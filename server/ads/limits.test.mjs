// The owner's limits (server/ads/limits.mjs, spec §10.1 as adapted: the ad_limits table): merging and failing
// closed, the hard ceilings, committed daily by switch, each limit code, and what never looks at limits.
import { describe, expect, it } from 'vitest';
import { ADS_BUILTIN_DEFAULTS, hardCeilings, increaseProblems, launchEnabled, launchProblems, mergeLimits, parsePatch, switchesProblem, switchMayBeOn } from './limits.mjs';

const DEF = { customer_tag: '*', ads_enabled: true, ads_currency: 'USD', ads_max_daily: 50, ads_max_change: 50, ads_max_campaign_total: 750, ads_launches_per_day: 3, ads_changes_per_day: 20, version: 4 };
const ON = { ADS_LAUNCH_ENABLED: '1' };
const codes = (l) => l.map((n) => n.code);

describe('merging', () => {
  it('fails closed: no defaults row means ads off whatever a customer row says; the built-ins are off', () => {
    expect(ADS_BUILTIN_DEFAULTS.ads_enabled).toBe(false);
    expect(mergeLimits(null, { ads_enabled: true }, ON).ads_enabled).toBe(false);
    expect(mergeLimits({ ...DEF, ads_enabled: null }, null, ON).ads_enabled).toBe(false);
  });

  it('a customer row overrides field by field; null inherits', () => {
    const m = mergeLimits(DEF, { ads_max_daily: 100, ads_max_change: null, version: 2 }, ON);
    expect(m).toMatchObject({ ads_enabled: true, ads_max_daily: 100, ads_max_change: 50, version: '4:2' });
  });

  it('the hard ceilings win over any owner value', () => {
    const m = mergeLimits({ ...DEF, ads_max_daily: 9999, ads_max_change: 9999 }, null, { ADS_HARD_MAX_DAILY: '300', ADS_HARD_MAX_CHANGE: '100' });
    expect(m).toMatchObject({ ads_max_daily: 300, ads_max_change: 100 });
    expect(hardCeilings({})).toEqual({ daily: 500, change: 200 });
  });
});

describe('switches', () => {
  it('needs ADS_LAUNCH_ENABLED=1, ads on for the customer, and a customer that isn’t blocked', () => {
    expect(launchEnabled({})).toBe(false);
    expect(launchEnabled({ ADS_LAUNCH_ENABLED: 'true' })).toBe(false);
    const lim = mergeLimits(DEF, null, ON);
    expect(switchesProblem(lim, {})).toBe('KILL_SWITCH');
    expect(switchesProblem({ ...lim, ads_enabled: false }, ON)).toBe('ADS_OFF');
    expect(switchesProblem({ ...lim, blocked: true }, ON)).toBe('BLOCKED');
    expect(switchesProblem(lim, ON)).toBeNull();
  });
});

describe('launch limits', () => {
  const lim = mergeLimits(DEF, null, ON);
  const base = { lim, currency: 'USD', daily: 25, days: 14, choice: 'ACTIVE', committed: 0, launchesToday: 0 };
  it('passes a launch inside every limit', () => expect(launchProblems(base)).toEqual([]));
  it('LIMIT_CHANGE: one launch’s daily over the per-change limit', () => expect(codes(launchProblems({ ...base, daily: 60, days: 1, choice: 'PAUSED' }))).toEqual(['LIMIT_CHANGE']));
  it('LIMIT_TOTAL: daily × days over the campaign total', () => expect(codes(launchProblems({ ...base, daily: 50, days: 16 }))).toEqual(['LIMIT_TOTAL']));
  it('LIMIT_DAILY: committed + this over the daily limit (ACTIVE only)', () => {
    expect(codes(launchProblems({ ...base, committed: 30 }))).toEqual(['LIMIT_DAILY']);
    expect(launchProblems({ ...base, committed: 30, choice: 'PAUSED' })).toEqual([]);
  });
  it('LIMIT_LAUNCHES: launches per day', () => expect(codes(launchProblems({ ...base, launchesToday: 3 }))).toEqual(['LIMIT_LAUNCHES']));
  it('LIMIT_CURRENCY: an account in another currency', () => expect(codes(launchProblems({ ...base, currency: 'EUR' }))).toEqual(['LIMIT_CURRENCY']));
  it('sums in minor units: 25.10 + 24.90 is exactly 50', () => expect(launchProblems({ ...base, daily: 24.9, committed: 25.1 }).map((n) => n.code)).not.toContain('LIMIT_DAILY'));
});

describe('increase limits', () => {
  const lim = mergeLimits(DEF, null, ON);
  it('checks the delta, the whole-campaign total, committed after and changes per day', () => {
    expect(increaseProblems({ lim, currency: 'USD', delta: 15, daily: 40, total: 500, committedAfter: 40, changesToday: 0 })).toEqual([]);
    expect(codes(increaseProblems({ lim, currency: 'USD', delta: 55, daily: 80, total: 500, committedAfter: 40, changesToday: 0 }))).toEqual(['LIMIT_CHANGE']);
    expect(codes(increaseProblems({ lim, currency: 'USD', delta: 0, daily: 25, total: 751, committedAfter: 25, changesToday: 0 }))).toEqual(['LIMIT_TOTAL']);
    expect(codes(increaseProblems({ lim, currency: 'USD', delta: 5, daily: 30, total: 100, committedAfter: 51, changesToday: 0 }))).toEqual(['LIMIT_DAILY']);
    expect(codes(increaseProblems({ lim, currency: 'USD', delta: 5, daily: 30, total: 100, committedAfter: 30, changesToday: 20 }))).toEqual(['LIMIT_CHANGES']);
    expect(codes(increaseProblems({ lim, currency: 'USD', isResume: true, daily: 60, total: 100, committedAfter: 60, changesToday: 0 }))).toEqual(['LIMIT_CHANGE', 'LIMIT_DAILY']);
  });
});

describe('committed daily: by the campaign switch, not the review', () => {
  it('counts a switch that is on or may be on', () => {
    expect(switchMayBeOn({ id: 'a', state: 'rejected', configured_status: 'ACTIVE' })).toBe(true);
    expect(switchMayBeOn({ id: 'a', state: 'in_review', configured_status: 'ACTIVE' })).toBe(true);
    expect(switchMayBeOn({ id: 'a', state: 'launching', configured_status: 'PAUSED' })).toBe(true);
    expect(switchMayBeOn({ id: 'a', state: 'unknown', configured_status: 'PAUSED' })).toBe(true);
    expect(switchMayBeOn({ id: 'a', state: 'paused', configured_status: 'PAUSED' }, new Set(['a']))).toBe(true);
  });
  it('leaves out paused, ended, completed and failed rows', () => {
    expect(switchMayBeOn({ id: 'a', state: 'paused', configured_status: 'PAUSED' })).toBe(false);
    for (const state of ['ended', 'completed', 'failed']) expect(switchMayBeOn({ id: 'a', state, configured_status: 'ACTIVE' })).toBe(false);
  });
});

describe('the owner’s edits', () => {
  it('takes known fields only and refuses values above the ceilings', () => {
    expect(parsePatch({ maxDaily: 100, adsEnabled: true, launchesPerDay: 5, adsCurrency: 'EUR' })).toEqual({ ads_max_daily: 100, ads_enabled: true, ads_launches_per_day: 5, ads_currency: 'EUR' });
    expect(parsePatch({ maxDaily: null })).toEqual({ ads_max_daily: null });
    expect(() => parsePatch({ maxDaily: 501 })).toThrow(/ADS_HARD_MAX_DAILY/);
    expect(() => parsePatch({ maxChange: 201 })).toThrow(/ADS_HARD_MAX_CHANGE/);
    expect(() => parsePatch({ maxDaily: 10.001 })).toThrow();
    expect(() => parsePatch({ adsCurrency: 'usd' })).toThrow();
    expect(() => parsePatch({ other: 1 })).toThrow(/Nothing to change/);
  });
});
