// Test harness for offers (tests only): mock Supabase, two mock Whops (sandbox and production: they share nothing)
// whose webhooks come back to this server, the offers module behind a bare HTTP server that also answers /b/, and a
// signed-in user per header. Every log line is captured. Nothing leaves the machine.

import http from 'node:http';
import crypto from 'node:crypto';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { createMockWhop } from '../test/mock-whop.mjs';
import { createMockStripe, TEST_STRIPE_CONNECT_WEBHOOK_SECRET, TEST_STRIPE_KEY } from '../test/mock-stripe.mjs';
import { entitlementOf, pausedError } from '../billing/entitlement.mjs';
import { fail } from '../integrations/common.mjs';
import { createDb } from '../integrations/db.mjs';
import { createBucketLimiter, readRaw } from '../integrations/common.mjs';
import { readJson, sendJson } from '../billing/test-helpers.mjs';
import { createOffers } from './index.mjs';

export const APP_URL = 'https://app.example.test';
export const PAYMENT_SECRET = 'test-payment-keys-secret-0123456789abcdef';
export const TAG_SECRET = 'test-customer-tag-secret-0123456789';

/**
 * A billing facade like P1's for tests (plans enforced): plans.set(userId, billing_accounts-like row) sets a user's
 * plan (default: Launch, active); who.isAdmin is the owner. fails: make entitlement throw (the fee can't be known).
 */
export function testBilling({ now = () => Date.now() } = {}) {
  const plans = new Map();
  const state = { failEntitlement: false, serveUntil: null, calls: [] };
  const row = (userId) => (plans.has(userId) ? plans.get(userId) : { user_id: userId, tier: 'launch', source: 'stripe', status: 'active', business_limit: 1 });
  const entitlement = async (userId, who = null) => {
    state.calls.push({ userId, admin: who?.isAdmin === true });
    if (state.failEntitlement) throw new Error('down');
    return entitlementOf(row(userId), { enforce: true }, now(), { isAdmin: who?.isAdmin === true });
  };
  return {
    plans,
    state,
    entitlement,
    async requireActive(who, feature = null) {
      const ent = await entitlement(who.id, who);
      if (ent.active) return ent;
      const [status, code, message] = pausedError(ent);
      throw fail(status, code, message, { need: { feature } });
    },
    pagesServeUntil: async () => state.serveUntil,
  };
}

export const ALL_PERMISSIONS = ['access_pass:basic:read', 'plan:basic:read', 'checkout_configuration:create', 'checkout_configuration:basic:read', 'payment:basic:read', 'member:email:read', 'webhook_receive:payments', 'developer:manage_webhook'];

/**
 * opts: env overrides; billing (a facade: requireActive, pagesServeUntil); whopTimeouts. Returns { base, supa, sandbox,
 * production, db, offers, logs, clock, advance(ms), user(email), call(who, method, path, body, headers), visit(path,
 * {method, headers, site}), close() }.
 */
export async function offersServer({ env: envOver = {}, billing = null, whopTimeouts = {}, sameOrigin = () => true, stripe: withStripe = false, sellerTermsReady = true } = {}) {
  let offset = 0;
  const clock = () => Date.now() + offset;
  const supa = await createMockSupabase().then((m) => m.start());
  const sandbox = await createMockWhop({ environment: 'sandbox', now: clock }).start();
  const production = await createMockWhop({ environment: 'production', now: clock }).start();
  // Stripe (P6 Connect): the mock, with the Connect webhook coming back to this server
  const stripeMock = withStripe ? await createMockStripe({ now: clock }).start() : null;
  const db = createDb({ supabaseUrl: supa.url, secretKey: supa.SECRET });
  const env = { SUPABASE_URL: supa.url, SUPABASE_SECRET_KEY: supa.SECRET, PAYMENT_KEYS_SECRET: PAYMENT_SECRET, APP_PUBLIC_URL: APP_URL, ...(stripeMock ? { STRIPE_SECRET_KEY: TEST_STRIPE_KEY, STRIPE_API_BASE: stripeMock.apiBase, STRIPE_CONNECT_WEBHOOK_SECRET: TEST_STRIPE_CONNECT_WEBHOOK_SECRET, CUSTOMER_TAG_SECRET: TAG_SECRET } : {}), ...envOver };
  const people = new Map();
  const logs = [];
  const log = { log: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)), error: (...a) => logs.push(a.map(String).join(' ')) };
  const auth = { enabled: true, identify: async (req) => people.get(String(req.headers['x-test-user'] ?? '')) ?? null };
  const limiter = createBucketLimiter({ now: clock });
  const offers = createOffers({ auth, db, send: sendJson, readJson, readRaw, limit: limiter, sameOrigin, clientKey: (req) => String(req.headers['x-test-ip'] ?? req.socket.remoteAddress), env, now: clock, log, billing, whopBases: { sandbox: sandbox.apiBase, production: production.apiBase }, whopTimeouts, sellerTermsReady });
  const page = (status, text) => (req, res) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : text);
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    if (offers.connectPages?.(req, res, url)) return;
    if (offers.buy.matchBuy(url) || url.pathname.startsWith('/b/')) {
      const site = req.headers['x-test-site'] ? { user_id: String(req.headers['x-test-site']), ...(req.headers['x-test-site-domain'] ? { domain: String(req.headers['x-test-site-domain']) } : {}) } : null;
      return void offers.buy.serveBuy(req, res, url, site, { notFound: page(404, 'NOT FOUND PAGE'), gone: page(410, 'GONE PAGE'), visitor: (r) => String(r.headers['x-test-ip'] ?? 'local') });
    }
    offers.handle(req, res, url).then((handled) => {
      if (handled === false && !res.headersSent) sendJson(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
    }, (e) => {
      logs.push(`crash ${e?.stack ?? e}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'crash', code: 'UNAVAILABLE' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  sandbox.webhookTarget = base;
  production.webhookTarget = base;
  if (stripeMock) stripeMock.connectWebhookUrl = `${base}/api/webhooks/stripe-connect`;

  async function user(email, { isAdmin = false } = {}) {
    const { user: u } = await supa.tokenFor(email);
    const key = crypto.randomUUID();
    people.set(key, { id: u.id, email, isAdmin });
    return { id: u.id, email, key, isAdmin };
  }

  async function call(who, method, path, body, headers = {}) {
    const res = await fetch(`${base}${path}`, { method, headers: { ...(who ? { 'x-test-user': who.key } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  async function visit(path, { method = 'GET', headers = {}, site = null, domain = null } = {}) {
    const res = await fetch(`${base}${path}`, { method, redirect: 'manual', headers: { ...(site ? { 'x-test-site': site } : {}), ...(domain ? { 'x-test-site-domain': domain } : {}), ...headers } });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  /** A seller with a connected Whop account in this environment and one product with one plan. */
  async function seller(email, { environment = 'production', permissions = ALL_PERMISSIONS, price = 49, key = null } = {}) {
    const who = await user(email);
    const mock = environment === 'sandbox' ? sandbox : production;
    const accountId = `biz_${crypto.randomBytes(6).toString('hex')}`;
    const whopKey = key ?? `whop_${environment}_${crypto.randomBytes(16).toString('hex')}`;
    mock.addKey(whopKey, accountId, permissions);
    const [product] = mock.seed(accountId, [{ title: 'Pottery course', plans: [{ title: 'Lifetime', initial_price: price, currency: 'usd' }] }]);
    const res = await call(who, 'POST', '/api/payments/whop', { environment, accountId, key: whopKey });
    return { who, mock, accountId, whopKey, product, plan: product.plans[0], connect: res, connection: res.body?.connection ?? null };
  }

  /** A Whop offer for a seller's plan. */
  const whopOffer = (s, over = {}) => call(s.who, 'POST', '/api/offers', { projectId: 'p1', provider: 'whop', connectionId: s.connection.id, productId: s.product.id, variantId: s.plan.id, clientRequestId: crypto.randomUUID(), ...over });

  /** A seller with a Stripe account (enabled unless enable: false), in the mock's sandbox. → { who, account, row } */
  async function stripeSeller(email, { enable = true, country = 'US', isAdmin = false } = {}) {
    const who = await user(email, { isAdmin });
    const res = await call(who, 'POST', '/api/payments/stripe', { country, acceptTerms: true, clientRequestId: crypto.randomUUID() });
    if (res.status !== 200) throw new Error(`stripeSeller: ${res.status} ${JSON.stringify(res.body)}`);
    const row = (supa.tables.get('connect_accounts') ?? []).find((r) => r.user_id === who.id && r.status !== 'disconnected');
    if (enable) {
      await fetch(`${stripeMock.base}/__accounts/enable`, { method: 'POST', body: JSON.stringify({ id: row.stripe_account_id }) });
      // the account.updated event was delivered and applied (or read it back now)
      await call(who, 'POST', '/api/payments/stripe/sync', {});
    }
    return { who, row: (supa.tables.get('connect_accounts') ?? []).find((r) => r.id === row.id), accountId: row.stripe_account_id };
  }

  return {
    base,
    supa,
    sandbox,
    production,
    stripe: stripeMock,
    stripeSeller,
    db,
    env,
    offers,
    logs,
    clock,
    advance: (ms) => {
      offset += ms;
    },
    user,
    call,
    visit,
    seller,
    whopOffer,
    rows: (table) => supa.tables.get(table) ?? [],
    async close() {
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      await sandbox.close();
      await production.close();
      await stripeMock?.close();
      await supa.close();
    },
  };
}
