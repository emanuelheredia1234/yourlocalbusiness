// Who writes the strategy and what it costs (shown above every paid button and in every confirm), and
// whether deep research with Manus can start, for each state of your server and its keys.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_AI_SERVER, useRuntime, type AIServerProvider } from '@/lib/platform';
import { searchPriceText, strategyWho } from './strategyWho';

const key = (id: string, label: string, model: string, o: Partial<AIServerProvider> = {}): AIServerProvider => ({ id, label, ready: true, models: { text: model }, effort: { text: { id: 'medium', label: 'Medium' } }, ...o });
const ANTHROPIC = key('anthropic', 'Anthropic Claude', 'claude-opus-5-5', { research: { perSearch: 0.01 } });
const GOOGLE = key('google', 'Google Gemini', 'gemini-3.8-flash', { research: null });
const XAI = key('xai', 'xAI Grok', 'grok-4.6', { research: { perSearch: 0.005 } });
const META = key('meta', 'Meta', 'muse-text', { research: { perSearch: 0.0025 } });
const OPENROUTER = key('openrouter2', 'OpenRouter 2', 'anthropic/claude-sonnet-5', { research: { perSearch: 0.01 } });
const MANUS = key('manus', 'Manus', 'manus-1.6', { research: null });

function server(providers: AIServerProvider[], routing: Record<string, string[]>, o: { posting?: { reason: string } } = {}) {
  useRuntime.getState().set({ server: 'ok', ai: { ...NO_AI_SERVER, reachable: true, ready: true, providers, routing, ...(o.posting ? { posting: o.posting } : {}) } as never });
}

beforeEach(() => useRuntime.getState().set({ server: 'ok', claude: 'unavailable', ai: NO_AI_SERVER }));
afterEach(() => vi.unstubAllGlobals());

describe('the who-and-cost line', () => {
  it('a key that can search: the model, effort, searches at list price, who pays', () => {
    server([GOOGLE, ANTHROPIC], { strategy: ['anthropic'] });
    const w = strategyWho();
    expect(w).toMatchObject({ mode: 'web', settings: false, searchKey: { id: 'anthropic', perSearch: 0.01, own: false } });
    expect(w.who).toBe('Anthropic Claude writes your strategy with claude-opus-5-5 (effort Medium): 6 steps, 6 requests.');
    expect(w.cost).toBe('Step 1 searches the web: up to 5 searches at $0.01 each (list price), plus the pages it reads, billed as tokens. Billed to the key that powers Strategy; if you have a daily AI limit, it counts toward it.');
    expect(strategyWho({ maxSearches: 8 }).cost).toContain('up to 8 searches');
    // one section: one request, and only the research step mentions the search
    expect(strategyWho({ requests: 1, research: false }).who).toBe('Anthropic Claude writes your strategy with claude-opus-5-5 (effort Medium): 1 request.');
    expect(strategyWho({ requests: 1, research: false }).cost).not.toContain('searches the web');
  });

  it('prices: $0.01, $0.005, $0.0025', () => {
    expect(searchPriceText(0.01)).toBe('$0.01');
    expect(searchPriceText(0.005)).toBe('$0.005');
    expect(searchPriceText(0.0025)).toBe('$0.0025');
    server([XAI], { strategy: ['xai'] });
    expect(strategyWho().cost).toContain('at $0.005 each');
    server([META], { strategy: ['meta'] });
    expect(strategyWho().cost).toContain('at $0.0025 each');
  });

  it('OpenRouter reports the exact cost; your own key is billed to you', () => {
    server([OPENROUTER], { strategy: ['openrouter2'] });
    expect(strategyWho().cost).toContain(' OpenRouter reports the exact cost after.');
    server([{ ...ANTHROPIC, own: true }], { strategy: ['anthropic'] });
    const w = strategyWho();
    expect(w.who).toMatch(/^Anthropic Claude \(your key\) writes your strategy/);
    expect(w.cost).toMatch(/Billed to your own key\.$/);
    expect(w.searchKey?.own).toBe(true);
  });

  it('when the key that searches isn’t first, it does the research and the first key writes the rest', () => {
    server([GOOGLE, ANTHROPIC], { strategy: ['google', 'anthropic'] });
    const w = strategyWho();
    expect(w.mode).toBe('web');
    expect(w.who).toBe('Anthropic Claude does the research with claude-opus-5-5 (effort Medium), and Google Gemini writes the other 5 steps with gemini-3.8-flash (effort Medium): 6 steps, 6 requests.');
    expect(w.cost).toContain('Billed to the keys that power Strategy');
    expect(strategyWho({ requests: 1, research: true }).who).toBe('Anthropic Claude writes your strategy with claude-opus-5-5 (effort Medium): 1 request.');
    expect(strategyWho({ requests: 5, research: false }).who).toBe('Google Gemini writes your strategy with gemini-3.8-flash (effort Medium): 5 steps, 5 requests.');
  });

  it('a key that can’t search: general knowledge, and how to get sources', () => {
    server([GOOGLE], { strategy: ['google'] });
    const w = strategyWho();
    expect(w).toMatchObject({ mode: 'general', settings: true });
    expect(w.who).toBe('Google Gemini writes your strategy with gemini-3.8-flash (effort Medium): 6 steps, 6 requests.');
    expect(w.cost).toBe('Google Gemini can’t search the web for Strategy, so the research comes from its general knowledge (no sources). For sources, tick Strategy for a key that can search (Anthropic, OpenAI, xAI, Meta or OpenRouter) in Settings › AI keys.');
  });

  it('no key, server down, still checking', () => {
    server([GOOGLE], {});
    expect(strategyWho()).toMatchObject({ mode: 'builtin', cost: '', settings: true, who: 'No API key powers Strategy yet, so the built-in engine writes a starter plan: free, general guidance, not research.' });
    useRuntime.getState().set({ server: 'down' });
    expect(strategyWho()).toMatchObject({ mode: 'builtin', settings: true, who: 'Your AI server isn’t running, so the built-in engine writes a starter plan (free).' });
    useRuntime.getState().set({ server: 'ok', ai: NO_AI_SERVER });
    expect(strategyWho()).toMatchObject({ mode: 'checking', who: 'Checking which AI key powers Strategy…' });
  });

  it('claude.ai: Claude writes it, with no web search; without Claude, the built-in engine', () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    useRuntime.getState().set({ claude: 'available' });
    expect(strategyWho()).toMatchObject({ mode: 'claude', settings: false, who: 'Claude writes your strategy through your claude.ai account, in 6 steps.', cost: 'There’s no web search in claude.ai, so findings come from Claude’s general knowledge and may be out of date.' });
    expect(strategyWho().deep.show).toBe(false);
    useRuntime.getState().set({ claude: 'declined' });
    expect(strategyWho()).toMatchObject({ mode: 'builtin', who: 'Claude isn’t available here, so the built-in engine writes a starter plan (free).' });
  });
});

describe('deep research with Manus', () => {
  it('ready when a Manus key powers it', () => {
    server([ANTHROPIC, MANUS], { strategy: ['anthropic'], marketResearch: ['manus'] });
    expect(strategyWho().deep).toEqual({ show: true, ok: true, reason: '', own: false });
    server([ANTHROPIC, { ...MANUS, own: true }], { strategy: ['anthropic'], marketResearch: ['manus'] });
    expect(strategyWho().deep.own).toBe(true);
  });

  it('says why not: server down, own key needed, not ticked, no Manus key', () => {
    useRuntime.getState().set({ server: 'down' });
    expect(strategyWho().deep).toMatchObject({ ok: false, reason: 'Your AI server isn’t running.' });
    server([ANTHROPIC], { strategy: ['anthropic'] }, { posting: { reason: 'own_key_needed' } });
    expect(strategyWho().deep.reason).toBe('Deep research uses your own Manus account: add your Manus API key in Settings › AI keys.');
    server([ANTHROPIC, MANUS], { strategy: ['anthropic'], marketResearch: [] });
    expect(strategyWho().deep.reason).toBe('Tick Deep research (Manus) for your Manus key in Settings › AI keys.');
    server([ANTHROPIC], { strategy: ['anthropic'] });
    expect(strategyWho().deep).toEqual({ show: true, ok: false, reason: 'Add a Manus key in Settings › AI keys to use deep research.', own: false });
  });
});
