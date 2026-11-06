// @vitest-environment happy-dom
// Settings › Plan dialogs in a real DOM: Remove one at renewal keeps its request id after an unclear answer (a dropped
// connection, "being confirmed") and makes a new one only after a definite refusal; a background refresh (a new
// slots array) never changes the business picked or the id. Choose which stay active keeps the user's choice across
// refreshes. Every request is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

vi.mock('@/components/ui/primitives', async (orig) => ({
  ...(await orig<typeof import('@/components/ui/primitives')>()),
  Modal: ({ title, children, footer }: { title?: ReactNode; children: ReactNode; footer?: ReactNode }) => createElement('section', null, createElement('h2', null, title), children, createElement('footer', null, footer)),
}));
const api = vi.hoisted(() => ({ changeBusinesses: vi.fn(), setActiveBusinesses: vi.fn(), getBusinesses: vi.fn(), getPlan: vi.fn() }));
vi.mock('@/lib/integrations/api', async (orig) => ({ ...(await orig<typeof import('@/lib/integrations/api')>()), ...api }));

const { IntegrationApiError } = await import('@/lib/integrations/api');
const { useBillingConfig } = await import('@/lib/billing/config');
const { useAuth } = await import('@/lib/cloud/auth');
const { RemoveDialog, ChooseDialog } = await import('./PlanSection');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Slot = { projectId: string; state: 'active' | 'locked'; lockAt?: string };
const SLOTS = (): Slot[] => [
  { projectId: 'a', state: 'active' },
  { projectId: 'b', state: 'active' },
  { projectId: 'c', state: 'active' },
];
const name = (id: string) => `Biz ${id.toUpperCase()}`;

let host: HTMLDivElement;
let root: Root;
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().endsWith(label)) as HTMLButtonElement;
const radio = (id: string) => host.querySelector(`input[type=radio][value="${id}"]`) as HTMLInputElement;
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
  });
};
const renderRemove = (slots: Slot[], open = true) => act(() => root.render(createElement(RemoveDialog, { open, onClose: () => undefined, slots: slots as never, name, at: '2026-12-01T00:00:00Z' })));
const ids = () => api.changeBusinesses.mock.calls.map((c) => c[0].clientRequestId);

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.getPlan.mockResolvedValue(null);
  api.getBusinesses.mockResolvedValue(null);
  useAuth.setState({ phase: 'ready' });
  useBillingConfig.setState({ enabled: true, enforce: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Remove one at renewal', () => {
  it('a dropped connection or "being confirmed": pressing again sends the same request id', async () => {
    renderRemove(SLOTS());
    api.changeBusinesses.mockRejectedValueOnce(new IntegrationApiError(0, null, 'Couldn’t reach the app’s server.'));
    await click(button('Remove at renewal'));
    api.changeBusinesses.mockRejectedValueOnce(new IntegrationApiError(409, { error: 'We’re confirming your last change.', code: 'BILLING_PENDING' }));
    await click(button('Remove at renewal'));
    api.changeBusinesses.mockResolvedValueOnce({ ok: true, op: { id: 'o1', kind: 'remove_business', state: 'done' } });
    await click(button('Remove at renewal'));
    const [a, b, c] = ids();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('a definite refusal: the next press is a new request', async () => {
    renderRemove(SLOTS());
    api.changeBusinesses.mockRejectedValueOnce(new IntegrationApiError(409, { error: 'Your plan has no extra business to remove.', code: 'BAD_REQUEST' }));
    await click(button('Remove at renewal'));
    api.changeBusinesses.mockResolvedValueOnce({ ok: true, op: { id: 'o1', kind: 'remove_business', state: 'done' } });
    await click(button('Remove at renewal'));
    const [a, b] = ids();
    expect(b).not.toBe(a);
  });

  it('a background refresh (a new slots array) keeps the business picked and the id', async () => {
    renderRemove(SLOTS());
    expect(radio('c').checked).toBe(true);
    await click(radio('a'));
    expect(radio('a').checked).toBe(true);
    api.changeBusinesses.mockRejectedValueOnce(new IntegrationApiError(0, null, 'offline'));
    await click(button('Remove at renewal'));
    // the plan is read again while the dialog is open: a fresh array with the same businesses
    renderRemove(SLOTS());
    renderRemove(SLOTS());
    expect(radio('a').checked).toBe(true);
    api.changeBusinesses.mockResolvedValueOnce({ ok: true, op: { id: 'o1', kind: 'remove_business', state: 'done' } });
    await click(button('Remove at renewal'));
    expect(api.changeBusinesses.mock.calls.map((c) => c[0].projectId)).toEqual(['a', 'a']);
    expect(new Set(ids()).size).toBe(1);
  });

  it('opening again starts afresh (a new id, the default pick)', async () => {
    renderRemove(SLOTS());
    await click(radio('a'));
    api.changeBusinesses.mockResolvedValue({ ok: true, op: { id: 'o1', kind: 'remove_business', state: 'done' } });
    await click(button('Remove at renewal'));
    renderRemove(SLOTS(), false);
    renderRemove(SLOTS());
    expect(radio('c').checked).toBe(true);
    await click(button('Remove at renewal'));
    const [a, b] = ids();
    expect(b).not.toBe(a);
  });
});

describe('Choose which businesses stay active', () => {
  it('keeps the user’s choice when the plan is read again while it’s open', async () => {
    const slots: Slot[] = [
      { projectId: 'a', state: 'active' },
      { projectId: 'b', state: 'locked' },
    ];
    const render = () => act(() => root.render(createElement(ChooseDialog, { open: true, onClose: () => undefined, slots: [...slots] as never, limit: 1, name })));
    render();
    // the checkbox is a button (role checkbox) named by its label
    const box = (label: string) => document.getElementById([...host.querySelectorAll('label')].find((l) => l.textContent?.includes(label))?.htmlFor ?? '') as HTMLElement;
    const on = (label: string) => box(label).getAttribute('aria-checked') === 'true';
    expect(on('Biz A')).toBe(true);
    await click(box('Biz A'));
    await click(box('Biz B'));
    expect(on('Biz B')).toBe(true);
    render();
    render();
    expect(on('Biz B')).toBe(true);
    expect(on('Biz A')).toBe(false);
    api.setActiveBusinesses.mockResolvedValue({});
    await click(button('Save'));
    expect(api.setActiveBusinesses).toHaveBeenCalledWith(['b']);
  });
});
