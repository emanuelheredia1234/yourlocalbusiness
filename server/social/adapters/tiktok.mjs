// TikTok direct posts (nango-digest §3.4, spec §1.7 TikTok and [R E4]).
//   preflight: POST /v2/post/publish/creator_info/query/ (a read) → privacy_level_options; the privacy sent must
//              be one of them. An unaudited app can only post SELF_ONLY (connection limited, private_only).
//   a video:   POST /v2/post/publish/video/init/ (one-shot). TIKTOK_UPLOAD_MODE=FILE_UPLOAD (default): the bytes are
//              PUT straight to the upload_url TikTok returns, in chunks. PULL_FROM_URL (only after the owner has
//              verified the media URL prefix with TikTok): TikTok fetches our short-lived link.
//   a photo:   POST /v2/post/publish/content/init/ (one-shot), PULL_FROM_URL only.
//   then the job stays `sending` while POST /v2/post/publish/status/fetch/ (a read) is asked every 10 s:
//   PUBLISH_COMPLETE → sent, FAILED → failed, still processing after 2 minutes → unknown.
// "Check again": the same status read.

import { fail } from '../../integrations/common.mjs';
import { directWrite, isObj, mediaFailure, ok, str } from './common.mjs';

const MB = 1024 * 1024;
const PRIVACY = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];

export const uploadMode = (env) => (String(env?.TIKTOK_UPLOAD_MODE || '').toUpperCase() === 'PULL_FROM_URL' ? 'PULL_FROM_URL' : 'FILE_UPLOAD');

/** TikTok's chunk rule: one chunk up to 64 MB; above that 10 MB chunks, the last one taking the remainder. */
export function chunksFor(size) {
  if (size <= 64 * MB) return { chunkSize: size, count: 1 };
  const chunkSize = 10 * MB;
  return { chunkSize, count: Math.floor(size / chunkSize) };
}

const tiktokOk = (res) => ok(res) && (!isObj(res.body?.error) || res.body.error.code === 'ok');

/** The publish's status: 'sent' | 'failed' | 'processing' | '' (couldn't read it). */
async function statusOf(ctx, publishId) {
  const res = await ctx.read({ method: 'POST', path: '/v2/post/publish/status/fetch/', body: { publish_id: publishId } });
  if (!tiktokOk(res)) return { state: '' };
  const s = str(res.body?.data?.status);
  const ids = Array.isArray(res.body?.data?.publicaly_available_post_id) ? res.body.data.publicaly_available_post_id.map(str).filter(Boolean) : [];
  if (s === 'PUBLISH_COMPLETE') return { state: 'sent', postId: ids[0] };
  if (s === 'FAILED') return { state: 'failed' };
  return { state: 'processing' };
}

export const tiktok = {
  async preflight(ctx) {
    if (ctx.media?.kind === 'image' && uploadMode(ctx.env) !== 'PULL_FROM_URL') {
      throw fail(400, 'MEDIA_UNSUPPORTED', 'TikTok photo posts from the app aren’t switched on yet. Post it yourself for now.');
    }
    const res = await ctx.read({ method: 'POST', path: '/v2/post/publish/creator_info/query/', body: {} });
    if (!tiktokOk(res)) throw fail(409, 'NEEDS_RECONNECT', 'TikTok didn’t answer for this account. Reconnect it in Settings → Connected accounts, or post it yourself.');
    const options = (Array.isArray(res.body?.data?.privacy_level_options) ? res.body.data.privacy_level_options : []).map(str).filter((o) => PRIVACY.includes(o));
    if (!options.length) throw fail(409, 'NEEDS_RECONNECT', 'TikTok won’t take posts from this account right now. Post it yourself.');
    let privacy;
    if (ctx.status?.limitedReason === 'private_only') privacy = 'SELF_ONLY';
    else if (ctx.privacy) privacy = String(ctx.privacy);
    else privacy = options.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : options[0];
    if (!options.includes(privacy)) throw fail(400, 'BAD_REQUEST', 'Choose who can see the TikTok post from the options shown.');
    return { tiktokPrivacy: privacy };
  },

  async publish(ctx) {
    const postInfo = { title: ctx.composed.text, privacy_level: ctx.tiktokPrivacy || 'SELF_ONLY', disable_duet: false, disable_comment: false, disable_stitch: false };
    let init;
    let file = null;
    if (ctx.media.kind === 'image') {
      init = await ctx.write({
        method: 'POST',
        path: '/v2/post/publish/content/init/',
        body: { post_info: { title: ctx.composed.text, privacy_level: postInfo.privacy_level }, source_info: { source: 'PULL_FROM_URL', photo_images: [ctx.publicUrl()], photo_cover_index: 0 }, post_mode: 'DIRECT_POST', media_type: 'PHOTO' },
      });
    } else if (uploadMode(ctx.env) === 'PULL_FROM_URL') {
      init = await ctx.write({ method: 'POST', path: '/v2/post/publish/video/init/', body: { post_info: postInfo, source_info: { source: 'PULL_FROM_URL', video_url: ctx.publicUrl() } } });
    } else {
      file = await ctx.mediaStore.bytes(ctx.userId, ctx.media.id);
      if (!file) return { state: 'failed', errorCode: 'MEDIA_MISSING' };
      const { chunkSize, count } = chunksFor(file.bytes.length);
      init = await ctx.write({ method: 'POST', path: '/v2/post/publish/video/init/', body: { post_info: postInfo, source_info: { source: 'FILE_UPLOAD', video_size: file.bytes.length, chunk_size: chunkSize, total_chunk_count: count } } });
    }
    if (init.outcome === 'failed') return { state: 'failed', errorCode: init.code };
    // FILE_UPLOAD: nothing goes out until we send the file, so an unclear init isn't a post. When TikTok fetches
    // the file itself (PULL_FROM_URL, photos) an init that timed out may still turn into a post: unknown.
    if (init.outcome === 'unknown') return file ? { state: 'failed', errorCode: 'REFUSED' } : { state: 'unknown' };
    if (!tiktokOk(init.res)) return { state: 'failed', errorCode: 'REFUSED' };
    const publishId = str(init.res.body?.data?.publish_id);
    if (!publishId) return { state: 'failed', errorCode: 'REFUSED' };
    await ctx.note({ publishId });

    if (file) {
      const uploadUrl = str(init.res.body?.data?.upload_url);
      if (!uploadUrl) return { state: 'failed', errorCode: 'MEDIA_UPLOAD_FAILED', ref: { publishId } };
      const total = file.bytes.length;
      const { chunkSize, count } = chunksFor(total);
      for (let i = 0; i < count; i++) {
        const start = i * chunkSize;
        const end = i === count - 1 ? total - 1 : start + chunkSize - 1;
        const part = file.bytes.subarray(start, end + 1);
        const put = await directWrite(() => ctx.direct.upload('tiktok', uploadUrl, part, { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${total}` }), 'media');
        if (put.outcome !== 'ok') return { ...mediaFailure(put), ref: { publishId } };
      }
    }

    // asynchronous: ask for the status (reads) until it's done, at most 2 minutes
    const deadline = ctx.now() + ctx.timing.tiktokMaxMs;
    for (;;) {
      await ctx.sleep(ctx.timing.tiktokPollMs);
      const s = await statusOf(ctx, publishId);
      if (s.state === 'sent') return { state: 'sent', ref: { publishId, ...(s.postId ? { postId: s.postId } : {}) } };
      if (s.state === 'failed') return { state: 'failed', errorCode: 'REFUSED', ref: { publishId } };
      if (ctx.now() >= deadline) return { state: 'unknown', ref: { publishId } };
    }
  },

  async check(ctx, job) {
    const publishId = str(job.provider_ref?.publishId);
    if (!publishId) return null;
    const s = await statusOf(ctx, publishId);
    if (s.state === 'sent') return { found: true, ref: { publishId, ...(s.postId ? { postId: s.postId } : {}) } };
    if (s.state === 'failed') return { found: false, failed: true };
    return { found: false };
  },
};
