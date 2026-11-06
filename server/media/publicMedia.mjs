// GET /api/media/public/<token>[.ext]: a short-lived, MAC'd link to one of a user's media files, for Upload-Post (and the
// networks behind it) to fetch a post's photo or video. Spec §1.7 "Media".
//
// While social posting is off (no UPLOAD_POST_API_KEY) no link is ever made, so every request answers 503.
// No sign-in and no same-origin check: the token is the permission (server/social/media.mjs makes it, 30 minutes
// for a photo, 2 hours for a video). A bad MAC answers 403, an expired token 410, a file that isn't there 404.
// The bytes stream from Supabase Storage with the service key; Range requests answer 206 (TikTok and video).
// The path is never logged as it is (server/integrations/common.mjs redactPath / unlogged), and the token isn't
// logged here either. Rate limit: 120 per minute per address (media-public).

import { safeLog } from '../integrations/common.mjs';
import { createMediaStore, PUBLIC_MEDIA_PATH, verifyMediaToken } from '../social/media.mjs';

const RANGE = /^bytes=(\d*)-(\d*)$/;

/** A single byte range of a file this long: { start, end } (inclusive), 'bad' (416), or null (whole file). */
export function parseRange(header, size) {
  if (!header) return null;
  const m = RANGE.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'bad';
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'bad';
    start = Math.max(size - n, 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'bad';
  return { start, end };
}

export function createPublicMediaRoutes(deps = {}) {
  const { send, corsHeaders = () => ({}), limit = () => false, clientKey = (req) => req.socket?.remoteAddress || 'unknown', env = process.env, fetch = globalThis.fetch, now = () => Date.now(), log = console } = deps;
  const store = deps.mediaStore ?? createMediaStore({ env, fetch });
  const plain = (req, res, status, error, code, extra = {}) => send(res, status, { error, code }, { ...corsHeaders(req), 'cache-control': 'no-store', 'x-robots-tag': 'noindex', ...extra });

  async function serve(req, res, token) {
    // links are only made for posts sent through a connected social account: with posting off there are none
    if (deps.connections && !deps.connections.socialEnabled) return plain(req, res, 503, 'This link isn’t available.', 'NOT_SET_UP');
    let v;
    try {
      v = verifyMediaToken(env, token, now());
    } catch {
      return plain(req, res, 503, 'This link isn’t available.', 'NOT_SET_UP');
    }
    if (!v.ok && v.why === 'expired') return plain(req, res, 410, 'This link has expired.', 'NOT_FOUND');
    if (!v.ok) return plain(req, res, 403, 'This link isn’t valid.', 'FORBIDDEN');
    if (!store.enabled) return plain(req, res, 503, 'This link isn’t available.', 'NOT_SET_UP');

    const head = await store.head(v.userId, v.mediaId).catch(() => undefined);
    if (head === undefined) return plain(req, res, 503, 'Try again shortly.', 'UNAVAILABLE');
    if (!head) return plain(req, res, 404, 'Not found.', 'NOT_FOUND');
    const range = parseRange(req.headers.range, head.size);
    const headers = {
      'content-type': head.type,
      'cache-control': 'private, max-age=0',
      'x-robots-tag': 'noindex',
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
    };
    if (range === 'bad') {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${head.size}` });
      return res.end();
    }
    if (req.method === 'HEAD') {
      res.writeHead(range ? 206 : 200, { ...headers, 'content-length': String(range ? range.end - range.start + 1 : head.size), ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${head.size}` } : {}) });
      return res.end();
    }

    let upstream;
    try {
      upstream = await store.get(v.userId, v.mediaId, range ? { range: `bytes=${range.start}-${range.end}` } : {});
    } catch {
      return plain(req, res, 503, 'Try again shortly.', 'UNAVAILABLE');
    }
    if (upstream.status === 404 || upstream.status === 400) return plain(req, res, 404, 'Not found.', 'NOT_FOUND');
    if (!upstream.ok) return plain(req, res, 503, 'Try again shortly.', 'UNAVAILABLE');

    if (range && upstream.status !== 206) {
      // storage sent the whole file: cut the range out here (files are at most the bucket's 50 MB)
      const all = Buffer.from(await upstream.arrayBuffer());
      const part = all.subarray(range.start, range.end + 1);
      res.writeHead(206, { ...headers, 'content-length': String(part.length), 'content-range': `bytes ${range.start}-${range.end}/${all.length}` });
      return res.end(part);
    }
    const length = upstream.headers.get('content-length');
    res.writeHead(range ? 206 : 200, {
      ...headers,
      ...(length ? { 'content-length': length } : {}),
      ...(range ? { 'content-range': upstream.headers.get('content-range') || `bytes ${range.start}-${range.end}/${head.size}` } : {}),
    });
    if (!upstream.body) return res.end();
    try {
      for await (const chunk of upstream.body) {
        if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      }
      res.end();
    } catch {
      res.destroy();
    }
  }

  return {
    async handle(req, res, url) {
      if (!url.pathname.startsWith(PUBLIC_MEDIA_PATH)) return false;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        plain(req, res, 405, 'Not allowed.', 'BAD_REQUEST', { allow: 'GET, HEAD' });
        return true;
      }
      if (limit('media-public', clientKey(req))) {
        plain(req, res, 429, 'Too many requests. Try again in a minute.', 'RATE_LIMITED');
        return true;
      }
      const token = url.pathname.slice(PUBLIC_MEDIA_PATH.length);
      try {
        await serve(req, res, token);
      } catch (e) {
        safeLog('public_media_error', { error: e?.name || 'Error' }, log);
        if (!res.headersSent) plain(req, res, 503, 'Try again shortly.', 'UNAVAILABLE');
        else res.destroy();
      }
      return true;
    },
    async forgetUser() {},
    async unforgetUser() {},
    async userDeleted() {},
    async onStart() {},
  };
}
