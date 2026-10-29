import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderStore, buildBody, createImageRoutes, generateImage, normalizeError, sizeFor, sniffImage, testProvider } from './images.mjs';

// 1×1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

let upstream;
let base;
const seen = [];
let mode = 'ok';

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      const json = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/v1/models') return req.headers.authorization === 'Bearer good-key' ? json(200, { data: [{ id: 'muse-image-1.0' }] }) : json(401, { error: { message: 'bad key' } });
      if (req.headers.authorization !== 'Bearer good-key') return json(401, { error: { message: 'Invalid API key' } });
      if (mode === 'policy') return json(400, { error: { code: 'content_policy_violation', message: 'Blocked by safety system' } });
      if (mode === 'strict' && JSON.parse(raw).response_format) return json(400, { error: { message: 'Unknown parameter: response_format' } });
      json(200, { created: 1, data: [{ b64_json: PNG.toString('base64'), revised_prompt: 'a calm desk' }] });
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${upstream.address().port}/v1`;
});

afterAll(() => upstream.close());

const tmpStore = (env = {}) => new ProviderStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-img-')), 'image-providers.json'), env);

describe('image providers', () => {
  it('maps aspects to sizes per provider', () => {
    expect(sizeFor('meta', '1:1')).toBe('1536x1536');
    expect(sizeFor('meta', '4:5')).toBe('1216x1536');
    expect(sizeFor('meta', '9:16')).toBe('896x1536');
    expect(sizeFor('meta', '21:8')).toBe('1536x576');
    expect(sizeFor('openai', '4:5')).toBe('1024x1536');
    expect(sizeFor('openai', '1.91:1')).toBe('1536x1024');
    expect(sizeFor('openai', '1:1')).toBe('1024x1024');
  });

  it('builds a Muse Image request', () => {
    const b = buildBody('meta', { model: 'muse-image-1.0' }, 'a desk', '4:5');
    expect(b).toMatchObject({ model: 'muse-image-1.0', prompt: 'a desk', n: 1, response_format: 'b64_json', output_format: 'png' });
    expect(buildBody('openai', { model: 'gpt-image-1' }, 'x', '1:1')).not.toHaveProperty('response_format');
  });

  it('normalizes upstream errors', () => {
    expect(normalizeError(401, {}).code).toBe('AUTH');
    expect(normalizeError(400, { error: { code: 'content_policy_violation' } }).code).toBe('CONTENT_POLICY');
    expect(normalizeError(429, {}).code).toBe('RATE_LIMIT');
    expect(normalizeError(500, 'boom').code).toBe('UPSTREAM');
  });

  it('sniffs image types', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from('<svg/>'))).toBeNull();
  });

  it('keeps keys on the server and prefers keys added in the app over env', () => {
    const store = tmpStore({ META_MODEL_API_KEY: 'env-key-1234' });
    expect(store.list().providers.find((p) => p.id === 'meta')).toMatchObject({ configured: true, source: 'env', keyHint: '••••1234' });
    store.update('meta', { apiKey: 'app-key-9876' });
    const listed = JSON.stringify(store.list());
    expect(listed).not.toContain('app-key-9876');
    expect(listed).not.toContain('env-key-1234');
    expect(store.config('meta').apiKey).toBe('app-key-9876');
    const reloaded = new ProviderStore(store.file, {});
    expect(reloaded.config('meta').apiKey).toBe('app-key-9876');
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
    store.remove('meta');
    expect(store.config('meta').apiKey).toBe('env-key-1234');
  });

  it('generates through an OpenAI-compatible host with the bearer key', async () => {
    const store = tmpStore();
    store.update('custom', { apiKey: 'good-key', baseUrl: base, model: 'muse-image-1.0' });
    const out = await generateImage(store, { prompt: 'a calm desk', aspect: '4:5', provider: 'custom' });
    expect(out.type).toBe('image/png');
    expect(out.revisedPrompt).toBe('a calm desk');
    const call = seen.at(-1);
    expect(call.url).toBe('/v1/images/generations');
    expect(call.auth).toBe('Bearer good-key');
    expect(call.body).toMatchObject({ model: 'muse-image-1.0', prompt: 'a calm desk', n: 1, response_format: 'b64_json' });
  });

  it('reports bad keys, policy blocks and missing keys by code', async () => {
    const store = tmpStore();
    await expect(generateImage(store, { prompt: 'x', aspect: '1:1', provider: 'meta' })).rejects.toMatchObject({ code: 'NO_KEY' });
    store.update('custom', { apiKey: 'wrong', baseUrl: base, model: 'm' });
    await expect(generateImage(store, { prompt: 'x', aspect: '1:1', provider: 'custom' })).rejects.toMatchObject({ code: 'AUTH' });
    store.update('custom', { apiKey: 'good-key' });
    mode = 'policy';
    await expect(generateImage(store, { prompt: 'x', aspect: '1:1', provider: 'custom' })).rejects.toMatchObject({ code: 'CONTENT_POLICY' });
    mode = 'strict';
    const out = await generateImage(store, { prompt: 'x', aspect: '1:1', provider: 'custom' });
    expect(out.type).toBe('image/png');
    expect(seen.at(-1).body).not.toHaveProperty('response_format');
    mode = 'ok';
  });

  it('checks keys for free via the model list', async () => {
    const store = tmpStore();
    store.update('custom', { apiKey: 'good-key', baseUrl: base, model: 'muse-image-1.0' });
    expect(await testProvider(store, 'custom')).toMatchObject({ ok: true, verified: true, modelListed: true });
    store.update('custom', { apiKey: 'nope' });
    expect(await testProvider(store, 'custom')).toMatchObject({ ok: false, code: 'AUTH' });
  });
});

describe('image routes', () => {
  const call = async (routes, { method, pathname, body, remote = '127.0.0.1', headers = {} }) => {
    let out = null;
    const req = {
      method,
      headers: { host: 'localhost:8787', ...headers },
      socket: { remoteAddress: remote },
    };
    const res = {
      writeHead: (status, h) => (out = { status, headers: h }),
      end: (data) => (out.data = data),
    };
    const send = (r, status, b) => {
      out = { status, body: b };
    };
    const r = createImageRoutes({ send, readJson: async () => body ?? {}, corsHeaders: () => ({}), rateLimited: () => false, dataDir: routes.dir, adminToken: routes.token, env: {} });
    if (routes.prime) await routes.prime(r);
    await r.handle(req, res, new URL(`http://local${pathname}`));
    return out;
  };

  it('only lets this machine (or the admin token) change keys', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-routes-'));
    const remote = await call({ dir }, { method: 'PUT', pathname: '/api/image/providers/meta', body: { apiKey: 'k-1234' }, remote: '203.0.113.9' });
    expect(remote.status).toBe(403);
    const proxied = await call({ dir }, { method: 'PUT', pathname: '/api/image/providers/meta', body: { apiKey: 'k-1234' }, headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(proxied.status).toBe(403);
    const crossSite = await call({ dir }, { method: 'PUT', pathname: '/api/image/providers/meta', body: { apiKey: 'k-1234' }, headers: { origin: 'https://evil.example' } });
    expect(crossSite.status).toBe(403);
    const local = await call({ dir }, { method: 'PUT', pathname: '/api/image/providers/meta', body: { apiKey: 'k-1234' } });
    expect(local.status).toBe(200);
    expect(JSON.stringify(local.body)).not.toContain('k-1234');
    const withToken = await call({ dir, token: 'secret-token' }, { method: 'DELETE', pathname: '/api/image/providers/meta', remote: '203.0.113.9', headers: { 'x-admin-token': 'secret-token' } });
    expect(withToken.status).toBe(200);
  });

  it('returns image bytes from POST /api/image', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-routes-'));
    const out = await call(
      { dir, prime: (r) => r.store.update('custom', { apiKey: 'good-key', baseUrl: base, model: 'muse-image-1.0' }) },
      { method: 'POST', pathname: '/api/image', body: { prompt: 'a calm desk', aspect: '4:5', provider: 'custom' } },
    );
    expect(out.status).toBe(200);
    expect(out.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(out.data, PNG)).toBe(0);
  });
});
