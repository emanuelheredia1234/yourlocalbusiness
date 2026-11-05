// Running a strategy: the steps one after another as an app-wide job. It keeps going while the owner moves
// around the app (a reload or closing the tab stops it), saves each step to its own project as soon as it's
// done, stops at the first failure and never retries by itself: "Continue" is always the owner's click.
import { create } from 'zustand';
import type { AssetsOut, ContentOut, OutreachOut, PlanOut, PromoteOut, ResearchOut, StepInfo, StrategyAction, StrategyState, StrategyStep } from '@/lib/strategyTypes';
import { beginBusy, endBusy } from '@/lib/busy';
import { tabLabel } from '@/lib/pageTabs';
import { useRuntime } from '@/lib/platform';
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

/**
 * What a run's step that wasn't saved may still cost, for the run's summary (in this tab only; `runAt` is
 * the run's startedAt). A web research step stopped or failed after it was asked: its searches may already
 * be billed, and your server counts an estimate for them, so `usd` is the searches at list price, the most
 * the step may make (`estimate`; the pages it read are billed as tokens on top). A step whose answer arrived
 * but couldn't be used was billed in full: `usd` is what the answer reported.
 */
export interface UnsavedCost {
  runAt: number;
  step: StrategyStep;
  usd: number;
  estimate: boolean;
  /** with `estimate`: the most searches the step may make, and the list price of one */
  searches?: number;
  perSearch?: number;
}

/** One job per project in this browser tab (in memory: a reload ends it), and its last run's unsaved step cost. */
export const useStrategyJobs = create<{ jobs: Record<string, StrategyJob>; unsaved: Record<string, UnsavedCost> }>(() => ({ jobs: {}, unsaved: {} }));
export const useStrategyJob = (projectId: string) => useStrategyJobs((s) => s.jobs[projectId]);
/** The unsaved step cost of a project's last run in this tab (match `runAt` with the run you show). */
export const useUnsavedCost = (projectId: string) => useStrategyJobs((s) => s.unsaved?.[projectId]);
const setUnsaved = (pid: string, cost: UnsavedCost | null) =>
  useStrategyJobs.setState((s) => {
    const { [pid]: _old, ...rest } = s.unsaved ?? {};
    return { unsaved: cost ? { ...rest, [pid]: cost } : rest };
  });

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

/** Stop every run in this tab: another tab took the workspace over, or the owner is logging out (nothing more is spent for a page that's going). */
export function stopAllStrategies(): void {
  for (const job of Object.values(useStrategyJobs.getState().jobs)) job.controller.abort();
}

/** Codes that mean "no AI here" (not a failure of an AI that was asked): the built-in engine may write the whole run. */
export const NO_AI = ['no_provider', 'server_down', 'unavailable', 'not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'];
/** Results that mean the request never reached a key, so nothing was billed: no AI here, your server unreachable, a daily limit. */
const NOT_SENT = new Set([...NO_AI, 'network', 'daily_limit']);

/** A step's sections as their tabs name them: the assets step writes two, “Assets to create” and “SEO page”. */
export const sectionNames = (step: StrategyStep): string[] => (step === 'assets' ? ['assets', 'seo'] : [step]).map((t) => `“${tabLabel('strategy', t)}”`);
/** "a", "a and b", "a, b and c" */
export const listOf = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** The steps whose section an AI wrote: the built-in engine never replaces them unless the owner chose it (startRun asks). */
export function aiWritten(s: StrategyState, steps: StrategyStep[]): StrategyStep[] {
  return steps.filter((k) => !!s[k] && s[k]!.provider !== 'local');
}

/** Why no AI can write the run now (from a step's result code, else from the runtime), and that nothing changed when nothing did. */
export function noAIText(code?: string, unchanged = true): string {
  const cause = code
    ? code === 'no_provider' ? 'key' : code === 'server_down' || code === 'network' ? 'server' : 'claude'
    : __ARTIFACT_BUILD__ ? 'claude' : useRuntime.getState().server === 'down' ? 'server' : 'key';
  const so = unchanged ? ', so nothing was changed' : '';
  if (cause === 'server') return `Your AI server can’t be reached right now${so}. Check that it’s running, then try again.`;
  if (cause === 'key') return `No API key powers Strategy now${so}. In Settings → AI, tick Strategy for one of your keys.`;
  return `Claude isn’t available here right now${so}.`;
}

/**
 * The page is going away (reload, closed tab): the request under way fails as the browser drops it. That's
 * not a failure to report: the run is left as it was, so it shows as stopped "because the page was closed".
 */
let leaving = false;
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => (leaving = true));
  // back from the browser's page cache: this page is in use again
  window.addEventListener('pageshow', () => (leaving = false));
}

/** A failure's note without "the built-in engine answered instead" (here nothing was saved in its place). */
export function stopNote(note: string | undefined): string {
  const kept = sentences(note ?? '')
    .filter((x) => x.trim() && !/built-in engine/i.test(x))
    .join(' ')
    .trim();
  return kept || 'The AI couldn’t write this step.';
}

type StepOut = ResearchOut | PromoteOut | ContentOut | AssetsOut | OutreachOut | PlanOut;

/**
 * Each section's core content. An answer without it (valid JSON in the wrong shape, or everything in it
 * dropped by the checks) is never saved: the step fails and the section stays as it was.
 */
const CORE: Record<StrategyStep, { what: string; has: (out: StepOut) => boolean }> = {
  research: { what: 'findings', has: (o) => (o as ResearchOut).findings.length > 0 || (o as ResearchOut).checks.length > 0 },
  promote: { what: 'places to promote', has: (o) => (o as PromoteOut).channels.length > 0 },
  content: { what: 'content pillars or post ideas', has: (o) => (o as ContentOut).pillars.length + (o as ContentOut).ideas.length + (o as ContentOut).formats.length > 0 },
  assets: {
    what: 'assets or SEO page direction',
    has: (o) => {
      const { assets, seo } = o as AssetsOut;
      return assets.length > 0 || !!(seo.audience || seo.angle || seo.keywords.length || seo.objections.length);
    },
  },
  outreach: { what: 'outreach emails', has: (o) => (o as OutreachOut).templates.length > 0 },
  plan: { what: 'plan steps', has: (o) => (o as PlanOut).actions.length > 0 },
};

/** A plan step's title as ticks follow it across re-plans: case, spaces and punctuation don't count. */
const titleKey = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The owner's ticks that still apply to a new plan: on the same step (same id), else on a step with the same title. */
function keptTicks(st: StrategyState, actions: StrategyAction[]): Record<string, number> {
  const ids = new Set(actions.map((a) => a.id));
  const byTitle = new Map<string, string>();
  for (const a of actions) {
    const key = titleKey(a.title);
    if (key && !byTitle.has(key)) byTitle.set(key, a.id);
  }
  const oldTitle = new Map((st.plan?.actions ?? []).map((a) => [a.id, a.title] as const));
  const ticks = Object.entries(st.ticks);
  const out: Record<string, number> = Object.fromEntries(ticks.filter(([id]) => ids.has(id)));
  for (const [id, at] of ticks) {
    const to = ids.has(id) ? undefined : byTitle.get(titleKey(oldTitle.get(id) ?? ''));
    if (to && !(to in out)) out[to] = at;
  }
  return out;
}

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
    s.plan = { ...info, ...p, startAt: st.plan?.startAt ?? now };
    s.ticks = keptTicks(st, p.actions);
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
 * built-in engine writes every step, free; a run is never half AI and half built-in. The built-in engine
 * never replaces a section an AI wrote unless the owner chose that (`replaceAI`, after startRun's confirm):
 * otherwise the run stops at once and nothing changes. Stops at the first failure without saving that step
 * (an answer without its section's core content counts as one), and never retries.
 */
export async function runStrategy(projectId: string, steps: StrategyStep[] = STRATEGY_STEPS, o: { replaceAI?: boolean } = {}): Promise<'done' | 'stopped' | 'failed' | 'busy' | 'missing'> {
  if (useStrategyJobs.getState().jobs[projectId]) return 'busy';
  if (!project(projectId)) return 'missing';
  const list = steps.filter((x, i, a) => STRATEGY_STEPS.includes(x) && a.indexOf(x) === i);
  if (!list.length) return 'done';
  const controller = new AbortController();
  const startedAt = Date.now();
  useStrategyJobs.setState((s) => ({ jobs: { ...s.jobs, [projectId]: { projectId, steps: list, index: 0, stage: 'Starting…', startedAt, costUsd: 0, searches: 0, requests: 0, controller } } }));
  setUnsaved(projectId, null);
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
  /** the step under way, when it's a web research step: the most searches it may make, and the list price of one */
  let searching: { step: StrategyStep; searches: number; perSearch: number } | null = null;
  /** a web research step that ended unsaved: its searches may be billed */
  const searchesMayBeBilled = () => {
    if (searching) setUnsaved(projectId, { runAt: startedAt, step: searching.step, usd: searching.searches * searching.perSearch, estimate: true, searches: searching.searches, perSearch: searching.perSearch });
  };
  try {
    for (let i = 0; i < list.length; i++) {
      const step = list[i];
      const p = project(projectId);
      if (!p) return (result = 'missing');
      setJob(projectId, { index: i, stage: 'Starting…' });
      const s = readStrategy(p);
      // what the step is written from, as its prompt gets it (details or research changed during the step show as changed)
      const factsHash = strategyFactsHash(p, s.inputs);
      const researchAt = step !== 'research' && s.research ? Math.max(s.research.at, s.manus?.state === 'done' ? s.manus.doneAt ?? 0 : 0) : undefined;
      const store = useStore.getState();
      const who = strategyWho();
      const input = stepInput(step, p, s, { web: who.mode === 'web', posts: store.posts, ads: store.ads, myListings: store.myListings });
      const task = STEP_TASK[step];
      searching = step === 'research' && who.mode === 'web' && who.searchKey && !builtinMode ? { step, searches: s.maxSearches, perSearch: who.searchKey.perSearch } : null;
      let res;
      try {
        // no "fresh take" on a re-run (no variation): a re-plan keeps the steps that still apply in the same words, and their ticks
        res = await runTask(task as never, input as never, {
          project: p,
          skills: s.useBrain ? store.skills : [],
          settings: store.settings,
          signal: controller.signal,
          forceLocal: builtinMode,
          onStage: (t) => setJob(projectId, { stage: t }),
        });
      } catch (e) {
        if (leaving) return (result = 'stopped');
        if ((e as AIError)?.code === 'cancelled' || controller.signal.aborted) {
          if (project(projectId)) writeStrategy(projectId, (st) => (st.run ? { ...st, run: { ...st.run, stoppedAt: step } } : st));
          searchesMayBeBilled();
          return (result = 'stopped');
        }
        throw e;
      }
      if (leaving) return (result = 'stopped');
      const fail = (why: string): 'failed' => {
        note = why;
        failedAt = i + 1;
        if (project(projectId)) writeStrategy(projectId, (st) => (st.run ? { ...st, run: { ...st.run, stoppedAt: step, note } } : st));
        return (result = 'failed');
      };
      if (res.provider === 'local' && !builtinMode) {
        const noAI = !res.code || NO_AI.includes(res.code);
        // the built-in engine stands in only for a run no AI is here for, and over sections an AI wrote only when the owner chose it
        if (noAI && !aiWrote && (o.replaceAI || !aiWritten(s, list).length)) builtinMode = true;
        else {
          if (res.code && !NOT_SENT.has(res.code)) searchesMayBeBilled();
          return fail(noAI ? noAIText(res.code, !aiWrote) : stopNote(res.note));
        }
      }
      // the latest project: a project deleted meanwhile ends the run quietly
      const latest = project(projectId);
      if (!latest) return (result = 'missing');
      const ls = readStrategy(latest);
      const out = renormalize(step, res.data, normCtx(latest, ls, { fallback: res.provider === 'local' ? 'builtin' : 'ai' }));
      // valid JSON in the wrong shape (or all of it dropped by the checks) never replaces a section
      if (!CORE[step].has(out)) {
        const names = sectionNames(step);
        // the answer came back, so it was billed: what it cost (else, for a web research step, its searches' estimate)
        const billed = res.provider !== 'local' ? res.meta?.cost?.usd : undefined;
        if (typeof billed === 'number' && billed > 0) setUnsaved(projectId, { runAt: startedAt, step, usd: billed, estimate: false });
        else if (res.provider !== 'local') searchesMayBeBilled();
        return fail(`The answer had no ${CORE[step].what} the app could use, so ${listOf(names)} ${names.length > 1 ? 'stay as they were' : 'stays as it was'}. Try again.`);
      }
      if (res.provider !== 'local') aiWrote = true;
      const now = Date.now();
      const meta = res.meta ? compactMeta(res.meta) : undefined;
      writeStrategy(projectId, (st) =>
        saveStep(
          st,
          step,
          out,
          { at: now, provider: res.provider, ...(meta ? { meta } : {}), ...(res.note ? { note: res.note } : {}), factsHash, ...(researchAt !== undefined ? { researchAt } : {}), ...(res.skills.length ? { skills: res.skills.map((k) => k.name).slice(0, 6) } : {}) },
          res.meta,
          res.provider,
        ),
      );
      written += 1;
      // saved: its cost is in the section now
      searching = null;
      useStore.getState().recordGeneration({ id: res.id, task: task.id, label: task.label, module: 'strategy', provider: res.provider, skillIds: res.skills.map((k) => k.id), createdAt: now, ms: res.ms, projectId, ...(res.meta ? { meta: compactMeta(res.meta) } : {}) });
      cost += res.meta?.cost?.usd ?? 0;
      const job = useStrategyJobs.getState().jobs[projectId];
      if (job) setJob(projectId, { costUsd: job.costUsd + (res.meta?.cost?.usd ?? 0), searches: job.searches + (res.meta?.searches ?? 0), requests: job.requests + (res.provider !== 'local' ? 1 : 0) });
    }
    return (result = 'done');
  } catch (e) {
    if (leaving) return (result = 'stopped');
    searchesMayBeBilled();
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
