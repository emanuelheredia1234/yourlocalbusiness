// Viktor through the owner's own Slack app: the token kept like the AI keys (never sent anywhere but Slack),
// the one place messages go, one-shot writes (an uncertain one settled by a read, never sent twice), reading
// only the threads the app started, and pages and files fetched safely. Against the Slack stand-in
// (server/test/mock-slack.mjs) and, for storage, the Supabase stand-in.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createAIRoutes } from '../providers/routes.mjs';
import { AIStore } from '../providers/store.mjs';
import { scrubKeys } from '../providers/http.mjs';
import { createAppState } from '../appState.mjs';
import { SLACK_QA, createMockProviders } from '../test/mock-providers.mjs';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { CREATE_URL, MANIFEST_YAML, MANIFEST } from './manifest.mjs';
import { tsCompare } from './format.mjs';

const OWNER = SLACK_QA.tokens.owner;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(80, 7)]);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-slack-'));

let mock;
beforeAll(async () => {
  mock = await createMockProviders({ keys: { manus: 'mn-key-6666' } }).start();
});
afterAll(() => mock.close());
beforeEach(() => {
  mock.reset();
  mock.slack.reset();
});

const slackCalls = (method) => mock.calls.filter((c) => c.provider === 'slack' && c.path === `/api/${method}`);

/** An app with the AI routes (Slack inside), on its own port. */
async function startApp({ env = {}, adminToken = 'admin-secret-token', auth, appState, logs = [] } = {}) {
  const dataDir = tmpDir();
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'));
        } catch {
          reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
        }
      });
    });
  const log = { debug: (s) => logs.push(String(s)), error: (e) => logs.push(String(e?.stack ?? e)) };
  const ai = createAIRoutes({ send, readJson, corsHeaders: () => ({}), rateLimited: () => false, dataDir, adminToken, env, baseUrls: mock.baseUrls(), ...(auth ? { auth } : {}), ...(appState ? { appState } : {}), slackOptions: { locateDelays: [0, 5, 5, 5], readCacheMs: 0, timeouts: { write: 400 }, topLevelAfterMs: 0, log } });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    ai.handle(req, res, url).then((h) => h === false && send(res, 404, { error: 'Not found' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const answers = [];
  const call = async (p, { method = 'POST', body, headers = {}, raw } = {}) => {
    const r = await fetch(`${base}${p}`, { method, headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await r.text();
    answers.push(text);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* bytes */
    }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { ai, server, base, dataDir, call, answers, logs, close: () => new Promise((r) => server.close(r)) };
}

async function connect(app, { token = OWNER, where = 'dm' } = {}) {
  expect((await app.call('/api/ai/slack', { method: 'PUT', body: { token } })).status).toBe(200);
  expect((await app.call('/api/ai/slack/viktor', { method: 'PUT', body: { userId: SLACK_QA.viktor } })).status).toBe(200);
  const w = await app.call('/api/ai/slack/where', { method: 'PUT', body: where === 'dm' ? { kind: 'dm' } : { kind: 'channel', channelId: SLACK_QA.channel } });
  expect(w.status).toBe(200);
  return w.json.slack;
}

const BUILD = { target: 'asset', kind: 'booking', facts: [{ id: 'name', value: 'Bean & Leaf' }], website: 'https://beanleaf.example', request: 'A booking widget for my yoga classes', images: [] };
let refN = 0;
const ref = () => `ylb-T${String(++refN).padStart(5, '0')}`;
const sendBuild = (app, request, o = {}) => app.call('/api/ai/slack/send', { body: { kind: 'build', build: { ...BUILD, request, ...(o.images ? { images: o.images } : {}) }, ref: o.ref ?? ref(), ...(o.files ? { files: o.files } : {}) } });
const read = async (app, id) => {
  const r = await app.call('/api/ai/slack/read', { body: { threadIds: [id] } });
  expect(r.status).toBe(200);
  return r.json.threads[0] ?? r.json.errors[id];
};

describe('the manifest', () => {
  it('asks for user scopes only, with the channel ones optional, and token rotation off', () => {
    expect(MANIFEST.display_information.name.length).toBeLessThanOrEqual(35);
    expect(MANIFEST.display_information.description.length).toBeLessThan(140);
    expect(MANIFEST.oauth_config.scopes.user).toEqual(['chat:write', 'im:write', 'im:history', 'users:read', 'files:write', 'files:read', 'channels:history', 'groups:history', 'channels:read', 'groups:read']);
    expect(MANIFEST.oauth_config.scopes.user_optional).toEqual(['channels:history', 'groups:history', 'channels:read', 'groups:read']);
    expect(MANIFEST_YAML).toContain('token_rotation_enabled: false');
    expect(MANIFEST_YAML).not.toContain('bot');
    expect(CREATE_URL).toBe(`https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(MANIFEST_YAML)}`);
  });
});

describe('the token', () => {
  it('is checked, saved, masked, and never sent back; the Secret wins', async () => {
    const app = await startApp();
    try {
      let r = await app.call('/api/ai/slack', { method: 'GET' });
      expect(r.json.slack).toMatchObject({ configured: false, reason: 'no_token', ready: false });
      expect(r.json.manifest.createUrl).toBe(CREATE_URL);
      r = await app.call('/api/ai/slack', { method: 'PUT', body: { token: 'xo\x78b-qa-bot-000000000004' } });
      expect(r).toMatchObject({ status: 400, json: { code: 'BOT_TOKEN' } });
      r = await app.call('/api/ai/slack', { method: 'PUT', body: { token: 'xo\x78e.xo\x78p-1-abcdefghijklmnopqrstuvwxyz' } });
      expect(r).toMatchObject({ status: 400, json: { code: 'ROTATING_TOKEN' } });
      r = await app.call('/api/ai/slack', { method: 'PUT', body: { token: 'xo\x78p-not-a-real-token-000000' } });
      expect(r).toMatchObject({ status: 400, json: { code: 'SLACK_AUTH' } });
      r = await app.call('/api/ai/slack', { method: 'PUT', body: { token: 'hello world' } });
      expect(r).toMatchObject({ status: 400, json: { code: 'BAD_TOKEN' } });
      r = await app.call('/api/ai/slack', { method: 'PUT', body: { token: OWNER } });
      expect(r.status).toBe(200);
      expect(r.json.slack).toMatchObject({ configured: true, source: 'app', tokenHint: '••••0001', team: 'QA Workspace', user: 'owner', userId: SLACK_QA.owner, reason: 'no_viktor', channelScopes: true, missingScopes: [] });
      // kept on disk privately
      const file = path.join(app.dataDir, 'ai-providers.json');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).connections.slack.token).toBe(OWNER);
      // missing permissions are named
      r = await app.call('/api/ai/slack', { method: 'PUT', body: { token: SLACK_QA.tokens.noScope } });
      expect(r.json.slack).toMatchObject({ reason: 'missing_scopes', missingScopes: ['files:read'] });
      r = await app.call('/api/ai/slack', { method: 'PUT', body: { removeToken: true, revoke: true } });
      expect(r.json).toMatchObject({ revoked: true, slack: { configured: false } });
      expect(slackCalls('auth.revoke')).toHaveLength(1);
    } finally {
      await app.close();
    }
    const secret = await startApp({ env: { SLACK_USER_TOKEN: OWNER } });
    try {
      await secret.call('/api/ai/slack', { method: 'PUT', body: { token: SLACK_QA.tokens.dmOnly } });
      const r = await secret.call('/api/ai/slack', { method: 'GET' });
      expect(r.json.slack).toMatchObject({ source: 'secrets', envKey: 'SLACK_USER_TOKEN', tokenHint: '••••0001' });
      expect(secret.ai.store.slackToken()).toBe(OWNER);
      for (const a of secret.answers) for (const t of Object.values(SLACK_QA.tokens)) expect(a).not.toContain(t);
    } finally {
      await secret.close();
    }
  });

  it('survives a reload from Supabase (adopt keeps the connection), and another copy of the server sees it', async () => {
    const supa = await (await createMockSupabase()).start();
    try {
      const appState = createAppState({ supabaseUrl: supa.url, secretKey: supa.SECRET });
      const a = new AIStore(path.join(tmpDir(), 'a.json'), { env: {}, remote: appState });
      await a.loadRemote();
      a.setSlack({ token: OWNER, viktor: { userId: SLACK_QA.viktor, name: 'Viktor' } });
      await a.persisted();
      // a store left with an older copy: the next load from Supabase must keep the connection
      a.adopt(JSON.parse(JSON.stringify(a.state)));
      expect(a.slackToken()).toBe(OWNER);
      const b = new AIStore(path.join(tmpDir(), 'b.json'), { env: {}, remote: appState });
      expect(b.slackToken()).toBe('');
      await b.refresh({ force: true });
      expect(b.slackToken()).toBe(OWNER);
      expect(b.slack()).toMatchObject({ viktor: { userId: SLACK_QA.viktor } });
      expect(JSON.stringify(b.slack())).not.toContain(OWNER);
      expect(JSON.stringify(b.slackPublic())).not.toContain(OWNER);
      // saving keys afterwards keeps it
      b.update('openai', { apiKey: 'sk-test-1234567890' });
      await b.persisted();
      const c = new AIStore(path.join(tmpDir(), 'c.json'), { env: {}, remote: appState });
      await c.loadRemote();
      expect(c.slackToken()).toBe(OWNER);
    } finally {
      await supa.close();
    }
  });
});

describe('finding Viktor and the place', () => {
  it('lists the bots (pages of 2) with Viktor first, saves Viktor, and opens the DM', async () => {
    const app = await startApp();
    try {
      await app.call('/api/ai/slack', { method: 'PUT', body: { token: OWNER } });
      const r = await app.call('/api/ai/slack/bots', { method: 'GET' });
      expect(r.json.bots.map((b) => b.userId)).toEqual([SLACK_QA.viktor, SLACK_QA.other]);
      expect(r.json.bots[0]).toMatchObject({ suggested: true, botId: SLACK_QA.viktorBot, displayName: 'Viktor' });
      expect(slackCalls('users.list').length).toBeGreaterThan(2);
      expect((await app.call('/api/ai/slack/viktor', { method: 'PUT', body: { userId: SLACK_QA.human } })).json).toMatchObject({ code: 'NOT_A_BOT' });
      expect((await app.call('/api/ai/slack/where', { method: 'PUT', body: { kind: 'dm' } })).json).toMatchObject({ code: 'NO_VIKTOR' });
      const slack = await connect(app);
      expect(slack).toMatchObject({ ready: true, reason: 'ok', viktor: { userId: SLACK_QA.viktor, name: 'Viktor' }, where: { kind: 'dm', channelId: SLACK_QA.dm } });
      expect(app.ai.store.slack().viktor).toMatchObject({ botId: SLACK_QA.viktorBot, appId: SLACK_QA.viktorApp });
      // Test connection only reads
      const t = await app.call('/api/ai/slack/test');
      expect(t.json.ok).toBe(true);
      expect(t.json.checks.map((c) => c.id)).toEqual(['token', 'scopes', 'viktor', 'place', 'read']);
      expect(slackCalls('chat.postMessage')).toHaveLength(0);
      expect(slackCalls('files.completeUploadExternal')).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('a channel needs the channel permissions and Viktor in it', async () => {
    const app = await startApp();
    try {
      await app.call('/api/ai/slack', { method: 'PUT', body: { token: SLACK_QA.tokens.dmOnly } });
      await app.call('/api/ai/slack/viktor', { method: 'PUT', body: { userId: SLACK_QA.viktor } });
      expect((await app.call('/api/ai/slack', { method: 'GET' })).json.slack.channelScopes).toBe(false);
      expect((await app.call('/api/ai/slack/channels', { method: 'GET' })).json).toMatchObject({ code: 'MISSING_SCOPES' });
      expect((await app.call('/api/ai/slack/where', { method: 'PUT', body: { kind: 'channel', channelId: SLACK_QA.channel } })).json).toMatchObject({ code: 'MISSING_SCOPES' });
      await app.call('/api/ai/slack', { method: 'PUT', body: { token: OWNER } });
      const list = await app.call('/api/ai/slack/channels', { method: 'GET' });
      expect(list.json.channels).toEqual([
        { id: SLACK_QA.general, name: 'general', private: false },
        { id: SLACK_QA.private, name: 'team', private: true },
        { id: SLACK_QA.channel, name: 'viktor-builds', private: false },
      ]);
      const no = await app.call('/api/ai/slack/where', { method: 'PUT', body: { kind: 'channel', channelId: SLACK_QA.general } });
      expect(no).toMatchObject({ status: 409, json: { code: 'VIKTOR_NOT_IN_CHANNEL', error: 'Invite Viktor first: type /invite @Viktor in #general.' } });
      const ok = await app.call('/api/ai/slack/where', { method: 'PUT', body: { kind: 'channel', channelId: SLACK_QA.channel } });
      expect(ok.json.slack).toMatchObject({ ready: true, where: { kind: 'channel', channelId: SLACK_QA.channel, name: 'viktor-builds' } });
    } finally {
      await app.close();
    }
  });
});

describe('sending', () => {
  it('posts the escaped template as the owner, in the saved DM only, with link previews off; the dry run sends nothing', async () => {
    const app = await startApp();
    try {
      await connect(app);
      const preview = await app.call('/api/ai/slack/send', { body: { kind: 'build', build: { ...BUILD, request: 'Use <script>& keep it' }, ref: 'ylb-PREV01', dryRun: true } });
      expect(preview.json.preview).toMatchObject({ limit: 3900 });
      expect(preview.json.preview.text).toContain('Use <script>& keep it');
      expect(preview.json.preview.text).toContain('My website, for reference: https://beanleaf.example/');
      expect(slackCalls('chat.postMessage')).toHaveLength(0);
      const r = await app.call('/api/ai/slack/send', { body: { kind: 'build', build: { ...BUILD, request: 'Use <script>& keep it' }, ref: 'ylb-SEND01', channel: SLACK_QA.general } });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ thread: { kind: 'build', channel: SLACK_QA.dm }, message: { located: true } });
      expect(r.json.thread.id).toMatch(/^vk_[A-Za-z0-9_-]{22}$/);
      expect(r.json.thread.permalink).toMatch(/^https:\/\/qa-workspace\.slack\.com\/archives\/DQAVIKTOR1\/p\d+$/);
      const [post] = slackCalls('chat.postMessage');
      expect(post.body).toMatchObject({ channel: SLACK_QA.dm, unfurl_links: false, unfurl_media: false });
      expect(post.body).not.toHaveProperty('link_names');
      expect(post.body).not.toHaveProperty('thread_ts');
      expect(post.body.text).toContain('Use &lt;script&gt;&amp; keep it');
      expect(post.body.text).toContain('My website, for reference: <https://beanleaf.example/>');
      expect(post.body.text).toMatch(/\nRef: ylb-SEND01$/);
      expect(post.headers.authorization).toBe(`Bearer ${OWNER}`);
      // too long after escaping: refused, nothing sent
      const long = await app.call('/api/ai/slack/send', { body: { kind: 'chat', chat: { text: '&'.repeat(1000), website: '', images: [] }, ref: 'ylb-LONG01' } });
      expect(long).toMatchObject({ status: 413, json: { code: 'TOO_LONG', limit: 3900 } });
      expect(slackCalls('chat.postMessage')).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('sends images as ONE message: uploads without the token, one completeUploadExternal, the ts found with files.info', async () => {
    const app = await startApp();
    try {
      await connect(app);
      const files = [];
      for (const n of [1, 2]) {
        const up = await app.call(`/api/ai/slack/attach?filename=img-${n}.jpg&alt=${encodeURIComponent(`photo ${n}`)}`, { raw: JPEG, headers: { 'content-type': 'image/jpeg' } });
        expect(up.status).toBe(200);
        files.push({ file_id: up.json.file_id, title: `img-${n}` });
      }
      const gets = slackCalls('files.getUploadURLExternal');
      expect(gets.map((c) => c.body)).toEqual([
        { filename: 'img-1.jpg', length: String(JPEG.length), alt_txt: 'photo 1' },
        { filename: 'img-2.jpg', length: String(JPEG.length), alt_txt: 'photo 2' },
      ]);
      const uploads = mock.calls.filter((c) => c.provider === 'slack-upload');
      expect(uploads).toHaveLength(2);
      for (const u of uploads) expect(u.headers.authorization).toBeUndefined();
      // a file that isn't the image its name says is refused
      expect((await app.call('/api/ai/slack/attach?filename=img-3.png', { raw: JPEG, headers: { 'content-type': 'image/png' } })).json).toMatchObject({ code: 'NOT_IMAGE' });
      const r = await sendBuild(app, 'With photos', { files, images: [{ key: 'img-1', note: 'photo 1' }, { key: 'img-2', note: '' }] });
      expect(r.status).toBe(200);
      const done = slackCalls('files.completeUploadExternal');
      expect(done).toHaveLength(1);
      expect(done[0].body).toMatchObject({ channel_id: SLACK_QA.dm, files: [{ id: files[0].file_id, title: 'img-1' }, { id: files[1].file_id, title: 'img-2' }] });
      expect(done[0].body.initial_comment).toContain('My images are attached to this message, named by their keys: img-1 (photo 1), img-2.');
      expect(slackCalls('chat.postMessage')).toHaveLength(0);
      expect(slackCalls('files.info').length).toBe(2);
      expect(r.json.message).toMatchObject({ located: true });
      // a change in the thread: thread_ts is the request's ts
      const edit = await app.call('/api/ai/slack/send', { body: { kind: 'edit', threadId: r.json.thread.id, edit: { text: 'Darker', images: [] }, ref: ref() } });
      expect(edit.status).toBe(200);
      expect(slackCalls('chat.postMessage').at(-1).body.thread_ts).toBe(r.json.message.ts);
      // a chat thread can't take a build's change, and the other way round
      expect((await app.call('/api/ai/slack/send', { body: { kind: 'chat', threadId: r.json.thread.id, chat: { text: 'hi', website: '', images: [] }, ref: ref() } })).status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('never sends twice: a timeout or internal_error may have been delivered, and verify finds it by its Ref', async () => {
    const app = await startApp();
    try {
      await connect(app);
      const timeoutRef = ref();
      let r = await sendBuild(app, 'qa-slack-timeout please', { ref: timeoutRef });
      expect(r.status).toBe(504);
      expect(r.json).toMatchObject({ code: 'SLACK_SEND_UNKNOWN', ref: timeoutRef });
      expect(slackCalls('chat.postMessage')).toHaveLength(1);
      const v = await app.call('/api/ai/slack/verify', { body: { ref: timeoutRef, sentAt: r.json.sentAt } });
      expect(v.json).toMatchObject({ found: true, thread: { kind: 'build' }, message: { located: true } });
      expect((await app.call('/api/ai/slack/verify', { body: { ref: 'ylb-NOPE00', sentAt: Date.now() } })).json).toEqual({ found: false });
      r = await sendBuild(app, 'qa-slack-internal now');
      expect(r).toMatchObject({ status: 502, json: { code: 'SLACK_SEND_UNKNOWN' } });
      r = await sendBuild(app, 'qa-slack-fail now');
      expect(r).toMatchObject({ status: 502, json: { code: 'SLACK_ERROR', slack: 'channel_not_found' } });
      r = await sendBuild(app, 'qa-slack-429 now');
      expect(r).toMatchObject({ status: 429, json: { code: 'RATE_LIMIT', retryAfter: 2 } });
      // each was one call: nothing was tried again
      expect(slackCalls('chat.postMessage')).toHaveLength(4);
    } finally {
      await app.close();
    }
  });

  it('stops at 6 posts a minute, before sending', async () => {
    const app = await startApp();
    try {
      await connect(app);
      for (let i = 0; i < 6; i++) expect((await app.call('/api/ai/slack/send', { body: { kind: 'chat', chat: { text: `hello ${i}`, website: '', images: [] }, ref: ref() } })).status).toBe(200);
      const r = await app.call('/api/ai/slack/send', { body: { kind: 'chat', chat: { text: 'one more', website: '', images: [] }, ref: ref() } });
      expect(r).toMatchObject({ status: 429, json: { code: 'RATE_LIMIT' } });
      expect(r.json.retryAfter).toBeGreaterThan(0);
      expect(slackCalls('chat.postMessage')).toHaveLength(6);
    } finally {
      await app.close();
    }
  });

  it('in a channel: the mention only in the first message, and only the thread is read', async () => {
    const app = await startApp();
    try {
      await connect(app, { where: 'channel' });
      const r = await sendBuild(app, 'A pricing table');
      expect(slackCalls('chat.postMessage')[0].body.text.startsWith(`<@${SLACK_QA.viktor}> Hi Viktor, please build`)).toBe(true);
      expect((await read(app, r.json.thread.id)).state).toBe('waiting');
      const built = await read(app, r.json.thread.id);
      expect(built.state).toBe('built');
      await app.call('/api/ai/slack/send', { body: { kind: 'followup', threadId: r.json.thread.id, followup: 'missing_file', ref: ref() } });
      expect(slackCalls('chat.postMessage')[1].body.text).not.toContain('<@');
      expect(slackCalls('conversations.history')).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

describe('reading', () => {
  it('Viktor’s reply shows on the 2nd read: who wrote what, the page as a note, and the page itself decoded once', async () => {
    const app = await startApp();
    try {
      await connect(app);
      const r = await sendBuild(app, 'A booking widget', { images: [{ key: 'img-1', note: '' }] });
      const id = r.json.thread.id;
      let t = await read(app, id);
      expect(t).toMatchObject({ threadId: id, state: 'waiting', sinceTs: r.json.message.ts, latestHtml: null });
      expect(t.messages).toEqual([expect.objectContaining({ from: 'you', via: 'app', where: 'thread' })]);
      t = await read(app, id);
      expect(t.state).toBe('built');
      const vk = t.messages.find((m) => m.from === 'viktor');
      expect(vk).toMatchObject({ via: 'slack', where: 'thread', edited: null, html: { source: 'code', complete: true } });
      expect(vk.text).toContain('[HTML page ·');
      expect(vk.text).toContain('Want a dark-theme version?');
      expect(vk.text).not.toContain('<!DOCTYPE');
      expect(t.latestHtml).toMatchObject({ at: vk.ts, source: 'code', filename: 'page.html' });
      const html = await app.call('/api/ai/slack/html', { body: { threadId: id, at: vk.ts } });
      expect(html.headers.get('content-type')).toMatch(/^application\/json/);
      expect(html.json).toMatchObject({ source: 'code', filename: 'page.html' });
      expect(html.json.html).toMatch(/^<!DOCTYPE html>/);
      expect(html.json.html).toContain('Fish &amp; Chips');
      expect(html.json.html).not.toContain('&amp;amp;');
      expect(html.json.html).toContain('{{img-1}}');
      // the first time Viktor answers, the shape is logged (no text)
      expect(app.logs.some((l) => /blocks \[rich_text:/.test(l))).toBe(true);
    } finally {
      await app.close();
    }
  });

  const after2 = async (app, request) => {
    const r = await sendBuild(app, request);
    expect(r.status).toBe(200);
    await read(app, r.json.thread.id);
    return { id: r.json.thread.id, t: await read(app, r.json.thread.id) };
  };

  it('every reply kind: a question, a link, half a page, an edit', async () => {
    const app = await startApp();
    try {
      await connect(app);
      expect((await after2(app, 'qa-viktor-question')).t.state).toBe('replied');
      expect((await after2(app, 'qa-viktor-link')).t.state).toBe('link_only');
      const split = await after2(app, 'qa-viktor-split');
      expect(split.t.state).toBe('partial');
      const half = split.t.messages.find((m) => m.from === 'viktor');
      expect((await app.call('/api/ai/slack/html', { body: { threadId: split.id, at: half.ts } })).json).toMatchObject({ code: 'PARTIAL' });
      const edit = await after2(app, 'qa-viktor-edit');
      expect(edit.t.state).toBe('replied');
      await read(app, edit.id);
      const edited = await read(app, edit.id);
      expect(edited.state).toBe('built');
      expect(edited.messages.find((m) => m.from === 'viktor').edited).toMatch(/^\d+\.\d+$/);
    } finally {
      await app.close();
    }
  });

  it('…a deletion, an answer outside the thread, a slow one', async () => {
    const app = await startApp();
    try {
      await connect(app);
      const del = await after2(app, 'qa-viktor-delete');
      const gone = await read(app, del.id);
      expect(gone.messages.find((m) => m.from === 'viktor')).toMatchObject({ deleted: true, text: '' });
      expect(gone.state).toBe('waiting');
      const top = await after2(app, 'qa-viktor-toplevel');
      expect(top.t.state).toBe('built');
      expect(top.t.messages.find((m) => m.from === 'viktor')).toMatchObject({ where: 'top' });
      const slow = await after2(app, 'qa-viktor-slow');
      expect(slow.t.state).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('reads 3 threads at once; another person’s words become a notice; an unknown thread is an error', async () => {
    const app = await startApp();
    try {
      await connect(app);
      const ids = [];
      for (const text of ['hello', 'second', 'third']) ids.push((await app.call('/api/ai/slack/send', { body: { kind: 'chat', chat: { text, website: '', images: [] }, ref: ref() } })).json.thread.id);
      // someone else writes in the first thread
      const root = mock.slack.conversation(SLACK_QA.dm).find((m) => m.text.startsWith('hello'));
      mock.slack.messages.get(SLACK_QA.dm).push({ type: 'message', ts: `${Math.floor(Date.now() / 1000) + 5}.999999`, user: SLACK_QA.human, text: 'secret words from someone else', thread_ts: root.ts });
      await app.call('/api/ai/slack/read', { body: { threadIds: ids } });
      const r = await app.call('/api/ai/slack/read', { body: { threadIds: [...ids, 'vk_AAAAAAAAAAAAAAAAAAAAAA'] } });
      expect(r.json.threads.map((t) => t.threadId)).toEqual(ids);
      expect(r.json.errors).toEqual({ vk_AAAAAAAAAAAAAAAAAAAAAA: { code: 'NOT_FOUND', message: expect.any(String) } });
      expect(r.json.threads[0].messages.find((m) => m.from === 'viktor').text).toBe('QA Viktor: I read your message (5 characters).');
      const other = r.json.threads[0].messages.find((m) => m.from === 'other');
      expect(other).toMatchObject({ text: '', files: [] });
      expect(r.text).not.toContain('secret words');
      const sorted = [...r.json.threads[0].messages].sort((a, b) => tsCompare(a.ts, b.ts));
      expect(r.json.threads[0].messages).toEqual(sorted);
    } finally {
      await app.close();
    }
  });
});

describe('pages and files from Slack', () => {
  async function fileReply(app, marker) {
    const r = await sendBuild(app, marker);
    await read(app, r.json.thread.id);
    const t = await read(app, r.json.thread.id);
    const vk = t.messages.find((m) => m.from === 'viktor');
    return { id: r.json.thread.id, t, vk, file: vk.files[0] };
  }

  it('downloads an attached page with the token, only from Slack’s file host, as JSON', async () => {
    const app = await startApp();
    try {
      await connect(app);
      const { id, t, file } = await fileReply(app, 'qa-viktor-file');
      expect(t.state).toBe('built');
      expect(t.latestHtml).toMatchObject({ source: 'file', at: file.id, filename: 'page.html' });
      expect(file).toMatchObject({ name: 'page.html', kind: 'html' });
      expect(JSON.stringify(t)).not.toContain('slack-files');
      const html = await app.call('/api/ai/slack/html', { body: { threadId: id, at: file.id } });
      expect(html.status).toBe(200);
      expect(html.headers.get('content-type')).toMatch(/^application\/json/);
      expect(html.json).toMatchObject({ source: 'file', filename: 'page.html' });
      expect(html.json.html).toContain('Fish &amp; Chips');
      const got = mock.calls.filter((c) => c.provider === 'slack-files');
      expect(got).toHaveLength(1);
      expect(got[0].headers.authorization).toBe(`Bearer ${OWNER}`);
      // the same file as bytes: an attachment, never shown as a page
      const bytes = await app.call('/api/ai/slack/file', { body: { threadId: id, at: file.id } });
      expect(bytes.headers.get('content-type')).toBe('application/octet-stream');
      expect(bytes.headers.get('content-disposition')).toBe('attachment; filename="page.html"');
      expect(bytes.headers.get('x-content-type-options')).toBe('nosniff');
      // with a token that can't read files, Slack answers its sign-in page: caught
      await app.call('/api/ai/slack', { method: 'PUT', body: { token: SLACK_QA.tokens.noScope } });
      expect((await app.call('/api/ai/slack/html', { body: { threadId: id, at: file.id } })).json).toMatchObject({ code: 'FILE_AUTH' });
    } finally {
      await app.close();
    }
  });

  it('never fetches a remote file, never follows a redirect to another host, refuses a big page', async () => {
    const app = await startApp();
    try {
      await connect(app);
      const ext = await fileReply(app, 'qa-viktor-external');
      expect((await app.call('/api/ai/slack/html', { body: { threadId: ext.id, at: ext.file.id } })).json).toMatchObject({ code: 'EXTERNAL_FILE' });
      expect((await app.call('/api/ai/slack/file', { body: { threadId: ext.id, at: ext.file.id } })).status).toBe(403);
      const red = await fileReply(app, 'qa-viktor-redirect');
      expect((await app.call('/api/ai/slack/html', { body: { threadId: red.id, at: red.file.id } })).json).toMatchObject({ code: 'EXTERNAL_FILE' });
      expect(mock.calls.some((c) => c.provider === 'evil')).toBe(false);
      const big = await fileReply(app, 'qa-viktor-big');
      expect((await app.call('/api/ai/slack/html', { body: { threadId: big.id, at: big.file.id } })).json).toMatchObject({ code: 'TOO_BIG' });
    } finally {
      await app.close();
    }
  });
});

describe('who may use it', () => {
  it('without accounts: this machine or the admin token; never a stranger, never another site', async () => {
    const app = await startApp();
    try {
      await connect(app);
      const proxied = { 'x-forwarded-for': '203.0.113.9' };
      let r = await app.call('/api/ai/slack/send', { body: { kind: 'chat', chat: { text: 'hi', website: '', images: [] }, ref: ref() }, headers: proxied });
      expect(r).toMatchObject({ status: 403, json: { code: 'OWNER_ONLY' } });
      expect((await app.call('/api/ai/slack', { method: 'GET', headers: proxied })).status).toBe(403);
      r = await app.call('/api/ai/slack/send', { body: { kind: 'chat', chat: { text: 'hi', website: '', images: [] }, ref: ref() }, headers: { ...proxied, 'x-admin-token': 'admin-secret-token' } });
      expect(r.status).toBe(200);
      r = await app.call('/api/ai/slack/read', { body: { threadIds: [r.json.thread.id] }, headers: { origin: 'https://evil.example' } });
      expect(r.status).toBe(403);
      // health: Viktor shows only for the owner
      const owner = await app.ai.health(null, { headers: {}, socket: { remoteAddress: '127.0.0.1' } });
      expect(owner.agents.viktor).toMatchObject({ ready: true, reason: 'ok', where: 'dm', place: '' });
      const stranger = await app.ai.health(null, { headers: proxied, socket: { remoteAddress: '127.0.0.1' } });
      expect(stranger.agents.viktor).toEqual({ ready: false, reason: 'owner_only', where: '', place: '' });
    } finally {
      await app.close();
    }
  });

  it('with accounts: only the owner’s account', async () => {
    const people = { 'Bearer owner': { id: '11111111-1111-4111-8111-111111111111', email: 'o@example.com', isAdmin: true }, 'Bearer user': { id: '22222222-2222-4222-8222-222222222222', email: 'u@example.com', isAdmin: false } };
    const auth = { enabled: true, signInRequired: true, identify: async (req) => people[req.headers.authorization] ?? null };
    const app = await startApp({ auth, env: { SLACK_USER_TOKEN: OWNER } });
    try {
      const as = (who) => ({ authorization: `Bearer ${who}` });
      expect((await app.call('/api/ai/slack', { method: 'GET', headers: as('user') })).status).toBe(403);
      expect((await app.call('/api/ai/slack/viktor', { method: 'PUT', body: { userId: SLACK_QA.viktor }, headers: as('owner') })).status).toBe(200);
      expect((await app.call('/api/ai/slack/where', { method: 'PUT', body: { kind: 'dm' }, headers: as('owner') })).status).toBe(200);
      const body = { kind: 'chat', chat: { text: 'hi', website: '', images: [] }, ref: ref() };
      expect((await app.call('/api/ai/slack/send', { body, headers: as('user') })).json).toMatchObject({ code: 'OWNER_ONLY' });
      // P5: an email or a lead magnet built by Viktor is the owner's too
      for (const [target, kind] of [['email', 'welcome'], ['leadMagnet', 'guide']]) {
        const build = { kind: 'build', build: { target, kind, facts: [{ id: 'name', value: 'Bean & Leaf' }], website: '', request: 'Make it warm', images: [] }, ref: ref() };
        expect((await app.call('/api/ai/slack/send', { body: build, headers: as('user') })).json).toMatchObject({ code: 'OWNER_ONLY' });
      }
      // the admin token doesn't make another account the owner
      expect((await app.call('/api/ai/slack/send', { body, headers: { ...as('user'), 'x-admin-token': 'admin-secret-token' } })).status).toBe(403);
      const sent = await app.call('/api/ai/slack/send', { body, headers: as('owner') });
      expect(sent.status).toBe(200);
      expect((await app.call('/api/ai/slack/read', { body: { threadIds: [sent.json.thread.id] }, headers: as('user') })).status).toBe(403);
      expect((await app.ai.health(people['Bearer user'], { headers: {}, socket: { remoteAddress: '127.0.0.1' } })).agents.viktor.reason).toBe('owner_only');
      expect((await app.ai.health(people['Bearer owner'], { headers: {}, socket: { remoteAddress: '127.0.0.1' } })).agents.viktor.reason).toBe('ok');
    } finally {
      await app.close();
    }
  });
});

describe('the token never leaks', () => {
  it('in any answer, any log line, or any request to a host other than Slack’s', async () => {
    const app = await startApp();
    try {
      await connect(app);
      const r = await sendBuild(app, 'qa-viktor-file');
      await read(app, r.json.thread.id);
      const t = await read(app, r.json.thread.id);
      await app.call('/api/ai/slack/html', { body: { threadId: r.json.thread.id, at: t.latestHtml.at } });
      await app.call('/api/ai/slack', { method: 'GET' });
      await app.call('/api/ai/slack/test');
      await app.call('/api/ai/providers', { method: 'GET' });
      for (const a of app.answers) expect(a).not.toContain(OWNER);
      for (const l of app.logs) expect(l).not.toContain(OWNER);
      for (const c of mock.calls.filter((x) => x.provider !== 'slack' && x.provider !== 'slack-files')) expect(JSON.stringify(c)).not.toContain(OWNER);
      expect(scrubKeys(`Slack said invalid_auth for ${OWNER} and xo\x78b-123-456-abcdefabcdef`)).toBe('Slack said invalid_auth for [key] and [key]');
    } finally {
      await app.close();
    }
  });
});
