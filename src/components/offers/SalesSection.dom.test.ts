// @vitest-environment happy-dom
// Analytics › Sales in a real DOM: archiving every offer keeps the section (their sales are still the business's);
// a business with no offers, sales or clicks shows nothing. Every request is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { SalesSummary } from '@/lib/offers';

const api = vi.hoisted(() => ({ listOffers: vi.fn(), salesSummary: vi.fn(), listSales: vi.fn() }));
vi.mock('@/lib/offers', async (orig) => ({ ...(await orig<typeof import('@/lib/offers')>()), ...api }));

const { useAuth } = await import('@/lib/cloud/auth');
const { useOffers } = await import('@/store/offers');
const { TooltipProvider } = await import('@/components/ui/shadcn/tooltip');
const { SalesSection } = await import('./SalesSection');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary = (live: number, clicks: number): SalesSummary => ({ days: 30, live: { count: live, revenue: live ? { usd: 4900 * live } : {}, refunded: {} }, test: { count: 0 }, clicks, offers: [] });

let host: HTMLDivElement;
let root: Root;
const render = async () => {
  await act(async () => {
    root.render(createElement(TooltipProvider, null, createElement(SalesSection, { projectId: 'p1', brand: 'Maya', days: 30 })));
  });
  await act(async () => {});
};

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.listOffers.mockResolvedValue([]);
  api.listSales.mockResolvedValue({ sales: [], next: null });
  useAuth.setState({ phase: 'ready', user: { id: 'u-sales', email: 'maya@example.com' } });
  useOffers.getState().reset();
  useOffers.setState({ config: { enabled: true, whop: { sandbox: false, production: true }, stripe: { available: false, environment: null }, reachable: true } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useOffers.getState().reset();
  useOffers.setState({ config: null });
  useAuth.setState({ phase: 'signed-out', user: null });
});

describe('Analytics › Sales', () => {
  it('stays when every offer is archived: their sales still show', async () => {
    api.salesSummary.mockResolvedValue(summary(2, 5));
    await render();
    expect(host.textContent).toContain('Sales');
    expect(host.textContent).toContain('$98');
    expect(api.listSales).toHaveBeenCalled();
  });

  it('nothing for a business with no offers, sales or clicks', async () => {
    api.salesSummary.mockResolvedValue(summary(0, 0));
    await render();
    expect(host.textContent).toBe('');
  });
});
