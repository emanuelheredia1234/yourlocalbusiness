// Starting a Strategy run from the page: your server is asked again before the app decides who writes it,
// Continue never carries an AI's run on with the built-in engine, and built-in guidance replaces what an AI
// wrote only after a confirm that names it. The store is real; your server is a fake fetch; the confirm
// answers as each test says.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Skill } from '@/lib/types';
import type { StrategyState, StrategyStep } from '@/lib/strategyTypes';
import { NO_AI_SERVER, useRuntime } from '@/lib/platform';
import { readStrategy } from '@/lib/strategy';
import { tickAction } from '@/lib/strategyWrite';
import { useStore } from '@/store/useStore';
import { useUI } from '@/store/ui';
import { defaultSettings } from '@/store/defaults';
import { STRATEGY_QA, qaMeta, qaProject, qaResearchMeta } from '@/test/strategyQa';

type Asked = { title: string; body?: string; confirmLabel?: string; danger?: boolean };
const confirm = vi.hoisted(() => ({ answer: true, asked: [] as Asked[] }));
vi.mock('@/components/ui/primitives', async (orig) => ({
  ...(await orig<typeof import('@/components/ui/primitives')>()),
  confirmAction: vi.fn(async (o: Asked) => {
    confirm.asked.push(o);
    return confirm.answer;
  }),
}));

import { PLAN_STEPS, runStrategy, useStrategyJobs } from '@/ai/strategyJob';
import { replaceConfirm, startRun, useServerCheck, type RunKind } from './runs';

const ANTHROPIC = { id: 'anthropic', label: 'Anthropic Claude', ready: true, models: { text: 'claude-opus-5-5' }, effort: { text: { id: 'medium', label: 'Medium' } }, research: { perSearch: 0.01 } };
const fetchMock = vi.fn();
/** Whether your server answers its health check. */
const health = { up: true };

/** Your server, faked: each step's QA answer, a dropped request where asked, and its health check. */
function serve(o: { network?: StrategyStep } = {}) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith('/api/health')) {
      if (!health.up) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ ok: true, ai: { ready: true, routing: { strategy: ['anthropic'] }, providers: [ANTHROPIC] } }), { status: 200 });
    }
    const step = /\[ylb-strategy:(\w+) v1\]/.exec(JSON.parse(String(init.body)).prompt)?.[1] as StrategyStep;
    if (o.network === step) throw new TypeError('Failed to fetch');
    const meta = step === 'research' ? qaMeta(qaResearchMeta()) : qaMeta();
    return new Response(JSON.stringify({ text: JSON.stringify(STRATEGY_QA[step]), meta }), { status: 200 });
  });
}

const strategyOf = (): StrategyState => readStrategy(useStore.getState().projects.find((p) => p.id === 'p1')!);
const generateCalls = () => fetchMock.mock.calls.filter(([url]) => !String(url).endsWith('/api/health'));
/** The run startRun started is over. */
const idle = () => vi.waitFor(() => expect(useStrategyJobs.getState().jobs.p1).toBeUndefined());
const noKey = () => useRuntime.getState().set({ ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: {} } });

/** A strategy your AI wrote, then a run that a dropped request stopped at step 2 (your server now marked down). */
async function blipAtStep2() {
  serve();
  expect(await runStrategy('p1')).toBe('done');
  serve({ network: 'promote' });
  expect(await runStrategy('p1')).toBe('failed');
  expect(useRuntime.getState().server).toBe('down');
  const s = strategyOf();
  const k: RunKind = { kind: 'continue', steps: s.run!.steps, from: s.run!.steps.indexOf(s.run!.stoppedAt!) + 1 };
  expect(k.from).toBe(2);
  fetchMock.mockClear();
  confirm.asked = [];
  return { s, k };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  health.up = true;
  confirm.answer = true;
  confirm.asked = [];
  useStore.setState({ projects: [qaProject('p1') as Project], activeProjectId: 'p1', genLog: [], skills: [] as Skill[], settings: defaultSettings(), posts: [], ads: [], myListings: [], notices: [] });
  useRuntime.getState().set({ server: 'ok', ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: { strategy: ['anthropic'] }, providers: [ANTHROPIC] } });
  useStrategyJobs.setState({ jobs: {} });
  useUI.setState({ toasts: [] });
});
afterEach(() => vi.unstubAllGlobals());

describe('Continue after a request couldn’t reach your server', () => {
  it('asks your server again first: it answers, so your AI writes the rest, after the paid confirm', async () => {
    const { k } = await blipAtStep2();
    serve();
    expect(await startRun('p1', k)).toBe(true);
    await idle();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/health$/);
    expect(confirm.asked.map((x) => x.title)).toEqual(['Continue from step 2?']);
    expect(confirm.asked[0].body).toContain('Anthropic Claude writes your strategy');
    const s = strategyOf();
    for (const step of PLAN_STEPS) expect(s[step]?.provider).toBe('server');
    expect(s.run!.finishedAt).toBeGreaterThan(0);
  });

  it('while your server still doesn’t answer: nothing runs or changes, and it says why', async () => {
    const { s } = await blipAtStep2();
    health.up = false;
    expect(await startRun('p1', { kind: 'continue', steps: s.run!.steps, from: 2 })).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/api/health']);
    expect(confirm.asked).toEqual([]);
    expect(useStrategyJobs.getState().jobs).toEqual({});
    const after = strategyOf();
    for (const step of ['research', ...PLAN_STEPS] as const) expect(after[step]).toEqual(s[step]);
    expect(useUI.getState().toasts.at(-1)).toMatchObject({ kind: 'error', title: 'Couldn’t continue from step 2', body: 'Your AI server can’t be reached right now, so nothing was changed. Check that it’s running, then try again.' });
  });
});

describe('while your server is asked again', () => {
  it('the button that started the run says so (your server was marked down), and stops saying so once it answers', async () => {
    const { k } = await blipAtStep2();
    serve();
    // the health check answers only when the test lets it
    let answer: () => void = () => {};
    const gate = new Promise<void>((res) => (answer = res));
    const real = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/health')) await gate;
      return real(url, init);
    });
    const started = startRun('p1', k);
    await vi.waitFor(() => expect(useServerCheck.getState().checking).toEqual({ p1: 'continue' }));
    expect(confirm.asked).toEqual([]);
    answer();
    expect(await started).toBe(true);
    expect(useServerCheck.getState().checking).toEqual({});
    await idle();
  });

  it('nothing to say when your server is up (no check), and none left behind when it still doesn’t answer', async () => {
    serve();
    const seen: unknown[] = [];
    const off = useServerCheck.subscribe((st) => seen.push(st.checking));
    expect(await startRun('p1', { kind: 'all' })).toBe(true);
    await idle();
    expect(seen).toEqual([]);
    const { s } = await blipAtStep2();
    health.up = false;
    expect(await startRun('p1', { kind: 'continue', steps: s.run!.steps, from: 2 })).toBe(false);
    expect(seen).toEqual([{ p1: 'continue' }, {}]);
    off();
  });
});

describe('built-in guidance in place of what an AI wrote', () => {
  it('asks first and names what it replaces: no changes nothing, yes writes the built-in strategy', async () => {
    serve();
    expect(await runStrategy('p1')).toBe('done');
    for (const a of strategyOf().plan!.actions.slice(0, 2)) tickAction('p1', a.id, true);
    const before = strategyOf();
    noKey();
    fetchMock.mockClear();
    confirm.answer = false;
    expect(await startRun('p1', { kind: 'all' })).toBe(false);
    expect(confirm.asked).toEqual([
      {
        title: 'Replace what your AI wrote with built-in guidance?',
        body: 'No API key powers Strategy yet, so the built-in engine writes a starter plan: free, general guidance, not research. It replaces “Research”, “Where to promote”, “Social content”, “Assets to create”, “SEO page”, “Email outreach” and “Plan”, which your AI wrote. Your web research is replaced by general guidance without sources. Ticks stay only on steps that are still in the new plan.',
        confirmLabel: 'Replace',
        danger: true,
      },
    ]);
    expect(strategyOf()).toEqual(before);
    confirm.answer = true;
    expect(await startRun('p1', { kind: 'all' })).toBe(true);
    await idle();
    const s = strategyOf();
    expect(s.research).toMatchObject({ provider: 'local', mode: 'builtin' });
    for (const step of PLAN_STEPS) expect(s[step]?.provider).toBe('local');
    expect(generateCalls()).toEqual([]);
  });

  it('one section: the confirm names just that one', async () => {
    serve();
    await runStrategy('p1');
    noKey();
    expect(replaceConfirm({ kind: 'refresh', step: 'assets' }, strategyOf(), 5)).toMatchObject({ title: 'Replace “Assets to create” and “SEO page” with built-in guidance?', body: expect.stringContaining('It replaces “Assets to create” and “SEO page”, which your AI wrote.') });
    expect(replaceConfirm({ kind: 'refresh', step: 'assets' }, strategyOf(), 5).body).not.toContain('sources');
  });

  it('a free built-in run that replaces nothing an AI wrote starts at once', async () => {
    noKey();
    expect(await startRun('p1', { kind: 'all' })).toBe(true);
    await idle();
    expect(confirm.asked).toEqual([]);
    expect(strategyOf().research).toMatchObject({ provider: 'local', mode: 'builtin' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
