// Stripe Connect events (P6): POST /api/webhooks/stripe-connect (its own signing secret), our fee events from the P1
// endpoint (application_fee.*, the platform's), giving our fee back after refunds and lost disputes, and the cron
// jobs that read back what didn't answer and catch lost webhooks.
//
// The order is P1's (server/billing/stripe.mjs): rate limit → raw body (256 KB) → 503 when not set up → the signature
// on the raw bytes with STRIPE_CONNECT_WEBHOOK_SECRET (or _PREVIOUS) only → JSON → livemode must match the key's →
// an acct_ account → dedupe (webhook_deliveries 'stripe-connect:<evt id>') → process → the delivery row → 200. Any
// failure while processing answers 500 with no delivery row, so Stripe delivers it again.
//
// Nothing in a payload is trusted: each event names an object that is read back from Stripe (with Stripe-Account),
// and a sale is recorded only for an offer whose seller account is the event's.
//
// Our fee back (returnFee): once per refund or lost dispute, floor(fee × money back / amount), capped at what's
// left. The connect_fee_returns row is written BEFORE the one-shot POST /v1/application_fees/:id/refunds (its
// Idempotency-Key 'ylb-fee-return:<env>:<source>' and metadata ylb_source); an unclear answer ('unknown') is read back
// hourly (GET …/refunds by metadata), never sent again. CONNECT_RETURN_FEES=off keeps our fee.

import { ACCOUNT_ID_RE } from '../billing/stripeClient.mjs';
import { verifyStripeSignature } from '../billing/stripe.mjs';
import { safeLog, sha256 } from '../integrations/common.mjs';
import { feeShare } from './connectFee.mjs';
import { saleFromSession } from '../offers/stripeCheckout.mjs';

const EVENT_ID = /^evt_[A-Za-z0-9]+$/;
const DAY_MS = 86_400_000;
/** A fee return still 'sending' after this is read back as 'unknown' (never sent again). */
export const STUCK_MS = 5 * 60_000;
const SALE_COLUMNS = 'id,user_id,project_id,offer_id,environment,provider_account,provider_payment_id,status,amount_minor,refunded_minor,application_fee_minor,application_fee_id,fee_returned_minor,currency,checkout_session_id,created_at';
const OFFER_COLUMNS = 'id,user_id,project_id,title,provider,connect_account_id';
export const CONNECT_EVENTS = Object.freeze(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'charge.refunded', 'charge.refund.updated', 'account.updated', 'account.application.deauthorized', 'payout.failed']);

const idOf = (v) => (typeof v === 'string' ? v : v?.id ?? null);

/** deps: db, connect (the core), now, log. */
export function createConnectWebhook({ db, connect, now = () => Date.now(), log = console }) {
  const cfg = connect.cfg;
  const stripe = connect.stripe;
  const iso = (t = now()) => new Date(t).toISOString();
  const env = () => cfg.environment;

  // ───────────── sales ─────────────

  async function offerOf(id) {
    if (!/^[A-Za-z0-9_-]{22}$/.test(String(id ?? ''))) return null;
    const [o] = await db.select('offers', { id }, { select: OFFER_COLUMNS, limit: 1 });
    return o ?? null;
  }
  /** The offer is the account row's (same account, same user), or null (and an owner alert). */
  async function ownOffer(row, offerId) {
    const offer = await offerOf(offerId);
    if (!offer || offer.provider !== 'stripe' || offer.connect_account_id !== row.id || offer.user_id !== row.user_id) {
      void connect.alert('account_mismatch', { where: 'event' });
      return null;
    }
    return offer;
  }
  async function saleByPayment(row, pi) {
    const [s] = await db.select('sales', { provider: 'stripe', environment: env(), provider_payment_id: pi, user_id: row.user_id }, { select: SALE_COLUMNS, limit: 1 });
    return s ?? null;
  }

  /** A checkout.session.* event: read the session back and record the sale. */
  async function onSession(row, evt) {
    const sid = idOf(evt.data?.object);
    if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(String(sid ?? ''))) return 'ignored';
    const session = await stripe.get(`/v1/checkout/sessions/${encodeURIComponent(sid)}`, { 'expand[]': ['payment_intent.latest_charge'] }, { account: row.stripe_account_id });
    if (session?.mode !== 'payment' || session.livemode !== cfg.live) return 'ignored';
    const offer = await ownOffer(row, session.metadata?.ylb_offer);
    if (!offer || session.client_reference_id !== offer.id) return 'not_ours';
    const status = evt.type === 'checkout.session.async_payment_failed' ? 'failed' : evt.type === 'checkout.session.async_payment_succeeded' || session.payment_status === 'paid' ? 'paid' : 'pending';
    if (status === 'pending' && session.status !== 'complete') return 'ignored';
    const p = saleFromSession(session, offer, row, { status, at: (Number(evt.created) || 0) * 1000 || now() });
    if (!/^pi_[A-Za-z0-9]+$/.test(String(p.provider_payment_id ?? ''))) return 'ignored';
    return `sale_${await db.rpc('record_sale', { p })}`;
  }

  /**
   * A sale not recorded yet (an event before the payment's): made from the PaymentIntent's own metadata and the
   * charge, or null.
   */
  async function saleFromCharge(row, charge, status, at) {
    const piId = idOf(charge.payment_intent);
    if (!/^pi_[A-Za-z0-9]+$/.test(String(piId ?? ''))) return null;
    const existing = await saleByPayment(row, piId);
    if (existing) return existing;
    const pi = await stripe.get(`/v1/payment_intents/${encodeURIComponent(piId)}`, {}, { account: row.stripe_account_id });
    const offer = await ownOffer(row, pi?.metadata?.ylb_offer);
    if (!offer) return null;
    const fee = Number(charge.application_fee_amount ?? pi.application_fee_amount);
    await db.rpc('record_sale', {
      p: {
        user_id: row.user_id,
        project_id: offer.project_id,
        offer_id: offer.id,
        provider: 'stripe',
        environment: env(),
        provider_account: row.stripe_account_id,
        provider_payment_id: piId,
        status,
        amount_minor: Number(charge.amount) || 0,
        refunded_minor: Number(charge.amount_refunded) || 0,
        application_fee_minor: Number.isSafeInteger(fee) && fee > 0 ? fee : null,
        application_fee_id: /^fee_[A-Za-z0-9]+$/.test(String(idOf(charge.application_fee) ?? '')) ? idOf(charge.application_fee) : null,
        currency: String(charge.currency ?? '').toLowerCase(),
        buyer_email: typeof charge.billing_details?.email === 'string' ? charge.billing_details.email.slice(0, 254) : null,
        paid_at: new Date((Number(charge.created) || at / 1000) * 1000).toISOString(),
        last_event_at: new Date(at).toISOString(),
      },
    });
    return saleByPayment(row, piId);
  }

  /** charge.refunded / charge.refund.updated: the charge's refunds, the sale's status, and our fee back. */
  async function onRefund(row, evt) {
    const obj = evt.data?.object ?? {};
    const chargeId = evt.type === 'charge.refund.updated' ? idOf(obj.charge) : idOf(obj);
    if (!/^(ch|py)_[A-Za-z0-9]+$/.test(String(chargeId ?? ''))) return 'ignored';
    const charge = await stripe.get(`/v1/charges/${encodeURIComponent(chargeId)}`, { 'expand[]': ['refunds'] }, { account: row.stripe_account_id });
    const at = (Number(evt.created) || 0) * 1000 || now();
    const amount = Number(charge.amount) || 0;
    const refunded = Math.min(amount, Number(charge.amount_refunded) || 0);
    const status = refunded >= amount && amount > 0 ? 'refunded' : refunded > 0 ? 'partially_refunded' : 'paid';
    let sale = await saleFromCharge(row, charge, status, at);
    if (!sale) return 'not_ours';
    await db.rpc('record_sale', { p: { user_id: sale.user_id, project_id: sale.project_id, offer_id: sale.offer_id, provider: 'stripe', environment: env(), provider_account: row.stripe_account_id, provider_payment_id: sale.provider_payment_id, status, amount_minor: amount, refunded_minor: refunded, currency: sale.currency, last_event_at: new Date(at).toISOString() } });
    sale = await saleByPayment(row, sale.provider_payment_id);
    const refunds = (Array.isArray(charge.refunds?.data) ? charge.refunds.data : []).filter((r) => /^(re|pyr)_[A-Za-z0-9]+$/.test(String(r?.id ?? '')));
    if (refunds.length) {
      await db.insert('sale_refunds', refunds.map((r) => ({ provider: 'stripe', environment: env(), refund_id: r.id, provider_payment_id: sale.provider_payment_id, user_id: sale.user_id, amount_minor: Math.max(0, Number(r.amount) || 0) })), { ignoreDuplicates: true, onConflict: 'provider,environment,refund_id' });
    }
    for (const r of refunds) if (r.status === 'succeeded' && /^re_/.test(r.id)) sale = (await returnFee(sale, r.id, Number(r.amount) || 0)) ?? sale;
    // a refund that failed (or was cancelled) after our fee went back: the seller keeps it; the owner decides (never
    // reversed here). Marked once per refund, so a repeat event doesn't alert again.
    for (const r of refunds) {
      if (!['failed', 'canceled'].includes(r.status) || !/^re_/.test(r.id)) continue;
      const marked = await db.update('connect_fee_returns', { environment: env(), source_id: r.id, state: 'ok', error_code: null }, { error_code: 'refund_reversed' }, { returning: true });
      if (marked.length) void connect.alert('fee_return_reversed', { status: String(r.status) });
    }
    return `refund_${status}`;
  }

  /** charge.dispute.*: the dispute's status on its sale (read back), and our fee back when it's lost. */
  async function onDispute(row, evt) {
    const did = idOf(evt.data?.object);
    if (!/^(dp|du)_[A-Za-z0-9]+$/.test(String(did ?? ''))) return 'ignored';
    const d = await stripe.get(`/v1/disputes/${encodeURIComponent(did)}`, {}, { account: row.stripe_account_id });
    let piId = idOf(d.payment_intent);
    let charge = null;
    if (!piId || evt.type === 'charge.dispute.created') {
      charge = await stripe.get(`/v1/charges/${encodeURIComponent(idOf(d.charge) ?? '')}`, {}, { account: row.stripe_account_id });
      piId = idOf(charge.payment_intent);
    }
    let sale = piId ? await saleByPayment(row, piId) : null;
    if (!sale && charge) sale = await saleFromCharge(row, charge, 'paid', (Number(evt.created) || 0) * 1000 || now());
    if (!sale) return 'not_ours';
    const at = new Date(((Number(evt.created) || 0) * 1000) || now()).toISOString();
    await db.rpc('record_sale_dispute', { p_provider: 'stripe', p_env: env(), p_payment_id: sale.provider_payment_id, p_user: sale.user_id, p_status: String(d.status ?? 'unknown').slice(0, 40), p_amount: Number(d.amount) || 0, p_at: at });
    if (d.status === 'lost' && (evt.type === 'charge.dispute.closed' || evt.type === 'charge.dispute.funds_withdrawn')) await returnFee(await saleByPayment(row, sale.provider_payment_id), d.id, Number(d.amount) || 0);
    return `dispute_${d.status}`;
  }

  // ───────────── our fee back ─────────────

  /**
   * The sale's fee_returned_minor as one absolute value, in one statement (sale_fee_returned): the greatest of what it
   * says now, the sum of its fee returns confirmed ('ok') and what Stripe says of the fee (feeRefunded). Never added
   * to, so a fee refund seen by two paths (the write's answer, the hourly read-back, application_fee.refunded) counts
   * once, and two server copies can't lose an update.
   */
  async function feeReturned(saleId, feeRefunded = 0) {
    await db.rpc('sale_fee_returned', { p_sale: saleId, p_fee_refunded: Math.max(0, Number(feeRefunded) || 0) });
  }

  /** The one-shot fee refund for a fee_returns row already written ('sending'). */
  async function sendReturn(ret) {
    const got = await stripe.post(`/v1/application_fees/${encodeURIComponent(ret.application_fee_id)}/refunds`, { amount: Number(ret.amount_minor), metadata: { ylb_source: ret.source_id } }, { idempotencyKey: ret.idempotency_key });
    const where = { environment: ret.environment, source_id: ret.source_id };
    if (got.outcome === 'ok' && /^fr_[A-Za-z0-9]+$/.test(String(got.value?.id ?? ''))) {
      await db.update('connect_fee_returns', where, { state: 'ok', fee_refund_id: got.value.id, error_code: null });
      await feeReturned(ret.sale_id);
      safeLog('connect_fee_returned', { env: env() }, log);
      return 'ok';
    }
    if (got.outcome === 'failed') {
      const code = String(got.error?.code ?? got.error?.kind ?? 'failed').slice(0, 60);
      await db.update('connect_fee_returns', where, { state: 'failed', error_code: code });
      void connect.alert('fee_return_failed', { code, status: got.status });
      return 'failed';
    }
    // it may have gone through: read back hourly, never sent again
    await db.update('connect_fee_returns', where, { state: 'unknown' });
    safeLog('connect_fee_return_unknown', { env: env() }, log);
    return 'unknown';
  }

  /**
   * Our fee back for money returned to the buyer (sourceId: re_… or dp_…), once per source. → the sale after, or null.
   */
  async function returnFee(sale, sourceId, backMinor) {
    if (!cfg.returnFees || !sale || !(Number(sale.application_fee_minor) > 0) || !(backMinor > 0)) return null;
    const share = feeShare({ feeMinor: Number(sale.application_fee_minor), returnedMinor: Number(sale.fee_returned_minor) || 0, amountMinor: Number(sale.amount_minor), backMinor });
    if (share <= 0) return null;
    const feeId = /^fee_[A-Za-z0-9]+$/.test(String(sale.application_fee_id ?? '')) ? sale.application_fee_id : '';
    const ret = { environment: env(), source_id: sourceId, sale_id: sale.id, user_id: sale.user_id, application_fee_id: feeId, amount_minor: share, idempotency_key: `ylb-fee-return:${env()}:${sourceId}`, state: feeId ? 'sending' : 'skipped' };
    // the row first: a second event for the same refund finds it (done, or in flight) and stops
    const inserted = await db.insert('connect_fee_returns', ret, { returning: true, ignoreDuplicates: true, onConflict: 'environment,source_id' });
    if (!inserted.length) return null;
    // the fee's id isn't known yet (fees are made after the charge): the hourly job finds it, then sends once
    if (!feeId) return null;
    await sendReturn(inserted[0]);
    return (await db.select('sales', { id: sale.id }, { select: SALE_COLUMNS, limit: 1 }))[0] ?? null;
  }

  /** application_fee.created / application_fee.refunded, from the P1 endpoint (the platform's events). */
  async function onPlatformEvent(evt) {
    const type = String(evt?.type ?? '');
    if (type !== 'application_fee.created' && type !== 'application_fee.refunded') return 'ignored';
    if (!connect.enabled) return 'ignored';
    const feeId = idOf(evt.data?.object);
    if (!/^fee_[A-Za-z0-9]+$/.test(String(feeId ?? ''))) return 'ignored';
    const fee = await stripe.get(`/v1/application_fees/${encodeURIComponent(feeId)}`);
    const acct = idOf(fee.account);
    if (!ACCOUNT_ID_RE.test(String(acct ?? ''))) return 'ignored';
    const row = await connect.rows.rowByAccount(acct);
    if (!row) return 'not_ours';
    const charge = await stripe.get(`/v1/charges/${encodeURIComponent(idOf(fee.charge) ?? '')}`, {}, { account: acct });
    const piId = idOf(charge.payment_intent);
    const sale = piId ? await saleByPayment(row, piId) : null;
    // fees are made after the charge: a sale not recorded yet is fine (the session's events fill it)
    if (!sale) return 'no_sale';
    const patch = {};
    if (!sale.application_fee_id) patch.application_fee_id = fee.id;
    if (sale.application_fee_minor == null && Number(fee.amount) > 0) patch.application_fee_minor = Number(fee.amount);
    if (Object.keys(patch).length) await db.update('sales', { id: sale.id }, patch);
    await feeReturned(sale.id, Number(fee.amount_refunded) || 0);
    // a fee return that waited for this id
    await db.update('connect_fee_returns', { sale_id: sale.id, state: 'skipped', application_fee_id: '' }, { application_fee_id: fee.id });
    return 'fee_applied';
  }

  // ───────────── the endpoint ─────────────

  async function processEvent(evt) {
    const row = await connect.rows.rowByAccount(evt.account);
    if (!row) {
      safeLog('connect_unknown_account', { type: String(evt.type ?? '').slice(0, 60) }, log);
      return 'not_ours';
    }
    const type = String(evt.type ?? '');
    await db.update('connect_accounts', { id: row.id }, { last_event_at: iso() });
    if (type.startsWith('checkout.session.')) return CONNECT_EVENTS.includes(type) ? onSession(row, evt) : 'ignored';
    if (type === 'charge.refunded' || type === 'charge.refund.updated') return onRefund(row, evt);
    if (type.startsWith('charge.dispute.')) return onDispute(row, evt);
    if (type === 'account.updated') {
      await connect.rows.syncRow(row);
      return 'account_synced';
    }
    if (type === 'account.application.deauthorized') return connect.deauthorized(row);
    if (type === 'payout.failed') {
      await db.update('connect_accounts', { id: row.id }, { payout_failed_at: iso() });
      return 'payout_failed';
    }
    return 'ignored';
  }

  /** POST /api/webhooks/stripe-connect → { status, body }. limited(req): over the rate limit. */
  async function webhook(req, { limited = () => false, readRaw }) {
    if (limited(req)) return { status: 429, body: { error: 'Too many requests.', code: 'RATE_LIMITED' } };
    let raw;
    try {
      raw = await readRaw(req, 256 * 1024);
    } catch (e) {
      return { status: e?.status === 413 ? 413 : 400, body: { error: 'Bad request.', code: 'BAD_REQUEST' } };
    }
    if (!cfg.webhookSecrets.length || !connect.enabled || !db?.enabled) {
      if (!cfg.webhookSecrets.length) safeLog('connect_alert_webhook_secret_missing', {}, log);
      return { status: 503, body: { error: 'Not set up.', code: 'NOT_SET_UP' } };
    }
    const header = req.headers['stripe-signature'];
    // the Connect endpoint's own secret only: the platform's STRIPE_WEBHOOK_SECRET never passes here
    if (!cfg.webhookSecrets.some((s) => verifyStripeSignature(raw, header, s, now()))) {
      safeLog('connect_webhook_bad_signature', {}, log);
      return { status: 400, body: { error: 'Bad signature.', code: 'BAD_REQUEST' } };
    }
    let evt;
    try {
      evt = JSON.parse(raw.toString('utf8'));
    } catch {
      return { status: 400, body: { error: 'Bad request.', code: 'BAD_REQUEST' } };
    }
    if (!evt || typeof evt !== 'object') return { status: 400, body: { error: 'Bad request.', code: 'BAD_REQUEST' } };
    // a live Connect endpoint also receives test events (and the other way round): only this mode's
    if (evt.livemode !== cfg.live) return { status: 200, body: { ok: true, ignored: true } };
    if (!ACCOUNT_ID_RE.test(String(evt.account ?? ''))) {
      safeLog('connect_webhook_no_account', { type: String(evt.type ?? '').slice(0, 60) }, log);
      return { status: 200, body: { ok: true, ignored: true } };
    }
    const id = String(evt.id ?? '');
    const dedupeKey = `stripe-connect:${EVENT_ID.test(id) ? id : sha256(raw)}`;
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
      safeLog('connect_webhook_failed', { type: String(evt.type ?? '').slice(0, 60), kind: e?.kind, code: e?.code }, log);
      return { status: 500, body: { error: 'Try again.', code: 'UNAVAILABLE' } };
    }
    try {
      await db.upsert('webhook_deliveries', { body_hash: dedupeKey, received_at: iso() }, { onConflict: 'body_hash' });
    } catch {
      /* a repeat reads the same objects again: harmless */
    }
    safeLog('connect_webhook', { type: String(evt.type ?? '').slice(0, 60), outcome }, log);
    return { status: 200, body: { ok: true } };
  }

  // ───────────── cron ─────────────

  /**
   * Fee returns that are 'unknown' (read back by metadata, never re-sent), 'skipped' (find the fee's id) or left in
   * 'sending' for over 5 minutes (the server stopped, or the database failed, around the write: it may have gone
   * through, so it becomes 'unknown' and is read back, never sent again).
   */
  async function cronFees() {
    if (!connect.enabled) return { checked: 0 };
    const rows = await db.select('connect_fee_returns', { environment: env(), state: ['in', ['unknown', 'skipped', 'sending']] }, { order: 'updated_at.asc', limit: 200 });
    const out = { checked: rows.length, resolved: 0, sent: 0, waiting: 0 };
    for (let ret of rows) {
      try {
        if (ret.state === 'sending') {
          if (now() - (Date.parse(ret.updated_at ?? '') || now()) < STUCK_MS) continue;
          const [moved] = await db.update('connect_fee_returns', { environment: ret.environment, source_id: ret.source_id, state: 'sending' }, { state: 'unknown' }, { returning: true });
          if (!moved) continue;
          safeLog('connect_fee_return_stuck', { env: env() }, log);
          ret = moved;
        }
        if (ret.state === 'skipped') {
          let feeId = ret.application_fee_id;
          if (!feeId) {
            const [sale] = await db.select('sales', { id: ret.sale_id }, { select: SALE_COLUMNS, limit: 1 });
            feeId = sale?.application_fee_id ?? null;
            if (!feeId && sale) {
              const pi = await stripe.get(`/v1/payment_intents/${encodeURIComponent(sale.provider_payment_id)}`, {}, { account: sale.provider_account });
              const chId = idOf(pi?.latest_charge);
              if (/^(ch|py)_[A-Za-z0-9]+$/.test(String(chId ?? ''))) feeId = idOf((await stripe.get(`/v1/charges/${encodeURIComponent(chId)}`, {}, { account: sale.provider_account }))?.application_fee) ?? null;
            }
          }
          if (!/^fee_[A-Za-z0-9]+$/.test(String(feeId ?? ''))) {
            out.waiting++;
            continue;
          }
          // the id is known now: this row's one and only write
          const [claimed] = await db.update('connect_fee_returns', { environment: ret.environment, source_id: ret.source_id, state: 'skipped' }, { state: 'sending', application_fee_id: feeId }, { returning: true });
          if (claimed) {
            await sendReturn(claimed);
            out.sent++;
          }
          continue;
        }
        // unknown: did the write go through? find it by its metadata
        const list = await stripe.get(`/v1/application_fees/${encodeURIComponent(ret.application_fee_id)}/refunds`, { limit: 100 });
        const found = (Array.isArray(list?.data) ? list.data : []).find((r) => r?.metadata?.ylb_source === ret.source_id);
        if (found) {
          await db.update('connect_fee_returns', { environment: ret.environment, source_id: ret.source_id, state: 'unknown' }, { state: 'ok', fee_refund_id: found.id, ...(Number(found.amount) > 0 ? { amount_minor: Number(found.amount) } : {}) });
          await feeReturned(ret.sale_id);
          out.resolved++;
        } else if (now() - Date.parse(ret.created_at ?? iso()) > DAY_MS) {
          void connect.alert('fee_return_unknown', { source: String(ret.source_id).slice(0, 40) }, { oncePerMs: DAY_MS });
        }
      } catch (e) {
        safeLog('connect_fee_check_failed', { kind: e?.kind, code: e?.code }, log);
      }
    }
    return out;
  }

  /**
   * Read-only: completed sessions with no sale (a lost webhook), for accounts with recent sales (and other active
   * accounts) — 50 accounts a run.
   */
  async function cronReconcile(ctx = {}) {
    if (!connect.enabled) return { accounts: 0 };
    const deadline = ctx.deadline ?? now() + 120_000;
    const since = now() - 3 * DAY_MS;
    const recent = await db.select('sales', { provider: 'stripe', environment: env(), created_at: ['gte', iso(since)] }, { select: 'provider_account', limit: 2000 });
    const accts = new Set(recent.map((r) => r.provider_account));
    const active = await db.select('connect_accounts', { environment: env(), status: 'active' }, { select: 'stripe_account_id', order: 'last_event_at.desc', limit: 50 });
    for (const a of active) if (accts.size < 50 && a.stripe_account_id) accts.add(a.stripe_account_id);
    let recorded = 0;
    let n = 0;
    for (const acct of [...accts].slice(0, 50)) {
      if (now() > deadline) break;
      const row = await connect.rows.rowByAccount(acct);
      if (!row) continue;
      n++;
      try {
        const list = await stripe.get('/v1/checkout/sessions', { limit: 100, 'created[gte]': Math.floor(since / 1000) }, { account: acct });
        for (const s of Array.isArray(list?.data) ? list.data : []) {
          if (s?.status !== 'complete' || !s.metadata?.ylb_offer) continue;
          const [have] = await db.select('sales', { provider: 'stripe', environment: env(), checkout_session_id: s.id }, { select: 'id', limit: 1 });
          if (have) continue;
          // the session's own time (not now): paid_at and the event order stay the payment's
          const out = await onSession(row, { type: 'checkout.session.completed', created: Number(s.created) > 0 ? Number(s.created) : Math.floor(now() / 1000), data: { object: { id: s.id } } });
          if (String(out).startsWith('sale_')) recorded++;
        }
      } catch (e) {
        safeLog('connect_reconcile_failed', { kind: e?.kind, code: e?.code }, log);
      }
    }
    return { accounts: n, recorded };
  }

  return { webhook, processEvent, onPlatformEvent, returnFee, cronFees, cronReconcile };
}
