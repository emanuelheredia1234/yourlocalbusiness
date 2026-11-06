// Periodic work, driven from outside. Replit Autoscale scales to zero, so a setInterval in the server only runs
// while someone happens to be using the app. Instead, Supabase's pg_cron calls POST /api/cron/tick every hour
// (supabase/migrations/20261109000000_cron_tick.sql) and each tick runs the jobs that are due.
//
//   const cron = createCron({ env, storage: appState, now, log });
//   cron.register({ name: 'treg-settle', everyMs: 5 * 60_000, run: (ctx) => … });
//   cron.register({ name: 'uploadpost-reconcile', dailyAtUtc: '03:00', run: (ctx) => … });
//   cron.match(url) / cron.handle(req, res, url)     POST /api/cron/tick, "Authorization: Bearer <CRON_SECRET>"
//   cron.tick()                                       run what is due now (the route and the local loop call it)
//   cron.startLocal()                                 local dev only: tick in-process every minute
//
// Rules:
// - A job runs at most once per period (everyMs: the window floor(now / everyMs); dailyAtUtc: the UTC day of the
//   latest HH:MM at or before now). The run is claimed first in app_state: one document per job (`cron:<name>`,
//   holding the period it last claimed), written with ifVersion (null when it doesn't exist yet: the same pattern
//   as Upload-Post's once-a-day reconcile), so two ticks, two copies of the server or a retry by pg_net never run it
//   twice, and app_state doesn't grow. A failed run is recorded on its claim and is NOT retried in the same period:
//   the next period runs it again.
// - A tick has a time budget (CRON_BUDGET_MS, 40 s by default) so it answers well before platform timeouts. A job
//   is not started when less than its `minMs` (5 s by default) is left; it stays unclaimed for the next tick. A job
//   still running when the budget is spent is reported as `running` and finishes in the background; its claim
//   stays, so nothing starts it again in this period. ctx.deadline (ms) and ctx.signal let a job stop early.
// - Without app_state (no SUPABASE_SECRET_KEY) the claims are kept in memory: enough for one dev server.
// - The secret is compared in constant time and never logged. No CRON_SECRET → 503 NOT_SET_UP.
// - Where the driver is: with CRON_SECRET, or on a Replit deployment (REPLIT_DEPLOYMENT), only the tick runs jobs.
//   Otherwise (local dev) startLocal() ticks in-process every minute, with the same claims.

import crypto from 'node:crypto';

export const TICK_PATH = '/api/cron/tick';
export const DEFAULT_BUDGET_MS = 40_000;
export const DEFAULT_MIN_MS = 5_000;
const LOCAL_EVERY_MS = 60_000;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

const has = (env, name) => String(env?.[name] ?? '').trim() !== '';
const iso = (t) => new Date(t).toISOString();

/** 'tick' (only POST /api/cron/tick runs jobs) or 'local' (dev: an in-process loop also ticks). */
export function cronMode(env = process.env) {
  if (has(env, 'CRON_SECRET') || has(env, 'REPLIT_DEPLOYMENT')) return 'tick';
  return 'local';
}

/** Constant-time check of "Bearer <secret>" (digests, so the lengths don't leak either). */
export function bearerMatches(header, secret) {
  if (!secret) return false;
  const m = /^Bearer\s+(.+)$/i.exec(String(header ?? '').trim());
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1].trim()).digest();
  const b = crypto.createHash('sha256').update(String(secret)).digest();
  return crypto.timingSafeEqual(a, b);
}

/** The period a job is in at `now`: { id, startsAt } or null when a daily job has never been due (never). */
export function periodOf(job, now) {
  if (job.everyMs) {
    const n = Math.floor(now / job.everyMs);
    return { id: `e${n}`, startsAt: n * job.everyMs };
  }
  const [, hh, mm] = HHMM.exec(job.dailyAtUtc);
  const offset = (Number(hh) * 60 + Number(mm)) * 60_000;
  // the latest HH:MM at or before now
  const startsAt = Math.floor((now - offset) / DAY_MS) * DAY_MS + offset;
  return { id: `d${iso(startsAt).slice(0, 10)}`, startsAt };
}

function checkJob(job) {
  if (!job || typeof job !== 'object') throw new TypeError('cron job: expected an object');
  if (!NAME_RE.test(String(job.name ?? ''))) throw new TypeError(`cron job: bad name ${JSON.stringify(job.name)}`);
  if (typeof job.run !== 'function') throw new TypeError(`cron job ${job.name}: run(ctx) is required`);
  const every = job.everyMs !== undefined;
  const daily = job.dailyAtUtc !== undefined;
  if (every === daily) throw new TypeError(`cron job ${job.name}: give everyMs or dailyAtUtc (one of them)`);
  if (every && !(Number.isInteger(job.everyMs) && job.everyMs >= 60_000)) throw new TypeError(`cron job ${job.name}: everyMs must be a whole number of ms, at least 60000`);
  if (daily && !HHMM.test(String(job.dailyAtUtc))) throw new TypeError(`cron job ${job.name}: dailyAtUtc must be "HH:MM" (UTC)`);
}

/** In-memory claims with app_state's put contract (ifVersion null: create only). */
function memoryClaims() {
  const docs = new Map();
  let v = 0;
  return {
    enabled: true,
    memory: true,
    async get(key) {
      return docs.get(key) ?? null;
    },
    async put(key, value, { ifVersion } = {}) {
      const cur = docs.get(key);
      if (ifVersion !== undefined && (cur?.updatedAt ?? null) !== ifVersion) throw Object.assign(new Error('Conflict'), { code: 'CONFLICT' });
      v += 1;
      const updatedAt = `m${v}`;
      docs.set(key, { value, updatedAt });
      return updatedAt;
    },
  };
}

/** What a failure is called in the summary and the claim: a code, never a message (it could carry a provider's words). */
const errorCode = (e) => String(e?.code || e?.name || 'Error').slice(0, 60);

/** A result small enough for the summary: plain numbers, booleans and short strings only. */
function brief(result) {
  if (!result || typeof result !== 'object') return typeof result === 'number' || typeof result === 'boolean' ? result : undefined;
  const out = {};
  for (const [k, v] of Object.entries(result).slice(0, 12)) {
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 40) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export function createCron({ env = process.env, storage = null, now = () => Date.now(), log = console, budgetMs, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const jobs = [];
  const claims = storage?.enabled ? storage : memoryClaims();
  const budget = Number(budgetMs ?? env.CRON_BUDGET_MS) > 0 ? Number(budgetMs ?? env.CRON_BUDGET_MS) : DEFAULT_BUDGET_MS;
  const background = new Set();
  let localTimer = null;
  let lastTick = null;

  const note = (event, fields = {}) => {
    try {
      log.info?.(JSON.stringify({ event, ...fields }));
    } catch {
      /* logging never breaks a tick */
    }
  };

  function register(job) {
    checkJob(job);
    if (jobs.some((j) => j.name === job.name)) throw new TypeError(`cron job ${job.name}: registered twice`);
    jobs.push({ minMs: DEFAULT_MIN_MS, ...job });
  }

  /** Record how a claimed run ended (best effort: the claim itself already stops a second run). */
  async function settle(key, version, value) {
    try {
      await claims.put(key, value, { ifVersion: version });
    } catch {
      /* the claim stays as `running`: still one run per period */
    }
  }

  async function runOne(job, tickStart, deadline) {
    const t = now();
    const period = periodOf(job, t);
    const key = `cron:${job.name}`;
    const base = { name: job.name, period: period.id };
    if (deadline - t < job.minMs) return { ...base, status: 'skipped', reason: 'budget' };
    let version;
    try {
      const existing = await claims.get(key);
      if (existing?.value?.period === period.id) return { ...base, status: 'skipped', reason: 'done', last: existing.value.state ?? 'running' };
      // compare-and-swap on the job's one document (ifVersion null: only if nobody created it yet)
      version = await claims.put(key, { period: period.id, state: 'running', at: iso(t) }, { ifVersion: existing?.updatedAt ?? null });
    } catch (e) {
      if (e?.code === 'CONFLICT') return { ...base, status: 'skipped', reason: 'claimed' };
      // can't claim: don't run (a run nobody can see could run twice)
      return { ...base, status: 'skipped', reason: 'no_claim', error: errorCode(e) };
    }
    const controller = new AbortController();
    const ctx = { now, deadline, signal: controller.signal, period: period.id, periodStartsAt: period.startsAt, tickStartedAt: tickStart, log };
    const started = now();
    const work = Promise.resolve()
      .then(() => job.run(ctx))
      .then(
        async (result) => {
          const ms = now() - started;
          await settle(key, version, { period: period.id, state: 'done', at: iso(started), ms });
          note('cron_job_done', { job: job.name, period: period.id, ms });
          return { ...base, status: 'ran', ms, ...(brief(result) !== undefined ? { result: brief(result) } : {}) };
        },
        async (e) => {
          const ms = now() - started;
          await settle(key, version, { period: period.id, state: 'failed', at: iso(started), ms, error: errorCode(e) });
          note('cron_job_failed', { job: job.name, period: period.id, ms, error: errorCode(e) });
          return { ...base, status: 'failed', ms, error: errorCode(e) };
        },
      );
    const left = Math.max(0, deadline - now());
    let timer;
    const outOfTime = new Promise((resolve) => {
      timer = setTimer(() => resolve(null), left);
    });
    const first = await Promise.race([work, outOfTime]);
    clearTimer(timer);
    if (first) return first;
    // over the budget: tell the job, answer now, let it finish (and record itself) in the background
    controller.abort();
    background.add(work);
    work.finally(() => background.delete(work));
    return { ...base, status: 'running', reason: 'budget' };
  }

  /** Run every job that is due, in the order registered, within the budget. → the summary. */
  async function tick({ source = 'tick' } = {}) {
    const startedAt = now();
    const deadline = startedAt + budget;
    const results = [];
    for (const job of jobs) results.push(await runOne(job, startedAt, deadline));
    const summary = {
      ok: true,
      at: iso(startedAt),
      budgetMs: budget,
      elapsedMs: now() - startedAt,
      ran: results.filter((r) => r.status === 'ran').length,
      failed: results.filter((r) => r.status === 'failed').length,
      jobs: results,
    };
    lastTick = { at: summary.at, source, ran: summary.ran, failed: summary.failed };
    // (the local loop's quiet minutes aren't logged)
    if (source !== 'local' || results.some((r) => r.status !== 'skipped')) note('cron_tick', { source, ran: summary.ran, failed: summary.failed, skipped: results.filter((r) => r.status === 'skipped').length, running: results.filter((r) => r.status === 'running').length, ms: summary.elapsedMs });
    return summary;
  }

  const secret = () => String(env.CRON_SECRET ?? '').trim();
  const match = (url) => url.pathname === TICK_PATH;

  /** POST /api/cron/tick. send(res, status, body) is the server's JSON helper. */
  async function handle(req, res, url, send) {
    if (!match(url)) return false;
    if (req.method !== 'POST') {
      send(res, 405, { error: 'Use POST.', code: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' });
      return true;
    }
    if (!secret()) {
      send(res, 503, { error: 'The cron tick isn’t set up: add the CRON_SECRET Secret.', code: 'NOT_SET_UP' });
      return true;
    }
    if (!bearerMatches(req.headers?.authorization, secret())) {
      note('cron_tick_refused', {});
      send(res, 401, { error: 'Not allowed.', code: 'AUTH_REQUIRED' });
      return true;
    }
    // the body (pg_net sends {}) is not read: nothing in it changes what runs
    req.resume?.();
    send(res, 200, await tick({ source: 'http' }));
    return true;
  }

  /** Local dev: tick now and every minute (unref'd), unless the tick is the driver. → whether it started. */
  function startLocal() {
    if (cronMode(env) !== 'local' || localTimer) return false;
    const loop = () => {
      tick({ source: 'local' }).catch(() => {});
    };
    loop();
    localTimer = setInterval(loop, LOCAL_EVERY_MS);
    localTimer.unref?.();
    return true;
  }

  function stopLocal() {
    if (localTimer) clearInterval(localTimer);
    localTimer = null;
  }

  /** Startup line: who drives the jobs (names only, never the secret). */
  function notes() {
    const names = jobs.map((j) => j.name).join(', ') || 'none';
    const mode = cronMode(env);
    if (mode === 'local') return [`Scheduled jobs (${names}): run in this process every minute (local dev; set CRON_SECRET to use POST ${TICK_PATH} instead).`];
    if (!secret()) return [`Scheduled jobs (${names}): NOT running. Add the CRON_SECRET Secret and the pg_cron schedule (docs/integrations-setup.md, "Scheduled jobs").`];
    return [`Scheduled jobs (${names}): run by POST ${TICK_PATH} (pg_cron, hourly)${claims.memory ? '; claims kept in memory (add SUPABASE_SECRET_KEY so copies of the server share them)' : ''}.`];
  }

  return {
    register,
    jobs: () => jobs.map((j) => ({ name: j.name, everyMs: j.everyMs, dailyAtUtc: j.dailyAtUtc })),
    tick,
    match,
    handle,
    startLocal,
    stopLocal,
    notes,
    mode: () => cronMode(env),
    lastTick: () => lastTick,
    /** tests: wait for runs that outlived their tick */
    async settled() {
      while (background.size) await Promise.all([...background]);
    },
  };
}
