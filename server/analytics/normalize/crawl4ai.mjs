// Crawl4AI's rows (routed post lists served by crawl4ai, and the direct crawl4ai.* calls), every network.
import { first, post } from './util.mjs';

export function crawl4aiPost(r) {
  if (!r || typeof r !== 'object') return null;
  const stats = r.stats && typeof r.stats === 'object' ? r.stats : {};
  return post({
    id: first(r.id, r.code, r.post_id, r.video_id),
    url: r.url,
    text: first(r.caption, r.text, r.description, r.title, ''),
    at: first(r.taken_at, r.posted, r.created_at),
    likes: first(r.likes, r.reactions, stats.likes),
    comments: first(r.comments, stats.comments),
    shares: first(r.shares, stats.shares),
    views: first(r.views, r.plays, stats.plays),
  });
}
