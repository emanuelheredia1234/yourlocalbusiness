// Meta's Model API: Muse Spark chat (effort in top-level `reasoning_effort`) and Muse Image
// (effort in `reasoning_strength`). Web research (Strategy) runs on Meta's Responses API: search
// grounding isn't available through Chat Completions.

import { errorFromResponse, num, requestJson } from '../http.mjs';
import { chatText, listModelIds } from './chat.mjs';
import { exactSize, imagesGenerations } from './images.mjs';
import { noTextError, responsesOutput, responsesUsage } from './responses.mjs';
import { RESEARCH_TIMEOUT_MS, TOOL_REFUSED, userLocation } from '../research.mjs';

const auth = (key) => ({ authorization: `Bearer ${key}` });

async function chat(ctx, { model, effort, system, prompt, images, signal, timeoutMs }) {
  const out = await chatText(ctx, { url: `${ctx.base}/chat/completions`, headers: auth(ctx.key), model, system, prompt, images, effortBody: effort ? { reasoning_effort: effort } : {}, signal, timeoutMs });
  // Meta reports the dollar amount charged as `usage.credits`
  return { ...out, cost: out.cost ?? out.credits, credits: null };
}

/** A research request on /responses with the web_search tool. Meta reports no cost there: the router estimates it. */
async function researchText(ctx, { model, effort, system, prompt, images, signal, timeoutMs, research }) {
  const body = {
    model,
    instructions: system,
    input: [{ role: 'user', content: [...(images ?? []).map((url) => ({ type: 'input_image', image_url: url })), { type: 'input_text', text: prompt }] }],
    tools: [{ type: 'web_search', search_context_size: 'medium', ...(research.location ? { user_location: userLocation(research.location) } : {}) }],
    // every source the model considered (titles and URLs; the snippets are never passed on)
    include: ['web_search_call.results'],
    max_tool_calls: research.maxSearches,
    store: false,
  };
  if (effort) body.reasoning = { effort };
  const t = timeoutMs ?? RESEARCH_TIMEOUT_MS;
  const r = await requestJson(ctx.fetch, `${ctx.base}/responses`, { method: 'POST', headers: auth(ctx.key), body, timeoutMs: t, signal, label: ctx.label });
  if (!r.ok) {
    const err = errorFromResponse(r.status, r.payload, ctx.label);
    // the search tool itself was refused (a 400 isn't billed): answer through chat, without searching
    if (r.status === 400 && err.code === 'BAD_REQUEST' && TOOL_REFUSED.test(err.message)) {
      return { ...(await chat(ctx, { model, effort, system, prompt, images, signal, timeoutMs: t })), research: { searches: 0, sources: [], queries: [], errors: [], refused: true } };
    }
    throw err;
  }
  const p = r.payload && typeof r.payload === 'object' ? r.payload : {};
  const o = responsesOutput(p);
  const text = o.text || o.allText;
  if (!text) throw noTextError(p, o.refusal, ctx.label);
  return {
    text,
    model: typeof p.model === 'string' && p.model ? p.model : model,
    usage: responsesUsage(p.usage),
    cost: null,
    research: { searches: o.searchCalls, sources: o.sources, queries: o.queries, errors: o.errors },
  };
}

export default {
  base: 'https://api.meta.ai/v1',

  async text(ctx, opts) {
    if (opts.research) return researchText(ctx, opts);
    return chat(ctx, opts);
  },

  async image(ctx, { model, effort, prompt, aspect, signal }) {
    const size = exactSize(aspect);
    const body = { model, prompt, n: 1, size, response_format: 'b64_json', output_format: 'png' };
    if (effort) body.reasoning_strength = effort;
    const out = await imagesGenerations(ctx, { url: `${ctx.base}/images/generations`, headers: auth(ctx.key), body, optional: ['response_format', 'output_format', 'size'], signal });
    // `usage.credits` is the dollar amount Meta charged
    return { ...out, model, usage: null, cost: num(out.usage?.credits), params: { size, reasoning_strength: effort } };
  },

  async listModels(ctx, kind, { signal } = {}) {
    const ids = (await listModelIds(ctx, `${ctx.base}/models`, auth(ctx.key), { signal })).map((x) => x.id);
    if (kind === 'image') return ids.filter((id) => /image/.test(id));
    return ids.filter((id) => !/image|embed|video|audio|tts/.test(id));
  },
};
