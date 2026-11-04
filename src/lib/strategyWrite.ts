// Writing a project's strategy: always a functional update on the latest project (never a copy taken when a
// run started), so ticks and details changed meanwhile are kept, then capped. src/lib/strategy.ts stays pure.
import type { StrategyInputs, StrategyState } from './strategyTypes';
import { useStore } from '@/store/useStore';
import { STRATEGY_CAPS as C, TICK_KEY, clip } from './strategyNormalize';
import { capStrategy, readStrategy } from './strategy';

/** Change one project's strategy (whichever project is open). */
export function writeStrategy(projectId: string, fn: (s: StrategyState) => StrategyState): void {
  useStore.getState().updateProject(projectId, (p) => ({ ...p, strategy: capStrategy({ ...fn(readStrategy(p)), updatedAt: Date.now() }) }));
}

/** The owner's own details (each one cut to its cap; nothing else is touched). */
export function setStrategyInputs(projectId: string, patch: Partial<StrategyInputs>): void {
  writeStrategy(projectId, (s) => {
    const i = { ...s.inputs };
    if (patch.goal !== undefined) i.goal = clip(patch.goal, C.inputs.goal);
    if (patch.budget !== undefined) i.budget = clip(patch.budget, C.inputs.budget);
    if (patch.timePerWeek !== undefined) i.timePerWeek = clip(patch.timePerWeek, C.inputs.timePerWeek);
    if (patch.tried !== undefined) i.tried = clip(patch.tried, C.inputs.tried, true);
    if (patch.notes !== undefined) i.notes = clip(patch.notes, C.inputs.notes, true);
    if (patch.competitors !== undefined)
      i.competitors = patch.competitors
        .map((c) => clip(c, C.inputs.competitor))
        .filter((c, k, a) => c && a.indexOf(c) === k)
        .slice(0, C.inputs.competitors);
    return { ...s, inputs: i };
  });
}

/** "I did this": tick (now) or untick an action of the plan. */
export function tickAction(projectId: string, id: string, on: boolean): void {
  if (!TICK_KEY.test(id)) return;
  writeStrategy(projectId, (s) => {
    if (!s.plan?.actions.some((a) => a.id === id)) return s;
    const ticks = { ...s.ticks };
    if (on) ticks[id] = Date.now();
    else delete ticks[id];
    return { ...s, ticks };
  });
}

/** "Use my Brain skills here" (Strategy only; the other tabs keep using the Brain). */
export const setUseBrain = (projectId: string, on: boolean) => writeStrategy(projectId, (s) => ({ ...s, useBrain: on }));

/** How many web searches the research step may make: 3, 5 or 8. */
export const setMaxSearches = (projectId: string, n: 3 | 5 | 8) => writeStrategy(projectId, (s) => ({ ...s, maxSearches: n === 3 || n === 8 ? n : 5 }));

/** "Start again from week 1". */
export const restartPlan = (projectId: string) => writeStrategy(projectId, (s) => (s.plan ? { ...s, plan: { ...s.plan, startAt: Date.now() } } : s));
