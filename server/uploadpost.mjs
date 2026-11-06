// The one module that talks to Upload-Post (https://docs.upload-post.com): customers' social accounts (one
// Upload-Post profile per customer), posting, post status and social stats. Everything else reaches Upload-Post
// through createUploadPostClient(...) here; nothing else in the server holds UPLOAD_POST_API_KEY or builds an
// Upload-Post URL. Ads stay on Zernio (server/zernio.mjs).
//
//   const up = createUploadPostClient({ env, fetch, now, log, onAlert });
//   up.enabled                                        UPLOAD_POST_API_KEY is set
//   await up.call('GET', '/uploadposts/users', { query })            → { status, headers, body }
//   await up.call('POST', '/upload_photos', { form, headers })        multipart (platform[], photos[], …)
//   (throws UploadPostCallError on a network error or a timeout: a write may have arrived)
//   up.verifySignature(rawBody, headers)              the webhook HMAC (UPLOAD_POST_WEBHOOK_SECRET)
//   up.setProfileCount(n)                             raises the request budget (+2/min, +10/10 min per profile)
//   upError(res)                                      a non-2xx answer as { status, code, violations, retryAfter }
//                                                     (Upload-Post's machine-readable fields only; never its text)
//
// Rules this file keeps:
// - The key goes only in `Authorization: Apikey <key>` to UPLOAD_POST_BASE_URL. It is never logged, returned, put in
//   a URL or an error; mask() (server/integrations/common.mjs) shows at most its last 4 characters.
// - A write (anything but GET) is sent once: no retry here, ever, and it carries the caller's Idempotency-Key. A
//   GET may be repeated once after a 429 when the caller asks (retry429), waiting Retry-After (at most 10 s).
// - The request budget follows the Advanced plan: 200/min and 1,000/10 min plus 2/min and 10/10 min per profile.
//   We stay under it: UPLOAD_POST_RPM (default 150) + 2 per profile a minute, and 90% of the 10-minute allowance.
//   A write waits at most 15 s for a slot, then gets a local 429 with nothing sent.
// - The bad-key lockout: ten failed calls with a bad key lock the server's address out for 5 minutes, so after a
//   401 for our key no call goes out for 60 s (a local 401) and the owner is told (onAlert('auth')). A 401 that is
//   one customer's social sign-in running out (reauth_required, e.g. facebook_reauth_required on the pinned-Page
//   read) is that customer's reconnect, never the key: it blocks nothing and alerts no one (isSocialReauth).
// - After an 'auth' or 'rate_lockout' alert, the next answer that is a success tells the owner it's over
//   (onRecover(kinds)).
// - Third-party text in answers is data: callers read only the fields they need and render them as text.

import crypto from 'node:crypto';
import { safeLog } from './integrations/common.mjs';

export const UPLOAD_POST_BASE_URL = 'https://api.upload-post.com/api';
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 120_000;
const MAX_RETRY_AFTER_S = 10;
const READ_SLOT_WAIT_MS = 65_000;
export const WRITE_SLOT_WAIT_MS = 15_000;
export const AUTH_GUARD_MS = 60_000;
/** The webhook timestamp window (seconds either way). */
export const SIGNATURE_WINDOW_S = 300;
const HEADER_WHITELIST = ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'content-type'];
const RESERVED_HEADER = /^(authorization|host|cookie|content-length|content-type)$/i;
/** Error codes we look for in an answer's text when it has no error_code (the text itself is never kept). */
const KNOWN_CODES = ['PROFILE_LIMIT_REACHED', 'PROFILE_BLOCKED', 'PROFILE_NOT_FOUND', 'SCHEDULED_POSTS_LIMIT', 'IDEMPOTENCY_KEY_IN_USE', 'INVALID_DISPLAY_NAME', 'READONLY_CALENDAR', 'MEDIA_REQUIRED', 'MEDIA_LIMITS'];

/** A call that got no answer (network error or timeout): it may or may not have reached Upload-Post. */
export class UploadPostCallError extends Error {
  constructor(kind) {
    super(kind === 'timeout' ? 'Upload-Post didn’t answer in time.' : kind === 'not_set_up' ? 'Upload-Post isn’t set up.' : 'Couldn’t reach Upload-Post.');
    this.name = 'UploadPostCallError';
    this.kind = kind;
  }
}

const isLocal = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

/** The API base: UPLOAD_POST_BASE_URL (tests and the mock), else Upload-Post's. https only, except a local mock. */
export function uploadPostBase(env = process.env) {
  const raw = String(env.UPLOAD_POST_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return UPLOAD_POST_BASE_URL;
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.search || u.hash) return UPLOAD_POST_BASE_URL;
    if (u.protocol === 'https:' || (u.protocol === 'http:' && isLocal(u.hostname))) return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    /* fall through */
  }
  return UPLOAD_POST_BASE_URL;
}

const clipCode = (s) => (typeof s === 'string' && /^[A-Za-z0-9_.-]{2,60}$/.test(s) ? s : '');

/**
 * Upload-Post's error envelope as stable fields only: { status, code, violations[{type, platform, cap}],
 * retryAfter }. `message` / `error` text is never kept: it is read only to spot a known code like
 * PROFILE_LIMIT_REACHED when error_code is missing.
 */
export function upError(res) {
  const b = res?.body && typeof res.body === 'object' ? res.body : {};
  let code = clipCode(b.error_code) || clipCode(b.code) || clipCode(b.error_type);
  if (!code) {
    const textOf = `${typeof b.message === 'string' ? b.message : ''} ${typeof b.error === 'string' ? b.error : ''}`;
    code = KNOWN_CODES.find((k) => textOf.includes(k)) ?? '';
  }
  const violations = (Array.isArray(b.violations) ? b.violations : [])
    .filter((v) => v && typeof v === 'object')
    .slice(0, 10)
    .map((v) => ({ type: clipCode(v.type), platform: clipCode(v.platform), ...(Number.isFinite(Number(v.cap)) ? { cap: Number(v.cap) } : {}) }));
  const retryAfter = Number.parseInt(res?.headers?.['retry-after'] ?? b.retry_after ?? '', 10);
  return { status: Number(res?.status) || 0, code, violations, ...(Number.isFinite(retryAfter) ? { retryAfter } : {}) };
}

/** A refusal that is one customer's social account asking to sign in again, never our key or plan. */
export function isSocialReauth(res) {
  const b = res?.body && typeof res.body === 'object' ? res.body : {};
  return b.reauth_required === true || /reauth|reconnect/i.test(String(b.error_code ?? ''));
}

function sameHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** One multipart field value: booleans as "true"/"false", numbers as text, strings as they are. */
const fieldValue = (v) => (typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));

/** A FormData from { field: value | value[] }; arrays repeat the field (name it `platform[]` etc.). */
export function toForm(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      for (const item of v) if (item !== undefined && item !== null && item !== '') fd.append(k, fieldValue(item));
    } else fd.append(k, fieldValue(v));
  }
  return fd;
}

/**
 * env: UPLOAD_POST_API_KEY, UPLOAD_POST_BASE_URL (tests), UPLOAD_POST_RPM, UPLOAD_POST_WEBHOOK_SECRET (+ _PREVIOUS
 * while rotating). fetch, now, sleep, log: for tests. onAlert(kind): the owner hint ('auth', 'rate_lockout');
 * onRecover(kinds): those are over (a later call succeeded).
 */
export function createUploadPostClient({ env = process.env, fetch = globalThis.fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console, onAlert = () => {}, onRecover = () => {} } = {}) {
  const key = String(env.UPLOAD_POST_API_KEY || '').trim();
  const base = uploadPostBase(env);
  const rpmBase = Math.max(1, Math.min(900, Number.parseInt(env.UPLOAD_POST_RPM, 10) || 150));
  const secrets = [env.UPLOAD_POST_WEBHOOK_SECRET, env.UPLOAD_POST_WEBHOOK_SECRET_PREVIOUS].map((s) => String(s || '').trim()).filter(Boolean);
  let profiles = 0;
  let authBlockedUntil = 0;
  let serverHoldUntil = 0;
  /** alerts raised that a later success ends ('auth', 'rate_lockout') */
  const raised = new Set();
  const alert = (kind) => {
    raised.add(kind);
    onAlert(kind);
  };

  const minuteLimit = () => Math.min(900, rpmBase + 2 * profiles);
  const tenMinuteLimit = () => Math.min(4500, Math.floor(0.9 * (1000 + 10 * profiles)));
  const times = []; // request times in the last 10 minutes, every customer together

  async function acquire(maxWaitMs) {
    const deadline = now() + Math.max(0, maxWaitMs);
    for (let i = 0; i < 200; i += 1) {
      const t = now();
      while (times.length && t - times[0] >= 600_000) times.shift();
      const lastMinute = times.filter((x) => t - x < 60_000);
      const hold = Math.max(0, serverHoldUntil - t);
      if (!hold && lastMinute.length < minuteLimit() && times.length < tenMinuteLimit()) {
        times.push(t);
        return true;
      }
      const waitMinute = lastMinute.length >= minuteLimit() ? 60_000 - (t - lastMinute[0]) + 5 : 0;
      const waitTen = times.length >= tenMinuteLimit() ? 600_000 - (t - times[0]) + 5 : 0;
      const wait = Math.max(hold, waitMinute, waitTen, 5);
      if (t + wait > deadline) break;
      await sleep(wait);
    }
    return false;
  }

  async function once(method, path, { query, body, form, headers = {}, timeoutMs, maxWaitMs }) {
    if (now() < authBlockedUntil) return { status: 401, headers: {}, body: { error_code: 'AUTH_GUARD' }, local: true };
    if (!(await acquire(maxWaitMs))) return { status: 429, headers: { 'retry-after': '60' }, body: { error_code: 'rate_limited' }, local: true };
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') q.append(k, String(v));
    const qs = q.toString();
    const h = { authorization: `Apikey ${key}`, accept: 'application/json' };
    for (const [k, v] of Object.entries(headers)) {
      if (RESERVED_HEADER.test(k) || /[\r\n]/.test(String(v))) continue;
      h[k.toLowerCase()] = String(v);
    }
    let payload;
    if (form !== undefined) payload = toForm(form);
    else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(`${base}${path}${qs ? `?${qs}` : ''}`, { method, headers: h, ...(payload !== undefined ? { body: payload } : {}), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new UploadPostCallError(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'network');
    }
    let parsed = null;
    try {
      const text = await res.text();
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const out = {};
    res.headers.forEach((v, k) => {
      if (HEADER_WHITELIST.includes(k)) out[k] = v;
    });
    if (res.status === 401 && !isSocialReauth({ body: parsed })) {
      // our key (one customer's expired social sign-in also answers 401 on some reads: that blocks nobody)
      authBlockedUntil = now() + AUTH_GUARD_MS;
      alert('auth');
    } else if (res.status === 429) {
      const reset = Number.parseInt(out['x-ratelimit-reset'] ?? '', 10);
      const remaining = Number.parseInt(out['x-ratelimit-remaining'] ?? '', 10);
      // our whole budget is spent (or the address is locked out): hold every call until the window resets
      if (Number.isFinite(reset) && reset * 1000 > now() && (remaining === 0 || !Number.isFinite(remaining))) serverHoldUntil = Math.min(reset * 1000, now() + 600_000);
      if (!Array.isArray(parsed?.violations) && !clipCode(parsed?.error_code)) alert('rate_lockout');
    } else if (res.status >= 200 && res.status < 300 && raised.size) {
      const over = [...raised];
      raised.clear();
      onRecover(over);
    }
    return { status: res.status, headers: out, body: parsed };
  }

  return {
    enabled: key !== '',
    /** webhooks can be checked (a secret is set) */
    webhookReady: secrets.length > 0,
    base,

    /** How many profiles the plan holds now (from GET /uploadposts/users): each adds to the request budget. */
    setProfileCount(n) {
      if (Number.isFinite(n) && n >= 0) profiles = Math.min(1000, Math.trunc(n));
    },

    /**
     * One request. path starts with '/' and sits under the base's /api (e.g. '/uploadposts/users', '/upload').
     * form: multipart fields (uploads); body: JSON (profiles, DELETE with a body). A GET is retried once after a
     * 429 only when retry429 is true (and Retry-After is 10 s or less); nothing else ever repeats.
     */
    async call(method, path, { query, body, form, headers, timeoutMs, retry429 = false } = {}) {
      if (!key) throw new UploadPostCallError('not_set_up');
      const m = String(method || 'GET').toUpperCase();
      const p = String(path || '');
      if (!/^\/[A-Za-z0-9/_.\-@]*$/.test(p) || p.includes('..') || p.includes('//')) throw new Error('uploadpost: bad path');
      const t = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), WRITE_TIMEOUT_MS) : m === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
      const maxWaitMs = m === 'GET' ? READ_SLOT_WAIT_MS : WRITE_SLOT_WAIT_MS;
      let res = await once(m, p, { query, body, form, headers, timeoutMs: t, maxWaitMs });
      if (res.status === 429 && m === 'GET' && retry429 && !res.local) {
        const wait = Number.parseInt(res.headers['retry-after'] ?? '', 10);
        if (Number.isFinite(wait) && wait >= 0 && wait <= MAX_RETRY_AFTER_S) {
          await sleep(wait * 1000);
          res = await once(m, p, { query, body, form, headers, timeoutMs: t, maxWaitMs });
        }
      }
      if (res.status >= 400) safeLog('uploadpost_call_refused', { method: m, path: p.replace(/ylb_[0-9a-f]{24}/g, ':profile'), status: res.status, code: upError(res).code, local: res.local === true }, log);
      return res;
    },

    /**
     * X-Upload-Post-Signature: `sha256=` + hex HMAC-SHA256(secret, `<X-Upload-Post-Timestamp>.<raw body>`), with
     * the current or previous secret, the timestamp within 300 s of now. Unsigned deliveries are refused.
     */
    verifySignature(rawBody, headers = {}) {
      if (!secrets.length) return false;
      const sig = String(headers['x-upload-post-signature'] ?? '').trim();
      const ts = String(headers['x-upload-post-timestamp'] ?? '').trim();
      const m = /^sha256=([0-9a-f]{64})$/i.exec(sig);
      if (!m || !/^\d{9,11}$/.test(ts)) return false;
      if (Math.abs(now() / 1000 - Number(ts)) > SIGNATURE_WINDOW_S) return false;
      const got = m[1].toLowerCase();
      const signed = Buffer.concat([Buffer.from(`${ts}.`), Buffer.from(rawBody)]);
      return secrets.some((s) => sameHex(crypto.createHmac('sha256', s).update(signed).digest('hex'), got));
    },
  };
}
