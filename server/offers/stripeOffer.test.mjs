// Stripe offers (server/offers/stripeOffer.mjs, spec S4): made on the seller's own Stripe account with a checked price
// and delivery, no Stripe write, one row per request; paused and resumed; deleted without sales.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { offersServer, testBilling } from './test-helpers.mjs';

describe('Stripe offers', () => {
  let h;
  let s;
  let billing;
  beforeAll(async () => {
    billing = testBilling();
    h = await offersServer({ stripe: true, billing });
    s = await h.stripeSeller('stripe-offers@example.com');
  });
  afterAll(() => h.close());
  const make = (who, over = {}) => h.call(who, 'POST', '/api/offers', { projectId: 'p1', provider: 'stripe', title: 'Pottery course', priceMinor: 4900, currency: 'usd', delivery: { kind: 'none' }, clientRequestId: crypto.randomUUID(), ...over });
  const productFile = async (who, over = {}) => {
    const id = crypto.randomBytes(16).toString('base64url');
    await h.db.insert('lead_files', { id, user_id: who.id, project_id: 'p1', title: 'Pack', kind: 'file', purpose: 'product', file_name: 'pack.pdf', object_path: `${who.id}/${id}/v1/pack.pdf`, ...over });
    return id;
  };

  it('creates one on the seller’s account, with the server’s price text, no Stripe write, one row per request', async () => {
    const writes = h.stripe.writes().length;
    const crid = crypto.randomUUID();
    const a = await make(s.who, { clientRequestId: crid });
    expect(a.status).toBe(200);
    expect(a.body.offer).toMatchObject({ provider: 'stripe', priceMinor: 4900, currency: 'usd', priceDisplay: '$49', environment: 'sandbox', checkoutHost: 'checkout.stripe.com', delivery: { kind: 'none' }, status: 'active' });
    expect(a.body.offer.problem).toBeUndefined();
    const b = await make(s.who, { clientRequestId: crid });
    expect(b.body.offer.id).toBe(a.body.offer.id);
    expect(h.rows('offers').filter((o) => o.id === a.body.offer.id)).toHaveLength(1);
    expect(h.rows('offers').find((o) => o.id === a.body.offer.id).connect_account_id).toBe(s.row.id);
    expect(h.stripe.writes().length).toBe(writes);
  });

  it('checks the price and the delivery: another user’s file or a magnet is refused', async () => {
    for (const [priceMinor, currency] of [[49, 'usd'], [100_000_000, 'usd'], [10.5, 'usd'], ['4900', 'usd'], [4900, 'dollars'], [4900, '']]) expect((await make(s.who, { priceMinor, currency })).body.code, `${priceMinor} ${currency}`).toBe('BAD_PRICE');
    // HUF and ISK: Stripe takes them with two decimals while our minor units keep them whole (5000 Ft would charge
    // 50 Ft): refused until that's handled, as is any currency off the list
    for (const currency of ['huf', 'isk', 'xof']) expect((await make(s.who, { priceMinor: 500000, currency })).body.code, currency).toBe('BAD_CURRENCY');
    // Stripe's minimum in the currency, not only USD's 0.50
    const small = await make(s.who, { priceMinor: 500, currency: 'mxn' });
    expect(small.body.code).toBe('BAD_PRICE');
    expect(small.body.error).toContain('MXN');
    expect((await make(s.who, { priceMinor: 1000, currency: 'mxn' })).status).toBe(200);
    expect((await make(s.who, { priceMinor: 30, currency: 'gbp' })).body.code).toBe('BAD_PRICE');
    const other = await h.user('other-files@example.com');
    const theirs = await productFile(other);
    expect((await make(s.who, { delivery: { kind: 'file', fileId: theirs } })).body.code).toBe('BAD_DELIVERY');
    const magnet = await productFile(s.who, { purpose: 'magnet' });
    expect((await make(s.who, { delivery: { kind: 'file', fileId: magnet } })).body.code).toBe('BAD_DELIVERY');
    expect((await make(s.who, { delivery: { kind: 'zip' } })).body.code).toBe('BAD_DELIVERY');
    const mine = await productFile(s.who);
    const ok = await make(s.who, { delivery: { kind: 'file', fileId: mine } });
    expect(ok.body.offer.delivery).toEqual({ kind: 'file', fileId: mine });
  });

  it('needs a Stripe account (409) and a plan (402); one still onboarding says so (problem stripe_setup)', async () => {
    const none = await h.user('no-stripe@example.com');
    expect((await make(none)).body.code).toBe('STRIPE_NOT_CONNECTED');
    const unpaid = await h.stripeSeller('unpaid-offers@example.com');
    billing.plans.set(unpaid.who.id, null);
    expect((await make(unpaid.who)).status).toBe(402);
    const early = await h.stripeSeller('early-offers@example.com', { enable: false });
    const o = await make(early.who);
    expect(o.status).toBe(200);
    expect(o.body.offer.problem).toBe('stripe_setup');
    const list = await h.call(early.who, 'GET', '/api/offers?projectId=p1');
    expect(list.body.offers[0].problem).toBe('stripe_setup');
  });

  it('PATCH: title, price, currency and delivery; pause, and resume only on a connected account; DELETE without sales', async () => {
    const seller = await h.stripeSeller('patch-offers@example.com');
    const o = (await make(seller.who)).body.offer;
    const p = await h.call(seller.who, 'PATCH', `/api/offers/${o.id}`, { title: 'Wheel class', priceMinor: 999, currency: 'eur' });
    expect(p.body.offer).toMatchObject({ title: 'Wheel class', priceMinor: 999, currency: 'eur', priceDisplay: '€9.99' });
    expect((await h.call(seller.who, 'PATCH', `/api/offers/${o.id}`, { priceMinor: 1 })).body.code).toBe('BAD_PRICE');
    expect((await h.call(seller.who, 'PATCH', `/api/offers/${o.id}`, { url: 'https://evil.example' })).status).toBe(400);
    expect((await h.call(seller.who, 'PATCH', `/api/offers/${o.id}`, { status: 'paused' })).body.offer.status).toBe('paused');
    await h.call(seller.who, 'DELETE', '/api/payments/stripe?confirm=1');
    expect((await h.call(seller.who, 'PATCH', `/api/offers/${o.id}`, { status: 'active' })).body.code).toBe('NOT_SELLABLE');
    expect((await h.call(seller.who, 'DELETE', `/api/offers/${o.id}`)).body).toEqual({ ok: true });
    expect(h.rows('offers').some((x) => x.id === o.id)).toBe(false);
  });
});
