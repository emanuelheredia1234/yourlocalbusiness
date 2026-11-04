import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SignJWT, generateKeyPair } from 'jose';
import { createAuth } from './auth.mjs';
import { createUserKeys } from './userKeys.mjs';
import { createAIRoutes } from './providers/routes.mjs';
import { createMockSupabase } from './test/mock-supabase.mjs';
import { createMockProviders } from './test/mock-providers.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-acct-'));
let supa;
let providers;

beforeAll(async () => {
  supa = await (await createMockSupabase()).start();
  providers = await createMockProviders({ keys: { manus: ['mn-key', 'mn-alice-own-0001'] } }).start();
});
afterAll(async () => {
  await supa.close();
  await providers.close();
});

const reqWith = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('checking a sign-in token', () => {
  it('accepts a real token and knows the owner by email', async () => {
    const auth = createAuth({ supabaseUrl: supa.url, publishableKey: supa.PUBLISHABLE, adminEmails: 'Owner@Example.com, other@x.io' });
    const owner = await supa.tokenFor('owner@example.com');
    const user = await supa.tokenFor('someone@example.com');
    expect(await auth.identify(reqWith(owner.token))).toEqual({ id: owner.user.id, email: 'owner@example.com', isAdmin: true });
    expect(await auth.identify(reqWith(user.token))).toEqual({ id: user.user.id, email: 'someone@example.com', isAdmin: false });
    expect(await auth.identify(reqWith(null))).toBeNull();
  });

  it('refuses expired, foreign and tampered tokens', async () => {
    const auth = createAuth({ supabaseUrl: supa.url, publishableKey: supa.PUBLISHABLE });
    const { privateKey } = await generateKeyPair('ES256');
    const now = Math.floor(Date.now() / 1000);
    const foreign = await new SignJWT({ role: 'authenticated', email: 'x@y.z' }).setProtectedHeader({ alg: 'ES256', kid: 'mock-key-1' }).setSubject('u1').setIssuer(`${supa.url}/auth/v1`).setAudience('authenticated').setIssuedAt(now).setExpirationTime(now + 60).sign(privateKey);
    expect(await auth.identify(reqWith(foreign))).toBeNull();
    const { token } = await supa.tokenFor('valid@example.com');
    const [h, p, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...payload, email: 'owner@example.com' })).toString('base64url')}.${sig}`;
    expect(await auth.identify(reqWith(forged))).toBeNull();
    const short = await (await createMockSupabase({ tokenTtl: -10 })).start();
    const expired = (await short.tokenFor('late@example.com')).token;
    const auth2 = createAuth({ supabaseUrl: short.url, publishableKey: short.PUBLISHABLE });
    expect(await auth2.identify(reqWith(expired))).toBeNull();
    await short.close();
  });

  it('ignores ADMIN_EMAILS when the project doesn’t make people confirm their email', async () => {
    const open = await (await createMockSupabase({ confirmEmail: false })).start();
    const auth = createAuth({ supabaseUrl: open.url, publishableKey: open.PUBLISHABLE, adminEmails: 'owner@example.com' });
    const { token } = await open.tokenFor('owner@example.com');
    expect((await auth.identify(reqWith(token))).isAdmin).toBe(false);
    await open.close();
  });

  it('only makes the owner someone who confirmed that address by email', async () => {
    const auth = createAuth({ supabaseUrl: supa.url, publishableKey: supa.PUBLISHABLE, adminEmails: 'boss@example.com' });
    // made while "Confirm email" was off: marked confirmed, but no email was ever sent
    const squatter = await supa.tokenFor('boss@example.com', 'x', { autoconfirmed: true });
    expect((await auth.identify(reqWith(squatter.token))).isAdmin).toBe(false);
  });

  it('is off without Supabase settings', async () => {
    const auth = createAuth({});
    expect(auth.enabled).toBe(false);
    expect(auth.signInRequired).toBe(false);
    expect(auth.publicConfig()).toMatchObject({ enabled: false, url: '', publishableKey: '' });
  });
});

// ───────────── the AI routes with accounts on ─────────────

function startApp({ adminEmails = 'owner@example.com' } = {}) {
  const auth = createAuth({ supabaseUrl: supa.url, publishableKey: supa.PUBLISHABLE, adminEmails });
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const readJson = (req) =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => resolve(JSON.parse(raw || '{}')));
    });
  const ai = createAIRoutes({
    send,
    readJson,
    corsHeaders: () => ({}),
    rateLimited: () => false,
    dataDir: tmpDir(),
    env: { OPENAI_API_KEY: 'o-key', MANUS_API_KEY: 'mn-key', XAI_API_KEY: 'x-key' },
    baseUrls: providers.baseUrls(),
    auth,
    userKeys: createUserKeys({ supabaseUrl: supa.url, secretKey: supa.SECRET }),
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    ai.handle(req, res, url).then((h) => h === false && send(res, 404, { error: 'Not found' }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ ai, server, base: `http://127.0.0.1:${server.address().port}` })));
}

describe('AI routes with accounts on', () => {
  let app;
  let owner;
  let alice;
  let bob;
  // requests from a browser elsewhere (like Replit), so loopback admin doesn't apply
  const remote = { 'x-forwarded-for': '203.0.113.7', 'content-type': 'application/json' };
  const as = (t) => ({ ...remote, ...(t ? { authorization: `Bearer ${t.token}` } : {}) });

  beforeAll(async () => {
    app = await startApp();
    owner = await supa.tokenFor('owner@example.com');
    alice = await supa.tokenFor('alice@example.com');
    bob = await supa.tokenFor('bob@example.com');
  });
  afterAll(() => app.server.close());
  const call = (p, init = {}) => fetch(`${app.base}${p}`, init);

  it('needs a signed-in user for AI', async () => {
    const r = await call('/api/ai/generate', { method: 'POST', headers: as(null), body: JSON.stringify({ fn: 'research', prompt: 'ideas' }) });
    expect(r.status).toBe(401);
    expect((await r.json()).code).toBe('AUTH_REQUIRED');
    const ok = await call('/api/ai/generate', { method: 'POST', headers: as(alice), body: JSON.stringify({ fn: 'research', prompt: 'ideas' }) });
    expect(ok.status).toBe(200);
    expect(app.ai.usage.recent(1)[0]).toMatchObject({ ok: true, userId: alice.user.id });
  });

  it('lets only the owner see and change the keys', async () => {
    let r = await call('/api/ai/providers', { headers: as(alice) });
    let j = await r.json();
    expect(j).toMatchObject({ role: 'user', state: null });
    expect(j.catalog.length).toBeGreaterThan(5);
    r = await call('/api/ai/providers/openai', { method: 'PUT', headers: as(alice), body: JSON.stringify({ effort: { text: 'high' } }) });
    expect(r.status).toBe(403);
    r = await call('/api/ai/providers', { headers: as(owner) });
    j = await r.json();
    expect(j.role).toBe('admin');
    expect(j.state.canManage).toBe(true);
    r = await call('/api/ai/providers/openai', { method: 'PUT', headers: as(owner), body: JSON.stringify({ effort: { text: 'high' } }) });
    expect(r.status).toBe(200);
    expect((await call('/api/ai/usage', { headers: as(alice) })).status).toBe(403);
    expect((await call('/api/ai/usage', { headers: as(owner) })).status).toBe(200);
  });

  it('keeps the owner’s Manus to the owner, and runs users on their own Manus key', async () => {
    // without their own key, nobody else may give the owner's Manus agent a task
    let r = await call('/api/ai/manus/create', { method: 'POST', headers: as(alice), body: JSON.stringify({ fn: 'photos', prompt: 'open my Facebook and post this' }) });
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('OWN_KEY_NEEDED');
    expect((await app.ai.health({ id: alice.user.id, isAdmin: false })).routing.facebook ?? []).not.toContain('manus');
    // adding their own key: checked with Manus, stored encrypted, shown as its last 4 only
    r = await call('/api/ai/my-keys/manus', { method: 'PUT', headers: as(alice), body: JSON.stringify({ key: 'wrong-key-0000000000' }) });
    expect(r.status).toBe(400);
    r = await call('/api/ai/my-keys/manus', { method: 'PUT', headers: as(alice), body: JSON.stringify({ key: 'mn-alice-own-0001' }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ available: true, keys: [{ provider: 'manus', last4: '0001' }], byProvider: { manus: { last4: '0001' } } });
    const stored = supa.tables.get('user_secrets').find((x) => x.user_id === alice.user.id);
    expect(stored.ciphertext).not.toContain('mn-alice');
    expect((await call('/api/ai/my-keys', { headers: as(bob) }).then((x) => x.json())).byProvider.manus).toBeNull();
    const h = await app.ai.health({ id: alice.user.id, isAdmin: false });
    expect(h.routing.facebook).toEqual(['manus']);
    expect(h.providers.find((p) => p.id === 'manus')).toMatchObject({ label: 'Manus (your key)', own: true });
    // her task runs with her key
    r = await call('/api/ai/manus/create', { method: 'POST', headers: as(alice), body: JSON.stringify({ fn: 'facebook', prompt: 'schedule it' }) });
    expect(r.status).toBe(200);
    const sent = providers.calls.filter((c) => c.provider === 'manus' && c.method === 'POST').pop();
    expect(JSON.stringify(sent.headers)).toContain('mn-alice-own-0001');
  });

  it('keeps each user’s Manus tasks and video jobs to themselves', async () => {
    const created = await (await call('/api/ai/manus/create', { method: 'POST', headers: as(alice), body: JSON.stringify({ fn: 'photos', prompt: 'one photo' }) })).json();
    expect(created.task_id).toBeTruthy();
    expect((await call('/api/ai/manus/output', { method: 'POST', headers: as(bob), body: JSON.stringify({ task_id: created.task_id }) })).status).toBe(404);
    expect((await call('/api/ai/manus/continue', { method: 'POST', headers: as(bob), body: JSON.stringify({ task_id: created.task_id, prompt: 'hi' }) })).status).toBe(404);
    expect((await call('/api/ai/manus/output', { method: 'POST', headers: as(alice), body: JSON.stringify({ task_id: created.task_id }) })).status).toBe(200);

    const { job } = await (await call('/api/ai/video', { method: 'POST', headers: as(alice), body: JSON.stringify({ prompt: 'a candle', aspect: '9:16' }) })).json();
    expect((await call(`/api/ai/video/${job.id}`, { headers: as(bob) })).status).toBe(404);
    expect((await call(`/api/ai/video/${job.id}`, { headers: as(null) })).status).toBe(401);
    expect((await call(`/api/ai/video/${job.id}`, { headers: as(alice) })).status).toBe(200);
  });

  it('keeps Facebook scheduling in the owner’s Manus to the owner (others need their own key)', async () => {
    const r = await call('/api/ai/manus/create', { method: 'POST', headers: as(bob), body: JSON.stringify({ fn: 'facebook', prompt: 'schedule it' }) });
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('OWN_KEY_NEEDED');
    const ok = await call('/api/ai/manus/create', { method: 'POST', headers: as(owner), body: JSON.stringify({ fn: 'facebook', prompt: 'schedule it' }) });
    expect(ok.status).toBe(200);
  });

  it('gives signed-out callers no AI details', async () => {
    expect(await app.ai.health(null)).toEqual({ ready: false, providers: [], routing: {}, signedIn: false });
    expect((await app.ai.health({ id: alice.user.id })).routing.research.length).toBeGreaterThan(0);
  });
});

// ───────────── the real server ─────────────

describe('ai-server.mjs with accounts', () => {
  it('serves the sign-in config and deletes an account with its files', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const port = 19000 + Math.floor(Math.random() * 900);
    const child = spawn(process.execPath, [path.join(here, 'ai-server.mjs')], {
      env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tmpDir(), SUPABASE_URL: supa.url, SUPABASE_PUBLISHABLE_KEY: supa.PUBLISHABLE, SUPABASE_SECRET_KEY: supa.SECRET, ADMIN_EMAILS: 'owner@example.com' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (d) => {
          out += d;
          if (out.includes('Accounts: on')) resolve();
        });
        child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
        setTimeout(() => reject(new Error(`server didn’t start: ${out}`)), 10_000);
      });
      const base = `http://127.0.0.1:${port}`;
      const cfg = await (await fetch(`${base}/api/config`)).json();
      expect(cfg.accounts).toEqual({ enabled: true, url: supa.url, publishableKey: supa.PUBLISHABLE, signInRequired: true, canDeleteAccount: true });
      const health = await (await fetch(`${base}/api/health`)).json();
      expect(health.ai.signedIn).toBe(false);

      const leaving = await supa.tokenFor('leaving@example.com');
      supa.tables.set('user_docs', [...(supa.tables.get('user_docs') ?? []), { user_id: leaving.user.id, kind: 'project', id: 'proj_1', data: {} }]);
      supa.objects.set(`media/${leaving.user.id}/media_1`, { bytes: Buffer.from('x'), type: 'image/png', created: Date.now() });
      const signedIn = async () => (await (await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${leaving.token}` } })).json()).ai.signedIn;
      expect(await signedIn()).toBe(true);
      const r = await fetch(`${base}/api/account`, { method: 'DELETE', headers: { authorization: `Bearer ${leaving.token}` } });
      expect(r.status).toBe(200);
      expect(supa.users.has(leaving.user.id)).toBe(false);
      expect((supa.tables.get('user_docs') ?? []).some((x) => x.user_id === leaving.user.id)).toBe(false);
      expect(supa.objects.has(`media/${leaving.user.id}/media_1`)).toBe(false);
      expect((await fetch(`${base}/api/account`, { method: 'DELETE' })).status).toBe(401);
      // the access token itself is still unexpired and signed, but this server no longer takes it
      expect(await signedIn()).toBe(false);
      expect((await fetch(`${base}/api/account`, { method: 'DELETE', headers: { authorization: `Bearer ${leaving.token}` } })).status).toBe(401);
    } finally {
      child.kill();
    }
  }, 20_000);
});
