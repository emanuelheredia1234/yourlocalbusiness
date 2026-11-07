// Post A/B tests through Post now (P4b §S2, §S3): the first variant starts the test and counts it in the month's
// limit, the limit (and two starts at it), the refund on a certainly-failed first job (never on unknown), key order and
// the 12-hour gap for "different times", Trial Reels back to back, a stopped test refusing its variants, a post that
// isn't the variant's, the credit window's reset, and unlimited legacy plans and the owner.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MP4 } from '../social/test-helpers.mjs';
import { startExperiments } from './test-helpers.mjs';

const HOUR = 3_600_000;
let t;
let alice;

beforeAll(async () => {
  t = await startExperiments({ enforce: true });
  alice = await t.user('alice-ab@example.com');
  await t.project(alice);
  await t.connect(alice, ['facebook', 'instagram']);
  await t.db.upsert('analytics_snapshots', { user_id: alice.id, project_id: 'proj-1', source: 'social', status: 'ok', fetched_at: new Date(t.clock.t).toISOString(), data: { networks: [{ network: 'instagram', origin: 'own', followers: 5000 }] } }, { onConflict: 'user_id,project_id,source' });
});
afterAll(() => t.close());
beforeEach(async () => {
  // a fresh month on Launch for each test
  t.clock.t += 40 * 86_400_000;
  t.plan(alice, 'launch');
  await t.db.remove('experiment_variants', { user_id: alice.id });
  await t.db.remove('experiments', { user_id: alice.id });
  expect(t.up.violations).toEqual([]);
});

const fbPost = (text) => t.post(alice, { platform: 'facebook', caption: text, hashtags: [] });
async function publish(post, extra) {
  const r = await t.publish(alice, post, extra);
  await t.settled();
  return r;
}
const usage = async () => (await t.x(alice, 'GET', '/api/experiments/usage')).body;

describe('starting and counting', () => {
  it('the first variant posted starts the test, counts it once, and records its job', async () => {
    const [a, b] = [await fbPost('Question hook?'), await fbPost('Statement hook.')];
    const exp = await t.draft(alice, [a, b]);
    expect(exp).toMatchObject({ state: 'draft', counted: false, kind: 'post', mode: 'times', metric: 'engagement_rate' });
    expect(await usage()).toMatchObject({ used: 0, limit: 2 });
    const r = await publish(a);
    expect(r.status).toBe(200);
    const row = await t.row(exp.id);
    expect(row).toMatchObject({ state: 'running', counted_month: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(Date.parse(row.ends_at)).toBeGreaterThan(t.clock.t + 6 * 86_400_000);
    const [va] = await t.variantRows(exp.id);
    expect(va.job_id).toBe(r.body.job.id);
    expect((await t.jobRow(r.body.job.id)).provider_ref.experiment).toEqual({ id: exp.id, key: 'a' });
    expect(await usage()).toMatchObject({ used: 1, limit: 2 });
    // B 12 hours later doesn't count again
    t.clock.t += 12 * HOUR;
    expect((await publish(b)).status).toBe(200);
    expect(await usage()).toMatchObject({ used: 1 });
  });

  it('the third test on Launch is refused with 402 EXPERIMENT_LIMIT before anything is sent', async () => {
    for (let i = 0; i < 2; i++) {
      const a = await fbPost(`A${i}`);
      await t.draft(alice, [a, await fbPost(`B${i}`)]);
      expect((await publish(a)).status).toBe(200);
    }
    const a = await fbPost('A3');
    const exp = await t.draft(alice, [a, await fbPost('B3')]);
    const before = t.postCalls().length;
    const r = await t.publish(alice, a);
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ code: 'EXPERIMENT_LIMIT', limit: 2, upgrade: '#plans' });
    expect(r.body.error).toMatch(/^You’ve used your 2 A\/B tests this month\. They reset on .+, or upgrade to Grow\.$/);
    expect(t.postCalls().length).toBe(before);
    expect((await t.row(exp.id)).state).toBe('draft');
    // saving a draft is always allowed
    expect((await t.x(alice, 'POST', '/api/experiments', { projectId: 'proj-1', kind: 'post', mode: 'times', changed: 'cta', network: 'facebook', subjectRef: (await fbPost('x')).id, variants: [] })).status).toBe(400);
  });

  it('two starts at the limit at once: exactly one goes', async () => {
    const a0 = await fbPost('first');
    await t.draft(alice, [a0, await fbPost('first b')]);
    expect((await publish(a0)).status).toBe(200);
    const [a1, a2] = [await fbPost('one'), await fbPost('two')];
    await t.draft(alice, [a1, await fbPost('one b')]);
    await t.draft(alice, [a2, await fbPost('two b')]);
    const both = await Promise.all([t.publish(alice, a1), t.publish(alice, a2)]);
    await t.settled();
    expect(both.map((r) => r.status).sort()).toEqual([200, 402]);
    expect(await usage()).toMatchObject({ used: 2, limit: 2 });
  });

  it('a first job that certainly failed gives the test back; one that may have gone out (unknown) doesn’t', async () => {
    const a = await fbPost('will fail');
    const exp = await t.draft(alice, [a, await fbPost('b')]);
    t.up.setUploadOutcome('platform_failed');
    await publish(a);
    expect(await t.row(exp.id)).toMatchObject({ state: 'draft', counted_month: null });
    expect(await usage()).toMatchObject({ used: 0 });
    const c = await fbPost('unclear');
    const exp2 = await t.draft(alice, [c, await fbPost('d')]);
    t.up.setUploadOutcome('accepted_then_500');
    await publish(c);
    expect((await t.jobRow((await t.variantRows(exp2.id))[0].job_id)).state).toBe('unknown');
    expect(await t.row(exp2.id)).toMatchObject({ state: 'running' });
    expect(await usage()).toMatchObject({ used: 1 });
  });

  it('the window resets with the credit window; legacy plans and the owner are unlimited', async () => {
    const used = async () => (await usage()).used;
    for (let i = 0; i < 2; i++) {
      const a = await fbPost(`w${i}`);
      await t.draft(alice, [a, await fbPost(`wb${i}`)]);
      await publish(a);
    }
    expect(await used()).toBe(2);
    // the next billing period: a new window
    t.clock.t += 26 * 86_400_000;
    t.plan(alice, 'launch', { current_period_start: new Date(t.clock.t - 86_400_000).toISOString(), current_period_end: new Date(t.clock.t + 29 * 86_400_000).toISOString() });
    expect(await usage()).toMatchObject({ used: 0, limit: 2 });
    // plans not enforced: no limit
    t.billing.state.enforce = false;
    expect(await usage()).toMatchObject({ limit: null });
    t.billing.state.enforce = true;
    t.billing.state.accounts.set(alice.id, { source: 'owner', tier: 'scale', status: 'active' });
    expect(await usage()).toMatchObject({ limit: null });
    t.plan(alice, 'scale');
    expect(await usage()).toMatchObject({ limit: null });
  });

  it('a paused plan can’t start a test (P1’s 402)', async () => {
    const a = await fbPost('paused');
    await t.draft(alice, [a, await fbPost('paused b')]);
    t.plan(alice, 'launch', { status: 'unpaid' });
    const r = await t.publish(alice, a);
    expect([r.status, r.body.code]).toEqual([402, 'PAYMENT_REQUIRED']);
  });
});

describe('order and gap', () => {
  it('“different times”: in key order, at least 12 hours apart', async () => {
    const [a, b, c] = [await fbPost('A'), await fbPost('B'), await fbPost('C')];
    await t.draft(alice, [a, b, c]);
    const early = await t.publish(alice, b);
    expect([early.status, early.body.code]).toEqual([409, 'TOO_SOON_AFTER_VARIANT']);
    expect(early.body.error).toBe('Post version A first: versions go out in order.');
    expect((await publish(a)).status).toBe(200);
    t.clock.t += 11 * HOUR;
    const gap = await t.publish(alice, b);
    expect([gap.status, gap.body.code]).toEqual([409, 'TOO_SOON_AFTER_VARIANT']);
    expect(Date.parse(gap.body.nextAt)).toBe(t.clock.t + HOUR);
    expect((await t.publish(alice, c)).body.code).toBe('TOO_SOON_AFTER_VARIANT');
    t.clock.t += HOUR;
    expect((await publish(b)).status).toBe(200);
  });

  it('Trial Reels may go back to back', async () => {
    const reel = async (i) => t.post(alice, { platform: 'instagram', format: 'video', media: t.file(alice, `vid-ab-${i}-${Math.random()}.mp4`, MP4, 'video/mp4'), instagram: { shareMode: 'TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS' } });
    const [a, b] = [await reel(1), await reel(2)];
    const exp = await t.draft(alice, [a, b], { mode: 'trial_reels', network: 'instagram' });
    expect(exp).toMatchObject({ metric: 'views', result: { eligibility: { eligible: true } } });
    expect(exp.variants.map((v) => v.shareMode)).toEqual(['TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS', 'TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS']);
    expect((await publish(b)).status).toBe(200);
    const last = await publish(a);
    expect(last.status).toBe(200);
    const row = await t.row(exp.id);
    // 72 hours after the last one went out
    expect(Date.parse(row.ends_at)).toBe(Date.parse((await t.jobRow(last.body.job.id)).requested_at) + 72 * HOUR);
    // a variant saved as a regular Reel can't go out in a Trial Reels test
    const c = await t.post(alice, { platform: 'instagram', format: 'video', media: t.file(alice, `vid-ab-c-${Math.random()}.mp4`, MP4, 'video/mp4') });
    const d = await reel(4);
    await t.draft(alice, [c, d], { mode: 'trial_reels', network: 'instagram' });
    expect((await t.publish(alice, c)).body.code).toBe('POST_CHANGED');
  });
});

describe('what can’t be posted from a test', () => {
  it('a stopped test refuses its variants; a post that isn’t the variant’s is refused', async () => {
    const [a, b] = [await fbPost('stop A'), await fbPost('stop B')];
    const exp = await t.draft(alice, [a, b]);
    await publish(a);
    expect((await t.x(alice, 'POST', `/api/experiments/${exp.id}/stop`)).body.experiment.state).toBe('stopped');
    t.clock.t += 13 * HOUR;
    const r = await t.publish(alice, b);
    expect([r.status, r.body.code]).toEqual([409, 'BAD_REQUEST']);
    // a post claiming to be another post's version
    const [c, d] = [await fbPost('c'), await fbPost('d')];
    const exp2 = await t.draft(alice, [c, d]);
    const other = await t.post(alice, { platform: 'facebook', caption: 'impostor', hashtags: [], experiment: { id: exp2.id, key: 'a' } });
    expect((await t.publish(alice, other)).body.code).toBe('POST_CHANGED');
    const ghost = await t.post(alice, { platform: 'facebook', caption: 'ghost', hashtags: [], experiment: { id: crypto.randomUUID(), key: 'a' } });
    expect((await t.publish(alice, ghost)).status).toBe(404);
  });
});
