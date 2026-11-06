// scripts/stripe-setup.mjs (spec §A3.2, C1.14) against mock Stripe: a dry run lists what's missing and changes
// nothing, --apply creates the 4 products and 8 prices once, a second run is all ok, a price that differs exits 1
// without changes, a live key needs --live, and the key never shows.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSetup } from '../../scripts/stripe-setup.mjs';
import { createMockStripe, TEST_STRIPE_KEY } from '../test/mock-stripe.mjs';

let mock;
let lines;
const out = (l) => lines.push(String(l));
const env = () => ({ STRIPE_SECRET_KEY: TEST_STRIPE_KEY, STRIPE_API_BASE: mock.apiBase });
const writes = () => mock.calls.filter((c) => c.method && c.method !== 'GET');

beforeEach(async () => {
  mock = await createMockStripe().start();
  lines = [];
});
afterEach(() => mock.close());

describe('stripe:setup', () => {
  it('dry run: lists the 8 lookup keys as missing and writes nothing', async () => {
    const r = await runSetup({ args: [], env: env(), out });
    expect(r.code).toBe(1);
    expect(r.rows).toHaveLength(8);
    expect(r.rows.every((x) => x.state === 'missing (dry run)')).toBe(true);
    expect(writes()).toHaveLength(0);
    expect(lines[0]).toContain('mode: test');
    expect(lines[0]).toContain(`…${TEST_STRIPE_KEY.slice(-4)}`);
    expect(lines.join('\n')).not.toContain(TEST_STRIPE_KEY);
  });

  it('--apply creates 4 products and 8 prices with idempotency keys; a second run is all ok and writes nothing', async () => {
    const r = await runSetup({ args: ['--apply'], env: env(), out });
    expect(r.code).toBe(0);
    expect(r.rows.map((x) => x.state)).toEqual(Array(8).fill('created'));
    expect([...mock.realm('').products.keys()].sort()).toEqual(['ylb_additional_business', 'ylb_grow', 'ylb_launch', 'ylb_scale']);
    const prices = [...mock.realm('').prices.values()];
    expect(prices.find((p) => p.lookup_key === 'ylb_grow_yearly')).toMatchObject({ unit_amount: 197000, currency: 'usd', recurring: { interval: 'year' }, product: 'ylb_grow', metadata: { ylb: '1' } });
    expect(writes().every((c) => /^ylb-setup-(product|price)-/.test(c.idempotencyKey))).toBe(true);
    const n = writes().length;
    lines = [];
    const again = await runSetup({ args: ['--apply'], env: env(), out });
    expect(again.code).toBe(0);
    expect(again.rows.every((x) => x.state === 'ok')).toBe(true);
    expect(writes()).toHaveLength(n);
  });

  it('a price that differs: MISMATCH and exit 1, nothing changed (unless --replace --apply)', async () => {
    await runSetup({ args: ['--apply'], env: env(), out });
    const grow = [...mock.realm('').prices.values()].find((p) => p.lookup_key === 'ylb_grow_monthly');
    grow.unit_amount = 18_700;
    lines = [];
    const n = writes().length;
    const r = await runSetup({ args: ['--apply'], env: env(), out });
    expect(r.code).toBe(1);
    expect(r.rows.find((x) => x.lookupKey === 'ylb_grow_monthly')).toMatchObject({ state: 'MISMATCH', have: { amount: 18_700 }, want: { amount: 19_700 } });
    expect(writes()).toHaveLength(n);
    const fixed = await runSetup({ args: ['--apply', '--replace'], env: env(), out });
    expect(fixed.code).toBe(0);
    expect([...mock.realm('').prices.values()].find((p) => p.lookup_key === 'ylb_grow_monthly').unit_amount).toBe(19_700);
  });

  it('refuses a live key without --live, and STRIPE_API_BASE with anything but a test key', async () => {
    const live = await runSetup({ args: ['--apply'], env: { STRIPE_SECRET_KEY: 'sk_live_not_real_0000000000000000' }, out });
    expect(live.code).toBe(2);
    expect(lines.join('\n')).toMatch(/--live/);
    expect(lines.join('\n')).not.toContain('sk_live_not_real_0000000000000000');
    const base = await runSetup({ args: ['--apply', '--live'], env: { STRIPE_SECRET_KEY: 'sk_live_not_real_0000000000000000', STRIPE_API_BASE: mock.apiBase }, out });
    expect(base.code).toBe(2);
    expect(mock.calls).toHaveLength(0);
    expect((await runSetup({ env: {}, out })).code).toBe(2);
  });

  it('--apply --portal makes one Customer Portal configuration with plan and quantity changes off', async () => {
    const r = await runSetup({ args: ['--apply', '--portal'], env: env(), out });
    expect(r.portal).toMatch(/^bpc_/);
    const config = mock.realm('').portalConfigs.get(r.portal);
    expect(config.features).toMatchObject({ subscription_update: { enabled: 'false' }, subscription_cancel: { enabled: 'true', mode: 'at_period_end' }, payment_method_update: { enabled: 'true' } });
    await runSetup({ args: ['--apply', '--portal'], env: env(), out });
    expect(mock.realm('').portalConfigs.size).toBe(1);
  });
});
