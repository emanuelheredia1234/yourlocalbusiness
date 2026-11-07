// Posting from the app through your connected account: what the confirm window shows (the text each network
// gets, read-only, built by the same rules as the server's caption.mjs), the request it sends once you confirm,
// and following the server's publish job. Every publish is one attempt: nothing here ever sends a post again by
// itself. "unknown" means it may have gone out, so the only next steps are a read-only check, marking it
// posted, or posting it yourself.

import type { Post, PostPlatform, Project, LinkPlacement } from '@/lib/types';
import type { ConnectPlatform, ConnectionStatus, LinkPlacementChoice, PublishJob, PublishRequest } from '@/lib/integrations/types';
import { getJob } from '@/lib/integrations/api';
import { firstCommentOf, pageLink, postPlacement, xLength } from '@/lib/pageLink';
import { networkLabel, postText } from '@/ai/postShared';
import { isTrialMode, shareModeOf } from '@/lib/trialReels';

/** The connected-account platform a post's network posts through (the same names). */
export const connectPlatformOf = (p: PostPlatform): ConnectPlatform => p;

/**
 * Whether the app can post on this account now: connected, or limited only in ways that still post (stats not
 * available yet, or TikTok posting as private until it approves the app).
 */
export function canPostFrom(status: ConnectionStatus | undefined): boolean {
  if (!status) return false;
  if (status.state === 'connected') return true;
  return status.state === 'limited' && (status.limitedReason === 'insights_unavailable' || status.limitedReason === 'private_only');
}

/** The account's name as the confirm window shows it ("Joe's Bakery (Page)"), or the network's. */
export function targetText(status: ConnectionStatus | undefined, platform: PostPlatform): string {
  const label = status?.targetLabel?.trim();
  if (!label) return `your ${networkLabel(platform)} account`;
  return status?.targetKind === 'fb_page' || status?.targetKind === 'li_org' ? `${label} (Page)` : label;
}

const PLACEMENT: Record<LinkPlacement, LinkPlacementChoice> = { post: 'in_post', comment: 'first_comment', bio: 'bio' };

/** Instagram takes at most 30 hashtags. */
const IG_MAX_TAGS = 30;
/** TikTok's caption limit. */
const TIKTOK_MAX = 2200;

export interface CaptionPreview {
  /** the text the network gets, exactly */
  text: string;
  /** the first comment (a reply on X) the app adds right after posting, when the network takes one */
  firstComment?: string;
  /** the first comment can't be added here: add it yourself */
  commentYourself?: string;
  /** where the link goes, in plain words */
  linkNote?: string;
  /** hashtags left out to fit the network */
  droppedTags: number;
  /** a post with a link on X (the link may be dropped: the app's X link allowance is shared) */
  xLinkCost: boolean;
  /** problems that stop it (the server refuses these too) */
  blockers: string[];
}

/**
 * What each network gets from this post (mirrors the server's caption rules, for a read-only preview). The
 * server builds the real payload from the saved post, never from this.
 */
export function captionPreview(post: Post, project: Project | undefined): CaptionPreview {
  const placement = postPlacement(post);
  const comment = firstCommentOf(post);
  const tags = post.hashtags.filter(Boolean);
  const caption = post.caption.trim();
  const name = networkLabel(post.platform);
  const link = project ? pageLink(project) : null;
  const blockers: string[] = [];
  let text = postText(post);
  let droppedTags = 0;
  let firstComment: string | undefined;
  let commentYourself: string | undefined;
  switch (post.platform) {
    case 'instagram': {
      const kept = tags.slice(0, IG_MAX_TAGS);
      droppedTags = tags.length - kept.length;
      text = postText({ caption, hashtags: kept });
      firstComment = comment;
      break;
    }
    case 'tiktok':
      // TikTok has no first comment through its API
      if (comment) commentYourself = 'Add your first comment in TikTok once it’s live.';
      if ([...text].length > TIKTOK_MAX) blockers.push(`TikTok takes ${TIKTOK_MAX} characters, and this post has ${[...text].length}.`);
      break;
    case 'x': {
      // hashtags go on only when they fit in 280 (a link counts 23)
      const kept: string[] = [];
      for (const t of tags) if (xLength(postText({ caption, hashtags: [...kept, t] })) <= 280) kept.push(t);
      droppedTags = tags.length - kept.length;
      text = postText({ caption, hashtags: kept });
      // the reply isn't added for you on X: add it yourself once the post is live
      if (comment) commentYourself = 'Add your reply on X once it’s live.';
      break;
    }
    default:
      firstComment = comment;
  }
  if (post.format === 'video' && post.media?.kind !== 'video') blockers.push('Make or add the video first: a storyboard can’t be posted.');
  if ((post.platform === 'instagram' || post.platform === 'tiktok') && !post.media) blockers.push(`${name} needs an image or a video. Add one first.`);
  const linkNote =
    !link || placement === 'post'
      ? undefined
      : placement === 'bio'
        ? `The link stays in your ${name} bio: the app doesn’t change your profile.`
        : firstComment
          ? `The link goes in the first ${post.platform === 'x' ? 'reply' : 'comment'}.`
          : undefined;
  return { text, firstComment, commentYourself, linkNote, droppedTags, xLinkCost: post.platform === 'x' && hasXLink(`${text}\n${firstComment ?? ''}`), blockers };
}

/**
 * Top-level domains a bare address ends in that X turns into a link; a 2-letter country code only with a path
 * (mybiz.de/menu) or after a second-level label (joes-bakery.co.uk), so "Thanks.So happy" is no link. The same rule
 * as the server's (server/connections/uploadpost.mjs).
 */
const X_TLDS =
  'com|net|org|info|biz|app|dev|io|ai|co|me|tv|xyz|shop|store|online|site|website|club|live|blog|news|page|link|art|design|studio|agency|business|company|services|solutions|tech|digital|media|cafe|bar|pizza|salon|fitness|health|church|school|academy|travel|events|photography|beauty|clinic|dental|law|realty|homes|garden|farm|auto|pet|vet|restaurant|bakery|coffee|menu|delivery|today|world|life|fun|love|works|email|group|team|global|city|nyc|london|berlin|paris|tokyo';
const X_SLD = '(?:co|com|org|net|ac|gov|edu|ltd|plc|nom|biz|info|me|or|ne|gob|gen|firm)';
const X_LINKISH = new RegExp(`https?:\\/\\/|\\bwww\\.[a-z0-9-]|(?:^|[^A-Za-z0-9@$#._'’-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${X_TLDS}|${X_SLD}\\.[a-z]{2}|[a-z]{2}(?=\\/))(?![A-Za-z0-9'’-])`, 'i');

/**
 * Whether a text has an address X turns into a link: http(s)://…, www.… or a bare domain such as mybiz.com (not part
 * of an email, a hashtag or a word). The server counts the same ones toward the shared X Links allowance.
 */
export const hasXLink = (text: string): boolean => X_LINKISH.test(text);

/** A fresh id for one press of Confirm: a double click makes one job on the server, a new press a new one. */
export function newClientRequestId(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The request Confirm sends: the saved post as it is (the server re-reads it and refuses one that changed). */
export function buildPublishRequest(post: Post, project: Project | undefined, o: { clientRequestId: string; mediaIds?: string[]; trialUnknownOk?: boolean }): PublishRequest {
  const link = project ? pageLink(project) : null;
  const comment = firstCommentOf(post);
  return {
    projectId: post.projectId,
    postId: post.id,
    platform: post.platform,
    confirm: true,
    clientRequestId: o.clientRequestId,
    content: {
      text: post.caption,
      hashtags: post.hashtags.filter(Boolean),
      ...(link ? { link: link.url, linkPlacement: PLACEMENT[postPlacement(post)] } : { linkPlacement: 'none' as const }),
      ...(comment ? { firstComment: comment } : {}),
      ...(o.mediaIds?.length ? { mediaIds: o.mediaIds } : {}),
      ...(post.platform === 'tiktok' && post.headline ? { title: post.headline.slice(0, 90) } : {}),
      // Instagram videos: the Reel mode the post was saved with (the server checks it against the saved post)
      ...(post.platform === 'instagram' && post.media?.kind === 'video' ? { shareMode: shareModeOf(post) } : {}),
    },
    ...(o.trialUnknownOk && isTrialMode(shareModeOf(post)) ? { trialUnknownOk: true as const } : {}),
  };
}

/** The app has (or may have) posted it: a job is sending, or its outcome is unknown. Moving or resending it waits. */
export const apiHolds = (post: Post) => post.external?.via === 'api' && (post.external.state === 'working' || post.external.state === 'unknown');

/** Sent with Manus by an older version: shown read-only. */
export const legacyManus = (post: Post) => post.external?.via === 'manus';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * Follow a job while it's sending: GET every few seconds (a pure read, never a check or a resend) for up to
 * two minutes. Returns the last job seen. A read that fails is skipped; the next one tries again.
 */
export async function followJob(jobId: string, o: { intervalMs?: number; maxMs?: number; signal?: AbortSignal; onUpdate?: (job: PublishJob) => void; read?: (id: string) => Promise<{ job: PublishJob }> } = {}): Promise<PublishJob | null> {
  const interval = o.intervalMs ?? 3000;
  const until = Date.now() + (o.maxMs ?? 120_000);
  const read = o.read ?? getJob;
  let last: PublishJob | null = null;
  while (!o.signal?.aborted) {
    try {
      last = (await read(jobId)).job;
      o.onUpdate?.(last);
      if (last.state !== 'queued' && last.state !== 'sending') return last;
    } catch {
      /* a read failed: the next one tries again */
    }
    if (Date.now() + interval > until) break;
    await sleep(interval, o.signal);
  }
  return last;
}

/** A plain reason for a refused post (the server's own codes; provider wording is never shown). */
export function failureCopy(job: Pick<PublishJob, 'errorCode' | 'errorMessage'>, platform: PostPlatform): string {
  const name = networkLabel(platform);
  switch (job.errorCode) {
    case 'MEDIA_UNSUPPORTED':
      return `${name} refused the image or video format.`;
    case 'NEEDS_RECONNECT':
    case 'NOT_CONNECTED':
      return `The ${name} connection needs to be renewed. Reconnect it in Settings › Connected accounts.`;
    case 'PLATFORM_LIMIT':
      return `${name} says this account has reached its posting limit for now. Try again later, or post it yourself.`;
    case 'CUSTOMER_CAP':
      return `You’ve reached today’s posting limit for ${name}. Post it yourself, or try again tomorrow.`;
    case 'POST_CHANGED':
      return 'The post changed since you opened it. Save it, then post it again.';
    case 'DUPLICATE':
      return `This looks the same as a recent post on ${name}. Change the text or the photo, then try again.`;
    case 'TIKTOK_PRIVACY':
      return 'This TikTok account doesn’t allow that audience setting. Check the account’s privacy settings in TikTok.';
    case 'BUSY':
      return 'Posting is busy right now. Try again in a minute.';
    case 'SERVICE_UNAVAILABLE':
      return 'Posting from the app isn’t available right now. We’ve been notified. You can post it yourself.';
    case 'TRIAL_REEL_REFUSED':
      return 'Instagram didn’t accept this as a Trial Reel (the account may not be eligible yet, or has hit Instagram’s trial limit). Nothing was posted. Post it as a regular Reel instead?';
    case 'UNCONFIRMED':
    case 'INTERRUPTED':
      return 'It may have been posted - check before trying again.';
    default:
      return `${name} didn’t take the post.`;
  }
}
