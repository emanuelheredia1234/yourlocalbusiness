// The morning action's rows (supabase/migrations/20261116000000_morning_action.sql), through the server's
// PostgREST client (server/integrations/db.mjs). Every query carries the server-resolved user id. Finishing a
// generation, a retry and each feedback write are compare-and-swaps: a lost race changes nothing.

import { MORNING, STALE_MS, iso } from './config.mjs';

export function createMorningStore({ db }) {
  return {
    async settings(userId, projectId) {
      const [row] = await db.select('business_settings', { user_id: userId, project_id: projectId }, { limit: 1 });
      return row ?? null;
    },
    /** Make the settings row (the first visit): returns it (or the one another request just made). */
    async ensureSettings(userId, projectId, { timeZone, nextAt, now }) {
      const made = await db.insert('business_settings', { user_id: userId, project_id: projectId, time_zone: timeZone, next_action_at: iso(nextAt), last_active_at: iso(now) }, { returning: true, ignoreDuplicates: true, onConflict: 'user_id,project_id' });
      return made?.[0] ?? (await this.settings(userId, projectId));
    },
    async patchSettings(userId, projectId, patch) {
      return db.update('business_settings', { user_id: userId, project_id: projectId }, patch, { returning: true });
    },
    /** Advance and release a claim: matched on this run's claim id, so a stale claimer changes nothing. → matched */
    async advance(userId, projectId, claimId, patch) {
      const rows = await db.update('business_settings', { user_id: userId, project_id: projectId, claim_id: claimId }, { ...patch, claim_id: null, claimed_until: null }, { returning: true });
      return rows.length > 0;
    },
    claim: (limit, leaseSeconds) => db.rpc('ylb_morning_claim', { p_limit: limit, p_lease_seconds: leaseSeconds }),
    backlog: (olderThanSeconds) => db.rpc('ylb_morning_backlog', { p_older_than_seconds: olderThanSeconds }),

    async day(userId, projectId, localDate) {
      const [row] = await db.select('daily_actions', { user_id: userId, project_id: projectId, local_date: localDate }, { limit: 1 });
      return row ?? null;
    },
    async byId(userId, id) {
      const [row] = await db.select('daily_actions', { id, user_id: userId }, { limit: 1 });
      return row ?? null;
    },
    /** Insert the day's row unless there is one: the row, or null when one already exists. */
    async begin({ userId, projectId, localDate, timeZone, source, now }) {
      const rows = await db.insert('daily_actions', { user_id: userId, project_id: projectId, local_date: localDate, time_zone: timeZone, state: 'generating', source, attempts: 1, started_at: iso(now) }, { returning: true, ignoreDuplicates: true, onConflict: 'user_id,project_id,local_date' });
      return rows?.[0] ?? null;
    },
    /** A failed row back to generating for one more attempt (only from `failed` with these attempts). → row or null */
    async retry(row, now) {
      const [out] = await db.update('daily_actions', { id: row.id, user_id: row.user_id, state: 'failed', attempts: row.attempts }, { state: 'generating', attempts: row.attempts + 1, source: 'manual', started_at: iso(now), error_code: null, engine: null, candidates: [], chosen: null, fallback: null }, { returning: true });
      return out ?? null;
    },
    /** Finish this attempt (only while it is still this attempt, generating). → the row as it is now */
    async finish(row, patch) {
      const [out] = await db.update('daily_actions', { id: row.id, user_id: row.user_id, state: 'generating', started_at: row.started_at }, patch, { returning: true });
      return out ?? (await this.byId(row.user_id, row.id));
    },
    /** A compare-and-swap on state and chosen. → the row, or null when it changed meanwhile */
    async swap(row, patch) {
      const filter = { id: row.id, user_id: row.user_id, state: row.state, chosen: row.chosen == null ? null : row.chosen };
      const [out] = await db.update('daily_actions', filter, patch, { returning: true });
      return out ?? null;
    },
    /** `generating` rows past the stale limit become failed (INTERRUPTED). → how many */
    async sweep(now, filters = {}) {
      const rows = await db.update('daily_actions', { ...filters, state: 'generating', started_at: ['lt', iso(now - STALE_MS)] }, { state: 'failed', error_code: 'INTERRUPTED' }, { returning: true });
      return rows.length;
    },
    /** Delete actions older than keepDays (by local date). */
    async prune(cutoffDate) {
      const rows = await db.remove('daily_actions', { local_date: ['lt', cutoffDate] }, { returning: true });
      return rows.length;
    },
  };
}

export const isStale = (row, now) => row?.state === 'generating' && now - Date.parse(row.started_at) > STALE_MS;
export const attemptsLeft = (row) => (row ? Math.max(0, MORNING.maxAttempts - (Number(row.attempts) || 1)) : MORNING.maxAttempts);
