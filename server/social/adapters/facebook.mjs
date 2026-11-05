// Facebook Page posts (nango-digest §3.1, spec §1.7 "Provider calls" FB). The Page's own token is read once
// through the proxy (GET /v26.0/{target}?fields=access_token), kept in memory for this job only, and every
// call that needs it goes straight to graph.facebook.com (direct.mjs) as a bearer header: the post or photo,
// the first comment and the "Check again" read.

import { GRAPH_VERSION } from '../direct.mjs';
import { directWrite, isObj, ok, recentEnough, str } from './common.mjs';
import { sameStart } from '../caption.mjs';

const PAGE_ID = /^\d{1,30}$/;

/** The Page's token and id, or { error } (nothing was posted). */
async function pageAccess(ctx) {
  const res = await ctx.read({ method: 'GET', path: `/${GRAPH_VERSION}/{target}`, query: { fields: 'access_token' } });
  if (!ok(res)) return { error: res?.status === 403 ? 'PERMISSION' : 'NEEDS_RECONNECT' };
  const token = isObj(res.body) && typeof res.body.access_token === 'string' ? res.body.access_token : '';
  const pageId = isObj(res.body) ? str(res.body.id) : '';
  if (!token || !PAGE_ID.test(pageId)) return { error: 'NEEDS_RECONNECT' };
  return { token, pageId };
}

const postUrl = (id) => `https://www.facebook.com/${encodeURIComponent(id)}`;

export const facebook = {
  async publish(ctx) {
    const page = await pageAccess(ctx);
    if (page.error) return { state: 'failed', errorCode: page.error };
    const { composed } = ctx;
    const r = ctx.media
      ? await directWrite(() => ctx.direct.graph(page.token, { method: 'POST', path: `/${GRAPH_VERSION}/${page.pageId}/photos`, body: { url: ctx.publicUrl(), message: composed.text } }))
      : await directWrite(() => ctx.direct.graph(page.token, { method: 'POST', path: `/${GRAPH_VERSION}/${page.pageId}/feed`, body: { message: composed.text, ...(composed.link ? { link: composed.link } : {}) } }));
    if (r.outcome === 'failed') return { state: 'failed', errorCode: r.code };
    if (r.outcome === 'unknown') return { state: 'unknown' };
    const body = isObj(r.res.body) ? r.res.body : {};
    const id = str(body.post_id) || str(body.id);
    if (!id) return { state: 'unknown' };
    const out = { state: 'sent', url: postUrl(id), ref: { postId: id } };
    if (composed.comment) {
      // a separate one-shot: its failure doesn't change the post ("Comment not added")
      const c = await directWrite(() => ctx.direct.graph(page.token, { method: 'POST', path: `/${GRAPH_VERSION}/${encodeURIComponent(id)}/comments`, body: { message: composed.comment } }));
      out.comment = c.outcome === 'ok' ? 'added' : 'not_added';
    }
    return out;
  },

  async check(ctx, job) {
    const page = await pageAccess(ctx);
    if (page.error) return { found: false };
    let res;
    try {
      res = await ctx.direct.graph(page.token, { method: 'GET', path: `/${GRAPH_VERSION}/${page.pageId}/feed`, query: { fields: 'id,message,created_time', limit: '10' } });
    } catch {
      return { found: false };
    }
    if (!ok(res)) return { found: false };
    const list = Array.isArray(res.body?.data) ? res.body.data : [];
    const hit = list.find((p) => isObj(p) && sameStart(ctx.composed.text, p.message) && recentEnough(p.created_time, job.requested_at));
    if (!hit || !str(hit.id)) return { found: false };
    return { found: true, url: postUrl(str(hit.id)), ref: { postId: str(hit.id) } };
  },
};
