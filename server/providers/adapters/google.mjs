// Google Gemini through the Interactions API: text (effort in `generation_config.thinking_level`),
// Nano Banana photos (`response_format.image_size`) and Gemini Omni video (`response_format.resolution`).

import { ProviderError, downloadBytes, errorFromResponse, num, parseDataUrl, requestJson, sniffImage, sniffVideo } from '../http.mjs';
import { nearestRatio } from './images.mjs';

const headers = (key) => ({ 'x-goog-api-key': key });
const IMAGE_RATIOS = ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

function imagePart(dataUrl) {
  const d = parseDataUrl(dataUrl);
  return d ? { type: 'image', mime_type: d.mime, data: d.base64 } : null;
}

/** Every content item the model produced (newer `steps`, or the older flat `outputs`). */
export function outputItems(p) {
  const items = [];
  for (const step of Array.isArray(p?.steps) ? p.steps : []) {
    if (step?.type && step.type !== 'model_output') continue;
    for (const c of Array.isArray(step?.content) ? step.content : []) items.push(c);
  }
  for (const c of Array.isArray(p?.outputs) ? p.outputs : []) items.push(c);
  return items;
}

function failure(ctx, p) {
  const msg = p?.error?.message || p?.status_message || '';
  if (/safety|policy|blocked|prohibited/i.test(msg)) return new ProviderError('CONTENT_POLICY', 'Google blocked this request under its content policy.', { status: 422, provider: ctx.label });
  return new ProviderError('UPSTREAM', `Google couldn’t finish this${msg ? `: ${msg}` : '.'}`, { provider: ctx.label });
}

function usageOf(p) {
  const u = p?.usage ?? {};
  const output = num(u.total_output_tokens) ?? 0;
  const thought = num(u.total_thought_tokens);
  // thinking is billed as output
  return { input: num(u.total_input_tokens) ?? 0, output: output + (thought ?? 0), visibleOutput: output, reasoning: thought };
}

async function interact(ctx, body, { signal, timeoutMs }) {
  const r = await requestJson(ctx.fetch, `${ctx.base}/interactions`, { method: 'POST', headers: headers(ctx.key), body, timeoutMs, signal, label: ctx.label });
  if (!r.ok) throw errorFromResponse(r.status, r.payload, ctx.label);
  const p = r.payload && typeof r.payload === 'object' ? r.payload : {};
  if (p.status === 'failed') throw failure(ctx, p);
  return p;
}

/** Bytes of an image or video item: inline base64, or a Files API link fetched with the key. */
async function itemBytes(ctx, item, { signal, maxBytes }) {
  if (typeof item?.data === 'string' && item.data) return Buffer.from(item.data, 'base64');
  if (typeof item?.uri === 'string' && /^https:\/\//i.test(item.uri)) {
    const url = /generativelanguage\.googleapis\.com/.test(item.uri) && !/[?&]alt=media/.test(item.uri) ? `${item.uri}${item.uri.includes('?') ? '&' : '?'}alt=media` : item.uri;
    return (await downloadBytes(ctx.fetch, url, { headers: headers(ctx.key), maxBytes, signal, label: ctx.label, timeoutMs: 300_000 })).bytes;
  }
  return null;
}

export default {
  base: 'https://generativelanguage.googleapis.com/v1beta',

  async text(ctx, { model, effort, system, prompt, images = [], signal, timeoutMs = 300_000 }) {
    const body = {
      model,
      // the app's instructions travel with the prompt
      input: [...images.map(imagePart).filter(Boolean), { type: 'text', text: `${system}\n\n${prompt}` }],
    };
    if (effort) body.generation_config = { thinking_level: effort };
    const p = await interact(ctx, body, { signal, timeoutMs });
    const text = outputItems(p)
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
    if (!text) {
      if (p.status === 'incomplete') throw new ProviderError('CUT_OFF', 'Gemini ran out of room before answering. Try a lower effort.', { provider: ctx.label });
      throw new ProviderError('NO_OUTPUT', 'Gemini returned an empty answer.', { provider: ctx.label });
    }
    const u = usageOf(p);
    return { text, model, usage: { input: u.input, output: u.output, reasoning: u.reasoning } };
  },

  async image(ctx, { model, effort, prompt, aspect, signal }) {
    const aspect_ratio = nearestRatio(aspect, IMAGE_RATIOS);
    const response_format = { type: 'image', aspect_ratio };
    if (effort) response_format.image_size = effort;
    const p = await interact(ctx, { model, input: [{ type: 'text', text: prompt }], response_format }, { signal, timeoutMs: 180_000 });
    const item = outputItems(p).filter((c) => c?.type === 'image').pop();
    const bytes = item ? await itemBytes(ctx, item, { signal, maxBytes: 30_000_000 }) : null;
    if (!bytes?.length) throw new ProviderError('NO_OUTPUT', 'Gemini didn’t return an image.', { provider: ctx.label });
    const contentType = sniffImage(bytes);
    if (!contentType) throw new ProviderError('UPSTREAM', 'Gemini returned a file that isn’t an image.', { provider: ctx.label });
    const u = usageOf(p);
    return { bytes, contentType, model, revisedPrompt: '', usage: { input: u.input, output: u.output, reasoning: u.reasoning }, params: { aspect_ratio, image_size: effort } };
  },

  /** Gemini Omni answers in one long call, so the job runs in the background. */
  video: {
    async start(ctx, { model, effort, prompt, aspect, firstFrame, signal }) {
      const response_format = { type: 'video', aspect_ratio: aspect === '9:16' || aspect === '3:4' ? '9:16' : '16:9' };
      if (effort) response_format.resolution = effort;
      const frame = firstFrame ? imagePart(firstFrame) : null;
      const body = { model, input: frame ? [frame, { type: 'text', text: prompt }] : [{ type: 'text', text: prompt }], response_format };
      const run = (async () => {
        const p = await interact(ctx, body, { signal, timeoutMs: 15 * 60_000 });
        const item = outputItems(p).filter((c) => c?.type === 'video').pop();
        const bytes = item ? await itemBytes(ctx, item, { signal, maxBytes: 200_000_000 }) : null;
        if (!bytes?.length) throw new ProviderError('NO_OUTPUT', 'Gemini didn’t return a video.', { provider: ctx.label });
        return { bytes, contentType: sniffVideo(bytes) || item.mime_type || 'video/mp4', usage: usageOf(p) };
      })();
      run.catch(() => {}); // read by status()
      return { upstreamId: '', run, params: { aspect_ratio: response_format.aspect_ratio, resolution: effort } };
    },
  },

  async listModels(ctx, kind, { signal } = {}) {
    const r = await requestJson(ctx.fetch, `${ctx.base}/models?pageSize=1000`, { headers: headers(ctx.key), timeoutMs: 20_000, signal, label: ctx.label });
    if (!r.ok) throw errorFromResponse(r.status, r.payload, ctx.label);
    const ids = (Array.isArray(r.payload?.models) ? r.payload.models : []).map((x) => String(x?.name ?? '').replace(/^models\//, '')).filter(Boolean);
    if (kind === 'image') return ids.filter((id) => /image|nano-banana/.test(id));
    if (kind === 'video') return ids.filter((id) => /omni|veo/.test(id));
    return ids.filter((id) => /^gemini-/.test(id) && !/image|omni|tts|embedding|live|audio|nano-banana/.test(id));
  },
};
