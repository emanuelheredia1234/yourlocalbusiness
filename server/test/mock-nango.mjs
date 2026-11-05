// A stand-in for Nango's API, for tests and offline QA (nothing here calls Nango or a network):
//
//   node server/test/mock-nango.mjs [port]     → prints its base URL (use it as NANGO_BASE_URL)
//   const mock = await createMockNango({ webhookUrl, signingKey }).start();
//
// What it answers (nango-digest §1):
//   POST   /connect/sessions               bearer must be the test key; records the body; 201 {data:{token, connect_link, expires_at}}
//   POST   /connect/sessions/reconnect     same answer; "Complete" then sends an `override` webhook for that connection
//   GET    /connect?session_token=…        a test page with a "Complete" button (POSTs /connect/complete)
//   POST   /connect/complete               sends the signed `auth` webhook (creation, or override for a reconnect)
//   GET    /connections/:id?provider_config_key=…     200 the connection (never credentials) | 404 unknown_connection
//   DELETE /connections/:id?provider_config_key=…     200 {success:true} and a `deletion` webhook | 404
//   ANY    /proxy/*                        needs Connection-Id and Provider-Config-Key of a live connection; records
//                                          the call; forwards to `upstream` (by Base-Url-Override or provider) or
//                                          answers from its own small canned set (targets, permissions)
//   GET    /__calls                        every call recorded (method, path, query, headers kept, body length)
//   GET    /__violations                   what the spec forbids that something sent (see below)
//   POST   /__fail {path, status, times, delayMs, body}   fault injection (path: exact proxy path or '*')
//   POST   /__config {webhookUrl}          where webhooks go
//
// Violations (a test fails when any is recorded; the proxy also refuses the call): a `Retries` or `Retry-On`
// header on a write, any `Nango-Proxy-Authorization` header (a derived token through the proxy), or a query
// string carrying `access_token=`, `secret` or `token=`.

import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const TEST_NANGO_KEY = 'test-nango-key';
export const TEST_SIGNING_KEY = 'test-nango-signing-key';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BAD_QUERY = /access_token=|secret|token=/i;

/** Canned provider answers for what the connections layer reads itself (targets, granted permissions). */
export const CANNED = {
  facebook: {
    'GET /v26.0/me/accounts': {
      data: [
        { id: '111222333', name: 'Joe’s Bakery', tasks: ['ANALYZE', 'ADVERTISE', 'MODERATE', 'CREATE_CONTENT', 'MANAGE'], instagram_business_account: { id: '17841400000000001' } },
        { id: '444555666', name: 'Joe’s Second Shop', tasks: ['ANALYZE'] },
      ],
    },
    'GET /v26.0/me/permissions': {
      data: [
        'pages_show_list',
        'pages_manage_posts',
        'pages_read_engagement',
        'pages_manage_engagement',
        'read_insights',
        'instagram_basic',
        'instagram_content_publish',
        'instagram_manage_insights',
        'instagram_manage_comments',
        'business_management',
      ].map((permission) => ({ permission, status: 'granted' })),
    },
  },
  linkedin: { 'GET /v2/userinfo': { sub: 'abcDEF123', name: 'Joe Baker' } },
  youtube: { 'GET /youtube/v3/channels': { items: [{ id: 'UCtestchannel000000000001', snippet: { title: 'Joe’s Bakery TV' } }] } },
  'google-ads': { 'GET /v26/customers:listAccessibleCustomers': { resourceNames: ['customers/1234567890'] } },
  'meta-marketing-api': { 'GET /v26.0/me/adaccounts': { data: [{ id: 'act_998877', account_id: '998877', name: 'Joe’s ads', currency: 'USD', account_status: 1 }] } },
  'google-search-console': { 'GET /v3/sites': { siteEntry: [{ siteUrl: 'sc-domain:joesbakery.example', permissionLevel: 'siteOwner' }, { siteUrl: 'https://other.example/', permissionLevel: 'siteUnverifiedUser' }] } },
  'tiktok-personal': { 'GET /v2/user/info/': { data: { user: { open_id: 'tt-open-1', display_name: 'joesbakery' } }, error: { code: 'ok' } } },
  'twitter-v2': { 'GET /2/users/me': { data: { id: '2244994945', username: 'joesbakery', name: 'Joe’s Bakery' } } },
};

/** Which Nango provider an integration id stands for (ours: server/nango.mjs defaults). */
const PROVIDER_OF = {
  'ylb-facebook': 'facebook',
  'ylb-instagram': 'instagram',
  'ylb-linkedin': 'linkedin',
  'ylb-tiktok': 'tiktok-personal',
  'ylb-x': 'twitter-v2',
  'ylb-youtube': 'youtube',
  'ylb-pinterest': 'pinterest',
  'ylb-google-ads': 'google-ads',
  'ylb-meta-ads': 'meta-marketing-api',
  'ylb-microsoft-ads': 'microsoft-ads',
  'ylb-tiktok-ads': 'tiktok-ads',
  'ylb-gsc': 'google-search-console',
};

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const nangoError = (res, status, code, message = code) => json(res, status, { error: { code, message } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The signature Nango puts in X-Nango-Hmac-Sha256: hex HMAC-SHA256 of the exact body with the signing key. */
export const signWebhook = (rawBody, key = TEST_SIGNING_KEY) => crypto.createHmac('sha256', key).update(rawBody).digest('hex');

/**
 * key: the API key it accepts. signingKey: what it signs webhooks with. webhookUrl: where they go (or /__config).
 * upstream: a base URL to forward proxy calls to (e.g. mock-social-providers), else the canned answers.
 */
export function createMockNango({ key = TEST_NANGO_KEY, signingKey = TEST_SIGNING_KEY, webhookUrl = process.env.NANGO_WEBHOOK_URL || '', upstream = '' } = {}) {
  const calls = [];
  const violations = [];
  const sessions = new Map(); // token → { body, reconnect?: {connectionId, integrationId}, used }
  const connections = new Map(); // connectionId → { id, providerConfigKey, tags, created_at }
  const faults = [];
  const webhooks = []; // what it sent: { body, status }
  const routes = new Map(); // `${METHOD} ${path}` → (req) => {status, body, headers}
  let server = null;
  let base = '';
  let n = 0;

  const authorized = (req) => req.headers.authorization === `Bearer ${key}`;

  function takeFault(path) {
    const i = faults.findIndex((f) => (f.path === '*' || f.path === path) && f.times > 0);
    if (i < 0) return null;
    const f = faults[i];
    f.times -= 1;
    if (f.times <= 0) faults.splice(i, 1);
    return f;
  }

  async function sendWebhook(payload) {
    const raw = JSON.stringify(payload);
    const entry = { body: payload, raw, status: 0 };
    webhooks.push(entry);
    if (!webhookUrl) return entry;
    try {
      const r = await fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nango-hmac-sha256': signWebhook(raw, signingKey) }, body: raw });
      entry.status = r.status;
    } catch {
      entry.status = -1;
    }
    return entry;
  }

  const authPayload = (operation, conn, extra = {}) => ({
    from: 'nango',
    type: 'auth',
    operation,
    connectionId: conn.id,
    authMode: 'OAUTH2',
    providerConfigKey: conn.providerConfigKey,
    provider: PROVIDER_OF[conn.providerConfigKey] ?? 'unknown',
    environment: 'DEV',
    success: true,
    tags: conn.tags,
    ...extra,
  });

  /** Complete a connect (or reconnect) session as if the user finished the provider's window. */
  async function complete(token, { success = true, errorType = 'oauth_error' } = {}) {
    const s = sessions.get(token);
    if (!s) return null;
    s.used = true;
    if (s.reconnect) {
      const conn = connections.get(s.reconnect.connectionId);
      if (!conn) return null;
      return sendWebhook(authPayload('override', conn, success ? {} : { success: false, error: { type: errorType, description: 'mock failure' } }));
    }
    const providerConfigKey = s.body.allowed_integrations?.[0];
    const conn = { id: crypto.randomUUID(), providerConfigKey, tags: s.body.tags ?? {}, created_at: new Date().toISOString() };
    if (success) connections.set(conn.id, conn);
    return sendWebhook(authPayload('creation', conn, success ? {} : { success: false, error: { type: errorType, description: 'mock failure' } }));
  }

  async function handleProxy(req, res, url, raw) {
    const path = url.pathname.slice('/proxy'.length) || '/';
    const h = req.headers;
    const kept = Object.fromEntries(Object.entries(h).filter(([k]) => k.startsWith('nango-proxy-') || ['connection-id', 'provider-config-key', 'base-url-override', 'retries', 'retry-on', 'content-type'].includes(k)));
    const call = { method: req.method, path, query: url.search.slice(1), headers: kept, bodyLength: raw.length, body: raw.length && raw.length < 65536 ? raw.toString('utf8') : '' };
    calls.push(call);
    const bad = [];
    if (WRITE_METHODS.has(req.method) && (h.retries !== undefined || h['retry-on'] !== undefined)) bad.push(`Retries/Retry-On on a write (${req.method} ${path})`);
    if (h['nango-proxy-authorization'] !== undefined) bad.push(`Nango-Proxy-Authorization header (${req.method} ${path})`);
    if (BAD_QUERY.test(url.search)) bad.push(`token or secret in the query string (${req.method} ${path})`);
    if (bad.length) {
      violations.push(...bad);
      return nangoError(res, 400, 'mock_nango_violation', bad.join('; '));
    }
    const conn = connections.get(String(h['connection-id'] || ''));
    if (!h['connection-id'] || !h['provider-config-key']) return nangoError(res, 400, 'missing_connection_id');
    if (!conn || conn.providerConfigKey !== h['provider-config-key']) return nangoError(res, 400, 'server_error', 'Connection not found');
    const fault = takeFault(path);
    if (fault) {
      if (fault.delayMs) await sleep(fault.delayMs);
      if (fault.status) return json(res, fault.status, fault.body ?? { error: { message: 'mock fault' } }, fault.headers ?? {});
    }
    const own = routes.get(`${req.method} ${path}`);
    if (own) {
      const out = await own({ ...call, provider: PROVIDER_OF[conn.providerConfigKey], connectionId: conn.id });
      return json(res, out.status ?? 200, out.body ?? {}, out.headers ?? {});
    }
    if (upstream) {
      const target = `${String(upstream).replace(/\/+$/, '')}${path}${url.search}`;
      const fwd = Object.fromEntries(Object.entries(h).filter(([k]) => k.startsWith('nango-proxy-')).map(([k, v]) => [k.slice('nango-proxy-'.length), v]));
      const r = await fetch(target, { method: req.method, headers: { ...fwd, ...(h['content-type'] ? { 'content-type': h['content-type'] } : {}), 'x-mock-via': 'nango', 'x-mock-provider': PROVIDER_OF[conn.providerConfigKey] ?? '' }, ...(raw.length ? { body: raw } : {}) });
      const headers = {};
      r.headers.forEach((v, k) => {
        if (k !== 'content-length' && k !== 'transfer-encoding' && k !== 'connection') headers[k] = v;
      });
      res.writeHead(r.status, headers);
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    const canned = CANNED[PROVIDER_OF[conn.providerConfigKey]]?.[`${req.method} ${path}`];
    if (canned) return json(res, 200, canned, { 'x-ratelimit-remaining': '99' });
    return json(res, 404, { error: { message: `mock-nango: no canned answer for ${req.method} ${path}` } });
  }

  async function handle(req, res, raw) {
    const url = new URL(req.url, 'http://mock');
    const p = url.pathname;
    if (p === '/__calls') return json(res, 200, { calls });
    if (p === '/__violations') return json(res, 200, { violations });
    if (p === '/__webhooks') return json(res, 200, { webhooks: webhooks.map((w) => ({ body: w.body, status: w.status })) });
    if (p === '/__fail' && req.method === 'POST') {
      const f = JSON.parse(raw.toString('utf8') || '{}');
      faults.push({ path: f.path || '*', status: f.status ?? 0, times: f.times ?? 1, delayMs: f.delayMs ?? 0, body: f.body, headers: f.headers });
      return json(res, 200, { ok: true });
    }
    if (p === '/__config' && req.method === 'POST') {
      const c = JSON.parse(raw.toString('utf8') || '{}');
      if (typeof c.webhookUrl === 'string') webhookUrl = c.webhookUrl;
      return json(res, 200, { ok: true });
    }
    if (p === '/connect' && req.method === 'GET') {
      const token = url.searchParams.get('session_token') || '';
      res.writeHead(sessions.has(token) ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(
        `<!doctype html><meta charset="utf-8"><title>Mock Nango connect</title><h1>Mock connect</h1>` +
          `<form method="post" action="/connect/complete"><input type="hidden" name="session_token" value="${escapeHtml(token)}"><button type="submit">Complete</button></form>`,
      );
    }
    if (p === '/connect/complete' && req.method === 'POST') {
      const form = new URLSearchParams(raw.toString('utf8'));
      const sent = await complete(form.get('session_token') || '');
      res.writeHead(sent ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(sent ? '<!doctype html><title>Done</title><p>Connected. You can close this tab.</p>' : '<p>Unknown session</p>');
    }
    if (p.startsWith('/proxy/') || p === '/proxy') {
      if (!authorized(req)) return nangoError(res, 401, 'unauthorized');
      return handleProxy(req, res, url, raw);
    }
    // everything below needs the API key
    calls.push({ method: req.method, path: p, query: url.search.slice(1), headers: {}, bodyLength: raw.length, body: raw.toString('utf8') });
    if (!authorized(req)) return nangoError(res, 401, 'unauthorized');
    const fault = takeFault(p);
    if (fault) {
      if (fault.delayMs) await sleep(fault.delayMs);
      if (fault.status) return json(res, fault.status, fault.body ?? { error: { code: 'server_error', message: 'mock fault' } });
    }
    if ((p === '/connect/sessions' || p === '/connect/sessions/reconnect') && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return nangoError(res, 400, 'invalid_body');
      }
      const reconnect = p.endsWith('/reconnect');
      if (reconnect) {
        const conn = connections.get(String(body.connection_id || ''));
        if (!conn || conn.providerConfigKey !== body.integration_id) return nangoError(res, 400, 'unknown_connection');
      }
      n += 1;
      const token = `nango_connect_session_test_${n}`;
      sessions.set(token, { body, reconnect: reconnect ? { connectionId: body.connection_id, integrationId: body.integration_id } : null, used: false });
      return json(res, 201, { data: { token, connect_link: `${base}/connect?session_token=${token}`, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() } });
    }
    const m = /^\/connections\/([^/]+)$/.exec(p);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const conn = connections.get(id);
      if (!conn || conn.providerConfigKey !== url.searchParams.get('provider_config_key')) return nangoError(res, 404, 'unknown_connection');
      if (req.method === 'GET') {
        if (conn.broken) return json(res, 424, { error: { code: 'invalid_credentials', message: 'refresh exhausted' } });
        return json(res, 200, { id: 1, connection_id: conn.id, provider_config_key: conn.providerConfigKey, provider: PROVIDER_OF[conn.providerConfigKey], errors: [], metadata: null, tags: conn.tags, created_at: conn.created_at });
      }
      if (req.method === 'DELETE') {
        connections.delete(id);
        setTimeout(() => void sendWebhook(authPayload('deletion', conn)), 0);
        return json(res, 200, { success: true });
      }
    }
    return nangoError(res, 404, 'not_found');
  }

  const api = {
    calls,
    violations,
    sessions,
    connections,
    webhooks,
    get base() {
      return base;
    },
    set webhookUrl(v) {
      webhookUrl = v;
    },
    /** Add or replace a proxy answer: on('GET', '/v26.0/me/accounts', (call) => ({status, body, headers})). */
    on(method, path, fn) {
      routes.set(`${method} ${path}`, typeof fn === 'function' ? fn : () => fn);
      return api;
    },
    fail(path, status, { times = 1, delayMs = 0, body, headers } = {}) {
      faults.push({ path, status, times, delayMs, body, headers });
      return api;
    },
    complete,
    /** Send any auth webhook (signed) for a connection, as Nango would. */
    sendAuth(operation, connectionId, extra = {}) {
      const conn = connections.get(connectionId) ?? { id: connectionId, providerConfigKey: extra.providerConfigKey ?? 'ylb-facebook', tags: extra.tags ?? {} };
      return sendWebhook(authPayload(operation, conn, extra));
    },
    /** The last session body sent to /connect/sessions (or …/reconnect). */
    lastSession() {
      return [...sessions.values()].at(-1)?.body ?? null;
    },
    proxyCalls: () => calls.filter((c) => c.path && !c.path.startsWith('/connect') && !c.path.startsWith('/connections') && c.headers['connection-id'] !== undefined),
    reset() {
      calls.length = 0;
      violations.length = 0;
      faults.length = 0;
      webhooks.length = 0;
      routes.clear();
    },
    async start(port = 0) {
      server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          handle(req, res, Buffer.concat(chunks)).catch(() => {
            if (!res.headersSent) nangoError(res, 500, 'server_error', 'mock-nango crashed');
          });
        });
      });
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
      return api;
    },
    close() {
      server?.closeAllConnections?.();
      return new Promise((r) => (server ? server.close(() => r()) : r()));
    },
  };
  return api;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await createMockNango({ upstream: process.env.MOCK_SOCIAL_PROVIDERS_URL || '' }).start(Number(process.argv[2] || 0));
  console.log(mock.base);
}
