// A stand-in for Zernio's API (https://docs.zernio.com), for tests and offline QA. Nothing here calls Zernio or a
// network. Same style as server/test/mock-providers.mjs:
//
//   node server/test/mock-zernio.mjs [port]     → prints its base URL; use `${base}/api/v1` as ZERNIO_BASE_URL
//   const mock = await createMockZernio({ webhookUrl }).start();
//
// What it answers (under /api/v1, bearer must be the test key; anything else 401 invalid_credentials):
//   GET    /profiles?externalId=          {profiles}
//   POST   /profiles                      201 {profile} | 409 profile_external_id_conflict {details.existingProfileId}
//   GET    /connect/:platform             {authUrl} (a test page on this mock)        records the query
//   GET    /connect/:platform/ads         {authUrl} | {alreadyConnected: true}
//   GET    /accounts?profileId=           {accounts}
//   DELETE /accounts/:id                  200 {gracePeriodEndsAt} (+ account.disconnected webhook) | 404
//   POST   /media/presign                 {uploadUrl, publicUrl}   (PUT the bytes to uploadUrl, no API key)
//   POST   /posts                         Idempotency-Key required; publishNow → 201 published | 207 failed, per
//                                          the next queued outcome (setPostOutcome); a replay of the key → 200 original
//   GET    /posts/:id   GET /posts?profileId=&fromDate=   the stored posts
//   GET    /analytics/daily-metrics?accountId=   GET /accounts/follower-stats?accountIds=   GET /analytics?accountId=
//   GET    /ads/timeline?accountId=       GET /ads/campaigns?accountId=
// Test hooks (no key): GET /__calls, GET /__violations, POST /__complete {platform, profileId, username, ads?}
// (finishes a connect: makes the account and sends a signed account.connected webhook), GET /__connect (the page).
//
// Violations a test fails on: a POST /posts without Idempotency-Key, a second POST /posts with a key it has seen
// (a resend), an API key on an upload URL or in a query string.

import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

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

export function createMockZernio({ key = TEST_ZERNIO_KEY, webhookSecret = TEST_ZERNIO_WEBHOOK_SECRET, webhookUrl = process.env.ZERNIO_WEBHOOK_URL || '' } = {}) {
  const profiles = [];
  const accounts = [];
  const posts = [];
  const idem = new Map(); // Idempotency-Key → post id
  const uploads = new Map();
  const calls = [];
  const violations = [];
  const outcomes = []; // queued POST /posts outcomes: 'published' | 'failed' | 'publishing' | 'error500' | { delayMs } …
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

  function addAccount({ platform, profileId, username = 'joesbakery', displayName, isActive = true }) {
    const a = { _id: oid(), platform, profileId, username, displayName: displayName ?? `${username} (${platform})`, isActive, createdAt: new Date().toISOString() };
    accounts.push(a);
    return a;
  }

  async function complete({ platform, profileId, username = 'joesbakery', ads = false }) {
    const zPlatform = ads ? ADS[platform] ?? platform : platform;
    const a = addAccount({ platform: zPlatform, profileId, username });
    await sendWebhook({ event: 'account.connected', profiles: profileRef(profileId), account: { accountId: a._id, profileId, platform: zPlatform, username, displayName: a.displayName } });
    return a;
  }

  function publishResult(body, accountIds) {
    const next = outcomes.length ? outcomes.shift() : 'published';
    return { next, platforms: body.platforms.map((p, i) => ({ platform: p.platform, accountId: accountIds[i], status: next === 'failed' ? 'failed' : next === 'publishing' ? 'processing' : 'published', ...(next === 'published' ? { platformPostUrl: `https://social.example/${p.platform}/p/${oid().slice(0, 10)}` } : {}), ...(next === 'failed' ? { errorMessage: 'mock refused', errorCategory: 'user_content', errorSource: 'user' } : {}) })) };
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
    let m = /^\/connect\/([a-z]+)(\/ads)?$/.exec(p);
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
    m = /^\/accounts\/([0-9a-f]{24})$/.exec(p);
    if (m && req.method === 'DELETE') {
      const i = accounts.findIndex((a) => a._id === m[1]);
      if (i < 0) return err(res, 404, 'account_not_found', 'not_found');
      const [a] = accounts.splice(i, 1);
      void sendWebhook({ event: 'account.disconnected', profiles: profileRef(a.profileId), account: { accountId: a._id, profileId: a.profileId, platform: a.platform, username: a.username, disconnectionType: 'intentional', reason: 'Removed through the API' } });
      return json(res, 200, { message: 'Account disconnected', gracePeriodEndsAt: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (req.method === 'POST' && p === '/media/presign') {
      const id = oid();
      return json(res, 200, { uploadUrl: `${base}/__upload/${id}`, publicUrl: `${base}/__media/${id}`, expiresIn: 3600 });
    }
    if (req.method === 'POST' && p === '/posts') {
      const ik = req.headers['idempotency-key'];
      if (!ik) violations.push({ kind: 'post_without_idempotency_key' });
      if (ik && idem.has(ik)) {
        violations.push({ kind: 'post_resent', key: ik });
        return json(res, 200, { message: 'Post already exists (idempotent retry)', post: posts.find((x) => x._id === idem.get(ik)) });
      }
      // { waitFor: promise, then: outcome }: the answer waits until the test releases it (a webhook can arrive first)
      if (outcomes[0] && typeof outcomes[0] === 'object' && outcomes[0].waitFor) {
        const o = outcomes.shift();
        await o.waitFor;
        outcomes.unshift(o.then ?? 'published');
      }
      const ids = (Array.isArray(body?.platforms) ? body.platforms : []).map((t) => String(t?.accountId ?? ''));
      if (!ids.length || ids.some((id) => !accounts.some((a) => a._id === id))) return err(res, 400, 'account_not_found', 'not_found');
      for (const item of body.mediaItems ?? []) if (!uploads.has(String(item.url).split('/').pop())) violations.push({ kind: 'media_not_uploaded', url: item.url });
      const result = publishResult(body, ids);
      if (result.next === 'error500') return err(res, 500, 'internal_error', 'api_error');
      if (result.next === 'hang') {
        await new Promise((r) => setTimeout(r, 60_000));
        return err(res, 504, 'timeout', 'api_error');
      }
      const status = result.platforms.every((x) => x.status === 'published') ? 'published' : result.platforms.every((x) => x.status === 'failed') ? 'failed' : 'publishing';
      const acct = accounts.find((a) => a._id === ids[0]);
      const post = { _id: oid(), content: body.content, status, platforms: result.platforms, metadata: body.metadata ?? {}, profileId: acct?.profileId, mediaItems: body.mediaItems ?? [], createdAt: new Date().toISOString(), body };
      posts.push(post);
      if (ik) idem.set(ik, post._id);
      if (result.next === 'accepted_then_500') return err(res, 502, 'platform_api_error', 'platform_error');
      return json(res, status === 'failed' ? 207 : 201, { message: 'Post published', post });
    }
    m = /^\/posts\/([0-9a-f]{24})$/.exec(p);
    if (m && req.method === 'GET') {
      const post = posts.find((x) => x._id === m[1]);
      return post ? json(res, 200, { post }) : err(res, 404, 'post_not_found', 'not_found');
    }
    if (req.method === 'GET' && p === '/posts') {
      const list = posts.filter((x) => (!q.get('profileId') || x.profileId === q.get('profileId')) && (!q.get('fromDate') || x.createdAt.slice(0, 10) >= q.get('fromDate').slice(0, 10)));
      return json(res, 200, { posts: list, pagination: { page: 1, limit: 50, total: list.length } });
    }
    const acct = accounts.find((a) => a._id === (q.get('accountId') ?? q.get('accountIds')));
    if (req.method === 'GET' && p === '/analytics/daily-metrics') {
      if (!acct) return err(res, 404, 'account_not_found', 'not_found');
      const dailyData = [
        { date: '2026-11-01', postCount: 1, platforms: { [acct.platform]: 1 }, metrics: { impressions: 900, reach: 700, likes: 40, comments: 6, shares: 3, saves: 1, clicks: 9, views: 500 } },
        { date: '2026-11-02', postCount: 0, platforms: {}, metrics: { impressions: 400, reach: 300, likes: 12, comments: 2, shares: 0, saves: 0, clicks: 3, views: 200 } },
      ];
      return json(res, 200, { dailyData, platformBreakdown: [], totals: { postCount: 1, impressions: 1300, reach: 1000, likes: 52, comments: 8, shares: 3, saves: 1, clicks: 12, views: 700 } });
    }
    if (req.method === 'GET' && p === '/accounts/follower-stats') {
      if (!acct) return json(res, 200, { accounts: [] });
      return json(res, 200, { accounts: [{ _id: acct._id, platform: acct.platform, currentFollowers: 1310, history: [{ date: '2026-11-01', followers: 1300 }, { date: '2026-11-02', followers: 1310 }] }] });
    }
    if (req.method === 'GET' && p === '/analytics') {
      if (!acct) return json(res, 200, { posts: [] });
      return json(res, 200, { posts: [{ _id: oid(), platform: acct.platform, content: 'Fresh bread every morning <b>not html</b>', publishedAt: '2026-11-01T09:00:00Z', platformPostUrl: `https://social.example/${acct.platform}/p/1`, analytics: { likes: 40, comments: 6, shares: 3, views: 500 } }], pagination: { page: 1, pages: 1 } });
    }
    if (req.method === 'GET' && p === '/ads/timeline') {
      if (!acct) return err(res, 404, 'account_not_found', 'not_found');
      return json(res, 200, { rows: [{ date: '2026-11-01', currency: 'USD', spend: 12.5, impressions: 3000, reach: 2000, clicks: 40, conversions: 2 }, { date: '2026-11-02', currency: 'USD', spend: 7.5, impressions: 1000, reach: 900, clicks: 10, conversions: 1 }] });
    }
    if (req.method === 'GET' && p === '/ads/campaigns') {
      if (!acct) return json(res, 200, { campaigns: [] });
      return json(res, 200, { campaigns: [{ platformCampaignId: '120200001', platform: 'facebook', campaignName: 'Autumn bread', status: 'active', currency: 'USD', metrics: { spend: 20, impressions: 4000, clicks: 50, conversions: 3 } }] });
    }
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
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), idempotencyKey: req.headers['idempotency-key'] ?? null, auth: req.headers.authorization ? 'bearer' : null, body, bytes: raw.length });
    if (url.pathname === '/__calls') return json(res, 200, { calls });
    if (url.pathname === '/__violations') return json(res, 200, { violations });
    if (url.pathname === '/__complete' && req.method === 'POST') return json(res, 200, { account: await complete(body ?? {}) });
    if (url.pathname === '/__connect') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Connect (mock)</title><p>Mock Zernio connect screen.</p>');
    }
    let m = /^\/__upload\/([0-9a-f]{24})$/.exec(url.pathname);
    if (m && req.method === 'PUT') {
      if (req.headers.authorization) violations.push({ kind: 'key_on_upload' });
      uploads.set(m[1], { type: req.headers['content-type'], bytes: raw.length });
      res.writeHead(200, { etag: '"mock"' });
      return res.end();
    }
    m = /^\/__media\/([0-9a-f]{24})$/.exec(url.pathname);
    if (m) return uploads.has(m[1]) ? (res.writeHead(200, { 'content-type': uploads.get(m[1]).type ?? 'application/octet-stream' }), res.end()) : err(res, 404, 'not_found');
    if (!url.pathname.startsWith('/api/v1/')) return err(res, 404, 'not_found', 'not_found');
    if (req.headers.authorization !== `Bearer ${key}`) return err(res, 401, 'invalid_credentials', 'authentication_error');
    return api(req, res, url, body, raw);
  }

  return {
    profiles,
    accounts,
    posts,
    uploads,
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
    /**
     * What the next POST /posts does: 'published' | 'failed' | 'publishing' | 'error500' | 'hang' | 'accepted_then_500',
     * or { waitFor: promise, then: one of those } to hold the answer until the promise settles.
     */
    setPostOutcome(...next) {
      outcomes.push(...next);
    },
    addAccount,
    complete,
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
      server?.closeAllConnections?.();
      await new Promise((r) => (server ? server.close(() => r()) : r()));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await createMockZernio().start(Number(process.argv[2] || 0));
  console.log(mock.apiBase);
}
