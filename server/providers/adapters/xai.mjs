// xAI: Grok chat (effort in top-level `reasoning_effort`), Grok Imagine photos (`quality`) and
// Grok Imagine video (`resolution`; asynchronous: start, then poll /videos/{request_id}).

import { ProviderError, downloadBytes, errorFromResponse, num, requestJson, sniffVideo } from '../http.mjs';
import { chatText, listModelIds } from './chat.mjs';
import { imagesGenerations, nearestRatio } from './images.mjs';

const auth = (key) => ({ authorization: `Bearer ${key}` });
const IMAGE_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '20:9', '9:20', '21:9', '5:2'];

export default {
  base: 'https://api.x.ai/v1',

  text(ctx, { model, effort, system, prompt, images, signal, timeoutMs }) {
    return chatText(ctx, { url: `${ctx.base}/chat/completions`, headers: auth(ctx.key), model, system, prompt, images, effortBody: effort ? { reasoning_effort: effort } : {}, signal, timeoutMs });
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
