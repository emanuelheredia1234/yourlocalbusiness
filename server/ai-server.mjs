// Yourlocalbusiness — AI server + static file server.
//
// Keeps your AI provider keys on the server. The web app calls /api/ai/… (see providers/routes.mjs):
// writing, photos, videos and Manus agent tasks, each sent to the keys that power that function in
// Settings → AI, with each key's own model and effort. GET /api/health says which keys are ready.
// When ./dist exists (npm run build), everything else is served from it.
//
// Keys: Replit Secrets / env vars OPENROUTER_API_KEY, GEMINI_API_KEY (or GOOGLE_API_KEY), XAI_API_KEY,
//   ANTHROPIC_API_KEY, META_MODEL_API_KEY, MANUS_API_KEY, OPENAI_API_KEY; or add them in the app
//   (saved in DATA_DIR/ai-providers.json, never sent back to the browser). Secrets win over keys typed in the app.
// Optional env: PORT (8787), HOST (0.0.0.0), ALLOWED_ORIGIN (enable CORS for one origin), RATE_LIMIT_PER_MIN (30),
//   DATA_DIR (./.data), ADMIN_TOKEN (lets a remote browser change AI settings; otherwise only this machine can),
//   AI_PROVIDER_BASE_URLS (JSON map of provider id → base URL, for a proxy or a test server).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAIRoutes } from './providers/routes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN || 30);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(here, '..', '.data'));
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_BODY = 14 * 1024 * 1024; // prompt + up to two images

let BASE_URLS = {};
try {
  BASE_URLS = JSON.parse(process.env.AI_PROVIDER_BASE_URLS || '{}');
} catch {
  console.warn('AI_PROVIDER_BASE_URLS is not valid JSON; ignoring it.');
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

const ai = createAIRoutes({ send, readJson, corsHeaders, rateLimited, dataDir: DATA_DIR, adminToken: ADMIN_TOKEN, allowedOrigin: ALLOWED_ORIGIN, baseUrls: BASE_URLS });

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://local');
  if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }
  if (url.pathname === '/api/health' && req.method === 'GET') {
    // `ok`: the server is up; `ai` says which keys are ready and what powers each function
    return send(res, 200, { ok: true, ai: ai.health() }, corsHeaders(req));
  }
  if (ai.match(url)) {
    return void ai.handle(req, res, url).then(
      (handled) => {
        if (handled === false) send(res, 404, { error: 'Not found' }, corsHeaders(req));
      },
      (e) => {
        console.error(e);
        if (!res.headersSent) send(res, 500, { error: 'Unexpected server error' }, corsHeaders(req));
      },
    );
  }
  if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' }, corsHeaders(req));
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  return send(res, 405, 'Method not allowed');
});

server.listen(PORT, HOST, () => {
  const h = ai.health();
  console.log(`Yourlocalbusiness server on http://localhost:${PORT}`);
  const ready = h.providers.filter((p) => p.ready).map((p) => p.label);
  console.log(ready.length ? `AI keys ready: ${ready.join(', ')}` : 'No AI keys yet: add them in Settings → AI, or as Secrets (e.g. OPENROUTER_API_KEY).');
  if (ai.store.imported) console.log('Imported your image keys from the old Image generation settings.');
  if (!fs.existsSync(DIST)) console.log('No ./dist yet: run `npm run build` to serve the app from here, or use `npm run dev` (it proxies /api to this server).');
});

process.on('SIGTERM', () => {
  ai.usage.flush();
  process.exit(0);
});
