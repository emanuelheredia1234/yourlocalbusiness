// Starting a Strategy run from the page: which steps, and the confirm that says who writes it and what it
// costs (spec §2.5). Paid runs always ask first; with the built-in engine (free) they start right away.
// Nothing here runs by itself or again on its own: every run is one click.
import type { StrategyStep } from '@/lib/strategyTypes';
import { STEP_LABEL, readStrategy } from '@/lib/strategy';
import { tabLabel } from '@/lib/pageTabs';
import { useStore } from '@/store/useStore';
import { confirmAction } from '@/components/ui/primitives';
import { PLAN_STEPS, runStrategy, STRATEGY_STEPS, useStrategyJobs } from '@/ai/strategyJob';
import { strategyWho, type StrategyWho } from '@/ai/strategyWho';

export type RunKind =
  /** Plan my strategy / Update everything (6 steps) */
  | { kind: 'all' }
  /** Search again (research only) */
  | { kind: 'research' }
  /** Update the plan from the research (the 5 steps after it) */
  | { kind: 'plan' }
  /** Refresh one section */
  | { kind: 'refresh'; step: StrategyStep }
  /** Continue a stopped run from step `from` (1-based) */
  | { kind: 'continue'; steps: StrategyStep[]; from: number };

export function stepsOf(k: RunKind): StrategyStep[] {
  switch (k.kind) {
    case 'all':
      return [...STRATEGY_STEPS];
    case 'research':
      return ['research'];
    case 'plan':
      return [...PLAN_STEPS];
    case 'refresh':
      return [k.step];
    case 'continue':
      return k.steps.slice(Math.max(0, k.from - 1));
  }
}

/** Who writes this run and what it costs: one sentence each ("6 steps, 6 requests", "1 request"…). */
export function whoFor(k: RunKind, maxSearches: number): StrategyWho {
  const steps = stepsOf(k);
  return strategyWho({ requests: steps.length, research: steps.includes('research'), maxSearches });
}

const join = (...parts: string[]) => parts.filter(Boolean).join(' ');

/** The confirm's words for a paid run (spec §2.5). */
export function runConfirm(k: RunKind, maxSearches: number): { title: string; body: string; confirmLabel: string } {
  const w = whoFor(k, maxSearches);
  switch (k.kind) {
    case 'all':
      return { title: 'Write your strategy?', body: join(w.who, w.cost, 'Each step is saved as soon as it’s done. Nothing else in your project changes until you choose.'), confirmLabel: 'Write it' };
    case 'research':
      return { title: 'Search the web again?', body: join(w.who, w.cost, 'Your plan stays as it is until you update it.'), confirmLabel: 'Search again' };
    case 'plan':
      return { title: 'Update the plan from the research?', body: join(w.who, w.cost, 'Your ticks stay on steps that are still in the plan.'), confirmLabel: 'Update the plan' };
    case 'refresh': {
      const name = k.step === 'assets' ? '“Assets to create” and “SEO page”' : `“${tabLabel('strategy', k.step) || STEP_LABEL[k.step]}”`;
      return { title: `Refresh ${name}?`, body: join(w.who, w.cost), confirmLabel: 'Refresh' };
    }
    case 'continue':
      return { title: `Continue from step ${k.from}?`, body: join(w.who, w.cost), confirmLabel: 'Continue' };
  }
}

/**
 * Start a run after its confirm (none with the built-in engine: it's free). False when the owner said no,
 * a run is already going for the project, or the app is still checking which key powers Strategy.
 */
export async function startRun(projectId: string, k: RunKind): Promise<boolean> {
  if (useStrategyJobs.getState().jobs[projectId]) return false;
  const p = useStore.getState().projects.find((x) => x.id === projectId);
  if (!p) return false;
  const maxSearches = readStrategy(p).maxSearches;
  const w = whoFor(k, maxSearches);
  if (w.mode === 'checking') return false;
  if (w.mode !== 'builtin' && !(await confirmAction(runConfirm(k, maxSearches)))) return false;
  void runStrategy(projectId, stepsOf(k));
  return true;
}
