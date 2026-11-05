// LinkedIn posts as the member or an organization they administer (nango-digest §3.3, spec §1.7 LinkedIn).
//   a photo: POST /rest/images?action=initializeUpload (one-shot) → uploadUrl + image urn; the bytes are PUT to
//            uploadUrl directly (not through the proxy). Any failure here: nothing was posted (failed).
//   POST /rest/posts (one-shot) → 201 with the post urn in x-restli-id (no urn: unknown)
//   the first comment: POST /rest/socialActions/{urn}/comments (a separate one-shot; UNVERIFIED path)
// "Check again": organization posts only (GET /rest/posts?q=author). A member's own posts can't be read back
// (r_member_social is closed to new apps), so their check makes no call: the app asks them to look.
//
// Env: LINKEDIN_UPLOAD_BEARER=1 sends the upload through the proxy instead (with the member's token), only if
// LinkedIn's upload links turn out to need it (spec §10 J1). Off by default.

import { directWrite, isObj, mediaFailure, ok, proxyWrite, recentEnough, str } from './common.mjs';
import { sameStart } from '../caption.mjs';

export const LINKEDIN_VERSION = '202610';
const HEADERS = { 'LinkedIn-Version': LINKEDIN_VERSION, 'X-Restli-Protocol-Version': '2.0.0' };

/** The author urn of the chosen account (person or organization), with the {target} placeholder. */
const authorOf = (ctx) => (ctx.status?.targetKind === 'li_org' ? 'urn:li:organization:{target}' : 'urn:li:person:{target}');
/** LinkedIn's times are epoch milliseconds. */
const msIso = (ms) => (Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : '');
const isOrg = (ctx) => ctx.status?.targetKind === 'li_org';
const postUrl = (urn) => `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}/`;

async function uploadImage(ctx, owner) {
  const init = await ctx.write({ method: 'POST', path: '/rest/images', query: { action: 'initializeUpload' }, headers: HEADERS, body: { initializeUploadRequest: { owner } } });
  if (init.outcome !== 'ok') return { error: mediaFailure(init) };
  const value = isObj(init.res.body?.value) ? init.res.body.value : {};
  const uploadUrl = str(value.uploadUrl);
  const image = str(value.image);
  if (!uploadUrl || !/^urn:li:image:/.test(image)) return { error: { state: 'failed', errorCode: 'MEDIA_UPLOAD_FAILED' } };
  const file = await ctx.mediaStore.bytes(ctx.userId, ctx.media.id);
  if (!file) return { error: { state: 'failed', errorCode: 'MEDIA_MISSING' } };
  let put;
  if (String(ctx.env.LINKEDIN_UPLOAD_BEARER || '') === '1') {
    const u = new URL(uploadUrl);
    put = await proxyWrite(ctx.connections, ctx.userId, 'linkedin', { method: 'PUT', baseUrlOverride: u.origin, path: u.pathname + u.search, headers: { 'Content-Type': file.type }, body: file.bytes }, ctx.timing.writeMs);
  } else {
    put = await directWrite(() => ctx.direct.upload('linkedin', uploadUrl, file.bytes, { 'content-type': file.type }), 'media');
  }
  if (put.outcome !== 'ok') return { error: mediaFailure(put) };
  return { image };
}

export const linkedin = {
  async publish(ctx) {
    const author = authorOf(ctx);
    let image = '';
    if (ctx.media) {
      const up = await uploadImage(ctx, author);
      if (up.error) return up.error;
      image = up.image;
    }
    const body = {
      author,
      commentary: ctx.composed.text,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      ...(image ? { content: { media: { id: image } } } : {}),
    };
    const r = await ctx.write({ method: 'POST', path: '/rest/posts', headers: HEADERS, body });
    const checkable = isOrg(ctx);
    if (r.outcome === 'failed') return { state: 'failed', errorCode: r.code };
    if (r.outcome === 'unknown') return { state: 'unknown', ref: { checkable } };
    const urn = str(r.res.headers?.['x-restli-id']) || (isObj(r.res.body) ? str(r.res.body.id) : '');
    if (!/^urn:li:(share|ugcPost):/.test(urn)) return { state: 'unknown', ref: { checkable } };
    const out = { state: 'sent', url: postUrl(urn), ref: { postId: urn, checkable } };
    if (ctx.composed.comment) {
      const c = await ctx.write({ method: 'POST', path: `/rest/socialActions/${encodeURIComponent(urn)}/comments`, headers: HEADERS, body: { actor: author, object: urn, message: { text: ctx.composed.comment } } });
      out.comment = c.outcome === 'ok' ? 'added' : 'not_added';
    }
    return out;
  },

  async check(ctx, job) {
    // a member's own posts can't be read back by a new app: no call, the job stays as it is
    if (!isOrg(ctx)) return null;
    const res = await ctx.read({ method: 'GET', path: '/rest/posts', query: { q: 'author', author: 'urn:li:organization:{target}', count: '10' }, headers: HEADERS });
    if (!ok(res)) return { found: false };
    const list = Array.isArray(res.body?.elements) ? res.body.elements : [];
    const hit = list.find((p) => isObj(p) && sameStart(ctx.composed.text, p.commentary) && recentEnough(msIso(p.createdAt ?? p.publishedAt), job.requested_at));
    const urn = hit ? str(hit.id) : '';
    if (!urn) return { found: false };
    return { found: true, url: postUrl(urn), ref: { postId: urn } };
  },
};
