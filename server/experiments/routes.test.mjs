// The /api/experiments routes (P4b §S3): drafts and their checks, the list with the month's usage, changes while a
// draft and while running, delete, stop (a draft is cancelled), Trial Reels' eligibility, "Use the winner" with its
// learning line, ownership, and the wiring: EXPERIMENTS=off, /api/config's flag, the cron job and the notes.
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIntegrations, moduleFor } from '../integrations/wiring.mjs';
import { describeExperiment, learningOf } from './index.mjs';
import { experimentSettings, cookieSecretFrom } from './config.mjs';
import { startExperiments } from './test-helpers.mjs';

const HOUR = 3_600_000;
let t;
let alice;
let bob;

beforeAll(async () => {
  t = await startExperiments();
  alice = await t.user('alice-routes@example.com');
  bob = await t.user('bob-routes@example.com');
  await t.project(alice);
  await t.project(bob);
  await t.connect(alice, ['facebook']);
});
afterAll(() => t.close());

const fbPost = (u, text) => t.post(u, { platform: 'facebook', caption: text, hashtags: [] });

describe('drafts', () => {
  it('checks the kind, mode, change, metric, network, versions and posts', async () => {
    const [a, b] = [await fbPost(alice, 'a'), await fbPost(alice, 'b')];
    const base = { projectId: 'proj-1', kind: 'post', mode: 'times', changed: 'hook', network: 'facebook', subjectRef: a.id, variants: [{ key: 'a', postId: a.id }, { key: 'b', postId: b.id }] };
    const bad = async (over) => (await t.x(alice, 'POST', '/api/experiments', { ...base, ...over })).body.code;
    expect(await bad({ kind: 'video' })).toBe('BAD_REQUEST');
    expect(await bad({ mode: 'split' })).toBe('BAD_REQUEST');
    expect(await bad({ changed: 'subject' })).toBe('BAD_REQUEST');
    expect(await bad({ metric: 'lead_rate' })).toBe('BAD_REQUEST');
    expect(await bad({ mode: 'trial_reels' })).toBe('BAD_REQUEST');
    // a Trial Reels test compares a hook, a caption or a visual (never a posting time or a call to action)
    for (const changed of ['time', 'cta']) {
      const r = await t.x(alice, 'POST', '/api/experiments', { ...base, mode: 'trial_reels', network: 'instagram', changed });
      expect([r.status, r.body.error]).toEqual([400, 'A Trial Reels test compares hooks, captions or visuals.']);
    }
    expect(await bad({ variants: [{ key: 'a', postId: a.id }] })).toBe('BAD_REQUEST');
    expect(await bad({ variants: [{ key: 'a', postId: a.id }, { key: 'c', postId: b.id }] })).toBe('BAD_REQUEST');
    expect(await bad({ variants: [{ key: 'a', postId: a.id }, { key: 'b', postId: a.id }] })).toBe('BAD_REQUEST');
    expect(await bad({ subjectRef: b.id })).toBe('BAD_REQUEST');
    const ig = await t.post(alice, { platform: 'instagram', caption: 'ig' });
    expect(await bad({ variants: [{ key: 'a', postId: a.id }, { key: 'b', postId: ig.id }] })).toBe('BAD_REQUEST');
    // someone else's post or business: not found
    const theirs = await fbPost(bob, 'theirs');
    expect(await bad({ variants: [{ key: 'a', postId: a.id }, { key: 'b', postId: theirs.id }] })).toBe('NOT_FOUND');
    expect((await t.x(alice, 'POST', '/api/experiments', { ...base, projectId: 'proj-x' })).status).toBe(404);
    // a page test is for this business's SEO page; email for a sequence step
    expect(await bad({ kind: 'page', mode: 'split', changed: 'headline', network: null, subjectRef: 'seo:other', variants: [{ key: 'a' }, { key: 'b' }] })).toBe('BAD_REQUEST');
    const ok = await t.x(alice, 'POST', '/api/experiments', { ...base, name: 'Hooks', variants: [{ key: 'a', postId: a.id, label: 'Question' }, { key: 'b', postId: b.id, label: 'Statement', plannedAt: new Date(t.clock.t + 86_400_000).toISOString() }] });
    expect(ok.status).toBe(201);
    expect(ok.body.experiment).toMatchObject({ state: 'draft', name: 'Hooks', metric: 'engagement_rate', network: 'facebook', variants: [{ key: 'a', label: 'Question', postId: a.id }, { key: 'b', label: 'Statement', postId: b.id }] });
    // a post is a version in one test only
    expect(await bad({})).toBe('BAD_REQUEST');
    const page = await t.x(alice, 'POST', '/api/experiments', { projectId: 'proj-1', kind: 'page', mode: 'split', changed: 'headline', subjectRef: 'seo:proj-1', variants: [{ key: 'a' }, { key: 'b' }] });
    expect(page.body.experiment).toMatchObject({ kind: 'page', metric: 'lead_rate', network: null });
    const email = await t.x(alice, 'POST', '/api/experiments', { projectId: 'proj-1', kind: 'email', mode: 'omnisend_ab', changed: 'opening', subjectRef: 'seq1:step2', variants: [{ key: 'a' }, { key: 'b' }] });
    expect(email.body.experiment).toMatchObject({ kind: 'email', metric: 'click_rate' });
  });

  it('lists the business’s tests with their versions (never a page version’s HTML) and the month’s usage; someone else’s is 404', async () => {
    const r = await t.x(alice, 'GET', '/api/experiments?projectId=proj-1');
    expect(r.status).toBe(200);
    expect(r.body.experiments.length).toBeGreaterThanOrEqual(3);
    expect(r.body.usage).toMatchObject({ used: 0, limit: null, resetsAt: expect.any(String) });
    expect(JSON.stringify(r.body)).not.toContain('"html"');
    const one = r.body.experiments[0];
    expect((await t.x(alice, 'GET', `/api/experiments/${one.id}`)).body.experiment.id).toBe(one.id);
    expect((await t.x(bob, 'GET', `/api/experiments/${one.id}`)).status).toBe(404);
    expect((await t.x(bob, 'DELETE', `/api/experiments/${one.id}`)).status).toBe(404);
    expect((await t.x(alice, 'GET', '/api/experiments/not-a-uuid')).status).toBe(404);
    expect((await t.x(null, 'GET', '/api/experiments?projectId=proj-1')).status).toBe(401);
    expect((await t.x(alice, 'GET', '/api/experiments?projectId=proj-1&kind=page')).body.experiments.every((e) => e.kind === 'page')).toBe(true);
  });
});

describe('changes', () => {
  it('a draft: name, labels, planned times, adding and removing C; running: only unposted planned times', async () => {
    const [a, b, c] = [await fbPost(alice, 'ca'), await fbPost(alice, 'cb'), await fbPost(alice, 'cc')];
    const exp = await t.draft(alice, [a, b]);
    const when = new Date(t.clock.t + 2 * 86_400_000).toISOString();
    let r = await t.x(alice, 'PATCH', `/api/experiments/${exp.id}`, { name: 'New name', variants: [{ key: 'b', label: 'B!', plannedAt: when }], addVariant: { key: 'c', postId: c.id, label: 'C' } });
    expect(r.body.experiment).toMatchObject({ name: 'New name', variants: [{ key: 'a' }, { key: 'b', label: 'B!', plannedAt: when }, { key: 'c', postId: c.id }] });
    r = await t.x(alice, 'PATCH', `/api/experiments/${exp.id}`, { removeVariant: 'c' });
    expect(r.body.experiment.variants.map((v) => v.key)).toEqual(['a', 'b']);
    await t.publish(alice, a);
    await t.settled();
    expect((await t.x(alice, 'PATCH', `/api/experiments/${exp.id}`, { name: 'x' })).status).toBe(409);
    expect((await t.x(alice, 'PATCH', `/api/experiments/${exp.id}`, { variants: [{ key: 'a', plannedAt: when }] })).status).toBe(409);
    const later = new Date(t.clock.t + 3 * 86_400_000).toISOString();
    r = await t.x(alice, 'PATCH', `/api/experiments/${exp.id}`, { variants: [{ key: 'b', plannedAt: later }] });
    expect(r.status).toBe(200);
    expect(Date.parse(r.body.experiment.endsAt)).toBe(Date.parse(later) + 7 * 86_400_000);
    // a running test can't be deleted; stopping keeps it
    expect((await t.x(alice, 'DELETE', `/api/experiments/${exp.id}`)).status).toBe(409);
  });

  it('stopping a draft cancels it; a draft or cancelled test can be deleted', async () => {
    const [a, b] = [await fbPost(alice, 'da'), await fbPost(alice, 'db')];
    const exp = await t.draft(alice, [a, b]);
    expect((await t.x(alice, 'POST', `/api/experiments/${exp.id}/stop`)).body.experiment.state).toBe('cancelled');
    expect((await t.x(alice, 'DELETE', `/api/experiments/${exp.id}`)).body).toEqual({ ok: true });
    expect(await t.row(exp.id)).toBeUndefined();
    expect(await t.variantRows(exp.id)).toEqual([]);
  });
});

describe('Trial Reels eligibility', () => {
  it('answers for the business’s Instagram: not connected here', async () => {
    const r = await t.x(alice, 'GET', '/api/experiments/trial-reels/eligibility?projectId=proj-1');
    expect(r.body).toMatchObject({ eligible: false, reason: 'not_connected', checkedAt: expect.any(String) });
    expect((await t.x(alice, 'GET', '/api/experiments/trial-reels/eligibility?projectId=nope')).status).toBe(404);
  });
});

describe('Use the winner', () => {
  it('only the clear winner, or a pick “anyway” on a close call; records it once and returns the learning line', async () => {
    const [a, b] = [await fbPost(alice, 'wa'), await fbPost(alice, 'wb')];
    const exp = await t.draft(alice, [a, b]);
    await t.publish(alice, a);
    await t.settled();
    await t.db.update('experiments', { id: exp.id }, { result: { verdict: 'too_close', metric: 'engagement_rate' } });
    const no = await t.x(alice, 'POST', `/api/experiments/${exp.id}/winner`, { key: 'b' });
    expect([no.status, no.body.error]).toEqual([409, 'There’s no clear winner yet. When the test is too close to call, you can pick one anyway.']);
    const pick = await t.x(alice, 'POST', `/api/experiments/${exp.id}/winner`, { key: 'b', override: true });
    expect(pick.status).toBe(200);
    expect(pick.body.experiment).toMatchObject({ winner: 'b', state: 'finished', result: { pickedByYou: true } });
    expect(pick.body.learning).toMatchObject({ changed: 'hook', winnerLabel: 'Hook 2', loserLabels: ['Hook 1'], lift: null, override: true });
    expect(pick.body.learning.summary).toBe('hooks: “Hook 2” beat “Hook 1” on Facebook (your pick)');
    expect((await t.x(alice, 'POST', `/api/experiments/${exp.id}/winner`, { key: 'a', override: true })).status).toBe(409);
    const learning = learningOf({ kind: 'post', network: 'instagram', changed: 'hook', metric: 'engagement_rate', result: { lift: 18 } }, [{ key: 'a', label: 'Statements' }, { key: 'b', label: 'Questions' }], 'b');
    expect(learning.summary).toBe('hooks: “Questions” beat “Statements” on Instagram: +18% engagement');
  });
});

describe('describe', () => {
  it('never shows the claim, the counted window or a page version’s HTML', () => {
    const out = describeExperiment({ id: 'e1', project_id: 'p', kind: 'page', mode: 'split', changed: 'cta', metric: 'lead_rate', subject_ref: 'seo:p', state: 'running', result: {}, counted_month: '2026-11-01', read_claim: 'x', last_read_at: '2026-11-07T00:00:00.000Z' }, [{ experiment_id: 'e1', key: 'b', html: '<p>secret</p>', html_sha256: 'f'.repeat(64), metrics: {} }]);
    expect(JSON.stringify(out)).not.toMatch(/secret|read_claim|2026-11-01/);
    expect(out).toMatchObject({ counted: true, refreshAt: '2026-11-07T00:15:00.000Z', variants: [{ key: 'b', hasHtml: true }] });
  });
});

describe('wiring', () => {
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const db = { enabled: true, select: async () => [], insert: async () => [], update: async () => [], upsert: async () => [], remove: async () => [], rpc: async () => [] };
  const auth = { enabled: true, identify: async () => ({ id: '00000000-0000-4000-8000-000000000001', email: 'x@y.test', isAdmin: false }) };

  it('routes /api/experiments to the module; on: the config flag, the hourly job after the morning action’s, the notes', () => {
    expect(moduleFor('/api/experiments')).toBe('experiments');
    expect(moduleFor('/api/experiments/abc/winner')).toBe('experiments');
    expect(moduleFor('/api/experimentsx')).toBeNull();
    const integrations = createIntegrations({ env: { SUPABASE_SECRET_KEY: 'k' }, send, db, auth, appState: { enabled: false } });
    expect(integrations.experimentsConfig()).toEqual({ enabled: true });
    const names = integrations.cronJobs().map((j) => j.name);
    expect(names.indexOf('experiment-results')).toBeGreaterThan(names.indexOf('morning-actions'));
    expect(integrations.cronJobs().find((j) => j.name === 'experiment-results')).toMatchObject({ everyMs: HOUR });
    expect(integrations.experimentPages).toMatchObject({ serve: expect.any(Function), leadVariant: expect.any(Function), onPublished: expect.any(Function) });
    expect(integrations.notes().join('\n')).toContain('A/B tests: on (needs supabase/migrations/20261117000000_experiments.sql)');
  });

  it('EXPERIMENTS=off: no job, every route 503 NOT_SET_UP, no page hooks (pages serve A), the notes say so', async () => {
    const integrations = createIntegrations({ env: { EXPERIMENTS: 'off' }, send, db, auth, appState: { enabled: false } });
    expect(integrations.experimentsConfig()).toEqual({ enabled: false });
    expect(integrations.cronJobs().some((j) => j.name === 'experiment-results')).toBe(false);
    expect(integrations.experimentPages).toBeNull();
    expect(integrations.notes().join('\n')).toContain('A/B tests: off (EXPERIMENTS=off).');
    const server = http.createServer((req, res) => integrations.handle(req, res, new URL(req.url, 'http://local')));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/experiments?projectId=p1`);
      expect(r.status).toBe(503);
      expect((await r.json()).code).toBe('NOT_SET_UP');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('the settings: reads per tick 1–200 (40), the cookie key from EXPERIMENT_COOKIE_SECRET or derived from the Supabase key', () => {
    expect(experimentSettings({})).toMatchObject({ off: false, readsPerTick: 40, cookieSecret: null });
    expect(experimentSettings({ EXPERIMENT_READS_PER_TICK: '0' }).readsPerTick).toBe(40);
    expect(experimentSettings({ EXPERIMENT_READS_PER_TICK: '200' }).readsPerTick).toBe(200);
    const derived = cookieSecretFrom({ SUPABASE_SECRET_KEY: 'sb_secret_x' });
    expect(derived).toHaveLength(32);
    expect(derived.equals(cookieSecretFrom({ SUPABASE_SECRET_KEY: 'sb_secret_x' }))).toBe(true);
    expect(derived.equals(cookieSecretFrom({ SUPABASE_SECRET_KEY: 'sb_secret_y' }))).toBe(false);
    expect(cookieSecretFrom({ SUPABASE_SECRET_KEY: 'sb_secret_x', EXPERIMENT_COOKIE_SECRET: 'own-secret-0123456789' }).toString()).toBe('own-secret-0123456789');
  });
});
