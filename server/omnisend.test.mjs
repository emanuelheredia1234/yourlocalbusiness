import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOmnisendRoutes, DRAFT_BODY_LIMIT, OMNISEND_PUBLIC_BASE_URL, OMNISEND_REDIRECT_URI, OMNISEND_SCOPES, REPORTS_PER_DAY } from './omnisend.mjs';
import { normalizeDoc } from '../shared/email/blocks.mjs';
import { docFromPlain } from '../shared/email/migrate.mjs';
import { renderEmail } from '../shared/email/render.mjs';
import { createMockSupabase } from './test/mock-supabase.mjs';
import { createSecretBox } from './secretBox.mjs';

const API = '/api/integrations/omnisend';
/** The cookie that ties Omnisend's callback to the browser that started the connection. */
const COOKIE = '__Host-ylb_omnisend';
/** The most a draft request may send (an email's block doc with its values and brand). */
const BODY_LIMIT = 256 * 1024;
/** The test Supabase project: its public-files bucket hosts each user's email images. */
const SUPABASE = 'https://sb.example.co';
const imageOf = (userId, name = 'e-AAAAAAAAAAAAAAAAAAAAAA.png') => `${SUPABASE}/storage/v1/object/public/public-files/${userId}/${name}`;
/** Each account's offers (P3), as server/offers' idsFor answers them. */
const OFFERS = { 'account-alpha': ['AlphaOfferAlphaOffer01', 'AlphaOfferAlphaOffer02'], 'account-beta': ['BetaOfferBetaOfferBe01'] };
const NOW = 1_800_000_000_000;
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const userKey = (id) => `omnisend:user:${sha256(id)}`;
const conflict = () => Object.assign(new Error('Conflict'), { code: 'CONFLICT' });

/** appState's contract: get → { value, updatedAt } (or { unreadable }), put with ifVersion compare-and-set. */
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

/** readJson as ai-server.mjs has it: (req, limit) → the body parsed; 413 over the limit, 400 when it isn't JSON. */
async function readJsonLike(req, limit) {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) throw new Error('readJson takes the request and a byte limit');
  const raw = req.rawBody ?? (req.body === undefined ? '' : JSON.stringify(req.body));
  if (Buffer.byteLength(raw) > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

const USERS = {
  'Bearer alpha': { id: 'account-alpha', email: 'alpha@example.com', isAdmin: false },
  'Bearer beta': { id: 'account-beta', email: 'beta@example.com', isAdmin: false },
  'Bearer owner': { id: 'account-owner', email: 'owner@example.com', isAdmin: true },
};

function makeService({ env, fetch = vi.fn(), storage = makeStorage(), rateLimited, auth, clock = { now: NOW }, offerIds = async (userId) => OFFERS[userId] ?? [], log = { log: vi.fn() } } = {}) {
  const readJson = vi.fn(readJsonLike);
  const service = createOmnisendRoutes({
    env: env || { OMNISEND_CLIENT_ID: 'client-id-test', OMNISEND_CLIENT_SECRET: 'client-secret-test', SUPABASE_URL: `${SUPABASE}/` },
    offerIds,
    log,
    storage,
    fetch,
    send,
    readJson,
    rateLimited,
    clientKey: (req) => req.socket?.remoteAddress || 'unknown',
    corsHeaders: (req) => (req.headers.origin === 'https://app.test' ? { 'access-control-allow-origin': 'https://app.test' } : {}),
    sameOrigin: (req) => !req.headers.origin || req.headers.origin === 'https://app.test' || req.headers.origin === OMNISEND_PUBLIC_BASE_URL,
    auth: auth || {
      enabled: true,
      async identify(req) {
        const user = USERS[req.headers.authorization];
        if (user) return user;
        const many = /^Bearer user-(\d+)$/.exec(req.headers.authorization || '');
        return many ? { id: `account-${many[1]}`, isAdmin: false } : null;
      },
    },
    now: () => clock.now,
  });
  return { service, storage, fetch, readJson, clock, log };
}

async function call(service, method, pathname, { authorization = 'Bearer alpha', origin = 'https://app.test', body, rawBody, cookie, headers = {} } = {}) {
  const req = {
    method,
    headers: { ...(authorization ? { authorization } : {}), ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body,
    rawBody,
    socket: { remoteAddress: '203.0.113.7' },
  };
  const res = makeResponse();
  await service.handle(req, res, new URL(pathname, 'https://app.test'));
  return res;
}

/** A browser: keeps the cookies the server sets (as one would for this host) and sends them back. */
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

/** Connect pressed in this browser on the published app: the state Omnisend will hand back. */
async function startConnect(service, b = browser(), authorization = 'Bearer alpha') {
  const res = await call(service, 'POST', `${API}/connect`, { authorization, origin: OMNISEND_PUBLIC_BASE_URL, body: {}, cookie: b.cookie() });
  b.take(res);
  const state = res.body?.authorizationUrl ? new URL(res.body.authorizationUrl).searchParams.get('state') : null;
  return { res, state, browser: b };
}

/** Omnisend sends a browser back to the callback (a top-level navigation: no sign-in header). */
async function backFromOmnisend(service, state, { b = null, code = 'oauth-code', params = {} } = {}) {
  const query = new URLSearchParams({ ...(code ? { code } : {}), ...(state !== undefined ? { state } : {}), ...params });
  const res = makeResponse();
  await service.handle({ method: 'GET', headers: b?.cookie() ? { cookie: b.cookie() } : {}, socket: { remoteAddress: '198.51.100.4' } }, res, new URL(`${OMNISEND_REDIRECT_URI}?${query}`));
  b?.take(res);
  return res;
}

const outcome = (res) => new URL(res.headers.location).searchParams.get('omnisend');
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** Omnisend's token endpoint and API, answered here; every call is kept in .log. */
function omnisendFetch({ token, template, campaign } = {}) {
  const log = [];
  const fn = vi.fn(async (url, options = {}) => {
    const u = String(url);
    if (u === 'https://app.omnisend.com/oauth2/token') {
      const form = new URLSearchParams(options.body);
      log.push({ kind: 'token', form });
      if (token) return token(form);
      return jsonResponse({ access_token: `private-at-${form.get('code')}`, refresh_token: `private-rt-${form.get('code')}`, token_type: 'Bearer', scope: OMNISEND_SCOPES.join(' ') });
    }
    if (u === 'https://api.omnisend.com/api/email-templates/import') {
      const body = JSON.parse(options.body);
      log.push({ kind: 'template', body, headers: options.headers });
      return template ? template(body) : jsonResponse({ id: 'a'.repeat(24) }, 201);
    }
    if (u === 'https://api.omnisend.com/api/campaigns') {
      const body = JSON.parse(options.body);
      log.push({ kind: 'campaign', body, headers: options.headers });
      return campaign ? campaign(body) : jsonResponse({ id: 'b'.repeat(24), name: body.name, status: 'draft', url: `https://app.omnisend.com/campaigns/${'b'.repeat(24)}/settings` }, 201);
    }
    throw new Error(`Unexpected endpoint ${u}`);
  });
  fn.log = log;
  return fn;
}

/** A connected account (the whole flow, in one browser). */
async function connected(service, authorization = 'Bearer alpha', code = 'oauth-code') {
  const { state, browser: b } = await startConnect(service, browser(), authorization);
  const back = await backFromOmnisend(service, state, { b, code });
  expect(outcome(back)).toBe('connected');
}

const DRAFT = { name: 'Copper & Comb — Email 1', subject: 'Your guide is inside', preheader: 'Start with page one.', body: 'Hi [First name],\n\nHere it is.', ctaLabel: 'Download your free guide', ctaUrl: 'https://copperandcomb.com/free' };

// ───────────── connecting ─────────────

describe('connecting Omnisend', () => {
  it('reports missing OAuth credentials and does not start authorization', async () => {
    const { service, storage } = makeService({ env: {}, fetch: vi.fn() });
    const status = await call(service, 'GET', `${API}/status`, { authorization: 'Bearer owner' });
    expect(status.statusCode).toBe(200);
    expect(status.body.credentialsConfigured).toBe(false);
    expect(status.body.missingCredentials).toEqual(['OMNISEND_CLIENT_ID', 'OMNISEND_CLIENT_SECRET']);

    const connect = await call(service, 'POST', `${API}/connect`, { authorization: 'Bearer owner', body: {}, origin: OMNISEND_PUBLIC_BASE_URL });
    expect(connect.statusCode).toBe(503);
    expect(connect.body).toEqual({ code: 'CREDENTIALS_NOT_CONFIGURED', error: 'Add OMNISEND_CLIENT_ID and OMNISEND_CLIENT_SECRET in Replit Secrets after Omnisend issues them.' });
    expect(connect.headers['set-cookie']).toBeUndefined();
    expect(storage.calls.filter((c) => c.op === 'put')).toHaveLength(0);
  });

  it('tells customers who aren’t the owner only that Omnisend isn’t set up: no Secret names', async () => {
    for (const env of [{}, { OMNISEND_CLIENT_ID: 'client-id-test' }, { OMNISEND_CLIENT_SECRET: 'client-secret-test' }]) {
      const { service } = makeService({ env, fetch: vi.fn() });
      const status = await call(service, 'GET', `${API}/status`);
      expect(status.body).toMatchObject({ credentialsConfigured: false, missingCredentials: [], owner: false });
      const connect = await call(service, 'POST', `${API}/connect`, { body: {}, origin: OMNISEND_PUBLIC_BASE_URL });
      const draft = await call(service, 'POST', `${API}/campaign-drafts`, { body: DRAFT });
      for (const res of [connect, draft]) {
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({ code: 'CREDENTIALS_NOT_CONFIGURED', error: 'Omnisend isn’t set up on this app yet.' });
      }
      expect(JSON.stringify([status.body, connect.body, draft.body])).not.toMatch(/OMNISEND_|Secret/);
    }
    // the owner still sees exactly which one is missing
    const { service } = makeService({ env: { OMNISEND_CLIENT_ID: 'client-id-test' }, fetch: vi.fn() });
    expect((await call(service, 'GET', `${API}/status`, { authorization: 'Bearer owner' })).body.missingCredentials).toEqual(['OMNISEND_CLIENT_SECRET']);
  });

  it('ties the state to the account and this browser, exchanges the code at the registered callback, and hides tokens', async () => {
    const fetch = omnisendFetch();
    const { service } = makeService({ fetch });
    const { res: started, state, browser: b } = await startConnect(service);
    expect(started.statusCode).toBe(200);
    const authorization = new URL(started.body.authorizationUrl);
    expect(authorization.origin).toBe('https://app.omnisend.com');
    expect(authorization.searchParams.get('redirect_uri')).toBe(OMNISEND_REDIRECT_URI);
    expect(authorization.searchParams.get('scope').split(' ').sort()).toEqual([...OMNISEND_SCOPES].sort());
    // random, its owner's document tag, and the server's MAC of both
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    // the binding cookie: random, HTTPS-only, out of scripts' reach, sent on Omnisend's redirect back, ten minutes
    expect(started.headers['set-cookie']).toMatch(new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{22}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax$`));
    expect(b.jar.get(COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}$/);

    const back = await backFromOmnisend(service, state, { b });
    expect(back.statusCode).toBe(303);
    expect(back.headers.location).toBe('https://yourlocalbusiness.replit.app/?omnisend=connected#marketing-email');
    expect(back.headers['referrer-policy']).toBe('no-referrer');
    // used up: the cookie goes
    expect(back.headers['set-cookie']).toBe(`${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
    expect(b.jar.has(COOKIE)).toBe(false);

    const token = fetch.log.find((c) => c.kind === 'token').form;
    expect(token.get('redirect_uri')).toBe(OMNISEND_REDIRECT_URI);
    expect(token.get('client_secret')).toBe('client-secret-test');
    expect(token.get('grant_type')).toBe('authorization_code');

    const alphaStatus = await call(service, 'GET', `${API}/status`);
    const betaStatus = await call(service, 'GET', `${API}/status`, { authorization: 'Bearer beta' });
    expect(alphaStatus.body).toMatchObject({ connected: true, reconnect: null, scopes: OMNISEND_SCOPES });
    expect(betaStatus.body.connected).toBe(false);
    expect(JSON.stringify([started, back, alphaStatus].map((r) => [r.body, r.headers]))).not.toContain('private-');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a callback in a browser that didn’t start the connection, and stores nothing', async () => {
    const fetch = omnisendFetch();
    const { service, storage } = makeService({ fetch });
    // beta starts a connection (from a script, say) and sends the Omnisend link to someone else
    const { state, browser: betas } = await startConnect(service, browser(), 'Bearer beta');
    const puts = storage.calls.filter((c) => c.op === 'put').length;

    // their browser comes back from Omnisend with their code: no cookie, or a cookie of its own
    const victim = browser();
    expect(outcome(await backFromOmnisend(service, state, { b: victim, code: 'victim-code' }))).toBe('invalid_state');
    victim.jar.set(COOKIE, crypto.randomBytes(32).toString('base64url'));
    expect(outcome(await backFromOmnisend(service, state, { b: victim, code: 'victim-code' }))).toBe('invalid_state');

    expect(fetch).not.toHaveBeenCalled();
    expect(storage.calls.filter((c) => c.op === 'put')).toHaveLength(puts);
    expect(storage.documents.has(userKey('account-beta'))).toBe(false);
    expect((await call(service, 'GET', `${API}/status`, { authorization: 'Bearer beta' })).body.connected).toBe(false);
    // a refused callback leaves the browser's own cookie alone
    expect(victim.jar.has(COOKIE)).toBe(true);
    // the state is still beta's own, in beta's own browser
    expect(outcome(await backFromOmnisend(service, state, { b: betas, code: 'beta-code' }))).toBe('connected');
  });

  it('uses a started connection once, disconnects only one account, and never exposes sending', async () => {
    const fetch = omnisendFetch();
    const { service } = makeService({ fetch });
    const { state, browser: b } = await startConnect(service);
    const cookie = b.cookie();
    const first = await backFromOmnisend(service, state, { b });
    // the same callback again, cookie and all
    const replay = makeResponse();
    await service.handle({ method: 'GET', headers: { cookie }, socket: {} }, replay, new URL(`${OMNISEND_REDIRECT_URI}?code=oauth-code&state=${encodeURIComponent(state)}`));
    expect(outcome(first)).toBe('connected');
    expect(outcome(replay)).toBe('invalid_state');
    expect(fetch).toHaveBeenCalledTimes(1);

    await connected(service, 'Bearer beta', 'beta-code');
    const disconnected = await call(service, 'DELETE', `${API}/connection`);
    expect(disconnected.body.connected).toBe(false);
    expect((await call(service, 'GET', `${API}/status`)).body.connected).toBe(false);
    expect((await call(service, 'GET', `${API}/status`, { authorization: 'Bearer beta' })).body.connected).toBe(true);
    const sending = await call(service, 'POST', `${API}/send`, { body: {} });
    expect(sending.statusCode).toBe(404);
    expect(sending.body.code).toBe('SEND_NOT_AVAILABLE');
  });

  it('keeps a connection started in another tab of the same browser', async () => {
    const { service } = makeService({ fetch: omnisendFetch() });
    const b = browser();
    const first = await startConnect(service, b);
    const value = b.jar.get(COOKIE);
    const second = await startConnect(service, b);
    // the second Connect keeps this browser's value (and starts its ten minutes again)
    expect(b.jar.get(COOKIE)).toBe(value);
    expect(second.state).not.toBe(first.state);
    expect(outcome(await backFromOmnisend(service, first.state, { b }))).toBe('connected');
  });

  it('turns every other return into a fixed outcome, never reflecting what came back', async () => {
    const tokenAnswers = [jsonResponse({ error: 'invalid_grant' }, 400), jsonResponse({ access_token: 'private-at-x', token_type: 'mac' })];
    const fetch = omnisendFetch({ token: () => tokenAnswers.shift() ?? jsonResponse({ access_token: 'private-at-y', token_type: 'Bearer', scope: 'campaigns.write' }) });
    const { service, clock, storage } = makeService({ fetch });
    const run = async (params, { code = 'oauth-code', later = 0 } = {}) => {
      const { state, browser: b } = await startConnect(service);
      clock.now += later;
      const res = await backFromOmnisend(service, state, { b, code, params });
      clock.now = NOW;
      return res;
    };
    const denied = await run({ error: 'access_denied', error_description: '<script>alert(1)</script>', redirect_uri: 'https://evil.example' }, { code: '' });
    expect(outcome(denied)).toBe('cancelled');
    expect(denied.headers.location).not.toMatch(/script|evil/);
    expect(outcome(await run({ error: 'server_error' }, { code: '' }))).toBe('error');
    expect(outcome(await run({}, { later: 10 * 60 * 1000 + 1 }))).toBe('invalid_state');
    expect(outcome(await run({}, { code: '' }))).toBe('error');
    expect(outcome(await run({}, { code: 'c'.repeat(3000) }))).toBe('error');
    expect(fetch).not.toHaveBeenCalled();
    expect(outcome(await run({}))).toBe('error'); // the exchange was refused
    expect(outcome(await run({}))).toBe('error'); // not a Bearer token
    // a grant without both permissions isn't kept: the account is asked to connect again
    expect(outcome(await run({}))).toBe('scopes');
    expect(storage.documents.get(userKey('account-alpha')).value).toEqual({ needsReconnect: 'scopes', markedAt: new Date(NOW).toISOString() });
    expect((await call(service, 'GET', `${API}/status`)).body).toMatchObject({ connected: false, reconnect: 'scopes' });
    expect(outcome(await backFromOmnisend(service, '"><script>', { code: 'x' }))).toBe('invalid_state');
  });
});

// ───────────── started connections: per account, read one at a time, limited ─────────────

describe('connections waiting for Omnisend', () => {
  it('can’t be pushed out by another account starting many connections', async () => {
    const { service, storage } = makeService({ fetch: omnisendFetch() });
    const { state, browser: b } = await startConnect(service);
    for (let i = 0; i < 501; i += 1) {
      const res = await call(service, 'POST', `${API}/connect`, { authorization: 'Bearer beta', origin: OMNISEND_PUBLIC_BASE_URL, body: {} });
      expect(res.statusCode).toBe(200);
    }
    expect(outcome(await backFromOmnisend(service, state, { b }))).toBe('connected');
    // beta's own document holds only its newest three
    const betas = [...storage.documents.entries()].filter(([key]) => key.startsWith('omnisend:oauth:pending:')).map(([, row]) => Object.keys(row.value.states).length);
    expect(betas.sort()).toEqual([0, 3]);
  });

  it('keeps an account’s newest three', async () => {
    const { service } = makeService({ fetch: omnisendFetch() });
    const b = browser();
    const states = [];
    for (let i = 0; i < 4; i += 1) states.push((await startConnect(service, b)).state);
    expect(outcome(await backFromOmnisend(service, states[0], { b }))).toBe('invalid_state');
    expect(outcome(await backFromOmnisend(service, states[3], { b }))).toBe('connected');
  });

  it('are read one small document at a time, and a malformed or made-up state or cookie reads nothing', async () => {
    const { service, storage } = makeService({ fetch: omnisendFetch() });
    const { state: betaState } = await startConnect(service, browser(), 'Bearer beta');
    const { browser: mine } = await startConnect(service);
    storage.calls.length = 0;
    const random = () => crypto.randomBytes(32).toString('base64url');
    const tag = crypto.randomBytes(16).toString('base64url').slice(0, 22);
    const mac = () => crypto.randomBytes(16).toString('base64url').slice(0, 22);
    // a cookie this server made, with states that are malformed or made up (a guessed MAC)
    for (const bad of ['', 'x', 'a'.repeat(300), `${random()}.${tag}`, `${'a'.repeat(43)}.${'b'.repeat(21)}.${mac()}`, `${random()}.${tag}.${mac()}`, `${betaState.slice(0, -22)}${mac()}`, `${betaState}x`]) {
      expect(outcome(await backFromOmnisend(service, bad, { b: mine }))).toBe('invalid_state');
    }
    expect(storage.calls).toHaveLength(0);
    // a real state, with a made-up cookie of the right form, another form, or none: nothing is read either
    for (const cookie of [`${random()}.${mac()}`, random(), null]) {
      const b = browser();
      if (cookie) b.jar.set(COOKIE, cookie);
      expect(outcome(await backFromOmnisend(service, betaState, { b }))).toBe('invalid_state');
    }
    expect(storage.calls).toHaveLength(0);
    // both real, but not the same browser's: only the state's owner's small document is read
    expect(outcome(await backFromOmnisend(service, betaState, { b: mine }))).toBe('invalid_state');
    expect(storage.calls).toEqual([{ op: 'get', key: `omnisend:oauth:pending:${betaState.split('.')[1]}` }]);
    expect([...storage.documents.keys()].some((key) => key === 'omnisend:oauth:states')).toBe(false);
  });

  it('turn away a cookie or state made with another client secret', async () => {
    const fetch = omnisendFetch();
    const storage = makeStorage();
    const before = makeService({ fetch, storage, env: { OMNISEND_CLIENT_ID: 'client-id-test', OMNISEND_CLIENT_SECRET: 'old-secret' } }).service;
    const { state, browser: b } = await startConnect(before);
    const after = makeService({ fetch, storage }).service;
    storage.calls.length = 0;
    expect(outcome(await backFromOmnisend(after, state, { b }))).toBe('invalid_state');
    expect(storage.calls).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    // and a fresh start in the same browser works with the new one
    const again = await startConnect(after, b);
    expect(outcome(await backFromOmnisend(after, again.state, { b }))).toBe('connected');
  });

  it('don’t conflict when different accounts connect at the same time', async () => {
    const { service } = makeService({ fetch: omnisendFetch(), storage: makeStorage({ latencyMs: 1 }) });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => call(service, 'POST', `${API}/connect`, { authorization: `Bearer user-${i}`, origin: OMNISEND_PUBLIC_BASE_URL, body: {} })),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array(12).fill(200));
  });

  it('are rate limited: connecting and drafts per account, the callback per caller', async () => {
    const limitedKeys = new Set();
    const rateLimited = vi.fn((key) => limitedKeys.has(key));
    const fetch = omnisendFetch();
    const { service, storage } = makeService({ fetch, rateLimited });
    await connected(service);
    expect(rateLimited).toHaveBeenCalledWith('omnisend-connect:user:account-alpha', 1);
    expect(rateLimited).toHaveBeenCalledWith('omnisend-callback:198.51.100.4');

    limitedKeys.add('omnisend-connect:user:account-alpha');
    limitedKeys.add('omnisend-drafts:user:account-alpha');
    limitedKeys.add('omnisend-callback:198.51.100.4');
    storage.calls.length = 0;
    const connect = await call(service, 'POST', `${API}/connect`, { origin: OMNISEND_PUBLIC_BASE_URL, body: {} });
    expect([connect.statusCode, connect.body.code]).toEqual([429, 'RATE_LIMIT']);
    const draft = await call(service, 'POST', `${API}/campaign-drafts`, { body: DRAFT });
    expect([draft.statusCode, draft.body.code]).toEqual([429, 'RATE_LIMIT']);
    const b = browser();
    b.jar.set(COOKIE, crypto.randomBytes(32).toString('base64url'));
    expect(outcome(await backFromOmnisend(service, `${crypto.randomBytes(32).toString('base64url')}.${'a'.repeat(22)}`, { b }))).toBe('busy');
    expect(storage.calls).toHaveLength(0);
    expect(fetch.log.filter((c) => c.kind !== 'token')).toHaveLength(0);
    // another account isn't held back
    expect((await call(service, 'POST', `${API}/connect`, { authorization: 'Bearer beta', origin: OMNISEND_PUBLIC_BASE_URL, body: {} })).statusCode).toBe(200);
  });

  it('refuses cross-site requests before changing anything, and starts only on the published app', async () => {
    const { service, storage } = makeService();
    const crossSite = await call(service, 'POST', `${API}/connect`, { body: {}, origin: 'https://attacker.test' });
    expect(crossSite.statusCode).toBe(403);
    const elsewhere = await call(service, 'POST', `${API}/connect`, { body: {} });
    expect(elsewhere.statusCode).toBe(400);
    expect(elsewhere.body.code).toBe('USE_PUBLISHED_APP');
    expect(storage.documents.size).toBe(0);
  });
});

// ───────────── campaign drafts ─────────────

describe('campaign drafts', () => {
  it('creates an email template and campaign draft only with the requesting account’s token', async () => {
    const fetch = omnisendFetch();
    const { service } = makeService({ fetch });
    await connected(service);
    const draft = await call(service, 'POST', `${API}/campaign-drafts`, {
      body: { ...DRAFT, subject: '<script>alert(1)</script>', body: 'Hello <script>bad()</script>\n\nThanks\nThe team' },
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.body.campaign).toEqual({ id: 'b'.repeat(24), name: DRAFT.name, status: 'draft', url: `https://app.omnisend.com/campaigns/${'b'.repeat(24)}/settings` });
    expect(draft.headers['access-control-allow-origin']).toBe('https://app.test');
    expect(JSON.stringify(draft.body)).not.toContain('private-');
    const [, template, campaign] = fetch.log;
    expect(fetch.log.map((c) => c.kind)).toEqual(['token', 'template', 'campaign']);
    for (const c of [template, campaign]) {
      expect(c.headers.authorization).toBe('Bearer private-at-oauth-code');
      expect(c.headers['omnisend-version']).toBe('2026-03-15');
    }
    const html = template.body.html;
    // the plain-text shape (older tabs) is made a doc and rendered here, as a designed email
    const expected = renderEmail(docFromPlain({ id: 'draft', body: 'Hello <script>bad()</script>\n\nThanks\nThe team', ctaLabel: DRAFT.ctaLabel, ctaUrl: DRAFT.ctaUrl }), { target: 'omnisend', subject: '<script>alert(1)</script>', preheader: DRAFT.preheader, brand: {}, values: { first_name: '[First name]' }, links: {}, footerNote: '', iconBase: '' }).html;
    expect(html).toBe(expected);
    expect(html).toMatch(/<p style="[^"]*">Hello &lt;script&gt;bad\(\)&lt;\/script&gt;<\/p>/);
    expect(html).toContain('Thanks<br>The team');
    expect(html).not.toContain('<script');
    expect(html).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    // the subject is the subject: the email doesn't repeat it in the body
    expect(html).not.toMatch(/<h1/);
    expect(html).toMatch(/<a href="https:\/\/copperandcomb\.com\/free" target="_blank" rel="noopener" style="display:inline-block;[^"]*">Download your free guide<\/a>/);
    expect(html).toContain('<v:roundrect');
    expect(campaign.body).toEqual({ channel: 'email', type: 'regular', name: DRAFT.name, language: 'en_US', content: { email: { templateID: 'a'.repeat(24), subject: '<script>alert(1)</script>', preheader: DRAFT.preheader } } });

    const betaDraft = await call(service, 'POST', `${API}/campaign-drafts`, { authorization: 'Bearer beta', body: DRAFT });
    expect(betaDraft.statusCode).toBe(409);
    expect(betaDraft.body.code).toBe('NOT_CONNECTED');
    expect(fetch.log).toHaveLength(3);
  });

  it('puts the unsubscribe link Omnisend requires in every imported template', async () => {
    const fetch = omnisendFetch();
    const { service } = makeService({ fetch });
    await connected(service);
    await call(service, 'POST', `${API}/campaign-drafts`, { body: { subject: 'Hello', body: 'Just text, no button.' } });
    const html = fetch.log.find((c) => c.kind === 'template').body.html;
    expect(html.split('[[unsubscribe_link]]')).toHaveLength(2);
    expect(html).toMatch(/<p style="[^"]*">You’re receiving this because you signed up\.<\/p><p style="[^"]*"><a href="\[\[unsubscribe_link\]\]" style="[^"]*">Unsubscribe<\/a><\/p><\/td>\n<\/tr>\n<\/table>/);
    expect(html).not.toContain('<a href="http');
  });

  it('reads the body with a small limit and answers 413 or 400', async () => {
    const fetch = omnisendFetch();
    const { service, readJson } = makeService({ fetch });
    await connected(service);
    const big = await call(service, 'POST', `${API}/campaign-drafts`, { rawBody: JSON.stringify({ ...DRAFT, pad: 'x'.repeat(BODY_LIMIT) }) });
    expect([big.statusCode, big.body.code]).toEqual([413, 'TOO_LARGE']);
    expect(readJson).toHaveBeenCalledWith(expect.anything(), BODY_LIMIT);
    // a body declared too large isn't read at all, and the connection closes after the answer
    readJson.mockClear();
    const declared = await call(service, 'POST', `${API}/campaign-drafts`, { body: DRAFT, headers: { 'content-length': String(40 * 1024 * 1024) } });
    expect([declared.statusCode, declared.body.code, declared.headers.connection]).toEqual([413, 'TOO_LARGE', 'close']);
    expect(readJson).not.toHaveBeenCalled();
    for (const rawBody of ['null', 'false', '0', '""', '[]', 'not json']) {
      const res = await call(service, 'POST', `${API}/campaign-drafts`, { rawBody });
      expect(res.statusCode).toBe(400);
      expect(['INVALID_DRAFT', 'BAD_REQUEST']).toContain(res.body.code);
    }
    expect(fetch.log.filter((c) => c.kind !== 'token')).toHaveLength(0);
  });

  it('refuses a button without a web address instead of leaving it out', async () => {
    const fetch = omnisendFetch();
    const { service } = makeService({ fetch });
    await connected(service);
    for (const ctaUrl of ['{{product_link}}', '[link to your offer]', 'javascript:alert(1)', 'https://user:pass@example.com/', '']) {
      const res = await call(service, 'POST', `${API}/campaign-drafts`, { body: { ...DRAFT, ctaUrl } });
      expect([res.statusCode, res.body.code]).toEqual([400, 'INVALID_CTA']);
    }
    expect(fetch.log.filter((c) => c.kind !== 'token')).toHaveLength(0);
    // a link without a label: the preview shows no button, and neither does the draft
    const noLabel = await call(service, 'POST', `${API}/campaign-drafts`, { body: { ...DRAFT, ctaLabel: '' } });
    expect(noLabel.statusCode).toBe(201);
    expect(fetch.log.find((c) => c.kind === 'template').body.html).not.toContain('copperandcomb.com');
  });

  it('refuses fields over their limits instead of cutting them, and shortens only the campaign name', async () => {
    const fetch = omnisendFetch();
    const { service } = makeService({ fetch });
    await connected(service);
    const tooLong = { subject: 'S'.repeat(251), preheader: 'P'.repeat(251), body: 'B'.repeat(24_001), ctaLabel: 'L'.repeat(101), ctaUrl: `https://example.com/${'u'.repeat(2048)}` };
    for (const [field, value] of Object.entries(tooLong)) {
      const res = await call(service, 'POST', `${API}/campaign-drafts`, { body: { ...DRAFT, [field]: value } });
      expect([res.statusCode, res.body.code]).toEqual([400, 'INVALID_DRAFT']);
    }
    // exactly at the limit is fine, counted as Omnisend does (an emoji is one character)
    const atLimit = await call(service, 'POST', `${API}/campaign-drafts`, { body: { ...DRAFT, subject: `${'S'.repeat(249)}😀`, name: `${'N'.repeat(300)}` } });
    expect(atLimit.statusCode).toBe(201);
    const campaign = fetch.log.find((c) => c.kind === 'campaign').body;
    expect(campaign.content.email.subject).toBe(`${'S'.repeat(249)}😀`);
    expect(campaign.name).toBe('N'.repeat(250));
    expect([...fetch.log.find((c) => c.kind === 'template').body.name].length).toBeLessThanOrEqual(255);
  });
});

// ───────────── designed emails (P5): the server renders what Omnisend gets ─────────────

describe('designed email drafts', () => {
  const ALPHA_OFFER = OFFERS['account-alpha'][0];
  const BETA_OFFER = OFFERS['account-beta'][0];
  const VALUES = { first_name: '[First name]', lead_magnet_link: 'https://yourlocalbusiness.replit.app/m/AAAAAAAAAAAAAAAAAAAAAA', product_link: 'https://copperandcomb.com/guide', sender_name: 'Maya' };
  const BRAND = { name: 'Copper & Comb', colors: { primary: '#7a1f5c', accent: '#e0a526', ink: '#1d2420', paper: '#ffffff' } };
  const DOC = {
    v: 1,
    theme: { id: 'brand' },
    blocks: [
      { type: 'heading', text: 'Welcome, {{first_name}}', level: 1 },
      { type: 'text', text: 'Here is **your guide**: [open it]({{lead_magnet_link}}).' },
      { type: 'image', src: imageOf('account-alpha'), alt: 'The guide', width: 'full', origin: 'upload' },
      { type: 'button', label: 'Get the course', link: { kind: 'offer', offerId: ALPHA_OFFER } },
    ],
  };
  const designed = (o = {}) => ({ name: 'Welcome', subject: 'Your guide', preheader: 'Page one', doc: DOC, values: VALUES, brand: BRAND, footerNote: 'You signed up at copperandcomb.com.', ...o });
  const draftWith = async (body, authorization = 'Bearer alpha') => {
    const fetch = omnisendFetch();
    const made = makeService({ fetch });
    await connected(made.service, authorization);
    const res = await call(made.service, 'POST', `${API}/campaign-drafts`, { body, authorization });
    const template = fetch.log.find((c) => c.kind === 'template');
    return { ...made, res, html: template?.body.html ?? null, calls: fetch.log.filter((c) => c.kind !== 'token').map((c) => c.kind) };
  };

  it('imports the HTML the shared renderer makes from the doc, with the buy link this server resolves', async () => {
    const { res, html, calls } = await draftWith(designed({ links: { [`buy:${ALPHA_OFFER}`]: 'https://evil.example/pay' } }));
    expect(res.statusCode).toBe(201);
    expect(calls).toEqual(['template', 'campaign']);
    const expected = renderEmail(normalizeDoc(DOC).doc, { target: 'omnisend', subject: 'Your guide', preheader: 'Page one', brand: BRAND, values: VALUES, links: { [`buy:${ALPHA_OFFER}`]: `https://yourlocalbusiness.replit.app/b/${ALPHA_OFFER}` }, footerNote: 'You signed up at copperandcomb.com.', iconBase: '' }).html;
    expect(html).toBe(expected);
    expect(html).toContain(`href="https://yourlocalbusiness.replit.app/b/${ALPHA_OFFER}"`);
    // a client-sent link is never used
    expect(html).not.toContain('evil.example');
    expect(html.split('[[unsubscribe_link]]')).toHaveLength(2);
    // the brand's colours, inline
    expect(html).toContain('bgcolor="#7a1f5c"');
    expect(html).toContain('Welcome, &#91;First name&#93;');
  });

  it('re-sanitizes custom blocks: no script, handler, javascript: or iframe reaches Omnisend', async () => {
    const evil = { v: 1, blocks: [{ type: 'custom', html: '<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)" onclick="x()">x</a><iframe src="https://evil.example"></iframe><p style="background:url(https://track.example/p.gif)">[[unsubscribe_link]]</p><img src="https://track.example/pixel.gif" alt=""><!--[if mso]><script>x</script><![endif]-->', css: '@import url(https://evil.example/x.css); p{color:red}' }] };
    const { res, html } = await draftWith(designed({ doc: evil }));
    expect(res.statusCode).toBe(201);
    expect(html).not.toMatch(/<script|<iframe/i);
    expect(html).not.toMatch(/<[^>]*\son\w+=/i);
    expect(html).not.toMatch(/javascript:|track\.example|evil\.example|@import/i);
    expect(html.split('[[unsubscribe_link]]')).toHaveLength(2);
  });

  it('a merge value can’t add CSS through a custom block’s style (no remote pixel past IMAGE_NOT_HOSTED)', async () => {
    const doc = { v: 1, blocks: [{ type: 'custom', html: '<p style="font-family:{{first_name}}">Hi</p>' }] };
    const { res, html } = await draftWith(designed({ doc, values: { ...VALUES, first_name: 'x;background-image:url(https://track.example/p.gif)' } }));
    expect(res.statusCode).toBe(201);
    expect(html).not.toContain('url(');
    expect(html).not.toContain('track.example');
  });

  it('buy links: the caller’s own offers only (UNKNOWN_BUY_LINK otherwise, nothing made in Omnisend)', async () => {
    for (const doc of [
      { v: 1, blocks: [{ type: 'button', label: 'Buy', link: { kind: 'offer', offerId: BETA_OFFER } }] },
      { v: 1, blocks: [{ type: 'text', text: `Buy here: {{buy:${BETA_OFFER}}}` }] },
      { v: 1, blocks: [{ type: 'offer', offerId: BETA_OFFER, title: 'Theirs', price: '$1' }] },
      { v: 1, blocks: [{ type: 'custom', html: `<a href="{{buy:${BETA_OFFER}}}">x</a>` }] },
    ]) {
      const { res, calls } = await draftWith(designed({ doc }));
      expect([res.statusCode, res.body.code, res.body.error]).toEqual([400, 'UNKNOWN_BUY_LINK', 'This buy link isn’t one of this business’s offers.']);
      expect(calls).toEqual([]);
    }
    // the same offer is beta's own
    expect((await draftWith(designed({ doc: { v: 1, blocks: [{ type: 'button', label: 'Buy', link: { kind: 'offer', offerId: BETA_OFFER } }] } }), 'Bearer beta')).res.statusCode).toBe(201);
  });

  it('images: the caller’s public-files folder and the app’s icons only (IMAGE_NOT_HOSTED otherwise)', async () => {
    const img = (src) => designed({ doc: { v: 1, blocks: [{ type: 'image', src, alt: 'x' }] } });
    for (const src of ['https://track.example/pixel.gif', imageOf('account-beta'), imageOf('account-alpha', '../account-beta/e-AAAAAAAAAAAAAAAAAAAAAA.png'), `${SUPABASE}/storage/v1/object/public/lead-files/account-alpha/x.png`, 'https://yourlocalbusiness.replit.app/m/AAAAAAAAAAAAAAAAAAAAAA']) {
      const { res, calls } = await draftWith(img(src));
      expect([res.statusCode, res.body.code], src).toEqual([400, 'IMAGE_NOT_HOSTED']);
      expect(res.body.error).toBe('Upload this image in the email studio first: images in emails have to be hosted by the app.');
      expect(calls).toEqual([]);
    }
    expect((await draftWith(img(imageOf('account-alpha', 'AAAAAAAAAAAAAAAAAAAAAA.jpg')))).res.statusCode).toBe(201);
    expect((await draftWith(designed({ brand: { ...BRAND, logoUrl: 'https://elsewhere.example/logo.png' } }))).res.body.code).toBe('IMAGE_NOT_HOSTED');
    // social icons are text links until the owner adds the icon files (EMAIL_ICONS=on)
    const social = designed({ doc: { v: 1, blocks: [{ type: 'social', style: 'icons', links: [{ platform: 'instagram', url: 'https://instagram.com/cc' }] }] } });
    const text = await draftWith(social);
    expect(text.html).not.toContain('/email-icons/');
    expect(text.html).toContain('>Instagram</a>');
    const fetch = omnisendFetch();
    const { service } = makeService({ fetch, env: { OMNISEND_CLIENT_ID: 'client-id-test', OMNISEND_CLIENT_SECRET: 'client-secret-test', SUPABASE_URL: SUPABASE, EMAIL_ICONS: 'on' } });
    await connected(service);
    expect((await call(service, 'POST', `${API}/campaign-drafts`, { body: social })).statusCode).toBe(201);
    expect(fetch.log.find((c) => c.kind === 'template').body.html).toContain('src="https://yourlocalbusiness.replit.app/email-icons/instagram.png"');
  });

  it('checks the values, the brand, the links and the doc before anything is made', async () => {
    const cases = [
      [designed({ brand: { ...BRAND, colors: { primary: 'red' } } }), 400, 'INVALID_DRAFT'],
      [designed({ values: { ...VALUES, coupon: 'X' } }), 400, 'INVALID_DRAFT'],
      [designed({ values: { ...VALUES, product_link: 'javascript:alert(1)' } }), 400, 'INVALID_DRAFT'],
      [designed({ values: { ...VALUES, sender_name: 'x'.repeat(501) } }), 400, 'INVALID_DRAFT'],
      [designed({ doc: { v: 1, blocks: [{ type: 'marquee' }] } }), 400, 'INVALID_DRAFT'],
      [designed({ doc: 'html' }), 400, 'INVALID_DRAFT'],
      [designed({ subject: '' }), 400, 'INVALID_DRAFT'],
      // a button to the download while it has no address yet (the app's placeholder)
      [designed({ doc: { v: 1, blocks: [{ type: 'button', label: 'Get it', link: { kind: 'magnet' } }] }, values: { ...VALUES, lead_magnet_link: '[link to your free download]' } }), 400, 'INVALID_CTA'],
      [designed({ doc: { v: 1, blocks: [{ type: 'button', label: 'Go', link: { kind: 'url', url: '[link to your offer]' } }] } }), 400, 'INVALID_CTA'],
      [designed({ doc: { v: 1, blocks: [{ type: 'button', label: 'Calc', link: { kind: 'asset', assetId: 'calc' } }] } }), 400, 'INVALID_CTA'],
      [designed({ doc: { v: 1, blocks: [{ type: 'button', label: 'Calc', link: { kind: 'asset', assetId: 'calc' } }] }, assetLinks: { calc: 'https://elsewhere.example/p/calc' } }), 400, 'INVALID_DRAFT'],
    ];
    for (const [body, status, code] of cases) {
      const { res, calls } = await draftWith(body);
      expect([res.statusCode, res.body.code], JSON.stringify(body).slice(0, 200)).toEqual([status, code]);
      expect(calls).toEqual([]);
    }
    const { res: first } = await draftWith(designed({ doc: { v: 1, blocks: [{ type: 'text', text: 'x'.repeat(5001) }] } }));
    expect(first.body.error).toBe('Block 1 (text) is too long: 5,001 characters, and at most 5,000 fit.');
    // a placeholder in text is fine (it's words, not a button), and a published asset on the app's address is a link
    const ok = await draftWith(designed({ doc: { v: 1, blocks: [{ type: 'text', text: 'Soon: {{lead_magnet_link}}' }, { type: 'button', label: 'Calc', link: { kind: 'asset', assetId: 'calc' } }] }, values: { ...VALUES, lead_magnet_link: '[link to your free download]' }, assetLinks: { calc: 'https://yourlocalbusiness.replit.app/p/calc' } }));
    expect(ok.res.statusCode).toBe(201);
    expect(ok.html).toContain('href="https://yourlocalbusiness.replit.app/p/calc"');
    expect(ok.html).toContain('Soon: &#91;link to your free download&#93;');
  });

  it('a rendered email over 200 KB is 413, nothing made; a missing first name is the placeholder', async () => {
    const doc = { v: 1, blocks: Array.from({ length: 60 }, () => ({ type: 'text', text: '<'.repeat(1500) })) };
    expect(JSON.stringify(designed({ doc })).length).toBeLessThan(DRAFT_BODY_LIMIT);
    const { res, calls } = await draftWith(designed({ doc }));
    expect([res.statusCode, res.body.code]).toEqual([413, 'TOO_LARGE']);
    expect(calls).toEqual([]);
    const { html } = await draftWith(designed({ values: { product_link: VALUES.product_link, lead_magnet_link: VALUES.lead_magnet_link } }));
    expect(html).toContain('Welcome, &#91;First name&#93;');
  });

  it('one attempt per write: a template import that may have happened is never sent again', async () => {
    const fetch = omnisendFetch({ template: () => Promise.reject(new DOMException('aborted', 'TimeoutError')) });
    const { service } = makeService({ fetch });
    await connected(service);
    const res = await call(service, 'POST', `${API}/campaign-drafts`, { body: designed() });
    expect([res.statusCode, res.body.code]).toEqual([502, 'OUTCOME_UNKNOWN']);
    expect(fetch.log.filter((c) => c.kind === 'template')).toHaveLength(1);
  });

  it('offers that can’t be read: 503, nothing made', async () => {
    const fetch = omnisendFetch();
    const failing = async () => {
      throw new Error('db down');
    };
    const { service } = makeService({ fetch, offerIds: failing });
    await connected(service);
    const res = await call(service, 'POST', `${API}/campaign-drafts`, { body: designed() });
    expect([res.statusCode, res.body.code]).toEqual([503, 'OFFERS_UNAVAILABLE']);
    expect(fetch.log.filter((c) => c.kind !== 'token')).toHaveLength(0);
  });
});

// ───────────── when Omnisend refuses, or doesn't say ─────────────

describe('when Omnisend refuses or doesn’t answer', () => {
  const draftWith = async (fetch) => {
    const made = makeService({ fetch });
    await connected(made.service);
    const res = await call(made.service, 'POST', `${API}/campaign-drafts`, { body: DRAFT });
    return { ...made, res };
  };
  const steps = (fetch) => fetch.log.filter((c) => c.kind !== 'token').map((c) => c.kind);

  it('a connection Omnisend no longer accepts (401) asks for a new one', async () => {
    const fetch = omnisendFetch({ template: () => jsonResponse({ type: 'https://problems.omnisend.com/unauthorized', detail: 'private detail' }, 401) });
    const { service, storage, res } = await draftWith(fetch);
    expect([res.statusCode, res.body.code]).toEqual([409, 'RECONNECT_REQUIRED']);
    expect(res.body.error).toBe('Omnisend no longer accepts this connection, so nothing was created. Connect Omnisend again.');
    expect(storage.documents.get(userKey('account-alpha')).value).toEqual({ needsReconnect: 'revoked', markedAt: new Date(NOW).toISOString() });
    expect((await call(service, 'GET', `${API}/status`)).body).toMatchObject({ connected: false, reconnect: 'revoked', scopes: [] });
    const again = await call(service, 'POST', `${API}/campaign-drafts`, { body: DRAFT });
    expect([again.statusCode, again.body.code]).toEqual([409, 'RECONNECT_REQUIRED']);
    expect(steps(fetch)).toEqual(['template']);
    // connecting again clears it
    await connected(service);
    expect((await call(service, 'GET', `${API}/status`)).body).toMatchObject({ connected: true, reconnect: null });
  });

  it('a connection without both permissions asks for a new one', async () => {
    const fetch = omnisendFetch();
    const { service, storage } = makeService({ fetch });
    storage.documents.set(userKey('account-alpha'), { value: { accessToken: 'private-at-old', scopes: ['campaigns.write'] }, updatedAt: 'v0' });
    expect((await call(service, 'GET', `${API}/status`)).body).toMatchObject({ connected: false, reconnect: 'scopes' });
    const res = await call(service, 'POST', `${API}/campaign-drafts`, { body: DRAFT });
    expect([res.statusCode, res.body.code]).toEqual([409, 'SCOPE_REQUIRED']);
    expect(fetch).not.toHaveBeenCalled();
    expect(storage.documents.get(userKey('account-alpha')).value.accessToken).toBeUndefined();
    // and Omnisend saying so (403) does the same
    const refused = omnisendFetch({ template: () => jsonResponse({}, 403) });
    const second = await draftWith(refused);
    expect([second.res.statusCode, second.res.body.code]).toEqual([409, 'SCOPE_REQUIRED']);
    expect((await call(second.service, 'GET', `${API}/status`)).body.reconnect).toBe('scopes');
  });

  it('a template import that may have happened says so, and is never retried', async () => {
    const fetch = omnisendFetch({ template: () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')) });
    const { res } = await draftWith(fetch);
    expect([res.statusCode, res.body.code]).toEqual([502, 'OUTCOME_UNKNOWN']);
    expect(res.body.error).toBe('The email template may have been created: Omnisend didn’t confirm it. Check Omnisend before trying again.');
    expect(steps(fetch)).toEqual(['template']);

    const serverError = omnisendFetch({ template: () => jsonResponse({}, 503) });
    expect((await draftWith(serverError)).res.body.code).toBe('OUTCOME_UNKNOWN');
    const noId = omnisendFetch({ template: () => jsonResponse({ id: 'not-a-template-id' }, 201) });
    const unconfirmed = (await draftWith(noId)).res;
    expect([unconfirmed.statusCode, unconfirmed.body.code]).toEqual([502, 'TEMPLATE_UNCONFIRMED']);
    expect(unconfirmed.body.error).toMatch(/may have been created: check Omnisend before trying again\.$/);
    expect(steps(noId)).toEqual(['template']);
  });

  it('an import that never reached Omnisend says nothing was created', async () => {
    const fetch = omnisendFetch({ template: () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })) });
    const { res } = await draftWith(fetch);
    expect([res.statusCode, res.body.code, res.body.error]).toEqual([502, 'OMNISEND_UNAVAILABLE', 'Couldn’t reach Omnisend, so nothing was created. Try again shortly.']);
    const refused = omnisendFetch({ template: () => jsonResponse({ detail: 'private detail' }, 400) });
    const answer = (await draftWith(refused)).res;
    expect([answer.body.code, answer.body.error]).toEqual(['TEMPLATE_CREATE_FAILED', 'Omnisend refused the email template (HTTP 400), so nothing was created.']);
  });

  it('a campaign step that fails says the template exists, and whether the draft may', async () => {
    const cases = [
      [() => Promise.reject(new DOMException('aborted', 'TimeoutError')), 502, 'OUTCOME_UNKNOWN', 'The email template was imported, and the campaign draft may have been created: Omnisend didn’t confirm it. Check Omnisend before trying again.'],
      [() => jsonResponse({}, 500), 502, 'OUTCOME_UNKNOWN', 'The email template was imported, and the campaign draft may have been created: Omnisend didn’t confirm it. Check Omnisend before trying again.'],
      [() => jsonResponse({ detail: 'private detail' }, 400), 502, 'DRAFT_CREATE_FAILED', 'The email template was imported, but Omnisend refused the campaign draft (HTTP 400), so none was created. Check Omnisend before trying again.'],
      [() => jsonResponse({ type: 'https://problems.omnisend.com/sender-email-not-available', detail: 'private detail' }, 422), 422, 'SENDER_REQUIRED', 'The email template was imported, but Omnisend can’t create a campaign until this brand has a verified sender email. Add one in Omnisend’s sender settings; the template is already there to use.'],
      [() => jsonResponse({ type: 'https://problems.omnisend.com/rate-limit-exceeded', retryAfter: 60 }, 429), 429, 'OMNISEND_RATE_LIMIT', 'The email template was imported, but Omnisend is limiting requests right now, so no campaign draft was created. Wait a minute and check Omnisend before trying again.'],
      [() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 502, 'OMNISEND_UNAVAILABLE', 'The email template was imported, but Omnisend couldn’t be reached to create the campaign draft. Check Omnisend before trying again.'],
    ];
    for (const [campaign, status, code, error] of cases) {
      const fetch = omnisendFetch({ campaign });
      const { res } = await draftWith(fetch);
      expect([res.statusCode, res.body.code, res.body.error]).toEqual([status, code, error]);
      expect(steps(fetch)).toEqual(['template', 'campaign']);
      expect(JSON.stringify(res.body)).not.toContain('private');
    }
  });
});

// ───────────── A/B test drafts (P4b) ─────────────

describe('A/B test drafts', () => {
  const VARIANTS = { a: { subject: 'Your guide is inside', body: 'Hi,\n\nHere it is.', ctaLabel: 'Get it', ctaUrl: 'https://copperandcomb.com/free' }, b: { subject: 'Free guide: 5 cuts', body: 'Hi,\n\nHere it is.', ctaLabel: 'Get it', ctaUrl: 'https://copperandcomb.com/free' } };
  /** Omnisend's API for A/B drafts and results; every call kept in .log. */
  function abFetch({ campaign, reports, get } = {}) {
    const log = [];
    let n = 0;
    const fn = vi.fn(async (url, options = {}) => {
      const u = String(url);
      const method = options.method || 'GET';
      if (u === 'https://app.omnisend.com/oauth2/token') {
        const form = new URLSearchParams(options.body);
        log.push({ kind: 'token' });
        return jsonResponse({ access_token: `private-at-${form.get('code')}`, refresh_token: 'private-rt', token_type: 'Bearer', scope: OMNISEND_SCOPES.join(' ') });
      }
      if (u === 'https://api.omnisend.com/api/email-templates/import') {
        log.push({ kind: 'template', body: JSON.parse(options.body) });
        n += 1;
        return jsonResponse({ id: String(n).repeat(24).slice(0, 24) }, 201);
      }
      if (u === 'https://api.omnisend.com/api/campaigns' && method === 'POST') {
        const body = JSON.parse(options.body);
        log.push({ kind: 'campaign', body });
        if (campaign) return campaign(body);
        return jsonResponse({ id: 'c'.repeat(24), name: body.name, status: 'draft', url: `https://app.omnisend.com/campaigns/${'c'.repeat(24)}/settings`, abTest: { ...body.abTest, variants: { a: { id: 'va1' }, b: { id: 'vb1' } } } }, 201);
      }
      if (u.startsWith('https://api.omnisend.com/api/campaigns/') && method === 'GET') {
        log.push({ kind: 'read', url: u });
        return get ? get(u) : jsonResponse({ id: 'c'.repeat(24), status: 'sent', abTest: { result: { winnerVariantID: 'vb1' } } });
      }
      if (u === 'https://api.omnisend.com/api/analytics/reports') {
        log.push({ kind: 'reports' });
        return reports ? reports() : jsonResponse({ reports: [{ alias: 'campaigns-30d', rows: [{ marketingActivityID: 'va1', sent: 300, openRate: 0.3, clickRate: 0.02 }, { marketingActivityID: 'vb1', sent: 300, openRate: 0.45, clickRate: 0.03 }] }, { alias: 'daily-30d', rows: [] }] });
      }
      if (u === 'https://api.omnisend.com/api/campaigns?limit=100') return jsonResponse({ campaigns: [] });
      throw new Error(`Unexpected endpoint ${method} ${u}`);
    });
    fn.log = log;
    return fn;
  }
  const kinds = (fetch) => fetch.log.filter((c) => !['token'].includes(c.kind)).map((c) => c.kind);

  it('imports two templates and makes one abTest campaign: both variants, no top-level content, the settings in bounds, the variant ids back', async () => {
    const fetch = abFetch();
    const { service } = makeService({ fetch });
    await connected(service);
    const got = await service.createAbDraft('account-alpha', { name: 'Guide subject test', variants: VARIANTS, settings: { testSizePercent: 80, decisionHours: 2, winningMetric: 'openRate' } });
    expect(kinds(fetch)).toEqual(['template', 'template', 'campaign']);
    const body = fetch.log.find((c) => c.kind === 'campaign').body;
    expect(body).not.toHaveProperty('content');
    expect(body).not.toHaveProperty('sendingSettings');
    expect(body).toEqual({
      channel: 'email',
      type: 'abTest',
      name: 'Guide subject test',
      language: 'en_US',
      abTest: {
        // out-of-range settings fall back to the defaults (30%, 24 hours)
        settings: { testSizePercent: 30, winningMetric: 'openRate', decisionTime: { amount: 24, unit: 'h' } },
        variants: { a: { content: { email: { subject: 'Your guide is inside', templateID: '1'.repeat(24) } } }, b: { content: { email: { subject: 'Free guide: 5 cuts', templateID: '2'.repeat(24) } } } },
      },
    });
    expect(got).toEqual({ mode: 'omnisend_ab', campaign: { id: 'c'.repeat(24), name: 'Guide subject test', status: 'draft', url: `https://app.omnisend.com/campaigns/${'c'.repeat(24)}/settings`, variantIds: { a: 'va1', b: 'vb1' } } });
    const html = fetch.log.filter((c) => c.kind === 'template').map((c) => c.body.html);
    expect(html.every((h) => h.includes('[[unsubscribe_link]]'))).toBe(true);
  });

  it('designed versions: each doc rendered here, the two templates differing only in the opening (or the subject)', async () => {
    const doc = (opening) => ({ v: 1, blocks: [{ id: 'b_opening001', type: 'text', text: opening }, { id: 'b_rest000001', type: 'text', text: 'The rest of the email.' }, { id: 'b_button0001', type: 'button', label: 'Get it', link: { kind: 'magnet' } }] });
    const values = { first_name: '[First name]', lead_magnet_link: 'https://yourlocalbusiness.replit.app/m/AAAAAAAAAAAAAAAAAAAAAA' };
    const opening = { a: { subject: 'Your guide', doc: doc('Here it is.'), values }, b: { subject: 'Your guide', doc: doc('You asked, so here it is.'), values } };
    for (const [variants, changed] of [[opening, 'opening'], [{ a: { ...opening.a }, b: { ...opening.a, subject: 'Free guide inside' } }, 'subject']]) {
      const fetch = abFetch();
      const { service } = makeService({ fetch });
      await connected(service);
      await service.createAbDraft('account-alpha', { name: 'Designed A/B', variants });
      const [a, b] = fetch.log.filter((c) => c.kind === 'template').map((c) => c.body.html);
      for (const h of [a, b]) expect(h.split('[[unsubscribe_link]]')).toHaveLength(2);
      if (changed === 'opening') {
        expect(a).not.toBe(b);
        expect(a.replace('Here it is.', 'You asked, so here it is.')).toBe(b);
      } else {
        // only the subject (the <title>) differs
        expect(a.replace('<title>Your guide</title>', '<title>Free guide inside</title>')).toBe(b);
        const subjects = fetch.log.find((c) => c.kind === 'campaign').body.abTest.variants;
        expect([subjects.a.content.email.subject, subjects.b.content.email.subject]).toEqual(['Your guide', 'Free guide inside']);
      }
    }
    // a version whose buy link isn't the caller's: nothing imported
    const fetch = abFetch();
    const { service } = makeService({ fetch });
    await connected(service);
    const theirs = { ...opening.b, doc: { v: 1, blocks: [{ type: 'button', label: 'Buy', link: { kind: 'offer', offerId: OFFERS['account-beta'][0] } }] } };
    await expect(service.createAbDraft('account-alpha', { name: 'x', variants: { a: opening.a, b: theirs } })).rejects.toMatchObject({ status: 400, code: 'UNKNOWN_BUY_LINK' });
    expect(kinds(fetch)).toEqual([]);
  });

  it('a timeout after the campaign POST is CAMPAIGN_UNCONFIRMED and is never retried', async () => {
    const fetch = abFetch({ campaign: () => Promise.reject(new DOMException('aborted', 'TimeoutError')) });
    const { service } = makeService({ fetch });
    await connected(service);
    await expect(service.createAbDraft('account-alpha', { name: 'x', variants: VARIANTS })).rejects.toMatchObject({ status: 502, code: 'CAMPAIGN_UNCONFIRMED', campaignMayExist: true, publicMessage: expect.stringMatching(/may have been created: Omnisend didn’t confirm it\. Check Omnisend before trying again\.$/) });
    expect(kinds(fetch)).toEqual(['template', 'template', 'campaign']);
  });

  it('when Omnisend refuses the abTest type for the brand (4xx), two regular drafts; a 5xx is not a reason to fall back', async () => {
    const refuse = (status, type) => (body) => (body.type === 'abTest' ? jsonResponse({ type: `https://problems.omnisend.com/${type}`, detail: 'private detail' }, status) : jsonResponse({ id: body.name.endsWith('A') ? 'a'.repeat(24) : 'b'.repeat(24), name: body.name, status: 'draft', url: '' }, 201));
    const fetch = abFetch({ campaign: refuse(422, 'campaign-type-not-supported') });
    const { service } = makeService({ fetch });
    await connected(service);
    const got = await service.createAbDraft('account-alpha', { name: 'Fallback', variants: VARIANTS });
    expect(got.mode).toBe('split');
    expect(got.campaigns.a).toMatchObject({ id: 'a'.repeat(24), name: 'Fallback — version A' });
    expect(got.campaigns.b).toMatchObject({ id: 'b'.repeat(24), name: 'Fallback — version B' });
    const regular = fetch.log.filter((c) => c.kind === 'campaign' && c.body.type === 'regular');
    expect(regular.map((c) => c.body.content.email.templateID)).toEqual(['1'.repeat(24), '2'.repeat(24)]);
    // both drafts' templates carry the unsubscribe link
    for (const t of fetch.log.filter((c) => c.kind === 'template')) expect(t.body.html.split('[[unsubscribe_link]]')).toHaveLength(2);
    const server = abFetch({ campaign: refuse(503, 'campaign-type-not-supported') });
    const made = makeService({ fetch: server });
    await connected(made.service);
    // a 5xx: the A/B draft may exist (never retried, never a fallback)
    await expect(made.service.createAbDraft('account-alpha', { name: 'x', variants: VARIANTS })).rejects.toMatchObject({ code: 'CAMPAIGN_UNCONFIRMED', campaignMayExist: true });
    expect(server.log.filter((c) => c.kind === 'campaign')).toHaveLength(1);
  });

  it('results: Omnisend’s pick and each variant’s rates from the reports (the hourly cache and the daily budget)', async () => {
    const fetch = abFetch();
    const { service, clock, storage } = makeService({ fetch });
    await connected(service);
    const got = await service.abResults('account-alpha', { abCampaignId: 'c'.repeat(24) });
    expect(got).toMatchObject({ status: 'ok', campaignStatus: 'sent', winnerId: 'vb1', rates: { va1: { sent: 300, openRate: 0.3, clickRate: 0.02 }, vb1: { sent: 300, openRate: 0.45 } } });
    // within the hour: the reports come from the cache
    await service.abResults('account-alpha', { abCampaignId: 'c'.repeat(24) });
    expect(fetch.log.filter((c) => c.kind === 'reports')).toHaveLength(1);
    // the day's budget (REPORTS_PER_DAY) is respected: none left today, no reports call
    clock.now += 61 * 60_000;
    const brand = sha256('omnisend-brand:private-at-oauth-code').slice(0, 24);
    const key = `omnisend:reports:${brand}:${new Date(clock.now).toISOString().slice(0, 10)}`;
    storage.documents.set(key, { value: { count: REPORTS_PER_DAY, lastAt: 0 }, updatedAt: 'v-budget' });
    const spent = await service.abResults('account-alpha', {});
    expect(fetch.log.filter((c) => c.kind === 'reports')).toHaveLength(1);
    expect(spent).toMatchObject({ status: 'ok', reports: 'RATE_LIMITED' });
    // a revoked read asks for a reconnect, never Omnisend's text
    const refused = abFetch({ get: () => jsonResponse({ detail: 'private detail' }, 403) });
    const other = makeService({ fetch: refused });
    await connected(other.service);
    expect(await other.service.abResults('account-alpha', { abCampaignId: 'c'.repeat(24) })).toEqual({ status: 'not_connected', errorCode: 'NEEDS_RECONNECT' });
  });
});

// ───────────── status ─────────────

describe('the status', () => {
  it('says whether the caller is the app’s owner', async () => {
    const { service } = makeService();
    expect((await call(service, 'GET', `${API}/status`, { authorization: 'Bearer owner' })).body.owner).toBe(true);
    expect((await call(service, 'GET', `${API}/status`)).body.owner).toBe(false);
  });

  it('copes with storage that isn’t set up, can’t be read or is down', async () => {
    const { service, storage } = makeService();
    storage.fail.get = 'NO_TABLE';
    const noTable = await call(service, 'GET', `${API}/status`);
    expect([noTable.statusCode, noTable.body.storageReady, noTable.body.connected]).toEqual([200, false, false]);
    storage.fail.get = 'UNREACHABLE';
    const down = await call(service, 'GET', `${API}/status`);
    expect([down.statusCode, down.body.code]).toEqual([503, 'STORAGE_UNAVAILABLE']);
    storage.fail.get = null;

    // a connection saved under an encryption secret that has since changed: connect again (or disconnect)
    storage.documents.set(userKey('account-alpha'), { value: { accessToken: 'private-at-old', scopes: OMNISEND_SCOPES }, updatedAt: 'v0' });
    storage.unreadable.add(userKey('account-alpha'));
    expect((await call(service, 'GET', `${API}/status`)).body).toMatchObject({ connected: false, reconnect: 'unreadable', storageReady: true });
    const draft = await call(service, 'POST', `${API}/campaign-drafts`, { body: DRAFT });
    expect([draft.statusCode, draft.body.code]).toEqual([409, 'RECONNECT_REQUIRED']);
    const disconnect = await call(service, 'DELETE', `${API}/connection`);
    expect(disconnect.statusCode).toBe(200);
    expect((await call(service, 'GET', `${API}/status`)).body).toMatchObject({ connected: false, reconnect: null });
  });

  it('needs accounts and a sign-in that can be checked', async () => {
    const off = makeService({ auth: { enabled: false } }).service;
    expect((await call(off, 'GET', `${API}/status`)).body.code).toBe('ACCOUNTS_NOT_CONFIGURED');
    const broken = makeService({ auth: { enabled: true, identify: async () => Promise.reject(new Error('down')) } }).service;
    const unavailable = await call(broken, 'GET', `${API}/status`);
    expect([unavailable.statusCode, unavailable.body.code]).toEqual([503, 'AUTH_UNAVAILABLE']);
    const signedOut = await call(makeService().service, 'GET', `${API}/status`, { authorization: '' });
    expect([signedOut.statusCode, signedOut.body.code]).toEqual([401, 'AUTH_REQUIRED']);
    expect(signedOut.headers['access-control-allow-origin']).toBe('https://app.test');
  });
});

// ───────────── deleting an account ─────────────

describe('forgetting an account (account deletion)', () => {
  it('has nothing to delete without the app_state table, or without storage', async () => {
    const { service, storage } = makeService();
    storage.fail.get = 'NO_TABLE';
    storage.fail.put = 'NO_TABLE';
    await expect(service.forgetUser('account-alpha')).resolves.toBeUndefined();
    const local = makeService({ storage: { enabled: false } }).service;
    await expect(local.forgetUser('account-alpha')).resolves.toBeUndefined();
  });

  it('overwrites a connection without reading it, so one it can’t decrypt goes too', async () => {
    const { service, storage } = makeService();
    storage.documents.set(userKey('account-alpha'), { value: { accessToken: 'private-at-old', refreshToken: 'private-rt-old' }, updatedAt: 'v0' });
    storage.unreadable.add(userKey('account-alpha'));
    storage.fail.get = 'UNREACHABLE';
    await service.forgetUser('account-alpha');
    expect(storage.calls.filter((c) => c.op === 'get')).toHaveLength(0);
    expect(storage.calls.filter((c) => c.op === 'put').every((c) => !c.conditional)).toBe(true);
    expect(storage.documents.get(userKey('account-alpha')).value).toEqual({ forgottenAt: new Date(NOW).toISOString() });
  });

  it('stops the deletion with its own message when storage is down', async () => {
    const { service, storage } = makeService();
    storage.fail.put = 'UNREACHABLE';
    await expect(service.forgetUser('account-alpha')).rejects.toMatchObject({
      status: 503,
      code: 'OMNISEND_FORGET_FAILED',
      message: 'Couldn’t remove your Omnisend connection just now, so your account wasn’t deleted. Try again shortly.',
    });
  });

  it('doesn’t hold up account deletion when Omnisend was never set up, though it still tries to overwrite', async () => {
    const { service, storage } = makeService({ env: {} });
    storage.fail.put = 'UNREACHABLE';
    await expect(service.forgetUser('account-alpha')).resolves.toBeUndefined();
    expect(storage.calls.filter((c) => c.op === 'put')).toHaveLength(1);
    // and when storage works, a connection left from before the credentials were removed goes too
    storage.fail.put = null;
    storage.documents.set(userKey('account-alpha'), { value: { accessToken: 'private-at-old', scopes: OMNISEND_SCOPES }, updatedAt: 'v0' });
    await service.forgetUser('account-alpha');
    expect(storage.documents.get(userKey('account-alpha')).value).toEqual({ forgottenAt: new Date(NOW).toISOString() });
  });

  it('lifts the block at once when the account wasn’t deleted after all', async () => {
    const { service, storage } = makeService({ fetch: omnisendFetch() });
    await connected(service, 'Bearer beta');
    const betaConnection = structuredClone(storage.documents.get(userKey('account-beta')));
    await service.forgetUser('account-alpha');
    await service.unforgetUser('account-alpha');
    // connecting works now, not in a week
    await connected(service);
    // and an account that wasn't being deleted is left alone
    await service.unforgetUser('account-beta');
    expect(storage.documents.get(userKey('account-beta'))).toEqual(betaConnection);
  });

  it('lifting the block is best effort when storage is down', async () => {
    const { service, storage } = makeService();
    await service.forgetUser('account-alpha');
    storage.fail.get = 'UNREACHABLE';
    await expect(service.unforgetUser('account-alpha')).resolves.toBeUndefined();
  });

  it('drops the connections the account started, so a sign-in finished afterwards stores nothing', async () => {
    const fetch = omnisendFetch();
    const { service, storage } = makeService({ fetch });
    const { state, browser: b } = await startConnect(service);
    await service.forgetUser('account-alpha');
    expect(outcome(await backFromOmnisend(service, state, { b, code: 'leaver-code' }))).toBe('invalid_state');
    expect(fetch).not.toHaveBeenCalled();
    expect(storage.documents.get(userKey('account-alpha')).value.accessToken).toBeUndefined();
    // and the deleted account can't start another
    const again = await call(service, 'POST', `${API}/connect`, { origin: OMNISEND_PUBLIC_BASE_URL, body: {} });
    expect([again.statusCode, again.body.code]).toEqual([403, 'ACCOUNT_GONE']);
  });

  it('never stores a token for an account deleted while its sign-in was being exchanged', async () => {
    let service;
    const fetch = omnisendFetch({
      token: async (form) => {
        await service.forgetUser('account-alpha');
        return jsonResponse({ access_token: `private-at-${form.get('code')}`, token_type: 'Bearer', scope: OMNISEND_SCOPES.join(' ') });
      },
    });
    const made = makeService({ fetch });
    service = made.service;
    const { state, browser: b } = await startConnect(service);
    expect(outcome(await backFromOmnisend(service, state, { b, code: 'leaver-code' }))).toBe('invalid_state');
    expect(made.storage.documents.get(userKey('account-alpha')).value).toEqual({ forgottenAt: new Date(NOW).toISOString() });
  });

  it('lets an account that wasn’t deleted after all connect again a week later', async () => {
    const { service, clock } = makeService({ fetch: omnisendFetch() });
    await service.forgetUser('account-alpha');
    clock.now = NOW + 8 * 24 * 60 * 60 * 1000;
    await connected(service);
  });
});

// ───────────── the real server ─────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = 'https://yourlocalbusiness.replit.app';

/** ai-server.mjs, with Omnisend answered by test/mock-omnisend.mjs (nothing leaves the machine). */
async function startServer(supa, extraEnv = {}) {
  const port = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-omnisend-'));
  const log = path.join(dir, 'omnisend-calls.jsonl');
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(here, 'test', 'mock-omnisend.mjs')).href, path.join(here, 'ai-server.mjs')], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dir,
      SUPABASE_URL: supa.url,
      SUPABASE_PUBLISHABLE_KEY: supa.PUBLISHABLE,
      SUPABASE_SECRET_KEY: supa.SECRET,
      ADMIN_EMAILS: 'owner@example.com',
      OMNISEND_CLIENT_ID: 'fake-client-id',
      OMNISEND_CLIENT_SECRET: 'fake-client-secret',
      OMNISEND_MOCK_LOG: log,
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
    const check = () => (out.includes('Yourlocalbusiness server on') ? (clearTimeout(timer), resolve()) : setTimeout(check, 25));
    check();
  });
  return {
    port,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
    output: () => out,
    // the server saves its usage log as it stops: its folder goes once it has exited
    stop: async () => {
      child.kill();
      await exited;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function request(port, method, pathname, { token, origin, body, rawBody, cookie, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const headers = { host: 'yourlocalbusiness.replit.app' };
    if (origin) headers.origin = origin;
    if (token) headers.authorization = `Bearer ${token}`;
    if (cookie) headers.cookie = cookie;
    const payload = rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined);
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
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ status: 'NO_ANSWER' });
    });
    req.on('error', (e) => resolve({ status: 'ERROR', error: e.code }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const returned = (res) => new URL(res.headers.location).searchParams.get('omnisend');

describe('the real server', () => {
  let supa;
  beforeAll(async () => {
    supa = await (await createMockSupabase()).start();
  });
  afterAll(async () => {
    await supa?.close();
  });

  it('ties the callback to the browser, limits the draft body, rate-limits callers and forgets deleted accounts', async () => {
    const server = await startServer(supa, { RATE_LIMIT_PER_MIN: '8' });
    try {
      const { port } = server;
      const alice = await supa.tokenFor('omnisend-alice@example.com');
      const bob = await supa.tokenFor('omnisend-bob@example.com');
      const drafts = `${API}/campaign-drafts`;

      const start = await request(port, 'POST', `${API}/connect`, { token: alice.token, origin: APP, body: {} });
      expect(start.status).toBe(200);
      expect(start.headers['set-cookie']).toHaveLength(1);
      expect(start.headers['set-cookie'][0]).toMatch(new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{22}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax$`));
      const cookie = start.headers['set-cookie'][0].split(';')[0];
      const state = encodeURIComponent(new URL(start.json.authorizationUrl).searchParams.get('state'));

      // another browser (no cookie) comes back with the state: nothing is exchanged or stored
      const stranger = await request(port, 'GET', `${API}/callback?code=bob-code&state=${state}`);
      expect([stranger.status, returned(stranger)]).toEqual([303, 'invalid_state']);
      expect(server.calls().filter((c) => c.kind === 'token')).toHaveLength(0);
      const back = await request(port, 'GET', `${API}/callback?code=alice-code&state=${state}`, { cookie });
      expect(returned(back)).toBe('connected');
      expect(back.headers['set-cookie'][0]).toMatch(/Max-Age=0;/);
      expect((await request(port, 'GET', `${API}/status`, { token: alice.token, origin: APP })).json).toMatchObject({ connected: true, owner: false });

      // the real sameOrigin and readJson
      const crossSite = await request(port, 'POST', drafts, { token: alice.token, origin: 'https://evil.example', body: DRAFT });
      expect(crossSite.status).toBe(403);
      const big = await request(port, 'POST', drafts, { token: alice.token, origin: APP, rawBody: JSON.stringify({ ...DRAFT, body: 'x'.repeat(300 * 1024) }) });
      expect([big.status, big.json?.code]).toEqual([413, 'TOO_LARGE']);
      const nothing = await request(port, 'POST', drafts, { token: alice.token, origin: APP, rawBody: 'null', timeoutMs: 5000 });
      expect([nothing.status, nothing.json?.code]).toEqual([400, 'INVALID_DRAFT']);
      const draft = await request(port, 'POST', drafts, { token: alice.token, origin: APP, body: DRAFT });
      expect(draft.status).toBe(201);
      const imported = server.calls().find((c) => c.path === '/api/email-templates/import');
      expect(imported.bearer).toBe('Bearer fake-at-alice-code');
      expect(imported.payload.html).toContain('<a href="[[unsubscribe_link]]"');
      // a designed email: its buy link checked against alice's own offers (server/offers, wired in ai-server.mjs)
      const offerId = 'RealServerOfferId00001';
      if (!supa.tables.has('offers')) supa.tables.set('offers', []);
      supa.tables.get('offers').push({ id: offerId, user_id: alice.user.id, project_id: 'proj-1', title: 'Course', provider: 'external', provider_ref: { url: 'https://pay.example/x' }, status: 'active', clicks: 0, created_at: new Date().toISOString() });
      const designed = { name: 'Designed', subject: 'Hi', doc: { v: 1, blocks: [{ type: 'text', text: 'Hi {{first_name}}' }, { type: 'button', label: 'Buy', link: { kind: 'offer', offerId } }] }, values: { first_name: '[First name]' } };
      const made = await request(port, 'POST', drafts, { token: alice.token, origin: APP, body: designed });
      expect([made.status, made.json]).toEqual([201, expect.anything()]);
      const html = server.calls().filter((c) => c.path === '/api/email-templates/import').at(-1).payload.html;
      expect(html).toContain(`href="https://yourlocalbusiness.replit.app/b/${offerId}"`);
      const notHers = await request(port, 'POST', drafts, { token: alice.token, origin: APP, body: { ...designed, doc: { v: 1, blocks: [{ type: 'button', label: 'Buy', link: { kind: 'offer', offerId: 'SomebodyElsesOffer0001' } }] } } });
      expect([notHers.status, notHers.json?.code]).toEqual([400, 'UNKNOWN_BUY_LINK']);

      // bob starts connecting, deletes his account, then his Omnisend tab comes back: no token for the deleted account
      const bobStart = await request(port, 'POST', `${API}/connect`, { token: bob.token, origin: APP, body: {} });
      const bobCookie = bobStart.headers['set-cookie'][0].split(';')[0];
      const bobState = encodeURIComponent(new URL(bobStart.json.authorizationUrl).searchParams.get('state'));
      const deleted = await request(port, 'DELETE', '/api/account', { token: bob.token, origin: APP });
      expect(deleted.status).toBe(200);
      expect(supa.users.has(bob.user.id)).toBe(false);
      const late = await request(port, 'GET', `${API}/callback?code=bob-code&state=${bobState}`, { cookie: bobCookie });
      expect(returned(late)).toBe('invalid_state');
      const key = userKey(bob.user.id);
      const row = (supa.tables.get('app_state') ?? []).find((r) => r.key === key);
      expect(JSON.parse(createSecretBox(supa.SECRET, 'ylb-app-state').open(row.ciphertext, `app_state:${key}`))).toEqual({ forgottenAt: expect.any(String) });
      expect(server.calls().filter((c) => c.kind === 'token').map((c) => c.code)).toEqual(['alice-code']);

      // callbacks from one caller with made-up states: none reads storage, and over RATE_LIMIT_PER_MIN they're turned away
      const reads = () => supa.calls.filter((c) => c.method === 'GET' && c.path === '/rest/v1/app_state').length;
      const outcomes = [];
      for (let i = 0; i < 8; i += 1) {
        const randomState = `${crypto.randomBytes(32).toString('base64url')}.${crypto.randomBytes(16).toString('base64url').slice(0, 22)}.${crypto.randomBytes(16).toString('base64url').slice(0, 22)}`;
        const before = reads();
        const res = await request(port, 'GET', `${API}/callback?code=x&state=${randomState}`, { cookie });
        outcomes.push([returned(res), reads() - before]);
      }
      expect(outcomes.every(([, read]) => read === 0)).toBe(true);
      expect(outcomes.at(-1)).toEqual(['busy', 0]);
      expect(server.calls().filter((c) => c.kind === 'blocked')).toEqual([]);
      expect(server.output()).not.toMatch(/fake-at-|fake-rt-|fake-client-secret/);
    } finally {
      await server.stop();
    }
  }, 30_000);

  it('leaves Omnisend usable when the account deletion itself fails', async () => {
    const server = await startServer(supa);
    try {
      const { port } = server;
      const carol = await supa.tokenFor('omnisend-carol@example.com');
      // deleting the account's files fails, so the account stays
      supa.behavior.fail = (method, pathname) => (pathname.startsWith('/storage/v1/') ? { status: 500, body: { message: 'mock storage failure' } } : null);
      let deleted;
      try {
        deleted = await request(port, 'DELETE', '/api/account', { token: carol.token, origin: APP });
      } finally {
        supa.behavior.fail = null;
      }
      expect(deleted.status).toBe(502);
      expect(supa.users.has(carol.user.id)).toBe(true);
      // and can connect Omnisend now, not in a week
      const start = await request(port, 'POST', `${API}/connect`, { token: carol.token, origin: APP, body: {} });
      expect(start.status).toBe(200);
      const cookie = start.headers['set-cookie'][0].split(';')[0];
      const state = encodeURIComponent(new URL(start.json.authorizationUrl).searchParams.get('state'));
      expect(returned(await request(port, 'GET', `${API}/callback?code=carol-code&state=${state}`, { cookie }))).toBe('connected');
      expect((await request(port, 'GET', `${API}/status`, { token: carol.token, origin: APP })).json.connected).toBe(true);
    } finally {
      await server.stop();
    }
  }, 30_000);

  it('deletes accounts and reports status without the app_state table', async () => {
    const bare = await (await createMockSupabase({ missingTables: ['app_state'] })).start();
    const server = await startServer(bare);
    try {
      const someone = await bare.tokenFor('omnisend-someone@example.com');
      const status = await request(server.port, 'GET', `${API}/status`, { token: someone.token, origin: APP });
      expect([status.status, status.json.storageReady]).toEqual([200, false]);
      const deleted = await request(server.port, 'DELETE', '/api/account', { token: someone.token, origin: APP });
      expect(deleted.status).toBe(200);
      expect(bare.users.has(someone.user.id)).toBe(false);
    } finally {
      await server.stop();
      await bare.close();
    }
  }, 30_000);
});
