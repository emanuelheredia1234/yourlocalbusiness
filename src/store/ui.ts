import { useEffect } from 'react';
import { create } from 'zustand';
import { uid } from '@/lib/utils';
import { navigate, type Route } from '@/lib/router';
import type { PageType } from '@/lib/types';

/** The Social media engine's tabs (create = Create individual post; analytics = the Analytics tab). */
export type SocialTab = 'setup' | 'plan' | 'batch' | 'create' | 'abtests' | 'analytics';

export interface Toast {
  id: string;
  title: string;
  body?: string;
  kind: 'success' | 'info' | 'error' | 'ai';
  action?: { label: string; run: () => void };
}

interface UIState {
  toasts: Toast[];
  toast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;

  /** a topic to start a new "Create individual post" draft from (n changes with each one) */
  composerPreset: { topic?: string; n: number } | null;
  /** Open "Create individual post" in the Social media engine. A topic starts a new draft with it; without one, the draft you had stays. */
  openComposer: (preset?: { topic?: string }) => void;
  /** the Social media engine tab to show next */
  socialTab: SocialTab | null;
  setSocialTab: (t: SocialTab | null) => void;
  /** a page type to open the SEO page builder with (n changes with each request); the builder takes it once */
  seoPreset?: { pageType: PageType; n: number };
  /**
   * Open the SEO page builder, with a page type chosen. Nothing is written by itself: the owner presses Write
   * page, or confirms a switch. `open` opens the page (default: navigate, through the leave guard). Resolves
   * false when the owner chose to stay where they were.
   */
  openSeoBuilder: (preset?: { pageType?: PageType }, open?: (route: Route) => Promise<boolean>) => Promise<boolean>;

  commandOpen: boolean;
  setCommandOpen: (v: boolean) => void;

  navOpen: boolean;
  setNavOpen: (v: boolean) => void;



  listingId: string | null;
  openListing: (id: string | null) => void;

  postEditorId: string | null;
  openPostEditor: (id: string | null) => void;

  /** a Settings tab to open next (e.g. "account" from the account menu) */
  settingsTab: string | null;
  setSettingsTab: (t: string | null) => void;

  /** a tab to show next on another tabbed page (Studio, Brain, Calendar, Email, Marketplace): the page takes it (see useTabRequest) */
  pageTab: { route: Route; tab: string } | null;
  requestTab: (route: Route, tab: string) => void;

  /** a Publish panel to bring into view (the SEO page's, or a code asset's), asked for from elsewhere (the assistant); n changes with each request, and the page takes it once */
  publishRequest: PublishRequest | null;
  /** Ask the open page to show this Publish panel. Nothing is published: the owner chooses the address and presses Publish there. */
  requestPublish: (r: { page: 'seo' } | { page: 'asset'; assetId: string }) => void;

  /** a code asset to open in Studio → Code & assets, asked for from elsewhere (a page from Manus or Viktor was just added); n changes with each request, and the tab takes it once */
  assetRequest: { assetId: string; n: number } | null;
  /** Ask Studio → Code & assets to open this asset (open the tab first). */
  requestAsset: (assetId: string) => void;
}

export type PublishRequest = { page: 'seo'; n: number } | { page: 'asset'; assetId: string; n: number };

export const useUI = create<UIState>((set) => ({
  toasts: [],
  toast: (t) => {
    const id = uid('t');
    // at most 3 on screen; errors stay longest, then anything with an action
    set((s) => ({ toasts: [...s.toasts.slice(-2), { ...t, id }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), t.kind === 'error' ? 8000 : t.action ? 6000 : 4000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),

  composerPreset: null,
  openComposer: (preset) => {
    void navigate('marketing-social').then((ok) => {
      if (!ok) return;
      set((s) => ({ socialTab: 'create', composerPreset: preset?.topic ? { topic: preset.topic, n: (s.composerPreset?.n ?? 0) + 1 } : s.composerPreset }));
      try {
        document.getElementById('main-scroll')?.scrollTo({ top: 0 });
      } catch {
        /* not in a browser */
      }
    });
  },
  socialTab: null,
  setSocialTab: (t) => set({ socialTab: t }),
  seoPreset: undefined,
  openSeoBuilder: async (preset, open = (route) => navigate(route)) => {
    const ok = await open('marketing-seo');
    const pageType = preset?.pageType;
    if (!ok || !pageType) return ok;
    set((s) => ({ seoPreset: { pageType, n: (s.seoPreset?.n ?? 0) + 1 } }));
    try {
      document.getElementById('main-scroll')?.scrollTo({ top: 0 });
    } catch {
      /* not in a browser */
    }
    return true;
  },

  commandOpen: false,
  setCommandOpen: (v) => set({ commandOpen: v }),

  navOpen: false,
  setNavOpen: (v) => set({ navOpen: v }),



  listingId: null,
  openListing: (id) => set({ listingId: id }),

  postEditorId: null,
  openPostEditor: (id) => set({ postEditorId: id }),

  settingsTab: null,
  setSettingsTab: (t) => set({ settingsTab: t }),

  pageTab: null,
  requestTab: (route, tab) => set({ pageTab: { route, tab } }),

  publishRequest: null,
  requestPublish: (r) => set((s) => ({ publishRequest: { ...r, n: (s.publishRequest?.n ?? 0) + 1 } })),

  assetRequest: null,
  requestAsset: (assetId) => set((s) => ({ assetRequest: { assetId, n: (s.assetRequest?.n ?? 0) + 1 } })),
}));

export const toast = (t: Omit<Toast, 'id'>) => useUI.getState().toast(t);

/**
 * A tabbed page takes a tab asked for from elsewhere (the assistant, a link): once, and only when it's
 * one of its own tabs. `show` is the page's own tab setter.
 */
export function useTabRequest<T extends string>(route: Route, tabs: readonly T[], show: (tab: T) => void): void {
  const wanted = useUI((s) => s.pageTab);
  useEffect(() => {
    if (!wanted || wanted.route !== route) return;
    useUI.setState({ pageTab: null });
    if ((tabs as readonly string[]).includes(wanted.tab)) show(wanted.tab as T);
  }, [wanted]); // eslint-disable-line react-hooks/exhaustive-deps
}
