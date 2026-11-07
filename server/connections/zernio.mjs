// Ad accounts through Zernio (the owner's choice for ads; social accounts and posting are Upload-Post's,
// server/connections/uploadpost.mjs): each customer's ad accounts live in one Zernio profile per customer, made on
// their first connect with externalId = our customer id (the opaque billing tag, never an email). Zernio runs on its
// own approved platform apps; connect links open Zernio's white-label welcome screen with our brand. The methods are
// those of server/connections/index.mjs for the ad platforms (the social ones answer "not here"), plus
// webhook(rawBody, headers) for POST /api/webhooks/zernio and meterIfDue(). Launching and changing campaigns lives in
// server/ads/ (owned by that feature), which reaches this side through three additions only:
//   adsAccountFor(userId, 'meta_ads'|'google_ads', projectId) → { zid, label, tag }   the business's connection
//                                                     (refuses in plain words like the reads: NOT_CONNECTED, …)
//   client                                           the same Zernio client (one ZERNIO_RPM window for everything)
//   setAdsListener(fn)                               fn(userId, zid, event) for the ad.* and ad_account.* events of
//                                                     one of that user's own connections (others: 'not_ours')
//
//   const impl = createZernioConnections({ env, fetch, now, storage, db, log });
//
// What this file keeps (docs/integrations-setup.md §3a):
// - Every Zernio call goes through server/zernio.mjs (the one client; the key never leaves it).
// - Isolation: each user has their own profile (a request only ever names that user's profileId and the account
//   ids stored for that user), and each business picks which ad account it uses (choice[projectId], else the
//   default). The account id always comes from the stored doc of the signed-in user, never from a request.
// - The browser sees ConnectionStatus and opaque target handles only: no Zernio profile or account ids.
// - Webhooks: HMAC-checked on the exact bytes, deduplicated by event id, routed by profiles[0].externalId, and
//   applied only to that customer's own doc (account.* events for ad accounts; post events are ignored).
// - Zernio's classic Meta Ads connect also makes a hidden Facebook account (enabled: false) that holds the
//   customer's token: it goes with its ad account (disconnect), and deleting an account removes everything in the
//   customer's Zernio profile, then the profile.
// - Third-party text (account names, campaign names) is data: clipped and kept as plain text.

import crypto from 'node:crypto';
import { AD_PLATFORMS, PHASE2_PLATFORMS, PLATFORMS } from '../integrations/contracts.mjs';
import { customerTag, ensureCustomer, fail, IntegrationError, notSetUp, safeLog, sha256 } from '../integrations/common.mjs';
import { notConnectedStatuses } from './index.mjs';
import { createZernioClient, ZernioCallError, zernioError } from '../zernio.mjs';
import { appOrigin } from '../seo/sitemap.mjs';
import { num, text } from '../analytics/normalize/util.mjs';

/** The webhook events that belong to launched campaigns (server/ads/webhook.mjs). */
const AD_EVENTS = Object.freeze(['ad.review.approved', 'ad.review.rejected', 'ad.status_changed', 'ad.delivery_issue', 'ad_account.status_changed']);

/** Our ad platform → Zernio's connect path platform (GET /v1/connect/{platform}/ads) and its ads account platform. */
export const ADS_CONNECT = Object.freeze({
  meta_ads: { connect: 'facebook', account: 'metaads' },
  google_ads: { connect: 'googleads', account: 'googleads' },
  linkedin_ads: { connect: 'linkedin', account: 'linkedinads' },
  tiktok_ads: { connect: 'tiktok', account: 'tiktokads' },
  pinterest_ads: { connect: 'pinterest', account: 'pinterestads' },
  // X Ads needs an X account inside Zernio, and X posting is Upload-Post's: "Coming soon" until the owner decides
  x_ads: { connect: 'twitter', account: 'xads', parent: 'x' },
  reddit_ads: { connect: 'redditads', account: 'redditads' },
  microsoft_ads: { connect: 'microsoftads', account: 'microsoftads' },
});
/** Zernio's ads account platform → ours (anything else in the profile, social accounts too, is ignored). */
export const FROM_ZERNIO = Object.freeze(Object.fromEntries(Object.entries(ADS_CONNECT).map(([ours, a]) => [a.account, ours])));

const NAMES = { google_ads: 'Google Ads', meta_ads: 'Meta Ads', linkedin_ads: 'LinkedIn Ads', tiktok_ads: 'TikTok Ads', pinterest_ads: 'Pinterest Ads', x_ads: 'X Ads', reddit_ads: 'Reddit Ads', microsoft_ads: 'Microsoft Ads' };

const PENDING_MS = 30 * 60_000;
const FORGOTTEN_FOR_MS = 24 * 3_600_000;
const ACCOUNT_MONTH_MICRO = 6_000_000; // $6 per connected ad account per month (Zernio's list price for accounts 1-10)
const ZID = /^[0-9a-f]{24}$/i;
const TARGET_ID = /^tgt_[0-9a-f]{32}$/;
const DEFAULT = '*';

const iso = (ms) => new Date(ms).toISOString();
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n = 120) => {
  const t = (typeof s === 'string' || typeof s === 'number' ? String(s) : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const docKey = (userId) => `zernio:user:${sha256(String(userId))}`;
/**
 * The profile an account sits in. Zernio's listing gives `profileId` as an id string, or as the Profile object
 * itself ({_id, name, …}) when it's expanded: both are read ('' when there's none).
 */
export const profileIdOf = (a) => {
  const p = a?.profileId;
  if (typeof p === 'string') return p;
  if (p && typeof p === 'object' && !Array.isArray(p)) return typeof p._id === 'string' ? p._id : typeof p.id === 'string' ? p.id : '';
  return '';
};
/** Why a connect came back unfinished (Zernio's ?error_reason=, kept as our code): anything else is connection_failed. */
export const CONNECT_ERROR_REASONS = Object.freeze(['no_pages_granted', 'page_not_granted', 'ad_accounts_not_granted', 'ads_addon_required', 'payment_required', 'state_expired', 'invalid_state', 'reconnect_required', 'meta_ads_authorization_denied', 'connection_failed', 'cancelled']);
export const connectErrorReason = (r) => (CONNECT_ERROR_REASONS.includes(String(r ?? '')) ? String(r) : 'connection_failed');
const blankDoc = () => ({ v: 1, accounts: {}, choice: {}, pending: {}, lastError: {} });
const isAds = (platform) => AD_PLATFORMS.includes(platform);

/** A Zernio answer's failure as a thrown { kind } (like a TregError), for reads. */
function readFailure(res) {
  const e = zernioError(res);
  const kind = e.status === 401 ? 'config' : e.status === 402 || e.code === 'analytics_addon_required' || e.code === 'ads_addon_required' ? 'config' : e.status === 403 || e.status === 409 || e.code === 'ads_connection_required' || e.code === 'TOKEN_EXPIRED' ? 'reconnect' : e.status === 429 ? 'busy' : e.status === 404 ? 'not_found' : 'upstream';
  return Object.assign(new Error('zernio read failed'), { kind, status: e.status, code: e.code });
}
const okBody = (res) => {
  if (res && res.status >= 200 && res.status < 300) return res.body ?? {};
  throw readFailure(res);
};

/**
 * env: ZERNIO_API_KEY, ZERNIO_WEBHOOK_SECRET, ZERNIO_BRAND_NAME, ZERNIO_BRAND_LOGO_URL, ZERNIO_BRAND_COLOR,
 * CUSTOMER_TAG_SECRET, GSC_APP_PROPERTY (the app's address for the connect redirect). storage: appState.
 * db: server/integrations/db.mjs. client: for tests (createZernioClient's shape).
 */
export function createZernioConnections({ env = process.env, fetch = globalThis.fetch, now = () => Date.now(), storage = null, db = null, log = console, client = null, sleep } = {}) {
  const zernio = client ?? createZernioClient({ env, fetch, now, log, ...(sleep ? { sleep } : {}) });
  const storageReady = storage?.enabled === true;
  const dbReady = db?.enabled === true;
  const tagSecret = String(env.CUSTOMER_TAG_SECRET || '');
  const log_ = (event, fields) => safeLog(event, fields, log);
  /** server/ads/webhook.mjs fromWebhook(userId, zid, event), set by the wiring */
  let adsListener = null;

  const missing = [...(zernio.enabled ? [] : ['ZERNIO_API_KEY']), ...(zernio.webhookReady ? [] : ['ZERNIO_WEBHOOK_SECRET']), ...(tagSecret.length >= 16 ? [] : ['CUSTOMER_TAG_SECRET'])];
  const setUp = missing.length === 0 && storageReady && dbReady;
  const hint = missing.length
    ? `Connecting accounts needs these Replit Secrets: ${missing.join(', ')}.`
    : !storageReady || !dbReady
      ? 'Connecting accounts needs Supabase server storage (SUPABASE_URL, SUPABASE_SECRET_KEY, the app_state and integrations migrations).'
      : '';

  function requireSetUp() {
    if (!setUp) throw notSetUp(hint, 'Connecting accounts isn’t available yet.');
  }

  /** A Zernio call in our words when it got no answer at all. */
  async function call(method, path, opts) {
    try {
      return await zernio.call(method, path, opts);
    } catch (e) {
      if (e instanceof ZernioCallError) throw fail(504, 'UNAVAILABLE', 'The accounts service didn’t answer in time. Try again shortly.');
      throw e;
    }
  }

  /** An answer from Zernio that isn't a success, for connect and account calls, in our words. */
  function callFailure(res, platform) {
    const e = zernioError(res);
    if (e.status === 401) return notSetUp('Zernio refused the API key: check ZERNIO_API_KEY in Replit Secrets.', 'Connecting accounts isn’t available right now.');
    if (e.status === 402 || e.code === 'PAYMENT_REQUIRED' || e.code === 'payment_required') {
      ownerAlert('payment_required');
      return fail(503, 'CONNECTIONS_UNAVAILABLE', 'Connecting accounts isn’t available right now. Try again later.', {}, 'Zernio’s billing gate is closed for the team: add a card or pay the open invoice in the Zernio dashboard.');
    }
    if (e.code === 'ads_addon_required' || e.code === 'feature_not_available') return fail(503, 'CONNECTIONS_UNAVAILABLE', `Connecting ${NAMES[platform] ?? 'this account'} isn’t available right now.`, {}, 'The ads add-on is off for the Zernio team.');
    if (e.code === 'PLATFORM_BETA_RESTRICTED' || e.code === 'PLATFORM_DISABLED') return fail(503, 'CONNECTIONS_UNAVAILABLE', `${NAMES[platform] ?? 'This network'} isn’t available to connect yet.`);
    if (e.status === 429) return fail(429, 'RATE_LIMITED', 'Too many requests. Try again in a minute.');
    return fail(502, 'UNAVAILABLE', 'Couldn’t reach the accounts service. Try again shortly.');
  }

  function ownerAlert(kind) {
    log_('zernio_owner_alert', { kind });
    if (!storageReady) return;
    storage.put('zernio:alert', { kind, at: iso(now()) }).catch(() => {});
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
    for (const k of ['accounts', 'choice', 'pending', 'lastError']) if (!isObj(value[k])) value[k] = {};
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

  /** The opaque handle the browser sees for an account (never the Zernio id). */
  const handleOf = (zid) => `tgt_${crypto.createHmac('sha256', tagSecret || 'ylb').update(`zernio:${zid}`).digest('hex').slice(0, 32)}`;

  const accountsOf = (doc, platform) => Object.entries(doc.accounts ?? {}).filter(([, a]) => a?.platform === platform);

  /** The account a business uses for a platform: its own choice, the default, or the only one there is. */
  function chosen(doc, platform, projectId) {
    const list = accountsOf(doc, platform);
    const pick = (projectId && doc.choice?.[projectId]?.[platform]) || doc.choice?.[DEFAULT]?.[platform];
    if (pick && doc.accounts?.[pick]?.platform === platform) return [pick, doc.accounts[pick]];
    if (list.length === 1) return list[0];
    return null;
  }

  function statusOf(doc, platform, projectId) {
    if (PHASE2_PLATFORMS.includes(platform)) return { platform, state: 'coming_soon' };
    // social networks are Upload-Post's: never shown from here
    if (!isAds(platform)) return { platform, state: 'not_connected' };
    const list = accountsOf(doc, platform);
    if (list.length) {
      const pick = chosen(doc, platform, projectId);
      const acct = pick?.[1];
      const state = acct ? (acct.state === 'needs_reconnect' ? 'needs_reconnect' : 'connected') : list.every(([, a]) => a.state === 'needs_reconnect') ? 'needs_reconnect' : 'connected';
      const out = { platform, state };
      if (acct?.label) {
        out.targetLabel = acct.label;
        out.targetKind = 'ads_account';
      }
      if (list.length > 1) out.targetsAvailable = list.length;
      const connectedAt = acct?.connectedAt ?? list[0][1].connectedAt;
      if (connectedAt) out.connectedAt = connectedAt;
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

  async function status(userId, { projectId } = {}) {
    if (!storageReady) return notConnectedStatuses();
    const { value } = await readDoc(userId);
    if (forgotten(value)) return notConnectedStatuses();
    return PLATFORMS.map((p) => statusOf(value, p, projectId));
  }

  // ───────────── the customer's profile ─────────────

  /** The user's Zernio profile id: stored, found by externalId, or made now (externalId = their customer tag). */
  async function ensureProfile(userId) {
    const { value: doc } = await readDoc(userId);
    if (forgotten(doc)) throw fail(409, 'FORBIDDEN', 'This account is being deleted.');
    if (doc.profileId && ZID.test(doc.profileId)) return { profileId: doc.profileId, tag: doc.customer };
    const tag = await ensureCustomer(db, userId, env).catch((e) => {
      if (e instanceof IntegrationError) throw e;
      throw fail(503, 'UNAVAILABLE', 'Couldn’t start connecting just now. Try again shortly.');
    });
    let profileId = '';
    const found = await call('GET', '/profiles', { query: { externalId: tag } });
    if (found.status >= 200 && found.status < 300) {
      const list = Array.isArray(found.body?.profiles) ? found.body.profiles : [];
      const hit = list.find((p) => isObj(p) && p.externalId === tag && ZID.test(String(p._id ?? '')));
      if (hit) profileId = String(hit._id);
    } else if (found.status !== 404) throw callFailure(found);
    if (!profileId) {
      // the externalId is unique among our profiles: a create that went through before answers 409 with its id
      const made = await call('POST', '/profiles', { body: { name: `Customer ${tag.slice(5, 13)}`, externalId: tag, description: 'Yourlocalbusiness customer' }, headers: { 'Idempotency-Key': `profile-${tag}` } });
      if (made.status >= 200 && made.status < 300 && ZID.test(String(made.body?.profile?._id ?? ''))) profileId = String(made.body.profile._id);
      else if (made.status === 409 && ZID.test(String(made.body?.details?.existingProfileId ?? ''))) profileId = String(made.body.details.existingProfileId);
      else throw callFailure(made);
    }
    await updateDoc(userId, (d) => {
      d.customer = tag;
      d.profileId = profileId;
      return { value: d };
    });
    log_('zernio_profile_ready', {});
    return { profileId, tag };
  }

  // ───────────── connect and reconnect ─────────────

  function brandQuery() {
    const q = { welcome: 'true', brandName: clip(env.ZERNIO_BRAND_NAME || 'Yourlocalbusiness', 60) };
    const logo = String(env.ZERNIO_BRAND_LOGO_URL || '').trim();
    if (/^https:\/\/[^\s]{4,500}$/.test(logo)) q.logoUrl = logo;
    const color = String(env.ZERNIO_BRAND_COLOR || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(color)) q.primaryColor = color;
    return q;
  }

  async function startConnect(userId, platform, { projectId, reconnect = false } = {}) {
    requireSetUp();
    if (PHASE2_PLATFORMS.includes(platform)) throw fail(400, 'BAD_REQUEST', `${NAMES[platform] ?? 'This network'} is coming soon.`);
    if (!isAds(platform)) throw fail(404, 'NOT_FOUND', 'Unknown account type.');
    const { profileId } = await ensureProfile(userId);
    const { value: doc } = await readDoc(userId);
    // our own marker (Zernio appends its own ?connected=…&accountId=… or ?error=…&error_reason=…): the app reads both
    const redirect = `${appOrigin(env)}/?ylb_connect=${encodeURIComponent(platform)}`;
    const query = { profileId, redirect_url: redirect, ...brandQuery() };
    const ads = ADS_CONNECT[platform];
    const path = `/connect/${ads.connect}/ads`;
    if (ads.parent) {
      const parent = chosen(doc, ads.parent, projectId);
      if (!parent) throw fail(409, 'NOT_CONNECTED', `Connect ${NAMES[ads.parent] ?? 'the account'} first, then ${NAMES[platform]}.`);
      query.accountId = parent[0];
    }
    if (reconnect) query.force = 'true';
    const res = await call('GET', path, { query });
    if (res.status < 200 || res.status >= 300) {
      log_('zernio_connect_failed', { platform, status: res.status, code: zernioError(res).code });
      throw callFailure(res, platform);
    }
    await updateDoc(userId, (d) => {
      d.pending[platform] = { at: iso(now()), ...(projectId ? { projectId } : {}) };
      delete d.lastError[platform];
      return { value: d };
    });
    if (res.body?.alreadyConnected === true) {
      await sync(userId).catch(() => null);
      log_('zernio_connect_already', { platform });
      return { alreadyConnected: true };
    }
    const link = typeof res.body?.authUrl === 'string' ? res.body.authUrl : '';
    let u = null;
    try {
      u = new URL(link);
    } catch {
      u = null;
    }
    if (!u || (u.protocol !== 'https:' && !(zernio.base !== 'https://zernio.com/api/v1' && u.protocol === 'http:'))) {
      log_('zernio_connect_bad_answer', { platform });
      throw fail(502, 'UNAVAILABLE', 'Couldn’t start connecting just now. Try again shortly.');
    }
    log_('zernio_connect_started', { platform, reconnect });
    // Zernio's link lasts 30 minutes (welcome screen)
    return { connectLink: link, expiresAt: iso(now() + PENDING_MS) };
  }

  // ───────────── reading the accounts back ─────────────

  /**
   * GET /v1/accounts for one profile, every ads account row: by default Zernio lists each ads login once per profile and
   * platform (its oldest row), so a second Meta ad account connected through the same login would never show, and an
   * account.connected webhook's row would be dropped again by the next read. adAccountRows=true lists one row per ad
   * account. A Zernio that doesn't know the parameter (400 on it) is asked again without it (a read: safe to repeat).
   * Rows are kept only when they sit in this profile (profileId as an id or as the Profile object).
   */
  async function listAccounts(profileId) {
    const query = { profileId, includeOverLimit: 'true', adAccountRows: 'true' };
    let res = await call('GET', '/accounts', { query, retry429: true });
    if (res.status === 400 && zernioError(res).param === 'adAccountRows') {
      const { adAccountRows, ...plain } = query;
      res = await call('GET', '/accounts', { query: plain, retry429: true });
    }
    if (res.status < 200 || res.status >= 300) return { res, accounts: null };
    const accounts = (Array.isArray(res.body?.accounts) ? res.body.accounts : []).filter((a) => {
      if (!isObj(a) || !ZID.test(String(a._id ?? ''))) return false;
      const pid = profileIdOf(a);
      return !pid || pid === profileId;
    });
    return { res, accounts };
  }

  /**
   * GET /v1/accounts for the user's profile → the doc's accounts (labels, state). Assigns a waiting business: to the
   * account Zernio named on its way back (hint.accountId, when it's one of this user's rows for that platform), else to
   * the first new one.
   */
  async function sync(userId, hint = null) {
    const { value: doc } = await readDoc(userId);
    if (!doc.profileId) return doc;
    const { res, accounts: all } = await listAccounts(doc.profileId);
    if (!all) throw callFailure(res);
    const listed = all.filter((a) => FROM_ZERNIO[a.platform]);
    // the hidden posting account an ad account's connect made (enabled: false), which holds the customer's token
    const hiddenParent = (a) => {
      const id = String(a.parentAccountId ?? '');
      return ZID.test(id) && all.some((x) => String(x._id) === id && x.enabled === false) ? id : null;
    };
    return updateDoc(userId, (d) => {
      const before = d.accounts ?? {};
      const next = {};
      for (const a of listed) {
        const zid = String(a._id);
        const platform = FROM_ZERNIO[a.platform];
        const old = before[zid];
        next[zid] = {
          platform,
          label: clip(a.displayName || a.username || a.name || NAMES[platform], 80),
          // the listing's flag is `needsReconnection` (docs: accounts and webhooks); `needsReconnect` is the health check's
          state: a.isActive === false || a.needsReconnection === true || a.needsReconnect === true || a.status === 'disconnected' ? 'needs_reconnect' : 'connected',
          connectedAt: old?.connectedAt ?? (typeof a.createdAt === 'string' && Number.isFinite(Date.parse(a.createdAt)) ? a.createdAt : iso(now())),
          ...(hiddenParent(a) ? { parent: hiddenParent(a) } : old?.parent ? { parent: old.parent } : {}),
        };
        if (!old && !(hint?.platform === platform && hint.accountId)) assignPending(d, platform, zid);
      }
      d.accounts = next;
      // the account Zernio said it connected (new, or a login that was already there and was signed in again)
      if (hint?.accountId && next[hint.accountId]?.platform === hint.platform) assignPending(d, hint.platform, hint.accountId);
      else if (hint?.platform && hint.accountId) {
        const fresh = Object.keys(next).find((zid) => !before[zid] && next[zid].platform === hint.platform);
        if (fresh) assignPending(d, hint.platform, fresh);
      }
      pruneChoices(d);
      return { value: d, result: d };
    });
  }

  /** A new account for a platform a business was waiting on: that business uses it (and it's the default if none). */
  function assignPending(d, platform, zid) {
    const waiting = d.pending?.[platform];
    if (!waiting) return;
    if (waiting.projectId) {
      d.choice[waiting.projectId] = { ...(d.choice[waiting.projectId] ?? {}), [platform]: zid };
    }
    if (!d.choice[DEFAULT]?.[platform]) d.choice[DEFAULT] = { ...(d.choice[DEFAULT] ?? {}), [platform]: zid };
    delete d.pending[platform];
  }

  /** Choices that name an account that's gone are dropped. */
  function pruneChoices(d) {
    for (const [key, map] of Object.entries(d.choice ?? {})) {
      for (const [p, zid] of Object.entries(map ?? {})) if (!d.accounts[zid]) delete map[p];
      if (!Object.keys(map ?? {}).length) delete d.choice[key];
    }
  }

  /** accountId: the account Zernio named when it sent the customer back (?accountId=), a hint only. */
  async function check(userId, platform, { projectId, accountId } = {}) {
    requireSetUp();
    const doc = await sync(userId, ZID.test(String(accountId ?? '')) ? { platform, accountId: String(accountId) } : null);
    return statusOf(doc, platform, projectId);
  }

  /**
   * Zernio sent the customer back with ?error=…: this platform stops waiting, and the reason is kept as lastError (our
   * code, never Zernio's text). The team-level ones (ads add-on, Zernio billing) also go to the owner.
   */
  async function abandon(userId, platform, { projectId, reason } = {}) {
    requireSetUp();
    if (!isAds(platform)) throw fail(404, 'NOT_FOUND', 'Unknown account type.');
    const code = connectErrorReason(reason);
    if (code === 'ads_addon_required' || code === 'payment_required') ownerAlert(code);
    const doc = await updateDoc(userId, (d) => {
      delete d.pending[platform];
      d.lastError[platform] = code;
      return { value: d, result: d };
    });
    log_('zernio_connect_returned_error', { platform, reason: code });
    return statusOf(doc, platform, projectId);
  }

  async function disconnect(userId, platform, { projectId } = {}) {
    requireSetUp();
    const { value: doc } = await readDoc(userId);
    const pick = chosen(doc, platform, projectId);
    const ids = pick ? [pick[0]] : accountsOf(doc, platform).map(([zid]) => zid);
    // a hidden posting account goes with the last ad account that uses it (it holds the customer's token)
    const parents = [...new Set(ids.map((zid) => doc.accounts?.[zid]?.parent).filter((p) => p && !Object.entries(doc.accounts ?? {}).some(([z, a]) => !ids.includes(z) && a?.parent === p)))];
    for (const zid of [...ids, ...parents]) {
      // one attempt each; a 404 means it's already gone
      const res = await call('DELETE', `/accounts/${zid}`);
      if ((res.status < 200 || res.status >= 300) && res.status !== 404) throw callFailure(res, platform);
    }
    await updateDoc(userId, (d) => {
      for (const zid of ids) delete d.accounts[zid];
      delete d.pending[platform];
      pruneChoices(d);
      return { value: d };
    });
    log_('zernio_disconnected', { platform, count: ids.length });
  }

  async function targets(userId, platform) {
    requireSetUp();
    const { value: doc } = await readDoc(userId);
    return accountsOf(doc, platform).map(([zid, a]) => ({ id: handleOf(zid), label: a.label, kind: 'ads_account' }));
  }

  async function setTarget(userId, platform, targetId, { projectId } = {}) {
    requireSetUp();
    if (!TARGET_ID.test(String(targetId))) throw fail(400, 'BAD_REQUEST', 'Choose one of the listed accounts.');
    return updateDoc(userId, (d) => {
      const hit = accountsOf(d, platform).find(([zid]) => handleOf(zid) === targetId);
      if (!hit) throw fail(400, 'BAD_REQUEST', 'Choose one of the listed accounts.');
      const key = projectId ?? DEFAULT;
      d.choice[key] = { ...(d.choice[key] ?? {}), [platform]: hit[0] };
      if (key !== DEFAULT && !d.choice[DEFAULT]?.[platform]) d.choice[DEFAULT] = { ...(d.choice[DEFAULT] ?? {}), [platform]: hit[0] };
      return { value: d, result: statusOf(d, platform, projectId) };
    });
  }

  // ───────────── ledger (Zernio calls per customer, next to treg's) ─────────────

  async function ledger(row) {
    if (!dbReady || !row.customer_tag) return;
    try {
      await db.insert('usage_ledger', { vendor: 'zernio', cost_micro: 0, estimated: false, ...row });
    } catch {
      log_('zernio_ledger_failed', { endpoint: row.endpoint });
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
    if (forgotten(doc)) throw fail(409, 'NOT_CONNECTED', `${NAMES[platform]} isn’t connected.`);
    const pick = chosen(doc, platform, projectId);
    if (!pick) {
      if (accountsOf(doc, platform).length) throw fail(409, 'NOT_CONNECTED', `Choose which ${NAMES[platform]} account to use in Settings → Connected accounts.`);
      throw fail(409, 'NOT_CONNECTED', `${NAMES[platform]} isn’t connected.`);
    }
    if (pick[1].state === 'needs_reconnect') throw fail(409, 'NEEDS_RECONNECT', `Reconnect ${NAMES[platform]} in Settings → Connected accounts.`);
    return { doc, zid: pick[0], account: pick[1], tag: tagOf(doc, userId) };
  }

  // ───────────── ad results (reads) ─────────────

  /** Social stats are Upload-Post's: nothing here. */
  async function insights() {
    return null;
  }

  async function adResults(userId, platform, { projectId, since, until } = {}) {
    let got;
    try {
      got = await usable(userId, platform, projectId);
    } catch (e) {
      if (e?.code === 'NOT_CONNECTED') return null;
      if (e?.code === 'NEEDS_RECONNECT') throw Object.assign(new Error('reconnect'), { kind: 'reconnect' });
      throw e;
    }
    const { zid, tag } = got;
    const from = ymd(since ?? now() - 30 * 86_400_000);
    const to = ymd(until ?? now());
    const read = async (path, query, endpoint) => {
      const res = await call('GET', path, { query, retry429: true });
      await ledger({ customer_tag: tag, user_id: userId, project_id: projectId ?? null, feature: 'ads', endpoint: `${platform}:${endpoint}`, http_status: res.status, outcome: res.status < 400 ? 'ok' : res.status >= 500 ? 'unknown' : 'failed' });
      return res;
    };
    const timeline = okBody(await read('/ads/timeline', { accountId: zid, fromDate: from, toDate: to }, 'timeline'));
    const rows = (Array.isArray(timeline.rows) ? timeline.rows : []).filter(isObj);
    // one currency: the one with the most spend (an account billing in several currencies shows its main one)
    const spendBy = new Map();
    for (const r of rows) spendBy.set(r.currency ?? '', (spendBy.get(r.currency ?? '') ?? 0) + (Number(r.spend) || 0));
    const currency = [...spendBy.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'USD';
    const mine = rows.filter((r) => (r.currency ?? '') === currency || (!r.currency && currency === 'USD'));
    const series = mine.map((r) => ({ date: String(r.date ?? '').slice(0, 10), spend: Math.round((Number(r.spend) || 0) * 100) / 100, clicks: num(r.clicks) ?? 0 })).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
    const cres = await read('/ads/campaigns', { accountId: zid, fromDate: from, toDate: to, limit: 50 }, 'campaigns');
    const campaigns = (cres.status >= 200 && cres.status < 300 && Array.isArray(cres.body?.campaigns) ? cres.body.campaigns : [])
      .filter((c) => isObj(c) && (!c.currency || c.currency === currency))
      .map((c) => ({
        id: text(c.platformCampaignId ?? c._id, 64),
        name: text(c.campaignName ?? c.name ?? '', 200),
        spend: Math.round((Number(c.metrics?.spend) || 0) * 100) / 100,
        impressions: num(c.metrics?.impressions) ?? 0,
        clicks: num(c.metrics?.clicks) ?? 0,
        conversions: Number(c.metrics?.conversions) || 0,
      }))
      .filter((c) => c.id)
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 50);
    const sumRows = (k) => mine.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    return {
      platform,
      currency: String(currency).slice(0, 3).toUpperCase() || 'USD',
      spend: Math.round(sumRows('spend') * 100) / 100,
      impressions: Math.round(sumRows('impressions')),
      clicks: Math.round(sumRows('clicks')),
      conversions: Math.round(sumRows('conversions') * 100) / 100,
      series,
      campaigns,
    };
  }

  // ───────────── posting is Upload-Post's ─────────────

  async function publish() {
    return { state: 'failed', errorCode: 'NO_TARGET', ref: { via: 'zernio' } };
  }

  async function postStatus() {
    return null;
  }

  // ───────────── webhooks ─────────────

  /** The customer an event is for: profiles[0].externalId → billing_customers → user id (null when not ours). */
  async function userOfEvent(evt) {
    const ext = Array.isArray(evt?.profiles) ? evt.profiles.find((p) => isObj(p) && typeof p.externalId === 'string')?.externalId : null;
    if (!ext || !/^cust_[0-9a-f]{24}$/.test(ext)) return null;
    const rows = await db.select('billing_customers', { customer_tag: ext }, { select: 'customer_tag,user_id', limit: 1 });
    const userId = rows[0]?.user_id;
    if (!userId) return null;
    // the event's profile must be the one stored for that customer
    const { value: doc } = await readDoc(userId);
    const pid = evt.profiles.find((p) => p?.externalId === ext)?.id;
    if (doc.profileId && pid && pid !== doc.profileId) return null;
    return { userId, doc };
  }

  async function applyEvent(evt) {
    const type = String(evt.event ?? '');
    if (type === 'webhook.test') return 'test';
    const who = await userOfEvent(evt);
    if (!who) return 'not_ours';
    const { userId } = who;
    if (type === 'account.connected' || type === 'account.disconnected') {
      const a = isObj(evt.account) ? evt.account : {};
      const zid = String(a.accountId ?? '');
      const platform = FROM_ZERNIO[a.platform];
      if (!ZID.test(zid) || !platform) return 'ignored';
      // the account must sit in this customer's own profile (account.profileId), not only the event's profiles list
      if (profileIdOf(a) && who.doc.profileId && profileIdOf(a) !== who.doc.profileId) return 'not_ours';
      // Zernio puts disconnectionType inside `account` (webhooks/accounts); the top level is read too for older senders
      const disconnection = String(a.disconnectionType ?? evt.disconnectionType ?? '');
      await updateDoc(userId, (d) => {
        if (type === 'account.connected') {
          const isNew = !d.accounts[zid];
          d.accounts[zid] = { platform, label: clip(a.displayName || a.username || NAMES[platform], 80), state: 'connected', connectedAt: d.accounts[zid]?.connectedAt ?? iso(now()) };
          if (isNew) assignPending(d, platform, zid);
          delete d.lastError[platform];
        } else if (d.accounts[zid]) {
          if (disconnection === 'intentional') delete d.accounts[zid];
          else d.accounts[zid].state = 'needs_reconnect';
          pruneChoices(d);
        }
        return { value: d };
      });
      return 'applied';
    }
    if (AD_EVENTS.includes(type)) {
      // only an event about one of this customer's own connections reaches the ads side; a throw answers 500 so
      // Zernio delivers it again (the dedupe row is written only after this succeeds)
      const zid = String(evt.account?.accountId ?? '');
      if (!ZID.test(zid) || !Object.hasOwn(who.doc.accounts ?? {}, zid)) return 'not_ours';
      if (typeof adsListener === 'function') await adsListener(userId, zid, evt);
      return 'applied';
    }
    // post.* events: posting is Upload-Post's, nothing to do here
    return 'ignored';
  }

  /**
   * POST /api/webhooks/zernio: rawBody is the exact bytes. → { status, body }. Nothing is read or written for a
   * delivery whose signature doesn't match. A delivery seen before (same event id) answers 200 and does nothing.
   */
  async function webhook(rawBody, headers = {}) {
    if (!zernio.webhookReady || !dbReady || !storageReady) return { status: 503, body: { error: 'Not set up.', code: 'NOT_SET_UP' } };
    const sig = headers['x-zernio-signature'] ?? headers['x-late-signature'];
    if (!zernio.verifySignature(rawBody, sig)) return { status: 401, body: { error: 'Bad signature.', code: 'FORBIDDEN' } };
    let evt;
    try {
      evt = JSON.parse(Buffer.from(rawBody).toString('utf8'));
    } catch {
      return { status: 400, body: { error: 'Bad request.', code: 'BAD_REQUEST' } };
    }
    if (!isObj(evt)) return { status: 400, body: { error: 'Bad request.', code: 'BAD_REQUEST' } };
    const eventId = String(evt.id ?? headers['x-zernio-event-id'] ?? '');
    const dedupeKey = `zernio:${/^[A-Za-z0-9_-]{6,80}$/.test(eventId) ? eventId : sha256(rawBody)}`;
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
      // a failed write answers 500 so Zernio delivers it again (it's idempotent by event id)
      log_('zernio_webhook_failed', { event: clip(evt.event, 60) });
      return { status: 500, body: { error: 'Try again.', code: 'UNAVAILABLE' } };
    }
    try {
      await db.upsert('webhook_deliveries', { body_hash: dedupeKey, received_at: iso(now()) }, { onConflict: 'body_hash' });
    } catch {
      /* a repeat would apply the same change again: harmless */
    }
    log_('zernio_webhook', { event: clip(evt.event, 60), outcome });
    return { status: 200, body: { ok: true } };
  }

  // ───────────── account deletion ─────────────

  async function forgetUser(userId) {
    if (!storageReady) return;
    const { value: doc } = await readDoc(userId);
    // every account in the customer's profile is disconnected, hidden posting accounts too (one attempt each; a
    // failure stops the deletion), then the profile itself, then the doc
    if (setUp && doc.profileId) {
      const listed = await listAccounts(doc.profileId).catch(() => null);
      const fromZernio = listed?.accounts ? listed.accounts.map((a) => String(a._id)) : [];
      const known = Object.entries(doc.accounts ?? {}).flatMap(([zid, a]) => [zid, ...(a?.parent ? [a.parent] : [])]);
      for (const zid of [...new Set([...fromZernio, ...known])]) {
        const res = await call('DELETE', `/accounts/${zid}`);
        if ((res.status < 200 || res.status >= 300) && res.status !== 404) throw fail(503, 'UNAVAILABLE', 'Couldn’t disconnect your accounts just now. Try again shortly.');
      }
      // the profile goes once it's empty (one attempt; a refusal leaves an empty profile, which costs nothing)
      const gone = await call('DELETE', `/profiles/${doc.profileId}`).catch(() => null);
      if (!gone || ((gone.status < 200 || gone.status >= 300) && gone.status !== 404)) log_('zernio_profile_delete_failed', { status: gone?.status ?? null });
    }
    await updateDoc(userId, (d) => ({ value: { ...blankDoc(), customer: d.customer, forgottenAt: iso(now()) } }));
  }

  async function unforgetUser(userId) {
    if (!storageReady) return;
    await updateDoc(userId, (d) => {
      if (!d.forgottenAt) return { write: false };
      delete d.forgottenAt;
      return { value: d };
    });
  }

  // ───────────── connected-account counts per customer (estimates; never count toward a cap) ─────────────

  /**
   * Once per month (on start and daily): for last month, one `zernio_accounts` row per customer with how many
   * ad accounts they had connected (prorated by days at $6 an account-month, Zernio's list price). Claimed with
   * ifVersion so two servers don't both write it.
   */
  async function meterIfDue() {
    if (!setUp) return { skipped: true };
    const t = new Date(now());
    const start = Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1);
    const end = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1);
    const month = iso(start).slice(0, 7);
    const claimKey = `zernio:metered:${month}`;
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
        log_('zernio_meter_failed', { month });
        return { rows };
      }
      for (const c of customers) {
        let doc;
        try {
          doc = (await readDoc(c.user_id)).value;
        } catch {
          continue;
        }
        let micro = 0;
        let count = 0;
        for (const a of Object.values(doc.accounts ?? {})) {
          const from = Math.max(start, Date.parse(a?.connectedAt) || start);
          if (from >= end) continue;
          count += 1;
          micro += Math.round((ACCOUNT_MONTH_MICRO * (end - from)) / 86_400_000 / days);
        }
        if (count > 0) {
          await ledger({ customer_tag: c.customer_tag, user_id: c.user_id, feature: 'connections', endpoint: `zernio_accounts ${month} (${count})`, cost_micro: micro, estimated: true, outcome: 'ok' });
          rows += 1;
        }
      }
      if (customers.length < 1000) break;
    }
    log_('zernio_metered', { month, rows });
    return { rows };
  }

  /** How many ad accounts a customer has connected now (the owner's per-customer view). */
  async function accountCount(userId) {
    if (!storageReady) return 0;
    const { value } = await readDoc(userId);
    return forgotten(value) ? 0 : Object.keys(value.accounts ?? {}).length;
  }

  return {
    enabled: true,
    setUp,
    hint,
    status,
    connectLink: (userId, platform, opts = {}) => startConnect(userId, platform, { ...opts, reconnect: false }),
    reconnectLink: (userId, platform, opts = {}) => startConnect(userId, platform, { ...opts, reconnect: true }),
    check,
    abandon,
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
    accountCount,
    /** server/ads/: the business's Zernio connection for an ad platform → { zid, label, tag }, or a plain refusal */
    async adsAccountFor(userId, platform, projectId) {
      if (platform !== 'meta_ads' && platform !== 'google_ads') throw fail(404, 'NOT_FOUND', 'Unknown account type.');
      const { zid, account, tag } = await usable(userId, platform, projectId);
      return { zid, label: account.label, tag };
    },
    /** the one Zernio client: ads writes share its ZERNIO_RPM window with every other call */
    client: zernio,
    setAdsListener(fn) {
      adsListener = typeof fn === 'function' ? fn : null;
    },
  };
}
