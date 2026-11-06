// First-party social connect: each signed-in customer connects a business's own Facebook Page,
// Instagram, TikTok, X, Pinterest, and YouTube account. One connection per business per network,
// the same boundary as an Upload-Post profile (one per business). This does not post. Upload-Post
// stays the posting path while UPLOAD_POST_API_KEY is set. Nango is not used.
//
// Routes, under /api/integrations/<network>/: GET status, POST connect, GET callback, DELETE connection.
// GET /api/integrations/social-oauth/status?projectId= returns every network for that business.
// Every route but the callback needs the app's own page (sameOrigin) and the customer's sign-in.
// There is no publish route. accessTokenFor() refreshes a stored token for a later posting helper.
//
// Instagram uses the same Meta app as Facebook (META_APP_ID, META_APP_SECRET) and its own callback,
// so both redirect URIs are registered on that one app. YouTube uses YOUTUBE_CLIENT_ID and
// YOUTUBE_CLIENT_SECRET, never the Gmail Google client.
//
// Scopes (these and no others):
//   meta       pages_show_list, pages_manage_posts, pages_read_engagement
//   instagram  instagram_basic, instagram_content_publish, pages_show_list, pages_read_engagement
//   tiktok     user.info.basic, video.publish
//   x          tweet.read, tweet.write, users.read, offline.access
//   pinterest  boards:read, pins:write, user_accounts:read
//   youtube    youtube.upload, youtube.readonly
// PKCE: X (base64url S256, required), TikTok (hex S256, the form TikTok documents), YouTube
// (base64url S256, which Google recommends). Meta, Instagram, and Pinterest use the state MAC
// and the browser-binding cookie, the same CSRF pair as Gmail. X and TikTok and YouTube use that pair too.
//
// Storage (appState: encrypted, server-only), per customer:
//   socialoauth:user:<sha256(user id)>     businesses[<project id>][<network>] = the tokens
//   socialoauth:oauth:pending:<tag>        connects they started and haven't finished
// A state is <32 random bytes>.<tag> plus a MAC. The callback reads that user's pending document only.

import crypto from 'node:crypto';

export const SOCIAL_OAUTH_PUBLIC_BASE_URL = 'https://yourlocalbusiness.replit.app';
export const GRAPH_VERSION = 'v23.0';

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PER_USER = 3;
const FORGOTTEN_FOR_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_SKEW_MS = 60_000;
const STATE_RE = /^([A-Za-z0-9_-]{43}\.([A-Za-z0-9_-]{22}))\.([A-Za-z0-9_-]{22})$/;
const NONCE_RE = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/;
const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const ACCOUNT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const META_AUTHORIZE_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const META_TOKEN_URL = `${GRAPH}/oauth/access_token`;

/** A project id the client may name. Empty when it isn't one. Never a prototype key. */
export function socialProjectId(value) {
  if (typeof value !== 'string' || !PROJECT_ID_RE.test(value) || RESERVED_KEYS.has(value)) return '';
  return value;
}

const redirectUri = (network) => `${SOCIAL_OAUTH_PUBLIC_BASE_URL}/api/integrations/${network}/callback`;

const META_SCOPES = Object.freeze(['pages_show_list', 'pages_manage_posts', 'pages_read_engagement']);
const INSTAGRAM_SCOPES = Object.freeze(['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement']);
const TIKTOK_SCOPES = Object.freeze(['user.info.basic', 'video.publish']);
const X_SCOPES = Object.freeze(['tweet.read', 'tweet.write', 'users.read', 'offline.access']);
const PINTEREST_SCOPES = Object.freeze(['boards:read', 'pins:write', 'user_accounts:read']);
const YOUTUBE_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
]);

/**
 * network id, customer-facing label, secret names, OAuth endpoints, scopes, and how the token call
 * authenticates. `pkce` is '' or 'base64url' or 'hex'. `scopeJoin` is what that provider splits on.
 */
export const SOCIAL_OAUTH_PROVIDERS = Object.freeze([
  {
    id: 'meta',
    label: 'Facebook',
    secretNames: Object.freeze(['META_APP_ID', 'META_APP_SECRET']),
    redirectUri: redirectUri('meta'),
    authorizeUrl: META_AUTHORIZE_URL,
    tokenUrl: META_TOKEN_URL,
    scopes: META_SCOPES,
    scopeJoin: ',',
    clientIdParam: 'client_id',
    pkce: '',
    tokenAuth: 'body',
    kind: 'meta',
    defaultTtl: 5_184_000,
    authorizeOrigin: 'https://www.facebook.com',
  },
  {
    id: 'instagram',
    label: 'Instagram',
    secretNames: Object.freeze(['META_APP_ID', 'META_APP_SECRET']),
    redirectUri: redirectUri('instagram'),
    authorizeUrl: META_AUTHORIZE_URL,
    tokenUrl: META_TOKEN_URL,
    scopes: INSTAGRAM_SCOPES,
    scopeJoin: ',',
    clientIdParam: 'client_id',
    pkce: '',
    tokenAuth: 'body',
    kind: 'meta',
    defaultTtl: 5_184_000,
    authorizeOrigin: 'https://www.facebook.com',
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    secretNames: Object.freeze(['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET']),
    redirectUri: redirectUri('tiktok'),
    authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    revokeUrl: 'https://open.tiktokapis.com/v2/oauth/revoke/',
    scopes: TIKTOK_SCOPES,
    scopeJoin: ',',
    clientIdParam: 'client_key',
    pkce: 'hex',
    tokenAuth: 'tiktok',
    kind: 'standard',
    defaultTtl: 7200,
    authorizeOrigin: 'https://www.tiktok.com',
  },
  {
    id: 'x',
    label: 'X',
    secretNames: Object.freeze(['X_CLIENT_ID', 'X_CLIENT_SECRET']),
    redirectUri: redirectUri('x'),
    authorizeUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.x.com/2/oauth2/token',
    revokeUrl: 'https://api.x.com/2/oauth2/revoke',
    scopes: X_SCOPES,
    scopeJoin: ' ',
    clientIdParam: 'client_id',
    pkce: 'base64url',
    tokenAuth: 'basic',
    kind: 'standard',
    defaultTtl: 7200,
    authorizeOrigin: 'https://x.com',
  },
  {
    id: 'pinterest',
    label: 'Pinterest',
    secretNames: Object.freeze(['PINTEREST_APP_ID', 'PINTEREST_APP_SECRET']),
    redirectUri: redirectUri('pinterest'),
    authorizeUrl: 'https://www.pinterest.com/oauth/',
    tokenUrl: 'https://api.pinterest.com/v5/oauth/token',
    scopes: PINTEREST_SCOPES,
    scopeJoin: ',',
    clientIdParam: 'client_id',
    pkce: '',
    tokenAuth: 'basic',
    kind: 'standard',
    defaultTtl: 2_592_000,
    authorizeOrigin: 'https://www.pinterest.com',
  },
  {
    id: 'youtube',
    label: 'YouTube',
    secretNames: Object.freeze(['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET']),
    redirectUri: redirectUri('youtube'),
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    scopes: YOUTUBE_SCOPES,
    scopeJoin: ' ',
    clientIdParam: 'client_id',
    pkce: 'base64url',
    tokenAuth: 'body',
    kind: 'standard',
    defaultTtl: 3600,
    extraParams: Object.freeze({ access_type: 'offline', prompt: 'consent' }),
    authorizeOrigin: 'https://accounts.google.com',
  },
]);

export const SOCIAL_OAUTH_REDIRECTS = Object.freeze(Object.fromEntries(SOCIAL_OAUTH_PROVIDERS.map((provider) => [provider.id, provider.redirectUri])));
export const SOCIAL_OAUTH_SCOPES = Object.freeze(Object.fromEntries(SOCIAL_OAUTH_PROVIDERS.map((provider) => [provider.id, provider.scopes])));

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
export const userDocumentKey = (userId) => `socialoauth:user:${sha256(userId)}`;
const pendingTag = (userId) => crypto.createHash('sha256').update(`socialoauth-pending:${userId}`).digest('base64url').slice(0, 22);
const pendingKey = (tag) => `socialoauth:oauth:pending:${tag}`;
const iso = (ms) => new Date(ms).toISOString();
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

class SocialOAuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'SocialOAuthError';
    this.status = status;
    this.code = code;
    this.publicMessage = message;
  }
}

function forgotten(doc, at) {
  const when = Date.parse(doc?.forgottenAt);
  return Number.isFinite(when) && at - when < FORGOTTEN_FOR_MS;
}

function failStorage(error) {
  if (error?.code === 'NO_TABLE') {
    return new SocialOAuthError(503, 'STORAGE_NOT_READY', 'Secure integration storage is not set up yet. Run the app_state Supabase migration before connecting a social account.');
  }
  return new SocialOAuthError(503, 'STORAGE_UNAVAILABLE', 'Secure integration storage is unavailable. Try again shortly.');
}

function cleanLabel(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
}

function cleanId(value) {
  const text = String(value || '');
  return ACCOUNT_ID_RE.test(text) ? text : '';
}

function scopeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.trim().split(/[\s,]+/).filter(Boolean);
}

function hasAll(granted, required) {
  const set = new Set(granted);
  return required.every((scope) => set.has(scope));
}

function ttlSeconds(expiresIn, fallback) {
  const seconds = Number(expiresIn);
  const max = 90 * 24 * 3600;
  return Number.isFinite(seconds) && seconds > 30 && seconds < max ? seconds : fallback;
}

function codeChallenge(verifier, encoding) {
  const digest = crypto.createHash('sha256').update(verifier).digest();
  return encoding === 'hex' ? digest.toString('hex') : digest.toString('base64url');
}

function basicAuth(id, secret) {
  return `Basic ${Buffer.from(`${id}:${secret}`, 'utf8').toString('base64')}`;
}

function businessesOf(doc) {
  const src = isRecord(doc?.businesses) ? doc.businesses : {};
  const out = Object.create(null);
  for (const [key, value] of Object.entries(src)) {
    if (!socialProjectId(key) || !isRecord(value)) continue;
    const slots = Object.create(null);
    for (const provider of SOCIAL_OAUTH_PROVIDERS) {
      if (isRecord(value[provider.id])) slots[provider.id] = value[provider.id];
    }
    if (Object.keys(slots).length) out[key] = slots;
  }
  return out;
}

function createSigner(clientSecret, providerId) {
  const key = clientSecret ? crypto.createHmac('sha256', clientSecret).update(`ylb-social-oauth-mac-v1:${providerId}`).digest() : null;
  const mac = (label, text) => crypto.createHmac('sha256', key).update(`${label}\n${text}`).digest('base64url').slice(0, 22);
  return {
    sign: (label, text) => `${text}.${mac(label, text)}`,
    verify: (label, text, given) => !!key && given.length === mac(label, text).length && crypto.timingSafeEqual(Buffer.from(mac(label, text)), Buffer.from(given)),
  };
}

function bindingFrom(req, cookieName, signer) {
  for (const part of String(req.headers?.cookie || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === cookieName) {
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

function tokenFresh(doc, at) {
  const exp = Date.parse(doc?.expiresAt);
  return typeof doc?.accessToken === 'string' && doc.accessToken.length > 0 && Number.isFinite(exp) && exp - at > REFRESH_SKEW_MS;
}

function invalidGrant(response, payload) {
  if (response?.status === 401) return true;
  if (!isRecord(payload)) return false;
  if (payload.error === 'invalid_grant' || payload.error === 'invalid_token') return true;
  const nested = isRecord(payload.error) ? payload.error : null;
  return nested?.code === 190;
}

/**
 * auth, storage, send, readJson, rateLimited, corsHeaders, sameOrigin, clientKey: the same deps Gmail takes.
 * env, fetch, now: tests.
 */
export function createSocialOAuthRoutes({
  auth,
  storage,
  send,
  readJson = async () => ({}),
  rateLimited = () => false,
  sameOrigin = () => true,
  clientKey = (req) => req.socket?.remoteAddress || 'unknown',
  corsHeaders = () => ({}),
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const providers = SOCIAL_OAUTH_PROVIDERS.map((spec) => {
    const clientId = String(env[spec.secretNames[0]] || '').trim();
    const clientSecret = String(env[spec.secretNames[1]] || '').trim();
    const missingCredentials = [
      ...(!clientId ? [spec.secretNames[0]] : []),
      ...(!clientSecret ? [spec.secretNames[1]] : []),
    ];
    return {
      ...spec,
      clientId,
      clientSecret,
      credentialsConfigured: !!(clientId && clientSecret),
      missingCredentials,
      cookieName: `__Host-ylb_${spec.id}`,
      signer: createSigner(clientSecret, spec.id),
    };
  });
  const byId = (id) => providers.find((provider) => provider.id === id) || null;
  const anyConfigured = () => providers.some((provider) => provider.credentialsConfigured);
  const storageReady = storage?.enabled === true;
  const reply = (req, res, status, body, headers = {}) => send(res, status, body, { ...corsHeaders(req), ...headers });

  function notes() {
    const lines = ['Direct social connect: on for any network whose secrets are set. Posting still uses Upload-Post when UPLOAD_POST_API_KEY is set. Not Nango.'];
    for (const provider of providers) {
      const redirect = `Redirect URI: ${provider.redirectUri}`;
      if (provider.credentialsConfigured) lines.push(`${provider.label} connect: on. ${redirect}`);
      else lines.push(`${provider.label} connect: off (add ${provider.missingCredentials.join(' and ') || provider.secretNames.join(' and ')} in Replit Secrets). ${redirect}`);
    }
    lines.push('Instagram uses the Meta app (META_APP_ID and META_APP_SECRET) and its own redirect URI. YouTube uses YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET, not the Gmail client.');
    return lines;
  }

  function match(url) {
    const path = url.pathname;
    if (path.startsWith('/api/integrations/social-oauth/')) return true;
    return providers.some((provider) => path.startsWith(`/api/integrations/${provider.id}/`));
  }

  async function readDocument(key) {
    if (!storageReady) throw new SocialOAuthError(503, 'STORAGE_NOT_READY', 'Secure integration storage needs Supabase server storage.');
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
    throw new SocialOAuthError(409, 'STORAGE_CONFLICT', 'The connection changed in another request. Try again.');
  }

  async function requireUser(req, res) {
    if (!auth?.enabled) {
      reply(req, res, 503, { error: 'Customer sign-in must be enabled before connecting a social account.', code: 'ACCOUNTS_NOT_CONFIGURED' });
      return null;
    }
    try {
      const user = await auth.identify(req);
      if (!user?.id) {
        reply(req, res, 401, { error: 'Sign in to connect a social account.', code: 'AUTH_REQUIRED' });
        return null;
      }
      return user;
    } catch {
      reply(req, res, 503, { error: 'Could not verify your sign-in. Try again shortly.', code: 'AUTH_UNAVAILABLE' });
      return null;
    }
  }

  function notSetUp(provider, user) {
    const names = provider.secretNames.join(' and ');
    return new SocialOAuthError(503, 'CREDENTIALS_NOT_CONFIGURED', user?.isAdmin === true
      ? `Add ${names} in Replit Secrets before customers can connect ${provider.label}.`
      : `${provider.label} isn’t set up on this app yet.`);
  }

  function limited(req, res, key, factor = 1) {
    if (!rateLimited(key, factor)) return false;
    reply(req, res, 429, { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMIT' });
    return true;
  }

  function bindingCookie(provider, value, maxAgeSeconds) {
    return `${provider.cookieName}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
  }

  async function postForm(url, fields, headers = {}) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => null);
    return { response, payload };
  }

  async function getJson(url, accessToken) {
    try {
      const response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return { network: true };
      return { payload: await response.json().catch(() => null) };
    } catch {
      return { network: true };
    }
  }

  function readToken(payload) {
    if (!isRecord(payload) || typeof payload.access_token !== 'string' || !payload.access_token) return null;
    if (payload.token_type && String(payload.token_type).toLowerCase() !== 'bearer') return { badType: true };
    return {
      accessToken: payload.access_token,
      refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : '',
      expiresIn: payload.expires_in,
      refreshExpiresIn: payload.refresh_expires_in ?? payload.refresh_token_expires_in,
      scope: payload.scope,
      openId: typeof payload.open_id === 'string' ? payload.open_id : '',
    };
  }

  async function exchangeCode(provider, code, verifier) {
    try {
      if (provider.kind === 'meta') {
        const short = await postForm(provider.tokenUrl, {
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
          redirect_uri: provider.redirectUri,
          code,
        });
        const shortToken = readToken(short.payload);
        if (!short.response.ok || !shortToken?.accessToken) {
          throw new SocialOAuthError(502, 'TOKEN_EXCHANGE_FAILED', `${provider.label} could not complete the connection. Check the app and the registered redirect URI.`);
        }
        const long = await postForm(provider.tokenUrl, {
          grant_type: 'fb_exchange_token',
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
          fb_exchange_token: shortToken.accessToken,
        });
        const longToken = readToken(long.payload);
        if (!long.response.ok || !longToken?.accessToken) {
          await revokeToken(provider, shortToken.accessToken);
          throw new SocialOAuthError(502, 'TOKEN_EXCHANGE_FAILED', `${provider.label} could not complete the connection. Try connecting again.`);
        }
        // The long-lived user token is the refresh credential. Page tokens are derived later, when posting exists.
        return { ...longToken, refreshToken: longToken.accessToken, scope: longToken.scope || shortToken.scope };
      }
      const fields = { grant_type: 'authorization_code', code, redirect_uri: provider.redirectUri };
      const headers = {};
      if (provider.pkce) fields.code_verifier = verifier;
      if (provider.tokenAuth === 'basic') {
        headers.authorization = basicAuth(provider.clientId, provider.clientSecret);
        if (provider.id === 'x') fields.client_id = provider.clientId;
      } else if (provider.tokenAuth === 'tiktok') {
        fields.client_key = provider.clientId;
        fields.client_secret = provider.clientSecret;
      } else {
        fields.client_id = provider.clientId;
        fields.client_secret = provider.clientSecret;
      }
      const { response, payload } = await postForm(provider.tokenUrl, fields, headers);
      const token = readToken(payload);
      if (token?.badType) throw new SocialOAuthError(502, 'TOKEN_TYPE_UNSUPPORTED', `${provider.label} returned an unsupported token type. Try connecting again.`);
      if (!response.ok || !token?.accessToken) {
        throw new SocialOAuthError(502, 'TOKEN_EXCHANGE_FAILED', `${provider.label} could not complete the connection. Check the app and the registered redirect URI.`);
      }
      return token;
    } catch (error) {
      if (error instanceof SocialOAuthError) throw error;
      throw new SocialOAuthError(502, 'TOKEN_EXCHANGE_FAILED', `${provider.label} could not complete the connection. Try connecting again.`);
    }
  }

  async function debugScopes(provider, accessToken) {
    try {
      const url = new URL(`${GRAPH}/debug_token`);
      url.searchParams.set('input_token', accessToken);
      url.searchParams.set('access_token', `${provider.clientId}|${provider.clientSecret}`);
      const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return { network: true };
      const payload = await response.json().catch(() => null);
      const data = isRecord(payload?.data) ? payload.data : null;
      if (!data || data.is_valid === false) return { invalid: true };
      return { scopes: scopeList(data.scopes) };
    } catch {
      return { network: true };
    }
  }

  async function grantedScopes(provider, token) {
    if (provider.kind === 'meta') {
      const debug = await debugScopes(provider, token.accessToken);
      if (debug.network) return { network: true };
      if (debug.invalid) return { invalid: true };
      if (!hasAll(debug.scopes || [], provider.scopes)) return { insufficient: true };
      return { scopes: [...provider.scopes] };
    }
    const granted = scopeList(token.scope);
    if (!granted.length) return { missing: true };
    if (!hasAll(granted, provider.scopes)) return { insufficient: true };
    return { scopes: [...provider.scopes] };
  }

  async function identify(provider, token) {
    if (provider.id === 'meta' || provider.id === 'instagram') {
      const me = await getJson(`${GRAPH}/me?fields=id,name`, token.accessToken);
      if (me.network) return { network: true };
      const pages = await getJson(`${GRAPH}/me/accounts?fields=id,name,instagram_business_account{id,username}&limit=25`, token.accessToken);
      if (pages.network) return { network: true };
      const list = Array.isArray(pages.payload?.data) ? pages.payload.data : [];
      if (provider.id === 'instagram') {
        for (const page of list) {
          const ig = page?.instagram_business_account;
          const accountId = cleanId(ig?.id);
          const accountLabel = cleanLabel(ig?.username);
          if (accountId && accountLabel) return { accountId, accountLabel };
        }
        return null;
      }
      if (list.length === 1) {
        const accountId = cleanId(list[0]?.id);
        const accountLabel = cleanLabel(list[0]?.name);
        if (accountId && accountLabel) return { accountId, accountLabel };
      }
      const accountId = cleanId(me.payload?.id);
      const accountLabel = cleanLabel(me.payload?.name);
      return accountId && accountLabel ? { accountId, accountLabel } : null;
    }
    if (provider.id === 'tiktok') {
      const info = await getJson('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', token.accessToken);
      if (info.network) return { network: true };
      const user = info.payload?.data?.user;
      const accountId = cleanId(user?.open_id) || cleanId(token.openId);
      const accountLabel = cleanLabel(user?.display_name) || accountId;
      return accountId && accountLabel ? { accountId, accountLabel } : null;
    }
    if (provider.id === 'x') {
      const me = await getJson('https://api.x.com/2/users/me?user.fields=username,name', token.accessToken);
      if (me.network) return { network: true };
      const data = me.payload?.data;
      const accountId = cleanId(data?.id);
      const accountLabel = cleanLabel(data?.username || data?.name);
      return accountId && accountLabel ? { accountId, accountLabel } : null;
    }
    if (provider.id === 'pinterest') {
      const me = await getJson('https://api.pinterest.com/v5/user_account', token.accessToken);
      if (me.network) return { network: true };
      const accountLabel = cleanLabel(me.payload?.username);
      const accountId = cleanId(me.payload?.username);
      return accountLabel ? { accountId, accountLabel } : null;
    }
    if (provider.id === 'youtube') {
      const channels = await getJson('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', token.accessToken);
      if (channels.network) return { network: true };
      const item = Array.isArray(channels.payload?.items) ? channels.payload.items[0] : null;
      const accountId = cleanId(item?.id);
      const accountLabel = cleanLabel(item?.snippet?.title);
      return accountId && accountLabel ? { accountId, accountLabel } : null;
    }
    return null;
  }

  /** Best effort. 200 or 400 (the provider already doesn't know the token) counts as revoked. Pinterest has no revoke call. */
  async function revokeToken(provider, token) {
    if (!token || !provider.credentialsConfigured || provider.id === 'pinterest') return false;
    try {
      if (provider.kind === 'meta') {
        const response = await fetchImpl(`${GRAPH}/me/permissions`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        return response.status === 200 || response.status === 400;
      }
      if (provider.id === 'tiktok') {
        const { response } = await postForm(provider.revokeUrl, { client_key: provider.clientId, client_secret: provider.clientSecret, token });
        return response.status === 200 || response.status === 400;
      }
      if (provider.id === 'x') {
        const { response } = await postForm(provider.revokeUrl, { token, token_type_hint: 'refresh_token' }, { authorization: basicAuth(provider.clientId, provider.clientSecret) });
        return response.status === 200 || response.status === 400;
      }
      const { response } = await postForm(provider.revokeUrl, { token });
      return response.status === 200 || response.status === 400;
    } catch {
      return false;
    }
  }

  function reconnectReason(provider, doc, unreadable) {
    if (unreadable) return 'unreadable';
    if (!isRecord(doc) || (!doc.accessToken && !doc.refreshToken && !doc.needsReconnect)) return null;
    if (doc.needsReconnect === 'revoked' || doc.needsReconnect === 'scopes') return doc.needsReconnect;
    if (!doc.refreshToken) return 'revoked';
    if (!hasAll(Array.isArray(doc.scopes) ? doc.scopes : [], provider.scopes)) return 'scopes';
    const refreshExp = Date.parse(doc.refreshExpiresAt);
    if (Number.isFinite(refreshExp) && refreshExp <= now()) return 'revoked';
    return null;
  }

  function viewOf(provider, doc, unreadable, user, projectId, statusStorageReady) {
    const reconnect = reconnectReason(provider, doc, unreadable);
    const connected = !unreadable && !reconnect && typeof doc.accessToken === 'string' && !!doc.accessToken && typeof doc.refreshToken === 'string' && !!doc.refreshToken;
    return {
      provider: provider.id,
      label: provider.label,
      credentialsConfigured: provider.credentialsConfigured,
      missingCredentials: user?.isAdmin === true ? [...provider.missingCredentials] : [],
      storageReady: statusStorageReady,
      connected,
      reconnect,
      scopes: connected && Array.isArray(doc.scopes) ? doc.scopes.filter((scope) => provider.scopes.includes(scope)) : [],
      accountLabel: !unreadable ? cleanLabel(doc.accountLabel) : '',
      accountId: !unreadable ? cleanId(doc.accountId) : '',
      projectId,
      owner: user?.isAdmin === true,
    };
  }

  async function readUser(userId) {
    if (!storageReady) return { value: {}, unreadable: false, storageReady: false };
    try {
      const doc = await readDocument(userDocumentKey(userId));
      return { ...doc, storageReady: true };
    } catch (error) {
      if (anyConfigured() && error?.code !== 'STORAGE_NOT_READY') throw error;
      return { value: {}, unreadable: false, storageReady: false };
    }
  }

  async function statusOne(user, provider, projectId) {
    const loaded = await readUser(user.id);
    const doc = loaded.unreadable ? {} : (businessesOf(loaded.value)[projectId]?.[provider.id] || {});
    return viewOf(provider, doc, loaded.unreadable, user, projectId, loaded.storageReady);
  }

  function authorizeUrl(provider, state, verifier) {
    const url = new URL(provider.authorizeUrl);
    url.searchParams.set(provider.clientIdParam, provider.clientId);
    url.searchParams.set('redirect_uri', provider.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', provider.scopes.join(provider.scopeJoin));
    url.searchParams.set('state', state);
    if (provider.pkce) {
      url.searchParams.set('code_challenge', codeChallenge(verifier, provider.pkce));
      url.searchParams.set('code_challenge_method', 'S256');
    }
    for (const [key, value] of Object.entries(provider.extraParams || {})) url.searchParams.set(key, value);
    return url;
  }

  async function connect(req, res, user, provider) {
    if (!provider.credentialsConfigured) throw notSetUp(provider, user);
    if (!storageReady) throw new SocialOAuthError(503, 'STORAGE_NOT_READY', `Secure ${provider.label} token storage is not configured. Check the Supabase server secret and app_state migration.`);
    if (req.headers.origin !== SOCIAL_OAUTH_PUBLIC_BASE_URL) {
      throw new SocialOAuthError(400, 'USE_PUBLISHED_APP', `Start the ${provider.label} connection from ${SOCIAL_OAUTH_PUBLIC_BASE_URL} so the callback returns to the same app.`);
    }
    let body = {};
    try {
      body = await readJson(req);
    } catch (error) {
      throw new SocialOAuthError(error?.status || 400, 'BAD_REQUEST', 'The request wasn’t valid JSON.');
    }
    const projectId = socialProjectId(body?.projectId);
    if (!projectId) throw new SocialOAuthError(400, 'PROJECT_REQUIRED', 'Which business? Open a business, then connect.');
    const nonce = bindingFrom(req, provider.cookieName, provider.signer) || provider.signer.sign('binding', crypto.randomBytes(32).toString('base64url'));
    const tag = pendingTag(user.id);
    const state = provider.signer.sign('state', `${crypto.randomBytes(32).toString('base64url')}.${tag}`);
    const verifier = provider.pkce ? crypto.randomBytes(32).toString('base64url') : '';
    const createdAt = now();
    const refused = await updateDocument(pendingKey(tag), (current) => {
      if (forgotten(current, createdAt)) return { write: false, result: true };
      const kept = Object.entries(isRecord(current.states) ? current.states : {})
        .filter(([, entry]) => isRecord(entry) && Number(entry.createdAt) > createdAt - STATE_TTL_MS)
        .sort((a, b) => Number(a[1].createdAt) - Number(b[1].createdAt))
        .slice(-(MAX_PENDING_PER_USER - 1));
      const states = Object.fromEntries(kept);
      states[sha256(state)] = {
        userId: user.id,
        projectId,
        provider: provider.id,
        createdAt,
        binding: sha256(nonce),
        ...(verifier ? { codeVerifier: verifier } : {}),
      };
      return { value: { states }, result: false };
    });
    if (refused) throw new SocialOAuthError(403, 'ACCOUNT_GONE', 'This account is being deleted, so a social account can’t be connected to it.');
    const url = authorizeUrl(provider, state, verifier);
    return reply(req, res, 200, { authorizationUrl: url.toString() }, { 'set-cookie': bindingCookie(provider, nonce, STATE_TTL_MS / 1000) });
  }

  function callbackRedirect(provider, res, outcome, headers = {}) {
    const target = new URL('/', `${SOCIAL_OAUTH_PUBLIC_BASE_URL}/`);
    target.searchParams.set('settings', 'accounts');
    target.searchParams.set('social_oauth', `${provider.id}.${outcome}`);
    target.hash = 'workspace-settings';
    res.writeHead(303, {
      location: target.toString(),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      ...headers,
    });
    res.end();
  }

  async function consumeState(provider, state, nonce) {
    const match = STATE_RE.exec(state);
    if (!match || !nonce || !provider.signer.verify('state', match[1], match[3])) return null;
    const hash = sha256(state);
    return updateDocument(pendingKey(match[2]), (current) => {
      const states = isRecord(current.states) ? current.states : {};
      const entry = states[hash];
      const age = now() - Number(entry?.createdAt);
      if (!isRecord(entry) || entry.provider !== provider.id || typeof entry.userId !== 'string' || !entry.userId) return { write: false, result: null };
      if (!(age <= STATE_TTL_MS) || entry.projectId !== socialProjectId(entry.projectId)) return { write: false, result: null };
      if (!matchesBinding(entry.binding, nonce)) return { write: false, result: null };
      if (provider.pkce && (typeof entry.codeVerifier !== 'string' || entry.codeVerifier.length < 43)) return { write: false, result: null };
      const rest = { ...states };
      delete rest[hash];
      return { value: { ...current, states: rest }, result: entry };
    });
  }

  async function callback(req, res, url, provider) {
    let done = {};
    let grant = null;
    try {
      if (rateLimited(`social-oauth-callback:${clientKey(req)}`)) return callbackRedirect(provider, res, 'busy');
      if (!storageReady) return callbackRedirect(provider, res, 'invalid_state');
      const entry = await consumeState(provider, url.searchParams.get('state') || '', bindingFrom(req, provider.cookieName, provider.signer));
      if (!entry) return callbackRedirect(provider, res, 'invalid_state');
      done = { 'set-cookie': bindingCookie(provider, '', 0) };
      if (url.searchParams.has('error')) {
        return callbackRedirect(provider, res, url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'error', done);
      }
      if (!provider.credentialsConfigured) return callbackRedirect(provider, res, 'setup', done);
      const code = url.searchParams.get('code') || '';
      if (!code || code.length > 2048) return callbackRedirect(provider, res, 'error', done);
      grant = await exchangeCode(provider, code, entry.codeVerifier || '');
      const scopes = await grantedScopes(provider, grant);
      const refreshToken = grant.refreshToken || '';
      if (scopes.network || scopes.invalid || scopes.missing) {
        await revokeToken(provider, refreshToken || grant.accessToken);
        return callbackRedirect(provider, res, 'error', done);
      }
      if (scopes.insufficient) {
        await revokeToken(provider, refreshToken || grant.accessToken);
        return callbackRedirect(provider, res, 'scopes', done);
      }
      if (!refreshToken) {
        await revokeToken(provider, grant.accessToken);
        return callbackRedirect(provider, res, 'error', done);
      }
      const who = await identify(provider, grant);
      if (who?.network) {
        await revokeToken(provider, refreshToken);
        return callbackRedirect(provider, res, 'error', done);
      }
      if (!who?.accountLabel) {
        await revokeToken(provider, refreshToken);
        return callbackRedirect(provider, res, 'identity', done);
      }
      const refreshExpiresAt = Number.isFinite(Number(grant.refreshExpiresIn)) && Number(grant.refreshExpiresIn) > 30
        ? iso(now() + ttlSeconds(grant.refreshExpiresIn, provider.defaultTtl) * 1000)
        : '';
      const connection = {
        accessToken: grant.accessToken,
        refreshToken,
        expiresAt: iso(now() + ttlSeconds(grant.expiresIn, provider.defaultTtl) * 1000),
        ...(refreshExpiresAt ? { refreshExpiresAt } : {}),
        scopes: scopes.scopes,
        accountLabel: who.accountLabel,
        accountId: who.accountId || '',
        connectedAt: iso(now()),
      };
      const stored = await updateDocument(userDocumentKey(entry.userId), (current) => {
        if (forgotten(current, now())) return { write: false, result: false };
        const businesses = businessesOf(current);
        const biz = { ...(businesses[entry.projectId] || {}) };
        biz[provider.id] = connection;
        businesses[entry.projectId] = biz;
        return { value: { ...current, businesses }, result: true };
      });
      if (!stored) {
        await revokeToken(provider, refreshToken);
        return callbackRedirect(provider, res, 'invalid_state', done);
      }
      return callbackRedirect(provider, res, 'connected', done);
    } catch {
      if (grant?.refreshToken || grant?.accessToken) await revokeToken(provider, grant.refreshToken || grant.accessToken);
      return callbackRedirect(provider, res, 'error', done);
    }
  }

  async function disconnect(req, res, user, provider, projectId) {
    if (!storageReady) throw new SocialOAuthError(503, 'STORAGE_NOT_READY', `Secure ${provider.label} token storage is not configured.`);
    let token = '';
    const outcome = await updateDocument(userDocumentKey(user.id), (current) => {
      if (forgotten(current, now())) return { write: false, result: 'gone' };
      const businesses = businessesOf(current);
      const biz = { ...(businesses[projectId] || {}) };
      const slot = isRecord(biz[provider.id]) ? biz[provider.id] : {};
      token = typeof slot.refreshToken === 'string' && slot.refreshToken ? slot.refreshToken : (typeof slot.accessToken === 'string' ? slot.accessToken : '');
      delete biz[provider.id];
      if (Object.keys(biz).length) businesses[projectId] = biz;
      else delete businesses[projectId];
      return { value: { ...current, businesses }, result: 'ok' };
    });
    const revoked = outcome === 'gone' ? false : await revokeToken(provider, token);
    return reply(req, res, 200, { connected: false, revoked });
  }

  async function refreshGrant(provider, refreshToken) {
    try {
      if (provider.kind === 'meta') {
        const { response, payload } = await postForm(provider.tokenUrl, {
          grant_type: 'fb_exchange_token',
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
          fb_exchange_token: refreshToken,
        });
        if (invalidGrant(response, payload)) return null;
        const token = readToken(payload);
        if (!response.ok || !token?.accessToken) {
          throw new SocialOAuthError(502, 'TOKEN_REFRESH_FAILED', `${provider.label} couldn’t refresh this connection. Connect it again if this keeps happening.`);
        }
        return { ...token, refreshToken: token.accessToken };
      }
      const fields = { grant_type: 'refresh_token', refresh_token: refreshToken };
      const headers = {};
      if (provider.tokenAuth === 'basic') {
        headers.authorization = basicAuth(provider.clientId, provider.clientSecret);
        if (provider.id === 'x') fields.client_id = provider.clientId;
      } else if (provider.tokenAuth === 'tiktok') {
        fields.client_key = provider.clientId;
        fields.client_secret = provider.clientSecret;
      } else {
        fields.client_id = provider.clientId;
        fields.client_secret = provider.clientSecret;
      }
      const { response, payload } = await postForm(provider.tokenUrl, fields, headers);
      if (invalidGrant(response, payload)) return null;
      const token = readToken(payload);
      if (!response.ok || !token?.accessToken) {
        throw new SocialOAuthError(502, 'TOKEN_REFRESH_FAILED', `${provider.label} couldn’t refresh this connection. Connect it again if this keeps happening.`);
      }
      return token;
    } catch (error) {
      if (error instanceof SocialOAuthError) throw error;
      throw new SocialOAuthError(502, 'SOCIAL_OAUTH_UNAVAILABLE', `Couldn’t reach ${provider.label} to refresh the connection. Nothing was posted. Try again shortly.`);
    }
  }

  async function markReconnect(userId, provider, projectId, refreshToken, reason) {
    await updateDocument(userDocumentKey(userId), (current) => {
      const businesses = businessesOf(current);
      const slot = businesses[projectId]?.[provider.id];
      if (!isRecord(slot) || slot.refreshToken !== refreshToken) return { write: false };
      const biz = { ...businesses[projectId] };
      biz[provider.id] = {
        needsReconnect: reason,
        markedAt: iso(now()),
        ...(cleanLabel(slot.accountLabel) ? { accountLabel: cleanLabel(slot.accountLabel) } : {}),
        ...(cleanId(slot.accountId) ? { accountId: cleanId(slot.accountId) } : {}),
      };
      businesses[projectId] = biz;
      return { value: { ...current, businesses } };
    });
  }

  function loadSlot(provider, doc, projectId) {
    const slot = businessesOf(doc)[projectId]?.[provider.id] || {};
    const reason = reconnectReason(provider, slot, false);
    if (reason) throw new SocialOAuthError(409, 'RECONNECT_REQUIRED', `${provider.label} needs to be connected again.`);
    if (typeof slot.refreshToken !== 'string' || !slot.refreshToken || typeof slot.accessToken !== 'string' || !slot.accessToken) {
      throw new SocialOAuthError(409, 'NOT_CONNECTED', `Connect ${provider.label} before posting.`);
    }
    return slot;
  }

  /**
   * A usable access token for a later posting helper. Refreshes when the access token is close to
   * expiry (or when force, after the network said 401). Not an HTTP route. Never log the return value.
   */
  async function accessTokenFor(userId, providerId, projectId, { force = false } = {}) {
    const provider = byId(providerId);
    if (!provider) throw new SocialOAuthError(404, 'NOT_FOUND', 'Unknown account type.');
    const id = socialProjectId(projectId);
    if (!id) throw new SocialOAuthError(400, 'PROJECT_REQUIRED', 'Which business?');
    if (!provider.credentialsConfigured) throw new SocialOAuthError(503, 'CREDENTIALS_NOT_CONFIGURED', `${provider.label} isn’t set up on this app yet.`);
    if (!storageReady) throw new SocialOAuthError(503, 'STORAGE_NOT_READY', `Secure ${provider.label} token storage is not configured.`);
    if (!userId) throw new SocialOAuthError(401, 'AUTH_REQUIRED', 'Sign in to use a connected social account.');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const loaded = await readDocument(userDocumentKey(userId));
      if (loaded.unreadable) throw new SocialOAuthError(409, 'RECONNECT_REQUIRED', `${provider.label} needs to be connected again.`);
      const doc = loadSlot(provider, loaded.value, id);
      if (!force && tokenFresh(doc, now())) return { accessToken: doc.accessToken, refreshToken: doc.refreshToken, accountLabel: doc.accountLabel, accountId: doc.accountId };
      const payload = await refreshGrant(provider, doc.refreshToken);
      if (!payload) {
        const again = await readDocument(userDocumentKey(userId));
        const latest = again.unreadable ? null : businessesOf(again.value)[id]?.[provider.id];
        if (latest && tokenFresh(latest, now())) return { accessToken: latest.accessToken, refreshToken: latest.refreshToken, accountLabel: latest.accountLabel, accountId: latest.accountId };
        await markReconnect(userId, provider, id, doc.refreshToken, 'revoked');
        throw new SocialOAuthError(409, 'RECONNECT_REQUIRED', `${provider.label} no longer accepts this connection. Connect it again.`);
      }
      if (typeof payload.scope === 'string' && payload.scope.trim() && !hasAll(scopeList(payload.scope), provider.scopes)) {
        await markReconnect(userId, provider, id, doc.refreshToken, 'scopes');
        throw new SocialOAuthError(409, 'SCOPE_REQUIRED', `${provider.label} didn’t grant permission to publish. Connect it again and allow publishing.`);
      }
      const refreshToken = typeof payload.refreshToken === 'string' && payload.refreshToken ? payload.refreshToken : doc.refreshToken;
      const expiresAt = iso(now() + ttlSeconds(payload.expiresIn, provider.defaultTtl) * 1000);
      const refreshExpiresAt = Number.isFinite(Number(payload.refreshExpiresIn)) && Number(payload.refreshExpiresIn) > 30
        ? iso(now() + ttlSeconds(payload.refreshExpiresIn, provider.defaultTtl) * 1000)
        : (refreshToken === doc.refreshToken ? doc.refreshExpiresAt || '' : '');
      const written = await updateDocument(userDocumentKey(userId), (current) => {
        if (forgotten(current, now())) return { write: false, result: null };
        const businesses = businessesOf(current);
        const slot = businesses[id]?.[provider.id];
        if (!isRecord(slot) || slot.refreshToken !== doc.refreshToken) return { write: false, result: 'retry' };
        const next = {
          ...slot,
          accessToken: payload.accessToken,
          refreshToken,
          expiresAt,
          ...(refreshExpiresAt ? { refreshExpiresAt } : {}),
        };
        if (!refreshExpiresAt) delete next.refreshExpiresAt;
        businesses[id] = { ...businesses[id], [provider.id]: next };
        return { value: { ...current, businesses }, result: { accessToken: payload.accessToken, refreshToken, accountLabel: slot.accountLabel, accountId: slot.accountId } };
      });
      if (written === 'retry') continue;
      if (!written?.accessToken) throw new SocialOAuthError(409, 'NOT_CONNECTED', `Connect ${provider.label} before posting.`);
      return written;
    }
    throw new SocialOAuthError(409, 'STORAGE_CONFLICT', `The ${provider.label} connection changed in another request. Try again.`);
  }

  async function projectIdFrom(req, url) {
    if (req.method === 'GET' || req.method === 'DELETE') return socialProjectId(url.searchParams.get('projectId'));
    try {
      const body = await readJson(req);
      return socialProjectId(body?.projectId);
    } catch (error) {
      throw new SocialOAuthError(error?.status || 400, 'BAD_REQUEST', 'The request wasn’t valid JSON.');
    }
  }

  async function handle(req, res, url) {
    const path = url.pathname;
    if (!match(url)) return false;
    const provider = providers.find((item) => path.startsWith(`/api/integrations/${item.id}/`)) || null;
    if (provider && path === `/api/integrations/${provider.id}/callback` && req.method === 'GET') return callback(req, res, url, provider);

    if (!sameOrigin(req)) return reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
    try {
      const user = await requireUser(req, res);
      if (!user) return true;
      if (path === '/api/integrations/social-oauth/status' && req.method === 'GET') {
        if (limited(req, res, `social-oauth-read:user:${user.id}`, 3)) return true;
        const projectId = socialProjectId(url.searchParams.get('projectId'));
        if (!projectId) throw new SocialOAuthError(400, 'PROJECT_REQUIRED', 'Which business? Open a business, then connect.');
        const accounts = [];
        for (const item of providers) accounts.push(await statusOne(user, item, projectId));
        return reply(req, res, 200, { projectId, storageReady: accounts[0]?.storageReady === true, owner: user.isAdmin === true, accounts });
      }
      if (!provider) return reply(req, res, 404, { error: 'Not found.', code: 'NOT_FOUND' });
      if (path === `/api/integrations/${provider.id}/status` && req.method === 'GET') {
        if (limited(req, res, `social-oauth-read:user:${user.id}`, 3)) return true;
        const projectId = socialProjectId(url.searchParams.get('projectId'));
        if (!projectId) throw new SocialOAuthError(400, 'PROJECT_REQUIRED', 'Which business? Open a business, then connect.');
        return reply(req, res, 200, await statusOne(user, provider, projectId));
      }
      if (path === `/api/integrations/${provider.id}/connect` && req.method === 'POST') {
        if (limited(req, res, `social-oauth-connect:user:${user.id}`)) return true;
        return await connect(req, res, user, provider);
      }
      if (path === `/api/integrations/${provider.id}/connection` && req.method === 'DELETE') {
        if (limited(req, res, `social-oauth-connect:user:${user.id}`)) return true;
        const projectId = await projectIdFrom(req, url);
        if (!projectId) throw new SocialOAuthError(400, 'PROJECT_REQUIRED', 'Which business? Open a business, then connect.');
        return await disconnect(req, res, user, provider, projectId);
      }
      return reply(req, res, 404, { error: 'Not found.', code: 'NOT_FOUND' });
    } catch (error) {
      if (res.headersSent) return true;
      const known = error instanceof SocialOAuthError;
      const statusCode = known ? error.status : 500;
      const message = known ? error.publicMessage : 'The social connection could not be completed. Try again shortly.';
      return reply(req, res, statusCode, { error: message, code: known ? error.code : 'SOCIAL_OAUTH_ERROR' });
    }
  }

  async function tokensIn(doc) {
    const found = [];
    for (const biz of Object.values(businessesOf(doc))) {
      for (const provider of providers) {
        const slot = biz[provider.id];
        if (!isRecord(slot)) continue;
        const token = typeof slot.refreshToken === 'string' && slot.refreshToken ? slot.refreshToken : (typeof slot.accessToken === 'string' ? slot.accessToken : '');
        if (token) found.push([provider, token]);
      }
    }
    return found;
  }

  async function forgetProject(userId, projectId) {
    if (!storageReady || !userId) return { removed: false };
    const id = socialProjectId(projectId);
    if (!id) return { removed: false };
    let pairs = [];
    try {
      const { value } = await readDocument(userDocumentKey(userId));
      const biz = businessesOf(value)[id] || {};
      pairs = providers.flatMap((provider) => {
        const slot = biz[provider.id];
        if (!isRecord(slot)) return [];
        const token = typeof slot.refreshToken === 'string' && slot.refreshToken ? slot.refreshToken : (typeof slot.accessToken === 'string' ? slot.accessToken : '');
        return token ? [[provider, token]] : [];
      });
    } catch {
      pairs = [];
    }
    for (const [provider, token] of pairs) await revokeToken(provider, token);
    const removed = await updateDocument(userDocumentKey(userId), (current) => {
      if (forgotten(current, now())) return { write: false, result: false };
      const businesses = businessesOf(current);
      if (!businesses[id]) return { write: false, result: false };
      delete businesses[id];
      return { value: { ...current, businesses }, result: true };
    }).catch((error) => {
      if (error?.code === 'STORAGE_NOT_READY' || error?.code === 'NO_TABLE') return false;
      throw error;
    });
    return { removed: removed === true };
  }

  async function forgetUser(userId) {
    if (!storageReady || !userId) return;
    let pairs = [];
    try {
      pairs = await tokensIn((await readDocument(userDocumentKey(userId))).value);
    } catch {
      pairs = [];
    }
    for (const [provider, token] of pairs) await revokeToken(provider, token);
    const tombstone = { forgottenAt: iso(now()) };
    try {
      await storage.put(userDocumentKey(userId), tombstone);
      await storage.put(pendingKey(pendingTag(userId)), { ...tombstone, states: {} });
    } catch (error) {
      if (error?.code === 'NO_TABLE' || !anyConfigured()) return;
      throw new SocialOAuthError(503, 'SOCIAL_OAUTH_FORGET_FAILED', 'Couldn’t remove your social connections just now, so your account wasn’t deleted. Try again shortly.');
    }
  }

  async function unforgetUser(userId) {
    if (!storageReady || !userId) return;
    const lift = (key, cleared) => updateDocument(key, (current) => (current.forgottenAt ? { value: cleared } : { write: false })).catch(() => {});
    await lift(userDocumentKey(userId), { businesses: {} });
    await lift(pendingKey(pendingTag(userId)), { states: {} });
  }

  return { handle, match, notes, forgetUser, unforgetUser, forgetProject, accessTokenFor, providers: byId };
}
