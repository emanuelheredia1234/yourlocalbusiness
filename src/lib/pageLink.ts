// The link social posts carry, and where it goes on each network: in the post, in the first comment (a reply
// on X), or in the profile's bio. Plain module: the Strategy tab imports it too.
import type { LinkPlacement, PageType, Post, PostPlatform, Project } from './types';
import { stripProtocol } from './utils';

export const LINK_PLACEMENTS: LinkPlacement[] = ['post', 'comment', 'bio'];
export const LINK_PLACEMENT_LABEL: Record<LinkPlacement, string> = { post: 'In the post', comment: 'First comment', bio: 'Bio' };

/** Where each network's link went before link settings existed, and still goes when none is set. */
export const DEFAULT_LINK_PLACEMENT: Record<PostPlatform, LinkPlacement> = { instagram: 'bio', tiktok: 'bio', facebook: 'post', linkedin: 'post', x: 'post' };

/** One plain fact per network about links (for the settings and the Strategy tab). */
export const LINK_FACTS: Record<PostPlatform, string> = {
  instagram: 'Links in Instagram captions and comments can’t be clicked.',
  tiktok: 'Links in TikTok captions and comments can’t be clicked.',
  facebook: 'Links in Facebook posts and comments can be clicked.',
  linkedin: 'Links in LinkedIn posts and comments can be clicked.',
  x: 'On X a link counts as 23 characters, and the first comment is a reply.',
};

/** An address with any lone "/" after the host taken off ("https://mybakery.com/" → "https://mybakery.com"). */
const noTrailingSlash = (url: string) => url.replace(/^(https?:\/\/[^/?#]+)\/$/i, '$1');

/** A web address we'll put in a post: http(s) with a real host, else '' (the same rule as safeUrl in pages/store/actions.ts, kept here so this module imports no page code). */
function webUrl(raw: string | undefined): string {
  const t = (raw ?? '').trim();
  if (!t) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.') && !u.username ? noTrailingSlash(u.toString()) : '';
  } catch {
    return '';
  }
}

/** The link posts use: the published SEO page (on the owner's domain when set), else the website, else none. */
export function pageLink(project: Project): { url: string; source: 'domain' | 'app' | 'website' } | null {
  const pub = project.marketing.seoPublished;
  if (pub?.domainUrl) return { url: pub.domainUrl, source: 'domain' };
  if (pub?.url) return { url: pub.url, source: 'app' };
  const site = webUrl(project.brand.websiteUrl);
  return site ? { url: site, source: 'website' } : null;
}

/** Where a network's link goes on this project's new posts: the owner's setting, else the default. */
export function placementFor(project: Pick<Project, 'marketing'>, platform: PostPlatform): LinkPlacement {
  return project.marketing.linkPlacement?.[platform] ?? DEFAULT_LINK_PLACEMENT[platform];
}

/** A post's link and where it goes. */
export interface PostLink {
  url: string;
  placement: LinkPlacement;
}

/** The link a new post on this network carries, and where it goes; null while there's nothing to link to. */
export function postLinkFor(project: Project, platform: PostPlatform, placement?: LinkPlacement): PostLink | null {
  const l = pageLink(project);
  return l ? { url: l.url, placement: placement ?? placementFor(project, platform) } : null;
}

/** Where an existing post's link goes: its own choice, else what its caption was written for. */
export function postPlacement(post: Pick<Post, 'platform' | 'linkPlacement'>): LinkPlacement {
  return post.linkPlacement ?? DEFAULT_LINK_PLACEMENT[post.platform];
}

/** The link an existing post carries now, and where it goes (for Rewrite and the AI batch). */
export function postLinkOf(project: Project, post: Pick<Post, 'platform' | 'linkPlacement'>): PostLink | null {
  const l = pageLink(project);
  return l ? { url: l.url, placement: postPlacement(post) } : null;
}

/** The first comment to add with the post, when its link goes there. */
export function firstCommentOf(post: Pick<Post, 'platform' | 'linkPlacement' | 'firstComment'>): string | undefined {
  return postPlacement(post) === 'comment' ? post.firstComment?.trim() || undefined : undefined;
}

const COMMENT_LEAD: Record<PageType, string> = { lead: 'Get in touch here:', booking: 'Book here:', website: 'Our website:', landing: 'All the details here:', showcase: 'See what we offer:', checkout: 'Get it here:' };

/** The first comment a new post gets when its link goes there (the owner can edit it). */
export function firstCommentFor(project: Project, link: PostLink | null): string | undefined {
  if (!link || link.placement !== 'comment') return undefined;
  const page = pageLink(project);
  // a page type this version doesn't know reads as a landing page
  const lead = page && page.source !== 'website' ? (COMMENT_LEAD[project.marketing.pageType ?? 'landing'] ?? COMMENT_LEAD.landing) : 'More here:';
  return `${lead} ${noTrailingSlash(link.url)}`;
}

/** The link as a caption shows it: a domain's home page without https:// ("mybakery.com"), any other address in full. */
export function linkText(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === '/' && !u.search && !u.hash ? stripProtocol(url) : url;
  } catch {
    return url;
  }
}

/** The addresses of the project's page and website, as captions may carry them. */
export function knownLinks(project: Project): string[] {
  const pub = project.marketing.seoPublished;
  return [pub?.url, pub?.domainUrl, project.brand.websiteUrl].filter((u): u is string => !!u?.trim());
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bare = (u: string) => u.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
/** Exactly one of these addresses (with or without https:// and www.), never a longer one that starts the same. */
function addressPattern(urls: string[]): string | null {
  const forms = [...new Set(urls.map(bare).filter(Boolean))].sort((a, b) => b.length - a.length).map(esc);
  return forms.length ? `(?<![\\w.@/-])(?:https?:\\/\\/)?(?:www\\.)?(?:${forms.join('|')})\\/?(?![\\w/?#=&-]|\\.\\w)` : null;
}
const BIO = String.raw`(?<!your )\b(?:the )?link (?:is )?in (?:my |our |the )?bio\b`;
const COMMENT = String.raw`(?<!your )\b(?:the )?link (?:is )?in (?:the )?(?:first |1st )?(?:comments?|repl(?:y|ies))\b`;

/** What a caption says when the link isn't in it. */
export function linkPointer(placement: Exclude<LinkPlacement, 'post'>, platform: PostPlatform): string {
  return placement === 'comment' ? (platform === 'x' ? 'the link in the first reply' : 'the link in the first comment') : 'the link in bio';
}

/**
 * The caption with its link moved to where it goes: the address itself, "the link in the first comment"
 * ("…first reply" on X) or "the link in bio". It replaces the link, the `known` addresses and the phrases
 * that say where a link is; it never adds a link the caption didn't point to. Without a link it changes
 * nothing, and running it again changes nothing.
 */
export function placeLink(caption: string, link: PostLink | null, platform: PostPlatform, known: string[] = []): string {
  if (!link?.url || !caption) return caption;
  const re = new RegExp([addressPattern([link.url, ...known]), BIO, COMMENT].filter(Boolean).join('|'), 'gi');
  const target = link.placement === 'post' ? linkText(link.url) : linkPointer(link.placement, platform);
  const placed = caption.replace(re, (m) => {
    if (link.placement === 'post') return target;
    const out = /^link/i.test(m) ? target.replace(/^the /, '') : target;
    return /^[A-Z]/.test(m) ? out[0].toUpperCase() + out.slice(1) : out;
  });
  // "Tap the link in bio sparkle.co" (an owner's CTA plus the website) would now say it twice: once is enough
  const twice = new RegExp(`(${esc(target.replace(/^the /, ''))})(?:[\\s,:;–—-]+(?:the )?${esc(target.replace(/^the /, ''))})+`, 'gi');
  return placed.replace(twice, (_m, first: string) => first);
}

// X counts a link as 23 characters whatever its length, an emoji as 2, most Latin text as 1 and other scripts as 2.
const X_URL = /(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:\/[^\s]*)?/gi;
const X_ONE: [number, number][] = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{20E3}/u;
const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
const graphemes = (s: string) => (segmenter ? [...segmenter.segment(s)].map((x) => x.segment) : [...s]);
const one = (cp: number) => X_ONE.some(([a, b]) => cp >= a && cp <= b);
const weight = (g: string) => (EMOJI.test(g) ? 2 : [...g].reduce((n, ch) => n + (one(ch.codePointAt(0) ?? 0) ? 1 : 2), 0));

/** The length X counts for a text (at worst a little over, never under, for links). */
export function xLength(text: string): number {
  const t = text.normalize('NFC');
  const links = t.match(X_URL)?.length ?? 0;
  return links * 23 + graphemes(t.replace(X_URL, '')).reduce((n, g) => n + weight(g), 0);
}

function clipX(s: string, room: number): string {
  if (xLength(s) <= room) return s;
  let out = '';
  for (const g of graphemes(s)) {
    // "…" counts 2 on X
    if (xLength(out + g) > room - 2) break;
    out += g;
  }
  // never cut a link in the middle (half an address is a wrong one): end before it instead
  for (const m of s.matchAll(X_URL)) {
    const start = m.index ?? 0;
    if (start < out.length && start + m[0].length > out.length) {
      out = out.slice(0, start);
      break;
    }
  }
  return `${out.trimEnd()}…`;
}
const LINKISH = new RegExp([X_URL.source, BIO, COMMENT].join('|'), 'i');

/**
 * An X caption that fits in `max` with its hashtags: it keeps the paragraph with the link (or the line that
 * says where it is), else the last paragraph (the call to action), whole, and shortens the opening.
 */
export function fitForX(caption: string, hashtags: string[] = [], max = 280): string {
  const tags = hashtags.filter(Boolean).join(' ');
  if (xLength(tags ? `${caption}\n\n${tags}` : caption) <= max) return caption;
  const paras = caption.split(/\n{2,}/);
  let i = paras.length - 1;
  while (i > 0 && !LINKISH.test(paras[i])) i--;
  const tail = i > 0 ? paras[i] : paras.length > 1 ? paras[paras.length - 1] : '';
  const room = max - (tail ? xLength(tail) + 2 : 0) - (tags ? xLength(tags) + 2 : 0);
  const head = clipX(paras[0], Math.max(20, room));
  return tail ? `${head}\n\n${tail}` : head;
}
