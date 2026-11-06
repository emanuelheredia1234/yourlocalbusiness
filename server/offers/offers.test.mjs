// Offers (spec tests 2, 4, 7, 8, 9): the API, the Whop webhook from the mock's deliveries, no auto-retry, account
// deletion and the cron jobs.
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { offersServer } from './test-helpers.mjs';
import { signWhopPayload } from '../payments/whopWebhook.mjs';
import { createPaymentCrypto } from './store.mjs';
import { PAYMENT_SECRET } from './test-helpers.mjs';

const uuid = () => crypto.randomUUID();
const checkoutOf = (h, offerId) => h.rows('offers').find((o) => o.id === offerId).provider_ref.checkoutId;

describe('/api/offers', () => {
  let h;
  let plan = 'active';
  beforeAll(async () => {
    h = await offersServer({
      billing: {
        requireActive: async () => {
          if (plan !== 'active') throw Object.assign(new Error('Your plan is paused.'), { status: 402, code: 'PLAN_REQUIRED', extra: { need: { feature: 'publish' } } });
        },
        pagesServeUntil: async () => null,
      },
    });
  });
  afterAll(() => h.close());

  it('refuses cross-site and signed-out requests', async () => {
    expect((await h.call(null, 'GET', '/api/offers?projectId=p1')).status).toBe(401);
    const cross = await offersServer({ sameOrigin: () => false });
    try {
      const who = await cross.user('cross@example.com');
      for (const [m, p] of [['GET', '/api/offers?projectId=p1'], ['POST', '/api/offers'], ['POST', '/api/payments/whop']]) expect((await cross.call(who, m, p, m === 'POST' ? {} : undefined)).status).toBe(403);
    } finally {
      await cross.close();
    }
  });

  it('makes an outside-link offer and lists it; edits, pauses, archives and deletes', async () => {
    const who = await h.user('ext@example.com');
    const made = await h.call(who, 'POST', '/api/offers', { projectId: 'p1', title: 'Consult', provider: 'external', url: 'https://buy.stripe.com/test_abc', priceDisplay: '$99' });
    expect(made.status).toBe(200);
    expect(made.body.offer).toMatchObject({ provider: 'external', title: 'Consult', priceDisplay: '$99', checkoutHost: 'buy.stripe.com', status: 'active', link: `https://app.example.test/b/${made.body.offer.id}` });
    const id = made.body.offer.id;
    expect((await h.call(who, 'GET', '/api/offers?projectId=p1')).body.offers.map((o) => o.id)).toEqual([id]);
    expect((await h.call(who, 'PATCH', `/api/offers/${id}`, { title: 'Consultation', url: 'https://gumroad.com/l/x' })).body.offer).toMatchObject({ title: 'Consultation', checkoutHost: 'gumroad.com' });
    expect((await h.call(who, 'PATCH', `/api/offers/${id}`, { url: 'javascript:alert(1)' })).body.code).toBe('BAD_URL');
    expect((await h.call(who, 'PATCH', `/api/offers/${id}`, { status: 'paused' })).body.offer.status).toBe('paused');
    expect((await h.call(who, 'POST', `/api/offers/${id}/archive`)).body.offer.status).toBe('archived');
    expect((await h.call(who, 'GET', '/api/offers?projectId=p1')).body.offers).toEqual([]);
    expect((await h.call(who, 'GET', '/api/offers?projectId=p1&archived=1')).body.offers).toHaveLength(1);
    expect((await h.call(who, 'DELETE', `/api/offers/${id}`)).body).toEqual({ ok: true });
    expect((await h.call(who, 'DELETE', `/api/offers/${id}`)).body).toEqual({ ok: true });
    expect((await h.call(who, 'POST', '/api/offers', { projectId: 'p1', title: 'x', provider: 'stripe' })).status).toBe(400);
  });

  it('writes need a plan; reading, pausing, archiving and deleting don’t', async () => {
    const who = await h.user('plan@example.com');
    const made = await h.call(who, 'POST', '/api/offers', { projectId: 'p1', title: 'A', provider: 'external', url: 'https://gumroad.com/l/a' });
    plan = 'paused';
    try {
      const refused = await h.call(who, 'POST', '/api/offers', { projectId: 'p1', title: 'B', provider: 'external', url: 'https://gumroad.com/l/b' });
      expect(refused.status).toBe(402);
      expect(refused.body).toMatchObject({ code: 'PLAN_REQUIRED', upgrade: '#plans' });
      expect((await h.call(who, 'PATCH', `/api/offers/${made.body.offer.id}`, { title: 'C' })).status).toBe(402);
      expect((await h.call(who, 'POST', '/api/payments/whop', { environment: 'production', accountId: 'biz_abcd1234', key: 'k'.repeat(30) })).status).toBe(402);
      expect((await h.call(who, 'GET', '/api/offers?projectId=p1')).status).toBe(200);
      expect((await h.call(who, 'PATCH', `/api/offers/${made.body.offer.id}`, { status: 'paused' })).status).toBe(200);
      expect((await h.call(who, 'POST', `/api/offers/${made.body.offer.id}/archive`)).status).toBe(200);
      expect((await h.call(who, 'DELETE', `/api/offers/${made.body.offer.id}`)).status).toBe(200);
    } finally {
      plan = 'active';
    }
  });

  it('keeps users apart: another user’s offer is "not found" everywhere', async () => {
    const a = await h.user('a@example.com');
    const b = await h.user('b@example.com');
    const made = await h.call(a, 'POST', '/api/offers', { projectId: 'p1', title: 'Mine', provider: 'external', url: 'https://gumroad.com/l/mine' });
    const id = made.body.offer.id;
    expect((await h.call(b, 'PATCH', `/api/offers/${id}`, { title: 'Theirs' })).status).toBe(404);
    expect((await h.call(b, 'POST', `/api/offers/${id}/archive`)).status).toBe(404);
    expect((await h.call(b, 'POST', `/api/offers/${id}/check`)).status).toBe(404);
    await h.call(b, 'DELETE', `/api/offers/${id}`);
    expect(h.rows('offers').find((o) => o.id === id)).toBeTruthy();
    expect((await h.call(b, 'GET', '/api/offers?projectId=p1')).body.offers).toEqual([]);
    expect((await h.call(b, 'GET', '/api/offers/sales?projectId=p1')).body.sales).toEqual([]);
  });

  it('a Whop offer: the plan read, one checkout link, a double click is the same row and the same call', async () => {
    const s = await h.seller('whop@example.com', { price: 49 });
    const crid = uuid();
    const [one, two] = await Promise.all([h.whopOffer(s, { clientRequestId: crid }), h.whopOffer(s, { clientRequestId: crid })]);
    // one of them made the link; the other answered the same row (made, or still being made)
    expect([one.status, two.status]).toContain(200);
    expect([200, 202]).toContain(one.status);
    expect([200, 202]).toContain(two.status);
    expect(one.body.offer.id).toBe(two.body.offer.id);
    const offer = h.rows('offers').find((o) => o.id === one.body.offer.id);
    expect(offer).toMatchObject({ status: 'active', provider: 'whop', price_display: '$49', price_minor: 4900, currency: 'usd', title: 'Pottery course' });
    expect(offer.provider_ref.purchaseUrl).toBe(`https://whop.com/checkout/${offer.provider_ref.checkoutId}/`);
    const posts = s.mock.writes('POST /checkout_configurations').filter((c) => c.idempotencyKey === `ylb-offer-${offer.id}`);
    expect(posts.length).toBe(1);
    const sent = [...s.mock.checkouts.values()].find((c) => c.id === offer.provider_ref.checkoutId);
    expect(sent.metadata).toEqual({ ylb_offer: offer.id, ylb_env: 'production' });
    expect(sent.redirect_url).toBe(`https://app.example.test/b/${offer.id}/done`);
    const again = await h.whopOffer(s, { clientRequestId: crid });
    expect(again.body.offer.id).toBe(offer.id);
    expect(s.mock.writes('POST /checkout_configurations').filter((c) => c.idempotencyKey === `ylb-offer-${offer.id}`).length).toBe(1);
    expect(JSON.stringify(again.body)).not.toContain('checkout/ch_');
  });

  it('unknown outcome: 202 checkout_unknown, then "Check again" replays the same key; after 24 h it’s too late', async () => {
    const s = await h.seller('unknown-offer@example.com');
    s.mock.fail('POST /checkout_configurations', { timeout: true });
    const first = await h.whopOffer(s);
    expect(first.status).toBe(202);
    expect(first.body.offer.status).toBe('checkout_unknown');
    const id = first.body.offer.id;
    const check = await h.call(s.who, 'POST', `/api/offers/${id}/check`);
    expect(check.status).toBe(200);
    expect(check.body.offer.status).toBe('active');
    const keys = s.mock.writes('POST /checkout_configurations').map((c) => c.idempotencyKey).filter((k) => k === `ylb-offer-${id}`);
    expect(keys).toEqual([`ylb-offer-${id}`, `ylb-offer-${id}`]);
    // Whop made one configuration: the replay answered the first
    expect([...s.mock.checkouts.values()].filter((c) => c.metadata?.ylb_offer === id)).toHaveLength(1);
    s.mock.fail('POST /checkout_configurations', { status: 503 });
    const late = await h.whopOffer(s);
    expect(late.body.offer.status).toBe('checkout_unknown');
    h.advance(25 * 3_600_000);
    try {
      const expired = await h.call(s.who, 'POST', `/api/offers/${late.body.offer.id}/check`);
      expect(expired.status).toBe(409);
      expect(expired.body.code).toBe('CHECKOUT_EXPIRED');
    } finally {
      h.advance(-25 * 3_600_000);
    }
  });

  it('a checkout link Whop answers on another host, scheme, port or with a user name is never stored', async () => {
    const s = await h.seller('tamper@example.com');
    for (const bad of ['https://evil.com/checkout/ch_abc123/', 'https://whop.com.evil.com/checkout/ch_abc123/', 'http://whop.com/checkout/ch_abc123/', 'https://whop.com:8443/checkout/ch_abc123/', 'https://u:p@whop.com/checkout/ch_abc123/', 'https://sandbox.whop.com/checkout/ch_abc123/', 'https://whop.com/elsewhere/ch_abc123/']) {
      s.mock.setPurchaseUrl(bad);
      const r = await h.whopOffer(s);
      expect(r.status, bad).toBe(202);
      expect(r.body.offer.status).toBe('checkout_unknown');
      const row = h.rows('offers').find((o) => o.id === r.body.offer.id);
      expect(row.provider_ref.purchaseUrl, bad).toBeUndefined();
    }
  });

  it('a refused checkout deletes the draft; a gone plan; the 100-offer cap', async () => {
    const s = await h.seller('refused@example.com');
    s.mock.fail('POST /checkout_configurations', { status: 422 });
    const refused = await h.whopOffer(s);
    expect(refused.body.code).toBe('WHOP_REFUSED');
    expect(h.rows('offers').filter((o) => o.user_id === s.who.id)).toHaveLength(0);
    const gone = await h.whopOffer(s, { variantId: 'plan_nothere123' });
    expect(gone.body.code).toBe('WHOP_PLAN_GONE');
    const who = await h.user('cap@example.com');
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `c${String(i).padStart(21, '0')}`, user_id: who.id, project_id: 'p1', title: 't', provider: 'external', provider_ref: { url: 'https://gumroad.com/l/x' }, status: 'active' }));
    await h.db.insert('offers', rows);
    const over = await h.call(who, 'POST', '/api/offers', { projectId: 'p1', title: 'One more', provider: 'external', url: 'https://gumroad.com/l/y' });
    expect(over.body.code).toBe('TOO_MANY');
  });

  it('an offer with sales can’t be deleted; the summary counts live sales and keeps test ones apart', async () => {
    const s = await h.seller('sales@example.com', { price: 20 });
    const offer = (await h.whopOffer(s)).body.offer;
    await s.mock.pay({ checkoutId: checkoutOf(h, offer.id) });
    await s.mock.pay({ checkoutId: checkoutOf(h, offer.id) });
    expect((await h.call(s.who, 'DELETE', `/api/offers/${offer.id}`)).body.code).toBe('HAS_SALES');
    const t = await h.seller('sales-test@example.com', { environment: 'sandbox', price: 5 });
    const tOffer = (await h.whopOffer(t)).body.offer;
    expect(tOffer.environment).toBe('sandbox');
    await t.mock.pay({ checkoutId: checkoutOf(h, tOffer.id) });
    const sum = await h.call(s.who, 'GET', '/api/offers/summary?projectId=p1&days=30');
    expect(sum.body).toMatchObject({ live: { count: 2, revenue: { usd: 4000 } }, test: { count: 0 } });
    const tsum = await h.call(t.who, 'GET', '/api/offers/summary?projectId=p1');
    expect(tsum.body).toMatchObject({ live: { count: 0 }, test: { count: 1 } });
    const list = await h.call(s.who, 'GET', '/api/offers?projectId=p1');
    expect(list.body.offers[0].sales.count).toBe(2);
    const sales = await h.call(s.who, 'GET', '/api/offers/sales?projectId=p1&limit=1');
    expect(sales.body.sales).toHaveLength(1);
    expect(sales.body.next).toBeTruthy();
    expect((await h.call(t.who, 'GET', '/api/offers/sales?projectId=p1&env=sandbox')).body.sales).toHaveLength(1);
  });
});

describe('the Whop webhook', () => {
  let h;
  beforeAll(async () => {
    h = await offersServer();
  });
  afterAll(() => h.close());
  const salesOf = (s) => h.rows('sales').filter((r) => r.user_id === s.who.id);

  it('records a sale once across redeliveries; an older failure doesn’t undo it', async () => {
    const s = await h.seller('hook@example.com', { price: 49 });
    const offer = (await h.whopOffer(s)).body.offer;
    const paid = await s.mock.pay({ checkoutId: checkoutOf(h, offer.id), email: 'Buyer@Example.com' });
    expect(paid.deliveries[0].status).toBe(200);
    await s.mock.deliver(paid.event.id);
    await s.mock.deliver(paid.event.id);
    await s.mock.deliver(paid.event.id);
    expect(salesOf(s)).toHaveLength(1);
    expect(salesOf(s)[0]).toMatchObject({ status: 'paid', amount_minor: 4900, net_minor: 4606, currency: 'usd', buyer_email: 'buyer@example.com', offer_id: offer.id, project_id: 'p1', environment: 'production', provider_account: s.accountId });
    expect(h.rows('webhook_deliveries').filter((d) => d.body_hash === `whop:${s.connection.id}:${paid.event.id}`)).toHaveLength(1);
    const conn = h.rows('payment_connections').find((c) => c.id === s.connection.id);
    expect(conn.last_event_at).toBeTruthy();
  });

  it('a refund before its payment ends refunded; a dispute is shown; a refund of a stored sale', async () => {
    const s = await h.seller('order@example.com', { price: 30 });
    const offer = (await h.whopOffer(s)).body.offer;
    // the payment happens, Whop's first delivery is lost, the refund arrives first
    const paid = await s.mock.pay({ checkoutId: checkoutOf(h, offer.id), deliver: false });
    const refund = await s.mock.refund({ paymentId: paid.payment.id, full: true });
    expect(refund.deliveries[0].status).toBe(200);
    await s.mock.deliver(paid.event.id);
    expect(salesOf(s)).toHaveLength(1);
    expect(salesOf(s)[0]).toMatchObject({ status: 'refunded', refunded_minor: 3000 });
    const p2 = await s.mock.pay({ checkoutId: checkoutOf(h, offer.id) });
    await s.mock.refund({ paymentId: p2.payment.id, amount: 1000 });
    expect(salesOf(s).find((r) => r.provider_payment_id === p2.payment.id)).toMatchObject({ status: 'partially_refunded', refunded_minor: 1000 });
    await s.mock.dispute({ paymentId: p2.payment.id });
    expect(salesOf(s).find((r) => r.provider_payment_id === p2.payment.id).status).toBe('disputed');
  });

  it('keeps nothing that isn’t ours: no metadata, another user’s offer, another account’s event, another checkout', async () => {
    const s = await h.seller('strict@example.com');
    const other = await h.seller('other@example.com');
    const otherOffer = (await h.whopOffer(other)).body.offer;
    // a sale on the seller's own Whop with no offer of ours
    const ch = [...s.mock.checkouts.values()];
    expect(ch.filter((c) => c.account_id === s.accountId)).toHaveLength(0);
    const plain = await post(h, s, { type: 'payment.succeeded', account_id: s.accountId, data: payment(s.accountId, {}) });
    expect(plain.status).toBe(200);
    // another user's offer id in the metadata
    const foreign = await post(h, s, { type: 'payment.succeeded', account_id: s.accountId, data: payment(s.accountId, { ylb_offer: otherOffer.id, ylb_env: 'production' }) });
    expect(foreign.status).toBe(200);
    // the seller's offer, but another account in the envelope
    const mine = (await h.whopOffer(s)).body.offer;
    const misrouted = await post(h, s, { type: 'payment.succeeded', account_id: 'biz_someoneelse1', data: payment(s.accountId, { ylb_offer: mine.id, ylb_env: 'production' }) });
    expect(misrouted.body).toMatchObject({ ignored: true });
    // the right offer, another checkout configuration
    const wrongCh = await post(h, s, { type: 'payment.succeeded', account_id: s.accountId, data: payment(s.accountId, { ylb_offer: mine.id, ylb_env: 'production' }, 'ch_notours123') });
    expect(wrongCh.status).toBe(200);
    expect(salesOf(s)).toHaveLength(0);
    // the older company_id envelope is read
    const legacy = await post(h, s, { type: 'payment.succeeded', company_id: s.accountId, data: payment(s.accountId, { ylb_offer: mine.id, ylb_env: 'production' }, checkoutOf(h, mine.id)) });
    expect(legacy.status).toBe(200);
    expect(salesOf(s)).toHaveLength(1);
  });

  it('bad and stale signatures are refused before anything is read from the database', async () => {
    const s = await h.seller('sig@example.com');
    const offer = (await h.whopOffer(s)).body.offer;
    const paid = await s.mock.pay({ checkoutId: checkoutOf(h, offer.id), deliver: false });
    const before = h.supa.calls.length;
    const bad = await s.mock.deliver(paid.event.id, { sig: 'bad' });
    const stale = await s.mock.deliver(paid.event.id, { sig: 'stale' });
    expect(bad[0].status).toBe(400);
    expect(stale[0].status).toBe(400);
    // only the connection's own row was read
    const reads = h.supa.calls.slice(before).map((c) => c.path);
    expect(reads.every((p) => p === '/rest/v1/payment_connections')).toBe(true);
    expect(salesOf(s)).toHaveLength(0);
  });

  it('unknown connection 404, over 256 KB 413, not JSON 400, per-IP 429, GET 405', async () => {
    expect((await fetch(`${h.base}/api/webhooks/whop/${'A'.repeat(22)}`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(`${h.base}/api/webhooks/whop/short`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(`${h.base}/api/webhooks/whop/${'A'.repeat(22)}`)).status).toBe(405);
    const s = await h.seller('size@example.com');
    expect((await fetch(`${h.base}/api/webhooks/whop/${s.connection.id}`, { method: 'POST', body: 'x'.repeat(256 * 1024 + 1) })).status).toBe(413);
    const secret = webhookSecret(h, s);
    const raw = 'not json';
    const ts = String(Math.floor(Date.now() / 1000));
    const notJson = await fetch(`${h.base}/api/webhooks/whop/${s.connection.id}`, { method: 'POST', headers: { 'webhook-id': 'msg_x', 'webhook-timestamp': ts, 'webhook-signature': signWhopPayload(raw, 'msg_x', ts, secret) }, body: raw });
    expect(notJson.status).toBe(400);
    let last = 0;
    for (let i = 0; i < 601; i++) last = (await fetch(`${h.base}/api/webhooks/whop/${'B'.repeat(22)}`, { method: 'POST', headers: { 'x-test-ip': '203.0.113.9' }, body: '{}' })).status;
    expect(last).toBe(429);
  });

  it('a database that can’t answer: 500 (Whop retries) and nothing recorded; a failure while recording: no delivery row', async () => {
    const s = await h.seller('dbdown@example.com');
    const offer = (await h.whopOffer(s)).body.offer;
    const paid = await s.mock.pay({ checkoutId: checkoutOf(h, offer.id), deliver: false });
    h.supa.behavior.fail = (method, path) => (path === '/rest/v1/webhook_deliveries' && method === 'GET' ? { status: 503, body: { message: 'down' } } : null);
    expect((await s.mock.deliver(paid.event.id))[0].status).toBe(500);
    h.supa.behavior.fail = (method, path) => (path === '/rest/v1/rpc/record_sale' ? { status: 503, body: { message: 'down' } } : null);
    expect((await s.mock.deliver(paid.event.id))[0].status).toBe(500);
    h.supa.behavior.fail = null;
    expect(salesOf(s)).toHaveLength(0);
    expect(h.rows('webhook_deliveries').some((d) => d.body_hash.endsWith(paid.event.id))).toBe(false);
    expect((await s.mock.deliver(paid.event.id))[0].status).toBe(200);
    expect(salesOf(s)).toHaveLength(1);
  });

  it('no buyer email without Whop’s member:email:read', async () => {
    const s = await h.seller('noemail@example.com', { permissions: ['access_pass:basic:read', 'plan:basic:read', 'checkout_configuration:create', 'developer:manage_webhook'] });
    const offer = (await h.whopOffer(s)).body.offer;
    await s.mock.pay({ checkoutId: checkoutOf(h, offer.id) });
    expect(salesOf(s)[0]).toMatchObject({ status: 'paid', buyer_email: null });
  });
});

describe('no Whop write is ever sent twice by itself', () => {
  let h;
  beforeAll(async () => {
    h = await offersServer();
  });
  afterAll(() => h.close());

  it('POST/PATCH/DELETE under timeouts and 5xx: one call each', async () => {
    const s = await h.seller('once@example.com');
    const c = s.connection.id;
    const routes = [
      ['POST /checkout_configurations', () => h.whopOffer(s)],
      ['PATCH /webhooks/:id', () => h.call(s.who, 'POST', `/api/payments/whop/${c}/enable-webhook`)],
    ];
    for (const [route, act] of routes) {
      for (const mode of [{ status: 503 }, { timeout: true }]) {
        const before = s.mock.writes(route).length;
        s.mock.fail(route, mode);
        await act();
        expect(s.mock.writes(route).length - before, `${route} ${JSON.stringify(mode)}`).toBe(1);
      }
    }
    const before = s.mock.writes('DELETE /webhooks/:id').length;
    s.mock.fail('DELETE /webhooks/:id', { status: 503 });
    const gone = await h.call(s.who, 'DELETE', `/api/payments/whop/${c}?confirm=1`);
    expect(gone.body.notice).toBe('REMOVE_WEBHOOK_IN_WHOP');
    expect(s.mock.writes('DELETE /webhooks/:id').length - before).toBe(1);
    const w = await h.seller('once-webhook@example.com', {});
    expect(w.mock.writes('POST /webhooks').filter((x) => x.idempotencyKey === `ylb-whop-webhook-${w.connection.id}`)).toHaveLength(1);
  });
});

describe('account deletion and the cron jobs', () => {
  let h;
  beforeAll(async () => {
    h = await offersServer();
  });
  afterAll(() => h.close());

  it('forgetUser: the buy links stop at once, one webhook removal attempt, a failure doesn’t stop it; unforget lifts', async () => {
    const s = await h.seller('forget@example.com');
    const offer = (await h.whopOffer(s)).body.offer;
    expect((await h.visit(`/b/${offer.id}`)).status).toBe(302);
    s.mock.fail('DELETE /webhooks/:id', { status: 503 });
    await h.offers.forgetUser(s.who.id);
    expect(s.mock.writes('DELETE /webhooks/:id')).toHaveLength(1);
    expect((await h.visit(`/b/${offer.id}`)).status).toBe(404);
    expect((await h.call(s.who, 'POST', '/api/offers', { projectId: 'p1', title: 'x', provider: 'external', url: 'https://gumroad.com/l/x' })).body.code).toBe('ACCOUNT_DELETING');
    await h.offers.unforgetUser(s.who.id);
    expect((await h.visit(`/b/${offer.id}`)).status).toBe(302);
  });

  it('the webhook check: Whop turned it off → disabled; a revoked key → key_rejected; reads only', async () => {
    const off = await h.seller('cron-off@example.com');
    const revoked = await h.seller('cron-401@example.com');
    off.mock.disable(h.rows('payment_connections').find((r) => r.id === off.connection.id).webhook_id);
    revoked.mock.removeKey(revoked.whopKey);
    const jobs = h.offers.cronJobs();
    expect(jobs.map((j) => j.name)).toEqual(['offers-webhooks', 'offers-reconcile']);
    const writesBefore = h.production.writes().length;
    const got = await jobs[0].run({});
    expect(got.disabled).toBeGreaterThanOrEqual(1);
    expect(h.rows('payment_connections').find((r) => r.id === off.connection.id).webhook_state).toBe('disabled');
    expect(h.rows('payment_connections').find((r) => r.id === revoked.connection.id).status).toBe('key_rejected');
    expect(h.production.writes().length).toBe(writesBefore);
    // checked: not again within 20 hours
    expect((await jobs[0].run({})).checked).toBe(0);
  });

  it('the reconcile records a sale the webhook missed, once, and ignores the seller’s other payments', async () => {
    const s = await h.seller('reconcile@example.com', { price: 12 });
    const offer = (await h.whopOffer(s)).body.offer;
    await s.mock.pay({ checkoutId: checkoutOf(h, offer.id), deliver: false });
    // a sale of the seller's that isn't ours
    s.mock.payments.set('pay_foreign123', { id: 'pay_foreign123', account_id: s.accountId, status: 'paid', total: { amount: '5.00', currency: 'usd' }, currency: 'usd', metadata: {}, created_at: new Date().toISOString() });
    const job = h.offers.cronJobs()[1];
    await job.run({});
    await job.run({});
    const mine = h.rows('sales').filter((r) => r.user_id === s.who.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'paid', amount_minor: 1200 });
    expect(h.rows('sales').some((r) => r.provider_payment_id === 'pay_foreign123')).toBe(false);
  });
});

// ── helpers: a signed delivery straight to the route (for envelopes the mock doesn't make) ──
function webhookSecret(h, s) {
  const row = h.rows('payment_connections').find((r) => r.id === s.connection.id);
  return createPaymentCrypto(PAYMENT_SECRET).openWebhook(row.user_id, row.id, row.webhook_secret_ciphertext);
}
function payment(account, metadata, checkoutId = null) {
  return { id: `pay_${crypto.randomBytes(6).toString('hex')}`, account_id: account, status: 'paid', total: { amount: '10.00', currency: 'usd', decimals: 2 }, currency: 'usd', metadata, ...(checkoutId ? { checkout_configuration_id: checkoutId } : {}), paid_at: new Date().toISOString() };
}
async function post(h, s, evt) {
  const raw = JSON.stringify({ id: `msg_${crypto.randomBytes(6).toString('hex')}`, api_version: 'v1', timestamp: new Date().toISOString(), ...evt });
  const id = JSON.parse(raw).id;
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${h.base}/api/webhooks/whop/${s.connection.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signWhopPayload(raw, id, ts, webhookSecret(h, s)) }, body: raw });
  return { status: res.status, body: await res.json() };
}
