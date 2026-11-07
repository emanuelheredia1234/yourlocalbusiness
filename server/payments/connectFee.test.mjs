// Our fee on a seller's sale (server/payments/connectFee.mjs) and the Connect settings (connectConfig.mjs): tables.
import { describe, expect, it } from 'vitest';
import { feeForEntitlement, feeShare, platformFee } from './connectFee.mjs';
import { connectConfig } from './connectConfig.mjs';
import { entitlementOf } from '../billing/entitlement.mjs';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const DAY = 86_400_000;
const on = { enforce: true };
const acct = (over = {}) => ({ user_id: 'u', tier: 'launch', source: 'stripe', status: 'active', business_limit: 1, current_period_start: new Date(NOW - DAY).toISOString(), current_period_end: new Date(NOW + 20 * DAY).toISOString(), ...over });

describe('platformFee', () => {
  it.each([
    // [amount, pct, fee]
    [100, 3, 3],
    [100, 1, 1],
    [100, 0, 0],
    [999, 3, 29], // floor(29.97)
    [999, 1, 9], // floor(9.99)
    [999, 0, 0],
    [4900, 3, 147],
    [4900, 1, 49],
    [4900, 0, 0],
    [33, 3, 0], // floor(0.99): left out
    [50, 1, 0],
  ])('$%s at %s%% is %s', (amountMinor, pct, fee) => {
    expect(platformFee({ amountMinor, pct }).fee).toBe(fee);
  });

  it('leaves out a fee of 0, one at or above the amount, a Brazilian seller, and bad input', () => {
    expect(platformFee({ amountMinor: 33, pct: 3 })).toEqual({ fee: 0, reason: 'zero' });
    expect(platformFee({ amountMinor: 100, pct: 100 })).toEqual({ fee: 0, reason: 'not_below_amount' });
    expect(platformFee({ amountMinor: 4900, pct: 3, sellerCountry: 'BR', platformCountry: 'US' })).toEqual({ fee: 0, reason: 'country' });
    expect(platformFee({ amountMinor: 4900, pct: 3, sellerCountry: 'BR', platformCountry: 'BR' })).toEqual({ fee: 147, reason: 'ok' });
    for (const bad of [{ amountMinor: 0, pct: 3 }, { amountMinor: -5, pct: 3 }, { amountMinor: 1.5, pct: 3 }, { amountMinor: 100, pct: -1 }, { amountMinor: 100, pct: 101 }, { amountMinor: '100', pct: NaN }]) expect(platformFee(bad).reason).toBe('bad_input');
  });
});

describe('feeForEntitlement (by plan state, from P1 entitlements)', () => {
  const fee = (a, s = on, opts = {}) => feeForEntitlement(entitlementOf(a, s, NOW, opts));
  it('owner 0, legacy (plans not enforced) 0', () => {
    expect(fee(null, on, { isAdmin: true })).toEqual({ pct: 0, tier: 'owner' });
    expect(fee(acct({ source: 'owner', tier: 'none' }))).toEqual({ pct: 0, tier: 'owner' });
    expect(fee(acct(), { enforce: false })).toEqual({ pct: 0, tier: 'legacy' });
  });
  it('the tiers 3/1/0; a comp plan and a card trial pay their tier; past due in grace pays its tier', () => {
    expect(fee(acct())).toEqual({ pct: 3, tier: 'launch' });
    expect(fee(acct({ tier: 'grow' }))).toEqual({ pct: 1, tier: 'grow' });
    expect(fee(acct({ tier: 'scale' }))).toEqual({ pct: 0, tier: 'scale' });
    expect(fee(acct({ tier: 'grow', source: 'comp', comp_until: null }))).toEqual({ pct: 1, tier: 'grow' });
    expect(fee(acct({ tier: 'scale', status: 'trialing', trial_ends_at: new Date(NOW + 3 * DAY).toISOString() }))).toEqual({ pct: 0, tier: 'scale' });
    expect(fee(acct({ tier: 'grow', status: 'past_due', grace_until: new Date(NOW + DAY).toISOString() }))).toEqual({ pct: 1, tier: 'grow' });
  });
  it('no plan, an ended plan or a paused one pays Launch’s 3', () => {
    expect(fee(null)).toEqual({ pct: 3, tier: 'none' });
    expect(fee(acct({ tier: 'scale', status: 'canceled', ended_at: new Date(NOW - DAY).toISOString() }))).toEqual({ pct: 3, tier: 'none' });
    expect(fee(acct({ tier: 'scale', status: 'unpaid' }))).toEqual({ pct: 3, tier: 'none' });
    expect(fee(acct({ tier: 'grow', status: 'past_due', grace_until: new Date(NOW - DAY).toISOString() }))).toEqual({ pct: 3, tier: 'none' });
  });
});

describe('feeShare', () => {
  it('is proportional with floor, capped at what’s left', () => {
    expect(feeShare({ feeMinor: 147, amountMinor: 4900, backMinor: 1000 })).toBe(30); // floor(30.0)
    expect(feeShare({ feeMinor: 29, amountMinor: 999, backMinor: 500 })).toBe(14); // floor(14.51)
    expect(feeShare({ feeMinor: 147, amountMinor: 4900, backMinor: 4900, returnedMinor: 100 })).toBe(47);
    expect(feeShare({ feeMinor: 147, amountMinor: 4900, backMinor: 9999 })).toBe(147);
    expect(feeShare({ feeMinor: 0, amountMinor: 4900, backMinor: 4900 })).toBe(0);
    expect(feeShare({ feeMinor: 147, amountMinor: 4900, backMinor: 0 })).toBe(0);
  });
});

describe('connectConfig', () => {
  const env = { STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_x', APP_PUBLIC_URL: 'https://app.example.test/x', CUSTOMER_TAG_SECRET: 'tag-secret-0123456789' };
  it('is on with the key and the Connect secret; off with STRIPE_CONNECT=off; names what’s missing, never values', () => {
    const c = connectConfig(env, { mode: 'test' });
    expect(c).toMatchObject({ enabled: true, ready: true, environment: 'sandbox', live: false, platformCountry: 'US', returnFees: true, downloadsPerSale: 10, downloadDays: 30, sessionsPerVisitorPerHour: 20, publicOrigin: 'https://app.example.test' });
    expect(connectConfig({ ...env, STRIPE_CONNECT: 'off' }, { mode: 'test' }).enabled).toBe(false);
    const none = connectConfig({}, { mode: null });
    expect(none.enabled).toBe(false);
    expect(none.missing()).toEqual(['STRIPE_SECRET_KEY', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'CUSTOMER_TAG_SECRET']);
    expect(JSON.stringify(none.missing())).not.toContain('whsec');
  });
  it('live mode needs an https APP_PUBLIC_URL to be ready', () => {
    expect(connectConfig({ ...env, APP_PUBLIC_URL: 'http://app.example.test' }, { mode: 'live' })).toMatchObject({ enabled: true, ready: false, environment: 'production' });
    expect(connectConfig({ ...env, APP_PUBLIC_URL: '' }, { mode: 'live' }).missing()).toEqual(['APP_PUBLIC_URL (https)']);
    expect(connectConfig(env, { mode: 'live' }).ready).toBe(true);
  });
  it('reads the numbers and switches', () => {
    const c = connectConfig({ ...env, CONNECT_RETURN_FEES: 'off', CONNECT_DOWNLOADS_PER_SALE: '3', CONNECT_DOWNLOAD_DAYS: 'x', STRIPE_PLATFORM_COUNTRY: 'br', STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS: 'whsec_old' }, { mode: 'test' });
    expect(c).toMatchObject({ returnFees: false, downloadsPerSale: 3, downloadDays: 30, platformCountry: 'BR', webhookSecrets: ['whsec_x', 'whsec_old'] });
  });
});
