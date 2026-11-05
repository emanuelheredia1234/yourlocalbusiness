// One normalizer per treg provider (X-Treg-Served-By) for post lists. Routed post and video lists hold the serving
// provider's own objects, so the provider decides how a post is read. An unknown provider gives no posts: the
// network still shows its profile numbers (followers, post count), never guessed post stats.
//
//   postsFrom(data, servedBy) → topPosts[] (SocialNetworkStats.topPosts shape)
//   profileFrom(data) → { followers, postsCount, isPrivate, userId, secUid, channelId, pageId }
//   servedByOf(res, endpointId) → the provider that answered

import { crawl4aiPost } from './crawl4ai.mjs';
import { anyapiPost } from './anyapi.mjs';
import { harvestapiPost } from './harvestapi.mjs';
import { scrapecreatorsPost } from './scrapecreators.mjs';
import { tikhubPost } from './tikhub.mjs';
import { compact, first, num, text } from './util.mjs';

export const POST_NORMALIZERS = Object.freeze({
  crawl4ai: crawl4aiPost,
  anyapi: anyapiPost,
  harvestapi: harvestapiPost,
  scrapecreators: scrapecreatorsPost,
  tikhub: tikhubPost,
});

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The provider that answered: treg's meta / _treg.served_by, else a direct call's own provider (its id's first part). */
export function servedByOf(res, endpointId = '') {
  const named = first(res?.meta?.servedBy, res?.meta?.served_by, res?.data?._treg?.served_by);
  if (typeof named === 'string' && named) return named.toLowerCase().split(/[.:/]/)[0];
  const head = String(endpointId).split('.')[0];
  return head && head !== 'treg' ? head : '';
}

/** The list of items in a provider's answer, wherever it keeps them. */
export function itemsOf(data) {
  if (!isObj(data) && !Array.isArray(data)) return [];
  if (Array.isArray(data)) return data;
  const out = isObj(data.output) ? data.output : data;
  for (const key of ['posts', 'videos', 'tweets', 'reels', 'items', 'rows', 'elements']) {
    if (Array.isArray(out[key])) return out[key];
  }
  // AnyAPI: output.data.tweets / output.data.items
  if (isObj(out.data)) for (const key of ['tweets', 'posts', 'items']) if (Array.isArray(out.data[key])) return out.data[key];
  if (Array.isArray(data.rows)) return data.rows;
  if (Array.isArray(data.elements)) return data.elements;
  return [];
}

/** The posts in an answer, normalized for its provider (none for a provider without a normalizer). */
export function postsFrom(data, servedBy) {
  const normalize = POST_NORMALIZERS[String(servedBy || '').toLowerCase()];
  if (!normalize) return [];
  const posts = [];
  for (const item of itemsOf(data).slice(0, 50)) {
    const p = normalize(item);
    if (p) posts.push(p);
  }
  return posts;
}

/** A profile's numbers: the routed contract's normalized output, or a direct call's first row. */
export function profileFrom(data) {
  if (!isObj(data)) return {};
  const o = isObj(data.output) ? data.output : Array.isArray(data.rows) && isObj(data.rows[0]) ? data.rows[0] : data;
  return compact({
    followers: num(first(o.followers, o.subscribers, o.follower_count)),
    postsCount: num(first(o.posts_count, o.videos_count, o.posts, o.videos, o.tweets, o.media_count)),
    isPrivate: o.is_private === true ? true : undefined,
    userId: first(o.user_id, o.id) != null ? text(first(o.user_id, o.id), 64) || undefined : undefined,
    secUid: o.sec_uid ? text(o.sec_uid, 200) : undefined,
    channelId: o.channel_id ? text(o.channel_id, 64) : undefined,
    pageId: first(o.page_id, data.raw?.adLibrary?.pageId) ? text(first(o.page_id, data.raw?.adLibrary?.pageId), 64) : undefined,
    name: first(o.name, o.full_name, o.nickname, o.title) ? text(first(o.name, o.full_name, o.nickname, o.title), 200) : undefined,
  });
}

/** Whether a profile answer is a miss (no such account). */
export function profileMissing(data) {
  if (!isObj(data)) return true;
  if (isObj(data.output)) return data.output.username === null || Object.keys(data.output).length === 0;
  if (Array.isArray(data.rows)) return data.rows.length === 0;
  return false;
}
