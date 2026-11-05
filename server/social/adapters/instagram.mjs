// Instagram professional accounts through the Facebook connection (nango-digest §3.2, spec §1.7 IG):
//   preflight: GET /{ig_user}/content_publishing_limit (a used-up quota answers 429 PLATFORM_LIMIT before any job)
//   1. POST /{ig_user}/media (one-shot) → container id (image_url or video_url: our short-lived media link, in
//      the body only)
//   2. a video: GET /{container}?fields=status_code once a minute for up to 5 minutes (reads)
//   3. POST /{ig_user}/media_publish {creation_id} (one-shot) → media id
//   then the permalink (a read) and the first comment (a separate one-shot).
// "Check again": GET /{container}?fields=status_code; PUBLISHED means it went out.

import { GRAPH_VERSION } from '../direct.mjs';
import { fail } from '../../integrations/common.mjs';
import { isObj, ok, str } from './common.mjs';

const V = GRAPH_VERSION;

async function permalink(ctx, mediaId) {
  const res = await ctx.read({ method: 'GET', path: `/${V}/${encodeURIComponent(mediaId)}`, query: { fields: 'permalink' } });
  const link = ok(res) && isObj(res.body) ? str(res.body.permalink) : '';
  return /^https:\/\/(www\.)?instagram\.com\//.test(link) ? link : '';
}

export const instagram = {
  async preflight(ctx) {
    const res = await ctx.read({ method: 'GET', path: `/${V}/{ig_user}/content_publishing_limit`, query: { fields: 'quota_usage,config' } });
    if (!ok(res)) return; // couldn't tell: Instagram itself refuses a post over its limit
    const row = Array.isArray(res.body?.data) ? res.body.data[0] : null;
    const used = Number(row?.quota_usage);
    const total = Number(row?.config?.quota_total);
    if (Number.isFinite(used) && Number.isFinite(total) && total > 0 && used >= total) {
      throw fail(429, 'PLATFORM_LIMIT', 'This Instagram account has reached Instagram’s posting limit for today. Try again tomorrow or post it yourself.');
    }
  },

  async publish(ctx) {
    const { composed } = ctx;
    const video = ctx.media?.kind === 'video';
    const body = video ? { media_type: 'REELS', video_url: ctx.publicUrl(), caption: composed.text } : { image_url: ctx.publicUrl(), caption: composed.text };
    const c = await ctx.write({ method: 'POST', path: `/${V}/{ig_user}/media`, body });
    if (c.outcome === 'failed') return { state: 'failed', errorCode: c.code === 'REFUSED' ? 'MEDIA_REFUSED' : c.code };
    // nothing is public until media_publish, but a container may exist: a check can't find it without its id
    if (c.outcome === 'unknown') return { state: 'failed', errorCode: 'REFUSED' };
    const containerId = isObj(c.res.body) ? str(c.res.body.id) : '';
    if (!containerId) return { state: 'failed', errorCode: 'REFUSED' };
    await ctx.note({ containerId });

    if (video) {
      let status = '';
      const deadline = ctx.now() + ctx.timing.igVideoMaxMs;
      for (;;) {
        const s = await ctx.read({ method: 'GET', path: `/${V}/${encodeURIComponent(containerId)}`, query: { fields: 'status_code' } });
        status = ok(s) && isObj(s.body) ? str(s.body.status_code) : '';
        if (status === 'FINISHED' || status === 'ERROR' || status === 'EXPIRED' || status === 'PUBLISHED') break;
        if (ctx.now() + ctx.timing.igPollMs > deadline) break;
        await ctx.sleep(ctx.timing.igPollMs);
      }
      if (status === 'PUBLISHED') return { state: 'sent', ref: { containerId } };
      if (status !== 'FINISHED') return { state: 'failed', errorCode: 'MEDIA_PROCESSING', ref: { containerId } };
    }

    const p = await ctx.write({ method: 'POST', path: `/${V}/{ig_user}/media_publish`, body: { creation_id: containerId } });
    if (p.outcome === 'failed') return { state: 'failed', errorCode: p.code, ref: { containerId } };
    if (p.outcome === 'unknown') return { state: 'unknown', ref: { containerId } };
    const mediaId = isObj(p.res.body) ? str(p.res.body.id) : '';
    if (!mediaId) return { state: 'unknown', ref: { containerId } };
    const url = await permalink(ctx, mediaId);
    const out = { state: 'sent', ...(url ? { url } : {}), ref: { containerId, postId: mediaId } };
    if (composed.comment) {
      const r = await ctx.write({ method: 'POST', path: `/${V}/${encodeURIComponent(mediaId)}/comments`, body: { message: composed.comment } });
      out.comment = r.outcome === 'ok' ? 'added' : 'not_added';
    }
    return out;
  },

  async check(ctx, job) {
    const containerId = str(job.provider_ref?.containerId);
    if (!containerId) return null;
    const s = await ctx.read({ method: 'GET', path: `/${V}/${encodeURIComponent(containerId)}`, query: { fields: 'status_code' } });
    const status = ok(s) && isObj(s.body) ? str(s.body.status_code) : '';
    if (status !== 'PUBLISHED') return { found: false };
    return { found: true };
  },
};
