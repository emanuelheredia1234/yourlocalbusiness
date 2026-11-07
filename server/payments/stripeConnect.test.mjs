// Seller accounts on Stripe Connect (server/payments/stripeConnect.mjs, spec S3): the create body, the plan and terms
// gates, one Stripe write per request, a timeout read back (never re-sent), onboarding links, the fixed /connect/*
// redirects, statuses from the account, and stopping selling. Against mock-stripe and mock-supabase only.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { offersServer, testBilling, APP_URL } from '../offers/test-helpers.mjs';
import { CONNECT_CONTROLLER, accountView, requirementsOf, statusOf, validLinkUrl } from './stripeConnect.mjs';

const ACCT = 'POST /v1/accounts';

describe('Stripe Connect seller accounts', () => {
  let h;
  let billing;
  beforeAll(async () => {
    billing = testBilling();
    h = await offersServer({ stripe: true, billing });
  });
  afterAll(() => h.close());
  const create = (who, over = {}) => h.call(who, 'POST', '/api/payments/stripe', { country: 'US', acceptTerms: true, clientRequestId: crypto.randomUUID(), ...over });
  const rowOf = (who) => h.rows('connect_accounts').find((r) => r.user_id === who.id && r.status !== 'disconnected');

  it('creates the account with exactly the four controller properties, both capabilities, the customer tag and never the raw user id', async () => {
    const who = await h.user('body@example.com');
    const before = h.stripe.writes(ACCT).length;
    const res = await create(who, { businessName: 'Pottery by Ana' });
    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ status: 'onboarding', environment: 'sandbox', country: 'US', chargesEnabled: false, defaultCurrency: 'usd', displayName: 'Pottery by Ana' });
    expect(JSON.stringify(res.body)).not.toMatch(/acct_[A-Za-z0-9]{6,}/);
    const writes = h.stripe.writes(ACCT);
    expect(writes.length).toBe(before + 1);
    const w = writes.at(-1);
    expect(w.idempotencyKey).toMatch(/^ylb-connect-acct:[0-9a-f]{40}$/);
    expect(w.body.controller).toEqual(JSON.parse(JSON.stringify(CONNECT_CONTROLLER)));
    expect(Object.keys(w.body.controller).sort()).toEqual(['fees', 'losses', 'requirement_collection', 'stripe_dashboard']);
    expect(w.body.capabilities).toEqual({ card_payments: { requested: 'true' }, transfers: { requested: 'true' } });
    expect(w.body.metadata).toEqual({ ylb_tag: expect.stringMatching(/^cust_[0-9a-f]{24}$/), ylb_env: 'sandbox', ylb_req: expect.stringMatching(/^[0-9a-f]{24}$/) });
    expect(w.body.email).toBe('body@example.com');
    expect(JSON.stringify(w.body)).not.toContain(who.id);
    // the owner row is made first (the fee at buy time needs it): the entitlement was asked with who
    expect(billing.state.calls.some((c) => c.userId === who.id)).toBe(true);
    const row = rowOf(who);
    expect(row).toMatchObject({ status: 'onboarding', terms_version: expect.any(String), requirements: { currently_due: 4, past_due: 0 } });
    expect(JSON.stringify(row.requirements)).not.toMatch(/dob|external_account/);
  });

  it('needs a plan (402) — the owner needs none — and accepted terms; a bad country or request id is refused before Stripe', async () => {
    const noPlan = await h.user('noplan@example.com');
    billing.plans.set(noPlan.id, null);
    const before = h.stripe.writes(ACCT).length;
    expect((await create(noPlan)).status).toBe(402);
    const plain = await h.user('terms@example.com');
    expect((await create(plain, { acceptTerms: false })).body.code).toBe('TERMS_REQUIRED');
    expect((await create(plain, { country: 'ZZ' })).body.code).toBe('BAD_COUNTRY');
    expect((await create(plain, { clientRequestId: 'nope' })).status).toBe(400);
    expect(h.stripe.writes(ACCT).length).toBe(before);
    const owner = await h.user('owner@example.com', { isAdmin: true });
    billing.plans.set(owner.id, null);
    expect((await create(owner)).status).toBe(200);
  });

  it('a double press makes one Stripe write; the second press answers the same account', async () => {
    const who = await h.user('double@example.com');
    const before = h.stripe.writes(ACCT).length;
    const crid = crypto.randomUUID();
    const [a, b] = await Promise.all([create(who, { clientRequestId: crid }), create(who, { clientRequestId: crid })]);
    // one of them makes it; the other answers the same account or "we're confirming" (409 PENDING)
    for (const r of [a, b]) expect([200, 409]).toContain(r.status);
    expect([a, b].some((r) => r.status === 200)).toBe(true);
    expect(h.stripe.writes(ACCT).length).toBe(before + 1);
    const again = await create(who, { clientRequestId: crid });
    expect(again.status).toBe(200);
    expect(again.body.account.id).toBe(rowOf(who).id);
    expect(h.stripe.writes(ACCT).length).toBe(before + 1);
  });

  it('a timeout: the row is unknown, the POST is never re-sent, and the read-back adopts the account by its metadata', async () => {
    const who = await h.user('timeout@example.com');
    const before = h.stripe.writes(ACCT).length;
    h.stripe.fail(ACCT, 'timeout');
    const res = await create(who);
    expect(res.status).toBe(202);
    expect(res.body.account.status).toBe('unknown');
    expect(rowOf(who).stripe_account_id ?? null).toBeNull();
    expect(h.stripe.writes(ACCT).length).toBe(before + 1);
    // the app's next read finds it (GET /v1/accounts, by metadata): no second POST
    const got = await h.call(who, 'GET', '/api/payments/stripe');
    expect(got.status).toBe(200);
    expect(got.body.account.status).toBe('onboarding');
    expect(rowOf(who).stripe_account_id).toMatch(/^acct_/);
    expect(h.stripe.writes(ACCT).length).toBe(before + 1);
    expect(h.stripe.calls.some((c) => c.method === 'GET' && c.path === '/v1/accounts')).toBe(true);
  });

  it('a create that never reached Stripe: kept while young, deleted by the hourly read-back after 10 minutes', async () => {
    const who = await h.user('lost@example.com');
    await h.db.insert('connect_accounts', { id: 'L'.repeat(22), user_id: who.id, environment: 'sandbox', status: 'unknown', country: 'US', terms_version: 'v', terms_accepted_at: new Date(h.clock()).toISOString(), create_key: 'ylb-connect-acct:x', create_started_at: new Date(h.clock()).toISOString() });
    const writes = h.stripe.writes(ACCT).length;
    await h.offers.connect.cronReadback();
    expect(rowOf(who)?.status).toBe('unknown');
    h.advance(11 * 60_000);
    await h.offers.connect.cronReadback();
    expect(rowOf(who)).toBeUndefined();
    expect(h.stripe.writes(ACCT).length).toBe(writes);
  });

  it('a Stripe refusal deletes the row and answers in our words; a refused key alerts the owner, with a hint for the owner only', async () => {
    const who = await h.user('refused@example.com');
    h.stripe.fail(ACCT, 'permission');
    const res = await create(who);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Stripe payments aren’t available right now.');
    expect(res.body.hint).toBeUndefined();
    expect(rowOf(who)).toBeUndefined();
    await vi.waitFor(() => expect(h.rows('connect_alerts').find((a) => a.kind === 'key_missing_connect_permission')).toBeTruthy());
    const owner = await h.user('owner2@example.com', { isAdmin: true });
    h.stripe.fail(ACCT, 'permission');
    expect((await create(owner)).body.hint).toMatch(/Connect permissions/);
  });

  it('onboarding links: a new one each call, https return and refresh on the app’s address; /connect/* are fixed 302s whatever the query', async () => {
    const who = await h.user('link@example.com');
    await create(who);
    const a = await h.call(who, 'POST', '/api/payments/stripe/onboarding', {});
    const b = await h.call(who, 'POST', '/api/payments/stripe/onboarding', {});
    expect(a.status).toBe(200);
    expect(a.body.url).not.toBe(b.body.url);
    const links = h.stripe.writes('POST /v1/account_links');
    expect(new Set(links.map((l) => l.idempotencyKey)).size).toBe(links.length);
    expect(links.at(-1).body).toMatchObject({ type: 'account_onboarding', collection_options: { fields: 'eventually_due' }, return_url: `${APP_URL}/connect/return`, refresh_url: `${APP_URL}/connect/refresh` });
    // the link is never stored
    expect(JSON.stringify(h.rows('connect_accounts'))).not.toContain('/__onboard/');
    for (const path of ['/connect/return', '/connect/return?to=https://evil.example', '/connect/refresh?next=//evil.example']) {
      const r = await h.visit(path);
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(path.startsWith('/connect/return') ? '/#settings/payments?stripe=return' : '/#settings/payments?stripe=refresh');
    }
    // no account yet: no link
    const none = await h.user('nolink@example.com');
    expect((await h.call(none, 'POST', '/api/payments/stripe/onboarding', {})).body.code).toBe('STRIPE_NOT_CONNECTED');
  });

  it('sync applies Stripe’s account (counts only); disconnect asks first, then pauses the Stripe offers', async () => {
    const s = await h.stripeSeller('sync@example.com');
    expect(s.row).toMatchObject({ status: 'active', charges_enabled: true });
    const view = await h.call(s.who, 'GET', '/api/payments/stripe');
    expect(view.body).toMatchObject({ available: true, environment: 'sandbox', fee: { pct: 3, tier: 'launch' }, account: { status: 'active', accountLast4: s.accountId.slice(-4) } });
    await h.db.insert('offers', { id: 'S'.repeat(22), user_id: s.who.id, project_id: 'p1', title: 'Ebook', provider: 'stripe', connect_account_id: s.row.id, price_minor: 900, currency: 'usd', status: 'active', delivery: { kind: 'none' } });
    const ask = await h.call(s.who, 'DELETE', '/api/payments/stripe');
    expect(ask.status).toBe(409);
    expect(ask.body).toMatchObject({ code: 'CONFIRM', offers: 1 });
    const done = await h.call(s.who, 'DELETE', '/api/payments/stripe?confirm=1');
    expect(done.body).toMatchObject({ ok: true, paused: 1 });
    expect(h.rows('offers').find((o) => o.id === 'S'.repeat(22)).status).toBe('paused');
    expect(h.rows('connect_accounts').find((r) => r.id === s.row.id).status).toBe('disconnected');
    // no Stripe write: the seller keeps their account
    expect(h.stripe.writes().filter((w) => w.path.includes(s.accountId))).toHaveLength(0);
  });

  it('Stripe Tax: only once Stripe says active', async () => {
    const s = await h.stripeSeller('tax@example.com');
    expect((await h.call(s.who, 'PUT', '/api/payments/stripe/tax', { enabled: true })).body.code).toBe('TAX_NOT_READY');
    await fetch(`${h.stripe.base}/__tax/active`, { method: 'POST', body: JSON.stringify({ account: s.accountId }) });
    const on = await h.call(s.who, 'PUT', '/api/payments/stripe/tax', { enabled: true });
    expect(on.body.account).toMatchObject({ taxEnabled: true, taxStatus: 'active' });
    expect((await h.call(s.who, 'PUT', '/api/payments/stripe/tax', { enabled: false })).body.account.taxEnabled).toBe(false);
  });

  it('setting up again after stopping: the old Stripe offers move to the new account and can be resumed', async () => {
    const s = await h.stripeSeller('again@example.com');
    const o = (await h.call(s.who, 'POST', '/api/offers', { projectId: 'p1', provider: 'stripe', title: 'Ebook', priceMinor: 900, currency: 'usd', clientRequestId: crypto.randomUUID() })).body.offer;
    await h.call(s.who, 'DELETE', '/api/payments/stripe?confirm=1');
    expect((await h.call(s.who, 'PATCH', `/api/offers/${o.id}`, { status: 'active' })).body.code).toBe('NOT_SELLABLE');
    const again = await create(s.who);
    expect(again.status).toBe(200);
    const fresh = rowOf(s.who);
    expect(fresh.id).not.toBe(s.row.id);
    expect(h.rows('offers').find((x) => x.id === o.id)).toMatchObject({ connect_account_id: fresh.id, status: 'paused' });
    expect((await h.call(s.who, 'PATCH', `/api/offers/${o.id}`, { status: 'active' })).status).toBe(200);
  });

  it('a Stripe answer about the key itself (409 in flight) keeps the row to read back, with no false owner alert', async () => {
    const who = await h.user('in-flight@example.com');
    const alerts = h.rows('connect_alerts').find((a) => a.kind === 'connect_not_enabled')?.count ?? 0;
    h.stripe.fail(ACCT, 'in_use');
    const res = await create(who);
    expect(res.status).toBe(202);
    expect(rowOf(who)).toMatchObject({ status: 'unknown' });
    expect(h.rows('connect_alerts').find((a) => a.kind === 'connect_not_enabled')?.count ?? 0).toBe(alerts);
  });

  it('a person’s same-key retry sends the stored body (its business name), never this request’s', async () => {
    const who = await h.user('same-key@example.com');
    const crid = crypto.randomUUID();
    h.stripe.fail(ACCT, 'server');
    expect((await create(who, { clientRequestId: crid, businessName: 'First Name Co' })).status).toBe(202);
    const res = await create(who, { clientRequestId: crid, businessName: 'Second Name Co' });
    expect(res.status).toBe(200);
    const [first, second] = h.stripe.writes(ACCT).slice(-2);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.body.business_profile).toEqual(first.body.business_profile);
    expect(second.body.business_profile.name).toBe('First Name Co');
  });

  it('the read-back skips the seller’s older account (another row’s), asks Stripe at most once a minute per row, and tells the owner when it gives up', async () => {
    const s = await h.stripeSeller('old-acct@example.com');
    await h.call(s.who, 'DELETE', '/api/payments/stripe?confirm=1');
    // a new create that never reached Stripe
    await h.db.insert('connect_accounts', { id: 'N'.repeat(22), user_id: s.who.id, environment: 'sandbox', status: 'unknown', country: 'US', terms_version: 'v', terms_accepted_at: new Date(h.clock()).toISOString(), create_key: 'ylb-connect-acct:new', create_started_at: new Date(h.clock()).toISOString() });
    const mismatches = h.rows('connect_alerts').find((a) => a.kind === 'account_mismatch')?.count ?? 0;
    const reads = () => h.stripe.calls.filter((c) => c.method === 'GET' && c.path === '/v1/accounts').length;
    const before = reads();
    const view = await h.call(s.who, 'GET', '/api/payments/stripe');
    expect(view.body.account.status).toBe('unknown');
    expect(rowOf(s.who).stripe_account_id ?? null).toBeNull();
    expect(h.rows('connect_alerts').find((a) => a.kind === 'account_mismatch')?.count ?? 0).toBe(mismatches);
    const once = reads();
    expect(once).toBeGreaterThan(before);
    // the card's next polls within the minute: no Stripe read
    await h.call(s.who, 'GET', '/api/payments/stripe');
    await h.call(s.who, 'GET', '/api/payments/stripe');
    expect(reads()).toBe(once);
    // ten minutes on, still not found: the owner is told, then the row goes
    h.advance(11 * 60_000);
    await h.offers.connect.cronReadback();
    expect(h.rows('connect_accounts').find((r) => r.id === 'N'.repeat(22))).toBeUndefined();
    expect(h.rows('connect_alerts').find((a) => a.kind === 'connect_readback_lost')).toBeTruthy();
  });
});

describe('validLinkUrl (onboarding links the server hands out)', () => {
  it('Stripe’s https hosts only: no http, other host, port or user', () => {
    expect(validLinkUrl('https://connect.stripe.com/setup/e/acct_1/abc')).toBe('https://connect.stripe.com/setup/e/acct_1/abc');
    expect(validLinkUrl('https://dashboard.stripe.com/x')).toBeTruthy();
    for (const bad of ['http://connect.stripe.com/x', 'https://connect.stripe.com.evil.example/x', 'https://evilstripe.com/x', 'https://connect.stripe.com:8443/x', 'https://u:p@connect.stripe.com/x', 'javascript:alert(1)', '', null]) expect(validLinkUrl(bad), String(bad)).toBeNull();
    expect(validLinkUrl('http://127.0.0.1:9/__onboard/a/b', { testBase: 'http://127.0.0.1:9' })).toBeTruthy();
    expect(validLinkUrl('http://127.0.0.1:9/__onboard/a/b')).toBeNull();
  });
});

describe('the owner’s Connect view', () => {
  let h;
  beforeAll(async () => {
    h = await offersServer({ stripe: true, billing: testBilling() });
  });
  afterAll(() => h.close());

  it('is the owner’s only: setup (Secret names only), sellers, our fees, alerts; an alert can be marked resolved', async () => {
    const s = await h.stripeSeller('admin-seller@example.com');
    const o = (await h.call(s.who, 'POST', '/api/offers', { projectId: 'p1', provider: 'stripe', title: 'Kit', priceMinor: 4900, currency: 'usd', clientRequestId: crypto.randomUUID() })).body.offer;
    const sid = (await h.visit(`/b/${o.id}`)).headers.get('location').split('/__pay/')[1];
    await h.visit(`/b/${o.id}/done?session_id=${sid}`);
    await fetch(`${h.stripe.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id: sid, account: s.accountId }) });
    await h.visit(`/b/${o.id}/done?session_id=${sid}`);
    await h.offers.connect.alert('checkout_url_unexpected', { host: 'x.example' });
    const plain = await h.user('not-owner@example.com');
    expect((await h.call(plain, 'GET', '/api/payments/stripe/admin')).status).toBe(403);
    const owner = await h.user('the-owner@example.com', { isAdmin: true });
    const v = await h.call(owner, 'GET', '/api/payments/stripe/admin');
    expect(v.status).toBe(200);
    expect(v.body.setup).toMatchObject({ environment: 'sandbox', missing: [], publicUrlOk: true, connectEnabled: true, returnFees: true });
    expect(v.body.accounts.counts.active).toBeGreaterThanOrEqual(1);
    expect(v.body.accounts.sellers[0]).toMatchObject({ customerTag: expect.stringMatching(/^cust_/), status: 'active', chargesEnabled: true });
    expect(v.body.fees.currencies.usd.last30).toMatchObject({ fees: 147, returned: 0, net: 147 });
    expect(v.body.alerts.map((a) => a.kind)).toContain('checkout_url_unexpected');
    expect(JSON.stringify(v.body)).not.toMatch(/sk_test_|whsec_|acct_[A-Za-z0-9]{6,}/);
    expect((await h.call(owner, 'POST', '/api/payments/stripe/admin/alerts/checkout_url_unexpected/resolve', {})).body).toEqual({ ok: true, resolved: 1 });
    expect((await h.call(owner, 'GET', '/api/payments/stripe/admin')).body.alerts.map((a) => a.kind)).not.toContain('checkout_url_unexpected');
  });
});

describe('the seller terms draft', () => {
  let h;
  beforeAll(async () => {
    h = await offersServer({ stripe: true, billing: testBilling(), sellerTermsReady: false });
  });
  afterAll(() => h.close());

  it('blocks everyone but the owner while it’s a draft', async () => {
    const who = await h.user('early@example.com');
    const res = await h.call(who, 'POST', '/api/payments/stripe', { country: 'US', acceptTerms: true, clientRequestId: crypto.randomUUID() });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Selling with Stripe opens soon.');
    expect((await h.call(who, 'GET', '/api/payments/stripe')).body).toMatchObject({ available: false, termsReady: false, termsUrl: '/seller-terms' });
    const owner = await h.user('boss@example.com', { isAdmin: true });
    expect((await h.call(owner, 'POST', '/api/payments/stripe', { country: 'US', acceptTerms: true, clientRequestId: crypto.randomUUID() })).status).toBe(200);
  });
});

describe('statusOf and requirementsOf', () => {
  it.each([
    [{ charges_enabled: true, details_submitted: true, requirements: {} }, 'active'],
    [{ charges_enabled: true, requirements: { past_due: ['x'] } }, 'active'],
    [{ charges_enabled: false, details_submitted: true, requirements: {} }, 'restricted'],
    [{ charges_enabled: false, details_submitted: false, requirements: {} }, 'onboarding'],
    [{ charges_enabled: true, requirements: { disabled_reason: 'rejected.fraud' } }, 'rejected'],
    [{ charges_enabled: false, requirements: { disabled_reason: 'requirements.past_due' } }, 'onboarding'],
    [{}, 'onboarding'],
  ])('%j → %s', (acct, status) => {
    expect(statusOf(acct)).toBe(status);
  });

  it('keeps counts and codes only, never the names', () => {
    const q = requirementsOf({ requirements: { currently_due: ['person_abc.dob.day', 'external_account'], past_due: ['person_abc.ssn_last_4'], eventually_due: [], pending_verification: ['x'], disabled_reason: 'requirements.past_due', current_deadline: 1900000000 } });
    expect(q).toEqual({ currently_due: 2, past_due: 1, eventually_due: 0, pending_verification: 1, disabled_reason: 'requirements.past_due', current_deadline: 1900000000 });
    expect(JSON.stringify(q)).not.toMatch(/person|dob|ssn/);
    expect(accountView({ id: 'x', environment: 'sandbox', status: 'active', country: 'US', requirements: q, stripe_account_id: 'acct_1234567890' })).toMatchObject({ due: { now: 2, pastDue: 1, later: 0, pending: 1 }, accountLast4: '7890' });
  });
});
