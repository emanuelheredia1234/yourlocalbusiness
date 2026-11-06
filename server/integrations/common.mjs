// Shared helpers for the integration modules (connections, posting, analytics, billing, SEO on Google).
// See docs/integrations-setup.md and the module headers. Nothing here calls a provider.
//
// Rules every module follows (and these helpers make easy):
// - Keys and tokens come only from env (Replit Secrets). They never go in a response, a log or a test value;
//   mask() shows the last 4 characters at most.
// - One-shot writes (a post, a sitemap submission, an ad change) are tried once: oneShot() turns a throw,
//   a timeout or a 5xx into { outcome: 'unknown' }, and nothing sends them again by itself.
// - Third-party text is data: it's rendered as text and never put into a prompt as instructions.

import crypto from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An error a route answers with: { error, code } and the status. The message is ours, never a provider's body. */
export class IntegrationError extends Error {
  constructor(status, code, message, extra = {}, hint = '') {
    super(message);
    this.name = 'IntegrationError';
    this.status = status;
    this.code = code;
    /** more fields for the reply body (nextAt, period), never upstream text */
    this.extra = extra;
    /** for the owner only: which Replit Secret or setting to add (names, never values) */
    this.hint = hint;
  }
}

/** A route failure: throw fail(429, 'CUSTOMER_CAP', 'You've reached today's analytics limit.', { period: 'day' }). */
export function fail(status, code, message, extra = {}, hint = '') {
  return new IntegrationError(status, code, message ?? code, extra, hint);
}

/** Not set up yet: everyone reads that it isn't available; the owner also reads `hint` (which Secret to add). */
export function notSetUp(hint = '', message = 'This isn’t set up on this app yet.') {
  return fail(503, 'NOT_SET_UP', message, {}, hint);
}

/**
 * The reply for an error: ours as it is (plus its hint for an admin), anything else a plain 500 whose text stays
 * in the server. who: the signed-in user ({ isAdmin }) or null.
 */
export function errorBody(e, who = null) {
  if (e instanceof IntegrationError) return { status: e.status, body: { error: e.message, code: e.code, ...e.extra, ...(who?.isAdmin === true && e.hint ? { hint: e.hint } : {}) } };
  return { status: 500, body: { error: 'Something went wrong. Try again shortly.', code: 'UNAVAILABLE' } };
}

const hmacHex = (secret, data) => crypto.createHmac('sha256', String(secret)).update(String(data)).digest('hex');

/** CUSTOMER_TAG_SECRET, or a clear error naming the Secret (admins see the name; it's never logged with a value). */
function tagSecret(env) {
  const secret = String(env?.CUSTOMER_TAG_SECRET || '');
  if (secret.length < 16) throw notSetUp('Add CUSTOMER_TAG_SECRET (32+ random bytes) in Replit Secrets.');
  return secret;
}

/**
 * A user's billing tag, as treg and the ledger know them: 'cust_' + 24 hex of HMAC-SHA256(CUSTOMER_TAG_SECRET, userId).
 * Opaque and stable (never an email); only [a-z0-9_]. CUSTOMER_TAG_SECRET must never change, or history splits.
 */
export function customerTag(userId, env = process.env) {
  if (!userId) throw fail(400, 'BAD_REQUEST', 'No user.');
  return `cust_${hmacHex(tagSecret(env), userId).slice(0, 24)}`;
}

/** A business's tag for treg's X-Treg-Meta: 'biz_' + 16 hex of HMAC(CUSTOMER_TAG_SECRET, userId + ':' + projectId). */
export function projectTag(userId, projectId, env = process.env) {
  return `biz_${hmacHex(tagSecret(env), `${userId}:${projectId}`).slice(0, 16)}`;
}

/**
 * The user's billing_customers row, made the first time (insert … on conflict do nothing). Returns the tag.
 * db: server/integrations/db.mjs. Only server-resolved user ids come here, never a client value.
 */
export async function ensureCustomer(db, userId, env = process.env) {
  if (!UUID.test(String(userId))) throw fail(400, 'BAD_REQUEST', 'No user.');
  const tag = customerTag(userId, env);
  await db.insert('billing_customers', { customer_tag: tag, user_id: userId }, { ignoreDuplicates: true, onConflict: 'customer_tag' });
  return tag;
}

/** The sales page's published id for a project, exactly as the app makes it (src/lib/seoPage.ts seoPageId). */
export function seoPageIdFor(projectId) {
  return `seo:${String(projectId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}`;
}

/** '…' and the last 4 characters (nothing for a short value): enough to tell keys apart, never enough to use one. */
export function mask(secret) {
  const s = String(secret ?? '');
  return s.length > 8 ? `…${s.slice(-4)}` : '…';
}

const SENSITIVE_KEY = /token|secret|key|authorization|cookie|link/i;

/** What may be logged of a value: sensitive keys dropped at any depth, long strings cut. */
function scrub(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (depth > 3) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!SENSITIVE_KEY.test(k)) out[k] = scrub(v, depth + 1);
    return out;
  }
  return String(value);
}

/**
 * Log an integration event as one JSON line, dropping every field whose name looks like a token, secret, key,
 * authorization, cookie or link (connect links carry a session token). logger: console by default (tests spy).
 */
export function safeLog(event, fields = {}, logger = console) {
  try {
    logger.log(JSON.stringify({ event: String(event), ...scrub(fields) }));
  } catch {
    /* logging never breaks a request */
  }
}

/** Paths whose next segment is a secret (a media token) or whose callers are third parties: never logged as they are. */
const REDACTED_PATHS = [
  [/^\/api\/media\/public\/.*/, '/api/media/public/[token]'],
  [/^\/api\/webhooks\/([a-z0-9-]+).*$/, '/api/webhooks/$1'],
];

/** A request path as it may appear in a log: media tokens and anything after a webhook's name replaced. */
export function redactPath(pathname) {
  const p = String(pathname || '/').split('?')[0];
  for (const [re, to] of REDACTED_PATHS) if (re.test(p)) return p.replace(re, to);
  return p;
}

/** Whether a request to this path is kept out of request logs altogether (media links, webhooks). */
export const unlogged = (pathname) => /^\/api\/(media\/public|webhooks)\//.test(String(pathname || ''));

/**
 * A request's raw body as a Buffer, at most `limit` bytes (413 over it). For webhooks, whose signature covers
 * the exact bytes: never parse them before checking it.
 */
export function readRaw(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        reject(fail(413, 'BAD_REQUEST', 'Request too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (!done) reject(e);
    });
  });
}

/**
 * Run a one-shot write once. Returns { outcome: 'ok', value } on success, { outcome: 'failed', status, error }
 * when the provider refused it with a definite 4xx (nothing was done), and { outcome: 'unknown' } for a throw,
 * a timeout or a 5xx: it may have happened. Never retried: the caller records the outcome and stops.
 *
 * fn(signal) → { status, ... } (a response-like object) or any value. timeoutMs: 120 s by default (writes).
 */
export async function oneShot(fn, { timeoutMs = 120_000 } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, timeoutMs);
  });
  try {
    const got = await Promise.race([Promise.resolve().then(() => fn(controller.signal)).then((value) => ({ value })), timeout]);
    if (got.timedOut) return { outcome: 'unknown', reason: 'timeout' };
    const status = Number(got.value?.status);
    if (Number.isFinite(status) && status >= 500) return { outcome: 'unknown', reason: 'upstream', status };
    if (Number.isFinite(status) && status >= 400) return { outcome: 'failed', status, value: got.value };
    return { outcome: 'ok', value: got.value };
  } catch (e) {
    if (e instanceof IntegrationError && e.status < 500) return { outcome: 'failed', status: e.status, error: e };
    return { outcome: 'unknown', reason: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/** Today in UTC (YYYY-MM-DD), the day every cap and counter uses. */
export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
/** sha256 hex of a string or Buffer. */
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
/** Whether a value is a UUID (user ids, job ids, run ids). */
export const isUuid = (v) => UUID.test(String(v ?? ''));

/** Each integration bucket's limits: every window must have room (contracts.mjs RATE_BUCKETS). */
export const BUCKET_LIMITS = Object.freeze({
  'integrations-connect': [{ limit: 10, windowMs: 3_600_000 }],
  'integrations-release': [{ limit: 60, windowMs: 3_600_000 }],
  'posting-publish': [{ limit: 30, windowMs: 3_600_000 }],
  'analytics-refresh': [{ limit: 10, windowMs: 3_600_000 }],
  'media-public': [{ limit: 120, windowMs: 60_000 }],
  'billing-read': [{ limit: 60, windowMs: 60_000 }],
  'nango-webhook': [{ limit: 600, windowMs: 60_000 }],
  'zernio-webhook': [{ limit: 600, windowMs: 60_000 }],
  'upload-post-webhook': [{ limit: 600, windowMs: 60_000 }],
  'posting-check': [{ limit: 60, windowMs: 3_600_000 }],
  'ads-read': [{ limit: 60, windowMs: 60_000 }],
  'ads-preview': [{ limit: 30, windowMs: 3_600_000 }],
  'ads-write': [{ limit: 20, windowMs: 3_600_000 }],
  'ads-stop': [{ limit: 120, windowMs: 3_600_000 }],
  'ads-check': [{ limit: 60, windowMs: 3_600_000 }],
  // keyed `${userId}:${projectId}`: one refresh per business every 5 minutes
  'ads-refresh': [{ limit: 1, windowMs: 300_000 }],
});

/**
 * Per-bucket limits with their own windows (the server's rateLimited is per minute only):
 * limit(bucket, who) → true when this request is over one of the bucket's limits (it isn't counted then).
 * who: a user id, or an address for the unauthenticated routes. Bounded like rateLimit.mjs.
 */
export function createBucketLimiter({ limits = BUCKET_LIMITS, now = () => Date.now(), maxKeys = 50_000 } = {}) {
  const hits = new Map(); // `${bucket}:${who}` → times
  return function limit(bucket, who) {
    const windows = limits[bucket];
    if (!windows) throw new Error(`Unknown rate-limit bucket: ${bucket}`);
    const key = `${bucket}:${who}`;
    const at = now();
    const longest = Math.max(...windows.map((w) => w.windowMs));
    const recent = (hits.get(key) || []).filter((t) => at - t < longest);
    const over = windows.some((w) => recent.filter((t) => at - t < w.windowMs).length >= w.limit);
    if (!over) recent.push(at);
    hits.delete(key);
    hits.set(key, recent);
    while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
    return over;
  };
}

/**
 * Placeholder routes for a module that isn't built yet: every request under `prefixes` answers
 * 503 { code: 'NOT_SET_UP' }; anything else is left alone (false). Nothing is read from the request.
 */
export function stubRoutes({ prefixes, send, corsHeaders = () => ({}), message = 'This isn’t available on this app yet.' }) {
  const list = [].concat(prefixes);
  const matches = (pathname) => list.some((p) => (p.endsWith('/') ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`)));
  return {
    stub: true,
    matches,
    async handle(req, res, url) {
      if (!matches(url.pathname)) return false;
      send(res, 503, { error: message, code: 'NOT_SET_UP' }, corsHeaders(req));
      return true;
    },
    async forgetUser() {},
    async unforgetUser() {},
    async userDeleted() {},
    async onStart() {},
  };
}
