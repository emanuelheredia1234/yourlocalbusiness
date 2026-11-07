// How long Meta's ad review takes, said the same way everywhere (Meta only: Google's own wording stays). Honest:
// usually about 10 minutes, sometimes longer; Meta itself says up to 24 hours. A paused launch isn't reviewed
// until it is turned on.
import type { AdsPlatform, LaunchChoice } from './launchTypes';

/** An Active launch on Meta (the spend confirm, the launch message). */
export const META_REVIEW_TIME = 'Meta reviews new ads before they run, usually in about 10 minutes (sometimes up to 24 hours). It goes live once approved.';
/** A Paused launch on Meta: nothing is reviewed until it is turned on. */
export const META_REVIEW_WHEN_ON = 'It starts paused. Meta reviews new ads when you turn it on, usually in about 10 minutes (sometimes up to 24 hours). It goes live once approved.';
/** A resume on Meta: ads it hasn't approved yet are reviewed first. */
export const META_REVIEW_ON_RESUME = 'Ads Meta hasn’t approved yet are reviewed first, usually in about 10 minutes (sometimes up to 24 hours). It goes live once approved.';
/** Next to "In review" on a Meta campaign. */
export const META_IN_REVIEW = 'Meta usually reviews new ads in about 10 minutes (sometimes up to 24 hours). It goes live once approved.';

export interface ReviewToast {
  kind: 'success';
  title: string;
  body: string;
}

/** The message after a launch on Meta was sent (none for Google). */
export function launchedMessage(platform: AdsPlatform, status: LaunchChoice | null | undefined): ReviewToast | null {
  if (platform !== 'meta') return null;
  return status === 'PAUSED' ? { kind: 'success', title: 'Launching on Meta, paused', body: META_REVIEW_WHEN_ON } : { kind: 'success', title: 'Launching on Meta', body: META_REVIEW_TIME };
}

/** The message after a resume on Meta was sent (none for Google). */
export function resumedMessage(platform: AdsPlatform): ReviewToast | null {
  return platform === 'meta' ? { kind: 'success', title: 'Turning it on at Meta', body: META_REVIEW_ON_RESUME } : null;
}
