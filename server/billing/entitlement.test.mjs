// Entitlement (spec §A5, C1.2): the table of plans and statuses, a downgrade keeping the old tier until the period
// ends, credit windows (monthly periods, yearly and free plans anchored on a day, day 31 in February), and the
// Stripe client's rules (secrets masked, one-shot writes, test bases only with test keys).
import { describe, expect, it, vi } from 'vitest';
import { anchoredWindow, entitlementOf, pausedError } from './entitlement.mjs';
import { StripeError, createStripeClient, encodeForm, stripeMode } from './stripeClient.mjs';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const DAY = 86_400_000;
const ON = { enforce: true };
const at = (d) => new Date(NOW + d * DAY).toISOString();
const acct = (over = {}) => ({ source: 'stripe', tier: 'grow', interval: 'month', status: 'active', business_limit: 1, current_period_start: at(-10), current_period_end: at(20), created_at: at(-40), ...over });

describe('entitlementOf', () => {
  it('is legacy (nothing gated) while plans are not enforced, and owner for the admin or an owner row', () => {
    expect(entitlementOf(null, { enforce: false }, NOW)).toMatchObject({ plan: 'legacy', active: true, paused: null, creditsPerMonth: null, businessLimit: null, features: { adsLaunch: true } });
    expect(entitlementOf(null, ON, NOW, { isAdmin: true })).toMatchObject({ plan: 'owner', active: true, businessLimit: null, creditsPerMonth: null });
    expect(entitlementOf(acct({ source: 'owner', tier: 'owner' }), ON, NOW)).toMatchObject({ plan: 'owner', active: true });
  });

  it('a new sign-up has no plan (paused, no banner) but setup’s one-off AI allowance; an ended one says so and gets none', () => {
    expect(entitlementOf(null, ON, NOW)).toMatchObject({ plan: 'none', active: false, paused: 'plan', banner: null, starter: true, creditsPerMonth: 200, creditWindow: { start: '2020-01-01T00:00:00.000Z', resetsAt: null }, features: { adsLaunch: false } });
    // a billing row made later (a Checkout that was abandoned) never moves the start: what setup used before it counts
    const fresh = entitlementOf(acct({ tier: 'none', status: 'none', created_at: '2026-11-10T15:00:00Z' }), ON, NOW);
    expect(fresh).toMatchObject({ starter: true, creditsPerMonth: 200, creditWindow: { start: '2020-01-01T00:00:00.000Z', resetsAt: null } });
    expect(entitlementOf(acct({ tier: 'none', status: 'canceled', ended_at: at(-1) }), ON, NOW)).toMatchObject({ plan: 'none', banner: 'plan_ended', starter: false, creditsPerMonth: 0 });
    // a free plan that ended, or a subscription that never finished: no allowance either
    expect(entitlementOf(acct({ source: 'comp', tier: 'none', status: 'expired' }), ON, NOW)).toMatchObject({ starter: false, creditsPerMonth: 0 });
    expect(entitlementOf(acct({ tier: 'none', status: 'none', stripe_subscription_id: 'sub_123456' }), ON, NOW)).toMatchObject({ starter: false, creditsPerMonth: 0 });
  });

  it('a 7-day card trial: the chosen tier’s features, the trial’s 300 credits for the whole trial, days left, ending soon in the last 3 days', () => {
    const t = entitlementOf(acct({ tier: 'scale', status: 'trialing', current_period_start: at(-2), current_period_end: at(5), trial_ends_at: at(5) }), ON, NOW);
    expect(t).toMatchObject({ plan: 'scale', active: true, trial: true, trialDaysLeft: 5, banner: 'trial', creditsPerMonth: 300, creditWindow: { start: at(-2), resetsAt: at(5) }, features: { adsLaunch: true, videosPerWeek: null } });
    expect(entitlementOf(acct({ status: 'trialing', trial_ends_at: at(2.5) }), ON, NOW)).toMatchObject({ banner: 'trial_ending', trialDaysLeft: 3 });
    // cancelled during the trial: it says so (no charge on day 8)
    expect(entitlementOf(acct({ status: 'trialing', trial_ends_at: at(4), cancel_at_period_end: true }), ON, NOW)).toMatchObject({ banner: 'cancel_at_period_end', trial: true });
    // after the trial (active): the tier's own credits again
    expect(entitlementOf(acct({ tier: 'scale', status: 'active', trial_ends_at: at(-1) }), ON, NOW)).toMatchObject({ trial: false, creditsPerMonth: 7500, banner: null });
  });

  it.each([
    ['active', {}, { active: true, paused: null, banner: null }],
    ['trialing (ends in 3 days)', { status: 'trialing', trial_ends_at: at(3) }, { active: true, banner: 'trial_ending' }],
    ['cancel at period end', { cancel_at_period_end: true }, { active: true, banner: 'cancel_at_period_end' }],
    ['past_due inside grace', { status: 'past_due', grace_until: at(2) }, { active: true, banner: 'grace', paused: null }],
    ['past_due after grace', { status: 'past_due', grace_until: at(-1) }, { active: false, paused: 'payment', banner: 'payment', businessLimit: 1 }],
    ['unpaid', { status: 'unpaid', business_limit: 3 }, { active: false, paused: 'payment', businessLimit: 1 }],
    ['paused', { status: 'paused' }, { active: false, paused: 'payment' }],
    ['incomplete', { status: 'incomplete' }, { active: false, paused: 'plan', banner: null }],
    ['canceled', { status: 'canceled', ended_at: at(-5) }, { active: false, paused: 'plan', banner: 'plan_ended', pagesServeUntil: at(25), dataKeptUntil: at(85) }],
    ['incomplete_expired', { status: 'incomplete_expired' }, { active: false, paused: 'plan', banner: 'plan_ended' }],
    ['comp active', { source: 'comp', status: 'trialing', comp_until: at(20), trial_ends_at: at(20) }, { active: true, banner: null }],
    ['comp ending soon', { source: 'comp', status: 'trialing', comp_until: at(5), trial_ends_at: at(5) }, { active: true, banner: 'trial_ending' }],
    ['comp expired', { source: 'comp', status: 'trialing', comp_until: at(-1) }, { active: false, paused: 'plan', banner: 'plan_ended', pagesServeUntil: at(29) }],
    ['comp with no end', { source: 'comp', status: 'active', comp_until: null }, { active: true }],
  ])('%s', (_, over, want) => {
    expect(entitlementOf(acct(over), ON, NOW)).toMatchObject(want);
  });

  it('past due after grace keeps its business limit (slots stay), and paused accounts get no credits', () => {
    const e = entitlementOf(acct({ status: 'past_due', grace_until: at(-1), business_limit: 3 }), ON, NOW);
    expect(e.businessLimit).toBe(3);
    expect(e.creditsPerMonth).toBe(0);
    expect(pausedError(e)[1]).toBe('PAYMENT_REQUIRED');
    expect(pausedError(entitlementOf(null, ON, NOW))[1]).toBe('PLAN_REQUIRED');
  });

  it('a downgrade keeps the old tier until tier_keep_until, then the new one', () => {
    const before = entitlementOf(acct({ tier: 'launch', tier_keep: 'scale', tier_keep_until: at(5) }), ON, NOW);
    expect(before).toMatchObject({ tier: 'scale', plan: 'scale', creditsPerMonth: 7500, features: { adsLaunch: true } });
    const after = entitlementOf(acct({ tier: 'launch', tier_keep: 'scale', tier_keep_until: at(-1) }), ON, NOW);
    expect(after).toMatchObject({ tier: 'launch', creditsPerMonth: 1500, features: { adsLaunch: false, video: { maxSeconds: 10, maxHeight: 768 } } });
  });

  it('credits: the tier plus 1,000 per business above the first; the window is the monthly period', () => {
    const e = entitlementOf(acct({ business_limit: 3 }), ON, NOW);
    expect(e.creditsPerMonth).toBe(3500 + 2000);
    expect(e.creditWindow).toEqual({ start: at(-10), resetsAt: at(20) });
    expect(e.features).toMatchObject({ leadEmailsPerMonth: 150, publicListings: 15, customDomains: 3, platformFeePct: 1, promptControl: 'style_notes', treg: { monthlyMicro: 8_000_000 } });
  });

  it('yearly and free plans use monthly windows anchored on a day, clamped to the month (day 31 in February)', () => {
    const y = entitlementOf(acct({ interval: 'year', billing_anchor: '2026-01-31T09:00:00Z' }), ON, Date.parse('2026-02-20T00:00:00Z'));
    expect(y.creditWindow).toEqual({ start: '2026-01-31T00:00:00.000Z', resetsAt: '2026-02-28T00:00:00.000Z' });
    expect(anchoredWindow('2026-01-31T09:00:00Z', Date.parse('2026-03-01T00:00:00Z'))).toEqual({ start: '2026-02-28T00:00:00.000Z', resetsAt: '2026-03-31T00:00:00.000Z' });
    expect(anchoredWindow('2025-12-15T00:00:00Z', Date.parse('2026-01-10T00:00:00Z'))).toEqual({ start: '2025-12-15T00:00:00.000Z', resetsAt: '2026-01-15T00:00:00.000Z' });
    const comp = entitlementOf(acct({ source: 'comp', status: 'trialing', comp_until: at(10), created_at: '2026-10-03T08:00:00Z', interval: null }), ON, NOW);
    expect(comp.creditWindow).toEqual({ start: '2026-11-03T00:00:00.000Z', resetsAt: '2026-12-03T00:00:00.000Z' });
  });
});

describe('the Stripe client', () => {
  it('knows the mode of a key, and encodes Stripe’s bracket form', () => {
    expect([stripeMode('sk_live_x'), stripeMode('rk_live_x'), stripeMode('sk_test_x'), stripeMode('pk_test_x'), stripeMode('')]).toEqual(['live', 'live', 'test', null, null]);
    expect(decodeURIComponent(encodeForm({ items: [{ id: 'si_1', quantity: 2 }], metadata: { a: 'b' } }))).toBe('items[0][id]=si_1&items[0][quantity]=2&metadata[a]=b');
  });

  it('refuses STRIPE_API_BASE with a live key, never shows the key, and needs an Idempotency-Key for every write', async () => {
    const live = createStripeClient({ env: { STRIPE_SECRET_KEY: 'sk_live_abcdefghijklmnop1234', STRIPE_API_BASE: 'http://127.0.0.1:1' } });
    expect(live.enabled).toBe(false);
    expect(live.baseRefused).toBe(true);
    expect(live.keyMask).toBe('…1234');
    const fetchSpy = vi.fn();
    const test = createStripeClient({ env: { STRIPE_SECRET_KEY: 'sk_test_abcdefghijklmnop5678', STRIPE_API_BASE: 'http://127.0.0.1:1' }, fetch: fetchSpy });
    await expect(test.post('/v1/customers', { email: 'x' })).rejects.toThrow(/Idempotency-Key/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a write is tried once: a 5xx or a dropped connection is unknown, a 402 is a card failure; reads retry once', async () => {
    const answers = [];
    const fetchImpl = vi.fn(async () => {
      const a = answers.shift();
      if (a === 'throw') throw new Error('socket hang up');
      return new Response(JSON.stringify(a.body), { status: a.status });
    });
    const c = createStripeClient({ env: { STRIPE_SECRET_KEY: 'sk_test_abcdefghijklmnop5678', STRIPE_API_BASE: 'http://stripe.test' }, fetch: fetchImpl, readRetryDelayMs: 1 });
    answers.push({ status: 500, body: { error: { type: 'api_error', message: 'raw stripe text' } } });
    expect(await c.post('/v1/x', {}, { idempotencyKey: 'k1' })).toMatchObject({ outcome: 'unknown' });
    answers.push('throw');
    expect(await c.post('/v1/x', {}, { idempotencyKey: 'k2' })).toMatchObject({ outcome: 'unknown' });
    answers.push({ status: 402, body: { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'raw stripe text' } } });
    const card = await c.post('/v1/x', {}, { idempotencyKey: 'k3' });
    expect(card).toMatchObject({ outcome: 'failed', status: 402 });
    expect(card.error).toBeInstanceOf(StripeError);
    expect(card.error).toMatchObject({ kind: 'card', code: 'card_declined', declineCode: 'insufficient_funds' });
    expect(card.error.message).not.toContain('raw stripe text');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const sent = fetchImpl.mock.calls.map(([, init]) => init.headers['idempotency-key']);
    expect(sent).toEqual(['k1', 'k2', 'k3']);
    answers.push({ status: 503, body: {} }, { status: 200, body: { id: 'sub_1' } });
    expect(await c.get('/v1/subscriptions/sub_1')).toEqual({ id: 'sub_1' });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});
