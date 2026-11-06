// Nango, kept for FUTURE non-social integrations (booking tools, CRMs, …): a customer connects their own account at
// a service the owner has set up in Nango, and the app may later read or write there on their behalf. Social
// networks, posting, social analytics and ad accounts are NOT here: social goes through Upload-Post
// (server/connections/uploadpost.mjs), ads through Zernio (server/connections/zernio.mjs). Search Console runs on
// treg's team connection.
//
// Off unless NANGO_SECRET_KEY is set. With it set, nothing is offered until the owner lists integrations in
// NANGO_INTEGRATIONS (JSON), e.g. {"calendly": {"id": "ylb-calendly", "label": "Calendly", "category": "booking"}}.
// A key or an integration id that names a social network, an ad platform or Search Console is refused.
//
//   const nango = createNango({ env, fetch, now, storage, db, log });
//   nango.list(userId) → [{ key, label, category, state, connectedAt?, lastError? }]
//   nango.connectLink(userId, key) → { connectLink, expiresAt }
//   nango.disconnect(userId, key)
//   nango.request(userId, key, { method, path, query, body, oneShot, timeoutMs }) → { status, headers, body }
//   nango.webhook(rawBody, headers) → { status, body }        POST /api/webhooks/nango
//   nango.forgetUser(userId) / unforgetUser(userId)
//
// Rules: the API key goes only to Nango, in Authorization; it, connect links and tokens are never logged, stored or
// returned to a route. Tags sent to Nango are the opaque customer tag only. A write is one attempt (never
// `Retries` / `Retry-On`). Webhooks are HMAC-checked on the exact bytes (X-Nango-Hmac-Sha256) and apply only to
// the connection they name.

import crypto from 'node:crypto';
import { PLATFORMS } from './integrations/contracts.mjs';
import { ensureCustomer, fail, IntegrationError, notSetUp, safeLog, sha256 } from './integrations/common.mjs';

export const NANGO_BASE_URL = 'https://api.nango.dev';
const PENDING_MS = 30 * 60_000;
const API_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 120_000;
const DEDUPE_MS = 10 * 60_000;
const FORGOTTEN_FOR_MS = 24 * 3_600_000;
const KEY = /^[a-z][a-z0-9_]{1,30}$/;
const INTEGRATION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const CATEGORIES = new Set(['booking', 'crm', 'calendar', 'payments', 'other']);
/** Never on Nango: these go through Upload-Post (social), Zernio (ads) or treg (Search Console). */
const NOT_ON_NANGO = /(facebook|instagram|linkedin|tiktok|twitter|youtube|pinterest|threads|reddit|bluesky|snapchat|meta|google[-_]?ads|[-_]ads$|^ads[-_]|search[-_]?console|gsc|webmaster)/i;
const RESERVED_HEADER = /^(authorization|retries|retry-on|connection-id|provider-config-key|base-url-override|host|cookie|content-length)$/i;

const iso = (ms) => new Date(ms).toISOString();
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n = 60) => {
  const t = (typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const docKey = (userId) => `nango:user:${sha256(String(userId))}`;
const blankDoc = () => ({ v: 2, connections: {}, pending: {} });

/**
 * NANGO_INTEGRATIONS → { key: { id, label, category } }. Accepts {"key": "integration-id"} or
 * {"key": {"id", "label", "category"}}. Social, ad and Search Console names are dropped (and logged by name).
 */
export function integrationsFrom(env = {}, log = console) {
  const raw = String(env.NANGO_INTEGRATIONS || '').trim();
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeLog('nango_integrations_unreadable', {}, log);
    return {};
  }
  if (!isObj(parsed)) return {};
  const out = {};
  for (const [key, v] of Object.entries(parsed)) {
    const id = typeof v === 'string' ? v : isObj(v) && typeof v.id === 'string' ? v.id : '';
    if (!KEY.test(key) || !INTEGRATION_ID.test(id)) continue;
    if (PLATFORMS.includes(key) || NOT_ON_NANGO.test(key) || NOT_ON_NANGO.test(id)) {
      safeLog('nango_integration_refused', { key, why: 'social, ads and Search Console go through Upload-Post, Zernio and treg' }, log);
      continue;
    }
    const label = clip(isObj(v) && typeof v.label === 'string' ? v.label : key.replace(/_/g, ' '), 40);
    const category = isObj(v) && CATEGORIES.has(v.category) ? v.category : 'other';
    out[key] = { id, label, category };
  }
  return out;
}

function sameHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * env: NANGO_SECRET_KEY, NANGO_WEBHOOK_SIGNING_KEY (+ _PREVIOUS), NANGO_BASE_URL (tests), NANGO_INTEGRATIONS,
 * CUSTOMER_TAG_SECRET. storage: appState (encrypted docs, ifVersion). db: server/integrations/db.mjs.
 */
export function createNango({ env = process.env, fetch = globalThis.fetch, now = () => Date.now(), storage = null, db = null, log = console } = {}) {
  const key = String(env.NANGO_SECRET_KEY || '').trim();
  const signingKeys = [env.NANGO_WEBHOOK_SIGNING_KEY, env.NANGO_WEBHOOK_SIGNING_KEY_PREVIOUS].map((k) => String(k || '').trim()).filter(Boolean);
  const base = String(env.NANGO_BASE_URL || NANGO_BASE_URL).replace(/\/+$/, '');
  const testBase = base !== NANGO_BASE_URL;
  const integrations = integrationsFrom(env, log);
  const keyOfId = new Map(Object.entries(integrations).map(([k, v]) => [v.id, k]));
  const storageReady = storage?.enabled === true;
  const dbReady = db?.enabled === true;
  const tagSecret = String(env.CUSTOMER_TAG_SECRET || '');
  const log_ = (event, fields) => safeLog(event, fields, log);

  const missing = [...(key ? [] : ['NANGO_SECRET_KEY']), ...(signingKeys.length ? [] : ['NANGO_WEBHOOK_SIGNING_KEY']), ...(tagSecret.length >= 16 ? [] : ['CUSTOMER_TAG_SECRET'])];
  const setUp = missing.length === 0 && storageReady && dbReady;
  const hint = missing.length
    ? `Other integrations (Nango) need these Replit Secrets: ${missing.join(', ')}.`
    : !storageReady || !dbReady
      ? 'Other integrations (Nango) need Supabase server storage (SUPABASE_URL, SUPABASE_SECRET_KEY and the migrations).'
      : Object.keys(integrations).length
        ? ''
        : 'Nango is on, but no integration is listed: add NANGO_INTEGRATIONS when a booking tool or CRM is set up in Nango.';

  function requireSetUp() {
    if (!setUp) throw notSetUp(hint, 'This integration isn’t available yet.');
  }
  function integration(k) {
    const i = integrations[k];
    if (!i) throw fail(404, 'NOT_FOUND', 'Unknown integration.');
    return i;
  }

  // ───────────── stored doc ─────────────

  async function readDoc(userId) {
    if (!storageReady) throw notSetUp(hint, 'This integration isn’t available yet.');
    let got;
    try {
      got = await storage.get(docKey(userId));
    } catch {
      throw fail(503, 'UNAVAILABLE', 'Couldn’t read your integrations just now. Try again shortly.');
    }
    const value = isObj(got?.value) && got.value.v === 2 ? got.value : blankDoc();
    if (!isObj(value.connections)) value.connections = {};
    if (!isObj(value.pending)) value.pending = {};
    return { value, version: got?.updatedAt ?? null };
  }

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
        throw fail(503, 'UNAVAILABLE', 'Couldn’t save your integrations just now. Try again shortly.');
      }
    }
    throw fail(409, 'UNAVAILABLE', 'Your integrations changed in another request. Try again.');
  }

  const forgotten = (doc) => {
    const at = Date.parse(doc?.forgottenAt);
    return Number.isFinite(at) && now() - at < FORGOTTEN_FOR_MS;
  };

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

  const nangoCode = (body) => (typeof body?.error?.code === 'string' ? body.error.code.slice(0, 60) : '');

  // ───────────── the routes' methods ─────────────

  function stateOf(doc, k) {
    const c = doc.connections?.[k];
    if (c?.connectionId) return { state: c.state === 'needs_reconnect' ? 'needs_reconnect' : 'connected', ...(c.connectedAt ? { connectedAt: c.connectedAt } : {}) };
    const pending = Date.parse(doc.pending?.[k]);
    if (Number.isFinite(pending) && now() - pending < PENDING_MS) return { state: 'pending' };
    return { state: 'not_connected', ...(c?.lastError ? { lastError: c.lastError } : {}) };
  }

  async function list(userId) {
    const all = Object.entries(integrations).map(([k, i]) => ({ key: k, label: i.label, category: i.category }));
    if (!all.length || !storageReady) return all.map((i) => ({ ...i, state: 'not_connected' }));
    const { value } = await readDoc(userId);
    if (forgotten(value)) return all.map((i) => ({ ...i, state: 'not_connected' }));
    return all.map((i) => ({ ...i, ...stateOf(value, i.key) }));
  }

  async function connectLink(userId, k) {
    requireSetUp();
    const i = integration(k);
    const { value: doc } = await readDoc(userId);
    if (forgotten(doc)) throw fail(409, 'FORBIDDEN', 'This account is being deleted.');
    const tag = await ensureCustomer(db, userId, env).catch((e) => {
      if (e instanceof IntegrationError) throw e;
      throw fail(503, 'UNAVAILABLE', 'Couldn’t start connecting just now. Try again shortly.');
    });
    const r = await api('POST', '/connect/sessions', { body: { tags: { end_user_id: tag, organization_id: tag }, allowed_integrations: [i.id] } });
    if (r.status < 200 || r.status >= 300) {
      log_('nango_connect_session_failed', { key: k, status: r.status, code: nangoCode(r.body) });
      if (r.status === 401 || r.status === 403) throw notSetUp('Nango refused the API key: check NANGO_SECRET_KEY.', 'This integration isn’t available right now.');
      if (r.status === 404 || nangoCode(r.body) === 'unknown_provider_config') throw notSetUp(`Create the integration "${i.id}" in Nango.`, 'This integration isn’t set up yet.');
      throw fail(502, 'UNAVAILABLE', 'Couldn’t reach the sign-in service. Try again shortly.');
    }
    const link = r.body?.data?.connect_link;
    let u = null;
    try {
      u = new URL(String(link));
    } catch {
      u = null;
    }
    if (!u || (u.protocol !== 'https:' && !(testBase && u.protocol === 'http:'))) throw fail(502, 'UNAVAILABLE', 'Couldn’t start connecting just now. Try again shortly.');
    await updateDoc(userId, (d) => {
      d.customer = tag;
      d.pending[k] = iso(now());
      return { value: d };
    });
    const expiresAt = r.body?.data?.expires_at;
    return { connectLink: String(link), expiresAt: typeof expiresAt === 'string' && Number.isFinite(Date.parse(expiresAt)) ? expiresAt : iso(now() + PENDING_MS) };
  }

  async function deleteAtNango(connectionId, providerConfigKey) {
    const r = await api('DELETE', `/connections/${encodeURIComponent(connectionId)}`, { query: { provider_config_key: providerConfigKey } });
    return (r.status >= 200 && r.status < 300) || r.status === 404;
  }

  async function disconnect(userId, k) {
    requireSetUp();
    integration(k);
    const removed = await updateDoc(userId, (d) => {
      const c = d.connections[k];
      delete d.pending[k];
      if (!c) return { value: d, result: null };
      delete d.connections[k];
      return { value: d, result: c };
    });
    if (removed?.connectionId && !(await deleteAtNango(removed.connectionId, removed.providerConfigKey))) log_('nango_delete_failed', { key: k });
  }

  /** A call to the customer's account at the service, through Nango's proxy. One attempt unless oneShot: false (reads). */
  async function request(userId, k, opts = {}) {
    requireSetUp();
    integration(k);
    const method = String(opts.method || 'GET').toUpperCase();
    const path = String(opts.path || '');
    if (!/^\/[^\s?#]*$/.test(path) || path.includes('..') || path.includes('//')) throw fail(400, 'BAD_REQUEST', 'Bad request path.');
    const { value: doc } = await readDoc(userId);
    const c = doc.connections?.[k];
    if (forgotten(doc) || !c?.connectionId) throw fail(409, 'NOT_CONNECTED', 'This integration isn’t connected.');
    if (c.state === 'needs_reconnect') throw fail(409, 'NEEDS_RECONNECT', 'Reconnect this integration first.');
    const headers = { authorization: `Bearer ${key}`, 'connection-id': c.connectionId, 'provider-config-key': c.providerConfigKey };
    for (const [h, v] of Object.entries(opts.headers ?? {})) {
      if (RESERVED_HEADER.test(h) || !/^[A-Za-z0-9-]{1,64}$/.test(h) || /[\r\n]/.test(String(v))) throw fail(400, 'BAD_REQUEST', 'Bad header.');
      headers[`nango-proxy-${h.toLowerCase()}`] = String(v);
    }
    const q = new URLSearchParams();
    for (const [qk, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) q.append(qk, String(v));
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers['content-type'] = 'application/json';
    const timeoutMs = method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
    let res;
    try {
      res = await fetch(`${base}/proxy${path}${q.toString() ? `?${q}` : ''}`, { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw fail(504, 'UNAVAILABLE', 'The service didn’t answer in time.');
    }
    let parsed = null;
    try {
      const text = await res.text();
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, headers: {}, body: parsed };
  }

  // ───────────── the webhook ─────────────

  function verify(raw, header) {
    const got = String(header || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(got)) return false;
    return signingKeys.some((k) => sameHex(crypto.createHmac('sha256', k).update(raw).digest('hex'), got));
  }

  /** POST /api/webhooks/nango: the exact bytes and the headers → { status, body }. */
  async function webhook(raw, headers = {}) {
    const ok = { status: 200, body: { ok: true } };
    if (!signingKeys.length || !key) return { status: 503, body: { error: 'Not set up.', code: 'NOT_SET_UP' } };
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
    if (!verify(bytes, headers['x-nango-hmac-sha256'])) return { status: 401, body: { error: 'Not allowed.', code: 'AUTH_REQUIRED' } };
    let ev;
    try {
      ev = JSON.parse(bytes.toString('utf8'));
    } catch {
      return { status: 400, body: { error: 'Bad request.', code: 'BAD_REQUEST' } };
    }
    if (!isObj(ev) || ev.type !== 'auth' || typeof ev.connectionId !== 'string' || !ev.connectionId) return ok;
    if (!['creation', 'override', 'refresh', 'deletion'].includes(ev.operation)) return ok;
    if (!setUp) return { status: 503, body: { error: 'Not set up.', code: 'NOT_SET_UP' } };
    const k = keyOfId.get(String(ev.providerConfigKey ?? ''));
    if (!k) return ok; // not one of ours (or a social provider someone added in Nango: never used)
    const tags = isObj(ev.tags) ? Object.fromEntries(Object.entries(ev.tags).map(([t, v]) => [String(t).toLowerCase(), v])) : {};
    const tag = String(tags.end_user_id ?? '');
    if (!/^cust_[0-9a-f]{24}$/.test(tag)) return ok;
    const hash = `nango:${sha256(bytes)}`;
    let userId;
    try {
      const seen = await db.select('webhook_deliveries', { body_hash: hash, received_at: ['gte', iso(now() - DEDUPE_MS)] }, { select: 'body_hash', limit: 1 });
      if (seen.length) return ok;
      userId = (await db.select('billing_customers', { customer_tag: tag }, { select: 'user_id', limit: 1 }))[0]?.user_id;
    } catch {
      return { status: 500, body: { error: 'Try again.', code: 'UNAVAILABLE' } };
    }
    if (!userId) return ok;
    try {
      await updateDoc(userId, (d) => {
        if (forgotten(d)) return { write: false };
        const c = d.connections[k];
        const same = c?.connectionId === ev.connectionId;
        if (ev.operation === 'creation') {
          delete d.pending[k];
          if (ev.success === false) d.connections[k] = { ...(c ?? {}), lastError: 'connect_failed' };
          else d.connections[k] = { connectionId: ev.connectionId, providerConfigKey: ev.providerConfigKey, state: 'connected', connectedAt: iso(now()) };
        } else if (!same) return { write: false };
        else if (ev.operation === 'deletion') delete d.connections[k];
        else c.state = ev.success === false ? 'needs_reconnect' : 'connected';
        return { value: d };
      });
      await db.upsert('webhook_deliveries', { body_hash: hash, received_at: iso(now()) }, { onConflict: 'body_hash' }).catch(() => {});
    } catch {
      return { status: 500, body: { error: 'Try again.', code: 'UNAVAILABLE' } };
    }
    log_('nango_webhook_applied', { key: k, operation: ev.operation });
    return ok;
  }

  // ───────────── account deletion ─────────────

  async function forgetUser(userId) {
    if (!storageReady || !key) return;
    const { value: doc } = await readDoc(userId);
    for (const [k, c] of Object.entries(doc.connections ?? {})) {
      if (c?.connectionId && !(await deleteAtNango(c.connectionId, c.providerConfigKey))) log_('nango_forget_delete_failed', { key: k });
    }
    await storage.put(docKey(userId), { ...blankDoc(), forgottenAt: iso(now()) });
  }

  async function unforgetUser(userId) {
    if (!storageReady || !key) return;
    await updateDoc(userId, (d) => (d.forgottenAt ? { value: blankDoc() } : { write: false })).catch(() => {});
  }

  return { enabled: key !== '', setUp, hint, integrations, list, connectLink, disconnect, request, webhook, forgetUser, unforgetUser };
}

/** Nango while NANGO_SECRET_KEY is unset: off, no integrations, nothing stored. */
export const nullNango = Object.freeze({
  enabled: false,
  setUp: false,
  hint: '',
  integrations: {},
  async list() {
    return [];
  },
  async connectLink() {
    throw fail(503, 'NOT_SET_UP', 'This integration isn’t available yet.');
  },
  async disconnect() {},
  async request() {
    throw fail(503, 'NOT_SET_UP', 'This integration isn’t available yet.');
  },
  async webhook() {
    return { status: 503, body: { error: 'Not set up.', code: 'NOT_SET_UP' } };
  },
  async forgetUser() {},
  async unforgetUser() {},
});
