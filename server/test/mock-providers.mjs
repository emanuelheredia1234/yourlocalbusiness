// A stand-in for every AI provider's API, for tests and offline QA. Each provider lives under its
// own path prefix (http://127.0.0.1:PORT/<id>/…). Reasoning tokens grow with the effort sent, so a
// test can see effort travel from the settings to the request and back into the usage.
//
//   node server/test/mock-providers.mjs [port]   → prints the AI_PROVIDER_BASE_URLS value to use

import http from 'node:http';
import { fileURLToPath } from 'node:url';

// 1×1 PNG, and the start of an MP4 (an `ftyp` box) padded to look like a file
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
export const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(4000, 7)]);

const EFFORT_TOKENS = { none: 0, minimal: 40, low: 120, medium: 480, high: 1900, xhigh: 4800, max: 9600 };
export const reasoningFor = (effort) => EFFORT_TOKENS[effort] ?? 300;

const ANSWER = JSON.stringify({ ok: true, note: 'mock answer' });

export function createMockProviders({ keys = {} } = {}) {
  const calls = [];
  const behavior = {}; // provider id → 'fail500' | 'policy' | 'auth' | 'rate' | undefined
  const videoPolls = new Map();
  const manusTasks = new Map();
  let server;
  let base = '';

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  function failFor(id, res) {
    const b = behavior[id];
    if (!b) return false;
    if (b === 'fail500') json(res, 500, { error: { message: 'mock outage' } });
    else if (b === 'policy') json(res, 400, { error: { code: 'content_policy_violation', message: 'Blocked by the safety system' } });
    else if (b === 'auth') json(res, 401, { error: { message: 'Incorrect API key provided: sk-abc123****wxyz' } });
    else if (b === 'rate') json(res, 429, { error: { message: 'slow down' } });
    else if (b === 'credits') json(res, 402, { error: { message: 'Insufficient credits' } });
    else return false;
    return true;
  }

  function sse(res, events) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  }

  function handle(req, res, raw) {
    const url = new URL(req.url, 'http://mock');
    const [, id, ...rest] = url.pathname.split('/');
    const p = `/${rest.join('/')}`;
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const auth = req.headers.authorization || req.headers['x-api-key'] || req.headers['x-goog-api-key'] || req.headers['x-manus-api-key'] || '';
    calls.push({ provider: id, method: req.method, path: p, query: Object.fromEntries(url.searchParams), headers: req.headers, body });

    // downloads (no key needed, like signed links)
    if (id === 'files') {
      if (p.endsWith('.mp4')) {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': MP4.length });
        return res.end(MP4);
      }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
      return res.end(req.method === 'HEAD' ? undefined : PNG);
    }
    const want = keys[id];
    if (want && !String(auth).includes(want)) return json(res, 401, { error: { message: 'Invalid API key' } });
    if (failFor(id, res)) return;

    // ── Anthropic (streamed Messages API) ──
    if (id === 'anthropic' && p === '/v1/messages') {
      const effort = body?.output_config?.effort;
      const out = 150 + reasoningFor(effort);
      return sse(res, [
        { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 200, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: out } },
        { type: 'message_stop' },
      ]);
    }
    if (id === 'anthropic' && p === '/v1/models') return json(res, 200, { data: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }], has_more: false });

    // ── OpenAI ──
    if (id === 'openai' && p === '/responses') {
      const r = reasoningFor(body?.reasoning?.effort);
      return json(res, 200, {
        id: 'resp_mock',
        model: body.model,
        status: 'completed',
        output: [
          { type: 'reasoning', summary: [] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ANSWER }] },
        ],
        usage: { input_tokens: 200, output_tokens: 150 + r, output_tokens_details: { reasoning_tokens: r } },
      });
    }
    if (id === 'openai' && p === '/images/generations') {
      const out = { low: 272, medium: 1056, high: 4160, xhigh: 8000, max: 12000 }[body?.quality] ?? 1000;
      return json(res, 200, { data: [{ b64_json: PNG.toString('base64') }], usage: { input_tokens: 40, output_tokens: out, input_tokens_details: { text_tokens: 40, image_tokens: 0 } } });
    }
    if (id === 'openai' && p === '/models') return json(res, 200, { data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-image-2.5-flare' }, { id: 'gpt-6-luna' }] });

    // ── Google (Interactions API) ──
    if (id === 'google' && p === '/interactions') {
      const rf = body?.response_format;
      if (rf?.type === 'image') {
        const out = { '1K': 1120, '2K': 1680, '4K': 2520 }[rf.image_size] ?? 1120;
        return json(res, 200, { id: 'int_img', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: PNG.toString('base64') }] }], usage: { total_input_tokens: 30, total_output_tokens: out, total_tokens: 30 + out } });
      }
      if (rf?.type === 'video') return json(res, 200, { id: 'int_vid', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: MP4.toString('base64') }] }], usage: { total_input_tokens: 30, total_output_tokens: 9000 } });
      const t = reasoningFor(body?.generation_config?.thinking_level);
      return json(res, 200, { id: 'int_txt', status: 'completed', steps: [{ type: 'thought' }, { type: 'model_output', content: [{ type: 'text', text: ANSWER }] }], usage: { total_input_tokens: 200, total_output_tokens: 150, total_thought_tokens: t, total_tokens: 350 + t } });
    }
    if (id === 'google' && p === '/models') return json(res, 200, { models: [{ name: 'models/gemini-3.8-flash' }, { name: 'models/gemini-nano-banana-2.1' }, { name: 'models/gemini-omni-1.1-flash' }] });

    // ── Chat Completions: xAI (reasoning beside completion), Meta, OpenRouter (reasoning inside) ──
    if ((id === 'xai' || id === 'meta' || id === 'openrouter') && p === '/chat/completions') {
      if (body?.modalities?.includes('image')) {
        return json(res, 200, { choices: [{ message: { role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } }] } }], usage: { prompt_tokens: 20, completion_tokens: 1300, cost: 0.039 } });
      }
      const effort = id === 'openrouter' ? body?.reasoning?.effort : body?.reasoning_effort;
      const r = reasoningFor(effort);
      const usage =
        id === 'xai'
          ? { prompt_tokens: 200, completion_tokens: 150, completion_tokens_details: { reasoning_tokens: r }, total_tokens: 350 + r }
          : { prompt_tokens: 200, completion_tokens: 150 + r, completion_tokens_details: { reasoning_tokens: r }, total_tokens: 350 + r, ...(id === 'openrouter' ? { cost: Math.round((200 * 0.8 + (150 + r) * 4) / 1000) / 1000 } : {}) };
      return json(res, 200, { id: 'chat_mock', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }], usage });
    }
    if ((id === 'xai' || id === 'meta' || id === 'openrouter') && p === '/models') {
      return json(res, 200, { data: [{ id: id === 'xai' ? 'grok-4.6' : id === 'meta' ? 'muse-spark-1.3' : 'google/gemini-3.8-flash', architecture: { output_modalities: ['text'] } }, { id: 'extra-model-1', architecture: { output_modalities: ['text'] } }] });
    }
    if ((id === 'xai' || id === 'meta') && p === '/images/generations') {
      return json(res, 200, { data: [{ b64_json: PNG.toString('base64') }], ...(id === 'meta' ? { usage: { credits: 0.011 } } : {}) });
    }

    // ── OpenRouter media ──
    if (id === 'openrouter' && p === '/images') return json(res, 200, { data: [{ b64_json: PNG.toString('base64') }], usage: { cost: 0.01 } });
    if (id === 'openrouter' && p === '/videos' && req.method === 'POST') {
      videoPolls.set('or_job_1', 0);
      return json(res, 200, { id: 'or_job_1', polling_url: `${base}/openrouter/videos/or_job_1`, status: 'pending' });
    }
    if (id === 'openrouter' && /^\/videos\/[\w-]+$/.test(p)) {
      const jobId = p.split('/').pop();
      const n = (videoPolls.get(jobId) ?? 0) + 1;
      videoPolls.set(jobId, n);
      if (n < 2) return json(res, 200, { id: jobId, status: 'in_progress' });
      return json(res, 200, { id: jobId, status: 'completed', unsigned_urls: [`${base}/files/or_video.mp4`], usage: { cost: 0.16 } });
    }
    if (id === 'openrouter' && p === '/videos/models') return json(res, 200, { data: [{ id: 'heygen/heygen-video-1' }] });

    // ── xAI video ──
    if (id === 'xai' && p === '/videos/generations') {
      videoPolls.set('xai_req_1', 0);
      return json(res, 200, { request_id: 'xai_req_1' });
    }
    if (id === 'xai' && /^\/videos\/[\w-]+$/.test(p)) {
      const reqId = p.split('/').pop();
      const n = (videoPolls.get(reqId) ?? 0) + 1;
      videoPolls.set(reqId, n);
      if (n < 2) return json(res, 200, { status: 'pending' });
      return json(res, 200, { status: 'done', video: { url: `${base}/files/xai_video.mp4`, duration: 8 }, model: 'grok-imagine-video-1.5' });
    }

    // ── Manus ──
    if (id === 'manus' && p === '/v2/task.create') {
      const taskId = `task${String(manusTasks.size + 1).padStart(6, '0')}`;
      manusTasks.set(taskId, { polls: 0, profile: body?.agent_profile, followUps: [] });
      return json(res, 200, { ok: true, request_id: 'r1', task_id: taskId, task_title: body?.title || 'Mock task', task_url: `https://manus.im/app/${taskId}` });
    }
    if (id === 'manus' && p === '/v2/task.detail') {
      const t = manusTasks.get(url.searchParams.get('task_id'));
      if (!t) return json(res, 404, { ok: false, error: { code: 'not_found', message: 'task not found' } });
      t.polls += 1;
      const done = t.polls >= 2;
      return json(res, 200, { ok: true, task: { id: url.searchParams.get('task_id'), status: done ? 'stopped' : 'running', title: 'Mock task', task_url: `https://manus.im/app/${url.searchParams.get('task_id')}`, ...(done ? { credit_usage: t.profile === 'lite' ? 12 : 41 } : {}) } });
    }
    if (id === 'manus' && p === '/v2/task.listMessages') {
      const t = manusTasks.get(url.searchParams.get('task_id'));
      const done = t && t.polls >= 2;
      return json(res, 200, {
        ok: true,
        messages: done
          ? [
              { id: 'e3', type: 'status_update', status_update: { agent_status: 'stopped' } },
              { id: 'e2', type: 'assistant_message', assistant_message: { content: 'Here is your image.\nRESULT: SCHEDULED | Mock Page | Monday 9:00 AM', attachments: [{ type: 'image', filename: 'photo.png', url: `${base}/files/photo.png`, content_type: 'image/png' }] } },
              { id: 'e1', type: 'user_message', user_message: { content: 'make it' } },
            ]
          : [{ id: 'e1', type: 'user_message', user_message: { content: 'make it' } }],
      });
    }
    if (id === 'manus' && p === '/v2/task.sendMessage') return json(res, 200, { ok: true });
    if (id === 'manus' && p === '/v2/task.list') return json(res, 200, { ok: true, data: [] });

    return json(res, 404, { error: { message: `mock: no route for ${id} ${p}` } });
  }

  return {
    calls,
    behavior,
    get base() {
      return base;
    },
    /** AI_PROVIDER_BASE_URLS for this mock. */
    baseUrls() {
      return {
        anthropic: `${base}/anthropic`,
        openai: `${base}/openai`,
        google: `${base}/google`,
        xai: `${base}/xai`,
        meta: `${base}/meta`,
        openrouter: `${base}/openrouter`,
        manus: `${base}/manus`,
      };
    },
    last(provider, path) {
      return [...calls].reverse().find((c) => c.provider === provider && (!path || c.path === path));
    },
    reset() {
      calls.length = 0;
      for (const k of Object.keys(behavior)) delete behavior[k];
    },
    async start(port = 0) {
      server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => handle(req, res, raw));
      });
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
      return this;
    },
    close() {
      return new Promise((r) => server.close(r));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await createMockProviders().start(Number(process.argv[2] || 0));
  console.log(JSON.stringify(mock.baseUrls()));
}
