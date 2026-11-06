// Plans and billing: the review's money and data cases, against mock Stripe and mock Supabase only. One open Checkout
// page per user, plan changes that never charge twice for a period already paid, ops a crashed process left
// 'sending', comp plans kept from old subscriptions, turning plans on, the owner row, account deletion cancelling
// every subscription, locked businesses, and abandoned slots.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { billingServer } from './test-helpers.mjs';
import { signStripeHeader, TEST_STRIPE_WEBHOOK_SECRET } from '../test/mock-stripe.mjs';

const MIN = 60_000;
let h;
const crid = () => crypto.randomUUID();
afterEach(async () => {
  await h?.close();
  h = null;
});

const sessions = () => [...h.stripe.realm('').sessions.values()];
const subWrites = () => h.writes().filter((c) => c.route === 'POST /v1/subscriptions/:id');
const updateInvoices = () => [...h.stripe.realm('').invoices.values()].filter((i) => i.billing_reason === 'subscription_update');
const ops = (u, kind) => (h.supa.tables.get('billing_ops') ?? []).filter((o) => o.user_id === u.id && (!kind || o.kind === kind));
const pay = (id) => fetch(`${h.stripe.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id }) }).then((r) => r.json());
const co = (u, tier, interval, extra = 0) => h.call(u, 'POST', '/api/billing/checkout', { tier, interval, extraBusinesses: extra, clientRequestId: crid() });
const plan = (u, tier, interval) => h.call(u, 'POST', '/api/billing/plan', { tier, interval, clientRequestId: crid(), confirm: true });
const biz = (u, action, extra = {}) => h.call(u, 'POST', '/api/billing/businesses', { action, clientRequestId: crid(), confirm: true, ...extra });
async function hook(type, object) {
  const evt = { id: `evt_${crypto.randomBytes(8).toString('hex')}`, object: 'event', type, livemode: false, data: { object }, created: Math.floor(h.clock() / 1000) };
  const raw = JSON.stringify(evt);
  const res = await fetch(`${h.base}/api/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripeHeader(raw, TEST_STRIPE_WEBHOOK_SECRET, Math.floor(h.clock() / 1000)) }, body: raw });
  return res.status;
}

describe('Checkout: only one page can ever be paid', () => {
  it('a new choice expires the open page first (once, with an Idempotency-Key); the old page can no longer be paid', async () => {
    h = await billingServer();
    const u = await h.user('two-pages@example.com');
    const a = await co(u, 'grow', 'month');
    expect(a.status).toBe(200);
    const b = await co(u, 'scale', 'month');
    expect(b.status).toBe(200);
    expect(b.body.url).not.toBe(a.body.url);
    const [sa, sb] = sessions();
    expect(sa.status).toBe('expired');
    expect(sb.status).toBe('open');
    const expires = h.writes().filter((c) => /\/expire$/.test(c.path));
    expect(expires).toHaveLength(1);
    expect(expires[0].idempotencyKey).toBe(`ylb-co-expire-${sa.id}`);
    // paying the old page is refused by Stripe; the new one makes the only subscription
    expect((await pay(sa.id)).error).toMatch(/expired/);
    expect((await pay(sb.id)).subscription).toBeTruthy();
    expect([...h.stripe.realm('').subscriptions.values()]).toHaveLength(1);
    // back to the same choice later: the same page, nothing expired or made
    const before = h.writes().length;
    expect((await co(u, 'grow', 'month')).body.code).toBe('ALREADY_SUBSCRIBED');
    expect(h.writes()).toHaveLength(before);
  });

  it('two tabs at once (each its own request id): at most one page stays open', async () => {
    h = await billingServer();
    const u = await h.user('two-tabs@example.com');
    // the Customer exists first (as after any earlier visit), so both requests race on the session itself
    await co(u, 'launch', 'month');
    const [x, y] = await Promise.all([co(u, 'grow', 'month'), co(u, 'scale', 'year')]);
    expect([x.status, y.status].sort()).toEqual(x.status === y.status ? [200, 200] : [200, 409]);
    if (x.status !== y.status) expect([x, y].find((r) => r.status === 409).body.code).toBe('BILLING_PENDING');
    expect(sessions().filter((s) => s.status === 'open')).toHaveLength(1);
    expect(ops(u, 'checkout').every((o) => o.state === 'done' || o.state === 'failed')).toBe(true);
  });
});

describe('plan changes never charge twice for a period already paid', () => {
  it('a lower plan with a switch to yearly is refused (two steps), with no Stripe write', async () => {
    h = await billingServer();
    const u = await h.user('down-year@example.com');
    await h.subscribe(u, { tier: 'scale', interval: 'month' });
    const n = subWrites().length;
    const res = await plan(u, 'launch', 'year');
    expect(res).toMatchObject({ status: 409, body: { code: 'NOT_ALLOWED_ON_PLAN' } });
    expect(subWrites()).toHaveLength(n);
  });

  it('a second downgrade keeps the highest tier paid; moving back up to it or below costs nothing; above it is refused', async () => {
    h = await billingServer();
    const u = await h.user('keep-tier@example.com');
    await h.subscribe(u, { tier: 'scale', interval: 'month' });
    expect((await plan(u, 'grow', 'month')).status).toBe(200);
    expect(h.account(u)).toMatchObject({ tier: 'grow', tier_keep: 'scale' });
    expect((await plan(u, 'launch', 'month')).status).toBe(200);
    expect(h.account(u)).toMatchObject({ tier: 'launch', tier_keep: 'scale' });
    // back up to Grow: within what was paid, so no charge and Scale stays
    expect((await plan(u, 'grow', 'month')).status).toBe(200);
    expect(subWrites().at(-1)).toBeTruthy();
    expect(updateInvoices()).toHaveLength(0);
    expect(h.account(u)).toMatchObject({ tier: 'grow', tier_keep: 'scale' });
    // and to Scale itself: no charge, nothing pending any more
    expect((await plan(u, 'scale', 'month')).status).toBe(200);
    expect(updateInvoices()).toHaveLength(0);
    expect(h.account(u)).toMatchObject({ tier: 'scale', tier_keep: null });

    const v = await h.user('keep-grow@example.com');
    await h.subscribe(v, { tier: 'grow', interval: 'month' });
    expect((await plan(v, 'launch', 'month')).status).toBe(200);
    const n = subWrites().length;
    expect(await plan(v, 'scale', 'month')).toMatchObject({ status: 409, body: { code: 'NOT_ALLOWED_ON_PLAN' } });
    expect(await plan(v, 'launch', 'year')).toMatchObject({ status: 409, body: { code: 'NOT_ALLOWED_ON_PLAN' } });
    expect(subWrites()).toHaveLength(n);
  });
});

describe('extra businesses', () => {
  it('a second removal keeps what the first kept; the same business twice is refused', async () => {
    h = await billingServer();
    const u = await h.user('rm-twice@example.com');
    await h.subscribe(u, { tier: 'grow', interval: 'month', extraBusinesses: 2 });
    for (const p of ['first', 'second', 'third']) expect(await h.claim(u, p)).toMatchObject({ ok: true });
    expect((await biz(u, 'remove', { projectId: 'third' })).status).toBe(200);
    expect(await biz(u, 'remove', { projectId: 'third' })).toMatchObject({ status: 409 });
    expect((await biz(u, 'remove', { projectId: 'second' })).status).toBe(200);
    expect(h.account(u)).toMatchObject({ extra_businesses: 0, extra_keep: 2, business_limit: 3 });
    // nothing locked before the period ends
    expect(h.slots(u).every((s) => s.state === 'active')).toBe(true);
  });

  it('undo after a switch to yearly (a new period) is refused: that would be a free business for a year', async () => {
    h = await billingServer();
    const u = await h.user('undo-year@example.com');
    await h.subscribe(u, { tier: 'grow', interval: 'month', extraBusinesses: 1 });
    expect((await biz(u, 'remove')).status).toBe(200);
    expect((await plan(u, 'grow', 'year')).status).toBe(200);
    const n = subWrites().length;
    expect(await biz(u, 'undo_remove')).toMatchObject({ status: 409, body: { useAdd: true } });
    expect(subWrites()).toHaveLength(n);
  });
});

describe('ops a crashed process left sending', () => {
  it('are read back (never resent): the user isn’t blocked for good, and the hourly job finds them', async () => {
    h = await billingServer();
    const u = await h.user('crashed@example.com');
    const sub = await h.subscribe(u, { tier: 'grow', interval: 'month' });
    const at = new Date(h.clock() - 3 * MIN).toISOString();
    h.supa.tables.get('billing_ops').push({ id: crypto.randomUUID(), user_id: u.id, kind: 'add_business', client_request_id: crid(), state: 'sending', request: { from: { qty: 0 }, to: { qty: 1 }, subscription: sub.id }, idempotency_key: 'ylb-biz-add-x', stripe_ref: {}, error_code: null, requested_at: at });
    const writes = subWrites().length;
    // within the give-up time it's still unclear: 409, and nothing was sent
    expect(await biz(u, 'add')).toMatchObject({ status: 409, body: { code: 'BILLING_PENDING' } });
    expect(ops(u, 'add_business')[0].state).toBe('unknown');
    h.advance(11 * MIN);
    const out = await h.plans.hourly({});
    expect(out.opsResolved).toBe(1);
    expect(ops(u, 'add_business')[0].state).toBe('not_applied');
    expect(subWrites()).toHaveLength(writes);
    expect((await biz(u, 'add')).status).toBe(200);
  });
});

describe('free (comp) plans', () => {
  it('an old subscription’s events never overwrite a comp plan; buying a plan still works', async () => {
    h = await billingServer();
    const u = await h.user('comp-old@example.com');
    const sub = await h.subscribe(u);
    await fetch(`${h.stripe.base}/__subscriptions/status`, { method: 'POST', body: JSON.stringify({ id: sub.id, status: 'canceled' }) });
    expect(h.account(u).status).toBe('canceled');
    const owner = await h.user('owner-comp@example.com', { admin: true });
    expect((await h.call(owner, 'PUT', `/api/billing/accounts/${h.account(u).customer_tag}/comp`, { tier: 'grow', extraBusinesses: 0, until: null })).status).toBe(200);
    const ended = (await h.stripe.realm('').subscriptions.get(sub.id)) ?? sub;
    expect(await hook('customer.subscription.deleted', { ...ended, id: sub.id, customer: sub.customer, status: 'canceled' })).toBe(200);
    expect(await hook('invoice.paid', { id: 'in_test_0000000001', customer: sub.customer })).toBe(200);
    expect(h.account(u)).toMatchObject({ source: 'comp', tier: 'grow', status: 'active' });
    // the comp user buys a plan: Checkout works and the new subscription is adopted
    const bought = await h.subscribe(u, { tier: 'scale', interval: 'month' });
    expect(h.account(u)).toMatchObject({ source: 'stripe', tier: 'scale', status: 'active', stripe_subscription_id: bought.id });
  });
});

describe('turning plans on', () => {
  it('existing users get their free Grow before plans go on; a failure leaves plans off and the owner can try again', async () => {
    h = await billingServer({ enforce: false });
    const owner = await h.user('owner-on@example.com', { admin: true });
    const u = await h.user('existing@example.com');
    h.supa.tables.set('user_docs', [{ user_id: u.id, kind: 'project', id: 'p1', data: {} }]);
    h.supa.behavior.fail = (method, path) => (path.endsWith('/rpc/ylb_billing_start_existing') ? { status: 500, body: { message: 'boom' } } : null);
    const first = await h.call(owner, 'PUT', '/api/billing/settings', { enforce: true });
    expect(first.status).toBeGreaterThanOrEqual(500);
    expect(h.supa.tables.get('billing_settings')[0].enforce).toBe(false);
    h.supa.behavior.fail = null;
    const again = await h.call(owner, 'PUT', '/api/billing/settings', { enforce: true });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ settings: { enforce: true }, existingAccountsStarted: 1 });
    expect(h.account(u)).toMatchObject({ source: 'comp', tier: 'grow' });
  });
});

describe('the owner plan', () => {
  it('a gate that only knows the user id sees the owner once the owner has been seen; a removed admin’s row is dropped', async () => {
    h = await billingServer();
    const o = await h.user('boss-gate@example.com', { admin: true });
    expect(await h.plans.businessLimit(o.id)).toBe(0);
    await h.plans.requireActive({ id: o.id, email: o.email, isAdmin: true });
    h.plans.forget(o.id);
    expect(await h.plans.businessLimit(o.id)).toBe(1000);
    expect((await h.plans.entitlement(o.id)).plan).toBe('owner');
    // no longer an admin: the stored row gives nothing
    const ent = await h.plans.entitlement(o.id, { id: o.id, email: o.email, isAdmin: false });
    expect(ent).toMatchObject({ plan: 'none', active: false });
    expect(h.account(o)).toMatchObject({ source: 'stripe', tier: 'none', business_limit: 1 });
  });
});

describe('account deletion', () => {
  it('cancels a subscription the database doesn’t know yet (webhook not in), and every live one of the customer', async () => {
    h = await billingServer({ webhook: false });
    const u = await h.user('behind@example.com');
    const a = await co(u, 'grow', 'month');
    const done = await pay(a.body.url.split('/__pay/')[1]);
    expect(h.account(u).stripe_subscription_id).toBe(null);
    await h.routes.beforeForget(u.id);
    const deletes = h.writes().filter((c) => c.method === 'DELETE');
    expect(deletes.map((d) => d.idempotencyKey)).toEqual([`ylb-cancel-${u.id}-${done.subscription.id}`]);
    expect(h.stripe.realm('').subscriptions.get(done.subscription.id).status).toBe('canceled');
  });

  it('Stripe failing is a 503 in our words; a subscription Stripe doesn’t know doesn’t block deletion', async () => {
    h = await billingServer();
    const u = await h.user('flaky@example.com');
    await h.subscribe(u);
    h.stripe.fail('GET /v1/subscriptions', 'server', 2);
    const err = await h.routes.beforeForget(u.id).catch((e) => e);
    expect(err).toMatchObject({ name: 'IntegrationError', status: 503, code: 'UNAVAILABLE' });
    expect(err.message).not.toMatch(/Stripe/);

    const v = await h.user('gone@example.com');
    await h.plans.store.ensureAccount(v.id);
    Object.assign(h.account(v), { stripe_subscription_id: 'sub_test_doesnotexist01', status: 'active' });
    await expect(h.routes.beforeForget(v.id)).resolves.toBeUndefined();
    expect(h.writes().filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });
});

describe('locked and abandoned businesses', () => {
  it('requireSlot refuses a locked business (402 BUSINESS_LIMIT) and lets an active one through', async () => {
    h = await billingServer();
    const u = await h.user('locked@example.com');
    await h.subscribe(u, { tier: 'grow', interval: 'month', extraBusinesses: 1 });
    expect(await h.claim(u, 'a')).toMatchObject({ ok: true });
    expect(await h.claim(u, 'b')).toMatchObject({ ok: true });
    expect((await h.call(u, 'PUT', '/api/billing/businesses/active', { projectIds: ['a'] })).status).toBe(200);
    const who = { id: u.id, email: u.email, isAdmin: false };
    await expect(h.plans.requireSlot(who, 'b')).rejects.toMatchObject({ status: 402, code: 'BUSINESS_LIMIT' });
    await expect(h.plans.requireSlot(who, 'a')).resolves.toBeUndefined();
    await expect(h.plans.requireSlot(who, 'never-claimed')).resolves.toBeUndefined();
  });

  it('a slot claimed for a business that was never saved goes back to the plan after a day', async () => {
    h = await billingServer();
    const u = await h.user('ghost@example.com');
    await h.subscribe(u, { tier: 'launch', interval: 'month' });
    expect(await h.claim(u, 'ghost')).toMatchObject({ ok: true });
    expect(await h.claim(u, 'real')).toMatchObject({ ok: false, reason: 'limit' });
    h.advance(25 * 60 * MIN);
    const out = await h.plans.hourly({});
    expect(out.orphanSlotsFreed).toBe(1);
    expect(h.slots(u)).toHaveLength(0);
    expect(await h.claim(u, 'real')).toMatchObject({ ok: true });
  });
});
