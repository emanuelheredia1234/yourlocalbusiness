// The billing tables (supabase/migrations/20261110000000_billing.sql) through the server's db client: settings,
// accounts, money operations and slots. Server-only; every query names the server-resolved user id.
//
//   const store = createBillingStore({ db, env, now, log });
//   await store.settings()                       billing_settings (cached 30 s; defaults when the table is missing)
//   await store.account(userId) / ensureAccount(userId)
//   await store.apply(userId, patch, fetchedAt)  → whether it wrote (an older Stripe read never overwrites a newer one)
//   await store.slots(userId)                    the user's project_slots rows
//   await store.op(...) / insertOp / finishOp    billing_ops

import crypto from 'node:crypto';
import { customerTag, safeLog } from '../integrations/common.mjs';

export const BILLING_MIGRATION = 'supabase/migrations/20261110000000_billing.sql';
const SETTINGS_TTL_MS = 30_000;

export const DEFAULT_SETTINGS = Object.freeze({ id: 1, enforce: false, enforced_at: null, card_trial_days: 0, existing_trial_days: 30 });

/** A complete billing_accounts row for a user who has none yet: no plan, no Stripe Customer. */
export function emptyAccount(userId, tag) {
  return {
    user_id: userId,
    customer_tag: tag,
    source: 'stripe',
    tier: 'none',
    interval: null,
    status: 'none',
    stripe_customer_id: null,
    stripe_subscription_id: null,
    tier_item_id: null,
    business_item_id: null,
    extra_businesses: 0,
    comp_extra: 0,
    business_limit: 1,
    extra_keep: 0,
    extra_keep_until: null,
    tier_keep: null,
    tier_keep_until: null,
    current_period_start: null,
    current_period_end: null,
    billing_anchor: null,
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    trial_ends_at: null,
    grace_until: null,
    comp_until: null,
    comp_note: null,
    checkout_session_id: null,
    checkout_expires_at: null,
  };
}

export function createBillingStore({ db, env = process.env, now = () => Date.now(), log = console } = {}) {
  let cachedSettings = null; // { value, until }
  const iso = (t = now()) => new Date(t).toISOString();

  async function settings({ fresh = false } = {}) {
    if (!fresh && cachedSettings && cachedSettings.until > now()) return cachedSettings.value;
    let value = { ...DEFAULT_SETTINGS };
    try {
      const [row] = await db.select('billing_settings', { id: 1 }, { limit: 1 });
      if (row) value = { ...DEFAULT_SETTINGS, ...row };
    } catch (e) {
      // the migration isn't run: plans are simply off; anything else: keep the last known value a little longer
      if (e?.code !== 'NOT_SET_UP' && cachedSettings) return cachedSettings.value;
      if (e?.code !== 'NOT_SET_UP') throw e;
      value = { ...DEFAULT_SETTINGS, missing: true };
    }
    cachedSettings = { value, until: now() + SETTINGS_TTL_MS };
    return value;
  }

  async function putSettings(patch) {
    const row = { ...(await settings({ fresh: true })), ...patch, id: 1, updated_at: iso() };
    delete row.missing;
    await db.upsert('billing_settings', row, { onConflict: 'id' });
    cachedSettings = null;
    return settings({ fresh: true });
  }

  async function account(userId) {
    const [row] = await db.select('billing_accounts', { user_id: userId }, { limit: 1 });
    return row ?? null;
  }

  /** The user's row, made (no plan) the first time. Never touches their slots. */
  async function ensureAccount(userId) {
    const existing = await account(userId);
    if (existing) return existing;
    const row = emptyAccount(userId, customerTag(userId, env));
    await db.insert('billing_accounts', row, { ignoreDuplicates: true, onConflict: 'user_id' });
    return (await account(userId)) ?? row;
  }

  /** Write fields under the advisory lock, only when `fetchedAt` is newer than what's stored (null: always). */
  async function apply(userId, patch, fetchedAt = null) {
    const wrote = await db.rpc('ylb_billing_apply', { p_user: userId, p_row: patch, p_fetched_at: fetchedAt });
    return wrote === true;
  }

  async function slots(userId) {
    return db.select('project_slots', { user_id: userId }, { select: 'project_id,state,claimed_at,lock_at,locked_reason', order: 'claimed_at.asc', limit: 1000 });
  }

  async function applySlots(userId) {
    return db.rpc('ylb_apply_slots', { p_user: userId });
  }

  // ───────────── money operations ─────────────

  /** The user's op for this client request id, or null. */
  async function opByRequest(userId, clientRequestId) {
    const [row] = await db.select('billing_ops', { user_id: userId, client_request_id: clientRequestId }, { limit: 1 });
    return row ?? null;
  }

  /** The user's op still in flight (sending or unknown), or null. */
  async function liveOp(userId) {
    const [row] = await db.select('billing_ops', { user_id: userId, state: ['in', ['sending', 'unknown']] }, { limit: 1 });
    return row ?? null;
  }

  async function lastOp(userId) {
    const [row] = await db.select('billing_ops', { user_id: userId }, { order: 'requested_at.desc', limit: 1 });
    return row ?? null;
  }

  /**
   * A new op in state 'sending'. Answers { op } or { existing } (same client request id) or { busy } (another op
   * is in flight: the billing_ops_one_live index).
   */
  async function insertOp(userId, { kind, clientRequestId, request, idempotencyKey }) {
    const row = { id: crypto.randomUUID(), user_id: userId, kind, client_request_id: clientRequestId, state: 'sending', request, idempotency_key: idempotencyKey, stripe_ref: {}, error_code: null, requested_at: iso() };
    try {
      await db.insert('billing_ops', row);
      return { op: row };
    } catch (e) {
      if (e?.name === 'DbError' && e.code === 'CONFLICT') {
        const existing = await opByRequest(userId, clientRequestId);
        if (existing) return { existing };
        return { busy: await liveOp(userId) };
      }
      throw e;
    }
  }

  async function finishOp(op, patch) {
    const fields = { ...patch, ...(patch.state && patch.state !== 'unknown' && patch.state !== 'sending' ? { finished_at: iso() } : {}), checked_at: iso() };
    try {
      await db.update('billing_ops', { id: op.id, user_id: op.user_id }, fields);
    } catch (e) {
      safeLog('billing_op_write_failed', { kind: op.kind, state: patch.state, code: e?.code }, log);
      throw e;
    }
    return { ...op, ...fields };
  }

  async function unknownOps({ olderThan, limit = 20 }) {
    return db.select('billing_ops', { state: 'unknown', requested_at: ['lte', iso(olderThan)] }, { order: 'requested_at.asc', limit });
  }

  return { settings, putSettings, account, ensureAccount, apply, slots, applySlots, opByRequest, liveOp, lastOp, insertOp, finishOp, unknownOps, invalidate: () => (cachedSettings = null) };
}
