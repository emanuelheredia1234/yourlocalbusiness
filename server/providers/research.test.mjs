// Web research for Strategy: the request options, which keys search, the sources each provider
// returns (normalized), the router's order and fallback rules, the daily-limit estimate and the routes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PROVIDERS, PROVIDER_IDS, describeProviders, fnById, supports } from './registry.mjs';
import { AIStore } from './store.mjs';
import { UsageLog } from './usage.mjs';
import { AIRouter } from './router.mjs';
import { createAIRoutes } from './routes.mjs';
import { createAuth } from '../auth.mjs';
import { createLimits } from '../limits.mjs';
import { RESEARCH_TIMEOUT_MS, TOOL_REFUSED, TOOL_VERSION, canResearch, isHttpUrl, normalizeSources, researchFromBody, researchInfo, researchMeta, searchPrice, sourceKey, userLocation } from './research.mjs';
import { responsesOutput, responsesUsage } from './adapters/responses.mjs';
import { createMockProviders } from '../test/mock-providers.mjs';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { QA_SOURCES, STRATEGY_QA } from '../test/strategy-qa.mjs';

const ENV = { OPENROUTER_API_KEY: 'or-key-1111', OPENROUTER_API_KEY_2: 'or2-key-8888', GEMINI_API_KEY: 'g-key-2222', XAI_API_KEY: 'x-key-3333', ANTHROPIC_API_KEY: 'a-key-4444', META_MODEL_API_KEY: 'm-key-5555', MANUS_API_KEY: 'mn-key-6666', OPENAI_API_KEY: 'o-key-7777' };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-research-'));

/** The research step's prompt starts with its marker: the mock answers with STRATEGY_QA.research. */
const PROMPT = '[ylb-strategy:research v1] Research how a business like this one finds clients and makes sales, in Austin, Texas.';
const RESEARCH = { maxSearches: 5, location: { city: 'Austin', region: 'Texas' } };
const AUSTIN = { type: 'approximate', city: 'Austin', region: 'Texas' };

let mock;
beforeAll(async () => {
  mock = await createMockProviders({ keys: { openrouter: ['or-key-1111', 'or2-key-8888'], google: 'g-key-2222', xai: 'x-key-3333', anthropic: 'a-key-4444', meta: 'm-key-5555', manus: 'mn-key-6666', openai: 'o-key-7777' } }).start();
});
afterAll(() => mock.close());
beforeEach(() => mock.reset());

/**
 * A router where only `ids` (in that order) have keys. With another `fetch`, pass `env` with a key of
 * its own: the Anthropic adapter keeps one SDK client per base URL and key.
 */
function setup(ids = PROVIDER_IDS, { fetch, researchTimeoutMs, env = ENV } = {}) {
  const keys = Object.fromEntries(Object.entries(env).filter(([name]) => ids.some((id) => PROVIDERS[id].envKeys.includes(name))));
  const store = new AIStore(path.join(tmpDir(), 'ai-providers.json'), { env: keys });
  store.setOrder(ids);
  const usage = new UsageLog('');
  const router = new AIRouter({ store, usage, baseUrls: mock.baseUrls(), ...(fetch ? { fetch } : {}), ...(researchTimeoutMs ? { researchTimeoutMs } : {}) });
  return { store, usage, router };
}

const callsTo = (provider, p) => mock.calls.filter((c) => c.provider === provider && (!p || c.path === p));
const S = QA_SOURCES;

// ───────────── research.mjs ─────────────

describe('URL rules (the same table as src/lib/strategy.test.ts)', () => {
  it('isHttpUrl: http(s), a host name with a dot, no user:password, at most 2,000 characters', () => {
    expect(isHttpUrl('https://example.com/a')).toBe(true);
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,x')).toBe(false);
    expect(isHttpUrl('ftp://example.com/x')).toBe(false);
    expect(isHttpUrl('https://user:pw@example.com/')).toBe(false);
    expect(isHttpUrl('https://localhost/x')).toBe(false);
    expect(isHttpUrl(`https://example.com/${'a'.repeat(2000)}`)).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(42)).toBe(false);
  });

  it('sourceKey: the same page however it’s written', () => {
    expect(sourceKey('https://www.Example.com/path/?utm_source=x&b=2#frag')).toBe('example.com/path?b=2');
    expect(sourceKey('http://example.com/path?b=2')).toBe('example.com/path?b=2');
    expect(sourceKey('https://example.org/qa?gclid=1')).toBe('example.org/qa');
    expect(sourceKey('not a url')).toBe('');
    expect(sourceKey(S[1].url)).toBe(sourceKey('https://example.org/qa-research/content-that-works'));
  });
});

describe('research options from a request body', () => {
  it('are refused for a function that can’t research, and ignored when not asked for', () => {
    expect(fnById.strategy.research).toBe(true);
    expect(fnById.seo.research).toBeUndefined();
    expect(() => researchFromBody({ research: { web: true } }, 'seo')).toThrow('Web research isn’t available for this function.');
    try {
      researchFromBody({ research: { web: true } }, 'seo');
    } catch (e) {
      expect(e.status).toBe(400);
    }
    for (const b of [{}, { research: null }, { research: false }]) {
      expect(researchFromBody(b, 'seo')).toBeNull();
      expect(researchFromBody(b, 'strategy')).toBeNull();
    }
    expect(researchFromBody({ research: { web: false, maxSearches: 3 } }, 'strategy')).toBeNull();
    expect(researchFromBody({ research: 'yes' }, 'strategy')).toBeNull();
    expect(researchFromBody({ research: [true] }, 'strategy')).toBeNull();
  });

  it('round and clamp the searches to 1-8 (5 when missing or not a number)', () => {
    const n = (maxSearches) => researchFromBody({ research: { web: true, maxSearches } }, 'strategy').maxSearches;
    expect(n(undefined)).toBe(5);
    expect(n(null)).toBe(5);
    expect(n('7')).toBe(5);
    expect(n(Number.NaN)).toBe(5);
    expect(n(3)).toBe(3);
    expect(n(3.6)).toBe(4);
    expect(n(0)).toBe(1);
    expect(n(-4)).toBe(1);
    expect(n(99)).toBe(8);
  });

  it('read only the city and region, one line each, and nothing else', () => {
    const r = researchFromBody({ research: { web: true, location: { city: 'Austin\nTexas\u0000', region: '\tTexas\r\n', country: 'US', lat: 30.2, lng: -97.7 }, engine: 'exa', allowed_domains: ['evil.example'], tools: [{ type: 'x_search' }] } }, 'strategy');
    expect(r).toEqual({ maxSearches: 5, location: { city: 'Austin Texas', region: 'Texas' } });
    expect(researchFromBody({ research: { web: true, location: { city: 'x'.repeat(200) } } }, 'strategy').location).toEqual({ city: 'x'.repeat(80), region: '' });
    expect(researchFromBody({ research: { web: true, location: { city: ' \n ', region: '' } } }, 'strategy').location).toBeNull();
    expect(researchFromBody({ research: { web: true, location: 'Austin' } }, 'strategy').location).toBeNull();
    expect(userLocation(null)).toEqual({ type: 'approximate' });
    expect(userLocation({ city: 'Austin', region: '' })).toEqual({ type: 'approximate', city: 'Austin' });
  });
});

describe('which keys can search', () => {
  it('Anthropic, OpenAI (not old models), xAI (not Grok 1-3), Meta and OpenRouter; never Google or Manus', () => {
    for (const m of PROVIDERS.anthropic.kinds.text.models) expect(canResearch('anthropic', m.id), m.id).toBe(true);
    expect(canResearch('openai', 'gpt-6.1-sol')).toBe(true);
    expect(canResearch('openai', 'gpt-4o')).toBe(false);
    expect(canResearch('openai', 'gpt-4-turbo')).toBe(false);
    expect(canResearch('openai', 'gpt-3.5-turbo')).toBe(false);
    expect(canResearch('xai', 'grok-4.6')).toBe(true);
    expect(canResearch('xai', 'grok-4.20')).toBe(true);
    expect(canResearch('xai', 'grok-3-mini')).toBe(false);
    expect(canResearch('xai', 'grok-3')).toBe(false);
    expect(canResearch('meta', 'muse-spark-1.3')).toBe(true);
    expect(canResearch('openrouter', 'anthropic/claude-opus-5.5')).toBe(true);
    expect(canResearch('openrouter2', 'google/gemini-3.8-flash')).toBe(true);
    for (const m of PROVIDERS.google.kinds.text.models) expect(canResearch('google', m.id), m.id).toBe(false);
    expect(canResearch('manus', 'manus')).toBe(false);
  });

  it('with list prices per search', () => {
    expect(researchInfo('anthropic', 'claude-opus-5-5')).toEqual({ perSearch: 0.01 });
    expect(researchInfo('openai', 'gpt-6.1-sol')).toEqual({ perSearch: 0.01 });
    expect(researchInfo('xai', 'grok-4.6')).toEqual({ perSearch: 0.005 });
    expect(researchInfo('meta', 'muse-spark-1.3')).toEqual({ perSearch: 0.0025 });
    expect(researchInfo('openrouter3', 'x-ai/grok-4.6')).toEqual({ perSearch: 0.01 });
    expect(researchInfo('xai', 'grok-3-mini')).toBeNull();
    expect(researchInfo('google', 'gemini-3.8-flash')).toBeNull();
    expect(researchInfo('manus', undefined)).toBeNull();
    expect(searchPrice('google')).toBe(0);
    expect(RESEARCH_TIMEOUT_MS).toBe(600_000);
  });

  it('show in the Settings catalog, and only Manus can do agent work', () => {
    const catalog = Object.fromEntries(describeProviders().map((p) => [p.id, p]));
    expect(catalog.anthropic.kinds.text.research).toEqual({ perSearch: 0.01 });
    expect(catalog.openrouter2.kinds.text.research).toEqual({ perSearch: 0.01 });
    expect(catalog.google.kinds.text.research).toBeNull();
    expect(catalog.openai.kinds.image.research).toBeNull();
    expect(catalog.manus.kinds.agent.research).toBeNull();
    expect(supports('google', 'marketResearch')).toEqual({ ok: false, reason: 'Only the Manus agent can do this: it works in its own browser.' });
    expect(supports('manus', 'marketResearch').ok).toBe(true);
    expect(supports('manus', 'strategy').ok).toBe(false);
    expect(supports('google', 'strategy').ok).toBe(true);
  });
});

describe('sources', () => {
  it('drop anything that isn’t an http(s) page with a real host name', () => {
    const out = normalizeSources([
      { url: 'javascript:alert(1)' },
      { url: 'data:text/html,x' },
      { url: 'ftp://example.com/x' },
      { url: 'https://user:pw@example.com/' },
      { url: 'https://intranet/page' },
      { url: `https://example.com/${'a'.repeat(2000)}` },
      { url: 'https://example.com/a b' },
      { url: 42 },
      null,
      { url: 'https://example.com/ok' },
    ]);
    expect(out.map((s) => s.url)).toEqual(['https://example.com/ok']);
    expect(normalizeSources('nope')).toEqual([]);
  });

  it('de-duplicate the same page however it’s written, keeping the URL as the provider sent it', () => {
    const out = normalizeSources([
      { url: 'https://WWW.Example.org/qa/?utm_source=x#top', title: '' },
      { url: 'https://example.org/qa', title: 'The QA page', cited: true, quote: 'Cited text.' },
    ]);
    expect(out).toEqual([{ n: 1, url: 'https://WWW.Example.org/qa/?utm_source=x#top', title: 'The QA page', domain: 'example.org', cited: true, quote: 'Cited text.' }]);
  });

  it('put cited ones first, number them from 1 and keep at most 30', () => {
    const raw = Array.from({ length: 35 }, (_, i) => ({ url: `https://example.com/p${i}`, title: `Page ${i}`, cited: i === 20 || i === 33 }));
    const out = normalizeSources(raw);
    expect(out).toHaveLength(30);
    expect(out.map((s) => s.n)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(out.slice(0, 3).map((s) => s.url)).toEqual(['https://example.com/p20', 'https://example.com/p33', 'https://example.com/p0']);
  });

  it('use the domain for a missing or numeric title, and cap titles, quotes and page dates', () => {
    const out = normalizeSources([
      { url: 'https://www.example.com/a', title: '1' },
      { url: 'https://example.net/b', title: '[2]' },
      { url: 'https://example.org/c', title: `Line one\nline two ${'t'.repeat(300)}`, quote: 'q'.repeat(400), pageAge: `${'2'.repeat(60)}`, cited: true },
    ]);
    const [c, a, b] = out;
    expect(c).toMatchObject({ n: 1, domain: 'example.org' });
    expect(c.title).toHaveLength(160);
    expect(c.title.startsWith('Line one line two')).toBe(true);
    expect(c.quote).toHaveLength(200);
    expect(c.pageAge).toHaveLength(40);
    expect(a).toEqual({ n: 2, url: 'https://www.example.com/a', title: 'example.com', domain: 'example.com', cited: false });
    expect(b.title).toBe('example.net');
  });
});

describe('meta.research', () => {
  const found = { searches: 2, sources: [{ url: S[0].url, title: S[0].title, cited: true }], queries: ['q1', 'q1', 'q2'], errors: [] };

  it('is web only when the key searched and a source came back', () => {
    expect(researchMeta(true, found)).toEqual({ web: true, reason: '', searches: 2, queries: ['q1', 'q2'], sources: [{ n: 1, url: S[0].url, title: S[0].title, domain: 'example.com', cited: true }], errors: [] });
  });

  it('says why it isn’t', () => {
    expect(researchMeta(false, found)).toMatchObject({ web: false, reason: 'unsupported', sources: [] });
    expect(researchMeta(false)).toEqual({ web: false, reason: 'unsupported', searches: 0, queries: [], sources: [], errors: [] });
    expect(researchMeta(true, { ...found, refused: true })).toMatchObject({ web: false, reason: 'provider_refused', sources: [] });
    expect(researchMeta(true, { searches: 0, sources: [], queries: ['q'], errors: ['too_many_requests'] })).toMatchObject({ web: false, reason: 'search_failed', errors: ['too_many_requests'] });
    expect(researchMeta(true, { searches: 0, sources: [] })).toMatchObject({ web: false, reason: 'not_used' });
    // sources without a search the provider counted don't make it web research
    expect(researchMeta(true, { searches: 0, sources: found.sources })).toMatchObject({ web: false, reason: 'not_used', sources: [] });
    expect(researchMeta(true, { searches: 3, sources: [{ url: 'not a url' }] })).toMatchObject({ web: false, reason: 'no_results', searches: 3 });
    // one search went through but found nothing, another failed: it searched, so no results
    expect(researchMeta(true, { searches: 1, sources: [], errors: ['unavailable'] })).toMatchObject({ web: false, reason: 'no_results' });
  });

  it('keeps queries and errors short and few', () => {
    const m = researchMeta(true, { searches: 99, sources: [], queries: Array.from({ length: 20 }, (_, i) => `query ${i} ${'x'.repeat(300)}`), errors: Array.from({ length: 9 }, (_, i) => `error_${i}_${'e'.repeat(60)}`) });
    expect(m.searches).toBe(50);
    expect(m.queries).toHaveLength(12);
    expect(m.queries.every((q) => q.length <= 200)).toBe(true);
    expect(m.errors).toHaveLength(5);
    expect(m.errors.every((e) => e.length <= 40)).toBe(true);
  });

  it('knows a 400 about the search tool from other 400s', () => {
    expect(TOOL_REFUSED.test('web search is not enabled for this organization')).toBe(true);
    expect(TOOL_REFUSED.test('No endpoints found that support tool use')).toBe(true);
    expect(TOOL_REFUSED.test('openrouter:web_search is not available for this model')).toBe(true);
    expect(TOOL_REFUSED.test('max_tokens: must be at most 64000')).toBe(false);
    expect(TOOL_VERSION.test('web_search_20260209 is not supported for this model')).toBe(true);
    expect(TOOL_VERSION.test('web search is not enabled for this organization')).toBe(false);
  });
});

describe('the Responses API reader', () => {
  it('answers with the last message, counts real searches, and never keeps snippets', () => {
    const o = responsesOutput({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Let me look that up.' }] },
        { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'a', queries: ['b'], sources: [{ type: 'url', url: 'https://example.com/1' }] } },
        { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://example.com/2' } },
        { type: 'web_search_call', status: 'failed', action: { type: 'search', query: 'c' } },
        { type: 'web_search_call', status: 'completed', results: [{ type: 'text_result', title: 'Three', url: 'https://example.com/3', snippet: 'page text' }] },
        { type: 'message', content: [{ type: 'output_text', text: '{"ok":true}', annotations: [{ type: 'url_citation', url: 'https://example.com/1', title: 'One' }] }] },
      ],
    });
    expect(o.text).toBe('{"ok":true}');
    expect(o.allText).toBe('Let me look that up.{"ok":true}');
    expect(o.searchCalls).toBe(2);
    expect(o.errors).toEqual(['failed']);
    expect(o.queries).toEqual(['a', 'b', 'c']);
    expect(o.sources.map((s) => s.url)).toEqual(['https://example.com/1', 'https://example.com/1', 'https://example.com/2', 'https://example.com/3']);
    expect(JSON.stringify(o)).not.toContain('page text');
    expect(responsesUsage({ input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 100 }, total_tokens: 115 })).toEqual({ input: 10, output: 105, reasoning: 100 });
    expect(responsesUsage({ input_tokens: 10, output_tokens: 105, output_tokens_details: { reasoning_tokens: 100 }, total_tokens: 115 })).toEqual({ input: 10, output: 105, reasoning: 100 });
  });
});

// ───────────── adapters against the mock ─────────────

describe('each provider’s search tool, sources and cost', () => {
  it('Anthropic: web_search_20260209 with max_uses and the place; the answer after the search; cited text', async () => {
    const { router } = setup(['anthropic']);
    const out = await router.text('strategy', { prompt: PROMPT, research: RESEARCH });
    const sent = mock.last('anthropic', '/v1/messages');
    expect(sent.body.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 5, user_location: AUSTIN }]);
    // "Let me look that up." came before the search: only the JSON after it is the answer
    expect(JSON.parse(out.text)).toEqual(STRATEGY_QA.research);
    expect(out.meta).toMatchObject({ provider: 'anthropic', fn: 'strategy', searches: 1 });
    expect(out.meta.research).toEqual({
      web: true,
      reason: '',
      searches: 1,
      queries: ['qa stand-in search'],
      sources: [
        { n: 1, url: S[0].url, title: S[0].title, domain: 'example.com', cited: true, quote: 'QA stand-in text.', pageAge: 'October 1, 2026' },
        { n: 2, url: S[1].url, title: S[1].title, domain: 'example.org', cited: false },
        { n: 3, url: S[2].url, title: S[2].title, domain: 'example.net', cited: false },
      ],
      errors: [],
    });
    // Opus 5.5 list prices: 4,200 in × $4 + 900 out × $20 per million, plus one search at $0.01
    expect(out.meta.cost).toEqual({ usd: 0.0448, source: 'estimate' });
    expect(JSON.stringify(out)).not.toMatch(/encrypted/);
  });

  it('OpenAI: web_search with include, max_tool_calls and always a user_location; minimal effort becomes low', async () => {
    const { router, store } = setup(['openai']);
    store.update('openai', { models: { text: 'gpt-6-luna' }, effort: { text: 'minimal' } });
    const out = await router.text('strategy', { prompt: PROMPT, research: { maxSearches: 3, location: null } });
    const sent = mock.last('openai', '/responses');
    expect(sent.body).toMatchObject({ tools: [{ type: 'web_search', search_context_size: 'medium', user_location: { type: 'approximate' } }], include: ['web_search_call.action.sources'], max_tool_calls: 3, reasoning: { effort: 'low' }, store: false });
    expect(JSON.parse(out.text)).toEqual(STRATEGY_QA.research);
    expect(out.meta.research).toMatchObject({ web: true, searches: 1, queries: ['qa stand-in search'] });
    expect(out.meta.research.sources.map((s) => [s.n, s.domain, s.cited])).toEqual([
      [1, 'example.com', true],
      [2, 'example.org', false],
      [3, 'example.net', false],
    ]);
    // GPT-6 Luna: 4,200 × $0.10 + 900 × $0.50 per million, plus one search at $0.01
    expect(out.meta.cost).toEqual({ usd: 0.01087, source: 'estimate' });
    await router.text('strategy', { prompt: PROMPT, research: RESEARCH });
    expect(mock.last('openai', '/responses').body.tools[0].user_location).toEqual(AUSTIN);
  });

  it('xAI: the Responses API without inline citations; the exact cost it reports', async () => {
    const { router } = setup(['xai']);
    const out = await router.text('strategy', { prompt: PROMPT, research: RESEARCH });
    const sent = mock.last('xai', '/responses');
    expect(sent.body).toMatchObject({ model: 'grok-4.6', tools: [{ type: 'web_search' }], include: ['no_inline_citations'], max_turns: 4, store: false, reasoning: { effort: 'medium' } });
    expect(sent.body.instructions).toMatch(/JSON/);
    expect(callsTo('xai', '/chat/completions')).toHaveLength(0);
    // no [[1]](url) after the JSON
    expect(JSON.parse(out.text)).toEqual(STRATEGY_QA.research);
    expect(out.meta.cost).toEqual({ usd: 0.1234, source: 'provider' });
    expect(out.meta.research).toMatchObject({ web: true, searches: 2 });
    // xAI's "titles" are citation numbers: the domain stands in
    expect(out.meta.research.sources.map((s) => [s.n, s.title, s.cited])).toEqual([
      [1, 'example.com', true],
      [2, 'example.org', true],
    ]);
  });

  it('Meta: the Responses API with the search results included; the cost estimated with its searches', async () => {
    const { router } = setup(['meta']);
    const out = await router.text('strategy', { prompt: PROMPT, research: RESEARCH });
    const sent = mock.last('meta', '/responses');
    expect(sent.body).toMatchObject({ tools: [{ type: 'web_search', search_context_size: 'medium', user_location: AUSTIN }], include: ['web_search_call.results'], max_tool_calls: 5, store: false });
    expect(callsTo('meta', '/chat/completions')).toHaveLength(0);
    expect(JSON.parse(out.text)).toEqual(STRATEGY_QA.research);
    expect(out.meta.research).toMatchObject({ web: true, searches: 1 });
    expect(out.meta.research.sources.map((s) => [s.domain, s.cited])).toEqual([
      ['example.com', true],
      ['example.org', false],
      ['example.net', false],
    ]);
    // Muse Spark 1.3: 4,200 × $1.25 + 900 × $4.25 per million, plus one search at $0.0025
    expect(out.meta.cost).toEqual({ usd: 0.011575, source: 'estimate' });
    expect(JSON.stringify(out)).not.toContain('QA stand-in snippet');
  });

  it('OpenRouter: its web_search server tool (Exa for google/* models), the cost it reports, no page excerpts', async () => {
    const { router, store } = setup(['openrouter']);
    let out = await router.text('strategy', { prompt: PROMPT, research: RESEARCH });
    let sent = mock.last('openrouter', '/chat/completions');
    expect(sent.body.model).toBe('google/gemini-3.8-flash');
    expect(sent.body.tools).toEqual([{ type: 'openrouter:web_search', parameters: { engine: 'exa', max_uses: 5, max_total_results: 25 } }]);
    expect(sent.body.max_tool_calls).toBe(5);
    expect(out.meta.cost).toEqual({ usd: 0.0421, source: 'provider' });
    expect(out.meta.research).toMatchObject({ web: true, searches: 2 });
    expect(out.meta.research.sources.map((s) => [s.n, s.title, s.cited])).toEqual([
      [1, S[0].title, true],
      [2, S[1].title, true],
    ]);
    expect(JSON.stringify(out)).not.toContain('QA stand-in excerpt');
    expect(out).not.toHaveProperty('annotations');
    store.update('openrouter', { models: { text: 'anthropic/claude-opus-5.5' } });
    out = await router.text('strategy', { prompt: PROMPT, research: RESEARCH });
    sent = mock.last('openrouter', '/chat/completions');
    expect(sent.body.tools[0].parameters).toEqual({ engine: 'auto', max_uses: 5, max_total_results: 25, user_location: AUSTIN });
  });

  it('sends exactly today’s requests when research isn’t asked for', async () => {
    const cases = [
      ['anthropic', '/v1/messages'],
      ['openai', '/responses'],
      ['xai', '/chat/completions'],
      ['meta', '/chat/completions'],
      ['openrouter', '/chat/completions'],
      ['google', '/interactions'],
    ];
    for (const [id, p] of cases) {
      const { router } = setup([id]);
      mock.reset();
      const out = await router.text('strategy', { prompt: PROMPT });
      expect(mock.calls.map((c) => c.path), id).toEqual([p]);
      const body = mock.calls[0].body;
      for (const k of ['tools', 'include', 'max_tool_calls', 'max_turns']) expect(body, `${id} ${k}`).not.toHaveProperty(k);
      expect(out.meta, id).not.toHaveProperty('research');
      expect(out.meta, id).not.toHaveProperty('searches');
    }
  });
});

describe('Anthropic specifics', () => {
  it('continues a paused turn with everything so far, the same tools, and adds up usage and searches', async () => {
    const { router } = setup(['anthropic']);
    const out = await router.text('strategy', { prompt: `${PROMPT}\nAnything else: qa-pause-turn`, research: RESEARCH });
    const calls = callsTo('anthropic', '/v1/messages');
    expect(calls).toHaveLength(2);
    const [first, second] = calls.map((c) => c.body);
    // the same tool, but max_uses counts the searches of one request: the continuation may run only the 4 left
    expect(first.tools[0].max_uses).toBe(5);
    expect(second.tools).toEqual([{ ...first.tools[0], max_uses: 4 }]);
    expect(second.system).toBe(first.system);
    expect(second.messages).toHaveLength(2);
    expect(second.messages[0]).toEqual(first.messages[0]);
    expect(second.messages[1].role).toBe('assistant');
    // the paused content goes back unchanged (a continuation, not a new question)
    expect(second.messages[1].content.map((b) => b.type)).toEqual(['server_tool_use', 'web_search_tool_result']);
    expect(second.messages[1].content[0].input).toEqual({ query: 'qa stand-in search' });
    expect(JSON.parse(out.text)).toEqual(STRATEGY_QA.research);
    expect(out.meta.usage).toEqual({ input: 8400, output: 1020, reasoning: null });
    expect(out.meta.research).toMatchObject({ web: true, searches: 2, queries: ['qa stand-in search'] });
  });

  it('never runs more searches than asked over a paused turn: with none left, the turn isn’t continued', async () => {
    const { router, usage } = setup(['anthropic']);
    const err = await router.text('strategy', { prompt: `${PROMPT}\nAnything else: qa-pause-turn`, research: { ...RESEARCH, maxSearches: 1 } }).catch((e) => e);
    // max_uses can't be 0 and the tool has to stay on a continuation, so the turn ends where it paused
    expect(callsTo('anthropic', '/v1/messages')).toHaveLength(1);
    expect(err.code).toBe('CUT_OFF');
    // what the call used is known (4,200 in, 120 out, one search): logged at list prices
    expect(usage.recent(1)[0]).toMatchObject({ ok: false, code: 'CUT_OFF', research: true, searches: 1, usage: { input: 4200, output: 120 }, cost: { usd: 0.0292, source: 'estimate' } });
  });

  it('treats a failed continuation as paid work: no other key searches again, and what the first call used counts', async () => {
    let sent = 0;
    const f = async (url, init) => {
      if (String(url).endsWith('/v1/messages') && ++sent === 2) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of input tokens has exceeded your per-minute rate limit' } }), { status: 429, headers: { 'content-type': 'application/json' } });
      }
      return fetch(url, init);
    };
    const { router, usage } = setup(['anthropic', 'openai'], { fetch: f, env: { ANTHROPIC_API_KEY: `${ENV.ANTHROPIC_API_KEY}-continued`, OPENAI_API_KEY: ENV.OPENAI_API_KEY } });
    const metered = [];
    const meter = { start() {}, cost: (usd, o) => metered.push([usd, !!o?.unsure]) };
    const err = await router.text('strategy', { prompt: `${PROMPT}\nAnything else: qa-pause-turn`, research: RESEARCH, meter }).catch((e) => e);
    expect(sent).toBe(2);
    expect(err).toMatchObject({ code: 'RATE_LIMIT', notStarted: false });
    expect(err.attempts).toEqual([expect.objectContaining({ provider: 'anthropic', code: 'RATE_LIMIT' })]);
    expect(callsTo('openai')).toHaveLength(0);
    // the 429 billed nothing, so the first call is all of it: 4,200 in, 120 out and one search
    expect(usage.recent(1)[0]).toMatchObject({ ok: false, provider: 'anthropic', code: 'RATE_LIMIT', research: true, searches: 1, cost: { usd: 0.0292, source: 'estimate' } });
    expect(metered).toEqual([[0.0292, true]]);
  });

  it('says the search failed when every search errored', async () => {
    const { router } = setup(['anthropic']);
    const out = await router.text('strategy', { prompt: `${PROMPT} qa-research-error`, research: RESEARCH });
    expect(out.meta.research).toEqual({ web: false, reason: 'search_failed', searches: 0, queries: ['qa stand-in search'], sources: [], errors: ['too_many_requests'] });
    // an errored search isn't billed: tokens only
    expect(out.meta.cost).toEqual({ usd: 0.0348, source: 'estimate' });
    expect(JSON.parse(out.text)).toEqual(STRATEGY_QA.research);
  });

  it('sends a refused search once more without the tool (a 400 isn’t billed)', async () => {
    const { router } = setup(['anthropic']);
    const out = await router.text('strategy', { prompt: `${PROMPT} qa-research-refused`, research: RESEARCH });
    const calls = callsTo('anthropic', '/v1/messages');
    expect(calls).toHaveLength(2);
    expect(calls[0].body.tools).toHaveLength(1);
    expect(calls[1].body).not.toHaveProperty('tools');
    expect(out.meta.research).toMatchObject({ web: false, reason: 'provider_refused', sources: [] });
    expect(JSON.parse(out.text)).toEqual(STRATEGY_QA.research);
  });

  it('never lets the SDK retry a research call (an ordinary call is retried once)', async () => {
    const { router } = setup(['anthropic']);
    mock.behavior.anthropic = 'fail500';
    await expect(router.text('strategy', { prompt: PROMPT, research: RESEARCH })).rejects.toMatchObject({ code: 'UPSTREAM' });
    expect(callsTo('anthropic', '/v1/messages')).toHaveLength(1);
    mock.reset();
    mock.behavior.anthropic = 'fail500';
    await expect(router.text('strategy', { prompt: PROMPT })).rejects.toMatchObject({ code: 'UPSTREAM' });
    expect(callsTo('anthropic', '/v1/messages')).toHaveLength(2);
  });

  /** A fetch that answers the first Messages calls with these 400 messages, then lets requests through to the mock. */
  const refusing = (messages) => {
    const sent = [];
    const f = async (url, init) => {
      if (String(url).endsWith('/v1/messages')) {
        sent.push(JSON.parse(init.body));
        const message = messages[sent.length - 1];
        if (message) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return fetch(url, init);
    };
    return { fetch: f, sent };
  };

  it('tries allowed_callers ["direct"], then the basic tool version, for free (at most twice)', async () => {
    // (the mock accepts any key that contains the real one)
    const withKey = (n) => ({ env: { ANTHROPIC_API_KEY: `${ENV.ANTHROPIC_API_KEY}-refusing-${n}` } });
    let r = refusing(['tools.0: this model doesn’t support programmatic tool calling; set "allowed_callers": ["direct"]']);
    let out = await setup(['anthropic'], { fetch: r.fetch, ...withKey(1) }).router.text('strategy', { prompt: PROMPT, research: RESEARCH });
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1].tools[0]).toMatchObject({ type: 'web_search_20260209', allowed_callers: ['direct'], max_uses: 5 });
    expect(out.meta.research.web).toBe(true);

    r = refusing(['tools.0: web_search_20260209 is not supported for this model']);
    out = await setup(['anthropic'], { fetch: r.fetch, ...withKey(2) }).router.text('strategy', { prompt: PROMPT, research: RESEARCH });
    expect(r.sent.map((b) => b.tools?.[0]?.type)).toEqual(['web_search_20260209', 'web_search_20250305']);
    expect(out.meta.research.web).toBe(true);

    // a third 400 is the answer
    r = refusing(['set "allowed_callers": ["direct"]', 'web_search_20260209 is not supported for this model', 'web search is not enabled for this organization']);
    const err = await setup(['anthropic'], { fetch: r.fetch, ...withKey(3) }).router.text('strategy', { prompt: PROMPT, research: RESEARCH }).catch((e) => e);
    expect(err.code).toBe('BAD_REQUEST');
    expect(r.sent).toHaveLength(3);
  });
});

// ───────────── the router ─────────────

describe('routing a research request', () => {
  it('puts the keys that can search first', async () => {
    const { router, store, usage } = setup(['google', 'anthropic']);
    expect(store.route('strategy')).toEqual(['google', 'anthropic']);
    const out = await router.text('strategy', { prompt: PROMPT, research: RESEARCH });
    expect(out.meta.provider).toBe('anthropic');
    expect(out.meta.research.web).toBe(true);
    expect(callsTo('google')).toHaveLength(0);
    // the usage log counts the searches, never what they found
    const entry = usage.recent(1)[0];
    expect(entry).toMatchObject({ ok: true, provider: 'anthropic', fn: 'strategy', research: true, searches: 1 });
    expect(entry).not.toHaveProperty('sources');
    expect(entry).not.toHaveProperty('queries');
    expect(JSON.stringify(usage.recent(10))).not.toMatch(/example\.(com|org|net)|qa stand-in search/);
    expect(usage.totals().providers.find((p) => p.provider === 'anthropic').searches).toBe(1);
    // an ordinary request keeps the owner's order
    const plain = await router.text('strategy', { prompt: PROMPT });
    expect(plain.meta.provider).toBe('google');
    expect(usage.recent(1)[0]).toMatchObject({ provider: 'google', searches: 0 });
    expect(usage.recent(1)[0]).not.toHaveProperty('research');
  });

  it('runs without search on a key that can’t search, and says so', async () => {
    const { router } = setup(['google']);
    const out = await router.text('strategy', { prompt: PROMPT, research: RESEARCH });
    expect(out.meta.provider).toBe('google');
    expect(out.meta.research).toEqual({ web: false, reason: 'unsupported', searches: 0, queries: [], sources: [], errors: [] });
    expect(out.meta.searches).toBe(0);
    expect(mock.last('google', '/interactions').body).not.toHaveProperty('tools');
  });

  it('doesn’t try another key after a research request timed out (its searches may be billed)', async () => {
    const { router } = setup(['anthropic', 'openai'], { researchTimeoutMs: 300 });
    const err = await router.text('strategy', { prompt: `${PROMPT} qa-research-slow`, research: RESEARCH }).catch((e) => e);
    expect(err.code).toBe('TIMEOUT');
    expect(err.attempts).toEqual([expect.objectContaining({ provider: 'anthropic', code: 'TIMEOUT' })]);
    expect(callsTo('openai')).toHaveLength(0);
    // on the Responses API too
    mock.reset();
    const openaiFirst = setup(['openai', 'xai'], { researchTimeoutMs: 300 });
    await expect(openaiFirst.router.text('strategy', { prompt: `${PROMPT} qa-research-slow`, research: RESEARCH })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(callsTo('xai')).toHaveLength(0);
  });

  it('logs a research request that failed after it started at an estimate, and tells the meter; never one that started nothing', async () => {
    const metered = [];
    const meter = { start() {}, cost: (usd, o) => metered.push([usd, !!o?.unsure]) };
    const { router, usage } = setup(['anthropic'], { researchTimeoutMs: 300 });
    // timed out: its searches may be billed and nothing says how many, so a research-sized request with all 5 (Opus 5.5: $0.28 + 5 × $0.01)
    await expect(router.text('strategy', { prompt: `${PROMPT} qa-research-slow`, research: RESEARCH, meter })).rejects.toMatchObject({ code: 'TIMEOUT' });
    const entry = usage.recent(1)[0];
    expect(entry).toMatchObject({ ok: false, code: 'TIMEOUT', research: true, cost: { usd: 0.33, source: 'estimate' } });
    expect(entry).not.toHaveProperty('searches');
    expect(metered).toEqual([[0.33, true]]);
    // refused before it did anything (429): no cost, and nothing for the meter
    metered.length = 0;
    mock.behavior.anthropic = 'rate';
    await expect(router.text('strategy', { prompt: PROMPT, research: RESEARCH, meter })).rejects.toMatchObject({ code: 'RATE_LIMIT', notStarted: true });
    expect(usage.recent(1)[0]).toMatchObject({ ok: false, code: 'RATE_LIMIT', research: true });
    expect(usage.recent(1)[0]).not.toHaveProperty('cost');
    // an ordinary request that fails is logged as before
    mock.behavior.anthropic = 'fail500';
    await expect(router.text('strategy', { prompt: PROMPT, meter })).rejects.toMatchObject({ code: 'UPSTREAM' });
    expect(usage.recent(1)[0]).not.toHaveProperty('cost');
    expect(metered).toEqual([]);
  });

  it('tries the next key after one refused before doing anything (429)', async () => {
    const { router } = setup(['anthropic', 'openai']);
    mock.behavior.anthropic = 'rate';
    const out = await router.text('strategy', { prompt: PROMPT, research: RESEARCH });
    expect(out.meta.provider).toBe('openai');
    expect(out.meta.research.web).toBe(true);
    expect(out.meta.attempts).toEqual([expect.objectContaining({ provider: 'anthropic', code: 'RATE_LIMIT' })]);
    // the SDK didn't retry the 429 either
    expect(callsTo('anthropic', '/v1/messages')).toHaveLength(1);
  });

  it('degrades on every provider: not used, failed, refused', async () => {
    for (const id of ['openai', 'xai', 'meta', 'openrouter']) {
      const { router } = setup([id]);
      const none = await router.text('strategy', { prompt: `${PROMPT} qa-research-none`, research: RESEARCH });
      expect(none.meta.research, id).toMatchObject({ web: false, reason: 'not_used', searches: 0, sources: [] });
      expect(JSON.parse(none.text), id).toEqual(STRATEGY_QA.research);
      mock.reset();
      const refused = await router.text('strategy', { prompt: `${PROMPT} qa-research-refused`, research: RESEARCH });
      expect(refused.meta.research, id).toMatchObject({ web: false, reason: 'provider_refused', sources: [] });
      expect(JSON.parse(refused.text), id).toEqual(STRATEGY_QA.research);
      expect(mock.calls, id).toHaveLength(2);
      expect(mock.calls[1].body, id).not.toHaveProperty('tools');
      mock.reset();
    }
    for (const id of ['openai', 'xai', 'meta']) {
      const { router } = setup([id]);
      const failed = await router.text('strategy', { prompt: `${PROMPT} qa-research-error`, research: RESEARCH });
      expect(failed.meta.research, id).toMatchObject({ web: false, reason: 'search_failed', searches: 0, sources: [], errors: ['failed'] });
    }
  });

  it('reserves a research-sized estimate for the daily limit', () => {
    const { router, store } = setup(['google', 'anthropic', 'xai']);
    // Opus 5.5: 40,000 in × $4 + 6,000 out × $20 per million = $0.28, plus 5 searches at $0.01
    expect(router.estimate('text', { fn: 'strategy', research: RESEARCH })).toBe(0.33);
    expect(router.estimate('text', { fn: 'strategy', research: { maxSearches: 8 } })).toBe(0.36);
    expect(router.estimate('text', { fn: 'strategy' })).toBe(0.02);
    store.update('anthropic', { functions: ['research'] });
    // Grok 4.6: $0.08 + $0.036 + 5 × $0.005
    expect(router.estimate('text', { fn: 'strategy', research: RESEARCH })).toBe(0.141);
    // no key powers it: $0.15 + $0.01 a search
    store.update('xai', { functions: ['research'] });
    store.update('google', { functions: ['research'] });
    expect(router.estimate('text', { fn: 'strategy', research: RESEARCH })).toBe(0.2);
  });
});

// ───────────── routes ─────────────

function startApp({ env = ENV, auth, limits } = {}) {
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'));
        } catch {
          reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
        }
      });
    });
  const ai = createAIRoutes({ send, readJson, corsHeaders: () => ({}), rateLimited: () => false, dataDir: tmpDir(), env, baseUrls: mock.baseUrls(), ...(auth ? { auth } : {}), ...(limits ? { limits } : {}) });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    ai.handle(req, res, url).then((h) => h === false && send(res, 404, { error: 'Not found' }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ ai, server, base: `http://127.0.0.1:${server.address().port}` })));
}

describe('POST /api/ai/generate with research', () => {
  let app;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(() => app.server.close());
  const generate = (body, headers = {}) => fetch(`${app.base}/api/ai/generate`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('refuses research for a function that can’t research, before anything is sent', async () => {
    const r = await generate({ fn: 'seo', prompt: 'x', research: { web: true } });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'Web research isn’t available for this function.', code: 'BAD_REQUEST' });
    expect(mock.calls).toHaveLength(0);
  });

  it('answers with the sources in meta, and never Anthropic’s encrypted content or OpenRouter’s excerpts', async () => {
    // OpenRouter is first in the default order, and can search
    let r = await generate({ fn: 'strategy', prompt: PROMPT, brain: true, research: { web: true, maxSearches: 3, location: { city: 'Austin', region: 'Texas', country: 'US' } } });
    expect(r.status).toBe(200);
    let raw = await r.text();
    expect(raw).not.toContain('QA stand-in excerpt');
    let j = JSON.parse(raw);
    expect(j.meta).toMatchObject({ provider: 'openrouter', searches: 2, research: { web: true, reason: '' } });
    expect(mock.last('openrouter', '/chat/completions').body.max_tool_calls).toBe(3);
    app.ai.store.setOrder(['anthropic']);
    r = await generate({ fn: 'strategy', prompt: PROMPT, research: { web: true } });
    raw = await r.text();
    expect(raw).not.toMatch(/encrypted/);
    j = JSON.parse(raw);
    expect(j.meta).toMatchObject({ provider: 'anthropic', searches: 1, research: { web: true } });
    expect(mock.last('anthropic', '/v1/messages').body.tools[0]).toEqual({ type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
    expect(JSON.parse(j.text)).toEqual(STRATEGY_QA.research);
    // research: false (or a web that isn't true) is an ordinary request
    r = await generate({ fn: 'strategy', prompt: PROMPT, research: { web: 'yes' } });
    j = await r.json();
    expect(j.meta).not.toHaveProperty('research');
    expect(mock.last('anthropic', '/v1/messages').body).not.toHaveProperty('tools');
    for (const k of Object.values(ENV)) expect(JSON.stringify(j)).not.toContain(k);
    const usage = await (await fetch(`${app.base}/api/ai/usage`)).json();
    expect(usage.totals.providers.find((p) => p.provider === 'anthropic').searches).toBe(1);
    app.ai.store.setOrder(PROVIDER_IDS);
  });

  it('tells the app which keys can search, and what powers Strategy', async () => {
    const h = await app.ai.health();
    const by = Object.fromEntries(h.providers.map((p) => [p.id, p]));
    expect(by.anthropic.research).toEqual({ perSearch: 0.01 });
    expect(by.openai.research).toEqual({ perSearch: 0.01 });
    expect(by.xai.research).toEqual({ perSearch: 0.005 });
    expect(by.meta.research).toEqual({ perSearch: 0.0025 });
    expect(by.openrouter2.research).toEqual({ perSearch: 0.01 });
    expect(by.google.research).toBeNull();
    expect(by.manus.research).toBeNull();
    expect(h.routing.strategy).toEqual(['openrouter', 'openrouter2', 'google', 'xai', 'anthropic', 'meta', 'openai']);
    expect(h.routing.marketResearch).toEqual(['manus']);
    // a key whose saved model can't search
    app.ai.store.update('xai', { models: { text: 'grok-3-mini' } });
    expect((await app.ai.health()).providers.find((p) => p.id === 'xai').research).toBeNull();
    app.ai.store.update('xai', { models: { text: '' } });
    const settings = await (await fetch(`${app.base}/api/ai/providers`)).json();
    expect(settings.catalog.find((p) => p.id === 'anthropic').kinds.text.research).toEqual({ perSearch: 0.01 });
    expect(settings.functions[0]).toMatchObject({ id: 'strategy', research: true, kind: 'text', group: 'writing' });
  });
});

describe('the daily limit for a research request', () => {
  let supa;
  beforeAll(async () => {
    supa = await (await createMockSupabase()).start();
  });
  afterAll(() => supa.close());

  it('reserves the research estimate first, so a request that alone would go over is refused before anything is sent', async () => {
    // signed-out visitors (sign-in not required) are metered like users, here in memory
    const auth = createAuth({ supabaseUrl: supa.url, publishableKey: supa.PUBLISHABLE, adminEmails: 'owner@example.com', signInRequired: false });
    const app = await startApp({ env: { ANTHROPIC_API_KEY: ENV.ANTHROPIC_API_KEY }, auth, limits: createLimits() });
    try {
      app.ai.store.setLimits({ requestsPerDay: 0, usdPerDay: 0.05 });
      expect(app.ai.router.estimate('text', { fn: 'strategy', research: RESEARCH })).toBeGreaterThan(0.02);
      const gen = (body) => fetch(`${app.base}/api/ai/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const r = await gen({ fn: 'strategy', prompt: PROMPT, research: { web: true, maxSearches: 5 } });
      expect(r.status).toBe(429);
      const j = await r.json();
      expect(j.code).toBe('DAILY_LIMIT');
      expect(j.error).toMatch(/This would cost about \$0\.33/);
      expect(mock.calls).toHaveLength(0);
      // without research the same request fits
      expect((await gen({ fn: 'strategy', prompt: PROMPT })).status).toBe(200);
    } finally {
      app.server.close();
    }
  });

  it('counts a stopped research request at its estimate (its searches may be billed), and never one refused before it started', async () => {
    const auth = createAuth({ supabaseUrl: supa.url, publishableKey: supa.PUBLISHABLE, adminEmails: 'owner@example.com', signInRequired: false });
    const limits = createLimits();
    const app = await startApp({ env: { ANTHROPIC_API_KEY: ENV.ANTHROPIC_API_KEY }, auth, limits });
    const today = async () => (await limits.usageByUser({ days: 1 })).find((r) => r.userId.startsWith('anon:')) ?? { requests: 0, usd: 0 };
    const counted = async (n) => {
      for (let i = 0; i < 100 && (await today()).requests < n; i++) await new Promise((r) => setTimeout(r, 20));
      return today();
    };
    const gen = (body, signal) => fetch(`${app.base}/api/ai/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    try {
      // a dollar limit only: a stopped request that cost nothing on the day would make it no limit at all
      app.ai.store.setLimits({ requestsPerDay: 0, usdPerDay: 1 });
      const stop = new AbortController();
      const r = gen({ fn: 'strategy', prompt: `${PROMPT} qa-research-slow`, research: { web: true, maxSearches: 8 } }, stop.signal).catch((e) => e);
      // Stop, once the provider has the request
      for (let i = 0; i < 200 && !callsTo('anthropic', '/v1/messages').length; i++) await new Promise((res) => setTimeout(res, 10));
      stop.abort();
      expect(await r).toMatchObject({ name: 'AbortError' });
      // what was reserved for it: a research-sized request with all 8 searches (Opus 5.5: $0.28 + 8 × $0.01)
      expect(await counted(1)).toMatchObject({ requests: 1, usd: 0.36 });
      expect(app.ai.usage.recent(1)[0]).toMatchObject({ ok: false, provider: 'anthropic', code: 'ABORTED', research: true, cost: { usd: 0.36, source: 'estimate' } });
      // refused before it did anything (429): it reached the provider, so one request, but no dollars
      mock.behavior.anthropic = 'rate';
      const refused = await gen({ fn: 'strategy', prompt: PROMPT, research: { web: true, maxSearches: 8 } });
      expect((await refused.json()).code).toBe('RATE_LIMIT');
      expect(await counted(2)).toMatchObject({ requests: 2, usd: 0.36 });
    } finally {
      app.server.close();
    }
  });
});

describe('keys saved before Strategy existed', () => {
  it('power Strategy until it’s unticked; Deep research (Manus) is never switched on by itself', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify({ providers: { anthropic: { functions: ['research'] }, manus: { functions: ['facebook'] } }, order: [...PROVIDER_IDS] }));
    const store = new AIStore(path.join(dir, 'ai.json'), { env: { ANTHROPIC_API_KEY: 'a', MANUS_API_KEY: 'm' } });
    expect(store.route('strategy')).toEqual(['anthropic']);
    expect(store.route('marketResearch')).toEqual([]);
    store.update('anthropic', { functions: ['research'] });
    expect(store.route('strategy')).toEqual([]);
    expect(new AIStore(store.file, { env: { ANTHROPIC_API_KEY: 'a' } }).route('strategy')).toEqual([]);
    // a key that was never saved powers everything it can do
    const fresh = new AIStore(path.join(tmpDir(), 'ai.json'), { env: { MANUS_API_KEY: 'm', GEMINI_API_KEY: 'g' } });
    expect(fresh.route('marketResearch')).toEqual(['manus']);
    expect(fresh.route('strategy')).toEqual(['google']);
  });
});

describe('secrets', () => {
  it('stay out of errors and research meta', async () => {
    const key = 'sk-proj-abcdef1234567890';
    const leaky = (message) => async (url, init) => {
      if (String(url).endsWith('/responses') && JSON.parse(init.body).tools) return new Response(JSON.stringify({ error: { message } }), { status: 400, headers: { 'content-type': 'application/json' } });
      return fetch(url, init);
    };
    // a 400 that isn't about the tool: the error, scrubbed
    let { router } = setup(['openai'], { fetch: leaky(`Invalid max_tool_calls for key ${key}`) });
    const err = await router.text('strategy', { prompt: PROMPT, research: RESEARCH }).catch((e) => e);
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toContain('[key]');
    expect(err.message).not.toContain(key);
    // a 400 about the tool that echoes the key: sent again without it, and the key appears nowhere
    ({ router } = setup(['openai'], { fetch: leaky(`web search is not enabled for key ${key}`) }));
    const out = await router.text('strategy', { prompt: PROMPT, research: RESEARCH });
    expect(out.meta.research.reason).toBe('provider_refused');
    expect(JSON.stringify(out)).not.toContain(key);
    // a normal research answer never carries any key
    const all = setup(PROVIDER_IDS);
    for (const id of ['anthropic', 'openai', 'xai', 'meta', 'openrouter']) {
      all.store.setOrder([id]);
      const got = await all.router.text('strategy', { prompt: PROMPT, research: RESEARCH });
      expect(got.meta.provider).toBe(id);
      for (const k of Object.values(ENV)) expect(JSON.stringify(got.meta.research), id).not.toContain(k);
    }
  });
});
