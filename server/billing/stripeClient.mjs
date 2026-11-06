// A minimal Stripe client (no SDK): form-encoded requests with the secret key from env, never anything else.
//
//   const stripe = createStripeClient({ env, fetch });
//   await stripe.get('/v1/subscriptions/sub_…', { 'expand[]': 'items.data.price' })   → the object (throws StripeError)
//   await stripe.post('/v1/subscriptions/sub_…', { items: [...] }, { idempotencyKey })   → { outcome, value?, error? }
//   await stripe.del('/v1/subscriptions/sub_…', { invoice_now: false }, { idempotencyKey })
//
// Rules (docs/integrations-setup.md "Plans and billing"):
// - STRIPE_SECRET_KEY is read from env only; it never goes in a log, a reply or an error. mask() shows its last 4.
// - Every write carries an Idempotency-Key (a write without one throws before anything is sent) and is ONE-SHOT: a
//   timeout, a dropped connection or a 5xx is { outcome: 'unknown' } and is never resent here; the caller reads the
//   object back. A definite 4xx is { outcome: 'failed', error: StripeError }.
// - Reads may be tried once more after a 429, a 5xx or a network error (reads only).
// - STRIPE_API_BASE (tests and the mock) is honoured only with an sk_test_ key, so a live key can't be sent elsewhere.
// - Stripe's own error text stays in the server (StripeError keeps kind and code; its message is ours).

import { mask, oneShot } from '../integrations/common.mjs';

export const STRIPE_API_VERSION = '2025-06-30.basil';
const LIVE_BASE = 'https://api.stripe.com';
const READ_TIMEOUT_MS = 20_000;
const WRITE_TIMEOUT_MS = 30_000;

/** 'live' | 'test' | null for a key (sk_/rk_ live or test). */
export function stripeMode(key) {
  const k = String(key ?? '');
  if (/^(sk|rk)_live_/.test(k)) return 'live';
  if (/^(sk|rk)_test_/.test(k)) return 'test';
  return null;
}

/** A Stripe failure in our terms: kind card|invalid|auth|rate|server|network|config, plus Stripe's code (never its text). */
export class StripeError extends Error {
  constructor(kind, { status = 0, code = null, declineCode = null, type = null } = {}) {
    super(kind === 'card' ? 'The card was declined.' : `Stripe request failed (${kind}).`);
    this.name = 'StripeError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.declineCode = declineCode;
    this.type = type;
  }
}

/** Stripe's bracket form encoding: { items: [{ id, quantity }] } → items[0][id]=…&items[0][quantity]=…. */
export function encodeForm(obj, prefix = '') {
  const pairs = [];
  const walk = (v, k) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${k}[${i}]`));
    else if (typeof v === 'object') for (const [ck, cv] of Object.entries(v)) walk(cv, k ? `${k}[${ck}]` : ck);
    else pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  };
  walk(obj, prefix);
  return pairs.join('&');
}

/** A query string from { key: value | value[] } (arrays repeat the key, e.g. 'lookup_keys[]'). */
function queryString(query = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    for (const one of [].concat(v)) q.append(k, String(one));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

function errorFrom(status, body) {
  const e = body?.error ?? {};
  const kind = e.type === 'card_error' || status === 402 ? 'card' : status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate' : status >= 500 ? 'server' : 'invalid';
  return new StripeError(kind, { status, code: typeof e.code === 'string' ? e.code : null, declineCode: typeof e.decline_code === 'string' ? e.decline_code : null, type: typeof e.type === 'string' ? e.type : null });
}

/**
 * env: STRIPE_SECRET_KEY (and STRIPE_API_BASE for tests with a test key). fetch: for tests. readRetryDelayMs: the wait
 * before a read's one retry.
 */
export function createStripeClient({ env = process.env, fetch = globalThis.fetch, readRetryDelayMs = 500 } = {}) {
  const key = String(env.STRIPE_SECRET_KEY ?? '').trim();
  const mode = stripeMode(key);
  const override = String(env.STRIPE_API_BASE ?? '').trim().replace(/\/+$/, '');
  // a custom base only with a test key: a live key only ever goes to Stripe
  const baseRefused = !!override && !/^sk_test_/.test(key);
  const base = override && !baseRefused ? override : LIVE_BASE;
  const enabled = !!mode && !baseRefused;

  const headers = (extra = {}) => ({ authorization: `Bearer ${key}`, 'stripe-version': STRIPE_API_VERSION, ...extra });
  const check = () => {
    if (!enabled) throw new StripeError('config');
  };

  async function readOnce(path, query) {
    let res;
    try {
      res = await fetch(`${base}${path}${queryString(query)}`, { method: 'GET', headers: headers(), signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    } catch {
      throw new StripeError('network');
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) throw errorFrom(res.status, body);
    if (!body || typeof body !== 'object') throw new StripeError('server', { status: res.status });
    return body;
  }

  async function write(method, path, body, { idempotencyKey, timeoutMs = WRITE_TIMEOUT_MS } = {}) {
    check();
    if (!idempotencyKey || typeof idempotencyKey !== 'string') throw new Error('Every Stripe write needs an Idempotency-Key.');
    const encoded = body && Object.keys(body).length ? encodeForm(body) : '';
    const got = await oneShot(
      async (signal) => {
        const res = await fetch(`${base}${path}${method === 'DELETE' && encoded ? `?${encoded}` : ''}`, {
          method,
          headers: headers({ 'idempotency-key': idempotencyKey, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }),
          ...(method === 'POST' ? { body: encoded } : {}),
          signal,
        });
        let json = null;
        try {
          json = await res.json();
        } catch {
          json = null;
        }
        return { status: res.status, body: json };
      },
      { timeoutMs },
    );
    if (got.outcome === 'ok') {
      if (!got.value?.body || typeof got.value.body !== 'object') return { outcome: 'unknown', reason: 'no_body' };
      return { outcome: 'ok', value: got.value.body };
    }
    if (got.outcome === 'failed') return { outcome: 'failed', status: got.status, error: errorFrom(got.status, got.value?.body) };
    return { outcome: 'unknown', reason: got.reason ?? 'error' };
  }

  return {
    enabled,
    mode,
    /** the key as the owner may see it (last 4), or '' */
    keyMask: key ? mask(key) : '',
    /** true when STRIPE_API_BASE was set with a key that isn't a test key (refused) */
    baseRefused,
    live: mode === 'live',

    /** GET → the object; one retry after a 429/5xx/network error. Throws StripeError. */
    async get(path, query = {}) {
      check();
      try {
        return await readOnce(path, query);
      } catch (e) {
        if (!(e instanceof StripeError) || !['rate', 'server', 'network'].includes(e.kind)) throw e;
        await new Promise((r) => setTimeout(r, readRetryDelayMs));
        return readOnce(path, query);
      }
    },

    /** POST once with an Idempotency-Key → { outcome: 'ok', value } | { outcome: 'failed', status, error } | { outcome: 'unknown' }. */
    post: (path, body, opts) => write('POST', path, body, opts),
    /** DELETE once (params in the query, as Stripe takes them) → the same outcomes. */
    del: (path, body, opts) => write('DELETE', path, body, opts),
  };
}
