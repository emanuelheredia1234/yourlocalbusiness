// "Post as" on a post (rendered once): only on Instagram videos, with the eligibility line for each state.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Post, TrialEligibility } from '@/lib/types';

const live = <S>(store: { getState: () => S }) => Object.assign(<T>(select: (s: S) => T = (s) => s as unknown as T) => select(store.getState()), store);
vi.mock('zustand', async (original) => {
  const real = await original<typeof import('zustand')>();
  const wrap = (store: ReturnType<typeof real.create>) => live(store as unknown as { getState: () => unknown });
  const create = ((init?: unknown) => (init === undefined ? (i: unknown) => wrap((real.create as unknown as (x: unknown) => never)(i)) : wrap((real.create as unknown as (x: unknown) => never)(init)))) as typeof real.create;
  return { ...real, create };
});
const { useAuth } = await import('@/lib/cloud/auth');
const { useExperimentsConfig } = await import('@/lib/experiments/config');
const { useExperiments } = await import('@/store/experiments');
const { TrialReelPicker } = await import('./TrialReelPicker');

const post = (o: Partial<Post> = {}) => ({ id: 'a', projectId: 'p1', platform: 'instagram', format: 'video', status: 'scheduled', media: { id: 'm', kind: 'video', mime: 'video/mp4' }, ...o }) as Post;
const words = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = (p: Post, el: TrialEligibility | null) => {
  useAuth.setState({ phase: 'ready' } as never);
  useExperimentsConfig.setState({ config: { enabled: true, reachable: true } });
  useExperiments.setState({ eligibility: el ? { p1: { value: el, at: Date.now(), loading: false } } : {} });
  return renderToStaticMarkup(createElement(TrialReelPicker, { post: p, onChange: () => {} }));
};

afterEach(() => vi.unstubAllGlobals());

describe('Trial Reel picker', () => {
  it('only on an Instagram video', () => {
    expect(render(post({ platform: 'facebook' }), { eligible: true })).toBe('');
    expect(render(post({ format: 'image', media: { id: 'm', kind: 'image', mime: 'image/png' } as Post['media'] }), { eligible: true })).toBe('');
    expect(words(render(post(), { eligible: true, followers: 2340 }))).toContain('Trial Reels: available (2,340 followers)');
  });
  it('too few followers disables the trial options; unknown explains; not connected says connect', () => {
    const few = render(post(), { eligible: false, reason: 'followers', followers: 640 });
    expect(words(few)).toContain('Trial Reels need 1,000+ followers (you have 640)');
    expect((few.match(/disabled=""/g) ?? []).length).toBe(2);
    expect(words(render(post(), { eligible: 'unknown', reason: 'unreadable' }))).toContain('We couldn’t check your followers.');
    expect(words(render(post(), { eligible: false, reason: 'not_connected' }))).toContain('Connect Instagram to post Trial Reels');
    expect(words(render(post(), { eligible: true }))).toContain('Trial Reels can’t have collaborators');
  });
  it('hidden in the claude.ai build', () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    expect(render(post(), { eligible: true })).toBe('');
  });
});
