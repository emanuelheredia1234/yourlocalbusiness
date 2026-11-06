// What every way of posting shares, whoever posts: the app through your connected account, you yourself, or
// Manus in Facebook groups. Each network's account words and limits, the post's full text, which account to
// suggest, and what stops a post from going out. Nothing here posts or talks to a network.

import type { Post, PostPlatform } from '@/lib/types';
import { safeStorage } from '@/lib/storage';
import { xLength } from '@/lib/pageLink';
import { PLATFORMS } from './knowledge';

/** Each network's account, in the words its own website uses, and its limits. */
export interface Network {
  /** what to call the account in a form */
  account: string;
  placeholder: string;
  hint: string;
  /** furthest ahead the network schedules posts, in days */
  maxDays: number;
  /** the network takes no post without an image or video */
  needsMedia: boolean;
  /** text longer than this may be refused (some accounts allow more) */
  textLimit?: number;
  /** where the account's scheduled posts are listed */
  scheduledList: string;
  /** where to post it yourself */
  home: string;
}

export const NETWORKS: Record<PostPlatform, Network> = {
  facebook: {
    account: 'Facebook Page',
    placeholder: 'Your business Page name',
    hint: 'The Page name as it appears on Facebook.',
    maxDays: 75,
    needsMedia: false,
    scheduledList: 'the Planner in Meta Business Suite',
    home: 'https://business.facebook.com/latest/home',
  },
  instagram: {
    account: 'Instagram account',
    placeholder: '@yourbusiness',
    hint: 'The account’s username. Scheduling needs a professional (business or creator) account linked to Meta Business Suite.',
    maxDays: 75,
    needsMedia: true,
    scheduledList: 'the Planner in Meta Business Suite',
    home: 'https://www.instagram.com/',
  },
  tiktok: {
    account: 'TikTok account',
    placeholder: '@yourbusiness',
    hint: 'The account’s username. TikTok schedules up to 10 days ahead.',
    maxDays: 10,
    needsMedia: true,
    scheduledList: 'TikTok Studio’s list of scheduled posts',
    home: 'https://www.tiktok.com/tiktokstudio/upload',
  },
  linkedin: {
    account: 'LinkedIn profile or Page',
    placeholder: 'Your name, or your company Page',
    hint: 'Your own name to post as yourself, or the company Page name to post as the Page (you need to be its admin).',
    maxDays: 90,
    needsMedia: false,
    scheduledList: 'LinkedIn’s list of scheduled posts',
    home: 'https://www.linkedin.com/feed/',
  },
  x: {
    account: 'X account',
    placeholder: '@yourbusiness',
    hint: 'The account’s @handle.',
    maxDays: 75,
    needsMedia: false,
    textLimit: 280,
    scheduledList: 'X’s list of scheduled posts',
    home: 'https://x.com/compose/post',
  },
};

/** "Facebook", "X" (never "X (Twitter)"). */
export const networkLabel = (n: PostPlatform) => PLATFORMS[n].label.replace(' (Twitter)', '');

/** Where the account name for a network was last used (per project, on this device). */
export const accountKey = (projectId: string, network: PostPlatform) => `ylb-post-account:${projectId}:${network}`;
/** Older versions remembered one Facebook Page name for every project. */
const LEGACY_FB_PAGE_KEY = 'ylb-fb-page';

/** The account to suggest: the last one used here, then the brand's handle, then its name. */
export function suggestedAccount(projectId: string, network: PostPlatform, brand: { name: string; socials: Partial<Record<string, string>> }): string {
  const used = safeStorage.getItem(accountKey(projectId, network)) || (network === 'facebook' ? safeStorage.getItem(LEGACY_FB_PAGE_KEY) : null);
  if (used) return used;
  const handle = (brand.socials[network] ?? '').trim();
  if (handle) return handle;
  return network === 'facebook' || network === 'linkedin' ? brand.name : '';
}

export function rememberAccount(projectId: string, network: PostPlatform, account: string) {
  if (account.trim()) safeStorage.setItem(accountKey(projectId, network), account.trim());
}

/** Each network schedules only so far ahead, and not in the next half hour. */
export function scheduleWindowError(network: PostPlatform, iso: string, now = Date.now()): string | null {
  const t = new Date(iso).getTime();
  const n = NETWORKS[network];
  if (!Number.isFinite(t)) return 'Pick a date and time first.';
  if (t - now < 30 * 60_000) return `Pick a time at least 30 minutes from now: ${networkLabel(network)} only schedules ahead.`;
  if (t - now > n.maxDays * 24 * 3600_000) return `${networkLabel(network)} schedules posts up to ${n.maxDays} days ahead. Pick an earlier date.`;
  return null;
}

/**
 * Why this post can't go out (yet), or null when it can. viaServer: false only for the Manus groups flow in
 * claude.ai, where a video can't reach Manus.
 */
export function postBlocker(post: Pick<Post, 'platform' | 'format' | 'media'>, o: { viaServer?: boolean } = {}): string | null {
  const n = NETWORKS[post.platform];
  if (post.format === 'video' && post.media?.kind !== 'video') return 'Make or add the video first: a storyboard can’t be posted.';
  if (post.media?.kind === 'video' && o.viaServer === false) return 'Videos go to Manus through your own server, so post this one from the self-hosted app.';
  if (n.needsMedia && !post.media) return `${networkLabel(post.platform)} needs an image or a video. Add one first.`;
  return null;
}

/** Text longer than the network usually takes (some accounts allow more, so this only warns). */
export function textWarning(post: Pick<Post, 'platform' | 'caption' | 'hashtags'>): string | null {
  const limit = NETWORKS[post.platform].textLimit;
  const text = postText(post);
  // X counts every link as 23 characters
  const n = post.platform === 'x' ? xLength(text) : [...text].length;
  return limit && n > limit ? `${networkLabel(post.platform)} takes ${limit} characters on most accounts, and this post has ${n}. Shorten it unless your account allows longer posts.` : null;
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function fmtWhen(iso: string, timeZone = localTimeZone()): string {
  try {
    return new Date(iso).toLocaleString('en-US', { timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return new Date(iso).toString();
  }
}

/** The caption, then its hashtags after a blank line. */
export function postText(post: Pick<Post, 'caption' | 'hashtags'>): string {
  const tags = post.hashtags.filter(Boolean).join(' ');
  return tags ? `${post.caption.trim()}\n\n${tags}` : post.caption.trim();
}
