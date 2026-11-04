// Viktor (viktor.com's AI employee) through the owner's own Slack app: the Settings routes that connect it
// and the work routes that send requests and read Viktor's replies. Mounted by server/providers/routes.mjs.
//
//   Settings (owner only):
//   GET  /api/ai/slack                 → { slack: store.slackPublic(), manifest: { yaml, json, createUrl } }
//   PUT  /api/ai/slack                 { token } | { removeToken: true, revoke?: true }
//   GET  /api/ai/slack/bots            → the workspace's bots, Viktor first
//   PUT  /api/ai/slack/viktor          { userId }
//   GET  /api/ai/slack/channels        → the owner's channels (needs the channel permissions)
//   PUT  /api/ai/slack/where           { kind: 'dm' } | { kind: 'channel', channelId }
//   POST /api/ai/slack/test            → a checklist (reads only: never posts)
//   Work (owner only):
//   POST /api/ai/slack/attach?filename=img-N.jpg&alt=…   raw image bytes → { file_id, filename } (not visible until sent)
//   POST /api/ai/slack/send            build | edit | answer | followup | chat (one-shot; dryRun shows the exact message)
//   POST /api/ai/slack/read            { threadIds } (1-6) → { threads: ViktorRead[], errors }
//   POST /api/ai/slack/verify          { ref, sentAt, threadId? } → finds a message that may have been sent
//   POST /api/ai/slack/html            { threadId, at } → a page as JSON (never as a page)
//   POST /api/ai/slack/file            { threadId, at } → a file's bytes, as an attachment
//
// The token acts as the owner in Slack and can read all of their DMs, so: it never leaves the server; every
// message goes to the one place chosen in Settings (never a channel from the browser); reads, files and
// replies work only in threads this app started (server/slack/threads.mjs); there's no route that posts
// to or reads any other conversation. Messages are the server's fixed templates (server/agents/templates.mjs).

import path from 'node:path';
import { SLACK_ENV } from '../providers/store.mjs';
import { sniffImage } from '../providers/http.mjs';
import { SlackError, createSlackApi } from './api.mjs';
import { ThreadRegistry } from './threads.mjs';
import { hasChannelScopes, manifestInfo, missingFor } from './manifest.mjs';
import { filesOf, hasLink, isExternalFile, messageHtml, readable, readableParts, renderParts, tsCompare } from './format.mjs';
import { CHANNEL_RE, IMAGE_KEY_RE, REF_RE, SLACK_FILE_RE, SLACK_LIMIT, THREAD_RE, TemplateError, cleanAnswer, cleanBuild, cleanChat, cleanEdit, isBuildRequestText, viktorAnswerParts, viktorBuildParts, viktorChatParts, viktorEditParts, viktorFollowupParts } from '../agents/templates.mjs';
import { MAX_HTML_BYTES, checkHtmlBytes, extractHtml, fileKind, isHtmlFile } from '../agents/html.mjs';

const POSTS_PER_MINUTE = 6;
const VERIFY_EVERY_MS = 10 * 60_000;
const BOTS_CACHE_MS = 10 * 60_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 15_000_000;
const TOP_LEVEL_AFTER_MS = 30_000;
const IMAGE_FILE_RE = /^img-([1-9]\d?)\.(jpe?g|png|webp|gif)$/i;
const EXT_TYPE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const SLACK_ID_RE = /^[UW][A-Z0-9]{6,}$/;
const AT_RE = /^(\d{1,12}\.\d{1,9})(?::(F[A-Z0-9]{6,}))?$/;

const OWNER_ONLY = 'Viktor runs in the app owner’s Slack, so only the owner can use it.';
const NOT_READY_TEXT = {
  no_token: 'Connect Slack in Settings → AI → Viktor (Slack).',
  bad_token: 'Slack didn’t accept the saved token: connect again in Settings → AI → Viktor (Slack).',
  missing_scopes: 'The Slack app is missing permissions: create it again from the manifest in Settings → AI → Viktor (Slack).',
  no_viktor: 'Choose Viktor in Settings → AI → Viktor (Slack).',
  no_place: 'Choose where to talk to Viktor (your DM or a channel) in Settings → AI → Viktor (Slack).',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freshEnough = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms).unref?.())]);
const endsWithRef = (text, ref) => new RegExp(`(?:^|\\n)\\s*Ref:\\s*${ref}\\s*$`).test(String(text ?? ''));
const safeName = (n) => String(n || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'file';

/**
 * store: the AIStore (the token and the connection); appState: Supabase (the thread list); reply/body/admin/
 * isAdmin/generationAllowed/abortOnClose/mayUse: the AI routes' own helpers. locateDelays: the waits between
 * the files.info looks for an upload's message (tests make them short); readCacheMs: how long a thread read
 * is shared (repeats within it cost one Slack call).
 */
export function createSlackRoutes({ store, appState = { enabled: false }, fetch = globalThis.fetch, baseUrls = {}, dataDir = '', reply, body, admin, isAdmin, generationAllowed, abortOnClose, mayUse = () => true, rateLimited = () => false, corsHeaders = () => ({}), locateDelays = [0, 2000, 3000, 5000], readCacheMs = 3000, timeouts = {}, topLevelAfterMs = TOP_LEVEL_AFTER_MS, log = console }) {
  const mockBase = baseUrls.slack ? String(baseUrls.slack).replace(/\/+$/, '') : '';
  let mock = null;
  try {
    mock = mockBase ? new URL(mockBase).origin : null;
  } catch {
    mock = null;
  }
  const api = createSlackApi({ fetch, base: mockBase || 'https://slack.com/api', mock, timeouts });
  const threads = new ThreadRegistry({ file: dataDir ? path.join(dataDir, 'slack-threads.json') : '', remote: appState });
  const posts = new Map(); // owner → times of recent posts (the 6-a-minute cap)
  const reads = new Map(); // thread id → { at, promise } (a shared read for a few seconds)
  const seen = new Map(); // thread id → Map(ts → { from, via }) (to tell when a message was deleted)
  let botsCache = null;
  let shapeLogged = false;

  // ───────────── the token and its checks ─────────────

  /** The token; if this copy of the server has none, look in Supabase once (another copy may have just saved it). */
  async function tokenNow() {
    let t = store.slackToken();
    if (!t && store.remote?.enabled) {
      await freshEnough(store.refresh({ force: true }), 2500);
      t = store.slackToken();
    }
    return t;
  }

  /** Remember a token problem Slack reported (only when it changes), so Settings and the buttons say what to fix. */
  function noteProblem(e) {
    if (!(e instanceof SlackError)) return;
    const cur = store.slack().problem;
    if (e.code === 'BAD_TOKEN' && cur?.code !== 'bad_token') store.setSlack({ problem: { code: 'bad_token', at: Date.now() } });
    if (e.code === 'MISSING_SCOPE' && !(cur?.code === 'missing_scopes' && JSON.stringify(cur.needed ?? []) === JSON.stringify(e.needed ?? []))) store.setSlack({ problem: { code: 'missing_scopes', at: Date.now(), needed: e.needed ?? [] } });
  }

  /** auth.test (free) → what the token is: its workspace, its user, its scopes. */
  async function authTest(token) {
    const { payload, scopes } = await api.callFull('auth.test', {}, { token });
    return { payload, verified: { teamId: String(payload.team_id ?? ''), team: String(payload.team ?? ''), url: String(payload.url ?? ''), userId: String(payload.user_id ?? ''), user: String(payload.user ?? ''), scopes: scopes ?? [], last4: token.slice(-4), checkedAt: Date.now() } };
  }

  /** Check the token in use again and save what Slack says (another workspace: Viktor and the place are chosen again). */
  async function refreshVerified(token) {
    try {
      const { verified } = await authTest(token);
      const prev = store.slack();
      const otherTeam = prev.verified?.teamId && prev.verified.teamId !== verified.teamId;
      store.setSlack({ verified, problem: null, ...(otherTeam ? { viktor: null, where: null } : {}) });
      return verified;
    } catch (e) {
      noteProblem(e);
      throw e;
    }
  }

  /** The token's check, done now if it's missing or for another token (the Secret was swapped). */
  async function ensureVerified(token) {
    const v = store.slack().verified;
    if (v && v.last4 === token.slice(-4) && v.userId) return v;
    return refreshVerified(token);
  }

  // ───────────── answers ─────────────

  const send = (req, res, status, payload) => reply(req, res, status, payload, { 'cache-control': 'no-store' });
  const notReady = (req, res, reason) => send(req, res, 409, { error: NOT_READY_TEXT[reason] ?? 'Viktor isn’t set up yet: see Settings → AI → Viktor (Slack).', code: 'NOT_READY', reason });
  const templateRefusal = (req, res, e) => send(req, res, e.status, { error: e.message, code: e.code, ...e.data });

  /** A Slack failure on a read or a settings call. */
  function slackFail(req, res, e) {
    if (!(e instanceof SlackError)) {
      log.error?.(e);
      return send(req, res, 502, { error: 'Something went wrong talking to Slack.', code: 'UPSTREAM' });
    }
    noteProblem(e);
    if (e.code === 'RATE_LIMIT') return send(req, res, 429, { error: e.message, code: 'RATE_LIMIT', retryAfter: e.retryAfter || 30 });
    if (e.code === 'BAD_TOKEN') return notReady(req, res, 'bad_token');
    if (e.code === 'MISSING_SCOPE') return send(req, res, 409, { error: NOT_READY_TEXT.missing_scopes, code: 'NOT_READY', reason: 'missing_scopes', needed: e.needed });
    if (e.code === 'ABORTED') return undefined;
    return send(req, res, e.code === 'TIMEOUT' ? 504 : 502, { error: e.message, code: e.code === 'SLACK_ERROR' ? 'SLACK_ERROR' : e.code === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK', ...(e.slack ? { slack: e.slack } : {}) });
  }

  /** A failed write (a post, or finishing an upload): "may have been delivered" or "not sent", never retried. */
  function sendFail(req, res, e, { ref, sentAt }) {
    if (e instanceof SlackError && e.uncertain) return send(req, res, e.code === 'TIMEOUT' ? 504 : 502, { error: 'The message may have been delivered: the connection to Slack dropped after it left. The app checks before anything is sent again.', code: 'SLACK_SEND_UNKNOWN', ref, sentAt });
    if (e instanceof SlackError && e.code === 'SLACK_ERROR') {
      noteProblem(e);
      return send(req, res, 502, { error: e.message, code: 'SLACK_ERROR', slack: e.slack });
    }
    return slackFail(req, res, e);
  }

  // ───────────── who may call ─────────────

  const settingsAllowed = (req, res, who) => {
    if (!admin(req, res, who)) return false;
    if (rateLimited(`slack-settings:${who?.id ?? req.socket.remoteAddress ?? 'unknown'}`)) {
      send(req, res, 429, { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMIT' });
      return false;
    }
    return true;
  };

  const workAllowed = (req, res, bucket, who) => {
    if (!generationAllowed(req, res, bucket, who)) return false;
    // Viktor acts as the owner in Slack: a stranger must never post as them
    if (!isAdmin(req, who)) {
      send(req, res, 403, { error: OWNER_ONLY, code: 'OWNER_ONLY' });
      return false;
    }
    return true;
  };

  // ───────────── reading a thread ─────────────

  async function repliesAll(channel, ts, token) {
    const out = [];
    let cursor = '';
    for (let page = 0; page < 5; page++) {
      const p = await api.call('conversations.replies', { channel, ts, limit: 200, ...(cursor ? { cursor } : {}) }, { token });
      out.push(...(Array.isArray(p.messages) ? p.messages : []));
      cursor = String(p.response_metadata?.next_cursor ?? '');
      if (!cursor) return { messages: out, complete: true };
    }
    return { messages: out, complete: false };
  }

  /** A send whose message wasn't found yet (images: Slack shares them a moment later): look for it by its Ref. */
  async function locateParent(t, token) {
    if (t.ts || !t.unlocated) return t;
    const ownerId = store.slack().verified?.userId;
    try {
      const p = await api.call('conversations.history', { channel: t.channel, oldest: (t.unlocated.sentAt / 1000 - 5).toFixed(6), inclusive: true, limit: 50 }, { token });
      const hit = (Array.isArray(p.messages) ? p.messages : []).find((m) => m.user === ownerId && endsWithRef(m.text, t.unlocated.ref) && (!m.thread_ts || m.thread_ts === m.ts));
      if (!hit) return t;
      const ts = String(hit.ts);
      return (
        threads.update(t.id, (x) => {
          x.ts = ts;
          delete x.unlocated;
          for (const s of x.sent) if (!s.ts && s.ref === t.unlocated.ref) s.ts = ts;
        }) ?? t
      );
    } catch (e) {
      noteProblem(e);
      return t;
    }
  }

  function logShapeOnce(m) {
    if (shapeLogged) return;
    shapeLogged = true;
    const blocks = (Array.isArray(m.blocks) ? m.blocks : []).map((b) => `${b?.type}:${(Array.isArray(b?.elements) ? b.elements : []).map((e) => e?.type).join('+')}`);
    log.debug?.(`Viktor’s first reply seen here: blocks [${blocks.join(', ')}], text escaped: ${/&lt;/.test(m.text ?? '')}, fence in text: ${/```/.test(m.text ?? '')}, files: ${(m.files ?? []).map((f) => `${f.filetype}/${f.mode}`).join(', ') || 'none'}`);
  }

  /** Read a thread with Viktor (the whole thread, so edits and deletions show): { read: ViktorRead, raw: Map(ts → message) }. */
  async function doRead(t0, token) {
    const now = Date.now();
    const conn = store.slack();
    const viktor = conn.viktor ?? {};
    const ownerId = conn.verified?.userId ?? '';
    const names = { ...(viktor.userId ? { [viktor.userId]: viktor.name || 'Viktor' } : {}), ...(ownerId ? { [ownerId]: conn.verified?.user || 'you' } : {}) };
    const base = (t, state) => ({ threadId: t.id, state, messages: [], latestHtml: null, permalink: t.permalink ?? '', sinceTs: null, checkedAt: now });
    let t = await locateParent(t0, token);
    if (!t.ts) return { read: base(t, 'sent_unlocated'), raw: new Map() };

    let got;
    try {
      got = await repliesAll(t.channel, t.ts, token);
    } catch (e) {
      if (e instanceof SlackError && (e.slack === 'thread_not_found' || e.slack === 'message_not_found')) return { read: base(t, 'gone'), raw: new Map() };
      throw e;
    }
    const isViktor = (m) => (!!viktor.userId && m.user === viktor.userId) || (!!viktor.botId && m.bot_id === viktor.botId);
    // Viktor's bot id, learned from its first message (current apps' messages carry it)
    const withBot = got.messages.find((m) => viktor.userId && m.user === viktor.userId && m.bot_id);
    if (withBot && !viktor.botId) store.setSlack({ viktor: { ...viktor, botId: String(withBot.bot_id) } });

    // messages sent with images whose ts wasn't known yet: found by their Ref line
    const unknown = t.sent.filter((s) => !s.ts);
    if (unknown.length) {
      const found = new Map();
      for (const s of unknown) {
        const hit = got.messages.find((m) => m.user === ownerId && endsWithRef(m.text, s.ref));
        if (hit) found.set(s.ref, String(hit.ts));
      }
      if (found.size) {
        t =
          threads.update(t.id, (x) => {
            for (const s of x.sent) if (!s.ts && found.has(s.ref)) s.ts = found.get(s.ref);
          }) ?? t;
      }
    }
    const sentTs = new Set(t.sent.map((s) => s.ts).filter(Boolean));
    const refs = t.sent.map((s) => s.ref);
    const last = t.sent[t.sent.length - 1];
    const since = last?.ts ?? null;

    const raw = new Map(got.messages.map((m) => [String(m.ts), { ...m, _where: 'thread' }]));
    // Viktor may answer outside the thread in the DM: its top-level messages after ours, until the owner writes again
    const viktorInThread = since ? got.messages.some((m) => isViktor(m) && tsCompare(m.ts, since) > 0) : false;
    if (t.place === 'dm' && since && !viktorInThread && last && now - last.at >= topLevelAfterMs) {
      try {
        const h = await api.call('conversations.history', { channel: t.channel, oldest: since, limit: 50 }, { token });
        const top = (Array.isArray(h.messages) ? h.messages : []).slice().sort((a, b) => tsCompare(a.ts, b.ts));
        for (const m of top) {
          if (tsCompare(m.ts, since) <= 0 || raw.has(String(m.ts))) continue;
          if (m.thread_ts && m.thread_ts !== m.ts) continue; // a reply in some thread, or a copy of one
          if (isViktor(m)) raw.set(String(m.ts), { ...m, _where: 'top' });
          else if (m.user === ownerId) break;
        }
      } catch (e) {
        if (!(e instanceof SlackError) || e.code !== 'RATE_LIMIT') throw e;
      }
    }

    const messages = [];
    for (const m of [...raw.values()].sort((a, b) => tsCompare(a.ts, b.ts))) {
      const viktorMsg = isViktor(m);
      const mine = !viktorMsg && !!ownerId && m.user === ownerId;
      const from = viktorMsg ? 'viktor' : mine ? 'you' : 'other';
      if (viktorMsg) logShapeOnce(m);
      const html = viktorMsg ? messageHtml(m, { log: (s) => log.debug?.(s) }) : null;
      messages.push({
        ts: String(m.ts),
        from,
        via: mine && (sentTs.has(String(m.ts)) || refs.some((r) => endsWithRef(m.text, r))) ? 'app' : 'slack',
        where: m._where,
        text: from === 'other' ? '' : readable(m, names),
        edited: m.edited?.ts ? String(m.edited.ts) : null,
        files: from === 'other' ? [] : filesOf(m),
        html: html ? { at: html.at, source: html.source, bytes: html.bytes, complete: html.complete } : null,
      });
    }
    // a message seen in an earlier full read of the thread and gone now: deleted in Slack
    const before = seen.get(t.id) ?? new Map();
    if (got.complete) {
      for (const [ts, info] of before) {
        if (raw.has(ts) || info.where !== 'thread') continue;
        messages.push({ ts, from: info.from, via: info.via, where: 'thread', text: '', edited: null, deleted: true, files: [], html: null });
      }
      messages.sort((a, b) => tsCompare(a.ts, b.ts));
    }
    const now2 = new Map([...before].filter(([ts]) => !raw.has(ts) && got.complete));
    for (const x of messages) if (!x.deleted) now2.set(x.ts, { from: x.from, via: x.via, where: x.where });
    seen.set(t.id, new Map([...now2].slice(-300)));
    if (seen.size > 500) seen.delete(seen.keys().next().value);

    // the thread's state, from Viktor's messages after the latest request (an edit makes a message newer)
    let state;
    let latestHtml = null;
    if (!last?.ts) state = 'sent_unlocated';
    else {
      const activity = (x) => (x.edited && tsCompare(x.edited, x.ts) > 0 ? x.edited : x.ts);
      const vk = messages.filter((x) => x.from === 'viktor' && !x.deleted && tsCompare(x.ts, last.ts) > 0).sort((a, b) => tsCompare(activity(a), activity(b)));
      const newest = vk[vk.length - 1];
      const withPage = [...vk].reverse().find((x) => x.html?.complete);
      if (withPage) {
        const rm = raw.get(withPage.ts);
        const h = messageHtml(rm);
        latestHtml = { at: withPage.html.at, bytes: withPage.html.bytes, source: withPage.html.source, filename: h?.filename ?? 'page.html' };
      }
      if (!newest) state = 'waiting';
      else if (newest.html && !newest.html.complete) state = 'partial';
      else if (latestHtml) state = 'built';
      else if (hasLink(raw.get(newest.ts))) state = 'link_only';
      else state = 'replied';
    }
    return { read: { threadId: t.id, state, messages, latestHtml, permalink: t.permalink ?? '', sinceTs: since, checkedAt: now }, raw };
  }

  /** A shared read: several tabs or devices asking at once cost one Slack call. */
  function readThread(t, token) {
    const hit = reads.get(t.id);
    if (hit && Date.now() - hit.at < readCacheMs) return hit.promise;
    const promise = doRead(t, token);
    reads.set(t.id, { at: Date.now(), promise });
    promise.catch(() => reads.delete(t.id));
    if (reads.size > 200) reads.delete(reads.keys().next().value);
    return promise;
  }

  /** A thread from the browser: one this app started, owned by the caller (otherwise 404, as if it didn't exist). */
  async function ownThread(req, res, who, id) {
    if (typeof id !== 'string' || !THREAD_RE.test(id)) {
      send(req, res, 400, { error: 'Which thread?', code: 'BAD_REQUEST' });
      return null;
    }
    await threads.ensure(id);
    const t = threads.get(id);
    if (!t || !mayUse(req, t.owner, who)) {
      send(req, res, 404, { error: 'This thread is older than 30 days, or wasn’t started by this app.', code: 'NOT_FOUND' });
      return null;
    }
    return t;
  }

  async function permalinkFor(t, token) {
    if (t.permalink || !t.ts) return t.permalink ?? '';
    try {
      const p = await api.call('chat.getPermalink', { channel: t.channel, message_ts: t.ts }, { token });
      const link = String(p.permalink ?? '');
      if (link) threads.update(t.id, (x) => (x.permalink = link));
      return link;
    } catch {
      return '';
    }
  }

  /** Where an upload's message is: in the answer, then files.info (Slack shares files a moment later), then the conversation. */
  async function locateUpload({ token, channel, parentTs, fileIds, sentAt, ownerId, answer }) {
    const fromShares = (files) => {
      for (const f of Array.isArray(files) ? files : []) {
        for (const kind of ['private', 'public']) {
          const list = f?.shares?.[kind]?.[channel];
          if (Array.isArray(list) && list[0]?.ts) return String(list[0].ts);
        }
      }
      return null;
    };
    const direct = fromShares(answer?.files);
    if (direct) return direct;
    for (let i = 0; i < locateDelays.length; i++) {
      if (locateDelays[i]) await sleep(locateDelays[i]);
      try {
        const p = await api.call('files.info', { file: fileIds[0] }, { token });
        const ts = fromShares([p.file]);
        if (ts) return ts;
      } catch (e) {
        if (e instanceof SlackError && (e.code === 'RATE_LIMIT' || e.code === 'BAD_TOKEN')) break;
      }
    }
    try {
      const msgs = parentTs ? (await repliesAll(channel, parentTs, token)).messages : (await api.call('conversations.history', { channel, oldest: (sentAt / 1000 - 5).toFixed(6), inclusive: true, limit: 20 }, { token })).messages ?? [];
      const hit = msgs.find((m) => m.user === ownerId && (m.files ?? []).some((f) => fileIds.includes(f.id)));
      if (hit) return String(hit.ts);
    } catch {
      /* the send happened; /read keeps looking */
    }
    return null;
  }

  // ───────────── the routes ─────────────

  async function readRaw(req, max) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let over = false;
      req.on('data', (c) => {
        if (over) return;
        size += c.length;
        if (size > max) {
          over = true;
          return reject(Object.assign(new Error('That image is over 4 MB.'), { status: 413 }));
        }
        chunks.push(c);
      });
      req.on('end', () => !over && resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function handle(req, res, url, who) {
    const p = url.pathname;
    const m = req.method;

    // ── Settings ──
    if (p === '/api/ai/slack') {
      if (!settingsAllowed(req, res, who)) return;
      if (m === 'GET') {
        await freshEnough(store.refresh({ every: 1000 }), 2500);
        const token = await tokenNow();
        if (token) {
          const v = store.slack().verified;
          if (!v || Date.now() - (v.checkedAt ?? 0) > VERIFY_EVERY_MS || v.last4 !== token.slice(-4)) await refreshVerified(token).catch(() => {});
        }
        return send(req, res, 200, { slack: store.slackPublic(), manifest: manifestInfo() });
      }
      if (m !== 'PUT') return send(req, res, 405, { error: 'Method not allowed', code: 'METHOD' });
      const b = await body(req, res);
      if (!b) return;
      await store.refresh({ force: true });
      if (b.removeToken === true) {
        const saved = store.state.connections?.slack?.token ?? '';
        let revoked = false;
        if (b.revoke === true && saved) {
          try {
            await api.call('auth.revoke', {}, { token: saved });
            revoked = true;
          } catch {
            /* removed here anyway */
          }
        }
        // a token from the Secret stays (and so does what was chosen for it)
        store.setSlack(store.slackSource() === 'secrets' ? { token: null } : { token: null, viktor: null, where: null, verified: null, problem: null });
        try {
          await store.persisted();
        } catch (e) {
          return send(req, res, 502, { error: `${e.message} The change works on this server for now, but may be lost when the app restarts.`, code: 'NOT_SAVED', slack: store.slackPublic(), manifest: manifestInfo() });
        }
        return send(req, res, 200, { slack: store.slackPublic(), manifest: manifestInfo(), revoked, secretStays: store.slackSource() === 'secrets' });
      }
      const token = typeof b.token === 'string' ? b.token.trim() : '';
      if (/^xoxb-/.test(token)) return send(req, res, 400, { error: 'That’s the Bot token. Use the User OAuth Token (xoxp-…): a bot can’t post in your DM with Viktor.', code: 'BOT_TOKEN' });
      if (/^xoxe/.test(token)) return send(req, res, 400, { error: 'This token expires every 12 hours (token rotation is on). Create the app again from the manifest.', code: 'ROTATING_TOKEN' });
      if (token.length > 512 || /\s/.test(token) || !/^xoxp-[A-Za-z0-9-]{20,}$/.test(token)) return send(req, res, 400, { error: 'That doesn’t look like a User OAuth Token. Copy it again from your Slack app’s OAuth & Permissions page: it starts with xoxp-.', code: 'BAD_TOKEN' });
      let checked;
      try {
        checked = await authTest(token);
      } catch (e) {
        if (e instanceof SlackError && (e.code === 'BAD_TOKEN' || e.code === 'SLACK_ERROR')) return send(req, res, 400, { error: `Slack didn’t accept that token: ${e.slack || 'invalid_auth'}.`, code: 'SLACK_AUTH' });
        return slackFail(req, res, e);
      }
      if (checked.payload.bot_id) return send(req, res, 400, { error: 'That’s the Bot token. Use the User OAuth Token (xoxp-…): a bot can’t post in your DM with Viktor.', code: 'BOT_TOKEN' });
      const prev = store.slack();
      const otherTeam = prev.verified?.teamId && prev.verified.teamId !== checked.verified.teamId;
      store.setSlack({ token, verified: checked.verified, problem: null, ...(otherTeam ? { viktor: null, where: null } : {}) });
      try {
        await store.persisted();
      } catch (e) {
        return send(req, res, 502, { error: `${e.message} The change works on this server for now, but may be lost when the app restarts.`, code: 'NOT_SAVED', slack: store.slackPublic(), manifest: manifestInfo() });
      }
      return send(req, res, 200, { slack: store.slackPublic(), manifest: manifestInfo() });
    }

    if (p === '/api/ai/slack/bots' && m === 'GET') {
      if (!settingsAllowed(req, res, who)) return;
      const token = await tokenNow();
      if (!token) return notReady(req, res, 'no_token');
      try {
        const v = await ensureVerified(token);
        if (botsCache && botsCache.team === v.teamId && Date.now() - botsCache.at < BOTS_CACHE_MS) return send(req, res, 200, botsCache.value);
        const members = [];
        let cursor = '';
        let truncated = false;
        for (let page = 0; ; page++) {
          if (page >= 10) {
            truncated = true;
            break;
          }
          const r = await api.call('users.list', { limit: 200, ...(cursor ? { cursor } : {}) }, { token });
          members.push(...(Array.isArray(r.members) ? r.members : []));
          cursor = String(r.response_metadata?.next_cursor ?? '');
          if (!cursor) break;
        }
        const bots = members
          .filter((u) => u?.is_bot && !u.deleted && u.id !== 'USLACKBOT')
          .map((u) => {
            const displayName = String(u.profile?.display_name ?? '');
            const realName = String(u.real_name ?? u.profile?.real_name ?? '');
            const name = String(u.name ?? '');
            return { userId: String(u.id), ...(u.profile?.bot_id ? { botId: String(u.profile.bot_id) } : {}), name, realName, displayName, suggested: /\bviktor\b/i.test(`${name} ${realName} ${displayName}`) };
          })
          .sort((a, b) => Number(b.suggested) - Number(a.suggested) || (a.displayName || a.realName || a.name).localeCompare(b.displayName || b.realName || b.name));
        const value = { bots, truncated };
        botsCache = { team: v.teamId, at: Date.now(), value };
        return send(req, res, 200, value);
      } catch (e) {
        return slackFail(req, res, e);
      }
    }

    if (p === '/api/ai/slack/viktor' && m === 'PUT') {
      if (!settingsAllowed(req, res, who)) return;
      const b = await body(req, res);
      if (!b) return;
      const userId = typeof b.userId === 'string' ? b.userId.trim() : '';
      if (!SLACK_ID_RE.test(userId)) return send(req, res, 400, { error: 'That isn’t a Slack member ID (it looks like U0123ABCD). In Slack, open Viktor’s profile → ⋯ → Copy member ID.', code: 'BAD_REQUEST' });
      const token = await tokenNow();
      if (!token) return notReady(req, res, 'no_token');
      try {
        await ensureVerified(token);
        let user;
        try {
          user = (await api.call('users.info', { user: userId }, { token })).user;
        } catch (e) {
          if (e instanceof SlackError && e.slack === 'user_not_found') return send(req, res, 400, { error: 'Slack has no member with that ID in this workspace.', code: 'NOT_A_BOT' });
          throw e;
        }
        if (!user?.is_bot || user.deleted) return send(req, res, 400, { error: 'That member isn’t a bot (Viktor is one): pick Viktor from the list, or copy Viktor’s member ID again.', code: 'NOT_A_BOT' });
        const botId = user.profile?.bot_id ? String(user.profile.bot_id) : '';
        let appId = '';
        if (botId) {
          try {
            appId = String((await api.call('bots.info', { bot: botId }, { token })).bot?.app_id ?? '');
          } catch {
            /* the bot id is enough */
          }
        }
        const viktor = { userId, ...(botId ? { botId } : {}), ...(appId ? { appId } : {}), name: String(user.profile?.display_name || user.real_name || user.name || 'Viktor') };
        let where = store.slack().where ?? null;
        if (where?.kind === 'dm') {
          const open = await api.call('conversations.open', { users: userId, return_im: true }, { token });
          where = { kind: 'dm', channelId: String(open.channel?.id ?? '') };
        }
        await store.refresh({ force: true });
        store.setSlack({ viktor, ...(where ? { where } : {}) });
        await store.persisted().catch(() => {});
        return send(req, res, 200, { slack: store.slackPublic(), manifest: manifestInfo() });
      } catch (e) {
        return slackFail(req, res, e);
      }
    }

    if (p === '/api/ai/slack/channels' && m === 'GET') {
      if (!settingsAllowed(req, res, who)) return;
      const token = await tokenNow();
      if (!token) return notReady(req, res, 'no_token');
      try {
        const v = await ensureVerified(token);
        if (!hasChannelScopes(v.scopes)) return send(req, res, 409, { error: 'Install the app again and allow the channel permissions to use a channel.', code: 'MISSING_SCOPES', needed: missingFor(v.scopes, 'channel') });
        const types = v.scopes.includes('groups:read') ? 'public_channel,private_channel' : 'public_channel';
        const channels = [];
        let cursor = '';
        let truncated = false;
        for (let page = 0; ; page++) {
          if (page >= 5) {
            truncated = true;
            break;
          }
          const r = await api.call('users.conversations', { types, exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) }, { token });
          for (const c of Array.isArray(r.channels) ? r.channels : []) if (c?.id && CHANNEL_RE.test(c.id)) channels.push({ id: String(c.id), name: String(c.name ?? ''), private: !!c.is_private });
          cursor = String(r.response_metadata?.next_cursor ?? '');
          if (!cursor) break;
        }
        channels.sort((a, b) => a.name.localeCompare(b.name));
        return send(req, res, 200, { channels, truncated });
      } catch (e) {
        return slackFail(req, res, e);
      }
    }

    if (p === '/api/ai/slack/where' && m === 'PUT') {
      if (!settingsAllowed(req, res, who)) return;
      const b = await body(req, res);
      if (!b) return;
      const token = await tokenNow();
      if (!token) return notReady(req, res, 'no_token');
      const viktor = store.slack().viktor;
      if (!viktor?.userId) return send(req, res, 409, { error: 'Choose Viktor first.', code: 'NO_VIKTOR' });
      try {
        const v = await ensureVerified(token);
        let where;
        if (b.kind === 'dm') {
          const open = await api.call('conversations.open', { users: viktor.userId, return_im: true }, { token });
          const channelId = String(open.channel?.id ?? '');
          if (!channelId) return send(req, res, 502, { error: 'Slack didn’t open the DM with Viktor.', code: 'NETWORK' });
          where = { kind: 'dm', channelId };
        } else if (b.kind === 'channel') {
          const channelId = typeof b.channelId === 'string' ? b.channelId : '';
          if (!CHANNEL_RE.test(channelId)) return send(req, res, 400, { error: 'Choose a channel.', code: 'BAD_REQUEST' });
          if (!hasChannelScopes(v.scopes)) return send(req, res, 409, { error: 'Install the app again and allow the channel permissions to use a channel.', code: 'MISSING_SCOPES', needed: missingFor(v.scopes, 'channel') });
          const info = (await api.call('conversations.info', { channel: channelId }, { token })).channel ?? {};
          if (info.is_archived) return send(req, res, 409, { error: 'That channel is archived.', code: 'ARCHIVED' });
          const name = String(info.name ?? '');
          const isPrivate = !!info.is_private;
          if (isPrivate && missingFor(v.scopes, 'channel', true).length) return send(req, res, 409, { error: 'For a private channel, install the app again and allow the private channel permissions.', code: 'MISSING_SCOPES', needed: missingFor(v.scopes, 'channel', true) });
          let found = false;
          let cursor = '';
          for (let page = 0; page < 5 && !found; page++) {
            const r = await api.call('conversations.members', { channel: channelId, limit: 200, ...(cursor ? { cursor } : {}) }, { token });
            found = (Array.isArray(r.members) ? r.members : []).includes(viktor.userId);
            cursor = String(r.response_metadata?.next_cursor ?? '');
            if (!cursor) break;
          }
          if (!found) return send(req, res, 409, { error: `Invite Viktor first: type /invite @${viktor.name || 'Viktor'} in #${name || 'the channel'}.`, code: 'VIKTOR_NOT_IN_CHANNEL' });
          where = { kind: 'channel', channelId, name, private: isPrivate };
        } else return send(req, res, 400, { error: 'Choose your DM with Viktor or a channel.', code: 'BAD_REQUEST' });
        await store.refresh({ force: true });
        store.setSlack({ where });
        await store.persisted().catch(() => {});
        return send(req, res, 200, { slack: store.slackPublic(), manifest: manifestInfo() });
      } catch (e) {
        return slackFail(req, res, e);
      }
    }

    if (p === '/api/ai/slack/test' && m === 'POST') {
      if (!settingsAllowed(req, res, who)) return;
      const checks = [];
      const add = (id, ok, text) => checks.push({ id, ok, text });
      const token = await tokenNow();
      if (!token) {
        add('token', false, 'No token yet: paste the User OAuth Token above, or add the SLACK_USER_TOKEN Secret.');
        return send(req, res, 200, { ok: false, checks });
      }
      let v = null;
      try {
        v = await refreshVerified(token);
        add('token', true, `Connected to ${v.team || 'your workspace'} as ${v.user || 'you'}.`);
      } catch (e) {
        add('token', false, e instanceof SlackError && e.code === 'BAD_TOKEN' ? 'Slack didn’t accept the token: connect again with a new User OAuth Token.' : `Couldn’t check the token: ${e.message}`);
        return send(req, res, 200, { ok: false, checks });
      }
      const conn = store.slack();
      const where = conn.where;
      const missing = missingFor(v.scopes, where?.kind === 'channel' ? 'channel' : 'dm', !!where?.private);
      add('scopes', !missing.length, missing.length ? `Missing permissions: ${missing.join(', ')}. Create the app again from the manifest and install it.` : 'The app has the permissions it needs.');
      const viktor = conn.viktor;
      if (!viktor?.userId) add('viktor', false, 'Choose Viktor: press Find Viktor.');
      else {
        try {
          const u = (await api.call('users.info', { user: viktor.userId }, { token })).user;
          add('viktor', !!u?.is_bot && !u.deleted, u?.is_bot && !u.deleted ? `Viktor: ${viktor.name || u.name} (${viktor.userId}).` : 'The member chosen as Viktor isn’t a bot any more: choose Viktor again.');
        } catch (e) {
          add('viktor', false, `Couldn’t find Viktor: ${e.message}`);
        }
      }
      if (!where?.channelId) add('place', false, 'Choose where to talk to Viktor: your DM, or a channel Viktor is in.');
      else {
        let placeOk = true;
        if (where.kind === 'channel' && viktor?.userId) {
          try {
            const r = await api.call('conversations.members', { channel: where.channelId, limit: 200 }, { token });
            placeOk = (Array.isArray(r.members) ? r.members : []).includes(viktor.userId);
          } catch {
            placeOk = false;
          }
          add('place', placeOk, placeOk ? `#${where.name}: Viktor is in it.` : `Viktor isn’t in #${where.name}: type /invite @${viktor.name || 'Viktor'} there.`);
        } else add('place', true, where.kind === 'dm' ? 'Your DM with Viktor.' : `#${where.name}.`);
        try {
          await api.call('conversations.history', { channel: where.channelId, limit: 1 }, { token });
          add('read', true, 'The app can read the conversation.');
        } catch (e) {
          add('read', false, `The app can’t read the conversation: ${e instanceof SlackError && e.slack ? e.slack : e.message}.`);
        }
      }
      return send(req, res, 200, { ok: checks.every((c) => c.ok), checks });
    }

    // ── Work ──
    if (p === '/api/ai/slack/attach' && m === 'POST') {
      if (!workAllowed(req, res, 'slack', who)) return;
      const token = await tokenNow();
      const r = store.slackReadiness();
      if (!token || r.reason === 'no_token' || r.reason === 'bad_token' || r.reason === 'missing_scopes') return notReady(req, res, token ? r.reason : 'no_token');
      const filename = url.searchParams.get('filename') ?? '';
      const fm = IMAGE_FILE_RE.exec(filename);
      if (!fm) return send(req, res, 400, { error: 'Images go to Slack named img-1.jpg … img-99.png.', code: 'BAD_REQUEST' });
      const declared = Number(req.headers['content-length'] || 0);
      if (!declared) return send(req, res, 411, { error: 'The image’s size is missing.', code: 'BAD_REQUEST' });
      if (declared > MAX_IMAGE_BYTES) return send(req, res, 413, { error: 'That image is over 4 MB.', code: 'TOO_BIG' });
      let bytes;
      try {
        bytes = await readRaw(req, MAX_IMAGE_BYTES);
      } catch (e) {
        return send(req, res, e.status || 400, { error: e.message, code: e.status === 413 ? 'TOO_BIG' : 'BAD_REQUEST' });
      }
      const type = sniffImage(bytes);
      if (!type || type !== EXT_TYPE[fm[2].toLowerCase()]) return send(req, res, 415, { error: 'That file isn’t the image its name says.', code: 'NOT_IMAGE' });
      const alt = (url.searchParams.get('alt') ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 1000);
      try {
        const up = await api.call('files.getUploadURLExternal', { filename, length: bytes.length, ...(alt ? { alt_txt: alt } : {}) }, { token });
        const fileId = String(up.file_id ?? '');
        if (!SLACK_FILE_RE.test(fileId)) return send(req, res, 502, { error: 'Slack didn’t give the image an id.', code: 'SLACK_ERROR' });
        await api.uploadBytes(up.upload_url, bytes, { signal: abortOnClose(res) });
        return send(req, res, 200, { file_id: fileId, filename });
      } catch (e) {
        if (e instanceof SlackError && (e.code === 'UPLOAD' || e.code === 'SLACK_UNCERTAIN' || e.code === 'TIMEOUT' || e.code === 'NETWORK' || e.code === 'UPSTREAM' || e.code === 'CUT_OFF')) {
          // nothing is visible in Slack until the message is sent: not sent
          return send(req, res, 502, { error: e.message, code: 'SLACK_ERROR', slack: e.slack || 'upload_failed' });
        }
        return slackFail(req, res, e);
      }
    }

    if (p === '/api/ai/slack/send' && m === 'POST') {
      if (!workAllowed(req, res, 'slack', who)) return;
      const b = await body(req, res);
      if (!b) return;
      const kind = b.kind;
      if (!['build', 'edit', 'answer', 'followup', 'chat'].includes(kind)) return send(req, res, 400, { error: 'What kind of message is it?', code: 'BAD_REQUEST' });
      const ref = typeof b.ref === 'string' ? b.ref : '';
      if (!REF_RE.test(ref)) return send(req, res, 400, { error: 'The message needs its Ref.', code: 'BAD_REQUEST' });
      const dryRun = b.dryRun === true;
      // a reply goes to a thread this app started, of the right kind
      let t = null;
      if (kind !== 'build' && !(kind === 'chat' && !b.threadId)) {
        t = await ownThread(req, res, who, b.threadId);
        if (!t) return;
        if (t.kind !== (kind === 'chat' ? 'chat' : 'build')) return send(req, res, 404, { error: kind === 'chat' ? 'That thread isn’t a chat with Viktor.' : 'That thread isn’t a build with Viktor.', code: 'NOT_FOUND' });
      }
      const token = await tokenNow();
      const ready = store.slackReadiness();
      if (!token) return notReady(req, res, 'no_token');
      if (!t && !ready.ready) return notReady(req, res, ready.reason);
      if (t && (ready.reason === 'bad_token' || ready.reason === 'missing_scopes' || ready.reason === 'no_viktor')) return notReady(req, res, ready.reason);
      const conn = store.slack();
      const viktor = conn.viktor;
      const place = t ? t.place : conn.where.kind;
      const mention = !t && place === 'channel' ? viktor.userId : '';
      let parts;
      let target;
      try {
        if (kind === 'build') {
          const build = cleanBuild(b.build, 'viktor');
          target = build.target;
          parts = viktorBuildParts(build, { ref, mention });
        } else if (kind === 'edit') parts = viktorEditParts(cleanEdit(b.edit, 'viktor'), { ref });
        else if (kind === 'answer') parts = viktorAnswerParts(cleanAnswer(b.text, 'viktor'), { ref });
        else if (kind === 'followup') {
          if (b.followup !== 'missing_file') return send(req, res, 400, { error: 'Unknown follow-up.', code: 'BAD_REQUEST' });
          parts = viktorFollowupParts({ ref });
        } else parts = viktorChatParts(cleanChat(b.chat, 'viktor'), { ref, first: !t, mention });
      } catch (e) {
        if (e instanceof TemplateError) return templateRefusal(req, res, e);
        throw e;
      }
      const text = renderParts(parts);
      if (text.length > SLACK_LIMIT) return send(req, res, 413, { error: `Too long for one Slack message (${text.length} of ${SLACK_LIMIT} characters).`, code: 'TOO_LONG', chars: text.length, limit: SLACK_LIMIT });
      if (dryRun) return send(req, res, 200, { preview: { text: readableParts(parts, { viktorName: viktor?.name }), chars: text.length, limit: SLACK_LIMIT } });

      const files = Array.isArray(b.files) ? b.files : [];
      if (files.length > 8 || (kind === 'followup' && files.length)) return send(req, res, 400, { error: 'At most 8 images go with one message.', code: 'BAD_REQUEST' });
      const fileList = [];
      for (const f of files) {
        if (!f || typeof f.file_id !== 'string' || !SLACK_FILE_RE.test(f.file_id)) return send(req, res, 400, { error: 'An image wasn’t sent to Slack first.', code: 'BAD_REQUEST' });
        fileList.push({ id: f.file_id, title: typeof f.title === 'string' && IMAGE_KEY_RE.test(f.title) ? f.title : 'image' });
      }

      let owner;
      try {
        owner = await ensureVerified(token);
      } catch (e) {
        return slackFail(req, res, e);
      }
      const channel = t ? t.channel : conn.where.channelId;
      let parentTs = null;
      if (t) {
        const located = await locateParent(t, token);
        parentTs = located.ts;
        if (!parentTs) return send(req, res, 409, { error: 'The first message of this thread isn’t found in Slack yet. Try again in a moment.', code: 'NOT_LOCATED' });
      }
      // at most 6 posts a minute: counted before sending, and nothing is sent over it
      const capKey = who?.id ?? 'owner';
      const now = Date.now();
      const recent = (posts.get(capKey) ?? []).filter((x) => now - x < 60_000);
      if (recent.length >= POSTS_PER_MINUTE) return send(req, res, 429, { error: 'That’s 6 messages to Viktor in a minute. Wait a moment before sending more.', code: 'RATE_LIMIT', retryAfter: Math.max(1, Math.ceil((60_000 - (now - recent[0])) / 1000)) });
      recent.push(now);
      posts.set(capKey, recent);

      // one visible write, never repeated
      const sentAt = Date.now();
      let ts = null;
      try {
        if (!fileList.length) {
          const r = await api.call('chat.postMessage', { channel, text, unfurl_links: false, unfurl_media: false, ...(parentTs ? { thread_ts: parentTs } : {}) }, { token, json: true, write: true });
          ts = r.ts ? String(r.ts) : null;
        } else {
          const r = await api.call('files.completeUploadExternal', { files: fileList, channel_id: channel, initial_comment: text, ...(parentTs ? { thread_ts: parentTs } : {}) }, { token, json: true, write: true });
          ts = await locateUpload({ token, channel, parentTs, fileIds: fileList.map((f) => f.id), sentAt, ownerId: owner.userId, answer: r });
        }
      } catch (e) {
        return sendFail(req, res, e, { ref, sentAt });
      }
      const entry = { ts, ref, at: sentAt, kind };
      let saved;
      if (!t) {
        saved = threads.add({ id: ThreadRegistry.newId(), owner: who?.id ?? null, channel, place, ts, kind: kind === 'build' ? 'build' : 'chat', ...(target ? { target } : {}), sent: [entry], ...(ts ? {} : { unlocated: { ref, sentAt } }) });
      } else saved = threads.update(t.id, (x) => x.sent.push(entry));
      // the thread must be in Supabase before the app asks another copy of the server about it
      await threads.saved();
      reads.delete(saved.id);
      const permalink = await permalinkFor(saved, token);
      return send(req, res, 200, { thread: { id: saved.id, permalink, channel: saved.channel, kind: saved.kind }, message: { ts, located: !!ts }, sentAt });
    }

    if (p === '/api/ai/slack/read' && m === 'POST') {
      if (!workAllowed(req, res, 'slack-read', who)) return;
      const b = await body(req, res);
      if (!b) return;
      const ids = Array.isArray(b.threadIds) ? [...new Set(b.threadIds)] : [];
      if (!ids.length || ids.length > 6 || ids.some((id) => typeof id !== 'string' || !THREAD_RE.test(id))) return send(req, res, 400, { error: 'Send 1 to 6 thread ids.', code: 'BAD_REQUEST' });
      const token = await tokenNow();
      if (!token) return notReady(req, res, 'no_token');
      try {
        await ensureVerified(token);
      } catch (e) {
        return slackFail(req, res, e);
      }
      const results = new Map();
      const errors = {};
      await Promise.all(
        ids.map(async (id) => {
          await threads.ensure(id);
          const t = threads.get(id);
          if (!t || !mayUse(req, t.owner, who)) {
            errors[id] = { code: 'NOT_FOUND', message: 'This thread is older than 30 days, or wasn’t started by this app.' };
            return;
          }
          try {
            results.set(id, (await readThread(t, token)).read);
          } catch (e) {
            noteProblem(e);
            const code = e instanceof SlackError ? (e.code === 'RATE_LIMIT' ? 'RATE_LIMIT' : e.code === 'BAD_TOKEN' || e.code === 'MISSING_SCOPE' ? 'SETUP' : 'NETWORK') : 'NETWORK';
            errors[id] = { code, message: e.message || 'Couldn’t read the thread.' };
          }
        }),
      );
      const threadsOut = ids.filter((id) => results.has(id)).map((id) => results.get(id));
      if (!threadsOut.length && Object.values(errors).length && Object.values(errors).every((e) => e.code === 'RATE_LIMIT')) return send(req, res, 429, { error: 'Slack asked the app to slow down. Try again in a minute.', code: 'RATE_LIMIT', retryAfter: 30 });
      return send(req, res, 200, { threads: threadsOut, errors });
    }

    if (p === '/api/ai/slack/verify' && m === 'POST') {
      if (!workAllowed(req, res, 'slack-read', who)) return;
      const b = await body(req, res);
      if (!b) return;
      const ref = typeof b.ref === 'string' ? b.ref : '';
      const sentAt = Number(b.sentAt);
      if (!REF_RE.test(ref) || !Number.isFinite(sentAt) || sentAt <= 0) return send(req, res, 400, { error: 'Send the message’s Ref and when it was sent.', code: 'BAD_REQUEST' });
      const token = await tokenNow();
      if (!token) return notReady(req, res, 'no_token');
      try {
        const owner = await ensureVerified(token);
        const answer = async (t, ts) => {
          const permalink = await permalinkFor(t, token);
          return send(req, res, 200, { found: true, thread: { id: t.id, permalink, channel: t.channel, kind: t.kind }, message: { ts, located: true }, sentAt });
        };
        if (b.threadId) {
          const t = await ownThread(req, res, who, b.threadId);
          if (!t) return;
          const known = t.sent.find((s) => s.ref === ref && s.ts);
          if (known) return answer(t, known.ts);
          const located = await locateParent(t, token);
          if (!located.ts) return send(req, res, 200, { found: false });
          const { messages } = await repliesAll(located.channel, located.ts, token);
          const hit = messages.find((x) => x.user === owner.userId && endsWithRef(x.text, ref));
          if (!hit) return send(req, res, 200, { found: false });
          const updated = threads.update(t.id, (x) => {
            const s = x.sent.find((y) => y.ref === ref);
            if (s) s.ts = String(hit.ts);
            else x.sent.push({ ts: String(hit.ts), ref, at: sentAt, kind: x.kind === 'build' ? 'edit' : 'chat' });
          });
          await threads.saved();
          reads.delete(t.id);
          return answer(updated ?? t, String(hit.ts));
        }
        // a new thread: already found (or sent) by this server? Then it was delivered (its message may not be located yet)
        const mine = threads.all().find((x) => mayUse(req, x.owner, who) && x.sent.some((s) => s.ref === ref));
        if (mine) {
          const located = await locateParent(mine, token);
          const ts = located.sent.find((s) => s.ref === ref)?.ts ?? located.ts ?? null;
          if (ts) return answer(located, ts);
          return send(req, res, 200, { found: true, thread: { id: located.id, permalink: '', channel: located.channel, kind: located.kind }, message: { ts: null, located: false }, sentAt });
        }
        const channel = store.slack().where?.channelId;
        if (!channel) return notReady(req, res, 'no_place');
        const h = await api.call('conversations.history', { channel, oldest: (sentAt / 1000 - 120).toFixed(6), limit: 100 }, { token });
        const hit = (Array.isArray(h.messages) ? h.messages : []).find((x) => x.user === owner.userId && endsWithRef(x.text, ref) && (!x.thread_ts || x.thread_ts === x.ts));
        if (!hit) return send(req, res, 200, { found: false });
        const ts = String(hit.ts);
        const where = store.slack().where;
        const t = threads.add({ id: ThreadRegistry.newId(), owner: who?.id ?? null, channel, place: where?.kind === 'channel' ? 'channel' : 'dm', ts, kind: isBuildRequestText(hit.text) ? 'build' : 'chat', sent: [{ ts, ref, at: sentAt, kind: isBuildRequestText(hit.text) ? 'build' : 'chat' }] });
        await threads.saved();
        return answer(t, ts);
      } catch (e) {
        return slackFail(req, res, e);
      }
    }

    if ((p === '/api/ai/slack/html' || p === '/api/ai/slack/file') && m === 'POST') {
      if (!workAllowed(req, res, 'slack-read', who)) return;
      const b = await body(req, res);
      if (!b) return;
      const t = await ownThread(req, res, who, b.threadId);
      if (!t) return;
      const at = AT_RE.exec(typeof b.at === 'string' ? b.at : '');
      if (!at || (p === '/api/ai/slack/file' && !at[2])) return send(req, res, 400, { error: 'Which message or file?', code: 'BAD_REQUEST' });
      const token = await tokenNow();
      if (!token) return notReady(req, res, 'no_token');
      try {
        const { raw } = await readThread(t, token);
        const msg = raw.get(at[1]);
        if (!msg) return send(req, res, 404, { error: 'That message is gone from Slack.', code: 'NOT_FOUND' });
        if (p === '/api/ai/slack/html' && !at[2]) {
          const page = extractHtml({ blocks: msg.blocks, text: msg.text ?? '' });
          if (!page) return send(req, res, 404, { error: 'That message has no page in it.', code: 'NO_FILE' });
          if (page.tooBig) return send(req, res, 413, { error: 'The page is over 1.5 MB, too big to use. Ask for a smaller page.', code: 'TOO_BIG' });
          if (!page.complete) return send(req, res, 422, { error: 'Viktor sent only part of the page.', code: 'PARTIAL' });
          return send(req, res, 200, { html: page.html, filename: 'page.html', bytes: page.bytes, source: 'code' });
        }
        const f = (Array.isArray(msg.files) ? msg.files : []).find((x) => x?.id === at[2]);
        if (!f) return send(req, res, 404, { error: 'That file is gone from Slack.', code: 'NO_FILE' });
        const filename = String(f.name || f.title || 'file').slice(0, 160);
        // a file outside Slack (an app chose its address): never fetched with the token
        if (isExternalFile(f)) return send(req, res, 403, { error: 'That file lives outside Slack, so the app won’t fetch it. Ask Viktor to attach the file itself.', code: 'EXTERNAL_FILE' });
        const fileUrl = f.url_private_download || f.url_private;
        if (typeof fileUrl !== 'string' || !fileUrl) return send(req, res, 404, { error: 'Slack didn’t give an address for that file.', code: 'NO_FILE' });
        if (p === '/api/ai/slack/html') {
          if (!isHtmlFile(f)) return send(req, res, 415, { error: `Viktor sent ${filename}, not an HTML page.`, code: 'NOT_HTML', filename });
          if (Number(f.size) > MAX_HTML_BYTES) return send(req, res, 413, { error: 'The page is over 1.5 MB, too big to use. Ask for a smaller page.', code: 'TOO_BIG' });
        }
        let got;
        try {
          got = await api.downloadFile(fileUrl, { token, maxBytes: p === '/api/ai/slack/html' ? MAX_HTML_BYTES : MAX_FILE_BYTES, signal: abortOnClose(res) });
        } catch (e) {
          if (e instanceof SlackError && e.code === 'BAD_FILE_URL') return send(req, res, 403, { error: e.message, code: 'EXTERNAL_FILE' });
          if (e instanceof SlackError && e.code === 'TOO_BIG') return send(req, res, 413, { error: p === '/api/ai/slack/html' ? 'The page is over 1.5 MB, too big to use. Ask for a smaller page.' : 'That file is over 15 MB: open it in Slack instead.', code: 'TOO_BIG' });
          if (e instanceof SlackError && e.code === 'FILE_AUTH') return send(req, res, 502, { error: 'Slack didn’t send the file; the token may be missing files:read.', code: 'FILE_AUTH' });
          throw e;
        }
        // Slack answers a sign-in page when the token can't read files: the size and the content must match
        const sizeOff = Number.isFinite(f.size) && f.size > 0 && got.bytes.length !== f.size;
        if (p === '/api/ai/slack/html') {
          if (sizeOff) return send(req, res, 502, { error: 'Slack didn’t send the file; the token may be missing files:read.', code: 'FILE_AUTH' });
          const checked = checkHtmlBytes(got.bytes);
          if (!checked.ok) return send(req, res, checked.reason === 'too_big' ? 413 : 415, { error: checked.reason === 'too_big' ? 'The page is over 1.5 MB, too big to use.' : `${filename} isn’t a web page the app can read.`, code: checked.reason === 'too_big' ? 'TOO_BIG' : 'NOT_HTML', filename });
          return send(req, res, 200, { html: checked.html, filename, bytes: got.bytes.length, source: 'file' });
        }
        const sniffed = sniffImage(got.bytes);
        if (sizeOff || (fileKind(f) === 'image' && (!sniffed || got.contentType === 'text/html'))) return send(req, res, 502, { error: 'Slack didn’t send the file; the token may be missing files:read.', code: 'FILE_AUTH' });
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': got.bytes.length,
          'content-disposition': `attachment; filename="${safeName(filename)}"`,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
          'x-file-type': sniffed ?? 'application/octet-stream',
          'access-control-expose-headers': 'x-file-type',
          ...corsHeaders(req),
        });
        return res.end(got.bytes);
      } catch (e) {
        return slackFail(req, res, e);
      }
    }

    return send(req, res, 404, { error: 'Not found.', code: 'NOT_FOUND' });
  }

  return {
    threads,
    match: (url) => url.pathname === '/api/ai/slack' || url.pathname.startsWith('/api/ai/slack/'),
    handle,
    /** For /api/health: whether Viktor can be used, from what's saved (no Slack call). */
    health: () => store.slackReadiness(),
    envKey: SLACK_ENV,
  };
}
