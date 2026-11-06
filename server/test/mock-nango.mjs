// A stand-in for Nango's API (kept for future non-social integrations), for tests and offline QA. Nothing here
// calls Nango or a network.
//
//   node server/test/mock-nango.mjs [port]     → prints its base URL (use it as NANGO_BASE_URL)
//   const mock = await createMockNango().start();
//
// What it answers:
//   POST   /connect/sessions               bearer must be the test key; records the body; 201 {data:{token, connect_link, expires_at}}
//   DELETE /connections/:id?provider_config_key=…     200 {success:true} | 404 unknown_connection
//   ANY    /proxy/*                        needs Connection-Id and Provider-Config-Key; records the call; 200 {ok:true}
//   GET    /__calls                        every call recorded (method, path, query, body length)
// A `Retries` / `Retry-On` header on a write is recorded as a violation and refused.

import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export { conflict, makeDb, makeLog, makeStorage } from './fakes.mjs';

export const TEST_NANGO_KEY = 'test-nango-key';
export const TEST_SIGNING_KEY = 'test-nango-signing-key';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** X-Nango-Hmac-Sha256 for a body. */
export const signWebhook = (rawBody, key = TEST_SIGNING_KEY) => crypto.createHmac('sha256', key).update(rawBody).digest('hex');

export function createMockNango({ key = TEST_NANGO_KEY } = {}) {
  const calls = [];
  const violations = [];
  const connections = new Map(); // id → { providerConfigKey }
  let server = null;
  let base = '';
  let n = 0;

  async function handler(req, res) {
    const url = new URL(req.url, 'http://mock');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const body = raw.length ? (() => { try { return JSON.parse(raw.toString()); } catch { return null; } })() : null;
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { 'connection-id': req.headers['connection-id'], 'provider-config-key': req.headers['provider-config-key'] }, body, bytes: raw.length });
    if (url.pathname === '/__calls') return json(res, 200, { calls });
    if (req.headers.authorization !== `Bearer ${key}`) return json(res, 401, { error: { code: 'invalid_credentials' } });
    if (req.method !== 'GET' && (req.headers.retries || req.headers['retry-on'])) {
      violations.push({ kind: 'retries_header', path: url.pathname });
      return json(res, 400, { error: { code: 'invalid_request' } });
    }
    if (req.method === 'POST' && url.pathname === '/connect/sessions') {
      n += 1;
      return json(res, 201, { data: { token: `nango_connect_session_${n}`, connect_link: `${base}/connect?session_token=nango_connect_session_${n}`, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() } });
    }
    let m = /^\/connections\/([^/]+)$/.exec(url.pathname);
    if (m && req.method === 'DELETE') {
      const id = decodeURIComponent(m[1]);
      if (!connections.has(id)) return json(res, 404, { error: { code: 'unknown_connection' } });
      connections.delete(id);
      return json(res, 200, { success: true });
    }
    m = /^\/proxy(\/.*)$/.exec(url.pathname);
    if (m) {
      const id = req.headers['connection-id'];
      if (!id || !connections.has(id) || !req.headers['provider-config-key']) return json(res, 400, { error: { code: 'unknown_connection' } });
      return json(res, 200, { ok: true, path: m[1] });
    }
    return json(res, 404, { error: { code: 'not_found' } });
  }

  return {
    calls,
    violations,
    connections,
    get base() {
      return base;
    },
    /** A connection Nango holds (as a finished connect would make). */
    addConnection(id, providerConfigKey) {
      connections.set(id, { providerConfigKey });
    },
    async start(port = 0) {
      server = http.createServer((req, res) => void handler(req, res).catch(() => json(res, 500, { error: { code: 'server_error' } })));
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
      return this;
    },
    async close() {
      await new Promise((r) => (server ? server.close(() => r()) : r()));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await createMockNango().start(Number(process.argv[2] || 0));
  console.log(mock.base);
}
