// Customers' social accounts through Upload-Post (the owner's choice for social; ads stay on Zernio): one
// Upload-Post profile per customer, made on their first Connect click, named `ylb_` + the 24 hex of their customer
// tag (never an email or our user id; Upload-Post usernames can't be changed, so it is stored once and never
// recomputed). Customers connect on Upload-Post's hosted white-label page. The methods are those of
// server/connections/index.mjs for the social platforms, plus webhook(rawBody, headers) for
// POST /api/webhooks/upload-post (settled() waits for its background work), setPostListener(fn), userDeleted(userId),
// meterIfDue(), reconcileIfDue(), accountCount(userId), ownerView() and alert(kind).
//
//   const impl = createUploadPostConnections({ env, fetch, now, storage, db, log });
//
// What this file keeps (docs/integrations-setup.md §3):
// - Every Upload-Post call goes through server/uploadpost.mjs (the one client; the key never leaves it).
// - Isolation: a request only ever names the signed-in user's own profile username (from their stored doc), and
//   every Pages list is asked with profile= (without it Upload-Post lists every customer's Pages).
// - The browser sees ConnectionStatus and opaque target handles only: no profile names, account or Page ids.
// - A post is one attempt (request_id = Idempotency-Key = external_id = the job id). A timeout, a 5xx or a status
//   that never settles is 'unknown' ("may have been posted - check before trying again") and is only ever
//   checked with a read of /uploadposts/status by the job id; nothing here sends it again.
// - Team-level problems (our key, the 75-profile cap, a blocked profile, the scheduled-post cap, the shared X and
//   analytics budgets) never reach a customer: they see a safe message and the owner gets an alert (one per kind in
//   `uploadpost:alerts`; a key or rate alert ends at the next call that works).
// - Webhooks: signed (HMAC over "<timestamp>.<raw body>", 300 s window; unsigned ones refused), de-duplicated by
//   request id + platform + event, answered 200 at once and worked on afterwards (Upload-Post waits 10 s and pauses
//   deliveries for 30 minutes after 5 failures), routed by profile_username → customer tag → user, applied only to
//   that customer's own doc and jobs. Upload-Post never retries a webhook, so status polling, a read of the profile
//   while a connect is waiting (and on Check and Connect) and the daily reconcile of every profile back it up.
// - A profile is deleted only after its customer's account is gone (userDeleted), or by the daily check for a
//   profile our own account deletion marked: never because a customer looks absent (another copy of the app on the
//   same key, or a doc that can't be read, must not delete anyone's connections). A profile nobody connected
//   anything to for a week goes back to the plan (it's made again on the next Connect).
// - Third-party text (account names, Page names, post text) is data: clipped and kept as plain text.

import crypto from 'node:crypto';
import { PHASE2_PLATFORMS, PLATFORMS, SOCIAL_PLATFORMS } from '../integrations/contracts.mjs';
import { customerTag, ensureCustomer, fail, IntegrationError, notSetUp, oneShot, safeLog, sha256 } from '../integrations/common.mjs';
import { notConnectedStatuses } from './index.mjs';
import { createUploadPostClient, isSocialReauth, UploadPostCallError, upError } from '../uploadpost.mjs';
import { appOrigin } from '../seo/sitemap.mjs';
import { num } from '../analytics/normalize/util.mjs';
import { canMakePublicLinks, publicMediaUrl } from '../social/media.mjs';

const NAMES = { facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', tiktok: 'TikTok', x: 'X', youtube: 'YouTube', pinterest: 'Pinterest' };
const TARGET_KIND = { facebook: 'fb_page', instagram: 'ig_account', linkedin: 'li_person', tiktok: 'tt_account', x: 'x_account', youtube: 'yt_channel', pinterest: 'pin_account' };
/** Our platform → Upload-Post's social_accounts key and upload platform (the same names today). */
export const UP_PLATFORM = Object.freeze({ facebook: 'facebook', instagram: 'instagram', linkedin: 'linkedin', tiktok: 'tiktok', x: 'x', youtube: 'youtube', pinterest: 'pinterest' });
const FROM_UP = Object.freeze(Object.fromEntries(Object.entries(UP_PLATFORM).map(([ours, up]) => [up, ours])));

const PENDING_MS = 30 * 60_000;
/** While a connect is waiting, the profile is read back at most this often (the webhook may never come). */
const PENDING_SYNC_MS = 30_000;
const LINK_LIFETIME_MS = 48 * 3_600_000;
const FORGOTTEN_FOR_MS = 24 * 3_600_000;
const CAP_CACHE_MS = 60_000;
/** A reauth event that names no profile reads every profile, at most this often. */
const FULL_READ_EVERY_MS = 10 * 60_000;
/** Webhook work running at once (each answer went out already). */
const WEBHOOK_WORKERS = 4;
const DAY_MS = 86_400_000;
/** X Links: 50 link posts a month for the whole Upload-Post account; the owner hears at 40. */
const X_LINKS_POOL = 50;
const X_LINKS_POOL_ALERT = 40;
/** The owner's alerts, most serious first (the Billing page shows the first one live), and how long one shows. */
const ALERT_RANK = ['auth', 'rate_lockout', 'profile_cap', 'profile_blocked', 'plan', 'scheduled_limit', 'media_secret', 'profile_budget', 'x_links', 'profile_cap_low', 'x_links_low', 'profile_orphans', 'analytics_limit'];
const ALERT_TTL_MS = 7 * DAY_MS;
const ALERTS_KEY = 'uploadpost:alerts';
const GONE_KEY = 'uploadpost:gone';
/** A request id Upload-Post may answer with (ours is a UUID; an identical recent upload returns its own). */
const REQUEST_ID = /^[A-Za-z0-9_.:-]{6,128}$/;
const TIKTOK_PRIVACY = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];
/** What each network's reach_timeseries counts when the answer has no metric_type (Upload-Post's metric_type). */
const SERIES_METRIC = { facebook: 'reach', instagram: 'reach', linkedin: 'reach', tiktok: 'views', youtube: 'views', x: 'impressions', pinterest: 'impressions' };
/** A web address X would turn into a link (Upload-Post strips those without the X Links add-on). */
const X_LINKISH = /https?:\/\/|\b[a-z0-9-]+\.[a-z]{2,}\//i;
/** Estimated cost of one profile for a month: the Advanced plan ($147) over its 75 profiles, ≈ $1.96 (owner sign-off). */
export const PROFILE_MONTH_MICRO = 1_960_000;
/** Analytics reads: 100 per 5 minutes at Upload-Post; we keep to 80 so on-demand views have room. */
const ANALYTICS_PER_5_MIN = 80;
const USERNAME = /^ylb_[0-9a-f]{24}$/;
const TARGET_ID = /^tgt_[0-9a-f]{32}$/;
const DEFAULT = '*';
const PERSONAL = 'personal';

const iso = (ms) => new Date(ms).toISOString();
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n = 120) => {
  const t = (typeof s === 'string' || typeof s === 'number' ? String(s) : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const httpsUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s<>"']{4,500}$/.test(u) ? u : undefined);
const docKey = (userId) => `uploadpost:user:${sha256(String(userId))}`;
const blankDoc = () => ({ v: 1, accounts: {}, pages: {}, pins: {}, choice: {}, pending: {}, lastError: {} });
const usernameFor = (tag) => `ylb_${String(tag).slice(5)}`;
const tagForUsername = (username) => (USERNAME.test(String(username)) ? `cust_${String(username).slice(4)}` : null);

/** A per-platform error_code → the code a job ends with (our words live in server/social/jobs.mjs). */
export function jobErrorForCode(code) {
  const c = String(code || '');
  if (/reauth|reconnect/i.test(c)) return 'NEEDS_RECONNECT';
  if (c === 'profile_platform_mapping_invalid') return 'NOT_CONNECTED';
  if (c === 'account_checkpoint_required') return 'ACCOUNT_CHECK';
  if (c === 'account_restricted') return 'TEMP_RESTRICTED';
  if (c === 'tiktok_privacy_unavailable') return 'TIKTOK_PRIVACY';
  if (c === 'spam_risk_too_many_pending_share') return 'TIKTOK_DRAFTS_FULL';
  if (c === 'reached_active_user_cap' || c === 'x_daily_write_limit' || c === 'hard_cap') return 'PLATFORM_LIMIT';
  if (/^(MEDIA_REQUIRED|MEDIA_LIMITS|invalid_video_file)$/.test(c)) return 'MEDIA_REFUSED';
  if (/duplicate|similar/i.test(c)) return 'DUPLICATE';
  return 'REFUSED';
}

/**
 * One platform's result → our outcome: { state: 'sent', url?, drafts? } | { state: 'failed', errorCode, reauth? } |
 * { state: 'unknown', errorCode: 'UNCONFIRMED' } | { state: 'pending' }. Top-level success is never trusted: only
 * this platform's own entry. `final`: the entry is a finished answer (an upload's own results.<p>, an
 * upload_completed event). A /status entry is finished only when it says so (its own status completed/failed/
 * skipped) or the whole request has (`top` completed/failed): Upload-Post lists a queued post as
 * `{success: true, message: "Queued"}` while the request is in_progress. `retryable` is not an answer either
 * (Upload-Post tries it again by itself), and a TikTok failure with no code is TikTok's internal error, which
 * TikTok sometimes publishes once moderation finishes: it may have been posted.
 */
export function outcomeOfEntry(entry, { platform = '', top = '', final = false } = {}) {
  if (!isObj(entry)) return { state: 'pending' };
  const st = String(entry.status ?? '');
  if (entry.skipped === true || st === 'skipped') return { state: 'failed', errorCode: 'NOT_CONNECTED' };
  if (['queued', 'processing', 'pending', 'in_progress', 'retryable'].includes(st)) return { state: 'pending' };
  const done = final || st === 'completed' || st === 'failed' || top === 'completed' || top === 'failed';
  if (entry.success === true) {
    if (entry.fallback_to_inbox === true) return { state: 'sent', drafts: true };
    const url = httpsUrl(entry.url) ?? httpsUrl(entry.post_url);
    if (!done && !url) return { state: 'pending' };
    return { state: 'sent', ...(url ? { url } : {}) };
  }
  if (entry.success === false || st === 'failed') {
    if (!done) return { state: 'pending' };
    const code = String(entry.error_code ?? '');
    if (entry.reauth_required === true || /reauth|reconnect/i.test(code)) return { state: 'failed', errorCode: 'NEEDS_RECONNECT', reauth: true };
    if ((platform || entry.platform) === 'tiktok' && !clip(code, 60)) return { state: 'unknown', errorCode: 'UNCONFIRMED' };
    return { state: 'failed', errorCode: jobErrorForCode(code) };
  }
  return { state: 'pending' };
}

/** The profile's connected accounts (Upload-Post's social_accounts) differ from what our doc has. */
export function accountsDiffer(doc, social) {
  if (!isObj(social)) return false;
  for (const platform of Object.keys(UP_PLATFORM)) {
    if (PHASE2_PLATFORMS.includes(platform)) continue;
    const there = social[UP_PLATFORM[platform]];
    const mine = doc?.accounts?.[platform];
    if (isObj(there) !== !!mine) return true;
    if (!mine) continue;
    if (clip(there.username ?? '', 120) !== (mine.key ?? '')) return true;
    if ((there.reauth_required === true) !== (mine.state === 'needs_reconnect')) return true;
  }
  return false;
}

/**
 * env: UPLOAD_POST_API_KEY, UPLOAD_POST_WEBHOOK_SECRET (+ _PREVIOUS), UPLOAD_POST_BASE_URL (tests), UPLOAD_POST_RPM,
 * UPLOAD_POST_ALERT_REMAINING, UPLOAD_POST_NEW_PROFILES_PER_DAY, UPLOAD_POST_RECLAIM_DAYS, UPLOAD_POST_X_LINKS
 * (the X Links add-on is bought), UPLOAD_POST_X_LINK_POSTS_PER_CUSTOMER, UPLOAD_POST_BRAND_LOGO_URL,
 * UPLOAD_POST_CONNECT_TITLE, UPLOAD_POST_CONNECT_DESCRIPTION, UPLOAD_POST_BACK_BUTTON_TEXT, CUSTOMER_TAG_SECRET,
 * MEDIA_URL_SECRET (posts with a photo or video), GSC_APP_PROPERTY (the app's address for the back button).
 * storage: appState. db: server/integrations/db.mjs. client, sleep: for tests.
 */
export function createUploadPostConnections({ env = process.env, fetch = globalThis.fetch, now = () => Date.now(), storage = null, db = null, log = console, client = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const storageReady = storage?.enabled === true;
  const dbReady = db?.enabled === true;
  const log_ = (event, fields) => safeLog(event, fields, log);
  const up = client ?? createUploadPostClient({ env, fetch, now, log, sleep, onAlert: (kind) => ownerAlert(kind), onRecover: (kinds) => clearAlerts(kinds) });
  const tagSecret = String(env.CUSTOMER_TAG_SECRET || '');
  const alertRemaining = Math.max(0, Number.parseInt(env.UPLOAD_POST_ALERT_REMAINING, 10) || 5);
  const intEnv = (name, dflt, min, max) => {
    const n = Number.parseInt(env[name], 10);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
  };
  /** New profiles a day at most (a burst of throwaway sign-ups must not fill the plan's 75 in an afternoon). */
  const newProfilesPerDay = intEnv('UPLOAD_POST_NEW_PROFILES_PER_DAY', 20, 1, 1000);
  /** A profile with nothing connected this long goes back to the plan. */
  const reclaimAfterMs = intEnv('UPLOAD_POST_RECLAIM_DAYS', 7, 2, 365) * DAY_MS;
  /** The X Links add-on is bought: links stay in X posts, out of a 50-a-month allowance for every customer. */
  const xLinks = /^(on|true|1|yes)$/i.test(String(env.UPLOAD_POST_X_LINKS || '').trim());
  const xLinkPostsPerCustomer = intEnv('UPLOAD_POST_X_LINK_POSTS_PER_CUSTOMER', 5, 0, X_LINKS_POOL);
  let postListener = null;
  let capCache = null; // { at, used, limit }
  const analyticsTimes = [];
  /** when each user's profile was last read back (status() reads it while a connect waits) */
  const lastSync = new Map();
  let lastFullRead = 0;
  /** when each alert kind was last saved (so a burst of the same one isn't a burst of writes) */
  const alertSaved = new Map();
  /** background work still running (webhook work, alert writes): settled() waits for it */
  const background = new Set();
  const track = (promise) => {
    const p = Promise.resolve(promise).catch(() => {});
    background.add(p);
    void p.finally(() => background.delete(p));
    return p;
  };

  const missing = [...(up.enabled ? [] : ['UPLOAD_POST_API_KEY']), ...(up.webhookReady ? [] : ['UPLOAD_POST_WEBHOOK_SECRET']), ...(tagSecret.length >= 16 ? [] : ['CUSTOMER_TAG_SECRET'])];
  const setUp = missing.length === 0 && storageReady && dbReady;
  const hint = missing.length
    ? `Social accounts and posting need these Replit Secrets: ${missing.join(', ')}.`
    : !storageReady || !dbReady
      ? 'Social accounts need Supabase server storage (SUPABASE_URL, SUPABASE_SECRET_KEY, the app_state and integrations migrations).'
      : '';
  /** Set up, but photo and video posts can't go (Upload-Post fetches them from our short-lived links). */
  const mediaReady = canMakePublicLinks(env);
  const warning = setUp && !mediaReady ? 'Photo and video posts need MEDIA_URL_SECRET (32+ random bytes) in Replit Secrets; text posts work without it.' : '';

  function requireSetUp() {
    if (!setUp) throw notSetUp(hint, 'Connecting accounts isn’t available yet.');
  }

  // ───────────── the owner's alerts (one entry per kind; the Billing page shows the most serious) ─────────────

  /** Change the stored alerts (`uploadpost:alerts`, { kind: { at, n? } }): change(map) → true when it changed. */
  async function changeAlerts(change) {
    if (!storageReady) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let got;
      try {
        got = await storage.get(ALERTS_KEY);
      } catch {
        return;
      }
      const map = isObj(got?.value) ? { ...got.value } : {};
      if (!change(map)) return;
      try {
        await storage.put(ALERTS_KEY, map, { ifVersion: got?.updatedAt ?? null });
        return;
      } catch (e) {
        if (e?.code !== 'CONFLICT') return;
      }
    }
  }

  function ownerAlert(kind, extra = {}) {
    log_('uploadpost_owner_alert', { kind });
    const last = alertSaved.get(kind) ?? 0;
    if (now() - last < 10 * 60_000 && !Object.keys(extra).length) return;
    alertSaved.set(kind, now());
    track(
      changeAlerts((map) => {
        map[kind] = { at: iso(now()), ...extra };
        return true;
      }),
    );
  }

  /** Alerts that are over (a call went through after a key or rate problem, room came back in the plan). */
  function clearAlerts(kinds) {
    for (const k of kinds) alertSaved.delete(k);
    track(
      changeAlerts((map) => {
        const had = kinds.filter((k) => map[k]);
        for (const k of had) delete map[k];
        return had.length > 0;
      }),
    );
  }

  /** The customer-safe refusal for the profile cap (the owner is told which add-on to buy). */
  const capFull = () => fail(503, 'CONNECTIONS_UNAVAILABLE', 'Social connections are temporarily full. We’ve been notified and will let you know.', {}, 'Upload-Post’s profile limit is reached: add the +25 or +50 profile add-on, or move to a bigger plan, in the Upload-Post dashboard.');

  /** An Upload-Post call in our words when it got no answer at all. */
  async function call(method, path, opts) {
    try {
      return await up.call(method, path, opts);
    } catch (e) {
      if (e instanceof UploadPostCallError) throw fail(504, 'UNAVAILABLE', 'The accounts service didn’t answer in time. Try again shortly.');
      throw e;
    }
  }

  /** An answer that isn't a success, for profile, connect and account calls, in our words (never Upload-Post's). */
  function callFailure(res, platform) {
    const e = upError(res);
    // one customer's social sign-in ran out (e.g. the pinned-Page read answers 401 facebook_reauth_required)
    if (isSocialReauth(res)) return fail(409, 'NEEDS_RECONNECT', `Reconnect ${NAMES[platform] ?? 'the account'} in Settings → Connected accounts.`);
    if (e.status === 401) return fail(503, 'CONNECTIONS_UNAVAILABLE', 'Connecting accounts isn’t available right now. We’ve been notified.', {}, 'Upload-Post refused the API key: check UPLOAD_POST_API_KEY in Replit Secrets.');
    if (e.code === 'PROFILE_LIMIT_REACHED') {
      ownerAlert('profile_cap');
      return capFull();
    }
    if (e.code === 'PROFILE_BLOCKED' || e.status === 403) {
      ownerAlert('profile_blocked');
      return fail(503, 'CONNECTIONS_UNAVAILABLE', 'Social connections are temporarily unavailable. We’ve been notified.', {}, 'Upload-Post blocked a customer profile over the plan’s limits: check the plan and profile count in the Upload-Post dashboard.');
    }
    if (e.status === 429) return fail(429, 'RATE_LIMITED', 'Too many requests. Try again in a minute.');
    if (e.status === 503) return fail(503, 'CONNECTIONS_UNAVAILABLE', `${NAMES[platform] ?? 'This network'} isn’t available to connect right now.`);
    return fail(502, 'UNAVAILABLE', 'Couldn’t reach the accounts service. Try again shortly.');
  }

  /** A read's failure as a thrown { kind } (like a TregError), for analytics. Team limits alert the owner. */
  function readFailure(res) {
    const e = upError(res);
    if (e.code === 'daily_limit') ownerAlert('analytics_limit');
    const kind = isSocialReauth(res) || e.status === 409 ? 'reconnect' : e.status === 401 || e.status === 403 ? 'config' : e.status === 429 ? 'busy' : e.status === 404 ? 'not_found' : 'upstream';
    return Object.assign(new Error('upload-post read failed'), { kind, status: e.status, code: e.code });
  }

  // ───────────── the stored doc (encrypted, per user) ─────────────

  async function readDoc(userId) {
    if (!storageReady) throw notSetUp(hint, 'Connecting accounts isn’t available yet.');
    let got;
    try {
      got = await storage.get(docKey(userId));
    } catch {
      throw fail(503, 'UNAVAILABLE', 'Couldn’t read your connected accounts just now. Try again shortly.');
    }
    // a doc this server can't decrypt (the secret changed) reads as blank so the customer can start over (the
    // profile name comes back from the customer tag, the accounts from Upload-Post), and says so: nothing may be
    // concluded from it (the daily check never deletes anything on a doc's say-so)
    if (got?.unreadable) return { value: blankDoc(), version: got.updatedAt ?? null, unreadable: true };
    const value = isObj(got?.value) ? got.value : blankDoc();
    for (const k of ['accounts', 'pages', 'pins', 'choice', 'pending', 'lastError']) if (!isObj(value[k])) value[k] = {};
    return { value, version: got?.updatedAt ?? null, unreadable: false };
  }

  /** change(doc) → { value, result } or { write: false, result }. Re-reads and retries on a version conflict. */
  async function updateDoc(userId, change) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await readDoc(userId);
      const out = await change(structuredClone(current.value));
      if (out?.write === false) return out.result;
      try {
        await storage.put(docKey(userId), out.value, { ifVersion: current.version });
        return out.result;
      } catch (e) {
        if (e?.code === 'CONFLICT') continue;
        throw fail(503, 'UNAVAILABLE', 'Couldn’t save your connected accounts just now. Try again shortly.');
      }
    }
    throw fail(409, 'UNAVAILABLE', 'Your connected accounts changed in another request. Try again.');
  }

  const forgotten = (doc) => {
    const at = Date.parse(doc?.forgottenAt);
    return Number.isFinite(at) && now() - at < FORGOTTEN_FOR_MS;
  };

  /** The opaque handle the browser sees for an account or a Page (never the id). */
  const handleOf = (platform, id) => `tgt_${crypto.createHmac('sha256', tagSecret || 'ylb').update(`uploadpost:${platform}:${id}`).digest('hex').slice(0, 32)}`;

  /**
   * The Page (Facebook) or page URN / 'personal' (LinkedIn) a business posts to, or null when none is clear. Each
   * business has its own choice; one that has none uses the customer's default ('*': set without a business, or
   * the Page that was pinned before a business chose another), never another business's choice.
   */
  function pageFor(doc, platform, projectId) {
    if (platform !== 'facebook' && platform !== 'linkedin') return null;
    // a Page pinned on the hosted connect page wins over anything sent with a post, so it wins here too
    const pin = doc.pins?.[platform];
    if (pin) return pin;
    const pick = (projectId && doc.choice?.[projectId]?.[platform]) || doc.choice?.[DEFAULT]?.[platform];
    const known = doc.pages?.[platform] ?? {};
    if (platform === 'linkedin') return pick && (pick === PERSONAL || known[pick]) ? pick : PERSONAL;
    if (pick && known[pick]) return pick;
    const ids = Object.keys(known);
    return ids.length === 1 ? ids[0] : null;
  }

  function statusOf(doc, platform, projectId) {
    if (PHASE2_PLATFORMS.includes(platform)) return { platform, state: 'coming_soon' };
    const acct = doc.accounts?.[platform];
    if (acct) {
      const state = acct.state === 'needs_reconnect' ? 'needs_reconnect' : 'connected';
      const out = { platform, state };
      if (platform === 'facebook') {
        const page = pageFor(doc, platform, projectId);
        const label = page ? doc.pages?.facebook?.[page] : '';
        if (label) Object.assign(out, { targetLabel: label, targetKind: 'fb_page' });
        // with a Page pinned on the connect page too: choosing another one here clears that pin
        const n = Object.keys(doc.pages?.facebook ?? {}).length;
        if (n > 1) out.targetsAvailable = n;
      } else if (platform === 'linkedin') {
        const page = pageFor(doc, platform, projectId);
        if (page && page !== PERSONAL && doc.pages?.linkedin?.[page]) Object.assign(out, { targetLabel: doc.pages.linkedin[page], targetKind: 'li_org' });
        else if (acct.label) Object.assign(out, { targetLabel: acct.label, targetKind: 'li_person' });
        const n = Object.keys(doc.pages?.linkedin ?? {}).length;
        if (n > 0) out.targetsAvailable = n + 1;
      } else if (acct.label) Object.assign(out, { targetLabel: acct.label, targetKind: TARGET_KIND[platform] });
      if (acct.connectedAt) out.connectedAt = acct.connectedAt;
      if (state === 'needs_reconnect') out.lastError = 'reconnect';
      return out;
    }
    const pending = Date.parse(doc.pending?.[platform]?.at);
    if (Number.isFinite(pending)) {
      if (now() - pending < PENDING_MS) return { platform, state: 'pending' };
      return { platform, state: 'not_connected', lastError: 'not_finished' };
    }
    if (doc.lastError?.[platform]) return { platform, state: 'not_connected', lastError: clip(doc.lastError[platform], 40) };
    return { platform, state: 'not_connected' };
  }

  const waiting = (doc) => Object.values(doc.pending ?? {}).some((x) => now() - Date.parse(x?.at) < PENDING_MS);

  /**
   * ConnectionStatus for every platform; ad platforms read "Not connected" here (Zernio answers those). While a
   * connect is waiting, the profile is read back from Upload-Post (at most every 30 s): Upload-Post sends its
   * social_account_connected webhook once and never again, so a lost one must not leave the customer waiting.
   */
  async function status(userId, { projectId } = {}) {
    if (!storageReady) return notConnectedStatuses();
    let { value } = await readDoc(userId);
    if (forgotten(value)) return notConnectedStatuses();
    if (setUp && USERNAME.test(String(value.username ?? '')) && waiting(value) && now() - (lastSync.get(userId) ?? 0) >= PENDING_SYNC_MS) {
      value = (await sync(userId).catch(() => null)) ?? value;
    }
    return PLATFORMS.map((p) => (SOCIAL_PLATFORMS.includes(p) ? statusOf(value, p, projectId) : { platform: p, state: PHASE2_PLATFORMS.includes(p) ? 'coming_soon' : 'not_connected' }));
  }

  // ───────────── the customer's profile (one per customer, of the plan's 75) ─────────────

  /** GET /uploadposts/users (cached 1 minute): { used, limit } or null. Also tells the client the budget. */
  async function capInfo({ fresh = false } = {}) {
    if (!fresh && capCache && now() - capCache.at < CAP_CACHE_MS) return capCache;
    const res = await call('GET', '/uploadposts/users', { retry429: true });
    if (res.status < 200 || res.status >= 300) return null;
    const list = Array.isArray(res.body?.profiles) ? res.body.profiles.filter(isObj) : [];
    const limit = Number(res.body?.limit);
    capCache = { at: now(), used: list.length, limit: Number.isFinite(limit) && limit > 0 ? limit : null, profiles: list };
    up.setProfileCount?.(list.length);
    return capCache;
  }

  /**
   * The user's profile username: stored, or made now (a 409 means it exists already, which is fine). → { username,
   * made } (made: Upload-Post created it just now, so it has no accounts yet).
   */
  async function ensureProfile(userId) {
    const { value: doc } = await readDoc(userId);
    if (forgotten(doc)) throw fail(409, 'FORBIDDEN', 'This account is being deleted.');
    if (USERNAME.test(String(doc.username ?? ''))) return { username: doc.username, made: false };
    const tag = await ensureCustomer(db, userId, env).catch((e) => {
      if (e instanceof IntegrationError) throw e;
      throw fail(503, 'UNAVAILABLE', 'Couldn’t start connecting just now. Try again shortly.');
    });
    const username = usernameFor(tag);
    const made = await createProfile(username, tag);
    await updateDoc(userId, (d) => {
      d.customer = tag;
      d.username = username;
      d.createdAt = d.createdAt ?? iso(now());
      delete d.reclaimedAt;
      return { value: d };
    });
    log_('uploadpost_profile_ready', {});
    return { username, made };
  }

  /** One of today's new-profile slots (UPLOAD_POST_NEW_PROFILES_PER_DAY), or false when they're used up. */
  async function takeNewProfileSlot() {
    const key = `uploadpost:new-profiles:${iso(now()).slice(0, 10)}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let got;
      try {
        got = await storage.get(key);
      } catch {
        return true;
      }
      const n = Number(got?.value?.n) || 0;
      if (n >= newProfilesPerDay) return false;
      try {
        await storage.put(key, { n: n + 1 }, { ifVersion: got?.updatedAt ?? null });
        return true;
      } catch (e) {
        if (e?.code !== 'CONFLICT') return true;
      }
    }
    return true;
  }

  /** → true when Upload-Post made it now, false when it was there already (409, or in the plan's list). */
  async function createProfile(username, tag) {
    const cap = await capInfo().catch(() => null);
    const listed = !!cap?.profiles.some((p) => p.username === username);
    if (cap?.limit && !listed) {
      const remaining = cap.limit - cap.used;
      if (remaining <= 0) {
        ownerAlert('profile_cap');
        throw capFull();
      }
      if (remaining <= alertRemaining) ownerAlert('profile_cap_low');
    }
    if (!listed && !(await takeNewProfileSlot())) {
      ownerAlert('profile_budget');
      throw fail(503, 'CONNECTIONS_UNAVAILABLE', 'Social connections are temporarily full. We’ve been notified and will let you know.', {}, `More than ${newProfilesPerDay} new customers started connecting social accounts today (UPLOAD_POST_NEW_PROFILES_PER_DAY): check they're real, then raise it if they are.`);
    }
    const made = await call('POST', '/uploadposts/users', { body: { username, display_name: `Customer ${String(tag).slice(5, 13)}` }, headers: { 'Idempotency-Key': `profile-${username}` } });
    if ((made.status >= 200 && made.status < 300) || made.status === 409) {
      if (capCache && made.status !== 409) capCache = { ...capCache, used: capCache.used + 1, profiles: [...capCache.profiles, { username }] };
      return made.status !== 409;
    }
    throw callFailure(made);
  }

  // ───────────── connect and reconnect (the hosted white-label page) ─────────────

  function branding(username, platform) {
    const logo = httpsUrl(String(env.UPLOAD_POST_BRAND_LOGO_URL || '').trim());
    // every field, every time: Upload-Post clears the ones left out. The back button opens Settings → Connected
    // accounts (the app routes by #hash; ?settings=accounts picks the section), where the profile is read back.
    return {
      username,
      redirect_url: `${appOrigin(env)}/?settings=accounts#workspace-settings`,
      ...(logo ? { logo_image: logo } : {}),
      redirect_button_text: clip(env.UPLOAD_POST_BACK_BUTTON_TEXT || 'Back to Yourlocalbusiness', 60),
      connect_title: clip(env.UPLOAD_POST_CONNECT_TITLE || 'Connect your social accounts', 100),
      connect_description: clip(env.UPLOAD_POST_CONNECT_DESCRIPTION || 'Sign in to the account your business posts from. You can disconnect it at any time in the app.', 300),
      platforms: [UP_PLATFORM[platform]],
      show_calendar: false,
      readonly_calendar: false,
      connect_theme: 'light',
    };
  }

  async function startConnect(userId, platform, { projectId, reconnect = false } = {}) {
    requireSetUp();
    if (!SOCIAL_PLATFORMS.includes(platform)) throw fail(404, 'NOT_FOUND', 'Unknown account type.');
    if (PHASE2_PLATFORMS.includes(platform)) throw fail(400, 'BAD_REQUEST', `${NAMES[platform]} is coming soon.`);
    const { username, made } = await ensureProfile(userId);
    let { value: doc } = await readDoc(userId);
    if (!reconnect) {
      // the profile as Upload-Post has it now: an account whose webhook never came is connected already
      if (!made || doc.accounts?.[platform]?.state === 'connected') doc = (await sync(userId).catch(() => null)) ?? doc;
      if (doc.accounts?.[platform]?.state === 'connected') {
        log_('uploadpost_connect_already', { platform });
        return { alreadyConnected: true };
      }
    }
    let res = await call('POST', '/uploadposts/users/generate-jwt', { body: branding(username, platform) });
    if (res.status === 404) {
      // the profile went missing at Upload-Post (deleted by hand?): made again once, then asked once more
      const tag = doc.customer ?? tagForUsername(username);
      await createProfile(username, tag);
      res = await call('POST', '/uploadposts/users/generate-jwt', { body: branding(username, platform) });
    }
    if (res.status < 200 || res.status >= 300) {
      log_('uploadpost_connect_failed', { platform, status: res.status, code: upError(res).code });
      throw callFailure(res, platform);
    }
    const link = typeof res.body?.access_url === 'string' ? res.body.access_url : '';
    let u = null;
    try {
      u = new URL(link);
    } catch {
      u = null;
    }
    const localMock = up.base !== 'https://api.upload-post.com/api';
    if (!u || (u.protocol !== 'https:' && !(localMock && u.protocol === 'http:'))) {
      log_('uploadpost_connect_bad_answer', { platform });
      throw fail(502, 'UNAVAILABLE', 'Couldn’t start connecting just now. Try again shortly.');
    }
    await updateDoc(userId, (d) => {
      d.pending[platform] = { at: iso(now()), ...(projectId ? { projectId } : {}) };
      delete d.lastError[platform];
      return { value: d };
    });
    log_('uploadpost_connect_started', { platform, reconnect });
    // a fresh link per click (Upload-Post's last 48 hours); it is never stored or logged
    return { connectLink: link, expiresAt: iso(now() + LINK_LIFETIME_MS) };
  }

  // ───────────── reading the accounts back ─────────────

  /** The Pages a profile can post to (always with profile=), as { id: label }; null when the read failed. */
  async function readPages(username, platform) {
    const res = await call('GET', `/uploadposts/${platform}/pages`, { query: { profile: username }, retry429: true });
    // LinkedIn answers 404 when the member administers no page
    if (res.status === 404) return {};
    if (res.status < 200 || res.status >= 300) return null;
    const out = {};
    for (const p of (Array.isArray(res.body?.pages) ? res.body.pages : []).filter(isObj).slice(0, 100)) {
      const id = String(p.id ?? p.urn ?? p.page_id ?? '');
      if (!/^[A-Za-z0-9:_.-]{1,120}$/.test(id)) continue;
      out[id] = clip(p.name ?? p.page_name ?? p.title ?? NAMES[platform], 80);
    }
    return out;
  }

  /**
   * The Page pinned on the profile (the hosted connect page lets the customer pick one, and a pin wins over the
   * Page sent with each post): { id, name } | '' (none) | { reauth: true } (this customer's Facebook sign-in ran
   * out: Upload-Post answers 401 facebook_reauth_required here) | null (the read failed). The answer is
   * { pages[], selected_page_id, selected_page_name }, selected_page_id null without a pin.
   */
  async function readPin(username, platform) {
    const res = await call('GET', `/uploadposts/users/${platform}-page`, { query: { profile_username: username }, retry429: true });
    if (res.status === 404) return '';
    if (isSocialReauth(res)) return { reauth: true };
    if (res.status < 200 || res.status >= 300) return null;
    const b = isObj(res.body) ? res.body : {};
    const raw = b.selected_page_id ?? b[`${platform}_page_id`] ?? null;
    if (raw === null || raw === undefined || raw === '') return '';
    const id = String(raw);
    return /^[A-Za-z0-9:_.-]{1,120}$/.test(id) ? { id, name: clip(b.selected_page_name ?? b[`${platform}_page_name`] ?? '', 80) } : null;
  }

  /** A pinned Page's id as the Pages list has it (LinkedIn takes a URN or its number). */
  function pinnedId(id, pages = {}) {
    if (pages[id]) return id;
    const num_ = /^\d+$/.test(id) ? id : (/^urn:li:organization:(\d+)$/.exec(id)?.[1] ?? '');
    if (num_) {
      if (pages[num_]) return num_;
      if (pages[`urn:li:organization:${num_}`]) return `urn:li:organization:${num_}`;
    }
    return id;
  }

  /** GET /uploadposts/users/{username} → the doc's accounts (labels, state), Pages and pins. */
  async function sync(userId) {
    const { value: doc } = await readDoc(userId);
    if (!USERNAME.test(String(doc.username ?? ''))) return doc;
    const username = doc.username;
    lastSync.set(userId, now());
    if (lastSync.size > 5000) for (const [k, at] of lastSync) if (now() - at > 3_600_000) lastSync.delete(k);
    const res = await call('GET', `/uploadposts/users/${username}`, { retry429: true });
    let social = {};
    if (res.status === 404) social = {};
    else if (res.status < 200 || res.status >= 300) throw callFailure(res);
    else social = isObj(res.body?.profile?.social_accounts) ? res.body.profile.social_accounts : {};
    const extra = {};
    for (const platform of ['facebook', 'linkedin']) {
      const a = social[UP_PLATFORM[platform]];
      if (!isObj(a)) continue;
      const [pages, pin] = await Promise.all([readPages(username, platform), readPin(username, platform)]);
      extra[platform] = { pages, pin };
    }
    return updateDoc(userId, (d) => {
      const next = {};
      for (const [upKey, a] of Object.entries(social)) {
        const platform = FROM_UP[upKey];
        if (!platform || !SOCIAL_PLATFORMS.includes(platform)) continue;
        // "" or null: not connected. A non-empty string: a credential channel (not one of ours)
        if (!isObj(a)) continue;
        const key = clip(a.username ?? '', 120);
        const old = d.accounts[platform];
        // a different account came in: this platform's choices start over
        if (old && old.key && key && old.key !== key) {
          for (const map of Object.values(d.choice)) delete map?.[platform];
          delete d.pages[platform];
        }
        next[platform] = {
          key,
          label: clip(a.display_name || (a.handle ? `@${String(a.handle).replace(/^@/, '')}` : '') || NAMES[platform], 80),
          state: a.reauth_required === true ? 'needs_reconnect' : 'connected',
          ...(Array.isArray(a.capabilities) ? { capabilities: a.capabilities.filter((c) => typeof c === 'string').slice(0, 30).map((c) => clip(c, 40)) } : {}),
          connectedAt: old?.key === key && old?.connectedAt ? old.connectedAt : iso(now()),
        };
        if (d.pending[platform]) delete d.pending[platform];
      }
      d.accounts = next;
      for (const platform of ['facebook', 'linkedin']) {
        if (!next[platform]) {
          delete d.pages[platform];
          delete d.pins[platform];
          continue;
        }
        const got = extra[platform];
        if (got?.pages) d.pages[platform] = got.pages;
        if (got?.pin === '') delete d.pins[platform];
        else if (got?.pin?.reauth) next[platform].state = 'needs_reconnect';
        else if (got?.pin?.id) {
          const id = pinnedId(got.pin.id, d.pages[platform]);
          d.pins[platform] = id;
          // a pinned Page the list didn't show still gets its name (posts go there whatever the list says)
          if (!d.pages[platform]?.[id] && got.pin.name) d.pages[platform] = { ...(d.pages[platform] ?? {}), [id]: got.pin.name };
        }
      }
      for (const [key, map] of Object.entries(d.choice)) {
        for (const p of Object.keys(map ?? {})) if (!next[p]) delete map[p];
        if (!Object.keys(map ?? {}).length) delete d.choice[key];
      }
      return { value: d, result: d };
    });
  }

  async function check(userId, platform, { projectId } = {}) {
    requireSetUp();
    const doc = await sync(userId);
    return statusOf(doc, platform, projectId);
  }

  async function disconnect(userId, platform) {
    requireSetUp();
    const { value: doc } = await readDoc(userId);
    if (USERNAME.test(String(doc.username ?? '')) && doc.accounts?.[platform]) {
      // one attempt; a 404 means it's already gone. Every business of this customer stops using it.
      const res = await call('DELETE', '/uploadposts/users/social', { body: { profile_username: doc.username, social_platform: UP_PLATFORM[platform] } });
      if ((res.status < 200 || res.status >= 300) && res.status !== 404) throw callFailure(res, platform);
    }
    await updateDoc(userId, (d) => {
      delete d.accounts[platform];
      delete d.pending[platform];
      delete d.pages[platform];
      delete d.pins[platform];
      for (const [key, map] of Object.entries(d.choice)) {
        delete map?.[platform];
        if (!Object.keys(map ?? {}).length) delete d.choice[key];
      }
      return { value: d };
    });
    log_('uploadpost_disconnected', { platform });
  }

  async function targets(userId, platform) {
    requireSetUp();
    const { value: doc } = await readDoc(userId);
    const acct = doc.accounts?.[platform];
    if (!acct || !USERNAME.test(String(doc.username ?? ''))) return [];
    if (platform !== 'facebook' && platform !== 'linkedin') return [{ id: handleOf(platform, acct.key || platform), label: acct.label, kind: TARGET_KIND[platform] }];
    const pages = (await readPages(doc.username, platform)) ?? doc.pages?.[platform] ?? {};
    await updateDoc(userId, (d) => {
      d.pages[platform] = pages;
      return { value: d };
    }).catch(() => null);
    // every Page, a pinned one too: choosing another for a business clears the pin (setTarget)
    const list = [];
    if (platform === 'linkedin') list.push({ id: handleOf(platform, PERSONAL), label: acct.label, kind: 'li_person' });
    for (const [id, label] of Object.entries(pages)) list.push({ id: handleOf(platform, id), label, kind: platform === 'facebook' ? 'fb_page' : 'li_org' });
    return list;
  }

  async function setTarget(userId, platform, targetId, { projectId } = {}) {
    requireSetUp();
    if (!TARGET_ID.test(String(targetId))) throw fail(400, 'BAD_REQUEST', 'Choose one of the listed accounts.');
    const { value: doc } = await readDoc(userId);
    const acct = doc.accounts?.[platform];
    if (!acct) throw fail(400, 'BAD_REQUEST', 'Choose one of the listed accounts.');
    if (platform !== 'facebook' && platform !== 'linkedin') {
      if (handleOf(platform, acct.key || platform) !== targetId) throw fail(400, 'BAD_REQUEST', 'Choose one of the listed accounts.');
      return statusOf(doc, platform, projectId);
    }
    const ids = [...(platform === 'linkedin' ? [PERSONAL] : []), ...Object.keys(doc.pages?.[platform] ?? {})];
    const id = ids.find((x) => handleOf(platform, x) === targetId);
    if (!id) throw fail(400, 'BAD_REQUEST', 'Choose one of the listed accounts.');
    const pin = doc.pins?.[platform];
    if (pin && pin !== id && USERNAME.test(String(doc.username ?? ''))) {
      // a Page pinned on the connect page wins over the Page each post names, so this business's choice would be
      // ignored: the pin goes (one attempt; 404 means it's gone already), and businesses that never chose keep
      // the pinned Page as their default below
      const res = await call('DELETE', `/uploadposts/users/${platform}-page`, { body: { profile_username: doc.username } });
      if ((res.status < 200 || res.status >= 300) && res.status !== 404) {
        if (isSocialReauth(res)) await markReconnect(userId, platform);
        throw callFailure(res, platform);
      }
      log_('uploadpost_pin_cleared', { platform });
    }
    return updateDoc(userId, (d) => {
      const key = projectId ?? DEFAULT;
      const was = d.pins[platform];
      if (was && was !== id) {
        if (key !== DEFAULT && !d.choice[DEFAULT]?.[platform]) d.choice[DEFAULT] = { ...(d.choice[DEFAULT] ?? {}), [platform]: was };
        delete d.pins[platform];
      }
      // this business only: another business never inherits it
      d.choice[key] = { ...(d.choice[key] ?? {}), [platform]: id };
      return { value: d, result: statusOf(d, platform, projectId) };
    });
  }

  // ───────────── ledger (Upload-Post calls per customer, next to treg's and Zernio's) ─────────────

  async function ledger(row) {
    if (!dbReady || !row.customer_tag) return;
    try {
      await db.insert('usage_ledger', { vendor: 'uploadpost', cost_micro: 0, estimated: false, ...row });
    } catch {
      log_('uploadpost_ledger_failed', { endpoint: row.endpoint });
    }
  }

  const tagOf = (doc, userId) => {
    if (doc.customer) return doc.customer;
    try {
      return customerTag(userId, env);
    } catch {
      return null;
    }
  };

  /** The account a read or a post uses, or a refusal in plain words. */
  async function usable(userId, platform, projectId) {
    requireSetUp();
    const { value: doc } = await readDoc(userId);
    if (forgotten(doc) || !USERNAME.test(String(doc.username ?? ''))) throw fail(409, 'NOT_CONNECTED', `${NAMES[platform]} isn’t connected.`);
    const acct = doc.accounts?.[platform];
    if (!acct) throw fail(409, 'NOT_CONNECTED', `${NAMES[platform]} isn’t connected.`);
    if (acct.state === 'needs_reconnect') throw fail(409, 'NEEDS_RECONNECT', `Reconnect ${NAMES[platform]} in Settings → Connected accounts.`);
    const page = pageFor(doc, platform, projectId);
    if (platform === 'facebook' && !page) throw fail(409, 'NOT_CONNECTED', 'Choose which Facebook Page to use in Settings → Connected accounts.');
    return { doc, username: doc.username, account: acct, page, tag: tagOf(doc, userId) };
  }

  // ───────────── own stats (reads) ─────────────

  function analyticsSlot() {
    const t = now();
    while (analyticsTimes.length && t - analyticsTimes[0] >= 300_000) analyticsTimes.shift();
    if (analyticsTimes.length >= ANALYTICS_PER_5_MIN) return false;
    analyticsTimes.push(t);
    return true;
  }

  async function insights(userId, platform, { projectId } = {}) {
    if (!SOCIAL_PLATFORMS.includes(platform)) return null;
    let got;
    try {
      got = await usable(userId, platform, projectId);
    } catch (e) {
      if (e?.code === 'NOT_CONNECTED') return null;
      if (e?.code === 'NEEDS_RECONNECT') throw Object.assign(new Error('reconnect'), { kind: 'reconnect' });
      throw e;
    }
    const { username, tag, page } = got;
    // LinkedIn has no stats for a personal profile: without page_urn Upload-Post would answer with the first company
    // page the member administers (maybe another business's), so a personal profile reads public data instead
    if (platform === 'linkedin' && (!page || page === PERSONAL)) return null;
    const read = async (path, query, endpoint) => {
      if (!analyticsSlot()) throw Object.assign(new Error('busy'), { kind: 'busy' });
      const res = await call('GET', path, { query, retry429: true });
      await ledger({ customer_tag: tag, user_id: userId, project_id: projectId ?? null, feature: 'social', endpoint: `${platform}:${endpoint}`, http_status: res.status, outcome: res.status < 400 ? 'ok' : res.status >= 500 ? 'unknown' : 'failed' });
      return res;
    };
    const q = { platforms: UP_PLATFORM[platform] };
    if (platform === 'facebook') Object.assign(q, { page_id: page, days: 30 });
    if (platform === 'linkedin' && page && page !== PERSONAL) q.page_urn = page;
    const res = await read(`/analytics/${username}`, q, 'GET /analytics');
    if (res.status < 200 || res.status >= 300) throw readFailure(res);
    const e = isObj(res.body?.[UP_PLATFORM[platform]]) ? res.body[UP_PLATFORM[platform]] : null;
    if (!e || e.success === false) throw Object.assign(new Error('no numbers'), { kind: /reauth|reconnect/i.test(String(e?.error_code ?? '')) ? 'reconnect' : 'upstream' });
    // a key that's missing is unknown, never 0
    const parts = ['likes', 'comments', 'shares', 'saves'].map((k) => num(e[k])).filter((v) => v !== undefined);
    // reach_timeseries counts what metric_type says: reach (Facebook, Instagram, LinkedIn), views (TikTok, YouTube,
    // Threads) or impressions (X, Pinterest); only reach is charted as reach
    const metric = ['reach', 'views', 'impressions'].includes(e.metric_type) ? e.metric_type : (SERIES_METRIC[platform] ?? 'reach');
    const series = (Array.isArray(e.reach_timeseries) ? e.reach_timeseries : [])
      .filter(isObj)
      .map((r) => ({ date: String(r.date ?? '').slice(0, 10), [metric]: num(r.value) ?? 0 }))
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    // no top posts and no post count here: Upload-Post's cached post stats only hold posts first read one by one
    // (and TikTok's video_count is a lifetime count, not this range's); the business's public posts fill those in
    return {
      followers: num(e.followers),
      reach: num(e.reach),
      views: num(e.views) ?? num(e.impressions),
      engagement: parts.length ? parts.reduce((a, b) => a + b, 0) : undefined,
      series,
    };
  }

  /** Ad results live on Zernio: nothing here. */
  async function adResults() {
    return null;
  }

  // ───────────── posting (one attempt) ─────────────

  /** The form an upload sends for one platform. path: '/upload' | '/upload_photos' | '/upload_text'. */
  function uploadFields(platform, { username, page, jobId, composed, mediaUrl, mediaKind, privacy }) {
    const text = String(composed?.text ?? '');
    const f = { user: username, 'platform[]': [UP_PLATFORM[platform]], request_id: jobId, external_id: String(jobId).slice(0, 200), title: text };
    if (mediaKind === 'video') Object.assign(f, { video: mediaUrl, async_upload: true });
    else if (mediaKind === 'image') f['photos[]'] = [mediaUrl];
    if (composed?.comment && ['facebook', 'instagram', 'linkedin'].includes(platform)) f.first_comment = composed.comment;
    switch (platform) {
      case 'facebook':
        if (page) f.facebook_page_id = page;
        if (mediaKind === 'video') Object.assign(f, { facebook_media_type: 'VIDEO', facebook_description: text });
        break;
      case 'linkedin':
        if (page && page !== PERSONAL) f.target_linkedin_page_id = page;
        // LinkedIn's commentary is `description` on media posts; the media title is at most 400 characters
        if (mediaKind) Object.assign(f, { title: clip(text.split('\n')[0] || 'Post', 400), linkedin_description: text });
        break;
      case 'tiktok':
        if (privacy) f.privacy_level = privacy;
        if (mediaKind === 'image') Object.assign(f, { tiktok_title: clip(text.split('\n')[0] || 'Post', 90), tiktok_description: text });
        break;
      case 'youtube':
        Object.assign(f, { title: composed.title, youtube_title: composed.title, description: composed.description ?? text, 'tags[]': Array.isArray(composed.tags) ? composed.tags : [], privacyStatus: 'public', selfDeclaredMadeForKids: false });
        break;
      default:
        break;
    }
    return f;
  }

  /**
   * TikTok's audience setting → { privacy? } | { error }. One asked for goes as it is (Upload-Post refuses one the
   * account doesn't have before anything reaches TikTok: TIKTOK_PRIVACY). A video without one sends none: TikTok
   * then uses the account's own default, the only choice that works on every account. A photo needs one (Upload-
   * Post's default, public, fails on a private account): public when the account has it, else its followers.
   */
  async function tiktokPrivacy(username, wanted, kind) {
    if (wanted !== undefined && wanted !== null && wanted !== '') return TIKTOK_PRIVACY.includes(wanted) ? { privacy: wanted } : { error: 'TIKTOK_PRIVACY' };
    if (kind !== 'image') return {};
    const res = await call('GET', '/uploadposts/tiktok/settings', { query: { profile: username }, retry429: true });
    if (res.status >= 200 && res.status < 300) {
      const options = (Array.isArray(res.body?.privacy_level_options) ? res.body.privacy_level_options : []).filter((o) => typeof o === 'string');
      if (options.includes('PUBLIC_TO_EVERYONE')) return { privacy: 'PUBLIC_TO_EVERYONE' };
      if (options.includes('FOLLOWER_OF_CREATOR')) return { privacy: 'FOLLOWER_OF_CREATOR' };
      return { error: 'TIKTOK_PRIVACY' };
    }
    // TikTok no longer accepts the connection (reauth_required, or 409): a reconnect
    if (res.status === 409 || res.body?.reauth_required === true) return { error: 'NEEDS_RECONNECT' };
    // an older connection this read doesn't support, or a hiccup: Upload-Post's own default goes, and a private
    // account's refusal comes back before anything reaches TikTok
    return {};
  }

  /** A definite refusal (4xx) of an upload → our outcome. Team-level ones tell the owner, never the customer. */
  function refusalOutcome(res) {
    const e = upError(res);
    // the account's own sign-in ran out (reauth_required): its reconnect, never our key
    if (isSocialReauth(res)) return { state: 'failed', errorCode: 'NEEDS_RECONNECT', reauth: true };
    if (res.local && e.status === 429) return { state: 'failed', errorCode: 'BUSY' };
    if (e.status === 401) return { state: 'failed', errorCode: 'SERVICE_UNAVAILABLE' };
    if (e.status === 403 || e.status === 404) {
      ownerAlert(e.code === 'PROFILE_BLOCKED' ? 'profile_blocked' : 'plan');
      return { state: 'failed', errorCode: 'SERVICE_UNAVAILABLE' };
    }
    if (e.status === 409) return { state: 'unknown', errorCode: 'UNCONFIRMED' };
    if (e.status === 429) {
      if (e.code === 'SCHEDULED_POSTS_LIMIT') {
        ownerAlert('scheduled_limit');
        return { state: 'failed', errorCode: 'SERVICE_UNAVAILABLE' };
      }
      if (e.violations.some((v) => v.type === 'hard_cap') || e.code === 'x_daily_write_limit') return { state: 'failed', errorCode: 'PLATFORM_LIMIT' };
      return { state: 'failed', errorCode: 'BUSY' };
    }
    // no requested platform is connected at Upload-Post: { invalid_platforms: { linkedin: "…" } } (an array too)
    const invalid = res.body?.invalid_platforms;
    if ((Array.isArray(invalid) && invalid.length) || (isObj(invalid) && Object.keys(invalid).length)) return { state: 'failed', errorCode: 'NOT_CONNECTED', resync: true };
    const v = e.violations.find((x) => x.type);
    return { state: 'failed', errorCode: jobErrorForCode(v?.type || e.code) };
  }

  /** One /status read for a request (our job id) → { state, url?, drafts?, errorCode? } for this platform. */
  async function readStatus(username, requestId, platform) {
    const res = await call('GET', '/uploadposts/status', { query: { request_id: requestId } });
    if (res.status === 404) return { state: 'pending', missing: true };
    if (res.status < 200 || res.status >= 300) return null;
    const b = isObj(res.body) ? res.body : {};
    const top = String(b.status ?? '');
    const entry = (Array.isArray(b.results) ? b.results : []).find((r) => isObj(r) && r.platform === UP_PLATFORM[platform]);
    let out = entry ? outcomeOfEntry(entry, { platform, top }) : { state: 'pending' };
    if (!entry && top === 'failed') out = { state: 'failed', errorCode: 'REFUSED' };
    if (out.state === 'sent' && !out.url && !out.drafts) {
      // the final address comes from the history when the status has none
      const h = await call('GET', '/uploadposts/history', { query: { request_id: requestId, profile_username: username, limit: 10 } }).catch(() => null);
      const row = (Array.isArray(h?.body?.history) ? h.body.history : []).find((r) => isObj(r) && r.platform === UP_PLATFORM[platform]);
      if (row?.fallback_to_inbox === true) out = { state: 'sent', drafts: true };
      else if (httpsUrl(row?.post_url)) out = { state: 'sent', url: row.post_url };
    }
    return out;
  }

  /** Poll /status for a request Upload-Post answers in the background: 5 s, then every 10 s (15 s for video). */
  async function poll(username, requestId, platform, video) {
    const deadline = now() + (video ? 10 * 60_000 : 2 * 60_000);
    let wait = 5_000;
    while (now() + wait <= deadline) {
      await sleep(wait);
      wait = video ? 15_000 : 10_000;
      const got = await readStatus(username, requestId, platform).catch(() => null);
      if (got && got.state !== 'pending') return got;
    }
    return { state: 'unknown', errorCode: 'UNCONFIRMED' };
  }

  async function markReconnect(userId, platform) {
    try {
      await updateDoc(userId, (d) => {
        if (!d.accounts[platform]) return { write: false };
        d.accounts[platform].state = 'needs_reconnect';
        return { value: d };
      });
    } catch {
      /* the next sync shows it */
    }
  }

  /** The job's ref fields for an outcome (`drafts` is kept so the app can say "sent to your TikTok drafts"). */
  const withRef = (out, ref) => ({ state: out.state, ...(out.url ? { url: out.url } : {}), ...(out.errorCode ? { errorCode: out.errorCode } : {}), ref: { ...ref, ...(out.drafts ? { outcome: 'drafts' } : {}) } });

  const monthStart = () => {
    const t = new Date(now());
    return iso(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
  };

  /** X posts with a link this month (`x:link_post` rows), one customer's or everyone's; null when unreadable. */
  async function xLinkPosts(tag) {
    if (!dbReady) return null;
    try {
      const rows = await db.select('usage_ledger', { vendor: 'uploadpost', endpoint: 'x:link_post', created_at: ['gte', monthStart()], ...(tag ? { customer_tag: tag } : {}) }, { select: 'id', limit: 1000 });
      return rows.length;
    } catch {
      return null;
    }
  }

  /** An X post with a link went (or may have): counted for this customer, and the owner hears when few are left. */
  async function noteXLink({ tag, userId, projectId, jobId, out, warned }) {
    await ledger({ customer_tag: tag, user_id: userId, project_id: projectId ?? null, call_id: jobId, feature: 'posting', endpoint: 'x:link_post', outcome: out.state === 'sent' ? 'ok' : 'unknown' });
    if (warned) ownerAlert('x_links');
    const all = await xLinkPosts(null);
    if (all !== null && all >= X_LINKS_POOL_ALERT) ownerAlert('x_links_low', { n: all });
  }

  /**
   * Post one saved post on the business's account: one upload (media as our short-lived public link), then, for
   * an answer that comes in the background, status reads by the job id. → { state: 'sent'|'failed'|'unknown',
   * url?, errorCode?, ref }. Never throws after the upload was sent; never sends again.
   */
  async function publish(userId, platform, { projectId, jobId, composed, media, privacy } = {}) {
    const ref = { via: 'upload_post', requestId: jobId, platform };
    let picked;
    try {
      picked = await usable(userId, platform, projectId);
    } catch (e) {
      return { state: 'failed', errorCode: e?.code === 'NEEDS_RECONNECT' ? 'NEEDS_RECONNECT' : 'NO_TARGET', ref };
    }
    const { username, page, tag } = picked;
    let mediaUrl;
    if (media) {
      try {
        mediaUrl = publicMediaUrl(env, { userId, mediaId: media.id, kind: media.kind, type: media.type }, now());
      } catch {
        if (!mediaReady) ownerAlert('media_secret');
        return { state: 'failed', errorCode: 'MEDIA_UPLOAD_FAILED', ref };
      }
    }
    // X: with the X Links add-on, links stay in X posts out of 50 a month for every customer together, so each
    // customer has a share (without it Upload-Post takes links out, and the app says so before posting)
    const xLink = platform === 'x' && xLinks && X_LINKISH.test(String(composed?.text ?? ''));
    if (xLink) {
      const used = await xLinkPosts(tag);
      if (used !== null && used >= xLinkPostsPerCustomer) return { state: 'failed', errorCode: 'X_LINKS_USED', ref };
    }
    let tiktok = {};
    if (platform === 'tiktok') {
      tiktok = await tiktokPrivacy(username, privacy, media?.kind).catch(() => ({}));
      if (tiktok.error) {
        if (tiktok.error === 'NEEDS_RECONNECT') await markReconnect(userId, platform);
        return { state: 'failed', errorCode: tiktok.error, ref };
      }
    }
    const path = media ? (media.kind === 'video' ? '/upload' : '/upload_photos') : '/upload_text';
    const form = uploadFields(platform, { username, page, jobId, composed, mediaUrl, mediaKind: media?.kind, privacy: tiktok.privacy });
    const sent = await oneShot(async () => up.call('POST', path, { form, headers: { 'Idempotency-Key': jobId }, timeoutMs: 120_000 }));
    const res = sent.value;
    await ledger({ customer_tag: tag, user_id: userId, project_id: projectId ?? null, call_id: jobId, feature: 'posting', endpoint: `${platform}:POST ${path}`, http_status: res?.status ?? null, outcome: sent.outcome === 'ok' ? 'ok' : sent.outcome === 'failed' ? 'failed' : 'unknown' });
    if (sent.outcome === 'unknown') {
      if (xLink) await noteXLink({ tag, userId, projectId, jobId, out: { state: 'unknown' } });
      return { state: 'unknown', errorCode: 'UNCONFIRMED', ref };
    }
    if (sent.outcome === 'failed') {
      const refused = refusalOutcome(res);
      // the account isn't connected at Upload-Post any more: the doc learns it now (one read), not on every post
      if (refused.resync) await sync(userId).catch(() => null);
      if (refused.reauth) await markReconnect(userId, platform);
      return withRef(refused, ref);
    }
    const body = isObj(res?.body) ? res.body : {};
    // an identical upload a moment ago answers with that request's id: its status is read by that id
    const requestId = typeof body.request_id === 'string' && REQUEST_ID.test(body.request_id) ? body.request_id : jobId;
    const at = requestId === jobId ? ref : { ...ref, requestId };
    const entry = isObj(body.results) ? body.results[UP_PLATFORM[platform]] : null;
    let out;
    if (entry) out = outcomeOfEntry(entry, { platform, final: true });
    else if (typeof body.request_id === 'string') out = await poll(username, requestId, platform, media?.kind === 'video');
    else out = { state: 'unknown', errorCode: 'UNCONFIRMED' };
    if (out.state === 'sent' && !out.url && !out.drafts && entry) {
      const later = await readStatus(username, requestId, platform).catch(() => null);
      if (later?.state === 'sent') out = later;
    }
    if (out.state === 'pending') out = { state: 'unknown', errorCode: 'UNCONFIRMED' };
    if (out.reauth || out.errorCode === 'NEEDS_RECONNECT') await markReconnect(userId, platform);
    if (xLink && out.state !== 'failed') {
      const warned = (Array.isArray(entry?.warnings) ? entry.warnings : []).some((w) => /link|url/i.test(typeof w === 'string' ? w : JSON.stringify(w ?? '')));
      await noteXLink({ tag, userId, projectId, jobId, out, warned });
    }
    return withRef(out, at);
  }

  /**
   * "Check again" for a job whose outcome is unknown: one /status read by the job id (plus the history for the
   * address). → { found: true, url?, drafts? } | { failed: true, errorCode } | { pending: true } | null.
   */
  async function postStatus(userId, ref = {}) {
    if (!setUp || !SOCIAL_PLATFORMS.includes(ref.platform)) return null;
    const { value: doc } = await readDoc(userId);
    if (!USERNAME.test(String(doc.username ?? ''))) return null;
    const requestId = String(ref.requestId ?? ref.jobId ?? '');
    if (!REQUEST_ID.test(requestId)) return null;
    const got = await readStatus(doc.username, requestId, ref.platform);
    if (!got) return null;
    if (got.state === 'sent') return { found: true, ...(got.url ? { url: got.url } : {}), ...(got.drafts ? { drafts: true, ref: { outcome: 'drafts' } } : {}) };
    if (got.state === 'failed') {
      if (got.errorCode === 'NEEDS_RECONNECT') await markReconnect(userId, ref.platform);
      return { failed: true, errorCode: got.errorCode };
    }
    return { pending: true, ...(got.missing ? { missing: true } : {}) };
  }

  // ───────────── webhooks ─────────────

  /**
   * The customer a profile_username belongs to: ylb_<hex> → cust_<hex> → billing_customers → user, or null. The
   * stored doc must name that profile; a doc that lost the name (it couldn't be read after a secret change) takes it
   * back, since the name comes from the customer's own tag.
   */
  async function userOfProfile(profileUsername) {
    const tag = tagForUsername(profileUsername);
    if (!tag) return null;
    const rows = await db.select('billing_customers', { customer_tag: tag }, { select: 'customer_tag,user_id', limit: 1 });
    const userId = rows[0]?.user_id;
    if (!userId) return null;
    const { value: doc } = await readDoc(userId);
    if (doc.username === profileUsername) return { userId, doc };
    if (USERNAME.test(String(doc.username ?? '')) || usernameFor(tag) !== profileUsername || forgotten(doc)) return null;
    const adopted = await updateDoc(userId, (d) => {
      if (d.username) return { write: false, result: null };
      d.customer = tag;
      d.username = profileUsername;
      d.createdAt = d.createdAt ?? iso(now());
      return { value: d, result: d };
    }).catch(() => null);
    return adopted ? { userId, doc: adopted } : null;
  }

  async function applyEvent(evt) {
    const type = String(evt.event ?? '');
    if (type === 'social_account_reauth_required' && !evt.profile_username) {
      // the documented reauth example has no profile: the profiles whose accounts changed are read again (one list
      // of every profile, at most every 10 minutes however many of these come)
      if (now() - lastFullRead < FULL_READ_EVERY_MS) return 'recent';
      lastFullRead = now();
      await reconcileAccounts();
      return 'reconciled';
    }
    const who = await userOfProfile(String(evt.profile_username ?? ''));
    if (!who) return 'not_ours';
    const { userId } = who;
    if (/^social_account_(connected|disconnected|reauth_required)$/.test(type)) {
      await sync(userId);
      const platform = FROM_UP[String(evt.platform ?? '')];
      if (type === 'social_account_reauth_required' && platform) await markReconnect(userId, platform);
      return 'applied';
    }
    if (type === 'upload_completed') {
      const jobId = String(evt.request_id ?? '');
      const platform = FROM_UP[String(evt.platform ?? '')];
      if (!/^[0-9a-f-]{36}$/i.test(jobId) || !platform || !postListener) return 'ignored';
      const result = isObj(evt.result) ? evt.result : {};
      let out = outcomeOfEntry(result, { platform, final: true });
      if (out.state !== 'sent' && out.state !== 'failed') return 'ignored';
      if (platform === 'tiktok' && out.state === 'sent' && !out.url && !out.drafts) {
        // the event has no fallback_to_inbox flag: a TikTok with no web address may be in the account's drafts
        // (video drafts carry "Video sent to Inbox (No Public URL)" as their post_url), so the status says which
        const read = USERNAME.test(String(who.doc.username ?? '')) ? await readStatus(who.doc.username, jobId, platform).catch(() => null) : null;
        if (read?.state === 'sent') out = read;
        else if (typeof result.post_url === 'string' && result.post_url.trim() && !httpsUrl(result.post_url)) out = { state: 'sent', drafts: true };
      }
      if (out.reauth) await markReconnect(userId, platform);
      await postListener(userId, jobId, { state: out.state, platform, ...(out.url ? { url: out.url } : {}), ...(out.errorCode ? { errorCode: out.errorCode } : {}), ...(out.drafts ? { drafts: true } : {}) });
      return 'applied';
    }
    return 'ignored';
  }

  // the webhook's work, after its answer went out: a few at a time, each one's failure only logged
  const webhookQueue = [];
  let webhookWorkers = 0;
  function pumpWebhooks() {
    while (webhookWorkers < WEBHOOK_WORKERS && webhookQueue.length) {
      const work = webhookQueue.shift();
      webhookWorkers += 1;
      void work().finally(() => {
        webhookWorkers -= 1;
        pumpWebhooks();
      });
    }
  }
  function afterAnswer(evt) {
    const done = new Promise((resolve) => {
      webhookQueue.push(async () => {
        try {
          const outcome = await applyEvent(evt);
          log_('uploadpost_webhook', { event: clip(evt.event, 60), outcome });
        } catch {
          // Upload-Post doesn't send it again: status polling, the reads while a connect waits and the daily check catch up
          log_('uploadpost_webhook_failed', { event: clip(evt.event, 60) });
        } finally {
          resolve();
        }
      });
    });
    track(done);
    pumpWebhooks();
  }

  /** The key a repeat of the same event has too (X-Upload-Post-Delivery is new on every delivery, so it isn't one). */
  function dedupeKeyOf(evt, rawBody) {
    const safe = (v) => (typeof v === 'string' && /^[A-Za-z0-9_.:@-]{1,120}$/.test(v) ? v : '');
    const type = safe(evt.event);
    if (type === 'upload_completed') {
      const id = safe(evt.result?.post_id) || safe(evt.result?.publish_id);
      const req = safe(evt.request_id);
      // a success after a failure (Upload-Post retried it) is a new answer, never a repeat of the failure
      const outcome = evt.result?.success === true ? `ok:${id}` : 'failed';
      if (req && safe(evt.platform)) return `uploadpost:${req}:${safe(evt.platform)}:${type}:${outcome}`;
      if (id) return `uploadpost:post:${id}`;
    }
    if (type && safe(evt.profile_username) && safe(evt.platform) && safe(evt.created_at)) return `uploadpost:${type}:${evt.profile_username}:${evt.platform}:${evt.created_at}`;
    return `uploadpost:${sha256(rawBody)}`;
  }

  /**
   * POST /api/webhooks/upload-post: rawBody is the exact bytes. → { status, body }. Nothing is read or written for
   * a delivery whose signature (or timestamp) doesn't check out. A good one is recorded and answered 200 at once;
   * its work (profile reads, the job) runs afterwards, since Upload-Post waits only 10 s, pauses every delivery for
   * 30 minutes after 5 failures and never sends one again (a 5xx would only count toward that pause). A repeat of
   * an event answers 200 and does nothing.
   */
  async function webhook(rawBody, headers = {}) {
    if (!up.webhookReady || !dbReady || !storageReady) return { status: 503, body: { error: 'Not set up.', code: 'NOT_SET_UP' } };
    if (!up.verifySignature(rawBody, headers)) return { status: 401, body: { error: 'Bad signature.', code: 'FORBIDDEN' } };
    let evt;
    try {
      evt = JSON.parse(Buffer.from(rawBody).toString('utf8'));
    } catch {
      return { status: 400, body: { error: 'Bad request.', code: 'BAD_REQUEST' } };
    }
    if (!isObj(evt)) return { status: 400, body: { error: 'Bad request.', code: 'BAD_REQUEST' } };
    const dedupeKey = dedupeKeyOf(evt, rawBody);
    try {
      const seen = await db.select('webhook_deliveries', { body_hash: dedupeKey }, { select: 'body_hash', limit: 1 });
      if (seen.length) return { status: 200, body: { ok: true, duplicate: true } };
    } catch {
      /* can't tell: worked on anyway (a repeat applies the same change again, which is harmless) */
    }
    try {
      await db.upsert('webhook_deliveries', { body_hash: dedupeKey, received_at: iso(now()) }, { onConflict: 'body_hash' });
    } catch {
      /* a repeat would apply the same change again: harmless */
    }
    afterAnswer(evt);
    return { status: 200, body: { ok: true } };
  }

  // ───────────── account deletion ─────────────

  /** The profiles our own account deletion marked for deleting ({ username: { at } }), as stored. */
  async function readGone() {
    const got = await storage.get(GONE_KEY);
    return { map: isObj(got?.value) ? got.value : {}, version: got?.updatedAt ?? null };
  }

  /** Mark (or unmark) a profile for deleting: the daily check deletes a marked one whose customer is gone. */
  async function markGone(username, on) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { map, version } = await readGone();
      if (on ? map[username] : !map[username]) return;
      const next = { ...map };
      if (on) next[username] = { at: iso(now()) };
      else delete next[username];
      try {
        await storage.put(GONE_KEY, next, { ifVersion: version });
        return;
      } catch (e) {
        if (e?.code !== 'CONFLICT') throw e;
      }
    }
  }

  /**
   * Before the account is deleted: social stops (status reads "Not connected", nothing posts) and the profile is
   * marked for deleting, but nothing at Upload-Post goes yet: a deletion that stops half way (unforgetUser) leaves
   * every connection as it was. The profile goes in userDeleted, once the account is gone.
   */
  async function forgetUser(userId) {
    if (!storageReady) return;
    const { value: doc } = await readDoc(userId);
    if (USERNAME.test(String(doc.username ?? ''))) {
      try {
        await markGone(doc.username, true);
      } catch {
        throw fail(503, 'UNAVAILABLE', 'Couldn’t disconnect your accounts just now. Try again shortly.');
      }
    }
    await updateDoc(userId, (d) => {
      d.forgottenAt = iso(now());
      return { value: d };
    });
  }

  async function unforgetUser(userId) {
    if (!storageReady) return;
    const { value: doc } = await readDoc(userId);
    await updateDoc(userId, (d) => {
      if (!d.forgottenAt) return { write: false };
      delete d.forgottenAt;
      return { value: d };
    });
    if (USERNAME.test(String(doc.username ?? ''))) await markGone(doc.username, false).catch(() => log_('uploadpost_unmark_failed', {}));
  }

  /**
   * After the account is gone (best effort): its profile's estimated cost so far (the monthly run won't see a
   * customer who's gone), then the profile at Upload-Post with every account in it (one attempt; 404 means gone
   * already; a failure stays marked for the daily check), then the doc.
   */
  async function userDeleted(userId) {
    if (!storageReady) return;
    const { value: doc } = await readDoc(userId);
    if (!USERNAME.test(String(doc.username ?? ''))) return;
    const tag = doc.customer ?? tagForUsername(doc.username);
    if (tag) await meterGoneCustomer(tag, doc).catch(() => log_('uploadpost_meter_failed', {}));
    if (setUp) {
      const res = await call('DELETE', '/uploadposts/users', { body: { username: doc.username } }).catch(() => null);
      if (res && ((res.status >= 200 && res.status < 300) || res.status === 404)) {
        capCache = null;
        await markGone(doc.username, false).catch(() => null);
      } else log_('uploadpost_profile_delete_failed', { status: res?.status ?? null });
    }
    await updateDoc(userId, (d) => ({ value: { ...blankDoc(), customer: d.customer, forgottenAt: d.forgottenAt ?? iso(now()), deletedAt: iso(now()) } })).catch(() => null);
  }

  // ───────────── the owner's view, the monthly estimate and the daily reconcile ─────────────

  /** How many social accounts a customer has connected now (the owner's per-customer view). */
  async function accountCount(userId) {
    if (!storageReady) return 0;
    const { value } = await readDoc(userId);
    return forgotten(value) ? 0 : Object.keys(value.accounts ?? {}).length;
  }

  /** For the owner's billing view: profiles used out of the plan's limit, and the most serious current alert. */
  async function ownerView() {
    if (!setUp) return null;
    const cap = await capInfo().catch(() => null);
    const got = await storage.get(ALERTS_KEY).catch(() => null);
    const map = isObj(got?.value) ? got.value : {};
    const live = ALERT_RANK.filter((k) => {
      const at = Date.parse(map[k]?.at);
      return Number.isFinite(at) && now() - at < (k === 'analytics_limit' ? DAY_MS : ALERT_TTL_MS);
    });
    const top = live[0];
    const alert = top ? { kind: top, at: clip(map[top].at, 40), ...(Number.isFinite(map[top].n) ? { n: map[top].n } : {}) } : null;
    return { ...(cap ? { profilesUsed: cap.used, ...(cap.limit ? { profilesLimit: cap.limit } : {}) } : {}), ...(alert ? { alert } : {}) };
  }

  /** A month as [start, end) in ms and its 'YYYY-MM' name; offset -1 is last month. */
  function monthOf(offset) {
    const t = new Date(now());
    const start = Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + offset, 1);
    const end = Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + offset + 1, 1);
    return { start, end, name: iso(start).slice(0, 7), days: (end - start) / DAY_MS };
  }

  /**
   * One profile's estimated cost inside [start, until) of a month (the plan price over its profiles, prorated by
   * days): the profile's current life (createdAt → deletion or now) and, when it was reclaimed once, its last one.
   */
  function profileMicro(doc, month, until = month.end) {
    const lives = [];
    if (USERNAME.test(String(doc.username ?? ''))) lives.push([Date.parse(doc.createdAt), Date.parse(doc.forgottenAt)]);
    if (isObj(doc.lastLife)) lives.push([Date.parse(doc.lastLife.from), Date.parse(doc.lastLife.to)]);
    let ms = 0;
    for (const [from, to] of lives) {
      const a = Math.max(month.start, Number.isFinite(from) ? from : month.start);
      const b = Math.min(until, Number.isFinite(to) ? to : until);
      if (b > a) ms += b - a;
    }
    return Math.round((PROFILE_MONTH_MICRO * ms) / DAY_MS / month.days);
  }

  /** One customer's estimated profile row for a month, unless it's there already. → 'written' | 'there' | 'failed'. */
  async function meterRow(tag, userId, month, micro) {
    const endpoint = `upload_post_profile ${month.name}`;
    try {
      const have = await db.select('usage_ledger', { vendor: 'uploadpost', customer_tag: tag, endpoint }, { select: 'id', limit: 1 });
      if (have.length) return 'there';
      await db.insert('usage_ledger', { vendor: 'uploadpost', customer_tag: tag, user_id: userId ?? null, feature: 'connections', endpoint, cost_micro: micro, estimated: true, outcome: 'ok' });
      return 'written';
    } catch {
      return 'failed';
    }
  }

  /** A deleted customer's profile cost: last month (if its row isn't there yet) and this month up to now. */
  async function meterGoneCustomer(tag, doc) {
    if (!dbReady) return;
    for (const [month, until] of [[monthOf(-1), monthOf(-1).end], [monthOf(0), now()]]) {
      const micro = profileMicro(doc, month, until);
      if (micro > 0) await meterRow(tag, null, month, micro);
    }
  }

  /**
   * Once per month: for last month, one estimated `upload_post_profile` row per customer with a profile. Each row
   * is written only when it isn't there yet, and the month counts as done only after a pass where every customer
   * was read and every row written, so a failed read or insert (or a restart half way) is finished by the next
   * daily run. A run claims the month for 2 hours (ifVersion), so two servers don't both write it.
   */
  async function meterIfDue() {
    if (!setUp) return { skipped: true };
    const month = monthOf(-1);
    const claimKey = `uploadpost:metered:${month.name}`;
    try {
      const claim = await storage.get(claimKey);
      if (claim?.value?.done) return { skipped: true };
      const at = Date.parse(claim?.value?.at);
      if (Number.isFinite(at) && now() - at < 2 * 3_600_000) return { skipped: true };
      await storage.put(claimKey, { at: iso(now()) }, { ifVersion: claim?.updatedAt ?? null });
    } catch {
      return { skipped: true };
    }
    let rows = 0;
    let complete = true;
    for (let offset = 0; offset < 100_000; offset += 1000) {
      let customers;
      try {
        customers = await db.select('billing_customers', {}, { select: 'customer_tag,user_id', order: 'customer_tag', limit: 1000, offset });
      } catch {
        complete = false;
        break;
      }
      for (const c of customers) {
        if (!c.user_id) continue;
        let got;
        try {
          got = await readDoc(c.user_id);
        } catch {
          complete = false;
          continue;
        }
        if (got.unreadable) continue;
        const micro = profileMicro(got.value, month);
        if (micro <= 0) continue;
        const r = await meterRow(c.customer_tag, c.user_id, month, micro);
        if (r === 'written') rows += 1;
        if (r === 'failed') complete = false;
      }
      if (customers.length < 1000) break;
    }
    if (complete) await storage.put(claimKey, { at: iso(now()), done: true }).catch(() => null);
    log_('uploadpost_metered', { month: month.name, rows, complete });
    return { rows, ...(complete ? {} : { incomplete: true }) };
  }

  /**
   * Every one of our profiles at Upload-Post against our docs: a profile whose accounts differ from its customer's
   * doc (a connect, disconnect or reconnect flag whose webhook was missed) is read again. → { checked, listed }.
   */
  async function reconcileAccounts() {
    const cap = await capInfo({ fresh: true });
    if (!cap) return { checked: 0, listed: null };
    let checked = 0;
    for (const p of cap.profiles) {
      if (!USERNAME.test(String(p.username ?? ''))) continue;
      const who = await userOfProfile(p.username).catch(() => null);
      if (!who || !accountsDiffer(who.doc, p.social_accounts)) continue;
      await sync(who.userId).catch(() => null);
      checked += 1;
    }
    return { checked, listed: cap.profiles };
  }

  /** Nothing is connected in this listed profile (and the listing says so). */
  const emptyProfile = (p) => isObj(p.social_accounts) && Object.values(p.social_accounts).every((a) => a === '' || a === null || a === undefined);

  /**
   * Once a day: every profile's accounts against our docs (above), the cap (an owner alert when few profiles are
   * left), then our own `ylb_` profiles (never one named otherwise, at most 10 deletions a day):
   * - a profile our account deletion marked, whose customer is gone, is deleted (a failed delete after the
   *   account went, or a restart in between); a mark whose customer is still here (a deletion that stopped) goes;
   * - a profile with no customer here and no mark is left alone and reported to the owner: it isn't ours to
   *   judge (another copy of the app on the same key, or a database that's empty or not this one);
   * - a customer's profile with nothing connected for UPLOAD_POST_RECLAIM_DAYS (no connect waiting) goes back
   *   to the plan; it's made again on their next Connect.
   */
  async function reconcileIfDue() {
    if (!setUp) return { skipped: true };
    const claimKey = `uploadpost:reconciled:${iso(now()).slice(0, 10)}`;
    try {
      if (await storage.get(claimKey)) return { skipped: true };
      await storage.put(claimKey, { at: iso(now()) }, { ifVersion: null });
    } catch {
      return { skipped: true };
    }
    lastFullRead = now();
    const { checked, listed } = await reconcileAccounts().catch(() => ({ checked: 0, listed: null }));
    const cap = capCache;
    if (!cap || !listed) return { checked, deleted: 0, reclaimed: 0 };
    if (cap.limit && cap.limit - cap.used <= alertRemaining) ownerAlert(cap.limit - cap.used <= 0 ? 'profile_cap' : 'profile_cap_low');
    else if (cap.limit) clearAlerts(['profile_cap', 'profile_cap_low']);
    let gone;
    try {
      gone = (await readGone()).map;
    } catch {
      return { checked, deleted: 0, reclaimed: 0 };
    }
    let deleted = 0;
    let reclaimed = 0;
    let unknown = 0;
    const remove = async (username) => {
      const res = await call('DELETE', '/uploadposts/users', { body: { username } }).catch(() => null);
      return !!res && ((res.status >= 200 && res.status < 300) || res.status === 404);
    };
    for (const p of listed) {
      if (deleted + reclaimed >= 10) break;
      const tag = tagForUsername(p.username);
      if (!tag) continue;
      let rows;
      try {
        rows = await db.select('billing_customers', { customer_tag: tag }, { select: 'customer_tag,user_id', limit: 1 });
      } catch {
        break;
      }
      const userId = rows[0]?.user_id;
      const mark = gone[p.username];
      if (!userId) {
        if (!mark) {
          unknown += 1;
          continue;
        }
        if (await remove(p.username)) {
          deleted += 1;
          await markGone(p.username, false).catch(() => null);
        }
        continue;
      }
      if (mark) {
        if (now() - Date.parse(mark.at) > FORGOTTEN_FOR_MS) await markGone(p.username, false).catch(() => null);
        continue;
      }
      const got = await readDoc(userId).catch(() => null);
      if (!got || got.unreadable) continue;
      const doc = got.value;
      if (doc.username !== p.username || forgotten(doc) || !emptyProfile(p) || Object.keys(doc.accounts ?? {}).length) continue;
      const created = Date.parse(doc.createdAt);
      const lastConnect = Math.max(0, ...Object.values(doc.pending ?? {}).map((x) => Date.parse(x?.at)).filter(Number.isFinite));
      if (!Number.isFinite(created) || now() - created < reclaimAfterMs || now() - lastConnect < LINK_LIFETIME_MS) continue;
      if (!(await remove(p.username))) continue;
      reclaimed += 1;
      await updateDoc(userId, (d) => {
        if (d.username !== p.username) return { write: false };
        d.lastLife = { from: d.createdAt, to: iso(now()) };
        delete d.username;
        delete d.createdAt;
        d.reclaimedAt = iso(now());
        d.pending = {};
        return { value: d };
      }).catch(() => null);
    }
    if (deleted || reclaimed) capCache = null;
    if (unknown) ownerAlert('profile_orphans', { n: unknown });
    else clearAlerts(['profile_orphans']);
    log_('uploadpost_reconciled', { checked, deleted, reclaimed, unknown });
    return { checked, deleted, reclaimed, unknown };
  }

  return {
    enabled: true,
    setUp,
    hint,
    /** set up, but something optional is missing (photo and video posts need MEDIA_URL_SECRET) */
    warning,
    /** the X Links add-on is bought (UPLOAD_POST_X_LINKS): links stay in X posts, from a shared allowance */
    xLinks,
    status,
    connectLink: (userId, platform, opts = {}) => startConnect(userId, platform, { ...opts, reconnect: false }),
    reconnectLink: (userId, platform, opts = {}) => startConnect(userId, platform, { ...opts, reconnect: true }),
    check,
    disconnect,
    targets,
    setTarget,
    insights,
    adResults,
    publish,
    postStatus,
    forgetUser,
    unforgetUser,
    userDeleted,
    webhook,
    /** for tests and shutdown: wait until the background work (webhooks, alert writes) has finished */
    async settled() {
      while (background.size) await Promise.allSettled([...background]);
    },
    meterIfDue,
    reconcileIfDue,
    accountCount,
    ownerView,
    /** a team-level problem another module found (posting: 'media_secret'), for the owner's Billing page */
    alert: (kind) => ownerAlert(kind),
    /** posting registers how an upload_completed webhook finishes its job: fn(userId, jobId, outcome) */
    setPostListener(fn) {
      postListener = typeof fn === 'function' ? fn : null;
    },
  };
}
