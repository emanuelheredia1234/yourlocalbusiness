// What plans gate (spec §A6, C1.10): the month's AI credits on top of the daily counters (own keys never counted,
// parallel requests can't all slip under, strict for videos), a paused plan refused before any provider call, video
// length per tier, the treg budget layer per tier, and the never-gated paths. Ads, Upload-Post, pages, analytics,
// posting and connecting are tested next to their modules (ads/gate.test.mjs, connections/uploadpost.test.mjs,
// pages.test.mjs) and here through requireActive.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from '../auth.mjs';
import { createUserKeys } from '../userKeys.mjs';
import { createLimits, utcDay } from '../limits.mjs';
import { createAIRoutes } from '../providers/routes.mjs';
import { effortWithin } from '../providers/router.mjs';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { createMockProviders } from '../test/mock-providers.mjs';
import { entitlementOf } from './entitlement.mjs';
import { BUILTIN_DEFAULTS, createCaps, mergeCaps } from './caps.mjs';
import { billingServer } from './test-helpers.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-gating-'));
const OWN_KEY = 'o-own-key-gate-00000001';
const OWN_VIDEO_KEY = 'x-own-key-gate-00000001';
const DAY = 86_400_000;
let supa;
let providers;

beforeAll(async () => {
  supa = await (await createMockSupabase()).start();
  providers = await createMockProviders({ keys: { openai: ['o-key-owner-1', OWN_KEY], xai: ['x-key-owner-1', OWN_VIDEO_KEY] } }).start();
});
afterAll(async () => {
  await supa.close();
  await providers.close();
});

/** A plans facade over a fixed account per user id (as server/billing/stripe.mjs answers). */
function fakeBilling(enforce = true) {
  const accounts = new Map();
  return {
    accounts,
    entitlement: async (userId, who) => entitlementOf(accounts.get(userId) ?? null, { enforce }, Date.now(), { isAdmin: who?.isAdmin === true }),
    config: () => ({ enabled: true, enforce }),
  };
}

async function startApp(billing) {
  const auth = createAuth({ supabaseUrl: supa.url, publishableKey: supa.PUBLISHABLE, adminEmails: 'owner@gate.test' });
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
  const limits = createLimits({ supabaseUrl: supa.url, secretKey: supa.SECRET });
  const ai = createAIRoutes({ send, readJson, corsHeaders: () => ({}), rateLimited: () => false, dataDir: tmpDir(), env: { OPENAI_API_KEY: 'o-key-owner-1', XAI_API_KEY: 'x-key-owner-1' }, baseUrls: providers.baseUrls(), auth, userKeys: createUserKeys({ supabaseUrl: supa.url, secretKey: supa.SECRET }), limits });
  ai.setBilling(billing);
  ai.store.setLimits?.({ requestsPerDay: 0, usdPerDay: 0 });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    ai.handle(req, res, url).then((h) => h === false && send(res, 404, { error: 'Not found' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { ai, limits, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const headersFor = (t) => ({ 'x-forwarded-for': '203.0.113.9', 'content-type': 'application/json', authorization: `Bearer ${t.token}` });
const window = () => ({ current_period_start: new Date(Date.now() - 5 * DAY).toISOString(), current_period_end: new Date(Date.now() + 25 * DAY).toISOString() });
const row = (over = {}) => ({ source: 'stripe', tier: 'launch', interval: 'month', status: 'active', business_limit: 1, ...window(), ...over });
const usedUsd = (userId, usd) => {
  const rows = supa.tables.get('ai_usage_daily') ?? [];
  supa.tables.set('ai_usage_daily', rows);
  rows.push({ user_id: userId, day: utcDay(Date.now() - DAY), email: '', requests: 1, usd, own_requests: 0, own_usd: 0 });
};

describe('the AI gate with plans', () => {
  let app;
  let billing;
  beforeAll(async () => {
    billing = fakeBilling(true);
    app = await startApp(billing);
  });
  afterAll(() => app.close());
  const gen = (t) => fetch(`${app.base}/api/ai/generate`, { method: 'POST', headers: headersFor(t), body: JSON.stringify({ fn: 'research', prompt: 'ideas' }) });

  it('refuses a paused plan with 402 before any provider call, and no plan at all', async () => {
    const u = await supa.tokenFor('paused@gate.test');
    billing.accounts.set(u.user.id, row({ status: 'unpaid' }));
    const calls = providers.calls.length;
    const r = await gen(u);
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ code: 'PAYMENT_REQUIRED' });
    // a plan that ended: no AI on the app's keys
    const ended = await supa.tokenFor('ended@gate.test');
    billing.accounts.set(ended.user.id, row({ tier: 'none', status: 'canceled', ended_at: new Date(Date.now() - DAY).toISOString() }));
    const n = await gen(ended);
    expect(n.status).toBe(402);
    expect(await n.json()).toMatchObject({ code: 'PLAN_REQUIRED', upgrade: '#plans' });
    expect(providers.calls.length).toBe(calls);
  });

  it('before any plan: setup’s one-off AI allowance (200 credits), then “Start your free trial”; never a video', async () => {
    const fresh = await supa.tokenFor('setup@gate.test');
    expect((await gen(fresh)).status).toBe(200);
    // $2 used on the app's keys: the allowance is spent, and it never renews
    usedUsd(fresh.user.id, 2);
    const r = await gen(fresh);
    expect(r.status).toBe(402);
    const j = await r.json();
    expect(j).toMatchObject({ code: 'PLAN_REQUIRED', need: { feature: 'ai' }, upgrade: '#plans' });
    expect(j.error).toContain('Start your free trial');
    const calls = providers.calls.length;
    const v = await fetch(`${app.base}/api/ai/video`, { method: 'POST', headers: headersFor(fresh), body: JSON.stringify({ prompt: 'a cafe', duration: 5 }) });
    expect(v.status).toBe(402);
    expect(await v.json()).toMatchObject({ code: 'PLAN_REQUIRED', need: { feature: 'video' }, error: 'AI video is part of every plan. Choose a plan to make videos, or use your own AI keys.' });
    // a longer one says the same on the app's keys (not the plan's length)
    const long = await fetch(`${app.base}/api/ai/video`, { method: 'POST', headers: headersFor(fresh), body: JSON.stringify({ prompt: 'a cafe', duration: 15 }) });
    expect(await long.json()).toMatchObject({ code: 'PLAN_REQUIRED', need: { feature: 'video' } });
    expect(providers.calls.length).toBe(calls);
  });

  it('own keys are never limited by a plan: AI video on the user’s own key with no plan, or a plan that ended', async () => {
    for (const [email, acct] of [['ownvideo@gate.test', null], ['ownlapsed@gate.test', row({ tier: 'none', status: 'canceled', ended_at: new Date(Date.now() - DAY).toISOString() })]]) {
      const u = await supa.tokenFor(email);
      if (acct) billing.accounts.set(u.user.id, acct);
      const put = await fetch(`${app.base}/api/ai/my-keys/xai`, { method: 'PUT', headers: headersFor(u), body: JSON.stringify({ apiKey: OWN_VIDEO_KEY }) });
      expect(put.status).toBe(200);
      const v = await fetch(`${app.base}/api/ai/video`, { method: 'POST', headers: headersFor(u), body: JSON.stringify({ prompt: 'a cafe', duration: 5 }) });
      expect(v.status).toBe(200);
      expect((await v.json()).job).toBeTruthy();
      await fetch(`${app.base}/api/ai/my-keys/xai`, { method: 'DELETE', headers: headersFor(u) });
    }
  });

  it('a card trial: its 300 credits on top of what setup spent that day before it; used up, it says so (nothing to add during a trial)', async () => {
    const u = await supa.tokenFor('trialgate@gate.test');
    const start = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const trial = row({ tier: 'grow', status: 'trialing', current_period_start: start, current_period_end: new Date(Date.now() + 7 * DAY).toISOString(), trial_ends_at: new Date(Date.now() + 7 * DAY).toISOString() });
    const day = utcDay(Date.parse(start));
    supa.tables.set('ai_usage_daily', [...(supa.tables.get('ai_usage_daily') ?? []).filter((r) => r.user_id !== u.user.id), { user_id: u.user.id, day, email: '', requests: 9, usd: 4, own_requests: 0, own_usd: 0 }]);
    const withBaseline = { ...billing, entitlement: async (id, who) => {
      const ent = await billing.entitlement(id, who);
      return id === u.user.id ? { ...ent, creditWindow: { ...ent.creditWindow, baselineUsd: 1.8 } } : ent;
    } };
    billing.accounts.set(u.user.id, trial);
    const t = await startApp(withBaseline);
    try {
      // $4 spent today, $1.80 of it by setup before the trial: $2.20 of the trial's $3 used, so it still runs
      expect((await fetch(`${t.base}/api/ai/generate`, { method: 'POST', headers: headersFor(u), body: JSON.stringify({ fn: 'research', prompt: 'ideas' }) })).status).toBe(200);
      const usage = await (await fetch(`${t.base}/api/ai/my-usage`, { headers: headersFor(u) })).json();
      expect(usage.credits.monthly).toBe(300);
      expect(usage.credits.usedCredits).toBeGreaterThanOrEqual(220);
      expect(usage.credits.usedCredits).toBeLessThan(230);
      // the trial's credits used up: what to do now, never "add a business or upgrade"
      supa.tables.get('ai_usage_daily').find((r) => r.user_id === u.user.id).usd = 4.8;
      const r = await fetch(`${t.base}/api/ai/generate`, { method: 'POST', headers: headersFor(u), body: JSON.stringify({ fn: 'research', prompt: 'ideas' }) });
      expect(r.status).toBe(402);
      const j = await r.json();
      expect(j).toMatchObject({ code: 'CREDITS_USED', trial: true, credits: { monthly: 300 } });
      expect(j.error).toMatch(/^You’ve used the 300 AI credits included in your free trial\. Your plan’s monthly credits start when the trial ends on .+\. Until then, use your own AI keys\.$/);
      expect(j.error).not.toMatch(/business|upgrade/i);
    } finally {
      await t.close();
    }
  });

  it('stops at the month’s credits with CREDITS_USED and when they renew; own keys are never counted or limited', async () => {
    const u = await supa.tokenFor('credits@gate.test');
    billing.accounts.set(u.user.id, row({ tier: 'launch' }));
    expect((await gen(u)).status).toBe(200);
    // 1,500 credits = $15 on the app's keys: used up
    usedUsd(u.user.id, 15);
    const r = await gen(u);
    expect(r.status).toBe(402);
    const j = await r.json();
    expect(j).toMatchObject({ code: 'CREDITS_USED', credits: { monthly: 1500 } });
    expect(j.error).toMatch(/You’ve used this month’s AI credits\. They renew on .+\. Add a business or upgrade for more, or use your own AI keys\./);
    expect(Date.parse(j.resetsAt)).toBeGreaterThan(Date.now());
    // their own key: never limited, never counted toward credits
    const put = await fetch(`${app.base}/api/ai/my-keys/openai`, { method: 'PUT', headers: headersFor(u), body: JSON.stringify({ apiKey: OWN_KEY }) });
    expect(put.status).toBe(200);
    expect((await gen(u)).status).toBe(200);
    const usage = await (await fetch(`${app.base}/api/ai/my-usage`, { headers: headersFor(u) })).json();
    expect(usage.credits.monthly).toBe(1500);
    // the $15 used before, plus the first request on the app's keys; the own-key request adds nothing
    expect(usage.credits.usedCredits).toBeGreaterThanOrEqual(1500);
    expect(usage.credits.usedCredits).toBeLessThan(1510);
    // a business added on the plan raises the month (1,000 more): back under it
    billing.accounts.set(u.user.id, row({ tier: 'launch', business_limit: 2 }));
    await fetch(`${app.base}/api/ai/my-keys/openai`, { method: 'DELETE', headers: headersFor(u) });
    expect((await gen(u)).status).toBe(200);
  });

  it('counts requests in flight: parallel requests can’t all slip under the month (monthStatus)', async () => {
    const limits = createLimits();
    const id = 'parallel-user';
    await limits.add(id, '', { requests: 1, usd: 0.95 });
    const r1 = limits.reserve(id, { usd: 0.04 });
    const r2 = limits.reserve(id, { usd: 0.04 });
    const since = utcDay();
    const s1 = await limits.monthStatus(id, { budgetUsd: 1, sinceDay: since }, { reservation: r1 });
    const s2 = await limits.monthStatus(id, { budgetUsd: 1, sinceDay: since }, { reservation: r2 });
    expect(s1.reached).toBe(false);
    expect(s2.reached).toBe(false);
    const r3 = limits.reserve(id, { usd: 0.04 });
    expect((await limits.monthStatus(id, { budgetUsd: 1, sinceDay: since }, { reservation: r3, strict: true })).reached).toBe(true);
    // own-key dollars never count
    await limits.add(id, '', { ownRequests: 5, ownUsd: 50 });
    expect((await limits.monthUsage(id, since)).usd).toBe(0.95);
    [r1, r2, r3].forEach((r) => r());
  });

  it('holds videos to the plan’s length (402 above it) and passes the plan’s height to the provider', async () => {
    const u = await supa.tokenFor('video@gate.test');
    billing.accounts.set(u.user.id, row({ tier: 'launch' }));
    const r = await fetch(`${app.base}/api/ai/video`, { method: 'POST', headers: headersFor(u), body: JSON.stringify({ prompt: 'a candle', duration: 15 }) });
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ code: 'PLAN_REQUIRED', need: { feature: 'video_length', tier: 'grow' } });
    // 2K on Launch (768p) uses the model's highest setting at or under 768
    expect(effortWithin(['480p', '768p', '2K'], '2K', 768)).toBe('768p');
    expect(effortWithin(['480p', '768p', '2K'], '2K', 1440)).toBe('2K');
    expect(effortWithin(['360p', '720p', '1080p', '4k'], '4k', 1440)).toBe('1080p');
    expect(effortWithin(['low', 'high'], 'high', 768)).toBe('high');
  });

  it('changes nothing while plans are not enforced (legacy), and never gates the owner', async () => {
    const off = await startApp(fakeBilling(false));
    try {
      const u = await supa.tokenFor('legacy@gate.test');
      const r = await fetch(`${off.base}/api/ai/generate`, { method: 'POST', headers: headersFor(u), body: JSON.stringify({ fn: 'research', prompt: 'ideas' }) });
      expect(r.status).toBe(200);
    } finally {
      await off.close();
    }
    const owner = await supa.tokenFor('owner@gate.test');
    expect((await gen(owner)).status).toBe(200);
  });
});

describe('the treg budget per tier (caps.mjs tier layer)', () => {
  it('sits between the defaults and a manual override', () => {
    const tier = { monthly_cap_micro: 8_000_000, daily_cap_micro: 800_000 };
    expect(mergeCaps(null, null, tier)).toMatchObject({ monthly_cap_micro: 8_000_000, daily_cap_micro: 800_000, calls_per_day: BUILTIN_DEFAULTS.calls_per_day });
    expect(mergeCaps(null, { monthly_cap_micro: 1_000, status: 'active' }, tier)).toMatchObject({ monthly_cap_micro: 1_000, daily_cap_micro: 800_000 });
    expect(mergeCaps(null, null, null)).toMatchObject({ monthly_cap_micro: BUILTIN_DEFAULTS.monthly_cap_micro });
  });

  it('createCaps uses the customer’s tier, and sends it to treg even without an override row', async () => {
    const puts = [];
    const db = { select: async () => [], update: async () => [], upsert: async () => [], remove: async () => [] };
    const admin = { budgets: { put: async (tag, body) => puts.push([tag, body]), delete: async () => puts.push(['delete']) } };
    const caps = createCaps({ db, ledger: null, admin, tierFor: async (tag) => (tag === 'cust_scale' ? { monthly_cap_micro: 20_000_000, daily_cap_micro: 2_000_000 } : null) });
    expect(await caps.effective('cust_scale')).toMatchObject({ monthly_cap_micro: 20_000_000, daily_cap_micro: 2_000_000 });
    expect(await caps.syncToTreg('cust_scale')).toBe(true);
    expect(puts).toEqual([['cust_scale', expect.objectContaining({ monthly_cap_micro: 20_000_000, daily_cap_micro: 2_000_000 })]]);
    expect(await caps.syncToTreg('cust_other')).toBe(true);
    expect(puts.at(-1)).toEqual(['delete']);
  });

  it('the plans give Grow’s budget to a Grow account, nothing to the owner, and nothing while not enforced', async () => {
    const h = await billingServer({ webhook: true });
    try {
      const u = await h.user('treg@example.com');
      await h.subscribe(u, { tier: 'grow' });
      const tag = h.account(u).customer_tag;
      expect(await h.plans.tregCapsFor(tag)).toEqual({ monthly_cap_micro: 8_000_000, daily_cap_micro: 800_000 });
      expect(await h.routes.caps.effective(tag)).toMatchObject({ monthly_cap_micro: 8_000_000 });
      const owner = await h.user('owner@example.com', { admin: true });
      await h.call(owner, 'GET', '/api/billing/plan');
      expect(await h.plans.tregCapsFor(h.account(owner).customer_tag)).toBe(null);
      h.supa.tables.get('billing_settings')[0].enforce = false;
      h.plans.store.invalidate();
      expect(await h.plans.tregCapsFor(tag)).toBe(null);
    } finally {
      await h.close();
    }
  });
});

describe('paused plans: paid actions refused, the rest never gated', () => {
  it('requireActive refuses analytics, posting, connecting and publishing on a paused plan, and passes when not enforced or for the owner', async () => {
    const h = await billingServer();
    try {
      const u = await h.user('paused@example.com');
      const sub = await h.subscribe(u);
      await expect(h.plans.requireActive({ id: u.id }, 'analytics')).resolves.toMatchObject({ active: true });
      await fetch(`${h.stripe.base}/__subscriptions/status`, { method: 'POST', body: JSON.stringify({ id: sub.id, status: 'unpaid' }) });
      h.plans.forget(u.id);
      for (const feature of ['analytics', 'posting', 'connect', 'publish']) await expect(h.plans.requireActive({ id: u.id }, feature)).rejects.toMatchObject({ status: 402, code: 'PAYMENT_REQUIRED', extra: { need: { feature } } });
      const none = await h.user('none@example.com');
      await expect(h.plans.requireActive({ id: none.id }, 'posting')).rejects.toMatchObject({ status: 402, code: 'PLAN_REQUIRED' });
      await expect(h.plans.requireActive({ id: none.id, isAdmin: true }, 'posting')).resolves.toMatchObject({ plan: 'owner' });
      // reads, Plan and the portal stay open on a paused plan
      expect((await h.call(u, 'GET', '/api/billing/plan')).status).toBe(200);
      expect((await h.call(u, 'GET', '/api/billing/businesses')).status).toBe(200);
      expect((await h.call(u, 'POST', '/api/billing/portal', { clientRequestId: crypto.randomUUID() })).status).toBe(200);
      h.supa.tables.get('billing_settings')[0].enforce = false;
      h.plans.store.invalidate();
      h.plans.forget(u.id);
      await expect(h.plans.requireActive({ id: u.id }, 'posting')).resolves.toMatchObject({ plan: 'legacy' });
      // pages after the plan ends: until ended_at + 30 days
      h.supa.tables.get('billing_settings')[0].enforce = true;
      h.plans.store.invalidate();
      h.plans.forget(u.id);
      await fetch(`${h.stripe.base}/__subscriptions/status`, { method: 'POST', body: JSON.stringify({ id: sub.id, status: 'canceled' }) });
      const until = await h.plans.pagesServeUntil(u.id);
      expect(Date.parse(until) - Date.parse(h.account(u).ended_at)).toBe(30 * DAY);
      expect(await h.plans.businessLimit(u.id)).toBe(0);
    } finally {
      await h.close();
    }
  });
});
