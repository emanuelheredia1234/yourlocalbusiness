import { describe, expect, it, vi } from 'vitest';
import { createOmnisendRoutes, OMNISEND_PUBLIC_BASE_URL, OMNISEND_REDIRECT_URI, OMNISEND_SCOPES } from './omnisend.mjs';

function makeStorage() {
  const documents = new Map();
  let version = 0;
  return {
    enabled: true,
    documents,
    async get(key) {
      const row = documents.get(key);
      return row ? structuredClone(row) : null;
    },
    async put(key, value, options = {}) {
      const current = documents.get(key);
      if (Object.hasOwn(options, 'ifVersion')) {
        if (options.ifVersion === null && current) throw Object.assign(new Error('Conflict'), { code: 'CONFLICT' });
        if (options.ifVersion !== null && current?.updatedAt !== options.ifVersion) {
          throw Object.assign(new Error('Conflict'), { code: 'CONFLICT' });
        }
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
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
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

function makeService({ env, fetch = vi.fn(), storage = makeStorage() } = {}) {
  const send = (res, status, body, headers = {}) => {
    res.statusCode = status;
    res.headers = headers;
    res.body = body;
    res.ended = true;
    return res;
  };
  const service = createOmnisendRoutes({
    env: env || { OMNISEND_CLIENT_ID: 'client-id-test', OMNISEND_CLIENT_SECRET: 'client-secret-test' },
    storage,
    fetch,
    send,
    readJson: async (req) => req.body || {},
    sameOrigin: (req) => req.headers.origin === 'https://app.test' || req.headers.origin === OMNISEND_PUBLIC_BASE_URL,
    auth: {
      enabled: true,
      async identify(req) {
        if (req.headers.authorization === 'Bearer alpha') return { id: 'account-alpha' };
        if (req.headers.authorization === 'Bearer beta') return { id: 'account-beta' };
        return null;
      },
    },
    now: () => 1_800_000_000_000,
  });
  return { service, storage, fetch };
}

function request(method, authorization = 'Bearer alpha', body = undefined, origin = 'https://app.test') {
  return { method, headers: { authorization, origin }, body };
}

async function handle(service, method, path, options = {}) {
  const req = request(method, options.authorization, options.body, options.origin);
  const res = makeResponse();
  const url = new URL(path, 'https://app.test');
  await service.handle(req, res, url);
  return res;
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('Omnisend OAuth and campaign drafts', () => {
  it('reports missing OAuth credentials and does not start authorization', async () => {
    const { service } = makeService({ env: {}, fetch: vi.fn() });
    const status = await handle(service, 'GET', '/api/integrations/omnisend/status');
    expect(status.statusCode).toBe(200);
    expect(status.body.credentialsConfigured).toBe(false);
    expect(status.body.missingCredentials).toEqual(['OMNISEND_CLIENT_ID', 'OMNISEND_CLIENT_SECRET']);

    const connect = await handle(service, 'POST', '/api/integrations/omnisend/connect', { body: {} });
    expect(connect.statusCode).toBe(503);
    expect(connect.body.code).toBe('CREDENTIALS_NOT_CONFIGURED');
  });

  it('binds OAuth state to a user, exchanges the code at the exact registered callback, and hides tokens', async () => {
    const fetch = vi.fn(async (url, options) => {
      expect(String(url)).toBe('https://app.omnisend.com/oauth2/token');
      const form = new URLSearchParams(options.body);
      expect(form.get('redirect_uri')).toBe(OMNISEND_REDIRECT_URI);
      expect(form.get('client_secret')).toBe('client-secret-test');
      return jsonResponse({
        access_token: 'private-alpha-access-token',
        refresh_token: 'private-alpha-refresh-token',
        token_type: 'Bearer',
        scope: OMNISEND_SCOPES.join(' '),
      });
    });
    const { service } = makeService({ fetch });
    const started = await handle(service, 'POST', '/api/integrations/omnisend/connect', { body: {}, origin: OMNISEND_PUBLIC_BASE_URL });
    const authorization = new URL(started.body.authorizationUrl);
    expect(authorization.origin).toBe('https://app.omnisend.com');
    expect(authorization.searchParams.get('redirect_uri')).toBe(OMNISEND_REDIRECT_URI);
    expect(authorization.searchParams.get('scope').split(' ').sort()).toEqual([...OMNISEND_SCOPES].sort());
    const state = authorization.searchParams.get('state');
    expect(state).toBeTruthy();

    const callback = makeResponse();
    await service.handle(
      request('GET', undefined, undefined, ''),
      callback,
      new URL(`${OMNISEND_REDIRECT_URI}?code=oauth-code&state=${encodeURIComponent(state)}`),
    );
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe('https://yourlocalbusiness.replit.app/?omnisend=connected#marketing-email');

    const alphaStatus = await handle(service, 'GET', '/api/integrations/omnisend/status');
    const betaStatus = await handle(service, 'GET', '/api/integrations/omnisend/status', { authorization: 'Bearer beta' });
    expect(alphaStatus.body.connected).toBe(true);
    expect(betaStatus.body.connected).toBe(false);
    expect(JSON.stringify(alphaStatus.body)).not.toContain('private-alpha');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('creates an email template and campaign draft only with the requesting user token', async () => {
    const calls = [];
    const fetch = vi.fn(async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/oauth2/token')) {
        return jsonResponse({
          access_token: 'private-alpha-access-token',
          refresh_token: 'private-alpha-refresh-token',
          token_type: 'Bearer',
          scope: OMNISEND_SCOPES.join(' '),
        });
      }
      if (String(url).endsWith('/email-templates/import')) return jsonResponse({ id: 'a'.repeat(24) }, 201);
      if (String(url).endsWith('/campaigns')) return jsonResponse({ id: 'b'.repeat(24), name: 'Draft', status: 'draft' }, 201);
      throw new Error('Unexpected provider endpoint');
    });
    const { service } = makeService({ fetch });
    const started = await handle(service, 'POST', '/api/integrations/omnisend/connect', { body: {}, origin: OMNISEND_PUBLIC_BASE_URL });
    const authUrl = new URL(started.body.authorizationUrl);
    const callback = makeResponse();
    await service.handle(
      request('GET', undefined, undefined, ''),
      callback,
      new URL(`${OMNISEND_REDIRECT_URI}?code=oauth-code&state=${encodeURIComponent(authUrl.searchParams.get('state'))}`),
    );

    const draft = await handle(service, 'POST', '/api/integrations/omnisend/campaign-drafts', {
      body: {
        name: 'Spring email',
        subject: '<script>alert(1)</script>',
        preheader: 'Preview',
        body: 'Hello <script>bad()</script>\n\nThanks',
        ctaLabel: 'Open site',
        ctaUrl: 'javascript:alert(1)',
      },
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.body.campaign.status).toBe('draft');
    expect(JSON.stringify(draft.body)).not.toContain('private-alpha');
    expect(calls.map((call) => call.url)).toEqual([
      'https://app.omnisend.com/oauth2/token',
      'https://api.omnisend.com/api/email-templates/import',
      'https://api.omnisend.com/api/campaigns',
    ]);
    for (const call of calls.slice(1)) {
      expect(call.options.headers.authorization).toBe('Bearer private-alpha-access-token');
      expect(call.options.headers['omnisend-version']).toBe('2026-03-15');
    }
    const templateBody = JSON.parse(calls[1].options.body);
    expect(templateBody.html).toContain('&lt;script&gt;');
    expect(templateBody.html).not.toContain('javascript:');
    const campaignBody = JSON.parse(calls[2].options.body);
    expect(campaignBody.content.email.templateID).toBe('a'.repeat(24));
    expect(campaignBody.type).toBe('regular');

    const betaDraft = await handle(service, 'POST', '/api/integrations/omnisend/campaign-drafts', {
      authorization: 'Bearer beta',
      body: { name: 'Other account', subject: 'Subject', body: 'Body' },
    });
    expect(betaDraft.statusCode).toBe(409);
    expect(betaDraft.body.code).toBe('NOT_CONNECTED');
    expect(calls).toHaveLength(3);
  });

  it('consumes state once, disconnects only one customer, and never exposes sending', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      access_token: 'private-alpha-access-token',
      refresh_token: 'private-alpha-refresh-token',
      token_type: 'Bearer',
      scope: OMNISEND_SCOPES.join(' '),
    }));
    const { service } = makeService({ fetch });
    const started = await handle(service, 'POST', '/api/integrations/omnisend/connect', { body: {}, origin: OMNISEND_PUBLIC_BASE_URL });
    const state = new URL(started.body.authorizationUrl).searchParams.get('state');
    const callbackUrl = new URL(`${OMNISEND_REDIRECT_URI}?code=oauth-code&state=${encodeURIComponent(state)}`);
    const first = makeResponse();
    await service.handle(request('GET', undefined, undefined, ''), first, callbackUrl);
    const replay = makeResponse();
    await service.handle(request('GET', undefined, undefined, ''), replay, callbackUrl);
    expect(first.headers.location).toContain('omnisend=connected');
    expect(replay.headers.location).toContain('omnisend=invalid_state');
    expect(fetch).toHaveBeenCalledTimes(1);

    const disconnected = await handle(service, 'DELETE', '/api/integrations/omnisend/connection');
    expect(disconnected.body.connected).toBe(false);
    expect((await handle(service, 'GET', '/api/integrations/omnisend/status')).body.connected).toBe(false);
    expect((await handle(service, 'GET', '/api/integrations/omnisend/status', { authorization: 'Bearer beta' })).body.connected).toBe(false);
    const sending = await handle(service, 'POST', '/api/integrations/omnisend/send', { body: {} });
    expect(sending.statusCode).toBe(404);
    expect(sending.body.code).toBe('SEND_NOT_AVAILABLE');
  });

  it('rejects cross-site browser requests before changing OAuth state', async () => {
    const { service, storage } = makeService();
    const result = await handle(service, 'POST', '/api/integrations/omnisend/connect', { body: {}, origin: 'https://attacker.test' });
    expect(result.statusCode).toBe(403);
    expect(storage.documents.size).toBe(0);
  });

  it('requires OAuth to start on the published app origin', async () => {
    const { service, storage } = makeService();
    const result = await handle(service, 'POST', '/api/integrations/omnisend/connect', { body: {} });
    expect(result.statusCode).toBe(400);
    expect(result.body.code).toBe('USE_PUBLISHED_APP');
    expect(storage.documents.size).toBe(0);
  });
});
