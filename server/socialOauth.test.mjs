// First-party social connect: one encrypted connection per business per network, CSRF state, PKCE where
// the provider requires it, refresh for a later poster, and no secret in a response. Nothing here
// reaches Meta, TikTok, X, Pinterest, or Google.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createSocialOAuthRoutes,
  SOCIAL_OAUTH_PROVIDERS,
  SOCIAL_OAUTH_PUBLIC_BASE_URL,
  SOCIAL_OAUTH_REDIRECTS,
  SOCIAL_OAUTH_SCOPES,
  socialProjectId,
  userDocumentKey,
} from './socialOauth.mjs';
import { createMockSupabase } from './test/mock-supabase.mjs';

const PUBLIC = SOCIAL_OAUTH_PUBLIC_BASE_URL;
const NOW = 1_800_000_000_000;
const CREDS = {
  META_APP_ID: 'meta-app-id',
  META_APP_SECRET: 'meta-app-secret-value',
  TIKTOK_CLIENT_KEY: 'tiktok-client-key',
  TIKTOK_CLIENT_SECRET: 'tiktok-client-secret-value',
  X_CLIENT_ID: 'x-client-id',
  X_CLIENT_SECRET: 'x-client-secret-value',
  PINTEREST_APP_ID: 'pin-app-id',
  PINTEREST_APP_SECRET: 'pin-app-secret-value',
  YOUTUBE_CLIENT_ID: 'yt-client-id',
  YOUTUBE_CLIENT_SECRET: 'yt-client-secret-value',
};
const SECRETS = Object.values(CREDS).filter((value) => value.includes('secret'));
const USERS = {
  'Bearer alpha': { id: 'account-alpha', email: 'alpha@example.com', isAdmin: false },
  'Bearer beta': { id: 'account-beta', email: 'beta@example.com', isAdmin: false },
  'Bearer owner': { id: 'account-owner', email: 'owner@example.com', isAdmin: true },
};
const SCOPE_STRING = SOCIAL_OAUTH_PROVIDERS.flatMap((provider) => [...provider.scopes]).join(' ');

function makeStorage() {
  const documents = new Map();
  const calls = [];
  let version = 0;
  return {
    enabled: true,
    documents,
    calls,
    async get(key) {
      calls.push({ op: 'get', key });
      const row = documents.get(key);
      return row ? structuredClone(row) : null;
    },
    async put(key, value, options = {}) {
      calls.push({ op: 'put', key });
      const current = documents.get(key);
      if (Object.hasOwn(options, 'ifVersion')) {
        if (options.ifVersion === null && current) throw Object.assign(new Error('Conflict'), { code: 'CONFLICT' });
        if (options.ifVersion !== null && current?.updatedAt !== options.ifVersion) throw Object.assign(new Error('Conflict'), { code: 'CONFLICT' });
      }
      const row = { value: structuredClone(value), updatedAt: String(++version) };
      documents.set(key, row);
      return row.updatedAt;
    },
  };
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    headersSent: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = { ...headers };
      this.headersSent = true;
      return this;
    },
    end(body) {
      this.body = body;
      this.ended = true;
      return this;
    },
  };
}

const send = (res, status, body, headers = {}) => {
  res.statusCode = status;
  res.headers = { ...headers };
  res.body = body;
  res.headersSent = true;
  res.ended = true;
  return res;
};

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function oauthFetch({ scopes = SCOPE_STRING, pages = 'both', tokenStatus = 200, refreshStatus = 200, refreshBody = null, identityStatus = 200 } = {}) {
  const log = [];
  const fn = vi.fn(async (url, options = {}) => {
    const u = String(url);
    const parsed = new URL(u);
    const body = typeof options.body === 'string' ? options.body : '';
    const form = new URLSearchParams(body);
    log.push({ host: parsed.host, path: parsed.pathname, grant: form.get('grant_type') || '', method: options.method || 'GET' });
    if (parsed.pathname.endsWith('/oauth/access_token') || parsed.pathname.endsWith('/token') || parsed.pathname.endsWith('/token/') || parsed.pathname.endsWith('/oauth/token')) {
      const grant = form.get('grant_type') || 'authorization_code';
      if (grant === 'refresh_token' || grant === 'fb_exchange_token') {
        if (refreshBody) return refreshBody(form);
        if (refreshStatus !== 200) return jsonResponse({ error: 'invalid_grant' }, refreshStatus);
        return jsonResponse({ access_token: 'private-at-refreshed', refresh_token: 'private-rt-refreshed', token_type: 'bearer', expires_in: 3600, scope: scopes });
      }
      if (tokenStatus !== 200) return jsonResponse({ error: 'invalid_client' }, tokenStatus);
      const code = form.get('code') || 'short';
      return jsonResponse({ access_token: `private-at-${code}`, refresh_token: `private-rt-${code}`, token_type: 'bearer', expires_in: 3600, refresh_expires_in: 5_000_000, scope: scopes, open_id: 'tt-open-1' });
    }
    if (parsed.pathname.endsWith('/debug_token')) {
      return jsonResponse({ data: { is_valid: true, scopes: scopes.split(/[\s,]+/) } });
    }
    if (identityStatus !== 200) return jsonResponse({ error: 'unavailable' }, identityStatus);
    if (parsed.pathname.endsWith('/me/accounts')) {
      if (pages === 'none') return jsonResponse({ data: [] });
      return jsonResponse({ data: [{ id: '222', name: 'Ada Page', instagram_business_account: pages === 'page' ? undefined : { id: '333', username: 'adabakery' } }] });
    }
    if (parsed.pathname.endsWith('/user/info/')) return jsonResponse({ data: { user: { open_id: 'tt-open-1', display_name: 'Ada TikTok' } } });
    if (parsed.pathname.endsWith('/users/me')) return jsonResponse({ data: { id: '999', name: 'Ada', username: 'ada' } });
    if (parsed.pathname.endsWith('/me')) return jsonResponse({ id: '111', name: 'Ada Bakery' });
    if (parsed.pathname.endsWith('/user_account')) return jsonResponse({ username: 'ada-pins' });
    if (parsed.pathname.endsWith('/channels')) return jsonResponse({ items: [{ id: 'UCchannel1', snippet: { title: 'Ada Channel' } }] });
    if (parsed.pathname.endsWith('/permissions') || parsed.pathname.endsWith('/revoke') || parsed.pathname.endsWith('/revoke/')) return jsonResponse({ ok: true });
    return jsonResponse({ error: 'unexpected' }, 500);
  });
  return { fetch: fn, log };
}

function makeService({ env = CREDS, fetch = oauthFetch().fetch, storage = makeStorage(), rateLimited = () => false, clock = { now: NOW } } = {}) {
  const service = createSocialOAuthRoutes({
    env,
    storage,
    fetch,
    send,
    readJson: async (req) => req.body ?? {},
    rateLimited,
    clientKey: (req) => req.socket?.remoteAddress || 'unknown',
    sameOrigin: (req) => !req.headers.origin || req.headers.origin === 'https://app.test' || req.headers.origin === PUBLIC,
    auth: {
      enabled: true,
      async identify(req) {
        return USERS[req.headers.authorization] || null;
      },
    },
    now: () => clock.now,
  });
  return { service, storage, fetch, clock };
}

async function call(service, method, pathname, { authorization = 'Bearer alpha', origin = 'https://app.test', body, cookie } = {}) {
  const req = {
    method,
    headers: { ...(authorization ? { authorization } : {}), ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
    body,
    socket: { remoteAddress: '203.0.113.7' },
  };
  const res = makeResponse();
  await service.handle(req, res, new URL(pathname, 'https://app.test'));
  return res;
}

function browser() {
  const jar = new Map();
  return {
    cookie: () => [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
    take(res) {
      for (const line of [].concat(res.headers?.['set-cookie'] || [])) {
        const [pair, ...attributes] = line.split(';');
        const at = pair.indexOf('=');
        const maxAge = attributes.map((part) => part.trim()).find((part) => /^max-age=/i.test(part));
        if (maxAge && Number(maxAge.split('=')[1]) <= 0) jar.delete(pair.slice(0, at).trim());
        else jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
      }
    },
  };
}

async function startConnect(service, providerId, { projectId = 'proj_bakery', authorization = 'Bearer alpha', b = browser() } = {}) {
  const res = await call(service, 'POST', `/api/integrations/${providerId}/connect`, { authorization, origin: PUBLIC, body: { projectId }, cookie: b.cookie() });
  b.take(res);
  const state = res.body?.authorizationUrl ? new URL(res.body.authorizationUrl).searchParams.get('state') : '';
  return { res, state, browser: b };
}

async function backFrom(service, providerId, state, { b, code = 'oauth-code', params = {} } = {}) {
  const query = new URLSearchParams({ ...(code ? { code } : {}), ...(state !== undefined ? { state } : {}), ...params });
  const res = makeResponse();
  await service.handle({ method: 'GET', headers: b?.cookie() ? { cookie: b.cookie() } : {}, socket: { remoteAddress: '198.51.100.4' } }, res, new URL(`${SOCIAL_OAUTH_REDIRECTS[providerId]}?${query}`));
  b?.take(res);
  return res;
}

const outcome = (res) => new URL(res.headers.location).searchParams.get('social_oauth');
const slot = (storage, userId, projectId, providerId) => storage.documents.get(userDocumentKey(userId))?.value?.businesses?.[projectId]?.[providerId];
const noSecrets = (value) => {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/private-at-|private-rt-/);
};

describe('callback URLs and scopes', () => {
  it('uses the live callback paths and the publish scopes, and keeps YouTube off the Gmail client', () => {
    expect(SOCIAL_OAUTH_REDIRECTS).toEqual({
      meta: 'https://yourlocalbusiness.replit.app/api/integrations/meta/callback',
      instagram: 'https://yourlocalbusiness.replit.app/api/integrations/instagram/callback',
      tiktok: 'https://yourlocalbusiness.replit.app/api/integrations/tiktok/callback',
      x: 'https://yourlocalbusiness.replit.app/api/integrations/x/callback',
      pinterest: 'https://yourlocalbusiness.replit.app/api/integrations/pinterest/callback',
      youtube: 'https://yourlocalbusiness.replit.app/api/integrations/youtube/callback',
    });
    expect(SOCIAL_OAUTH_SCOPES.meta).toEqual(['pages_show_list', 'pages_manage_posts', 'pages_read_engagement']);
    expect(SOCIAL_OAUTH_SCOPES.instagram).toEqual(['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement']);
    expect(SOCIAL_OAUTH_SCOPES.tiktok).toEqual(['user.info.basic', 'video.publish']);
    expect(SOCIAL_OAUTH_SCOPES.x).toEqual(['tweet.read', 'tweet.write', 'users.read', 'offline.access']);
    expect(SOCIAL_OAUTH_SCOPES.pinterest).toEqual(['boards:read', 'pins:write', 'user_accounts:read']);
    expect(SOCIAL_OAUTH_SCOPES.youtube).toEqual(['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly']);
    expect(SOCIAL_OAUTH_PROVIDERS.find((provider) => provider.id === 'instagram').secretNames).toEqual(['META_APP_ID', 'META_APP_SECRET']);
    expect(SOCIAL_OAUTH_PROVIDERS.find((provider) => provider.id === 'youtube').secretNames).toEqual(['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET']);
    expect(socialProjectId('proj_bakery')).toBe('proj_bakery');
    expect(socialProjectId('__proto__')).toBe('');
    expect(socialProjectId('../etc')).toBe('');
  });
});

describe('when a network is not set up', () => {
  it('says so without crashing, and does not treat the Gmail client as YouTube', async () => {
    const { service } = makeService({ env: { GOOGLE_CLIENT_ID: 'gmail-client', GOOGLE_CLIENT_SECRET: 'gmail-secret-value' } });
    const status = await call(service, 'GET', '/api/integrations/youtube/status?projectId=proj_bakery', { authorization: 'Bearer owner' });
    expect(status.statusCode).toBe(200);
    expect(status.body).toMatchObject({ credentialsConfigured: false, connected: false, missingCredentials: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'], owner: true });
    expect(JSON.stringify(status.body)).not.toContain('gmail-secret-value');
    const connect = await call(service, 'POST', '/api/integrations/youtube/connect', { authorization: 'Bearer owner', origin: PUBLIC, body: { projectId: 'proj_bakery' } });
    expect(connect.statusCode).toBe(503);
    expect(connect.body.code).toBe('CREDENTIALS_NOT_CONFIGURED');
    expect(connect.body.error).toContain('YOUTUBE_CLIENT_ID');
    const customer = await call(service, 'POST', '/api/integrations/meta/connect', { origin: PUBLIC, body: { projectId: 'proj_bakery' } });
    expect(customer.body).toMatchObject({ code: 'CREDENTIALS_NOT_CONFIGURED' });
    expect(customer.body.error).toBe('Facebook isn’t set up on this app yet.');
    expect(customer.body.error).not.toContain('META_APP');
  });

  it('asks a signed-out visitor to sign in', async () => {
    const { service } = makeService({ env: {} });
    const res = await call(service, 'GET', '/api/integrations/tiktok/status?projectId=proj_bakery', { authorization: '' });
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });
});

describe('connect, callback, and isolation', () => {
  it('builds each authorize URL with its callback, scopes, and PKCE only where that provider uses it', async () => {
    const { service, storage } = makeService();
    const pkce = { x: 'base64url', tiktok: 'hex', youtube: 'base64url' };
    for (const provider of SOCIAL_OAUTH_PROVIDERS) {
      const { res } = await startConnect(service, provider.id, { projectId: `proj_${provider.id}` });
      expect(res.statusCode).toBe(200);
      const url = new URL(res.body.authorizationUrl);
      expect(url.origin).toBe(provider.authorizeOrigin);
      expect(url.searchParams.get('redirect_uri')).toBe(provider.redirectUri);
      expect(url.searchParams.get('scope').split(provider.scopeJoin)).toEqual([...provider.scopes]);
      expect(url.searchParams.get(provider.clientIdParam)).toBe(provider.id === 'tiktok' ? CREDS.TIKTOK_CLIENT_KEY : provider.id === 'x' ? CREDS.X_CLIENT_ID : provider.id === 'pinterest' ? CREDS.PINTEREST_APP_ID : provider.id === 'youtube' ? CREDS.YOUTUBE_CLIENT_ID : CREDS.META_APP_ID);
      expect(res.body.authorizationUrl).not.toContain('secret-value');
      const entry = Object.values([...storage.documents.values()].find((row) => row.value?.states)?.value.states).at(-1);
      if (pkce[provider.id]) {
        const digest = crypto.createHash('sha256').update(entry.codeVerifier).digest(pkce[provider.id]);
        expect(url.searchParams.get('code_challenge')).toBe(digest);
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(res.body.authorizationUrl).not.toContain(entry.codeVerifier);
      } else {
        expect(url.searchParams.get('code_challenge')).toBeNull();
        expect(entry.codeVerifier).toBeUndefined();
      }
    }
    const youtube = new URL((await startConnect(service, 'youtube')).res.body.authorizationUrl);
    expect(youtube.searchParams.get('access_type')).toBe('offline');
    expect(youtube.searchParams.get('prompt')).toBe('consent');
    expect(youtube.searchParams.get('client_id')).toBe('yt-client-id');
  });

  it('stores the connection on that customer and that business, and never returns the token', async () => {
    const { fetch, log } = oauthFetch();
    const { service, storage } = makeService({ fetch });
    for (const provider of SOCIAL_OAUTH_PROVIDERS) {
      const started = await startConnect(service, provider.id, { projectId: 'proj_bakery' });
      const back = await backFrom(service, provider.id, started.state, { b: started.browser, code: `${provider.id}-code` });
      expect(back.statusCode).toBe(303);
      expect(outcome(back)).toBe(`${provider.id}.connected`);
      expect(back.headers.location).toBe(`${PUBLIC}/?settings=accounts&social_oauth=${provider.id}.connected#workspace-settings`);
      const saved = slot(storage, 'account-alpha', 'proj_bakery', provider.id);
      expect(saved.accessToken).toMatch(/^private-at-/);
      expect(saved.refreshToken).toMatch(/^private-/);
      expect(saved.scopes).toEqual([...provider.scopes]);
      expect(saved.accountLabel.length).toBeGreaterThan(0);
      const status = await call(service, 'GET', `/api/integrations/${provider.id}/status?projectId=proj_bakery`);
      expect(status.body).toMatchObject({ connected: true, provider: provider.id, projectId: 'proj_bakery', accountLabel: saved.accountLabel, scopes: [...provider.scopes] });
      noSecrets(status.body);
    }
    expect(slot(storage, 'account-alpha', 'proj_bakery', 'meta').accountLabel).toBe('Ada Page');
    expect(slot(storage, 'account-alpha', 'proj_bakery', 'instagram').accountLabel).toBe('adabakery');
    expect(slot(storage, 'account-alpha', 'proj_bakery', 'x').accountLabel).toBe('ada');
    expect(slot(storage, 'account-alpha', 'proj_bakery', 'tiktok').accountLabel).toBe('Ada TikTok');
    expect(slot(storage, 'account-alpha', 'proj_bakery', 'pinterest').accountLabel).toBe('ada-pins');
    expect(slot(storage, 'account-alpha', 'proj_bakery', 'youtube').accountLabel).toBe('Ada Channel');
    const other = await call(service, 'GET', '/api/integrations/social-oauth/status?projectId=proj_bakery', { authorization: 'Bearer beta' });
    expect(other.body.accounts.every((account) => account.connected === false)).toBe(true);
    noSecrets(other.body);
    expect(JSON.stringify(log)).not.toContain('secret-value');
    const bundle = await call(service, 'GET', '/api/integrations/social-oauth/status?projectId=proj_catering');
    expect(bundle.body.accounts.every((account) => account.connected === false)).toBe(true);
  });

  it('refuses a callback that is not the browser and state that started it', async () => {
    const { fetch, log } = oauthFetch();
    const { service } = makeService({ fetch });
    const started = await startConnect(service, 'x');
    const stranger = await backFrom(service, 'x', started.state, { code: 'stolen' });
    expect(outcome(stranger)).toBe('x.invalid_state');
    const swapped = await backFrom(service, 'instagram', started.state, { b: started.browser, code: 'swapped' });
    expect(outcome(swapped)).toBe('instagram.invalid_state');
    expect(log.some((entry) => entry.grant === 'authorization_code' || entry.path.endsWith('/token'))).toBe(false);
    const back = await backFrom(service, 'x', started.state, { b: started.browser, code: 'ok-code' });
    expect(outcome(back)).toBe('x.connected');
  });

  it('does not keep a connection that is missing publish permission or an account', async () => {
    const narrow = oauthFetch({ scopes: 'tweet.read' });
    const { service, storage } = makeService({ fetch: narrow.fetch });
    const started = await startConnect(service, 'x');
    const back = await backFrom(service, 'x', started.state, { b: started.browser });
    expect(outcome(back)).toBe('x.scopes');
    expect(slot(storage, 'account-alpha', 'proj_bakery', 'x')).toBeUndefined();
    expect(narrow.log.some((entry) => entry.path.endsWith('/revoke'))).toBe(true);

    const noPage = oauthFetch({ pages: 'none' });
    const ig = makeService({ fetch: noPage.fetch });
    const igStart = await startConnect(ig.service, 'instagram');
    const igBack = await backFrom(ig.service, 'instagram', igStart.state, { b: igStart.browser });
    expect(outcome(igBack)).toBe('instagram.identity');
    expect(slot(ig.storage, 'account-alpha', 'proj_bakery', 'instagram')).toBeUndefined();
  });

  it('needs a business, the published app, and a same-site request', async () => {
    const { service } = makeService();
    const missing = await call(service, 'POST', '/api/integrations/x/connect', { origin: PUBLIC, body: {} });
    expect(missing.body.code).toBe('PROJECT_REQUIRED');
    const local = await call(service, 'POST', '/api/integrations/x/connect', { origin: 'https://app.test', body: { projectId: 'proj_bakery' } });
    expect(local.body.code).toBe('USE_PUBLISHED_APP');
    const cross = await call(service, 'POST', '/api/integrations/x/connect', { origin: 'https://evil.example', body: { projectId: 'proj_bakery' } });
    expect(cross.statusCode).toBe(403);
    expect(cross.body.code).toBe('FORBIDDEN');
    const cancelled = await startConnect(service, 'pinterest');
    const back = await backFrom(service, 'pinterest', cancelled.state, { b: cancelled.browser, code: '', params: { error: 'access_denied' } });
    expect(outcome(back)).toBe('pinterest.cancelled');
  });
});

describe('refresh, disconnect, and deletion', () => {
  it('refreshes an expired token and keeps the new token off the status response', async () => {
    const { fetch, log } = oauthFetch();
    const clock = { now: NOW };
    const { service, storage } = makeService({ fetch, clock });
    const started = await startConnect(service, 'x');
    await backFrom(service, 'x', started.state, { b: started.browser, code: 'x-code' });
    expect(slot(storage, 'account-alpha', 'proj_bakery', 'x').accessToken).toBe('private-at-x-code');
    clock.now = NOW + 4_000_000;
    const token = await service.accessTokenFor('account-alpha', 'x', 'proj_bakery');
    expect(token.accessToken).toBe('private-at-refreshed');
    expect(slot(storage, 'account-alpha', 'proj_bakery', 'x')).toMatchObject({ accessToken: 'private-at-refreshed', refreshToken: 'private-rt-refreshed' });
    const status = await call(service, 'GET', '/api/integrations/x/status?projectId=proj_bakery');
    noSecrets(status.body);
    expect(log.some((entry) => entry.grant === 'refresh_token')).toBe(true);
  });

  it('asks for a new connection when the provider rejects the refresh token', async () => {
    const { fetch } = oauthFetch({ refreshStatus: 400 });
    const clock = { now: NOW };
    const { service } = makeService({ fetch, clock });
    const started = await startConnect(service, 'tiktok');
    await backFrom(service, 'tiktok', started.state, { b: started.browser, code: 'tt-code' });
    clock.now = NOW + 4_000_000;
    await expect(service.accessTokenFor('account-alpha', 'tiktok', 'proj_bakery')).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' });
    const status = await call(service, 'GET', '/api/integrations/tiktok/status?projectId=proj_bakery');
    expect(status.body).toMatchObject({ connected: false, reconnect: 'revoked', accountLabel: 'Ada TikTok' });
    noSecrets(status.body);
  });

  it('disconnects one network and forgets one business without touching the other', async () => {
    const { fetch, log } = oauthFetch();
    const { service, storage } = makeService({ fetch });
    for (const projectId of ['proj_bakery', 'proj_catering']) {
      const started = await startConnect(service, 'youtube', { projectId });
      await backFrom(service, 'youtube', started.state, { b: started.browser, code: projectId });
    }
    const x = await startConnect(service, 'x', { projectId: 'proj_bakery' });
    await backFrom(service, 'x', x.state, { b: x.browser, code: 'keep-x' });
    const removed = await call(service, 'DELETE', '/api/integrations/youtube/connection?projectId=proj_bakery');
    expect(removed.body).toEqual({ connected: false, revoked: true });
    expect(slot(storage, 'account-alpha', 'proj_bakery', 'youtube')).toBeUndefined();
    expect(slot(storage, 'account-alpha', 'proj_catering', 'youtube').accessToken).toBe('private-at-proj_catering');
    expect(slot(storage, 'account-alpha', 'proj_bakery', 'x').accessToken).toBe('private-at-keep-x');
    expect(log.some((entry) => entry.path.endsWith('/revoke'))).toBe(true);

    await service.forgetProject('account-alpha', 'proj_catering');
    expect(slot(storage, 'account-alpha', 'proj_catering', 'youtube')).toBeUndefined();
    expect(slot(storage, 'account-alpha', 'proj_bakery', 'x')).toBeTruthy();
    await service.forgetUser('account-alpha');
    expect(storage.documents.get(userDocumentKey('account-alpha')).value.forgottenAt).toEqual(expect.any(String));
    const again = await startConnect(service, 'x');
    expect(again.res.body.code).toBe('ACCOUNT_GONE');
  });

  it('limits connect bursts and does not print secret names’ values in the startup notes', () => {
    const { service } = makeService();
    const notes = service.notes().join('\n');
    expect(notes).toContain('https://yourlocalbusiness.replit.app/api/integrations/meta/callback');
    expect(notes).toContain('https://yourlocalbusiness.replit.app/api/integrations/instagram/callback');
    expect(notes).toContain('YOUTUBE_CLIENT_ID');
    expect(notes).not.toContain('secret-value');
    expect(notes).toContain('Posting still uses Upload-Post');
  });

  it('returns 429 when the connect limit is already spent', async () => {
    const rateLimited = vi.fn((key) => key.startsWith('social-oauth-connect:'));
    const { service } = makeService({ rateLimited });
    const res = await call(service, 'POST', '/api/integrations/meta/connect', { origin: PUBLIC, body: { projectId: 'proj_bakery' } });
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe('RATE_LIMIT');
  });
});

describe('the real server', () => {
  let supa;
  beforeAll(async () => {
    supa = await (await createMockSupabase()).start();
  });
  afterAll(async () => {
    await supa?.close();
  });

  it('answers the live callback prefix and does not print a client secret', async () => {
    const port = await new Promise((resolve) => {
      const probe = http.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address();
        probe.close(() => resolve(free));
      });
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-social-oauth-'));
    const here = path.dirname(fileURLToPath(import.meta.url));
    const child = spawn(process.execPath, [path.join(here, 'ai-server.mjs')], {
      env: {
        PATH: process.env.PATH,
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: dir,
        SUPABASE_URL: supa.url,
        SUPABASE_PUBLISHABLE_KEY: supa.PUBLISHABLE,
        SUPABASE_SECRET_KEY: supa.SECRET,
        ADMIN_EMAILS: 'owner@example.com',
        META_APP_ID: 'meta-app-id',
        META_APP_SECRET: 'meta-app-secret-value',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server didn’t start: ${out}`)), 20_000);
        child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
        const check = () => (out.includes('Direct social connect:') ? (clearTimeout(timer), resolve()) : setTimeout(check, 25));
        check();
      });
      expect(out).toContain('https://yourlocalbusiness.replit.app/api/integrations/instagram/callback');
      expect(out).not.toContain('meta-app-secret-value');
      const owner = await supa.tokenFor('owner@example.com');
      const status = await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/integrations/meta/status?projectId=proj_bakery', headers: { authorization: `Bearer ${owner.token}`, origin: PUBLIC, host: 'yourlocalbusiness.replit.app' } }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
        });
        req.end();
      });
      expect(status.status).toBe(200);
      expect(status.json).toMatchObject({ credentialsConfigured: true, connected: false, provider: 'meta' });
      expect(JSON.stringify(status.json)).not.toContain('meta-app-secret-value');
      const tiktok = await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/integrations/tiktok/connect', headers: { authorization: `Bearer ${owner.token}`, origin: PUBLIC, host: 'yourlocalbusiness.replit.app', 'content-type': 'application/json' } }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
        });
        req.write(JSON.stringify({ projectId: 'proj_bakery' }));
        req.end();
      });
      expect(tiktok.status).toBe(503);
      expect(tiktok.json.code).toBe('CREDENTIALS_NOT_CONFIGURED');
      expect(tiktok.json.error).not.toContain('meta-app-secret-value');
    } finally {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
