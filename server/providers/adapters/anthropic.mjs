// Anthropic: Claude through the Messages API, effort in `output_config.effort`. Models that support
// it get server-side fallbacks (a declined request is re-run on Anthropic's recommended model).

import Anthropic from '@anthropic-ai/sdk';
import { ProviderError, errorFromResponse, num, parseDataUrl } from '../http.mjs';
import { listModelIds } from './chat.mjs';
import { modelDef } from '../registry.mjs';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const clients = new Map();

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

export default {
  base: 'https://api.anthropic.com',

  async text(ctx, { model, effort, system, prompt, images = [], tier, signal }) {
    const params = {
      model,
      max_tokens: tier === 'quick' ? 16_000 : 64_000,
      system,
      messages: [{ role: 'user', content: [...images.map(imageBlock).filter(Boolean), { type: 'text', text: prompt }] }],
    };
    if (effort) params.output_config = { effort };
    if (modelDef('anthropic', 'text', model)?.fallbacks) Object.assign(params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
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
