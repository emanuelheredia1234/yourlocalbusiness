// @vitest-environment happy-dom
// Get paid with Stripe in a real DOM: back from Stripe (?stripe=return) the account is read again and a toast says
// where things stand; ?stripe=refresh gets a new link and goes there; the address loses the landing; the terms gate
// the button; a refused create gets a new request id, a lost connection keeps it. Every request is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { ConnectAccount, ConnectState } from '@/lib/stripeConnect';

const api = vi.hoisted(() => ({ connectStatus: vi.fn(), createConnectAccount: vi.fn(), onboardingLink: vi.fn(), syncConnect: vi.fn(), setConnectTax: vi.fn(), disconnectConnect: vi.fn() }));
vi.mock('@/lib/stripeConnect', async (orig) => ({ ...(await orig<typeof import('@/lib/stripeConnect')>()), ...api }));
const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/store/ui', async (orig) => ({ ...(await orig<typeof import('@/store/ui')>()), ...ui }));

const { OffersError } = await import('@/lib/offers');
const { takeStripeLanding } = await import('@/lib/router');
const { setConnectLanding, useOffers } = await import('@/store/offers');
const { TooltipProvider } = await import('@/components/ui/shadcn/tooltip');
const { StripeConnectCard } = await import('./StripeConnectCard');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT: ConnectAccount = { id: 'RRRRRRRRRRRRRRRRRRRRRR', environment: 'production', status: 'onboarding', country: 'US', defaultCurrency: 'usd', displayName: 'Maya Bakes', chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false, due: { now: 3, pastDue: 0, later: 0, pending: 0 }, deadline: null, disabledReason: null, taxEnabled: false, taxStatus: null, payoutFailedAt: null, accountLast4: 'h9Zq' };
const STATE: ConnectState = { available: true, environment: 'production', account: null, fee: { pct: 3, tier: 'launch' }, termsUrl: '/seller-terms', termsVersion: 'v1', termsReady: true, countries: ['US', 'GB'] };

let host: HTMLDivElement;
let root: Root;
const assign = vi.fn();
const render = async () => {
  await act(async () => {
    root.render(createElement(TooltipProvider, null, createElement(StripeConnectCard)));
  });
  await act(async () => {});
  await act(async () => {});
};
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

beforeEach(() => {
  for (const f of [...Object.values(api), ui.toast]) f.mockReset();
  api.connectStatus.mockResolvedValue(STATE);
  useOffers.getState().reset();
  vi.stubGlobal('location', { ...window.location, assign, hash: '', pathname: '/', search: '' });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setConnectLanding(null);
  useOffers.getState().reset();
  vi.unstubAllGlobals();
  assign.mockReset();
});

describe('Get paid with Stripe (DOM)', () => {
  it('back from Stripe: reads the account again and says where things stand', async () => {
    setConnectLanding('return');
    api.syncConnect.mockResolvedValue({ ...ACCOUNT, status: 'active', chargesEnabled: true });
    api.connectStatus.mockResolvedValue({ ...STATE, account: { ...ACCOUNT, status: 'active', chargesEnabled: true } });
    await render();
    expect(api.syncConnect).toHaveBeenCalledTimes(1);
    expect(ui.toast).toHaveBeenCalledWith({ kind: 'success', title: 'You’re ready to sell with Stripe.' });
    expect(host.textContent).toContain('Receiving payments');
  });

  it('back from Stripe, not finished yet: Stripe saved your progress', async () => {
    setConnectLanding('return');
    api.syncConnect.mockResolvedValue(ACCOUNT);
    api.connectStatus.mockResolvedValue({ ...STATE, account: ACCOUNT });
    await render();
    expect(ui.toast).toHaveBeenCalledWith({ kind: 'success', title: 'Stripe saved your progress.' });
    expect(host.textContent).toContain('Continue setup');
  });

  it('a link that ran out (?stripe=refresh): a new one, straight to Stripe', async () => {
    setConnectLanding('refresh');
    api.onboardingLink.mockResolvedValue('https://connect.stripe.com/setup/s/new');
    await render();
    expect(assign).toHaveBeenCalledWith('https://connect.stripe.com/setup/s/new');
  });

  it('the address: #settings/payments?stripe=return is taken once and becomes #workspace-settings', () => {
    const replace = vi.fn();
    vi.stubGlobal('location', { hash: '#settings/payments?stripe=return', pathname: '/', search: '' });
    vi.stubGlobal('history', { replaceState: replace });
    expect(takeStripeLanding()).toBe('return');
    expect(replace).toHaveBeenCalledWith(null, '', '/#workspace-settings');
    vi.stubGlobal('location', { hash: '#settings/payments?stripe=return&to=https://evil.test', pathname: '/', search: '' });
    expect(takeStripeLanding()).toBeNull();
  });

  it('the button waits for the seller terms; a refusal gets a new request id, a lost connection keeps it', async () => {
    await render();
    const go = button('Get paid with Stripe')!;
    expect(go.disabled).toBe(true);
    await act(async () => (host.querySelector('#stripe-terms') as HTMLButtonElement).click());
    expect(button('Get paid with Stripe')!.disabled).toBe(false);

    api.createConnectAccount.mockRejectedValueOnce(new OffersError('Couldn’t reach the server.', 'NETWORK'));
    await act(async () => button('Get paid with Stripe')!.click());
    api.createConnectAccount.mockRejectedValueOnce(new OffersError('Stripe doesn’t support sellers in that country yet.', 'BAD_COUNTRY', 400));
    await act(async () => button('Get paid with Stripe')!.click());
    api.createConnectAccount.mockResolvedValueOnce({ account: { ...ACCOUNT, status: 'unknown' }, pending: true });
    await act(async () => button('Get paid with Stripe')!.click());
    const ids = api.createConnectAccount.mock.calls.map((c) => c[0].clientRequestId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[1]);
    expect(host.textContent).toContain('Confirming your Stripe account…');
  });

  it('Continue setup goes to Stripe in this tab', async () => {
    api.connectStatus.mockResolvedValue({ ...STATE, account: ACCOUNT });
    api.onboardingLink.mockResolvedValue('https://connect.stripe.com/setup/s/abc');
    await render();
    await act(async () => button('Continue setup')!.click());
    expect(assign).toHaveBeenCalledWith('https://connect.stripe.com/setup/s/abc');
  });
});
