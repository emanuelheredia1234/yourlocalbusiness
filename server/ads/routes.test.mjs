// The ads routes end to end (spec §1, §15.2): HTTP through the real wiring, mock Supabase and the mock Zernio
// server. Every rule of §1 has a case here or in the module tests; the mock fails a test (violations) on a repeated
// write body or a launch body that breaks the rules.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startAds } from './test-helpers.mjs';
import { TEST_ZERNIO_KEY } from '../test/mock-zernio.mjs';
import { META_REFUSALS } from '../test/mock-zernio-ads.mjs';
import { messageFor, REFUSAL_REASON, ZERNIO_CODES } from './messages.mjs';

let t;
let u;
afterEach(async () => {
  expect(t.violations().filter((v) => v.kind !== 'repeated_write' || !t.allowRepeats)).toEqual([]);
  await t.close();
});

async function ready(opts = {}, { platforms = ['meta_ads'], email = 'owner@acme.test' } = {}) {
  t = await startAds(opts);
  u = await t.user(email);
  await t.project(u);
  await t.plan(u);
  for (const p of platforms) {
    await t.connect(u, p);
    await t.choose(u, p === 'meta_ads' ? 'meta' : 'google');
  }
  return t;
}

const metaCampaign = (row) => t.zm.ads.state.campaigns.get(row.remote.campaignId);
const codes = (list) => (list ?? []).map((n) => n.code);
const writePaths = (from = 0) => t.writes(from).map((w) => `${w.method} ${w.path.replace('/api/v1', '').replace(/\/[0-9a-f]{24}(?=\/|$)/g, '/:zad').replace(/\/\d{6,}/g, '/:id')}`);

/** the fix link the customer is shown: ours for a payment method (act_1's payment settings) and the policy, else Zernio's */
const SHOWN_FIX = { ad_account_payment_required: 'https://business.facebook.com/billing_hub/payment_settings/?asset_id=1', ad_account_policy_not_accepted: 'https://business.facebook.com/latest/settings/business_users' };
const shownFix = (code) => SHOWN_FIX[code] ?? META_REFUSALS[code]?.fix?.url;

describe('launch: confirm, token, one send (R1, R2)', () => {
  beforeEach(async () => ready());

  it('refuses without confirm, with a bad or expired token, or after the plan was edited; nothing reaches Zernio', async () => {
    const pv = await t.preview(u, await t.request(u));
    expect(pv.status).toBe(200);
    const token = pv.body.reviewToken;
    const before = t.writes().length;
    expect((await t.call(u, 'POST', '/api/ads/launch', { reviewToken: token, clientRequestId: crypto.randomUUID() })).body.code).toBe('CONFIRM_REQUIRED');
    expect((await t.launch(u, `${token.slice(0, -3)}abc`)).status).toBe(400);
    expect((await t.launch(u, 'nope')).status).toBe(400);
    // edited after the review
    await t.plan(u, { creatives: undefined, name: 'Winter pipes (edited)' });
    const edited = await t.launch(u, token);
    expect(edited).toMatchObject({ status: 409, body: { code: 'PLAN_CHANGED' } });
    // expired
    await t.plan(u);
    const pv2 = await t.preview(u, await t.request(u));
    t.clock.t += 11 * 60_000;
    expect((await t.launch(u, pv2.body.reviewToken)).body.code).toBe('REVIEW_EXPIRED');
    expect(t.writes(before)).toEqual([]);
    const audit = await t.audit(u.id);
    expect(audit.some((a) => a.outcome === 'refused' && /The plan changed/.test(a.summary))).toBe(true);
  });

  it('a double press (same clientRequestId) gives one job and one create', async () => {
    const pv = await t.preview(u, await t.request(u));
    const id = crypto.randomUUID();
    const [a, b] = await Promise.all([t.launch(u, pv.body.reviewToken, id), t.launch(u, pv.body.reviewToken, id)]);
    await t.settled();
    const c = await t.launch(u, pv.body.reviewToken, id);
    expect(new Set([a.body.job.id, b.body.job.id, c.body.job.id]).size).toBe(1);
    expect(writePaths().filter((p) => p === 'POST /ads/create')).toHaveLength(1);
    expect(c.body.replayed).toBe(true);
  });

  it('a second launch of the same plan on the same platform is ALREADY_LAUNCHED', async () => {
    await t.launchPlan(u, 'meta');
    const pv = await t.preview(u, await t.request(u));
    const before = t.writes().length;
    const again = await t.launch(u, pv.body.reviewToken);
    expect(again).toMatchObject({ status: 409, body: { code: 'ALREADY_LAUNCHED' } });
    expect(t.writes(before)).toEqual([]);
  });

  it('Meta PAUSED: create (campaign held off) then the spending limit; no switch-on', async () => {
    const r = await t.launchPlan(u, 'meta', { status: 'PAUSED' });
    expect(writePaths()).toEqual(['POST /ads/create', 'PUT /ads/campaigns/:id']);
    const [create, cap] = t.writes();
    expect(create.body).toMatchObject({ status: 'PAUSED', campaignStatus: 'PAUSED', adSetStatus: 'ACTIVE', adStatus: 'ACTIVE', budgetAmount: 25, budgetType: 'daily' });
    expect(create.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(cap.body).toEqual({ platform: 'facebook', platformSpecificData: { spendCap: 350 } });
    expect(r.job).toMatchObject({ state: 'done' });
    expect(r.campaign).toMatchObject({ state: 'paused', launchedAs: 'PAUSED', configuredStatus: 'PAUSED', spendCap: 350 });
    const row = await t.row(r.campaign.id);
    expect(JSON.stringify(row.sent_body)).not.toContain('/api/media/public/');
    expect(row.sent_body.creatives[0].imageUrl).toBe('media:img-A.jpg');
  });

  it('Meta ACTIVE: create → spending limit → switch on, in that order', async () => {
    const r = await t.launchPlan(u, 'meta', { status: 'ACTIVE' });
    expect(writePaths()).toEqual(['POST /ads/create', 'PUT /ads/campaigns/:id', 'PUT /ads/campaigns/:id/status']);
    expect(t.writes()[2].body).toEqual({ status: 'active', platform: 'facebook' });
    expect(r.campaign).toMatchObject({ state: 'in_review', configuredStatus: 'ACTIVE', spendCap: 350 });
    const row = await t.row(r.campaign.id);
    expect(metaCampaign(row)).toMatchObject({ configuredStatus: 'ACTIVE', spendCap: 350 });
  });

  it('a refused spending limit leaves the campaign paused (CAP_NOT_SET) and never switches it on', async () => {
    t.zm.ads.fail('PUT /ads/campaigns/:id', '401-reconnect');
    const r = await t.launchPlan(u, 'meta', { status: 'ACTIVE' });
    expect(writePaths()).toEqual(['POST /ads/create', 'PUT /ads/campaigns/:id']);
    expect(r.job).toMatchObject({ state: 'done', code: 'CAP_NOT_SET' });
    expect(r.job.message).toContain('$350.00 spending limit');
    expect(r.campaign).toMatchObject({ state: 'paused', configuredStatus: 'PAUSED' });
    expect(r.campaign.spendCap).toBeUndefined();
  });

  it('dates: N days end on start + N − 1; “as soon as approved” sends no startDate; a launch 9 minutes after the preview has the same body', async () => {
    const pv = await t.preview(u, await t.request(u, 'meta', { startDate: null, durationDays: 14 }));
    expect(pv.body.review).toMatchObject({ asap: true, start: t.day(0), end: t.day(13), plannedTotal: 350 });
    t.clock.t += 9 * 60_000;
    const res = await t.launch(u, pv.body.reviewToken);
    expect(res.status).toBe(200);
    await t.settled();
    const create = t.writes()[0].body;
    expect(create).not.toHaveProperty('startDate');
    expect(create.endDate).toBe(pv.body.review.end);
  });

  it('a create that times out is unknown; reads, restarts and reloads never send it again; Check status reads only', async () => {
    t.zm.ads.fail('POST /ads/create', 'timeout');
    const r = await t.launchPlan(u, 'meta');
    expect(r.job).toMatchObject({ state: 'unknown' });
    expect(r.job.message).toContain('may have happened - check status before trying again');
    expect(r.campaign.state).toBe('unknown');
    for (let i = 0; i < 3; i++) await t.call(u, 'GET', `/api/ads/jobs/${r.job.id}`);
    await t.ads.onStart();
    await t.call(u, 'GET', '/api/ads/campaigns?projectId=proj-1');
    expect(writePaths()).toEqual(['POST /ads/create']);
    // Check status: GETs only. Meta hasn't got it and the read is too soon after the send to say so
    const c1 = await t.call(u, 'POST', `/api/ads/jobs/${r.job.id}/check`, {});
    expect(c1.body.job.state).toBe('unknown');
    expect(c1.body.note).toMatch(/Check again in a few minutes/);
    expect((await t.call(u, 'POST', `/api/ads/jobs/${r.job.id}/check`, {})).status).toBe(429);
    // two minutes later the live read is fresh enough: not created
    t.clock.t += 3 * 60_000;
    const c2 = await t.call(u, 'POST', `/api/ads/jobs/${r.job.id}/check`, {});
    expect(c2.body.job).toMatchObject({ state: 'failed', code: 'NOT_CREATED' });
    expect(c2.body.campaign.state).toBe('failed');
    expect(writePaths()).toEqual(['POST /ads/create']);
    // "Launch again": a new key and a new tag through a new confirm
    t.zm.ads.release();
    const again = await t.launchPlan(u, 'meta');
    expect(again.job.state).toBe('done');
    const creates = t.writes().filter((w) => w.path === '/api/v1/ads/create');
    expect(creates).toHaveLength(2);
    expect(creates[1].idempotencyKey).not.toBe(creates[0].idempotencyKey);
    expect(creates[1].body.name).not.toBe(creates[0].body.name);
  });

  it('Check status finds a campaign Meta made but Zernio never stored (live read), and never says NOT_CREATED', async () => {
    t.zm.ads.fail('POST /ads/create', 'created-not-stored-hang');
    const r = await t.launchPlan(u, 'meta');
    expect(r.job.state).toBe('unknown');
    t.clock.t += 5 * 60_000;
    const c = await t.call(u, 'POST', `/api/ads/jobs/${r.job.id}/check`, {});
    expect(c.body.job).toMatchObject({ state: 'done', code: 'CAP_NOT_SET' });
    expect(c.body.campaign).toMatchObject({ state: 'paused', configuredStatus: 'PAUSED' });
    expect(c.body.campaign.platformCampaignId).toMatch(/^\d+$/);
    expect(writePaths()).toEqual(['POST /ads/create']);
  });

  it('a failed create that left parts behind is failed, with the parts listed', async () => {
    t.zm.ads.fail('POST /ads/create', '503-left-behind');
    const r = await t.launchPlan(u, 'meta');
    expect(r.job).toMatchObject({ state: 'failed', code: 'PARTIAL_LEFT' });
    expect(r.job.leftBehind).toEqual([expect.stringMatching(/^campaign …\d{4}$/)]);
    expect(r.campaign.state).toBe('failed');
  });

  it('activation_failed: done ACTIVATION_FAILED with the spending limit set; Resume switches the refused ad on first, the campaign last', async () => {
    t.zm.ads.fail('POST /ads/create', '201-activation-failed');
    const r = await t.launchPlan(u, 'meta', { status: 'PAUSED' });
    expect(r.job).toMatchObject({ state: 'done', code: 'ACTIVATION_FAILED' });
    expect(r.campaign).toMatchObject({ spendCap: 350, adsOff: 1 });
    const from = t.writes().length;
    const res = await t.changeCampaign(u, r.campaign.id, { action: 'resume' });
    expect(res.preview.body.review.confirmKind).toBe('spend');
    expect(res.job).toMatchObject({ state: 'done' });
    expect(writePaths(from)).toEqual(['PUT /ads/:zad/status', 'PUT /ads/campaigns/:id/status']);
    expect(res.campaign).toMatchObject({ configuredStatus: 'ACTIVE' });
    expect(res.campaign.adsOff).toBeUndefined();
  });

  it('never shows Zernio’s, Meta’s or Google’s text for a refusal we have a sentence for, the key or a Zernio id', async () => {
    // (Meta's own words go along only where our sentence needs them: budget_too_low, below)
    t.zm.ads.fail('POST /ads/create', '403-payment');
    const r = await t.launchPlan(u, 'meta');
    expect(r.job).toMatchObject({ state: 'failed', code: 'PAYMENT_REQUIRED' });
    const all = JSON.stringify([r, await t.call(u, 'GET', '/api/ads/campaigns?projectId=proj-1'), await t.call(u, 'GET', '/api/ads/audit?projectId=proj-1'), await t.call(u, 'GET', '/api/ads/accounts?projectId=proj-1&platform=meta')]);
    expect(all).not.toMatch(/SECRET|mock |platformError|error_user_msg/);
    expect(all).not.toContain(TEST_ZERNIO_KEY);
    for (const a of t.zm.accounts) expect(all).not.toContain(a._id);
    expect(t.lines.join('\n')).not.toContain(TEST_ZERNIO_KEY);
  });
});

describe('Meta’s 24-hour rule for a daily budget (the live refusal of 6 Nov)', () => {
  beforeEach(async () => ready());
  const DAILY_24H = /^Meta needs a daily-budget ad to run more than 24 hours\. Choose at least [23] days\.$/;

  it('blocks a schedule of 24 hours or less at Review, with no review token, and sends nothing', async () => {
    const before = t.writes().length;
    // as soon as approved today with 1 day (the incident), a later day with 1 day, a late start time
    for (const extra of [{ startDate: null, durationDays: 1 }, { startDate: t.day(10), durationDays: 1 }, { startDate: t.day(3), startTime: '23:30', durationDays: 1 }]) {
      const pv = await t.preview(u, await t.request(u, 'meta', extra));
      expect(pv.status).toBe(200);
      expect(pv.body.reviewToken).toBeUndefined();
      const b = pv.body.review.blockers.find((n) => n.code === 'META_DAILY_24H');
      expect(b?.message).toMatch(DAILY_24H);
    }
    // 2 days from a later day (and from a late start time) pass: Meta gets more than 24 hours
    for (const extra of [{ startDate: t.day(10), durationDays: 2 }, { startDate: t.day(3), startTime: '23:30', durationDays: 2 }]) {
      const ok = await t.preview(u, await t.request(u, 'meta', extra));
      expect(codes(ok.body.review.blockers)).toEqual([]);
      expect(ok.body.reviewToken).toBeTruthy();
    }
    expect(t.writes(before)).toEqual([]);
  });

  it('“Launch again” after a refused launch goes through the same check', async () => {
    t.zm.ads.fail('POST /ads/create', '403-payment');
    const first = await t.launchPlan(u, 'meta', { startDate: t.day(10), durationDays: 2 });
    expect(first.job.state).toBe('failed');
    expect(first.campaign.state).toBe('failed');
    // Launch again opens a new review of the same plan: 1 day is refused before anything is sent
    const before = t.writes().length;
    const short = await t.preview(u, await t.request(u, 'meta', { startDate: null, durationDays: 1 }));
    expect(codes(short.body.review.blockers)).toContain('META_DAILY_24H');
    expect(short.body.reviewToken).toBeUndefined();
    expect(t.writes(before)).toEqual([]);
    const again = await t.launchPlan(u, 'meta', { startDate: t.day(5), durationDays: 2 });
    expect(again.job.state).toBe('done');
    const creates = t.writes().filter((w) => w.path === '/api/v1/ads/create');
    expect(creates).toHaveLength(2);
    expect(creates[1].body).toMatchObject({ startDate: t.day(5), endDate: t.day(6) });
  });
});

describe('why Meta refused: the refusal’s own reason, kept and said plainly', () => {
  beforeEach(async () => ready());
  const NOTHING = 'Nothing was created and no money was spent.';
  const failedAudit = async () => (await t.audit(u.id)).find((a) => a.action === 'launch' && a.outcome === 'failed');
  const auditList = async () => (await t.call(u, 'GET', '/api/ads/audit?projectId=proj-1')).body.entries;

  it.each(Object.keys(META_REFUSALS))('%s: stored on the job and its audit row; the customer reads our sentence, nothing was created, and the fix link', async (code) => {
    t.zm.ads.fail('POST /ads/create', `meta-refusal:${code}`);
    const r = await t.launchPlan(u, 'meta');
    const m = META_REFUSALS[code];
    // the job keeps today's category, and the refusal's safe fields
    const row = await t.jobRow(r.job.id);
    expect(row).toMatchObject({ state: 'failed', error_code: ZERNIO_CODES[code] ?? 'REFUSED' });
    expect(row.error_detail).toMatchObject({ code, type: m.type, status: m.status, hint: `zernio-hint for ${code}`, ...(m.fix ? { fix: m.fix } : {}), ...(m.param ? { param: m.param } : {}) });
    if (m.type === 'platform_error') expect(row.error_detail).toMatchObject({ metaMessage: `META-OWN-WORDS for ${code}`, ...(m.subcode ? { subcode: m.subcode } : {}) });
    expect((await failedAudit()).after).toEqual({ refusal: row.error_detail });
    // the customer: our own sentence for the code, then what happened, the fix link; never Zernio's words, and
    // Meta's own only where our sentence needs them (Meta's minimum budget is only in Meta's message)
    const said = `${messageFor(REFUSAL_REASON[code], { platform: 'meta' })} ${NOTHING}`;
    const metaSays = code === 'budget_too_low' ? `META-OWN-WORDS title: META-OWN-WORDS for ${code}` : undefined;
    expect(r.job).toMatchObject({ state: 'failed', message: said });
    expect(r.job.message).not.toMatch(/to see why/);
    expect(r.job.platformSays).toBe(metaSays);
    if (m.fix) expect(r.job.fixUrl).toBe(shownFix(code));
    else expect(r.job).not.toHaveProperty('fixUrl');
    const campaigns = await t.call(u, 'GET', '/api/ads/campaigns?projectId=proj-1');
    expect(campaigns.body.campaigns[0]).toMatchObject({ state: 'failed', lastJob: { message: said } });
    // the activity log says the same, with the same link
    const entry = (await auditList()).find((e) => e.action === 'launch' && e.outcome === 'failed');
    const line = `${said}${metaSays ? ` Meta’s message: “${metaSays}”` : ''}`;
    expect(entry.summary).toMatch(new RegExp(`: not done\\. ${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    if (m.fix) expect(entry.fixUrl).toBe(shownFix(code));
    const all = JSON.stringify([r, campaigns.body, await auditList()]);
    expect(all).not.toMatch(metaSays ? /zernio-hint|mock |platformError|error_user/ : /zernio-hint|META-OWN-WORDS|mock |platformError|error_user/);
  });

  it('a refusal Zernio has no code for: Zernio’s hint, cut and as plain text, labelled as Meta’s message; never a foreign link', async () => {
    t.zm.ads.fail('POST /ads/create', 'meta-refusal-unknown');
    const r = await t.launchPlan(u, 'meta');
    expect(r.job).toMatchObject({ state: 'failed', code: 'REFUSED', message: `Meta refused the launch. ${NOTHING}` });
    expect(r.job.platformSays).toHaveLength(300);
    expect(r.job.platformSays.startsWith('<script>alert(1)</script> [Fix it](https://evil.example) Use an image Meta can read.')).toBe(true);
    expect(r.job.platformSays).not.toMatch(/[\u0000-\u001f\u202a-\u202e]/);
    // a link shim on facebook.com, labelled "Click here to claim": never shown
    expect(r.job).not.toHaveProperty('fixUrl');
    expect((await t.jobRow(r.job.id)).error_detail).not.toHaveProperty('fix');
    const entry = (await auditList()).find((e) => e.action === 'launch' && e.outcome === 'failed');
    expect(entry.summary).toContain(`: not done. Meta refused the launch. ${NOTHING} Meta’s message: “<script>alert(1)</script>`);
    expect(entry.summary.length).toBeLessThanOrEqual(500);
    expect(entry.summary.endsWith('…”')).toBe(true);
    expect(entry).not.toHaveProperty('fixUrl');
  });

  it('a team-level refusal (our Zernio key) stays the owner’s: the customer reads “isn’t available”, never Zernio’s words', async () => {
    t.zm.ads.fail('POST /ads/create', 'restricted-key');
    const r = await t.launchPlan(u, 'meta');
    expect(r.job).toMatchObject({ state: 'failed', code: 'ADS_UNAVAILABLE', message: messageFor('ADS_UNAVAILABLE') });
    expect(r.job).not.toHaveProperty('platformSays');
    expect(r.job).not.toHaveProperty('fixUrl');
    expect((await t.jobRow(r.job.id)).error_detail).toEqual({ status: 403, code: 'insufficient_permissions', type: 'permission_error', owner: true });
    const all = JSON.stringify([r, await t.call(u, 'GET', '/api/ads/campaigns?projectId=proj-1'), await auditList(), await t.audit(u.id)]);
    expect(all).not.toMatch(/SECRET-TEAM-TEXT|required_group|zernio/i);
    expect(t.storage.documents.get('zernio:alert')?.value?.kind).toBe('insufficient_permissions');
  });

  it('a refused change keeps its reason too and says nothing was changed', async () => {
    const launched = await t.launchPlan(u, 'meta', { status: 'PAUSED' });
    t.zm.ads.fail('PUT /ads/ad-sets/:id', 'meta-refusal:budget_too_low');
    const res = await t.changeCampaign(u, launched.campaign.id, { action: 'budget', dailyBudget: 20 });
    expect(res.job).toMatchObject({ state: 'failed', code: 'BUDGET_TOO_LOW', message: `${messageFor('BUDGET_TOO_LOW', { platform: 'meta' })} Nothing was changed.` });
    expect((await t.jobRow(res.job.id)).error_detail).toMatchObject({ code: 'budget_too_low', subcode: 1885272, param: 'budgetAmount' });
    expect(res.campaign.lastJob.message).toBe(res.job.message);
  });

  it('the live refusal of 6 Nov, as it was stored (REFUSED, nothing else): the Campaigns tab now says why, not “open Ads Manager”', async () => {
    const id = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const asked = '2026-11-07T01:40:00.000Z'; // 5:40 PM in Los Angeles on Fri 6 Nov 2026
    await t.db.insert('ad_campaigns', { id, user_id: u.id, customer_tag: 'cust_000000000000000000000000', project_id: 'proj-1', plan_id: 'plan-1', platform: 'meta', zernio_account_id: 'a'.repeat(24), ad_account_id: 'act_1', ad_account_name: 'Acme Plumbing', currency: 'USD', timezone: 'America/Los_Angeles', name: 'Winter pipes · Meta · YLB 0123456789ab', launch_key: crypto.randomUUID(), goal: 'traffic', budget_level: 'adset', daily_budget: 1, start_at: asked, end_at: '2026-11-07T07:59:59.000Z', launched_as: 'PAUSED', state: 'failed', configured_status: null, review: {}, remote: {}, sent_body: {} });
    await t.db.insert('ad_jobs', { id: jobId, user_id: u.id, campaign_id: id, kind: 'launch', actor: 'customer', client_request_id: crypto.randomUUID(), state: 'failed', error_code: 'REFUSED', request: { platform: 'meta', account: { name: 'Acme Plumbing', idTail: 't_1', currency: 'USD', timezone: 'America/Los_Angeles' }, status: 'PAUSED', daily: 1, days: 1, start: '2026-11-06', startTime: null, asap: true, end: '2026-11-06', plannedTotal: 1 }, provider_ref: { sent: true }, requested_at: asked, finished_at: asked });
    const got = await t.call(u, 'GET', '/api/ads/campaigns?projectId=proj-1');
    const c = got.body.campaigns.find((x) => x.id === id);
    expect(c.lastJob.message).toBe(`Meta needs a daily-budget ad to run more than 24 hours, and this one was set for less. Launch it again with at least 2 days. ${NOTHING}`);
    expect(JSON.stringify(c)).not.toMatch(/to see why/);
  });
});

describe('Google', () => {
  beforeEach(async () => ready({}, { platforms: ['google_ads'] }));

  it('creates the campaign PAUSED, then switches it on only for ACTIVE (a late create can never be live untracked)', async () => {
    const r = await t.launchPlan(u, 'google', { status: 'ACTIVE' });
    expect(writePaths()).toEqual(['POST /ads/create', 'PUT /ads/campaigns/:id/status']);
    expect(t.writes()[0].body).toMatchObject({ campaignType: 'search', status: 'PAUSED', campaignStatus: 'PAUSED', adSetStatus: 'ACTIVE', adStatus: 'ACTIVE' });
    expect(t.writes()[1].body).toEqual({ status: 'active', platform: 'google' });
    expect(r.campaign).toMatchObject({ state: 'in_review', configuredStatus: 'ACTIVE' });
    expect(r.campaign.spendCap).toBeUndefined();
  });

  it('a Google PAUSED launch is the create only', async () => {
    const r = await t.launchPlan(u, 'google', { status: 'PAUSED' });
    expect(writePaths()).toEqual(['POST /ads/create']);
    expect(r.campaign).toMatchObject({ state: 'paused', configuredStatus: 'PAUSED' });
  });

  it('a raise is never shown or handled as a cut when Google’s synced figure lags behind our own last change', async () => {
    const r = await t.launchPlan(u, 'google', { status: 'ACTIVE', dailyBudget: 40 });
    const lower = await t.changeCampaign(u, r.campaign.id, { action: 'budget', dailyBudget: 20 });
    expect(lower.job.state).toBe('done');
    // the synced tree still says 40; the customer now sets 30: that is a raise from 20
    t.zm.ads.state.campaigns.get(r.campaign.platformCampaignId).campaignBudget = { amount: 40, type: 'daily' };
    const pv = await t.changePreview(u, r.campaign.id, { action: 'budget', dailyBudget: 30 });
    expect(pv.body.review).toMatchObject({ confirmKind: 'spend', dailyDelta: 10, current: { daily: 20 } });
    expect(codes(pv.body.review.notes)).toContain('GOOGLE_BUDGET_LAG');
  });

  it('a timed-out Google create stays unknown until a sync newer than the send, then reads NOT_CREATED', async () => {
    t.zm.ads.fail('POST /ads/create', 'timeout');
    const r = await t.launchPlan(u, 'google');
    t.zm.ads.state.syncedAt = new Date(t.clock.t - 60 * 60_000).toISOString();
    const c1 = await t.call(u, 'POST', `/api/ads/jobs/${r.job.id}/check`, {});
    expect(c1.body.job.state).toBe('unknown');
    expect(c1.body.note).toMatch(/15 to 60 minutes late/);
    t.clock.t += 11 * 60_000;
    t.zm.ads.state.syncedAt = new Date(t.clock.t).toISOString();
    const c2 = await t.call(u, 'POST', `/api/ads/jobs/${r.job.id}/check`, {});
    expect(c2.body.job).toMatchObject({ state: 'failed', code: 'NOT_CREATED' });
  });

  it('refuses an end-date change before any call (Google can’t change dates)', async () => {
    const r = await t.launchPlan(u, 'google');
    const from = t.zm.calls.length;
    const pv = await t.changePreview(u, r.campaign.id, { action: 'end_date', endDate: t.day(40) });
    expect(codes(pv.body.review.blockers)).toContain('GOOGLE_NO_DATES');
    expect(pv.body.reviewToken).toBeUndefined();
    expect(t.writes(from)).toEqual([]);
  });

  it('a shared budget is refused plainly', async () => {
    const r = await t.launchPlan(u, 'google');
    t.zm.ads.state.sharedBudget.add(r.campaign.platformCampaignId);
    t.zm.ads.state.syncedAt = null;
    const res = await t.changeCampaign(u, r.campaign.id, { action: 'budget', dailyBudget: 20 });
    expect(res.preview.body.review.confirmKind).toBe('short');
    expect(res.job).toMatchObject({ state: 'failed', code: 'SHARED_BUDGET' });
    expect(res.job.message).toBe('This budget is shared with other campaigns in Google Ads; change it there. Nothing was changed.');
  });
});

describe('two platforms', () => {
  it('two launches are two jobs; one failing leaves the other done', async () => {
    await ready({}, { platforms: ['meta_ads', 'google_ads'] });
    const g = await t.request(u, 'google', { dailyBudget: 10 });
    const m = await t.request(u, 'meta', { dailyBudget: 15 });
    const pg = await t.preview(u, g);
    const pm = await t.preview(u, m);
    t.zm.ads.fail('POST /ads/create', '403-payment');
    const a = await t.launch(u, pm.body.reviewToken);
    await t.settled();
    const b = await t.launch(u, pg.body.reviewToken);
    await t.settled();
    const ja = (await t.call(u, 'GET', `/api/ads/jobs/${a.body.job.id}`)).body.job;
    const jb = (await t.call(u, 'GET', `/api/ads/jobs/${b.body.job.id}`)).body.job;
    expect(ja).toMatchObject({ state: 'failed', code: 'PAYMENT_REQUIRED' });
    expect(jb).toMatchObject({ state: 'done' });
    expect(writePaths().filter((p) => p === 'POST /ads/create')).toHaveLength(2);
  });
});

describe('changes (§9.1)', () => {
  let launched;
  beforeEach(async () => {
    await ready();
    launched = await t.launchPlan(u, 'meta', { status: 'PAUSED' });
  });

  it('resume of a PAUSED launch is one status write behind a spend confirm', async () => {
    const from = t.writes().length;
    const r = await t.changeCampaign(u, launched.campaign.id, { action: 'resume' });
    expect(r.preview.body.review).toMatchObject({ confirmKind: 'spend', current: { live: true } });
    expect(writePaths(from)).toEqual(['PUT /ads/campaigns/:id/status']);
    expect(r.campaign.configuredStatus).toBe('ACTIVE');
  });

  it('a resume that fails on a child step leaves the campaign off', async () => {
    const row = await t.row(launched.campaign.id);
    await t.db.update('ad_campaigns', { id: row.id }, { remote: { ...row.remote, offAds: [row.remote.zernioAdIds[0]] } });
    t.zm.ads.fail('PUT /ads/:adId/status', '401-reconnect');
    const from = t.writes().length;
    const r = await t.changeCampaign(u, launched.campaign.id, { action: 'resume' });
    expect(r.job.state).toBe('failed');
    expect(writePaths(from)).toEqual(['PUT /ads/:zad/status']);
    expect(metaCampaign(row).configuredStatus).toBe('PAUSED');
  });

  it('a budget increase is a spend confirm and sends the spending limit first, then the budget', async () => {
    const from = t.writes().length;
    const r = await t.changeCampaign(u, launched.campaign.id, { action: 'budget', dailyBudget: 40 });
    expect(r.preview.body.review).toMatchObject({ confirmKind: 'spend', dailyDelta: 15, newSpendCap: 560 });
    expect(writePaths(from)).toEqual(['PUT /ads/campaigns/:id', 'PUT /ads/ad-sets/:id']);
    expect(t.writes(from)[0].body).toEqual({ platform: 'facebook', platformSpecificData: { spendCap: 560 } });
    expect(t.writes(from)[1].body).toEqual({ platform: 'facebook', budget: { amount: 40, type: 'daily' } });
    expect(r.campaign).toMatchObject({ daily: 40, spendCap: 560 });
  });

  it('a decrease is a short confirm and only the budget', async () => {
    const from = t.writes().length;
    const r = await t.changeCampaign(u, launched.campaign.id, { action: 'budget', dailyBudget: 10 });
    expect(r.preview.body.review.confirmKind).toBe('short');
    expect(writePaths(from)).toEqual(['PUT /ads/ad-sets/:id']);
  });

  it('refuses an increase over the owner’s per-change limit in the preview', async () => {
    const pv = await t.changePreview(u, launched.campaign.id, { action: 'budget', dailyBudget: 90 });
    expect(codes(pv.body.review.blockers)).toEqual(expect.arrayContaining(['LIMIT_CHANGE']));
    expect(pv.body.reviewToken).toBeUndefined();
  });

  it('a budget changed in Ads Manager between preview and write is LIVE_CHANGED: nothing sent', async () => {
    const pv = await t.changePreview(u, launched.campaign.id, { action: 'budget', dailyBudget: 20 });
    metaCampaign(await t.row(launched.campaign.id)).adSets[0].dailyBudget = 45;
    const from = t.writes().length;
    const res = await t.change(u, launched.campaign.id, pv.body.reviewToken);
    expect(res.body.code).toBe('LIVE_CHANGED');
    expect(t.writes(from)).toEqual([]);
  });

  it('a budget sent to the wrong level is refused plainly', async () => {
    t.zm.ads.fail('PUT /ads/ad-sets/:id', '409-budget-level');
    const r = await t.changeCampaign(u, launched.campaign.id, { action: 'budget', dailyBudget: 20 });
    expect(r.job).toMatchObject({ state: 'failed', code: 'BUDGET_LEVEL' });
  });

  it('a lifetime budget set in Ads Manager disables the budget change', async () => {
    metaCampaign(await t.row(launched.campaign.id)).lifetimeBudget = 500;
    const pv = await t.changePreview(u, launched.campaign.id, { action: 'budget', dailyBudget: 20 });
    expect(codes(pv.body.review.blockers)).toContain('LIFETIME_BUDGET');
  });

  it('an unknown change blocks the next one until checked; a third value stays unknown', async () => {
    t.zm.ads.fail('PUT /ads/ad-sets/:id', 'timeout');
    const r = await t.changeCampaign(u, launched.campaign.id, { action: 'budget', dailyBudget: 20 });
    expect(r.job.state).toBe('unknown');
    const pv = await t.changePreview(u, launched.campaign.id, { action: 'budget', dailyBudget: 15 });
    expect(codes(pv.body.review.blockers)).toContain('JOB_LIVE');
    metaCampaign(await t.row(launched.campaign.id)).adSets[0].dailyBudget = 33;
    t.zm.ads.release();
    const c = await t.call(u, 'POST', `/api/ads/jobs/${r.job.id}/check`, {});
    expect(c.body.job.state).toBe('unknown');
    expect(c.body.note).toBe('The budget is now $33.00, which is neither the old nor the new amount. Check in Ads Manager.');
    metaCampaign(await t.row(launched.campaign.id)).adSets[0].dailyBudget = 20;
    t.clock.t += 31_000;
    const c2 = await t.call(u, 'POST', `/api/ads/jobs/${r.job.id}/check`, {});
    expect(c2.body.job.state).toBe('done');
    expect(c2.body.campaign.daily).toBe(20);
  });

  it('repeated end-date extensions are refused once spent + remaining passes the campaign total', async () => {
    const r1 = await t.changeCampaign(u, launched.campaign.id, { action: 'end_date', endDate: t.day(10 + 24) });
    expect(r1.preview.body.review.confirmKind).toBe('spend');
    expect(r1.job.state).toBe('done');
    // spend reported so far comes in on refresh: $100
    const row = await t.row(launched.campaign.id);
    await t.db.update('ad_campaigns', { id: row.id }, { results: { spend: 100 } });
    const pv = await t.changePreview(u, launched.campaign.id, { action: 'end_date', endDate: t.day(10 + 29) });
    expect(codes(pv.body.review.blockers)).toContain('LIMIT_TOTAL');
    const set = t.writes().find((w) => w.path.includes('/ads/ad-sets/') && w.body?.platformSpecificData?.endDate);
    expect(set.body.platformSpecificData.endDate).toMatch(/T23:59:59-0[56]:00$/);
    expect(set.body).not.toHaveProperty('endDate');
  });

  it('pause works with ads off for the customer, a blocked customer, the kill switch and a full ads-write bucket', async () => {
    await t.db.update('ad_limits', { customer_tag: '*' }, { ads_enabled: false, version: 9 });
    const tag = (await t.row(launched.campaign.id)).customer_tag;
    await t.db.insert('billing_caps', { customer_tag: tag, status: 'blocked', daily_cap_micro: 1, monthly_cap_micro: 1, calls_per_day: 1, posts_per_day: 1, x_posts_per_day: 1 });
    t.env.ADS_LAUNCH_ENABLED = '0';
    // fill the ads-write bucket (20 an hour): launches and increases are now refused before anything else
    const tries = [];
    for (let i = 0; i < 21; i++) tries.push((await t.launch(u, 'x')).status);
    expect(tries.at(-1)).toBe(429);
    // resume (spend) is refused …
    const resume = await t.changePreview(u, launched.campaign.id, { action: 'resume' });
    expect(resume.status).toBe(403);
    // … the campaign is paused already, so switch it on in "Ads Manager" and pause it from the app
    metaCampaign(await t.row(launched.campaign.id)).configuredStatus = 'ACTIVE';
    const from = t.writes().length;
    const r = await t.changeCampaign(u, launched.campaign.id, { action: 'pause' });
    expect(r.preview.body.review.confirmKind).toBe('short');
    expect(r.job.state).toBe('done');
    expect(writePaths(from)).toEqual(['PUT /ads/campaigns/:id/status']);
    expect(t.writes(from)[0].body).toEqual({ status: 'paused', platform: 'facebook' });
  });

  it('end always sends the pause: a campaign switched on after the review is never marked ended while running', async () => {
    const pv = await t.changePreview(u, launched.campaign.id, { action: 'end' });
    expect(pv.body.review.current.configured).toBe('PAUSED');
    // resumed in Ads Manager (or another tab) after the review
    metaCampaign(await t.row(launched.campaign.id)).configuredStatus = 'ACTIVE';
    const from = t.writes().length;
    const res = await t.change(u, launched.campaign.id, pv.body.reviewToken);
    expect(res.status).toBe(200);
    await t.settled();
    expect(writePaths(from)).toEqual(['PUT /ads/campaigns/:id/status']);
    expect(t.writes(from)[0].body).toEqual({ status: 'paused', platform: 'facebook' });
    expect(metaCampaign(await t.row(launched.campaign.id)).configuredStatus).toBe('PAUSED');
    expect((await t.row(launched.campaign.id)).state).toBe('ended');
  });

  it('a review token starts one write, ever: a fresh request id with the same token is REVIEW_USED', async () => {
    const pv = await t.changePreview(u, launched.campaign.id, { action: 'resume' });
    const first = await t.change(u, launched.campaign.id, pv.body.reviewToken);
    expect(first.status).toBe(200);
    await t.settled();
    // paused again in Ads Manager, so the live values match the review once more
    metaCampaign(await t.row(launched.campaign.id)).configuredStatus = 'PAUSED';
    await t.db.update('ad_campaigns', { id: launched.campaign.id }, { configured_status: 'PAUSED', state: 'paused' });
    const from = t.writes().length;
    const again = await t.change(u, launched.campaign.id, pv.body.reviewToken);
    expect(again).toMatchObject({ status: 409, body: { code: 'REVIEW_USED' } });
    expect(t.writes(from)).toEqual([]);
  });

  it('the same request id sent with a different review is REQUEST_MISMATCH, never the old job’s answer', async () => {
    const id = crypto.randomUUID();
    const up = await t.changePreview(u, launched.campaign.id, { action: 'budget', dailyBudget: 40 });
    expect((await t.change(u, launched.campaign.id, up.body.reviewToken, id)).status).toBe(200);
    await t.settled();
    const down = await t.changePreview(u, launched.campaign.id, { action: 'budget', dailyBudget: 30 });
    const from = t.writes().length;
    const res = await t.change(u, launched.campaign.id, down.body.reviewToken, id);
    expect(res).toMatchObject({ status: 409, body: { code: 'REQUEST_MISMATCH' } });
    expect(t.writes(from)).toEqual([]);
    // the same review pressed twice still answers its own job
    expect((await t.change(u, launched.campaign.id, up.body.reviewToken, id)).body).toMatchObject({ replayed: true });
  });

  it('finds the campaign past the first page of the account’s live campaigns', async () => {
    t.zm.ads.state.livePageSize = 1;
    // an older campaign in the same ad account lands first
    await t.plan(u, { id: 'plan-2' });
    const other = await t.preview(u, { ...(await t.request(u, 'meta')), planId: 'plan-2' });
    await t.launch(u, other.body.reviewToken);
    await t.settled();
    // the account lists the other campaign (and its ad set) before ours
    const m = t.zm.ads.state.campaigns;
    const all = [...m.entries()].reverse();
    m.clear();
    for (const [k, v] of all) m.set(k, v);
    const r = await t.changeCampaign(u, launched.campaign.id, { action: 'resume' });
    expect(r.preview.body.review.blockers).toEqual([]);
    expect(r.job.state).toBe('done');
    expect(t.zm.calls.some((c) => c.path.endsWith('/ads/accounts/live') && c.query?.after && c.query?.level)).toBe(true);
  });

  it('a budget set to 12.50 in Ads Manager: the spending limit is rounded down and sent, never a false “may have happened”', async () => {
    const c = metaCampaign(await t.row(launched.campaign.id));
    c.spendCap = null;
    c.adSets[0].dailyBudget = 12.5;
    const r = await t.changeCampaign(u, launched.campaign.id, { action: 'resume' });
    expect(r.job.state).toBe('done');
    const cap = t.writes().find((w) => w.body?.platformSpecificData?.spendCap != null && w.body.platformSpecificData.spendCap !== 350);
    expect(Number.isInteger(cap.body.platformSpecificData.spendCap)).toBe(true);
  });

  it('a decrease below the ad account’s minimum is blocked in the preview', async () => {
    await t.db.update('ad_campaigns', { id: launched.campaign.id }, { min_daily: 5 });
    const pv = await t.changePreview(u, launched.campaign.id, { action: 'budget', dailyBudget: 3 });
    expect(codes(pv.body.review.blockers)).toContain('BUDGET_TOO_LOW');
    expect(pv.body.reviewToken).toBeUndefined();
  });

  it('a swap on a refused campaign whose switch is on is a spend: money confirm, owner switches and plan gate', async () => {
    metaCampaign(await t.row(launched.campaign.id)).configuredStatus = 'ACTIVE';
    await t.db.update('ad_campaigns', { id: launched.campaign.id }, { configured_status: 'ACTIVE', state: 'rejected' });
    const pv = await t.changePreview(u, launched.campaign.id, { action: 'creative', creativeId: 'cr-B', adIndex: 0 });
    expect(pv.body.review).toMatchObject({ confirmKind: 'spend', proposed: { daily: 25 } });
    expect(codes(pv.body.review.notes)).toContain('SWAP_SPENDS');
    await t.db.update('ad_limits', { customer_tag: '*' }, { ads_enabled: false, version: 2 });
    const from = t.writes().length;
    expect((await t.change(u, launched.campaign.id, pv.body.reviewToken)).body.code).toBe('ADS_OFF');
    expect(t.writes(from)).toEqual([]);
  });

  it('Refresh never undoes our own newer write from Zernio’s older stored copy', async () => {
    const r = await t.changeCampaign(u, launched.campaign.id, { action: 'resume' });
    expect(r.campaign.configuredStatus).toBe('ACTIVE');
    // the stored copy was read before the resume and still says paused
    t.zm.ads.state.syncedAt = new Date(t.clock.t - 30 * 60_000).toISOString();
    metaCampaign(await t.row(launched.campaign.id)).configuredStatus = 'PAUSED';
    t.clock.t += 6 * 60_000;
    const res = await t.call(u, 'POST', '/api/ads/campaigns/refresh', { projectId: 'proj-1' });
    expect(res.status).toBe(200);
    expect(res.body.campaigns.find((c) => c.id === launched.campaign.id)).toMatchObject({ configuredStatus: 'ACTIVE' });
    // Refresh asks for our own campaigns by id
    expect(t.zm.calls.some((c) => c.path.endsWith('/ads/tree') && c.query?.campaignId === launched.campaign.platformCampaignId)).toBe(true);
  });

  it('end pauses and ends; ended campaigns can’t be resumed', async () => {
    metaCampaign(await t.row(launched.campaign.id)).configuredStatus = 'ACTIVE';
    const r = await t.changeCampaign(u, launched.campaign.id, { action: 'end' });
    expect(r.job.state).toBe('done');
    expect(r.campaign.state).toBe('ended');
    const pv = await t.changePreview(u, launched.campaign.id, { action: 'resume' });
    expect(codes(pv.body.review.blockers)).toContain('CANT_CHANGE');
  });

  it('swaps a Meta creative with every field, after its claim check', async () => {
    const from = t.writes().length;
    const r = await t.changeCampaign(u, launched.campaign.id, { action: 'creative', creativeId: 'cr-B', adIndex: 0 });
    expect(r.preview.body.review.notes.map((n) => n.code)).toContain('BACK_TO_REVIEW');
    expect(r.job.state).toBe('done');
    const w = t.writes(from)[0];
    expect(Object.keys(w.body.creative).sort()).toEqual(['body', 'callToAction', 'description', 'headline', 'imageUrl', 'linkUrl']);
  });
});

describe('limits (§10) and the plan gate', () => {
  it('fails closed with no defaults row: ads off', async () => {
    await ready({ limits: null });
    const pv = await t.preview(u, await t.request(u));
    expect(pv).toMatchObject({ status: 403, body: { code: 'ADS_OFF' } });
    expect((await t.call(u, 'GET', '/api/ads/accounts?projectId=proj-1&platform=meta')).body.canLaunch).toBe(false);
  });

  it('the kill switch stops launches', async () => {
    await ready({ env: { ADS_LAUNCH_ENABLED: '' } });
    expect((await t.preview(u, await t.request(u))).body.code).toBe('KILL_SWITCH');
  });

  it('launches sent at the same moment are checked one after another against the daily limit', async () => {
    await ready();
    const tokens = [];
    for (const id of ['plan-1', 'plan-2', 'plan-3']) {
      await t.plan(u, { id });
      const pv = await t.preview(u, { ...(await t.request(u, 'meta', { status: 'ACTIVE', dailyBudget: 40 })), planId: id });
      tokens.push(pv.body.reviewToken);
    }
    const res = await Promise.all(tokens.map((tk) => t.launch(u, tk)));
    await t.settled();
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.body?.code === 'LIMIT_DAILY')).toHaveLength(2);
    expect(writePaths().filter((p) => p === 'POST /ads/create')).toHaveLength(1);
  });

  it('counts a rejected campaign whose switch is on toward the daily limit', async () => {
    await ready();
    const a = await t.launchPlan(u, 'meta', { status: 'ACTIVE', dailyBudget: 40 });
    await t.db.update('ad_campaigns', { id: a.campaign.id }, { state: 'rejected' });
    await t.plan(u, { id: 'plan-2' });
    const pv = await t.preview(u, { ...(await t.request(u, 'meta', { status: 'ACTIVE', dailyBudget: 20 })), planId: 'plan-2' });
    expect(codes(pv.body.review.blockers)).toContain('LIMIT_DAILY');
    // a PAUSED launch checks only the per-launch amount and the total
    const pv2 = await t.preview(u, { ...(await t.request(u, 'meta', { status: 'PAUSED', dailyBudget: 20 })), planId: 'plan-2' });
    expect(pv2.body.reviewToken).toBeTruthy();
  });

  it('a limits change between preview and launch is LIMITS_CHANGED', async () => {
    await ready();
    const pv = await t.preview(u, await t.request(u));
    await t.db.update('ad_limits', { customer_tag: '*' }, { version: 2 });
    expect((await t.launch(u, pv.body.reviewToken)).body.code).toBe('LIMITS_CHANGED');
    expect(t.writes()).toEqual([]);
  });

  it('a different currency than the owner’s limit is refused', async () => {
    await ready();
    const list = await t.call(u, 'GET', '/api/ads/accounts?projectId=proj-1&platform=meta');
    const eur = list.body.accounts.find((a) => a.currency === 'EUR');
    await t.call(u, 'PUT', '/api/ads/accounts/choice', { projectId: 'proj-1', platform: 'meta', adAccountRef: eur.ref });
    const pv = await t.preview(u, await t.request(u));
    expect(codes(pv.body.review.blockers)).toEqual(expect.arrayContaining(['LIMIT_CURRENCY']));
  });

  it('the plan gate (false) refuses launch, resume and increases with no call; pause still sends', async () => {
    let open = true;
    await ready({ gate: async () => open });
    const r = await t.launchPlan(u, 'meta', { status: 'PAUSED' });
    open = false;
    const from = t.zm.calls.length;
    expect((await t.call(u, 'GET', '/api/ads/accounts?projectId=proj-1&platform=meta')).body.canLaunch).toBe(false);
    expect((await t.preview(u, await t.request(u))).body.code).toBe('PLAN_REQUIRED');
    expect((await t.changePreview(u, r.campaign.id, { action: 'resume' })).body.code).toBe('PLAN_REQUIRED');
    expect((await t.changePreview(u, r.campaign.id, { action: 'budget', dailyBudget: 30 })).body.code).toBe('PLAN_REQUIRED');
    expect(t.writes(from)).toEqual([]);
    metaCampaign(await t.row(r.campaign.id)).configuredStatus = 'ACTIVE';
    const p = await t.changeCampaign(u, r.campaign.id, { action: 'pause' });
    expect(p.job.state).toBe('done');
    const d = await t.changeCampaign(u, r.campaign.id, { action: 'budget', dailyBudget: 10 });
    expect(d.job.state).toBe('done');
  });
});

describe('ownership', () => {
  it('another user gets 404 on every campaign and job route; an ad account ref from another user is refused', async () => {
    await ready();
    const r = await t.launchPlan(u, 'meta');
    const eve = await t.user('eve@evil.test');
    await t.project(eve);
    for (const [m, p, b] of [
      ['POST', `/api/ads/campaigns/${r.campaign.id}/change/preview`, { action: 'pause' }],
      ['POST', `/api/ads/campaigns/${r.campaign.id}/change`, { reviewToken: 'x', confirm: true, clientRequestId: crypto.randomUUID() }],
      ['GET', `/api/ads/campaigns/${r.campaign.id}/review`],
      ['GET', `/api/ads/jobs/${r.job.id}`],
      ['POST', `/api/ads/jobs/${r.job.id}/check`, {}],
    ]) expect((await t.call(eve, m, p, b)).status, p).toBe(404);
    expect((await t.call(eve, 'GET', `/api/ads/audit?campaignId=${r.campaign.id}`)).body.entries).toEqual([]);
    const refs = (await t.call(u, 'GET', '/api/ads/accounts?projectId=proj-1&platform=meta')).body.accounts.map((a) => a.ref);
    await t.connect(eve, 'meta_ads', { username: 'eve' });
    const res = await t.call(eve, 'PUT', '/api/ads/accounts/choice', { projectId: 'proj-1', platform: 'meta', adAccountRef: refs[0] });
    expect(res.status).toBe(400);
  });

  it('Meta place search asks for every kind of place (countries, regions, ZIPs), not cities only', async () => {
    await ready();
    await t.place(u, 'meta', 'Texas');
    const q = t.zm.calls.filter((c) => c.path.endsWith('/ads/targeting/search')).at(-1).query;
    expect(q).toMatchObject({ dimension: 'geo', geoType: 'all' });
  });

  it('ignores a Zernio accountId in the request: the server resolves the connection', async () => {
    await ready();
    const pv = await t.preview(u, { ...(await t.request(u)), accountId: 'ffffffffffffffffffffffff', zernioAccountId: 'ffffffffffffffffffffffff' });
    await t.launch(u, pv.body.reviewToken);
    await t.settled();
    expect(t.writes()[0].body.accountId).toBe(t.zm.accounts.find((a) => a.platform === 'metaads')._id);
  });
});

describe('audit (R9) and the webhook', () => {
  it('every write and its outcome leave audit rows in our words', async () => {
    await ready();
    const r = await t.launchPlan(u, 'meta');
    await t.changeCampaign(u, r.campaign.id, { action: 'budget', dailyBudget: 20 });
    const list = await t.call(u, 'GET', `/api/ads/audit?projectId=proj-1`);
    const s = list.body.entries.map((e) => `${e.action}:${e.outcome}`);
    expect(s).toEqual(expect.arrayContaining(['launch:sending', 'launch:done', 'budget:sending', 'budget:done']));
    expect(list.body.entries.find((e) => e.action === 'budget' && e.outcome === 'done').summary).toMatch(/^Daily budget \$25\.00 → \$20\.00 on Meta \(Acme Plumbing …1\): done/);
  });

  it('a rejected review arrives on the one Zernio webhook, updates the row and sends nothing', async () => {
    await ready();
    const r = await t.launchPlan(u, 'meta', { status: 'ACTIVE' });
    const from = t.writes().length;
    const out = await t.zm.ads.review(r.campaign.platformCampaignId, 'rejected', { reasons: ['<script>alert(1)</script> Misleading claim'] });
    expect(out.every((o) => o.status === 200)).toBe(true);
    const row = await t.row(r.campaign.id);
    expect(row.state).toBe('rejected');
    expect(row.review.reasons[0]).toBe('<script>alert(1)</script> Misleading claim');
    expect(t.writes(from)).toEqual([]);
    // a duplicate delivery changes nothing more
    const n = (await t.audit(u.id)).length;
    const evt = t.zm.webhooks.at(-1);
    const raw = Buffer.from(JSON.stringify(evt));
    const { signWebhook } = await import('../test/mock-zernio.mjs');
    await fetch(`${t.base}/api/webhooks/zernio`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-zernio-signature': signWebhook(raw) } });
    expect((await t.audit(u.id)).length).toBe(n);
  });

  it('an event for another customer’s campaign id through a different connection changes nothing', async () => {
    await ready();
    const r = await t.launchPlan(u, 'meta', { status: 'ACTIVE' });
    const eve = await t.user('eve@evil.test');
    await t.project(eve);
    const eveAcct = await t.connect(eve, 'meta_ads', { username: 'eve' });
    const doc = (await t.storage.get(`zernio:user:${(await import('../integrations/common.mjs')).sha256(eve.id)}`)).value;
    const row = await t.row(r.campaign.id);
    const res = await t.zm.sendWebhook({ event: 'ad.review.rejected', profiles: t.zm.profileRef(doc.profileId), account: { accountId: eveAcct._id, profileId: doc.profileId, platform: 'metaads' }, adObject: { level: 'AD', platformId: row.remote.adIds[0], platformAdAccountId: 'act_1', adId: row.remote.zernioAdIds[0], name: 'x' }, review: { status: 'rejected', reasons: [] } });
    expect(res.status).toBe(200);
    expect((await t.row(r.campaign.id)).state).toBe('in_review');
  });
});

describe('before the ads migration is run', () => {
  it('account deletion and disconnect read “nothing launched” instead of failing', async () => {
    const { createAdsRoutes } = await import('./routes.mjs');
    const err = Object.assign(new Error('missing'), { name: 'DbError', code: 'NOT_SET_UP' });
    const lines = [];
    const r = createAdsRoutes({ db: { enabled: true, select: async () => Promise.reject(err) }, env: {}, log: { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) } });
    await expect(r.beforeForget('0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11')).resolves.toBeUndefined();
    await expect(r.liveOn('0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11', 'meta_ads')).resolves.toEqual([]);
    expect(lines.join('\n')).toMatch(/ads_not_set_up/);
    t = { violations: () => [], close: async () => {} };
  });
});

describe('account deletion and the live list (R12)', () => {
  it('names the campaigns still on and refuses deletion until acknowledged', async () => {
    await ready();
    const r = await t.launchPlan(u, 'meta', { status: 'ACTIVE' });
    const live = await t.call(u, 'GET', '/api/ads/live');
    expect(live.body.live).toEqual([{ id: r.campaign.id, name: 'Winter pipes', platform: 'meta', daily: 25, currency: 'USD', idTail: '1' }]);
    await expect(t.integrations.forgetUser(u.id)).rejects.toMatchObject({ status: 409, code: 'ADS_LIVE', extra: { live: [expect.objectContaining({ id: r.campaign.id })] } });
    // nothing was disconnected at Zernio
    expect(t.zm.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await t.integrations.forgetUser(u.id, { ackLiveAds: true });
    expect(t.zm.calls.some((c) => c.method === 'DELETE')).toBe(true);
  });
});

describe('ads off and the owner', () => {
  it('answers 503 for everything with no Zernio key; pause says to use Ads Manager', async () => {
    await ready();
    const r = await t.launchPlan(u, 'meta');
    const off = await startAds({ env: { ZERNIO_API_KEY: '' } });
    try {
      const v = await off.user('owner@acme.test');
      const res = await off.call(v, 'GET', '/api/ads/accounts?projectId=proj-1&platform=meta');
      expect(res).toMatchObject({ status: 503, body: { code: 'NOT_SET_UP' } });
      expect((await off.call(v, 'POST', `/api/ads/jobs/${r.job.id}/check`, {})).body.error).toMatch(/Ads Manager/);
    } finally {
      await off.close();
    }
  });

  it('lets the owner set limits (within the hard ceilings) and pause everything for one customer', async () => {
    await ready();
    const r = await t.launchPlan(u, 'meta', { status: 'ACTIVE' });
    const boss = await t.user('boss@app.test', { admin: true });
    expect((await t.call(u, 'GET', '/api/ads/admin/limits')).status).toBe(403);
    const tag = (await t.row(r.campaign.id)).customer_tag;
    const list = await t.call(boss, 'GET', '/api/ads/admin/limits');
    expect(list.body.customers).toEqual([expect.objectContaining({ tag, liveCampaigns: 1, committedDaily: 25 })]);
    expect(list.body.zernioAlert).toBeUndefined();
    // Zernio's team-level alert reaches the owner's page (customers only ever saw our words)
    await t.storage.put('zernio:alert', { kind: 'ads_addon_required', at: new Date().toISOString() });
    expect((await t.call(boss, 'GET', '/api/ads/admin/limits')).body.zernioAlert).toMatchObject({ kind: 'ads_addon_required' });
    expect((await t.call(boss, 'PUT', `/api/ads/admin/limits/${tag}`, { maxDaily: 600 })).status).toBe(400);
    const put = await t.call(boss, 'PUT', `/api/ads/admin/limits/${tag}`, { maxDaily: 100 });
    expect(put.body.limits.maxDaily).toBe(100);
    expect((await t.audit(u.id)).some((a) => a.actor === 'owner' && a.action === 'limits' && /\$100\.00/.test(a.summary))).toBe(true);
    // a currency change is refused while a USD campaign is on
    expect((await t.call(boss, 'PUT', `/api/ads/admin/limits/${tag}`, { adsCurrency: 'EUR' })).status).toBe(409);
    // Pause all: preview, confirm, one pause per campaign
    const pv = await t.call(boss, 'POST', `/api/ads/admin/customers/${tag}/pause-all/preview`, {});
    expect(pv.body.campaigns).toHaveLength(1);
    const from = t.writes().length;
    const go = await t.call(boss, 'POST', `/api/ads/admin/customers/${tag}/pause-all`, { reviewToken: pv.body.reviewToken, confirm: true });
    expect(go.body.jobs).toHaveLength(1);
    await t.settled();
    expect(writePaths(from)).toEqual(['PUT /ads/campaigns/:id/status']);
    const audit = await t.audit(u.id);
    expect(audit.some((a) => a.actor === 'owner' && /Paused by the app owner/.test(a.summary) && a.outcome === 'done')).toBe(true);
  });
});

describe('what a refusal leaves: a change done in part, a campaign still running, objects Meta kept, a launch not switched on', () => {
  beforeEach(async () => ready());
  const auditList = async () => (await t.call(u, 'GET', '/api/ads/audit?projectId=proj-1')).body.entries;
  const lastAudit = async (action, outcome) => (await auditList()).find((e) => e.action === action && e.outcome === outcome);
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const CAP_ONLY = 'Only the first part of this change went through (a higher spending limit, which can’t spend by itself).';

  it('a budget increase refused after its spending limit went up says only that part went through, never “Nothing was changed”', async () => {
    const launched = await t.launchPlan(u, 'meta', { status: 'PAUSED' });
    t.zm.ads.fail('PUT /ads/ad-sets/:id', 'meta-refusal:meta_action_blocked');
    const from = t.writes().length;
    const r = await t.changeCampaign(u, launched.campaign.id, { action: 'budget', dailyBudget: 40 });
    expect(writePaths(from)).toEqual(['PUT /ads/campaigns/:id', 'PUT /ads/ad-sets/:id']);
    const said = `${CAP_ONLY} ${messageFor('META_ACTION_BLOCKED')}`;
    expect(r.job).toMatchObject({ state: 'failed', code: 'ACTION_BLOCKED', message: said });
    // the limit did go up, on Meta and on the row; the budget didn't
    expect(metaCampaign(await t.row(launched.campaign.id)).spendCap).toBe(560);
    expect(r.campaign).toMatchObject({ spendCap: 560, daily: 25, lastJob: { message: said } });
    expect((await t.jobRow(r.job.id)).provider_ref).toMatchObject({ done: ['cap'], op: 'adSetBudget' });
    expect((await lastAudit('budget', 'failed')).summary).toMatch(new RegExp(`: not done\\. ${escapeRe(said)}$`));
    expect(JSON.stringify([r, await auditList()])).not.toMatch(/Nothing was changed/);
  });

  it('a 409 on the budget after the spending limit went up says the same, with that reason', async () => {
    const launched = await t.launchPlan(u, 'meta', { status: 'PAUSED' });
    t.zm.ads.fail('PUT /ads/ad-sets/:id', '409-budget-level');
    const r = await t.changeCampaign(u, launched.campaign.id, { action: 'budget', dailyBudget: 40 });
    expect(r.job).toMatchObject({ state: 'failed', code: 'BUDGET_LEVEL', message: `${CAP_ONLY} ${messageFor('BUDGET_LEVEL')}` });
  });

  it('a resume whose campaign switch is refused after an ad was switched on says the campaign itself is still paused', async () => {
    const launched = await t.launchPlan(u, 'meta', { status: 'PAUSED' });
    const row = await t.row(launched.campaign.id);
    await t.db.update('ad_campaigns', { id: row.id }, { remote: { ...row.remote, offAds: [row.remote.zernioAdIds[0]] } });
    t.zm.ads.fail('PUT /ads/campaigns/:id/status', 'meta-refusal:ad_account_payment_required');
    const from = t.writes().length;
    const r = await t.changeCampaign(u, launched.campaign.id, { action: 'resume' });
    expect(writePaths(from)).toEqual(['PUT /ads/:zad/status', 'PUT /ads/campaigns/:id/status']);
    const said = `Only part of this change went through: parts of it were switched on, but the campaign itself is still paused, so it can’t spend yet. ${messageFor('PAYMENT_REQUIRED')}`;
    expect(r.job).toMatchObject({ state: 'failed', code: 'PAYMENT_REQUIRED', message: said, fixUrl: shownFix('ad_account_payment_required') });
    expect(metaCampaign(row).configuredStatus).toBe('PAUSED');
    expect((await lastAudit('resume', 'failed')).summary).toContain(`: not done. ${said}`);
  });

  it('a refused pause says the campaign is still running and to pause it in Ads Manager now, never “wait”', async () => {
    const launched = await t.launchPlan(u, 'meta', { status: 'PAUSED' });
    metaCampaign(await t.row(launched.campaign.id)).configuredStatus = 'ACTIVE';
    t.zm.ads.fail('PUT /ads/campaigns/:id/status', 'meta-refusal:meta_action_blocked');
    const r = await t.changeCampaign(u, launched.campaign.id, { action: 'pause' });
    const said = 'Meta has blocked the Facebook login connected here from making ad changes for now. It’s still running: pause it in Meta Ads Manager now.';
    expect(r.job).toMatchObject({ state: 'failed', message: said });
    expect(r.campaign.lastJob.message).toBe(said);
    expect(metaCampaign(await t.row(launched.campaign.id)).configuredStatus).toBe('ACTIVE');
    expect((await lastAudit('pause', 'failed')).summary).toMatch(new RegExp(`: not done\\. ${escapeRe(said)}$`));
    expect(JSON.stringify([r, await auditList()])).not.toMatch(/wait a few hours|Nothing was changed/);
  });

  it.each(['ad_account_unusable', 'insufficient_permissions'])('a launch Meta refused (%s) after making the campaign and ad set lists what it kept, never “Nothing was created”', async (code) => {
    t.zm.ads.fail('POST /ads/create', `left-behind:${code}`);
    const r = await t.launchPlan(u, 'meta');
    const said = `${messageFor(REFUSAL_REASON[code], { platform: 'meta' })} ${messageFor('PARTIAL_LEFT')} No money was spent.`;
    expect(r.job).toMatchObject({ state: 'failed', code: ZERNIO_CODES[code], message: said });
    expect(r.job.leftBehind).toEqual([expect.stringMatching(/^campaign …\d{4}$/), expect.stringMatching(/^adset …\d{4}$/)]);
    expect(r.campaign.state).toBe('failed');
    expect((await t.jobRow(r.job.id)).provider_ref.leftBehind).toHaveLength(2);
    const campaigns = (await t.call(u, 'GET', '/api/ads/campaigns?projectId=proj-1')).body;
    expect(campaigns.campaigns[0].lastJob).toMatchObject({ message: said, leftBehind: r.job.leftBehind });
    expect((await lastAudit('launch', 'failed')).summary).toMatch(new RegExp(`: not done\\. ${escapeRe(said)}$`));
    expect(JSON.stringify([r, campaigns, await auditList()])).not.toMatch(/Nothing was created/);
    // what Meta kept is there, paused and with no ads (so it can't spend)
    const kept = [...t.zm.ads.state.campaigns.values()].at(-1);
    expect(kept).toMatchObject({ configuredStatus: 'PAUSED' });
    expect(kept.ads()).toEqual([]);
  });

  it('an ACTIVE launch whose switch-on Meta refused says why, with Meta’s fix page, on the card and in the activity log', async () => {
    t.zm.ads.fail('PUT /ads/campaigns/:id/status', 'meta-refusal:ad_account_payment_required');
    const r = await t.launchPlan(u, 'meta', { status: 'ACTIVE' });
    expect(writePaths()).toEqual(['POST /ads/create', 'PUT /ads/campaigns/:id', 'PUT /ads/campaigns/:id/status']);
    const said = `${messageFor('ACTIVATION_NOT_SENT', { platform: 'meta' })} ${messageFor('PAYMENT_REQUIRED')}`;
    const fix = shownFix('ad_account_payment_required');
    expect(r.job).toMatchObject({ state: 'done', code: 'ACTIVATION_NOT_SENT', message: said, fixUrl: fix });
    expect(r.campaign).toMatchObject({ state: 'paused', configuredStatus: 'PAUSED', spendCap: 350, lastJob: { message: said, fixUrl: fix } });
    const entry = await lastAudit('launch', 'done');
    expect(entry.summary).toMatch(new RegExp(`: done\\. ${escapeRe(said)}$`));
    expect(entry.fixUrl).toBe(fix);
    expect(JSON.stringify([r, await auditList()])).not.toMatch(/zernio-hint|META-OWN-WORDS/);
  });

  it('budget_too_low passes on Meta’s own words (its minimum), labelled and as plain text; never Zernio’s hint', async () => {
    t.zm.ads.fail('POST /ads/create', '422-budget-too-low');
    const r = await t.launchPlan(u, 'meta');
    expect(r.job).toMatchObject({ state: 'failed', code: 'BUDGET_TOO_LOW', message: `${messageFor('BUDGET_TOO_LOW', { platform: 'meta' })} Nothing was created and no money was spent.`, platformSays: 'Your budget is too low: SECRET-PLATFORM-TEXT' });
    expect((await lastAudit('launch', 'failed')).summary).toContain('Meta’s message: “Your budget is too low: SECRET-PLATFORM-TEXT”');
  });

  it('a 429 on our own Zernio key stays team-level: “try again in a minute”, none of Zernio’s words, no link, no alert', async () => {
    t.zm.ads.fail('POST /ads/create', '429-key');
    const r = await t.launchPlan(u, 'meta');
    expect(r.job).toMatchObject({ state: 'failed', code: 'RATE_LIMITED', message: messageFor('RATE_LIMITED', { platform: 'meta' }) });
    expect(r.job).not.toHaveProperty('platformSays');
    expect(r.job).not.toHaveProperty('fixUrl');
    expect((await t.jobRow(r.job.id)).error_detail).toEqual({ status: 429, owner: true });
    expect(await lastAudit('launch', 'failed')).not.toHaveProperty('fixUrl');
    const all = JSON.stringify([r, (await t.call(u, 'GET', '/api/ads/campaigns?projectId=proj-1')).body, await auditList(), await t.audit(u.id)]);
    expect(all).not.toMatch(/SECRET-TEAM-TEXT|retryAfterSeconds|Zernio/i);
    expect(t.storage.documents.get('zernio:alert')).toBeUndefined();
    expect(writePaths()).toEqual(['POST /ads/create']);
  });
});
