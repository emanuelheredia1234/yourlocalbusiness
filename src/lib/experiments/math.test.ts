import { describe, expect, it } from 'vitest';
import { DASH, lastUpdated, metricLine, missingCopy, pct, resultNotes, secondaryNumbers, verdictCopy } from './math';
import type { Experiment, ExperimentVariant } from '@/lib/types';

const variant = (key: 'a' | 'b', o: Partial<ExperimentVariant> = {}): ExperimentVariant => ({ key, label: '', postId: null, jobId: null, plannedAt: null, shareMode: null, hasHtml: false, omnisendCampaignId: null, metrics: {}, metricsAt: null, metricsError: null, visitors: 0, views: 0, leads: 0, ...o });

describe('display of an A/B result', () => {
  it('rates with their counts, and unknown as a dash', () => {
    const e = { metric: 'engagement_rate' as const, result: { measure: 'reach', perVariant: { a: { successes: 41, trials: 1210, rate: 0.034 } } } };
    expect(metricLine(e, 'a')).toBe('3.4% · 41 of 1,210 reached');
    expect(metricLine(e, 'b')).toBe(DASH);
    expect(metricLine({ metric: 'views', result: { perVariant: { a: { count: 2340 } } } }, 'a')).toBe('2,340 views');
    expect(pct(undefined)).toBe(DASH);
    expect(pct(0)).toBe('0%');
  });

  it('a metric a network did not report is "—", never 0', () => {
    const rows = secondaryNumbers({ kind: 'post' }, variant('a', { metrics: { views: 10, likes: 0 } }));
    expect(rows.find((r) => r.label === 'Views')!.value).toBe('10');
    expect(rows.find((r) => r.label === 'Likes')!.value).toBe('0');
    expect(rows.find((r) => r.label === 'Saves')!.value).toBe(DASH);
    expect(secondaryNumbers({ kind: 'email' }, variant('a')).every((r) => r.value === DASH)).toBe(true);
    expect(secondaryNumbers({ kind: 'page' }, variant('a', { visitors: 200, leads: 10 })).map((r) => r.value)).toEqual(['200', '10', '5%']);
  });

  it('a verdict banner for each verdict, never "significant"', () => {
    const base = { state: 'running' as const, endsAt: '2026-11-20T12:00:00Z', metric: 'engagement_rate' as const, winner: null };
    const per = { a: { rate: 0.031 }, b: { rate: 0.034 } };
    const cases = [
      [{ verdict: 'winner', winner: 'b', lift: 18, perVariant: per }, /^Clear winner: Version B \+18%$/],
      [{ verdict: 'too_close', perVariant: per }, /^Too close to call$/],
      [{ verdict: 'tie', perVariant: per }, /^Tie$/],
      [{ verdict: 'not_enough', reason: 'sample', missing: [{ key: 'b', what: 'reach', have: 120, need: 300 }] }, /^Not enough data to call it$/],
      [{ verdict: 'keep_going', leader: 'b' }, /^Keep going$/],
      [{}, /^Not enough data yet$/],
    ] as const;
    for (const [result, title] of cases) {
      const v = verdictCopy({ ...base, result: result as Experiment['result'] });
      expect(v.title).toMatch(title);
      expect(`${v.title} ${v.body}`).not.toMatch(/significan/i);
    }
    expect(verdictCopy({ ...base, result: { verdict: 'too_close', perVariant: per } }).body).toBe('A 3.1% vs B 3.4%. Both work about the same.');
    expect(verdictCopy({ ...base, result: { verdict: 'not_enough', reason: 'sample', missing: [{ key: 'b', what: 'reach', have: 120, need: 300 }] } }).body).toBe('Version B needs 300 reached (has 120)');
  });

  it('notes: different times, non-followers, more than one change, your pick', () => {
    expect(resultNotes({ result: { note: 'time_differs' }, winner: null }, true)).toEqual(['These went out at different times, which can also change results.', 'More than one thing changed between the versions, so the result can’t say which made the difference.']);
    expect(resultNotes({ result: { note: 'non_followers' }, winner: null })[0]).toMatch(/non-followers/);
    expect(resultNotes({ result: { pickedByYou: true }, winner: 'a' })).toEqual(['Version A is your pick: the numbers didn’t call it.']);
    expect(missingCopy({ reason: 'variant_missing' })).toMatch(/missing/);
  });

  it('last updated', () => {
    expect(lastUpdated(null)).toBe('');
    expect(lastUpdated('2026-11-07T10:00:00Z', Date.parse('2026-11-07T11:00:00Z'))).toMatch(/^Last updated \d/);
  });
});
