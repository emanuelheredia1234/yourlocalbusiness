import { describe, expect, it } from 'vitest';
import { OffersError, checkoutHint, decimalToMinor, feePreview, formatMoney, isCheckoutHost, minorToDecimal, offerConnection, offerPrice, offerProblem, offersError, requestIdsAfter, saleStatusLabel, toConnection, toOffer, toSale, type WhopConnection } from './offers';

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('offers client', () => {
  it('reads an offer and refuses what isn’t one', () => {
    const o = toOffer({ id: ID, projectId: 'p1', title: 'Course', priceDisplay: '$49', priceMinor: 4900, currency: 'usd', provider: 'whop', status: 'active', environment: 'sandbox', checkoutHost: 'sandbox.whop.com', clicks: 3, sales: { count: 2, last: null }, link: `https://app.test/b/${ID}` });
    expect(o).toMatchObject({ id: ID, provider: 'whop', environment: 'sandbox', clicks: 3, sales: { count: 2 }, link: `https://app.test/b/${ID}` });
    expect(toOffer({ id: 'bad' })).toBeNull();
    // a link that isn't this offer's own isn't kept
    expect(toOffer({ id: ID, link: 'https://evil.test/x' })?.link).toBe('');
  });

  it('a connection never carries more than the key’s last 4', () => {
    const c = toConnection({ id: ID, environment: 'production', accountId: 'biz_abcd', keyLast4: 'secretkey1234', webhook: { mode: 'manual', state: 'missing', url: 'https://app.test/api/webhooks/whop/x' }, status: 'active' });
    expect(c?.keyLast4).toBe('1234');
    expect(c?.webhook.url).toBe('https://app.test/api/webhooks/whop/x');
  });

  it('refusals in our words, never Whop’s', () => {
    expect(offersError(400, { code: 'WHOP_KEY_REJECTED', error: 'whop said something' }).message).toMatch(/didn’t accept this API key/);
    expect(offersError(400, { code: 'WHOP_PERMISSION', missing: 'plan:basic:read' }).message).toContain('plan:basic:read');
    expect(offersError(402, { code: 'PLAN_REQUIRED' }).code).toBe('UPGRADE');
    expect(offersError(409, { code: 'OFFERS_LIVE', error: '2 buy links use this Whop account.', count: 2 }).extra.count).toBe(2);
  });

  it('checkout hosts: listed sites go straight there, others see the leaving page', () => {
    expect(isCheckoutHost('shop.myshopify.com')).toBe(true);
    expect(isCheckoutHost('www.gumroad.com')).toBe(true);
    expect(isCheckoutHost('evilgumroad.com')).toBe(false);
    expect(checkoutHint('https://buy.stripe.com/abc')).toBe('Buyers go straight to buy.stripe.com.');
    expect(checkoutHint('https://my-shop.test/buy')).toMatch(/You’re leaving/);
  });

  it('prices and problems in plain words', () => {
    expect(formatMoney(4900, 'usd')).toBe('$49.00');
    expect(offerPrice({ priceDisplay: '', priceMinor: 1900, currency: 'usd' })).toBe('$19.00');
    expect(offerProblem({ status: 'checkout_unknown' })).toMatch(/Check again/);
    expect(offerProblem({ status: 'active' }, { status: 'key_rejected' })).toMatch(/Settings › Payments/);
    expect(offerProblem({ status: 'active' })).toBe('');
  });

  it('a refused create gets a new request id; a lost answer keeps it (no second link)', () => {
    const ids = { whop: 'w-1', own: 'o-1' };
    const refused = requestIdsAfter(ids, 'whop', new OffersError('Whop didn’t accept this.', 'WHOP_REFUSED', 422));
    expect(refused.whop).not.toBe('w-1');
    expect(refused.own).toBe('o-1');
    expect(requestIdsAfter(ids, 'own', new OffersError('Use https', 'BAD_URL', 400)).own).not.toBe('o-1');
    expect(requestIdsAfter(ids, 'whop', new OffersError('Couldn’t reach the server.', 'NETWORK', 0))).toBe(ids);
    expect(requestIdsAfter(ids, 'whop', new Error('boom'))).toBe(ids);
  });

  it('an offer’s Whop connection is matched by id: a reconnect doesn’t make an old offer look live', () => {
    const conn = (id: string, status: WhopConnection['status'] = 'active') => ({ id, environment: 'production', status }) as WhopConnection;
    const offer = { provider: 'whop' as const, connectionId: 'old-conn' };
    expect(offerConnection(offer, null)).toBeNull();
    expect(offerConnection(offer, [conn('old-conn')])?.status).toBe('active');
    // disconnected, then the same environment connected again: a new connection
    const now = offerConnection(offer, [conn('new-conn')]);
    expect(now?.status).toBe('disconnected');
    expect(offerProblem({ status: 'active' }, now)).toMatch(/isn’t connected any more/);
    expect(offerConnection({ provider: 'external', connectionId: null }, [conn('new-conn')])).toBeNull();
  });
});

describe('Stripe offers and sales (P6)', () => {
  it('a Stripe offer carries its delivery and the setup problem', () => {
    const o = toOffer({ id: ID, projectId: 'p1', title: 'Guide', priceDisplay: '$49', priceMinor: 4900, currency: 'usd', provider: 'stripe', status: 'active', environment: 'sandbox', checkoutHost: 'checkout.stripe.com', delivery: { kind: 'file', fileId: 'FFFFFFFFFFFFFFFFFFFFFF' }, problem: 'stripe_setup', link: `https://app.test/b/${ID}` });
    expect(o).toMatchObject({ provider: 'stripe', environment: 'sandbox', delivery: { kind: 'file', fileId: 'FFFFFFFFFFFFFFFFFFFFFF' }, problem: 'stripe_setup' });
    expect(offerProblem(o!)).toBe('Finish Stripe setup to start selling.');
    // a bad file id reads as "nothing to download"; a Whop offer has neither
    expect(toOffer({ id: ID, provider: 'stripe', delivery: { kind: 'file', fileId: '../x' } })?.delivery).toEqual({ kind: 'none' });
    const w = toOffer({ id: ID, provider: 'whop', delivery: { kind: 'file', fileId: 'FFFFFFFFFFFFFFFFFFFFFF' }, problem: 'stripe_setup' });
    expect(w?.delivery).toBeUndefined();
    expect(w?.problem).toBeUndefined();
  });

  it('a Stripe sale: our fee, the fee returned, the dispute and downloads', () => {
    const s = toSale({ id: 'S1', provider: 'stripe', status: 'disputed', amountMinor: 4900, refundedMinor: 0, currency: 'usd', environment: 'production', feeMinor: 147, feePct: 3, feeReturnedMinor: 50, disputeStatus: 'won', downloads: 2 });
    expect(s).toMatchObject({ provider: 'stripe', feeMinor: 147, feePct: 3, feeReturnedMinor: 50, disputeStatus: 'won', downloads: 2 });
    expect(saleStatusLabel(s!)).toBe('Dispute won');
    expect(saleStatusLabel({ ...s!, disputeStatus: 'needs_response' })).toBe('Dispute: needs response');
    expect(saleStatusLabel({ ...s!, disputeStatus: 'lost' })).toBe('Dispute lost');
    // a Whop sale (or one from before the provider was said) points to Whop
    const w = toSale({ id: 'S2', status: 'disputed', amountMinor: 100, currency: 'usd' });
    expect(w?.feeMinor).toBeUndefined();
    expect(saleStatusLabel(w!)).toBe('Disputed: see Whop');
    // no fee taken stays null, not 0
    expect(toSale({ id: 'S3', provider: 'stripe', status: 'paid', amountMinor: 100, currency: 'usd', feeMinor: null })?.feeMinor).toBeNull();
  });

  it('feePreview mirrors the server: floor, none when 0 or not below the amount, none for a seller in Brazil', () => {
    expect(feePreview(4900, 3)).toBe(147);
    expect(feePreview(999, 3)).toBe(29);
    expect(feePreview(100, 1)).toBe(1);
    expect(feePreview(99, 1)).toBe(0);
    expect(feePreview(4900, 0)).toBe(0);
    expect(feePreview(100, 100)).toBe(0);
    expect(feePreview(4900, 3, 'BR')).toBe(0);
    expect(feePreview(4900, 3, 'BR', 'BR')).toBe(147);
  });

  it('a typed price as minor units, zero-decimal currencies whole', () => {
    expect(decimalToMinor('49', 'usd')).toBe(4900);
    expect(decimalToMinor('$49.5', 'usd')).toBe(4950);
    expect(decimalToMinor('1,299.99', 'eur')).toBe(129999);
    expect(decimalToMinor('49.999', 'usd')).toBeNull();
    expect(decimalToMinor('abc', 'usd')).toBeNull();
    expect(decimalToMinor('500', 'jpy')).toBe(500);
    expect(decimalToMinor('500.5', 'jpy')).toBeNull();
    expect(minorToDecimal(decimalToMinor('12.30', 'usd')!, 'usd')).toBe('12.30');
  });

  it('Stripe’s refusals in the server’s own words (already ours)', () => {
    expect(offersError(409, { code: 'STRIPE_NOT_CONNECTED', error: 'Set up Stripe in Settings › Payments first.' }).message).toBe('Set up Stripe in Settings › Payments first.');
    expect(offersError(409, { code: 'TAX_NOT_READY', error: 'Finish Stripe Tax setup in your Stripe Dashboard (Tax → Settings), then try again.' }).message).toMatch(/Stripe Tax/);
    // NOT_SET_UP stays the generic sentence unless the caller asks for the server's
    expect(offersError(503, { code: 'NOT_SET_UP', error: 'Selling with Stripe opens soon.' }).message).toMatch(/aren’t set up/);
    expect(offersError(503, { code: 'NOT_SET_UP', error: 'Selling with Stripe opens soon.' }, ['NOT_SET_UP']).message).toBe('Selling with Stripe opens soon.');
  });
});
