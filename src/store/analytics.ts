// Analytics snapshots, the running Update and connected accounts, in memory only (never saved or synced):
// snapshots always come from the server, and nothing here holds a connection id, a token or anyone else's data.
//
//   useConnections() → { byPlatform, enabled, refresh() }   for PostNowButton and Settings › Connected accounts
//   useAnalytics      the store: snapshots per project, the hub's Update (start, follow, the per-source row),
//                     connected accounts (connect, waiting for the network, check, disconnect, choose a Page)
//
// The only thing kept in the browser is the Analytics range (7 or 30 days) under ylb-analytics-range.
// Nothing here retries a write: Update and Connect are one request each, started by the person.

import { useEffect } from 'react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { AnalyticsSettings, AnalyticsSettingsInput, AnalyticsSnapshot, AnalyticsSource, ConnectPlatform, ConnectionStatus, RefreshRun } from '@/lib/integrations/types';
import { ANALYTICS_SOURCES, AD_PLATFORMS, SOCIAL_PLATFORMS } from '@/lib/integrations/types';
import { IntegrationApiError, checkConnection, connect as connectApi, disconnect as disconnectApi, getConnections, getRun, getSnapshots, reconnect as reconnectApi, refreshAnalytics, saveAnalyticsSettings } from '@/lib/integrations/api';
import { serverFetch } from '@/ai/claude';
import { serverBaseNow } from '@/lib/cloud/auth';
import { safeStorage } from '@/lib/storage';
import { useStore } from '@/store/useStore';

/** The business on screen: it picks which of the user's connected accounts are shown and used. */
const activeProject = (): string | undefined => {
  try {
    return useStore.getState().activeProjectId ?? undefined;
  } catch {
    return undefined;
  }
};

const artifact = () => typeof __ARTIFACT_BUILD__ !== 'undefined' && __ARTIFACT_BUILD__;

// ───────────── timing (exported for tests) ─────────────

/** Follow a run: every 2 s for 2 minutes, then every 10 s; after 5 minutes "in the background", every 30 s. */
export const RUN_POLL = { fastMs: 2_000, fastForMs: 120_000, slowMs: 10_000, backgroundAfterMs: 300_000, backgroundMs: 30_000 } as const;
/** Waiting for a network after Connect: every 5 s for up to 3 minutes while the tab is visible. */
export const CONNECT_POLL = { everyMs: 5_000, forMs: 180_000 } as const;
/** A connect window that didn't finish within 30 minutes: "That didn't finish. Try again." */
export const PENDING_EXPIRES_MS = 30 * 60_000;
/** useConnections() reads the connections at most this often (on mount and when the tab comes back). */
export const CONNECTIONS_FRESH_MS = 60_000;

export function runPollDelay(elapsedMs: number): number {
  if (elapsedMs < RUN_POLL.fastForMs) return RUN_POLL.fastMs;
  if (elapsedMs < RUN_POLL.backgroundAfterMs) return RUN_POLL.slowMs;
  return RUN_POLL.backgroundMs;
}

// ───────────── the remembered range ─────────────

export type AnalyticsRange = 7 | 30;
const RANGE_KEY = 'ylb-analytics-range';
function readRange(): AnalyticsRange {
  try {
    return safeStorage.getItem(RANGE_KEY) === '7' ? 7 : 30;
  } catch {
    return 30;
  }
}

// ───────────── what the Update said, besides the run ─────────────

/** A refusal of the Update shown as a Callout under the hub's header (the rest are toasts). */
export interface UpdateNotice {
  kind: 'cap' | 'blocked' | 'nothing' | 'unavailable';
  message: string;
  period?: 'day' | 'month';
}

export type UpdateStart = { ok: true; run: RefreshRun } | { ok: false; code: string; message: string; nextAt?: string; period?: 'day' | 'month' };

export interface AnalyticsState {
  /** the latest snapshots per project id (memory only) */
  snapshots: Record<string, AnalyticsSnapshot[]>;
  /** per project: loading the snapshots now, and the last load's error */
  snapshotsLoading: Record<string, boolean>;
  snapshotsError: Record<string, string | undefined>;
  /** the Update running now (or the last one, until the progress row is dismissed) */
  run: RefreshRun | null;
  /** idle; running (the button shows Updating…); background (over 5 minutes: the button is back, polling goes on) */
  runPhase: 'idle' | 'running' | 'background';
  /** a refused Update shown as a Callout (cap, blocked, nothing to update) */
  notice: UpdateNotice | null;
  loading: boolean;
  /** the Analytics range (7 or 30 days), remembered in this browser */
  range: AnalyticsRange;

  /** connected accounts, as the server last said */
  connections: ConnectionStatus[];
  /** whether connecting accounts is switched on (false: every network is posted by hand) */
  connectionsEnabled: boolean;
  /** social accounts (connect, post, social stats) are switched on */
  socialEnabled: boolean;
  /** ad accounts (connect, ad results) are switched on */
  adsEnabled: boolean;
  /** the first answer has come in */
  connectionsLoaded: boolean;
  /** the owner only: which Replit Secret is missing (names, never values) */
  connectionsHint?: string;
  connectionsError?: string;
  /** when each network's connect window was opened here (memory only) */
  pending: Partial<Record<ConnectPlatform, number>>;
  /** connect windows that ran past 30 minutes: the row says "That didn't finish. Try again." */
  expired: Partial<Record<ConnectPlatform, true>>;

  /** whether this person is the app's owner (null: not known yet) */
  owner: boolean | null;
  /** keywords, city and competitors per project, as the server last said */
  settings: Record<string, AnalyticsSettings | undefined>;

  refreshConnections: () => Promise<void>;
  loadSnapshots: (projectId: string) => Promise<void>;
  startUpdate: (projectId: string) => Promise<UpdateStart>;
  dismissRun: () => void;
  dismissNotice: () => void;
  setRange: (r: AnalyticsRange) => void;
  /** Connect / Reconnect: one request for a link, opened in a new tab; then the row waits for the network. */
  connectPlatform: (platform: ConnectPlatform, mode?: 'connect' | 'reconnect') => Promise<{ ok: boolean; message?: string }>;
  /** "Check": re-reads the status (pending rows) or asks the server to check the connection (connected rows). */
  checkPlatform: (platform: ConnectPlatform) => Promise<{ ok: boolean; message?: string }>;
  disconnectPlatform: (platform: ConnectPlatform) => Promise<{ ok: boolean; message?: string }>;
  loadOwner: () => Promise<void>;
  /** Read the project's analytics settings (a PUT with no fields changes nothing and answers them). */
  loadSettings: (projectId: string) => Promise<void>;
  saveSettings: (input: AnalyticsSettingsInput) => Promise<{ ok: boolean; message?: string }>;
}

let runTimer: ReturnType<typeof setTimeout> | null = null;
let runFollowing: string | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;
let connectUntil = 0;
let connectionsInFlight: Promise<void> | null = null;
let connectionsAt = 0;
/** the business the stored connections were read for (each business picks its own accounts) */
let connectionsFor: string | undefined | null = null;
let focusRefetchInstalled = false;

const connectionsLoadedOnce = () => connectionsAt > 0 || connectionsFor !== null;

const messageOf = (e: unknown, fallback = 'Something went wrong. Try again shortly.') => (e instanceof IntegrationApiError ? e.message : fallback);

const SOURCE_LABEL: Record<AnalyticsSource, string> = { social: 'Social', ads: 'Ads', seo: 'SEO', email: 'Email' };
export const sourceLabel = (s: AnalyticsSource) => SOURCE_LABEL[s];

/** How many sources ended badly (error) in a finished run. */
export function runProblems(run: RefreshRun): number {
  return ANALYTICS_SOURCES.filter((s) => run.sources[s] === 'error').length;
}

/** The toast when a run ends. */
function announce(run: RefreshRun, toastFn: (t: { title: string; kind: 'success' | 'info' | 'error' }) => void) {
  const n = runProblems(run);
  if (n === 0) toastFn({ title: 'Analytics updated', kind: 'success' });
  else toastFn({ title: `Updated with ${n} problem${n === 1 ? '' : 's'}`, kind: 'info' });
}

// the toast store is loaded lazily, so this store stays importable from anywhere (and from node tests)
async function toastNow(t: { title: string; body?: string; kind: 'success' | 'info' | 'error' }) {
  try {
    const { toast } = await import('@/store/ui');
    toast(t);
  } catch {
    /* no UI */
  }
}

export const useAnalytics: UseBoundStore<StoreApi<AnalyticsState>> = create<AnalyticsState>((set, get) => {
  /** Poll the connections while some network is waiting, every 5 s for up to 3 min while the tab is visible. */
  const scheduleConnectPoll = () => {
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = null;
    if (Date.now() > connectUntil) return;
    if (!Object.keys(get().pending).length) return;
    connectTimer = setTimeout(async () => {
      connectTimer = null;
      const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
      if (visible) await get().refreshConnections();
      scheduleConnectPoll();
    }, CONNECT_POLL.everyMs);
  };

  const followRun = (runId: string, projectId: string, startedMs: number) => {
    if (runTimer) clearTimeout(runTimer);
    runFollowing = runId;
    const tick = async () => {
      runTimer = null;
      if (runFollowing !== runId) return;
      let run: RefreshRun | null = null;
      try {
        run = (await getRun(runId)).run;
      } catch {
        /* a missed read: the next one tries again (a read, never the Update itself) */
      }
      if (runFollowing !== runId) return;
      const elapsed = Date.now() - startedMs;
      if (run) set({ run });
      if (run && run.state !== 'running') {
        runFollowing = null;
        set({ runPhase: 'idle' });
        announce(run, (t) => void toastNow(t));
        await get().loadSnapshots(projectId);
        return;
      }
      if (elapsed >= RUN_POLL.backgroundAfterMs && get().runPhase === 'running') set({ runPhase: 'background' });
      runTimer = setTimeout(() => void tick(), runPollDelay(elapsed));
    };
    runTimer = setTimeout(() => void tick(), RUN_POLL.fastMs);
  };

  /** One read of the connections (refreshConnections() shares it while it runs). */
  const readConnections = async () => {
    const projectId = activeProject();
    try {
      const r = await getConnections(projectId);
      // another business came on screen while this was out: drop it (its accounts must never show on the new one)
      if (projectId !== activeProject()) return;
      const connections = Array.isArray(r.connections) ? r.connections : [];
      // a network that's no longer waiting (connected, or anything but not connected) leaves `pending`;
      // one still not connected after 30 minutes becomes "That didn't finish"
      const pending = { ...get().pending };
      const expired = { ...get().expired };
      const now = Date.now();
      for (const [p, at] of Object.entries(pending) as [ConnectPlatform, number][]) {
        const c = connections.find((x) => x.platform === p);
        if (c && c.state !== 'not_connected' && c.state !== 'pending') {
          delete pending[p];
          delete expired[p];
        } else if (now - at > PENDING_EXPIRES_MS) {
          delete pending[p];
          expired[p] = true;
        }
      }
      connectionsAt = Date.now();
      connectionsFor = projectId;
      const available = Array.isArray(r.available) ? r.available : [];
      const enabled = r.setUp === true && available.length > 0;
      // each side by its own flag; an older server sent only setUp (then both follow it)
      const side = (flag: boolean | undefined, list: readonly ConnectPlatform[]) => enabled && (flag ?? true) && available.some((p) => list.includes(p));
      set({
        connections,
        connectionsEnabled: enabled,
        socialEnabled: side(r.setUpSocial, SOCIAL_PLATFORMS),
        adsEnabled: side(r.setUpAds, AD_PLATFORMS),
        connectionsLoaded: true,
        connectionsHint: typeof r.hint === 'string' && r.hint ? r.hint : undefined,
        connectionsError: undefined,
        pending,
        expired,
      });
    } catch (e) {
      // off, signed out or unreachable: everything reads "Not connected" and posting stays manual
      // (signed out: the next mount or focus asks again, so signing in shows the accounts)
      if (projectId !== activeProject()) return;
      connectionsAt = e instanceof IntegrationApiError && e.code === 'AUTH_REQUIRED' ? 0 : Date.now();
      connectionsFor = projectId;
      set({ connections: [], connectionsEnabled: false, socialEnabled: false, adsEnabled: false, connectionsLoaded: true, connectionsError: e instanceof IntegrationApiError && e.code !== 'AUTH_REQUIRED' ? e.message : undefined });
    }
  };

  return {
    snapshots: {},
    snapshotsLoading: {},
    snapshotsError: {},
    run: null,
    runPhase: 'idle',
    notice: null,
    loading: false,
    range: readRange(),
    connections: [],
    connectionsEnabled: false,
    socialEnabled: false,
    adsEnabled: false,
    connectionsLoaded: false,
    pending: {},
    expired: {},
    owner: null,
    settings: {},

    refreshConnections: () => {
      if (artifact()) return Promise.resolve();
      // one read at a time: every posting button may ask at once
      if (connectionsInFlight) return connectionsInFlight;
      const run = async () => {
        await readConnections();
        // the business changed while that read was out: read again for the one on screen (once)
        if (connectionsFor !== activeProject()) await readConnections();
      };
      connectionsInFlight = run().finally(() => {
        connectionsInFlight = null;
      });
      return connectionsInFlight;
    },

    loadSnapshots: async (projectId) => {
      if (artifact() || !projectId) return;
      set((s) => ({ snapshotsLoading: { ...s.snapshotsLoading, [projectId]: true } }));
      try {
        const r = await getSnapshots(projectId);
        set((s) => ({
          snapshots: { ...s.snapshots, [projectId]: Array.isArray(r.snapshots) ? r.snapshots : [] },
          snapshotsLoading: { ...s.snapshotsLoading, [projectId]: false },
          snapshotsError: { ...s.snapshotsError, [projectId]: undefined },
        }));
      } catch (e) {
        set((s) => ({ snapshotsLoading: { ...s.snapshotsLoading, [projectId]: false }, snapshotsError: { ...s.snapshotsError, [projectId]: messageOf(e, 'Couldn’t load your analytics.') } }));
      }
    },

    startUpdate: async (projectId) => {
      if (artifact()) return { ok: false, code: 'UNAVAILABLE', message: 'Live analytics need the full app.' };
      if (get().runPhase === 'running' || get().loading) return { ok: false, code: 'IN_PROGRESS', message: 'Already updating.' };
      set({ loading: true, notice: null });
      try {
        const { run } = await refreshAnalytics(projectId);
        set({ run, runPhase: run.state === 'running' ? 'running' : 'idle', loading: false });
        if (run.state === 'running') followRun(run.id, projectId, Date.now());
        else {
          announce(run, (t) => void toastNow(t));
          await get().loadSnapshots(projectId);
        }
        return { ok: true, run };
      } catch (e) {
        set({ loading: false });
        const err = e instanceof IntegrationApiError ? e : null;
        const code = err?.code ?? 'UNAVAILABLE';
        const message = messageOf(e);
        if (code === 'CUSTOMER_CAP') set({ notice: { kind: 'cap', message, ...(err?.period ? { period: err.period } : {}) } });
        else if (code === 'CUSTOMER_BLOCKED') set({ notice: { kind: 'blocked', message } });
        else if (code === 'NOTHING_TO_UPDATE') set({ notice: { kind: 'nothing', message } });
        return { ok: false, code, message, ...(err?.nextAt ? { nextAt: err.nextAt } : {}), ...(err?.period ? { period: err.period } : {}) };
      }
    },

    dismissRun: () => {
      if (get().runPhase !== 'idle') return; // still going: the row stays
      set({ run: null });
    },
    dismissNotice: () => set({ notice: null }),

    setRange: (range) => {
      set({ range });
      try {
        safeStorage.setItem(RANGE_KEY, String(range));
      } catch {
        /* remembered for this visit only */
      }
    },

    connectPlatform: async (platform, mode = 'connect') => {
      if (artifact()) return { ok: false, message: 'Connected accounts need the full app.' };
      try {
        const link = await (mode === 'reconnect' ? reconnectApi(platform, activeProject()) : connectApi(platform, activeProject()));
        // an ad account on a network already connected needs no sign-in: read the accounts again
        if (link.alreadyConnected || !link.connectLink) {
          await get().refreshConnections();
          return { ok: true };
        }
        // a new tab with no way back to this page; the link is never put in the address bar or kept
        if (typeof window !== 'undefined') window.open(link.connectLink, '_blank', 'noopener');
        // only when the window was opened is kept
        const expired = { ...get().expired };
        delete expired[platform];
        set({ pending: { ...get().pending, [platform]: Date.now() }, expired });
        connectUntil = Date.now() + CONNECT_POLL.forMs;
        scheduleConnectPoll();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: messageOf(e) };
      }
    },

    checkPlatform: async (platform) => {
      if (artifact()) return { ok: false };
      if (get().pending[platform] !== undefined) {
        await get().refreshConnections();
        // a fresh look at the network starts another 3 minutes of waiting
        if (get().pending[platform] !== undefined) {
          connectUntil = Date.now() + CONNECT_POLL.forMs;
          scheduleConnectPoll();
        }
        return { ok: true };
      }
      try {
        const { connection } = await checkConnection(platform, activeProject());
        set({ connections: [...get().connections.filter((c) => c.platform !== platform), connection] });
        return { ok: true };
      } catch (e) {
        return { ok: false, message: messageOf(e) };
      }
    },

    disconnectPlatform: async (platform) => {
      if (artifact()) return { ok: false };
      try {
        await disconnectApi(platform, activeProject());
        const pending = { ...get().pending };
        delete pending[platform];
        set({ connections: get().connections.map((c) => (c.platform === platform ? { platform, state: 'not_connected' } : c)), pending });
        await get().refreshConnections();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: messageOf(e) };
      }
    },

    loadSettings: async (projectId) => {
      if (artifact() || !projectId) return;
      try {
        const { settings } = await saveAnalyticsSettings({ projectId });
        set((s) => ({ settings: { ...s.settings, [projectId]: settings } }));
      } catch {
        /* the drawer starts empty and says what failed when saving */
      }
    },

    saveSettings: async (input) => {
      if (artifact()) return { ok: false };
      try {
        const { settings } = await saveAnalyticsSettings(input);
        set((s) => ({ settings: { ...s.settings, [input.projectId]: settings } }));
        return { ok: true };
      } catch (e) {
        return { ok: false, message: messageOf(e, 'Couldn’t save.') };
      }
    },

    loadOwner: async () => {
      if (artifact() || get().owner !== null) return;
      // the AI keys page's own answer says whether this person manages the app (the server decides)
      try {
        const res = await serverFetch(serverBaseNow(), '/api/ai/providers', { method: 'GET' });
        const j = (await res.json().catch(() => null)) as { role?: string } | null;
        set({ owner: res.ok && j?.role === 'admin' });
      } catch {
        set({ owner: false });
      }
    },
  };
});

/** Stop following runs and connect windows (tests, sign-out). */
export function stopAnalyticsTimers(): void {
  if (runTimer) clearTimeout(runTimer);
  if (connectTimer) clearTimeout(connectTimer);
  runTimer = null;
  connectTimer = null;
  runFollowing = null;
  connectUntil = 0;
  connectionsAt = 0;
  connectionsFor = null;
}

/**
 * Read the connections unless a read is running or one finished in the last minute. Posting buttons and the
 * analytics tabs call this through useConnections(), so they know what's connected without opening Settings.
 */
export function ensureConnections(now = Date.now()): Promise<void> {
  if (artifact()) return Promise.resolve();
  if (connectionsInFlight) return connectionsInFlight;
  if (connectionsAt && now - connectionsAt < CONNECTIONS_FRESH_MS && connectionsFor === activeProject()) return Promise.resolve();
  return useAnalytics.getState().refreshConnections();
}

/** Read the connections again whenever the tab comes back into view (at most once a minute). */
function installFocusRefetch(): void {
  if (focusRefetchInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
  focusRefetchInstalled = true;
  const onFocus = () => {
    if (document.visibilityState !== 'hidden') void ensureConnections();
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  // another business on screen: its own chosen accounts (the labels a posting confirm shows)
  try {
    useStore.subscribe((state, prev) => {
      if (state.activeProjectId !== prev.activeProjectId && connectionsLoadedOnce()) void ensureConnections();
    });
  } catch {
    /* no store (tests): the next focus or mount reads them */
  }
}

/** Connection status by platform (missing: not connected), whether connecting is on, and a refetch. */
export function useConnections(): { byPlatform: Partial<Record<ConnectPlatform, ConnectionStatus>>; enabled: boolean; refresh(): Promise<void> } {
  const connections = useAnalytics((s) => s.connections);
  const enabled = useAnalytics((s) => s.connectionsEnabled);
  const refresh = useAnalytics((s) => s.refreshConnections);
  // read once when first needed, and again when the tab comes back (§2.3: refetched on focus)
  useEffect(() => {
    if (artifact()) return;
    installFocusRefetch();
    void ensureConnections();
  }, []);
  const byPlatform: Partial<Record<ConnectPlatform, ConnectionStatus>> = {};
  for (const c of connections) byPlatform[c.platform] = c;
  return { byPlatform, enabled, refresh };
}

/** The snapshot of one source for a project (undefined until loaded or when there is none). */
export function snapshotOf<T>(snapshots: AnalyticsSnapshot[] | undefined, source: AnalyticsSource): AnalyticsSnapshot<T> | undefined {
  return snapshots?.find((s) => s.source === source) as AnalyticsSnapshot<T> | undefined;
}
