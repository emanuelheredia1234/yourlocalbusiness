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

  /**
   * Hand Manus a file (a video, or anything over the 20 MB inline limit) for a task: a file record,
   * then the bytes straight to its upload address (good for 3 minutes; S3 needs the exact length),
   * then wait until Manus has it. `body` is a web ReadableStream or bytes. Returns its file_id.
   */
  async uploadFile(ctx, { filename, size, body, signal }) {
    const rec = await call(ctx, '/v2/file.upload', { method: 'POST', body: { filename: String(filename).slice(0, 120) }, signal });
    const fileId = String(rec.file?.id ?? '');
    const uploadUrl = String(rec.upload_url ?? '');
    if (!fileId || !uploadUrl) throw new ProviderError('UPSTREAM', 'Manus didn’t return an upload address for the file.', { provider: ctx.label });
    let put;
    try {
      put = await ctx.fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-length': String(size) },
        body,
        duplex: 'half',
        // a presigned PUT never redirects; allowing it would make fetch keep the whole body in memory
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(15 * 60_000), ...(signal ? [signal] : [])]),
      });
    } catch (e) {
      throw new ProviderError('NETWORK', `Couldn’t send the file to Manus (${e?.message || 'network error'}).`, { provider: ctx.label });
    }
    if (!put.ok) throw new ProviderError('UPSTREAM', `Manus didn’t accept the file (${put.status}).`, { provider: ctx.label });
    for (let i = 0; i < 20; i++) {
      const d = await call(ctx, `/v2/file.detail?file_id=${encodeURIComponent(fileId)}`, { signal });
      const status = String(d.file?.status ?? '');
      if (status === 'uploaded') return { file_id: fileId, filename: String(filename) };
      if (status === 'error' || status === 'deleted') throw new ProviderError('UPSTREAM', 'Manus couldn’t store the file. Try again.', { provider: ctx.label });
      await new Promise((r) => setTimeout(r, Math.min(3000, 500 + i * 250)));
    }
    throw new ProviderError('UPSTREAM', 'Manus is still processing the file. Try again in a minute.', { provider: ctx.label });
  },

  /**
   * Start a task (a paid, one-shot write: never retried). `files`: [{ file_id, filename }] from uploadFile.
   * structuredOutputSchema: Manus fills it in when the task ends (structured_output in output());
   * clearConnectors: the task runs without the account's connected apps (Gmail and so on).
   */
  async create(ctx, { prompt, title, profile, interactive, hidden, image, files = [], structuredOutputSchema = null, clearConnectors = false, signal }) {
    const file = image ? parseDataUrl(image.dataUrl) : null;
    const parts = [
      ...(file ? [{ type: 'file', file_data: `data:${file.mime};base64,${file.base64}`, filename: image.filename || 'image.jpg', mime_type: file.mime }] : []),
      ...files.map((f) => ({ type: 'file', file_id: f.file_id, filename: f.filename })),
    ];
    const content = parts.length ? [{ type: 'text', text: prompt }, ...parts] : prompt;
    const body = { message: { content }, agent_profile: profile || 'standard', interactive_mode: !!interactive, hide_in_task_list: !!hidden };
    if (title) body.title = String(title).slice(0, 120);
    if (structuredOutputSchema) body.structured_output_schema = structuredOutputSchema;
    if (clearConnectors) body.clear_connectors = true;
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
      // what Manus filled in for a task created with a structured_output_schema (the router reads it; never sent to the app)
      structured_output: events.find((e) => e?.type === 'structured_output_result')?.structured_output_result ?? null,
    };
  },

  /** A free check that the key works. */
  async check(ctx, { signal } = {}) {
    await call(ctx, '/v2/task.list?limit=1', { signal });
    return true;
  },
};
