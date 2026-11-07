// The monthly A/B test limit (P4b §S2): a test counts once, when it starts (the first variant posted, the page split
// going live, the Omnisend A/B draft created), in the account's AI-credit window, so "per month" resets with the
// credits. Launch 2, Grow 10, Scale unlimited; the owner and plans not enforced: unlimited. A paused plan can't start
// one (P1's 402). A post test whose first job certainly failed, with nothing else out, is given back (refund).

import { fail } from '../integrations/common.mjs';
import { iso } from './config.mjs';

const monthStart = (t) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
const nextMonth = (t) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};
const dayText = (v) => new Date(v).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
const UPGRADE = { launch: 'Grow', grow: 'Scale' };

/** { window (YYYY-MM-DD), resetsAt, limit, tier, unlimited } for a user now. */
export async function windowFor({ billing, now }, who) {
  const t = now();
  const ent = billing ? await billing.entitlement(who.id, who) : null;
  const unlimited = !ent || ent.plan === 'legacy' || ent.plan === 'owner';
  const start = ent?.creditWindow?.start && !ent.starter ? Date.parse(ent.creditWindow.start) : monthStart(t);
  const resetsAt = ent?.creditWindow?.resetsAt && !ent.starter ? ent.creditWindow.resetsAt : iso(nextMonth(t));
  const limit = unlimited ? null : (ent?.features?.experimentsPerMonth ?? null);
  return { window: iso(start).slice(0, 10), resetsAt, limit, tier: ent?.tier ?? null, unlimited };
}

/** "2 of 10 used": { used, limit, resetsAt } (limit null: unlimited). */
export async function usageFor(ctx, who) {
  const w = await windowFor(ctx, who);
  const used = Number(await ctx.store.count(who.id, w.window)) || 0;
  return { used, limit: w.limit, resetsAt: w.resetsAt };
}

/**
 * Start a draft test (counted in the month's limit). → { row (as it is now), started (here, not by another request) }.
 * Throws P1's 402 when the plan is paused, 402 EXPERIMENT_LIMIT at the limit, 409 EXPERIMENT_RUNNING when another
 * split runs on that page, 404 when it's gone.
 */
export async function startTest(ctx, who, row, { endsAt = null } = {}) {
  const { store, billing } = ctx;
  if (billing?.requireActive) await billing.requireActive(who, 'experiments');
  const w = await windowFor(ctx, who);
  const got = await store.start(row.id, who.id, w.window, w.limit);
  if (got === 'limit') {
    const more = UPGRADE[w.tier] ? `, or upgrade to ${UPGRADE[w.tier]}` : '';
    throw fail(402, 'EXPERIMENT_LIMIT', `You’ve used your ${w.limit} A/B ${w.limit === 1 ? 'test' : 'tests'} this month. They reset on ${dayText(w.resetsAt)}${more}.`, { used: w.limit, limit: w.limit, resetsAt: w.resetsAt, upgrade: '#plans' });
  }
  if (got === 'running') throw fail(409, 'EXPERIMENT_RUNNING', 'Another A/B test is already running on this page. Stop it first.');
  if (got === 'missing') throw fail(404, 'NOT_FOUND', 'That A/B test isn’t in your account.');
  // 'state': another request started it a moment ago (not counted again here)
  const started = got === 'ok';
  const now = started && endsAt != null ? await store.patch(who.id, row.id, { ends_at: iso(endsAt) }) : null;
  return { row: now ?? (await store.byId(who.id, row.id)), started };
}
