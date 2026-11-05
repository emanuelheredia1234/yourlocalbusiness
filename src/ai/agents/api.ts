// The app's side of the routes that build and chat with Manus (/api/ai/manus/*, server/providers/routes.mjs)
// and Viktor through Slack (/api/ai/slack/*, server/slack/routes.mjs). One function per route, and one error
// type whose codes the build window, the build cards and the assistant chat all explain the same way.
//
// The server writes every message Manus or Viktor gets from its fixed templates (server/agents/templates.mjs):
// the app sends only structured fields (the target, the kind, the facts the owner ticked, the website, the
// owner's words, image notes). Writes (manusStart, manusSend, viktorSend and the two attach calls) are
// one-shot: nothing here retries them. A write that fails in a way that may have delivered it is
// SEND_UNKNOWN, settled by a read (manusVerify, viktorVerify), never by sending again.

import type { AgentFileRef, AgentHtml, AgentId, AgentPreview, BuildRequest, ChatRequest, ImageNote, ManusRead, ViktorRead, ViktorSent } from '@/lib/agentTypes';
import type { PromptImage } from '@/lib/types';
import { imageKeyNumber, imagesForPublish } from '@/lib/promptImages';
import { useStore } from '@/store/useStore';
import { serverFetch } from '@/ai/claude';
import { agentName, agentReady, readinessText } from './who';

export type AgentErrorCode =
  | 'SETUP' // not set up: no key or token, function not ticked, Viktor or the place not chosen (data.reason)
  | 'OWNER_ONLY' // Viktor is the owner's; or Manus needs your own key
  | 'NOT_SENT' // refused before anything went out: safe to send again
  | 'SEND_UNKNOWN' // may have been delivered: check (verify) before sending again
  | 'TOO_LONG' // data: { chars, limit }
  | 'RATE_LIMIT' // data: { retryAfter } (seconds)
  | 'NOT_FOUND' // a task/thread this app didn't start, or forgotten (30 days)
  | 'GONE' // deleted in Slack, or the Manus task was deleted
  | 'NO_FILE'
  | 'NOT_HTML'
  | 'TOO_BIG'
  | 'WEBDEV'
  | 'EXTERNAL_FILE'
  | 'PARTIAL'
  | 'NETWORK' // a read failed: try again later
  | 'ERROR'
  | 'cancelled';

export class AgentError extends Error {
  constructor(
    message: string,
    readonly code: AgentErrorCode,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

const ARTIFACT_MESSAGE = 'Building and chatting with Manus or Viktor works in the self-hosted app.';

/** A short code that ends each request (Viktor: its last line; Manus: the end of the task title), so a read can find it. */
export function newRef(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  while (out.length < 6) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    // 252 = 7 × 36: drop the few bytes above it so every character is equally likely
    for (const b of bytes) if (b < 252 && out.length < 6) out += chars[b % 36];
  }
  return `ylb-${out}`;
}

// ───────────── one request ─────────────

const SETUP_CODES = new Set(['NO_PROVIDER', 'NOT_READY']);
const SAME_CODE = new Set(['NO_FILE', 'NOT_HTML', 'WEBDEV', 'EXTERNAL_FILE', 'PARTIAL']);
const UNCERTAIN = new Set(['SLACK_SEND_UNKNOWN', 'TIMEOUT', 'NETWORK', 'UPSTREAM', 'CUT_OFF']);

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

/**
 * What a failed answer from your server means for the app (the table in the spec §2.2). `write`: the
 * request may have sent something (a Manus task or message, a Slack post, a file handed to either).
 */
export function agentFailure(status: number, json: Record<string, unknown> | null, write: boolean): AgentError {
  const code = typeof json?.code === 'string' ? json.code : '';
  const message = typeof json?.error === 'string' && json.error.trim() ? json.error.trim() : `Your AI server answered ${status || 'nothing'}.`;
  const reason = typeof json?.reason === 'string' ? json.reason : '';
  if (code === 'TOO_LONG') return new AgentError(message, 'TOO_LONG', { chars: num(json?.chars), limit: num(json?.limit) });
  if (code === 'OWN_KEY_NEEDED') return new AgentError(message, 'SETUP', { reason: 'own_key_needed' });
  if ((status === 409 && SETUP_CODES.has(code)) || status === 501) return new AgentError(message, 'SETUP', { reason: reason || (code === 'NO_PROVIDER' ? 'not_ticked' : '') });
  if (status === 403 && (code === 'OWNER_ONLY' || code === 'FORBIDDEN')) return new AgentError(message, 'OWNER_ONLY');
  if (code === 'NOT_FOUND' && status === 404) return new AgentError(message, 'NOT_FOUND');
  if (code === 'GONE' && status === 410) return new AgentError(message, 'GONE');
  if (code === 'TOO_BIG' && status === 413) return new AgentError(message, 'TOO_BIG', { bytes: num(json?.bytes) });
  if (SAME_CODE.has(code)) return new AgentError(message, code as AgentErrorCode, typeof json?.filename === 'string' ? { filename: json.filename } : {});
  if (status === 429) return new AgentError(message, 'RATE_LIMIT', { retryAfter: num(json?.retryAfter) });
  if (write) {
    if (UNCERTAIN.has(code) || (status >= 500 && !json)) return new AgentError(message, 'SEND_UNKNOWN', { ref: json?.ref, sentAt: num(json?.sentAt) });
    if ((status >= 400 && status < 500) || code === 'SLACK_ERROR') return new AgentError(message, 'NOT_SENT', code === 'SLACK_ERROR' && typeof json?.slack === 'string' ? { slack: json.slack } : {});
  } else if (status >= 500) return new AgentError(message, 'NETWORK');
  return new AgentError(message, 'ERROR', code ? { cause: code } : {});
}

interface Req {
  path: string;
  /** JSON body (POST) */
  body?: unknown;
  /** raw bytes instead (the attach routes) */
  raw?: Blob;
  write: boolean;
  signal?: AbortSignal;
}

async function send(r: Req): Promise<Response> {
  if (__ARTIFACT_BUILD__) throw new AgentError(ARTIFACT_MESSAGE, 'SETUP', { reason: 'artifact' });
  const serverUrl = useStore.getState().settings.ai.serverUrl;
  let res: Response;
  try {
    res = await serverFetch(serverUrl, r.path, r.raw ? { method: 'POST', headers: { 'content-type': r.raw.type || 'application/octet-stream' }, body: r.raw, signal: r.signal } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r.body ?? {}), signal: r.signal });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError' || r.signal?.aborted) throw new AgentError('Stopped.', 'cancelled');
    // a write may have reached the server (and Manus or Slack) before the connection dropped
    if (r.write) throw new AgentError('The connection to your AI server dropped after your request left.', 'SEND_UNKNOWN');
    throw new AgentError('Couldn’t reach your AI server.', 'NETWORK');
  }
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    throw agentFailure(res.status, json && typeof json === 'object' ? json : null, r.write);
  }
  return res;
}

async function requestJson<T>(r: Req): Promise<T> {
  const res = await send(r);
  const json = (await res.json().catch(() => null)) as T | null;
  if (json && typeof json === 'object') return json;
  if (r.signal?.aborted) throw new AgentError('Stopped.', 'cancelled');
  if (r.write) throw new AgentError('Your AI server’s answer was cut off after your request left.', 'SEND_UNKNOWN');
  throw new AgentError('Your AI server’s answer couldn’t be read.', 'NETWORK');
}

async function requestBlob(r: Req): Promise<Blob> {
  const res = await send(r);
  try {
    return new Blob([await res.arrayBuffer()], { type: res.headers.get('x-file-type') || 'application/octet-stream' });
  } catch {
    if (r.signal?.aborted) throw new AgentError('Stopped.', 'cancelled');
    throw new AgentError('The file was cut off on the way. Try again.', 'NETWORK');
  }
}

// ───────────── the owner's images ─────────────

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

/**
 * Prepare each image (imagesForPublish: at most 1600 px and 900 KB, named img-N.jpg|png) and hand it to the
 * agent's service, one at a time: Manus's file upload, or Slack's (the file isn't shared anywhere until the
 * message that carries it is sent). Stops at the first failure with NOT_SENT: nothing visible was sent.
 */
export async function sendImages(via: AgentId, images: PromptImage[], signal?: AbortSignal): Promise<AgentFileRef[]> {
  if (__ARTIFACT_BUILD__) throw new AgentError(ARTIFACT_MESSAGE, 'SETUP', { reason: 'artifact' });
  const out: AgentFileRef[] = [];
  for (const [i, img] of images.entries()) {
    const n = imageKeyNumber(img.key) || i + 1;
    const fail = (why: string, cause = '') => new AgentError(`Couldn’t send image ${n} to ${agentName(via)}: ${lowerFirst(why.trim()) || 'it didn’t go through.'}`, 'NOT_SENT', { image: n, ...(cause ? { cause } : {}) });
    let prepared;
    try {
      [prepared] = await imagesForPublish([img], [img.key]);
    } catch (e) {
      throw fail((e as Error)?.message || 'its file couldn’t be loaded.');
    }
    if (!prepared) throw fail('its file couldn’t be loaded.');
    const blob = new Blob([bytesOf(prepared.data)], { type: prepared.mime });
    const note = (img.note ?? '').trim().slice(0, 1000);
    const path = via === 'manus' ? `/api/ai/manus/attach?filename=${encodeURIComponent(prepared.name)}` : `/api/ai/slack/attach?filename=${encodeURIComponent(prepared.name)}${note ? `&alt=${encodeURIComponent(note)}` : ''}`;
    try {
      const j = await requestJson<{ file_id?: string; filename?: string }>({ path, raw: blob, write: true, signal });
      if (!j.file_id) throw fail('your AI server didn’t say where the file went.');
      out.push({ id: j.file_id, filename: j.filename || prepared.name });
    } catch (e) {
      if (e instanceof AgentError && (e.code === 'cancelled' || e.code === 'NOT_SENT')) throw e;
      throw fail(e instanceof AgentError ? e.message : (e as Error)?.message || '', e instanceof AgentError ? e.code : '');
    }
  }
  return out;
}

// ───────────── Manus (/api/ai/manus/*) ─────────────

export type ManusStart = { ref: string; profile?: string; files?: AgentFileRef[] } & ({ fn: 'build'; build: BuildRequest } | { fn: 'agentchat'; chat: ChatRequest });
export type ManusSend = { taskId: string; files?: AgentFileRef[] } & (
  | { edit: { text: string; images: ImageNote[] } } // build: Ask for changes
  | { answer: string } // build: answer Manus's question
  | { followup: 'missing_file' } // build: the fixed "send page.html" follow-up
  | { chat: ChatRequest }
); // chat: the owner's words as typed

const manusFiles = (files: AgentFileRef[] | undefined) => (files ?? []).map((f) => ({ file_id: f.id, filename: f.filename }));

function manusStartBody(o: ManusStart, dryRun: boolean): Record<string, unknown> {
  return {
    fn: o.fn,
    ...(o.fn === 'build' ? { build: o.build } : { chat: o.chat }),
    ref: o.ref,
    ...(o.profile ? { profile: o.profile } : {}),
    ...(dryRun ? { dryRun: true } : { files: manusFiles(o.files) }),
  };
}

/** Start a build or a chat task (one-shot: never retried). */
export async function manusStart(o: ManusStart, signal?: AbortSignal): Promise<{ taskId: string; taskUrl: string }> {
  const j = await requestJson<{ task_id?: string; task_url?: string }>({ path: '/api/ai/manus/create', body: manusStartBody(o, false), write: true, signal });
  if (!j.task_id) throw new AgentError('Your AI server didn’t say which Manus task it started.', 'SEND_UNKNOWN');
  return { taskId: j.task_id, taskUrl: j.task_url || `https://manus.im/app/${j.task_id}` };
}

/** The exact message manusStart would send (a dry run: no task, no files). */
export async function manusPreview(o: ManusStart): Promise<AgentPreview> {
  const j = await requestJson<{ preview?: AgentPreview }>({ path: '/api/ai/manus/create', body: manusStartBody(o, true), write: false });
  if (!j.preview) throw new AgentError('Your AI server didn’t show the message.', 'ERROR');
  return j.preview;
}

/** A follow-up in the same task: a change, an answer, the fixed "send page.html" follow-up, or a chat message (one-shot). */
export async function manusSend(o: ManusSend, signal?: AbortSignal): Promise<void> {
  const what = 'edit' in o ? { edit: o.edit } : 'answer' in o ? { answer: o.answer } : 'followup' in o ? { followup: o.followup } : { chat: o.chat };
  await requestJson<{ ok?: boolean }>({ path: '/api/ai/manus/continue', body: { task_id: o.taskId, ...what, files: manusFiles(o.files) }, write: true, signal });
}

/** The task's state and its events (newest first; only the ones after `after` when given). */
export function manusRead(taskId: string, after?: string, signal?: AbortSignal): Promise<ManusRead> {
  return requestJson<ManusRead>({ path: '/api/ai/manus/messages', body: { task_id: taskId, ...(after ? { after } : {}) }, write: false, signal });
}

/** A page Manus made (no `at`: the latest round's page), as text. Never served as a page. */
export function manusHtml(taskId: string, at?: string, signal?: AbortSignal): Promise<AgentHtml & { at: string }> {
  return requestJson<AgentHtml & { at: string }>({ path: '/api/ai/manus/html', body: { task_id: taskId, ...(at ? { at } : {}) }, write: false, signal });
}

/** A file Manus attached ("<event id>:<index>"), as bytes (its type checked by the server). */
export function manusFile(taskId: string, at: string, signal?: AbortSignal): Promise<Blob> {
  return requestBlob({ path: '/api/ai/manus/file', body: { task_id: taskId, at }, write: false, signal });
}

/** Stop the task (free; a stopped task can be resumed by the next message). */
export async function manusStop(taskId: string): Promise<void> {
  await requestJson<{ ok?: boolean }>({ path: '/api/ai/manus/stop', body: { task_id: taskId }, write: false });
}

/** After an uncertain start: the task whose title ends with this Ref, started since `sentAt` (a read). */
export async function manusVerify(ref: string, sentAt: number): Promise<{ taskId: string; taskUrl: string } | null> {
  const j = await requestJson<{ found?: boolean; task_id?: string; task_url?: string }>({ path: '/api/ai/manus/verify', body: { ref, sent_at: sentAt }, write: false });
  return j.found && j.task_id ? { taskId: j.task_id, taskUrl: j.task_url || `https://manus.im/app/${j.task_id}` } : null;
}

// ───────────── Viktor (/api/ai/slack/*) ─────────────

export type ViktorSend = { ref: string; files?: AgentFileRef[] } & (
  | { kind: 'build'; build: BuildRequest }
  | { kind: 'edit'; threadId: string; edit: { text: string; images: ImageNote[] } }
  | { kind: 'answer'; threadId: string; text: string }
  | { kind: 'followup'; threadId: string; followup: 'missing_file' }
  | { kind: 'chat'; threadId?: string; chat: ChatRequest }
); // no threadId: a new thread

function viktorBody(o: ViktorSend, dryRun: boolean): Record<string, unknown> {
  const { files, ...rest } = o;
  // a file's title in Slack is its key (img-3), which the message names
  return { ...rest, ...(dryRun ? { dryRun: true } : { files: (files ?? []).map((f) => ({ file_id: f.id, title: f.filename.replace(/\.[a-z0-9]+$/i, '') })) }) };
}

interface SentAnswer {
  thread?: { id?: string; permalink?: string };
  message?: { ts?: string | null; located?: boolean };
  sentAt?: number;
}

const sentOf = (j: SentAnswer, fallbackAt: number): ViktorSent | null =>
  j.thread?.id ? { threadId: j.thread.id, permalink: j.thread.permalink || '', ts: j.message?.ts ?? null, located: !!j.message?.located, sentAt: num(j.sentAt) ?? fallbackAt } : null;

/** Post a request or a chat message to Viktor in Slack, as the owner (one-shot: never retried). */
export async function viktorSend(o: ViktorSend, signal?: AbortSignal): Promise<ViktorSent> {
  const at = Date.now();
  const j = await requestJson<SentAnswer>({ path: '/api/ai/slack/send', body: viktorBody(o, false), write: true, signal });
  const sent = sentOf(j, at);
  if (!sent) throw new AgentError('Your AI server didn’t say where the message went.', 'SEND_UNKNOWN', { ref: o.ref, sentAt: at });
  return sent;
}

/** The exact message viktorSend would post (a dry run: Slack isn't called). */
export async function viktorPreview(o: ViktorSend): Promise<AgentPreview> {
  const j = await requestJson<{ preview?: AgentPreview }>({ path: '/api/ai/slack/send', body: viktorBody(o, true), write: false });
  if (!j.preview) throw new AgentError('Your AI server didn’t show the message.', 'ERROR');
  return j.preview;
}

const ERROR_CODES = new Set<AgentErrorCode>(['SETUP', 'OWNER_ONLY', 'NOT_SENT', 'SEND_UNKNOWN', 'TOO_LONG', 'RATE_LIMIT', 'NOT_FOUND', 'GONE', 'NO_FILE', 'NOT_HTML', 'TOO_BIG', 'WEBDEV', 'EXTERNAL_FILE', 'PARTIAL', 'NETWORK', 'ERROR', 'cancelled']);

/** Read 1 to 6 threads with Viktor (the whole thread each time, so edits and deletions show). */
export async function viktorRead(threadIds: string[], signal?: AbortSignal): Promise<{ threads: ViktorRead[]; errors: Record<string, { code: AgentErrorCode; message: string }> }> {
  const ids = [...new Set(threadIds)].slice(0, 6);
  if (!ids.length) return { threads: [], errors: {} };
  const j = await requestJson<{ threads?: ViktorRead[]; errors?: Record<string, { code?: string; message?: string }> }>({ path: '/api/ai/slack/read', body: { threadIds: ids }, write: false, signal });
  const errors: Record<string, { code: AgentErrorCode; message: string }> = {};
  for (const [id, e] of Object.entries(j.errors ?? {})) errors[id] = { code: ERROR_CODES.has(e?.code as AgentErrorCode) ? (e.code as AgentErrorCode) : 'ERROR', message: typeof e?.message === 'string' ? e.message : '' };
  return { threads: Array.isArray(j.threads) ? j.threads : [], errors };
}

/** After an uncertain send: the owner's message ending with this Ref, posted since `sentAt` (a read). */
export async function viktorVerify(o: { ref: string; sentAt: number; threadId?: string }): Promise<ViktorSent | null> {
  const j = await requestJson<SentAnswer & { found?: boolean }>({ path: '/api/ai/slack/verify', body: o, write: false });
  return j.found ? sentOf(j, o.sentAt) : null;
}

/** A page in Viktor's reply: '<ts>' (a code block) or '<ts>:<file id>' (an attached .html file), as text. */
export function viktorHtml(threadId: string, at: string, signal?: AbortSignal): Promise<AgentHtml> {
  return requestJson<AgentHtml>({ path: '/api/ai/slack/html', body: { threadId, at }, write: false, signal });
}

/** A file Viktor attached ('<ts>:<file id>'), as bytes. */
export function viktorFile(threadId: string, at: string, signal?: AbortSignal): Promise<Blob> {
  return requestBlob({ path: '/api/ai/slack/file', body: { threadId, at }, write: false, signal });
}

// ───────────── what to tell the owner ─────────────

const sentence = (s: string) => {
  const t = s.trim().replace(/[.\s]+$/, '');
  return t ? `${t}.` : '';
};

/** Friendly copy for any failure above. settings: offer "Open Settings › AI keys". */
export function agentErrorText(e: unknown, via: AgentId): { title: string; body: string; settings: boolean } {
  const name = agentName(via);
  const service = via === 'manus' ? 'Manus' : 'Slack';
  if (!(e instanceof AgentError)) return { title: `Something went wrong with ${name}`, body: sentence((e as Error)?.message || '') || 'Please try again.', settings: false };
  const d = e.data;
  switch (e.code) {
    case 'SEND_UNKNOWN':
      return { title: 'May have been delivered', body: `May have been delivered. The connection dropped after your request left. Check ${via === 'manus' ? 'your Manus tasks' : 'Slack'} before sending it again, or it may go twice.`, settings: false };
    case 'NOT_SENT':
      return { title: 'Not sent', body: `Not sent: ${sentence(lowerFirst(e.message.replace(/^not sent:\s*/i, '')))}`, settings: false };
    case 'TOO_LONG': {
      const chars = num(d.chars);
      const limit = num(d.limit);
      const counts = chars !== undefined && limit !== undefined ? ` (${chars.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} characters)` : '';
      return { title: 'Too long', body: `Too long for one ${via === 'manus' ? 'Manus message' : 'Slack message'}${counts}. Shorten your words.`, settings: false };
    }
    case 'RATE_LIMIT': {
      const n = num(d.retryAfter);
      return { title: 'Slow down', body: n ? `${service} asked the app to slow down. Try again in ${Math.ceil(n)} seconds.` : 'Too many requests right now. Try again in a minute.', settings: false };
    }
    case 'NOT_FOUND':
      return { title: `${via === 'manus' ? 'Task' : 'Thread'} not found`, body: `This ${via === 'manus' ? 'task' : 'thread'} is older than 30 days, or wasn’t started by this app.`, settings: false };
    case 'GONE':
      return { title: 'Deleted', body: `It was deleted in ${service}.`, settings: false };
    case 'SETUP': {
      if (d.reason === 'artifact') return { title: `${name} isn’t available here`, body: ARTIFACT_MESSAGE, settings: false };
      const reason = typeof d.reason === 'string' && d.reason ? d.reason : '';
      // the server names which Manus power is off (Building pages & assets, or Chat with Manus)
      if (via === 'manus' && reason === 'not_ticked' && /power/.test(e.message)) return { title: `${name} isn’t set up`, body: sentence(e.message), settings: true };
      const live = agentReady(via, 'build');
      const text = (reason && readinessText(via, reason)) || live.text || sentence(e.message);
      return { title: `${name} isn’t set up`, body: text, settings: true };
    }
    case 'OWNER_ONLY':
      return { title: 'Only the owner', body: sentence(e.message) || readinessText(via, 'owner_only'), settings: false };
    case 'cancelled':
      return { title: 'Stopped', body: 'Stopped.', settings: false };
    case 'NETWORK':
      return { title: 'Couldn’t check', body: `${sentence(e.message) || 'Couldn’t reach your AI server.'} Try again in a moment.`, settings: false };
    default:
      return { title: `${name}: something went wrong`, body: sentence(e.message) || 'Please try again.', settings: false };
  }
}
