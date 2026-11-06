// Ad events from Zernio's one webhook (POST /api/webhooks/zernio, verified and deduplicated by event id in
// server/connections/zernio.mjs, which hands over only events about one of the customer's own connections):
//   ad.review.approved / ad.review.rejected   the platform's verdict on one ad
//   ad.status_changed                         Meta: a campaign, ad set or ad changed status (WITH_ISSUES, PAUSED, …)
//   ad.delivery_issue                         an ad moved into the platform's error state
//   ad_account.status_changed                 the ad account became active, restricted, disabled or closed
// An event changes only ad_campaigns rows of that user whose Zernio connection is the event's AND whose own platform
// campaign / ad set / ad id (or ad account) is the event's: names, profile ids and text in the event never pick a
// row, and an event that matches nothing is dropped. Review reasons are kept as cut plain text (R6). This never sends
// anything to Zernio, and never starts a write: it only updates our rows and writes a 'platform' audit line.
// A throw (the database is down) reaches the webhook route, which answers 500 so Zernio delivers it again; the ads
// tables not being there yet (the migration not run) is no throw: nothing was ever launched.
//
// Events arrive late and out of order (a redelivery keeps its first timestamp). A campaign's own switch is taken from
// an event only when the event is newer than our own last write on that campaign and than the last switch event
// applied, and never while one of our writes is going or unconfirmed; with no usable timestamp it can only raise the
// switch (counting more as committed), never lower it. Review verdicts are per ad: the campaign is refused only when
// every one of its ads is.

import { AD_EVENTS, PLATFORM_LABEL } from './contracts.mjs';
import { cut } from './messages.mjs';
import { safeLog } from '../integrations/common.mjs';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const iso = (t) => new Date(t).toISOString();
const bare = (id) => String(id ?? '').replace(/^act_/, '');
/** rows that are over (or never started) keep their state; a review or account note can still be added */
const SETTLED = ['ended', 'failed', 'launching', 'unknown'];

/** The rows an event is about (already narrowed to the user and the connection). */
export function rowsFor(rows, evt) {
  if (evt.event === 'ad_account.status_changed') {
    const acct = bare(evt.adAccount?.platformAdAccountId);
    return acct ? rows.filter((r) => bare(r.ad_account_id) === acct) : [];
  }
  const o = isObj(evt.adObject) ? evt.adObject : {};
  const id = String(o.platformId ?? '');
  const acct = bare(o.platformAdAccountId);
  if (!id) return [];
  return rows.filter((r) => {
    if (acct && bare(r.ad_account_id) !== acct) return false;
    const remote = isObj(r.remote) ? r.remote : {};
    const level = String(o.level ?? 'AD');
    if (level === 'CAMPAIGN') return String(remote.campaignId) === id;
    if (level === 'AD_SET') return String(remote.adSetId) === id;
    const ads = (Array.isArray(remote.adIds) ? remote.adIds : []).map(String);
    const zads = (Array.isArray(remote.zernioAdIds) ? remote.zernioAdIds : []).map(String);
    return ads.includes(id) || (o.adId != null && zads.includes(String(o.adId)));
  });
}

/** The reasons an event carries, as cut text (at most 5). */
function reasonsOf(evt) {
  const list = [...(Array.isArray(evt.review?.reasons) ? evt.review.reasons : []), ...(Array.isArray(evt.issue?.reasons) ? evt.issue.reasons : [])];
  return list
    .map((r) => (typeof r === 'string' ? r : isObj(r) ? r.message ?? r.reason ?? '' : ''))
    .map((r) => cut(r, 200))
    .filter(Boolean)
    .slice(0, 5);
}

/** The ad an event is about, as a key in review.adsRejected (Zernio's ad id when known), or null (not one ad). */
function adKeyOf(row, evt) {
  const o = isObj(evt.adObject) ? evt.adObject : {};
  if (String(o.level ?? 'AD') !== 'AD') return null;
  const remote = isObj(row.remote) ? row.remote : {};
  const zads = (Array.isArray(remote.zernioAdIds) ? remote.zernioAdIds : []).map(String);
  const ads = (Array.isArray(remote.adIds) ? remote.adIds : []).map(String);
  if (o.adId != null && zads.includes(String(o.adId))) return String(o.adId);
  const i = ads.indexOf(String(o.platformId ?? ''));
  return i >= 0 ? zads[i] ?? `ad:${ads[i]}` : null;
}
const adCountOf = (row) => Math.max((row.remote?.zernioAdIds ?? []).length, (row.remote?.adIds ?? []).length, 1);

/** One ad refused: the campaign is refused only when all its ads are. → { review, all } */
function refuseAd(row, review, evt) {
  const key = adKeyOf(row, evt);
  const set = new Set(Array.isArray(review.adsRejected) ? review.adsRejected : []);
  if (key) set.add(key);
  const all = !key || set.size >= adCountOf(row);
  review.adsRejected = [...set];
  if (all) review.status = 'rejected';
  return all;
}

/** What an event changes on one row → { patch, summary } or null (nothing to change). own: { at, live } our last write. */
export function changeFor(row, evt, at = Date.now(), own = { at: 0, live: false }) {
  const P = PLATFORM_LABEL[row.platform];
  const review = isObj(row.review) ? { ...row.review } : {};
  const settled = SETTLED.includes(row.state);
  switch (evt.event) {
    case 'ad.review.approved': {
      const key = adKeyOf(row, evt);
      const left = (Array.isArray(review.adsRejected) ? review.adsRejected : []).filter((k) => k !== key);
      review.adsRejected = key ? left : [];
      review.status = 'approved';
      review.reasons = review.adsRejected.length ? review.reasons ?? [] : [];
      const on = row.configured_status === 'ACTIVE';
      const state = settled ? row.state : row.state === 'rejected' ? (on ? 'active' : 'paused') : on && row.state === 'in_review' ? 'active' : row.state;
      return { patch: { review, state }, summary: `${P} approved the ad.` };
    }
    case 'ad.review.rejected': {
      review.reasons = reasonsOf(evt);
      const all = refuseAd(row, review, evt);
      return { patch: { review, state: settled || !all ? row.state : 'rejected' }, summary: all ? `${P} didn’t approve the ad.` : `${P} didn’t approve one of the ads; the others can still run.` };
    }
    case 'ad.delivery_issue':
      review.issue = true;
      review.reasons = reasonsOf(evt);
      return { patch: { review, state: settled || row.state === 'completed' ? row.state : 'with_issues' }, summary: `${P} reports a delivery problem.` };
    case 'ad.status_changed': {
      const raw = String(evt.status?.raw ?? '').toUpperCase();
      const level = String(evt.adObject?.level ?? 'AD');
      if (raw === 'WITH_ISSUES') {
        review.issue = true;
        return { patch: { review, state: settled ? row.state : 'with_issues' }, summary: `${P} reports a delivery problem.` };
      }
      if (raw === 'DISAPPROVED') {
        const all = level === 'CAMPAIGN' || refuseAd(row, review, evt);
        if (all) review.status = 'rejected';
        return { patch: { review, state: settled || !all ? row.state : 'rejected' }, summary: all ? `${P} didn’t approve the ad.` : `${P} didn’t approve one of the ads; the others can still run.` };
      }
      if ((raw === 'DELETED' || raw === 'ARCHIVED') && level === 'CAMPAIGN') {
        review.deleted = true;
        return { patch: { review, state: row.state === 'failed' ? row.state : 'ended', configured_status: 'PAUSED', ended_at: row.ended_at ?? iso(at) }, summary: 'The campaign was deleted in Ads Manager.' };
      }
      // the campaign's own switch, changed outside the app: it decides what counts as committed
      if (level === 'CAMPAIGN' && (raw === 'ACTIVE' || raw === 'PAUSED') && !['ended', 'failed'].includes(row.state)) {
        if (row.configured_status === raw) return null;
        // late or out of order: never over one of our own writes (going, unconfirmed or newer), never older than the
        // last switch event applied; without a time it may only raise the switch
        if (settled || own.live) return null;
        const evtAt = Date.parse(evt.timestamp ?? '');
        const lastEvt = Date.parse(row.remote?.switchEventAt ?? '');
        if (Number.isFinite(evtAt)) {
          if (evtAt <= own.at || (Number.isFinite(lastEvt) && evtAt <= lastEvt)) return null;
        } else if (raw === 'PAUSED') return null;
        const state = raw === 'PAUSED' ? 'paused' : review.status === 'approved' ? 'active' : 'in_review';
        const remote = { ...(isObj(row.remote) ? row.remote : {}), ...(Number.isFinite(evtAt) ? { switchEventAt: new Date(evtAt).toISOString() } : {}) };
        return { patch: { configured_status: raw, state, remote }, summary: raw === 'PAUSED' ? 'The campaign was paused in Ads Manager.' : 'The campaign was switched on in Ads Manager.' };
      }
      return null;
    }
    case 'ad_account.status_changed': {
      const current = String(evt.status?.current ?? '');
      if (!['active', 'restricted', 'disabled', 'closed'].includes(current)) return null;
      if (current === 'active') delete review.account;
      else review.account = current;
      return { patch: { review }, summary: current === 'active' ? `${P} says the ad account is active again.` : `${P} has ${current === 'closed' ? 'closed' : 'restricted'} this ad account.` };
    }
    default:
      return null;
  }
}

/**
 * fromWebhook(userId, zid, evt): apply one event to the user's matching rows. → how many rows changed.
 * deps: { db, audit, now }.
 */
export function createAdsWebhook({ db, audit, now = () => Date.now(), log = console }) {
  return async function fromWebhook(userId, zid, evt) {
    if (!isObj(evt) || !AD_EVENTS.includes(evt.event) || !db?.enabled) return 0;
    let rows;
    try {
      rows = await db.select('ad_campaigns', { user_id: userId, zernio_account_id: zid }, { limit: 500 });
    } catch (e) {
      // the ads tables aren't there yet (the migration not run): nothing launched, nothing to change
      if (e?.name === 'DbError' && e.code === 'NOT_SET_UP') {
        safeLog('ads_not_set_up', { where: 'webhook', hint: 'run supabase/migrations/20261108000000_ads_launch.sql' }, log);
        return 0;
      }
      throw e;
    }
    const hit = rowsFor(rows, evt);
    if (!hit.length) return 0;
    // our own last write on each campaign (the newest job): when it was, and whether it is still going or unconfirmed
    const jobs = await db.select('ad_jobs', { user_id: userId, campaign_id: ['in', hit.map((r) => r.id)] }, { select: 'campaign_id,state,requested_at,finished_at', order: 'requested_at.desc', limit: 1000 });
    const own = new Map();
    for (const j of jobs) {
      const o = own.get(j.campaign_id) ?? { at: 0, live: false };
      if (['queued', 'sending', 'unknown'].includes(j.state)) o.live = true;
      o.at = Math.max(o.at, Date.parse(j.finished_at ?? j.requested_at) || 0);
      own.set(j.campaign_id, o);
    }
    let changed = 0;
    for (const row of hit) {
      const c = changeFor(row, evt, now(), own.get(row.id) ?? { at: 0, live: false });
      if (!c) continue;
      await db.update('ad_campaigns', { id: row.id, user_id: userId }, { ...c.patch, updated_at: iso(now()) });
      await audit.append({ userId, tag: row.customer_tag, projectId: row.project_id, campaignId: row.id, actor: 'platform', action: 'review', summary: c.summary, outcome: 'info' });
      changed += 1;
    }
    return changed;
  };
}
