// Usage and billing (spec §3, §9.2 WP3): the routes (own usage only, owner-only routes, not set up), caps synced
// to treg with the exact bodies, reconcile on closed UTC days, settling pending rows, and the invoice CSV.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { createBillingRoutes } from './routes.mjs';
import { createLedger } from './ledger.mjs';
import { createCaps, mergeCaps, parseCapFields, BUILTIN_DEFAULTS } from './caps.mjs';
import { createTregAdmin } from './tregAdmin.mjs';
import { reconcile, settlePending, chargedFrom } from './reconcile.mjs';
import { csvCell, invoiceCsv, microToUsd, INVOICE_HEADER } from './invoice.mjs';
import { createMockTreg, MOCK_TREG } from '../test/mock-treg.mjs';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { createDb } from '../integrations/db.mjs';
import { customerTag, ensureCustomer } from '../integrations/common.mjs';

const SECRET = 'test-customer-tag-secret-0123456789';
const DAY = 86_400_000;
let supa;
let mock;
let db;
let users;

function memoryStorage() {
  const docs = new Map();
  return {
    enabled: true,
    docs,
    async get(key) {
      return docs.has(key) ? { value: docs.get(key), updatedAt: 't' } : null;
    },
    async put(key, value) {
      docs.set(key, structuredClone(value));
      return 't';
    },
  };
}

const envFor = (over = {}) => ({ TREG_TOKEN: MOCK_TREG.token, TREG_ADMIN_TOKEN: MOCK_TREG.adminToken, TREG_ORG_ID: MOCK_TREG.org, TREG_BASE_URL: mock.url, CUSTOMER_TAG_SECRET: SECRET, SUPABASE_URL: supa.url, SUPABASE_SECRET_KEY: supa.SECRET, ...over });

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(data);
}
function readJson(req, limit = 1e6) {
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

/** The billing routes behind a bare server; sign-in is "Bearer <user id>" (users map → isAdmin). */
async function serve({ env = envFor(), storage = memoryStorage(), alert = null, limit = () => false, admin = null, connections = null } = {}) {
  const auth = {
    enabled: true,
    async identify(req) {
      const id = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
      const u = [...users.values()].find((x) => x.id === id);
      return u ? { id: u.id, email: u.email, isAdmin: u.isAdmin } : null;
    },
  };
  const routes = createBillingRoutes({ auth, storage, db, treg: { alert: async () => alert }, connections, send, readJson, limit, sameOrigin: (req) => req.headers.origin !== 'https://evil.example', env, ...(admin ? { admin } : {}) });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (!(await routes.handle(req, res, url))) send(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = (who) => async (method, path, body, headers = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { ...(who ? { authorization: `Bearer ${users.get(who).id}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { routes, storage, as, close: () => new Promise((r) => server.close(r)) };
}

const tagOf = (who) => customerTag(users.get(who).id, { CUSTOMER_TAG_SECRET: SECRET });
const iso = (t) => new Date(t).toISOString();
const row = (who, over = {}) => ({ customer_tag: tagOf(who), user_id: users.get(who).id, feature: 'social', vendor: 'treg', endpoint: 'treg.instagram.user.profile', cost_micro: 1000, outcome: 'ok', created_at: iso(Date.now()), ...over });

beforeAll(async () => {
  supa = await (await createMockSupabase()).start();
  db = createDb({ supabaseUrl: supa.url, secretKey: supa.SECRET });
  mock = await createMockTreg().start();
  users = new Map();
  for (const [name, isAdmin] of [
    ['ana', false],
    ['ben', false],
    ['owner', true],
  ]) {
    const { user } = await supa.tokenFor(`${name}@example.com`);
    users.set(name, { id: user.id, email: `${name}@example.com`, isAdmin });
  }
});
afterAll(async () => {
  await mock?.close();
  await supa?.close();
});
beforeEach(async () => {
  mock.reset();
  for (const t of ['usage_ledger', 'billing_caps', 'billing_customers']) supa.tables.set(t, []);
  for (const name of ['ana', 'ben', 'owner']) await ensureCustomer(db, users.get(name).id, { CUSTOMER_TAG_SECRET: SECRET });
});

describe('the routes', () => {
  it('refuse a cross-site page, a signed-out request and too many requests', async () => {
    let over = false;
    const s = await serve({ limit: () => over });
    try {
      expect((await s.as('ana')('GET', '/api/billing/me', null, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await s.as(null)('GET', '/api/billing/me')).json.code).toBe('AUTH_REQUIRED');
      over = true;
      expect((await s.as('ana')('GET', '/api/billing/me')).json.code).toBe('RATE_LIMITED');
    } finally {
      await s.close();
    }
  });

  it('answer 503 NOT_SET_UP until billing is set up, naming the Secrets to the owner only', async () => {
    const s = await serve({ env: envFor({ TREG_ORG_ID: '', TREG_ADMIN_TOKEN: '' }) });
    try {
      // a user's own usage needs only the ledger and the tag secret: their calls are charged without the admin token
      const own = await s.as('ana')('GET', '/api/billing/me');
      expect(own.status).toBe(200);
      expect(own.json.usage.today).toEqual({ costMicro: 0, calls: 0 });
      const forOwner = await s.as('owner')('GET', '/api/billing/customers');
      expect(forOwner.status).toBe(503);
      expect(forOwner.json.hint).toMatch(/TREG_ADMIN_TOKEN, TREG_ORG_ID/);
      expect(forOwner.text).not.toContain(MOCK_TREG.adminToken);
    } finally {
      await s.close();
    }
    const noTag = await serve({ env: envFor({ CUSTOMER_TAG_SECRET: '' }) });
    try {
      const forUser = await noTag.as('ana')('GET', '/api/billing/me');
      expect(forUser.status).toBe(503);
      expect(forUser.json).toEqual({ error: expect.any(String), code: 'NOT_SET_UP' });
      expect((await noTag.as('owner')('GET', '/api/billing/me')).json.hint).toMatch(/CUSTOMER_TAG_SECRET/);
    } finally {
      await noTag.close();
    }
  });

  it('GET /me shows only the user’s own rows: today, month, by feature, recent with plain labels, caps', async () => {
    await db.insert('usage_ledger', [
      row('ana', { cost_micro: 1500 }),
      row('ana', { cost_micro: 2500, feature: 'seo', endpoint: 'crawl4ai.google.serp.organic' }),
      row('ana', { vendor: 'x', estimated: true, cost_micro: 200_000, feature: 'posting', endpoint: 'x:POST /2/tweets' }),
      row('ana', { outcome: 'settled', cost_micro: -500, call_id: 'c'.repeat(32) }),
      row('ben', { cost_micro: 999_999 }),
    ]);
    const s = await serve({ alert: { kind: 'insufficient_balance', at: 'x' } });
    try {
      const { status, json } = await s.as('ana')('GET', '/api/billing/me?days=30');
      expect(status).toBe(200);
      expect(json.usage.today).toEqual({ costMicro: 3500, calls: 2 });
      expect(json.usage.month).toEqual({ costMicro: 3500, calls: 2 });
      expect(json.usage.caps).toEqual({ dailyCapMicro: 250_000, monthlyCapMicro: 3_000_000, status: 'active' });
      expect(json.usage.byFeature).toEqual(
        expect.arrayContaining([
          { feature: 'seo', costMicro: 2500, calls: 1 },
          { feature: 'social', costMicro: 1000, calls: 1 },
          { feature: 'posting', costMicro: 0, calls: 1 },
        ]),
      );
      expect(json.usage.recent.map((r) => [r.label, r.costMicro, r.estimated])).toEqual([
        ['X post', 200_000, true],
        ['Google rank', 2500, false],
        ['Instagram profile', 1500, false],
      ]);
      expect(JSON.stringify(json)).not.toContain(tagOf('ben'));
      expect(JSON.stringify(json)).not.toContain('999999');
      expect(json.alert).toBeUndefined(); // the owner alert is for the owner
      expect((await s.as('owner')('GET', '/api/billing/me')).json.alert).toEqual({ kind: 'insufficient_balance', at: 'x' });
    } finally {
      await s.close();
    }
  });

  it('owner routes answer 403 to everyone else', async () => {
    const s = await serve();
    try {
      for (const [m, p, b] of [
        ['GET', '/api/billing/customers'],
        ['PUT', `/api/billing/customers/${tagOf('ben')}/cap`, { dailyCapMicro: 1 }],
        ['PUT', '/api/billing/defaults', { dailyCapMicro: 1 }],
        ['GET', '/api/billing/reconcile'],
        ['GET', '/api/billing/invoice.csv?month=2026-11'],
      ]) {
        const r = await s.as('ana')(m, p, b);
        expect([p, r.status, r.json?.code]).toEqual([p, 403, 'FORBIDDEN']);
      }
      expect(mock.budgets.perTag.size).toBe(0);
      expect((await s.as('ana')('GET', '/api/billing/nothing')).status).toBe(404);
    } finally {
      await s.close();
    }
  });

  it('GET /customers lists every customer with email, real and estimated costs, calls, today, caps and status', async () => {
    await db.insert('usage_ledger', [row('ana', { cost_micro: 4000 }), row('ana', { vendor: 'nango', estimated: true, cost_micro: 290_000, feature: 'connections', endpoint: 'nango_connection' }), row('ben', { cost_micro: 1000, created_at: iso(Date.now() - 3 * DAY) }), row('ben', { vendor: 'uploadpost', cost_micro: 0, endpoint: 'upload_post upload' }), row('ben', { vendor: 'uploadpost', estimated: true, cost_micro: 1_960_000, feature: 'connections', endpoint: 'upload_post_profile 2026-11' })]);
    await db.insert('billing_caps', { customer_tag: tagOf('ben'), daily_cap_micro: 10, status: 'blocked', synced_to_treg_at: iso(Date.now()) });
    const s = await serve({ alert: { kind: 'platform_daily_cap_reached', at: 'y' } });
    try {
      const { json } = await s.as('owner')('GET', '/api/billing/customers?days=30');
      const ana = json.customers.find((c) => c.customerTag === tagOf('ana'));
      const ben = json.customers.find((c) => c.customerTag === tagOf('ben'));
      expect(ana).toMatchObject({ email: 'ana@example.com', costMicro: 4000, estimatedMicro: 290_000, calls: 1, todayMicro: 4000, caps: {}, status: 'active', lastActivityAt: expect.any(String) });
      expect(ben).toMatchObject({ email: 'ben@example.com', costMicro: 1000, todayMicro: 0, status: 'blocked', syncedToTreg: true, caps: { dailyCapMicro: 10, monthlyCapMicro: null, status: 'blocked' } });
      expect(json.defaults).toMatchObject({ dailyCapMicro: 250_000, monthlyCapMicro: 3_000_000, callsPerDay: 400, postsPerDay: 50, xPostsPerDay: 20, status: 'active' });
      expect(json.alert).toEqual({ kind: 'platform_daily_cap_reached', at: 'y' });
      // each vendor side by side (nango is not one of the columns)
      expect(ana.vendors).toEqual({ treg: { costMicro: 4000, estimatedMicro: 0, calls: 1 } });
      expect(ben.vendors).toEqual({ treg: { costMicro: 1000, estimatedMicro: 0, calls: 1 }, uploadpost: { costMicro: 0, estimatedMicro: 1_960_000, calls: 1 } });
      expect(ben.costMicro).toBe(1000);
    } finally {
      await s.close();
    }
  });

  it('GET /customers: Upload-Post profiles per customer (one per business), their social accounts across businesses, profiles used of the plan and each customer’s limit; the estimated rows per business add up per customer', async () => {
    const est = (who, projectId, month = '2026-10') => row(who, { vendor: 'uploadpost', estimated: true, cost_micro: 1_960_000, feature: 'connections', endpoint: `upload_post_profile ${month}`, project_id: projectId });
    await db.insert('usage_ledger', [est('ana', 'proj_a1'), est('ana', 'proj_a2'), est('ben', 'proj_b1'), row('ana', { vendor: 'uploadpost', cost_micro: 0, feature: 'posting', endpoint: 'x:POST /upload_text', project_id: 'proj_a2' })]);
    const ana = users.get('ana').id;
    const ben = users.get('ben').id;
    const social = {
      accountCount: async (id) => (id === ana ? 5 : id === ben ? 1 : 0),
      profileCount: async (id) => (id === ana ? 2 : id === ben ? 1 : 0),
      ownerView: async () => ({ profilesUsed: 12, profilesLimit: 75, perUserLimit: 3, alert: { kind: 'profile_user_cap', at: 'x', n: 3, customerTag: tagOf('ana') } }),
    };
    const s = await serve({ connections: { impl: { social, ads: null } } });
    try {
      const { json } = await s.as('owner')('GET', '/api/billing/customers?days=30');
      const a = json.customers.find((c) => c.customerTag === tagOf('ana'));
      const b = json.customers.find((c) => c.customerTag === tagOf('ben'));
      expect(a).toMatchObject({ socialAccounts: 5, socialProfiles: 2, estimatedMicro: 3_920_000, vendors: { uploadpost: { costMicro: 0, estimatedMicro: 3_920_000, calls: 1 } } });
      expect(b).toMatchObject({ socialAccounts: 1, socialProfiles: 1, estimatedMicro: 1_960_000 });
      expect(json.upProfiles).toEqual({ used: 12, limit: 75, perCustomer: 3 });
      expect(json.uploadPostAlert).toEqual({ kind: 'profile_user_cap', at: 'x', n: 3, customerTag: tagOf('ana') });
    } finally {
      await s.close();
    }
    // the month's CSV puts both of ana's businesses on her one line
    const csv = invoiceCsv({ month: '2026-10', rows: [est('ana', 'proj_a1'), est('ana', 'proj_a2')] });
    expect(csv.split('\r\n')[1]).toContain(`${tagOf('ana')},,2026-10,0.000000,0,3.920000,0.000000,3.920000,active`);
  });

  it('PUT a customer’s cap stores it and sends treg the merged caps; bad values 400; unknown customers 404', async () => {
    const s = await serve();
    try {
      const tag = tagOf('ana');
      const r = await s.as('owner')('PUT', `/api/billing/customers/${tag}/cap`, { dailyCapMicro: 100_000, monthlyCapMicro: null, note: 'friend of the shop' });
      expect(r.status).toBe(200);
      expect(r.json.cap).toMatchObject({ dailyCapMicro: 100_000, monthlyCapMicro: null, status: 'active', note: 'friend of the shop', syncedToTreg: true });
      expect(mock.budgets.perTag.get(tag)).toEqual({ status: 'active', daily_cap_micro: 100_000, monthly_cap_micro: 3_000_000, calls_per_day: 400 });
      const put = mock.calls.find((c) => c.method === 'PUT' && c.path === `/orgs/${MOCK_TREG.org}/budgets/customer/${tag}`);
      expect(put.headers['x-treg-token']).toBe('[admin-token]');
      const [stored] = await db.select('billing_caps', { customer_tag: tag });
      expect(stored.synced_to_treg_at).toEqual(expect.any(String));
      // block, then back to the defaults (every field null and active): the override goes, here and at treg
      await s.as('owner')('PUT', `/api/billing/customers/${tag}/cap`, { status: 'blocked' });
      expect(mock.budgets.perTag.get(tag).status).toBe('blocked');
      const reset = await s.as('owner')('PUT', `/api/billing/customers/${tag}/cap`, { dailyCapMicro: null, status: 'active', note: '' });
      expect(reset.json.cap.reset).toBe(true);
      expect(await db.select('billing_caps', { customer_tag: tag })).toEqual([]);
      expect(mock.budgets.perTag.has(tag)).toBe(false);
      expect((await s.as('owner')('PUT', `/api/billing/customers/${tag}/cap`, { dailyCapMicro: -5 })).status).toBe(400);
      expect((await s.as('owner')('PUT', `/api/billing/customers/${tag}/cap`, { dailyCapMicro: 1.5 })).status).toBe(400);
      expect((await s.as('owner')('PUT', `/api/billing/customers/${tag}/cap`, { status: 'gone' })).status).toBe(400);
      expect((await s.as('owner')('PUT', `/api/billing/customers/${tag}/cap`, { note: 'x'.repeat(501) })).status).toBe(400);
      expect((await s.as('owner')('PUT', `/api/billing/customers/cust_${'0'.repeat(24)}/cap`, { dailyCapMicro: 1 })).status).toBe(404);
      expect((await s.as('owner')('PUT', '/api/billing/customers/someone@example.com/cap', { dailyCapMicro: 1 })).status).toBe(404);
    } finally {
      await s.close();
    }
  });

  it('a cap that treg doesn’t take is kept, marked not synced', async () => {
    const s = await serve({ env: envFor({ TREG_ADMIN_TOKEN: 'test-wrong-admin-token' }) });
    try {
      const tag = tagOf('ben');
      const r = await s.as('owner')('PUT', `/api/billing/customers/${tag}/cap`, { dailyCapMicro: 5000 });
      expect(r.status).toBe(200);
      expect(r.json.cap.syncedToTreg).toBe(false);
      const [stored] = await db.select('billing_caps', { customer_tag: tag });
      expect(stored).toMatchObject({ daily_cap_micro: 5000, synced_to_treg_at: null });
    } finally {
      await s.close();
    }
  });

  it('PUT the defaults ("Set up caps"): declares the customer dimension once, then the default budget and each override', async () => {
    const s = await serve();
    try {
      await db.insert('billing_caps', { customer_tag: tagOf('ana'), daily_cap_micro: 50_000, status: 'active' });
      const r = await s.as('owner')('PUT', '/api/billing/defaults', { dailyCapMicro: 300_000, monthlyCapMicro: 4_000_000, callsPerDay: 500 });
      expect(r.json.defaults).toMatchObject({ dailyCapMicro: 300_000, monthlyCapMicro: 4_000_000, callsPerDay: 500, postsPerDay: 50, xPostsPerDay: 20, syncedToTreg: true });
      expect(mock.settings).toEqual({ budget_dims: ['customer'], primary_dim: 'customer' });
      expect(mock.budgets.default).toEqual({ status: 'active', daily_cap_micro: 300_000, monthly_cap_micro: 4_000_000, calls_per_day: 500 });
      expect(mock.budgets.perTag.get(tagOf('ana'))).toEqual({ status: 'active', daily_cap_micro: 50_000, monthly_cap_micro: 4_000_000, calls_per_day: 500 });
      await s.as('owner')('PUT', '/api/billing/defaults', { dailyCapMicro: null });
      expect(mock.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
      expect(mock.budgets.default.daily_cap_micro).toBe(BUILTIN_DEFAULTS.daily_cap_micro);
      expect((await s.as('owner')('PUT', '/api/billing/defaults', { status: 'blocked' })).status).toBe(400);
      expect(mock.calls.some((c) => /public-token/.test(c.path))).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('GET /invoice.csv answers the month’s CSV as an attachment; a bad month is 400', async () => {
    await db.insert('usage_ledger', [row('ana', { cost_micro: 333_333, created_at: '2026-11-02T10:00:00.000Z' }), row('ana', { cost_micro: 333_333, created_at: '2026-11-03T10:00:00.000Z' }), row('ana', { cost_micro: 333_333, created_at: '2026-10-31T23:59:59.000Z' })]);
    const s = await serve();
    try {
      const r = await s.as('owner')('GET', '/api/billing/invoice.csv?month=2026-11');
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/^text\/csv/);
      expect(r.headers.get('content-disposition')).toBe('attachment; filename="usage-2026-11.csv"');
      const [header, line] = r.text.trim().split('\r\n');
      expect(header).toBe(INVOICE_HEADER.join(','));
      expect(line).toBe(`${tagOf('ana')},ana@example.com,2026-11,0.666666,2,0.000000,0.000000,0.666666,active`);
      expect((await s.as('owner')('GET', '/api/billing/invoice.csv?month=2026-13')).status).toBe(400);
      expect((await s.as('owner')('GET', '/api/billing/invoice.csv?month==1+1')).status).toBe(400);
    } finally {
      await s.close();
    }
  });

  it('GET /reconcile compares with treg and keeps the report; unattributed spend is flagged', async () => {
    mock.unattributedMicro = 1880;
    const s = await serve();
    try {
      const r = await s.as('owner')('GET', '/api/billing/reconcile?days=30');
      expect(r.status).toBe(200);
      expect(r.json.treg).toEqual({ attributedMicro: 0, unattributedMicro: 1880, totalMicro: 1880, sumOk: true });
      expect(r.json.unattributedOk).toBe(false);
      expect(s.storage.docs.get('billing:lastReconcile')).toMatchObject({ days: 30, unattributedOk: false });
    } finally {
      await s.close();
    }
  });

  it('userDeleted clears the user id from the ledger and keeps the rows by tag', async () => {
    await db.insert('usage_ledger', [row('ben'), row('ben')]);
    const s = await serve();
    try {
      await s.routes.userDeleted(users.get('ben').id);
      const rows = await db.select('usage_ledger', { customer_tag: tagOf('ben') });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.user_id == null)).toBe(true);
    } finally {
      await s.close();
    }
  });
});

describe('caps', () => {
  it('merge the defaults and an override: null inherits, blocked blocks', () => {
    const d = { daily_cap_micro: 1000, monthly_cap_micro: 5000, calls_per_day: 10, posts_per_day: 50, x_posts_per_day: 20 };
    expect(mergeCaps(d, null)).toMatchObject({ ...d, status: 'active' });
    expect(mergeCaps(d, { daily_cap_micro: 3000, monthly_cap_micro: null, status: 'blocked' })).toMatchObject({ daily_cap_micro: 3000, monthly_cap_micro: 5000, status: 'blocked' });
    expect(mergeCaps(null, null)).toMatchObject({ daily_cap_micro: 250_000, monthly_cap_micro: 3_000_000, calls_per_day: 400, posts_per_day: 50, x_posts_per_day: 20 });
    expect(parseCapFields({ dailyCapMicro: 5, xPostsPerDay: null, ignored: 1 })).toEqual({ daily_cap_micro: 5, x_posts_per_day: null });
    expect(() => parseCapFields([])).toThrow();
  });

  it('the pre-check counts treg rows only and blocks before the call', async () => {
    const ledger = createLedger({ db });
    const caps = createCaps({ db, ledger });
    const tag = tagOf('ana');
    await db.insert('usage_ledger', [row('ana', { cost_micro: 240_000 }), row('ana', { vendor: 'nango', estimated: true, cost_micro: 10_000_000, feature: 'connections' })]);
    await expect(caps.check(tag, { estimateMicro: 5000 })).resolves.toBeTruthy();
    await expect(caps.check(tag, { estimateMicro: 20_000 })).rejects.toMatchObject({ kind: 'customer_cap', period: 'day' });
  });
});

describe('reconcile', () => {
  const yesterday = () => iso(Date.parse(`${iso(Date.now()).slice(0, 10)}T00:00:00Z`) - DAY / 2);
  const fakeAdmin = (report, calls = {}) => ({ setUp: true, usageByTag: async () => report, call: async (id) => calls[id] ?? null });

  it('checks attributed + unattributed = total', async () => {
    const ledger = createLedger({ db });
    const ok = await reconcile({ ledger, admin: fakeAdmin({ rows: [], attributed_micro: 10, unattributed_micro: 5, total_micro: 15 }) });
    expect(ok.treg.sumOk).toBe(true);
    expect(ok.unattributedOk).toBe(false);
    const bad = await reconcile({ ledger, admin: fakeAdmin({ rows: [], attributed_micro: 10, unattributed_micro: 0, total_micro: 15 }) });
    expect(bad.treg.sumOk).toBe(false);
  });

  it('reports per-customer differences on closed days, samples our call ids, and lists pending rows apart', async () => {
    const ledger = createLedger({ db });
    const a = tagOf('ana');
    const b = tagOf('ben');
    await db.insert('usage_ledger', [
      row('ana', { cost_micro: 3000, created_at: yesterday(), call_id: '1'.repeat(32) }),
      row('ana', { cost_micro: 1000, created_at: yesterday(), call_id: '2'.repeat(32), outcome: 'settled' }),
      row('ben', { cost_micro: 2000, created_at: yesterday(), call_id: '3'.repeat(32) }),
      row('ben', { cost_micro: 500, created_at: iso(Date.now() - 10 * DAY), outcome: 'pending', call_id: '4'.repeat(32) }),
      row('ben', { vendor: 'x', estimated: true, cost_micro: 15_000, created_at: yesterday() }),
    ]);
    const report = await reconcile({
      ledger,
      admin: fakeAdmin({ rows: [{ value: a, charged_micro: 9000 }, { value: b, charged_micro: 2500 }], attributed_micro: 11_500, unattributed_micro: 0, total_micro: 11_500 }, { ['1'.repeat(32)]: { call_id: '1' } }),
    });
    expect(report.rows.find((r) => r.customerTag === a)).toMatchObject({ tregMicro: 9000, ledgerMicro: 4000, diffMicro: 5000, mismatch: true, checkedCalls: 1, missingAtTreg: 0 });
    expect(report.rows.find((r) => r.customerTag === b)).toMatchObject({ tregMicro: 2500, ledgerMicro: 2500, diffMicro: 0 });
    expect(report.mismatches).toBe(1);
    expect(report.pending).toEqual([{ customerTag: b, callId: '4'.repeat(32), at: expect.any(String) }]);
    expect(report.window.to).toBe(`${iso(Date.now()).slice(0, 10)}T00:00:00.000Z`);
  });

  it('a one-day lag is not a mismatch', async () => {
    const ledger = createLedger({ db });
    const a = tagOf('ana');
    // treg already counts a call our closed window doesn't (made today)
    await db.insert('usage_ledger', row('ana', { cost_micro: 700, created_at: iso(Date.now() - 1000) }));
    const report = await reconcile({ ledger, admin: fakeAdmin({ rows: [{ value: a, charged_micro: 700 }], attributed_micro: 700, unattributed_micro: 0, total_micro: 700 }) });
    expect(report.rows[0]).toMatchObject({ customerTag: a, diffMicro: 700 });
    expect(report.rows[0].mismatch).toBeUndefined();
    expect(report.mismatches).toBe(0);
  });
});

describe('settling pending answers', () => {
  it('writes a correcting row (charged − reserved) once treg has settled, and nothing while it is still pending', async () => {
    const ledger = createLedger({ db });
    const admin = createTregAdmin({ env: envFor() });
    const callId = crypto.randomBytes(16).toString('hex');
    mock.ledger.push({ callId, customer: tagOf('ana'), endpointId: 'treg.instagram.user.posts', charged: null, reserved: 2000, at: iso(Date.now()), outcome: 'pending' });
    await db.insert('usage_ledger', row('ana', { outcome: 'pending', cost_micro: 2000, call_id: callId, created_at: iso(Date.now() - 5 * 60_000) }));
    expect(await settlePending({ ledger, admin })).toBe(0);
    mock.settle(callId, 1500);
    expect(await settlePending({ ledger, admin })).toBe(1);
    expect(await settlePending({ ledger, admin })).toBe(0);
    const rows = await db.select('usage_ledger', { call_id: callId }, { order: 'id.asc' });
    expect(rows.map((r) => [r.outcome, r.cost_micro])).toEqual([
      ['pending', 2000],
      ['settled', -500],
    ]);
    // a fresh pending row (under 2 minutes) waits
    await db.insert('usage_ledger', row('ana', { outcome: 'pending', cost_micro: 2000, call_id: 'f'.repeat(32) }));
    expect(await settlePending({ ledger, admin })).toBe(0);
    // a 410 "uncertain" answer (recorded at 0) is settled the same way
    const lost = crypto.randomBytes(16).toString('hex');
    mock.ledger.push({ callId: lost, customer: tagOf('ana'), endpointId: 'treg.x.user.posts', charged: 900, reserved: 900, at: iso(Date.now()), outcome: 'ok' });
    await db.insert('usage_ledger', row('ana', { outcome: 'error:uncertain', cost_micro: 0, call_id: lost, created_at: iso(Date.now() - 5 * 60_000) }));
    expect(await settlePending({ ledger, admin })).toBe(1);
    expect((await db.select('usage_ledger', { call_id: lost, outcome: 'settled' }))[0].cost_micro).toBe(900);
    expect(chargedFrom({ outcome: 'pending', charged_micro: 5 })).toBeNull();
    expect(chargedFrom({ ledger: { charged_micro: 7 } })).toBe(7);
  });
});

describe('the settle job’s rules', () => {
  it('runs one settle at a time per server, so a slow round can’t write a second settled row', async () => {
    const callId = crypto.randomBytes(16).toString('hex');
    mock.ledger.push({ callId, customer: tagOf('ana'), endpointId: 'treg.instagram.user.posts', charged: 1500, reserved: 2000, at: iso(Date.now()), outcome: 'ok' });
    await db.insert('usage_ledger', row('ana', { outcome: 'pending', cost_micro: 2000, call_id: callId, created_at: iso(Date.now() - 5 * 60_000) }));
    const s = await serve();
    try {
      const [a, b] = await Promise.all([s.routes.settle(), s.routes.settle()]);
      expect([a, b]).toEqual([1, 1]); // the same run, shared
      expect(await db.select('usage_ledger', { call_id: callId, outcome: 'settled' })).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it('settles once per hourly cron tick, not from a timer of its own', async () => {
    const s = await serve();
    try {
      expect(s.routes.stop).toBeUndefined();
      const jobs = s.routes.cronJobs();
      // the treg settle, then the plan jobs (server/billing/stripe.mjs)
      expect(jobs.map((j) => j.name)).toEqual(['treg-settle', 'billing-hourly', 'stripe-reconcile', 'billing-retention']);
      expect(jobs[0]).toEqual(expect.objectContaining({ name: 'treg-settle', everyMs: 60 * 60_000 }));
      expect(await jobs[0].run({})).toEqual({ settled: expect.any(Number) });
    } finally {
      await s.close();
    }
  });

  it('looks back 7 days only, newest first, so rows treg never settles can’t crowd out new ones', async () => {
    const ledger = createLedger({ db });
    const admin = createTregAdmin({ env: envFor() });
    for (let i = 0; i < 3; i++) await db.insert('usage_ledger', row('ana', { outcome: 'pending', cost_micro: 1, call_id: crypto.randomBytes(16).toString('hex'), created_at: iso(Date.now() - 2 * DAY) }));
    const fresh = crypto.randomBytes(16).toString('hex');
    mock.ledger.push({ callId: fresh, customer: tagOf('ana'), endpointId: 'treg.x.user.posts', charged: 900, reserved: 1000, at: iso(Date.now()), outcome: 'ok' });
    await db.insert('usage_ledger', row('ana', { outcome: 'pending', cost_micro: 1000, call_id: fresh, created_at: iso(Date.now() - 5 * 60_000) }));
    const old = crypto.randomBytes(16).toString('hex');
    mock.ledger.push({ callId: old, customer: tagOf('ana'), endpointId: 'treg.x.user.posts', charged: 900, reserved: 1000, at: iso(Date.now()), outcome: 'ok' });
    await db.insert('usage_ledger', row('ana', { outcome: 'pending', cost_micro: 1000, call_id: old, created_at: iso(Date.now() - 8 * DAY) }));
    expect(await settlePending({ ledger, admin, max: 1 })).toBe(1);
    expect(await db.select('usage_ledger', { call_id: fresh, outcome: 'settled' })).toHaveLength(1);
    expect(await settlePending({ ledger, admin })).toBe(0);
    expect(await db.select('usage_ledger', { call_id: old, outcome: 'settled' })).toHaveLength(0);
  });
});

describe('the settle job and one bad call', () => {
  it('a lookup refused for one call (a bad id or a 4xx) skips that row only; treg down stops the round', async () => {
    const ledger = createLedger({ db });
    const good = crypto.randomBytes(16).toString('hex');
    mock.ledger.push({ callId: good, customer: tagOf('ana'), endpointId: 'treg.x.user.posts', charged: 900, reserved: 1000, at: iso(Date.now()), outcome: 'ok' });
    await db.insert('usage_ledger', row('ana', { outcome: 'pending', cost_micro: 1000, call_id: good, created_at: iso(Date.now() - 10 * 60_000) }));
    // a newer row (looked at first) whose lookup is refused
    await db.insert('usage_ledger', row('ana', { outcome: 'pending', cost_micro: 1000, call_id: 'not-a-treg-id', created_at: iso(Date.now() - 5 * 60_000) }));
    const real = createTregAdmin({ env: envFor() });
    const refusing = { ...real, setUp: true, call: async (id) => (id === good ? real.call(id) : Promise.reject(Object.assign(new Error('x'), { name: 'TregError', kind: 'bad_request' }))) };
    expect(await settlePending({ ledger, admin: refusing })).toBe(1);
    expect(await db.select('usage_ledger', { call_id: good, outcome: 'settled' })).toHaveLength(1);
    // treg unreachable: the round stops at the first row (nothing is asked twice in a round)
    const asked = [];
    const down = { setUp: true, call: async (id) => { asked.push(id); throw Object.assign(new Error('x'), { name: 'TregError', kind: 'unavailable' }); } };
    await db.insert('usage_ledger', row('ana', { outcome: 'pending', cost_micro: 1, call_id: crypto.randomBytes(16).toString('hex'), created_at: iso(Date.now() - 4 * 60_000) }));
    expect(await settlePending({ ledger, admin: down })).toBe(0);
    expect(asked).toHaveLength(1);
  });
});

describe('the admin client', () => {
  it('uses the admin token, never public-token, and treats a missing budget or call as nothing', async () => {
    const admin = createTregAdmin({ env: envFor() });
    expect(await admin.budgets.delete(`cust_${'a'.repeat(24)}`)).toBeNull();
    expect(await admin.call('a'.repeat(32))).toBeNull();
    expect((await admin.balance()).balance_micro).toBe(5_000_000);
    expect(mock.calls.every((c) => c.headers['x-treg-token'] === '[admin-token]')).toBe(true);
    const off = createTregAdmin({ env: { TREG_BASE_URL: mock.url } });
    await expect(off.budgets.list()).rejects.toMatchObject({ kind: 'config', hint: expect.stringMatching(/TREG_ADMIN_TOKEN/) });
    expect(Object.keys(admin)).not.toContain('publicToken');
  });

  it('keeps only a plain error code from a refusal: treg’s prose (a balance, a top-up link) never reaches the logs', async () => {
    const lines = [];
    const log = { log: (l) => lines.push(l) };
    const fetch = async () => new Response(JSON.stringify({ error: 'balance 1.23 USD, top up at https://treg.example/topup/x', topup_url: 'https://treg.example/topup/x' }), { status: 400 });
    const admin = createTregAdmin({ env: envFor(), fetch, log });
    const err = await admin.budgets.put(`cust_${'a'.repeat(24)}`, { status: 'active' }).catch((e) => e);
    expect(err).toMatchObject({ kind: 'bad_request', reason: null });
    expect(lines.join('\n')).not.toMatch(/topup|1\.23/);
    const coded = createTregAdmin({ env: envFor(), fetch: async () => new Response(JSON.stringify({ error: 'invalid_budget' }), { status: 400 }), log });
    expect(await coded.budgets.put(`cust_${'a'.repeat(24)}`, {}).catch((e) => e.reason)).toBe('invalid_budget');
  });
});

describe('the invoice CSV', () => {
  it('escapes, guards formulas and sums integer micros', () => {
    expect(csvCell('=cmd|calc')).toBe("'=cmd|calc");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(microToUsd(1)).toBe('0.000001');
    expect(microToUsd(1_234_567)).toBe('1.234567');
    expect(microToUsd(-500)).toBe('-0.000500');
    const tag = 'cust_bbbbbbbbbbbbbbbbbbbbbbbb';
    const rows = [
      ...Array.from({ length: 3 }, () => ({ customer_tag: tag, vendor: 'treg', cost_micro: 100_001, outcome: 'ok' })),
      { customer_tag: tag, vendor: 'treg', cost_micro: -1, outcome: 'settled' },
      { customer_tag: tag, vendor: 'nango', estimated: true, cost_micro: 290_000, outcome: 'ok' },
      { customer_tag: tag, vendor: 'x', estimated: true, cost_micro: 200_000, outcome: 'ok' },
      // Upload-Post's estimated profile row and Zernio's ad accounts count as connections; its real calls cost nothing
      { customer_tag: tag, vendor: 'uploadpost', estimated: true, cost_micro: 1_960_000, outcome: 'ok' },
      { customer_tag: tag, vendor: 'zernio', estimated: true, cost_micro: 6_000_000, outcome: 'ok' },
      { customer_tag: tag, vendor: 'uploadpost', estimated: false, cost_micro: 0, feature: 'posting', outcome: 'ok' },
    ];
    const csv = invoiceCsv({ month: '2026-11', rows, emails: new Map([[tag, '=HYPERLINK("http://x")']]), statuses: new Map([[tag, 'blocked']]) });
    expect(csv.split('\r\n')[1]).toBe(`${tag},"'=HYPERLINK(""http://x"")",2026-11,0.300002,3,8.250000,0.200000,8.750002,blocked`);
  });
});
