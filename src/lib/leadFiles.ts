// Lead magnets' downloads: the client for server/leadFiles.mjs. A business's free download (a PDF made from its
// guide, a file the owner uploads, or a link) is published at a permanent address, https://<app>/m/<id>, optionally
// behind an email gate whose sign-ups land in Email → Leads. Plus public images (a download's cover). Publishing
// needs the app's server with accounts, so none of this is offered in the claude.ai build.

import { serverFetch } from '@/ai/claude';
import { serverBaseNow } from '@/lib/cloud/auth';
import { LEAD_FILE_ID } from './leadFields';

export type LeadFilePurpose = 'magnet' | 'product';

/** A published download, as the server describes it. */
export interface LeadFile {
  id: string;
  projectId: string;
  title: string;
  brand: string;
  kind: 'file' | 'url';
  fileName: string;
  mime: string;
  bytes: number;
  /** the outside link, for kind 'url' */
  url: string;
  /** visitors give their email first */
  gate: boolean;
  /** magnet: a free download at /m/<id>; product: a paid download, delivered only after a Stripe sale (no /m/ link) */
  purpose: LeadFilePurpose;
  coverUrl: string | null;
  downloads: number;
  lastDownloadAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  /** https://<app>/m/<id> */
  link: string;
}

export class LeadFilesError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** The server's limits (a little under them, so the client says so before sending). */
export const MAX_LEAD_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PUBLIC_IMAGE_BYTES = 5 * 1024 * 1024;
/** What an upload may be (the server checks the bytes too). */
export const LEAD_FILE_ACCEPT = '.pdf,.epub,.zip,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.webp,.mp3,.mp4';
export const PUBLIC_IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif';

/** Plain words for the server's refusals (its own message is used for the others). */
const MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'Your sign-in has ended. Sign in again, then try once more.',
  PAGES_OFF: 'Downloads need publishing, which isn’t set up on this app’s server yet.',
  RATE_LIMIT: 'That’s a lot of changes at once. Wait a minute, then try again.',
  FORBIDDEN: 'This request was refused because it didn’t come from the app’s own page.',
  NETWORK: 'Couldn’t reach the server. Check your connection, then try again.',
  TOO_MANY: 'You’ve published as many downloads as you can. Unpublish one first.',
  FILE_TYPE: 'That kind of file can’t be a download. Use a PDF, EPUB, ZIP, Word, Excel or PowerPoint file, a PNG, JPEG or WebP image, an MP3 or an MP4.',
  IMAGE_TYPE: 'Use a JPEG, PNG, WebP or GIF image.',
  QUOTA: 'Your downloads are using all the space your account has. Remove one first.',
  TOO_LARGE: 'That file is too big: a download can be up to 25 MB, a cover image up to 5 MB.',
  UPGRADE: 'Publishing downloads needs an active plan. See Settings › Plan.',
  BAD_URL: 'Use a full web address starting with https://.',
  LEADS_MIGRATION: 'Downloads need an update to the app’s database first. Ask the app’s owner to run the latest migration.',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const time = (v: unknown): number | null => (typeof v === 'number' ? v : typeof v === 'string' && v ? Date.parse(v) || null : null);

/** A download from the server's answer, or null when it isn't one. */
export function toLeadFile(raw: unknown): LeadFile | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r) || !LEAD_FILE_ID.test(str(r.id))) return null;
  const link = str(r.link);
  const cover = str(r.coverUrl);
  return {
    id: str(r.id),
    projectId: str(r.projectId),
    title: str(r.title),
    brand: str(r.brand),
    kind: r.kind === 'url' ? 'url' : 'file',
    fileName: str(r.fileName),
    mime: str(r.mime),
    bytes: typeof r.bytes === 'number' && r.bytes > 0 ? r.bytes : 0,
    url: /^https?:\/\//i.test(str(r.url)) ? str(r.url) : '',
    gate: r.gate !== false,
    purpose: r.purpose === 'product' ? 'product' : 'magnet',
    coverUrl: /^https?:\/\//i.test(cover) ? cover : null,
    downloads: typeof r.downloads === 'number' && r.downloads > 0 ? Math.floor(r.downloads) : 0,
    lastDownloadAt: time(r.lastDownloadAt),
    createdAt: time(r.createdAt),
    updatedAt: time(r.updatedAt),
    // a product file is never served at /m/: it has no public link
    link: r.purpose !== 'product' && /^https?:\/\/[^/]+\/m\/[A-Za-z0-9_-]{22}$/.test(link) ? link : '',
  };
}

/** The error for a refused answer: the server's code, in plain words. */
export function leadFilesError(status: number, body: { error?: unknown; code?: unknown } | null): LeadFilesError {
  let code = str(body?.code) || (status === 429 ? 'RATE_LIMIT' : status === 401 ? 'AUTH_REQUIRED' : status === 413 ? 'TOO_LARGE' : status === 415 ? 'FILE_TYPE' : `HTTP_${status}`);
  // a refusal for the plan (402) reads as "upgrade", whatever its code
  if (status === 402) code = 'UPGRADE';
  return new LeadFilesError(MESSAGES[code] ?? (str(body?.error) || `The server couldn’t do that (error ${status}). Try again.`), code, status);
}

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, init: { json?: unknown; body?: Blob; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.body) body = init.body;
    res = await serverFetch(serverBaseNow(), path, { method, headers, body, signal: init.signal });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new LeadFilesError(MESSAGES.NETWORK, 'NETWORK');
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: unknown; code?: unknown }) | null;
  if (!res.ok) throw leadFilesError(res.status, json);
  return (json ?? {}) as T;
}

const idPath = (id: string) => {
  if (!LEAD_FILE_ID.test(id)) throw new LeadFilesError('That download isn’t one the server knows.', 'BAD_ID');
  return id;
};
const one = (j: { file?: unknown }): LeadFile => {
  const f = toLeadFile(j.file);
  if (!f) throw new LeadFilesError('The server’s answer couldn’t be read. Try again.', 'BAD_ANSWER');
  return f;
};

/** Your downloads (one business's, with projectId; only lead magnets or only product files, with purpose). */
export async function listLeadFiles(projectId?: string, signal?: AbortSignal, purpose?: LeadFilePurpose): Promise<LeadFile[]> {
  const q = new URLSearchParams();
  if (projectId) q.set('projectId', projectId);
  if (purpose) q.set('purpose', purpose);
  const qs = q.toString();
  const j = await call<{ files?: unknown }>('GET', `/api/lead-files${qs ? `?${qs}` : ''}`, { signal });
  return (Array.isArray(j.files) ? j.files : []).map(toLeadFile).filter((f): f is LeadFile => !!f);
}

/** A new download: a file (its content comes next, uploadLeadFileContent) or a link. */
export async function createLeadFile(input: { projectId: string; title: string; brand?: string; kind: 'file' | 'url'; url?: string; gate?: boolean; purpose?: LeadFilePurpose }): Promise<LeadFile> {
  return one(await call<{ file?: unknown }>('POST', '/api/lead-files', { json: input }));
}

/** Whether a file's name is one the server would refuse anyway (markup), checked before uploading. */
export function refusedFileName(name: string): boolean {
  return /\.(svg|svgz|html?|xhtml|xml|js|mjs)$/i.test(name.trim());
}

/** The file of a download (replacing the one before; the link stays the same). Raw bytes, not JSON. */
export async function uploadLeadFileContent(id: string, blob: Blob, name: string): Promise<LeadFile> {
  if (refusedFileName(name)) throw new LeadFilesError(MESSAGES.FILE_TYPE, 'FILE_TYPE', 415);
  if (blob.size > MAX_LEAD_FILE_BYTES) throw new LeadFilesError(MESSAGES.TOO_LARGE, 'TOO_LARGE', 413);
  if (!blob.size) throw new LeadFilesError('That file is empty.', 'EMPTY');
  const clean = name.replace(/[^A-Za-z0-9._ -]/g, '').slice(0, 200) || 'download';
  return one(await call<{ file?: unknown }>('PUT', `/api/lead-files/${idPath(id)}/content`, { body: blob, headers: { 'content-type': 'application/octet-stream', 'x-file-name': clean } }));
}

/** Change a download's title, gate or link. */
export async function patchLeadFile(id: string, patch: { title?: string; brand?: string; gate?: boolean; url?: string }): Promise<LeadFile> {
  return one(await call<{ file?: unknown }>('PATCH', `/api/lead-files/${idPath(id)}`, { json: patch }));
}

/** Unpublish a download: its link stops working at once. Already gone counts as done. */
export async function deleteLeadFile(id: string): Promise<void> {
  try {
    await call('DELETE', `/api/lead-files/${idPath(id)}`);
  } catch (e) {
    if (!(e instanceof LeadFilesError && e.status === 404)) throw e;
  }
}

/** A public image (with leadFile: that download's cover, replacing the one before). Never SVG. */
export async function uploadPublicImage(blob: Blob, name: string, leadFile?: string, use?: 'email' | 'listing'): Promise<{ url: string; path: string }> {
  // hosting needs the app's own server: never called in the claude.ai build (and the path isn't in its bundle)
  if (__ARTIFACT_BUILD__) throw new LeadFilesError('Image hosting needs the app’s own server.', 'NO_SERVER');
  if (refusedFileName(name) || !/\.(png|jpe?g|webp|gif)$/i.test(name.trim())) throw new LeadFilesError(MESSAGES.IMAGE_TYPE, 'FILE_TYPE', 415);
  if (blob.size > MAX_PUBLIC_IMAGE_BYTES) throw new LeadFilesError(MESSAGES.TOO_LARGE, 'TOO_LARGE', 413);
  // an email's image (P5: e-<random>.<ext>, listed apart from covers), or a lead file's cover
  // or a public listing's image (P7: l-<random>.<ext>)
  const query = use === 'email' ? '?use=email' : use === 'listing' ? '?use=listing' : leadFile ? `?leadFile=${idPath(leadFile)}` : '';
  const j = await call<{ url?: unknown; path?: unknown }>('POST', `/api/public-images${query}`, { body: blob, headers: { 'content-type': 'application/octet-stream' } });
  const url = str(j.url);
  if (!/^https?:\/\//i.test(url)) throw new LeadFilesError('The server’s answer couldn’t be read. Try again.', 'BAD_ANSWER');
  return { url, path: str(j.path) };
}
