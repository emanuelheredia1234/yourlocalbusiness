// shared/plans.json (spec §A2, C1.1): every tier has every key, lookup keys are unique, amounts match the Tiers table,
// and the credits math.
import { describe, expect, it } from 'vitest';
import { OWNER_PLAN, PLANS, PRICE_TABLE, TIERS, creditsFor, creditsToUsd, intervalFromLookupKey, lookupKeyFor, lookupKeysAll, planFor, tierFromLookupKey, tierRank, usdToCredits, videosPerWeekFor } from './plans.mjs';

const KEYS = ['name', 'price', 'lookupKeys', 'businessesIncluded', 'aiCreditsPerMonth', 'video', 'videosPerWeek', 'adsLaunch', 'treg', 'leadEmailsPerMonth', 'publicListings', 'customDomains', 'platformFeePct', 'promptControl', 'support'];

describe('plans.json', () => {
  it('has the three tiers in order, each with every key', () => {
    expect(TIERS).toEqual(['launch', 'grow', 'scale']);
    for (const t of TIERS) {
      expect(Object.keys(PLANS.plans[t]).sort()).toEqual([...KEYS].sort());
      expect(PLANS.plans[t].video).toEqual({ maxHeight: expect.any(Number), maxSeconds: expect.any(Number), label: expect.any(String) });
      expect(PLANS.plans[t].treg).toEqual({ monthlyMicro: expect.any(Number), dailyMicro: expect.any(Number) });
    }
    expect(Object.isFrozen(PLANS.plans.grow.price)).toBe(true);
  });

  it('matches the Tiers table', () => {
    const row = (t) => {
      const p = PLANS.plans[t];
      return [p.price.month, p.price.year, p.businessesIncluded, p.aiCreditsPerMonth, p.video.maxHeight, p.video.maxSeconds, p.adsLaunch, p.leadEmailsPerMonth, p.publicListings, p.customDomains, p.platformFeePct, p.promptControl, p.support];
    };
    expect(row('launch')).toEqual([9700, 97000, 1, 1500, 768, 10, false, 25, 3, 1, 3, 'style_notes', 'email']);
    expect(row('grow')).toEqual([19700, 197000, 1, 3500, 1440, 15, true, 150, 15, 3, 1, 'style_notes', 'email']);
    expect(row('scale')).toEqual([39700, 397000, 1, 7500, 1440, 15, true, 500, 50, 10, 0, 'per_prompt', 'priority']);
    expect(PLANS.additionalBusiness.price).toEqual({ month: 9700, year: 97000 });
    expect(PLANS.additionalBusiness.aiCreditsPerMonth).toBe(1000);
    expect(PLANS.creditUsd).toBe(0.01);
    expect(PLANS.graceDays).toBe(7);
    expect([PLANS.pagesAfterCancelDays, PLANS.dataAfterCancelDays]).toEqual([30, 90]);
  });

  it('has 8 unique lookup keys that map back to their tier and interval', () => {
    const keys = lookupKeysAll();
    expect(keys).toHaveLength(8);
    expect(new Set(keys).size).toBe(8);
    expect(keys).toEqual(['ylb_launch_monthly', 'ylb_launch_yearly', 'ylb_grow_monthly', 'ylb_grow_yearly', 'ylb_scale_monthly', 'ylb_scale_yearly', 'ylb_business_monthly', 'ylb_business_yearly']);
    expect(tierFromLookupKey('ylb_grow_yearly')).toBe('grow');
    expect(intervalFromLookupKey('ylb_grow_yearly')).toBe('year');
    expect(tierFromLookupKey('ylb_business_monthly')).toBe(null);
    expect(tierFromLookupKey('other')).toBe(null);
    expect(lookupKeyFor('business', 'year')).toBe('ylb_business_yearly');
    expect(PRICE_TABLE.ylb_scale_monthly).toMatchObject({ amount: 39700, product: 'ylb_scale', interval: 'month' });
  });

  it('counts credits: the tier plus 1,000 per extra business; the owner is unlimited', () => {
    expect(creditsFor('launch', 0)).toBe(1500);
    expect(creditsFor('grow', 2)).toBe(5500);
    expect(creditsFor('owner', 3)).toBe(null);
    expect(creditsFor('none')).toBe(0);
    expect(creditsToUsd(3500)).toBe(35);
    expect(usdToCredits(0.011)).toBe(2);
    expect(planFor('owner')).toBe(OWNER_PLAN);
    expect(planFor('nope')).toBe(null);
    expect(tierRank('scale')).toBeGreaterThan(tierRank('grow'));
  });

  it('has the weekly AI videos per business: Launch 3, Grow 5, Scale and the owner unlimited', () => {
    expect(TIERS.map((t) => PLANS.plans[t].videosPerWeek)).toEqual([3, 5, null]);
    expect(videosPerWeekFor('launch')).toBe(3);
    expect(videosPerWeekFor('grow')).toBe(5);
    expect(videosPerWeekFor('scale')).toBe(null);
    expect(videosPerWeekFor('owner')).toBe(null);
    expect(videosPerWeekFor('none')).toBe(0);
  });
});
