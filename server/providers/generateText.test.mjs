// The router's two opt-in settings (effortCap, strictFallback) and generateText: writing for the server itself from
// the same gate as POST /api/ai/generate (own keys first, plan, daily limit, month's credits, usage recorded).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from '../auth.mjs';
import { createUserKeys } from '../userKeys.mjs';
import { createLimits, utcDay } from '../limits.mjs';
import { createAIRoutes } from './routes.mjs';
import { effortUnder } from './router.mjs';
import { createMockSupabase } from '../test/mock-supabase.mjs';
import { createMockProviders, reasoningFor } from '../test/mock-providers.mjs';
import { entitlementOf } from '../billing/entitlement.mjs';

const DAY = 86_400_000;
const OWN = 'o-own-key-gentext-0001';
let supa;
let providers;
let ai;
let limits;
let userKeys;
const accounts = new Map();
let enforce = false;

beforeAll(async () => {
  supa = await (await createMockSupabase()).start();
  providers = await createMockProviders({ keys: { openai: ['o-key-owner-1', OWN], xai: 'x-key-owner-1' } }).start();
  const auth = createAuth({ supabaseUrl: supa.url, publishableKey: supa.PUBLISHABLE, adminEmails: 'owner@gt.test' });
  limits = createLimits({ supabaseUrl: supa.url, secretKey: supa.SECRET });
  userKeys = createUserKeys({ supabaseUrl: supa.url, secretKey: supa.SECRET });
  ai = createAIRoutes({ send: () => {}, readJson: async () => ({}), corsHeaders: () => ({}), rateLimited: () => false, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-gentext-')), env: { OPENAI_API_KEY: 'o-key-owner-1', XAI_API_KEY: 'x-key-owner-1' }, baseUrls: providers.baseUrls(), auth, userKeys, limits });
  ai.setBilling({ entitlement: async (id, who) => entitlementOf(accounts.get(id) ?? null, { enforce }, Date.now(), { isAdmin: who?.isAdmin === true }), config: () => ({ enabled: true, enforce }) });
});
afterAll(async () => {
  await supa.close();
  await providers.close();
});
beforeEach(() => {
  providers.reset();
  enforce = false;
  ai.store.setLimits?.({ requestsPerDay: 0, usdPerDay: 0 });
});

const user = async (email) => ({ id: (await supa.tokenFor(email)).user.id, email, isAdmin: false });
const usage = (id) => (supa.tables.get('ai_usage_daily') ?? []).find((r) => r.user_id === id && r.day === utcDay()) ?? null;
const textCalls = () => providers.calls.filter((c) => /chat\/completions|responses/.test(c.path));

describe('effortUnder', () => {
  it('the highest accepted effort not above the cap, else the lowest; other scales left alone', () => {
    expect(effortUnder(['minimal', 'low', 'medium', 'high'], 'high', 'low')).toBe('low');
    expect(effortUnder(['low', 'high'], 'high', 'low')).toBe('low');
    expect(effortUnder(['medium', 'high'], 'high', 'low')).toBe('medium');
    expect(effortUnder(['minimal', 'low', 'medium'], 'minimal', 'low')).toBe('minimal');
    expect(effortUnder([], 'medium', 'low')).toBe('medium');
    expect(effortUnder(['480p', '720p'], '720p', 'low')).toBe('720p');
    expect(effortUnder(['low', 'medium'], 'medium', null)).toBe('medium');
  });
});

describe('generateText', () => {
  it('runs at effort low on the quick tier and is metered like /api/ai/generate', async () => {
    const who = await user('meter@gt.test');
    const out = await ai.generateText(who, 'research', 'ideas please', { tier: 'quick', effortCap: 'low', strictFallback: true });
    expect(out.own).toBe(false);
    expect(out.meta.effort).toBe('low');
    expect(out.meta.usage.reasoning).toBe(reasoningFor('low'));
    const row = usage(who.id);
    expect(row).toMatchObject({ requests: 1 });
    expect(Number(row.usd)).toBeGreaterThan(0);
  });

  it('own keys first: counted on the own counters, never the app’s', async () => {
    const who = await user('own@gt.test');
    await userKeys.set(who.id, 'openai', OWN);
    const out = await ai.generateText(who, 'research', 'ideas please', { effortCap: 'low' });
    expect(out.own).toBe(true);
    expect(out.meta.ownKey).toBe(true);
    expect(usage(who.id)).toMatchObject({ requests: 0, own_requests: 1 });
  });

  it('the owner is never metered', async () => {
    const owner = { id: (await supa.tokenFor('owner@gt.test')).user.id, email: 'owner@gt.test', isAdmin: true };
    await ai.generateText(owner, 'research', 'ideas', {});
    expect(usage(owner.id)).toBeNull();
  });

  it('refuses with DAILY_LIMIT, PLAN_REQUIRED and CREDITS_USED before any provider call', async () => {
    const who = await user('limit@gt.test');
    ai.store.setLimits({ requestsPerDay: 1, usdPerDay: 0 });
    await ai.generateText(who, 'research', 'one', {});
    const n = textCalls().length;
    await expect(ai.generateText(who, 'research', 'two', {})).rejects.toMatchObject({ code: 'DAILY_LIMIT', status: 429 });
    ai.store.setLimits({ requestsPerDay: 0, usdPerDay: 0 });
    enforce = true;
    const ended = await user('ended@gt.test');
    accounts.set(ended.id, { source: 'stripe', tier: 'none', status: 'canceled', ended_at: new Date(Date.now() - DAY).toISOString() });
    await expect(ai.generateText(ended, 'research', 'x', {})).rejects.toMatchObject({ code: 'PLAN_REQUIRED', status: 402 });
    const unpaid = await user('unpaid@gt.test');
    accounts.set(unpaid.id, { source: 'stripe', tier: 'launch', interval: 'month', status: 'unpaid', business_limit: 1 });
    await expect(ai.generateText(unpaid, 'research', 'x', {})).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    const spent = await user('spent@gt.test');
    accounts.set(spent.id, { source: 'stripe', tier: 'launch', interval: 'month', status: 'active', business_limit: 1, current_period_start: new Date(Date.now() - 5 * DAY).toISOString(), current_period_end: new Date(Date.now() + 25 * DAY).toISOString() });
    supa.tables.get('ai_usage_daily').push({ user_id: spent.id, day: utcDay(Date.now() - DAY), email: '', requests: 1, usd: 500, own_requests: 0, own_usd: 0 });
    await expect(ai.generateText(spent, 'research', 'x', {})).rejects.toMatchObject({ code: 'CREDITS_USED', status: 402 });
    expect(textCalls().length).toBe(n);
  });

  it('strictFallback: a 500 on the first key never moves to the second (it may have billed); a 401 does', async () => {
    const who = await user('strict@gt.test');
    providers.behavior.xai = 'fail500';
    await expect(ai.generateText(who, 'research', 'x', { strictFallback: true })).rejects.toMatchObject({ code: 'UPSTREAM' });
    expect(providers.calls.some((c) => c.provider === 'openai')).toBe(false);
    // without it (every other caller), the next key answers
    providers.reset();
    providers.behavior.xai = 'fail500';
    const loose = await ai.generateText(who, 'research', 'x', {});
    expect(loose.meta.provider).toBe('openai');
    providers.reset();
    providers.behavior.xai = 'auth';
    const out = await ai.generateText(who, 'research', 'x', { strictFallback: true });
    expect(out.meta.provider).toBe('openai');
    expect(out.meta.attempts?.[0]).toMatchObject({ provider: 'xai', code: 'AUTH' });
  });
});
