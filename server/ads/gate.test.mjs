// The paid-tier hook (server/ads/gate.mjs). Where it is checked (launch, resume, increases, later end dates, the
// canLaunch flag) and where it never is (pause, end, decreases, checks, reads) is tested through the routes in
// routes.test.mjs; here, the answer per plan (spec §A6.2).
import { describe, expect, it } from 'vitest';
import { canLaunchAds } from './gate.mjs';
import { entitlementOf } from '../billing/entitlement.mjs';

const UID = '0b6f3a52-5d0e-4c58-9a0c-0e7c5b1d2a11';
const billingFor = (acct, enforce = true, opts = {}) => ({ entitlement: async () => entitlementOf(acct, { enforce }, Date.parse('2026-11-15T00:00:00Z'), opts) });
const acct = (over) => ({ source: 'stripe', status: 'active', business_limit: 1, current_period_start: '2026-11-01T00:00:00Z', current_period_end: '2026-12-01T00:00:00Z', ...over });

describe('canLaunchAds', () => {
  it('lets every signed-in user launch without billing, or while plans are not enforced', async () => {
    await expect(canLaunchAds(UID)).resolves.toBe(true);
    await expect(canLaunchAds(UID, { db: null })).resolves.toBe(true);
    await expect(canLaunchAds(UID, { billing: billingFor(null, false) })).resolves.toBe(true);
  });

  it('enforced: Grow, Scale, a free Grow plan and the owner may; Launch, no plan and a paused plan may not', async () => {
    await expect(canLaunchAds(UID, { billing: billingFor(acct({ tier: 'grow' })) })).resolves.toBe(true);
    await expect(canLaunchAds(UID, { billing: billingFor(acct({ tier: 'scale' })) })).resolves.toBe(true);
    await expect(canLaunchAds(UID, { billing: billingFor(acct({ tier: 'grow', source: 'comp', status: 'trialing', comp_until: '2026-12-01T00:00:00Z' })) })).resolves.toBe(true);
    await expect(canLaunchAds(UID, { billing: billingFor(null, true, { isAdmin: true }) })).resolves.toBe(true);
    await expect(canLaunchAds(UID, { billing: billingFor(acct({ tier: 'launch' })) })).resolves.toBe(false);
    await expect(canLaunchAds(UID, { billing: billingFor(null) })).resolves.toBe(false);
    await expect(canLaunchAds(UID, { billing: billingFor(acct({ tier: 'scale', status: 'unpaid' })) })).resolves.toBe(false);
  });
});
