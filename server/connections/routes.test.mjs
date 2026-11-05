// The connected-accounts routes over HTTP (server/connections/routes.mjs) with the Nango implementation and
// server/test/mock-nango.mjs: sign-in and same-origin first, the server's user only, ownership between two users,
// the connect rate limit, the webhook (raw body, HMAC, no bearer) end to end from the mock's "Complete" button,
// and connecting switched off.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createConnectionRoutes } from './routes.mjs';
import { createConnections, nullConnections } from './index.mjs';
import { createNango } from '../nango.mjs';
import { createBucketLimiter, readRaw } from '../integrations/common.mjs';
import { createMockNango, makeDb, makeLog, makeStorage, signWebhook, TEST_NANGO_KEY, TEST_SIGNING_KEY } from '../test/mock-nango.mjs';

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
async function serve({ connections, nango, extraEnv = {} } = {}) {
  const log = makeLog();
  const auth = { enabled: true, identify: async (req) => USERS[req.headers['x-test-user']] ?? null };
  const routes = createConnectionRoutes({
    auth,
    connections,
    nango,
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
let nango;
let storage;
let db;
let nangoLog;

beforeAll(async () => {
  mock = await createMockNango().start();
  storage = makeStorage();
  db = makeDb();
  nangoLog = makeLog();
  const env = { NANGO_SECRET_KEY: TEST_NANGO_KEY, NANGO_WEBHOOK_SIGNING_KEY: TEST_SIGNING_KEY, CUSTOMER_TAG_SECRET: TAG_SECRET, NANGO_BASE_URL: mock.base };
  nango = createNango({ env, storage, db, log: nangoLog });
  app = await serve({ connections: createConnections(nango), nango });
  mock.webhookUrl = `${app.base}/api/webhooks/nango`;
});
afterAll(async () => {
  await app.close();
  await mock.close();
});
afterEach(() => mock.reset());

/** Connect through the routes and the mock's Complete button (the webhook comes back over HTTP). */
async function connectOverHttp(who, platform) {
  const r = await app.call(who, 'POST', `/api/integrations/connections/${platform}/connect`, {});
  expect(r.status).toBe(200);
  const { connectLink } = await r.json();
  const page = await fetch(connectLink);
  expect(await page.text()).toContain('Complete');
  const token = new URL(connectLink).searchParams.get('session_token');
  const done = await fetch(`${mock.base}/connect/complete`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `session_token=${token}` });
  expect(done.status).toBe(200);
  const hook = mock.webhooks.at(-1);
  expect(hook.status).toBe(200);
  await new Promise((r) => setTimeout(r, 50)); // the accounts are read after the reply
  return { connectLink, connectionId: hook.body.connectionId };
}

describe('sign-in and same origin', () => {
  it('needs a signed-in user; refuses another site first', async () => {
    expect((await app.call(null, 'GET', '/api/integrations/connections')).status).toBe(401);
    expect((await app.call('alice', 'GET', '/api/integrations/connections', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await app.call(null, 'POST', '/api/integrations/connections/facebook/connect', {})).status).toBe(401);
  });

  it('answers 404 for an unknown platform or action', async () => {
    expect((await app.call('alice', 'POST', '/api/integrations/connections/myspace/connect', {})).status).toBe(404);
    expect((await app.call('alice', 'POST', '/api/integrations/connections/facebook/explode', {})).status).toBe(404);
  });
});

describe('the list', () => {
  it('lists every platform, set up, with no hint for a customer (and none needed for the owner)', async () => {
    const r = await app.call('alice', 'GET', '/api/integrations/connections');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.json();
    expect(body.setUp).toBe(true);
    expect(body.available).toContain('facebook');
    expect(body.available).not.toContain('pinterest');
    expect(body.connections).toHaveLength(12);
    expect(body.hint).toBeUndefined();
  });

  it('names the missing Secret to the owner only when not set up', async () => {
    const half = createNango({ env: { NANGO_SECRET_KEY: TEST_NANGO_KEY, CUSTOMER_TAG_SECRET: TAG_SECRET, NANGO_BASE_URL: mock.base }, storage: makeStorage(), db: makeDb(), log: makeLog() });
    const s = await serve({ connections: createConnections(half), nango: half });
    try {
      const customer = await (await s.call('alice', 'GET', '/api/integrations/connections')).json();
      expect(customer.setUp).toBe(false);
      expect(customer.hint).toBeUndefined();
      const owner = await (await s.call('owner', 'GET', '/api/integrations/connections')).json();
      expect(owner.hint).toMatch(/NANGO_WEBHOOK_SIGNING_KEY/);
      expect(JSON.stringify(owner)).not.toContain(TEST_NANGO_KEY);
      const connect = await s.call('owner', 'POST', '/api/integrations/connections/facebook/connect', {});
      expect(connect.status).toBe(503);
      expect(await connect.json()).toMatchObject({ code: 'NOT_SET_UP', hint: expect.stringMatching(/NANGO_WEBHOOK_SIGNING_KEY/) });
      // the webhook can't be checked without the signing key
      expect((await fetch(`${s.base}/api/webhooks/nango`, { method: 'POST', body: '{}' })).status).toBe(503);
    } finally {
      await s.close();
    }
  });
});

describe('connecting end to end', () => {
  it('connects Facebook from the mock’s Complete button; the browser sees status only', async () => {
    const { connectionId, connectLink } = await connectOverHttp('alice', 'facebook');
    const list = await (await app.call('alice', 'GET', '/api/integrations/connections')).json();
    const fb = list.connections.find((c) => c.platform === 'facebook');
    expect(fb).toMatchObject({ state: 'connected', targetsAvailable: 2 });
    const text = JSON.stringify(list);
    expect(text).not.toContain(connectionId);
    expect(text).not.toContain('111222333');

    const targets = (await (await app.call('alice', 'GET', '/api/integrations/connections/facebook/targets')).json()).targets;
    expect(targets).toHaveLength(2);
    const chosen = await app.call('alice', 'PUT', '/api/integrations/connections/facebook/target', { targetId: targets[0].id });
    expect(chosen.status).toBe(200);
    expect((await chosen.json()).connection).toMatchObject({ state: 'connected', targetLabel: 'Joe’s Bakery' });
    const ig = (await (await app.call('alice', 'GET', '/api/integrations/connections')).json()).connections.find((c) => c.platform === 'instagram');
    expect(ig.state).toBe('connected');

    const checked = await app.call('alice', 'POST', '/api/integrations/connections/facebook/check', {});
    expect((await checked.json()).connection.state).toBe('connected');

    // nothing secret in any log line
    const logs = app.log.text() + nangoLog.text();
    expect(logs).not.toContain(new URL(connectLink).searchParams.get('session_token'));
    expect(logs).not.toContain(TEST_NANGO_KEY);
    expect(logs).not.toContain(connectionId);
    expect(mock.violations).toEqual([]);
  });

  it('uses the signed-in user only: a user id in the body is ignored', async () => {
    const r = await app.call('bob', 'POST', '/api/integrations/connections/youtube/connect', { userId: ALICE.id, end_user_id: 'cust_000000000000000000000000', tags: { end_user_email: 'x@y.z' } });
    expect(r.status).toBe(200);
    const session = mock.lastSession();
    const bobTag = db.rows('billing_customers').find((c) => c.user_id === BOB.id).customer_tag;
    expect(session.tags).toEqual({ end_user_id: bobTag, organization_id: bobTag });
    expect(JSON.stringify(session)).not.toContain('x@y.z');
  });

  it('keeps users apart: another user’s account handle is refused, their status is their own', async () => {
    await connectOverHttp('alice', 'x');
    const aliceTargets = (await (await app.call('alice', 'GET', '/api/integrations/connections/x/targets')).json()).targets;
    // Bob has no X connection: his own status, and nothing of Alice's
    const bobList = await (await app.call('bob', 'GET', '/api/integrations/connections')).json();
    expect(bobList.connections.find((c) => c.platform === 'x').state).toBe('not_connected');
    const r = await app.call('bob', 'PUT', '/api/integrations/connections/x/target', { targetId: aliceTargets[0].id });
    expect(r.status).toBe(409);
    expect((await app.call('bob', 'GET', '/api/integrations/connections/x/targets')).status).toBe(409);
    // once Bob connects too, Alice's handle still means nothing for him
    await connectOverHttp('bob', 'x');
    expect((await app.call('bob', 'PUT', '/api/integrations/connections/x/target', { targetId: aliceTargets[0].id })).status).toBe(404);
    // Bob disconnecting doesn't touch Alice
    expect((await app.call('bob', 'DELETE', '/api/integrations/connections/x')).status).toBe(200);
    const aliceList = await (await app.call('alice', 'GET', '/api/integrations/connections')).json();
    expect(aliceList.connections.find((c) => c.platform === 'x').state).toBe('connected');
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
  it('needs no bearer or same origin, but a valid signature; refuses over 64 KB', async () => {
    const raw = JSON.stringify({ type: 'sync' });
    const ok = await fetch(`${app.base}/api/webhooks/nango`, { method: 'POST', body: raw, headers: { 'x-nango-hmac-sha256': signWebhook(raw), origin: 'https://api.nango.dev' } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const bad = await fetch(`${app.base}/api/webhooks/nango`, { method: 'POST', body: raw, headers: { 'x-nango-hmac-sha256': 'f'.repeat(64) } });
    expect(bad.status).toBe(401);
    const big = 'x'.repeat(70_000);
    const tooBig = await fetch(`${app.base}/api/webhooks/nango`, { method: 'POST', body: big, headers: { 'x-nango-hmac-sha256': signWebhook(big) } });
    expect(tooBig.status).toBe(413);
    expect((await fetch(`${app.base}/api/webhooks/nango`)).status).toBe(405);
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
      expect((await fetch(`${s.base}/api/webhooks/nango`, { method: 'POST', body: '{}' })).status).toBe(503);
    } finally {
      await s.close();
    }
  });
});

describe('through the server wiring (server/integrations/wiring.mjs)', () => {
  it('selects Nango from NANGO_SECRET_KEY, and the webhook route reaches the same instance', async () => {
    const { createIntegrations } = await import('../integrations/wiring.mjs');
    const appState = makeStorage();
    const wdb = makeDb();
    const env = { NANGO_SECRET_KEY: TEST_NANGO_KEY, NANGO_WEBHOOK_SIGNING_KEY: TEST_SIGNING_KEY, CUSTOMER_TAG_SECRET: TAG_SECRET, NANGO_BASE_URL: mock.base };
    const auth = { enabled: true, identify: async (req) => USERS[req.headers['x-test-user']] ?? null };
    const integrations = createIntegrations({ env, auth, appState, db: wdb, send: sendLike, readJson, log: makeLog() });
    expect(integrations.connectionsProvider).toBe('nango');
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://local');
      if (integrations.match(url)) return void integrations.handle(req, res, url);
      sendLike(res, 404, {});
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    mock.webhookUrl = `${base}/api/webhooks/nango`;
    try {
      const r = await fetch(`${base}/api/integrations/connections/linkedin/connect`, { method: 'POST', headers: { 'x-test-user': 'alice', 'content-type': 'application/json' }, body: '{}' });
      expect(r.status).toBe(200);
      const { connectLink } = await r.json();
      const sent = await mock.complete(new URL(connectLink).searchParams.get('session_token'));
      expect(sent.status).toBe(200);
      await new Promise((res) => setTimeout(res, 50));
      const list = await (await fetch(`${base}/api/integrations/connections`, { headers: { 'x-test-user': 'alice' } })).json();
      expect(list.connections.find((c) => c.platform === 'linkedin')).toMatchObject({ state: 'connected', targetKind: 'li_person' });
    } finally {
      mock.webhookUrl = `${app.base}/api/webhooks/nango`;
      await new Promise((r) => server.close(r));
    }
  });
});
