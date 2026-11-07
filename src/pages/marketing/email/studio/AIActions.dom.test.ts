// @vitest-environment happy-dom
// The studio's AI actions (P5 §A5): the result bar is the action that ran last, not whichever has a result.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

const fake = vi.hoisted(() => ({ hooks: {} as Record<string, unknown> }));
vi.mock('@/ai/useAI', () => ({
  useAI: (task: { id: string }) => {
    const id = task.id === 'emailBolder' ? 'bolder' : 'design';
    return (fake.hooks[id] ??= { running: false, stage: '', chars: 0, result: { provider: 'local', skills: [], ms: 1, note: id }, logId: `log-${id}`, provider: 'local', run: vi.fn(async () => null), stop: vi.fn() });
  },
}));
vi.mock('@/components/ai/AI', async (orig) => ({
  ...(await orig<typeof import('@/components/ai/AI')>()),
  AIResultBar: ({ logId, note }: { logId: string | null; note?: string }) => createElement('output', { 'data-log': logId ?? '' }, note),
}));

const { newProject } = await import('@/store/defaults');
const { useStore } = await import('@/store/useStore');
const { generateEmailSequence } = await import('@/ai/local/email');
const { EmailAIActions } = await import('./AIActions');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  fake.hooks = {};
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('EmailAIActions', () => {
  it('shows the result of the action that ran last', async () => {
    const p = newProject('business');
    p.marketing.emails = generateEmailSequence(p, null);
    useStore.setState({ projects: [p], activeProjectId: p.id });
    const step = p.marketing.emails[0];
    await act(async () => root.render(createElement(EmailAIActions, { project: p, step, index: 0 })));
    // nothing ran here yet: no result bar
    expect(host.querySelector('output')).toBeNull();
    const click = (label: string) => act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label))!.click());
    await click('Make it bolder');
    expect(host.querySelector('output')?.getAttribute('data-log')).toBe('log-bolder');
    await click('Design this email');
    expect(host.querySelector('output')?.getAttribute('data-log')).toBe('log-design');
  });
});
