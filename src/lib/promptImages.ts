// Images the owner adds in a prompt box (the sales page's and each artifact's). The page or artifact refers
// to each one by a token, {{img-1}}, {{img-2}}…, never by an address or base64: the code stays small, AI
// edits can send it again, and each place that shows the page puts in the right address (a data URL in
// the preview and downloads, a path on the public page once it's published).

import type { MediaRef, PromptImage } from './types';
import { getBlob } from './storage';
import { hashStr, listJoin, readFileAsDataURL, truncate } from './utils';
import { toast } from '@/store/ui';

/** The most images one page or artifact can have. */
export const MAX_PROMPT_IMAGES = 8;
/** The most images sent to the AI with one request (your server keeps 4). */
export const MAX_AI_IMAGES = 4;
/** SVG is left out on purpose: an SVG file can carry code. */
export const PROMPT_IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const PROMPT_IMAGE_ACCEPT = PROMPT_IMAGE_TYPES.join(',');

/** Published image names are img-1.jpg … img-99.png, so new keys stop at 99. */
const MAX_KEY = 99;
const KEY = /^img-(\d+)$/;
const TOKEN = /\{\{\s*img-(\d+)\s*\}\}/gi;

/** 3 for 'img-3'; 0 for anything else. */
export function imageKeyNumber(key: string): number {
  const m = KEY.exec(key);
  return m ? Number(m[1]) : 0;
}

/**
 * The key for the next image: one more than the highest in use. `reserved` adds keys still used
 * elsewhere (e.g. tokens left in the code after their image was removed), so a new image never takes
 * their place. Past img-99 it takes the lowest free number.
 */
export function nextImageKey(images: PromptImage[], reserved: readonly string[] = []): string {
  const used = new Set<number>();
  for (const k of [...images.map((i) => i.key), ...reserved]) {
    const n = imageKeyNumber(k);
    if (n) used.add(n);
  }
  const top = used.size ? Math.max(...used) : 0;
  if (top < MAX_KEY) return `img-${top + 1}`;
  for (let n = 1; n <= MAX_KEY; n++) if (!used.has(n)) return `img-${n}`;
  return `img-${top + 1}`;
}

/** Why files weren't added, counted: SVG, video, another type, or no room left. */
export type RefusalCounts = Partial<Record<'svg' | 'video' | 'type' | 'full', number>>;

/** Whether a file (or a saved image) can go in a prompt box, by its type; null when it can. */
export function promptImageRefusal(mime: string, kind?: 'image' | 'video'): 'svg' | 'video' | 'type' | null {
  const t = (mime || '').toLowerCase();
  if (kind === 'video' || t.startsWith('video/')) return 'video';
  if (t === 'image/svg+xml') return 'svg';
  return PROMPT_IMAGE_TYPES.includes(t) ? null : 'type';
}

/** What to tell the owner about files that weren't added (null when every file was). */
export function refusalNotice(c: RefusalCounts, max = MAX_PROMPT_IMAGES): { title: string; body: string } | null {
  const total = (c.svg ?? 0) + (c.video ?? 0) + (c.type ?? 0) + (c.full ?? 0);
  if (!total) return null;
  const why: string[] = [];
  if (c.svg) why.push('SVG files can’t be used because they can carry code. Use a PNG or JPEG instead.');
  if (c.video) why.push('Videos can’t be used here, only images.');
  if (c.type) why.push('Use JPEG, PNG, WebP or GIF images.');
  if (c.full) why.push(`A page can have up to ${max} images.`);
  return { title: total === 1 ? 'That file wasn’t added' : `${total} files weren’t added`, body: why.join(' ') };
}

/** Say (once) why files weren't added. */
export function reportRefusals(c: RefusalCounts, max = MAX_PROMPT_IMAGES): void {
  const n = refusalNotice(c, max);
  if (n) toast({ kind: 'error', ...n });
}

/**
 * `current` plus the images from `media` that can go in a prompt box (JPEG, PNG, WebP or GIF, not
 * already there, up to `max` in all), each with a new key. `refused` counts the others by reason.
 */
export function planPromptImages(current: PromptImage[], media: MediaRef[], opts: { max?: number; reserved?: readonly string[] } = {}): { images: PromptImage[]; added: PromptImage[]; refused: RefusalCounts } {
  const max = opts.max ?? MAX_PROMPT_IMAGES;
  const reserved = opts.reserved ?? [];
  const images = [...current];
  const added: PromptImage[] = [];
  const refused: RefusalCounts = {};
  for (const m of media) {
    if (images.some((i) => i.media.id === m.id)) continue;
    const why = promptImageRefusal(m.mime, m.kind) ?? (images.length >= max ? 'full' : null);
    if (why) {
      refused[why] = (refused[why] ?? 0) + 1;
      continue;
    }
    const img: PromptImage = { key: nextImageKey(images, reserved), media: m };
    images.push(img);
    added.push(img);
  }
  return { images, added, refused };
}

/** Add images to a prompt box's list (see planPromptImages), saying why any weren't added. */
export function addPromptImages(current: PromptImage[], media: MediaRef[], opts: { max?: number; reserved?: readonly string[] } = {}): PromptImage[] {
  const plan = planPromptImages(current, media, opts);
  reportRefusals(plan.refused, opts.max);
  return plan.images;
}

// ───────────── tokens ─────────────

/** The image keys a text uses as {{img-N}}, each once, in order. */
export function imageTokens(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of (text ?? '').matchAll(TOKEN)) {
    const key = `img-${Number(m[1])}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** The text with each {{img-N}} replaced by its address in `map`; a key the map doesn't have becomes '' (no token is ever left showing). */
export function resolveImageTokens(text: string, map: Record<string, string>): string {
  return text.replace(TOKEN, (_, n: string) => map[`img-${Number(n)}`] ?? '');
}

/** The images that texts (html, css, js…) use. */
export function usedImages(images: PromptImage[], ...texts: string[]): PromptImage[] {
  const keys = new Set(texts.flatMap((t) => imageTokens(t)));
  return images.filter((i) => keys.has(i.key));
}

// ───────────── telling the AI ─────────────

function kindLabel(m: MediaRef): string {
  const t = (m.mime || '').toLowerCase();
  const kind = t === 'image/png' ? 'PNG image' : t === 'image/gif' ? 'GIF image' : 'photo';
  return m.w && m.h ? `${m.w}×${m.h} ${kind}` : kind;
}

/**
 * One line per image for a prompt: its token, whether it's attached (and which attachment it is),
 * the owner's note and its size:
 *   {{img-1}} (attached image 1): "our shop front" — 1200×800 photo
 * `attached` is best given as the keys the request really attached, in order (the engine passes
 * env.attached): a file that couldn't be loaded, or a limit of the AI, then never shifts the numbers.
 * A number means "the first N images", which is what imagesForAI tries to attach.
 */
export function describeImagesForAI(images: PromptImage[], attached: number | readonly string[] = MAX_AI_IMAGES): string {
  let n = 0;
  return images
    .map((img) => {
      const at = typeof attached === 'number' ? (img.media.kind === 'image' && n < attached ? ++n : 0) : attached.indexOf(img.key) + 1;
      const where = at ? `attached image ${at}` : 'not attached: go by its note';
      const note = img.note?.trim() ? `: ${JSON.stringify(truncate(img.note.trim().replace(/\s+/g, ' '), 300))}` : '';
      return `{{${img.key}}} (${where})${note} — ${kindLabel(img.media)}`;
    })
    .join('\n');
}

// ───────────── image files ─────────────

interface Decoded {
  img: HTMLImageElement;
  w: number;
  h: number;
  done: () => void;
}

/**
 * Open an image file for drawing. An <img> is used because browsers turn phone photos the right way
 * up there. Inside claude.ai it reads a data URL (the only kind of address allowed there).
 */
async function decode(blob: Blob): Promise<Decoded> {
  if (typeof document === 'undefined') throw new Error('Images can only be prepared in the browser.');
  const objectUrl = __ARTIFACT_BUILD__ ? null : URL.createObjectURL(blob);
  const src = objectUrl ?? (await readFileAsDataURL(blob));
  const done = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Couldn’t read that image.'));
      i.src = src;
    });
    return { img, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height, done };
  } catch (e) {
    done();
    throw e;
  }
}

function draw(d: Decoded, max: number, type: 'image/jpeg' | 'image/png', quality = 0.85): Promise<Blob> {
  const scale = Math.min(1, max / Math.max(d.w, d.h, 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(d.w * scale));
  canvas.height = Math.max(1, Math.round(d.h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Couldn’t prepare that image.'));
  if (type === 'image/jpeg') {
    // a transparent background would turn black in a JPEG
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(d.img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t prepare that image.'))), type, quality));
}

interface EncodeOptions {
  /** [longest side, JPEG quality], tried in order until the file fits `budget` */
  steps: [number, number][];
  budget?: number;
  /** keep a PNG as a PNG (a logo keeps its transparent background) when it's at most this many bytes */
  pngUpTo?: number;
}

/**
 * Redraw an image, smaller. Always redrawn, never passed on as it was: that also drops the photo's
 * hidden details (such as where it was taken), which must never reach a public page.
 */
async function encode(blob: Blob, o: EncodeOptions): Promise<{ blob: Blob; mime: 'image/jpeg' | 'image/png' }> {
  const d = await decode(blob);
  try {
    if (o.pngUpTo && blob.type === 'image/png') {
      const png = await draw(d, o.steps[0][0], 'image/png');
      if (png.size <= o.pngUpTo) return { blob: png, mime: 'image/png' };
    }
    let out: Blob | null = null;
    for (const [max, q] of o.steps) {
      out = await draw(d, max, 'image/jpeg', q);
      if (!o.budget || out.size <= o.budget) break;
    }
    return { blob: out!, mime: 'image/jpeg' };
  } finally {
    d.done();
  }
}

/** An image's file: from this device, or the account. Null for a video or a file that can't be had. */
async function fileOf(img: PromptImage): Promise<Blob | null> {
  if (img.media.kind !== 'image') return null;
  return getBlob(img.media.id).catch(() => null);
}

/**
 * The first `max` images, ready for the AI (up to 1280 px JPEGs, in order), each with its key. An image
 * whose file can't be had (or read) is skipped, so the keys say exactly which ones are ready to attach.
 */
export async function imagesWithKeysForAI(images: PromptImage[] | undefined, max = MAX_AI_IMAGES): Promise<{ key: string; blob: Blob }[]> {
  const out: { key: string; blob: Blob }[] = [];
  for (const img of (images ?? []).filter((i) => i.media.kind === 'image').slice(0, max)) {
    const blob = await fileOf(img);
    if (!blob) continue;
    const small = await encode(blob, { steps: [[1280, 0.85]] }).catch(() => null);
    if (small) out.push({ key: img.key, blob: small.blob });
  }
  return out;
}

/** The first `max` images, ready for the AI: up to 1280 px JPEGs, in order (see imagesWithKeysForAI). */
export async function imagesForAI(images: PromptImage[] | undefined, max = MAX_AI_IMAGES): Promise<Blob[]> {
  return (await imagesWithKeysForAI(images, max)).map((x) => x.blob);
}

/** Sizes to try, largest first, so each image stays under the budget. */
const stepsFrom = (max: number): [number, number][] => [
  [max, 0.82],
  [Math.round(max * 0.9), 0.76],
  [Math.round(max * 0.8), 0.72],
  [Math.round(max * 0.675), 0.68],
];
/** each published image stays under this, so a page with 8 of them fits in one request */
const IMAGE_BUDGET = 900 * 1024;
/** a PNG up to this size stays a PNG */
const PNG_SMALL = 700 * 1024;
const PUBLISH_MAX = 1600;

const dataUrlCache = new Map<string, Promise<string | null>>();

/** One image as a data URL, kept for the next preview (the newest 24). */
function cachedDataUrl(img: PromptImage, max: number): Promise<string | null> {
  const id = `${img.media.id}|${max}`;
  let p = dataUrlCache.get(id);
  if (!p) {
    const made = fileOf(img)
      .then((blob) => (blob ? encode(blob, { steps: stepsFrom(max), budget: IMAGE_BUDGET, pngUpTo: PNG_SMALL }) : null))
      .then((e) => (e ? readFileAsDataURL(e.blob) : null))
      .catch(() => null);
    p = made;
    dataUrlCache.set(id, made);
    // a file that couldn't be had may arrive later: look again next time
    void made.then((v) => {
      if (v === null && dataUrlCache.get(id) === made) dataUrlCache.delete(id);
    });
    while (dataUrlCache.size > 24) dataUrlCache.delete(dataUrlCache.keys().next().value!);
  }
  return p;
}

/** key → data URL (at most `max` px) for the preview, Copy and downloads. Images whose file can't be had are left out. */
export async function imageDataUrls(images: PromptImage[] | undefined, max = PUBLISH_MAX): Promise<Record<string, string>> {
  const list = (images ?? []).filter((i) => i.media.kind === 'image');
  const urls = await Promise.all(list.map((img) => cachedDataUrl(img, max)));
  const out: Record<string, string> = {};
  list.forEach((img, i) => {
    const u = urls[i];
    if (u) out[img.key] = u;
  });
  return out;
}

export interface PublishImage {
  /** img-1.jpg, img-2.png… */
  name: string;
  mime: 'image/jpeg' | 'image/png';
  /** the file, base64 */
  data: string;
  /** fingerprint of the file */
  hash: string;
}

/**
 * The images a page uses (`keys`), ready to publish: at most 1600 px, JPEG (a small PNG stays a PNG),
 * each under 900 KB. Throws, saying which, when a used image's file can't be had.
 */
export async function imagesForPublish(images: PromptImage[], keys: string[]): Promise<PublishImage[]> {
  const out: PublishImage[] = [];
  const missing: number[] = [];
  for (const img of images.filter((i) => keys.includes(i.key))) {
    const blob = await fileOf(img);
    if (!blob) {
      missing.push(imageKeyNumber(img.key));
      continue;
    }
    const e = await encode(blob, { steps: stepsFrom(PUBLISH_MAX), budget: IMAGE_BUDGET, pngUpTo: PNG_SMALL });
    const data = (await readFileAsDataURL(e.blob)).replace(/^data:[^,]*,/, '');
    out.push({ name: `${img.key}.${e.mime === 'image/png' ? 'png' : 'jpg'}`, mime: e.mime, data, hash: `${hashStr(data).toString(16).padStart(8, '0')}${data.length.toString(16)}` });
  }
  if (missing.length) {
    const which = missing.length === 1 ? `Image ${missing[0]} couldn’t` : `Images ${listJoin(missing.map(String))} couldn’t`;
    throw new Error(`${which} be loaded. If you added ${missing.length === 1 ? 'it' : 'them'} on another device, ${missing.length === 1 ? 'it' : 'they'} may still be uploading: try again in a minute, or remove ${missing.length === 1 ? 'it' : 'them'} from the page.`);
  }
  return out;
}
