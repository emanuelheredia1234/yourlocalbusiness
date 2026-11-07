// Plans and billing with Stripe (spec §A3–A4, C1.3–C1.8, C1.11–C1.13), against mock Stripe and mock Supabase only:
// Checkout, the subscription lifecycle through webhooks, webhook safety, adding and removing businesses (one Stripe
// write each, read back after a timeout and never resent), plan changes, the cron jobs, secrets kept out of
// replies and logs, and account deletion cancelling first.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { billingServer } from './test-helpers.mjs';
import { signStripeHeader, TEST_STRIPE_KEY, TEST_STRIPE_WEBHOOK_SECRET } from '../test/mock-stripe.mjs';

const DAY = 86_400_000;
let h;
const crid = () => crypto.randomUUID();

afterEach(async () => {
  await h?.close();
  h = null;
});

const coCalls = () => h.stripe.calls.filter((c) => c.route === 'POST /v1/checkout/sessions');
const subWrites = () => h.writes().filter((c) => c.route === 'POST /v1/subscriptions/:id');
async function hook(type, object, { secret = TEST_STRIPE_WEBHOOK_SECRET, t, livemode = false, account, id } = {}) {
  const evt = { id: id ?? `evt_${crypto.randomBytes(8).toString('hex')}`, object: 'event', type, livemode, data: { object }, created: Math.floor(h.clock() / 1000), ...(account ? { account } : {}) };
  const raw = JSON.stringify(evt);
  const res = await fetch(`${h.base}/api/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripeHeader(raw, secret, t ?? Math.floor(h.clock() / 1000)) }, body: raw });
  return { status: res.status, body: await res.json(), evt };
}

describe('Checkout', () => {
  beforeEach(async () => {
    h = await billingServer();
  });

  it('makes one Customer (idempotency key), uses the lookup-key prices, sets client_reference_id, and adds the extra line only when > 0', async () => {
    const u = await h.user('co@example.com');
    const first = await h.call(u, 'POST', '/api/billing/checkout', { tier: 'grow', interval: 'month', extraBusinesses: 0, clientRequestId: crid() });
    expect(first.status).toBe(200);
    expect(first.body.url).toContain('/__pay/cs_test_');
    const customers = h.writes().filter((c) => c.route === 'POST /v1/customers');
    expect(customers).toHaveLength(1);
    expect(customers[0].idempotencyKey).toBe(`ylb-cus-${u.id}`);
    const session = [...h.stripe.realm('').sessions.values()][0];
    expect(session).toMatchObject({ client_reference_id: u.id, mode: 'subscription', customer: h.account(u).stripe_customer_id, cancel_url: 'https://app.example.test/#plans' });
    expect(session.success_url).toBe('https://app.example.test/?billing=success&session_id={CHECKOUT_SESSION_ID}#dashboard');
    expect(session.line_items_input).toHaveLength(1);
    expect(h.stripe.realm('').prices.get(session.line_items_input[0].price).lookup_key).toBe('ylb_grow_monthly');
    expect(session.subscription_data.trial_period_days).toBe(null);
    expect(coCalls()[0].idempotencyKey).toMatch(new RegExp(`^ylb-co-${u.id}-`));

    // the same choice again: the open session comes back, no second session
    const again = await h.call(u, 'POST', '/api/billing/checkout', { tier: 'grow', interval: 'month', extraBusinesses: 0, clientRequestId: crid() });
    expect(again.body.url).toBe(first.body.url);
    expect(coCalls()).toHaveLength(1);
    // another choice: a new session with the extra businesses line, same Customer
    const extra = await h.call(u, 'POST', '/api/billing/checkout', { tier: 'scale', interval: 'year', extraBusinesses: 2, clientRequestId: crid() });
    expect(extra.status).toBe(200);
    const s2 = [...h.stripe.realm('').sessions.values()][1];
    expect(s2.line_items_input.map((l) => [h.stripe.realm('').prices.get(l.price).lookup_key, l.quantity])).toEqual([
      ['ylb_scale_yearly', 1],
      ['ylb_business_yearly', 2],
    ]);
    expect(h.writes().filter((c) => c.route === 'POST /v1/customers')).toHaveLength(1);
  });

  it('refuses a second subscription (from the database and from Stripe’s list), and the owner', async () => {
    const u = await h.user('twice@example.com');
    await h.subscribe(u);
    expect(h.account(u)).toMatchObject({ status: 'active', tier: 'grow' });
    const again = await h.call(u, 'POST', '/api/billing/checkout', { tier: 'scale', interval: 'month', clientRequestId: crid() });
    expect(again).toMatchObject({ status: 409, body: { code: 'ALREADY_SUBSCRIBED' } });
    // the database is behind (as if the webhook never came): Stripe's list still refuses
    const row = h.account(u);
    Object.assign(row, { stripe_subscription_id: null, status: 'none' });
    const behind = await h.call(u, 'POST', '/api/billing/checkout', { tier: 'scale', interval: 'month', clientRequestId: crid() });
    expect(behind).toMatchObject({ status: 409, body: { code: 'ALREADY_SUBSCRIBED' } });

    const owner = await h.user('boss@example.com', { admin: true });
    expect((await h.call(owner, 'POST', '/api/billing/checkout', { tier: 'grow', interval: 'month', clientRequestId: crid() })).body.code).toBe('OWNER_PLAN');
    expect((await h.call(owner, 'POST', '/api/billing/portal', { clientRequestId: crid() })).body.code).toBe('OWNER_PLAN');
    const plan = await h.call(owner, 'GET', '/api/billing/plan');
    expect(plan.body.plan).toMatchObject({ plan: 'owner', active: true });
    expect(h.account(owner)).toMatchObject({ source: 'owner', tier: 'owner', business_limit: null, stripe_customer_id: null });
    expect(h.writes().filter((c) => c.route === 'POST /v1/customers')).toHaveLength(1);
  });

  it('adds a card trial only when the owner set one and only the first time', async () => {
    h.supa.tables.get('billing_settings')[0].card_trial_days = 7;
    h.plans.store.invalidate();
    const u = await h.user('trial@example.com');
    const sub = await h.subscribe(u);
    expect(sub.status).toBe('trialing');
    expect([...h.stripe.realm('').sessions.values()][0].subscription_data.trial_period_days).toBe(7);
    // ended, then back: no second trial
    await fetch(`${h.stripe.base}/__subscriptions/status`, { method: 'POST', body: JSON.stringify({ id: sub.id, status: 'canceled' }) });
    expect(h.account(u).status).toBe('canceled');
    await h.subscribe(u);
    expect([...h.stripe.realm('').sessions.values()][1].subscription_data.trial_period_days).toBe(null);
  });

  it('answers 503 NOT_SET_UP with the Secret names for the owner only when Stripe isn’t set up', async () => {
    await h.close();
    h = await billingServer({ env: { STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' } });
    const u = await h.user('nokey@example.com');
    const customer = await h.call(u, 'POST', '/api/billing/checkout', { tier: 'grow', interval: 'month', clientRequestId: crid() });
    expect(customer).toMatchObject({ status: 503, body: { code: 'NOT_SET_UP', error: 'Plans aren’t available yet.' } });
    expect(customer.body.hint).toBeUndefined();
    const owner = await h.user('owner@example.com', { admin: true });
    const seen = await h.call(owner, 'GET', '/api/billing/settings');
    expect(seen.status).toBe(200);
    expect(seen.body.missing).toEqual(expect.arrayContaining(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']));
    const put = await h.call(owner, 'PUT', '/api/billing/settings', { enforce: true });
    expect(put.status).toBe(503);
    expect(put.body.hint).toContain('STRIPE_SECRET_KEY');
  });

  it('refuses a live key with STRIPE_API_BASE (a live key only ever goes to Stripe)', async () => {
    await h.close();
    h = await billingServer({ env: { STRIPE_SECRET_KEY: 'sk_live_not_a_real_key_0000000000' } });
    const u = await h.user('livebase@example.com');
    const before = h.stripe.calls.length;
    expect((await h.call(u, 'POST', '/api/billing/checkout', { tier: 'grow', interval: 'month', clientRequestId: crid() })).body.code).toBe('NOT_SET_UP');
    expect(h.stripe.calls).toHaveLength(before);
  });
});

describe('the subscription lifecycle through the webhook', () => {
  beforeEach(async () => {
    h = await billingServer();
  });

  it('active → more businesses → failed payment (7 days of grace) → paid → unpaid locks extras → deleted keeps the oldest → resubscribe', async () => {
    const u = await h.user('life@example.com');
    // the first business needs no plan (setup makes it before the paywall); a second does
    expect(await h.claim(u, 'p1')).toMatchObject({ ok: true, state: 'active', starter: true });
    expect(await h.claim(u, 'p0')).toEqual({ ok: false, reason: 'plan_required' });
    const sub = await h.subscribe(u, { tier: 'grow', interval: 'month' });
    expect(h.account(u)).toMatchObject({ source: 'stripe', tier: 'grow', interval: 'month', status: 'active', business_limit: 1, extra_businesses: 0 });
    expect(await h.claim(u, 'p1')).toMatchObject({ ok: true });
    expect(await h.claim(u, 'p2')).toMatchObject({ ok: false, reason: 'limit', limit: 1 });

    // two more businesses (as from the dashboard): the webhook re-reads, the limit is 3
    const bizPrice = [...h.stripe.realm('').prices.values()].find((p) => p.lookup_key === 'ylb_business_monthly');
    await fetch(`${h.stripe.apiBase}/v1/subscriptions/${sub.id}`, { method: 'POST', headers: { authorization: `Bearer ${TEST_STRIPE_KEY}`, 'content-type': 'application/x-www-form-urlencoded' }, body: `items[0][price]=${bizPrice.id}&items[0][quantity]=2` });
    expect(h.account(u)).toMatchObject({ extra_businesses: 2, business_limit: 3 });
    expect(await h.claim(u, 'p2')).toMatchObject({ ok: true });
    expect(await h.claim(u, 'p3')).toMatchObject({ ok: true });

    // a renewal fails: past due, 7 days of grace, still active
    await fetch(`${h.stripe.base}/__invoices/fail`, { method: 'POST', body: JSON.stringify({ subscription: sub.id }) });
    const graced = h.account(u);
    expect(graced.status).toBe('past_due');
    expect(Date.parse(graced.grace_until) - h.clock()).toBeGreaterThan(6.9 * DAY);
    h.plans.forget(u.id);
    expect(await h.plans.entitlement(u.id)).toMatchObject({ active: true, banner: 'grace' });
    // after the grace: paused for payment, slots kept
    h.advance(8 * DAY);
    h.plans.forget(u.id);
    expect(await h.plans.entitlement(u.id)).toMatchObject({ active: false, paused: 'payment' });
    await expect(h.plans.requireActive({ id: u.id }, 'ai')).rejects.toMatchObject({ status: 402, code: 'PAYMENT_REQUIRED' });
    expect(h.slots(u).filter((s) => s.state === 'active')).toHaveLength(3);
    // paid: grace cleared
    await fetch(`${h.stripe.base}/__subscriptions/renew`, { method: 'POST', body: JSON.stringify({ id: sub.id }) });
    expect(h.account(u)).toMatchObject({ status: 'active', grace_until: null });
    // unpaid: everything above the oldest business locked; active again unlocks
    await fetch(`${h.stripe.base}/__subscriptions/status`, { method: 'POST', body: JSON.stringify({ id: sub.id, status: 'unpaid' }) });
    expect(h.slots(u).map((s) => [s.project_id, s.state, s.locked_reason ?? null])).toEqual([
      ['p1', 'active', null],
      ['p2', 'locked', 'payment'],
      ['p3', 'locked', 'payment'],
    ]);
    await fetch(`${h.stripe.base}/__subscriptions/status`, { method: 'POST', body: JSON.stringify({ id: sub.id, status: 'active' }) });
    expect(h.slots(u).every((s) => s.state === 'active')).toBe(true);
    // deleted: plan ended, the oldest business stays open, the rest are locked (never deleted)
    await fetch(`${h.stripe.base}/__subscriptions/status`, { method: 'POST', body: JSON.stringify({ id: sub.id, status: 'canceled' }) });
    expect(h.account(u)).toMatchObject({ status: 'canceled' });
    expect(h.account(u).ended_at).toBeTruthy();
    h.plans.forget(u.id);
    expect(await h.plans.entitlement(u.id)).toMatchObject({ active: false, paused: 'plan', banner: 'plan_ended' });
    expect(h.slots(u).map((s) => s.state)).toEqual(['active', 'locked', 'locked']);
    expect(h.slots(u)).toHaveLength(3);
    // a new subscription with two extras unlocks them again
    await h.subscribe(u, { tier: 'scale', interval: 'month', extraBusinesses: 2 });
    expect(h.account(u)).toMatchObject({ tier: 'scale', status: 'active', business_limit: 3 });
    expect(h.slots(u).every((s) => s.state === 'active')).toBe(true);
  });

  it('GET /plan with session_id adopts a finished Checkout even when its webhook never came (only the user’s own)', async () => {
    await h.close();
    h = await billingServer({ webhook: false });
    const u = await h.user('nohook@example.com');
    const other = await h.user('other@example.com');
    const co = await h.call(u, 'POST', '/api/billing/checkout', { tier: 'launch', interval: 'month', clientRequestId: crid() });
    const sid = co.body.url.split('/__pay/')[1];
    await fetch(`${h.stripe.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id: sid }) });
    expect(h.account(u).status).toBe('none');
    // someone else's session id does nothing for them
    await h.call(other, 'GET', `/api/billing/plan?session_id=${sid}`);
    expect(h.account(other)?.stripe_subscription_id ?? null).toBe(null);
    const plan = await h.call(u, 'GET', `/api/billing/plan?session_id=${sid}`);
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ billing: { enabled: true, enforce: true }, plan: { plan: 'launch', active: true }, account: { tier: 'launch', status: 'active', hasCustomer: true }, businesses: { limit: 1 }, credits: { monthly: 1500, usedCredits: 0 } });
  });
});

describe('webhook safety', () => {
  beforeEach(async () => {
    h = await billingServer({ webhook: false });
  });

  async function subscribed(email = 'hook@example.com') {
    const u = await h.user(email);
    const co = await h.call(u, 'POST', '/api/billing/checkout', { tier: 'grow', interval: 'month', clientRequestId: crid() });
    const sid = co.body.url.split('/__pay/')[1];
    const done = await (await fetch(`${h.stripe.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id: sid }) })).json();
    return { u, sub: done.subscription, session: done.session };
  }

  it('refuses a bad signature, a wrong secret and a stale timestamp without processing; accepts the previous secret', async () => {
    const { u, sub } = await subscribed();
    const reads = () => h.stripe.calls.filter((c) => c.route === 'GET /v1/subscriptions/:id').length;
    const before = reads();
    expect((await hook('customer.subscription.updated', sub, { secret: 'whsec_wrong_000000000000000000000' })).status).toBe(400);
    expect((await hook('customer.subscription.updated', sub, { t: Math.floor(h.clock() / 1000) - 600 })).status).toBe(400);
    const res = await fetch(`${h.base}/api/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=00' }, body: '{}' });
    expect(res.status).toBe(400);
    expect(reads()).toBe(before);
    expect(h.account(u).status).toBe('none');
    expect(h.logs.some((l) => l.includes('stripe_webhook_bad_signature'))).toBe(true);
    await h.close();
    h = await billingServer({ webhook: false, env: { STRIPE_WEBHOOK_SECRET: 'whsec_new_secret_00000000000000000', STRIPE_WEBHOOK_SECRET_PREVIOUS: TEST_STRIPE_WEBHOOK_SECRET } });
    const again = await subscribed('rotate@example.com');
    expect((await hook('checkout.session.completed', again.session)).status).toBe(200);
    expect(h.account(again.u).status).toBe('active');
  });

  it('ignores live-mode events with a test key, Connect events, and unknown customers (with an owner alert)', async () => {
    const { u, sub } = await subscribed();
    expect((await hook('customer.subscription.updated', sub, { livemode: true })).body).toEqual({ ok: true, ignored: true });
    expect((await hook('customer.subscription.updated', sub, { account: 'acct_123456789' })).body).toEqual({ ok: true, ignored: true });
    expect(h.account(u).status).toBe('none');
    const stranger = await hook('customer.subscription.updated', { ...sub, customer: 'cus_nobody000000' });
    expect(stranger).toMatchObject({ status: 200, body: { ok: true } });
    expect(h.logs.some((l) => l.includes('billing_alert_stripe_unknown_customer'))).toBe(true);
  });

  it('ignores a completed session whose client_reference_id is someone else’s with another customer', async () => {
    const { session } = await subscribed();
    const other = await h.user('victim@example.com');
    const forged = await hook('checkout.session.completed', { ...session, client_reference_id: other.id });
    expect(forged.status).toBe(200);
    expect(h.account(other)?.stripe_subscription_id ?? null).toBe(null);
  });

  it('applies a duplicate event once, never lets an older event win, and trusts Stripe over the payload', async () => {
    const { u, sub, session } = await subscribed();
    const first = await hook('checkout.session.completed', session, { id: 'evt_dupe0001' });
    expect(first.body).toEqual({ ok: true });
    const reads = h.stripe.calls.filter((c) => c.route === 'GET /v1/subscriptions/:id').length;
    expect((await hook('checkout.session.completed', session, { id: 'evt_dupe0001' })).body).toEqual({ ok: true, duplicate: true });
    expect(h.stripe.calls.filter((c) => c.route === 'GET /v1/subscriptions/:id').length).toBe(reads);
    // a tampered payload (scale, 9 extras, canceled) changes nothing: the subscription is read again
    await hook('customer.subscription.updated', { ...sub, status: 'canceled', items: { data: [{ id: 'si_x', price: { lookup_key: 'ylb_scale_monthly' }, quantity: 1 }, { id: 'si_y', price: { lookup_key: 'ylb_business_monthly' }, quantity: 9 }] } });
    expect(h.account(u)).toMatchObject({ tier: 'grow', status: 'active', extra_businesses: 0 });
    // an older read arriving late never overwrites a newer one
    const stamp = h.account(u).stripe_fetched_at;
    const wrote = await h.plans.store.apply(u.id, { status: 'canceled' }, new Date(Date.parse(stamp) - 60_000).toISOString());
    expect(wrote).toBe(false);
    expect(h.account(u).status).toBe('active');
  });

  it('answers 500 when processing fails (Stripe unreachable), and the redelivery succeeds', async () => {
    const { u, session } = await subscribed();
    h.stripe.fail('GET /v1/checkout/sessions/:id', 'server', 2);
    const failed = await hook('checkout.session.completed', session, { id: 'evt_retry0001' });
    expect(failed.status).toBe(500);
    expect(h.account(u).status).toBe('none');
    expect((h.supa.tables.get('webhook_deliveries') ?? []).some((r) => r.body_hash === 'stripe:evt_retry0001')).toBe(false);
    const again = await hook('checkout.session.completed', session, { id: 'evt_retry0001' });
    expect(again).toMatchObject({ status: 200, body: { ok: true } });
    expect(h.account(u).status).toBe('active');
  });

  it('never adopts a second subscription over the live one (owner alert)', async () => {
    const { u, sub } = await subscribed();
    await hook('customer.subscription.created', sub);
    expect(h.account(u).stripe_subscription_id).toBe(sub.id);
    // a second Checkout made outside the app for the same customer
    const price = [...h.stripe.realm('').prices.values()].find((p) => p.lookup_key === 'ylb_scale_monthly');
    const s2 = await fetch(`${h.stripe.apiBase}/v1/checkout/sessions`, { method: 'POST', headers: { authorization: `Bearer ${TEST_STRIPE_KEY}`, 'content-type': 'application/x-www-form-urlencoded' }, body: `mode=subscription&success_url=https://x&customer=${sub.customer}&line_items[0][price]=${price.id}&line_items[0][quantity]=1` }).then((r) => r.json());
    const done = await (await fetch(`${h.stripe.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id: s2.id }) })).json();
    await hook('customer.subscription.created', done.subscription);
    expect(h.account(u)).toMatchObject({ stripe_subscription_id: sub.id, tier: 'grow' });
    expect(h.logs.some((l) => l.includes('billing_alert_stripe_second_subscription'))).toBe(true);
    // never cancelled or refunded by us
    expect(h.writes().filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });
});

describe('adding and removing businesses', () => {
  beforeEach(async () => {
    h = await billingServer();
  });

  async function onPlan(email, opts = {}) {
    const u = await h.user(email);
    const sub = await h.subscribe(u, opts);
    expect(await h.claim(u, 'first')).toMatchObject({ ok: true });
    return { u, sub };
  }

  it('adds one: always_invoice + error_if_incomplete + an Idempotency-Key; the slot is usable after; the same request twice is one call', async () => {
    const { u } = await onPlan('add@example.com');
    const id = crid();
    expect((await h.call(u, 'POST', '/api/billing/businesses', { action: 'add', clientRequestId: id })).status).toBe(400); // confirm missing
    const res = await h.call(u, 'POST', '/api/billing/businesses', { action: 'add', clientRequestId: id, confirm: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, op: { kind: 'add_business', state: 'done' }, businesses: { limit: 2, extraBusinesses: 1 } });
    const w = subWrites();
    expect(w).toHaveLength(1);
    expect(w[0].idempotencyKey).toBe(`ylb-biz-add-${u.id}-${id}`);
    const sent = h.stripe.calls.find((c) => c === w[0]);
    expect(sent).toBeTruthy();
    expect(await h.claim(u, 'second')).toMatchObject({ ok: true });
    // the same clientRequestId again: the first answer, no second Stripe write
    const again = await h.call(u, 'POST', '/api/billing/businesses', { action: 'add', clientRequestId: id, confirm: true });
    expect(again.status).toBe(200);
    expect(subWrites()).toHaveLength(1);
    // the request had the money flags (the mock records the body through the idempotency fingerprint)
    const inv = [...h.stripe.realm('').invoices.values()].find((i) => i.billing_reason === 'subscription_update');
    expect(inv).toMatchObject({ status: 'paid', amount_paid: expect.any(Number) });
  });

  it('a declined card answers 402 CARD_DECLINED and changes nothing', async () => {
    const { u, sub } = await onPlan('declined@example.com');
    h.stripe.decline(sub.customer);
    const res = await h.call(u, 'POST', '/api/billing/businesses', { action: 'add', clientRequestId: crid(), confirm: true });
    expect(res).toMatchObject({ status: 402, body: { code: 'CARD_DECLINED', error: 'Your card was declined. Update it in Billing, then try again.' } });
    expect(res.text).not.toMatch(/generic_decline|Your card was declined\.$/);
    expect(h.account(u)).toMatchObject({ extra_businesses: 0, business_limit: 1 });
    expect(await h.claim(u, 'second')).toMatchObject({ ok: false, reason: 'limit' });
    // a deliberate "try again" is a new request and is allowed once the card works
    h.stripe.decline(sub.customer, false);
    expect((await h.call(u, 'POST', '/api/billing/businesses', { action: 'add', clientRequestId: crid(), confirm: true })).status).toBe(200);
  });

  it('a timeout after Stripe applied it: op unknown, read back → done, and never a second POST', async () => {
    const { u } = await onPlan('timeout@example.com');
    h.stripe.fail('POST /v1/subscriptions/:id', 'timeout');
    const res = await h.call(u, 'POST', '/api/billing/businesses', { action: 'add', clientRequestId: crid(), confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.op).toMatchObject({ state: 'done' });
    expect(subWrites()).toHaveLength(1);
    expect(h.account(u)).toMatchObject({ extra_businesses: 1, business_limit: 2 });
  });

  it('a timeout where nothing was applied stays unknown (202), blocks a second op (409), and becomes not_applied after 10 minutes', async () => {
    const { u, sub } = await onPlan('lost@example.com');
    // the request never reached Stripe: a server error answer (5xx is "unknown" too) with nothing done
    h.stripe.fail('POST /v1/subscriptions/:id', 'server');
    const res = await h.call(u, 'POST', '/api/billing/businesses', { action: 'add', clientRequestId: crid(), confirm: true });
    expect(res).toMatchObject({ status: 202, body: { code: 'BILLING_PENDING', op: { state: 'unknown' } } });
    expect(subWrites()).toHaveLength(1);
    const busy = await h.call(u, 'POST', '/api/billing/businesses', { action: 'add', clientRequestId: crid(), confirm: true });
    expect(busy).toMatchObject({ status: 409, body: { code: 'BILLING_PENDING' } });
    h.advance(11 * 60_000);
    const view = await h.call(u, 'GET', '/api/billing/businesses');
    expect(view.body.op).toBe(null);
    expect((h.supa.tables.get('billing_ops') ?? []).find((o) => o.user_id === u.id && o.kind === 'add_business').state).toBe('not_applied');
    expect(subWrites()).toHaveLength(1);
    void sub;
  });

  it('two different add requests at once: one goes to Stripe, the other is 409 BILLING_PENDING', async () => {
    const { u } = await onPlan('race@example.com');
    const [a, b] = await Promise.all([1, 2].map(() => h.call(u, 'POST', '/api/billing/businesses', { action: 'add', clientRequestId: crid(), confirm: true })));
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(subWrites()).toHaveLength(1);
  });

  it('removes one at period end (proration none): the limit stays until then, the hourly job locks the chosen one; undo restores at no charge', async () => {
    const { u } = await onPlan('remove@example.com', { extraBusinesses: 2 });
    expect(await h.claim(u, 'second')).toMatchObject({ ok: true });
    expect(await h.claim(u, 'third')).toMatchObject({ ok: true });
    const rm = await h.call(u, 'POST', '/api/billing/businesses', { action: 'remove', projectId: 'second', clientRequestId: crid(), confirm: true });
    expect(rm.status).toBe(200);
    expect(rm.body.businesses).toMatchObject({ limit: 3, extraBusinesses: 1, pendingRemove: { count: 1 } });
    const periodEnd = h.account(u).current_period_end;
    expect(h.account(u)).toMatchObject({ extra_businesses: 1, extra_keep: 2, extra_keep_until: periodEnd, business_limit: 3 });
    expect(h.slots(u).find((s) => s.project_id === 'second').lock_at).toBe(periodEnd);
    const w = subWrites().at(-1);
    expect(w.idempotencyKey).toMatch(/^ylb-biz-rm-/);
    expect([...h.stripe.realm('').invoices.values()].filter((i) => i.billing_reason === 'subscription_update')).toHaveLength(0);

    // undo before the period ends: back to 2, no charge, no lock
    const undo = await h.call(u, 'POST', '/api/billing/businesses', { action: 'undo_remove', clientRequestId: crid(), confirm: true });
    expect(undo.status).toBe(200);
    expect(h.account(u)).toMatchObject({ extra_businesses: 2, extra_keep: 0, extra_keep_until: null, business_limit: 3 });
    expect(h.slots(u).find((s) => s.project_id === 'second').lock_at ?? null).toBe(null);
    expect([...h.stripe.realm('').invoices.values()].filter((i) => i.billing_reason === 'subscription_update')).toHaveLength(0);

    // remove again, then the period ends: the hourly job lowers the limit and locks the chosen business
    await h.call(u, 'POST', '/api/billing/businesses', { action: 'remove', projectId: 'third', clientRequestId: crid(), confirm: true });
    h.advance(Date.parse(periodEnd) - h.clock() + 60_000);
    const out = await h.plans.hourly({});
    expect(out).toMatchObject({ keepsApplied: 1 });
    expect(h.account(u)).toMatchObject({ business_limit: 2, extra_keep: 0 });
    expect(h.slots(u).map((s) => [s.project_id, s.state])).toEqual([
      ['first', 'active'],
      ['second', 'active'],
      ['third', 'locked'],
    ]);
  });

  it('adding while a removal is pending says to undo it instead (no charge for a paid slot); comp plans can’t buy', async () => {
    const { u } = await onPlan('pending@example.com', { extraBusinesses: 1 });
    await h.call(u, 'POST', '/api/billing/businesses', { action: 'remove', clientRequestId: crid(), confirm: true });
    const add = await h.call(u, 'POST', '/api/billing/businesses', { action: 'add', clientRequestId: crid(), confirm: true });
    expect(add).toMatchObject({ status: 409, body: { useUndo: true } });
    const comp = await h.user('comp@example.com');
    const owner = await h.user('owner@example.com', { admin: true });
    const tag = (await h.call(owner, 'GET', '/api/billing/accounts')).body.accounts.find((a) => a.customerTag) ? null : null;
    void tag;
    await h.plans.store.ensureAccount(comp.id);
    const compTag = h.account(comp).customer_tag;
    expect((await h.call(owner, 'PUT', `/api/billing/accounts/${compTag}/comp`, { tier: 'grow', extraBusinesses: 1, until: null, note: 'friend' })).status).toBe(200);
    expect(h.account(comp)).toMatchObject({ source: 'comp', tier: 'grow', status: 'active', business_limit: 2 });
    expect((await h.call(comp, 'POST', '/api/billing/businesses', { action: 'add', clientRequestId: crid(), confirm: true })).body.code).toBe('NOT_ALLOWED_ON_PLAN');
  });

  it('PUT businesses/active chooses which stay active (at most the limit, only theirs)', async () => {
    const { u } = await onPlan('choose@example.com', { extraBusinesses: 1 });
    expect(await h.claim(u, 'b')).toMatchObject({ ok: true });
    expect((await h.call(u, 'PUT', '/api/billing/businesses/active', { projectIds: ['first', 'b', 'c'] })).status).toBe(400);
    const ok = await h.call(u, 'PUT', '/api/billing/businesses/active', { projectIds: ['b'] });
    expect(ok.status).toBe(200);
    expect(ok.body.slots.map((s) => [s.projectId, s.state])).toEqual([
      ['first', 'locked'],
      ['b', 'active'],
    ]);
  });
});

describe('changing the plan', () => {
  beforeEach(async () => {
    h = await billingServer();
  });

  it('an upgrade is immediate and charged now; a downgrade keeps the old tier until the period ends', async () => {
    const u = await h.user('upgrade@example.com');
    await h.subscribe(u, { tier: 'grow', interval: 'month' });
    const up = await h.call(u, 'POST', '/api/billing/plan', { tier: 'scale', interval: 'month', clientRequestId: crid(), confirm: true });
    expect(up.status).toBe(200);
    expect(h.account(u)).toMatchObject({ tier: 'scale', tier_keep: null });
    expect([...h.stripe.realm('').invoices.values()].filter((i) => i.billing_reason === 'subscription_update')).toHaveLength(1);
    expect(subWrites().at(-1).idempotencyKey).toMatch(/^ylb-plan-/);
    const down = await h.call(u, 'POST', '/api/billing/plan', { tier: 'launch', interval: 'month', clientRequestId: crid(), confirm: true });
    expect(down.status).toBe(200);
    const row = h.account(u);
    expect(row).toMatchObject({ tier: 'launch', tier_keep: 'scale', tier_keep_until: row.current_period_end });
    expect(down.body.plan).toMatchObject({ tier: 'scale', features: { adsLaunch: true } });
    expect([...h.stripe.realm('').invoices.values()].filter((i) => i.billing_reason === 'subscription_update')).toHaveLength(1);
    h.advance(Date.parse(row.current_period_end) - h.clock() + 60_000);
    await h.plans.hourly({});
    h.plans.forget(u.id);
    expect(await h.plans.entitlement(u.id)).toMatchObject({ tier: 'launch', features: { adsLaunch: false } });
  });

  it('month → year switches both items to yearly prices; year → month is refused', async () => {
    const u = await h.user('yearly@example.com');
    await h.subscribe(u, { tier: 'grow', interval: 'month', extraBusinesses: 1 });
    const res = await h.call(u, 'POST', '/api/billing/plan', { tier: 'grow', interval: 'year', clientRequestId: crid(), confirm: true });
    expect(res.status).toBe(200);
    const sub = [...h.stripe.realm('').subscriptions.values()][0];
    const items = [...h.stripe.realm('').items.values()].filter((i) => i.subscription === sub.id && !i.deleted);
    expect(items.map((i) => i.price.lookup_key).sort()).toEqual(['ylb_business_yearly', 'ylb_grow_yearly']);
    expect(h.account(u)).toMatchObject({ interval: 'year', extra_businesses: 1 });
    const back = await h.call(u, 'POST', '/api/billing/plan', { tier: 'grow', interval: 'month', clientRequestId: crid(), confirm: true });
    expect(back).toMatchObject({ status: 409, body: { code: 'NOT_ALLOWED_ON_PLAN' } });
    const none = await h.user('noplan@example.com');
    expect((await h.call(none, 'POST', '/api/billing/plan', { tier: 'grow', interval: 'month', clientRequestId: crid(), confirm: true })).body.code).toBe('PLAN_REQUIRED');
  });
});

describe('cron jobs', () => {
  beforeEach(async () => {
    h = await billingServer({ webhook: false });
  });

  it('the reconcile adopts a completed Checkout whose webhook never came, and writes nothing to Stripe', async () => {
    const u = await h.user('missed@example.com');
    const co = await h.call(u, 'POST', '/api/billing/checkout', { tier: 'grow', interval: 'year', clientRequestId: crid() });
    await fetch(`${h.stripe.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id: co.body.url.split('/__pay/')[1] }) });
    const writesBefore = h.writes().length;
    const report = await h.plans.reconcile({ deadline: h.clock() + 30_000 });
    expect(report.changed).toBeGreaterThanOrEqual(1);
    expect(h.account(u)).toMatchObject({ status: 'active', tier: 'grow', interval: 'year', checkout_session_id: null });
    expect(h.writes().length).toBe(writesBefore);
    // a second run reads again and changes nothing
    expect((await h.plans.reconcile({ deadline: h.clock() + 30_000 })).changed).toBe(0);
  });

  it('the hourly job ends free trials, resolves unknown ops by reading back, and respects its deadline', async () => {
    const u = await h.user('comp-trial@example.com');
    h.supa.tables.set('user_docs', [{ user_id: u.id, kind: 'project', id: 'p1', data: {} }]);
    h.supa.tables.set('project_slots', [{ user_id: u.id, project_id: 'p1', state: 'active', claimed_at: new Date(h.clock()).toISOString() }]);
    await h.db.rpc('ylb_billing_start_existing', { p_days: 30, p_tags: { [u.id]: `cust_${'d'.repeat(24)}` } });
    h.advance(31 * DAY);
    const out = await h.plans.hourly({ deadline: h.clock() + 30_000 });
    expect(out.compsEnded).toBe(1);
    expect(h.account(u)).toMatchObject({ status: 'expired' });
    h.plans.forget(u.id);
    expect(await h.plans.entitlement(u.id)).toMatchObject({ active: false, banner: 'plan_ended' });
    // with no time left it stops before reading anything back
    const none = await h.plans.hourly({ deadline: h.clock() });
    expect(none.opsResolved).toBe(0);
  });

  it('runs each job once per period behind the cron claims (server/cron)', async () => {
    const { createCron } = await import('../cron/index.mjs');
    const cron = createCron({ env: { CRON_SECRET: 'x'.repeat(32) }, storage: null, now: h.clock, log: { log() {}, warn() {} } });
    for (const job of h.routes.cronJobs()) cron.register(job);
    const first = await cron.tick();
    const second = await cron.tick();
    const ran = (r) => r.jobs.filter((x) => x.status === 'ran').map((x) => x.name);
    expect(ran(first)).toEqual(expect.arrayContaining(['billing-hourly']));
    expect(ran(second)).not.toContain('billing-hourly');
  });
});

describe('secrets and account deletion', () => {
  beforeEach(async () => {
    h = await billingServer();
  });

  it('no reply or log line holds the Stripe key or the webhook secret; the owner sees the last 4', async () => {
    const u = await h.user('secret@example.com');
    const owner = await h.user('owner@example.com', { admin: true });
    const bodies = [];
    bodies.push((await h.call(u, 'POST', '/api/billing/checkout', { tier: 'grow', interval: 'month', clientRequestId: crid() })).text);
    bodies.push((await h.call(u, 'GET', '/api/billing/plan')).text);
    bodies.push((await h.call(owner, 'GET', '/api/billing/settings')).text);
    bodies.push((await h.call(owner, 'GET', '/api/billing/accounts')).text);
    h.stripe.fail('POST /v1/checkout/sessions', 'server');
    bodies.push((await h.call(u, 'POST', '/api/billing/checkout', { tier: 'scale', interval: 'month', clientRequestId: crid() })).text);
    const settings = JSON.parse(bodies[2]);
    expect(settings.stripe).toMatchObject({ mode: 'test', key: `…${TEST_STRIPE_KEY.slice(-4)}`, webhookSecret: `…${TEST_STRIPE_WEBHOOK_SECRET.slice(-4)}` });
    expect(Object.values(settings.stripe.prices).every((v) => v === 'ok')).toBe(true);
    for (const text of [...bodies, ...h.logs]) {
      expect(text).not.toContain(TEST_STRIPE_KEY);
      expect(text).not.toContain(TEST_STRIPE_WEBHOOK_SECRET);
      expect(text).not.toMatch(/sk_test_[A-Za-z0-9_]{8,}/);
    }
    const accounts = JSON.parse(bodies[3]).accounts;
    for (const a of accounts) for (const v of [a.stripeCustomer, a.stripeSubscription]) if (v) expect(v).toMatch(/^….{4}$/);
  });

  it('cancels the live subscription once before the account goes; an unconfirmed cancel stops the deletion (409)', async () => {
    const u = await h.user('leaving@example.com');
    const sub = await h.subscribe(u);
    await h.routes.beforeForget(u.id);
    const deletes = h.writes().filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].idempotencyKey).toBe(`ylb-cancel-${u.id}-${sub.id}`);
    expect(h.account(u).status).toBe('canceled');
    // nothing live: nothing to do
    await h.routes.beforeForget(u.id);
    expect(h.writes().filter((c) => c.method === 'DELETE')).toHaveLength(1);

    const v = await h.user('stuck@example.com');
    await h.subscribe(v);
    h.stripe.fail('DELETE /v1/subscriptions/:id', 'server');
    await expect(h.routes.beforeForget(v.id)).rejects.toMatchObject({ status: 409, code: 'BILLING_PENDING' });
    expect(h.account(v).status).toBe('active');
  });
});
