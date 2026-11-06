// A stand-in for Upload-Post's API (https://docs.upload-post.com), for tests and offline QA. Nothing here calls
// Upload-Post or a network. Same style as server/test/mock-zernio.mjs:
//
//   node server/test/mock-uploadpost.mjs [port]   → prints its base URL; use it as UPLOAD_POST_BASE_URL
//   const mock = await createMockUploadPost().start();
//
// What it answers (under /api, `Authorization: Apikey <test key>`; anything else 401 "Invalid API key"):
//   GET    /uploadposts/me
//   POST   /uploadposts/users                    201 {profile} | 409 exists | 403 PROFILE_LIMIT_REACHED (cap)
//   GET    /uploadposts/users                    {limit, plan, profiles}
//   GET    /uploadposts/users/:username          {profile} | 404
//   DELETE /uploadposts/users                    JSON {username}
//   POST   /uploadposts/users/generate-jwt       {access_url, duration} | 403 PROFILE_BLOCKED | 404 PROFILE_NOT_FOUND
//   DELETE /uploadposts/users/social             JSON {profile_username, social_platform}
//   GET    /uploadposts/facebook/pages?profile=  GET /uploadposts/linkedin/pages?profile=
//   GET    /uploadposts/users/facebook-page?profile_username=   GET /uploadposts/users/linkedin-page?…  (pins)
//   GET    /uploadposts/tiktok/settings?profile=
//   POST   /upload  /upload_photos  /upload_text  multipart; per the next queued outcome (setUploadOutcome)
//   GET    /uploadposts/status?request_id=       GET /uploadposts/history?request_id=
//   GET    /analytics/:username?platforms=       GET /uploadposts/post-analytics/cached?user=
// Test hooks: mock.connect(username, platform, extra), mock.setStatus(requestId, …), mock.signed(event, …).
//
// Violations a test fails on: an upload without Idempotency-Key, a second upload with a key it has seen (a
// resend), the API key in a query string, a Pages/boards list without profile=, an external_id over 200 chars.

import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const TEST_UPLOAD_POST_KEY = 'up_test_key_000000000000000000000000';
export const TEST_UPLOAD_POST_WEBHOOK_SECRET = 'whsec_test_upload_post_secret_0000';

/** The X-Upload-Post-* headers for a body, as Upload-Post signs it: sha256=hex(HMAC(secret, `${ts}.${raw}`)). */
export function signUploadPost(rawBody, { secret = TEST_UPLOAD_POST_WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000), event = 'upload_completed', delivery = crypto.randomUUID() } = {}) {
  const sig = crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${ts}.`), Buffer.from(rawBody)])).digest('hex');
  return { 'x-upload-post-signature': `sha256=${sig}`, 'x-upload-post-timestamp': String(ts), 'x-upload-post-event': event, 'x-upload-post-delivery': delivery, 'user-agent': 'Upload-Post-Webhooks/1.0' };
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'x-ratelimit-limit': '200', 'x-ratelimit-remaining': '199', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60), ...headers });
  res.end(JSON.stringify(body));
};
const rid = () => crypto.randomBytes(8).toString('hex');

export function createMockUploadPost({ key = TEST_UPLOAD_POST_KEY, cap = 75, webhookSecret = TEST_UPLOAD_POST_WEBHOOK_SECRET } = {}) {
  const profiles = new Map(); // username → { username, display_name, created_at, social_accounts }
  const calls = [];
  const violations = [];
  const jwtBodies = [];
  const outcomes = []; // queued upload outcomes
  const requests = new Map(); // request_id → { user, platforms, kind, status, results, external_id, form }
  const idem = new Map(); // Idempotency-Key → request_id
  const pins = { facebook: new Map(), linkedin: new Map() }; // username → page id
  const pages = { facebook: new Map(), linkedin: new Map() }; // username → [{ id, name }]
  const tiktokPrivacy = new Map(); // username → options
  const blocked = new Set(); // usernames that answer PROFILE_BLOCKED on generate-jwt
  let profileCap = cap;
  let server = null;
  let base = '';

  const err = (res, status, message, extra = {}) => json(res, status, { success: false, message, ...extra });

  function profileOut(p) {
    return { username: p.username, display_name: p.display_name ?? null, created_at: p.created_at, social_accounts: p.social_accounts };
  }

  /** Connect a social account to a profile (what the hosted page does). */
  function connect(username, platform, { id = `acct_${platform}_${rid().slice(0, 6)}`, handle = 'joesbakery', display_name = `Joe’s Bakery (${platform})`, reauth_required = false, capabilities } = {}) {
    const p = profiles.get(username);
    if (!p) throw new Error(`mock: no profile ${username}`);
    p.social_accounts[platform] = { username: id, handle, display_name, social_images: 'https://cdn.example/avatar.png', reauth_required, ...(capabilities ? { capabilities } : {}) };
    return p.social_accounts[platform];
  }

  function resultFor(platform, outcome, requestId) {
    if (outcome === 'platform_failed') return { success: false, error: 'mock: the network said no (raw text)', error_code: 'content_rejected' };
    if (outcome === 'reauth') return { success: false, error: 'Expired access token', error_code: 'account_reauth_required', reauth_required: true };
    if (outcome === 'skipped') return { success: false, skipped: true, skip_reason: 'profile_platform_not_configured', error_code: 'profile_platform_mapping_invalid' };
    if (outcome === 'inbox') return { success: true, fallback_to_inbox: true, post_url: 'Video sent to Inbox (No Public URL)' };
    if (outcome === 'privacy') return { success: false, error_code: 'tiktok_privacy_unavailable' };
    return { success: true, url: `https://social.example/${platform}/p/${requestId.slice(0, 8)}`, post_id: `pid_${requestId.slice(0, 8)}` };
  }

  async function upload(req, res, kind, form) {
    const ik = req.headers['idempotency-key'];
    if (!ik) violations.push({ kind: 'upload_without_idempotency_key' });
    if (ik && idem.has(ik)) {
      violations.push({ kind: 'upload_resent', key: ik });
      const r = requests.get(idem.get(ik));
      return json(res, 200, { success: true, idempotent_replay: true, request_id: r?.request_id });
    }
    const user = form.get('user');
    const platforms = form.getAll('platform[]');
    const external = form.get('external_id');
    if (external && String(external).length > 200) violations.push({ kind: 'external_id_too_long' });
    const p = profiles.get(String(user));
    if (!p) return err(res, 400, 'Username not associated with any profile');
    let next = outcomes.length ? outcomes.shift() : 'ok';
    if (next && typeof next === 'object' && next.waitFor) {
      await next.waitFor;
      next = next.then ?? 'ok';
    }
    if (next === 'unauthorized') return err(res, 401, 'Invalid API key');
    if (next === 'hard_cap') return json(res, 429, { success: false, message: 'Post verification failed', violations: [{ platform: platforms[0], type: 'hard_cap', message: 'Daily cap reached', used_last_24h: 50, cap: 50 }] });
    if (next === 'scheduled_limit') return json(res, 429, { success: false, error_code: 'SCHEDULED_POSTS_LIMIT', message: 'Your plan (Advanced) allows 40000 pending posts; upgrade at https://upload-post.com/pricing' });
    if (next === 'error500') return err(res, 500, 'Internal error: something about our infrastructure');
    if (next === 'hang') {
      await new Promise((r) => setTimeout(r, 60_000));
      return err(res, 504, 'timeout');
    }
    if (!platforms.some((pl) => p.social_accounts[pl])) return err(res, 400, `Invalid platforms: ${platforms.join(',')}`, { invalid_platforms: platforms });
    const requestId = String(form.get('request_id') || rid());
    const record = { request_id: requestId, user: p.username, platforms, kind, external_id: external, form: Object.fromEntries([...form.keys()].map((k) => [k, form.getAll(k).length > 1 || k.endsWith('[]') ? form.getAll(k) : form.get(k)])), status: 'completed', results: {} };
    for (const pl of platforms) record.results[pl] = p.social_accounts[pl] ? resultFor(pl, next, requestId) : resultFor(pl, 'skipped', requestId);
    requests.set(requestId, record);
    if (ik) idem.set(ik, requestId);
    if (next === 'accepted_then_500') return err(res, 502, 'Bad gateway');
    // 'async' / 'async_pending': answered in the background (as after the 59 s fallback); async_upload=true too
    if (next === 'async' || next === 'async_pending' || form.get('async_upload') === 'true') {
      record.pendingPolls = next === 'async_pending' ? Infinity : next === 'async' ? 1 : 0;
      return json(res, 200, { success: true, message: 'Upload initiated successfully in background.', request_id: requestId, total_platforms: platforms.length });
    }
    record.pendingPolls = 0;
    return json(res, 200, { success: true, results: record.results, usage: { count: 12, limit: 100, last_reset: '2026-11-01T00:00:00.000Z' } });
  }

  function statusOf(r) {
    if (r.pendingPolls > 0) {
      r.pendingPolls -= 1;
      return { request_id: r.request_id, external_id: r.external_id, status: 'in_progress', completed: 0, total: r.platforms.length, results: [], last_update: new Date().toISOString() };
    }
    const results = r.platforms.map((pl) => {
      const x = r.results[pl];
      return { platform: pl, success: !!x.success, ...(x.skipped ? { status: 'skipped', skipped: true } : { status: x.success ? 'completed' : 'failed' }), ...(x.error_code ? { error_code: x.error_code } : {}), ...(x.error ? { message: x.error } : {}), ...(x.url ? { post_url: x.url } : {}), ...(x.post_url ? { post_url: x.post_url } : {}), ...(x.fallback_to_inbox ? { fallback_to_inbox: true } : {}), ...(x.reauth_required ? { reauth_required: true } : {}) };
    });
    return { request_id: r.request_id, external_id: r.external_id, status: r.status, completed: results.length, total: results.length, results, last_update: new Date().toISOString() };
  }

  async function api(req, res, url, body, form) {
    const p = url.pathname.replace(/^\/api/, '');
    const q = url.searchParams;
    const m = req.method;
    if (m === 'GET' && p === '/uploadposts/me') return json(res, 200, { success: true, message: 'Token is valid', email: 'owner@example.com', plan: 'Advanced' });
    if (p === '/uploadposts/users' && m === 'POST') {
      const username = String(body?.username ?? '');
      if (!/^[A-Za-z0-9_@-]{1,64}$/.test(username)) return err(res, 400, 'Username required');
      if (profiles.has(username)) return err(res, 409, 'User already exists');
      if (profiles.size >= profileCap) return err(res, 403, 'You have reached the PROFILE_LIMIT_REACHED for your plan (Advanced, owner@example.com)', { error_code: 'PROFILE_LIMIT_REACHED' });
      const prof = { username, display_name: body?.display_name ?? null, created_at: new Date().toUTCString(), social_accounts: {} };
      profiles.set(username, prof);
      return json(res, 201, { success: true, profile: profileOut(prof) });
    }
    if (p === '/uploadposts/users' && m === 'GET') return json(res, 200, { success: true, limit: profileCap, plan: 'advanced', profiles: [...profiles.values()].map(profileOut) });
    if (p === '/uploadposts/users' && m === 'DELETE') {
      const username = String(body?.username ?? '');
      if (!profiles.delete(username)) return err(res, 404, 'Profile not found');
      return json(res, 200, { success: true, message: 'Perfil eliminado correctamente' });
    }
    if (p === '/uploadposts/users/generate-jwt' && m === 'POST') {
      jwtBodies.push(body);
      const username = String(body?.username ?? '');
      if (!profiles.has(username)) return err(res, 404, 'PROFILE_NOT_FOUND', { error_code: 'PROFILE_NOT_FOUND' });
      if (blocked.has(username)) return err(res, 403, 'PROFILE_BLOCKED: over your plan limit', { error_code: 'PROFILE_BLOCKED' });
      return json(res, 200, { success: true, access_url: `${base}/connect?token=jwt_${rid()}${rid()}`, duration: '48h' });
    }
    if (p === '/uploadposts/users/social' && m === 'DELETE') {
      const prof = profiles.get(String(body?.profile_username ?? ''));
      const plat = String(body?.social_platform ?? '');
      if (!prof || !prof.social_accounts[plat]) return err(res, 404, 'Not found');
      delete prof.social_accounts[plat];
      return json(res, 200, { success: true, message: `Social platform ${plat} disconnected successfully` });
    }
    let mm = /^\/uploadposts\/users\/(facebook|linkedin)-page$/.exec(p);
    if (mm && m === 'GET') {
      const pin = pins[mm[1]].get(String(q.get('profile_username') ?? ''));
      return json(res, 200, { success: true, ...(pin ? { [`${mm[1]}_page_id`]: pin } : {}) });
    }
    mm = /^\/uploadposts\/users\/([A-Za-z0-9_@-]+)$/.exec(p);
    if (mm && m === 'GET') {
      const prof = profiles.get(mm[1]);
      return prof ? json(res, 200, { success: true, profile: profileOut(prof) }) : err(res, 404, 'Profile not found');
    }
    mm = /^\/uploadposts\/(facebook|linkedin)\/pages$/.exec(p);
    if (mm && m === 'GET') {
      const who = q.get('profile');
      if (!who) {
        violations.push({ kind: 'pages_without_profile', platform: mm[1] });
        return json(res, 200, { success: true, pages: [...pages[mm[1]].values()].flat() });
      }
      return json(res, 200, { success: true, pages: pages[mm[1]].get(who) ?? [] });
    }
    if (p === '/uploadposts/tiktok/settings' && m === 'GET') {
      const who = String(q.get('profile') ?? '');
      if (!profiles.get(who)?.social_accounts.tiktok) return err(res, 400, 'tiktok_reconnect_required', { error_code: 'tiktok_reconnect_required' });
      return json(res, 200, { success: true, privacy_level_options: tiktokPrivacy.get(who) ?? ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'], max_video_post_duration_sec: 600, comment_disabled: false, duet_disabled: false, stitch_disabled: false });
    }
    if (m === 'POST' && (p === '/upload' || p === '/upload_photos' || p === '/upload_text')) {
      if (!form) return err(res, 400, 'multipart/form-data required');
      return upload(req, res, p === '/upload' ? 'video' : p === '/upload_photos' ? 'photo' : 'text', form);
    }
    if (p === '/uploadposts/status' && m === 'GET') {
      const r = requests.get(String(q.get('request_id') ?? ''));
      if (!q.get('request_id') && !q.get('job_id')) return json(res, 400, { error: 'request_id or job_id is required' });
      if (!r) return json(res, 404, { status: 'not_found' });
      return json(res, 200, statusOf(r));
    }
    if (p === '/uploadposts/history' && m === 'GET') {
      const r = requests.get(String(q.get('request_id') ?? ''));
      const rows = r && r.pendingPolls <= 0 ? r.platforms.map((pl) => ({ profile_username: r.user, platform: pl, request_id: r.request_id, success: !!r.results[pl].success, post_url: r.results[pl].url ?? r.results[pl].post_url ?? null, platform_post_id: r.results[pl].post_id ?? null, fallback_to_inbox: !!r.results[pl].fallback_to_inbox })) : [];
      return json(res, 200, { history: rows, in_progress: [], total: rows.length, page: 1, limit: 20 });
    }
    mm = /^\/analytics\/([A-Za-z0-9_@-]+)$/.exec(p);
    if (mm && m === 'GET') {
      const prof = profiles.get(mm[1]);
      if (!prof) return err(res, 404, 'Profile not found');
      const out = { success: true };
      for (const pl of String(q.get('platforms') ?? '').split(',').filter(Boolean)) {
        if (pl === 'facebook' && !q.get('page_id')) {
          out[pl] = { success: false, message: 'page_id is required for facebook' };
          continue;
        }
        out[pl] = { followers: 1310, reach: 1000, views: 700, impressions: 700, likes: 52, comments: 8, shares: 3, saves: 1, reach_timeseries: [{ date: '2026-11-01', value: 700 }, { date: '2026-11-02', value: 300 }], metric_type: 'reach' };
      }
      return json(res, 200, out);
    }
    if (p === '/uploadposts/post-analytics/cached' && m === 'GET') {
      return json(res, 200, { source: 'snapshot_cache', posts: [{ post_id: 'pid_1', platform: q.get('platform') ?? 'instagram', profile_username: q.get('user'), date: '2026-11-01', metrics: { likes: 40, comments: 6, shares: 3, views: 500 }, post_url: 'https://social.example/p/1', media_type: 'photo', upload_timestamp: '2026-11-01T09:00:00Z' }], limit: 50, has_more: false });
    }
    return err(res, 404, 'Not found');
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://mock');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const type = String(req.headers['content-type'] ?? '');
    let body = null;
    let form = null;
    if (raw.length && /json/.test(type)) {
      try {
        body = JSON.parse(raw.toString());
      } catch {
        body = null;
      }
    } else if (raw.length && /multipart\/form-data/.test(type)) {
      try {
        form = await new Request('http://mock/', { method: 'POST', headers: { 'content-type': type }, body: raw }).formData();
      } catch {
        form = null;
      }
    }
    if (url.search.includes(key)) violations.push({ kind: 'key_in_query', path: url.pathname });
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), idempotencyKey: req.headers['idempotency-key'] ?? null, auth: /^Apikey /.test(String(req.headers.authorization ?? '')) ? 'apikey' : null, body, form: form ? Object.fromEntries([...new Set(form.keys())].map((k) => [k, k.endsWith('[]') ? form.getAll(k) : form.get(k)])) : null });
    if (url.pathname === '/connect') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Connect (mock)</title><p>Mock Upload-Post connect page.</p>');
    }
    if (!url.pathname.startsWith('/api/')) return err(res, 404, 'Not found');
    if (req.headers.authorization !== `Apikey ${key}`) return err(res, 401, 'Invalid API key');
    return api(req, res, url, body, form);
  }

  return {
    profiles,
    calls,
    violations,
    jwtBodies,
    requests,
    pins,
    pages,
    tiktokPrivacy,
    blocked,
    get base() {
      return `${base}/api`;
    },
    set cap(n) {
      profileCap = n;
    },
    connect,
    /** Add a profile directly (as if made earlier, e.g. by another customer). */
    addProfile(username) {
      profiles.set(username, { username, display_name: null, created_at: new Date().toISOString(), social_accounts: {} });
    },
    /**
     * What the next upload does: 'ok' | 'async' | 'async_pending' | 'platform_failed' | 'reauth' | 'skipped' |
     * 'inbox' | 'privacy' | 'hard_cap' | 'scheduled_limit' | 'unauthorized' | 'error500' | 'hang' |
     * 'accepted_then_500', or { waitFor: promise, then } to hold the answer.
     */
    setUploadOutcome(...next) {
      outcomes.push(...next);
    },
    /** Finish an async request now (the next /status read answers its results). */
    finish(requestId) {
      const r = requests.get(requestId);
      if (r) r.pendingPolls = 0;
    },
    /** An event as Upload-Post would sign it, for calling a webhook handler directly: { raw, headers, payload }. */
    signed(event, opts = {}) {
      const payload = { created_at: new Date().toISOString(), ...event };
      const raw = Buffer.from(JSON.stringify(payload));
      return { raw, payload, headers: signUploadPost(raw, { secret: webhookSecret, event: payload.event, ...opts }) };
    },
    uploadCalls() {
      return calls.filter((c) => c.method === 'POST' && /^\/api\/upload(_photos|_text)?$/.test(c.path));
    },
    async start(port = 0) {
      server = http.createServer((req, res) => void handler(req, res).catch(() => err(res, 500, 'internal')));
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
  const mock = await createMockUploadPost().start(Number(process.argv[2] || 0));
  console.log(mock.base);
}
