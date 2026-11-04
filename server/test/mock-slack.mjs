// A stand-in for Slack's Web API and a scripted Viktor, for tests and browser QA (mounted by mock-providers.mjs):
//   <base>/slack/api/<method>          the Web API (form or JSON bodies; every answer carries x-oauth-scopes)
//   <base>/slack-upload/v1/<ticket>    the upload address files.getUploadURLExternal hands out (no token allowed)
//   <base>/slack-files/…               the file host (needs the token; without it, a "sign in" page)
//   <base>/evil/…                      a host the app must never send the token to (or fetch at all)
//
// The workspace: team TQA00001 "QA Workspace"; the owner UQAOWNER1; a human UQAHUMAN1; Viktor UQAVIKTOR (bot
// BQAVIKTOR, app AQAVIKTOR); "Other Bot" UQAOTHER1; a deleted bot; USLACKBOT. Conversations: the DM with Viktor
// DQAVIKTOR1, #viktor-builds CQAVIKTOR (owner + Viktor), #general CQAGENERAL (owner + human), private #team
// GQAPRIVATE (owner + Viktor). Tokens: the owner user token (…1) (all scopes), the dmonly user token (…2) (the
// DM scopes only), the noscope user token (…3) (no files:read), the bot token (…4).
//
// Viktor answers the owner's messages in the DM, or in a channel thread whose first message mentions it, on the
// 2nd conversations.replies read of that thread after the owner wrote (markers in the owner's words change the
// answer: see mockViktorReply).

export const SLACK_QA = {
  team: { id: 'TQA00001', name: 'QA Workspace', domain: 'qa-workspace' },
  owner: 'UQAOWNER1',
  human: 'UQAHUMAN1',
  viktor: 'UQAVIKTOR',
  viktorBot: 'BQAVIKTOR',
  viktorApp: 'AQAVIKTOR',
  other: 'UQAOTHER1',
  dm: 'DQAVIKTOR1',
  channel: 'CQAVIKTOR',
  general: 'CQAGENERAL',
  private: 'GQAPRIVATE',
  tokens: { owner: 'xo\x78p-qa-owner-000000000001', dmOnly: 'xo\x78p-qa-dmonly-000000000002', noScope: 'xo\x78p-qa-noscope-000000000003', bot: 'xo\x78b-qa-bot-000000000004' },
};

const DM_SCOPES = ['chat:write', 'im:write', 'im:history', 'users:read', 'files:write', 'files:read'];
const ALL_SCOPES = [...DM_SCOPES, 'channels:history', 'groups:history', 'channels:read', 'groups:read'];
const TOKENS = {
  [SLACK_QA.tokens.owner]: { user: SLACK_QA.owner, scopes: ALL_SCOPES },
  [SLACK_QA.tokens.dmOnly]: { user: SLACK_QA.owner, scopes: DM_SCOPES },
  [SLACK_QA.tokens.noScope]: { user: SLACK_QA.owner, scopes: ALL_SCOPES.filter((s) => s !== 'files:read') },
  [SLACK_QA.tokens.bot]: { user: 'UQABOTUSR', scopes: ['chat:write', 'users:read'], bot: 'BQABOTTOK' },
};

const USERS = [
  { id: SLACK_QA.owner, name: 'owner', real_name: 'QA Owner', is_bot: false, deleted: false, profile: { display_name: 'Owner', real_name: 'QA Owner' } },
  { id: SLACK_QA.human, name: 'sam', real_name: 'Sam Human', is_bot: false, deleted: false, profile: { display_name: 'Sam', real_name: 'Sam Human' } },
  { id: SLACK_QA.viktor, name: 'viktor', real_name: 'Viktor', is_bot: true, deleted: false, profile: { display_name: 'Viktor', real_name: 'Viktor', bot_id: SLACK_QA.viktorBot } },
  { id: SLACK_QA.other, name: 'otherbot', real_name: 'Other Bot', is_bot: true, deleted: false, profile: { display_name: 'Other Bot', real_name: 'Other Bot', bot_id: 'BQAOTHER1' } },
  { id: 'UQAGONEBT', name: 'oldbot', real_name: 'Old Bot', is_bot: true, deleted: true, profile: { display_name: 'Old Bot', real_name: 'Old Bot', bot_id: 'BQAGONEBT' } },
  { id: 'USLACKBOT', name: 'slackbot', real_name: 'Slackbot', is_bot: true, deleted: false, profile: { display_name: 'Slackbot', real_name: 'Slackbot' } },
];
const BOTS = { [SLACK_QA.viktorBot]: { id: SLACK_QA.viktorBot, app_id: SLACK_QA.viktorApp, user_id: SLACK_QA.viktor, name: 'Viktor', deleted: false }, BQAOTHER1: { id: 'BQAOTHER1', app_id: 'AQAOTHER1', user_id: SLACK_QA.other, name: 'Other Bot', deleted: false } };
const CONVERSATIONS = {
  [SLACK_QA.dm]: { id: SLACK_QA.dm, is_im: true, user: SLACK_QA.viktor, members: [SLACK_QA.owner, SLACK_QA.viktor] },
  [SLACK_QA.channel]: { id: SLACK_QA.channel, name: 'viktor-builds', is_channel: true, is_private: false, members: [SLACK_QA.owner, SLACK_QA.viktor] },
  [SLACK_QA.general]: { id: SLACK_QA.general, name: 'general', is_channel: true, is_private: false, members: [SLACK_QA.owner, SLACK_QA.human] },
  [SLACK_QA.private]: { id: SLACK_QA.private, name: 'team', is_channel: true, is_private: true, members: [SLACK_QA.owner, SLACK_QA.viktor] },
};

/** The scopes a method needs on a conversation (D: DMs, C: public channels, G: private ones). */
function scopeFor(method, channel = '') {
  const t = channel[0];
  const kind = (im, pub, priv) => (t === 'D' ? im : t === 'G' ? priv : pub);
  switch (method) {
    case 'users.list':
    case 'users.info':
    case 'bots.info':
      return ['users:read'];
    case 'conversations.open':
      return ['im:write'];
    case 'chat.postMessage':
      return ['chat:write'];
    case 'files.getUploadURLExternal':
    case 'files.completeUploadExternal':
      return ['files:write'];
    case 'files.info':
      return ['files:read'];
    case 'conversations.replies':
    case 'conversations.history':
      return [kind('im:history', 'channels:history', 'groups:history')];
    case 'conversations.info':
    case 'conversations.members':
      return [kind('im:read', 'channels:read', 'groups:read')];
    case 'users.conversations':
      return ['channels:read'];
    default:
      return [];
  }
}

const escapeSlack = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const decodeSlack = (s) => String(s).replace(/&(lt|gt|amp);/g, (_, n) => (n === 'lt' ? '<' : n === 'gt' ? '>' : '&'));

/** The page Viktor builds for QA: Fish &amp; Chips (decoded exactly once, it stays &amp;), {{img-1}} when it was sent. */
export function viktorPage({ img = false, script = false, extra = '' } = {}) {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>QA booking page</title><meta name="description" content="A page the stand-in Viktor made for QA.">',
    '<style>body{font-family:sans-serif;margin:0;padding:24px;color:#1d2a22}h1{color:#156343}.cta{background:#efb026;padding:10px 16px;border-radius:8px}</style></head>',
    '<body>',
    '<header><h1>Fish &amp; Chips</h1><p>Fresh every day.</p><a class="cta" href="#contact">Get in touch</a></header>',
    img ? '<img src="{{img-1}}" alt="The shop front">' : '',
    '<section><h2>What we serve</h2><p>Hand-cut chips and fish from the morning boats.</p></section>',
    script ? '<button onclick="alert(1)">Click</button><script>document.title = "changed";</script>' : '',
    extra,
    '</body>',
    '</html>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The owner's own words in a chat message (the app's footer, website, images and Ref lines taken off). */
function ownerWords(text) {
  return decodeSlack(text)
    .replace(/^<@[UW][A-Z0-9]+>\s*/, '')
    .replace(/\n\n\(Sent from my Yourlocalbusiness app[\s\S]*$/, '')
    .replace(/\nRef: ylb-[A-Z0-9]{6}\s*$/, '')
    .replace(/\n\(Images attached:[^\n]*\)$/, '')
    .replace(/\nMy website: [^\n]*$/, '');
}

/**
 * What the scripted Viktor answers a message (its decoded text and how many files it carried): a list of
 * replies, each { text, blocks?, files?: [{ name, mode, external?, redirect?, big?, script? }] }, plus how it
 * arrives: { where: 'thread' | 'top', after: n reads, edit?, delete? }.
 */
export function mockViktorReply(text, fileCount = 0) {
  const t = decodeSlack(String(text ?? ''));
  const has = (m) => t.includes(m);
  const build = /^(?:<@[UW][A-Z0-9]+>\s*)?Hi Viktor, please build ONE web page/.test(t) || /^Please change page\.html/.test(t) || /^I didn't get the whole page/.test(t) || /^My answer, in my own words/.test(t);
  const img = /\{\{img-1\}\}|\bimg-1\b/.test(t);
  const plan = { where: has('qa-viktor-toplevel') ? 'top' : 'thread', after: has('qa-viktor-slow') ? 6 : 2, edit: has('qa-viktor-edit'), delete: has('qa-viktor-delete') };
  const pageReply = (o = {}) => {
    const page = viktorPage({ img, ...o });
    return {
      text: `Here's your page. I used the colors from your website.\n\`\`\`${escapeSlack(page)}\`\`\`\nWant a dark-theme version?`,
      blocks: [
        {
          type: 'rich_text',
          elements: [
            { type: 'rich_text_section', elements: [{ type: 'text', text: 'Here’s your page. I used the colors from your website.\n' }] },
            { type: 'rich_text_preformatted', elements: [{ type: 'text', text: page }] },
            { type: 'rich_text_section', elements: [{ type: 'text', text: 'Want a dark-theme version?' }] },
          ],
        },
      ],
    };
  };
  if (!build) {
    const n = ownerWords(t).length;
    const read = `QA Viktor: I read your message (${n} characters)${fileCount ? ` and ${fileCount} image${fileCount === 1 ? '' : 's'}` : ''}.`;
    // a chat takes markers too: a page as an attached file or in a code block, an answer edited later (and the
    // delivery markers above: qa-viktor-delete, qa-viktor-toplevel, qa-viktor-slow)
    if (has('qa-viktor-file')) return { ...plan, replies: [{ text: `${read} Here is page.html.`, files: [{ name: 'page.html', mode: 'hosted', img }] }] };
    if (has('qa-viktor-page')) return { ...plan, replies: [pageReply()] };
    if (plan.edit) return { ...plan, replies: [{ text: 'Working on it…', later: { text: `${read} Done: I changed it.` } }] };
    return { ...plan, replies: [{ text: read }] };
  }
  if (has('qa-viktor-question')) return { ...plan, replies: [{ text: 'Which colors do you prefer?' }] };
  if (has('qa-viktor-link')) return { ...plan, replies: [{ text: 'It’s live here: <https://qa-hosted.example/page|qa-hosted.example/page>' }] };
  if (has('qa-viktor-split')) {
    const page = viktorPage({ img });
    const half = page.slice(0, Math.floor(page.length / 2));
    return { ...plan, replies: [{ text: `Here's the first part:\n\`\`\`${escapeSlack(half)}\`\`\`` }] };
  }
  if (has('qa-viktor-file') || has('qa-viktor-snippet')) return { ...plan, replies: [{ text: 'Here is page.html.', files: [{ name: 'page.html', mode: has('qa-viktor-snippet') ? 'snippet' : 'hosted', img }] }] };
  if (has('qa-viktor-external')) return { ...plan, replies: [{ text: 'Here is page.html.', files: [{ name: 'page.html', mode: 'external', external: true }] }] };
  if (has('qa-viktor-redirect')) return { ...plan, replies: [{ text: 'Here is page.html.', files: [{ name: 'page.html', mode: 'hosted', redirect: true }] }] };
  if (has('qa-viktor-big')) return { ...plan, replies: [{ text: 'Here is page.html.', files: [{ name: 'page.html', mode: 'hosted', big: true }] }] };
  if (has('qa-viktor-script')) return { ...plan, replies: [pageReply({ script: true })] };
  if (plan.edit) return { ...plan, replies: [{ text: 'Working on it…', later: pageReply() }] };
  return { ...plan, replies: [pageReply()] };
}

/**
 * The Slack stand-in. base(): the mock server's base URL (http://127.0.0.1:PORT). It handles the ids 'slack',
 * 'slack-upload', 'slack-files' and 'evil' (mock-providers.mjs routes them here before its key check).
 */
export function createMockSlack({ base }) {
  const messages = new Map(); // channel → [message] (top-level and replies)
  const files = new Map(); // file id → { file, uploaded, completed, infoCalls, bytes, channel }
  const tickets = new Map(); // upload ticket → { fileId, length, filename, alt }
  const watches = new Map(); // `${channel}:${root ts}` → { reads, plan, trigger, files }
  const hanging = []; // answers that never come (qa-slack-timeout)
  let seq = 0;
  let fileSeq = 0;
  let rate429Done = false;

  const nextTs = () => `${Math.floor(Date.now() / 1000)}.${String(++seq).padStart(6, '0')}`;
  const listOf = (ch) => {
    if (!messages.has(ch)) messages.set(ch, []);
    return messages.get(ch);
  };
  const json = (res, status, body, scopes) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(scopes ? { 'x-oauth-scopes': scopes.join(',') } : {}) });
    res.end(JSON.stringify(body));
  };
  const tokenOf = (req) => {
    const h = String(req.headers.authorization ?? '');
    return h.startsWith('Bearer ') ? h.slice(7) : '';
  };

  /** The page bytes behind a Viktor file. */
  const fileBytes = (spec) => Buffer.from(spec.big ? viktorPage({ extra: `<p>${'x'.repeat(1_600_000)}</p>` }) : viktorPage({ img: !!spec.img }), 'utf8');

  function addMessage(channel, m) {
    listOf(channel).push(m);
    return m;
  }

  /** A Viktor message (and its files) in the channel, in the thread or top-level. */
  function viktorSays(channel, rootTs, reply, where) {
    const ts = nextTs();
    const fileObjs = (reply.files ?? []).map((spec) => {
      const id = `FQAV${String(++fileSeq).padStart(4, '0')}`;
      const bytes = fileBytes(spec);
      const url = spec.external ? `${base()}/evil/page.html` : `${base()}/slack-files/files-pri/${SLACK_QA.team.id}-${id}/${spec.redirect ? 'redirect-' : ''}${spec.name}`;
      const file = { id, name: spec.name, title: spec.name, mimetype: 'text/html', filetype: spec.external ? 'remote' : 'html', mode: spec.mode, is_external: !!spec.external, size: bytes.length, url_private: url, ...(spec.external ? {} : { url_private_download: `${url}?download=1` }) };
      files.set(id, { file, uploaded: true, completed: true, infoCalls: 0, bytes, channel });
      return file;
    });
    const m = { type: 'message', ts, user: SLACK_QA.viktor, bot_id: SLACK_QA.viktorBot, bot_profile: { id: SLACK_QA.viktorBot, app_id: SLACK_QA.viktorApp, name: 'Viktor' }, text: reply.text, ...(reply.blocks ? { blocks: reply.blocks } : {}), ...(fileObjs.length ? { files: fileObjs } : {}), ...(where === 'thread' ? { thread_ts: rootTs } : {}) };
    return addMessage(channel, m);
  }

  /** The owner wrote in a thread (or started one): Viktor answers on a later read of that thread. */
  function ownerWrote(channel, msg, rootTs) {
    const conv = CONVERSATIONS[channel];
    const root = listOf(channel).find((x) => x.ts === rootTs);
    // in a channel, Viktor answers threads whose first message mentions it
    if (!conv?.is_im && !String(root?.text ?? '').includes(`<@${SLACK_QA.viktor}>`)) return;
    const plan = mockViktorReply(msg.text, (msg.files ?? []).length);
    watches.set(`${channel}:${rootTs}`, { reads: 0, plan, done: false, said: [] });
  }

  /** A read of a thread: Viktor's scripted answer appears, changes or disappears on the planned read. */
  function onThreadRead(channel, rootTs) {
    const w = watches.get(`${channel}:${rootTs}`);
    if (!w) return;
    w.reads += 1;
    if (!w.done && w.reads >= w.plan.after) {
      w.done = true;
      for (const r of w.plan.replies) w.said.push({ m: viktorSays(channel, rootTs, r, w.plan.where), reply: r });
    }
    if (w.done && w.plan.edit && w.reads >= 4 && !w.edited) {
      w.edited = true;
      for (const { m, reply } of w.said) {
        if (!reply.later) continue;
        m.text = reply.later.text;
        m.blocks = reply.later.blocks;
        m.edited = { user: SLACK_QA.viktor, ts: nextTs() };
      }
    }
    if (w.done && w.plan.delete && w.reads >= 3 && !w.deleted) {
      w.deleted = true;
      const list = listOf(channel);
      for (const { m } of w.said) list.splice(list.indexOf(m), 1);
    }
  }

  const topLevel = (m) => !m.thread_ts || m.thread_ts === m.ts;
  const permalink = (ch, ts) => `https://${SLACK_QA.team.domain}.slack.com/archives/${ch}/p${String(ts).replace('.', '')}`;

  function api(req, res, method, params) {
    const token = tokenOf(req);
    const who = TOKENS[token];
    if (!who) return json(res, 200, { ok: false, error: 'invalid_auth' });
    const scopes = who.scopes;
    const reply = (body) => json(res, 200, { ok: true, ...body }, scopes);
    const fail = (error, extra = {}) => json(res, 200, { ok: false, error, ...extra }, scopes);
    const channel = String(params.channel ?? params.channel_id ?? '');
    const need = scopeFor(method, channel).filter((s) => !scopes.includes(s));
    if (need.length) return fail('missing_scope', { needed: need.join(','), provided: scopes.join(',') });

    switch (method) {
      case 'auth.test':
        return reply({ url: `https://${SLACK_QA.team.domain}.slack.com/`, team: SLACK_QA.team.name, user: who.bot ? 'qa-bot' : 'owner', team_id: SLACK_QA.team.id, user_id: who.user, ...(who.bot ? { bot_id: who.bot } : {}) });
      case 'auth.revoke':
        return reply({ revoked: true });
      case 'users.list': {
        const limit = Math.max(1, Math.min(2, Number(params.limit) || 2)); // pages of 2, so the app pages
        const start = Number(params.cursor || 0) || 0;
        const page = USERS.slice(start, start + limit);
        const next = start + limit < USERS.length ? String(start + limit) : '';
        return reply({ members: page, response_metadata: { next_cursor: next } });
      }
      case 'users.info': {
        const u = USERS.find((x) => x.id === params.user);
        return u ? reply({ user: u }) : fail('user_not_found');
      }
      case 'bots.info': {
        const b = BOTS[params.bot];
        return b ? reply({ bot: b }) : fail('bot_not_found');
      }
      case 'conversations.open': {
        if (params.users === SLACK_QA.viktor) return reply({ channel: { id: SLACK_QA.dm, ...(params.return_im ? { is_im: true, user: SLACK_QA.viktor } : {}) } });
        return reply({ channel: { id: `DQA${String(params.users ?? '').slice(-6)}` } });
      }
      case 'conversations.info': {
        const c = CONVERSATIONS[channel];
        return c ? reply({ channel: { id: c.id, name: c.name, is_private: !!c.is_private, is_archived: false, is_channel: !!c.is_channel, is_im: !!c.is_im } }) : fail('channel_not_found');
      }
      case 'conversations.members': {
        const c = CONVERSATIONS[channel];
        if (!c) return fail('channel_not_found');
        return reply({ members: c.members, response_metadata: { next_cursor: '' } });
      }
      case 'users.conversations': {
        const types = String(params.types ?? 'public_channel').split(',');
        if (types.includes('private_channel') && !scopes.includes('groups:read')) return fail('missing_scope', { needed: 'groups:read', provided: scopes.join(',') });
        const list = Object.values(CONVERSATIONS).filter((c) => c.is_channel && c.members.includes(who.user) && types.includes(c.is_private ? 'private_channel' : 'public_channel'));
        return reply({ channels: list.map((c) => ({ id: c.id, name: c.name, is_private: !!c.is_private, is_archived: false })), response_metadata: { next_cursor: '' } });
      }
      case 'chat.postMessage': {
        const c = CONVERSATIONS[channel];
        const text = String(params.text ?? '');
        if (text.includes('qa-slack-fail')) return fail('channel_not_found');
        if (text.includes('qa-slack-429') && !rate429Done) {
          rate429Done = true;
          res.writeHead(429, { 'retry-after': '2', 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'ratelimited' }));
        }
        if (!c || !c.members.includes(who.user)) return fail(c ? 'not_in_channel' : 'channel_not_found');
        if (!text) return fail('no_text');
        const threadTs = params.thread_ts ? String(params.thread_ts) : '';
        if (threadTs && !listOf(channel).some((m) => m.ts === threadTs)) return fail('thread_not_found');
        const m = addMessage(channel, { type: 'message', ts: nextTs(), user: who.user, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
        ownerWrote(channel, m, threadTs || m.ts);
        if (text.includes('qa-slack-internal')) return fail('internal_error');
        // stored, but the answer never comes
        if (text.includes('qa-slack-timeout')) return void hanging.push(res);
        return reply({ channel, ts: m.ts, message: { ...m } });
      }
      case 'chat.getPermalink':
        return reply({ channel, permalink: permalink(channel, params.message_ts) });
      case 'files.getUploadURLExternal': {
        const length = Number(params.length);
        if (!params.filename || !(length > 0)) return fail('invalid_arguments');
        if (String(params.alt_txt ?? '').length > 1000) return fail('alt_txt_too_large');
        const id = `FQA${String(++fileSeq).padStart(5, '0')}`;
        const ticket = `t${id}`;
        tickets.set(ticket, { fileId: id, length, filename: String(params.filename), alt: String(params.alt_txt ?? '') });
        files.set(id, { file: { id, name: String(params.filename), title: String(params.filename), mimetype: 'image/jpeg', filetype: 'jpg', mode: 'hosted', size: length }, uploaded: false, completed: false, infoCalls: 0, bytes: null, channel: '' });
        return reply({ upload_url: `${base()}/slack-upload/v1/${ticket}`, file_id: id });
      }
      case 'files.completeUploadExternal': {
        let list = params.files;
        if (typeof list === 'string') {
          try {
            list = JSON.parse(list);
          } catch {
            list = [];
          }
        }
        if (!Array.isArray(list) || !list.length) return fail('invalid_arguments');
        for (const f of list) {
          const rec = files.get(f?.id);
          if (!rec || !rec.uploaded) return fail('file_not_found');
          if (rec.completed) return fail('file_not_found');
        }
        const c = CONVERSATIONS[channel];
        if (!c || !c.members.includes(who.user)) return fail('channel_not_found');
        const threadTs = params.thread_ts ? String(params.thread_ts) : '';
        const fileObjs = list.map((f) => {
          const rec = files.get(f.id);
          rec.completed = true;
          rec.channel = channel;
          rec.file.title = f.title || rec.file.title;
          return rec.file;
        });
        const text = String(params.initial_comment ?? '');
        const m = addMessage(channel, { type: 'message', ts: nextTs(), user: who.user, text, files: fileObjs, ...(threadTs ? { thread_ts: threadTs } : {}), upload: true });
        for (const f of list) files.get(f.id).messageTs = m.ts;
        ownerWrote(channel, m, threadTs || m.ts);
        // like Slack's reference: the files, without where they were shared (found later with files.info)
        return reply({ files: fileObjs.map((f) => ({ id: f.id, title: f.title, shares: {} })) });
      }
      case 'files.info': {
        const rec = files.get(params.file);
        if (!rec) return fail('file_not_found');
        rec.infoCalls += 1;
        // shared a moment later: the message's ts shows from the second look
        const shares = rec.completed && rec.infoCalls >= 2 && rec.messageTs ? { [rec.channel[0] === 'C' ? 'public' : 'private']: { [rec.channel]: [{ ts: rec.messageTs }] } } : {};
        return reply({ file: { ...rec.file, shares } });
      }
      case 'conversations.replies': {
        const ts = String(params.ts ?? '');
        const list = listOf(channel);
        const root = list.find((m) => m.ts === ts && topLevel(m));
        if (!root) return fail('thread_not_found');
        onThreadRead(channel, ts);
        const thread = [root, ...list.filter((m) => m.thread_ts === ts && m.ts !== ts)].sort((a, b) => (a.ts < b.ts ? -1 : 1));
        const limit = Math.max(1, Math.min(1000, Number(params.limit) || 200));
        const start = Number(params.cursor || 0) || 0;
        const next = start + limit < thread.length ? String(start + limit) : '';
        return reply({ messages: thread.slice(start, start + limit).map((m) => ({ ...m })), has_more: !!next, response_metadata: { next_cursor: next } });
      }
      case 'conversations.history': {
        const c = CONVERSATIONS[channel];
        if (!c) return fail('channel_not_found');
        const oldest = Number(params.oldest || 0);
        const inclusive = params.inclusive === true || params.inclusive === 'true';
        const all = listOf(channel)
          .filter((m) => topLevel(m) || m.subtype === 'thread_broadcast')
          .filter((m) => (inclusive ? Number(m.ts) >= oldest : Number(m.ts) > oldest))
          .sort((a, b) => (a.ts < b.ts ? 1 : -1));
        const limit = Math.max(1, Math.min(999, Number(params.limit) || 100));
        return reply({ messages: all.slice(0, limit).map((m) => ({ ...m })), has_more: all.length > limit, response_metadata: { next_cursor: '' } });
      }
      default:
        return fail('unknown_method');
    }
  }

  /** Every Slack path. id: 'slack' | 'slack-upload' | 'slack-files' | 'evil'. Returns true when it answered. */
  function handle(req, res, id, rest, raw, rawBuf) {
    if (id === 'slack') {
      const method = rest[1] ?? '';
      let params = {};
      const type = String(req.headers['content-type'] ?? '');
      if (/application\/json/.test(type)) {
        try {
          params = JSON.parse(raw || '{}');
        } catch {
          params = {};
        }
      } else params = Object.fromEntries(new URLSearchParams(raw || ''));
      api(req, res, method, params);
      return true;
    }
    if (id === 'slack-upload') {
      // the upload address must never get the token
      if (req.headers.authorization) return void json(res, 400, { error: 'no_auth_allowed' }) || true;
      const t = tickets.get(rest[1]);
      if (!t || req.method !== 'POST') return void json(res, 404, { error: 'expired' }) || true;
      if (rawBuf.length !== t.length) return void json(res, 400, { error: 'length_mismatch' }) || true;
      const rec = files.get(t.fileId);
      rec.uploaded = true;
      rec.bytes = rawBuf;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`OK - ${rawBuf.length}`);
      return true;
    }
    if (id === 'slack-files') {
      const token = tokenOf(req);
      const who = TOKENS[token];
      // without the token (or without files:read): Slack's sign-in page, not the file
      if (!who || !who.scopes.includes('files:read')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><body><h1>Sign in to Slack</h1></body></html>');
        return true;
      }
      const name = rest[rest.length - 1] ?? '';
      if (name.startsWith('redirect-')) {
        // a redirect to another host: the token must not follow
        const port = new URL(base()).port;
        res.writeHead(302, { location: `http://localhost:${port}/evil/page.html` });
        res.end();
        return true;
      }
      const fileId = /-(F[A-Z0-9]+)$/.exec(rest[1] ?? '')?.[1] ?? '';
      const rec = files.get(fileId);
      if (!rec?.bytes) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return true;
      }
      res.writeHead(200, { 'content-type': rec.file.mimetype || 'application/octet-stream', 'content-length': rec.bytes.length });
      res.end(rec.bytes);
      return true;
    }
    if (id === 'evil') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!DOCTYPE html><html><body>evil</body></html>');
      return true;
    }
    return false;
  }

  return {
    handle,
    messages,
    files,
    /** Messages in a conversation (oldest first). */
    conversation: (ch) => [...listOf(ch)].sort((a, b) => (a.ts < b.ts ? -1 : 1)),
    reset() {
      messages.clear();
      files.clear();
      tickets.clear();
      watches.clear();
      rate429Done = false;
      while (hanging.length) hanging.pop().destroy();
    },
    close() {
      while (hanging.length) hanging.pop().destroy();
    },
  };
}
