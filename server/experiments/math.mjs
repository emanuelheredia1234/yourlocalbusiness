// Who won an A/B test (P4b §S7), pure: no I/O, no clock of its own. The app shows this result as it is
// (src/lib/experiments/math.ts only formats it); the server's is the one that counts.
//
//   decide({ kind, mode, changed, metric, endsAt, now, variants: [{ key, metrics, visitors, leads, missing }] })
//     → { verdict, winner?, lift?, z?, metric, perVariant, minimums, computedAt, note?, reason?, missing? }
//
// verdict: 'winner' | 'tie' | 'too_close' | 'not_enough' | 'keep_going'. Rules, in order:
//  1. A variant whose post is gone, or whose job failed or may not have gone out → not_enough (variant_missing).
//  2. The minimum sample (config.mjs MINIMUMS): before the deadline keep_going, after it not_enough (what's missing).
//  3. Identical rates (or counts), 0 and 0 included → tie.
//  4. Rates: a two-proportion z-test of the best against each other variant (pooled p); counts (views, reach): a
//     conditional binomial test, z = (a − n/2) / √(n/4). |z| ≥ 1.96 with two variants, ≥ 2.394 with three
//     (Bonferroni), and at least a 10% relative lift over each other variant → winner.
//  5. Otherwise keep_going before the deadline, too_close after it.
// Notes: time_differs (posts at different times testing something else), non_followers (Trial Reels).
// A metric a network didn't report is unknown, never 0: only keys every variant reported are compared.

import { MINIMUMS, MIN_LIFT, Z_THREE, Z_TWO } from './config.mjs';

const ENGAGEMENT = ['likes', 'comments', 'shares', 'saves'];
const MEASURES = ['reach', 'views', 'impressions'];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const r3 = (x) => Math.round(x * 1000) / 1000;
const r2 = (x) => Math.round(x * 100) / 100;

/** z of two proportions (pooled); 0 when nothing can be told. */
export function zTwoProportions(s1, n1, s2, n2) {
  if (!(n1 > 0 && n2 > 0)) return 0;
  const p = (s1 + s2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!(se > 0)) return 0;
  return (s1 / n1 - s2 / n2) / se;
}

/** z of two counts given their total (conditional binomial, p = 1/2). */
export function zCounts(a, b) {
  const n = a + b;
  if (!(n > 0)) return 0;
  return (a - n / 2) / Math.sqrt(n / 4);
}

/** The keys every variant reported (a missing key is unknown, never 0). */
const common = (variants, keys) => keys.filter((k) => variants.every((v) => num(v.metrics?.[k]) !== undefined));

/**
 * Each variant's { successes, trials } (rates) or { count } (counts), or { reason } when they can't be compared.
 * → { kind: 'rate' | 'count', rows: { key → {...} }, group, measure? } | { reason }
 */
export function measure({ kind, metric }, variants) {
  if (kind === 'page') {
    return { kind: 'rate', group: 'page', rows: Object.fromEntries(variants.map((v) => [v.key, { successes: Math.max(0, Number(v.leads) || 0), trials: Math.max(0, Number(v.visitors) || 0) }])) };
  }
  if (kind === 'email') {
    const field = metric === 'click_rate' ? 'clickRate' : 'openRate';
    if (!variants.every((v) => num(v.metrics?.sent) !== undefined && num(v.metrics?.[field]) !== undefined)) return { reason: 'no_common_measure' };
    return { kind: 'rate', group: 'email', rows: Object.fromEntries(variants.map((v) => [v.key, { successes: Math.round(v.metrics[field] * v.metrics.sent), trials: v.metrics.sent }])) };
  }
  if (metric === 'views' || metric === 'reach') {
    if (common(variants, [metric]).length !== 1) return { reason: 'no_common_measure' };
    return { kind: 'count', group: 'counts', measure: metric, rows: Object.fromEntries(variants.map((v) => [v.key, { count: v.metrics[metric] }])) };
  }
  // engagement rate: the engagement keys every variant has, over the first measure every variant has
  const eng = common(variants, ENGAGEMENT);
  const over = common(variants, MEASURES)[0];
  if (!eng.length || !over) return { reason: 'no_common_measure' };
  return { kind: 'rate', group: 'social', measure: over, engagement: eng, rows: Object.fromEntries(variants.map((v) => [v.key, { successes: eng.reduce((a, k) => a + v.metrics[k], 0), trials: v.metrics[over] }])) };
}

/** A plain-words list of what the minimum sample still needs (for "Not enough data to call it: …"). */
function shortfall(m, rows) {
  const out = [];
  if (m.kind === 'count') {
    const total = Object.values(rows).reduce((a, r) => a + r.count, 0);
    if (total < MINIMUMS.counts.total) out.push({ what: m.measure ?? 'views', have: total, need: MINIMUMS.counts.total });
    return out;
  }
  const min = MINIMUMS[m.group];
  const unit = m.group === 'page' ? 'visitors' : m.group === 'email' ? 'sent' : (m.measure ?? 'reach');
  for (const [key, r] of Object.entries(rows)) if (r.trials < min.trials) out.push({ key, what: unit, have: r.trials, need: min.trials });
  const s = Object.values(rows).reduce((a, r) => a + r.successes, 0);
  if (min.successes > 0 && s < min.successes) out.push({ what: m.group === 'page' ? 'leads' : m.group === 'email' ? 'opens' : 'engagements', have: s, need: min.successes });
  return out;
}

export function decide({ kind, mode, changed, metric, endsAt = null, now = Date.now(), variants = [] }) {
  const ended = endsAt != null && now >= endsAt;
  const note = kind === 'post' ? (mode === 'trial_reels' ? 'non_followers' : changed !== 'time' ? 'time_differs' : undefined) : undefined;
  const base = { metric, computedAt: new Date(now).toISOString(), ...(note ? { note } : {}) };
  const list = [...variants].sort((x, y) => (x.key < y.key ? -1 : 1));
  if (list.length < 2) return { ...base, verdict: 'not_enough', reason: 'variant_missing', perVariant: {}, minimums: null };
  if (list.some((v) => v.missing)) return { ...base, verdict: 'not_enough', reason: 'variant_missing', perVariant: {}, minimums: null };
  const m = measure({ kind, metric }, list);
  if (m.reason) return { ...base, verdict: ended ? 'not_enough' : 'keep_going', reason: m.reason, perVariant: {}, minimums: null };
  const minimums = m.kind === 'count' ? { total: MINIMUMS.counts.total } : { ...MINIMUMS[m.group] };
  const perVariant = Object.fromEntries(
    Object.entries(m.rows).map(([k, r]) => [k, m.kind === 'count' ? { count: r.count } : { successes: r.successes, trials: r.trials, rate: r.trials > 0 ? r3(r.successes / r.trials) : 0 }]),
  );
  const out = { ...base, perVariant, minimums, ...(m.measure ? { measure: m.measure } : {}) };
  const missing = shortfall(m, m.rows);
  if (missing.length) return { ...out, verdict: ended ? 'not_enough' : 'keep_going', reason: 'sample', missing };

  const value = (k) => (m.kind === 'count' ? m.rows[k].count : m.rows[k].trials > 0 ? m.rows[k].successes / m.rows[k].trials : 0);
  const keys = list.map((v) => v.key);
  if (keys.every((k) => value(k) === value(keys[0]))) return { ...out, verdict: 'tie' };

  const best = keys.reduce((a, k) => (value(k) > value(a) ? k : a), keys[0]);
  const threshold = keys.length >= 3 ? Z_THREE : Z_TWO;
  let zMin = Infinity;
  let liftMin = Infinity;
  for (const k of keys) {
    if (k === best) continue;
    const z = m.kind === 'count' ? zCounts(m.rows[best].count, m.rows[k].count) : zTwoProportions(m.rows[best].successes, m.rows[best].trials, m.rows[k].successes, m.rows[k].trials);
    const lift = value(k) > 0 ? (value(best) - value(k)) / value(k) : Infinity;
    zMin = Math.min(zMin, z);
    liftMin = Math.min(liftMin, lift);
  }
  const stats = { z: r2(zMin), ...(Number.isFinite(liftMin) ? { lift: Math.round(liftMin * 1000) / 10 } : {}) };
  if (zMin >= threshold && liftMin >= MIN_LIFT) return { ...out, ...stats, verdict: 'winner', winner: best };
  return { ...out, ...stats, verdict: ended ? 'too_close' : 'keep_going', leader: best };
}
