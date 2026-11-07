// Analytics › Sales: live sales and revenue per currency from the server's summary, refunds under it, clicks,
// Test mode only as a note; nothing at all where offers aren't on.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import { SalesSection, SalesTiles } from './SalesSection';

const wrap = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(TooltipProvider, null, el));

describe('Analytics › Sales', () => {
  it('live sales, revenue per currency with refunds under it, buy link clicks', () => {
    const html = wrap(createElement(SalesTiles, { days: 30, summary: { days: 30, live: { count: 3, revenue: { usd: 14700, eur: 2000 }, refunded: { usd: 4900 } }, test: { count: 0 }, clicks: 42, offers: [] } }));
    expect(html).toContain('Sales');
    expect(html).toContain('>3<');
    expect(html).toContain('$147.00 · €20.00');
    expect(html).toContain('$49.00 refunded');
    expect(html).toContain('Buy link clicks');
    expect(html).toContain('>42<');
    expect(html).not.toContain('Test mode');
  });

  it('Test mode sales: only a note, never counted', () => {
    const html = wrap(createElement(SalesTiles, { days: 7, summary: { days: 7, live: { count: 0, revenue: {}, refunded: {} }, test: { count: 2 }, clicks: 0, offers: [] } }));
    expect(html).toContain('Plus 2 Test mode sales (not counted).');
    expect(html).toContain('$0.00');
  });

  it('Revenue: before the provider’s fees, and our fee too for Stripe sales', () => {
    const summary = { days: 7, live: { count: 1, revenue: { usd: 4900 }, refunded: {} }, test: { count: 0 }, clicks: 1, offers: [] };
    expect(wrap(createElement(SalesTiles, { days: 7, summary, via: 'Whop' }))).toContain('Before Whop’s fees<');
    expect(wrap(createElement(SalesTiles, { days: 7, summary, via: 'Stripe' }))).toContain('Before Stripe’s fees and our fee');
    expect(wrap(createElement(SalesTiles, { days: 7, summary, via: 'Stripe and Whop' }))).toContain('fees and our fee');
  });

  it('nothing at all when offers are off (signed out, server off)', () => {
    expect(wrap(createElement(SalesSection, { projectId: 'p1', brand: 'Maya', days: 30 }))).toBe('');
  });
});
