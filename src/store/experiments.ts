// A/B tests as the server last said, per business (memory only: the server is the record). The experiment card, the
// A/B tests tab, the analytics surfaces and the assistant read from here; each change the server answers replaces the
// one test it is about. Trial Reel eligibility is kept per business for 10 minutes (the server caches its own read).

import { useEffect } from 'react';
import { create } from 'zustand';
import { experimentErrorCopy, getTrialEligibility, listExperiments } from '@/lib/experiments/api';
import { useExperimentsOn } from '@/lib/experiments/config';
import { useAuth } from '@/lib/cloud/auth';
import { navigate } from '@/lib/router';
import { useUI } from './ui';
import type { Experiment, ExperimentUsage, TrialEligibility } from '@/lib/types';

export interface ExperimentsEntry {
  experiments: Experiment[];
  usage: ExperimentUsage | null;
  loading: boolean;
  error: string;
  at: number;
}

const EMPTY: ExperimentsEntry = { experiments: [], usage: null, loading: false, error: '', at: 0 };
const ELIGIBILITY_MS = 10 * 60_000;

interface ExperimentsStore {
  byProject: Record<string, ExperimentsEntry>;
  eligibility: Record<string, { value: TrialEligibility | null; at: number; loading: boolean }>;
  /** the card open in the A/B tests tab (a morning action or a badge opens it) */
  openId: string | null;
  load: (projectId: string, force?: boolean) => Promise<void>;
  upsert: (e: Experiment) => void;
  drop: (projectId: string, id: string) => void;
  setUsage: (projectId: string, usage: ExperimentUsage) => void;
  loadEligibility: (projectId: string, force?: boolean) => Promise<TrialEligibility | null>;
  open: (id: string | null) => void;
  reset: () => void;
}

const seq = new Map<string, number>();

export const useExperiments = create<ExperimentsStore>((set, get) => ({
  byProject: {},
  eligibility: {},
  openId: null,
  async load(projectId, force = false) {
    const cur = get().byProject[projectId];
    if (cur?.loading || (!force && cur && Date.now() - cur.at < 30_000)) return;
    const n = (seq.get(projectId) ?? 0) + 1;
    seq.set(projectId, n);
    set((s) => ({ byProject: { ...s.byProject, [projectId]: { ...(s.byProject[projectId] ?? EMPTY), loading: true, error: '' } } }));
    try {
      const got = await listExperiments(projectId);
      if (seq.get(projectId) !== n) return;
      set((s) => ({ byProject: { ...s.byProject, [projectId]: { experiments: got.experiments ?? [], usage: got.usage ?? null, loading: false, error: '', at: Date.now() } } }));
    } catch (e) {
      if (seq.get(projectId) !== n) return;
      set((s) => ({ byProject: { ...s.byProject, [projectId]: { ...(s.byProject[projectId] ?? EMPTY), loading: false, error: experimentErrorCopy(e), at: Date.now() } } }));
    }
  },
  upsert(e) {
    set((s) => {
      const cur = s.byProject[e.projectId] ?? EMPTY;
      const has = cur.experiments.some((x) => x.id === e.id);
      const experiments = has ? cur.experiments.map((x) => (x.id === e.id ? e : x)) : [e, ...cur.experiments];
      return { byProject: { ...s.byProject, [e.projectId]: { ...cur, experiments } } };
    });
  },
  drop(projectId, id) {
    set((s) => {
      const cur = s.byProject[projectId] ?? EMPTY;
      return { byProject: { ...s.byProject, [projectId]: { ...cur, experiments: cur.experiments.filter((x) => x.id !== id) } } };
    });
  },
  setUsage(projectId, usage) {
    set((s) => ({ byProject: { ...s.byProject, [projectId]: { ...(s.byProject[projectId] ?? EMPTY), usage } } }));
  },
  async loadEligibility(projectId, force = false) {
    const cur = get().eligibility[projectId];
    if (cur?.loading) return cur.value;
    if (!force && cur?.value && Date.now() - cur.at < ELIGIBILITY_MS) return cur.value;
    set((s) => ({ eligibility: { ...s.eligibility, [projectId]: { value: cur?.value ?? null, at: cur?.at ?? 0, loading: true } } }));
    let value: TrialEligibility | null;
    try {
      value = await getTrialEligibility(projectId);
    } catch {
      value = { eligible: 'unknown', reason: 'unreadable' };
    }
    set((s) => ({ eligibility: { ...s.eligibility, [projectId]: { value, at: Date.now(), loading: false } } }));
    return value;
  },
  open(id) {
    set({ openId: id });
  },
  reset() {
    seq.clear();
    set({ byProject: {}, eligibility: {}, openId: null });
  },
}));

/** The test a post is a version in (from the post's own reference). */
export const experimentOf = (projectId: string, id: string | undefined): Experiment | undefined => (id ? useExperiments.getState().byProject[projectId]?.experiments.find((e) => e.id === id) : undefined);

let lastAccount: string | null = null;
const EMPTY_LIST: Experiment[] = [];

/**
 * A business's A/B tests, loaded when A/B tests are on (signed in, the server has them; never in the claude.ai build).
 * Another account (or signing out) drops what the one before saw.
 */
export function useProjectExperiments(projectId: string | undefined): { on: boolean; experiments: Experiment[]; usage: ExperimentUsage | null; loading: boolean; error: string; loaded: boolean } {
  const on = useExperimentsOn();
  const account = useAuth((s) => (s.phase === 'ready' ? (s.user?.id ?? '') : ''));
  const entry = useExperiments((s) => (projectId ? s.byProject[projectId] : undefined));
  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    if (lastAccount !== null && lastAccount !== account) useExperiments.getState().reset();
    lastAccount = account;
  }, [account]);
  useEffect(() => {
    if (on && projectId) void useExperiments.getState().load(projectId);
  }, [on, projectId, account]);
  return { on, experiments: on ? (entry?.experiments ?? EMPTY_LIST) : EMPTY_LIST, usage: entry?.usage ?? null, loading: !!entry?.loading, error: entry?.error ?? '', loaded: !!entry && !entry.loading && !entry.error };
}

/** Open a test's card: Social › A/B tests, with that test open (a badge, a morning action, the assistant). */
export function openExperimentCard(id: string): Promise<boolean> {
  return navigate('marketing-social').then((ok) => {
    if (ok) {
      useUI.getState().setSocialTab('abtests');
      useExperiments.getState().open(id);
    }
    return ok;
  });
}
