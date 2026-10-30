// OpenAI: GPT through the Responses API (effort in `reasoning.effort`) and GPT Image (effort in `quality`).

import { ProviderError, errorFromResponse, num, requestJson } from '../http.mjs';
import { listModelIds } from './chat.mjs';
import { exactSize, imagesGenerations, nearestRatio } from './images.mjs';
import { modelDef } from '../registry.mjs';

const auth = (key) => ({ authorization: `Bearer ${key}` });

export default {
  base: 'https://api.openai.com/v1',

  async text(ctx, { model, effort, system, prompt, images = [], signal, timeoutMs = 300_000 }) {
    const body = {
      model,
      instructions: system,
      input: [{ role: 'user', content: [...images.map((url) => ({ type: 'input_image', image_url: url })), { type: 'input_text', text: prompt }] }],
      store: false,
    };
    if (effort) body.reasoning = { effort };
    const r = await requestJson(ctx.fetch, `${ctx.base}/responses`, { method: 'POST', headers: auth(ctx.key), body, timeoutMs, signal, label: ctx.label });
    if (!r.ok) throw errorFromResponse(r.status, r.payload, ctx.label);
    const p = r.payload && typeof r.payload === 'object' ? r.payload : {};
    let text = '';
    let refusal = '';
    for (const item of Array.isArray(p.output) ? p.output : []) {
      if (item?.type !== 'message') continue;
      for (const c of Array.isArray(item.content) ? item.content : []) {
        if (c?.type === 'output_text' && typeof c.text === 'string') text += c.text;
        if (c?.type === 'refusal') refusal += String(c.refusal ?? '');
      }
    }
    if (!text && typeof p.output_text === 'string') text = p.output_text;
    if (!text) {
      if (refusal) throw new ProviderError('REFUSAL', 'OpenAI declined this request.', { status: 422, provider: ctx.label });
      if (p.status === 'failed') throw new ProviderError('UPSTREAM', `OpenAI failed: ${p.error?.message || 'unknown error'}`, { provider: ctx.label });
      if (p.status === 'incomplete') {
        const why = p.incomplete_details?.reason;
        if (why === 'content_filter') throw new ProviderError('CONTENT_POLICY', 'OpenAI blocked this request under its content policy.', { status: 422, provider: ctx.label });
        throw new ProviderError('CUT_OFF', 'OpenAI ran out of room before answering. Try a lower effort.', { provider: ctx.label });
      }
      throw new ProviderError('NO_OUTPUT', 'OpenAI returned an empty answer.', { provider: ctx.label });
    }
    const u = p.usage ?? {};
    return {
      text,
      model: typeof p.model === 'string' && p.model ? p.model : model,
      usage: { input: num(u.input_tokens) ?? 0, output: num(u.output_tokens) ?? 0, reasoning: num(u.output_tokens_details?.reasoning_tokens) },
    };
  },

  async image(ctx, { model, effort, prompt, aspect, signal }) {
    // GPT Image 2.5 takes any size (multiples of 16); earlier models take three
    const size = modelDef('openai', 'image', model)?.customSizes ? exactSize(aspect, 1536, 16) : nearestRatio(aspect, ['1024x1024', '1536x1024', '1024x1536']);
    const body = { model, prompt, n: 1, size, output_format: 'png' };
    if (effort) body.quality = effort;
    const out = await imagesGenerations(ctx, { url: `${ctx.base}/images/generations`, headers: auth(ctx.key), body, optional: ['output_format'], signal });
    const u = out.usage ?? {};
    const details = u.input_tokens_details ?? {};
    const imageInput = num(details.image_tokens) ?? 0;
    const input = num(details.text_tokens) ?? Math.max(0, (num(u.input_tokens) ?? 0) - imageInput);
    return { ...out, model, usage: { input, imageInput, output: num(u.output_tokens) ?? 0, reasoning: null }, params: { size, quality: effort } };
  },

  async listModels(ctx, kind, { signal } = {}) {
    const ids = (await listModelIds(ctx, `${ctx.base}/models`, auth(ctx.key), { signal })).map((x) => x.id);
    if (kind === 'image') return ids.filter((id) => /^gpt-image/.test(id));
    return ids.filter((id) => /^(gpt-|o\d)/.test(id) && !/image|audio|realtime|tts|transcribe|embedding|search|moderation|sora|whisper|dall-e/i.test(id));
  },
};
