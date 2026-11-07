// @vitest-environment happy-dom
// Today's action card, live: switching business never carries the Not useful panel, a picked reason or an answer
// still on its way over to the next business; the last Not useful says no other idea comes today; and in the
// built-in version a Done said to the assistant shows on the open card at once. Requests are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

vi.mock('@/lib/integrations/api', async (orig) => ({ ...(await orig<typeof import('@/lib/integrations/api')>()), getMorningToday: vi.fn(), startMorning: vi.fn(), sendMorningFeedback: vi.fn() }));

const { TooltipProvider } = await import('@/components/ui/shadcn/tooltip');
const { newProject } = await import('@/store/defaults');
const { useAuth } = await import('@/lib/cloud/auth');
const { useMorningConfig } = await import('@/lib/morning/config');
const { localKey } = await import('@/lib/morning/local');
const { safeStorage } = await import('@/lib/storage');
const { useStore } = await import('@/store/useStore');
const { fakeHost, runTool, seedWorkspace, TEST_PROJECT } = await import('@/ai/assistant/testing');
const { MorningCard, MorningCardView } = await import('./MorningCard');
import type { MorningAction, MorningToday } from '@/lib/integrations/types';
import type { MorningViewProps } from './MorningCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cands = [
  { key: 'leads:x', kind: 'leads' as const, title: 'Reply to your 2 new leads', why: '2 people got in touch recently. Reply today.', target: {}, from: 'rule' as const },
  { key: 'strategy', kind: 'strategy' as const, title: 'Plan your marketing strategy', why: 'A short plan tells you what to post.', target: {}, from: 'rule' as const },
];
const action = (projectId: string, o: Partial<MorningAction> = {}): MorningAction => ({ id: `${projectId}-1111-4111-8111-111111111111`, projectId, localDate: '2026-11-07', timeZone: 'UTC', state: 'ready', source: 'cron', engine: 'ai', chosen: 0, candidates: cands, feedback: [], fallback: null, credits: 1, ownKey: false, generatedAt: null, doneAt: null, ...o });
const today = (projectId: string, o: Partial<MorningAction> = {}): MorningToday => ({ actionDay: '2026-11-07', timeZone: 'UTC', action: action(projectId, o), dueNow: false, late: false, nextAt: '2026-11-08T05:00:00.000Z', attemptsLeft: 3, plan: 'active' });
const biz = (id: string) => ({ ...newProject('business', 'existing'), id, timeZone: 'UTC' });
const AT = '2026-11-07T12:00:00.000Z';
const A = biz('pA');
const B = biz('pB');

let host: HTMLDivElement;
let root: Root;
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().includes(label)) as HTMLButtonElement | undefined;
const live = () => host.querySelector('[aria-live="polite"]')?.textContent ?? '';
const click = async (el: HTMLElement | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => {
    el!.click();
  });
};
const view = (project: typeof A, onFeedback: MorningViewProps['onFeedback'], asking = false) =>
  act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(MorningCardView, { project, local: false, entry: { today: today(project.id), loading: false, starting: false, error: '', notice: '', locked: null, stalled: false }, browserZone: 'UTC', onStart: () => {}, onRefresh: () => {}, onFeedback, onUpgrade: () => {}, asking }),
      ),
    ),
  );

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('switching business', () => {
  it('closes the Not useful panel and drops the picked reason', async () => {
    const onFeedback = vi.fn(() => true);
    await view(A, onFeedback, true);
    expect(host.textContent).toContain('What didn’t work about this one?');
    await click(button('No time today'));
    expect(host.querySelector('[aria-pressed="true"]')).toBeTruthy();
    await view(B, onFeedback);
    expect(host.textContent).not.toContain('What didn’t work about this one?');
    expect(host.querySelector('[aria-pressed="true"]')).toBeNull();
    // and B's own panel opens empty
    await click(button('Not useful'));
    expect(host.querySelector('[aria-pressed="true"]')).toBeNull();
    expect((host.querySelector('input') as HTMLInputElement).value).toBe('');
    expect(onFeedback).not.toHaveBeenCalled();
  });

  it('an answer for A that lands after the switch isn’t announced on B', async () => {
    let finish: (v: boolean) => void = () => {};
    const onFeedback = vi.fn(() => new Promise<boolean>((r) => (finish = r)));
    await view(A, onFeedback);
    await click(button('Done'));
    await view(B, onFeedback);
    await act(async () => finish(true));
    expect(live()).toBe('');
    expect(button('Done')?.disabled).toBe(false);
  });
});

describe('what the screen reader hears', () => {
  it('another idea while one is left; no other idea after the last one', async () => {
    await view(A, () => action('pA', { chosen: 1, feedback: [{ i: 0, at: AT }] }), true);
    await click(button('Skip'));
    expect(live()).toBe('Thanks. Here’s another idea.');
    await view(A, () => action('pA', { state: 'dismissed', feedback: [{ i: 0, at: AT }, { i: 1, at: AT }] }));
    await click(button('Not useful'));
    await click(button('Skip'));
    expect(live()).toBe('Thanks. We’ll pick differently tomorrow.');
  });
});

describe('the built-in version', () => {
  let tools: ReturnType<typeof fakeHost>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
    seedWorkspace({ project: { timeZone: 'UTC' } });
    safeStorage.removeItem(localKey(TEST_PROJECT));
    useAuth.setState({ phase: 'off' });
    tools = fakeHost();
  });
  afterEach(() => {
    tools.restore();
    vi.useRealTimers();
    useAuth.setState({ phase: 'loading' });
    useMorningConfig.setState({ config: null });
  });

  it('a Done said to the assistant shows on the open card at once', async () => {
    const project = useStore.getState().projects[0];
    const ctx = { posts: [], ads: [], myListings: [], now: Date.now() };
    await act(async () => root.render(createElement(TooltipProvider, null, createElement(MorningCard, { project, ctx }))));
    expect(button('Done')).toBeTruthy();
    expect(host.textContent).not.toContain('Done. Nice work.');
    let r: Awaited<ReturnType<typeof runTool>> | undefined;
    await act(async () => {
      r = await runTool('mark_todays_action_done');
    });
    expect(r?.ok).toBe(true);
    expect(host.textContent).toContain('Done. Nice work.');
    expect(button('Not useful')).toBeUndefined();
  });
});
