// The paid-tier hook for ads: whether a user may launch ads or raise what they spend. Checked server side only,
// and only before a launch, a resume, a budget increase and a later end date (and for the canLaunch flag on
// GET /api/ads/accounts), after the owner's switches and before the limits. Never for pause, end, a decrease,
// an earlier end date, a creative swap, Check status, reads or the owner's Pause all. A refusal is
// 403 PLAN_REQUIRED. The tier phase replaces this one function (routes take deps.canLaunchAds).

/** Whether this user may launch ads or raise spend. Paid tiers later: Grow and up. One change here. */
export async function canLaunchAds(userId, deps = {}) {
  void userId;
  void deps;
  return true;
}
