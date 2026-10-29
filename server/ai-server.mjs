// Yourlocalbusiness — optional Claude proxy + static file server.
//
// Keeps your Anthropic credentials on the server. The web app calls:
//   POST /api/generate  { prompt, tier: 'quick' | 'default', images?: dataURL[] }  →  { text }
//   GET  /api/health                                                                →  { ok, model, image }
//   /api/image…  AI image generation through Meta Muse Image, OpenAI or any OpenAI-compatible host (see images.mjs)
// and, when ./dist exists (npm run build), everything else is served from it.
//
// Credentials: ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile — the SDK resolves them).
// Image keys: META_MODEL_API_KEY, OPENAI_API_KEY, IMAGE_CUSTOM_BASE_URL/IMAGE_CUSTOM_API_KEY/IMAGE_CUSTOM_MODEL,
//   IMAGE_PROVIDER (meta | openai | custom), or add them in the app (stored in DATA_DIR/image-providers.json).
// Optional env: PORT (8787), HOST (0.0.0.0), ALLOWED_ORIGIN (enable CORS for one origin), RATE_LIMIT_PER_MIN (30),
//   DATA_DIR (./.data), ADMIN_TOKEN (lets a remote browser change image keys; otherwise only this machine can).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createImageRoutes } from './images.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN || 30);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(here, '..', '.data'));
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MODEL = 'claude-opus-5-5';
const MAX_BODY = 14 * 1024 * 1024; // prompt + up to two images
const MAX_PROMPT_CHARS = 120_000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Thinking is always on for this model; effort is the depth control (its default is "medium").
const TIERS = {
  quick: { effort: 'low', max_tokens: 16000 },
  default: { effort: 'medium', max_tokens: 64000 },
};

const SYSTEM =
  'You generate content for the Yourlocalbusiness app (product research, branding, sales pages, emails, social posts, ads and code widgets for creators and local businesses). Follow the instructions in the user message exactly and reply with only the JSON value it asks for.';

const client = new Anthropic();

const NO_CREDENTIALS = 'No Anthropic credentials on the server. Set ANTHROPIC_API_KEY (or run `ant auth login`) and restart.';

// Health only reports ready when credentials work (Models API lookup: no tokens are generated).
let credCheck = { at: 0, ok: false, error: '' };
async function credentialsReady() {
  const ttl = credCheck.ok ? 5 * 60_000 : 30_000;
  if (credCheck.at && Date.now() - credCheck.at < ttl) return credCheck;
  try {
    await client.models.retrieve(MODEL);
    credCheck = { at: Date.now(), ok: true, error: '' };
  } catch (e) {
    // Anything that fails before an HTTP response is credential resolution (the SDK found no key/profile).
    credCheck = { at: Date.now(), ok: false, error: e instanceof Anthropic.APIError ? describeError(e).error : NO_CREDENTIALS };
  }
  return credCheck;
}

function describeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return { status: 500, error: 'The server’s Anthropic credentials are invalid.' };
  if (e instanceof Anthropic.PermissionDeniedError) return { status: 500, error: 'The server’s Anthropic credentials can’t use this model.' };
  if (e instanceof Anthropic.RateLimitError) return { status: 429, error: 'Rate limited by the AI provider. Try again shortly.' };
  if (e instanceof Anthropic.BadRequestError) return { status: 400, error: e.message };
  if (e instanceof Anthropic.APIConnectionError) return { status: 502, error: 'Could not reach the AI provider.' };
  if (e instanceof Anthropic.APIError) return { status: e.status && e.status >= 500 ? 502 : e.status || 500, error: e.message };
  if (e instanceof Anthropic.AnthropicError) return { status: 500, error: NO_CREDENTIALS };
  return { status: 500, error: 'Unexpected server error' };
}

// ───────────── helpers ─────────────

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function corsHeaders(req) {
  if (!ALLOWED_ORIGIN || req.headers.origin !== ALLOWED_ORIGIN) return {};
  return { 'access-control-allow-origin': ALLOWED_ORIGIN, 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type, x-admin-token', vary: 'origin' };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

function imageBlock(dataUrl) {
  const m = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const media_type = m[1].toLowerCase();
  if (!IMAGE_TYPES.has(media_type)) return null;
  return { type: 'image', source: { type: 'base64', media_type, data: m[2].replace(/\s+/g, '') } };
}

// ───────────── /api/generate ─────────────

async function generate(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) return send(res, 429, { error: 'Too many requests. Try again in a minute.' }, corsHeaders(req));
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return send(res, e.status || 400, { error: e.message }, corsHeaders(req));
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return send(res, 400, { error: 'Missing prompt' }, corsHeaders(req));
  if (prompt.length > MAX_PROMPT_CHARS) return send(res, 413, { error: 'Prompt too long' }, corsHeaders(req));
  const tier = TIERS[body.tier] || TIERS.default;
  const images = (Array.isArray(body.images) ? body.images : []).slice(0, 2).map(imageBlock).filter(Boolean);

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: tier.max_tokens,
        output_config: { effort: tier.effort },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default', // if a safety classifier declines, re-run on Anthropic's recommended fallback model
        system: SYSTEM,
        messages: [{ role: 'user', content: [...images, { type: 'text', text: prompt }] }],
      },
      { signal: controller.signal },
    );
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      return send(res, 422, { error: 'The model declined this request.', category: message.stop_details?.category ?? null }, corsHeaders(req));
    }
    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (message.stop_reason === 'max_tokens' && !text) return send(res, 502, { error: 'The response was cut off. Try again.' }, corsHeaders(req));
    return send(res, 200, { text, model: message.model, stop_reason: message.stop_reason }, corsHeaders(req));
  } catch (e) {
    if (controller.signal.aborted) return; // client went away
    const { status, error } = describeError(e);
    if (status === 500 && error === 'Unexpected server error') console.error(e);
    return send(res, status, { error }, corsHeaders(req));
  }
}

// ───────────── static files (production build) ─────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res) {
  if (!fs.existsSync(DIST)) return send(res, 404, 'Build the app first: npm run build');
  const url = new URL(req.url || '/', 'http://local');
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  let file = path.normalize(path.join(DIST, rel));
  if (file !== DIST && !file.startsWith(DIST + path.sep)) return send(res, 403, 'Forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  const ext = path.extname(file).toLowerCase();
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

// ───────────── router ─────────────

const images = createImageRoutes({ send, readJson, corsHeaders, rateLimited, dataDir: DATA_DIR, adminToken: ADMIN_TOKEN, allowedOrigin: ALLOWED_ORIGIN });

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://local');
  if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }
  if (url.pathname === '/api/health' && req.method === 'GET') {
    // Always 200: `ok` says whether generations will work, so browsers don't log an error for a keyless server.
    return void credentialsReady().then((c) => send(res, 200, { ok: c.ok, model: MODEL, image: images.health(), ...(c.error ? { error: c.error } : {}) }, corsHeaders(req)));
  }
  if (url.pathname === '/api/generate' && req.method === 'POST') return void generate(req, res);
  if (images.match(url)) {
    return void images.handle(req, res, url).then((handled) => {
      if (handled === false) send(res, 404, { error: 'Not found' }, corsHeaders(req));
    });
  }
  if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' }, corsHeaders(req));
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  return send(res, 405, 'Method not allowed');
});

server.listen(PORT, HOST, () => {
  const img = images.health();
  console.log(`Yourlocalbusiness server on http://localhost:${PORT}  (model ${MODEL}, server-side fallbacks on)`);
  console.log(img.configured ? `Image generation: ${img.label}` : 'Image generation: no provider key yet (add one in Settings → Image generation, or set META_MODEL_API_KEY).');
  if (!fs.existsSync(DIST)) console.log('No ./dist yet: run `npm run build` to serve the app from here, or use `npm run dev` (it proxies /api to this server).');
});
