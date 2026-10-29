import { create } from 'zustand';
import { uid } from '@/lib/utils';

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

  composerOpen: boolean;
  composerPreset: { topic?: string } | null;
  openComposer: (preset?: { topic?: string }) => void;
  closeComposer: () => void;

  commandOpen: boolean;
  setCommandOpen: (v: boolean) => void;

  navOpen: boolean;
  setNavOpen: (v: boolean) => void;

  cartOpen: boolean;
  setCartOpen: (v: boolean) => void;

  checkoutOpen: boolean;
  setCheckoutOpen: (v: boolean) => void;

  listingId: string | null;
  openListing: (id: string | null) => void;

  postEditorId: string | null;
  openPostEditor: (id: string | null) => void;
}

export const useUI = create<UIState>((set) => ({
  toasts: [],
  toast: (t) => {
    const id = uid('t');
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), t.action ? 7000 : 4200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),

  composerOpen: false,
  composerPreset: null,
  openComposer: (preset) => set({ composerOpen: true, composerPreset: preset ?? null }),
  closeComposer: () => set({ composerOpen: false, composerPreset: null }),

  commandOpen: false,
  setCommandOpen: (v) => set({ commandOpen: v }),

  navOpen: false,
  setNavOpen: (v) => set({ navOpen: v }),

  cartOpen: false,
  setCartOpen: (v) => set({ cartOpen: v }),

  checkoutOpen: false,
  setCheckoutOpen: (v) => set({ checkoutOpen: v }),

  listingId: null,
  openListing: (id) => set({ listingId: id }),

  postEditorId: null,
  openPostEditor: (id) => set({ postEditorId: id }),
}));

export const toast = (t: Omit<Toast, 'id'>) => useUI.getState().toast(t);
