// The Stripe client's Stripe-Account option (P6 Connect): sent as the header on reads and writes, checked by shape
// before anything is sent, and never a reason to drop the Idempotency-Key rule. Against a recording fetch: no network.
import { describe, expect, it } from 'vitest';
import { createStripeClient } from './stripeClient.mjs';

const KEY = 'sk_test_client_000000000000000000';

function recorder(status = 200, body = { id: 'x', object: 'thing' }) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: { ...init.headers } });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch };
}

describe('createStripeClient { account }', () => {
  it('sends Stripe-Account on GET, POST and DELETE when asked, and not otherwise', async () => {
    const r = recorder();
    const stripe = createStripeClient({ env: { STRIPE_SECRET_KEY: KEY, STRIPE_API_BASE: 'http://127.0.0.1:9' }, fetch: r.fetch });
    await stripe.get('/v1/checkout/sessions/cs_test_1', {}, { account: 'acct_abc123XYZ' });
    await stripe.post('/v1/checkout/sessions', { mode: 'payment' }, { idempotencyKey: 'k1', account: 'acct_abc123XYZ' });
    await stripe.del('/v1/things/x', {}, { idempotencyKey: 'k2', account: 'acct_abc123XYZ' });
    await stripe.get('/v1/accounts/acct_abc123XYZ');
    expect(r.calls.map((c) => c.headers['stripe-account'])).toEqual(['acct_abc123XYZ', 'acct_abc123XYZ', 'acct_abc123XYZ', undefined]);
    expect(r.calls[1].headers['idempotency-key']).toBe('k1');
  });

  it('a malformed account throws before fetch (GET and POST)', async () => {
    const r = recorder();
    const stripe = createStripeClient({ env: { STRIPE_SECRET_KEY: KEY, STRIPE_API_BASE: 'http://127.0.0.1:9' }, fetch: r.fetch });
    for (const account of ['', 'acct_', 'acct_ab', 'cus_abc12345', 'acct_abc123\r\nx-evil: 1', 42]) {
      await expect(stripe.get('/v1/x', {}, { account })).rejects.toThrow(/acct_/);
      await expect(stripe.post('/v1/x', {}, { idempotencyKey: 'k', account })).rejects.toThrow(/acct_/);
    }
    expect(r.calls).toHaveLength(0);
  });

  it('a write on a connected account still needs an Idempotency-Key', async () => {
    const r = recorder();
    const stripe = createStripeClient({ env: { STRIPE_SECRET_KEY: KEY, STRIPE_API_BASE: 'http://127.0.0.1:9' }, fetch: r.fetch });
    await expect(stripe.post('/v1/checkout/sessions', {}, { account: 'acct_abc123XYZ' })).rejects.toThrow(/Idempotency-Key/);
    expect(r.calls).toHaveLength(0);
  });
});
