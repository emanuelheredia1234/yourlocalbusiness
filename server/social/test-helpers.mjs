// For the posting tests: the posting routes on a bare HTTP server with mock Supabase (database, storage, sign-in) and
// the real Upload-Post connections against the mock Upload-Post server (server/test/mock-uploadpost.mjs). Fake values
// only; nothing reaches Upload-Post.

import http from 'node:http';
import { createAuth } from '../auth.mjs';
import { combineConnections, createConnections, nullConnections } from '../connections/index.mjs';
import { createUploadPostConnections } from '../connections/uploadpost.mjs';
import { createDb } from '../integrations/db.mjs';
import { createBucketLimiter, sha256 } from '../integrations/common.mjs';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { createMockUploadPost, TEST_UPLOAD_POST_KEY, TEST_UPLOAD_POST_WEBHOOK_SECRET } from '../test/mock-uploadpost.mjs';
import { makeStorage } from '../test/fakes.mjs';
import { createPostingRoutes } from './routes.mjs';
import { createPublicMediaRoutes } from '../media/publicMedia.mjs';
import { createTrialReels } from './trialReels.mjs';

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

/** Every network a test user can connect. */
export const NETWORKS = ['facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube'];

/** Everything a posting test needs, started. Call .close() after. */
export async function startPosting({ env: envExtra = {}, enabled = true, experimentHooks = () => null } = {}) {
  const supa = await (await createMockSupabase()).start();
  const up = await createMockUploadPost().start();
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const env = {
    SUPABASE_URL: supa.url,
    SUPABASE_SECRET_KEY: supa.SECRET,
    MEDIA_PUBLIC_BASE_URL: 'https://app.test',
    UPLOAD_POST_API_KEY: TEST_UPLOAD_POST_KEY,
    UPLOAD_POST_WEBHOOK_SECRET: TEST_UPLOAD_POST_WEBHOOK_SECRET,
    UPLOAD_POST_BASE_URL: up.base,
    UPLOAD_POST_RPM: '900',
    ...TEST_SECRETS,
    ...envExtra,
  };
  const db = createDb({ supabaseUrl: supa.url, secretKey: supa.SECRET });
  const auth = createAuth({ supabaseUrl: supa.url, publishableKey: supa.PUBLISHABLE });
  const storage = makeStorage();
  const logs = [];
  const log = { log: (line) => logs.push(String(line)) };
  // status polling waits through `sleep`: the test clock moves instead of real time passing
  const impl = enabled ? createUploadPostConnections({ env, storage, db, now, log, sleep: async (ms) => void (clock.t += ms) }) : nullConnections;
  const connections = createConnections(enabled ? combineConnections({ social: impl }) : nullConnections);
  const limit = createBucketLimiter({ now });
  const trialReels = createTrialReels({ db, connections, now, log });
  const deps = { auth, db, connections, send: sendLike, readJson, limit, env, now, log, trialReels, experimentHooks };
  const routes = createPostingRoutes(deps);
  impl.setPostListener?.((userId, jobId, outcome, where) => routes.posting.fromWebhook(userId, jobId, outcome, where));
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
    up,
    db,
    env,
    impl,
    storage,
    connections,
    routes,
    media,
    trialReels,
    deps,
    limit,
    auth,
    clock,
    logs,
    base,
    async user(email) {
      const { token, user } = await supa.tokenFor(email);
      return { token, id: user.id, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } };
    },
    /**
     * Connect networks for one of a user's businesses the way a customer does: a connect link, the hosted page
     * (mock), then Upload-Post's signed social_account_connected webhook. Facebook gets one Page. The business must
     * be saved first (project()).
     */
    async connect(u, platforms = NETWORKS, { username = 'joesbakery', projectId = 'proj-1' } = {}) {
      const made = {};
      for (const platform of platforms) {
        await connections.connectLink(u.id, platform, { projectId });
        const name = await ctx.profileOf(u, projectId);
        if (platform === 'facebook') up.pages.facebook.set(name, [{ id: `page_${name.slice(-8)}`, name: `${username} page` }]);
        const account = up.connect(name, platform, { handle: username, display_name: `${username} on ${platform}` });
        const evt = up.signed({ event: 'social_account_connected', profile_username: name, platform }, { ts: Math.floor(clock.t / 1000) });
        const res = await impl.webhook(evt.raw, evt.headers);
        if (res.status !== 200) throw new Error(`connect webhook ${res.status}`);
        await impl.settled();
        made[platform] = account;
      }
      return made;
    },
    /** A business's Upload-Post profile name (each business has its own). */
    async profileOf(u, projectId = 'proj-1') {
      return (await storage.get(`uploadpost:user:${sha256(u.id)}`))?.value?.profiles?.find((p) => p.projectId === projectId)?.username;
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
    /** the uploads Upload-Post received */
    postCalls() {
      return up.uploadCalls();
    },
    async close() {
      await new Promise((r) => server.close(r));
      await up.close();
      await supa.close();
    },
  };
  return ctx;
}
