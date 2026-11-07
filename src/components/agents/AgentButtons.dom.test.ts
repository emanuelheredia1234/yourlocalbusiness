// @vitest-environment happy-dom
// The per-email agent buttons (P5): pressing one opens the build window for that email (its stepId goes along).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

const open = vi.hoisted(() => ({ openAgentBuild: vi.fn(async () => true) }));
vi.mock('./buildWindow', async (orig) => ({ ...(await orig<typeof import('./buildWindow')>()), openAgentBuild: open.openAgentBuild }));
vi.mock('@/ai/agents/who', async (orig) => ({ ...(await orig<typeof import('@/ai/agents/who')>()), useAgentReady: () => ({ show: true, ready: true, reason: 'ok', text: '', settings: false }) }));

const { AgentButtons } = await import('./AgentButtons');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  open.openAgentBuild.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('AgentButtons for one email', () => {
  it('the buttons open the window for that email (stepId)', async () => {
    await act(async () => root.render(createElement(AgentButtons, { target: 'email', stepId: 'em_1', kind: 'welcome', lead: 'or design it with' })));
    const manus = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Manus')) as HTMLButtonElement;
    await act(async () => manus.click());
    expect(open.openAgentBuild).toHaveBeenCalledTimes(1);
    expect(open.openAgentBuild).toHaveBeenCalledWith({ target: 'email', via: 'manus', kind: 'welcome', stepId: 'em_1' });
    const viktor = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Viktor')) as HTMLButtonElement;
    await act(async () => viktor.click());
    expect(open.openAgentBuild).toHaveBeenLastCalledWith({ target: 'email', via: 'viktor', kind: 'welcome', stepId: 'em_1' });
  });
});
