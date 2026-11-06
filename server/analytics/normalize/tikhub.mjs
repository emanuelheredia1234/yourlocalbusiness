// TikHub's objects: TikTok "aweme" items, YouTube videos and Instagram media as TikHub passes them on.
import { first, post } from './util.mjs';

export function tikhubPost(r) {
  if (!r || typeof r !== 'object') return null;
  const s = r.statistics && typeof r.statistics === 'object' ? r.statistics : {};
  return post({
    id: first(r.aweme_id, r.video_id, r.id, r.code),
    url: first(r.share_url, r.url),
    text: first(r.desc, r.title, r.caption?.text, r.caption, ''),
    at: first(r.create_time, r.published_time, r.taken_at),
    likes: first(s.digg_count, r.like_count, r.likes),
    comments: first(s.comment_count, r.comment_count, r.comments),
    shares: first(s.share_count, r.shares),
    views: first(s.play_count, r.view_count, r.number_of_views, r.views),
  });
}
