// What each network gets of a post (spec §1.7 "Caption composition"): the text, hashtags, link and first
// comment, composed from the post as it is stored in the user's account (never from free text in a request).
// Pure: no I/O, so every rule here is unit-tested (caption.test.mjs).
//
//   composeFor('x', { caption, hashtags, linkPlacement, firstComment, headline }) →
//     { text, link?, comment?, commentSupported, title?, description?, tags?, hasUrl, error? }
//
// linkPlacement: the stored post's 'post' | 'comment' | 'bio' (or the request's 'in_post' | 'first_comment' |
// 'bio' | 'none'); absent means the network's built-in default, which is what the caption was written for.

/** A web address in post text (what the networks turn into links). */
export const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
/** X counts every link as 23 characters, whatever its length (t.co). */
export const X_URL_WEIGHT = 23;
export const X_MAX = 280;
export const IG_MAX_HASHTAGS = 30;
export const TIKTOK_MAX = 2200;
export const YT_TITLE_MAX = 100;
export const YT_DESCRIPTION_MAX = 5000;
export const YT_TAGS_MAX_CHARS = 500;

/** The request's placement words and the post's, as one set. */
export function placementOf(p) {
  if (p === 'post' || p === 'in_post') return 'in_post';
  if (p === 'comment' || p === 'first_comment') return 'first_comment';
  if (p === 'bio') return 'bio';
  if (p === 'none') return 'none';
  return undefined;
}

const urlsIn = (text) => String(text ?? '').match(URL_RE) ?? [];
/** The first web address in a text ('' when none). */
export const firstUrl = (text) => urlsIn(text)[0] ?? '';

/** '#tag' for each hashtag, without empties or repeats (case-insensitive), in order. */
export function cleanHashtags(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const word = String(raw ?? '')
      .trim()
      .replace(/^#+/, '')
      .replace(/\s+/g, '');
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`#${word}`);
  }
  return out;
}

const joinBlocks = (...blocks) =>
  blocks
    .map((b) => String(b ?? '').trim())
    .filter(Boolean)
    .join('\n\n');

/**
 * A text's length as X counts it when the app posts it: code points, every link as 23, and every line break as 2
 * (the upload is multipart form data, which sends a line break as CR LF, and both count; over 280 Upload-Post
 * would split the post into a thread).
 */
export function xLength(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  let len = [...s.replace(URL_RE, '')].length;
  len += urlsIn(s).length * X_URL_WEIGHT;
  len += (s.match(/\n/g) ?? []).length;
  return len;
}

/** Cut to `max` code points, at a word break when one is close, with an ellipsis. */
export function cut(text, max) {
  const chars = [...String(text ?? '')];
  if (chars.length <= max) return chars.join('');
  const head = chars.slice(0, max - 1).join('');
  const space = head.lastIndexOf(' ');
  return `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`;
}

/**
 * The parts of a post one network gets. `post`: { caption, hashtags, linkPlacement, firstComment, headline }.
 * `error` is set (and nothing should be sent) when the text can't fit the network at all.
 */
export function composeFor(platform, post = {}) {
  const caption = String(post.caption ?? '').trim();
  const tags = cleanHashtags(post.hashtags);
  const placement = placementOf(post.linkPlacement);
  const comment = String(post.firstComment ?? '').trim();
  const wantsComment = placement === 'first_comment' && comment !== '';

  switch (platform) {
    case 'facebook': {
      const text = joinBlocks(caption, tags.join(' '));
      const link = placement === 'in_post' ? firstUrl(caption) : '';
      return { text, ...(link ? { link } : {}), ...(wantsComment ? { comment } : {}), commentSupported: true, hasUrl: urlsIn(text).length > 0 };
    }
    case 'instagram': {
      // links aren't clickable on Instagram: the caption keeps what the owner wrote, nothing is added
      const text = joinBlocks(caption, tags.slice(0, IG_MAX_HASHTAGS).join(' '));
      return { text, ...(wantsComment ? { comment } : {}), commentSupported: true, hasUrl: urlsIn(text).length > 0 };
    }
    case 'linkedin': {
      // plain text and plain #tags: Upload-Post takes the post text as it is (LinkedIn's own escaping is its job)
      const text = joinBlocks(caption, tags.join(' '));
      return { text, ...(wantsComment ? { comment } : {}), commentSupported: true, hasUrl: urlsIn(caption).length > 0 };
    }
    case 'tiktok': {
      // links aren't clickable on TikTok: they're left out of the title
      const words = caption.replace(URL_RE, '').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
      const text = cut(joinBlocks(words, tags.join(' ')), TIKTOK_MAX);
      return { text, commentSupported: false, hasUrl: false };
    }
    case 'x': {
      if (xLength(caption) > X_MAX) return { text: caption, error: 'TEXT_TOO_LONG', commentSupported: true, hasUrl: urlsIn(caption).length > 0 };
      // hashtags go on the end, each only if it still fits
      let text = caption;
      const fitting = [];
      for (const tag of tags) {
        const next = joinBlocks(caption, [...fitting, tag].join(' '));
        if (xLength(next) <= X_MAX) {
          fitting.push(tag);
          text = next;
        }
      }
      let reply = '';
      if (wantsComment) reply = xLength(comment) <= X_MAX ? comment : '';
      return { text, ...(reply ? { comment: reply } : {}), commentSupported: true, hasUrl: urlsIn(text).length > 0 };
    }
    case 'youtube': {
      const title = cut(String(post.headline ?? '').trim() || caption.split('\n')[0] || 'Video', YT_TITLE_MAX).replace(/[<>]/g, '');
      const description = cut(caption, YT_DESCRIPTION_MAX).replace(/[<>]/g, '');
      const ytTags = [];
      let total = 0;
      for (const t of tags.map((x) => x.slice(1))) {
        if (total + t.length + 1 > YT_TAGS_MAX_CHARS) break;
        ytTags.push(t);
        total += t.length + 1;
      }
      return { text: description, title, description, tags: ytTags, commentSupported: false, hasUrl: urlsIn(description).length > 0 };
    }
    default:
      return { text: caption, error: 'UNKNOWN_PLATFORM', commentSupported: false, hasUrl: false };
  }
}

/** X's list prices per post (estimates, in micro-USD): a post with a link costs more. */
export const X_POST_COST_MICRO = Object.freeze({ plain: 15_000, withUrl: 200_000 });
export const xPostCost = (composed) => (composed?.hasUrl ? X_POST_COST_MICRO.withUrl : X_POST_COST_MICRO.plain);

/** The start of a text, for matching a post we sent against a network's list of recent posts. */
export function matchPrefix(text, n = 40) {
  const plain = String(text ?? '')
    .split(URL_RE)[0]
    .replace(/\\(.)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return [...plain].slice(0, n).join('');
}

/** Whether a network's copy of a post starts like ours (spaces and LinkedIn escapes don't count). */
export function sameStart(ours, theirs) {
  const a = matchPrefix(ours);
  if (!a) return false;
  const b = String(theirs ?? '')
    .replace(/\\(.)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return b.startsWith(a);
}
