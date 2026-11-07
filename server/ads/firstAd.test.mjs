// "Before your first ad" (GET /api/ads/accounts → firstAd, PUT /api/ads/accounts/policy): for the chosen Meta ad
// account, a payment method (Zernio's live payment check and the listing's billingStatus), Meta's non-discrimination
// policy (the customer's own answer, kept per ad account; Meta has no check for it before a create) and a Facebook
// Page. An unanswered policy is a warning, never a block; a policy refusal Zernio remembers (last_refusal) or reports
// makes it "not done". Against the mock Zernio only; ticking the box writes our database and nothing else.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startAds } from './test-helpers.mjs';
import { FIRST_AD, policySteps } from './preview.mjs';
import { safeFixUrl } from './messages.mjs';
import { createDb, DbError } from '../integrations/db.mjs';
import { BeforeFirstAd } from '../../src/pages/marketing/ads/launch/BeforeFirstAd.tsx';
import { noAccountReason } from '../../src/components/ads/FirstAdPanel.tsx';

const POLICY_ADMIN = 'https://business.facebook.com/latest/settings/business_users';
const POLICY_PERSONAL = 'https://www.facebook.com/certification/nondiscrimination';
const paymentOf = (digits) => `https://business.facebook.com/billing_hub/payment_settings/?asset_id=${digits}`;

let t;
let u;
beforeEach(async () => {
  t = await startAds();
  u = await t.user('owner@acme.test');
  await t.project(u);
  await t.plan(u);
  await t.connect(u, 'meta_ads');
});
afterEach(async () => {
  expect(t.violations()).toEqual([]);
  await t.close();
});

const accounts = async (platform = 'meta') => (await t.call(u, 'GET', `/api/ads/accounts?projectId=proj-1&platform=${platform}`)).body;
const item = (fa, id) => fa.items.find((i) => i.id === id);
const confirm = (ref, confirmed, extra = {}) => t.call(u, 'PUT', '/api/ads/accounts/policy', { projectId: 'proj-1', platform: 'meta', adAccountRef: ref, confirmed, ...extra });
const choiceRow = async () => (await t.db.select('ad_account_choices', { user_id: u.id, project_id: 'proj-1', platform: 'meta' }, { limit: 1 }))[0];

/** Zernio's health answer for act_1 with a remembered refusal for each code (live checks as given) */
function remembered(codes, { payment = 'ok' } = {}) {
  t.zm.ads.state.health.act_1 = {
    status: 'blocked',
    ready: false,
    blockers: codes.map((code) => ({ check: 'last_refusal', code, message: 'SECRET-PLATFORM-TEXT', fix: { label: 'x', url: POLICY_PERSONAL } })),
    checks: [
      { id: 'account_status', status: 'ok', title: 'Account', message: 'x' },
      { id: 'payment', status: payment, title: 'Payment', message: 'x' },
      { id: 'page', status: 'ok', title: 'Page', message: 'x' },
      { id: 'instagram', status: 'ok', title: 'Instagram', message: 'x' },
      { id: 'spend_cap', status: 'ok', title: 'Spend cap', message: 'x' },
      { id: 'last_refusal', status: codes.length ? 'error' : 'ok', title: 'Last refusal', message: 'x', ...(codes.length ? { code: codes[0] } : {}) },
    ],
  };
}

describe('the checklist', () => {
  it('no ad account chosen yet: no firstAd (the account picker comes first)', async () => {
    const a = await accounts();
    expect(a.chosen).toBeUndefined();
    expect(a).not.toHaveProperty('firstAd');
  });

  it('act_1 (payment on it, a Page): payment done, policy not confirmed with the admin link, steps and the profile link, Page done; not ready', async () => {
    await t.choose(u, 'meta'); // act_1
    const { firstAd } = await accounts();
    expect(firstAd.adAccount).toEqual({ name: 'Acme Plumbing', idTail: '1' });
    expect(firstAd.items.map((i) => [i.id, i.status])).toEqual([
      ['payment', 'done'],
      ['policy', 'unconfirmed'],
      ['page', 'done'],
    ]);
    expect(item(firstAd, 'payment')).toEqual({ id: 'payment', status: 'done', message: FIRST_AD.PAYMENT_DONE });
    expect(item(firstAd, 'policy')).toEqual({ id: 'policy', status: 'unconfirmed', message: FIRST_AD.POLICY_UNCONFIRMED, fixUrl: POLICY_ADMIN, fixLabel: 'Open Business Settings', alsoUrl: POLICY_PERSONAL, alsoLabel: 'Your own acceptance on Facebook (only if Meta asks you)', steps: policySteps('1'), confirmed: false });
    // the steps say to check which business Meta opened (the link can't name it), with this ad account's tail
    expect(item(firstAd, 'policy').steps[1]).toBe('Open Meta Business Settings. Check the business name in the top-left menu is the one that owns ad account …1; switch to it if not.');
    expect(item(firstAd, 'policy').message).toMatch(/Only a business admin can accept it/);
    expect(firstAd.ready).toBe(false);
    // an unconfirmed policy never blocks: the setup checklist has no red line, and the review isn't blocked by it
    const prev = await t.preview(u, await t.request(u, 'meta'));
    expect(prev.status).toBe(200);
    expect(prev.body.review.blockers.map((b) => b.code)).not.toContain('POLICY_NOT_ACCEPTED');
    expect(prev.body.reviewToken).toEqual(expect.any(String));
  });

  it('act_2 (billingStatus missing): payment not done, linking that ad account’s own payment settings', async () => {
    await t.choose(u, 'meta', { tail: '2' });
    const { firstAd } = await accounts();
    expect(item(firstAd, 'payment')).toEqual({ id: 'payment', status: 'not_done', message: FIRST_AD.PAYMENT_NOT_DONE, fixUrl: paymentOf('2'), fixLabel: 'Open payment settings' });
    // the setup checklist's red payment line links the same page
    const { setup } = await accounts();
    expect(setup.find((c) => c.id === 'payment')).toMatchObject({ state: 'missing', code: 'PAYMENT_REQUIRED', fixUrl: paymentOf('2') });
  });

  it('a payment method Meta can’t show (payment check unknown): "can’t tell", with a link to check that account’s payment settings', async () => {
    await t.choose(u, 'meta');
    remembered([], { payment: 'unknown' });
    t.zm.ads.state.health.act_1.status = 'ok';
    t.zm.ads.state.health.act_1.ready = true;
    const { firstAd } = await accounts();
    expect(item(firstAd, 'payment')).toEqual({ id: 'payment', status: 'unknown', message: FIRST_AD.PAYMENT_UNKNOWN, fixUrl: paymentOf('1'), fixLabel: 'Check payment settings' });
  });

  it('the payment link is built from the ad account id (the owner’s test account)', async () => {
    t.zm.ads.state.adAccounts.meta.push({ id: 'act_1106745002143814', name: 'Owner test', currency: 'USD', accountStatus: 1, timezoneName: 'America/Chicago', minimumDailyBudget: 1, selectable: true, unusableReason: null, billingStatus: 'missing', selected: true });
    await t.choose(u, 'meta', { tail: '3814' });
    const { firstAd } = await accounts();
    expect(item(firstAd, 'payment').fixUrl).toBe('https://business.facebook.com/billing_hub/payment_settings/?asset_id=1106745002143814');
    for (const i of firstAd.items) for (const url of [i.fixUrl, i.alsoUrl].filter(Boolean)) expect(safeFixUrl(url), url).toBe(url);
  });

  it('Zernio’s payment check answering "error" (the listing doesn’t say missing): "can’t tell", never "no payment method"', async () => {
    await t.choose(u, 'meta');
    remembered([], { payment: 'error' });
    t.zm.ads.state.health.act_1.status = 'ok';
    t.zm.ads.state.health.act_1.ready = true;
    const { firstAd } = await accounts();
    expect(item(firstAd, 'payment')).toEqual({ id: 'payment', status: 'unknown', message: FIRST_AD.PAYMENT_UNKNOWN, fixUrl: paymentOf('1'), fixLabel: 'Check payment settings' });
  });

  it('Settings says why when there’s no ad account to pick (none listed, or none usable); nothing when one can be picked', async () => {
    expect(noAccountReason(await accounts())).toBeUndefined();
    for (const a of t.zm.ads.state.adAccounts.meta) a.accountStatus = 2; // disabled
    expect(noAccountReason(await accounts())).toBe('None of your Meta ad accounts can run ads right now. Open Meta Ads Manager to see why.');
    t.zm.ads.state.adAccounts.meta.length = 0;
    const none = await accounts();
    expect(noAccountReason(none)).toBe(none.setup[0].message);
    expect(none.setup[0].code).toBe('NO_AD_ACCOUNTS');
  });

  it('Google: no firstAd', async () => {
    await t.connect(u, 'google_ads');
    await t.choose(u, 'google');
    expect(await accounts('google')).not.toHaveProperty('firstAd');
  });
});

describe('the policy confirmation', () => {
  it('saved and shown: ticked → done ("you told us"), unticked → not confirmed; our database only', async () => {
    const a = await t.choose(u, 'meta');
    const before = t.writes().length;
    const on = await confirm(a.ref, true);
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ policyConfirmed: true });
    expect(await choiceRow()).toMatchObject({ ad_account_id: 'act_1', policy_confirmed_for: 'act_1', policy_confirmed_at: expect.any(String) });
    let { firstAd } = await accounts();
    expect(item(firstAd, 'policy')).toMatchObject({ status: 'done', message: FIRST_AD.POLICY_DONE, confirmed: true, fixUrl: POLICY_ADMIN });
    expect(firstAd.ready).toBe(true);
    const off = await confirm(a.ref, false);
    expect(off.body).toEqual({ policyConfirmed: false });
    expect(await choiceRow()).toMatchObject({ policy_confirmed_for: null, policy_confirmed_at: null });
    ({ firstAd } = await accounts());
    expect(item(firstAd, 'policy')).toMatchObject({ status: 'unconfirmed', confirmed: false });
    // nothing went to Zernio
    expect(t.writes(before)).toEqual([]);
  });

  it('is kept per ad account: another ad account starts unconfirmed, and the first keeps its answer', async () => {
    const one = await t.choose(u, 'meta');
    await confirm(one.ref, true);
    await t.choose(u, 'meta', { tail: '2' });
    expect(item((await accounts()).firstAd, 'policy')).toMatchObject({ status: 'unconfirmed', confirmed: false });
    await t.choose(u, 'meta', { tail: '1' });
    expect(item((await accounts()).firstAd, 'policy')).toMatchObject({ status: 'done', confirmed: true });
  });

  it('only for the business’s chosen Meta ad account, with a yes or no', async () => {
    const one = await t.choose(u, 'meta');
    const other = (await accounts()).accounts.find((x) => x.idTail === '2');
    expect((await confirm(other.ref, true)).body.code).toBe('ACCOUNT_CHANGED');
    expect((await confirm(one.ref, 'yes')).status).toBe(400);
    expect((await confirm('adacct_nope', true)).status).toBe(400);
    expect((await confirm(one.ref, true, { platform: 'google' })).status).toBe(400);
    expect((await confirm(one.ref, true, { projectId: 'proj-404' })).status).toBe(404);
    expect((await choiceRow()).policy_confirmed_for ?? null).toBeNull();
  });

  it('nothing chosen yet: refused (pick the ad account first)', async () => {
    const ref = (await accounts()).accounts[0].ref;
    const r = await confirm(ref, true);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ACCOUNT_CHANGED');
  });
});

describe('a remembered policy refusal', () => {
  it('marks the policy "not done", even when the box is ticked, with the admin link (not Zernio’s)', async () => {
    const a = await t.choose(u, 'meta');
    await confirm(a.ref, true);
    remembered(['ad_account_policy_not_accepted']);
    const { firstAd, setup } = await accounts();
    expect(item(firstAd, 'policy')).toMatchObject({ status: 'not_done', message: FIRST_AD.POLICY_REFUSED, fixUrl: POLICY_ADMIN, confirmed: true });
    expect(firstAd.ready).toBe(false);
    // the checklist's warning links where a business admin accepts it
    expect(setup.find((c) => c.id === 'last_refusal')).toMatchObject({ state: 'warn', code: 'POLICY_NOT_ACCEPTED', fixUrl: POLICY_ADMIN });
  });

  it('marks it "not done" even when a red line comes first (a live payment problem hides the warning)', async () => {
    await t.choose(u, 'meta');
    remembered(['ad_account_payment_required', 'ad_account_policy_not_accepted'], { payment: 'missing' });
    const { firstAd, setup } = await accounts();
    expect(setup.some((c) => c.id === 'last_refusal')).toBe(false);
    expect(item(firstAd, 'policy').status).toBe('not_done');
    expect(item(firstAd, 'payment')).toMatchObject({ status: 'not_done', fixUrl: paymentOf('1') });
  });
});

describe('a live policy blocker', () => {
  it('marks the policy "not done" in neutral words (never "refused in the last 7 days… you can launch again")', async () => {
    await t.choose(u, 'meta');
    remembered([]);
    const h = t.zm.ads.state.health.act_1;
    h.status = 'blocked';
    h.ready = false;
    h.blockers = [{ check: 'account_status', code: 'ad_account_policy_not_accepted', message: 'SECRET-PLATFORM-TEXT', fix: { label: 'x', url: POLICY_PERSONAL } }];
    const { firstAd, setup } = await accounts();
    expect(item(firstAd, 'policy')).toMatchObject({ status: 'not_done', message: FIRST_AD.POLICY_LIVE, fixUrl: POLICY_ADMIN });
    expect(item(firstAd, 'policy').message).not.toMatch(/7 days|launch again/);
    expect(setup.find((c) => c.code === 'POLICY_NOT_ACCEPTED')).toMatchObject({ state: 'missing', fixUrl: POLICY_ADMIN });
  });
});

describe('the answer can’t be saved', () => {
  async function failing(pg) {
    const a = await t.choose(u, 'meta');
    const orig = t.db.update;
    t.db.update = async (table, ...rest) => {
      if (table === 'ad_account_choices') throw new DbError(400, 'BAD_REQUEST', 'The database refused that value.', { pg });
      return orig(table, ...rest);
    };
    try {
      return await confirm(a.ref, true);
    } finally {
      t.db.update = orig;
    }
  }

  it('before the migration is run (no column): 503 with our words, no database text, and the log names the migration', async () => {
    const r = await failing('PGRST204');
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'UNAVAILABLE', error: 'Your answer couldn’t be saved just now. Try again later.' });
    expect(JSON.stringify(r.body)).not.toMatch(/database|PGRST|refused that value|migration/i);
    const line = t.lines.find((l) => l.includes('ads_policy_confirm_not_saved'));
    expect(JSON.parse(line)).toEqual({ event: 'ads_policy_confirm_not_saved', code: 'BAD_REQUEST', pg: 'PGRST204', hint: 'run supabase/migrations/20261116000000_ad_policy_confirmed.sql' });
    expect((await choiceRow()).policy_confirmed_for ?? null).toBeNull();
  });

  it('a check refusing the value: the same customer words, logged as itself (never blames a migration already run)', async () => {
    const r = await failing('23514');
    expect(r.status).toBe(503);
    const line = t.lines.find((l) => l.includes('ads_policy_confirm_not_saved'));
    expect(JSON.parse(line)).toEqual({ event: 'ads_policy_confirm_not_saved', code: 'BAD_REQUEST', pg: '23514' });
  });

  it('the database layer passes Postgres’s code along for the log (only a code, never the message)', async () => {
    const fake = async () => new Response(JSON.stringify({ code: 'PGRST204', message: 'Could not find the policy_confirmed_for column SECRET-ROW' }), { status: 400, headers: { 'content-type': 'application/json' } });
    const db = createDb({ supabaseUrl: 'https://db.test', secretKey: 'k', fetch: fake });
    const e = await db.update('ad_account_choices', { user_id: 'u' }, { policy_confirmed_for: 'act_1' }).catch((x) => x);
    expect(e).toMatchObject({ name: 'DbError', status: 400, code: 'BAD_REQUEST', pg: 'PGRST204' });
    expect(e.message).not.toContain('SECRET-ROW');
  });
});

describe('the app shows it', () => {
  const render = (props) => renderToStaticMarkup(createElement(BeforeFirstAd, { projectId: 'proj-1', adAccountRef: 'adacct_x', onChanged: () => {}, ...props }));

  it('lists each item with its state word, the links, the steps and the box', async () => {
    await t.choose(u, 'meta', { tail: '2' });
    const html = render({ firstAd: (await accounts()).firstAd });
    expect(html).toContain('Before your first ad');
    expect(html).toContain('Not done');
    expect(html).toContain('Not confirmed');
    expect(html).toContain(`href="${paymentOf('2')}"`);
    expect(html).toContain(`href="${POLICY_ADMIN}"`);
    expect(html).toContain(`href="${POLICY_PERSONAL}"`);
    expect(html).toContain('Only a business admin can accept');
    expect(html).toContain('Users, then System users');
    expect(html).toContain('Check the business name in the top-left menu is the one that owns ad account …2');
    expect(html).toContain('Your own acceptance on Facebook (only if Meta asks you)');
    expect(html).toMatch(/role="checkbox"[^>]*aria-checked="false"/);
    expect(html).toContain('A business admin has accepted Meta’s non-discrimination policy');
  });

  it('a remembered refusal reads "Not done" with the box ticked', async () => {
    const a = await t.choose(u, 'meta');
    await confirm(a.ref, true);
    remembered(['ad_account_policy_not_accepted']);
    const html = render({ firstAd: (await accounts()).firstAd });
    expect(html).toContain('Not done');
    expect(html).toContain(FIRST_AD.POLICY_REFUSED);
    expect(html).toMatch(/role="checkbox"[^>]*aria-checked="true"/);
  });
});
