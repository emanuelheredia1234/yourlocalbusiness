// Instagram Trial Reels (P4b §A4): a Reel Instagram shows to non-followers first. Only for Instagram videos, on a
// public professional account with 1,000+ followers. The server checks the followers and refuses what isn't eligible
// (server/social/trialReels.mjs); this is the words and the pure rules the pickers use.

import type { Post, ShareMode, TrialEligibility } from '@/lib/types';

export const TRIAL_MIN_FOLLOWERS = 1000;
export const SHARE_MODES: readonly ShareMode[] = ['CUSTOM', 'TRIAL_REELS_SHARE_TO_FOLLOWERS_IF_LIKED', 'TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS'];

export const isTrialMode = (m: unknown): m is Exclude<ShareMode, 'CUSTOM'> => m === 'TRIAL_REELS_SHARE_TO_FOLLOWERS_IF_LIKED' || m === 'TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS';

/** The Reel mode a post is saved with (anything unknown is a regular Reel). */
export const shareModeOf = (post: Pick<Post, 'instagram'>): ShareMode => (SHARE_MODES.includes(post.instagram?.shareMode as ShareMode) ? (post.instagram!.shareMode as ShareMode) : 'CUSTOM');

/** Whether the "Post as" choice shows: an Instagram video post (or one that will be a video). */
export const canTrialReel = (post: Pick<Post, 'platform' | 'format' | 'media'>): boolean => post.platform === 'instagram' && (post.media ? post.media.kind === 'video' : post.format === 'video');

export const SHARE_MODE_OPTIONS: { value: ShareMode; label: string; hint: string }[] = [
  { value: 'CUSTOM', label: 'Reel', hint: 'A regular Reel for your followers and feed.' },
  { value: 'TRIAL_REELS_SHARE_TO_FOLLOWERS_IF_LIKED', label: 'Trial Reel', hint: 'Instagram shares it with your followers if it does well within 72 hours.' },
  { value: 'TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS', label: 'Trial Reel (only non-followers)', hint: 'Only non-followers see it; you decide later in Instagram whether to share it.' },
];

export const shareModeLabel = (m: ShareMode | null | undefined): string => SHARE_MODE_OPTIONS.find((o) => o.value === m)?.label ?? 'Reel';

export const TRIAL_HELP = 'Trial Reels can’t have collaborators and aren’t shared to your feed. Only you see that it’s a trial.';

export interface EligibilityView {
  /** the line shown under the choice */
  line: string;
  /** trial options disabled */
  disabled: boolean;
  /** the "Post as a trial anyway" checkbox shows */
  askAnyway: boolean;
  tone: 'good' | 'muted' | 'warn';
}

/** The eligibility line and what it allows (null eligibility: still checking). */
export function eligibilityView(el: TrialEligibility | null | undefined): EligibilityView {
  if (!el) return { line: 'Checking whether this account can post Trial Reels…', disabled: false, askAnyway: false, tone: 'muted' };
  const f = typeof el.followers === 'number' ? el.followers.toLocaleString('en-US') : null;
  if (el.eligible === true) return { line: `Trial Reels: available${f ? ` (${f} followers)` : ''}`, disabled: false, askAnyway: false, tone: 'good' };
  if (el.eligible === false && el.reason === 'followers') return { line: `Trial Reels need ${TRIAL_MIN_FOLLOWERS.toLocaleString('en-US')}+ followers${f ? ` (you have ${f})` : ''}`, disabled: true, askAnyway: false, tone: 'warn' };
  if (el.eligible === false && el.reason === 'needs_reconnect') return { line: 'Reconnect Instagram to post Trial Reels', disabled: true, askAnyway: false, tone: 'warn' };
  if (el.eligible === false) return { line: 'Connect Instagram to post Trial Reels', disabled: true, askAnyway: false, tone: 'warn' };
  return { line: 'We couldn’t check your followers. Trial Reels need a public professional account with 1,000+ followers. If Instagram refuses, nothing is posted.', disabled: false, askAnyway: true, tone: 'muted' };
}

/** The post with its Reel mode set (CUSTOM drops the field: a regular Reel is the default). */
export function withShareMode<T extends Pick<Post, 'instagram'>>(post: T, mode: ShareMode): T {
  if (mode === 'CUSTOM') {
    const { instagram: _drop, ...rest } = post;
    return rest as T;
  }
  return { ...post, instagram: { shareMode: mode } };
}
