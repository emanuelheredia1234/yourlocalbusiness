// Test harness for the public marketplace (tests only): mock Supabase (tables, Storage, the set-public function), a
// plans facade (Launch by default), an in-memory app_state, a fake treg (no live calls), the market module and the
// sitemap behind a bare HTTP server that answers /api/market…, /market…, /sitemap.xml and /robots.txt. A signed-in user
// per header; the visitor per x-test-ip. Every log line is captured.

import http from 'node:http';
import crypto from 'node:crypto';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { createDb } from '../integrations/db.mjs';
import { createBucketLimiter } from '../integrations/common.mjs';
import { readJson, sendJson } from '../billing/test-helpers.mjs';
import { fakeTreg, makeStorage } from '../analytics/test-helpers.mjs';
import { testBilling } from '../offers/test-helpers.mjs';
import { createSitemapRoutes } from '../seo/sitemap.mjs';
import { createMarket } from './index.mjs';

export const APP = 'https://yourlocalbusiness.replit.app';
export const TAG_SECRET = 'test-customer-tag-secret-0123456789';
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A tiny real PNG's first bytes (the mock doesn't sniff). */
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

export const DESCRIPTION = 'Hand-thrown stoneware mugs made in our small studio by the river. Each mug holds about twelve ounces, is glazed in a food-safe satin finish, and goes through the dishwasher without fading. We fire every piece twice and check it by hand before it leaves the shop, so you get a sturdy everyday mug that feels good to hold.';

/** opts: env overrides; treg (a fake treg); sitemap: also serve /sitemap.xml and /robots.txt. */
export async function marketServer({ env: envOver = {}, treg: tregOver = null, now: nowOver = null } = {}) {
  let offset = 0;
  const clock = nowOver ?? (() => Date.now() + offset);
  const supa = await (await createMockSupabase()).start();
  const db = createDb({ supabaseUrl: supa.url, secretKey: supa.SECRET });
  const env = { SUPABASE_URL: supa.url, SUPABASE_SECRET_KEY: supa.SECRET, GSC_APP_PROPERTY: `${APP}/`, CUSTOMER_TAG_SECRET: TAG_SECRET, MARKET_REPORT_SECRET: 'test-market-report-secret-0123', ...envOver };
  const people = new Map();
  const logs = [];
  const log = { log: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)), error: (...a) => logs.push(a.map(String).join(' ')) };
  const auth = { enabled: true, identify: async (req) => people.get(String(req.headers['x-test-user'] ?? '')) ?? null };
  const billing = testBilling({ now: clock });
  const storage = makeStorage();
  const treg = tregOver ?? fakeTreg(() => ({}));
  const limiter = createBucketLimiter({ now: clock });
  const market = createMarket({ auth, db, storage, treg, send: sendJson, readJson, limit: limiter, env, now: clock, log, billing, visitor: (req) => String(req.headers['x-test-ip'] ?? 'visitor-1') });
  const sitemap = createSitemapRoutes({ db, env, now: clock, log });
  sitemap.setMarket(market);
  market.setSitemap(sitemap);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    const fail = (e) => {
      logs.push(`crash ${e?.stack ?? e}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'crash', code: 'UNAVAILABLE' });
    };
    if (market.publicRoutes.match(url)) return void market.publicRoutes.handle(req, res, url).catch(fail);
    if (url.pathname === '/sitemap.xml' || url.pathname === '/robots.txt') {
      return void sitemap.handle(req, res, url).then((h) => h || sendJson(res, 404, { code: 'NOT_FOUND' }), fail);
    }
    market.handle(req, res, url).then((handled) => {
      if (handled === false && !res.headersSent) sendJson(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
    }, fail);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function user(email, { isAdmin = false, tier = 'launch', status = 'active', trialing = false } = {}) {
    const { user: u } = await supa.tokenFor(email);
    const key = crypto.randomUUID();
    people.set(key, { id: u.id, email, isAdmin });
    billing.plans.set(u.id, { user_id: u.id, tier, source: 'stripe', status: trialing ? 'trialing' : status, business_limit: 1, ...(trialing ? { trial_ends_at: new Date(clock() + 5 * 86_400_000).toISOString() } : {}) });
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

  async function visit(path, { method = 'GET', headers = {}, body } = {}) {
    const res = await fetch(`${base}${path}`, { method, redirect: 'manual', headers, ...(body !== undefined ? { body } : {}) });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  /** A hosted listing image in the seller's public-files folder → its path. */
  function image(who, name = null) {
    const file = name ?? `l-${b64url(crypto.randomBytes(16))}.png`;
    supa.objects.set(`public-files/${who.id}/${file}`, { bytes: PNG, type: 'image/png', created: Date.now() });
    return `${who.id}/${file}`;
  }

  /** An offer row of this seller. */
  function offer(who, over = {}) {
    const id = b64url(crypto.randomBytes(16)).slice(0, 22);
    const row = { id, user_id: who.id, project_id: 'p1', title: 'Mug', provider: 'external', provider_ref: { url: 'https://buy.stripe.com/x' }, status: 'active', price_minor: null, currency: null, created_at: new Date().toISOString(), ...over };
    (supa.tables.get('offers') ?? supa.tables.set('offers', []).get('offers')).push(row);
    return row;
  }

  /** A full, indexable listing body for PUT. */
  const listing = (who, over = {}) => ({
    projectId: 'p1',
    kind: 'product',
    title: 'Stoneware mug, river glaze',
    tagline: 'A sturdy everyday mug made by hand',
    description: DESCRIPTION,
    category: 'Home & Kitchen',
    tags: ['mug', 'pottery', 'handmade'],
    price: 34,
    priceModel: 'one-time',
    sellerName: 'River Pottery',
    website: 'https://riverpottery.example.com',
    location: { city: 'Portland', region: 'OR', lat: 45.5, lng: -122.6 },
    coverPath: image(who),
    ...over,
  });

  const put = (who, id, body) => call(who, 'PUT', `/api/market/public/${id}`, body);

  return {
    base,
    supa,
    db,
    env,
    market,
    sitemap,
    billing,
    storage,
    treg,
    logs,
    clock,
    advance: (ms) => {
      offset += ms;
    },
    user,
    call,
    visit,
    image,
    offer,
    listing,
    put,
    rows: (table) => supa.tables.get(table) ?? [],
    async close() {
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      await supa.close();
    },
  };
}
