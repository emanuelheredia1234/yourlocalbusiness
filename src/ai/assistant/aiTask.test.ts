// Running an AI text task from a tool, outside React: what it records (as useAI does), the daily
// limit, the busy registry, and the chat's Stop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBusy } from '@/lib/busy';
import { NO_AI_SERVER, useRuntime } from '@/lib/platform';
import { useStore } from '@/store/useStore';
import { defaultSettings, newProject } from '@/store/defaults';
import { skillTestTask } from '../tasks';
import { runAITask } from './aiTask';
import type { ToolContext } from './registry';

const meta = { provider: 'openai', providerLabel: 'OpenAI', fn: 'brand', kind: 'text', model: 'gpt-6.1-sol', effort: 'high', effortLabel: 'High', effortField: 'reasoning.effort', ms: 900, usage: { input: 1200, output: 2600, reasoning: 2100 }, cost: { usd: 0.0284, source: 'estimate' }, credits: null };
const fetchMock = vi.fn();
const ctx = (signal = new AbortController().signal): ToolContext & { stages: string[] } => {
  const stages: string[] = [];
  return { signal, projectId: 'p1', stage: (s) => stages.push(s), ai: [], stages };
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  const project = { ...newProject('business', 'existing'), id: 'p1', onboarded: true };
  project.brand.name = 'Copper Kettle';
  useStore.setState({ projects: [project], activeProjectId: 'p1', genLog: [], skills: [], settings: defaultSettings() });
  useRuntime.getState().set({ server: 'ok', ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: { brand: ['openai'] } } });
});
afterEach(() => vi.unstubAllGlobals());

describe('running an AI task for a tool', () => {
  it('asks your AI, logs the generation with who answered, and notes it for the chat', async () => {
    let busy: unknown = null;
    fetchMock.mockImplementation(async () => {
      busy = Object.values(useBusy.getState().jobs);
      return new Response(JSON.stringify({ text: JSON.stringify({ text: 'Fresh bread, every morning.' }), meta }), { status: 200 });
    });
    const c = ctx();
    const r = await runAITask(skillTestTask, { sample: 'caption' }, c);
    expect(r).toMatchObject({ provider: 'server', limitReached: false, data: { text: 'Fresh bread, every morning.' } });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ fn: 'brand' });
    expect(busy).toEqual([{ id: expect.stringMatching(/^assistant:skillTest#/), label: skillTestTask.label, scope: 'app' }]);
    expect(Object.keys(useBusy.getState().jobs)).toEqual([]);
    const log = useStore.getState().genLog[0];
    expect(log).toMatchObject({ id: r.logId, task: 'skillTest', provider: 'server', projectId: 'p1', meta: { providerLabel: 'OpenAI', model: 'gpt-6.1-sol', costUsd: 0.0284 } });
    expect(c.ai).toEqual([{ task: 'skillTest', label: skillTestTask.label, provider: 'server' }]);
    expect(c.stages[0]).toBe(`${skillTestTask.label}…`);
  });

  it('can stay out of the log (silent)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: '{"text":"x"}', meta }), { status: 200 }));
    const r = await runAITask(skillTestTask, { sample: 'caption' }, ctx(), { silent: true });
    expect(r.logId).toBeNull();
    expect(useStore.getState().genLog).toEqual([]);
  });

  it('says when today’s limit was reached (the built-in engine wrote it instead)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'You’ve reached today’s limit on the app’s AI keys (50 requests). It resets at midnight UTC.', code: 'DAILY_LIMIT' }), { status: 429 }));
    const c = ctx();
    const r = await runAITask(skillTestTask, { sample: 'caption' }, c);
    expect(r).toMatchObject({ provider: 'local', limitReached: true });
    expect(r.note).toMatch(/Settings → AI/);
    expect(c.ai[0]).toMatchObject({ provider: 'local', note: r.note });
  });

  it('says what to set up when no key powers the task', async () => {
    useRuntime.getState().set({ ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: {} } });
    const r = await runAITask(skillTestTask, { sample: 'caption' }, ctx());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r).toMatchObject({ provider: 'local', limitReached: false });
    expect(r.note).toMatch(/No API key powers Brand kit & voice yet/);
  });

  it('stops with the chat’s Stop', async () => {
    const stop = new AbortController();
    const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_res, rej) => (init.signal?.aborted ? rej(aborted()) : init.signal?.addEventListener('abort', () => rej(aborted())))));
    const run = runAITask(skillTestTask, { sample: 'caption' }, ctx(stop.signal));
    await new Promise((r) => setTimeout(r, 0));
    stop.abort();
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
    expect(Object.keys(useBusy.getState().jobs)).toEqual([]);
    expect(useStore.getState().genLog).toEqual([]);
  });
});
