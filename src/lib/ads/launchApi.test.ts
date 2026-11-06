// The ads calls: each goes to its route with the right method and body; a write is one request (never retried,
// even after a network error or a 502); a write without a definite answer is "may have happened"; following a
// job only GETs our own job route. fetch is stubbed: nothing here reaches a server.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cloud/auth', async (original) => ({ ...(await original<typeof import('@/lib/cloud/auth')>()), authHeaders: async () => ({ authorization: 'Bearer test-session' }) }));

const api = await import('./launchApi');
const fmt = await import('./launchFormat');
const { AdsApiError, setAdsBase } = api;

const BASE = 'https://app.test';

function stub(status: number, body: unknown) {
  const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', f);
  return f;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setAdsBase(null);
});

describe('ads API calls', () => {
  it('send each call to its route with the sign-in', async () => {
    setAdsBase(BASE);
    const cases: [() => Promise<unknown>, string, string, unknown][] = [
      [() => api.getAdAccounts('p1', 'meta'), 'GET', '/api/ads/accounts?projectId=p1&platform=meta', undefined],
      [() => api.chooseAdAccount('p1', 'google', 'adacct_x'), 'PUT', '/api/ads/accounts/choice', { projectId: 'p1', platform: 'google', adAccountRef: 'adacct_x' }],
      [() => api.searchTargeting('p1', 'meta', 'geo', 'Austin'), 'GET', '/api/ads/targeting/search?projectId=p1&platform=meta&dimension=geo&q=Austin', undefined],
      [() => api.getCampaigns('p1'), 'GET', '/api/ads/campaigns?projectId=p1', undefined],
      [() => api.refreshCampaigns('p1'), 'POST', '/api/ads/campaigns/refresh', { projectId: 'p1' }],
      [() => api.getAdJob('j/1'), 'GET', '/api/ads/jobs/j%2F1', undefined],
      [() => api.checkAdJob('j1'), 'POST', '/api/ads/jobs/j1/check', {}],
      [() => api.getAdAudit({ projectId: 'p1', before: 40 }), 'GET', '/api/ads/audit?projectId=p1&before=40', undefined],
      [() => api.getLiveAds('google'), 'GET', '/api/ads/live?platform=google', undefined],
      [() => api.previewChange('c1', { action: 'budget', dailyBudget: 40 }), 'POST', '/api/ads/campaigns/c1/change/preview', { action: 'budget', dailyBudget: 40 }],
      [() => api.launchAds('tok', 'req-1'), 'POST', '/api/ads/launch', { reviewToken: 'tok', confirm: true, clientRequestId: 'req-1' }],
      [() => api.changeAds('c1', 'tok', 'req-2'), 'POST', '/api/ads/campaigns/c1/change', { reviewToken: 'tok', confirm: true, clientRequestId: 'req-2' }],
      [() => api.putAdLimits('*', { maxDaily: 80 }), 'PUT', '/api/ads/admin/limits/defaults', { maxDaily: 80 }],
      [() => api.putAdLimits('cust_1', { adsEnabled: true }), 'PUT', '/api/ads/admin/limits/cust_1', { adsEnabled: true }],
      [() => api.pauseAll('cust_1', 'tok'), 'POST', '/api/ads/admin/customers/cust_1/pause-all', { reviewToken: 'tok', confirm: true }],
    ];
    for (const [run, method, path, body] of cases) {
      const f = stub(200, {});
      await run();
      expect(f).toHaveBeenCalledTimes(1);
      const [url, init] = f.mock.calls[0];
      expect(url).toBe(`${BASE}${path}`);
      expect(init?.method).toBe(method);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-session');
      expect(init?.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(body);
    }
  });

  it('a launch that can’t reach the server is one request and reads as “may have happened”', async () => {
    setAdsBase(BASE);
    const f = vi.fn(async () => {
      throw new TypeError('network down');
    });
    vi.stubGlobal('fetch', f);
    const err = await api.launchAds('tok', 'req-1').catch((e) => e);
    expect(err).toBeInstanceOf(AdsApiError);
    expect(err.code).toBe('NETWORK');
    expect(err.uncertain).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a gateway error is uncertain; a refusal keeps the server’s code and is not', async () => {
    setAdsBase(BASE);
    stub(502, { error: 'Bad gateway', code: 'UNAVAILABLE' });
    const gw = await api.changeAds('c1', 'tok', 'r').catch((e) => e);
    expect(gw.uncertain).toBe(true);
    const f = stub(409, { error: 'This campaign was changed in Ads Manager since you looked. Review it again.', code: 'LIVE_CHANGED' });
    const e = await api.changeAds('c1', 'tok', 'r').catch((x) => x);
    expect(e.code).toBe('LIVE_CHANGED');
    expect(e.uncertain).toBe(false);
    expect(e.message).toContain('Review it again');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('ADS_LIVE carries the list of campaigns that keep running', async () => {
    setAdsBase(BASE);
    stub(409, { error: 'These campaigns are still on…', code: 'ADS_LIVE', live: [{ id: 'c1', name: 'Spring', platform: 'meta', daily: 25, currency: 'USD', idTail: '1234' }] });
    const e = await api.getLiveAds().catch((x) => x);
    expect(e.live).toHaveLength(1);
  });
});

describe('followAdJob', () => {
  it('only reads the job route until it settles, and never checks or resends', async () => {
    const states = ['sending', 'sending', 'unknown'] as const;
    let i = 0;
    const read = vi.fn(async (id: string) => ({ job: { id, kind: 'launch' as const, platform: 'meta' as const, state: states[Math.min(i++, 2)], message: '', requestedAt: '' } }));
    const last = await api.followAdJob('j1', { read, intervalMs: 1, maxMs: 1000 });
    expect(last?.state).toBe('unknown');
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.every(([id]) => id === 'j1')).toBe(true);
  });

  it('the default reader is a GET on /api/ads/jobs/:id', async () => {
    setAdsBase(BASE);
    const f = stub(200, { job: { id: 'j1', kind: 'pause', platform: 'google', state: 'done', message: 'Done', requestedAt: '' } });
    await api.followAdJob('j1', { intervalMs: 1 });
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe(`${BASE}/api/ads/jobs/j1`);
    expect(f.mock.calls[0][1]?.method).toBe('GET');
  });
});

describe('money words', () => {
  it('format in the account’s own currency, never $ for a EUR account', () => {
    expect(fmt.money(25, 'USD')).toBe('$25.00');
    expect(fmt.money(25, 'EUR')).toBe('€25.00');
    expect(fmt.money(25, 'EUR')).not.toContain('$');
    expect(fmt.money(2500, 'JPY')).toBe('¥2,500');
  });
  it('the run text names the last day and the time zone', () => {
    expect(fmt.runsText('2026-12-01', 14, 'America/Chicago')).toBe('Runs 14 days: Tue 1 Dec 2026 to Mon 14 Dec 2026, ending 23:59 America/Chicago');
  });
});
