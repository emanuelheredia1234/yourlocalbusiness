// For the posting tests: the posting routes on a bare HTTP server with mock Supabase (database, storage, sign-in),
// the mock networks, and a connections proxy that checks what Nango's would (test/mock-social-providers.mjs).
// Fake values only.

import http from 'node:http';
import { createAuth } from '../auth.mjs';
import { createConnections } from '../connections/index.mjs';
import { createDb } from '../integrations/db.mjs';
import { createBucketLimiter } from '../integrations/common.mjs';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { createMockSocialProviders, createProxyConnections, FB_PAGE_ID, LI_PERSON } from '../test/mock-social-providers.mjs';
import { createPostingRoutes } from './routes.mjs';
import { createPublicMediaRoutes } from '../media/publicMedia.mjs';

export const TEST_SECRETS = Object.freeze({
  CUSTOMER_TAG_SECRET: 'test-customer-tag-secret-0123456789',
  MEDIA_URL_SECRET: 'test-media-url-secret-abcdef0123456789',
});

export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1)]);
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
export const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(6000, 7)]);

function sendLike(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(data);
}

function readJson(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const t = Buffer.concat(chunks).toString();
        resolve(t ? JSON.parse(t) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const connected = (platform, extra = {}) => ({ platform, state: 'connected', ...extra });
export const DEFAULT_STATUSES = [
  connected('facebook', { targetLabel: 'Joe’s Bakery', targetKind: 'fb_page' }),
  connected('instagram', { targetLabel: '@joesbakery', targetKind: 'ig_account' }),
  connected('linkedin', { targetLabel: 'Joe Baker', targetKind: 'li_person' }),
  connected('tiktok', { targetLabel: 'joesbakery', targetKind: 'tt_account' }),
  connected('x', { targetLabel: '@joesbakery', targetKind: 'x_account' }),
  connected('youtube', { targetLabel: 'Joe’s Bakery', targetKind: 'yt_channel' }),
];

/** Everything a posting test needs, started. Call .close() after. */
export async function startPosting({ timing = {}, statuses = DEFAULT_STATUSES, env: envExtra = {}, enabled = true } = {}) {
  const supa = await (await createMockSupabase()).start();
  const clock = { t: Date.now() };
  const social = await createMockSocialProviders({ clock: () => clock.t }).start();
  const now = () => clock.t;
  const sleep = async (ms) => {
    clock.t += ms;
  };
  const env = {
    SUPABASE_URL: supa.url,
    SUPABASE_SECRET_KEY: supa.SECRET,
    GRAPH_BASE_URL: social.url,
    SOCIAL_MOCK_BASE_URL: social.url,
    MEDIA_PUBLIC_BASE_URL: 'https://app.test',
    ...TEST_SECRETS,
    ...envExtra,
  };
  const db = createDb({ supabaseUrl: supa.url, secretKey: supa.SECRET });
  const auth = createAuth({ supabaseUrl: supa.url, publishableKey: supa.PUBLISHABLE });
  const impl = createProxyConnections({ base: social.url, statuses: [...statuses], targets: { facebook: FB_PAGE_ID, instagram: FB_PAGE_ID, linkedin: LI_PERSON }, enabled });
  const connections = createConnections(impl);
  const limit = createBucketLimiter({ now });
  const logs = [];
  const log = { log: (line) => logs.push(String(line)) };
  const deps = { auth, db, connections, send: sendLike, readJson, limit, env, now, log, sleep, timing: { writeMs: 2000, readMs: 2000, ...timing } };
  const routes = createPostingRoutes(deps);
  const media = createPublicMediaRoutes({ ...deps, clientKey: () => 'test' });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    (async () => {
      if (await routes.handle(req, res, url)) return;
      if (await media.handle(req, res, url)) return;
      sendLike(res, 404, { error: 'Not found' });
    })();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  await db.insert('billing_caps', { customer_tag: '*', daily_cap_micro: 250000, monthly_cap_micro: 3000000, calls_per_day: 400, posts_per_day: 50, x_posts_per_day: 20 }, { ignoreDuplicates: true, onConflict: 'customer_tag' });

  const ctx = {
    supa,
    social,
    db,
    env,
    impl,
    connections,
    routes,
    media,
    clock,
    logs,
    base,
    async user(email) {
      const { token, user } = await supa.tokenFor(email);
      return { token, id: user.id, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } };
    },
    async project(u, id = 'proj-1') {
      await db.upsert('user_docs', { user_id: u.id, kind: 'project', id, data: { id, name: 'Joe’s Bakery', location: { city: 'Austin' } } }, { onConflict: 'user_id,kind,id' });
      return id;
    },
    async post(u, data) {
      const post = { id: `post-${Math.random().toString(36).slice(2, 10)}`, projectId: 'proj-1', status: 'draft', platform: 'facebook', format: 'image', caption: 'Fresh sourdough today', hashtags: ['#bakery'], headline: 'Fresh bread', ...data };
      await db.upsert('user_docs', { user_id: u.id, kind: 'post', id: post.id, data: post }, { onConflict: 'user_id,kind,id' });
      return post;
    },
    file(u, id, bytes, type) {
      supa.objects.set(`media/${u.id}/${id}`, { bytes, type, created: Date.now() });
      return { id, kind: type.startsWith('video/') ? 'video' : 'image', mime: type, name: id, size: bytes.length, createdAt: 1 };
    },
    async call(u, method, path, body) {
      const res = await fetch(`${base}${path}`, { method, headers: u?.headers ?? {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not json */
      }
      return { status: res.status, body: json, text, headers: res.headers };
    },
    /** POST /api/posting/publish for a saved post, with the request the app would send. */
    publish(u, post, extra = {}) {
      return ctx.call(u, 'POST', '/api/posting/publish', {
        projectId: post.projectId,
        postId: post.id,
        platform: post.platform,
        confirm: true,
        clientRequestId: crypto.randomUUID(),
        content: { text: post.caption, hashtags: post.hashtags, ...(post.media ? { mediaIds: [post.media.id] } : {}) },
        ...extra,
      });
    },
    async settled() {
      await routes.posting.settled();
    },
    async jobRow(id) {
      return (await db.select('post_publish_jobs', { id }))[0];
    },
    async close() {
      await new Promise((r) => server.close(r));
      await social.close();
      await supa.close();
    },
  };
  return ctx;
}
