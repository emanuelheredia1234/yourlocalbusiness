// A stand-in for every AI provider's API, for tests and offline QA. Each provider lives under its
// own path prefix (http://127.0.0.1:PORT/<id>/…). Reasoning tokens grow with the effort sent, so a
// test can see effort travel from the settings to the request and back into the usage. Slack and a
// scripted Viktor live in mock-slack.mjs (the "slack" base URL).
//
//   node server/test/mock-providers.mjs [port]   → prints the AI_PROVIDER_BASE_URLS value to use

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { QA_SOURCES, STRATEGY_SCRIPTED } from './strategy-qa.mjs';
import { createMockSlack } from './mock-slack.mjs';

export { QA_SOURCES, STRATEGY_QA, STRATEGY_SCRIPTED } from './strategy-qa.mjs';
export { SLACK_QA, mockViktorReply, viktorPage } from './mock-slack.mjs';

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
  // Strategy: each step's prompt starts with its marker, [ylb-strategy:<step> v1] (server/test/strategy-qa.mjs)
  ...STRATEGY_SCRIPTED,
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
 *   "Write a message to Viktor|Manus …" or "qa-draft" → draft_agent_message (a card with the exact text; sent only
 *                  on the owner's yes); then done, saying what happened
 *   "qa-open-build" → open_agent_build for the SEO page with Viktor (Manus when the message names Manus)
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
  const agent = /\bmanus\b/i.test(message) ? 'manus' : 'viktor';
  if (/qa-draft/i.test(message) || /\b(write|draft) a message (to|for) (viktor|manus)\b/i.test(message)) {
    if (!results.length) return step('', [{ tool: 'draft_agent_message', args: { to: agent, text: /darker/i.test(message) ? 'Please make a darker version of the page you sent.' : 'QA: a message the assistant drafted.' } }]);
    return step(`QA: draft_agent_message → ${outcome('draft_agent_message')}.`);
  }
  if (/qa-open-build/i.test(message)) {
    if (!results.length) return step('', [{ tool: 'open_agent_build', args: { target: 'seo', agent } }]);
    return step(`QA: open_agent_build → ${outcome('open_agent_build')}.`);
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

// ───────────── web research (Strategy) ─────────────
// A request carrying its provider's search tool gets that provider's search-shaped answer: made-up
// sources (QA_SOURCES, reserved example domains) and the scripted JSON as the final text. Markers in
// the request (the owner types them in Strategy → Your details → "Anything else"):
//   qa-research-none     the tool is there but the model doesn't search (the plain answer)
//   qa-research-error    the search fails (Anthropic: a tool-result error; OpenAI, xAI, Meta: a failed search call)
//   qa-research-refused  400 "web search is not enabled": the request sent again without the tool answers as usual
//   qa-pause-turn        Anthropic: the first answer pauses (pause_turn) after one search; the continuation finishes
//   qa-research-slow     the answer waits 1.5 s (tests time research out sooner than that)

/** The provider's web search tool is in the request (Google: none, the app doesn't search with Gemini). */
function searchToolIn(id, p, body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  if (id === 'anthropic') return p === '/v1/messages' && tools.some((t) => /^web_search_/.test(String(t?.type ?? '')));
  if (id === 'openai' || id === 'xai' || id === 'meta') return p === '/responses' && tools.some((t) => t?.type === 'web_search');
  if (id === 'openrouter') return p === '/chat/completions' && tools.some((t) => t?.type === 'openrouter:web_search');
  return false;
}

/** A deep research task (server/providers/marketResearch.mjs writes the prompt). */
const RESEARCH_TASK = /^Research how businesses in one market find clients/;

/** The stand-in Manus's research report, in the lines the server reads; and what it fills in for the schema. */
export function mockResearchReport(prompt) {
  if (/qa-research-failed/i.test(prompt ?? '')) {
    return { text: 'I tried, but the pages wouldn’t open.\nRESULT: FAILED | QA: couldn\'t open the pages.', value: { pages_read: 0, failed_reason: "QA: couldn't open the pages.", findings: [] } };
  }
  return {
    text: [
      'I opened 3 public pages.',
      `FINDING: buyers | QA: a directory page lists local businesses with photos and opening hours. | ${QA_SOURCES[0].url}`,
      'FINDING: social | QA: a guide says behind-the-scenes clips get comments. | https://example.org/qa-research/content-that-works',
      'FINDING: promote | QA: a finding without an address (it must be dropped). | not-a-url',
      'RESULT: RESEARCH DONE | 3',
    ].join('\n'),
    value: {
      pages_read: 3,
      failed_reason: null,
      findings: [
        { topic: 'buyers', finding: 'QA: a directory page lists local businesses with photos and opening hours.', url: QA_SOURCES[0].url, quote: null },
        { topic: 'social', finding: 'QA: a guide says behind-the-scenes clips get comments.', url: 'https://example.org/qa-research/content-that-works', quote: 'QA stand-in quote.' },
      ],
    },
  };
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

// ───────────── Manus builds and chats (server/agents/templates.mjs writes their messages) ─────────────
// A build or chat task keeps a log of events (ids e1, e2…, timestamps in ms, delivery_kind), in rounds: the
// task's first message, then each task.sendMessage. A round's answer arrives on the first read of the
// messages after 2 status checks (task.detail), and the task says "stopped" only once it has arrived. Markers
// in the owner's words pick the answer:
//   build: qa-manus-script (page-script.html: a script, onclick= and a form that doesn't fit), qa-manus-zip
//          (page.zip only), qa-manus-webdev (a Manus website link, no file), qa-manus-noresult (the file, no
//          RESULT line), qa-manus-fail (RESULT: FAILED), qa-manus-nofile ("Done."), qa-manus-big (page-big.html,
//          1.6 MB), qa-manus-ask (a question first; the answer's round builds), qa-manus-approve (waits for an
//          approval in Manus), qa-manus-bg (background jobs for one check); anything else: page.html.
//   chat:  qa-manus-page (+ page.html), qa-manus-image (+ photo.png), qa-manus-question (a question with Blue /
//          Green), qa-manus-progress (an opening and a progress message, then the result); else "I read it".

export const MANUS_BUILD_TASK = /^Build ONE web page as ONE self-contained HTML file/;
export const MANUS_CHAT_TASK = /^I'm writing to you from my Yourlocalbusiness app/;

/** The page the stand-in Manus builds: it shows {{img-1}} and "Fish &amp; Chips". */
export const MANUS_QA_PAGE = [
  '<!DOCTYPE html>',
  '<html lang="en">',
  '<head><meta charset="utf-8"><title>QA page from Manus</title><meta name="description" content="A page the stand-in Manus made for QA.">',
  '<style>body{font-family:sans-serif;margin:0;padding:24px;color:#1d2a22}h1{color:#156343}</style></head>',
  '<body>',
  '<header><h1>Fish &amp; Chips</h1><p>Fresh every day.</p><a href="#contact">Get in touch</a></header>',
  '<img src="{{img-1}}" alt="The shop front">',
  '<section><h2>What we serve</h2><p>Hand-cut chips and fish from the morning boats.</p></section>',
  '</body>',
  '</html>',
].join('\n');

/** The QA files the stand-in Manus attaches, served at /files/<name>. */
export function manusQaFile(name) {
  if (name === 'page.html') return { type: 'text/html; charset=utf-8', bytes: Buffer.from(MANUS_QA_PAGE, 'utf8') };
  if (name === 'page-script.html') {
    const page = MANUS_QA_PAGE.replace('</body>', '<button onclick="alert(1)">Hi</button>\n<form action="https://collect.example/card" method="post"><input name="card"><button>Pay</button></form>\n<script>document.title = "changed";</script>\n</body>');
    return { type: 'text/html; charset=utf-8', bytes: Buffer.from(page, 'utf8') };
  }
  if (name === 'page-big.html') return { type: 'text/html; charset=utf-8', bytes: Buffer.from(MANUS_QA_PAGE.replace('</body>', `<p>${'x'.repeat(1_600_000)}</p></body>`), 'utf8') };
  if (name === 'page.zip') return { type: 'application/zip', bytes: Buffer.from('PK\u0003\u0004qa-zip-file', 'binary') };
  return null;
}

/** The owner's words in a chat message: the MESSAGE block of the first one; a later one without its website and images lines. */
function manusChatWords(text) {
  const block = /<<<MESSAGE\n([\s\S]*?)\nMESSAGE>>>/.exec(text);
  if (block) return block[1];
  return String(text).replace(/\n\n\(Images attached:[^\n]*\)$/, '').replace(/\n\nMy website: [^\n]*$/, '');
}

function agentEvent(t, type, payload) {
  t.seq += 1;
  const e = { id: `e${t.seq}`, type, timestamp: t.createdMs + t.seq * 10, [type]: payload };
  t.events.push(e);
  return e;
}

/** A new build or chat task from task.create, or null when the prompt is neither. */
export function newAgentTask(prompt, files, { title, profile, now = Date.now() }) {
  const kind = MANUS_BUILD_TASK.test(prompt) ? 'build' : MANUS_CHAT_TASK.test(prompt) ? 'chat' : null;
  if (!kind) return null;
  const t = { kind, title, profile, createdMs: now, seq: 0, events: [], credits: 0, rounds: 0, asked: false, stopped: false };
  agentEvent(t, 'user_message', { content: prompt, attachments: files.map((f) => ({ type: 'file', filename: f.filename, file_uid: f.file_id })) });
  agentEvent(t, 'status_update', { agent_status: 'running' });
  t.round = { text: prompt, polls: 0, state: 'running', bg: false };
  return t;
}

/** task.sendMessage: the owner's message starts a new round (a stopped task resumes). */
export function agentFollowUp(t, content) {
  const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const text = parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
  const files = parts.filter((p) => p?.type === 'file');
  agentEvent(t, 'user_message', { content: text, attachments: files.map((f) => ({ type: 'file', filename: f.filename, file_uid: f.file_id })) });
  agentEvent(t, 'status_update', { agent_status: 'running' });
  t.stopped = false;
  t.round = { text, polls: 0, state: 'running', bg: false };
}

/** The round's answer (on the read after 2 checks). */
function finishRound(t, base) {
  const r = t.round;
  const has = (m) => r.text.includes(m);
  const credit = () => {
    t.credits += t.profile === 'lite' ? 12 : 41;
  };
  const file = (name, type = 'text/html') => ({ type: 'file', filename: name, content_type: type, path: `/home/ubuntu/${name}`, url: `${base}/files/${name}`, file_uid: `f-${name}`, version_uid: `v${t.rounds + 1}` });
  const wait = (type, description) => {
    agentEvent(t, 'status_update', { agent_status: 'waiting', status_detail: { waiting_for_event_type: type, waiting_description: description } });
    r.state = 'waiting';
    credit();
  };
  if (t.kind === 'build') {
    if (has('qa-manus-ask') && !t.asked) {
      t.asked = true;
      agentEvent(t, 'assistant_message', { content: 'Which colors do you prefer?', attachments: [], delivery_kind: 'result' });
      return wait('messageAskUser', 'Which colors do you prefer?');
    }
    if (has('qa-manus-approve')) return wait('needConnectMyBrowser', 'Please sign in to your website in my browser so I can look at it.');
    let content = 'Here is your page.\nRESULT: BUILT | page.html';
    let attachments = [file('page.html')];
    if (has('qa-manus-zip')) {
      content = 'Here is your site.\nRESULT: BUILT | page.zip';
      attachments = [file('page.zip', 'application/zip')];
    } else if (has('qa-manus-webdev')) {
      content = 'I built it: [your site](manus-webdev://v1)';
      attachments = [];
    } else if (has('qa-manus-fail')) {
      content = "RESULT: FAILED | QA: couldn't open the website.";
      attachments = [];
    } else if (has('qa-manus-nofile')) {
      content = 'Done.';
      attachments = [];
    } else if (has('qa-manus-noresult')) content = 'Here is your page.';
    else if (has('qa-manus-script')) attachments = [file('page-script.html')];
    else if (has('qa-manus-big')) attachments = [file('page-big.html')];
    agentEvent(t, 'assistant_message', { content, attachments, delivery_kind: 'result' });
  } else {
    if (has('qa-manus-question')) {
      agentEvent(t, 'assistant_message', { content: 'Which color should the button be?', attachments: [], question_expectation: { options: ['Blue', 'Green'], selection_mode: 'single', response_method: 'send_message' }, delivery_kind: 'result' });
      return wait('messageAskUser', 'Which color should the button be?');
    }
    if (has('qa-manus-progress')) {
      agentEvent(t, 'assistant_message', { content: 'On it: reading your message.', attachments: [], delivery_kind: 'opening' });
      agentEvent(t, 'assistant_message', { content: 'Working on it…', attachments: [], delivery_kind: 'progress' });
    }
    const attachments = [];
    if (has('qa-manus-page')) attachments.push(file('page.html'));
    if (has('qa-manus-image')) attachments.push({ type: 'image', filename: 'photo.png', content_type: 'image/png', url: `${base}/files/photo.png` });
    agentEvent(t, 'assistant_message', { content: `QA Manus: I read your message (${manusChatWords(r.text).length} characters).`, attachments, delivery_kind: 'result' });
  }
  agentEvent(t, 'status_update', { agent_status: 'stopped' });
  r.state = 'done';
  r.bg = has('qa-manus-bg');
  t.rounds += 1;
  credit();
}

/** task.detail for a build or chat task: running until the round's answer arrived. */
export function agentDetail(t, id) {
  const r = t.round;
  if (r.state === 'running' && !t.stopped) r.polls += 1;
  let background = false;
  if (r.state === 'done' && r.bg && !r.bgShown) {
    r.bgShown = true;
    background = true;
  }
  const status = t.stopped ? 'stopped' : r.state === 'running' ? 'running' : r.state === 'waiting' ? 'waiting' : 'stopped';
  return { id, status, title: t.title || 'Mock task', task_url: `https://manus.im/app/${id}`, has_running_background_jobs: background, ...(t.credits ? { credit_usage: t.credits } : {}) };
}

/** task.listMessages for a build or chat task, newest first. */
export function agentMessages(t, base, limit = 50) {
  const r = t.round;
  if (r.state === 'running' && !t.stopped && r.polls >= 2) finishRound(t, base);
  const list = [...t.events].reverse();
  return { messages: list.slice(0, limit), has_more: list.length > limit };
}

/** task.stop. */
export function agentStop(t) {
  t.stopped = true;
  if (t.round.state === 'running') t.round.state = 'stopped';
  agentEvent(t, 'status_update', { agent_status: 'stopped' });
}

export function createMockProviders({ keys = {} } = {}) {
  const calls = [];
  const behavior = {}; // provider id → 'fail500' | 'policy' | 'auth' | 'rate' | undefined
  const videoPolls = new Map();
  const manusTasks = new Map();
  const manusFiles = new Map(); // file id → { filename, status, size } (Manus file.upload)
  let server;
  let base = '';
  const slack = createMockSlack({ base: () => base });

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

  /** Anthropic's streamed answer with one web search (pause: it stops after the search, as pause_turn). */
  function anthropicSearch(res, body, answer, { error = false, pause = false } = {}) {
    const S = QA_SOURCES;
    // a continuation carries the paused turn back as an assistant message: its tool ids must be new
    const n = (body?.messages ?? []).filter((m) => m?.role === 'assistant').length + 1;
    const events = [{ type: 'message_start', message: { id: `msg_qa_r${n}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4200, output_tokens: 1 } } }];
    let index = 0;
    const block = (start, deltas = []) => {
      events.push({ type: 'content_block_start', index, content_block: start });
      for (const delta of deltas) events.push({ type: 'content_block_delta', index, delta });
      events.push({ type: 'content_block_stop', index });
      index += 1;
    };
    // narration before the search: not part of the answer
    if (!pause) block({ type: 'text', text: '' }, [{ type: 'text_delta', text: 'Let me look that up.' }]);
    block({ type: 'server_tool_use', id: `srvtoolu_qa${n}`, name: 'web_search', input: {} }, [{ type: 'input_json_delta', partial_json: '{"query":"qa stand-in search"}' }]);
    block({
      type: 'web_search_tool_result',
      tool_use_id: `srvtoolu_qa${n}`,
      content: error ? { type: 'web_search_tool_result_error', error_code: 'too_many_requests' } : S.map((s) => ({ type: 'web_search_result', url: s.url, title: s.title, page_age: s.page_age ?? null, encrypted_content: 'qa-encrypted-content' })),
    });
    if (!pause) {
      const cite = error ? [] : [{ type: 'citations_delta', citation: { type: 'web_search_result_location', url: S[0].url, title: S[0].title, cited_text: 'QA stand-in text.', encrypted_index: 'qa-encrypted-index' } }];
      block({ type: 'text', text: '' }, [...cite, { type: 'text_delta', text: answer }]);
    }
    events.push({ type: 'message_delta', delta: { stop_reason: pause ? 'pause_turn' : 'end_turn', stop_sequence: null }, usage: { output_tokens: pause ? 120 : 900, server_tool_use: { web_search_requests: error ? 0 : 1 } } });
    events.push({ type: 'message_stop' });
    sse(res, events);
  }

  /**
   * A request carrying its provider's search tool: the search-shaped answer (see the markers above).
   * Returns false for other requests, and for qa-research-none (the plain answer routes below reply).
   */
  function research(req, res, id, p, body, raw) {
    if (!searchToolIn(id, p, body)) return false;
    const sent = typeof raw === 'string' ? raw : '';
    if (sent.includes('qa-research-none')) return false;
    const S = QA_SOURCES;
    const answer = answerFor(body);
    const error = sent.includes('qa-research-error');
    const has = (name) => Array.isArray(body?.include) && body.include.includes(name);
    const reply = () => {
      if (sent.includes('qa-research-refused')) return json(res, 400, { error: { type: 'invalid_request_error', message: 'web search is not enabled for this organization' } });
      if (id === 'anthropic') {
        const continued = (body?.messages ?? []).some((m) => m?.role === 'assistant');
        return anthropicSearch(res, body, answer, { error, pause: sent.includes('qa-pause-turn') && !continued });
      }
      if (id === 'openai') {
        return json(res, 200, {
          id: 'resp_qa_r',
          model: body.model,
          status: 'completed',
          output: [
            { type: 'reasoning', summary: [] },
            { type: 'web_search_call', id: 'ws_qa1', status: error ? 'failed' : 'completed', action: { type: 'search', query: 'qa stand-in search', ...(!error && has('web_search_call.action.sources') ? { sources: S.map((s) => ({ type: 'url', url: s.url })) } : {}) } },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer, annotations: error ? [] : [{ type: 'url_citation', url: S[0].url, title: S[0].title, start_index: 0, end_index: 1 }] }] },
          ],
          usage: { input_tokens: 4200, output_tokens: 900, output_tokens_details: { reasoning_tokens: 300 } },
          tool_usage: { web_search: { num_requests: error ? 0 : 1 } },
        });
      }
      if (id === 'xai') {
        // without include no_inline_citations, xAI puts [[1]](url) links in the text (here after the JSON)
        const inline = has('no_inline_citations') ? '' : ` [[1]](${S[0].url})`;
        return json(res, 200, {
          id: 'xai_qa_r',
          object: 'response',
          model: body.model,
          status: 'completed',
          output: [
            { type: 'web_search_call', id: 'ws_x1', status: error ? 'failed' : 'completed' },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `${answer}${inline}`, annotations: error ? [] : S.slice(0, 2).map((s, i) => ({ type: 'url_citation', url: s.url, title: String(i + 1), start_index: 0, end_index: 0 })) }] },
          ],
          usage: { input_tokens: 9000, output_tokens: 900, output_tokens_details: { reasoning_tokens: 300 }, num_server_side_tools_used: error ? 0 : 2, server_side_tool_usage_details: { web_search_calls: error ? 0 : 2, x_search_calls: 0 }, cost_in_usd_ticks: 1_234_000_000 },
        });
      }
      if (id === 'meta') {
        return json(res, 200, {
          id: 'meta_qa_r',
          object: 'response',
          model: body.model,
          status: 'completed',
          output: [
            { type: 'web_search_call', id: 'ws_m1', status: error ? 'failed' : 'completed', ...(!error && has('web_search_call.results') ? { results: S.map((s) => ({ type: 'text_result', title: s.title, url: s.url, snippet: 'QA stand-in snippet.' })) } : {}) },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer, annotations: error ? [] : [{ type: 'url_citation', url: S[0].url, title: S[0].title, start_index: 0, end_index: 1 }] }] },
          ],
          usage: { input_tokens: 4200, output_tokens: 900, output_tokens_details: { reasoning_tokens: 300 }, total_tokens: 5100 },
        });
      }
      // OpenRouter: its citations carry page excerpts, which must never reach the browser
      return json(res, 200, {
        id: 'chat_qa_r',
        model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: answer, annotations: error ? [] : S.slice(0, 2).map((s) => ({ type: 'url_citation', url_citation: { url: s.url, title: s.title, content: 'QA stand-in excerpt (must not reach the browser).', start_index: 0, end_index: 0 } })) } }],
        usage: { prompt_tokens: 4200, completion_tokens: 900, cost: 0.0421, server_tool_use_details: { web_search_requests: error ? 0 : 2 } },
      });
    };
    if (!sent.includes('qa-research-slow')) {
      reply();
      return true;
    }
    // a slow search: the caller may have given up by then
    res.on('error', () => {});
    setTimeout(() => {
      if (!res.writableEnded && !res.destroyed && !req.socket?.destroyed) reply();
    }, 1500).unref?.();
    return true;
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
      // Slack's form-encoded calls are kept as fields
      body = /application\/x-www-form-urlencoded/.test(String(req.headers['content-type'] ?? '')) ? Object.fromEntries(new URLSearchParams(raw)) : raw;
    }
    const auth = req.headers.authorization || req.headers['x-api-key'] || req.headers['x-goog-api-key'] || req.headers['x-manus-api-key'] || '';
    calls.push({ provider: id, method: req.method, path: p, query: Object.fromEntries(url.searchParams), headers: req.headers, body });

    // what the mock has seen, for QA scripts (the request bodies, without images)
    if (id === '__calls') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(calls.slice(0, -1).map((c) => ({ provider: c.provider, path: c.path, body: c.body && typeof c.body === 'object' ? { ...c.body, messages: undefined, input: undefined } : null }))));
    }
    // Slack (its API answers 200 { ok: false } for a bad token, so it's routed before the key check below)
    if (id === 'slack' || id === 'slack-upload' || id === 'slack-files' || id === 'evil') {
      if (slack.handle(req, res, id, rest, raw, rawBuf)) return;
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
      const qa = manusQaFile(rest[rest.length - 1] ?? '');
      if (qa) {
        res.writeHead(200, { 'content-type': qa.type, 'content-length': qa.bytes.length });
        return res.end(req.method === 'HEAD' ? undefined : qa.bytes);
      }
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
    // ── web research (Strategy): requests carrying a search tool ──
    if (research(req, res, id, p, body, raw)) return;

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

    // ── xAI and Meta Responses API (the app uses it for web research; this is the answer without a search) ──
    if ((id === 'xai' || id === 'meta') && p === '/responses') {
      const r = reasoningFor(body?.reasoning?.effort);
      const usage = { input_tokens: 200, output_tokens: 150 + r, output_tokens_details: { reasoning_tokens: r }, total_tokens: 350 + r };
      // xAI reports the cost (grok-4.6 list prices), in ticks of 1e-10 dollars
      if (id === 'xai') usage.cost_in_usd_ticks = Math.round(((200 * 2 + (150 + r) * 6) / 1e6) * 1e10);
      return json(res, 200, { id: `${id}_resp_mock`, object: 'response', model: body.model, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answerFor(body), annotations: [] }] }], usage });
    }

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
      // deep research (Strategy): the schema it fills in at the end, and whether it runs without connected apps
      const fileParts = Array.isArray(content) ? content.filter((c) => c?.type === 'file' && c.file_id) : [];
      const agent = newAgentTask(prompt, fileParts, { title: body?.title || '', profile: body?.agent_profile });
      manusTasks.set(taskId, { polls: 0, profile: body?.agent_profile, followUps: [], prompt, research: RESEARCH_TASK.test(prompt), schema: body?.structured_output_schema ?? null, clearConnectors: body?.clear_connectors === true, interactive: body?.interactive_mode === true, title: body?.title || 'Mock task', createdAt: Math.floor(Date.now() / 1000), ...(agent ? { agent } : {}) });
      return json(res, 200, { ok: true, request_id: 'r1', task_id: taskId, task_title: body?.title || 'Mock task', task_url: `https://manus.im/app/${taskId}` });
    }
    if (id === 'manus' && p === '/v2/task.detail') {
      const t = manusTasks.get(url.searchParams.get('task_id'));
      if (!t) return json(res, 404, { ok: false, error: { code: 'not_found', message: 'task not found' } });
      if (t.agent) return json(res, 200, { ok: true, task: agentDetail(t.agent, url.searchParams.get('task_id')) });
      t.polls += 1;
      const done = t.polls >= (signInFirst(t) ? 4 : 2);
      if (signInFirst(t) && t.polls < 3) return json(res, 200, { ok: true, task: { id: url.searchParams.get('task_id'), status: 'waiting', title: 'Mock task', task_url: `https://manus.im/app/${url.searchParams.get('task_id')}` } });
      // made-up credit counts for QA only (a research task reads more pages, so it reports more)
      return json(res, 200, { ok: true, task: { id: url.searchParams.get('task_id'), status: done ? 'stopped' : 'running', title: 'Mock task', task_url: `https://manus.im/app/${url.searchParams.get('task_id')}`, ...(done ? { credit_usage: t.research ? 120 : t.profile === 'lite' ? 12 : 41 } : {}) } });
    }
    if (id === 'manus' && p === '/v2/task.listMessages') {
      const t = manusTasks.get(url.searchParams.get('task_id'));
      if (t?.agent) return json(res, 200, { ok: true, ...agentMessages(t.agent, base, Number(url.searchParams.get('limit')) || 50) });
      const voice = voiceProfile(t?.prompt) !== null;
      const done = t && t.polls >= (signInFirst(t) ? 4 : 2);
      if (t && signInFirst(t) && t.polls < 3) {
        return json(res, 200, { ok: true, messages: [{ id: 'e2', type: 'status_update', status_update: { agent_status: 'waiting', status_detail: { waiting_for_event_type: 'needConnectMyBrowser', waiting_description: 'Please sign in to the network in my browser so I can see the posts.' } } }, { id: 'e1', type: 'user_message', user_message: { content: 'read it' } }] });
      }
      // a deep research task reports its findings (no attachments), and fills in the schema when it was sent one
      if (t?.research && done) {
        const report = mockResearchReport(t.prompt);
        return json(res, 200, {
          ok: true,
          messages: [
            ...(t.schema ? [{ id: 'e4', type: 'structured_output_result', structured_output_result: { success: true, value: report.value, error: null } }] : []),
            { id: 'e3', type: 'status_update', status_update: { agent_status: 'stopped' } },
            { id: 'e2', type: 'assistant_message', assistant_message: { content: report.text, attachments: [] } },
            { id: 'e1', type: 'user_message', user_message: { content: 'research it' } },
          ],
        });
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
    if (id === 'manus' && p === '/v2/task.sendMessage') {
      const t = manusTasks.get(body?.task_id);
      if (!t) return json(res, 404, { ok: false, error: { code: 'not_found', message: 'task not found' } });
      t.followUps.push(body?.message?.content);
      if (t.agent) agentFollowUp(t.agent, body?.message?.content);
      return json(res, 200, { ok: true });
    }
    if (id === 'manus' && p === '/v2/task.stop') {
      const t = manusTasks.get(body?.task_id);
      if (!t) return json(res, 404, { ok: false, error: { code: 'not_found', message: 'task not found' } });
      if (t.agent) agentStop(t.agent);
      else t.polls = Math.max(t.polls, 99);
      return json(res, 200, { ok: true });
    }
    if (id === 'manus' && p === '/v2/task.list') {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
      const data = [...manusTasks.entries()].reverse().slice(0, limit).map(([tid, t]) => ({ id: tid, title: t.title, created_at: t.createdAt, task_url: `https://manus.im/app/${tid}`, status: t.agent ? agentDetail({ ...t.agent, round: { ...t.agent.round } }, tid).status : 'stopped' }));
      return json(res, 200, { ok: true, data, has_more: false });
    }

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
        slack: `${base}/slack/api`,
      };
    },
    manusFiles,
    manusTasks,
    /** The Slack stand-in (its conversations, files and reset()). */
    slack,
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
      // answers that never came (qa-slack-timeout) would keep the server open
      slack.close();
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await createMockProviders().start(Number(process.argv[2] || 0));
  console.log(JSON.stringify(mock.baseUrls()));
}
