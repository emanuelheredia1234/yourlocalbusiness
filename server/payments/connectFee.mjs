// Our fee on a seller's Stripe sale (P6), pure: no I/O.
//
//   feeForEntitlement(ent)  → { pct, tier }    the percentage a seller's plan takes (shared/plans.json platformFeePct)
//   platformFee({ amountMinor, pct, sellerCountry, platformCountry }) → { fee, reason }
//
// Rules (docs/integrations-setup.md "Stripe Connect"):
// - The plan's platformFeePct: Launch 3, Grow 1, Scale 0; the owner and plans-not-enforced ('legacy') 0; a free plan
//   (comp) and a card trial their tier's; a plan in grace its tier's. A seller with no plan, an ended plan or a paused
//   one pays Launch's (the buy links keep working for the days P1 allows).
// - fee = floor(amount × pct / 100) (rounding favours the seller). Stripe takes a fee only when it's a positive whole
//   number below the amount, so 0 (and anything at or above the amount) is left out rather than sent.
// - A seller in Brazil pays no fee unless the platform is in Brazil too (Stripe doesn't allow it across borders).

import { PLANS } from '../billing/plans.mjs';

export const FEE_TIERS = Object.freeze(['launch', 'grow', 'scale', 'owner', 'legacy', 'none']);
const LAUNCH_PCT = Number(PLANS.plans.launch.platformFeePct) || 0;

/** The fee percentage and the plan it came from, for an entitlement (server/billing/entitlement.mjs). */
export function feeForEntitlement(ent) {
  const plan = String(ent?.plan ?? 'none');
  const raw = Number(ent?.features?.platformFeePct);
  const pct = Number.isFinite(raw) ? Math.min(100, Math.max(0, Math.trunc(raw))) : LAUNCH_PCT;
  if (plan === 'legacy' || plan === 'owner') return { pct, tier: plan };
  // no plan, an ended plan or a paused one: Launch's fee
  if (ent?.active !== true) return { pct: LAUNCH_PCT, tier: 'none' };
  return { pct, tier: FEE_TIERS.includes(plan) ? plan : 'none' };
}

/**
 * The fee to send with a Checkout Session, in minor units, or 0 with why it's left out:
 * reason 'ok' | 'zero' | 'not_below_amount' | 'country' | 'bad_input'.
 */
export function platformFee({ amountMinor, pct, sellerCountry = null, platformCountry = 'US' }) {
  const amount = Number(amountMinor);
  const p = Number(pct);
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isFinite(p) || p < 0 || p > 100) return { fee: 0, reason: 'bad_input' };
  if (String(sellerCountry ?? '').toUpperCase() === 'BR' && String(platformCountry ?? '').toUpperCase() !== 'BR') return { fee: 0, reason: 'country' };
  // whole-number math: pct is a whole percentage, so amount × pct is exact
  const fee = Math.floor((amount * Math.trunc(p)) / 100);
  if (fee <= 0) return { fee: 0, reason: 'zero' };
  if (fee >= amount) return { fee: 0, reason: 'not_below_amount' };
  return { fee, reason: 'ok' };
}

/** Our fee's share of money going back to the buyer: floor(fee × back / amount), capped at what's left. */
export function feeShare({ feeMinor, returnedMinor = 0, amountMinor, backMinor }) {
  const fee = Number(feeMinor) || 0;
  const amount = Number(amountMinor) || 0;
  const back = Number(backMinor) || 0;
  if (fee <= 0 || amount <= 0 || back <= 0) return 0;
  const left = Math.max(0, fee - (Number(returnedMinor) || 0));
  return Math.min(left, Math.floor((fee * Math.min(back, amount)) / amount));
}
