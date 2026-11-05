// YouTube uploads (nango-digest §3.6, spec §1.7 YouTube).
//   POST /upload/youtube/v3/videos?uploadType=resumable&part=snippet,status (one-shot, through the proxy) → the
//   session address in Location; the bytes are PUT there directly (not through the proxy, which bills per GB).
//   A refused session or upload means nothing was posted (failed); a PUT that times out or gets a 5xx may have
//   gone through (unknown).
// "Check again": GET /youtube/v3/search?forMine=true&type=video&order=date&maxResults=5 (100 quota units).

import { fail } from '../../integrations/common.mjs';
import { directWrite, isObj, mediaFailure, ok, recentEnough, str } from './common.mjs';

const PRIVACY = ['public', 'unlisted', 'private'];
const idOk = (v) => /^[A-Za-z0-9_-]{6,20}$/.test(v);
const videoUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

export const youtube = {
  async preflight(ctx) {
    const privacy = ctx.privacy ? String(ctx.privacy) : 'public';
    if (!PRIVACY.includes(privacy)) throw fail(400, 'BAD_REQUEST', 'Choose public, unlisted or private for the YouTube video.');
    return { youtubePrivacy: privacy };
  },

  async publish(ctx) {
    const file = await ctx.mediaStore.bytes(ctx.userId, ctx.media.id);
    if (!file) return { state: 'failed', errorCode: 'MEDIA_MISSING' };
    const { composed } = ctx;
    const session = await ctx.write({
      method: 'POST',
      path: '/upload/youtube/v3/videos',
      query: { uploadType: 'resumable', part: 'snippet,status' },
      headers: { 'X-Upload-Content-Type': file.type, 'X-Upload-Content-Length': String(file.bytes.length) },
      body: { snippet: { title: composed.title, description: composed.description, tags: composed.tags, categoryId: '22' }, status: { privacyStatus: ctx.youtubePrivacy || 'public', selfDeclaredMadeForKids: false } },
    });
    if (session.outcome !== 'ok') return mediaFailure(session);
    const location = str(session.res.headers?.location);
    if (!location) return { state: 'failed', errorCode: 'MEDIA_UPLOAD_FAILED' };
    const put = await directWrite(() => ctx.direct.upload('youtube', location, file.bytes, { 'content-type': file.type }), 'media');
    if (put.outcome === 'failed') return { state: 'failed', errorCode: put.code === 'MEDIA_REFUSED' ? 'MEDIA_REFUSED' : put.code };
    if (put.outcome === 'unknown') return { state: 'unknown' };
    const id = isObj(put.res.body) ? str(put.res.body.id) : '';
    if (!idOk(id)) return { state: 'unknown' };
    return { state: 'sent', url: videoUrl(id), ref: { postId: id }, ...(composed.comment ? { comment: 'not_supported' } : {}) };
  },

  async check(ctx, job) {
    const res = await ctx.read({ method: 'GET', path: '/youtube/v3/search', query: { part: 'snippet', forMine: 'true', type: 'video', order: 'date', maxResults: '5' } });
    if (!ok(res)) return { found: false };
    const list = Array.isArray(res.body?.items) ? res.body.items : [];
    const hit = list.find((v) => isObj(v) && str(v.snippet?.title) === ctx.composed.title && recentEnough(v.snippet?.publishedAt, job.requested_at));
    const id = hit ? str(hit.id?.videoId) : '';
    if (!idOk(id)) return { found: false };
    return { found: true, url: videoUrl(id), ref: { postId: id } };
  },
};
