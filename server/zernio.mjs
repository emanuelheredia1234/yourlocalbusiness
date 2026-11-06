// The one module that talks to Zernio (https://docs.zernio.com): customers' social accounts, posting, social
// analytics and ad results. Everything else reaches Zernio through createZernioClient(...) here; nothing else in the
// server holds ZERNIO_API_KEY or builds a Zernio URL.
//
//   const zernio = createZernioClient({ env, fetch, now, log });
//   zernio.enabled                                   ZERNIO_API_KEY is set
//   await zernio.call('GET', '/accounts', { query })  → { status, headers, body }   (throws ZernioCallError on
//                                                       a network error or a timeout: the request may have arrived)
//   await zernio.upload(uploadUrl, bytes, type)      PUT to a presigned media URL (no API key on it)
//   zernio.verifySignature(rawBody, header)          the webhook HMAC (ZERNIO_WEBHOOK_SECRET)
//   zernioError(res)                                 a non-2xx answer as { code, type, retryAfter } (Zernio's
//                                                     machine-readable fields only; never its text)
//
// Rules this file keeps:
// - The key goes only in the Authorization header to ZERNIO_BASE_URL. It is never logged, returned, put in a
//   URL or an error; mask() (server/integrations/common.mjs) shows at most its last 4 characters.
// - A write is sent once (oneShot: true, the default for anything but GET): no retry here, ever. A GET may be
//   repeated once after a 429, waiting Retry-After (at most 10 s), and only when the caller asks (retry429).
// - Requests per minute stay under ZERNIO_RPM (default 60, Zernio's floor; raise it to 600 once the team has 3+
//   connected accounts, see docs/integrations-setup.md).
// - Third-party text in answers is data: callers read only the fields they need and render them as text.

import crypto from 'node:crypto';
import { safeLog } from './integrations/common.mjs';

export const ZERNIO_BASE_URL = 'https://zernio.com/api/v1';
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const MAX_RETRY_AFTER_S = 10;
/** response headers a caller may see (nothing else of Zernio's headers is passed on) */
const HEADER_WHITELIST = ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'content-type'];
const RESERVED_HEADER = /^(authorization|host|cookie|content-length)$/i;

/** A call that got no answer (network error or timeout): it may or may not have reached Zernio. */
export class ZernioCallError extends Error {
  constructor(kind) {
    super(kind === 'timeout' ? 'Zernio didn’t answer in time.' : 'Couldn’t reach Zernio.');
    this.name = 'ZernioCallError';
    this.kind = kind;
  }
}

const isLocal = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

/** The API base: ZERNIO_BASE_URL (tests and the mock), else Zernio's. https only, except a local mock. */
export function zernioBase(env = process.env) {
  const raw = String(env.ZERNIO_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return ZERNIO_BASE_URL;
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.search || u.hash) return ZERNIO_BASE_URL;
    if (u.protocol === 'https:' || (u.protocol === 'http:' && isLocal(u.hostname))) return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    /* fall through */
  }
  return ZERNIO_BASE_URL;
}

/** Zernio's error envelope, as the stable fields only (code, type, param, retryAfter). Never `error` text. */
export function zernioError(res) {
  const b = res?.body && typeof res.body === 'object' ? res.body : {};
  const code = typeof b.code === 'string' ? b.code.slice(0, 60) : '';
  const type = typeof b.type === 'string' ? b.type.slice(0, 40) : '';
  const retryAfter = Number.parseInt(res?.headers?.['retry-after'] ?? '', 10);
  return { status: Number(res?.status) || 0, code, type, ...(Number.isFinite(retryAfter) ? { retryAfter } : {}) };
}

function sameHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * env: ZERNIO_API_KEY, ZERNIO_BASE_URL (tests), ZERNIO_RPM, ZERNIO_WEBHOOK_SECRET (+ _PREVIOUS while rotating).
 * fetch, now, sleep, log: for tests.
 */
export function createZernioClient({ env = process.env, fetch = globalThis.fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console } = {}) {
  const key = String(env.ZERNIO_API_KEY || '').trim();
  const base = zernioBase(env);
  const baseHost = new URL(base).hostname;
  const testBase = base !== ZERNIO_BASE_URL;
  const rpm = Math.max(1, Math.min(10_000, Number.parseInt(env.ZERNIO_RPM, 10) || 60));
  const secrets = [env.ZERNIO_WEBHOOK_SECRET, env.ZERNIO_WEBHOOK_SECRET_PREVIOUS].map((s) => String(s || '').trim()).filter(Boolean);

  const window_ = []; // request times in the last minute, every customer together
  async function acquire() {
    for (let i = 0; i < 100; i += 1) {
      const t = now();
      while (window_.length && t - window_[0] >= 60_000) window_.shift();
      if (window_.length < rpm) {
        window_.push(t);
        return true;
      }
      const wait = 60_000 - (t - window_[0]) + 5;
      if (wait > 60_000) break;
      await sleep(wait);
    }
    return false;
  }

  async function once(method, path, { query, body, headers = {}, timeoutMs }) {
    if (!(await acquire())) return { status: 429, headers: { 'retry-after': '60' }, body: { code: 'rate_limited', type: 'rate_limit_error' }, local: true };
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') q.append(k, String(v));
    const qs = q.toString();
    const h = { authorization: `Bearer ${key}`, accept: 'application/json' };
    for (const [k, v] of Object.entries(headers)) {
      if (RESERVED_HEADER.test(k) || /[\r\n]/.test(String(v))) continue;
      h[k.toLowerCase()] = String(v);
    }
    if (body !== undefined) h['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(`${base}${path}${qs ? `?${qs}` : ''}`, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new ZernioCallError(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'network');
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
    return { status: res.status, headers: out, body: parsed };
  }

  return {
    enabled: key !== '',
    /** webhooks can be checked (a secret is set) */
    webhookReady: secrets.length > 0,
    base,

    /**
     * One request to the Zernio API. path starts with '/' and is under /v1 (e.g. '/accounts'). A GET is retried
     * once after a 429 only when retry429 is true (and Retry-After is 10 s or less); nothing else ever repeats.
     */
    async call(method, path, { query, body, headers, timeoutMs, retry429 = false } = {}) {
      if (!key) throw new ZernioCallError('not_set_up');
      const m = String(method || 'GET').toUpperCase();
      const p = String(path || '');
      if (!/^\/[A-Za-z0-9/_.\-{}:]*$/.test(p) || p.includes('..') || p.includes('//')) throw new Error('zernio: bad path');
      const t = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), WRITE_TIMEOUT_MS) : m === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
      let res = await once(m, p, { query, body, headers, timeoutMs: t });
      if (res.status === 429 && m === 'GET' && retry429 && !res.local) {
        const wait = Number.parseInt(res.headers['retry-after'] ?? '', 10);
        if (Number.isFinite(wait) && wait >= 0 && wait <= MAX_RETRY_AFTER_S) {
          await sleep(wait * 1000);
          res = await once(m, p, { query, body, headers, timeoutMs: t });
        }
      }
      if (res.status >= 400) safeLog('zernio_call_refused', { method: m, path: p.replace(/[0-9a-f]{24}/g, ':id'), status: res.status, code: zernioError(res).code }, log);
      return res;
    },

    /**
     * PUT the file to the presigned URL Zernio gave (POST /media/presign). The URL must be https (or the local
     * mock's host); no API key is sent to it. → { status }. Throws ZernioCallError on no answer.
     */
    async upload(uploadUrl, bytes, contentType) {
      let u;
      try {
        u = new URL(String(uploadUrl));
      } catch {
        return { status: 0 };
      }
      const okProtocol = u.protocol === 'https:' || (testBase && u.protocol === 'http:' && (isLocal(u.hostname) || u.hostname === baseHost));
      if (!okProtocol || u.username || u.password) return { status: 0 };
      if (!(await acquire())) return { status: 429 };
      try {
        const res = await fetch(u.toString(), { method: 'PUT', headers: { 'content-type': String(contentType || 'application/octet-stream') }, body: bytes, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
        await res.arrayBuffer().catch(() => null);
        return { status: res.status };
      } catch (e) {
        throw new ZernioCallError(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'network');
      }
    },

    /** X-Zernio-Signature: lowercase hex HMAC-SHA256 of the exact body bytes, with the current or previous secret. */
    verifySignature(rawBody, signature) {
      if (!secrets.length || typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature.trim())) return false;
      const got = signature.trim().toLowerCase();
      return secrets.some((s) => sameHex(crypto.createHmac('sha256', s).update(rawBody).digest('hex'), got));
    },
  };
}
