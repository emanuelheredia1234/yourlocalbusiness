// Starting a Strategy run from the page: which steps, and the confirm that says who writes it and what it
// costs (spec §2.5). Paid runs always ask first; with the built-in engine (free) they start right away,
// unless it would replace sections an AI wrote: then it says which, and asks. Nothing here runs by itself
// or again on its own: every run is one click.
import { create } from 'zustand';
import type { StrategyState, StrategyStep } from '@/lib/strategyTypes';
import { readStrategy } from '@/lib/strategy';
import { useRuntime } from '@/lib/platform';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { confirmAction } from '@/components/ui/primitives';
import { recheckServer } from '@/ai/claude';
import { PLAN_STEPS, aiWritten, listOf, noAIText, runStrategy, sectionNames, STRATEGY_STEPS, useStrategyJobs } from '@/ai/strategyJob';
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
    case 'refresh':
      return { title: `Refresh ${listOf(sectionNames(k.step))}?`, body: join(w.who, w.cost), confirmLabel: 'Refresh' };
    case 'continue':
      return { title: `Continue from step ${k.from}?`, body: join(w.who, w.cost), confirmLabel: 'Continue' };
  }
}

/** The confirm before the built-in engine (free) replaces sections an AI wrote: which ones, and what goes with them. */
export function replaceConfirm(k: RunKind, s: StrategyState, maxSearches: number): { title: string; body: string; confirmLabel: string; danger: true } {
  const steps = aiWritten(s, stepsOf(k));
  // every tab it changes (the assets step fills two)
  const names = steps.flatMap(sectionNames);
  return {
    title: steps.length === 1 ? `Replace ${listOf(names)} with built-in guidance?` : 'Replace what your AI wrote with built-in guidance?',
    body: join(
      whoFor(k, maxSearches).who,
      `It replaces ${listOf(names)}, which your AI wrote.`,
      steps.includes('research') && s.research?.mode === 'web' ? 'Your web research is replaced by general guidance without sources.' : '',
      steps.includes('plan') ? 'Ticks stay only on steps that are still in the new plan.' : '',
    ),
    confirmLabel: 'Replace',
    danger: true,
  };
}

/** The last run was written by the built-in engine (it never stops halfway on its own: an AI's run is what usually needs Continue). */
const builtinRun = (s: StrategyState) => !!s.run?.done.length && s.run.done.every((k) => s[k]?.provider === 'local');

/** Which button started a run: "all", "research", "plan", "refresh:<step>" or "continue". */
export type RunKey = 'all' | 'research' | 'plan' | 'continue' | `refresh:${StrategyStep}`;
export const runKey = (k: RunKind): RunKey => (k.kind === 'refresh' ? `refresh:${k.step}` : k.kind);

/**
 * Runs waiting on a fresh check of your AI server (it was marked down: the check can take up to 8 seconds)
 * before they ask or start, by project, with the button that started each: that button says so meanwhile.
 */
export const useServerCheck = create<{ checking: Record<string, RunKey> }>(() => ({ checking: {} }));
/** The button whose run is checking your AI server for this project (null when none is). */
export const useCheckingServer = (projectId: string): RunKey | null => useServerCheck((s) => s.checking[projectId] ?? null);
const setChecking = (projectId: string, key: RunKey | null) =>
  useServerCheck.setState((s) => {
    const { [projectId]: _done, ...rest } = s.checking;
    return { checking: key ? { ...rest, [projectId]: key } : rest };
  });
/** What a run button says while its run checks your AI server. */
export const CHECKING_LABEL = 'Checking your AI server…';

/**
 * Start a run after its confirm (none with the built-in engine when it replaces nothing an AI wrote: it's
 * free). Your server, if it was marked down, is asked again first: one dropped request mustn't turn a run
 * built-in. An AI's stopped run never continues with the built-in engine: while the AI is unreachable,
 * Continue says so and changes nothing. False when the owner said no, a run is already going for the
 * project, the app is still checking which key powers Strategy, or the run can't continue.
 */
export async function startRun(projectId: string, k: RunKind): Promise<boolean> {
  if (useStrategyJobs.getState().jobs[projectId]) return false;
  // a server marked down is asked again, which can take a while: the button says so meanwhile
  const slow = !__ARTIFACT_BUILD__ && useRuntime.getState().server === 'down';
  if (slow) setChecking(projectId, runKey(k));
  try {
    await recheckServer(useStore.getState().settings.ai.serverUrl, 0);
  } finally {
    if (slow) setChecking(projectId, null);
  }
  const p = useStore.getState().projects.find((x) => x.id === projectId);
  if (!p || useStrategyJobs.getState().jobs[projectId]) return false;
  const s = readStrategy(p);
  const w = whoFor(k, s.maxSearches);
  if (w.mode === 'checking') return false;
  let replaceAI = false;
  if (w.mode === 'builtin') {
    if (k.kind === 'continue' && !builtinRun(s)) {
      toast({ kind: 'error', title: `Couldn’t continue from step ${k.from}`, body: noAIText() });
      return false;
    }
    if (aiWritten(s, stepsOf(k)).length) {
      if (!(await confirmAction(replaceConfirm(k, s, s.maxSearches)))) return false;
      replaceAI = true;
    }
  } else if (!(await confirmAction(runConfirm(k, s.maxSearches)))) return false;
  void runStrategy(projectId, stepsOf(k), { replaceAI });
  return true;
}
