// Test harness for the morning action (tests only): mock Supabase with a controllable clock, the real AI routes on
// mock providers (two owner keys: xai first, then openai), a billing stub (plans enforced or not, an account per
// user, locked slots from project_slots), app_state in memory, and the morning module behind a bare HTTP server with a
// signed-in user per header. Nothing leaves the machine.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { createMockProviders } from '../test/mock-providers.mjs';
import { createDb } from '../integrations/db.mjs';
import { createBucketLimiter, fail } from '../integrations/common.mjs';
import { readJson, sendJson } from '../billing/test-helpers.mjs';
import { createLimits } from '../limits.mjs';
import { createUserKeys } from '../userKeys.mjs';
import { createAIRoutes } from '../providers/routes.mjs';
import { entitlementOf } from '../billing/entitlement.mjs';
import { localToUtc } from '../localTime.mjs';
import { createMorning } from './index.mjs';

export const LA = 'America/Los_Angeles';
const DAY = 86_400_000;
/** Saturday 2026-11-07 07:07 in Los Angeles (15:07 UTC). */
export const BASE = Date.parse('2026-11-07T15:07:00Z');

/** app_state in memory, with app_state's put contract. */
export function memoryState() {
  const docs = new Map();
  let v = 0;
  return {
    enabled: true,
    docs,
    async get(key) {
      return docs.get(key) ?? null;
    },
    async put(key, value, { ifVersion } = {}) {
      const cur = docs.get(key);
      if (ifVersion !== undefined && (cur?.updatedAt ?? null) !== ifVersion) throw Object.assign(new Error('Conflict'), { code: 'CONFLICT' });
      v += 1;
      docs.set(key, { value, updatedAt: `m${v}` });
      return `m${v}`;
    },
  };
}

/** A plans facade like server/billing/stripe.mjs answers, over fixed accounts (P1's entitlementOf). */
export function stubBilling(supa, clock) {
  const state = { enforce: false, accounts: new Map(), calls: [] };
  const entitlement = async (userId, who = null) => {
    state.calls.push(['entitlement', userId]);
    return entitlementOf(state.accounts.get(userId) ?? null, { enforce: state.enforce }, clock(), { isAdmin: who?.isAdmin === true });
  };
  return {
    state,
    entitlement,
    async requireActive(who) {
      const ent = await entitlement(who.id, who);
      if (ent.active) return ent;
      throw ent.paused === 'payment' ? fail(402, 'PAYMENT_REQUIRED', 'Your last payment didn’t go through.', { upgrade: '#plans' }) : fail(402, 'PLAN_REQUIRED', 'This needs a plan.', { upgrade: '#plans' });
    },
    async requireSlot(who, projectId) {
      const ent = await entitlement(who.id, who);
      if (ent.plan === 'legacy' || ent.plan === 'owner') return;
      const locked = (supa.tables.get('project_slots') ?? []).some((r) => r.user_id === who.id && r.project_id === projectId && r.state === 'locked');
      if (locked) throw fail(402, 'BUSINESS_LIMIT', 'This business is paused on your plan.', { locked: true });
    },
    config: () => ({ enabled: true, enforce: state.enforce }),
  };
}

/** A Strategy with a week-1 plan: build a booking page (open) and write a post (open). */
export function strategyFixture(now, { notes = '', actions } = {}) {
  return {
    v: 1,
    inputs: { goal: 'More bookings this month', budget: '', timePerWeek: '', competitors: [], tried: '', notes },
    promote: { page: { pageType: 'booking' }, positioning: { line: 'Calm, friendly yoga for busy parents' }, channels: [{ name: 'Instagram' }] },
    plan: {
      startAt: now - 2 * DAY,
      summary: '',
      weeks: [{ week: 1, focus: 'Get found locally', goal: 'A page people can book from' }],
      actions: actions ?? [
        { id: 'a_build1', week: 1, title: 'Build your booking page', detail: '', kind: 'build_page', pageType: 'booking', basis: 'ai' },
        { id: 'a_post1', week: 1, title: 'Write a post about your opening hours', detail: '', kind: 'write_post', topic: 'Opening hours', basis: 'ai' },
      ],
      habits: [],
      measure: [],
    },
    ticks: {},
    applied: {},
    sources: [],
    nextSource: 1,
    useBrain: true,
    maxSearches: 5,
    updatedAt: now,
  };
}

export async function morningServer({ env: envOver = {}, perTick, concurrency, ai: withAi = true, aiText: aiTextOver } = {}) {
  let offset = 0;
  const clock = () => BASE + offset;
  const supa = await (await createMockSupabase()).start();
  supa.behavior.now = clock;
  const providers = await createMockProviders({ keys: { openai: ['o-key-owner-1', 'o-own-key-morning-01'], xai: 'x-key-owner-1' } }).start();
  const db = createDb({ supabaseUrl: supa.url, secretKey: supa.SECRET });
  const people = new Map();
  const logs = [];
  const log = { log: (line) => logs.push(String(line)), info: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)), error: (...a) => logs.push(a.map(String).join(' ')) };
  const auth = { enabled: true, signInRequired: true, identify: async (req) => people.get(String(req.headers['x-test-user'] ?? '')) ?? null };
  const billing = stubBilling(supa, clock);
  const limits = createLimits({ supabaseUrl: supa.url, secretKey: supa.SECRET });
  const userKeys = createUserKeys({ supabaseUrl: supa.url, secretKey: supa.SECRET });
  const ai = createAIRoutes({ send: () => {}, readJson: async () => ({}), corsHeaders: () => ({}), rateLimited: () => false, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-morning-')), env: { XAI_API_KEY: 'x-key-owner-1', OPENAI_API_KEY: 'o-key-owner-1' }, baseUrls: providers.baseUrls(), auth, userKeys, limits });
  ai.setBilling(billing);
  ai.store.setLimits?.({ requestsPerDay: 0, usdPerDay: 0 });
  const storage = memoryState();
  const aiCalls = [];
  const aiText = aiTextOver ?? (withAi ? async (...a) => {
    aiCalls.push(a);
    return ai.generateText(...a);
  } : null);
  const env = { ...(perTick ? { MORNING_PER_TICK: String(perTick) } : {}), ...(concurrency ? { MORNING_CONCURRENCY: String(concurrency) } : {}), ...envOver };
  const limiter = createBucketLimiter({ now: clock });
  const morning = createMorning({ auth, db, storage, send: sendJson, readJson, limit: limiter, env, now: clock, log, billing, aiText, aiPowered: () => ai.store.route('morning').length > 0 });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    morning.handle(req, res, url).then(
      (handled) => {
        if (handled === false && !res.headersSent) sendJson(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
      },
      (e) => {
        logs.push(`crash ${e?.stack ?? e}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'crash', code: 'UNAVAILABLE' });
      },
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function user(email, { admin = false } = {}) {
    const { user: u } = await supa.tokenFor(email);
    const key = crypto.randomUUID();
    people.set(key, { id: u.id, email, isAdmin: admin });
    return { id: u.id, email, key, isAdmin: admin };
  }

  /** A saved, onboarded business (its settings row made as a first visit would, due now unless said otherwise). */
  async function business(who, id, { tz = LA, onboarded = true, strategy = true, notes = '', brand = 'Calm Yoga Studio', posts = [], marketing = {}, settings = true, due = null, active = null } = {}) {
    const data = {
      id,
      name: brand,
      track: 'business',
      onboarded,
      timeZone: tz,
      niche: 'yoga classes',
      category: 'fitness',
      businessType: 'studio',
      location: { city: 'Portland', region: 'OR' },
      summary: 'Small yoga studio',
      brand: { name: brand, websiteUrl: '', socials: {} },
      studio: { packages: [], codeAssets: [], listing: {} },
      marketing: { salesPage: null, emails: [], leadMagnet: null, ...marketing },
      ...(strategy ? { strategy: strategyFixture(clock(), { notes }) } : {}),
    };
    await db.upsert('user_docs', { user_id: who.id, kind: 'project', id, data }, { onConflict: 'user_id,kind,id' });
    for (const p of posts) await db.upsert('user_docs', { user_id: who.id, kind: 'post', id: p.id, data: { projectId: id, status: 'scheduled', source: 'composer', headline: 'A post', ...p } }, { onConflict: 'user_id,kind,id' });
    if (settings) {
      await db.upsert('business_settings', { user_id: who.id, project_id: id, time_zone: tz, next_action_at: new Date(due ?? clock() - 2 * 3_600_000).toISOString(), last_active_at: new Date(active ?? clock() - 3_600_000).toISOString() }, { onConflict: 'user_id,project_id' });
    }
    return id;
  }

  async function call(who, method, p, body) {
    const res = await fetch(`${base}${p}`, { method, headers: { ...(who ? { 'x-test-user': who.key } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json, text };
  }

  const tick = (ctx = {}) => morning.jobs.run({ deadline: clock() + 40_000, signal: new AbortController().signal, ...ctx });

  return {
    base,
    supa,
    providers,
    db,
    ai,
    billing,
    storage,
    morning,
    logs,
    aiCalls,
    clock,
    set: (t) => {
      offset = t - BASE;
    },
    advance: (ms) => {
      offset += ms;
    },
    /** move the clock to a local wall time in a zone */
    at: (ymd, hh, mm, tz = LA) => {
      offset = localToUtc(ymd, hh, mm, tz) - BASE;
    },
    user,
    business,
    call,
    tick,
    rows: (table) => supa.tables.get(table) ?? [],
    actions: (projectId) => (supa.tables.get('daily_actions') ?? []).filter((r) => !projectId || r.project_id === projectId),
    settingsOf: (projectId) => (supa.tables.get('business_settings') ?? []).find((r) => r.project_id === projectId) ?? null,
    textCalls: () => providers.calls.filter((c) => /chat\/completions|responses|messages|interactions/.test(c.path)),
    async close() {
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      await providers.close();
      await supa.close();
    },
  };
}
