// Attach payment, the offers list and the sales table, drawn once per state (as on the server: no effects run).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import type { Offer, Sale, WhopConnection } from '@/lib/offers';
import { AttachPayment, AttachPaymentForm, AttachedOffer } from './AttachPayment';
import { OfferRow } from './OffersPanel';
import { SalesRows } from './SalesTable';

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const OFFER: Offer = {
  id: ID,
  projectId: 'p1',
  title: 'Spring course',
  priceDisplay: '$49',
  priceMinor: 4900,
  currency: 'usd',
  provider: 'whop',
  status: 'active',
  environment: 'production',
  checkoutHost: 'whop.com',
  clicks: 12,
  lastClickAt: null,
  sales: { count: 3, last: null },
  createdAt: null,
  updatedAt: null,
  link: `https://app.test/b/${ID}`,
};
const CONN: WhopConnection = { id: 'CCCCCCCCCCCCCCCCCCCCCC', environment: 'production', accountId: 'biz_live1234', accountName: '', keyLast4: 'w9Zq', webhook: { mode: 'auto', state: 'ok' }, status: 'active', lastEventAt: null, checkedAt: null };
const wrap = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(TooltipProvider, null, el));
const form = (props: Partial<Parameters<typeof AttachPaymentForm>[0]>) => wrap(createElement(AttachPaymentForm, { projectId: 'p1', offers: [], connections: [], whopOn: true, onAttach: () => {}, ...props }));

afterEach(() => vi.unstubAllGlobals());

describe('Attach payment', () => {
  it('lists the business’s offers to pick, with who takes the payment and Test mode', () => {
    const html = form({ offers: [OFFER, { ...OFFER, id: 'BBBBBBBBBBBBBBBBBBBBBB', title: 'Test plan', environment: 'sandbox' }], connections: [CONN] });
    expect(html).toContain('Your offers');
    expect(html).toContain('Spring course');
    expect(html).toContain('$49');
    expect(html).toContain('Whop');
    expect(html).toContain('Test mode');
  });

  it('Whop: the product to choose first (loading), with the connection in place', () => {
    const html = form({ connections: [CONN], initialTab: 'whop' });
    expect(html).toContain('Whop product');
    expect(html).toContain('Loading your products');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Create buy link/);
  });

  it('Whop without a connection: where to connect it', () => {
    const html = form({ initialTab: 'whop' });
    expect(html).toContain('Connect your Whop account in Settings › Payments first.');
  });

  it('your own link: the URL, title and price, and that only clicks show', () => {
    const html = form({ initialTab: 'external' });
    expect(html).toContain('Your checkout link');
    expect(html).toContain('Price (as shown)');
    expect(html).toContain('only clicks on its buy link show in Analytics');
  });

  it('a link Whop didn’t confirm: says so, with Check again', () => {
    const html = form({ initialPending: { ...OFFER, status: 'checkout_unknown' } });
    expect(html).toContain('Whop didn’t confirm the link yet');
    expect(html).toContain('Check again');
    expect(html).not.toContain('Create buy link');
  });

  it('an attached offer: title, price, provider, Copy link, Change, Remove, and a warning when it isn’t selling', () => {
    const html = wrap(createElement(AttachedOffer, { offer: OFFER, onChange: () => {}, onRemove: () => {} }));
    for (const t of ['Spring course', '$49', 'Whop', 'Copy link', 'Change', 'Remove']) expect(html).toContain(t);
    expect(html).not.toContain('Paused');
    const paused = wrap(createElement(AttachedOffer, { offer: { ...OFFER, status: 'paused' }, onChange: () => {}, onRemove: () => {} }));
    expect(paused).toContain('Paused: its buy link says it isn’t available right now.');
    const rejected = wrap(createElement(AttachedOffer, { offer: OFFER, connection: { ...CONN, status: 'key_rejected' }, onChange: () => {}, onRemove: () => {} }));
    expect(rejected).toContain('Settings › Payments');
  });

  it('the claude.ai build: only the plain link field', () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    const html = wrap(createElement(AttachPayment, { projectId: 'p1', onAttach: () => {}, onDetach: () => {}, fallback: createElement('input', { id: 'plain-link' }) }));
    expect(html).toContain('id="plain-link"');
    expect(html).not.toContain('Attach payment');
  });
});

describe('Offers and sales', () => {
  it('an offer’s row: clicks, live sales, where it’s used', () => {
    const html = wrap(createElement(OfferRow, { offer: OFFER, uses: ['SEO page', 'Listing'], onCheck: () => {}, onPause: () => {}, onArchive: () => {} }));
    expect(html).toContain('12 clicks');
    expect(html).toContain('3 sales');
    expect(html).toContain('Used on: SEO page, Listing');
    const own = wrap(createElement(OfferRow, { offer: { ...OFFER, provider: 'external', environment: null, checkoutHost: 'gumroad.com' }, uses: [], onCheck: () => {}, onPause: () => {}, onArchive: () => {} }));
    expect(own).toContain('sales happen on your own checkout');
    expect(own).toContain('Not used anywhere yet');
  });

  it('the sales table: amount, refund, status in plain words, buyer email', () => {
    const sales: Sale[] = [
      { id: 's1', offerId: ID, projectId: 'p1', status: 'partially_refunded', amountMinor: 4900, refundedMinor: 1000, currency: 'usd', environment: 'production', buyerEmail: 'ann@example.com', paidAt: '2026-11-01T10:00:00Z', createdAt: null },
      { id: 's2', offerId: ID, projectId: 'p1', status: 'disputed', amountMinor: 4900, refundedMinor: 0, currency: 'usd', environment: 'production', buyerEmail: null, paidAt: '2026-11-02T10:00:00Z', createdAt: null },
    ];
    const html = wrap(createElement(SalesRows, { sales, offers: [OFFER] }));
    expect(html).toContain('$49.00');
    expect(html).toContain('$10.00 refunded');
    expect(html).toContain('Partly refunded');
    expect(html).toContain('Disputed: see Whop');
    expect(html).toContain('ann@example.com');
    expect(html).toContain('Spring course');
  });
});
