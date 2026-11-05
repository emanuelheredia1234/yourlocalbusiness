// A post's photo or video, as the posting code and the public media route reach it (spec §1.7 "Media").
//
// Files live in the private Supabase Storage bucket `media` at <userId>/<mediaId> (src/lib/cloud/media.ts). The
// server reads them with the service key: a HEAD to check one exists (and its type and size), a GET for the
// bytes it uploads itself (X, LinkedIn, YouTube, TikTok FILE_UPLOAD).
//
// Networks that fetch the file themselves (Instagram, Facebook photos, TikTok PULL_FROM_URL) get a short-lived
// link: <base>/api/media/public/<token>, token = base64url(JSON{u,m,e,k}) + '.' + base64url(HMAC-SHA256(
// MEDIA_URL_SECRET, payload)). 30 minutes for a photo, 2 hours for a video. The link only ever goes in a POST
// body (never a query string, so it isn't in anyone's URL logs) and is never logged.

import crypto from 'node:crypto';
import { serviceHeaders } from '../secretBox.mjs';
import { fail, notSetUp } from '../integrations/common.mjs';

export const MEDIA_BUCKET = 'media';
export const IMAGE_TTL_MS = 30 * 60_000;
export const VIDEO_TTL_MS = 2 * 60 * 60_000;
export const PUBLIC_MEDIA_PATH = '/api/media/public/';
const DEFAULT_PUBLIC_BASE = 'https://yourlocalbusiness.replit.app';
/** A media id as the app makes them (and the Instagram JPEG copy, `<id>.jpg`). */
export const MEDIA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const mac = (secret, payload) => b64url(crypto.createHmac('sha256', secret).update(payload).digest());

function mediaSecret(env) {
  const s = String(env?.MEDIA_URL_SECRET || '');
  if (s.length < 16) throw notSetUp('Add MEDIA_URL_SECRET (32+ random bytes) in Replit Secrets.', 'Posting photos and videos from the app isn’t set up yet. Post it yourself for now.');
  return s;
}

/** Whether links for networks that fetch the file can be made (MEDIA_URL_SECRET is set). */
export const canMakePublicLinks = (env) => String(env?.MEDIA_URL_SECRET || '').length >= 16;

/** The address networks fetch media from: MEDIA_PUBLIC_BASE_URL, else ALLOWED_ORIGIN, else the app on Replit. */
export function publicBase(env = process.env) {
  const raw = String(env.MEDIA_PUBLIC_BASE_URL || env.ALLOWED_ORIGIN || DEFAULT_PUBLIC_BASE).trim();
  return raw.replace(/\/+$/, '');
}

/** A signed token for one of a user's files. kind: 'image' | 'video' (sets how long it lasts). */
export function mediaToken(env, { userId, mediaId, kind }, now = Date.now()) {
  if (!UUID_RE.test(String(userId)) || !MEDIA_ID_RE.test(String(mediaId))) throw fail(400, 'BAD_REQUEST', 'That file can’t be shared.');
  const k = kind === 'video' ? 'video' : 'image';
  const payload = b64url(JSON.stringify({ u: userId, m: mediaId, e: now + (k === 'video' ? VIDEO_TTL_MS : IMAGE_TTL_MS), k }));
  return `${payload}.${mac(mediaSecret(env), payload)}`;
}

/** The public link networks fetch (it goes in a POST body only). */
export function publicMediaUrl(env, ref, now = Date.now()) {
  return `${publicBase(env)}${PUBLIC_MEDIA_PATH}${mediaToken(env, ref, now)}`;
}

/**
 * A token's contents when its MAC is right and it hasn't expired: { ok: true, userId, mediaId, kind }, or
 * { ok: false, why: 'bad' | 'expired' }. The MAC is checked first, in constant time.
 */
export function verifyMediaToken(env, token, now = Date.now()) {
  const secret = mediaSecret(env);
  const m = /^([A-Za-z0-9_-]{10,600})\.([A-Za-z0-9_-]{43})$/.exec(String(token ?? ''));
  if (!m) return { ok: false, why: 'bad' };
  const want = Buffer.from(mac(secret, m[1]));
  const got = Buffer.from(m[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, why: 'bad' };
  let p;
  try {
    p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, why: 'bad' };
  }
  if (!p || !UUID_RE.test(String(p.u)) || !MEDIA_ID_RE.test(String(p.m)) || !Number.isFinite(p.e) || !['image', 'video'].includes(p.k)) return { ok: false, why: 'bad' };
  if (p.e <= now) return { ok: false, why: 'expired' };
  return { ok: true, userId: p.u, mediaId: p.m, kind: p.k, expiresAt: p.e };
}

/**
 * The user's files in Supabase Storage, with the service key. Only server-resolved user ids come here.
 *   head(userId, mediaId) → { type, size } | null
 *   get(userId, mediaId, { range, signal }) → fetch Response (the caller checks .status)
 *   bytes(userId, mediaId) → { bytes: Buffer, type } | null
 */
export function createMediaStore({ env = process.env, fetch = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '');
  const enabled = !!(base && key);
  const objectUrl = (userId, mediaId) => {
    if (!UUID_RE.test(String(userId)) || !MEDIA_ID_RE.test(String(mediaId))) throw fail(404, 'NOT_FOUND', 'That file isn’t in your account.');
    return `${base}/storage/v1/object/${MEDIA_BUCKET}/${userId}/${encodeURIComponent(mediaId)}`;
  };
  const check = () => {
    if (!enabled) throw notSetUp('Supabase isn’t set up on this server (SUPABASE_URL and SUPABASE_SECRET_KEY).');
  };
  const headers = () => {
    const h = { ...serviceHeaders(key) };
    delete h['content-type'];
    return h;
  };

  return {
    enabled,
    async head(userId, mediaId) {
      check();
      let res;
      try {
        res = await fetch(objectUrl(userId, mediaId), { method: 'HEAD', headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        throw fail(503, 'UNAVAILABLE', 'Your files couldn’t be reached. Try again shortly.');
      }
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw fail(503, 'UNAVAILABLE', 'Your files couldn’t be reached. Try again shortly.');
      return { type: String(res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase(), size: Number(res.headers.get('content-length')) || 0 };
    },
    async get(userId, mediaId, { range, signal } = {}) {
      check();
      return fetch(objectUrl(userId, mediaId), { method: 'GET', headers: { ...headers(), ...(range ? { range } : {}) }, signal: signal ?? AbortSignal.timeout(120_000) });
    },
    async bytes(userId, mediaId) {
      check();
      let res;
      try {
        res = await fetch(objectUrl(userId, mediaId), { method: 'GET', headers: headers(), signal: AbortSignal.timeout(120_000) });
      } catch {
        throw fail(503, 'UNAVAILABLE', 'Your files couldn’t be reached. Try again shortly.');
      }
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw fail(503, 'UNAVAILABLE', 'Your files couldn’t be reached. Try again shortly.');
      return { bytes: Buffer.from(await res.arrayBuffer()), type: String(res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase() };
    },
  };
}

/** What a file is, from its type: 'image' | 'video' | null. */
export function mediaKind(type) {
  const t = String(type || '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  return null;
}

/**
 * Each network's formats (spec §1.7 "Format rules"), phase 1. → null when it's fine, else a plain reason.
 * media: { type, size } | null (a text-only post).
 */
export function formatProblem(platform, media) {
  const kind = media ? mediaKind(media.type) : null;
  const t = media?.type ?? '';
  switch (platform) {
    case 'instagram':
      if (!media) return 'Instagram posts need a photo or a video.';
      if (kind === 'image' && t !== 'image/jpeg') return 'Instagram only takes JPEG photos. Save the post again so the app can make a JPEG copy.';
      if (kind === 'video' && t !== 'video/mp4') return 'Instagram Reels need an MP4 video.';
      if (!kind) return 'Instagram can’t post this kind of file.';
      return null;
    case 'facebook':
      if (!media) return null;
      if (kind === 'video') return 'Posting videos to a Facebook Page from the app is coming soon. Post it yourself for now.';
      if (!['image/jpeg', 'image/png'].includes(t)) return 'Facebook Pages take JPEG or PNG photos.';
      return null;
    case 'linkedin':
      if (!media) return null;
      if (kind === 'video') return 'Posting videos to LinkedIn from the app is coming soon. Post it yourself for now.';
      if (!['image/jpeg', 'image/png', 'image/gif'].includes(t)) return 'LinkedIn takes JPEG, PNG or GIF photos.';
      return null;
    case 'tiktok':
      if (!media) return 'TikTok posts need a video or a photo.';
      if (kind === 'video' && t !== 'video/mp4') return 'TikTok needs an MP4 video.';
      if (kind === 'image' && !['image/jpeg', 'image/webp'].includes(t)) return 'TikTok photo posts take JPEG or WebP photos.';
      if (!kind) return 'TikTok can’t post this kind of file.';
      return null;
    case 'x':
      if (!media) return null;
      if (kind === 'video' && t !== 'video/mp4') return 'X needs an MP4 video.';
      if (kind === 'image' && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(t)) return 'X takes JPEG, PNG, GIF or WebP photos.';
      if (!kind) return 'X can’t post this kind of file.';
      return null;
    case 'youtube':
      if (!media || kind !== 'video') return 'YouTube needs a video.';
      return null;
    default:
      return 'That network isn’t supported.';
  }
}
