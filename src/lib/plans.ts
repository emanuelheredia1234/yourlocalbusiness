// Plans (Launch, Grow, Scale) as the app shows them: every price and limit comes from shared/plans.json, the same
// file the server reads (the server decides; the app only shows and asks).
//
// Billing is never shown in the claude.ai artifact build, nor when the app's server hasn't set up Stripe.

import catalog from '../../shared/plans.json';

export type Tier = 'launch' | 'grow' | 'scale';
export type Interval = 'month' | 'year';

export interface PlanDef {
  name: string;
  price: Record<Interval, number>;
  lookupKeys: Record<Interval, string>;
  businessesIncluded: number;
  aiCreditsPerMonth: number;
  video: { maxHeight: number; maxSeconds: number; label: string };
  /** AI videos each business may start a week (Monday to Sunday in its time zone); null = unlimited */
  videosPerWeek: number | null;
  /** A/B tests the account may start per AI-credit window (P4b); null = unlimited */
  experimentsPerMonth: number | null;
  adsLaunch: boolean;
  treg: { monthlyMicro: number; dailyMicro: number };
  leadEmailsPerMonth: number;
  publicListings: number;
  customDomains: number;
  platformFeePct: number;
  promptControl: 'style_notes' | 'per_prompt';
  support: 'email' | 'priority';
}

export interface PlansCatalog {
  version: number;
  currency: string;
  tiers: Tier[];
  plans: Record<Tier, PlanDef>;
  additionalBusiness: { name: string; price: Record<Interval, number>; lookupKeys: Record<Interval, string>; aiCreditsPerMonth: number };
  creditUsd: number;
  graceDays: number;
  pagesAfterCancelDays: number;
  dataAfterCancelDays: number;
  existingAccountTrial: { tier: Tier; days: number };
  /** the card trial a first plan starts with (its length is the owner's setting; this is its allowance) */
  cardTrial: { days: number; aiCredits: number; endingSoonDays: number };
  /** setup's one-off AI allowance before any plan */
  starter: { aiCredits: number };
}

export const PLANS = catalog as unknown as PlansCatalog;
export const TIERS: Tier[] = PLANS.tiers;

export const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as string[]).includes(v);
export const isInterval = (v: unknown): v is Interval => v === 'month' || v === 'year';

export const planFor = (tier: Tier): PlanDef => PLANS.plans[tier];
export const tierName = (tier: string | null | undefined): string => (isTier(tier) ? PLANS.plans[tier].name : tier === 'owner' ? 'Owner' : 'No plan');

/** $97 or $1,970 (whole dollars without cents). */
export function formatPrice(cents: number): string {
  const dollars = cents / 100;
  const whole = Number.isInteger(dollars);
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** What a year costs less than twelve months, in cents (annual is ten months' price: two months free). */
export function yearlySavings(tier: Tier): number {
  const p = planFor(tier).price;
  return Math.max(0, p.month * 12 - p.year);
}

/** How many months a year's price saves (rounded), for "2 months free". */
export function monthsFree(tier: Tier): number {
  const p = planFor(tier).price;
  return Math.round(yearlySavings(tier) / p.month);
}

export const tierRank = (tier: string | null | undefined): number => (isTier(tier) ? TIERS.indexOf(tier) : tier === 'owner' ? 99 : -1);

export type PlanFeature = 'adsLaunch' | 'video_length' | 'per_prompt' | 'priority_support';

/** The lowest tier that has a feature (the upgrade prompt's "Upgrade to …"). */
export function featureTier(feature: PlanFeature | string): Tier {
  const has = (t: Tier) => {
    const p = planFor(t);
    switch (feature) {
      case 'adsLaunch':
      case 'ads':
        return p.adsLaunch;
      case 'video_length':
        return p.video.maxSeconds > planFor('launch').video.maxSeconds;
      case 'per_prompt':
        return p.promptControl === 'per_prompt';
      case 'priority_support':
        return p.support === 'priority';
      default:
        return true;
    }
  };
  return TIERS.find(has) ?? 'scale';
}

/** AI credits a month for a tier with `extra` businesses above the first. */
export const creditsFor = (tier: Tier, extra = 0): number => planFor(tier).aiCreditsPerMonth + PLANS.additionalBusiness.aiCreditsPerMonth * Math.max(0, extra);

/** "$9.70" a month of AI on the owner's keys, from the credits (1 credit ≈ 1¢). */
export const creditsUsd = (credits: number): string => formatPrice(Math.round(credits * PLANS.creditUsd * 100));

/** "$3/mo" of treg budget, from micro-dollars. */
export const microUsd = (micro: number): string => formatPrice(Math.round(micro / 10_000));

/** The price line of a plan: "$97/month" or "$970/year". */
export const priceLine = (tier: Tier, interval: Interval): string => `${formatPrice(planFor(tier).price[interval])}/${interval}`;

/** The extra business line: "$97/month" (or the yearly price). */
export const businessPriceLine = (interval: Interval): string => `${formatPrice(PLANS.additionalBusiness.price[interval])}/${interval}`;

const isArtifact = () => typeof __ARTIFACT_BUILD__ !== 'undefined' && __ARTIFACT_BUILD__;

/**
 * Whether plans are shown at all: never in the claude.ai artifact build; otherwise when the server said Stripe is
 * set up (GET /api/config → billing.enabled).
 */
export function isBillingUi(config: { enabled?: boolean } | null | undefined): boolean {
  return !isArtifact() && config?.enabled === true;
}

/** One row of the comparison table: a label and a value per tier. */
export interface CompareRow {
  label: string;
  values: Record<Tier, string | boolean>;
}

const n = (v: number) => v.toLocaleString('en-US');

/** "3", or "Unlimited" (null). */
export const videosPerWeekLabel = (v: number | null | undefined): string => (v == null ? 'Unlimited' : n(v));

/** AI videos a week for each business on a tier (null = unlimited). */
export const videosPerWeekFor = (tier: string | null | undefined): number | null => (isTier(tier) ? (planFor(tier).videosPerWeek ?? null) : null);

/** The comparison table, from plans.json (every row of the Tiers table). */
export function compareRows(): CompareRow[] {
  const per = <T,>(fn: (p: PlanDef, t: Tier) => T): Record<Tier, T> => Object.fromEntries(TIERS.map((t) => [t, fn(planFor(t), t)])) as Record<Tier, T>;
  const extra = PLANS.additionalBusiness.price;
  return [
    { label: 'Businesses included', values: per((p) => n(p.businessesIncluded)) },
    { label: 'Each extra business', values: per(() => `${formatPrice(extra.month)}/mo · ${formatPrice(extra.year)}/yr`) },
    { label: 'AI credits a month', values: per((p) => n(p.aiCreditsPerMonth)) },
    { label: 'AI credits per extra business', values: per(() => `+${n(PLANS.additionalBusiness.aiCreditsPerMonth)}`) },
    { label: 'Video', values: per((p) => p.video.label) },
    { label: 'AI videos a week, per business', values: per((p) => videosPerWeekLabel(p.videosPerWeek)) },
    { label: 'Launch ads from the app', values: per((p) => p.adsLaunch) },
    { label: 'Analytics updates (budget a month)', values: per((p) => microUsd(p.treg.monthlyMicro)) },
    { label: 'Lead emails a month', values: per((p) => n(p.leadEmailsPerMonth)) },
    { label: 'Public Marketplace listings', values: per((p) => n(p.publicListings)) },
    { label: 'Custom domains', values: per((p) => n(p.customDomains)) },
    { label: 'Fee on your sales', values: per((p) => (p.platformFeePct ? `${p.platformFeePct}%` : 'None')) },
    { label: 'Prompt control', values: per((p) => (p.promptControl === 'per_prompt' ? 'Per prompt' : 'Style notes')) },
    { label: 'Support', values: per((p) => (p.support === 'priority' ? 'Priority' : 'Email')) },
  ];
}

/** What every plan has (the shared rows of the table). */
export const SHARED_FEATURES = [
  'Social posting',
  'Analytics',
  'Morning action',
  'Assistant',
  'Email studio',
  'Lead magnets',
  'SEO pages',
  'Video planner and editor',
  'Whop buy links',
] as const;
