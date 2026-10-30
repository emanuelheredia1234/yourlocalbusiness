// Manus (the AI agent). Two ways to reach it, with the same answers:
//   claude.ai artifact → the viewer's Zapier connector, where two custom actions on the Manus
//                        connection do the work (create_task_with_image, task_output)
//   self-hosted        → your server (/api/ai/manus/*) with your Manus API key, which also picks
//                        the agent profile (the key's effort in Settings → AI)
// Manus tasks take minutes, so the page starts a task and then polls its output.

import type { BrandColors, ImageAspect } from '@/lib/types';
import { safeStorage } from '@/lib/storage';
import { readFileAsDataURL } from '@/lib/utils';
import { ZapierError, zapierCall } from '@/lib/zapier';
import { useStore } from '@/store/useStore';
import { ART_SIZE } from './local/art';
import { serverBase } from './claude';

export const MANUS_API = 'App229860CLIAPI';
export const MANUS_CREATE = 'code_action_app229860cliapi__create_task_with_image';
export const MANUS_OUTPUT = 'code_action_app229860cliapi__task_output';
export const MANUS_CONTINUE = 'continue_task';

/** Largest image file brought back through Zapier, in bytes (it travels as base64, about 1.35× that). */
export const MANUS_IMAGE_LIMIT = 2_000_000;
/** Your server brings back much larger files. */
export const MANUS_SERVER_IMAGE_LIMIT = 15_000_000;

/** Self-hosted builds reach Manus through your server; the claude.ai artifact through Zapier. */
export const manusTransport = { server: !__ARTIFACT_BUILD__ };
export const manusViaServer = () => manusTransport.server;

export function manusImageLimit(): number {
  return manusViaServer() ? MANUS_SERVER_IMAGE_LIMIT : MANUS_IMAGE_LIMIT;
}

/** One call to your server's Manus routes; errors come back as ManusErrors. */
async function serverManus(action: 'create' | 'output' | 'continue', body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${serverBase(useStore.getState().settings.ai.serverUrl)}/api/ai/manus/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new ManusError('Stopped.', 'cancelled');
    throw new ManusError('Couldn’t reach your AI server.', 'MANUS_NETWORK');
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const code = String(json?.code ?? '');
    const message = String(json?.error ?? `Manus request failed (${res.status}).`);
    if (code === 'NO_PROVIDER') throw new ManusError(message, 'MANUS_SETUP');
    if (res.status >= 500 && action !== 'create') throw new ManusError(message, 'MANUS_NETWORK');
    throw new ManusError(message, action === 'create' ? 'MANUS_CREATE' : 'MANUS_ERROR');
  }
  return json;
}

export class ManusError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly taskUrl?: string,
  ) {
    super(message);
  }
}

export interface ManusTask {
  taskId: string;
  taskUrl: string;
  title: string;
  /** a follow-up asking for a smaller image was already sent */
  followedUp?: boolean;
}

export interface ManusImage {
  filename: string;
  contentType: string;
  base64: string;
  sizeBytes: number;
  note: string;
}

export interface ManusState {
  taskId: string;
  status: string;
  agentStatus: string;
  done: boolean;
  waiting: boolean;
  waitingType: string;
  waitingDescription: string;
  error: string;
  title: string;
  taskUrl: string;
  creditUsage: number;
  text: string;
  imageCount: number;
  images: ManusImage[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const bool = (v: unknown) => v === true || v === 'true';

/** Find the first object in a (possibly nested) value that has `key`. */
function findWith(v: unknown, key: string, depth = 0): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || depth > 5) return null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const f = findWith(x, key, depth + 1);
      if (f) return f;
    }
    return null;
  }
  const o = v as Record<string, unknown>;
  if (key in o) return o;
  for (const x of Object.values(o)) {
    const f = findWith(x, key, depth + 1);
    if (f) return f;
  }
  return null;
}

export function parseManusCreate(raw: unknown): ManusTask {
  const o = findWith(raw, 'task_id') ?? findWith(raw, 'taskId');
  if (!o) {
    const err = findWith(raw, 'error');
    throw new ManusError(str(err?.error) || 'Manus didn’t return a task.', 'MANUS_CREATE');
  }
  if (o.ok === false || (str(o.error) && !str(o.task_id ?? o.taskId))) throw new ManusError(`${str(o.error) || 'Manus couldn’t start the task.'}${str(o.stage) ? ` (step: ${str(o.stage)})` : ''}`, 'MANUS_CREATE');
  const taskId = str(o.task_id ?? o.taskId);
  if (!taskId) throw new ManusError(str(o.error) || 'Manus didn’t return a task id.', 'MANUS_CREATE');
  return { taskId, taskUrl: str(o.task_url ?? o.taskUrl) || `https://manus.im/app/${taskId}`, title: str(o.task_title ?? o.title) };
}

export function parseManusState(raw: unknown): ManusState {
  const o = findWith(raw, 'done') ?? findWith(raw, 'status') ?? {};
  const images = Array.isArray(o.images)
    ? (o.images as Record<string, unknown>[]).map((i) => ({ filename: str(i.filename), contentType: str(i.content_type ?? i.contentType), base64: str(i.base64), sizeBytes: num(i.size_bytes ?? i.sizeBytes), note: str(i.note) }))
    : [];
  const status = str(o.status);
  const agentStatus = str(o.agent_status);
  return {
    taskId: str(o.task_id),
    status,
    agentStatus,
    done: bool(o.done) || status === 'error' || status === 'deleted',
    waiting: bool(o.waiting) || status === 'waiting' || agentStatus === 'waiting',
    waitingType: str(o.waiting_type),
    waitingDescription: str(o.waiting_description),
    error: str(o.error),
    title: str(o.title),
    taskUrl: str(o.task_url),
    creditUsage: num(o.credit_usage),
    text: str(o.text),
    imageCount: num(o.image_count) || images.length,
    images,
  };
}

// ───────────── prompts ─────────────

/** Instructions for a one-image Manus task. The app adds headlines and logos itself. */
export function manusImagePrompt(o: { subject: string; aspect: ImageAspect; styleHint?: string; colors: BrandColors; purpose: 'post' | 'listing'; textSpace: 'bottom' | 'center' | 'none' }): string {
  const [w, h] = ART_SIZE[o.aspect];
  return [
    `Generate exactly ONE high-quality image for a ${o.purpose === 'post' ? 'social media post' : 'marketplace product listing'}: a polished, realistic photo unless the style below says otherwise.`,
    `Subject: ${o.subject.trim().replace(/\.*$/, '.')}`,
    o.styleHint ? `Look and style: ${o.styleHint}.` : '',
    `Color palette inspired by the brand colors ${o.colors.primary}, ${o.colors.secondary} and ${o.colors.accent}.`,
    `Aspect ratio ${o.aspect} (about ${w}×${h} px), filling the whole frame.`,
    o.textSpace === 'bottom' ? 'Keep the lower third calm and uncluttered: a headline will be added there later.' : o.textSpace === 'center' ? 'Keep the center calm and uncluttered: a text panel will be placed there later.' : '',
    'Absolutely no text, letters, words, numbers, logos or watermarks in the image.',
    // image tools save multi-MB PNGs, too big to come back through Zapier
    `When it's done, resize it to about ${w}×${h} px, save it as a JPEG (quality about 85) under 1.5 MB, and attach only that JPEG to your final message.`,
    'Do not ask questions, do not build a website, document or slides, and do not make variations: one finished image file only.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Follow-up for a finished task whose image can't come back through Zapier (too large, or not attached). */
export function manusAttachPrompt(o: { imageCount: number; aspect: ImageAspect }): string {
  const [w, h] = ART_SIZE[o.aspect];
  return o.imageCount
    ? `The image file is too large for me to receive. Please resize the finished image to about ${w}×${h} px, save it as a JPEG (quality about 85) under 1.5 MB and attach that JPEG to your reply. Keep the picture exactly the same and don't ask questions.`
    : `I didn't receive an image file. Please attach the finished image to your reply as one JPEG (about ${w}×${h} px, quality about 85, under 1.5 MB). If it isn't made yet, make it as described in my first message. Don't ask questions.`;
}

// ───────────── calls ─────────────

const INLINE_LIMIT = 700_000; // bytes of raw image we inline as base64 (connector input limit is 1 MiB)

async function shrinkForUpload(blob: Blob): Promise<Blob> {
  if (blob.size <= INLINE_LIMIT || typeof document === 'undefined') return blob;
  const url = await readFileAsDataURL(blob);
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('Could not read the image'));
    i.src = url;
  });
  for (const [max, q] of [
    [1600, 0.86],
    [1280, 0.8],
    [1080, 0.74],
  ] as const) {
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    const ctx = c.getContext('2d');
    if (!ctx) break;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const out = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', q));
    if (out && out.size <= INLINE_LIMIT) return out;
  }
  throw new ManusError('This image is too large to send to Manus.', 'MANUS_IMAGE_TOO_LARGE');
}

export interface CreateManusOptions {
  /** what the task is for: its key must power this function (self-hosted) */
  fn: 'photos' | 'facebook';
  prompt: string;
  title?: string;
  image?: Blob | null;
  imageName?: string;
  /** let Manus pause to ask (e.g. to sign in to Facebook) */
  interactive?: boolean;
  hidden?: boolean;
  /** claude.ai only: self-hosted, the key's effort in Settings → AI picks the profile */
  profile?: 'standard' | 'lite' | 'max';
}

const SERVER_UPLOAD_LIMIT = 8_000_000;

/** Start a Manus task (one-shot write: never retried automatically). */
export async function createManusTask(o: CreateManusOptions): Promise<ManusTask> {
  if (manusViaServer()) {
    const body: Record<string, unknown> = { fn: o.fn, prompt: o.prompt, interactive_mode: !!o.interactive, hide_in_task_list: !!o.hidden };
    if (o.title) body.title = o.title.slice(0, 120);
    if (o.image) {
      const blob = o.image.size > SERVER_UPLOAD_LIMIT ? await shrinkForUpload(o.image) : o.image;
      const type = blob.type || 'image/jpeg';
      body.image_filename = (o.imageName || 'image').replace(/\.[a-z0-9]+$/i, '') + (type === 'image/png' ? '.png' : '.jpg');
      body.image_data_url = await readFileAsDataURL(blob);
    }
    return parseManusCreate(await serverManus('create', body));
  }
  // the code action declares every field as text
  const params: Record<string, unknown> = {
    prompt: o.prompt,
    interactive_mode: o.interactive ? 'true' : 'false',
    hide_in_task_list: o.hidden ? 'true' : 'false',
    agent_profile: o.profile ?? 'standard',
  };
  if (o.title) params.title = o.title.slice(0, 120);
  if (o.image) {
    // always inline: Zapier code actions take plain strings
    const blob = await shrinkForUpload(o.image);
    const type = blob.type || 'image/jpeg';
    const name = (o.imageName || 'image').replace(/\.[a-z0-9]+$/i, '') + (type === 'image/png' ? '.png' : '.jpg');
    params.image_filename = name;
    params.image_mime_type = type;
    params.image_base64 = (await readFileAsDataURL(blob)).replace(/^data:[^,]*,/, '');
  }
  try {
    return parseManusCreate(await zapierCall(MANUS_CREATE, params, { selectedApi: MANUS_API }));
  } catch (e) {
    if (e instanceof ZapierError && e.code === 'tool_error' && /not found|unknown action|does not exist/i.test(e.message)) {
      throw new ManusError('The Manus actions aren’t set up in your Zapier account yet.', 'MANUS_SETUP');
    }
    throw e;
  }
}

export async function readManusTask(taskId: string, o: { waitSeconds?: number; maxImages?: number; maxImageBytes?: number; signal?: AbortSignal } = {}): Promise<ManusState> {
  const params = { task_id: taskId, max_images: o.maxImages ?? 0, max_image_bytes: o.maxImageBytes ?? manusImageLimit() };
  const raw = manusViaServer() ? await serverManus('output', params, o.signal) : await zapierCall(MANUS_OUTPUT, { ...params, wait_seconds: o.waitSeconds ?? 0 }, { selectedApi: MANUS_API, signal: o.signal });
  const s = parseManusState(raw);
  return { ...s, taskId: s.taskId || taskId };
}

/** Index of the first image small enough to bring back (unknown sizes are worth a try), or -1. */
export function pickManusImage(images: ManusImage[]): number {
  return images.findIndex((i) => i.sizeBytes <= manusImageLimit() && (!i.contentType || i.contentType.startsWith('image/')));
}

/**
 * Bring back a finished task's image. The first read lists the attachments without their bytes;
 * the second downloads only the first one that fits, so an oversized file never travels.
 */
export async function fetchManusImage(taskId: string, o: { signal?: AbortSignal } = {}): Promise<{ image: ManusImage | null; state: ManusState }> {
  const list = await readManusTask(taskId, { maxImages: 8, maxImageBytes: 1, signal: o.signal });
  const idx = pickManusImage(list.images);
  if (idx < 0) return { image: null, state: list };
  const full = await readManusTask(taskId, { maxImages: idx + 1, signal: o.signal });
  return { image: full.images.find((i) => i.base64) ?? null, state: { ...full, images: full.images.length ? full.images : list.images } };
}

/** Send follow-up instructions to a task (one-shot write: never retried automatically). */
export async function continueManusTask(taskId: string, prompt: string): Promise<void> {
  if (manusViaServer()) await serverManus('continue', { task_id: taskId, prompt });
  else await zapierCall(MANUS_CONTINUE, { task_id: taskId, prompt }, { selectedApi: MANUS_API });
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      rej(new ManusError('Stopped.', 'cancelled'));
    });
  });

/**
 * Wait until a Manus task stops. After a follow-up, pass the state it was sent in as `after`:
 * the task can still read "stopped" for a moment, and that old answer mustn't count.
 */
export async function waitForManus(task: ManusTask, o: { signal?: AbortSignal; timeoutMs?: number; after?: ManusState; onUpdate?: (s: ManusState | null, elapsedMs: number) => void } = {}): Promise<ManusState> {
  const t0 = Date.now();
  const limit = o.timeoutMs ?? 12 * 60_000;
  let failures = 0;
  let pickedUp = !o.after;
  o.onUpdate?.(null, 0);
  for (;;) {
    if (o.signal?.aborted) throw new ManusError('Stopped.', 'cancelled', task.taskUrl);
    let s: ManusState;
    try {
      s = await readManusTask(task.taskId, { waitSeconds: 0, signal: o.signal });
      failures = 0;
    } catch (e) {
      if ((e as { code?: string }).code === 'cancelled' || o.signal?.aborted) throw new ManusError('Stopped.', 'cancelled', task.taskUrl);
      // a status read is safe to repeat: tolerate a couple of transient failures
      const transient = (e instanceof ZapierError && (e.retryable || e.code === 'server_unavailable' || e.code === 'upstream_error')) || (e instanceof ManusError && e.code === 'MANUS_NETWORK');
      if (transient && failures < 2) {
        failures += 1;
        await sleep(4000 + Math.random() * 3000, o.signal);
        continue;
      }
      throw e;
    }
    o.onUpdate?.(s, Date.now() - t0);
    if (s.status === 'error') throw new ManusError(s.error || 'Manus reported an error.', 'MANUS_ERROR', s.taskUrl || task.taskUrl);
    if (s.status === 'deleted') throw new ManusError('The Manus task was deleted.', 'MANUS_ERROR', task.taskUrl);
    if (!s.done) pickedUp = true;
    else if (!pickedUp) pickedUp = s.text !== o.after!.text || s.imageCount !== o.after!.imageCount || Date.now() - t0 > 90_000;
    if (s.done && pickedUp) return s;
    if (Date.now() - t0 > limit) throw new ManusError('Manus is still working on it.', 'MANUS_TIMEOUT', s.taskUrl || task.taskUrl);
    // the Zapier read long-polls while Manus runs; pause a little between reads otherwise (e.g. waiting for you)
    await sleep(s.waiting ? 15_000 : manusViaServer() ? 6_000 : 8_000, o.signal);
  }
}

export function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || 'image/png' });
}

// ───────────── tasks still running after a reload ─────────────

const PENDING_KEY = 'ylb-manus-pending';
type Pending = Record<string, ManusTask & { startedAt: number }>;

function readPending(): Pending {
  try {
    return JSON.parse(safeStorage.getItem(PENDING_KEY) || '{}') as Pending;
  } catch {
    return {};
  }
}

export const pendingManus = {
  get(key: string): (ManusTask & { startedAt: number }) | null {
    const p = readPending()[key];
    // tasks older than a day are not worth resuming
    return p && Date.now() - p.startedAt < 24 * 3600_000 ? p : null;
  },
  set(key: string, task: ManusTask) {
    const all = readPending();
    all[key] = { ...task, startedAt: Date.now() };
    safeStorage.setItem(PENDING_KEY, JSON.stringify(all));
  },
  clear(key: string) {
    const all = readPending();
    delete all[key];
    safeStorage.setItem(PENDING_KEY, JSON.stringify(all));
  },
};

export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Friendly copy for a Manus failure. */
export function manusErrorMessage(code: string, message = ''): { title: string; body: string } | null {
  switch (code) {
    case 'MANUS_SETUP':
      return manusViaServer()
        ? { title: 'Manus isn’t set up for this', body: message || 'Add your Manus API key in Settings → AI and tick this function in its “Powers” list.' }
        : { title: 'Manus isn’t set up in Zapier', body: 'The custom Manus actions are missing from your Zapier account. Ask Claude to set up Manus in Zapier again.' };
    case 'MANUS_CREATE':
      return { title: 'Manus couldn’t start the task', body: message || (manusViaServer() ? 'Check your Manus key and credits in Settings → AI.' : 'Check your Manus connection and credits in Zapier.') };
    case 'MANUS_NETWORK':
      return { title: 'Couldn’t reach your AI server', body: 'Check that the server is running (npm run server), then try again.' };
    case 'MANUS_ERROR':
      return { title: 'Manus reported an error', body: message || 'Open the task in Manus to see what happened.' };
    case 'MANUS_TIMEOUT':
      return { title: 'Manus is still working', body: 'It’s taking longer than usual. Open the task in Manus, or try again later to pick up the result.' };
    case 'MANUS_NO_IMAGE':
      return { title: 'No image came back', body: message || 'Manus finished without an image file. Open the task to see what happened.' };
    case 'MANUS_IMAGE_TOO_LARGE':
      return { title: 'Image too large for Manus', body: 'Use a smaller image and try again.' };
    default:
      return null;
  }
}
