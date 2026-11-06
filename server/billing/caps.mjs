// Per-customer caps (table billing_caps): the '*' row holds the defaults, a row per customer tag overrides
// them (a null field inherits the default), and status 'blocked' cuts a customer off. With plans enforced, the
// customer's tier adds a layer between the two (its treg budget from shared/plans.json): defaults < tier < override.
//
//   const caps = createCaps({ db, ledger, admin, storage, now, log });   // admin: server/billing/tregAdmin.mjs
//   await caps.check(tag, { estimateMicro })   throws TregError customer_blocked | customer_cap (same as treg's)
//   await caps.effective(tag)                   the merged caps
//   await caps.putCap(tag, fields) / putDefaults(fields) / resetCap(tag)   then synced to treg (admin token)
//
// The app-side check counts real treg spend only (vendor 'treg'): estimated Upload-Post, Zernio, Nango and X rows never block anyone.
// treg's own budgets are the authoritative ceiling; ours stops a call before it is made. Neither is a hard
// limit when calls run at the same time (about one call each), which is why each customer runs at most 4.
//
// createTreg (server/treg.mjs) uses check() only, with no admin: this file never imports tregAdmin.mjs.

import { TregError } from '../treg.mjs';
import { fail, safeLog } from '../integrations/common.mjs';

/** The built-in defaults (the migration's '*' row), used when that row is missing. */
export const BUILTIN_DEFAULTS = Object.freeze({ daily_cap_micro: 250_000, monthly_cap_micro: 3_000_000, calls_per_day: 400, posts_per_day: 50, x_posts_per_day: 20, status: 'active', note: null });

const NUMERIC = [
  ['dailyCapMicro', 'daily_cap_micro'],
  ['monthlyCapMicro', 'monthly_cap_micro'],
  ['callsPerDay', 'calls_per_day'],
  ['postsPerDay', 'posts_per_day'],
  ['xPostsPerDay', 'x_posts_per_day'],
];
const MAX_MICRO = 1_000_000_000_000; // $1M: anything above is a typo

/** A billing_caps row as the API's CapSettings. */
export function capToApi(row = {}) {
  const out = {};
  for (const [api, col] of NUMERIC) out[api] = row[col] == null ? null : Number(row[col]);
  out.status = row.status === 'blocked' ? 'blocked' : 'active';
  if (row.note) out.note = String(row.note);
  return out;
}

/**
 * The fields of a PUT body, checked: whole non-negative numbers or null, status 'active'|'blocked', a note of at
 * most 500 characters. Throws 400 BAD_REQUEST naming the field. Only fields present in the body are returned.
 */
export function parseCapFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'BAD_REQUEST', 'Send the caps as JSON.');
  const out = {};
  for (const [api, col] of NUMERIC) {
    if (!(api in body)) continue;
    const v = body[api];
    if (v === null) out[col] = null;
    else if (Number.isInteger(v) && v >= 0 && v <= MAX_MICRO) out[col] = v;
    else throw fail(400, 'BAD_REQUEST', `${api} must be a whole number of 0 or more, or null.`);
  }
  if ('status' in body) {
    if (body.status !== 'active' && body.status !== 'blocked') throw fail(400, 'BAD_REQUEST', 'status must be "active" or "blocked".');
    out.status = body.status;
  }
  if ('note' in body) {
    if (body.note != null && typeof body.note !== 'string') throw fail(400, 'BAD_REQUEST', 'note must be text.');
    const note = String(body.note ?? '').trim();
    if (note.length > 500) throw fail(400, 'BAD_REQUEST', 'Keep the note to 500 characters.');
    out.note = note || null;
  }
  return out;
}

/**
 * Defaults merged with an override: the override's null fields inherit. tierLayer (plans): the tier's money caps
 * ({ monthly_cap_micro, daily_cap_micro }) on top of the defaults and under the override.
 */
export function mergeCaps(defaults, override, tierLayer = null) {
  const d = { ...BUILTIN_DEFAULTS, ...dropNulls(defaults), ...dropNulls(tierLayer ? { daily_cap_micro: tierLayer.daily_cap_micro, monthly_cap_micro: tierLayer.monthly_cap_micro } : null) };
  if (!override) return { ...d, status: d.status === 'blocked' ? 'blocked' : 'active' };
  const out = { ...d };
  for (const [, col] of NUMERIC) if (override[col] != null) out[col] = Number(override[col]);
  out.status = override.status === 'blocked' ? 'blocked' : 'active';
  out.note = override.note ?? null;
  return out;
}

function dropNulls(row) {
  if (!row) return {};
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v != null));
}

/** What treg's budget routes take: the money and call caps and the status (posting caps are ours only). */
export function tregBudgetBody(caps) {
  const body = { status: caps.status === 'blocked' ? 'blocked' : 'active' };
  for (const col of ['daily_cap_micro', 'monthly_cap_micro', 'calls_per_day']) if (caps[col] != null) body[col] = Number(caps[col]);
  return body;
}

/**
 * tierFor(tag) → { monthly_cap_micro, daily_cap_micro } | null: the customer's plan layer (server/billing/stripe.mjs
 * tregCapsFor); null or absent → no layer (plans off, the owner, no plan).
 */
export function createCaps({ db, ledger, admin = null, storage = null, now = () => Date.now(), log = console, tierFor = null } = {}) {
  const stamp = () => new Date(now()).toISOString();

  async function rowFor(tag) {
    const [row] = await db.select('billing_caps', { customer_tag: tag }, { limit: 1 });
    return row ?? null;
  }

  async function defaults() {
    return { ...BUILTIN_DEFAULTS, ...dropNulls(await rowFor('*')) };
  }

  async function tierLayer(tag) {
    if (tag === '*' || typeof tierFor !== 'function') return null;
    try {
      return (await tierFor(tag)) ?? null;
    } catch {
      // the plan can't be read now: the defaults and the override still apply
      return null;
    }
  }

  async function effective(tag) {
    const [d, o, t] = await Promise.all([rowFor('*'), tag === '*' ? null : rowFor(tag), tierLayer(tag)]);
    return mergeCaps(d, o, t);
  }

  /** Mark a row synced (or not) with treg. */
  async function markSynced(tag, ok) {
    try {
      await db.update('billing_caps', { customer_tag: tag }, { synced_to_treg_at: ok ? stamp() : null });
    } catch (e) {
      safeLog('billing_cap_mark_failed', { code: e?.code }, log);
    }
  }

  /** Send one customer's caps to treg (the merged values, so treg's ceiling is ours). Returns whether it worked. */
  async function syncToTreg(tag) {
    if (!admin || admin.stub) return false;
    try {
      const row = await rowFor(tag);
      // a tier layer is sent even without an override row (the plan's budget is the customer's ceiling at treg)
      if (!row && !(await tierLayer(tag))) {
        await admin.budgets.delete(tag);
        return true;
      }
      await admin.budgets.put(tag, tregBudgetBody(await effective(tag)));
      if (row) await markSynced(tag, true);
      return true;
    } catch (e) {
      safeLog('billing_cap_sync_failed', { kind: e?.kind, code: e?.code }, log);
      await markSynced(tag, false);
      return false;
    }
  }

  /** Declare the customer budget dimension at treg once (stored in appState billing:tregSettings). */
  async function declareDimensionOnce() {
    let done = null;
    try {
      done = await storage?.get?.('billing:tregSettings');
    } catch {
      done = null;
    }
    if (done?.value?.at) return;
    await admin.settings({ budget_dims: ['customer'], primary_dim: 'customer' });
    try {
      await storage?.put?.('billing:tregSettings', { at: stamp() });
    } catch {
      /* sent again next time: it's idempotent at treg */
    }
  }

  /** Send the defaults (and, once, the budget dimension), then every override (their merged values changed). */
  async function syncDefaults() {
    if (!admin || admin.stub) return false;
    let ok = true;
    try {
      await declareDimensionOnce();
      await admin.budgets.putDefault(tregBudgetBody(await defaults()));
      await markSynced('*', true);
    } catch (e) {
      safeLog('billing_defaults_sync_failed', { kind: e?.kind, code: e?.code }, log);
      await markSynced('*', false);
      ok = false;
    }
    if (ok) {
      const overrides = await db.select('billing_caps', { customer_tag: ['neq', '*'] }, { select: 'customer_tag', limit: 1000 });
      for (const o of overrides) ok = (await syncToTreg(o.customer_tag)) && ok;
    }
    return ok;
  }

  return {
    defaults,
    effective,
    rowFor,
    syncToTreg,
    syncDefaults,

    /**
     * Before a metered treg call (or an analytics refresh): blocked → customer_blocked; today's or this month's
     * real spend plus the estimate over the cap, or today's calls at the cap → customer_cap with period.
     */
    async check(tag, { estimateMicro = 0 } = {}) {
      const caps = await effective(tag);
      if (caps.status === 'blocked') throw new TregError('customer_blocked', 'Analytics are paused for your account. Contact support.', { status: 403 });
      const spent = await ledger.spend(tag);
      const est = Math.max(0, Math.trunc(Number(estimateMicro) || 0));
      if (caps.daily_cap_micro != null && spent.todayMicro + est > caps.daily_cap_micro) throw new TregError('customer_cap', 'You’ve reached today’s analytics limit. It resets at midnight UTC.', { status: 429, period: 'day' });
      if (caps.calls_per_day != null && spent.todayCalls + 1 > caps.calls_per_day) throw new TregError('customer_cap', 'You’ve reached today’s analytics limit. It resets at midnight UTC.', { status: 429, period: 'day' });
      if (caps.monthly_cap_micro != null && spent.monthMicro + est > caps.monthly_cap_micro) throw new TregError('customer_cap', 'You’ve reached this month’s analytics limit.', { status: 429, period: 'month' });
      return { caps, spent };
    },

    /** Set a customer's override (fields not sent stay as they were) and sync it. Returns { cap, synced }. */
    async putCap(tag, fields) {
      const existing = await rowFor(tag);
      const row = { ...(existing ?? { customer_tag: tag }), ...fields, customer_tag: tag, updated_at: stamp(), synced_to_treg_at: null };
      // every field back to "inherit" and active: that's no override at all
      if (NUMERIC.every(([, c]) => row[c] == null) && row.status !== 'blocked' && !row.note) return this.resetCap(tag);
      await db.upsert('billing_caps', row, { onConflict: 'customer_tag' });
      const synced = await syncToTreg(tag);
      return { cap: { ...capToApi(row), syncedToTreg: synced }, synced };
    },

    /** Drop a customer's override (back to the defaults) and remove it at treg. */
    async resetCap(tag) {
      await db.remove('billing_caps', { customer_tag: tag });
      const synced = await syncToTreg(tag);
      return { cap: { ...capToApi(mergeCaps(await rowFor('*'), null)), syncedToTreg: synced, reset: true }, synced };
    },

    /** Change the defaults ('*') and sync them (with the dimension, once) and every override. */
    async putDefaults(fields) {
      const existing = await rowFor('*');
      // the defaults can't inherit from anything: a null field goes back to the built-in default
      const row = { ...BUILTIN_DEFAULTS, ...dropNulls(existing), ...dropNulls(fields), note: 'note' in fields ? fields.note : (existing?.note ?? null), customer_tag: '*', updated_at: stamp(), synced_to_treg_at: null };
      for (const [, col] of NUMERIC) if (fields[col] === null) row[col] = BUILTIN_DEFAULTS[col];
      await db.upsert('billing_caps', row, { onConflict: 'customer_tag' });
      const synced = await syncDefaults();
      return { defaults: { ...capToApi(row), syncedToTreg: synced }, synced };
    },
  };
}
