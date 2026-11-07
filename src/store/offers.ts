// Offers, sales summaries and Whop connections as the server last said (memory only: the server is the source,
// nothing here is saved to the workspace or synced). A business's offers load when a page that uses them opens;
// switching accounts drops everything.

import { useEffect } from 'react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { useAuth } from '@/lib/cloud/auth';
import { listOffers, offersConfig, salesSummary, whopConnections, type Offer, type OffersConfig, type SalesSummary, type WhopConnection } from '@/lib/offers';
import { connectStatus, type ConnectAccount, type ConnectState } from '@/lib/stripeConnect';

interface OffersState {
  config: OffersConfig | null;
  /** each business's offers (archived left out), by project id */
  byProject: Record<string, Offer[]>;
  /** each business's sales summary (30 days) */
  summary: Record<string, SalesSummary>;
  /** the signed-in user's Whop connections (null: not loaded yet) */
  connections: WhopConnection[] | null;
  /** the last error per project, in plain words ('' when none) */
  error: Record<string, string>;
  /** the signed-in seller's Stripe account, their fee and the seller terms (null: not loaded yet) */
  connect: ConnectState | null;
  /** why the Stripe account couldn't be read ('' when it could) */
  connectError: string;
  refreshConnect: () => Promise<ConnectState | null>;
  /** an account the server just answered with (made, synced, tax changed; null: stopped selling here) */
  setConnectAccount: (account: ConnectAccount | null) => void;
  loadConfig: (refresh?: boolean) => Promise<OffersConfig>;
  refresh: (projectId: string) => Promise<Offer[]>;
  refreshSummary: (projectId: string, days?: number) => Promise<SalesSummary | null>;
  refreshConnections: () => Promise<WhopConnection[]>;
  /** an offer the server just answered with (made, changed, archived) */
  put: (offer: Offer) => void;
  /** an offer that's gone */
  drop: (projectId: string, id: string) => void;
  setConnections: (connections: WhopConnection[]) => void;
  reset: () => void;
}

const asking = new Map<string, Promise<Offer[]>>();

export const useOffers: UseBoundStore<StoreApi<OffersState>> = create<OffersState>((set, get) => ({
  config: null,
  byProject: {},
  summary: {},
  connections: null,
  error: {},
  connect: null,
  connectError: '',
  loadConfig: async (refresh = false) => {
    const c = await offersConfig(refresh);
    set({ config: c });
    return c;
  },
  refresh: (projectId) => {
    const cur = asking.get(projectId);
    if (cur) return cur;
    const ask = listOffers(projectId)
      .then((offers) => {
        set((s) => ({ byProject: { ...s.byProject, [projectId]: offers.filter((o) => o.status !== 'archived') }, error: { ...s.error, [projectId]: '' } }));
        return offers;
      })
      .catch((e: Error) => {
        set((s) => ({ error: { ...s.error, [projectId]: e.message } }));
        return get().byProject[projectId] ?? [];
      })
      .finally(() => asking.delete(projectId));
    asking.set(projectId, ask);
    return ask;
  },
  refreshSummary: async (projectId, days = 30) => {
    try {
      const s = await salesSummary(projectId, days);
      set((st) => ({ summary: { ...st.summary, [projectId]: s } }));
      return s;
    } catch {
      return null;
    }
  },
  refreshConnections: async () => {
    try {
      const c = await whopConnections();
      set({ connections: c });
      return c;
    } catch {
      return get().connections ?? [];
    }
  },
  put: (offer) =>
    set((s) => {
      const list = (s.byProject[offer.projectId] ?? []).filter((o) => o.id !== offer.id);
      return { byProject: { ...s.byProject, [offer.projectId]: offer.status === 'archived' ? list : [offer, ...list] } };
    }),
  drop: (projectId, id) => set((s) => ({ byProject: { ...s.byProject, [projectId]: (s.byProject[projectId] ?? []).filter((o) => o.id !== id) } })),
  setConnections: (connections) => set({ connections }),
  refreshConnect: async () => {
    if (__ARTIFACT_BUILD__) return null;
    try {
      const c = await connectStatus();
      set({ connect: c, connectError: '' });
      return c;
    } catch (e) {
      set({ connectError: (e as Error)?.message || 'Couldn’t read your Stripe account. Try again.' });
      return get().connect;
    }
  },
  setConnectAccount: (account) => set((s) => (s.connect ? { connect: { ...s.connect, account } } : {})),
  reset: () => set({ byProject: {}, summary: {}, connections: null, error: {}, connect: null, connectError: '' }),
}));

/**
 * Back from Stripe's setup page (Settings › Payments ?stripe=return): read the account again each time the window
 * regains focus for the next 10 minutes (Stripe can finish its checks a little later, or in another tab).
 */
export function watchConnectFocus(minutes = 10): () => void {
  if (__ARTIFACT_BUILD__ || typeof window === 'undefined') return () => {};
  const until = Date.now() + minutes * 60_000;
  const onFocus = () => {
    if (Date.now() > until) return stop();
    const a = useOffers.getState().connect?.account;
    if (a && a.status !== 'active') void useOffers.getState().refreshConnect();
  };
  const stop = () => window.removeEventListener('focus', onFocus);
  window.addEventListener('focus', onFocus);
  return stop;
}

/** A business's offer by id, as last loaded (undefined: not one of its offers, or not loaded yet). */
export function findOffer(projectId: string, id: string | undefined): Offer | undefined {
  if (!id) return undefined;
  return useOffers.getState().byProject[projectId]?.find((o) => o.id === id);
}

/** Every offer id loaded so far, all businesses (a copy of a page made outside a business's own view). */
export function allKnownOfferIds(): Set<string> {
  return new Set(Object.values(useOffers.getState().byProject).flatMap((l) => l.map((o) => o.id)));
}

/** A business's offers, asked of the server now (publishing: which {{buy:<id>}} links are really its). */
export async function offerIdsForPublish(projectId: string): Promise<Set<string>> {
  const offers = await listOffers(projectId);
  useOffers.setState((s) => ({ byProject: { ...s.byProject, [projectId]: offers.filter((o) => o.status !== 'archived') } }));
  return new Set(offers.filter((o) => o.status !== 'archived' && o.status !== 'draft').map((o) => o.id));
}

/** A business's buy links as last loaded: buy:<id> → its full /b/<id> link (for {{buy:<id>}} in emails). */
export function buyLinksOf(projectId: string): Record<string, string> {
  return Object.fromEntries((useOffers.getState().byProject[projectId] ?? []).filter((o) => o.link).map((o) => [`buy:${o.id}`, o.link]));
}

/** buyLinksOf, the business's offers loaded first when they haven't been (an export made away from its page). */
export async function loadBuyLinks(projectId: string): Promise<Record<string, string>> {
  if (!__ARTIFACT_BUILD__ && !useOffers.getState().byProject[projectId]) await useOffers.getState().refresh(projectId);
  return buyLinksOf(projectId);
}

/**
 * A copy of a business's page (Copy HTML, Export HTML): its offer ids asked of the server now, so its Buy buttons
 * get their links even when no offers were loaded yet. Throws, in plain words, when they can't be asked now.
 */
export async function offerIdsForCopy(projectId: string): Promise<Set<string>> {
  if (__ARTIFACT_BUILD__) return new Set();
  try {
    return await offerIdsForPublish(projectId);
  } catch {
    throw new Error('Couldn’t check this page’s buy links. Try again in a moment.');
  }
}

/** The ids of a business's offers as last loaded (for resolving {{buy:<id>}}). */
export function knownOfferIds(projectId: string): Set<string> {
  return new Set((useOffers.getState().byProject[projectId] ?? []).map((o) => o.id));
}

let lastAccount: string | null = null;

/**
 * React: whether offers are on here (the server has them and you're signed in) and a business's offers, loaded
 * when asked for. Another account (or signing out) drops what the one before saw.
 */
export function useProjectOffers(projectId: string | undefined): { on: boolean; checking: boolean; offers: Offer[]; loaded: boolean; whop: boolean; stripe: boolean } {
  const account = useAuth((s) => (s.phase === 'ready' ? s.user?.id ?? '' : ''));
  const config = useOffers((s) => s.config);
  const offers = useOffers((s) => (projectId ? s.byProject[projectId] : undefined));
  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    if (lastAccount !== null && lastAccount !== account) useOffers.getState().reset();
    lastAccount = account;
    if (!useOffers.getState().config) void useOffers.getState().loadConfig();
  }, [account]);
  const on = !__ARTIFACT_BUILD__ && !!account && !!config?.enabled;
  useEffect(() => {
    if (on && projectId) void useOffers.getState().refresh(projectId);
  }, [on, projectId, account]);
  return { on, checking: !__ARTIFACT_BUILD__ && !config, offers: offers ?? [], loaded: !!offers, whop: on && !!(config?.whop.production || config?.whop.sandbox), stripe: on && !!config?.stripe.available };
}
