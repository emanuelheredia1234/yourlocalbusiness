// Whop webhook pieces with no network: the signature (a fixed vector pins whopHmacKey's rule), the event shape,
// money in minor units and what a Payment says about its sale.
import { describe, expect, it } from 'vitest';
import { cleanEmail, parseEvent, paymentOf, saleFromPayment, signWhopPayload, toMinor, verifyWhopSignature, whopHmacKey } from './whopWebhook.mjs';

const SECRET = 'ws_test_secret_0123456789abcdef';
const BODY = '{"id":"msg_2Kxyz","type":"payment.succeeded"}';
const ID = 'msg_2Kxyz';
const TS = '1767225600';
const NOW = 1767225600 * 1000;
const headers = (over = {}) => ({ 'webhook-id': ID, 'webhook-timestamp': TS, 'webhook-signature': signWhopPayload(Buffer.from(BODY), ID, TS, SECRET), ...over });

describe('verifyWhopSignature', () => {
  it('pins the key rule with a fixed vector (changing whopHmacKey must be deliberate)', () => {
    expect(whopHmacKey(SECRET).equals(Buffer.from(SECRET, 'utf8'))).toBe(true);
    expect(signWhopPayload(Buffer.from(BODY), ID, TS, SECRET)).toBe('v1,IQqWM/ma4tIB7iIVXJEE5V8lX30i4uZwpmLdbl5qsXE=');
    expect(verifyWhopSignature(Buffer.from(BODY), { 'webhook-id': ID, 'webhook-timestamp': TS, 'webhook-signature': 'v1,IQqWM/ma4tIB7iIVXJEE5V8lX30i4uZwpmLdbl5qsXE=' }, SECRET, NOW)).toBe(true);
  });

  it('refuses a wrong secret, a changed byte and re-serialised JSON', () => {
    expect(verifyWhopSignature(Buffer.from(BODY), headers(), 'ws_other', NOW)).toBe(false);
    const tampered = Buffer.from(BODY);
    tampered[5] ^= 1;
    expect(verifyWhopSignature(tampered, headers(), SECRET, NOW)).toBe(false);
    expect(verifyWhopSignature(Buffer.from(JSON.stringify(JSON.parse(BODY), null, 1)), headers(), SECRET, NOW)).toBe(false);
  });

  it('refuses stale and future timestamps beyond 5 minutes, and odd timestamps', () => {
    expect(verifyWhopSignature(Buffer.from(BODY), headers(), SECRET, NOW + 300_000)).toBe(true);
    expect(verifyWhopSignature(Buffer.from(BODY), headers(), SECRET, NOW + 301_000)).toBe(false);
    expect(verifyWhopSignature(Buffer.from(BODY), headers(), SECRET, NOW - 301_000)).toBe(false);
    expect(verifyWhopSignature(Buffer.from(BODY), headers({ 'webhook-timestamp': '1767225600.0' }), SECRET, NOW)).toBe(false);
  });

  it('refuses missing or oversized headers, and needs a v1 entry that matches', () => {
    for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
      const h = headers();
      delete h[name];
      expect(verifyWhopSignature(Buffer.from(BODY), h, SECRET, NOW)).toBe(false);
    }
    expect(verifyWhopSignature(Buffer.from(BODY), headers({ 'webhook-signature': `${'v1,AAAA '.repeat(200)}${headers()['webhook-signature']}` }), SECRET, NOW)).toBe(false);
    const good = headers()['webhook-signature'];
    expect(verifyWhopSignature(Buffer.from(BODY), headers({ 'webhook-signature': `v1,AAAA ${good}` }), SECRET, NOW)).toBe(true);
    expect(verifyWhopSignature(Buffer.from(BODY), headers({ 'webhook-signature': good.replace('v1,', 'v2,') }), SECRET, NOW)).toBe(false);
    expect(verifyWhopSignature(Buffer.from(BODY), headers({ 'webhook-signature': good.slice(3) }), SECRET, NOW)).toBe(false);
    expect(verifyWhopSignature(BODY, headers(), SECRET, NOW)).toBe(false);
    expect(verifyWhopSignature(Buffer.from(BODY), headers(), '', NOW)).toBe(false);
  });
});

describe('parseEvent', () => {
  it('reads the envelope with account_id or the older company_id', () => {
    expect(parseEvent(Buffer.from(JSON.stringify({ id: 'msg_1', type: 'payment.succeeded', timestamp: '2026-11-06T10:00:00Z', account_id: 'biz_abcd', data: { id: 'pay_1' } })))).toMatchObject({ id: 'msg_1', account: 'biz_abcd', timestamp: '2026-11-06T10:00:00.000Z' });
    expect(parseEvent(Buffer.from(JSON.stringify({ id: 'msg_1', type: 'x', company_id: 'biz_old1', data: {} }))).account).toBe('biz_old1');
  });
  it('refuses what isn’t an event', () => {
    for (const s of ['not json', '[]', '{"id":"x","type":"y"}', '{"id":1,"type":"y","data":{}}', '{"id":"x","type":"y","data":[]}']) expect(parseEvent(Buffer.from(s))).toBeNull();
  });
});

describe('toMinor', () => {
  it.each([
    [{ amount: '10.00', currency: 'USD', decimals: 2 }, 1000, 'usd', true],
    [{ amount: '10', currency: 'usd' }, 1000, 'usd', true],
    [{ amount: '10.5', currency: 'usd' }, 1050, 'usd', true],
    [{ amount: '1500', currency: 'jpy', decimals: 0 }, 1500, 'jpy', true],
    [{ amount: '1.234', currency: 'kwd', decimals: 3 }, 1234, 'kwd', true],
    [{ amount: '10.000', currency: 'usd', decimals: 2 }, 1000, 'usd', true],
    [{ amount: '10.005', currency: 'usd', decimals: 2 }, 0, 'usd', false],
    [{ amount: '-1.00', currency: 'usd' }, 0, 'usd', false],
    [{ amount: '1e3', currency: 'usd' }, 0, 'usd', false],
    [{ amount: '9999999999999', currency: 'usd' }, 0, 'usd', false],
    [{ amount: '10.00', currency: 'usd', decimals: 9 }, 0, 'usd', false],
    [49.99, 4999, null, true],
    [0.1 + 0.2, 30, null, true],
    [Number.NaN, 0, null, false],
    [null, 0, null, false],
    ['garbage', 0, null, false],
    [{ amount: { nested: 1 } }, 0, null, false],
  ])('%j → %i %s %s', (money, minor, currency, ok) => {
    expect(toMinor(money)).toEqual({ minor, currency, ok });
  });
  it('takes the payment’s currency when the money has none', () => {
    expect(toMinor('12.00', 'EUR')).toEqual({ minor: 1200, currency: 'eur', ok: true });
  });
});

describe('saleFromPayment', () => {
  const pay = (over = {}) => ({
    id: 'pay_abc123',
    account_id: 'biz_abcd1234',
    status: 'paid',
    total: { amount: '49.00', currency: 'usd', decimals: 2 },
    amount_after_fees: { amount: '45.10', currency: 'usd', decimals: 2 },
    currency: 'usd',
    metadata: { ylb_offer: 'o'.repeat(22), ylb_env: 'production' },
    checkout_configuration_id: 'ch_abc123',
    membership_id: 'mem_abc123',
    customer_email: ' Buyer@Example.com ',
    paid_at: '2026-11-06T10:00:00Z',
    ...over,
  });

  it('maps a succeeded payment', () => {
    expect(saleFromPayment('payment.succeeded', pay())).toEqual({
      paymentId: 'pay_abc123',
      offerId: 'o'.repeat(22),
      checkoutId: 'ch_abc123',
      account: 'biz_abcd1234',
      status: 'paid',
      amountMinor: 4900,
      amountOk: true,
      netMinor: 4510,
      refundedMinor: 0,
      currency: 'usd',
      email: 'buyer@example.com',
      paidAt: '2026-11-06T10:00:00.000Z',
      membershipId: 'mem_abc123',
    });
  });

  it('maps statuses and lets the payment’s own refund win', () => {
    expect(saleFromPayment('payment.pending', pay({ status: 'pending' })).status).toBe('pending');
    expect(saleFromPayment('payment.failed', pay({ status: 'open' })).status).toBe('failed');
    expect(saleFromPayment('payment.pending', pay()).status).toBe('paid');
    expect(saleFromPayment('payment.succeeded', pay({ refunded_amount: { amount: '49.00', currency: 'usd' } })).status).toBe('refunded');
    expect(saleFromPayment('payment.succeeded', pay({ refunded_amount: { amount: '9.00', currency: 'usd' } }))).toMatchObject({ status: 'partially_refunded', refundedMinor: 900 });
  });

  it('keeps a sale whose money can’t be read at 0, and has no email without the permission', () => {
    expect(saleFromPayment('payment.succeeded', pay({ total: { amount: 'abc' }, customer_email: null }))).toMatchObject({ amountMinor: 0, amountOk: false, email: null });
    expect(saleFromPayment('payment.succeeded', pay({ metadata: { ylb_offer: 'short' } })).offerId).toBeNull();
    expect(saleFromPayment('payment.succeeded', { id: 'nope' })).toBeNull();
  });

  it('cleanEmail and paymentOf', () => {
    expect(cleanEmail('a@b')).toBeNull();
    expect(cleanEmail(`${'a'.repeat(250)}@b.co`)).toBeNull();
    expect(paymentOf({ payment: { id: 'pay_abc123' } })).toEqual({ paymentId: 'pay_abc123', payment: null });
    expect(paymentOf({ payment_id: 'pay_abc123' })).toEqual({ paymentId: 'pay_abc123', payment: null });
    expect(paymentOf({ payment: pay() }).payment.id).toBe('pay_abc123');
    expect(paymentOf({ payment_id: 'x' })).toBeNull();
  });
});
