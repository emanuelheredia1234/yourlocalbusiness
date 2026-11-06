// Plans and billing with Stripe (docs/integrations-setup.md "Plans and billing"): Checkout, the Customer Portal,
// extra businesses, plan changes, the webhook, the cron jobs and account deletion. Mounted by server/billing/routes.mjs
// (the /api/billing/* routes below) and server/integrations/wiring.mjs (the webhook, and `billing` for the gates).
//
//   GET  /api/billing/plan[?session_id=cs_…]         the plan, businesses and credits (adopts a finished Checkout)
//   POST /api/billing/plan {tier, interval, clientRequestId, confirm}       change the plan of a live subscription
//   POST /api/billing/checkout {tier, interval, extraBusinesses?, clientRequestId}   → {url}
//   POST /api/billing/portal {clientRequestId}       → {url} (card, invoices, cancel at period end)
//   GET  /api/billing/businesses                      limit, slots, pending removal, the op in flight
//   POST /api/billing/businesses {action: add|remove|undo_remove, clientRequestId, confirm, projectId?}
//   PUT  /api/billing/businesses/active {projectIds}  which businesses stay active when over the limit
//   POST /api/billing/cancel {reason, comment?, offer?, clientRequestId, confirm}   the cancel survey, then cancel at
//                                                     the period's end (a trial: before day 8, so nothing is charged)
//   POST /api/billing/cancel/survey {reason, comment?, offer, outcome: kept|switched}   the survey of someone who took
//                                                     the alternative instead (nothing changes in Stripe)
//   POST /api/billing/resume {clientRequestId, confirm}   keep the plan after all (undo cancel at period end)
//   owner: GET /api/billing/accounts, PUT /api/billing/accounts/:tag/comp, POST /api/billing/accounts/:tag/sync,
//          GET|PUT /api/billing/settings {enforce?, cardTrialDays?, existingTrialDays?},
//          GET /api/billing/surveys  (why people cancel: counts by reason, recent comments; trials)
//   POST /api/webhooks/stripe                         Stripe's events (signature on the raw body)
//
// Money rules (each one is a test in stripe.test.mjs):
// - Every Stripe write carries a fixed Idempotency-Key built from the user and the app's clientRequestId (a double
//   click or a browser retry reaches Stripe as the same request) and is sent ONCE: a timeout or 5xx marks the op
//   'unknown' and the subscription is READ back; nothing is ever resent by the server.
// - At most one money op in flight per user (billing_ops_one_live): a second answers 409 BILLING_PENDING.
// - An added business exists only once Stripe says it's paid (error_if_incomplete): the applied subscription raises the
//   limit, then the app claims the slot.
// - The webhook verifies the signature on the raw bytes, dedupes in webhook_deliveries, re-fetches the subscription
//   instead of trusting the payload, and answers 2xx only after processing (500 → Stripe delivers it again).
// - STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are read from env only, never logged or returned (the owner sees the
//   last 4). Stripe's text never reaches a customer; platform problems go to the owner as `hint` and safeLog.
// - The owner (server/auth.mjs isAdmin) is on the 'owner' plan: no Stripe Customer is ever made for them.
// - The card trial (billing_settings.card_trial_days, 7 by default) is offered once per person: never to someone who
//   had a plan, a free plan or a trial, nor to an email or card a trial was already on (keyed hashes in
//   billing_trials). A second trial that slips through Checkout (another account, the same card) is ended at once:
//   one write, Idempotency-Key per subscription, never resent (an unclear answer is read back).

import crypto from 'node:crypto';
import { createStripeClient, StripeError } from './stripeClient.mjs';
import { createBillingStore, emptyAccount, BILLING_MIGRATION } from './accounts.mjs';
import { entitlementOf, pausedError } from './entitlement.mjs';
import { PLANS, PRICE_TABLE, isInterval, isTier, lookupKeyFor, lookupKeysAll, planFor, tierRank, usdToCredits, isBusinessLookupKey, tierFromLookupKey } from './plans.mjs';
import { customerTag, errorBody, fail, IntegrationError, isUuid, mask, notSetUp, safeLog, sha256 } from '../integrations/common.mjs';

const DAY_MS = 86_400_000;
const TAG = /^cust_[0-9a-f]{24}$/;
const SESSION_ID = /^cs_[A-Za-z0-9_]{6,200}$/;
const SUB_ID = /^sub_[A-Za-z0-9_]{6,200}$/;
const EVENT_ID = /^evt_[A-Za-z0-9]+$/;
const LIVE_STATUSES = ['trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused'];
const ENDED_STATUSES = ['canceled', 'incomplete_expired'];
const PRICE_TTL_MS = 10 * 60_000;
const ENT_TTL_MS = 30_000;
const OP_RECHECK_MS = 60_000;
const OP_GIVE_UP_MS = 10 * 60_000;
/** An op still 'sending' this long after it started lost its process (a crash or a failed write of the outcome): it's
 * read back like an 'unknown' one. Well past the write timeout (30 s), so a write still on its way is never raced. */
const OP_STALE_SENDING_MS = 2 * 60_000;
/** An active slot with no business saved this long after its claim (an abandoned setup) goes back to the plan. */
const ORPHAN_SLOT_MS = 24 * 3_600_000;
const SIGNATURE_TOLERANCE_S = 300;
/** The events the webhook acts on (the rest answer 200 and are ignored). */
export const STRIPE_EVENTS = Object.freeze(['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed', 'invoice.payment_action_required']);
/** /api/billing/<sub> paths this module answers. */
export const STRIPE_ROUTES = /^(plan|checkout|portal|businesses|businesses\/active|cancel|cancel\/survey|resume|surveys|accounts|accounts\/[^/]+\/(comp|sync)|settings)$/;
/** The cancel survey's reasons (the app's), and the alternative each one offers (never blocking the cancel). */
export const CANCEL_REASONS = Object.freeze(['too_expensive', 'not_using', 'missing_feature', 'results', 'switching', 'too_hard', 'short_term', 'other']);
export const CANCEL_OFFERS = Object.freeze(['cheaper_plan', 'tips', 'tell_feature', 'none']);
/** Our reason → Stripe's cancellation_details.feedback. */
const FEEDBACK_OF = Object.freeze({ too_expensive: 'too_expensive', not_using: 'unused', missing_feature: 'missing_features', results: 'low_quality', switching: 'switched_service', too_hard: 'too_complex', short_term: 'other', other: 'other' });
/** Stripe's feedback (the Customer Portal's survey) → our reason. */
const REASON_OF = Object.freeze({ too_expensive: 'too_expensive', unused: 'not_using', missing_features: 'missing_feature', low_quality: 'results', switched_service: 'switching', too_complex: 'too_hard', customer_service: 'other', other: 'other' });

const MSG = Object.freeze({
  notReady: 'Plans aren’t available yet.',
  pending: 'We’re confirming your last change. This takes a minute.',
  confirming: 'We’re confirming your payment. This takes a minute.',
  declined: 'Your card was declined. Update it in Billing, then try again.',
  payment: 'Your last payment didn’t go through. Update your card in Billing to keep going.',
  planRequired: 'This needs a plan. Choose one to keep going.',
  already: 'You already have a plan. Change it in Settings › Plan.',
  owner: 'You’re on the owner plan.',
  unavailable: 'Billing is unavailable right now. Try again in a minute.',
  notOnPlan: 'Your plan is managed by us. Contact support to change it.',
  cancelLater: 'We couldn’t cancel your subscription just now. Try again shortly.',
  noTrial: 'This plan starts today: free trials are for first plans only.',
});

/** A timing-safe check of a Stripe-Signature header against one secret: any v1 matches and t is recent. */
export function verifyStripeSignature(raw, header, secret, nowMs = Date.now(), toleranceSec = SIGNATURE_TOLERANCE_S) {
  if (!secret) return false;
  const parts = String(header ?? '').split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => String(v ?? ''));
  if (!Number.isFinite(t) || !sigs.length) return false;
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return false;
  const want = crypto.createHmac('sha256', String(secret)).update(`${t}.`).update(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw))).digest();
  return sigs.some((s) => {
    if (!/^[0-9a-f]{64}$/i.test(s)) return false;
    const got = Buffer.from(s, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
}

/** A UUID made from text (for an op the server starts itself, e.g. the cancel on account deletion). */
const uuidFrom = (text) => {
  const h = sha256(text);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const secToIso = (s) => (Number.isFinite(Number(s)) && Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null);
const ms = (v) => (v == null ? null : Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const int = (v) => (Number.isInteger(v) ? v : null);

/** The tier item and the additional-business item of a subscription (by price lookup key). */
export function subscriptionItems(sub) {
  const items = Array.isArray(sub?.items?.data) ? sub.items.data : [];
  const tierItem = items.find((i) => tierFromLookupKey(i?.price?.lookup_key)) ?? null;
  const businessItem = items.find((i) => isBusinessLookupKey(i?.price?.lookup_key)) ?? null;
  const unknown = items.filter((i) => !PRICE_TABLE[i?.price?.lookup_key]);
  return { items, tierItem, businessItem, unknown };
}

export function createStripeBilling({
  db,
  env = process.env,
  fetch = globalThis.fetch,
  now = () => Date.now(),
  log = console,
  readJson,
  readRaw,
  limit = () => false,
  clientKey = (req) => req.socket?.remoteAddress || 'unknown',
  emailFor = async () => '',
  caps = null,
  stripe: stripeOverride = null,
  store: storeOverride = null,
} = {}) {
  const stripe = stripeOverride ?? createStripeClient({ env, fetch });
  const store = storeOverride ?? createBillingStore({ db, env, now, log });
  const iso = (t = now()) => new Date(t).toISOString();
  const webhookSecrets = () => [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_PREVIOUS].map((s) => String(s ?? '').trim()).filter(Boolean);
  const appUrl = () => String(env.APP_URL || env.GSC_APP_PROPERTY || '').trim().replace(/\/+$/, '');
  const alert = (event, fields = {}) => safeLog(`billing_alert_${event}`, fields, log);

  /** What's missing for Stripe billing, by Secret name (empty when ready). */
  function missing() {
    const out = [];
    if (!stripe.enabled) out.push(stripe.baseRefused ? 'STRIPE_SECRET_KEY (a test key: STRIPE_API_BASE is only for test keys)' : 'STRIPE_SECRET_KEY');
    if (!webhookSecrets().length) out.push('STRIPE_WEBHOOK_SECRET');
    if (String(env.CUSTOMER_TAG_SECRET || '').length < 16) out.push('CUSTOMER_TAG_SECRET');
    if (!db?.enabled) out.push(`SUPABASE_URL and SUPABASE_SECRET_KEY (and ${BILLING_MIGRATION})`);
    return out;
  }
  const configured = () => missing().length === 0;
  const notReady = () => notSetUp(`Plans need these in Replit Secrets: ${missing().join(', ')}.`, MSG.notReady);

  // ───────────── entitlement ─────────────

  const entCache = new Map(); // user id → { value, until }
  let lastSettings = null;
  let lastSettingsAt = 0;
  const forgetCache = (userId) => entCache.delete(userId);

  async function settings() {
    if (!db?.enabled) return { enforce: false, missing: true };
    lastSettings = await store.settings();
    lastSettingsAt = now();
    return lastSettings;
  }

  const ownerChecked = new Map(); // user id → until (the owner row was made, or a removed admin's dropped)

  /**
   * The owner's row is made the first time any gated request of theirs is seen (so a gate that only knows the user id,
   * e.g. Upload-Post's cap or a cron job, sees the owner plan too); someone who signs in and is no longer an admin has
   * a stale owner row dropped (owner rights come from server/auth.mjs isAdmin, never from the row alone).
   */
  async function checkOwnerRow(userId, who) {
    if (!userId || !who || typeof who.isAdmin !== 'boolean') return;
    const hit = ownerChecked.get(userId);
    if (hit && hit.until > now() && hit.admin === who.isAdmin) return;
    try {
      if (who.isAdmin) await ensureOwner(userId);
      else {
        const acct = await store.account(userId);
        if (acct?.source === 'owner') await dropOwner(userId, acct);
      }
      ownerChecked.set(userId, { admin: who.isAdmin, until: now() + 10 * 60_000 });
      if (ownerChecked.size > 10_000) ownerChecked.delete(ownerChecked.keys().next().value);
    } catch (e) {
      safeLog('billing_owner_row_failed', { code: e?.code }, log);
    }
  }

  /** The user's entitlement (cached 30 s). who: the signed-in user ({ isAdmin }). */
  async function entitlement(userId, who = null) {
    const s = await settings();
    if (s.enforce !== true) return entitlementOf(null, s, now());
    await checkOwnerRow(userId, who);
    if (who?.isAdmin === true) return entitlementOf(null, s, now(), { isAdmin: true });
    if (!userId) return entitlementOf(null, s, now());
    const hit = entCache.get(userId);
    if (hit && hit.until > now()) return hit.value;
    const value = entitlementOf(await store.account(userId), s, now());
    entCache.set(userId, { value, until: now() + ENT_TTL_MS });
    if (entCache.size > 10_000) entCache.delete(entCache.keys().next().value);
    return value;
  }

  /** Throws 402 PLAN_REQUIRED / PAYMENT_REQUIRED when the user's plan is paused (a no-op when not enforced/owner). */
  async function requireActive(who, feature = null) {
    if (!who?.id) return null;
    const ent = await entitlement(who.id, who);
    if (ent.active) return ent;
    const [status, code, message] = pausedError(ent);
    throw fail(status, code, message, { need: { feature, ...(ent.paused === 'plan' ? { tier: 'launch' } : {}) }, upgrade: '#plans' });
  }

  /**
   * Throws 402 BUSINESS_LIMIT ({locked: true}) when this business is locked on the user's plan (over the limit: removed at renewal, a
   * smaller plan). A no-op when plans aren't enforced, for the owner, without a project id or a slot row. Cached 30 s.
   */
  const slotCache = new Map();
  async function requireSlot(who, projectId) {
    if (!who?.id || projectId == null || projectId === '') return;
    const ent = await entitlement(who.id, who);
    if (ent.plan === 'legacy' || ent.plan === 'owner') return;
    const key = `${who.id}:${projectId}`;
    let hit = slotCache.get(key);
    if (!hit || hit.until <= now()) {
      const [row] = await db.select('project_slots', { user_id: who.id, project_id: String(projectId) }, { select: 'state', limit: 1 });
      hit = { state: row?.state ?? null, until: now() + ENT_TTL_MS };
      slotCache.set(key, hit);
      if (slotCache.size > 10_000) slotCache.delete(slotCache.keys().next().value);
    }
    // BUSINESS_LIMIT: the app's upgrade prompt offers Add a business / Settings › Plan
    if (hit.state === 'locked') throw fail(402, 'BUSINESS_LIMIT', 'This business is paused on your plan. Add a business, or choose which ones stay active in Settings › Plan.', { locked: true, upgrade: '#workspace-settings' });
  }

  /** The user's business limit for Upload-Post's cap: null = not enforced (use the env cap), 1000 for the owner. */
  async function businessLimit(userId, who = null) {
    const ent = await entitlement(userId, who);
    if (ent.plan === 'legacy') return null;
    if (ent.plan === 'owner') return 1000;
    if (!ent.active) return 0;
    return ent.businessLimit ?? 1000;
  }

  /**
   * The treg caps of a customer's plan ({ monthly_cap_micro, daily_cap_micro }) for server/billing/caps.mjs, or null
   * (plans not enforced, the owner, no plan). A paused plan keeps its layer: the analytics route refuses it.
   */
  async function tregCapsFor(tag) {
    if (!TAG.test(String(tag ?? '')) || !db?.enabled) return null;
    const s = await settings();
    if (s.enforce !== true) return null;
    const [acct] = await db.select('billing_accounts', { customer_tag: tag }, { limit: 1 });
    if (!acct) return null;
    const ent = entitlementOf(acct, s, now());
    const t = ent.features?.treg;
    if (ent.plan === 'owner' || ent.plan === 'none' || !t) return null;
    return { monthly_cap_micro: t.monthlyMicro, daily_cap_micro: t.dailyMicro };
  }

  /** Until when a user's published pages keep serving (null: no end). Fail-open: errors and not enforced → null. */
  const pagesCache = new Map();
  async function pagesServeUntil(userId) {
    const hit = pagesCache.get(userId);
    if (hit && hit.until > now()) return hit.value;
    let value = null;
    try {
      const ent = await entitlement(userId);
      value = ent.plan === 'legacy' || ent.plan === 'owner' || ent.active ? null : ent.pagesServeUntil;
      // a plan that never existed (a page published before plans) keeps serving
    } catch {
      value = null;
    }
    pagesCache.set(userId, { value, until: now() + 10 * 60_000 });
    if (pagesCache.size > 10_000) pagesCache.delete(pagesCache.keys().next().value);
    return value;
  }

  // ───────────── Stripe reads ─────────────

  let priceCache = null; // { byKey, until }
  async function prices() {
    if (priceCache && priceCache.until > now()) return priceCache.byKey;
    const keys = lookupKeysAll();
    const got = await stripe.get('/v1/prices', { 'lookup_keys[]': keys, active: 'true', limit: 100 });
    const byKey = {};
    for (const p of Array.isArray(got?.data) ? got.data : []) {
      const want = PRICE_TABLE[p.lookup_key];
      if (!want) continue;
      if (p.unit_amount !== want.amount || String(p.currency).toLowerCase() !== PLANS.currency || p.recurring?.interval !== want.interval) {
        alert('price_mismatch', { lookupKey: p.lookup_key });
        continue;
      }
      byKey[p.lookup_key] = p;
    }
    priceCache = { byKey, until: now() + PRICE_TTL_MS };
    return byKey;
  }
  async function priceId(lookupKey) {
    const p = (await prices())[lookupKey];
    if (!p) {
      priceCache = null;
      throw notSetUp('A plan price is missing in Stripe. Run npm run stripe:setup (dry run first).', MSG.notReady);
    }
    return p.id;
  }

  const getSubscription = (id) => stripe.get(`/v1/subscriptions/${encodeURIComponent(id)}`);

  // ───────────── applying what Stripe says ─────────────

  /**
   * The billing_accounts fields a subscription gives (the read happened at `fetchedAt`). opts: extraKeep {count, until}
   * | 'clear', tierKeep {tier, until} | 'clear', failed (a payment just failed). Returns { patch } or { refused }.
   */
  function rowFromSubscription(acct, sub, { extraKeep = null, tierKeep = null, failed = false } = {}) {
    const { tierItem, businessItem, unknown } = subscriptionItems(sub);
    if (unknown.length) alert('stripe_unknown_price', { count: unknown.length });
    const tier = tierFromLookupKey(tierItem?.price?.lookup_key) ?? (acct.tier && acct.tier !== 'owner' ? acct.tier : 'none');
    const interval = tierItem?.price?.recurring?.interval ?? acct.interval ?? null;
    const extra = Math.max(0, Number(businessItem?.quantity ?? 0) || 0);
    const t = now();
    const periodStart = secToIso(tierItem?.current_period_start ?? sub.current_period_start);
    const periodEnd = secToIso(tierItem?.current_period_end ?? sub.current_period_end);
    let keepCount = acct.extra_keep ?? 0;
    let keepUntil = acct.extra_keep_until ?? null;
    if (extraKeep === 'clear' || (keepUntil && ms(keepUntil) <= t)) {
      keepCount = 0;
      keepUntil = null;
    } else if (extraKeep) {
      keepCount = extraKeep.count;
      keepUntil = extraKeep.until;
    }
    let tierKeepV = acct.tier_keep ?? null;
    let tierKeepUntil = acct.tier_keep_until ?? null;
    if (tierKeep === 'clear' || (tierKeepUntil && ms(tierKeepUntil) <= t)) {
      tierKeepV = null;
      tierKeepUntil = null;
    } else if (tierKeep) {
      tierKeepV = tierKeep.tier;
      tierKeepUntil = tierKeep.until;
    }
    if (tierKeepV && tierRank(tierKeepV) <= tierRank(tier)) {
      tierKeepV = null;
      tierKeepUntil = null;
    }
    const compExtra = acct.source === 'stripe' ? acct.comp_extra ?? 0 : 0;
    const status = String(sub.status || 'none');
    const grace = ['active', 'trialing'].includes(status) ? null : acct.grace_until ?? (status === 'past_due' || failed ? iso(t + PLANS.graceDays * DAY_MS) : null);
    return {
      customer_tag: acct.customer_tag,
      source: 'stripe',
      tier,
      interval,
      status,
      stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? acct.stripe_customer_id ?? null,
      stripe_subscription_id: sub.id,
      tier_item_id: tierItem?.id ?? null,
      business_item_id: businessItem?.id ?? null,
      extra_businesses: extra,
      comp_extra: compExtra,
      business_limit: 1 + Math.max(extra, keepUntil ? keepCount : 0) + compExtra,
      extra_keep: keepUntil ? keepCount : 0,
      extra_keep_until: keepUntil,
      tier_keep: tierKeepV,
      tier_keep_until: tierKeepUntil,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      billing_anchor: secToIso(sub.billing_cycle_anchor) ?? acct.billing_anchor ?? periodStart,
      cancel_at_period_end: sub.cancel_at_period_end === true,
      canceled_at: secToIso(sub.canceled_at),
      ended_at: secToIso(sub.ended_at),
      trial_ends_at: secToIso(sub.trial_end),
      grace_until: grace,
      comp_until: null,
      comp_note: null,
      checkout_session_id: null,
      checkout_expires_at: null,
    };
  }

  /**
   * Apply a subscription read from Stripe to the user's account (older reads never overwrite newer ones). A second
   * live subscription is never adopted over the one the account holds (owner alert). → { applied, refused? }
   */
  async function applySubscription(userId, sub, fetchedAt, opts = {}) {
    if (!sub || typeof sub !== 'object' || !SUB_ID.test(String(sub.id ?? ''))) return { applied: false, refused: 'bad_subscription' };
    const acct = await store.ensureAccount(userId);
    if (acct.source === 'owner') return { applied: false, refused: 'owner' };
    // a free plan the owner gave is only replaced by a plan the customer buys, never by an old subscription's end
    if (acct.source === 'comp' && ENDED_STATUSES.includes(String(sub.status))) return { applied: false, refused: 'comp' };
    const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    if (acct.stripe_customer_id && customer && customer !== acct.stripe_customer_id) {
      alert('stripe_customer_mismatch', { tag: acct.customer_tag });
      return { applied: false, refused: 'customer' };
    }
    if (acct.stripe_subscription_id && acct.stripe_subscription_id !== sub.id) {
      const heldLive = acct.source === 'stripe' && LIVE_STATUSES.includes(acct.status);
      const incomingLive = !ENDED_STATUSES.includes(sub.status);
      if (heldLive && incomingLive) {
        alert('stripe_second_subscription', { tag: acct.customer_tag });
        return { applied: false, refused: 'second_subscription' };
      }
      // an old, ended subscription never replaces the one the account holds
      if (!incomingLive) return { applied: false, refused: 'old_subscription' };
    }
    const patch = rowFromSubscription(acct, sub, opts);
    const wrote = await store.apply(userId, patch, iso(fetchedAt));
    forgetCache(userId);
    pagesCache.delete(userId);
    // the card trial (once per subscription) and a Customer Portal cancel's survey answer
    if (!opts.skipTrial && (sub.status === 'trialing' || sub.trial_end)) await noteTrial(userId, sub);
    if (sub.cancel_at_period_end === true || sub.status === 'canceled') await notePortalCancel(userId, sub, acct);
    if (wrote && patch.tier !== acct.tier) {
      try {
        await caps?.syncToTreg?.(acct.customer_tag);
      } catch {
        /* best effort: synced_to_treg_at shows it */
      }
    }
    return { applied: wrote, account: { ...acct, ...patch } };
  }

  /** GET the subscription now and apply it. */
  async function syncSubscription(userId, subId, opts = {}) {
    const sub = await getSubscription(subId);
    const fetchedAt = now();
    return { sub, ...(await applySubscription(userId, sub, fetchedAt, opts)) };
  }

  /** The Owner plan row (no Stripe call, ever). */
  async function ensureOwner(userId) {
    const acct = await store.ensureAccount(userId);
    if (acct.source === 'owner' && acct.business_limit == null) return acct;
    if (acct.stripe_subscription_id && LIVE_STATUSES.includes(acct.status)) {
      alert('owner_has_subscription', { tag: acct.customer_tag });
      return acct;
    }
    await store.apply(userId, { source: 'owner', tier: 'owner', status: 'active', business_limit: null, comp_extra: 0 }, null);
    forgetCache(userId);
    return { ...acct, source: 'owner', tier: 'owner', status: 'active', business_limit: null };
  }

  /** A former admin's owner row goes back to no plan (their extra businesses lock, as for any plan that ends). */
  async function dropOwner(userId, acct) {
    await store.apply(userId, { source: 'stripe', tier: 'none', interval: null, status: 'none', business_limit: 1, comp_extra: 0, extra_keep: 0, extra_keep_until: null, tier_keep: null, tier_keep_until: null }, null);
    forgetCache(userId);
    pagesCache.delete(userId);
    alert('owner_row_dropped', { tag: acct.customer_tag });
    try {
      await store.applySlots(userId);
    } catch {
      /* the hourly job and the next claim apply it */
    }
  }

  // ───────────── views ─────────────

  async function creditsView(userId, ent) {
    if (ent.creditsPerMonth == null || !ent.creditWindow) return { monthly: ent.creditsPerMonth ?? null, usedCredits: null, resetsAt: null };
    let usd = 0;
    try {
      const rows = await db.select('ai_usage_daily', { user_id: userId, day: ['gte', ent.creditWindow.start.slice(0, 10)] }, { select: 'usd', order: 'day.desc', limit: 400 });
      usd = rows.reduce((n, r) => n + (Number(r.usd) || 0), 0);
    } catch {
      return { monthly: ent.creditsPerMonth, usedCredits: null, resetsAt: ent.creditWindow.resetsAt };
    }
    return { monthly: ent.creditsPerMonth, usedCredits: usdToCredits(usd), resetsAt: ent.creditWindow.resetsAt };
  }

  function accountView(acct) {
    if (!acct) return null;
    const keepOn = acct.extra_keep_until && ms(acct.extra_keep_until) > now() && acct.extra_keep > acct.extra_businesses;
    const downOn = acct.tier_keep && acct.tier_keep_until && ms(acct.tier_keep_until) > now();
    return {
      tier: acct.tier,
      interval: acct.interval ?? null,
      status: acct.status,
      source: acct.source,
      currentPeriodEnd: acct.current_period_end ?? null,
      cancelAtPeriodEnd: acct.cancel_at_period_end === true,
      trialEndsAt: acct.trial_ends_at ?? null,
      trialing: acct.source === 'stripe' && acct.status === 'trialing',
      graceUntil: acct.grace_until ?? null,
      compUntil: acct.comp_until ?? null,
      extraBusinesses: acct.extra_businesses ?? 0,
      pendingRemove: keepOn ? { count: acct.extra_keep - acct.extra_businesses, at: acct.extra_keep_until } : null,
      pendingDowngrade: downOn ? { tier: acct.tier, at: acct.tier_keep_until } : null,
      hasCustomer: !!acct.stripe_customer_id,
    };
  }

  const slotView = (rows) => rows.map((r) => ({ projectId: r.project_id, state: r.state, ...(r.lock_at ? { lockAt: r.lock_at } : {}), ...(r.locked_reason ? { lockedReason: r.locked_reason } : {}) }));
  const opView = (op) => (op ? { id: op.id, kind: op.kind, state: op.state, ...(op.error_code && op.error_code !== 'DRIFT' ? { errorCode: op.error_code } : {}) } : null);

  async function businessesView(userId, who, acct = null) {
    const a = acct ?? (await store.account(userId));
    const ent = await entitlement(userId, who);
    const rows = await store.slots(userId);
    const live = await store.liveOp(userId);
    return {
      limit: ent.plan === 'legacy' || ent.plan === 'owner' ? null : ent.businessLimit,
      used: rows.filter((r) => r.state === 'active').length,
      extraBusinesses: a?.extra_businesses ?? 0,
      pricePerBusiness: { ...PLANS.additionalBusiness.price },
      interval: a?.interval ?? null,
      slots: slotView(rows),
      pendingRemove: accountView(a)?.pendingRemove ?? null,
      op: opView(live ?? null),
    };
  }

  async function planView(userId, who, acct) {
    const s = await settings();
    const ent = await entitlement(userId, who);
    const rows = await store.slots(userId);
    return {
      billing: { enabled: configured(), enforce: s.enforce === true },
      // the card trial offered on #plans and at the end of setup ("Start 7-day free trial")
      trial: who?.isAdmin ? { days: 0, eligible: false } : await trialOffer(userId, who, acct),
      plan: ent,
      account: who?.isAdmin ? { ...(accountView(acct) ?? {}), tier: 'owner', source: 'owner' } : accountView(acct),
      businesses: { limit: ent.plan === 'legacy' || ent.plan === 'owner' ? null : ent.businessLimit, used: rows.filter((r) => r.state === 'active').length, slots: slotView(rows) },
      credits: await creditsView(userId, ent),
    };
  }

  // ───────────── the card trial ─────────────

  /** A keyed hash (CUSTOMER_TAG_SECRET) of an email or a card fingerprint: the same one matches, nothing reads back. */
  const keyedHash = (kind, value) => {
    const v = String(value ?? '').trim().toLowerCase();
    if (!v || String(env.CUSTOMER_TAG_SECRET || '').length < 16) return null;
    return crypto.createHmac('sha256', String(env.CUSTOMER_TAG_SECRET)).update(`ylb-trial:${kind}:${v}`).digest('hex');
  };

  async function trialRows(filter) {
    try {
      return await db.select('billing_trials', filter, { limit: 5 });
    } catch (e) {
      // the P1c migration isn't run: no trial is offered (we couldn't tell a second one)
      if (e?.code === 'NOT_SET_UP') return null;
      throw e;
    }
  }

  /**
   * The card trial this person may start: { days, eligible }. Only a first plan: never after a plan, a free plan or a
   * trial (theirs, or one on the same email), and never for the owner. Fail-closed: no trial when it can't be checked.
   */
  async function trialOffer(userId, who, acct = null) {
    const s = await settings().catch(() => ({}));
    const days = Number(s.card_trial_days) || 0;
    if (!days || who?.isAdmin === true) return { days, eligible: false };
    const a = acct ?? (await store.account(userId).catch(() => null));
    if (a && (a.source !== 'stripe' || a.stripe_subscription_id || a.ended_at || !['none', null, undefined].includes(a.status))) return { days, eligible: false };
    try {
      const mine = await trialRows({ user_id: userId });
      if (!mine || mine.length) return { days, eligible: false };
      const emailHash = keyedHash('email', who?.email);
      if (emailHash) {
        const same = await trialRows({ email_hash: emailHash });
        if (!same || same.length) return { days, eligible: false };
      }
    } catch {
      return { days, eligible: false };
    }
    return { days, eligible: true };
  }

  /**
   * A subscription that is trialing: its trial is recorded once (billing_trials), with the email hash Checkout put in
   * its metadata and the card's fingerprint (hashed). A trial whose person, email or card had one before is ended now:
   * one write (trial_end=now), Idempotency-Key per subscription, an op so it's sent once; an unclear answer is read
   * back by the op's recheck, never resent. Never throws (the plan is applied either way).
   */
  async function noteTrial(userId, sub) {
    try {
      if (!SUB_ID.test(String(sub?.id ?? ''))) return;
      const seen = await trialRows({ subscription_id: sub.id });
      // the P1c migration isn't run: nothing to record (and no trial is offered)
      if (!seen) return;
      const known = seen[0] ?? null;
      if (known && known.outcome !== 'duplicate') return;
      if (sub.status !== 'trialing') {
        if (known?.outcome === 'duplicate') await db.update('billing_trials', { subscription_id: sub.id }, { outcome: 'ended_early', updated_at: iso() });
        return;
      }
      let row = known;
      if (!row) {
        const acct = await store.account(userId);
        let cardHash = null;
        const pmId = typeof sub.default_payment_method === 'string' ? sub.default_payment_method : sub.default_payment_method?.id;
        if (/^pm_[A-Za-z0-9_]+$/.test(String(pmId ?? ''))) {
          try {
            const pm = typeof sub.default_payment_method === 'object' ? sub.default_payment_method : await stripe.get(`/v1/payment_methods/${encodeURIComponent(pmId)}`);
            cardHash = keyedHash('card', pm?.card?.fingerprint);
          } catch {
            cardHash = null;
          }
        }
        const emailHash = /^[0-9a-f]{64}$/.test(String(sub.metadata?.ylb_email_hash ?? '')) ? sub.metadata.ylb_email_hash : null;
        const before = [
          ...((await trialRows({ user_id: userId })) ?? []),
          ...(emailHash ? (await trialRows({ email_hash: emailHash })) ?? [] : []),
          ...(cardHash ? (await trialRows({ card_hash: cardHash })) ?? [] : []),
        ].filter((r) => r.subscription_id !== sub.id);
        const { tierItem } = subscriptionItems(sub);
        row = { subscription_id: sub.id, user_id: userId, customer_tag: acct?.customer_tag ?? customerTag(userId, env), email_hash: emailHash, card_hash: cardHash, tier: tierFromLookupKey(tierItem?.price?.lookup_key), started_at: secToIso(sub.trial_start) ?? iso(), trial_ends_at: secToIso(sub.trial_end), outcome: before.length ? 'duplicate' : 'trialing', updated_at: iso() };
        await db.insert('billing_trials', row, { ignoreDuplicates: true, onConflict: 'subscription_id' });
        if (!before.length) return;
        alert('trial_duplicate', { tag: row.customer_tag });
      }
      await endTrialNow(userId, sub);
    } catch (e) {
      safeLog('billing_trial_note_failed', { code: e?.code, kind: e?.kind }, log);
    }
  }

  /** End a duplicate trial now (charged today), once per subscription. */
  async function endTrialNow(userId, sub) {
    const key = `ylb-trial-end-${sub.id}`;
    const ins = await store.insertOp(userId, { kind: 'end_trial', clientRequestId: uuidFrom(key), request: { subscription: sub.id, from: { status: 'trialing' }, to: { status: 'active' } }, idempotencyKey: key });
    // sent before (this op or its outcome): never again; another op in flight: the next sync tries
    if (!ins.op) return;
    const out = await stripe.post(`/v1/subscriptions/${sub.id}`, { trial_end: 'now', proration_behavior: 'none' }, { idempotencyKey: key });
    if (out.outcome === 'ok') {
      await store.finishOp(ins.op, { state: 'done', stripe_ref: { subscription: sub.id } });
      await db.update('billing_trials', { subscription_id: sub.id }, { outcome: 'ended_early', updated_at: iso() });
      await applySubscription(userId, out.value, now(), { skipTrial: true });
      return;
    }
    if (out.outcome === 'failed') {
      await store.finishOp(ins.op, { state: 'failed', error_code: out.error?.kind === 'card' ? 'CARD_DECLINED' : 'UNAVAILABLE' });
      await db.update('billing_trials', { subscription_id: sub.id }, { outcome: 'end_failed', updated_at: iso() });
      alert('trial_end_failed', { errorKind: out.error?.kind, code: out.error?.code });
      return;
    }
    // no answer: read back later (recheckLiveOp / the hourly job), never resent
    await store.finishOp(ins.op, { state: 'unknown' });
  }

  // ───────────── cancel surveys ─────────────

  const surveyText = (v) => (v == null ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1000) || null);

  async function saveSurvey(row) {
    try {
      await db.insert('cancel_surveys', { id: crypto.randomUUID(), created_at: iso(), ...row }, row.source === 'portal' ? { ignoreDuplicates: true, onConflict: 'subscription_id' } : {});
      return true;
    } catch (e) {
      safeLog('billing_survey_save_failed', { code: e?.code }, log);
      return false;
    }
  }

  /** A cancel made in the Customer Portal: its survey answer (cancellation_details), kept once per subscription. */
  async function notePortalCancel(userId, sub, acct) {
    try {
      const fb = sub?.cancellation_details?.feedback;
      if (!(sub?.cancel_at_period_end === true || sub?.status === 'canceled') || !REASON_OF[fb]) return;
      const mine = await db.select('cancel_surveys', { subscription_id: sub.id }, { select: 'source,outcome', limit: 5 });
      // the app's own cancel wrote its survey (and put the same answer in Stripe): not twice
      if (mine.some((r) => r.source === 'app' && r.outcome === 'cancelled') || mine.some((r) => r.source === 'portal')) return;
      const { tierItem } = subscriptionItems(sub);
      await saveSurvey({ user_id: userId, customer_tag: acct?.customer_tag ?? null, source: 'portal', reason: REASON_OF[fb], comment: surveyText(sub.cancellation_details?.comment), offer: null, outcome: 'cancelled', tier: tierFromLookupKey(tierItem?.price?.lookup_key), status: String(sub.status ?? ''), subscription_id: sub.id });
    } catch (e) {
      safeLog('billing_survey_portal_failed', { code: e?.code }, log);
    }
  }

  function surveyFields(body) {
    const reason = body?.reason;
    if (!CANCEL_REASONS.includes(reason)) throw fail(400, 'BAD_REQUEST', 'Choose why you’re leaving.');
    const offer = body?.offer == null ? 'none' : body.offer;
    if (!CANCEL_OFFERS.includes(offer)) throw fail(400, 'BAD_REQUEST', 'Choose one of the offers.');
    const comment = surveyText(body?.comment);
    return { reason, offer, comment };
  }

  /** The cancel: the survey first, then cancel at the period's end (a trial ends without a charge). */
  async function cancelPlan(who, body) {
    if (body?.confirm !== true) throw fail(400, 'BAD_REQUEST', 'Confirm the change first.');
    const { reason, offer, comment } = surveyFields(body);
    const crid = body?.clientRequestId;
    let saved = false;
    return moneyOp(who, 'cancel', crid, async (sub, acct) => {
      if (sub.cancel_at_period_end === true) throw fail(409, 'BAD_REQUEST', 'Your plan is already set to end.');
      if (!saved) {
        const { tierItem } = subscriptionItems(sub);
        saved = await saveSurvey({ user_id: who.id, customer_tag: acct.customer_tag, source: 'app', reason, comment, offer, outcome: 'cancelled', tier: tierFromLookupKey(tierItem?.price?.lookup_key), status: String(sub.status ?? ''), subscription_id: sub.id });
      }
      return {
        request: { from: { cancel: false }, to: { cancel: true }, reason },
        path: `/v1/subscriptions/${sub.id}`,
        body: { cancel_at_period_end: 'true', cancellation_details: { feedback: FEEDBACK_OF[reason], ...(comment ? { comment } : {}) } },
        key: `ylb-cancel-${who.id}-${crid}`,
      };
    });
  }

  /** Someone answered the survey and took the offer instead (a cheaper plan, tips, telling us the missing feature). */
  async function keepSurvey(who, body) {
    const { reason, offer, comment } = surveyFields(body);
    const outcome = body?.outcome === 'switched' ? 'switched' : 'kept';
    const acct = await store.account(who.id);
    await saveSurvey({ user_id: who.id, customer_tag: acct?.customer_tag ?? null, source: 'app', reason, comment, offer, outcome, tier: isTier(acct?.tier) ? acct.tier : null, status: acct?.status ?? null, subscription_id: acct?.stripe_subscription_id ?? null });
    return { ok: true };
  }

  async function resumePlan(who, body) {
    if (body?.confirm !== true) throw fail(400, 'BAD_REQUEST', 'Confirm the change first.');
    const crid = body?.clientRequestId;
    return moneyOp(who, 'resume', crid, async (sub) => {
      if (sub.cancel_at_period_end !== true) throw fail(409, 'BAD_REQUEST', 'Your plan isn’t set to end.');
      return { request: { from: { cancel: true }, to: { cancel: false } }, path: `/v1/subscriptions/${sub.id}`, body: { cancel_at_period_end: 'false' }, key: `ylb-resume-${who.id}-${crid}` };
    });
  }

  /** Owner: why people cancel (counts by reason, the latest comments) and the trials. */
  async function ownerSurveys(url) {
    const n = Math.min(500, Math.max(1, Math.trunc(Number(url.searchParams.get('limit')) || 200)));
    let rows = [];
    let trials = [];
    try {
      rows = await db.select('cancel_surveys', {}, { order: 'created_at.desc', limit: n });
      trials = await db.select('billing_trials', {}, { order: 'started_at.desc', limit: n });
    } catch (e) {
      if (e?.code === 'NOT_SET_UP') return { missing: 'supabase/migrations/20261114000000_trial_paywall.sql', counts: {}, recent: [], trials: { trialing: 0, endedEarly: 0, duplicates: 0, list: [] } };
      throw e;
    }
    const counts = Object.fromEntries(CANCEL_REASONS.map((r) => [r, { cancelled: 0, kept: 0 }]));
    for (const r of rows) if (counts[r.reason]) counts[r.reason][r.outcome === 'cancelled' ? 'cancelled' : 'kept'] += 1;
    const live = (t) => t.outcome === 'trialing' && ms(t.trial_ends_at) != null && ms(t.trial_ends_at) > now();
    return {
      counts,
      recent: rows.slice(0, 50).map((r) => ({ reason: r.reason, comment: r.comment ?? null, source: r.source, outcome: r.outcome, offer: r.offer ?? null, tier: r.tier ?? null, at: r.created_at, customerTag: r.customer_tag ?? null })),
      trials: {
        trialing: trials.filter(live).length,
        endedEarly: trials.filter((t) => t.outcome === 'ended_early').length,
        duplicates: trials.filter((t) => t.outcome === 'duplicate' || t.outcome === 'ended_early' || t.outcome === 'end_failed').length,
        list: trials.slice(0, 50).map((t) => ({ customerTag: t.customer_tag, tier: t.tier ?? null, startedAt: t.started_at, trialEndsAt: t.trial_ends_at ?? null, outcome: live(t) ? 'trialing' : t.outcome === 'trialing' ? 'ended' : t.outcome })),
      },
    };
  }

  // ───────────── Checkout and the portal ─────────────

  /** Adopt a finished Checkout Session the user came back from (only theirs, only its subscription). */
  async function adoptSession(userId, sessionId, acct) {
    let session;
    try {
      session = await stripe.get(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
    } catch (e) {
      safeLog('billing_session_read_failed', { kind: e?.kind }, log);
      return false;
    }
    if (session?.client_reference_id !== userId) return false;
    const customer = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    if (acct?.stripe_customer_id && customer !== acct.stripe_customer_id) return false;
    if (session.status !== 'complete' || !session.subscription) return false;
    const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
    await syncSubscription(userId, subId);
    return true;
  }

  async function getPlan(who, url) {
    if (who.isAdmin === true) return planView(who.id, who, await ensureOwner(who.id));
    let acct = await store.account(who.id);
    const sessionId = url.searchParams.get('session_id');
    if (sessionId && SESSION_ID.test(sessionId) && configured()) {
      if (await adoptSession(who.id, sessionId, acct)) acct = await store.account(who.id);
    }
    await recheckLiveOp(who.id);
    return planView(who.id, who, acct ?? (await store.account(who.id)));
  }

  async function customerFor(who, acct) {
    if (acct.stripe_customer_id) return acct.stripe_customer_id;
    const out = await stripe.post('/v1/customers', { email: who.email || undefined, metadata: { ylb_user: who.id, customer_tag: acct.customer_tag } }, { idempotencyKey: `ylb-cus-${who.id}` });
    if (out.outcome === 'unknown') throw fail(503, 'BILLING_PENDING', 'Try again in a minute.');
    if (out.outcome !== 'ok' || !/^cus_/.test(String(out.value?.id))) {
      alert('stripe_customer_failed', { kind: out.error?.kind, code: out.error?.code });
      throw fail(503, 'UNAVAILABLE', MSG.unavailable, {}, 'Stripe refused creating a Customer. Check the key’s permissions (Customers: write).');
    }
    try {
      await db.update('billing_accounts', { user_id: who.id }, { stripe_customer_id: out.value.id, updated_at: iso() });
    } catch (e) {
      alert('stripe_customer_store_failed', { code: e?.code });
      throw fail(503, 'UNAVAILABLE', MSG.unavailable);
    }
    return out.value.id;
  }

  /**
   * Expire every open Checkout Session of the customer but `keep` (two open pages could each make a subscription, and
   * Stripe would charge both). Once per session (Idempotency-Key); an unclear answer is read back, never resent.
   * Throws 409 ALREADY_SUBSCRIBED when one was paid meanwhile, 503 when one can't be closed.
   */
  async function expireOpenSessions(userId, customer, wanted) {
    const list = await stripe.get('/v1/checkout/sessions', { customer, status: 'open', limit: 20 });
    const sessions = (Array.isArray(list?.data) ? list.data : []).filter((x) => SESSION_ID.test(String(x?.id ?? '')) && x.status === 'open');
    // the same choice, still good for a while: that page comes back (it may be one whose answer never reached us)
    const keep = sessions.find((x) => x.metadata?.ylb_plan === wanted && x.client_reference_id === userId && x.url && Number(x.expires_at) * 1000 > now() + 60_000) ?? null;
    for (const open of sessions) {
      if (open === keep) continue;
      const out = await stripe.post(`/v1/checkout/sessions/${encodeURIComponent(open.id)}/expire`, {}, { idempotencyKey: `ylb-co-expire-${open.id}` });
      if (out.outcome === 'ok' && out.value?.status === 'expired') continue;
      const now_ = await stripe.get(`/v1/checkout/sessions/${encodeURIComponent(open.id)}`);
      if (now_?.status === 'expired') continue;
      if (now_?.status === 'complete') throw fail(409, 'ALREADY_SUBSCRIBED', MSG.already);
      alert('stripe_checkout_expire_failed', { kind: out.error?.kind, code: out.error?.code });
      throw fail(503, 'UNAVAILABLE', MSG.unavailable);
    }
    return keep;
  }

  async function checkout(who, body) {
    if (who.isAdmin === true) throw fail(409, 'OWNER_PLAN', MSG.owner);
    const tier = body?.tier;
    const interval = body?.interval;
    const crid = body?.clientRequestId;
    if (!isTier(tier) || !isInterval(interval)) throw fail(400, 'BAD_REQUEST', 'Choose Launch, Grow or Scale, monthly or yearly.');
    if (!isUuid(crid)) throw fail(400, 'BAD_REQUEST', 'Refresh the page and try again.');
    const acct0 = await store.ensureAccount(who.id);
    if (acct0.source === 'owner') throw fail(409, 'OWNER_PLAN', MSG.owner);
    // one Checkout at a time per user (two tabs, a double click with two ids): the one-live-op lock
    await recheckLiveOp(who.id);
    const lock = await store.insertOp(who.id, { kind: 'checkout', clientRequestId: uuidFrom(`checkout:${who.id}:${crid}:${now()}`), request: { tier, interval }, idempotencyKey: `ylb-co-${who.id}-${crid}` });
    if (!lock.op) throw fail(409, 'BILLING_PENDING', MSG.pending);
    let result = null;
    try {
      result = await checkoutLocked(who, body, { tier, interval, crid });
      return result;
    } finally {
      await store.finishOp(lock.op, result ? { state: 'done' } : { state: 'failed', error_code: 'CHECKOUT' }).catch(() => {});
    }
  }

  async function checkoutLocked(who, body, { tier, interval, crid }) {
    const acct = await store.ensureAccount(who.id);
    if (acct.source === 'stripe' && acct.stripe_subscription_id && LIVE_STATUSES.includes(acct.status)) throw fail(409, 'ALREADY_SUBSCRIBED', MSG.already);
    const active = (await store.slots(who.id)).filter((r) => r.state === 'active').length;
    let extra = body.extraBusinesses;
    if (extra === undefined || extra === null) extra = Math.max(0, active - 1);
    if (!Number.isInteger(extra) || extra < 0 || extra > 50) throw fail(400, 'BAD_REQUEST', 'Choose between 0 and 50 extra businesses.');
    // the database may be behind Stripe: any subscription that isn't over refuses a second one
    if (acct.stripe_customer_id) {
      const list = await stripe.get('/v1/subscriptions', { customer: acct.stripe_customer_id, status: 'all', limit: 20 });
      if ((list?.data ?? []).some((s) => !ENDED_STATUSES.includes(s.status))) throw fail(409, 'ALREADY_SUBSCRIBED', MSG.already);
    }
    const wanted = `${tier}:${interval}:${extra}`;
    // (an open session for the same choice is handed back as is: it was made with the same trial offer)
    // one open session at a time: the same choice gets the same page back, any other open page closes first (so only
    // one can ever be paid). Every session is made with the customer, so the customer's list has them all.
    if (acct.stripe_customer_id) {
      const keep = await expireOpenSessions(who.id, acct.stripe_customer_id, wanted);
      if (keep) return { url: keep.url };
    }
    const base = appUrl();
    if (!base) throw notSetUp('Add APP_URL (the app’s https address) in Replit Secrets.', MSG.notReady);
    const customer = await customerFor(who, acct);
    const tierPrice = await priceId(lookupKeyFor(tier, interval));
    const lineItems = [{ price: tierPrice, quantity: 1 }];
    if (extra > 0) lineItems.push({ price: await priceId(lookupKeyFor('business', interval)), quantity: extra });
    // the card trial: a first plan only, once per person (and their email); the card is taken now, charged on day 8
    const offer = await trialOffer(who.id, who, acct);
    const trialDays = offer.eligible ? offer.days : 0;
    const emailHash = keyedHash('email', who.email);
    const expiresAt = Math.floor(now() / 1000) + 31 * 60;
    const params = {
      mode: 'subscription',
      customer,
      client_reference_id: who.id,
      line_items: lineItems,
      metadata: { ylb_user: who.id, ylb_plan: wanted },
      subscription_data: {
        metadata: { ylb_user: who.id, ...(emailHash ? { ylb_email_hash: emailHash } : {}) },
        ...(trialDays ? { trial_period_days: trialDays, trial_settings: { end_behavior: { missing_payment_method: 'cancel' } } } : {}),
      },
      ...(trialDays ? { payment_method_collection: 'always' } : {}),
      allow_promotion_codes: 'false',
      success_url: `${base}/?billing=success&session_id={CHECKOUT_SESSION_ID}#dashboard`,
      cancel_url: `${base}/#plans`,
      ...(String(env.STRIPE_AUTOMATIC_TAX ?? '') === '1' ? { automatic_tax: { enabled: 'true' } } : {}),
      expires_at: expiresAt,
    };
    const out = await stripe.post('/v1/checkout/sessions', params, { idempotencyKey: `ylb-co-${who.id}-${crid}` });
    if (out.outcome === 'unknown') throw fail(503, 'BILLING_PENDING', 'Try again in a minute.');
    if (out.outcome !== 'ok' || !out.value?.url) {
      if (out.error?.type === 'idempotency_error') throw fail(400, 'BAD_REQUEST', 'Refresh the page and try again.');
      alert('stripe_checkout_failed', { kind: out.error?.kind, code: out.error?.code });
      throw fail(503, 'UNAVAILABLE', MSG.unavailable);
    }
    try {
      await db.update('billing_accounts', { user_id: who.id }, { checkout_session_id: out.value.id, checkout_expires_at: secToIso(out.value.expires_at ?? expiresAt), updated_at: iso() });
    } catch {
      /* the session still works; the next Checkout finds it by the customer and closes it */
    }
    return { url: out.value.url };
  }

  async function portal(who, body) {
    if (who.isAdmin === true) throw fail(409, 'OWNER_PLAN', MSG.owner);
    if (!isUuid(body?.clientRequestId)) throw fail(400, 'BAD_REQUEST', 'Refresh the page and try again.');
    const acct = await store.account(who.id);
    if (acct?.source === 'owner') throw fail(409, 'OWNER_PLAN', MSG.owner);
    if (!acct?.stripe_customer_id) throw fail(409, 'PLAN_REQUIRED', MSG.planRequired, { upgrade: '#plans' });
    const base = appUrl();
    if (!base) throw notSetUp('Add APP_URL (the app’s https address) in Replit Secrets.', MSG.notReady);
    const config = String(env.STRIPE_PORTAL_CONFIGURATION ?? '').trim();
    const out = await stripe.post('/v1/billing_portal/sessions', { customer: acct.stripe_customer_id, return_url: `${base}/#workspace-settings`, ...(config ? { configuration: config } : {}) }, { idempotencyKey: `ylb-portal-${who.id}-${body.clientRequestId}` });
    if (out.outcome === 'unknown') throw fail(503, 'BILLING_PENDING', 'Try again in a minute.');
    if (out.outcome !== 'ok' || !out.value?.url) {
      alert('stripe_portal_failed', { kind: out.error?.kind, code: out.error?.code });
      throw fail(503, 'UNAVAILABLE', MSG.unavailable, {}, 'Stripe refused a Customer Portal session. Check the portal is set up (Settings → Billing → Customer portal) and STRIPE_PORTAL_CONFIGURATION.');
    }
    return { url: out.value.url };
  }

  // ───────────── money operations ─────────────

  /** Whether an op's target is visible on the subscription: 'to' | 'from' | 'drift'. */
  function opStateOn(op, sub) {
    const req = op.request ?? {};
    if (op.kind === 'cancel_for_delete') return sub.status === 'canceled' ? 'to' : 'from';
    if (op.kind === 'cancel') return sub.cancel_at_period_end === true || sub.status === 'canceled' ? 'to' : 'from';
    if (op.kind === 'resume') return sub.cancel_at_period_end === true ? 'from' : 'to';
    if (op.kind === 'end_trial') return sub.status === 'trialing' ? 'from' : 'to';
    const { tierItem, businessItem } = subscriptionItems(sub);
    if (op.kind === 'change_plan') {
      const key = tierItem?.price?.lookup_key;
      if (key === req.to?.lookupKey) return 'to';
      if (key === req.from?.lookupKey) return 'from';
      return 'drift';
    }
    const qty = Number(businessItem?.quantity ?? 0);
    if (qty === req.to?.qty) return 'to';
    if (qty === req.from?.qty) return 'from';
    return 'drift';
  }

  /** The extra businesses / the tier kept to the end of a period already paid for, while that's still on. */
  const liveExtraKeep = (acct) => (acct?.extra_keep_until && ms(acct.extra_keep_until) > now() && acct.extra_keep > 0 ? { count: acct.extra_keep, until: acct.extra_keep_until } : null);
  const liveTierKeep = (acct) => (acct?.tier_keep && acct.tier_keep_until && ms(acct.tier_keep_until) > now() ? { tier: acct.tier_keep, until: acct.tier_keep_until } : null);

  /** What an op does to our own fields once it's done (a removal keeps the extra until the period ends, …). */
  async function afterDone(op, sub) {
    const req = op.request ?? {};
    const { tierItem } = subscriptionItems(sub);
    const periodEnd = secToIso(tierItem?.current_period_end ?? sub.current_period_end);
    const acct = (await store.account(op.user_id)) ?? {};
    if (op.kind === 'remove_business') {
      // a second removal in the same period never cuts what the first one kept (it was paid for)
      const kept = liveExtraKeep(acct);
      await applySubscription(op.user_id, sub, now(), { extraKeep: { count: Math.max(kept ? kept.count : 0, req.from.qty), until: kept?.until ?? periodEnd } });
      if (req.projectId) await db.update('project_slots', { user_id: op.user_id, project_id: req.projectId }, { lock_at: periodEnd });
    } else if (op.kind === 'undo_remove') {
      await applySubscription(op.user_id, sub, now(), { extraKeep: 'clear' });
      await db.update('project_slots', { user_id: op.user_id, state: 'active' }, { lock_at: null });
    } else if (op.kind === 'change_plan') {
      // the highest tier paid for this period stays until it ends (a second downgrade, or a move back up to or below
      // it, keeps it); a charged upgrade ends the keep
      const kept = liveTierKeep(acct);
      let keepTier = req.downgrade || req.withinKept ? kept?.tier ?? null : null;
      if (req.downgrade && (!keepTier || tierRank(req.from.tier) > tierRank(keepTier))) keepTier = req.from.tier;
      await applySubscription(op.user_id, sub, now(), keepTier ? { tierKeep: { tier: keepTier, until: kept?.until ?? periodEnd } } : { tierKeep: 'clear' });
    } else {
      await applySubscription(op.user_id, sub, now());
    }
  }

  /** Read an 'unknown' op back from Stripe (never resends): done | not_applied | still unknown. */
  async function resolveOp(op) {
    const subId = op.request?.subscription;
    if (!SUB_ID.test(String(subId ?? ''))) return store.finishOp(op, { state: 'failed', error_code: 'UNAVAILABLE' });
    let sub;
    try {
      sub = await getSubscription(subId);
    } catch (e) {
      // Stripe doesn't know the subscription: the write had nothing to change
      if (e instanceof StripeError && e.status === 404) return store.finishOp(op, { state: op.kind === 'cancel_for_delete' ? 'done' : 'not_applied', error_code: 'GONE' });
      throw e;
    }
    const seen = opStateOn(op, sub);
    if (seen === 'to') {
      const done = await store.finishOp(op, { state: 'done', stripe_ref: { subscription: sub.id, invoice: typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id ?? null } });
      await afterDone(op, sub);
      return done;
    }
    if (seen === 'drift') {
      // someone changed it in Stripe's dashboard: Stripe wins
      const done = await store.finishOp(op, { state: 'done', error_code: 'DRIFT', stripe_ref: { subscription: sub.id } });
      await applySubscription(op.user_id, sub, now());
      alert('stripe_drift', { kind: op.kind });
      return done;
    }
    if (now() - ms(op.requested_at) >= OP_GIVE_UP_MS) return store.finishOp(op, { state: 'not_applied' });
    return store.finishOp(op, { state: 'unknown' });
  }

  /** An op left 'sending' by a process that's gone: it's read back like an unknown one (never resent). */
  const staleSending = (op) => op?.state === 'sending' && now() - (ms(op.requested_at) ?? now()) >= OP_STALE_SENDING_MS;

  /** The user's op in flight, read back when it's been unknown for a minute or more (or stuck 'sending'). */
  async function recheckLiveOp(userId) {
    if (!configured()) return null;
    let op = null;
    try {
      op = await store.liveOp(userId);
      if ((op?.state === 'unknown' && now() - ms(op.checked_at ?? op.requested_at) >= OP_RECHECK_MS) || staleSending(op)) op = await resolveOp(op);
    } catch (e) {
      safeLog('billing_op_recheck_failed', { kind: e?.kind, code: e?.code }, log);
    }
    return op;
  }

  /** The answer for an op that ran (or ran before with the same clientRequestId). */
  async function opResult(who, op) {
    if (op.state === 'done') return { status: 200, body: { ok: true, op: opView(op), businesses: await businessesView(who.id, who), plan: await entitlement(who.id, who) } };
    if (op.state === 'unknown' || op.state === 'sending') return { status: 202, body: { error: MSG.confirming, code: 'BILLING_PENDING', op: opView(op) } };
    if (op.error_code === 'CARD_DECLINED') throw fail(402, 'CARD_DECLINED', MSG.declined, { op: opView(op) });
    if (op.state === 'not_applied') throw fail(409, 'BILLING_PENDING', 'That change didn’t go through. Try again.', { op: opView(op) });
    throw fail(503, 'UNAVAILABLE', MSG.unavailable, { op: opView(op) });
  }

  /**
   * One money operation, exactly once: plan(sub, acct) → { request, path, body, key } (or throws our error). The
   * subscription is read first; the op row goes in before the one Stripe write; the outcome is recorded.
   */
  async function moneyOp(who, kind, crid, plan) {
    if (!isUuid(crid)) throw fail(400, 'BAD_REQUEST', 'Refresh the page and try again.');
    const again = await store.opByRequest(who.id, crid);
    if (again) return opResult(who, again);
    const live = await recheckLiveOp(who.id);
    if (live && ['sending', 'unknown'].includes(live.state)) throw fail(409, 'BILLING_PENDING', MSG.pending, { op: opView(live) });
    const acct = await store.account(who.id);
    if (acct?.source === 'owner' || who.isAdmin === true) throw fail(409, 'OWNER_PLAN', MSG.owner);
    if (acct?.source === 'comp') throw fail(409, 'NOT_ALLOWED_ON_PLAN', MSG.notOnPlan);
    if (!acct?.stripe_subscription_id) throw fail(409, 'PLAN_REQUIRED', MSG.planRequired, { upgrade: '#plans' });
    const sub = await getSubscription(acct.stripe_subscription_id);
    if (sub.status === 'past_due' || sub.status === 'unpaid') throw fail(402, 'PAYMENT_REQUIRED', 'Update your card first.');
    if (!['active', 'trialing'].includes(sub.status)) throw fail(409, 'PLAN_REQUIRED', MSG.planRequired, { upgrade: '#plans' });
    const p = await plan(sub, acct);
    const ins = await store.insertOp(who.id, { kind, clientRequestId: crid, request: { ...p.request, subscription: sub.id }, idempotencyKey: p.key });
    if (ins.existing) return opResult(who, ins.existing);
    if (ins.busy !== undefined) throw fail(409, 'BILLING_PENDING', MSG.pending, { op: opView(ins.busy) });
    let op = ins.op;
    const out = await stripe.post(p.path, p.body, { idempotencyKey: p.key });
    if (out.outcome === 'ok') {
      op = await store.finishOp(op, { state: 'done', stripe_ref: { subscription: sub.id, invoice: typeof out.value?.latest_invoice === 'string' ? out.value.latest_invoice : null } });
      // the write's answer is the subscription as it is now
      await afterDone(op, out.value);
      return opResult(who, op);
    }
    if (out.outcome === 'failed') {
      const card = out.error?.kind === 'card';
      op = await store.finishOp(op, { state: 'failed', error_code: card ? 'CARD_DECLINED' : 'UNAVAILABLE' });
      if (!card) alert('stripe_op_failed', { kind, errorKind: out.error?.kind, code: out.error?.code });
      return opResult(who, op);
    }
    op = await store.finishOp(op, { state: 'unknown' });
    try {
      op = await resolveOp(op);
    } catch (e) {
      safeLog('billing_op_readback_failed', { kind, errorKind: e?.kind }, log);
    }
    return opResult(who, op);
  }

  async function changeBusinesses(who, body) {
    if (body?.confirm !== true) throw fail(400, 'BAD_REQUEST', 'Confirm the change first.');
    const action = body?.action;
    const crid = body?.clientRequestId;
    if (action === 'add') {
      return moneyOp(who, 'add_business', crid, async (sub, acct) => {
        if (acct.extra_keep_until && ms(acct.extra_keep_until) > now() && acct.extra_keep > acct.extra_businesses) {
          throw fail(409, 'BAD_REQUEST', 'You’re removing a business at renewal. Keep it instead, at no charge.', { useUndo: true });
        }
        const { tierItem, businessItem } = subscriptionItems(sub);
        const interval = tierItem?.price?.recurring?.interval;
        if (!isInterval(interval)) throw fail(503, 'UNAVAILABLE', MSG.unavailable, {}, 'The subscription has no plan price with a known lookup key.');
        const from = Number(businessItem?.quantity ?? 0);
        const to = from + 1;
        const item = businessItem ? { id: businessItem.id, quantity: to } : { price: await priceId(lookupKeyFor('business', interval)), quantity: 1 };
        return { request: { from: { qty: from }, to: { qty: to } }, path: `/v1/subscriptions/${sub.id}`, body: { items: [item], proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete' }, key: `ylb-biz-add-${who.id}-${crid}` };
      });
    }
    if (action === 'remove') {
      const projectId = body.projectId == null ? null : String(body.projectId);
      if (projectId !== null && (projectId.length < 1 || projectId.length > 80)) throw fail(400, 'BAD_REQUEST', 'Choose a business.');
      if (projectId) {
        const slot = (await store.slots(who.id)).find((r) => r.project_id === projectId);
        if (!slot) throw fail(404, 'NOT_FOUND', 'No such business.');
        // already leaving at renewal: a second press (or a retry with a new id) never removes another one
        if (slot.lock_at && ms(slot.lock_at) > now()) throw fail(409, 'BAD_REQUEST', 'That business is already set to be removed at renewal.');
      }
      return moneyOp(who, 'remove_business', crid, async (sub) => {
        const { businessItem } = subscriptionItems(sub);
        const from = Number(businessItem?.quantity ?? 0);
        if (!businessItem || from < 1) throw fail(409, 'BAD_REQUEST', 'Your plan has no extra business to remove.');
        return { request: { from: { qty: from }, to: { qty: from - 1 }, ...(projectId ? { projectId } : {}) }, path: `/v1/subscriptions/${sub.id}`, body: { items: [{ id: businessItem.id, quantity: from - 1 }], proration_behavior: 'none' }, key: `ylb-biz-rm-${who.id}-${crid}` };
      });
    }
    if (action === 'undo_remove') {
      return moneyOp(who, 'undo_remove', crid, async (sub, acct) => {
        const { businessItem } = subscriptionItems(sub);
        const from = Number(businessItem?.quantity ?? 0);
        if (!acct.extra_keep_until || ms(acct.extra_keep_until) <= now() || !(acct.extra_keep > from) || !businessItem) throw fail(409, 'BAD_REQUEST', 'There’s no removal to undo.');
        // free only within the period that was paid for: after a switch to yearly (a new period) it's an added business
        const { tierItem } = subscriptionItems(sub);
        const periodEnd = secToIso(tierItem?.current_period_end ?? sub.current_period_end);
        if (ms(periodEnd) !== ms(acct.extra_keep_until)) throw fail(409, 'BAD_REQUEST', 'Your billing period changed since the removal. Add a business instead.', { useAdd: true });
        return { request: { from: { qty: from }, to: { qty: acct.extra_keep } }, path: `/v1/subscriptions/${sub.id}`, body: { items: [{ id: businessItem.id, quantity: acct.extra_keep }], proration_behavior: 'none' }, key: `ylb-biz-undo-${who.id}-${crid}` };
      });
    }
    throw fail(400, 'BAD_REQUEST', 'Choose add, remove or undo_remove.');
  }

  async function changePlan(who, body) {
    if (body?.confirm !== true) throw fail(400, 'BAD_REQUEST', 'Confirm the change first.');
    const tier = body?.tier;
    const interval = body?.interval;
    if (!isTier(tier) || !isInterval(interval)) throw fail(400, 'BAD_REQUEST', 'Choose Launch, Grow or Scale, monthly or yearly.');
    return moneyOp(who, 'change_plan', body?.clientRequestId, async (sub, acct) => {
      const { tierItem, businessItem } = subscriptionItems(sub);
      const fromKey = tierItem?.price?.lookup_key;
      const fromTier = tierFromLookupKey(fromKey);
      const fromInterval = tierItem?.price?.recurring?.interval;
      if (!fromTier || !isInterval(fromInterval)) throw fail(503, 'UNAVAILABLE', MSG.unavailable, {}, 'The subscription has no plan price with a known lookup key.');
      if (fromTier === tier && fromInterval === interval) throw fail(400, 'BAD_REQUEST', 'That’s your plan already.');
      if (fromInterval === 'year' && interval === 'month') throw fail(409, 'NOT_ALLOWED_ON_PLAN', 'Switching from yearly to monthly happens at renewal: contact support.');
      const intervalChange = fromInterval !== interval;
      // a lower plan starts at renewal and yearly starts now: both at once would charge today for a plan the app said
      // waits, so they're two steps
      if (intervalChange && tierRank(tier) < tierRank(fromTier)) throw fail(409, 'NOT_ALLOWED_ON_PLAN', `Choose ${PLANS.plans[tier]?.name ?? 'the lower plan'} monthly first (it starts at renewal). You can switch to yearly after that.`);
      const kept = liveTierKeep(acct);
      if (kept && intervalChange) throw fail(409, 'NOT_ALLOWED_ON_PLAN', `You’re moving to a lower plan at renewal. Switch back to ${PLANS.plans[kept.tier]?.name ?? 'your plan'} first, then to yearly.`);
      // back up to (or below) the tier already paid for this period: no second charge
      const withinKept = !!kept && !intervalChange && tierRank(tier) > tierRank(fromTier) && tierRank(tier) <= tierRank(kept.tier);
      if (kept && !intervalChange && tierRank(tier) > tierRank(kept.tier)) throw fail(409, 'NOT_ALLOWED_ON_PLAN', `You’ve paid for ${PLANS.plans[kept.tier]?.name ?? 'your plan'} until renewal. Switch back to it first (no charge), then upgrade.`);
      const toKey = lookupKeyFor(tier, interval);
      const items = [{ id: tierItem.id, price: await priceId(toKey) }];
      if (intervalChange && businessItem) items.push({ id: businessItem.id, price: await priceId(lookupKeyFor('business', interval)) });
      const downgrade = !intervalChange && tierRank(tier) < tierRank(fromTier);
      const free = downgrade || withinKept;
      return {
        request: { from: { tier: fromTier, interval: fromInterval, lookupKey: fromKey }, to: { tier, interval, lookupKey: toKey }, downgrade, withinKept },
        path: `/v1/subscriptions/${sub.id}`,
        body: free ? { items, proration_behavior: 'none' } : { items, proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete' },
        key: `ylb-plan-${who.id}-${body.clientRequestId}`,
      };
    });
  }

  async function chooseActive(who, body) {
    const ids = Array.isArray(body?.projectIds) ? body.projectIds.map(String) : null;
    if (!ids || !ids.length || ids.length > 1000 || ids.some((id) => id.length < 1 || id.length > 80)) throw fail(400, 'BAD_REQUEST', 'Choose which businesses stay active.');
    const out = await db.rpc('ylb_choose_active_slots', { p_user: who.id, p_ids: ids });
    if (out?.ok !== true) throw fail(400, 'BAD_REQUEST', out?.reason === 'not_found' ? 'One of those isn’t your business.' : `Your plan includes ${out?.limit ?? 1} ${out?.limit === 1 ? 'business' : 'businesses'}. Choose that many or fewer.`);
    return businessesView(who.id, who);
  }

  // ───────────── owner ─────────────

  const last4 = (id) => (id ? `…${String(id).slice(-4)}` : null);

  async function ownerAccounts(url) {
    const status = url.searchParams.get('status');
    const n = Math.min(500, Math.max(1, Math.trunc(Number(url.searchParams.get('limit')) || 200)));
    const rows = await db.select('billing_accounts', status ? { status } : {}, { order: 'updated_at.desc', limit: n });
    const out = [];
    for (const r of rows) {
      const lastOp = await store.lastOp(r.user_id).catch(() => null);
      out.push({
        customerTag: r.customer_tag,
        email: (await emailFor(r.user_id).catch(() => '')) || undefined,
        tier: r.tier,
        interval: r.interval,
        status: r.status,
        source: r.source,
        businessLimit: r.business_limit,
        extraBusinesses: r.extra_businesses,
        compExtra: r.comp_extra,
        currentPeriodEnd: r.current_period_end,
        trialEndsAt: r.status === 'trialing' ? r.trial_ends_at ?? null : null,
        graceUntil: r.grace_until,
        compUntil: r.comp_until,
        cancelAtPeriodEnd: r.cancel_at_period_end === true,
        dataExpiresAt: r.ended_at ? new Date(ms(r.ended_at) + PLANS.dataAfterCancelDays * DAY_MS).toISOString() : null,
        stripeCustomer: last4(r.stripe_customer_id),
        stripeSubscription: last4(r.stripe_subscription_id),
        lastOp: lastOp ? { kind: lastOp.kind, state: lastOp.state, at: lastOp.requested_at } : null,
      });
    }
    return { accounts: out };
  }

  async function accountByTag(tag) {
    if (!TAG.test(tag)) throw fail(404, 'NOT_FOUND', 'No such customer.');
    const [row] = await db.select('billing_accounts', { customer_tag: tag }, { limit: 1 });
    if (row) return row;
    const [cust] = await db.select('billing_customers', { customer_tag: tag }, { limit: 1 });
    if (!cust?.user_id) throw fail(404, 'NOT_FOUND', 'No such customer.');
    return store.ensureAccount(cust.user_id);
  }

  async function putComp(tag, body) {
    const acct = await accountByTag(tag);
    if (acct.source === 'owner') throw fail(409, 'OWNER_PLAN', 'That’s the owner’s account.');
    if (acct.source === 'stripe' && acct.stripe_subscription_id && LIVE_STATUSES.includes(acct.status)) throw fail(409, 'ALREADY_SUBSCRIBED', 'This customer pays through Stripe. Cancel that subscription in Stripe first.');
    const tier = body?.tier;
    if (tier === 'none') {
      await store.apply(acct.user_id, { source: 'comp', status: 'expired', ended_at: iso(), comp_until: iso() }, null);
    } else {
      if (!isTier(tier)) throw fail(400, 'BAD_REQUEST', 'tier must be launch, grow, scale or none.');
      const extra = body.extraBusinesses ?? 0;
      if (!Number.isInteger(extra) || extra < 0 || extra > 100) throw fail(400, 'BAD_REQUEST', 'extraBusinesses must be a whole number from 0 to 100.');
      const until = body.until == null ? null : ms(body.until);
      if (body.until != null && (until == null || until <= now())) throw fail(400, 'BAD_REQUEST', 'until must be a date in the future, or null.');
      const note = body.note == null ? null : String(body.note).trim().slice(0, 500) || null;
      await store.apply(acct.user_id, { source: 'comp', tier, interval: null, status: 'active', comp_extra: extra, business_limit: 1 + extra, comp_until: until == null ? null : iso(until), comp_note: note, ended_at: null, tier_keep: null, tier_keep_until: null, extra_keep: 0, extra_keep_until: null, grace_until: null }, null);
    }
    forgetCache(acct.user_id);
    try {
      await caps?.syncToTreg?.(acct.customer_tag);
    } catch {
      /* best effort */
    }
    return { ok: true, account: accountView(await store.account(acct.user_id)) };
  }

  async function syncAccount(tag) {
    const acct = await accountByTag(tag);
    if (acct.stripe_subscription_id) await syncSubscription(acct.user_id, acct.stripe_subscription_id);
    else if (acct.stripe_customer_id) await adoptFromCustomer(acct);
    return { ok: true, account: accountView(await store.account(acct.user_id)) };
  }

  async function settingsView() {
    const s = await settings();
    let priceState = null;
    if (stripe.enabled) {
      try {
        priceCache = null;
        const byKey = await prices();
        priceState = Object.fromEntries(lookupKeysAll().map((k) => [k, byKey[k] ? 'ok' : 'missing']));
      } catch {
        priceState = null;
      }
    }
    return {
      settings: { enforce: s.enforce === true, enforcedAt: s.enforced_at ?? null, cardTrialDays: Number(s.card_trial_days) || 0, existingTrialDays: Number(s.existing_trial_days ?? 30) },
      stripe: { mode: stripe.mode, key: stripe.keyMask || null, webhookSecret: webhookSecrets().length ? mask(webhookSecrets()[0]) : null, prices: priceState },
      missing: missing(),
    };
  }

  async function putSettings(body) {
    if (!body || typeof body !== 'object') throw fail(400, 'BAD_REQUEST', 'Send the settings as JSON.');
    const patch = {};
    if ('cardTrialDays' in body) {
      if (!Number.isInteger(body.cardTrialDays) || body.cardTrialDays < 0 || body.cardTrialDays > 14) throw fail(400, 'BAD_REQUEST', 'cardTrialDays must be 0 to 14.');
      patch.card_trial_days = body.cardTrialDays;
    }
    if ('existingTrialDays' in body) {
      if (!Number.isInteger(body.existingTrialDays) || body.existingTrialDays < 0 || body.existingTrialDays > 90) throw fail(400, 'BAD_REQUEST', 'existingTrialDays must be 0 to 90.');
      patch.existing_trial_days = body.existingTrialDays;
    }
    const current = await store.settings({ fresh: true });
    let started = null;
    if ('enforce' in body) {
      if (typeof body.enforce !== 'boolean') throw fail(400, 'BAD_REQUEST', 'enforce must be true or false.');
      if (body.enforce && !current.enforce) {
        if (!configured()) throw fail(409, 'NOT_SET_UP', 'Plans can’t start yet.', {}, `Add these first: ${missing().join(', ')}.`);
        priceCache = null;
        const byKey = await prices();
        const gone = lookupKeysAll().filter((k) => !byKey[k]);
        if (gone.length) throw fail(409, 'NOT_SET_UP', 'Plans can’t start yet.', {}, `Stripe has no matching price for ${gone.join(', ')}. Run npm run stripe:setup (dry run first, then --apply).`);
        if (!appUrl()) throw fail(409, 'NOT_SET_UP', 'Plans can’t start yet.', {}, 'Add APP_URL (the app’s https address) in Replit Secrets.');
      }
      patch.enforce = body.enforce;
      if (body.enforce && !current.enforced_at) patch.enforced_at = iso();
    }
    // existing users get their free Grow BEFORE plans go on: if that fails, plans stay off and the owner can try again
    // (it's idempotent: only users with businesses and no billing row get one)
    const turningOn = patch.enforce === true && !current.enforce;
    const trialDays = Number(patch.existing_trial_days ?? current.existing_trial_days ?? 30);
    if (turningOn) started = await startExisting(trialDays);
    await store.putSettings(patch);
    if (turningOn) {
      // anyone who made a first business in between
      try {
        started += await startExisting(trialDays);
      } catch (e) {
        safeLog('billing_existing_start_failed', { code: e?.code }, log);
      }
    }
    entCache.clear();
    pagesCache.clear();
    return { ...(await settingsView()), ...(started != null ? { existingAccountsStarted: started } : {}) };
  }

  /** Existing accounts with businesses get free Grow for `days` (rows the server tags; the function inserts them). */
  async function startExisting(days) {
    const tags = {};
    for (let page = 0; page < 100; page++) {
      const rows = await db.select('user_docs', { kind: 'project' }, { select: 'user_id', limit: 1000, offset: page * 1000 });
      for (const r of rows) if (isUuid(r.user_id) && !tags[r.user_id]) tags[r.user_id] = customerTag(r.user_id, env);
      if (rows.length < 1000) break;
    }
    const n = await db.rpc('ylb_billing_start_existing', { p_days: days, p_tags: tags });
    safeLog('billing_existing_started', { accounts: Number(n) || 0 }, log);
    return Number(n) || 0;
  }

  // ───────────── the webhook ─────────────

  /** The user a Stripe customer id belongs to (or null). */
  async function userForCustomer(customer) {
    if (!/^cus_[A-Za-z0-9]+$/.test(String(customer ?? ''))) return null;
    const [row] = await db.select('billing_accounts', { stripe_customer_id: customer }, { select: 'user_id,stripe_customer_id,customer_tag', limit: 1 });
    return row?.user_id ?? null;
  }

  async function processEvent(evt) {
    const type = String(evt.type ?? '');
    const obj = evt.data?.object ?? {};
    if (!STRIPE_EVENTS.includes(type)) return 'ignored';
    if (type === 'checkout.session.completed') {
      const uid = String(obj.client_reference_id ?? '');
      if (!isUuid(uid)) return 'not_ours';
      const customer = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      const linked = await userForCustomer(customer);
      if (linked && linked !== uid) {
        alert('stripe_customer_other_user', {});
        return 'not_ours';
      }
      const acct = await store.account(uid);
      if (!acct) {
        // a user we made a session for has a row; anyone else is not ours
        alert('stripe_unknown_customer', { type });
        return 'not_ours';
      }
      if (acct.stripe_customer_id && customer && acct.stripe_customer_id !== customer) {
        alert('stripe_customer_mismatch', { tag: acct.customer_tag });
        return 'not_ours';
      }
      // re-read the session: the payload only tells us which one
      const session = await stripe.get(`/v1/checkout/sessions/${encodeURIComponent(obj.id)}`);
      if (session.client_reference_id !== uid || session.status !== 'complete' || !session.subscription) return 'ignored';
      await syncSubscription(uid, typeof session.subscription === 'string' ? session.subscription : session.subscription.id);
      return 'applied';
    }
    const customer = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
    const uid = await userForCustomer(customer);
    if (!uid) {
      alert('stripe_unknown_customer', { type });
      return 'not_ours';
    }
    let subId = null;
    if (type.startsWith('customer.subscription.')) subId = obj.id;
    else subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id ?? obj.parent?.subscription_details?.subscription ?? null;
    if (!SUB_ID.test(String(subId ?? ''))) {
      const acct = await store.account(uid);
      subId = acct?.stripe_subscription_id ?? null;
      if (!subId) return 'ignored';
    }
    const failed = type === 'invoice.payment_failed' || type === 'invoice.payment_action_required';
    const out = await syncSubscription(uid, subId, { failed });
    return out.refused ? `refused_${out.refused}` : 'applied';
  }

  /** POST /api/webhooks/stripe → { status, body }. */
  async function webhook(req) {
    if (limit('stripe-webhook', clientKey(req))) return { status: 429, body: { error: 'Too many requests.', code: 'RATE_LIMITED' } };
    let raw;
    try {
      raw = await readRaw(req, 256 * 1024);
    } catch (e) {
      return { status: e?.status === 413 ? 413 : 400, body: { error: 'Bad request.', code: 'BAD_REQUEST' } };
    }
    if (!webhookSecrets().length || !stripe.enabled || !db?.enabled) return { status: 503, body: { error: 'Not set up.', code: 'NOT_SET_UP' } };
    const header = req.headers['stripe-signature'];
    if (!webhookSecrets().some((s) => verifyStripeSignature(raw, header, s, now()))) {
      safeLog('stripe_webhook_bad_signature', {}, log);
      return { status: 400, body: { error: 'Bad signature.', code: 'BAD_REQUEST' } };
    }
    let evt;
    try {
      evt = JSON.parse(raw.toString('utf8'));
    } catch {
      return { status: 400, body: { error: 'Bad request.', code: 'BAD_REQUEST' } };
    }
    if (!evt || typeof evt !== 'object') return { status: 400, body: { error: 'Bad request.', code: 'BAD_REQUEST' } };
    if (evt.livemode !== stripe.live) {
      safeLog('stripe_webhook_mode_mismatch', { live: evt.livemode === true }, log);
      return { status: 200, body: { ok: true, ignored: true } };
    }
    // Connect events belong to the sellers' payments (a later phase)
    if (evt.account) return { status: 200, body: { ok: true, ignored: true } };
    const id = String(evt.id ?? '');
    const dedupeKey = `stripe:${EVENT_ID.test(id) ? id : sha256(raw)}`;
    try {
      const seen = await db.select('webhook_deliveries', { body_hash: dedupeKey }, { select: 'body_hash', limit: 1 });
      if (seen.length) return { status: 200, body: { ok: true, duplicate: true } };
    } catch {
      return { status: 500, body: { error: 'Try again.', code: 'UNAVAILABLE' } };
    }
    let outcome;
    try {
      outcome = await processEvent(evt);
    } catch (e) {
      safeLog('stripe_webhook_failed', { type: String(evt.type ?? '').slice(0, 60), kind: e?.kind, code: e?.code }, log);
      return { status: 500, body: { error: 'Try again.', code: 'UNAVAILABLE' } };
    }
    try {
      await db.upsert('webhook_deliveries', { body_hash: dedupeKey, received_at: iso() }, { onConflict: 'body_hash' });
    } catch {
      /* a repeat applies the same read again: harmless */
    }
    safeLog('stripe_webhook', { type: String(evt.type ?? '').slice(0, 60), outcome }, log);
    return { status: 200, body: { ok: true } };
  }

  // ───────────── cron ─────────────

  /** A customer with no subscription id on file: adopt their single live subscription (alert on more). */
  async function adoptFromCustomer(acct) {
    const list = await stripe.get('/v1/subscriptions', { customer: acct.stripe_customer_id, status: 'all', limit: 20 });
    const live = (list?.data ?? []).filter((s) => !ENDED_STATUSES.includes(s.status));
    if (live.length > 1) {
      alert('stripe_second_subscription', { tag: acct.customer_tag });
      return { changed: false, alert: true };
    }
    if (live.length === 1) return { changed: (await applySubscription(acct.user_id, live[0], now())).applied === true, alert: false };
    return { changed: false, alert: false };
  }

  async function hourly(ctx = {}) {
    const deadline = ctx.deadline ?? now() + 30_000;
    const out = { keepsApplied: 0, locksApplied: 0, compsEnded: 0, opsResolved: 0, pastDueAfterGrace: 0, orphanSlotsFreed: 0 };
    const t = iso();
    // (a) pending removals and downgrades whose period ended
    const due = [...(await db.select('billing_accounts', { extra_keep_until: ['lte', t] }, { limit: 200 })), ...(await db.select('billing_accounts', { tier_keep_until: ['lte', t] }, { limit: 200 }))];
    for (const a of new Map(due.map((r) => [r.user_id, r])).values()) {
      const patch = {};
      if (a.extra_keep_until && ms(a.extra_keep_until) <= now()) Object.assign(patch, { extra_keep: 0, extra_keep_until: null, business_limit: 1 + (a.extra_businesses ?? 0) + (a.comp_extra ?? 0) });
      if (a.tier_keep_until && ms(a.tier_keep_until) <= now()) Object.assign(patch, { tier_keep: null, tier_keep_until: null });
      await store.apply(a.user_id, patch, null);
      forgetCache(a.user_id);
      out.keepsApplied += 1;
      if (patch.tier_keep === null) {
        try {
          await caps?.syncToTreg?.(a.customer_tag);
        } catch {
          /* best effort */
        }
      }
    }
    // (b) businesses chosen for removal whose date came
    const locks = await db.select('project_slots', { lock_at: ['lte', t] }, { select: 'user_id', limit: 500 });
    for (const u of new Set(locks.map((r) => r.user_id))) {
      await store.applySlots(u);
      out.locksApplied += 1;
    }
    // (c) free plans that ended
    const comps = await db.select('billing_accounts', { source: 'comp', status: ['in', ['trialing', 'active']], comp_until: ['lte', t] }, { limit: 200 });
    for (const a of comps) {
      await store.apply(a.user_id, { status: 'expired', ended_at: a.comp_until }, null);
      forgetCache(a.user_id);
      out.compsEnded += 1;
    }
    // (d) money ops whose outcome is still unknown: read back, never resent
    if (configured()) {
      const ops = await store.unknownOps({ olderThan: now() - OP_RECHECK_MS, staleBefore: now() - OP_STALE_SENDING_MS, limit: 20 });
      for (const op of ops) {
        if (now() > deadline - 5_000) break;
        try {
          const r = await resolveOp(op);
          if (r.state !== 'unknown') out.opsResolved += 1;
        } catch (e) {
          safeLog('billing_op_readback_failed', { kind: op.kind, errorKind: e?.kind }, log);
        }
      }
    }
    // (f) a slot claimed for a business that was never saved (setup abandoned, the tab closed) goes back to the plan
    // after a day (users can't delete slot rows; only deleting a saved business frees one)
    try {
      const old = await db.select('project_slots', { state: 'active', claimed_at: ['lte', iso(now() - ORPHAN_SLOT_MS)] }, { select: 'user_id,project_id,claimed_at', order: 'claimed_at.desc', limit: 1000 });
      const byUser = new Map();
      for (const r of old) if (ms(r.claimed_at) >= now() - 7 * DAY_MS) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r.project_id]);
      for (const [u, ids] of byUser) {
        if (now() > deadline - 5_000) break;
        const docs = await db.select('user_docs', { user_id: u, kind: 'project', id: ['in', ids] }, { select: 'id', limit: ids.length });
        const saved = new Set(docs.map((d) => d.id));
        const gone = ids.filter((id) => !saved.has(id));
        if (!gone.length) continue;
        await db.remove('project_slots', { user_id: u, project_id: ['in', gone], state: 'active' });
        await store.applySlots(u);
        out.orphanSlotsFreed += gone.length;
      }
    } catch (e) {
      safeLog('billing_orphan_slots_failed', { code: e?.code }, log);
    }
    // (e) past due after grace: the entitlement pauses them; counted for the owner
    out.pastDueAfterGrace = (await db.select('billing_accounts', { status: 'past_due', grace_until: ['lte', t] }, { select: 'user_id', limit: 1000 })).length;
    return out;
  }

  async function reconcile(ctx = {}) {
    const deadline = ctx.deadline ?? now() + 30_000;
    const report = { checked: 0, changed: 0, alerts: 0 };
    if (!configured()) return { ...report, skipped: 'not_set_up' };
    const left = () => now() < deadline - 5_000;
    // live subscriptions, the longest unread first
    for (let page = 0; page < 50 && left(); page++) {
      const rows = await db.select('billing_accounts', { stripe_subscription_id: ['neq', ''], source: 'stripe' }, { order: 'stripe_fetched_at.asc.nullsfirst', limit: 100, offset: page * 100 });
      for (const a of rows) {
        if (!left()) break;
        if (!a.stripe_subscription_id) continue;
        try {
          const r = await syncSubscription(a.user_id, a.stripe_subscription_id);
          report.checked += 1;
          if (r.applied && (r.account?.status !== a.status || r.account?.tier !== a.tier || r.account?.extra_businesses !== a.extra_businesses)) report.changed += 1;
          if (r.refused === 'second_subscription') report.alerts += 1;
        } catch (e) {
          safeLog('billing_reconcile_read_failed', { kind: e?.kind }, log);
        }
      }
      if (rows.length < 100) break;
    }
    // Checkouts whose webhook never came
    const open = left() ? await db.select('billing_accounts', { checkout_session_id: ['neq', ''] }, { limit: 200 }) : [];
    for (const a of open) {
      if (!left() || !a.checkout_session_id) continue;
      try {
        report.checked += 1;
        if (await adoptSession(a.user_id, a.checkout_session_id, a)) report.changed += 1;
        else if (ms(a.checkout_expires_at) != null && ms(a.checkout_expires_at) < now()) await db.update('billing_accounts', { user_id: a.user_id }, { checkout_session_id: null, checkout_expires_at: null });
      } catch (e) {
        safeLog('billing_reconcile_read_failed', { kind: e?.kind }, log);
      }
    }
    // customers with no subscription on file
    const bare = left() ? await db.select('billing_accounts', { stripe_customer_id: ['neq', ''], stripe_subscription_id: null }, { limit: 200 }) : [];
    for (const a of bare) {
      if (!left() || !a.stripe_customer_id) continue;
      try {
        report.checked += 1;
        const r = await adoptFromCustomer(a);
        if (r.changed) report.changed += 1;
        if (r.alert) report.alerts += 1;
      } catch (e) {
        safeLog('billing_reconcile_read_failed', { kind: e?.kind }, log);
      }
    }
    return report;
  }

  async function retention() {
    const cutoff = iso(now() - PLANS.dataAfterCancelDays * DAY_MS);
    const rows = await db.select('billing_accounts', { ended_at: ['lte', cutoff] }, { select: 'customer_tag,ended_at', limit: 1000 });
    // never deleted here: deleting data stays the owner's action
    return { dataPastRetention: rows.length };
  }

  function cronJobs() {
    if (!db?.enabled) return [];
    return [
      { name: 'billing-hourly', everyMs: 3_600_000, run: (ctx) => hourly(ctx) },
      { name: 'stripe-reconcile', dailyAtUtc: '04:17', run: (ctx) => reconcile(ctx) },
      { name: 'billing-retention', dailyAtUtc: '04:47', run: () => retention() },
    ];
  }

  // ───────────── account deletion ─────────────

  /**
   * Before an account is deleted: every subscription of its Stripe customer that isn't over is cancelled (the stored
   * one, and any the database hasn't caught up with: a Checkout whose webhook hasn't come, a second one that was
   * refused). One op and key per subscription. Unconfirmed → 409 BILLING_PENDING; Stripe or the database failing →
   * 503 in our words (their text stays here). A subscription Stripe doesn't know is over.
   */
  async function forgetUser(userId) {
    if (!db?.enabled) return;
    let acct;
    try {
      acct = await store.account(userId);
    } catch (e) {
      if (e?.code === 'NOT_SET_UP') return;
      alert('delete_read_failed', { code: e?.code });
      throw fail(503, 'UNAVAILABLE', MSG.cancelLater);
    }
    forgetCache(userId);
    if (!acct?.stripe_customer_id && !acct?.stripe_subscription_id) return;
    if (!stripe.enabled) throw fail(503, 'UNAVAILABLE', MSG.cancelLater);
    try {
      await cancelAllFor(userId, acct);
    } catch (e) {
      if (e instanceof IntegrationError) throw e;
      alert('stripe_cancel_failed', { errorKind: e?.kind, code: e?.code });
      throw fail(503, 'UNAVAILABLE', MSG.cancelLater);
    }
  }

  async function cancelAllFor(userId, acct) {
    const pendingErr = () => fail(409, 'BILLING_PENDING', 'We couldn’t confirm your subscription was cancelled. Try again in a minute.');
    const live = await store.liveOp(userId);
    if (live) {
      const r = live.state === 'unknown' || staleSending(live) ? await resolveOp(live).catch(() => live) : live;
      if (['sending', 'unknown'].includes(r.state)) throw pendingErr();
    }
    const subs = new Map();
    if (acct.stripe_customer_id) {
      const list = await stripe.get('/v1/subscriptions', { customer: acct.stripe_customer_id, status: 'all', limit: 100 });
      for (const sub of Array.isArray(list?.data) ? list.data : []) if (SUB_ID.test(String(sub?.id ?? ''))) subs.set(sub.id, sub);
    }
    if (acct.stripe_subscription_id && !subs.has(acct.stripe_subscription_id)) {
      try {
        subs.set(acct.stripe_subscription_id, await getSubscription(acct.stripe_subscription_id));
      } catch (e) {
        // Stripe doesn't know it (deleted, or another mode's): nothing left to bill
        if (!(e instanceof StripeError && e.status === 404)) throw e;
      }
    }
    for (const sub of subs.values()) {
      if (ENDED_STATUSES.includes(sub.status)) continue;
      const key = `ylb-cancel-${userId}-${sub.id}`;
      const ins = await store.insertOp(userId, { kind: 'cancel_for_delete', clientRequestId: uuidFrom(`${key}:${now()}`), request: { subscription: sub.id, from: { status: sub.status }, to: { status: 'canceled' } }, idempotencyKey: key });
      if (!ins.op) throw pendingErr();
      let op = ins.op;
      const out = await stripe.del(`/v1/subscriptions/${sub.id}`, { invoice_now: 'false', prorate: 'false' }, { idempotencyKey: key });
      if (out.outcome === 'ok') {
        await store.finishOp(op, { state: 'done', stripe_ref: { subscription: sub.id } });
        if (sub.id === acct.stripe_subscription_id) await applySubscription(userId, out.value, now()).catch(() => null);
        continue;
      }
      if (out.outcome === 'failed') {
        await store.finishOp(op, { state: 'failed', error_code: 'UNAVAILABLE' });
        alert('stripe_cancel_failed', { errorKind: out.error?.kind, code: out.error?.code });
        throw fail(503, 'UNAVAILABLE', MSG.cancelLater);
      }
      op = await store.finishOp(op, { state: 'unknown' });
      try {
        op = await resolveOp(op);
      } catch {
        /* still unknown */
      }
      if (op.state !== 'done') throw pendingErr();
    }
  }

  // ───────────── routes ─────────────

  async function body(req) {
    try {
      return await readJson(req, 16_384);
    } catch (e) {
      throw fail(e?.status === 413 ? 413 : 400, 'BAD_REQUEST', e?.status === 413 ? 'Request too large.' : 'Send JSON.');
    }
  }

  /**
   * /api/billing/<sub> for this module (routes.mjs has checked same origin, sign-in and billing-read). → { status, body }
   * or null when the method/path isn't one of ours.
   */
  async function route(req, sub, who, url) {
    const m = req.method;
    const write = m !== 'GET';
    if (write && limit('billing-write', who.id)) throw fail(429, 'RATE_LIMITED', 'Too many requests. Try again in a minute.');
    const ownerRoute = sub === 'accounts' || sub === 'settings' || sub === 'surveys' || /^accounts\//.test(sub);
    if (ownerRoute && who.isAdmin !== true) throw fail(403, 'FORBIDDEN', 'Only the app owner can see this.');
    if (!db?.enabled) throw notReady();
    // the owner's settings page works before Stripe is set up (it says what's missing)
    if (!(sub === 'settings' && m === 'GET') && !(sub === 'plan' && m === 'GET') && !configured()) throw notReady();
    if (sub === 'plan' && m === 'GET') return { status: 200, body: await getPlan(who, url) };
    if (sub === 'plan' && m === 'POST') return changePlan(who, await body(req));
    if (sub === 'checkout' && m === 'POST') return { status: 200, body: await checkout(who, await body(req)) };
    if (sub === 'portal' && m === 'POST') return { status: 200, body: await portal(who, await body(req)) };
    if (sub === 'businesses' && m === 'GET') {
      await recheckLiveOp(who.id);
      return { status: 200, body: await businessesView(who.id, who) };
    }
    if (sub === 'businesses' && m === 'POST') return changeBusinesses(who, await body(req));
    if (sub === 'businesses/active' && m === 'PUT') return { status: 200, body: await chooseActive(who, await body(req)) };
    if (sub === 'cancel' && m === 'POST') return cancelPlan(who, await body(req));
    if (sub === 'cancel/survey' && m === 'POST') return { status: 200, body: await keepSurvey(who, await body(req)) };
    if (sub === 'resume' && m === 'POST') return resumePlan(who, await body(req));
    if (sub === 'surveys' && m === 'GET') return { status: 200, body: await ownerSurveys(url) };
    if (sub === 'accounts' && m === 'GET') return { status: 200, body: await ownerAccounts(url) };
    const tagRoute = /^accounts\/([^/]+)\/(comp|sync)$/.exec(sub);
    if (tagRoute && tagRoute[2] === 'comp' && m === 'PUT') return { status: 200, body: await putComp(decodeURIComponent(tagRoute[1]), await body(req)) };
    if (tagRoute && tagRoute[2] === 'sync' && m === 'POST') return { status: 200, body: await syncAccount(decodeURIComponent(tagRoute[1])) };
    if (sub === 'settings' && m === 'GET') return { status: 200, body: await settingsView() };
    if (sub === 'settings' && m === 'PUT') return { status: 200, body: await putSettings(await body(req)) };
    return null;
  }

  /** A thrown error as a reply: ours as they are; Stripe's and the database's in our words (hints for the owner). */
  function errorReply(e, who) {
    if (e instanceof StripeError) {
      safeLog('billing_stripe_failed', { kind: e.kind, code: e.code }, log);
      const hint = e.kind === 'auth' || e.kind === 'config' ? 'Stripe refused the key. Check STRIPE_SECRET_KEY (a restricted key needs Customers, Checkout Sessions, Subscriptions, Billing Portal: write; Prices, Products, Invoices, Events: read).' : '';
      return errorBody(fail(503, 'UNAVAILABLE', MSG.unavailable, {}, hint), who);
    }
    if (e?.name === 'DbError') {
      safeLog('billing_db_failed', { code: e.code }, log);
      if (e.code === 'NOT_SET_UP') return errorBody(notSetUp(`Run ${BILLING_MIGRATION} in Supabase.`, MSG.notReady), who);
      return errorBody(fail(503, 'UNAVAILABLE', MSG.unavailable), who);
    }
    return errorBody(e, who);
  }

  return {
    route,
    errorReply,
    webhook,
    entitlement,
    requireActive,
    requireSlot,
    businessLimit,
    pagesServeUntil,
    tregCapsFor,
    forgetUser,
    cronJobs,
    configured,
    missing,
    store,
    stripe,
    /** for tests: the read-back and the cron jobs, run directly */
    resolveOp,
    trialOffer,
    hourly,
    reconcile,
    retention,
    /** what /api/config says about plans (no key, no ids); settings cached ≤ 30 s */
    config() {
      if (db?.enabled && now() - lastSettingsAt > ENT_TTL_MS) {
        lastSettingsAt = now();
        void settings().catch(() => {});
      }
      return { enabled: configured(), enforce: lastSettings?.enforce === true };
    },
    async refreshConfig() {
      await settings().catch(() => null);
      return this.config();
    },
    forget: forgetCache,
    notes() {
      if (!configured()) return [`Plans: off (add ${missing().join(', ')} in Replit Secrets).`];
      const s = lastSettings;
      if (s?.enforce === true) return [`Plans: on (${stripe.mode} mode, key ${stripe.keyMask}).`];
      return [`Plans: set up, not enforced (${stripe.mode} mode, key ${stripe.keyMask}; Owner → Billing → Turn on plans).`];
    },
  };
}
