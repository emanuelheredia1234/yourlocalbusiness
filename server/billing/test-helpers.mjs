// Test harness for plans and billing (tests only): mock Supabase with the billing migration's emulation, mock Stripe
// with the eight plan prices and its webhooks pointed at the billing routes, and a signed-in user per header. A shared
// clock (offset from the real one) moves the server, the database and Stripe forward together. Nothing leaves the
// machine.

import http from 'node:http';
import crypto from 'node:crypto';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { createMockStripe, TEST_STRIPE_KEY, TEST_STRIPE_WEBHOOK_SECRET } from '../test/mock-stripe.mjs';
import { createDb } from '../integrations/db.mjs';
import { createBucketLimiter, readRaw } from '../integrations/common.mjs';
import { createBillingRoutes } from './routes.mjs';
import { PRICE_TABLE } from './plans.mjs';

export const TAG_SECRET = 'test-customer-tag-secret-0123456789';
export const APP_URL = 'https://app.example.test';

export function sendJson(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(data);
}

export function readJson(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) reject(Object.assign(new Error('too large'), { status: 413 }));
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('bad json'), { status: 400 }));
      }
    });
  });
}

/** The eight plan prices in mock Stripe, as the setup script makes them. */
export async function seedPrices(stripeMock) {
  const call = (path, body) =>
    fetch(`${stripeMock.apiBase}${path}`, { method: 'POST', headers: { authorization: `Bearer ${TEST_STRIPE_KEY}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() }).then((r) => r.json());
  const made = new Set();
  for (const [key, p] of Object.entries(PRICE_TABLE)) {
    if (!made.has(p.product)) {
      await call('/v1/products', { id: p.product, name: p.productName });
      made.add(p.product);
    }
    await call('/v1/prices', { product: p.product, currency: 'usd', unit_amount: String(p.amount), lookup_key: key, 'recurring[interval]': p.interval });
  }
}

/**
 * A running billing server. opts: env overrides, enforce (billing_settings.enforce), seed (the prices; default true),
 * log (a spy). Returns { base, supa, stripe, db, routes, plans, logs, clock, advance(ms), user(email, {admin}), call(…),
 * close() }.
 */
export async function billingServer({ env: envOver = {}, enforce = true, seed = true, webhook = true } = {}) {
  let offset = 0;
  const clock = () => Date.now() + offset;
  const supa = await createMockSupabase({ projectSlots: true }).then((m) => m.start());
  supa.behavior.now = clock;
  const stripe = await createMockStripe({ now: clock }).start();
  if (seed) await seedPrices(stripe);
  const db = createDb({ supabaseUrl: supa.url, secretKey: supa.SECRET });
  const env = { STRIPE_SECRET_KEY: TEST_STRIPE_KEY, STRIPE_WEBHOOK_SECRET: TEST_STRIPE_WEBHOOK_SECRET, STRIPE_API_BASE: stripe.apiBase, CUSTOMER_TAG_SECRET: TAG_SECRET, SUPABASE_URL: supa.url, SUPABASE_SECRET_KEY: supa.SECRET, APP_URL, ...envOver };
  const people = new Map(); // header value → who
  const logs = [];
  const log = { log: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)), error: (line) => logs.push(String(line)) };
  const auth = { enabled: true, identify: async (req) => people.get(String(req.headers['x-test-user'] ?? '')) ?? null };
  const limiter = createBucketLimiter({ now: clock });
  const routes = createBillingRoutes({ auth, db, send: sendJson, readJson, readRaw, limit: limiter, env, now: clock, log });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    routes.handle(req, res, url).then((handled) => {
      if (handled === false && !res.headersSent) sendJson(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
    }, (e) => {
      logs.push(`crash ${e?.stack ?? e}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'crash', code: 'UNAVAILABLE' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  if (webhook) stripe.webhookUrl = `${base}/api/webhooks/stripe`;
  supa.tables.set('billing_settings', [{ id: 1, enforce, enforced_at: enforce ? new Date().toISOString() : null, card_trial_days: 0, existing_trial_days: 30 }]);

  async function user(email, { admin = false } = {}) {
    const { token, user: u } = await supa.tokenFor(email, 'password123', admin ? { appMetadata: { ylb_role: 'admin' } } : {});
    const key = crypto.randomUUID();
    people.set(key, { id: u.id, email, isAdmin: admin });
    return { id: u.id, email, key, token };
  }

  async function call(who, method, path, body) {
    const res = await fetch(`${base}${path}`, { method, headers: { ...(who ? { 'x-test-user': who.key } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json, text };
  }

  /** Sign up through Checkout and complete it (mock): → the subscription. */
  async function subscribe(who, { tier = 'grow', interval = 'month', extraBusinesses = 0 } = {}) {
    const co = await call(who, 'POST', '/api/billing/checkout', { tier, interval, extraBusinesses, clientRequestId: crypto.randomUUID() });
    if (co.status !== 200) throw new Error(`checkout ${co.status} ${co.text}`);
    const id = co.body.url.split('/__pay/')[1];
    const done = await (await fetch(`${stripe.base}/__checkout/complete`, { method: 'POST', body: JSON.stringify({ id }) })).json();
    return done.subscription;
  }

  const account = (who) => (supa.tables.get('billing_accounts') ?? []).find((r) => r.user_id === who.id) ?? null;
  const slots = (who) => (supa.tables.get('project_slots') ?? []).filter((r) => r.user_id === who.id);
  const claim = async (who, projectId) => {
    const res = await fetch(`${supa.url}/rest/v1/rpc/claim_project_slot`, { method: 'POST', headers: { apikey: supa.PUBLISHABLE, authorization: `Bearer ${who.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ p_project_id: projectId }) });
    return res.json();
  };
  const writes = () => stripe.calls.filter((c) => c.method && c.method !== 'GET');

  return {
    base,
    supa,
    stripe,
    db,
    env,
    routes,
    plans: routes.plans,
    logs,
    clock,
    advance: (ms) => {
      offset += ms;
    },
    user,
    call,
    subscribe,
    account,
    slots,
    claim,
    writes,
    async close() {
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      await stripe.close();
      await supa.close();
    },
  };
}
