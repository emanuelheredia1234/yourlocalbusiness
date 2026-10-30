// Meta's Model API: Muse Spark chat (effort in top-level `reasoning_effort`) and Muse Image
// (effort in `reasoning_strength`).

import { num } from '../http.mjs';
import { chatText, listModelIds } from './chat.mjs';
import { exactSize, imagesGenerations } from './images.mjs';

const auth = (key) => ({ authorization: `Bearer ${key}` });

export default {
  base: 'https://api.meta.ai/v1',

  async text(ctx, { model, effort, system, prompt, images, signal, timeoutMs }) {
    const out = await chatText(ctx, { url: `${ctx.base}/chat/completions`, headers: auth(ctx.key), model, system, prompt, images, effortBody: effort ? { reasoning_effort: effort } : {}, signal, timeoutMs });
    // Meta reports the dollar amount charged as `usage.credits`
    return { ...out, cost: out.cost ?? out.credits, credits: null };
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
