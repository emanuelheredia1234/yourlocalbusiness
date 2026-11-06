// Check status (spec §8): an `unknown` job is decided only by reads (GET), at most once per 30 s per job. Nothing
// here sends a write or an Idempotency-Key (a replay of POST /v1/ads/create is a write). "Launch again" after a
// definite NOT_CREATED / PARTIAL_LEFT is a new launch with a new key and tag, through a new spend confirm.
//
// What each kind reads:
//   launch, Meta    accounts/live (every status, campaigns with no ads too), matched on the "YLB <12 hex>" tag and the
//                   row's own ad account; the tree (source=all) for the ads. Not found → NOT_CREATED only when the
//                   live read is at least 2 minutes after the send and Zernio didn't report an unconfirmed write.
//   launch, Google  the tree (source=all): Google has no live read. Not found → NOT_CREATED only when the sync is at
//                   least 10 minutes after the send.
//   status          Meta accounts/live configuredStatus; Google GET /ads/{id}?live=true (statusReadAt must be set)
//   budget          Meta accounts/live (whole units); Google the tree with a sync after the send
//   spend cap       accounts/live spendCap
//   end date        the raw ad set's end_time (instants compared, not strings)
//   creative        GET /ads/{id}?live=true creative fields / the search ad's lists

import { createIds } from './zernioAds.mjs';
import { messageFor } from './messages.mjs';
import { compareWhole, zernioWhole } from './money.mjs';

const META_NOT_FOUND_AFTER_MS = 2 * 60_000;
const GOOGLE_NOT_FOUND_AFTER_MS = 10 * 60_000;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const iso = (t) => new Date(t).toISOString();
const tagOf = (row) => /YLB [0-9a-f]{12}/.exec(String(row.name ?? ''))?.[0] ?? null;

/** → { state: 'done'|'failed'|'unknown', code?, ref?, campaign?: patch, note?: code } (never throws on a read failure) */
export async function decide(ctx, job, row, lctx) {
  const ref = job.provider_ref ?? {};
  const sentAt = Date.parse(ref.sentAt ?? job.requested_at) || Date.parse(job.requested_at);
  const remote = row.remote ?? {};
  const z = ctx.zads.reads;

  const metaLive = async () => {
    const got = await z.liveEntities(row.zernio_account_id, row.ad_account_id, lctx);
    return got.ok ? got.body : null;
  };
  const campaignIn = (live, id) => (Array.isArray(live?.campaigns) ? live.campaigns : []).find((c) => isObj(c) && String(c.platformCampaignId) === String(id)) ?? null;

  if (job.kind === 'launch') {
    const tag = tagOf(row);
    const step = ref.step ?? 'create';
    if (row.platform === 'meta' && (step === 'cap' || step === 'activate')) {
      // the create went through (ids stored): only the step that was unclear is read
      const live = await metaLive();
      const c = live && campaignIn(live, remote.campaignId ?? ref.ids?.campaignId);
      if (!c) return { state: 'unknown', note: 'STILL_UNKNOWN_META' };
      const capSet = zernioWhole(c.spendCap) != null;
      if (step === 'cap') {
        if (!capSet) return { state: 'done', code: 'CAP_NOT_SET', campaign: { state: 'paused', configured_status: 'PAUSED' } };
        return { state: 'done', code: row.launched_as === 'ACTIVE' ? 'ACTIVATION_NOT_SENT' : null, campaign: { state: 'paused', configured_status: 'PAUSED', spend_cap: zernioWhole(c.spendCap) } };
      }
      if (c.configuredStatus === 'ACTIVE') return { state: 'done', campaign: { state: 'in_review', configured_status: 'ACTIVE' } };
      if (c.configuredStatus === 'PAUSED') return { state: 'done', code: 'ACTIVATION_NOT_SENT', campaign: { state: 'paused', configured_status: 'PAUSED' } };
      return { state: 'unknown', note: 'STILL_UNKNOWN_META' };
    }
    if (!tag) return { state: 'unknown' };
    if (row.platform === 'meta') {
      const live = await metaLive();
      if (!live) return { state: 'unknown', note: 'STILL_UNKNOWN_META' };
      const c = (Array.isArray(live.campaigns) ? live.campaigns : []).find((x) => isObj(x) && String(x.campaignName ?? '').includes(tag));
      if (!c) {
        const readAt = Date.parse(live.readAt ?? '');
        if (Number.isFinite(readAt) && readAt - sentAt >= META_NOT_FOUND_AFTER_MS && !ref.unconfirmedWrite) return { state: 'failed', code: 'NOT_CREATED', campaign: { state: 'failed', configured_status: null } };
        return { state: 'unknown', note: 'STILL_UNKNOWN_META' };
      }
      const sets = (Array.isArray(live.adSets) ? live.adSets : []).filter((s) => isObj(s) && String(s.platformCampaignId) === String(c.platformCampaignId));
      const leftBehind = [{ type: 'campaign', id: String(c.platformCampaignId), cleanup: 'left_behind' }, ...sets.map((s) => ({ type: 'adset', id: String(s.platformAdSetId), cleanup: 'left_behind' }))];
      if (!sets.length) return { state: 'failed', code: 'PARTIAL_LEFT', ref: { leftBehind }, campaign: { state: 'failed', configured_status: null } };
      // the ads: the tree (source=all sees objects Meta made that Zernio never stored)
      const t = await z.tree(row.zernio_account_id, { search: tag, source: 'all' }, lctx);
      const node = t.ok ? (Array.isArray(t.body.campaigns) ? t.body.campaigns : []).find((n) => isObj(n) && String(n.platformCampaignId) === String(c.platformCampaignId)) : null;
      const ads = node ? (node.adSets ?? []).flatMap((s) => (Array.isArray(s?.ads) ? s.ads : [])).filter(isObj) : [];
      if (!ads.length) {
        const synced = t.ok ? Date.parse(t.body.syncedAt ?? '') : Number.NaN;
        if (Number.isFinite(synced) && synced - sentAt >= GOOGLE_NOT_FOUND_AFTER_MS) return { state: 'failed', code: 'PARTIAL_LEFT', ref: { leftBehind }, campaign: { state: 'failed', configured_status: null } };
        return { state: 'unknown', note: 'STILL_UNKNOWN_META' };
      }
      const ids = { ...createIds({ ads: ads.map((a) => ({ ...a, platformCampaignId: c.platformCampaignId, platformAdSetId: sets[0].platformAdSetId })) }) };
      // found: the tree exists, held PAUSED as created; its limit and switch never went (the check never writes)
      const capSet = zernioWhole(c.spendCap) != null;
      const on = c.configuredStatus === 'ACTIVE';
      return { state: 'done', code: capSet ? (row.launched_as === 'ACTIVE' && !on ? 'ACTIVATION_NOT_SENT' : null) : 'CAP_NOT_SET', ref: { ids }, campaign: { remote: { ...remote, ...ids }, state: on ? 'in_review' : 'paused', configured_status: on ? 'ACTIVE' : 'PAUSED', ...(capSet ? { spend_cap: zernioWhole(c.spendCap) } : {}), review: { status: 'in_review' } } };
    }
    const t = await z.tree(row.zernio_account_id, { search: tag, source: 'all' }, lctx);
    if (!t.ok || t.status === 202) return { state: 'unknown', note: 'STILL_UNKNOWN_GOOGLE' };
    const node = (Array.isArray(t.body.campaigns) ? t.body.campaigns : []).find((n) => isObj(n) && String(n.campaignName ?? '').includes(tag));
    if (!node) {
      const synced = Date.parse(t.body.syncedAt ?? '');
      if (Number.isFinite(synced) && synced - sentAt >= GOOGLE_NOT_FOUND_AFTER_MS) return { state: 'failed', code: 'NOT_CREATED', campaign: { state: 'failed', configured_status: null } };
      return { state: 'unknown', note: 'STILL_UNKNOWN_GOOGLE' };
    }
    const ads = (node.adSets ?? []).flatMap((s) => (Array.isArray(s?.ads) ? s.ads : [])).filter(isObj);
    const ids = createIds({ ads: ads.map((a) => ({ ...a, platformCampaignId: node.platformCampaignId, platformAdSetId: node.adSets?.[0]?.platformAdSetId })) });
    const on = node.configuredStatus === 'ACTIVE' || (node.configuredStatus == null && node.status !== 'paused');
    return { state: 'done', ref: { ids }, campaign: { remote: { ...remote, ...ids, campaignId: String(node.platformCampaignId) }, state: on ? 'in_review' : 'paused', configured_status: on ? 'ACTIVE' : 'PAUSED', review: { status: 'in_review' } } };
  }

  // a change: read the one write that was unclear
  const step = Number.isInteger(ref.step) ? ref.step : 0;
  const ops = Array.isArray(job.request?.ops) ? job.request.ops : [];
  const op = ops[step] ?? { op: ref.op };
  const last = step >= ops.length - 1;
  // a later step that didn't happen still leaves the earlier ones (a higher spending limit, which can't spend by itself)
  const after = (ok) => (ok ? (last ? { state: 'done' } : { state: 'failed', code: 'CHANGE_INCOMPLETE' }) : { state: 'failed', code: step > 0 ? 'CHANGE_INCOMPLETE' : 'NOT_CHANGED' });

  if (op.op === 'campaignStatus' || op.op === 'adSetStatus' || op.op === 'adStatus') {
    const want = op.status === 'active' ? 'ACTIVE' : 'PAUSED';
    let got = null;
    if (row.platform === 'meta' && op.op === 'campaignStatus') {
      const live = await metaLive();
      got = live ? campaignIn(live, remote.campaignId)?.configuredStatus ?? null : null;
    } else {
      const adId = op.op === 'adStatus' ? op.id : (remote.zernioAdIds ?? [])[0];
      const r = adId ? await z.ad(adId, { live: true }, lctx) : { ok: false };
      if (r.ok && r.body.statusReadAt) {
        const a = r.body.ad ?? {};
        got = op.op === 'adStatus' ? a.configuredStatus : a.status === 'paused' ? 'PAUSED' : 'ACTIVE';
      }
    }
    if (got !== 'ACTIVE' && got !== 'PAUSED') return { state: 'unknown', note: row.platform === 'meta' ? 'STILL_UNKNOWN_META' : 'STILL_UNKNOWN_GOOGLE' };
    const res = after(got === want);
    const patch = op.op === 'campaignStatus' ? { configured_status: got, state: got === 'ACTIVE' ? (row.review?.status === 'approved' ? 'active' : 'in_review') : job.kind === 'end' && got === 'PAUSED' && last ? 'ended' : 'paused', ...(job.kind === 'end' && got === 'PAUSED' && last ? { ended_at: iso(ctx.now()) } : {}) } : {};
    return { ...res, campaign: patch };
  }
  if (op.op === 'cap') {
    const live = await metaLive();
    const c = live && campaignIn(live, remote.campaignId);
    if (!c) return { state: 'unknown', note: 'STILL_UNKNOWN_META' };
    const cap = zernioWhole(c.spendCap);
    if (cap != null && compareWhole(cap, op.amount, row.currency) === 0) return { ...after(true), campaign: { spend_cap: cap } };
    return { ...after(false), ...(cap != null ? { campaign: { spend_cap: cap } } : {}) };
  }
  if (op.op === 'adSetBudget' || op.op === 'campaignBudget') {
    const from = job.before?.daily;
    let now = null;
    if (row.platform === 'meta') {
      const live = await metaLive();
      const c = live && campaignIn(live, remote.campaignId);
      const s = live && (live.adSets ?? []).find((x) => isObj(x) && String(x.platformAdSetId) === String(remote.adSetId));
      now = op.op === 'campaignBudget' ? zernioWhole(c?.dailyBudget) : zernioWhole(s?.dailyBudget);
      if (!live) return { state: 'unknown', note: 'STILL_UNKNOWN_META' };
    } else {
      const t = await z.tree(row.zernio_account_id, { campaignId: remote.campaignId, source: 'all' }, lctx);
      const synced = t.ok ? Date.parse(t.body.syncedAt ?? '') : Number.NaN;
      if (!t.ok || !Number.isFinite(synced) || synced <= Date.parse(ref.sentAt ?? job.requested_at)) return { state: 'unknown', note: 'STILL_UNKNOWN_GOOGLE' };
      const n = (t.body.campaigns ?? []).find((x) => isObj(x) && String(x.platformCampaignId) === String(remote.campaignId));
      now = zernioWhole(n?.campaignBudget?.amount);
    }
    if (now == null) return { state: 'unknown' };
    if (compareWhole(now, op.amount, row.currency) === 0) return { ...after(true), campaign: last ? { daily_budget: now } : {} };
    if (from != null && compareWhole(now, from, row.currency) === 0) return after(false);
    return { state: 'unknown', note: 'THIRD_VALUE', noteCtx: { amount: now, currency: row.currency } };
  }
  if (op.op === 'endDate') {
    const r = await z.adSet(op.id, row.zernio_account_id, lctx);
    const t = r.ok ? Date.parse(r.body.adSet?.end_time ?? '') : Number.NaN;
    if (!Number.isFinite(t)) return { state: 'unknown', note: 'STILL_UNKNOWN_META' };
    const want = Date.parse(op.value);
    const before = Date.parse(job.before?.endAt ?? row.end_at ?? '');
    if (Math.abs(t - want) < 1000) return { ...after(true), campaign: last ? { end_at: iso(want) } : {} };
    if (Number.isFinite(before) && Math.abs(t - before) < 1000) return after(false);
    return { state: 'unknown' };
  }
  if (op.op === 'metaCreative' || op.op === 'searchText') {
    const r = await z.ad(op.id, { live: true }, lctx);
    if (!r.ok) return { state: 'unknown' };
    const a = r.body.ad ?? {};
    const same = op.op === 'metaCreative' ? a.creative?.headline === op.creative.headline && a.creative?.body === op.creative.body : JSON.stringify((a.headlines ?? []).map((x) => (isObj(x) ? x.text : x))) === JSON.stringify(op.headlines);
    return same ? { ...after(true), campaign: last ? { state: row.configured_status === 'ACTIVE' ? 'in_review' : row.state, review: { ...(row.review ?? {}), status: 'in_review' } } : {} } : after(false);
  }
  return { state: 'unknown' };
}

/** POST /api/ads/jobs/:id/check → { job, campaign } after one claimed check. */
export async function checkJob(ctx, who, jobId) {
  const row0 = await ctx.jobs.byId(who.id, jobId);
  if (!row0) return null;
  const camp = (await ctx.db.select('ad_campaigns', { id: row0.campaign_id, user_id: who.id }, { limit: 1 }))[0];
  if (!camp) return null;
  if (row0.state !== 'unknown') return { job: row0, campaign: camp, unchanged: true };
  const job = await ctx.jobs.claimCheck(who.id, row0);
  const lctx = { userId: who.id, tag: camp.customer_tag, projectId: camp.project_id, platform: camp.platform };
  const d = await decide(ctx, job, camp, lctx);
  let finished = job;
  if (d.state !== 'unknown') finished = await ctx.jobs.finish(who.id, job.id, { state: d.state, code: d.code ?? null, ref: d.ref });
  if (d.campaign && Object.keys(d.campaign).length) await ctx.db.update('ad_campaigns', { id: camp.id, user_id: who.id }, { ...d.campaign, last_read_at: iso(ctx.now()), updated_at: iso(ctx.now()) });
  const said = d.state === 'unknown' ? messageFor(d.note ?? 'UNKNOWN', { platform: camp.platform, ...(d.noteCtx ?? {}) }) : messageFor(d.code ?? 'DONE', { platform: camp.platform });
  await ctx.audit.append({ userId: who.id, tag: camp.customer_tag, projectId: camp.project_id, campaignId: camp.id, jobId: job.id, actor: 'customer', action: 'check', summary: `Check status: ${d.state === 'done' ? 'it happened' : d.state === 'failed' ? 'it did not happen' : 'not known yet'}. ${said}`, outcome: 'info' });
  const fresh = (await ctx.db.select('ad_campaigns', { id: camp.id, user_id: who.id }, { limit: 1 }))[0] ?? camp;
  return { job: finished, campaign: fresh, note: d.state === 'unknown' ? said : null };
}
