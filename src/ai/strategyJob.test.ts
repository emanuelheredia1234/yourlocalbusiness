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
import { readStrategy } from '@/lib/strategy';
import { tickAction } from '@/lib/strategyWrite';
import { STRATEGY_QA, qaMeta, qaProject, qaResearchMeta, qaSavedStrategy } from '@/test/strategyQa';

vi.mock('./engine', async (orig) => {
  const m = await orig<typeof import('./engine')>();
  return { ...m, runTask: vi.fn(m.runTask) };
});

import { runTask } from './engine';
import { runStrategy, stopStrategy, useStrategyJobs } from './strategyJob';

const fetchMock = vi.fn();
const runs = vi.mocked(runTask);
const voice: Skill = { ...newSkill({ name: 'QA Bakery brand voice', scope: ['all'], instructions: 'Warm and plain.' }), id: 'skill_voice' };

type Fail = 'daily' | 'abort' | 'stop';
function answer(o: { fail?: Partial<Record<StrategyStep, Fail>>; onStep?: (step: StrategyStep) => void } = {}) {
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const step = /\[ylb-strategy:(\w+) v1\]/.exec(body.prompt)?.[1] as StrategyStep;
    o.onStep?.(step);
    const fail = o.fail?.[step];
    if (fail === 'daily') return new Response(JSON.stringify({ error: 'You’ve reached today’s limit on the app’s AI keys.', code: 'DAILY_LIMIT' }), { status: 429 });
    if (fail === 'stop' || fail === 'abort') {
      if (fail === 'stop') setTimeout(() => stopStrategy('p1'), 0);
      return new Promise((_res, rej) => {
        const aborted = () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (init.signal?.aborted) aborted();
        else init.signal?.addEventListener('abort', aborted);
      });
    }
    const meta = step === 'research' ? qaMeta(qaResearchMeta()) : qaMeta();
    return new Response(JSON.stringify({ text: JSON.stringify(STRATEGY_QA[step]), meta }), { status: 200 });
  });
}

const strategyOf = (id: string): StrategyState => readStrategy(useStore.getState().projects.find((p) => p.id === id)!);
const stepsCalled = () => fetchMock.mock.calls.map(([, init]) => /\[ylb-strategy:(\w+) v1\]/.exec(JSON.parse(String(init.body)).prompt)?.[1]);

beforeEach(() => {
  fetchMock.mockReset();
  runs.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  const p1: Project = qaProject('p1');
  const p2: Project = { ...qaProject('p2'), brand: { ...qaProject('p2').brand, name: 'Other Shop' } };
  useStore.setState({ projects: [p1, p2], activeProjectId: 'p1', genLog: [], skills: [voice], settings: defaultSettings(), posts: [], ads: [], myListings: [], notices: [] });
  useRuntime.getState().set({
    server: 'ok',
    ai: {
      ...NO_AI_SERVER,
      reachable: true,
      ready: true,
      routing: { strategy: ['anthropic'] },
      providers: [{ id: 'anthropic', label: 'Anthropic Claude', ready: true, models: { text: 'claude-opus-5-5' }, effort: { text: { id: 'medium', label: 'Medium' } }, research: { perSearch: 0.01 } }],
    },
  });
  useStrategyJobs.setState({ jobs: {} });
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
