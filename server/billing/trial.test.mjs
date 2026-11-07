// P1c against mock Stripe and mock Supabase only: the 7-day card trial (offered once per person, the card taken in
// Checkout, the trial's own AI allowance counted from setup's spend that day, a second trial on the same card or email
// cancelled at once with nothing charged, one DELETE, never resent; the trial's hashes kept after an account is
// deleted; a card that couldn't be read checked again), no extra businesses during a trial, what is locked before a
// plan, the cancel survey (cancel at period end with Stripe's cancellation_details, or now after a failed payment; the
// answer kept once the cancel went through; the alternative taken instead; resume), the Customer Portal's survey read
// from the subscription, the portal standing in before the migration, and the owner's totals.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { billingServer, TAG_SECRET } from './test-helpers.mjs';

const DAY = 86_400_000;
let h;
const crid = () => crypto.randomUUID();
const subWrites = () => h.writes().filter((c) => c.route === 'POST /v1/subscriptions/:id' || c.route === 'DELETE /v1/subscriptions/:id');
const writesTo = (subId) => subWrites().filter((w) => w.path === `/v1/subscriptions/${subId}`);
const trials = () => h.supa.tables.get('billing_trials') ?? [];
const trialOf = (subId) => trials().find((t) => t.subscription_id === subId);
const surveys = () => h.supa.tables.get('cancel_surveys') ?? [];
const stripeSub = (id) => h.stripe.realm('').subscriptions.get(id);

async function trialServer(opts = {}) {
  h = await billingServer(opts);
  h.supa.tables.set('billing_settings', [{ id: 1, enforce: true, enforced_at: new Date().toISOString(), card_trial_days: 7, existing_trial_days: 30 }]);
  h.plans.store.invalidate();
  return h;
}

/** Checkout and finish it on the mock with a card (its fingerprint). → { sub, session } */
async function startTrial(who, { tier = 'grow', interval = 'month', card, extraBusinesses } = {}) {
  const co = await h.call(who, 'POST', '/api/billing/checkout', { tier, interval, clientRequestId: crid(), ...(extraBusinesses !== undefined ? { extraBusinesses } : {}) });
  if (co.status !== 200) throw new Error(`checkout ${co.status} ${co.text}`);
  const id = co.body.url.split('/__pay/')[1];
  const done = await (await fetch(`${h.stripe.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id, ...(card ? { card } : {}) }) })).json();
  return { sub: done.subscription, session: h.stripe.realm('').sessions.get(id) };
}

const stripeHook = (path, body) => fetch(`${h.stripe.base}${path}`, { method: 'POST', body: JSON.stringify(body) });

afterEach(async () => {
  await h?.close();
  h = null;
});

describe('the 7-day card trial', () => {
  beforeEach(() => trialServer());

  it('a new sign-up is offered it; Checkout takes a card (one trial per person and card, said on Stripe’s page) and starts trialing (no charge), with the trial’s own AI allowance', async () => {
    const u = await h.user('new@trial.test');
    const plan = await h.call(u, 'GET', '/api/billing/plan');
    expect(plan.body.trial).toEqual({ days: 7, eligible: true });
    expect(plan.body.billing).toMatchObject({ cancelInApp: true });
    // what /api/config tells a visitor who isn't signed in yet
    expect(await h.plans.refreshConfig()).toEqual({ enabled: true, enforce: true, trialDays: 7 });
    expect(plan.body.plan).toMatchObject({ plan: 'none', active: false, paused: 'plan', starter: true });
    const { sub, session } = await startTrial(u, { tier: 'scale', card: 'fp_card_new' });
    expect(session.subscription_data).toMatchObject({ trial_period_days: 7, trial_settings: { end_behavior: { missing_payment_method: 'cancel' } } });
    expect(session.subscription_data.metadata.ylb_email_hash).toMatch(/^[0-9a-f]{64}$/);
    // a card (its fingerprint tells a second trial apart; Link has none), and the rule next to the pay button
    expect(session).toMatchObject({ payment_method_collection: 'always', payment_method_types: ['card'] });
    expect(session.custom_text.submit.message).toBe('One free trial per person and card. If this card or email had one before, the trial doesn’t start and nothing is charged.');
    expect(sub.status).toBe('trialing');
    // nothing was charged: the first invoice is $0
    expect(h.stripe.realm('').invoices.get(sub.latest_invoice).amount_due).toBe(0);
    h.plans.forget(u.id);
    const ent = await h.plans.entitlement(u.id);
    expect(ent).toMatchObject({ plan: 'scale', active: true, trial: true, trialDaysLeft: 7, banner: 'trial', creditsPerMonth: 300, features: { adsLaunch: true } });
    const after = await h.call(u, 'GET', '/api/billing/plan');
    expect(after.body.trial.eligible).toBe(false);
    expect(after.body.account).toMatchObject({ status: 'trialing', trialing: true });
    expect(after.body.account.trialRefused).toBeUndefined();
    // recorded once, with keyed hashes only (never the card's fingerprint or the address)
    expect(trials()).toHaveLength(1);
    expect(trials()[0]).toMatchObject({ subscription_id: sub.id, user_id: u.id, outcome: 'trialing', tier: 'scale', ai_baseline_usd: 0 });
    expect(trials()[0].card_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(trials())).not.toContain('fp_card_new');
    expect(JSON.stringify(trials())).not.toContain('new@trial.test');
    // no write to the subscription was needed
    expect(subWrites()).toHaveLength(0);
  });

  it('ends with Stripe’s first charge on day 8; then the tier’s own credits', async () => {
    const u = await h.user('day8@trial.test');
    const { sub } = await startTrial(u, { tier: 'launch' });
    // the last 3 days say "ending soon"
    h.advance(5 * DAY);
    h.plans.forget(u.id);
    expect(await h.plans.entitlement(u.id)).toMatchObject({ banner: 'trial_ending', trialDaysLeft: 2 });
    await stripeHook('/__subscriptions/renew', { id: sub.id });
    h.plans.forget(u.id);
    expect(h.account(u).status).toBe('active');
    expect(await h.plans.entitlement(u.id)).toMatchObject({ trial: false, creditsPerMonth: 1500, banner: null });
  });

  it('only once per person: not after a trial, a plan that ended, or a free plan; and a repeat Checkout says why the plan starts today', async () => {
    const u = await h.user('once@trial.test');
    await startTrial(u);
    await stripeHook('/__subscriptions/status', { id: h.account(u).stripe_subscription_id, status: 'canceled' });
    expect(h.account(u).status).toBe('canceled');
    expect((await h.call(u, 'GET', '/api/billing/plan')).body.trial.eligible).toBe(false);
    const co = await h.call(u, 'POST', '/api/billing/checkout', { tier: 'grow', interval: 'month', clientRequestId: crid() });
    expect(co.status).toBe(200);
    const last = [...h.stripe.realm('').sessions.values()].at(-1);
    expect(last.subscription_data.trial_period_days).toBe(null);
    expect(last.custom_text.submit.message).toBe('This plan starts today: free trials are for first plans only.');
    // a free plan the owner gave: no trial either
    const c = await h.user('comp@trial.test');
    await h.plans.store.apply(c.id, { customer_tag: `cust_${'c'.repeat(24)}`, source: 'comp', tier: 'grow', status: 'active', business_limit: 1 }, null);
    expect((await h.call(c, 'GET', '/api/billing/plan')).body.trial.eligible).toBe(false);
    // the owner: never
    const o = await h.user('owner@trial.test', { admin: true });
    expect((await h.call(o, 'GET', '/api/billing/plan')).body.trial).toEqual({ days: 0, eligible: false });
  });

  it('a second trial on a card already used (another account) is cancelled at once, nothing charged: one DELETE, Idempotency-Key, never resent; the app says so', async () => {
    const a = await h.user('first@trial.test');
    await startTrial(a, { card: 'fp_shared_card' });
    const b = await h.user('second@trial.test');
    const { sub } = await startTrial(b, { card: 'fp_shared_card' });
    const writes = writesTo(sub.id);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'DELETE', idempotencyKey: `ylb-trial-cancel-${sub.id}` });
    // cancelled without a final invoice or proration: no charge, ever (never trial_end=now)
    expect(new URLSearchParams(writes[0].query)).toEqual(new URLSearchParams('invoice_now=false&prorate=false'));
    expect(stripeSub(sub.id).status).toBe('canceled');
    const invoices = [...h.stripe.realm('').invoices.values()].filter((i) => i.subscription === sub.id);
    expect(invoices.every((i) => i.amount_paid === 0)).toBe(true);
    expect(h.account(b).status).toBe('canceled');
    expect(trialOf(sub.id).outcome).toBe('ended_early');
    expect(h.logs.join('\n')).toContain('billing_alert_trial_duplicate');
    // the app tells them (and offers the plan without a trial: Stripe's page says it starts today)
    const plan = await h.call(b, 'GET', '/api/billing/plan');
    expect(plan.body.account).toMatchObject({ status: 'canceled', trialRefused: 'refused' });
    expect(plan.body.trial.eligible).toBe(false);
    const co = await h.call(b, 'POST', '/api/billing/checkout', { tier: 'grow', interval: 'month', clientRequestId: crid() });
    expect(co.status).toBe(200);
    const paid = [...h.stripe.realm('').sessions.values()].at(-1);
    expect(paid.subscription_data.trial_period_days).toBe(null);
    expect(paid.custom_text.submit.message).toBe('This plan starts today: free trials are for first plans only.');
    // the webhooks again, a reconcile: nothing more is sent
    await h.plans.reconcile({});
    expect(writesTo(sub.id)).toHaveLength(1);
    // the first person's trial is untouched
    expect(h.account(a).status).toBe('trialing');
  });

  it('Stripe refuses that cancel: recorded, the owner alerted, never retried (the trial runs on, as Checkout said)', async () => {
    const a = await h.user('first2@trial.test');
    await startTrial(a, { card: 'fp_refused' });
    const b = await h.user('second2@trial.test');
    h.stripe.fail('DELETE /v1/subscriptions/:id', 'rate_limit', 1);
    const { sub } = await startTrial(b, { card: 'fp_refused' });
    expect(trialOf(sub.id).outcome).toBe('end_failed');
    expect(h.logs.join('\n')).toContain('billing_alert_trial_end_failed');
    await h.plans.reconcile({});
    expect(writesTo(sub.id)).toHaveLength(1);
    expect(stripeSub(sub.id).status).toBe('trialing');
    expect((await h.call(b, 'GET', '/api/billing/plan')).body.account.trialRefused).toBeUndefined();
  });

  it('an unclear answer to that cancel is read back, never resent', async () => {
    const a = await h.user('first3@trial.test');
    await startTrial(a, { card: 'fp_unclear' });
    const b = await h.user('second3@trial.test');
    // the cancel goes through, then the connection drops
    h.stripe.fail('DELETE /v1/subscriptions/:id', 'timeout', 1);
    const { sub } = await startTrial(b, { card: 'fp_unclear' });
    expect(stripeSub(sub.id).status).toBe('canceled');
    expect(h.supa.tables.get('billing_ops').find((o) => o.kind === 'end_trial' && o.user_id === b.id).state).toBe('unknown');
    // a minute later the plan read reads it back: done, nothing sent again
    h.advance(61_000);
    const plan = await h.call(b, 'GET', '/api/billing/plan');
    expect(h.supa.tables.get('billing_ops').find((o) => o.kind === 'end_trial' && o.user_id === b.id).state).toBe('done');
    expect(trialOf(sub.id).outcome).toBe('ended_early');
    expect(plan.body.account.trialRefused).toBe('refused');
    expect(writesTo(sub.id)).toHaveLength(1);
  });

  it('deleting the account keeps the trial’s hashes: the same email gets no second trial, and the same card on another email is cancelled at once', async () => {
    const a = await h.user('leaver@trial.test');
    const { sub } = await startTrial(a, { card: 'fp_leaver' });
    await h.plans.forgetUser(a.id);
    expect(stripeSub(sub.id).status).toBe('canceled');
    const del = await fetch(`${h.supa.url}/auth/v1/admin/users/${a.id}`, { method: 'DELETE', headers: { apikey: h.supa.SECRET } });
    expect(del.status).toBe(200);
    // on delete set null: the row stays, without the user
    expect(trialOf(sub.id)).toMatchObject({ user_id: null, outcome: 'trialing' });
    expect(trialOf(sub.id).email_hash).toMatch(/^[0-9a-f]{64}$/);
    // signs up again with the same email: no trial
    const again = await h.user('leaver@trial.test');
    expect(again.id).not.toBe(a.id);
    expect((await h.call(again, 'GET', '/api/billing/plan')).body.trial.eligible).toBe(false);
    // another email, the same card: the trial is cancelled at once
    const other = await h.user('newemail@trial.test');
    const second = await startTrial(other, { card: 'fp_leaver' });
    expect(stripeSub(second.sub.id).status).toBe('canceled');
    expect(trialOf(second.sub.id).outcome).toBe('ended_early');
  });

  it('a card that couldn’t be read (no PaymentMethods permission): the owner is alerted, it is read again while the trial runs, and a later trial on it is cancelled', async () => {
    const a = await h.user('unread@trial.test');
    // refused on both of the Checkout's syncs (checkout.session.completed, customer.subscription.created)
    h.stripe.fail('GET /v1/payment_methods/:id', 'permission', 2);
    const first = await startTrial(a, { card: 'fp_unread' });
    expect(trialOf(first.sub.id)).toMatchObject({ outcome: 'trialing', card_hash: null });
    expect(h.logs.join('\n')).toMatch(/billing_alert_trial_card_unread.*no_permission/);
    // another account, the same card (read this time): nothing to compare it with yet
    const b = await h.user('later@trial.test');
    const second = await startTrial(b, { card: 'fp_unread' });
    expect(trialOf(second.sub.id).outcome).toBe('trialing');
    // the daily reconcile reads the first card again: the later trial on it is the second one, and is cancelled
    await h.plans.reconcile({});
    await h.plans.reconcile({});
    expect(trialOf(first.sub.id).card_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(trialOf(first.sub.id).outcome).toBe('trialing');
    expect(stripeSub(first.sub.id).status).toBe('trialing');
    expect(stripeSub(second.sub.id).status).toBe('canceled');
    expect(trialOf(second.sub.id).outcome).toBe('ended_early');
    expect(writesTo(second.sub.id)).toHaveLength(1);
  });

  it('the trial’s 300 credits: what setup spent earlier that day isn’t counted', async () => {
    // midday UTC, so the trial starts on the same UTC day as setup's spend
    const t = h.clock();
    const d = new Date(t);
    h.advance(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12) + (d.getUTCHours() >= 12 ? DAY : 0) - t);
    const u = await h.user('baseline@trial.test');
    const day = new Date(h.clock()).toISOString().slice(0, 10);
    h.supa.tables.set('ai_usage_daily', [{ user_id: u.id, day, email: '', requests: 9, usd: 1.8, own_requests: 0, own_usd: 0 }]);
    const { sub } = await startTrial(u);
    expect(trialOf(sub.id).ai_baseline_usd).toBe(1.8);
    h.plans.forget(u.id);
    const ent = await h.plans.entitlement(u.id);
    expect(ent.creditWindow).toMatchObject({ start: expect.stringContaining(day), baselineUsd: 1.8 });
    let plan = await h.call(u, 'GET', '/api/billing/plan');
    expect(plan.body.credits).toMatchObject({ monthly: 300, usedCredits: 0 });
    // the trial's own use counts
    h.supa.tables.get('ai_usage_daily')[0].usd = 2.3;
    plan = await h.call(u, 'GET', '/api/billing/plan');
    expect(plan.body.credits.usedCredits).toBe(50);
  });

  it('the trial covers one business: a Checkout with extra businesses starts paid, and Add a business waits for the trial to end', async () => {
    const u = await h.user('extras@trial.test');
    const co = await h.call(u, 'POST', '/api/billing/checkout', { tier: 'grow', interval: 'month', extraBusinesses: 2, clientRequestId: crid() });
    expect(co.status).toBe(200);
    const s = [...h.stripe.realm('').sessions.values()].at(-1);
    expect(s.subscription_data.trial_period_days).toBe(null);
    expect(s.custom_text.submit.message).toBe('This plan starts today: the free trial covers one business.');
    expect(s.line_items_input).toHaveLength(2);
    // a trial running: no business is added (Stripe would bill it $0 until day 8)
    const v = await h.user('trialadd@trial.test');
    const { sub } = await startTrial(v);
    const before = h.writes().length;
    const add = await h.call(v, 'POST', '/api/billing/businesses', { action: 'add', clientRequestId: crid(), confirm: true });
    expect(add.status).toBe(409);
    expect(add.body).toMatchObject({ code: 'NOT_ALLOWED_ON_PLAN' });
    expect(add.body.error).toMatch(/^Extra businesses start after your free trial, which ends on [A-Z][a-z]+ \d{1,2}\. Add one then\.$/);
    expect(h.writes().length).toBe(before);
    expect(stripeSub(sub.id).status).toBe('trialing');
  });

  it('the email hash is keyed with CUSTOMER_TAG_SECRET (the same address matches, another secret doesn’t)', async () => {
    const u = await h.user('hash@trial.test');
    const { session } = await startTrial(u);
    const want = crypto.createHmac('sha256', TAG_SECRET).update('ylb-trial:email:hash@trial.test').digest('hex');
    expect(session.subscription_data.metadata.ylb_email_hash).toBe(want);
    expect(trials()[0].email_hash).toBe(want);
  });
});

describe('before a plan', () => {
  beforeEach(() => trialServer());

  it('the first business is free (setup), paid actions answer PLAN_REQUIRED, and a second business needs a plan', async () => {
    const u = await h.user('locked@trial.test');
    expect(await h.claim(u, 'biz1')).toMatchObject({ ok: true, starter: true });
    for (const feature of ['publish', 'posting', 'connect', 'analytics', 'ads']) {
      await expect(h.plans.requireActive({ id: u.id }, feature)).rejects.toMatchObject({ status: 402, code: 'PLAN_REQUIRED', extra: { upgrade: '#plans' } });
    }
    expect(await h.claim(u, 'biz2')).toEqual({ ok: false, reason: 'plan_required' });
    // a trial unlocks them
    await startTrial(u);
    h.plans.forget(u.id);
    await expect(h.plans.requireActive({ id: u.id }, 'publish')).resolves.toMatchObject({ active: true, trial: true });
  });

  it('setup’s allowance counts from the start, even after a Checkout that was abandoned made the billing row', async () => {
    const u = await h.user('abandon@trial.test');
    const co = await h.call(u, 'POST', '/api/billing/checkout', { tier: 'grow', interval: 'month', clientRequestId: crid() });
    expect(co.status).toBe(200);
    expect(h.account(u)).toBeTruthy();
    h.plans.forget(u.id);
    expect((await h.plans.entitlement(u.id)).creditWindow).toEqual({ start: '2020-01-01T00:00:00.000Z', resetsAt: null });
  });
});

describe('the cancel survey', () => {
  beforeEach(() => trialServer());

  it('needs a reason; cancels at the period’s end with Stripe’s cancellation_details, once per press; keeps the answer once it went through', async () => {
    const u = await h.user('cancel@trial.test');
    const { sub } = await startTrial(u, { tier: 'grow' });
    expect((await h.call(u, 'POST', '/api/billing/cancel', { clientRequestId: crid(), confirm: true })).status).toBe(400);
    expect((await h.call(u, 'POST', '/api/billing/cancel', { reason: 'bored', clientRequestId: crid(), confirm: true })).status).toBe(400);
    expect((await h.call(u, 'POST', '/api/billing/cancel', { reason: 'too_expensive', clientRequestId: crid() })).status).toBe(400);
    const id = crid();
    const r = await h.call(u, 'POST', '/api/billing/cancel', { reason: 'too_expensive', comment: 'Too much for now\u0007', offer: 'cheaper_plan', clientRequestId: id, confirm: true });
    expect(r.status).toBe(200);
    const s = stripeSub(sub.id);
    expect(s).toMatchObject({ cancel_at_period_end: true, status: 'trialing', cancellation_details: { feedback: 'too_expensive', comment: 'Too much for now' } });
    const writes = writesTo(sub.id);
    expect(writes).toHaveLength(1);
    expect(writes[0].idempotencyKey).toBe(`ylb-cancel-${u.id}-${id}`);
    // the same press again: nothing new is sent, no second answer kept
    expect((await h.call(u, 'POST', '/api/billing/cancel', { reason: 'too_expensive', clientRequestId: id, confirm: true })).status).toBe(200);
    expect(writesTo(sub.id)).toHaveLength(1);
    expect(surveys().filter((x) => x.source === 'app')).toHaveLength(1);
    expect(surveys()[0]).toMatchObject({ user_id: u.id, source: 'app', reason: 'too_expensive', offer: 'cheaper_plan', outcome: 'cancelled', tier: 'grow', subscription_id: sub.id });
    // the app's own cancel isn't counted again as a portal answer (its webhook came while the cancel was on its way)
    await h.plans.reconcile({});
    expect(surveys().filter((x) => x.source === 'portal')).toHaveLength(0);
    h.plans.forget(u.id);
    expect(await h.plans.entitlement(u.id)).toMatchObject({ active: true, banner: 'cancel_at_period_end', trial: true });
    // changed their mind: keep the plan
    const back = await h.call(u, 'POST', '/api/billing/resume', { clientRequestId: crid(), confirm: true });
    expect(back.status).toBe(200);
    expect(stripeSub(sub.id).cancel_at_period_end).toBe(false);
    expect(h.account(u).cancel_at_period_end).toBe(false);
  });

  it('a cancel Stripe refuses keeps no answer; the next press is a new request, and its answer is kept once', async () => {
    const u = await h.user('refused@trial.test');
    const { sub } = await startTrial(u);
    h.stripe.fail('POST /v1/subscriptions/:id', 'rate_limit', 1);
    const first = await h.call(u, 'POST', '/api/billing/cancel', { reason: 'not_using', clientRequestId: crid(), confirm: true });
    expect(first.status).toBe(503);
    expect(surveys()).toHaveLength(0);
    expect(stripeSub(sub.id).cancel_at_period_end).toBe(false);
    const second = await h.call(u, 'POST', '/api/billing/cancel', { reason: 'not_using', clientRequestId: crid(), confirm: true });
    expect(second.status).toBe(200);
    expect(surveys()).toHaveLength(1);
    expect(surveys()[0]).toMatchObject({ source: 'app', reason: 'not_using', outcome: 'cancelled' });
  });

  it('an unclear answer: the cancel is read back, and its answer kept once then', async () => {
    const u = await h.user('unclear@trial.test');
    await startTrial(u);
    // done in Stripe, then the connection drops
    h.stripe.fail('POST /v1/subscriptions/:id', 'timeout', 1);
    const id = crid();
    const r = await h.call(u, 'POST', '/api/billing/cancel', { reason: 'results', clientRequestId: id, confirm: true });
    // read back at once: there
    expect(r.status).toBe(200);
    expect(surveys().filter((x) => x.source === 'app')).toHaveLength(1);
    expect((await h.call(u, 'POST', '/api/billing/cancel', { reason: 'results', clientRequestId: id, confirm: true })).status).toBe(200);
    expect(surveys()).toHaveLength(1);
  });

  it('a change that was read back and isn’t there answers NOT_APPLIED (the app’s next press is a new request)', async () => {
    const u = await h.user('notapplied@trial.test');
    const { sub } = await startTrial(u);
    // Stripe answers 500 and did nothing: unclear, read back, still not there after 10 minutes
    h.stripe.fail('POST /v1/subscriptions/:id', 'server', 1);
    const id = crid();
    expect((await h.call(u, 'POST', '/api/billing/cancel', { reason: 'other', clientRequestId: id, confirm: true })).status).toBe(202);
    h.advance(11 * 60_000);
    await h.call(u, 'GET', '/api/billing/plan');
    const again = await h.call(u, 'POST', '/api/billing/cancel', { reason: 'other', clientRequestId: id, confirm: true });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'NOT_APPLIED', op: { state: 'not_applied' } });
    expect(surveys()).toHaveLength(0);
    const fresh = await h.call(u, 'POST', '/api/billing/cancel', { reason: 'other', clientRequestId: crid(), confirm: true });
    expect(fresh.status).toBe(200);
    expect(stripeSub(sub.id).cancel_at_period_end).toBe(true);
    expect(surveys()).toHaveLength(1);
  });

  it('after a payment failed: Cancel ends the plan now (no final invoice, Stripe stops trying the card); Keep my plan still works', async () => {
    const u = await h.user('pastdue@trial.test');
    const { sub } = await startTrial(u);
    await stripeHook('/__subscriptions/renew', { id: sub.id });
    await stripeHook('/__invoices/fail', { subscription: sub.id });
    expect(h.account(u).status).toBe('past_due');
    const id = crid();
    const r = await h.call(u, 'POST', '/api/billing/cancel', { reason: 'too_expensive', comment: 'Card expired anyway', clientRequestId: id, confirm: true });
    expect(r.status).toBe(200);
    const writes = writesTo(sub.id);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'DELETE', idempotencyKey: `ylb-cancel-${u.id}-${id}` });
    const q = new URLSearchParams(writes[0].query);
    expect(q.get('invoice_now')).toBe('false');
    expect(q.get('prorate')).toBe('false');
    expect(stripeSub(sub.id)).toMatchObject({ status: 'canceled', cancellation_details: { feedback: 'too_expensive', comment: 'Card expired anyway' } });
    expect(h.account(u).status).toBe('canceled');
    expect(surveys().filter((x) => x.source === 'app')).toHaveLength(1);
    expect(surveys().filter((x) => x.source === 'portal')).toHaveLength(0);
    // Keep my plan while a payment is being retried (nothing is charged by it)
    const v = await h.user('keep@trial.test');
    const second = await startTrial(v);
    await stripeHook('/__subscriptions/renew', { id: second.sub.id });
    expect((await h.call(v, 'POST', '/api/billing/cancel', { reason: 'not_using', clientRequestId: crid(), confirm: true })).status).toBe(200);
    await stripeHook('/__invoices/fail', { subscription: second.sub.id });
    const keep = await h.call(v, 'POST', '/api/billing/resume', { clientRequestId: crid(), confirm: true });
    expect(keep.status).toBe(200);
    expect(stripeSub(second.sub.id)).toMatchObject({ status: 'past_due', cancel_at_period_end: false });
    // any other change still waits for the card
    expect((await h.call(v, 'POST', '/api/billing/plan', { tier: 'scale', interval: 'month', clientRequestId: crid(), confirm: true })).body).toMatchObject({ code: 'PAYMENT_REQUIRED' });
  });

  it('the alternative taken instead is kept as an answer and changes nothing in Stripe', async () => {
    const u = await h.user('kept@trial.test');
    await startTrial(u);
    const before = h.writes().length;
    const r = await h.call(u, 'POST', '/api/billing/cancel/survey', { reason: 'missing_feature', comment: 'Needs Etsy', offer: 'tell_feature', outcome: 'kept' });
    expect(r.status).toBe(200);
    expect(h.writes().length).toBe(before);
    expect(surveys()[0]).toMatchObject({ reason: 'missing_feature', comment: 'Needs Etsy', outcome: 'kept', source: 'app' });
  });

  it('a cancel made in the Customer Portal: its survey answer is read from the subscription, once (no ON CONFLICT on the partial index)', async () => {
    const u = await h.user('portal@trial.test');
    const { sub } = await startTrial(u);
    const cancel = { id: sub.id, cancel_at_period_end: true, cancellation_details: { feedback: 'too_complex', comment: 'Hard to set up', reason: 'cancellation_requested' } };
    await stripeHook('/__subscriptions/status', cancel);
    await stripeHook('/__subscriptions/status', cancel);
    await h.plans.reconcile({});
    const portal = surveys().filter((x) => x.source === 'portal');
    expect(portal).toHaveLength(1);
    expect(portal[0]).toMatchObject({ reason: 'too_hard', comment: 'Hard to set up', outcome: 'cancelled', subscription_id: sub.id });
    // as Postgres answers it: a partial unique index can't be named in ON CONFLICT (42P10)
    await expect(h.db.insert('cancel_surveys', { id: crypto.randomUUID(), user_id: u.id, source: 'portal', reason: 'other', outcome: 'cancelled', subscription_id: sub.id }, { ignoreDuplicates: true, onConflict: 'subscription_id' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // a second portal row is refused by the index (23505)
    await expect(h.db.insert('cancel_surveys', { id: crypto.randomUUID(), user_id: u.id, source: 'portal', reason: 'other', outcome: 'cancelled', subscription_id: sub.id })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a portal cancel after the app’s own cancel was undone (Keep my plan) is the portal’s answer', async () => {
    const u = await h.user('both@trial.test');
    const { sub } = await startTrial(u);
    expect((await h.call(u, 'POST', '/api/billing/cancel', { reason: 'not_using', clientRequestId: crid(), confirm: true })).status).toBe(200);
    expect((await h.call(u, 'POST', '/api/billing/resume', { clientRequestId: crid(), confirm: true })).status).toBe(200);
    await stripeHook('/__subscriptions/status', { id: sub.id, cancel_at_period_end: true, cancellation_details: { feedback: 'switched_service', comment: 'Moved', reason: 'cancellation_requested' } });
    expect(surveys().map((x) => [x.source, x.reason]).sort()).toEqual([['app', 'not_using'], ['portal', 'switching']]);
  });

  it('the owner sees totals by reason (every answer), the comments and the trials; nobody else does', async () => {
    const u = await h.user('one@trial.test');
    await startTrial(u);
    await h.call(u, 'POST', '/api/billing/cancel', { reason: 'not_using', comment: 'No time', clientRequestId: crid(), confirm: true });
    const v = await h.user('two@trial.test');
    await startTrial(v);
    await h.call(v, 'POST', '/api/billing/cancel/survey', { reason: 'too_expensive', offer: 'cheaper_plan', outcome: 'switched' });
    expect((await h.call(u, 'GET', '/api/billing/surveys')).status).toBe(403);
    const o = await h.user('boss@trial.test', { admin: true });
    let r = await h.call(o, 'GET', '/api/billing/surveys');
    expect(r.status).toBe(200);
    expect(r.body.counts.not_using).toEqual({ cancelled: 1, kept: 0 });
    expect(r.body.counts.too_expensive).toEqual({ cancelled: 0, kept: 1 });
    expect(r.body.total).toBe(2);
    expect(r.body.recent.map((x) => x.comment)).toContain('No time');
    expect(r.body.trials).toMatchObject({ trialing: 2, duplicates: 0 });
    expect(r.body.trials.list[0]).toMatchObject({ outcome: 'trialing' });
    expect(JSON.stringify(r.body)).not.toMatch(/sub_|cus_|fp_/);
    // more answers than the list shows: the totals still count every one
    for (let i = 0; i < 60; i++) h.supa.tables.get('cancel_surveys').push({ id: crypto.randomUUID(), user_id: u.id, source: 'app', reason: 'other', outcome: 'cancelled', created_at: new Date(Date.now() - i * 1000).toISOString() });
    r = await h.call(o, 'GET', '/api/billing/surveys?limit=10');
    expect(r.body.total).toBe(62);
    expect(r.body.counts.other).toEqual({ cancelled: 60, kept: 0 });
    expect(r.body.recent.length).toBeLessThanOrEqual(10);
    expect(r.body.partial).toBeUndefined();
    // the accounts list shows when each trial ends
    const accts = await h.call(o, 'GET', '/api/billing/accounts');
    expect(accts.body.accounts.find((a) => a.status === 'trialing').trialEndsAt).toBeTruthy();
  });
});

describe('before the P1c migration is run', () => {
  beforeEach(() => trialServer({ missingTables: ['billing_trials', 'cancel_surveys'] }));

  it('no trial is offered, and Cancel and Keep my plan go to the Customer Portal (nothing is sent to Stripe)', async () => {
    const u = await h.user('premigration@trial.test');
    const plan = await h.call(u, 'GET', '/api/billing/plan');
    expect(plan.body.trial).toEqual({ days: 7, eligible: false });
    expect(plan.body.billing.cancelInApp).toBe(false);
    const sub = await h.subscribe(u);
    expect(sub.status).toBe('active');
    const before = h.writes().length;
    const r = await h.call(u, 'POST', '/api/billing/cancel', { reason: 'other', clientRequestId: crid(), confirm: true });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'USE_PORTAL', portal: true });
    expect((await h.call(u, 'POST', '/api/billing/resume', { clientRequestId: crid(), confirm: true })).body).toMatchObject({ code: 'USE_PORTAL' });
    expect(h.writes().length).toBe(before);
    // the portal itself still opens
    expect((await h.call(u, 'POST', '/api/billing/portal', { clientRequestId: crid() })).status).toBe(200);
  });
});
