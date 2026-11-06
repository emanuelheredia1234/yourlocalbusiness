// The analytics store: Update is one request (never retried), the run is followed every 2 s, then 10 s, then
// in the background every 30 s; refusals become Callouts; Connect opens the link in a new tab without keeping
// it, then waits for the network (every 5 s, up to 3 minutes); a window older than 30 minutes "didn't finish".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefreshRun } from '@/lib/integrations/types';

const api = vi.hoisted(() => ({
  refreshAnalytics: vi.fn(),
  getRun: vi.fn(),
  getSnapshots: vi.fn(),
  getConnections: vi.fn(),
  connect: vi.fn(),
  reconnect: vi.fn(),
  checkConnection: vi.fn(),
  disconnect: vi.fn(),
  saveAnalyticsSettings: vi.fn(),
}));
vi.mock('@/lib/integrations/api', async (original) => ({ ...(await original<typeof import('@/lib/integrations/api')>()), ...api }));
vi.mock('@/store/ui', () => ({ toast: vi.fn() }));

const { useAnalytics, runPollDelay, stopAnalyticsTimers, ensureConnections, RUN_POLL, PENDING_EXPIRES_MS, CONNECTIONS_FRESH_MS } = await import('./analytics');
const { IntegrationApiError } = await import('@/lib/integrations/api');
const { toast } = await import('@/store/ui');

const run = (state: RefreshRun['state'], sources: Partial<RefreshRun['sources']> = {}): RefreshRun => ({ id: 'run1', projectId: 'p1', state, sources: { social: 'queued', ads: 'queued', seo: 'queued', email: 'queued', ...sources }, startedAt: new Date().toISOString() });

beforeEach(() => {
  vi.useFakeTimers();
  for (const f of Object.values(api)) f.mockReset();
  vi.mocked(toast).mockReset();
  api.getSnapshots.mockResolvedValue({ snapshots: [] });
  useAnalytics.setState({ run: null, runPhase: 'idle', loading: false, notice: null, snapshots: {}, connections: [], pending: {}, expired: {}, connectionsEnabled: false });
});
afterEach(() => {
  stopAnalyticsTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the polling schedule', () => {
  it('2 s for 2 minutes, then 10 s, then 30 s after 5 minutes', () => {
    expect(runPollDelay(0)).toBe(2_000);
    expect(runPollDelay(119_000)).toBe(2_000);
    expect(runPollDelay(121_000)).toBe(10_000);
    expect(runPollDelay(299_000)).toBe(10_000);
    expect(runPollDelay(301_000)).toBe(30_000);
  });
});

describe('Update', () => {
  it('starts one run, follows it with reads, toasts when done and reloads the snapshots', async () => {
    api.refreshAnalytics.mockResolvedValue({ run: run('running') });
    api.getRun.mockResolvedValueOnce({ run: run('running', { social: 'running' }) }).mockResolvedValueOnce({ run: run('done', { social: 'ok', ads: 'not_connected', seo: 'ok', email: 'ok' }) });
    const r = await useAnalytics.getState().startUpdate('p1');
    expect(r.ok).toBe(true);
    expect(useAnalytics.getState().runPhase).toBe('running');
    await vi.advanceTimersByTimeAsync(RUN_POLL.fastMs);
    expect(useAnalytics.getState().run?.sources.social).toBe('running');
    await vi.advanceTimersByTimeAsync(RUN_POLL.fastMs);
    expect(useAnalytics.getState().runPhase).toBe('idle');
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Analytics updated' }));
    expect(api.getSnapshots).toHaveBeenCalledWith('p1');
    expect(api.refreshAnalytics).toHaveBeenCalledTimes(1);
  });

  it('“Updated with 1 problem” when a source ends in error', async () => {
    api.refreshAnalytics.mockResolvedValue({ run: run('running') });
    api.getRun.mockResolvedValue({ run: run('done_with_errors', { social: 'ok', ads: 'ok', seo: 'error', email: 'ok' }) });
    await useAnalytics.getState().startUpdate('p1');
    await vi.advanceTimersByTimeAsync(RUN_POLL.fastMs);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Updated with 1 problem' }));
  });

  it('after 5 minutes the button is back ("background") and reads go on every 30 s', async () => {
    api.refreshAnalytics.mockResolvedValue({ run: run('running') });
    api.getRun.mockResolvedValue({ run: run('running') });
    await useAnalytics.getState().startUpdate('p1');
    await vi.advanceTimersByTimeAsync(RUN_POLL.backgroundAfterMs + 1_000);
    expect(useAnalytics.getState().runPhase).toBe('background');
    const reads = api.getRun.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.getRun.mock.calls.length).toBe(reads + 1);
    // still only one Update was ever sent
    expect(api.refreshAnalytics).toHaveBeenCalledTimes(1);
  });

  it('a second press while running sends nothing', async () => {
    api.refreshAnalytics.mockResolvedValue({ run: run('running') });
    api.getRun.mockResolvedValue({ run: run('running') });
    await useAnalytics.getState().startUpdate('p1');
    const again = await useAnalytics.getState().startUpdate('p1');
    expect(again.ok).toBe(false);
    expect(api.refreshAnalytics).toHaveBeenCalledTimes(1);
  });

  it('refusals: too soon (nextAt), over the limit and nothing to update become notices; none is retried', async () => {
    api.refreshAnalytics.mockRejectedValueOnce(new IntegrationApiError(429, { error: 'Too soon', code: 'REFRESH_TOO_SOON', nextAt: '2026-11-05T15:15:00Z' }));
    const soon = await useAnalytics.getState().startUpdate('p1');
    expect(soon).toMatchObject({ ok: false, code: 'REFRESH_TOO_SOON', nextAt: '2026-11-05T15:15:00Z' });
    expect(useAnalytics.getState().notice).toBeNull();

    api.refreshAnalytics.mockRejectedValueOnce(new IntegrationApiError(429, { error: 'Limit', code: 'CUSTOMER_CAP', period: 'month' }));
    await useAnalytics.getState().startUpdate('p1');
    expect(useAnalytics.getState().notice).toMatchObject({ kind: 'cap', period: 'month' });

    api.refreshAnalytics.mockRejectedValueOnce(new IntegrationApiError(422, { error: 'Nothing', code: 'NOTHING_TO_UPDATE' }));
    await useAnalytics.getState().startUpdate('p1');
    expect(useAnalytics.getState().notice?.kind).toBe('nothing');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.refreshAnalytics).toHaveBeenCalledTimes(3);
  });
});

describe('connected accounts', () => {
  it('Connect opens the link in a new tab with noopener, keeps only when, and waits (every 5 s)', async () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    api.connect.mockResolvedValue({ connectLink: 'https://connect.example/session?token=secret-session', expiresAt: '' });
    api.getConnections.mockResolvedValue({ connections: [{ platform: 'facebook', state: 'not_connected' }], available: ['facebook'], setUp: true });
    const r = await useAnalytics.getState().connectPlatform('facebook');
    expect(r.ok).toBe(true);
    expect(open).toHaveBeenCalledWith('https://connect.example/session?token=secret-session', '_blank', 'noopener');
    // the link is nowhere in the store
    expect(JSON.stringify(useAnalytics.getState())).not.toContain('secret-session');
    expect(useAnalytics.getState().pending.facebook).toBeTypeOf('number');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.getConnections).toHaveBeenCalledTimes(1);
    api.getConnections.mockResolvedValue({ connections: [{ platform: 'facebook', state: 'connected', targetsAvailable: 2 }], available: ['facebook'], setUp: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(useAnalytics.getState().pending.facebook).toBeUndefined();
    // stops polling once nothing waits
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.getConnections).toHaveBeenCalledTimes(2);
  });

  it('polling stops after 3 minutes', async () => {
    vi.stubGlobal('window', { open: vi.fn() });
    api.connect.mockResolvedValue({ connectLink: 'https://x', expiresAt: '' });
    api.getConnections.mockResolvedValue({ connections: [], available: ['x'], setUp: true });
    await useAnalytics.getState().connectPlatform('x');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(api.getConnections.mock.calls.length).toBeLessThanOrEqual(37);
    expect(api.getConnections.mock.calls.length).toBeGreaterThanOrEqual(35);
  });

  it('a refused connect opens nothing and reports why', async () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    api.connect.mockRejectedValue(new IntegrationApiError(503, { error: 'Connecting accounts is coming soon.', code: 'CONNECTIONS_NOT_ENABLED' }));
    const r = await useAnalytics.getState().connectPlatform('linkedin');
    expect(r).toEqual({ ok: false, message: 'Connecting accounts is coming soon.' });
    expect(open).not.toHaveBeenCalled();
    expect(useAnalytics.getState().pending.linkedin).toBeUndefined();
  });

  it('a window opened more than 30 minutes ago and still not connected becomes “didn’t finish”', async () => {
    useAnalytics.setState({ pending: { tiktok: Date.now() - PENDING_EXPIRES_MS - 1_000 } });
    api.getConnections.mockResolvedValue({ connections: [{ platform: 'tiktok', state: 'not_connected' }], available: ['tiktok'], setUp: true });
    await useAnalytics.getState().refreshConnections();
    expect(useAnalytics.getState().pending.tiktok).toBeUndefined();
    expect(useAnalytics.getState().expired.tiktok).toBe(true);
  });

  it('switched off (no available platforms) or unreachable: nothing is enabled', async () => {
    api.getConnections.mockResolvedValue({ connections: [], available: [], setUp: false, hint: 'add ZERNIO_API_KEY in Replit Secrets' });
    await useAnalytics.getState().refreshConnections();
    expect(useAnalytics.getState().connectionsEnabled).toBe(false);
    expect(useAnalytics.getState().connectionsHint).toContain('ZERNIO_API_KEY');
    api.getConnections.mockRejectedValue(new IntegrationApiError(0, null));
    await useAnalytics.getState().refreshConnections();
    expect(useAnalytics.getState().connectionsEnabled).toBe(false);
  });

  it('Check on a pending row re-reads; on a connected row asks the server once', async () => {
    api.getConnections.mockResolvedValue({ connections: [], available: ['x'], setUp: true });
    useAnalytics.setState({ pending: { x: Date.now() } });
    await useAnalytics.getState().checkPlatform('x');
    expect(api.getConnections).toHaveBeenCalledTimes(1);
    expect(api.checkConnection).not.toHaveBeenCalled();
    api.checkConnection.mockResolvedValue({ connection: { platform: 'youtube', state: 'needs_reconnect' } });
    await useAnalytics.getState().checkPlatform('youtube');
    expect(api.checkConnection).toHaveBeenCalledTimes(1);
    expect(useAnalytics.getState().connections.find((c) => c.platform === 'youtube')?.state).toBe('needs_reconnect');
  });
});

describe('connections without opening Settings (useConnections → ensureConnections)', () => {
  it('reads once, shares a running read, and reads again only after a minute', async () => {
    let resolve!: (v: unknown) => void;
    api.getConnections.mockReturnValue(new Promise((r) => (resolve = r)));
    const a = ensureConnections();
    const b = ensureConnections();
    const c = useAnalytics.getState().refreshConnections();
    expect(api.getConnections).toHaveBeenCalledTimes(1);
    resolve({ connections: [{ platform: 'facebook', state: 'connected' }], available: ['facebook'], setUp: true });
    await Promise.all([a, b, c]);
    expect(useAnalytics.getState().connections[0]?.state).toBe('connected');
    expect(useAnalytics.getState().connectionsEnabled).toBe(true);
    api.getConnections.mockResolvedValue({ connections: [], available: ['facebook'], setUp: true });
    await ensureConnections();
    expect(api.getConnections).toHaveBeenCalledTimes(1);
    await ensureConnections(Date.now() + CONNECTIONS_FRESH_MS + 1);
    expect(api.getConnections).toHaveBeenCalledTimes(2);
  });
  it('another business on screen reads its own accounts at once (each business picks its own)', async () => {
    const { useStore } = await import('@/store/useStore');
    const before = useStore.getState().activeProjectId;
    try {
      useStore.setState({ activeProjectId: 'biz-a' });
      api.getConnections.mockResolvedValue({ connections: [{ platform: 'facebook', state: 'connected', targetLabel: 'A page' }], available: ['facebook'], setUp: true });
      await ensureConnections();
      expect(api.getConnections).toHaveBeenLastCalledWith('biz-a');
      const calls = api.getConnections.mock.calls.length;
      // still fresh for biz-a: no read
      await ensureConnections();
      expect(api.getConnections).toHaveBeenCalledTimes(calls);
      useStore.setState({ activeProjectId: 'biz-b' });
      await ensureConnections();
      expect(api.getConnections).toHaveBeenLastCalledWith('biz-b');
      // a switch while a read is out: the read for the old business is followed by one for the new
      let resolve!: (v: unknown) => void;
      api.getConnections.mockReturnValueOnce(new Promise((r) => (resolve = r)));
      const p = useAnalytics.getState().refreshConnections();
      useStore.setState({ activeProjectId: 'biz-c' });
      let resolveC!: (v: unknown) => void;
      api.getConnections.mockReturnValueOnce(new Promise((r) => (resolveC = r)));
      resolve({ connections: [{ platform: 'facebook', state: 'connected', targetLabel: 'B page' }], available: ['facebook'], setUp: true });
      await vi.waitFor(() => expect(api.getConnections).toHaveBeenLastCalledWith('biz-c'));
      // while the new business's read is out, the old business's answer was dropped
      expect(useAnalytics.getState().connections[0]?.targetLabel).not.toBe('B page');
      resolveC({ connections: [{ platform: 'facebook', state: 'connected', targetLabel: 'C page' }], available: ['facebook'], setUp: true });
      await p;
      expect(api.getConnections).toHaveBeenLastCalledWith('biz-c');
      // the old business's answer never shows on the new one
      expect(useAnalytics.getState().connections[0]?.targetLabel).toBe('C page');
    } finally {
      useStore.setState({ activeProjectId: before });
    }
  });
  it('signed out: the next ask reads again (so signing in shows the accounts)', async () => {
    api.getConnections.mockRejectedValue(new IntegrationApiError(401, { error: 'Sign in', code: 'AUTH_REQUIRED' }));
    await ensureConnections();
    expect(useAnalytics.getState().connectionsError).toBeUndefined();
    api.getConnections.mockResolvedValue({ connections: [], available: [], setUp: false });
    await ensureConnections();
    expect(api.getConnections).toHaveBeenCalledTimes(2);
  });
});

describe('the range', () => {
  it('7 or 30, remembered', () => {
    useAnalytics.getState().setRange(7);
    expect(useAnalytics.getState().range).toBe(7);
  });
});
