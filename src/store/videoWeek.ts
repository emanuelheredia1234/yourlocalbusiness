// Each business's AI videos this week (src/lib/videoWeek.ts), as the server last answered: read when the video panel
// or the campaign setup opens (at most once a minute per business), and updated by every video the app starts.
// Not persisted: the server is the record. Self-hosted builds with plans shown only.

import { useEffect } from 'react';
import { create } from 'zustand';
import { videoAllowance, type VideoAllowance, type VideoWeek } from '@/lib/videoWeek';
import { browserTimeZone, projectTimeZone } from '@/lib/timeZone';
import { useAuth } from '@/lib/cloud/auth';
import { serverFetch } from '@/ai/claude';
import { billingOn, useBilling, useBillingOn } from './billing';
import { useStore } from './useStore';

const FRESH_MS = 60_000;

interface VideoWeekState {
  byProject: Record<string, VideoWeek & { at: number }>;
  /** Read a business's week from the server (skipped when read in the last minute, unless forced). */
  refresh: (projectId: string, opts?: { force?: boolean }) => Promise<VideoWeek | null>;
  /** What the server answered with a started (or refused) video. */
  set: (projectId: string, w: VideoWeek) => void;
  reset: () => void;
}

const isWeek = (v: unknown): v is VideoWeek => !!v && typeof v === 'object' && typeof (v as VideoWeek).used === 'number' && typeof (v as VideoWeek).resetsAt === 'string';

export const useVideoWeek = create<VideoWeekState>((set, get) => ({
  byProject: {},
  refresh: async (projectId, opts = {}) => {
    if (!projectId || __ARTIFACT_BUILD__ || !billingOn() || useAuth.getState().phase !== 'ready') return null;
    const have = get().byProject[projectId];
    if (have && !opts.force && Date.now() - have.at < FRESH_MS) return have;
    const project = useStore.getState().projects.find((p) => p.id === projectId);
    const q = new URLSearchParams({ projectId, timeZone: projectTimeZone(project), browserTimeZone: browserTimeZone() });
    try {
      const res = await serverFetch(useStore.getState().settings.ai.serverUrl, `/api/ai/video/week?${q}`);
      if (!res.ok) return null;
      const w = (await res.json()) as unknown;
      if (!isWeek(w)) return null;
      get().set(projectId, w);
      return w;
    } catch {
      return null;
    }
  },
  set: (projectId, w) => {
    if (!projectId || !isWeek(w)) return;
    set((s) => ({ byProject: { ...s.byProject, [projectId]: { used: w.used, limit: w.limit ?? null, resetsAt: w.resetsAt, enforced: w.enforced === true, known: w.known !== false, ...(w.scope === 'account' ? { scope: 'account' as const } : {}), ...(typeof w.timeZone === 'string' ? { timeZone: w.timeZone } : {}), at: Date.now() } } }));
  },
  reset: () => set({ byProject: {} }),
}));

/** React: a business's videos this week (read from the server when shown). */
export function useProjectVideoWeek(projectId: string | null | undefined): VideoWeek | null {
  const w = useVideoWeek((s) => (projectId ? (s.byProject[projectId] ?? null) : null));
  useEffect(() => {
    if (projectId) void useVideoWeek.getState().refresh(projectId);
  }, [projectId]);
  return w;
}

/** What the plan allows a business a week (the campaign setup and the assistant warn from it); null with plans hidden. */
export function currentVideoAllowance(): VideoAllowance | null {
  if (__ARTIFACT_BUILD__ || !billingOn()) return null;
  const b = useBilling.getState();
  return videoAllowance(b.plan, b.account);
}

/** React: currentVideoAllowance. */
export function useVideoAllowance(): VideoAllowance | null {
  const on = useBillingOn();
  const plan = useBilling((s) => s.plan);
  const account = useBilling((s) => s.account);
  if (__ARTIFACT_BUILD__ || !on) return null;
  return videoAllowance(plan, account);
}
