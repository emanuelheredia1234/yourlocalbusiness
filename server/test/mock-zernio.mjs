// A stand-in for Zernio's ads API (https://docs.zernio.com), for tests and offline QA. Nothing here calls Zernio or a
// network. Same style as server/test/mock-providers.mjs:
//
//   node server/test/mock-zernio.mjs [port]     → prints its base URL; use `${base}/api/v1` as ZERNIO_BASE_URL
//   const mock = await createMockZernio({ webhookUrl }).start();
//
// What it answers (under /api/v1, bearer must be the test key; anything else 401 invalid_credentials):
//   GET    /profiles?externalId=          {profiles}
//   POST   /profiles                      201 {profile} | 409 profile_external_id_conflict {details.existingProfileId}
//   GET    /connect/:platform/ads         {authUrl} (a test page on this mock) | {alreadyConnected: true}
//   GET    /accounts?profileId=           {accounts} (a classic Meta Ads connect also lists its hidden Facebook
//                                         account: enabled false, the metaads account's parentAccountId)
//   DELETE /accounts/:id                  200 {gracePeriodEndsAt} (+ account.disconnected webhook) | 404
//   DELETE /profiles/:id                  200 | 400 while it still has accounts | 404
//   /ads/…                                every ads route: server/test/mock-zernio-ads.mjs (reads, launches, changes,
//                                         fault injection and the write rules a test fails on)
// Ads only: social accounts, posting and social stats are Upload-Post's (server/test/mock-uploadpost.mjs).
// Test hooks (no key): GET /__calls, GET /__violations, POST /__complete {platform, profileId, username, ads?,
// hiddenParent?} (finishes a connect: makes the account, with a hidden Facebook account for a classic Meta Ads
// connect when hiddenParent, and sends a signed account.connected webhook), GET /__connect (the page),
// POST /__fail {route, mode, times} and POST /__expectRepeat {n} (the ads mock's fault injection and repeat rule).
//
// Violations a test fails on: an API key in a query string, and the ads write rules (mock-zernio-ads.mjs).

import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createMockZernioAds } from './mock-zernio-ads.mjs';

export const TEST_ZERNIO_KEY = 'sk_test_zernio_key_0000000000000000';
export const TEST_ZERNIO_WEBHOOK_SECRET = 'test-zernio-webhook-secret';

/** X-Zernio-Signature for a body: lowercase hex HMAC-SHA256 of the exact bytes. */
export const signWebhook = (rawBody, secret = TEST_ZERNIO_WEBHOOK_SECRET) => crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

const oid = () => crypto.randomBytes(12).toString('hex');
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const err = (res, status, code, type = 'invalid_request_error', extra = {}) => json(res, status, { error: `mock ${code}`, type, code, ...extra });
const ADS = { facebook: 'metaads', googleads: 'googleads', linkedin: 'linkedinads', tiktok: 'tiktokads', pinterest: 'pinterestads', twitter: 'xads', redditads: 'redditads', microsoftads: 'microsoftads' };

export function createMockZernio({ key = TEST_ZERNIO_KEY, webhookSecret = TEST_ZERNIO_WEBHOOK_SECRET, webhookUrl = process.env.ZERNIO_WEBHOOK_URL || '', now = () => Date.now() } = {}) {
  const profiles = [];
  const accounts = [];
  const calls = [];
  const violations = [];
  const webhooks = [];
  let server = null;
  let base = '';
  let hookUrl = webhookUrl;

  async function sendWebhook(event) {
    const payload = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...event };
    const raw = Buffer.from(JSON.stringify(payload));
    webhooks.push(payload);
    if (!hookUrl) return { status: 0, payload, raw };
    try {
      const res = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-zernio-event': payload.event, 'x-zernio-event-id': payload.id, 'x-zernio-signature': signWebhook(raw, webhookSecret) }, body: raw });
      return { status: res.status, payload, raw };
    } catch {
      return { status: 0, payload, raw };
    }
  }

  const profileRef = (profileId) => {
    const p = profiles.find((x) => x._id === profileId);
    return p ? [{ id: p._id, externalId: p.externalId ?? null }] : [];
  };
  const ads = createMockZernioAds({ calls, violations, sendWebhook: (e) => sendWebhook(e), connections: () => accounts, profileRef, now });

  function addAccount({ platform, profileId, username = 'joesbakery', displayName, isActive = true, enabled, parentAccountId }) {
    const a = { _id: oid(), platform, profileId, username, displayName: displayName ?? `${username} (${platform})`, isActive, ...(enabled !== undefined ? { enabled } : {}), ...(parentAccountId ? { parentAccountId } : {}), createdAt: new Date().toISOString() };
    accounts.push(a);
    return a;
  }

  async function complete({ platform, profileId, username = 'joesbakery', ads = false, hiddenParent = false }) {
    const zPlatform = ads ? ADS[platform] ?? platform : platform;
    // Zernio's classic Meta Ads OAuth: a hidden Facebook account for the Page (not billed, not postable) is the parent
    const parent = ads && hiddenParent ? addAccount({ platform: 'facebook', profileId, username, enabled: false }) : null;
    const a = addAccount({ platform: zPlatform, profileId, username, ...(parent ? { parentAccountId: parent._id } : {}) });
    await sendWebhook({ event: 'account.connected', profiles: profileRef(profileId), account: { accountId: a._id, profileId, platform: zPlatform, username, displayName: a.displayName } });
    return a;
  }

  async function api(req, res, url, body, raw) {
    const p = url.pathname.replace(/^\/api\/v1/, '');
    const q = url.searchParams;
    if (req.method === 'GET' && p === '/profiles') return json(res, 200, { profiles: profiles.filter((x) => !q.get('externalId') || x.externalId === q.get('externalId')) });
    if (req.method === 'POST' && p === '/profiles') {
      const dup = profiles.find((x) => body?.externalId && x.externalId === body.externalId);
      if (dup) return err(res, 409, 'profile_external_id_conflict', 'invalid_request_error', { param: 'externalId', details: { existingProfileId: dup._id } });
      const prof = { _id: oid(), name: String(body?.name ?? ''), externalId: body?.externalId ?? null, isDefault: false, createdAt: new Date().toISOString() };
      profiles.push(prof);
      return json(res, 201, { message: 'Profile created successfully', profile: prof });
    }
    let m = /^\/connect\/([a-z]+)(\/ads)$/.exec(p);
    if (m && req.method === 'GET') {
      const profileId = q.get('profileId');
      if (!profiles.some((x) => x._id === profileId)) return err(res, 404, 'not_found', 'not_found');
      if (q.get('logoUrl') && q.get('welcome') !== 'true') return err(res, 400, 'INVALID_FIELD_VALUE');
      if (m[2] && m[1] === 'twitter' && !q.get('accountId')) return err(res, 400, 'missing_required_field', 'invalid_request_error', { param: 'accountId' });
      if (m[2] && q.get('force') !== 'true' && accounts.some((a) => a.profileId === profileId && a.platform === ADS[m[1]])) return json(res, 200, { alreadyConnected: true });
      const state = oid();
      return json(res, 200, { authUrl: `${base}/__connect?platform=${m[1]}&profileId=${profileId}${m[2] ? '&ads=1' : ''}&state=${state}`, state });
    }
    if (req.method === 'GET' && p === '/accounts') return json(res, 200, { accounts: accounts.filter((a) => !q.get('profileId') || a.profileId === q.get('profileId')), hasAnalyticsAccess: true });
    m = /^\/profiles\/([0-9a-f]{24})$/.exec(p);
    if (m && req.method === 'DELETE') {
      const i = profiles.findIndex((x) => x._id === m[1]);
      if (i < 0) return err(res, 404, 'not_found', 'not_found');
      if (accounts.some((a) => a.profileId === m[1])) return err(res, 400, 'profile_has_accounts');
      profiles.splice(i, 1);
      return json(res, 200, { message: 'Profile deleted' });
    }
    m = /^\/accounts\/([0-9a-f]{24})$/.exec(p);
    if (m && req.method === 'DELETE') {
      const i = accounts.findIndex((a) => a._id === m[1]);
      if (i < 0) return err(res, 404, 'account_not_found', 'not_found');
      const [a] = accounts.splice(i, 1);
      void sendWebhook({ event: 'account.disconnected', profiles: profileRef(a.profileId), account: { accountId: a._id, profileId: a.profileId, platform: a.platform, username: a.username, disconnectionType: 'intentional', reason: 'Removed through the API' } });
      return json(res, 200, { message: 'Account disconnected', gracePeriodEndsAt: new Date(Date.now() + 3_600_000).toISOString() });
    }
    // every /ads route (reads, launches and changes) is server/test/mock-zernio-ads.mjs's
    if (await ads.handle(req, res, p, q, body, req.headers)) return;
    return err(res, 404, 'not_found', 'not_found');
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://mock');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body = null;
    if (raw.length && /json/.test(String(req.headers['content-type'] ?? ''))) {
      try {
        body = JSON.parse(raw.toString());
      } catch {
        body = null;
      }
    }
    if (url.search.includes(key)) violations.push({ kind: 'key_in_query', path: url.pathname });
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), idempotencyKey: req.headers['idempotency-key'] ?? null, auth: req.headers.authorization ? 'bearer' : null, host: req.headers.host ?? null, body, bytes: raw.length });
    if (url.pathname === '/__calls') return json(res, 200, { calls });
    if (url.pathname === '/__violations') return json(res, 200, { violations });
    if (url.pathname === '/__complete' && req.method === 'POST') return json(res, 200, { account: await complete(body ?? {}) });
    if (url.pathname === '/__fail' && req.method === 'POST') {
      ads.fail(String(body?.route ?? ''), String(body?.mode ?? ''), body?.times);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__expectRepeat' && req.method === 'POST') {
      ads.expectRepeat(body?.n);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__connect') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Connect (mock)</title><p>Mock Zernio connect screen.</p>');
    }
    if (!url.pathname.startsWith('/api/v1/')) return err(res, 404, 'not_found', 'not_found');
    if (req.headers.authorization !== `Bearer ${key}`) return err(res, 401, 'invalid_credentials', 'authentication_error');
    return api(req, res, url, body, raw);
  }

  return {
    profiles,
    accounts,
    calls,
    violations,
    webhooks,
    get base() {
      return base;
    },
    /** ZERNIO_BASE_URL for the client */
    get apiBase() {
      return `${base}/api/v1`;
    },
    set webhookUrl(u) {
      hookUrl = u;
    },
    addAccount,
    complete,
    /** the ads side: state, fail(route, mode, times), expectRepeat(n), review(campaignId, outcome), campaignByTag(tag) */
    ads,
    sendWebhook,
    /** An event as Zernio would sign it, for calling a webhook handler directly: { raw, headers }. */
    signed(event, secret = webhookSecret) {
      const payload = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...event };
      const raw = Buffer.from(JSON.stringify(payload));
      return { raw, payload, headers: { 'x-zernio-event': payload.event, 'x-zernio-event-id': payload.id, 'x-zernio-signature': signWebhook(raw, secret) } };
    },
    profileRef,
    async start(port = 0) {
      server = http.createServer((req, res) => void handler(req, res).catch(() => err(res, 500, 'internal_error', 'api_error')));
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
      return this;
    },
    async close() {
      ads.release();
      server?.closeAllConnections?.();
      await new Promise((r) => (server ? server.close(() => r()) : r()));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await createMockZernio().start(Number(process.argv[2] || 0));
  console.log(mock.apiBase);
}
