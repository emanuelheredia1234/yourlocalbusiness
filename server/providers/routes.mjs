// HTTP routes for AI, mounted by ai-server.mjs:
//
//   GET  /api/ai/providers                 → catalog, per-key settings (keys masked), routing, canManage
//   PUT  /api/ai/providers/:id             { apiKey?, removeKey?, enabled?, functions?, effort?, models? }   (admin)
//   PUT  /api/ai/settings                  { order }                                                         (admin)
//   GET  /api/ai/providers/:id/models?kind → built-in models plus the account's live list                   (admin)
//   POST /api/ai/providers/:id/test        { compare?: string[] } → free key check, or a paid effort comparison (admin)
//   POST /api/ai/generate                  { fn, prompt, images?, tier?, brain? } → { text, meta }
//   POST /api/ai/image                     { prompt, aspect } → image bytes (meta in the x-ai-meta header)
//   POST /api/ai/video                     { prompt, aspect, duration, firstFrame? } → job
//   GET  /api/ai/video/:id                 → job;  GET /api/ai/video/:id/content → video bytes
//   POST /api/ai/manus/create | /output | /continue   (Manus tasks, same shapes as the Zapier actions)
//   GET  /api/ai/usage                     → recent requests and totals
//
// "admin" = this machine, or the ADMIN_TOKEN header. Generation routes refuse other sites' pages.

import crypto from 'node:crypto';
import path from 'node:path';
import { FUNCTIONS, FUNCTION_GROUPS, PROVIDERS, describeProviders, effortLabel, fnById } from './registry.mjs';
import { AIStore } from './store.mjs';
import { UsageLog } from './usage.mjs';
import { AIRouter, asProviderError } from './router.mjs';
import { ASPECTS } from './adapters/images.mjs';
import { parseDataUrl } from './http.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Settings changes are allowed from this machine (no proxy in between) or with the ADMIN_TOKEN header. */
export function canManage(req, adminToken) {
  const token = req.headers['x-admin-token'];
  if (adminToken && typeof token === 'string' && token.length === adminToken.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(adminToken))) return true;
  const forwarded = req.headers['x-forwarded-for'] || req.headers.forwarded;
  return LOOPBACK.has(req.socket.remoteAddress || '') && !forwarded;
}

/** Requests must come from this app's own page (or the one allowed origin), never from another site. */
export function sameOrigin(req, allowedOrigin) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (allowedOrigin && origin === allowedOrigin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const MAX_PROMPT_CHARS = 120_000;
const MAX_MEDIA_PROMPT = 4000;
const VIDEO_ASPECTS = new Set(['9:16', '1:1', '16:9', '3:4', '4:3']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const cleanImages = (list) =>
  (Array.isArray(list) ? list : [])
    .slice(0, 2)
    .filter((u) => {
      const d = parseDataUrl(u);
      return d && IMAGE_TYPES.has(d.mime);
    });

export function createAIRoutes({ send, readJson, corsHeaders, rateLimited, dataDir, adminToken = '', allowedOrigin = '', env = process.env, fetch = globalThis.fetch, baseUrls = {} }) {
  const store = new AIStore(path.join(dataDir, 'ai-providers.json'), { env, legacyFile: path.join(dataDir, 'image-providers.json') });
  const usage = new UsageLog(path.join(dataDir, 'ai-usage.json'));
  const router = new AIRouter({ store, usage, fetch, baseUrls });

  const reply = (req, res, status, body, headers) => send(res, status, body, { ...corsHeaders(req), ...headers });

  const fail = (req, res, e) => {
    const err = asProviderError(e);
    if (err.code === 'UPSTREAM' && !err.provider) console.error(e);
    return reply(req, res, err.status || 502, { error: err.message, code: err.code, ...(err.attempts ? { attempts: err.attempts } : {}) });
  };

  const admin = (req, res) => {
    if (!sameOrigin(req, allowedOrigin)) {
      reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
      return false;
    }
    if (!canManage(req, adminToken)) {
      reply(req, res, 403, {
        error: adminToken ? 'Enter the admin token to change AI settings.' : 'AI settings can only be changed from the machine running the server. On Replit, add a Secret named ADMIN_TOKEN and enter it here.',
        code: 'FORBIDDEN',
      });
      return false;
    }
    return true;
  };

  const generationAllowed = (req, res, bucket) => {
    if (!sameOrigin(req, allowedOrigin)) {
      reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
      return false;
    }
    if (rateLimited(`${bucket}:${req.socket.remoteAddress || 'unknown'}`)) {
      reply(req, res, 429, { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMIT' });
      return false;
    }
    return true;
  };

  async function body(req, res) {
    try {
      return await readJson(req);
    } catch (e) {
      reply(req, res, e.status || 400, { error: e.message, code: 'BAD_REQUEST' });
      return null;
    }
  }

  /** Aborts provider calls when the browser goes away. */
  const abortOnClose = (res) => {
    const c = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) c.abort();
    });
    return c.signal;
  };

  const state = (req) => ({ ...store.list(), canManage: canManage(req, adminToken), adminTokenSet: !!adminToken, imported: store.imported });

  async function handle(req, res, url) {
    const p = url.pathname;
    const m = req.method;

    if (p === '/api/ai/providers' && m === 'GET') {
      return reply(req, res, 200, { catalog: describeProviders(), functions: FUNCTIONS, groups: FUNCTION_GROUPS, state: state(req) });
    }

    const prov = /^\/api\/ai\/providers\/([a-z]+)(\/models|\/test)?$/.exec(p);
    if (prov && PROVIDERS[prov[1]]) {
      const id = prov[1];
      if (!prov[2] && m === 'PUT') {
        if (!admin(req, res)) return;
        const b = await body(req, res);
        if (!b) return;
        try {
          store.update(id, b);
          return reply(req, res, 200, { state: state(req) });
        } catch (e) {
          return reply(req, res, e.status || 400, { error: e.message, code: 'BAD_REQUEST' });
        }
      }
      if (prov[2] === '/models' && m === 'GET') {
        if (!admin(req, res)) return;
        const kind = url.searchParams.get('kind') || 'text';
        return reply(req, res, 200, await router.models(id, kind, { signal: abortOnClose(res) }));
      }
      if (prov[2] === '/test' && m === 'POST') {
        if (!admin(req, res)) return;
        const b = await body(req, res);
        if (!b) return;
        try {
          if (Array.isArray(b.compare)) return reply(req, res, 200, await router.compareEfforts(id, b.compare, { signal: abortOnClose(res) }));
          return reply(req, res, 200, await router.checkKey(id, { signal: abortOnClose(res) }));
        } catch (e) {
          return fail(req, res, e);
        }
      }
    }

    if (p === '/api/ai/settings' && m === 'PUT') {
      if (!admin(req, res)) return;
      const b = await body(req, res);
      if (!b) return;
      try {
        store.setOrder(b.order);
        return reply(req, res, 200, { state: state(req) });
      } catch (e) {
        return reply(req, res, e.status || 400, { error: e.message, code: 'BAD_REQUEST' });
      }
    }

    if (p === '/api/ai/usage' && m === 'GET') {
      return reply(req, res, 200, { recent: usage.recent(Number(url.searchParams.get('limit')) || 50), totals: usage.totals() });
    }

    if (p === '/api/ai/generate' && m === 'POST') {
      if (!generationAllowed(req, res, 'gen')) return;
      const b = await body(req, res);
      if (!b) return;
      const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
      if (!prompt) return reply(req, res, 400, { error: 'Missing prompt', code: 'BAD_REQUEST' });
      if (prompt.length > MAX_PROMPT_CHARS) return reply(req, res, 413, { error: 'Prompt too long', code: 'BAD_REQUEST' });
      const fn = typeof b.fn === 'string' ? b.fn : '';
      if (fnById[fn]?.kind !== 'text') return reply(req, res, 400, { error: 'Unknown AI function.', code: 'BAD_REQUEST' });
      const signal = abortOnClose(res);
      try {
        const out = await router.text(fn, { prompt, images: cleanImages(b.images), tier: b.tier === 'quick' ? 'quick' : 'default', brain: typeof b.brain === 'boolean' ? b.brain : null, signal });
        return reply(req, res, 200, out);
      } catch (e) {
        if (signal.aborted) return;
        return fail(req, res, e);
      }
    }

    if (p === '/api/ai/image' && m === 'POST') {
      if (!generationAllowed(req, res, 'img')) return;
      const b = await body(req, res);
      if (!b) return;
      const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
      if (!prompt) return reply(req, res, 400, { error: 'Missing prompt', code: 'BAD_REQUEST' });
      if (prompt.length > MAX_MEDIA_PROMPT) return reply(req, res, 413, { error: 'Image prompt too long', code: 'BAD_REQUEST' });
      const signal = abortOnClose(res);
      try {
        const out = await router.image({ prompt, aspect: ASPECTS[b.aspect] ? b.aspect : '1:1', signal });
        res.writeHead(200, {
          'content-type': out.contentType,
          'cache-control': 'no-store',
          'x-ai-meta': encodeURIComponent(JSON.stringify(out.meta)),
          ...(out.revisedPrompt ? { 'x-revised-prompt': encodeURIComponent(out.revisedPrompt.slice(0, 1500)) } : {}),
          'access-control-expose-headers': 'x-ai-meta, x-revised-prompt',
          ...corsHeaders(req),
        });
        return res.end(out.bytes);
      } catch (e) {
        if (signal.aborted) return;
        return fail(req, res, e);
      }
    }

    if (p === '/api/ai/video' && m === 'POST') {
      if (!generationAllowed(req, res, 'vid')) return;
      const b = await body(req, res);
      if (!b) return;
      const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
      if (!prompt) return reply(req, res, 400, { error: 'Missing prompt', code: 'BAD_REQUEST' });
      if (prompt.length > MAX_MEDIA_PROMPT) return reply(req, res, 413, { error: 'Video prompt too long', code: 'BAD_REQUEST' });
      const firstFrame = typeof b.firstFrame === 'string' && parseDataUrl(b.firstFrame) && IMAGE_TYPES.has(parseDataUrl(b.firstFrame).mime) ? b.firstFrame : null;
      try {
        // one-shot paid job: started once, never retried
        const job = await router.startVideo({ prompt, aspect: VIDEO_ASPECTS.has(b.aspect) ? b.aspect : '9:16', duration: Math.max(1, Math.min(15, Number(b.duration) || 8)), firstFrame });
        return reply(req, res, 200, { job });
      } catch (e) {
        return fail(req, res, e);
      }
    }

    const vid = /^\/api\/ai\/video\/(vid_[0-9a-f-]{36})(\/content)?$/.exec(p);
    if (vid && m === 'GET') {
      try {
        if (!vid[2]) return reply(req, res, 200, { job: await router.videoStatus(vid[1], { signal: abortOnClose(res) }) });
        const out = await router.videoContent(vid[1], { signal: abortOnClose(res) });
        res.writeHead(200, { 'content-type': out.contentType, 'content-length': out.bytes.length, 'cache-control': 'no-store', ...corsHeaders(req) });
        return res.end(out.bytes);
      } catch (e) {
        return fail(req, res, e);
      }
    }

    const mt = /^\/api\/ai\/manus\/(create|output|continue)$/.exec(p);
    if (mt && m === 'POST') {
      if (!generationAllowed(req, res, mt[1] === 'output' ? 'manus-read' : 'manus')) return;
      const b = await body(req, res);
      if (!b) return;
      try {
        if (mt[1] === 'create') {
          const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
          if (!prompt) return reply(req, res, 400, { error: 'Missing prompt', code: 'BAD_REQUEST' });
          const image = typeof b.image_data_url === 'string' && parseDataUrl(b.image_data_url) ? { dataUrl: b.image_data_url, filename: typeof b.image_filename === 'string' ? b.image_filename.slice(0, 120) : 'image.jpg' } : null;
          // one-shot write: never retried
          return reply(req, res, 200, await router.manusCreate({ fn: b.fn, prompt: prompt.slice(0, 20_000), title: typeof b.title === 'string' ? b.title : '', interactive: b.interactive_mode === true || b.interactive_mode === 'true', hidden: b.hide_in_task_list === true || b.hide_in_task_list === 'true', image }));
        }
        const taskId = typeof b.task_id === 'string' ? b.task_id.trim() : '';
        if (!/^[A-Za-z0-9_-]{6,64}$/.test(taskId)) return reply(req, res, 400, { error: 'Missing task id', code: 'BAD_REQUEST' });
        if (mt[1] === 'output') {
          const out = await router.manusOutput({ taskId, maxImages: Math.max(0, Math.min(8, Number(b.max_images) || 0)), maxImageBytes: Math.max(1, Math.min(30_000_000, Number(b.max_image_bytes) || 15_000_000)), signal: abortOnClose(res) });
          return reply(req, res, 200, out);
        }
        const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
        if (!prompt) return reply(req, res, 400, { error: 'Missing message', code: 'BAD_REQUEST' });
        return reply(req, res, 200, await router.manusContinue({ taskId, prompt: prompt.slice(0, 20_000) }));
      } catch (e) {
        return fail(req, res, e);
      }
    }

    return false;
  }

  return {
    store,
    router,
    usage,
    match: (url) => url.pathname.startsWith('/api/ai/'),
    handle,
    /** For /api/health: which keys are ready, their model and effort per kind, and what powers each function. */
    health: () => ({
      ready: store.order().some((id) => store.ready(id)),
      providers: store.order().map((id) => {
        const s = store.settings(id);
        return {
          id,
          label: PROVIDERS[id].label,
          ready: store.ready(id),
          models: s.models,
          effort: Object.fromEntries(Object.entries(s.effort).map(([kind, value]) => [kind, { id: value, label: value ? effortLabel(id, kind, value) : 'Set by the model' }])),
        };
      }),
      routing: store.routing(),
    }),
  };
}
