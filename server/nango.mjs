// Connected accounts through Nango: each app user connects their own Facebook Page (and the Instagram account
// on it), LinkedIn, TikTok, X, YouTube, Google Ads, Meta Ads and Search Console. Nango holds their logins; this
// server keeps, per user, which connection belongs to which network and the account (Page, channel, ad
// account, site) they chose. Selected by server/integrations/wiring.mjs once NANGO_SECRET_KEY is set
// (CONNECTIONS_PROVIDER=off keeps it off); see docs/integrations-setup.md §3.
//
//   const nango = createNango({ env, fetch, now, storage, db, log });
//   → the methods of server/connections/index.mjs, plus webhook(rawBody, headers) for POST /api/webhooks/nango
//     and meterIfDue() (the monthly connection-cost estimate rows).
//
// Rules this file keeps (spec §1.3):
// - The API key is sent only to Nango, in Authorization. It, connect links and tokens are never logged,
//   stored or returned to a route; logs go through safeLog, which drops anything named like a token or link.
// - The browser gets ConnectionStatus only: connection ids and the chosen account's real id stay here. Paths
//   name the chosen account with placeholders this file fills: {target} (its id) and {ig_user} (the Instagram
//   professional account of the chosen Facebook Page).
// - Tags sent to Nango are the opaque customer tag only (never an email or a name).
// - Never `Retries` or `Retry-On`: a write is one attempt. Reads (oneShot:false) may repeat once after a 429,
//   waiting its Retry-After (60 s at most). Derived tokens (a Page token, upload URLs) never go through the
//   proxy: an Authorization header for the provider is refused here.
// - Webhooks are HMAC-checked on the exact bytes, stored before the 200 (a failed store answers 500 so Nango
//   sends it again), and apply only to the connection they name.

import crypto from 'node:crypto';
import { LEDGER_FEATURES, PHASE2_PLATFORMS, PLATFORMS } from './integrations/contracts.mjs';
import { customerTag, ensureCustomer, fail, IntegrationError, notSetUp, safeLog, sha256 } from './integrations/common.mjs';
import { notConnectedStatuses } from './connections/index.mjs';

export const NANGO_BASE_URL = 'https://api.nango.dev';
export const GRAPH_VERSION = 'v26.0';

/** Our Nango integration ids, by platform (NANGO_INTEGRATIONS may replace any of them). */
export const DEFAULT_INTEGRATIONS = Object.freeze({
  facebook: 'ylb-facebook',
  instagram: 'ylb-instagram',
  linkedin: 'ylb-linkedin',
  tiktok: 'ylb-tiktok',
  x: 'ylb-x',
  youtube: 'ylb-youtube',
  pinterest: 'ylb-pinterest',
  google_ads: 'ylb-google-ads',
  meta_ads: 'ylb-meta-ads',
  microsoft_ads: 'ylb-microsoft-ads',
  tiktok_ads: 'ylb-tiktok-ads',
  google_search_console: 'ylb-gsc',
});

/** The Nango provider each integration is created from (docs/integrations-setup.md §3). */
export const NANGO_PROVIDERS = Object.freeze({
  facebook: 'facebook',
  instagram: 'instagram',
  linkedin: 'linkedin',
  tiktok: 'tiktok-personal',
  x: 'twitter-v2',
  youtube: 'youtube',
  pinterest: 'pinterest',
  google_ads: 'google-ads',
  meta_ads: 'meta-marketing-api',
  microsoft_ads: 'microsoft-ads',
  tiktok_ads: 'tiktok-ads',
  google_search_console: 'google-search-console',
});

const NAMES = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  x: 'X',
  youtube: 'YouTube',
  pinterest: 'Pinterest',
  google_ads: 'Google Ads',
  meta_ads: 'Meta Ads',
  microsoft_ads: 'Microsoft Ads',
  tiktok_ads: 'TikTok Ads',
  google_search_console: 'Search Console',
};

/** Instagram (phase 1) goes through the Facebook connection: the Page's Instagram professional account. */
const CONNECT_AS = Object.freeze({ instagram: 'facebook' });
const connectionPlatform = (platform) => CONNECT_AS[platform] ?? platform;

const FACEBOOK_SCOPES = [
  'pages_show_list',
  'pages_manage_posts',
  'pages_read_engagement',
  'pages_manage_engagement',
  'read_insights',
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_insights',
  'instagram_manage_comments',
  'business_management',
];

/**
 * The scopes each connect asks for (comma-separated, nango-digest §2). LinkedIn's org scopes only once
 * LINKEDIN_ORG_APPROVED=1: LinkedIn refuses the whole sign-in when one scope isn't granted to the app.
 */
export function scopesFor(platform, env = {}) {
  switch (platform) {
    case 'facebook':
      return FACEBOOK_SCOPES.join(',');
    case 'linkedin': {
      const s = ['openid', 'profile', 'w_member_social'];
      if (String(env.LINKEDIN_MEMBER_ANALYTICS_APPROVED || '') === '1') s.push('r_member_postAnalytics');
      if (String(env.LINKEDIN_ORG_APPROVED || '') === '1') s.push('w_organization_social', 'r_organization_social', 'rw_organization_admin');
      return s.join(',');
    }
    case 'tiktok':
      return 'user.info.basic,user.info.stats,video.list,video.publish';
    case 'x':
      return 'tweet.read,tweet.write,users.read,media.write,offline.access';
    case 'youtube':
      return 'https://www.googleapis.com/auth/youtube.upload,https://www.googleapis.com/auth/youtube.readonly,https://www.googleapis.com/auth/yt-analytics.readonly';
    case 'google_ads':
      return 'https://www.googleapis.com/auth/adwords';
    case 'meta_ads':
      return 'ads_read,business_management';
    case 'google_search_console':
      return 'https://www.googleapis.com/auth/webmasters,https://www.googleapis.com/auth/siteverification';
    default:
      return '';
  }
}

/** The Meta permissions a connection must have granted (anything missing reads "Some permissions weren't allowed"). */
const REQUIRED_META = { facebook: FACEBOOK_SCOPES, meta_ads: ['ads_read', 'business_management'] };

const PENDING_MS = 30 * 60_000;
const FB_EXPIRES_SOON_MS = 50 * 86_400_000;
const FORGOTTEN_FOR_MS = 24 * 3_600_000;
const DEDUPE_MS = 10 * 60_000;
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 120_000;
const API_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_S = 60;
const PER_USER_IN_FLIGHT = 3;
const CONNECTION_MONTH_MICRO = 290_000; // $0.29 per connection-month (Nango Pay-as-you-go list price)
const PROXY_GB_MICRO = 500_000; // $0.50 per GB

/** Provider headers handed back to the caller (nothing else). */
const HEADER_WHITELIST = ['location', 'x-restli-id', 'content-type', 'retry-after'];
/** Nango's own error codes (the provider's pass through unchanged). */
const NANGO_CODES = new Set(['unknown_provider_config', 'server_error', 'connection_refresh_backoff', 'plan_limit', 'unknown_connection', 'invalid_credentials', 'base_url_override_disabled', 'base_url_override_not_allowed', 'missing_connection_id', 'missing_provider_config_key']);
/** Query keys that would carry a secret (Nango logs full URLs). `fields=access_token` names a field: fine. */
const SECRET_QUERY_KEY = /^(access_token|client_secret|app_secret|secret|api_key|apikey|key|password|developer_token)$/i;
const RESERVED_HEADER = /^(authorization|retries|retry-on|connection-id|provider-config-key|base-url-override|host|cookie|content-length)$/i;
const INTEGRATION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const TARGET_ID = /^tgt_[0-9a-f]{32}$/;
const ERROR_TYPE = /^[a-z0-9_]{1,40}$/i;

const iso = (ms) => new Date(ms).toISOString();
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const clip = (s, n = 120) => {
  const t = str(s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const docKey = (userId) => `nango:user:${sha256(String(userId))}`;
const blankDoc = () => ({ v: 1, platforms: {}, pendingSince: {} });

/** Instances by the storage they share, so the webhook route finds the one wiring.mjs built. */
const registry = new WeakMap();

/** The Nango instance created for these deps (same storage), if any. */
export function nangoFor(deps) {
  const key = deps?.storage ?? deps?.env;
  return key && typeof key === 'object' ? (registry.get(key) ?? null) : null;
}

/** NANGO_INTEGRATIONS (JSON) over the defaults: only known platforms and plain ids. */
export function integrationIds(env = {}) {
  const ids = { ...DEFAULT_INTEGRATIONS };
  const raw = String(env.NANGO_INTEGRATIONS || '').trim();
  if (!raw) return ids;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ids;
  }
  if (!isObj(parsed)) return ids;
  for (const [platform, id] of Object.entries(parsed)) if (PLATFORMS.includes(platform) && typeof id === 'string' && INTEGRATION_ID.test(id)) ids[platform] = id;
  return ids;
}

/** Hex HMAC compare in constant time (false for anything that isn't the right length). */
function sameHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** Fill {target} / {ig_user} in a string: encoded for a path segment, raw for a query value or a body string. */
function fillPlaceholders(s, values, encode) {
  return String(s).replace(/\{(target|ig_user)\}/g, (_, name) => (encode ? encodeURIComponent(values[name]) : values[name]));
}

function deepFill(value, values, depth = 0) {
  if (typeof value === 'string') return fillPlaceholders(value, values, false);
  if (depth > 8 || value == null || typeof value !== 'object' || Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map((v) => deepFill(v, values, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepFill(v, values, depth + 1)]));
}

const usesPlaceholder = (value, name, depth = 0) => {
  if (typeof value === 'string') return value.includes(`{${name}}`);
  if (depth > 8 || value == null || typeof value !== 'object' || Buffer.isBuffer(value) || value instanceof Uint8Array) return false;
  return Object.values(value).some((v) => usesPlaceholder(v, name, depth + 1));
};

function parseRetryAfter(value, nowMs) {
  const s = String(value ?? '').trim();
  if (!s) return 1;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const at = Date.parse(s);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - nowMs) / 1000)) : 1;
}

/**
 * env: NANGO_SECRET_KEY, NANGO_WEBHOOK_SIGNING_KEY (+ _PREVIOUS), NANGO_BASE_URL, NANGO_INTEGRATIONS, NANGO_RPM,
 * META_LOGIN_CONFIG_ID, LINKEDIN_*_APPROVED, CUSTOMER_TAG_SECRET. storage: appState (encrypted docs, ifVersion).
 * db: server/integrations/db.mjs. sleep: for tests.
 */
export function createNango({ env = process.env, fetch = globalThis.fetch, now = () => Date.now(), storage = null, db = null, log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const key = String(env.NANGO_SECRET_KEY || '').trim();
  const signingKeys = [env.NANGO_WEBHOOK_SIGNING_KEY, env.NANGO_WEBHOOK_SIGNING_KEY_PREVIOUS].map((k) => String(k || '').trim()).filter(Boolean);
  const base = String(env.NANGO_BASE_URL || NANGO_BASE_URL).replace(/\/+$/, '');
  const testBase = base !== NANGO_BASE_URL;
  const ids = integrationIds(env);
  const platformOf = new Map(Object.entries(ids).filter(([p]) => p !== 'instagram').map(([p, id]) => [id, p]));
  const rpm = Math.max(1, Math.min(10_000, Number.parseInt(env.NANGO_RPM, 10) || 150));
  const storageReady = storage?.enabled === true;
  const dbReady = db?.enabled === true;
  const tagSecret = String(env.CUSTOMER_TAG_SECRET || '');
  const log_ = (event, fields) => safeLog(event, fields, log);

  const missing = [
    ...(key ? [] : ['NANGO_SECRET_KEY']),
    ...(signingKeys.length ? [] : ['NANGO_WEBHOOK_SIGNING_KEY']),
    ...(tagSecret.length >= 16 ? [] : ['CUSTOMER_TAG_SECRET']),
  ];
  const setUp = missing.length === 0 && storageReady && dbReady;
  const hint = missing.length
    ? `Connecting accounts needs these Replit Secrets: ${missing.join(', ')}.`
    : !storageReady || !dbReady
      ? 'Connecting accounts needs Supabase server storage (SUPABASE_URL, SUPABASE_SECRET_KEY, the app_state and integrations migrations).'
      : '';

  function requireSetUp() {
    if (!setUp) throw notSetUp(hint, 'Connecting accounts isn’t available yet.');
  }

  // ───────────── stored doc ─────────────

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
    if (!isObj(value.platforms)) value.platforms = {};
    if (!isObj(value.pendingSince)) value.pendingSince = {};
    return { value, version: got?.updatedAt ?? null };
  }

  /** change(doc) → { value, result } or { write: false, result }. Re-reads and retries on a version conflict. */
  async function updateDoc(userId, change) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await readDoc(userId);
      const out = change(structuredClone(current.value));
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

  // ───────────── status ─────────────

  function entryState(entry) {
    if (entry.state === 'needs_reconnect') return 'needs_reconnect';
    if (entry.limited) return 'limited';
    return 'connected';
  }

  function statusOf(doc, platform) {
    if (PHASE2_PLATFORMS.includes(platform)) return { platform, state: 'coming_soon' };
    if (platform === 'instagram') {
      const fb = doc.platforms?.facebook;
      const ig = fb?.target?.igUserId;
      if (!fb?.connectionId || !ig) return { platform, state: 'not_connected' };
      const state = entryState(fb);
      return {
        platform,
        state,
        ...(state === 'limited' ? { limitedReason: fb.limited } : {}),
        targetLabel: fb.target.igLabel || `Instagram on ${fb.target.label}`,
        targetKind: 'ig_account',
        ...(fb.connectedAt ? { connectedAt: fb.connectedAt } : {}),
        ...(state === 'needs_reconnect' && fb.lastError ? { lastError: fb.lastError } : {}),
      };
    }
    const entry = doc.platforms?.[platform];
    if (entry?.connectionId) {
      const state = entryState(entry);
      const out = { platform, state };
      if (state === 'limited') out.limitedReason = entry.limited;
      if (entry.target?.label) {
        out.targetLabel = entry.target.label;
        out.targetKind = entry.target.kind;
      }
      if (Number.isFinite(entry.targetsAvailable)) out.targetsAvailable = entry.targetsAvailable;
      if (entry.connectedAt) out.connectedAt = entry.connectedAt;
      const age = now() - Date.parse(entry.connectedAt);
      if ((platform === 'facebook' || platform === 'meta_ads') && Number.isFinite(age) && age > FB_EXPIRES_SOON_MS) out.expiresSoon = true;
      if (state === 'needs_reconnect' && entry.lastError) out.lastError = entry.lastError;
      return out;
    }
    const pending = Date.parse(doc.pendingSince?.[platform]);
    if (Number.isFinite(pending)) {
      if (now() - pending < PENDING_MS) return { platform, state: 'pending' };
      return { platform, state: 'not_connected', lastError: 'not_finished' };
    }
    if (entry?.lastError) return { platform, state: 'not_connected', lastError: entry.lastError };
    return { platform, state: 'not_connected' };
  }

  async function status(userId) {
    if (!storageReady) return notConnectedStatuses();
    const { value } = await readDoc(userId);
    if (forgotten(value)) return notConnectedStatuses();
    return PLATFORMS.map((p) => statusOf(value, p));
  }

  // ───────────── Nango's own API ─────────────

  async function api(method, path, { query, body, timeoutMs = API_TIMEOUT_MS } = {}) {
    const q = query ? `?${new URLSearchParams(query)}` : '';
    let res;
    try {
      res = await fetch(`${base}${path}${q}`, {
        method,
        headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { status: 0, body: null };
    }
    let parsed = null;
    try {
      const text = await res.text();
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  }

  const nangoCode = (body) => (typeof body?.error?.code === 'string' ? body.error.code : '');

  /** An answer from Nango's own API that isn't a success, in our words (never Nango's text). */
  function apiFailure(r, integrationId) {
    const code = nangoCode(r.body);
    if (code === 'unknown_provider_config' || r.status === 404) return notSetUp(`Create the integration "${integrationId}" in Nango (docs/integrations-setup.md §3).`, 'Connecting this account isn’t set up yet.');
    if (r.status === 401 || r.status === 403) return notSetUp('Nango refused the API key: check NANGO_SECRET_KEY and its scopes (docs/integrations-setup.md §3).', 'Connecting accounts isn’t available right now.');
    if (code === 'plan_limit' || r.status === 402) {
      ownerAlert('plan_limit');
      return fail(503, 'CONNECTIONS_UNAVAILABLE', 'Connecting accounts isn’t available right now. Try again later.');
    }
    return fail(502, 'UNAVAILABLE', 'Couldn’t reach the sign-in service. Try again shortly.');
  }

  function ownerAlert(kind) {
    log_('nango_owner_alert', { kind });
    if (!storageReady) return;
    storage.put('nango:alert', { kind, at: iso(now()) }).catch(() => {});
  }

  // ───────────── connect and reconnect ─────────────

  function sessionDefaults(platform, integrationId) {
    if (platform === 'facebook' && String(env.META_LOGIN_CONFIG_ID || '').trim()) {
      return { [integrationId]: { authorization_params: { config_id: String(env.META_LOGIN_CONFIG_ID).trim() } } };
    }
    const scopes = scopesFor(platform, env);
    return scopes ? { [integrationId]: { connection_config: { oauth_scopes_override: scopes } } } : {};
  }

  function linkFrom(r) {
    const link = r.body?.data?.connect_link;
    const expiresAt = r.body?.data?.expires_at;
    if (typeof link !== 'string') return null;
    let u;
    try {
      u = new URL(link);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' && !(testBase && u.protocol === 'http:')) return null;
    return { connectLink: link, expiresAt: typeof expiresAt === 'string' && Number.isFinite(Date.parse(expiresAt)) ? expiresAt : iso(now() + PENDING_MS) };
  }

  async function startSession(userId, platform, reconnectEntry) {
    requireSetUp();
    if (PHASE2_PLATFORMS.includes(platform)) throw fail(400, 'BAD_REQUEST', `${NAMES[platform]} is coming soon.`);
    const conn = connectionPlatform(platform);
    const { value: doc } = await readDoc(userId);
    if (forgotten(doc)) throw fail(409, 'FORBIDDEN', 'This account is being deleted.');
    const tag = await ensureCustomer(db, userId, env).catch((e) => {
      if (e instanceof IntegrationError) throw e;
      throw fail(503, 'UNAVAILABLE', 'Couldn’t start connecting just now. Try again shortly.');
    });
    const integrationId = ids[conn];
    const tags = { end_user_id: tag, organization_id: tag };
    const defaults = sessionDefaults(conn, integrationId);
    const entry = reconnectEntry === undefined ? null : doc.platforms?.[conn];
    const r = entry?.connectionId
      ? await api('POST', '/connect/sessions/reconnect', { body: { connection_id: entry.connectionId, integration_id: entry.providerConfigKey || integrationId, tags, integrations_config_defaults: defaults } })
      : await api('POST', '/connect/sessions', { body: { tags, allowed_integrations: [integrationId], integrations_config_defaults: defaults } });
    if (r.status < 200 || r.status >= 300) {
      log_('nango_connect_session_failed', { platform: conn, status: r.status, code: nangoCode(r.body) });
      throw apiFailure(r, integrationId);
    }
    const link = linkFrom(r);
    if (!link) {
      log_('nango_connect_session_bad_answer', { platform: conn });
      throw fail(502, 'UNAVAILABLE', 'Couldn’t start connecting just now. Try again shortly.');
    }
    await updateDoc(userId, (d) => {
      d.customer = tag;
      d.pendingSince[conn] = iso(now());
      return { value: d };
    });
    log_('nango_connect_started', { platform: conn, reconnect: !!entry?.connectionId });
    return link;
  }

  const connectLink = (userId, platform) => startSession(userId, platform, undefined);
  const reconnectLink = (userId, platform) => startSession(userId, platform, true);

  // ───────────── the proxy ─────────────

  const window_ = []; // request times in the last minute, all users (NANGO_RPM)
  async function acquireRate() {
    for (let i = 0; i < 100; i += 1) {
      const t = now();
      while (window_.length && t - window_[0] >= 60_000) window_.shift();
      if (window_.length < rpm) {
        window_.push(t);
        return;
      }
      const wait = 60_000 - (t - window_[0]) + 5;
      if (wait > 60_000) break;
      await sleep(wait);
    }
    throw fail(503, 'CONNECTIONS_UNAVAILABLE', 'Too many requests to connected accounts right now. Try again in a minute.');
  }

  const inFlight = new Map(); // userId → { active, queue[] }
  async function withUserSlot(userId, fn) {
    let slot = inFlight.get(userId);
    if (!slot) inFlight.set(userId, (slot = { active: 0, queue: [] }));
    if (slot.active >= PER_USER_IN_FLIGHT) await new Promise((r) => slot.queue.push(r));
    slot.active += 1;
    try {
      return await fn();
    } finally {
      slot.active -= 1;
      const next = slot.queue.shift();
      if (next) next();
      else if (slot.active === 0) inFlight.delete(userId);
    }
  }

  async function ledger(row) {
    if (!dbReady) return;
    try {
      await db.insert('usage_ledger', { vendor: 'nango', cost_micro: 0, estimated: false, ...row });
    } catch {
      log_('nango_ledger_failed', { endpoint: row.endpoint });
    }
  }

  function bodyBytes(body) {
    if (body === undefined || body === null) return { payload: undefined, size: 0, json: false };
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) return { payload: body, size: body.byteLength, json: false };
    if (typeof body === 'string') return { payload: body, size: Buffer.byteLength(body), json: false };
    const s = JSON.stringify(body);
    return { payload: s, size: Buffer.byteLength(s), json: true };
  }

  /** Mark a connection as needing a reconnect (only while it is still that connection). */
  async function markReconnect(userId, conn, connectionId, reason) {
    try {
      await updateDoc(userId, (d) => {
        const e = d.platforms[conn];
        if (!e || e.connectionId !== connectionId) return { write: false };
        e.state = 'needs_reconnect';
        e.needsReconnect = reason;
        return { value: d };
      });
    } catch {
      /* the next read shows it */
    }
  }

  async function request(userId, platform, opts = {}) {
    requireSetUp();
    const method = String(opts.method || 'GET').toUpperCase();
    const path = String(opts.path || '');
    if (!/^\/[^\s?#]*$/.test(path) || path.includes('..') || path.includes('//')) throw fail(400, 'BAD_REQUEST', 'Bad request path.');
    const oneShot = opts.oneShot !== false; // one attempt unless a read says otherwise
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Math.min(Number(opts.timeoutMs), WRITE_TIMEOUT_MS) : method === 'GET' || method === 'HEAD' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
    const conn = connectionPlatform(platform);
    const { value: doc } = await readDoc(userId);
    const entry = doc.platforms?.[conn];
    if (forgotten(doc) || !entry?.connectionId) throw fail(409, 'NOT_CONNECTED', `${NAMES[platform]} isn’t connected.`);
    if (entry.state === 'needs_reconnect') throw fail(409, 'NEEDS_RECONNECT', `Reconnect ${NAMES[conn]} in Settings → Connected accounts.`);

    // the chosen account, by placeholder (its id never leaves this file)
    const wants = (name) => usesPlaceholder(path, name) || usesPlaceholder(opts.query ?? {}, name) || usesPlaceholder(opts.body ?? null, name);
    const values = { target: '', ig_user: '' };
    if (wants('target')) {
      if (!entry.target?.id) throw fail(409, 'NOT_CONNECTED', `Choose which account to use for ${NAMES[conn]} in Settings → Connected accounts.`);
      values.target = entry.target.id;
    }
    if (wants('ig_user')) {
      if (!entry.target?.igUserId) throw fail(409, 'NOT_CONNECTED', 'The chosen Facebook Page has no Instagram professional account.');
      values.ig_user = entry.target.igUserId;
    }
    const filledPath = fillPlaceholders(path, values, true);
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === null) continue;
      if (SECRET_QUERY_KEY.test(k)) throw fail(400, 'BAD_REQUEST', 'Secrets never go in a query string.');
      q.append(k, fillPlaceholders(String(v), values, false));
    }
    const qs = q.toString();

    const headers = { authorization: `Bearer ${key}`, 'connection-id': entry.connectionId, 'provider-config-key': entry.providerConfigKey };
    if (opts.baseUrlOverride) {
      let u;
      try {
        u = new URL(String(opts.baseUrlOverride));
      } catch {
        throw fail(400, 'BAD_REQUEST', 'Bad base URL.');
      }
      if ((u.protocol !== 'https:' && !(testBase && u.protocol === 'http:')) || u.username || u.password || u.search || u.hash) throw fail(400, 'BAD_REQUEST', 'Bad base URL.');
      headers['base-url-override'] = u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''));
    }
    let contentType = '';
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      const name = String(k).replace(/^nango-proxy-/i, '');
      if (RESERVED_HEADER.test(name)) throw fail(400, 'BAD_REQUEST', 'That header can’t go through the connections proxy.');
      if (/^content-type$/i.test(name)) {
        contentType = String(v);
        continue;
      }
      if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || /[\r\n]/.test(String(v))) throw fail(400, 'BAD_REQUEST', 'Bad header.');
      headers[`nango-proxy-${name.toLowerCase()}`] = String(v);
    }
    const body = bodyBytes(opts.body === undefined ? undefined : deepFill(opts.body, values));
    if (body.payload !== undefined) headers['content-type'] = contentType || (body.json ? 'application/json' : 'application/octet-stream');

    const feature = LEDGER_FEATURES.includes(opts.feature) ? opts.feature : 'connections';
    let tag = doc.customer;
    if (!tag) {
      try {
        tag = customerTag(userId, env);
      } catch {
        tag = null;
      }
    }
    const endpoint = clip(`${platform}:${method} ${path}`, 200);

    const attempt = () =>
      withUserSlot(userId, async () => {
        await acquireRate();
        let res;
        try {
          res = await fetch(`${base}/proxy${filledPath}${qs ? `?${qs}` : ''}`, { method, headers, ...(body.payload !== undefined ? { body: body.payload } : {}), signal: AbortSignal.timeout(timeoutMs) });
        } catch {
          if (tag) await ledger({ customer_tag: tag, user_id: userId, project_id: opts.projectId ?? null, feature, endpoint, http_status: null, outcome: 'unknown', bytes: body.size });
          throw fail(504, 'UNAVAILABLE', `${NAMES[platform]} didn’t answer in time.`);
        }
        const buf = Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
        const type = res.headers.get('content-type') || '';
        let parsed;
        if (!buf.length) parsed = null;
        else if (/json/i.test(type) || /^[\s]*[{[]/.test(buf.subarray(0, 64).toString('utf8'))) {
          try {
            parsed = JSON.parse(buf.toString('utf8'));
          } catch {
            parsed = buf.toString('utf8');
          }
        } else if (/^(text\/|application\/(xml|x-www-form-urlencoded))/i.test(type)) parsed = buf.toString('utf8');
        else parsed = buf;
        const out = {};
        res.headers.forEach((v, k) => {
          if (HEADER_WHITELIST.includes(k) || k.startsWith('x-ratelimit-')) out[k] = v;
        });
        if (tag) await ledger({ customer_tag: tag, user_id: userId, project_id: opts.projectId ?? null, feature, endpoint, http_status: res.status, outcome: res.status < 400 ? 'ok' : res.status >= 500 ? 'unknown' : 'failed', bytes: body.size + buf.length });
        return { status: res.status, headers: out, body: parsed };
      });

    let r = await attempt();
    if (r.status === 429 && !oneShot) {
      const wait = parseRetryAfter(r.headers['retry-after'], now());
      if (wait <= MAX_RETRY_AFTER_S) {
        await sleep(wait * 1000);
        r = await attempt();
      }
    }
    // Nango's own refusals (the call never reached the network): in our words
    const code = r.status >= 400 ? nangoCode(r.body) : '';
    if (code && NANGO_CODES.has(code)) {
      log_('nango_proxy_refused', { platform: conn, status: r.status, code });
      if (code === 'unknown_provider_config') throw notSetUp(`Create the integration "${entry.providerConfigKey}" in Nango.`, `${NAMES[conn]} isn’t set up for connecting yet.`);
      if (code === 'plan_limit') {
        ownerAlert('plan_limit');
        throw fail(503, 'CONNECTIONS_UNAVAILABLE', 'Connected accounts aren’t available right now. Try again later.');
      }
      if (code === 'base_url_override_disabled' || code === 'base_url_override_not_allowed') throw notSetUp('Nango refused a base URL override: allow it for this integration.', 'That isn’t available right now.');
      if (code === 'unknown_connection') {
        await updateDoc(userId, (d) => {
          if (d.platforms[conn]?.connectionId !== entry.connectionId) return { write: false };
          delete d.platforms[conn];
          return { value: d };
        }).catch(() => {});
        throw fail(409, 'NOT_CONNECTED', `${NAMES[conn]} isn’t connected any more.`);
      }
      // server_error, connection_refresh_backoff, invalid_credentials: the token can't be used
      await markReconnect(userId, conn, entry.connectionId, 'refresh_failed');
      throw fail(409, 'NEEDS_RECONNECT', `Reconnect ${NAMES[conn]} in Settings → Connected accounts.`);
    }
    return r;
  }

  // ───────────── targets ─────────────

  const targetHandle = (userId, conn, realId) => `tgt_${crypto.createHmac('sha256', tagSecret || key).update(`target|${userId}|${conn}|${realId}`).digest('hex').slice(0, 32)}`;

  /** The accounts this connection can use, fresh from the network: [{ real: {...stored}, label, kind }]. */
  async function fetchTargets(userId, conn) {
    const read = (req) => request(userId, conn, { ...req, oneShot: false, timeoutMs: READ_TIMEOUT_MS });
    const ok = (r) => r && r.status >= 200 && r.status < 300 && r.body && typeof r.body === 'object';
    const unreadable = () => fail(502, 'UNAVAILABLE', `Couldn’t read your ${NAMES[conn]} accounts just now. Try again shortly.`);
    switch (conn) {
      case 'facebook': {
        const r = await read({ method: 'GET', path: `/${GRAPH_VERSION}/me/accounts`, query: { fields: 'id,name,tasks,instagram_business_account', limit: '100' } });
        if (!ok(r)) throw unreadable();
        return (Array.isArray(r.body.data) ? r.body.data : [])
          .filter((p) => str(p?.id))
          .map((p) => ({
            real: { id: str(p.id), label: clip(p.name) || 'Facebook Page', kind: 'fb_page', tasks: Array.isArray(p.tasks) ? p.tasks.map(str).slice(0, 20) : [], ...(str(p.instagram_business_account?.id) ? { igUserId: str(p.instagram_business_account.id), ...(str(p.instagram_business_account.username) ? { igLabel: `@${clip(p.instagram_business_account.username, 60)}` } : {}) } : {}) },
          }));
      }
      case 'linkedin': {
        const me = await read({ method: 'GET', path: '/v2/userinfo' });
        if (!ok(me) || !str(me.body.sub)) throw unreadable();
        const list = [{ real: { id: str(me.body.sub), label: clip(me.body.name) || 'Your LinkedIn profile', kind: 'li_person' } }];
        if (String(env.LINKEDIN_ORG_APPROVED || '') === '1') {
          const li = { 'LinkedIn-Version': '202610', 'X-Restli-Protocol-Version': '2.0.0' };
          const acls = await read({ method: 'GET', path: '/rest/organizationAcls', query: { q: 'roleAssignee', role: 'ADMINISTRATOR', state: 'APPROVED' }, headers: li }).catch(() => null);
          const orgIds = ok(acls) && Array.isArray(acls.body.elements) ? acls.body.elements.map((e) => /^urn:li:organization:(\d+)$/.exec(str(e?.organization))?.[1]).filter(Boolean).slice(0, 10) : [];
          for (const id of orgIds) {
            const org = await read({ method: 'GET', path: `/rest/organizations/${id}`, headers: li }).catch(() => null);
            list.push({ real: { id, label: clip(ok(org) ? org.body.localizedName : '') || 'LinkedIn page', kind: 'li_org' } });
          }
        }
        return list;
      }
      case 'youtube': {
        const r = await read({ method: 'GET', path: '/youtube/v3/channels', query: { part: 'snippet', mine: 'true' } });
        if (!ok(r)) throw unreadable();
        return (Array.isArray(r.body.items) ? r.body.items : []).filter((c) => str(c?.id)).map((c) => ({ real: { id: str(c.id), label: clip(c.snippet?.title) || 'YouTube channel', kind: 'yt_channel' } }));
      }
      case 'google_ads': {
        const r = await read({ method: 'GET', path: '/v26/customers:listAccessibleCustomers' });
        if (!ok(r)) throw unreadable();
        return (Array.isArray(r.body.resourceNames) ? r.body.resourceNames : [])
          .map((n) => /^customers\/(\d{10})$/.exec(str(n))?.[1])
          .filter(Boolean)
          .map((id) => ({ real: { id, label: `Google Ads ${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`, kind: 'ads_account' } }));
      }
      case 'meta_ads': {
        const r = await read({ method: 'GET', path: `/${GRAPH_VERSION}/me/adaccounts`, query: { fields: 'id,account_id,name,currency,account_status' } });
        if (!ok(r)) throw unreadable();
        return (Array.isArray(r.body.data) ? r.body.data : [])
          .map((a) => ({ id: str(a?.account_id) || str(a?.id).replace(/^act_/, ''), a }))
          .filter(({ id }) => /^\d+$/.test(id))
          .map(({ id, a }) => ({ real: { id, label: clip(a.name) || `Ad account ${id}`, kind: 'ads_account', ...(str(a.currency) ? { currency: str(a.currency).slice(0, 3) } : {}) } }));
      }
      case 'google_search_console': {
        const r = await read({ method: 'GET', path: '/v3/sites' });
        if (!ok(r)) throw unreadable();
        return (Array.isArray(r.body.siteEntry) ? r.body.siteEntry : [])
          .filter((s) => str(s?.siteUrl) && str(s.permissionLevel) !== 'siteUnverifiedUser')
          .map((s) => ({ real: { id: str(s.siteUrl).slice(0, 300), label: clip(str(s.siteUrl).replace(/^sc-domain:/, ''), 120), kind: 'gsc_site' } }));
      }
      case 'tiktok': {
        const r = await read({ method: 'GET', path: '/v2/user/info/', query: { fields: 'open_id,display_name' } });
        const u = ok(r) ? r.body.data?.user : null;
        if (!str(u?.open_id)) throw unreadable();
        return [{ real: { id: str(u.open_id), label: clip(u.display_name) || 'TikTok account', kind: 'tt_account' } }];
      }
      case 'x': {
        const r = await read({ method: 'GET', path: '/2/users/me', baseUrlOverride: 'https://api.x.com' });
        const u = ok(r) ? r.body.data : null;
        if (!str(u?.id)) throw unreadable();
        return [{ real: { id: str(u.id), label: str(u.username) ? `@${clip(u.username, 60)}` : clip(u.name) || 'X account', kind: 'x_account' } }];
      }
      default:
        return [];
    }
  }

  /** limited reason from a Facebook Page's tasks (null when it may post). */
  const pageRole = (target) => (target?.kind === 'fb_page' && Array.isArray(target.tasks) && !target.tasks.includes('CREATE_CONTENT') ? 'no_page_role' : null);

  async function targets(userId, platform) {
    requireSetUp();
    const conn = connectionPlatform(platform);
    const list = await fetchTargets(userId, conn);
    await updateDoc(userId, (d) => {
      const e = d.platforms[conn];
      if (!e?.connectionId || e.targetsAvailable === list.length) return { write: false };
      e.targetsAvailable = list.length;
      return { value: d };
    }).catch(() => {});
    return list.map((t) => ({ id: targetHandle(userId, conn, t.real.id), label: t.real.label, kind: t.real.kind }));
  }

  /** Store the chosen account (already fetched) for a connection, if it is still that connection. */
  async function storeTarget(userId, conn, connectionId, real, count) {
    return updateDoc(userId, (d) => {
      const e = d.platforms[conn];
      if (!e || e.connectionId !== connectionId) return { write: false, result: false };
      e.target = real;
      if (Number.isFinite(count)) e.targetsAvailable = count;
      const role = pageRole(real);
      if (role) e.limited = role;
      else if (e.limited === 'no_page_role') e.limited = null;
      return { value: d, result: true };
    });
  }

  async function setTarget(userId, platform, targetId) {
    requireSetUp();
    const conn = connectionPlatform(platform);
    if (!TARGET_ID.test(String(targetId ?? ''))) throw fail(400, 'BAD_REQUEST', 'Choose one of the listed accounts.');
    const { value: doc } = await readDoc(userId);
    const entry = doc.platforms?.[conn];
    if (!entry?.connectionId) throw fail(409, 'NOT_CONNECTED', `${NAMES[conn]} isn’t connected.`);
    const list = await fetchTargets(userId, conn);
    const hit = list.find((t) => targetHandle(userId, conn, t.real.id) === targetId);
    if (!hit) throw fail(404, 'NOT_FOUND', 'That account isn’t available any more. Choose again.');
    const stored = await storeTarget(userId, conn, entry.connectionId, hit.real, list.length);
    if (!stored) throw fail(409, 'NOT_CONNECTED', `${NAMES[conn]} changed meanwhile. Try again.`);
    const { value } = await readDoc(userId);
    return statusOf(value, platform);
  }

  // ───────────── check, disconnect, credentials ─────────────

  async function check(userId, platform) {
    if (PHASE2_PLATFORMS.includes(platform)) return { platform, state: 'coming_soon' };
    requireSetUp();
    const conn = connectionPlatform(platform);
    const { value: doc } = await readDoc(userId);
    const entry = doc.platforms?.[conn];
    if (forgotten(doc) || !entry?.connectionId) return statusOf(doc, platform);
    const r = await api('GET', `/connections/${encodeURIComponent(entry.connectionId)}`, { query: { provider_config_key: entry.providerConfigKey } });
    const code = nangoCode(r.body);
    let next = null; // 'gone' | 'reconnect' | 'ok'
    if (r.status === 404 || code === 'unknown_connection') next = 'gone';
    else if (r.status === 424 || code === 'invalid_credentials') next = 'reconnect';
    else if (r.status >= 200 && r.status < 300) next = Array.isArray(r.body?.errors) && r.body.errors.some((e) => e?.type === 'auth') ? 'reconnect' : 'ok';
    else throw apiFailure(r, entry.providerConfigKey);
    await updateDoc(userId, (d) => {
      const e = d.platforms[conn];
      if (!e || e.connectionId !== entry.connectionId) return { write: false };
      if (next === 'gone') delete d.platforms[conn];
      else if (next === 'reconnect') {
        if (e.state === 'needs_reconnect') return { write: false };
        e.state = 'needs_reconnect';
        e.needsReconnect = 'refresh_failed';
      } else {
        if (e.state === 'connected') return { write: false };
        e.state = 'connected';
        e.needsReconnect = null;
      }
      return { value: d };
    });
    const { value } = await readDoc(userId);
    return statusOf(value, platform);
  }

  async function deleteAtNango(connectionId, providerConfigKey, why) {
    const r = await api('DELETE', `/connections/${encodeURIComponent(connectionId)}`, { query: { provider_config_key: providerConfigKey } });
    const ok = (r.status >= 200 && r.status < 300) || r.status === 404;
    if (!ok) log_('nango_delete_failed', { why, status: r.status, code: nangoCode(r.body) });
    return ok;
  }

  async function disconnect(userId, platform) {
    requireSetUp();
    if (platform === 'instagram') throw fail(400, 'BAD_REQUEST', 'Instagram is connected through your Facebook Page. Choose another Page, or disconnect Facebook.');
    const conn = connectionPlatform(platform);
    // the entry goes first, so the deletion webhook finds nothing to match; then Nango, once
    const removed = await updateDoc(userId, (d) => {
      const e = d.platforms[conn];
      const had = !!d.pendingSince[conn];
      delete d.pendingSince[conn];
      if (!e) return had ? { value: d, result: null } : { write: false, result: null };
      delete d.platforms[conn];
      return { value: d, result: e };
    });
    if (removed?.connectionId) await deleteAtNango(removed.connectionId, removed.providerConfigKey, 'disconnect');
  }

  async function credentials(userId, platform) {
    requireSetUp();
    const { value: doc } = await readDoc(userId);
    const entry = doc.platforms?.[platform];
    if (!entry?.connectionId) throw fail(409, 'NOT_CONNECTED', `${NAMES[platform]} isn’t connected.`);
    const r = await api('GET', `/connections/${encodeURIComponent(entry.connectionId)}`, { query: { provider_config_key: entry.providerConfigKey } });
    const token = r.status === 200 ? r.body?.credentials?.access_token : null;
    if (typeof token !== 'string' || !token) {
      if (r.status === 424 || nangoCode(r.body) === 'invalid_credentials') await markReconnect(userId, platform, entry.connectionId, 'refresh_failed');
      throw fail(409, 'NEEDS_RECONNECT', `Reconnect ${NAMES[platform]} in Settings → Connected accounts.`);
    }
    return { accessToken: token };
  }

  // ───────────── account deletion ─────────────

  async function forgetUser(userId) {
    if (!storageReady) return;
    let doc = blankDoc();
    try {
      doc = (await readDoc(userId)).value;
    } catch {
      if (setUp) throw fail(503, 'UNAVAILABLE', 'Couldn’t remove your connected accounts just now, so your account wasn’t deleted. Try again shortly.');
      return;
    }
    if (key) {
      for (const [platform, e] of Object.entries(doc.platforms ?? {})) {
        if (!e?.connectionId) continue;
        // one attempt each; a failure is logged for an admin sweep, never retried here
        const ok = await deleteAtNango(e.connectionId, e.providerConfigKey, 'forget').catch(() => false);
        if (!ok) log_('nango_forget_delete_failed', { platform, customer: doc.customer ?? null });
      }
    }
    try {
      await storage.put(docKey(userId), { v: 1, forgottenAt: iso(now()), platforms: {}, pendingSince: {} });
    } catch {
      if (setUp) throw fail(503, 'UNAVAILABLE', 'Couldn’t remove your connected accounts just now, so your account wasn’t deleted. Try again shortly.');
    }
  }

  async function unforgetUser(userId) {
    if (!storageReady) return;
    await updateDoc(userId, (d) => (d.forgottenAt ? { value: blankDoc() } : { write: false })).catch(() => {});
  }

  // ───────────── the webhook ─────────────

  /** What a connection was granted, read after connect (Meta only): a limited reason or null. */
  async function grantedReason(userId, conn, target) {
    const required = REQUIRED_META[conn];
    if (!required) return null;
    const r = await request(userId, conn, { method: 'GET', path: `/${GRAPH_VERSION}/me/permissions`, oneShot: false }).catch(() => null);
    if (r && r.status >= 200 && r.status < 300 && Array.isArray(r.body?.data)) {
      const granted = new Set(r.body.data.filter((p) => p?.status === 'granted').map((p) => str(p.permission)));
      if (required.some((p) => !granted.has(p))) return 'missing_permissions';
    } else if (r && r.status >= 400 && r.status < 500) {
      const msg = JSON.stringify(r.body ?? '').toLowerCase();
      if (/not.*approved|development mode|standard access|app.*review/.test(msg)) return 'app_not_approved';
    }
    return pageRole(target);
  }

  /** After a creation or a successful reconnect: the accounts it can use (one is chosen for them) and what was granted. */
  async function afterConnect(userId, conn, connectionId) {
    let list = [];
    try {
      list = await fetchTargets(userId, conn);
    } catch (e) {
      log_('nango_targets_failed', { platform: conn, code: e?.code });
    }
    const { value: doc } = await readDoc(userId);
    const entry = doc.platforms?.[conn];
    if (!entry || entry.connectionId !== connectionId) return;
    let target = entry.target;
    // keep the earlier choice when it is still there; else one account is chosen for them
    const still = target?.id ? list.find((t) => t.real.id === target.id) : null;
    if (still) target = still.real;
    else target = list.length === 1 ? list[0].real : null;
    const reason = await grantedReason(userId, conn, target);
    await updateDoc(userId, (d) => {
      const e = d.platforms[conn];
      if (!e || e.connectionId !== connectionId) return { write: false };
      e.targetsAvailable = list.length;
      e.target = target;
      e.limited = reason;
      return { value: d };
    });
  }

  function verify(raw, header) {
    const got = String(header || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(got)) return false;
    let ok = false;
    for (const k of signingKeys) if (sameHex(crypto.createHmac('sha256', k).update(raw).digest('hex'), got)) ok = true;
    return ok;
  }

  async function userForTag(tag) {
    const rows = await db.select('billing_customers', { customer_tag: tag }, { select: 'user_id', limit: 1 });
    return rows?.[0]?.user_id ?? null;
  }

  async function seen(hash) {
    try {
      const rows = await db.select('webhook_deliveries', { body_hash: hash, received_at: ['gte', iso(now() - DEDUPE_MS)] }, { select: 'body_hash', limit: 1 });
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  async function remember(hash) {
    try {
      await db.remove('webhook_deliveries', { received_at: ['lt', iso(now() - DEDUPE_MS)] });
    } catch {
      /* pruning is best effort */
    }
    try {
      await db.upsert('webhook_deliveries', { body_hash: hash, received_at: iso(now()) }, { onConflict: 'body_hash' });
    } catch {
      log_('nango_webhook_dedupe_failed', {});
    }
  }

  /** Apply one auth event to the user's doc. → { after?: () => Promise } */
  function applyAuth(doc, ev, conn) {
    const at = iso(now());
    const entry = doc.platforms[conn];
    const errorType = ERROR_TYPE.test(str(ev.error?.type)) ? str(ev.error.type) : 'connect_failed';
    const matches = entry?.connectionId && entry.connectionId === ev.connectionId;
    switch (ev.operation) {
      case 'creation': {
        delete doc.pendingSince[conn];
        if (ev.success === false) {
          if (entry?.connectionId) entry.lastError = errorType; // keep the connection they already have
          else doc.platforms[conn] = { state: 'not_connected', lastError: errorType };
          return { changed: true };
        }
        if (matches) return { changed: false, after: 'connect' };
        const old = entry?.connectionId ? { connectionId: entry.connectionId, providerConfigKey: entry.providerConfigKey } : null;
        doc.platforms[conn] = { connectionId: ev.connectionId, providerConfigKey: ev.providerConfigKey, state: 'connected', connectedAt: at, target: null, needsReconnect: null, limited: null, lastError: null };
        return { changed: true, after: 'connect', old };
      }
      case 'override': {
        if (!matches) return { stale: true };
        delete doc.pendingSince[conn];
        if (ev.success === false) {
          entry.state = 'needs_reconnect';
          entry.lastError = errorType;
          return { changed: true };
        }
        entry.state = 'connected';
        entry.needsReconnect = null;
        entry.lastError = null;
        entry.connectedAt = at; // a fresh sign-in: the Facebook 60-day clock starts again
        return { changed: true, after: 'connect' };
      }
      case 'refresh': {
        if (!matches) return { stale: true };
        if (ev.success === false) {
          entry.state = 'needs_reconnect';
          entry.needsReconnect = 'refresh_failed';
        } else {
          entry.state = 'connected';
          entry.needsReconnect = null;
        }
        return { changed: true };
      }
      case 'deletion': {
        if (!matches) return { stale: true };
        delete doc.platforms[conn];
        return { changed: true };
      }
      default:
        return { changed: false };
    }
  }

  /**
   * POST /api/webhooks/nango: raw (Buffer, the exact bytes) and the request headers. → { status, body, after }
   * where `after` (a Promise or null) is the work that runs once the reply has gone (reading the accounts).
   */
  async function webhook(raw, headers = {}) {
    const okReply = { status: 200, body: { ok: true }, after: null };
    if (!signingKeys.length || !key) return { status: 503, body: { error: 'Not set up.', code: 'NOT_SET_UP' }, after: null };
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
    if (!verify(bytes, headers['x-nango-hmac-sha256'])) return { status: 401, body: { error: 'Not allowed.', code: 'AUTH_REQUIRED' }, after: null };
    let ev;
    try {
      ev = JSON.parse(bytes.toString('utf8'));
    } catch {
      return { status: 400, body: { error: 'Bad request.', code: 'BAD_REQUEST' }, after: null };
    }
    if (!isObj(ev) || ev.type !== 'auth') return okReply; // Nango adds new types without notice
    if (!['creation', 'override', 'refresh', 'deletion'].includes(ev.operation) || typeof ev.connectionId !== 'string' || !ev.connectionId) return okReply;
    if (!setUp) return { status: 503, body: { error: 'Not set up.', code: 'NOT_SET_UP' }, after: null };

    const hash = sha256(bytes);
    if (await seen(hash)) return okReply;

    const tags = isObj(ev.tags) ? Object.fromEntries(Object.entries(ev.tags).map(([k, v]) => [String(k).toLowerCase(), v])) : {};
    const tag = str(tags.end_user_id);
    if (!/^cust_[0-9a-f]{24}$/.test(tag)) {
      log_('nango_webhook_unknown_customer', { operation: ev.operation });
      return okReply;
    }
    let userId;
    try {
      userId = await userForTag(tag);
    } catch {
      return { status: 500, body: { error: 'Try again.', code: 'UNAVAILABLE' }, after: null };
    }
    if (!userId) {
      log_('nango_webhook_unknown_customer', { customer: tag, operation: ev.operation });
      return okReply;
    }
    const conn = platformOf.get(str(ev.providerConfigKey));
    if (!conn) {
      log_('nango_webhook_unknown_integration', { customer: tag, operation: ev.operation });
      return okReply;
    }

    let outcome;
    try {
      outcome = await updateDoc(userId, (d) => {
        if (forgotten(d)) return { write: false, result: { forgotten: true } };
        const r = applyAuth(d, ev, conn);
        if (!d.customer) d.customer = tag;
        return r.changed ? { value: d, result: r } : { write: false, result: r };
      });
    } catch {
      log_('nango_webhook_store_failed', { customer: tag, operation: ev.operation });
      return { status: 500, body: { error: 'Try again.', code: 'UNAVAILABLE' }, after: null };
    }
    await remember(hash);

    if (outcome?.stale) {
      log_('stale_connection_event', { customer: tag, platform: conn, operation: ev.operation });
      return okReply;
    }
    if (outcome?.forgotten) {
      // the account is being deleted: a connection made meanwhile goes too (one attempt)
      const after = ev.operation === 'creation' && ev.success !== false ? deleteAtNango(ev.connectionId, ev.providerConfigKey, 'forgotten').then(() => {}) : null;
      return { ...okReply, after };
    }
    log_('nango_webhook_applied', { customer: tag, platform: conn, operation: ev.operation, success: ev.success !== false });
    const jobs = [];
    if (outcome?.old) jobs.push(() => deleteAtNango(outcome.old.connectionId, outcome.old.providerConfigKey, 'replaced'));
    if (outcome?.after === 'connect') jobs.push(() => afterConnect(userId, conn, ev.connectionId));
    const after = jobs.length
      ? (async () => {
          for (const job of jobs) {
            try {
              await job();
            } catch (e) {
              log_('nango_after_connect_failed', { platform: conn, code: e?.code });
            }
          }
        })()
      : null;
    return { ...okReply, after };
  }

  // ───────────── monthly cost estimates (estimated: true; they never count toward a cap) ─────────────

  /**
   * Once per month (on start and daily): for last month, one `nango_connection` row per customer (connected
   * platforms, prorated by days) and one `nango_proxy_gb` row (proxied bytes at $0.50/GB). Claimed with
   * ifVersion so two servers don't both write it.
   */
  async function meterIfDue() {
    if (!setUp) return { skipped: true };
    const t = new Date(now());
    const start = Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1);
    const end = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1);
    const month = iso(start).slice(0, 7);
    const claimKey = `nango:metered:${month}`;
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
        log_('nango_meter_failed', { month });
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
        for (const e of Object.values(doc.platforms ?? {})) {
          if (!e?.connectionId) continue;
          const from = Math.max(start, Date.parse(e.connectedAt) || start);
          if (from >= end) continue;
          micro += Math.round((CONNECTION_MONTH_MICRO * (end - from)) / 86_400_000 / days);
        }
        if (micro > 0) {
          await ledger({ customer_tag: c.customer_tag, user_id: c.user_id, feature: 'connections', endpoint: `nango_connection ${month}`, cost_micro: micro, estimated: true, outcome: 'ok' });
          rows += 1;
        }
        let bytes = 0;
        try {
          const used = await db.select('usage_ledger', { customer_tag: c.customer_tag, vendor: 'nango', created_at: ['gte', iso(start)] }, { select: 'bytes,created_at', limit: 10_000 });
          for (const u of used) if (Date.parse(u.created_at) < end) bytes += Number(u.bytes) || 0;
        } catch {
          bytes = 0;
        }
        const gbMicro = Math.round((bytes / 1e9) * PROXY_GB_MICRO);
        if (gbMicro > 0) {
          await ledger({ customer_tag: c.customer_tag, user_id: c.user_id, feature: 'connections', endpoint: `nango_proxy_gb ${month}`, cost_micro: gbMicro, estimated: true, outcome: 'ok', bytes });
          rows += 1;
        }
      }
      if (customers.length < 1000) break;
    }
    log_('nango_metered', { month, rows });
    return { rows };
  }

  const impl = {
    enabled: true,
    setUp,
    hint,
    status,
    connectLink,
    reconnectLink,
    check,
    disconnect,
    targets,
    setTarget,
    request,
    credentials,
    forgetUser,
    unforgetUser,
    webhook,
    meterIfDue,
  };
  const regKey = storage ?? env;
  if (regKey && typeof regKey === 'object') registry.set(regKey, impl);
  return impl;
}
