// AnyAPI's objects (X tweets, Instagram and LinkedIn posts).
import { first, post } from './util.mjs';

export function anyapiPost(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.isReply === true) return null;
  return post({
    id: r.id,
    url: first(r.url, r.permalink),
    text: first(r.text, r.caption, ''),
    at: first(r.createdUtc, r.created_at, r.takenAt),
    likes: first(r.likes, r.likeCount),
    comments: first(r.replies, r.comments, r.commentCount),
    shares: first(r.retweets, r.shares),
    views: first(r.views, r.viewCount),
  });
}
