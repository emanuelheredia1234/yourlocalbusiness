// Meta Muse Image through OpenRouter, via the viewer's Zapier connector.
//
// A custom Zapier action on the user's OpenRouter connection does the work:
//   generate_image → OpenRouter /api/v1/images (chat/completions for chat image models)
// and returns the image as base64, so the page never needs to reach OpenRouter itself.

import type { ImageAspect } from '@/lib/types';
import { zapierCall } from '@/lib/zapier';

export const OPENROUTER_API = 'App217255CLIAPI';
export const OPENROUTER_IMAGE = 'code_action_app217255cliapi__generate_image';
export const MUSE_MODEL = 'meta/muse-image';

/** Largest image file brought back through Zapier, in bytes. */
export const MUSE_IMAGE_LIMIT = 2_000_000;

export class MuseError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface MuseImage {
  base64: string;
  contentType: string;
  sizeBytes: number;
  /** what OpenRouter charged, in dollars, when it says */
  cost: number | null;
}

/** OpenRouter takes the common ratios; the wide banner shapes are cropped from 16:9. */
export const MUSE_ASPECT: Record<ImageAspect, string> = {
  '1:1': '1:1',
  '4:5': '4:5',
  '9:16': '9:16',
  '1.91:1': '16:9',
  '3:2': '3:2',
  '21:8': '16:9',
};

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

export function parseMuseResult(raw: unknown): MuseImage {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const error = str(o.error);
  if (o.ok === false || (!str(o.base64) && error)) {
    const credits = /\b402\b|insufficient credits/i.test(error);
    throw new MuseError(credits ? 'Your OpenRouter account is out of credits. Add some at openrouter.ai/settings/credits.' : error || 'OpenRouter didn’t return an image.', credits ? 'MUSE_CREDITS' : 'MUSE_ERROR');
  }
  const base64 = str(o.base64);
  if (!base64) throw new MuseError(str(o.note) || 'OpenRouter didn’t return an image.', 'MUSE_NO_IMAGE');
  const usage = (o.usage && typeof o.usage === 'object' ? o.usage : {}) as Record<string, unknown>;
  return { base64, contentType: str(o.content_type) || 'image/png', sizeBytes: Number(o.size_bytes) || 0, cost: typeof usage.cost === 'number' ? usage.cost : null };
}

/** One image from Muse (a paid write: never retried automatically). */
export async function generateMuseImage(prompt: string, aspect: ImageAspect): Promise<MuseImage> {
  const raw = await zapierCall(OPENROUTER_IMAGE, { model: MUSE_MODEL, prompt, aspect_ratio: MUSE_ASPECT[aspect], max_image_bytes: String(MUSE_IMAGE_LIMIT) }, { selectedApi: OPENROUTER_API });
  return parseMuseResult(raw);
}

/** Friendly copy for a Muse failure. */
export function museErrorMessage(code: string, message = ''): { title: string; body: string } | null {
  switch (code) {
    case 'MUSE_CREDITS':
      return { title: 'OpenRouter is out of credits', body: 'Add credits at openrouter.ai/settings/credits, then try again.' };
    case 'MUSE_ERROR':
      return { title: 'Muse couldn’t make the image', body: message || 'Check your OpenRouter connection in Zapier.' };
    case 'MUSE_NO_IMAGE':
      return { title: 'No image came back', body: message || 'Try again, or rephrase the image description.' };
    default:
      return null;
  }
}
