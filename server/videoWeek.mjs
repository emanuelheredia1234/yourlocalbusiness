// Weekly AI video limits per business (shared/plans.json videosPerWeek: Launch 3, Grow 5, Scale unlimited).
//
// A business's week runs Monday 00:00 to Sunday 23:59 in its time zone (the saved business's Project.timeZone, read
// by the server; else the zone the app sent; else UTC). While a limit applies the business must be one of the
// account's (it holds a project_slots row): business() reads both. A video counts when the server starts it: claim() before the provider is asked, then
// settle(id, 'started') once it accepted the job, or settle(id, 'refunded') when it certainly never started (the
// provider refused before any paid work). A claim never settled (the server stopped in between) keeps counting: when
// in doubt the video counts, so nothing is ever started twice on one claim.
// The claim's id is made here and sent with it, so a claim written but whose answer was lost (a timeout) can still be
// refunded when the video is then refused.
//
// With Supabase's secret key the claims live in public.video_starts and ylb_claim_video_start checks and inserts under
// a per-user, per-week advisory lock, so two parallel starts (on any copy of the server) can't both pass at the limit.
// Without it, or before the migration was run (reported as `problem`), they're kept in this server's memory, where the
// check and the insert happen in one synchronous step.
//
// Own-key videos are recorded with own: true and never counted or refused (own keys never use credits either).

import crypto from 'node:crypto';
import { serviceHeaders } from './secretBox.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
export const VIDEO_WEEK_MIGRATION = 'supabase/migrations/20261111000000_video_week.sql';

/** Whether Intl knows this IANA time zone. */
export function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** The first valid time zone of the candidates (the business's, then the browser's), else 'UTC'. */
export const zoneOf = (...candidates) => candidates.find(validTimeZone) ?? 'UTC';

const partsFmt = new Map();
/** The wall-clock date and time of `t` in `tz`, as numbers. */
function wall(t, tz) {
  let f = partsFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    partsFmt.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(t))) o[p.type] = p.value;
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), h: Number(o.hour), mi: Number(o.minute), s: Number(o.second), wd: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(o.weekday) };
}

/** How far `tz` is ahead of UTC at `t`, in ms. */
function offsetAt(t, tz) {
  const w = wall(t, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000;
}

/** The UTC time of a local date's midnight in `tz` (after a daylight-saving gap at midnight: the first time that exists). */
function midnightUtc(ymd, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz);
  return t;
}

const ymdOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The week `now` falls in for a business in `tz`: { weekStart: the Monday (YYYY-MM-DD, local), resetsAt: the next
 * Monday 00:00 local as an ISO time, timeZone }.
 */
export function weekOf(now = Date.now(), tz = 'UTC') {
  const zone = zoneOf(tz);
  const w = wall(now, zone);
  const today = Date.UTC(w.y, w.m - 1, w.d);
  const monday = today - w.wd * DAY_MS;
  const weekStart = ymdOf(monday);
  return { weekStart, resetsAt: new Date(midnightUtc(ymdOf(monday + 7 * DAY_MS), zone)).toISOString(), timeZone: zone };
}

export function videoWeekFromEnv(env = process.env, fetchImpl = globalThis.fetch) {
  return createVideoWeek({ supabaseUrl: env.SUPABASE_URL || '', secretKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '', fetch: fetchImpl });
}

export function createVideoWeek({ supabaseUrl = '', secretKey = '', fetch = globalThis.fetch } = {}) {
  const url = String(supabaseUrl).replace(/\/+$/, '');
  const enabled = !!(url && secretKey);
  const headers = enabled ? serviceHeaders(secretKey) : {};
  const memory = []; // { id, user_id, project_id, week_start, state, own_key, job_id }
  let problem = null;

  const upstream = (what, status) =>
    status === 404
      ? Object.assign(new Error(`The weekly video counts aren’t set up in Supabase yet (Supabase ${status}). Run ${VIDEO_WEEK_MIGRATION} in Supabase → SQL Editor; until then they’re kept in this server’s memory only.`), { code: 'NOT_SET_UP' })
      : Object.assign(new Error(`Couldn’t ${what} the weekly video counts (Supabase ${status}).`), { code: 'UPSTREAM' });
  const note = (e) => {
    problem = { code: e?.code || 'UNREACHABLE', message: e?.code === 'NOT_SET_UP' || e?.code === 'UPSTREAM' ? e.message : `Couldn’t reach Supabase for the weekly video counts (${e?.message || 'no answer'}).` };
    console.warn(`Video limits: ${problem.message}`);
  };
  const remote = (userId) => enabled && UUID.test(userId);

  const counted = (r, userId, weekStart) => r.user_id === userId && r.week_start === weekStart && r.state !== 'refunded' && !r.own_key;

  function claimMemory({ id, userId, projectId, weekStart, limit, userLimit, own }) {
    const mine = memory.filter((r) => counted(r, userId, weekStart));
    const usedProject = mine.filter((r) => r.project_id === projectId).length;
    if (!own) {
      if (limit != null && usedProject >= limit) return { ok: false, used: usedProject, limit, reason: 'business' };
      // the account's total refused it: its count and limit, so the app's line matches the refusal
      if (userLimit != null && mine.length >= userLimit) return { ok: false, used: mine.length, limit: userLimit, reason: 'account' };
    }
    memory.push({ id, user_id: userId, project_id: projectId, week_start: weekStart, state: 'pending', own_key: !!own, job_id: null });
    // memory is a stand-in only: keep about five weeks
    if (memory.length > 5000) {
      const cutoff = ymdOf(Date.now() - 35 * DAY_MS);
      for (let i = memory.length - 1; i >= 0; i--) if (memory[i].week_start < cutoff) memory.splice(i, 1);
    }
    return { ok: true, id, used: usedProject + (own ? 0 : 1), limit };
  }

  return {
    enabled,
    /** 'supabase', or 'memory' (also while `problem` says the migration wasn't run). */
    get storage() {
      return enabled && problem?.code !== 'NOT_SET_UP' ? 'supabase' : 'memory';
    },
    get problem() {
      return problem;
    },

    /**
     * Claim one video start for a business's week. limit: the business's weekly limit (null = none: counted, never
     * refused); userLimit: the account's weekly total (null = none); own: an own-key video (recorded, never counted).
     * → { ok, id, used, limit, reason? } (reason 'account': used and limit are the account's). Throws
     * { code: 'UNAVAILABLE', id } when Supabase can't be reached: the claim's id is made here, so a claim that was
     * written but whose answer was lost can still be settled (the caller refunds it when it refuses, and settles it as
     * usual when it goes ahead).
     */
    async claim({ userId, projectId = '', weekStart, limit = null, userLimit = null, own = false }) {
      const id = crypto.randomUUID();
      const a = { id, userId, projectId: String(projectId ?? ''), weekStart, limit: limit == null ? null : Math.max(0, Math.trunc(limit)), userLimit: userLimit == null ? null : Math.max(0, Math.trunc(userLimit)), own: !!own };
      if (!remote(userId)) return claimMemory(a);
      try {
        const res = await fetch(`${url}/rest/v1/rpc/ylb_claim_video_start`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ p_id: a.id, p_user: a.userId, p_project: a.projectId, p_week: a.weekStart, p_limit: a.limit, p_user_limit: a.userLimit, p_own: a.own }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw upstream('update', res.status);
        problem = null;
        const out = await res.json();
        return { ok: out?.ok === true, id: out?.ok === true ? (out?.id ?? id) : null, used: Number(out?.used) || 0, limit: out?.limit ?? a.limit, ...(out?.reason ? { reason: out.reason } : {}) };
      } catch (e) {
        note(e);
        if (e?.code === 'NOT_SET_UP') return claimMemory(a);
        throw Object.assign(new Error(problem.message), { code: 'UNAVAILABLE', id });
      }
    },

    /** The provider accepted the job ('started', with its id) or certainly never started it ('refunded'). Never throws. */
    async settle(id, state, { jobId = null } = {}) {
      if (!id || !['started', 'refunded'].includes(state)) return;
      const m = memory.find((r) => r.id === id);
      if (m) {
        m.state = state;
        if (jobId) m.job_id = jobId;
        return;
      }
      if (!enabled) return;
      try {
        const res = await fetch(`${url}/rest/v1/video_starts?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { ...headers, prefer: 'return=minimal' },
          body: JSON.stringify({ state, ...(jobId ? { job_id: String(jobId).slice(0, 100) } : {}), updated_at: new Date().toISOString() }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw upstream('update', res.status);
      } catch (e) {
        // a refund that didn't reach Supabase leaves the video counted (never the other way round)
        note(e);
      }
    },

    /**
     * A business's counted videos this week, and the account's: { used, usedUser, known } (known: false when Supabase
     * couldn't be read).
     */
    async usage({ userId, projectId = '', weekStart }) {
      const proj = String(projectId ?? '');
      const mem = () => {
        const mine = memory.filter((r) => counted(r, userId, weekStart));
        return { used: mine.filter((r) => r.project_id === proj).length, usedUser: mine.length };
      };
      if (!remote(userId)) return { ...mem(), known: true };
      try {
        const q = `user_id=eq.${encodeURIComponent(userId)}&week_start=eq.${weekStart}&state=in.(pending,started)&own_key=eq.false&select=project_id&limit=5000`;
        const res = await fetch(`${url}/rest/v1/video_starts?${q}`, { headers, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw upstream('read', res.status);
        problem = null;
        const rows = await res.json();
        return { used: rows.filter((r) => r.project_id === proj).length, usedUser: rows.length, known: true };
      } catch (e) {
        note(e);
        return { ...mem(), known: e?.code === 'NOT_SET_UP' };
      }
    },

    /**
     * The business as the account has it: { checked, slot: 'active' | 'locked' | null, timeZone: string | null }.
     * slot: its project_slots row (every business has one; a made-up id has none); timeZone: the saved business's
     * (user_docs), when it has a valid one. checked: false without Supabase (nothing to check against). Throws
     * { code: 'UNAVAILABLE' } when Supabase can't be read.
     */
    async business({ userId, projectId = '' }) {
      const proj = String(projectId ?? '');
      if (!remote(userId) || !proj) return { checked: false, slot: null, timeZone: null };
      const get = async (path) => {
        const res = await fetch(`${url}/rest/v1/${path}`, { headers, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw upstream('read', res.status);
        return res.json();
      };
      try {
        const u = encodeURIComponent(userId);
        const p = encodeURIComponent(proj);
        const [slots, docs] = await Promise.all([get(`project_slots?user_id=eq.${u}&project_id=eq.${p}&select=state&limit=1`), get(`user_docs?user_id=eq.${u}&kind=eq.project&id=eq.${p}&select=tz:data->>timeZone&limit=1`)]);
        const tz = docs?.[0]?.tz;
        return { checked: true, slot: slots?.[0]?.state === 'locked' ? 'locked' : slots?.[0] ? 'active' : null, timeZone: validTimeZone(tz) ? tz : null };
      } catch (e) {
        console.warn(`Video limits: couldn’t read the business (${e?.message || 'no answer'}).`);
        throw Object.assign(new Error('Couldn’t check the business right now.'), { code: 'UNAVAILABLE' });
      }
    },
  };
}
