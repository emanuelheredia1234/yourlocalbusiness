// P1c against mock Stripe and mock Supabase only: the 7-day card trial (offered once per person, the card taken in
// Checkout, the trial's own AI allowance, a second trial on the same card ended at once with one write), what is
// locked before a plan, the cancel survey (cancel at period end with Stripe's cancellation_details, the alternative
// taken instead, resume), the Customer Portal's survey read from the subscription, and the owner's view.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { billingServer, TAG_SECRET } from './test-helpers.mjs';

const DAY = 86_400_000;
let h;
const crid = () => crypto.randomUUID();
const subWrites = () => h.writes().filter((c) => c.route === 'POST /v1/subscriptions/:id');
const trials = () => h.supa.tables.get('billing_trials') ?? [];
const surveys = () => h.supa.tables.get('cancel_surveys') ?? [];

async function trialServer() {
  h = await billingServer();
  h.supa.tables.set('billing_settings', [{ id: 1, enforce: true, enforced_at: new Date().toISOString(), card_trial_days: 7, existing_trial_days: 30 }]);
  h.plans.store.invalidate();
  return h;
}

/** Checkout and finish it on the mock with a card (its fingerprint). → { sub, session } */
async function startTrial(who, { tier = 'grow', interval = 'month', card } = {}) {
  const co = await h.call(who, 'POST', '/api/billing/checkout', { tier, interval, clientRequestId: crid() });
  if (co.status !== 200) throw new Error(`checkout ${co.status} ${co.text}`);
  const id = co.body.url.split('/__pay/')[1];
  const done = await (await fetch(`${h.stripe.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id, ...(card ? { card } : {}) }) })).json();
  return { sub: done.subscription, session: h.stripe.realm('').sessions.get(id) };
}

afterEach(async () => {
  await h?.close();
  h = null;
});

describe('the 7-day card trial', () => {
  beforeEach(trialServer);

  it('a new sign-up is offered it; Checkout takes the card and starts trialing (no charge), with the trial’s own AI allowance', async () => {
    const u = await h.user('new@trial.test');
    const plan = await h.call(u, 'GET', '/api/billing/plan');
    expect(plan.body.trial).toEqual({ days: 7, eligible: true });
    expect(plan.body.plan).toMatchObject({ plan: 'none', active: false, paused: 'plan', starter: true });
    const { sub, session } = await startTrial(u, { tier: 'scale', card: 'fp_card_new' });
    expect(session.subscription_data).toMatchObject({ trial_period_days: 7, trial_settings: { end_behavior: { missing_payment_method: 'cancel' } } });
    expect(session.subscription_data.metadata.ylb_email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sub.status).toBe('trialing');
    // nothing was charged: the first invoice is $0
    expect(h.stripe.realm('').invoices.get(sub.latest_invoice).amount_due).toBe(0);
    h.plans.forget(u.id);
    const ent = await h.plans.entitlement(u.id);
    expect(ent).toMatchObject({ plan: 'scale', active: true, trial: true, trialDaysLeft: 7, banner: 'trial', creditsPerMonth: 300, features: { adsLaunch: true } });
    const after = await h.call(u, 'GET', '/api/billing/plan');
    expect(after.body.trial.eligible).toBe(false);
    expect(after.body.account).toMatchObject({ status: 'trialing', trialing: true });
    // recorded once, with keyed hashes only (never the card's fingerprint or the address)
    expect(trials()).toHaveLength(1);
    expect(trials()[0]).toMatchObject({ subscription_id: sub.id, user_id: u.id, outcome: 'trialing', tier: 'scale' });
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
    await fetch(`${h.stripe.base}/__subscriptions/renew`, { method: 'POST', body: JSON.stringify({ id: sub.id }) });
    h.plans.forget(u.id);
    expect(h.account(u).status).toBe('active');
    expect(await h.plans.entitlement(u.id)).toMatchObject({ trial: false, creditsPerMonth: 1500, banner: null });
  });

  it('only once per person: not after a trial, a plan that ended, or a free plan; and not on a repeat Checkout', async () => {
    const u = await h.user('once@trial.test');
    await startTrial(u);
    await fetch(`${h.stripe.base}/__subscriptions/status`, { method: 'POST', body: JSON.stringify({ id: h.account(u).stripe_subscription_id, status: 'canceled' }) });
    expect(h.account(u).status).toBe('canceled');
    expect((await h.call(u, 'GET', '/api/billing/plan')).body.trial.eligible).toBe(false);
    const co = await h.call(u, 'POST', '/api/billing/checkout', { tier: 'grow', interval: 'month', clientRequestId: crid() });
    expect(co.status).toBe(200);
    const last = [...h.stripe.realm('').sessions.values()].at(-1);
    expect(last.subscription_data.trial_period_days).toBe(null);
    // a free plan the owner gave: no trial either
    const c = await h.user('comp@trial.test');
    await h.plans.store.apply(c.id, { customer_tag: `cust_${'c'.repeat(24)}`, source: 'comp', tier: 'grow', status: 'active', business_limit: 1 }, null);
    expect((await h.call(c, 'GET', '/api/billing/plan')).body.trial.eligible).toBe(false);
    // the owner: never
    const o = await h.user('owner@trial.test', { admin: true });
    expect((await h.call(o, 'GET', '/api/billing/plan')).body.trial).toEqual({ days: 0, eligible: false });
  });

  it('a second trial on a card already used (another account) is ended at once: one write, Idempotency-Key, never resent', async () => {
    const a = await h.user('first@trial.test');
    await startTrial(a, { card: 'fp_shared_card' });
    const b = await h.user('second@trial.test');
    const { sub } = await startTrial(b, { card: 'fp_shared_card' });
    const ends = subWrites().filter((w) => w.path === `/v1/subscriptions/${sub.id}`);
    expect(ends).toHaveLength(1);
    expect(ends[0].idempotencyKey).toBe(`ylb-trial-end-${sub.id}`);
    expect(h.stripe.realm('').subscriptions.get(sub.id).status).toBe('active');
    expect(h.account(b).status).toBe('active');
    expect(trials().find((t) => t.subscription_id === sub.id).outcome).toBe('ended_early');
    expect(h.logs.join('\n')).toContain('billing_alert_trial_duplicate');
    // the webhooks again, a reconcile: nothing more is sent
    await h.plans.reconcile({});
    expect(subWrites().filter((w) => w.path === `/v1/subscriptions/${sub.id}`)).toHaveLength(1);
    // the first person's trial is untouched
    expect(h.account(a).status).toBe('trialing');
  });

  it('ending a duplicate trial that the card declines: recorded, the owner alerted, never retried', async () => {
    const a = await h.user('first2@trial.test');
    await startTrial(a, { card: 'fp_declines' });
    const b = await h.user('second2@trial.test');
    const co = await h.call(b, 'POST', '/api/billing/checkout', { tier: 'grow', interval: 'month', clientRequestId: crid() });
    const id = co.body.url.split('/__pay/')[1];
    h.stripe.decline(h.account(b).stripe_customer_id);
    const done = await (await fetch(`${h.stripe.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id, card: 'fp_declines' }) })).json();
    const sub = done.subscription;
    expect(trials().find((t) => t.subscription_id === sub.id).outcome).toBe('end_failed');
    expect(h.logs.join('\n')).toContain('billing_alert_trial_end_failed');
    await h.plans.reconcile({});
    expect(subWrites().filter((w) => w.path === `/v1/subscriptions/${sub.id}`)).toHaveLength(1);
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
  beforeEach(trialServer);

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
});

describe('the cancel survey', () => {
  beforeEach(trialServer);

  it('needs a reason; cancels at the period’s end with Stripe’s cancellation_details, once per press; keeps the answer', async () => {
    const u = await h.user('cancel@trial.test');
    const { sub } = await startTrial(u, { tier: 'grow' });
    expect((await h.call(u, 'POST', '/api/billing/cancel', { clientRequestId: crid(), confirm: true })).status).toBe(400);
    expect((await h.call(u, 'POST', '/api/billing/cancel', { reason: 'bored', clientRequestId: crid(), confirm: true })).status).toBe(400);
    expect((await h.call(u, 'POST', '/api/billing/cancel', { reason: 'too_expensive', clientRequestId: crid() })).status).toBe(400);
    const id = crid();
    const r = await h.call(u, 'POST', '/api/billing/cancel', { reason: 'too_expensive', comment: 'Too much for now\u0007', offer: 'cheaper_plan', clientRequestId: id, confirm: true });
    expect(r.status).toBe(200);
    const s = h.stripe.realm('').subscriptions.get(sub.id);
    expect(s).toMatchObject({ cancel_at_period_end: true, status: 'trialing', cancellation_details: { feedback: 'too_expensive', comment: 'Too much for now' } });
    const writes = subWrites().filter((w) => w.path === `/v1/subscriptions/${sub.id}`);
    expect(writes).toHaveLength(1);
    expect(writes[0].idempotencyKey).toBe(`ylb-cancel-${u.id}-${id}`);
    // the same press again: nothing new is sent, no second answer kept
    expect((await h.call(u, 'POST', '/api/billing/cancel', { reason: 'too_expensive', clientRequestId: id, confirm: true })).status).toBe(200);
    expect(subWrites().filter((w) => w.path === `/v1/subscriptions/${sub.id}`)).toHaveLength(1);
    expect(surveys().filter((x) => x.source === 'app')).toHaveLength(1);
    expect(surveys()[0]).toMatchObject({ user_id: u.id, source: 'app', reason: 'too_expensive', offer: 'cheaper_plan', outcome: 'cancelled', tier: 'grow', subscription_id: sub.id });
    // the app's own cancel isn't counted again as a portal answer
    expect(surveys().filter((x) => x.source === 'portal')).toHaveLength(0);
    h.plans.forget(u.id);
    expect(await h.plans.entitlement(u.id)).toMatchObject({ active: true, banner: 'cancel_at_period_end', trial: true });
    // changed their mind: keep the plan
    const back = await h.call(u, 'POST', '/api/billing/resume', { clientRequestId: crid(), confirm: true });
    expect(back.status).toBe(200);
    expect(h.stripe.realm('').subscriptions.get(sub.id).cancel_at_period_end).toBe(false);
    expect(h.account(u).cancel_at_period_end).toBe(false);
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

  it('a cancel made in the Customer Portal: its survey answer is read from the subscription, once', async () => {
    const u = await h.user('portal@trial.test');
    const { sub } = await startTrial(u);
    const cancel = { id: sub.id, cancel_at_period_end: true, cancellation_details: { feedback: 'too_complex', comment: 'Hard to set up', reason: 'cancellation_requested' } };
    await fetch(`${h.stripe.base}/__subscriptions/status`, { method: 'POST', body: JSON.stringify(cancel) });
    await fetch(`${h.stripe.base}/__subscriptions/status`, { method: 'POST', body: JSON.stringify(cancel) });
    await h.plans.reconcile({});
    const portal = surveys().filter((x) => x.source === 'portal');
    expect(portal).toHaveLength(1);
    expect(portal[0]).toMatchObject({ reason: 'too_hard', comment: 'Hard to set up', outcome: 'cancelled', subscription_id: sub.id });
  });

  it('the owner sees counts by reason, the comments and the trials; nobody else does', async () => {
    const u = await h.user('one@trial.test');
    await startTrial(u);
    await h.call(u, 'POST', '/api/billing/cancel', { reason: 'not_using', comment: 'No time', clientRequestId: crid(), confirm: true });
    const v = await h.user('two@trial.test');
    await startTrial(v);
    await h.call(v, 'POST', '/api/billing/cancel/survey', { reason: 'too_expensive', offer: 'cheaper_plan', outcome: 'switched' });
    expect((await h.call(u, 'GET', '/api/billing/surveys')).status).toBe(403);
    const o = await h.user('boss@trial.test', { admin: true });
    const r = await h.call(o, 'GET', '/api/billing/surveys');
    expect(r.status).toBe(200);
    expect(r.body.counts.not_using).toEqual({ cancelled: 1, kept: 0 });
    expect(r.body.counts.too_expensive).toEqual({ cancelled: 0, kept: 1 });
    expect(r.body.recent.map((x) => x.comment)).toContain('No time');
    expect(r.body.trials).toMatchObject({ trialing: 2, duplicates: 0 });
    expect(r.body.trials.list[0]).toMatchObject({ outcome: 'trialing' });
    expect(JSON.stringify(r.body)).not.toMatch(/sub_|cus_|fp_/);
    // the accounts list shows when each trial ends
    const accts = await h.call(o, 'GET', '/api/billing/accounts');
    expect(accts.body.accounts.find((a) => a.status === 'trialing').trialEndsAt).toBeTruthy();
  });
});
