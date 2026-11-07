// A/B tests (P4b): the fixed rules and the three plain env settings.
//
//   EXPERIMENTS                "off" turns the module off (routes 503 NOT_SET_UP, no jobs; pages serve version A
//                              only and count nothing)
//   EXPERIMENT_READS_PER_TICK  tests one hourly tick may read results for (40; 1–200)
//   EXPERIMENT_COOKIE_SECRET   optional: the key for the page split's cookies and lead tokens. Unset, it's derived
//                              from SUPABASE_SECRET_KEY (HKDF, label ylb-exp-v1), so no new Secret is needed.
// Bad values fall back to the defaults.

import crypto from 'node:crypto';

export const EXPERIMENTS_MIGRATION = 'supabase/migrations/20261117000000_experiments.sql';
export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const POST_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export const KINDS = Object.freeze(['post', 'email', 'page']);
export const KEYS = Object.freeze(['a', 'b', 'c']);
/** How each kind runs. */
export const MODES = Object.freeze({ post: ['times', 'trial_reels'], email: ['omnisend_ab', 'split'], page: ['split'] });
/** The one thing that differs. */
export const CHANGED = Object.freeze({ post: ['hook', 'caption', 'visual', 'cta', 'time'], email: ['subject', 'opening'], page: ['headline', 'hero', 'cta'] });
/** What decides it (the first is the default; Trial Reels default to views). */
export const METRICS = Object.freeze({ post: ['engagement_rate', 'views', 'reach'], email: ['open_rate', 'click_rate'], page: ['lead_rate'] });
export const STATES = Object.freeze(['draft', 'running', 'finished', 'stopped', 'cancelled']);
export const NETWORKS = Object.freeze(['instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'youtube']);

export const SHARE_MODES = Object.freeze(['CUSTOM', 'TRIAL_REELS_SHARE_TO_FOLLOWERS_IF_LIKED', 'TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS']);
export const TRIAL_MODES = Object.freeze(['TRIAL_REELS_SHARE_TO_FOLLOWERS_IF_LIKED', 'TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS']);
export const isTrialMode = (m) => TRIAL_MODES.includes(m);
/** Trial Reels need at least this many followers (Instagram's rule). */
export const TRIAL_MIN_FOLLOWERS = 1000;

/** The minimum sample before any verdict: per variant (trials) and in all (successes); a count comparison's total. */
export const MINIMUMS = Object.freeze({
  social: Object.freeze({ trials: 300, successes: 20 }),
  page: Object.freeze({ trials: 100, successes: 10 }),
  email: Object.freeze({ trials: 200, successes: 0 }),
  counts: Object.freeze({ total: 400 }),
});
/** |z| needed: two variants (α 0.05, two-sided), three (Bonferroni, α 0.05/3). */
export const Z_TWO = 1.96;
export const Z_THREE = 2.394;
/** A winner must also beat each other variant by at least this much (relative). */
export const MIN_LIFT = 0.1;

/** "Same network, different times": a variant goes out at least this long after the previous one. */
export const GAP_MS = 12 * HOUR_MS;
/** Decision deadlines: posts 7 days after the last planned time, Trial Reels 72 h after the last one went out, pages 30 days, email Omnisend's decision time + 24 h. */
export const WINDOW = Object.freeze({ postTimes: 7 * DAY_MS, trialReels: 72 * HOUR_MS, page: 30 * DAY_MS, emailExtra: 24 * HOUR_MS });
/** Post results: read every 3 h in the first 72 h after posting, every 12 h up to the deadline, never after it + 24 h. */
export const CADENCE = Object.freeze({ early: 3 * HOUR_MS, earlyFor: 72 * HOUR_MS, late: 12 * HOUR_MS, after: 24 * HOUR_MS });
/** Omnisend results: at most every 6 h. */
export const EMAIL_EVERY_MS = 6 * HOUR_MS;
/** "Update results": once every 15 minutes per test. */
export const REFRESH_EVERY_MS = 15 * MINUTE_MS;
/** The result reader's lease per claimed test. */
export const READ_LEASE_SECONDS = 600;
/** What the experiment-results job leaves of the tick's budget for the jobs after it. */
export const LEAVE_FOR_OTHERS_MS = 4_000;
/** A lead token stays good this long after its split stopped (late form posts still count as that version). */
export const TOKEN_AFTER_STOP_MS = 7 * DAY_MS;
/** The page split's cookie lifetime. */
export const COOKIE_MAX_AGE_S = 90 * 86_400;
/** Counter flushes: every 30 s; counts that can't be written are kept up to 10 minutes. */
export const FLUSH_EVERY_MS = 30_000;
export const FLUSH_KEEP_MS = 10 * MINUTE_MS;
export const FLUSH_MAX_ROWS = 200;
/** How long another server copy's new split can go unseen (the running-split cache). */
export const SPLIT_TTL_MS = 60_000;

const int = (v, def, lo, hi) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : def;
};

/** The page split's key: EXPERIMENT_COOKIE_SECRET, or derived from SUPABASE_SECRET_KEY; null without either. */
export function cookieSecretFrom(env = process.env) {
  const own = String(env.EXPERIMENT_COOKIE_SECRET ?? '').trim();
  if (own.length >= 16) return Buffer.from(own, 'utf8');
  const base = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!base) return null;
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(base, 'utf8'), Buffer.alloc(0), Buffer.from('ylb-exp-v1', 'utf8'), 32));
}

/** { off, readsPerTick, cookieSecret, ownSecret } from env. */
export function experimentSettings(env = process.env) {
  return {
    off: ['off', 'none', 'false', '0'].includes(String(env.EXPERIMENTS ?? '').trim().toLowerCase()),
    readsPerTick: int(env.EXPERIMENT_READS_PER_TICK, 40, 1, 200),
    cookieSecret: cookieSecretFrom(env),
    ownSecret: String(env.EXPERIMENT_COOKIE_SECRET ?? '').trim().length >= 16,
  };
}

export const iso = (t) => (t == null ? null : new Date(t).toISOString());
export const ms = (v) => (v == null ? null : typeof v === 'number' ? v : Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
