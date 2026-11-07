// Plans as the app shows them (src/lib/plans.ts, shared/plans.json): prices, the annual saving, the tier that has a
// feature, the comparison table, and billing hidden in the artifact build.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANS, TIERS, compareRows, creditsFor, experimentsPerMonthFor, experimentsUsageLabel, featureTier, formatPrice, isBillingUi, monthsFree, priceLine, tierRank, videosPerWeekFor, yearlySavings } from './plans';

afterEach(() => vi.unstubAllGlobals());

describe('prices', () => {
  it('formats whole dollars without cents, and cents when there are some', () => {
    expect(formatPrice(9700)).toBe('$97');
    expect(formatPrice(197000)).toBe('$1,970');
    expect(formatPrice(1234)).toBe('$12.34');
    expect(priceLine('grow', 'month')).toBe('$197/month');
    expect(priceLine('scale', 'year')).toBe('$3,970/year');
  });

  it('annual is ten months: the saving is two months of the monthly price', () => {
    expect(yearlySavings('launch')).toBe(9700 * 2);
    expect(yearlySavings('grow')).toBe(19700 * 2);
    expect(yearlySavings('scale')).toBe(39700 * 2);
    for (const t of TIERS) expect(monthsFree(t)).toBe(2);
  });

  it('credits: the tier’s plus 1,000 per extra business', () => {
    expect(creditsFor('launch')).toBe(1500);
    expect(creditsFor('grow', 2)).toBe(5500);
    expect(creditsFor('scale', -1)).toBe(7500);
  });
});

describe('tiers and features', () => {
  it('ranks tiers, the owner above them all', () => {
    expect(tierRank('launch')).toBeLessThan(tierRank('grow'));
    expect(tierRank('grow')).toBeLessThan(tierRank('scale'));
    expect(tierRank('owner')).toBeGreaterThan(tierRank('scale'));
    expect(tierRank(null)).toBe(-1);
  });

  it('names the lowest tier that has a feature', () => {
    expect(featureTier('adsLaunch')).toBe('grow');
    expect(featureTier('video_length')).toBe('grow');
    expect(featureTier('per_prompt')).toBe('scale');
    expect(featureTier('priority_support')).toBe('scale');
    expect(featureTier('anything_else')).toBe('launch');
  });

  it('the comparison table has a value for every tier on every row, from plans.json', () => {
    const rows = compareRows();
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const r of rows) for (const t of TIERS) expect(r.values[t]).not.toBeUndefined();
    const ads = rows.find((r) => r.label === 'Launch ads from the app')!;
    expect(ads.values).toEqual({ launch: false, grow: true, scale: true });
    expect(rows.find((r) => r.label === 'AI credits a month')!.values.grow).toBe(PLANS.plans.grow.aiCreditsPerMonth.toLocaleString('en-US'));
    expect(rows.find((r) => r.label === 'Fee on your sales')!.values).toEqual({ launch: '3%', grow: '1%', scale: 'None' });
    expect(rows.find((r) => r.label === 'AI videos a week, per business')!.values).toEqual({ launch: '3', grow: '5', scale: 'Unlimited' });
    expect(rows.find((r) => r.label === 'A/B tests a month')!.values).toEqual({ launch: '2', grow: '10', scale: 'Unlimited' });
    expect([experimentsPerMonthFor('launch'), experimentsPerMonthFor('grow'), experimentsPerMonthFor('scale'), experimentsPerMonthFor('owner')]).toEqual([2, 10, null, null]);
    expect(experimentsUsageLabel({ used: 1, limit: 2, resetsAt: '2026-12-01T12:00:00Z' })).toMatch(/^A\/B tests this month: 1 of 2 · resets Dec 1$/);
    expect(experimentsUsageLabel({ used: 3, limit: null })).toBe('A/B tests this month: 3 · unlimited');
    expect([videosPerWeekFor('launch'), videosPerWeekFor('grow'), videosPerWeekFor('scale'), videosPerWeekFor('owner')]).toEqual([3, 5, null, null]);
  });
});

describe('isBillingUi', () => {
  it('only when the server set up Stripe', () => {
    expect(isBillingUi({ enabled: true })).toBe(true);
    expect(isBillingUi({ enabled: false })).toBe(false);
    expect(isBillingUi(null)).toBe(false);
  });
  it('never in the claude.ai artifact build', () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    expect(isBillingUi({ enabled: true })).toBe(false);
  });
});
