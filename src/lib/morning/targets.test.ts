// "Do it" for each kind: the plan kinds use Strategy's own targets, leads / analytics / strategy open their pages,
// a due post opens its editor (a missing one falls back to the calendar), the assistant only gets text in its box
// (nothing is sent), and an action done outside the app has no Do it.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/strategyActions', async (original) => ({ ...(await original<typeof import('@/lib/strategyActions')>()), runTarget: vi.fn(async () => {}) }));
vi.mock('@/ai/assistant/nav', async (original) => ({ ...(await original<typeof import('@/ai/assistant/nav')>()), openPage: vi.fn(async () => true) }));
vi.mock('@/lib/router', async (original) => ({ ...(await original<typeof import('@/lib/router')>()), navigate: vi.fn(async () => true) }));

const sa = await import('@/lib/strategyActions');
const nav = await import('@/ai/assistant/nav');
const router = await import('@/lib/router');
const { useStore } = await import('@/store/useStore');
const { useUI } = await import('@/store/ui');
const { useAssistant, chatOf } = await import('@/store/assistant');
const { newProject } = await import('@/store/defaults');
const { askHow, doIt } = await import('./targets');

const p = { ...newProject('business', 'existing'), id: 'p1' };
const post = { id: 'post_1', projectId: 'p1', status: 'scheduled', headline: 'Fresh bread' };

beforeEach(() => {
  vi.mocked(sa.runTarget).mockClear();
  vi.mocked(nav.openPage).mockClear();
  vi.mocked(router.navigate).mockClear();
  useStore.setState({ posts: [post as never] });
  useUI.setState({ postEditorId: null });
  useAssistant.setState({ open: false, draft: null });
});

describe('doIt', () => {
  it('a plan kind uses Strategy’s target and label: build_page opens the builder with the page type, write_post the composer with the topic', async () => {
    const b = doIt({ kind: 'build_page', title: 'Build your booking page', target: { pageType: 'booking' } }, p)!;
    expect(b.label).toBe('Build this page');
    await b.run();
    expect(sa.runTarget).toHaveBeenLastCalledWith({ kind: 'seo', pageType: 'booking' });
    const w = doIt({ kind: 'write_post', title: 'Share a behind-the-scenes post', target: { topic: 'Behind the scenes' } }, p)!;
    expect(w.label).toBe('Write this post');
    await w.run();
    expect(sa.runTarget).toHaveBeenLastCalledWith({ kind: 'composer', topic: 'Behind the scenes' });
    const b7 = doIt({ kind: 'batch_7', title: 'Plan a week of posts', target: {} }, p)!;
    await b7.run();
    expect(sa.runTarget).toHaveBeenLastCalledWith({ kind: 'page', route: 'marketing-social', tab: 'batch' });
  });
  it('leads, analytics and strategy open their pages', async () => {
    const l = doIt({ kind: 'leads', title: 'Reply to your 2 new leads', target: {} }, p)!;
    expect(l.label).toBe('Open your leads');
    await l.run();
    expect(nav.openPage).toHaveBeenLastCalledWith('marketing-email', 'leads');
    const a = doIt({ kind: 'analytics', title: 'Update your numbers', target: {} }, p)!;
    expect(a.label).toBe('Open Analytics');
    await a.run();
    expect(router.navigate).toHaveBeenLastCalledWith('analytics');
    const s = doIt({ kind: 'strategy', title: 'Plan your marketing strategy', target: {} }, p)!;
    expect(s.label).toBe('Open your plan');
    await s.run();
    expect(nav.openPage).toHaveBeenLastCalledWith('strategy', 'plan');
  });
  it('a due post opens its editor; a post that’s gone falls back to the calendar’s Planned tab', async () => {
    const o = doIt({ kind: 'calendar', title: 'Post today’s planned post', target: { postId: 'post_1' } }, p)!;
    expect(o.label).toBe('Open the post');
    await o.run();
    expect(useUI.getState().postEditorId).toBe('post_1');
    const gone = doIt({ kind: 'calendar', title: 'Post today’s planned post', target: { postId: 'post_x' } }, p)!;
    expect(gone.label).toBe('Open the calendar');
    await gone.run();
    expect(nav.openPage).toHaveBeenLastCalledWith('calendar', 'scheduled');
  });
  it('assistant puts the prompt in the chat’s box and sends nothing', async () => {
    const before = chatOf('p1').length;
    const a = doIt({ kind: 'assistant', title: 'Ask a happy customer for a referral', target: { prompt: 'Help me write a referral ask.' } }, p)!;
    expect(a.label).toBe('Ask the assistant');
    await a.run();
    expect(useAssistant.getState()).toMatchObject({ open: true, draft: 'Help me write a referral ask.' });
    expect(chatOf('p1').length).toBe(before);
    expect(doIt({ kind: 'assistant', title: 'Ask', target: {} }, p)).toBeNull();
  });
  it('offline has no Do it, only “Ask the assistant how”; an unknown kind has none', () => {
    expect(doIt({ kind: 'offline', title: 'Reply to comments for 15 minutes', target: {} }, p)).toBeNull();
    const h = askHow({ title: 'Reply to comments for 15 minutes' });
    expect(h.label).toBe('Ask the assistant how');
    void h.run();
    expect(useAssistant.getState().draft).toBe('Help me with today’s action: Reply to comments for 15 minutes');
    expect(doIt({ kind: 'launch_rocket' as never, title: 'Nope', target: {} }, p)).toBeNull();
  });
});
