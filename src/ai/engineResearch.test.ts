// The engine's research hook: a task that asks for a web search sends `research` to your server, its merge
// gets what served the request (meta, with the search's sources), claude.ai never asks for it, and a
// result says why the built-in engine answered (RunResult.code).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskDef, TaskEnv } from './tasks';
import type { ResearchInput } from '@/lib/strategyTypes';
import { NO_AI_SERVER, useRuntime } from '@/lib/platform';
import { defaultSettings } from '@/store/defaults';
import { emptyStrategy } from '@/lib/strategy';
import { STRATEGY_QA, qaMeta, qaProject, qaResearchMeta } from '@/test/strategyQa';

const artifact = vi.hoisted(() => ({ calls: 0 }));
vi.mock('./claude', async (orig) => ({
  ...(await orig<typeof import('./claude')>()),
  callArtifactClaude: vi.fn(async () => {
    artifact.calls++;
    return JSON.parse(JSON.stringify(STRATEGY_QA.research));
  }),
}));

import { runTask } from './engine';
import { stepInput, strategyResearchTask } from './strategyTasks';

const fetchMock = vi.fn();
const project = qaProject();
const opts = () => ({ project, skills: [], settings: defaultSettings() });
const input = (web = true) => stepInput('research', project, emptyStrategy(), { web, posts: [], ads: [], myListings: [] }) as ResearchInput;

/** The research task with its hook and merge watched. */
function watched() {
  const seen: { research: unknown[]; merge: TaskEnv[] } = { research: [], merge: [] };
  const c = strategyResearchTask.claude!;
  const task = {
    ...strategyResearchTask,
    claude: {
      ...c,
      research: (i: never, env: TaskEnv) => {
        const r = c.research!(i, env);
        seen.research.push(r);
        return r;
      },
      merge: (raw: unknown, base: never, i: never, env: TaskEnv) => {
        seen.merge.push(env);
        return c.merge(raw, base, i, env);
      },
    },
  } as unknown as TaskDef<ReturnType<typeof input>, unknown>;
  return { task, seen };
}

beforeEach(() => {
  fetchMock.mockReset();
  artifact.calls = 0;
  vi.stubGlobal('fetch', fetchMock);
  useRuntime.getState().set({ server: 'ok', claude: 'unavailable', ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: { strategy: ['anthropic'] } } });
});
afterEach(() => vi.unstubAllGlobals());

describe('web research through your server', () => {
  it('sends the research request, and the merge gets the meta with the search', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: JSON.stringify(STRATEGY_QA.research), meta: qaMeta(qaResearchMeta()) }), { status: 200 }));
    const { task, seen } = watched();
    const res = await runTask(task, input(true), opts());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ fn: 'strategy', research: { web: true, maxSearches: 5, location: { city: 'Austin', region: 'Texas' } } });
    expect(seen.merge[0].meta?.research).toMatchObject({ web: true, sources: [{ n: 1 }, { n: 2 }, { n: 3 }] });
    expect(res).toMatchObject({ provider: 'server' });
    expect(res.code).toBeUndefined();
    expect((res.data as { findings: { sourceUrls: string[] }[] }).findings[0].sourceUrls).toEqual(['https://example.com/qa-research/where-buyers-look']);
  });

  it('sends no research when no key that powers Strategy can search', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: JSON.stringify(STRATEGY_QA.research), meta: qaMeta() }), { status: 200 }));
    const { task, seen } = watched();
    await runTask(task, input(false), opts());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('research');
    expect(seen.research).toEqual([null]);
  });

  it('claude.ai never asks for it (there is no search there), and the merge gets no meta', async () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    useRuntime.getState().set({ claude: 'available' });
    const { task, seen } = watched();
    const res = await runTask(task, input(true), opts());
    expect(res.provider).toBe('claude');
    expect(artifact.calls).toBe(1);
    expect(seen.research).toEqual([]);
    expect(seen.merge[0].meta).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('why the built-in engine answered (RunResult.code)', () => {
  it('no_provider: no key powers Strategy (no request is made)', async () => {
    useRuntime.getState().set({ ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: {} } });
    const res = await runTask(strategyResearchTask, input(), opts());
    expect(res).toMatchObject({ provider: 'local', code: 'no_provider' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('server_down: your AI server isn’t running', async () => {
    useRuntime.getState().set({ server: 'down' });
    const res = await runTask(strategyResearchTask, input(), opts());
    expect(res).toMatchObject({ provider: 'local', code: 'server_down' });
  });

  it('daily_limit: the server refused before sending anything', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'You’ve reached today’s limit.', code: 'DAILY_LIMIT' }), { status: 429 }));
    const res = await runTask(strategyResearchTask, input(), opts());
    expect(res).toMatchObject({ provider: 'local', code: 'daily_limit' });
    expect(res.note).toBeTruthy();
  });
});
