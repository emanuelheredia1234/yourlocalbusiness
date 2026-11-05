// The Strategy run: six steps one after another, each saved to its own project as soon as it lands, the
// generation log, a stop at the first failure without saving that step, built-in mode when no AI is here,
// Stop, one run per project, and the per-project Brain switch. The store is real; your server is a fake fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Skill } from '@/lib/types';
import type { StrategyState, StrategyStep } from '@/lib/strategyTypes';
import { NO_AI_SERVER, useRuntime } from '@/lib/platform';
import { useBusy } from '@/lib/busy';
import { useStore } from '@/store/useStore';
import { defaultSettings } from '@/store/defaults';
import { newSkill } from './brain';
import { readStrategy, stale, strategyFactsHash } from '@/lib/strategy';
import { setMaxSearches, setStrategyInputs, tickAction, writeStrategy } from '@/lib/strategyWrite';
import { useUI } from '@/store/ui';
import { STRATEGY_QA, qaMeta, qaProject, qaResearchMeta, qaSavedStrategy } from '@/test/strategyQa';

vi.mock('./engine', async (orig) => {
  const m = await orig<typeof import('./engine')>();
  return { ...m, runTask: vi.fn(m.runTask) };
});

import { runTask } from './engine';
import { PLAN_STEPS, runStrategy, saveStep, stopStrategy, useStrategyJobs } from './strategyJob';

const fetchMock = vi.fn();
const runs = vi.mocked(runTask);
const voice: Skill = { ...newSkill({ name: 'QA Bakery brand voice', scope: ['all'], instructions: 'Warm and plain.' }), id: 'skill_voice' };
const ANTHROPIC = { id: 'anthropic', label: 'Anthropic Claude', ready: true, models: { text: 'claude-opus-5-5' }, effort: { text: { id: 'medium', label: 'Medium' } }, research: { perSearch: 0.01 } };

type Fail = 'daily' | 'abort' | 'stop' | 'network' | 'upstream';
/**
 * Your server, faked: each step's QA answer (or `reply[step]` instead), the failures asked for, and its health
 * check (the same key powers Strategy).
 */
function answer(o: { fail?: Partial<Record<StrategyStep, Fail>>; onStep?: (step: StrategyStep) => void; reply?: Partial<Record<StrategyStep, unknown>> } = {}) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith('/api/health')) return new Response(JSON.stringify({ ok: true, ai: { ready: true, routing: { strategy: ['anthropic'] }, providers: [ANTHROPIC] } }), { status: 200 });
    const body = JSON.parse(String(init.body));
    const step = /\[ylb-strategy:(\w+) v1\]/.exec(body.prompt)?.[1] as StrategyStep;
    o.onStep?.(step);
    const fail = o.fail?.[step];
    if (fail === 'network') throw new TypeError('Failed to fetch');
    if (fail === 'daily') return new Response(JSON.stringify({ error: 'You’ve reached today’s limit on the app’s AI keys.', code: 'DAILY_LIMIT' }), { status: 429 });
    if (fail === 'upstream') return new Response(JSON.stringify({ error: 'Anthropic Claude took too long to answer.', code: 'TIMEOUT' }), { status: 504 });
    if (fail === 'stop' || fail === 'abort') {
      if (fail === 'stop') setTimeout(() => stopStrategy('p1'), 0);
      return new Promise((_res, rej) => {
        const aborted = () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (init.signal?.aborted) aborted();
        else init.signal?.addEventListener('abort', aborted);
      });
    }
    const meta = step === 'research' ? qaMeta(qaResearchMeta()) : qaMeta();
    const value = o.reply && step in o.reply ? o.reply[step] : STRATEGY_QA[step];
    return new Response(JSON.stringify({ text: JSON.stringify(value), meta }), { status: 200 });
  });
}

const strategyOf = (id: string): StrategyState => readStrategy(useStore.getState().projects.find((p) => p.id === id)!);
const projectOf = (id: string) => useStore.getState().projects.find((p) => p.id === id)!;
/** The step of each request to your server (its health checks left out), and each prompt. */
const generateCalls = () => fetchMock.mock.calls.filter(([, init]) => !!init?.body).map(([, init]) => JSON.parse(String(init.body)) as { prompt: string });
const stepsCalled = () => generateCalls().map((b) => /\[ylb-strategy:(\w+) v1\]/.exec(b.prompt)?.[1]);

beforeEach(() => {
  fetchMock.mockReset();
  runs.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  const p1: Project = qaProject('p1');
  const p2: Project = { ...qaProject('p2'), brand: { ...qaProject('p2').brand, name: 'Other Shop' } };
  useStore.setState({ projects: [p1, p2], activeProjectId: 'p1', genLog: [], skills: [voice], settings: defaultSettings(), posts: [], ads: [], myListings: [], notices: [] });
  useRuntime.getState().set({ server: 'ok', ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: { strategy: ['anthropic'] }, providers: [ANTHROPIC] } });
  useStrategyJobs.setState({ jobs: {} });
  useUI.setState({ toasts: [] });
});
afterEach(() => vi.unstubAllGlobals());

describe('a full run', () => {
  it('saves each section as it lands, logs 6 generations, and ends cleanly', async () => {
    let researchBeforePromote = false;
    let busyDuring: unknown = null;
    answer({
      onStep: (step) => {
        if (step === 'promote') researchBeforePromote = !!strategyOf('p1').research;
        busyDuring ??= Object.values(useBusy.getState().jobs);
      },
    });
    expect(await runStrategy('p1')).toBe('done');
    expect(stepsCalled()).toEqual(['research', 'promote', 'content', 'assets', 'outreach', 'plan']);
    expect(researchBeforePromote).toBe(true);
    const s = strategyOf('p1');
    for (const k of ['research', 'promote', 'content', 'assets', 'outreach', 'plan'] as const) expect(s[k]?.provider).toBe('server');
    expect(s.research).toMatchObject({ mode: 'web', searches: 1 });
    expect(s.sources.map((x) => x.n)).toEqual([1, 2]);
    expect(s.run).toMatchObject({ steps: ['research', 'promote', 'content', 'assets', 'outreach', 'plan'], done: ['research', 'promote', 'content', 'assets', 'outreach', 'plan'] });
    expect(s.run!.finishedAt).toBeGreaterThan(0);
    const log = useStore.getState().genLog;
    expect(log).toHaveLength(6);
    expect(log.every((g) => g.module === 'strategy' && g.projectId === 'p1' && g.provider === 'server')).toBe(true);
    expect(log.map((g) => g.task).sort()).toEqual(['strategyAssets', 'strategyContent', 'strategyOutreach', 'strategyPlan', 'strategyPromote', 'strategyResearch']);
    // an app-wide job while it ran (pages can change), gone after
    expect(busyDuring).toEqual([{ id: 'strategy:p1', label: 'Strategy', scope: 'app' }]);
    expect(Object.keys(useBusy.getState().jobs)).toEqual([]);
    expect(useStrategyJobs.getState().jobs).toEqual({});
    // the research request asked for the search; the others didn't
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies[0].research).toEqual({ web: true, maxSearches: 5, location: { city: 'Austin', region: 'Texas' } });
    expect(bodies.slice(1).every((b) => !('research' in b))).toBe(true);
  });

  it('stops at a daily limit on step 3: steps 1-2 kept, step 3 not saved, nothing after it asked', async () => {
    answer({ fail: { content: 'daily' } });
    expect(await runStrategy('p1')).toBe('failed');
    const s = strategyOf('p1');
    expect(s.research).toBeDefined();
    expect(s.promote).toBeDefined();
    expect(s.content).toBeUndefined();
    expect(s.run).toMatchObject({ stoppedAt: 'content', done: ['research', 'promote'] });
    expect(s.run!.note).toBeTruthy();
    expect(s.run!.note).not.toMatch(/built-in engine/);
    expect(s.run!.finishedAt).toBeUndefined();
    expect(runs).toHaveBeenCalledTimes(3);
    expect(useStore.getState().genLog).toHaveLength(2);
  });

  it('with no key for Strategy, the built-in engine writes all six for free', async () => {
    useRuntime.getState().set({ ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: {} } });
    expect(await runStrategy('p1')).toBe('done');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runs.mock.calls.map(([, , o]) => !!o.forceLocal)).toEqual([false, true, true, true, true, true]);
    const s = strategyOf('p1');
    for (const k of ['research', 'promote', 'content', 'assets', 'outreach', 'plan'] as const) expect(s[k]?.provider).toBe('local');
    expect(s.research).toMatchObject({ mode: 'builtin', reason: 'builtin' });
    expect(s.research!.checks.length).toBeGreaterThan(0);
  });

  it('keeps writing to its own project when another one is opened meanwhile', async () => {
    answer({ onStep: (step) => step === 'promote' && useStore.setState({ activeProjectId: 'p2' }) });
    expect(await runStrategy('p1')).toBe('done');
    expect(strategyOf('p1').plan).toBeDefined();
    expect(useStore.getState().projects.find((p) => p.id === 'p2')!.strategy).toBeUndefined();
    // the owner is elsewhere: a notice names the brand
    expect(useStore.getState().notices[0]).toMatchObject({ title: 'Strategy ready for QA Bakery', route: 'strategy' });
  });

  it('keeps a tick made while it runs', async () => {
    const saved = qaSavedStrategy(useStore.getState().projects[0]);
    useStore.getState().updateProject('p1', (p) => ({ ...p, strategy: saved }));
    const id = saved.plan!.actions[3].id;
    answer({ onStep: (step) => step === 'content' && tickAction('p1', id, true) });
    expect(await runStrategy('p1')).toBe('done');
    expect(strategyOf('p1').ticks[id]).toBeGreaterThan(0);
    // the plan keeps its start date across a re-plan
    expect(strategyOf('p1').plan!.startAt).toBe(saved.plan!.startAt);
  });

  it('Stop: the request is aborted, the steps before it stay, no toast of failure', async () => {
    answer({ fail: { content: 'stop' } });
    expect(await runStrategy('p1')).toBe('stopped');
    const s = strategyOf('p1');
    expect(s.promote).toBeDefined();
    expect(s.content).toBeUndefined();
    expect(s.run).toMatchObject({ stoppedAt: 'content' });
    expect(s.run!.note).toBeUndefined();
  });

  it('one run per project: a second start is "busy"', async () => {
    answer();
    const first = runStrategy('p1');
    expect(await runStrategy('p1')).toBe('busy');
    expect(await first).toBe('done');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('"Use my Brain skills here" off: no skills reach the steps', async () => {
    useStore.getState().updateProject('p1', (p) => ({ ...p, strategy: { ...readStrategy(p), useBrain: false } }));
    answer();
    await runStrategy('p1', ['promote']);
    expect(runs.mock.calls[0][2].skills).toEqual([]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).prompt).not.toContain('QA Bakery brand voice');
    useStore.getState().updateProject('p1', (p) => ({ ...p, strategy: { ...readStrategy(p), useBrain: true } }));
    runs.mockClear();
    fetchMock.mockClear();
    await runStrategy('p1', ['promote']);
    expect(runs.mock.calls[0][2].skills).toEqual([voice]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).prompt).toContain('QA Bakery brand voice');
  });

  it('a deleted project ends the run quietly', async () => {
    answer({ onStep: (step) => step === 'promote' && useStore.setState({ projects: useStore.getState().projects.filter((p) => p.id !== 'p1') }) });
    expect(await runStrategy('p1')).toBe('missing');
    expect(Object.keys(useBusy.getState().jobs)).toEqual([]);
  });
});

describe('the built-in engine never takes over what an AI wrote on its own', () => {
  /** A full run from your AI, every plan step ticked: what a blip must not wipe out. */
  async function aiStrategy() {
    answer();
    expect(await runStrategy('p1')).toBe('done');
    for (const a of strategyOf('p1').plan!.actions) tickAction('p1', a.id, true);
    return strategyOf('p1');
  }

  it('a request that can’t reach your server stops the run there; while it stays unreachable, the next run changes nothing', async () => {
    const before = await aiStrategy();
    answer({ fail: { promote: 'network' } });
    expect(await runStrategy('p1')).toBe('failed');
    expect(useRuntime.getState().server).toBe('down');
    const mid = strategyOf('p1');
    expect(mid.run).toMatchObject({ stoppedAt: 'promote', note: 'Your AI server could not be reached (is it running?).' });
    for (const k of PLAN_STEPS) expect(mid[k]).toEqual(before[k]);
    // "Continue from step 2" straight away: no request, no built-in sections in place of the AI's
    fetchMock.mockClear();
    expect(await runStrategy('p1', PLAN_STEPS)).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
    const after = strategyOf('p1');
    for (const k of ['research', ...PLAN_STEPS] as const) expect(after[k]).toEqual(mid[k]);
    expect(after.ticks).toEqual(before.ticks);
    expect(after.sources).toEqual(mid.sources);
    expect(after.run).toMatchObject({ stoppedAt: 'promote', note: 'Your AI server can’t be reached right now, so nothing was changed. Check that it’s running, then try again.' });
    expect(useUI.getState().toasts.at(-1)).toMatchObject({ kind: 'error', title: 'Strategy stopped at step 1' });
  });

  it('the key is taken off Strategy halfway: the run stops there, keeps what the AI wrote, and says why', async () => {
    answer({ onStep: (step) => step === 'research' && useRuntime.getState().set({ ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: {} } }) });
    expect(await runStrategy('p1')).toBe('failed');
    const s = strategyOf('p1');
    expect(s.research?.provider).toBe('server');
    expect(s.promote).toBeUndefined();
    expect(s.run).toMatchObject({ stoppedAt: 'promote', done: ['research'], note: 'No API key powers Strategy now. In Settings → AI, tick Strategy for one of your keys.' });
  });

  it('with no key for Strategy: only when the owner chose it (replaceAI) does the built-in engine replace the AI’s sections', async () => {
    const before = await aiStrategy();
    useRuntime.getState().set({ ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: {} } });
    expect(await runStrategy('p1')).toBe('failed');
    expect(strategyOf('p1').research).toEqual(before.research);
    expect(strategyOf('p1').plan).toEqual(before.plan);
    expect(strategyOf('p1').sources).toHaveLength(2);
    expect(strategyOf('p1').run!.note).toBe('No API key powers Strategy now, so nothing was changed. In Settings → AI, tick Strategy for one of your keys.');
    expect(await runStrategy('p1', undefined, { replaceAI: true })).toBe('done');
    const s = strategyOf('p1');
    for (const k of ['research', 'promote', 'content', 'assets', 'outreach', 'plan'] as const) expect(s[k]?.provider).toBe('local');
    expect(s.research).toMatchObject({ mode: 'builtin' });
  });
});

describe('an answer in the wrong shape never replaces a section', () => {
  it('an answer wrapped in one key ({"plan": {…}}) is read as the answer inside it', async () => {
    answer();
    await runStrategy('p1');
    for (const a of strategyOf('p1').plan!.actions) tickAction('p1', a.id, true);
    answer({ reply: { research: { research: STRATEGY_QA.research }, plan: { plan: STRATEGY_QA.plan } } });
    expect(await runStrategy('p1', ['research', 'plan'])).toBe('done');
    const s = strategyOf('p1');
    expect(s.research).toMatchObject({ mode: 'web', summary: STRATEGY_QA.research.summary });
    expect(s.research!.findings).toHaveLength(4);
    expect(s.plan!.actions).toHaveLength(5);
    expect(Object.keys(s.ticks)).toHaveLength(5);
  });

  it('an answer without the section’s core content stops the run at that step: the section and its ticks stay as they were', async () => {
    answer();
    await runStrategy('p1');
    for (const a of strategyOf('p1').plan!.actions) tickAction('p1', a.id, true);
    const before = strategyOf('p1');
    answer({ reply: { plan: { answer: 'Here is your plan.' } } });
    expect(await runStrategy('p1', ['plan'])).toBe('failed');
    expect(strategyOf('p1').plan).toEqual(before.plan);
    expect(strategyOf('p1').ticks).toEqual(before.ticks);
    expect(strategyOf('p1').run).toMatchObject({ stoppedAt: 'plan', note: 'The answer had no plan steps the app could use, so “Plan” stays as it was. Try again.' });
    expect(useUI.getState().toasts.at(-1)).toMatchObject({ kind: 'error', title: 'Strategy stopped at step 1' });
    // research with no findings: the web research and its sources stay
    answer({ reply: { research: { summary: '', findings: 'none' } } });
    expect(await runStrategy('p1', ['research', 'plan'])).toBe('failed');
    expect(strategyOf('p1').research).toEqual(before.research);
    expect(strategyOf('p1').sources).toEqual(before.sources);
    expect(stepsCalled().slice(-1)).toEqual(['research']);
    expect(useStore.getState().genLog).toHaveLength(6);
    // the assets step fills two tabs: the note names both
    answer({ reply: { assets: { assets: [], seo: {} } } });
    expect(await runStrategy('p1', ['assets'])).toBe('failed');
    expect(strategyOf('p1').assets).toEqual(before.assets);
    expect(strategyOf('p1').run?.note).toBe('The answer had no assets or SEO page direction the app could use, so “Assets to create” and “SEO page” stay as they were. Try again.');
  });
});

describe('what a step that wasn’t saved may still cost (the run’s summary)', () => {
  beforeEach(() => useStrategyJobs.setState({ jobs: {}, unsaved: {} }));
  const unsaved = () => useStrategyJobs.getState().unsaved.p1;

  it('a web research step that was stopped: its searches at list price, as an estimate', async () => {
    answer({ fail: { research: 'stop' } });
    expect(await runStrategy('p1')).toBe('stopped');
    const run = strategyOf('p1').run!;
    expect(run).toMatchObject({ stoppedAt: 'research', done: [] });
    // the most searches step 1 may make (5 by default) at the key's $0.01 each
    expect(unsaved()).toEqual({ runAt: run.startedAt, step: 'research', usd: 0.05, estimate: true, searches: 5, perSearch: 0.01 });
  });

  it('…or that failed after your server took it (a timeout): the same estimate, with the run’s own search limit', async () => {
    setMaxSearches('p1', 3);
    answer({ fail: { research: 'upstream' } });
    expect(await runStrategy('p1')).toBe('failed');
    expect(unsaved()).toMatchObject({ runAt: strategyOf('p1').run!.startedAt, step: 'research', usd: 0.03, estimate: true, searches: 3 });
  });

  it('nothing when the request never reached a key (a daily limit, your server unreachable), or the step wasn’t research', async () => {
    answer({ fail: { research: 'daily' } });
    expect(await runStrategy('p1')).toBe('failed');
    expect(unsaved()).toBeUndefined();
    answer({ fail: { research: 'network' } });
    expect(await runStrategy('p1')).toBe('failed');
    expect(unsaved()).toBeUndefined();
    useRuntime.getState().set({ server: 'ok' });
    answer({ fail: { content: 'stop' } });
    expect(await runStrategy('p1')).toBe('stopped');
    expect(unsaved()).toBeUndefined();
  });

  it('an answer that came back unusable was billed: what it reported, not an estimate', async () => {
    answer({ reply: { promote: { channels: 'none' } } });
    expect(await runStrategy('p1')).toBe('failed');
    expect(unsaved()).toEqual({ runAt: strategyOf('p1').run!.startedAt, step: 'promote', usd: 0.0412, estimate: false });
  });

  it('a new run clears the last one’s', async () => {
    answer({ fail: { research: 'stop' } });
    await runStrategy('p1');
    expect(unsaved()).toBeDefined();
    answer();
    expect(await runStrategy('p1')).toBe('done');
    expect(unsaved()).toBeUndefined();
  });
});

describe('what a section was written from', () => {
  it('is what its prompt had: details changed or research that came in during the step show as changed', async () => {
    const goal = 'Brand new goal typed during the run';
    answer({ onStep: (step) => step === 'research' && setStrategyInputs('p1', { goal }) });
    const hashBefore = strategyFactsHash(projectOf('p1'), strategyOf('p1').inputs);
    expect(await runStrategy('p1', ['research'])).toBe('done');
    expect(strategyOf('p1').inputs.goal).toBe(goal);
    expect(strategyOf('p1').research!.factsHash).toBe(hashBefore);
    expect(stale(projectOf('p1'), strategyOf('p1')).details).toBe(true);
    // Manus's deep research finishes while "Where to promote" is being written
    const doneAt = Date.now() + 1;
    answer({ onStep: (step) => step === 'promote' && writeStrategy('p1', (s) => ({ ...s, manus: { taskId: 'task_qa_123', taskUrl: 'https://manus.im/app/task_qa_123', state: 'done', requestedAt: 1, doneAt } })) });
    expect(await runStrategy('p1', ['promote'])).toBe('done');
    const s = strategyOf('p1');
    expect(s.promote!.researchAt).toBe(s.research!.at);
    expect(stale(projectOf('p1'), s).beforeResearch).toEqual(['promote']);
  });
});

describe('a re-plan keeps the owner’s ticks', () => {
  const planPrompt = () => generateCalls().filter((b) => b.prompt.includes('[ylb-strategy:plan v1]')).at(-1)!.prompt;

  it('asks for no “fresh take”, and gives the plan step the titles of the steps the owner ticked, to keep', async () => {
    answer();
    await runStrategy('p1');
    expect(planPrompt()).not.toMatch(/regeneration #\d+/);
    expect(planPrompt()).not.toContain('INPUT.earlier.done');
    const [a, b] = strategyOf('p1').plan!.actions;
    tickAction('p1', a.id, true);
    tickAction('p1', b.id, true);
    await runStrategy('p1', ['plan']);
    expect(planPrompt()).not.toMatch(/regeneration #\d+/);
    expect(planPrompt()).toContain(`"done": [\n   ${JSON.stringify(a.title)},\n   ${JSON.stringify(b.title)}\n  ]`);
    expect(planPrompt()).toContain('INPUT.earlier.done lists steps of the current plan the owner already did. Keep each one that still applies in the new plan, with exactly the same title, so it stays marked as done.');
  });

  it('a tick follows its step when the new plan writes its title in other case or punctuation, or gives it another kind', async () => {
    answer();
    await runStrategy('p1');
    const old = strategyOf('p1').plan!.actions;
    const page = old.find((x) => x.kind === 'build_page')!;
    const email = old.find((x) => x.kind === 'outreach')!;
    tickAction('p1', page.id, true);
    tickAction('p1', email.id, true);
    const ticks = strategyOf('p1').ticks;
    const actions = STRATEGY_QA.plan.actions.map((x) => (x.kind === 'build_page' ? { ...x, title: 'QA:  Build your booking page.' } : x.kind === 'outreach' ? { ...x, kind: 'offline' } : x));
    answer({ reply: { plan: { ...STRATEGY_QA.plan, actions } } });
    expect(await runStrategy('p1', ['plan'])).toBe('done');
    const s = strategyOf('p1');
    const page2 = s.plan!.actions.find((x) => x.kind === 'build_page')!;
    const email2 = s.plan!.actions.find((x) => x.title === email.title)!;
    expect(page2.id).not.toBe(page.id);
    expect(email2).toMatchObject({ kind: 'offline' });
    expect(s.ticks).toEqual({ [page2.id]: ticks[page.id], [email2.id]: ticks[email.id] });
  });

  it('saveStep: a tick stays on its own step first, moves only to a step with the same title, and goes when its step is gone', () => {
    const p = qaProject('p1');
    const st = qaSavedStrategy(p);
    const [a, b, c] = st.plan!.actions;
    const ticked = { ...st, ticks: { [a.id]: 1, [b.id]: 2, [c.id]: 3 } };
    const info = { at: 2_000_000_000_000, provider: 'server' as const, factsHash: 'x' };
    // a kept as is; b renamed (dropped); c's title on another kind (followed)
    const plan = { ...st.plan!, actions: [a, { ...b, id: 'a_new1', title: 'Something else entirely' }, { ...c, id: 'a_new2', kind: 'offline' as const }] };
    const out = saveStep(ticked, 'plan', plan, info, undefined, 'server');
    expect(out.ticks).toEqual({ [a.id]: 1, a_new2: 3 });
  });
});
