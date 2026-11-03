// Accounts 2: daily limits on the owner's keys, users' own keys for every provider, per-user usage.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from './auth.mjs';
import { createUserKeys } from './userKeys.mjs';
import { createLimits, nextReset, utcDay } from './limits.mjs';
import { createAIRoutes } from './providers/routes.mjs';
import { createMockSupabase } from './test/mock-supabase.mjs';
import { createMockProviders } from './test/mock-providers.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-limits-'));
const OWN = { openai: 'o-own-key-dave-00000001', anthropic: 'a-own-key-dave-00009999', xai: 'x-own-key-eve-000000042' };
let supa;
let providers;

beforeAll(async () => {
  supa = await (await createMockSupabase()).start();
  providers = await createMockProviders({
    keys: { openai: ['o-key-owner-1', OWN.openai], anthropic: [OWN.anthropic], xai: ['x-key-owner-1', OWN.xai], openrouter: 'or-key-owner-1' },
  }).start();
});
afterAll(async () => {
  await supa.close();
  await providers.close();
});

/** An app with accounts on; `supabaseLimits: false` keeps the daily counters in memory. */
function startApp({ supabaseLimits = true, env = { OPENAI_API_KEY: 'o-key-owner-1', XAI_API_KEY: 'x-key-owner-1' } } = {}) {
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
  const limits = supabaseLimits ? createLimits({ supabaseUrl: supa.url, secretKey: supa.SECRET }) : createLimits();
  const ai = createAIRoutes({
    send,
    readJson,
    corsHeaders: () => ({}),
    rateLimited: () => false,
    dataDir: tmpDir(),
    env,
    baseUrls: providers.baseUrls(),
    auth,
    userKeys: createUserKeys({ supabaseUrl: supa.url, secretKey: supa.SECRET }),
    limits,
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    ai.handle(req, res, url).then((h) => h === false && send(res, 404, { error: 'Not found' }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ ai, limits, server, base: `http://127.0.0.1:${server.address().port}` })));
}

const remote = { 'x-forwarded-for': '203.0.113.7', 'content-type': 'application/json' };
const as = (t) => ({ ...remote, ...(t ? { authorization: `Bearer ${t.token}` } : {}) });
const rowFor = (userId) => (supa.tables.get('ai_usage_daily') ?? []).find((r) => r.user_id === userId && r.day === utcDay());
const lastCall = (provider, p) => [...providers.calls].reverse().find((c) => c.provider === provider && (!p || c.path === p));

describe('the daily counters module', () => {
  it('counts in memory without Supabase (UTC days, requests and dollars, own keys apart)', async () => {
    const l = createLimits();
    expect(l.storage).toBe('memory');
    await l.add('u1', 'u1@example.com', { requests: 1, usd: 0.25 });
    await l.add('u1', 'u1@example.com', { requests: 1, usd: 0.5 });
    await l.add('u1', '', { ownRequests: 1, ownUsd: 2 });
    await l.add('u2', 'u2@example.com', { requests: 3 });
    expect(await l.usage('u1')).toEqual({ requests: 2, usd: 0.75, ownRequests: 1, ownUsd: 2 });
    const hist = await l.history('u1', { days: 7 });
    expect(hist).toHaveLength(7);
    expect(hist[0]).toMatchObject({ day: utcDay(), requests: 2 });
    expect(hist[1]).toMatchObject({ requests: 0, usd: 0 });
    const rows = await l.usageByUser({ days: 7 });
    expect(rows.map((r) => r.email)).toEqual(['u1@example.com', 'u2@example.com']);
    let st = await l.status('u2', { requestsPerDay: 4, usdPerDay: 0 });
    expect(st).toMatchObject({ usedRequests: 3, reached: false, resetsAt: nextReset() });
    // a request that's running counts toward the limit until it's recorded
    const release = l.reserve('u2');
    expect((await l.status('u2', { requestsPerDay: 4, usdPerDay: 0 })).reached).toBe(true);
    release();
    st = await l.status('u1', { requestsPerDay: 0, usdPerDay: 0.75 });
    expect(st.reached).toBe(true);
    expect((await l.status('u1', { requestsPerDay: 0, usdPerDay: 0 })).reached).toBe(false);
    expect(nextReset().endsWith('T00:00:00.000Z')).toBe(true);
  });

  it('adds atomically in Supabase through ylb_add_ai_usage, which only the secret key may call', async () => {
    const u = await supa.tokenFor('counter@example.com');
    const l = createLimits({ supabaseUrl: supa.url, secretKey: supa.SECRET });
    await Promise.all([l.add(u.user.id, 'counter@example.com', { requests: 1, usd: 0.1 }), l.add(u.user.id, 'counter@example.com', { requests: 1, usd: 0.2 })]);
    expect(rowFor(u.user.id)).toMatchObject({ requests: 2, usd: 0.3, email: 'counter@example.com' });
    // a fresh copy of the server (or a restart) sees the same counters
    expect(await createLimits({ supabaseUrl: supa.url, secretKey: supa.SECRET }).usage(u.user.id)).toMatchObject({ requests: 2, usd: 0.3 });
    // browsers can't call the function or read the table
    const asUser = { apikey: supa.PUBLISHABLE, authorization: `Bearer ${u.token}`, 'content-type': 'application/json' };
    expect((await fetch(`${supa.url}/rest/v1/rpc/ylb_add_ai_usage`, { method: 'POST', headers: asUser, body: JSON.stringify({ p_user: u.user.id, p_day: utcDay(), p_requests: -5, p_usd: 0 }) })).status).toBe(401);
    expect((await fetch(`${supa.url}/rest/v1/ai_usage_daily?user_id=eq.${u.user.id}`, { headers: asUser })).status).toBe(401);
  });
});

describe('limits, own keys and usage with accounts on', () => {
  let app;
  let owner;
  let alice;
  let bob;
  let dave;
  let eve;
  const call = (p, init = {}) => fetch(`${app.base}${p}`, init);
  const gen = (who, fn = 'research') => call('/api/ai/generate', { method: 'POST', headers: as(who), body: JSON.stringify({ fn, prompt: 'ideas' }) });
  const setLimits = (l, who = owner) => call('/api/ai/limits', { method: 'PUT', headers: as(who), body: JSON.stringify(l) });

  beforeAll(async () => {
    app = await startApp();
    owner = await supa.tokenFor('owner@example.com');
    alice = await supa.tokenFor('alice@example.com');
    bob = await supa.tokenFor('bob@example.com');
    dave = await supa.tokenFor('dave@example.com');
    eve = await supa.tokenFor('eve@example.com');
  });
  afterAll(() => app.server.close());

  it('has sensible default limits that only the owner can read or change', async () => {
    let r = await call('/api/ai/limits', { headers: as(owner) });
    expect(await r.json()).toMatchObject({ limits: { requestsPerDay: 50, usdPerDay: 1 }, storage: 'supabase' });
    expect((await call('/api/ai/limits', { headers: as(alice) })).status).toBe(403);
    expect((await setLimits({ requestsPerDay: 1000 }, alice)).status).toBe(403);
    expect((await setLimits({ requestsPerDay: -1 })).status).toBe(400);
    r = await setLimits({ requestsPerDay: 2, usdPerDay: 0 });
    expect(r.status).toBe(200);
    expect((await r.json()).limits).toEqual({ requestsPerDay: 2, usdPerDay: 0 });
    // kept with the other AI settings (and shown on the owner's settings page)
    expect(app.ai.store.state.limits).toEqual({ requestsPerDay: 2, usdPerDay: 0 });
    expect((await (await call('/api/ai/providers', { headers: as(owner) })).json()).state.limits).toEqual({ requestsPerDay: 2, usdPerDay: 0 });
  });

  it('stops a user at the daily request limit with DAILY_LIMIT, and never limits the owner', async () => {
    await setLimits({ requestsPerDay: 2, usdPerDay: 0 });
    expect((await gen(alice)).status).toBe(200);
    expect((await gen(alice)).status).toBe(200);
    const r = await gen(alice);
    expect(r.status).toBe(429);
    const j = await r.json();
    expect(j.code).toBe('DAILY_LIMIT');
    expect(j.error).toMatch(/limit on the app’s AI keys/);
    expect(j.error).toMatch(/midnight UTC/);
    expect(j.error).toMatch(/Settings → AI/);
    expect(j.limits).toMatchObject({ requestsPerDay: 2, usedRequests: 2, reached: true });
    expect(rowFor(alice.user.id)).toMatchObject({ requests: 2, email: 'alice@example.com' });
    // photos and videos on the owner's keys are limited too
    expect((await call('/api/ai/image', { method: 'POST', headers: as(alice), body: JSON.stringify({ prompt: 'a candle' }) })).status).toBe(429);
    expect((await call('/api/ai/video', { method: 'POST', headers: as(alice), body: JSON.stringify({ prompt: 'a candle' }) })).status).toBe(429);
    // the owner is never limited, nor counted
    for (let i = 0; i < 3; i++) expect((await gen(owner)).status).toBe(200);
    expect(rowFor(owner.user.id)).toBeUndefined();
    // health tells the app where the user stands
    const h = await app.ai.health({ id: alice.user.id, email: 'alice@example.com', isAdmin: false });
    expect(h.limits).toMatchObject({ unlimited: false, requestsPerDay: 2, usdPerDay: 0, usedRequests: 2, reached: true });
    expect(Date.parse(h.limits.resetsAt)).toBeGreaterThan(Date.now());
    expect((await app.ai.health({ id: owner.user.id, isAdmin: true })).limits).toEqual({ unlimited: true });
  });

  it('doesn’t count requests that never reached a provider', async () => {
    await setLimits({ requestsPerDay: 5, usdPerDay: 0 });
    // no key powers videos for this function → refused before anything is sent
    app.ai.store.update('xai', { functions: ['research'] });
    const r = await call('/api/ai/video', { method: 'POST', headers: as(bob), body: JSON.stringify({ prompt: 'a candle' }) });
    expect(r.status).toBe(409);
    expect(rowFor(bob.user.id)).toBeUndefined();
    app.ai.store.update('xai', { functions: ['research', 'videos'] });
  });

  it('adds up each request’s cost against the dollar limit', async () => {
    await setLimits({ requestsPerDay: 0, usdPerDay: 0.008 });
    // xAI writing (first in the owner's order): 200 tokens in, 630 out at $2/$6 per million = $0.00418
    const first = await (await gen(bob)).json();
    expect(first.meta).toMatchObject({ provider: 'xai', cost: { usd: 0.00418 } });
    expect((await gen(bob)).status).toBe(200);
    expect(rowFor(bob.user.id).usd).toBeCloseTo(0.00836, 6);
    const r = await gen(bob);
    expect(r.status).toBe(429);
    expect((await r.json()).code).toBe('DAILY_LIMIT');
  });

  it('counts a video’s cost when the job finishes', async () => {
    await setLimits({ requestsPerDay: 0, usdPerDay: 5 });
    app.ai.store.update('xai', { functions: ['research'] });
    // an OpenRouter key just for videos (it reports the exact cost: $0.16)
    app.ai.store.update('openrouter', { apiKey: 'or-key-owner-1', functions: ['videos'] });
    const carol = await supa.tokenFor('carol@example.com');
    const { job } = await (await call('/api/ai/video', { method: 'POST', headers: as(carol), body: JSON.stringify({ prompt: 'a candle', aspect: '9:16' }) })).json();
    expect(rowFor(carol.user.id)).toMatchObject({ requests: 1, usd: 0 });
    let state = job.state;
    for (let i = 0; i < 4 && state !== 'done'; i++) {
      app.ai.router.jobs.get(job.id).checkedAt = 0;
      state = (await (await call(`/api/ai/video/${job.id}`, { headers: as(carol) })).json()).job.state;
    }
    expect(state).toBe('done');
    await new Promise((r) => setTimeout(r, 50));
    expect(rowFor(carol.user.id).usd).toBeCloseTo(0.16, 6);
    app.ai.store.update('openrouter', { removeKey: true });
    app.ai.store.update('xai', { functions: ['research', 'videos'] });
  });

  it('lets a user add their own key for any provider: checked first, stored encrypted, shown masked', async () => {
    let r = await call('/api/ai/my-keys', { headers: as(dave) });
    let j = await r.json();
    expect(j).toMatchObject({ available: true, keys: [] });
    expect(j.providers.map((p) => p.id).sort()).toEqual(['anthropic', 'google', 'manus', 'meta', 'openai', 'openrouter', 'xai']);
    expect(j.providers.find((p) => p.id === 'openai').kinds).toEqual(['text', 'image']);
    // a key the provider refuses isn't saved
    r = await call('/api/ai/my-keys/openai', { method: 'PUT', headers: as(dave), body: JSON.stringify({ apiKey: 'o-wrong-key-0000000000' }) });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('BAD_KEY');
    r = await call('/api/ai/my-keys/openai', { method: 'PUT', headers: as(dave), body: JSON.stringify({ apiKey: 'short' }) });
    expect((await r.json()).code).toBe('BAD_REQUEST');
    expect((await call('/api/ai/my-keys/openrouter2', { method: 'PUT', headers: as(dave), body: JSON.stringify({ apiKey: OWN.openai }) })).status).toBe(404);
    r = await call('/api/ai/my-keys/openai', { method: 'PUT', headers: as(dave), body: JSON.stringify({ apiKey: OWN.openai }) });
    expect(r.status).toBe(200);
    // checked with a free model list, using their key
    expect(JSON.stringify(lastCall('openai', '/models').headers)).toContain(OWN.openai);
    j = await r.json();
    expect(j.keys).toEqual([{ provider: 'openai', last4: '0001', updatedAt: expect.any(String) }]);
    expect(JSON.stringify(j)).not.toContain(OWN.openai);
    const stored = supa.tables.get('user_secrets').find((x) => x.user_id === dave.user.id && x.provider === 'openai');
    expect(stored.ciphertext).not.toContain('dave');
    // nobody else sees it
    expect((await (await call('/api/ai/my-keys', { headers: as(bob) })).json()).keys).toEqual([]);
    expect((await call('/api/ai/my-keys', { headers: as(null) })).status).toBe(401);
  });

  it('runs a user on their own key instead of the owner’s, never limited, and records it apart', async () => {
    await setLimits({ requestsPerDay: 1, usdPerDay: 0 });
    // without their own key: used up on the owner's keys…
    expect((await call('/api/ai/my-keys/openai', { method: 'DELETE', headers: as(dave) })).status).toBe(200);
    expect((await gen(dave)).status).toBe(200);
    expect(lastCall('xai', '/chat/completions').headers.authorization).toBe('Bearer x-key-owner-1');
    expect((await gen(dave)).status).toBe(429);
    // …but writing and photos run on their own OpenAI key
    expect((await call('/api/ai/my-keys/openai', { method: 'PUT', headers: as(dave), body: JSON.stringify({ apiKey: OWN.openai }) })).status).toBe(200);
    const r = await gen(dave);
    expect(r.status).toBe(200);
    const { meta } = await r.json();
    expect(meta).toMatchObject({ provider: 'openai', providerLabel: 'OpenAI (your key)', ownKey: true, model: 'gpt-6.1-sol', effort: 'medium' });
    expect(lastCall('openai', '/responses').headers.authorization).toBe(`Bearer ${OWN.openai}`);
    const img = await call('/api/ai/image', { method: 'POST', headers: as(dave), body: JSON.stringify({ prompt: 'a candle' }) });
    expect(img.status).toBe(200);
    expect(lastCall('openai', '/images/generations').headers.authorization).toBe(`Bearer ${OWN.openai}`);
    expect(app.ai.usage.recent(1)[0]).toMatchObject({ userId: dave.user.id, ownKey: true, providerLabel: 'OpenAI (your key)' });
    expect(rowFor(dave.user.id)).toMatchObject({ requests: 1, own_requests: 2 });
    expect(rowFor(dave.user.id).own_usd).toBeGreaterThan(0);
    // videos: no own key can make them, so they still use the owner's keys (and are limited)
    expect((await call('/api/ai/video', { method: 'POST', headers: as(dave), body: JSON.stringify({ prompt: 'x' }) })).status).toBe(429);
    // the app is told what runs where
    const h = await app.ai.health({ id: dave.user.id, email: 'dave@example.com', isAdmin: false });
    expect(h.providers.filter((p) => p.id === 'openai')).toEqual([expect.objectContaining({ label: 'OpenAI (your key)', own: true, ready: true })]);
    expect(h.routing.research).toEqual(['openai']);
    expect(h.routing.photos).toEqual(['openai']);
    expect(h.routing.videos).toEqual(['xai']);
    expect(h.ownKeyFunctions).toContain('research');
    expect(h.ownKeyFunctions).not.toContain('videos');
    // a failing own key doesn't fall back to the owner's keys
    providers.behavior.openai = 'fail500';
    const failed = await gen(dave);
    providers.behavior.openai = undefined;
    expect(failed.status).toBe(502);
    expect(lastCall('xai').headers.authorization).not.toContain(OWN.xai);
  });

  it('uses another provider’s own key when it’s the one that can do the job', async () => {
    expect((await call('/api/ai/my-keys/anthropic', { method: 'PUT', headers: as(dave), body: JSON.stringify({ apiKey: OWN.anthropic }) })).status).toBe(200);
    expect((await call('/api/ai/my-keys/openai', { method: 'DELETE', headers: as(dave) })).status).toBe(200);
    const r = await gen(dave);
    expect(r.status).toBe(200);
    expect((await r.json()).meta).toMatchObject({ provider: 'anthropic', providerLabel: 'Anthropic Claude (your key)' });
    expect(lastCall('anthropic', '/v1/messages').headers.authorization).toBe(`Bearer ${OWN.anthropic}`);
    // Anthropic doesn't make photos: those go back to the owner's keys, within the limit
    expect((await call('/api/ai/image', { method: 'POST', headers: as(dave), body: JSON.stringify({ prompt: 'a candle' }) })).status).toBe(429);
    const keys = await (await call('/api/ai/my-keys', { headers: as(dave) })).json();
    expect(keys.keys.map((k) => k.provider)).toEqual(['anthropic']);
  });

  it('follows a video started on an own key with that key, without keeping the key on the job', async () => {
    await setLimits({ requestsPerDay: 0, usdPerDay: 0 });
    expect((await call('/api/ai/my-keys/xai', { method: 'PUT', headers: as(eve), body: JSON.stringify({ apiKey: OWN.xai }) })).status).toBe(200);
    const r = await call('/api/ai/video', { method: 'POST', headers: as(eve), body: JSON.stringify({ prompt: 'a candle', aspect: '9:16' }) });
    expect(r.status).toBe(200);
    const { job } = await r.json();
    expect(job.meta.providerLabel).toBe('xAI Grok (your key)');
    expect(lastCall('xai', '/videos/generations').headers.authorization).toBe(`Bearer ${OWN.xai}`);
    expect(JSON.stringify(app.ai.router.jobs.get(job.id))).not.toContain(OWN.xai);
    let state = job.state;
    for (let i = 0; i < 4 && state !== 'done'; i++) {
      app.ai.router.jobs.get(job.id).checkedAt = 0;
      state = (await (await call(`/api/ai/video/${job.id}`, { headers: as(eve) })).json()).job.state;
    }
    expect(state).toBe('done');
    expect(lastCall('xai').path).toMatch(/^\/videos\//);
    expect(lastCall('xai').headers.authorization).toBe(`Bearer ${OWN.xai}`);
    const content = await call(`/api/ai/video/${job.id}/content`, { headers: as(eve) });
    expect(content.status).toBe(200);
    expect(rowFor(eve.user.id)).toMatchObject({ requests: 0, own_requests: 1 });
    // another user can't follow it
    expect((await call(`/api/ai/video/${job.id}`, { headers: as(bob) })).status).toBe(404);
  });

  it('shows each user their own usage, and the owner everyone’s', async () => {
    let r = await call('/api/ai/my-usage', { headers: as(alice) });
    let j = await r.json();
    expect(j.day).toBe(utcDay());
    expect(j.today).toMatchObject({ requests: 2 });
    expect(j.days).toHaveLength(7);
    expect(j.limits).toMatchObject({ unlimited: false, usedRequests: 2 });
    j = await (await call('/api/ai/my-usage', { headers: as(dave) })).json();
    expect(j.today.ownRequests).toBeGreaterThanOrEqual(3);
    expect((await (await call('/api/ai/my-usage', { headers: as(owner) })).json()).limits).toEqual({ unlimited: true });
    expect((await call('/api/ai/my-usage', { headers: as(null) })).status).toBe(401);
    // only the owner sees everyone's
    expect((await call('/api/ai/usage/users?days=7', { headers: as(alice) })).status).toBe(403);
    r = await call('/api/ai/usage/users?days=7', { headers: as(owner) });
    expect(r.status).toBe(200);
    j = await r.json();
    expect(j.days).toBe(7);
    expect(j.rows).toEqual(expect.arrayContaining([expect.objectContaining({ email: 'alice@example.com', day: utcDay(), requests: 2 }), expect.objectContaining({ email: 'bob@example.com' })]));
    expect(j.users.find((u) => u.email === 'bob@example.com').usd).toBeCloseTo(0.00836, 6);
  });

  it('keeps the counters across a restart (Supabase)', async () => {
    const again = await startApp();
    try {
      // limits are settings: a fresh server starts from the defaults on its own disk, so set them again
      again.ai.store.setLimits({ requestsPerDay: 2, usdPerDay: 0 });
      const r = await fetch(`${again.base}/api/ai/generate`, { method: 'POST', headers: as(alice), body: JSON.stringify({ fn: 'research', prompt: 'ideas' }) });
      expect(r.status).toBe(429);
      expect((await r.json()).code).toBe('DAILY_LIMIT');
    } finally {
      again.server.close();
    }
  });
});

describe('limits without Supabase counters', () => {
  it('counts in memory and still enforces the limit', async () => {
    const app = await startApp({ supabaseLimits: false });
    try {
      app.ai.store.setLimits({ requestsPerDay: 1, usdPerDay: 0 });
      const frank = await supa.tokenFor('frank@example.com');
      const gen = () => fetch(`${app.base}/api/ai/generate`, { method: 'POST', headers: as(frank), body: JSON.stringify({ fn: 'research', prompt: 'ideas' }) });
      expect((await gen()).status).toBe(200);
      expect((await gen()).status).toBe(429);
      expect(rowFor(frank.user.id)).toBeUndefined();
      const mine = await (await fetch(`${app.base}/api/ai/my-usage`, { headers: as(frank) })).json();
      expect(mine).toMatchObject({ storage: 'memory', today: { requests: 1 } });
    } finally {
      app.server.close();
    }
  });
});
