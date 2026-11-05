// Deep research with Manus: what the app sends (six short facts the owner typed, nothing else), how it
// reads the report (checked again, capped), that a finished task is written once, and the watcher.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_AI_SERVER, useRuntime } from '@/lib/platform';
import { useStore } from '@/store/useStore';
import { defaultSettings } from '@/store/defaults';
import { readStrategy } from '@/lib/strategy';
import { qaProject, qaSavedStrategy } from '@/test/strategyQa';
import { applyManusCheck, checkDeepResearch, manusFacts, manusWatchTick, readManusResearch, startDeepResearch } from './strategyManus';

const fetchMock = vi.fn();
const DAY = 86_400_000;
const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ path: new URL(String(url), 'http://x').pathname, body: JSON.parse(String(init.body)) }));
const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
const DONE = {
  ok: true,
  task_id: 'task_qa_1',
  status: 'stopped',
  done: true,
  credit_usage: 120,
  research: {
    state: 'done',
    pagesRead: 3,
    reason: '',
    findings: [
      { topic: 'buyers', text: 'QA: a directory page lists local businesses with photos and opening hours.', url: 'https://example.com/qa-research/where-buyers-look' },
      { topic: 'social', text: 'QA: a guide says behind-the-scenes clips get comments.', url: 'https://example.org/qa-research/content-that-works', quote: 'QA stand-in quote.' },
      { topic: 'promote', text: 'QA: a finding without an address (it must be dropped).', url: 'not-a-url' },
    ],
  },
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  const p = qaProject('p1');
  const strategy = { ...qaSavedStrategy(p), inputs: { goal: 'SECRET GOAL 10 bookings', budget: '', timePerWeek: '', competitors: ['Rise Bakery'], tried: '', notes: 'private notes' } };
  useStore.setState({ projects: [{ ...p, strategy }], activeProjectId: 'p1', settings: defaultSettings(), notices: [] });
  useRuntime.getState().set({ server: 'ok', ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: { marketResearch: ['manus'] }, providers: [{ id: 'manus', label: 'Manus', ready: true, models: {}, effort: {} }] } });
});
afterEach(() => vi.unstubAllGlobals());

describe('starting', () => {
  it('sends only the six facts: no prompt, no title, nothing the AI wrote, no details or competitors', async () => {
    fetchMock.mockResolvedValue(ok({ ok: true, task_id: 'task_qa_1', task_url: 'https://manus.im/app/task_qa_1', task_title: 'Market research: qa bakery' }));
    expect(await startDeepResearch('p1', { confirm: async () => true })).toBe('started');
    const [c] = calls();
    expect(c.path).toBe('/api/ai/manus/create');
    expect(c.body).toEqual({ fn: 'marketResearch', research: { niche: 'qa bakery', category: 'sourdough', kind: 'local', typeLabel: 'Café & Bakery', city: 'Austin', region: 'Texas' } });
    expect(JSON.stringify(c.body)).not.toMatch(/SECRET|Rise Bakery|private|QA:/);
    expect(readStrategy(useStore.getState().projects[0]).manus).toMatchObject({ taskId: 'task_qa_1', taskUrl: 'https://manus.im/app/task_qa_1', state: 'working' });
  });

  it('a product sends no place', () => {
    const p = { ...qaProject('p9'), track: 'product' as const, format: 'ebook' as const };
    expect(manusFacts(p)).toMatchObject({ kind: 'online', city: '', region: '' });
  });

  it('asks first, and never starts without a yes', async () => {
    expect(await startDeepResearch('p1', { confirm: async () => false })).toBe('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an uncertain start is saved as failed with what to check, and isn’t retried', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'));
    expect(await startDeepResearch('p1', { confirm: async () => true })).toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readStrategy(useStore.getState().projects[0]).manus).toMatchObject({ state: 'failed', message: 'The connection dropped while starting. Check your Manus tasks before you start again.' });
  });

  it('isn’t offered without a Manus key that powers it', async () => {
    useRuntime.getState().set({ ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: {}, providers: [] } });
    expect(await startDeepResearch('p1', { confirm: async () => true })).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('reading the report', () => {
  it('checks every value again: http(s) links only, at most 12 findings', () => {
    const many = { state: 'done', pagesRead: 3.7, reason: '', findings: Array.from({ length: 30 }, (_, i) => ({ topic: i % 2 ? 'buyers' : 'rocket', text: `QA finding ${i}`, url: i === 0 ? 'javascript:alert(1)' : `https://example.com/${i}` })) };
    const r = readManusResearch(many)!;
    expect(r.findings).toHaveLength(12);
    expect(r.findings[0].url).toBe('https://example.com/1');
    expect(r.findings.map((f) => f.topic)).toContain('other');
    expect(r.pagesRead).toBe(4);
    expect(readManusResearch({ state: 'maybe' })).toBeNull();
    expect(readManusResearch('x')).toBeNull();
  });

  it('keeps a finding only with a page address the strategy keeps as a source (at most 400 characters, as the server)', () => {
    const at = (n: number) => `https://example.com/${'a'.repeat(n - 'https://example.com/'.length)}`;
    const r = readManusResearch({ state: 'done', pagesRead: 2, reason: '', findings: [{ topic: 'buyers', text: 'QA: at the limit.', url: at(400) }, { topic: 'buyers', text: 'QA: one longer.', url: at(401) }] })!;
    expect(r.findings.map((f) => f.url)).toEqual([at(400)]);
    // and the one it keeps is saved with its page
    const p = qaProject();
    const s = { ...qaSavedStrategy(p), manus: { taskId: 'task_qa_1', taskUrl: 'https://manus.im/app/task_qa_1', state: 'working' as const, requestedAt: 1 } };
    const done = applyManusCheck(s, p, { status: 'stopped', done: true, waiting: false, error: '', creditUsage: 3 }, r);
    expect(done.manus!.findings!.map((f) => [f.text, f.basis, f.sources])).toEqual([['QA: at the limit.', 'web', [3]]]);
    expect(done.sources.at(-1)).toMatchObject({ n: 3, url: at(400), via: 'manus' });
  });

  it('a finished task is written once: findings with their pages, credits, pages read', async () => {
    useStore.getState().updateProject('p1', (p) => ({ ...p, strategy: { ...readStrategy(p), manus: { taskId: 'task_qa_1', taskUrl: 'https://manus.im/app/task_qa_1', state: 'working', requestedAt: Date.now() - 60_000 } } }));
    fetchMock.mockResolvedValue(ok(DONE));
    expect(await checkDeepResearch('p1')).toEqual({ before: 'working', after: 'done' });
    expect(calls()[0].body).toEqual({ task_id: 'task_qa_1', max_images: 0 });
    const s = readStrategy(useStore.getState().projects[0]);
    expect(s.manus).toMatchObject({ state: 'done', pagesRead: 3, credits: 120 });
    expect(s.manus!.findings!.map((f) => [f.basis, f.sources])).toEqual([
      ['web', [1]],
      ['web', [2]],
    ]);
    // the same pages as the search found keep their numbers; Manus is noted on them only when new
    expect(s.sources.map((x) => x.n)).toEqual([1, 2]);
    // done is done: a second check changes nothing and asks nothing
    expect(await checkDeepResearch('p1')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const again = applyManusCheck(s, useStore.getState().projects[0], { status: 'stopped', done: true, waiting: false, error: '', creditUsage: 999 }, readManusResearch(DONE.research));
    expect(again).toBe(s);
  });

  it('a failed report says why', async () => {
    useStore.getState().updateProject('p1', (p) => ({ ...p, strategy: { ...readStrategy(p), manus: { taskId: 'task_qa_2', taskUrl: 'https://manus.im/app/task_qa_2', state: 'working', requestedAt: Date.now() } } }));
    fetchMock.mockResolvedValue(ok({ ...DONE, research: { state: 'failed', pagesRead: 0, reason: "QA: couldn't open the pages.", findings: [] } }));
    await checkDeepResearch('p1');
    expect(readStrategy(useStore.getState().projects[0]).manus).toMatchObject({ state: 'failed', message: "QA: couldn't open the pages." });
  });
});

describe('the watcher', () => {
  const working = (requestedAt: number) => useStore.getState().updateProject('p1', (p) => ({ ...p, strategy: { ...readStrategy(p), manus: { taskId: 'task_qa_1', taskUrl: 'https://manus.im/app/task_qa_1', state: 'working', requestedAt } } }));

  it('skips while the page is hidden', async () => {
    working(Date.now());
    expect(await manusWatchTick({ hidden: true })).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(ok({ ok: true, task_id: 'task_qa_1', status: 'running', done: false }));
    expect(await manusWatchTick({})).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readStrategy(useStore.getState().projects[0]).manus?.state).toBe('working');
  });

  it('gives up after 3 days without asking Manus again', async () => {
    working(Date.now() - 3 * DAY - 60_000);
    await manusWatchTick({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readStrategy(useStore.getState().projects[0]).manus).toMatchObject({ state: 'failed', message: 'Stopped checking after 3 days: open the task in Manus.' });
  });

  it('does nothing in the claude.ai build', async () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    working(Date.now());
    expect(await manusWatchTick({})).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
