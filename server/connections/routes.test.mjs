// The connected-accounts routes over HTTP (server/connections/routes.mjs) with the Zernio implementation and
// server/test/mock-zernio.mjs: sign-in and same-origin first, the server's user only, ownership between two users,
// the connect rate limit, the webhook (raw body, HMAC, no bearer) end to end from the mock's connect, and
// connecting switched off.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createConnectionRoutes } from './routes.mjs';
import { createConnections, nullConnections } from './index.mjs';
import { createZernioConnections } from './zernio.mjs';
import { createBucketLimiter, readRaw, sha256 } from '../integrations/common.mjs';
import { createMockZernio, signWebhook, TEST_ZERNIO_KEY, TEST_ZERNIO_WEBHOOK_SECRET } from '../test/mock-zernio.mjs';
import { makeDb, makeLog, makeStorage } from '../test/fakes.mjs';

const ALICE = { id: '0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11', isAdmin: false };
const BOB = { id: '7d1e2b3c-4a5f-4b6c-8d7e-9f0a1b2c3d4e', isAdmin: false };
const OWNER = { id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d', isAdmin: true };
const USERS = { alice: ALICE, bob: BOB, owner: OWNER };
const TAG_SECRET = 'test-customer-tag-secret-0123456789';

function sendLike(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(data);
}

async function readJson(req) {
  const raw = await readRaw(req, 65536);
  return raw.length ? JSON.parse(raw.toString('utf8')) : {};
}

/** A server that routes like wiring.mjs: the connections routes, 404 otherwise. */
async function serve({ connections, extraEnv = {} } = {}) {
  const log = makeLog();
  const auth = { enabled: true, identify: async (req) => USERS[req.headers['x-test-user']] ?? null };
  const routes = createConnectionRoutes({
    auth,
    connections,
    send: sendLike,
    readJson,
    readRaw,
    limit: createBucketLimiter(),
    sameOrigin: (req) => !req.headers.origin || req.headers.origin === 'http://app.local',
    log,
    env: extraEnv,
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (!(await routes.handle(req, res, url))) sendLike(res, 404, { error: 'Not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (who, method, path, body, headers = {}) =>
    fetch(`${base}${path}`, { method, headers: { ...(who ? { 'x-test-user': who } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { base, call, log, close: () => new Promise((r) => server.close(r)) };
}

let mock;
let app;
let impl;
let storage;
let db;
let implLog;
const ENV = () => ({ ZERNIO_API_KEY: TEST_ZERNIO_KEY, ZERNIO_WEBHOOK_SECRET: TEST_ZERNIO_WEBHOOK_SECRET, ZERNIO_BASE_URL: mock.apiBase, ZERNIO_RPM: '10000', CUSTOMER_TAG_SECRET: TAG_SECRET });

beforeAll(async () => {
  mock = await createMockZernio().start();
  storage = makeStorage();
  db = makeDb();
  implLog = makeLog();
  impl = createZernioConnections({ env: ENV(), storage, db, log: implLog });
  app = await serve({ connections: createConnections(impl) });
  mock.webhookUrl = `${app.base}/api/webhooks/zernio`;
});
afterAll(async () => {
  await app.close();
  await mock.close();
});
afterEach(() => expect(mock.violations).toEqual([]));

/** Connect through the routes, then finish on the mock: its signed account.connected webhook comes back over HTTP. */
async function connectOverHttp(who, platform, zPlatform = platform, username = 'joesbakery') {
  const r = await app.call(who, 'POST', `/api/integrations/connections/${platform}/connect`, {});
  expect(r.status).toBe(200);
  const { connectLink } = await r.json();
  expect((await fetch(connectLink)).status).toBe(200);
  const profileId = new URL(connectLink).searchParams.get('profileId');
  const done = await fetch(`${mock.base}/__complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: zPlatform, profileId, username }) });
  const { account } = await done.json();
  return { connectLink, accountId: account._id };
}

describe('sign-in and same origin', () => {
  it('needs a signed-in user; refuses another site first', async () => {
    expect((await app.call(null, 'GET', '/api/integrations/connections')).status).toBe(401);
    expect((await app.call('alice', 'GET', '/api/integrations/connections', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await app.call(null, 'POST', '/api/integrations/connections/facebook/connect', {})).status).toBe(401);
  });

  it('answers 404 for an unknown platform or action (Search Console isn’t a connected account any more)', async () => {
    expect((await app.call('alice', 'POST', '/api/integrations/connections/myspace/connect', {})).status).toBe(404);
    expect((await app.call('alice', 'POST', '/api/integrations/connections/google_search_console/connect', {})).status).toBe(404);
    expect((await app.call('alice', 'POST', '/api/integrations/connections/facebook/explode', {})).status).toBe(404);
  });
});

describe('the list', () => {
  it('lists every network and ad platform, set up, through Zernio, with no hint for a customer', async () => {
    const r = await app.call('alice', 'GET', '/api/integrations/connections');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.json();
    expect(body).toMatchObject({ setUp: true, provider: 'zernio' });
    expect(body.available).toEqual(expect.arrayContaining(['facebook', 'google_ads', 'meta_ads', 'linkedin_ads', 'tiktok_ads', 'x_ads', 'reddit_ads', 'microsoft_ads', 'pinterest_ads']));
    expect(body.available).not.toContain('pinterest');
    expect(body.connections).toHaveLength(15);
    expect(body.hint).toBeUndefined();
  });

  it('names the missing Secret to the owner only when not set up', async () => {
    const half = createZernioConnections({ env: { ...ENV(), ZERNIO_WEBHOOK_SECRET: '' }, storage: makeStorage(), db: makeDb(), log: makeLog() });
    const s = await serve({ connections: createConnections(half) });
    try {
      const customer = await (await s.call('alice', 'GET', '/api/integrations/connections')).json();
      expect(customer.setUp).toBe(false);
      expect(customer.hint).toBeUndefined();
      const owner = await (await s.call('owner', 'GET', '/api/integrations/connections')).json();
      expect(owner.hint).toMatch(/ZERNIO_WEBHOOK_SECRET/);
      expect(JSON.stringify(owner)).not.toContain(TEST_ZERNIO_KEY);
      const connect = await s.call('owner', 'POST', '/api/integrations/connections/facebook/connect', {});
      expect(connect.status).toBe(503);
      expect(await connect.json()).toMatchObject({ code: 'NOT_SET_UP', hint: expect.stringMatching(/ZERNIO_WEBHOOK_SECRET/) });
      expect((await fetch(`${s.base}/api/webhooks/zernio`, { method: 'POST', body: '{}' })).status).toBe(503);
    } finally {
      await s.close();
    }
  });
});

describe('connecting end to end', () => {
  it('connects Facebook through the white-label link and Zernio’s webhook; the browser sees status only', async () => {
    const { accountId, connectLink } = await connectOverHttp('alice', 'facebook');
    const list = await (await app.call('alice', 'GET', '/api/integrations/connections')).json();
    expect(list.connections.find((c) => c.platform === 'facebook')).toMatchObject({ state: 'connected', targetKind: 'fb_page' });
    expect(JSON.stringify(list)).not.toContain(accountId);
    const checked = await app.call('alice', 'POST', '/api/integrations/connections/facebook/check', {});
    expect((await checked.json()).connection.state).toBe('connected');
    const logs = app.log.text() + implLog.text();
    expect(logs).not.toContain(TEST_ZERNIO_KEY);
    expect(logs).not.toContain(accountId);
    expect(logs).not.toContain(connectLink);
  });

  it('uses the signed-in user only: a user id in the body is ignored; the profile is theirs', async () => {
    const r = await app.call('bob', 'POST', '/api/integrations/connections/youtube/connect', { userId: ALICE.id, externalId: 'cust_000000000000000000000000' });
    expect(r.status).toBe(200);
    const bobTag = db.rows('billing_customers').find((c) => c.user_id === BOB.id).customer_tag;
    const profileId = new URL((await r.json()).connectLink).searchParams.get('profileId');
    expect(mock.profiles.find((p) => p._id === profileId).externalId).toBe(bobTag);
  });

  it('keeps users apart: another user’s account handle is refused, their status is their own', async () => {
    await connectOverHttp('alice', 'x', 'twitter');
    const aliceTargets = (await (await app.call('alice', 'GET', '/api/integrations/connections/x/targets')).json()).targets;
    const bobList = await (await app.call('bob', 'GET', '/api/integrations/connections')).json();
    expect(bobList.connections.find((c) => c.platform === 'x').state).toBe('not_connected');
    expect((await app.call('bob', 'PUT', '/api/integrations/connections/x/target', { targetId: aliceTargets[0].id })).status).toBe(400);
    await connectOverHttp('bob', 'x', 'twitter', 'bob');
    expect((await app.call('bob', 'DELETE', '/api/integrations/connections/x')).status).toBe(200);
    const aliceList = await (await app.call('alice', 'GET', '/api/integrations/connections')).json();
    expect(aliceList.connections.find((c) => c.platform === 'x').state).toBe('connected');
  });

  it('a business id picks which account that business uses', async () => {
    await connectOverHttp('alice', 'linkedin', 'linkedin', 'joe');
    await connectOverHttp('alice', 'linkedin', 'linkedin', 'joesbakery-co');
    const targets = (await (await app.call('alice', 'GET', '/api/integrations/connections/linkedin/targets')).json()).targets;
    expect(targets).toHaveLength(2);
    const second = targets.find((x) => /bakery-co/.test(x.label));
    const r = await app.call('alice', 'PUT', '/api/integrations/connections/linkedin/target', { targetId: second.id, projectId: 'proj-2' });
    expect((await r.json()).connection.targetLabel).toMatch(/bakery-co/);
    const forP2 = (await (await app.call('alice', 'GET', '/api/integrations/connections?projectId=proj-2')).json()).connections.find((c) => c.platform === 'linkedin');
    expect(forP2.targetLabel).toMatch(/bakery-co/);
  });

  it('refuses a malformed target id', async () => {
    const r = await app.call('alice', 'PUT', '/api/integrations/connections/facebook/target', { targetId: '111222333' });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('BAD_REQUEST');
  });

  it('limits connect attempts to 10 an hour per user', async () => {
    let last;
    for (let i = 0; i < 11; i += 1) last = await app.call('owner', 'POST', '/api/integrations/connections/tiktok/connect', {});
    expect(last.status).toBe(429);
    expect((await last.json()).code).toBe('RATE_LIMITED');
  });
});

describe('the webhook route', () => {
  it('needs no bearer or same origin, but a valid signature; refuses over 256 KB', async () => {
    const raw = JSON.stringify({ id: 'evt_test_000001', event: 'webhook.test' });
    const ok = await fetch(`${app.base}/api/webhooks/zernio`, { method: 'POST', body: raw, headers: { 'x-zernio-signature': signWebhook(raw), origin: 'https://zernio.com' } });
    expect(ok.status).toBe(200);
    const bad = await fetch(`${app.base}/api/webhooks/zernio`, { method: 'POST', body: raw, headers: { 'x-zernio-signature': 'f'.repeat(64) } });
    expect(bad.status).toBe(401);
    const big = 'x'.repeat(270_000);
    const tooBig = await fetch(`${app.base}/api/webhooks/zernio`, { method: 'POST', body: big, headers: { 'x-zernio-signature': signWebhook(big) } });
    expect(tooBig.status).toBe(413);
    expect((await fetch(`${app.base}/api/webhooks/zernio`)).status).toBe(405);
  });
});

describe('connecting switched off', () => {
  it('lists Not connected, refuses the rest with CONNECTIONS_NOT_ENABLED, and the webhook answers 503 unread', async () => {
    const s = await serve({ connections: createConnections(nullConnections) });
    try {
      const list = await (await s.call('alice', 'GET', '/api/integrations/connections')).json();
      expect(list.setUp).toBe(false);
      expect(list.available).toEqual([]);
      expect(list.connections.find((c) => c.platform === 'facebook')).toEqual({ platform: 'facebook', state: 'not_connected' });
      for (const [method, p] of [
        ['POST', '/api/integrations/connections/facebook/connect'],
        ['POST', '/api/integrations/connections/facebook/reconnect'],
        ['POST', '/api/integrations/connections/facebook/check'],
        ['GET', '/api/integrations/connections/facebook/targets'],
        ['PUT', '/api/integrations/connections/facebook/target'],
        ['DELETE', '/api/integrations/connections/facebook'],
      ]) {
        const r = await s.call('alice', method, p, method === 'GET' || method === 'DELETE' ? undefined : {});
        expect([p, r.status]).toEqual([p, 503]);
        expect((await r.json()).code).toBe('CONNECTIONS_NOT_ENABLED');
      }
      expect((await fetch(`${s.base}/api/webhooks/zernio`, { method: 'POST', body: '{}' })).status).toBe(503);
    } finally {
      await s.close();
    }
  });
});

describe('through the server wiring (server/integrations/wiring.mjs)', () => {
  it('selects Zernio from ZERNIO_API_KEY (Nango stays off), and the webhook route reaches the same instance', async () => {
    const { createIntegrations } = await import('../integrations/wiring.mjs');
    const appState = makeStorage();
    const wdb = makeDb();
    const auth = { enabled: true, identify: async (req) => USERS[req.headers['x-test-user']] ?? null };
    const integrations = createIntegrations({ env: ENV(), auth, appState, db: wdb, send: sendLike, readJson, log: makeLog() });
    expect(integrations.connectionsProvider).toBe('zernio');
    expect(integrations.nango.enabled).toBe(false);
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://local');
      if (integrations.match(url)) return void integrations.handle(req, res, url);
      sendLike(res, 404, {});
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    mock.webhookUrl = `${base}/api/webhooks/zernio`;
    try {
      const r = await fetch(`${base}/api/integrations/connections/linkedin/connect`, { method: 'POST', headers: { 'x-test-user': 'alice', 'content-type': 'application/json' }, body: '{}' });
      expect(r.status).toBe(200);
      const profileId = new URL((await r.json()).connectLink).searchParams.get('profileId');
      await mock.complete({ platform: 'linkedin', profileId, username: 'joe' });
      const list = await (await fetch(`${base}/api/integrations/connections`, { headers: { 'x-test-user': 'alice' } })).json();
      expect(list.connections.find((c) => c.platform === 'linkedin')).toMatchObject({ state: 'connected', targetKind: 'li_person' });
      const nangoList = await (await fetch(`${base}/api/integrations/nango`, { headers: { 'x-test-user': 'alice' } })).json();
      expect(nangoList).toEqual({ enabled: false, setUp: false, integrations: [] });
      void sha256;
    } finally {
      mock.webhookUrl = `${app.base}/api/webhooks/zernio`;
      await new Promise((r) => server.close(r));
    }
  });
});
