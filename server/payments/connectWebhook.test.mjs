// The Connect webhook (server/payments/connectWebhook.mjs, spec S7) and our fee back after refunds and lost disputes
// (feeReturn): signatures on the raw body with the Connect secret only, livemode, dedupe, 500 with no delivery row on a
// failure, re-reads from Stripe, sales by event, and the one-shot fee refunds with their hourly read-back. Plus our fee
// events on the P1 endpoint. Against mock-stripe and mock-supabase only.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { offersServer, testBilling } from '../offers/test-helpers.mjs';
import { signStripeHeader, TEST_STRIPE_CONNECT_WEBHOOK_SECRET, TEST_STRIPE_WEBHOOK_SECRET } from '../test/mock-stripe.mjs';
import { createStripeBilling } from '../billing/stripe.mjs';
import { readRaw } from '../integrations/common.mjs';

const HOOK = '/api/webhooks/stripe-connect';
const FEE_REFUND = 'POST /v1/application_fees/:id/refunds';

describe('the Connect webhook and our fee back', () => {
  let h;
  let s;
  let offer;
  let ip = 0;
  beforeAll(async () => {
    h = await offersServer({ stripe: true, billing: testBilling() });
    s = await h.stripeSeller('hooks@example.com');
    offer = (await h.call(s.who, 'POST', '/api/offers', { projectId: 'p1', provider: 'stripe', title: 'Course', priceMinor: 4900, currency: 'usd', clientRequestId: crypto.randomUUID() })).body.offer;
  });
  afterAll(() => h.close());
  const post = (raw, header) => fetch(`${h.base}${HOOK}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const hook = (mock) => h.stripe.signed(mock.type, mock.object, { account: mock.account ?? s.accountId, ...(mock.secret ? { secret: mock.secret } : {}), ...(mock.livemode !== undefined ? { livemode: mock.livemode } : {}) });
  /** A buyer pays: the session id, its charge and our fee (the mock delivers the Connect events here). */
  async function pay({ async = false } = {}) {
    const r = await h.visit(`/b/${offer.id}`, { headers: { 'x-test-ip': `100.64.0.${(ip++ % 200) + 1}` } });
    const sid = r.headers.get('location').split('/__pay/')[1];
    const done = await (await fetch(`${h.stripe.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id: sid, account: s.accountId, async, email: 'payer@example.com' }) })).json();
    return { sid, charge: done.charge };
  }
  const saleOf = (sid) => h.rows('sales').find((x) => x.checkout_session_id === sid);
  const saleByPi = (pi) => h.rows('sales').find((x) => x.provider_payment_id === pi);
  const delivered = (type) => h.stripe.deliveries.filter((d) => d.connect && d.event.type === type).at(-1);

  it('refuses a bad signature, the platform’s secret and a stale one; ignores the other mode and events with no account', async () => {
    const e = hook({ type: 'account.updated', object: { id: s.accountId } });
    expect((await post(e.raw, 'garbage')).status).toBe(400);
    expect((await post(e.raw, signStripeHeader(e.raw, TEST_STRIPE_WEBHOOK_SECRET))).status).toBe(400);
    expect((await post(e.raw, signStripeHeader(e.raw, TEST_STRIPE_CONNECT_WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600))).status).toBe(400);
    expect((await post(e.raw.replace('account.updated', 'account.updatee'), e.header)).status).toBe(400);
    const live = hook({ type: 'account.updated', object: { id: s.accountId }, livemode: true });
    expect((await post(live.raw, live.header)).body).toEqual({ ok: true, ignored: true });
    const none = h.stripe.signed('account.updated', { id: 'x' }, { secret: TEST_STRIPE_CONNECT_WEBHOOK_SECRET });
    expect((await post(none.raw, none.header)).body).toEqual({ ok: true, ignored: true });
    expect((await post(e.raw, e.header)).body).toEqual({ ok: true });
    // the same event again: once
    expect((await post(e.raw, e.header)).body).toEqual({ ok: true, duplicate: true });
  });

  it('an unknown account is ignored (no alert); a processing error answers 500 with no delivery row, and works delivered again', async () => {
    const unknown = hook({ type: 'account.updated', object: { id: 'acct_nobody0000' }, account: 'acct_nobody0000' });
    expect((await post(unknown.raw, unknown.header)).status).toBe(200);
    expect(h.logs.some((l) => l.includes('connect_unknown_account'))).toBe(true);
    const e = hook({ type: 'account.updated', object: { id: s.accountId } });
    h.stripe.fail('GET /v1/accounts/:id', 'server', 2);
    expect((await post(e.raw, e.header)).status).toBe(500);
    expect(h.rows('webhook_deliveries').some((d) => d.body_hash === `stripe-connect:${e.event.id}`)).toBe(false);
    expect((await post(e.raw, e.header)).status).toBe(200);
    expect(h.rows('webhook_deliveries').some((d) => d.body_hash === `stripe-connect:${e.event.id}`)).toBe(true);
  });

  it('checkout.session.completed (from Stripe, signed with the Connect secret): a paid sale with our fee fields', async () => {
    const { sid, charge } = await pay();
    expect(delivered('checkout.session.completed').status).toBe(200);
    expect(saleOf(sid)).toMatchObject({ status: 'paid', amount_minor: 4900, application_fee_minor: 147, application_fee_id: charge.application_fee, fee_pct: 3, fee_tier: 'launch', buyer_email: 'payer@example.com', provider_account: s.accountId, environment: 'sandbox' });
  });

  it('async payments: pending, then paid (or failed)', async () => {
    const a = await pay({ async: true });
    expect(saleOf(a.sid).status).toBe('pending');
    await fetch(`${h.stripe.base}/__checkout/async`, { method: 'POST', body: JSON.stringify({ id: a.sid, account: s.accountId, succeeded: true }) });
    expect(saleOf(a.sid).status).toBe('paid');
    const b = await pay({ async: true });
    await fetch(`${h.stripe.base}/__checkout/async`, { method: 'POST', body: JSON.stringify({ id: b.sid, account: s.accountId, succeeded: false }) });
    expect(saleOf(b.sid).status).toBe('failed');
  });

  it('an offer of another account (or user): an owner alert, no sale', async () => {
    const other = await h.stripeSeller('hooks-other@example.com');
    const theirs = (await h.call(other.who, 'POST', '/api/offers', { projectId: 'p1', provider: 'stripe', title: 'X', priceMinor: 999, currency: 'usd', clientRequestId: crypto.randomUUID() })).body.offer;
    // a session on s's account that names the other seller's offer
    const made = await fetch(`${h.stripe.apiBase}/v1/checkout/sessions`, { method: 'POST', headers: { authorization: `Bearer ${h.env.STRIPE_SECRET_KEY}`, 'stripe-account': s.accountId, 'idempotency-key': `test-${crypto.randomUUID()}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ mode: 'payment', success_url: 'https://x/y', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': '999', 'line_items[0][price_data][product_data][name]': 'X', 'line_items[0][quantity]': '1', 'metadata[ylb_offer]': theirs.id, client_reference_id: theirs.id }).toString() }).then((r) => r.json());
    await fetch(`${h.stripe.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id: made.id, account: s.accountId }) });
    expect(saleOf(made.id)).toBeUndefined();
    await vi.waitFor(() => expect(h.rows('connect_alerts').some((a) => a.kind === 'account_mismatch')).toBe(true));
  });

  it('refunds: two partial refunds add up (sale_refunds rows), a full one is refunded; our fee goes back in proportion, once per refund', async () => {
    const { sid, charge } = await pay();
    const writes = h.stripe.writes(FEE_REFUND).length;
    await fetch(`${h.stripe.base}/__charges/refund`, { method: 'POST', body: JSON.stringify({ charge: charge.id, account: s.accountId, amount: 1000 }) });
    expect(saleOf(sid)).toMatchObject({ status: 'partially_refunded', refunded_minor: 1000, fee_returned_minor: 30 });
    await fetch(`${h.stripe.base}/__charges/refund`, { method: 'POST', body: JSON.stringify({ charge: charge.id, account: s.accountId, amount: 900 }) });
    expect(saleOf(sid)).toMatchObject({ status: 'partially_refunded', refunded_minor: 1900, fee_returned_minor: 30 + 27 });
    expect(h.rows('sale_refunds').filter((r) => r.provider_payment_id === saleOf(sid).provider_payment_id)).toHaveLength(2);
    const sent = h.stripe.writes(FEE_REFUND).slice(writes);
    expect(sent).toHaveLength(2);
    for (const w of sent) {
      expect(w.idempotencyKey).toMatch(/^ylb-fee-return:sandbox:re_/);
      expect(w.body.metadata.ylb_source).toMatch(/^re_/);
      expect(w.account).toBeNull();
    }
    // the same refund event again changes nothing (one write per refund)
    const again = delivered('charge.refunded');
    expect((await post(again.raw, signStripeHeader(again.raw, TEST_STRIPE_CONNECT_WEBHOOK_SECRET))).status).toBe(200);
    const e2 = hook({ type: 'charge.refunded', object: { id: charge.id } });
    await post(e2.raw, e2.header);
    expect(h.stripe.writes(FEE_REFUND).length).toBe(writes + 2);
    await fetch(`${h.stripe.base}/__charges/refund`, { method: 'POST', body: JSON.stringify({ charge: charge.id, account: s.accountId }) });
    expect(saleOf(sid)).toMatchObject({ status: 'refunded', refunded_minor: 4900, fee_returned_minor: 147 });
    expect(h.rows('connect_fee_returns').filter((r) => r.sale_id === saleOf(sid).id).every((r) => r.state === 'ok')).toBe(true);
  });

  it('a refund that arrives before the payment’s own event still ends right', async () => {
    const { sid, charge } = await pay();
    // drop what the webhook wrote, as if checkout.session.completed hadn't come yet
    h.supa.tables.set('sales', h.rows('sales').filter((x) => x.checkout_session_id !== sid));
    await fetch(`${h.stripe.base}/__charges/refund`, { method: 'POST', body: JSON.stringify({ charge: charge.id, account: s.accountId, amount: 4900 }) });
    const pi = h.stripe.realm(s.accountId).charges.get(charge.id).payment_intent;
    expect(saleByPi(pi)).toMatchObject({ status: 'refunded', refunded_minor: 4900, amount_minor: 4900, offer_id: offer.id });
    // the late completed event fills in the session and keeps refunded
    const late = delivered('checkout.session.completed');
    const replay = h.stripe.signed('checkout.session.completed', { id: sid }, { account: s.accountId });
    await post(replay.raw, replay.header);
    expect(saleByPi(pi)).toMatchObject({ status: 'refunded', checkout_session_id: sid });
    expect(late).toBeTruthy();
  });

  it('disputes: created then won keeps "disputed" with dispute_status won; lost returns our fee once', async () => {
    const won = await pay();
    const d1 = await (await fetch(`${h.stripe.base}/__charges/dispute`, { method: 'POST', body: JSON.stringify({ charge: won.charge.id, account: s.accountId }) })).json();
    expect(saleOf(won.sid)).toMatchObject({ status: 'disputed', dispute_status: 'needs_response', dispute_amount_minor: 4900 });
    await fetch(`${h.stripe.base}/__disputes/close`, { method: 'POST', body: JSON.stringify({ id: d1.id, account: s.accountId, status: 'won' }) });
    expect(saleOf(won.sid)).toMatchObject({ status: 'disputed', dispute_status: 'won', fee_returned_minor: 0 });
    const lost = await pay();
    const writes = h.stripe.writes(FEE_REFUND).length;
    const d2 = await (await fetch(`${h.stripe.base}/__charges/dispute`, { method: 'POST', body: JSON.stringify({ charge: lost.charge.id, account: s.accountId }) })).json();
    await fetch(`${h.stripe.base}/__disputes/close`, { method: 'POST', body: JSON.stringify({ id: d2.id, account: s.accountId, status: 'lost' }) });
    expect(saleOf(lost.sid)).toMatchObject({ status: 'disputed', dispute_status: 'lost', fee_returned_minor: 147 });
    expect(h.stripe.writes(FEE_REFUND).length).toBe(writes + 1);
    expect(h.rows('connect_fee_returns').find((r) => r.source_id === d2.id)).toMatchObject({ state: 'ok', amount_minor: 147 });
  });

  it('a fee return that times out is read back by the hourly job: never a second POST', async () => {
    const { sid, charge } = await pay();
    h.stripe.fail(FEE_REFUND, 'timeout');
    const writes = h.stripe.writes(FEE_REFUND).length;
    await fetch(`${h.stripe.base}/__charges/refund`, { method: 'POST', body: JSON.stringify({ charge: charge.id, account: s.accountId, amount: 4900 }) });
    const ret = h.rows('connect_fee_returns').find((r) => r.sale_id === saleOf(sid).id);
    expect(ret.state).toBe('unknown');
    expect(saleOf(sid).fee_returned_minor).toBe(0);
    const out = await h.offers.connectHooks.cronFees();
    expect(out.resolved).toBeGreaterThanOrEqual(1);
    expect(h.rows('connect_fee_returns').find((r) => r.source_id === ret.source_id)).toMatchObject({ state: 'ok', fee_refund_id: expect.stringMatching(/^fr_/) });
    expect(saleOf(sid).fee_returned_minor).toBe(147);
    expect(h.stripe.writes(FEE_REFUND).length).toBe(writes + 1);
  });

  it('a refused fee return is "failed" with an owner alert; with no fee known yet it waits ("skipped") and the hourly job sends it once', async () => {
    const a = await pay();
    h.stripe.fail(FEE_REFUND, 'permission');
    await fetch(`${h.stripe.base}/__charges/refund`, { method: 'POST', body: JSON.stringify({ charge: a.charge.id, account: s.accountId, amount: 100 }) });
    expect(h.rows('connect_fee_returns').find((r) => r.sale_id === saleOf(a.sid).id).state).toBe('failed');
    await vi.waitFor(() => expect(h.rows('connect_alerts').some((x) => x.kind === 'fee_return_failed')).toBe(true));
    const b = await pay();
    saleOf(b.sid).application_fee_id = null;
    const writes = h.stripe.writes(FEE_REFUND).length;
    await fetch(`${h.stripe.base}/__charges/refund`, { method: 'POST', body: JSON.stringify({ charge: b.charge.id, account: s.accountId, amount: 4900 }) });
    // the sale doesn't know its fee's id yet: the return waits, nothing is sent
    const ret = h.rows('connect_fee_returns').find((r) => r.sale_id === saleOf(b.sid).id);
    expect(ret.state).toBe('skipped');
    expect(h.stripe.writes(FEE_REFUND).length).toBe(writes);
    await h.offers.connectHooks.cronFees();
    expect(h.rows('connect_fee_returns').find((r) => r.source_id === ret.source_id).state).toBe('ok');
    expect(h.stripe.writes(FEE_REFUND).length).toBe(writes + 1);
    await h.offers.connectHooks.cronFees();
    expect(h.stripe.writes(FEE_REFUND).length).toBe(writes + 1);
  });

  it('account.updated re-reads the account and drops the buy cache; deauthorized stops selling', async () => {
    const seller = await h.stripeSeller('hooks-acct@example.com');
    const o = (await h.call(seller.who, 'POST', '/api/offers', { projectId: 'p1', provider: 'stripe', title: 'Y', priceMinor: 999, currency: 'usd', clientRequestId: crypto.randomUUID() })).body.offer;
    expect((await h.visit(`/b/${o.id}`, { headers: { 'x-test-ip': '100.64.9.1' } })).status).toBe(303);
    await fetch(`${h.stripe.base}/__accounts/requirements`, { method: 'POST', body: JSON.stringify({ id: seller.accountId, charges_enabled: false, past_due: ['external_account'] }) });
    expect(h.rows('connect_accounts').find((r) => r.id === seller.row.id)).toMatchObject({ status: 'restricted', charges_enabled: false });
    expect((await h.visit(`/b/${o.id}`, { headers: { 'x-test-ip': '100.64.9.2' } })).status).toBe(503);
    await fetch(`${h.stripe.base}/__accounts/deauthorize`, { method: 'POST', body: JSON.stringify({ id: seller.accountId }) });
    expect(h.rows('connect_accounts').find((r) => r.id === seller.row.id).status).toBe('disconnected');
    expect(h.rows('offers').find((x) => x.id === o.id).status).toBe('paused');
  });

  it('CONNECT_RETURN_FEES=off keeps our fee (no write)', async () => {
    const off = await offersServer({ stripe: true, billing: testBilling(), env: { CONNECT_RETURN_FEES: 'off' } });
    try {
      const seller = await off.stripeSeller('nofees@example.com');
      const o = (await off.call(seller.who, 'POST', '/api/offers', { projectId: 'p1', provider: 'stripe', title: 'Z', priceMinor: 4900, currency: 'usd', clientRequestId: crypto.randomUUID() })).body.offer;
      const sid = (await off.visit(`/b/${o.id}`)).headers.get('location').split('/__pay/')[1];
      const done = await (await fetch(`${off.stripe.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id: sid, account: seller.accountId }) })).json();
      await fetch(`${off.stripe.base}/__charges/refund`, { method: 'POST', body: JSON.stringify({ charge: done.charge.id, account: seller.accountId }) });
      expect(off.rows('sales').find((x) => x.checkout_session_id === sid)).toMatchObject({ status: 'refunded', fee_returned_minor: 0 });
      expect(off.stripe.writes(FEE_REFUND)).toHaveLength(0);
    } finally {
      await off.close();
    }
  });

  it('the read-only reconcile records a completed session whose webhook was lost', async () => {
    h.stripe.connectWebhookUrl = '';
    const { sid } = await pay();
    h.stripe.connectWebhookUrl = `${h.base}${HOOK}`;
    expect(saleOf(sid)).toBeUndefined();
    const writes = h.stripe.writes().length;
    const out = await h.offers.connectHooks.cronReconcile();
    expect(out.recorded).toBeGreaterThanOrEqual(1);
    expect(saleOf(sid)).toMatchObject({ status: 'paid' });
    expect(h.stripe.writes().length).toBe(writes);
  });

  it('rules: every Stripe write had an Idempotency-Key; no key, secret or session id in any log line', () => {
    const writes = h.stripe.writes();
    expect(writes.length).toBeGreaterThan(10);
    for (const w of writes) expect(w.idempotencyKey, w.route).toBeTruthy();
    const logs = h.logs.join('\n');
    expect(logs).not.toMatch(/sk_(test|live)_/);
    expect(logs).not.toMatch(/whsec_/);
    expect(logs).not.toMatch(/cs_(test|live)_[A-Za-z0-9]{6,}/);
    expect(logs).not.toContain('payer@example.com');
  });

  describe('our fee events on the P1 endpoint', () => {
    let plans;
    const p1 = (raw, header) => {
      const req = Readable.from([Buffer.from(raw)]);
      req.headers = { 'stripe-signature': header };
      req.socket = { remoteAddress: '127.0.0.1' };
      return plans.webhook(req);
    };
    beforeAll(() => {
      plans = createStripeBilling({ db: h.db, env: { ...h.env, STRIPE_WEBHOOK_SECRET: TEST_STRIPE_WEBHOOK_SECRET }, readRaw, log: { log() {}, warn() {} } });
      plans.setPlatformEventHandler((evt) => h.offers.connectPlatformEvent(evt));
    });

    it('application_fee.created fills in a sale’s fee id; a fee with no sale yet is fine', async () => {
      const { sid, charge } = await pay();
      const feeId = charge.application_fee;
      saleOf(sid).application_fee_id = null;
      const e = h.stripe.signed('application_fee.created', { id: feeId });
      expect(await p1(e.raw, e.header)).toMatchObject({ status: 200 });
      expect(saleOf(sid).application_fee_id).toBe(feeId);
      h.supa.tables.set('sales', h.rows('sales').filter((x) => x.checkout_session_id !== sid));
      const again = h.stripe.signed('application_fee.created', { id: feeId });
      expect(await p1(again.raw, again.header)).toMatchObject({ status: 200 });
    });

    it('each endpoint refuses the other’s secret', async () => {
      const e = h.stripe.signed('application_fee.created', { id: 'fee_x' }, { secret: TEST_STRIPE_CONNECT_WEBHOOK_SECRET });
      expect((await p1(e.raw, e.header)).status).toBe(400);
      const c = h.stripe.signed('account.updated', { id: s.accountId }, { account: s.accountId, secret: TEST_STRIPE_WEBHOOK_SECRET });
      expect((await post(c.raw, c.header)).status).toBe(400);
    });
  });
});
