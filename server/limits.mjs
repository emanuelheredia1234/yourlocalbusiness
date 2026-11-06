// Daily AI counters per signed-in user (UTC days), so the owner can cap how much of their keys
// each person uses: requests and dollars per day.
//
// With Supabase's secret key, counters live in public.ai_usage_daily (server-only: row-level
// security with no policies) and are bumped atomically by public.ylb_add_ai_usage, so several
// copies of the server share them and they survive restarts. Without it, they're kept in memory.
// Requests made with a user's own keys are counted apart (own_requests / own_usd) and never limit them.
//
// Requests running right now on the owner's keys are reserved in this process (count and estimated
// cost) before the counters are read, so parallel requests can't all slip under a limit. When Supabase
// can't be read for a moment, the larger of this server's own count and the last count read is used,
// and a user nobody has counted yet is refused (fail closed) until Supabase answers again. Only a
// missing table (the migration wasn't run) falls back to memory, and that is reported as `problem`.

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
  const lastRead = new Map(); // `${userId}|${day}` → the row last read from Supabase (a floor while it can't be read)
  const inflight = new Map(); // userId → Map(seq → estimated usd): requests on the owner's keys running right now
  let seq = 0;
  let problem = null;

  const MIGRATION = 'supabase/migrations/20261103030000_ai_usage_daily.sql';
  const upstream = (what, status) =>
    status === 404
      ? Object.assign(new Error(`The AI usage counters aren’t set up in Supabase yet (Supabase ${status}). Run ${MIGRATION} in Supabase → SQL Editor; until then they’re kept in this server’s memory only.`), { status: 502, code: 'NOT_SET_UP' })
      : Object.assign(new Error(`Couldn’t ${what} the AI usage counters (Supabase ${status}).`), { status: 502, code: 'UPSTREAM' });
  const note = (e) => {
    problem = { code: e?.code || 'UNREACHABLE', message: e?.code === 'NOT_SET_UP' || e?.code === 'UPSTREAM' ? e.message : `Couldn’t reach Supabase for the AI usage counters (${e?.message || 'no answer'}).` };
    console.warn(`AI limits: ${problem.message}`);
  };
  const remember = (k, r) => {
    lastRead.set(k, r ?? null);
    if (lastRead.size > 5000) lastRead.delete(lastRead.keys().next().value);
  };
  const maxRow = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    return { ...a, requests: Math.max(num(a.requests), num(b.requests)), usd: Math.max(num(a.usd), num(b.usd)), own_requests: Math.max(num(a.own_requests), num(b.own_requests)), own_usd: Math.max(num(a.own_usd), num(b.own_usd)) };
  };

  function bumpMemory(userId, email, day, d) {
    const k = `${userId}|${day}`;
    const r = memory.get(k) ?? { user_id: userId, day, email: email || '', requests: 0, usd: 0, own_requests: 0, own_usd: 0 };
    if (email) r.email = email;
    r.requests += d.requests;
    r.usd = Math.max(0, round6(r.usd + d.usd)); // d.usd < 0: an estimate charged earlier, corrected
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

  /**
   * One user's counters for a day, and whether they can be trusted for a limit (known: false when
   * Supabase can't be read and this server has never seen a count for them that day).
   */
  async function read(userId, day) {
    const k = `${userId}|${day}`;
    if (enabled && UUID.test(userId)) {
      try {
        const [r] = await rows(`user_id=eq.${encodeURIComponent(userId)}&day=eq.${day}&${select}`);
        problem = null;
        remember(k, r);
        return { used: fromRow(r), known: true };
      } catch (e) {
        note(e);
        // the table isn't there: this server's memory is all there is (reported as `problem`)
        if (e?.code === 'NOT_SET_UP') return { used: fromRow(memory.get(k)), known: true };
        const floor = maxRow(lastRead.has(k) ? lastRead.get(k) ?? { requests: 0, usd: 0, own_requests: 0, own_usd: 0 } : null, memory.get(k) ?? null);
        return { used: fromRow(floor), known: !!floor };
      }
    }
    return { used: fromRow(memory.get(k)), known: true };
  }

  return {
    enabled,
    /** Where the counters are kept: 'supabase', or 'memory' (also while `problem` says Supabase isn't keeping them). */
    get storage() {
      return enabled && problem?.code !== 'NOT_SET_UP' ? 'supabase' : 'memory';
    },
    /** Why Supabase isn't keeping the counters right now ({ code, message }), or null. */
    get problem() {
      return problem;
    },

    /** Read Supabase once (a tiny query) so `storage` and `problem` are current. */
    async probe() {
      if (!enabled) return;
      try {
        await rows(`${select}&limit=1`);
        problem = null;
      } catch (e) {
        note(e);
      }
    },

    /** One user's counters for a day (today by default). Never throws: falls back to what this server knows. */
    async usage(userId, day = utcDay()) {
      if (!userId) return EMPTY();
      return (await read(userId, day)).used;
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
     * Add to a user's counters for a day (today by default; pass the day a request started on, so one
     * that runs past midnight counts on its own day). d: { requests?, usd?, ownRequests?, ownUsd? };
     * usd may be negative to correct an estimate charged earlier (the total never goes below 0).
     * Atomic in Supabase (ylb_add_ai_usage); the memory copy is always bumped too.
     */
    async add(userId, email, d = {}, { day = utcDay() } = {}) {
      if (!userId) return;
      const delta = { requests: Math.max(0, Math.round(num(d.requests))), usd: round6(d.usd), ownRequests: Math.max(0, Math.round(num(d.ownRequests))), ownUsd: Math.max(0, round6(d.ownUsd)) };
      if (!delta.requests && !delta.usd && !delta.ownRequests && !delta.ownUsd) return;
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
      // signed-out visitors (anon:<address>) are only ever counted in memory
      if (!got) got = memoryRows((r) => r.day >= since);
      else got = [...got, ...memoryRows((r) => r.day >= since && !UUID.test(r.user_id))];
      return got
        .map((r) => ({ userId: r.user_id, email: r.email || '', day: String(r.day).slice(0, 10), ...fromRow(r) }))
        .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.usd - a.usd || b.requests - a.requests));
    },

    /**
     * A request on the owner's keys is starting: it counts toward the limit (one request, `usd`
     * estimated dollars) until it's recorded. Call this before reading the counters (synchronously,
     * so parallel requests queue up in order), then pass the reservation to status(). Returns the
     * release function, which also carries the reservation's place in line.
     */
    reserve(userId, { usd = 0 } = {}) {
      const id = ++seq;
      const mine = inflight.get(userId) ?? new Map();
      mine.set(id, Math.max(0, num(usd)));
      inflight.set(userId, mine);
      let done = false;
      const release = () => {
        if (done) return;
        done = true;
        const m = inflight.get(userId);
        if (!m) return;
        m.delete(id);
        if (!m.size) inflight.delete(userId);
      };
      release.seq = id;
      return release;
    },

    /**
     * A user's dollars on the app's keys since `sinceDay` (YYYY-MM-DD, inclusive; at most ~31 rows): { usd, known }.
     * Their own keys never count (own_usd). Same fail-closed rule as the daily counters: Supabase unreadable and
     * nothing seen here for them → known: false.
     */
    async monthUsage(userId, sinceDay) {
      const mem = () => round6(memoryRows((r) => r.user_id === userId && r.day >= sinceDay).reduce((n, r) => n + num(r.usd), 0));
      if (enabled && UUID.test(userId)) {
        try {
          const got = await rows(`user_id=eq.${encodeURIComponent(userId)}&day=gte.${sinceDay}&select=day,usd&order=day.desc&limit=400`);
          problem = null;
          return { usd: round6(got.reduce((n, r) => n + num(r.usd), 0)), known: true };
        } catch (e) {
          note(e);
          if (e?.code === 'NOT_SET_UP') return { usd: mem(), known: true };
          const seen = memoryRows((r) => r.user_id === userId && r.day >= sinceDay).length > 0;
          return { usd: mem(), known: seen };
        }
      }
      return { usd: mem(), known: true };
    },

    /**
     * Where a user stands against their plan's monthly AI credits (plans: budgetUsd = credits × $0.01), counting this
     * process's requests in flight like status() so parallel requests can't all slip under it. strict: refuse when
     * this request's own estimate would take the month over (videos, web research).
     */
    async monthStatus(userId, { budgetUsd, sinceDay, resetsAt = null }, { reservation = null, strict = false } = {}) {
      const { usd, known } = await this.monthUsage(userId, sinceDay);
      const mine = inflight.get(userId) ?? new Map();
      const upTo = reservation?.seq ?? Infinity;
      let pendingUsd = 0;
      let ownUsd = 0;
      for (const [id, est] of mine) {
        if (id > upTo) continue;
        if (id === upTo) ownUsd = est;
        else pendingUsd += est;
      }
      const budget = Math.max(0, num(budgetUsd));
      const spent = usd + pendingUsd;
      const over = spent >= budget || (strict && reservation && round6(spent + ownUsd) > budget);
      return {
        budgetUsd: round6(budget),
        usedUsd: round6(usd),
        pendingUsd: round6(pendingUsd),
        estimateUsd: round6(ownUsd),
        resetsAt,
        unavailable: !known,
        tooCostly: spent < budget && over,
        reached: over || !known,
      };
    },

    /**
     * Where a user stands against the owner's daily limits.
     * reservation: this request's own reserve() (only the requests ahead of it, and it, count).
     * strict: refuse when this request's own estimate would take the dollars over the limit (videos);
     * otherwise a request may start while the dollars used so far are under the limit.
     */
    async status(userId, limits, { reservation = null, strict = false } = {}) {
      const { used, known } = await read(userId, utcDay());
      const mine = inflight.get(userId) ?? new Map();
      const upTo = reservation?.seq ?? Infinity;
      let running = 0;
      let pendingUsd = 0;
      let ownUsd = 0;
      for (const [id, usd] of mine) {
        if (id > upTo) continue;
        running += 1;
        if (id === upTo) ownUsd = usd;
        else pendingUsd += usd;
      }
      const rpd = num(limits?.requestsPerDay);
      const upd = num(limits?.usdPerDay);
      // without a reservation (a status read), `running` is everything in flight; with one, it includes this request
      const overRequests = rpd > 0 && (reservation ? used.requests + running > rpd : used.requests + running >= rpd);
      const spent = used.usd + pendingUsd;
      const overUsd = upd > 0 && (spent >= upd || (strict && reservation && round6(spent + ownUsd) > upd));
      const unavailable = !known && (rpd > 0 || upd > 0);
      return {
        requestsPerDay: rpd,
        usdPerDay: upd,
        usedRequests: used.requests,
        usedUsd: used.usd,
        running: reservation ? Math.max(0, running - 1) : running,
        pendingUsd: round6(pendingUsd),
        estimateUsd: round6(ownUsd),
        resetsAt: nextReset(),
        // the request alone would take the dollars over (while what's used so far is under)
        tooCostly: upd > 0 && !overRequests && spent < upd && overUsd,
        unavailable,
        reached: overRequests || overUsd || unavailable,
      };
    },
  };
}
