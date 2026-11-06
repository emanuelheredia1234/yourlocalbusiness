// @vitest-environment happy-dom
// Add a business in a real DOM (spec §B5): the request id is made when the dialog opens and reused when the same
// dialog submits again; a 202 "being confirmed" is read back every 10 s (getBusinesses) and never re-sent; a
// declined card offers Update card; after 2 minutes it hands over to Settings › Plan. Every request is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

vi.mock('@/components/ui/primitives', async (orig) => ({
  ...(await orig<typeof import('@/components/ui/primitives')>()),
  Modal: ({ title, children, footer }: { title?: ReactNode; children: ReactNode; footer?: ReactNode }) => createElement('section', null, createElement('h2', null, title), children, createElement('footer', null, footer)),
}));
const api = vi.hoisted(() => ({ changeBusinesses: vi.fn(), getBusinesses: vi.fn(), getPlan: vi.fn(), openPortal: vi.fn() }));
vi.mock('@/lib/integrations/api', async (orig) => ({ ...(await orig<typeof import('@/lib/integrations/api')>()), ...api }));

const { IntegrationApiError } = await import('@/lib/integrations/api');
const { useAuth } = await import('@/lib/cloud/auth');
const { useBillingConfig } = await import('@/lib/billing/config');
const { useBilling } = await import('@/store/billing');
const { AddBusinessDialog, POLL_FOR_MS, POLL_MS } = await import('./AddBusinessDialog');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BIZ = (extra: number, op: unknown = null) => ({ limit: 1 + extra, used: 1, extraBusinesses: extra, pricePerBusiness: { month: 9700, year: 97000 }, interval: 'month', slots: [], pendingRemove: null, op });
const PLAN = { billing: { enabled: true, enforce: true }, plan: { plan: 'launch', active: true, features: {} }, account: { tier: 'launch', interval: 'month', status: 'active', source: 'stripe', extraBusinesses: 0, pendingRemove: null, hasCustomer: true }, businesses: { limit: 1, used: 1, slots: [] }, credits: { monthly: 1500, usedCredits: 0, resetsAt: null } };

let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent ?? '';
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().endsWith(label)) as HTMLButtonElement;
const click = async (label: string) => {
  await act(async () => {
    button(label).click();
  });
};

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.getPlan.mockResolvedValue(PLAN);
  api.getBusinesses.mockResolvedValue(BIZ(0));
  useAuth.setState({ phase: 'ready' });
  useBillingConfig.setState({ enabled: true, enforce: true });
  useBilling.getState().reset();
  useBilling.setState({ plan: PLAN.plan as never, account: PLAN.account as never, businesses: BIZ(0) as never });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(AddBusinessDialog)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const open = (after?: () => void) => act(() => useBilling.getState().openAddBusiness(after));

describe('Add a business', () => {
  it('says the price and the charge today; done → the plan is read again, the dialog closes and what it was opened for runs', async () => {
    const after = vi.fn();
    open(after);
    expect(text()).toContain('Add a business for $97/month (or $970/year on yearly plans). You’ll be charged today for the rest of this billing period.');
    api.changeBusinesses.mockResolvedValue({ ok: true, op: { id: 'o1', kind: 'add_business', state: 'done' } });
    await click('Add a business');
    expect(api.changeBusinesses).toHaveBeenCalledTimes(1);
    expect(api.changeBusinesses.mock.calls[0][0]).toMatchObject({ action: 'add', confirm: true, clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(after).toHaveBeenCalledTimes(1);
    expect(useBilling.getState().addOpen).toBe(false);
    expect(api.getPlan).toHaveBeenCalled();
  });

  it('a dropped connection: submitting the same dialog again sends the same request id', async () => {
    open();
    api.changeBusinesses.mockRejectedValueOnce(new IntegrationApiError(0, null, 'Couldn’t reach the app’s server.'));
    await click('Add a business');
    expect(text()).toContain('Couldn’t reach the app’s server.');
    api.changeBusinesses.mockResolvedValueOnce({ ok: true, op: { id: 'o1', kind: 'add_business', state: 'done' } });
    await click('Add a business');
    const [a, b] = api.changeBusinesses.mock.calls.map((c) => c[0].clientRequestId);
    expect(a).toBe(b);
  });

  it('being confirmed (202): reads back every 10 s and never re-sends; the quantity going up finishes it', async () => {
    vi.useFakeTimers();
    const after = vi.fn();
    open(after);
    api.changeBusinesses.mockResolvedValue({ op: { id: 'o1', kind: 'add_business', state: 'unknown' } });
    api.getBusinesses.mockResolvedValue(BIZ(0, { id: 'o1', kind: 'add_business', state: 'unknown' }));
    await click('Add a business');
    expect(text()).toContain('Confirming your payment…');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(api.getBusinesses.mock.calls.length).toBeGreaterThanOrEqual(3);
    // the buttons are off while it's confirmed: nothing can send it again
    expect(button('Add a business').disabled).toBe(true);
    api.getBusinesses.mockResolvedValue(BIZ(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(api.changeBusinesses).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(useBilling.getState().addOpen).toBe(false);
  });

  it('still unconfirmed after 2 minutes: hands over to Settings › Plan, still one request', async () => {
    vi.useFakeTimers();
    open();
    api.changeBusinesses.mockResolvedValue({ op: { id: 'o1', kind: 'add_business', state: 'unknown' } });
    api.getBusinesses.mockResolvedValue(BIZ(0, { id: 'o1', kind: 'add_business', state: 'unknown' }));
    await click('Add a business');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_FOR_MS + POLL_MS);
    });
    expect(text()).toContain('We’ll finish this shortly; check Settings › Plan.');
    expect(api.changeBusinesses).toHaveBeenCalledTimes(1);
  });

  it('the op ended without the change: says so, and the next try is a new request', async () => {
    vi.useFakeTimers();
    open();
    api.changeBusinesses.mockResolvedValueOnce({ op: { id: 'o1', kind: 'add_business', state: 'unknown' } });
    api.getBusinesses.mockResolvedValue(BIZ(0));
    await click('Add a business');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(text()).toContain('That change didn’t go through. Try again.');
    api.changeBusinesses.mockResolvedValueOnce({ ok: true, op: { id: 'o2', kind: 'add_business', state: 'done' } });
    await click('Add a business');
    const [a, b] = api.changeBusinesses.mock.calls.map((c) => c[0].clientRequestId);
    expect(a).not.toBe(b);
  });

  it('a declined card: our words and Update card; nothing else is sent', async () => {
    open();
    api.changeBusinesses.mockRejectedValue(new IntegrationApiError(402, { error: 'Your card was declined. Update it in Billing, then try again.', code: 'CARD_DECLINED' }));
    await click('Add a business');
    expect(text()).toContain('Your card was declined. Update it in Billing, then try again.');
    expect(button('Update card')).toBeTruthy();
    expect(api.changeBusinesses).toHaveBeenCalledTimes(1);
  });

  it('a pending removal: keep it instead, at no charge (undo)', async () => {
    useBilling.setState({ businesses: { ...BIZ(1), pendingRemove: { count: 1, at: '2026-12-01T00:00:00Z' } } as never });
    open();
    expect(text()).toContain('Keep the business you were removing instead (no charge).');
    api.changeBusinesses.mockResolvedValue({ ok: true, op: { id: 'o1', kind: 'undo_remove', state: 'done' } });
    await click('Keep it');
    expect(api.changeBusinesses.mock.calls[0][0]).toMatchObject({ action: 'undo_remove', confirm: true });
  });

  it('a free plan can’t buy here', () => {
    useBilling.setState({ account: { ...PLAN.account, source: 'comp' } as never });
    open();
    expect(text()).toContain('Your plan doesn’t add businesses here.');
    expect(button('Add a business')).toBeUndefined();
  });
});
