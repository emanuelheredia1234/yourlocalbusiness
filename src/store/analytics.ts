// Analytics snapshots, the running Update and connected accounts, in memory only (never saved or synced):
// snapshots always come from the server. WP5 builds this out (polling, focus refetch, the hub's Update);
// this is the contract other parts compile against.
//
//   useConnections() → { byPlatform, enabled, refresh() }   for PostNowButton and Settings › Connected accounts

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { AnalyticsSnapshot, ConnectPlatform, ConnectionStatus, RefreshRun } from '@/lib/integrations/types';
import { getConnections } from '@/lib/integrations/api';

export interface AnalyticsState {
  /** the latest snapshots per project id (memory only) */
  snapshots: Record<string, AnalyticsSnapshot[]>;
  /** the Update running now, if any */
  run: RefreshRun | null;
  loading: boolean;
  /** connected accounts, as the server last said */
  connections: ConnectionStatus[];
  /** whether connecting accounts is switched on (false: every network is posted by hand) */
  connectionsEnabled: boolean;
  refreshConnections: () => Promise<void>;
}

export const useAnalytics: UseBoundStore<StoreApi<AnalyticsState>> = create<AnalyticsState>((set) => ({
  snapshots: {},
  run: null,
  loading: false,
  connections: [],
  connectionsEnabled: false,
  refreshConnections: async () => {
    if (typeof __ARTIFACT_BUILD__ !== 'undefined' && __ARTIFACT_BUILD__) return;
    try {
      const r = await getConnections();
      set({ connections: Array.isArray(r.connections) ? r.connections : [], connectionsEnabled: r.setUp === true && Array.isArray(r.available) && r.available.length > 0 });
    } catch {
      // off, signed out or unreachable: everything reads "Not connected" and posting stays manual
      set({ connections: [], connectionsEnabled: false });
    }
  },
}));

/** Connection status by platform (missing: not connected), whether connecting is on, and a refetch. */
export function useConnections(): { byPlatform: Partial<Record<ConnectPlatform, ConnectionStatus>>; enabled: boolean; refresh(): Promise<void> } {
  const connections = useAnalytics((s) => s.connections);
  const enabled = useAnalytics((s) => s.connectionsEnabled);
  const refresh = useAnalytics((s) => s.refreshConnections);
  const byPlatform: Partial<Record<ConnectPlatform, ConnectionStatus>> = {};
  for (const c of connections) byPlatform[c.platform] = c;
  return { byPlatform, enabled, refresh };
}
