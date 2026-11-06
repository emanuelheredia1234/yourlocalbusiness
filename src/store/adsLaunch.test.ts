// The launched-campaigns store: loading follows a sending job with GETs of our own job route only; nothing calls
// Check status by itself; a job update lands on its row; an automatic refresh is skipped within 5 minutes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cloud/auth', async (original) => ({ ...(await original<typeof import('@/lib/cloud/auth')>()), authHeaders: async () => ({ authorization: 'Bearer t' }) }));

const { setAdsBase } = await import('@/lib/ads/launchApi');
const { useAdsLaunch, mayBeOn } = await import('./adsLaunch');
import type { LaunchedCampaign } from '@/lib/ads/launchTypes';

const BASE = 'https://app.test';
const camp = (over: Partial<LaunchedCampaign> = {}): LaunchedCampaign => ({
  id: 'c1',
  planId: 'ad_1',
  projectId: 'p1',
  platform: 'meta',
  name: 'Spring',
  tag: 'YLB 0123456789ab',
  account: { name: 'Acme', idTail: '1234', currency: 'USD', timezone: 'America/Chicago' },
  state: 'launching',
  stateMessage: 'Launching…',
  review: { status: null, reasons: [] },
  daily: 25,
  start: '2026-12-01',
  end: '2026-12-14',
  launchedAs: 'PAUSED',
  configuredStatus: 'PAUSED',
  ...over,
});
const limits = { adsEnabled: true, currency: 'USD', maxDaily: 50, maxChange: 50, maxCampaignTotal: 750, launchesPerDay: 3, changesPerDay: 20, committedDaily: 0, liveCampaigns: 0, launchOpen: true };

beforeEach(() => {
  setAdsBase(BASE);
  useAdsLaunch.setState({ campaigns: {}, limits: {}, loadedAt: {}, refreshedAt: {}, loading: {}, error: {}, audit: {}, checkNotes: {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setAdsBase(null);
});

describe('adsLaunch store', () => {
  it('a sending job is followed with GETs of /api/ads/jobs/:id only; no check is ever made by itself', async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET' });
        if (url.includes('/api/ads/campaigns?')) return Response.json({ campaigns: [camp({ pendingJob: { id: 'j1', kind: 'launch', platform: 'meta', state: 'sending', message: 'Sending…', requestedAt: '' } })], limits });
        if (url.endsWith('/api/ads/jobs/j1')) return Response.json({ job: { id: 'j1', kind: 'launch', platform: 'meta', state: 'unknown', message: 'It may have happened - check status before trying again.', requestedAt: '' }, campaign: camp({ state: 'unknown', pendingJob: { id: 'j1', kind: 'launch', platform: 'meta', state: 'unknown', message: 'x', requestedAt: '' } }) });
        return new Response('{}', { status: 404 });
      }),
    );
    await useAdsLaunch.getState().load('p1');
    await useAdsLaunch.getState().follow('j1');
    expect(calls.some((c) => c.url.includes('/check'))).toBe(false);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(calls.filter((c) => c.url.endsWith('/api/ads/jobs/j1')).length).toBeGreaterThan(0);
    expect(useAdsLaunch.getState().campaigns.p1[0].state).toBe('unknown');
  });

  it('Check status is one POST to the check route, and its note is kept', async () => {
    const f = vi.fn(async () => Response.json({ job: { id: 'j1', kind: 'launch', platform: 'meta', state: 'unknown', message: 'x', requestedAt: '' }, campaign: camp({ state: 'unknown' }), note: { code: 'STILL_UNKNOWN_META', message: 'Meta may still be working on it. Check again in a few minutes.' } }));
    vi.stubGlobal('fetch', f);
    const r = await useAdsLaunch.getState().check('j1');
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect(useAdsLaunch.getState().checkNotes.j1).toContain('Check again');
  });

  it('an automatic refresh within 5 minutes reads nothing', async () => {
    const f = vi.fn(async () => Response.json({ campaigns: [], limits }));
    vi.stubGlobal('fetch', f);
    await useAdsLaunch.getState().refresh('p1');
    await useAdsLaunch.getState().refresh('p1', { auto: true });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('counts a switched-on, launching or unknown campaign as maybe spending; a paused or ended one not', () => {
    expect(mayBeOn(camp({ state: 'active', configuredStatus: 'ACTIVE' }))).toBe(true);
    expect(mayBeOn(camp({ state: 'rejected', configuredStatus: 'ACTIVE' }))).toBe(true);
    expect(mayBeOn(camp({ state: 'unknown' }))).toBe(true);
    expect(mayBeOn(camp({ state: 'paused', configuredStatus: 'PAUSED' }))).toBe(false);
    expect(mayBeOn(camp({ state: 'ended', configuredStatus: 'ACTIVE' }))).toBe(false);
  });
});
