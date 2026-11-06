// @vitest-environment happy-dom
// #plans, Settings › Plan and the upgrade prompt, drawn with fixed data (spec §C2): both intervals and the annual
// saving, the cards' buttons for a visitor, a subscriber and the owner, "not available here" when plans are off or in
// the artifact build; the plan's states (active, grace, free trial, owner, a change being confirmed); and the prompt
// per refusal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

// nothing leaves the test: the plan reads wait forever (the stores are set by hand)
vi.mock('@/lib/integrations/api', async (orig) => ({ ...(await orig<typeof import('@/lib/integrations/api')>()), getPlan: vi.fn(() => new Promise(() => undefined)), getBusinesses: vi.fn(() => new Promise(() => undefined)) }));
vi.mock('@/components/ui/primitives', async (orig) => ({
  ...(await orig<typeof import('@/components/ui/primitives')>()),
  Modal: ({ title, children, footer }: { title?: ReactNode; children: ReactNode; footer?: ReactNode }) => createElement('section', { 'data-modal': '' }, createElement('h2', null, title), children, createElement('footer', null, footer)),
}));

const { TooltipProvider } = await import('@/components/ui/shadcn/tooltip');
const { useAuth } = await import('@/lib/cloud/auth');
const { useBillingConfig } = await import('@/lib/billing/config');
const { useBilling } = await import('@/store/billing');
const { useStore } = await import('@/store/useStore');
const { useSyncStatus } = await import('@/lib/cloud/sync');
const { PlanCards, usePlanActions, LaunchPaywall } = await import('./Plans');
const PlansPage = (await import('./Plans')).default;
const { PlanSection, statusChip } = await import('@/pages/settings/PlanSection');
const { UpgradePrompt } = await import('@/components/billing/UpgradePrompt');
const { PlanBanner } = await import('@/components/billing/PlanBanner');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Rendered in a real DOM (the stores' current state, not their first one), then unmounted. */
function html(el: ReturnType<typeof createElement>): string {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(TooltipProvider, null, el)));
  const out = host.innerHTML;
  act(() => root.unmount());
  host.remove();
  return out;
}

const ENT = (over: Record<string, unknown> = {}) => ({
  plan: 'grow',
  active: true,
  paused: null,
  banner: null,
  tier: 'grow',
  businessLimit: 2,
  creditsPerMonth: 4500,
  creditWindow: { start: '2026-11-01T00:00:00Z', resetsAt: '2026-12-01T00:00:00Z' },
  features: { adsLaunch: true, video: { maxHeight: 1440, maxSeconds: 15 }, treg: null, leadEmailsPerMonth: 150, publicListings: 15, customDomains: 3, platformFeePct: 1, promptControl: 'style_notes' },
  pagesServeUntil: null,
  dataKeptUntil: null,
  ...over,
});
const ACCT = (over: Record<string, unknown> = {}) => ({ tier: 'grow', interval: 'month', status: 'active', source: 'stripe', currentPeriodEnd: '2026-12-01T12:00:00Z', cancelAtPeriodEnd: false, trialEndsAt: null, graceUntil: null, extraBusinesses: 1, pendingRemove: null, pendingDowngrade: null, hasCustomer: true, ...over });
const BIZ = (over: Record<string, unknown> = {}) => ({ limit: 2, used: 2, extraBusinesses: 1, pricePerBusiness: { month: 9700, year: 97000 }, interval: 'month', slots: [{ projectId: 'p1', state: 'active' }, { projectId: 'p2', state: 'active', lockAt: '2026-12-01T12:00:00Z' }], pendingRemove: null, op: null, ...over });

function Cards({ interval }: { interval: 'month' | 'year' }) {
  const { action, busy } = usePlanActions(interval);
  return createElement(PlanCards, { interval, action, busy });
}

beforeEach(() => {
  useBillingConfig.setState({ enabled: true, enforce: true, trialDays: 0 });
  useAuth.setState({ phase: 'ready' });
  useBilling.getState().reset();
  useSyncStatus.getState().set({ held: [] });
  useStore.setState({ projects: [] });
});
afterEach(() => vi.unstubAllGlobals());

describe('#plans', () => {
  it('monthly: three cards with their prices, Grow most popular, the extra business price, and the comparison and FAQ', () => {
    useAuth.setState({ phase: 'signed-out' });
    const out = html(createElement(PlansPage));
    for (const t of ['Launch', 'Grow', 'Scale', 'Most popular', '$97', '$197', '$397', '/month', 'Each extra business $97/mo · $970/yr', 'Compare plans', 'Questions', 'What is an AI credit?', 'Start with Grow', '2 months free', 'Sign in']) expect(out).toContain(t);
    expect(out).toContain('Launch ads from the app');
  });

  it('annual: the year’s price, the monthly equivalent and the saving', () => {
    useAuth.setState({ phase: 'signed-out' });
    const out = html(createElement(Cards, { interval: 'year' }));
    expect(out).toContain('$1,970');
    expect(out).toContain('/year');
    expect(out).toContain('save $394 a year');
  });

  it('signed in with a plan: Current plan, Switch to the others; the owner’s buttons are off', () => {
    useBilling.setState({ plan: ENT() as never, account: ACCT() as never });
    const out = html(createElement(Cards, { interval: 'month' }));
    expect(out).toContain('Current plan');
    expect(out).toContain('Switch to Scale');
    expect(out).toContain('Switch to Launch');
    expect(out).toContain('Starts at your next renewal.');
    useBilling.setState({ plan: ENT({ plan: 'owner', tier: 'owner' }) as never, account: null });
    expect(html(createElement(Cards, { interval: 'month' }))).toContain('Owner plan');
  });

  it('a yearly subscriber can’t switch to monthly here', () => {
    useBilling.setState({ plan: ENT() as never, account: ACCT({ interval: 'year' }) as never });
    expect(html(createElement(Cards, { interval: 'month' }))).toContain('Yearly to monthly happens at renewal: contact support.');
  });

  it('not available without Stripe on the server, or in the artifact build', () => {
    useBillingConfig.setState({ enabled: false });
    expect(html(createElement(PlansPage))).toContain('Plans aren’t available here.');
    useBillingConfig.setState({ enabled: true });
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    const out = html(createElement(PlansPage));
    expect(out).toContain('Plans aren’t available here.');
    expect(out).not.toContain('Start with');
  });
});

describe('Settings › Plan', () => {
  it('active: plan, price, renewal, credits meter, Change plan and Manage billing; businesses with an ending one', () => {
    useBilling.setState({ plan: ENT() as never, account: ACCT() as never, credits: { monthly: 4500, usedCredits: 1240, resetsAt: '2026-12-01T00:00:00Z' }, businesses: BIZ() as never });
    useStore.setState({ projects: [{ id: 'p1', brand: { name: 'Copper & Comb' } }, { id: 'p2', brand: { name: 'Second Shop' } }] as never });
    const out = html(createElement(PlanSection));
    for (const t of ['Grow', '$197/month', 'Next renewal', '1,240 of 4,500 credits used', 'Change plan', 'Manage billing', 'Active', '2 of 2 businesses', 'Copper &amp; Comb', 'Second Shop', 'Ends Dec', 'Add a business — $97/month', 'Remove one at renewal']) expect(out).toContain(t);
  });

  it('a failed payment in grace: the chip says until when', () => {
    const plan = ENT({ banner: 'grace', graceUntil: '2026-11-13T00:00:00Z' });
    expect(statusChip(plan as never, ACCT({ status: 'past_due' }) as never)).toEqual({ tone: 'warn', label: expect.stringContaining('Payment problem until Nov') });
    expect(statusChip(ENT({ paused: 'payment' }) as never, ACCT({ status: 'unpaid' }) as never).label).toBe('Payment needed');
    expect(statusChip(ENT() as never, ACCT({ cancelAtPeriodEnd: true }) as never).label).toContain('Cancels');
    expect(statusChip(ENT({ plan: 'none', active: false, paused: 'plan' }) as never, null).label).toBe('No plan');
  });

  it('a free trial (existing account): Free Grow until <date>, pick a plan; nothing to add or remove', () => {
    useBilling.setState({ plan: ENT() as never, account: ACCT({ source: 'comp', interval: null, compUntil: '2026-12-06T00:00:00Z', hasCustomer: false }) as never, businesses: BIZ() as never });
    const out = html(createElement(PlanSection));
    expect(out).toContain('Free Grow until Dec');
    expect(out).toContain('Pick a plan to keep going.');
    expect(out).not.toContain('Add a business —');
    expect(out).not.toContain('Manage billing');
  });

  it('the owner: Owner plan — unlimited', () => {
    useBilling.setState({ plan: ENT({ plan: 'owner', tier: 'owner', businessLimit: null, creditsPerMonth: null }) as never, account: ACCT({ tier: 'owner', source: 'owner' }) as never });
    const out = html(createElement(PlanSection));
    expect(out).toContain('Owner plan — unlimited');
    expect(out).not.toContain('Businesses');
  });

  it('a change being confirmed: says so, with Check again (never a resend)', () => {
    useBilling.setState({ plan: ENT() as never, account: ACCT() as never, businesses: BIZ({ op: { id: 'o1', kind: 'add_business', state: 'unknown' } }) as never });
    const out = html(createElement(PlanSection));
    expect(out).toContain('We’re confirming your last change…');
    expect(out).toContain('Check again');
  });

  it('a pending removal: when, and Undo', () => {
    useBilling.setState({ plan: ENT() as never, account: ACCT() as never, businesses: BIZ({ pendingRemove: { count: 1, at: '2026-12-01T12:00:00Z' } }) as never });
    const out = html(createElement(PlanSection));
    expect(out).toContain('One business will be removed on Dec');
    expect(out).toContain('Undo');
    expect(out).not.toContain('Remove one at renewal');
  });

  it('a project the plan has no slot for: named, with Add a business and Remove from this device', () => {
    useBilling.setState({ plan: ENT() as never, account: ACCT() as never, businesses: BIZ() as never });
    useStore.setState({ projects: [{ id: 'p9', brand: { name: 'Held Bakery' } }] as never });
    useSyncStatus.getState().set({ held: ['p9'] });
    const out = html(createElement(PlanSection));
    expect(out).toContain('Held Bakery');
    expect(out).toContain('isn’t saved to your account: your plan has no free business slot.');
    expect(out).toContain('Remove from this device');
  });
});

describe('the upgrade prompt', () => {
  const show = (code: string, extra: Record<string, unknown> = {}) => {
    useBilling.setState({ upgrade: { code, message: 'The server’s sentence.', ...extra } as never });
    return html(createElement(UpgradePrompt));
  };

  it('PLAN_REQUIRED on a paid plan: the needed tier and Upgrade to it', () => {
    useBilling.setState({ plan: ENT({ plan: 'launch', tier: 'launch' }) as never, account: ACCT({ tier: 'launch' }) as never });
    const out = show('PLAN_REQUIRED', { need: { feature: 'ads', tier: 'grow' } });
    expect(out).toContain('The server’s sentence.');
    expect(out).toContain('Upgrade to Grow');
    expect(out).toContain('$197/month');
  });

  it('PLAN_REQUIRED without a plan: See plans', () => {
    const out = show('PLAN_REQUIRED');
    expect(out).toContain('See plans');
    expect(out).not.toContain('Upgrade to');
  });

  it('PAYMENT_REQUIRED and CARD_DECLINED: Update card', () => {
    expect(show('PAYMENT_REQUIRED')).toContain('Update card');
    expect(show('CARD_DECLINED')).toContain('Update card');
  });

  it('CREDITS_USED: when they renew, own keys, add a business on a paid plan', () => {
    useBilling.setState({ plan: ENT() as never, account: ACCT() as never });
    const out = show('CREDITS_USED', { resetsAt: '2026-12-01T12:00:00Z' });
    expect(out).toContain('Your credits renew on Dec 1');
    expect(out).toContain('Use my own AI keys');
    expect(out).toContain('Add a business');
  });

  it('BUSINESS_LIMIT: Add a business on a paid plan', () => {
    useBilling.setState({ plan: ENT() as never, account: ACCT() as never });
    expect(show('BUSINESS_LIMIT')).toContain('Add a business');
  });

  it('nothing when plans aren’t shown', () => {
    useBillingConfig.setState({ enabled: false });
    expect(show('PLAN_REQUIRED')).toBe('');
  });
});

describe('the plan banner', () => {
  it('grace: update the card by the date', () => {
    useBilling.setState({ plan: ENT({ banner: 'grace', graceUntil: '2026-11-13T12:00:00Z' }) as never, account: ACCT({ status: 'past_due' }) as never });
    const out = html(createElement(PlanBanner));
    expect(out).toContain('Your payment didn’t go through. Update your card by Nov 13 to keep everything running.');
    expect(out).toContain('Update card');
  });
  it('plan ended: see plans; nothing when there’s no banner', () => {
    useBilling.setState({ plan: ENT({ banner: 'plan_ended', active: false, paused: 'plan' }) as never, account: ACCT({ status: 'canceled' }) as never });
    expect(html(createElement(PlanBanner))).toContain('Your plan has ended.');
    useBilling.setState({ plan: ENT() as never });
    expect(html(createElement(PlanBanner))).toBe('');
  });
});

describe('the 7-day card trial and the paywall after setup (P1c)', () => {
  const NONE = (over: Record<string, unknown> = {}) => ENT({ plan: 'none', tier: 'none', active: false, paused: 'plan', banner: null, starter: true, creditsPerMonth: 200, creditWindow: { start: '2020-01-01T00:00:00.000Z', resetsAt: null }, ...over });

  it('#plans for a visitor: “Start 7-day free trial” with what happens on day 8, and the trial in the FAQ', () => {
    useAuth.setState({ phase: 'signed-out' });
    useBillingConfig.setState({ trialDays: 7 });
    const out = html(createElement(PlansPage));
    expect(out).toContain('Start 7-day free trial');
    expect(out).toContain('Free for 7 days, then $197/month. Cancel any time before day 8 and you pay nothing.');
    expect(out).toContain('Try any plan free for 7 days.');
    expect(out).toContain('How does the free trial work?');
    expect(out).not.toContain('Start with Grow');
  });

  it('signed in with no plan: the server’s offer wins (no trial once one was used)', () => {
    useBillingConfig.setState({ trialDays: 7 });
    useBilling.setState({ plan: NONE() as never, account: null, trial: { days: 7, eligible: true } });
    expect(html(createElement(Cards, { interval: 'month' }))).toContain('Start 7-day free trial');
    useBilling.setState({ trial: { days: 7, eligible: false } });
    const out = html(createElement(Cards, { interval: 'month' }));
    expect(out).toContain('Start with Grow');
    expect(out).not.toContain('free trial');
  });

  it('the Launch step’s paywall: the trial, the cards, and “Not now, look around first”', () => {
    useBillingConfig.setState({ trialDays: 7 });
    useBilling.setState({ plan: NONE() as never, account: null, trial: { days: 7, eligible: true } });
    const out = html(createElement(LaunchPaywall, { before: () => {}, onSkip: () => {} }));
    for (const t of ['Start your 7-day free trial', 'Nothing is charged for 7 days', 'Start 7-day free trial', 'Not now, look around first', 'publishing, posting, ads, AI video and connecting accounts wait for a plan']) expect(out).toContain(t);
  });

  it('Settings › Plan during a trial: days left, the price from the day it ends, Cancel trial; no plan yet: Start your free trial', () => {
    useBilling.setState({ plan: ENT({ trial: true, trialDaysLeft: 4, banner: 'trial', trialEndsAt: '2026-11-20T12:00:00Z', creditsPerMonth: 300 }) as never, account: ACCT({ status: 'trialing', trialing: true, trialEndsAt: '2026-11-20T12:00:00Z', currentPeriodEnd: '2026-11-20T12:00:00Z' }) as never, credits: { monthly: 300, usedCredits: 12, resetsAt: '2026-11-20T12:00:00Z' }, businesses: BIZ() as never });
    let out = html(createElement(PlanSection));
    for (const t of ['Free trial · 4 days left', '4 days left · $197/month from Nov 20', 'Cancel trial', 'during your trial']) expect(out).toContain(t);
    useBillingConfig.setState({ trialDays: 7 });
    useBilling.setState({ plan: NONE() as never, account: null, trial: { days: 7, eligible: true }, credits: { monthly: 200, usedCredits: 30, resetsAt: null }, businesses: BIZ({ limit: 1, used: 1, slots: [{ projectId: 'p1', state: 'active' }] }) as never });
    out = html(createElement(PlanSection));
    expect(out).toContain('Start 7-day free trial');
    expect(out).toContain('to set up (once, before a plan)');
    expect(out).not.toContain('Cancel plan');
  });

  it('cancelling: the chip says when, and Keep my plan replaces Cancel', () => {
    useBilling.setState({ plan: ENT({ banner: 'cancel_at_period_end' }) as never, account: ACCT({ cancelAtPeriodEnd: true }) as never, businesses: BIZ() as never });
    const out = html(createElement(PlanSection));
    expect(out).toContain('Cancels Dec 1, 2026');
    expect(out).toContain('Keep my plan');
    expect(out).not.toContain('Cancel plan');
  });

  it('a locked action before any plan: “Start your free trial”', () => {
    useBillingConfig.setState({ trialDays: 7 });
    useBilling.setState({ plan: NONE() as never, account: null, trial: { days: 7, eligible: true }, upgrade: { code: 'PLAN_REQUIRED', message: 'This needs a plan. Choose one to keep going.' } as never });
    const out = html(createElement(UpgradePrompt));
    expect(out).toContain('Start your free trial');
    expect(out).toContain('Start 7-day free trial');
    expect(out).toContain('nothing is charged until day 8');
  });

  it('the banners: no plan yet, the trial with days left, ending in its last days', () => {
    useBillingConfig.setState({ trialDays: 7 });
    useBilling.setState({ plan: NONE() as never, account: null, trial: { days: 7, eligible: true } });
    expect(html(createElement(PlanBanner))).toContain('You’re looking around for free.');
    useBilling.setState({ plan: ENT({ banner: 'trial', trial: true, trialDaysLeft: 5, trialEndsAt: '2026-11-20T12:00:00Z' }) as never, account: ACCT({ status: 'trialing', trialEndsAt: '2026-11-20T12:00:00Z' }) as never });
    expect(html(createElement(PlanBanner))).toContain('Free trial: 5 days left. Grow is $197/month from Nov 20 unless you cancel.');
    useBilling.setState({ plan: ENT({ banner: 'trial_ending', trial: true, trialDaysLeft: 2, trialEndsAt: '2026-11-20T12:00:00Z' }) as never });
    expect(html(createElement(PlanBanner))).toContain('Your free trial ends on Nov 20. Then Grow is $197/month. Cancel before then in Settings › Plan to pay nothing.');
  });
});
