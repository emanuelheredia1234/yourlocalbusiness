// Reading post A/B results (P4b §S5): Upload-Post's per-post analytics by our job id (numbers only, a missing key
// stays missing), the cadence (3 h / 12 h / never after the deadline + 24 h), the analytics limit stopping the tick,
// a failed read keeping the old numbers, a team-level error telling the owner while the customer sees "delayed",
// "Update results" once every 15 minutes, two ticks never reading the same test twice, and finishing past the deadline.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startExperiments } from './test-helpers.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let t;
let alice;

beforeAll(async () => {
  t = await startExperiments();
  alice = await t.user('alice-results@example.com');
  await t.project(alice);
  await t.connect(alice, ['facebook']);
});
afterAll(() => t.close());

const fbPost = (text) => t.post(alice, { platform: 'facebook', caption: text, hashtags: [] });
/** A running test with both versions posted (12 hours apart). → { exp, jobs: [a, b] } */
async function postedTest() {
  // the tests before this one are over
  await t.db.update('experiments', { user_id: alice.id, state: 'running' }, { state: 'stopped' });
  const [a, b] = [await fbPost(`A ${Math.random()}`), await fbPost(`B ${Math.random()}`)];
  const exp = await t.draft(alice, [a, b]);
  const ra = await t.publish(alice, a);
  await t.settled();
  t.clock.t += 12 * HOUR;
  const rb = await t.publish(alice, b);
  await t.settled();
  if (!ra.body?.job || !rb.body?.job) throw new Error(`publish: ${ra.text} ${rb.text}`);
  return { exp, jobs: [ra.body.job.id, rb.body.job.id] };
}
const tick = () => t.mod.jobs.run({});
const row = (id) => t.row(id);

describe('post metrics', () => {
  it('reads one post’s numbers by our job id: numbers only, missing keys stay missing; errors in our words', async () => {
    const { jobs } = await postedTest();
    t.up.postMetrics.set(jobs[0], { facebook: { views: 900, reach: 700, likes: 40, comments: 'n/a', media_product_type: 'FEED' } });
    expect(await t.connections.postMetrics(alice.id, 'facebook', { projectId: 'proj-1', requestId: jobs[0] })).toEqual({ metrics: { views: 900, reach: 700, likes: 40 } });
    const ledger = await t.db.select('usage_ledger', { user_id: alice.id, endpoint: 'facebook:GET /post-analytics' });
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger[0]).toMatchObject({ vendor: 'uploadpost', feature: 'social' });
    t.up.postMetrics.set(jobs[1], { facebook: { error: 'Facebook post not found (private detail)' } });
    expect(await t.connections.postMetrics(alice.id, 'facebook', { projectId: 'proj-1', requestId: jobs[1] })).toEqual({ error: 'unavailable' });
    expect(await t.connections.postMetrics(alice.id, 'facebook', { projectId: 'proj-1', requestId: crypto.randomUUID() })).toEqual({ error: 'not_found' });
  });
});

describe('Update results', () => {
  it('reads now, at most once every 15 minutes per test', async () => {
    const { exp, jobs } = await postedTest();
    for (const j of jobs) t.up.postMetrics.set(j, { facebook: { reach: 50, likes: 2 } });
    t.clock.t += 6 * 60_000;
    const r = await t.x(alice, 'POST', `/api/experiments/${exp.id}/refresh`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.experiment.variants.map((v) => v.metrics.reach)).toEqual([50, 50]);
    const again = await t.x(alice, 'POST', `/api/experiments/${exp.id}/refresh`);
    expect([again.status, again.body.code]).toEqual([409, 'TOO_SOON']);
    expect(Date.parse(again.body.nextAt)).toBe(t.clock.t + 15 * 60_000);
    t.clock.t += 15 * 60_000;
    expect((await t.x(alice, 'POST', `/api/experiments/${exp.id}/refresh`)).status).toBe(200);
  });
});

describe('the hourly results job', () => {
  it('reads posted versions on the cadence, keeps old numbers on a failed read, finishes past the deadline', async () => {
    const { exp, jobs } = await postedTest();
    t.up.postMetrics.set(jobs[0], { facebook: { reach: 1000, likes: 20, comments: 10 } });
    t.up.postMetrics.set(jobs[1], { facebook: { reach: 1000, likes: 45, comments: 10 } });
    const reads0 = t.up.analyticsReads;
    await tick();
    expect(t.up.analyticsReads - reads0).toBe(2);
    let r = await row(exp.id);
    expect(r.result).toMatchObject({ verdict: 'winner', winner: 'b', note: 'time_differs' });
    expect(r.result.perVariant.b).toMatchObject({ successes: 55, trials: 1000 });
    // an hour later: not due (3-hourly in the first 72 hours)
    t.clock.t += HOUR;
    await tick();
    expect(t.up.analyticsReads - reads0).toBe(2);
    // 3 hours later: read again; this time b's read fails and its old numbers stay
    t.clock.t += 3 * HOUR;
    t.up.postMetrics.set(jobs[1], { facebook: { error: 'temporarily unavailable' } });
    await tick();
    const vs = await t.variantRows(exp.id);
    expect(vs[1]).toMatchObject({ metrics: { reach: 1000, likes: 45, comments: 10 }, metrics_error: 'unavailable' });
    t.up.postMetrics.set(jobs[1], { facebook: { reach: 1000, likes: 45, comments: 10 } });
    // four days on: 12-hourly; past the deadline the test finishes with its verdict
    t.clock.t += 4 * DAY;
    const reads1 = t.up.analyticsReads;
    await tick();
    expect(t.up.analyticsReads - reads1).toBe(2);
    t.clock.t += 2 * HOUR;
    await t.db.update('experiments', { id: exp.id }, { last_read_at: new Date(t.clock.t - 7 * HOUR).toISOString() });
    await tick();
    expect(t.up.analyticsReads - reads1).toBe(2);
    await t.db.update('experiments', { id: exp.id }, { ends_at: new Date(t.clock.t - HOUR).toISOString(), last_read_at: new Date(t.clock.t - 13 * HOUR).toISOString() });
    await tick();
    r = await row(exp.id);
    expect(r.state).toBe('finished');
    expect(r.result).toMatchObject({ verdict: 'winner', winner: 'b' });
    // never read after the deadline + 24 hours
    await t.db.update('experiments', { id: exp.id }, { state: 'running', ends_at: new Date(t.clock.t - 25 * HOUR).toISOString(), last_read_at: new Date(t.clock.t - 13 * HOUR).toISOString() });
    const reads2 = t.up.analyticsReads;
    await tick();
    expect(t.up.analyticsReads).toBe(reads2);
    expect((await row(exp.id)).state).toBe('finished');
  });

  it('two ticks at once never read the same test twice', async () => {
    const { exp, jobs } = await postedTest();
    for (const j of jobs) t.up.postMetrics.set(j, { facebook: { reach: 10, likes: 1 } });
    // every other running test is read already
    for (const e of await t.db.select('experiments', { user_id: alice.id, state: 'running' })) if (e.id !== exp.id) await t.db.update('experiments', { id: e.id }, { last_read_at: new Date(t.clock.t).toISOString() });
    const reads0 = t.up.analyticsReads;
    await Promise.all([tick(), tick()]);
    expect(t.up.analyticsReads - reads0).toBe(2);
  });

  it('the first read past the deadline reads every version again, so the verdict never uses numbers from before it', async () => {
    const { exp, jobs } = await postedTest();
    for (const e of await t.db.select('experiments', { user_id: alice.id, state: 'running' })) if (e.id !== exp.id) await t.db.update('experiments', { id: e.id }, { state: 'stopped' });
    t.up.postMetrics.set(jobs[0], { facebook: { reach: 1000, likes: 20 } });
    t.up.postMetrics.set(jobs[1], { facebook: { reach: 1000, likes: 21 } });
    t.clock.t += 5 * DAY;
    await tick();
    // the deadline passes 2 hours after that read (inside the 12-hour cadence)
    await t.db.update('experiments', { id: exp.id }, { ends_at: new Date(t.clock.t + HOUR).toISOString() });
    t.up.postMetrics.set(jobs[1], { facebook: { reach: 1000, likes: 60 } });
    t.clock.t += 2 * HOUR;
    await t.db.update('experiments', { id: exp.id }, { last_read_at: new Date(t.clock.t - 13 * HOUR).toISOString() });
    const reads0 = t.up.analyticsReads;
    await tick();
    expect(t.up.analyticsReads - reads0).toBe(2);
    const r = await row(exp.id);
    expect(r.state).toBe('finished');
    expect(r.result).toMatchObject({ verdict: 'winner', winner: 'b', perVariant: { b: { successes: 60 } } });
  });

  it('a version still going out (queued or sending) is waiting, not missing: the test never ends on it', async () => {
    const { exp, jobs } = await postedTest();
    for (const j of jobs) t.up.postMetrics.set(j, { facebook: { reach: 1000, likes: 30 } });
    await t.db.update('post_publish_jobs', { id: jobs[1] }, { state: 'sending' });
    await t.db.update('experiments', { id: exp.id }, { ends_at: new Date(t.clock.t - HOUR).toISOString(), last_read_at: null });
    await tick();
    const r = await row(exp.id);
    expect(r.state).toBe('running');
    expect(r.result).toMatchObject({ verdict: 'keep_going', reason: 'not_posted' });
    await t.db.update('post_publish_jobs', { id: jobs[1] }, { state: 'sent' });
  });

  it('“Update results” on a finished test keeps “your pick” and the verdict it was picked on', async () => {
    const { exp, jobs } = await postedTest();
    for (const j of jobs) t.up.postMetrics.set(j, { facebook: { reach: 1000, likes: 30 } });
    await t.db.update('experiments', { id: exp.id }, { result: { verdict: 'too_close', leader: 'b', metric: 'engagement_rate' } });
    const w = await t.x(alice, 'POST', `/api/experiments/${exp.id}/winner`, { key: 'b', override: true });
    expect(w.status, w.text).toBe(200);
    t.up.postMetrics.set(jobs[0], { facebook: { reach: 1000, likes: 10 } });
    t.clock.t += 20 * 60_000;
    const r = await t.x(alice, 'POST', `/api/experiments/${exp.id}/refresh`);
    expect(r.status).toBe(200);
    expect(r.body.experiment).toMatchObject({ state: 'finished', winner: 'b', result: { verdict: 'too_close', pickedByYou: true } });
    expect(r.body.experiment.result.perVariant.a).toMatchObject({ successes: 10 });
  });

  it('a plan-level refusal of the read (402) tells the owner; the customer sees “delayed”', async () => {
    const id = crypto.randomUUID();
    const logs0 = t.logs.length;
    t.up.postMetrics.set(id, { status: 402, body: { success: false, message: 'Your plan does not include analytics' } });
    expect(await t.connections.postMetrics(alice.id, 'facebook', { projectId: 'proj-1', requestId: id })).toEqual({ error: 'delayed' });
    expect(t.logs.slice(logs0).some((l) => l.includes('uploadpost_owner_alert'))).toBe(true);
  });
  it('when the analytics limit is used up the tick stops and the rest wait; a team-level error tells the owner, the customer sees “delayed”', async () => {
    const { exp, jobs } = await postedTest();
    for (const e of await t.db.select('experiments', { user_id: alice.id, state: 'running' })) if (e.id !== exp.id) await t.db.update('experiments', { id: e.id }, { last_read_at: new Date(t.clock.t).toISOString() });
    // use up the 100 reads per 5 minutes
    for (let i = 0; i < 100; i++) await t.connections.postMetrics(alice.id, 'facebook', { projectId: 'proj-1', requestId: crypto.randomUUID() }).catch(() => null);
    const reads0 = t.up.analyticsReads;
    const counts = await tick();
    expect(counts).toMatchObject({ claimed: 1, read: 0, waiting: 1 });
    expect(t.up.analyticsReads).toBe(reads0);
    expect((await row(exp.id)).last_read_at).toBeNull();
    t.clock.t += 6 * 60_000;
    // (last: a 401 makes the client hold further calls for a while, as it does for a bad key)
    t.up.postMetrics.set(jobs[0], { status: 401, body: { success: false, message: 'Invalid API key' } });
    t.up.postMetrics.set(jobs[1], { facebook: { reach: 10, likes: 1 } });
    await tick();
    const got = await t.x(alice, 'GET', `/api/experiments/${exp.id}`);
    expect(got.body.experiment.delayed).toBe(true);
    expect(got.body.experiment.variants[0].metricsError).toBe('delayed');
    expect(JSON.stringify(got.body)).not.toContain('Invalid API key');
    expect(t.logs.some((l) => l.includes('uploadpost_owner_alert'))).toBe(true);
  });

});
