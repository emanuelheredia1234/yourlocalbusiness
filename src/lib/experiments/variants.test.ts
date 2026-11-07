import { describe, expect, it } from 'vitest';
import { alsoChanged, applyEmailChange, applyPostChange, captionParts, costLine, defaultPlannedTimes, emailDiff, heroAlsoChanged, heroDiff, localPieces, postDiff, postNowGate, validatePieces, variantPost } from './variants';
import type { Experiment, ExperimentVariant, Post } from '@/lib/types';

const SRC = { headline: 'Fresh bread daily', caption: 'Our sourdough is back.\nBaked at 5 am with local flour.\nOrder yours: link in bio.', hashtags: ['#bread'], visualPrompt: 'a loaf on a board' };

describe('a post version from one changed piece', () => {
  it('splits a caption into hook, body and call to action', () => {
    expect(captionParts(SRC.caption)).toEqual({ hook: 'Our sourdough is back.', body: 'Baked at 5 am with local flour.', cta: 'Order yours: link in bio.' });
    expect(captionParts('One line')).toEqual({ hook: 'One line', body: '', cta: '' });
  });

  it('changes only the named piece', () => {
    const hook = applyPostChange(SRC, 'hook', 'Guess what’s back?');
    expect(postDiff(SRC, hook)).toEqual(['hook']);
    expect(alsoChanged('hook', postDiff(SRC, hook))).toEqual([]);
    const cta = applyPostChange(SRC, 'cta', 'Message us to reserve a loaf.');
    expect(postDiff(SRC, cta)).toEqual(['cta']);
    const visual = applyPostChange(SRC, 'visual', 'a baker pulling loaves from the oven');
    expect(postDiff(SRC, visual)).toEqual(['visual']);
  });

  it('"Also changed" flags an edit outside the chosen piece', () => {
    const hook = applyPostChange(SRC, 'hook', 'Guess what’s back?');
    const edited = { ...hook, caption: hook.caption.replace('local flour', 'organic flour'), hashtags: ['#sourdough'] };
    expect(alsoChanged('hook', postDiff(SRC, edited))).toEqual(['caption', 'hashtags']);
    // a whole-caption test may change hook, body and call to action
    expect(alsoChanged('caption', ['hook', 'body', 'cta'])).toEqual([]);
    const e = applyEmailChange({ subject: 'Hi', preview: 'p', body: 'First.\n\nSecond.' }, 'opening', 'New first.');
    expect(emailDiff({ subject: 'Hi', preview: 'p', body: 'First.\n\nSecond.' }, e)).toEqual(['opening']);
    expect(heroAlsoChanged('cta', heroDiff({ headline: 'H', subheadline: 'S', ctaLabel: 'Go' }, { headline: 'H2', subheadline: 'S', ctaLabel: 'Book' }))).toEqual(['headline']);
  });
});

describe('the AI answer is checked', () => {
  it('accepts the right number of different one-line versions', () => {
    const r = validatePieces({ variants: [{ label: 'Question', text: 'Guess what’s back?' }, { label: 'Number', text: '5 am. Fresh sourdough.' }] }, { change: 'hook', count: 2, original: 'Our sourdough is back.' });
    expect(r.problem).toBeUndefined();
    expect(r.variants.map((v) => v.label)).toEqual(['Question', 'Number']);
  });
  it('refuses malformed JSON, too few, same as the original, duplicates, and more than one line', () => {
    const o = { change: 'hook' as const, count: 2, original: 'Our sourdough is back.' };
    expect(validatePieces('not json', o).problem).toMatch(/shape/);
    expect(validatePieces({ variants: [{ text: 'A new hook' }] }, o).problem).toMatch(/1 of 2/);
    expect(validatePieces({ variants: [{ text: 'Our sourdough is back.' }, { text: 'x' }] }, o).problem).toMatch(/same as the original/);
    expect(validatePieces({ variants: [{ text: 'Same' }, { text: 'Same' }] }, o).problem).toMatch(/Two versions/);
    expect(validatePieces({ variants: [{ text: 'Line 1\nLine 2' }, { text: 'x' }] }, o).problem).toMatch(/more than one line/);
    expect(validatePieces({ variants: [{ text: '' }, { text: 'x' }] }, o).problem).toMatch(/empty/);
  });
  it('the built-in engine makes versions that pass the same check', () => {
    for (const change of ['hook', 'cta', 'caption', 'visual', 'subject', 'opening', 'headline'] as const) {
      const original = change === 'caption' ? SRC.caption : change === 'visual' ? SRC.visualPrompt : 'Our sourdough is back.';
      const pieces = localPieces(change, original, { count: 2, topic: 'Sourdough' });
      expect(pieces.length).toBeGreaterThanOrEqual(1);
      expect(validatePieces({ variants: pieces }, { change, count: pieces.length, original }).problem).toBeUndefined();
    }
  });
});

describe('cost, times and saving', () => {
  it('shows the cost first, and Visual on a video needs this week’s videos', () => {
    expect(costLine('post', 'hook', { count: 2 }).text).toMatch(/^About \d+ AI credits \(none on your own AI keys\)$/);
    // the exact count: one per new version
    expect(costLine('post', 'visual', { count: 2 }).text).toMatch(/^Makes 2 new images/);
    expect(costLine('post', 'visual', { count: 2, video: true, videosLeft: 3 }).text).toMatch(/^Uses 2 of this week’s videos \(3 left\)/);
    expect(costLine('post', 'visual', { count: 2, video: true, videosLeft: 1 })).toMatchObject({ disabled: true, text: 'Uses 2 of this week’s videos (1 left)' });
    expect(costLine('post', 'visual', { count: 1, video: true, videosLeft: 2 }).text).toMatch(/Uses 1 of this week’s videos \(2 left\)/);
    const out = costLine('post', 'visual', { count: 1, video: true, videosLeft: 0 });
    expect(out.disabled).toBe(true);
    expect(out.reason).toMatch(/used up/);
    expect(costLine('post', 'time', { count: 2 }).text).toMatch(/No AI/);
  });
  it('default planned times are a day apart at the same hour', () => {
    const t = defaultPlannedTimes('2026-12-01T15:00:00.000Z', 3, Date.parse('2026-11-07T00:00:00Z'));
    expect(t).toEqual(['2026-12-01T15:00:00.000Z', '2026-12-02T15:00:00.000Z', '2026-12-03T15:00:00.000Z']);
  });
  it('a version is an unposted copy with the test set', () => {
    const src = { id: 'post_a', projectId: 'p1', status: 'published', platform: 'instagram', postUrl: 'https://x', external: { via: 'api' }, publishedAt: 'x', ...SRC } as unknown as Post;
    const v = variantPost(src, { caption: 'New' }, { id: 'e1', key: 'b' });
    expect(v.id).not.toBe('post_a');
    expect(v).toMatchObject({ status: 'draft', caption: 'New', experiment: { id: 'e1', key: 'b' } });
    expect(v.external).toBeUndefined();
    expect(v.postUrl).toBeUndefined();
  });
});

describe('Post now order and gap', () => {
  const v = (key: 'a' | 'b' | 'c', o: Partial<ExperimentVariant> = {}): ExperimentVariant => ({ key, label: '', postId: `p_${key}`, jobId: null, plannedAt: null, shareMode: null, hasHtml: false, omnisendCampaignId: null, metrics: {}, metricsAt: null, metricsError: null, visitors: 0, views: 0, leads: 0, ...o });
  const e = (mode: Experiment['mode'], variants: ExperimentVariant[], state: Experiment['state'] = 'running') => ({ mode, state, variants });
  const now = Date.parse('2026-11-07T12:00:00Z');
  it('in key order, and 12 hours apart for different times', () => {
    expect(postNowGate(e('times', [v('a'), v('b')], 'draft'), 'a', () => null, now)).toEqual({ ok: true });
    expect(postNowGate(e('times', [v('a'), v('b')], 'draft'), 'b', () => null, now).reason).toBe('Post version A first.');
    const posted = e('times', [v('a', { jobId: 'j1' }), v('b')]);
    expect(postNowGate(posted, 'b', () => now - 3 * 3_600_000, now).reason).toBe('Wait 9 more hours: versions go out at least 12 hours apart.');
    expect(postNowGate(posted, 'b', () => now - 13 * 3_600_000, now)).toEqual({ ok: true });
    expect(postNowGate(posted, 'a', () => null, now).reason).toBe('Already posted.');
  });
  it('a version whose try failed isn’t out: it can be posted again, and the next one waits for it', () => {
    const failedA = e('times', [v('a', { jobId: 'j1' }), v('b')], 'draft');
    const failed = (id: string | null) => id === 'p_a';
    expect(postNowGate(failedA, 'a', () => now - 13 * 3_600_000, now, failed)).toEqual({ ok: true });
    expect(postNowGate(failedA, 'b', () => now - 13 * 3_600_000, now, failed).reason).toBe('Post version A first.');
  });
  it('Trial Reels may go back to back; an ended test posts nothing', () => {
    expect(postNowGate(e('trial_reels', [v('a', { jobId: 'j1' }), v('b')]), 'b', () => now, now)).toEqual({ ok: true });
    expect(postNowGate(e('times', [v('a'), v('b')], 'stopped'), 'a', () => null, now).reason).toBe('This test has ended.');
  });
});
