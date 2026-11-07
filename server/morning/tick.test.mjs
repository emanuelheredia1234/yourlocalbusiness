// The hourly `morning-actions` job (server/morning/tick.mjs): claim races, the per-tick cap and the time budget, who
// is due, P1's gating, the late window, the stale sweep and no auto-retry, the backlog alert and the prune.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, LA, morningServer } from './test-helpers.mjs';
import { createCron } from '../cron/index.mjs';
import { ALERT_KEY, LAST_KEY } from './alerts.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let app;
beforeEach(async () => {
  app = await morningServer();
});
afterEach(() => app.close());

describe('the morning-actions job', () => {
  it('makes the action, moves next_action_at to the next 05:00 and releases the claim before the AI call', async () => {
    const who = await app.user('one@t.test');
    await app.business(who, 'proj_one');
    const out = await app.tick();
    expect(out).toMatchObject({ claimed: 1, ai: 1, rules: 0, failed: 0 });
    const [row] = app.actions('proj_one');
    expect(row).toMatchObject({ state: 'ready', engine: 'ai', source: 'cron', local_date: '2026-11-07', time_zone: LA, attempts: 1 });
    const s = app.settingsOf('proj_one');
    expect(s).toMatchObject({ next_action_at: '2026-11-08T13:00:00.000Z', claim_id: null, claimed_until: null, last_outcome: 'ready' });
    expect(app.aiCalls).toHaveLength(1);
    // the summary: app_state and one log line with counts only
    expect((await app.storage.get(LAST_KEY)).value).toMatchObject({ claimed: 1, ai: 1 });
    const line = app.logs.find((l) => l.includes('"morning_run"'));
    expect(line).toBeTruthy();
    expect(line).not.toContain(who.id);
    // a second run in the same hour finds nothing due: no AI call
    expect(await app.tick()).toMatchObject({ claimed: 0 });
    expect(app.aiCalls).toHaveLength(1);
  });

  it('the claim is released and next_action_at moved on before the AI is asked', async () => {
    await app.close();
    let seen = null;
    const holder = {};
    app = await morningServer({
      aiText: async () => {
        seen = { ...holder.app.settingsOf('proj_rel') };
        throw Object.assign(new Error('none'), { code: 'NO_PROVIDER' });
      },
    });
    holder.app = app;
    const who = await app.user('rel@t.test');
    await app.business(who, 'proj_rel');
    expect(await app.tick()).toMatchObject({ claimed: 1, rules: 1 });
    expect(seen).toMatchObject({ claim_id: null, claimed_until: null, next_action_at: '2026-11-08T13:00:00.000Z' });
    expect(app.actions('proj_rel')[0]).toMatchObject({ engine: 'rules', fallback: 'no_ai' });
    // no key powers it: no owner alert
    expect(app.logs.some((l) => l.includes('morning_owner_alert'))).toBe(false);
  });

  it('claim races: two runs at once handle each business once; two crons sharing claims run the job once an hour', async () => {
    const who = await app.user('race@t.test');
    for (let i = 0; i < 4; i++) await app.business(who, `proj_r${i}`);
    const [a, b] = await Promise.all([app.tick(), app.tick()]);
    expect(a.claimed + b.claimed).toBe(4);
    expect(app.actions().length).toBe(4);
    expect(app.aiCalls).toHaveLength(4);
    // the cron's own per-period claim
    const claims = new Map();
    const storage = { enabled: true, get: async (k) => claims.get(k) ?? null, put: async (k, v, { ifVersion } = {}) => {
      if (ifVersion !== undefined && (claims.get(k)?.updatedAt ?? null) !== ifVersion) throw Object.assign(new Error('c'), { code: 'CONFLICT' });
      const u = String(Math.random());
      claims.set(k, { value: v, updatedAt: u });
      return u;
    } };
    let runs = 0;
    const job = { name: 'morning-actions', everyMs: HOUR, minMs: 25_000, run: async () => {
      runs += 1;
    } };
    const c1 = createCron({ env: {}, storage, now: app.clock, log: { info() {} } });
    const c2 = createCron({ env: {}, storage, now: app.clock, log: { info() {} } });
    c1.register(job);
    c2.register(job);
    await Promise.all([c1.tick(), c2.tick()]);
    expect(runs).toBe(1);
  });

  it('a crash after claiming: after the lease the next run re-claims, finds the row, no second AI call; a lost claimer changes nothing', async () => {
    const who = await app.user('crash@t.test');
    await app.business(who, 'proj_crash');
    const [c] = await app.morning.store.claim(6, 600);
    // the crashed run had inserted the day's row and stopped before releasing
    await app.morning.store.begin({ userId: who.id, projectId: 'proj_crash', localDate: '2026-11-07', timeZone: LA, source: 'cron', now: app.clock() });
    // still leased: nothing to claim
    expect(await app.tick()).toMatchObject({ claimed: 0 });
    app.advance(11 * 60_000);
    const out = await app.tick();
    expect(out).toMatchObject({ claimed: 1, exists: 1, failed: 0, swept: 1 });
    // the stale `generating` row was swept to failed first, then the claim found it there
    expect(app.actions('proj_crash')[0]).toMatchObject({ state: 'failed', error_code: 'INTERRUPTED' });
    expect(app.aiCalls).toHaveLength(0);
    expect(app.settingsOf('proj_crash')).toMatchObject({ next_action_at: '2026-11-08T13:00:00.000Z', claim_id: null, last_outcome: 'exists' });
    // the lost claimer's claim id no longer matches: it can't advance or release the business
    expect(await app.morning.store.advance(who.id, 'proj_crash', c.claim_id, { next_action_at: new Date(BASE).toISOString() })).toBe(false);
    expect(app.settingsOf('proj_crash').next_action_at).toBe('2026-11-08T13:00:00.000Z');
  });

  it('per-tick cap: 30 due, cap 24 → 24 oldest first, 6 wait for the next hour; budget and stop end it early', async () => {
    await app.close();
    app = await morningServer({ perTick: 24, concurrency: 6, ai: false });
    const who = await app.user('cap@t.test');
    for (let i = 0; i < 30; i++) await app.business(who, `proj_c${String(i).padStart(2, '0')}`, { due: BASE - HOUR - i * 60_000 });
    const out = await app.tick();
    expect(out).toMatchObject({ claimed: 24, rules: 24 });
    const done = new Set(app.actions().map((r) => r.project_id));
    // oldest due first: the six most recently due wait
    for (let i = 0; i < 6; i++) expect(done.has(`proj_c${String(i).padStart(2, '0')}`)).toBe(false);
    app.advance(HOUR);
    expect(await app.tick()).toMatchObject({ claimed: 6 });
    // a short budget claims nothing new; an aborted run stops
    for (let i = 0; i < 3; i++) await app.business(who, `proj_b${i}`);
    expect(await app.tick({ deadline: app.clock() + 21_000 })).toMatchObject({ claimed: 0 });
    const stop = new AbortController();
    stop.abort();
    expect(await app.tick({ signal: stop.signal })).toMatchObject({ claimed: 0 });
    expect(await app.tick()).toMatchObject({ claimed: 3 });
  });

  it('the backlog alert: businesses still due 3 hours after their 05:00 when the run stopped on its cap', async () => {
    await app.close();
    app = await morningServer({ perTick: 2, concurrency: 2, ai: false });
    const who = await app.user('backlog@t.test');
    for (let i = 0; i < 5; i++) await app.business(who, `proj_k${i}`, { due: BASE - 4 * HOUR - i * 60_000 });
    const out = await app.tick();
    expect(out).toMatchObject({ claimed: 2, backlog: 3 });
    expect((await app.storage.get(ALERT_KEY)).value).toMatchObject({ kind: 'backlog', n: 3 });
    expect(app.logs.some((l) => l.includes('morning_owner_alert') && l.includes('backlog'))).toBe(true);
  });

  it('who is due: active in 14 days, next_action_at passed, onboarded, saved, slot not locked, on a plan', async () => {
    const who = await app.user('due@t.test');
    await app.business(who, 'proj_inactive', { active: BASE - 15 * DAY });
    await app.business(who, 'proj_future', { due: BASE + HOUR });
    await app.business(who, 'proj_setup', { onboarded: false });
    await app.business(who, 'proj_deleted');
    await app.db.remove('user_docs', { user_id: who.id, kind: 'project', id: 'proj_deleted' });
    expect(app.settingsOf('proj_deleted')).toBeNull();
    expect(await app.tick()).toMatchObject({ claimed: 0 });
    expect(app.aiCalls).toHaveLength(0);
  });

  it('gating with plans enforced: active, trialing, a free plan and the owner yes; no plan, ended, unpaid, late past due no', async () => {
    app.supa.tables.set('billing_settings', [{ id: 1, enforce: true }]);
    app.billing.state.enforce = true;
    const win = { current_period_start: new Date(BASE - 5 * DAY).toISOString(), current_period_end: new Date(BASE + 25 * DAY).toISOString() };
    const make = async (email, acct) => {
      const u = await app.user(email);
      await app.business(u, `proj_${email.split('@')[0]}`);
      if (acct) {
        app.billing.state.accounts.set(u.id, acct);
        app.supa.tables.set('billing_accounts', [...app.rows('billing_accounts'), { user_id: u.id, ...acct }]);
      }
      return u;
    };
    await make('active@g.test', { source: 'stripe', tier: 'launch', interval: 'month', status: 'active', business_limit: 1, ...win });
    await make('trial@g.test', { source: 'stripe', tier: 'launch', interval: 'month', status: 'trialing', business_limit: 1, trial_ends_at: new Date(BASE + 3 * DAY).toISOString(), ...win });
    await make('free@g.test', { source: 'comp', tier: 'grow', status: 'trialing', business_limit: 1, comp_until: new Date(BASE + 10 * DAY).toISOString() });
    await make('owner@g.test', { source: 'owner', tier: 'owner', status: 'active' });
    await make('none@g.test', null);
    await make('ended@g.test', { source: 'stripe', tier: 'none', status: 'canceled', ended_at: new Date(BASE - DAY).toISOString() });
    await make('unpaid@g.test', { source: 'stripe', tier: 'launch', interval: 'month', status: 'unpaid', business_limit: 1 });
    // past due: the SQL lets it through, P1's entitlement refuses it after the 7-day grace
    await make('pastdue@g.test', { source: 'stripe', tier: 'launch', interval: 'month', status: 'past_due', business_limit: 1, grace_until: new Date(BASE - DAY).toISOString() });
    const out = await app.tick();
    expect(out).toMatchObject({ claimed: 5, ai: 4, skipped: 1 });
    expect(new Set(app.actions().map((r) => r.project_id))).toEqual(new Set(['proj_active', 'proj_trial', 'proj_free', 'proj_owner']));
    expect(app.settingsOf('proj_pastdue')).toMatchObject({ last_outcome: 'skipped_plan', next_action_at: '2026-11-08T13:00:00.000Z', claim_id: null });
    // the owner isn't metered
    const owner = app.actions('proj_owner')[0];
    expect(app.rows('ai_usage_daily').some((r) => r.user_id === owner.user_id)).toBe(false);
  });

  it('a locked slot is skipped; a fresh business gets rules with no AI call; the late window waits for the coming 05:00', async () => {
    const who = await app.user('misc@t.test');
    await app.business(who, 'proj_locked');
    app.supa.tables.set('project_slots', [{ user_id: who.id, project_id: 'proj_locked', state: 'locked' }]);
    await app.business(who, 'proj_fresh', { strategy: false });
    expect(await app.tick()).toMatchObject({ claimed: 1, rules: 1 });
    expect(app.actions('proj_fresh')[0]).toMatchObject({ engine: 'rules', fallback: 'fresh' });
    expect(app.aiCalls).toHaveLength(0);
    expect(app.actions('proj_locked')).toEqual([]);
    // the late window: 03:30 local on Nov 8 → no action for Nov 7, next_action_at is 05:00 that morning
    app.at('2026-11-08', 3, 30);
    await app.business(who, 'proj_late', { due: app.clock() - HOUR });
    expect(await app.tick()).toMatchObject({ claimed: 1, late: 1 });
    expect(app.actions('proj_late')).toEqual([]);
    expect(app.settingsOf('proj_late')).toMatchObject({ last_outcome: 'skipped_late', next_action_at: '2026-11-08T13:00:00.000Z' });
  });

  it('a slot locked through P1 (requireSlot) with SQL not knowing: skipped_slot', async () => {
    const who = await app.user('slot@t.test');
    await app.business(who, 'proj_slot');
    const orig = app.billing.requireSlot;
    app.billing.requireSlot = async () => {
      throw Object.assign(new Error('locked'), { status: 402, code: 'BUSINESS_LIMIT' });
    };
    try {
      expect(await app.tick()).toMatchObject({ claimed: 1, skipped: 1 });
      expect(app.settingsOf('proj_slot')).toMatchObject({ last_outcome: 'skipped_slot', claim_id: null });
    } finally {
      app.billing.requireSlot = orig;
    }
  });

  it('a failed release after the row is in still makes the action; the next tick releases through `exists`', async () => {
    const who = await app.user('rel2@t.test');
    await app.business(who, 'proj_rel2');
    const orig = app.morning.store.advance;
    app.morning.store.advance = async () => {
      throw Object.assign(new Error('network'), { code: 'UNAVAILABLE' });
    };
    try {
      expect(await app.tick()).toMatchObject({ claimed: 1, ai: 1, failed: 0 });
    } finally {
      app.morning.store.advance = orig;
    }
    expect(app.actions('proj_rel2')[0]).toMatchObject({ state: 'ready', engine: 'ai' });
    expect(app.aiCalls).toHaveLength(1);
    expect(app.logs.some((l) => l.includes('morning_release_failed'))).toBe(true);
    // still claimed until the lease ends; then the row is found, the business released, no second AI call
    app.advance(11 * 60_000);
    expect(await app.tick()).toMatchObject({ claimed: 1, exists: 1 });
    expect(app.aiCalls).toHaveLength(1);
    expect(app.settingsOf('proj_rel2')).toMatchObject({ next_action_at: '2026-11-08T13:00:00.000Z', claim_id: null });
  });

  it('a billing read that fails skips nothing: no skipped_plan, the business is tried again after the lease', async () => {
    const who = await app.user('ent@t.test');
    await app.business(who, 'proj_ent');
    const orig = app.billing.entitlement;
    app.billing.entitlement = async () => {
      throw Object.assign(new Error('db'), { code: 'UNAVAILABLE' });
    };
    try {
      expect(await app.tick()).toMatchObject({ claimed: 1, failed: 1, skipped: 0 });
    } finally {
      app.billing.entitlement = orig;
    }
    expect(app.actions('proj_ent')).toEqual([]);
    expect(app.aiCalls).toHaveLength(0);
    expect(app.settingsOf('proj_ent').last_outcome).not.toBe('skipped_plan');
    expect(Date.parse(app.settingsOf('proj_ent').next_action_at)).toBeLessThan(app.clock());
    app.advance(HOUR);
    expect(await app.tick()).toMatchObject({ claimed: 1, ai: 1 });
    expect(app.actions('proj_ent')[0]).toMatchObject({ state: 'ready', local_date: '2026-11-07' });
  });

  it('no auto-retry: a failed day is left alone by every later run that day; the next day is made normally', async () => {
    const who = await app.user('retry@t.test');
    await app.business(who, 'proj_fail');
    app.supa.behavior.fail = (method, p) => (method === 'GET' && p.endsWith('/offers') ? { status: 500, body: {} } : null);
    expect(await app.tick()).toMatchObject({ claimed: 1, failed: 1 });
    app.supa.behavior.fail = null;
    expect(app.actions('proj_fail')[0]).toMatchObject({ state: 'failed', error_code: 'UNAVAILABLE' });
    for (let h = 1; h <= 5; h++) {
      app.advance(HOUR);
      expect(await app.tick()).toMatchObject({ claimed: 0 });
    }
    expect(app.actions('proj_fail')).toHaveLength(1);
    expect(app.aiCalls).toHaveLength(0);
    // the next morning
    app.at('2026-11-08', 5, 7);
    expect(await app.tick()).toMatchObject({ claimed: 1, ai: 1 });
    expect(app.actions('proj_fail').map((r) => [r.local_date, r.state])).toEqual([['2026-11-07', 'failed'], ['2026-11-08', 'ready']]);
  });

  it('half-hour and 45-minute zones and the date line get their own 05:00', async () => {
    const who = await app.user('zones@t.test');
    await app.business(who, 'proj_kat', { tz: 'Asia/Kathmandu', due: Date.parse('2026-11-07T23:15:00Z') });
    await app.business(who, 'proj_kir', { tz: 'Pacific/Kiritimati', due: Date.parse('2026-11-07T15:00:00Z') });
    app.set(Date.parse('2026-11-07T15:30:00Z'));
    expect(await app.tick()).toMatchObject({ claimed: 1 });
    expect(app.actions('proj_kir')[0].local_date).toBe('2026-11-08');
    expect(app.settingsOf('proj_kir').next_action_at).toBe('2026-11-08T15:00:00.000Z');
    app.set(Date.parse('2026-11-07T23:52:00Z'));
    expect(await app.tick()).toMatchObject({ claimed: 1 });
    expect(app.actions('proj_kat')[0].local_date).toBe('2026-11-08');
    expect(app.settingsOf('proj_kat').next_action_at).toBe('2026-11-08T23:15:00.000Z');
  });

  it('morning-prune deletes actions older than 120 days by local date', async () => {
    const who = await app.user('prune@t.test');
    for (const d of ['2026-07-01', '2026-07-10', '2026-11-01']) await app.db.insert('daily_actions', { user_id: who.id, project_id: 'proj_p', local_date: d, time_zone: LA, state: 'done', source: 'cron' });
    expect(await app.morning.jobs.prune()).toEqual({ deleted: 1 });
    expect(app.actions('proj_p').map((r) => r.local_date)).toEqual(['2026-07-10', '2026-11-01']);
  });
});
