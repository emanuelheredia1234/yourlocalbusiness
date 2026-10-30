// Manus (API v2): an agent with its own browser. Effort is the task's `agent_profile`.
// Answers use the same shapes as the app's Zapier Manus actions, so one client flow serves both.

import { ProviderError, downloadBytes, errorFromResponse, num, parseDataUrl, requestJson } from '../http.mjs';

const headers = (key) => ({ 'x-manus-api-key': key });

async function call(ctx, path, { method = 'GET', body, signal, timeoutMs = 30_000 } = {}) {
  const r = await requestJson(ctx.fetch, `${ctx.base}${path}`, { method, headers: headers(ctx.key), body, timeoutMs, signal, label: ctx.label });
  if (!r.ok || r.payload?.ok === false) throw errorFromResponse(r.ok ? 400 : r.status, r.payload, ctx.label);
  return r.payload ?? {};
}

const imageCache = new Map(); // attachment url → { bytes, type } for a few minutes

async function attachmentSize(ctx, url, signal) {
  const hit = imageCache.get(url);
  if (hit) return hit.bytes.length;
  try {
    const r = await ctx.fetch(url, { method: 'HEAD', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) });
    const n = Number(r.headers.get('content-length') || 0);
    if (r.ok && n > 0) return n;
  } catch {
    /* fall back to downloading */
  }
  return (await attachmentBytes(ctx, url, signal)).bytes.length;
}

async function attachmentBytes(ctx, url, signal) {
  const hit = imageCache.get(url);
  if (hit) return hit;
  const got = await downloadBytes(ctx.fetch, url, { maxBytes: 40_000_000, signal, label: ctx.label, timeoutMs: 120_000 });
  imageCache.set(url, got);
  setTimeout(() => imageCache.delete(url), 10 * 60_000).unref?.();
  if (imageCache.size > 6) imageCache.delete(imageCache.keys().next().value);
  return got;
}

const isImage = (a) => a && (a.type === 'image' || /^image\//.test(String(a.content_type || '')) || /\.(png|jpe?g|webp|gif)$/i.test(String(a.filename || '')));

export default {
  base: 'https://api.manus.ai',

  /** Start a task (a paid, one-shot write: never retried). */
  async create(ctx, { prompt, title, profile, interactive, hidden, image, signal }) {
    const file = image ? parseDataUrl(image.dataUrl) : null;
    const content = file ? [{ type: 'text', text: prompt }, { type: 'file', file_data: `data:${file.mime};base64,${file.base64}`, filename: image.filename || 'image.jpg', mime_type: file.mime }] : prompt;
    const body = { message: { content }, agent_profile: profile || 'standard', interactive_mode: !!interactive, hide_in_task_list: !!hidden };
    if (title) body.title = String(title).slice(0, 120);
    const p = await call(ctx, '/v2/task.create', { method: 'POST', body, signal, timeoutMs: 60_000 });
    const taskId = String(p.task_id ?? '');
    if (!taskId) throw new ProviderError('UPSTREAM', 'Manus didn’t return a task.', { provider: ctx.label });
    return { ok: true, task_id: taskId, task_url: p.task_url || `https://manus.im/app/${taskId}`, task_title: p.task_title || title || '' };
  },

  /** A follow-up message to a task (one-shot write: never retried). */
  async send(ctx, { taskId, prompt, profile, signal }) {
    const body = { task_id: taskId, message: { content: prompt } };
    if (profile) body.agent_profile = profile;
    await call(ctx, '/v2/task.sendMessage', { method: 'POST', body, signal, timeoutMs: 60_000 });
    return { ok: true };
  },

  /**
   * The task's state, latest answer and image attachments (newest first). Images up to `maxImages`
   * come back as base64 when they're at most `maxImageBytes`; the rest only report their size.
   */
  async output(ctx, { taskId, maxImages = 0, maxImageBytes = 15_000_000, signal }) {
    const [detail, list] = await Promise.all([
      call(ctx, `/v2/task.detail?task_id=${encodeURIComponent(taskId)}`, { signal }),
      call(ctx, `/v2/task.listMessages?task_id=${encodeURIComponent(taskId)}&order=desc&limit=100`, { signal }),
    ]);
    const task = detail.task ?? {};
    const status = String(task.status ?? '');
    const events = Array.isArray(list.messages) ? list.messages : [];
    const answer = events.find((e) => e?.type === 'assistant_message' && typeof e.assistant_message?.content === 'string');
    const waitingEvent = events.find((e) => e?.type === 'status_update');
    const statusDetail = waitingEvent?.status_update?.agent_status === 'waiting' ? waitingEvent.status_update.status_detail ?? {} : {};
    const errorEvent = events.find((e) => e?.type === 'error_message');
    const attachments = events.flatMap((e) => (e?.type === 'assistant_message' && Array.isArray(e.assistant_message?.attachments) ? e.assistant_message.attachments : [])).filter((a) => isImage(a) && typeof a.url === 'string');

    const images = [];
    for (const [i, a] of attachments.slice(0, Math.max(maxImages, 0)).entries()) {
      const item = { filename: String(a.filename || `image-${i + 1}`), content_type: String(a.content_type || ''), base64: '', size_bytes: 0, note: '' };
      try {
        item.size_bytes = await attachmentSize(ctx, a.url, signal);
        if (item.size_bytes <= maxImageBytes) {
          const got = await attachmentBytes(ctx, a.url, signal);
          item.base64 = got.bytes.toString('base64');
          item.content_type = item.content_type || got.contentType;
        } else item.note = `Image too large: ${item.size_bytes} bytes`;
      } catch (e) {
        item.note = e?.message || 'Couldn’t download this image.';
      }
      images.push(item);
    }
    const credits = num(task.credit_usage);
    return {
      task_id: taskId,
      status,
      agent_status: String(waitingEvent?.status_update?.agent_status ?? ''),
      done: status === 'stopped' || status === 'error' || status === 'deleted',
      waiting: status === 'waiting',
      waiting_type: String(statusDetail.waiting_for_event_type ?? ''),
      waiting_description: String(statusDetail.waiting_description ?? ''),
      error: status === 'error' ? String(errorEvent?.error_message?.content ?? 'Manus reported an error.') : '',
      title: String(task.title ?? ''),
      task_url: String(task.task_url || `https://manus.im/app/${taskId}`),
      credit_usage: credits ?? 0,
      text: String(answer?.assistant_message?.content ?? ''),
      image_count: attachments.length,
      images,
    };
  },

  /** A free check that the key works. */
  async check(ctx, { signal } = {}) {
    await call(ctx, '/v2/task.list?limit=1', { signal });
    return true;
  },
};
