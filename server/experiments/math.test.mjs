// The winner math (P4b §S7): minimum samples per kind, ties, the two-proportion z-test with the 10% lift rule,
// Bonferroni with three variants, the count test for views, like-for-like keys, notes and missing variants.
import { describe, expect, it } from 'vitest';
import { MINIMUMS, MIN_LIFT, Z_THREE, Z_TWO } from './config.mjs';
import { decide, measure, zCounts, zTwoProportions } from './math.mjs';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const BEFORE = NOW + 86_400_000;
const AFTER = NOW - 1;
const social = (key, m) => ({ key, metrics: m });
const post = (variants, over = {}) => decide({ kind: 'post', mode: 'times', changed: 'time', metric: 'engagement_rate', endsAt: BEFORE, now: NOW, variants, ...over });
const page = (rows, over = {}) => decide({ kind: 'page', mode: 'split', changed: 'headline', metric: 'lead_rate', endsAt: BEFORE, now: NOW, variants: rows.map(([key, visitors, leads]) => ({ key, visitors, leads })), ...over });

describe('the constants', () => {
  it('are the documented ones', () => {
    expect(MINIMUMS).toEqual({ social: { trials: 300, successes: 20 }, page: { trials: 100, successes: 10 }, email: { trials: 200, successes: 0 }, counts: { total: 400, perVariant: 100 } });
    expect([Z_TWO, Z_THREE, MIN_LIFT]).toEqual([1.96, 2.394, 0.1]);
    expect(zTwoProportions(50, 1000, 30, 1000)).toBeCloseTo(2.282, 2);
    expect(zCounts(260, 200)).toBeCloseTo(2.797, 2);
    expect(zTwoProportions(0, 0, 1, 1)).toBe(0);
  });
});

describe('minimum sample', () => {
  it('just under the minimum keeps going before the deadline and is not enough after it, saying what’s missing', () => {
    const under = [social('a', { reach: 299, likes: 30 }), social('b', { reach: 400, likes: 20 })];
    expect(post(under)).toMatchObject({ verdict: 'keep_going', reason: 'sample' });
    const after = post(under, { endsAt: AFTER });
    expect(after).toMatchObject({ verdict: 'not_enough', reason: 'sample', missing: [{ key: 'a', what: 'reach', have: 299, need: 300 }] });
    // too few engagements in all
    expect(post([social('a', { reach: 500, likes: 9 }), social('b', { reach: 500, likes: 10 })], { endsAt: AFTER }).missing).toEqual([{ what: 'engagements', have: 19, need: 20 }]);
    // pages: 100 visitors per version and 10 leads in all
    expect(page([['a', 99, 5], ['b', 100, 6]]).verdict).toBe('keep_going');
    expect(page([['a', 100, 4], ['b', 100, 5]], { endsAt: AFTER })).toMatchObject({ verdict: 'not_enough', missing: [{ what: 'leads', have: 9, need: 10 }] });
    // email: 200 sent per version
    const email = (a, b) => decide({ kind: 'email', mode: 'split', changed: 'subject', metric: 'open_rate', endsAt: AFTER, now: NOW, variants: [{ key: 'a', metrics: { sent: a, openRate: 0.4 } }, { key: 'b', metrics: { sent: b, openRate: 0.3 } }] });
    expect(email(199, 300)).toMatchObject({ verdict: 'not_enough', missing: [{ key: 'a', what: 'sent', have: 199, need: 200 }] });
    expect(email(1000, 1000).verdict).toBe('winner');
  });
});

describe('ties', () => {
  it('identical rates, 0 and 0 included, are a tie', () => {
    expect(post([social('a', { reach: 1000, likes: 50 }), social('b', { reach: 1000, likes: 50 })]).verdict).toBe('tie');
    const zero = decide({ kind: 'email', mode: 'split', changed: 'subject', metric: 'click_rate', endsAt: BEFORE, now: NOW, variants: [{ key: 'a', metrics: { sent: 300, clickRate: 0 } }, { key: 'b', metrics: { sent: 500, clickRate: 0 } }] });
    expect(zero.verdict).toBe('tie');
    expect(decide({ kind: 'post', mode: 'trial_reels', changed: 'hook', metric: 'views', endsAt: BEFORE, now: NOW, variants: [social('a', { views: 300 }), social('b', { views: 300 })] }).verdict).toBe('tie');
  });
});

describe('rates', () => {
  it('a clear winner needs z ≥ 1.96 and at least a 10% lift', () => {
    const r = post([social('a', { reach: 1000, likes: 20, comments: 10 }), social('b', { reach: 1000, likes: 40, comments: 10 })]);
    expect(r).toMatchObject({ verdict: 'winner', winner: 'b', measure: 'reach', perVariant: { a: { successes: 30, trials: 1000, rate: 0.03 }, b: { successes: 50, trials: 1000, rate: 0.05 } } });
    expect(r.z).toBeGreaterThanOrEqual(1.96);
    expect(r.lift).toBe(66.7);
  });

  it('a significant z with a lift under 10% is too close to call (after the deadline), keep going before it', () => {
    const v = [social('a', { reach: 400_000, likes: 20_000 }), social('b', { reach: 400_000, likes: 21_200 })];
    const before = post(v);
    expect(before.z).toBeGreaterThan(1.96);
    expect(before.lift).toBe(6);
    expect(before.verdict).toBe('keep_going');
    expect(post(v, { endsAt: AFTER }).verdict).toBe('too_close');
  });

  it('three variants need |z| ≥ 2.394 against each other (Bonferroni)', () => {
    // b vs a: z ≈ 2.2 (passes 1.96, not 2.394)
    const v = [social('a', { reach: 2000, likes: 100 }), social('b', { reach: 2000, likes: 135 }), social('c', { reach: 2000, likes: 60 })];
    const z = zTwoProportions(135, 2000, 100, 2000);
    expect(z).toBeGreaterThan(1.96);
    expect(z).toBeLessThan(2.394);
    expect(post(v, { endsAt: AFTER }).verdict).toBe('too_close');
    expect(post(v.slice(0, 2), { endsAt: AFTER })).toMatchObject({ verdict: 'winner', winner: 'b' });
  });

  it('pages compare leads over visitors', () => {
    expect(page([['a', 1000, 20], ['b', 1000, 45]])).toMatchObject({ verdict: 'winner', winner: 'b', perVariant: { a: { rate: 0.02 }, b: { rate: 0.045 } } });
  });
});

describe('counts (Trial Reels views)', () => {
  it('a conditional binomial test with the same thresholds and lift rule', () => {
    const tr = (a, b, endsAt = BEFORE) => decide({ kind: 'post', mode: 'trial_reels', changed: 'hook', metric: 'views', endsAt, now: NOW, variants: [social('a', { views: a }), social('b', { views: b })] });
    expect(tr(260, 200, AFTER)).toMatchObject({ verdict: 'winner', winner: 'a', note: 'non_followers', perVariant: { a: { count: 260 }, b: { count: 200 } } });
    expect(tr(215, 200, AFTER).verdict).toBe('too_close');
    expect(tr(150, 100).verdict).toBe('keep_going');
    expect(tr(150, 100, AFTER)).toMatchObject({ verdict: 'not_enough', missing: [{ what: 'views', have: 250, need: 400 }] });
  });

  it('never calls counts before the deadline (one version may have been out longer), and needs a minimum per version', () => {
    const tr = (a, b, endsAt = BEFORE) => decide({ kind: 'post', mode: 'trial_reels', changed: 'hook', metric: 'views', endsAt, now: NOW, variants: [social('a', { views: a }), social('b', { views: b })] });
    // A posted Monday, B Wednesday: A is far ahead only because it's been out longer
    expect(tr(2000, 60)).toMatchObject({ verdict: 'keep_going', reason: 'sample' });
    expect(tr(2000, 300)).toMatchObject({ verdict: 'keep_going', leader: 'a' });
    expect(tr(2000, 60).winner).toBeUndefined();
    expect(tr(260, 200)).toMatchObject({ verdict: 'keep_going', leader: 'a' });
    // no deadline yet (Trial Reels before the first one is out): never a winner
    expect(tr(2000, 300, null).verdict).toBe('keep_going');
    // at the deadline, a version under the per-version minimum is not enough, not a loser
    expect(tr(400, 0, AFTER)).toMatchObject({ verdict: 'not_enough', reason: 'sample', missing: [{ key: 'b', what: 'views', have: 0, need: 100 }] });
    expect(tr(2000, 60, AFTER)).toMatchObject({ verdict: 'not_enough', minimums: { total: 400, perVariant: 100 } });
    const reach = decide({ kind: 'post', mode: 'times', changed: 'hook', metric: 'reach', endsAt: BEFORE, now: NOW, variants: [social('a', { reach: 900 }), social('b', { reach: 300 })] });
    expect(reach.verdict).toBe('keep_going');
  });
});

describe('like for like', () => {
  it('compares only keys both variants reported; different measures are no_common_measure; a missing key is never 0', () => {
    expect(post([social('a', { reach: 1000, likes: 30 }), social('b', { views: 1000, likes: 30 })], { endsAt: AFTER })).toMatchObject({ verdict: 'not_enough', reason: 'no_common_measure' });
    // saves only on b: left out of both, so b's saves don't make it win
    const r = post([social('a', { reach: 1000, likes: 40 }), social('b', { reach: 1000, likes: 40, saves: 30 })]);
    expect(r.verdict).toBe('tie');
    // reach on one, views on both: views are used for both
    expect(measure({ kind: 'post', metric: 'engagement_rate' }, [social('a', { reach: 1, views: 500, likes: 1 }), social('b', { views: 500, likes: 1 })]).measure).toBe('views');
  });
});

describe('notes and missing variants', () => {
  it('time_differs for times tests of something else, non_followers for Trial Reels, nothing for a time test', () => {
    const v = [social('a', { reach: 1000, likes: 50 }), social('b', { reach: 1000, likes: 50 })];
    expect(post(v, { changed: 'hook' }).note).toBe('time_differs');
    expect(post(v, { changed: 'time' }).note).toBeUndefined();
    expect(post(v, { mode: 'trial_reels', changed: 'caption' }).note).toBe('non_followers');
  });

  it('a variant whose post is gone, or whose job failed or is unknown, is not enough (variant_missing)', () => {
    const r = post([social('a', { reach: 1000, likes: 30 }), { key: 'b', metrics: {}, missing: true }]);
    expect(r).toMatchObject({ verdict: 'not_enough', reason: 'variant_missing' });
  });
});
