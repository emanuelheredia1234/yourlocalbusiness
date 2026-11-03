// Anthropic: Claude through the Messages API, effort in `output_config.effort`. Models that support
// it get server-side fallbacks (a declined request is re-run on Anthropic's recommended model).
// Web research (Strategy): Anthropic's server-side web_search tool (see ../research.mjs).

import Anthropic from '@anthropic-ai/sdk';
import { ProviderError, errorFromResponse, num, parseDataUrl } from '../http.mjs';
import { listModelIds } from './chat.mjs';
import { modelDef } from '../registry.mjs';
import { RESEARCH_TIMEOUT_MS, TOOL_REFUSED, TOOL_VERSION, userLocation } from '../research.mjs';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const clients = new Map();

/** The web search tool's versions are dated: check them against Anthropic's docs before a release. */
export const WEB_SEARCH_TOOL = 'web_search_20260209';
/** The basic version, for models the newer one isn't available on. */
const WEB_SEARCH_BASIC = 'web_search_20250305';
/** pause_turn: the search loop paused; the same turn is continued at most this many times (not retries). */
const MAX_CONTINUATIONS = 3;
/** Blocks that aren't tool calls or results (the final answer is the text after the last tool block). */
const NOT_TOOL = new Set(['text', 'thinking', 'redacted_thinking']);

function client(ctx) {
  const id = `${ctx.base}|${ctx.key}`;
  let c = clients.get(id);
  if (!c) {
    c = new Anthropic({ apiKey: ctx.key, authToken: null, baseURL: ctx.base, fetch: ctx.fetch, maxRetries: 1, timeout: 15 * 60_000 });
    clients.set(id, c);
    if (clients.size > 8) clients.delete(clients.keys().next().value);
  }
  return c;
}

function imageBlock(dataUrl) {
  const d = parseDataUrl(dataUrl);
  if (!d || !IMAGE_TYPES.has(d.mime)) return null;
  return { type: 'image', source: { type: 'base64', media_type: d.mime, data: d.base64 } };
}

function toProviderError(e, signal, label) {
  if (signal?.aborted || e instanceof Anthropic.APIUserAbortError) return new ProviderError('ABORTED', 'Stopped.', { status: 499, provider: label });
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('TIMEOUT', `${label} took too long to answer.`, { status: 504, provider: label });
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError('NETWORK', `Couldn’t reach ${label}.`, { provider: label });
  if (e instanceof Anthropic.APIError && e.status) return errorFromResponse(e.status, e.error ?? e.message, label);
  return new ProviderError('UPSTREAM', `${label} had an error: ${e?.message || 'unknown'}`, { provider: label });
}

function webSearchTool(research) {
  return { type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: research.maxSearches, ...(research.location ? { user_location: userLocation(research.location) } : {}) };
}

const isText = (b) => b?.type === 'text' && typeof b.text === 'string';
const textOf = (blocks) =>
  blocks
    .filter(isText)
    .map((b) => b.text)
    .join('');

/**
 * A research request: the web_search tool, never retried by the SDK (the searches may be billed).
 * Only free 400s are sent again (at most twice): with allowed_callers ['direct'], with the basic tool
 * version, or without the tool (`refused`). pause_turn continues the same turn, at most 3 times.
 */
async function researchText(ctx, params, research, { model, signal, timeoutMs }) {
  const opts = { signal, maxRetries: 0, timeout: timeoutMs };
  const call = async (p) => {
    try {
      return await client(ctx).beta.messages.stream(p, opts).finalMessage();
    } catch (e) {
      throw toProviderError(e, signal, ctx.label);
    }
  };
  let tool = webSearchTool(research);
  params.tools = [tool];
  let refused = false;
  let message;
  for (let resent = 0; ; resent += 1) {
    try {
      message = await call(params);
      break;
    } catch (err) {
      if (resent >= 2 || err.code !== 'BAD_REQUEST' || !params.tools) throw err;
      if (/allowed_callers/i.test(err.message) && !tool.allowed_callers) tool = { ...tool, allowed_callers: ['direct'] };
      else if (TOOL_VERSION.test(err.message) && tool.type !== WEB_SEARCH_BASIC) tool = { ...tool, type: WEB_SEARCH_BASIC };
      else if (TOOL_REFUSED.test(err.message)) tool = null;
      else throw err;
      if (tool) params.tools = [tool];
      else {
        // e.g. "web search is not enabled for this organization": answer without searching
        delete params.tools;
        refused = true;
      }
    }
  }
  const content = [...(message.content ?? [])];
  const usages = [message.usage];
  for (let i = 0; message.stop_reason === 'pause_turn' && i < MAX_CONTINUATIONS; i += 1) {
    // the same turn goes on: everything so far goes back unchanged, with the same system prompt and tools
    message = await call({ ...params, messages: [params.messages[0], { role: 'assistant', content: [...content] }] });
    content.push(...(message.content ?? []));
    usages.push(message.usage);
  }
  if (message.stop_reason === 'refusal') throw new ProviderError('REFUSAL', 'Claude declined this request.', { status: 422, provider: ctx.label });
  // the answer is the text after the last search ("Let me look that up." before it is narration)
  const lastTool = content.findLastIndex((b) => !NOT_TOOL.has(b?.type));
  const final = textOf(content.slice(lastTool + 1));
  const paused = message.stop_reason === 'pause_turn';
  const text = final.trim() ? final : paused ? '' : textOf(content);
  if (!text.trim()) {
    if (paused || message.stop_reason === 'max_tokens') throw new ProviderError('CUT_OFF', 'Claude ran out of room before answering. Try fewer searches or a lower effort.', { provider: ctx.label });
    throw new ProviderError('NO_OUTPUT', 'Claude returned an empty answer.', { provider: ctx.label });
  }
  let input = 0;
  let output = 0;
  let reported = null;
  for (const u of usages) {
    input += (num(u?.input_tokens) ?? 0) + (num(u?.cache_creation_input_tokens) ?? 0) + (num(u?.cache_read_input_tokens) ?? 0);
    output += num(u?.output_tokens) ?? 0;
    const n = num(u?.server_tool_use?.web_search_requests);
    if (n !== null) reported = (reported ?? 0) + n;
  }
  // what the searches found: URLs, titles, page ages and Claude's cited text (never encrypted_content or encrypted_index)
  const sources = [];
  const queries = [];
  const errors = [];
  let ran = 0;
  for (const b of content) {
    if (b?.type === 'server_tool_use' && b.name === 'web_search' && typeof b.input?.query === 'string') queries.push(b.input.query);
    if (b?.type === 'web_search_tool_result') {
      if (Array.isArray(b.content)) {
        ran += 1;
        for (const x of b.content) if (x?.type === 'web_search_result' && typeof x.url === 'string') sources.push({ url: x.url, title: x.title, pageAge: x.page_age });
      } else if (b.content?.type === 'web_search_tool_result_error') errors.push(String(b.content.error_code || 'error'));
    }
    if (isText(b)) {
      for (const c of Array.isArray(b.citations) ? b.citations : []) {
        if (c?.type === 'web_search_result_location' && typeof c.url === 'string') sources.push({ url: c.url, title: c.title, cited: true, quote: c.cited_text });
      }
    }
  }
  return { text, model: message.model || model, usage: { input, output, reasoning: null }, research: { searches: reported ?? ran, sources, queries, errors, refused } };
}

export default {
  base: 'https://api.anthropic.com',

  async text(ctx, { model, effort, system, prompt, images = [], tier, signal, research = null, timeoutMs }) {
    const params = {
      model,
      max_tokens: tier === 'quick' ? 16_000 : 64_000,
      system,
      messages: [{ role: 'user', content: [...images.map(imageBlock).filter(Boolean), { type: 'text', text: prompt }] }],
    };
    if (effort) params.output_config = { effort };
    // (with web research too: how server-side fallbacks and the search tool work together is unverified)
    if (modelDef('anthropic', 'text', model)?.fallbacks) Object.assign(params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    if (research) return researchText(ctx, params, research, { model, signal, timeoutMs: timeoutMs ?? RESEARCH_TIMEOUT_MS });
    let message;
    try {
      message = await client(ctx).beta.messages.stream(params, { signal }).finalMessage();
    } catch (e) {
      throw toProviderError(e, signal, ctx.label);
    }
    if (message.stop_reason === 'refusal') throw new ProviderError('REFUSAL', 'Claude declined this request.', { status: 422, provider: ctx.label });
    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (!text) {
      if (message.stop_reason === 'max_tokens') throw new ProviderError('CUT_OFF', 'Claude ran out of room before answering. Try a lower effort.', { provider: ctx.label });
      throw new ProviderError('NO_OUTPUT', 'Claude returned an empty answer.', { provider: ctx.label });
    }
    const u = message.usage ?? {};
    const input = (num(u.input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0);
    // thinking isn't counted separately: it's inside output_tokens and billed as output
    return { text, model: message.model || model, usage: { input, output: num(u.output_tokens) ?? 0, reasoning: null } };
  },

  async listModels(ctx, kind, { signal } = {}) {
    if (kind !== 'text') return [];
    const models = await listModelIds(ctx, `${ctx.base}/v1/models?limit=100`, { 'x-api-key': ctx.key, 'anthropic-version': '2023-06-01' }, { signal });
    return models.map((x) => x.id);
  },
};
