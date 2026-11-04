// OpenRouter: chat for any model (effort in `reasoning.effort`; OpenRouter reports the real cost),
// image models (/images, or chat for chat-based image models) and video models (/videos, polled).
// Web research (Strategy): OpenRouter's openrouter:web_search server tool (in beta at OpenRouter).

import { ProviderError, downloadBytes, errorFromResponse, imageFromValue, num, requestJson, sniffImage, sniffVideo } from '../http.mjs';
import { chatText, listModelIds } from './chat.mjs';
import { RESEARCH_TIMEOUT_MS, TOOL_REFUSED, userLocation } from '../research.mjs';

const headers = (key) => ({ authorization: `Bearer ${key}`, 'x-title': 'Yourlocalbusiness', 'http-referer': 'https://yourlocalbusiness.app' });

/** OpenRouter takes the common ratios; the wide banner shapes are cropped from 16:9. */
const ASPECT = { '1:1': '1:1', '4:5': '4:5', '9:16': '9:16', '1.91:1': '16:9', '3:2': '3:2', '21:8': '16:9' };

/** The image in any of the shapes OpenRouter's image routes answer with. */
function imageValue(p) {
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  const pick = (o) => (typeof o === 'string' ? o : o && typeof o === 'object' ? o.b64_json || o.url || (typeof o.image_url === 'string' ? o.image_url : o.image_url?.url) || '' : '');
  return pick(first(p?.data)) || pick(first(p?.images)) || pick(first(p?.output)) || pick(p?.image) || pick(first(p?.choices)?.message?.images?.[0]) || '';
}

const VIDEO_URL_KEYS = (p) => [p?.unsigned_urls?.[0], p?.urls?.[0], p?.video?.url, p?.video_url, p?.output?.url, p?.output?.[0]?.url, p?.data?.[0]?.url, p?.result?.url, p?.url].find((u) => typeof u === 'string' && /^https?:\/\//i.test(u));

export default {
  base: 'https://openrouter.ai/api/v1',

  async text(ctx, { model, effort, system, prompt, images, tier, signal, timeoutMs, research = null }) {
    const send = (search) =>
      chatText(ctx, {
        url: `${ctx.base}/chat/completions`,
        headers: headers(ctx.key),
        model,
        system,
        prompt,
        images,
        // OpenRouter turns effort into a share of max_tokens for budget-based models
        extraBody: { max_tokens: tier === 'quick' ? 16_000 : 32_000, usage: { include: true }, ...search },
        effortBody: effort ? { reasoning: { effort } } : {},
        signal,
        timeoutMs: research ? (timeoutMs ?? RESEARCH_TIMEOUT_MS) : timeoutMs,
      });
    if (!research) {
      const { annotations, serverToolUse, ...out } = await send({});
      return out;
    }
    // `auto` would use Google's own grounding for google/* models, whose terms don't fit Strategy: Exa instead
    const engine = /^google\//.test(model) ? 'exa' : 'auto';
    const parameters = { engine, max_uses: research.maxSearches, max_total_results: research.maxSearches * 5, ...(engine === 'auto' && research.location ? { user_location: userLocation(research.location) } : {}) };
    let refused = false;
    let got;
    try {
      got = await send({ tools: [{ type: 'openrouter:web_search', parameters }], max_tool_calls: research.maxSearches });
    } catch (e) {
      // the search tool itself was refused (a 400 or 404 isn't billed): answer without searching
      if (!['BAD_REQUEST', 'NOT_FOUND'].includes(e?.code) || !TOOL_REFUSED.test(e.message)) throw e;
      refused = true;
      got = await send({});
    }
    const { annotations, serverToolUse, ...out } = got;
    // the URL and title of each cited page; never url_citation.content (page excerpts)
    const sources = annotations.filter((a) => a?.type === 'url_citation' && typeof a.url_citation?.url === 'string').map((a) => ({ url: a.url_citation.url, title: a.url_citation.title, cited: true }));
    // OpenRouter counts the searches; citations without a count mean it searched at least once
    const searches = num(serverToolUse?.web_search_requests) ?? (sources.length ? 1 : 0);
    return { ...out, research: { searches, sources, queries: [], errors: [], refused } };
  },

  async image(ctx, { model, prompt, aspect, signal }) {
    const aspect_ratio = ASPECT[aspect] ?? '1:1';
    let r = await requestJson(ctx.fetch, `${ctx.base}/images`, { method: 'POST', headers: headers(ctx.key), body: { model, prompt, n: 1, aspect_ratio }, timeoutMs: 180_000, signal, label: ctx.label });
    let route = 'images';
    if (!r.ok && (r.status === 404 || r.status === 405 || /chat\/completions|modalities/i.test(JSON.stringify(r.payload ?? '')))) {
      // chat-based image models (e.g. Gemini image) answer through chat completions
      route = 'chat';
      r = await requestJson(ctx.fetch, `${ctx.base}/chat/completions`, {
        method: 'POST',
        headers: headers(ctx.key),
        body: { model, messages: [{ role: 'user', content: prompt }], modalities: ['image', 'text'], image_config: { aspect_ratio }, usage: { include: true } },
        timeoutMs: 180_000,
        signal,
        label: ctx.label,
      });
    }
    if (!r.ok) throw errorFromResponse(r.status, r.payload, ctx.label);
    const bytes = await imageFromValue(ctx.fetch, imageValue(r.payload), { label: ctx.label, signal });
    if (!bytes?.length) throw new ProviderError('NO_OUTPUT', 'OpenRouter didn’t return an image.', { provider: ctx.label });
    const contentType = sniffImage(bytes);
    if (!contentType) throw new ProviderError('UPSTREAM', 'OpenRouter returned a file that isn’t an image.', { provider: ctx.label });
    const u = r.payload?.usage ?? {};
    return { bytes, contentType, model, revisedPrompt: '', cost: num(u.cost), usage: num(u.prompt_tokens) !== null ? { input: num(u.prompt_tokens) ?? 0, output: num(u.completion_tokens) ?? 0, reasoning: null } : null, params: { aspect_ratio, route } };
  },

  video: {
    async start(ctx, { model, effort, prompt, aspect, duration, firstFrame, signal }) {
      const body = { model, prompt, duration: Math.round(duration || 8), aspect_ratio: aspect };
      if (effort) body.resolution = effort;
      if (firstFrame) body.frame_images = [{ type: 'first_frame', image_url: firstFrame }];
      const r = await requestJson(ctx.fetch, `${ctx.base}/videos`, { method: 'POST', headers: headers(ctx.key), body, timeoutMs: 60_000, signal, label: ctx.label });
      if (!r.ok) throw errorFromResponse(r.status, r.payload, ctx.label);
      const p = r.payload ?? {};
      const id = String(p.id ?? p.job_id ?? p.generation_id ?? p.data?.id ?? '');
      if (!id) throw new ProviderError('UPSTREAM', 'OpenRouter didn’t return a video job.', { provider: ctx.label });
      const pollingUrl = typeof p.polling_url === 'string' && /^https:\/\/openrouter\.ai\//.test(p.polling_url) ? p.polling_url : '';
      return { upstreamId: id, pollingUrl, params: { resolution: effort, duration: body.duration, aspect_ratio: aspect } };
    },

    async status(ctx, job, { signal } = {}) {
      const url = job.pollingUrl || `${ctx.base}/videos/${encodeURIComponent(job.upstreamId)}`;
      const r = await requestJson(ctx.fetch, url, { headers: headers(ctx.key), timeoutMs: 30_000, signal, label: ctx.label });
      if (!r.ok) throw errorFromResponse(r.status, r.payload, ctx.label);
      const p = r.payload ?? {};
      const status = String(p.status ?? '').toLowerCase();
      const cost = num(p.usage?.cost ?? p.cost);
      if (['completed', 'succeeded', 'success', 'done', 'complete'].includes(status)) return { state: 'done', url: VIDEO_URL_KEYS(p), cost };
      if (['failed', 'error', 'cancelled', 'canceled', 'expired'].includes(status)) return { state: 'failed', error: (typeof p.error === 'string' ? p.error : p.error?.message) || 'OpenRouter couldn’t make this video.', cost };
      return { state: 'running', progress: num(p.progress) };
    },

    async content(ctx, job, { signal } = {}) {
      if (!job.url) throw new ProviderError('NO_OUTPUT', 'OpenRouter didn’t say where the video is.', { provider: ctx.label });
      const own = /^https:\/\/([a-z0-9-]+\.)*openrouter\.ai\//i.test(job.url);
      const { bytes, contentType } = await downloadBytes(ctx.fetch, job.url, { headers: own ? headers(ctx.key) : {}, maxBytes: 200_000_000, signal, label: ctx.label });
      return { bytes, contentType: sniffVideo(bytes) || contentType || 'video/mp4' };
    },
  },

  /**
   * A free check that the key works. OpenRouter's model list is public (it answers without a key),
   * so it can't tell a good key from a typo: GET /key needs a valid one (401 otherwise).
   */
  async checkAuth(ctx, { signal } = {}) {
    const r = await requestJson(ctx.fetch, `${ctx.base}/key`, { headers: headers(ctx.key), timeoutMs: 20_000, signal, label: ctx.label });
    if (!r.ok) throw errorFromResponse(r.status, r.payload, ctx.label);
  },

  async listModels(ctx, kind, { signal } = {}) {
    if (kind === 'video') {
      const r = await requestJson(ctx.fetch, `${ctx.base}/videos/models`, { headers: headers(ctx.key), timeoutMs: 20_000, signal, label: ctx.label });
      if (!r.ok) throw errorFromResponse(r.status, r.payload, ctx.label);
      return (Array.isArray(r.payload?.data) ? r.payload.data : []).map((x) => String(x?.id ?? '')).filter(Boolean);
    }
    const url = kind === 'image' ? `${ctx.base}/models?output_modalities=image` : `${ctx.base}/models`;
    const models = await listModelIds(ctx, url, headers(ctx.key), { signal });
    return models.filter((x) => kind === 'image' || (x.raw?.architecture?.output_modalities ?? ['text']).includes('text')).map((x) => x.id);
  },
};
