// The plans (shared/plans.json, which the app imports too; the server is authoritative): Launch, Grow and Scale, the
// "Additional business" add-on, and the synthetic owner plan (never in Stripe). Prices are in cents. 1 AI credit is
// $0.01 of AI cost on the app's keys; each extra business adds 1,000 credits a month. "2K" video is stored as 1440p.
// videosPerWeek: AI videos each business may start per week (Monday to Sunday in its time zone); null = unlimited.
//
//   planFor('grow')                → the frozen plan (or the owner's for 'owner', null for anything else)
//   lookupKeysAll()                → the 8 Stripe price lookup keys
//   tierFromLookupKey(k) / intervalFromLookupKey(k)
//   creditsFor(tier, extraBusinesses)

import fs from 'node:fs';

const deepFreeze = (o) => {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
};

/** shared/plans.json, frozen. */
export const PLANS = deepFreeze(JSON.parse(fs.readFileSync(new URL('../../shared/plans.json', import.meta.url), 'utf8')));

export const TIERS = PLANS.tiers;
export const INTERVALS = Object.freeze(['month', 'year']);
/** Stripe Product ids (custom, so the setup script finds them again). */
export const PRODUCT_IDS = Object.freeze({ launch: 'ylb_launch', grow: 'ylb_grow', scale: 'ylb_scale', business: 'ylb_additional_business' });

/** The owner's plan: unlimited everything, no Stripe Customer, ads on. */
export const OWNER_PLAN = deepFreeze({
  name: PLANS.owner.name,
  price: { month: 0, year: 0 },
  businessesIncluded: null,
  aiCreditsPerMonth: null,
  video: { maxHeight: 2160, maxSeconds: 60, label: 'Unlimited' },
  videosPerWeek: null,
  adsLaunch: true,
  treg: null,
  leadEmailsPerMonth: null,
  publicListings: null,
  customDomains: null,
  platformFeePct: 0,
  promptControl: 'per_prompt',
  support: 'priority',
});

export const isTier = (t) => TIERS.includes(t);
export const isInterval = (i) => INTERVALS.includes(i);
/** Launch < Grow < Scale (−1 for anything else). */
export const tierRank = (t) => TIERS.indexOf(t);

/** The plan of a tier ('owner' → the owner's), or null. */
export function planFor(tier) {
  if (tier === 'owner') return OWNER_PLAN;
  return isTier(tier) ? PLANS.plans[tier] : null;
}

/** Every price lookup key: the three tiers and the additional business, monthly and yearly. */
export function lookupKeysAll() {
  const out = [];
  for (const t of TIERS) out.push(PLANS.plans[t].lookupKeys.month, PLANS.plans[t].lookupKeys.year);
  out.push(PLANS.additionalBusiness.lookupKeys.month, PLANS.additionalBusiness.lookupKeys.year);
  return out;
}

/** What each lookup key is: { kind: 'tier'|'business', tier?, interval, amount, product }. */
export const PRICE_TABLE = deepFreeze(
  Object.fromEntries([
    ...TIERS.flatMap((t) => INTERVALS.map((i) => [PLANS.plans[t].lookupKeys[i], { kind: 'tier', tier: t, interval: i, amount: PLANS.plans[t].price[i], product: PRODUCT_IDS[t], productName: PLANS.plans[t].name }])),
    ...INTERVALS.map((i) => [PLANS.additionalBusiness.lookupKeys[i], { kind: 'business', interval: i, amount: PLANS.additionalBusiness.price[i], product: PRODUCT_IDS.business, productName: PLANS.additionalBusiness.name }]),
  ]),
);

/** The tier a price lookup key bills (null for the additional business or an unknown key). */
export const tierFromLookupKey = (key) => PRICE_TABLE[key]?.tier ?? null;
/** The interval of a lookup key ('month' | 'year'), or null. */
export const intervalFromLookupKey = (key) => PRICE_TABLE[key]?.interval ?? null;
/** Whether a lookup key is the additional business. */
export const isBusinessLookupKey = (key) => PRICE_TABLE[key]?.kind === 'business';

/** The lookup key of a tier (or 'business') for an interval. */
export function lookupKeyFor(tierOrBusiness, interval) {
  if (tierOrBusiness === 'business') return PLANS.additionalBusiness.lookupKeys[interval] ?? null;
  return planFor(tierOrBusiness)?.lookupKeys?.[interval] ?? null;
}

/** AI credits a month: the tier's plus 1,000 for each extra business (null = unlimited, for the owner). */
export function creditsFor(tier, extraBusinesses = 0) {
  if (tier === 'owner') return null;
  const p = planFor(tier);
  if (!p) return 0;
  return p.aiCreditsPerMonth + PLANS.additionalBusiness.aiCreditsPerMonth * Math.max(0, Math.trunc(Number(extraBusinesses) || 0));
}

/** Credits → dollars on the app's AI keys. */
export const creditsToUsd = (credits) => Math.round(Number(credits || 0) * PLANS.creditUsd * 1e6) / 1e6;
/** Dollars → credits (rounded up: a partial credit shows as used). */
export const usdToCredits = (usd) => Math.ceil(Math.round((Number(usd || 0) / PLANS.creditUsd) * 1e6) / 1e6);

/** AI videos a week for each business on a tier (null = unlimited: Scale and the owner; 0 for no plan). */
export function videosPerWeekFor(tier) {
  if (tier === 'owner') return null;
  const p = planFor(tier);
  if (!p) return 0;
  return p.videosPerWeek ?? null;
}
