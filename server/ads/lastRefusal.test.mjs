// A refusal Zernio remembers (GET /v1/ads/accounts/health, check `last_refusal`): the last refusal Meta gave a create
// for a reason only the owner can fix (a payment method, the non-discrimination policy, a disabled account, a security
// check, a temporary block) stays until a later create succeeds or for 7 days, even once it's fixed, and only a create
// clears it. The setup checklist (preview.mjs setupChecks) warns about it instead of blocking while the live checks for
// its cause pass, so a launch goes ahead (one create; Meta checks again). A live problem (any blocker not from
// last_refusal, a failing account status check), a blocker without a check, billingStatus `missing`, a temporary block
// or a code we don't know still block, with the red line in place of the line it's about. Against the mock Zernio's
// custom health answer only (state.health), with the launch window's own checklist, summary and review rendered from
// the server's answers.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startAds } from './test-helpers.mjs';
import { SetupChecklist, checklistSummary } from '../../src/pages/marketing/ads/campaigns/SetupChecklist.tsx';
import { ReviewStep } from '../../src/pages/marketing/ads/launch/ReviewStep.tsx';

const BILLING = 'https://business.facebook.com/billing_hub/payment_settings';
/** each refusal's fix link as Zernio sends it (a Zernio dashboard path is never passed on) */
const FIX = {
  ad_account_payment_required: BILLING,
  ad_account_policy_not_accepted: 'https://www.facebook.com/certification/nondiscrimination',
  ad_account_unusable: 'https://www.facebook.com/business/help/422289316306981',
  meta_security_check_required: '/dashboard/zernio-only',
};
/**
 * the fix link the customer is shown: ours for a payment method (act_1's own payment settings) and the policy
 * (Business Settings → Users → System users, where a business admin accepts it), whatever Zernio sent; else Zernio's
 */
const PAYMENT_SETTINGS = 'https://business.facebook.com/billing_hub/payment_settings/?asset_id=1';
const POLICY_ADMIN = 'https://business.facebook.com/latest/settings/system_users';
const SHOWN = { ...FIX, ad_account_payment_required: PAYMENT_SETTINGS, ad_account_policy_not_accepted: POLICY_ADMIN };
/** the fix link Zernio's account status check carries when it fails (not the same as a remembered refusal's) */
const ACCOUNT_QUALITY = 'https://business.facebook.com/accountquality';
/** what the customer reads for each remembered refusal (never "the last launch": a later refusal of another kind doesn't clear it) */
const SAYS = {
  ad_account_payment_required: 'Meta refused a launch on this ad account in the last 7 days because of its payment method. If you’ve added or fixed it since, you can launch again: Meta checks it when you launch.',
  ad_account_policy_not_accepted: 'Meta refused a launch on this ad account in the last 7 days because its non-discrimination policy hadn’t been accepted. If a business admin has accepted it since, you can launch again: Meta checks it when you launch.',
  ad_account_unusable: 'Meta refused a launch on this ad account in the last 7 days because the account was disabled or restricted. If Meta has lifted that since, you can launch again: Meta checks it when you launch.',
  meta_security_check_required: 'Meta refused a launch from the Facebook login connected here in the last 7 days because of a security check. If you’ve done the check on facebook.com since, you can launch again: Meta checks it when you launch.',
};
/** the payment line next to a remembered payment refusal (never "that’s fine" beside it) */
const PAYMENT_UNSEEN = 'We can’t see this ad account’s payment method from here.';

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
      { id: 'account_status', status: accountStatus, title: 'Account status', message: 'SECRET-PLATFORM-TEXT', ...(['missing', 'error'].includes(accountStatus) ? { code: 'ad_account_unusable', fix: { label: 'Account quality', url: ACCOUNT_QUALITY } } : {}) },
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
const lineOf = (list, id) => list.find((c) => c.id === id);
/** the red line Meta's "not letting this ad account create ads" takes: in place of the account line, never next to a green one */
const accountBlocked = (extra = {}) => ({ id: 'account', state: 'missing', code: 'ACTION_BLOCKED', message: 'Meta isn’t letting this ad account create ads right now. Open Ads Manager to see why.', ...extra });
const warnFor = (code, ourCode) => ({ id: 'last_refusal', state: 'warn', code: ourCode, message: SAYS[code], ...(code === 'meta_security_check_required' ? {} : { fixUrl: SHOWN[code] }) });
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
    // the payment line is neutral next to Meta's payment refusal: nothing says "that's fine"
    expect(s.find((c) => c.id === 'payment')).toEqual({ id: 'payment', state: 'unknown', code: 'PAYMENT_UNKNOWN', message: PAYMENT_UNSEEN });
    expect(JSON.stringify(s)).not.toMatch(/that’s fine/);
    expect(s.filter((c) => c.id === 'last_refusal')).toEqual([warnFor('ad_account_payment_required', 'PAYMENT_REQUIRED')]);
    expect(checklistSummary(s)).toEqual({ tone: 'warn', text: 'Ready, 2 to check' });

    const r = await t.launchPlan(u, 'meta', { status: 'PAUSED' });
    expect(r.preview.body.review.blockers).toEqual([]);
    expect(r.preview.body.review.warnings).toContainEqual({ code: 'PAYMENT_REQUIRED', message: SAYS.ad_account_payment_required, fixUrl: PAYMENT_SETTINGS });
    expect(creates()).toHaveLength(1);
    expect(r.job).toMatchObject({ state: 'done' });
    expect(await t.db.select('ad_jobs', { user_id: u.id })).toHaveLength(1);
    // Zernio's and Meta's own words never reach the customer
    expect(JSON.stringify([s, r])).not.toMatch(/SECRET/);
  });

  it('(a) the launch window shows the warning on its checklist and in the review, before the confirm', async () => {
    listing({ billingStatus: 'unknown' });
    health({ payment: 'unknown' });
    const list = renderToStaticMarkup(createElement(SetupChecklist, { checks: await setup() }));
    expect(list).toContain(SAYS.ad_account_payment_required);
    expect(list).toContain(`href="${PAYMENT_SETTINGS}"`);
    expect(list).toContain(PAYMENT_UNSEEN);
    expect(list).not.toContain('Add a payment method');
    expect(list).not.toContain('that’s fine');
    const pv = await t.preview(u, await t.request(u));
    expect(pv.body.reviewToken).toEqual(expect.any(String));
    const html = renderToStaticMarkup(createElement(ReviewStep, { review: pv.body.review, error: null, stale: false, confirmed: [], onClaims: () => {} }));
    expect(html).toContain('Good to know');
    expect(html).toContain(SAYS.ad_account_payment_required);
    expect(html).not.toContain('Fix these first');
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
    const { id, state, ...note } = warnFor(remembered, code);
    expect(pv.body.review.warnings).toContainEqual(note);
  });

  it('(g) a security check remembered for the connection and a payment refusal for the ad account: one warning each', async () => {
    health({ remembered: ['meta_security_check_required', 'ad_account_payment_required'], payment: 'unknown' });
    const s = await setup();
    expect(red(s)).toEqual([]);
    expect(s.filter((c) => c.id === 'last_refusal')).toEqual([warnFor('meta_security_check_required', 'SECURITY_CHECK'), warnFor('ad_account_payment_required', 'PAYMENT_REQUIRED')]);
    expect(lineOf(s, 'payment').message).toBe(PAYMENT_UNSEEN);
  });

  it('(g) a security check only, with the payment method out of sight: the payment line keeps its usual words', async () => {
    listing({ billingStatus: 'unknown' });
    health({ remembered: ['meta_security_check_required'], payment: 'unknown' });
    const s = await setup();
    expect(red(s)).toEqual([]);
    expect(s.filter((c) => c.id === 'last_refusal')).toEqual([warnFor('meta_security_check_required', 'SECURITY_CHECK')]);
    expect(lineOf(s, 'payment')).toMatchObject({ state: 'unknown', code: 'PAYMENT_UNKNOWN', message: expect.stringMatching(/Business Billing Hub/) });
  });
});

describe('still blocks, as before', () => {
  it.each(['missing', 'error'])('(c) the live payment check is %s: one red payment line, no warning', async (payment) => {
    health({ payment });
    const s = await setup();
    expect(red(s)).toEqual([{ id: 'payment', state: 'missing', code: 'PAYMENT_REQUIRED', message: expect.stringMatching(/^Add a payment method/), fixUrl: PAYMENT_SETTINGS }]);
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
    expect(red(s)).toEqual([{ id: 'payment', state: 'missing', code: 'PAYMENT_REQUIRED', message: expect.stringMatching(/^Add a payment method/), fixUrl: PAYMENT_SETTINGS }]);
    expect(s.filter((c) => c.id === 'payment')).toHaveLength(1);
    expect(s.some((c) => c.id === 'last_refusal')).toBe(false);
    await reviewBlocked('PAYMENT_REQUIRED');
  });

  it('(f) a remembered temporary block (meta_action_blocked, kept a day): one red line in place of the account line', async () => {
    health({ remembered: ['meta_action_blocked'], payment: 'ok' });
    const s = await setup();
    expect(red(s)).toEqual([accountBlocked()]);
    expect(s.filter((c) => c.id === 'account')).toHaveLength(1);
    expect(s.some((c) => c.id === 'last_refusal')).toBe(false);
    await reviewBlocked('ACTION_BLOCKED');
  });

  it('(h) a remembered payment refusal and a live account status problem: the live reason in place of the account line, the payment line stays green', async () => {
    health({ payment: 'ok', accountStatus: 'error', blockers: [blocker('account_status', 'ad_account_unusable')] });
    const s = await setup();
    expect(red(s)).toEqual([accountBlocked({ fixUrl: FIX.ad_account_unusable })]);
    // never "The ad account is active." next to it
    expect(s.filter((c) => c.id === 'account')).toHaveLength(1);
    expect(lineOf(s, 'payment')).toMatchObject({ state: 'ok' });
    expect(s.some((c) => c.id === 'last_refusal')).toBe(false);
    await reviewBlocked('ACTION_BLOCKED');
  });

  it.each([
    ['ad_account_payment_required', 'error'],
    ['ad_account_policy_not_accepted', 'error'],
    ['meta_security_check_required', 'error'],
    ['ad_account_unusable', 'error'],
    ['ad_account_payment_required', 'missing'],
  ])('(h) remembered %s while the account status check is %s with no blocker of its own (the ad account list says active): blocks with the account reason and its link', async (remembered, accountStatus) => {
    listing({ billingStatus: 'unknown' });
    health({ remembered: [remembered], payment: 'unknown', accountStatus });
    const s = await setup();
    expect(red(s)).toEqual([accountBlocked({ fixUrl: ACCOUNT_QUALITY })]);
    expect(s.filter((c) => c.id === 'account')).toHaveLength(1);
    expect(lineOf(s, 'payment')).toMatchObject({ state: 'unknown' });
    expect(s.some((c) => c.id === 'last_refusal')).toBe(false);
    await reviewBlocked('ACTION_BLOCKED');
  });

  it('a live account status blocker with a code we’d downgrade if remembered (policy), its own check ok: blocks', async () => {
    health({ remembered: [], payment: 'ok', blockers: [blocker('account_status', 'ad_account_policy_not_accepted')] });
    const s = await setup();
    expect(red(s)).toEqual([{ id: 'account', state: 'missing', code: 'POLICY_NOT_ACCEPTED', message: 'A business admin needs to accept Meta’s non-discrimination policy: in Meta Business Settings → Users → System users, click “Review policy” (or “Add”), then “I accept”.', fixUrl: POLICY_ADMIN }]);
    expect(s.some((c) => c.id === 'last_refusal')).toBe(false);
    await reviewBlocked('POLICY_NOT_ACCEPTED');
  });

  it('a live payment blocker while the payment check reads unknown, next to a remembered payment refusal: one red payment line, no warning', async () => {
    listing({ billingStatus: 'unknown' });
    health({ payment: 'unknown', blockers: [blocker('payment', 'ad_account_payment_required')] });
    const s = await setup();
    expect(red(s)).toEqual([{ id: 'payment', state: 'missing', code: 'PAYMENT_REQUIRED', message: expect.stringMatching(/^Add a payment method/), fixUrl: PAYMENT_SETTINGS }]);
    expect(s.filter((c) => c.id === 'payment')).toHaveLength(1);
    expect(s.some((c) => c.id === 'last_refusal')).toBe(false);
    await reviewBlocked('PAYMENT_REQUIRED');
  });

  it('a remembered refusal with a code we don’t know: blocks as Meta not letting the ad account create ads', async () => {
    health({ remembered: ['some_new_code'], payment: 'ok' });
    const s = await setup();
    expect(red(s)).toEqual([accountBlocked()]);
    expect(s.some((c) => c.id === 'last_refusal')).toBe(false);
    await reviewBlocked('ACTION_BLOCKED');
  });

  it('Zernio says not ready but lists no blocker: blocks', async () => {
    health({ remembered: [], payment: 'ok' });
    const s = await setup();
    expect(red(s)).toEqual([accountBlocked()]);
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
