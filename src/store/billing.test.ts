// The plan store and the billing actions (spec §B1, §B4): reading the plan (after sign-in, back from Checkout), the
// Checkout return address cleaned once, a plan chosen before signing up, Checkout and plan changes sent once per
// user action (the same request id after "try again in a minute"), and plan refusals opening the upgrade prompt.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getPlan: vi.fn(), getBusinesses: vi.fn(), startCheckout: vi.fn(), changePlan: vi.fn(), openPortal: vi.fn() }));
vi.mock('@/lib/integrations/api', async (orig) => ({ ...(await orig<typeof import('@/lib/integrations/api')>()), ...api }));
const confirm = vi.hoisted(() => ({ confirmAction: vi.fn(async (_req: { title: string; body?: string }) => true) }));
vi.mock('@/components/ui/primitives', async (orig) => ({ ...(await orig<typeof import('@/components/ui/primitives')>()), ...confirm }));

const { IntegrationApiError } = await import('@/lib/integrations/api');
const { useAuth } = await import('@/lib/cloud/auth');
const { useBillingConfig } = await import('@/lib/billing/config');
const { useUI } = await import('@/store/ui');
const { clearPlanIntent, hasLivePlan, readPlanIntent, savePlanIntent, takeCheckoutReturn, useBilling } = await import('./billing');
const { changeKind, changeRefusal, checkout, confirmPlanChange, setGoTo, upgradeTier } = await import('@/lib/billing/actions');
const { checkoutTotal } = await import('@/pages/plans/Plans');
const { showUpgrade } = await import('@/lib/billing/upgrade');

const PLAN = (over: Record<string, unknown> = {}) => ({
  billing: { enabled: true, enforce: true },
  plan: { plan: 'grow', active: true, paused: null, banner: null, tier: 'grow', businessLimit: 2, creditsPerMonth: 4500, creditWindow: null, features: { adsLaunch: true, video: { maxHeight: 1440, maxSeconds: 15 } }, pagesServeUntil: null, dataKeptUntil: null },
  account: { tier: 'grow', interval: 'month', status: 'active', source: 'stripe', currentPeriodEnd: '2026-12-01T00:00:00Z', cancelAtPeriodEnd: false, trialEndsAt: null, graceUntil: null, extraBusinesses: 1, pendingRemove: null, pendingDowngrade: null, hasCustomer: true },
  businesses: { limit: 2, used: 1, slots: [{ projectId: 'p1', state: 'active' }, { projectId: 'p2', state: 'locked', lockedReason: 'limit' }] },
  credits: { monthly: 4500, usedCredits: 120, resetsAt: '2026-12-01T00:00:00Z' },
  ...over,
});

const gone: string[] = [];
beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  confirm.confirmAction.mockReset().mockResolvedValue(true);
  useAuth.setState({ phase: 'ready' });
  useBillingConfig.setState({ enabled: true, enforce: true });
  useBilling.getState().reset();
  useUI.setState({ toasts: [] });
  gone.length = 0;
  setGoTo((url) => gone.push(url));
  api.getBusinesses.mockResolvedValue({ limit: 2, used: 1, extraBusinesses: 1, pricePerBusiness: { month: 9700, year: 97000 }, interval: 'month', slots: PLAN().businesses.slots, pendingRemove: null, op: null });
});
afterEach(() => vi.unstubAllGlobals());

describe('reading the plan', () => {
  it('reads the plan and the businesses, and answers slots left and locked businesses', async () => {
    api.getPlan.mockResolvedValue(PLAN());
    await useBilling.getState().refresh();
    const b = useBilling.getState();
    expect(b.plan?.plan).toBe('grow');
    expect(b.slotsLeft()).toBe(1);
    expect(b.isLocked('p2')).toBe(true);
    expect(b.isLocked('p1')).toBe(false);
    expect(b.credits?.usedCredits).toBe(120);
  });

  it('passes the Checkout Session the user came back from', async () => {
    api.getPlan.mockResolvedValue(PLAN());
    await useBilling.getState().refresh({ sessionId: 'cs_test_abc123' });
    expect(api.getPlan).toHaveBeenCalledWith('cs_test_abc123');
  });

  it('reads nothing signed out, without Stripe on the server, or in the artifact build', async () => {
    useAuth.setState({ phase: 'guest' });
    expect(await useBilling.getState().refresh()).toBeNull();
    useAuth.setState({ phase: 'ready' });
    useBillingConfig.setState({ enabled: false });
    expect(await useBilling.getState().refresh()).toBeNull();
    useBillingConfig.setState({ enabled: true });
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    expect(await useBilling.getState().refresh()).toBeNull();
    expect(api.getPlan).not.toHaveBeenCalled();
  });

  it('plans not enforced: no limit on slots', async () => {
    api.getPlan.mockResolvedValue(PLAN({ billing: { enabled: true, enforce: false } }));
    await useBilling.getState().refresh();
    expect(useBilling.getState().slotsLeft()).toBe(Infinity);
    expect(useBilling.getState().isLocked('p2')).toBe(false);
  });

  it('a live plan: paid statuses, a free plan while active, the owner', () => {
    const p = PLAN();
    expect(hasLivePlan(p.plan as never, p.account as never)).toBe(true);
    expect(hasLivePlan(p.plan as never, { ...p.account, status: 'canceled' } as never)).toBe(false);
    expect(hasLivePlan({ ...p.plan, active: true } as never, { ...p.account, source: 'comp' } as never)).toBe(true);
    expect(hasLivePlan({ ...p.plan, plan: 'owner' } as never, null)).toBe(true);
    expect(hasLivePlan(null, null)).toBe(false);
  });
});

describe('back from Stripe Checkout', () => {
  it('takes ?billing=success&session_id= once and cleans the address', () => {
    const replaced: string[] = [];
    vi.stubGlobal('location', { search: '?billing=success&session_id=cs_test_a1b2c3d4&utm=x', pathname: '/', hash: '#dashboard' });
    vi.stubGlobal('history', { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) });
    expect(takeCheckoutReturn()).toBe('cs_test_a1b2c3d4');
    expect(replaced).toEqual(['/?utm=x#dashboard']);
  });
  it('ignores an address without it, and a session id that isn’t one', () => {
    vi.stubGlobal('location', { search: '', pathname: '/', hash: '' });
    expect(takeCheckoutReturn()).toBeNull();
    vi.stubGlobal('location', { search: '?billing=success&session_id=%3Cscript%3E', pathname: '/', hash: '' });
    vi.stubGlobal('history', { replaceState: () => undefined });
    expect(takeCheckoutReturn()).toBeNull();
  });
});

describe('a plan chosen before signing up', () => {
  it('is kept for the session and read back once', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    savePlanIntent({ tier: 'scale', interval: 'year' });
    expect(readPlanIntent()).toEqual({ tier: 'scale', interval: 'year' });
    clearPlanIntent();
    expect(readPlanIntent()).toBeNull();
    store.set('ylb-plan-intent', '{"tier":"enterprise","interval":"month"}');
    expect(readPlanIntent()).toBeNull();
  });
  it('storage blocked: nothing breaks', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } });
    savePlanIntent({ tier: 'grow', interval: 'month' });
    expect(readPlanIntent()).toBeNull();
  });
});

describe('Checkout', () => {
  it('goes to Stripe’s page', async () => {
    api.startCheckout.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    expect(await checkout('grow', 'year')).toBe(true);
    expect(gone).toEqual(['https://checkout.stripe.com/c/pay/cs_test_1']);
    expect(api.startCheckout.mock.calls[0][0]).toMatchObject({ tier: 'grow', interval: 'year', clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it('“try again in a minute” (or a dropped connection): the next press is the same request; a definite refusal makes a new one', async () => {
    api.startCheckout.mockRejectedValueOnce(new IntegrationApiError(503, { error: 'Try again in a minute.', code: 'BILLING_PENDING' }));
    expect(await checkout('launch', 'month')).toBe(false);
    api.startCheckout.mockRejectedValueOnce(new IntegrationApiError(0, null, 'Couldn’t reach the app’s server. Check your connection and try again.'));
    expect(await checkout('launch', 'month')).toBe(false);
    api.startCheckout.mockRejectedValueOnce(new IntegrationApiError(400, { error: 'Refresh the page and try again.', code: 'BAD_REQUEST' }));
    expect(await checkout('launch', 'month')).toBe(false);
    api.startCheckout.mockResolvedValueOnce({ url: 'https://checkout.stripe.com/x' });
    await checkout('launch', 'month');
    const ids = api.startCheckout.mock.calls.map((c) => c[0].clientRequestId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[1]).toBe(ids[2]);
    expect(ids[3]).not.toBe(ids[2]);
    // Stripe's text never reaches the toast: only the server's own words
    expect(useUI.getState().toasts.map((t) => t.title)).toEqual(['Try again in a minute.', 'Couldn’t reach the app’s server. Check your connection and try again.', 'Refresh the page and try again.']);
  });

  it('already subscribed: says so and points to Settings › Plan', async () => {
    api.getPlan.mockResolvedValue(PLAN());
    api.startCheckout.mockRejectedValue(new IntegrationApiError(409, { error: 'You already have a plan. Change it in Settings › Plan.', code: 'ALREADY_SUBSCRIBED' }));
    expect(await checkout('scale', 'month')).toBe(false);
    expect(useUI.getState().toasts.at(-1)).toMatchObject({ title: 'You already have a plan. Change it in Settings › Plan.', action: { label: 'Open Plan' } });
    expect(gone).toEqual([]);
  });
});

describe('changing the plan', () => {
  it('knows upgrades, downgrades and the interval switches', () => {
    expect(changeKind('grow', 'month', 'grow', 'month')).toBe('same');
    expect(changeKind('launch', 'month', 'scale', 'month')).toBe('upgrade');
    expect(changeKind('scale', 'month', 'grow', 'month')).toBe('downgrade');
    expect(changeKind('grow', 'month', 'grow', 'year')).toBe('to_year');
    expect(changeKind('grow', 'year', 'grow', 'month')).toBe('to_month');
    expect(upgradeTier('grow', 'launch')).toBe('grow');
    expect(upgradeTier(undefined, 'grow')).toBe('scale');
    expect(upgradeTier(undefined, 'scale')).toBeNull();
  });

  it('asks first, sends once with the id made with the question, and reads the plan again', async () => {
    api.getPlan.mockResolvedValue(PLAN());
    await useBilling.getState().refresh();
    api.changePlan.mockResolvedValue({ ok: true, op: { id: 'o1', kind: 'change_plan', state: 'done' } });
    expect(await confirmPlanChange('scale', 'month')).toBe(true);
    expect(confirm.confirmAction).toHaveBeenCalledWith(expect.objectContaining({ title: 'Switch to Scale now?', body: expect.stringContaining('charged the prorated difference today') }));
    expect(api.changePlan).toHaveBeenCalledTimes(1);
    expect(api.changePlan.mock.calls[0][0]).toMatchObject({ tier: 'scale', interval: 'month', confirm: true });
    expect(useUI.getState().toasts.at(-1)?.title).toBe('You’re on Scale.');
  });

  it('a downgrade says it starts at renewal with no refund; cancelling the question sends nothing', async () => {
    api.getPlan.mockResolvedValue(PLAN());
    await useBilling.getState().refresh();
    confirm.confirmAction.mockResolvedValueOnce(false);
    expect(await confirmPlanChange('launch', 'month')).toBe(false);
    expect(confirm.confirmAction.mock.calls[0][0]).toMatchObject({ title: 'Switch to Launch at renewal?', body: expect.stringContaining('no refund') });
    expect(api.changePlan).not.toHaveBeenCalled();
  });

  it('a lower plan with yearly isn’t one step (yearly is charged now, a lower plan waits): nothing is sent', async () => {
    expect(changeKind('scale', 'month', 'launch', 'year')).toBe('down_to_year');
    api.getPlan.mockResolvedValue(PLAN());
    await useBilling.getState().refresh();
    expect(await confirmPlanChange('launch', 'year')).toBe(false);
    expect(confirm.confirmAction).not.toHaveBeenCalled();
    expect(api.changePlan).not.toHaveBeenCalled();
    expect(useUI.getState().toasts.at(-1)?.title).toContain('Launch monthly first');
  });

  it('while a downgrade waits: back up to the plan paid for is free; above it or to yearly isn’t one step', async () => {
    expect(changeRefusal('upgrade', 'grow', 'scale')).toBeNull();
    expect(changeRefusal('upgrade', 'scale', 'grow')).toContain('Switch back to it first');
    expect(changeRefusal('to_year', 'launch', 'scale')).toContain('then to yearly');
    // on Launch until renewal, Scale paid for: back to Grow says there's no charge
    api.getPlan.mockResolvedValue(PLAN({ plan: { ...PLAN().plan, tier: 'scale' }, account: { ...PLAN().account, tier: 'launch', pendingDowngrade: { tier: 'launch', at: '2026-12-01T00:00:00Z' } } }));
    await useBilling.getState().refresh();
    api.changePlan.mockResolvedValue({ ok: true, op: { id: 'o1', kind: 'change_plan', state: 'done' } });
    expect(await confirmPlanChange('grow', 'month')).toBe(true);
    expect(confirm.confirmAction.mock.calls[0][0]).toMatchObject({ title: 'Switch to Grow now?', body: expect.stringContaining('There’s no charge') });
  });

  it('Checkout with several businesses says the total', () => {
    expect(checkoutTotal('launch', 'month', 4)).toBe('You have 4 businesses: $388/month in total ($97 + 3 × $97).');
  });

  it('yearly → monthly isn’t self-serve; a declined card opens the prompt', async () => {
    api.getPlan.mockResolvedValue(PLAN({ account: { ...PLAN().account, interval: 'year' } }));
    await useBilling.getState().refresh();
    expect(await confirmPlanChange('grow', 'month')).toBe(false);
    expect(api.changePlan).not.toHaveBeenCalled();
    api.changePlan.mockRejectedValue(new IntegrationApiError(402, { error: 'Your card was declined. Update it in Billing, then try again.', code: 'CARD_DECLINED' }));
    expect(await confirmPlanChange('scale', 'year')).toBe(false);
    expect(useBilling.getState().upgrade).toMatchObject({ code: 'CARD_DECLINED' });
  });
});

describe('the upgrade prompt', () => {
  it('opens for each plan refusal with the server’s sentence, one at a time', () => {
    expect(showUpgrade({ code: 'CREDITS_USED', error: 'You’ve used this month’s AI credits. They renew on Dec 1.', resetsAt: '2026-12-01T00:00:00Z' })).toBe(true);
    expect(useBilling.getState().upgrade).toEqual({ code: 'CREDITS_USED', message: 'You’ve used this month’s AI credits. They renew on Dec 1.', resetsAt: '2026-12-01T00:00:00Z' });
    // a second refusal while one is open doesn't replace it
    showUpgrade({ code: 'PLAN_REQUIRED', error: 'x' });
    expect(useBilling.getState().upgrade?.code).toBe('CREDITS_USED');
    useBilling.getState().closeUpgrade();
    for (const code of ['PLAN_REQUIRED', 'PAYMENT_REQUIRED', 'BUSINESS_LIMIT', 'CARD_DECLINED', 'VIDEO_WEEK_LIMIT']) {
      expect(showUpgrade({ code, error: 'words', need: { feature: 'ads', tier: 'grow' } })).toBe(true);
      expect(useBilling.getState().upgrade).toMatchObject({ code, message: 'words' });
      useBilling.getState().closeUpgrade();
    }
  });

  it('ignores other errors, and everything when plans aren’t shown', () => {
    expect(showUpgrade({ code: 'RATE_LIMITED', error: 'slow down' })).toBe(false);
    useBillingConfig.setState({ enabled: false });
    expect(showUpgrade({ code: 'PLAN_REQUIRED', error: 'x' })).toBe(false);
    expect(useBilling.getState().upgrade).toBeNull();
  });
});
