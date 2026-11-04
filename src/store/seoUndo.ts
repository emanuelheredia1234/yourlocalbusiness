// Undo for the sales page's AI changes (Rewrite page, a section rewrite, Edit with AI, new metadata).
// Kept in memory only, per project: it lasts while the app is open in this tab and is never saved with the
// project, so it can't grow the saved workspace. Snapshots hold the page's text and image ids, never image files.

import { create } from 'zustand';
import type { PageType, SalesPage, SeoMeta } from '@/lib/types';

/** What an AI change replaced: the page, its metadata and its type as they were just before. */
export interface SeoSnapshot {
  salesPage: SalesPage | null;
  seo: SeoMeta | null;
  /** the page's type (absent: it had none, which reads as a landing page) */
  pageType?: PageType;
}

/** The most AI changes that can be undone, per project. */
export const UNDO_LIMIT = 15;

interface SeoUndoState {
  stacks: Record<string, SeoSnapshot[]>;
  /** keep the state before an AI change (the oldest goes past UNDO_LIMIT) */
  push: (projectId: string, snapshot: SeoSnapshot) => void;
  /** take back the latest one, if any */
  pop: (projectId: string) => SeoSnapshot | undefined;
}

export const useSeoUndo = create<SeoUndoState>((set, get) => ({
  stacks: {},
  push: (projectId, snapshot) => set((s) => ({ stacks: { ...s.stacks, [projectId]: [...(s.stacks[projectId] ?? []), snapshot].slice(-UNDO_LIMIT) } })),
  pop: (projectId) => {
    const stack = get().stacks[projectId] ?? [];
    const last = stack[stack.length - 1];
    if (last) set((s) => ({ stacks: { ...s.stacks, [projectId]: stack.slice(0, -1) } }));
    return last;
  },
}));
