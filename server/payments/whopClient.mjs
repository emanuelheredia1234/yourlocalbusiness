// Whop's REST API (https://docs.whop.com/api-reference) with one user's own account key: the only file that knows
// Whop's addresses and headers. Nothing here stores or logs the key, and no Whop text ever leaves this file: errors
// become our own codes and words (WHOP_KEY_REJECTED, WHOP_PERMISSION, …), keyed on Whop's status and error type.
//
//   const whop = createWhopClient({ environment: 'sandbox', key, fetch });
//   await whop.read('products.list', '/products', { account_id, first: 25 })      → JSON, or throws IntegrationError
//   await whop.write('checkout.create', 'POST', '/checkout_configurations', body, { idempotencyKey })
//        → { outcome: 'ok', value, replayed } | { outcome: 'failed', error } | { outcome: 'unknown', reason }
//
// Reads are never retried. Writes go through oneShot(): tried once; a timeout, a dropped connection, a 5xx or Whop's
// "still running" answer is `unknown` (it may have happened) and nothing sends it again by itself. A 429 is a
// definite "not done" (WHOP_BUSY, with our own retryAfter). Production's base can't be changed from the environment:
// only tests pass `base`.

import { IntegrationError, fail, oneShot } from '../integrations/common.mjs';

/** The API version every request (and the webhooks we make) asks for: payloads say account_id from 2026-08-14 on. */
export const WHOP_API_VERSION_DATE = '2026-08-14';
export const WHOP_ENVIRONMENTS = Object.freeze(['sandbox', 'production']);
export const WHOP_API_BASES = Object.freeze({ sandbox: 'https://sandbox-api.whop.com/api/v1', production: 'https://api.whop.com/api/v1' });
/** The only hosts a Whop checkout link may be on, per environment (server/offers/providers.mjs checks every click). */
export const WHOP_CHECKOUT_HOSTS = Object.freeze({ sandbox: 'sandbox.whop.com', production: 'whop.com' });
export const READ_TIMEOUT_MS = 10_000;
export const WRITE_TIMEOUT_MS = 20_000;

/** The permission each call needs (named in WHOP_PERMISSION answers; from our table, never from Whop's text). */
export const WHOP_PERMISSIONS = Object.freeze({
  'products.list': 'access_pass:basic:read',
  'variants.list': 'plan:basic:read',
  'checkout.create': 'checkout_configuration:create',
  'webhooks.create': 'developer:manage_webhook',
  'webhooks.list': 'developer:manage_webhook',
  'webhooks.read': 'developer:manage_webhook',
  'webhooks.update': 'developer:manage_webhook',
  'webhooks.delete': 'developer:manage_webhook',
  'payments.list': 'payment:basic:read',
});
/** What a connected key needs, in the order the setup guide lists it (the last one is optional). */
export const WHOP_KEY_PERMISSIONS = Object.freeze(['access_pass:basic:read', 'plan:basic:read', 'checkout_configuration:create', 'checkout_configuration:basic:read', 'payment:basic:read', 'member:email:read', 'webhook_receive:payments', 'developer:manage_webhook']);

/** Seconds to wait from Whop's 429 text ("Try again in 12 seconds."): only the digits are read, 1..120 (else 60). */
export function retryAfterFrom(message) {
  const m = /(\d{1,6})/.exec(String(message ?? '').slice(0, 200));
  const n = m ? Number(m[1]) : 60;
  return Math.min(120, Math.max(1, Number.isFinite(n) ? n : 60));
}

/** Whop's error body read defensively: { type } from error.type, else error.code ('' when there's none). */
export function whopErrorType(body) {
  const e = body && typeof body === 'object' ? body.error : null;
  const t = e && typeof e === 'object' ? (typeof e.type === 'string' ? e.type : typeof e.code === 'string' ? e.code : '') : '';
  return /^[a-z_]{1,60}$/.test(t) ? t : '';
}

/**
 * Our error for a Whop failure: status and type → code and words. The IntegrationError carries whopStatus and
 * whopType for the caller (never sent to the browser: they aren't in `extra`).
 */
export function mapWhopError(status, body, op = '') {
  const type = whopErrorType(body);
  let e;
  if (status === 401 || type === 'unauthorized') e = fail(400, 'WHOP_KEY_REJECTED', 'Whop didn’t accept this API key. Check it, or make a new one in Whop’s dashboard.');
  else if (status === 403 || type === 'insufficient_scope') {
    const missing = WHOP_PERMISSIONS[op] ?? null;
    e = fail(400, 'WHOP_PERMISSION', missing ? `This Whop API key needs the ${missing} permission.` : 'This Whop API key is missing a permission this needs.', missing ? { missing } : {});
  } else if (status === 429 || type === 'rate_limit_exceeded') {
    const msg = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error.message : '';
    e = fail(429, 'WHOP_BUSY', 'Whop is busy. Try again in a minute.', { retryAfter: retryAfterFrom(msg) });
  } else if (status === 404) e = fail(404, 'WHOP_NOT_FOUND', 'Whop couldn’t find that.');
  else if (status === 400 || status === 409 || status === 422) e = fail(400, 'WHOP_REFUSED', 'Whop didn’t accept this. Check the plan is still for sale.');
  else e = fail(502, 'WHOP_UNAVAILABLE', 'Whop didn’t answer just now. Try again in a few minutes.');
  e.whopStatus = status;
  e.whopType = type;
  return e;
}

const query = (q = {}) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v == null || v === '') continue;
    for (const one of [].concat(v)) s.append(k, String(one));
  }
  const text = s.toString();
  return text ? `?${text}` : '';
};

/**
 * environment: 'sandbox' | 'production'. key: the user's own account API key (decrypted just for this call).
 * base: tests only (the mock). fetch: the server's.
 */
export function createWhopClient({ environment, key, fetch = globalThis.fetch, base = null, readTimeoutMs = READ_TIMEOUT_MS, writeTimeoutMs = WRITE_TIMEOUT_MS } = {}) {
  if (!WHOP_ENVIRONMENTS.includes(environment)) throw new TypeError('whop: unknown environment');
  const root = String(base ?? WHOP_API_BASES[environment]).replace(/\/+$/, '');
  const headers = (extra = {}) => ({ authorization: `Bearer ${key}`, 'api-version-date': WHOP_API_VERSION_DATE, accept: 'application/json', ...extra });

  async function json(res) {
    const text = await res.text().catch(() => '');
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  return {
    environment,

    /** GET a path; JSON, or throws our IntegrationError (a timeout or network failure: WHOP_UNAVAILABLE). Never retried. */
    async read(op, path, q = {}) {
      let res;
      try {
        res = await fetch(`${root}${path}${query(q)}`, { method: 'GET', headers: headers(), redirect: 'error', signal: AbortSignal.timeout(readTimeoutMs) });
      } catch {
        const e = fail(502, 'WHOP_UNAVAILABLE', 'Whop didn’t answer just now. Try again in a few minutes.');
        e.whopStatus = 0;
        throw e;
      }
      const body = await json(res);
      if (!res.ok) throw mapWhopError(res.status, body, op);
      return body ?? {};
    },

    /** One page of a list: { data, next } (next: the cursor for `after`, or null). */
    async list(op, path, q = {}) {
      const body = await this.read(op, path, q);
      const data = Array.isArray(body?.data) ? body.data : [];
      const info = body?.page_info ?? {};
      const next = info.has_next_page === true && typeof info.end_cursor === 'string' && info.end_cursor.length <= 500 ? info.end_cursor : null;
      return { data, next };
    },

    /**
     * A write, tried once (oneShot). → { outcome: 'ok', value, replayed } | { outcome: 'failed', error, status } |
     * { outcome: 'unknown', reason }. 409 idempotency_request_in_progress is `unknown` (the first may still finish).
     */
    async write(op, method, path, body = undefined, { idempotencyKey = null } = {}) {
      const got = await oneShot(
        async (signal) => {
          const res = await fetch(`${root}${path}`, {
            method,
            headers: headers({ ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }),
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            redirect: 'error',
            signal,
          });
          return { status: res.status, body: await json(res), replayed: res.headers.get('idempotent-replayed') === 'true' };
        },
        { timeoutMs: writeTimeoutMs },
      );
      if (got.outcome === 'ok') return { outcome: 'ok', value: got.value.body ?? {}, replayed: got.value.replayed };
      if (got.outcome === 'unknown') return { outcome: 'unknown', reason: got.reason };
      const status = got.status;
      const b = got.value?.body ?? null;
      if (status === 409 && whopErrorType(b) === 'idempotency_request_in_progress') return { outcome: 'unknown', reason: 'in_progress' };
      const error = got.error instanceof IntegrationError ? got.error : mapWhopError(status, b, op);
      return { outcome: 'failed', status, error };
    },
  };
}
