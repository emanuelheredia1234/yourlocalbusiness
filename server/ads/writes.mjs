// Running a confirmed launch or change (spec §7.5, §9.1): each step one oneShot through zernioAds.writes, in a
// fixed order, stopping at the first step that isn't ok. Nothing here retries, loops over a write or sends anything
// from a catch: an uncertain step leaves the job `unknown` (Check status reads, never sends), and the next send
// only ever comes from a new customer confirm (R1, R8).
//
// Launch: the campaign is always created PAUSED. Google = (a) create → (c) only for ACTIVE, switch the campaign on.
// Meta = (a) create → (b) the campaign spending limit (the planned total, at least Meta's minimum) → (c) only for
// ACTIVE, switch it on. All of it is covered by the one spend confirm. A tree that exists without its limit or its
// switch spends nothing, so a create that answers late can never be running untracked.
// Change: the cap goes up first and is never lowered, children before the campaign switch, the switch last.
// A step Zernio refused keeps the refusal's safe fields (zernioAds.mjs refusalDetail) on the job (error_detail) and
// in its audit row (after.refusal), and the audit line says why (messages.mjs refusalOf).

import { safeLog } from '../integrations/common.mjs';
import { createIds } from './zernioAds.mjs';
import { findOwn } from './live.mjs';
import { cut, messageFor, platformSaysLine } from './messages.mjs';
import { PLATFORM_LABEL, idTailOf } from './contracts.mjs';
import { formatMoney } from './money.mjs';
import { dayLabel, todayIn } from './build.mjs';
import { jobRefusal } from './jobs.mjs';

const iso = (t) => new Date(t).toISOString();

/** "Meta (Acme Plumbing …1234)" */
export const where = (row) => `${PLATFORM_LABEL[row.platform]} (${row.ad_account_name} …${idTailOf(row.ad_account_id)})`;

/** The audit summary of a launch, from our template only. */
export function launchSummary(row) {
  const start = todayIn(row.timezone, Date.parse(row.start_at));
  const end = row.end_at ? todayIn(row.timezone, Date.parse(row.end_at)) : null;
  return `Launched on ${where(row)}, ${row.launched_as}, ${formatMoney(row.daily_budget, row.currency)}/day, ${dayLabel(start)}${end ? ` to ${dayLabel(end)}` : ''}`;
}

/** The audit summary of a change, from our template only. request: what the confirm showed. */
export function changeSummary(row, action, request = {}) {
  const w = where(row);
  switch (action) {
    case 'pause':
      return `Paused on ${w}`;
    case 'end':
      return `Ended on ${w}`;
    case 'resume':
      return `Resumed on ${w}, ${formatMoney(request.daily ?? row.daily_budget, row.currency)}/day`;
    case 'budget':
      return `Daily budget ${formatMoney(request.from ?? row.daily_budget, row.currency)} → ${formatMoney(request.to, row.currency)} on ${w}`;
    case 'end_date':
      return `Last day ${request.from ? dayLabel(request.from) : '—'} → ${request.to ? dayLabel(request.to) : '—'} on ${w}`;
    case 'creative':
      return `Swapped the ad${request.variant ? ` (ad ${request.variant})` : ''} on ${w}`;
    default:
      return `Changed on ${w}`;
  }
}

/**
 * The audit line of a finished launch or change. A failure, or a done launch with a refused step (made but not
 * switched on), says why (jobRefusal): our sentence, then, when we have no sentence for the refusal or ours needs
 * Meta's own number, the platform's own words quoted and labelled, cut to what the 500-character line has left.
 */
function outcomeText(base, state, code, platform, said = null) {
  if (state === 'unknown') return `${base}: not confirmed yet. Check status before doing anything else.`;
  const line = state === 'done' ? `${base}: done${code ? `. ${said?.message ?? messageFor(code, { platform })}` : ''}` : `${base}: not done. ${said?.message ?? messageFor(code ?? 'REFUSED', { platform })}`;
  return said?.platformSays ? `${line} ${platformSaysLine(platform, cut(said.platformSays, Math.max(40, 470 - line.length)))}` : line;
}

/**
 * Why a job of this row ended as it did, for its audit line: as the app will say it (jobs.mjs jobOut), from the job
 * as it is now finished (ref: what this run adds to provider_ref, e.g. the steps that went through, what was left).
 */
const outcomeOf = (job, kind, code, refusal, platform, ref) => jobRefusal({ ...job, kind, error_code: code ?? 'REFUSED', error_detail: refusal ?? null, provider_ref: { ...(job.provider_ref ?? {}), ...(ref ?? {}) } }, platform);
/** the jobs whose line says why: failed ones, and done ones a refused step left short */
const saysWhy = (state, code, refusal) => state === 'failed' || (state === 'done' && !!code && !!refusal);

async function patchCampaign(ctx, userId, id, patch) {
  try {
    await ctx.db.update('ad_campaigns', { id, user_id: userId }, { ...patch, updated_at: iso(ctx.now()) });
  } catch (e) {
    safeLog('ads_campaign_update_failed', { code: e?.code }, ctx.log);
  }
}

/**
 * Which levels Meta left off after activation_failed: the live account read (ad set) and each ad's live switch.
 * Reads only. → { offAdSet, offAds }
 */
async function readOffLevels(ctx, row, ids, lctx) {
  const out = { offAdSet: false, offAds: [] };
  const live = await findOwn(ctx, row, lctx, { campaignId: ids.campaignId, adSetId: ids.adSetId });
  if (live.ok) out.offAdSet = live.adSets[0]?.configuredStatus === 'PAUSED';
  for (const adId of ids.zernioAdIds ?? []) {
    const got = await ctx.zads.reads.ad(adId, { live: true }, lctx);
    if (got.ok && got.body.statusReadAt && got.body.ad?.configuredStatus === 'PAUSED') out.offAds.push(adId);
  }
  return out;
}

/** The background run of a launch job (sending). Never throws, never resends. */
export async function runLaunch(ctx, { userId, tag, job, row, body, spendCap }) {
  const { jobs, zads, audit } = ctx;
  const platform = row.platform;
  const lctx = { userId, tag, projectId: row.project_id, platform };
  const busyKey = `${platform}:${row.ad_account_id}`;
  jobs.active.add(job.id);
  ctx.busy.add(busyKey);
  const base = launchSummary(row);
  /** refusal: the refused step's safe fields (error_detail) */
  const finishWith = async (state, code, ref, campaignPatch, refusal = null) => {
    if (campaignPatch) await patchCampaign(ctx, userId, row.id, campaignPatch);
    await jobs.finish(userId, job.id, { state, code, ref, detail: refusal });
    const said = saysWhy(state, code, refusal) ? outcomeOf(job, 'launch', code, refusal, platform, ref) : null;
    await audit.append({ userId, tag, projectId: row.project_id, campaignId: row.id, jobId: job.id, actor: 'customer', action: 'launch', summary: outcomeText(base, state, code, platform, said), ...(refusal ? { after: { refusal } } : {}), outcome: state });
  };
  try {
    await jobs.note(userId, job.id, { step: 'create', sentAt: iso(ctx.now()) });
    const a = await zads.writes.createAd(body, row.launch_key, lctx);
    if (a.outcome === 'failed') {
      const leftBehind = (a.createdObjects ?? []).filter((o) => o.cleanup === 'left_behind');
      // every object it made is kept on the job (kept, unknown and deleted too): removing the row checks them
      const createdObjects = a.createdObjects ?? [];
      return await finishWith('failed', a.code, { ...(leftBehind.length ? { leftBehind } : {}), ...(createdObjects.length ? { createdObjects } : {}), ...(a.fixUrl ? { fixUrl: a.fixUrl } : {}), sent: a.sent }, { state: 'failed', configured_status: null }, a.refusal);
    }
    if (a.outcome === 'unknown') {
      return await finishWith('unknown', 'UNKNOWN', { step: 'create', ...(a.unconfirmedWrite ? { unconfirmedWrite: a.unconfirmedWrite } : {}), ...(a.createdObjects ? { createdObjects: a.createdObjects } : {}) }, { state: 'unknown' });
    }
    const ids = createIds(a.body);
    const remote = { ...ids };
    await patchCampaign(ctx, userId, row.id, { remote, configured_status: 'PAUSED' });
    let code = null;
    if (platform === 'meta') {
      // (b) the spending limit, before anything can spend
      await jobs.note(userId, job.id, { step: 'cap', sentAt: iso(ctx.now()), ids });
      const b = ids.campaignId ? await localSafe(() => zads.writes.setCampaignSpendCap(ids.campaignId, spendCap, lctx)) : { outcome: 'failed', code: 'CAP_NOT_SET' };
      if (b.outcome === 'failed') return await finishWith('done', 'CAP_NOT_SET', { ids, capFailed: b.code }, { state: 'paused', configured_status: 'PAUSED', review: { status: 'in_review' } }, b.refusal);
      if (b.outcome === 'unknown') return await finishWith('unknown', 'UNKNOWN', { step: 'cap', ids, sentAt: iso(ctx.now()) }, { state: 'paused', configured_status: 'PAUSED', review: { status: 'in_review' } });
      await patchCampaign(ctx, userId, row.id, { spend_cap: spendCap });
    }
    // (c) only for ACTIVE: switch the campaign on
    let state = 'paused';
    let configured = 'PAUSED';
    let refusal = null;
    if (row.launched_as === 'ACTIVE') {
      await jobs.note(userId, job.id, { step: 'activate', sentAt: iso(ctx.now()), ids });
      const c = ids.campaignId ? await localSafe(() => zads.writes.setCampaignStatus(ids.campaignId, platform, 'active', lctx)) : { outcome: 'failed', code: 'REFUSED' };
      if (c.outcome === 'failed') {
        code = 'ACTIVATION_NOT_SENT';
        refusal = c.refusal ?? null;
      } else if (c.outcome === 'unknown') return await finishWith('unknown', 'UNKNOWN', { step: 'activate', ids, sentAt: iso(ctx.now()) }, { state: 'unknown', configured_status: 'PAUSED', review: { status: 'in_review' } });
      else {
        state = 'in_review';
        configured = 'ACTIVE';
      }
    }
    if (a.activationFailed && platform === 'meta') {
      const off = await readOffLevels(ctx, row, ids, lctx).catch(() => ({ offAdSet: false, offAds: [] }));
      remote.offAds = off.offAds;
      remote.offAdSet = off.offAdSet;
      code = code ?? 'ACTIVATION_FAILED';
    }
    return await finishWith('done', code, { ids }, { state, configured_status: configured, remote, review: { status: 'in_review' } }, refusal);
  } catch (e) {
    // anything unexpected after the create may have been sent: unknown, never resent
    safeLog('ads_launch_error', { error: e?.name || 'Error', code: e?.code }, ctx.log);
    await finishWith('unknown', 'UNKNOWN', { step: 'create' }, null).catch(() => {});
  } finally {
    jobs.active.delete(job.id);
    ctx.busy.delete(busyKey);
  }
}

/** The codes zernioAds.mjs throws before sending anything (a bad amount, id or date: our own check). */
const LOCAL_REFUSALS = ['BAD_AMOUNT', 'BAD_ID', 'BAD_DATE'];

/** A write whose own argument check throws before anything is sent: a definite failure, never "may have happened". */
async function localSafe(fn) {
  try {
    return await fn();
  } catch (e) {
    if (LOCAL_REFUSALS.includes(e?.code)) return { outcome: 'failed', code: 'REFUSED', sent: false, local: e.code };
    throw e;
  }
}

/** One write of a change. → zernioAds result */
function exec(ctx, row, op, lctx) {
  return localSafe(() => send(ctx, row, op, lctx));
}

function send(ctx, row, op, lctx) {
  const w = ctx.zads.writes;
  const r = row.remote ?? {};
  switch (op.op) {
    case 'cap':
      return w.setCampaignSpendCap(r.campaignId, op.amount, lctx);
    case 'campaignStatus':
      return w.setCampaignStatus(r.campaignId, row.platform, op.status, lctx);
    case 'adSetStatus':
      return w.setAdSetStatus(op.id, row.platform, op.status, lctx);
    case 'adStatus':
      return w.setAdStatus(op.id, op.status, lctx);
    case 'adSetBudget':
      return w.setAdSetBudget(op.id, op.amount, lctx);
    case 'campaignBudget':
      return w.setCampaignBudget(r.campaignId, row.platform, op.amount, lctx);
    case 'endDate':
      return w.setAdSetEndDate(op.id, op.value, lctx);
    case 'metaCreative':
      return w.setMetaCreative(op.id, op.creative, lctx);
    case 'searchText':
      return w.setSearchAdText(op.id, op.headlines, op.descriptions, op.finalUrls, lctx);
    default:
      return Promise.resolve({ outcome: 'failed', code: 'REFUSED', sent: false });
  }
}

/** What the campaign row looks like once every write of the change went through. */
function effectOf(row, action, ops, request, now) {
  const p = {};
  if (action === 'pause') Object.assign(p, { configured_status: 'PAUSED', state: row.state === 'rejected' ? 'rejected' : 'paused' });
  if (action === 'end') Object.assign(p, { configured_status: 'PAUSED', state: 'ended', ended_at: iso(now) });
  if (action === 'resume') {
    const remote = { ...(row.remote ?? {}), offAds: [], offAdSet: false };
    Object.assign(p, { configured_status: 'ACTIVE', state: row.review?.status === 'approved' ? 'active' : 'in_review', remote });
  }
  if (action === 'budget') {
    const b = ops.find((o) => o.op === 'adSetBudget' || o.op === 'campaignBudget');
    if (b) Object.assign(p, { daily_budget: b.amount, budget_level: b.op === 'campaignBudget' ? 'campaign' : 'adset' });
  }
  if (action === 'end_date' && request.endAt) p.end_at = request.endAt;
  if (action === 'creative') Object.assign(p, { review: { ...(row.review ?? {}), status: 'in_review', reasons: [] }, ...(row.configured_status === 'ACTIVE' || row.state === 'rejected' ? { state: 'in_review' } : {}) });
  const cap = ops.find((o) => o.op === 'cap');
  if (cap) p.spend_cap = cap.amount;
  return p;
}

/**
 * The background run of a change job (sending). ops: the planned writes (preview.mjs planChange). actor: 'customer'
 * or 'owner' (Pause all). Never throws, never resends.
 */
export async function runChange(ctx, { userId, tag, job, row, ops, action, request = {}, actor = 'customer' }) {
  const { jobs, audit } = ctx;
  const platform = row.platform;
  const lctx = { userId, tag, projectId: row.project_id, platform };
  const stop = action === 'pause' || action === 'end';
  const busyKey = `${platform}:${row.ad_account_id}`;
  jobs.active.add(job.id);
  if (!stop) ctx.busy.add(busyKey);
  const base = actor === 'owner' ? `Paused by the app owner on ${where(row)}` : changeSummary(row, action, request);
  /** refusal: the refused step's safe fields (error_detail) */
  const finishWith = async (state, code, ref, campaignPatch, refusal = null) => {
    if (campaignPatch && Object.keys(campaignPatch).length) await patchCampaign(ctx, userId, row.id, campaignPatch);
    await jobs.finish(userId, job.id, { state, code, ref, detail: refusal });
    const said = saysWhy(state, code, refusal) ? outcomeOf({ ...job, request: job.request ?? request }, action, code, refusal, platform, ref) : null;
    await audit.append({ userId, tag, projectId: row.project_id, campaignId: row.id, jobId: job.id, actor, action, summary: outcomeText(base, state, code, platform, said), ...(refusal ? { after: { refusal } } : {}), outcome: state });
  };
  try {
    const done = [];
    for (let i = 0; i < ops.length; i += 1) {
      const op = ops[i];
      await jobs.note(userId, job.id, { step: i, op: op.op, sentAt: iso(ctx.now()) });
      const r = await exec(ctx, row, op, lctx);
      if (r.outcome === 'ok') {
        done.push(op.op);
        if (op.op === 'cap') await patchCampaign(ctx, userId, row.id, { spend_cap: op.amount });
        continue;
      }
      if (r.outcome === 'unknown') {
        // a switch that may now be on counts as committed until a read says otherwise
        const patch = op.op === 'campaignStatus' && op.status === 'active' ? { state: 'unknown' } : {};
        return await finishWith('unknown', 'UNKNOWN', { step: i, op: op.op, done, sentAt: iso(ctx.now()) }, patch);
      }
      let code = r.code ?? 'REFUSED';
      if (op.op === 'campaignBudget' && platform === 'google' && r.status === 409) code = 'SHARED_BUDGET';
      if ((op.op === 'adSetBudget' || op.op === 'campaignBudget') && platform === 'meta' && r.status === 409 && code === 'REFUSED') code = 'BUDGET_LEVEL';
      if (code === 'REFUSED' && done.length) code = 'CHANGE_INCOMPLETE';
      return await finishWith('failed', code, { step: i, op: op.op, done, ...(r.fixUrl ? { fixUrl: r.fixUrl } : {}) }, null, r.refusal);
    }
    return await finishWith('done', null, { done }, effectOf(row, action, ops, request, ctx.now()));
  } catch (e) {
    safeLog('ads_change_error', { action, error: e?.name || 'Error', code: e?.code }, ctx.log);
    await finishWith('unknown', 'UNKNOWN', {}, null).catch(() => {});
  } finally {
    jobs.active.delete(job.id);
    if (!stop) ctx.busy.delete(busyKey);
  }
}
