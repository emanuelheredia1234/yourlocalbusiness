// Running a strategy: the steps one after another as an app-wide job. It keeps going while the owner moves
// around the app (a reload or closing the tab stops it), saves each step to its own project as soon as it's
// done, stops at the first failure and never retries by itself: "Continue" is always the owner's click.
import { create } from 'zustand';
import type { AssetsOut, ContentOut, OutreachOut, PlanOut, PromoteOut, ResearchOut, StepInfo, StrategyState, StrategyStep } from '@/lib/strategyTypes';
import { beginBusy, endBusy } from '@/lib/busy';
import { currentRoute } from '@/lib/router';
import { addSource, normCtx, readStrategy, strategyFactsHash, STRATEGY_STEPS } from '@/lib/strategy';
import { sentences } from '@/lib/strategyNormalize';
import { writeStrategy } from '@/lib/strategyWrite';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import type { AIError } from './claude';
import { runTask } from './engine';
import { compactMeta, fmtUsdSmall, readResearchMeta, type AIMeta } from './meta';
import { openPage } from './assistant/nav';
import { STEP_TASK, renormalize, stepInput } from './strategyTasks';
import { strategyWho } from './strategyWho';

export { STRATEGY_STEPS };

export interface StrategyJob {
  projectId: string;
  steps: StrategyStep[];
  index: number;
  stage: string;
  startedAt: number;
  costUsd: number;
  searches: number;
  requests: number;
  controller: AbortController;
}

/** One job per project in this browser tab (in memory: a reload ends it). */
export const useStrategyJobs = create<{ jobs: Record<string, StrategyJob> }>(() => ({ jobs: {} }));
export const useStrategyJob = (projectId: string) => useStrategyJobs((s) => s.jobs[projectId]);

const setJob = (pid: string, patch: Partial<StrategyJob>) =>
  useStrategyJobs.setState((s) => (s.jobs[pid] ? { jobs: { ...s.jobs, [pid]: { ...s.jobs[pid], ...patch } } } : s));
const removeJob = (pid: string) =>
  useStrategyJobs.setState((s) => {
    const { [pid]: _gone, ...jobs } = s.jobs;
    return { jobs };
  });

/** Stop the run: the request under way is aborted (the server stops it upstream); finished steps stay saved. */
export function stopStrategy(projectId: string): void {
  useStrategyJobs.getState().jobs[projectId]?.controller.abort();
}

/** Codes that mean "no AI here" (not a failure of an AI that was asked): the built-in engine may write the whole run. */
export const NO_AI = ['no_provider', 'server_down', 'unavailable', 'not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'];

/** Fresh wording for each regeneration of a step, per project (as useAI keeps them). */
const variations = new Map<string, number>();

/** A failure's note without "the built-in engine answered instead" (here nothing was saved in its place). */
export function stopNote(note: string | undefined): string {
  const kept = sentences(note ?? '')
    .filter((x) => x.trim() && !/built-in engine/i.test(x))
    .join(' ')
    .trim();
  return kept || 'The AI couldn’t write this step.';
}

type StepOut = ResearchOut | PromoteOut | ContentOut | AssetsOut | OutreachOut | PlanOut;

/** A step's section written into the strategy (sources numbered for research; the plan keeps its start and the ticks that still apply). */
export function saveStep(st: StrategyState, step: StrategyStep, out: StepOut, info: StepInfo, meta: AIMeta | undefined, provider: 'local' | 'claude' | 'server'): StrategyState {
  const s: StrategyState = { ...st, sources: st.sources.map((x) => ({ ...x })), run: st.run ? { ...st.run, done: [...st.run.done] } : st.run };
  const now = info.at;
  if (step === 'research') {
    const r = out as ResearchOut;
    const rm = readResearchMeta(meta?.research);
    const found = new Map((rm?.sources ?? []).map((x) => [x.url, x] as const));
    const findings = r.findings.map((f) => {
      const sources = f.sourceUrls
        .map((u) => found.get(u))
        .filter((x): x is NonNullable<typeof x> => !!x)
        .map((src) => addSource(s, { url: src.url, title: src.title, domain: src.domain, quote: src.quote, pageAge: src.pageAge }, 'search', now))
        .filter((n): n is number => n !== null);
      return sources.length ? { topic: f.topic, text: f.text, basis: 'web' as const, sources } : { topic: f.topic, text: f.text, basis: f.basis === 'web' ? ('ai' as const) : f.basis };
    });
    const mode: 'web' | 'general' | 'builtin' = provider === 'local' ? 'builtin' : provider === 'claude' ? 'general' : rm ? (rm.web ? 'web' : 'general') : 'general';
    const reason = provider === 'local' ? 'builtin' : provider === 'claude' ? 'claude_ai' : rm ? rm.reason : 'unsupported';
    s.research = { ...info, mode, reason, searches: rm?.searches ?? 0, queries: rm?.queries ?? [], summary: r.summary, findings, checks: r.checks };
  } else if (step === 'plan') {
    const p = out as PlanOut;
    const ids = new Set(p.actions.map((a) => a.id));
    s.plan = { ...info, ...p, startAt: st.plan?.startAt ?? now };
    s.ticks = Object.fromEntries(Object.entries(st.ticks).filter(([k]) => ids.has(k)));
  } else if (step === 'promote') s.promote = { ...info, ...(out as PromoteOut) };
  else if (step === 'content') s.content = { ...info, ...(out as ContentOut) };
  else if (step === 'assets') s.assets = { ...info, ...(out as AssetsOut) };
  else s.outreach = { ...info, ...(out as OutreachOut) };
  if (s.run && !s.run.done.includes(step)) s.run.done.push(step);
  return s;
}

const project = (pid: string) => useStore.getState().projects.find((p) => p.id === pid);

/**
 * Run the steps (all six by default) for a project. Each step is one request, saved as soon as it lands.
 * With no AI here at the start (no key powers Strategy, the server is down, Claude isn't available) the
 * built-in engine writes every step, free; a run is never half AI and half built-in. Stops at the first
 * failure without saving that step, and never retries.
 */
export async function runStrategy(projectId: string, steps: StrategyStep[] = STRATEGY_STEPS): Promise<'done' | 'stopped' | 'failed' | 'busy' | 'missing'> {
  if (useStrategyJobs.getState().jobs[projectId]) return 'busy';
  if (!project(projectId)) return 'missing';
  const list = steps.filter((x, i, a) => STRATEGY_STEPS.includes(x) && a.indexOf(x) === i);
  if (!list.length) return 'done';
  const controller = new AbortController();
  const startedAt = Date.now();
  useStrategyJobs.setState((s) => ({ jobs: { ...s.jobs, [projectId]: { projectId, steps: list, index: 0, stage: 'Starting…', startedAt, costUsd: 0, searches: 0, requests: 0, controller } } }));
  const busy = `strategy:${projectId}`;
  beginBusy(busy, 'Strategy', 'app');
  writeStrategy(projectId, (s) => ({ ...s, run: { startedAt, steps: list, done: [] } }));
  let builtinMode = false;
  let aiWrote = false;
  let result: 'done' | 'stopped' | 'failed' | 'missing' = 'done';
  let failedAt = 0;
  let note = '';
  let written = 0;
  let cost = 0;
  try {
    for (let i = 0; i < list.length; i++) {
      const step = list[i];
      const p = project(projectId);
      if (!p) return (result = 'missing');
      setJob(projectId, { index: i, stage: 'Starting…' });
      const s = readStrategy(p);
      const store = useStore.getState();
      const who = strategyWho();
      const input = stepInput(step, p, s, { web: who.mode === 'web', posts: store.posts, ads: store.ads, myListings: store.myListings });
      const task = STEP_TASK[step];
      const vkey = `${step}|${projectId}`;
      const variation = variations.get(vkey) ?? 0;
      variations.set(vkey, variation + 1);
      let res;
      try {
        res = await runTask(task as never, input as never, {
          project: p,
          skills: s.useBrain ? store.skills : [],
          settings: store.settings,
          variation,
          signal: controller.signal,
          forceLocal: builtinMode,
          onStage: (t) => setJob(projectId, { stage: t }),
        });
      } catch (e) {
        if ((e as AIError)?.code === 'cancelled' || controller.signal.aborted) {
          if (project(projectId)) writeStrategy(projectId, (st) => (st.run ? { ...st, run: { ...st.run, stoppedAt: step } } : st));
          return (result = 'stopped');
        }
        throw e;
      }
      if (res.provider === 'local' && !builtinMode) {
        const noAI = !res.code || NO_AI.includes(res.code);
        if (noAI && !aiWrote) builtinMode = true;
        else {
          note = stopNote(res.note);
          failedAt = i + 1;
          if (project(projectId)) writeStrategy(projectId, (st) => (st.run ? { ...st, run: { ...st.run, stoppedAt: step, note } } : st));
          return (result = 'failed');
        }
      }
      if (res.provider !== 'local') aiWrote = true;
      // the latest project: a project deleted meanwhile ends the run quietly
      const latest = project(projectId);
      if (!latest) return (result = 'missing');
      const ls = readStrategy(latest);
      const out = renormalize(step, res.data, normCtx(latest, ls, { fallback: res.provider === 'local' ? 'builtin' : 'ai' }));
      const factsHash = strategyFactsHash(latest, ls.inputs);
      const now = Date.now();
      const meta = res.meta ? compactMeta(res.meta) : undefined;
      writeStrategy(projectId, (st) =>
        saveStep(
          st,
          step,
          out,
          { at: now, provider: res.provider, ...(meta ? { meta } : {}), ...(res.note ? { note: res.note } : {}), factsHash, ...(step !== 'research' && st.research ? { researchAt: Math.max(st.research.at, st.manus?.state === 'done' ? st.manus.doneAt ?? 0 : 0) } : {}), ...(res.skills.length ? { skills: res.skills.map((k) => k.name).slice(0, 6) } : {}) },
          res.meta,
          res.provider,
        ),
      );
      written += 1;
      useStore.getState().recordGeneration({ id: res.id, task: task.id, label: task.label, module: 'strategy', provider: res.provider, skillIds: res.skills.map((k) => k.id), createdAt: now, ms: res.ms, projectId, ...(res.meta ? { meta: compactMeta(res.meta) } : {}) });
      cost += res.meta?.cost?.usd ?? 0;
      const job = useStrategyJobs.getState().jobs[projectId];
      if (job) setJob(projectId, { costUsd: job.costUsd + (res.meta?.cost?.usd ?? 0), searches: job.searches + (res.meta?.searches ?? 0), requests: job.requests + (res.provider !== 'local' ? 1 : 0) });
    }
    return (result = 'done');
  } catch (e) {
    note = stopNote((e as Error)?.message);
    result = 'failed';
    const at = Math.min(list.length - 1, useStrategyJobs.getState().jobs[projectId]?.index ?? 0);
    failedAt = at + 1;
    if (project(projectId)) writeStrategy(projectId, (st) => (st.run ? { ...st, run: { ...st.run, stoppedAt: list[at], note } } : st));
    return 'failed';
  } finally {
    if (result === 'done' && project(projectId)) writeStrategy(projectId, (st) => (st.run ? { ...st, run: { ...st.run, finishedAt: Date.now() } } : st));
    endBusy(busy);
    removeJob(projectId);
    notifyEnd(projectId, result, { written, cost, failedAt, note });
  }
}

/** The toast (and, from elsewhere, a notice) when a run ends. Stopping says nothing. */
function notifyEnd(pid: string, result: 'done' | 'stopped' | 'failed' | 'missing', o: { written: number; cost: number; failedAt: number; note: string }) {
  const p = project(pid);
  if (!p || result === 'stopped' || result === 'missing') return;
  const brand = p.brand.name || 'Your project';
  const active = useStore.getState().activeProjectId === pid;
  if (result === 'failed') {
    toast({ kind: 'error', title: `Strategy stopped at step ${o.failedAt || 1}`, body: o.note });
    return;
  }
  const parts = `${o.written} part${o.written === 1 ? '' : 's'}`;
  toast({ kind: 'ai', title: 'Your strategy is ready', body: `${brand}: ${parts} written${o.cost > 0 ? ` · ≈${fmtUsdSmall(o.cost)}` : ''}`, action: active ? { label: 'Open', run: () => void openPage('strategy', 'plan') } : undefined });
  if (currentRoute() !== 'strategy' || !active) useStore.getState().notify({ kind: 'ai', title: `Strategy ready for ${brand}`, body: `${parts} written.`, route: 'strategy' });
}

/** The five steps after the research ("Update the plan from the research"). */
export const PLAN_STEPS: StrategyStep[] = ['promote', 'content', 'assets', 'outreach', 'plan'];
