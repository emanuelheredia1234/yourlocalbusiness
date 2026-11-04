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

/**
 * Scripted answers for browser QA: a marker in the owner's words picks one; anything else gets ANSWER (a
 * stub the app's merges ignore, so the built-in engine's result stands).
 */
const SCRIPTED = [
  // SEO page → Edit with AI: a change the app can apply (and undo)
  ['qa-dark-look', JSON.stringify({ theme: { font: 'sans', mode: 'dark', radius: 'soft' }, summary: 'Switched the page to a dark look.' })],
];
// ───────────── the in-app assistant (src/ai/assistant) ─────────────
// Its prompts start with this marker and use these section titles (src/ai/assistant/protocol.ts).
export const ASSISTANT_MARKER = '[ylb-assistant-protocol v1]';

/** A section of an assistant prompt, by its title ('' when missing). */
function promptSection(prompt, title) {
  const head = `\n## ${title}\n`;
  const at = prompt.indexOf(head);
  if (at < 0) return '';
  const rest = prompt.slice(at + head.length);
  const end = rest.search(/\n## /);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/** The assistant prompt in a request body (the provider's shape doesn't matter), or null. */
function assistantPromptIn(value, depth = 0) {
  if (typeof value === 'string') return value.includes(ASSISTANT_MARKER) ? value : null;
  if (!value || typeof value !== 'object' || depth > 6) return null;
  for (const v of Object.values(value)) {
    const found = assistantPromptIn(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Scripted steps for browser QA, by the owner's latest message:
 *   "calendar"   → step 1: navigate to the calendar + list_posts {due: true}; step 2: done, with the due count
 *   "qa-confirm" → make_video for a post (P-media: a confirm card first); then done, saying what happened
 *   "qa-delete"  → delete_posts for one real post from the prompt (D: a danger confirm first); then done
 *   anything else → a short done answer
 * Until a tool exists, the app answers it with an unknown-tool error, and the next step says so.
 */
export function mockAssistantReply(prompt) {
  const message = promptSection(prompt, 'Latest message from the owner');
  let results = [];
  try {
    results = JSON.parse(promptSection(prompt, 'Tool results so far this turn (JSON)') || '[]');
  } catch {
    results = [];
  }
  const postId = /"id":"(post_[A-Za-z0-9_-]+)"/.exec(promptSection(prompt, 'Workspace (JSON)'))?.[1] ?? '';
  const step = (reply, actions = []) => JSON.stringify({ reply, actions, done: actions.length === 0 });
  const outcome = (tool) => {
    const r = [...results].reverse().find((x) => x.tool === tool) ?? results[results.length - 1];
    if (!r) return 'nothing came back';
    if (r.ok) return `it worked (${r.status})`;
    return `${r.status}: ${r.error ?? 'no reason given'}`;
  };
  if (/qa-confirm/i.test(message)) {
    if (!results.length) return step('QA: asking to make a short video for one of your posts.', [{ tool: 'make_video', args: { postId, seconds: 5 } }]);
    return step(`QA: make_video → ${outcome('make_video')}.`);
  }
  if (/qa-delete/i.test(message)) {
    if (!postId) return step('QA: there’s no post in this project to delete. Create one first.');
    if (!results.length) return step('', [{ tool: 'delete_posts', args: { ids: [postId] } }]);
    return step(`QA: delete_posts → ${outcome('delete_posts')}.`);
  }
  if (/calendar/i.test(message)) {
    if (!results.length) return step('Opening your calendar and checking what’s due.', [{ tool: 'navigate', args: { route: 'calendar' } }, { tool: 'list_posts', args: { due: true } }]);
    const listed = [...results].reverse().find((x) => x.tool === 'list_posts' && x.ok);
    const n = Number(listed?.result?.total ?? 0);
    return step(
      n
        ? `Your [content calendar](#calendar) is open. **${n} post${n === 1 ? ' is' : 's are'} due**: the time has passed and ${n === 1 ? 'it hasn’t' : 'they haven’t'} been posted. Post ${n === 1 ? 'it' : 'them'} with Manus, or post ${n === 1 ? 'it' : 'them'} yourself and mark ${n === 1 ? 'it' : 'them'} posted.`
        : 'Your [content calendar](#calendar) is open. Nothing is due right now.',
    );
  }
  return step(`QA assistant: I read your message (${message.length} characters). Try “calendar”, “qa-confirm” or “qa-delete”.`);
}

/** What a text model answers: a scripted step for an assistant prompt, a scripted QA answer for a marker, else the fixed answer. */
function answerFor(body) {
  const prompt = assistantPromptIn(body);
  if (prompt) return mockAssistantReply(prompt);
  const sent = JSON.stringify(body ?? '');
  return SCRIPTED.find(([marker]) => sent.includes(marker))?.[1] ?? ANSWER;
}

/** A brand-voice read (src/ai/manusVoice.ts): the profile, when the prompt is one. */
const voiceProfile = (prompt) => (/^Read the latest posts of one .+ profile and describe how they sound and look/m.test(prompt ?? '') ? (/^The .+?(?:: | named “)(.+?)(?:”.*)?$/m.exec(prompt)?.[1] ?? '') : null);
/** A read of a "needs-signin" profile waits for you to sign in for its first two checks. */
const signInFirst = (task) => /needs-signin/i.test(voiceProfile(task?.prompt) ?? '');

/**
 * The stand-in Manus's report for a brand-voice read, in the lines the app reads. A profile with "private" in it
 * can't be read; one with "needs-signin" first waits for you to sign in (see task.detail). Made-up style notes
 * for QA only: they describe no real account.
 */
export function mockVoiceReply(prompt) {
  const profile = voiceProfile(prompt) ?? '';
  if (/private/i.test(profile)) return 'I opened the profile, but it is private and I can’t see its posts.\nRESULT: FAILED | The account is private: its posts aren’t visible to me.';
  return [
    'I read the 15 most recent posts on the profile. Here is how they sound and look.',
    'VOICE TONE: friendly | warm, cheerful, neighborly, down-to-earth',
    'VOICE PERSON: we',
    'VOICE WORDS: fresh from the oven | come say hi | made by hand | treat yourself',
    'VOICE OPENINGS: a cheerful greeting or a question to the reader',
    'VOICE ENDINGS: an invitation to stop by or to order ahead',
    'VOICE EMOJI: few | 🍞 ☕ ✨',
    'VOICE HASHTAGS: few | #freshbread #shoplocal #bakerylife',
    'VOICE LENGTH: short | two or three lines, with a line break before the invitation',
    'VOICE TOPICS: what is baking today | behind the scenes | seasonal flavors',
    'VOICE VISUALS: Bright natural light on close-ups of bread and pastries on wooden counters, with warm golden colors and hands at work.',
    'EXAMPLE: Good morning! The first loaves just came out of the oven and the whole street smells like it. Come say hi ☕',
    'EXAMPLE: Ever wondered what happens before sunrise in our kitchen? Flour, patience and a lot of coffee 🍞',
    'EXAMPLE: Something new is joining the pastry case this week. Stop by and tell us what you think ✨',
    'RESULT: VOICE READ | 15',
  ].join('\n');
}

export function createMockProviders({ keys = {} } = {}) {
  const calls = [];
  const behavior = {}; // provider id → 'fail500' | 'policy' | 'auth' | 'rate' | undefined
  const videoPolls = new Map();
  const manusTasks = new Map();
  const manusFiles = new Map(); // file id → { filename, status, size } (Manus file.upload)
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

  function handle(req, res, raw, rawBuf = Buffer.from(raw)) {
    // QA: a prompt containing "slow-qa" answers after 8 s (to test "leave while generating")
    if (typeof raw === 'string' && raw.includes('slow-qa') && !req.headers['x-mock-delayed']) {
      req.headers['x-mock-delayed'] = '1';
      setTimeout(() => handle(req, res, raw, rawBuf), 8000);
      return;
    }
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

    // what the mock has seen, for QA scripts (the request bodies, without images)
    if (id === '__calls') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(calls.slice(0, -1).map((c) => ({ provider: c.provider, path: c.path, body: c.body && typeof c.body === 'object' ? { ...c.body, messages: undefined, input: undefined } : null }))));
    }
    // Manus's presigned upload address (S3): no key, the exact length is required
    if (id === 'manus-upload' && req.method === 'PUT') {
      const f = manusFiles.get(rest[0]);
      if (!f) return json(res, 403, { error: 'expired or unknown upload' });
      const len = Number(req.headers['content-length'] || NaN);
      if (!Number.isFinite(len)) return json(res, 411, { error: 'MissingContentLength' });
      if (len !== rawBuf.length) return json(res, 400, { error: 'IncompleteBody' });
      Object.assign(f, { status: 'uploaded', size: rawBuf.length, head: rawBuf.subarray(0, 16).toString('hex') });
      res.writeHead(200, { etag: '"mock"' });
      return res.end();
    }
    // downloads (no key needed, like signed links)
    if (id === 'files') {
      if (p.endsWith('.mp4')) {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': MP4.length });
        return res.end(MP4);
      }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
      return res.end(req.method === 'HEAD' ? undefined : PNG);
    }
    // one key, or several (e.g. extra OpenRouter slots)
    const want = keys[id];
    if (want && ![want].flat().some((k) => String(auth).includes(k))) return json(res, 401, { error: { message: 'Invalid API key' } });
    if (failFor(id, res)) return;

    // ── Anthropic (streamed Messages API) ──
    if (id === 'anthropic' && p === '/v1/messages') {
      const effort = body?.output_config?.effort;
      const out = 150 + reasoningFor(effort);
      return sse(res, [
        { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 200, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answerFor(body) } },
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
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answerFor(body) }] },
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
      return json(res, 200, { id: 'int_txt', status: 'completed', steps: [{ type: 'thought' }, { type: 'model_output', content: [{ type: 'text', text: answerFor(body) }] }], usage: { total_input_tokens: 200, total_output_tokens: 150, total_thought_tokens: t, total_tokens: 350 + t } });
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
      return json(res, 200, { id: 'chat_mock', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: answerFor(body) }, finish_reason: 'stop' }], usage });
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
    // the key's own details: answers only with a valid key (the model list above is public on the real API)
    if (id === 'openrouter' && p === '/key') return json(res, 200, { data: { label: 'mock key', usage: 0, limit: null } });
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
    if (id === 'manus' && p === '/v2/file.upload') {
      const fileId = `file${String(manusFiles.size + 1).padStart(5, '0')}`;
      manusFiles.set(fileId, { filename: body?.filename, status: 'pending', size: 0 });
      return json(res, 200, { ok: true, request_id: 'r1', file: { id: fileId, filename: body?.filename, status: 'pending', created_at: String(Math.floor(Date.now() / 1000)) }, upload_url: `${base}/manus-upload/${fileId}?X-Amz-Signature=mock`, upload_expires_at: String(Math.floor(Date.now() / 1000) + 180) });
    }
    if (id === 'manus' && p === '/v2/file.detail') {
      const f = manusFiles.get(url.searchParams.get('file_id'));
      if (!f) return json(res, 404, { ok: false, error: { code: 'not_found', message: 'file not found' } });
      return json(res, 200, { ok: true, request_id: 'r1', file: { id: url.searchParams.get('file_id'), filename: f.filename, status: f.status } });
    }
    if (id === 'manus' && p === '/v2/task.create') {
      const taskId = `task${String(manusTasks.size + 1).padStart(6, '0')}`;
      const content = body?.message?.content;
      const prompt = typeof content === 'string' ? content : ((content ?? []).find?.((c) => c?.type === 'text')?.text ?? '');
      manusTasks.set(taskId, { polls: 0, profile: body?.agent_profile, followUps: [], prompt });
      return json(res, 200, { ok: true, request_id: 'r1', task_id: taskId, task_title: body?.title || 'Mock task', task_url: `https://manus.im/app/${taskId}` });
    }
    if (id === 'manus' && p === '/v2/task.detail') {
      const t = manusTasks.get(url.searchParams.get('task_id'));
      if (!t) return json(res, 404, { ok: false, error: { code: 'not_found', message: 'task not found' } });
      t.polls += 1;
      const done = t.polls >= (signInFirst(t) ? 4 : 2);
      if (signInFirst(t) && t.polls < 3) return json(res, 200, { ok: true, task: { id: url.searchParams.get('task_id'), status: 'waiting', title: 'Mock task', task_url: `https://manus.im/app/${url.searchParams.get('task_id')}` } });
      return json(res, 200, { ok: true, task: { id: url.searchParams.get('task_id'), status: done ? 'stopped' : 'running', title: 'Mock task', task_url: `https://manus.im/app/${url.searchParams.get('task_id')}`, ...(done ? { credit_usage: t.profile === 'lite' ? 12 : 41 } : {}) } });
    }
    if (id === 'manus' && p === '/v2/task.listMessages') {
      const t = manusTasks.get(url.searchParams.get('task_id'));
      const voice = voiceProfile(t?.prompt) !== null;
      const done = t && t.polls >= (signInFirst(t) ? 4 : 2);
      if (t && signInFirst(t) && t.polls < 3) {
        return json(res, 200, { ok: true, messages: [{ id: 'e2', type: 'status_update', status_update: { agent_status: 'waiting', status_detail: { waiting_for_event_type: 'needConnectMyBrowser', waiting_description: 'Please sign in to the network in my browser so I can see the posts.' } } }, { id: 'e1', type: 'user_message', user_message: { content: 'read it' } }] });
      }
      // a "post right now" task reports a post on that network, with its link
      const postNow = /^Post ONE organic post on (Facebook|Instagram|TikTok|LinkedIn|X), right now/m.exec(t?.prompt ?? '');
      const LINKS = { Facebook: 'https://www.facebook.com/mockpage/posts/1001', Instagram: 'https://www.instagram.com/p/MOCK1/', TikTok: 'https://www.tiktok.com/@mock/video/1001', LinkedIn: 'https://www.linkedin.com/feed/update/urn:li:activity:1001/', X: 'https://x.com/mock/status/1001' };
      // a Facebook groups task reports each group (one that needs approval says so)
      const groupsTask = /^Share ONE post in each of these Facebook groups/m.test(t?.prompt ?? '');
      const groupLines = groupsTask ? [...(t?.prompt ?? '').matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]).filter((g) => !/^(Open Facebook|Read the group|Post as|In the group|Attach|This is a text|Choose|Wait about)/.test(g)) : [];
      const reply = voice
        ? mockVoiceReply(t?.prompt)
        : groupsTask
        ? `Done.\n${groupLines.map((g, i) => (/approval/i.test(g) ? `GROUP: ${g} | PENDING | waiting for admin approval` : `GROUP: ${g} | POSTED | https://www.facebook.com/groups/mock${i}/posts/1`)).join('\n')}\nRESULT: GROUPS DONE`
        : postNow ? `Posted it.\nRESULT: POSTED | Mock Account | ${LINKS[postNow[1]]}${/^<<<COMMENT TEXT$/m.test(t?.prompt ?? '') ? (/comments-off/i.test(t?.prompt ?? '') ? ' | COMMENT FAILED: Comments are turned off for this post' : ' | COMMENT ADDED') : ''}` : 'Here is your image.\nRESULT: SCHEDULED | Mock Page | Monday 9:00 AM';
      return json(res, 200, {
        ok: true,
        messages: done
          ? [
              { id: 'e3', type: 'status_update', status_update: { agent_status: 'stopped' } },
              { id: 'e2', type: 'assistant_message', assistant_message: { content: reply, attachments: [{ type: 'image', filename: 'photo.png', url: `${base}/files/photo.png`, content_type: 'image/png' }] } },
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
    manusFiles,
    last(provider, path) {
      return [...calls].reverse().find((c) => c.provider === provider && (!path || c.path === path));
    },
    reset() {
      calls.length = 0;
      for (const k of Object.keys(behavior)) delete behavior[k];
    },
    async start(port = 0) {
      server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const rawBuf = Buffer.concat(chunks);
          handle(req, res, rawBuf.toString('utf8'), rawBuf);
        });
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
