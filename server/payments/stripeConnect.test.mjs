// Seller accounts on Stripe Connect (server/payments/stripeConnect.mjs, spec S3): the create body, the plan and terms
// gates, one Stripe write per request, a timeout read back (never re-sent), onboarding links, the fixed /connect/*
// redirects, statuses from the account, and stopping selling. Against mock-stripe and mock-supabase only.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { offersServer, testBilling, APP_URL } from '../offers/test-helpers.mjs';
import { CONNECT_CONTROLLER, accountView, requirementsOf, statusOf } from './stripeConnect.mjs';

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
    expect(w.body.metadata).toEqual({ ylb_tag: expect.stringMatching(/^cust_[0-9a-f]{24}$/), ylb_env: 'sandbox' });
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
