// The morning routes (server/morning/index.mjs): GET today (reads and records the visit, never generates), POST today
// (the first visit and "Get today's action": gating, the late window, one per day, the generation bucket, manual
// retries only), feedback (Done, Undo, Not useful), the owner's section, and the fallbacks customers see.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, morningServer } from './test-helpers.mjs';
import { utcDay } from '../limits.mjs';
import { ALERT_KEY } from './alerts.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let app;
beforeEach(async () => {
  app = await morningServer();
});
afterEach(() => app.close());

const today = (who, id, tz) => app.call(who, 'GET', `/api/morning/today?projectId=${id}${tz ? `&timeZone=${encodeURIComponent(tz)}` : ''}`);
const start = (who, id, mode = 'visit') => app.call(who, 'POST', '/api/morning/today', { projectId: id, mode });
const fb = (who, id, body) => app.call(who, 'POST', `/api/morning/actions/${id}/feedback`, body);

describe('GET /api/morning/today', () => {
  it('makes the settings row on the first visit, records visits at most once an hour, and never generates', async () => {
    const who = await app.user('get@r.test');
    await app.business(who, 'proj_get', { settings: false });
    const r = await today(who, 'proj_get');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ actionDay: '2026-11-07', timeZone: 'America/Los_Angeles', action: null, dueNow: true, late: false, nextAt: '2026-11-08T13:00:00.000Z', attemptsLeft: 3, plan: 'active' });
    const s = app.settingsOf('proj_get');
    expect(s).toMatchObject({ next_action_at: '2026-11-08T13:00:00.000Z', last_active_at: new Date(BASE).toISOString() });
    app.advance(30 * 60_000);
    await today(who, 'proj_get');
    expect(app.settingsOf('proj_get').last_active_at).toBe(new Date(BASE).toISOString());
    app.advance(31 * 60_000);
    await today(who, 'proj_get');
    expect(app.settingsOf('proj_get').last_active_at).toBe(new Date(BASE + 61 * 60_000).toISOString());
    expect(app.actions('proj_get')).toEqual([]);
    expect(app.aiCalls).toHaveLength(0);
  });

  it('a changed zone is stored and next_action_at recomputed; the saved business’s zone wins over the hint', async () => {
    const who = await app.user('zone@r.test');
    await app.business(who, 'proj_zone', { settings: false });
    await today(who, 'proj_zone', 'Asia/Kolkata');
    expect(app.settingsOf('proj_zone').time_zone).toBe('America/Los_Angeles');
    const doc = app.rows('user_docs').find((d) => d.id === 'proj_zone');
    doc.data.timeZone = 'Asia/Kolkata';
    const r = await today(who, 'proj_zone');
    expect(r.body).toMatchObject({ timeZone: 'Asia/Kolkata', actionDay: '2026-11-07', nextAt: '2026-11-07T23:30:00.000Z' });
    expect(app.settingsOf('proj_zone')).toMatchObject({ time_zone: 'Asia/Kolkata', next_action_at: '2026-11-07T23:30:00.000Z' });
  });

  it('another user’s business is 404; the plan paused shows as paused with P1’s code; signed out is 401', async () => {
    const a = await app.user('a@r.test');
    const b = await app.user('b@r.test');
    await app.business(a, 'proj_a');
    expect((await today(b, 'proj_a')).status).toBe(404);
    expect((await start(b, 'proj_a')).status).toBe(404);
    expect((await today(null, 'proj_a')).status).toBe(401);
    app.billing.state.enforce = true;
    app.billing.state.accounts.set(a.id, { source: 'stripe', tier: 'launch', interval: 'month', status: 'unpaid', business_limit: 1 });
    expect((await today(a, 'proj_a')).body).toMatchObject({ plan: 'paused', planCode: 'PAYMENT_REQUIRED', dueNow: false });
  });
});

describe('POST /api/morning/today', () => {
  it('a visit makes the action (source visit) and moves next_action_at on, so the tick skips it', async () => {
    const who = await app.user('visit@r.test');
    await app.business(who, 'proj_v');
    const r = await start(who, 'proj_v');
    expect(r.status).toBe(200);
    expect(r.body.action).toMatchObject({ state: 'ready', engine: 'ai', source: 'visit', chosen: 0, ownKey: false });
    expect(r.body.action.credits).toBeGreaterThanOrEqual(1);
    expect(r.body.action).not.toHaveProperty('provider');
    expect(r.body.action).not.toHaveProperty('model');
    expect(app.settingsOf('proj_v').next_action_at).toBe('2026-11-08T13:00:00.000Z');
    expect(await app.tick()).toMatchObject({ claimed: 0 });
    // the GET now carries it
    expect((await today(who, 'proj_v')).body).toMatchObject({ dueNow: false, action: { id: r.body.action.id } });
    expect(app.aiCalls).toHaveLength(1);
  });

  it('two parallel visits make one action; a visit after the tick made it starts nothing', async () => {
    const who = await app.user('par@r.test');
    await app.business(who, 'proj_par');
    const [x, y] = await Promise.all([start(who, 'proj_par'), start(who, 'proj_par')]);
    expect(x.body.action.id).toBe(y.body.action.id);
    expect(app.actions('proj_par')).toHaveLength(1);
    expect(app.aiCalls).toHaveLength(1);
    await app.business(who, 'proj_tick');
    await app.tick();
    const n = app.aiCalls.length;
    expect((await start(who, 'proj_tick')).body.action).toMatchObject({ source: 'cron', state: 'ready' });
    expect(app.aiCalls.length).toBe(n);
  });

  it('402s from P1 before anything; 409 NOT_DUE in the late window; 400 for a bad mode', async () => {
    const who = await app.user('gate@r.test');
    await app.business(who, 'proj_gate');
    app.billing.state.enforce = true;
    expect((await start(who, 'proj_gate')).body).toMatchObject({ code: 'PLAN_REQUIRED' });
    app.billing.state.accounts.set(who.id, { source: 'stripe', tier: 'launch', interval: 'month', status: 'active', business_limit: 1, current_period_start: new Date(BASE - 5 * DAY).toISOString(), current_period_end: new Date(BASE + 25 * DAY).toISOString() });
    app.supa.tables.set('project_slots', [{ user_id: who.id, project_id: 'proj_gate', state: 'locked' }]);
    const locked = await start(who, 'proj_gate');
    expect(locked.status).toBe(402);
    expect(locked.body.code).toBe('BUSINESS_LIMIT');
    app.supa.tables.set('project_slots', []);
    expect(app.actions('proj_gate')).toEqual([]);
    expect((await app.call(who, 'POST', '/api/morning/today', { projectId: 'proj_gate', mode: 'auto' })).status).toBe(400);
    app.at('2026-11-08', 3, 0);
    const late = await start(who, 'proj_gate');
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: 'NOT_DUE', nextAt: '2026-11-08T13:00:00.000Z' });
    expect((await today(who, 'proj_gate')).body).toMatchObject({ late: true, dueNow: false });
    expect(app.aiCalls).toHaveLength(0);
  });

  it('the 7th generation start in an hour is 429; reads and existing rows don’t count', async () => {
    const who = await app.user('rate@r.test');
    for (let i = 0; i < 7; i++) await app.business(who, `proj_q${i}`);
    for (let i = 0; i < 6; i++) expect((await start(who, `proj_q${i}`)).status).toBe(200);
    // an existing row answers as it is, without counting
    expect((await start(who, 'proj_q0')).status).toBe(200);
    expect((await today(who, 'proj_q6')).status).toBe(200);
    const seventh = await start(who, 'proj_q6');
    expect(seventh.status).toBe(429);
    expect(seventh.body.code).toBe('RATE_LIMITED');
    expect(app.actions('proj_q6')).toEqual([]);
    app.advance(HOUR + 1000);
    expect((await start(who, 'proj_q6')).status).toBe(200);
  });

  it('no auto-retry: a visit never re-runs a failed day; manual does, up to 3 attempts, then 429', async () => {
    const who = await app.user('manual@r.test');
    await app.business(who, 'proj_m');
    const failReads = () => {
      app.supa.behavior.fail = (method, p) => (method === 'GET' && p.endsWith('/offers') ? { status: 500, body: {} } : null);
    };
    failReads();
    const first = await start(who, 'proj_m');
    expect(first.body.action).toMatchObject({ state: 'failed', errorCode: 'UNAVAILABLE', attempts: 1 });
    expect((await start(who, 'proj_m', 'visit')).body.action).toMatchObject({ state: 'failed', attempts: 1 });
    expect((await today(who, 'proj_m')).body).toMatchObject({ attemptsLeft: 2, dueNow: false });
    expect((await start(who, 'proj_m', 'manual')).body.action).toMatchObject({ state: 'failed', attempts: 2, source: 'manual' });
    expect((await start(who, 'proj_m', 'manual')).body.action).toMatchObject({ state: 'failed', attempts: 3 });
    expect((await today(who, 'proj_m')).body.attemptsLeft).toBe(0);
    const fourth = await start(who, 'proj_m', 'manual');
    expect(fourth.status).toBe(429);
    expect(fourth.body).toMatchObject({ code: 'RATE_LIMITED', nextAt: '2026-11-08T13:00:00.000Z' });
    app.supa.behavior.fail = null;
    expect(app.aiCalls).toHaveLength(0);
    // a manual retry after the trouble passed makes it
    await app.business(who, 'proj_m2');
    failReads();
    await start(who, 'proj_m2');
    app.supa.behavior.fail = null;
    expect((await start(who, 'proj_m2', 'manual')).body.action).toMatchObject({ state: 'ready', attempts: 2 });
  });

  it('a stale generating row is marked failed on read (INTERRUPTED) and a visit leaves it', async () => {
    const who = await app.user('stale@r.test');
    await app.business(who, 'proj_s');
    await app.morning.store.begin({ userId: who.id, projectId: 'proj_s', localDate: '2026-11-07', timeZone: 'America/Los_Angeles', source: 'cron', now: BASE - 11 * 60_000 });
    expect((await today(who, 'proj_s')).body.action).toMatchObject({ state: 'failed', errorCode: 'INTERRUPTED' });
    expect((await start(who, 'proj_s')).body.action).toMatchObject({ state: 'failed' });
    expect(app.aiCalls).toHaveLength(0);
  });
});

describe('fallbacks customers see', () => {
  it('own key failing → own_key; credits and the daily limit → rules with no provider request; refusal → refused', async () => {
    const who = await app.user('fb@r.test');
    // their own OpenAI key, refused by OpenAI
    const { createUserKeys } = await import('../userKeys.mjs');
    await createUserKeys({ supabaseUrl: app.supa.url, secretKey: app.supa.SECRET }).set(who.id, 'openai', 'o-own-key-morning-01');
    app.providers.behavior.openai = 'auth';
    await app.business(who, 'proj_own');
    const own = (await start(who, 'proj_own')).body.action;
    expect(own).toMatchObject({ state: 'ready', engine: 'rules', fallback: 'own_key' });
    expect(app.logs.some((l) => l.includes('morning_owner_alert'))).toBe(false);
    expect(JSON.stringify(own)).not.toMatch(/Incorrect API key|sk-abc/);
    app.providers.reset();

    const limited = await app.user('limit@r.test');
    app.ai.store.setLimits({ requestsPerDay: 1, usdPerDay: 0 });
    app.supa.tables.get('ai_usage_daily').push({ user_id: limited.id, day: utcDay(), email: '', requests: 1, usd: 0.01, own_requests: 0, own_usd: 0 });
    await app.business(limited, 'proj_lim');
    const calls = app.textCalls().length;
    expect((await start(limited, 'proj_lim')).body.action).toMatchObject({ engine: 'rules', fallback: 'daily_limit' });
    app.ai.store.setLimits({ requestsPerDay: 0, usdPerDay: 0 });

    app.billing.state.enforce = true;
    const spent = await app.user('spent@r.test');
    app.billing.state.accounts.set(spent.id, { source: 'stripe', tier: 'launch', interval: 'month', status: 'active', business_limit: 1, current_period_start: new Date(BASE - 5 * DAY).toISOString(), current_period_end: new Date(BASE + 25 * DAY).toISOString() });
    app.supa.tables.get('ai_usage_daily').push({ user_id: spent.id, day: utcDay(BASE - DAY), email: '', requests: 1, usd: 500, own_requests: 0, own_usd: 0 });
    await app.business(spent, 'proj_spent');
    expect((await start(spent, 'proj_spent')).body.action).toMatchObject({ engine: 'rules', fallback: 'credits' });
    expect(app.textCalls().length).toBe(calls);
    app.billing.state.enforce = false;

    app.providers.behavior.xai = 'policy';
    const refused = await app.user('policy@r.test');
    await app.business(refused, 'proj_pol');
    expect((await start(refused, 'proj_pol')).body.action).toMatchObject({ engine: 'rules', fallback: 'refused' });
  });

  it('the owner’s key out of credits: rules, an owner alert in app_state and the log, nothing of it on the customer’s side', async () => {
    const who = await app.user('cred@r.test');
    await app.business(who, 'proj_cred');
    app.providers.behavior.xai = 'credits';
    app.providers.behavior.openai = 'credits';
    const r = await start(who, 'proj_cred');
    expect(r.body.action).toMatchObject({ engine: 'rules', fallback: 'no_ai' });
    expect(JSON.stringify(r.body)).not.toMatch(/Insufficient|credits\b.*xAI|xai/i);
    expect((await app.storage.get(ALERT_KEY)).value).toMatchObject({ kind: 'ai_credits' });
    const line = app.logs.find((l) => l.includes('morning_owner_alert'));
    expect(line).toContain('ai_credits');
    expect(line).not.toContain(who.id);
  });
});

describe('feedback', () => {
  it('done → done with done_at; undo → ready; not useful → the next idea, then dismissed', async () => {
    const who = await app.user('feed@r.test');
    await app.business(who, 'proj_f');
    const a = (await start(who, 'proj_f')).body.action;
    const d = await fb(who, a.id, { verdict: 'done' });
    expect(d.body.action).toMatchObject({ state: 'done', doneAt: new Date(BASE).toISOString() });
    expect((await fb(who, a.id, { verdict: 'undo' })).body.action).toMatchObject({ state: 'ready', doneAt: null });
    const n1 = await fb(who, a.id, { verdict: 'not_useful', reason: 'no_time', note: 'Busy\u0007 today' });
    expect(n1.body.action).toMatchObject({ state: 'ready', chosen: 1, feedback: [{ i: 0, reason: 'no_time', note: 'Busy today' }] });
    expect((await fb(who, a.id, { verdict: 'not_useful' })).body.action).toMatchObject({ state: 'ready', chosen: 2 });
    const n3 = await fb(who, a.id, { verdict: 'not_useful', reason: 'other' });
    expect(n3.body.action).toMatchObject({ state: 'dismissed' });
    expect(n3.body.action.feedback).toHaveLength(3);
    expect((await fb(who, a.id, { verdict: 'done' })).status).toBe(400);
  });

  it('a double click records one entry; bad reason, long note, unknown verdict → 400; someone else’s → 404', async () => {
    const who = await app.user('dbl@r.test');
    const other = await app.user('other@r.test');
    await app.business(who, 'proj_d');
    const a = (await start(who, 'proj_d')).body.action;
    const [x, y] = await Promise.all([fb(who, a.id, { verdict: 'not_useful' }), fb(who, a.id, { verdict: 'not_useful' })]);
    expect(x.status).toBe(200);
    expect(y.status).toBe(200);
    expect(app.actions('proj_d')[0].feedback).toHaveLength(1);
    expect((await fb(who, a.id, { verdict: 'not_useful', reason: 'boring' })).status).toBe(400);
    expect((await fb(who, a.id, { verdict: 'not_useful', note: 'x'.repeat(201) })).status).toBe(400);
    expect((await fb(who, a.id, { verdict: 'love_it' })).status).toBe(400);
    expect((await fb(other, a.id, { verdict: 'done' })).status).toBe(404);
    expect((await fb(who, 'not-a-uuid', { verdict: 'done' })).status).toBe(404);
  });

  it('Not useful keys never come back for 30 days; a recent one goes last', async () => {
    const who = await app.user('later@r.test');
    await app.business(who, 'proj_l');
    const a = (await start(who, 'proj_l')).body.action;
    const firstKey = a.candidates[0].key;
    await fb(who, a.id, { verdict: 'not_useful', reason: 'doesnt_fit' });
    app.at('2026-11-08', 6, 0);
    const b = (await start(who, 'proj_l')).body.action;
    expect(b.localDate).toBe('2026-11-08');
    expect(b.candidates.map((c) => c.key)).not.toContain(firstKey);
    // the one shown yesterday after the Not useful (index 1) is now last if it comes back at all
    const shown = a.candidates[1].key;
    const keys = b.candidates.map((c) => c.key);
    if (keys.includes(shown)) expect(keys.indexOf(shown)).toBe(keys.length - 1);
  });
});

describe('GET /api/morning/owner', () => {
  it('owner only: the last run, the alerts, whether a key powers it, the settings', async () => {
    const owner = await app.user('owner@r.test', { admin: true });
    const who = await app.user('cust@r.test');
    expect((await app.call(who, 'GET', '/api/morning/owner')).status).toBe(403);
    await app.business(who, 'proj_o');
    await app.tick();
    const r = await app.call(owner, 'GET', '/api/morning/owner');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ last: { claimed: 1, ai: 1 }, alert: null, powered: true, perTick: 24, concurrency: 6 });
  });
});
