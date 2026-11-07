// Stripe Connect for sellers (P6): each seller's own Stripe account, made by this server, and what the app sees of it.
// Mounted by server/offers/index.mjs (routes under /api/payments/stripe) and used by the buy links, the Connect
// webhook and the cron jobs (server/offers/stripeCheckout.mjs, server/payments/connectWebhook.mjs).
//
//   GET    /api/payments/stripe                    { available, environment, account, fee: {pct, tier}, termsUrl,
//                                                    termsVersion, termsReady }                      (no key, ever)
//   POST   /api/payments/stripe {country, acceptTerms: true, clientRequestId, businessName?}   create (needs a plan)
//   POST   /api/payments/stripe/onboarding {}      → { url }: a fresh Stripe-hosted onboarding link (single use)
//   POST   /api/payments/stripe/sync {}            read the account back now
//   PUT    /api/payments/stripe/tax {enabled}      Stripe Tax on the seller's Checkouts (only once Stripe says active)
//   DELETE /api/payments/stripe?confirm=1          stop selling with Stripe here (no Stripe write: the seller keeps
//                                                  their account); 409 CONFIRM { offers } without confirm=1
//   owner: GET /api/payments/stripe/admin, POST /api/payments/stripe/admin/alerts/<kind>/resolve
//   GET    /connect/return, /connect/refresh       (app host) a fixed 302 into the app: never anywhere else
//
// Accounts (docs/integrations-setup.md "Stripe Connect"): POST /v1/accounts with controller[fees][payer]=account,
// controller[losses][payments]=stripe, controller[requirement_collection]=stripe,
// controller[stripe_dashboard][type]=full (the seller owns the account and sees the full Dashboard; Stripe charges its
// fees to the seller and backs negative balances; none of these can change later). Metadata carries the customer tag
// (never the raw user id) and the environment.
//
// Money rules:
// - The row is written BEFORE the one-shot create ('creating', with its Idempotency-Key). A timeout marks it 'unknown'
//   and the account is found again by its metadata (GET /v1/accounts, paged), never sent again by the server; a row
//   still not found 10 minutes on is deleted (pressing the button again is a new request). Pressing it again with the
//   same clientRequestId within 24 hours re-sends the same key: a person's retry, which Stripe answers with the first
//   answer if it went through.
// - Every write carries an Idempotency-Key; onboarding links are new every time (single use) and are never stored,
//   logged or emailed.
// - Requirements are kept as counts and codes only (requirement names can describe people).
// - Platform-level problems go to the owner: connect_alerts (Owner › Billing › Stripe Connect) and safeLog; customers
//   read our words, never Stripe's text, and only the owner sees a hint.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createStripeClient, StripeError, ACCOUNT_ID_RE } from '../billing/stripeClient.mjs';
import { customerTag, fail, IntegrationError, isUuid, notSetUp, safeLog, sha256 } from '../integrations/common.mjs';
import { SELLER_TERMS_PATH, SELLER_TERMS_READY, SELLER_TERMS_VERSION } from '../legal.mjs';
import { newId } from '../offers/store.mjs';
import { connectConfig } from './connectConfig.mjs';
import { feeForEntitlement } from './connectFee.mjs';

export const CONNECT_MIGRATION = 'supabase/migrations/20261118000000_stripe_connect.sql';
const COUNTRIES = JSON.parse(fs.readFileSync(new URL('../../shared/connect-countries.json', import.meta.url), 'utf8'));
export const CONNECT_COUNTRIES = Object.freeze([...COUNTRIES.countries]);
export const CONNECT_CONTROLLER = Object.freeze({ fees: { payer: 'account' }, losses: { payments: 'stripe' }, requirement_collection: 'stripe', stripe_dashboard: { type: 'full' } });
/** Statuses of a row that still counts as the seller's (one per user and environment). */
export const LIVE_STATUSES = Object.freeze(['creating', 'unknown', 'onboarding', 'restricted', 'active', 'rejected']);
const PENDING_MS = 2 * 60_000;
const GIVE_UP_MS = 10 * 60_000;
const SAME_KEY_MS = 24 * 3_600_000;
const READBACK_PAGES = 10;
/** A seller's own page polls while Stripe confirms: read Stripe back at most once a minute per row (the cron does the rest). */
const READBACK_EVERY_MS = 60_000;
const STUCK_RETURN_MS = 5 * 60_000;
/** Stripe's onboarding links: https on connect.stripe.com (or another stripe.com host), nothing else. */
export function validLinkUrl(raw, { testBase = null } = {}) {
  if (typeof raw !== 'string' || !raw || raw.length > 2000) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === 'https:' && u.port === '' && (u.hostname === 'connect.stripe.com' || u.hostname.endsWith('.stripe.com'))) return u.href;
  if (testBase) {
    try {
      if (u.origin === new URL(testBase).origin) return u.href;
    } catch {
      return null;
    }
  }
  return null;
}
export const ALERT_KINDS = Object.freeze(['connect_not_enabled', 'platform_profile_incomplete', 'key_missing_connect_permission', 'checkout_url_unexpected', 'webhook_secret_missing', 'fee_return_failed', 'fee_return_unknown', 'account_mismatch', 'fee_not_allowed_br', 'connect_no_public_url', 'connect_readback_lost', 'fee_return_reversed', 'link_url_unexpected']);
const ROW_COLUMNS = 'id,user_id,environment,stripe_account_id,status,country,default_currency,display_name,charges_enabled,payouts_enabled,details_submitted,requirements,tax_status,tax_enabled,payout_failed_at,terms_version,terms_accepted_at,create_key,create_started_at,last_event_at,synced_at,created_at,updated_at';

const MSG = Object.freeze({
  unavailable: 'Stripe payments aren’t available right now.',
  soon: 'Selling with Stripe opens soon.',
  country: 'Stripe doesn’t support sellers in that country yet.',
  tryAgain: 'Stripe didn’t answer. Try again in a minute.',
  confirming: 'We’re confirming your Stripe account. This takes a minute.',
  notConnected: 'Set up Stripe in Settings › Payments first.',
  taxNotReady: 'Finish Stripe Tax setup in your Stripe Dashboard (Tax → Settings), then try again.',
  needsInfo: 'Stripe needs more information before you can sell.',
});

/** An account's status from Stripe's account object (pure). */
export function statusOf(acct) {
  const reason = String(acct?.requirements?.disabled_reason ?? '');
  if (reason.startsWith('rejected.')) return 'rejected';
  if (acct?.charges_enabled === true) return 'active';
  if (acct?.details_submitted === true) return 'restricted';
  return 'onboarding';
}

/** Requirements as counts and codes only (never the names: they can describe people). */
export function requirementsOf(acct) {
  const q = acct?.requirements ?? {};
  const n = (v) => (Array.isArray(v) ? v.length : 0);
  const reason = typeof q.disabled_reason === 'string' && /^[a-z_.]{1,60}$/.test(q.disabled_reason) ? q.disabled_reason : null;
  const deadline = Number.isFinite(Number(q.current_deadline)) && Number(q.current_deadline) > 0 ? Number(q.current_deadline) : null;
  return { currently_due: n(q.currently_due), past_due: n(q.past_due), eventually_due: n(q.eventually_due), pending_verification: n(q.pending_verification), disabled_reason: reason, current_deadline: deadline };
}

/** What the browser sees of a row (never the full acct_ id: its last 4 is enough to tell accounts apart). */
export function accountView(r) {
  if (!r) return null;
  const q = r.requirements && typeof r.requirements === 'object' ? r.requirements : {};
  return {
    id: r.id,
    environment: r.environment,
    status: r.status,
    country: r.country,
    defaultCurrency: r.default_currency ?? null,
    displayName: r.display_name ?? '',
    chargesEnabled: r.charges_enabled === true,
    payoutsEnabled: r.payouts_enabled === true,
    detailsSubmitted: r.details_submitted === true,
    due: { now: Number(q.currently_due) || 0, pastDue: Number(q.past_due) || 0, later: Number(q.eventually_due) || 0, pending: Number(q.pending_verification) || 0 },
    deadline: q.current_deadline ? new Date(Number(q.current_deadline) * 1000).toISOString() : null,
    disabledReason: q.disabled_reason ?? null,
    taxEnabled: r.tax_enabled === true,
    taxStatus: r.tax_status ?? null,
    payoutFailedAt: r.payout_failed_at ?? null,
    accountLast4: r.stripe_account_id ? String(r.stripe_account_id).slice(-4) : '',
    termsVersion: r.terms_version ?? null,
    createdAt: r.created_at ?? null,
  };
}

/** The display name Stripe has for an account (business name, else the Dashboard's), at most 120 characters. */
const displayNameOf = (acct) => String(acct?.business_profile?.name || acct?.settings?.dashboard?.display_name || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 120);

/**
 * The shared Connect core: settings, the Stripe client, alerts, error mapping and the seller accounts.
 * deps: db, env, fetch, now, log, billing (entitlement, requireActive), stripe (tests: a client), sellerTermsReady
 * (tests), onAccountChanged(rowId) (the buy links' cache).
 */
export function createConnectCore({ db, env = process.env, fetch = globalThis.fetch, now = () => Date.now(), log = console, billing = null, stripe: stripeOverride = null, sellerTermsReady = SELLER_TERMS_READY, onAccountChanged = () => {} } = {}) {
  const stripe = stripeOverride ?? createStripeClient({ env, fetch });
  const cfg = connectConfig(env, { mode: stripe.enabled ? stripe.mode : null });
  const enabled = cfg.enabled && !!db?.enabled;
  const iso = (t = now()) => new Date(t).toISOString();
  const ms = (v) => (v == null ? null : Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
  const alertedAt = new Map();
  const readBackAt = new Map(); // row id → when its account was last looked for (the seller's polls)
  const testBase = stripe.mode === 'test' && String(env.STRIPE_API_BASE ?? '').trim() ? String(env.STRIPE_API_BASE).trim() : null;

  /**
   * An owner alert: a log line and the connect_alerts row (best effort; codes only, never a key, an email or a cs_ id).
   * oncePerMs: at most one row update per kind in that time on this server copy.
   */
  async function alert(kind, detail = {}, { oncePerMs = 0 } = {}) {
    safeLog(`connect_alert_${kind}`, detail, log);
    if (oncePerMs && now() - (alertedAt.get(kind) ?? -Infinity) < oncePerMs) return;
    alertedAt.set(kind, now());
    const clean = {};
    for (const [k, v] of Object.entries(detail ?? {})) if (/^[a-z_]{1,30}$/.test(k) && (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 120 && !/sk_|rk_|whsec_|cs_(test|live)_|@/.test(v)))) clean[k] = v;
    try {
      await db.rpc('connect_alert', { p_kind: kind, p_detail: clean });
    } catch (e) {
      safeLog('connect_alert_write_failed', { kind, code: e?.code }, log);
    }
  }

  /**
   * A Stripe failure in our words (IntegrationError): platform problems also alert the owner (with a hint for them).
   * where: 'accounts' | 'link' | 'checkout' | 'read' | 'tax' | 'fee'.
   */
  function mapStripeError(e, where = 'read') {
    if (e instanceof IntegrationError) return e;
    if (!(e instanceof StripeError)) return fail(503, 'UNAVAILABLE', MSG.tryAgain);
    if (e.kind === 'config') return notSetUp(`Stripe Connect needs: ${cfg.missing().join(', ') || 'STRIPE_SECRET_KEY'}.`, MSG.unavailable);
    if (e.kind === 'auth') {
      void alert('key_missing_connect_permission', { where, status: e.status });
      return fail(503, 'NOT_SET_UP', MSG.unavailable, {}, 'Stripe refused the key for Connect: add the Connect permissions (accounts, account links, Checkout on connected accounts, application fees) to the restricted key, or use a secret key. See docs/integrations-setup.md "Stripe Connect".');
    }
    if (['rate', 'server', 'network'].includes(e.kind)) return fail(503, 'UNAVAILABLE', MSG.tryAgain);
    const code = String(e.code ?? '');
    if (where === 'accounts') {
      if (/country/.test(code)) return fail(400, 'BAD_COUNTRY', MSG.country);
      // the exact codes for "Connect isn't enabled" and "the platform profile isn't finished" are UNCONFIRMED: an
      // invalid request with no other reason on /v1/accounts is a platform problem
      const kind = /profile|questionnaire|platform/.test(code) ? 'platform_profile_incomplete' : 'connect_not_enabled';
      void alert(kind, { code: code.slice(0, 60) || 'none', status: e.status });
      return fail(503, 'NOT_SET_UP', MSG.unavailable, {}, kind === 'connect_not_enabled' ? 'Stripe refused to make a connected account: turn on Connect in the Stripe Dashboard (Connect → Get started) and finish the platform profile.' : 'Finish the Connect platform profile in the Stripe Dashboard (Settings → Connect → Platform profile).');
    }
    if (where === 'checkout' && (code === 'account_invalid' || /capabilit/.test(code))) return fail(409, 'STRIPE_SETUP', MSG.needsInfo, { sellerSync: true });
    return fail(502, 'STRIPE_REFUSED', 'Stripe didn’t accept that. Try again later.');
  }

  // ───────────── rows ─────────────

  /** The user's live row in this environment (any live status), or null. */
  async function liveRow(userId) {
    const rows = await db.select('connect_accounts', { user_id: userId, environment: cfg.environment, status: ['neq', 'disconnected'] }, { select: ROW_COLUMNS, limit: 1 });
    return rows[0] ?? null;
  }
  async function rowById(id) {
    const rows = await db.select('connect_accounts', { id }, { select: ROW_COLUMNS, limit: 1 });
    return rows[0] ?? null;
  }
  async function rowByAccount(accountId) {
    if (!ACCOUNT_ID_RE.test(String(accountId ?? ''))) return null;
    const rows = await db.select('connect_accounts', { environment: cfg.environment, stripe_account_id: accountId }, { select: ROW_COLUMNS, limit: 1 });
    return rows[0] ?? null;
  }
  async function patchRow(row, patch) {
    const [saved] = await db.update('connect_accounts', { id: row.id, user_id: row.user_id }, patch, { returning: true });
    return saved ?? { ...row, ...patch };
  }

  /** Apply what Stripe says about an account to its row (a disconnected row keeps its status). */
  async function applyAccount(row, acct, extra = {}) {
    const patch = {
      ...(row.status === 'disconnected' ? {} : { status: statusOf(acct) }),
      charges_enabled: acct.charges_enabled === true,
      payouts_enabled: acct.payouts_enabled === true,
      details_submitted: acct.details_submitted === true,
      requirements: requirementsOf(acct),
      default_currency: /^[a-z]{3}$/.test(String(acct.default_currency ?? '')) ? acct.default_currency : row.default_currency ?? null,
      display_name: displayNameOf(acct) || row.display_name || '',
      synced_at: iso(),
      ...extra,
    };
    const saved = await patchRow(row, patch);
    if ((row.charges_enabled === true) !== patch.charges_enabled || row.status !== saved.status) onAccountChanged(row.id);
    return saved;
  }

  /** Read an account back now and apply it. Throws the mapped error. */
  async function syncRow(row) {
    if (!row?.stripe_account_id) return row;
    let acct;
    try {
      acct = await stripe.get(`/v1/accounts/${encodeURIComponent(row.stripe_account_id)}`);
    } catch (e) {
      throw mapStripeError(e, 'read');
    }
    if (acct?.id !== row.stripe_account_id) throw fail(503, 'UNAVAILABLE', MSG.tryAgain);
    return applyAccount(row, acct);
  }

  /** The tag accounts carry in their metadata (customer tag: never the raw user id). */
  const tagOf = (userId) => customerTag(userId, env);
  const createKeyFor = (userId, clientRequestId) => `ylb-connect-acct:${sha256(`${userId}:${cfg.environment}:${clientRequestId}`).slice(0, 40)}`;
  /** The create's own mark in the account's metadata (from its Idempotency-Key): the read-back matches this one. */
  const reqTagOf = (createKey) => sha256(`req:${createKey}`).slice(0, 24);

  /** A new account for a seller who stopped selling here before: their old Stripe offers move to it (still paused). */
  async function adoptOffers(row) {
    try {
      const old = await db.select('connect_accounts', { user_id: row.user_id, environment: row.environment, status: 'disconnected' }, { select: 'id', limit: 50 });
      const ids = old.map((r) => r.id).filter((id) => id !== row.id);
      if (ids.length) await db.update('offers', { user_id: row.user_id, provider: 'stripe', connect_account_id: ['in', ids] }, { connect_account_id: row.id });
    } catch (e) {
      safeLog('connect_offers_move_failed', { code: e?.code }, log);
    }
  }

  /**
   * A row whose create didn't answer ('unknown', or 'creating' too long): find the account by its metadata (read
   * only, never re-sent). → the row adopted, the row as it was (not found yet), or null (not found after 10 minutes:
   * the row is deleted).
   */
  async function readBack(row) {
    const tag = tagOf(row.user_id);
    let after = null;
    let found = null;
    for (let page = 0; page < READBACK_PAGES && !found; page++) {
      let list;
      try {
        list = await stripe.get('/v1/accounts', { limit: 100, ...(after ? { starting_after: after } : {}) });
      } catch (e) {
        safeLog('connect_readback_failed', { kind: e?.kind, code: e?.code }, log);
        return row;
      }
      const data = Array.isArray(list?.data) ? list.data : [];
      // this user's accounts in this environment, made by this create (an older account of theirs, e.g. one they
      // stopped selling with, is another row's: skipped, and the search goes on)
      for (const a of data) {
        if (a?.metadata?.ylb_tag !== tag || a?.metadata?.ylb_env !== cfg.environment || !ACCOUNT_ID_RE.test(String(a.id))) continue;
        if (a.metadata.ylb_req && a.metadata.ylb_req !== reqTagOf(row.create_key)) continue;
        const other = await rowByAccount(a.id);
        if (other && other.id !== row.id) continue;
        found = a;
        break;
      }
      if (found || !list?.has_more || !data.length) break;
      after = data.at(-1).id;
    }
    if (found) {
      safeLog('connect_account_adopted', { env: cfg.environment }, log);
      const saved = await applyAccount(row, found, { stripe_account_id: found.id, status: statusOf(found) });
      await adoptOffers(saved);
      return saved;
    }
    if (now() - (ms(row.create_started_at) ?? now()) >= GIVE_UP_MS) {
      // the create may still have gone through (a read that missed it): the owner checks for an account with no seller
      // before this seller makes another
      await alert('connect_readback_lost', { env: cfg.environment });
      await db.remove('connect_accounts', { id: row.id, user_id: row.user_id, status: ['in', ['creating', 'unknown']] });
      safeLog('connect_readback_not_found', { env: cfg.environment }, log);
      return null;
    }
    return row;
  }

  /**
   * The one-shot create of a row inserted just before (or a person's same-key retry: the stored body again, the
   * business name from the row). → { status, row }.
   */
  async function sendCreate(row, who, { country, businessName }) {
    const body = {
      controller: CONNECT_CONTROLLER,
      country,
      ...(who.email ? { email: String(who.email).slice(0, 254) } : {}),
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      ...(businessName ? { business_profile: { name: businessName } } : {}),
      metadata: { ylb_tag: tagOf(who.id), ylb_env: cfg.environment, ylb_req: reqTagOf(row.create_key) },
    };
    const got = await stripe.post('/v1/accounts', body, { idempotencyKey: row.create_key });
    if (got.outcome === 'ok' && ACCOUNT_ID_RE.test(String(got.value?.id ?? ''))) {
      const acct = got.value;
      const other = await rowByAccount(acct.id);
      if (other && other.id !== row.id) {
        void alert('account_mismatch', { where: 'create' });
        throw fail(409, 'CONFLICT', MSG.tryAgain);
      }
      const saved = await applyAccount(row, acct, { stripe_account_id: acct.id, status: statusOf(acct) });
      await adoptOffers(saved);
      safeLog('connect_account_created', { env: cfg.environment }, log);
      return { status: 200, row: saved };
    }
    if (got.outcome === 'failed' && (got.status === 409 || got.error?.type === 'idempotency_error' || /^idempotency/.test(String(got.error?.code ?? '')))) {
      // the same key still in flight, or Stripe refusing it: not a refusal of the account. Keep the row and read back.
      const saved = await patchRow(row, { status: 'unknown' });
      safeLog('connect_account_key_busy', { env: cfg.environment, status: got.status }, log);
      return { status: 202, row: saved };
    }
    if (got.outcome === 'failed') {
      await db.remove('connect_accounts', { id: row.id, user_id: row.user_id, status: 'creating' });
      throw mapStripeError(got.error, 'accounts');
    }
    // timeout, a dropped connection or a 5xx: it may have gone through. Read back, never re-send.
    const saved = await patchRow(row, { status: 'unknown' });
    safeLog('connect_account_unknown', { env: cfg.environment, reason: got.reason ?? 'unknown' }, log);
    return { status: 202, row: saved };
  }

  async function ensureEntitlement(who) {
    if (!billing?.entitlement) return null;
    try {
      // this also makes the owner's billing row, so the owner's fee (0) is known at buy time with no one signed in
      return await billing.entitlement(who.id, who);
    } catch {
      throw fail(503, 'UNAVAILABLE', 'Couldn’t check your plan just now. Try again in a minute.');
    }
  }

  /** POST /api/payments/stripe. needsActive(who): the plan gate (402). */
  async function create(who, b, { needsActive }) {
    if (!cfg.ready) throw notSetUp(`Stripe Connect needs: ${cfg.missing().join(', ')}.`, MSG.unavailable);
    await ensureEntitlement(who);
    if (!sellerTermsReady && who.isAdmin !== true) throw fail(503, 'NOT_SET_UP', MSG.soon, {}, `Publish the seller terms first: review the draft at ${SELLER_TERMS_PATH} (server/legal.mjs), then set SELLER_TERMS_READY.`);
    await needsActive(who);
    const country = typeof b.country === 'string' ? b.country.trim().toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(country) || !CONNECT_COUNTRIES.includes(country)) throw fail(400, 'BAD_COUNTRY', MSG.country);
    if (b.acceptTerms !== true) throw fail(400, 'TERMS_REQUIRED', 'Accept the seller terms to keep going.');
    const crid = String(b.clientRequestId ?? '');
    if (!isUuid(crid)) throw fail(400, 'BAD_REQUEST', 'clientRequestId must be a UUID.');
    let businessName = '';
    if (b.businessName !== undefined) {
      if (typeof b.businessName !== 'string' || b.businessName.length > 480) throw fail(400, 'BAD_REQUEST', 'The business name is too long.');
      businessName = b.businessName.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    }
    const key = createKeyFor(who.id, crid);

    let existing = await liveRow(who.id);
    if (existing && ['active', 'onboarding', 'restricted', 'rejected'].includes(existing.status)) return { status: 200, row: existing };
    if (existing) {
      const age = now() - (ms(existing.create_started_at) ?? now());
      if (existing.status === 'creating' && age < PENDING_MS) throw fail(409, 'PENDING', MSG.confirming);
      const found = await readBack(existing);
      if (found && !['creating', 'unknown'].includes(found.status)) return { status: 200, row: found };
      if (found) {
        // a person pressing again with the same request within 24 hours: the same key, sent once more
        if (found.create_key === key && age < SAME_KEY_MS) {
          const sending = await patchRow(found, { status: 'creating' });
          // the stored body: the same key must carry the same parameters (never this request's business name)
          return sendCreate(sending, who, { country: found.country, businessName: found.display_name ?? '' });
        }
        return { status: 202, row: found };
      }
      existing = null;
    }
    let row;
    try {
      [row] = await db.insert('connect_accounts', { id: newId(), user_id: who.id, environment: cfg.environment, status: 'creating', country, display_name: businessName, terms_version: SELLER_TERMS_VERSION, terms_accepted_at: iso(), create_key: key, create_started_at: iso() }, { returning: true });
    } catch (e) {
      if (e?.code === 'CONFLICT') throw fail(409, 'PENDING', MSG.confirming);
      throw e;
    }
    return sendCreate(row, who, { country, businessName });
  }

  /** POST /api/payments/stripe/onboarding → { url }. origin: the app's public origin. */
  async function onboardingLink(who, origin) {
    if (!cfg.ready) throw notSetUp(`Stripe Connect needs: ${cfg.missing().join(', ')}.`, MSG.unavailable);
    const row = await liveRow(who.id);
    if (!row?.stripe_account_id) throw fail(409, row ? 'PENDING' : 'STRIPE_NOT_CONNECTED', row ? MSG.confirming : MSG.notConnected);
    if (row.status === 'rejected') throw fail(409, 'STRIPE_REJECTED', 'Stripe closed this account. Check your email from Stripe.');
    if (cfg.live && !String(origin).startsWith('https://')) {
      void alert('connect_no_public_url', { where: 'link' });
      throw notSetUp('Set APP_PUBLIC_URL to the app’s https address.', MSG.unavailable);
    }
    const got = await stripe.post('/v1/account_links', { account: row.stripe_account_id, type: 'account_onboarding', collection_options: { fields: 'eventually_due' }, refresh_url: `${origin}/connect/refresh`, return_url: `${origin}/connect/return` }, { idempotencyKey: `ylb-connect-link:${row.id}:${crypto.randomBytes(16).toString('hex')}` });
    if (got.outcome === 'ok') {
      // the browser is sent there: Stripe's own hosts only, checked here (not only in the app)
      const href = validLinkUrl(got.value?.url, { testBase });
      if (href) return { url: href };
      let host = '';
      try {
        host = new URL(String(got.value?.url ?? '')).host.slice(0, 120);
      } catch {
        host = 'unreadable';
      }
      void alert('link_url_unexpected', { host });
      throw fail(503, 'UNAVAILABLE', MSG.unavailable);
    }
    if (got.outcome === 'failed') throw mapStripeError(got.error, 'link');
    // a new click makes a new link: harmless
    throw fail(503, 'UNAVAILABLE', 'Try again.');
  }

  /** The seller's row after a read-back of an unclear create (GET /api/payments/stripe does this), or null. */
  async function current(userId) {
    let row = await liveRow(userId);
    if (row && (row.status === 'unknown' || (row.status === 'creating' && now() - (ms(row.create_started_at) ?? now()) >= PENDING_MS))) {
      // the seller's page asks every few seconds: Stripe is read at most once a minute per row
      if (now() - (readBackAt.get(row.id) ?? -Infinity) < READBACK_EVERY_MS) return row;
      readBackAt.set(row.id, now());
      while (readBackAt.size > 5000) readBackAt.delete(readBackAt.keys().next().value);
      row = await readBack(row);
    }
    return row;
  }

  async function view(who) {
    let ent = null;
    try {
      ent = billing?.entitlement ? await billing.entitlement(who.id, who) : null;
    } catch {
      ent = null;
    }
    const row = enabled ? await current(who.id) : null;
    return {
      available: enabled && cfg.ready && (sellerTermsReady || who.isAdmin === true),
      environment: cfg.environment,
      account: accountView(row),
      fee: ent ? feeForEntitlement(ent) : null,
      termsUrl: SELLER_TERMS_PATH,
      termsVersion: SELLER_TERMS_VERSION,
      termsReady: sellerTermsReady,
      countries: CONNECT_COUNTRIES,
    };
  }

  async function sync(who) {
    const row = await liveRow(who.id);
    if (!row) throw fail(409, 'STRIPE_NOT_CONNECTED', MSG.notConnected);
    if (!row.stripe_account_id) return { account: accountView(await current(who.id)) };
    const saved = await syncRow(row);
    if (saved.tax_enabled) await refreshTax(saved).catch(() => null);
    return { account: accountView(await rowById(row.id)) };
  }

  /** Re-read an account's tax settings (Stripe-Account) and store the status. */
  async function refreshTax(row) {
    const t = await stripe.get('/v1/tax/settings', {}, { account: row.stripe_account_id });
    const status = t?.status === 'active' ? 'active' : 'pending';
    return patchRow(row, { tax_status: status, ...(status === 'active' ? {} : { tax_enabled: false }) });
  }

  async function setTax(who, b) {
    if (typeof b.enabled !== 'boolean') throw fail(400, 'BAD_REQUEST', 'enabled must be true or false.');
    const row = await liveRow(who.id);
    if (!row?.stripe_account_id) throw fail(409, 'STRIPE_NOT_CONNECTED', MSG.notConnected);
    if (!b.enabled) return { account: accountView(await patchRow(row, { tax_enabled: false })) };
    let t;
    try {
      t = await stripe.get('/v1/tax/settings', {}, { account: row.stripe_account_id });
    } catch (e) {
      throw mapStripeError(e, 'tax');
    }
    if (t?.status !== 'active') {
      await patchRow(row, { tax_status: 'pending', tax_enabled: false });
      throw fail(409, 'TAX_NOT_READY', MSG.taxNotReady);
    }
    const saved = await patchRow(row, { tax_status: 'active', tax_enabled: true });
    onAccountChanged(row.id);
    return { account: accountView(saved) };
  }

  /** The row's Stripe offers that sell now (active), and pausing them. */
  async function liveOffers(row) {
    return db.select('offers', { user_id: row.user_id, connect_account_id: row.id, status: 'active' }, { select: 'id', limit: 1000 });
  }
  async function stopSelling(row) {
    await patchRow(row, { status: 'disconnected' });
    await db.update('offers', { user_id: row.user_id, connect_account_id: row.id, status: 'active' }, { status: 'paused' });
    onAccountChanged(row.id);
  }

  async function disconnect(who, { confirm }) {
    const row = await liveRow(who.id);
    if (!row) return { ok: true, account: null };
    const offers = await liveOffers(row);
    if (!confirm) throw fail(409, 'CONFIRM', `This pauses ${offers.length} Stripe buy link${offers.length === 1 ? '' : 's'}. Your Stripe account stays yours.`, { offers: offers.length });
    await stopSelling(row);
    safeLog('connect_account_disconnected', { env: cfg.environment, by: 'seller' }, log);
    return { ok: true, account: null, paused: offers.length };
  }

  /** account.application.deauthorized: the seller removed us from their Stripe account. */
  async function deauthorized(row) {
    if (row.status === 'disconnected') return 'kept';
    await stopSelling(row);
    safeLog('connect_account_disconnected', { env: cfg.environment, by: 'stripe' }, log);
    return 'disconnected';
  }

  // ───────────── the owner's view ─────────────

  let connectCheck = { at: 0, value: null };
  /** Whether Stripe lets this key make connected accounts (a cached read: a refusal says it isn't enabled). */
  async function connectEnabledCheck() {
    if (now() - connectCheck.at < 5 * 60_000) return connectCheck.value;
    let value = null;
    try {
      await stripe.get('/v1/accounts', { limit: 1 });
      value = true;
    } catch (e) {
      value = e instanceof StripeError && ['auth', 'invalid'].includes(e.kind) ? false : null;
    }
    connectCheck = { at: now(), value };
    return value;
  }

  /** GET /api/payments/stripe/admin (owner only): setup, sellers, our fees, fee returns to check, alerts. */
  async function adminView({ emailFor = async () => '' } = {}) {
    const environment = cfg.environment;
    const setup = { environment, missing: cfg.missing(), publicUrlOk: cfg.publicUrlOk, sellerTermsReady, termsVersion: SELLER_TERMS_VERSION, returnFees: cfg.returnFees, connectEnabled: enabled ? await connectEnabledCheck() : null, webhookLastAt: null };
    if (!enabled) return { setup, accounts: { counts: {}, sellers: [] }, fees: { currencies: {}, returns: [] }, alerts: [] };
    const rows = await db.select('connect_accounts', { environment }, { select: ROW_COLUMNS, order: 'created_at.desc', limit: 1000 });
    const counts = {};
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    setup.webhookLastAt = rows.map((r) => r.last_event_at).filter(Boolean).sort().at(-1) ?? null;
    const since30 = iso(now() - 30 * 86_400_000);
    const d = new Date(now());
    const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
    const sales = await db.select('sales', { provider: 'stripe', environment, created_at: ['gte', since30 < monthStart ? since30 : monthStart] }, { select: 'user_id,status,amount_minor,currency,application_fee_minor,fee_returned_minor,created_at', limit: 10000 });
    const counted = ['paid', 'partially_refunded', 'refunded', 'disputed'];
    const currencies = {};
    const bySeller = new Map();
    for (const x of sales) {
      if (!counted.includes(x.status)) continue;
      const cur = String(x.currency);
      currencies[cur] ??= { last30: { fees: 0, returned: 0, net: 0 }, monthToDate: { fees: 0, returned: 0, net: 0 } };
      const fee = Number(x.application_fee_minor) || 0;
      const back = Number(x.fee_returned_minor) || 0;
      for (const [k, from] of [['last30', since30], ['monthToDate', monthStart]]) {
        if (String(x.created_at) < from) continue;
        currencies[cur][k].fees += fee;
        currencies[cur][k].returned += back;
        currencies[cur][k].net += fee - back;
      }
      if (String(x.created_at) >= since30) {
        const m = bySeller.get(x.user_id) ?? { count: 0, gross: {}, fees: {} };
        m.count++;
        m.gross[cur] = (m.gross[cur] ?? 0) + (Number(x.amount_minor) || 0);
        m.fees[cur] = (m.fees[cur] ?? 0) + fee - back;
        bySeller.set(x.user_id, m);
      }
    }
    const sellers = [];
    for (const r of rows.filter((x) => x.status !== 'disconnected').slice(0, 100)) {
      const q = r.requirements ?? {};
      let tag = '';
      try {
        tag = tagOf(r.user_id);
      } catch {
        tag = '';
      }
      sellers.push({ customerTag: tag, email: await emailFor(r.user_id).catch(() => ''), status: r.status, country: r.country, chargesEnabled: r.charges_enabled === true, payoutsEnabled: r.payouts_enabled === true, dueNow: Number(q.currently_due) || 0, last30: bySeller.get(r.user_id) ?? { count: 0, gross: {}, fees: {} } });
    }
    // to check: unclear, refused, waiting, left 'sending' (the hourly job reads those back), or reversed afterwards
    const returns = (await db.select('connect_fee_returns', { environment, state: ['in', ['unknown', 'failed', 'skipped', 'sending']] }, { select: 'source_id,state,amount_minor,error_code,created_at,updated_at', order: 'created_at.desc', limit: 100 })).filter((r) => r.state !== 'sending' || now() - (Date.parse(r.updated_at ?? '') || now()) >= STUCK_RETURN_MS);
    const reversed = await db.select('connect_fee_returns', { environment, state: 'ok', error_code: 'refund_reversed' }, { select: 'source_id,state,amount_minor,error_code,created_at,updated_at', order: 'created_at.desc', limit: 50 });
    returns.push(...reversed);
    const alerts = await db.select('connect_alerts', { resolved_at: null }, { order: 'last_at.desc', limit: 100 });
    return {
      setup,
      accounts: { counts, sellers },
      fees: { currencies, returns: returns.map((r) => ({ sourceId: r.source_id, state: r.state, amountMinor: Number(r.amount_minor) || 0, errorCode: r.error_code ?? null, createdAt: r.created_at ?? null })) },
      alerts: alerts.map((a) => ({ kind: a.kind, count: Number(a.count) || 0, firstAt: a.first_at, lastAt: a.last_at, detail: a.detail ?? {} })),
    };
  }

  /** POST /api/payments/stripe/admin/alerts/<kind>/resolve (owner only). */
  async function resolveAlert(kind) {
    if (!/^[a-z0-9_]{1,60}$/.test(String(kind ?? ''))) throw fail(404, 'NOT_FOUND', 'No such alert.');
    const done = await db.update('connect_alerts', { kind, resolved_at: null }, { resolved_at: iso() }, { returning: true });
    return { ok: true, resolved: done.length };
  }

  // ───────────── cron ─────────────

  /** Rows whose create didn't answer: read back (never re-sent). */
  async function cronReadback() {
    if (!enabled) return { checked: 0 };
    const rows = await db.select('connect_accounts', { environment: cfg.environment, status: ['in', ['creating', 'unknown']] }, { select: ROW_COLUMNS, limit: 100 });
    let adopted = 0;
    let removed = 0;
    for (const r of rows) {
      if (r.status === 'creating' && now() - (ms(r.create_started_at) ?? now()) < PENDING_MS) continue;
      const out = await readBack(r);
      if (out === null) removed++;
      else if (!['creating', 'unknown'].includes(out.status)) adopted++;
    }
    return { checked: rows.length, adopted, removed };
  }

  /** Active and restricted accounts, least recently synced first (200 a run); tax status for tax_enabled ones. */
  async function cronSync(ctx = {}) {
    if (!enabled) return { synced: 0 };
    const deadline = ctx.deadline ?? now() + 60_000;
    const rows = await db.select('connect_accounts', { environment: cfg.environment, status: ['in', ['active', 'restricted', 'onboarding']] }, { select: ROW_COLUMNS, order: 'synced_at.asc.nullsfirst', limit: 200 });
    let synced = 0;
    for (const r of rows) {
      if (now() > deadline) break;
      try {
        const saved = await syncRow(r);
        if (saved.tax_enabled) await refreshTax(saved);
        synced++;
      } catch (e) {
        safeLog('connect_sync_failed', { code: e?.code }, log);
      }
    }
    return { synced };
  }

  return {
    cfg,
    enabled,
    stripe,
    alert,
    mapStripeError,
    tagOf,
    rows: { liveRow, rowById, rowByAccount, patchRow, applyAccount, syncRow, readBack, liveOffers, stopSelling, columns: ROW_COLUMNS },
    create,
    onboardingLink,
    view,
    current,
    sync,
    setTax,
    refreshTax,
    disconnect,
    deauthorized,
    cronReadback,
    cronSync,
    adminView,
    resolveAlert,
    sellerTermsReady,
    MSG,
  };
}

/** /connect/return and /connect/refresh on the app's host: a fixed 302 into the app (nothing read from the request). */
export function serveConnectReturn(req, res, url) {
  const p = url.pathname;
  if (p !== '/connect/return' && p !== '/connect/refresh') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const to = p === '/connect/return' ? '/#settings/payments?stripe=return' : '/#settings/payments?stripe=refresh';
  res.writeHead(302, { location: to, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex', 'content-security-policy': "default-src 'none'", 'content-length': 0 });
  res.end();
  return true;
}
