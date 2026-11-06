import { describe, expect, it } from 'vitest';
import type { Entitlement, PlanAccount } from '@/lib/integrations/types';
import { shortDate, videoAllowance, videoDaysOverLimit, videoWeekFull, videoWeekLimitText, videoWeekLine } from './videoWeek';

const ent = (over: Partial<Entitlement>): Entitlement => ({ plan: 'launch', active: true, paused: null, banner: null, tier: 'launch', businessLimit: 1, creditsPerMonth: 1500, creditWindow: null, features: { adsLaunch: false, video: { maxHeight: 768, maxSeconds: 10 }, videosPerWeek: 3, treg: null, leadEmailsPerMonth: 25, publicListings: 3, customDomains: 1, platformFeePct: 3, promptControl: 'style_notes' }, ...over }) as Entitlement;

describe('weekly AI videos (app side)', () => {
  it('shows “2 of 3 videos used this week” and nothing while plans are off', () => {
    expect(videoWeekLine({ used: 2, limit: 3, resetsAt: '', enforced: true })).toBe('2 of 3 videos used this week · resets Monday');
    expect(videoWeekLine({ used: 0, limit: 1, resetsAt: '', enforced: true })).toBe('0 of 1 video used this week · resets Monday');
    expect(videoWeekLine({ used: 4, limit: null, resetsAt: '', enforced: true })).toBe('Unlimited AI videos · 4 videos this week');
    expect(videoWeekLine({ used: 4, limit: null, resetsAt: '', enforced: false })).toBeNull();
    expect(videoWeekLine({ used: 1, limit: 3, resetsAt: '', enforced: true, known: false })).toBeNull();
    expect(videoWeekLimitText(3, 3)).toBe('You’ve made 3 of 3 videos this week. Resets Monday.');
    expect(videoWeekFull({ used: 3, limit: 3, resetsAt: '', enforced: true })).toBe(true);
    expect(videoWeekFull({ used: 3, limit: 3, resetsAt: '', enforced: false })).toBe(false);
    // the account's week was used up first: its count, and the upgrade link shows
    const acct = { used: 3, limit: 3, scope: 'account' as const, resetsAt: '', enforced: true };
    expect(videoWeekLine(acct)).toBe('3 of 3 videos used this week across your businesses · resets Monday');
    expect(videoWeekFull(acct)).toBe(true);
  });

  it('the reset date is shown in the business’s time zone', () => {
    // Monday Nov 9 00:00 in Sydney is Sunday Nov 8 in Los Angeles
    expect(shortDate('2026-11-08T13:00:00.000Z', 'Australia/Sydney')).toBe('Nov 9');
    expect(shortDate('2026-11-08T13:00:00.000Z', 'America/Los_Angeles')).toBe('Nov 8');
    expect(shortDate('2026-11-08T13:00:00.000Z', 'Not/AZone')).toMatch(/^Nov \d+$/);
    expect(shortDate(null)).toBe('');
  });

  it('the allowance: the plan in force, the account’s tier while plans are off, nothing for the owner', () => {
    expect(videoAllowance(ent({}), null)).toEqual({ perWeek: 3, enforced: true, planName: 'Launch' });
    expect(videoAllowance(ent({ plan: 'grow', tier: 'grow', features: { ...ent({}).features, videosPerWeek: 5 } }), null)).toMatchObject({ perWeek: 5 });
    expect(videoAllowance(ent({ plan: 'scale', tier: 'scale', features: { ...ent({}).features, videosPerWeek: null } }), null)).toMatchObject({ perWeek: null, enforced: true });
    expect(videoAllowance(ent({ plan: 'owner', tier: 'owner' }), null)).toBeNull();
    // plans not turned on: warn from the account's tier, never enforced
    expect(videoAllowance(ent({ plan: 'legacy', tier: 'legacy' }), { tier: 'grow' } as PlanAccount)).toEqual({ perWeek: 5, enforced: false, planName: 'Grow' });
    expect(videoAllowance(null, null)).toBeNull();
    // an older server without videosPerWeek in the features: from plans.json
    const old = ent({});
    delete (old.features as { videosPerWeek?: unknown }).videosPerWeek;
    expect(videoAllowance(old, null)?.perWeek).toBe(3);
  });

  it('says when the chosen video days go over the plan', () => {
    const a = { perWeek: 3, enforced: true, planName: 'Launch' };
    expect(videoDaysOverLimit(3, a)).toBeNull();
    expect(videoDaysOverLimit(5, a)).toBe('You chose 5 videos a week; Launch makes 3 AI videos a week for each business, so the rest won’t be made. Choose fewer video days, or upgrade.');
    expect(videoDaysOverLimit(5, { ...a, enforced: false })).toMatch(/before plans start/);
    expect(videoDaysOverLimit(9, { perWeek: null, enforced: true, planName: 'Scale' })).toBeNull();
    expect(videoDaysOverLimit(9, null)).toBeNull();
  });
});
