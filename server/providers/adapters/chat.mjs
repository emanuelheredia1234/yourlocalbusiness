// OpenAI-style Chat Completions, shared by xAI, Meta and OpenRouter (each adds its own effort field).

import { ProviderError, errorFromResponse, num, requestJson } from '../http.mjs';

function userContent(prompt, images) {
  if (!images?.length) return prompt;
  return [...images.map((url) => ({ type: 'image_url', image_url: { url } })), { type: 'text', text: prompt }];
}

function messageText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}

/**
 * One chat completion. `effortBody` is merged into the request (e.g. { reasoning_effort: 'high' }).
 * Resolves { text, model, usage: { input, output, reasoning }, cost?, credits?, finishReason }.
 */
export async function chatText(ctx, { url, headers, model, system, prompt, images, effortBody = {}, extraBody = {}, signal, timeoutMs = 300_000 }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent(prompt, images) },
    ],
    ...extraBody,
    ...effortBody,
  };
  const r = await requestJson(ctx.fetch, url, { method: 'POST', headers, body, timeoutMs, signal, label: ctx.label });
  if (!r.ok) throw errorFromResponse(r.status, r.payload, ctx.label);
  const p = r.payload && typeof r.payload === 'object' ? r.payload : {};
  if (p.error) throw errorFromResponse(Number(p.error.code) || 502, p, ctx.label);
  const choice = Array.isArray(p.choices) ? p.choices[0] : null;
  const text = messageText(choice?.message);
  const finishReason = String(choice?.finish_reason ?? '');
  if (!text) {
    if (choice?.message?.refusal) throw new ProviderError('REFUSAL', `${ctx.label} declined this request.`, { status: 422, provider: ctx.label });
    if (finishReason === 'content_filter') throw new ProviderError('CONTENT_POLICY', `${ctx.label} blocked this request under its content policy.`, { status: 422, provider: ctx.label });
    if (finishReason === 'length') throw new ProviderError('CUT_OFF', `${ctx.label} ran out of room before answering. Try a lower effort.`, { provider: ctx.label });
    throw new ProviderError('NO_OUTPUT', `${ctx.label} returned an empty answer.`, { provider: ctx.label });
  }
  return {
    text,
    model: typeof p.model === 'string' && p.model ? p.model : model,
    finishReason,
    usage: chatUsage(p.usage),
    cost: num(p.usage?.cost),
    credits: num(p.usage?.credits),
  };
}

/**
 * Tokens from a Chat Completions `usage`. `output` is everything billed as output: some hosts count
 * reasoning inside completion_tokens, others (like xAI) beside it, which total_tokens reveals.
 */
export function chatUsage(u) {
  if (!u || typeof u !== 'object') return { input: 0, output: 0, reasoning: null };
  const input = num(u.prompt_tokens) ?? 0;
  const completion = num(u.completion_tokens) ?? 0;
  const reasoning = num(u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens);
  const total = num(u.total_tokens);
  const separate = reasoning > 0 && total !== null && Math.abs(total - (input + completion + reasoning)) < Math.abs(total - (input + completion));
  return { input, output: separate ? completion + reasoning : completion, reasoning };
}

/** Model ids from an OpenAI-style GET /models. */
export async function listModelIds(ctx, url, headers, { signal } = {}) {
  const r = await requestJson(ctx.fetch, url, { headers, timeoutMs: 20_000, signal, label: ctx.label });
  if (!r.ok) throw errorFromResponse(r.status, r.payload, ctx.label);
  const data = Array.isArray(r.payload?.data) ? r.payload.data : Array.isArray(r.payload?.models) ? r.payload.models : [];
  return data.map((x) => ({ id: String(x?.id ?? ''), name: typeof x?.name === 'string' ? x.name : '', raw: x })).filter((x) => x.id);
}
