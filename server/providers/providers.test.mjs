import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FUNCTION_IDS, PROVIDER_IDS, defaultEffort, effortIds, estimateCost, supports } from './registry.mjs';
import { AIStore } from './store.mjs';
import { UsageLog } from './usage.mjs';
import { AIRouter } from './router.mjs';
import { createAIRoutes } from './routes.mjs';
import { chatUsage } from './adapters/chat.mjs';
import { scrubKeys } from './http.mjs';
import { MP4, PNG, createMockProviders, reasoningFor } from '../test/mock-providers.mjs';

const ENV = { OPENROUTER_API_KEY: 'or-key-1111', GEMINI_API_KEY: 'g-key-2222', XAI_API_KEY: 'x-key-3333', ANTHROPIC_API_KEY: 'a-key-4444', META_MODEL_API_KEY: 'm-key-5555', MANUS_API_KEY: 'mn-key-6666', OPENAI_API_KEY: 'o-key-7777' };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-ai-'));

let mock;
beforeAll(async () => {
  mock = await createMockProviders({ keys: { openrouter: 'or-key-1111', google: 'g-key-2222', xai: 'x-key-3333', anthropic: 'a-key-4444', meta: 'm-key-5555', manus: 'mn-key-6666', openai: 'o-key-7777' } }).start();
});
afterAll(() => mock.close());
beforeEach(() => mock.reset());

/** A router where only `ids` (in that order) have keys. */
function setup(ids = PROVIDER_IDS, env = ENV) {
  const dir = tmpDir();
  const keys = Object.fromEntries(Object.entries(env).filter(([name]) => ids.some((id) => ({ openrouter: 'OPENROUTER_API_KEY', google: 'GEMINI_API_KEY', xai: 'XAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', meta: 'META_MODEL_API_KEY', manus: 'MANUS_API_KEY', openai: 'OPENAI_API_KEY' })[id] === name)));
  const store = new AIStore(path.join(dir, 'ai-providers.json'), { env: keys });
  store.setOrder(ids);
  const usage = new UsageLog('');
  const router = new AIRouter({ store, usage, baseUrls: mock.baseUrls() });
  return { store, usage, router, dir };
}

describe('registry', () => {
  it('lets some key power every function', () => {
    for (const fn of FUNCTION_IDS) expect(PROVIDER_IDS.some((id) => supports(id, fn).ok), fn).toBe(true);
  });

  it('explains what a key can’t do', () => {
    expect(supports('openai', 'videos')).toMatchObject({ ok: false, reason: expect.stringMatching(/Sora/) });
    expect(supports('manus', 'research')).toMatchObject({ ok: false, reason: expect.stringMatching(/agent/) });
    expect(supports('anthropic', 'photos').ok).toBe(false);
    expect(supports('manus', 'facebook').ok).toBe(true);
    expect(supports('google', 'facebook').ok).toBe(false);
  });

  it('offers only the efforts each model accepts', () => {
    expect(effortIds('anthropic', 'text', 'claude-opus-5-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortIds('openai', 'text', 'gpt-6.1-sol')).not.toContain('none');
    expect(effortIds('openai', 'text', 'gpt-5.5')).toContain('none');
    expect(effortIds('xai', 'text', 'grok-4.20')).toEqual([]);
    expect(effortIds('meta', 'text', 'muse-spark-1.3-contributor')).not.toContain('max');
    expect(effortIds('google', 'image', 'gemini-3.1-flash-lite-image')).toEqual(['1K']);
    // a model picked from the live list gets the provider's list
    expect(effortIds('openai', 'text', 'gpt-7-preview')).toContain('max');
    expect(defaultEffort('anthropic', 'text', 'claude-sonnet-5-5')).toBe('high');
    expect(defaultEffort('manus', 'agent', 'manus')).toBe('standard');
  });

  it('estimates cost from tokens and list prices', () => {
    expect(estimateCost('anthropic', 'text', 'claude-opus-5-5', { input: 1_000_000, output: 100_000 })).toBe(6);
    expect(estimateCost('openai', 'image', 'gpt-image-2.5-flare', { input: 40, output: 1056 })).toBeCloseTo(0.03188, 6);
    expect(estimateCost('meta', 'image', 'muse-image-1.0', null)).toBe(0.011);
    expect(estimateCost('openrouter', 'video', 'heygen/heygen-video-1', null, { seconds: 8, effort: '768p' })).toBeCloseTo(0.288, 6);
    expect(estimateCost('openai', 'text', 'unknown-model', { input: 5, output: 5 })).toBeNull();
  });
});

describe('key store', () => {
  it('prefers Secrets, never lists a key, and saves privately', () => {
    const dir = tmpDir();
    const store = new AIStore(path.join(dir, 'ai.json'), { env: { OPENAI_API_KEY: 'sk-secret-env-1234' } });
    store.update('openai', { apiKey: 'sk-typed-in-app-9876' });
    store.update('google', { apiKey: 'AIza-typed-5555' });
    expect(store.key('openai')).toBe('sk-secret-env-1234');
    expect(store.keySource('openai')).toBe('secrets');
    expect(store.keySource('google')).toBe('app');
    const listed = JSON.stringify(store.list());
    for (const k of ['sk-secret-env-1234', 'sk-typed-in-app-9876', 'AIza-typed-5555']) expect(listed).not.toContain(k);
    expect(store.list().providers.find((p) => p.id === 'openai')).toMatchObject({ keyHint: '••••1234', envKey: 'OPENAI_API_KEY', configured: true });
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
    expect(new AIStore(store.file, { env: {} }).key('google')).toBe('AIza-typed-5555');
    store.update('google', { removeKey: true });
    expect(store.key('google')).toBe('');
  });

  it('powers everything a new key supports, until functions are chosen', () => {
    const store = new AIStore(path.join(tmpDir(), 'ai.json'), { env: { XAI_API_KEY: 'x' } });
    expect(store.settings('xai').functions).toEqual(FUNCTION_IDS.filter((f) => supports('xai', f).ok));
    store.update('xai', { functions: ['research', 'code', 'facebook', 'bogus'] });
    expect(store.settings('xai').functions).toEqual(['research', 'code']);
    expect(store.route('research')).toEqual(['xai']);
    expect(store.route('seo')).toEqual([]);
    store.update('xai', { enabled: false });
    expect(store.route('research')).toEqual([]);
  });

  it('checks effort against the chosen model', () => {
    const store = new AIStore(path.join(tmpDir(), 'ai.json'), { env: {} });
    store.update('openai', { effort: { text: 'max' } });
    expect(store.settings('openai').effort.text).toBe('max');
    expect(() => store.update('openai', { effort: { text: 'none' } })).toThrow(/isn’t an effort/);
    store.update('openai', { models: { text: 'gpt-5.5' } });
    // gpt-5.5 has no "max": its own default applies
    expect(store.settings('openai').effort.text).toBe('medium');
    expect(() => store.update('openai', { models: { text: 'bad model name!' } })).toThrow(/valid model/);
  });

  it('imports image keys saved by the old Image generation page', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'image-providers.json'), JSON.stringify({ active: 'meta', providers: { meta: { apiKey: 'meta-old-1111' }, custom: { apiKey: 'c' } } }));
    const store = new AIStore(path.join(dir, 'ai-providers.json'), { env: {}, legacyFile: path.join(dir, 'image-providers.json') });
    expect(store.imported).toBe(true);
    expect(store.key('meta')).toBe('meta-old-1111');
    expect(store.settings('meta').functions).toEqual(['photos']);
    expect(fs.existsSync(path.join(dir, 'ai-providers.json'))).toBe(true);
  });

  it('keeps the priority order', () => {
    const store = new AIStore(path.join(tmpDir(), 'ai.json'), { env: { OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' } });
    store.setOrder(['openai', 'nope', 'anthropic']);
    expect(store.order().slice(0, 2)).toEqual(['openai', 'anthropic']);
    expect(store.order()).toHaveLength(PROVIDER_IDS.length);
    expect(store.route('research')).toEqual(['openai', 'anthropic']);
  });
});

describe('effort travels in each provider’s own field and comes back in the usage', () => {
  const cases = [
    { id: 'anthropic', effort: 'high', path: '/v1/messages', field: (b) => b.output_config.effort },
    { id: 'openai', effort: 'xhigh', path: '/responses', field: (b) => b.reasoning.effort },
    { id: 'google', effort: 'low', path: '/interactions', field: (b) => b.generation_config.thinking_level },
    { id: 'xai', effort: 'high', path: '/chat/completions', field: (b) => b.reasoning_effort },
    { id: 'meta', effort: 'xhigh', path: '/chat/completions', field: (b) => b.reasoning_effort },
    { id: 'openrouter', effort: 'max', path: '/chat/completions', field: (b) => b.reasoning.effort },
  ];
  for (const c of cases) {
    it(c.id, async () => {
      const { store, router, usage } = setup([c.id]);
      store.update(c.id, { effort: { text: c.effort } });
      const out = await router.text('research', { prompt: 'Find product ideas', tier: 'default' });
      const sent = mock.last(c.id, c.path);
      expect(c.field(sent.body)).toBe(c.effort);
      expect(out.text).toContain('mock answer');
      expect(out.meta).toMatchObject({ provider: c.id, fn: 'research', effort: c.effort, model: store.settings(c.id).models.text });
      // billed output includes the reasoning the effort bought
      expect(out.meta.usage.output).toBe(150 + reasoningFor(c.effort));
      if (c.id !== 'anthropic') expect(out.meta.usage.reasoning).toBe(reasoningFor(c.effort));
      expect(out.meta.cost.usd).toBeGreaterThan(0);
      expect(out.meta.cost.source).toBe(c.id === 'openrouter' ? 'provider' : 'estimate');
      expect(usage.recent(1)[0]).toMatchObject({ ok: true, provider: c.id, effort: c.effort });
    });
  }

  it('sends the app’s instructions and Claude’s fallbacks', async () => {
    const { router, store } = setup(['anthropic']);
    await router.text('seo', { prompt: 'Write SEO metadata', tier: 'quick' });
    let sent = mock.last('anthropic', '/v1/messages');
    expect(sent.body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16000, fallbacks: 'default' });
    expect(sent.body.system).toMatch(/JSON/);
    expect(sent.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(sent.headers.authorization).toBe('Bearer a-key-4444');
    store.update('anthropic', { models: { text: 'claude-haiku-5-5' } });
    await router.text('seo', { prompt: 'Write SEO metadata' });
    sent = mock.last('anthropic', '/v1/messages');
    expect(sent.body.fallbacks).toBeUndefined();
    expect(sent.body.max_tokens).toBe(64000);
  });

  it('sends images to vision models', async () => {
    const { router } = setup(['openai']);
    const img = `data:image/png;base64,${PNG.toString('base64')}`;
    await router.text('brand', { prompt: 'Describe this logo', images: [img] });
    const content = mock.last('openai', '/responses').body.input[0].content;
    expect(content[0]).toEqual({ type: 'input_image', image_url: img });
    expect(content[1]).toMatchObject({ type: 'input_text' });
  });

  it('shows more reasoning and cost at higher effort', async () => {
    const { router } = setup(['xai']);
    const out = await router.compareEfforts('xai', ['low', 'xhigh']);
    expect(out.field).toBe('reasoning_effort');
    const [low, high] = out.results;
    expect(low).toMatchObject({ effort: 'low', ok: true });
    expect(high.usage.reasoning).toBeGreaterThan(low.usage.reasoning);
    expect(high.cost.usd).toBeGreaterThan(low.cost.usd);
    expect(mock.calls.filter((x) => x.provider === 'xai').map((x) => x.body.reasoning_effort)).toEqual(['low', 'xhigh']);
  });

  it('reads reasoning counted beside or inside completion tokens', () => {
    expect(chatUsage({ prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 100 }, total_tokens: 115 })).toEqual({ input: 10, output: 105, reasoning: 100 });
    expect(chatUsage({ prompt_tokens: 10, completion_tokens: 105, completion_tokens_details: { reasoning_tokens: 100 }, total_tokens: 115 })).toEqual({ input: 10, output: 105, reasoning: 100 });
  });
});

describe('photos', () => {
  it('OpenAI: quality and an exact size', async () => {
    const { router, store } = setup(['openai']);
    store.update('openai', { effort: { image: 'high' } });
    const out = await router.image({ prompt: 'a desk', aspect: '4:5' });
    expect(mock.last('openai', '/images/generations').body).toMatchObject({ model: 'gpt-image-2.5-flare', quality: 'high', size: '1232x1536', n: 1 });
    expect(out.contentType).toBe('image/png');
    expect(out.meta).toMatchObject({ provider: 'openai', effort: 'high', cost: { source: 'estimate' } });
    expect(out.meta.cost.usd).toBeCloseTo((40 * 5 + 4160 * 30) / 1e6, 6);
  });

  it('Google: image size and ratio in response_format', async () => {
    const { router, store } = setup(['google']);
    store.update('google', { effort: { image: '4K' } });
    await router.image({ prompt: 'a desk', aspect: '21:8' });
    expect(mock.last('google', '/interactions').body.response_format).toEqual({ type: 'image', aspect_ratio: '21:9', image_size: '4K' });
    expect(mock.last('google', '/interactions').headers['x-goog-api-key']).toBe('g-key-2222');
  });

  it('xAI quality, Meta reasoning strength (with its charge), OpenRouter cost', async () => {
    let s = setup(['xai']);
    s.store.update('xai', { effort: { image: 'medium' } });
    await s.router.image({ prompt: 'p', aspect: '9:16' });
    expect(mock.last('xai', '/images/generations').body).toMatchObject({ quality: 'medium', aspect_ratio: '9:16', response_format: 'b64_json' });

    s = setup(['meta']);
    s.store.update('meta', { effort: { image: 'low' } });
    const meta = await s.router.image({ prompt: 'p', aspect: '1:1' });
    expect(mock.last('meta', '/images/generations').body).toMatchObject({ reasoning_strength: 'low', size: '1536x1536' });
    expect(meta.meta.cost).toEqual({ usd: 0.011, source: 'provider' });

    s = setup(['openrouter']);
    const or = await s.router.image({ prompt: 'p', aspect: '1.91:1' });
    expect(mock.last('openrouter', '/images').body).toMatchObject({ model: 'meta/muse-image', aspect_ratio: '16:9' });
    expect(or.meta.cost).toEqual({ usd: 0.01, source: 'provider' });
  });

  it('leaves Manus photos to the agent flow', async () => {
    const { router, store } = setup(['manus']);
    expect(store.route('photos')).toEqual(['manus']);
    await expect(router.image({ prompt: 'p', aspect: '1:1' })).rejects.toMatchObject({ code: 'USE_AGENT' });
  });
});

describe('videos', () => {
  const waitDone = async (router, job) => {
    for (let i = 0; i < 8 && job.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 2600));
      job = await router.videoStatus(job.id);
    }
    return job;
  };

  it('OpenRouter: resolution, duration, first frame; reported cost; the file', async () => {
    const { router, store } = setup(['openrouter']);
    store.update('openrouter', { effort: { video: '768p' } });
    const frame = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64')}`;
    let job = await router.startVideo({ prompt: 'a candle', aspect: '1:1', duration: 6, firstFrame: frame });
    expect(mock.last('openrouter', '/videos').body).toEqual({ model: 'heygen/heygen-video-1', prompt: 'a candle', duration: 6, aspect_ratio: '1:1', resolution: '768p', frame_images: [{ type: 'first_frame', image_url: frame }] });
    job = await waitDone(router, job);
    expect(job).toMatchObject({ state: 'done', meta: { provider: 'openrouter', effort: '768p', cost: { usd: 0.16, source: 'provider' } } });
    const file = await router.videoContent(job.id);
    expect(file.bytes.equals(MP4)).toBe(true);
    expect(file.contentType).toBe('video/mp4');
  }, 30_000);

  it('xAI: resolution and duration; Google Omni: resolution in response_format', async () => {
    let s = setup(['xai']);
    s.store.update('xai', { effort: { video: '1080p' } });
    let job = await s.router.startVideo({ prompt: 'p', aspect: '9:16', duration: 20 });
    expect(mock.last('xai', '/videos/generations').body).toMatchObject({ resolution: '1080p', duration: 15, aspect_ratio: '9:16' });
    job = await waitDone(s.router, job);
    expect(job.state).toBe('done');
    expect((await s.router.videoContent(job.id)).bytes.length).toBe(MP4.length);

    s = setup(['google']);
    job = await s.router.startVideo({ prompt: 'p', aspect: '16:9', duration: 8 });
    // Gemini Omni answers in one long call that runs in the background
    for (let i = 0; i < 50 && job.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = await s.router.videoStatus(job.id);
    }
    expect(job.state).toBe('done');
    expect(mock.last('google', '/interactions').body.response_format).toEqual({ type: 'video', aspect_ratio: '16:9', resolution: '720p' });
  }, 30_000);

  it('puts keys that can make the shape first, and never retries a job that may have started', async () => {
    let s = setup(['google', 'xai']);
    await s.router.startVideo({ prompt: 'p', aspect: '1:1' });
    await new Promise((r) => setTimeout(r, 100));
    expect(mock.calls.some((x) => x.provider === 'google')).toBe(false); // Gemini Omni has no 1:1
    expect(mock.last('xai', '/videos/generations').body.aspect_ratio).toBe('1:1');

    s = setup(['xai', 'openrouter']);
    mock.reset();
    mock.behavior.xai = 'fail500'; // the job may exist: don't start another one elsewhere
    await expect(s.router.startVideo({ prompt: 'p', aspect: '16:9' })).rejects.toMatchObject({ code: 'UPSTREAM' });
    expect(mock.calls.some((x) => x.provider === 'openrouter')).toBe(false);
    mock.reset();
    mock.behavior.xai = 'rate'; // a 429 started nothing: next key
    const job = await s.router.startVideo({ prompt: 'p', aspect: '16:9' });
    expect(job.meta.provider).toBe('openrouter');
    expect(job.meta.attempts[0]).toMatchObject({ provider: 'xai', code: 'RATE_LIMIT' });
  });
});

describe('Manus tasks', () => {
  it('uses the key’s agent profile, attaches the image, and reports credits', async () => {
    const { router, store, usage } = setup(['manus']);
    store.update('manus', { effort: { agent: 'max-high' } });
    const created = await router.manusCreate({ fn: 'facebook', prompt: 'Schedule this post', title: 'FB', interactive: true, image: { dataUrl: `data:image/png;base64,${PNG.toString('base64')}`, filename: 'post.png' } });
    expect(created).toMatchObject({ ok: true, task_id: 'task000001', meta: { effort: 'max-high', provider: 'manus' } });
    const sent = mock.last('manus', '/v2/task.create');
    expect(sent.body).toMatchObject({ agent_profile: 'max-high', interactive_mode: true, hide_in_task_list: false, title: 'FB' });
    expect(sent.body.message.content[1]).toMatchObject({ type: 'file', filename: 'post.png', mime_type: 'image/png' });
    expect(sent.headers['x-manus-api-key']).toBe('mn-key-6666');

    let out = await router.manusOutput({ taskId: created.task_id, maxImages: 8, maxImageBytes: 1 });
    expect(out).toMatchObject({ status: 'running', done: false });
    out = await router.manusOutput({ taskId: created.task_id, maxImages: 8, maxImageBytes: 1 });
    expect(out).toMatchObject({ status: 'stopped', done: true, image_count: 1, credit_usage: 41 });
    expect(out.images[0]).toMatchObject({ size_bytes: PNG.length, base64: '' });
    out = await router.manusOutput({ taskId: created.task_id, maxImages: 1, maxImageBytes: 5_000_000 });
    expect(Buffer.from(out.images[0].base64, 'base64').equals(PNG)).toBe(true);
    expect(out.text).toMatch(/RESULT: SCHEDULED/);
    expect(usage.recent(1)[0]).toMatchObject({ provider: 'manus', credits: 41, pending: false });
  });

  it('photos use the image effort; Manus must be set to power the function', async () => {
    const { router, store } = setup(['manus']);
    store.update('manus', { effort: { image: 'lite' }, functions: ['photos'] });
    await router.manusCreate({ fn: 'photos', prompt: 'one image', hidden: true });
    expect(mock.last('manus', '/v2/task.create').body).toMatchObject({ agent_profile: 'lite', hide_in_task_list: true, message: { content: 'one image' } });
    await expect(router.manusCreate({ fn: 'facebook', prompt: 'x' })).rejects.toMatchObject({ code: 'NO_PROVIDER' });
  });
});

describe('routing between keys', () => {
  it('falls back to the next key and says why', async () => {
    const { router, usage } = setup(['openai', 'google']);
    mock.behavior.openai = 'fail500';
    const out = await router.text('ads', { prompt: 'Write ads' });
    expect(out.meta.provider).toBe('google');
    expect(out.meta.attempts).toEqual([expect.objectContaining({ provider: 'openai', code: 'UPSTREAM' })]);
    expect(usage.recent(2).map((e) => [e.provider, e.ok])).toEqual([
      ['google', true],
      ['openai', false],
    ]);
  });

  it('doesn’t shop a blocked prompt around', async () => {
    const { router } = setup(['openai', 'google']);
    mock.behavior.openai = 'policy';
    await expect(router.text('ads', { prompt: 'x' })).rejects.toMatchObject({ code: 'CONTENT_POLICY' });
    expect(mock.calls.some((x) => x.provider === 'google')).toBe(false);
  });

  it('says when no key powers a function', async () => {
    const { router, store } = setup(['openai']);
    store.update('openai', { functions: ['research'] });
    await expect(router.text('email', { prompt: 'x' })).rejects.toMatchObject({ code: 'NO_PROVIDER', message: expect.stringMatching(/Emails & lead magnets/) });
  });

  it('keeps keys out of error messages', async () => {
    const { router } = setup(['openai']);
    mock.behavior.openai = 'auth';
    const err = await router.text('ads', { prompt: 'x' }).catch((e) => e);
    expect(err.code).toBe('AUTH');
    expect(err.message).not.toContain('sk-abc123');
    expect(scrubKeys('bad key sk-or-v1-abcdef123456 and AIzaSyD123456789012')).toBe('bad key [key] and [key]');
  });
});

// ───────────── HTTP routes ─────────────

function startApp({ adminToken = '', env = ENV } = {}) {
  const dataDir = tmpDir();
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'));
        } catch {
          reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
        }
      });
    });
  const ai = createAIRoutes({ send, readJson, corsHeaders: () => ({}), rateLimited: () => false, dataDir, adminToken, env, baseUrls: mock.baseUrls() });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    ai.handle(req, res, url).then((h) => h === false && send(res, 404, { error: 'Not found' }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ ai, server, base: `http://127.0.0.1:${server.address().port}` })));
}

describe('HTTP routes', () => {
  let app;
  beforeAll(async () => {
    app = await startApp({ adminToken: 'admin-secret-token' });
  });
  afterAll(() => app.server.close());

  const call = (p, init = {}) => fetch(`${app.base}${p}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });

  it('lists providers without any key', async () => {
    const r = await call('/api/ai/providers');
    const text = await r.text();
    for (const k of Object.values(ENV)) expect(text).not.toContain(k);
    const j = JSON.parse(text);
    expect(j.catalog.map((p) => p.id)).toEqual(PROVIDER_IDS);
    expect(j.functions.length).toBe(FUNCTION_IDS.length);
    expect(j.state.canManage).toBe(true); // loopback, no proxy
    expect(j.state.routing.research[0]).toBe('openrouter');
  });

  it('lets only this machine or the admin token change settings', async () => {
    const proxied = { 'x-forwarded-for': '203.0.113.9' };
    let r = await call('/api/ai/providers/openai', { method: 'PUT', headers: proxied, body: JSON.stringify({ effort: { text: 'high' } }) });
    expect(r.status).toBe(403);
    r = await call('/api/ai/providers/openai', { method: 'PUT', headers: { ...proxied, 'x-admin-token': 'admin-secret-token' }, body: JSON.stringify({ effort: { text: 'high' }, functions: ['research', 'photos'] }) });
    expect(r.status).toBe(200);
    const openai = (await r.json()).state.providers.find((p) => p.id === 'openai');
    expect(openai).toMatchObject({ effort: { text: 'high' }, functions: ['research', 'photos'] });
    r = await call('/api/ai/providers/openai', { method: 'PUT', headers: { origin: 'https://evil.example' }, body: JSON.stringify({ enabled: false }) });
    expect(r.status).toBe(403);
    r = await call('/api/ai/settings', { method: 'PUT', body: JSON.stringify({ order: ['openai'] }) });
    expect((await r.json()).state.order[0]).toBe('openai');
  });

  it('generates with the function’s key and returns what it used', async () => {
    const r = await call('/api/ai/generate', { method: 'POST', body: JSON.stringify({ fn: 'research', prompt: 'ideas', brain: true }) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.meta).toMatchObject({ provider: 'openai', effort: 'high', effortField: 'reasoning.effort' });
    expect(mock.last('openai', '/responses').body.reasoning.effort).toBe('high');
    const bad = await call('/api/ai/generate', { method: 'POST', body: JSON.stringify({ fn: 'photos', prompt: 'x' }) });
    expect(bad.status).toBe(400);
    const usage = await (await call('/api/ai/usage')).json();
    expect(usage.recent[0]).toMatchObject({ provider: 'openai', fn: 'research', brain: true });
  });

  it('returns photo bytes with the meta in a header', async () => {
    const r = await call('/api/ai/image', { method: 'POST', body: JSON.stringify({ prompt: 'a desk', aspect: '1:1' }) });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    const meta = JSON.parse(decodeURIComponent(r.headers.get('x-ai-meta')));
    expect(meta.provider).toBe('openai');
    expect(Buffer.from(await r.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('runs a free key check and lists live models', async () => {
    let r = await call('/api/ai/providers/openai/test', { method: 'POST', body: '{}' });
    expect(await r.json()).toMatchObject({ ok: true });
    r = await call('/api/ai/providers/openai/models?kind=text');
    const j = await r.json();
    expect(j.source).toBe('live');
    expect(j.models.map((m) => m.id)).toContain('gpt-6.1-sol');
  });
});

// ───────────── the real server ─────────────

describe('ai-server.mjs', () => {
  it('serves health and generation from env keys', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const port = 18000 + Math.floor(Math.random() * 1000);
    const child = spawn(process.execPath, [path.join(here, '..', 'ai-server.mjs')], {
      env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tmpDir(), AI_PROVIDER_BASE_URLS: JSON.stringify(mock.baseUrls()), GEMINI_API_KEY: ENV.GEMINI_API_KEY },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (d) => {
          out += d;
          if (out.includes('server on')) resolve();
        });
        child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
        setTimeout(() => reject(new Error(`server didn’t start: ${out}`)), 10_000);
      });
      const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
      expect(health).toMatchObject({ ok: true, ai: { ready: true } });
      expect(health.ai.routing.research).toEqual(['google']);
      expect(health.ai.routing.facebook).toEqual([]);
      const r = await fetch(`http://127.0.0.1:${port}/api/ai/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fn: 'code', prompt: 'a calculator' }) });
      const j = await r.json();
      expect(j.meta).toMatchObject({ provider: 'google', model: 'gemini-3.8-flash', effort: 'medium' });
      expect((await fetch(`http://127.0.0.1:${port}/api/generate`, { method: 'POST' })).status).toBe(404);
    } finally {
      child.kill();
    }
  }, 20_000);
});
