// A thin PostgREST client for the integration tables (supabase/migrations/20261105000000_integrations.sql),
// with Supabase's secret key, like server/limits.mjs. Server-only: the tables have row-level security with no
// policies, so only this key reaches them. Every query a route makes includes the server-resolved user_id.
//
//   const db = dbFromEnv(process.env);
//   await db.select('analytics_snapshots', { user_id: who.id, project_id: id }, { order: 'updated_at.desc', limit: 10 });
//   await db.insert('usage_ledger', row);                                  // → [] (or the rows with returning: true)
//   await db.upsert('analytics_settings', row, { onConflict: 'user_id,project_id' });
//   await db.update('post_publish_jobs', { id, user_id: who.id }, { state: 'unknown' }, { returning: true });
//   await db.remove('webhook_deliveries', { received_at: ['lt', cutoff] });
//   await db.rpc('claim_analytics_run', { p_user, p_project, p_id, p_sources });
//
// Filters: { col: value } is col = value; { col: [op, value] } with op one of eq, neq, gt, gte, lt, lte, is, in
// (in takes an array). Errors are DbError { status, code } with code NOT_SET_UP (the migration wasn't run),
// CONFLICT (a unique key: `constraint` names it), FOREIGN_KEY, UNAVAILABLE; never the database's own text.

import { serviceHeaders } from '../secretBox.mjs';

export const INTEGRATIONS_MIGRATION = 'supabase/migrations/20261105000000_integrations.sql';
const OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'in']);
const NAME = /^[a-z_][a-z0-9_]*$/;

export class DbError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'DbError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export function dbFromEnv(env = process.env, fetchImpl = globalThis.fetch) {
  return createDb({ supabaseUrl: env.SUPABASE_URL || '', secretKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '', fetch: fetchImpl });
}

/** A PostgREST value in a filter: in-lists quoted, everything else as text. */
function filterValue(op, value) {
  if (op === 'in') {
    const list = (Array.isArray(value) ? value : [value]).map((v) => `"${String(v).replace(/["\\]/g, (c) => `\\${c}`)}"`);
    return `(${list.join(',')})`;
  }
  if (op === 'is') return value === null ? 'null' : String(value);
  return String(value);
}

/** The query string of a filter object (see the header). */
export function filterQuery(filters = {}) {
  const q = new URLSearchParams();
  for (const [col, f] of Object.entries(filters)) {
    if (!NAME.test(col)) throw new DbError(400, 'BAD_REQUEST', `Bad column name: ${col}`);
    const [op, value] = Array.isArray(f) ? f : [f === null ? 'is' : 'eq', f];
    if (!OPS.has(op)) throw new DbError(400, 'BAD_REQUEST', `Bad filter: ${op}`);
    q.append(col, `${op}.${filterValue(op, value)}`);
  }
  return q;
}

/**
 * supabaseUrl, secretKey: the project's and its secret key (enabled only with both). fetch: for tests.
 * timeoutMs: each request's limit (a slow database answers UNAVAILABLE, never hangs a route).
 */
export function createDb({ supabaseUrl = '', secretKey = '', fetch = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const base = String(supabaseUrl).replace(/\/+$/, '');
  const enabled = !!(base && secretKey);
  const headers = enabled ? serviceHeaders(secretKey) : {};

  function check(table) {
    if (!enabled) throw new DbError(503, 'NOT_SET_UP', 'Supabase isn’t set up on this server (SUPABASE_URL and SUPABASE_SECRET_KEY).');
    if (!NAME.test(table)) throw new DbError(400, 'BAD_REQUEST', `Bad table name: ${table}`);
  }

  /** Map PostgREST's answer to a DbError: only our words and Postgres's error code / constraint name. */
  async function failure(res, table) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    const pg = String(body?.code || '');
    if (res.status === 404 || pg === 'PGRST205' || pg === 'PGRST202' || pg === '42P01') {
      return new DbError(503, 'NOT_SET_UP', `The ${table} table isn’t in Supabase yet. Run ${INTEGRATIONS_MIGRATION} in Supabase → SQL Editor.`);
    }
    if (pg === '23505') return new DbError(409, 'CONFLICT', 'That already exists.', { constraint: /"([a-z0-9_]+)"/.exec(String(body?.message || ''))?.[1] ?? null });
    if (pg === '23503') return new DbError(409, 'FOREIGN_KEY', 'That refers to something that isn’t there.');
    // pg: Postgres's or PostgREST's own error code (e.g. 23514 a check, PGRST204 a column not there), for the log only
    if (pg === '23514' || pg === '22P02' || pg === '428C9' || res.status === 400) return new DbError(400, 'BAD_REQUEST', 'The database refused that value.', { pg: /^[A-Z0-9]{1,16}$/.test(pg) ? pg : null });
    return new DbError(502, 'UNAVAILABLE', `Supabase answered ${res.status}.`);
  }

  async function request(method, path, { query, body, prefer, table } = {}) {
    const url = `${base}/rest/v1/${path}${query && String(query) ? `?${query}` : ''}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { ...headers, ...(prefer ? { prefer } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new DbError(503, 'UNAVAILABLE', 'Supabase couldn’t be reached.');
    }
    if (!res.ok) throw await failure(res, table ?? path);
    if (res.status === 204) return [];
    const text = await res.text();
    if (!text) return [];
    try {
      return JSON.parse(text);
    } catch {
      throw new DbError(502, 'UNAVAILABLE', 'Supabase sent something that isn’t JSON.');
    }
  }

  return {
    enabled,

    /** Rows matching `filters`. opts: select ('a,b'), order ('col.desc,col2'), limit, offset. */
    async select(table, filters = {}, { select = '*', order, limit, offset } = {}) {
      check(table);
      const q = filterQuery(filters);
      q.set('select', select);
      if (order) q.set('order', order);
      if (limit != null) q.set('limit', String(limit));
      if (offset != null) q.set('offset', String(offset));
      return request('GET', table, { query: q, table });
    },

    /** Insert one row or many. ignoreDuplicates: on conflict do nothing (onConflict: the key columns). */
    async insert(table, rows, { returning = false, ignoreDuplicates = false, onConflict } = {}) {
      check(table);
      const q = new URLSearchParams();
      if (onConflict) q.set('on_conflict', onConflict);
      const prefer = [returning ? 'return=representation' : 'return=minimal', ...(ignoreDuplicates ? ['resolution=ignore-duplicates'] : [])].join(',');
      return request('POST', table, { query: q, body: rows, prefer, table });
    },

    /** Insert or replace on the key columns (onConflict, e.g. 'user_id,project_id'). */
    async upsert(table, rows, { onConflict, returning = false } = {}) {
      check(table);
      const q = new URLSearchParams();
      if (onConflict) q.set('on_conflict', onConflict);
      return request('POST', table, { query: q, body: rows, prefer: `resolution=merge-duplicates,${returning ? 'return=representation' : 'return=minimal'}`, table });
    },

    /** Change the rows matching `filters` (at least one filter: never the whole table). */
    async update(table, filters, patch, { returning = false } = {}) {
      check(table);
      if (!filters || !Object.keys(filters).length) throw new DbError(400, 'BAD_REQUEST', 'An update needs a filter.');
      return request('PATCH', table, { query: filterQuery(filters), body: patch, prefer: returning ? 'return=representation' : 'return=minimal', table });
    },

    /** Delete the rows matching `filters` (at least one filter). */
    async remove(table, filters, { returning = false } = {}) {
      check(table);
      if (!filters || !Object.keys(filters).length) throw new DbError(400, 'BAD_REQUEST', 'A delete needs a filter.');
      return request('DELETE', table, { query: filterQuery(filters), prefer: returning ? 'return=representation' : 'return=minimal', table });
    },

    /** Call a database function (POST /rest/v1/rpc/<fn>). Set-returning functions answer an array. */
    async rpc(fn, args = {}) {
      check(fn);
      return request('POST', `rpc/${fn}`, { body: args, table: fn });
    },
  };
}
