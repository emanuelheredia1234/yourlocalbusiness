// Removing a failed launch from the Campaigns tab (DELETE /api/ads/campaigns/:id?projectId=). Our database only:
// nothing is sent to Zernio, Meta or Google, before, during or after. A row goes only when nothing of it can be at
// the platform: its state is `failed`, it has no platform ids, no job of it is still sending or unknown ("may have
// happened"), and no job left anything behind (provider_ref.leftBehind, created objects that weren't deleted, or a
// PARTIAL_LEFT outcome). Not before its launch confirm has run out (REVIEW_TTL_MS after the last send): the job row
// is what makes a review token start one launch only, and the cascade takes it. A Google "not created" (a guess from
// an empty read 10 minutes on) waits a day. The audit row is written first (append-only); no audit, no removal.

import { fail, isUuid } from '../integrations/common.mjs';
import { loadProject } from '../social/publish.mjs';
import { REVIEW_TTL_MS } from './preview.mjs';

/** the plan's name without " · Meta · YLB …" (as reads.mjs planNameOf; no import, reads.mjs imports this file) */
const planNameOf = (name) => String(name ?? '').replace(/ · (Meta|Google) · YLB [0-9a-f]{12}$/, '');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const LIVE = ['queued', 'sending', 'unknown'];
const filled = (v) => (Array.isArray(v) ? v.length > 0 : v != null && v !== '');
/** a Google "not created" is decided on an empty read 10 minutes after the send: removal waits a day */
export const GOOGLE_NOT_CREATED_WAIT_MS = 24 * 60 * 60_000;
const LABEL = { meta: 'Meta', google: 'Google' };

export const REMOVE_CHECK_MANAGER = 'Part of this launch may exist at Meta or Google. Check Ads Manager first: it can’t be removed from the app.';
export const REMOVE_ONLY_FAILED = 'Only a launch that failed can be removed.';
export const REMOVE_JOB_LIVE = 'This launch isn’t confirmed yet. Check its status first.';
export const REMOVE_TOO_SOON = 'This launch’s confirm is still open. It can be removed 10 minutes after it was sent.';
export const REMOVE_GOOGLE_WAIT = 'Google may still be finishing this launch. It can be removed a day after it was sent, if nothing of it shows in Google Ads.';
export const REMOVE_NOT_RECORDED = 'It wasn’t removed: the app couldn’t record it. Try again in a minute.';

/** Ids that would mean something exists at the platform (on the row, or on a job's provider_ref). */
const hasPlatformIds = (o) => isObj(o) && ['campaignId', 'adSetId', 'adIds', 'zernioAdIds', 'creativeIds', 'zernioCampaignId'].some((k) => filled(o[k]));

/** What a job says may be left at the platform: parts it kept, created objects not deleted, ids it made. */
function jobLeftSomething(job) {
  const ref = isObj(job?.provider_ref) ? job.provider_ref : {};
  if (job?.error_code === 'PARTIAL_LEFT' || filled(ref.leftBehind)) return true;
  if (Array.isArray(ref.createdObjects) && ref.createdObjects.some((o) => !isObj(o) || o.cleanup !== 'deleted')) return true;
  return hasPlatformIds(ref.ids) || hasPlatformIds(ref);
}

const sentAt = (jobs, row) => Math.max(Date.parse(row?.created_at) || 0, ...jobs.map((j) => Date.parse(j.requested_at) || 0));
const googleGuess = (row, jobs) => row?.platform === 'google' && jobs.some((j) => j.error_code === 'NOT_CREATED');

/**
 * Why this row can't be removed (null: it can). jobs: every job of the row (the list reads them all for a failed
 * row; the route again). → { code, message } | null
 */
export function removeProblem(row, jobs = [], now = Date.now()) {
  if (!row || row.state !== 'failed') return { code: 'NOT_FAILED', message: REMOVE_ONLY_FAILED };
  const list = (jobs ?? []).filter(Boolean);
  if (list.some((j) => LIVE.includes(j.state))) return { code: 'JOB_LIVE', message: REMOVE_JOB_LIVE };
  if (hasPlatformIds(row.remote) || list.some(jobLeftSomething)) return { code: 'MAY_EXIST', message: REMOVE_CHECK_MANAGER };
  const since = now - sentAt(list, row);
  if (googleGuess(row, list) && since < GOOGLE_NOT_CREATED_WAIT_MS) return { code: 'TOO_SOON', message: REMOVE_GOOGLE_WAIT };
  if (since < REVIEW_TTL_MS) return { code: 'TOO_SOON', message: REMOVE_TOO_SOON };
  return null;
}

/**
 * Which words are true for a removable row: 'none' (nothing was made), 'deleted' (made, then deleted by Zernio),
 * 'unseen' (Google showed none of it when checked).
 */
export function removeKind(row, jobs = []) {
  const list = (jobs ?? []).filter(Boolean);
  if (googleGuess(row, list)) return 'unseen';
  return list.some((j) => isObj(j.provider_ref) && filled(j.provider_ref.createdObjects)) ? 'deleted' : 'none';
}

/** "…, so nothing changes there." for that kind (the app's confirm says the same). */
export function removeWords(platform, kind) {
  const p = LABEL[platform] ?? 'Meta';
  if (kind === 'deleted') return `What it made at ${p} was deleted again, so nothing changes there.`;
  if (kind === 'unseen') return `${p} showed none of it when it was checked, so nothing changes there.`;
  return `Nothing was created at ${p}, so nothing changes there.`;
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
  const problem = removeProblem(row, jobs, ctx.now());
  if (problem) throw fail(409, problem.code === 'MAY_EXIST' ? 'MAY_EXIST_AT_PLATFORM' : problem.code, problem.message);
  const where = `${planNameOf(row.name)}, ${LABEL[row.platform] ?? 'Meta'}`;
  const entry = { userId: who.id, tag: row.customer_tag, projectId, campaignId: id, actor: 'customer', action: 'remove', before: { state: row.state, platform: row.platform, jobs: jobs.length } };
  // the audit row first: a removal is never left unrecorded (append never throws; false is a lost row)
  const recorded = await audit.append({ ...entry, summary: `Removed a failed launch (${where}) from the list. ${removeWords(row.platform, removeKind(row, jobs))}`, outcome: 'done' });
  if (!recorded) throw fail(503, 'NOT_RECORDED', REMOVE_NOT_RECORDED);
  // only while it is still failed (a check that changed it meanwhile leaves it); its jobs go with it (cascade)
  const gone = await db.remove('ad_campaigns', { id, user_id: who.id, project_id: projectId, state: 'failed' }, { returning: true });
  if (!gone.length) {
    await audit.append({ ...entry, summary: `The failed launch (${where}) wasn’t removed after all: its status changed meanwhile.`, outcome: 'refused' });
    throw fail(409, 'NOT_FAILED', REMOVE_ONLY_FAILED);
  }
  return { removed: id };
}
