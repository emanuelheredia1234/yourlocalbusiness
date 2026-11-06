// The owner's ad limits (spec §10.1, adapted: their own table ad_limits, so server/billing/caps.mjs is untouched).
// The '*' row holds the defaults, a row per customer tag overrides them (a null field inherits), and anything missing
// fails CLOSED: ads off. Hard ceilings from env (ADS_HARD_MAX_DAILY 500, ADS_HARD_MAX_CHANGE 200) win over any owner
// value. ADS_LAUNCH_ENABLED=1 is the app-wide switch for launches, resumes and increases; pause, end and decreases
// never look at any of this (R7). A customer blocked in billing_caps (status 'blocked') is read, never written.
//
//   const limits = createAdLimits({ db, env, now });
//   await limits.effective(tag)                 merged limits + version + blocked
//   await limits.committed(userId, currency, { exclude })   committed daily across the customer's campaigns
//   await limits.countToday(userId, kinds)      jobs started today (UTC) of these kinds
//   switchesProblem(lim, env) / launchProblems(…) / increaseProblems(…)   pure checks → codes / notes
//   await limits.put(tag, patch) / parsePatch(body, env)                 the owner's edits (version bumped)

import { fail } from '../integrations/common.mjs';
import { dayStart } from '../billing/ledger.mjs';
import { FINAL_STATES, LIVE_JOB_STATES } from './contracts.mjs';
import { note } from './messages.mjs';
import { compareWhole, fromMinor, isCurrency, sumWhole, toMinor } from './money.mjs';

export const ADS_BUILTIN_DEFAULTS = Object.freeze({ ads_enabled: false, ads_currency: 'USD', ads_max_daily: 50, ads_max_change: 50, ads_max_campaign_total: 750, ads_launches_per_day: 3, ads_changes_per_day: 20 });
const FIELDS = Object.keys(ADS_BUILTIN_DEFAULTS);
const API = { adsEnabled: 'ads_enabled', adsCurrency: 'ads_currency', maxDaily: 'ads_max_daily', maxChange: 'ads_max_change', maxCampaignTotal: 'ads_max_campaign_total', launchesPerDay: 'ads_launches_per_day', changesPerDay: 'ads_changes_per_day' };

/** The env switch: launches, resumes and increases only with ADS_LAUNCH_ENABLED=1. */
export const launchEnabled = (env = process.env) => String(env?.ADS_LAUNCH_ENABLED ?? '').trim() === '1';

/** The ceilings no owner value can pass. */
export function hardCeilings(env = process.env) {
  const n = (v, d) => {
    const x = Number(String(v ?? '').trim());
    return Number.isFinite(x) && x > 0 ? x : d;
  };
  return { daily: n(env?.ADS_HARD_MAX_DAILY, 500), change: n(env?.ADS_HARD_MAX_CHANGE, 200) };
}

/** '*' merged with a customer's row (null inherits), then the built-ins for anything still missing, then the ceilings. */
export function mergeLimits(defaults, own, env = process.env) {
  const out = {};
  for (const f of FIELDS) {
    const o = own?.[f];
    const d = defaults?.[f];
    out[f] = o !== null && o !== undefined ? o : d !== null && d !== undefined ? d : ADS_BUILTIN_DEFAULTS[f];
  }
  // a missing '*' row (the migration's defaults are gone): fail closed, ads off whatever a customer row says
  out.ads_enabled = defaults ? out.ads_enabled === true : false;
  for (const f of ['ads_max_daily', 'ads_max_change', 'ads_max_campaign_total', 'ads_launches_per_day', 'ads_changes_per_day']) out[f] = Number(out[f]);
  const ceil = hardCeilings(env);
  out.ads_max_daily = Math.min(out.ads_max_daily, ceil.daily);
  out.ads_max_change = Math.min(out.ads_max_change, ceil.change);
  if (!isCurrency(out.ads_currency)) out.ads_currency = 'USD';
  out.version = `${defaults?.version ?? 0}:${own?.version ?? 0}`;
  return out;
}

/** The reason launches/resumes/increases are off for this customer, or null. */
export function switchesProblem(lim, env = process.env) {
  if (!launchEnabled(env)) return 'KILL_SWITCH';
  if (!lim?.ads_enabled) return 'ADS_OFF';
  if (lim?.blocked) return 'BLOCKED';
  return null;
}

/**
 * A launch's limit notes. choice PAUSED checks only the per-launch amount and the total (it spends nothing until a
 * resume, which is checked like a launch). committed: whole units already committed (this launch not included).
 */
export function launchProblems({ lim, currency, daily, days, choice, committed, launchesToday }) {
  const out = [];
  if (currency !== lim.ads_currency) return [note('LIMIT_CURRENCY', { currency })];
  if (compareWhole(daily, lim.ads_max_change, currency) > 0) out.push(note('LIMIT_CHANGE', { currency, amount: daily, limit: lim.ads_max_change }));
  const total = fromMinor(toMinor(daily, currency) * days, currency);
  if (compareWhole(total, lim.ads_max_campaign_total, currency) > 0) out.push(note('LIMIT_TOTAL', { currency, amount: total, limit: lim.ads_max_campaign_total }));
  const after = sumWhole([committed, daily], currency);
  if (choice === 'ACTIVE' && compareWhole(after, lim.ads_max_daily, currency) > 0) out.push(note('LIMIT_DAILY', { currency, after, limit: lim.ads_max_daily }));
  if (launchesToday >= lim.ads_launches_per_day) out.push(note('LIMIT_LAUNCHES', { limit: lim.ads_launches_per_day }));
  return out;
}

/**
 * A change that can raise spend (resume, a higher daily, a later end date). increase: the daily delta (0 for a resume
 * or an end date; a resume checks its whole daily like a launch). total: spent so far + the new remaining planned.
 * committedAfter: the committed daily across live campaigns after the change.
 */
export function increaseProblems({ lim, currency, delta, total, committedAfter, changesToday, isResume = false, daily }) {
  const out = [];
  if (currency !== lim.ads_currency) return [note('LIMIT_CURRENCY', { currency })];
  const step = isResume ? daily : delta;
  if (Number(step) > 0 && compareWhole(step, lim.ads_max_change, currency) > 0) out.push(note('LIMIT_CHANGE', { currency, amount: step, limit: lim.ads_max_change }));
  if (compareWhole(total, lim.ads_max_campaign_total, currency) > 0) out.push(note('LIMIT_TOTAL', { currency, amount: total, limit: lim.ads_max_campaign_total }));
  if (compareWhole(committedAfter, lim.ads_max_daily, currency) > 0) out.push(note('LIMIT_DAILY', { currency, after: committedAfter, limit: lim.ads_max_daily }));
  if (changesToday >= lim.ads_changes_per_day) out.push(note('LIMIT_CHANGES', { limit: lim.ads_changes_per_day }));
  return out;
}

/** Whether a campaign's switch is on, or may be on (it counts toward committed daily and the live lists, R12). */
export function switchMayBeOn(row, liveJobCampaignIds = new Set()) {
  if (!row || FINAL_STATES.includes(row.state)) return false;
  return row.configured_status === 'ACTIVE' || row.state === 'launching' || row.state === 'unknown' || liveJobCampaignIds.has(row.id);
}

/** The owner's PUT body: { adsEnabled?, adsCurrency?, maxDaily?, … } (null = inherit). Throws 400 naming the field. */
export function parsePatch(body, env = process.env) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'BAD_REQUEST', 'Send the limits as JSON.');
  const ceil = hardCeilings(env);
  const out = {};
  for (const [api, col] of Object.entries(API)) {
    if (!(api in body)) continue;
    const v = body[api];
    if (v === null) {
      out[col] = null;
      continue;
    }
    if (col === 'ads_enabled') {
      if (typeof v !== 'boolean') throw fail(400, 'BAD_REQUEST', 'adsEnabled must be true, false or null.');
      out[col] = v;
    } else if (col === 'ads_currency') {
      if (!isCurrency(v)) throw fail(400, 'BAD_REQUEST', 'adsCurrency must be a 3-letter currency code, like USD.');
      out[col] = v;
    } else if (col === 'ads_launches_per_day' || col === 'ads_changes_per_day') {
      if (!Number.isInteger(v) || v < 0 || v > 1000) throw fail(400, 'BAD_REQUEST', `${api} must be a whole number from 0 to 1000.`);
      out[col] = v;
    } else {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || Math.round(v * 100) !== v * 100) throw fail(400, 'BAD_REQUEST', `${api} must be an amount of 0 or more (at most 2 decimals).`);
      if (col === 'ads_max_daily' && v > ceil.daily) throw fail(400, 'BAD_REQUEST', `maxDaily can be at most ${ceil.daily} (ADS_HARD_MAX_DAILY).`);
      if (col === 'ads_max_change' && v > ceil.change) throw fail(400, 'BAD_REQUEST', `maxChange can be at most ${ceil.change} (ADS_HARD_MAX_CHANGE).`);
      out[col] = v;
    }
  }
  if (!Object.keys(out).length) throw fail(400, 'BAD_REQUEST', 'Nothing to change.');
  return out;
}

/** A merged limits object as the API shows it. */
export function limitsToApi(lim) {
  return { adsEnabled: lim.ads_enabled, currency: lim.ads_currency, maxDaily: lim.ads_max_daily, maxChange: lim.ads_max_change, maxCampaignTotal: lim.ads_max_campaign_total, launchesPerDay: lim.ads_launches_per_day, changesPerDay: lim.ads_changes_per_day, ...(lim.blocked ? { blocked: true } : {}) };
}
/** A raw ad_limits row as the API shows it (null = inherits). */
export function rowToApi(row = {}) {
  const out = {};
  for (const [api, col] of Object.entries(API)) out[api] = row?.[col] ?? null;
  return out;
}

export function createAdLimits({ db, env = process.env, now = () => Date.now() } = {}) {
  /** The customer's merged limits. A database that can't be read fails closed (ads off). */
  async function effective(tag) {
    let rows = [];
    let blocked = false;
    try {
      rows = await db.select('ad_limits', { customer_tag: ['in', ['*', tag]] }, { limit: 2 });
    } catch {
      return { ...mergeLimits(null, null, env), ads_enabled: false, blocked: false, version: 'unreadable' };
    }
    try {
      const caps = await db.select('billing_caps', { customer_tag: tag }, { select: 'customer_tag,status', limit: 1 });
      blocked = caps[0]?.status === 'blocked';
    } catch {
      blocked = true; // can't tell: fail closed
    }
    const def = rows.find((r) => r.customer_tag === '*') ?? null;
    const own = rows.find((r) => r.customer_tag === tag) ?? null;
    return { ...mergeLimits(def, own, env), blocked };
  }

  /**
   * Committed daily (whole units) over the customer's campaigns in `currency` whose switch is on or may be on
   * (configured ACTIVE whatever the review, launching, unknown, or with a live job). exclude: a campaign id left out.
   */
  async function committed(userId, currency, { exclude } = {}) {
    const rows = await db.select('ad_campaigns', { user_id: userId, state: ['in', ['launching', 'in_review', 'active', 'paused', 'rejected', 'with_issues', 'unknown']] }, { select: 'id,state,configured_status,daily_budget,currency,platform,name,ad_account_id,project_id', limit: 1000 });
    const live = new Set((await db.select('ad_jobs', { user_id: userId, state: ['in', LIVE_JOB_STATES] }, { select: 'campaign_id', limit: 1000 })).map((j) => j.campaign_id));
    const on = rows.filter((r) => r.id !== exclude && switchMayBeOn(r, live));
    const mine = on.filter((r) => r.currency === currency);
    return { daily: sumWhole(mine.map((r) => r.daily_budget), currency), count: on.length, rows: on, liveJobs: live };
  }

  /** Jobs this user started today (UTC) of these kinds (launch attempts, or changes without pause/end). */
  async function countToday(userId, kinds) {
    const rows = await db.select('ad_jobs', { user_id: userId, kind: ['in', kinds], requested_at: ['gte', dayStart(now())] }, { select: 'id', limit: 1000 });
    return rows.length;
  }

  async function rows() {
    return db.select('ad_limits', {}, { order: 'customer_tag.asc', limit: 1000 });
  }

  /** The owner's change for one tag ('*' = the defaults): only the fields sent; the version goes up. */
  async function put(tag, patch) {
    const cur = (await db.select('ad_limits', { customer_tag: tag }, { limit: 1 }))[0] ?? null;
    const next = { ...(cur ?? {}), ...patch, customer_tag: tag, version: (Number(cur?.version) || 0) + 1, updated_at: new Date(now()).toISOString() };
    delete next.created_at;
    await db.upsert('ad_limits', next, { onConflict: 'customer_tag' });
    return next;
  }

  return { effective, committed, countToday, rows, put };
}
