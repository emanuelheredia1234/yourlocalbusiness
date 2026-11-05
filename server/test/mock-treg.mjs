// A stand-in for treg (https://treg.to) for tests and offline QA. Nothing here reaches the real treg.
//
//   node server/test/mock-treg.mjs [port]        → prints its base URL (use it as TREG_BASE_URL)
//   const mock = await createMockTreg({ token, adminToken, org }).start();   mock.url, mock.calls, mock.close()
//
// /call/:endpointId  needs X-Treg-Token (the member token; the admin token is refused), refuses (422) a request
//   with an Authorization header or a missing or malformed X-Treg-Meta, and answers the example bodies in
//   server/test/fixtures/treg/<endpointId>.json (routed tools in the {output, raw, _treg} envelope) with
//   X-Treg-Call-Id, X-Treg-Cost-Micro, X-Treg-Served-By, X-Treg-Cache, X-Treg-Fetched-At. Idempotency-Key: the same
//   key answers the stored result (X-Treg-Idempotent-Replay: true, cost 0, X-Treg-Original-Cost-Micro); a key
//   reused for a different request is 422. It keeps its own ledger per `customer` tag, enforces the budgets
//   (429 tag_spend_cap_reached, 403 tag_blocked, with X-Treg-Error: 1).
// Admin (the admin token): PUT/DELETE/GET /orgs/:org/budgets…, GET /orgs/:org/usage/by-tag?key=customer&days=,
//   GET /orgs/:org/balance, GET /calls/:id, PATCH /orgs/:org/settings. POST …/public-token is recorded as a
//   violation and refused.
// Faults: mock.fail(endpointIdOr'*', { status, error, times, delayMs, pending, upstreamFailed, body }):
//   402 insufficient_balance (with a fake topup_url tests assert never reaches a client), 429
//   platform_daily_cap_reached, 402 route_max_cost, 202 pending, a slow answer (delayMs) for timeout replays.
//   mock.unattributedMicro adds treg-side spend no tag claimed. mock.priceMicro: what each metered call costs.
// GET /__calls (and mock.calls): every request, with its headers (tokens replaced by their role).

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'treg');

export const MOCK_TREG = Object.freeze({ token: 'test-treg-token-member', adminToken: 'test-treg-token-admin', org: 'org_test' });
export const FAKE_TOPUP_URL = 'https://treg.example/topup/secret-topup-link';

const META_PAIR = /^([a-z_]{1,32})=([A-Za-z0-9._:-]{1,128})$/;

/** X-Treg-Meta as an object, or null if malformed (spec: up to 5 key=value pairs, customer required). */
export function parseMeta(header) {
  if (!header) return null;
  const parts = String(header).split(',').map((p) => p.trim());
  if (!parts.length || parts.length > 5) return null;
  const out = {};
  for (const p of parts) {
    const m = META_PAIR.exec(p);
    if (!m || /@/.test(m[2])) return null;
    out[m[1]] = m[2];
  }
  return /^cust_[0-9a-f]{24}$/.test(out.customer || '') ? out : null;
}

function loadFixture(endpointId) {
  const file = path.join(FIXTURES, `${endpointId}.json`);
  if (!/^[a-z0-9._-]+$/i.test(endpointId) || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export function createMockTreg({ token = MOCK_TREG.token, adminToken = MOCK_TREG.adminToken, org = MOCK_TREG.org, priceMicro = 1000 } = {}) {
  const state = {
    calls: [],
    violations: [],
    ledger: [], // { callId, customer, feature, endpointId, charged, reserved, at, outcome }
    idem: new Map(), // key → { fingerprint, status, headers, body, callId, cost }
    budgets: { default: null, perTag: new Map() },
    settings: {},
    faults: [],
    unattributedMicro: 0,
    priceMicro,
  };
  let server;

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const refuse = (res, status, error, extra = {}) => send(res, status, { error, ...extra }, { 'x-treg-error': '1' });

  function record(req, url, body) {
    const role = (v) => (v === token ? '[member-token]' : v === adminToken ? '[admin-token]' : v ? '[other]' : undefined);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = k === 'x-treg-token' ? role(v) : k === 'authorization' ? '[present]' : v;
    const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body, at: new Date().toISOString() };
    if (req.headers['x-treg-token'] === adminToken && url.pathname.startsWith('/call/')) state.violations.push('admin token on /call/');
    state.calls.push(entry);
    return entry;
  }

  function takeFault(endpointId) {
    const i = state.faults.findIndex((f) => (f.endpoint === endpointId || f.endpoint === '*') && f.times > 0);
    if (i < 0) return null;
    const f = state.faults[i];
    f.times -= 1;
    if (f.times <= 0) state.faults.splice(i, 1);
    return f;
  }

  function capsFor(tag) {
    const d = state.budgets.default ?? {};
    const o = state.budgets.perTag.get(tag) ?? {};
    return { ...d, ...o };
  }

  function spentBy(tag) {
    const d = today();
    const m = d.slice(0, 7);
    let day = 0;
    let month = 0;
    let calls = 0;
    for (const r of state.ledger) {
      if (r.customer !== tag) continue;
      const c = r.charged ?? r.reserved ?? 0;
      if (r.at.slice(0, 7) === m) month += c;
      if (r.at.slice(0, 10) === d) {
        day += c;
        calls += 1;
      }
    }
    return { day, month, calls };
  }

  async function handleCall(req, res, url, raw) {
    const endpointId = decodeURIComponent(url.pathname.slice('/call/'.length));
    const tok = req.headers['x-treg-token'];
    if (req.headers.authorization) return refuse(res, 422, 'authorization_header_not_allowed_in_mock');
    if (tok === adminToken) return refuse(res, 422, 'admin_token_on_call');
    if (tok !== token) return refuse(res, 401, 'unauthorized');
    const meta = parseMeta(req.headers['x-treg-meta']);
    if (!meta) return refuse(res, 422, 'invalid_tags');
    const metered = req.headers['x-treg-route-max-cost'] != null;
    if (metered && !(Number(req.headers['x-treg-route-max-cost']) > 0)) return refuse(res, 422, 'invalid_max_cost');
    const key = req.headers['idempotency-key'];
    const fingerprint = crypto.createHash('sha256').update(`${req.method} ${url.pathname}${url.search} ${raw}`).digest('hex');
    if (key && state.idem.has(key)) {
      const prev = state.idem.get(key);
      if (prev.fingerprint !== fingerprint) return refuse(res, 422, 'idempotency_key_reused');
      if (prev.running) return refuse(res, 409, 'idempotency_in_progress');
      return send(res, prev.status, prev.body, { ...prev.headers, 'x-treg-idempotent-replay': 'true', 'x-treg-cost-micro': '0', 'x-treg-original-cost-micro': String(prev.cost) });
    }

    const fault = takeFault(endpointId);
    const caps = capsFor(meta.customer);
    if (caps.status === 'blocked') return refuse(res, 403, 'tag_blocked', { dim: 'customer', val: meta.customer, message: 'blocked' });
    const spent = spentBy(meta.customer);
    const price = metered ? state.priceMicro : 0;
    if (caps.daily_cap_micro != null && spent.day + price > caps.daily_cap_micro) return refuse(res, 429, 'tag_spend_cap_reached', { dim: 'customer', val: meta.customer, spent_micro: spent.day, cap_micro: caps.daily_cap_micro, period: 'day' });
    if (caps.monthly_cap_micro != null && spent.month + price > caps.monthly_cap_micro) return refuse(res, 429, 'tag_spend_cap_reached', { dim: 'customer', val: meta.customer, spent_micro: spent.month, cap_micro: caps.monthly_cap_micro, period: 'month' });
    if (caps.calls_per_day != null && spent.calls + 1 > caps.calls_per_day) return refuse(res, 429, 'tag_spend_cap_reached', { dim: 'customer', val: meta.customer, period: 'day' });

    if (key) state.idem.set(key, { fingerprint, running: true });
    if (fault?.delayMs) await new Promise((r) => setTimeout(r, fault.delayMs));
    const callId = crypto.randomBytes(16).toString('hex');
    const finish = (status, body, headers, cost) => {
      if (key) {
        if (status >= 400) state.idem.delete(key); // a failed call frees its key
        else state.idem.set(key, { fingerprint, status, body, headers, callId, cost });
      }
      if (!res.writableEnded && !res.destroyed) send(res, status, body, headers);
    };

    if (fault?.status) {
      const err = fault.error;
      const body =
        err === 'insufficient_balance'
          ? { error: err, balance_micro: 1234, estimated_cost_micro: 5000, topup_url: FAKE_TOPUP_URL, message: `Top up at ${FAKE_TOPUP_URL}` }
          : err === 'route_max_cost'
            ? { error: err, max_cost_micro: 1, estimated_cost_micro: 5000 }
            : fault.body ?? { error: err ?? 'mock_error' };
      const headers = { 'x-treg-call-id': callId, ...(fault.tregError === false ? {} : { 'x-treg-error': '1' }), ...(fault.costMicro ? { 'x-treg-cost-micro': String(fault.costMicro) } : {}) };
      return finish(fault.status, body, headers, fault.costMicro ?? 0);
    }
    const fixture = loadFixture(endpointId);
    if (!fixture) return finish(404, { error: 'unknown_endpoint' }, { 'x-treg-error': '1', 'x-treg-call-id': callId }, 0);
    const at = new Date().toISOString();
    if (fault?.pending) {
      const reserved = price || 2000;
      state.ledger.push({ callId, customer: meta.customer, feature: meta.feature, endpointId, charged: null, reserved, at, outcome: 'pending' });
      return finish(202, { output: null, _treg: { outcome: 'pending', reserved_micro: reserved, charged_micro: null, served_by: fixture.served_by } }, { 'x-treg-call-id': callId, 'x-treg-cost-micro': String(reserved) }, reserved);
    }
    state.ledger.push({ callId, customer: meta.customer, feature: meta.feature, endpointId, charged: price, reserved: price, at, outcome: 'ok' });
    const body = fixture.routed ? { ...fixture.body, _treg: { ...fixture.body._treg, charged_micro: price } } : fixture.body;
    const headers = {
      'x-treg-call-id': callId,
      ...(metered ? { 'x-treg-cost-micro': String(price) } : {}),
      'x-treg-served-by': fixture.served_by,
      'x-treg-cache': 'miss',
      'x-treg-fetched-at': at,
      ...(fault?.upstreamFailed ? { 'x-treg-upstream-failed': '1' } : {}),
    };
    return finish(200, body, headers, price);
  }

  function handleAdmin(req, res, url, raw) {
    if (req.headers['x-treg-token'] !== adminToken) return refuse(res, req.headers['x-treg-token'] ? 403 : 401, 'forbidden');
    const p = url.pathname;
    const json = () => {
      try {
        return raw ? JSON.parse(raw) : {};
      } catch {
        return {};
      }
    };
    if (/\/public-token$/.test(p)) {
      state.violations.push('public-token');
      return refuse(res, 403, 'not_allowed_in_mock');
    }
    const orgM = /^\/orgs\/([^/]+)(\/.*)$/.exec(p);
    if (orgM) {
      if (orgM[1] !== org) return refuse(res, 404, 'org_not_found');
      const rest = orgM[2];
      if (rest === '/budgets/customer' && req.method === 'PUT') {
        state.budgets.default = { ...(state.budgets.default ?? {}), ...json() };
        return send(res, 200, { dim: 'customer', default: state.budgets.default });
      }
      const one = /^\/budgets\/customer\/([A-Za-z0-9._:-]+)$/.exec(rest);
      if (one && req.method === 'PUT') {
        state.budgets.perTag.set(one[1], { ...(state.budgets.perTag.get(one[1]) ?? {}), ...json() });
        return send(res, 200, { dim: 'customer', val: one[1], ...state.budgets.perTag.get(one[1]) });
      }
      if (one && req.method === 'DELETE') {
        const had = state.budgets.perTag.delete(one[1]);
        return had ? send(res, 200, { ok: true }) : refuse(res, 404, 'not_found');
      }
      if (rest === '/budgets' && req.method === 'GET') return send(res, 200, { dim: 'customer', default: state.budgets.default, rows: [...state.budgets.perTag].map(([val, b]) => ({ val, ...b })) });
      if (rest === '/usage/by-tag' && req.method === 'GET') {
        const days = Number(url.searchParams.get('days') || 30);
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        const per = new Map();
        for (const r of state.ledger) {
          if (r.at < since) continue;
          const p2 = per.get(r.customer) ?? { value: r.customer, charged_micro: 0, calls: 0 };
          p2.charged_micro += r.charged ?? r.reserved ?? 0;
          p2.calls += 1;
          per.set(r.customer, p2);
        }
        const rows = [...per.values()].map((r) => ({ ...r, charged_usd: r.charged_micro / 1e6 }));
        const attributed = rows.reduce((a, r) => a + r.charged_micro, 0);
        return send(res, 200, { key: url.searchParams.get('key'), days, rows, attributed_micro: attributed, unattributed_micro: state.unattributedMicro, total_micro: attributed + state.unattributedMicro });
      }
      if (rest === '/balance' && req.method === 'GET') return send(res, 200, { balance_micro: 5_000_000, balance_usd: 5 });
      if (rest === '/settings' && req.method === 'PATCH') {
        state.settings = { ...state.settings, ...json() };
        return send(res, 200, state.settings);
      }
      return refuse(res, 404, 'not_found');
    }
    const call = /^\/calls\/([0-9a-f]{32})$/.exec(p);
    if (call && req.method === 'GET') {
      const r = state.ledger.find((x) => x.callId === call[1]);
      if (!r) return refuse(res, 404, 'not_found');
      return send(res, 200, { call_id: r.callId, outcome: r.outcome, endpoint_id: r.endpointId, reserved_micro: r.reserved, charged_micro: r.charged, ledger: { charged_micro: r.charged } });
    }
    return refuse(res, 404, 'not_found');
  }

  const mock = {
    url: null,
    get calls() {
      return state.calls;
    },
    get violations() {
      return state.violations;
    },
    get ledger() {
      return state.ledger;
    },
    get budgets() {
      return state.budgets;
    },
    get settings() {
      return state.settings;
    },
    set unattributedMicro(v) {
      state.unattributedMicro = v;
    },
    set priceMicro(v) {
      state.priceMicro = v;
    },
    /** Inject a fault for one endpoint id (or '*'): { status, error, times = 1, delayMs, pending, upstreamFailed, costMicro, tregError, body }. */
    fail(endpoint, fault) {
      state.faults.push({ times: 1, ...fault, endpoint });
    },
    /** Settle a pending call as charged (the billing job reads it with GET /calls/:id). */
    settle(callId, chargedMicro) {
      const r = state.ledger.find((x) => x.callId === callId);
      if (r) Object.assign(r, { charged: chargedMicro, outcome: 'ok' });
    },
    reset() {
      Object.assign(state, { calls: [], violations: [], ledger: [], idem: new Map(), budgets: { default: null, perTag: new Map() }, settings: {}, faults: [], unattributedMicro: 0 });
    },
    async start(port = 0) {
      server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const url = new URL(req.url, 'http://mock');
          if (url.pathname === '/__calls') return send(res, 200, { calls: state.calls, violations: state.violations });
          record(req, url, raw ? raw.slice(0, 4000) : undefined);
          if (url.pathname.startsWith('/call/')) return void handleCall(req, res, url, raw).catch(() => send(res, 500, { error: 'mock_crash' }));
          return handleAdmin(req, res, url, raw);
        });
      });
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      mock.url = `http://127.0.0.1:${server.address().port}`;
      return mock;
    },
    close() {
      return new Promise((r) => (server ? server.close(() => r()) : r()));
    },
  };
  return mock;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.argv[2] || 9923);
  const mock = await createMockTreg().start(port);
  console.log(mock.url);
  console.log(`TREG_BASE_URL=${mock.url} TREG_ORG_ID=${MOCK_TREG.org} (member and admin test tokens: see MOCK_TREG in this file)`);
}
