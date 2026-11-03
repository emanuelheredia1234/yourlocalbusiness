// Daily AI counters per signed-in user (UTC days), so the owner can cap how much of their keys
// each person uses: requests and dollars per day.
//
// With Supabase's secret key, counters live in public.ai_usage_daily (server-only: row-level
// security with no policies) and are bumped atomically by public.ylb_add_ai_usage, so several
// copies of the server share them and they survive restarts. Without it, they're kept in memory.
// Requests made with a user's own keys are counted apart (own_requests / own_usd) and never limit them.

import { serviceHeaders } from './secretBox.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Today's date in UTC, as YYYY-MM-DD. */
export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
/** When today's counters reset: the next midnight UTC. */
export const nextReset = (t = Date.now()) => {
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
};
const daysBack = (n, t = Date.now()) => Array.from({ length: n }, (_, i) => utcDay(t - i * 86_400_000));

const EMPTY = () => ({ requests: 0, usd: 0, ownRequests: 0, ownUsd: 0 });
const fromRow = (r) => ({ requests: num(r?.requests), usd: round6(r?.usd), ownRequests: num(r?.own_requests), ownUsd: round6(r?.own_usd) });

export function limitsFromEnv(env = process.env, fetchImpl = globalThis.fetch) {
  return createLimits({ supabaseUrl: env.SUPABASE_URL || '', secretKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '', fetch: fetchImpl });
}

export function createLimits({ supabaseUrl = '', secretKey = '', fetch = globalThis.fetch } = {}) {
  const url = String(supabaseUrl).replace(/\/+$/, '');
  const enabled = !!(url && secretKey);
  const headers = enabled ? serviceHeaders(secretKey) : {};
  // memory counters: used without Supabase, and as a stand-in while Supabase can't be reached
  const memory = new Map(); // `${userId}|${day}` → { user_id, day, email, requests, usd, own_requests, own_usd }
  const inflight = new Map(); // userId → requests on the owner's keys that are running right now
  let problem = null;

  const upstream = (what, status) => Object.assign(new Error(`Couldn’t ${what} the AI usage counters (Supabase ${status}).`), { status: 502, code: 'UPSTREAM' });
  const note = (e) => {
    problem = { code: e?.code || 'UNREACHABLE', message: e?.message || 'Couldn’t reach Supabase.' };
    console.warn(`AI limits: ${problem.message}`);
  };

  function bumpMemory(userId, email, day, d) {
    const k = `${userId}|${day}`;
    const r = memory.get(k) ?? { user_id: userId, day, email: email || '', requests: 0, usd: 0, own_requests: 0, own_usd: 0 };
    if (email) r.email = email;
    r.requests += d.requests;
    r.usd = round6(r.usd + d.usd);
    r.own_requests += d.ownRequests;
    r.own_usd = round6(r.own_usd + d.ownUsd);
    memory.set(k, r);
    // memory is a stand-in only: keep about a month
    if (memory.size > 5000) {
      const cutoff = utcDay(Date.now() - 31 * 86_400_000);
      for (const [key, row] of memory) if (row.day < cutoff) memory.delete(key);
    }
    return r;
  }

  async function rows(query) {
    const res = await fetch(`${url}/rest/v1/ai_usage_daily?${query}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw upstream('read', res.status);
    return res.json();
  }

  const memoryRows = (filter) => [...memory.values()].filter(filter);
  const select = 'select=user_id,day,email,requests,usd,own_requests,own_usd';

  return {
    enabled,
    get storage() {
      return enabled ? 'supabase' : 'memory';
    },
    get problem() {
      return problem;
    },

    /** One user's counters for a day (today by default). Never throws: falls back to memory. */
    async usage(userId, day = utcDay()) {
      if (!userId) return EMPTY();
      if (enabled && UUID.test(userId)) {
        try {
          const [r] = await rows(`user_id=eq.${encodeURIComponent(userId)}&day=eq.${day}&${select}`);
          problem = null;
          return fromRow(r);
        } catch (e) {
          note(e);
        }
      }
      return fromRow(memory.get(`${userId}|${day}`));
    },

    /** One user's last `days` days, newest first (days without requests are zeros). */
    async history(userId, { days = 7 } = {}) {
      const list = daysBack(days);
      let got = null;
      if (enabled && UUID.test(userId)) {
        try {
          got = await rows(`user_id=eq.${encodeURIComponent(userId)}&day=gte.${list[list.length - 1]}&${select}&order=day.desc`);
        } catch (e) {
          note(e);
        }
      }
      if (!got) got = memoryRows((r) => r.user_id === userId && r.day >= list[list.length - 1]);
      const byDay = new Map(got.map((r) => [String(r.day).slice(0, 10), r]));
      return list.map((day) => ({ day, ...fromRow(byDay.get(day)) }));
    },

    /**
     * Add to a user's counters for today. d: { requests?, usd?, ownRequests?, ownUsd? }.
     * Atomic in Supabase (ylb_add_ai_usage); the memory copy is always bumped too.
     */
    async add(userId, email, d = {}) {
      if (!userId) return;
      const delta = { requests: Math.max(0, Math.round(num(d.requests))), usd: Math.max(0, round6(d.usd)), ownRequests: Math.max(0, Math.round(num(d.ownRequests))), ownUsd: Math.max(0, round6(d.ownUsd)) };
      if (!delta.requests && !delta.usd && !delta.ownRequests && !delta.ownUsd) return;
      const day = utcDay();
      bumpMemory(userId, email, day, delta);
      if (!enabled || !UUID.test(userId)) return;
      try {
        const res = await fetch(`${url}/rest/v1/rpc/ylb_add_ai_usage`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ p_user: userId, p_day: day, p_email: email || '', p_requests: delta.requests, p_usd: delta.usd, p_own_requests: delta.ownRequests, p_own_usd: delta.ownUsd }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw upstream('update', res.status);
        problem = null;
      } catch (e) {
        note(e);
      }
    },

    /** For the owner: everyone's counters for the last `days` days, newest day first, then by cost. */
    async usageByUser({ days = 7 } = {}) {
      const since = daysBack(days).pop();
      let got = null;
      if (enabled) {
        try {
          got = await rows(`day=gte.${since}&${select}&order=day.desc,usd.desc&limit=1000`);
        } catch (e) {
          note(e);
        }
      }
      if (!got) got = memoryRows((r) => r.day >= since);
      return got
        .map((r) => ({ userId: r.user_id, email: r.email || '', day: String(r.day).slice(0, 10), ...fromRow(r) }))
        .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.usd - a.usd || b.requests - a.requests));
    },

    /** A request on the owner's keys is starting: counts toward the limit until it's recorded. */
    reserve(userId) {
      inflight.set(userId, (inflight.get(userId) ?? 0) + 1);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const n = (inflight.get(userId) ?? 1) - 1;
        if (n > 0) inflight.set(userId, n);
        else inflight.delete(userId);
      };
    },

    /** Where a user stands against the owner's daily limits. */
    async status(userId, limits) {
      const used = await this.usage(userId);
      const running = inflight.get(userId) ?? 0;
      const rpd = num(limits?.requestsPerDay);
      const upd = num(limits?.usdPerDay);
      const reached = (rpd > 0 && used.requests + running >= rpd) || (upd > 0 && used.usd >= upd);
      return { requestsPerDay: rpd, usdPerDay: upd, usedRequests: used.requests, usedUsd: used.usd, running, resetsAt: nextReset(), reached };
    },
  };
}
