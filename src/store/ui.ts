import { create } from 'zustand';
import { uid } from '@/lib/utils';
import { navigate } from '@/lib/router';

/** The Social media engine's tabs (create = Create individual post). */
export type SocialTab = 'setup' | 'plan' | 'batch' | 'create';

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
}

export const useUI = create<UIState>((set) => ({
  toasts: [],
  toast: (t) => {
    const id = uid('t');
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), t.action ? 7000 : 4200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),

  composerPreset: null,
  openComposer: (preset) => {
    set((s) => ({ socialTab: 'create', composerPreset: preset?.topic ? { topic: preset.topic, n: (s.composerPreset?.n ?? 0) + 1 } : s.composerPreset }));
    navigate('marketing-social');
  },
  socialTab: null,
  setSocialTab: (t) => set({ socialTab: t }),

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
}));

export const toast = (t: Omit<Toast, 'id'>) => useUI.getState().toast(t);
