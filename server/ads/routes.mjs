// Launching and changing Meta and Google ad campaigns (spec §3, as adapted). Every route: sameOrigin, a signed-in
// user, then its rate-limit bucket; answers are { error, code } in our words, never Zernio's, Meta's or Google's.
//
//   GET  /api/ads/accounts?projectId=&platform=          {accounts, chosen?, connection, setup, canLaunch}
//   PUT  /api/ads/accounts/choice                         {projectId, platform, adAccountRef} → {chosen}
//   GET  /api/ads/targeting/search?projectId=&platform=&dimension=geo|interest&q=   {results}
//   POST /api/ads/launch/preview                          LaunchPreviewRequest → {review, reviewToken?}
//   POST /api/ads/launch                                  {reviewToken, confirm: true, clientRequestId} → {job, campaign}
//   GET  /api/ads/campaigns?projectId=                    {campaigns, limits}          (our database only)
//   POST /api/ads/campaigns/refresh                       {projectId} → {campaigns, limits, notes?}  (1 per 5 min)
//   POST /api/ads/campaigns/:id/change/preview            ChangePreviewRequest → {review, reviewToken?}
//   POST /api/ads/campaigns/:id/change                    {reviewToken, confirm: true, clientRequestId} → {job}
//   GET  /api/ads/campaigns/:id/review                    {review}
//   GET  /api/ads/jobs/:jobId                             {job, campaign}              (our database only)
//   POST /api/ads/jobs/:jobId/check                       {} → {job, campaign, note?}  (reads only; 1 per 30 s)
//   GET  /api/ads/audit?projectId=&campaignId=&before=    {entries, next?}
//   GET  /api/ads/live?platform=                          {live}  campaigns whose switch is (or may be) on
//   GET  /api/ads/admin/limits?days=30                    owner: {defaults, customers}
//   PUT  /api/ads/admin/limits/defaults | /:tag           owner: AdLimitsPatch → {limits}
//   POST /api/ads/admin/customers/:tag/pause-all/preview  owner: {campaigns, reviewToken?}
//   POST /api/ads/admin/customers/:tag/pause-all          owner: {reviewToken, confirm: true} → {jobs, skipped}
//
// Money rules this file keeps (spec §1): a write needs confirm: true and a review token for exactly what the customer
// saw (R2); it is rebuilt from the saved plan and refused before anything is sent when anything moved (PLAN_CHANGED,
// LIVE_CHANGED, LIMITS_CHANGED, ACCOUNT_CHANGED); the same clientRequestId answers the same job (a double press sends
// nothing); each write goes once, in the background, through server/ads/writes.mjs (R1); limits, the kill switch
// (ADS_LAUNCH_ENABLED), the owner's per-customer switch and the plan gate (gate.mjs) are checked before launches,
// resumes and increases only, never before pause or end (R7), which have their own ads-stop bucket.
// With ads off (no ZERNIO_API_KEY) every route answers 503; pause and end say to use Ads Manager.
//
// Module hooks for the wiring: fromWebhook (ad events), liveOn (the disconnect warning), beforeForget (account
// deletion: 409 ADS_LIVE unless acknowledged), onStart (the INTERRUPTED sweep), settled() (tests).

import crypto from 'node:crypto';
import { customerTag, errorBody, fail, IntegrationError, isUuid, notSetUp, safeLog } from '../integrations/common.mjs';
import { createLedger } from '../billing/ledger.mjs';
import { createMediaStore } from '../social/media.mjs';
import { createZernioAds } from './zernioAds.mjs';
import { createAdJobs, jobOut } from './jobs.mjs';
import { createAudit } from './audit.mjs';
import { createAdLimits, launchProblems, limitsToApi, parsePatch, rowToApi, switchesProblem, switchMayBeOn } from './limits.mjs';
import { canLaunchAds as defaultGate } from './gate.mjs';
import { ADS_PLATFORMS, CONNECTION_OF, FINAL_STATES, LIVE_JOB_STATES, PLATFORM_LABEL, STOP_ACTIONS } from './contracts.mjs';
import { beforeOf, loadPlan, mediaUrlFor, opsHash, planChange, previewChange, previewLaunch, readNow, rebuildLaunch, reviewNonceOf, sameBefore, signToken, spendLimitNotes, unreadNow, userHash, verifyToken } from './preview.mjs';
import { storedBody } from './build.mjs';
import { launchSummary, changeSummary, runChange, runLaunch, where } from './writes.mjs';
import { checkJob } from './reconcile.mjs';
import { accounts, campaignOut, campaigns, liveRowOut, liveRows, refresh, reviewOf, setChoice, targeting } from './reads.mjs';
import { createAdsWebhook } from './webhook.mjs';
import { loadProject } from '../social/publish.mjs';
import { messageFor } from './messages.mjs';
import { formatMoney, sumWhole } from './money.mjs';

const PREFIX = '/api/ads/';
const ID = /^[A-Za-z0-9._:-]{1,120}$/;
const TAG = /^cust_[0-9a-f]{24}$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const iso = (t) => new Date(t).toISOString();

/** A DbError in our words, with the migration for the owner. */
function fromDbError(e) {
  if (e?.name !== 'DbError') return e;
  if (e.code === 'NOT_SET_UP') return fail(503, 'NOT_SET_UP', messageFor('NOT_SET_UP'), {}, 'Run supabase/migrations/20261108000000_ads_launch.sql in Supabase.');
  return fail(503, 'UNAVAILABLE', messageFor('UNAVAILABLE'));
}

/** A missing ads table (the migration not run yet): read as "nothing launched", never a failure. */
const notSetUpTable = (e) => e?.name === 'DbError' && e.code === 'NOT_SET_UP';

/** deps: the integration deps (server/integrations/wiring.mjs); tests may add canLaunchAds, mediaStore, adTimeouts. */
export function createAdsRoutes(deps = {}) {
  const { auth, db, connections, storage = null, send, readJson, sameOrigin = () => true, corsHeaders = () => ({}), limit = () => false, env = process.env, fetch = globalThis.fetch, now = () => Date.now(), log = console } = deps;
  const zimpl = connections?.adsEnabled ? (connections.impl?.ads ?? null) : null;
  const ledger = createLedger({ db, now, log });
  const zads = createZernioAds({ client: zimpl?.client ?? null, ledger, storage, log, now, ...(deps.adTimeouts ? { timeouts: deps.adTimeouts } : {}) });
  const jobs = createAdJobs({ db, now });
  const audit = createAudit({ db, now, log });
  const limits = createAdLimits({ db, env, now });
  const gate = typeof deps.canLaunchAds === 'function' ? deps.canLaunchAds : defaultGate;
  const ctx = {
    db,
    env,
    now,
    log,
    zads,
    zimpl,
    jobs,
    audit,
    limits,
    /** ad accounts with a write in flight here (one at a time per ad account; pause and end never wait) */
    busy: new Set(),
    canLaunchAds: (userId) => gate(userId, { db, env, billing: deps.billing ?? null }),
    mediaStore: deps.mediaStore ?? createMediaStore({ env, fetch }),
    tagOf: (userId) => customerTag(userId, env),
  };
  const fromWebhook = createAdsWebhook({ db, audit, now, log });

  // Limits are checked and then acted on: one launch or increase per customer at a time in this process, and a
  // second check after the job row exists (other processes) that cancels the job before anything is sent.
  const userLocks = new Map();
  async function oneAtATime(userId, fn) {
    const prev = userLocks.get(userId) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => {
      release = r;
    });
    const chain = prev.then(() => mine);
    userLocks.set(userId, chain);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (userLocks.get(userId) === chain) userLocks.delete(userId);
    }
  }

  /** A begun job whose limits no longer hold: failed before anything was sent (and its launch row with it). */
  async function cancelBegun(who, jobRow, campaignId, entry, n, isLaunch) {
    await jobs.finish(who.id, jobRow.id, { state: 'failed', code: n.code, ref: { sent: false } });
    if (isLaunch) await db.update('ad_campaigns', { id: campaignId, user_id: who.id }, { state: 'failed', configured_status: null, updated_at: iso(now()) });
    const err = noteError(n);
    await refused(entry, err);
    return err;
  }
  const running = new Set();
  const track = (p) => {
    const q = Promise.resolve(p).catch((e) => safeLog('ads_background_error', { error: e?.name || 'Error' }, log));
    running.add(q);
    q.finally(() => running.delete(q));
    return q;
  };
  const reply = (req, res, status, body) => send(res, status, body, { ...corsHeaders(req), 'cache-control': 'no-store' });
  const adsOn = () => connections?.adsEnabled === true && !!zimpl && zads.enabled;

  async function user(req, res) {
    if (!sameOrigin(req)) {
      reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
      return null;
    }
    if (!auth?.enabled) {
      reply(req, res, 503, { error: 'Sign-in isn’t set up on this app.', code: 'NOT_SET_UP' });
      return null;
    }
    let who = null;
    try {
      who = await auth.identify(req);
    } catch {
      reply(req, res, 503, { error: 'Couldn’t check your sign-in. Try again shortly.', code: 'UNAVAILABLE' });
      return null;
    }
    if (!who?.id) {
      reply(req, res, 401, { error: 'Sign in first.', code: 'AUTH_REQUIRED' });
      return null;
    }
    return who;
  }

  const limited = (bucket, key, code = 'RATE_LIMITED', message = 'Too many requests. Try again in a minute.') => {
    if (limit(bucket, key)) throw fail(429, code, message);
  };

  async function body(req) {
    try {
      const b = await readJson(req, 64 * 1024);
      return isObj(b) ? b : {};
    } catch (e) {
      throw e?.status === 413 ? fail(413, 'BAD_REQUEST', 'Request too large.') : fail(400, 'BAD_REQUEST', 'That request isn’t valid JSON.');
    }
  }

  async function campaignRow(userId, id) {
    if (!isUuid(id)) throw fail(404, 'NOT_FOUND', 'That campaign isn’t in your account.');
    const rows = await db.select('ad_campaigns', { id, user_id: userId }, { limit: 1 });
    if (!rows[0]) throw fail(404, 'NOT_FOUND', 'That campaign isn’t in your account.');
    return rows[0];
  }

  /** A refused write, audited in our words (R9). Never throws. */
  async function refused(entry, e) {
    await audit.append({ ...entry, summary: `${entry.summary} refused: ${e?.message ?? messageFor('UNAVAILABLE')}`.slice(0, 500), outcome: 'refused' });
  }

  /** A plain note as the error a write answers with. */
  const noteError = (n, status = 409) => fail(status, n.code, n.message);

  // ───────────── the launch ─────────────

  /** The token as far as its MAC and user go, expired or not (a replay answers whatever its age). */
  const peekToken = (token, uid, kind) => {
    try {
      return verifyToken(env, token, { uid, kind, now: now(), allowExpired: true });
    } catch {
      return null;
    }
  };

  /** A job started with this clientRequestId answers only the review it was started for (else 409, nothing sent). */
  function sameReview(job, tok) {
    const rid = reviewNonceOf(tok);
    if (!rid || (job.review_nonce ?? null) !== rid) throw fail(409, 'REQUEST_MISMATCH', messageFor('REQUEST_MISMATCH'));
  }

  /** A launch already started with this clientRequestId: its job and campaign, nothing sent. */
  async function replay(who, job, tok) {
    sameReview(job, tok);
    const row = (await db.select('ad_campaigns', { id: job.campaign_id, user_id: who.id }, { limit: 1 }))[0];
    return { job: jobOut(job, row?.platform), ...(row ? { campaign: campaignOut(row, job) } : {}), replayed: true };
  }

  async function launch(who, b) {
    if (b.confirm !== true) throw fail(400, 'CONFIRM_REQUIRED', messageFor('CONFIRM_REQUIRED'));
    if (!isUuid(b.clientRequestId)) throw fail(400, 'BAD_REQUEST', 'Open the launch window again.');
    // a second press of the same confirm: the same job, nothing sent
    const same = await jobs.byClientRequest(who.id, b.clientRequestId);
    if (same) return replay(who, same, peekToken(b.reviewToken, who.id, 'launch'));
    const tok = verifyToken(env, b.reviewToken, { uid: who.id, kind: 'launch', now: now() });
    // a review made before reviews carried their one-write id: review it again
    if (!reviewNonceOf(tok)) throw fail(409, 'REVIEW_EXPIRED', messageFor('REVIEW_EXPIRED'));
    return oneAtATime(who.id, () => launchLocked(who, b, tok));
  }

  async function launchLocked(who, b, tok) {
    const tag = ctx.tagOf(who.id);
    const entry = { userId: who.id, tag, projectId: tok.projectId, actor: 'customer', action: 'launch', summary: `Launch on ${PLATFORM_LABEL[tok.platform]} (${tok.acct.name} …${tok.acct.idTail})` };
    let rebuilt;
    try {
      rebuilt = await rebuildLaunch(ctx, who, tok);
      const lim = await limits.effective(rebuilt.conn.tag);
      const sw = switchesProblem(lim, env);
      if (sw) throw fail(403, sw, messageFor(sw));
      if ((await ctx.canLaunchAds(who.id)) !== true) throw fail(403, 'PLAN_REQUIRED', messageFor('PLAN_REQUIRED'));
      if (lim.version !== tok.limitsVersion) throw fail(409, 'LIMITS_CHANGED', messageFor('LIMITS_CHANGED'));
      const committed = await limits.committed(who.id, tok.acct.currency);
      const launchesToday = await limits.countToday(who.id, ['launch']);
      const problems = launchProblems({ lim, currency: tok.acct.currency, daily: tok.picks.dailyBudget, days: tok.picks.durationDays, choice: tok.picks.status, committed: committed.daily, launchesToday });
      if (problems.length) throw noteError(problems[0]);
      if (ctx.busy.has(`${tok.platform}:${tok.acct.adAccountId}`)) throw fail(409, 'AD_ACCOUNT_BUSY', messageFor('AD_ACCOUNT_BUSY', { platform: tok.platform }));
    } catch (e) {
      // the same confirm pressed twice at once: the first press is already sending (busy), answer its job
      const raced = await jobs.byClientRequest(who.id, b.clientRequestId);
      if (raced) return replay(who, raced, tok);
      if (e instanceof IntegrationError) await refused(entry, e);
      throw e;
    }
    const { conn, built } = rebuilt;
    const lim = await limits.effective(rebuilt.conn.tag);
    const id = crypto.randomUUID();
    const row = {
      id,
      user_id: who.id,
      customer_tag: conn.tag,
      project_id: tok.projectId,
      plan_id: tok.planId,
      platform: tok.platform,
      zernio_account_id: conn.zid,
      ad_account_id: tok.acct.adAccountId,
      ad_account_name: tok.acct.name,
      currency: tok.acct.currency,
      timezone: tok.acct.timezone,
      name: built.names.name,
      launch_key: tok.launchKey,
      goal: built.goal,
      budget_level: tok.platform === 'google' ? 'campaign' : 'adset',
      daily_budget: tok.picks.dailyBudget,
      min_daily: Number.isFinite(tok.acct.minDaily) && tok.acct.minDaily > 0 ? tok.acct.minDaily : null,
      spend_cap: null,
      start_at: built.dates.startAt,
      end_at: built.dates.endAt,
      launched_as: tok.picks.status,
      state: 'launching',
      configured_status: tok.picks.status,
      review: {},
      remote: {},
      sent_body: storedBody(built.body, built.ads),
    };
    const job = { id: crypto.randomUUID(), user_id: who.id, kind: 'launch', actor: 'customer', client_request_id: b.clientRequestId, review_nonce: reviewNonceOf(tok), state: 'sending', request: { ...built.summary, claims: built.claims.filter((c) => c.confirmed).map((c) => c.phrase) }, before: null, provider_ref: {} };
    const summary = launchSummary(row);
    let got;
    try {
      got = await db.rpc('ads_begin_launch', { p: { campaign: row, job, audit: { user_id: who.id, customer_tag: conn.tag, project_id: tok.projectId, actor: 'customer', action: 'launch', summary: `${summary}: sending`, outcome: 'sending' } } });
    } catch (e) {
      // two presses of the same confirm at the same moment: the other one won, answer its job
      const raced = e?.name === 'DbError' && e.code === 'CONFLICT' ? await jobs.byClientRequest(who.id, b.clientRequestId) : null;
      if (raced) return replay(who, raced, tok);
      if (e?.name === 'DbError' && e.code === 'CONFLICT' && e.constraint === 'ad_campaigns_one_live') {
        const err = fail(409, 'ALREADY_LAUNCHED', messageFor('ALREADY_LAUNCHED', { platform: tok.platform }));
        await refused(entry, err);
        throw err;
      }
      if (e?.name === 'DbError' && e.code === 'CONFLICT' && e.constraint === 'ad_jobs_review_once') {
        const err = fail(409, 'REVIEW_USED', messageFor('REVIEW_USED'));
        await refused(entry, err);
        throw err;
      }
      throw e;
    }
    const begun = Array.isArray(got) ? got[0] : got;
    if (begun?.existing) {
      sameReview(begun.job, tok);
      return { job: jobOut(begun.job, tok.platform), ...(begun.campaign ? { campaign: campaignOut(begun.campaign, begun.job) } : {}), replayed: true };
    }
    const jobRow = begun?.job ?? job;
    const campRow = begun?.campaign ?? row;
    // the limits again, now that this launch's rows exist: a launch begun elsewhere at the same moment is counted
    const committedNow = await limits.committed(who.id, tok.acct.currency, { exclude: campRow.id });
    const launchesNow = await limits.countToday(who.id, ['launch'], { exclude: jobRow.id });
    const late = launchProblems({ lim, currency: tok.acct.currency, daily: tok.picks.dailyBudget, days: tok.picks.durationDays, choice: tok.picks.status, committed: committedNow.daily, launchesToday: launchesNow });
    if (late.length) throw await cancelBegun(who, jobRow, campRow.id, entry, late[0], true);
    // the one send, in the background; the app follows the job with GET /api/ads/jobs/:id
    track(runLaunch(ctx, { userId: who.id, tag: conn.tag, job: jobRow, row: campRow, body: built.body, spendCap: built.spendCap }));
    return { job: jobOut(jobRow, tok.platform), campaign: campaignOut(campRow, jobRow) };
  }

  // ───────────── a change ─────────────

  /** What the confirm showed, for the audit line and Check status (the image link swapped for its media id). */
  function requestOf(row, action, planned, params) {
    const ops = planned.ops.map(({ mediaId, ...o }) => (o.op === 'metaCreative' ? { ...o, creative: { ...o.creative, imageUrl: mediaId ? `media:${mediaId}` : '' } } : o));
    const out = { action, ops };
    if (action === 'budget') Object.assign(out, { from: planned.current.daily, to: params.dailyBudget });
    if (action === 'end_date') Object.assign(out, { from: planned.current.end, to: params.endDate, endAt: planned.newEndAt });
    if (action === 'resume') Object.assign(out, { daily: planned.current.daily });
    if (action === 'creative') Object.assign(out, { variant: planned.proposed?.ad?.variant ?? null });
    if (planned.newSpendCap != null) out.newSpendCap = planned.newSpendCap;
    return out;
  }

  async function change(who, id, b) {
    if (b.confirm !== true) throw fail(400, 'CONFIRM_REQUIRED', messageFor('CONFIRM_REQUIRED'));
    if (!isUuid(b.clientRequestId)) throw fail(400, 'BAD_REQUEST', 'Open the window again.');
    const row = await campaignRow(who.id, id);
    const same = await jobs.byClientRequest(who.id, b.clientRequestId);
    if (same) {
      if (same.campaign_id !== row.id) throw fail(409, 'BAD_REQUEST', 'Open the window again.');
      sameReview(same, peekToken(b.reviewToken, who.id, 'change'));
      return { job: jobOut(same, row.platform), replayed: true };
    }
    const tok = verifyToken(env, b.reviewToken, { uid: who.id, kind: 'change', now: now() });
    if (tok.cid !== row.id) throw fail(400, 'BAD_REQUEST', 'That review isn’t valid. Review it again.');
    if (!reviewNonceOf(tok)) throw fail(409, 'REVIEW_EXPIRED', messageFor('REVIEW_EXPIRED'));
    const stop = STOP_ACTIONS.includes(tok.action);
    // stopping never waits behind a launch or an increase (R7)
    return stop ? changeLocked(who, row, b, tok) : oneAtATime(who.id, () => changeLocked(who, row, b, tok));
  }

  async function changeLocked(who, row, b, tok) {
    const action = tok.action;
    const stop = STOP_ACTIONS.includes(action);
    // stopping has its own bucket: never throttled by launches and increases (R7)
    if (stop) limited('ads-stop', who.id);
    else limited('ads-write', who.id, 'RATE_LIMITED', messageFor('TOO_MANY_CHANGES'));
    if (!adsOn()) throw notSetUp('Add ZERNIO_API_KEY in Replit Secrets.', messageFor(stop ? 'NOT_SET_UP_STOP' : 'NOT_SET_UP'));
    const lctx = { userId: who.id, tag: row.customer_tag, projectId: row.project_id, platform: row.platform };
    const entry = { userId: who.id, tag: row.customer_tag, projectId: row.project_id, campaignId: row.id, actor: 'customer', action, summary: changeSummary(row, action, tok.params ?? {}) };
    let planned;
    try {
      if (FINAL_STATES.includes(row.state) && !stop) throw fail(409, 'CANT_CHANGE', messageFor('CANT_CHANGE'));
      if (await jobs.liveFor(who.id, row.id)) throw fail(409, 'JOB_LIVE', messageFor('JOB_LIVE'));
      // the live value(s) again, just before sending (R2): a change made in Ads Manager since the preview is refused
      let nowVals = await readNow(ctx, row, lctx, { withEndTime: action === 'end_date' });
      if (!nowVals.ok) {
        if (!stop) throw fail(nowVals.code === 'ADS_UNAVAILABLE' ? 503 : 409, nowVals.code, messageFor(nowVals.code, { platform: row.platform }));
        nowVals = unreadNow(row);
      }
      if (!stop && !sameBefore(tok.before, beforeOf(nowVals), row.currency)) throw fail(409, 'LIVE_CHANGED', messageFor('LIVE_CHANGED'));
      let plan = null;
      let project = null;
      if (action === 'creative') {
        project = await loadProject(db, who.id, row.project_id);
        plan = await loadPlan(db, who.id, row.project_id, row.plan_id).catch(() => null);
      }
      planned = planChange({ row, action, params: tok.params, nowVals, nowMs: tok.builtAt, plan, project, mediaUrl: mediaUrlFor(env, who.id, tok.builtAt) });
      if (!stop) {
        if (planned.blockers.length || opsHash(planned.ops) !== tok.opsHash) throw fail(409, 'PLAN_CHANGED', messageFor('PLAN_CHANGED'));
      } else {
        // pause and end: the campaign switch always goes off (Zernio skips it when it already is), nothing else. End
        // never trusts the switch the review saw: it may have been switched on since, in another tab or Ads Manager.
        planned.ops = [{ op: 'campaignStatus', status: 'paused' }];
      }
      if (tok.spend) {
        const lim = await limits.effective(row.customer_tag);
        const sw = switchesProblem(lim, env);
        if (sw) throw fail(403, sw, messageFor(sw));
        if ((await ctx.canLaunchAds(who.id)) !== true) throw fail(403, 'PLAN_REQUIRED', messageFor('PLAN_REQUIRED'));
        if (lim.version !== tok.limitsVersion) throw fail(409, 'LIMITS_CHANGED', messageFor('LIMITS_CHANGED'));
        const problems = await spendLimitNotes(ctx, who, row, planned, lim);
        if (problems.length) throw noteError(problems[0]);
      } else if (action === 'creative') {
        const lim = await limits.effective(row.customer_tag);
        if ((await limits.countToday(who.id, ['resume', 'budget', 'end_date', 'creative'])) >= lim.ads_changes_per_day) throw fail(409, 'LIMIT_CHANGES', messageFor('LIMIT_CHANGES', { limit: lim.ads_changes_per_day }));
      }
      if (!stop && ctx.busy.has(`${row.platform}:${row.ad_account_id}`)) throw fail(409, 'AD_ACCOUNT_BUSY', messageFor('AD_ACCOUNT_BUSY', { platform: row.platform }));
    } catch (e) {
      const raced = await jobs.byClientRequest(who.id, b.clientRequestId);
      if (raced && raced.campaign_id === row.id) {
        sameReview(raced, tok);
        return { job: jobOut(raced, row.platform), replayed: true };
      }
      if (e instanceof IntegrationError) await refused(entry, e);
      throw e;
    }
    const endAt = Date.parse(planned.ops.find((o) => o.op === 'endDate')?.value ?? '');
    planned.newEndAt = Number.isFinite(endAt) ? iso(endAt) : null;
    const request = requestOf(row, action, planned, tok.params);
    const job = { id: crypto.randomUUID(), user_id: who.id, campaign_id: row.id, kind: action, actor: 'customer', client_request_id: b.clientRequestId, review_nonce: reviewNonceOf(tok), state: 'sending', request, before: tok.before ?? null, provider_ref: {} };
    let got;
    try {
      got = await db.rpc('ads_begin_change', { p: { job, audit: { user_id: who.id, customer_tag: row.customer_tag, project_id: row.project_id, actor: 'customer', action, summary: `${changeSummary(row, action, request)}: sending`, outcome: 'sending' } } });
    } catch (e) {
      const raced = e?.name === 'DbError' && e.code === 'CONFLICT' ? await jobs.byClientRequest(who.id, b.clientRequestId) : null;
      if (raced) {
        sameReview(raced, tok);
        return { job: jobOut(raced, row.platform), replayed: true };
      }
      if (e?.name === 'DbError' && e.code === 'CONFLICT' && e.constraint === 'ad_jobs_one_live') {
        const err = fail(409, 'JOB_LIVE', messageFor('JOB_LIVE'));
        await refused(entry, err);
        throw err;
      }
      if (e?.name === 'DbError' && e.code === 'CONFLICT' && e.constraint === 'ad_jobs_review_once') {
        const err = fail(409, 'REVIEW_USED', messageFor('REVIEW_USED'));
        await refused(entry, err);
        throw err;
      }
      throw e;
    }
    const begun = Array.isArray(got) ? got[0] : got;
    if (begun?.existing) {
      sameReview(begun.job, tok);
      return { job: jobOut(begun.job, row.platform), replayed: true };
    }
    const jobRow = begun?.job ?? job;
    if (tok.spend) {
      // the limits again, now that this job exists: an increase begun elsewhere at the same moment is counted
      const lim = await limits.effective(row.customer_tag);
      const late = await spendLimitNotes(ctx, who, row, planned, lim, { excludeJob: jobRow.id });
      if (late.length) throw await cancelBegun(who, jobRow, row.id, entry, late[0], false);
    }
    track(runChange(ctx, { userId: who.id, tag: row.customer_tag, job: jobRow, row, ops: planned.ops, action, request }));
    return { job: jobOut(jobRow, row.platform) };
  }

  // ───────────── jobs ─────────────

  async function jobRead(who, jobId) {
    if (!isUuid(jobId)) throw fail(404, 'NOT_FOUND', 'That job isn’t in your account.');
    await jobs.sweep(who.id);
    const job = await jobs.byId(who.id, jobId);
    if (!job) throw fail(404, 'NOT_FOUND', 'That job isn’t in your account.');
    const row = (await db.select('ad_campaigns', { id: job.campaign_id, user_id: who.id }, { limit: 1 }))[0];
    return { job: jobOut(job, row?.platform), ...(row ? { campaign: campaignOut(row, job) } : {}) };
  }

  async function check(who, jobId) {
    if (!isUuid(jobId)) throw fail(404, 'NOT_FOUND', 'That job isn’t in your account.');
    await jobs.sweep(who.id);
    const out = await checkJob(ctx, who, jobId);
    if (!out) throw fail(404, 'NOT_FOUND', 'That job isn’t in your account.');
    return { job: jobOut(out.job, out.campaign.platform), campaign: campaignOut(out.campaign, out.job), ...(out.note ? { note: out.note } : {}) };
  }

  // ───────────── the owner ─────────────

  async function userOfTag(tag) {
    const rows = await db.select('billing_customers', { customer_tag: tag }, { select: 'customer_tag,user_id', limit: 1 });
    return rows[0]?.user_id ?? null;
  }

  async function adminLimits(url) {
    const days = Math.max(1, Math.min(90, Number.parseInt(url.searchParams.get('days') ?? '30', 10) || 30));
    const rows = await limits.rows();
    const defaults = rows.find((r) => r.customer_tag === '*') ?? null;
    const camps = await db.select('ad_campaigns', { state: ['in', ['launching', 'in_review', 'active', 'paused', 'rejected', 'with_issues', 'unknown']] }, { select: 'id,user_id,customer_tag,state,configured_status,daily_budget,currency', limit: 5000 });
    const live = new Set((await db.select('ad_jobs', { state: ['in', LIVE_JOB_STATES] }, { select: 'campaign_id', limit: 5000 })).map((j) => j.campaign_id));
    const recent = await db.select('ad_jobs', { requested_at: ['gte', iso(now() - days * 86_400_000)] }, { select: 'campaign_id,user_id,requested_at', order: 'requested_at.desc', limit: 5000 });
    const tags = new Set([...rows.filter((r) => r.customer_tag !== '*').map((r) => r.customer_tag), ...camps.map((c) => c.customer_tag)]);
    const lastByUser = new Map();
    for (const j of recent) if (!lastByUser.has(j.user_id)) lastByUser.set(j.user_id, j.requested_at);
    const customers = [];
    for (const tag of [...tags].sort()) {
      const own = rows.find((r) => r.customer_tag === tag) ?? null;
      const lim = await limits.effective(tag);
      const mine = camps.filter((c) => c.customer_tag === tag);
      const on = mine.filter((c) => switchMayBeOn(c, live));
      const userId = mine[0]?.user_id ?? null;
      customers.push({
        tag,
        own: rowToApi(own ?? {}),
        effective: limitsToApi(lim),
        committedDaily: sumWhole(on.filter((c) => c.currency === lim.ads_currency).map((c) => c.daily_budget), lim.ads_currency),
        liveCampaigns: on.length,
        otherCurrencies: [...new Set(on.map((c) => c.currency).filter((c) => c !== lim.ads_currency))],
        ...(userId && lastByUser.has(userId) ? { lastChangeAt: lastByUser.get(userId) } : {}),
        version: own?.version ?? 0,
      });
    }
    // Zernio's last team-level problem (plan, billing, add-on, key), for the owner only: customers saw our words
    let zernioAlert = null;
    try {
      const got = storage?.enabled === true ? await storage.get('zernio:alert') : null;
      const v = got?.value;
      if (v && typeof v.kind === 'string' && /^[a-z0-9_]{1,40}$/i.test(v.kind) && typeof v.at === 'string') zernioAlert = { kind: v.kind, at: v.at };
    } catch {
      /* no alert to show */
    }
    return { ...(zernioAlert ? { zernioAlert } : {}), defaults: rowToApi(defaults ?? {}), defaultsVersion: defaults?.version ?? 0, ceilings: { maxDaily: Number(env.ADS_HARD_MAX_DAILY) > 0 ? Number(env.ADS_HARD_MAX_DAILY) : 500, maxChange: Number(env.ADS_HARD_MAX_CHANGE) > 0 ? Number(env.ADS_HARD_MAX_CHANGE) : 200 }, launchEnabled: String(env.ADS_LAUNCH_ENABLED ?? '').trim() === '1', customers };
  }

  /** "The app owner set your daily ad limit to $100, …" */
  function limitsSentence(patch, currency) {
    const parts = [];
    if ('ads_enabled' in patch) parts.push(patch.ads_enabled === null ? 'launching ads back to the app default' : patch.ads_enabled ? 'launching ads on' : 'launching ads off');
    if ('ads_currency' in patch) parts.push(`your ad limit currency to ${patch.ads_currency ?? 'the default'}`);
    if ('ads_max_daily' in patch) parts.push(`your daily limit across campaigns to ${patch.ads_max_daily == null ? 'the default' : formatMoney(patch.ads_max_daily, currency)}`);
    if ('ads_max_change' in patch) parts.push(`the most one launch or increase can add to ${patch.ads_max_change == null ? 'the default' : `${formatMoney(patch.ads_max_change, currency)} a day`}`);
    if ('ads_max_campaign_total' in patch) parts.push(`the most one campaign can spend in total to ${patch.ads_max_campaign_total == null ? 'the default' : formatMoney(patch.ads_max_campaign_total, currency)}`);
    if ('ads_launches_per_day' in patch) parts.push(`launches a day to ${patch.ads_launches_per_day ?? 'the default'}`);
    if ('ads_changes_per_day' in patch) parts.push(`ad changes a day to ${patch.ads_changes_per_day ?? 'the default'}`);
    return `The app owner set ${parts.join(', ')}.`;
  }

  async function putLimits(who, tag, b) {
    const patch = parsePatch(b, env);
    if ('ads_currency' in patch) {
      // never while a campaign whose switch is on runs in another currency (its limits would stop applying)
      const camps = await db.select('ad_campaigns', { state: ['in', ['launching', 'in_review', 'active', 'paused', 'rejected', 'with_issues', 'unknown']], ...(tag === '*' ? {} : { customer_tag: tag }) }, { select: 'id,customer_tag,state,configured_status,currency', limit: 5000 });
      const live = new Set((await db.select('ad_jobs', { state: ['in', LIVE_JOB_STATES] }, { select: 'campaign_id', limit: 5000 })).map((j) => j.campaign_id));
      const overrides = tag === '*' ? new Set((await limits.rows()).filter((r) => r.ads_currency).map((r) => r.customer_tag)) : new Set();
      const next = patch.ads_currency ?? (await limits.effective('*')).ads_currency;
      const clash = camps.filter((c) => switchMayBeOn(c, live) && c.currency !== next && !(tag === '*' && overrides.has(c.customer_tag)));
      if (clash.length) throw fail(409, 'BAD_REQUEST', `${clash.length === 1 ? 'A campaign' : `${clash.length} campaigns`} in another currency ${clash.length === 1 ? 'is' : 'are'} still on. Pause ${clash.length === 1 ? 'it' : 'them'} first.`);
    }
    const saved = await limits.put(tag, patch);
    const lim = await limits.effective(tag === '*' ? '*' : tag);
    const sentence = limitsSentence(patch, lim.ads_currency);
    const targets = tag === '*' ? [...new Map((await db.select('ad_campaigns', {}, { select: 'user_id,customer_tag', limit: 5000 })).map((c) => [c.customer_tag, c.user_id])).entries()] : [[tag, await userOfTag(tag)]];
    for (const [t, userId] of targets) if (userId) await audit.append({ userId, tag: t, actor: 'owner', action: 'limits', summary: tag === '*' ? sentence.replace('The app owner set', 'The app owner set the defaults for everyone:') : sentence, outcome: 'info' });
    safeLog('ads_limits_changed', { scope: tag === '*' ? 'defaults' : 'customer', fields: Object.keys(patch) }, log);
    void who;
    return { limits: rowToApi(saved), version: saved.version };
  }

  async function pauseAllPreview(who, tag) {
    const userId = await userOfTag(tag);
    if (!userId) throw fail(404, 'NOT_FOUND', 'No such customer.');
    const rows = (await liveRows(ctx, userId)).filter((r) => r.remote?.campaignId);
    const out = rows.map(liveRowOut);
    if (!rows.length) return { campaigns: [] };
    const t = now();
    return { campaigns: out, reviewToken: signToken(env, { v: 1, kind: 'pauseall', uid: userHash(who.id), tag, ids: rows.map((r) => r.id), builtAt: t, exp: t + 10 * 60_000 }) };
  }

  async function pauseAll(who, tag, b) {
    if (b.confirm !== true) throw fail(400, 'CONFIRM_REQUIRED', messageFor('CONFIRM_REQUIRED'));
    const tok = verifyToken(env, b.reviewToken, { uid: who.id, kind: 'pauseall', now: now() });
    if (tok.tag !== tag) throw fail(400, 'BAD_REQUEST', 'That review isn’t valid. Review it again.');
    if (!adsOn()) throw notSetUp('Add ZERNIO_API_KEY in Replit Secrets.', messageFor('NOT_SET_UP_STOP'));
    const userId = await userOfTag(tag);
    if (!userId) throw fail(404, 'NOT_FOUND', 'No such customer.');
    const started = [];
    let skipped = 0;
    for (const id of Array.isArray(tok.ids) ? tok.ids.slice(0, 200) : []) {
      const row = (await db.select('ad_campaigns', { id, user_id: userId }, { limit: 1 }))[0];
      if (!row || FINAL_STATES.includes(row.state) || !row.remote?.campaignId || (await jobs.liveFor(userId, row.id))) {
        skipped += 1;
        continue;
      }
      const ops = [{ op: 'campaignStatus', status: 'paused' }];
      const job = { id: crypto.randomUUID(), user_id: userId, campaign_id: row.id, kind: 'pause', actor: 'owner', client_request_id: crypto.randomUUID(), state: 'sending', request: { action: 'pause', ops }, before: null, provider_ref: {} };
      try {
        const got = await db.rpc('ads_begin_change', { p: { job, audit: { user_id: userId, customer_tag: row.customer_tag, project_id: row.project_id, actor: 'owner', action: 'pause', summary: `Paused by the app owner on ${where(row)}: sending`, outcome: 'sending' } } });
        const begun = Array.isArray(got) ? got[0] : got;
        started.push({ row, job: begun?.job ?? job, ops });
      } catch (e) {
        if (e?.name === 'DbError' && e.code === 'CONFLICT') skipped += 1;
        else throw e;
      }
    }
    // one pause per campaign, one after another, never retried
    track(
      (async () => {
        for (const s of started) await runChange(ctx, { userId, tag: s.row.customer_tag, job: s.job, row: s.row, ops: s.ops, action: 'pause', request: { action: 'pause', ops: s.ops }, actor: 'owner' });
      })(),
    );
    return { jobs: started.map((s) => jobOut(s.job, s.row.platform)), skipped };
  }

  // ───────────── the router ─────────────

  async function route(req, res, url, who) {
    const p = url.pathname;
    const m = req.method;
    const q = url.searchParams;
    if (!db?.enabled) throw notSetUp('Supabase isn’t set up on this server (SUPABASE_URL and SUPABASE_SECRET_KEY).', messageFor('NOT_SET_UP'));

    // the owner's pages and the live list read our database only: they work with ads off
    if (p.startsWith(`${PREFIX}admin/`)) {
      if (who.isAdmin !== true) throw fail(403, 'FORBIDDEN', 'Only the app owner can do this.');
      if (p === `${PREFIX}admin/limits` && m === 'GET') return reply(req, res, 200, await adminLimits(url));
      let a = /^\/api\/ads\/admin\/limits\/([^/]+)$/.exec(p);
      if (a && m === 'PUT') {
        const tag = a[1] === 'defaults' ? '*' : a[1];
        if (tag !== '*' && !TAG.test(tag)) throw fail(404, 'NOT_FOUND', 'No such customer.');
        return reply(req, res, 200, await putLimits(who, tag, await body(req)));
      }
      a = /^\/api\/ads\/admin\/customers\/([^/]+)\/pause-all(\/preview)?$/.exec(p);
      if (a && m === 'POST') {
        if (!TAG.test(a[1])) throw fail(404, 'NOT_FOUND', 'No such customer.');
        limited('ads-stop', who.id);
        return reply(req, res, 200, a[2] ? await pauseAllPreview(who, a[1]) : await pauseAll(who, a[1], await body(req)));
      }
      throw fail(404, 'NOT_FOUND', 'Not found.');
    }
    if (p === `${PREFIX}live` && m === 'GET') {
      limited('ads-read', who.id);
      const platform = ADS_PLATFORMS.includes(q.get('platform')) ? q.get('platform') : null;
      return reply(req, res, 200, { live: (await liveRows(ctx, who.id, platform)).map(liveRowOut) });
    }

    // a change's route decides its own bucket and "ads off" words once it knows the action (pause/end never wait)
    let c = /^\/api\/ads\/campaigns\/([^/]+)\/change$/.exec(p);
    if (c && m === 'POST') return reply(req, res, 200, await change(who, c[1], await body(req)));

    const checkRoute = /^\/api\/ads\/jobs\/[^/]+\/check$/.test(p);
    if (!adsOn()) throw notSetUp('Add ZERNIO_API_KEY in Replit Secrets.', messageFor(checkRoute ? 'NOT_SET_UP_STOP' : 'NOT_SET_UP'));

    if (p === `${PREFIX}accounts` && m === 'GET') {
      limited('ads-read', who.id);
      return reply(req, res, 200, await accounts(ctx, who, q));
    }
    if (p === `${PREFIX}accounts/choice` && m === 'PUT') {
      limited('ads-read', who.id);
      return reply(req, res, 200, await setChoice(ctx, who, await body(req)));
    }
    if (p === `${PREFIX}targeting/search` && m === 'GET') {
      limited('ads-read', who.id);
      return reply(req, res, 200, await targeting(ctx, who, q));
    }
    if (p === `${PREFIX}launch/preview` && m === 'POST') {
      limited('ads-preview', who.id);
      return reply(req, res, 200, await previewLaunch(ctx, who, await body(req)));
    }
    if (p === `${PREFIX}launch` && m === 'POST') {
      limited('ads-write', who.id, 'RATE_LIMITED', messageFor('TOO_MANY_CHANGES'));
      return reply(req, res, 200, await launch(who, await body(req)));
    }
    if (p === `${PREFIX}campaigns` && m === 'GET') {
      limited('ads-read', who.id);
      return reply(req, res, 200, await campaigns(ctx, who, q.get('projectId')));
    }
    if (p === `${PREFIX}campaigns/refresh` && m === 'POST') {
      const b = await body(req);
      const projectId = typeof b.projectId === 'string' && ID.test(b.projectId) ? b.projectId : null;
      if (!projectId) throw fail(400, 'BAD_REQUEST', 'Which business?');
      await loadProject(db, who.id, projectId);
      limited('ads-refresh', `${who.id}:${projectId}`, 'REFRESH_TOO_SOON', 'Updated a moment ago. Try again in a few minutes.');
      return reply(req, res, 200, await refresh(ctx, who, projectId));
    }
    c = /^\/api\/ads\/campaigns\/([^/]+)\/change\/preview$/.exec(p);
    if (c && m === 'POST') {
      const b = await body(req);
      limited(STOP_ACTIONS.includes(b.action) ? 'ads-stop' : 'ads-preview', who.id);
      const row = await campaignRow(who.id, c[1]);
      return reply(req, res, 200, await previewChange(ctx, who, row, b));
    }
    c = /^\/api\/ads\/campaigns\/([^/]+)\/review$/.exec(p);
    if (c && m === 'GET') {
      limited('ads-read', who.id);
      return reply(req, res, 200, await reviewOf(ctx, who, await campaignRow(who.id, c[1])));
    }
    c = /^\/api\/ads\/jobs\/([^/]+)$/.exec(p);
    if (c && m === 'GET') {
      limited('ads-read', who.id);
      return reply(req, res, 200, await jobRead(who, c[1]));
    }
    c = /^\/api\/ads\/jobs\/([^/]+)\/check$/.exec(p);
    if (c && m === 'POST') {
      limited('ads-check', who.id);
      return reply(req, res, 200, await check(who, c[1]));
    }
    if (p === `${PREFIX}audit` && m === 'GET') {
      limited('ads-read', who.id);
      const projectId = q.get('projectId');
      const campaignId = q.get('campaignId');
      const before = Number.parseInt(q.get('before') ?? '', 10);
      if (projectId && !ID.test(projectId)) throw fail(400, 'BAD_REQUEST', 'Which business?');
      if (campaignId && !isUuid(campaignId)) throw fail(404, 'NOT_FOUND', 'That campaign isn’t in your account.');
      return reply(req, res, 200, await audit.list(who.id, { projectId: projectId || undefined, campaignId: campaignId || undefined, before: Number.isInteger(before) ? before : undefined }));
    }
    throw fail(404, 'NOT_FOUND', 'Not found.');
  }

  /** The user's campaigns whose switch is (or may be) on, for a connection's platform ('meta_ads'|'google_ads'). */
  async function liveOn(userId, connectionPlatform) {
    if (!db?.enabled) return [];
    const platform = Object.entries(CONNECTION_OF).find(([, v]) => v === connectionPlatform)?.[0];
    if (!platform) return [];
    try {
      return (await liveRows(ctx, userId, platform)).map(liveRowOut);
    } catch (e) {
      if (!notSetUpTable(e)) throw e;
      safeLog('ads_not_set_up', { where: 'disconnect', hint: 'run supabase/migrations/20261108000000_ads_launch.sql' }, log);
      return [];
    }
  }

  return {
    async handle(req, res, url) {
      if (!url.pathname.startsWith(PREFIX)) return false;
      const who = await user(req, res);
      if (!who) return true;
      try {
        await route(req, res, url, who);
      } catch (e) {
        if (e?.name === 'DbError') safeLog('ads_db_failed', { code: e.code }, log);
        const { status, body: out } = errorBody(fromDbError(e), who);
        if (!res.headersSent) reply(req, res, status, out);
      }
      return true;
    },
    fromWebhook,
    liveOn,
    /**
     * Before an account is deleted (and before its Zernio connections go, after which nothing could be paused):
     * 409 ADS_LIVE with the list while any campaign's switch is (or may be) on, unless the customer acknowledged it.
     */
    async beforeForget(userId, { ackLiveAds = false } = {}) {
      if (!db?.enabled) return;
      let rows;
      try {
        rows = await liveRows(ctx, userId);
      } catch (e) {
        // the ads tables aren't there yet: nothing was ever launched
        if (!notSetUpTable(e)) throw e;
        safeLog('ads_not_set_up', { where: 'account_delete', hint: 'run supabase/migrations/20261108000000_ads_launch.sql' }, log);
        return;
      }
      if (!rows.length) return;
      if (!ackLiveAds) throw fail(409, 'ADS_LIVE', 'These campaigns are still on and will keep spending on your own Meta or Google account after you delete this app account. Pause or end them first, or confirm that you’ll manage them in Ads Manager.', { live: rows.map(liveRowOut) });
      await audit.append({ userId, tag: rows[0].customer_tag, actor: 'customer', action: 'account', summary: `Deleted the app account with ${rows.length} campaign${rows.length === 1 ? '' : 's'} still on; ${rows.length === 1 ? 'it keeps' : 'they keep'} running in Ads Manager.`, outcome: 'info' });
      safeLog('ads_account_deleted_with_live', { count: rows.length }, log);
    },
    /** Startup: `sending` jobs a restart left behind become `unknown` INTERRUPTED (never re-sent). */
    async onStart() {
      if (db?.enabled) await jobs.sweep();
    },
    /** server/cron: the same sweep once an hour, each hourly tick (`sending` → `unknown`; never re-sent). */
    cronJobs: () => (db?.enabled ? [{ name: 'ads-sweep', everyMs: 60 * 60_000, run: async () => ({ interrupted: await jobs.sweep() }) }] : []),
    // rows go with the account (on delete cascade); nothing is held anywhere else
    async forgetUser() {},
    async unforgetUser() {},
    async userDeleted() {},
    /** tests: wait for the background sends */
    async settled() {
      while (running.size) await Promise.all([...running]);
    },
    ctx,
  };
}
