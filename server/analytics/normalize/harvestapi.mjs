// HarvestAPI's LinkedIn company posts: {elements: [{id, linkedinUrl, content, postedAt, engagement}]}.
import { first, post } from './util.mjs';

export function harvestapiPost(r) {
  if (!r || typeof r !== 'object') return null;
  const e = r.engagement && typeof r.engagement === 'object' ? r.engagement : {};
  return post({
    id: r.id,
    url: first(r.linkedinUrl, r.shareLinkedinUrl),
    text: first(r.content, ''),
    at: first(r.postedAt?.date, r.postedAt?.timestamp),
    likes: e.likes,
    comments: e.comments,
    shares: e.shares,
  });
}
