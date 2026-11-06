// Customers' social accounts through Upload-Post (the owner's choice for social; ads stay on Zernio): one
// Upload-Post profile per customer, made on their first Connect click, named `ylb_` + the 24 hex of their customer
// tag (never an email or our user id; Upload-Post usernames can't be changed, so it is stored once and never
// recomputed). Customers connect on Upload-Post's hosted white-label page. The methods are those of
// server/connections/index.mjs for the social platforms, plus webhook(rawBody, headers) for
// POST /api/webhooks/upload-post, setPostListener(fn), meterIfDue(), reconcileIfDue(), accountCount(userId) and
// ownerView().
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
//   analytics budgets) never reach a customer: they see a safe message and the owner gets an `uploadpost:alert`.
// - Webhooks: signed (HMAC over "<timestamp>.<raw body>", 300 s window; unsigned ones refused), de-duplicated by
//   request id + platform + event, routed by profile_username → customer tag → user, applied only to that
//   customer's own doc and jobs. Upload-Post never retries a webhook, so status polling and the daily reconcile
//   back it up.
// - Third-party text (account names, Page names, post text) is data: clipped and kept as plain text.

import crypto from 'node:crypto';
import { PHASE2_PLATFORMS, PLATFORMS, SOCIAL_PLATFORMS } from '../integrations/contracts.mjs';
import { customerTag, ensureCustomer, fail, IntegrationError, notSetUp, oneShot, safeLog, sha256 } from '../integrations/common.mjs';
import { notConnectedStatuses } from './index.mjs';
import { createUploadPostClient, UploadPostCallError, upError } from '../uploadpost.mjs';
import { appOrigin } from '../seo/sitemap.mjs';
import { num, post as normPost } from '../analytics/normalize/util.mjs';
import { publicMediaUrl } from '../social/media.mjs';

const NAMES = { facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', tiktok: 'TikTok', x: 'X', youtube: 'YouTube', pinterest: 'Pinterest' };
const TARGET_KIND = { facebook: 'fb_page', instagram: 'ig_account', linkedin: 'li_person', tiktok: 'tt_account', x: 'x_account', youtube: 'yt_channel', pinterest: 'pin_account' };
/** Our platform → Upload-Post's social_accounts key and upload platform (the same names today). */
export const UP_PLATFORM = Object.freeze({ facebook: 'facebook', instagram: 'instagram', linkedin: 'linkedin', tiktok: 'tiktok', x: 'x', youtube: 'youtube', pinterest: 'pinterest' });
const FROM_UP = Object.freeze(Object.fromEntries(Object.entries(UP_PLATFORM).map(([ours, up]) => [up, ours])));

const PENDING_MS = 30 * 60_000;
const LINK_LIFETIME_MS = 48 * 3_600_000;
const FORGOTTEN_FOR_MS = 24 * 3_600_000;
const CAP_CACHE_MS = 60_000;
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
 * One platform's result (an upload's results.<p>, a /status results[] entry, an upload_completed result) → our
 * outcome: { state: 'sent', url?, drafts? } | { state: 'failed', errorCode, reauth? } | { state: 'pending' }.
 * Top-level success is never trusted: only this platform's own entry.
 */
export function outcomeOfEntry(entry) {
  if (!isObj(entry)) return { state: 'pending' };
  const st = String(entry.status ?? '');
  if (entry.skipped === true || st === 'skipped') return { state: 'failed', errorCode: 'NOT_CONNECTED' };
  if (['queued', 'processing', 'pending', 'in_progress'].includes(st)) return { state: 'pending' };
  if (entry.success === true) {
    if (entry.fallback_to_inbox === true) return { state: 'sent', drafts: true };
    const url = httpsUrl(entry.url) ?? httpsUrl(entry.post_url);
    return { state: 'sent', ...(url ? { url } : {}) };
  }
  if (entry.success === false || st === 'failed' || st === 'retryable') {
    const reauth = entry.reauth_required === true || /reauth|reconnect/i.test(String(entry.error_code ?? ''));
    return { state: 'failed', errorCode: reauth ? 'NEEDS_RECONNECT' : jobErrorForCode(entry.error_code), ...(reauth ? { reauth: true } : {}) };
  }
  return { state: 'pending' };
}

/**
 * env: UPLOAD_POST_API_KEY, UPLOAD_POST_WEBHOOK_SECRET (+ _PREVIOUS), UPLOAD_POST_BASE_URL (tests), UPLOAD_POST_RPM,
 * UPLOAD_POST_ALERT_REMAINING, UPLOAD_POST_BRAND_LOGO_URL, UPLOAD_POST_CONNECT_TITLE,
 * UPLOAD_POST_CONNECT_DESCRIPTION, UPLOAD_POST_BACK_BUTTON_TEXT, CUSTOMER_TAG_SECRET, MEDIA_URL_SECRET (posts with a
 * photo or video), GSC_APP_PROPERTY (the app's address for the back button). storage: appState. db:
 * server/integrations/db.mjs. client, sleep: for tests.
 */
export function createUploadPostConnections({ env = process.env, fetch = globalThis.fetch, now = () => Date.now(), storage = null, db = null, log = console, client = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const storageReady = storage?.enabled === true;
  const dbReady = db?.enabled === true;
  const log_ = (event, fields) => safeLog(event, fields, log);
  const up = client ?? createUploadPostClient({ env, fetch, now, log, sleep, onAlert: (kind) => ownerAlert(kind) });
  const tagSecret = String(env.CUSTOMER_TAG_SECRET || '');
  const alertRemaining = Math.max(0, Number.parseInt(env.UPLOAD_POST_ALERT_REMAINING, 10) || 5);
  let postListener = null;
  let capCache = null; // { at, used, limit }
  const analyticsTimes = [];

  const missing = [...(up.enabled ? [] : ['UPLOAD_POST_API_KEY']), ...(up.webhookReady ? [] : ['UPLOAD_POST_WEBHOOK_SECRET']), ...(tagSecret.length >= 16 ? [] : ['CUSTOMER_TAG_SECRET'])];
  const setUp = missing.length === 0 && storageReady && dbReady;
  const hint = missing.length
    ? `Social accounts and posting need these Replit Secrets: ${missing.join(', ')}.`
    : !storageReady || !dbReady
      ? 'Social accounts need Supabase server storage (SUPABASE_URL, SUPABASE_SECRET_KEY, the app_state and integrations migrations).'
      : '';

  function requireSetUp() {
    if (!setUp) throw notSetUp(hint, 'Connecting accounts isn’t available yet.');
  }

  function ownerAlert(kind) {
    log_('uploadpost_owner_alert', { kind });
    if (!storageReady) return;
    storage.put('uploadpost:alert', { kind, at: iso(now()) }).catch(() => {});
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
    const kind = e.status === 401 || e.status === 403 ? 'config' : e.status === 409 || /reauth|reconnect/i.test(e.code) ? 'reconnect' : e.status === 429 ? 'busy' : e.status === 404 ? 'not_found' : 'upstream';
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
    if (got?.unreadable) return { value: blankDoc(), version: got.updatedAt ?? null };
    const value = isObj(got?.value) ? got.value : blankDoc();
    for (const k of ['accounts', 'pages', 'pins', 'choice', 'pending', 'lastError']) if (!isObj(value[k])) value[k] = {};
    return { value, version: got?.updatedAt ?? null };
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

  /** The Page (Facebook) or page URN / 'personal' (LinkedIn) a business posts to, or null when none is clear. */
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
        const n = Object.keys(doc.pages?.facebook ?? {}).length;
        if (n > 1 && !doc.pins?.facebook) out.targetsAvailable = n;
      } else if (platform === 'linkedin') {
        const page = pageFor(doc, platform, projectId);
        if (page && page !== PERSONAL && doc.pages?.linkedin?.[page]) Object.assign(out, { targetLabel: doc.pages.linkedin[page], targetKind: 'li_org' });
        else if (acct.label) Object.assign(out, { targetLabel: acct.label, targetKind: 'li_person' });
        const n = Object.keys(doc.pages?.linkedin ?? {}).length;
        if (n > 0 && !doc.pins?.linkedin) out.targetsAvailable = n + 1;
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

  /** ConnectionStatus for every platform; ad platforms read "Not connected" here (Zernio answers those). */
  async function status(userId, { projectId } = {}) {
    if (!storageReady) return notConnectedStatuses();
    const { value } = await readDoc(userId);
    if (forgotten(value)) return notConnectedStatuses();
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

  /** The user's profile username: stored, or made now (a 409 means it exists already, which is fine). */
  async function ensureProfile(userId) {
    const { value: doc } = await readDoc(userId);
    if (forgotten(doc)) throw fail(409, 'FORBIDDEN', 'This account is being deleted.');
    if (USERNAME.test(String(doc.username ?? ''))) return doc.username;
    const tag = await ensureCustomer(db, userId, env).catch((e) => {
      if (e instanceof IntegrationError) throw e;
      throw fail(503, 'UNAVAILABLE', 'Couldn’t start connecting just now. Try again shortly.');
    });
    const username = usernameFor(tag);
    await createProfile(username, tag);
    await updateDoc(userId, (d) => {
      d.customer = tag;
      d.username = username;
      d.createdAt = d.createdAt ?? iso(now());
      return { value: d };
    });
    log_('uploadpost_profile_ready', {});
    return username;
  }

  async function createProfile(username, tag) {
    const cap = await capInfo().catch(() => null);
    if (cap?.limit && !cap.profiles.some((p) => p.username === username)) {
      const remaining = cap.limit - cap.used;
      if (remaining <= 0) {
        ownerAlert('profile_cap');
        throw capFull();
      }
      if (remaining <= alertRemaining) ownerAlert('profile_cap_low');
    }
    const made = await call('POST', '/uploadposts/users', { body: { username, display_name: `Customer ${String(tag).slice(5, 13)}` }, headers: { 'Idempotency-Key': `profile-${username}` } });
    if ((made.status >= 200 && made.status < 300) || made.status === 409) {
      if (capCache && made.status !== 409) capCache = { ...capCache, used: capCache.used + 1, profiles: [...capCache.profiles, { username }] };
      return;
    }
    throw callFailure(made);
  }

  // ───────────── connect and reconnect (the hosted white-label page) ─────────────

  function branding(username, platform) {
    const logo = httpsUrl(String(env.UPLOAD_POST_BRAND_LOGO_URL || '').trim());
    // every field, every time: Upload-Post clears the ones left out
    return {
      username,
      redirect_url: `${appOrigin(env)}/settings?tab=accounts&from=connect`,
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
    const username = await ensureProfile(userId);
    const { value: doc } = await readDoc(userId);
    if (!reconnect && doc.accounts?.[platform]?.state === 'connected') {
      await sync(userId).catch(() => null);
      log_('uploadpost_connect_already', { platform });
      return { alreadyConnected: true };
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
    if (res.status < 200 || res.status >= 300) return null;
    const out = {};
    for (const p of (Array.isArray(res.body?.pages) ? res.body.pages : []).filter(isObj).slice(0, 100)) {
      const id = String(p.id ?? p.urn ?? p.page_id ?? '');
      if (!/^[A-Za-z0-9:_.-]{1,120}$/.test(id)) continue;
      out[id] = clip(p.name ?? p.title ?? NAMES[platform], 80);
    }
    return out;
  }

  /** The Page pinned on the profile (the hosted page may set one), or '' (none) / null (the read failed). */
  async function readPin(username, platform) {
    const res = await call('GET', `/uploadposts/users/${platform}-page`, { query: { profile_username: username }, retry429: true });
    if (res.status === 404) return '';
    if (res.status < 200 || res.status >= 300) return null;
    const b = isObj(res.body) ? res.body : {};
    const id = String(b[`${platform}_page_id`] ?? b.page_id ?? b.page?.id ?? '');
    return /^[A-Za-z0-9:_.-]{1,120}$/.test(id) ? id : '';
  }

  /** GET /uploadposts/users/{username} → the doc's accounts (labels, state), Pages and pins. */
  async function sync(userId) {
    const { value: doc } = await readDoc(userId);
    if (!USERNAME.test(String(doc.username ?? ''))) return doc;
    const username = doc.username;
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
        else if (got?.pin) d.pins[platform] = got.pin;
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
    const pin = doc.pins?.[platform];
    const list = [];
    if (platform === 'linkedin' && (!pin || pin === PERSONAL)) list.push({ id: handleOf(platform, PERSONAL), label: acct.label, kind: 'li_person' });
    for (const [id, label] of Object.entries(pages)) if (!pin || pin === id) list.push({ id: handleOf(platform, id), label, kind: platform === 'facebook' ? 'fb_page' : 'li_org' });
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
    if (doc.pins?.[platform] && doc.pins[platform] !== id) throw fail(409, 'BAD_REQUEST', `This ${NAMES[platform]} Page was set on the connect page. Reconnect ${NAMES[platform]} to change it.`);
    return updateDoc(userId, (d) => {
      const key = projectId ?? DEFAULT;
      d.choice[key] = { ...(d.choice[key] ?? {}), [platform]: id };
      if (key !== DEFAULT && !d.choice[DEFAULT]?.[platform]) d.choice[DEFAULT] = { ...(d.choice[DEFAULT] ?? {}), [platform]: id };
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
    const series = (Array.isArray(e.reach_timeseries) ? e.reach_timeseries : [])
      .filter(isObj)
      .map((r) => ({ date: String(r.date ?? '').slice(0, 10), reach: num(r.value) ?? 0 }))
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    let topPosts = [];
    const cached = await read('/uploadposts/post-analytics/cached', { user: username, platform: UP_PLATFORM[platform], limit: 25 }, 'GET /post-analytics/cached').catch(() => null);
    if (cached && cached.status >= 200 && cached.status < 300) {
      topPosts = (Array.isArray(cached.body?.posts) ? cached.body.posts : [])
        .filter(isObj)
        .map((p) => normPost({ id: p.post_id, url: p.post_url, text: '', at: p.upload_timestamp, likes: p.metrics?.likes, comments: p.metrics?.comments, shares: p.metrics?.shares, views: p.metrics?.views ?? p.metrics?.impressions }))
        .filter(Boolean);
    }
    return {
      followers: num(e.followers),
      reach: num(e.reach),
      views: num(e.views) ?? num(e.impressions),
      engagement: parts.length ? parts.reduce((a, b) => a + b, 0) : undefined,
      postsCount: num(e.posts_count) ?? num(e.video_count),
      series,
      topPosts,
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

  /** TikTok's audience setting for this account: the one asked for, else public, else nothing (refused). */
  async function tiktokPrivacy(username, wanted) {
    const res = await call('GET', '/uploadposts/tiktok/settings', { query: { profile: username }, retry429: true });
    if (res.status < 200 || res.status >= 300) {
      const e = upError(res);
      return { error: /reauth|reconnect/i.test(e.code) ? 'NEEDS_RECONNECT' : 'NOT_SENT' };
    }
    const options = (Array.isArray(res.body?.privacy_level_options) ? res.body.privacy_level_options : []).filter((o) => typeof o === 'string' && /^[A-Z_]{3,40}$/.test(o));
    if (typeof wanted === 'string' && options.includes(wanted)) return { privacy: wanted };
    if (options.includes('PUBLIC_TO_EVERYONE')) return { privacy: 'PUBLIC_TO_EVERYONE' };
    return { error: 'TIKTOK_PRIVACY' };
  }

  /** A definite refusal (4xx) of an upload → our outcome. Team-level ones tell the owner, never the customer. */
  function refusalOutcome(res) {
    const e = upError(res);
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
    if (Array.isArray(res.body?.invalid_platforms)) return { state: 'failed', errorCode: 'NOT_CONNECTED' };
    const v = e.violations.find((x) => x.type);
    return { state: 'failed', errorCode: jobErrorForCode(v?.type || e.code) };
  }

  /** One /status read for a request (our job id) → { state, url?, drafts?, errorCode? } for this platform. */
  async function readStatus(username, requestId, platform) {
    const res = await call('GET', '/uploadposts/status', { query: { request_id: requestId } });
    if (res.status === 404) return { state: 'pending', missing: true };
    if (res.status < 200 || res.status >= 300) return null;
    const b = isObj(res.body) ? res.body : {};
    const entry = (Array.isArray(b.results) ? b.results : []).find((r) => isObj(r) && r.platform === UP_PLATFORM[platform]);
    let out = entry ? outcomeOfEntry(entry) : { state: 'pending' };
    if (!entry && b.status === 'failed') out = { state: 'failed', errorCode: 'REFUSED' };
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
        mediaUrl = publicMediaUrl(env, { userId, mediaId: media.id, kind: media.kind }, now());
      } catch {
        return { state: 'failed', errorCode: 'MEDIA_UPLOAD_FAILED', ref };
      }
    }
    let tiktok;
    if (platform === 'tiktok') {
      tiktok = await tiktokPrivacy(username, privacy).catch(() => ({ error: 'NOT_SENT' }));
      if (tiktok.error) {
        if (tiktok.error === 'NEEDS_RECONNECT') await markReconnect(userId, platform);
        return { state: 'failed', errorCode: tiktok.error, ref };
      }
    }
    const path = media ? (media.kind === 'video' ? '/upload' : '/upload_photos') : '/upload_text';
    const form = uploadFields(platform, { username, page, jobId, composed, mediaUrl, mediaKind: media?.kind, privacy: tiktok?.privacy });
    const sent = await oneShot(async () => up.call('POST', path, { form, headers: { 'Idempotency-Key': jobId }, timeoutMs: 120_000 }));
    const res = sent.value;
    await ledger({ customer_tag: tag, user_id: userId, project_id: projectId ?? null, call_id: jobId, feature: 'posting', endpoint: `${platform}:POST ${path}`, http_status: res?.status ?? null, outcome: sent.outcome === 'ok' ? 'ok' : sent.outcome === 'failed' ? 'failed' : 'unknown' });
    if (sent.outcome === 'unknown') return { state: 'unknown', errorCode: 'UNCONFIRMED', ref };
    if (sent.outcome === 'failed') return withRef(refusalOutcome(res), ref);
    const entry = isObj(res?.body?.results) ? res.body.results[UP_PLATFORM[platform]] : null;
    let out;
    if (entry) out = outcomeOfEntry(entry);
    else if (typeof res?.body?.request_id === 'string') out = await poll(username, jobId, platform, media?.kind === 'video');
    else out = { state: 'unknown', errorCode: 'UNCONFIRMED' };
    if (out.state === 'sent' && !out.url && !out.drafts && entry) {
      const later = await readStatus(username, jobId, platform).catch(() => null);
      if (later?.state === 'sent') out = later;
    }
    if (out.state === 'pending') out = { state: 'unknown', errorCode: 'UNCONFIRMED' };
    if (out.reauth || out.errorCode === 'NEEDS_RECONNECT') await markReconnect(userId, platform);
    return withRef(out, ref);
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
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) return null;
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

  /** The customer a profile_username belongs to: ylb_<hex> → cust_<hex> → billing_customers → user (or null). */
  async function userOfProfile(profileUsername) {
    const tag = tagForUsername(profileUsername);
    if (!tag) return null;
    const rows = await db.select('billing_customers', { customer_tag: tag }, { select: 'customer_tag,user_id', limit: 1 });
    const userId = rows[0]?.user_id;
    if (!userId) return null;
    const { value: doc } = await readDoc(userId);
    // the event's profile must be the one stored for that customer
    if (doc.username !== profileUsername) return null;
    return { userId, doc };
  }

  async function applyEvent(evt) {
    const type = String(evt.event ?? '');
    if (type === 'social_account_reauth_required' && !evt.profile_username) {
      // the documented reauth example has no profile: one full read of every profile instead
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
      const out = outcomeOfEntry(isObj(evt.result) ? evt.result : {});
      if (out.state === 'pending') return 'ignored';
      if (out.reauth) await markReconnect(userId, platform);
      await postListener(userId, jobId, { state: out.state, platform, ...(out.url ? { url: out.url } : {}), ...(out.errorCode ? { errorCode: out.errorCode } : {}), ...(out.drafts ? { drafts: true } : {}) });
      return 'applied';
    }
    return 'ignored';
  }

  /** The key a repeat of the same event has too (X-Upload-Post-Delivery is new on every delivery, so it isn't one). */
  function dedupeKeyOf(evt, rawBody) {
    const safe = (v) => (typeof v === 'string' && /^[A-Za-z0-9_.:@-]{1,120}$/.test(v) ? v : '');
    const type = safe(evt.event);
    if (type === 'upload_completed') {
      const id = safe(evt.result?.post_id) || safe(evt.result?.publish_id);
      const req = safe(evt.request_id);
      if (req && safe(evt.platform)) return `uploadpost:${req}:${safe(evt.platform)}:${type}`;
      if (id) return `uploadpost:post:${id}`;
    }
    if (type && safe(evt.profile_username) && safe(evt.platform) && safe(evt.created_at)) return `uploadpost:${type}:${evt.profile_username}:${evt.platform}:${evt.created_at}`;
    return `uploadpost:${sha256(rawBody)}`;
  }

  /**
   * POST /api/webhooks/upload-post: rawBody is the exact bytes. → { status, body }. Nothing is read or written for
   * a delivery whose signature (or timestamp) doesn't check out. A repeat of an event answers 200 and does nothing.
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
      return { status: 500, body: { error: 'Try again.', code: 'UNAVAILABLE' } };
    }
    let outcome;
    try {
      outcome = await applyEvent(evt);
    } catch {
      // Upload-Post doesn't send it again: status polling and the daily reconcile catch up
      log_('uploadpost_webhook_failed', { event: clip(evt.event, 60) });
      return { status: 500, body: { error: 'Try again.', code: 'UNAVAILABLE' } };
    }
    try {
      await db.upsert('webhook_deliveries', { body_hash: dedupeKey, received_at: iso(now()) }, { onConflict: 'body_hash' });
    } catch {
      /* a repeat would apply the same change again: harmless */
    }
    log_('uploadpost_webhook', { event: clip(evt.event, 60), outcome });
    return { status: 200, body: { ok: true } };
  }

  // ───────────── account deletion ─────────────

  async function forgetUser(userId) {
    if (!storageReady) return;
    const { value: doc } = await readDoc(userId);
    // the profile (and every account connected in it) goes at Upload-Post: one attempt; a 404 means already gone
    if (setUp && USERNAME.test(String(doc.username ?? ''))) {
      const res = await call('DELETE', '/uploadposts/users', { body: { username: doc.username } });
      if ((res.status < 200 || res.status >= 300) && res.status !== 404) throw fail(503, 'UNAVAILABLE', 'Couldn’t disconnect your accounts just now. Try again shortly.');
      capCache = null;
    }
    await updateDoc(userId, (d) => ({ value: { ...blankDoc(), username: d.username, customer: d.customer, createdAt: d.createdAt, forgottenAt: iso(now()) } }));
  }

  async function unforgetUser(userId) {
    if (!storageReady) return;
    await updateDoc(userId, (d) => {
      if (!d.forgottenAt) return { write: false };
      delete d.forgottenAt;
      return { value: d };
    });
  }

  // ───────────── the owner's view, the monthly estimate and the daily reconcile ─────────────

  /** How many social accounts a customer has connected now (the owner's per-customer view). */
  async function accountCount(userId) {
    if (!storageReady) return 0;
    const { value } = await readDoc(userId);
    return forgotten(value) ? 0 : Object.keys(value.accounts ?? {}).length;
  }

  /** For the owner's billing view: profiles used out of the plan's limit, and the last team-level alert. */
  async function ownerView() {
    if (!setUp) return null;
    const cap = await capInfo().catch(() => null);
    const alert = await storage.get('uploadpost:alert').catch(() => null);
    return { ...(cap ? { profilesUsed: cap.used, ...(cap.limit ? { profilesLimit: cap.limit } : {}) } : {}), ...(isObj(alert?.value) && typeof alert.value.kind === 'string' ? { alert: { kind: clip(alert.value.kind, 40), at: clip(alert.value.at, 40) } } : {}) };
  }

  /**
   * Once per month: for last month, one estimated `upload_post_profile` row per customer with a profile (the plan
   * price over its profiles, prorated by days). Claimed with ifVersion so two servers don't both write it.
   */
  async function meterIfDue() {
    if (!setUp) return { skipped: true };
    const t = new Date(now());
    const start = Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1);
    const end = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1);
    const month = iso(start).slice(0, 7);
    const claimKey = `uploadpost:metered:${month}`;
    try {
      if (await storage.get(claimKey)) return { skipped: true };
      await storage.put(claimKey, { at: iso(now()) }, { ifVersion: null });
    } catch {
      return { skipped: true };
    }
    const days = (end - start) / 86_400_000;
    let rows = 0;
    for (let offset = 0; offset < 100_000; offset += 1000) {
      let customers;
      try {
        customers = await db.select('billing_customers', {}, { select: 'customer_tag,user_id', order: 'customer_tag', limit: 1000, offset });
      } catch {
        log_('uploadpost_meter_failed', { month });
        return { rows };
      }
      for (const c of customers) {
        if (!c.user_id) continue;
        let doc;
        try {
          doc = (await readDoc(c.user_id)).value;
        } catch {
          continue;
        }
        if (!USERNAME.test(String(doc.username ?? ''))) continue;
        const from = Math.max(start, Date.parse(doc.createdAt) || start);
        const until = Math.min(end, Date.parse(doc.forgottenAt) || end);
        if (from >= until) continue;
        const micro = Math.round((PROFILE_MONTH_MICRO * (until - from)) / 86_400_000 / days);
        await ledger({ customer_tag: c.customer_tag, user_id: c.user_id, feature: 'connections', endpoint: `upload_post_profile ${month}`, cost_micro: micro, estimated: true, outcome: 'ok' });
        rows += 1;
      }
      if (customers.length < 1000) break;
    }
    log_('uploadpost_metered', { month, rows });
    return { rows };
  }

  /** Every profile's reconnect flags against our docs (after a reauth event that named no profile). */
  async function reconcileAccounts() {
    const cap = await capInfo({ fresh: true });
    if (!cap) return { checked: 0 };
    let checked = 0;
    for (const p of cap.profiles) {
      if (!USERNAME.test(String(p.username ?? ''))) continue;
      const flagged = Object.values(isObj(p.social_accounts) ? p.social_accounts : {}).some((a) => isObj(a) && a.reauth_required === true);
      if (!flagged) continue;
      const who = await userOfProfile(p.username).catch(() => null);
      if (!who) continue;
      await sync(who.userId).catch(() => null);
      checked += 1;
    }
    return { checked };
  }

  /**
   * Once a day: the cap (an owner alert when few profiles are left), reconnect flags, and our own orphans (a
   * `ylb_` profile whose customer is gone) deleted, at most 10 a day. Profiles not named `ylb_…` are never touched.
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
    const { checked } = await reconcileAccounts().catch(() => ({ checked: 0 }));
    const cap = capCache;
    if (!cap) return { checked, deleted: 0 };
    if (cap.limit && cap.limit - cap.used <= alertRemaining) ownerAlert(cap.limit - cap.used <= 0 ? 'profile_cap' : 'profile_cap_low');
    let deleted = 0;
    for (const p of cap.profiles) {
      if (deleted >= 10) break;
      const tag = tagForUsername(p.username);
      if (!tag) continue;
      let rows;
      try {
        rows = await db.select('billing_customers', { customer_tag: tag }, { select: 'customer_tag,user_id', limit: 1 });
      } catch {
        return { checked, deleted };
      }
      if (rows[0]?.user_id) {
        const doc = (await readDoc(rows[0].user_id).catch(() => null))?.value;
        if (!doc || doc.username === p.username) continue;
      }
      const res = await call('DELETE', '/uploadposts/users', { body: { username: p.username } }).catch(() => null);
      if (res && ((res.status >= 200 && res.status < 300) || res.status === 404)) deleted += 1;
    }
    if (deleted) capCache = null;
    log_('uploadpost_reconciled', { checked, deleted });
    return { checked, deleted };
  }

  return {
    enabled: true,
    setUp,
    hint,
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
    webhook,
    meterIfDue,
    reconcileIfDue,
    accountCount,
    ownerView,
    /** posting registers how an upload_completed webhook finishes its job: fn(userId, jobId, outcome) */
    setPostListener(fn) {
      postListener = typeof fn === 'function' ? fn : null;
    },
  };
}
