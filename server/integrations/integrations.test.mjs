// The shared integration pieces (WP0): helpers, the PostgREST client against the mock Supabase (the new tables,
// identities, partial unique indexes and the claim_analytics_run slot), the connections interface and its
// off state, and the contracts shared with the app.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import {
  IntegrationError,
  createBucketLimiter,
  customerTag,
  ensureCustomer,
  errorBody,
  fail,
  mask,
  notSetUp,
  oneShot,
  projectTag,
  readRaw,
  redactPath,
  safeLog,
  seoPageIdFor,
  stubRoutes,
  unlogged,
} from './common.mjs';
import { createDb, DbError, filterQuery } from './db.mjs';
import { AD_PLATFORMS, ANALYTICS_SOURCES, API_ERROR_CODES, PHASE1_PLATFORMS, PHASE2_PLATFORMS, PLATFORMS, SOCIAL_PLATFORMS } from './contracts.mjs';
import { CONNECTION_METHODS, createConnections, nullConnections } from '../connections/index.mjs';
import { AD_PLATFORMS as CLIENT_ADS, ANALYTICS_SOURCES as CLIENT_SOURCES, CONNECT_PLATFORMS, PHASE2_PLATFORMS as CLIENT_PHASE2, SOCIAL_PLATFORMS as CLIENT_SOCIAL } from '../../src/lib/integrations/types.ts';
import { seoPageId } from '../../src/lib/seoPage.ts';
import { TREG_ENDPOINTS } from '../treg-endpoints.mjs';
import { createTreg, TregError } from '../treg.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENV = { CUSTOMER_TAG_SECRET: 'test-customer-tag-secret-0123456789' };

let supa;
let db;
beforeAll(async () => {
  supa = await (await createMockSupabase()).start();
  db = createDb({ supabaseUrl: supa.url, secretKey: supa.SECRET });
});
afterAll(async () => {
  await supa.close();
});

// ───────────── helpers ─────────────

describe('customer and business tags', () => {
  it('are opaque, stable, [a-z0-9_] only, and never the email or id', () => {
    const id = '0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11';
    const tag = customerTag(id, ENV);
    expect(tag).toMatch(/^cust_[0-9a-f]{24}$/);
    expect(customerTag(id, ENV)).toBe(tag);
    expect(customerTag('0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a12', ENV)).not.toBe(tag);
    expect(tag).not.toContain(id.slice(0, 8));
    expect(projectTag(id, 'proj_1', ENV)).toMatch(/^biz_[0-9a-f]{16}$/);
    expect(projectTag(id, 'proj_2', ENV)).not.toBe(projectTag(id, 'proj_1', ENV));
  });

  it('refuse to work without CUSTOMER_TAG_SECRET, naming it only for the owner', () => {
    let e;
    try {
      customerTag('0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11', {});
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(IntegrationError);
    expect(e.code).toBe('NOT_SET_UP');
    expect(errorBody(e, { isAdmin: false }).body).toEqual({ error: expect.any(String), code: 'NOT_SET_UP' });
    expect(errorBody(e, { isAdmin: true }).body.hint).toMatch(/CUSTOMER_TAG_SECRET/);
  });
});

describe('seoPageIdFor', () => {
  it('gives the same id as the app’s seoPageId for the same project', () => {
    for (const id of ['proj_abc', 'p 1/2:x', 'ü-ñ_ok', 'x'.repeat(120)]) {
      expect(seoPageIdFor(id)).toBe(seoPageId({ id }));
    }
  });
});

describe('mask, safeLog and log paths', () => {
  it('masks to the last 4 characters at most', () => {
    expect(mask('test-nango-key-abcd1234')).toBe('…1234');
    expect(mask('short')).toBe('…');
    expect(mask(undefined)).toBe('…');
  });

  it('drops every token, secret, key, authorization, cookie and link field, at any depth', () => {
    const logger = { log: vi.fn() };
    safeLog('connect', { platform: 'facebook', connectLink: 'https://x/connect?session_token=abc', nested: { access_token: 't', apiKey: 'k', ok: 1 }, Authorization: 'Bearer z', cookie: 'c', webhookSecret: 's' }, logger);
    const line = logger.log.mock.calls[0][0];
    expect(JSON.parse(line)).toEqual({ event: 'connect', platform: 'facebook', nested: { ok: 1 } });
    expect(line).not.toMatch(/session_token|Bearer|abc/);
  });

  it('never logs a media token or anything after a webhook’s name', () => {
    expect(redactPath('/api/media/public/eyJ1Ijoi.c2ln')).toBe('/api/media/public/[token]');
    expect(redactPath('/api/webhooks/nango/extra?x=1')).toBe('/api/webhooks/nango');
    expect(redactPath('/api/posting/jobs/1?x=1')).toBe('/api/posting/jobs/1');
    expect(unlogged('/api/media/public/abc')).toBe(true);
    expect(unlogged('/api/webhooks/nango')).toBe(true);
    expect(unlogged('/api/posting/publish')).toBe(false);
  });
});

describe('readRaw', () => {
  it('returns the exact bytes, and refuses a body over the limit', async () => {
    const req = new PassThrough();
    const got = readRaw(req, 64);
    req.end(Buffer.from('{"a": 1,  "b":"é"}'));
    expect((await got).toString('utf8')).toBe('{"a": 1,  "b":"é"}');
    const big = new PassThrough();
    const over = readRaw(big, 8);
    big.write(Buffer.alloc(16));
    await expect(over).rejects.toMatchObject({ status: 413 });
  });
});

describe('oneShot', () => {
  it('runs once and never again, whatever happens', async () => {
    const ok = vi.fn(async () => ({ status: 201, id: 'p1' }));
    expect(await oneShot(ok)).toEqual({ outcome: 'ok', value: { status: 201, id: 'p1' } });
    const refused = vi.fn(async () => ({ status: 400 }));
    expect((await oneShot(refused)).outcome).toBe('failed');
    const server = vi.fn(async () => ({ status: 502 }));
    expect(await oneShot(server)).toMatchObject({ outcome: 'unknown', reason: 'upstream' });
    const thrown = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    expect(await oneShot(thrown)).toEqual({ outcome: 'unknown', reason: 'error' });
    const slow = vi.fn((signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ status: 200 }))));
    expect(await oneShot(slow, { timeoutMs: 20 })).toEqual({ outcome: 'unknown', reason: 'timeout' });
    for (const f of [ok, refused, server, thrown, slow]) expect(f).toHaveBeenCalledTimes(1);
  });

  it('treats our own 4xx refusal before the call as failed (nothing was sent)', async () => {
    expect((await oneShot(async () => {
      throw fail(400, 'MEDIA_UNSUPPORTED', 'JPEG only');
    })).outcome).toBe('failed');
  });
});

describe('bucket limits', () => {
  it('counts per bucket and user, with their own windows', () => {
    let t = 0;
    const limit = createBucketLimiter({ now: () => t, limits: { 'integrations-connect': [{ limit: 2, windowMs: 3_600_000 }] } });
    expect(limit('integrations-connect', 'u1')).toBe(false);
    expect(limit('integrations-connect', 'u1')).toBe(false);
    expect(limit('integrations-connect', 'u1')).toBe(true);
    expect(limit('integrations-connect', 'u2')).toBe(false);
    t = 3_600_001;
    expect(limit('integrations-connect', 'u1')).toBe(false);
    expect(() => limit('nope', 'u1')).toThrow();
  });
});

describe('stubRoutes', () => {
  it('answers 503 NOT_SET_UP under its prefix only, without reading the body', async () => {
    const send = vi.fn();
    const r = stubRoutes({ prefixes: '/api/posting/', send });
    const req = new PassThrough();
    req.headers = {};
    expect(await r.handle(req, {}, new URL('http://x/api/posting/publish'))).toBe(true);
    expect(send).toHaveBeenCalledWith({}, 503, expect.objectContaining({ code: 'NOT_SET_UP' }), {});
    expect(await r.handle(req, {}, new URL('http://x/api/postingx'))).toBe(false);
    expect(req.readableFlowing).toBe(null);
  });
});

// ───────────── the database (mock Supabase) ─────────────

describe('the integrations migration', () => {
  const sql = fs.readFileSync(path.join(here, '..', '..', 'supabase', 'migrations', '20261105000000_integrations.sql'), 'utf8');
  it('creates every table server-only (row-level security, no policies) and the slot function', () => {
    for (const t of ['billing_customers', 'billing_caps', 'usage_ledger', 'analytics_settings', 'analytics_snapshots', 'analytics_runs', 'analytics_history', 'webhook_deliveries', 'seo_google_steps', 'post_publish_jobs']) {
      expect(sql).toContain(`create table if not exists public.${t} (`);
      expect(sql).toContain(`alter table public.${t} enable row level security;`);
    }
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).toMatch(/revoke all on function public\.claim_analytics_run\(uuid, text, uuid, jsonb\) from public, anon, authenticated;/);
    expect(sql).toMatch(/post_publish_jobs_one_live[\s\S]*where state in \('queued', 'sending', 'sent', 'unknown'\)/);
    // the ledger outlives the account (no foreign key on user_id)
    expect(/create table if not exists public\.usage_ledger \([\s\S]*?\n\);/.exec(sql)[0]).not.toMatch(/references/);
  });
});

describe('the PostgREST client', () => {
  it('builds filters safely', () => {
    expect(filterQuery({ user_id: 'u', state: ['in', ['queued', 'sending']], at: ['lt', '2026-01-01'], domain: null }).toString()).toBe('user_id=eq.u&state=in.%28%22queued%22%2C%22sending%22%29&at=lt.2026-01-01&domain=is.null');
    expect(() => filterQuery({ 'x;drop': 1 })).toThrow(DbError);
    expect(() => filterQuery({ a: ['like', 'x'] })).toThrow(DbError);
  });

  it('is off without Supabase, and refuses whole-table updates and deletes', async () => {
    const off = createDb({});
    expect(off.enabled).toBe(false);
    await expect(off.select('usage_ledger')).rejects.toMatchObject({ code: 'NOT_SET_UP' });
    await expect(db.update('usage_ledger', {}, { cost_micro: 0 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(db.remove('usage_ledger', {})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('numbers ledger rows itself and keeps them when the account goes', async () => {
    const { user } = await supa.tokenFor('ledger@example.com');
    await db.insert('usage_ledger', [{ customer_tag: 'cust_aaaaaaaaaaaaaaaaaaaaaaaa', user_id: user.id, feature: 'social', vendor: 'treg', endpoint: 'ig.profile', cost_micro: 3000, outcome: 'ok' }]);
    const [second] = await db.insert('usage_ledger', { customer_tag: 'cust_aaaaaaaaaaaaaaaaaaaaaaaa', user_id: user.id, feature: 'social', vendor: 'treg', endpoint: 'ig.posts', cost_micro: 4000, outcome: 'ok' }, { returning: true });
    expect(second.id).toBeGreaterThan(0);
    await expect(db.insert('usage_ledger', { id: 99, customer_tag: 'c', feature: 'social', vendor: 'treg', endpoint: 'x', outcome: 'ok' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const rows = await db.select('usage_ledger', { customer_tag: 'cust_aaaaaaaaaaaaaaaaaaaaaaaa' }, { order: 'id.asc' });
    expect(rows.map((r) => r.endpoint)).toEqual(['ig.profile', 'ig.posts']);
    expect(rows[1].id).toBe(rows[0].id + 1);
    // deleting the account cascades everywhere except the ledger
    await db.insert('analytics_settings', { user_id: user.id, project_id: 'p1', settings: {}, resolved: {} });
    await fetch(`${supa.url}/auth/v1/admin/users/${user.id}`, { method: 'DELETE', headers: { apikey: supa.SECRET } });
    expect(await db.select('usage_ledger', { user_id: user.id })).toHaveLength(2);
    expect(await db.select('analytics_settings', { user_id: user.id })).toHaveLength(0);
  });

  it('refuses a second live publish of the same post to the same network (409 with the index name)', async () => {
    const { user } = await supa.tokenFor('jobs@example.com');
    const job = (over) => ({ id: crypto.randomUUID(), user_id: user.id, project_id: 'p1', post_id: 'post_1', platform: 'x', client_request_id: crypto.randomUUID(), state: 'sending', ...over });
    await db.insert('post_publish_jobs', job());
    await expect(db.insert('post_publish_jobs', job({ state: 'queued' }))).rejects.toMatchObject({ status: 409, code: 'CONFLICT', constraint: 'post_publish_jobs_one_live' });
    // a failed one doesn't hold the slot; another network or post is fine
    await db.insert('post_publish_jobs', job({ state: 'failed' }));
    await db.insert('post_publish_jobs', job({ platform: 'facebook' }));
    // the same click twice is one job
    const reqId = crypto.randomUUID();
    await db.insert('post_publish_jobs', job({ post_id: 'post_2', client_request_id: reqId }));
    await expect(db.insert('post_publish_jobs', job({ post_id: 'post_3', client_request_id: reqId }))).rejects.toMatchObject({ constraint: 'post_publish_jobs_user_id_client_request_id_key' });
    // an update into a live state that would clash is refused too
    const [failed] = await db.select('post_publish_jobs', { user_id: user.id, post_id: 'post_1', state: 'failed' });
    await expect(db.update('post_publish_jobs', { id: failed.id, user_id: user.id }, { state: 'queued' })).rejects.toMatchObject({ code: 'CONFLICT' });
    // a job for a user that doesn't exist is refused (foreign key)
    await expect(db.insert('post_publish_jobs', job({ user_id: crypto.randomUUID() }))).rejects.toMatchObject({ code: 'FOREIGN_KEY' });
  });

  it('claims the 15-minute Update slot once, even for two presses at the same moment', async () => {
    const { user } = await supa.tokenFor('runs@example.com');
    const claim = (project) => db.rpc('claim_analytics_run', { p_user: user.id, p_project: project, p_id: crypto.randomUUID(), p_sources: { social: 'queued', ads: 'queued', seo: 'queued', email: 'queued' } });
    const [a, b] = await Promise.all([claim('biz_1'), claim('biz_1')]);
    expect([a.length, b.length].sort()).toEqual([0, 1]);
    const run = (a[0] ?? b[0]);
    expect(run).toMatchObject({ user_id: user.id, project_id: 'biz_1', state: 'running' });
    expect(await claim('biz_1')).toEqual([]);
    // another business has its own slot
    expect(await claim('biz_2')).toHaveLength(1);
    // 16 minutes later, a finished run doesn't hold it; one still marked running does (the sweep ends it first)
    const runs = supa.tables.get('analytics_runs');
    for (const r of runs) if (r.project_id === 'biz_1') r.started_at = new Date(Date.now() - 16 * 60_000).toISOString();
    expect(await claim('biz_1')).toEqual([]);
    for (const r of runs) if (r.project_id === 'biz_1') r.state = 'done';
    expect(await claim('biz_1')).toHaveLength(1);
  });

  it('answers NOT_SET_UP naming the migration when it wasn’t run', async () => {
    const bare = await (await createMockSupabase({ missingTables: ['usage_ledger', 'analytics_runs'] })).start();
    try {
      const d = createDb({ supabaseUrl: bare.url, secretKey: bare.SECRET });
      await expect(d.select('usage_ledger')).rejects.toMatchObject({ code: 'NOT_SET_UP', message: expect.stringContaining('20261105000000_integrations.sql') });
      await expect(d.rpc('claim_analytics_run', {})).rejects.toMatchObject({ code: 'NOT_SET_UP' });
    } finally {
      await bare.close();
    }
  });

  it('keeps the tables away from signed-in browsers', async () => {
    const { token } = await supa.tokenFor('browser@example.com');
    for (const t of ['usage_ledger', 'billing_customers', 'post_publish_jobs', 'analytics_snapshots']) {
      const r = await fetch(`${supa.url}/rest/v1/${t}?select=*`, { headers: { apikey: supa.PUBLISHABLE, authorization: `Bearer ${token}` } });
      expect(r.status).toBe(401);
    }
    const rpc = await fetch(`${supa.url}/rest/v1/rpc/claim_analytics_run`, { method: 'POST', headers: { apikey: supa.PUBLISHABLE, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(rpc.status).toBe(401);
  });

  it('ensureCustomer makes the billing row once', async () => {
    const { user } = await supa.tokenFor('customer@example.com');
    const tag = await ensureCustomer(db, user.id, ENV);
    expect(await ensureCustomer(db, user.id, ENV)).toBe(tag);
    expect(await db.select('billing_customers', { user_id: user.id })).toEqual([expect.objectContaining({ customer_tag: tag, user_id: user.id })]);
    await expect(ensureCustomer(db, 'not-a-uuid', ENV)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('says whether a media file exists (HEAD with the secret key), another user’s missing path included', async () => {
    const { user } = await supa.tokenFor('media@example.com');
    supa.objects.set(`media/${user.id}/m1`, { bytes: Buffer.from('abc'), type: 'image/jpeg', created: Date.now() });
    const head = (p) => fetch(`${supa.url}/storage/v1/object/media/${p}`, { method: 'HEAD', headers: { apikey: supa.SECRET } });
    const hit = await head(`${user.id}/m1`);
    expect(hit.status).toBe(200);
    expect(hit.headers.get('content-length')).toBe('3');
    expect((await head(`${crypto.randomUUID()}/m1`)).status).toBe(404);
  });
});

// ───────────── connections ─────────────

describe('connections', () => {
  const uid = '0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11';

  it('off: every network not connected (phase 2: coming soon), and nothing can be connected', async () => {
    const c = createConnections(nullConnections);
    expect(c.enabled).toBe(false);
    const list = await c.status(uid);
    expect(list.map((s) => s.platform)).toEqual([...PLATFORMS]);
    for (const s of list) expect(s.state).toBe(PHASE2_PLATFORMS.includes(s.platform) ? 'coming_soon' : 'not_connected');
    await expect(c.connectLink(uid, 'facebook')).rejects.toMatchObject({ status: 503, code: 'CONNECTIONS_NOT_ENABLED' });
    await expect(c.publish(uid, 'x', { jobId: uid })).rejects.toMatchObject({ code: 'CONNECTIONS_NOT_ENABLED' });
    expect(await c.insights(uid, 'facebook', {})).toBeNull();
    expect(await c.adResults(uid, 'meta_ads', {})).toBeNull();
    expect(await c.check(uid, 'linkedin')).toEqual({ platform: 'linkedin', state: 'not_connected' });
  });

  it('checks the user and the platform before the implementation sees them', async () => {
    const impl = Object.fromEntries(CONNECTION_METHODS.map((m) => [m, vi.fn(async () => 'ok')]));
    const c = createConnections(impl);
    await expect(c.connectLink('someone', 'facebook')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(c.connectLink(uid, 'myspace')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(c.connectLink(uid, 'google_search_console')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // a business id that isn't a plain id never reaches the implementation
    await c.status(uid, { projectId: '../../etc' });
    expect(impl.status).toHaveBeenLastCalledWith(uid, { projectId: undefined });
    expect(impl.connectLink).not.toHaveBeenCalled();
    expect(await c.connectLink(uid, 'facebook')).toBe('ok');
    expect(() => createConnections({ status() {} })).toThrow(/connectLink/);
  });
});

// ───────────── contracts ─────────────

describe('the contracts on both sides', () => {
  it('list the same platforms, sources and error codes', () => {
    expect([...CONNECT_PLATFORMS]).toEqual([...PLATFORMS]);
    expect([...CLIENT_PHASE2]).toEqual([...PHASE2_PLATFORMS]);
    expect([...CLIENT_SOURCES]).toEqual([...ANALYTICS_SOURCES]);
    expect(PHASE1_PLATFORMS).toEqual(['facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube', 'google_ads', 'meta_ads', 'linkedin_ads', 'tiktok_ads', 'pinterest_ads', 'x_ads', 'reddit_ads', 'microsoft_ads']);
    expect([...CLIENT_SOCIAL]).toEqual([...SOCIAL_PLATFORMS]);
    expect([...CLIENT_ADS]).toEqual([...AD_PLATFORMS]);
    const ts = fs.readFileSync(path.join(here, '..', '..', 'src', 'lib', 'integrations', 'types.ts'), 'utf8');
    const union = /export type ApiErrorCode =([\s\S]*?);/.exec(ts)[1];
    expect([...union.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1])).toEqual([...API_ERROR_CODES]);
  });
});

describe('the treg placeholders', () => {
  it('refuse every call as config, and say what is set up without reading the admin token for calls', async () => {
    const t = createTreg({ env: { TREG_TOKEN: 'test-treg-token' } });
    await expect(t.call('treg.instagram.user.profile', {}, {}, {})).rejects.toBeInstanceOf(TregError);
    await expect(t.call('x', {}, {}, {})).rejects.toMatchObject({ kind: 'config' });
    expect(t.health()).toEqual({ setUp: true, billingSetUp: false });
  });

  it('have a price ceiling for every metered endpoint, and none for Search Console', () => {
    for (const [key, e] of Object.entries(TREG_ENDPOINTS)) {
      if (key.startsWith('gsc.')) expect(e.maxCostUsd).toBeNull();
      else expect(e.maxCostUsd).toBeGreaterThan(0);
    }
    expect(TREG_ENDPOINTS['gsc.submit'].oneShot).toBe(true);
  });
});

describe('notSetUp', () => {
  it('shows the hint to the owner only', () => {
    const e = notSetUp('Add TREG_TOKEN in Replit Secrets.');
    expect(errorBody(e, null).body).toEqual({ error: expect.any(String), code: 'NOT_SET_UP' });
    expect(errorBody(e, { isAdmin: true }).body.hint).toBe('Add TREG_TOKEN in Replit Secrets.');
    expect(errorBody(new Error('upstream said: secret=abc')).body).toEqual({ error: expect.any(String), code: 'UNAVAILABLE' });
  });
});
