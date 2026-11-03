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
//   GET  /api/ai/usage                     → recent requests and totals                                      (admin)
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
    const originHost = new URL(origin).host;
    if (originHost === req.headers.host) return true;

    // Replit's preview proxy sends /api requests through the local Vite proxy,
    // which changes Host to localhost:8787. Trust its forwarded host only for
    // requests that actually arrived from this machine.
    const forwardedHost = req.headers['x-forwarded-host'];
    return LOOPBACK.has(req.socket.remoteAddress || '')
      && typeof forwardedHost === 'string'
      && forwardedHost.split(',').map((host) => host.trim()).includes(originHost);
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

const NO_ACCOUNTS = { enabled: false, signInRequired: false, identify: async () => null };
const LOCAL_ONLY = { enabled: false, get: async () => null, version: async () => null, put: async () => null };
const NO_USER_KEYS = { enabled: false, get: async () => null, info: async () => ({ manus: null }), set: async () => {}, remove: async () => {} };

/**
 * auth (server/auth.mjs): with accounts on, AI needs a signed-in user, the owner (ADMIN_EMAILS) manages
 * the keys, and each video job or Manus task can only be read by whoever started it.
 */
export function createAIRoutes({ send, readJson, corsHeaders, rateLimited, dataDir, adminToken = '', allowedOrigin = '', env = process.env, fetch = globalThis.fetch, baseUrls = {}, auth = NO_ACCOUNTS, userKeys = NO_USER_KEYS, appState = LOCAL_ONLY }) {
  // appState (server/appState.mjs): with Supabase's secret key, the owner's keys and settings, the
  // Manus task list and the usage log are also kept in Supabase, so they survive restarts
  const store = new AIStore(path.join(dataDir, 'ai-providers.json'), { env, legacyFile: path.join(dataDir, 'image-providers.json'), remote: appState });
  const usage = new UsageLog(path.join(dataDir, 'ai-usage.json'), { remote: appState });
  const router = new AIRouter({ store, usage, fetch, baseUrls, tasksFile: path.join(dataDir, 'ai-tasks.json'), remote: appState });
  // hosts that wipe the disk when the app restarts or sleeps (keys typed into the app would vanish)
  const ephemeralDisk = !!(env.REPLIT_DEPLOYMENT || env.VERCEL);

  /** A settings change is kept on this server; report if it didn't also reach Supabase. */
  const savedReply = async (req, res, who) => {
    try {
      await store.persisted();
    } catch (e) {
      return reply(req, res, 502, { error: `${e.message} The change works on this server for now, but may be lost when the app restarts.`, code: 'NOT_SAVED', cause: e.code || 'UNREACHABLE', state: state(req, who) });
    }
    return reply(req, res, 200, { state: state(req, who) });
  };

  /** Wait for a look at Supabase, but never long: a slow Supabase mustn't hold up the app. */
  const freshEnough = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms).unref?.())]);

  /**
   * Run an AI request; if this copy of the server knows no key for it, look in Supabase once and try
   * again (a key may have just been added through another copy). "No key" is decided before anything
   * is sent to a provider, so the second try can't start paid work twice.
   */
  const withFreshKeys = async (run) => {
    try {
      return await run();
    } catch (e) {
      if (e?.code !== 'NO_PROVIDER' && e?.code !== 'USE_AGENT') throw e;
      if (!store.remote.enabled) throw e;
      await freshEnough(store.refresh({ force: true }), 2500);
      return run();
    }
  };

  const reply = (req, res, status, body, headers) => send(res, status, body, { ...corsHeaders(req), ...headers });

  const fail = (req, res, e) => {
    const err = asProviderError(e);
    if (err.code === 'UPSTREAM' && !err.provider) console.error(e);
    return reply(req, res, err.status || 502, { error: err.message, code: err.code, ...(err.attempts ? { attempts: err.attempts } : {}) });
  };

  /**
   * The owner. With accounts on: only someone signed in with an ADMIN_EMAILS address (an admin token
   * left in a shared browser, or a request from this machine, must not make another account the owner).
   * Without accounts: this machine, or the ADMIN_TOKEN.
   */
  const isAdmin = (req, who) => (auth.enabled ? !!who?.isAdmin : canManage(req, adminToken));

  const admin = (req, res, who) => {
    if (!sameOrigin(req, allowedOrigin)) {
      reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
      return false;
    }
    if (!isAdmin(req, who)) {
      const error = auth.enabled
        ? 'Only the app’s owner can change the AI keys. Sign in with the email in the ADMIN_EMAILS Secret.'
        : adminToken
          ? 'Enter the admin token to change AI settings.'
          : 'AI settings can only be changed from the machine running the server. On Replit, add a Secret named ADMIN_TOKEN and enter it here.';
      reply(req, res, 403, { error, code: 'FORBIDDEN' });
      return false;
    }
    return true;
  };

  /** A signed-in user is needed when accounts are on. */
  const signedIn = (req, res, who) => {
    if (auth.signInRequired && !who) {
      reply(req, res, 401, { error: 'Sign in to use AI.', code: 'AUTH_REQUIRED' });
      return false;
    }
    return true;
  };

  const generationAllowed = (req, res, bucket, who) => {
    if (!sameOrigin(req, allowedOrigin)) {
      reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
      return false;
    }
    if (!signedIn(req, res, who)) return false;
    if (rateLimited(`${bucket}:${who ? `user:${who.id}` : req.socket.remoteAddress || 'unknown'}`)) {
      reply(req, res, 429, { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMIT' });
      return false;
    }
    return true;
  };

  /** Jobs and tasks belong to whoever started them (older ones have no owner). */
  const mayUse = (req, owner, who) => !owner || owner === who?.id || isAdmin(req, who);
  const notFound = (req, res) => reply(req, res, 404, { error: 'Not found.', code: 'NOT_FOUND' });

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

  const state = (req, who) => ({ ...store.list(), canManage: isAdmin(req, who), adminTokenSet: !!adminToken, imported: store.imported, storage: store.storage, storageProblem: store.storageProblem, ephemeralDisk, accounts: auth.enabled, supabaseUrlSet: !!env.SUPABASE_URL });

  /** The signed-in user behind a request (null when signed out, or accounts are off). */
  async function whoIs(req, res) {
    if (!auth.enabled || !req.headers.authorization) return { who: null };
    try {
      return { who: await auth.identify(req) };
    } catch (e) {
      reply(req, res, e.status || 503, { error: e.message, code: e.code || 'AUTH_UNAVAILABLE' });
      return null;
    }
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    const ident = await whoIs(req, res);
    if (!ident) return;
    const { who } = ident;
    // keys or settings changed through another copy of the server: looked up every few seconds,
    // in the background (AI requests never wait for Supabase)
    const looked = store.refresh();

    if (p === '/api/ai/providers' && m === 'GET') {
      if (!signedIn(req, res, who)) return;
      // the settings page shows the newest settings (but doesn't wait long for them)
      await freshEnough(looked, 2500);
      // with accounts on, only the owner sees the keys' settings
      const show = !auth.enabled || isAdmin(req, who);
      return reply(req, res, 200, { catalog: describeProviders(), functions: FUNCTIONS, groups: FUNCTION_GROUPS, state: show ? state(req, who) : null, role: show ? 'admin' : 'user' });
    }

    const prov = /^\/api\/ai\/providers\/([a-z][a-z0-9]*)(\/models|\/test)?$/.exec(p);
    if (prov && PROVIDERS[prov[1]]) {
      const id = prov[1];
      if (!prov[2] && m === 'PUT') {
        if (!admin(req, res, who)) return;
        const b = await body(req, res);
        if (!b) return;
        try {
          // start from the newest settings, so this change can't undo one saved elsewhere
          await store.refresh({ force: true });
          store.update(id, b);
          return await savedReply(req, res, who);
        } catch (e) {
          return reply(req, res, e.status || 400, { error: e.message, code: 'BAD_REQUEST' });
        }
      }
      if (prov[2] === '/models' && m === 'GET') {
        if (!admin(req, res, who)) return;
        const kind = url.searchParams.get('kind') || 'text';
        return reply(req, res, 200, await router.models(id, kind, { signal: abortOnClose(res) }));
      }
      if (prov[2] === '/test' && m === 'POST') {
        if (!admin(req, res, who)) return;
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
      if (!admin(req, res, who)) return;
      const b = await body(req, res);
      if (!b) return;
      try {
        await store.refresh({ force: true });
        store.setOrder(b.order);
        return await savedReply(req, res, who);
      } catch (e) {
        return reply(req, res, e.status || 400, { error: e.message, code: 'BAD_REQUEST' });
      }
    }

    if (p === '/api/ai/usage' && m === 'GET') {
      // errors and task ids can reveal the owner's account details
      if (!admin(req, res, who)) return;
      return reply(req, res, 200, { recent: usage.recent(Number(url.searchParams.get('limit')) || 50), totals: usage.totals() });
    }

    if (p === '/api/ai/generate' && m === 'POST') {
      if (!generationAllowed(req, res, 'gen', who)) return;
      const b = await body(req, res);
      if (!b) return;
      const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
      if (!prompt) return reply(req, res, 400, { error: 'Missing prompt', code: 'BAD_REQUEST' });
      if (prompt.length > MAX_PROMPT_CHARS) return reply(req, res, 413, { error: 'Prompt too long', code: 'BAD_REQUEST' });
      const fn = typeof b.fn === 'string' ? b.fn : '';
      if (fnById[fn]?.kind !== 'text') return reply(req, res, 400, { error: 'Unknown AI function.', code: 'BAD_REQUEST' });
      const signal = abortOnClose(res);
      try {
        const out = await withFreshKeys(() => router.text(fn, { prompt, images: cleanImages(b.images), tier: b.tier === 'quick' ? 'quick' : 'default', brain: typeof b.brain === 'boolean' ? b.brain : null, signal, userId: who?.id }));
        return reply(req, res, 200, out);
      } catch (e) {
        if (signal.aborted) return;
        return fail(req, res, e);
      }
    }

    if (p === '/api/ai/image' && m === 'POST') {
      if (!generationAllowed(req, res, 'img', who)) return;
      const b = await body(req, res);
      if (!b) return;
      const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
      if (!prompt) return reply(req, res, 400, { error: 'Missing prompt', code: 'BAD_REQUEST' });
      if (prompt.length > MAX_MEDIA_PROMPT) return reply(req, res, 413, { error: 'Image prompt too long', code: 'BAD_REQUEST' });
      const signal = abortOnClose(res);
      try {
        const out = await withFreshKeys(() => router.image({ prompt, aspect: ASPECTS[b.aspect] ? b.aspect : '1:1', signal, userId: who?.id }));
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
      if (!generationAllowed(req, res, 'vid', who)) return;
      const b = await body(req, res);
      if (!b) return;
      const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
      if (!prompt) return reply(req, res, 400, { error: 'Missing prompt', code: 'BAD_REQUEST' });
      if (prompt.length > MAX_MEDIA_PROMPT) return reply(req, res, 413, { error: 'Video prompt too long', code: 'BAD_REQUEST' });
      const firstFrame = typeof b.firstFrame === 'string' && parseDataUrl(b.firstFrame) && IMAGE_TYPES.has(parseDataUrl(b.firstFrame).mime) ? b.firstFrame : null;
      try {
        // one-shot paid job: started once, never retried
        const job = await withFreshKeys(() => router.startVideo({ prompt, aspect: VIDEO_ASPECTS.has(b.aspect) ? b.aspect : '9:16', duration: Math.max(1, Math.min(15, Number(b.duration) || 8)), firstFrame, owner: who?.id ?? null }));
        return reply(req, res, 200, { job });
      } catch (e) {
        return fail(req, res, e);
      }
    }

    const vid = /^\/api\/ai\/video\/(vid_[0-9a-f-]{36})(\/content)?$/.exec(p);
    if (vid && m === 'GET') {
      if (!signedIn(req, res, who)) return;
      if (!mayUse(req, router.jobs.get(vid[1])?.owner, who)) return notFound(req, res);
      try {
        if (!vid[2]) return reply(req, res, 200, { job: await router.videoStatus(vid[1], { signal: abortOnClose(res) }) });
        const out = await router.videoContent(vid[1], { signal: abortOnClose(res) });
        res.writeHead(200, { 'content-type': out.contentType, 'content-length': out.bytes.length, 'cache-control': 'no-store', ...corsHeaders(req) });
        return res.end(out.bytes);
      } catch (e) {
        return fail(req, res, e);
      }
    }

    // the signed-in user's own keys: GET lists (last 4 only), PUT saves after a free check, DELETE removes
    const mk = /^\/api\/ai\/my-keys(?:\/([a-z]+))?$/.exec(p);
    if (mk) {
      if (!sameOrigin(req, allowedOrigin)) return reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
      if (!auth.enabled || !who) return reply(req, res, 401, { error: 'Sign in to add your own keys.', code: 'AUTH_REQUIRED' });
      try {
        if (m === 'GET' && !mk[1]) return reply(req, res, 200, { available: userKeys.enabled, keys: await userKeys.info(who.id) });
        if (mk[1] !== 'manus') return notFound(req, res);
        if (m === 'DELETE') {
          await userKeys.remove(who.id, 'manus');
          return reply(req, res, 200, { available: true, keys: await userKeys.info(who.id) });
        }
        if (m === 'PUT') {
          if (rateLimited(`my-keys:${who.id}`)) return reply(req, res, 429, { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMIT' });
          const b = await body(req, res);
          if (!b) return;
          const key = typeof b.key === 'string' ? b.key.trim() : '';
          if (key.length < 16 || key.length > 400 || /\s/.test(key)) return reply(req, res, 400, { error: 'That doesn’t look like a Manus API key. Copy it again from Manus → Settings → API Integration.', code: 'BAD_REQUEST' });
          if (!userKeys.enabled) return reply(req, res, 501, { error: 'Your own keys need the SUPABASE_SECRET_KEY Secret on the server. Ask the app’s owner to add it.', code: 'NOT_CONFIGURED' });
          try {
            await router.checkManusKey(key);
          } catch (e) {
            const err = asProviderError(e, 'Manus');
            return reply(req, res, 400, { error: err.code === 'AUTH' ? 'Manus didn’t accept that key. Check you copied all of it, or create a new one.' : `Couldn’t check the key with Manus: ${err.message}`, code: 'BAD_KEY' });
          }
          await userKeys.set(who.id, 'manus', key);
          return reply(req, res, 200, { available: true, keys: await userKeys.info(who.id) });
        }
        return reply(req, res, 405, { error: 'Method not allowed', code: 'METHOD' });
      } catch (e) {
        return reply(req, res, e.status || 502, { error: e.message, code: e.code || 'UPSTREAM' });
      }
    }

    const mt = /^\/api\/ai\/manus\/(create|output|continue)$/.exec(p);
    if (mt && m === 'POST') {
      if (!generationAllowed(req, res, mt[1] === 'output' ? 'manus-read' : 'manus', who)) return;
      const b = await body(req, res);
      if (!b) return;
      try {
        if (mt[1] === 'create') {
          const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
          if (!prompt) return reply(req, res, 400, { error: 'Missing prompt', code: 'BAD_REQUEST' });
          // Manus is an agent with its own browser, signed in to the owner's accounts (Facebook…), and the
          // prompt is written by the caller: with accounts on, only the owner may give it tasks
          // …unless they've added their own Manus key: then it's their own account and credits
          const ownKey = auth.enabled && !isAdmin(req, who) ? await userKeys.get(who?.id, 'manus') : null;
          if (auth.enabled && !isAdmin(req, who) && !ownKey) {
            return reply(req, res, 403, { error: 'Manus needs your own Manus account: add your Manus API key in Settings → AI.', code: 'OWN_KEY_NEEDED' });
          }
          const image = typeof b.image_data_url === 'string' && parseDataUrl(b.image_data_url) ? { dataUrl: b.image_data_url, filename: typeof b.image_filename === 'string' ? b.image_filename.slice(0, 120) : 'image.jpg' } : null;
          // one-shot write: never retried
          const created = await withFreshKeys(() => router.manusCreate({ fn: b.fn, prompt: prompt.slice(0, 20_000), title: typeof b.title === 'string' ? b.title : '', interactive: b.interactive_mode === true || b.interactive_mode === 'true', hidden: b.hide_in_task_list === true || b.hide_in_task_list === 'true', image, owner: who?.id ?? null, apiKey: ownKey }));
          // the task list must reach Supabase before the app asks another copy of the server about it
          await router.tasksSaved();
          return reply(req, res, 200, created);
        }
        const taskId = typeof b.task_id === 'string' ? b.task_id.trim() : '';
        if (!/^[A-Za-z0-9_-]{6,64}$/.test(taskId)) return reply(req, res, 400, { error: 'Missing task id', code: 'BAD_REQUEST' });
        // started by another copy of the server, or before a restart
        await router.ensureTask(taskId);
        const task = router.manusTasks.get(taskId);
        if (!mayUse(req, task?.owner, who)) return notFound(req, res);
        // a task started with someone's own key is read and continued with that key
        const apiKey = task?.ownKey ? await userKeys.get(task.owner, 'manus') : null;
        if (task?.ownKey && !apiKey) return reply(req, res, 409, { error: 'The Manus key this task was started with was removed. Add it again in Settings → AI.', code: 'OWN_KEY_NEEDED' });
        // the owner's task, on a copy of the server that hasn't picked up the owner's Manus key yet
        if (!apiKey && !store.key('manus') && store.remote.enabled) await freshEnough(store.refresh({ force: true }), 2500);
        if (mt[1] === 'output') {
          const out = await router.manusOutput({ apiKey, taskId, maxImages: Math.max(0, Math.min(8, Number(b.max_images) || 0)), maxImageBytes: Math.max(1, Math.min(30_000_000, Number(b.max_image_bytes) || 15_000_000)), signal: abortOnClose(res) });
          return reply(req, res, 200, out);
        }
        if (auth.enabled && !isAdmin(req, who) && !task?.ownKey) {
          return reply(req, res, 403, { error: 'Manus runs in the app owner’s account, so only the owner can use it.', code: 'OWNER_ONLY' });
        }
        const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
        if (!prompt) return reply(req, res, 400, { error: 'Missing message', code: 'BAD_REQUEST' });
        return reply(req, res, 200, await router.manusContinue({ apiKey, taskId, prompt: prompt.slice(0, 20_000) }));
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
    /** Who's calling (for routes outside /api/ai/*). */
    whoIs,
    /** For /api/health: which keys are ready, their model and effort per kind, and what powers each function. */
    /** At start-up: settings, Manus tasks and the usage log from Supabase (when it keeps them). */
    init: async () => {
      const [settings] = await Promise.all([store.loadRemote(), usage.loadRemote(), router.loadTasksRemote()]);
      return settings;
    },
    health: async (who = null) => {
      if (auth.signInRequired && !who) return { ready: false, providers: [], routing: {}, signedIn: false };
      // the app routes on this answer: a key just saved through another copy must show up here
      await freshEnough(store.refresh({ every: 1000 }), 2000);
      // with accounts on, the owner's Manus is the owner's alone; others can add their own Manus key
      const hide = auth.enabled && !who?.isAdmin ? new Set(['manus']) : new Set();
      const ownManus = hide.size && who?.id ? !!(await userKeys.get(who.id, 'manus').catch(() => null)) : false;
      const ids = store.order().filter((id) => !hide.has(id));
      const base = {
      signedIn: !!who,
      ready: ids.some((id) => store.ready(id)),
      providers: ids.map((id) => {
        const s = store.settings(id);
        return {
          id,
          label: PROVIDERS[id].label,
          ready: store.ready(id),
          models: s.models,
          effort: Object.fromEntries(Object.entries(s.effort).map(([kind, value]) => [kind, { id: value, label: value ? effortLabel(id, kind, value) : 'Set by the model' }])),
        };
      }),
      routing: Object.fromEntries(Object.entries(store.routing()).map(([fn, list]) => [fn, list.filter((id) => !hide.has(id))])),
      };
      if (ownManus) {
        const s = store.settings('manus');
        base.ready = true;
        base.providers.push({ id: 'manus', label: 'Manus (your key)', ready: true, own: true, models: s.models, effort: Object.fromEntries(Object.entries(s.effort).map(([kind, value]) => [kind, { id: value, label: value ? effortLabel('manus', kind, value) : 'Set by the model' }])) });
        base.routing.facebook = ['manus'];
        base.routing.photos = [...(base.routing.photos ?? []), 'manus'];
      }
      return base;
    },
  };
}
