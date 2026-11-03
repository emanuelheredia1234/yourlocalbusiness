// Published pages: someone's SEO page or artifact at a public address. On the app's own host it's
// https://<app>/<slug>; on a domain of their own it's https://<domain>/<slug>, or that domain's home page.
//
//   GET    /api/pages                       → { pages, domains, appOrigin }                       (signed in)
//   GET    /api/pages/check?slug=&pageId=   → { ok } | { ok: false, reason: 'taken'|'reserved'|'format' }
//   PUT    /api/pages/<pageId>              { kind, slug, title, html, images, domain?, home? } → { page, url, domainUrl? }
//   DELETE /api/pages/<pageId>
//   POST   /api/domains                     { domain } → { domain, token, verified }
//   POST   /api/domains/<domain>/check      → { verified, error? }
//   DELETE /api/domains/<domain>
//
// The browser builds the page (its HTML and images). The server checks the address and the images,
// keeps the page in Supabase (published_pages and published_domains: tables only the server can
// reach) and its images in the private media bucket (media/<user id>/published/<page>/<name>, so
// deleting the account removes them), and serves both to anyone.
//
// Published HTML is someone else's code, sent from the app's own address, where the app keeps its
// sign-in in localStorage. So on the app's host every page goes out with a CSP sandbox that never
// includes allow-same-origin: the page runs in an origin of its own, with no access to the app's
// storage or to the API as the visitor, and SEO pages can't run scripts at all. On someone's own
// domain the page has the origin to itself, so it isn't sandboxed; the app and /api never answer there.
//
// Needs accounts and SUPABASE_SECRET_KEY (GET /api/config says pages: { enabled } either way).
// Env: APP_HOSTS (comma-separated: other hosts the app itself runs on, which nobody can claim);
// PAGES_CHECK_BASE (tests: where the domain check is sent, with Host: <domain>).

import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { serviceHeaders } from './secretBox.mjs';
import { sameOrigin } from './providers/routes.mjs';

export const PAGES_MIGRATION = 'supabase/migrations/20261103040000_published_pages.sql';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;
export const PAGE_ID_RE = /^(seo|artifact):[A-Za-z0-9_-]{1,80}$/;
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IMAGE_NAME_RE = /^img-\d{1,2}\.(jpg|png|webp|gif)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** /<slug>, /<slug>/ and /<slug>/img/<name>: the paths a published page answers on. */
const PAGE_PATH = /^\/([a-z0-9][a-z0-9-]{1,58}[a-z0-9])(?:(\/)|\/img\/([^/]+))?$/;
const API_PATH = /^\/api\/(pages|domains)(?:\/([^/]+))?(\/check)?$/;
const WELL_KNOWN = '/.well-known/ylb-domain-check';

/** Names that stay the app's own (plus every top-level name in dist/). */
export const RESERVED_SLUGS = new Set([
  'api', 'assets', 'static', 'public', 'p', 's', 'u', 'i', 'img', 'images', 'media', 'files', 'file', 'download', 'downloads',
  'admin', 'administrator', 'login', 'logout', 'signin', 'sign-in', 'signup', 'sign-up', 'register', 'auth', 'oauth', 'callback',
  'account', 'accounts', 'settings', 'dashboard', 'app', 'apps', 'billing', 'pay', 'payment', 'payments', 'checkout', 'support',
  'help', 'security', 'privacy', 'terms', 'legal', 'status', 'docs', 'www', 'mail', 'email', 'root', 'system', 'null', 'undefined',
  'index', 'favicon', 'robots', 'sitemap', 'well-known', 'home', 'new', 'edit', 'preview', 'yourlocalbusiness', 'replit', 'supabase', 'manus',
]);

/** Hosts that belong to the app's host (or this machine): nobody's own domain. */
const NEVER_CLAIMED = [/(^|\.)replit\.app$/, /(^|\.)replit\.dev$/, /(^|\.)repl\.co$/, /(^|\.)localhost$/];

const IMAGE_TYPES = { 'image/jpeg': { ext: 'jpg', label: 'JPEG' }, 'image/png': { ext: 'png', label: 'PNG' }, 'image/webp': { ext: 'webp', label: 'WebP' }, 'image/gif': { ext: 'gif', label: 'GIF' } };
const MAX_HTML_BYTES = 1_500_000;
const MAX_IMAGES = 12;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_TITLE = 300;
const MAX_PAGES_PER_USER = 100;
const MAX_DOMAINS_PER_USER = 20;
const PAGE_TTL = 30_000;
const DOMAIN_TTL = 60_000;
const IMAGE_TTL = 10 * 60_000;
const IMAGE_CACHE_BYTES = 40 * 1024 * 1024;
const CHECK_TIMEOUT = 5000;
const LOOKUP_TIMEOUT = 5000;
/** Database lookups for visitors per minute (this copy of the server); cached answers don't count. */
const LOOKUPS_PER_MIN = 1200;

// Never allow-same-origin: the app's sign-in tokens live in localStorage on the app's origin.
const ARTIFACT_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
const SEO_CSP = 'sandbox allow-forms allow-popups allow-popups-to-escape-sandbox';
const IMAGE_CSP = "default-src 'none'; sandbox";
const NOTICE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const COMMON = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' };

// A plain page with no app name: custom domains must not show whose app serves them.
const notice = (title, text) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2937; background: #ffffff; }
  main { padding: 24px; max-width: 32rem; text-align: center; }
  h1 { margin: 0 0 8px; font-size: 1.5rem; }
  p { margin: 0; color: #4b5563; }
  @media (prefers-color-scheme: dark) { body { color: #f3f4f6; background: #111827; } p { color: #9ca3af; } }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${text}</p>
</main>
</body>
</html>
`;
const NOT_FOUND_PAGE = notice('Page not found', 'This page doesn’t exist, or it’s no longer published.');
const UNAVAILABLE_PAGE = notice('This page can’t be shown right now', 'Try again in a minute.');

/** The image type its first bytes show (only the types a page may publish), or null. */
export function imageTypeOf(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  const head = buf.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** A domain as typed ("https://Shop.Example.com:443/about") → its host name ("shop.example.com"), or ''. */
export function normalizeDomain(input) {
  let s = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#\\].*$/s, '')
    .replace(/^.*@/, '')
    .replace(/:\d*$/, '')
    .replace(/\.+$/, '');
  if (!s) return '';
  try {
    // international names in the xn-- form browsers send
    s = new URL(`http://${s}`).hostname.replace(/\.+$/, '');
  } catch {
    /* not a host name: the format check refuses it */
  }
  return s;
}

/** Whether a host could be someone's own domain (a name with a real top-level domain, not the app's host). */
export function claimable(host, appHosts = new Set()) {
  return host.length <= 253 && DOMAIN_RE.test(host) && !NEVER_CLAIMED.some((re) => re.test(host)) && !appHosts.has(host);
}

/** The host a request was made to, port included: Host, or X-Forwarded-Host from this machine (the Vite dev proxy), like sameOrigin. */
function hostWithPort(req) {
  const fwd = req.headers['x-forwarded-host'];
  const raw = typeof fwd === 'string' && fwd && LOOPBACK.has(req.socket?.remoteAddress || '') ? fwd.split(',')[0] : req.headers.host;
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\.+(?=(:\d+)?$)/, '');
}
/** The same without the port: what custom domains are matched on. */
export const hostOf = (req) => hostWithPort(req).replace(/:\d*$/, '');

/** The app's public address as this request reached it (where its pages are served). */
function originOf(req) {
  const host = hostWithPort(req);
  const proto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (proto === 'http' || proto === 'https') return `${proto}://${host}`;
  try {
    const o = new URL(String(req.headers.origin || ''));
    if (o.host === host) return `${o.protocol}//${host}`;
  } catch {
    /* no Origin header (a same-origin GET) */
  }
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(host);
  return `${req.socket?.encrypted || !local ? 'https' : 'http'}://${host}`;
}

// Addresses the domain check never connects to: a domain pointed at this machine or a private network
// would otherwise make the server send requests there.
const PRIVATE = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) PRIVATE.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVATE.addSubnet(a, p, 'ipv6');
export function isPrivateAddress(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped || net.isIPv4(address)) return PRIVATE.check(mapped || address, 'ipv4');
  return net.isIPv6(address) ? PRIVATE.check(address, 'ipv6') : true;
}
/** dns.lookup for the domain check: refuses names that resolve to a private address. */
export function publicOnly(hostname, options, callback) {
  dns.lookup(hostname, options, (e, address, family) => {
    if (e) return callback(e);
    const all = Array.isArray(address) ? address : [{ address }];
    if (!all.length || all.some((a) => isPrivateAddress(a.address))) return callback(Object.assign(new Error(`${hostname} points to a private address`), { code: 'EPRIVATE' }));
    return callback(null, address, family);
  });
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Text Postgres can store: no NUL characters, no half emoji (browsers show both as nothing or �). */
const storable = (v) => {
  const s = typeof v === 'string' ? v.replace(/\u0000/g, '') : '';
  return typeof s.toWellFormed === 'function' ? s.toWellFormed() : s;
};

/** A small cache. Entries stay after they expire (a fallback while Supabase can't answer) until pushed out. */
function cache(name, ttl, max) {
  const m = new Map();
  return {
    name,
    ttl,
    fresh(k) {
      const e = m.get(k);
      return e && e.until > Date.now() ? e : null;
    },
    last: (k) => m.get(k) ?? null,
    set(k, value, ms = ttl) {
      m.delete(k);
      m.set(k, { value, until: Date.now() + ms });
      if (m.size > max) m.delete(m.keys().next().value);
    },
    delete: (k) => m.delete(k),
    deleteWhere(test) {
      for (const [k, e] of [...m]) if (test(e.value)) m.delete(k);
    },
  };
}

/** Image bytes, least recently used out first, up to maxBytes in all. */
function byteCache(maxBytes, ttl) {
  const m = new Map();
  let total = 0;
  const drop = (k) => {
    const e = m.get(k);
    if (e) total -= e.bytes.length;
    m.delete(k);
  };
  return {
    get(k) {
      const e = m.get(k);
      if (!e) return null;
      drop(k);
      if (e.until <= Date.now()) return null;
      m.set(k, e);
      total += e.bytes.length;
      return e.bytes;
    },
    set(k, bytes) {
      if (bytes.length > maxBytes) return;
      drop(k);
      m.set(k, { bytes, until: Date.now() + ttl });
      total += bytes.length;
      while (total > maxBytes) drop(m.keys().next().value);
    },
    dropPrefix(prefix) {
      for (const k of [...m.keys()]) if (k.startsWith(prefix)) drop(k);
    },
  };
}

export function pagesFromEnv(env = process.env, deps = {}) {
  return createPages({
    supabaseUrl: env.SUPABASE_URL || '',
    secretKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '',
    appHosts: env.APP_HOSTS || '',
    checkBase: env.PAGES_CHECK_BASE || '',
    ...deps,
  });
}

/**
 * auth: server/auth.mjs (publishing needs accounts on). whoIs, send, readJson, rateLimited and
 * corsHeaders: the server's own (see ai-server.mjs). distDir: the built app, whose top-level names
 * can't be page names.
 */
export function createPages({
  supabaseUrl = '',
  secretKey = '',
  auth = { enabled: false },
  whoIs,
  send,
  readJson,
  rateLimited = () => false,
  corsHeaders = () => ({}),
  allowedOrigin = '',
  distDir = '',
  appHosts = '',
  checkBase = '',
  fetch = globalThis.fetch,
} = {}) {
  const url = String(supabaseUrl).replace(/\/+$/, '');
  const enabled = !!(auth?.enabled && url && secretKey);
  const headers = secretKey ? serviceHeaders(secretKey) : {};
  // Storage takes the same key; each call sets its own content type
  const storageAuth = { ...headers };
  delete storageAuth['content-type'];
  // the app's own hosts besides the one a request names (and the allowed origin's), never someone's domain
  const ownHosts = new Set(
    String(appHosts)
      .split(/[\s,]+/)
      .map(normalizeDomain)
      .filter(Boolean),
  );
  try {
    if (allowedOrigin) ownHosts.add(new URL(allowedOrigin).hostname);
  } catch {
    /* not a URL: ignored */
  }

  const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
  const unreachable = (e) => fail(502, 'UPSTREAM', `Couldn’t reach Supabase (${e?.name === 'TimeoutError' ? 'it took too long' : e?.message || 'network error'}). Try again.`);
  let warnedTables = false;
  const tablesMissing = () => {
    if (!warnedTables) {
      warnedTables = true;
      console.warn(`Published pages: the tables aren’t in Supabase yet. Run ${PAGES_MIGRATION} in Supabase → SQL Editor.`);
    }
    return fail(503, 'PAGES_TABLES', `Run ${PAGES_MIGRATION} in Supabase → SQL Editor.`);
  };

  /** Supabase's REST API with the secret key: the parsed answer, or an error with status and code. */
  async function rest(query, { method = 'GET', body, prefer, timeout = 10_000 } = {}) {
    let res;
    try {
      res = await fetch(`${url}/rest/v1/${query}`, { method, headers: { ...headers, ...(prefer ? { prefer } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw unreachable(e);
    }
    const text = await res.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.ok) return data;
    const code = String(data?.code ?? '');
    const message = String(data?.message ?? '');
    if (res.status === 404 && (code === 'PGRST205' || code === '42P01' || /published_(pages|domains)/.test(message))) throw tablesMissing();
    // a unique key: the address (or the domain's home page) was just taken
    if (code === '23505') throw fail(409, 'CONFLICT', message);
    throw fail(502, 'UPSTREAM', `Supabase refused that (${res.status}${message ? `: ${message.slice(0, 160)}` : ''}). Try again.`);
  }

  // ── stored images: media/<user id>/published/<page id with - for :>/<name> ──
  const folderOf = (userId, pageId) => `${userId}/published/${pageId.replace(':', '-')}`;
  const objectPath = (p) => p.split('/').map(encodeURIComponent).join('/');
  async function storage(pathname, init, timeout = 20_000) {
    try {
      return await fetch(`${url}/storage/v1/${pathname}`, { ...init, headers: { ...storageAuth, ...init.headers }, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw unreachable(e);
    }
  }
  async function putImage(folder, img) {
    const res = await storage(`object/media/${objectPath(`${folder}/${img.name}`)}`, { method: 'POST', headers: { 'content-type': img.mime, 'x-upsert': 'true' }, body: img.bytes });
    if (!res.ok) throw fail(502, 'UPSTREAM', `Couldn’t store ${img.name} in Supabase (${res.status}). Try again.`);
  }
  /** The stored file, or null when it isn't there (Supabase answers 400 or 404 for that). */
  async function getImage(folder, name) {
    const res = await storage(`object/authenticated/media/${objectPath(`${folder}/${name}`)}`, { method: 'GET', headers: {} }, LOOKUP_TIMEOUT);
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status === 400 || res.status === 404) return null;
    throw fail(502, 'UPSTREAM', `Supabase didn’t send an image (${res.status}).`);
  }
  /** Remove a page's stored images except those named in keep. Best effort: a leftover file is only unused space. */
  async function removeImages(folder, keep = []) {
    try {
      const list = await storage('object/list/media', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix: `${folder}/`, limit: 1000, offset: 0 }) });
      if (!list.ok) return;
      const items = await list.json();
      // files only (Storage lists a sub-folder as an entry without an id)
      const gone = (Array.isArray(items) ? items : []).filter((i) => i?.id != null && !keep.includes(i.name)).map((i) => `${folder}/${i.name}`);
      if (gone.length) await storage('object/media', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: gone }) });
    } catch (e) {
      console.warn(`Published pages: couldn’t remove unused images in ${folder} (${e.message}).`);
    }
  }

  // ── lookups for visitors: cached, one request at a time per key, within a budget ──
  const domainCache = cache('domain', DOMAIN_TTL, 5000); // host → { domain, user_id, token, verified_at } | null
  const pageCache = cache('page', PAGE_TTL, 5000); // slug → page row | null
  const onDomainCache = cache('on-domain', PAGE_TTL, 2000); // domain → [{ slug, user_id, home, updated_at }]
  const imageCache = byteCache(IMAGE_CACHE_BYTES, IMAGE_TTL);
  const inflight = new Map();
  let budget = { start: 0, used: 0 };
  // random paths or Host names (scanners) must not turn into a flood of database requests
  const mayLookUp = () => {
    const now = Date.now();
    if (now - budget.start >= 60_000) budget = { start: now, used: 0 };
    return budget.used++ < LOOKUPS_PER_MIN;
  };
  function lookUp(store, key, load) {
    const hit = store.fresh(key);
    if (hit) return Promise.resolve(hit.value);
    const id = `${store.name}:${key}`;
    if (inflight.has(id)) return inflight.get(id);
    const last = store.last(key);
    if (!mayLookUp()) return last ? Promise.resolve(last.value) : Promise.reject(fail(503, 'BUSY', 'Too many lookups right now.'));
    const p = load()
      .then(
        (value) => {
          store.set(key, value);
          return value;
        },
        (e) => {
          // the migration wasn't run: nothing is published
          if (e.code === 'PAGES_TABLES') {
            store.set(key, null);
            return null;
          }
          // Supabase didn't answer: what was known last, for a few seconds (a short outage mustn't take pages down)
          if (last) {
            store.set(key, last.value, 10_000);
            return last.value;
          }
          throw e;
        },
      )
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  }
  const domainRow = (host) => lookUp(domainCache, host, async () => (await rest(`published_domains?domain=eq.${encodeURIComponent(host)}&select=domain,user_id,token,verified_at`, { timeout: LOOKUP_TIMEOUT }))?.[0] ?? null);
  const pageRow = (slug) => lookUp(pageCache, slug, async () => (await rest(`published_pages?slug=eq.${slug}&select=slug,user_id,page_id,kind,title,html,images,domain,home,updated_at`, { timeout: LOOKUP_TIMEOUT }))?.[0] ?? null);
  const pagesOnDomain = (domain) => lookUp(onDomainCache, domain, async () => (await rest(`published_pages?domain=eq.${encodeURIComponent(domain)}&select=slug,user_id,home,updated_at&order=updated_at.desc&limit=1000`, { timeout: LOOKUP_TIMEOUT })) ?? []);
  /** Drop what this copy of the server remembers about pages that just changed. */
  const forget = ({ slugs = [], domains = [] }) => {
    for (const s of slugs) if (s) pageCache.delete(s);
    for (const d of domains) if (d) onDomainCache.delete(d);
  };

  const distHas = (name) => !!distDir && fs.existsSync(path.join(distDir, name));
  const reserved = (slug) => RESERVED_SLUGS.has(slug) || distHas(slug);
  const slugProblem = (slug) => (!SLUG_RE.test(slug) ? 'format' : reserved(slug) ? 'reserved' : null);

  // ── responses for visitors ──
  function write(req, res, status, hdrs, body) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    res.writeHead(status, { ...hdrs, 'content-length': buf.length });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }
  const notFound = (req, res) => write(req, res, 404, { ...COMMON, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': NOTICE_CSP }, NOT_FOUND_PAGE);
  let warnedAt = 0;
  const unavailable = (req, res, e) => {
    if (e?.code !== 'BUSY' && Date.now() - warnedAt > 60_000) {
      warnedAt = Date.now();
      console.warn(`Published pages: couldn’t serve a page (${e?.message || e}).`);
    }
    write(req, res, 503, { ...COMMON, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '60', 'content-security-policy': NOTICE_CSP }, UNAVAILABLE_PAGE);
  };
  const sendPage = (req, res, page, { sandbox }) =>
    write(req, res, 200, { ...COMMON, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60', ...(sandbox ? { 'content-security-policy': page.kind === 'artifact' ? ARTIFACT_CSP : SEO_CSP } : {}) }, page.html);

  async function sendImage(req, res, page, name) {
    const img = IMAGE_NAME_RE.test(name) && Array.isArray(page.images) ? page.images.find((i) => i?.name === name) : null;
    if (!img || !IMAGE_TYPES[img.mime]) return notFound(req, res);
    const folder = folderOf(page.user_id, page.page_id);
    const key = `${folder}/${name}@${img.sha256 || ''}`;
    let bytes = imageCache.get(key);
    if (!bytes) {
      const id = `image:${key}`;
      if (!inflight.has(id)) inflight.set(id, getImage(folder, name).finally(() => inflight.delete(id)));
      bytes = await inflight.get(id);
      // only the exact file checked when the page was published: the owner can also change their
      // folder directly, and nothing but an image of the listed type may go out from here
      if (!bytes || imageTypeOf(bytes) !== img.mime || (img.sha256 && sha256(bytes) !== img.sha256)) return notFound(req, res);
      imageCache.set(key, bytes);
    }
    return write(req, res, 200, { ...COMMON, 'content-type': img.mime, 'cache-control': 'public, max-age=86400', 'content-security-policy': IMAGE_CSP }, bytes);
  }

  /** Whether this request's host could be someone's own domain (then serveDomain decides, before anything else). */
  const mayBeDomain = (req) => enabled && claimable(hostOf(req), ownHosts);

  /**
   * A request to someone's own domain: only their published pages answer, plus the domain check,
   * robots.txt and sitemap.xml. false: the host isn't anyone's domain (the app answers as usual).
   */
  async function serveDomain(req, res, url) {
    const host = hostOf(req);
    let site;
    try {
      site = await domainRow(host);
    } catch (e) {
      // can't tell whose domain this is right now: show nothing rather than the app
      unavailable(req, res, e);
      return true;
    }
    if (!site) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      write(req, res, 405, { ...COMMON, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', allow: 'GET, HEAD' }, 'Method not allowed');
      return true;
    }
    const p = url.pathname;
    const text = (type, body, cacheControl) => write(req, res, 200, { ...COMMON, 'content-type': type, 'cache-control': cacheControl }, body);
    // the domain's pages (only its owner's: a page can only be published to its owner's domain)
    const listed = async () => ((await pagesOnDomain(host)) ?? []).filter((r) => r.user_id === site.user_id);
    try {
      if (p === WELL_KNOWN) text('text/plain; charset=utf-8', site.token, 'no-store');
      else if (p === '/robots.txt') text('text/plain; charset=utf-8', `User-agent: *\nAllow: /\nSitemap: https://${host}/sitemap.xml\n`, 'public, max-age=300');
      else if (p === '/sitemap.xml') {
        const urls = (await listed()).map((r) => `  <url><loc>https://${host}/${r.home ? '' : r.slug}</loc>${r.updated_at ? `<lastmod>${String(r.updated_at).slice(0, 10)}</lastmod>` : ''}</url>\n`);
        text('application/xml; charset=utf-8', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('')}</urlset>\n`, 'public, max-age=300');
      } else {
        const m = p === '/' ? null : PAGE_PATH.exec(p);
        const slug = p === '/' ? (await listed()).find((r) => r.home)?.slug : m?.[1];
        const page = slug ? await pageRow(slug) : null;
        // only this domain's own pages (and, at /, its home page)
        if (!page || page.domain !== host || page.user_id !== site.user_id || (p === '/' && !page.home)) notFound(req, res);
        else if (m?.[3] !== undefined) await sendImage(req, res, page, m[3]);
        else sendPage(req, res, page, { sandbox: false });
      }
    } catch (e) {
      if (!res.headersSent) unavailable(req, res, e);
    }
    return true;
  }

  /** GET|HEAD /<slug>, /<slug>/ and /<slug>/img/<name> on the app's host (call servePage for them). */
  const matchPage = (url) => enabled && PAGE_PATH.test(url.pathname);

  /** A published page or its image on the app's host. false: it's one of the app's own paths (serve the app). */
  async function servePage(req, res, url) {
    const m = PAGE_PATH.exec(url.pathname);
    if (!enabled || !m) return false;
    const [, slug, , image] = m;
    if (reserved(slug)) return false;
    try {
      const page = await pageRow(slug);
      if (!page) notFound(req, res);
      else if (image !== undefined) await sendImage(req, res, page, image);
      else sendPage(req, res, page, { sandbox: true });
    } catch (e) {
      if (!res.headersSent) unavailable(req, res, e);
    }
    return true;
  }

  // ── the signed-in API ──
  const describePage = (r, origin) => ({
    pageId: r.page_id,
    kind: r.kind,
    slug: r.slug,
    title: r.title ?? '',
    domain: r.domain ?? null,
    home: !!r.home,
    updatedAt: r.updated_at ?? null,
    url: `${origin}/${r.slug}`,
    ...(r.domain ? { domainUrl: r.home ? `https://${r.domain}/` : `https://${r.domain}/${r.slug}` } : {}),
  });
  const describeDomain = (r) => ({ domain: r.domain, token: r.token, verified: !!r.verified_at, verifiedAt: r.verified_at ?? null });
  const PAGE_COLUMNS = 'page_id,kind,slug,title,domain,home,updated_at';

  /** The images a page is published with, checked: [{ name, mime, bytes, size, sha256 }]. */
  function readImages(list) {
    const bad = (message) => fail(400, 'BAD_IMAGE', message);
    if (list == null) return [];
    if (!Array.isArray(list)) throw bad('The images must be a list.');
    if (list.length > MAX_IMAGES) throw bad(`A page can have up to ${MAX_IMAGES} images.`);
    const seen = new Set();
    return list.map((it, i) => {
      const name = typeof it?.name === 'string' ? it.name : '';
      if (!IMAGE_NAME_RE.test(name) || seen.has(name)) throw bad(`Image ${i + 1} has a name the app doesn’t use.`);
      seen.add(name);
      const mime = String(it.mime || '').toLowerCase();
      const type = IMAGE_TYPES[mime];
      if (!type || !name.endsWith(`.${type.ext}`)) throw bad(`${name}: only JPEG, PNG, WebP and GIF images can be published.`);
      const data = typeof it.data === 'string' ? it.data.replace(/^data:[^,]*;base64,/, '') : '';
      if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw bad(`${name} isn’t a readable image.`);
      const tooBig = () => bad(`${name} is over 3 MB. Use a smaller image.`);
      if (Math.floor((data.length * 3) / 4) > MAX_IMAGE_BYTES + 2) throw tooBig();
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length > MAX_IMAGE_BYTES) throw tooBig();
      if (imageTypeOf(bytes) !== mime) throw bad(`${name} isn’t a ${type.label} image.`);
      return { name, mime, bytes, size: bytes.length, sha256: sha256(bytes) };
    });
  }

  async function publish(req, who, pageId, b, origin) {
    const kind = pageId.slice(0, pageId.indexOf(':'));
    if (b.kind !== undefined && b.kind !== kind) throw fail(400, 'BAD_REQUEST', 'The page’s kind doesn’t match its id.');
    const slug = typeof b.slug === 'string' ? b.slug.trim() : '';
    const why = slugProblem(slug);
    if (why === 'format') throw fail(400, 'BAD_SLUG', 'Use 3 to 60 lower-case letters, numbers and hyphens, starting and ending with a letter or number.', { reason: 'format' });
    if (why === 'reserved') throw fail(400, 'BAD_SLUG', 'That name is used by the app. Choose another.', { reason: 'reserved' });
    const html = storable(b.html);
    if (!html.trim()) throw fail(400, 'BAD_REQUEST', 'There’s nothing to publish yet.');
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw fail(413, 'TOO_LARGE', 'This page is over 1.5 MB. Make it shorter, or use fewer images inside the page.');
    // whole characters only (Postgres counts characters, and half an emoji isn't storable)
    const title = Array.from(storable(b.title).trim())
      .slice(0, MAX_TITLE)
      .join('');
    const images = readImages(b.images);
    if (b.domain != null && typeof b.domain !== 'string') throw fail(400, 'BAD_REQUEST', 'The domain must be text.');
    const domain = b.domain ? normalizeDomain(b.domain) : null;
    const home = b.home === true;
    if (home && !domain) throw fail(400, 'BAD_REQUEST', 'Choose one of your domains to make this its home page.');
    const uid = who.id;
    const pid = encodeURIComponent(pageId);
    const [holders, currents, owned] = await Promise.all([
      rest(`published_pages?slug=eq.${slug}&select=user_id,page_id`),
      rest(`published_pages?user_id=eq.${uid}&page_id=eq.${pid}&select=slug,domain`),
      domain ? rest(`published_domains?domain=eq.${encodeURIComponent(domain)}&user_id=eq.${uid}&select=domain`) : [],
    ]);
    const holder = holders?.[0];
    const current = currents?.[0];
    if (holder && !(holder.user_id === uid && holder.page_id === pageId)) throw fail(409, 'SLUG_TAKEN', 'That name is taken. Choose another.');
    if (domain && !owned?.length) throw fail(400, 'DOMAIN_NOT_YOURS', 'Add that domain in Settings → Domains first.');
    if (!current) {
      const mine = await rest(`published_pages?user_id=eq.${uid}&select=slug&limit=${MAX_PAGES_PER_USER}`);
      if ((mine?.length ?? 0) >= MAX_PAGES_PER_USER) throw fail(400, 'TOO_MANY', `You can publish up to ${MAX_PAGES_PER_USER} pages. Unpublish one first.`);
    }
    // the images first: the page never points at an image that isn't stored yet
    const folder = folderOf(uid, pageId);
    await Promise.all(images.map((img) => putImage(folder, img)));
    // one home page per domain: the domain's other home page stays published at its own name
    let demoted = [];
    if (home) {
      demoted = await rest(`published_pages?domain=eq.${encodeURIComponent(domain)}&home=is.true&page_id=neq.${pid}&select=slug`, { method: 'PATCH', body: { home: false }, prefer: 'return=representation' });
    }
    let saved;
    try {
      // one row per page: a new name moves the page (its old name stops working)
      const rows = await rest(`published_pages?on_conflict=user_id,page_id&select=${PAGE_COLUMNS}`, {
        method: 'POST',
        body: { slug, user_id: uid, page_id: pageId, kind, title, html, images: images.map(({ name, mime, size, sha256: hash }) => ({ name, mime, size, sha256: hash })), domain, home },
        prefer: 'resolution=merge-duplicates,return=representation',
      });
      saved = rows?.[0];
    } catch (e) {
      // the domain keeps the home page it had
      if (demoted?.length) await rest(`published_pages?slug=eq.${demoted[0].slug}&domain=eq.${encodeURIComponent(domain)}`, { method: 'PATCH', body: { home: true }, prefer: 'return=minimal' }).catch(() => {});
      if (e.code === 'CONFLICT') throw fail(409, 'SLUG_TAKEN', 'That name was just taken. Choose another.');
      throw e;
    }
    forget({ slugs: [slug, current?.slug, ...(demoted ?? []).map((d) => d.slug)], domains: [domain, current?.domain] });
    imageCache.dropPrefix(`${folder}/`);
    await removeImages(folder, images.map((i) => i.name));
    const page = describePage(saved ?? { page_id: pageId, kind, slug, title, domain, home }, origin);
    return { page, url: page.url, ...(page.domainUrl ? { domainUrl: page.domainUrl } : {}) };
  }

  async function unpublish(who, pageId) {
    const gone = await rest(`published_pages?user_id=eq.${who.id}&page_id=eq.${encodeURIComponent(pageId)}&select=slug,domain`, { method: 'DELETE', prefer: 'return=representation' });
    forget({ slugs: (gone ?? []).map((g) => g.slug), domains: (gone ?? []).map((g) => g.domain) });
    const folder = folderOf(who.id, pageId);
    imageCache.dropPrefix(`${folder}/`);
    await removeImages(folder);
    return { ok: true };
  }

  async function addDomain(req, who, raw) {
    const domain = normalizeDomain(raw);
    if (!domain) throw fail(400, 'BAD_DOMAIN', 'Enter a domain, like shop.example.com.');
    if (domain.length > 253 || !DOMAIN_RE.test(domain)) throw fail(400, 'BAD_DOMAIN', 'That isn’t a domain name. Enter it like shop.example.com.');
    if (NEVER_CLAIMED.some((re) => re.test(domain))) throw fail(400, 'BAD_DOMAIN', 'That address belongs to the app’s host. Use a domain you own.');
    if (domain === hostOf(req) || ownHosts.has(domain)) throw fail(400, 'BAD_DOMAIN', 'That’s this app’s own address. Use a domain you own.');
    const mine = (await rest(`published_domains?user_id=eq.${who.id}&select=domain,token,verified_at`)) ?? [];
    const have = mine.find((d) => d.domain === domain);
    if (have) return describeDomain(have);
    if (mine.length >= MAX_DOMAINS_PER_USER) throw fail(400, 'TOO_MANY', `You can add up to ${MAX_DOMAINS_PER_USER} domains.`);
    // claimed by whoever adds it first (insert only if nobody has it)
    const rows = await rest('published_domains?on_conflict=domain&select=domain,user_id,token,verified_at', {
      method: 'POST',
      body: { domain, user_id: who.id, token: crypto.randomBytes(16).toString('hex') },
      prefer: 'resolution=ignore-duplicates,return=representation',
    });
    let row = rows?.[0];
    if (!row) {
      row = (await rest(`published_domains?domain=eq.${encodeURIComponent(domain)}&select=domain,user_id,token,verified_at`))?.[0];
      if (row?.user_id !== who.id) throw fail(409, 'DOMAIN_TAKEN', 'Another account already added this domain.');
    }
    domainCache.delete(domain);
    return describeDomain(row);
  }

  /** One GET of the domain's check address, as a visitor would reach it (no redirects followed here). */
  function getOnce(domain, pathname, deadline) {
    return new Promise((resolve) => {
      const base = checkBase ? new URL(checkBase) : null;
      const mod = base?.protocol === 'http:' ? http : https;
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      const req = mod.request(
        {
          method: 'GET',
          host: base ? base.hostname.replace(/^\[|\]$/g, '') : domain,
          port: base ? Number(base.port) || (base.protocol === 'http:' ? 80 : 443) : 443,
          path: pathname,
          headers: { host: domain, accept: 'text/plain', 'user-agent': 'Yourlocalbusiness domain check' },
          agent: false,
          ...(mod === https ? { servername: domain } : {}),
          ...(base ? {} : { lookup: publicOnly }),
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            body += c;
            if (body.length > 4096) res.destroy();
          });
          const end = () => finish({ status: res.statusCode, location: res.headers.location, body });
          res.on('end', end);
          res.on('close', end);
          res.on('error', (e) => finish({ error: e }));
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        finish({ error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) });
      }, Math.max(1, deadline - Date.now()));
      req.on('error', (e) => finish({ error: e }));
      req.end();
    });
  }
  const checkError = (e) => {
    const code = String(e?.code || '');
    if (code === 'ETIMEDOUT') return 'Your domain didn’t answer within 5 seconds. Try again in a few minutes.';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') return 'Your domain doesn’t point anywhere yet. Add the records Replit shows at your registrar; it can take a few hours to work.';
    if (code === 'EPRIVATE') return 'Your domain points to a private address. Use the records Replit shows.';
    if (/CERT|TLS|SSL/i.test(code) || /certificate|ssl|tls/i.test(String(e?.message || ''))) return 'Your domain reaches a server, but its secure certificate isn’t ready. Replit makes one once the records work; try again in a few minutes.';
    return 'Your domain isn’t reaching this app yet. Check the records at your registrar, then try again.';
  };
  /** Does https://<domain>/.well-known/ylb-domain-check answer with this domain's code? Redirects only on the same domain. */
  async function checkDomain(domain, token) {
    const deadline = Date.now() + CHECK_TIMEOUT;
    let pathname = WELL_KNOWN;
    for (let hop = 0; hop < 4; hop++) {
      const r = await getOnce(domain, pathname, deadline);
      if (r.error) return { verified: false, error: checkError(r.error) };
      if (r.status >= 300 && r.status < 400 && r.location) {
        let next = null;
        try {
          next = new URL(r.location, `https://${domain}${pathname}`);
        } catch {
          /* unreadable: treated as another address */
        }
        if (!next || next.protocol !== 'https:' || next.hostname !== domain) return { verified: false, error: 'Your domain sends visitors to another address. Remove that redirect, then check again.' };
        pathname = `${next.pathname}${next.search}`;
        continue;
      }
      if (r.status === 200 && r.body.trim() === token) return { verified: true };
      return { verified: false, error: 'Your domain answers, but not with this app yet. Check the records at your registrar (Cloudflare: DNS only, not proxied), or try again in a few minutes.' };
    }
    return { verified: false, error: 'Your domain redirects too many times.' };
  }

  async function verifyDomain(who, domain) {
    const row = (await rest(`published_domains?domain=eq.${encodeURIComponent(domain)}&user_id=eq.${who.id}&select=domain,token`))?.[0];
    if (!row) throw fail(404, 'NOT_FOUND', 'That domain isn’t in your list. Add it first.');
    const out = await checkDomain(domain, row.token);
    // the list says whether the domain worked the last time it was checked
    await rest(`published_domains?domain=eq.${encodeURIComponent(domain)}&user_id=eq.${who.id}`, { method: 'PATCH', body: { verified_at: out.verified ? new Date().toISOString() : null }, prefer: 'return=minimal' });
    domainCache.delete(domain);
    return out;
  }

  async function removeDomain(who, domain) {
    const d = encodeURIComponent(domain);
    const row = (await rest(`published_domains?domain=eq.${d}&user_id=eq.${who.id}&select=domain`))?.[0];
    if (!row) return { ok: true };
    // its pages stay published on the app's address
    const moved = await rest(`published_pages?user_id=eq.${who.id}&domain=eq.${d}&select=slug`, { method: 'PATCH', body: { domain: null, home: false }, prefer: 'return=representation' });
    await rest(`published_domains?domain=eq.${d}&user_id=eq.${who.id}`, { method: 'DELETE', prefer: 'return=minimal' });
    forget({ slugs: (moved ?? []).map((m) => m.slug), domains: [domain] });
    domainCache.delete(domain);
    return { ok: true };
  }

  const matchApi = (url) => /^\/api\/(pages|domains)(\/|$)/.test(url.pathname);

  async function handleApi(req, res, url) {
    const reply = (status, body) => send(res, status, body, corsHeaders(req));
    if (!sameOrigin(req, allowedOrigin)) return reply(403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
    if (!enabled) return reply(503, { error: 'Publishing isn’t set up on this server yet: it needs accounts and the SUPABASE_SECRET_KEY Secret. Ask the app’s owner.', code: 'PAGES_OFF' });
    const ident = await whoIs(req, res);
    if (!ident) return;
    const { who } = ident;
    if (!who || !UUID.test(String(who.id))) return reply(401, { error: 'Sign in to publish pages.', code: 'AUTH_REQUIRED' });
    const m = API_PATH.exec(url.pathname);
    if (!m) return reply(404, { error: 'Not found.', code: 'NOT_FOUND' });
    const method = req.method;
    // reads (the list, the name check while typing) are counted apart from changes
    if (rateLimited(`${method === 'GET' ? 'pages-read' : 'pages'}:user:${who.id}`)) return reply(429, { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMIT' });
    const notAllowed = () => reply(405, { error: 'Method not allowed', code: 'METHOD' });
    let target = null;
    if (m[2] !== undefined) {
      try {
        target = decodeURIComponent(m[2]);
      } catch {
        return reply(400, { error: 'Bad address.', code: 'BAD_REQUEST' });
      }
    }
    const readBody = async () => {
      try {
        const b = await readJson(req);
        if (b && typeof b === 'object' && !Array.isArray(b)) return b;
        reply(400, { error: 'Send a JSON object.', code: 'BAD_REQUEST' });
      } catch (e) {
        reply(e.status || 400, { error: e.status === 413 ? 'That’s too much to send at once. Use fewer or smaller images.' : e.message, code: e.status === 413 ? 'TOO_LARGE' : 'BAD_REQUEST' });
      }
      return null;
    };
    try {
      if (m[1] === 'pages') {
        if (m[3]) return reply(404, { error: 'Not found.', code: 'NOT_FOUND' });
        if (target === null) {
          if (method !== 'GET') return notAllowed();
          const [pages, domains] = await Promise.all([
            rest(`published_pages?user_id=eq.${who.id}&select=${PAGE_COLUMNS}&order=updated_at.desc`),
            rest(`published_domains?user_id=eq.${who.id}&select=domain,token,verified_at,created_at&order=created_at.asc`),
          ]);
          const origin = originOf(req);
          return reply(200, { pages: (pages ?? []).map((r) => describePage(r, origin)), domains: (domains ?? []).map(describeDomain), appOrigin: origin });
        }
        if (target === 'check') {
          if (method !== 'GET') return notAllowed();
          const slug = String(url.searchParams.get('slug') ?? '');
          const pageId = String(url.searchParams.get('pageId') ?? '');
          if (pageId && !PAGE_ID_RE.test(pageId)) return reply(400, { error: 'Unknown page.', code: 'BAD_REQUEST' });
          const why = slugProblem(slug);
          if (why) return reply(200, { ok: false, reason: why });
          const holder = (await rest(`published_pages?slug=eq.${slug}&select=user_id,page_id`))?.[0];
          return reply(200, holder && !(holder.user_id === who.id && holder.page_id === pageId) ? { ok: false, reason: 'taken' } : { ok: true });
        }
        if (!PAGE_ID_RE.test(target)) return reply(400, { error: 'Unknown page.', code: 'BAD_REQUEST' });
        if (method === 'PUT') {
          const b = await readBody();
          if (!b) return;
          return reply(200, await publish(req, who, target, b, originOf(req)));
        }
        if (method === 'DELETE') return reply(200, await unpublish(who, target));
        return notAllowed();
      }
      // domains
      if (target === null) {
        if (m[3]) return reply(404, { error: 'Not found.', code: 'NOT_FOUND' });
        if (method !== 'POST') return notAllowed();
        const b = await readBody();
        if (!b) return;
        return reply(200, await addDomain(req, who, typeof b.domain === 'string' ? b.domain : ''));
      }
      const domain = normalizeDomain(target);
      if (!domain || !DOMAIN_RE.test(domain)) return reply(404, { error: 'That domain isn’t in your list.', code: 'NOT_FOUND' });
      if (m[3]) return method === 'POST' ? reply(200, await verifyDomain(who, domain)) : notAllowed();
      if (method === 'DELETE') return reply(200, await removeDomain(who, domain));
      return notAllowed();
    } catch (e) {
      if (!e?.status) console.error(e);
      if (res.headersSent) return;
      return reply(e?.status || 500, { error: e?.status ? e.message : 'Unexpected server error', code: e?.code || 'UPSTREAM', ...(e?.reason ? { reason: e.reason } : {}) });
    }
  }

  /** A deleted account: its pages and domains stop answering on this copy of the server right away. */
  function forgetUser(userId) {
    const theirs = (v) => (Array.isArray(v) ? v.some((r) => r?.user_id === userId) : v?.user_id === userId);
    pageCache.deleteWhere(theirs);
    onDomainCache.deleteWhere(theirs);
    domainCache.deleteWhere(theirs);
    imageCache.dropPrefix(`${userId}/`);
  }

  return {
    enabled,
    /** For GET /api/config. */
    config: () => ({ enabled }),
    forgetUser,
    mayBeDomain,
    serveDomain,
    matchApi,
    handleApi,
    matchPage,
    servePage,
  };
}
