// Reaching the AI for the assistant (self-hosted: the key that powers "Assistant"), saying plainly when
// it can't, and what it still does without one: open the page a message names.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_AI_SERVER, useRuntime } from '@/lib/platform';
import { useStore } from '@/store/useStore';
import { defaultSettings } from '@/store/defaults';
import { askAssistantModel, assistantAvailability } from './transport';
import { matchPageIntent, starterSuggestions } from './intents';

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  useStore.setState({ settings: defaultSettings() });
  useRuntime.getState().set({ server: 'ok', ai: { ...NO_AI_SERVER, reachable: true, ready: true, routing: { assistant: ['openai'] } } });
});
afterEach(() => vi.unstubAllGlobals());

describe('whether the assistant can think', () => {
  it('is ready when a key powers the Assistant', () => {
    expect(assistantAvailability()).toEqual({ ok: true, reason: '', settings: false });
  });

  it('says what to do when no key powers it, or the server is down; tries while still checking', () => {
    useRuntime.getState().set({ ai: { ...NO_AI_SERVER, reachable: true, routing: { assistant: [] } } });
    expect(assistantAvailability()).toEqual({ ok: false, reason: 'No API key powers the Assistant yet. In Settings → AI keys, tick Assistant for one of your keys, or add your own key there.', settings: true });
    useRuntime.getState().set({ server: 'down' });
    expect(assistantAvailability()).toMatchObject({ ok: false, settings: true, reason: expect.stringContaining('can’t reach its AI server') });
    useRuntime.getState().set({ server: 'unknown', ai: NO_AI_SERVER });
    expect(assistantAvailability()).toMatchObject({ ok: true, checking: true });
  });
});

describe('asking for a step', () => {
  it('asks /api/ai/generate for the "assistant" function and returns its JSON', async () => {
    fetchMock.mockResolvedValue(reply({ text: '{"reply":"Hi","actions":[],"done":true}' }));
    const out = await askAssistantModel('the prompt', new AbortController().signal);
    expect(out).toEqual({ reply: 'Hi', actions: [], done: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/ai/generate');
    expect(JSON.parse(init.body)).toMatchObject({ fn: 'assistant', prompt: 'the prompt', tier: 'default' });
  });

  it('returns the text when the AI answered in prose', async () => {
    fetchMock.mockResolvedValue(reply({ text: 'You have two posts due.' }));
    expect(await askAssistantModel('p', new AbortController().signal)).toBe('You have two posts due.');
  });

  it('turns failures into plain words, pointing to Settings → AI when that’s where to fix it', async () => {
    fetchMock.mockResolvedValue(reply({ error: 'You’ve reached today’s limit on the app’s AI keys. It resets at midnight UTC.', code: 'DAILY_LIMIT' }, 429));
    await expect(askAssistantModel('p', new AbortController().signal)).rejects.toMatchObject({ code: 'daily_limit', settings: true, message: expect.stringContaining('add your own API keys in Settings → AI') });
    fetchMock.mockResolvedValue(reply({ error: 'No key powers Assistant', code: 'NO_PROVIDER' }, 409));
    await expect(askAssistantModel('p', new AbortController().signal)).rejects.toMatchObject({ code: 'no_provider', settings: true });
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(askAssistantModel('p', new AbortController().signal)).rejects.toMatchObject({ code: 'network', settings: true });
  });

  it('reports Stop as cancelled', async () => {
    const stop = new AbortController();
    // like fetch: an aborted signal rejects, now or later
    const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_r, rej) => (init.signal?.aborted ? rej(aborted()) : init.signal?.addEventListener('abort', () => rej(aborted())))));
    const ask = askAssistantModel('p', stop.signal);
    stop.abort();
    await expect(ask).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('without an AI', () => {
  it('finds the page a message is about', () => {
    expect(matchPageIntent('where do I change my API keys?')).toEqual({ route: 'workspace-settings', tab: 'ai', label: 'Settings → AI keys' });
    expect(matchPageIntent('show me my calendar')).toEqual({ route: 'calendar', label: 'Content calendar' });
    expect(matchPageIntent('I want to write a new post')).toEqual({ route: 'marketing-social', tab: 'create', label: 'Social → Create post' });
    expect(matchPageIntent('my email subscribers')).toMatchObject({ route: 'marketing-email', tab: 'subscribers' });
    expect(matchPageIntent('hello there')).toBeNull();
  });

  it('suggests three starters that fit the workspace', () => {
    expect(starterSuggestions({ name: 'Copper Kettle', due: 2, posts: 5, nextStep: 'SEO sales page', plan: true })).toEqual(['Which 2 posts are due?', 'What should I do next for Copper Kettle?', 'What’s planned for this week?']);
    expect(starterSuggestions({ name: 'Copper Kettle', due: 0, posts: 0, nextStep: null, plan: false })).toEqual(['Help me write my first post', 'How do I plan a month of posts?', 'What can you do?']);
    expect(starterSuggestions(null)).toHaveLength(3);
  });
});
