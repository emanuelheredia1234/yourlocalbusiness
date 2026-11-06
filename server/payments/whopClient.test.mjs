// The Whop client against the mock: our own error codes for each Whop failure, writes tried once whatever happens,
// the pinned version header, and the key never in an error.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockWhop } from '../test/mock-whop.mjs';
import { WHOP_API_VERSION_DATE, createWhopClient, mapWhopError, retryAfterFrom, whopErrorType } from './whopClient.mjs';
import { errorBody } from '../integrations/common.mjs';

const KEY = 'whop_test_key_never_shown_0123456789';
const ACCT = 'biz_client1234';

describe('whopClient', () => {
  let mock;
  let plan;
  const client = (over = {}) => createWhopClient({ environment: 'sandbox', key: KEY, base: mock.apiBase, ...over });
  beforeAll(async () => {
    mock = await createMockWhop({ environment: 'sandbox' }).start();
    mock.addKey(KEY, ACCT, ['access_pass:basic:read', 'plan:basic:read', 'checkout_configuration:create']);
    plan = mock.seed(ACCT, [{ title: 'Course', plans: [{ initial_price: 49 }] }])[0].plans[0];
  });
  afterAll(() => mock.close());

  it('reads with the key and the pinned version date', async () => {
    const page = await client().list('products.list', '/products', { account_id: ACCT, first: 1 });
    expect(page.data).toHaveLength(1);
    expect(mock.calls.at(-1)).toMatchObject({ apiVersionDate: WHOP_API_VERSION_DATE });
  });

  it('maps Whop’s failures to our codes, with no Whop text and no key', async () => {
    const codeOf = async (p) => p.then(() => null, (e) => e);
    const bad = await codeOf(createWhopClient({ environment: 'sandbox', key: 'wrong_key_0123456789abcdef', base: mock.apiBase }).read('products.list', '/products', { account_id: ACCT }));
    expect(bad.code).toBe('WHOP_KEY_REJECTED');
    mock.addKey('narrow_key_0123456789abcdef', ACCT, []);
    const perm = await codeOf(createWhopClient({ environment: 'sandbox', key: 'narrow_key_0123456789abcdef', base: mock.apiBase }).read('variants.list', '/variants', { account_id: ACCT }));
    expect(perm.code).toBe('WHOP_PERMISSION');
    expect(perm.extra).toEqual({ missing: 'plan:basic:read' });
    const other = await codeOf(client().read('products.list', '/products', { account_id: 'biz_other99' }));
    expect(other.code).toBe('WHOP_NOT_FOUND');
    mock.rateLimit('GET /products');
    const busy = await codeOf(client().read('products.list', '/products', { account_id: ACCT }));
    expect(busy.code).toBe('WHOP_BUSY');
    expect(busy.extra.retryAfter).toBe(12);
    for (const e of [bad, perm, other, busy]) {
      const { body } = errorBody(e);
      expect(JSON.stringify(body)).not.toMatch(/Invalid API key|Missing permission|Try again in 12|not found\./i);
      expect(JSON.stringify(body)).not.toContain(KEY);
      expect(e.message).not.toContain(KEY);
    }
  });

  it('tries a write once: a 5xx and a dropped connection are unknown, never sent again', async () => {
    const body = { account_id: ACCT, variant_id: plan.id, metadata: { ylb_offer: 'a'.repeat(22) } };
    const before = mock.writes('POST /checkout_configurations').length;
    mock.fail('POST /checkout_configurations', { status: 503 });
    expect(await client().write('checkout.create', 'POST', '/checkout_configurations', body, { idempotencyKey: 'ylb-offer-1' })).toEqual({ outcome: 'unknown', reason: 'upstream' });
    mock.fail('POST /checkout_configurations', { timeout: true });
    expect((await client().write('checkout.create', 'POST', '/checkout_configurations', body, { idempotencyKey: 'ylb-offer-2' })).outcome).toBe('unknown');
    expect(mock.writes('POST /checkout_configurations').length - before).toBe(2);
    // the dropped one was made: the same key answers it, marked as a replay
    const again = await client().write('checkout.create', 'POST', '/checkout_configurations', body, { idempotencyKey: 'ylb-offer-2' });
    expect(again).toMatchObject({ outcome: 'ok', replayed: true });
    expect(again.value.id).toMatch(/^ch_/);
  });

  it('a slow write times out as unknown; a request still running is unknown; 422 and 429 are definite', async () => {
    const body = { account_id: ACCT, variant_id: plan.id };
    mock.hold();
    const slow = await client({ writeTimeoutMs: 100 }).write('checkout.create', 'POST', '/checkout_configurations', body, { idempotencyKey: 'ylb-offer-3' });
    expect(slow).toEqual({ outcome: 'unknown', reason: 'timeout' });
    expect(await client().write('checkout.create', 'POST', '/checkout_configurations', body, { idempotencyKey: 'ylb-offer-3' })).toEqual({ outcome: 'unknown', reason: 'in_progress' });
    mock.release();
    const refused = await client().write('checkout.create', 'POST', '/checkout_configurations', { account_id: ACCT, variant_id: 'plan_nothere1' }, { idempotencyKey: 'ylb-offer-4' });
    expect(refused).toMatchObject({ outcome: 'failed', status: 422 });
    expect(refused.error.code).toBe('WHOP_REFUSED');
    mock.rateLimit('POST /checkout_configurations');
    const busy = await client().write('checkout.create', 'POST', '/checkout_configurations', body, { idempotencyKey: 'ylb-offer-5' });
    expect(busy.error.code).toBe('WHOP_BUSY');
  });

  it('reads the error type defensively and the wait as digits only', () => {
    expect(whopErrorType({ error: { code: 'insufficient_scope' } })).toBe('insufficient_scope');
    expect(whopErrorType({ error: { type: 'x y' } })).toBe('');
    expect(whopErrorType('nope')).toBe('');
    expect(retryAfterFrom('Try again in 999 seconds.')).toBe(120);
    expect(retryAfterFrom('soon')).toBe(60);
    expect(mapWhopError(500, null).code).toBe('WHOP_UNAVAILABLE');
    expect(mapWhopError(403, { error: { code: 'insufficient_scope' } }, 'unknown.op').extra).toEqual({});
  });
});
