import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as tasks from './tasks';
import { AI_FUNCTIONS, functionForTask } from './functions';
import { metaLine } from './meta';
import { runTask } from './engine';
import { newProject } from '@/store/defaults';
import { defaultSettings } from '@/store/defaults';
import { NO_AI_SERVER, useRuntime } from '@/lib/platform';

const allTasks = (Object.values(tasks) as unknown[]).filter((t): t is { id: string } => !!t && typeof t === 'object' && 'id' in t && 'local' in t);

describe('the functions catalog', () => {
  it('puts every AI task under exactly one function', () => {
    expect(allTasks.length).toBeGreaterThan(20);
    for (const t of allTasks) {
      const owners = AI_FUNCTIONS.filter((f) => f.tasks.includes(t.id));
      expect(owners.map((f) => f.id), t.id).toHaveLength(1);
      expect(functionForTask(t.id)?.kind).toBe('text');
    }
  });

  it('lists only tasks that exist', () => {
    const ids = new Set(allTasks.map((t) => t.id));
    for (const f of AI_FUNCTIONS) for (const t of f.tasks) expect(ids.has(t), `${f.id} → ${t}`).toBe(true);
  });
});

describe('the engine on your server', () => {
  const meta = { provider: 'openai', providerLabel: 'OpenAI', fn: 'research', kind: 'text', model: 'gpt-6.1-sol', effort: 'high', effortLabel: 'High', effortField: 'reasoning.effort', ms: 900, usage: { input: 1200, output: 2600, reasoning: 2100 }, cost: { usd: 0.0284, source: 'estimate' }, credits: null };
  const fetchMock = vi.fn();
  const project = () => {
    const p = newProject('product', 'new');
    p.niche = 'Personal Finance';
    p.category = 'Freelancer Tax Tracking';
    p.format = 'spreadsheet';
    return p;
  };
  const opts = () => ({ project: project(), skills: [], settings: { ...defaultSettings(), ai: { ...defaultSettings().ai, simulateLatency: false } } });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    useRuntime.getState().set({ server: 'ok', ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: { research: ['openai'], seo: [] } } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks /api/ai/generate for the task’s function and keeps who answered', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: JSON.stringify([{ title: 'Quarterly Tax Tracker', hook: 'Never miss a payment' }]), meta }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await runTask(tasks.productIdeasTask, { niche: 'Personal Finance', category: 'Freelancer Tax Tracking', format: 'spreadsheet', count: 1 }, opts());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/ai/generate');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ fn: 'research', tier: 'default', brain: true });
    expect(body.prompt).toContain('Freelancer Tax Tracking');
    expect(r.provider).toBe('server');
    expect(r.meta).toEqual(meta);
    expect(r.data[0].title).toBe('Quarterly Tax Tracker');
    expect(metaLine(r.meta!)).toBe('OpenAI · gpt-6.1-sol · effort High · 2,100 reasoning tokens · ≈$0.028');
  });

  it('doesn’t call the server when no key powers the function, and says what to do', async () => {
    const r = await runTask(tasks.seoMetaTask, {}, opts());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.provider).toBe('local');
    expect(r.note).toMatch(/No API key powers SEO & sales pages yet/);
  });

  it('falls back to the built-in engine with the server’s reason', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'OpenAI says the account is out of credits.', code: 'CREDITS' }), { status: 402 }));
    const r = await runTask(tasks.productIdeasTask, { niche: 'Personal Finance', category: 'Freelancer Tax Tracking', format: 'spreadsheet', count: 1 }, opts());
    expect(r.provider).toBe('local');
    expect(r.note).toBe('OpenAI says the account is out of credits. The built-in engine answered instead.');
    expect(r.data.length).toBeGreaterThan(0);
  });

  it('says when another key answered after the first one failed', async () => {
    const withAttempt = { ...meta, provider: 'google', providerLabel: 'Google Gemini', attempts: [{ provider: 'openai', providerLabel: 'OpenAI', code: 'UPSTREAM', error: 'OpenAI had an error (500).' }] };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: '[]', meta: withAttempt }), { status: 200 }));
    const r = await runTask(tasks.productIdeasTask, { niche: 'Personal Finance', category: 'Freelancer Tax Tracking', format: 'spreadsheet', count: 1 }, opts());
    expect(r.note).toBe('OpenAI failed (OpenAI had an error (500).) Google Gemini answered instead.');
  });
});
