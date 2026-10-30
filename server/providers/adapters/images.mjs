// OpenAI-style Images API (POST …/images/generations), shared by OpenAI, xAI and Meta.

import { ProviderError, errorFromResponse, imageFromValue, requestJson, sniffImage } from '../http.mjs';

/** Width:height for every aspect the app asks for. */
export const ASPECTS = {
  '1:1': [1, 1],
  '4:5': [4, 5],
  '9:16': [9, 16],
  '1.91:1': [1.91, 1],
  '3:2': [3, 2],
  '21:8': [21, 8],
};

/** The allowed ratio string closest to the aspect the app wants. */
export function nearestRatio(aspect, allowed) {
  const [w, h] = ASPECTS[aspect] ?? ASPECTS['1:1'];
  const want = w / h;
  let best = allowed[0];
  let bestDiff = Infinity;
  for (const r of allowed) {
    const [a, b] = r.split(/[:x]/).map(Number);
    const diff = Math.abs(Math.log(a / b / want));
    if (diff < bestDiff) {
      best = r;
      bestDiff = diff;
    }
  }
  return best;
}

/** "WxH" with the long side `long`, both sides multiples of `step`. */
export function exactSize(aspect, long = 1536, step = 64) {
  const [w, h] = ASPECTS[aspect] ?? ASPECTS['1:1'];
  const ratio = w / h;
  const W = ratio >= 1 ? long : Math.round((long * ratio) / step) * step;
  const H = ratio >= 1 ? Math.round(long / ratio / step) * step : long;
  return `${W}x${H}`;
}

/**
 * One image. Optional fields a host rejects (named in its 400 reply) are dropped and the request
 * sent again: a 400 means nothing was generated or billed.
 */
export async function imagesGenerations(ctx, { url, headers, body, optional = [], signal, timeoutMs = 180_000 }) {
  let b = { ...body };
  const dropped = [];
  for (;;) {
    const r = await requestJson(ctx.fetch, url, { method: 'POST', headers, body: b, timeoutMs, signal, label: ctx.label });
    if (!r.ok) {
      const msg = JSON.stringify(r.payload ?? '');
      const drop = optional.find((k) => k in b && msg.includes(k));
      if (r.status === 400 && drop && dropped.length < 2 && !/content_policy|safety|moderation/i.test(msg)) {
        b = { ...b };
        delete b[drop];
        dropped.push(drop);
        continue;
      }
      throw errorFromResponse(r.status, r.payload, ctx.label);
    }
    const item = Array.isArray(r.payload?.data) ? r.payload.data[0] : null;
    const bytes = item?.b64_json ? Buffer.from(String(item.b64_json), 'base64') : await imageFromValue(ctx.fetch, item?.url, { label: ctx.label, signal });
    if (!bytes?.length) throw new ProviderError('NO_OUTPUT', `${ctx.label} didn’t return an image.`, { provider: ctx.label });
    const contentType = sniffImage(bytes);
    if (!contentType) throw new ProviderError('UPSTREAM', `${ctx.label} returned a file that isn’t an image.`, { provider: ctx.label });
    return { bytes, contentType, revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : '', usage: r.payload?.usage ?? null, sent: b, dropped };
  }
}
