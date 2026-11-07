// Email A/B tests (P4b §S8) through the experiments routes, with a fake Omnisend: the A/B draft starts the test and
// counts it, the limit is checked before anything is made in Omnisend, a draft that certainly wasn't made gives the
// test back (one that may exist doesn't), the split fallback, and results: Omnisend's pick wins, the rates are kept.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startExperiments } from './test-helpers.mjs';

const HOUR = 3_600_000;
const VARIANTS = { a: { subject: 'Your guide is inside', body: 'Hi' }, b: { subject: 'Free guide: 5 cuts', body: 'Hi' } };
let t;
let alice;

beforeAll(async () => {
  t = await startExperiments({ enforce: true });
  alice = await t.user('alice-email@example.com');
  await t.project(alice);
});
afterAll(() => t.close());
beforeEach(() => {
  t.clock.t += 40 * 86_400_000;
  t.plan(alice, 'launch');
  t.omnisend.state.next = 'ab';
  t.omnisend.state.calls.length = 0;
});

async function emailTest(changed = 'subject') {
  const r = await t.x(alice, 'POST', '/api/experiments', { projectId: 'proj-1', kind: 'email', mode: 'omnisend_ab', changed, subjectRef: `seq1:step${Math.floor(Math.random() * 1e6)}`, name: 'Guide subjects', variants: [{ key: 'a', label: 'Plain' }, { key: 'b', label: 'Number' }] });
  expect(r.status).toBe(201);
  return r.body.experiment;
}
const draft = (e, settings = { testSizePercent: 20, decisionHours: 12 }) => t.x(alice, 'POST', `/api/experiments/${e.id}/email`, { variants: VARIANTS, settings });

describe('the Omnisend A/B draft', () => {
  it('makes the draft, then the test runs (counted), with the variant ids and Omnisend’s decision time + 24 h', async () => {
    const e = await emailTest();
    const r = await draft(e);
    expect(r.status).toBe(201);
    expect(r.body.campaign).toMatchObject({ id: 'c'.repeat(24), variantIds: { a: 'va', b: 'vb' } });
    expect(r.body.experiment).toMatchObject({ state: 'running', counted: true, mode: 'omnisend_ab', metric: 'open_rate' });
    expect(r.body.experiment.variants.map((v) => v.omnisendCampaignId)).toEqual(['c'.repeat(24), 'c'.repeat(24)]);
    expect(Date.parse(r.body.experiment.endsAt)).toBe(t.clock.t + 36 * HOUR);
    const [, userId, args] = t.omnisend.state.calls[0];
    expect(userId).toBe(alice.id);
    expect(args).toMatchObject({ name: 'Guide subjects', settings: { testSizePercent: 20, decisionHours: 12, winningMetric: 'openRate' } });
    // a second press doesn't make another
    expect((await draft(e)).status).toBe(409);
    expect(t.omnisend.state.calls).toHaveLength(1);
  });

  it('two presses at once: the one that started the test makes the draft; the other makes nothing (409)', async () => {
    const e = await emailTest();
    const stale = await t.row(e.id);
    expect((await draft(e)).status).toBe(201);
    // the second request had read the test while it was still a draft
    await expect(t.mod.email.createDraft({ id: alice.id }, stale, { variants: VARIANTS })).rejects.toMatchObject({ status: 409 });
    expect(t.omnisend.state.calls.filter((c) => c[0] === 'createAbDraft')).toHaveLength(1);
    expect(await t.row(e.id)).toMatchObject({ state: 'running' });
  });

  it('at the month’s limit nothing is made in Omnisend', async () => {
    for (let i = 0; i < 2; i++) expect((await draft(await emailTest())).status).toBe(201);
    const e = await emailTest();
    const n = t.omnisend.state.calls.length;
    const r = await draft(e);
    expect([r.status, r.body.code]).toEqual([402, 'EXPERIMENT_LIMIT']);
    expect(t.omnisend.state.calls.length).toBe(n);
  });

  it('a draft certainly not made gives the test back; one that may exist keeps it counted', async () => {
    const e = await emailTest();
    t.omnisend.state.next = { status: 409, code: 'NOT_CONNECTED', message: 'Connect your Omnisend account before creating a draft.' };
    const r = await draft(e);
    expect([r.status, r.body.code, r.body.error]).toEqual([409, 'NOT_CONNECTED', 'Connect your Omnisend account before creating a draft.']);
    expect(await t.row(e.id)).toMatchObject({ state: 'draft', counted_month: null });
    t.omnisend.state.next = { status: 502, code: 'CAMPAIGN_UNCONFIRMED', message: 'It may have been created: check Omnisend before trying again.', campaignMayExist: true };
    const u = await draft(e);
    expect([u.status, u.body.code]).toEqual([502, 'CAMPAIGN_UNCONFIRMED']);
    expect((await t.row(e.id)).state).toBe('running');
  });

  it('the split fallback: two drafts, their ids, and how to send them', async () => {
    t.omnisend.state.next = 'split';
    const e = await emailTest('opening');
    const r = await draft(e);
    expect(r.status).toBe(201);
    expect(r.body.experiment).toMatchObject({ mode: 'split', metric: 'click_rate' });
    expect(r.body.experiment.variants.map((v) => v.omnisendCampaignId)).toEqual(['a1'.repeat(12), 'b1'.repeat(12)]);
    expect(r.body.split.note).toMatch(/Send version A to half of your list and version B to the other half/);
  });

  it('designed versions (P5): the docs go through as they are; a version with neither text nor design makes nothing', async () => {
    const doc = (opening) => ({ v: 1, blocks: [{ type: 'text', text: opening }, { type: 'button', label: 'Get it', link: { kind: 'magnet' } }] });
    const variants = { a: { subject: 'Your guide', doc: doc('Here it is.'), values: { lead_magnet_link: 'https://app.example/m/x' } }, b: { subject: 'Your guide', doc: doc('You asked, so here it is.'), values: { lead_magnet_link: 'https://app.example/m/x' } } };
    const e = await emailTest('opening');
    const r = await t.x(alice, 'POST', `/api/experiments/${e.id}/email`, { variants });
    expect(r.status).toBe(201);
    const [, , args] = t.omnisend.state.calls.at(-1);
    expect(args.variants).toEqual(variants);
    const n = t.omnisend.state.calls.length;
    for (const bad of [{ a: variants.a, b: { subject: 'x' } }, { a: { doc: variants.a.doc }, b: variants.b }, { a: variants.a, b: { subject: 'x', doc: [] } }]) {
      const u = await t.x(alice, 'POST', `/api/experiments/${(await emailTest('opening')).id}/email`, { variants: bad });
      expect([u.status, u.body.code]).toEqual([400, 'BAD_REQUEST']);
    }
    expect(t.omnisend.state.calls.length).toBe(n);
  });
});

describe('email results', () => {
  it('Omnisend’s pick is the verdict (ours beside it); the rates are kept; the test finishes', async () => {
    const e = await emailTest();
    await draft(e);
    t.omnisend.state.results = { status: 'ok', campaignStatus: 'sent', winnerId: 'vb', rates: { va: { sent: 500, openRate: 0.3, clickRate: 0.02 }, vb: { sent: 500, openRate: 0.42, clickRate: 0.03 } } };
    t.clock.t += 6 * 60_000;
    const r = await t.x(alice, 'POST', `/api/experiments/${e.id}/refresh`);
    expect(r.status).toBe(200);
    expect(r.body.experiment).toMatchObject({ state: 'finished', result: { verdict: 'winner', winner: 'b', source: 'omnisend', ours: { verdict: 'winner', winner: 'b' }, campaignStatus: 'sent' } });
    expect(r.body.experiment.variants.map((v) => v.metrics)).toEqual([{ sent: 500, openRate: 0.3, clickRate: 0.02 }, { sent: 500, openRate: 0.42, clickRate: 0.03 }]);
    expect(t.omnisend.state.calls.at(-1)).toEqual(['abResults', alice.id, { abCampaignId: 'c'.repeat(24) }]);
    // "Use the winner" takes Omnisend's pick
    const w = await t.x(alice, 'POST', `/api/experiments/${e.id}/winner`, { key: 'b' });
    expect(w.body.learning.summary).toMatch(/^subject lines: “Number” beat “Plain” in email/);
  });

  it('before Omnisend picks, its A/B test has no winner of ours (ours is only beside it); Use the winner is refused', async () => {
    const e = await emailTest();
    await draft(e);
    t.omnisend.state.results = { status: 'ok', campaignStatus: 'sent', rates: { va: { sent: 500, openRate: 0.2, clickRate: 0.02 }, vb: { sent: 500, openRate: 0.45, clickRate: 0.03 } } };
    t.clock.t += 6 * 60_000;
    const r = await t.x(alice, 'POST', `/api/experiments/${e.id}/refresh`);
    expect(r.body.experiment).toMatchObject({ state: 'running', result: { verdict: 'keep_going', reason: 'omnisend_picks', ours: { verdict: 'winner', winner: 'b' } } });
    expect(r.body.experiment.result.winner).toBeUndefined();
    expect((await t.x(alice, 'POST', `/api/experiments/${e.id}/winner`, { key: 'b' })).status).toBe(409);
    // past the decision time with no pick: not enough, never ours as the verdict
    t.clock.t += 40 * HOUR;
    const late = await t.x(alice, 'POST', `/api/experiments/${e.id}/refresh`);
    expect(late.body.experiment).toMatchObject({ state: 'finished', result: { verdict: 'not_enough', reason: 'omnisend_no_pick' } });
  });

  it('a lost connection is our own words on each version', async () => {
    const e = await emailTest();
    await draft(e);
    t.omnisend.state.results = { status: 'not_connected', errorCode: 'NEEDS_RECONNECT' };
    await t.mod.jobs.run({});
    const vs = await t.variantRows(e.id);
    expect(vs.map((v) => v.metrics_error)).toEqual(['reconnect', 'reconnect']);
  });
});
