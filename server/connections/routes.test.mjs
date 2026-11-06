// The connected-accounts routes over HTTP (server/connections/routes.mjs) with both sides: social networks on the
// Upload-Post implementation (server/test/mock-uploadpost.mjs) and ad accounts on the Zernio implementation
// (server/test/mock-zernio.mjs). Sign-in and same-origin first, the server's user only, ownership between two users,
// the connect rate limit, both webhooks (raw body, HMAC, no bearer) end to end, each side on or off by its own key,
// and connecting switched off.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createConnectionRoutes } from './routes.mjs';
import { combineConnections, createConnections, nullConnections } from './index.mjs';
import { createZernioConnections } from './zernio.mjs';
import { createUploadPostConnections } from './uploadpost.mjs';
import { createBucketLimiter, readRaw, sha256 } from '../integrations/common.mjs';
import { createMockZernio, signWebhook, TEST_ZERNIO_KEY, TEST_ZERNIO_WEBHOOK_SECRET } from '../test/mock-zernio.mjs';
import { createMockUploadPost, signUploadPost, TEST_UPLOAD_POST_KEY, TEST_UPLOAD_POST_WEBHOOK_SECRET } from '../test/mock-uploadpost.mjs';
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
let up;
let app;
let upImpl;
let storage;
let db;
let implLog;
const ZENV = () => ({ ZERNIO_API_KEY: TEST_ZERNIO_KEY, ZERNIO_WEBHOOK_SECRET: TEST_ZERNIO_WEBHOOK_SECRET, ZERNIO_BASE_URL: mock.apiBase, ZERNIO_RPM: '10000', CUSTOMER_TAG_SECRET: TAG_SECRET });
const UENV = () => ({ UPLOAD_POST_API_KEY: TEST_UPLOAD_POST_KEY, UPLOAD_POST_WEBHOOK_SECRET: TEST_UPLOAD_POST_WEBHOOK_SECRET, UPLOAD_POST_BASE_URL: up.base, UPLOAD_POST_RPM: '900', CUSTOMER_TAG_SECRET: TAG_SECRET });
const ENV = () => ({ ...ZENV(), ...UENV() });

/** Both sides on one storage and database, as wiring.mjs builds them. */
function both({ env = ENV(), store = storage, database = db, log = implLog } = {}) {
  const social = createUploadPostConnections({ env, storage: store, db: database, log });
  const ads = createZernioConnections({ env, storage: store, db: database, log });
  return { social, ads, connections: createConnections(combineConnections({ social, ads })) };
}

beforeAll(async () => {
  mock = await createMockZernio().start();
  up = await createMockUploadPost().start();
  storage = makeStorage();
  db = makeDb();
  implLog = makeLog();
  const made = both();
  upImpl = made.social;
  app = await serve({ connections: made.connections });
  mock.webhookUrl = `${app.base}/api/webhooks/zernio`;
});
afterAll(async () => {
  await app.close();
  await mock.close();
  await up.close();
});
afterEach(() => {
  expect(mock.violations).toEqual([]);
  expect(up.violations).toEqual([]);
});

const profileOf = async (user) => (await storage.get(`uploadpost:user:${sha256(user.id)}`)).value.username;

/** POST a signed Upload-Post event to the app's webhook route, as Upload-Post does. */
async function upHook(base, event, opts) {
  const raw = Buffer.from(JSON.stringify({ created_at: new Date().toISOString(), ...event }));
  return fetch(`${base}/api/webhooks/upload-post`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', ...signUploadPost(raw, { event: event.event, ...opts }) } });
}

/** Connect a social network through the routes: the hosted page (mock), then Upload-Post's webhook over HTTP. */
async function connectOverHttp(who, platform, account = {}) {
  const r = await app.call(who, 'POST', `/api/integrations/connections/${platform}/connect`, {});
  expect(r.status).toBe(200);
  const { connectLink } = await r.json();
  expect((await fetch(connectLink)).status).toBe(200);
  const username = await profileOf(USERS[who]);
  const acct = up.connect(username, platform, account);
  expect((await upHook(app.base, { event: 'social_account_connected', profile_username: username, platform })).status).toBe(200);
  return { connectLink, accountId: acct.username, username };
}

/** Connect an ad account through the routes, then finish on the Zernio mock (its signed webhook comes back over HTTP). */
async function connectAdsOverHttp(who, platform, zPlatform) {
  const r = await app.call(who, 'POST', `/api/integrations/connections/${platform}/connect`, {});
  expect(r.status).toBe(200);
  const { connectLink } = await r.json();
  const profileId = new URL(connectLink).searchParams.get('profileId');
  const done = await fetch(`${mock.base}/__complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: zPlatform, profileId, username: 'joe ads', ads: true }) });
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
  it('lists every network and ad platform: social through Upload-Post, ads through Zernio, no hint for a customer', async () => {
    const r = await app.call('alice', 'GET', '/api/integrations/connections');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.json();
    expect(body).toMatchObject({ setUp: true, setUpSocial: true, setUpAds: true, provider: { social: 'upload_post', ads: 'zernio' } });
    expect(body.available).toEqual(expect.arrayContaining(['facebook', 'instagram', 'google_ads', 'meta_ads', 'linkedin_ads', 'tiktok_ads', 'reddit_ads', 'microsoft_ads', 'pinterest_ads']));
    expect(body.available).not.toContain('pinterest');
    expect(body.available).not.toContain('x_ads');
    expect(body.connections).toHaveLength(15);
    expect(body.hint).toBeUndefined();
  });

  it('names the missing Secret to the owner only when not set up', async () => {
    const half = both({ env: { ...ENV(), UPLOAD_POST_WEBHOOK_SECRET: '' }, store: makeStorage(), database: makeDb(), log: makeLog() });
    const s = await serve({ connections: half.connections });
    try {
      const customer = await (await s.call('alice', 'GET', '/api/integrations/connections')).json();
      expect(customer).toMatchObject({ setUpSocial: false, setUpAds: true });
      expect(customer.hint).toBeUndefined();
      const owner = await (await s.call('owner', 'GET', '/api/integrations/connections')).json();
      expect(owner.hint).toMatch(/UPLOAD_POST_WEBHOOK_SECRET/);
      expect(JSON.stringify(owner)).not.toContain(TEST_UPLOAD_POST_KEY);
      const connect = await s.call('owner', 'POST', '/api/integrations/connections/facebook/connect', {});
      expect(connect.status).toBe(503);
      expect(await connect.json()).toMatchObject({ code: 'NOT_SET_UP', hint: expect.stringMatching(/UPLOAD_POST_WEBHOOK_SECRET/) });
      expect((await fetch(`${s.base}/api/webhooks/upload-post`, { method: 'POST', body: '{}' })).status).toBe(503);
    } finally {
      await s.close();
    }
  });

  it('each side is on or off by its own key: social without ads, and ads without social', async () => {
    const socialOnly = createConnections(combineConnections({ social: createUploadPostConnections({ env: UENV(), storage: makeStorage(), db: makeDb(), log: makeLog() }) }));
    const s = await serve({ connections: socialOnly });
    try {
      const list = await (await s.call('owner', 'GET', '/api/integrations/connections')).json();
      expect(list).toMatchObject({ setUpSocial: true, setUpAds: false, provider: { social: 'upload_post', ads: null } });
      expect(list.available).toContain('facebook');
      expect(list.available).not.toContain('google_ads');
      expect(list.hint).toMatch(/ZERNIO_API_KEY/);
      expect((await (await s.call('alice', 'POST', '/api/integrations/connections/google_ads/connect', {})).json()).code).toBe('CONNECTIONS_NOT_ENABLED');
      expect((await fetch(`${s.base}/api/webhooks/zernio`, { method: 'POST', body: '{}' })).status).toBe(503);
    } finally {
      await s.close();
    }
    const adsOnly = createConnections(combineConnections({ ads: createZernioConnections({ env: ZENV(), storage: makeStorage(), db: makeDb(), log: makeLog() }) }));
    const a = await serve({ connections: adsOnly });
    try {
      const list = await (await a.call('owner', 'GET', '/api/integrations/connections')).json();
      expect(list).toMatchObject({ setUpSocial: false, setUpAds: true, provider: { social: null, ads: 'zernio' } });
      expect(list.available).not.toContain('facebook');
      expect(list.hint).toMatch(/UPLOAD_POST_API_KEY/);
      expect((await (await a.call('alice', 'POST', '/api/integrations/connections/facebook/connect', {})).json()).code).toBe('CONNECTIONS_NOT_ENABLED');
      expect((await fetch(`${a.base}/api/webhooks/upload-post`, { method: 'POST', body: '{}' })).status).toBe(503);
    } finally {
      await a.close();
    }
  });
});

describe('connecting end to end', () => {
  it('connects Instagram through the hosted page and Upload-Post’s webhook; the browser sees status only', async () => {
    const { accountId, connectLink, username } = await connectOverHttp('alice', 'instagram', { id: 'ig_acct_9000' });
    const list = await (await app.call('alice', 'GET', '/api/integrations/connections')).json();
    expect(list.connections.find((c) => c.platform === 'instagram')).toMatchObject({ state: 'connected', targetKind: 'ig_account' });
    expect(JSON.stringify(list)).not.toContain(accountId);
    expect(JSON.stringify(list)).not.toContain(username);
    const checked = await app.call('alice', 'POST', '/api/integrations/connections/instagram/check', {});
    expect((await checked.json()).connection.state).toBe('connected');
    const logs = app.log.text() + implLog.text();
    expect(logs).not.toContain(TEST_UPLOAD_POST_KEY);
    expect(logs).not.toContain(accountId);
    expect(logs).not.toContain(connectLink);
  });

  it('connects an ad account through Zernio’s ads connect and its webhook', async () => {
    const { accountId } = await connectAdsOverHttp('alice', 'meta_ads', 'facebook');
    const list = await (await app.call('alice', 'GET', '/api/integrations/connections')).json();
    expect(list.connections.find((c) => c.platform === 'meta_ads')).toMatchObject({ state: 'connected', targetKind: 'ads_account' });
    expect(JSON.stringify(list)).not.toContain(accountId);
  });

  it('uses the signed-in user only: a user id in the body is ignored; the profile is theirs', async () => {
    const r = await app.call('bob', 'POST', '/api/integrations/connections/youtube/connect', { userId: ALICE.id, profile_username: 'ylb_000000000000000000000000' });
    expect(r.status).toBe(200);
    const bobTag = db.rows('billing_customers').find((c) => c.user_id === BOB.id).customer_tag;
    expect(await profileOf(BOB)).toBe(`ylb_${bobTag.slice(5)}`);
    expect(up.jwtBodies.pop().username).toBe(`ylb_${bobTag.slice(5)}`);
  });

  it('keeps users apart: another user’s account handle is refused, their status is their own', async () => {
    await connectOverHttp('alice', 'x');
    const aliceTargets = (await (await app.call('alice', 'GET', '/api/integrations/connections/x/targets')).json()).targets;
    const bobList = await (await app.call('bob', 'GET', '/api/integrations/connections')).json();
    expect(bobList.connections.find((c) => c.platform === 'x').state).toBe('not_connected');
    await connectOverHttp('bob', 'x', { id: 'x_bob' });
    expect((await app.call('bob', 'PUT', '/api/integrations/connections/x/target', { targetId: aliceTargets[0].id })).status).toBe(400);
    expect((await app.call('bob', 'DELETE', '/api/integrations/connections/x')).status).toBe(200);
    const aliceList = await (await app.call('alice', 'GET', '/api/integrations/connections')).json();
    expect(aliceList.connections.find((c) => c.platform === 'x').state).toBe('connected');
  });

  it('a business id picks which LinkedIn page that business posts as', async () => {
    const username = (await (async () => {
      await app.call('alice', 'POST', '/api/integrations/connections/linkedin/connect', {});
      return profileOf(ALICE);
    })());
    up.pages.linkedin.set(username, [{ id: 'urn:li:organization:42', name: 'Joe’s Bakery Co' }]);
    await connectOverHttp('alice', 'linkedin', { display_name: 'Joe Baker' });
    const targets = (await (await app.call('alice', 'GET', '/api/integrations/connections/linkedin/targets')).json()).targets;
    expect(targets.map((x) => x.kind)).toEqual(['li_person', 'li_org']);
    expect(JSON.stringify(targets)).not.toContain('urn:li');
    const org = targets.find((x) => x.kind === 'li_org');
    const r = await app.call('alice', 'PUT', '/api/integrations/connections/linkedin/target', { targetId: org.id, projectId: 'proj-2' });
    expect((await r.json()).connection.targetLabel).toBe('Joe’s Bakery Co');
    const forP2 = (await (await app.call('alice', 'GET', '/api/integrations/connections?projectId=proj-2')).json()).connections.find((c) => c.platform === 'linkedin');
    expect(forP2).toMatchObject({ targetLabel: 'Joe’s Bakery Co', targetKind: 'li_org' });
    const forOther = (await (await app.call('alice', 'GET', '/api/integrations/connections?projectId=proj-3')).json()).connections.find((c) => c.platform === 'linkedin');
    expect(forOther.targetLabel).toBeDefined();
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

describe('the webhook routes', () => {
  it('Upload-Post: no bearer or same origin, but a valid signature within 300 s; unsigned, stale or bad is 401; over 256 KB is 413', async () => {
    const ok = await upHook(app.base, { event: 'social_account_connected', profile_username: 'ylb_000000000000000000000000', platform: 'x' });
    expect(ok.status).toBe(200);
    const raw = JSON.stringify({ event: 'upload_completed' });
    expect((await fetch(`${app.base}/api/webhooks/upload-post`, { method: 'POST', body: raw })).status).toBe(401);
    expect((await fetch(`${app.base}/api/webhooks/upload-post`, { method: 'POST', body: raw, headers: signUploadPost(Buffer.from(raw), { ts: Math.floor(Date.now() / 1000) - 600 }) })).status).toBe(401);
    expect((await fetch(`${app.base}/api/webhooks/upload-post`, { method: 'POST', body: raw, headers: signUploadPost(Buffer.from(raw), { secret: 'whsec_wrong' }) })).status).toBe(401);
    const big = 'x'.repeat(270_000);
    expect((await fetch(`${app.base}/api/webhooks/upload-post`, { method: 'POST', body: big, headers: signUploadPost(Buffer.from(big)) })).status).toBe(413);
    expect((await fetch(`${app.base}/api/webhooks/upload-post`)).status).toBe(405);
    expect((await fetch(`${app.base}/api/webhooks/upload-post/extra`, { method: 'POST', body: raw })).status).toBe(404);
  });

  it('Zernio: needs no bearer or same origin, but a valid signature; refuses over 256 KB', async () => {
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
  it('lists Not connected, refuses the rest with CONNECTIONS_NOT_ENABLED, and both webhooks answer 503 unread', async () => {
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
      expect((await fetch(`${s.base}/api/webhooks/upload-post`, { method: 'POST', body: '{}' })).status).toBe(503);
    } finally {
      await s.close();
    }
  });
});

describe('through the server wiring (server/integrations/wiring.mjs)', () => {
  it('selects Upload-Post and Zernio from their keys (Nango stays off), and the webhook route reaches the same instance', async () => {
    const { createIntegrations } = await import('../integrations/wiring.mjs');
    const appState = makeStorage();
    const wdb = makeDb();
    const auth = { enabled: true, identify: async (req) => USERS[req.headers['x-test-user']] ?? null };
    const integrations = createIntegrations({ env: ENV(), auth, appState, db: wdb, send: sendLike, readJson, log: makeLog() });
    expect(integrations.connectionsProvider).toBe('upload_post+zernio');
    expect(integrations.nango.enabled).toBe(false);
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://local');
      if (integrations.match(url)) return void integrations.handle(req, res, url);
      sendLike(res, 404, {});
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const r = await fetch(`${base}/api/integrations/connections/tiktok/connect`, { method: 'POST', headers: { 'x-test-user': 'alice', 'content-type': 'application/json' }, body: '{}' });
      expect(r.status).toBe(200);
      const username = (await appState.get(`uploadpost:user:${sha256(ALICE.id)}`)).value.username;
      up.connect(username, 'tiktok');
      expect((await upHook(base, { event: 'social_account_connected', profile_username: username, platform: 'tiktok' })).status).toBe(200);
      const list = await (await fetch(`${base}/api/integrations/connections`, { headers: { 'x-test-user': 'alice' } })).json();
      expect(list.connections.find((c) => c.platform === 'tiktok')).toMatchObject({ state: 'connected', targetKind: 'tt_account' });
      const nangoList = await (await fetch(`${base}/api/integrations/nango`, { headers: { 'x-test-user': 'alice' } })).json();
      expect(nangoList).toEqual({ enabled: false, setUp: false, integrations: [] });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
