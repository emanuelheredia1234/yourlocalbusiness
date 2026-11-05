// ScrapeCreators' objects (Instagram, Facebook, X and LinkedIn posts as they return them).
import { first, post } from './util.mjs';

export function scrapecreatorsPost(r) {
  if (!r || typeof r !== 'object') return null;
  return post({
    id: first(r.id, r.post_id, r.shortcode),
    url: first(r.url, r.permalink, r.link),
    text: first(r.text, r.caption, r.description, ''),
    at: first(r.publishTime, r.date, r.created_at, r.taken_at_timestamp),
    likes: first(r.reactionCount, r.likes, r.like_count),
    comments: first(r.commentCount, r.comments, r.comment_count),
    shares: first(r.shareCount, r.shares),
    views: first(r.videoViewCount, r.views, r.play_count),
  });
}
