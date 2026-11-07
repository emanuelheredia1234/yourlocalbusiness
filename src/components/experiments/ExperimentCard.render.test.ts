// The experiment card (rendered once, as on the server): Post now in order and after the 12-hour gap with the reason
// when it can't go yet, the verdict copy, unknown numbers as "—", and Use the winner / Pick one anyway.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Experiment, ExperimentVariant, Post } from '@/lib/types';

const live = <S>(store: { getState: () => S }) => Object.assign(<T>(select: (s: S) => T = (s) => s as unknown as T) => select(store.getState()), store);
vi.mock('@/store/useStore', async (original) => {
  const real = await original<typeof import('@/store/useStore')>();
  return { ...real, useStore: live(real.useStore) };
});
const { useStore } = await import('@/store/useStore');
const { defaultSettings } = await import('@/store/defaults');
const { ExperimentCard, postStateLabel } = await import('./ExperimentCard');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const post = (id: string, o: Partial<Post> = {}): Post => ({ id, projectId: 'p1', status: 'scheduled', platform: 'instagram', format: 'image', style: 'minimal', postType: 'sales', headline: 'H', visualPrompt: '', caption: `Caption ${id}`, hashtags: [], scheduledAt: '2026-11-08T10:00:00Z', watermark: false, source: 'composer', createdAt: 1, updatedAt: 1, seed: 1, ...o }) as Post;
const v = (key: 'a' | 'b', o: Partial<ExperimentVariant> = {}): ExperimentVariant => ({ key, label: key === 'a' ? 'Original' : 'Question', postId: `p_${key}`, jobId: null, plannedAt: '2026-11-08T10:00:00Z', shareMode: null, hasHtml: false, omnisendCampaignId: null, metrics: {}, metricsAt: null, metricsError: null, visitors: 0, views: 0, leads: 0, ...o });
const exp = (o: Partial<Experiment> = {}): Experiment => ({ id: 'e1', projectId: 'p1', kind: 'post', mode: 'times', changed: 'hook', network: 'instagram', metric: 'engagement_rate', subjectRef: 'p_a', name: 'Fresh bread', state: 'running', startedAt: null, endsAt: '2026-11-20T00:00:00Z', result: {}, delayed: false, winner: null, winnerUsedAt: null, counted: true, lastReadAt: null, refreshAt: null, createdAt: null, variants: [v('a'), v('b')], ...o });
const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = (e: Experiment, posts: Post[]) => {
  useStore.setState({ posts, projects: [], settings: defaultSettings() });
  return renderToStaticMarkup(createElement(ExperimentCard, { experiment: e, now: NOW }));
};

describe('the experiment card', () => {
  it('version B waits for A, then for the 12-hour gap', () => {
    const draft = words(render(exp({ state: 'draft' }), [post('p_a'), post('p_b')]));
    expect(draft).toContain('Post version A first.');
    expect(draft).toContain('Post version A to start the test.');
    const after = words(render(exp({ variants: [v('a', { jobId: 'j1' }), v('b')] }), [post('p_a', { status: 'published', publishedAt: new Date(NOW - 2 * 3_600_000).toISOString() }), post('p_b')]));
    expect(after).toContain('Wait 10 more hours: versions go out at least 12 hours apart.');
    expect(after).toContain('Posted');
  });

  it('the verdict in plain words, unknown numbers as —, and Use the winner', () => {
    const e = exp({ result: { verdict: 'winner', winner: 'b', lift: 18, note: 'time_differs', measure: 'reach', perVariant: { a: { successes: 20, trials: 1000, rate: 0.02 }, b: { successes: 41, trials: 1210, rate: 0.034 } } }, variants: [v('a', { jobId: 'j1', metrics: { views: 1500, likes: 20 } }), v('b', { jobId: 'j2', metrics: { views: 1800, likes: 41 } })] });
    const t = words(render(e, [post('p_a', { status: 'published' }), post('p_b', { status: 'published' })]));
    expect(t).toContain('Clear winner: Version B +18%');
    expect(t).toContain('3.4% · 41 of 1,210 reached');
    expect(t).toMatch(/Saves —/);
    expect(t).toContain('Use the winner');
    expect(t).not.toMatch(/significan/i);
    expect(t).toContain('These went out at different times');
  });

  it('too close to call: Pick one anyway', () => {
    const t = words(render(exp({ state: 'finished', result: { verdict: 'too_close', perVariant: { a: { rate: 0.031 }, b: { rate: 0.034 } } } }), [post('p_a'), post('p_b')]));
    expect(t).toContain('Too close to call');
    expect(t).toContain('Pick A anyway');
    expect(t).toContain('Pick B anyway');
    expect(t).not.toContain('Use the winner');
  });

  it('post states', () => {
    expect(postStateLabel(undefined, null)).toBe('Removed');
    expect(postStateLabel(post('x', { external: { via: 'api', state: 'unknown' } as Post['external'] }), 'j')).toBe('Check again');
    expect(postStateLabel(post('x', { external: { via: 'api', state: 'failed' } as Post['external'] }), 'j')).toBe('Failed');
    expect(postStateLabel(post('x'), null)).toBe('Planned');
  });
});
