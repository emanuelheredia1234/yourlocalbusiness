// Image generation providers for the Yourlocalbusiness server.
//
// One adapter speaks the OpenAI-compatible Images API (`POST {baseUrl}/images/generations`),
// which Meta's Model API (Muse Image), OpenAI and many other hosts implement. Keys stay on
// the server: they come from env vars or are added in the app (Settings → Image generation)
// and stored in .data/image-providers.json, never sent back to the browser.
//
// Routes (mounted by ai-server.mjs):
//   GET    /api/image/providers         → { active, providers: [{ id, label, configured, source, keyHint, model, baseUrl, ... }] }
//   PUT    /api/image/providers/:id     { apiKey?, model?, baseUrl? }   (local or ADMIN_TOKEN only)
//   DELETE /api/image/providers/:id                                     (local or ADMIN_TOKEN only)
//   POST   /api/image/active            { id }                          (local or ADMIN_TOKEN only)
//   POST   /api/image/test              { id }  → checks the key via GET {baseUrl}/models (free)
//   POST   /api/image                   { prompt, aspect, provider? }  → image bytes (png / jpeg / webp)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PROVIDERS = {
  meta: {
    label: 'Meta Muse Image',
    baseUrl: 'https://api.meta.ai/v1',
    model: 'muse-image-1.0',
    envKey: 'META_MODEL_API_KEY',
    sizes: 'any',
    keyUrl: 'https://dev.meta.ai',
    note: 'About $0.01 per image.',
  },
  openai: {
    label: 'OpenAI Images',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-1',
    envKey: 'OPENAI_API_KEY',
    sizes: ['1024x1024', '1536x1024', '1024x1536'],
    keyUrl: 'https://platform.openai.com/api-keys',
    note: 'Billed per image by OpenAI.',
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    model: '',
    envKey: 'IMAGE_CUSTOM_API_KEY',
    sizes: 'any',
    keyUrl: '',
    note: 'Any host that implements POST /images/generations.',
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/** Width:height for every aspect the app asks for. */
export const ASPECTS = {
  '1:1': [1, 1],
  '4:5': [4, 5],
  '9:16': [9, 16],
  '1.91:1': [1.91, 1],
  '3:2': [3, 2],
  '21:8': [21, 8],
};

/** Pick the `size` string for a provider: exact aspect where any is accepted, else the nearest allowed size. */
export function sizeFor(providerId, aspect) {
  const [w, h] = ASPECTS[aspect] ?? ASPECTS['1:1'];
  const ratio = w / h;
  const allowed = PROVIDERS[providerId]?.sizes ?? 'any';
  if (allowed === 'any') {
    // Long side 1536, rounded to multiples of 64 (only the ratio matters to Muse Image).
    const long = 1536;
    const W = ratio >= 1 ? long : Math.round((long * ratio) / 64) * 64;
    const H = ratio >= 1 ? Math.round(long / ratio / 64) * 64 : long;
    return `${W}x${H}`;
  }
  let best = allowed[0];
  let bestDiff = Infinity;
  for (const s of allowed) {
    const [sw, sh] = s.split('x').map(Number);
    const diff = Math.abs(Math.log(sw / sh / ratio));
    if (diff < bestDiff) {
      best = s;
      bestDiff = diff;
    }
  }
  return best;
}

/** The JSON body sent upstream for one image. */
export function buildBody(providerId, cfg, prompt, aspect) {
  const body = { model: cfg.model, prompt, n: 1, size: sizeFor(providerId, aspect) };
  if (providerId === 'meta') Object.assign(body, { response_format: 'b64_json', output_format: 'png', reasoning_strength: 'high' });
  else if (providerId === 'openai') Object.assign(body, { output_format: 'png' }); // gpt-image models always return base64
  else body.response_format = 'b64_json';
  return body;
}

export function maskKey(key) {
  if (!key) return '';
  return `••••${String(key).slice(-4)}`;
}

/** Map an upstream failure to a stable code the app can explain. */
export function normalizeError(status, payload) {
  const err = payload && typeof payload === 'object' ? payload.error ?? payload : {};
  const code = typeof err === 'object' ? String(err.code ?? err.type ?? '') : '';
  const message = typeof err === 'object' && typeof err.message === 'string' ? err.message : typeof payload === 'string' ? payload.slice(0, 300) : '';
  if (status === 401 || status === 403) return { status: 502, code: 'AUTH', error: 'The image provider rejected the API key. Check it in Settings → Image generation.' };
  if (/content_policy|moderation|safety/i.test(code) || /content[ _]policy|safety system|moderation/i.test(message)) {
    return { status: 422, code: 'CONTENT_POLICY', error: 'The image provider blocked this prompt under its content policy. Rephrase the image description and try again.' };
  }
  if (status === 429) return { status: 429, code: 'RATE_LIMIT', error: 'The image provider is rate limiting or out of credit. Try again shortly or check your account.' };
  if (status === 400 || status === 404 || status === 422) return { status: 502, code: 'BAD_REQUEST', error: message || `The image provider refused the request (${status}).` };
  return { status: 502, code: 'UPSTREAM', error: message || `The image provider returned an error (${status}).` };
}

/** Identify png / jpeg / webp bytes; anything else is refused. */
export function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

async function fetchJson(url, init, timeoutMs) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let payload = text;
  try {
    payload = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { res, payload };
}

// ───────────── key store ─────────────

export class ProviderStore {
  constructor(file, env = process.env) {
    this.file = file;
    this.env = env;
    this.state = { active: '', providers: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') this.state = { active: String(raw.active || ''), providers: raw.providers && typeof raw.providers === 'object' ? raw.providers : {} };
    } catch {
      /* first run */
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Effective config: values added in the app win over env vars. */
  config(id) {
    const def = PROVIDERS[id];
    if (!def) return null;
    const saved = this.state.providers[id] || {};
    const envKey = this.env[def.envKey] || '';
    const envBase = id === 'custom' ? this.env.IMAGE_CUSTOM_BASE_URL || '' : '';
    const envModel = id === 'custom' ? this.env.IMAGE_CUSTOM_MODEL || '' : id === 'meta' ? this.env.META_IMAGE_MODEL || '' : id === 'openai' ? this.env.OPENAI_IMAGE_MODEL || '' : '';
    const apiKey = saved.apiKey || envKey;
    return {
      id,
      apiKey,
      source: saved.apiKey ? 'app' : envKey ? 'env' : '',
      baseUrl: String(saved.baseUrl || envBase || def.baseUrl).replace(/\/+$/, ''),
      model: saved.model || envModel || def.model,
    };
  }

  configured(id) {
    const c = this.config(id);
    return !!(c && c.apiKey && c.baseUrl && c.model);
  }

  /** The provider used when a request names none: the chosen one if usable, else the first configured. */
  activeId() {
    const chosen = this.state.active || this.env.IMAGE_PROVIDER || '';
    if (chosen && this.configured(chosen)) return chosen;
    return PROVIDER_IDS.find((id) => this.configured(id)) || chosen || 'meta';
  }

  list() {
    const active = this.activeId();
    return {
      active,
      providers: PROVIDER_IDS.map((id) => {
        const def = PROVIDERS[id];
        const c = this.config(id);
        return {
          id,
          label: def.label,
          configured: this.configured(id),
          source: c.source,
          keyHint: maskKey(c.apiKey),
          model: c.model,
          baseUrl: c.baseUrl,
          defaultModel: def.model,
          defaultBaseUrl: def.baseUrl,
          keyUrl: def.keyUrl,
          note: def.note,
          active: id === active && this.configured(id),
        };
      }),
    };
  }

  update(id, patch) {
    if (!PROVIDERS[id]) throw Object.assign(new Error('Unknown provider'), { status: 404 });
    const cur = { ...(this.state.providers[id] || {}) };
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) cur.apiKey = patch.apiKey.trim();
    if (typeof patch.model === 'string') cur.model = patch.model.trim() || undefined;
    if (typeof patch.baseUrl === 'string') {
      const b = patch.baseUrl.trim();
      if (b && !/^https:\/\/[^\s/]+/i.test(b) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(b)) throw Object.assign(new Error('Base URL must start with https://'), { status: 400 });
      cur.baseUrl = b || undefined;
    }
    this.state.providers[id] = cur;
    if (!this.state.active) this.state.active = id;
    this.save();
  }

  remove(id) {
    if (!PROVIDERS[id]) throw Object.assign(new Error('Unknown provider'), { status: 404 });
    delete this.state.providers[id];
    if (this.state.active === id) this.state.active = '';
    this.save();
  }

  setActive(id) {
    if (!PROVIDERS[id]) throw Object.assign(new Error('Unknown provider'), { status: 404 });
    this.state.active = id;
    this.save();
  }
}

// ───────────── generation ─────────────

/** Generate one image. Resolves { bytes: Buffer, type, revisedPrompt, provider } or rejects { status, code, error }. */
export async function generateImage(store, { prompt, aspect, provider }, { timeoutMs = 150_000 } = {}) {
  const id = provider && PROVIDERS[provider] ? provider : store.activeId();
  const cfg = store.config(id);
  if (!cfg || !cfg.apiKey) throw { status: 400, code: 'NO_KEY', error: `No API key for ${PROVIDERS[id]?.label ?? id}. Add one in Settings → Image generation.` };
  if (!cfg.baseUrl || !cfg.model) throw { status: 400, code: 'NO_KEY', error: 'Set a base URL and model for the custom provider in Settings → Image generation.' };

  let body = buildBody(id, cfg, prompt, aspect);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` };
  let attempt = 0;
  for (;;) {
    let res;
    let payload;
    try {
      ({ res, payload } = await fetchJson(`${cfg.baseUrl}/images/generations`, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs));
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw { status: 504, code: 'TIMEOUT', error: 'The image provider took too long. Try again.' };
      throw { status: 502, code: 'NETWORK', error: `Could not reach ${PROVIDERS[id].label}.` };
    }
    if (!res.ok) {
      // Some OpenAI-compatible hosts reject optional fields; drop the one they name and retry once.
      const msg = JSON.stringify(payload ?? '');
      const drop = ['response_format', 'output_format', 'size', 'reasoning_strength'].find((k) => k in body && msg.includes(k));
      if (res.status === 400 && drop && attempt < 2 && !/content_policy/i.test(msg)) {
        attempt += 1;
        body = { ...body };
        delete body[drop];
        continue;
      }
      throw normalizeError(res.status, payload);
    }
    const item = Array.isArray(payload?.data) ? payload.data[0] : null;
    let bytes = null;
    if (item?.b64_json) bytes = Buffer.from(item.b64_json, 'base64');
    else if (typeof item?.url === 'string' && /^https:\/\//i.test(item.url)) {
      try {
        const r = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
        if (r.ok) {
          const ab = await r.arrayBuffer();
          if (ab.byteLength <= MAX_IMAGE_BYTES) bytes = Buffer.from(ab);
        }
      } catch {
        /* handled below */
      }
    }
    if (!bytes || bytes.length > MAX_IMAGE_BYTES) throw { status: 502, code: 'UPSTREAM', error: 'The image provider returned no usable image.' };
    const type = sniffImage(bytes);
    if (!type) throw { status: 502, code: 'UPSTREAM', error: 'The image provider returned an unsupported file type.' };
    return { bytes, type, revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : '', provider: id };
  }
}

/** Free credential check: list models with the key. */
export async function testProvider(store, id) {
  const cfg = store.config(id);
  if (!cfg) return { ok: false, code: 'UNKNOWN', error: 'Unknown provider' };
  if (!cfg.apiKey) return { ok: false, code: 'NO_KEY', error: 'Add an API key first.' };
  if (!cfg.baseUrl || !cfg.model) return { ok: false, code: 'NO_KEY', error: 'Set a base URL and model first.' };
  try {
    const { res, payload } = await fetchJson(`${cfg.baseUrl}/models`, { headers: { authorization: `Bearer ${cfg.apiKey}` } }, 20_000);
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'AUTH', error: 'The provider rejected this API key.' };
    if (res.status === 404 || res.status === 405) return { ok: true, verified: false, message: 'Key saved. This host has no model list to check against, so generate an image to confirm it works.' };
    if (!res.ok) return { ok: false, ...normalizeError(res.status, payload) };
    const ids = Array.isArray(payload?.data) ? payload.data.map((m) => m?.id).filter(Boolean) : [];
    const listed = !ids.length || ids.includes(cfg.model);
    return { ok: true, verified: true, modelListed: listed, message: listed ? `Key works and ${cfg.model} is available.` : `Key works, but ${cfg.model} isn’t in this account’s model list. Check the model name.` };
  } catch {
    return { ok: false, code: 'NETWORK', error: `Could not reach ${cfg.baseUrl}.` };
  }
}

// ───────────── HTTP routes ─────────────

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Key changes are allowed from this machine (no proxy in between) or with the ADMIN_TOKEN header. */
export function canManage(req, adminToken) {
  const token = req.headers['x-admin-token'];
  if (adminToken && typeof token === 'string' && token.length === adminToken.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(adminToken))) return true;
  const forwarded = req.headers['x-forwarded-for'] || req.headers.forwarded;
  return LOOPBACK.has(req.socket.remoteAddress || '') && !forwarded;
}

/** Writes must come from this app's own page (or the one allowed origin), never from another site. */
function sameOrigin(req, allowedOrigin) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (allowedOrigin && origin === allowedOrigin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const MAX_PROMPT = 4000;

export function createImageRoutes({ send, readJson, corsHeaders, rateLimited, dataDir, adminToken = '', allowedOrigin = '', env = process.env }) {
  const store = new ProviderStore(path.join(dataDir, 'image-providers.json'), env);

  const guard = (req, res) => {
    if (!sameOrigin(req, allowedOrigin)) {
      send(res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' }, corsHeaders(req));
      return false;
    }
    if (!canManage(req, adminToken)) {
      send(res, 403, { error: adminToken ? 'Send the X-Admin-Token header to change image providers.' : 'Image providers can only be changed from the machine running the server (or set ADMIN_TOKEN).', code: 'FORBIDDEN' }, corsHeaders(req));
      return false;
    }
    return true;
  };

  async function body(req, res) {
    try {
      return await readJson(req);
    } catch (e) {
      send(res, e.status || 400, { error: e.message }, corsHeaders(req));
      return null;
    }
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (p === '/api/image/providers' && req.method === 'GET') return send(res, 200, { ...store.list(), canManage: canManage(req, adminToken) }, corsHeaders(req));

    const m = /^\/api\/image\/providers\/([a-z]+)$/.exec(p);
    if (m && (req.method === 'PUT' || req.method === 'DELETE')) {
      if (!guard(req, res)) return;
      try {
        if (req.method === 'DELETE') store.remove(m[1]);
        else {
          const b = await body(req, res);
          if (!b) return;
          store.update(m[1], b);
        }
        return send(res, 200, store.list(), corsHeaders(req));
      } catch (e) {
        return send(res, e.status || 500, { error: e.message }, corsHeaders(req));
      }
    }

    if (p === '/api/image/active' && req.method === 'POST') {
      if (!guard(req, res)) return;
      const b = await body(req, res);
      if (!b) return;
      try {
        store.setActive(String(b.id || ''));
        return send(res, 200, store.list(), corsHeaders(req));
      } catch (e) {
        return send(res, e.status || 500, { error: e.message }, corsHeaders(req));
      }
    }

    if (p === '/api/image/test' && req.method === 'POST') {
      if (!guard(req, res)) return;
      const b = await body(req, res);
      if (!b) return;
      return send(res, 200, await testProvider(store, String(b.id || store.activeId())), corsHeaders(req));
    }

    if (p === '/api/image' && req.method === 'POST') {
      if (!sameOrigin(req, allowedOrigin)) return send(res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' }, corsHeaders(req));
      if (rateLimited(`img:${req.socket.remoteAddress || 'unknown'}`)) return send(res, 429, { error: 'Too many image requests. Try again in a minute.', code: 'RATE_LIMIT' }, corsHeaders(req));
      const b = await body(req, res);
      if (!b) return;
      const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
      if (!prompt) return send(res, 400, { error: 'Missing prompt', code: 'BAD_REQUEST' }, corsHeaders(req));
      if (prompt.length > MAX_PROMPT) return send(res, 413, { error: 'Image prompt too long', code: 'BAD_REQUEST' }, corsHeaders(req));
      const aspect = ASPECTS[b.aspect] ? b.aspect : '1:1';
      try {
        const out = await generateImage(store, { prompt, aspect, provider: typeof b.provider === 'string' ? b.provider : undefined });
        res.writeHead(200, {
          'content-type': out.type,
          'cache-control': 'no-store',
          'x-image-provider': out.provider,
          'x-image-model': store.config(out.provider).model,
          ...(out.revisedPrompt ? { 'x-revised-prompt': encodeURIComponent(out.revisedPrompt.slice(0, 1500)) } : {}),
          'access-control-expose-headers': 'x-image-provider, x-image-model, x-revised-prompt',
          ...corsHeaders(req),
        });
        return res.end(out.bytes);
      } catch (e) {
        if (e && e.code && e.error) return send(res, e.status || 502, { error: e.error, code: e.code }, corsHeaders(req));
        console.error(e);
        return send(res, 500, { error: 'Unexpected server error', code: 'UPSTREAM' }, corsHeaders(req));
      }
    }
    return false;
  }

  return {
    store,
    /** true when the request was an image route (handled or rejected). */
    match: (url) => url.pathname === '/api/image' || url.pathname.startsWith('/api/image/'),
    handle,
    health: () => {
      const active = store.activeId();
      return { active, label: PROVIDERS[active]?.label ?? active, configured: store.configured(active) };
    },
  };
}
