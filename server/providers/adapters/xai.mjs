// xAI: Grok chat (effort in top-level `reasoning_effort`), Grok Imagine photos (`quality`) and
// Grok Imagine video (`resolution`; asynchronous: start, then poll /videos/{request_id}).
// Web research (Strategy) runs on xAI's Responses API, the only one with its web_search tool.

import { ProviderError, downloadBytes, errorFromResponse, num, requestJson, sniffVideo } from '../http.mjs';
import { chatText, listModelIds } from './chat.mjs';
import { imagesGenerations, nearestRatio } from './images.mjs';
import { noTextError, responsesOutput, responsesUsage } from './responses.mjs';
import { RESEARCH_TIMEOUT_MS, TOOL_REFUSED } from '../research.mjs';

const auth = (key) => ({ authorization: `Bearer ${key}` });
const IMAGE_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '20:9', '9:20', '21:9', '5:2'];

const chat = (ctx, { model, effort, system, prompt, images, signal, timeoutMs }) =>
  chatText(ctx, { url: `${ctx.base}/chat/completions`, headers: auth(ctx.key), model, system, prompt, images, effortBody: effort ? { reasoning_effort: effort } : {}, signal, timeoutMs });

/** A research request on /responses: web_search only (X search is billed per post, so it's left out). */
async function researchText(ctx, { model, effort, system, prompt, images, signal, timeoutMs, research }) {
  const body = {
    model,
    instructions: system,
    input: [{ role: 'user', content: [...(images ?? []).map((url) => ({ type: 'input_image', image_url: url })), { type: 'input_text', text: prompt }] }],
    tools: [{ type: 'web_search' }],
    // keeps [[1]](url) links out of the answer (they would land outside the JSON)
    include: ['no_inline_citations'],
    max_turns: Math.min(4, research.maxSearches),
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
  const u = p.usage ?? {};
  // xAI reports the exact cost, searches included: 10,000,000,000 ticks per dollar
  const ticks = num(u.cost_in_usd_ticks);
  const nano = num(u.cost_in_nano_usd);
  return {
    text,
    model: typeof p.model === 'string' && p.model ? p.model : model,
    usage: responsesUsage(u),
    cost: ticks !== null ? ticks / 1e10 : nano !== null ? nano / 1e9 : null,
    research: {
      searches: num(u.server_side_tool_usage_details?.web_search_calls) ?? o.searchCalls,
      sources: [...o.sources, ...(Array.isArray(p.citations) ? p.citations.filter((url) => typeof url === 'string').map((url) => ({ url })) : [])],
      queries: o.queries,
      errors: o.errors,
    },
  };
}

export default {
  base: 'https://api.x.ai/v1',

  text(ctx, opts) {
    if (opts.research) return researchText(ctx, opts);
    return chat(ctx, opts);
  },

  async image(ctx, { model, effort, prompt, aspect, signal }) {
    const aspect_ratio = nearestRatio(aspect, IMAGE_RATIOS);
    const body = { model, prompt, n: 1, aspect_ratio, response_format: 'b64_json' };
    if (effort) body.quality = effort;
    const out = await imagesGenerations(ctx, { url: `${ctx.base}/images/generations`, headers: auth(ctx.key), body, optional: ['aspect_ratio'], signal });
    return { ...out, model, usage: null, params: { aspect_ratio, quality: effort } };
  },

  video: {
    async start(ctx, { model, effort, prompt, aspect, duration, firstFrame, signal }) {
      const body = { model, prompt, aspect_ratio: aspect, duration: Math.max(1, Math.min(15, Math.round(duration || 8))) };
      if (effort) body.resolution = effort;
      if (firstFrame) body.image = { url: firstFrame };
      let r = await requestJson(ctx.fetch, `${ctx.base}/videos/generations`, { method: 'POST', headers: auth(ctx.key), body, timeoutMs: 60_000, signal, label: ctx.label });
      let note = '';
      if (r.status === 400 && body.image && /image/i.test(JSON.stringify(r.payload ?? ''))) {
        // the starting photo was refused (nothing was made): go without it
        delete body.image;
        note = 'xAI didn’t accept the starting photo, so the video starts from the prompt alone.';
        r = await requestJson(ctx.fetch, `${ctx.base}/videos/generations`, { method: 'POST', headers: auth(ctx.key), body, timeoutMs: 60_000, signal, label: ctx.label });
      }
      if (!r.ok) throw errorFromResponse(r.status, r.payload, ctx.label);
      const id = String(r.payload?.request_id ?? r.payload?.id ?? '');
      if (!id) throw new ProviderError('UPSTREAM', 'xAI didn’t return a video job.', { provider: ctx.label });
      return { upstreamId: id, note, params: { resolution: effort, duration: body.duration, aspect_ratio: aspect } };
    },

    async status(ctx, job, { signal } = {}) {
      const r = await requestJson(ctx.fetch, `${ctx.base}/videos/${encodeURIComponent(job.upstreamId)}`, { headers: auth(ctx.key), timeoutMs: 30_000, signal, label: ctx.label });
      if (r.status === 202) return { state: 'running' };
      if (!r.ok) throw errorFromResponse(r.status, r.payload, ctx.label);
      const p = r.payload ?? {};
      const status = String(p.status ?? '').toLowerCase();
      if (status === 'done' || p.video?.url) return { state: 'done', url: p.video?.url, seconds: num(p.video?.duration) };
      if (status === 'failed' || status === 'expired') return { state: 'failed', error: p.error?.message || (status === 'expired' ? 'The video expired before it was collected.' : 'xAI couldn’t make this video.') };
      return { state: 'running' };
    },

    async content(ctx, job, { signal } = {}) {
      if (!job.url) throw new ProviderError('NO_OUTPUT', 'The video isn’t ready.', { provider: ctx.label });
      const { bytes, contentType } = await downloadBytes(ctx.fetch, job.url, { maxBytes: 200_000_000, signal, label: ctx.label });
      return { bytes, contentType: sniffVideo(bytes) || contentType || 'video/mp4' };
    },
  },

  async listModels(ctx, kind, { signal } = {}) {
    const ids = (await listModelIds(ctx, `${ctx.base}/models`, auth(ctx.key), { signal })).map((x) => x.id);
    if (kind === 'image') return ids.filter((id) => /imagine-image|image/.test(id) && !/video/.test(id));
    if (kind === 'video') return ids.filter((id) => /video/.test(id));
    return ids.filter((id) => /^grok/.test(id) && !/imagine|image|video/.test(id));
  },
};
