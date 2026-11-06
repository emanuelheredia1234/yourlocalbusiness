import { describe, expect, it } from 'vitest';
import { OffersError, checkoutHint, formatMoney, isCheckoutHost, offerConnection, offerPrice, offerProblem, offersError, requestIdsAfter, toConnection, toOffer, type WhopConnection } from './offers';

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
