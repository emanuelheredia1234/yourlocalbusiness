// "Make variations" as it first shows (rendered once, as on the server): the cost of each choice first, Visual
// disabled on a video post when this week's videos are used up, the Trial Reels mode only for an Instagram video,
// the explainer and the limits copy. Hidden in the claude.ai build.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Post } from '@/lib/types';

const live = <S>(store: { getState: () => S }) => Object.assign(<T>(select: (s: S) => T = (s) => s as unknown as T) => select(store.getState()), store);
vi.mock('zustand', async (original) => {
  const real = await original<typeof import('zustand')>();
  const wrap = (store: ReturnType<typeof real.create>) => live(store as unknown as { getState: () => unknown });
  const create = ((init?: unknown) => (init === undefined ? (i: unknown) => wrap((real.create as unknown as (x: unknown) => never)(i)) : wrap((real.create as unknown as (x: unknown) => never)(init)))) as typeof real.create;
  return { ...real, create };
});
vi.mock('@/components/ui/primitives', async (orig) => ({
  ...(await orig<typeof import('@/components/ui/primitives')>()),
  Modal: ({ title, subtitle, children, footer }: { title?: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) => createElement('section', null, createElement('h2', null, title), createElement('p', null, subtitle), children, createElement('footer', null, footer)),
}));
vi.mock('@/store/useStore', async (original) => {
  const real = await original<typeof import('@/store/useStore')>();
  return { ...real, useStore: live(real.useStore) };
});

const { useStore } = await import('@/store/useStore');
const { useVideoWeek } = await import('@/store/videoWeek');
const { newProject, defaultSettings } = await import('@/store/defaults');
const { useAuth } = await import('@/lib/cloud/auth');
const { useExperimentsConfig } = await import('@/lib/experiments/config');
const { MakeVariations, MakeVariationsHost, useMakeVariations, LIMITS_COPY } = await import('./MakeVariations');

const post = (o: Partial<Post> = {}): Post =>
  ({ id: 'post_1', projectId: 'p1', status: 'scheduled', platform: 'instagram', format: 'image', style: 'minimal', postType: 'sales', headline: 'Fresh bread', visualPrompt: 'a loaf', caption: 'Fresh bread daily.\nOrder now.', hashtags: [], scheduledAt: '2099-11-10T10:00:00.000Z', watermark: false, source: 'composer', createdAt: 1, updatedAt: 1, seed: 1, ...o }) as Post;
function use(p: Post) {
  const project = { ...newProject('business', 'existing'), id: 'p1', onboarded: true };
  useStore.setState({ projects: [project], activeProjectId: 'p1', posts: [p], settings: defaultSettings() });
}
const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = (p: Post) => {
  use(p);
  return renderToStaticMarkup(createElement(MakeVariations, { target: { kind: 'post', postId: p.id } }));
};

afterEach(() => {
  vi.unstubAllGlobals();
  useVideoWeek.setState({ byProject: {} });
});

describe('Make variations', () => {
  it('shows each choice with its cost first, the explainer and the limits', () => {
    const t = words(render(post()));
    expect(t).toContain('A/B testing: change one thing, see which does better.');
    for (const label of ['Hook', 'Caption', 'Visual', 'Call to action', 'Posting time']) expect(t).toContain(label);
    expect(t).toMatch(/About \d+ AI credits/);
    expect(t).toMatch(/Makes 1 new image \(image credits\)/);
    expect(t).toContain('No AI: the same post goes out at different times.');
    expect(t).toContain(LIMITS_COPY);
    // a photo post: no Trial Reels
    expect(t).not.toContain('Instagram Trial Reels');
  });

  it('Visual on a video uses this week’s videos, and is disabled when they’re used up', () => {
    useVideoWeek.setState({ byProject: { p1: { used: 3, limit: 3, resetsAt: '2026-11-09T00:00:00Z', enforced: true, known: true, at: Date.now() } } });
    const html = render(post({ format: 'video', media: { id: 'm1', kind: 'video', mime: 'video/mp4' } as Post['media'] }));
    expect(words(html)).toContain('This week’s videos are used up.');
    expect(html).toMatch(/<input type="radio" name="variation-change" class="mt-1" disabled=""/);
    // an Instagram video may run as Trial Reels
    expect(words(html)).toContain('Instagram Trial Reels');
  });

  it('with videos left, Visual says how many', () => {
    useVideoWeek.setState({ byProject: { p1: { used: 1, limit: 3, resetsAt: '2026-11-09T00:00:00Z', enforced: true, known: true, at: Date.now() } } });
    expect(words(render(post({ format: 'video', media: { id: 'm1', kind: 'video', mime: 'video/mp4' } as Post['media'] })))).toMatch(/Uses 1 of this week’s videos \(2 left\)/);
  });

  it('the host shows nothing in the claude.ai build, or when the server has no A/B tests', () => {
    use(post());
    useMakeVariations.getState().open({ kind: 'post', postId: 'post_1' });
    useAuth.setState({ phase: 'ready' } as never);
    useExperimentsConfig.setState({ config: { enabled: false, reachable: true } });
    expect(renderToStaticMarkup(createElement(MakeVariationsHost))).toBe('');
    useExperimentsConfig.setState({ config: { enabled: true, reachable: true } });
    expect(renderToStaticMarkup(createElement(MakeVariationsHost))).toContain('Make variations');
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    expect(renderToStaticMarkup(createElement(MakeVariationsHost))).toBe('');
  });
});
