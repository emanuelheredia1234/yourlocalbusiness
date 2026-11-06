// Reading what was launched (spec §9.2, §9.3, §12): the ad accounts and setup checklist, the place and interest
// lookups, the Campaigns tab's rows (our database), its Refresh (one tree read per connection, at most one per business
// every 5 minutes), a campaign's review reasons, and the list of campaigns whose switch is on (for the delete-account
// and disconnect warnings, R12). Reads only: nothing here writes to Zernio. Platform text (names, review reasons) is
// data: cut, plain text, never a link unless allowlisted (R6).

import { fail } from '../integrations/common.mjs';
import { loadProject } from '../social/publish.mjs';
import { ADS_PLATFORMS, CONNECTION_OF, FINAL_STATES, PLATFORM_LABEL, idTailOf } from './contracts.mjs';
import { accountOption, adAccountRef, choiceFor, connectionFor, listAccounts, setupChecks, targetRef } from './preview.mjs';
import { jobOut } from './jobs.mjs';
import { cut, messageFor } from './messages.mjs';
import { formatMoney, zernioWhole } from './money.mjs';
import { limitsToApi, switchesProblem, switchMayBeOn } from './limits.mjs';
import { todayIn, dayLabel } from './build.mjs';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const iso = (t) => new Date(t).toISOString();
const ID = /^[A-Za-z0-9._:-]{1,120}$/;

/** The plan's own name, without the " · Meta · YLB …" tail the launch added. */
export const planNameOf = (name) => String(name ?? '').replace(/ · (Meta|Google) · YLB [0-9a-f]{12}$/, '');

/** Ads Manager / Google Ads for a campaign (built from ids only; allowlisted hosts). */
export function managerUrl(row) {
  const id = row.remote?.campaignId;
  if (row.platform === 'meta') return `https://business.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(String(row.ad_account_id).replace(/^act_/, ''))}${id ? `&selected_campaign_ids=${encodeURIComponent(id)}` : ''}`;
  return `https://ads.google.com/aw/campaigns?${id ? `campaignId=${encodeURIComponent(id)}&` : ''}ocid=${encodeURIComponent(String(row.ad_account_id))}`;
}

/** The plain words for a campaign's state (§9.3). */
export function stateText(row) {
  const P = PLATFORM_LABEL[row.platform];
  const r = row.review ?? {};
  switch (row.state) {
    case 'launching':
      return 'Launching…';
    case 'in_review':
      return `In review at ${P}. This usually takes up to a day. Nothing is spent until it’s approved.`;
    case 'active':
      return 'Running';
    case 'paused':
      return r.status === 'approved' ? 'Approved and paused. Resume to start spending.' : 'Paused: not spending.';
    case 'rejected':
      return `${P} didn’t approve this ad. Edit the ad and swap it in, or open ${row.platform === 'meta' ? 'Meta Ads Manager' : 'Google Ads'} to ask for another review.`;
    case 'with_issues':
      return `Running, but ${P} reports a delivery problem. Open Ads Manager to see it.`;
    case 'completed':
      return row.spend_cap != null && Number(row.results?.spend) >= Number(row.spend_cap) ? `Reached its ${formatMoney(row.spend_cap, row.currency)} limit and stopped.` : `Finished${row.end_at ? ` on ${dayLabel(todayIn(row.timezone, Date.parse(row.end_at)))}` : ''}.`;
    case 'ended':
      return r.deleted ? 'Deleted in Ads Manager.' : 'Ended. It can’t be resumed from the app.';
    case 'failed':
      return 'Not launched.';
    case 'unknown':
      return messageFor('UNKNOWN_LAUNCH', { platform: row.platform });
    default:
      return '';
  }
}

/** How many of the campaign's ads the platform refused, when only some were (else null). */
export function adsNotApproved(row) {
  const r = isObj(row.review) ? row.review : {};
  const remote = isObj(row.remote) ? row.remote : {};
  const of = Math.max((remote.zernioAdIds ?? []).length, (remote.adIds ?? []).length);
  const count = Array.isArray(r.adsRejected) ? r.adsRejected.length : 0;
  return count > 0 && of > 1 && count < of ? { count, of } : null;
}

/**
 * One ad's verdict from GET /ads/{id}/review (Meta and Google shapes): Google puts DISAPPROVED / APPROVED_LIMITED in
 * approvalStatus (its reviewStatus is REVIEWED); Meta's `approved` is true only while the ad delivers, so an ad under a
 * paused campaign that left review with no rejection reads approved too. → 'approved'|'rejected'|'with_issues'|'in_review'
 */
export function verdictOf(review) {
  const r = isObj(review) ? review : {};
  const appr = String(r.approvalStatus ?? '').toUpperCase();
  const rs = String(r.reviewStatus ?? '').toUpperCase();
  const rejections = (Array.isArray(r.rejections) ? r.rejections : []).filter(Boolean);
  if (appr === 'DISAPPROVED' || rs === 'DISAPPROVED') return 'rejected';
  if (appr === 'APPROVED_LIMITED' || appr === 'AREA_OF_INTEREST_ONLY' || rs === 'WITH_ISSUES') return 'with_issues';
  if (r.approved === true || appr === 'APPROVED') return 'approved';
  if (!appr && !rejections.length && ['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'].includes(rs)) return 'approved';
  return 'in_review';
}

/** A launched campaign as the app sees it (LaunchedCampaign): no Zernio ids, our words, cut platform text. */
export function campaignOut(row, job = null, planIds = null) {
  const r = isObj(row.review) ? row.review : {};
  const remote = isObj(row.remote) ? row.remote : {};
  const res = isObj(row.results) ? row.results : null;
  return {
    id: row.id,
    planId: row.plan_id,
    projectId: row.project_id,
    platform: row.platform,
    name: planNameOf(row.name),
    tag: /YLB [0-9a-f]{12}/.exec(String(row.name))?.[0] ?? null,
    account: { name: row.ad_account_name, idTail: idTailOf(row.ad_account_id), currency: row.currency, timezone: row.timezone },
    state: row.state,
    stateMessage: stateText(row),
    review: { status: r.status ?? null, reasons: Array.isArray(r.reasons) ? r.reasons.slice(0, 5).map((x) => cut(x, 200)) : [], ...(r.account ? { account: r.account, accountMessage: r.account === 'restricted' || r.account === 'disabled' || r.account === 'closed' ? `${PLATFORM_LABEL[row.platform]} has restricted this ad account. Open ${row.platform === 'meta' ? 'Meta Ads Manager' : 'Google Ads'} to see why.` : null } : {}) },
    daily: Number(row.daily_budget),
    start: todayIn(row.timezone, Date.parse(row.start_at)),
    end: row.end_at ? todayIn(row.timezone, Date.parse(row.end_at)) : null,
    launchedAs: row.launched_as,
    configuredStatus: row.configured_status ?? null,
    ...(row.spend_cap != null ? { spendCap: Number(row.spend_cap) } : {}),
    ...(res ? { spendToDate: Number(res.spend) || 0, results: { impressions: Number(res.impressions) || 0, clicks: Number(res.clicks) || 0, ctr: Number(res.ctr) || 0, ...(res.conversions != null ? { conversions: Number(res.conversions) } : {}) }, resultsAsOf: res.asOf ?? null } : {}),
    ...(remote.campaignId ? { platformCampaignId: String(remote.campaignId), openInManagerUrl: managerUrl(row) } : {}),
    ...(Array.isArray(remote.offAds) && remote.offAds.length ? { adsOff: remote.offAds.length } : {}),
    ...(remote.offAdSet ? { adSetOff: true } : {}),
    ...(adsNotApproved(row) ? { adsNotApproved: adsNotApproved(row) } : {}),
    ...(job && ['queued', 'sending', 'unknown'].includes(job.state) ? { pendingJob: jobOut(job, row.platform) } : job ? { lastJob: jobOut(job, row.platform) } : {}),
    ...(row.last_read_at ? { lastReadAt: row.last_read_at } : {}),
    ...(planIds && !planIds.has(row.plan_id) ? { planDeleted: true } : {}),
  };
}

/** A campaign whose switch is on or may be on, for the warnings (R12). */
export const liveRowOut = (row) => ({ id: row.id, name: planNameOf(row.name), platform: row.platform, daily: Number(row.daily_budget), currency: row.currency, idTail: idTailOf(row.ad_account_id) });

/** The user's campaigns whose switch is on or may be on (platform: 'meta'|'google', or every one). */
export async function liveRows(ctx, userId, platform) {
  const rows = await ctx.db.select('ad_campaigns', { user_id: userId, state: ['in', ['launching', 'in_review', 'active', 'paused', 'rejected', 'with_issues', 'unknown']], ...(platform ? { platform } : {}) }, { limit: 1000 });
  const live = new Set((await ctx.db.select('ad_jobs', { user_id: userId, state: ['in', ['queued', 'sending', 'unknown']] }, { select: 'campaign_id', limit: 1000 })).map((j) => j.campaign_id));
  return rows.filter((r) => switchMayBeOn(r, live));
}

// ───────────── accounts and the checklist ─────────────

const projectOf = (v) => (typeof v === 'string' && ID.test(v) ? v : null);
const platformOf = (v) => (ADS_PLATFORMS.includes(v) ? v : null);

/** GET /api/ads/accounts?projectId=&platform= */
export async function accounts(ctx, who, q) {
  const projectId = projectOf(q.get('projectId'));
  const platform = platformOf(q.get('platform'));
  if (!projectId || !platform) throw fail(400, 'BAD_REQUEST', 'Which business and platform?');
  await loadProject(ctx.db, who.id, projectId);
  const conn = await connectionFor(ctx, who, projectId, platform);
  const canLaunch = await canLaunchFor(ctx, who, conn.ok ? conn.tag : null);
  if (!conn.ok) return { accounts: [], connection: null, setup: [{ id: 'connected', state: 'missing', code: 'NOT_CONNECTED', message: conn.message || messageFor('NOT_CONNECTED', { platform }) }], canLaunch };
  const lctx = { userId: who.id, tag: conn.tag, projectId, platform };
  const listed = await listAccounts(ctx, conn.zid, platform, lctx);
  if (!listed.ok) return { accounts: [], connection: { label: conn.label }, setup: [{ id: 'connected', state: listed.code === 'RECONNECT' ? 'missing' : 'unknown', code: listed.code, message: messageFor(listed.code === 'UNAVAILABLE' ? 'UNAVAILABLE' : listed.code, { platform }) }], canLaunch };
  if (!listed.accounts.length) return { accounts: [], connection: { label: conn.label }, setup: [{ id: 'accounts', state: 'missing', code: 'NO_AD_ACCOUNTS', message: messageFor('NO_AD_ACCOUNTS', { platform }) }], canLaunch };
  const { row, stale } = await choiceFor(ctx, who.id, projectId, platform, conn.zid);
  const chosenAcct = row ? listed.accounts.find((a) => a.adAccountId === row.ad_account_id) : null;
  const setup = await setupChecks(ctx, conn.zid, platform, chosenAcct, lctx);
  return {
    accounts: listed.accounts.map((a) => accountOption(ctx.env, conn.zid, platform, a)),
    ...(chosenAcct ? { chosen: accountOption(ctx.env, conn.zid, platform, chosenAcct) } : {}),
    ...(stale ? { choiceStale: true } : {}),
    connection: { label: conn.label },
    setup,
    canLaunch,
  };
}

/** Whether launching is open for this user: the switches and the plan gate (never the limits). */
async function canLaunchFor(ctx, who, tag) {
  if (!tag) return false;
  const lim = await ctx.limits.effective(tag);
  if (switchesProblem(lim, ctx.env)) return false;
  return (await ctx.canLaunchAds(who.id, ctx)) === true;
}

/** PUT /api/ads/accounts/choice {projectId, platform, adAccountRef} */
export async function setChoice(ctx, who, body) {
  const projectId = projectOf(body?.projectId);
  const platform = platformOf(body?.platform);
  const ref = typeof body?.adAccountRef === 'string' && /^adacct_[0-9a-f]{32}$/.test(body.adAccountRef) ? body.adAccountRef : null;
  if (!projectId || !platform || !ref) throw fail(400, 'BAD_REQUEST', 'Choose one of the listed ad accounts.');
  await loadProject(ctx.db, who.id, projectId);
  const conn = await connectionFor(ctx, who, projectId, platform);
  if (!conn.ok) throw fail(409, conn.code, conn.message);
  const listed = await listAccounts(ctx, conn.zid, platform, { userId: who.id, tag: conn.tag, projectId, platform });
  if (!listed.ok) throw fail(502, 'UNAVAILABLE', messageFor('UNAVAILABLE'));
  const hit = listed.accounts.find((a) => adAccountRef(ctx.env, conn.zid, a.adAccountId) === ref);
  if (!hit) throw fail(400, 'BAD_REQUEST', 'Choose one of the listed ad accounts.');
  if (!hit.usable) throw fail(409, hit.reason ?? 'ACCOUNT_UNUSABLE', messageFor(hit.reason ?? 'ACCOUNT_UNUSABLE', { platform }));
  await ctx.db.upsert('ad_account_choices', { user_id: who.id, project_id: projectId, platform, zernio_account_id: conn.zid, ad_account_id: hit.adAccountId, ad_account_name: hit.name, currency: hit.currency, timezone: hit.timezone, chosen_at: iso(ctx.now()) }, { onConflict: 'user_id,project_id,platform' });
  return { chosen: accountOption(ctx.env, conn.zid, platform, hit) };
}

/** GET /api/ads/targeting/search?projectId=&platform=&dimension=geo|interest&q= */
export async function targeting(ctx, who, q) {
  const projectId = projectOf(q.get('projectId'));
  const platform = platformOf(q.get('platform'));
  const dimension = q.get('dimension') === 'interest' ? 'interest' : q.get('dimension') === 'geo' ? 'geo' : null;
  const term = String(q.get('q') ?? '').trim().slice(0, 80);
  if (!projectId || !platform || !dimension) throw fail(400, 'BAD_REQUEST', 'What should we look up?');
  if (dimension === 'interest' && platform === 'google') throw fail(400, 'BAD_REQUEST', messageFor('GOOGLE_NO_AGE'));
  if (term.length < 2) return { results: [] };
  await loadProject(ctx.db, who.id, projectId);
  const conn = await connectionFor(ctx, who, projectId, platform);
  if (!conn.ok) throw fail(409, conn.code, conn.message);
  // Meta's geo search defaults to cities: `all` returns countries, regions and ZIPs too (Google ignores geoType)
  const got = await ctx.zads.reads.targetingSearch(conn.zid, { q: term, dimension, ...(dimension === 'geo' && platform === 'meta' ? { geoType: 'all' } : {}) }, { userId: who.id, tag: conn.tag, projectId, platform });
  if (!got.ok) throw fail(got.code === 'ADS_UNAVAILABLE' ? 503 : 502, got.code === 'ADS_UNAVAILABLE' ? 'ADS_UNAVAILABLE' : 'UNAVAILABLE', messageFor(got.code === 'ADS_UNAVAILABLE' ? 'ADS_UNAVAILABLE' : 'UNAVAILABLE'));
  const KIND = { city: 'city', City: 'city', region: 'region', State: 'region', Region: 'region', zip: 'zip', Postal_Code: 'zip', country: 'country', Country: 'country', interest: 'interest' };
  const results = (Array.isArray(got.body.results) ? got.body.results : [])
    .filter((r) => isObj(r) && (typeof r.id === 'string' || typeof r.id === 'number') && /^[A-Za-z0-9:_-]{1,64}$/.test(String(r.id)))
    .slice(0, 20)
    .map((r) => {
      const kind = dimension === 'interest' ? 'interest' : KIND[r.type] ?? 'other';
      const cc = typeof r.countryCode === 'string' && /^[A-Z]{2}$/.test(r.countryCode) ? r.countryCode : kind === 'country' && /^[A-Z]{2}$/.test(String(r.id)) ? String(r.id) : null;
      const item = { key: String(r.id), name: cut(r.name, 80), kind, cc };
      return { ref: targetRef(ctx.env, who.id, platform, dimension, item), name: item.name, kind, path: (Array.isArray(r.path) ? r.path : []).slice(0, 5).map((x) => cut(x, 60)) };
    })
    .filter((r) => r.kind !== 'other');
  return { results };
}

// ───────────── the Campaigns tab ─────────────

/** GET /api/ads/campaigns?projectId= → { campaigns, limits } (our database only) */
export async function campaigns(ctx, who, projectId) {
  if (!projectOf(projectId)) throw fail(400, 'BAD_REQUEST', 'Which business?');
  await loadProject(ctx.db, who.id, projectId);
  await ctx.jobs.sweep(who.id);
  const rows = await ctx.db.select('ad_campaigns', { user_id: who.id, project_id: projectId }, { order: 'created_at.desc', limit: 200 });
  const jobs = await ctx.jobs.latestFor(who.id, rows.map((r) => r.id));
  const plans = new Set((await ctx.db.select('user_docs', { user_id: who.id, kind: 'ad' }, { select: 'id', limit: 1000 })).map((p) => p.id));
  const tag = rows[0]?.customer_tag ?? (await ctx.tagOf(who.id));
  const lim = await ctx.limits.effective(tag);
  const committed = await ctx.limits.committed(who.id, lim.ads_currency);
  return {
    campaigns: rows.map((r) => campaignOut(r, jobs.get(r.id) ?? null, plans)),
    limits: { ...limitsToApi(lim), committedDaily: committed.daily, liveCampaigns: committed.count, launchOpen: !switchesProblem(lim, ctx.env) },
  };
}

/** Our state from a tree node (§9.3). Rows we ended, or that are launching/unknown, keep theirs. */
export function stateFromNode(row, node) {
  if (['ended', 'failed', 'launching', 'unknown'].includes(row.state)) return null;
  const st = String(node.status ?? '');
  const rs = String(node.reviewStatus ?? '');
  const cap = zernioWhole(row.spend_cap);
  const spend = Number(node.metrics?.spend) || 0;
  if (st === 'cancelled') return { state: 'ended', reviewPatch: { deleted: true } };
  if (st === 'completed' || (cap != null && cap > 0 && spend >= cap)) return { state: 'completed' };
  // the verdict is per ad: the campaign is refused only when every ad is (one refused ad of three leaves two to run)
  const ads = (Array.isArray(node.adSets) ? node.adSets : []).flatMap((x) => (Array.isArray(x?.ads) ? x.ads : [])).filter(isObj);
  const refused = ads.filter((a) => a.reviewStatus === 'rejected');
  if (ads.length ? refused.length === ads.length : st === 'rejected' || rs === 'rejected') return { state: 'rejected', reviewPatch: { status: 'rejected', adsRejected: refused.map((a) => String(a._id ?? a.platformAdId ?? '')).filter(Boolean) } };
  const partial = refused.length ? { adsRejected: refused.map((a) => String(a._id ?? a.platformAdId ?? '')).filter(Boolean) } : { adsRejected: [] };
  if (st === 'error' || rs === 'with_issues' || (node.campaignIssuesInfo && st === 'active')) return { state: 'with_issues', reviewPatch: { ...partial, status: rs === 'with_issues' ? 'with_issues' : row.review?.status ?? null } };
  const configured = node.configuredStatus === 'PAUSED' || st === 'paused' ? 'PAUSED' : node.configuredStatus === 'ACTIVE' ? 'ACTIVE' : row.configured_status;
  if (configured === 'PAUSED') return { state: 'paused', configured, reviewPatch: { ...partial, ...(rs === 'approved' ? { status: 'approved' } : {}) } };
  if (st === 'pending_review' || rs === 'in_review' || (st === 'rejected' && refused.length)) return { state: 'in_review', configured, reviewPatch: { ...partial, status: 'in_review' } };
  if (st === 'active') return { state: 'active', configured, reviewPatch: { ...partial, status: 'approved' } };
  return null;
}

/** POST /api/ads/campaigns/refresh {projectId}: one tree read per connection. */
export async function refresh(ctx, who, projectId) {
  if (!projectOf(projectId)) throw fail(400, 'BAD_REQUEST', 'Which business?');
  await loadProject(ctx.db, who.id, projectId);
  const rows = (await ctx.db.select('ad_campaigns', { user_id: who.id, project_id: projectId }, { limit: 200 })).filter((r) => r.remote?.campaignId && !['failed'].includes(r.state));
  const byZid = new Map();
  for (const r of rows) byZid.set(r.zernio_account_id, [...(byZid.get(r.zernio_account_id) ?? []), r]);
  const notes = [];
  let reviewReads = 0;
  // our own last write per campaign: stored data synced before it (or while one is still going) can't overwrite it
  const lastJobs = await ctx.jobs.latestFor(who.id, rows.map((r) => r.id));
  const ownAt = (r) => {
    const j = lastJobs.get(r.id);
    if (!j) return 0;
    return ['queued', 'sending', 'unknown'].includes(j.state) ? Number.POSITIVE_INFINITY : Date.parse(j.finished_at ?? j.requested_at) || 0;
  };
  for (const [zid, all] of byZid) {
    const p0 = all[0].platform;
    const lctx = { userId: who.id, tag: all[0].customer_tag, projectId, platform: p0 };
    // only our own campaigns, by id (the tree is paged at campaign level, and an account can hold many more)
    for (let i = 0; i < all.length; i += TREE_IDS_PER_READ) {
      const list = all.slice(i, i + TREE_IDS_PER_READ);
      const earliest = list.map((r) => todayIn(r.timezone, Date.parse(r.start_at))).sort()[0];
      const got = await ctx.zads.reads.tree(zid, { campaignId: list.map((r) => String(r.remote.campaignId)).join(','), limit: list.length, fromDate: earliest, toDate: todayIn(list[0].timezone, ctx.now()), source: 'zernio' }, lctx);
      if (!got.ok) {
        notes.push({ code: got.code, message: messageFor(got.code === 'ADS_UNAVAILABLE' ? 'ADS_UNAVAILABLE' : 'UNAVAILABLE', { platform: p0 }) });
        break;
      }
      if (got.status === 202) {
        notes.push({ code: 'BACKFILL', message: `Results are still loading at ${PLATFORM_LABEL[p0]}.` });
        break;
      }
      await refreshList(ctx, who, projectId, list, got.body, lctx, ownAt, () => reviewReads++ < 5);
    }
  }
  return { ...(await campaigns(ctx, who, projectId)), ...(notes.length ? { notes } : {}) };
}

/** How many campaign ids one tree read asks for. */
const TREE_IDS_PER_READ = 20;

/** Apply one tree page to our rows: results always; state, switch and budget only from data synced after our last write. */
async function refreshList(ctx, who, projectId, list, body, lctx, ownAt, mayReadReview) {
  {
    const nodes = (Array.isArray(body.campaigns) ? body.campaigns : []).filter(isObj);
    const synced = Date.parse(body.syncedAt ?? '');
    const asOf = typeof body.syncedAt === 'string' ? body.syncedAt : iso(ctx.now());
    for (const r of list) {
      const n = nodes.find((x) => String(x.platformCampaignId) === String(r.remote.campaignId));
      if (!n) continue;
      const m = n.metrics ?? {};
      const results = { spend: Number(m.spend) || 0, impressions: Number(m.impressions) || 0, clicks: Number(m.clicks) || 0, ctr: Number(m.ctr) || 0, ...(m.conversions != null ? { conversions: Number(m.conversions) || 0 } : {}), asOf };
      // Zernio's stored copy is 15 to 60 minutes behind: it never undoes a switch or budget we set after it was read
      const fresh = Number.isFinite(synced) && synced > ownAt(r);
      const s = fresh ? stateFromNode(r, n) : null;
      const review = { ...(r.review ?? {}), ...(s?.reviewPatch ?? {}) };
      // a paused launch whose review finished sends no "approved": read each ad's verdict (a few campaigns per refresh)
      const adIds = (r.remote.zernioAdIds ?? []).slice(0, 3);
      if (s?.state === 'paused' && review.status !== 'approved' && review.status !== 'rejected' && adIds.length && mayReadReview()) {
        const verdicts = [];
        for (const adId of adIds) {
          const rv = await ctx.zads.reads.review(adId, lctx);
          verdicts.push(rv.ok ? verdictOf(rv.body.review) : 'unknown');
        }
        const refusedIds = adIds.filter((_, i) => verdicts[i] === 'rejected');
        review.adsRejected = refusedIds;
        if (refusedIds.length === adIds.length) review.status = 'rejected';
        else if (verdicts.every((v) => v === 'approved' || v === 'rejected')) review.status = 'approved';
      }
      const patch = { results, last_read_at: iso(ctx.now()), updated_at: iso(ctx.now()), review, ...(s ? { state: review.status === 'rejected' && s.state === 'paused' ? 'paused' : s.state } : {}), ...(s?.configured ? { configured_status: s.configured } : {}) };
      await ctx.db.update('ad_campaigns', { id: r.id, user_id: who.id }, patch);
      if (s && s.state !== r.state) await ctx.audit.append({ userId: who.id, tag: r.customer_tag, projectId, campaignId: r.id, actor: 'platform', action: 'review', summary: `${PLATFORM_LABEL[r.platform]} reports: ${stateText({ ...r, ...patch })}`, outcome: 'info' });
      if (fresh && n.campaignBudget?.amount != null && r.platform === 'google' && zernioWhole(n.campaignBudget.amount) !== Number(r.daily_budget)) {
        await ctx.db.update('ad_campaigns', { id: r.id, user_id: who.id }, { daily_budget: zernioWhole(n.campaignBudget.amount) });
        await ctx.audit.append({ userId: who.id, tag: r.customer_tag, projectId, campaignId: r.id, actor: 'platform', action: 'budget', summary: `Budget was changed outside the app: ${formatMoney(zernioWhole(n.campaignBudget.amount), r.currency)} a day`, outcome: 'info' });
      }
    }
  }
}

/** GET /api/ads/campaigns/:id/review: each ad's verdict (at most 3 reads), reasons cut, as text. */
export async function reviewOf(ctx, who, row) {
  const lctx = { userId: who.id, tag: row.customer_tag, projectId: row.project_id, platform: row.platform };
  const ads = [];
  for (const [i, adId] of (row.remote?.zernioAdIds ?? []).slice(0, 3).entries()) {
    const got = await ctx.zads.reads.review(adId, lctx);
    if (!got.ok) {
      ads.push({ index: i, status: 'unknown', reasons: [] });
      continue;
    }
    const r = got.body.review ?? {};
    const reasons = [];
    for (const rej of Array.isArray(r.rejections) ? r.rejections : []) for (const x of Array.isArray(rej?.reasons) ? rej.reasons : []) reasons.push(typeof x === 'string' ? x : x?.message ?? '');
    for (const t of Array.isArray(r.policyTopics) ? r.policyTopics : []) reasons.push(t?.topic ?? '');
    const status = verdictOf(r);
    ads.push({ index: i, status, reasons: reasons.filter(Boolean).slice(0, 5).map((x) => cut(x, 200)) });
  }
  return { review: { platform: row.platform, ads, readAt: iso(ctx.now()) } };
}

export { CONNECTION_OF, FINAL_STATES };
