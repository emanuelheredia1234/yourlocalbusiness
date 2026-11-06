// The paid-tier hook for ads: whether a user may launch ads or raise what they spend. Checked server side only,
// and only before a launch, a resume, a budget increase and a later end date (and for the canLaunch flag on
// GET /api/ads/accounts), after the owner's switches and before the limits. Never for pause, end, a decrease,
// an earlier end date, a creative swap, Check status, reads or the owner's Pause all. A refusal is
// 403 PLAN_REQUIRED (kept as it was: the app treats PLAN_REQUIRED the same whatever the status).
//
// Plans (server/billing/stripe.mjs): with no billing, or plans not enforced, everyone may (as before plans).
// Enforced: Grow, Scale, the owner and a free Grow plan may; Launch, no plan and a paused plan may not. The
// owner's per-customer ad limits still apply after this.

/** Whether this user may launch ads or raise spend. deps.billing: the plans facade (server/integrations/wiring.mjs). */
export async function canLaunchAds(userId, deps = {}) {
  const billing = deps.billing;
  if (!billing?.entitlement) return true;
  const ent = await billing.entitlement(userId, deps.who ?? null);
  if (ent.plan === 'legacy') return true;
  return ent.active === true && ent.features?.adsLaunch === true;
}
