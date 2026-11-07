// The A/B tests' rows (supabase/migrations/20261117000000_experiments.sql), through the server's PostgREST client
// (server/integrations/db.mjs). Every query a route makes carries the server-resolved user id. State changes are
// compare-and-swaps on the state they expect: a lost race changes nothing.

import { iso } from './config.mjs';

/** Every variant column but a page version's HTML. */
export const VARIANT_COLUMNS = 'experiment_id,key,user_id,label,post_id,job_id,planned_at,share_mode,html_sha256,omnisend_campaign_id,omnisend_variant_id,metrics,metrics_at,metrics_error,visitors,views,leads,created_at,updated_at';

export function createExperimentStore({ db }) {
  const one = (rows) => rows?.[0] ?? null;
  return {
    async byId(userId, id) {
      return one(await db.select('experiments', { id, user_id: userId }, { limit: 1 }));
    },
    /** A test by id alone (the result reader and the page split: the row names its user). */
    async byIdAny(id) {
      return one(await db.select('experiments', { id }, { limit: 1 }));
    },
    async list(userId, projectId, { kind, state } = {}) {
      return db.select('experiments', { user_id: userId, project_id: projectId, ...(kind ? { kind } : {}), ...(state ? { state } : {}) }, { order: 'created_at.desc', limit: 100 });
    },
    async variants(userId, experimentIds, { withHtml = false } = {}) {
      const ids = [].concat(experimentIds);
      if (!ids.length) return [];
      return db.select('experiment_variants', { user_id: userId, experiment_id: ['in', ids] }, { select: withHtml ? '*' : VARIANT_COLUMNS, order: 'key.asc', limit: 300 });
    },
    async variant(userId, experimentId, key, { withHtml = false } = {}) {
      return one(await db.select('experiment_variants', { user_id: userId, experiment_id: experimentId, key }, { select: withHtml ? '*' : VARIANT_COLUMNS, limit: 1 }));
    },
    async variantsOfPosts(userId, postIds) {
      if (!postIds.length) return [];
      return db.select('experiment_variants', { user_id: userId, post_id: ['in', postIds] }, { select: 'experiment_id,key,post_id', limit: 10 });
    },
    async insert(row) {
      return one(await db.insert('experiments', row, { returning: true }));
    },
    async insertVariants(rows) {
      return db.insert('experiment_variants', rows, { returning: true });
    },
    /** Change a test only while it is still in `from` (one state or a list). → the row, or null */
    async swap(userId, id, from, patch) {
      return one(await db.update('experiments', { id, user_id: userId, state: Array.isArray(from) ? ['in', from] : from }, patch, { returning: true }));
    },
    async patch(userId, id, patch) {
      return one(await db.update('experiments', { id, user_id: userId }, patch, { returning: true }));
    },
    async patchVariant(userId, experimentId, key, patch, extra = {}) {
      return one(await db.update('experiment_variants', { user_id: userId, experiment_id: experimentId, key, ...extra }, patch, { returning: true }));
    },
    async removeVariant(userId, experimentId, key) {
      return db.remove('experiment_variants', { user_id: userId, experiment_id: experimentId, key });
    },
    async remove(userId, id, states) {
      return db.remove('experiments', { id, user_id: userId, state: ['in', states] }, { returning: true });
    },
    start: (id, userId, windowStart, limit) => db.rpc('ylb_experiment_start', { p_id: id, p_user: userId, p_window_start: windowStart, p_limit: limit }),
    count: (userId, windowStart) => db.rpc('ylb_experiment_count', { p_user: userId, p_window_start: windowStart }),
    addCounts: (rows) => db.rpc('ylb_experiment_add_counts', { p_rows: rows }),
    claimReads: (limit, lease) => db.rpc('ylb_experiment_claim_reads', { p_limit: limit, p_lease: lease }),
    /** Release a read claim (only this claim's), recording the read time. */
    async release(id, claim, patch) {
      return one(await db.update('experiments', { id, read_claim: claim }, { ...patch, read_claim: null, read_claimed_until: null }, { returning: true }));
    },
    /** Running page splits past their deadline (the hourly job finishes them). */
    async pagesDue(nowMs, limit = 50) {
      return db.select('experiments', { kind: 'page', state: 'running', ends_at: ['lt', iso(nowMs)] }, { limit });
    },
    /** The running split of a page (by its user and page id), if any. */
    async runningSplit(userId, pageId) {
      return one(await db.select('experiments', { user_id: userId, subject_ref: pageId, kind: 'page', state: 'running' }, { limit: 1 }));
    },
    async job(userId, jobId) {
      return one(await db.select('post_publish_jobs', { user_id: userId, id: jobId }, { select: 'id,post_id,platform,state,requested_at,finished_at,provider_ref', limit: 1 }));
    },
    async jobs(userId, jobIds) {
      if (!jobIds.length) return [];
      return db.select('post_publish_jobs', { user_id: userId, id: ['in', jobIds] }, { select: 'id,post_id,platform,state,requested_at,finished_at,provider_ref', limit: 10 });
    },
    async posts(userId, postIds) {
      if (!postIds.length) return [];
      return db.select('user_docs', { user_id: userId, kind: 'post', id: ['in', postIds] }, { select: 'id,data', limit: 10 });
    },
    async project(userId, projectId) {
      return one(await db.select('user_docs', { user_id: userId, kind: 'project', id: projectId }, { select: 'id,name:data->>name', limit: 1 }));
    },
    async publishedPage(userId, pageId) {
      return one(await db.select('published_pages', { user_id: userId, page_id: pageId }, { select: 'slug,user_id,page_id,kind,images,html,project_id,updated_at', limit: 1 }));
    },
  };
}
