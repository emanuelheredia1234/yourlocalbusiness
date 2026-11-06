// The one wrapper for every treg call: public social data, competitor ads, Google rank and Maps position, and
// Search Console for app-host pages. Each call is tagged with the customer (X-Treg-Meta), checked against that
// customer's caps first (metered endpoints), and written to the usage ledger, success or failure.
//
//   const treg = createTreg({ env, fetch, now, db, log });
//   treg.call(endpoint, { method, query, body }, ctx, opts) → { ok, status, data, meta } | throws TregError
//     endpoint = a key of server/treg-endpoints.mjs ('ig.profile') or its endpointId; nothing else is called
//     ctx  = { userId, projectId, feature: 'social'|'seo'|'ads'|'gsc'|'email', runId }  (server-resolved only)
//     opts = { maxCostUsd, idempotencyKey, maxAgeS, preferProvider, noCache, timeoutMs = 150000 }
//   A 202 "pending" answer comes back as { ok: false, pending: true, status: 202, data: null, meta }: never
//   retried; the billing job settles it (server/billing/routes.mjs).
//   treg.checkCaps(userId, estimateMicro)   the same pre-check, for an analytics refresh before it starts
//   treg.alert()                            the owner alert ({ kind, at } or null)
//   treg.health() → { setUp, billingSetUp }
//
// Rules:
// - The token goes in X-Treg-Token only, never Authorization (treg relays that header to the provider).
// - createTreg never reads TREG_ADMIN_TOKEN: that's server/billing/tregAdmin.mjs, for server/billing/* only.
// - Metered endpoints need opts.maxCostUsd (X-Treg-Route-Max-Cost); Search Console ones (the team's own
//   connection) never send that header.
// - Every call needs an Idempotency-Key. A client-side timeout on a read is repeated once with the same key;
//   one-shot writes (gsc.submit) are never repeated. The repeat waits replayDelayMs (5 s) first.
// - treg's error bodies are never returned, logged or stored: 402 insufficient_balance carries the balance
//   and a top-up link. Errors are TregError with a kind (the table below) and our own words.

import { TREG_ENDPOINTS, tregEndpoint } from './treg-endpoints.mjs';
import { createLedger } from './billing/ledger.mjs';
import { createCaps } from './billing/caps.mjs';
import { appStateFromEnv } from './appState.mjs';
import { customerTag, fail, isUuid, notSetUp, projectTag, safeLog } from './integrations/common.mjs';

/** TregError.kind: what went wrong, in the terms the routes and the UI use (docs/integrations-setup.md). */
export const TREG_ERROR_KINDS = Object.freeze(['customer_blocked', 'customer_cap', 'team_unavailable', 'not_found', 'too_expensive', 'busy', 'unavailable', 'in_progress', 'uncertain', 'config', 'bad_request', 'upstream', 'timeout']);

export class TregError extends Error {
  /** kind: one of TREG_ERROR_KINDS. extra: { status, period, callId, reason, hint } (never treg's own text or amounts). */
  constructor(kind, message = kind, extra = {}) {
    super(message);
    this.name = 'TregError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

export const TREG_FEATURES = Object.freeze(['social', 'seo', 'ads', 'gsc', 'email']);
const DEFAULT_TIMEOUT_MS = 150_000;
const MAX_IN_FLIGHT_PER_CUSTOMER = 4;
const ENDPOINT_ID = /^[a-z0-9][a-z0-9._-]{0,200}$/i;
const META_VALUE = /^[A-Za-z0-9._:-]{1,128}$/;

const GENERIC_UNAVAILABLE = 'Analytics are temporarily unavailable. Try again later.';
/** treg's error codes are third-party text: only a plain code is kept (for the logs and kind mapping), never prose. */
const ERROR_CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
/** X-Treg-Call-Id is 32 hex (treg-digest §7); anything else is third-party text and isn't stored or looked up. */
const CALL_ID = /^[0-9a-f]{32}$/i;
/** The team-level refusals the owner alert may name; anything else is stored as 'team_unavailable'. */
const ALERT_KINDS = new Set(['insufficient_balance', 'platform_daily_cap_reached', 'trial_allowance_reached']);

/**
 * treg's refusal (X-Treg-Error: 1) as a kind. `code` is the body's `error` string (e.g. 'tag_blocked').
 * Spec §1.4's table, row by row.
 */
export function tregErrorKind(status, code) {
  const c = String(code || '');
  if (status === 403 && c === 'tag_blocked') return 'customer_blocked';
  if (status === 429 && c === 'tag_spend_cap_reached') return 'customer_cap';
  if ((status === 402 && c === 'insufficient_balance') || c === 'platform_daily_cap_reached' || c === 'trial_allowance_reached') return 'team_unavailable';
  if (status === 422 && (c === 'invalid_identity' || /strict|filter/.test(c))) return 'not_found';
  if (status === 402 && c === 'route_max_cost') return 'too_expensive';
  if (status === 429 && (c === 'share_busy' || c === 'provider_rate_limited')) return 'busy';
  if ((status === 503 && c === 'provider_capacity_unavailable') || (status === 502 && c === 'route_failed')) return 'unavailable';
  if (status === 409) return 'in_progress';
  // 410 idempotency_* only: a 422 for a key reused on another request is our own mistake (config), not a charge
  if (status === 410) return 'uncertain';
  if (status === 429) return 'busy';
  if (status >= 500) return 'unavailable';
  return 'config';
}

/** What the user reads for each kind (the owner-only details stay in the alert and the logs, by name). */
const KIND_COPY = {
  customer_blocked: 'Analytics are paused for your account. Contact support.',
  customer_cap: 'You’ve reached today’s analytics limit. It resets at midnight UTC.',
  team_unavailable: GENERIC_UNAVAILABLE,
  not_found: 'That account wasn’t found. Check this handle in Settings.',
  too_expensive: 'Skipped (over cost limit).',
  busy: 'Try again later.',
  unavailable: GENERIC_UNAVAILABLE,
  in_progress: 'Still loading. Press Update later.',
  uncertain: 'Still loading. Press Update later.',
  config: GENERIC_UNAVAILABLE,
  bad_request: 'That couldn’t be read.',
  upstream: 'Try again later.',
  timeout: 'That took too long. Try again later.',
};

/**
 * A TregError as a route error (server/integrations/common.mjs fail): blocked 403 CUSTOMER_BLOCKED, cap 429
 * CUSTOMER_CAP with period, a config problem 503 NOT_SET_UP (with its admin hint), everything else 503
 * UNAVAILABLE with a plain message. Never treg's text.
 */
export function tregErrorToApi(e) {
  if (!(e instanceof TregError)) return fail(503, 'UNAVAILABLE', GENERIC_UNAVAILABLE);
  if (e.kind === 'customer_blocked') return fail(403, 'CUSTOMER_BLOCKED', KIND_COPY.customer_blocked);
  if (e.kind === 'customer_cap') {
    const period = e.period === 'month' ? 'month' : 'day';
    return fail(429, 'CUSTOMER_CAP', period === 'month' ? 'You’ve reached this month’s analytics limit.' : KIND_COPY.customer_cap, { period });
  }
  if (e.kind === 'config') return notSetUp(e.hint || '', GENERIC_UNAVAILABLE);
  return fail(503, 'UNAVAILABLE', KIND_COPY[e.kind] || GENERIC_UNAVAILABLE);
}

/** Integer header value, or null. */
function intHeader(headers, name) {
  const v = headers.get(name);
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** A tiny counting semaphore per key. */
function createGate(max) {
  const state = new Map(); // key → { active, queue: [] }
  return async function run(key, fn) {
    let s = state.get(key);
    if (!s) state.set(key, (s = { active: 0, queue: [] }));
    if (s.active >= max) await new Promise((resolve) => s.queue.push(resolve));
    s.active += 1;
    try {
      return await fn();
    } finally {
      s.active -= 1;
      const next = s.queue.shift();
      if (next) next();
      else if (s.active === 0) state.delete(key);
    }
  };
}

/** The query string of a params object (arrays repeat the key; null and undefined are left out). */
function queryString(query) {
  if (!query) return '';
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v == null) continue;
    for (const one of Array.isArray(v) ? v : [v]) q.append(k, String(one));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function createTreg({ env = process.env, fetch = globalThis.fetch, now = () => Date.now(), db = null, ledger = null, caps = null, storage = null, log = console, maxInFlight = MAX_IN_FLIGHT_PER_CUSTOMER, replayDelayMs = 5_000, tierFor = null } = {}) {
  const base = String(env.TREG_BASE_URL || 'https://treg.to').replace(/\/+$/, '');
  const book = ledger ?? (db ? createLedger({ db, now, log }) : null);
  // tierFor: the customer's plan layer of caps (server/billing/caps.mjs)
  const limits = caps ?? (db && book ? createCaps({ db, ledger: book, now, log, tierFor }) : null);
  let store = storage;
  const appState = () => (store ??= appStateFromEnv(env, fetch));
  const gate = createGate(maxInFlight);

  const config = (message, hint = '') => new TregError('config', message, { hint });

  /** Note an owner alert (no amounts, no treg text): the owner sees it on the billing page and the hub. */
  async function raiseAlert(reason) {
    safeLog('treg_team_unavailable', { reason }, log);
    try {
      const s = appState();
      if (s?.enabled) await s.put('treg:alert', { kind: reason, at: new Date(now()).toISOString() });
    } catch {
      /* the log line above is the fallback */
    }
  }

  /** Who pays and how the call is tagged; throws config when something is missing. */
  function identity(ctx) {
    if (!ctx || !isUuid(ctx.userId)) throw config('A treg call needs the signed-in user.');
    if (!TREG_FEATURES.includes(ctx.feature)) throw config('A treg call needs its feature.');
    let tag;
    let biz = null;
    try {
      tag = customerTag(ctx.userId, env);
      if (ctx.projectId) biz = projectTag(ctx.userId, ctx.projectId, env);
    } catch {
      throw config('Usage tracking isn’t set up.', 'Add CUSTOMER_TAG_SECRET (32+ random bytes) in Replit Secrets.');
    }
    const meta = [`customer=${tag}`, `feature=${ctx.feature}`, ...(biz ? [`business=${biz}`] : [])];
    if (!meta.every((p) => META_VALUE.test(p.split('=')[1]))) throw config('A treg tag isn’t valid.');
    return { tag, meta: meta.join(', ') };
  }

  async function checkCaps(userId, estimateMicro = 0) {
    if (!limits) throw config('Usage tracking needs Supabase.', 'Add SUPABASE_URL and SUPABASE_SECRET_KEY, and run the integrations migration.');
    let tag;
    try {
      tag = customerTag(userId, env);
    } catch {
      throw config('Usage tracking isn’t set up.', 'Add CUSTOMER_TAG_SECRET (32+ random bytes) in Replit Secrets.');
    }
    return limits.check(tag, { estimateMicro });
  }

  /** One HTTP attempt. Returns { res, body, text } or { timedOut: true }. Network errors throw TregError. */
  async function attempt(url, init, timeoutMs) {
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { timedOut: true };
      throw new TregError('unavailable', GENERIC_UNAVAILABLE);
    }
    let text = '';
    try {
      text = await res.text();
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { timedOut: true };
      throw new TregError('unavailable', GENERIC_UNAVAILABLE);
    }
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { res, body };
  }

  async function call(endpoint, { method, query, body } = {}, ctx = {}, opts = {}) {
    const entry = tregEndpoint(endpoint);
    if (!entry || !ENDPOINT_ID.test(entry.endpointId)) throw config('That analytics source isn’t one the app uses.');
    const token = String(env.TREG_TOKEN || '');
    if (!token) throw config('Analytics data isn’t set up.', 'Add the TREG_TOKEN Secret (a member-role agent token) in Replit Secrets.');
    const metered = entry.maxCostUsd != null;
    const asked = Number(opts.maxCostUsd);
    if (metered && !(Number.isFinite(asked) && asked > 0)) throw config('A metered treg call needs a price ceiling.');
    // never above the table's ceiling for that endpoint: a caller can lower it, not raise it
    const maxCostUsd = metered ? Math.min(asked, entry.maxCostUsd) : null;
    const idempotencyKey = String(opts.idempotencyKey || '');
    if (!idempotencyKey || idempotencyKey.length > 255) throw config('A treg call needs an Idempotency-Key.');
    const { tag, meta: metaHeader } = identity(ctx);
    if (!book?.enabled) throw config('Usage tracking needs Supabase.', 'Add SUPABASE_URL and SUPABASE_SECRET_KEY, and run the integrations migration.');

    const verb = String(method || entry.method || 'POST').toUpperCase();
    // the table's method only: a write can't be dressed up as a read (and repeated after a timeout)
    if (verb !== entry.method) throw config('That analytics source is called another way.');
    const url = `${base}/call/${entry.endpointId}${queryString(query)}`;
    const headers = {
      'x-treg-token': token,
      'x-treg-meta': metaHeader,
      'idempotency-key': idempotencyKey,
      accept: 'application/json',
    };
    if (metered) headers['x-treg-route-max-cost'] = String(maxCostUsd);
    if (opts.maxAgeS != null && Number.isFinite(Number(opts.maxAgeS))) headers['x-treg-max-age'] = String(Math.max(0, Math.trunc(Number(opts.maxAgeS))));
    if (opts.noCache) headers['cache-control'] = 'no-cache';
    if (opts.preferProvider && /^[a-z0-9._-]{1,64}$/i.test(opts.preferProvider)) headers['x-treg-route-prefer'] = opts.preferProvider;
    const init = { method: verb, headers };
    if (body !== undefined && verb !== 'GET') {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    // treg's routed tools are reads (GET or POST); anything else is a write and is never repeated
    const oneShot = entry.oneShot === true || opts.oneShot === true || (verb !== 'GET' && verb !== 'POST');
    const timeoutMs = Math.max(1, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
    const row = {
      customer_tag: tag,
      user_id: ctx.userId,
      project_id: ctx.projectId ? String(ctx.projectId).slice(0, 200) : null,
      feature: ctx.feature,
      vendor: 'treg',
      endpoint: entry.endpointId,
      run_id: isUuid(ctx.runId) ? ctx.runId : null,
      idempotency_key: idempotencyKey,
    };

    return gate(tag, async () => {
      // the cap check runs inside the customer's slot, so at most `maxInFlight` calls can pass it on the same
      // spend (spec §3.1: overshoot is about one call each), however many the caller queues at once
      if (metered) await checkCaps(ctx.userId, Math.round(maxCostUsd * 1e6));
      let got = await attempt(url, init, timeoutMs);
      let afterTimeout = false;
      if (got.timedOut) {
        await book.write({ ...row, outcome: 'timeout', cost_micro: 0, http_status: null });
        // a read may be asked once more with the same key: treg answers the stored result for free
        if (oneShot) throw new TregError('timeout', KIND_COPY.timeout, { status: 504 });
        // give treg a moment to finish the first one (a 409 means it's still running: the caller tries later)
        await new Promise((r) => setTimeout(r, replayDelayMs));
        afterTimeout = true;
        got = await attempt(url, init, timeoutMs);
        if (got.timedOut) {
          await book.write({ ...row, outcome: 'timeout', cost_micro: 0, http_status: null });
          throw new TregError('timeout', KIND_COPY.timeout, { status: 504 });
        }
      }
      return settle(got, row, { afterTimeout });
    });
  }

  /** Read the answer, write its ledger row, and return it or throw the mapped error. */
  async function settle({ res, body }, row, { afterTimeout = false } = {}) {
    const h = res.headers;
    const rawCallId = h.get('x-treg-call-id') || '';
    const callId = CALL_ID.test(rawCallId) ? rawCallId.toLowerCase() : null;
    const replay = /^(1|true)$/i.test(h.get('x-treg-idempotent-replay') || '');
    let cost = intHeader(h, 'x-treg-cost-micro') ?? 0;
    if (replay) {
      // treg charges the first answer once; a replay of a call our side timed out on is that charge [R F1]
      const earlier = await book.byIdempotencyKey(row.idempotency_key).catch(() => []);
      const timedOut = earlier.some((r) => r.outcome === 'timeout');
      const charged = earlier.some((r) => r.outcome !== 'timeout' && r.outcome !== 'settled' && (Number(r.cost_micro) || 0) !== 0);
      cost = timedOut && !charged ? intHeader(h, 'x-treg-original-cost-micro') ?? 0 : 0;
    }
    const meta = {
      callId,
      costMicro: cost,
      cache: h.get('x-treg-cache') || null,
      servedBy: h.get('x-treg-served-by') || body?._treg?.served_by || null,
      fetchedAt: h.get('x-treg-fetched-at') || null,
      replay,
      ignoredFilters: h.get('x-treg-ignored-filters') || null,
    };
    const base = { ...row, call_id: callId, cache: meta.cache, served_by: meta.servedBy ? String(meta.servedBy).slice(0, 200) : null, http_status: res.status };
    const tregRefusal = h.get('x-treg-error') === '1';

    if (!tregRefusal && res.status === 202 && body?._treg?.outcome === 'pending') {
      const reserved = Number.isFinite(Number(body._treg.reserved_micro)) ? Math.trunc(Number(body._treg.reserved_micro)) : cost;
      await book.write({ ...base, outcome: 'pending', cost_micro: reserved });
      return { ok: false, pending: true, status: 202, data: null, meta: { ...meta, costMicro: reserved, outcome: 'pending' } };
    }

    if (!tregRefusal && res.ok && !h.get('x-treg-upstream-failed')) {
      await book.write({ ...base, outcome: 'ok', cost_micro: cost });
      return { ok: true, status: res.status, data: body, meta: { ...meta, outcome: 'ok' } };
    }

    let kind;
    let reason = null;
    let period;
    if (tregRefusal) {
      reason = typeof body?.error === 'string' && ERROR_CODE.test(body.error) ? body.error : null;
      kind = tregErrorKind(res.status, reason);
      if (kind === 'customer_cap') period = /month/i.test(String(body?.period ?? '')) ? 'month' : 'day';
    } else if (res.ok || res.status >= 500) {
      kind = 'upstream';
    } else {
      kind = 'bad_request';
    }
    // our repeat after a timeout found the first call still running: treg will charge it, so the row is left
    // for the billing job to settle by call id (GET /calls/<id>), like a 410 (outcome 'error:uncertain')
    const outcome = kind === 'in_progress' && afterTimeout ? 'error:uncertain' : `error:${kind}`;
    await book.write({ ...base, outcome, cost_micro: cost });
    safeLog('treg_call_refused', { endpoint: row.endpoint, status: res.status, kind, reason }, log);
    if (kind === 'team_unavailable') await raiseAlert(ALERT_KINDS.has(reason) ? reason : 'team_unavailable');
    throw new TregError(kind, kind === 'customer_cap' && period === 'month' ? 'You’ve reached this month’s analytics limit.' : KIND_COPY[kind], {
      status: res.status,
      callId,
      reason,
      ...(period ? { period } : {}),
      ...(kind === 'config' ? { hint: 'treg refused the app’s request: check TREG_TOKEN (a member-role agent token) in Replit Secrets.' } : {}),
    });
  }

  return {
    endpoints: TREG_ENDPOINTS,
    call,
    checkCaps,
    /** The owner alert, or null (admins only see it; no amounts are ever stored in it). */
    async alert() {
      try {
        const s = appState();
        if (!s?.enabled) return null;
        const doc = await s.get('treg:alert');
        return doc?.value?.kind ? { kind: String(doc.value.kind), at: String(doc.value.at || '') } : null;
      } catch {
        return null;
      }
    },
    async clearAlert() {
      const s = appState();
      if (s?.enabled) await s.put('treg:alert', {});
    },
    health() {
      return { setUp: Boolean(env.TREG_TOKEN), billingSetUp: Boolean(env.TREG_ADMIN_TOKEN && env.TREG_ORG_ID) };
    },
  };
}
