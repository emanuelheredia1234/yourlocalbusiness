// Gmail: each signed-in customer connects their own mailbox so later outreach can send as them.
// One connection per customer (the account that owns their businesses), not per project and not through
// Nango. Omnisend is the pattern: start connect, callback, state + browser binding, encrypted app_state.
//
// Routes, under /api/integrations/gmail/: GET status, POST connect, GET callback (where Google sends the
// browser back), DELETE connection. Every route but the callback needs the app's own page (sameOrigin)
// and the customer's sign-in (a bearer token, never a cookie). There is no send route: sendMail() is for
// a later outreach caller. POST /send answers 404.
//
// Scopes, and no others: gmail.send, openid, and the email identity scope (to name the mailbox).
// Google access tokens expire; the refresh token is stored with the connection and used by sendMail.
// Disconnect and account deletion revoke the grant at Google when they can, and always forget it here.
//
// Storage (appState: encrypted, server-only), per customer:
//   gmail:user:<sha256(user id)>        their connection (the tokens), or a marker: disconnected, needs a
//                                       reconnect, or forgotten (the account was deleted)
//   gmail:oauth:pending:<tag>           the connections they started and haven't finished: at most
//                                       MAX_PENDING_PER_USER, each valid STATE_TTL_MS, used once
// A state is <32 random bytes>.<tag>, so a callback reads its owner's small document and nobody else's.
//
// The callback is tied to the browser that started the connection: /connect sets a __Host- cookie with a
// random value and keeps its hash with the state, and the callback needs that cookie. The cookie and the
// state each carry a MAC (a key derived from GOOGLE_CLIENT_SECRET), so a made-up cookie or state is turned
// away before any storage read.
//
// The redirect Google must allow is GMAIL_REDIRECT_URI only. Connect starts on the published app, as
// Omnisend does, so there is no localhost callback.

import crypto from 'node:crypto';

export const GMAIL_PUBLIC_BASE_URL = 'https://yourlocalbusiness.replit.app';
export const GMAIL_REDIRECT_URI = `${GMAIL_PUBLIC_BASE_URL}/api/integrations/gmail/callback`;
/** Send mail only. Do not add gmail.readonly, gmail.modify, gmail.compose, or profile. */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
/** OpenID Connect, required so Google will name the account. */
export const GMAIL_OPENID_SCOPE = 'openid';
/** The mailbox address. `email` is the same scope when Google returns the short name. */
export const GMAIL_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
export const GMAIL_SCOPES = Object.freeze([GMAIL_SEND_SCOPE, GMAIL_OPENID_SCOPE, GMAIL_EMAIL_SCOPE]);
/** The cookie that ties a callback to the browser that started the connection (HTTPS only). */
export const BINDING_COOKIE = '__Host-ylb_gmail';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const API_PREFIX = '/api/integrations/gmail';
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PER_USER = 3;
/** A deleted account's Gmail documents refuse new tokens this long: the longest a sign-in token can last. */
const FORGOTTEN_FOR_MS = 7 * 24 * 60 * 60 * 1000;
/** Refresh this long before Google's expiry, so a send doesn't race the clock. */
const REFRESH_SKEW_MS = 60_000;
const STATE_RE = /^([A-Za-z0-9_-]{43}\.([A-Za-z0-9_-]{22}))\.([A-Za-z0-9_-]{22})$/;
const NONCE_RE = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const GMAIL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const NOT_SENT = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|CERT_|ERR_TLS_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;

class GmailError extends Error {
  constructor(status, code, message, headers = undefined) {
    super(message);
    this.name = 'GmailError';
    this.status = status;
    this.code = code;
    this.publicMessage = message;
    this.headers = headers;
  }
}

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const userDocumentKey = (userId) => `gmail:user:${sha256(userId)}`;
const pendingTag = (userId) => crypto.createHash('sha256').update(`gmail-pending:${userId}`).digest('base64url').slice(0, 22);
const pendingKey = (tag) => `gmail:oauth:pending:${tag}`;
const iso = (ms) => new Date(ms).toISOString();

function forgotten(doc, at) {
  const when = Date.parse(doc?.forgottenAt);
  return Number.isFinite(when) && at - when < FORGOTTEN_FOR_MS;
}

function failStorage(error) {
  if (error?.code === 'NO_TABLE') {
    return new GmailError(503, 'STORAGE_NOT_READY', 'Secure integration storage is not set up yet. Run the app_state Supabase migration before connecting Gmail.');
  }
  return new GmailError(503, 'STORAGE_UNAVAILABLE', 'Secure integration storage is unavailable. Try again shortly.');
}

const bindingCookie = (value, maxAgeSeconds) => `${BINDING_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;

function createSigner(clientSecret) {
  const key = clientSecret ? crypto.createHmac('sha256', clientSecret).update('ylb-gmail-callback-mac-v1').digest() : null;
  const mac = (label, text) => crypto.createHmac('sha256', key).update(`${label}\n${text}`).digest('base64url').slice(0, 22);
  return {
    sign: (label, text) => `${text}.${mac(label, text)}`,
    verify: (label, text, given) => !!key && crypto.timingSafeEqual(Buffer.from(mac(label, text)), Buffer.from(given)),
  };
}

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

function matchesBinding(storedHex, nonce) {
  if (!nonce || typeof storedHex !== 'string' || !/^[a-f0-9]{64}$/.test(storedHex)) return false;
  return crypto.timingSafeEqual(Buffer.from(storedHex, 'hex'), crypto.createHash('sha256').update(nonce).digest());
}

/** An address safe to put in a mail header (no display name, no folding). */
export function safeEmail(value) {
  const email = String(value || '');
  return email.length <= 254 && EMAIL_RE.test(email);
}

function grantedSet(scopeString, fallback) {
  if (typeof scopeString !== 'string' || !scopeString.trim()) return new Set(fallback);
  return new Set(scopeString.trim().split(/\s+/));
}

const hasSend = (set) => set.has(GMAIL_SEND_SCOPE);
const hasOpenId = (set) => set.has(GMAIL_OPENID_SCOPE);
const hasEmailScope = (set) => set.has(GMAIL_EMAIL_SCOPE) || set.has('email');

function mailboxFrom(payload) {
  if (!isRecord(payload)) return null;
  const email = typeof payload.email === 'string' ? payload.email.trim() : '';
  const verified = payload.email_verified === true || payload.email_verified === 'true';
  if (!verified || !safeEmail(email)) return null;
  return email;
}

function tokenFresh(doc, at) {
  const exp = Date.parse(doc?.expiresAt);
  return typeof doc?.accessToken === 'string' && doc.accessToken.length > 0 && Number.isFinite(exp) && exp - at > REFRESH_SKEW_MS;
}

function reconnectReason(doc, unreadable) {
  if (unreadable) return 'unreadable';
  if (doc.needsReconnect === 'revoked' || doc.needsReconnect === 'scopes') return doc.needsReconnect;
  if (doc.accessToken && !doc.refreshToken) return 'revoked';
  if (doc.accessToken && !hasSend(new Set(Array.isArray(doc.scopes) ? doc.scopes : []))) return 'scopes';
  return null;
}

function ttlSeconds(expiresIn) {
  const seconds = Number(expiresIn);
  return Number.isFinite(seconds) && seconds > 30 && seconds < 86_400 ? seconds : 3600;
}

function encodeSubject(subject) {
  return /^[\t\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

/** One plain-text RFC 822 message, base64url, as Gmail's users.messages.send `raw` field. */
export function buildRawMessage({ from, to, subject, text, at }) {
  const body = Buffer.from(text.replace(/\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n')
    .replace(/\r\n$/, '');
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${new Date(at).toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}

function failureKind(error) {
  const code = String(error?.cause?.code || error?.code || '');
  if (NOT_SENT.test(code)) return 'not_sent';
  return 'unknown';
}

/**
 * auth, storage, send, rateLimited, corsHeaders, sameOrigin, clientKey: the same deps Omnisend takes
 * (ai-server.mjs). env, fetch, now: tests.
 */
export function createGmailRoutes({
  auth,
  storage,
  send,
  rateLimited = () => false,
  sameOrigin = () => true,
  clientKey = (req) => req.socket?.remoteAddress || 'unknown',
  corsHeaders = () => ({}),
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const clientId = String(env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(env.GOOGLE_CLIENT_SECRET || '').trim();
  const credentialsConfigured = !!(clientId && clientSecret);
  const missingCredentials = [
    ...(!clientId ? ['GOOGLE_CLIENT_ID'] : []),
    ...(!clientSecret ? ['GOOGLE_CLIENT_SECRET'] : []),
  ];
  const storageReady = storage?.enabled === true;
  const signer = createSigner(clientSecret);
  const reply = (req, res, status, body, headers = {}) => send(res, status, body, { ...corsHeaders(req), ...headers });

  function notes() {
    const redirect = `Redirect URI: ${GMAIL_REDIRECT_URI}`;
    if (credentialsConfigured) return [`Gmail outreach: on (customers connect their own Gmail). ${redirect}`];
    const names = missingCredentials.length ? missingCredentials.join(' and ') : 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET';
    return [`Gmail outreach: off (add ${names} in Replit Secrets). ${redirect}`];
  }

  async function readDocument(key) {
    if (!storageReady) throw new GmailError(503, 'STORAGE_NOT_READY', 'Secure integration storage needs Supabase server storage.');
    let result;
    try {
      result = await storage.get(key);
    } catch (error) {
      throw failStorage(error);
    }
    if (result?.unreadable) return { value: {}, version: result.updatedAt ?? null, unreadable: true };
    return { value: isRecord(result?.value) ? result.value : {}, version: result?.updatedAt ?? null, unreadable: false };
  }

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
    throw new GmailError(409, 'STORAGE_CONFLICT', 'The connection changed in another request. Try again.');
  }

  async function requireUser(req, res) {
    if (!auth?.enabled) {
      reply(req, res, 503, { error: 'Customer sign-in must be enabled before connecting Gmail.', code: 'ACCOUNTS_NOT_CONFIGURED' });
      return null;
    }
    try {
      const user = await auth.identify(req);
      if (!user?.id) {
        reply(req, res, 401, { error: 'Sign in to connect your Gmail account.', code: 'AUTH_REQUIRED' });
        return null;
      }
      return user;
    } catch {
      reply(req, res, 503, { error: 'Could not verify your sign-in. Try again shortly.', code: 'AUTH_UNAVAILABLE' });
      return null;
    }
  }

  function notSetUp(user) {
    return new GmailError(503, 'CREDENTIALS_NOT_CONFIGURED', user?.isAdmin === true
      ? 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Replit Secrets (the Google OAuth web client).'
      : 'Gmail isn’t set up on this app yet.');
  }

  function limited(req, res, key, factor = 1) {
    if (!rateLimited(key, factor)) return false;
    reply(req, res, 429, { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMIT' });
    return true;
  }

  async function markReconnect(userId, refreshToken, reason) {
    await updateDocument(userDocumentKey(userId), (current) =>
      current.refreshToken === refreshToken ? { value: { needsReconnect: reason, markedAt: iso(now()), ...(safeEmail(current.email) ? { email: current.email } : {}) } } : { write: false },
    );
  }

  async function postForm(url, fields, timeoutMs) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => null);
    return { response, payload };
  }

  /** Best effort. 200, or 400 (Google already doesn't know the token), counts as revoked. */
  async function revokeToken(token) {
    if (!token || !credentialsConfigured) return false;
    try {
      const response = await fetchImpl(REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      return response.status === 200 || response.status === 400;
    } catch {
      return false;
    }
  }

  async function connect(req, res, user) {
    if (!credentialsConfigured) throw notSetUp(user);
    if (!storageReady) throw new GmailError(503, 'STORAGE_NOT_READY', 'Secure Gmail token storage is not configured. Check the Supabase server secret and app_state migration.');
    if (req.headers.origin !== GMAIL_PUBLIC_BASE_URL) {
      throw new GmailError(400, 'USE_PUBLISHED_APP', `Start the Gmail connection from ${GMAIL_PUBLIC_BASE_URL} so the callback returns to the same app.`);
    }
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
      states[sha256(state)] = { userId: user.id, createdAt, binding: sha256(nonce), scopes: [...GMAIL_SCOPES] };
      return { value: { states }, result: false };
    });
    if (refused) throw new GmailError(403, 'ACCOUNT_GONE', 'This account is being deleted, so Gmail can’t be connected to it.');
    const authUrl = new URL(AUTHORIZE_URL);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', GMAIL_REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', GMAIL_SCOPES.join(' '));
    authUrl.searchParams.set('state', state);
    // offline + consent: Google returns a refresh token (it only does that on the first grant otherwise).
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    return reply(req, res, 200, { authorizationUrl: authUrl.toString() }, { 'set-cookie': bindingCookie(nonce, STATE_TTL_MS / 1000) });
  }

  function callbackRedirect(res, outcome, headers = {}) {
    const target = new URL('/', `${GMAIL_PUBLIC_BASE_URL}/`);
    target.searchParams.set('settings', 'accounts');
    target.searchParams.set('gmail', outcome);
    target.hash = 'workspace-settings';
    res.writeHead(303, {
      location: target.toString(),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      ...headers,
    });
    res.end();
  }

  async function exchangeCode(code) {
    let response;
    let payload;
    try {
      ({ response, payload } = await postForm(TOKEN_URL, {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: GMAIL_REDIRECT_URI,
      }, 15_000));
    } catch {
      throw new GmailError(502, 'TOKEN_EXCHANGE_FAILED', 'Google could not complete the connection. Try connecting again.');
    }
    if (!response.ok || !isRecord(payload) || typeof payload.access_token !== 'string' || !payload.access_token) {
      throw new GmailError(502, 'TOKEN_EXCHANGE_FAILED', 'Google could not complete the connection. Check the OAuth client and the registered redirect URI.');
    }
    if (payload.token_type && String(payload.token_type).toLowerCase() !== 'bearer') {
      throw new GmailError(502, 'TOKEN_TYPE_UNSUPPORTED', 'Google returned an unsupported token type. Try connecting again.');
    }
    return payload;
  }

  /** { email } when Google names a verified mailbox, { network: true } when it didn't answer, or null. */
  async function identifyMailbox(accessToken) {
    try {
      const response = await fetchImpl(USERINFO_URL, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return { network: true };
      const email = mailboxFrom(await response.json().catch(() => null));
      return email ? { email } : null;
    } catch {
      return { network: true };
    }
  }

  async function consumeState(state, nonce) {
    const match = STATE_RE.exec(state);
    if (!match || !nonce || !signer.verify('state', match[1], match[3])) return null;
    const hash = sha256(state);
    return updateDocument(pendingKey(match[2]), (current) => {
      const states = isRecord(current.states) ? current.states : {};
      const entry = states[hash];
      const age = now() - Number(entry?.createdAt);
      if (!isRecord(entry) || typeof entry.userId !== 'string' || !entry.userId || !(age <= STATE_TTL_MS)) return { write: false, result: null };
      if (!matchesBinding(entry.binding, nonce)) return { write: false, result: null };
      const rest = { ...states };
      delete rest[hash];
      return { value: { ...current, states: rest }, result: entry };
    });
  }

  async function callback(req, res, url) {
    let done = {};
    let grant = null;
    try {
      if (rateLimited(`gmail-callback:${clientKey(req)}`)) return callbackRedirect(res, 'busy');
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
      grant = await exchangeCode(code);
      const granted = grantedSet(grant.scope, GMAIL_SCOPES);
      const refreshToken = typeof grant.refresh_token === 'string' ? grant.refresh_token : '';
      if (!hasSend(granted) || !hasOpenId(granted) || !hasEmailScope(granted)) {
        await revokeToken(refreshToken || grant.access_token);
        return callbackRedirect(res, 'scopes', done);
      }
      if (!refreshToken) {
        await revokeToken(grant.access_token);
        return callbackRedirect(res, 'error', done);
      }
      const who = await identifyMailbox(grant.access_token);
      if (who?.network) {
        await revokeToken(refreshToken);
        return callbackRedirect(res, 'error', done);
      }
      if (!who?.email) {
        await revokeToken(refreshToken);
        return callbackRedirect(res, 'identity', done);
      }
      const connection = {
        accessToken: grant.access_token,
        refreshToken,
        expiresAt: iso(now() + ttlSeconds(grant.expires_in) * 1000),
        scopes: [...GMAIL_SCOPES],
        email: who.email,
        connectedAt: iso(now()),
      };
      const stored = await updateDocument(userDocumentKey(entry.userId), (current) => (forgotten(current, now()) ? { write: false, result: false } : { value: connection, result: true }));
      if (!stored) {
        await revokeToken(refreshToken);
        return callbackRedirect(res, 'invalid_state', done);
      }
      return callbackRedirect(res, 'connected', done);
    } catch {
      if (grant?.refresh_token || grant?.access_token) await revokeToken(grant.refresh_token || grant.access_token);
      return callbackRedirect(res, 'error', done);
    }
  }

  async function status(req, res, user) {
    let doc = {};
    let unreadable = false;
    let statusStorageReady = storageReady;
    if (storageReady) {
      try {
        ({ value: doc, unreadable } = await readDocument(userDocumentKey(user.id)));
      } catch (error) {
        if (credentialsConfigured && error?.code !== 'STORAGE_NOT_READY') throw error;
        statusStorageReady = false;
      }
    }
    const reconnect = reconnectReason(doc, unreadable);
    const email = !unreadable && safeEmail(doc.email) ? doc.email : '';
    return reply(req, res, 200, {
      credentialsConfigured,
      missingCredentials: user.isAdmin === true ? missingCredentials : [],
      storageReady: statusStorageReady,
      connected: !reconnect && !!doc.accessToken && !!doc.refreshToken,
      reconnect,
      scopes: !reconnect && Array.isArray(doc.scopes) ? doc.scopes.filter((scope) => GMAIL_SCOPES.includes(scope)) : [],
      email,
      owner: user.isAdmin === true,
    });
  }

  async function disconnect(req, res, user) {
    if (!storageReady) throw new GmailError(503, 'STORAGE_NOT_READY', 'Secure Gmail token storage is not configured.');
    let token = '';
    const outcome = await updateDocument(userDocumentKey(user.id), (current) => {
      if (forgotten(current, now())) return { write: false, result: 'gone' };
      token = typeof current.refreshToken === 'string' && current.refreshToken ? current.refreshToken : (typeof current.accessToken === 'string' ? current.accessToken : '');
      return { value: { disconnectedAt: iso(now()) }, result: 'ok' };
    });
    const revoked = outcome === 'gone' ? false : await revokeToken(token);
    return reply(req, res, 200, { connected: false, revoked });
  }

  async function refreshGrant(refreshToken) {
    let response;
    let payload;
    try {
      ({ response, payload } = await postForm(TOKEN_URL, {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }, 15_000));
    } catch {
      // Refresh is before any send, so a lost answer here did not send mail.
      throw new GmailError(502, 'GMAIL_UNAVAILABLE', 'Couldn’t reach Google to refresh the Gmail connection. Nothing was sent. Try again shortly.');
    }
    if (response.status === 400 && isRecord(payload) && payload.error === 'invalid_grant') return null;
    if (!response.ok || !isRecord(payload) || typeof payload.access_token !== 'string' || !payload.access_token) {
      throw new GmailError(502, 'TOKEN_REFRESH_FAILED', 'Google couldn’t refresh the Gmail connection. Connect Gmail again if this keeps happening.');
    }
    return payload;
  }

  async function loadConnection(userId) {
    const { value, unreadable } = await readDocument(userDocumentKey(userId));
    const reason = reconnectReason(value, unreadable);
    if (reason) throw new GmailError(409, 'RECONNECT_REQUIRED', 'Gmail needs to be connected again before mail can be sent.');
    if (typeof value.refreshToken !== 'string' || !value.refreshToken || typeof value.accessToken !== 'string' || !value.accessToken) {
      throw new GmailError(409, 'NOT_CONNECTED', 'Connect Gmail before sending.');
    }
    if (!safeEmail(value.email)) throw new GmailError(409, 'RECONNECT_REQUIRED', 'Gmail needs to be connected again so the mailbox address is known.');
    return value;
  }

  /**
   * A usable access token, refreshing first when it's close to expiry (or when force, after Gmail said 401).
   * An invalid_grant re-reads in case another request just stored a fresh token, and only then asks the
   * customer to connect again.
   */
  async function ensureAccess(userId, { force = false } = {}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const doc = await loadConnection(userId);
      if (!force && tokenFresh(doc, now())) return { accessToken: doc.accessToken, refreshToken: doc.refreshToken, email: doc.email };
      const payload = await refreshGrant(doc.refreshToken);
      if (!payload) {
        const again = await readDocument(userDocumentKey(userId));
        if (!again.unreadable && tokenFresh(again.value, now())) return { accessToken: again.value.accessToken, refreshToken: again.value.refreshToken, email: again.value.email };
        await markReconnect(userId, doc.refreshToken, 'revoked');
        throw new GmailError(409, 'RECONNECT_REQUIRED', 'Gmail no longer accepts this connection. Connect Gmail again.');
      }
      if (typeof payload.scope === 'string' && payload.scope.trim() && !hasSend(grantedSet(payload.scope, []))) {
        await markReconnect(userId, doc.refreshToken, 'scopes');
        throw new GmailError(409, 'SCOPE_REQUIRED', 'Gmail didn’t grant permission to send. Connect Gmail again and allow sending.');
      }
      const refreshToken = typeof payload.refresh_token === 'string' && payload.refresh_token ? payload.refresh_token : doc.refreshToken;
      const expiresAt = iso(now() + ttlSeconds(payload.expires_in) * 1000);
      const written = await updateDocument(userDocumentKey(userId), (current) => {
        if (forgotten(current, now())) return { write: false, result: null };
        if (current.refreshToken !== doc.refreshToken) return { write: false, result: 'retry' };
        return {
          value: { ...current, accessToken: payload.access_token, refreshToken, expiresAt },
          result: { accessToken: payload.access_token, refreshToken, email: current.email },
        };
      });
      if (written === 'retry') continue;
      if (!written?.accessToken) throw new GmailError(409, 'NOT_CONNECTED', 'Connect Gmail before sending.');
      return written;
    }
    throw new GmailError(409, 'STORAGE_CONFLICT', 'The Gmail connection changed in another request. Try again.');
  }

  function validateMessage(message) {
    if (!isRecord(message)) throw new GmailError(400, 'INVALID_MESSAGE', 'The message needs a recipient, a subject and some text.');
    const to = typeof message.to === 'string' ? message.to.trim() : '';
    const subject = typeof message.subject === 'string' ? message.subject.trim() : '';
    const text = typeof message.text === 'string' ? message.text : '';
    const subjectChars = [...subject].length;
    if (!safeEmail(to) || !subject || subjectChars > 200 || /[\r\n\u0000]/.test(subject) || !text.trim() || text.length > 20_000 || /[\u0000]/.test(text)) {
      throw new GmailError(400, 'INVALID_MESSAGE', 'The message needs one email address, a subject and some text.');
    }
    return { to, subject, text: text.replace(/\r\n/g, '\n').replace(/\r/g, '\n') };
  }

  async function postMessage(accessToken, raw) {
    try {
      const response = await fetchImpl(SEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ raw }),
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json().catch(() => null);
      return { status: response.status, payload };
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || failureKind(error) === 'unknown') {
        throw new GmailError(504, 'OUTCOME_UNKNOWN', 'The message may have been sent. Check the mailbox before trying again.');
      }
      throw new GmailError(502, 'GMAIL_UNAVAILABLE', 'Couldn’t reach Gmail, so the message was not sent. Try again shortly.');
    }
  }

  function permissionDenied(payload) {
    if (payload?.error?.status === 'PERMISSION_DENIED') return true;
    const errors = payload?.error?.errors;
    return Array.isArray(errors) && errors.some((item) => item?.reason === 'insufficientPermissions' || item?.reason === 'forbidden');
  }

  function sentId(value) {
    return typeof value === 'string' && GMAIL_ID_RE.test(value) ? value : '';
  }

  /**
   * Send one plain-text message from the customer's connected Gmail. Not an HTTP route: outreach calls
   * this later. The message is sent once. A timeout or a 5xx is not retried (it may have been sent).
   * A 401 refreshes the access token and tries once more, because Gmail rejected it before accepting it.
   * From is the connected mailbox, never a value on the message.
   */
  async function sendMail(userId, message) {
    const draft = validateMessage(message);
    if (!credentialsConfigured) throw new GmailError(503, 'CREDENTIALS_NOT_CONFIGURED', 'Gmail isn’t set up on this app yet.');
    if (!storageReady) throw new GmailError(503, 'STORAGE_NOT_READY', 'Secure Gmail token storage is not configured.');
    if (!userId) throw new GmailError(401, 'AUTH_REQUIRED', 'Sign in to send from Gmail.');
    if (rateLimited(`gmail-send:user:${userId}`)) throw new GmailError(429, 'RATE_LIMIT', 'Too many messages. Try again in a minute.');
    let access = await ensureAccess(userId);
    const raw = buildRawMessage({ from: access.email, to: draft.to, subject: draft.subject, text: draft.text, at: now() });
    let sent = await postMessage(access.accessToken, raw);
    if (sent.status === 401) {
      access = await ensureAccess(userId, { force: true });
      sent = await postMessage(access.accessToken, buildRawMessage({ from: access.email, to: draft.to, subject: draft.subject, text: draft.text, at: now() }));
    }
    if (sent.status === 401) {
      await markReconnect(userId, access.refreshToken, 'revoked');
      throw new GmailError(409, 'RECONNECT_REQUIRED', 'Gmail no longer accepts this connection. Connect Gmail again. Nothing further was sent.');
    }
    if (sent.status === 403 && permissionDenied(sent.payload)) {
      await markReconnect(userId, access.refreshToken, 'scopes');
      throw new GmailError(409, 'SCOPE_REQUIRED', 'Gmail didn’t allow sending. Connect Gmail again and allow sending. Nothing was sent.');
    }
    if (sent.status === 429) throw new GmailError(429, 'GMAIL_RATE_LIMIT', 'Gmail is limiting sends right now. Wait and check the mailbox before trying again.');
    if (sent.status >= 500 || sent.status === 408) throw new GmailError(504, 'OUTCOME_UNKNOWN', 'The message may have been sent. Check the mailbox before trying again.');
    if (sent.status !== 200) throw new GmailError(502, 'SEND_FAILED', 'Gmail refused the message, so it was not sent. Check the recipient and try again.');
    return { id: sentId(sent.payload?.id), threadId: sentId(sent.payload?.threadId) };
  }

  async function connected(userId) {
    if (!storageReady || !userId) return false;
    try {
      const { value, unreadable } = await readDocument(userDocumentKey(userId));
      return !!value.accessToken && !!value.refreshToken && !reconnectReason(value, unreadable) && safeEmail(value.email);
    } catch {
      return false;
    }
  }

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
        if (limited(req, res, `gmail-read:user:${user.id}`, 3)) return true;
        return await status(req, res, user);
      }
      if (path === `${API_PREFIX}/connect` && method === 'POST') {
        if (limited(req, res, `gmail-connect:user:${user.id}`)) return true;
        return await connect(req, res, user);
      }
      if (path === `${API_PREFIX}/connection` && method === 'DELETE') {
        if (limited(req, res, `gmail-connect:user:${user.id}`)) return true;
        return await disconnect(req, res, user);
      }
      if (path === `${API_PREFIX}/send`) {
        return reply(req, res, 404, { error: 'Gmail sending isn’t available from the app yet.', code: 'SEND_NOT_AVAILABLE' });
      }
      return reply(req, res, 404, { error: 'Not found.', code: 'NOT_FOUND' });
    } catch (error) {
      if (res.headersSent) return true;
      const known = error instanceof GmailError;
      const statusCode = known ? error.status : 500;
      const message = known ? error.publicMessage : 'Gmail could not complete the request. Try again shortly.';
      return reply(req, res, statusCode, { error: message, code: known ? error.code : 'GMAIL_ERROR' }, known ? error.headers : undefined);
    }
  }

  /**
   * Before an account is deleted: revoke the grant if we can still read it, then overwrite the connection
   * and the connections it started (an unreadable one goes too). For FORGOTTEN_FOR_MS nothing can be
   * connected to it. A storage failure stops the deletion only while Gmail is set up.
   */
  async function forgetUser(userId) {
    if (!storageReady || !userId) return;
    let token = '';
    try {
      const { value } = await readDocument(userDocumentKey(userId));
      token = typeof value.refreshToken === 'string' && value.refreshToken ? value.refreshToken : (typeof value.accessToken === 'string' ? value.accessToken : '');
    } catch {
      token = '';
    }
    if (token) await revokeToken(token);
    const tombstone = { forgottenAt: iso(now()) };
    try {
      await storage.put(userDocumentKey(userId), tombstone);
      await storage.put(pendingKey(pendingTag(userId)), { ...tombstone, states: {} });
    } catch (error) {
      if (error?.code === 'NO_TABLE' || !credentialsConfigured) return;
      throw new GmailError(503, 'GMAIL_FORGET_FAILED', 'Couldn’t remove your Gmail connection just now, so your account wasn’t deleted. Try again shortly.');
    }
  }

  async function unforgetUser(userId) {
    if (!storageReady || !userId) return;
    const lift = (key, cleared) =>
      updateDocument(key, (current) => (current.forgottenAt ? { value: cleared } : { write: false })).catch(() => {});
    await lift(userDocumentKey(userId), {});
    await lift(pendingKey(pendingTag(userId)), { states: {} });
  }

  return { handle, forgetUser, unforgetUser, sendMail, connected, notes };
}
