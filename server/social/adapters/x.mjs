// X posts (nango-digest §3.5, spec §1.7 X), all through the proxy with Base-Url-Override https://api.x.com.
//   a photo: POST /2/media/upload (one-shot, the bytes as base64 in JSON) → media id
//   a video: POST /2/media/upload/initialize, /{id}/append (≤ 5 MB segments), /{id}/finalize (each one-shot),
//            then GET /2/media/upload?command=STATUS&media_id= (reads) until processing is done
//   POST /2/tweets (one-shot) → 201 { data: { id } }
//   the first comment is a reply: POST /2/tweets { text, reply: { in_reply_to_tweet_id } } (a separate one-shot)
// "Check again": GET /2/users/me, then GET /2/users/{id}/tweets?max_results=5 (reads X bills per resource).

import { isObj, mediaFailure, ok, recentEnough, str } from './common.mjs';
import { sameStart } from '../caption.mjs';

export const X_BASE = 'https://api.x.com';
const SEGMENT = 5 * 1024 * 1024;
const idOk = (v) => /^\d{1,30}$/.test(v);
const postUrl = (id) => `https://x.com/i/web/status/${id}`;

async function uploadMedia(ctx) {
  const file = await ctx.mediaStore.bytes(ctx.userId, ctx.media.id);
  if (!file) return { error: { state: 'failed', errorCode: 'MEDIA_MISSING' } };
  const w = (req) => ctx.write({ ...req, baseUrlOverride: X_BASE });
  if (ctx.media.kind === 'image') {
    const r = await w({ method: 'POST', path: '/2/media/upload', body: { media: file.bytes.toString('base64'), media_category: 'tweet_image', media_type: file.type } });
    const id = r.outcome === 'ok' ? str(r.res.body?.data?.id) : '';
    if (!idOk(id)) return { error: mediaFailure(r) };
    return { mediaId: id };
  }
  const init = await w({ method: 'POST', path: '/2/media/upload/initialize', body: { media_type: 'video/mp4', total_bytes: file.bytes.length, media_category: 'tweet_video' } });
  const id = init.outcome === 'ok' ? str(init.res.body?.data?.id) : '';
  if (!idOk(id)) return { error: mediaFailure(init) };
  for (let i = 0, at = 0; at < file.bytes.length; i++, at += SEGMENT) {
    const seg = file.bytes.subarray(at, at + SEGMENT);
    const a = await w({ method: 'POST', path: `/2/media/upload/${id}/append`, body: { media: seg.toString('base64'), segment_index: i } });
    if (a.outcome !== 'ok') return { error: mediaFailure(a) };
  }
  const fin = await w({ method: 'POST', path: `/2/media/upload/${id}/finalize` });
  if (fin.outcome !== 'ok') return { error: mediaFailure(fin) };
  let info = fin.res.body?.data?.processing_info;
  const deadline = ctx.now() + ctx.timing.xVideoMaxMs;
  while (isObj(info) && ['pending', 'in_progress'].includes(info.state)) {
    if (ctx.now() >= deadline) return { error: { state: 'failed', errorCode: 'MEDIA_PROCESSING' } };
    await ctx.sleep(Math.min(Math.max(Number(info.check_after_secs) || 5, 1), 30) * 1000);
    const s = await ctx.read({ method: 'GET', path: '/2/media/upload', query: { command: 'STATUS', media_id: id }, baseUrlOverride: X_BASE });
    info = ok(s) ? s.body?.data?.processing_info : { state: 'failed' };
  }
  if (isObj(info) && info.state === 'failed') return { error: { state: 'failed', errorCode: 'MEDIA_PROCESSING' } };
  return { mediaId: id };
}

export const x = {
  async publish(ctx) {
    let mediaId = '';
    if (ctx.media) {
      const up = await uploadMedia(ctx);
      if (up.error) return up.error;
      mediaId = up.mediaId;
    }
    const r = await ctx.write({ method: 'POST', path: '/2/tweets', baseUrlOverride: X_BASE, body: { text: ctx.composed.text, ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) } });
    if (r.outcome === 'failed') return { state: 'failed', errorCode: r.code };
    if (r.outcome === 'unknown') return { state: 'unknown' };
    const id = str(r.res.body?.data?.id);
    if (!idOk(id)) return { state: 'unknown' };
    const out = { state: 'sent', url: postUrl(id), ref: { postId: id } };
    if (ctx.composed.comment) {
      const c = await ctx.write({ method: 'POST', path: '/2/tweets', baseUrlOverride: X_BASE, body: { text: ctx.composed.comment, reply: { in_reply_to_tweet_id: id } } });
      out.comment = c.outcome === 'ok' ? 'added' : 'not_added';
    }
    return out;
  },

  async check(ctx, job) {
    const me = await ctx.read({ method: 'GET', path: '/2/users/me', baseUrlOverride: X_BASE });
    const userId = ok(me) ? str(me.body?.data?.id) : '';
    if (!idOk(userId)) return { found: false };
    const res = await ctx.read({ method: 'GET', path: `/2/users/${userId}/tweets`, query: { max_results: '5', 'tweet.fields': 'created_at' }, baseUrlOverride: X_BASE });
    if (!ok(res)) return { found: false };
    const list = Array.isArray(res.body?.data) ? res.body.data : [];
    const hit = list.find((t) => isObj(t) && sameStart(ctx.composed.text, t.text) && recentEnough(t.created_at, job.requested_at));
    const id = hit ? str(hit.id) : '';
    if (!idOk(id)) return { found: false };
    return { found: true, url: postUrl(id), ref: { postId: id } };
  },
};
