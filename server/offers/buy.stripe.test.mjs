// /b/<id> for Stripe offers (server/offers/stripeCheckout.mjs, spec S5.1): a Checkout Session on the seller's account
// with our fee by plan, one write per click (replayed in a 10-minute window), never an open redirect, no session for
// HEAD or a prefetch, limits, and NOT_NOW whenever something doesn't add up. Against mock-stripe only.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { offersServer, testBilling, APP_URL } from './test-helpers.mjs';
import { validCheckoutUrl } from './stripeCheckout.mjs';

const CS = 'POST /v1/checkout/sessions';

describe('/b/<id> for a Stripe offer', () => {
  let h;
  let billing;
  let ip = 0;
  beforeAll(async () => {
    billing = testBilling();
    h = await offersServer({ stripe: true, billing, env: { CONNECT_SESSIONS_PER_VISITOR_PER_HOUR: '4' } });
  });
  afterAll(() => h.close());
  const visit = (path, opts = {}) => h.visit(path, { ...opts, headers: { 'x-test-ip': opts.ip ?? `203.0.113.${(ip++ % 200) + 1}`, ...(opts.headers ?? {}) } });
  const offerFor = async (seller, over = {}) => (await h.call(seller.who, 'POST', '/api/offers', { projectId: 'p1', provider: 'stripe', title: 'Pottery course', priceMinor: 4900, currency: 'usd', clientRequestId: crypto.randomUUID(), ...over })).body.offer;
  const lastSession = () => h.stripe.writes(CS).at(-1);
  const sessionsOn = (accountId) => h.stripe.writes(CS).filter((w) => w.account === accountId).length;

  it('makes a direct charge on the seller’s account: Stripe-Account, inline price, our fee by plan, metadata; 303 to Checkout', async () => {
    for (const [tier, fee] of [['launch', 147], ['grow', 49], ['scale', null]]) {
      const s = await h.stripeSeller(`fee-${tier}@example.com`);
      billing.plans.set(s.who.id, { user_id: s.who.id, tier, source: 'stripe', status: 'active', business_limit: 1 });
      const o = await offerFor(s);
      const r = await visit(`/b/${o.id}`);
      expect(r.status, tier).toBe(303);
      expect(r.headers.get('location')).toMatch(new RegExp(`^${h.stripe.base}/__pay/cs_test_`));
      const w = lastSession();
      expect(w.account).toBe(s.accountId);
      expect(w.idempotencyKey).toMatch(/^ylb-cs:[0-9a-f]{48}$/);
      expect(w.body).toMatchObject({ mode: 'payment', client_reference_id: o.id, metadata: { ylb_offer: o.id, ylb_fee_pct: String(fee === null ? 0 : tier === 'launch' ? 3 : 1), ylb_fee_tier: tier }, line_items: [{ price_data: { currency: 'usd', unit_amount: '4900', product_data: { name: 'Pottery course' } }, quantity: '1' }], success_url: `${APP_URL}/b/${o.id}/done?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${APP_URL}/b/${o.id}/back` });
      expect(w.body.payment_intent_data.application_fee_amount).toBe(fee === null ? undefined : String(fee));
      expect(w.body.payment_intent_data.metadata).toEqual({ ylb_offer: o.id });
      expect(w.body.customer).toBeUndefined();
      expect(w.body.receipt_email).toBeUndefined();
      expect(w.body.automatic_tax).toBeUndefined();
      const ahead = Number(w.body.expires_at) - Date.now() / 1000;
      expect(ahead).toBeGreaterThan(30 * 60);
      expect(ahead).toBeLessThanOrEqual(3600);
      expect(h.rows('offers').find((x) => x.id === o.id).clicks).toBe(1);
    }
  });

  it('the owner and plans-not-enforced pay 0 (no fee sent); a seller with no plan pays Launch’s 3%; a Brazilian seller none', async () => {
    const owner = await h.stripeSeller('fee-owner@example.com', { isAdmin: true });
    // at buy time there's no signed-in user: the owner is known by the billing row their own requests made
    billing.plans.set(owner.who.id, { user_id: owner.who.id, tier: 'none', source: 'owner', status: 'active' });
    await visit(`/b/${(await offerFor(owner)).id}`);
    expect(lastSession().body.payment_intent_data.application_fee_amount).toBeUndefined();
    expect(lastSession().body.metadata.ylb_fee_tier).toBe('owner');
    const lapsed = await h.stripeSeller('fee-lapsed@example.com');
    const o = await offerFor(lapsed);
    billing.plans.set(lapsed.who.id, { user_id: lapsed.who.id, tier: 'grow', source: 'stripe', status: 'canceled', ended_at: new Date().toISOString() });
    await visit(`/b/${o.id}`);
    expect(lastSession().body.payment_intent_data.application_fee_amount).toBe('147');
    const br = await h.stripeSeller('fee-br@example.com', { country: 'BR' });
    await visit(`/b/${(await offerFor(br, { currency: 'brl' })).id}`);
    expect(lastSession().body.payment_intent_data.application_fee_amount).toBeUndefined();
    await vi.waitFor(() => expect(h.rows('connect_alerts').some((a) => a.kind === 'fee_not_allowed_br')).toBe(true));
  });

  it('success_url ignores the Host header; on the seller’s verified domain it uses that domain', async () => {
    const s = await h.stripeSeller('host@example.com');
    const o = await offerFor(s);
    await visit(`/b/${o.id}`, { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
    expect(lastSession().body.success_url).toBe(`${APP_URL}/b/${o.id}/done?session_id={CHECKOUT_SESSION_ID}`);
    const r = await visit(`/b/${o.id}`, { site: s.who.id, domain: 'shop.potter.example' });
    expect(r.status).toBe(303);
    expect(lastSession().body.success_url).toBe(`https://shop.potter.example/b/${o.id}/done?session_id={CHECKOUT_SESSION_ID}`);
    expect(lastSession().body.cancel_url).toBe(`https://shop.potter.example/b/${o.id}/back`);
  });

  it('HEAD and a prefetch make no session and count nothing', async () => {
    const s = await h.stripeSeller('preview@example.com');
    const o = await offerFor(s);
    for (const opts of [{ method: 'HEAD' }, { headers: { 'sec-purpose': 'prefetch' } }, { headers: { purpose: 'prefetch' } }]) {
      const r = await visit(`/b/${o.id}`, opts);
      expect(r.status).toBe(200);
      expect(r.headers.get('location')).toBeNull();
    }
    const page = await visit(`/b/${o.id}`, { headers: { 'sec-purpose': 'prefetch' } });
    expect(page.text).toContain('Continue to checkout');
    expect(page.text).not.toMatch(/<script/i);
    expect(sessionsOn(s.accountId)).toBe(0);
    expect(h.rows('offers').find((x) => x.id === o.id).clicks ?? 0).toBe(0);
  });

  it('a second click in the same window sends the same Idempotency-Key and gets one session; per-visitor limits', async () => {
    const s = await h.stripeSeller('twice@example.com');
    const o = await offerFor(s);
    const a = await visit(`/b/${o.id}`, { ip: '198.18.0.9' });
    const b = await visit(`/b/${o.id}`, { ip: '198.18.0.9' });
    expect(b.headers.get('location')).toBe(a.headers.get('location'));
    const writes = h.stripe.writes(CS).filter((w) => w.account === s.accountId);
    expect(writes).toHaveLength(2);
    expect(writes[0].idempotencyKey).toBe(writes[1].idempotencyKey);
    expect(h.stripe.realm(s.accountId).sessions.size).toBe(1);
    // another visitor: another session
    await visit(`/b/${o.id}`, { ip: '198.18.0.10' });
    expect(h.stripe.realm(s.accountId).sessions.size).toBe(2);
    // the per-visitor limit (4 an hour here)
    await visit(`/b/${o.id}`, { ip: '198.18.0.9' });
    await visit(`/b/${o.id}`, { ip: '198.18.0.9' });
    expect((await visit(`/b/${o.id}`, { ip: '198.18.0.9' })).status).toBe(429);
  });

  it('a timeout: 503 "try again", exactly one write; the buyer’s own retry replays the same key', async () => {
    const s = await h.stripeSeller('slow@example.com');
    const o = await offerFor(s);
    h.stripe.fail(CS, 'timeout');
    const r = await visit(`/b/${o.id}`, { ip: '198.18.1.1' });
    expect(r.status).toBe(503);
    expect(r.text).toContain('Checkout didn’t open');
    expect(r.headers.get('location')).toBeNull();
    expect(sessionsOn(s.accountId)).toBe(1);
    const again = await visit(`/b/${o.id}`, { ip: '198.18.1.1' });
    expect(again.status).toBe(303);
    const w = h.stripe.writes(CS).filter((x) => x.account === s.accountId);
    expect(w[0].idempotencyKey).toBe(w[1].idempotencyKey);
    expect(h.stripe.realm(s.accountId).sessions.size).toBe(1);
  });

  it('buyers on one address: different browsers (cookies) get their own sessions; the redirect sets the browser’s cookie', async () => {
    const s = await h.stripeSeller('nat@example.com');
    const o = await offerFor(s);
    const first = await visit(`/b/${o.id}`, { ip: '198.18.2.1' });
    const cookie = /^ylb_v=([A-Za-z0-9_-]{22});/.exec(first.headers.get('set-cookie') ?? '');
    expect(cookie).toBeTruthy();
    expect(first.headers.get('set-cookie')).toMatch(/Path=\/b\/; Max-Age=3600; HttpOnly; SameSite=Lax/);
    const a = await visit(`/b/${o.id}`, { ip: '198.18.2.1', headers: { cookie: 'ylb_v=AAAAAAAAAAAAAAAAAAAAAA' } });
    const b = await visit(`/b/${o.id}`, { ip: '198.18.2.1', headers: { cookie: 'other=1; ylb_v=BBBBBBBBBBBBBBBBBBBBBB' } });
    expect(a.status).toBe(303);
    expect(b.status).toBe(303);
    expect(a.headers.get('location')).not.toBe(b.headers.get('location'));
    // a browser with its cookie gets no new one
    expect(a.headers.get('set-cookie')).toBeNull();
    // no cookie yet: the address with the browser's user agent tells two people apart
    const c = await visit(`/b/${o.id}`, { ip: '198.18.2.2', headers: { 'user-agent': 'Phone A' } });
    const d = await visit(`/b/${o.id}`, { ip: '198.18.2.2', headers: { 'user-agent': 'Laptop B' } });
    expect(c.headers.get('location')).not.toBe(d.headers.get('location'));
  });

  it('a replayed session someone already paid is never reused: one new session (a new key), never a redirect to the paid one', async () => {
    const s = await h.stripeSeller('replay-paid@example.com');
    const o = await offerFor(s);
    const first = await visit(`/b/${o.id}`, { ip: '198.18.3.1' });
    const paidSid = first.headers.get('location').split('/__pay/')[1];
    await fetch(`${h.stripe.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id: paidSid, account: s.accountId }) });
    // the same address and browser within the window: Stripe replays the paid session; it's read back and not used
    const again = await visit(`/b/${o.id}`, { ip: '198.18.3.1' });
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).not.toContain(paidSid);
    const writes = h.stripe.writes(CS).filter((w) => w.account === s.accountId);
    expect(writes).toHaveLength(3);
    expect(writes[1].idempotencyKey).toBe(writes[0].idempotencyKey);
    expect(writes[2].idempotencyKey).not.toBe(writes[0].idempotencyKey);
    expect(h.stripe.realm(s.accountId).sessions.size).toBe(2);
    // a third click replays the new (open) session
    const third = await visit(`/b/${o.id}`, { ip: '198.18.3.1' });
    expect(third.headers.get('location')).toBe(again.headers.get('location'));
    expect(h.stripe.realm(s.accountId).sessions.size).toBe(2);
  });

  it('the key covers the whole body: the seller’s domain then the app host (or tax turned on) is a new key, never Stripe’s idempotency_error', async () => {
    const s = await h.stripeSeller('two-hosts@example.com');
    const o = await offerFor(s);
    const onDomain = await visit(`/b/${o.id}`, { ip: '198.18.4.1', site: s.who.id, domain: 'shop.two.example' });
    const onApp = await visit(`/b/${o.id}`, { ip: '198.18.4.1' });
    expect(onDomain.status).toBe(303);
    expect(onApp.status).toBe(303);
    const w = h.stripe.writes(CS).filter((x) => x.account === s.accountId);
    expect(w[0].idempotencyKey).not.toBe(w[1].idempotencyKey);
    expect(h.stripe.calls.filter((c) => c.route === CS && c.account === s.accountId).length).toBe(2);
  });

  it('a double click still in flight (Stripe 409) or a refused key: "try again in a minute" (Retry-After 60), never the hour-long NOT_NOW', async () => {
    const s = await h.stripeSeller('in-flight@example.com');
    const o = await offerFor(s);
    h.stripe.fail(CS, 'in_use');
    const r = await visit(`/b/${o.id}`, { ip: '198.18.5.1' });
    expect(r.status).toBe(503);
    expect(r.text).toContain('Try again in a minute');
    expect(r.headers.get('retry-after')).toBe('60');
    expect(r.headers.get('location')).toBeNull();
    // the buyer's next click opens checkout
    const again = await visit(`/b/${o.id}`, { ip: '198.18.5.1' });
    expect(again.status).toBe(303);
  });

  it('never an open redirect: a session url elsewhere is not followed (owner alert); ?next=, ?redirect= and a Referer change nothing', async () => {
    const s = await h.stripeSeller('redirect@example.com');
    const o = await offerFor(s);
    for (const bad of ['https://evil.example/pay', 'https://checkout.stripe.com.evil.example/x', 'http://checkout.stripe.com/x', 'https://checkout.stripe.com:8443/x', 'https://user@checkout.stripe.com/x']) {
      h.stripe.checkoutUrl = () => bad;
      const r = await visit(`/b/${o.id}`);
      expect(r.status, bad).toBe(503);
      expect(r.headers.get('location')).toBeNull();
      expect(r.text).not.toContain('evil');
    }
    h.stripe.checkoutUrl = null;
    await vi.waitFor(() => expect(h.rows('connect_alerts').find((a) => a.kind === 'checkout_url_unexpected')?.detail.host).toBeTruthy());
    const r = await visit(`/b/${o.id}?next=https://evil.example&redirect=https://evil.example`, { headers: { referer: 'https://evil.example/' } });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toMatch(new RegExp(`^${h.stripe.base}/__pay/`));
    expect(JSON.stringify(lastSession().body)).not.toContain('evil');
  });

  it('NOT_NOW when the account isn’t active, belongs to someone else or another mode, or the fee can’t be known; no session', async () => {
    const s = await h.stripeSeller('notnow@example.com');
    const o = await offerFor(s);
    const acct = h.rows('connect_accounts').find((r) => r.id === s.row.id);
    const before = sessionsOn(s.accountId);
    for (const [k, v] of [['status', 'restricted'], ['charges_enabled', false], ['user_id', '00000000-0000-4000-8000-000000000000'], ['environment', 'production']]) {
      const was = acct[k];
      acct[k] = v;
      h.offers.buy.dropAccount(s.row.id);
      const r = await visit(`/b/${o.id}`);
      expect(r.status, k).toBe(503);
      expect(r.text).toContain('isn’t available to buy right now');
      acct[k] = was;
      h.offers.buy.dropAccount(s.row.id);
    }
    billing.state.failEntitlement = true;
    expect((await visit(`/b/${o.id}`)).status).toBe(503);
    billing.state.failEntitlement = false;
    expect(sessionsOn(s.accountId)).toBe(before);
    // an onboarding seller's offer exists but doesn't sell
    const early = await h.stripeSeller('notnow-early@example.com', { enable: false });
    expect((await visit(`/b/${(await offerFor(early)).id}`)).status).toBe(503);
  });

  it('/file and /back are "not found" for other providers', async () => {
    const who = await h.user('ext-file@example.com');
    const o = (await h.call(who, 'POST', '/api/offers', { projectId: 'p1', title: 'Ext', provider: 'external', url: 'https://gumroad.com/l/x' })).body.offer;
    expect((await visit(`/b/${o.id}/file`)).status).toBe(404);
    expect((await visit(`/b/${o.id}/back`)).status).toBe(404);
  });
});

describe('validCheckoutUrl', () => {
  it.each([
    ['https://checkout.stripe.com/c/pay/cs_test_abc#fid', true],
    ['https://checkout.stripe.com/x', true],
    ['http://checkout.stripe.com/x', false],
    ['https://checkout.stripe.com:443/x', true],
    ['https://checkout.stripe.com:8443/x', false],
    ['https://a@checkout.stripe.com/x', false],
    ['https://checkout.stripe.com.evil.com/x', false],
    ['https://evilcheckout.stripe.com/x', false],
    ['https://stripe.com/x', false],
    ['//checkout.stripe.com/x', false],
    ['javascript:alert(1)', false],
    ['', false],
  ])('%s → %s', (url, ok) => {
    expect(!!validCheckoutUrl(url)).toBe(ok);
  });
  it('the mock’s /__pay/ only with its own origin as the test base', () => {
    expect(validCheckoutUrl('http://127.0.0.1:5555/__pay/cs_test_1', { testBase: 'http://127.0.0.1:5555' })).toBeTruthy();
    expect(validCheckoutUrl('http://127.0.0.1:5555/elsewhere', { testBase: 'http://127.0.0.1:5555' })).toBeNull();
    expect(validCheckoutUrl('http://127.0.0.1:6666/__pay/cs_test_1', { testBase: 'http://127.0.0.1:5555' })).toBeNull();
    expect(validCheckoutUrl('http://127.0.0.1:5555/__pay/cs_test_1')).toBeNull();
  });
});
