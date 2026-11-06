// The owner's ad limits: an empty field inherits the default, values above the hard ceilings are refused before
// anything is sent, and amounts take at most 2 decimals. The R12 warnings name what keeps running.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cloud/auth', async (original) => ({ ...(await original<typeof import('@/lib/cloud/auth')>()), authHeaders: async () => ({ authorization: 'Bearer t' }) }));

const { patchFrom, zernioAlertText } = await import('./AdsLimitsSection');
const { disconnectWarning, liveAdLine } = await import('@/components/ads/liveAds');
const api = await import('@/lib/integrations/api');

const ceilings = { maxDaily: 500, maxChange: 200 };

describe('owner ad limits', () => {
  it('empty fields inherit (null); values become numbers', () => {
    const r = patchFrom({ adsEnabled: 'inherit', adsCurrency: '', maxDaily: '100', maxChange: '', maxCampaignTotal: '1500.50', launchesPerDay: '5', changesPerDay: '' }, ceilings);
    expect(r).toEqual({ patch: { adsEnabled: null, adsCurrency: null, maxDaily: 100, maxChange: null, maxCampaignTotal: 1500.5, launchesPerDay: 5, changesPerDay: null } });
  });
  it('refuses values above the hard ceilings, bad currencies and fractions of a launch', () => {
    expect(patchFrom({ adsEnabled: 'on', maxDaily: '501' }, ceilings)).toMatchObject({ error: expect.stringContaining('ADS_HARD_MAX_DAILY') });
    expect(patchFrom({ adsEnabled: 'on', maxChange: '201' }, ceilings)).toMatchObject({ error: expect.stringContaining('ADS_HARD_MAX_CHANGE') });
    expect(patchFrom({ adsEnabled: 'on', adsCurrency: 'EURO' }, ceilings)).toMatchObject({ error: expect.stringContaining('3-letter') });
    expect(patchFrom({ adsEnabled: 'on', launchesPerDay: '1.5' }, ceilings)).toMatchObject({ error: expect.any(String) });
    expect(patchFrom({ adsEnabled: 'on', maxDaily: '10.123' }, ceilings)).toMatchObject({ error: expect.any(String) });
  });
});

describe('Zernio’s team-level alerts', () => {
  it('are plain words for the owner, naming where to fix it', () => {
    expect(zernioAlertText('ads_addon_required')).toContain('ads add-on');
    expect(zernioAlertText('payment_required')).toContain('billing gate');
    expect(zernioAlertText('ads_allowance_exceeded')).toContain('payment method');
    expect(zernioAlertText('http_401')).toContain('ZERNIO_API_KEY');
  });
});

describe('live campaigns named before they become unreachable', () => {
  const row = { id: 'c1', name: 'Spring fixes', platform: 'meta' as const, daily: 25, currency: 'EUR', idTail: '1234' };
  it('the disconnect warning names each one and what keeps running', () => {
    expect(liveAdLine(row)).toBe('Spring fixes on Meta (…1234), €25.00 a day');
    const w = disconnectWarning([row]);
    expect(w).toContain('the app can’t pause it');
    expect(w).toContain('keeps running until you pause it in Ads Manager');
    expect(disconnectWarning([])).toBe('');
  });
  it('the disconnect request carries the acknowledgement only when asked', async () => {
    api.setIntegrationsBase('https://app.test');
    const f = vi.fn(async (_u: string, _i?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal('fetch', f);
    await api.disconnect('meta_ads', 'p1', true);
    await api.disconnect('meta_ads', 'p1');
    expect(f.mock.calls[0][0]).toBe('https://app.test/api/integrations/connections/meta_ads?projectId=p1&ackLiveAds=1');
    expect(f.mock.calls[1][0]).toBe('https://app.test/api/integrations/connections/meta_ads?projectId=p1');
    vi.unstubAllGlobals();
    api.setIntegrationsBase(null);
  });
});
