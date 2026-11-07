// @vitest-environment happy-dom
// Removing a failed launch in the Campaigns tab: the Remove button (styled as destructive) asks first with words true
// for that launch, sends one DELETE, the row leaves the list, and the "Ad activity" list on the tab reads again and
// shows the removal without a remount. An already-removed launch says so plainly. Requests are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

const ui = vi.hoisted(() => ({ confirm: vi.fn(async (_o: unknown) => true) }));
vi.mock('@/components/ui/primitives', async (orig) => ({ ...(await orig<typeof import('@/components/ui/primitives')>()), confirmAction: ui.confirm }));
const toasts = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/store/ui', async (orig) => ({ ...(await orig<typeof import('@/store/ui')>()), toast: toasts.toast }));

import type { AdJob, AuditEntry, LaunchedCampaign } from '@/lib/ads/launchTypes';
const { useAdsLaunch } = await import('@/store/adsLaunch');
const { RemoveButton } = await import('./CampaignRow');
const { AuditLog } = await import('./AuditLog');
const { TooltipProvider } = await import('@/components/ui/shadcn/tooltip');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const job = (over: Partial<AdJob> = {}): AdJob => ({ id: 'j1', kind: 'launch', platform: 'meta', state: 'failed', code: 'PAYMENT_REQUIRED', message: 'Nothing was created and no money was spent.', requestedAt: '2026-11-06T10:00:00Z', ...over });
const failed = (over: Partial<LaunchedCampaign> = {}): LaunchedCampaign => ({
  id: 'c1',
  planId: 'ad1',
  projectId: 'proj1',
  platform: 'meta',
  name: 'Spring fixes',
  tag: 'YLB 0123456789ab',
  account: { name: 'Acme', idTail: '1234', currency: 'USD', timezone: 'America/Chicago' },
  state: 'failed',
  stateMessage: 'Not launched.',
  review: { status: null, reasons: [] },
  daily: 25,
  start: '2026-12-01',
  end: '2026-12-14',
  launchedAs: 'PAUSED',
  configuredStatus: null,
  canRemove: true,
  lastJob: job(),
  ...over,
});
const entry = (id: number, summary: string): AuditEntry => ({ id, at: '2026-11-07T10:00:00Z', campaignId: 'c1', actor: 'customer', action: id === 2 ? 'remove' : 'launch', summary, outcome: id === 2 ? 'done' : 'refused' });

let host: HTMLDivElement;
let root: Root;
let removed = false;
let deleteStatus = 200;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === 'DELETE') {
    removed = deleteStatus === 200;
    return deleteStatus === 200 ? Response.json({ removed: 'c1' }) : Response.json({ error: 'That campaign isn’t in your account.', code: 'NOT_FOUND' }, { status: 404 });
  }
  if (String(url).includes('/api/ads/audit')) return Response.json({ entries: removed ? [entry(2, 'Removed a failed launch (Spring fixes, Meta) from the list.'), entry(1, 'Launch refused')] : [entry(1, 'Launch refused')] });
  return new Response('{}', { status: 404 });
});
const removeButton = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Remove') as HTMLButtonElement | undefined;
const render = async (c: LaunchedCampaign) => {
  await act(async () => root.render(createElement(TooltipProvider, null, createElement('div', null, createElement(RemoveButton, { c }), createElement(AuditLog, { projectId: 'proj1' })))));
};

beforeEach(() => {
  removed = false;
  deleteStatus = 200;
  fetchMock.mockClear();
  ui.confirm.mockClear();
  toasts.toast.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  useAdsLaunch.setState({ campaigns: { proj1: [failed()] }, auditRev: {}, error: {} });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Remove on a failed launch', () => {
  it('is a destructive button; asks first; one DELETE; the row goes and the activity list shows the removal', async () => {
    await render(failed());
    expect(host.textContent).toContain('Launch refused');
    expect(host.textContent).not.toContain('Removed a failed launch');
    const b = removeButton()!;
    expect(b.className).toContain('btn-danger-ghost');
    await act(async () => b.click());
    expect(ui.confirm).toHaveBeenCalledTimes(1);
    expect(ui.confirm.mock.calls[0][0]).toMatchObject({ title: 'Remove this failed launch?', body: 'Nothing was created at Meta, so nothing changes there.', confirmLabel: 'Remove', danger: true });
    expect(fetchMock.mock.calls.filter(([, i]) => i?.method === 'DELETE')).toHaveLength(1);
    expect(useAdsLaunch.getState().campaigns.proj1).toEqual([]);
    // the tab's activity list read again by itself (no remount), and the list's error stays clear
    expect(host.textContent).toContain('Removed a failed launch (Spring fixes, Meta) from the list.');
    expect(useAdsLaunch.getState().error.proj1).toBeFalsy();
    expect(toasts.toast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', title: 'Removed the failed launch' }));
  });

  it('a “no” sends nothing and keeps the row', async () => {
    ui.confirm.mockResolvedValueOnce(false);
    await render(failed());
    await act(async () => removeButton()!.click());
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(false);
    expect(useAdsLaunch.getState().campaigns.proj1).toHaveLength(1);
  });

  it('a launch Zernio made then deleted says so, not “nothing was created”', async () => {
    ui.confirm.mockResolvedValueOnce(false);
    await render(failed({ removeKind: 'deleted' }));
    await act(async () => removeButton()!.click());
    expect(ui.confirm.mock.calls[0][0]).toMatchObject({ body: 'What it made at Meta was deleted again, so nothing changes there.' });
  });

  it('already removed in another tab: the row goes with a plain “already removed”, not an error', async () => {
    deleteStatus = 404;
    await render(failed());
    await act(async () => removeButton()!.click());
    expect(useAdsLaunch.getState().campaigns.proj1).toEqual([]);
    expect(toasts.toast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'info', title: 'Already removed' }));
    expect(toasts.toast).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });
});
