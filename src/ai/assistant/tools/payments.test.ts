// The assistant and payments (P6): reads run at once and never show a Stripe id beyond its last 4 or any address;
// making a Stripe buy link asks on a card first (price and our fee); setting up Stripe only opens Settings › Payments,
// and Continue setup is the owner's own click; refunds, disputes and payouts are never done here; none of it in the
// claude.ai build.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectAccount, ConnectState } from '@/lib/stripeConnect';

const conn = vi.hoisted(() => ({ connectStatus: vi.fn(), onboardingLink: vi.fn() }));
vi.mock('@/lib/stripeConnect', async (orig) => ({ ...(await orig<typeof import('@/lib/stripeConnect')>()), ...conn }));
const off = vi.hoisted(() => ({ createStripeOffer: vi.fn(), listOffers: vi.fn(), whopConnections: vi.fn(), salesSummary: vi.fn(), listSales: vi.fn() }));
vi.mock('@/lib/offers', async (orig) => ({ ...(await orig<typeof import('@/lib/offers')>()), ...off }));
const files = vi.hoisted(() => ({ listLeadFiles: vi.fn() }));
vi.mock('@/lib/leadFiles', async (orig) => ({ ...(await orig<typeof import('@/lib/leadFiles')>()), ...files }));

const { useOffers } = await import('@/store/offers');
const { answerCard, pressButton } = await import('@/store/assistant');
const { fakeHost, runTool, seedWorkspace, testChat, TEST_PROJECT } = await import('../testing');
const { registry } = await import('.');
const { paymentToolsFor } = await import('./payments');
const { paymentExclusions, paymentsHere } = await import('./excluded');

const ACCOUNT: ConnectAccount = { id: 'RRRRRRRRRRRRRRRRRRRRRR', environment: 'production', status: 'active', country: 'US', defaultCurrency: 'usd', displayName: 'Copper Kettle', chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, due: { now: 0, pastDue: 0, later: 0, pending: 0 }, deadline: null, disabledReason: null, taxEnabled: false, taxStatus: null, payoutFailedAt: null, accountLast4: 'h9Zq' };
const STATE: ConnectState = { available: true, environment: 'production', account: ACCOUNT, fee: { pct: 3, tier: 'launch' }, termsUrl: '/seller-terms', termsVersion: 'v1', termsReady: true, countries: ['US'] };
const OFFER_ID = 'SSSSSSSSSSSSSSSSSSSSSS';
const offer = { id: OFFER_ID, projectId: TEST_PROJECT, title: 'Spring class', priceDisplay: '$49', priceMinor: 4900, currency: 'usd', provider: 'stripe', status: 'active', environment: 'production', checkoutHost: 'checkout.stripe.com', delivery: { kind: 'none' }, clicks: 0, lastClickAt: null, sales: { count: 0, last: null }, createdAt: null, updatedAt: null, link: `https://app.test/b/${OFFER_ID}` };

async function pendingCard() {
  let id = '';
  await vi.waitFor(() => {
    const c = testChat().find((m) => m.role === 'card' && m.card?.state === 'pending');
    expect(c).toBeTruthy();
    id = c!.id;
  });
  return testChat().find((m) => m.id === id)!;
}
const noAddress = (v: unknown) => expect(JSON.stringify(v ?? null)).not.toMatch(/https?:\/\/|acct_/);

let host: ReturnType<typeof fakeHost>;
beforeEach(() => {
  seedWorkspace();
  for (const f of [...Object.values(conn), ...Object.values(off), ...Object.values(files)]) f.mockReset();
  conn.connectStatus.mockResolvedValue(STATE);
  off.listOffers.mockResolvedValue([offer]);
  off.whopConnections.mockResolvedValue([]);
  useOffers.getState().reset();
  useOffers.setState({ config: { enabled: true, whop: { sandbox: false, production: false }, stripe: { available: true, environment: 'production' }, reachable: true } });
  host = fakeHost();
});
afterEach(() => {
  host.restore();
  useOffers.getState().reset();
  useOffers.setState({ config: null });
  vi.unstubAllGlobals();
});

describe('payments tools', () => {
  it('get_payments_status: the account in words, our fee, the buy links; no ids beyond the last 4, no address', async () => {
    const r = await runTool('get_payments_status');
    expect(registry.get('get_payments_status')).toMatchObject({ class: 'R' });
    expect(r.result).toMatchObject({ stripe: { status: 'receiving payments', payouts: 'on', ourFee: '3% on Launch', account: '…h9Zq' }, stripeBuyLinks: 1 });
    noAddress(r.result);
  });

  it('start_stripe_setup opens Settings › Payments; an unfinished account gets Continue setup, the owner’s own click', async () => {
    conn.connectStatus.mockResolvedValue({ ...STATE, account: { ...ACCOUNT, status: 'restricted', chargesEnabled: false, due: { now: 2, pastDue: 0, later: 0, pending: 0 } } });
    conn.onboardingLink.mockResolvedValue('https://connect.stripe.com/setup/s/abc');
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    const r = await runTool('start_stripe_setup');
    expect(r.ok).toBe(true);
    expect(host.calls.pages).toEqual([['workspace-settings', 'payments']]);
    noAddress(r.result);
    // no link was asked for until the owner pressed the button
    expect(conn.onboardingLink).not.toHaveBeenCalled();
    const line = testChat().find((m) => m.role === 'activity' && m.tool === 'start_stripe_setup');
    const button = line?.buttons?.find((b) => b.label === 'Continue setup');
    expect(button).toBeTruthy();
    await pressButton(button!.id);
    expect(assign).toHaveBeenCalledWith('https://connect.stripe.com/setup/s/abc');
    // nothing in the chat carries the link
    expect(JSON.stringify(testChat())).not.toContain('connect.stripe.com');
  });

  it('create_stripe_offer asks on a card with the price and our fee; nothing is made without a yes', async () => {
    off.createStripeOffer.mockResolvedValue(offer);
    const run = runTool('create_stripe_offer', { title: 'Spring class', price: 49 });
    const c = await pendingCard();
    expect(c.card).toMatchObject({ title: 'Make a Stripe buy link for “Spring class”?', confirmLabel: 'Create buy link' });
    expect(c.card?.what).toContain('Buyer pays $49.00 · Our fee $1.47 (3% on Launch)');
    expect(c.card?.who).toContain('Nothing is charged now.');
    expect(off.createStripeOffer).not.toHaveBeenCalled();
    answerCard(c.id, false);
    expect(await run).toMatchObject({ ok: false, status: 'declined' });
    expect(off.createStripeOffer).not.toHaveBeenCalled();
  });

  it('on yes, makes it in minor units; the result has the {{buy:id}} token, never an address', async () => {
    off.createStripeOffer.mockResolvedValue(offer);
    const run = runTool('create_stripe_offer', { title: 'Spring class', price: 49.5, currency: 'usd' });
    answerCard((await pendingCard()).id, true);
    const r = await run;
    expect(r).toMatchObject({ ok: true, result: { id: OFFER_ID, provider: 'stripe' } });
    expect(off.createStripeOffer).toHaveBeenCalledWith(expect.objectContaining({ projectId: TEST_PROJECT, title: 'Spring class', priceMinor: 4950, currency: 'usd', delivery: { kind: 'none' } }));
    expect(JSON.stringify(r.result)).toContain(`{{buy:${OFFER_ID}}}`);
    noAddress(r.result);
  });

  it('no Stripe account: set it up first (no card); a file that isn’t a product file is refused', async () => {
    conn.connectStatus.mockResolvedValue({ ...STATE, account: null });
    const r = await runTool('create_stripe_offer', { title: 'X', price: 10 });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/start_stripe_setup/);
    expect(testChat().some((m) => m.role === 'card')).toBe(false);
    conn.connectStatus.mockResolvedValue(STATE);
    files.listLeadFiles.mockResolvedValue([]);
    const f = await runTool('create_stripe_offer', { title: 'X', price: 10, fileId: 'FFFFFFFFFFFFFFFFFFFFFF' });
    expect(f.error).toMatch(/product files/);
  });

  it('list_sales: count, revenue, refunds, disputes, our fees; buyer emails only when asked', async () => {
    off.salesSummary.mockResolvedValue({ days: 30, live: { count: 2, revenue: { usd: 9800 }, refunded: {} }, test: { count: 0 }, clicks: 5, offers: [] });
    const now = new Date().toISOString();
    off.listSales.mockResolvedValue({ sales: [{ id: 's1', offerId: OFFER_ID, projectId: TEST_PROJECT, status: 'paid', amountMinor: 4900, refundedMinor: 0, currency: 'usd', environment: 'production', buyerEmail: 'ann@example.com', paidAt: now, createdAt: now, provider: 'stripe', feeMinor: 147, feeReturnedMinor: 0 }, { id: 's2', offerId: OFFER_ID, projectId: TEST_PROJECT, status: 'disputed', amountMinor: 4900, refundedMinor: 0, currency: 'usd', environment: 'production', buyerEmail: 'bo@example.com', paidAt: now, createdAt: now, provider: 'stripe', feeMinor: 147, feeReturnedMinor: 0 }], next: null });
    const r = await runTool('list_sales');
    expect(r.result).toMatchObject({ sales: 2, revenue: '$98.00', disputes: 1, ourFees: '$2.94' });
    expect(JSON.stringify(r.result)).not.toContain('@example.com');
    const e = await runTool('list_sales', { emails: true });
    expect((e.result as { buyerEmails: string[] }).buyerEmails).toEqual(['ann@example.com', 'bo@example.com']);
  });

  it('refunds, disputes, payouts: never done here; Settings › Payments opens', async () => {
    const r = await runTool('stripe_money');
    expect(r).toMatchObject({ ok: false, status: 'refused' });
    expect(r.error).toContain('Stripe Dashboard');
    expect(host.calls.pages).toEqual([['workspace-settings', 'payments']]);
  });

  it('the claude.ai build: none of the payments tools, only a word on where they are', () => {
    expect(paymentToolsFor(true)).toEqual([]);
    expect(paymentToolsFor(false).map((t) => t.name)).toEqual(['get_payments_status', 'start_stripe_setup', 'create_stripe_offer', 'list_sales']);
    expect(paymentsHere.class).toBe('X');
    expect(paymentExclusions.every((t) => t.class === 'X')).toBe(true);
  });
});
