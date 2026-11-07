// Morning action (P4): one "action for today" per business, on its Dashboard by about 5 am in the business's own
// time zone. docs/integrations-setup.md §13; spec in the P4 plan.
//
//   GET  /api/morning/today?projectId=&timeZone=          → today's state (reads and records the visit; never generates)
//        { actionDay, timeZone, action | null, dueNow, late, nextAt, attemptsLeft, plan: 'active' | 'paused', planCode? }
//   POST /api/morning/today { projectId, timeZone?, mode: 'visit' | 'manual' }  → { action }
//        the first Dashboard visit after 05:00 (visit) and "Get today's action" (manual): P1's 402s when the plan is
//        paused, 409 NOT_DUE in the late window (02:00–05:00), one action per business per day, 6 generation starts an
//        hour per user. A visit never re-runs a failed day; only manual does, up to 3 attempts.
//   POST /api/morning/actions/<id>/feedback { verdict: 'done' | 'undo' | 'not_useful', reason?, note? } → { action }
//   GET  /api/morning/owner                                → { alert, last, powered, perTick, concurrency } (owner only)
//
// Every route: same site, signed in, errors as { error, code } in our words (the owner also gets a hint naming the
// migration), the business owned by the user (someone else's answers 404). The hourly `morning-actions` job and the
// daily `morning-prune` job are in server/morning/tick.mjs. Tables: supabase/migrations/20261116000000_morning_action.sql.
// Env: MORNING_ACTIONS (off), MORNING_PER_TICK (24), MORNING_CONCURRENCY (6). Nothing here posts, sends or buys.

import { createKit, fromDbError } from '../analytics/http.mjs';
import { errorBody, fail, notSetUp, safeLog, stubRoutes } from '../integrations/common.mjs';
import { ROUTE_PREFIXES, RATE_BUCKETS } from '../integrations/contracts.mjs';
import { actionDayOf, isLate, nextMorningAt, zoneOf } from '../localTime.mjs';
import { HOUR_MS, MORNING, MORNING_MIGRATION, PROJECT_ID_RE, UUID_RE, iso, morningSettings } from './config.mjs';
import { ALERT_KEY, LAST_KEY, createAlerts } from './alerts.mjs';
import { createMorningStore, attemptsLeft, isStale } from './store.mjs';
import { makeAction } from './generate.mjs';
import { createMorningJobs } from './tick.mjs';
import { clip } from './facts.mjs';

const REASONS = MORNING.reasons.map((r) => r.id);

/** What the app sees of a row (camelCase; never the provider, model or cost in dollars). */
export function describeAction(r) {
  if (!r) return null;
  const cost = Number(r.cost_usd) || 0;
  return {
    id: r.id,
    projectId: r.project_id,
    localDate: r.local_date,
    timeZone: r.time_zone,
    state: r.state,
    source: r.source,
    engine: r.engine ?? null,
    chosen: Number.isInteger(r.chosen) ? r.chosen : null,
    candidates: (Array.isArray(r.candidates) ? r.candidates : []).map((c) => ({ key: c.key, kind: c.kind, title: c.title, why: c.why, ...(c.steps ? { steps: c.steps } : {}), target: c.target ?? {}, from: c.from })),
    feedback: Array.isArray(r.feedback) ? r.feedback : [],
    fallback: r.fallback ?? null,
    // whole AI credits on the app's keys (1 credit = $0.01); own keys use none
    credits: !r.own_key && cost > 0 ? Math.max(1, Math.ceil(Math.round(cost * 100 * 1e6) / 1e6)) : null,
    ownKey: !!r.own_key,
    attempts: Number(r.attempts) || 1,
    errorCode: r.error_code ?? null,
    generatedAt: r.generated_at ?? null,
    doneAt: r.done_at ?? null,
  };
}

/**
 * deps: the integration modules' own (server/integrations/wiring.mjs): auth, db, storage (app_state), send, readJson,
 * limit, rateLimited, corsHeaders, sameOrigin, env, now, log, billing; aiText(who, fn, prompt, opts) (the AI routes'
 * generateText; null: rules only); aiPowered() (some ready key powers Morning action).
 */
export function createMorning(deps) {
  const { auth, db, storage = null, send, readJson, limit = () => false, rateLimited = () => false, corsHeaders = () => ({}), sameOrigin = () => true, env = process.env, now = () => Date.now(), log = console, billing = null, aiText = null, aiPowered = () => false } = deps;
  const settings = morningSettings(env);
  const enabled = !settings.off && !!db?.enabled && !!auth?.enabled;
  const config = () => ({ enabled });
  const notes = () => {
    if (settings.off) return ['Morning action: off (MORNING_ACTIONS=off).'];
    if (!enabled) return ['Morning action: off (it needs accounts and SUPABASE_URL and SUPABASE_SECRET_KEY).'];
    const lines = [`Morning action: on (needs ${MORNING_MIGRATION}); up to ${settings.perTick} businesses per hourly tick, ${settings.concurrency} at a time.`];
    if (!aiPowered()) lines.push('No AI key powers Morning action: actions are built from each business’s plan (tick Morning action on a low-cost key in Settings › AI keys).');
    return lines;
  };
  if (!enabled) {
    const stub = stubRoutes({ prefixes: [ROUTE_PREFIXES.morning], send, corsHeaders, message: 'The morning action isn’t set up on this app yet.' });
    return { ...stub, enabled: false, config, notes, cronJobs: () => [] };
  }

  const store = createMorningStore({ db });
  const alerts = createAlerts({ storage, now, log });
  const gen = { store, db, aiText, alerts, log };
  const jobs = createMorningJobs({ ...gen, billing, storage, settings, now, log });
  const kit = createKit({ auth, send, readJson, sameOrigin, corsHeaders, rateLimited, limit });
  const reply = (req, res, status, body) => send(res, status, body, { ...corsHeaders(req), 'cache-control': 'no-store' });

  const dbError = (e) => {
    if (e?.name === 'DbError' && e.code === 'NOT_SET_UP') {
      safeLog('morning_not_set_up', { hint: `run ${MORNING_MIGRATION}` }, log);
      return notSetUp(`Run ${MORNING_MIGRATION} in Supabase → SQL Editor.`);
    }
    return fromDbError(e);
  };
  const answerError = (req, res, e, who) => {
    const { status, body } = errorBody(dbError(e), who);
    if (!res.headersSent) reply(req, res, status, body);
  };

  const projectOf = (v) => {
    if (typeof v !== 'string' || !PROJECT_ID_RE.test(v)) throw fail(404, 'NOT_FOUND', 'That business isn’t in your account.');
    return v;
  };
  /** The saved business (404 when it isn't the user's): its zone and whether it's set up. */
  async function business(userId, projectId) {
    const [doc] = await db.select('user_docs', { user_id: userId, kind: 'project', id: projectId }, { select: 'id,tz:data->>timeZone,onboarded:data->>onboarded', limit: 1 });
    if (!doc) throw fail(404, 'NOT_FOUND', 'That business isn’t in your account.');
    return { timeZone: doc.tz ?? null, onboarded: doc.onboarded === 'true' };
  }

  /** P1's checks: null when the plan is active for this business, else the 402 error. */
  async function planCheck(who, projectId) {
    try {
      await billing?.requireActive?.(who, 'morning');
      await billing?.requireSlot?.(who, projectId);
      return null;
    } catch (e) {
      if (e?.status === 402) return e;
      throw fail(503, 'UNAVAILABLE', 'Couldn’t check your plan just now. Try again in a minute.');
    }
  }

  /** Read (and make) the business's settings row, recording the visit at most once an hour and a changed zone. */
  async function touch(userId, projectId, tz, t) {
    const s = await store.settings(userId, projectId);
    if (!s) return store.ensureSettings(userId, projectId, { timeZone: tz, nextAt: nextMorningAt(t, tz), now: t });
    const patch = {};
    if (t - Date.parse(s.last_active_at) >= HOUR_MS) patch.last_active_at = iso(t);
    if (s.time_zone !== tz || !s.next_action_at) {
      patch.time_zone = tz;
      patch.next_action_at = iso(nextMorningAt(t, tz));
    }
    if (!Object.keys(patch).length) return s;
    const [out] = await store.patchSettings(userId, projectId, patch);
    return out ?? s;
  }

  /** The day's row, with a `generating` row past the stale limit marked failed on read. */
  async function dayRow(userId, projectId, day, t) {
    const row = await store.day(userId, projectId, day);
    if (row && isStale(row, t)) {
      await store.sweep(t, { id: row.id, user_id: userId });
      return store.day(userId, projectId, day);
    }
    return row;
  }

  async function getToday(req, res, url, who) {
    if (kit.limited(req, res, { bucket: RATE_BUCKETS.morningRead }, who.id)) return;
    const projectId = projectOf(url.searchParams.get('projectId'));
    const biz = await business(who.id, projectId);
    const t = now();
    const s0 = await store.settings(who.id, projectId);
    const tz = zoneOf(biz.timeZone, url.searchParams.get('timeZone'), s0?.time_zone);
    await touch(who.id, projectId, tz, t);
    const day = actionDayOf(t, tz);
    const row = await dayRow(who.id, projectId, day, t);
    const late = isLate(t, tz);
    const paused = await planCheck(who, projectId);
    return reply(req, res, 200, {
      actionDay: day,
      timeZone: tz,
      action: describeAction(row),
      dueNow: !row && !late && biz.onboarded && !paused,
      late,
      nextAt: iso(nextMorningAt(t, tz)),
      attemptsLeft: attemptsLeft(row),
      plan: paused ? 'paused' : 'active',
      ...(paused ? { planCode: paused.code } : {}),
    });
  }

  async function postToday(req, res, who) {
    if (kit.limited(req, res, { bucket: RATE_BUCKETS.morningRead }, who.id)) return;
    const b = await kit.body(req);
    const projectId = projectOf(b.projectId);
    const mode = b.mode === 'manual' ? 'manual' : b.mode === 'visit' ? 'visit' : null;
    if (!mode) throw fail(400, 'BAD_REQUEST', 'Say how this started: visit or manual.');
    const biz = await business(who.id, projectId);
    const paused = await planCheck(who, projectId);
    if (paused) throw paused;
    const t = now();
    const s0 = await store.settings(who.id, projectId);
    const tz = zoneOf(biz.timeZone, typeof b.timeZone === 'string' ? b.timeZone : null, s0?.time_zone);
    await touch(who.id, projectId, tz, t);
    if (isLate(t, tz)) throw fail(409, 'NOT_DUE', 'Your next action comes at 5:00 AM.', { nextAt: iso(nextMorningAt(t, tz)) });
    if (!biz.onboarded) throw fail(409, 'NOT_DUE', 'Finish setting up this business first.', { nextAt: iso(nextMorningAt(t, tz)) });
    const day = actionDayOf(t, tz);
    const row = await dayRow(who.id, projectId, day, t);
    const tooMany = () => fail(429, 'RATE_LIMITED', 'Try again in a few minutes.');
    const metered = { id: who.id, email: who.email || '', isAdmin: who.isAdmin === true };
    if (!row) {
      if (limit(RATE_BUCKETS.morningGenerate, who.id)) throw tooMany();
      const mine = await store.begin({ userId: who.id, projectId, localDate: day, timeZone: tz, source: mode, now: t });
      // another tab or the tick made it at the same moment: one action
      if (!mine) return reply(req, res, 200, { action: describeAction(await store.day(who.id, projectId, day)) });
      await store.patchSettings(who.id, projectId, { next_action_at: iso(nextMorningAt(t, tz)), time_zone: tz }).catch(() => {});
      // a started paid call finishes and is recorded even if the browser goes away
      const done = await makeAction(gen, { who: metered, row: mine, now });
      return reply(req, res, 200, { action: describeAction(done) });
    }
    if (row.state === 'failed' && mode === 'manual') {
      if (attemptsLeft(row) <= 0) throw fail(429, 'RATE_LIMITED', 'Try again tomorrow.', { nextAt: iso(nextMorningAt(t, tz)) });
      if (limit(RATE_BUCKETS.morningGenerate, who.id)) throw tooMany();
      const again = await store.retry(row, t);
      if (!again) return reply(req, res, 200, { action: describeAction(await store.byId(who.id, row.id)) });
      const done = await makeAction(gen, { who: metered, row: again, now });
      return reply(req, res, 200, { action: describeAction(done) });
    }
    // a visit never re-runs anything; any other state is answered as it is
    return reply(req, res, 200, { action: describeAction(row) });
  }

  async function feedback(req, res, who, id) {
    if (kit.limited(req, res, { bucket: RATE_BUCKETS.morningFeedback }, who.id)) return;
    if (!UUID_RE.test(id)) throw fail(404, 'NOT_FOUND', 'That action isn’t in your account.');
    const b = await kit.body(req);
    const row = await store.byId(who.id, id);
    if (!row) throw fail(404, 'NOT_FOUND', 'That action isn’t in your account.');
    const t = now();
    const verdict = b.verdict;
    let patch;
    if (verdict === 'done') {
      if (row.state === 'done') return reply(req, res, 200, { action: describeAction(row) });
      if (row.state !== 'ready') throw fail(400, 'BAD_REQUEST', 'This action can’t be marked done now.');
      patch = { state: 'done', done_at: iso(t) };
    } else if (verdict === 'undo') {
      if (row.state === 'ready') return reply(req, res, 200, { action: describeAction(row) });
      if (row.state !== 'done' || row.local_date !== actionDayOf(t, row.time_zone)) throw fail(400, 'BAD_REQUEST', 'Only today’s done action can be undone.');
      patch = { state: 'ready', done_at: null };
    } else if (verdict === 'not_useful') {
      if (row.state !== 'ready') throw fail(400, 'BAD_REQUEST', 'This action can’t be marked now.');
      if (b.reason !== undefined && b.reason !== null && !REASONS.includes(b.reason)) throw fail(400, 'BAD_REQUEST', 'Unknown reason.');
      let note;
      if (b.note !== undefined && b.note !== null) {
        if (typeof b.note !== 'string') throw fail(400, 'BAD_REQUEST', 'The note must be text.');
        note = clip(b.note, MORNING.limits.note + 1);
        if (Array.from(note).length > MORNING.limits.note) throw fail(400, 'BAD_REQUEST', `The note can be at most ${MORNING.limits.note} characters.`);
      }
      const fb = Array.isArray(row.feedback) ? row.feedback : [];
      const entry = { i: row.chosen, ...(b.reason ? { reason: b.reason } : {}), ...(note ? { note } : {}), at: iso(t) };
      const marked = new Set([...fb.map((f) => f.i), row.chosen]);
      const n = Array.isArray(row.candidates) ? row.candidates.length : 0;
      let next = null;
      for (let i = 0; i < n; i++) if (!marked.has(i)) {
        next = i;
        break;
      }
      patch = next == null ? { feedback: [...fb, entry].slice(0, 3), state: 'dismissed' } : { feedback: [...fb, entry].slice(0, 3), chosen: next };
    } else throw fail(400, 'BAD_REQUEST', 'Unknown verdict.');
    const out = await store.swap(row, patch);
    // a lost race (a double click): the row as it is now
    return reply(req, res, 200, { action: describeAction(out ?? (await store.byId(who.id, id))) });
  }

  async function owner(req, res, who) {
    if (!who.isAdmin) throw fail(403, 'FORBIDDEN', 'Only the app’s owner can see this.');
    const read = async (key) => {
      try {
        return (await storage?.get?.(key))?.value ?? null;
      } catch {
        return null;
      }
    };
    const [alert, last] = await Promise.all([read(ALERT_KEY), read(LAST_KEY)]);
    return reply(req, res, 200, { alert, last, powered: !!aiPowered(), perTick: settings.perTick, concurrency: settings.concurrency });
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith(ROUTE_PREFIXES.morning)) return false;
    const who = await kit.user(req, res);
    if (!who) {
      req.resume?.();
      return true;
    }
    try {
      const rest = p.slice(ROUTE_PREFIXES.morning.length);
      if (rest === 'today' && req.method === 'GET') { await getToday(req, res, url, who); return true; }
      if (rest === 'today' && req.method === 'POST') { await postToday(req, res, who); return true; }
      if (rest === 'owner' && req.method === 'GET') { await owner(req, res, who); return true; }
      const fb = /^actions\/([^/]+)\/feedback$/.exec(rest);
      if (fb && req.method === 'POST') { await feedback(req, res, who, fb[1]); return true; }
      reply(req, res, 404, { error: 'Not found.', code: 'NOT_FOUND' });
    } catch (e) {
      if (!(e?.name === 'IntegrationError' || e?.name === 'DbError')) safeLog('morning_route_failed', { error: e?.name || 'Error', code: e?.code }, log);
      answerError(req, res, e, who);
    }
    return true;
  }

  return {
    enabled: true,
    handle,
    config,
    notes,
    /** for tests */
    store,
    jobs,
    cronJobs: () => [
      { name: 'morning-actions', everyMs: HOUR_MS, minMs: 25_000, run: (ctx) => jobs.run(ctx) },
      { name: 'morning-prune', dailyAtUtc: '05:23', run: (ctx) => jobs.prune(ctx) },
    ],
  };
}
