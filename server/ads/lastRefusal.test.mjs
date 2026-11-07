// A refusal Zernio remembers (GET /v1/ads/accounts/health, check `last_refusal`): the last refusal Meta gave a create
// for a reason only the owner can fix (a payment method, the non-discrimination policy, a disabled account, a security
// check, a temporary block) stays until a later create succeeds or for 7 days, even once it's fixed, and only a create
// clears it. The setup checklist (preview.mjs setupChecks) warns about it instead of blocking while the live checks for
// its cause pass, so a launch goes ahead (one create; Meta checks again). A live problem, a blocker without a check, a
// missing billingStatus or a temporary block still block. Against the mock Zernio's custom health answer only
// (state.health), with the launch window's own checklist and summary rendered from the server's answers.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startAds } from './test-helpers.mjs';
import { SetupChecklist, checklistSummary } from '../../src/pages/marketing/ads/campaigns/SetupChecklist.tsx';

const BILLING = 'https://business.facebook.com/billing_hub/payment_settings';
/** each refusal's fix link as Zernio sends it (a Zernio dashboard path is never passed on) */
const FIX = {
  ad_account_payment_required: BILLING,
  ad_account_policy_not_accepted: 'https://business.facebook.com/settings/ad-accounts',
  ad_account_unusable: 'https://www.facebook.com/business/help/422289316306981',
  meta_security_check_required: '/dashboard/zernio-only',
};
/** what the customer reads for each remembered refusal */
const SAYS = {
  ad_account_payment_required: 'Meta refused the last launch on this ad account because of its payment method. If you’ve added or fixed it since, you can launch again: Meta checks it when you launch.',
  ad_account_policy_not_accepted: 'Meta refused the last launch on this ad account because its non-discrimination policy hadn’t been accepted. If a business admin has accepted it since, you can launch again: Meta checks it when you launch.',
  ad_account_unusable: 'Meta refused the last launch on this ad account because the account was disabled or restricted. If Meta has lifted that since, you can launch again: Meta checks it when you launch.',
  meta_security_check_required: 'Meta refused the last launch from the Facebook login connected here because of a security check. If you’ve done the check on facebook.com since, you can launch again: Meta checks it when you launch.',
};

let t;
let u;
beforeEach(async () => {
  t = await startAds();
  u = await t.user('owner@acme.test');
  await t.project(u);
  await t.plan(u);
  await t.connect(u, 'meta_ads');
  await t.choose(u, 'meta'); // act_1
});
afterEach(async () => {
  expect(t.violations()).toEqual([]);
  await t.close();
});

/** act_1 as Zernio's ad account list shows it */
const listing = (patch) => Object.assign(t.zm.ads.state.adAccounts.meta.find((a) => a.id === 'act_1'), patch);
const fix = (code) => (FIX[code] ? { fix: { label: 'Fix it', url: FIX[code] } } : {});
const blocker = (check, code) => ({ ...(check ? { check } : {}), code, message: 'SECRET-PLATFORM-TEXT', hint: 'SECRET-HINT', ...fix(code) });

/** Zernio's health answer for act_1: not ready because of the remembered refusal (and `blockers`); the live checks as given */
function health({ remembered = ['ad_account_payment_required'], payment = 'unknown', accountStatus = 'ok', blockers = [] } = {}) {
  t.zm.ads.state.health.act_1 = {
    status: 'blocked',
    ready: false,
    blockers: [...remembered.map((code) => blocker('last_refusal', code)), ...blockers],
    checks: [
      { id: 'account_status', status: accountStatus, title: 'Account status', message: 'SECRET-PLATFORM-TEXT' },
      { id: 'payment', status: payment, title: 'Payment method', message: 'SECRET-PLATFORM-TEXT', ...(['missing', 'error'].includes(payment) ? { code: 'ad_account_payment_required', ...fix('ad_account_payment_required') } : {}) },
      { id: 'page', status: 'ok', title: 'Facebook Page', message: 'x' },
      { id: 'instagram', status: 'ok', title: 'Instagram', message: 'x' },
      { id: 'spend_cap', status: 'ok', title: 'Spending limit', message: 'x' },
      { id: 'last_refusal', status: remembered.length ? 'error' : 'ok', title: 'Last refusal', message: 'SECRET-PLATFORM-TEXT', ...(remembered.length ? { code: remembered[0], ...fix(remembered[0]) } : {}) },
    ],
  };
}

const setup = async () => (await t.call(u, 'GET', '/api/ads/accounts?projectId=proj-1&platform=meta')).body.setup;
const red = (list) => list.filter((c) => c.state === 'missing');
const warnFor = (code, ourCode) => ({ id: 'last_refusal', state: 'warn', code: ourCode, message: SAYS[code], ...(code === 'meta_security_check_required' ? {} : { fixUrl: FIX[code] }) });
const creates = () => t.writes().filter((w) => w.method === 'POST' && w.path === '/api/v1/ads/create');

/** The review is blocked with `code`, has no token and says none of the remembered-refusal warnings; nothing was sent. */
async function reviewBlocked(code) {
  const pv = await t.preview(u, await t.request(u));
  expect(pv.status).toBe(200);
  expect(pv.body.reviewToken).toBeUndefined();
  expect(pv.body.review.blockers.map((b) => b.code)).toContain(code);
  expect(pv.body.review.warnings.filter((w) => Object.values(SAYS).includes(w.message))).toEqual([]);
  expect(t.writes()).toEqual([]);
}

describe('a remembered refusal the live checks don’t confirm: a warning, and the launch goes ahead', () => {
  it('(a) payment, with the payment method out of sight (Business Billing Hub): one warning, no red line; the review isn’t blocked and the launch sends one create', async () => {
    listing({ billingStatus: 'unknown' });
    health({ payment: 'unknown' });
    const s = await setup();
    expect(red(s)).toEqual([]);
    expect(s.find((c) => c.id === 'payment')).toMatchObject({ state: 'unknown', code: 'PAYMENT_UNKNOWN' });
    expect(s.filter((c) => c.id === 'last_refusal')).toEqual([warnFor('ad_account_payment_required', 'PAYMENT_REQUIRED')]);
    expect(checklistSummary(s)).toEqual({ tone: 'warn', text: 'Ready, 2 to check' });

    const r = await t.launchPlan(u, 'meta', { status: 'PAUSED' });
    expect(r.preview.body.review.blockers).toEqual([]);
    expect(creates()).toHaveLength(1);
    expect(r.job).toMatchObject({ state: 'done' });
    expect(await t.db.select('ad_jobs', { user_id: u.id })).toHaveLength(1);
    // Zernio's and Meta's own words never reach the customer
    expect(JSON.stringify([s, r])).not.toMatch(/SECRET/);
  });

  it('(a) the launch window’s checklist shows the warning with its fix link, and no red line', async () => {
    listing({ billingStatus: 'unknown' });
    health({ payment: 'unknown' });
    const list = renderToStaticMarkup(createElement(SetupChecklist, { checks: await setup() }));
    expect(list).toContain(SAYS.ad_account_payment_required);
    expect(list).toContain(`href="${BILLING}"`);
    expect(list).not.toContain('Add a payment method');
  });

  it('(a) if Meta refuses the payment method again, the job fails PAYMENT_REQUIRED after one create and nothing is sent again', async () => {
    listing({ billingStatus: 'unknown' });
    health({ payment: 'unknown' });
    t.zm.ads.fail('POST /ads/create', '403-payment');
    const r = await t.launchPlan(u, 'meta', { status: 'PAUSED' });
    expect(r.job).toMatchObject({ state: 'failed', code: 'PAYMENT_REQUIRED' });
    expect(t.writes().map((w) => `${w.method} ${w.path}`)).toEqual(['POST /api/v1/ads/create']);
    // reading the job, the campaigns and the checklist later sends nothing
    t.clock.t += 30 * 60_000;
    await t.call(u, 'GET', `/api/ads/jobs/${r.job.id}`);
    await t.call(u, 'GET', '/api/ads/campaigns?projectId=proj-1');
    await setup();
    await t.settled();
    expect(t.writes()).toHaveLength(1);
  });

  it('(b) payment, with the payment method on the account: the ok line and one warning, no red line', async () => {
    health({ payment: 'ok' });
    const s = await setup();
    expect(red(s)).toEqual([]);
    expect(s.find((c) => c.id === 'payment')).toEqual({ id: 'payment', state: 'ok', message: 'A payment method is on the ad account.' });
    expect(s.filter((c) => c.state !== 'ok')).toEqual([warnFor('ad_account_payment_required', 'PAYMENT_REQUIRED')]);
    expect(checklistSummary(s)).toEqual({ tone: 'warn', text: 'Ready, 1 to check' });
    const pv = await t.preview(u, await t.request(u));
    expect(pv.body.review.blockers).toEqual([]);
    expect(pv.body.reviewToken).toEqual(expect.any(String));
  });

  it.each([
    ['ad_account_policy_not_accepted', 'POLICY_NOT_ACCEPTED'],
    ['meta_security_check_required', 'SECURITY_CHECK'],
    ['ad_account_unusable', 'ACTION_BLOCKED'],
  ])('(g) %s: one warning (our code %s), and the review isn’t blocked', async (remembered, code) => {
    health({ remembered: [remembered], payment: 'ok' });
    const s = await setup();
    expect(red(s)).toEqual([]);
    expect(s.filter((c) => c.id === 'last_refusal')).toEqual([warnFor(remembered, code)]);
    const pv = await t.preview(u, await t.request(u));
    expect(pv.body.review.blockers).toEqual([]);
    expect(pv.body.reviewToken).toEqual(expect.any(String));
  });

  it('(g) a security check remembered for the connection and a payment refusal for the ad account: one warning each', async () => {
    health({ remembered: ['meta_security_check_required', 'ad_account_payment_required'], payment: 'unknown' });
    const s = await setup();
    expect(red(s)).toEqual([]);
    expect(s.filter((c) => c.id === 'last_refusal')).toEqual([warnFor('meta_security_check_required', 'SECURITY_CHECK'), warnFor('ad_account_payment_required', 'PAYMENT_REQUIRED')]);
  });
});

describe('still blocks, as before', () => {
  it.each(['missing', 'error'])('(c) the live payment check is %s: one red payment line, no warning', async (payment) => {
    health({ payment });
    const s = await setup();
    expect(red(s)).toEqual([{ id: 'payment', state: 'missing', code: 'PAYMENT_REQUIRED', message: expect.stringMatching(/^Add a payment method/), fixUrl: BILLING }]);
    expect(s.some((c) => c.id === 'last_refusal')).toBe(false);
    await reviewBlocked('PAYMENT_REQUIRED');
  });

  it('(d) the ad account list says the payment method is missing (billingStatus), even with the live check ok', async () => {
    listing({ accountStatus: 3, billingStatus: 'missing' });
    health({ payment: 'ok' });
    const s = await setup();
    expect(red(s)).toEqual([expect.objectContaining({ id: 'payment', state: 'missing', code: 'PAYMENT_REQUIRED' })]);
    expect(s.some((c) => c.id === 'last_refusal' || (c.id === 'payment' && c.state === 'ok'))).toBe(false);
    await reviewBlocked('PAYMENT_REQUIRED');
  });

  it.each(['unknown', 'ok'])('(e) a blocker without a check, the live payment check %s: one red payment line in place of the live one', async (payment) => {
    health({ remembered: [], payment, blockers: [blocker(null, 'ad_account_payment_required')] });
    const s = await setup();
    expect(red(s)).toEqual([{ id: 'payment', state: 'missing', code: 'PAYMENT_REQUIRED', message: expect.stringMatching(/^Add a payment method/), fixUrl: BILLING }]);
    expect(s.filter((c) => c.id === 'payment')).toHaveLength(1);
    expect(s.some((c) => c.id === 'last_refusal')).toBe(false);
    await reviewBlocked('PAYMENT_REQUIRED');
  });

  it('(f) a remembered temporary block (meta_action_blocked, kept a day)', async () => {
    health({ remembered: ['meta_action_blocked'], payment: 'ok' });
    const s = await setup();
    expect(red(s)).toEqual([{ id: 'ready', state: 'missing', code: 'ACTION_BLOCKED', message: expect.any(String) }]);
    expect(s.some((c) => c.id === 'last_refusal')).toBe(false);
    await reviewBlocked('ACTION_BLOCKED');
  });

  it('(h) a remembered payment refusal and a live account status problem: the live reason, never a red payment line next to the green one', async () => {
    health({ payment: 'ok', accountStatus: 'error', blockers: [blocker('account_status', 'ad_account_unusable')] });
    const s = await setup();
    expect(red(s)).toEqual([{ id: 'ready', state: 'missing', code: 'ACTION_BLOCKED', message: expect.any(String), fixUrl: FIX.ad_account_unusable }]);
    expect(s.find((c) => c.id === 'payment')).toMatchObject({ state: 'ok' });
    expect(s.some((c) => c.id === 'last_refusal')).toBe(false);
    await reviewBlocked('ACTION_BLOCKED');
  });

  it('a remembered disabled account that Meta still lists as disabled', async () => {
    listing({ accountStatus: 2 });
    health({ remembered: ['ad_account_unusable'], payment: 'ok' });
    const s = await setup();
    expect(red(s).map((c) => c.code)).toEqual(['ACCOUNT_DISABLED', 'ACTION_BLOCKED']);
    expect(s.some((c) => c.id === 'last_refusal')).toBe(false);
    await reviewBlocked('ACCOUNT_DISABLED');
  });

  it('a red line of our own (the ad account list) and only a remembered refusal from Zernio: the red line, never “you can launch again” next to it', async () => {
    listing({ accountStatus: 7 });
    health({ remembered: ['ad_account_policy_not_accepted'], payment: 'ok' });
    const s = await setup();
    expect(red(s).map((c) => c.code)).toEqual(['ACCOUNT_RISK_REVIEW']);
    expect(s.some((c) => c.id === 'last_refusal')).toBe(false);
    await reviewBlocked('ACCOUNT_RISK_REVIEW');
  });
});
