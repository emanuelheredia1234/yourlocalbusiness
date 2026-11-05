// Omnisend: each signed-in customer connects their own Omnisend brand (OAuth), and the app creates email
// campaign drafts there from their email sequence. It never sends: they review and send in Omnisend.
//
// Routes, under /api/integrations/omnisend/: GET status, POST connect, GET callback (where Omnisend sends the
// browser back), DELETE connection, POST campaign-drafts. Every route but the callback needs the app's own
// page (sameOrigin) and the customer's sign-in (a bearer token, never a cookie).
//
// Storage (appState: encrypted, server-only), per customer:
//   omnisend:user:<sha256(user id)>     their connection (the tokens), or a marker: disconnected, needs a
//                                       reconnect, or forgotten (the account was deleted)
//   omnisend:oauth:pending:<tag>        the connections they started and haven't finished: at most
//                                       MAX_PENDING_PER_USER, each valid STATE_TTL_MS, used once
// A state is <32 random bytes>.<tag>, so a callback reads its owner's small document and nobody else's, and
// one account starting connections can only ever push out its own.
//
// The callback is tied to the browser that started the connection: /connect sets a __Host- cookie with a
// random value and keeps its hash with the state, and the callback needs that cookie. So a sign-in link made by
// one account, approved by someone else in Omnisend, never attaches their Omnisend brand to that account.
//
// The cookie and the state each carry a MAC (a key derived from OMNISEND_CLIENT_SECRET, which every copy of the
// server has), so a callback with a made-up cookie or state is turned away before any storage read: only the
// values /connect handed out, to a signed-in customer and within its rate limit, can cost one.

import crypto from 'node:crypto';

export const OMNISEND_PUBLIC_BASE_URL = 'https://yourlocalbusiness.replit.app';
export const OMNISEND_REDIRECT_URI = `${OMNISEND_PUBLIC_BASE_URL}/api/integrations/omnisend/callback`;
export const OMNISEND_SCOPES = ['campaigns.write', 'email-templates.write'];
/**
 * Scopes asked for on every new connect and reconnect, but never required: only the Email Analytics tab checks
 * them ("Reconnect Omnisend to see email stats"); drafts keep working without them, so an existing connection
 * missing one is NOT sent to reconnect (reconnectReason looks at OMNISEND_SCOPES only). The scope Omnisend wants
 * for POST /api/analytics/reports isn't confirmed yet (UNVERIFIED): add it here once it is.
 */
export const OMNISEND_OPTIONAL_SCOPES = [];
/** Email analytics: at most one live reports call per Omnisend brand per hour, and at most this many a day (Omnisend allows 55). */
export const REPORTS_PER_DAY = 40;
export const REPORTS_EVERY_MS = 60 * 60 * 1000;
const CAMPAIGN_NAMES_TTL_MS = 24 * 60 * 60 * 1000;
/** The cookie that ties a callback to the browser that started the connection (HTTPS only: Secure, host-only). */
export const BINDING_COOKIE = '__Host-ylb_omnisend';
/** The most a draft request may send: a little over the largest draft the field limits below allow. */
export const DRAFT_BODY_LIMIT = 128 * 1024;

const OAUTH_AUTHORIZE_URL = 'https://app.omnisend.com/oauth2/authorize';
const OAUTH_TOKEN_URL = 'https://app.omnisend.com/oauth2/token';
const API_BASE_URL = 'https://api.omnisend.com/api';
const API_VERSION = '2026-03-15';
const API_PREFIX = '/api/integrations/omnisend';
const STATE_TTL_MS = 10 * 60 * 1000;
/** Connections one customer can have started at once (the newest are kept). */
const MAX_PENDING_PER_USER = 3;
/** A deleted account's Omnisend documents refuse new tokens this long: the longest a sign-in token can last. */
const FORGOTTEN_FOR_MS = 7 * 24 * 60 * 60 * 1000;
/** Draft fields: Omnisend's own limits for the name, subject and preheader; the app's for the rest. */
const LIMITS = { name: 250, subject: 250, preheader: 250, body: 24_000, ctaLabel: 100, ctaUrl: 2048 };
/** A state: 32 random bytes, its owner's pending-document tag, and the server's MAC of both (all base64url). */
const STATE_RE = /^([A-Za-z0-9_-]{43}\.([A-Za-z0-9_-]{22}))\.([A-Za-z0-9_-]{22})$/;
/** The binding cookie's value: 32 random bytes, then the server's MAC of them (base64url). */
const NONCE_RE = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/;
/** fetch failures that mean the request never reached Omnisend (no address, refused, no TLS): nothing was done there. */
const NOT_SENT = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|CERT_|ERR_TLS_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;

class OmnisendError extends Error {
  constructor(status, code, message, headers = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.publicMessage = message;
    this.headers = headers;
  }
}

/** How one call to Omnisend's API failed: 'not_sent', 'unknown' (it may have been done) or what Omnisend answered. */
class CallFailure extends Error {
  constructor(kind, status = 0) {
    super(`Omnisend call failed: ${kind}`);
    this.kind = kind;
    this.status = status;
  }
}

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const userDocumentKey = (userId) => `omnisend:user:${sha256(userId)}`;
/** The tag of a customer's pending document: derived from their id, and the second half of each of their states. */
const pendingTag = (userId) => crypto.createHash('sha256').update(`omnisend-pending:${userId}`).digest('base64url').slice(0, 22);
const pendingKey = (tag) => `omnisend:oauth:pending:${tag}`;
const iso = (ms) => new Date(ms).toISOString();
/** Characters as Omnisend counts them (code points, so an emoji is one). */
const chars = (text) => [...text];

/** The document says its account was deleted recently: nothing may be connected to it. */
function forgotten(doc, at) {
  const when = Date.parse(doc?.forgottenAt);
  return Number.isFinite(when) && at - when < FORGOTTEN_FOR_MS;
}

function failStorage(error) {
  if (error?.code === 'NO_TABLE') {
    return new OmnisendError(503, 'STORAGE_NOT_READY', 'Secure integration storage is not set up yet. Run the app_state Supabase migration before connecting Omnisend.');
  }
  return new OmnisendError(503, 'STORAGE_UNAVAILABLE', 'Secure integration storage is unavailable. Try again shortly.');
}

const bindingCookie = (value, maxAgeSeconds) => `${BINDING_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;

/** Signs and checks the values this server hands out (the cookie, the state); with no client secret, nothing checks. */
function createSigner(clientSecret) {
  const key = clientSecret ? crypto.createHmac('sha256', clientSecret).update('ylb-omnisend-callback-mac-v1').digest() : null;
  const mac = (label, text) => crypto.createHmac('sha256', key).update(`${label}\n${text}`).digest('base64url').slice(0, 22);
  return {
    sign: (label, text) => `${text}.${mac(label, text)}`,
    /** text's MAC is the given one (compared in constant time). */
    verify: (label, text, given) => !!key && crypto.timingSafeEqual(Buffer.from(mac(label, text)), Buffer.from(given)),
  };
}

/** The binding value this browser sent, if this server made it; '' otherwise (nothing is read for it). */
function bindingFrom(req, signer) {
  for (const part of String(req.headers?.cookie || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === BINDING_COOKIE) {
      const value = part.slice(at + 1).trim();
      const match = NONCE_RE.exec(value);
      return match && signer.verify('binding', match[1], match[2]) ? value : '';
    }
  }
  return '';
}

/** The cookie's value hashes to what was kept with the state (compared in constant time). */
function matchesBinding(storedHex, nonce) {
  if (!nonce || typeof storedHex !== 'string' || !/^[a-f0-9]{64}$/.test(storedHex)) return false;
  return crypto.timingSafeEqual(Buffer.from(storedHex, 'hex'), crypto.createHash('sha256').update(nonce).digest());
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

// Omnisend needs [[unsubscribe_link]] in every template; the app's preview shows the same line under each email.
const FOOTER = '<p style="margin:24px 0 0;border-top:1px solid #e6ebe8;padding-top:12px;font-size:12px;line-height:1.5;color:#6b7280">You’re receiving this because you signed up. <a href="[[unsubscribe_link]]" style="color:#6b7280">Unsubscribe</a> anytime.</p>';

/** The email as the app's preview shows it: its paragraphs, its button, and the footer (no heading: the subject is the subject). */
function campaignHtml({ subject, body, ctaLabel, ctaUrl }) {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((part) => `<p style="margin:0 0 14px">${escapeHtml(part).replaceAll('\n', '<br>')}</p>`)
    .join('\n');
  const button = ctaUrl && ctaLabel
    ? `<p style="margin:20px 0 0"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:10px 20px;background:#176b52;color:#fff;font-weight:bold;text-decoration:none;border-radius:8px">${escapeHtml(ctaLabel)}</a></p>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:24px;font-family:Arial,sans-serif;font-size:14px;line-height:1.65;color:#1d2420"><main style="max-width:600px;margin:0 auto">${paragraphs}${button}${FOOTER}</main></body></html>`;
}

/**
 * auth: server/auth.mjs. storage: appState (get, put with ifVersion). send, readJson(req, limit), rateLimited(key, factor)
 * and corsHeaders: the server's own (ai-server.mjs). sameOrigin(req): the app's own page. clientKey(req): who an
 * unauthenticated caller is, for the callback's limit (the address the platform's proxies saw).
 */
export function createOmnisendRoutes({
  auth,
  storage,
  send,
  readJson,
  sameOrigin = () => true,
  rateLimited = () => false,
  clientKey = (req) => req.socket?.remoteAddress || 'unknown',
  corsHeaders = () => ({}),
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  optionalScopes = OMNISEND_OPTIONAL_SCOPES,
} = {}) {
  const askedScopes = [...OMNISEND_SCOPES, ...optionalScopes.filter((scope) => !OMNISEND_SCOPES.includes(scope))];
  const clientId = String(env.OMNISEND_CLIENT_ID || '').trim();
  const clientSecret = String(env.OMNISEND_CLIENT_SECRET || '').trim();
  const credentialsConfigured = !!(clientId && clientSecret);
  const missingCredentials = [
    ...(!clientId ? ['OMNISEND_CLIENT_ID'] : []),
    ...(!clientSecret ? ['OMNISEND_CLIENT_SECRET'] : []),
  ];
  const storageReady = storage?.enabled === true;
  const signer = createSigner(clientSecret);
  const reply = (req, res, status, body, headers = {}) => send(res, status, body, { ...corsHeaders(req), ...headers });

  /**
   * A document and its version. One this server can't decrypt any more (the encryption secret changed) is
   * { unreadable: true } with its version, so it can be replaced; its contents are lost either way.
   */
  async function readDocument(key) {
    if (!storageReady) throw new OmnisendError(503, 'STORAGE_NOT_READY', 'Secure integration storage needs Supabase server storage.');
    let result;
    try {
      result = await storage.get(key);
    } catch (error) {
      throw failStorage(error);
    }
    if (result?.unreadable) return { value: {}, version: result.updatedAt ?? null, unreadable: true };
    return { value: isRecord(result?.value) ? result.value : {}, version: result?.updatedAt ?? null, unreadable: false };
  }

  /** Change a document only if nobody else changed it meanwhile (read again and retry if they did). */
  async function updateDocument(key, change) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await readDocument(key);
      const result = change(current.value, current);
      if (result?.write === false) return result.result;
      try {
        await storage.put(key, result.value, { ifVersion: current.version });
        return result.result;
      } catch (error) {
        if (error?.code === 'CONFLICT') continue;
        throw failStorage(error);
      }
    }
    throw new OmnisendError(409, 'STORAGE_CONFLICT', 'The connection changed in another request. Try again.');
  }

  async function requireUser(req, res) {
    if (!auth?.enabled) {
      reply(req, res, 503, { error: 'Customer sign-in must be enabled before connecting Omnisend.', code: 'ACCOUNTS_NOT_CONFIGURED' });
      return null;
    }
    try {
      const user = await auth.identify(req);
      if (!user?.id) {
        reply(req, res, 401, { error: 'Sign in to connect your Omnisend account.', code: 'AUTH_REQUIRED' });
        return null;
      }
      return user;
    } catch {
      reply(req, res, 503, { error: 'Could not verify your sign-in. Try again shortly.', code: 'AUTH_UNAVAILABLE' });
      return null;
    }
  }

  /** Omnisend isn't set up: the owner is told which Secrets to add; everyone else, only that it isn't set up yet. */
  function notSetUp(user) {
    return new OmnisendError(503, 'CREDENTIALS_NOT_CONFIGURED', user?.isAdmin === true
      ? 'Add OMNISEND_CLIENT_ID and OMNISEND_CLIENT_SECRET in Replit Secrets after Omnisend issues them.'
      : 'Omnisend isn’t set up on this app yet.');
  }

  /** Over this minute's limit: answered with 429 here. */
  function limited(req, res, key, factor = 1) {
    if (!rateLimited(key, factor)) return false;
    reply(req, res, 429, { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMIT' });
    return true;
  }

  /** Why a stored connection can't be used until the customer connects again, or null. */
  function reconnectReason(doc, unreadable) {
    if (unreadable) return 'unreadable';
    if (doc.needsReconnect === 'revoked' || doc.needsReconnect === 'scopes') return doc.needsReconnect;
    if (doc.accessToken && OMNISEND_SCOPES.some((scope) => !Array.isArray(doc.scopes) || !doc.scopes.includes(scope))) return 'scopes';
    return null;
  }

  /** Omnisend refused this token (or its permissions): forget it, so status asks for a new connection. */
  async function markReconnect(userId, accessToken, reason) {
    await updateDocument(userDocumentKey(userId), (current) =>
      current.accessToken === accessToken ? { value: { needsReconnect: reason, markedAt: iso(now()) } } : { write: false },
    );
  }

  // ───────────── connecting ─────────────

  async function connect(req, res, user) {
    if (!credentialsConfigured) throw notSetUp(user);
    if (!storageReady) throw new OmnisendError(503, 'STORAGE_NOT_READY', 'Secure Omnisend token storage is not configured. Check the Supabase server secret and app_state migration.');
    if (req.headers.origin !== OMNISEND_PUBLIC_BASE_URL) {
      throw new OmnisendError(400, 'USE_PUBLISHED_APP', `Start the Omnisend connection from ${OMNISEND_PUBLIC_BASE_URL} so the callback returns to the same app.`);
    }
    // this browser's binding value: the one it already has (a connection started in another tab stays valid), or a new one
    const nonce = bindingFrom(req, signer) || signer.sign('binding', crypto.randomBytes(32).toString('base64url'));
    const tag = pendingTag(user.id);
    const state = signer.sign('state', `${crypto.randomBytes(32).toString('base64url')}.${tag}`);
    const createdAt = now();
    const refused = await updateDocument(pendingKey(tag), (current) => {
      if (forgotten(current, createdAt)) return { write: false, result: true };
      const kept = Object.entries(isRecord(current.states) ? current.states : {})
        .filter(([, entry]) => isRecord(entry) && Number(entry.createdAt) > createdAt - STATE_TTL_MS)
        .sort((a, b) => Number(a[1].createdAt) - Number(b[1].createdAt))
        .slice(-(MAX_PENDING_PER_USER - 1));
      const states = Object.fromEntries(kept);
      states[sha256(state)] = { userId: user.id, createdAt, binding: sha256(nonce), scopes: [...askedScopes] };
      return { value: { states }, result: false };
    });
    if (refused) throw new OmnisendError(403, 'ACCOUNT_GONE', 'This account is being deleted, so Omnisend can’t be connected to it.');
    const authUrl = new URL(OAUTH_AUTHORIZE_URL);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', OMNISEND_REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', askedScopes.join(' '));
    authUrl.searchParams.set('state', state);
    return reply(req, res, 200, { authorizationUrl: authUrl.toString() }, { 'set-cookie': bindingCookie(nonce, STATE_TTL_MS / 1000) });
  }

  function callbackRedirect(res, outcome, headers = {}) {
    const target = new URL('/', `${OMNISEND_PUBLIC_BASE_URL}/`);
    target.searchParams.set('omnisend', outcome);
    target.hash = 'marketing-email';
    res.writeHead(303, {
      location: target.toString(),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      ...headers,
    });
    res.end();
  }

  async function exchangeCode(code) {
    const form = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: OMNISEND_REDIRECT_URI,
    });
    let response;
    try {
      response = await fetchImpl(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new OmnisendError(502, 'TOKEN_EXCHANGE_FAILED', 'Omnisend could not complete the token exchange. Try connecting again.');
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !isRecord(payload) || typeof payload.access_token !== 'string' || !payload.access_token) {
      throw new OmnisendError(502, 'TOKEN_EXCHANGE_FAILED', 'Omnisend could not complete the token exchange. Check the OAuth credentials and registered callback URL.');
    }
    if (payload.token_type && String(payload.token_type).toLowerCase() !== 'bearer') {
      throw new OmnisendError(502, 'TOKEN_TYPE_UNSUPPORTED', 'Omnisend returned an unsupported token type. Try connecting again.');
    }
    return payload;
  }

  /** The started connection this state names, used once, if this browser started it; null otherwise. */
  async function consumeState(state, nonce) {
    const match = STATE_RE.exec(state);
    // a made-up state or cookie (no valid MAC) costs no storage read
    if (!match || !nonce || !signer.verify('state', match[1], match[3])) return null;
    const hash = sha256(state);
    return updateDocument(pendingKey(match[2]), (current) => {
      const states = isRecord(current.states) ? current.states : {};
      const entry = states[hash];
      // (another copy of the server may have made it, its clock a moment ahead: only an old one is refused)
      const age = now() - Number(entry?.createdAt);
      if (!isRecord(entry) || typeof entry.userId !== 'string' || !entry.userId || !(age <= STATE_TTL_MS)) return { write: false, result: null };
      if (!matchesBinding(entry.binding, nonce)) return { write: false, result: null };
      const rest = { ...states };
      delete rest[hash];
      return { value: { ...current, states: rest }, result: entry };
    });
  }

  async function callback(req, res, url) {
    // once a started connection is used up, this browser's cookie has done its job
    let done = {};
    try {
      // per caller (no sign-in here): each one costs a storage read, and may cost a token exchange
      if (rateLimited(`omnisend-callback:${clientKey(req)}`)) return callbackRedirect(res, 'busy');
      if (!storageReady) return callbackRedirect(res, 'invalid_state');
      const entry = await consumeState(url.searchParams.get('state') || '', bindingFrom(req, signer));
      if (!entry) return callbackRedirect(res, 'invalid_state');
      done = { 'set-cookie': bindingCookie('', 0) };
      if (url.searchParams.has('error')) {
        return callbackRedirect(res, url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'error', done);
      }
      if (!credentialsConfigured) return callbackRedirect(res, 'setup', done);
      const code = url.searchParams.get('code') || '';
      if (!code || code.length > 2048) return callbackRedirect(res, 'error', done);
      const token = await exchangeCode(code);
      const requested = Array.isArray(entry.scopes) ? entry.scopes : OMNISEND_SCOPES;
      const granted = typeof token.scope === 'string' && token.scope.trim() ? token.scope.trim().split(/\s+/) : requested;
      const scopes = askedScopes.filter((scope) => granted.includes(scope));
      const complete = OMNISEND_SCOPES.every((scope) => scopes.includes(scope));
      const connection = complete
        ? {
            accessToken: token.access_token,
            // Omnisend documents non-expiring access tokens and no refresh grant endpoint; retain the returned refresh token securely, but do not invent a refresh flow.
            refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token : '',
            scopes,
            connectedAt: iso(now()),
          }
        : { needsReconnect: 'scopes', markedAt: iso(now()) };
      // never for an account deleted meanwhile (its documents say so)
      const stored = await updateDocument(userDocumentKey(entry.userId), (current) => (forgotten(current, now()) ? { write: false, result: false } : { value: connection, result: true }));
      if (!stored) return callbackRedirect(res, 'invalid_state', done);
      return callbackRedirect(res, complete ? 'connected' : 'scopes', done);
    } catch {
      return callbackRedirect(res, 'error', done);
    }
  }

  // ───────────── status and disconnecting ─────────────

  async function status(req, res, user) {
    let doc = {};
    let unreadable = false;
    let statusStorageReady = storageReady;
    if (storageReady) {
      try {
        ({ value: doc, unreadable } = await readDocument(userDocumentKey(user.id)));
      } catch (error) {
        // the app_state table isn't there yet (the owner is told how to fix it); other trouble is passing
        if (credentialsConfigured && error?.code !== 'STORAGE_NOT_READY') throw error;
        statusStorageReady = false;
      }
    }
    const reconnect = reconnectReason(doc, unreadable);
    return reply(req, res, 200, {
      credentialsConfigured,
      // which Secrets are missing is the owner's business only
      missingCredentials: user.isAdmin === true ? missingCredentials : [],
      storageReady: statusStorageReady,
      connected: !reconnect && !!doc.accessToken,
      reconnect,
      scopes: !reconnect && Array.isArray(doc.scopes) ? doc.scopes.filter((scope) => OMNISEND_SCOPES.includes(scope)) : [],
      // the app's owner (ADMIN_EMAILS, as for Settings › AI keys) is the one who can set Omnisend up
      owner: user.isAdmin === true,
    });
  }

  async function disconnect(req, res, user) {
    if (!storageReady) throw new OmnisendError(503, 'STORAGE_NOT_READY', 'Secure Omnisend token storage is not configured.');
    // a connection that can't be read any more is replaced all the same
    await updateDocument(userDocumentKey(user.id), (current) => (forgotten(current, now()) ? { write: false } : { value: { disconnectedAt: iso(now()) } }));
    return reply(req, res, 200, { connected: false });
  }

  // ───────────── campaign drafts ─────────────

  /** One call to Omnisend's API: its answer, or a CallFailure saying whether it may have been done. Never retried. */
  async function omnisendCall(accessToken, path, payload) {
    let response;
    try {
      response = await fetchImpl(`${API_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          'omnisend-version': API_VERSION,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      // a timeout, or a connection lost after the request went out: Omnisend may have done it
      throw new CallFailure(NOT_SENT.test(String(error?.cause?.code || error?.code || '')) ? 'not_sent' : 'unknown');
    }
    const result = await response.json().catch(() => null);
    if (response.ok) return result;
    if (response.status === 401) throw new CallFailure('revoked', 401);
    if (response.status === 403) throw new CallFailure('forbidden', 403);
    if (response.status === 429) throw new CallFailure('rate_limited', 429);
    if (response.status >= 500) throw new CallFailure('unknown', response.status);
    // Omnisend's problem type, matched against fixed names only (its text is never passed on)
    if (response.status === 422 && typeof result?.type === 'string' && result.type.endsWith('/sender-email-not-available')) throw new CallFailure('sender', 422);
    throw new CallFailure('refused', response.status);
  }

  /** What to tell the customer about a failed step: whether something may now exist in Omnisend, never Omnisend's own text. */
  async function draftFailure(failure, step, userId, accessToken) {
    if (!(failure instanceof CallFailure)) return failure;
    const campaign = step === 'campaign';
    switch (failure.kind) {
      case 'revoked':
        await markReconnect(userId, accessToken, 'revoked').catch(() => {});
        return new OmnisendError(409, 'RECONNECT_REQUIRED', campaign
          ? 'The email template was imported, but Omnisend no longer accepts this connection, so no campaign draft was created. Connect Omnisend again.'
          : 'Omnisend no longer accepts this connection, so nothing was created. Connect Omnisend again.');
      case 'forbidden':
        await markReconnect(userId, accessToken, 'scopes').catch(() => {});
        return new OmnisendError(409, 'SCOPE_REQUIRED', campaign
          ? 'The email template was imported, but this connection may not create campaigns, so no campaign draft was created. Connect Omnisend again and allow campaigns and email templates.'
          : 'This connection may not create email templates, so nothing was created. Connect Omnisend again and allow campaigns and email templates.');
      case 'rate_limited':
        return new OmnisendError(429, 'OMNISEND_RATE_LIMIT', campaign
          ? 'The email template was imported, but Omnisend is limiting requests right now, so no campaign draft was created. Wait a minute and check Omnisend before trying again.'
          : 'Omnisend is limiting requests right now, so nothing was created. Wait a minute, then try again.');
      case 'sender':
        return new OmnisendError(422, 'SENDER_REQUIRED', 'The email template was imported, but Omnisend can’t create a campaign until this brand has a verified sender email. Add one in Omnisend’s sender settings; the template is already there to use.');
      case 'not_sent':
        return new OmnisendError(502, 'OMNISEND_UNAVAILABLE', campaign
          ? 'The email template was imported, but Omnisend couldn’t be reached to create the campaign draft. Check Omnisend before trying again.'
          : 'Couldn’t reach Omnisend, so nothing was created. Try again shortly.');
      case 'unknown':
        return new OmnisendError(502, 'OUTCOME_UNKNOWN', campaign
          ? 'The email template was imported, and the campaign draft may have been created: Omnisend didn’t confirm it. Check Omnisend before trying again.'
          : 'The email template may have been created: Omnisend didn’t confirm it. Check Omnisend before trying again.');
      default:
        return campaign
          ? new OmnisendError(502, 'DRAFT_CREATE_FAILED', `The email template was imported, but Omnisend refused the campaign draft (HTTP ${failure.status}), so none was created. Check Omnisend before trying again.`)
          : new OmnisendError(502, 'TEMPLATE_CREATE_FAILED', `Omnisend refused the email template (HTTP ${failure.status}), so nothing was created.`);
    }
  }

  /** The draft request's JSON object; a body over DRAFT_BODY_LIMIT is refused before it's read. */
  async function readDraftBody(req) {
    const tooLarge = () => new OmnisendError(413, 'TOO_LARGE', 'This email is too large for an Omnisend draft.', { connection: 'close' });
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > DRAFT_BODY_LIMIT) throw tooLarge();
    let body;
    try {
      body = await readJson(req, DRAFT_BODY_LIMIT);
    } catch (error) {
      if (error?.status === 413) throw tooLarge();
      throw new OmnisendError(400, 'BAD_REQUEST', 'The draft request couldn’t be read.');
    }
    if (!isRecord(body)) throw new OmnisendError(400, 'INVALID_DRAFT', 'Send the draft as a JSON object.');
    return body;
  }

  /** The draft's fields, checked: anything too long is refused, never cut (the draft must be what the preview shows). */
  function draftFrom(body) {
    const text = (value) => (typeof value === 'string' ? value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim() : '');
    const draft = {
      subject: text(body.subject),
      preheader: text(body.preheader),
      body: text(body.body),
      ctaLabel: text(body.ctaLabel),
      ctaUrl: text(body.ctaUrl),
    };
    if (!draft.subject || !draft.body) throw new OmnisendError(400, 'INVALID_DRAFT', 'A subject and email body are required.');
    const words = { subject: 'The subject', preheader: 'The preview text', body: 'The email body', ctaLabel: 'The button label', ctaUrl: 'The button link' };
    for (const field of Object.keys(words)) {
      if (chars(draft[field]).length > LIMITS[field]) {
        throw new OmnisendError(400, 'INVALID_DRAFT', `${words[field]} can be up to ${LIMITS[field].toLocaleString('en-US')} characters.`);
      }
    }
    if (draft.ctaUrl) {
      const url = safeHttpUrl(draft.ctaUrl);
      if (!url) throw new OmnisendError(400, 'INVALID_CTA', 'The button link must be a full web address (https://…).');
      draft.ctaUrl = url;
    }
    if (draft.ctaLabel && !draft.ctaUrl) throw new OmnisendError(400, 'INVALID_CTA', 'The button needs a link: a full web address (https://…).');
    // the campaign's name isn't part of the email, so a long one is shortened to Omnisend's limit
    const name = chars(text(body.name) || `Email campaign — ${draft.subject}`).slice(0, LIMITS.name).join('').trim();
    return { ...draft, name };
  }

  async function createCampaignDraft(req, res, user) {
    if (!credentialsConfigured) throw notSetUp(user);
    if (!storageReady) throw new OmnisendError(503, 'STORAGE_NOT_READY', 'Secure Omnisend token storage is not configured.');
    const { value: connection, unreadable } = await readDocument(userDocumentKey(user.id));
    const reason = reconnectReason(connection, unreadable);
    if (reason === 'scopes') {
      if (connection.accessToken) await markReconnect(user.id, connection.accessToken, 'scopes').catch(() => {});
      throw new OmnisendError(409, 'SCOPE_REQUIRED', 'Connect Omnisend again and allow campaigns and email templates.');
    }
    if (reason) throw new OmnisendError(409, 'RECONNECT_REQUIRED', 'This app can’t use the saved Omnisend connection anymore. Connect Omnisend again.');
    if (!connection.accessToken) throw new OmnisendError(409, 'NOT_CONNECTED', 'Connect your Omnisend account before creating a draft.');
    const accessToken = connection.accessToken;

    const draft = draftFrom(await readDraftBody(req));

    let template;
    try {
      template = await omnisendCall(accessToken, '/email-templates/import', {
        name: chars(`${draft.name} — email content`).slice(0, 255).join(''),
        html: campaignHtml(draft),
      });
    } catch (failure) {
      throw await draftFailure(failure, 'template', user.id, accessToken);
    }
    const templateId = template?.id;
    if (typeof templateId !== 'string' || !/^[a-f0-9]{24}$/i.test(templateId)) {
      throw new OmnisendError(502, 'TEMPLATE_UNCONFIRMED', 'Omnisend didn’t return the new template’s ID, so no campaign draft was created. The template may have been created: check Omnisend before trying again.');
    }

    let campaign;
    try {
      campaign = await omnisendCall(accessToken, '/campaigns', {
        channel: 'email',
        type: 'regular',
        name: draft.name,
        language: 'en_US',
        content: { email: { templateID: templateId, subject: draft.subject, ...(draft.preheader ? { preheader: draft.preheader } : {}) } },
      });
    } catch (failure) {
      throw await draftFailure(failure, 'campaign', user.id, accessToken);
    }
    return reply(req, res, 201, {
      campaign: {
        id: typeof campaign?.id === 'string' ? campaign.id : '',
        name: typeof campaign?.name === 'string' ? campaign.name : draft.name,
        status: typeof campaign?.status === 'string' ? campaign.status : 'draft',
        url: typeof campaign?.url === 'string' && campaign.url.startsWith('https://app.omnisend.com/') ? campaign.url : '',
      },
    });
  }

  // ───────────── the routes ─────────────

  async function handle(req, res, url) {
    const path = url.pathname;
    const method = req.method;
    if (!path.startsWith(`${API_PREFIX}/`)) return false;
    if (path === `${API_PREFIX}/callback` && method === 'GET') return callback(req, res, url);

    if (!sameOrigin(req)) {
      return reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
    }

    try {
      const user = await requireUser(req, res);
      if (!user) return true;

      if (path === `${API_PREFIX}/status` && method === 'GET') {
        if (limited(req, res, `omnisend-read:user:${user.id}`, 3)) return true;
        return await status(req, res, user);
      }
      if (path === `${API_PREFIX}/connect` && method === 'POST') {
        if (limited(req, res, `omnisend-connect:user:${user.id}`)) return true;
        return await connect(req, res, user);
      }
      if (path === `${API_PREFIX}/connection` && method === 'DELETE') {
        if (limited(req, res, `omnisend-connect:user:${user.id}`)) return true;
        return await disconnect(req, res, user);
      }
      if (path === `${API_PREFIX}/campaign-drafts` && method === 'POST') {
        if (limited(req, res, `omnisend-drafts:user:${user.id}`)) return true;
        return await createCampaignDraft(req, res, user);
      }
      if (path === `${API_PREFIX}/send` || path.startsWith(`${API_PREFIX}/campaigns/`) && path.endsWith('/send')) {
        return reply(req, res, 404, { error: 'Campaign sending is not enabled. Review and confirmation must be implemented first.', code: 'SEND_NOT_AVAILABLE' });
      }
      return reply(req, res, 404, { error: 'Not found.', code: 'NOT_FOUND' });
    } catch (error) {
      if (res.headersSent) return true;
      const known = error instanceof OmnisendError;
      const status = known ? error.status : 500;
      const message = known ? error.publicMessage : 'Omnisend could not complete the request. Try again shortly.';
      return reply(req, res, status, { error: message, code: known ? error.code : 'OMNISEND_ERROR' }, known ? error.headers : undefined);
    }
  }

  /**
   * Before an account is deleted: its connection and the connections it started are overwritten without being
   * read (an unreadable one goes too), and for FORGOTTEN_FOR_MS nothing can be connected to it, so a sign-in
   * still open in Omnisend's tab can't store a token for it. No app_state table means nothing was ever stored.
   *
   * A storage failure stops the deletion only while Omnisend is set up (a sign-in could still store a token).
   * Without the OAuth credentials no sign-in can finish, so the overwrite is tried and the deletion goes on
   * either way: an app that never set Omnisend up doesn't make account deletion depend on it.
   */
  async function forgetUser(userId) {
    if (!storageReady || !userId) return;
    const tombstone = { forgottenAt: iso(now()) };
    try {
      await storage.put(userDocumentKey(userId), tombstone);
      await storage.put(pendingKey(pendingTag(userId)), { ...tombstone, states: {} });
    } catch (error) {
      if (error?.code === 'NO_TABLE' || !credentialsConfigured) return;
      throw new OmnisendError(503, 'OMNISEND_FORGET_FAILED', 'Couldn’t remove your Omnisend connection just now, so your account wasn’t deleted. Try again shortly.');
    }
  }

  /**
   * The account deletion that forgetUser prepared for didn't happen: lift its block, so the account can connect
   * Omnisend again now rather than in FORGOTTEN_FOR_MS. (Its old connection is gone: they connect again.)
   * Best effort: if storage is down, the block simply lasts until it expires.
   */
  async function unforgetUser(userId) {
    if (!storageReady || !userId) return;
    const lift = (key, cleared) =>
      updateDocument(key, (current) => (current.forgottenAt ? { value: cleared } : { write: false })).catch(() => {});
    await lift(userDocumentKey(userId), {});
    await lift(pendingKey(pendingTag(userId)), { states: {} });
  }

  // ───────────── email analytics (server/analytics/sources/email.mjs) ─────────────

  /** A brand's opaque tag for the rate counters: the same connection, the same brand (never the token itself). */
  const brandTag = (accessToken) => sha256(`omnisend-brand:${accessToken}`).slice(0, 24);
  const reportsKey = (brand, day) => `omnisend:reports:${brand}:${day}`;
  const namesKey = (brand) => `omnisend:campaigns:${brand}`;

  /** One read from Omnisend's API (GET or a read-only POST): { status, body }, or { status: 0 } when it never answered. */
  async function omnisendRead(accessToken, method, path, payload) {
    try {
      const response = await fetchImpl(`${API_BASE_URL}${path}`, {
        method,
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'omnisend-version': API_VERSION, ...(payload ? { 'content-type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    } catch {
      return { status: 0, body: null };
    }
  }

  /** Campaign names by id (GET /api/campaigns?limit=100), kept for a day per brand. Names are shown as text. */
  async function campaignNames(accessToken, brand) {
    const key = namesKey(brand);
    const cached = await readDocument(key).catch(() => null);
    if (cached && Number(cached.value.at) > now() - CAMPAIGN_NAMES_TTL_MS && isRecord(cached.value.names)) return cached.value.names;
    const got = await omnisendRead(accessToken, 'GET', '/campaigns?limit=100');
    if (got.status !== 200) return isRecord(cached?.value?.names) ? cached.value.names : {};
    const list = Array.isArray(got.body?.campaigns) ? got.body.campaigns : Array.isArray(got.body) ? got.body : [];
    const names = {};
    for (const c of list.slice(0, 100)) if (isRecord(c) && typeof c.id === 'string') names[c.id.slice(0, 64)] = String(c.name ?? '').slice(0, 200);
    await storage.put(key, { at: now(), names }).catch(() => {});
    return names;
  }

  /**
   * The customer's email stats for the last 30 days (EmailData without leads), within Omnisend's limits: at most
   * one live call per brand per hour (inside the hour the last answer is served again, cached: true) and
   * REPORTS_PER_DAY a day. Never retried. Returns { status: 'ok', data, fetchedAt, cached? } |
   * { status: 'not_connected', errorCode: 'NOT_CONNECTED'|'NEEDS_RECONNECT' } | { status: 'skipped', errorCode:
   * 'RATE_LIMITED' } | { status: 'error', errorCode: 'UNAVAILABLE' }. Omnisend's own text never comes back.
   */
  async function reports(userId) {
    if (!storageReady || !userId) return { status: 'not_connected', errorCode: 'NOT_CONNECTED' };
    const { value: doc, unreadable } = await readDocument(userDocumentKey(userId));
    if (!doc.accessToken && !unreadable && !doc.needsReconnect) return { status: 'not_connected', errorCode: 'NOT_CONNECTED' };
    if (reconnectReason(doc, unreadable)) return { status: 'not_connected', errorCode: 'NEEDS_RECONNECT' };
    if (optionalScopes.some((scope) => !Array.isArray(doc.scopes) || !doc.scopes.includes(scope))) return { status: 'not_connected', errorCode: 'NEEDS_RECONNECT' };
    const brand = brandTag(doc.accessToken);
    const day = iso(now()).slice(0, 10);
    const key = reportsKey(brand, day);
    // claim the call before making it (compare-and-set): two Updates at once make one call
    const claim = await updateDocument(key, (current) => {
      const lastAt = Number(current.lastAt) || 0;
      if (lastAt > now() - REPORTS_EVERY_MS) return { write: false, result: { cached: current.last ?? null } };
      if ((Number(current.count) || 0) >= REPORTS_PER_DAY) return { write: false, result: { limited: true } };
      return { value: { ...current, count: (Number(current.count) || 0) + 1, lastAt: now() }, result: { go: true } };
    });
    if (claim.limited) return { status: 'skipped', errorCode: 'RATE_LIMITED' };
    if (!claim.go) return claim.cached?.data ? { status: 'ok', data: claim.cached.data, fetchedAt: claim.cached.fetchedAt, cached: true } : { status: 'ok', cached: true };
    const got = await omnisendRead(doc.accessToken, 'POST', '/analytics/reports', REPORTS_QUERY);
    if (got.status === 401) {
      await markReconnect(userId, doc.accessToken, 'revoked').catch(() => {});
      return { status: 'not_connected', errorCode: 'NEEDS_RECONNECT' };
    }
    if (got.status === 403) return { status: 'not_connected', errorCode: 'NEEDS_RECONNECT' };
    if (got.status === 429) return { status: 'skipped', errorCode: 'RATE_LIMITED' };
    if (got.status !== 200 || !Array.isArray(got.body?.reports)) return { status: 'error', errorCode: 'UNAVAILABLE' };
    const names = await campaignNames(doc.accessToken, brand).catch(() => ({}));
    const data = emailDataFrom(got.body.reports, names);
    const fetchedAt = iso(now());
    await updateDocument(key, (current) => ({ value: { ...current, last: { data, fetchedAt } } })).catch(() => {});
    return { status: 'ok', data, fetchedAt };
  }

  /** Whether the customer has a usable Omnisend connection (for "nothing to update"). */
  async function connected(userId) {
    if (!storageReady || !userId) return false;
    try {
      const { value: doc, unreadable } = await readDocument(userDocumentKey(userId));
      return !!doc.accessToken && !reconnectReason(doc, unreadable);
    } catch {
      return false;
    }
  }

  return { handle, forgetUser, unforgetUser, reports, connected };
}

/** The reports request for the Email Analytics tab (spec §1.5): campaign totals and sends per day, last 30 days. */
export const REPORTS_QUERY = Object.freeze({
  queries: [
    {
      alias: 'campaigns-30d',
      metrics: [{ name: 'sent' }, { name: 'openRate' }, { name: 'clickRate' }, { name: 'unsubscribeRate' }, { name: 'attributedRevenue' }, { name: 'attributedOrders' }],
      dimensions: [{ name: 'marketingActivityID' }],
      dateRange: { interval: 'last30Days' },
      filters: [{ name: 'marketingActivityType', operator: 'in', values: ['Campaign'] }],
    },
    {
      alias: 'daily-30d',
      metrics: [{ name: 'sent' }, { name: 'openedUnique' }, { name: 'clickedUnique' }],
      dimensions: [{ name: 'timestamp', granularity: 'day' }],
      dateRange: { interval: 'last30Days' },
    },
  ],
});

/** EmailData (without leads) from Omnisend's reports answer: rates are ratios (0–1); totals weighted by sends. */
export function emailDataFrom(reportList, names = {}) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  const rowsOf = (alias) => {
    const r = reportList.find((x) => isRecord(x) && x.alias === alias);
    return Array.isArray(r?.rows) ? r.rows.filter(isRecord).slice(0, 500) : [];
  };
  const campaigns = rowsOf('campaigns-30d').map((r) => {
    const id = String(r.marketingActivityID ?? '').slice(0, 64);
    return { id, name: String(names[id] ?? 'Campaign').slice(0, 200), sent: n(r.sent), openRate: n(r.openRate), clickRate: n(r.clickRate), unsubscribeRate: n(r.unsubscribeRate), revenue: n(r.attributedRevenue) };
  });
  const sent = campaigns.reduce((a, c) => a + c.sent, 0);
  const weighted = (field) => (sent ? campaigns.reduce((a, c) => a + c[field] * c.sent, 0) / sent : 0);
  const series = rowsOf('daily-30d')
    .map((r) => ({ date: String(r.timestamp ?? '').slice(0, 10), sent: n(r.sent), opened: n(r.openedUnique), clicked: n(r.clickedUnique) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    sent,
    openRate: weighted('openRate'),
    clickRate: weighted('clickRate'),
    unsubscribeRate: weighted('unsubscribeRate'),
    revenue: campaigns.reduce((a, c) => a + c.revenue, 0),
    series,
    campaigns: campaigns.map(({ unsubscribeRate, ...c }) => c),
  };
}
