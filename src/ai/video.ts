// AI video. Two routes, one flow (start a paid job, wait, bring the file back):
//   claude.ai artifact → HeyGen Video 1 through OpenRouter in the viewer's Zapier connector:
//                        start_video → POST /api/v1/videos; video_status → the job's state and
//                        size; video_chunk → one slice of the MP4 as base64 (files are larger
//                        than one connector reply)
//   self-hosted        → your server (/api/ai/video), which uses the keys that power Videos
//                        (OpenRouter, Google Gemini Omni or xAI Grok Imagine) at each key's quality

import type { ImageAspect, MediaRef } from '@/lib/types';
import { saveMediaFile, safeStorage } from '@/lib/storage';
import { readFileAsDataURL } from '@/lib/utils';
import { ZapierError, zapierCall } from '@/lib/zapier';
import { useStore } from '@/store/useStore';
import { serverBase } from './claude';
import { fmtElapsed } from './manus';
import { isAIMeta, type AIMeta } from './meta';
import { OPENROUTER_API } from './openrouter';

/** Self-hosted builds make videos on your server; the claude.ai artifact through Zapier. */
export const videoTransport = { server: !__ARTIFACT_BUILD__ };

export const VIDEO_MODEL = 'heygen/heygen-video-1';
const START = 'code_action_app217255cliapi__start_video';
const STATUS = 'code_action_app217255cliapi__video_status';
const CHUNK = 'code_action_app217255cliapi__video_chunk';

export type VideoResolution = '480p' | '768p' | '2K';
export type VideoAspect = '9:16' | '1:1' | '16:9' | '3:4' | '4:3';

export const VIDEO_DURATIONS = [5, 6, 8, 10, 12, 15] as const;
export const VIDEO_RESOLUTIONS: { id: VideoResolution; label: string }[] = [
  { id: '480p', label: '480p · draft' },
  { id: '768p', label: '768p · social' },
  { id: '2K', label: '2K · best' },
];
/** OpenRouter's list price per second; it has billed half of this so far */
const PRICE_PER_SECOND: Record<VideoResolution, number> = { '480p': 0.02, '768p': 0.036, '2K': 0.1 };
const CHUNK_BYTES = 1_500_000;
const MAX_VIDEO_BYTES = 40_000_000;

export class VideoError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface VideoJob {
  jobId: string;
  pollingUrl: string;
  /** a job on your server (self-hosted) */
  server?: boolean;
}

export interface VideoRequest {
  prompt: string;
  aspect: VideoAspect;
  duration: number;
  /** claude.ai route only: self-hosted, the key's quality in Settings → AI decides */
  resolution: VideoResolution;
  /** a photo to start from (e.g. the listing cover) */
  firstFrame?: Blob | null;
}

export function videoCost(duration: number, resolution: VideoResolution): number {
  return duration * PRICE_PER_SECOND[resolution];
}

export const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

/** The closest shape HeyGen offers for a post or listing image shape. */
export function videoAspectFor(aspect: ImageAspect | VideoAspect): VideoAspect {
  switch (aspect) {
    case '9:16':
    case '4:5':
      return aspect === '4:5' ? '3:4' : '9:16';
    case '1:1':
      return '1:1';
    case '3:4':
    case '4:3':
    case '16:9':
      return aspect;
    default:
      return '16:9';
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function fail(o: Record<string, unknown>, fallback: string): never {
  const error = str(o.error);
  const credits = /\b402\b|insufficient credits/i.test(error);
  throw new VideoError(credits ? 'Your OpenRouter account is out of credits. Add some at openrouter.ai/settings/credits.' : error || fallback, credits ? 'VIDEO_CREDITS' : 'VIDEO_ERROR');
}

export function parseVideoStart(raw: unknown): VideoJob {
  const o = obj(raw);
  if (o.ok === false || !str(o.job_id)) fail(o, 'OpenRouter didn’t start the video.');
  return { jobId: str(o.job_id), pollingUrl: str(o.polling_url) };
}

export interface VideoState {
  status: string;
  done: boolean;
  failed: boolean;
  error: string;
  sizeBytes: number;
  contentType: string;
  cost: number | null;
  /** your server: which key, model and quality made it */
  meta?: AIMeta | null;
}

// ───────────── your server ─────────────

async function serverVideo(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${serverBase(useStore.getState().settings.ai.serverUrl)}/api/ai/video${path}`, init);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new VideoError('Stopped.', 'cancelled');
    throw new VideoError('Couldn’t reach your AI server.', 'VIDEO_NETWORK');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    const code = body?.code === 'NO_PROVIDER' ? 'VIDEO_SETUP' : body?.code === 'CREDITS' ? 'VIDEO_CREDITS' : body?.code === 'NOT_FOUND' ? 'VIDEO_LOST' : res.status >= 500 && init.method !== 'POST' ? 'VIDEO_NETWORK' : 'VIDEO_ERROR';
    throw new VideoError(body?.error || `Video request failed (${res.status}).`, code);
  }
  return res;
}

interface ServerJob {
  id: string;
  state: 'running' | 'done' | 'failed';
  error: string;
  progress: number | null;
  meta: unknown;
}

function stateFromServer(j: ServerJob): VideoState {
  const meta = isAIMeta(j.meta) ? j.meta : null;
  return { status: j.state, done: j.state === 'done', failed: j.state === 'failed', error: j.error || '', sizeBytes: 0, contentType: 'video/mp4', cost: meta?.cost?.usd ?? null, meta };
}

export function parseVideoStatus(raw: unknown): VideoState {
  const o = obj(raw);
  if (o.ok === false) fail(o, 'Couldn’t read the video’s progress.');
  return {
    status: str(o.status),
    done: o.done === true,
    failed: o.failed === true,
    error: str(o.error),
    sizeBytes: Number(o.size_bytes) || 0,
    contentType: str(o.content_type) || 'video/mp4',
    cost: typeof o.cost === 'number' ? o.cost : null,
  };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      rej(new VideoError('Stopped.', 'cancelled'));
    });
  });

/** Start a video job (a paid write: never retried automatically). */
export async function startVideo(r: VideoRequest): Promise<VideoJob> {
  if (videoTransport.server) {
    const body: Record<string, unknown> = { prompt: r.prompt, aspect: r.aspect, duration: r.duration };
    if (r.firstFrame) body.firstFrame = await readFileAsDataURL(r.firstFrame);
    const res = await serverVideo('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const { job } = (await res.json()) as { job: ServerJob };
    return { jobId: job.id, pollingUrl: '', server: true };
  }
  const params: Record<string, unknown> = { model: VIDEO_MODEL, prompt: r.prompt, duration: String(r.duration), resolution: r.resolution, aspect_ratio: r.aspect };
  if (r.firstFrame) {
    // the connector's input limit is 1 MiB: listing covers are compressed JPEGs well under that
    if (r.firstFrame.size > 700_000) throw new VideoError('The starting photo is too large to send.', 'VIDEO_ERROR');
    params.first_frame_base64 = (await readFileAsDataURL(r.firstFrame)).replace(/^data:[^,]*,/, '');
    params.first_frame_mime = r.firstFrame.type || 'image/jpeg';
  }
  return parseVideoStart(await zapierCall(START, params, { selectedApi: OPENROUTER_API }));
}

export async function readVideo(job: VideoJob, signal?: AbortSignal): Promise<VideoState> {
  if (job.server) {
    const res = await serverVideo(`/${encodeURIComponent(job.jobId)}`, { signal });
    return stateFromServer(((await res.json()) as { job: ServerJob }).job);
  }
  const params: Record<string, unknown> = { job_id: job.jobId };
  if (job.pollingUrl) params.polling_url = job.pollingUrl;
  return parseVideoStatus(await zapierCall(STATUS, params, { selectedApi: OPENROUTER_API, signal }));
}

/** Wait for the job. Through Zapier each check is one Zapier task, so checks are spaced out. */
export async function waitForVideo(job: VideoJob, o: { signal?: AbortSignal; onUpdate?: (elapsedMs: number) => void; timeoutMs?: number } = {}): Promise<VideoState> {
  const t0 = Date.now();
  let failures = 0;
  await sleep(job.server ? 4_000 : 20_000, o.signal);
  for (;;) {
    o.onUpdate?.(Date.now() - t0);
    let s: VideoState;
    try {
      s = await readVideo(job, o.signal);
      failures = 0;
    } catch (e) {
      if (o.signal?.aborted) throw new VideoError('Stopped.', 'cancelled');
      const transient = (e instanceof ZapierError && (e.retryable || e.code === 'server_unavailable' || e.code === 'upstream_error')) || (e instanceof VideoError && e.code === 'VIDEO_NETWORK');
      if (transient && failures < 2) {
        failures += 1;
        await sleep(5000, o.signal);
        continue;
      }
      throw e;
    }
    if (s.failed) throw new VideoError(s.error || 'The video couldn’t be made.', 'VIDEO_FAILED');
    if (s.done) return s;
    if (Date.now() - t0 > (o.timeoutMs ?? 15 * 60_000)) throw new VideoError('The video is taking longer than usual. Try picking it up again later.', 'VIDEO_TIMEOUT');
    await sleep(job.server ? 5_000 : 15_000, o.signal);
  }
}

/** Bring the finished MP4 back (through Zapier, in slices). */
export async function downloadVideo(job: VideoJob, state: VideoState, o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<Blob> {
  if (job.server) {
    const res = await serverVideo(`/${encodeURIComponent(job.jobId)}/content`, { signal: o.signal });
    const blob = await res.blob();
    if (!blob.size) throw new VideoError('The video came back empty.', 'VIDEO_ERROR');
    return blob.type ? blob : new Blob([blob], { type: 'video/mp4' });
  }
  const parts: Uint8Array[] = [];
  let offset = 0;
  let total = state.sizeBytes || 0;
  let type = state.contentType;
  for (let i = 0; i < 40; i++) {
    const params: Record<string, unknown> = { job_id: job.jobId, offset: String(offset), length: String(CHUNK_BYTES) };
    if (job.pollingUrl) params.polling_url = job.pollingUrl;
    const c = obj(await zapierCall(CHUNK, params, { selectedApi: OPENROUTER_API, signal: o.signal }));
    if (c.ok === false) fail(c, 'Couldn’t download the video.');
    const b64 = str(c.base64);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    parts.push(bytes);
    offset += bytes.length;
    total = Number(c.total_size) || total;
    type = str(c.content_type) || type;
    if (total > MAX_VIDEO_BYTES) throw new VideoError('This video is too large to bring back. Try a shorter or lower-quality one.', 'VIDEO_ERROR');
    o.onProgress?.(offset, total);
    if (c.done === true || !bytes.length || (total && offset >= total)) break;
  }
  if (!offset) throw new VideoError('The video came back empty.', 'VIDEO_ERROR');
  return new Blob(parts as BlobPart[], { type: type || 'video/mp4' });
}

/** Start (or pick up) a job, wait, download and save it as post/listing media. */
export async function createVideo(r: VideoRequest & { name: string; signal?: AbortSignal; onStage?: (s: string) => void; pendingKey?: string; resume?: VideoJob }): Promise<{ media: MediaRef; cost: number | null; ms: number; meta: AIMeta | null }> {
  const t0 = Date.now();
  const maker = videoTransport.server ? 'The AI' : 'HeyGen';
  let job = r.resume;
  if (!job) {
    r.onStage?.(videoTransport.server ? 'Starting the video…' : 'Starting the HeyGen video…');
    job = await startVideo(r);
  }
  if (r.pendingKey) pendingVideos.set(r.pendingKey, job);
  const state = await waitForVideo(job, { signal: r.signal, onUpdate: () => r.onStage?.(`${maker} is making the video… ${fmtElapsed(Date.now() - t0)}`) });
  r.onStage?.('Bringing the video back…');
  const blob = await downloadVideo(job, state, { signal: r.signal, onProgress: (d, t) => t > CHUNK_BYTES && r.onStage?.(`Bringing the video back… ${Math.round((100 * d) / t)}%`) });
  if (r.pendingKey) pendingVideos.clear(r.pendingKey);
  const file = new File([blob], `${r.name}.mp4`, { type: blob.type || 'video/mp4' });
  const media = await saveMediaFile(file);
  return { media, cost: state.cost, ms: Date.now() - t0, meta: state.meta ?? null };
}

// ───────────── jobs still running after a reload ─────────────

const PENDING_KEY = 'ylb-video-pending';
type Pending = Record<string, VideoJob & { startedAt: number }>;

function readPending(): Pending {
  try {
    return JSON.parse(safeStorage.getItem(PENDING_KEY) || '{}') as Pending;
  } catch {
    return {};
  }
}

export const pendingVideos = {
  get(key: string): VideoJob | null {
    const p = readPending()[key];
    // OpenRouter keeps finished videos for about a day
    return p && Date.now() - p.startedAt < 20 * 3600_000 ? p : null;
  },
  set(key: string, job: VideoJob) {
    const all = readPending();
    all[key] = { ...job, startedAt: Date.now() };
    safeStorage.setItem(PENDING_KEY, JSON.stringify(all));
  },
  clear(key: string) {
    const all = readPending();
    delete all[key];
    safeStorage.setItem(PENDING_KEY, JSON.stringify(all));
  },
};

/** Friendly copy for a video failure (Zapier errors are handled by the caller). */
export function videoErrorMessage(code: string, message = ''): { title: string; body: string } | null {
  switch (code) {
    case 'VIDEO_CREDITS':
      return videoTransport.server ? { title: 'Out of credits', body: message || 'Add credits with your video provider, then try again.' } : { title: 'OpenRouter is out of credits', body: 'Add credits at openrouter.ai/settings/credits, then try again.' };
    case 'VIDEO_FAILED':
      return { title: videoTransport.server ? 'The video couldn’t be made' : 'HeyGen couldn’t make this video', body: message || 'Try a simpler description.' };
    case 'VIDEO_TIMEOUT':
      return { title: 'The video is still being made', body: message };
    case 'VIDEO_ERROR':
      return { title: 'Couldn’t create the video', body: message || 'Please try again.' };
    case 'VIDEO_SETUP':
      return { title: 'No key makes videos yet', body: message || 'In Settings → AI, tick Videos for an OpenRouter, Google or xAI key.' };
    case 'VIDEO_NETWORK':
      return { title: 'Couldn’t reach your AI server', body: 'Check that the server is running (npm run server), then try again.' };
    case 'VIDEO_LOST':
      return { title: 'The video job was lost', body: message || 'The server restarted while the video was being made. Start it again.' };
    default:
      return null;
  }
}
