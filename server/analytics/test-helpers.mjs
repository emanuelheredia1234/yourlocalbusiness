// Shared pieces for the analytics and SEO tests: a fake treg (createTreg's shape, recording calls and how many run
// at once), fake connections, appState's storage contract, a fake auth, and a way to call a route handler.
// Test values only (no real key anywhere).

import { Readable } from 'node:stream';
import { createConnections, nullConnections } from '../connections/index.mjs';
import { TregError } from '../treg.mjs';

export const ENV = { CUSTOMER_TAG_SECRET: 'test-customer-tag-secret-0123456789', GSC_APP_PROPERTY: 'https://yourlocalbusiness.replit.app/' };

/** treg.call stand-in. answer(endpointId, request, ctx, opts) → data | { data, meta } | throws. */
export function fakeTreg(answer, { delayMs = 0 } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
    async call(endpointId, request, ctx, opts) {
      calls.push({ endpointId, request: structuredClone(request), ctx: { ...ctx }, opts: { ...opts } });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const got = await answer(endpointId, request, ctx, opts);
        if (got && typeof got === 'object' && 'data' in got && 'meta' in got) return { ok: true, status: 200, ...got };
        return { ok: true, status: 200, data: got, meta: { costMicro: 100, servedBy: endpointId.split('.')[0] === 'treg' ? 'crawl4ai' : endpointId.split('.')[0] } };
      } finally {
        inFlight -= 1;
      }
    },
    health: () => ({ setUp: true, billingSetUp: false }),
  };
}

export const tregError = (kind, extra = {}) => new TregError(kind, kind, extra);

/** Connections with these statuses and a request(userId, platform, req) answerer. */
export function fakeConnections({ statuses = {}, request = async () => ({ status: 404, body: null }) } = {}) {
  const calls = [];
  const impl = {
    ...nullConnections,
    enabled: true,
    setUp: true,
    async status() {
      return Object.entries(statuses).map(([platform, s]) => ({ platform, ...s }));
    },
    async request(userId, platform, req) {
      calls.push({ userId, platform, ...structuredClone(req) });
      return request(userId, platform, req);
    },
  };
  const c = createConnections(impl);
  return Object.assign(Object.create(null), c, { calls });
}

/** appState's contract (get → { value, updatedAt }, put with ifVersion compare-and-set). */
export function makeStorage({ latencyMs = 0 } = {}) {
  const documents = new Map();
  let version = 0;
  const pause = () => (latencyMs ? new Promise((r) => setTimeout(r, latencyMs)) : Promise.resolve());
  return {
    enabled: true,
    documents,
    async get(key) {
      await pause();
      const row = documents.get(key);
      return row ? structuredClone(row) : null;
    },
    async put(key, value, options = {}) {
      await pause();
      const current = documents.get(key);
      if (Object.hasOwn(options, 'ifVersion')) {
        if (options.ifVersion === null && current) throw Object.assign(new Error('Conflict'), { code: 'CONFLICT' });
        if (options.ifVersion !== null && current?.updatedAt !== options.ifVersion) throw Object.assign(new Error('Conflict'), { code: 'CONFLICT' });
      }
      const row = { value: structuredClone(value), updatedAt: String(++version) };
      documents.set(key, row);
      return row.updatedAt;
    },
  };
}

/** auth.identify by bearer: tokens map 'Bearer <name>' → user. */
export function fakeAuth(users) {
  return {
    enabled: true,
    async identify(req) {
      const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''));
      return m ? users[m[1]] ?? null : null;
    },
  };
}

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export function readJson(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (raw.length > limit) return reject(Object.assign(new Error('big'), { status: 413 }));
      try {
        resolve(JSON.parse(raw.toString() || '{}'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Call a module's handle(req, res, url) and get { status, body }. */
export async function call(module, method, path, { token, body, host = 'yourlocalbusiness.replit.app' } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = { host, ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const res = {
    statusCode: 0,
    headers: {},
    raw: '',
    headersSent: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(chunk) {
      this.raw = chunk === undefined ? '' : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    },
    destroy() {},
  };
  const url = new URL(path, `https://${host}`);
  const handled = await module.handle(req, res, url);
  let parsed = null;
  try {
    parsed = res.raw ? JSON.parse(res.raw) : null;
  } catch {
    parsed = res.raw;
  }
  return { handled, status: res.statusCode, body: parsed, headers: res.headers, raw: res.raw };
}
