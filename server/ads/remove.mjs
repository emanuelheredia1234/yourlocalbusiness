// Removing a failed launch from the Campaigns tab (DELETE /api/ads/campaigns/:id?projectId=). Our database only:
// nothing is sent to Zernio, Meta or Google, before, during or after. A row goes only when nothing of it can be at
// the platform: its state is `failed`, it has no platform ids, no job of it is still sending or unknown ("may have
// happened"), and no job left anything behind (provider_ref.leftBehind, or created objects that weren't deleted).
// Its ad_jobs go with it (on delete cascade); one ad_audit row says so, and the audit stays append-only.

import { fail, isUuid } from '../integrations/common.mjs';
import { loadProject } from '../social/publish.mjs';

/** the plan's name without " · Meta · YLB …" (as reads.mjs planNameOf; no import, reads.mjs imports this file) */
const planNameOf = (name) => String(name ?? '').replace(/ · (Meta|Google) · YLB [0-9a-f]{12}$/, '');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const LIVE = ['queued', 'sending', 'unknown'];
const filled = (v) => (Array.isArray(v) ? v.length > 0 : v != null && v !== '');

export const REMOVE_CHECK_MANAGER = 'Part of this launch may exist at Meta or Google. Check Ads Manager first: it can’t be removed from the app.';
export const REMOVE_ONLY_FAILED = 'Only a launch that failed can be removed.';
export const REMOVE_JOB_LIVE = 'This launch isn’t confirmed yet. Check its status first.';

/** Ids that would mean something exists at the platform (on the row, or on a job's provider_ref). */
const hasPlatformIds = (o) => isObj(o) && ['campaignId', 'adSetId', 'adIds', 'zernioAdIds', 'creativeIds', 'zernioCampaignId'].some((k) => filled(o[k]));

/** What a job says may be left at the platform: parts it kept, created objects not deleted, ids it made. */
function jobLeftSomething(job) {
  const ref = isObj(job?.provider_ref) ? job.provider_ref : {};
  if (filled(ref.leftBehind)) return true;
  if (Array.isArray(ref.createdObjects) && ref.createdObjects.some((o) => !isObj(o) || o.cleanup !== 'deleted')) return true;
  return hasPlatformIds(ref.ids) || hasPlatformIds(ref);
}

/**
 * Why this row can't be removed (null: it can). jobs: every job of the row (or, for a list, its latest one: the
 * route checks them all again). → { code, message } | null
 */
export function removeProblem(row, jobs = []) {
  if (!row || row.state !== 'failed') return { code: 'NOT_FAILED', message: REMOVE_ONLY_FAILED };
  const list = (jobs ?? []).filter(Boolean);
  if (list.some((j) => LIVE.includes(j.state))) return { code: 'JOB_LIVE', message: REMOVE_JOB_LIVE };
  if (hasPlatformIds(row.remote) || list.some(jobLeftSomething)) return { code: 'MAY_EXIST', message: REMOVE_CHECK_MANAGER };
  return null;
}

/** The route: the signed-in user's own row, in the business they're in, checked again here; never retried. */
export async function removeFailed(ctx, who, id, projectId) {
  const { db, audit } = ctx;
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(projectId)) throw fail(400, 'BAD_REQUEST', 'Which business?');
  if (!isUuid(id)) throw fail(404, 'NOT_FOUND', 'That campaign isn’t in your account.');
  await loadProject(db, who.id, projectId);
  const row = (await db.select('ad_campaigns', { id, user_id: who.id, project_id: projectId }, { limit: 1 }))[0];
  if (!row) throw fail(404, 'NOT_FOUND', 'That campaign isn’t in your account.');
  const jobs = await db.select('ad_jobs', { user_id: who.id, campaign_id: id }, { limit: 200 });
  const problem = removeProblem(row, jobs);
  if (problem) throw fail(409, problem.code === 'MAY_EXIST' ? 'MAY_EXIST_AT_PLATFORM' : problem.code, problem.message);
  // only while it is still failed (a check that changed it meanwhile leaves it); its jobs go with it (cascade)
  const gone = await db.remove('ad_campaigns', { id, user_id: who.id, project_id: projectId, state: 'failed' }, { returning: true });
  if (!gone.length) throw fail(409, 'NOT_FAILED', REMOVE_ONLY_FAILED);
  await audit.append({
    userId: who.id,
    tag: row.customer_tag,
    projectId,
    campaignId: id,
    actor: 'customer',
    action: 'remove',
    summary: `Removed a failed launch (${planNameOf(row.name)}, ${row.platform === 'google' ? 'Google' : 'Meta'}) from the list. Nothing was created at ${row.platform === 'google' ? 'Google' : 'Meta'}, so nothing changed there.`,
    before: { state: row.state, platform: row.platform, jobs: jobs.length },
    outcome: 'done',
  });
  return { removed: id };
}
