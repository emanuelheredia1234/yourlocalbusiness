// Settings › Payments › Get paid with Stripe, drawn once per state (as on the server: no effects run): the setup form
// behind the seller terms, confirming, onboarding, restricted, active, rejected; the fee line by tier and for the
// owner; never a full Stripe account id; Payments without it in the claude.ai build.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import type { ConnectAccount, ConnectState } from '@/lib/stripeConnect';
import type { OffersConfig } from '@/lib/offers';
import { StripeConnectView, defaultCountry, type ConnectActions } from './StripeConnectCard';
import { showStripeCard } from './PaymentsSection';

const noop = async () => {};
const actions: ConnectActions = { create: noop, continueSetup: noop, refresh: noop, setTax: noop, stop: noop };
const ACCOUNT: ConnectAccount = { id: 'RRRRRRRRRRRRRRRRRRRRRR', environment: 'production', status: 'active', country: 'US', defaultCurrency: 'usd', displayName: 'Maya Bakes', chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, due: { now: 0, pastDue: 0, later: 0, pending: 0 }, deadline: null, disabledReason: null, taxEnabled: false, taxStatus: null, payoutFailedAt: null, accountLast4: 'h9Zq' };
const STATE: ConnectState = { available: true, environment: 'production', account: null, fee: { pct: 3, tier: 'launch' }, termsUrl: '/seller-terms', termsVersion: '2026-11-18', termsReady: true, countries: ['US', 'GB', 'BR'] };
const wrap = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(TooltipProvider, null, el));
const render = (state: ConnectState | null, extra: Partial<Parameters<typeof StripeConnectView>[0]> = {}) => wrap(createElement(StripeConnectView, { state, actions, ...extra }));
const acct = (over: Partial<ConnectAccount>) => ({ ...STATE, account: { ...ACCOUNT, ...over } });

afterEach(() => vi.unstubAllGlobals());

describe('Get paid with Stripe', () => {
  it('none: the seller’s own Stripe account, the country, and the button locked until the terms are ticked', () => {
    const html = render(STATE);
    expect(html).toContain('Get paid with Stripe');
    expect(html).toContain('Buyers pay you through your own Stripe account.');
    expect(html).toContain('If you already have one, sign in with the same email during setup.');
    expect(html).toMatch(/<select id="stripe-country"/);
    expect(html).toContain('United Kingdom');
    expect(html).toMatch(/href="\/seller-terms" target="_blank" rel="noopener noreferrer"[^>]*>Seller terms/);
    expect(html).toMatch(/<button type="button" class="btn btn-primary btn-sm" disabled="">Get paid with Stripe/);
    // nothing promised about reusing an existing account
    expect(html).not.toMatch(/connect your existing/i);
  });

  it('not open to this user (the seller terms a draft): “opens soon”, never the setup form or the terms box', () => {
    const html = render({ ...STATE, available: false, termsReady: false });
    expect(html).toContain('Selling with Stripe opens soon.');
    expect(html).not.toMatch(/<select id="stripe-country"/);
    expect(html).not.toContain('Seller terms');
    expect(html).not.toMatch(/btn-primary[^>]*>Get paid with Stripe/);
  });

  it('the fee line: the seller’s tier marked; the owner pays none', () => {
    const launch = render(STATE);
    expect(launch).toContain('Stripe’s fees come out of your Stripe balance. Our fee is');
    expect(launch).toMatch(/<span class="font-semibold text-ink">3%<\/span> on Launch/);
    expect(launch).toContain('1% on Grow');
    expect(launch).toContain('0% on Scale');
    expect(render({ ...STATE, fee: { pct: 1, tier: 'grow' } })).toMatch(/<span class="font-semibold text-ink">1%<\/span> on Grow/);
    expect(render({ ...STATE, fee: { pct: 3, tier: 'none' } })).toContain('Without a plan, sales pay Launch’s rate.');
    const owner = render({ ...STATE, fee: { pct: 0, tier: 'owner' } });
    expect(owner).toContain('No platform fee.');
    expect(owner).not.toContain('on Launch');
    expect(render({ ...STATE, fee: { pct: 0, tier: 'legacy' } })).toContain('No platform fee.');
  });

  it('confirming: a spinner, then Refresh status after the polling ends', () => {
    expect(render(acct({ status: 'unknown' }))).toContain('Confirming your Stripe account…');
    const ended = render(acct({ status: 'creating' }), { pollEnded: true });
    expect(ended).toContain('Stripe hasn’t confirmed your account yet.');
    expect(ended).toContain('Refresh status');
  });

  it('onboarding: Continue setup (a button, never a link to copy)', () => {
    const html = render(acct({ status: 'onboarding', chargesEnabled: false }));
    expect(html).toContain('Finish setting up Stripe');
    expect(html).toContain('It takes about 5 minutes.');
    expect(html).toMatch(/<button[^>]*>.*Continue setup/);
    expect(html).not.toContain('connect.stripe.com');
  });

  it('restricted: what Stripe needs and by when; past due pauses payments', () => {
    const html = render(acct({ status: 'restricted', chargesEnabled: false, due: { now: 2, pastDue: 1, later: 0, pending: 0 }, deadline: '2026-11-20T12:00:00.000Z', disabledReason: 'requirements.past_due' }));
    expect(html).toContain('Stripe needs more information');
    expect(html).toContain('3 items, due Nov 20');
    expect(html).toContain('Payments are paused until you finish.');
    expect(html).toContain('Continue setup');
    // plain words only
    expect(html).not.toMatch(/KYC|application fee/i);
  });

  it('active: receiving payments, payouts, the last 4 only, the Dashboard, Stripe Tax, stop selling', () => {
    const html = render(acct({}));
    expect(html).toContain('Receiving payments');
    expect(html).toContain('Payouts: On');
    expect(html).toContain('Maya Bakes · United States · …h9Zq');
    expect(html).not.toContain('acct_');
    expect(html).toMatch(/href="https:\/\/dashboard\.stripe\.com\/" target="_blank" rel="noopener noreferrer"/);
    expect(html).toContain('Stripe Tax');
    expect(html).toContain('Stripe may charge you for Stripe Tax.');
    expect(html).toContain('Refresh status');
    expect(html).toContain('Stop selling with Stripe here');
    expect(render(acct({ payoutsEnabled: false }))).toContain('Payouts: Paused by Stripe');
  });

  it('Test mode: the badge and the test Dashboard', () => {
    const html = render({ ...acct({ environment: 'sandbox' }), environment: 'sandbox' });
    expect(html).toContain('Test mode');
    expect(html).toContain('https://dashboard.stripe.com/test/');
  });

  it('rejected: contact Stripe support, and stop selling', () => {
    const html = render(acct({ status: 'rejected', chargesEnabled: false, disabledReason: 'rejected.fraud' }));
    expect(html).toContain('Stripe can’t support this account. Contact Stripe support.');
    expect(html).toContain('Stop selling with Stripe here');
  });

  it('stopped: the setup form again, with a note that the Stripe account stays theirs', () => {
    const html = render(STATE, { stopped: true });
    expect(html).toContain('You stopped selling with Stripe here. Your Stripe account is still yours');
    expect(html).toContain('Get paid with Stripe');
  });

  it('the default country is the browser’s region when Stripe supports it', () => {
    expect(defaultCountry(['US', 'GB'], 'en-GB')).toBe('GB');
    expect(defaultCountry(['US', 'GB'], 'pt-BR')).toBe('US');
  });

  it('Payments shows the card only where Stripe is on and signed in, never in the claude.ai build', () => {
    const on: OffersConfig = { enabled: true, whop: { sandbox: false, production: false }, stripe: { available: true, environment: 'production' }, reachable: true };
    expect(showStripeCard(on, true)).toBe(true);
    expect(showStripeCard(on, false)).toBe(false);
    expect(showStripeCard({ ...on, stripe: { available: false, environment: null } }, true)).toBe(false);
    expect(showStripeCard(null, true)).toBe(false);
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    expect(showStripeCard(on, true)).toBe(false);
  });
});
