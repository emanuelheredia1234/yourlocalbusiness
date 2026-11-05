// A stand-in for the social networks' APIs, for tests and offline QA (spec §9.1 mock-social-providers): Graph
// v26 (Facebook Pages and Instagram), LinkedIn, TikTok, X and YouTube, plus canned answers for the analytics
// reads (Google Ads search, Meta ads insights, Search Console, site verification). Nothing here is a real
// network: every id and token is fake.
//
// One server answers every network's paths. It's reached two ways, like the real ones:
// - through the connections proxy (mock-nango in QA, or createProxyConnections() below in unit tests), which
//   marks its calls `via: 'proxy'` and fills the {target} / {ig_user} placeholders;
// - directly, for server/social/direct.mjs: Graph with the Page token (GRAPH_BASE_URL=<this url>) and the upload
//   addresses it hands out (SOCIAL_MOCK_BASE_URL=<this url>).
// Every call is recorded (GET /__calls, or .calls) with its method, path, query, headers and body length.
// Faults: POST /__fail { path, method?, mode: 'timeout'|'500'|'500_after_create'|'400'|'401'|'429', times?, delayMs? }
// ('timeout' and '500_after_create' still do the work, as a network that timed out after creating the post).
//
//   node server/test/mock-social-providers.mjs [port]   → prints its base URL

import http from 'node:http';
import { fileURLToPath } from 'node:url';

/** The fake Page token the Graph mock hands out and expects (a test asserts it never reaches the proxy). */
export const FB_PAGE_TOKEN = 'test-fb-page-token-7f3a';
export const FB_PAGE_ID = '1029384756';
export const IG_USER_ID = '17841400000000001';
export const LI_PERSON = 'aBcD123xyz';
export const LI_ORG = '5551234';
export const X_USER_ID = '4242424242';

const WHITELIST = ['location', 'x-restli-id', 'content-type', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

/** clock: () => ms, for the times posts are stamped with (tests that move time pass theirs). */
export function createMockSocialProviders({ clock = () => Date.now() } = {}) {
  const calls = [];
  const faults = [];
  const sockets = new Set();
  let server;
  let base = '';
  let n = 0;
  const next = () => ++n;
  const fresh = () => ({
    fbFeed: [], // {id, message, created_time}
    igContainers: new Map(), // id → status_code
    igMedia: new Map(), // media id → container id
    igQuota: { used: 0, total: 100 },
    igVideoStatus: ['IN_PROGRESS', 'FINISHED'], // what a video container answers, in turn
    liPosts: [],
    tiktokOptions: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
    tiktokStatus: ['PROCESSING_UPLOAD', 'PUBLISH_COMPLETE'], // status/fetch answers, in turn (the last repeats)
    tiktokPublishes: new Map(), // publish_id → index into tiktokStatus
    tweets: [],
    xMedia: new Map(),
    ytVideos: [],
    uploads: [], // { network, bytes }
  });
  let state = fresh();

  const now = () => new Date(clock()).toISOString();

  function send(res, status, body, headers = {}) {
    if (res.writableEnded || res.destroyed) return;
    const data = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(data);
  }

  function faultFor(method, path) {
    const f = faults.find((x) => (!x.method || x.method === method) && (x.path instanceof RegExp ? x.path.test(path) : path.startsWith(x.path)) && x.times !== 0);
    if (f && f.times > 0) f.times -= 1;
    return f ?? null;
  }

  const bearer = (req) => /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1] ?? '';

  /** The network's answer to one call: [status, body, headers] (it may change state). */
  function answer(req, path, q, body, raw, via) {
    const m = (re) => re.exec(path);
    let g;
    const method = req.method;
    const direct = via !== 'proxy';

    // ───── Graph: Facebook Pages + Instagram (v26.0) ─────
    if ((g = m(/^\/v26\.0\/(\d+)$/)) && method === 'GET') {
      const id = g[1];
      if (q.get('fields') === 'access_token') return id === FB_PAGE_ID && !direct ? [200, { id, access_token: FB_PAGE_TOKEN }] : [400, { error: { message: 'Unsupported get request.' } }];
      if (q.get('fields') === 'status_code') {
        if (!state.igContainers.has(id)) return [400, { error: { message: 'Unsupported get request.' } }];
        const s = state.igContainers.get(id);
        // a video container moves through its list, one step per read; the last one stays
        const cur = Array.isArray(s) ? (s.length > 1 ? s.shift() : s[0]) : s;
        return [200, { id, status_code: cur }];
      }
      if (q.get('fields') === 'permalink') return [200, { id, permalink: `https://www.instagram.com/p/MOCK${id}/` }];
      return [200, { id, name: 'Joe’s Bakery', instagram_business_account: { id: IG_USER_ID } }];
    }
    if ((g = m(/^\/v26\.0\/(\d+)\/(feed|photos)$/)) && method === 'POST') {
      if (!direct || bearer(req) !== FB_PAGE_TOKEN) return [401, { error: { message: 'Invalid OAuth access token.', code: 190 } }];
      if (g[1] !== FB_PAGE_ID) return [400, { error: { message: 'Unknown page' } }];
      const id = `${FB_PAGE_ID}_${next()}`;
      state.fbFeed.unshift({ id, message: String(body?.message ?? ''), created_time: now() });
      return [200, g[2] === 'photos' ? { id: String(next()), post_id: id } : { id }];
    }
    if ((g = m(/^\/v26\.0\/(\d+)\/feed$/)) && method === 'GET') {
      if (!direct || bearer(req) !== FB_PAGE_TOKEN) return [401, { error: { message: 'Invalid OAuth access token.', code: 190 } }];
      return [200, { data: state.fbFeed.slice(0, Number(q.get('limit')) || 25) }];
    }
    if ((g = m(/^\/v26\.0\/([\d_]+)\/comments$/)) && method === 'POST') {
      return [200, { id: `${g[1]}_c${next()}` }];
    }
    if ((g = m(/^\/v26\.0\/(\d+)\/content_publishing_limit$/)) && method === 'GET') {
      return [200, { data: [{ quota_usage: state.igQuota.used, config: { quota_total: state.igQuota.total, quota_duration: 86400 } }] }];
    }
    if ((g = m(/^\/v26\.0\/(\d+)\/media$/)) && method === 'POST') {
      if (g[1] !== IG_USER_ID) return [400, { error: { message: 'Unknown user' } }];
      if (!body?.image_url && !body?.video_url) return [400, { error: { message: 'media url required' } }];
      const id = String(9_000_000 + next());
      state.igContainers.set(id, body.video_url ? [...state.igVideoStatus] : 'FINISHED');
      return [200, { id }];
    }
    if ((g = m(/^\/v26\.0\/(\d+)\/media_publish$/)) && method === 'POST') {
      const c = String(body?.creation_id ?? '');
      if (!state.igContainers.has(c)) return [400, { error: { message: 'Invalid creation id' } }];
      state.igContainers.set(c, 'PUBLISHED');
      const id = String(18_000_000 + next());
      state.igMedia.set(id, c);
      state.igQuota.used += 1;
      return [200, { id }];
    }
    if ((g = m(/^\/v26\.0\/([\w]+)\/insights$/)) && method === 'GET') return [200, { data: [] }];
    if ((g = m(/^\/v26\.0\/me\/(accounts|adaccounts|permissions)$/)) && method === 'GET') {
      if (g[1] === 'accounts') return [200, { data: [{ id: FB_PAGE_ID, name: 'Joe’s Bakery', tasks: ['CREATE_CONTENT', 'MANAGE', 'MODERATE', 'ANALYZE'], instagram_business_account: { id: IG_USER_ID } }] }];
      if (g[1] === 'adaccounts') return [200, { data: [{ id: 'act_111', account_id: '111', name: 'Joe’s ads', currency: 'USD', account_status: 1 }] }];
      return [200, { data: [{ permission: 'pages_manage_posts', status: 'granted' }] }];
    }
    if ((g = m(/^\/v26\.0\/act_(\d+)\/insights$/)) && method === 'GET') return [200, { data: [] }];

    // ───── LinkedIn ─────
    if (path === '/v2/userinfo' && method === 'GET') return [200, { sub: LI_PERSON, name: 'Joe Baker' }];
    if ((g = m(/^\/rest\/organizations\/(\d+)$/)) && method === 'GET') return [200, { id: Number(g[1]), localizedName: 'Joe’s Bakery Inc' }];
    if (path === '/rest/images' && method === 'POST' && q.get('action') === 'initializeUpload') {
      const k = next();
      return [200, { value: { uploadUrl: `${base}/upload/linkedin/${k}`, image: `urn:li:image:C4E${k}`, uploadUrlExpiresAt: Date.now() + 86_400_000 } }];
    }
    if (path === '/rest/posts' && method === 'POST') {
      const urn = `urn:li:share:${7_000_000 + next()}`;
      state.liPosts.unshift({ id: urn, author: body?.author, commentary: String(body?.commentary ?? ''), createdAt: clock(), content: body?.content ?? null });
      return [201, null, { 'x-restli-id': urn }];
    }
    if (path === '/rest/posts' && method === 'GET') return [200, { elements: state.liPosts.filter((p) => !q.get('author') || p.author === q.get('author')).slice(0, Number(q.get('count')) || 10) }];
    if ((g = m(/^\/rest\/socialActions\/([^/]+)\/comments$/)) && method === 'POST') return [201, { id: `c${next()}` }];
    if (path.startsWith('/rest/organizationalEntity') || path.startsWith('/rest/memberCreatorPostAnalytics') || path.startsWith('/rest/organizationAcls')) return [200, { elements: [] }];

    // ───── TikTok ─────
    if (path === '/v2/post/publish/creator_info/query/' && method === 'POST') {
      return [200, { data: { creator_nickname: 'joesbakery', privacy_level_options: state.tiktokOptions, max_video_post_duration_sec: 600 }, error: { code: 'ok', message: '' } }];
    }
    if ((path === '/v2/post/publish/video/init/' || path === '/v2/post/publish/content/init/') && method === 'POST') {
      if (!body?.post_info?.privacy_level) return [400, { error: { code: 'invalid_params', message: 'privacy_level' } }];
      const id = `v_pub_file~v2-1.${next()}`;
      state.tiktokPublishes.set(id, 0);
      const fileUpload = body?.source_info?.source === 'FILE_UPLOAD';
      return [200, { data: { publish_id: id, ...(fileUpload ? { upload_url: `${base}/upload/tiktok/${encodeURIComponent(id)}` } : {}) }, error: { code: 'ok', message: '' } }];
    }
    if (path === '/v2/post/publish/status/fetch/' && method === 'POST') {
      const id = String(body?.publish_id ?? '');
      if (!state.tiktokPublishes.has(id)) return [200, { data: {}, error: { code: 'invalid_publish_id', message: '' } }];
      const i = state.tiktokPublishes.get(id);
      const s = state.tiktokStatus[Math.min(i, state.tiktokStatus.length - 1)];
      state.tiktokPublishes.set(id, i + 1);
      return [200, { data: { status: s, ...(s === 'PUBLISH_COMPLETE' ? { publicaly_available_post_id: [String(7_300_000_000 + next())] } : {}) }, error: { code: 'ok', message: '' } }];
    }
    if (path === '/v2/user/info/' && method === 'GET') return [200, { data: { user: { open_id: 'tt-open-1', display_name: 'joesbakery', follower_count: 120 } }, error: { code: 'ok' } }];
    if (path === '/v2/video/list/' && method === 'POST') return [200, { data: { videos: [], has_more: false }, error: { code: 'ok' } }];

    // ───── X ─────
    if (path === '/2/media/upload' && method === 'POST') {
      if (!body?.media) return [400, { errors: [{ message: 'media required' }] }];
      const id = String(1_800_000_000 + next());
      state.xMedia.set(id, 'succeeded');
      return [200, { data: { id, media_key: `3_${id}` } }];
    }
    if (path === '/2/media/upload/initialize' && method === 'POST') {
      const id = String(1_900_000_000 + next());
      state.xMedia.set(id, 'pending');
      return [200, { data: { id, expires_after_secs: 86400 } }];
    }
    if ((g = m(/^\/2\/media\/upload\/(\d+)\/(append|finalize)$/)) && method === 'POST') {
      if (!state.xMedia.has(g[1])) return [400, { errors: [{ message: 'unknown media' }] }];
      if (g[2] === 'finalize') {
        state.xMedia.set(g[1], 'in_progress');
        return [200, { data: { id: g[1], processing_info: { state: 'pending', check_after_secs: 1 } } }];
      }
      return [200, {}];
    }
    if (path === '/2/media/upload' && method === 'GET' && q.get('command') === 'STATUS') {
      const id = q.get('media_id') ?? '';
      if (!state.xMedia.has(id)) return [400, { errors: [{ message: 'unknown media' }] }];
      state.xMedia.set(id, 'succeeded');
      return [200, { data: { id, processing_info: { state: 'succeeded', progress_percent: 100 } } }];
    }
    if (path === '/2/tweets' && method === 'POST') {
      const id = String(1_850_000_000_000_000 + next());
      state.tweets.unshift({ id, text: String(body?.text ?? ''), created_at: now(), reply: body?.reply ?? null });
      return [201, { data: { id, text: String(body?.text ?? '') } }];
    }
    if (path === '/2/users/me' && method === 'GET') return [200, { data: { id: X_USER_ID, username: 'joesbakery', public_metrics: { followers_count: 50 } } }];
    if ((g = m(/^\/2\/users\/(\d+)\/tweets$/)) && method === 'GET') return [200, { data: state.tweets.filter((t) => !t.reply).slice(0, Number(q.get('max_results')) || 10) }];

    // ───── YouTube ─────
    if (path === '/upload/youtube/v3/videos' && method === 'POST' && q.get('uploadType') === 'resumable') {
      if (!body?.snippet?.title) return [400, { error: { message: 'title required' } }];
      return [200, null, { location: `${base}/upload/youtube/session-${next()}?upload_id=mock`, 'x-mock-title': encodeURIComponent(body.snippet.title) }];
    }
    if (path === '/youtube/v3/search' && method === 'GET') return [200, { items: state.ytVideos.slice(0, Number(q.get('maxResults')) || 5) }];
    if (path === '/youtube/v3/channels' && method === 'GET') return [200, { items: [{ id: 'UCmock', snippet: { title: 'Joe’s Bakery' }, statistics: { subscriberCount: '10' } }] }];
    if (path === '/v2/reports' && method === 'GET') return [200, { columnHeaders: [], rows: [] }];

    // ───── upload addresses (direct PUTs) ─────
    if ((g = m(/^\/upload\/(linkedin|tiktok|youtube)\/(.+)$/)) && method === 'PUT') {
      if (req.headers.authorization) return [400, { error: 'unexpected authorization on a pre-signed upload' }];
      state.uploads.push({ network: g[1], bytes: raw.length, range: req.headers['content-range'] ?? null });
      if (g[1] === 'youtube') {
        const id = `yt${String(next()).padStart(9, '0')}`;
        state.ytVideos.unshift({ id: { kind: 'youtube#video', videoId: id }, snippet: { title: state.lastYtTitle ?? '', publishedAt: now() } });
        return [200, { id, kind: 'youtube#video', status: { uploadStatus: 'uploaded' } }];
      }
      return [201, {}];
    }

    // ───── ads, Search Console, site verification (the analytics reads) ─────
    if ((g = m(/^\/v26\/customers(:listAccessibleCustomers|\/\d+\/googleAds:search)$/))) return [200, g[1].startsWith(':') ? { resourceNames: ['customers/1234567890'] } : { results: [] }];
    if (path === '/webmasters/v3/sites' || path === '/v3/sites') return [200, { siteEntry: [] }];
    if (/^\/(webmasters\/)?v3\/sites\/[^/]+(\/sitemaps\/[^/]+)?$/.test(path) && method === 'PUT') return [204, null];
    if (/^\/(webmasters\/)?v3\/sites\/[^/]+\/searchAnalytics\/query$/.test(path)) return [200, { rows: [] }];
    if (path === '/v1/urlInspection/index:inspect' && method === 'POST') return [200, { inspectionResult: { indexStatusResult: { verdict: 'NEUTRAL', coverageState: 'URL is unknown to Google' } } }];
    if (path === '/siteVerification/v1/token' && method === 'POST') return [200, { method: 'DNS_TXT', token: 'google-site-verification=mock' }];
    if (path === '/siteVerification/v1/webResource' && method === 'POST') return [200, { id: 'dns://example.com', site: body?.site ?? {} }];

    return [404, { error: { message: `mock-social-providers: no route ${method} ${path}` } }];
  }

  async function handle(req, res, raw) {
    const url = new URL(req.url, 'http://mock');
    const path = url.pathname;
    if (path === '/__calls' && req.method === 'GET') return send(res, 200, { calls });
    if (path === '/__reset' && req.method === 'POST') {
      api.reset();
      return send(res, 200, { ok: true });
    }
    if (path === '/__fail' && req.method === 'POST') {
      const f = JSON.parse(raw.toString() || '{}');
      api.fail(f);
      return send(res, 200, { ok: true });
    }
    let body = null;
    if (raw.length && /json/i.test(String(req.headers['content-type'] || ''))) {
      try {
        body = JSON.parse(raw.toString());
      } catch {
        return send(res, 400, { error: 'bad json' });
      }
    }
    const via = req.headers['x-mock-via'] === 'proxy' ? 'proxy' : 'direct';
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    calls.push({ via, platform: req.headers['x-mock-platform'] || null, method: req.method, path, query: Object.fromEntries(url.searchParams), headers, bodyLength: raw.length, body, at: Date.now() });
    if (path === '/upload/youtube/v3/videos' && body?.snippet?.title) state.lastYtTitle = body.snippet.title;
    const f = faultFor(req.method, path);
    if (f && ['400', '401', '429', '500'].includes(String(f.mode))) {
      const status = Number(f.mode);
      return send(res, status, { error: { message: `mock fault ${status}` } }, status === 429 ? { 'retry-after': '1' } : {});
    }
    const [status, out, extra] = answer(req, path, url.searchParams, body, raw, via);
    if (f?.mode === '500_after_create') return send(res, 500, { error: { message: 'mock fault 500 after create' } });
    if (f?.mode === 'timeout') {
      // the work is done; the answer comes too late (or never, when the test closes the server first)
      const t = setTimeout(() => send(res, status, out ?? undefined, extra), f.delayMs ?? 60_000);
      res.on('close', () => clearTimeout(t));
      return;
    }
    return send(res, status, out ?? undefined, extra);
  }

  const api = {
    calls,
    get state() {
      return state;
    },
    get url() {
      return base;
    },
    /** Add a fault: { path (prefix or RegExp), method?, mode, times? (default 1; -1 forever), delayMs? }. */
    fail(f) {
      faults.push({ times: 1, ...f, path: typeof f.path === 'string' && f.path.startsWith('^') ? new RegExp(f.path) : f.path });
    },
    reset() {
      calls.length = 0;
      faults.length = 0;
      state = fresh();
    },
    /** Calls matching a method and a path (prefix or RegExp). */
    callsTo(method, path) {
      return calls.filter((c) => c.method === method && (path instanceof RegExp ? path.test(c.path) : c.path === path));
    },
    async start(port = 0) {
      server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => handle(req, res, Buffer.concat(chunks)).catch(() => send(res, 500, { error: 'mock crashed' })));
      });
      server.on('connection', (s) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
      });
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
      return api;
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
  return api;
}

/**
 * A connections implementation for unit tests that behaves like Nango's proxy in front of this mock (what
 * mock-nango does in QA): it fills {target} / {ig_user} from the chosen account, sends the provider headers on
 * (Nango strips its Nango-Proxy- prefix), and records a violation (and refuses the call) for anything the spec
 * forbids on the proxy: an Authorization header from us (a derived token), a token or secret in the query
 * string, or Retries / Retry-On. Pass it to createConnections() (server/connections/index.mjs).
 *
 * statuses: ConnectionStatus[] (what status() answers). targets: { facebook, linkedin, ... } real ids by platform;
 * igUser: the Instagram account of the chosen Page.
 */
export function createProxyConnections({ base, statuses = [], targets = {}, igUser = IG_USER_ID, enabled = true } = {}) {
  const proxyCalls = [];
  const violations = [];
  const fill = (s, platform) =>
    String(s)
      .replaceAll('{target}', encodeURIComponent(targets[platform] ?? ''))
      .replaceAll('{ig_user}', encodeURIComponent(igUser));
  const notUsed = async () => {
    throw new Error('not used in these tests');
  };
  return {
    enabled,
    proxyCalls,
    violations,
    statuses,
    async status() {
      return statuses;
    },
    connectLink: notUsed,
    reconnectLink: notUsed,
    async check(_u, platform) {
      return statuses.find((s) => s.platform === platform) ?? { platform, state: 'not_connected' };
    },
    async disconnect() {},
    targets: notUsed,
    setTarget: notUsed,
    credentials: notUsed,
    async forgetUser() {},
    async unforgetUser() {},
    async request(_userId, platform, { method = 'GET', path, query, body, headers = {}, baseUrlOverride, oneShot, timeoutMs = 30_000 } = {}) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(query ?? {})) q.set(k, fill(v, platform));
      const qs = q.toString();
      const bad = [];
      if (Object.keys(headers).some((h) => /^(nango-proxy-)?authorization$/i.test(h))) bad.push('authorization header on the proxy');
      if (Object.keys(headers).some((h) => /^(retries|retry-on)$/i.test(h))) bad.push('Retries/Retry-On header');
      // a token or secret as a query parameter (Nango logs full URLs). `fields=access_token` (asking Graph for the
      // Page token, spec §1.2) names a field, it doesn't carry one.
      if ([...q.keys()].some((k) => /token|secret|key|signature/i.test(k)) || [...q.values()].some((v) => v.includes(FB_PAGE_TOKEN))) bad.push('token or secret in the query string');
      const p = fill(path, platform);
      proxyCalls.push({ platform, method, path: p, query: Object.fromEntries(q), oneShot: oneShot === true, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [`nango-proxy-${k.toLowerCase()}`, v])), baseUrlOverride: baseUrlOverride ?? null });
      if (bad.length) {
        violations.push(...bad);
        return { status: 400, headers: {}, body: { error: { code: 'mock_nango_violation', message: bad.join(', ') } } };
      }
      const isBytes = Buffer.isBuffer(body) || body instanceof Uint8Array;
      const res = await fetch(`${base}${p}${qs ? `?${qs}` : ''}`, {
        method,
        headers: { ...headers, 'x-mock-via': 'proxy', 'x-mock-platform': platform, ...(body !== undefined && !isBytes ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: isBytes ? body : JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const out = {};
      for (const h of WHITELIST) if (res.headers.get(h) != null) out[h] = res.headers.get(h);
      const text = await res.text();
      let parsed = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* text */
      }
      return { status: res.status, headers: out, body: parsed };
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = createMockSocialProviders();
  await mock.start(Number(process.argv[2] || 0));
  console.log(mock.url);
}
