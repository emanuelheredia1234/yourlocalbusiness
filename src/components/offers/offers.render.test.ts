// Attach payment, the offers list and the sales table, drawn once per state (as on the server: no effects run).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import type { Offer, Sale, WhopConnection } from '@/lib/offers';
import { AttachPayment, AttachPaymentForm, AttachedOffer } from './AttachPayment';
import { OfferRow } from './OffersPanel';
import { RefundsNote, SalesRows, canRelink } from './SalesTable';
import { StripeOfferForm, priceProblem, stripePreview } from './StripeOfferForm';
import type { ConnectAccount, ConnectState } from '@/lib/stripeConnect';
import type { LeadFile } from '@/lib/leadFiles';

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

const ACCT: ConnectAccount = { id: 'RRRRRRRRRRRRRRRRRRRRRR', environment: 'production', status: 'active', country: 'US', defaultCurrency: 'usd', displayName: 'Maya Bakes', chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, due: { now: 0, pastDue: 0, later: 0, pending: 0 }, deadline: null, disabledReason: null, taxEnabled: false, taxStatus: null, payoutFailedAt: null, accountLast4: 'h9Zq' };
const CONNECT: ConnectState = { available: true, environment: 'production', account: ACCT, fee: { pct: 3, tier: 'launch' }, termsUrl: '/seller-terms', termsVersion: 'v1', termsReady: true, countries: ['US'] };
const FILE: LeadFile = { id: 'FFFFFFFFFFFFFFFFFFFFFF', projectId: 'p1', title: 'Spring guide', brand: '', kind: 'file', fileName: 'guide.pdf', mime: 'application/pdf', bytes: 1000, url: '', gate: false, purpose: 'product', coverUrl: null, downloads: 0, lastDownloadAt: null, createdAt: null, updatedAt: null, link: '' };
const stripeForm = (props: Partial<Parameters<typeof StripeOfferForm>[0]> = {}) => wrap(createElement(StripeOfferForm, { projectId: 'p1', connect: CONNECT, busy: false, error: '', onCreate: () => {}, ...props }));
const STRIPE_OFFER: Offer = { ...OFFER, id: 'SSSSSSSSSSSSSSSSSSSSSS', provider: 'stripe', checkoutHost: 'checkout.stripe.com', delivery: { kind: 'file', fileId: FILE.id } };

describe('Attach payment › Stripe (P6)', () => {
  it('Stripe comes first when it’s on, and never in the claude.ai build', () => {
    const html = form({ stripeOn: true, connect: CONNECT });
    expect(html.indexOf('New: Stripe')).toBeGreaterThan(-1);
    expect(html.indexOf('New: Stripe')).toBeLessThan(html.indexOf('New: Whop'));
    expect(html).toContain('What the buyer gets');
    expect(form({ stripeOn: false })).not.toContain('New: Stripe');
    // the seller terms still a draft (not open to this user): no Stripe tab, and Whop or outside links first
    const closed = form({ stripeOn: true, connect: { ...CONNECT, available: false, account: null } });
    expect(closed).not.toContain('New: Stripe');
    expect(closed).toContain('New: Whop');
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    expect(form({ stripeOn: true, connect: CONNECT })).not.toContain('New: Stripe');
  });

  it('the currency list is Stripe’s own minor units only: no HUF or ISK, even as the account’s default', () => {
    const html = stripeForm({ connect: { ...CONNECT, account: { ...ACCT, defaultCurrency: 'huf' } } });
    expect(html).not.toMatch(/<option value="huf"/);
    expect(html).not.toMatch(/<option value="isk"/);
    expect(html).toMatch(/<option value="usd" selected=""/);
  });

  it('no Stripe account: where to set it up', () => {
    const html = stripeForm({ connect: { ...CONNECT, account: null } });
    expect(html).toContain('Set up Stripe to sell here');
    expect(html).toContain('Go to Settings › Payments');
    expect(html).not.toContain('Create buy link');
  });

  it('the form: title (the asset’s name), price, the account’s currency, what the buyer gets', () => {
    const html = stripeForm({ defaultTitle: 'Spring course', connect: { ...CONNECT, account: { ...ACCT, defaultCurrency: 'gbp' } } });
    expect(html).toMatch(/id="attach-stripe-title"[^>]*value="Spring course"/);
    expect(html).toMatch(/<option value="gbp" selected="">GBP<\/option>/);
    expect(html).toContain('Nothing to download');
    expect(html).toContain('A file');
    expect(html).toContain('You deliver it yourself');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
    expect(html).not.toMatch(/application fee|KYC/i);
  });

  it('the preview: our fee per tier; none on Scale or for the owner', () => {
    expect(stripePreview(4900, 'usd', { pct: 3, tier: 'launch' })).toBe('Buyer pays $49.00 · Our fee $1.47 (3% on Launch) · Stripe’s fee comes out of your Stripe balance.');
    expect(stripePreview(4900, 'usd', { pct: 1, tier: 'grow' })).toContain('Our fee $0.49 (1% on Grow)');
    expect(stripePreview(4900, 'usd', { pct: 0, tier: 'scale' })).toContain('No platform fee');
    expect(stripePreview(4900, 'usd', { pct: 0, tier: 'owner' })).toContain('No platform fee');
    expect(stripePreview(4900, 'usd', { pct: 3, tier: 'launch' }, 'BR')).toContain('No platform fee on this price');
  });

  it('a zero-decimal currency takes whole numbers; Stripe’s limits are said before sending', () => {
    expect(priceProblem('5000', 'jpy')).toBe('');
    expect(priceProblem('50.5', 'jpy')).toBe('Use a whole number.');
    expect(priceProblem('0.10', 'usd')).toMatch(/lowest price Stripe takes in USD is \$0\.50/);
    // Stripe's minimum in each currency (shared/stripe-currencies.json), and no HUF or ISK (Stripe takes them with two decimals)
    expect(priceProblem('5.00', 'mxn')).toMatch(/lowest price Stripe takes in MXN is MX\$10\.00/);
    expect(priceProblem('10', 'mxn')).toBe('');
    expect(priceProblem('5000', 'huf')).toMatch(/can’t be priced in HUF/);
    expect(priceProblem('5000', 'isk')).toMatch(/can’t be priced in ISK/);
    expect(priceProblem('49.999', 'usd')).toMatch(/like 49/);
    expect(stripePreview(5000, 'jpy', { pct: 3, tier: 'launch' })).toContain('Buyer pays ¥5,000 · Our fee ¥150');
  });

  it('a file: pick one of the product files or upload one', () => {
    const html = wrap(createElement(StripeOfferForm, { projectId: 'p1', connect: CONNECT, busy: false, error: '', onCreate: () => {}, initialFiles: [FILE] }));
    // the files list shows once "A file" is chosen (a click): drawn here, the choice is there
    expect(html).toContain('What the buyer gets');
    expect(html).toContain('A file');
  });

  it('Stripe setup not finished: the offer can still be made, with a note', () => {
    const html = stripeForm({ connect: { ...CONNECT, account: { ...ACCT, status: 'onboarding', chargesEnabled: false } } });
    expect(html).toContain('Finish Stripe setup to start selling.');
    expect(html).toContain('Create buy link');
  });

  it('a Stripe offer’s badges and problem', () => {
    const html = wrap(createElement(AttachedOffer, { offer: { ...STRIPE_OFFER, problem: 'stripe_setup', environment: 'sandbox' }, onChange: () => {}, onRemove: () => {} }));
    expect(html).toContain('Stripe');
    expect(html).toContain('Test mode');
    expect(html).toContain('Finish Stripe setup to start selling.');
    const row = wrap(createElement(OfferRow, { offer: STRIPE_OFFER, uses: [], onCheck: () => {}, onPause: () => {}, onArchive: () => {} }));
    expect(row).toContain('3 sales');
    expect(row).not.toContain('Refresh from Whop');
  });
});

describe('Stripe sales (P6)', () => {
  const sale = (over: Partial<Sale>): Sale => ({ id: '11111111-1111-4111-8111-111111111111', offerId: STRIPE_OFFER.id, projectId: 'p1', status: 'paid', amountMinor: 4900, refundedMinor: 0, currency: 'usd', environment: 'production', buyerEmail: 'ann@example.com', paidAt: '2026-11-01T10:00:00Z', createdAt: null, provider: 'stripe', feeMinor: 147, feePct: 3, feeReturnedMinor: 0, disputeStatus: null, downloads: 1, ...over });

  it('our fee under the amount, and what went back', () => {
    const html = wrap(createElement(SalesRows, { sales: [sale({}), sale({ id: '22222222-2222-4222-8222-222222222222', status: 'partially_refunded', refundedMinor: 2450, feeReturnedMinor: 73 })], offers: [STRIPE_OFFER] }));
    expect(html).toContain('Our fee $1.47');
    expect(html).toContain('$0.73 returned');
    expect(html).toContain('$24.50 refunded');
  });

  it('a dispute in words', () => {
    const html = wrap(createElement(SalesRows, { sales: [sale({ status: 'disputed', disputeStatus: 'needs_response' }), sale({ id: 'x2', status: 'disputed', disputeStatus: 'won' }), sale({ id: 'x3', status: 'disputed', disputeStatus: 'lost' })], offers: [STRIPE_OFFER] }));
    expect(html).toContain('Dispute: needs response');
    expect(html).toContain('Dispute won');
    expect(html).toContain('Dispute lost');
    expect(html).not.toContain('see Whop');
  });

  it('a paid sale with a file: a new download link for the buyer; not when refunded or without a file', () => {
    expect(canRelink(sale({}), [STRIPE_OFFER])).toBe(true);
    expect(canRelink(sale({ status: 'refunded' }), [STRIPE_OFFER])).toBe(false);
    expect(canRelink(sale({}), [{ ...STRIPE_OFFER, delivery: { kind: 'none' } }])).toBe(false);
    expect(canRelink(sale({ provider: 'whop' }), [STRIPE_OFFER])).toBe(false);
    const html = wrap(createElement(SalesRows, { sales: [sale({})], offers: [STRIPE_OFFER] }));
    expect(html).toContain('Download link');
  });

  it('refunds and disputes: in the Stripe Dashboard', () => {
    const html = wrap(createElement(RefundsNote, { offers: [STRIPE_OFFER] }));
    expect(html).toMatch(/href="https:\/\/dashboard\.stripe\.com\/payments"/);
    expect(html).toContain('in your Stripe Dashboard');
    expect(html).not.toContain('Whop');
    expect(wrap(createElement(RefundsNote, { offers: [OFFER] }))).toContain('handled in Whop');
  });
});
