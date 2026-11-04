// What a Manus task's events mean for the app (src/lib/agentTypes.ts ManusRead): its replies for the
// assistant chat, and for a build task, its latest round (built, needs you, failed, no file). Manus's
// words are untrusted: they're cut, links to Manus's own files and sites are reduced to their names, and
// no address or file URL ever goes to the browser (files are fetched by the server, by event and index).
// Pure: no I/O.

import { codePlaceholders, extractHtml, fileKind, isHtmlFile } from './html.mjs';

const TEXT_MAX = 8000;
const ANSWER_HERE = new Set(['messageAskUser', 'cascadeAskUser']);
const KEPT = new Set(['user_message', 'assistant_message', 'error_message']);
const DELIVERY = new Set(['opening', 'progress', 'result']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

const cut = (s, max) => {
  const t = String(s ?? '');
  if (t.length <= max) return t;
  return `${t.slice(0, max).replace(/[\uD800-\uDBFF]$/, '')}…`;
};

/** An event's text: Manus sends a string (or, for a message the app sent, text parts). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? String(c.text ?? '') : '')).filter(Boolean).join('\n');
  return '';
}

/**
 * Manus's Markdown, made safe to show: image embeds go, links to anything but http(s) (sandbox paths,
 * manus-webdev://) become their label. webdev: it linked a website Manus made in its own account.
 */
export function cleanManusText(raw) {
  let webdev = /manus-webdev:\/\//i.test(raw);
  let t = String(raw ?? '').replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '');
  t = t.replace(/\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g, (m, label, target) => (/^https?:\/\//i.test(target) ? m : label));
  // a bare manus-webdev:// address left in the text
  t = t.replace(/manus-webdev:\/\/\S*/gi, () => {
    webdev = true;
    return 'a website in Manus';
  });
  return { text: t, webdev };
}

const fileMeta = (a, id, i) => {
  const name = String(a?.filename || `file-${i + 1}`).slice(0, 160);
  const mime = typeof a?.content_type === 'string' && a.content_type ? a.content_type.slice(0, 100) : undefined;
  return { id, name, kind: fileKind(a), ...(mime ? { mime } : {}) };
};

/** One event for the browser (user, assistant or error), without any address. */
export function normalizeEvent(e) {
  const id = String(e?.id ?? '');
  const at = num(e?.timestamp) ?? 0;
  if (e?.type === 'user_message') {
    const u = e.user_message ?? {};
    const attachments = Array.isArray(u.attachments) ? u.attachments : [];
    return { id, type: 'user', at, text: cut(contentText(u.content), TEXT_MAX), files: attachments.map((a, i) => fileMeta(a, `${id}:${i}`, i)) };
  }
  if (e?.type === 'error_message') return { id, type: 'error', at, text: cut(String(e.error_message?.content ?? 'Manus reported an error.'), TEXT_MAX), files: [] };
  const a = e?.assistant_message ?? {};
  const { text } = cleanManusText(contentText(a.content));
  const attachments = Array.isArray(a.attachments) ? a.attachments : [];
  const files = attachments.map((x, i) => fileMeta(x, `${id}:${i}`, i));
  const page = extractHtml({ text, slack: false });
  if (page) files.push({ id: `${id}:code`, name: 'page.html', kind: 'html', bytes: page.bytes });
  const options = Array.isArray(a.question_expectation?.options) ? a.question_expectation.options.filter((o) => typeof o === 'string' && o.trim()).slice(0, 10).map((o) => cut(o.trim(), 200)) : [];
  return {
    id,
    type: 'assistant',
    at,
    text: cut(codePlaceholders(text), TEXT_MAX),
    ...(DELIVERY.has(a.delivery_kind) ? { deliveryKind: a.delivery_kind } : {}),
    files,
    ...(options.length ? { options } : {}),
  };
}

/** The newest RESULT line in a text: { kind: 'BUILT' | 'FAILED', detail } (Markdown around it tolerated), or null. */
export function lastResult(text) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^[\s>*_`#-]*RESULT\s*:\s*\**\s*(BUILT|FAILED)\b\**\s*\|?\s*(.*?)[\s*_`]*$/i.exec(lines[i]);
    if (m) return { kind: m[1].toUpperCase(), detail: m[2].trim().slice(0, 300) };
  }
  return null;
}

/** The events of the latest round: the ones after the newest message the app sent (events are newest first). */
export function latestRound(events) {
  const list = Array.isArray(events) ? events : [];
  const u = list.findIndex((e) => e?.type === 'user_message');
  return u >= 0 ? list.slice(0, u) : list;
}

/**
 * The page in a build's latest round: the newest .html attachment (the newest version first), else the first
 * fenced HTML document in the round's assistant text. { at, filename, bytes, source } or null.
 */
export function roundPage(round) {
  for (const e of round) {
    if (e?.type !== 'assistant_message') continue;
    const attachments = Array.isArray(e.assistant_message?.attachments) ? e.assistant_message.attachments : [];
    // several .html files in one message: page.html first, then the last one
    const html = attachments.map((a, i) => ({ a, i })).filter(({ a }) => isHtmlFile(a));
    if (html.length) {
      const pick = html.find(({ a }) => /^page\.html?$/i.test(String(a.filename ?? ''))) ?? html[html.length - 1];
      return { at: `${e.id}:${pick.i}`, filename: String(pick.a.filename || 'page.html').slice(0, 160), bytes: 0, source: 'file' };
    }
  }
  for (const e of round) {
    if (e?.type !== 'assistant_message') continue;
    const page = extractHtml({ text: cleanManusText(contentText(e.assistant_message?.content)).text, slack: false });
    if (page?.complete) return { at: `${e.id}:code`, filename: 'page.html', bytes: page.bytes, source: 'code' };
  }
  return null;
}

/** A build task's latest round, worked out on the server (spec §5.5). */
export function buildRound(task, events) {
  const status = String(task?.status ?? '');
  const background = task?.has_running_background_jobs === true;
  const round = latestRound(events);
  const said = round.filter((e) => e?.type === 'assistant_message').map((e) => contentText(e.assistant_message?.content));
  if (status === 'running' || background) return { state: 'working', reason: background ? 'Manus is still finishing in the background.' : '', result: null };
  if (status === 'waiting') {
    const s = (Array.isArray(events) ? events : []).find((e) => e?.type === 'status_update')?.status_update;
    const text = String(s?.status_detail?.waiting_description ?? '').trim();
    return { state: 'needs_you', reason: cut(text || 'Manus is waiting for you.', 600), result: null };
  }
  if (status === 'error') {
    const err = round.find((e) => e?.type === 'error_message') ?? (Array.isArray(events) ? events : []).find((e) => e?.type === 'error_message');
    return { state: 'failed', reason: cut(String(err?.error_message?.content || 'Manus reported an error.'), 600), result: null };
  }
  if (status === 'deleted') return { state: 'failed', reason: 'The Manus task was deleted.', result: null };
  if (status !== 'stopped') return { state: 'working', reason: '', result: null };
  const page = roundPage(round);
  if (page) return { state: 'built', reason: '', result: page };
  // newest message first: its last RESULT line counts
  for (const t of said) {
    const r = lastResult(t);
    if (r?.kind === 'FAILED') return { state: 'failed', reason: cut(r.detail || 'Manus couldn’t build the page.', 600), result: null };
    if (r) break;
  }
  if (said.some((t) => /manus-webdev:\/\//i.test(t))) return { state: 'failed', reason: 'Manus made a website in its own Manus account instead of a file.', result: null };
  const other = round.flatMap((e) => (e?.type === 'assistant_message' && Array.isArray(e.assistant_message?.attachments) ? e.assistant_message.attachments : [])).find((a) => a && !isHtmlFile(a));
  if (other) return { state: 'no_file', reason: `Manus sent ${String(other.filename || 'a file').slice(0, 120)}, not one HTML file.`, result: null };
  return { state: 'no_file', reason: 'Manus finished without page.html.', result: null };
}

/**
 * The task as the browser sees it (ManusRead). events: task.listMessages, newest first. after: only events
 * newer than this id (all of them, truncated, when it isn't in the list).
 */
export function readManus(task, events, { taskId = '', after = '', hasMore = false, build = false } = {}) {
  const list = Array.isArray(events) ? events : [];
  const status = String(task?.status ?? '');
  const statusUpdate = list.find((e) => e?.type === 'status_update')?.status_update;
  const detail = statusUpdate?.agent_status === 'waiting' ? (statusUpdate.status_detail ?? {}) : {};
  const type = String(detail.waiting_for_event_type ?? '');
  const waiting = status === 'waiting' ? { type, text: cut(String(detail.waiting_description ?? ''), 600), answerHere: ANSWER_HERE.has(type) } : null;
  let newer = list;
  let truncated = false;
  if (after) {
    const i = list.findIndex((e) => e?.id === after);
    if (i >= 0) newer = list.slice(0, i);
    else truncated = true;
  } else truncated = !!hasMore;
  const out = {
    status,
    waiting,
    background: task?.has_running_background_jobs === true,
    credits: num(task?.credit_usage) ?? 0,
    taskUrl: String(task?.task_url || (taskId ? `https://manus.im/app/${taskId}` : '')),
    events: newer.filter((e) => KEPT.has(e?.type)).map(normalizeEvent),
    truncated,
    webdev: list.some((e) => e?.type === 'assistant_message' && /manus-webdev:\/\//i.test(contentText(e.assistant_message?.content))),
  };
  if (build) out.build = buildRound(task, list);
  return out;
}

/** "e12:0" → { eventId: 'e12', part: 0 }; "e12:code" → { eventId: 'e12', part: 'code' }; null when it isn't one. */
export function parseAt(at) {
  const m = /^([A-Za-z0-9_-]{1,128}):(code|\d{1,3})$/.exec(String(at ?? ''));
  if (!m) return null;
  return { eventId: m[1], part: m[2] === 'code' ? 'code' : Number(m[2]) };
}
