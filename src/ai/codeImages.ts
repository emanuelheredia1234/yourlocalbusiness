// The owner's images in the Code & assets tasks: what the AI is told about them, the files it's sent, and
// the check on what it writes back. Code shows an image only through its {{img-N}} token, never through
// an address or base64: the code stays small enough to send again with every edit, and each place that
// shows it fills in the right address (a data URL in the preview and downloads, a path once published).

import type { PromptImage } from '@/lib/types';
import { MAX_AI_IMAGES, describeImagesForAI, imageKeyNumber, imageTokens, imagesForAI } from '@/lib/promptImages';
import { removeImages } from './local/code';

/** The images in a code task's input (named so it can't clash with other imports of PromptImage). */
export type CodeImages = PromptImage[];

type Code = { html: string; css: string; js: string };

/** The image keys the code uses as {{img-N}}, in its HTML, CSS or JS. */
export const codeImageKeys = (code: Code): string[] => imageTokens(`${code.html}\n${code.css}\n${code.js}`);

/**
 * What a widget prompt says about images: which the AI may use and how, or that it may use none. For an
 * edit, `code` is the widget's code now: images it doesn't show yet are named, since "this photo" in the
 * owner's change usually means the one they just added. `attached` is what the engine really sent (env.attached),
 * so "attached image N" always matches the files the AI gets.
 */
export function codeImageRules(images: CodeImages | undefined, code?: Code, attached: number | readonly string[] = MAX_AI_IMAGES): string {
  const own = (images ?? []).filter((i) => i.media.kind === 'image');
  if (!own.length) {
    return code
      ? ' Add no images: the owner has added none to this widget. Keep any {{img-N}} tokens already in the code as they are.'
      : ' Use no images: the owner added none. No <img> tags and no image addresses.';
  }
  const shown = code ? new Set(codeImageKeys(code)) : null;
  const fresh = shown ? own.filter((i) => !shown.has(i.key)).map((i) => `{{${i.key}}}`) : [];
  return [
    ` IMAGES: the owner added ${own.length === 1 ? 'this image' : `these ${own.length} images`} for this widget, each with its token:`,
    describeImagesForAI(own, attached),
    `The code may show only these images, and only through their tokens, written exactly as shown: <img src="{{${own[0].key}}}" alt="…"> in the HTML, or url({{${own[0].key}}}) in the CSS. Never use any other image address, a data: URL or base64, and never invent an image.`,
    'Images marked “attached image N” are attached to this request in that order when your model can see images; otherwise go by the owner’s note and the request.',
    ...(code
      ? [
          'Put an image where the owner’s change or its note says. Keep the {{img-N}} tokens already in the code as they are unless the change is about them.',
          ...(fresh.length ? [`Not in the code yet: ${fresh.join(', ')}. When the change says “this image” or “the new photo”, it means the last of these.`] : []),
        ]
      : ['Put each image where the owner’s request or its note says, else where it fits best; you may leave out an image that doesn’t fit.']),
    'Give each <img> a short alt text saying what it shows (from the owner’s note, or what you see), and never present an image as a customer, a review or a result unless the owner’s note says it is one.',
  ].join('\n');
}

/** The owner's images to send with a code task (resized), or none. */
export async function codeImagesForAI(images: CodeImages | undefined): Promise<Blob[] | undefined> {
  if (!images?.some((i) => i.media.kind === 'image')) return undefined;
  const blobs = await imagesForAI(images);
  return blobs.length ? blobs : undefined;
}

// What counts as a picture from elsewhere in AI-written code.
const TOKEN = /\{\{\s*img-(\d+)\s*\}\}/gi;
/** an embedded image file (a photo, not a small icon) */
const BASE64_IMAGE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{1500,}/gi;
/** …as a CSS url(), which goes as a whole (`url(none)` would ask the server for a file called "none") */
const BASE64_URL = /url\(\s*["']?\s*data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{1500,}["']?\s*\)/gi;
/** an <img>, <source> or <video poster> that loads its picture from another site */
const REMOTE_TAG = /<(?:img|source)\b[^>]*?\b(?:src|srcset)\s*=\s*["']?\s*(?:https?:)?\/\/[^>]*>|<video\b[^>]*?\bposter\s*=\s*["']?\s*(?:https?:)?\/\/[^>]*>/gi;
/** a CSS url() of another site's picture (fonts and imports are left alone) */
const REMOTE_URL = /url\(\s*["']?\s*(?:https?:)?\/\/[^)]*\)/gi;

/**
 * AI-written code with only the owner's images: tokens of images it wasn't given, embedded image files,
 * and pictures from other sites are taken out (a CSS background becomes `none`). `removed` counts them,
 * so the owner can be told.
 */
export function keepOwnImages<T extends Code>(code: T, keys: readonly string[]): { code: T; removed: number } {
  const allowed = new Set(keys.map((k) => imageKeyNumber(k)).filter(Boolean));
  let removed = 0;
  const count = <A extends unknown[]>(fn: (...a: A) => string) => (...a: A) => {
    removed++;
    return fn(...a);
  };
  // an image the owner never added: its <img> goes, like one the owner removed
  const unknown = [...new Set([...`${code.html}\n${code.css}\n${code.js}`.matchAll(TOKEN)].map((m) => Number(m[1])))].filter((n) => !allowed.has(n));
  if (unknown.length) {
    for (const m of `${code.html}\n${code.css}\n${code.js}`.matchAll(TOKEN)) if (!allowed.has(Number(m[1]))) removed++;
    code = removeImages(code, unknown.map((n) => `img-${n}`));
  }
  const embedded = (s: string) => s.replace(BASE64_URL, count(() => 'none')).replace(BASE64_IMAGE, count(() => ''));
  const cssUrls = (s: string) =>
    s.replace(REMOTE_URL, (m, offset: number, whole: string) => {
      // @font-face src and @import are about fonts, not pictures
      const before = whole.slice(Math.max(0, offset - 60), offset);
      return /(?:@import|\bsrc\s*:)[^;{}]*$/i.test(before) ? m : count(() => 'none')();
    });
  const html = cssUrls(embedded(code.html).replace(REMOTE_TAG, count(() => '')));
  const css = cssUrls(embedded(code.css));
  const js = embedded(code.js);
  return { code: { ...code, html, css, js }, removed };
}

/** What to tell the owner when keepOwnImages took something out (null when it didn't). */
export function keptOwnImagesNote(removed: number): string | null {
  if (!removed) return null;
  return `The AI added ${removed === 1 ? 'a picture' : `${removed} pictures`} that ${removed === 1 ? 'isn’t' : 'aren’t'} one of yours, so ${removed === 1 ? 'it was' : 'they were'} taken out. Only your own images can be used: add one with Add images.`;
}
