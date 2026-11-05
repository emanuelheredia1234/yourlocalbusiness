// The typed integration calls: each goes to its route with the right method and body, a refusal keeps the
// server's code (and nextAt, period, the owner's hint), and nothing is sent twice. fetch is stubbed.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cloud/auth', async (original) => ({ ...(await original<typeof import('@/lib/cloud/auth')>()), authHeaders: async () => ({ authorization: 'Bearer test-session' }) }));

const api = await import('./api');
const { IntegrationApiError, setIntegrationsBase } = api;

const BASE = 'https://app.test';

function stub(status: number, body: unknown) {
  const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', f);
  return f;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setIntegrationsBase(null);
});

describe('integration API calls', () => {
  it('send each call to its route, with the sign-in and a JSON body', async () => {
    setIntegrationsBase(BASE);
    const cases: [() => Promise<unknown>, string, string, unknown][] = [
      [() => api.getConnections(), 'GET', '/api/integrations/connections', undefined],
      [() => api.connect('facebook'), 'POST', '/api/integrations/connections/facebook/connect', {}],
      [() => api.reconnect('linkedin'), 'POST', '/api/integrations/connections/linkedin/reconnect', {}],
      [() => api.checkConnection('x'), 'POST', '/api/integrations/connections/x/check', {}],
      [() => api.disconnect('youtube'), 'DELETE', '/api/integrations/connections/youtube', undefined],
      [() => api.getTargets('facebook'), 'GET', '/api/integrations/connections/facebook/targets', undefined],
      [() => api.setTarget('facebook', 't_1'), 'PUT', '/api/integrations/connections/facebook/target', { targetId: 't_1' }],
      [() => api.getJob('j/1'), 'GET', '/api/posting/jobs/j%2F1', undefined],
      [() => api.checkJob('j1'), 'POST', '/api/posting/jobs/j1/check', {}],
      [() => api.listJobs('p 1'), 'GET', '/api/posting/jobs?projectId=p+1', undefined],
      [() => api.refreshAnalytics('p1'), 'POST', '/api/analytics/refresh', { projectId: 'p1' }],
      [() => api.getRun('r1'), 'GET', '/api/analytics/runs/r1', undefined],
      [() => api.getSnapshots('p1'), 'GET', '/api/analytics/snapshots?projectId=p1', undefined],
      [() => api.saveAnalyticsSettings({ projectId: 'p1', keywords: ['bakery'] }), 'PUT', '/api/analytics/settings', { projectId: 'p1', keywords: ['bakery'] }],
      [() => api.publishSeoToGoogle('p1'), 'POST', '/api/seo/google/publish', { projectId: 'p1', confirm: true }],
      [() => api.getSeoGoogleStatus('p1'), 'GET', '/api/seo/google/status?projectId=p1', undefined],
      [() => api.getMyUsage(), 'GET', '/api/billing/me?days=30', undefined],
      [() => api.getCustomers(7), 'GET', '/api/billing/customers?days=7', undefined],
      [() => api.putCustomerCap('cust_x', { dailyCapMicro: 100 }), 'PUT', '/api/billing/customers/cust_x/cap', { dailyCapMicro: 100 }],
      [() => api.putDefaults({ status: 'active' }), 'PUT', '/api/billing/defaults', { status: 'active' }],
      [() => api.getReconcile(), 'GET', '/api/billing/reconcile?days=30', undefined],
    ];
    for (const [run, method, path, body] of cases) {
      const f = stub(200, {});
      await run();
      expect(f).toHaveBeenCalledTimes(1);
      const [url, init] = f.mock.calls[0];
      expect([path, url]).toEqual([path, `${BASE}${path}`]);
      expect(init?.method).toBe(method);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-session');
      expect(init?.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(body);
    }
    expect(api.invoiceCsvUrl('2026-11')).toBe(`${BASE}/api/billing/invoice.csv?month=2026-11`);
  });

  it('publish once, and keep the server’s refusal (no retry)', async () => {
    setIntegrationsBase(BASE);
    const f = stub(409, { error: 'Already posting.', code: 'ALREADY_PUBLISHING' });
    const req = { projectId: 'p1', postId: 'post1', platform: 'x' as const, confirm: true as const, clientRequestId: '6f1c1d1e-1111-4111-8111-111111111111', content: { text: 'Hi' } };
    const e = await api.publishPost(req).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(IntegrationApiError);
    expect(e).toMatchObject({ status: 409, code: 'ALREADY_PUBLISHING', message: 'Already posting.' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('carry nextAt, period and the owner’s hint; a network failure is NETWORK', async () => {
    setIntegrationsBase(BASE);
    stub(429, { error: 'Too soon.', code: 'REFRESH_TOO_SOON', nextAt: '2026-11-05T12:15:00Z' });
    await expect(api.refreshAnalytics('p1')).rejects.toMatchObject({ code: 'REFRESH_TOO_SOON', nextAt: '2026-11-05T12:15:00Z' });
    stub(429, { error: 'Limit.', code: 'CUSTOMER_CAP', period: 'day' });
    await expect(api.refreshAnalytics('p1')).rejects.toMatchObject({ code: 'CUSTOMER_CAP', period: 'day' });
    stub(503, { error: 'Not set up.', code: 'NOT_SET_UP', hint: 'Add TREG_TOKEN in Replit Secrets.' });
    await expect(api.getMyUsage()).rejects.toMatchObject({ code: 'NOT_SET_UP', hint: 'Add TREG_TOKEN in Replit Secrets.' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(api.getConnections()).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
  });
});
