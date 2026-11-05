// How an Update calls treg and the connected accounts: through treg.call (server/treg.mjs, which tags the customer,
// writes the ledger and maps errors) and connections.request, with at most 4 treg calls in flight per customer and
// 3 connection calls per user, and an Idempotency-Key per call so a timeout repeat (treg's own) is free.

import { sha256 } from '../integrations/common.mjs';
import { TREG_ENDPOINTS } from '../treg-endpoints.mjs';
import { servedByOf } from './normalize/index.mjs';

export const TREG_PER_CUSTOMER = 4;
export const CONNECTIONS_PER_USER = 3;

/** A semaphore per key: run(key, fn) waits until fewer than `max` are running for that key. */
export function createSemaphores(max) {
  const state = new Map(); // key → { running, queue }
  return {
    async run(key, fn) {
      let s = state.get(key);
      if (!s) state.set(key, (s = { running: 0, queue: [] }));
      if (s.running >= max) await new Promise((resolve) => s.queue.push(resolve));
      s.running += 1;
      try {
        return await fn();
      } finally {
        s.running -= 1;
        const next = s.queue.shift();
        if (next) next();
        else if (s.running === 0) state.delete(key);
      }
    },
    inFlight: (key) => state.get(key)?.running ?? 0,
  };
}

// shared by every run in this server: the limits are per customer, whatever business or run the call is for
const tregSlots = createSemaphores(TREG_PER_CUSTOMER);
const connectionSlots = createSemaphores(CONNECTIONS_PER_USER);

/** Errors that end the whole Update for this customer (no more treg calls are made). */
export const STOPPING_KINDS = new Set(['customer_cap', 'customer_blocked', 'team_unavailable', 'config']);

/** TregError kinds a customer may see as they are (as a code); every other kind reads as plain UNAVAILABLE. */
const PUBLIC_KINDS = { customer_cap: 'CUSTOMER_CAP', customer_blocked: 'CUSTOMER_BLOCKED', too_expensive: 'OVER_COST', not_found: 'NOT_FOUND', reconnect: 'NEEDS_RECONNECT' };
/** Codes a source may store as they are. */
const PUBLIC_CODES = new Set(['CUSTOMER_CAP', 'CUSTOMER_BLOCKED', 'OVER_COST', 'NOT_FOUND', 'NEEDS_RECONNECT', 'NOT_CONNECTED', 'RATE_LIMITED', 'INTERRUPTED', 'NO_HANDLES', 'NOTHING_TO_UPDATE', 'UNAVAILABLE']);

/**
 * The code a customer may see for an error (snapshot error_code, a step's detail). Team-level treg problems
 * (insufficient_balance, platform_daily_cap_reached, trial_allowance_reached → team_unavailable), our own config
 * and provider failures all read as UNAVAILABLE: never which of them it was.
 */
export function publicCode(e) {
  if (e == null) return null;
  if (typeof e === 'string') return PUBLIC_CODES.has(e) ? e : 'UNAVAILABLE';
  if (e.kind) return PUBLIC_KINDS[e.kind] ?? 'UNAVAILABLE';
  if (typeof e.code === 'string' && PUBLIC_CODES.has(e.code)) return e.code;
  return 'UNAVAILABLE';
}

/** A stable JSON text (sorted keys) for the idempotency key. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

/**
 * One run's caller. ctx: { userId, projectId, runId, customerTag }. treg: createTreg(...). connections:
 * createConnections(...). Returns { treg(key, params, feature), own(platform, request), costMicro(), stopped() }.
 */
export function createRunner({ treg, connections, ctx }) {
  let cost = 0;
  let stop = null;
  return {
    /**
     * Call one treg endpoint by its TREG_ENDPOINTS key. GET and PUT send `params` as the query, POST as the body.
     * → { data, servedBy, costMicro, fetchedAt }. Throws the TregError (kind) as treg.call does.
     */
    async treg(key, params, feature, { query } = {}) {
      const ep = TREG_ENDPOINTS[key];
      if (!ep) throw new Error(`Unknown treg endpoint ${key}`);
      if (stop) throw stop;
      return tregSlots.run(ctx.customerTag || ctx.userId, async () => {
        if (stop) throw stop;
        // POST tools take the body; Search Console's performance also takes ?siteUrl (`query`)
        const request = ep.method === 'POST' ? { method: 'POST', body: params, ...(query ? { query } : {}) } : { method: ep.method, query: params };
        const opts = {
          ...(ep.maxCostUsd != null ? { maxCostUsd: ep.maxCostUsd } : {}),
          idempotencyKey: `${ctx.runId}:${ep.endpointId}:${sha256(stable({ params, query: query ?? null })).slice(0, 24)}`,
          ...(ep.oneShot ? { oneShot: true } : {}),
        };
        try {
          const res = await treg.call(ep.endpointId, request, { userId: ctx.userId, projectId: ctx.projectId, feature, runId: ctx.runId }, opts);
          const costMicro = Math.max(0, Number(res?.meta?.costMicro ?? res?.meta?.cost_micro ?? 0) || 0);
          cost += costMicro;
          return { data: res?.data, servedBy: servedByOf(res, ep.endpointId), costMicro, fetchedAt: res?.meta?.fetchedAt };
        } catch (e) {
          if (STOPPING_KINDS.has(e?.kind)) stop = e;
          throw e;
        }
      });
    },

    /** A read from the user's own connected account (connections.request), oneShot false (one 429 repeat at most). */
    async own(platform, request) {
      return connectionSlots.run(ctx.userId, () => connections.request(ctx.userId, platform, { oneShot: false, timeoutMs: 30_000, ...request }));
    },

    costMicro: () => cost,
    /** The error that stopped treg calls for this run (a cap, a block, the team's balance), or null. */
    stopped: () => stop,
  };
}

/** For tests: how many treg calls are in flight for a customer. */
export const tregInFlight = (key) => tregSlots.inFlight(key);
