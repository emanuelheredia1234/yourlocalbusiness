// What ai-server.mjs delivers to the integration modules (WP0), one acceptance test each: the route table,
// the Upload-Post, Zernio and Nango webhooks' raw bodies, unlogged media and webhook paths, the account-deletion order, the startup
// sweeps and notes, the connections switch, and the app-host hook in pages.mjs; then the real server.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIntegrations, moduleFor, selectConnections } from './wiring.mjs';
import { CONNECTION_METHODS } from '../connections/index.mjs';
import { createPages } from '../pages.mjs';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { createDb } from './db.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const UID = '0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11';

function sendLike(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(data);
}

/** A bare server that routes like ai-server.mjs: integrations first, 404 otherwise. */
async function serve(integrations) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    if (integrations.match(url)) return void integrations.handle(req, res, url);
    sendLike(res, 404, { error: 'Not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** Fake module factories that record what they were given. */
function recorder() {
  const calls = [];
  const mod = (name, extra = {}) =>
    vi.fn((deps) => ({
      deps,
      async handle(req, res, url) {
        calls.push(['handle', name, url.pathname]);
        sendLike(res, 200, { module: name });
        return true;
      },
      async forgetUser(id) {
        calls.push(['forget', name, id]);
      },
      async unforgetUser(id) {
        calls.push(['unforget', name, id]);
      },
      async userDeleted(id) {
        calls.push(['deleted', name, id]);
      },
      async onStart() {
        calls.push(['start', name]);
      },
      ...extra,
    }));
  const zernioImpl = Object.fromEntries(CONNECTION_METHODS.map((m) => [m, vi.fn(async () => (m === 'status' ? [] : undefined))]));
  zernioImpl.forgetUser = vi.fn(async (id) => calls.push(['forget', 'vendor', id]));
  zernioImpl.unforgetUser = vi.fn(async (id) => calls.push(['unforget', 'vendor', id]));
  const uploadPostImpl = Object.fromEntries(CONNECTION_METHODS.map((m) => [m, vi.fn(async () => (m === 'status' ? [] : undefined))]));
  uploadPostImpl.forgetUser = vi.fn(async (id) => calls.push(['forget', 'social', id]));
  uploadPostImpl.unforgetUser = vi.fn(async (id) => calls.push(['unforget', 'social', id]));
  uploadPostImpl.setPostListener = vi.fn();
  return {
    calls,
    zernioImpl,
    uploadPostImpl,
    factories: {
      uploadPost: vi.fn(() => uploadPostImpl),
      zernio: vi.fn(() => zernioImpl),
      nango: vi.fn(() => ({ enabled: true, integrations: {} })),
      connectionRoutes: mod('connections'),
      nangoRoutes: mod('nango'),
      posting: mod('posting'),
      publicMedia: mod('publicMedia'),
      analytics: mod('analytics'),
      seoGoogle: mod('seoGoogle'),
      billing: mod('billing'),
      ads: mod('ads', {
        async beforeForget(id, opts) {
          calls.push(['beforeForget', 'ads', id, opts]);
        },
        async liveOn(id, platform) {
          calls.push(['liveOn', 'ads', id, platform]);
          return [{ id: 'c1' }];
        },
        async fromWebhook(id, zid, evt) {
          calls.push(['fromWebhook', 'ads', id, zid, evt.event]);
        },
      }),
      sitemap: vi.fn(() => ({ handle: vi.fn(async () => false) })),
      treg: vi.fn(() => ({ health: () => ({ setUp: false, billingSetUp: false }) })),
    },
  };
}

describe('the route table', () => {
  it('sends each prefix to its module', () => {
    expect(moduleFor('/api/integrations/connections')).toBe('connections');
    expect(moduleFor('/api/integrations/connections/facebook/connect')).toBe('connections');
    expect(moduleFor('/api/webhooks/zernio')).toBe('connections');
    expect(moduleFor('/api/webhooks/upload-post')).toBe('connections');
    expect(moduleFor('/api/webhooks/nango')).toBe('nango');
    expect(moduleFor('/api/integrations/nango')).toBe('nango');
    expect(moduleFor('/api/integrations/nango/calendly/connect')).toBe('nango');
    expect(moduleFor('/api/posting/publish')).toBe('posting');
    expect(moduleFor('/api/media/public/abc.def')).toBe('publicMedia');
    expect(moduleFor('/api/analytics/refresh')).toBe('analytics');
    expect(moduleFor('/api/seo/google/publish')).toBe('seoGoogle');
    expect(moduleFor('/api/billing/me')).toBe('billing');
    expect(moduleFor('/api/ads/launch')).toBe('ads');
    expect(moduleFor('/api/ads/campaigns/x/change')).toBe('ads');
    expect(moduleFor('/api/adsx')).toBeNull();
    expect(moduleFor('/api/integrations/omnisend/status')).toBeNull();
    expect(moduleFor('/api/integrations/connectionsx')).toBeNull();
    expect(moduleFor('/api/postingx')).toBeNull();
  });

  it('dispatches, answers 404 when a module passes, and 500 (path redacted) when one throws', async () => {
    const r = recorder();
    r.factories.publicMedia = vi.fn(() => ({
      async handle() {
        throw new Error('boom with the token in it');
      },
    }));
    r.factories.billing = vi.fn(() => ({ handle: async () => false }));
    const log = { log: vi.fn() };
    const integrations = createIntegrations({ env: {}, send: sendLike, factories: r.factories, log, db: { enabled: false } });
    const s = await serve(integrations);
    try {
      expect(await (await fetch(`${s.base}/api/posting/jobs/1`)).json()).toEqual({ module: 'posting' });
      expect(await (await fetch(`${s.base}/api/analytics/snapshots?projectId=p`)).json()).toEqual({ module: 'analytics' });
      expect((await fetch(`${s.base}/api/billing/whatever`)).status).toBe(404);
      const crash = await fetch(`${s.base}/api/media/public/SECRET-TOKEN-123.sig`);
      expect(crash.status).toBe(500);
      expect(await crash.json()).toEqual({ error: expect.any(String), code: 'UNAVAILABLE' });
      const logged = log.log.mock.calls.map((c) => c[0]).join('\n');
      expect(logged).toContain('/api/media/public/[token]');
      expect(logged).not.toContain('SECRET-TOKEN-123');
      expect(logged).not.toContain('boom');
    } finally {
      await s.close();
    }
  });

  it('gives every module the same deps, with the connections and treg it made', () => {
    const r = recorder();
    const readJson = vi.fn();
    const integrations = createIntegrations({ env: {}, send: sendLike, readJson, factories: r.factories, db: { enabled: false } });
    for (const name of ['connectionRoutes', 'posting', 'publicMedia', 'analytics', 'seoGoogle', 'billing']) {
      const deps = r.factories[name].mock.calls[0][0];
      expect(deps.connections).toBe(integrations.connections);
      expect(deps.treg).toBeDefined();
      expect(typeof deps.readRaw).toBe('function');
      expect(typeof deps.limit).toBe('function');
      expect(deps.readJson).toBe(readJson);
    }
  });
});

describe('the Upload-Post and Zernio webhooks', () => {
  it('reaches its module with the body unread, so the HMAC covers the exact bytes (readJson never runs)', async () => {
    const r = recorder();
    const readJson = vi.fn(async () => ({}));
    let got = null;
    r.factories.connectionRoutes = vi.fn((deps) => ({
      async handle(req, res) {
        // nothing upstream may have consumed or parsed the stream
        got = (await deps.readRaw(req, 65536)).toString('utf8');
        sendLike(res, 200, { ok: true });
        return true;
      },
    }));
    const integrations = createIntegrations({ env: {}, send: sendLike, readJson, factories: r.factories, db: { enabled: false } });
    const s = await serve(integrations);
    try {
      const raw = '{"event":"account.connected",  "id":"evt_1","x":"é"}';
      const res = await fetch(`${s.base}/api/webhooks/zernio`, { method: 'POST', body: raw, headers: { 'x-zernio-signature': 'abc' } });
      expect(res.status).toBe(200);
      expect(got).toBe(raw);
      const upRaw = '{"event":"upload_completed",  "request_id":"r1","x":"é"}';
      const upRes = await fetch(`${s.base}/api/webhooks/upload-post`, { method: 'POST', body: upRaw, headers: { 'x-upload-post-signature': 'sha256=abc', 'x-upload-post-timestamp': '1' } });
      expect(upRes.status).toBe(200);
      expect(got).toBe(upRaw);
      expect(readJson).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });
});

describe('account deletion', () => {
  it('forgets the vendor connections first, then posting, analytics, SEO and billing; lifts them newest first', async () => {
    const r = recorder();
    const integrations = createIntegrations({ env: { ZERNIO_API_KEY: 'test-zernio-key', UPLOAD_POST_API_KEY: 'test-upload-post-key' }, send: sendLike, factories: r.factories, db: { enabled: false } });
    await integrations.forgetUser(UID);
    const forgets = r.calls.filter((c) => c[0] === 'forget').map((c) => c[1]);
    // the social profile goes first, then the ad accounts, then everything else
    expect(forgets.slice(0, 2)).toEqual(['social', 'vendor']);
    expect(forgets.indexOf('posting')).toBeLessThan(forgets.indexOf('analytics'));
    expect(forgets.indexOf('analytics')).toBeLessThan(forgets.indexOf('billing'));
    r.calls.length = 0;
    await integrations.unforgetUser(UID);
    const lifts = r.calls.filter((c) => c[0] === 'unforget').map((c) => c[1]);
    expect(lifts.slice(-2)).toEqual(['vendor', 'social']);
    expect(lifts.indexOf('billing')).toBeLessThan(lifts.indexOf('posting'));
    r.calls.length = 0;
    await integrations.userDeleted(UID);
    expect(r.calls.filter((c) => c[0] === 'deleted').map((c) => c[1])).toContain('billing');
  });

  it('asks the ads module first (live campaigns), before any Zernio connection goes, and passes the acknowledgement', async () => {
    const r = recorder();
    const integrations = createIntegrations({ env: { ZERNIO_API_KEY: 'test-zernio-key' }, send: sendLike, factories: r.factories, db: { enabled: false } });
    await integrations.forgetUser(UID, { ackLiveAds: true });
    expect(r.calls[0]).toEqual(['beforeForget', 'ads', UID, { ackLiveAds: true }]);
    expect(r.calls.findIndex((c) => c[1] === 'vendor')).toBeGreaterThan(0);
    r.calls.length = 0;
    r.factories.ads = vi.fn(() => ({
      handle: async () => false,
      async beforeForget() {
        throw Object.assign(new Error('live ads'), { status: 409, code: 'ADS_LIVE' });
      },
    }));
    const blocked = createIntegrations({ env: { ZERNIO_API_KEY: 'test-zernio-key' }, send: sendLike, factories: r.factories, db: { enabled: false } });
    await expect(blocked.forgetUser(UID)).rejects.toMatchObject({ code: 'ADS_LIVE' });
    expect(r.calls.some((c) => c[0] === 'forget')).toBe(false);
  });

  it('wires the ad events listener and the disconnect guard to the ads module', async () => {
    const r = recorder();
    r.zernioImpl.setAdsListener = vi.fn();
    const integrations = createIntegrations({ env: { ZERNIO_API_KEY: 'test-zernio-key' }, send: sendLike, factories: r.factories, db: { enabled: false } });
    expect(r.zernioImpl.setAdsListener).toHaveBeenCalledTimes(1);
    await r.zernioImpl.setAdsListener.mock.calls[0][0](UID, 'z1', { event: 'ad.review.rejected' });
    expect(r.calls).toContainEqual(['fromWebhook', 'ads', UID, 'z1', 'ad.review.rejected']);
    const deps = r.factories.connectionRoutes.mock.calls[0][0];
    expect(await deps.liveAdsGuard(UID, 'meta_ads')).toEqual([{ id: 'c1' }]);
    void integrations;
  });

  it('stops when a module can’t forget (so the account isn’t deleted half-way)', async () => {
    const r = recorder();
    r.factories.analytics = vi.fn(() => ({
      handle: async () => false,
      async forgetUser() {
        throw Object.assign(new Error('storage down'), { status: 503 });
      },
    }));
    const integrations = createIntegrations({ env: {}, send: sendLike, factories: r.factories, db: { enabled: false } });
    await expect(integrations.forgetUser(UID)).rejects.toThrow('storage down');
    expect(r.calls.some((c) => c[0] === 'forget' && c[1] === 'billing')).toBe(false);
  });
});

describe('startup', () => {
  it('runs every module’s sweep once, and a failing one doesn’t stop the others', async () => {
    const r = recorder();
    r.factories.posting = vi.fn(() => ({
      handle: async () => false,
      async onStart() {
        throw new Error('db down');
      },
    }));
    const log = { log: vi.fn() };
    const integrations = createIntegrations({ env: {}, send: sendLike, factories: r.factories, log, db: { enabled: false } });
    await integrations.start();
    const started = r.calls.filter((c) => c[0] === 'start').map((c) => c[1]);
    expect(started).toEqual(expect.arrayContaining(['analytics', 'billing', 'connections']));
    expect(log.log.mock.calls.map((c) => c[0]).join('\n')).toContain('integration_start_failed');
  });

  it('collects every module’s cron jobs; a module that throws doesn’t stop the others', () => {
    const r = recorder();
    r.factories.billing = vi.fn(() => ({ handle: async () => false, cronJobs: () => [{ name: 'treg-settle', everyMs: 3_600_000, run() {} }] }));
    r.factories.posting = vi.fn(() => ({
      handle: async () => false,
      cronJobs() {
        throw new Error('nope');
      },
    }));
    r.factories.ads = vi.fn(() => ({ handle: async () => false, cronJobs: () => [{ name: 'ads-sweep', everyMs: 3_600_000, run() {} }] }));
    const log = { log: vi.fn() };
    const integrations = createIntegrations({ env: {}, send: sendLike, factories: r.factories, log, db: { enabled: false } });
    expect(integrations.cronJobs().map((j) => j.name)).toEqual(['treg-settle', 'ads-sweep']);
    expect(log.log.mock.calls.map((c) => c[0]).join('\n')).toContain('integration_cron_jobs_failed');
  });

  it('the real modules ask for the treg settle, the daily metering and reconcile, and the sweeps (no timers of their own)', () => {
    const env = { UPLOAD_POST_API_KEY: 'up_test_key_xyz_000', ZERNIO_API_KEY: 'sk_test_zernio_key_xyz', TREG_TOKEN: 'test-treg-token-xyz', TREG_ADMIN_TOKEN: 'test-treg-admin-token', TREG_ORG_ID: 'org_test', CUSTOMER_TAG_SECRET: 'test-customer-tag-secret-0123456789' };
    const spy = vi.spyOn(globalThis, 'setInterval');
    const integrations = createIntegrations({ env, send: sendLike, db: { enabled: true, select: async () => [], insert: async () => [], update: async () => [], upsert: async () => [], remove: async () => [] }, appState: { enabled: false } });
    const names = integrations.cronJobs().map((j) => j.name);
    expect(names).toEqual(expect.arrayContaining(['treg-settle', 'uploadpost-meter', 'uploadpost-reconcile', 'zernio-meter', 'posting-sweep', 'analytics-sweep', 'ads-sweep']));
    // pg_cron ticks hourly on the deployment: a shorter period would promise a cadence that never happens
    for (const j of integrations.cronJobs()) if (j.everyMs !== undefined) expect(j.everyMs, j.name).toBeGreaterThanOrEqual(3_600_000);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('names what is missing and never prints a value', () => {
    const secrets = { ZERNIO_API_KEY: 'sk_test_zernio_key_xyz', UPLOAD_POST_API_KEY: 'up_test_key_xyz_000', TREG_TOKEN: 'test-treg-token-xyz', TREG_ADMIN_TOKEN: 'test-treg-admin-token', CUSTOMER_TAG_SECRET: 'test-customer-tag-secret-0123456789' };
    const integrations = createIntegrations({ env: secrets, send: sendLike, db: { enabled: false } });
    const text = integrations.notes().join('\n');
    expect(text).toContain('Social accounts and posting: on (Upload-Post).');
    expect(text).toContain('Ad accounts: on (Zernio).');
    expect(text).toContain('UPLOAD_POST_WEBHOOK_SECRET');
    expect(text).toContain('MEDIA_URL_SECRET');
    expect(text).toContain('ZERNIO_WEBHOOK_SECRET');
    expect(text).toContain('Other integrations (Nango): off');
    expect(text).toContain('TREG_ORG_ID');
    for (const v of Object.values(secrets)) expect(text).not.toContain(v);
    const off = createIntegrations({ env: {}, send: sendLike, db: { enabled: false } }).notes().join('\n');
    expect(off).toMatch(/Social accounts and posting: off.*UPLOAD_POST_API_KEY/);
    expect(off).toMatch(/Ad accounts: off.*ZERNIO_API_KEY/);
    expect(off).toContain('TREG_TOKEN');
  });
});

describe('the connections switch', () => {
  it('is Upload-Post for social with UPLOAD_POST_API_KEY and Zernio for ads with ZERNIO_API_KEY, unless CONNECTIONS_PROVIDER=off; Nango never carries social accounts', () => {
    expect(selectConnections({})).toEqual({ provider: null, social: null, ads: null, reason: 'no_key' });
    expect(selectConnections({ CONNECTIONS_PROVIDER: 'zernio' })).toEqual({ provider: null, social: null, ads: null, reason: 'no_key' });
    expect(selectConnections({ ZERNIO_API_KEY: 'k' })).toEqual({ provider: 'zernio', social: null, ads: 'zernio', reason: 'key' });
    expect(selectConnections({ UPLOAD_POST_API_KEY: 'k' })).toEqual({ provider: 'upload_post', social: 'upload_post', ads: null, reason: 'key' });
    expect(selectConnections({ UPLOAD_POST_API_KEY: 'k', ZERNIO_API_KEY: 'k' })).toEqual({ provider: 'upload_post+zernio', social: 'upload_post', ads: 'zernio', reason: 'key' });
    expect(selectConnections({ UPLOAD_POST_API_KEY: 'k', ZERNIO_API_KEY: 'k', CONNECTIONS_PROVIDER: 'off' })).toEqual({ provider: null, social: null, ads: null, reason: 'off' });
    expect(selectConnections({ ZERNIO_API_KEY: 'k', CONNECTIONS_PROVIDER: 'nango' })).toEqual({ provider: null, social: null, ads: null, reason: 'unknown_provider' });
    expect(selectConnections({ NANGO_SECRET_KEY: 'test-nango-key' })).toEqual({ provider: null, social: null, ads: null, reason: 'no_key' });
  });

  it('builds each side only when its key is set, wires posting to Upload-Post’s webhooks, and Nango only with NANGO_SECRET_KEY', () => {
    const off = recorder();
    const none = createIntegrations({ env: {}, send: sendLike, factories: off.factories, db: { enabled: false } });
    expect(off.factories.zernio).not.toHaveBeenCalled();
    expect(off.factories.uploadPost).not.toHaveBeenCalled();
    expect(off.factories.nango).not.toHaveBeenCalled();
    expect(none.nango.enabled).toBe(false);
    expect(none.connections.enabled).toBe(false);
    const on = recorder();
    const i = createIntegrations({ env: { ZERNIO_API_KEY: 'k', UPLOAD_POST_API_KEY: 'k', NANGO_SECRET_KEY: 'test-nango-key' }, send: sendLike, factories: on.factories, db: { enabled: false } });
    expect(on.factories.zernio).toHaveBeenCalledTimes(1);
    expect(on.factories.uploadPost).toHaveBeenCalledTimes(1);
    expect(on.factories.nango).toHaveBeenCalledTimes(1);
    expect(on.uploadPostImpl.setPostListener).toHaveBeenCalledTimes(1);
    expect(i.connectionsProvider).toBe('upload_post+zernio');
    expect(i.connections).toMatchObject({ enabled: true, socialEnabled: true, adsEnabled: true });
    const adsOnly = recorder();
    const a = createIntegrations({ env: { ZERNIO_API_KEY: 'k' }, send: sendLike, factories: adsOnly.factories, db: { enabled: false } });
    expect(a.connections).toMatchObject({ enabled: true, socialEnabled: false, adsEnabled: true });
  });
});

describe('pages.mjs appHostExtras', () => {
  it('asks the hook for GET and HEAD on the app’s host before page names; a failing hook answers 503', async () => {
    const seen = [];
    const hook = vi.fn(async (req, res, url) => {
      seen.push(`${req.method} ${url.pathname}`);
      if (url.pathname === '/boom') throw new Error('x');
      if (url.pathname !== '/sitemap.xml') return false;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end('<urlset/>');
      return true;
    });
    const pages = createPages({ appHostExtras: hook, send: sendLike });
    const without = createPages({ send: sendLike });
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://local');
      const p = url.searchParams.has('none') ? without : pages;
      if (await p.serveAppHostExtras(req, res, url)) return;
      sendLike(res, 299, { fellThrough: true });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const sm = await fetch(`${base}/sitemap.xml`);
      expect(sm.status).toBe(200);
      expect(await sm.text()).toBe('<urlset/>');
      expect((await fetch(`${base}/robots.txt`)).status).toBe(299);
      expect((await fetch(`${base}/sitemap.xml`, { method: 'POST' })).status).toBe(299);
      expect((await fetch(`${base}/boom`)).status).toBe(503);
      expect((await fetch(`${base}/sitemap.xml?none=1`)).status).toBe(299);
      expect(seen).toEqual(['GET /sitemap.xml', 'GET /robots.txt', 'GET /boom']);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ───────────── the real server ─────────────

describe('ai-server.mjs with the integrations', () => {
  let supa;
  let child;
  let base;
  let output = '';
  const FAKE = { CRON_SECRET: 'test-cron-secret-0005-abcdef', TREG_TOKEN: 'test-treg-token-0001', TREG_ADMIN_TOKEN: 'test-treg-admin-0002', CUSTOMER_TAG_SECRET: 'test-customer-tag-secret-0003', MEDIA_URL_SECRET: 'test-media-url-secret-0004' };

  beforeAll(async () => {
    supa = await (await createMockSupabase()).start();
    const port = 19900 + Math.floor(Math.random() * 90);
    child = spawn(process.execPath, [path.join(here, '..', 'ai-server.mjs')], {
      env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-int-')), SUPABASE_URL: supa.url, SUPABASE_PUBLISHABLE_KEY: supa.PUBLISHABLE, SUPABASE_SECRET_KEY: supa.SECRET, ADMIN_EMAILS: 'owner@example.com', ...FAKE },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    await new Promise((resolve, reject) => {
      const t = setInterval(() => {
        if (output.includes('Analytics data (treg)')) {
          clearInterval(t);
          resolve();
        }
      }, 50);
      child.on('exit', (code) => reject(new Error(`server exited ${code}: ${output}`)));
      setTimeout(() => reject(new Error(`server didn’t start: ${output}`)), 15_000);
    });
    base = `http://127.0.0.1:${port}`;
  }, 20_000);

  afterAll(async () => {
    child?.kill();
    await supa?.close();
  });

  it('lists every account as not connected while connecting is off, with the Secret named for the owner only', async () => {
    expect((await fetch(`${base}/api/integrations/connections`)).status).toBe(401);
    const user = await supa.tokenFor('someone@example.com');
    const r = await fetch(`${base}/api/integrations/connections`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.setUp).toBe(false);
    expect(body.available).toEqual([]);
    expect(body.hint).toBeUndefined();
    expect(body.connections.find((c) => c.platform === 'facebook')).toEqual({ platform: 'facebook', state: 'not_connected' });
    expect(body.connections.find((c) => c.platform === 'pinterest')).toEqual({ platform: 'pinterest', state: 'coming_soon' });
    const owner = await supa.tokenFor('owner@example.com');
    const forOwner = await (await fetch(`${base}/api/integrations/connections`, { headers: { authorization: `Bearer ${owner.token}` } })).json();
    expect(forOwner.hint).toMatch(/UPLOAD_POST_API_KEY/);
    expect(forOwner.hint).toMatch(/ZERNIO_API_KEY/);
    // connecting is refused plainly; a cross-site page is refused first
    const connect = await fetch(`${base}/api/integrations/connections/facebook/connect`, { method: 'POST', headers: { authorization: `Bearer ${user.token}` } });
    expect(connect.status).toBe(503);
    expect((await connect.json()).code).toBe('CONNECTIONS_NOT_ENABLED');
    expect((await fetch(`${base}/api/integrations/connections`, { headers: { authorization: `Bearer ${user.token}`, origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('DELETE /api/account names the launched campaigns still on (409 ADS_LIVE) until acknowledged; ads routes are off without Zernio', async () => {
    const user = await supa.tokenFor('ads-live@example.com');
    const auth = { authorization: `Bearer ${user.token}` };
    expect((await fetch(`${base}/api/ads/accounts?projectId=p1&platform=meta`, { headers: auth })).status).toBe(503);
    const db = createDb({ supabaseUrl: supa.url, secretKey: supa.SECRET });
    const id = crypto.randomUUID();
    await db.insert('ad_campaigns', { id, user_id: user.user.id, customer_tag: 'cust_000000000000000000000000', project_id: 'p1', plan_id: 'plan-1', platform: 'meta', zernio_account_id: 'aaaaaaaaaaaaaaaaaaaaaaa1', ad_account_id: 'act_123456789', ad_account_name: 'Acme', currency: 'USD', timezone: 'America/Chicago', name: 'Winter pipes · Meta · YLB 1a2b3c4d5e6f', launch_key: crypto.randomUUID(), goal: 'traffic', daily_budget: 25, start_at: new Date().toISOString(), launched_as: 'ACTIVE', state: 'active', configured_status: 'ACTIVE', review: {}, remote: {}, sent_body: {} });
    const live = await (await fetch(`${base}/api/ads/live`, { headers: auth })).json();
    expect(live.live).toEqual([{ id, name: 'Winter pipes', platform: 'meta', daily: 25, currency: 'USD', idTail: '6789' }]);
    const refused = await fetch(`${base}/api/account`, { method: 'DELETE', headers: auth });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'ADS_LIVE', live: [expect.objectContaining({ id })] });
    const ok = await fetch(`${base}/api/account?ackLiveAds=1`, { method: 'DELETE', headers: auth });
    expect(ok.status).toBe(200);
  });

  it('answers 503 NOT_SET_UP where a route still needs a missing Secret, and the built routes answer for themselves', async () => {
    const user = await supa.tokenFor('stubs@example.com');
    const auth = { authorization: `Bearer ${user.token}` };
    for (const [method, p] of [
      // posting needs connected social accounts, and they are off here (no UPLOAD_POST_API_KEY)
      ['POST', '/api/posting/publish'],
      ['GET', '/api/posting/jobs?projectId=p1'],
      // /api/billing/me is built (WP3) and needs only Supabase and CUSTOMER_TAG_SECRET; the owner routes still
      // need TREG_ADMIN_TOKEN and TREG_ORG_ID, which this server doesn't have
      ['GET', '/api/billing/customers'],
    ]) {
      const r = await fetch(`${base}${p}`, { method, headers: auth, ...(method === 'POST' ? { body: '{}' } : {}) });
      expect([p, r.status]).toEqual([p, 503]);
      expect((await r.json()).code).toBe('NOT_SET_UP');
    }
    // analytics and Submit to Google read through treg (WP3), which this server has a TREG_TOKEN for: they are
    // live and refuse a bad request plainly, spending nothing
    for (const [method, p, status, code] of [
      ['POST', '/api/analytics/refresh', 400, 'BAD_REQUEST'],
      ['GET', '/api/analytics/snapshots?projectId=p1', 404, 'NOT_FOUND'],
      ['POST', '/api/seo/google/publish', 400, 'BAD_REQUEST'],
    ]) {
      const r = await fetch(`${base}${p}`, { method, headers: auth, ...(method === 'POST' ? { body: '{}' } : {}) });
      expect([p, r.status]).toEqual([p, status]);
      expect((await r.json()).code).toBe(code);
    }
  });

  it('never logs a media token or a webhook body, and never prints a Secret', async () => {
    const token = 'eyJ1IjoiU0VDUkVUTUVESUFUT0tFTiJ9.c2lnbmF0dXJlLXNlY3JldA';
    expect((await fetch(`${base}/api/media/public/${token}`)).status).toBe(503);
    const hook = await fetch(`${base}/api/webhooks/nango`, { method: 'POST', body: '{"connectionId":"conn-SECRET-ID"}', headers: { 'x-nango-hmac-sha256': 'deadbeef' } });
    expect(hook.status).toBe(503);
    await new Promise((r) => setTimeout(r, 100));
    expect(output).not.toContain(token);
    expect(output).not.toContain('SECRETMEDIATOKEN');
    expect(output).not.toContain('conn-SECRET-ID');
    for (const v of Object.values(FAKE)) expect(output).not.toContain(v);
    expect(output).toContain('Social accounts and posting: off.');
    expect(output).toContain('20261105000000_integrations.sql');
  });

  it('POST /api/cron/tick: 401 without the bearer, then runs the due jobs once per period', async () => {
    expect((await fetch(`${base}/api/cron/tick`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/api/cron/tick`, { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${base}/api/cron/tick`, { headers: { authorization: `Bearer ${FAKE.CRON_SECRET}` } })).status).toBe(405);
    const first = await (await fetch(`${base}/api/cron/tick`, { method: 'POST', headers: { authorization: `Bearer ${FAKE.CRON_SECRET}`, 'content-type': 'application/json' }, body: '{}' })).json();
    expect(first.ok).toBe(true);
    const names = first.jobs.map((j) => j.name);
    expect(names).toEqual(expect.arrayContaining(['treg-settle', 'posting-sweep', 'analytics-sweep', 'ads-sweep']));
    expect(first.jobs.find((j) => j.name === 'posting-sweep').status).toBe('ran');
    const second = await (await fetch(`${base}/api/cron/tick`, { method: 'POST', headers: { authorization: `Bearer ${FAKE.CRON_SECRET}` } })).json();
    expect(second.jobs.find((j) => j.name === 'posting-sweep')).toMatchObject({ status: 'skipped', reason: 'done' });
    expect(output).toContain('Scheduled jobs (');
    expect(output).not.toContain(FAKE.CRON_SECRET);
  });

  it('leaves /sitemap.xml and /robots.txt to the app until the sitemap module answers them', async () => {
    const r = await fetch(`${base}/sitemap.xml`);
    expect(r.status).not.toBe(503);
  });

  it('still deletes an account, with the integrations asked first', async () => {
    const leaving = await supa.tokenFor('leaving-int@example.com');
    const r = await fetch(`${base}/api/account`, { method: 'DELETE', headers: { authorization: `Bearer ${leaving.token}` } });
    expect(r.status).toBe(200);
    expect(supa.users.has(leaving.user.id)).toBe(false);
  });
});
