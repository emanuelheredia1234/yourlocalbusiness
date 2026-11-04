import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FUNCTION_IDS, PROVIDERS, PROVIDER_IDS, adapterId, defaultEffort, effortIds, estimateCost, supports } from './registry.mjs';
import { AIStore } from './store.mjs';
import { UsageLog } from './usage.mjs';
import { AIRouter } from './router.mjs';
import { createAIRoutes, sameOrigin } from './routes.mjs';
import { chatUsage } from './adapters/chat.mjs';
import { scrubKeys } from './http.mjs';
import { MP4, PNG, createMockProviders, reasoningFor } from '../test/mock-providers.mjs';

const ENV = { OPENROUTER_API_KEY: 'or-key-1111', OPENROUTER_API_KEY_2: 'or2-key-8888', GEMINI_API_KEY: 'g-key-2222', XAI_API_KEY: 'x-key-3333', ANTHROPIC_API_KEY: 'a-key-4444', META_MODEL_API_KEY: 'm-key-5555', MANUS_API_KEY: 'mn-key-6666', OPENAI_API_KEY: 'o-key-7777' };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ylb-ai-'));

let mock;
beforeAll(async () => {
  mock = await createMockProviders({ keys: { openrouter: ['or-key-1111', 'or2-key-8888'], google: 'g-key-2222', xai: 'x-key-3333', anthropic: 'a-key-4444', meta: 'm-key-5555', manus: 'mn-key-6666', openai: 'o-key-7777' } }).start();
});
afterAll(() => mock.close());
beforeEach(() => mock.reset());

/** A router where only `ids` (in that order) have keys. */
function setup(ids = PROVIDER_IDS, env = ENV) {
  const dir = tmpDir();
  const keys = Object.fromEntries(Object.entries(env).filter(([name]) => ids.some((id) => PROVIDERS[id].envKeys.includes(name))));
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

describe('extra OpenRouter key slots', () => {
  it('are separate keys that share OpenRouter’s models, efforts and API', () => {
    expect(PROVIDER_IDS.slice(0, 4)).toEqual(['openrouter', 'openrouter2', 'openrouter3', 'openrouter4']);
    expect(PROVIDERS.openrouter3).toMatchObject({ label: 'OpenRouter 3', envKeys: ['OPENROUTER_API_KEY_3'] });
    expect(adapterId('openrouter4')).toBe('openrouter');
    expect(adapterId('openai')).toBe('openai');
    expect(effortIds('openrouter2', 'text', 'google/gemini-3.8-flash')).toEqual(effortIds('openrouter', 'text', 'google/gemini-3.8-flash'));
    expect(supports('openrouter2', 'videos').ok).toBe(true);
  });

  it('let one OpenRouter key power product research while another does the rest', async () => {
    const { store, router } = setup(['openrouter', 'openrouter2']);
    store.update('openrouter', { functions: FUNCTION_IDS.filter((f) => f !== 'research' && supports('openrouter', f).ok) });
    store.update('openrouter2', { functions: ['research'], models: { text: 'anthropic/claude-opus-5.5' }, effort: { text: 'high' } });
    expect(store.route('research')).toEqual(['openrouter2']);
    const research = await router.text('research', { prompt: 'Find winning products' });
    let sent = mock.last('openrouter', '/chat/completions');
    expect(research.meta).toMatchObject({ provider: 'openrouter2', providerLabel: 'OpenRouter 2', model: 'anthropic/claude-opus-5.5', effort: 'high' });
    expect(sent.headers.authorization).toBe('Bearer or2-key-8888');
    expect(sent.body).toMatchObject({ model: 'anthropic/claude-opus-5.5', reasoning: { effort: 'high' } });
    const seo = await router.text('seo', { prompt: 'Write SEO metadata' });
    sent = mock.last('openrouter', '/chat/completions');
    expect(seo.meta.provider).toBe('openrouter');
    expect(sent.headers.authorization).toBe('Bearer or-key-1111');
    expect(sent.body.model).toBe('google/gemini-3.8-flash');
  });

  it('show up next to OpenRouter in an order saved before they existed', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify({ providers: {}, order: ['openai', 'openrouter', 'google', 'xai', 'anthropic', 'meta', 'manus'] }));
    const store = new AIStore(path.join(dir, 'ai.json'), { env: {} });
    expect(store.order()).toEqual(['openai', 'openrouter', 'openrouter2', 'openrouter3', 'openrouter4', 'google', 'xai', 'anthropic', 'meta', 'manus']);
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

  it('only reads or continues tasks this app started, also after a restart', async () => {
    const { store, usage, dir } = setup(['manus']);
    const tasksFile = path.join(dir, 'ai-tasks.json');
    const router = new AIRouter({ store, usage, baseUrls: mock.baseUrls(), tasksFile });
    // a task in the same Manus account that the app didn't start stays private
    await expect(router.manusOutput({ taskId: 'otherTask123' })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(router.manusContinue({ taskId: 'otherTask123', prompt: 'hello' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mock.calls.some((c) => c.provider === 'manus')).toBe(false);
    const t = await router.manusCreate({ fn: 'facebook', prompt: 'Schedule it' });
    const restarted = new AIRouter({ store, usage, baseUrls: mock.baseUrls(), tasksFile });
    await expect(restarted.manusOutput({ taskId: t.task_id, maxImages: 0 })).resolves.toMatchObject({ task_id: t.task_id });
    await expect(restarted.manusContinue({ taskId: t.task_id, prompt: 'thanks' })).resolves.toEqual({ ok: true });
  });

  it('photos use the image effort; Manus must be set to power the function', async () => {
    const { router, store } = setup(['manus']);
    store.update('manus', { effort: { image: 'lite' }, functions: ['photos'] });
    await router.manusCreate({ fn: 'photos', prompt: 'one image', hidden: true });
    expect(mock.last('manus', '/v2/task.create').body).toMatchObject({ agent_profile: 'lite', hide_in_task_list: true, message: { content: 'one image' } });
    await expect(router.manusCreate({ fn: 'facebook', prompt: 'x' })).rejects.toMatchObject({ code: 'NO_PROVIDER' });
  });

  it('a brand-voice read runs on Social posting; the stand-in reports the voice, or waits for you to sign in first', async () => {
    const { router } = setup(['manus']);
    // the first lines of src/ai/manusVoice.ts voicePrompt (the stand-in answers on those)
    const prompt = (profile) => `Read the latest posts of one Instagram profile and describe how they sound and look, so that new posts can continue the same brand voice. Use your web browser.\n\nThe Instagram account: https://www.instagram.com/${profile}/\n`;
    const read = await router.manusCreate({ fn: 'facebook', prompt: prompt('copper'), interactive: true });
    await router.manusOutput({ taskId: read.task_id });
    const out = await router.manusOutput({ taskId: read.task_id });
    expect(out).toMatchObject({ done: true, status: 'stopped' });
    expect(out.text).toMatch(/^VOICE TONE: friendly \|/m);
    expect(out.text).toMatch(/^EXAMPLE: /m);
    expect(out.text).toMatch(/RESULT: VOICE READ \| 15$/);

    const waits = await router.manusCreate({ fn: 'facebook', prompt: prompt('needs-signin'), interactive: true });
    expect(await router.manusOutput({ taskId: waits.task_id })).toMatchObject({ status: 'waiting', waiting: true, waiting_type: 'needConnectMyBrowser', done: false });

    const closed = await router.manusCreate({ fn: 'facebook', prompt: prompt('private.copper'), interactive: true });
    await router.manusOutput({ taskId: closed.task_id });
    expect((await router.manusOutput({ taskId: closed.task_id })).text).toMatch(/RESULT: FAILED \| The account is private/);
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

  it('accepts the Replit preview host only through the local proxy', () => {
    const previewRequest = {
      headers: { origin: 'https://preview.example', host: 'localhost:8787', 'x-forwarded-host': 'preview.example' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    expect(sameOrigin(previewRequest, '')).toBe(true);
    expect(sameOrigin({ ...previewRequest, socket: { remoteAddress: '203.0.113.9' } }, '')).toBe(false);
    expect(sameOrigin({ ...previewRequest, headers: { ...previewRequest.headers, origin: 'https://evil.example' } }, '')).toBe(false);
  });

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
    r = await call('/api/ai/settings', {
      method: 'PUT',
      headers: {
        origin: 'https://preview.example',
        'x-forwarded-host': 'preview.example',
        ...proxied,
        'x-admin-token': 'admin-secret-token',
      },
      body: JSON.stringify({ order: ['openai'] }),
    });
    expect(r.status).toBe(200);
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

  it('passes up to 4 images with a writing request, and only real image data URLs', async () => {
    const png = `data:image/png;base64,${PNG.toString('base64')}`;
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;
    let r = await call('/api/ai/generate', { method: 'POST', body: JSON.stringify({ fn: 'research', prompt: 'ideas', images: [png, png, png, png, png] }) });
    expect(r.status).toBe(200);
    let content = mock.last('openai', '/responses').body.input[0].content;
    expect(content.filter((c) => c.type === 'input_image')).toHaveLength(4);
    expect(content.at(-1)).toMatchObject({ type: 'input_text' });
    r = await call('/api/ai/generate', { method: 'POST', body: JSON.stringify({ fn: 'research', prompt: 'ideas', images: [svg, 'https://example.com/a.png', png] }) });
    expect(r.status).toBe(200);
    content = mock.last('openai', '/responses').body.input[0].content;
    expect(content.filter((c) => c.type === 'input_image').map((c) => c.image_url)).toEqual([png]);
  });

  it('returns photo bytes with the meta in a header', async () => {
    const r = await call('/api/ai/image', { method: 'POST', body: JSON.stringify({ prompt: 'a desk', aspect: '1:1' }) });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    const meta = JSON.parse(decodeURIComponent(r.headers.get('x-ai-meta')));
    expect(meta.provider).toBe('openai');
    expect(Buffer.from(await r.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('saves a key in an extra OpenRouter slot', async () => {
    const r = await call('/api/ai/providers/openrouter3', { method: 'PUT', body: JSON.stringify({ apiKey: 'sk-or-v1-slot3-9999', functions: ['research'] }) });
    expect(r.status).toBe(200);
    const slot = (await r.json()).state.providers.find((p) => p.id === 'openrouter3');
    expect(slot).toMatchObject({ configured: true, source: 'app', keyHint: '••••9999', functions: ['research'] });
  });

  it('shows usage only to the admin', async () => {
    const remote = { 'x-forwarded-for': '203.0.113.9' };
    expect((await call('/api/ai/usage', { headers: remote })).status).toBe(403);
    expect((await call('/api/ai/usage', { headers: { ...remote, 'x-admin-token': 'admin-secret-token' } })).status).toBe(200);
  });

  it('refuses Manus task ids it didn’t start', async () => {
    const r = await call('/api/ai/manus/output', { method: 'POST', body: JSON.stringify({ task_id: 'notOurs12345' }) });
    expect(r.status).toBe(404);
    expect((await r.json()).code).toBe('NOT_FOUND');
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

describe('the Assistant function', () => {
  it('is on for keys whose Powers list was saved before it existed, until unticked', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify({ providers: { openai: { functions: ['research', 'photos'] }, manus: { functions: ['facebook'] } }, order: [...PROVIDER_IDS] }));
    const store = new AIStore(path.join(dir, 'ai.json'), { env: { OPENAI_API_KEY: 'o', MANUS_API_KEY: 'm' } });
    // (Strategy was added later too: store.mjs ADDED_LATER)
    expect(store.settings('openai').functions).toEqual(['strategy', 'research', 'assistant', 'photos']);
    expect(store.route('assistant')).toEqual(['openai']);
    // Manus doesn't write, so it never powers the Assistant (Building pages & assets and Chat with Manus were
    // added later too: store.mjs ADDED_LATER_AGENTS)
    expect(store.settings('manus').functions).toEqual(['facebook', 'build', 'agentchat']);
    store.update('openai', { functions: ['research', 'photos'] });
    expect(store.settings('openai').functions).toEqual(['research', 'photos']);
    expect(new AIStore(store.file, { env: { OPENAI_API_KEY: 'o' } }).route('assistant')).toEqual([]);
    store.update('openai', { functions: ['research', 'assistant'] });
    expect(store.route('assistant')).toEqual(['openai']);
  });

  it('is on for a new key, like everything a key can do', () => {
    const store = new AIStore(path.join(tmpDir(), 'ai.json'), { env: { ANTHROPIC_API_KEY: 'a' } });
    expect(store.settings('anthropic').functions).toContain('assistant');
    expect(store.route('assistant')).toEqual(['anthropic']);
  });

  it('gets scripted steps from the provider mock, while other prompts get the usual answer', async () => {
    const { router } = setup(['openai']);
    const prompt = ['[ylb-assistant-protocol v1]', 'You are the assistant.', '', '## Workspace (JSON)', '{"project":{"id":"proj_1"},"somePosts":[{"id":"post_abc123","platform":"x"}]}', '', '## Latest message from the owner', 'What is due on my calendar?', '', '## Tool results so far this turn (JSON)', '[]', '', '## Reply format', 'JSON'].join('\n');
    const first = JSON.parse((await router.text('assistant', { prompt })).text);
    expect(first).toMatchObject({ done: false, actions: [{ tool: 'navigate', args: { route: 'calendar' } }, { tool: 'list_posts', args: { due: true } }] });
    const second = JSON.parse((await router.text('assistant', { prompt: prompt.replace('\n[]\n', '\n[{"step":1,"tool":"list_posts","ok":true,"status":"ok","result":{"total":2}}]\n') })).text);
    expect(second).toMatchObject({ done: true, actions: [] });
    expect(second.reply).toMatch(/2 posts are due/);
    const del = JSON.parse((await router.text('assistant', { prompt: prompt.replace('What is due on my calendar?', 'qa-delete please') })).text);
    expect(del.actions).toEqual([{ tool: 'delete_posts', args: { ids: ['post_abc123'] } }]);
    const plain = await router.text('research', { prompt: 'Find winning products' });
    expect(JSON.parse(plain.text)).toEqual({ ok: true, note: 'mock answer' });
  });

  it('is a text function /api/ai/generate accepts, routed in /api/health', async () => {
    const app = await startApp();
    try {
      const prompt = '[ylb-assistant-protocol v1]\n\n## Latest message from the owner\nhello\n\n## Tool results so far this turn (JSON)\n[]';
      const r = await fetch(`${app.base}/api/ai/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fn: 'assistant', prompt }) });
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(JSON.parse(j.text)).toMatchObject({ done: true, actions: [], reply: expect.stringContaining('QA assistant') });
      expect(j.meta.fn).toBe('assistant');
      expect((await app.ai.health()).routing.assistant.length).toBeGreaterThan(0);
    } finally {
      app.server.close();
    }
  });
});

// ───────────── building pages and assets, and chatting, with Manus ─────────────

describe('Manus builds and chats', () => {
  let app;
  beforeAll(async () => {
    app = await startApp({ adminToken: 'admin-secret-token' });
  });
  afterAll(() => app.server.close());

  const post = async (p, body, headers = {}) => {
    const r = await fetch(`${app.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* bytes */
    }
    return { status: r.status, json, text, headers: r.headers };
  };
  const BUILD = { target: 'asset', kind: 'booking', facts: [{ id: 'name', value: 'Bean & Leaf' }], website: 'https://beanleaf.example', request: 'A booking widget for my yoga classes', images: [{ key: 'img-1', note: 'the shop' }] };
  let n = 0;
  const ref = () => `ylb-P${String(++n).padStart(5, '0')}`;
  const start = async (request, o = {}) => {
    const r = await post('/api/ai/manus/create', { fn: 'build', build: { ...BUILD, request }, ref: ref(), ...o });
    expect(r.status).toBe(200);
    return r.json.task_id;
  };
  /** Read the build until it isn't working any more. */
  const settle = async (taskId) => {
    for (let i = 0; i < 8; i++) {
      const r = await post('/api/ai/manus/messages', { task_id: taskId });
      if (r.json.build?.state !== 'working') return r.json;
    }
    throw new Error('still working');
  };

  it('starts a build from the server’s template: no connected apps, never interactive, the profile chosen, up to 8 files', async () => {
    const files = Array.from({ length: 8 }, (_, i) => ({ file_id: `file0000${i}`, filename: `img-${i + 1}.jpg` }));
    const r = await post('/api/ai/manus/create', { fn: 'build', build: BUILD, ref: 'ylb-BUILD1', profile: 'max-high', files, prompt: 'IGNORED free text' });
    expect(r.json).toMatchObject({ ok: true, meta: { fn: 'build', effort: 'max-high' } });
    const sent = mock.last('manus', '/v2/task.create').body;
    expect(sent).toMatchObject({ agent_profile: 'max-high', interactive_mode: false, hide_in_task_list: false, clear_connectors: true, title: 'Build · Booking widget · Bean & Leaf · ylb-BUILD1' });
    expect(sent.message.content[0].text).toMatch(/^Build ONE web page as ONE self-contained HTML file\./);
    expect(sent.message.content[0].text).not.toContain('IGNORED');
    expect(sent.message.content.filter((c) => c.type === 'file')).toHaveLength(8);
    // an unknown profile falls back to the key's agent profile
    await post('/api/ai/manus/create', { fn: 'build', build: BUILD, ref: 'ylb-BUILD2', profile: 'turbo' });
    expect(mock.last('manus', '/v2/task.create').body.agent_profile).toBe('standard');
    // 9 files, a bad Ref, an unknown kind or an http website are refused before anything is sent
    const before = mock.calls.length;
    expect((await post('/api/ai/manus/create', { fn: 'build', build: BUILD, ref: 'ylb-BUILD3', files: [...files, { file_id: 'file00009', filename: 'img-9.jpg' }] })).status).toBe(400);
    expect((await post('/api/ai/manus/create', { fn: 'build', build: BUILD, ref: 'bad' })).status).toBe(400);
    expect((await post('/api/ai/manus/create', { fn: 'build', build: { ...BUILD, kind: 'casino' }, ref: 'ylb-BUILD4' })).status).toBe(400);
    expect((await post('/api/ai/manus/create', { fn: 'build', build: { ...BUILD, website: 'http://beanleaf.example' }, ref: 'ylb-BUILD5' })).json).toMatchObject({ code: 'BAD_WEBSITE' });
    expect(mock.calls.slice(before).some((c) => c.provider === 'manus' && c.path === '/v2/task.create')).toBe(false);
  });

  it('shows the exact message without starting anything (dry run), and refuses one that’s too long', async () => {
    const before = mock.calls.length;
    const r = await post('/api/ai/manus/create', { fn: 'agentchat', chat: { text: 'hello', website: '', images: [], brand: 'Bean & Leaf' }, ref: 'ylb-DRY001', dryRun: true });
    expect(r.json.preview).toMatchObject({ limit: 12000 });
    expect(r.json.preview.text).toContain('<<<MESSAGE\nhello\nMESSAGE>>>');
    expect(r.json.preview.chars).toBe(r.json.preview.text.length);
    const long = await post('/api/ai/manus/create', { fn: 'agentchat', chat: { text: 'x'.repeat(6001), website: '', images: [] }, ref: 'ylb-DRY002' });
    expect(long).toMatchObject({ status: 413, json: { code: 'TOO_LONG', chars: 6001, limit: 6000 } });
    expect(mock.calls.length).toBe(before);
  });

  it('reads a build’s latest round: built, then a change; markers for every other ending', async () => {
    const id = await start('A plain one');
    let r = await settle(id);
    expect(r.build).toMatchObject({ state: 'built', result: { source: 'file', filename: 'page.html' } });
    expect(r.credits).toBe(41);
    expect(JSON.stringify(r)).not.toContain('/files/page.html');
    const page = await post('/api/ai/manus/html', { task_id: id });
    expect(page.headers.get('content-type')).toMatch(/^application\/json/);
    expect(page.json).toMatchObject({ source: 'file', filename: 'page.html', at: r.build.result.at });
    expect(page.json.html).toContain('{{img-1}}');
    // Ask for changes: a new round in the same task; the old page doesn't count for it
    const edit = await post('/api/ai/manus/continue', { task_id: id, edit: { text: 'Make the button green', images: [{ key: 'img-2', note: '' }] }, files: [{ file_id: 'file00042', filename: 'img-2.jpg' }] });
    expect(edit.json).toEqual({ ok: true });
    const sent = mock.last('manus', '/v2/task.sendMessage').body;
    expect(sent.message.content[0].text).toMatch(/^Change page\.html as the owner asks below\./);
    expect(sent.message.content[1]).toEqual({ type: 'file', file_id: 'file00042', filename: 'img-2.jpg' });
    expect((await post('/api/ai/manus/messages', { task_id: id })).json.build.state).toBe('working');
    r = await settle(id);
    expect(r.build.state).toBe('built');
    expect(r.credits).toBe(82);
    // a build never takes a free prompt
    expect((await post('/api/ai/manus/continue', { task_id: id, prompt: 'do something else' })).status).toBe(400);

    const ending = async (marker) => (await settle(await start(marker))).build;
    expect(await ending('qa-manus-fail')).toMatchObject({ state: 'failed', reason: "QA: couldn't open the website." });
    expect(await ending('qa-manus-webdev')).toMatchObject({ state: 'failed', reason: 'Manus made a website in its own Manus account instead of a file.' });
    expect(await ending('qa-manus-nofile')).toMatchObject({ state: 'no_file', reason: 'Manus finished without page.html.' });
    expect(await ending('qa-manus-noresult')).toMatchObject({ state: 'built' });
    const zip = await start('qa-manus-zip');
    expect((await settle(zip)).build).toMatchObject({ state: 'no_file', reason: 'Manus sent page.zip, not one HTML file.' });
    // the fixed follow-up builds it
    await post('/api/ai/manus/continue', { task_id: zip, followup: 'missing_file' });
    expect(mock.last('manus', '/v2/task.sendMessage').body.message.content).toMatch(/^I didn't receive page\.html\./);
    expect((await settle(zip)).build.state).toBe('built');
    const webdev = await start('qa-manus-webdev');
    expect((await settle(webdev)).webdev).toBe(true);
    expect((await post('/api/ai/manus/html', { task_id: webdev })).json).toMatchObject({ code: 'WEBDEV' });
  });

  it('a question is answered here; an approval waits in Manus; background work keeps it working', async () => {
    const ask = await start('qa-manus-ask');
    let r = await settle(ask);
    expect(r).toMatchObject({ status: 'waiting', waiting: { type: 'messageAskUser', answerHere: true }, build: { state: 'needs_you', reason: 'Which colors do you prefer?' } });
    await post('/api/ai/manus/continue', { task_id: ask, answer: 'Blue and white' });
    expect(mock.last('manus', '/v2/task.sendMessage').body.message.content).toBe('My answer, in my own words:\n<<<ANSWER\nBlue and white\nANSWER>>>\nKeep to all the rules in my first message.');
    expect((await settle(ask)).build.state).toBe('built');
    r = await settle(await start('qa-manus-approve'));
    expect(r).toMatchObject({ waiting: { type: 'needConnectMyBrowser', answerHere: false }, build: { state: 'needs_you' } });
    const bg = await start('qa-manus-bg');
    let saw = false;
    for (let i = 0; i < 8; i++) {
      const x = (await post('/api/ai/manus/messages', { task_id: bg })).json;
      if (x.build.reason === 'Manus is still finishing in the background.') saw = true;
      if (x.build.state === 'built') break;
    }
    expect(saw).toBe(true);
  });

  it('refuses pages it can’t use: a zip, one over 1.5 MB', async () => {
    const zip = await start('qa-manus-zip');
    const r = await settle(zip);
    expect(r.build.state).toBe('no_file');
    const at = `${r.events.find((e) => e.files.some((f) => f.name === 'page.zip')).id}:0`;
    expect((await post('/api/ai/manus/html', { task_id: zip, at })).json).toMatchObject({ code: 'NOT_HTML', filename: 'page.zip' });
    const big = await start('qa-manus-big');
    await settle(big);
    expect(await post('/api/ai/manus/html', { task_id: big })).toMatchObject({ status: 413, json: { code: 'TOO_BIG' } });
  });

  it('chats: the opening once, then the owner’s words as typed; replies with options, files and delivery kinds', async () => {
    const c = await post('/api/ai/manus/create', { fn: 'agentchat', chat: { text: 'hello', website: '', images: [], brand: 'Bean & Leaf' }, ref: 'ylb-CHAT01' });
    const created = mock.last('manus', '/v2/task.create').body;
    expect(created).toMatchObject({ interactive_mode: true, clear_connectors: true, title: 'Chat · Bean & Leaf · ylb-CHAT01' });
    const id = c.json.task_id;
    let r;
    for (let i = 0; i < 6 && !r?.events?.some((e) => e.type === 'assistant'); i++) r = (await post('/api/ai/manus/messages', { task_id: id })).json;
    expect(r.events.find((e) => e.type === 'assistant')).toMatchObject({ text: 'QA Manus: I read your message (5 characters).', deliveryKind: 'result' });
    expect(r.build).toBeUndefined();
    const last = r.events[0].id;
    await post('/api/ai/manus/continue', { task_id: id, chat: { text: 'qa-manus-question and qa-manus-image', website: 'https://beanleaf.example', images: [] } });
    expect(mock.last('manus', '/v2/task.sendMessage').body.message.content).toBe('qa-manus-question and qa-manus-image\n\nMy website: https://beanleaf.example/');
    for (let i = 0; i < 6 && r.status !== 'waiting'; i++) r = (await post('/api/ai/manus/messages', { task_id: id, after: last })).json;
    expect(r.waiting).toMatchObject({ answerHere: true });
    expect(r.events.every((e) => e.id !== last)).toBe(true);
    expect(r.events.find((e) => e.options)).toMatchObject({ options: ['Blue', 'Green'] });
    // a chat takes chat messages only
    expect((await post('/api/ai/manus/continue', { task_id: id, prompt: 'free' })).status).toBe(400);
    await post('/api/ai/manus/continue', { task_id: id, chat: { text: 'qa-manus-image please', website: '', images: [] } });
    for (let i = 0; i < 6 && !r.events?.some((e) => e.files.some((f) => f.kind === 'image')); i++) r = (await post('/api/ai/manus/messages', { task_id: id })).json;
    const image = r.events.flatMap((e) => e.files).find((f) => f.kind === 'image');
    const file = await post('/api/ai/manus/file', { task_id: id, at: image.id });
    expect(file.headers.get('content-type')).toBe('application/octet-stream');
    expect(file.headers.get('x-file-type')).toBe('image/png');
    expect(file.headers.get('content-disposition')).toBe('attachment; filename="photo.png"');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(file.headers.get('cache-control')).toBe('no-store');
  });

  it('stops a task; finds one by its Ref after an uncertain start; never touches tasks it didn’t start', async () => {
    const id = await start('stop me');
    expect((await post('/api/ai/manus/stop', { task_id: id })).json).toEqual({ ok: true });
    expect(mock.last('manus', '/v2/task.stop').body).toEqual({ task_id: id });
    expect((await post('/api/ai/manus/messages', { task_id: id })).json.status).toBe('stopped');
    // a task started (by another tab, say) that this server doesn't know yet is found by its title's Ref
    const created = await fetch(`${mock.baseUrls().manus}/v2/task.create`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-manus-api-key': 'mn-key-6666' }, body: JSON.stringify({ title: 'Build · Pricing table · Bean & Leaf · ylb-LOST01', message: { content: 'Build ONE web page as ONE self-contained HTML file.' } }) }).then((x) => x.json());
    const v = await post('/api/ai/manus/verify', { ref: 'ylb-LOST01', sent_at: Date.now() - 1000 });
    expect(v.json).toEqual({ found: true, task_id: created.task_id, task_url: `https://manus.im/app/${created.task_id}` });
    expect(app.ai.router.manusTasks.get(created.task_id)).toMatchObject({ fn: 'build', ref: 'ylb-LOST01' });
    expect((await post('/api/ai/manus/verify', { ref: 'ylb-NOPE01', sent_at: Date.now() })).json).toEqual({ found: false });
    for (const route of ['messages', 'html', 'file', 'stop']) expect((await post(`/api/ai/manus/${route}`, { task_id: 'notOurs12345', at: 'e1:0' })).status).toBe(404);
  });

  it('needs Building pages & assets (or Chat with Manus) ticked, and says which is missing', async () => {
    app.ai.store.update('manus', { functions: ['facebook'] });
    try {
      const r = await post('/api/ai/manus/create', { fn: 'build', build: BUILD, ref: 'ylb-TICK01' });
      expect(r).toMatchObject({ status: 409, json: { code: 'NO_PROVIDER', reason: 'not_ticked' } });
      const h = await app.ai.health(null, { headers: {}, socket: { remoteAddress: '127.0.0.1' } });
      expect(h.agents.manus).toMatchObject({ build: { ready: false, reason: 'not_ticked' }, chat: { ready: false, reason: 'not_ticked' }, own: false, profile: 'standard' });
    } finally {
      app.ai.store.update('manus', { functions: ['facebook', 'photos', 'build', 'agentchat'] });
    }
    const h = await app.ai.health(null, { headers: {}, socket: { remoteAddress: '127.0.0.1' } });
    expect(h.agents.manus.build).toEqual({ ready: true, reason: 'ok' });
  });
});

describe('Manus build and chat tasks', () => {
  it('are kept 30 days (other Manus tasks 7)', async () => {
    const { ttlOf } = await import('./router.mjs');
    expect(ttlOf({ fn: 'build' })).toBe(30 * 24 * 3600_000);
    expect(ttlOf({ fn: 'agentchat' })).toBe(30 * 24 * 3600_000);
    expect(ttlOf({ fn: 'facebook' })).toBe(7 * 24 * 3600_000);
    const dir = tmpDir();
    const tasksFile = path.join(dir, 'ai-tasks.json');
    const day = 24 * 3600_000;
    fs.writeFileSync(tasksFile, JSON.stringify({ tasks: { old1: { fn: 'build', at: Date.now() - 20 * day }, old2: { fn: 'facebook', at: Date.now() - 20 * day }, old3: { fn: 'agentchat', at: Date.now() - 31 * day } } }));
    const { store, usage } = setup(['manus']);
    const router = new AIRouter({ store, usage, baseUrls: mock.baseUrls(), tasksFile });
    expect([...router.manusTasks.keys()]).toEqual(['old1']);
  });

  it('are on for Manus keys saved before they existed, until unticked', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify({ providers: { manus: { functions: ['facebook'], seen: ['strategy', 'research', 'facebook', 'photos'] } }, order: [...PROVIDER_IDS] }));
    const store = new AIStore(path.join(dir, 'ai.json'), { env: { MANUS_API_KEY: 'm' } });
    expect(store.settings('manus').functions).toEqual(['facebook', 'build', 'agentchat']);
    store.update('manus', { functions: ['facebook'] });
    expect(store.settings('manus').functions).toEqual(['facebook']);
  });
});
