// Preview → review token → one write (spec §3.3). Previews only read; nothing is stored between a preview and its
// write: the review token carries what the customer saw (their picks, the hashes, the live values read for a change),
// MAC'd with ADS_REVIEW_SECRET (or an HKDF of CUSTOMER_TAG_SECRET labelled 'ads-review'), for 10 minutes, bound to
// the user. The write route rebuilds the request from the saved plan with the token's builtAt as "now", so the body
// is byte-identical and its hash matches, or the write is refused (PLAN_CHANGED) before anything is sent.
//
// Ids the browser holds are opaque: an ad account is adacct_<32 hex> (an HMAC of the connection and the ad account,
// resolved only against a fresh list of that user's ad accounts), a place or interest is a signed tref_… bound to the
// user and platform. The Zernio connection id never leaves the server (the token keeps a hash of it only).

import crypto from 'node:crypto';
import { fail, IntegrationError, isUuid, notSetUp, sha256 } from '../integrations/common.mjs';
import { loadProject } from '../social/publish.mjs';
import { canMakePublicLinks, publicMediaUrl } from '../social/media.mjs';
import { ADS_PLATFORMS, CONNECTION_OF, LAUNCH_CHOICES, idTailOf } from './contracts.mjs';
import { buildLaunch, canonical, daysBetween, hashOf, isYmd, metaCreativeFor, metaSpendCap, searchTextFor, todayIn, validTimeZone, withOffset } from './build.mjs';
import { findOwn } from './live.mjs';
import { cut, messageFor, note, safeFixUrl } from './messages.mjs';
import { compareWhole, isCurrency, sumWhole, timesDays, toMinor, fromMinor, zernioWhole, dailyProblem } from './money.mjs';
import { increaseProblems, launchProblems, switchesProblem } from './limits.mjs';

export const REVIEW_TTL_MS = 10 * 60_000;
const ID = /^[A-Za-z0-9._:-]{1,120}$/;
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const h16 = (v) => sha256(String(v)).slice(0, 16);
const iso = (t) => new Date(t).toISOString();

// ───────────── the review token and opaque refs ─────────────

function reviewKey(env) {
  const own = String(env?.ADS_REVIEW_SECRET || '');
  if (own.length >= 16) return Buffer.from(own);
  const tag = String(env?.CUSTOMER_TAG_SECRET || '');
  if (tag.length >= 16) return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(tag), Buffer.alloc(0), Buffer.from('ads-review'), 32));
  throw notSetUp('Add ADS_REVIEW_SECRET (32+ random bytes) in Replit Secrets (or CUSTOMER_TAG_SECRET).', messageFor('NOT_SET_UP'));
}
const mac = (env, data) => b64url(crypto.createHmac('sha256', reviewKey(env)).update(data).digest());
function sameMac(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** A review token: base64url(JSON payload) + '.' + its HMAC. */
export function signToken(env, payload) {
  const p = b64url(JSON.stringify(payload));
  return `${p}.${mac(env, p)}`;
}

/** The token's payload when its MAC, user, kind and expiry are right; else a 400 or 409 (never sent anything). */
export function verifyToken(env, token, { uid, kind, now, allowExpired = false }) {
  const m = /^([A-Za-z0-9_-]{10,16000})\.([A-Za-z0-9_-]{43})$/.exec(String(token ?? ''));
  if (!m || !sameMac(mac(env, m[1]), m[2])) throw fail(400, 'BAD_REQUEST', 'That review isn’t valid. Review it again.');
  let p;
  try {
    p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
  } catch {
    throw fail(400, 'BAD_REQUEST', 'That review isn’t valid. Review it again.');
  }
  if (!isObj(p) || p.v !== 1 || p.kind !== kind || p.uid !== h16(uid)) throw fail(400, 'BAD_REQUEST', 'That review isn’t valid. Review it again.');
  if (!allowExpired && (!Number.isFinite(p.exp) || p.exp <= now)) throw fail(409, 'REVIEW_EXPIRED', messageFor('REVIEW_EXPIRED'));
  return p;
}
export const userHash = h16;

/** The one-write id of a review (each token can start one write, ever: ad_jobs_review_once). */
export const reviewNonceOf = (tok) => (typeof tok?.rid === 'string' && /^[0-9a-f-]{36}$/.test(tok.rid) ? tok.rid : null);

/** A place or interest the customer can pick: signed, bound to the user, platform and dimension. */
export function targetRef(env, uid, platform, dim, item) {
  const p = b64url(JSON.stringify({ u: h16(uid), p: platform, d: dim, k: String(item.key), n: cut(item.name, 80), t: item.kind, c: item.cc ?? null }));
  return `tref_${p}.${mac(env, p)}`;
}
export function readTargetRef(env, uid, platform, dim, ref) {
  const m = /^tref_([A-Za-z0-9_-]{10,2000})\.([A-Za-z0-9_-]{43})$/.exec(String(ref ?? ''));
  if (!m || !sameMac(mac(env, m[1]), m[2])) return null;
  try {
    const p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    if (p.u !== h16(uid) || p.p !== platform || p.d !== dim) return null;
    return { key: String(p.k), name: String(p.n ?? ''), kind: String(p.t ?? 'other'), cc: p.c ?? null };
  } catch {
    return null;
  }
}

/** adacct_<32 hex>: the same construction as connections/zernio.mjs handleOf, over the connection and ad account. */
export function adAccountRef(env, zid, adAccountId) {
  const secret = String(env?.CUSTOMER_TAG_SECRET || '').length >= 16 ? String(env.CUSTOMER_TAG_SECRET) : reviewKey(env);
  return `adacct_${crypto.createHmac('sha256', secret).update(`ads:${zid}:${adAccountId}`).digest('hex').slice(0, 32)}`;
}

// ───────────── ad accounts inside the business's connection ─────────────

const META_STATUS = { 1: null, 3: 'warn:ACCOUNT_UNSETTLED', 9: 'warn:ACCOUNT_GRACE', 2: 'ACCOUNT_DISABLED', 7: 'ACCOUNT_RISK_REVIEW', 8: 'ACCOUNT_SETTLEMENT', 100: 'ACCOUNT_CLOSED', 101: 'ACCOUNT_CLOSED' };

/** The ad accounts of a connection, normalized. → { ok: true, accounts } | { ok: false, code } */
export async function listAccounts(ctx, zid, platform, lctx) {
  const got = await ctx.zads.reads.listAdAccounts(zid, lctx);
  if (!got.ok) return { ok: false, code: got.code };
  const raw = (Array.isArray(got.body.accounts) ? got.body.accounts : []).filter(isObj);
  let accounts;
  if (platform === 'meta') {
    accounts = raw
      .filter((a) => /^act_\d{1,30}$/.test(String(a.id ?? '')))
      .map((a) => {
        const status = Number(a.accountStatus);
        const s = Object.hasOwn(META_STATUS, status) ? META_STATUS[status] : 'ACCOUNT_UNUSABLE';
        const currency = isCurrency(a.currency) ? a.currency : null;
        const timezone = validTimeZone(a.timezoneName) ? a.timezoneName : null;
        let reason = s && !s.startsWith('warn:') ? s : null;
        if (!reason && a.selectable === false) reason = 'ACCOUNT_UNUSABLE';
        if (!reason && (!currency || !timezone)) reason = 'ACCOUNT_UNUSABLE';
        return { adAccountId: String(a.id), name: cut(a.name, 80) || 'Ad account', idTail: idTailOf(a.id), currency, timezone, minDaily: zernioWhole(a.minimumDailyBudget) ?? 1, status, billingStatus: ['ok', 'missing', 'unknown'].includes(a.billingStatus) ? a.billingStatus : 'unknown', usable: !reason, ...(reason ? { reason } : {}), ...(s?.startsWith('warn:') ? { warn: s.slice(5) } : {}) };
      });
  } else {
    const h = await ctx.zads.reads.hierarchy(zid, lctx);
    const nodes = [];
    const walk = (list) => {
      for (const n of Array.isArray(list) ? list : []) {
        if (!isObj(n)) continue;
        nodes.push(n);
        walk(n.clients);
      }
    };
    if (h.ok) walk(h.body.roots);
    accounts = raw
      .filter((a) => /^\d{6,20}$/.test(String(a.id ?? '')))
      .map((a) => {
        const n = nodes.find((x) => String(x.customerId) === String(a.id)) ?? {};
        const currency = isCurrency(n.currency) ? n.currency : isCurrency(a.currency) ? a.currency : null;
        const timezone = validTimeZone(n.timeZone) ? n.timeZone : null;
        let reason = null;
        if (n.manager === true) reason = 'GOOGLE_MANAGER';
        else if (n.testAccount === true) reason = 'GOOGLE_TEST_ACCOUNT';
        else if (n.status && n.status !== 'ENABLED') reason = 'ACCOUNT_CLOSED';
        else if (!timezone || !currency) reason = 'GOOGLE_NO_TIMEZONE';
        return { adAccountId: String(a.id), name: cut(n.name ?? a.name, 80) || 'Google Ads account', idTail: idTailOf(a.id), currency, timezone, minDaily: 1, status: n.status ?? null, usable: !reason, ...(reason ? { reason } : {}) };
      });
  }
  return { ok: true, accounts };
}

/** The business's connection for a platform (server-resolved), or the plain refusal as a setup check. */
export async function connectionFor(ctx, who, projectId, platform) {
  try {
    const got = await ctx.zimpl.adsAccountFor(who.id, CONNECTION_OF[platform], projectId);
    return { ok: true, ...got };
  } catch (e) {
    if (e instanceof IntegrationError && (e.code === 'NOT_CONNECTED' || e.code === 'NEEDS_RECONNECT')) return { ok: false, code: e.code, message: e.message };
    throw e;
  }
}

/** The stored choice of ad account for the business, when it is for the business's current connection. */
export async function choiceFor(ctx, userId, projectId, platform, zid) {
  const rows = await ctx.db.select('ad_account_choices', { user_id: userId, project_id: projectId, platform }, { limit: 1 });
  const row = rows[0] ?? null;
  if (!row || row.zernio_account_id !== zid) return { row: null, stale: !!row };
  return { row, stale: false };
}

export const accountOption = (env, zid, platform, a) => ({
  ref: adAccountRef(env, zid, a.adAccountId),
  platform,
  name: a.name,
  idTail: a.idTail,
  currency: a.currency ?? '',
  timezone: a.timezone ?? '',
  usable: a.usable,
  ...(a.reason ? { reason: a.reason, message: messageFor(a.reason, { platform }) } : {}),
  ...(Number.isFinite(a.minDaily) ? { minDailyBudget: a.minDaily } : {}),
});

/** The setup checklist for the chosen ad account (§12). Reads health (Meta) or billing (Google). */
export async function setupChecks(ctx, zid, platform, account, lctx) {
  const checks = [{ id: 'connected', state: 'ok', message: messageFor('CONNECTED_OK', { platform }) }];
  if (!account) {
    checks.push({ id: 'account', state: 'missing', code: 'ACCOUNT_NOT_CHOSEN', message: messageFor('ACCOUNT_NOT_CHOSEN') });
    return checks;
  }
  const accountCheck = account.reason ? { id: 'account', state: 'missing', code: account.reason, message: messageFor(account.reason, { platform }) } : account.warn ? { id: 'account', state: 'warn', code: account.warn, message: messageFor(account.warn) } : { id: 'account', state: 'ok', message: messageFor('ACCOUNT_OK') };
  checks.push(accountCheck);
  if (platform === 'meta') {
    const hres = await ctx.zads.reads.health(zid, account.adAccountId, lctx);
    if (!hres.ok) {
      checks.push({ id: 'health', state: 'unknown', code: hres.code === 'ADS_UNAVAILABLE' ? 'ADS_UNAVAILABLE' : 'PAYMENT_UNKNOWN', message: hres.code === 'ADS_UNAVAILABLE' ? messageFor('ADS_UNAVAILABLE') : 'We couldn’t check this ad account just now. Try again shortly.' });
      return checks;
    }
    const hb = hres.body;
    const list = (Array.isArray(hb.checks) ? hb.checks : []).filter(isObj);
    const byId = (id) => list.find((c) => c.id === id);
    const pay = byId('payment');
    const fixOf = (c) => safeFixUrl(c?.fix?.url);
    if (pay?.status === 'ok' && account.billingStatus !== 'missing') checks.push({ id: 'payment', state: 'ok', message: 'A payment method is on the ad account.' });
    else if (pay?.status === 'missing' || pay?.status === 'error' || account.billingStatus === 'missing') checks.push({ id: 'payment', state: 'missing', code: 'PAYMENT_REQUIRED', message: messageFor('PAYMENT_REQUIRED'), ...(fixOf(pay) ? { fixUrl: fixOf(pay) } : {}) });
    else checks.push({ id: 'payment', state: 'unknown', code: 'PAYMENT_UNKNOWN', message: messageFor('PAYMENT_UNKNOWN') });
    const page = byId('page');
    checks.push(page && page.status !== 'ok' ? { id: 'page', state: 'missing', code: 'NO_PAGE', message: messageFor('NO_PAGE') } : { id: 'page', state: 'ok', message: messageFor('PAGE_OK') });
    const ig = byId('instagram');
    checks.push(ig && ig.status !== 'ok' ? { id: 'instagram', state: 'warn', code: 'NO_INSTAGRAM', message: messageFor('NO_INSTAGRAM') } : { id: 'instagram', state: 'ok', message: messageFor('INSTAGRAM_OK') });
    const cap = byId('spend_cap');
    if ((cap && cap.status !== 'ok') || (hb.status === 'blocked' && hb.ready === true)) checks.push({ id: 'spend_cap', state: 'warn', code: 'ACCOUNT_SPEND_CAP', message: messageFor('ACCOUNT_SPEND_CAP') });
    if (hb.ready === false) {
      const first = (Array.isArray(hb.blockers) ? hb.blockers : []).find(isObj);
      const code = (first?.code && { ad_account_payment_required: 'PAYMENT_REQUIRED', ad_account_policy_not_accepted: 'POLICY_NOT_ACCEPTED', meta_security_check_required: 'SECURITY_CHECK', ad_account_unusable: 'ACTION_BLOCKED', meta_action_blocked: 'ACTION_BLOCKED', meta_ad_consent_required: 'AD_CONSENT', instagram_account_restricted: 'IG_RESTRICTED', verified_advertiser_required: 'VERIFIED_ADVERTISER', linked_account_required: 'NO_PAGE' }[first.code]) || 'ACTION_BLOCKED';
      if (!checks.some((c) => c.code === code && c.state === 'missing')) checks.push({ id: 'ready', state: 'missing', code, message: messageFor(code), ...(fixOf(first) ? { fixUrl: fixOf(first) } : {}) });
    }
  } else {
    const b = await ctx.zads.reads.billing(zid, account.adAccountId, lctx);
    const setups = b.ok && Array.isArray(b.body.billingSetups) ? b.body.billingSetups.filter(isObj) : [];
    const stale = b.ok && b.body.stale === true;
    if (setups.some((s) => s.status === 'APPROVED') && !stale) checks.push({ id: 'billing', state: 'ok', message: messageFor('GOOGLE_BILLING_OK') });
    else if (setups.some((s) => s.status === 'PENDING' || s.status === 'APPROVED_HELD') && !stale) checks.push({ id: 'billing', state: 'warn', code: 'GOOGLE_BILLING_PENDING', message: messageFor('GOOGLE_BILLING_PENDING'), fixUrl: 'https://ads.google.com/aw/billing' });
    else checks.push({ id: 'billing', state: 'unknown', code: 'GOOGLE_BILLING_UNKNOWN', message: messageFor('GOOGLE_BILLING_UNKNOWN'), fixUrl: 'https://ads.google.com/aw/billing' });
    checks.push({ id: 'review', state: 'ok', message: messageFor('GOOGLE_REVIEW') });
  }
  return checks;
}

// ───────────── the launch ─────────────

/** The launch request's fields, checked. → { projectId, planId, platform, picksIn } or 400. */
export function readLaunchRequest(body) {
  const b = isObj(body) ? body : {};
  const projectId = typeof b.projectId === 'string' && ID.test(b.projectId) ? b.projectId : null;
  const planId = typeof b.planId === 'string' && ID.test(b.planId) ? b.planId : null;
  if (!projectId || !planId) throw fail(400, 'BAD_REQUEST', 'Which plan?');
  if (!ADS_PLATFORMS.includes(b.platform)) throw fail(400, 'BAD_REQUEST', 'Launch on Meta or Google.');
  if (!LAUNCH_CHOICES.includes(b.status)) throw fail(400, 'BAD_REQUEST', 'Choose Paused or Active.');
  const strings = (v, max, len = 2100) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= len).slice(0, max) : []);
  return {
    projectId,
    planId,
    platform: b.platform,
    picksIn: {
      status: b.status,
      startDate: b.startDate == null || b.startDate === '' ? null : String(b.startDate),
      startTime: typeof b.startTime === 'string' && b.startTime !== 'asap' ? b.startTime : null,
      dailyBudget: typeof b.dailyBudget === 'number' ? b.dailyBudget : Number.NaN,
      durationDays: typeof b.durationDays === 'number' ? b.durationDays : Number.NaN,
      locations: strings(b.locations, 25),
      radiusMi: typeof b.radiusMi === 'number' && Number.isFinite(b.radiusMi) ? b.radiusMi : null,
      interests: strings(b.interests, 25),
      creativeIds: strings(b.creativeIds, 3, 120),
      languages: strings(b.languages, 5, 5),
      claimsConfirmed: strings(b.claimsConfirmed, 40, 80),
      specialCategory: b.specialCategory === 'yes' || b.specialCategory === 'none' ? b.specialCategory : null,
    },
  };
}

/** The user's saved plan (user_docs kind 'ad') in that business, for that platform; 404 otherwise. */
export async function loadPlan(db, userId, projectId, planId) {
  const rows = await db.select('user_docs', { user_id: userId, kind: 'ad', id: planId }, { select: 'id,data', limit: 1 });
  const plan = rows[0]?.data;
  if (!isObj(plan) || plan.projectId !== projectId) throw fail(404, 'NOT_FOUND', 'That plan isn’t in your account.');
  return plan;
}

/** Image links for Meta, minted with builtAt (the link's expiry is part of the body, so the hash holds). */
export function mediaUrlFor(env, userId, builtAt) {
  return (creative) => {
    if (!canMakePublicLinks(env)) throw Object.assign(new Error('no media links'), { code: 'NO_IMAGE_LINKS' });
    const m = creative.media;
    const type = typeof m?.type === 'string' && /^image\/(jpeg|png)$/.test(m.type) ? m.type : 'image/jpeg';
    return { url: publicMediaUrl(env, { userId, mediaId: m.mediaId, kind: 'image', type }, builtAt), madeBy: m.madeBy === 'ai' ? 'ai' : 'owner' };
  };
}

/** The LaunchReview the confirm shows (our words and numbers only). */
export function launchReview({ platform, account, built, committedAfter, lim, setup = [] }) {
  return {
    platform,
    account: { name: account.name, idTail: account.idTail, currency: account.currency, timezone: account.timezone },
    status: built.summary.status,
    daily: built.summary.daily,
    days: built.summary.days,
    plannedTotal: built.plannedTotal,
    start: built.summary.start,
    startTime: built.summary.startTime,
    asap: built.summary.asap,
    end: built.summary.end,
    tz: account.timezone,
    goal: built.goal,
    ...(built.warnings.some((w) => w.code === 'GOAL_NOTE') ? { goalNote: messageFor('GOAL_NOTE') } : {}),
    targeting: built.targeting,
    leftOut: built.leftOut,
    ads: built.ads.map(({ mediaId, ...a }) => ({ ...a, hasImage: !!mediaId })),
    claims: built.claims,
    warnings: built.warnings,
    blockers: built.blockers,
    committedDailyAfter: committedAfter,
    limitDaily: lim?.ads_max_daily ?? null,
    ...(platform === 'meta' ? { spendCap: built.spendCap } : {}),
    linkUrl: built.summary.linkUrl,
    setup,
  };
}

/**
 * Everything a launch preview needs, read fresh: project, plan, the business's connection and chosen ad account,
 * the setup checks, the customer's picks resolved, the build, the limits. No writes.
 */
export async function previewLaunch(ctx, who, body) {
  const { db, env, now } = ctx;
  const { projectId, planId, platform, picksIn } = readLaunchRequest(body);
  const project = await loadProject(db, who.id, projectId);
  const plan = await loadPlan(db, who.id, projectId, planId);
  if (!Array.isArray(plan.platforms) || !plan.platforms.includes(platform)) throw fail(400, 'BAD_REQUEST', `This plan isn’t for ${platform === 'meta' ? 'Meta' : 'Google'}.`);
  const conn = await connectionFor(ctx, who, projectId, platform);
  if (!conn.ok) throw fail(409, conn.code, conn.message);
  const lctx = { userId: who.id, tag: conn.tag, projectId, platform };
  const { row: choice } = await choiceFor(ctx, who.id, projectId, platform, conn.zid);
  if (!choice) throw fail(409, 'ACCOUNT_NOT_CHOSEN', messageFor('ACCOUNT_NOT_CHOSEN'));
  const listed = await listAccounts(ctx, conn.zid, platform, lctx);
  if (!listed.ok) throw fail(listed.code === 'ADS_UNAVAILABLE' ? 503 : 502, listed.code === 'ADS_UNAVAILABLE' ? 'ADS_UNAVAILABLE' : 'UNAVAILABLE', messageFor(listed.code === 'ADS_UNAVAILABLE' ? 'ADS_UNAVAILABLE' : 'UNAVAILABLE', { platform }));
  const account = listed.accounts.find((a) => a.adAccountId === choice.ad_account_id);
  if (!account) throw fail(409, 'ACCOUNT_CHANGED', messageFor('ACCOUNT_CHANGED'));
  const setup = await setupChecks(ctx, conn.zid, platform, account, lctx);

  // the customer's picks, resolved from their signed refs (an unknown ref is dropped, never guessed)
  const locations = picksIn.locations.map((r) => readTargetRef(env, who.id, platform, 'geo', r)).filter(Boolean);
  const interests = picksIn.interests.map((r) => readTargetRef(env, who.id, platform, 'interest', r)).filter(Boolean).map((t) => ({ id: t.key, name: t.name }));
  const picks = { ...picksIn, locations, interests };
  const builtAt = now();
  const launchKey = crypto.randomUUID();
  const built = buildLaunch({ platform, plan, project, account, zid: conn.zid, picks, launchKey, builtAt, mediaUrl: mediaUrlFor(env, who.id, builtAt) });

  // every picked image must be saved to the account (Meta fetches it from our link)
  if (platform === 'meta' && ctx.mediaStore?.enabled) {
    for (const a of built.ads) {
      if (!a.mediaId) continue;
      const head = await ctx.mediaStore.head(who.id, a.mediaId).catch(() => undefined);
      if (head === null || (head && !/^image\/(jpeg|png)$/.test(head.type))) built.blockers.push(note('NO_IMAGE', { field: `Ad ${a.variant}` }));
    }
  }
  for (const c of setup) if (c.state === 'missing') built.blockers.push({ code: c.code ?? 'ACCOUNT_UNUSABLE', message: c.message, ...(c.fixUrl ? { fixUrl: c.fixUrl } : {}) });

  // the owner's switches, the plan gate, then the limits (§D10 order)
  const lim = await ctx.limits.effective(conn.tag);
  const sw = switchesProblem(lim, env);
  if (sw) throw fail(403, sw, messageFor(sw));
  if (!(await ctx.canLaunchAds(who.id, who))) throw fail(403, 'PLAN_REQUIRED', messageFor('PLAN_REQUIRED'));
  const committed = await ctx.limits.committed(who.id, account.currency ?? lim.ads_currency);
  const launchesToday = await ctx.limits.countToday(who.id, ['launch']);
  const limitNotes = Number.isInteger(picks.dailyBudget) && Number.isInteger(picks.durationDays) ? launchProblems({ lim, currency: account.currency, daily: picks.dailyBudget, days: picks.durationDays, choice: picks.status, committed: committed.daily, launchesToday }) : [];
  built.blockers.push(...limitNotes);
  const committedAfter = picks.status === 'ACTIVE' && Number.isInteger(picks.dailyBudget) ? sumWhole([committed.daily, picks.dailyBudget], account.currency) : committed.daily;

  const review = launchReview({ platform, account, built, committedAfter, lim, setup });
  if (built.blockers.length) return { review };
  const token = signToken(env, {
    v: 1,
    kind: 'launch',
    rid: crypto.randomUUID(),
    uid: h16(who.id),
    projectId,
    planId,
    platform,
    picks,
    acct: { adAccountId: account.adAccountId, name: account.name, idTail: account.idTail, currency: account.currency, timezone: account.timezone, minDaily: account.minDaily },
    zid: h16(conn.zid),
    launchKey,
    builtAt,
    bodyHash: built.bodyHash,
    summaryHash: built.summaryHash,
    limitsVersion: lim.version,
    exp: builtAt + REVIEW_TTL_MS,
  });
  return { review, reviewToken: token };
}

/**
 * The launch write's checks, in order, from the token alone (no Zernio call): the business's connection and choice
 * are the same, the rebuilt body has the same hash, the dates haven't passed. → { conn, plan, project, built, tok }
 * or throws (refusal code in e.code, to be audited by the caller).
 */
export async function rebuildLaunch(ctx, who, tok) {
  const { db, env } = ctx;
  const project = await loadProject(db, who.id, tok.projectId);
  const plan = await loadPlan(db, who.id, tok.projectId, tok.planId).catch((e) => {
    if (e?.status === 404) throw fail(409, 'PLAN_CHANGED', messageFor('PLAN_CHANGED'));
    throw e;
  });
  const conn = await connectionFor(ctx, who, tok.projectId, tok.platform);
  if (!conn.ok || h16(conn.zid) !== tok.zid) throw fail(409, 'ACCOUNT_CHANGED', messageFor('ACCOUNT_CHANGED'));
  const { row: choice } = await choiceFor(ctx, who.id, tok.projectId, tok.platform, conn.zid);
  if (!choice || choice.ad_account_id !== tok.acct.adAccountId) throw fail(409, 'ACCOUNT_CHANGED', messageFor('ACCOUNT_CHANGED'));
  const built = buildLaunch({ platform: tok.platform, plan, project, account: tok.acct, zid: conn.zid, picks: tok.picks, launchKey: tok.launchKey, builtAt: tok.builtAt, mediaUrl: mediaUrlFor(env, who.id, tok.builtAt) });
  // a start day that is now in the past: the dates the customer saw no longer hold
  if (tok.picks.startDate && tok.picks.startDate < todayIn(tok.acct.timezone, ctx.now())) throw fail(409, 'REVIEW_EXPIRED', messageFor('REVIEW_EXPIRED'));
  if (built.bodyHash !== tok.bodyHash || built.summaryHash !== tok.summaryHash || built.blockers.length) throw fail(409, 'PLAN_CHANGED', messageFor('PLAN_CHANGED'));
  return { conn, plan, project, built };
}

// ───────────── changes to a launched campaign (§9.1) ─────────────

/** The newest values there are: live on Meta (accounts/live), the synced tree on Google ("as of"). */
export async function readNow(ctx, row, lctx, { withEndTime = false } = {}) {
  const remote = row.remote ?? {};
  if (row.platform === 'meta') {
    // every page of the account's live campaigns and ad sets until ours is found (live.mjs)
    const got = await findOwn(ctx, row, lctx);
    if (!got.ok) return { ok: false, code: got.code };
    const c = got.campaign;
    if (!c) return { ok: false, code: got.complete.campaigns ? 'META_OBJECT_GONE' : 'UNAVAILABLE' };
    const s = got.adSets[0] ?? null;
    const cbo = zernioWhole(c.dailyBudget) != null || isObj(c.budget);
    let endAt = null;
    if (withEndTime && remote.adSetId) {
      const raw = await ctx.zads.reads.adSet(remote.adSetId, row.zernio_account_id, lctx);
      if (!raw.ok) return { ok: false, code: raw.code };
      const t = Date.parse(raw.body.adSet?.end_time ?? '');
      endAt = Number.isFinite(t) ? iso(t) : null;
    }
    return {
      ok: true,
      live: true,
      asOf: got.readAt ?? iso(ctx.now()),
      configured: c.configuredStatus === 'ACTIVE' ? 'ACTIVE' : c.configuredStatus === 'PAUSED' ? 'PAUSED' : String(c.configuredStatus ?? ''),
      adSetConfigured: s?.configuredStatus ?? null,
      budgetLevel: cbo ? 'campaign' : 'adset',
      daily: cbo ? zernioWhole(c.dailyBudget) : zernioWhole(s?.dailyBudget),
      lifetime: zernioWhole(c.lifetimeBudget) ?? zernioWhole(s?.lifetimeBudget),
      spendCap: zernioWhole(c.spendCap),
      ...(withEndTime ? { endAt } : {}),
    };
  }
  const got = await ctx.zads.reads.tree(row.zernio_account_id, { campaignId: remote.campaignId, source: 'all' }, lctx);
  if (!got.ok) return { ok: false, code: got.code };
  if (got.status === 202) return { ok: false, code: 'UNAVAILABLE' };
  const n = (Array.isArray(got.body.campaigns) ? got.body.campaigns : []).find((x) => isObj(x) && String(x.platformCampaignId) === String(remote.campaignId));
  if (!n) return { ok: false, code: 'NOT_FOUND_REMOTE' };
  const configured = n.configuredStatus === 'ACTIVE' || n.configuredStatus === 'ENABLED' ? 'ACTIVE' : n.configuredStatus === 'PAUSED' ? 'PAUSED' : n.status === 'paused' ? 'PAUSED' : 'ACTIVE';
  return { ok: true, live: false, asOf: typeof got.body.syncedAt === 'string' ? got.body.syncedAt : null, configured, budgetLevel: 'campaign', daily: zernioWhole(n.campaignBudget?.amount), lifetime: null, spendCap: null };
}

const STOP = ['pause', 'end'];

/** What we know without a read (pause and end only): the switch unknown, so the pause is sent. */
export const unreadNow = (row) => ({ ok: true, live: false, asOf: null, configured: null, adSetConfigured: null, budgetLevel: row.budget_level ?? 'adset', daily: Number(row.daily_budget), lifetime: null, spendCap: row.spend_cap == null ? null : Number(row.spend_cap) });

/** What a change preview compares later (R2 LIVE_CHANGED): the switch, the money and (end date) the end. */
export const beforeOf = (now) => ({ configured: now.configured, daily: now.daily, lifetime: now.lifetime, spendCap: now.spendCap, ...(now.endAt !== undefined ? { endAt: now.endAt } : {}) });
export function sameBefore(a, b, currency) {
  const money = (x, y) => (x == null && y == null) || (x != null && y != null && compareWhole(x, y, currency) === 0);
  return a.configured === b.configured && money(a.daily, b.daily) && money(a.lifetime, b.lifetime) && money(a.spendCap, b.spendCap) && (a.endAt === undefined || a.endAt === b.endAt);
}

/** The change request, checked. */
export function readChangeRequest(body) {
  const b = isObj(body) ? body : {};
  const action = ['pause', 'resume', 'end', 'budget', 'end_date', 'creative'].includes(b.action) ? b.action : null;
  if (!action) throw fail(400, 'BAD_REQUEST', 'What should change?');
  const params = {};
  if (action === 'budget') {
    if (typeof b.dailyBudget !== 'number') throw fail(400, 'BAD_REQUEST', messageFor('BUDGET_INVALID'));
    params.dailyBudget = b.dailyBudget;
  }
  if (action === 'end_date') {
    if (!isYmd(b.endDate)) throw fail(400, 'BAD_REQUEST', 'Pick the new last day.');
    params.endDate = b.endDate;
  }
  if (action === 'creative') {
    if (b.creativeId != null && (typeof b.creativeId !== 'string' || !ID.test(b.creativeId))) throw fail(400, 'BAD_REQUEST', 'Which ad?');
    params.creativeId = b.creativeId ?? null;
    params.adIndex = Number.isInteger(b.adIndex) && b.adIndex >= 0 && b.adIndex < 3 ? b.adIndex : 0;
    params.claimsConfirmed = Array.isArray(b.claimsConfirmed) ? b.claimsConfirmed.filter((x) => typeof x === 'string' && x.length <= 80).slice(0, 40) : [];
  }
  return { action, params };
}

/** The first day still to run: today, or the start day when the campaign hasn't started yet (account time zone). */
export function fromDay(row, now) {
  const today = todayIn(row.timezone, now);
  const start = row.start_at ? todayIn(row.timezone, Date.parse(row.start_at)) : today;
  return start > today ? start : today;
}

/** Days left to run, counting the first day still to run and the end day. */
export function remainingDays(row, now, endDay = row.end_at ? todayIn(row.timezone, Date.parse(row.end_at)) : null) {
  if (!endDay) return 0;
  return Math.max(0, daysBetween(fromDay(row, now), endDay) + 1);
}

/**
 * The writes a change needs, in their fixed order (the cap always first and never lowered; the campaign switch
 * last), plus what the confirm shows. Pure, given the live values. → { ops, confirmKind, spend, blockers, notes,
 * current, proposed, dailyDelta?, totalDeltaEstimate?, newSpendCap?, newEnd? }
 */
export function planChange({ row, action, params, nowVals, nowMs, plan, project, mediaUrl }) {
  const p = row.platform;
  const cur = row.currency;
  const remote = row.remote ?? {};
  const blockers = [];
  const notes = [];
  const ops = [];
  const daily = nowVals.daily ?? Number(row.daily_budget);
  const remaining = remainingDays(row, nowMs);
  const spent = Math.max(0, Math.floor(Number(row.results?.spend) || 0));
  // whole units only (a budget set in Ads Manager can be 12.50); rounded down, so the limit never allows more
  const capFor = (d, days) => Math.floor(spent + Number(timesDays(d, days, cur)));
  // Meta refuses a spending limit below its minimum (USD: 100): never send one it can't take
  const metaCap = (d, days) => metaSpendCap(capFor(d, days), cur);
  let spend = false;
  let confirmKind = 'short';
  const out = { current: { daily, configured: nowVals.configured, spendCap: nowVals.spendCap ?? null, end: row.end_at ? todayIn(row.timezone, Date.parse(row.end_at)) : null, asOf: nowVals.asOf, live: nowVals.live }, proposed: {} };
  if (['ended', 'failed', 'completed'].includes(row.state) && action !== 'pause') blockers.push(note('CANT_CHANGE'));

  if (action === 'pause' || action === 'end') {
    if (nowVals.configured !== 'PAUSED') ops.push({ op: 'campaignStatus', status: 'paused' });
    else if (action === 'pause') blockers.push(note('NOTHING_TO_CHANGE'));
    out.proposed = { configured: 'PAUSED', ...(action === 'end' ? { ended: true } : {}) };
  } else if (action === 'resume') {
    spend = true;
    confirmKind = 'spend';
    if (row.end_at && remaining <= 0) blockers.push(note('ENDED'));
    if (row.state === 'rejected') blockers.push(note('REJECTED_RESUME'));
    const offAds = Array.isArray(remote.offAds) ? remote.offAds : [];
    const offAdSet = remote.offAdSet === true && nowVals.adSetConfigured !== 'ACTIVE';
    if (nowVals.configured === 'ACTIVE' && !offAds.length && !offAdSet) blockers.push(note('NOTHING_TO_CHANGE'));
    if (p === 'meta') {
      const need = metaCap(daily, remaining);
      if (nowVals.spendCap == null) {
        notes.push(note('NO_SPEND_CAP'));
        if (need > 0) ops.push({ op: 'cap', amount: need });
        out.newSpendCap = need;
      }
      if (offAdSet && remote.adSetId) ops.push({ op: 'adSetStatus', id: remote.adSetId, status: 'active' });
      for (const id of offAds) ops.push({ op: 'adStatus', id, status: 'active' });
    }
    if (nowVals.configured !== 'ACTIVE') ops.push({ op: 'campaignStatus', status: 'active' });
    out.proposed = { configured: 'ACTIVE', daily, remainingDays: remaining, remainingTotal: timesDays(daily, remaining, cur), total: capFor(daily, remaining) };
    out.limitCheck = { isResume: true, daily, total: capFor(daily, remaining) };
  } else if (action === 'budget') {
    const next = params.dailyBudget;
    const minDaily = Number(row.min_daily) > 0 ? Number(row.min_daily) : 1;
    const dp = dailyProblem(next, minDaily);
    if (dp) blockers.push(note(dp, { platform: p, currency: cur, min: minDaily }));
    if (nowVals.lifetime != null) blockers.push(note('LIFETIME_BUDGET'));
    // Google's figure is the synced copy and can lag behind our own last change: an increase is decided against the
    // lower of the two, so a raise is never treated as a cut (no limit check, no money confirm)
    const ours = Number(row.daily_budget);
    const base = p === 'google' && daily != null && Number.isFinite(ours) && ours > 0 && compareWhole(ours, daily, cur) < 0 ? ours : daily;
    if (base !== daily) {
      notes.push(note('GOOGLE_BUDGET_LAG', { currency: cur, amount: daily, ours }));
      out.current.daily = base;
    }
    if (daily != null && next === daily && next === base) blockers.push(note('NOTHING_TO_CHANGE'));
    const up = base == null || compareWhole(next, base, cur) > 0;
    if (up) {
      spend = true;
      confirmKind = 'spend';
    }
    if (p === 'meta' && up && !dp) {
      const need = metaCap(next, remaining);
      if (nowVals.spendCap == null || need > nowVals.spendCap) {
        ops.push({ op: 'cap', amount: need });
        out.newSpendCap = need;
      }
    }
    if (!dp) {
      if (p === 'google' || nowVals.budgetLevel === 'campaign') ops.push({ op: 'campaignBudget', amount: next });
      else ops.push({ op: 'adSetBudget', id: remote.adSetId, amount: next });
    }
    if (nowVals.live === true && nowVals.ownLearning && ['LEARNING', 'SUCCESS'].includes(nowVals.ownLearning)) notes.push(note('LEARNING_RESTART'));
    out.proposed = { daily: next, remainingDays: remaining, remainingTotal: Number.isInteger(next) ? timesDays(next, remaining, cur) : null, total: Number.isInteger(next) ? capFor(next, remaining) : null };
    out.dailyDelta = Number.isInteger(next) && base != null ? fromMinor(toMinor(next, cur) - toMinor(base, cur), cur) : null;
    out.totalDeltaEstimate = Number.isInteger(next) && base != null ? fromMinor((toMinor(next, cur) - toMinor(base, cur)) * remaining, cur) : null;
    out.limitCheck = { isResume: false, delta: out.dailyDelta ?? next, daily: next, total: Number.isInteger(next) ? capFor(next, remaining) : 0 };
  } else if (action === 'end_date') {
    if (p === 'google') blockers.push(note('GOOGLE_NO_DATES'));
    else {
      const today = todayIn(row.timezone, nowMs);
      const curEnd = out.current.end;
      const next = params.endDate;
      if (next < today) blockers.push(note('END_DATE_PAST'));
      if (curEnd && next === curEnd) blockers.push(note('NOTHING_TO_CHANGE'));
      const days = remainingDays(row, nowMs, next);
      const later = !curEnd || next > curEnd;
      if (later) {
        spend = true;
        confirmKind = 'spend';
        const need = metaCap(daily, days);
        if (nowVals.spendCap == null || need > nowVals.spendCap) {
          ops.push({ op: 'cap', amount: need });
          out.newSpendCap = need;
        }
      }
      if (remote.adSetId) ops.push({ op: 'endDate', id: remote.adSetId, value: withOffset(next, '23:59:59', row.timezone) });
      out.newEnd = next;
      out.proposed = { end: next, remainingDays: days, remainingTotal: timesDays(daily, days, cur), total: capFor(daily, days) };
      out.limitCheck = { isResume: false, delta: 0, daily, total: capFor(daily, days) };
    }
  } else if (action === 'creative') {
    if (p === 'meta') {
      const creative = (plan?.creatives ?? []).find((c) => c?.id === params.creativeId);
      const zad = (remote.zernioAdIds ?? [])[params.adIndex ?? 0];
      if (!creative) blockers.push(note('NO_CREATIVE'));
      if (!zad) blockers.push(note('CANT_CHANGE'));
      if (creative && zad) {
        const got = metaCreativeFor({ plan, project, creative, mediaUrl, claimsConfirmed: params.claimsConfirmed });
        blockers.push(...got.blockers);
        ops.push({ op: 'metaCreative', id: zad, creative: got.creative, mediaId: got.mediaId });
        out.claims = got.claims;
        out.proposed = { ad: { variant: creative.variant, headline: got.creative.headline, body: got.creative.body, description: got.creative.description, callToAction: got.creative.callToAction } };
      }
    } else {
      const got = searchTextFor({ plan, project, claimsConfirmed: params.claimsConfirmed });
      blockers.push(...got.blockers);
      const zad = (remote.zernioAdIds ?? [])[0];
      if (!zad) blockers.push(note('CANT_CHANGE'));
      else ops.push({ op: 'searchText', id: zad, headlines: got.headlines, descriptions: got.descriptions, finalUrls: got.finalUrls });
      out.claims = got.claims;
      out.proposed = { headlines: got.headlines, descriptions: got.descriptions };
    }
    notes.push(note('BACK_TO_REVIEW'));
    // a refused ad under a campaign whose switch is on: once the new ad is approved it spends, so this is a spend
    // (the money confirm, the owner's switches, the plan gate and the limits), like a resume
    if ((nowVals.configured === 'ACTIVE' || row.configured_status === 'ACTIVE') && ['rejected', 'with_issues'].includes(row.state)) {
      spend = true;
      confirmKind = 'spend';
      if (row.end_at && remaining <= 0) blockers.push(note('ENDED'));
      out.proposed = { ...out.proposed, daily, remainingDays: remaining, remainingTotal: timesDays(daily, remaining, cur), total: capFor(daily, remaining) };
      out.limitCheck = { isResume: true, daily, total: capFor(daily, remaining) };
      notes.push(note('SWAP_SPENDS', { currency: cur, amount: daily }));
    }
  }
  return { ops, confirmKind, spend, blockers, notes, spentSoFar: spent, ...out };
}

/** The hash of the writes a change will send (the media link is part of a creative, so builtAt fixes it). */
export const opsHash = (ops) => hashOf(ops.map(({ mediaId, ...o }) => o));

/** The change preview: one live read, the plan, the checks; a token when nothing blocks. */
export async function previewChange(ctx, who, row, body) {
  const { env, now, db } = ctx;
  const { action, params } = readChangeRequest(body);
  const lctx = { userId: who.id, tag: row.customer_tag, projectId: row.project_id, platform: row.platform };
  if (!row.remote?.campaignId) throw fail(409, 'CANT_CHANGE', messageFor('CANT_CHANGE'));
  const live = await ctx.jobs.liveFor(who.id, row.id);
  const builtAt = now();
  let nowVals = await readNow(ctx, row, lctx, { withEndTime: action === 'end_date' });
  if (!nowVals.ok) {
    // stopping never waits on a read (R7): Zernio reads the switch itself before writing and skips it when it's off
    if (!STOP.includes(action) || nowVals.code === 'ADS_UNAVAILABLE') throw fail(nowVals.code === 'ADS_UNAVAILABLE' ? 503 : 409, nowVals.code, messageFor(nowVals.code, { platform: row.platform }));
    nowVals = unreadNow(row);
  }
  let plan = null;
  let project = null;
  if (action === 'creative') {
    project = await loadProject(db, who.id, row.project_id);
    plan = await loadPlan(db, who.id, row.project_id, row.plan_id);
  }
  // the learning phase (Meta): a raw read of the ad set, for the note only (never money)
  if (row.platform === 'meta' && (action === 'budget' || action === 'creative') && row.remote?.adSetId) {
    const raw = await ctx.zads.reads.adSet(row.remote.adSetId, row.zernio_account_id, lctx);
    const st = raw.ok ? raw.body.adSet?.learning_stage_info?.status : null;
    if (['LEARNING', 'SUCCESS', 'FAIL', 'WAIVING'].includes(st)) nowVals.ownLearning = st;
  }
  const planned = planChange({ row, action, params, nowVals, nowMs: builtAt, plan, project, mediaUrl: mediaUrlFor(env, who.id, builtAt) });
  if (live) planned.blockers.unshift(note('JOB_LIVE'));
  let lim = null;
  if (planned.spend) {
    lim = await ctx.limits.effective(row.customer_tag);
    const sw = switchesProblem(lim, env);
    if (sw) throw fail(403, sw, messageFor(sw));
    if (!(await ctx.canLaunchAds(who.id, who))) throw fail(403, 'PLAN_REQUIRED', messageFor('PLAN_REQUIRED'));
    planned.blockers.push(...(await spendLimitNotes(ctx, who, row, planned, lim)));
  } else if (action === 'creative') {
    lim = await ctx.limits.effective(row.customer_tag);
    const changesToday = await ctx.limits.countToday(who.id, ['resume', 'budget', 'end_date', 'creative']);
    if (changesToday >= lim.ads_changes_per_day) planned.blockers.push(note('LIMIT_CHANGES', { limit: lim.ads_changes_per_day }));
  }
  const review = {
    action,
    platform: row.platform,
    confirmKind: planned.confirmKind,
    account: { name: row.ad_account_name, idTail: idTailOf(row.ad_account_id), currency: row.currency, timezone: row.timezone },
    current: planned.current,
    proposed: planned.proposed,
    ...(planned.dailyDelta != null ? { dailyDelta: planned.dailyDelta } : {}),
    ...(planned.totalDeltaEstimate != null ? { totalDeltaEstimate: planned.totalDeltaEstimate } : {}),
    spentSoFar: planned.spentSoFar,
    ...(planned.newSpendCap != null ? { newSpendCap: planned.newSpendCap } : {}),
    ...(nowVals.ownLearning ? { learning: nowVals.ownLearning } : {}),
    ...(planned.claims ? { claims: planned.claims } : {}),
    notes: planned.notes,
    blockers: planned.blockers,
  };
  if (planned.blockers.length) return { review };
  const token = signToken(env, {
    v: 1,
    kind: 'change',
    rid: crypto.randomUUID(),
    uid: h16(who.id),
    cid: row.id,
    action,
    params,
    before: beforeOf(nowVals),
    opsHash: opsHash(planned.ops),
    spend: planned.spend,
    limitsVersion: lim?.version ?? null,
    builtAt,
    exp: builtAt + REVIEW_TTL_MS,
  });
  return { review, reviewToken: token };
}

/** The limit notes for a change that can raise spend (committed daily counts this campaign at its new amount). */
export async function spendLimitNotes(ctx, who, row, planned, lim, { excludeJob } = {}) {
  const c = planned.limitCheck ?? { daily: Number(row.daily_budget), total: 0 };
  const others = await ctx.limits.committed(who.id, row.currency, { exclude: row.id });
  const changesToday = await ctx.limits.countToday(who.id, ['resume', 'budget', 'end_date', 'creative'], { exclude: excludeJob });
  // this campaign counts at its new daily when its switch is (or will be) on
  const counts = c.isResume === true || planned.current?.configured === 'ACTIVE';
  return increaseProblems({ lim, currency: row.currency, delta: c.delta ?? 0, daily: c.daily, total: c.total, committedAfter: counts ? sumWhole([others.daily, c.daily], row.currency) : others.daily, changesToday, isResume: c.isResume === true });
}

export { isUuid, canonical };
