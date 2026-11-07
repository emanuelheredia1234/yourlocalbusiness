// What a user may do on their plan, from their billing_accounts row and billing_settings (pure: no I/O).
//
//   entitlementOf(account, settings, now, { isAdmin }) → Entitlement
//
// Rules, in order (docs/integrations-setup.md "Plans and billing"):
//  1. Plans not enforced → 'legacy': everything as before plans (daily limits still apply), nothing gated.
//  2. The owner (isAdmin, or source 'owner') → 'owner': unlimited.
//  3. The effective tier is tier_keep while tier_keep_until is ahead (a downgrade keeps the old tier to period end).
//  4. Free plans (source 'comp'): active until comp_until; then paused 'plan', banner 'plan_ended'.
//  5. Stripe plans by status: active/trialing → active; past_due → active until grace_until (7 days from the first
//     failed payment), then paused 'payment'; unpaid/paused → paused 'payment'; incomplete → paused 'plan';
//     canceled/incomplete_expired/none/expired → paused 'plan', banner 'plan_ended'.
//  6. After a plan ends (ended_at), published pages keep serving 30 days and data is kept 90 days (never deleted
//     automatically).
//  7. AI credits a month = the tier's + 1,000 per business above the first (paid or free extras); 0 while paused.
//  8. A card trial (a Stripe subscription 'trialing'): the chosen tier's features, but AI credits are the trial's
//     allowance (cardTrial.aiCredits, ~$3) for the whole trial, counted from its first UTC day (server/billing/
//     stripe.mjs adds creditWindow.baselineUsd: what setup spent that day before the trial, not the trial's); banner
//     'trial' (days left), 'trial_ending' in its last cardTrial.endingSoonDays days.
//  9. Before any plan (a new sign-up, never subscribed): paused 'plan' (publishing, posting, ads, video, connecting
//     and every other paid action refused: "Start your free trial"), but `starter` with a one-off AI allowance
//     (starter.aiCredits) so setup can make the brand board, strategy and first posts. A plan that ended gets none.
//     The window: monthly Stripe plans use the billing period; yearly and free plans use monthly windows anchored on
//     the billing anchor's (or the account's creation) day of the month, clamped to the month's length, in UTC days.

import { OWNER_PLAN, PLANS, creditsFor, planFor } from './plans.mjs';

const DAY_MS = 86_400_000;
/** Setup's AI allowance counts every day before a plan (no row yet: from long before any account existed). */
const STARTER_FROM = '2020-01-01T00:00:00.000Z';
const ms = (v) => (v == null ? null : typeof v === 'number' ? v : Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const iso = (t) => (t == null ? null : new Date(t).toISOString());

/** The features a plan gives (the later-phase values are exposed only; P1 enforces adsLaunch, video and treg). */
export function featuresOf(plan) {
  const p = plan ?? OWNER_PLAN;
  return {
    adsLaunch: p.adsLaunch === true,
    video: { maxHeight: p.video.maxHeight, maxSeconds: p.video.maxSeconds, label: p.video.label },
    // AI videos each business may start a week (null = unlimited)
    videosPerWeek: p.videosPerWeek ?? null,
    treg: p.treg ? { monthlyMicro: p.treg.monthlyMicro, dailyMicro: p.treg.dailyMicro } : null,
    leadEmailsPerMonth: p.leadEmailsPerMonth ?? null,
    publicListings: p.publicListings ?? null,
    customDomains: p.customDomains ?? null,
    platformFeePct: p.platformFeePct ?? 0,
    promptControl: p.promptControl,
    support: p.support,
  };
}

const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const anchoredStart = (y, m, day) => Date.UTC(y, m, Math.min(day, daysIn(y, m)));

/**
 * The monthly window around `now` anchored on `anchor`'s day of the month (UTC days; day 31 becomes the month's last
 * day): { start, resetsAt } as ISO strings.
 */
export function anchoredWindow(anchor, now) {
  const a = new Date(ms(anchor) ?? now);
  const day = a.getUTCDate();
  const n = new Date(now);
  let y = n.getUTCFullYear();
  let m = n.getUTCMonth();
  let start = anchoredStart(y, m, day);
  if (start > now) {
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
    start = anchoredStart(y, m, day);
  }
  const ny = m === 11 ? y + 1 : y;
  const nm = (m + 1) % 12;
  return { start: iso(start), resetsAt: iso(anchoredStart(ny, nm, day)) };
}

/** The credit window of an account at `now`. */
export function creditWindow(acct, now) {
  const start = ms(acct?.current_period_start);
  const end = ms(acct?.current_period_end);
  if (acct?.source === 'stripe' && acct.interval === 'month' && start != null && end != null && start <= now && now < end) return { start: iso(start), resetsAt: iso(end) };
  return anchoredWindow(acct?.billing_anchor ?? acct?.created_at ?? now, now);
}

const BASE = (plan, over = {}) => ({
  plan,
  active: true,
  paused: null,
  banner: null,
  tier: plan,
  status: null,
  source: null,
  businessLimit: null,
  creditsPerMonth: null,
  creditWindow: null,
  features: featuresOf(OWNER_PLAN),
  graceUntil: null,
  trialEndsAt: null,
  trial: false,
  trialDaysLeft: null,
  starter: false,
  pagesServeUntil: null,
  dataKeptUntil: null,
  ...over,
});

/**
 * account: the billing_accounts row (or null); settings: billing_settings ({ enforce }); now: ms; isAdmin: the
 * signed-in user is the app's owner (server/auth.mjs).
 */
export function entitlementOf(acct, settings, now = Date.now(), { isAdmin = false } = {}) {
  if (settings?.enforce !== true) return BASE('legacy');
  if (isAdmin === true || acct?.source === 'owner') return BASE('owner', { source: 'owner', status: 'active' });
  if (!acct || acct.tier === 'none' || !planFor(acct.tier)) {
    const ended = ms(acct?.ended_at);
    // never had a plan: setup's one-off AI allowance (a plan that ended, or a free plan that did, gets none)
    const fresh = ended == null && (!acct || (acct.status === 'none' && !acct.stripe_subscription_id && acct.source !== 'comp'));
    // counted over the whole account, never renewed: always from the start (the billing row is often made later, by a
    // Checkout that was then abandoned; anchoring on it would forgive what setup used before)
    return BASE('none', {
      ...(fresh ? { starter: true, creditsPerMonth: PLANS.starter.aiCredits, creditWindow: { start: STARTER_FROM, resetsAt: null } } : {}),
      active: false,
      paused: 'plan',
      // a brand-new sign-up has no plan yet; a plan that ended says so
      banner: ended != null || (acct && !['none'].includes(acct.status)) ? 'plan_ended' : null,
      tier: 'none',
      status: acct?.status ?? 'none',
      source: acct?.source ?? null,
      businessLimit: 1,
      ...(fresh ? {} : { creditsPerMonth: 0 }),
      features: { ...featuresOf(PLANS.plans.launch), adsLaunch: false },
      ...(ended != null ? { pagesServeUntil: iso(ended + PLANS.pagesAfterCancelDays * DAY_MS), dataKeptUntil: iso(ended + PLANS.dataAfterCancelDays * DAY_MS) } : {}),
    });
  }

  const keep = acct.tier_keep && ms(acct.tier_keep_until) != null && ms(acct.tier_keep_until) > now ? acct.tier_keep : null;
  const tier = keep ?? acct.tier;
  const plan = planFor(tier);
  const status = acct.status;
  const trialEnds = ms(acct.trial_ends_at);
  const trialSoon = trialEnds != null && trialEnds > now && trialEnds - now <= 7 * DAY_MS;
  // a card trial (Stripe): the last few days are "ending soon"
  const cardTrial = acct.source === 'stripe' && acct.status === 'trialing' && trialEnds != null && trialEnds > now;
  const cardTrialSoon = cardTrial && trialEnds - now <= PLANS.cardTrial.endingSoonDays * DAY_MS;
  let active = false;
  let paused = 'plan';
  let banner = null;
  let graceUntil = null;
  let endedAt = ms(acct.ended_at);

  if (acct.source === 'comp') {
    const until = ms(acct.comp_until);
    if (['active', 'trialing'].includes(status) && (until == null || until > now)) {
      active = true;
      paused = null;
      banner = trialSoon || (until != null && until - now <= 7 * DAY_MS) ? 'trial_ending' : null;
    } else {
      banner = 'plan_ended';
      endedAt ??= until;
    }
  } else if (status === 'active' || status === 'trialing') {
    active = true;
    paused = null;
    banner = acct.cancel_at_period_end ? 'cancel_at_period_end' : cardTrial ? (cardTrialSoon ? 'trial_ending' : 'trial') : status === 'trialing' && trialSoon ? 'trial_ending' : null;
  } else if (status === 'past_due') {
    // no grace date recorded (a missed failure event): 7 days after the period's end
    graceUntil = ms(acct.grace_until) ?? (ms(acct.current_period_end) != null ? ms(acct.current_period_end) + PLANS.graceDays * DAY_MS : now + PLANS.graceDays * DAY_MS);
    if (now < graceUntil) {
      active = true;
      paused = null;
      banner = 'grace';
    } else {
      paused = 'payment';
      banner = 'payment';
    }
  } else if (status === 'unpaid' || status === 'paused') {
    paused = 'payment';
    banner = 'payment';
  } else if (status === 'incomplete') {
    paused = 'plan';
  } else {
    paused = 'plan';
    banner = 'plan_ended';
  }

  const limit = acct.business_limit == null ? null : Math.max(1, Number(acct.business_limit));
  const extras = limit == null ? 0 : limit - 1;
  return BASE(tier, {
    active,
    paused,
    banner,
    tier,
    status,
    source: acct.source,
    // past due after grace keeps its businesses (slots aren't locked); unpaid and ended plans keep one
    businessLimit: active || (paused === 'payment' && status === 'past_due') ? limit : 1,
    // a card trial: the trial's allowance for the whole trial, whatever the tier
    creditsPerMonth: active ? (cardTrial ? PLANS.cardTrial.aiCredits : creditsFor(tier, extras)) : 0,
    creditWindow: cardTrial ? { start: iso(ms(acct.current_period_start) ?? ms(acct.created_at) ?? now), resetsAt: iso(trialEnds) } : creditWindow(acct, now),
    trial: cardTrial,
    trialDaysLeft: cardTrial ? Math.max(0, Math.ceil((trialEnds - now) / DAY_MS)) : null,
    features: featuresOf(plan),
    graceUntil: iso(graceUntil),
    trialEndsAt: iso(trialEnds),
    pagesServeUntil: !active && endedAt != null ? iso(endedAt + PLANS.pagesAfterCancelDays * DAY_MS) : null,
    dataKeptUntil: !active && endedAt != null ? iso(endedAt + PLANS.dataAfterCancelDays * DAY_MS) : null,
  });
}

/** The error a paused entitlement answers a paid action with: [status, code, message]. */
export function pausedError(ent) {
  if (ent?.paused === 'payment') return [402, 'PAYMENT_REQUIRED', 'Your last payment didn’t go through. Update your card in Billing to keep going.'];
  return [402, 'PLAN_REQUIRED', 'This needs a plan. Choose one to keep going.'];
}
