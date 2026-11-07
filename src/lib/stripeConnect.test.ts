// The Stripe Connect client: what the browser keeps of the seller's account (never the full acct_ id), the
// onboarding link only when it is one of Stripe's own pages, the server's own words for its refusals, and the owner's
// view read defensively.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OffersError } from './offers';
import { connectStatus, createConnectAccount, disabledWords, dueWords, feeLabel, isStripeUrl, noFee, onboardingLink, saleDownloadLink, toConnectAccount, toConnectAdmin, toConnectState } from './stripeConnect';

const ROW = 'RRRRRRRRRRRRRRRRRRRRRR';
const ACCOUNT = { id: ROW, environment: 'sandbox', status: 'restricted', country: 'US', defaultCurrency: 'usd', displayName: 'Maya Bakes', chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: true, due: { now: 2, pastDue: 1, later: 4, pending: 0 }, deadline: '2026-11-20T00:00:00.000Z', disabledReason: 'requirements.past_due', taxEnabled: false, taxStatus: null, accountLast4: 'acct_1AbCdEfGh9Zq' };

function server(answers: Record<string, () => Response>) {
  const calls: { method: string; url: string; body?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      calls.push({ method, url: String(url), body: typeof init?.body === 'string' ? init.body : undefined });
      const answer = answers[`${method} ${path}`];
      return answer ? answer() : new Response(JSON.stringify({ error: 'nope' }), { status: 500 });
    }),
  );
  return calls;
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('Stripe Connect client', () => {
  it('keeps only the last 4 of the account id, counts of what is due, and drops what isn’t ours', () => {
    const a = toConnectAccount(ACCOUNT)!;
    expect(a.accountLast4).toBe('h9Zq');
    expect(a.due).toEqual({ now: 2, pastDue: 1, later: 4, pending: 0 });
    expect(a.environment).toBe('sandbox');
    expect(JSON.stringify(a)).not.toContain('acct_');
    expect(toConnectAccount({ id: 'nope' })).toBeNull();
    expect(toConnectAccount({ ...ACCOUNT, disabledReason: '<b>x</b>' })?.disabledReason).toBeNull();
  });

  it('the state: fee, terms and countries (the shared list when the server sends none)', () => {
    const s = toConnectState({ available: true, environment: 'production', account: null, fee: { pct: 3, tier: 'launch' }, termsUrl: '/seller-terms', termsVersion: '2026-11-18', termsReady: false });
    expect(s.fee).toEqual({ pct: 3, tier: 'launch' });
    expect(s.countries).toContain('US');
    expect(s.termsUrl).toBe('/seller-terms');
    // an address that isn't ours is never a terms link
    expect(toConnectState({ termsUrl: 'https://evil.test' }).termsUrl).toBe('/seller-terms');
  });

  it('words: what is due, why Stripe paused it, the fee', () => {
    expect(dueWords(toConnectAccount(ACCOUNT)!)).toMatch(/^3 items, due Nov (19|20)$/);
    expect(dueWords({ due: { now: 1, pastDue: 0, later: 0, pending: 0 }, deadline: null })).toBe('1 item');
    expect(disabledWords('requirements.past_due')).toMatch(/past due/);
    expect(disabledWords('rejected.fraud')).toBe('Stripe closed this account.');
    expect(disabledWords('something.new')).toMatch(/Stripe Dashboard says why/);
    expect(feeLabel({ pct: 3, tier: 'launch' })).toBe('3% on Launch');
    expect(feeLabel({ pct: 0, tier: 'owner' })).toBe('No platform fee');
    expect(noFee({ pct: 0, tier: 'scale' })).toBe(true);
    expect(feeLabel({ pct: 3, tier: 'none' })).toMatch(/no plan/);
  });

  it('an onboarding link goes only to Stripe’s own https pages', async () => {
    expect(isStripeUrl('https://connect.stripe.com/setup/s/abc')).toBe(true);
    expect(isStripeUrl('http://connect.stripe.com/setup')).toBe(false);
    expect(isStripeUrl('https://stripe.com.evil.test/x')).toBe(false);
    expect(isStripeUrl('https://user@connect.stripe.com/x')).toBe(false);
    server({ 'POST /api/payments/stripe/onboarding': json({ url: 'https://evil.test/phish' }) });
    await expect(onboardingLink()).rejects.toMatchObject({ code: 'BAD_ANSWER' });
    server({ 'POST /api/payments/stripe/onboarding': json({ url: 'https://connect.stripe.com/setup/s/abc' }) });
    await expect(onboardingLink()).resolves.toBe('https://connect.stripe.com/setup/s/abc');
  });

  it('create: sends the terms, the country and the request id; 202 is pending', async () => {
    const calls = server({ 'POST /api/payments/stripe': json({ account: { ...ACCOUNT, status: 'unknown' } }, 202) });
    const got = await createConnectAccount({ country: 'US', clientRequestId: '11111111-1111-4111-8111-111111111111' });
    expect(got.pending).toBe(true);
    expect(JSON.parse(calls[0].body!)).toEqual({ country: 'US', acceptTerms: true, clientRequestId: '11111111-1111-4111-8111-111111111111' });
  });

  it('refusals: Connect’s own sentence for NOT_SET_UP (opens soon), never Stripe’s', async () => {
    server({ 'GET /api/payments/stripe': json({ error: 'Selling with Stripe opens soon.', code: 'NOT_SET_UP' }, 503) });
    const e = await connectStatus().catch((x) => x);
    expect(e).toBeInstanceOf(OffersError);
    expect(e.message).toBe('Selling with Stripe opens soon.');
  });

  it('a seller’s download link must be a /b/<id>/file?t= link', async () => {
    server({ 'POST /api/offers/sales/11111111-1111-4111-8111-111111111111/download-link': json({ url: 'https://evil.test/x', expiresAt: null }) });
    await expect(saleDownloadLink('11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({ code: 'BAD_ANSWER' });
    server({ 'POST /api/offers/sales/11111111-1111-4111-8111-111111111111/download-link': json({ url: 'https://app.test/b/AAAAAAAAAAAAAAAAAAAAAA/file?t=abc.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', expiresAt: '2026-11-14T00:00:00.000Z' }) });
    await expect(saleDownloadLink('11111111-1111-4111-8111-111111111111')).resolves.toMatchObject({ expiresAt: '2026-11-14T00:00:00.000Z' });
    await expect(saleDownloadLink('../../x')).rejects.toMatchObject({ code: 'BAD_ID' });
  });

  it('the owner’s view is read defensively', () => {
    const v = toConnectAdmin({ setup: { environment: 'production', missing: ['STRIPE_CONNECT_WEBHOOK_SECRET', 'bad name'], publicUrlOk: true, connectEnabled: false }, accounts: { counts: { active: 2, bogus: 1 }, sellers: [{ customerTag: 'cust_x', status: 'restricted', last30: { count: 1, gross: { usd: 4900 }, fees: { usd: 147 } } }] }, fees: { currencies: { usd: { last30: { fees: 147, returned: 0, net: 147 } } }, returns: [{ sourceId: 're_1', state: 'unknown', amountMinor: 30 }] }, alerts: [{ kind: 'fee_return_failed', count: 2 }, { kind: 'Bad Kind' }] });
    expect(v.setup.missing).toEqual(['STRIPE_CONNECT_WEBHOOK_SECRET']);
    expect(v.setup.connectEnabled).toBe(false);
    expect(v.accounts.counts).toEqual({ active: 2 });
    expect(v.accounts.sellers[0].last30.gross).toEqual({ usd: 4900 });
    expect(v.fees.currencies.usd.monthToDate).toEqual({ fees: 0, returned: 0, net: 0 });
    expect(v.alerts.map((a) => a.kind)).toEqual(['fee_return_failed']);
  });
});
