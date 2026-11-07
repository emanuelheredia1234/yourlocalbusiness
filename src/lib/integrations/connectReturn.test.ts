// Coming back from Zernio's connect page: the query is read once (success → Check right away with the account Zernio
// named; error → the waiting stops on the server and the reason is said in our words, the team-level ones only to
// the owner), and the parameters leave the address bar. Requests are stubbed.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ checkConnection: vi.fn(), abandonConnection: vi.fn(), getConnections: vi.fn() }));
vi.mock('@/lib/integrations/api', async (original) => ({ ...(await original<typeof import('@/lib/integrations/api')>()), ...api }));
const ui = vi.hoisted(() => ({ toast: vi.fn(), setSettingsTab: vi.fn() }));
vi.mock('@/store/ui', async (original) => {
  const real = await original<typeof import('@/store/ui')>();
  real.useUI.setState({ setSettingsTab: ui.setSettingsTab });
  return { ...real, toast: ui.toast };
});
const nav = vi.hoisted(() => ({ navigate: vi.fn(async () => true) }));
vi.mock('@/lib/router', async (original) => ({ ...(await original<typeof import('@/lib/router')>()), navigate: nav.navigate }));

const { parseConnectReturn, withoutConnectParams, connectErrorMessage, CONNECT_ERROR_REASONS } = await import('./connectReturn');
const { handleConnectReturn } = await import('./connectReturnWatcher');
const { useAnalytics } = await import('@/store/analytics');
const { rowView } = await import('@/pages/settings/ConnectedAccounts');

const ACC = '65f1c0ffee0123456789abcd';

beforeEach(() => {
  for (const f of [...Object.values(api), ...Object.values(ui), nav.navigate]) f.mockReset();
  api.getConnections.mockResolvedValue({ connections: [], available: ['meta_ads'], setUp: true, setUpAds: true });
  useAnalytics.setState({ connections: [], pending: {}, expired: {}, owner: false, loadOwner: async () => {} });
});

describe('reading the query', () => {
  it('success: our marker, Zernio’s connected name and the account id', () => {
    expect(parseConnectReturn(`?ylb_connect=meta_ads&connected=metaads&profileId=aaaaaaaaaaaaaaaaaaaaaaaa&accountId=${ACC}`)).toEqual({ kind: 'connected', platform: 'meta_ads', accountId: ACC });
    // without our marker, Zernio's ads names map to ours
    expect(parseConnectReturn(`?connected=googleads&accountId=${ACC}`)).toEqual({ kind: 'connected', platform: 'google_ads', accountId: ACC });
    // a bad account id is dropped (a hint only)
    expect(parseConnectReturn('?connected=metaads&accountId=<x>')).toEqual({ kind: 'connected', platform: 'meta_ads' });
  });

  it('failure: each reason Zernio names, anything else connection_failed; is_user_fixable read', () => {
    for (const r of CONNECT_ERROR_REASONS) expect(parseConnectReturn(`?ylb_connect=meta_ads&error=access_denied&platform=facebook&error_reason=${r}`)).toMatchObject({ kind: 'error', platform: 'meta_ads', reason: r });
    expect(parseConnectReturn('?ylb_connect=tiktok_ads&error=x&error_reason=weird&is_user_fixable=true')).toEqual({ kind: 'error', platform: 'tiktok_ads', reason: 'connection_failed', userFixable: true });
    expect(parseConnectReturn('?error=x&platform=metaads&error_reason=state_expired')).toMatchObject({ platform: 'meta_ads', reason: 'state_expired' });
  });

  it('nothing to do for an ordinary address, or someone else’s ?error=', () => {
    expect(parseConnectReturn('')).toBeNull();
    expect(parseConnectReturn('?billing=success&session_id=cs_123')).toBeNull();
    expect(parseConnectReturn('?error=access_denied')).toBeNull();
    // a social name without our marker isn't taken for an ad platform
    expect(parseConnectReturn('?connected=facebook')).toEqual({ kind: 'connected', platform: null });
  });

  it('takes only the connect parameters out of the address (the rest and the hash stay)', () => {
    expect(withoutConnectParams(`https://app.example/?ylb_connect=meta_ads&connected=metaads&accountId=${ACC}&profileId=p&keep=1#workspace-settings`)).toBe('/?keep=1#workspace-settings');
    expect(withoutConnectParams('https://app.example/?error=e&platform=metaads&error_reason=x&error_message=Meta%20said&is_user_fixable=false')).toBe('/');
  });
});

describe('the words', () => {
  it('owner-facing reasons say what to fix only to the owner; customers get a safe line', () => {
    for (const r of ['ads_addon_required', 'payment_required'] as const) {
      expect(connectErrorMessage(r, 'Meta Ads', true)).toContain('Zernio');
      expect(connectErrorMessage(r, 'Meta Ads', false)).not.toContain('Zernio');
      expect(connectErrorMessage(r, 'Meta Ads', false)).toContain('isn’t available right now');
    }
    expect(connectErrorMessage('ad_accounts_not_granted', 'Meta Ads')).toContain('ad account');
    expect(connectErrorMessage('no_pages_granted', 'Meta Ads')).toContain('Page');
    expect(connectErrorMessage('meta_ads_authorization_denied', 'Meta Ads')).toContain('Allow');
    expect(connectErrorMessage('state_expired', 'Meta Ads')).toContain('Start again');
    expect(connectErrorMessage('reconnect_required', 'Meta Ads')).toContain('Reconnect');
    expect(connectErrorMessage('connection_failed', 'Meta Ads')).toContain('Try again');
  });

  it('the row shows the reason the server kept (Reconnect for reconnect_required), never Zernio’s team problem', () => {
    expect(rowView('meta_ads', { platform: 'meta_ads', state: 'not_connected', lastError: 'page_not_granted' }, { enabled: true })).toMatchObject({ tone: 'warn', note: expect.stringContaining('Page'), action: 'connect' });
    expect(rowView('meta_ads', { platform: 'meta_ads', state: 'not_connected', lastError: 'reconnect_required' }, { enabled: true }).action).toBe('reconnect');
    expect(rowView('meta_ads', { platform: 'meta_ads', state: 'not_connected', lastError: 'ads_addon_required' }, { enabled: true }).note).not.toContain('Zernio');
  });
});

describe('acting on it', () => {
  it('success: Check right away with the account id, then a success toast, on Settings › Connected accounts', async () => {
    api.checkConnection.mockResolvedValue({ connection: { platform: 'meta_ads', state: 'connected', targetLabel: 'Joe’s ads' } });
    api.getConnections.mockResolvedValue({ connections: [{ platform: 'meta_ads', state: 'connected', targetLabel: 'Joe’s ads' }], available: ['meta_ads'], setUp: true, setUpAds: true });
    await handleConnectReturn({ kind: 'connected', platform: 'meta_ads', accountId: ACC });
    expect(api.checkConnection).toHaveBeenCalledTimes(1);
    expect(api.checkConnection.mock.calls[0][0]).toBe('meta_ads');
    expect(api.checkConnection.mock.calls[0][2]).toBe(ACC);
    expect(ui.setSettingsTab).toHaveBeenCalledWith('accounts');
    expect(nav.navigate).toHaveBeenCalledWith('workspace-settings', { force: true });
    expect(ui.toast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', title: 'Meta Ads connected' }));
  });

  it('error: the waiting stops on the server (the reason sent), here too, and the message is ours', async () => {
    useAnalytics.setState({ pending: { meta_ads: Date.now() } });
    api.abandonConnection.mockResolvedValue({ connection: { platform: 'meta_ads', state: 'not_connected', lastError: 'ad_accounts_not_granted' } });
    await handleConnectReturn({ kind: 'error', platform: 'meta_ads', reason: 'ad_accounts_not_granted', userFixable: true });
    expect(api.abandonConnection).toHaveBeenCalledWith('meta_ads', 'ad_accounts_not_granted', undefined);
    expect(useAnalytics.getState().pending.meta_ads).toBeUndefined();
    expect(api.checkConnection).not.toHaveBeenCalled();
    expect(ui.toast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', body: expect.stringContaining('No ad account was shared') }));
  });

  it('the owner reads what to fix for the ads add-on; a customer doesn’t', async () => {
    api.abandonConnection.mockResolvedValue({ connection: { platform: 'meta_ads', state: 'not_connected' } });
    useAnalytics.setState({ owner: true });
    await handleConnectReturn({ kind: 'error', platform: 'meta_ads', reason: 'ads_addon_required', userFixable: false });
    expect(ui.toast).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.stringContaining('Zernio dashboard') }));
    useAnalytics.setState({ owner: false });
    await handleConnectReturn({ kind: 'error', platform: 'meta_ads', reason: 'ads_addon_required', userFixable: false });
    expect(ui.toast).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.not.stringContaining('Zernio') }));
  });
});
