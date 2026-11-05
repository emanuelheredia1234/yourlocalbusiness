// The usage ledger (table usage_ledger): one row per treg response (success or failure), plus the estimated
// rows for connected accounts and X posts. Integer micro-USD only; nothing here rounds.
//
//   const ledger = createLedger({ db, now, log });
//   await ledger.write({ customer_tag, user_id, project_id, feature, vendor, endpoint, call_id, cost_micro, outcome, … });
//   await ledger.spend(tag)              → { todayMicro, monthMicro, todayCalls }   (vendor 'treg' only: what caps count)
//   await ledger.rows({ customer_tag, since, until, vendor })   every row in a window (paged past PostgREST's 1000)
//   await ledger.byIdempotencyKey(key)   earlier rows for that key (timeout replays, spec §1.4)
//   await ledger.pending(olderThanIso)   'pending' (and 410 'error:uncertain') rows not settled yet
//   await ledger.clearUser(userId)       after an account is deleted: user_id → null, the customer tag stays
//
// Rows are never updated except clearUser: a settlement or a correction is a new row with the same call_id.

import { safeLog } from '../integrations/common.mjs';

const PAGE = 1000;
const MAX_PAGES = 200; // 200k rows per question; far above one customer's month

/** Start of the UTC day / month of a time, as ISO. */
export const dayStart = (t) => `${new Date(t).toISOString().slice(0, 10)}T00:00:00.000Z`;
export const monthStart = (t) => `${new Date(t).toISOString().slice(0, 7)}-01T00:00:00.000Z`;

/** A row counts as a call (for calls_per_day and the reports) unless it only corrects or repeats one. */
export const isCall = (r) => r.outcome !== 'settled' && r.outcome !== 'timeout';
/** Money that's real (treg's settled charge): estimates for Nango and X never count toward caps or treg totals. */
export const isReal = (r) => r.vendor === 'treg' && r.estimated !== true;

export function createLedger({ db, now = () => Date.now(), log = console } = {}) {
  /** Every row matching `filters`, oldest first, in pages. */
  async function selectAll(filters, select = '*') {
    const out = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await db.select('usage_ledger', filters, { select, order: 'id.asc', limit: PAGE, offset: page * PAGE });
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return out;
  }

  return {
    get enabled() {
      return db?.enabled === true;
    },

    /**
     * Insert one row (created_at set here, so every copy of the server and the tests agree on the clock).
     * Returns true when stored. A failure is logged (no values) and returns false: the caller has already
     * spent the money, so it must not throw away the answer because the ledger was briefly unreachable.
     */
    async write(row) {
      const full = { estimated: false, cost_micro: 0, ...row, created_at: row.created_at ?? new Date(now()).toISOString() };
      full.cost_micro = Math.trunc(Number(full.cost_micro) || 0);
      try {
        await db.insert('usage_ledger', full);
        return true;
      } catch (e) {
        safeLog('ledger_write_failed', { endpoint: full.endpoint, outcome: full.outcome, code: e?.code }, log);
        return false;
      }
    },

    /** Today's and this month's real treg spend for a customer (UTC), and today's call count. */
    async spend(customerTag) {
      const at = now();
      const rows = await selectAll({ customer_tag: customerTag, vendor: 'treg', created_at: ['gte', monthStart(at)] }, 'cost_micro,created_at,outcome,vendor,estimated');
      const today = dayStart(at);
      let todayMicro = 0;
      let monthMicro = 0;
      let todayCalls = 0;
      for (const r of rows) {
        if (!isReal(r)) continue;
        const c = Number(r.cost_micro) || 0;
        monthMicro += c;
        if (String(r.created_at) >= today) {
          todayMicro += c;
          if (isCall(r)) todayCalls += 1;
        }
      }
      return { todayMicro, monthMicro, todayCalls };
    },

    /** Rows in [since, until), optionally for one customer or vendor. */
    async rows({ customer_tag, vendor, since, until, select = '*' } = {}) {
      const f = {};
      if (customer_tag) f.customer_tag = customer_tag;
      if (vendor) f.vendor = vendor;
      // two bounds on one column: PostgREST takes the filter twice; our client takes one per key, so the upper
      // bound is applied here
      if (since) f.created_at = ['gte', since];
      const rows = await selectAll(f, select);
      return until ? rows.filter((r) => String(r.created_at) < until) : rows;
    },

    /** The last rows of a customer, newest first. */
    async recent(customerTag, limit = 50) {
      return db.select('usage_ledger', { customer_tag: customerTag }, { order: 'id.desc', limit });
    },

    async byIdempotencyKey(key) {
      if (!key) return [];
      return db.select('usage_ledger', { idempotency_key: key }, { order: 'id.asc', limit: 20 });
    },

    /**
     * Rows whose charge treg hasn't told us yet, older than `olderThanIso`, with no 'settled' row (by call_id):
     * 'pending' (a 202) and 'error:uncertain' (a 410 idempotency_* answer, or a 409 to our repeat after a
   * timeout: it may have been charged). `sinceIso` leaves out older rows.
     */
    async pending(olderThanIso, sinceIso = null) {
      const rows = (await selectAll({ outcome: ['in', ['pending', 'error:uncertain']], created_at: ['lt', olderThanIso] })).filter((r) => !sinceIso || String(r.created_at) >= sinceIso);
      const ids = [...new Set(rows.map((r) => r.call_id).filter(Boolean))];
      if (!ids.length) return [];
      const settled = new Set();
      for (let i = 0; i < ids.length; i += 100) {
        const done = await db.select('usage_ledger', { call_id: ['in', ids.slice(i, i + 100)], outcome: 'settled' }, { select: 'call_id', limit: PAGE });
        for (const d of done) settled.add(d.call_id);
      }
      return rows.filter((r) => r.call_id && !settled.has(r.call_id));
    },

    /** After an account is gone: its ledger rows keep the customer tag (for invoices) and lose the user id. */
    async clearUser(userId) {
      await db.update('usage_ledger', { user_id: userId }, { user_id: null });
    },
  };
}
