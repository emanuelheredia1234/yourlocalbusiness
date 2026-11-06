// Weekly AI video limits per business (P1b): the week in the business's time zone, the claim (atomic, durable in
// Supabase, refunds only for a start that never reached a provider, own keys never counted) and the video route
// (402 VIDEO_WEEK_LIMIT, plans off: counted but never refused, the owner unlimited).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from './auth.mjs';
import { createUserKeys } from './userKeys.mjs';
import { createLimits } from './limits.mjs';
import { createAIRoutes } from './providers/routes.mjs';
import { createMockSupabase } from './test/mock-supabase.mjs';
import { createMockProviders } from './test/mock-providers.mjs';
import { entitlementOf } from './billing/entitlement.mjs';
import { createVideoWeek, validTimeZone, weekOf, zoneOf } from './videoWeek.mjs';

const DAY = 86_400_000;
const OWN_XAI = 'x-own-key-video-0000001';
const at = (iso) => Date.parse(iso);

describe('weekOf: Monday 00:00 to Sunday 23:59 in the business’s time zone', () => {
  it('starts on the local Monday and resets at the next local Monday midnight', () => {
    // Friday 2026-11-06 12:00 UTC
    expect(weekOf(at('2026-11-06T12:00:00Z'), 'UTC')).toEqual({ weekStart: '2026-11-02', resetsAt: '2026-11-09T00:00:00.000Z', timeZone: 'UTC' });
    // New York (EST after Nov 1): Monday 00:00 local is 05:00 UTC
    expect(weekOf(at('2026-11-06T12:00:00Z'), 'America/New_York')).toEqual({ weekStart: '2026-11-02', resetsAt: '2026-11-09T05:00:00.000Z', timeZone: 'America/New_York' });
  });

  it('a Sunday night locally is still the old week; a Monday morning locally is the new one', () => {
    // Monday 2026-11-09 03:00 UTC = Sunday 22:00 in New York
    expect(weekOf(at('2026-11-09T03:00:00Z'), 'America/New_York').weekStart).toBe('2026-11-02');
    // Sunday 2026-11-08 20:00 UTC = Monday 01:30 in Kolkata (+5:30)
    const k = weekOf(at('2026-11-08T20:00:00Z'), 'Asia/Kolkata');
    expect(k.weekStart).toBe('2026-11-09');
    expect(k.resetsAt).toBe('2026-11-15T18:30:00.000Z');
    // Chatham (+13:45 in summer)
    expect(weekOf(at('2026-11-08T10:15:00Z'), 'Pacific/Chatham').weekStart).toBe('2026-11-09');
  });

  it('handles the week daylight saving changes in', () => {
    // US clocks fall back on Sunday 2026-11-01: the week of Oct 26 began on EDT (-4), the next on EST (-5)
    const w = weekOf(at('2026-10-31T12:00:00Z'), 'America/New_York');
    expect(w.weekStart).toBe('2026-10-26');
    expect(w.resetsAt).toBe('2026-11-02T05:00:00.000Z');
    // Europe springs forward on Sunday 2026-03-29
    expect(weekOf(at('2026-03-28T12:00:00Z'), 'Europe/Berlin').resetsAt).toBe('2026-03-29T22:00:00.000Z');
  });

  it('falls back from the business’s zone to the browser’s, then UTC', () => {
    expect(validTimeZone('Europe/Paris')).toBe(true);
    expect(validTimeZone('Mars/Base')).toBe(false);
    expect(zoneOf('', 'Europe/Paris')).toBe('Europe/Paris');
    expect(zoneOf('Mars/Base', 'nope')).toBe('UTC');
    expect(weekOf(at('2026-11-06T12:00:00Z'), 'nope').timeZone).toBe('UTC');
  });
});

describe('createVideoWeek', () => {
  const W = '2026-11-02';

  it('in memory: refuses at the business’s limit, per business, and refunds and own-key videos never count', async () => {
    const vw = createVideoWeek();
    const claim = (o = {}) => vw.claim({ userId: 'u1', projectId: 'p1', weekStart: W, limit: 3, ...o });
    const a = await claim();
    expect(a).toMatchObject({ ok: true, used: 1, limit: 3 });
    await claim();
    const c = await claim();
    await vw.settle(c.id, 'refunded');
    expect((await vw.usage({ userId: 'u1', projectId: 'p1', weekStart: W })).used).toBe(2);
    expect(await claim()).toMatchObject({ ok: true, used: 3 });
    expect(await claim()).toMatchObject({ ok: false, used: 3, limit: 3, reason: 'business' });
    // an own-key video is recorded, never counted or refused
    expect(await claim({ own: true })).toMatchObject({ ok: true, used: 3 });
    // another business has its own week; another week starts fresh
    expect(await claim({ projectId: 'p2' })).toMatchObject({ ok: true, used: 1 });
    expect(await claim({ weekStart: '2026-11-09' })).toMatchObject({ ok: true, used: 1 });
    // no limit (plans off, Scale, the owner): counted, never refused
    expect(await claim({ limit: null })).toMatchObject({ ok: true, used: 4, limit: null });
  });

  it('the account’s total stops made-up business ids from getting around the limit', async () => {
    const vw = createVideoWeek();
    for (let i = 0; i < 3; i++) expect((await vw.claim({ userId: 'u2', projectId: `fake-${i}`, weekStart: W, limit: 3, userLimit: 3 })).ok).toBe(true);
    expect(await vw.claim({ userId: 'u2', projectId: 'fake-9', weekStart: W, limit: 3, userLimit: 3 })).toMatchObject({ ok: false, reason: 'account' });
  });

  describe('in Supabase', () => {
    let supa;
    beforeAll(async () => {
      supa = await (await createMockSupabase()).start();
    });
    afterAll(() => supa.close());

    it('keeps the claims durably and lets only `limit` of parallel starts through', async () => {
      const u = await supa.tokenFor('week@video.test');
      const vw = createVideoWeek({ supabaseUrl: supa.url, secretKey: supa.SECRET });
      const out = await Promise.all(Array.from({ length: 6 }, () => vw.claim({ userId: u.user.id, projectId: 'p1', weekStart: W, limit: 3 })));
      expect(out.filter((o) => o.ok)).toHaveLength(3);
      expect(out.filter((o) => !o.ok).every((o) => o.used === 3 && o.reason === 'business')).toBe(true);
      expect(supa.tables.get('video_starts').filter((r) => r.user_id === u.user.id)).toHaveLength(3);
      // a second server (or a restart) sees the same count
      const other = createVideoWeek({ supabaseUrl: supa.url, secretKey: supa.SECRET });
      expect(await other.usage({ userId: u.user.id, projectId: 'p1', weekStart: W })).toEqual({ used: 3, known: true });
      await other.settle(out.find((o) => o.ok).id, 'refunded');
      expect((await vw.usage({ userId: u.user.id, projectId: 'p1', weekStart: W })).used).toBe(2);
      await vw.settle(out.filter((o) => o.ok)[1].id, 'started', { jobId: 'vid_x' });
      expect(supa.tables.get('video_starts').find((r) => r.job_id === 'vid_x')?.state).toBe('started');
    });

    it('fails with UNAVAILABLE when Supabase doesn’t answer, and falls back to memory before the migration', async () => {
      const u = await supa.tokenFor('down@video.test');
      const vw = createVideoWeek({ supabaseUrl: supa.url, secretKey: supa.SECRET, fetch: async () => new Response('', { status: 503 }) });
      await expect(vw.claim({ userId: u.user.id, projectId: 'p', weekStart: W, limit: 3 })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      expect((await vw.usage({ userId: u.user.id, projectId: 'p', weekStart: W })).known).toBe(false);
      const missing = await (await createMockSupabase({ missingTables: ['video_starts'] })).start();
      try {
        const m = await missing.tokenFor('nomigration@video.test');
        const nv = createVideoWeek({ supabaseUrl: missing.url, secretKey: missing.SECRET });
        expect(await nv.claim({ userId: m.user.id, projectId: 'p', weekStart: W, limit: 1 })).toMatchObject({ ok: true });
        expect(nv.storage).toBe('memory');
        expect(nv.problem.code).toBe('NOT_SET_UP');
        expect(await nv.claim({ userId: m.user.id, projectId: 'p', weekStart: W, limit: 1 })).toMatchObject({ ok: false });
      } finally {
        await missing.close();
      }
    });
  });
});

describe('POST /api/ai/video with weekly limits', () => {
  let supa;
  let providers;
  beforeAll(async () => {
    supa = await (await createMockSupabase()).start();
    providers = await createMockProviders({ keys: { openai: ['o-key-owner-1'], xai: ['x-key-owner-1', OWN_XAI] } }).start();
  });
  afterAll(async () => {
    await supa.close();
    await providers.close();
  });

  const row = (over = {}) => ({ source: 'stripe', tier: 'launch', interval: 'month', status: 'active', business_limit: 1, current_period_start: new Date(Date.now() - 5 * DAY).toISOString(), current_period_end: new Date(Date.now() + 25 * DAY).toISOString(), ...over });
  function fakeBilling(enforce) {
    const accounts = new Map();
    return {
      accounts,
      entitlement: async (userId, who) => entitlementOf(accounts.get(userId) ?? null, { enforce }, Date.now(), { isAdmin: who?.isAdmin === true }),
      config: () => ({ enabled: true, enforce }),
    };
  }

  async function startApp(billing) {
    const auth = createAuth({ supabaseUrl: supa.url, publishableKey: supa.PUBLISHABLE, adminEmails: 'owner@video.test' });
    const send = (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const readJson = (req) =>
      new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => resolve(JSON.parse(raw || '{}')));
      });
    const videoWeek = createVideoWeek({ supabaseUrl: supa.url, secretKey: supa.SECRET });
    const ai = createAIRoutes({ send, readJson, corsHeaders: () => ({}), rateLimited: () => false, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-vweek-')), env: { OPENAI_API_KEY: 'o-key-owner-1', XAI_API_KEY: 'x-key-owner-1' }, baseUrls: providers.baseUrls(), auth, userKeys: createUserKeys({ supabaseUrl: supa.url, secretKey: supa.SECRET }), limits: createLimits({ supabaseUrl: supa.url, secretKey: supa.SECRET }), videoWeek });
    ai.setBilling(billing);
    ai.store.setLimits?.({ requestsPerDay: 0, usdPerDay: 0 });
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://local');
      ai.handle(req, res, url).then((h) => h === false && send(res, 404, { error: 'Not found' }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
  }

  const headersFor = (t) => ({ 'x-forwarded-for': '203.0.113.7', 'content-type': 'application/json', authorization: `Bearer ${t.token}` });
  const videoCalls = () => providers.calls.filter((c) => /videos\/generations/.test(c.path ?? c.url ?? '')).length;
  const start = (app, t, body = {}) => fetch(`${app.base}/api/ai/video`, { method: 'POST', headers: headersFor(t), body: JSON.stringify({ prompt: 'a candle on a table', duration: 5, projectId: 'proj_a', timeZone: 'America/New_York', ...body }) });
  const week = async (app, t, projectId = 'proj_a') => (await fetch(`${app.base}/api/ai/video/week?projectId=${projectId}&timeZone=America/New_York`, { headers: headersFor(t) })).json();

  it('Launch: 3 videos a week per business, then 402 VIDEO_WEEK_LIMIT before any provider call', async () => {
    const billing = fakeBilling(true);
    const app = await startApp(billing);
    try {
      const u = await supa.tokenFor('launch@video.test');
      billing.accounts.set(u.user.id, row({ tier: 'launch' }));
      for (let i = 1; i <= 3; i++) {
        const r = await start(app, u);
        expect(r.status).toBe(200);
        expect((await r.json()).videoWeek).toMatchObject({ used: i, limit: 3, enforced: true, timeZone: 'America/New_York' });
      }
      const calls = videoCalls();
      const r = await start(app, u);
      expect(r.status).toBe(402);
      const j = await r.json();
      expect(j).toMatchObject({ code: 'VIDEO_WEEK_LIMIT', used: 3, limit: 3, upgrade: '#plans', need: { feature: 'videos_per_week', tier: 'grow' } });
      expect(j.error).toBe('You’ve made 3 of 3 videos this week. Resets Monday.');
      expect(Date.parse(j.resetsAt)).toBeGreaterThan(Date.now());
      expect(videoCalls()).toBe(calls);
      expect(await week(app, u)).toMatchObject({ used: 3, limit: 3, enforced: true, known: true });
      // another business has its own week (an account with one business: its total is 3, so a second needs a slot)
      billing.accounts.set(u.user.id, row({ tier: 'launch', business_limit: 2 }));
      expect((await start(app, u, { projectId: 'proj_b' })).status).toBe(200);
      expect(await week(app, u, 'proj_b')).toMatchObject({ used: 1, limit: 3 });
    } finally {
      await app.close();
    }
  });

  it('two parallel starts at the limit can’t both pass', async () => {
    const billing = fakeBilling(true);
    const app = await startApp(billing);
    try {
      const u = await supa.tokenFor('parallel@video.test');
      billing.accounts.set(u.user.id, row({ tier: 'launch' }));
      expect((await start(app, u)).status).toBe(200);
      expect((await start(app, u)).status).toBe(200);
      const both = await Promise.all([start(app, u), start(app, u)]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 402]);
      expect(supa.tables.get('video_starts').filter((x) => x.user_id === u.user.id && x.state !== 'refunded')).toHaveLength(3);
    } finally {
      await app.close();
    }
  });

  it('a provider that refused before starting refunds the video; one that may have started counts it (never retried)', async () => {
    const billing = fakeBilling(true);
    const app = await startApp(billing);
    try {
      const u = await supa.tokenFor('refund@video.test');
      billing.accounts.set(u.user.id, row({ tier: 'grow' }));
      providers.behavior.xai = 'policy';
      expect((await start(app, u)).status).not.toBe(200);
      expect(await week(app, u)).toMatchObject({ used: 0, limit: 5 });
      providers.behavior.xai = 'fail500';
      const calls = videoCalls();
      expect((await start(app, u)).status).not.toBe(200);
      expect(videoCalls()).toBe(calls + 1);
      expect(await week(app, u)).toMatchObject({ used: 1, limit: 5 });
    } finally {
      delete providers.behavior.xai;
      await app.close();
    }
  });

  it('own-key videos are never counted or refused', async () => {
    const billing = fakeBilling(true);
    const app = await startApp(billing);
    try {
      const u = await supa.tokenFor('ownkey@video.test');
      billing.accounts.set(u.user.id, row({ tier: 'launch' }));
      const put = await fetch(`${app.base}/api/ai/my-keys/xai`, { method: 'PUT', headers: headersFor(u), body: JSON.stringify({ apiKey: OWN_XAI }) });
      expect(put.status).toBe(200);
      for (let i = 0; i < 4; i++) expect((await start(app, u)).status).toBe(200);
      expect(await week(app, u)).toMatchObject({ used: 0, limit: 3 });
      expect(supa.tables.get('video_starts').filter((x) => x.user_id === u.user.id && x.own_key)).toHaveLength(4);
    } finally {
      await app.close();
    }
  });

  it('plans not turned on: counted, never refused; Scale and the owner are unlimited', async () => {
    const off = await startApp(fakeBilling(false));
    try {
      const u = await supa.tokenFor('legacy@video.test');
      for (let i = 0; i < 4; i++) expect((await start(off, u)).status).toBe(200);
      expect(await week(off, u)).toMatchObject({ used: 4, limit: null, enforced: false });
    } finally {
      await off.close();
    }
    const billing = fakeBilling(true);
    const app = await startApp(billing);
    try {
      const s = await supa.tokenFor('scale@video.test');
      billing.accounts.set(s.user.id, row({ tier: 'scale' }));
      for (let i = 0; i < 6; i++) expect((await start(app, s)).status).toBe(200);
      expect(await week(app, s)).toMatchObject({ used: 6, limit: null, enforced: true });
      const owner = await supa.tokenFor('owner@video.test');
      for (let i = 0; i < 4; i++) expect((await start(app, owner)).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
