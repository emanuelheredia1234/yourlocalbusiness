// The owner's AI keys and settings, the Manus task list and the usage log kept in Supabase
// (server/appState.mjs): they survive a restart with an empty disk, and every copy of the server
// sees the same keys. Against the Supabase and provider stand-ins.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from './auth.mjs';
import { createAppState } from './appState.mjs';
import { createAIRoutes } from './providers/routes.mjs';
import { AIStore } from './providers/store.mjs';
import { mergeEntries } from './providers/usage.mjs';
import { createMockSupabase } from './test/mock-supabase.mjs';
import { createMockProviders } from './test/mock-providers.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-state-'));
let supa;
let providers;
let appState;

beforeAll(async () => {
  supa = await (await createMockSupabase()).start();
  providers = await createMockProviders({ keys: { openai: ['sk-owner-typed-1234'], manus: ['mn-owner-typed-5678'] } }).start();
  appState = createAppState({ supabaseUrl: supa.url, secretKey: supa.SECRET });
});
afterAll(async () => {
  await supa.close();
  await providers.close();
});

const remote = { 'x-forwarded-for': '203.0.113.7', 'content-type': 'application/json' };
const as = (t) => ({ ...remote, ...(t ? { authorization: `Bearer ${t.token}` } : {}) });

/** One copy of the server (its own empty disk), sharing Supabase with the others. */
function serverCopy({ state = appState, env = {} } = {}) {
  const auth = createAuth({ supabaseUrl: supa.url, publishableKey: supa.PUBLISHABLE, adminEmails: 'owner@example.com' });
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
  const ai = createAIRoutes({ send, readJson, corsHeaders: () => ({}), rateLimited: () => false, dataDir: tmpDir(), env, baseUrls: providers.baseUrls(), auth, appState: state });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    ai.handle(req, res, url).then((h) => h === false && send(res, 404, { error: 'Not found' }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ ai, server, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => server.close(c)) })));
}

describe('server settings in Supabase', () => {
  it('stores documents encrypted, where browsers can’t reach them', async () => {
    const at = await appState.put('probe', { secret: 'sk-very-secret-9999' });
    expect(at).toBeTruthy();
    const row = supa.tables.get('app_state').find((r) => r.key === 'probe');
    expect(row.ciphertext).not.toContain('sk-very-secret');
    expect(await appState.get('probe')).toEqual({ value: { secret: 'sk-very-secret-9999' }, updatedAt: at });
    expect(await appState.version('probe')).toBe(at);
    // a signed-in user's token (or the publishable key) can't read the table
    const { token } = await supa.tokenFor('reader@example.com');
    const asUser = await fetch(`${supa.url}/rest/v1/app_state?select=*`, { headers: { apikey: supa.PUBLISHABLE, authorization: `Bearer ${token}` } });
    expect(asUser.status).toBe(401);
    // a different secret can't open it: reported as unreadable, never as "nothing saved"
    expect(await createAppState({ supabaseUrl: supa.url, secretKey: supa.SECRET, encryptionSecret: 'other' }).get('probe')).toEqual({ unreadable: true, value: null, updatedAt: at });
  });

  it('keeps the owner’s keys through a restart with an empty disk, and shares them between copies', async () => {
    const owner = await supa.tokenFor('owner@example.com');
    const user = await supa.tokenFor('user@example.com');
    const a = await serverCopy();
    const b = await serverCopy();
    // the owner types a key on copy A
    let r = await fetch(`${a.base}/api/ai/providers/openai`, { method: 'PUT', headers: as(owner), body: JSON.stringify({ apiKey: 'sk-owner-typed-1234', functions: ['research', 'social'] }) });
    expect(r.status).toBe(200);
    expect((await r.json()).state.storage).toBe('supabase');
    expect(JSON.stringify(supa.tables.get('app_state'))).not.toContain('sk-owner-typed-1234');
    // a user's request lands on copy B: it already uses the owner's key
    r = await fetch(`${b.base}/api/ai/generate`, { method: 'POST', headers: as(user), body: JSON.stringify({ fn: 'research', prompt: 'ideas' }) });
    expect(r.status).toBe(200);
    expect((await r.json()).meta.provider).toBe('openai');
    expect(JSON.stringify(providers.calls.filter((c) => c.provider === 'openai').pop().headers)).toContain('sk-owner-typed-1234');
    // a fresh copy (a restart: nothing on disk) starts with the key
    const c = await serverCopy();
    expect(await c.ai.init()).toBe('loaded');
    const st = (await (await fetch(`${c.base}/api/ai/providers`, { headers: as(owner) })).json()).state;
    expect(st.providers.find((p) => p.id === 'openai')).toMatchObject({ configured: true, source: 'app', keyHint: '••••1234', functions: ['research', 'social'] });
    // a change on C reaches A (which looks again after a few seconds, or right before its own change)
    r = await fetch(`${c.base}/api/ai/providers/openai`, { method: 'PUT', headers: as(owner), body: JSON.stringify({ effort: { text: 'high' } }) });
    expect(r.status).toBe(200);
    r = await fetch(`${a.base}/api/ai/providers/openai`, { method: 'PUT', headers: as(owner), body: JSON.stringify({ enabled: true }) });
    const merged = (await r.json()).state.providers.find((p) => p.id === 'openai');
    expect(merged.effort.text).toBe('high'); // A started from C's newer settings instead of undoing them
    await Promise.all([a.close(), b.close(), c.close()]);
  });

  it('finds a Manus task on another copy of the server', async () => {
    const owner = await supa.tokenFor('owner@example.com');
    const a = await serverCopy();
    const b = await serverCopy();
    await fetch(`${a.base}/api/ai/providers/manus`, { method: 'PUT', headers: as(owner), body: JSON.stringify({ apiKey: 'mn-owner-typed-5678', functions: ['photos'] }) });
    const created = await (await fetch(`${a.base}/api/ai/manus/create`, { method: 'POST', headers: as(owner), body: JSON.stringify({ fn: 'photos', prompt: 'a candle' }) })).json();
    expect(created.task_id).toBeTruthy();
    const r = await fetch(`${b.base}/api/ai/manus/output`, { method: 'POST', headers: as(owner), body: JSON.stringify({ task_id: created.task_id }) });
    expect(r.status).toBe(200);
    // and the usage log reaches Supabase, merged with other copies' entries
    await a.ai.usage.flushRemote();
    const c = await serverCopy();
    await c.ai.init();
    expect(c.ai.usage.recent(50).some((e) => e.taskId === created.task_id)).toBe(true);
    await Promise.all([a.close(), b.close(), c.close()]);
  });

  it('says so when a change couldn’t reach Supabase', async () => {
    const owner = await supa.tokenFor('owner@example.com');
    const a = await serverCopy();
    // signed in already (the sign-in check is cached), then Supabase's database goes away
    expect((await fetch(`${a.base}/api/ai/providers`, { headers: as(owner) })).status).toBe(200);
    supa.behavior.down = true;
    try {
      const r = await fetch(`${a.base}/api/ai/providers/openai`, { method: 'PUT', headers: as(owner), body: JSON.stringify({ effort: { text: 'low' } }) });
      const body = await r.json();
      expect(r.status).toBe(502);
      expect(body.code).toBe('NOT_SAVED');
      expect(body.error).toMatch(/may be lost when the app restarts/);
      // the change still applies on this server, and the page can say why it isn't kept
      expect(body.state.providers.find((p) => p.id === 'openai').effort.text).toBe('low');
      expect(body.state.storageProblem.code).toBeTruthy();
    } finally {
      supa.behavior.down = false;
    }
    await a.close();
  });

  it('uploads keys typed before the secret key was added', async () => {
    const dir = tmpDir();
    const local = new AIStore(path.join(dir, 'ai-providers.json'), { env: {} });
    local.update('google', { apiKey: 'AIza-before-secret-0001' });
    const empty = await (await createMockSupabase()).start();
    try {
      const st = createAppState({ supabaseUrl: empty.url, secretKey: empty.SECRET });
      const store = new AIStore(path.join(dir, 'ai-providers.json'), { env: {}, remote: st });
      expect(await store.loadRemote()).toBe('uploaded');
      const fresh = new AIStore(path.join(tmpDir(), 'ai-providers.json'), { env: {}, remote: st });
      expect(await fresh.loadRemote()).toBe('loaded');
      expect(fresh.key('google')).toBe('AIza-before-secret-0001');
    } finally {
      await empty.close();
    }
  });

  it('keeps working from the disk when Supabase can’t be reached at start-up', async () => {
    supa.behavior.down = true;
    try {
      const store = new AIStore(path.join(tmpDir(), 'ai-providers.json'), { env: {}, remote: appState });
      expect(await store.loadRemote()).toBe('unreachable');
    } finally {
      supa.behavior.down = false;
    }
  });

  it('merges usage logs by entry, newest first', () => {
    const mine = [{ id: 'a', at: 3, credits: 9 }];
    const theirs = [{ id: 'a', at: 3, credits: null }, { id: 'b', at: 5 }, { id: 'c', at: 1 }, { bad: true }];
    expect(mergeEntries(mine, theirs)).toEqual([{ id: 'b', at: 5 }, { id: 'a', at: 3, credits: 9 }, { id: 'c', at: 1 }]);
  });
});

describe('the review’s fixes', () => {
  it('saves only over the version it started from; creating twice is a conflict', async () => {
    const at = await appState.put('cas', { n: 1 }, { ifVersion: null });
    await expect(appState.put('cas', { n: 2 }, { ifVersion: null })).rejects.toMatchObject({ code: 'CONFLICT' });
    const next = await appState.put('cas', { n: 3 }, { ifVersion: at });
    await expect(appState.put('cas', { n: 4 }, { ifVersion: at })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await appState.get('cas')).value).toEqual({ n: 3 });
    expect(next).not.toBe(at);
  });

  it('two copies saving at once keep both changes, and a removed key stays removed', async () => {
    const st = createAppState({ supabaseUrl: supa.url, secretKey: supa.SECRET });
    const seed = new AIStore(path.join(tmpDir(), 'ai-providers.json'), { env: {}, remote: st });
    seed.update('xai', { apiKey: 'xai-to-remove-1111' });
    seed.update('anthropic', { apiKey: 'sk-ant-stays-2222' });
    await seed.persisted();
    const a = new AIStore(path.join(tmpDir(), 'ai-providers.json'), { env: {}, remote: st });
    const b = new AIStore(path.join(tmpDir(), 'ai-providers.json'), { env: {}, remote: st });
    await a.loadRemote();
    await b.loadRemote();
    a.update('xai', { removeKey: true });
    await a.persisted();
    // b hasn't looked since: its save conflicts, so it starts from a's settings and re-applies its change
    b.update('anthropic', { effort: { text: 'high' } });
    await b.persisted();
    const fresh = new AIStore(path.join(tmpDir(), 'ai-providers.json'), { env: {}, remote: st });
    await fresh.loadRemote();
    expect(fresh.key('xai')).toBe('');
    expect(fresh.key('anthropic')).toBe('sk-ant-stays-2222');
    expect(fresh.settings('anthropic').effort.text).toBe('high');
  });

  it('never overwrites settings it can’t read on its own; an explicit save replaces them', async () => {
    const owners = await (await createMockSupabase()).start();
    try {
      const mine = createAppState({ supabaseUrl: owners.url, secretKey: owners.SECRET });
      const saved = new AIStore(path.join(tmpDir(), 'ai-providers.json'), { env: {}, remote: mine });
      saved.update('openai', { apiKey: 'sk-precious-3333' });
      await saved.persisted();
      const before = JSON.stringify(owners.tables.get('app_state'));
      // a copy started with another secret, and keys of its own on disk
      const dir = tmpDir();
      new AIStore(path.join(dir, 'ai-providers.json'), { env: {} }).update('google', { apiKey: 'AIza-other-4444' });
      const other = new AIStore(path.join(dir, 'ai-providers.json'), { env: {}, remote: createAppState({ supabaseUrl: owners.url, secretKey: owners.SECRET, encryptionSecret: 'rotated' }) });
      expect(await other.loadRemote()).toBe('unreadable');
      expect(other.storageProblem.code).toBe('UNREADABLE');
      await other.refresh({ force: true });
      expect(JSON.stringify(owners.tables.get('app_state'))).toBe(before); // untouched
      other.update('google', { effort: { text: 'low' } }); // the owner saves on purpose
      await other.persisted();
      expect(other.storageProblem).toBeNull();
      expect(JSON.stringify(owners.tables.get('app_state'))).not.toBe(before);
    } finally {
      await owners.close();
    }
  });

  it('names the missing table and its SQL file, and says keys aren’t kept yet', async () => {
    const bare = await (await createMockSupabase({ missingTables: ['app_state'] })).start();
    try {
      const st = createAppState({ supabaseUrl: bare.url, secretKey: bare.SECRET });
      await expect(st.version('ai-providers')).rejects.toMatchObject({ code: 'NO_TABLE' });
      const store = new AIStore(path.join(tmpDir(), 'ai-providers.json'), { env: {}, remote: st });
      expect(await store.loadRemote()).toBe('no-table');
      expect(store.storageProblem.message).toMatch(/20261103010000_app_state\.sql/);
      store.update('openai', { apiKey: 'sk-works-for-now-5555' });
      await expect(store.persisted()).rejects.toMatchObject({ code: 'NO_TABLE' });
      expect(store.key('openai')).toBe('sk-works-for-now-5555'); // still works on this server
    } finally {
      await bare.close();
    }
  });

  it('a key saved through one copy works on another right away', async () => {
    const owner = await supa.tokenFor('owner@example.com');
    const user = await supa.tokenFor('user@example.com');
    const a = await serverCopy();
    const b = await serverCopy();
    await b.ai.init();
    // b just looked (its periodic check isn't due), then the owner adds a key through a
    expect((await fetch(`${b.base}/api/ai/providers`, { headers: as(owner) })).status).toBe(200);
    await fetch(`${a.base}/api/ai/providers/anthropic`, { method: 'PUT', headers: as(owner), body: JSON.stringify({ apiKey: 'sk-ant-fresh-6666', functions: ['seo'] }) });
    // an AI request on b finds no key for SEO, looks in Supabase once, and uses the new key
    const r = await fetch(`${b.base}/api/ai/generate`, { method: 'POST', headers: as(user), body: JSON.stringify({ fn: 'seo', prompt: 'title tags' }) });
    expect(r.status).toBe(200);
    expect((await r.json()).meta.provider).toBe('anthropic');
    // and the health answer the app routes on is never more than a second behind
    await fetch(`${a.base}/api/ai/providers/anthropic`, { method: 'PUT', headers: as(owner), body: JSON.stringify({ functions: ['seo', 'email'] }) });
    await new Promise((r2) => setTimeout(r2, 1100));
    expect((await b.ai.health({ id: owner.user.id, isAdmin: true })).routing.email).toContain('anthropic');
    await Promise.all([a.close(), b.close()]);
  });

  it('a slow Supabase doesn’t hold up AI requests', async () => {
    const user = await supa.tokenFor('user@example.com');
    const a = await serverCopy({ env: { OPENAI_API_KEY: 'sk-owner-typed-1234' } });
    await fetch(`${a.base}/api/ai/generate`, { method: 'POST', headers: as(user), body: JSON.stringify({ fn: 'research', prompt: 'warm up' }) });
    supa.behavior.restDelayMs = 4000;
    try {
      a.ai.store.lastCheck = 0; // its periodic check is due now
      const t0 = Date.now();
      const r = await fetch(`${a.base}/api/ai/generate`, { method: 'POST', headers: as(user), body: JSON.stringify({ fn: 'research', prompt: 'ideas' }) });
      expect(r.status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(1500);
      const t1 = Date.now();
      await a.ai.health({ id: user.user.id });
      expect(Date.now() - t1).toBeLessThan(2600);
    } finally {
      supa.behavior.restDelayMs = 0;
    }
    await a.close();
  }, 15_000);

  it('usage updates made on another copy aren’t undone, and updates for entries not seen yet wait for them', async () => {
    const mine = [{ id: 'm', at: 2, rev: 0, pending: true }];
    const theirs = [{ id: 'm', at: 2, rev: 1, pending: false, credits: 41 }];
    expect(mergeEntries(mine, theirs)[0]).toMatchObject({ pending: false, credits: 41 });
    const st = createAppState({ supabaseUrl: supa.url, secretKey: supa.SECRET });
    const { UsageLog } = await import('./providers/usage.mjs');
    const a = new UsageLog('', { remote: st });
    const b = new UsageLog('', { remote: st });
    const id = a.add({ provider: 'manus', pending: true });
    b.update(id, { pending: false, credits: 12 }); // b never saw it yet
    await a.flushRemote();
    await b.flushRemote();
    await a.flushRemote();
    const c = new UsageLog('', { remote: st });
    await c.loadRemote();
    expect(c.recent(50).find((e) => e.id === id)).toMatchObject({ pending: false, credits: 12 });
  });
});

describe('the app’s owner', () => {
  it('is whoever Supabase marks as admin (app_metadata), whatever their email', async () => {
    const auth = createAuth({ supabaseUrl: supa.url, publishableKey: supa.PUBLISHABLE, adminEmails: 'someone-else@example.com' });
    const boss = await supa.tokenFor('boss@shop.example', 'x', { appMetadata: { ylb_role: 'admin' } });
    const staff = await supa.tokenFor('staff@shop.example', 'x', { appMetadata: { ylb_role: 'editor' } });
    expect((await auth.identify({ headers: { authorization: `Bearer ${boss.token}` } })).isAdmin).toBe(true);
    expect((await auth.identify({ headers: { authorization: `Bearer ${staff.token}` } })).isAdmin).toBe(false);
  });
});
