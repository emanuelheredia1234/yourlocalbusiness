// What every posting adapter shares: one-shot writes through the connections proxy, reads that never throw,
// and the mapping of a network's answer to a job outcome in our own words.
//
// An adapter is { publish(ctx) → Outcome, check(ctx, job) → Found | null, preflight?(ctx) }:
//   Outcome: { state: 'sent', url?, ref? } | { state: 'failed', errorCode, ref? } | { state: 'unknown', ref? }
//            plus comment: 'added' | 'not_added' | 'not_supported' when a first comment was asked for.
//   Found:   { found: true, url?, ref? } | { found: false }; null = this job can't be checked automatically.
// ctx (built in publish.mjs): userId, platform, status (ConnectionStatus), composed (caption.mjs), media
// ({ id, type, size, kind } | null), privacy, read(req), write(req), direct, mediaStore, publicUrl(), env,
// sleep(ms), now(), timing, note(ref), requestedAt, job.
//
// Paths name the chosen account with placeholders the connections implementation fills from its stored target
// (the ids never leave it): {target} (the Page, LinkedIn member or organization id), {ig_user} (the Instagram
// professional account of the chosen Page).

import { IntegrationError } from '../../integrations/common.mjs';

/** Errors the connections implementation raises itself, before (or instead of) calling the network. */
const NOT_SENT_CODES = new Set(['NEEDS_RECONNECT', 'NOT_CONNECTED', 'NOT_SET_UP', 'CONNECTIONS_NOT_ENABLED', 'CONNECTIONS_UNAVAILABLE', 'FORBIDDEN', 'BAD_REQUEST', 'AUTH_REQUIRED', 'NOT_FOUND']);

export const ok = (res) => !!res && res.status >= 200 && res.status < 300;
export const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/** A definite refusal (a 4xx) as our error code. step: 'post' or 'media' (a refused upload). */
export function refusalCode(status, step = 'post') {
  if (status === 401) return 'NEEDS_RECONNECT';
  if (status === 403) return 'PERMISSION';
  if (status === 429) return 'PLATFORM_LIMIT';
  return step === 'media' ? 'MEDIA_REFUSED' : 'REFUSED';
}

/**
 * One attempt at a write through the connections proxy. → { outcome: 'ok', res } (2xx), { outcome: 'failed',
 * res?, code } (a definite 4xx, or the connections layer refused before sending), { outcome: 'unknown' } (a
 * throw, a timeout, a 5xx: it may have happened). Never retried.
 */
export async function proxyWrite(connections, userId, platform, req, timeoutMs) {
  let res;
  try {
    res = await connections.request(userId, platform, { ...req, oneShot: true, timeoutMs });
  } catch (e) {
    if (e instanceof IntegrationError && NOT_SENT_CODES.has(e.code)) return { outcome: 'failed', code: e.code === 'NEEDS_RECONNECT' ? 'NEEDS_RECONNECT' : 'REFUSED' };
    return { outcome: 'unknown' };
  }
  const status = Number(res?.status);
  if (!Number.isFinite(status) || status >= 500) return { outcome: 'unknown', res };
  if (status >= 400) return { outcome: 'failed', res, code: refusalCode(status) };
  if (status < 200 || status >= 300) return { outcome: 'unknown', res };
  return { outcome: 'ok', res };
}

/** A read through the proxy: the answer, or null when it threw. Reads may repeat once after a 429. */
export async function proxyRead(connections, userId, platform, req, timeoutMs) {
  try {
    return await connections.request(userId, platform, { ...req, oneShot: false, timeoutMs });
  } catch {
    return null;
  }
}

/** A direct call (direct.mjs) as an outcome, like proxyWrite. */
export async function directWrite(fn, step = 'post') {
  let res;
  try {
    res = await fn();
  } catch (e) {
    if (e?.refused) return { outcome: 'failed', code: step === 'media' ? 'MEDIA_UPLOAD_FAILED' : 'REFUSED' };
    return { outcome: 'unknown' };
  }
  const status = Number(res?.status);
  if (!Number.isFinite(status) || status >= 500) return { outcome: 'unknown', res };
  if (status >= 400) return { outcome: 'failed', res, code: refusalCode(status, step) };
  return { outcome: 'ok', res };
}

/**
 * A media step that happens before the post exists: whatever goes wrong, nothing was posted, so it's a
 * definite `failed` (MEDIA_UPLOAD_FAILED unless the network said why).
 */
export function mediaFailure(r) {
  if (r.outcome === 'failed' && ['NEEDS_RECONNECT', 'PERMISSION', 'PLATFORM_LIMIT'].includes(r.code)) return { state: 'failed', errorCode: r.code };
  if (r.outcome === 'failed' && r.code === 'MEDIA_REFUSED') return { state: 'failed', errorCode: 'MEDIA_REFUSED' };
  return { state: 'failed', errorCode: 'MEDIA_UPLOAD_FAILED' };
}

/** Whether a time (ISO or unix seconds) is no earlier than a minute before the job was requested. */
export function recentEnough(at, requestedAt) {
  const t = typeof at === 'number' ? at * 1000 : Date.parse(String(at ?? ''));
  return Number.isFinite(t) && t >= Date.parse(requestedAt) - 60_000;
}
