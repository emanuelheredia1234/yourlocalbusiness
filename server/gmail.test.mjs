import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGmailRoutes, buildRawMessage, GMAIL_PUBLIC_BASE_URL, GMAIL_REDIRECT_URI, GMAIL_SCOPES, BINDING_COOKIE } from './gmail.mjs';
import { createMockSupabase } from './test/mock-supabase.mjs';
import { createSecretBox } from './secretBox.mjs';

const API = '/api/integrations/gmail';
const COOKIE = BINDING_COOKIE;
const NOW = 1_800_000_000_000;
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const userKey = (id) => `gmail:user:${sha256(id)}`;
const SCOPES = GMAIL_SCOPES.join(' ');
const conflict = () => Object.assign(new Error('Conflict'), { code: 'CONFLICT' });

function makeStorage({ latencyMs = 0 } = {}) {
  const documents = new Map();
  const unreadable = new Set();
  const calls = [];
  const fail = { get: null, put: null };
  let version = 0;
  const pause = () => (latencyMs ? new Promise((resolve) => setTimeout(resolve, latencyMs)) : Promise.resolve());
  const failure = (which, key) => {
    const code = typeof fail[which] === 'function' ? fail[which](key) : fail[which];
    if (code) throw Object.assign(new Error(`storage ${which} failed`), { code });
  };
  return {
    enabled: true,
    documents,
    unreadable,
    calls,
    fail,
    async get(key) {
      calls.push({ op: 'get', key });
      await pause();
      failure('get', key);
      const row = documents.get(key);
      if (!row) return null;
      if (unreadable.has(key)) return { unreadable: true, value: null, updatedAt: row.updatedAt };
      return structuredClone(row);
    },
    async put(key, value, options = {}) {
      calls.push({ op: 'put', key, conditional: Object.hasOwn(options, 'ifVersion') });
      await pause();
      failure('put', key);
      const current = documents.get(key);
      if (Object.hasOwn(options, 'ifVersion')) {
        if (options.ifVersion === null && current) throw conflict();
        if (options.ifVersion !== null && current?.updatedAt !== options.ifVersion) throw conflict();
      }
      unreadable.delete(key);
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

const USERS = {
  'Bearer alpha': { id: 'account-alpha', email: 'alpha@example.com', isAdmin: false },
  'Bearer beta': { id: 'account-beta', email: 'beta@example.com', isAdmin: false },
  'Bearer owner': { id: 'account-owner', email: 'owner@example.com', isAdmin: true },
};

const CREDS = { GOOGLE_CLIENT_ID: 'client-id-test', GOOGLE_CLIENT_SECRET: 'client-secret-test' };

function makeService({ env, fetch = vi.fn(), storage = makeStorage(), rateLimited, auth, clock = { now: NOW } } = {}) {
  const service = createGmailRoutes({
    env: env || CREDS,
    storage,
    fetch,
    send,
    rateLimited,
    clientKey: (req) => req.socket?.remoteAddress || 'unknown',
    corsHeaders: (req) => (req.headers.origin === 'https://app.test' ? { 'access-control-allow-origin': 'https://app.test' } : {}),
    sameOrigin: (req) => !req.headers.origin || req.headers.origin === 'https://app.test' || req.headers.origin === GMAIL_PUBLIC_BASE_URL,
    auth: auth || {
      enabled: true,
      async identify(req) {
        const user = USERS[req.headers.authorization];
        return user || null;
      },
    },
    now: () => clock.now,
  });
  return { service, storage, fetch, clock };
}

async function call(service, method, pathname, { authorization = 'Bearer alpha', origin = 'https://app.test', body, cookie, headers = {} } = {}) {
  const req = {
    method,
    headers: { ...(authorization ? { authorization } : {}), ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...headers },
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
    jar,
    cookie: () => [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
    take(res) {
      for (const line of [].concat(res.headers?.['set-cookie'] || [])) {
        const [pair, ...attributes] = line.split(';');
        const at = pair.indexOf('=');
        const maxAge = attributes.map((a) => a.trim()).find((a) => /^max-age=/i.test(a));
        if (maxAge && Number(maxAge.split('=')[1]) <= 0) jar.delete(pair.slice(0, at).trim());
        else jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
      }
    },
  };
}

async function startConnect(service, b = browser(), authorization = 'Bearer alpha') {
  const res = await call(service, 'POST', `${API}/connect`, { authorization, origin: GMAIL_PUBLIC_BASE_URL, body: {}, cookie: b.cookie() });
  b.take(res);
  const state = res.body?.authorizationUrl ? new URL(res.body.authorizationUrl).searchParams.get('state') : null;
  return { res, state, browser: b };
}

async function backFromGoogle(service, state, { b = null, code = 'oauth-code', params = {} } = {}) {
  const query = new URLSearchParams({ ...(code ? { code } : {}), ...(state !== undefined ? { state } : {}), ...params });
  const res = makeResponse();
  await service.handle({ method: 'GET', headers: b?.cookie() ? { cookie: b.cookie() } : {}, socket: { remoteAddress: '198.51.100.4' } }, res, new URL(`${GMAIL_REDIRECT_URI}?${query}`));
  b?.take(res);
  return res;
}

const outcome = (res) => new URL(res.headers.location).searchParams.get('gmail');
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function googleFetch({ token, userinfo, send: sendImpl, revoke } = {}) {
  const log = [];
  const fn = vi.fn(async (url, options = {}) => {
    const u = String(url);
    const body = typeof options.body === 'string' ? options.body : '';
    if (u === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(body);
      log.push({ kind: 'token', grant: form.get('grant_type'), form });
      if (token) return token(form);
      if (form.get('grant_type') === 'refresh_token') return jsonResponse({ access_token: 'private-at-refreshed', token_type: 'Bearer', expires_in: 3600, scope: SCOPES });
      return jsonResponse({ access_token: `private-at-${form.get('code')}`, refresh_token: `private-rt-${form.get('code')}`, token_type: 'Bearer', expires_in: 3600, scope: SCOPES });
    }
    if (u === 'https://openidconnect.googleapis.com/v1/userinfo') {
      log.push({ kind: 'userinfo', authorization: options.headers?.authorization });
      if (userinfo) return userinfo(options);
      return jsonResponse({ sub: 'sub-ada', email: 'ada@gmail.com', email_verified: true });
    }
    if (u === 'https://oauth2.googleapis.com/revoke') {
      log.push({ kind: 'revoke', body });
      if (revoke) return revoke(body);
      return new Response('', { status: 200 });
    }
    if (u === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
      const parsed = JSON.parse(body);
      log.push({ kind: 'send', raw: parsed.raw, authorization: options.headers?.authorization });
      if (sendImpl) return sendImpl(parsed, options);
      return jsonResponse({ id: 'msg_1', threadId: 'thr_1' });
    }
    throw new Error(`Unexpected endpoint ${u}`);
  });
  fn.log = log;
  return fn;
}

function seed(storage, id = 'account-alpha', extra = {}) {
  storage.documents.set(userKey(id), {
    value: {
      accessToken: 'private-at-live',
      refreshToken: 'private-rt-live',
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
      scopes: [...GMAIL_SCOPES],
      email: 'ada@gmail.com',
      connectedAt: new Date(NOW).toISOString(),
      ...extra,
    },
    updatedAt: 'seed',
  });
}

const decodeRaw = (raw) => Buffer.from(raw, 'base64url').toString('utf8');

describe('the redirect and the scopes', () => {
  it('uses the published callback only, and only the send and mailbox-identity scopes', () => {
    expect(GMAIL_REDIRECT_URI).toBe('https://yourlocalbusiness.replit.app/api/integrations/gmail/callback');
    expect(GMAIL_SCOPES).toEqual(['https://www.googleapis.com/auth/gmail.send', 'openid', 'https://www.googleapis.com/auth/userinfo.email']);
    expect(GMAIL_SCOPES.join(' ')).not.toMatch(/gmail\.(readonly|modify|compose)|userinfo\.profile|\bprofile\b/);
  });
});

describe('connecting Gmail', () => {
  it('reports missing OAuth credentials and does not start authorization or crash', async () => {
    const { service, storage, fetch } = makeService({ env: {}, fetch: vi.fn() });
    const status = await call(service, 'GET', `${API}/status`, { authorization: 'Bearer owner' });
    expect(status.statusCode).toBe(200);
    expect(status.body.credentialsConfigured).toBe(false);
    expect(status.body.missingCredentials).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);

    const connect = await call(service, 'POST', `${API}/connect`, { authorization: 'Bearer owner', body: {}, origin: GMAIL_PUBLIC_BASE_URL });
    expect(connect.statusCode).toBe(503);
    expect(connect.body).toEqual({ code: 'CREDENTIALS_NOT_CONFIGURED', error: 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Replit Secrets (the Google OAuth web client).' });
    expect(connect.headers['set-cookie']).toBeUndefined();
    expect(storage.calls.filter((c) => c.op === 'put')).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(service.notes().join('\n')).toContain('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
    expect(service.notes().join('\n')).toContain(GMAIL_REDIRECT_URI);
  });

  it('names only the missing secret, and hides secret names from customers', async () => {
    for (const env of [{}, { GOOGLE_CLIENT_ID: 'client-id-test' }, { GOOGLE_CLIENT_SECRET: 'client-secret-test' }]) {
      const { service } = makeService({ env, fetch: vi.fn() });
      const status = await call(service, 'GET', `${API}/status`);
      expect(status.body).toMatchObject({ credentialsConfigured: false, missingCredentials: [], owner: false });
      const connect = await call(service, 'POST', `${API}/connect`, { body: {}, origin: GMAIL_PUBLIC_BASE_URL });
      expect(connect.statusCode).toBe(503);
      expect(connect.body.code).toBe('CREDENTIALS_NOT_CONFIGURED');
      expect(JSON.stringify([status.body, connect.body])).not.toMatch(/GOOGLE_|Secret/);
    }
    const { service } = makeService({ env: { GOOGLE_CLIENT_ID: 'client-id-test' }, fetch: vi.fn() });
    expect((await call(service, 'GET', `${API}/status`, { authorization: 'Bearer owner' })).body.missingCredentials).toEqual(['GOOGLE_CLIENT_SECRET']);
  });

  it('starts Google’s web flow on the published app, with offline access and no extra scope', async () => {
    const fetch = googleFetch();
    const { service } = makeService({ fetch });
    const { res: started, state, browser: b } = await startConnect(service);
    expect(started.statusCode).toBe(200);
    const authorization = new URL(started.body.authorizationUrl);
    expect(authorization.origin).toBe('https://accounts.google.com');
    expect(authorization.pathname).toBe('/o/oauth2/v2/auth');
    expect(authorization.searchParams.get('client_id')).toBe('client-id-test');
    expect(authorization.searchParams.get('redirect_uri')).toBe(GMAIL_REDIRECT_URI);
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.get('access_type')).toBe('offline');
    expect(authorization.searchParams.get('prompt')).toBe('consent');
    expect(authorization.searchParams.get('include_granted_scopes')).toBeNull();
    expect(authorization.searchParams.get('scope').split(' ').sort()).toEqual([...GMAIL_SCOPES].sort());
    expect(authorization.toString()).not.toContain('client-secret-test');
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(started.headers['set-cookie']).toMatch(new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{22}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax$`));
    expect(b.jar.get(COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}$/);
    expect(service.notes().join('\n')).toContain('Gmail outreach: on');
    expect(service.notes().join('\n')).not.toContain('client-secret-test');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses to start anywhere but the published app', async () => {
    const { service } = makeService({ fetch: vi.fn() });
    const connect = await call(service, 'POST', `${API}/connect`, { origin: 'https://app.test', body: {} });
    expect([connect.statusCode, connect.body.code]).toEqual([400, 'USE_PUBLISHED_APP']);
    const cross = await call(service, 'POST', `${API}/connect`, { origin: 'https://evil.example', body: {} });
    expect([cross.statusCode, cross.body.code]).toEqual([403, 'FORBIDDEN']);
  });

  it('exchanges the code, stores the mailbox per customer, and never returns the tokens', async () => {
    const fetch = googleFetch();
    const { service, storage } = makeService({ fetch });
    const { state, browser: b } = await startConnect(service);
    const back = await backFromGoogle(service, state, { b });
    expect(back.statusCode).toBe(303);
    expect(back.headers.location).toBe('https://yourlocalbusiness.replit.app/?settings=accounts&gmail=connected#workspace-settings');
    expect(back.headers['referrer-policy']).toBe('no-referrer');
    expect(back.headers['set-cookie']).toBe(`${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);

    const token = fetch.log.find((c) => c.kind === 'token').form;
    expect(token.get('grant_type')).toBe('authorization_code');
    expect(token.get('redirect_uri')).toBe(GMAIL_REDIRECT_URI);
    expect(token.get('client_secret')).toBe('client-secret-test');
    expect(fetch.log.some((c) => c.kind === 'userinfo')).toBe(true);

    const saved = storage.documents.get(userKey('account-alpha')).value;
    expect(saved).toMatchObject({ accessToken: 'private-at-oauth-code', refreshToken: 'private-rt-oauth-code', email: 'ada@gmail.com', scopes: GMAIL_SCOPES });
    expect(Date.parse(saved.expiresAt)).toBe(NOW + 3_600_000);

    const alpha = await call(service, 'GET', `${API}/status`);
    const beta = await call(service, 'GET', `${API}/status`, { authorization: 'Bearer beta' });
    expect(alpha.body).toMatchObject({ connected: true, reconnect: null, email: 'ada@gmail.com', scopes: [...GMAIL_SCOPES], owner: false });
    expect(beta.body.connected).toBe(false);
    expect(JSON.stringify([alpha.body, beta.body, back.headers])).not.toMatch(/private-at-|private-rt-|client-secret/);
  });

  it('refuses a callback the browser didn’t start, and a replay, and stores nothing for the other account', async () => {
    const fetch = googleFetch();
    const { service, storage } = makeService({ fetch });
    const { state, browser: b } = await startConnect(service, browser(), 'Bearer beta');
    const puts = storage.calls.filter((c) => c.op === 'put').length;
    expect(outcome(await backFromGoogle(service, state, { code: 'victim-code' }))).toBe('invalid_state');
    expect(fetch).not.toHaveBeenCalled();
    expect(storage.calls.filter((c) => c.op === 'put')).toHaveLength(puts);

    const first = await backFromGoogle(service, state, { b, code: 'beta-code' });
    expect(outcome(first)).toBe('connected');
    const cookie = `${COOKIE}=${b.jar.get(COOKIE) || ''}`;
    const replay = makeResponse();
    await service.handle({ method: 'GET', headers: { cookie: b.cookie() || cookie }, socket: {} }, replay, new URL(`${GMAIL_REDIRECT_URI}?code=beta-code&state=${encodeURIComponent(state)}`));
    expect(outcome(replay)).toBe('invalid_state');
    expect(fetch.log.filter((c) => c.kind === 'token')).toHaveLength(1);
    expect((await call(service, 'GET', `${API}/status`)).body.connected).toBe(false);
    expect((await call(service, 'GET', `${API}/status`, { authorization: 'Bearer beta' })).body.email).toBe('ada@gmail.com');
  });

  it('turns a denied consent into cancelled, and a missing send scope into scopes, without keeping the token', async () => {
    const fetch = googleFetch({
      token: (form) => jsonResponse({ access_token: `private-at-${form.get('code')}`, refresh_token: 'private-rt-x', token_type: 'Bearer', expires_in: 3600, scope: 'openid email' }),
    });
    const { service, storage } = makeService({ fetch });
    const denied = await startConnect(service);
    expect(outcome(await backFromGoogle(service, denied.state, { b: denied.browser, code: '', params: { error: 'access_denied' } }))).toBe('cancelled');
    expect(fetch).not.toHaveBeenCalled();

    const { state, browser: b } = await startConnect(service);
    expect(outcome(await backFromGoogle(service, state, { b, code: 'narrow' }))).toBe('scopes');
    expect(fetch.log.some((c) => c.kind === 'revoke')).toBe(true);
    expect(storage.documents.get(userKey('account-alpha'))?.value.accessToken).toBeUndefined();
    expect((await call(service, 'GET', `${API}/status`)).body.connected).toBe(false);
  });

  it('does not keep a grant when Google won’t name a verified mailbox', async () => {
    const fetch = googleFetch({ userinfo: () => jsonResponse({ email: 'ada@gmail.com', email_verified: false }) });
    const { service, storage } = makeService({ fetch });
    const { state, browser: b } = await startConnect(service);
    expect(outcome(await backFromGoogle(service, state, { b }))).toBe('identity');
    expect(fetch.log.some((c) => c.kind === 'revoke')).toBe(true);
    expect(storage.documents.get(userKey('account-alpha'))?.value.accessToken).toBeUndefined();
  });

  it('needs a sign-in, and a made-up state costs no storage read', async () => {
    const { service, storage } = makeService();
    expect((await call(service, 'GET', `${API}/status`, { authorization: '' })).body.code).toBe('AUTH_REQUIRED');
    const forged = `${crypto.randomBytes(32).toString('base64url')}.${'a'.repeat(22)}.${'b'.repeat(22)}`;
    storage.calls.length = 0;
    const res = await backFromGoogle(service, forged, { b: browser(), code: 'x' });
    expect(outcome(res)).toBe('invalid_state');
    expect(storage.calls.filter((c) => c.op === 'get')).toHaveLength(0);
  });
});

describe('disconnect, refresh and send', () => {
  it('revokes at Google and forgets the tokens, for this customer only', async () => {
    const fetch = googleFetch();
    const { service, storage } = makeService({ fetch });
    seed(storage);
    seed(storage, 'account-beta');
    const disconnected = await call(service, 'DELETE', `${API}/connection`);
    expect(disconnected.body).toEqual({ connected: false, revoked: true });
    expect(fetch.log.find((c) => c.kind === 'revoke').body).toContain('private-rt-live');
    expect(storage.documents.get(userKey('account-alpha')).value.accessToken).toBeUndefined();
    expect((await call(service, 'GET', `${API}/status`)).body.connected).toBe(false);
    expect((await call(service, 'GET', `${API}/status`, { authorization: 'Bearer beta' })).body).toMatchObject({ connected: true, email: 'ada@gmail.com' });
    expect(JSON.stringify(disconnected.body)).not.toContain('private-');
  });

  it('still forgets the connection when revoke fails', async () => {
    const fetch = vi.fn(async (url) => {
      if (String(url) === 'https://oauth2.googleapis.com/revoke') throw new TypeError('fetch failed');
      throw new Error(`Unexpected endpoint ${url}`);
    });
    const { service, storage } = makeService({ fetch });
    seed(storage);
    const disconnected = await call(service, 'DELETE', `${API}/connection`);
    expect(disconnected.body).toEqual({ connected: false, revoked: false });
    expect((await call(service, 'GET', `${API}/status`)).body.connected).toBe(false);
  });

  it('has no send route', async () => {
    const { service } = makeService();
    const sending = await call(service, 'POST', `${API}/send`, { body: { to: 'a@b.co', subject: 'Hi', text: 'Hello' } });
    expect([sending.statusCode, sending.body.code]).toEqual([404, 'SEND_NOT_AVAILABLE']);
  });

  it('sends once from the connected mailbox, and refreshes an expired access token first', async () => {
    const fetch = googleFetch();
    const { service, storage } = makeService({ fetch });
    seed(storage, 'account-alpha', { expiresAt: new Date(NOW + 10_000).toISOString() });
    const sent = await service.sendMail('account-alpha', { to: 'bob@example.com', subject: 'Hello', text: 'See you Tuesday.', from: 'attacker@evil.com', bcc: 'secret@evil.com' });
    expect(sent).toEqual({ id: 'msg_1', threadId: 'thr_1' });
    expect(fetch.log.map((c) => c.kind)).toEqual(['token', 'send']);
    expect(fetch.log[0].form.get('grant_type')).toBe('refresh_token');
    expect(fetch.log[0].form.get('refresh_token')).toBe('private-rt-live');
    const raw = decodeRaw(fetch.log[1].raw);
    expect(raw).toContain('From: ada@gmail.com\r\n');
    expect(raw).toContain('To: bob@example.com\r\n');
    expect(raw).toContain('Subject: Hello\r\n');
    expect(raw).not.toContain('attacker@evil.com');
    expect(raw).not.toContain('secret@evil.com');
    expect(raw).not.toContain('Bcc:');
    expect(fetch.log[1].authorization).toBe('Bearer private-at-refreshed');
    expect(storage.documents.get(userKey('account-alpha')).value.accessToken).toBe('private-at-refreshed');
  });

  it('does not call a refused connection a sent message', async () => {
    const fetch = googleFetch({ send: () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })) });
    const { service, storage } = makeService({ fetch });
    seed(storage);
    await expect(service.sendMail('account-alpha', { to: 'bob@example.com', subject: 'Hello', text: 'Hi' })).rejects.toMatchObject({ code: 'GMAIL_UNAVAILABLE' });
    expect(fetch.log.map((c) => c.kind)).toEqual(['send']);
  });

  it('does not refresh a token that is still fresh, and does not retry a lost send', async () => {
    const fetch = googleFetch({ send: () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')) });
    const { service, storage } = makeService({ fetch });
    seed(storage);
    await expect(service.sendMail('account-alpha', { to: 'bob@example.com', subject: 'Hello', text: 'Hi' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(fetch.log.map((c) => c.kind)).toEqual(['send']);
    expect(storage.documents.get(userKey('account-alpha')).value.accessToken).toBe('private-at-live');
  });

  it('rejects an injected subject before any Google call', async () => {
    const fetch = googleFetch();
    const { service, storage } = makeService({ fetch });
    seed(storage);
    await expect(service.sendMail('account-alpha', { to: 'bob@example.com', subject: 'Hi\r\nBcc: evil@example.com', text: 'Hello' })).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });
    await expect(service.sendMail('account-alpha', { to: 'not an email', subject: 'Hi', text: 'Hello' })).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('encodes a non-ascii subject and keeps the body out of the headers', () => {
    const raw = decodeRaw(buildRawMessage({ from: 'ada@gmail.com', to: 'bob@example.com', subject: 'Café', text: 'Line one\nLine two', at: NOW }));
    expect(raw).toContain('Subject: =?UTF-8?B?');
    expect(raw.split('\r\n\r\n')[0]).not.toContain('Line one');
    expect(Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Line one\r\nLine two');
  });

  it('asks the customer to connect again when Google has revoked the refresh token, and does not send', async () => {
    const fetch = googleFetch({ token: () => jsonResponse({ error: 'invalid_grant' }, 400) });
    const { service, storage } = makeService({ fetch });
    seed(storage, 'account-alpha', { expiresAt: new Date(NOW - 1000).toISOString() });
    await expect(service.sendMail('account-alpha', { to: 'bob@example.com', subject: 'Hello', text: 'Hi' })).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' });
    expect(fetch.log.map((c) => c.kind)).toEqual(['token']);
    expect((await call(service, 'GET', `${API}/status`)).body).toMatchObject({ connected: false, reconnect: 'revoked', email: 'ada@gmail.com' });
  });

  it('refreshes once after Gmail rejects the access token', async () => {
    const answers = [jsonResponse({ error: { status: 'UNAUTHENTICATED' } }, 401), jsonResponse({ id: 'msg_2', threadId: 'thr_2' })];
    const fetch = googleFetch({ send: () => answers.shift() });
    const { service, storage } = makeService({ fetch });
    seed(storage);
    const sent = await service.sendMail('account-alpha', { to: 'bob@example.com', subject: 'Hello', text: 'Hi' });
    expect(sent).toEqual({ id: 'msg_2', threadId: 'thr_2' });
    expect(fetch.log.map((c) => c.kind)).toEqual(['send', 'token', 'send']);
    expect(fetch.log[2].authorization).toBe('Bearer private-at-refreshed');
    expect(storage.documents.get(userKey('account-alpha')).value.accessToken).toBe('private-at-refreshed');
  });
});

describe('forgetting an account', () => {
  it('revokes, then overwrites the connection, and blocks deletion when storage is down and Gmail is set up', async () => {
    const fetch = googleFetch();
    const { service, storage } = makeService({ fetch });
    seed(storage);
    await service.forgetUser('account-alpha');
    expect(fetch.log.some((c) => c.kind === 'revoke')).toBe(true);
    expect(storage.documents.get(userKey('account-alpha')).value).toEqual({ forgottenAt: new Date(NOW).toISOString() });

    storage.fail.put = 'UNREACHABLE';
    await expect(service.forgetUser('account-beta')).rejects.toMatchObject({ code: 'GMAIL_FORGET_FAILED' });
  });

  it('does not block account deletion when Gmail was never set up', async () => {
    const { service, storage } = makeService({ env: {} });
    storage.fail.put = 'UNREACHABLE';
    await expect(service.forgetUser('account-alpha')).resolves.toBeUndefined();
  });

  it('drops a sign-in that finishes after the account was deleted', async () => {
    const fetch = googleFetch();
    const { service, storage } = makeService({ fetch });
    const { state, browser: b } = await startConnect(service);
    await service.forgetUser('account-alpha');
    expect(outcome(await backFromGoogle(service, state, { b, code: 'late' }))).toBe('invalid_state');
    expect(fetch.log.filter((c) => c.kind === 'token')).toHaveLength(0);
    expect(storage.documents.get(userKey('account-alpha')).value.accessToken).toBeUndefined();
    const again = await call(service, 'POST', `${API}/connect`, { origin: GMAIL_PUBLIC_BASE_URL, body: {} });
    expect([again.statusCode, again.body.code]).toEqual([403, 'ACCOUNT_GONE']);
  });
});

// ───────────── the real server ─────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = 'https://yourlocalbusiness.replit.app';

async function startServer(supa, extraEnv = {}) {
  const port = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-gmail-'));
  const log = path.join(dir, 'google-calls.jsonl');
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(here, 'test', 'mock-google.mjs')).href, path.join(here, 'ai-server.mjs')], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dir,
      SUPABASE_URL: supa.url,
      SUPABASE_PUBLISHABLE_KEY: supa.PUBLISHABLE,
      SUPABASE_SECRET_KEY: supa.SECRET,
      ADMIN_EMAILS: 'owner@example.com',
      GOOGLE_CLIENT_ID: 'fake-client-id',
      GOOGLE_CLIENT_SECRET: 'fake-client-secret',
      GOOGLE_MOCK_LOG: log,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server didn’t start: ${out}`)), 15_000);
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
    // "server on" is logged before the startup notes; wait until the Gmail line is actually in the pipe
    const check = () => (out.includes('Yourlocalbusiness server on') && out.includes('Gmail outreach:') ? (clearTimeout(timer), resolve()) : setTimeout(check, 25));
    check();
  });
  return {
    port,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
    output: () => out,
    stop: async () => {
      child.kill();
      await exited;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function request(port, method, pathname, { token, origin, body, cookie } = {}) {
  return new Promise((resolve) => {
    const headers = { host: 'yourlocalbusiness.replit.app' };
    if (origin) headers.origin = origin;
    if (token) headers.authorization = `Bearer ${token}`;
    if (cookie) headers.cookie = cookie;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.setTimeout(10_000, () => {
      req.destroy();
      resolve({ status: 'NO_ANSWER' });
    });
    req.on('error', (e) => resolve({ status: 'ERROR', error: e.code }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const returned = (res) => new URL(res.headers.location).searchParams.get('gmail');

describe('the real server', () => {
  let supa;
  beforeAll(async () => {
    supa = await (await createMockSupabase()).start();
  });
  afterAll(async () => {
    await supa?.close();
  });

  it('connects a signed-in customer through the documented callback and does not print the secret', async () => {
    const server = await startServer(supa);
    try {
      const { port } = server;
      expect(server.output()).toContain('Gmail outreach: on');
      expect(server.output()).toContain(GMAIL_REDIRECT_URI);
      expect(server.output()).not.toContain('fake-client-secret');
      const alice = await supa.tokenFor('gmail-alice@example.com');
      const start = await request(port, 'POST', `${API}/connect`, { token: alice.token, origin: APP, body: {} });
      expect(start.status).toBe(200);
      const authorization = new URL(start.json.authorizationUrl);
      expect(authorization.searchParams.get('redirect_uri')).toBe(GMAIL_REDIRECT_URI);
      expect(authorization.searchParams.get('scope').split(' ').sort()).toEqual([...GMAIL_SCOPES].sort());
      expect(start.json.authorizationUrl).not.toContain('fake-client-secret');
      const cookie = start.headers['set-cookie'][0].split(';')[0];
      const state = encodeURIComponent(authorization.searchParams.get('state'));
      const stranger = await request(port, 'GET', `${API}/callback?code=stranger-code&state=${state}`);
      expect([stranger.status, returned(stranger)]).toEqual([303, 'invalid_state']);
      expect(server.calls().filter((c) => c.kind === 'token')).toHaveLength(0);
      const back = await request(port, 'GET', `${API}/callback?code=alice-code&state=${state}`, { cookie });
      expect(back.status).toBe(303);
      expect(back.headers.location).toBe(`${APP}/?settings=accounts&gmail=connected#workspace-settings`);
      const status = await request(port, 'GET', `${API}/status`, { token: alice.token, origin: APP });
      expect(status.json).toMatchObject({ connected: true, email: 'ada@gmail.com', reconnect: null });
      expect(JSON.stringify(status.json)).not.toMatch(/fake-at-|fake-rt-/);
      const key = userKey(alice.user.id);
      const row = (supa.tables.get('app_state') ?? []).find((r) => r.key === key);
      const saved = JSON.parse(createSecretBox(supa.SECRET, 'ylb-app-state').open(row.ciphertext, `app_state:${key}`));
      expect(saved.accessToken).toBe('fake-at-alice-code');
      expect(saved.refreshToken).toBe('fake-rt-alice-code');
      const tokenCall = server.calls().find((c) => c.kind === 'token');
      expect(tokenCall).toMatchObject({ grant: 'authorization_code', redirect: GMAIL_REDIRECT_URI, hasSecret: true, code: 'alice-code' });
      expect(server.calls().some((c) => c.kind === 'userinfo')).toBe(true);

      const sending = await request(port, 'POST', `${API}/send`, { token: alice.token, origin: APP, body: {} });
      expect([sending.status, sending.json.code]).toEqual([404, 'SEND_NOT_AVAILABLE']);
      const off = await request(port, 'DELETE', `${API}/connection`, { token: alice.token, origin: APP });
      expect(off.json).toEqual({ connected: false, revoked: true });
      expect((await request(port, 'GET', `${API}/status`, { token: alice.token, origin: APP })).json.connected).toBe(false);
      expect(server.output()).not.toMatch(/fake-at-|fake-rt-|fake-client-secret/);
    } finally {
      await server.stop();
    }
  }, 30_000);

  it('stays up when the Google secrets are missing, and connect says so', async () => {
    const server = await startServer(supa, { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' });
    try {
      expect(server.output()).toContain('Gmail outreach: off');
      expect(server.output()).toContain('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
      expect(server.output()).toContain(GMAIL_REDIRECT_URI);
      const ada = await supa.tokenFor('gmail-ada@example.com');
      const connect = await request(server.port, 'POST', `${API}/connect`, { token: ada.token, origin: APP, body: {} });
      expect(connect.status).toBe(503);
      expect(connect.json.code).toBe('CREDENTIALS_NOT_CONFIGURED');
      const owner = await supa.tokenFor('owner@example.com');
      const status = await request(server.port, 'GET', `${API}/status`, { token: owner.token, origin: APP });
      expect(status.json.missingCredentials).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    } finally {
      await server.stop();
    }
  }, 30_000);

  it('forgets Gmail when the account is deleted, so a late callback stores nothing', async () => {
    const server = await startServer(supa);
    try {
      const bob = await supa.tokenFor('gmail-bob@example.com');
      const start = await request(server.port, 'POST', `${API}/connect`, { token: bob.token, origin: APP, body: {} });
      const cookie = start.headers['set-cookie'][0].split(';')[0];
      const state = encodeURIComponent(new URL(start.json.authorizationUrl).searchParams.get('state'));
      const deleted = await request(server.port, 'DELETE', '/api/account', { token: bob.token, origin: APP });
      expect(deleted.status).toBe(200);
      const late = await request(server.port, 'GET', `${API}/callback?code=bob-code&state=${state}`, { cookie });
      expect(returned(late)).toBe('invalid_state');
      expect(server.calls().filter((c) => c.kind === 'token').map((c) => c.code)).not.toContain('bob-code');
      const key = userKey(bob.user.id);
      const row = (supa.tables.get('app_state') ?? []).find((r) => r.key === key);
      expect(JSON.parse(createSecretBox(supa.SECRET, 'ylb-app-state').open(row.ciphertext, `app_state:${key}`))).toEqual({ forgottenAt: expect.any(String) });
    } finally {
      await server.stop();
    }
  }, 30_000);
});
