// The launch window's choices for one platform, before they go to the server's preview. Nothing that spends is
// ever prefilled: PAUSED/ACTIVE and the "special category" question start unanswered, and with two platforms the
// daily amounts start empty (the plan's daily is the total for both). Amounts are never carried across currencies.

import type { AdCampaign } from '@/lib/types';
import type { AdsPlatform, LaunchChoice, LaunchPreviewRequest, LaunchReview, TargetOption } from '@/lib/ads/launchTypes';

export interface LaunchDraft {
  platform: AdsPlatform;
  /** launch on this platform (with two, the customer can launch one and not the other) */
  include: boolean;
  locations: TargetOption[];
  radiusMi: number;
  interests: TargetOption[];
  languages: string[];
  specialCategory: '' | 'none' | 'yes';
  creativeIds: string[];
  claimsConfirmed: string[];
  /** as typed: a whole number of the account's currency, or '' */
  daily: string;
  /** the customer typed the amount (a prefilled one is cleared when the account isn't in the plan's currency) */
  dailyTouched: boolean;
  durationDays: number;
  startMode: 'asap' | 'day';
  startDate: string;
  startTime: string;
  status: '' | LaunchChoice;
  review: LaunchReview | null;
  reviewToken: string | null;
  /** the request the review was made for (a change since needs a new review) */
  reviewedFor: string | null;
}

/** Ad platforms this window can launch on, in the plan's order. */
export const launchablePlatforms = (plan: AdCampaign): AdsPlatform[] => plan.platforms.filter((p): p is AdsPlatform => p === 'meta' || p === 'google');

/** The plan's free-text places as separate searches ("Austin, TX; Round Rock" → two). */
export const placeSearches = (locations: string): string[] =>
  locations
    .split(/[;\n]|\s+\/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);

export function newDraft(plan: AdCampaign, platform: AdsPlatform, platformCount: number): LaunchDraft {
  return {
    platform,
    include: true,
    locations: [],
    radiusMi: Math.max(10, Math.round(plan.radiusMi || 10)),
    interests: [],
    languages: ['en'],
    specialCategory: '',
    creativeIds: platform === 'meta' ? plan.selectedCreativeIds.slice(0, 3) : [],
    claimsConfirmed: [],
    // one platform: the plan's daily; two: empty, the customer splits it
    daily: platformCount === 1 && Number.isInteger(plan.dailyBudget) ? String(plan.dailyBudget) : '',
    dailyTouched: false,
    durationDays: Math.max(1, Math.min(90, plan.durationDays || 14)),
    startMode: 'asap',
    startDate: '',
    startTime: '09:00',
    status: '',
    review: null,
    reviewToken: null,
    reviewedFor: null,
  };
}

/** The plan's daily is in USD: an account in another currency starts with an empty field (never converted). */
export function forCurrency(d: LaunchDraft, currency: string | undefined): LaunchDraft {
  if (!currency || currency === 'USD' || d.dailyTouched || !d.daily) return d;
  return { ...d, daily: '' };
}

/** The daily amount as a whole number, or null when it isn't one. */
export const dailyOf = (d: LaunchDraft): number | null => (/^\d{1,7}$/.test(d.daily.trim()) && Number(d.daily) >= 1 ? Number(d.daily) : null);

/** What's still missing before a preview can be asked for, in plain words (the server checks everything again). */
export function draftProblems(d: LaunchDraft, o: { accountChosen: boolean; minDaily?: number }): string[] {
  const out: string[] = [];
  if (!o.accountChosen) out.push('Pick the ad account.');
  if (!d.locations.length) out.push('Pick at least one place.');
  if (!d.specialCategory) out.push('Answer whether the ad is about housing, jobs, credit, financial products, politics or gambling.');
  if (d.platform === 'meta' && (!d.creativeIds.length || d.creativeIds.length > 3)) out.push('Pick 1 to 3 ads.');
  const daily = dailyOf(d);
  if (daily == null) out.push('Enter the daily amount as a whole number.');
  else if (o.minDaily && daily < o.minDaily) out.push(`The daily amount must be at least ${o.minDaily}.`);
  if (!Number.isInteger(d.durationDays) || d.durationDays < 1 || d.durationDays > 90) out.push('Pick between 1 and 90 days.');
  if (d.startMode === 'day' && !/^\d{4}-\d{2}-\d{2}$/.test(d.startDate)) out.push('Pick the start day.');
  if (!d.status) out.push('Choose Paused or Active.');
  return out;
}

/** The preview request for this draft (only the customer's own picks; the server reads the saved plan). */
export function previewRequest(d: LaunchDraft, projectId: string, planId: string): LaunchPreviewRequest {
  return {
    projectId,
    planId,
    platform: d.platform,
    status: d.status as LaunchChoice,
    ...(d.startMode === 'day' ? { startDate: d.startDate, ...(d.platform === 'meta' ? { startTime: d.startTime || '09:00' } : {}) } : { startTime: 'asap' }),
    dailyBudget: dailyOf(d) ?? Number.NaN,
    durationDays: d.durationDays,
    locations: d.locations.map((l) => l.ref),
    ...(d.platform === 'meta' ? { radiusMi: d.radiusMi, interests: d.interests.map((i) => i.ref), creativeIds: d.creativeIds } : { languages: d.languages }),
    claimsConfirmed: d.claimsConfirmed,
    specialCategory: d.specialCategory as 'none' | 'yes',
  };
}

/** A key for "what was reviewed": any change after the review needs a new one. */
export const requestKey = (r: LaunchPreviewRequest) => JSON.stringify(r);

/** The review is still for exactly these picks, and nothing blocks it. */
export const readyToConfirm = (d: LaunchDraft, projectId: string, planId: string) => !!d.review && !!d.reviewToken && d.review.blockers.length === 0 && d.reviewedFor === requestKey(previewRequest(d, projectId, planId));

/** "Meta $15 + Google $10 = $25 a day (plan: $25)" when both are in the same currency; null otherwise. */
export function splitLine(drafts: LaunchDraft[], plan: AdCampaign, currencyOf: (p: AdsPlatform) => string | undefined): { text: string; over: boolean } | null {
  const inc = drafts.filter((d) => d.include);
  if (inc.length < 2) return null;
  const cur = new Set(inc.map((d) => currencyOf(d.platform)));
  if (cur.size !== 1 || !inc.every((d) => dailyOf(d) != null)) return null;
  const c = [...cur][0] ?? 'USD';
  const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
  const sum = inc.reduce((s, d) => s + (dailyOf(d) ?? 0), 0);
  const parts = inc.map((d) => `${d.platform === 'meta' ? 'Meta' : 'Google'} ${fmt(dailyOf(d) ?? 0)}`).join(' + ');
  return { text: `${parts} = ${fmt(sum)} a day (plan: ${fmt(plan.dailyBudget)})`, over: sum > plan.dailyBudget };
}
