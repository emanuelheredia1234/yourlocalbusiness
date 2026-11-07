// Lead magnets: a business's free download (a PDF, an ebook, a spreadsheet, an audio or video file) or an outside
// link, served at a permanent public address /m/<id>, optionally behind an email gate whose sign-ups go to
// Email → Leads (page_leads, source 'magnet'). Plus public images (a lead magnet's cover now, email images later).
//
//   GET    /api/lead-files?projectId=[&purpose=magnet|product]  → { files: [file] }           (signed in, same site)
//   POST   /api/lead-files                     { projectId, title, brand?, kind: 'file'|'url', url?, gate?,
//                                                purpose?: 'magnet'|'product' } → { file }
//   PUT    /api/lead-files/<id>/content        raw bytes (x-file-name: the file's name) → { file }
//   PATCH  /api/lead-files/<id>                { title?, brand?, gate?, url? } → { file }
//   DELETE /api/lead-files/<id>                → { ok: true } (already gone counts as done; 409 IN_USE while a
//                                              Stripe offer delivers it)
//   POST   /api/public-images[?leadFile=<id>|?use=email]  raw image bytes → { url, path } (with leadFile: that file's
//                                              cover; use=email: an email image, named e-<random>.<ext>)
//   GET    /api/public-images                  → { images: [{ path, url, bytes, createdAt, use: 'email'|'cover' }], limit }
//   DELETE /api/public-images/<name>           the caller's own image; 409 IN_USE while it's a download's cover
//   GET|HEAD|POST /m/<id>                      (visitors) the download: a gate page (no script) or a redirect to a
//                                              60-second signed link or the outside link; POST is the gate's form
//
//   file: { id, projectId, title, brand, kind, fileName, mime, bytes, url, gate, coverUrl, downloads, lastDownloadAt,
//           createdAt, updatedAt, link: <app>/m/<id> }
//
// A product file (purpose 'product', P6): a paid download, a file only, delivered after a Stripe sale through
// /b/<offer>/file (server/offers/stripeCheckout.mjs, signProductDownload below). It is never served at /m/ (not found),
// never a lead form's magnet, and counts toward the same per-account limits.
//
// Tables and buckets (supabase/migrations/20261112000000_leads_p2.sql, purpose: 20261118000000_stripe_connect.sql): lead_files (row-level security on, no
// policies: only this server reaches it), lead-files (private: lead-files/<user id>/<id>/<version>/<name>) and
// public-files (public, images only: public-files/<user id>/<random id>.<ext>). Deleting an account removes all of it
// (server/auth.mjs clears the buckets; the rows cascade).
//
// Uploads are typed by their bytes, never by what the browser says: PDF, EPUB, ZIP, DOCX, XLSX, PPTX, PNG, JPEG,
// WebP, MP3 and MP4 (public images: JPEG, PNG, WebP, GIF). SVG, HTML and anything that starts like markup are
// refused. Limits: 25 MB a file, 20 files and 200 MB per account, 5 MB and 200 public images per account.
//
// /m/<id>: the id (16 random bytes) is the permission. On the app's host and on the owner's verified domains (only
// their own files there). An outside link is a 302 only on the owner's verified domain; on the app's host it's a
// page (no script) that names where it goes and links there, so the app's address never bounces anyone elsewhere. Per visitor and per file, limits per hour (memory only); the row lookup is cached and
// budgeted. 410 once the owner's plan ended more than 30 days ago. A gated file needs an email first, or a ticket
// (?k=, 15 minutes, HMAC) the lead form's answer gives right after a sign-up. Each delivered GET (not HEAD, not a
// prefetch) counts one download (lead_file_downloaded). Nothing a visitor typed, no email, no signed link is logged.
//
// Env: LEAD_LINK_SECRET (optional, 16+ characters: signs the tickets; else derived from SUPABASE_SECRET_KEY),
// MAGNET_HITS_PER_IP_PER_HOUR (default 60), MAGNET_DOWNLOADS_PER_FILE_PER_HOUR (default 600),
// MAGNET_SIGNUPS_PER_FILE_PER_HOUR (default 300: the gate's sign-ups, its own count, so a link in an email to many
// subscribers isn't held to a page form's LEADS_PER_PAGE_PER_HOUR). The gate shares LEADS_PER_IP_PER_HOUR.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { serviceHeaders } from './secretBox.mjs';
import { sameOrigin } from './providers/routes.mjs';
import { LEAD_FILES_BUCKET, PUBLIC_FILES_BUCKET } from './buckets.mjs';
import { ANSWERS, MAGNET_ID, PROJECT_ID_RE, drain, escapeHtml, leadCounters, leadNotice, readForm, readLeadFields, visitorOf, windowCounter } from './leads.mjs';

export const LEAD_FILES_MIGRATION = 'supabase/migrations/20261112000000_leads_p2.sql';

const MB = 1024 * 1024;
export const MAX_LEAD_FILE_BYTES = 25 * MB;
export const MAX_LEAD_FILES_PER_USER = 20;
export const MAX_LEAD_FILE_TOTAL = 200 * MB;
export const MAX_PUBLIC_IMAGE_BYTES = 5 * MB;
export const MAX_PUBLIC_IMAGES_PER_USER = 200;
/** How long a download ticket (?k=) lets a visitor past the gate they just filled in. */
export const TICKET_TTL = 15 * 60_000;
/** How long a signed download link works. */
const SIGNED_SECONDS = 60;
const MAX_TITLE = 200;
const MAX_BRAND = 120;
const MAX_URL = 2000;
const MAX_JSON = 16 * 1024;
const MAX_NAME_HEADER = 200;
const MAX_FILE_NAME = 100;
const TIMEOUT = 10_000;
const LOOKUP_TIMEOUT = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_RE = /^[0-9a-z]{1,12}-[0-9a-f]{10}$/;
const MAGNET_PATH = /^\/m\/([A-Za-z0-9_-]{22})$/;
const MAX_MAGNET_PATH = 25;
const API_PATH = /^\/api\/lead-files(?:\/([^/]{1,64})(\/content)?)?$/;
const IMAGES_PATH = '/api/public-images';
/** A public image's object name under the caller's folder: an email image (e-) or a cover, 16 random bytes, its type. */
const IMAGE_NAME = /^(e-)?[A-Za-z0-9_-]{22}\.(png|jpg|webp|gif)$/;

/** Visitors per hour on /m/ (each request), requests per file per hour, and the gate's sign-ups per file per hour. */
export const MAGNET_LIMITS = Object.freeze({ perIp: 60, perFile: 600, signupsPerFile: 300, windowMs: 3_600_000 });
/** Row lookups for visitors per minute (cache misses only), in all and per client. */
const LOOKUP_BUDGET = { perMin: 600, perClient: 60 };

/** MAGNET_HITS_PER_IP_PER_HOUR, MAGNET_DOWNLOADS_PER_FILE_PER_HOUR and MAGNET_SIGNUPS_PER_FILE_PER_HOUR (whole numbers from 1). */
export function magnetLimitsFromEnv(env = process.env) {
  const count = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
  };
  return {
    perIp: count(env.MAGNET_HITS_PER_IP_PER_HOUR, MAGNET_LIMITS.perIp),
    perFile: count(env.MAGNET_DOWNLOADS_PER_FILE_PER_HOUR, MAGNET_LIMITS.perFile),
    signupsPerFile: count(env.MAGNET_SIGNUPS_PER_FILE_PER_HOUR, MAGNET_LIMITS.signupsPerFile),
    windowMs: MAGNET_LIMITS.windowMs,
  };
}

// ── the words the gate page shows (shared with the app: src/lib/consent.ts) ──
const CONSENT = JSON.parse(fs.readFileSync(new URL('../shared/leadConsent.json', import.meta.url), 'utf8'));
const withBrand = (template, brand, capital) => {
  const b = brand || (capital ? CONSENT.fallbackBrand.charAt(0).toUpperCase() + CONSENT.fallbackBrand.slice(1) : CONSENT.fallbackBrand);
  return template.replace('{Brand}', b);
};

// ── download tickets: <expiry in base 36 seconds>.<base64url HMAC-SHA256(secret, "m1|<id>|<expiry>")> ──

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The secret tickets are signed with: LEAD_LINK_SECRET (16+ characters), else HKDF-SHA256 of the Supabase secret key. null without either. */
export function leadLinkSecret(env = process.env) {
  const own = String(env.LEAD_LINK_SECRET ?? '');
  if (own.length >= 16) return Buffer.from(own, 'utf8');
  const key = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '');
  return key ? deriveLinkSecret(key) : null;
}
const deriveLinkSecret = (key) => Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), 'ylb-lead-link', 32));

/** A ticket for one file, valid TICKET_TTL from now. */
export function makeTicket(secret, id, now = Date.now()) {
  const exp = Math.floor((now + TICKET_TTL) / 1000).toString(36);
  return `${exp}.${b64url(crypto.createHmac('sha256', secret).update(`m1|${id}|${exp}`).digest())}`;
}

/** Whether k is an unexpired ticket for this file (and not one that claims to last longer than tickets do). */
export function checkTicket(secret, id, k, now = Date.now()) {
  if (!secret || typeof k !== 'string' || k.length > 80) return false;
  const dot = k.indexOf('.');
  if (dot < 1 || dot > 12) return false;
  const exp = k.slice(0, dot);
  if (!/^[0-9a-z]+$/.test(exp)) return false;
  const at = Number.parseInt(exp, 36) * 1000;
  if (!Number.isFinite(at) || at < now || at > now + TICKET_TTL + 60_000) return false;
  const want = Buffer.from(b64url(crypto.createHmac('sha256', secret).update(`m1|${id}|${exp}`).digest()));
  const got = Buffer.from(k.slice(dot + 1));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ── what a file is, by its bytes ──

const TYPES = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
};
const ZIP_KINDS = new Set(['epub', 'docx', 'xlsx', 'pptx']);

/** Whether bytes start like markup (<, or a BOM or whitespace then <), or hold <svg or <html near the start. */
function looksLikeMarkup(buf) {
  let i = 0;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
  while (i < buf.length && i < 1024 && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x0c)) i++;
  if (buf[i] === 0x3c) return true;
  const head = buf.subarray(0, 1024).toString('latin1').toLowerCase();
  return head.includes('<svg') || head.includes('<html');
}

/** An image's extension by its first bytes (JPEG, PNG, WebP, GIF), or null. */
function imageExt(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  const head = buf.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * A lead file's type by its bytes: { ext, mime } or null (refused). nameExt: the extension the owner's file name
 * had, which only tells the ZIP-based formats apart (EPUB, DOCX, XLSX, PPTX; else a plain ZIP).
 */
export function sniffLeadFile(buf, nameExt = '') {
  if (!buf || buf.length < 4 || looksLikeMarkup(buf)) return null;
  const head = buf.subarray(0, 12).toString('latin1');
  let ext = null;
  if (head.startsWith('%PDF-')) ext = 'pdf';
  else if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) ext = ZIP_KINDS.has(nameExt) ? nameExt : 'zip';
  else if (head.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && buf[1] !== 0xff)) ext = 'mp3';
  else if (buf.length >= 12 && head.slice(4, 8) === 'ftyp') ext = 'mp4';
  else {
    const img = imageExt(buf);
    // GIF isn't one of the download types (the lead-files bucket doesn't take it)
    if (img && img !== 'gif') ext = img;
  }
  return ext ? { ext, mime: TYPES[ext] } : null;
}

/** A public image's type by its bytes (JPEG, PNG, WebP, GIF; never SVG): { ext, mime } or null. */
export function sniffPublicImage(buf) {
  if (!buf || looksLikeMarkup(buf)) return null;
  const ext = imageExt(buf);
  return ext ? { ext, mime: TYPES[ext] } : null;
}

/** The file name as stored: [A-Za-z0-9._ -] only, at most 100 characters, ending in the type's own extension. */
export function cleanFileName(raw, ext) {
  let s = String(raw ?? '').slice(0, MAX_NAME_HEADER);
  try {
    s = decodeURIComponent(s);
  } catch {
    /* sent as it is */
  }
  s = s
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._ -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s-]+/, '');
  const dot = s.lastIndexOf('.');
  let base = (dot > 0 ? s.slice(0, dot) : s).replace(/[.\s]+$/, '');
  if (!base) base = 'download';
  base = base.slice(0, MAX_FILE_NAME - ext.length - 1).replace(/[.\s]+$/, '') || 'download';
  return `${base}.${ext}`;
}
/** The extension a name as sent ends in (lower case), for telling ZIP-based formats apart. */
const extOf = (raw) => {
  const m = /\.([A-Za-z0-9]{1,8})\s*$/.exec(String(raw ?? '').slice(0, MAX_NAME_HEADER));
  return m ? m[1].toLowerCase() : '';
};

/** An owner's outside link: http(s), a host with a dot, no user name or password, at most 2000 characters. The URL as parsed, or null. */
export function normalizeLink(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_URL) return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || !u.hostname.includes('.') || u.hostname.endsWith('.')) return null;
  const href = u.href;
  return href.length <= MAX_URL ? href : null;
}

const formatBytes = (n) => (n >= MB ? `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const GATE_STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2937; background: #ffffff; }
  main { padding: 24px; max-width: 28rem; width: 100%; box-sizing: border-box; }
  h1 { margin: 0 0 4px; font-size: 1.5rem; }
  p { margin: 0 0 16px; color: #4b5563; }
  img { display: block; max-width: 100%; max-height: 240px; margin: 0 auto 16px; border-radius: 8px; }
  label { display: block; margin: 0 0 12px; font-size: 0.95rem; }
  input[type=text], input[type=email] { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 10px 12px; font: inherit; border: 1px solid #9ca3af; border-radius: 6px; }
  label.check { display: flex; gap: 8px; align-items: flex-start; }
  label.check input { margin-top: 4px; }
  button { width: 100%; padding: 12px; font: inherit; font-weight: 600; color: #ffffff; background: #1d4ed8; border: 0; border-radius: 6px; cursor: pointer; }
  small { display: block; margin-top: 12px; color: #6b7280; }
  .hp { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
  @media (prefers-color-scheme: dark) { body { color: #f3f4f6; background: #111827; } p, small { color: #9ca3af; } input[type=text], input[type=email] { color: #f3f4f6; background: #1f2937; border-color: #4b5563; } }
`;

/**
 * deps: enabled, supabaseUrl, secretKey, fetch (Supabase); whoIs, send, readJson, rateLimited, corsHeaders,
 * allowedOrigin (the server's own); billing (requireActive, pagesServeUntil); mustExist(uid) and originOf(req)
 * (pages.mjs's); notFound(req, res) and gone(req, res) (the published pages' pages); visitor(req) (pages.mjs's client
 * key, for the lookup budget); keepLead(row) (server/leads.mjs) and counters (the lead forms' per-visitor and
 * per-page counters, shared); limits (MAGNET_LIMITS); linkSecret (a Buffer; else derived from secretKey).
 */
export function createLeadFiles({
  enabled = false,
  supabaseUrl = '',
  secretKey = '',
  fetch = globalThis.fetch,
  whoIs,
  send,
  readJson,
  rateLimited = () => false,
  corsHeaders = () => ({}),
  allowedOrigin = '',
  billing = null,
  mustExist = async () => {},
  originOf = () => '',
  notFound = (req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('Not found');
  },
  gone = (req, res) => {
    res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('Gone');
  },
  visitor = (req) => visitorOf(req),
  keepLead = async () => {
    throw new Error('no keepLead');
  },
  counters = null,
  limits = MAGNET_LIMITS,
  linkSecret = null,
} = {}) {
  let base = String(supabaseUrl);
  while (base.endsWith('/')) base = base.slice(0, -1);
  const headers = secretKey ? serviceHeaders(secretKey) : {};
  const storageAuth = { ...headers };
  delete storageAuth['content-type'];
  const secret = linkSecret ?? (secretKey ? deriveLinkSecret(secretKey) : null);
  const lim = { ...MAGNET_LIMITS, ...(limits || {}) };
  const perHit = windowCounter(lim.perIp, lim.windowMs);
  const perFile = windowCounter(lim.perFile, lim.windowMs);
  const perSignup = windowCounter(lim.signupsPerFile, lim.windowMs);
  const gateCounters = counters ?? leadCounters();

  const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
  let warnedTable = false;
  const tableMissing = () => {
    if (!warnedTable) {
      warnedTable = true;
      console.warn(`Lead magnets: the lead_files table isn’t in Supabase yet. Run ${LEAD_FILES_MIGRATION} in Supabase → SQL Editor.`);
    }
    return fail(503, 'LEAD_FILES_TABLE', `Run ${LEAD_FILES_MIGRATION} in Supabase → SQL Editor.`);
  };
  const warnedAt = new Map();
  /** One line a minute per kind, codes only: never an id with an email, never what a visitor typed, never a signed link. */
  const warn = (kind, line) => {
    if (Date.now() - (warnedAt.get(kind) ?? 0) < 60_000) return;
    warnedAt.set(kind, Date.now());
    console.warn(line);
  };
  const unreachable = (e) => fail(502, 'UPSTREAM', e?.name === 'TimeoutError' ? 'Supabase took too long to answer. Try again.' : 'Couldn’t reach Supabase. Try again.');

  async function rest(query, { method = 'GET', body, prefer, timeout = TIMEOUT } = {}) {
    let res;
    try {
      res = await fetch(`${base}/rest/v1/${query}`, { method, headers: { ...headers, ...(prefer ? { prefer } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
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
    const code = String(data?.code ?? '').slice(0, 16);
    const message = String(data?.message ?? '').slice(0, 300);
    if ((res.status === 404 && (code === 'PGRST205' || code === '42P01' || code === 'PGRST202' || message.includes('lead_files') || message.includes('lead_file_downloaded'))) || code === 'PGRST204' || code === '42703') throw tableMissing();
    if (code === '23503') throw fail(401, 'ACCOUNT_GONE', 'This account doesn’t exist anymore. Sign in again.');
    warn('rest', `Lead magnets: Supabase refused a request (${res.status}${code ? ` ${code}` : ''}).`);
    throw fail(502, 'UPSTREAM', `Supabase refused that (error ${res.status}). Try again.`);
  }

  const objectPath = (p) => p.split('/').map(encodeURIComponent).join('/');
  async function storage(pathname, init = {}, timeout = 30_000) {
    try {
      return await fetch(`${base}/storage/v1/${pathname}`, { ...init, headers: { ...storageAuth, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw unreachable(e);
    }
  }
  const bucketGone = (bucket) => fail(503, 'LEAD_FILES_BUCKET', `The ${bucket} bucket isn’t in Supabase yet. Run ${LEAD_FILES_MIGRATION} in Supabase → SQL Editor.`);
  async function putObject(bucket, path, bytes, mime) {
    const res = await storage(`object/${bucket}/${objectPath(path)}`, { method: 'POST', headers: { 'content-type': mime, 'x-upsert': 'true' }, body: bytes }, 120_000);
    const text = await res.text().catch(() => '');
    if (res.ok) return;
    if (/bucket not found/i.test(text)) throw bucketGone(bucket);
    throw fail(502, 'UPSTREAM', `Couldn’t store the file in Supabase (error ${res.status}). Try again.`);
  }
  /** The files under a folder (and one level of sub-folders): their paths. A missing bucket holds nothing. */
  async function listFiles(bucket, prefix, depth = 1) {
    const res = await storage(`object/list/${bucket}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix, limit: 1000, offset: 0 }) });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      if (/bucket not found/i.test(text)) return [];
      throw fail(502, 'UPSTREAM', `Couldn’t list stored files (error ${res.status}).`);
    }
    let items;
    try {
      items = JSON.parse(text);
    } catch {
      items = [];
    }
    const out = [];
    for (const i of Array.isArray(items) ? items : []) {
      if (typeof i?.name !== 'string') continue;
      if (i.id != null) out.push({ path: `${prefix}${i.name}`, folder: '' });
      else if (depth > 0) for (const f of await listFiles(bucket, `${prefix}${i.name}/`, depth - 1)) out.push({ path: f.path, folder: f.folder || i.name });
    }
    return out;
  }
  async function removeObjects(bucket, paths) {
    for (let i = 0; i < paths.length; i += 1000) {
      const res = await storage(`object/${bucket}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: paths.slice(i, i + 1000) }) });
      const text = await res.text().catch(() => '');
      if (!res.ok && !/bucket not found/i.test(text)) throw fail(502, 'UPSTREAM', `Couldn’t remove stored files (error ${res.status}).`);
    }
  }
  const publicUrl = (path) => `${base}/storage/v1/object/public/${PUBLIC_FILES_BUCKET}/${objectPath(path)}`;
  const supabaseOrigin = (() => {
    try {
      return new URL(base).origin;
    } catch {
      return '';
    }
  })();

  // ── rows ──
  const COLUMNS = 'id,user_id,project_id,title,brand,kind,file_name,mime,bytes,sha256,object_path,url,gate,cover_path,downloads,last_download_at,purpose,created_at,updated_at';
  const describe = (r, origin) => ({
    id: r.id,
    projectId: r.project_id,
    title: r.title ?? '',
    brand: r.brand ?? '',
    kind: r.kind === 'url' ? 'url' : 'file',
    fileName: r.file_name ?? '',
    mime: r.mime ?? '',
    bytes: Number(r.bytes) || 0,
    url: r.kind === 'url' ? r.url ?? '' : '',
    gate: r.gate !== false,
    purpose: r.purpose === 'product' ? 'product' : 'magnet',
    coverUrl: r.cover_path ? publicUrl(r.cover_path) : null,
    downloads: Number(r.downloads) || 0,
    lastDownloadAt: r.last_download_at ?? null,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
    link: `${origin}/m/${r.id}`,
  });
  const ownRow = async (uid, id) => (await rest(`lead_files?id=eq.${id}&user_id=eq.${uid}&select=${COLUMNS}`))?.[0] ?? null;

  // ── the visitors' row cache: id → row | null (fresh 60 s, a miss 30 s), bounded ──
  const cache = new Map(); // id → { row, until }
  const MAX_CACHED = 5000;
  const forget = (id) => cache.delete(id);
  let budgetStart = 0;
  let budgetAll = 0;
  const budgetClients = new Map();
  const takeLookup = (client) => {
    const now = Date.now();
    if (now - budgetStart >= 60_000) {
      budgetStart = now;
      budgetAll = 0;
      budgetClients.clear();
    }
    const key = budgetClients.size >= 10_000 && !budgetClients.has(client) ? '(others)' : client;
    const mine = budgetClients.get(key) ?? 0;
    if (budgetAll >= LOOKUP_BUDGET.perMin || mine >= LOOKUP_BUDGET.perClient) return false;
    budgetAll++;
    budgetClients.set(key, mine + 1);
    return true;
  };
  const inflight = new Map();
  /** A lead file's row for visitors (cached; throws BUSY over the budget, or when Supabase can't answer). */
  async function findRow(id, client = 'server') {
    const hit = cache.get(id);
    if (hit && hit.until > Date.now()) return hit.row;
    if (inflight.has(id)) return inflight.get(id);
    if (!takeLookup(client)) throw fail(503, 'BUSY', 'Too many lookups right now.');
    const p = rest(`lead_files?id=eq.${id}&select=${COLUMNS}`, { timeout: LOOKUP_TIMEOUT })
      .then(
        (rows) => {
          const row = rows?.[0] ?? null;
          cache.delete(id);
          cache.set(id, { row, until: Date.now() + (row ? 60_000 : 30_000) });
          while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
          return row;
        },
        (e) => {
          // the migration wasn't run: there are no lead magnets
          if (e?.code === 'LEAD_FILES_TABLE') return null;
          throw e;
        },
      )
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  }
  /** For the lead forms (server/leads.mjs): a lead magnet's { id, user_id, project_id, title }, or null. client: the visitor's key, for the lookup budget. */
  async function findMagnet(id, client = 'server') {
    if (typeof id !== 'string' || !MAGNET_ID.test(id)) return null;
    const r = await findRow(id, typeof client === 'string' && client ? client.slice(0, 200) : 'server');
    // a paid product file is never a lead form's free download
    return r && r.purpose !== 'product' ? { id: r.id, user_id: r.user_id, project_id: r.project_id, title: r.title ?? '' } : null;
  }
  /** A ticket for a file (server/leads.mjs gives it after a sign-up that named the file). */
  const ticket = (id) => {
    if (!secret) throw new Error('no secret');
    return makeTicket(secret, id);
  };

  // ── the signed-in API ──
  const matchApi = (url) => url.pathname === IMAGES_PATH || url.pathname.startsWith(`${IMAGES_PATH}/`) || url.pathname === '/api/lead-files' || url.pathname.startsWith('/api/lead-files/');

  /** A raw body of at most max bytes (content-length required). Rejects with { status: 411 | 413 | 400 }. */
  function readRaw(req, max) {
    return new Promise((resolve, reject) => {
      const refuse = (status) => reject(Object.assign(new Error('That upload couldn’t be read.'), { status }));
      const raw = req.headers['content-length'];
      const length = typeof raw === 'string' && /^\d{1,12}$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isFinite(length)) {
        drain(req);
        return refuse(411);
      }
      if (length > max) {
        drain(req);
        return refuse(413);
      }
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size <= max) chunks.push(c);
        else req.destroy();
      });
      req.on('end', () => (size > max ? refuse(413) : resolve(Buffer.concat(chunks))));
      req.on('error', () => refuse(size > max ? 413 : 400));
      req.on('close', () => refuse(size > max ? 413 : 400));
    });
  }

  async function needsActive(who) {
    if (!billing?.requireActive) return;
    try {
      await billing.requireActive(who, 'publish');
    } catch (e) {
      if (e?.status === 402) throw fail(402, e.code, e.message, { need: e.extra?.need, upgrade: '#plans' });
      throw fail(503, 'UNAVAILABLE', 'Couldn’t check your plan just now. Try again in a minute.');
    }
  }

  const text = (v, max, what) => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length > max * 4) throw fail(400, 'BAD_REQUEST', `${what} must be text, at most ${max} characters.`);
    const s = v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (Array.from(s).length > max) throw fail(400, 'BAD_REQUEST', `${what} can be at most ${max} characters.`);
    return s;
  };
  const linkOf = (v) => {
    const href = normalizeLink(v);
    if (!href) throw fail(400, 'BAD_URL', 'Use a full web address starting with https://, without a user name or password.');
    return href;
  };

  async function create(who, b, origin) {
    const uid = who.id;
    const projectId = typeof b.projectId === 'string' && b.projectId.length <= 80 && PROJECT_ID_RE.test(b.projectId) ? b.projectId : null;
    if (!projectId) throw fail(400, 'BAD_REQUEST', 'Unknown business.');
    const kind = b.kind === 'url' ? 'url' : b.kind === 'file' || b.kind === undefined ? 'file' : null;
    if (!kind) throw fail(400, 'BAD_REQUEST', 'A lead magnet is a file or a link.');
    const purpose = b.purpose === undefined || b.purpose === 'magnet' ? 'magnet' : b.purpose === 'product' ? 'product' : null;
    if (!purpose) throw fail(400, 'BAD_REQUEST', 'A download is a lead magnet or a product.');
    if (purpose === 'product' && kind !== 'file') throw fail(400, 'BAD_REQUEST', 'A product download is a file.');
    const title = text(b.title, MAX_TITLE, 'The title') ?? '';
    const brand = text(b.brand, MAX_BRAND, 'The business name') ?? '';
    if (b.gate !== undefined && typeof b.gate !== 'boolean') throw fail(400, 'BAD_REQUEST', 'gate must be true or false.');
    const url = kind === 'url' ? linkOf(b.url) : '';
    const mine = (await rest(`lead_files?user_id=eq.${uid}&select=id&limit=${MAX_LEAD_FILES_PER_USER + 1}`)) ?? [];
    if (mine.length >= MAX_LEAD_FILES_PER_USER) throw fail(400, 'TOO_MANY', `You can publish up to ${MAX_LEAD_FILES_PER_USER} downloads. Unpublish one first.`);
    await mustExist(uid);
    const id = b64url(crypto.randomBytes(16));
    // a product file has no email gate (the buyer paid; /m/ never serves it)
    const gate = purpose === 'product' ? false : b.gate !== false;
    const rows = await rest(`lead_files?select=${COLUMNS}`, { method: 'POST', body: { id, user_id: uid, project_id: projectId, title, brand, kind, url, gate, purpose }, prefer: 'return=representation' });
    return { file: describe(rows?.[0] ?? { id, user_id: uid, project_id: projectId, title, brand, kind, url, gate, purpose }, origin) };
  }

  async function update(who, id, b, origin) {
    const row = await ownRow(who.id, id);
    if (!row) throw fail(404, 'NOT_FOUND', 'That download isn’t in your list.');
    const patch = {};
    const title = text(b.title, MAX_TITLE, 'The title');
    if (title !== undefined) patch.title = title;
    const brand = text(b.brand, MAX_BRAND, 'The business name');
    if (brand !== undefined) patch.brand = brand;
    if (b.gate !== undefined) {
      if (typeof b.gate !== 'boolean') throw fail(400, 'BAD_REQUEST', 'gate must be true or false.');
      patch.gate = b.gate;
    }
    // a link: the download becomes that link (an upload later makes it a file again)
    if (b.url !== undefined) Object.assign(patch, { kind: 'url', url: linkOf(b.url) });
    if (!Object.keys(patch).length) return { file: describe(row, origin) };
    const rows = await rest(`lead_files?id=eq.${id}&user_id=eq.${who.id}&select=${COLUMNS}`, { method: 'PATCH', body: { ...patch, updated_at: new Date().toISOString() }, prefer: 'return=representation' });
    forget(id);
    if (!rows?.[0]) throw fail(404, 'NOT_FOUND', 'That download isn’t in your list.');
    return { file: describe(rows[0], origin) };
  }

  async function upload(req, who, id, origin) {
    const uid = who.id;
    const row = await ownRow(uid, id);
    if (!row) {
      drain(req);
      throw fail(404, 'NOT_FOUND', 'That download isn’t in your list.');
    }
    const sentName = String(req.headers['x-file-name'] ?? '');
    if (sentName.length > MAX_NAME_HEADER) {
      drain(req);
      throw fail(400, 'BAD_REQUEST', 'That file name is too long.');
    }
    let bytes;
    try {
      bytes = await readRaw(req, MAX_LEAD_FILE_BYTES);
    } catch (e) {
      if (e.status === 413) throw fail(413, 'TOO_LARGE', `A download can be up to ${MAX_LEAD_FILE_BYTES / MB} MB.`);
      if (e.status === 411) throw fail(411, 'BAD_REQUEST', 'Send the file’s size (Content-Length).');
      throw fail(400, 'BAD_REQUEST', 'That upload couldn’t be read.');
    }
    if (!bytes.length) throw fail(400, 'BAD_REQUEST', 'That file is empty.');
    const type = sniffLeadFile(bytes, extOf(sentName));
    if (!type) throw fail(415, 'FILE_TYPE', 'Upload a PDF, EPUB, ZIP, Word, Excel or PowerPoint file, a PNG, JPEG or WebP image, an MP3 or an MP4.');
    const others = (await rest(`lead_files?user_id=eq.${uid}&id=neq.${id}&select=bytes&limit=${MAX_LEAD_FILES_PER_USER + 5}`)) ?? [];
    const used = others.reduce((n, r) => n + (Number(r.bytes) || 0), 0);
    if (used + bytes.length > MAX_LEAD_FILE_TOTAL) throw fail(413, 'QUOTA', `Your downloads can take up to ${MAX_LEAD_FILE_TOTAL / MB} MB in all. Remove one first.`);
    await mustExist(uid);
    const fileName = cleanFileName(sentName, type.ext);
    // a new version's own folder: the live link keeps the file it has until the row points here
    const version = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
    const path = `${uid}/${id}/${version}/${fileName}`;
    await putObject(LEAD_FILES_BUCKET, path, bytes, type.mime);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    let rows;
    try {
      rows = await rest(`lead_files?id=eq.${id}&user_id=eq.${uid}&select=${COLUMNS}`, { method: 'PATCH', body: { kind: 'file', url: '', file_name: fileName, mime: type.mime, bytes: bytes.length, sha256, object_path: path, updated_at: new Date().toISOString() }, prefer: 'return=representation' });
    } catch (e) {
      await removeObjects(LEAD_FILES_BUCKET, [path]).catch(() => {});
      throw e;
    }
    forget(id);
    if (!rows?.[0]) {
      // removed meanwhile
      await removeObjects(LEAD_FILES_BUCKET, [path]).catch(() => {});
      throw fail(404, 'NOT_FOUND', 'That download isn’t in your list.');
    }
    // the versions before this one go (best effort: a leftover is only unused space)
    try {
      const old = (await listFiles(LEAD_FILES_BUCKET, `${uid}/${id}/`)).filter((f) => f.folder !== version && (!f.folder || VERSION_RE.test(f.folder))).map((f) => f.path);
      if (old.length) await removeObjects(LEAD_FILES_BUCKET, old);
    } catch {
      warn('versions', 'Lead magnets: couldn’t remove an earlier version of a download.');
    }
    return { file: describe(rows[0], origin) };
  }

  async function remove(who, id) {
    const uid = who.id;
    // a Stripe offer that delivers this file keeps it (a buyer's paid download must still be there)
    const offers = (await rest(`offers?user_id=eq.${uid}&provider=eq.stripe&status=neq.archived&select=id,delivery&limit=1000`).catch((e) => (e?.code === 'LEAD_FILES_TABLE' ? [] : Promise.reject(e)))) ?? [];
    if (offers.some((o) => o?.delivery?.kind === 'file' && o.delivery.fileId === id)) throw fail(409, 'IN_USE', 'A buy link delivers this file. Change or archive that offer first.');
    const gone = (await rest(`lead_files?id=eq.${id}&user_id=eq.${uid}&select=id,cover_path`, { method: 'DELETE', prefer: 'return=representation' })) ?? [];
    forget(id);
    if (!gone.length) return { ok: true };
    const files = (await listFiles(LEAD_FILES_BUCKET, `${uid}/${id}/`)).map((f) => f.path);
    if (files.length) await removeObjects(LEAD_FILES_BUCKET, files);
    const cover = String(gone[0].cover_path ?? '');
    if (cover.startsWith(`${uid}/`)) await removeObjects(PUBLIC_FILES_BUCKET, [cover]).catch(() => {});
    return { ok: true };
  }

  async function publicImage(req, who, url, origin) {
    const uid = who.id;
    const leadFile = url.searchParams.get('leadFile');
    const use = url.searchParams.get('use');
    if (use !== null && use !== 'email') {
      drain(req);
      throw fail(400, 'BAD_REQUEST', 'Unknown use for this image.');
    }
    if (leadFile !== null && !(leadFile.length === 22 && MAGNET_ID.test(leadFile))) {
      drain(req);
      throw fail(404, 'NOT_FOUND', 'That download isn’t in your list.');
    }
    const row = leadFile ? await ownRow(uid, leadFile) : null;
    if (leadFile && !row) {
      drain(req);
      throw fail(404, 'NOT_FOUND', 'That download isn’t in your list.');
    }
    let bytes;
    try {
      bytes = await readRaw(req, MAX_PUBLIC_IMAGE_BYTES);
    } catch (e) {
      if (e.status === 413) throw fail(413, 'TOO_LARGE', `An image can be up to ${MAX_PUBLIC_IMAGE_BYTES / MB} MB.`);
      if (e.status === 411) throw fail(411, 'BAD_REQUEST', 'Send the image’s size (Content-Length).');
      throw fail(400, 'BAD_REQUEST', 'That upload couldn’t be read.');
    }
    const type = sniffPublicImage(bytes);
    if (!type) throw fail(415, 'FILE_TYPE', 'Use a JPEG, PNG, WebP or GIF image.');
    const have = await listFiles(PUBLIC_FILES_BUCKET, `${uid}/`, 0);
    if (have.length >= MAX_PUBLIC_IMAGES_PER_USER) throw fail(400, 'TOO_MANY', `You can keep up to ${MAX_PUBLIC_IMAGES_PER_USER} public images. Remove a download’s cover first.`);
    await mustExist(uid);
    // an email image is named e-<random> so the list can tell it from a download's cover (a cover never is)
    const path = `${uid}/${use === 'email' && !row ? 'e-' : ''}${b64url(crypto.randomBytes(16))}.${type.ext}`;
    await putObject(PUBLIC_FILES_BUCKET, path, bytes, type.mime);
    if (row) {
      let rows;
      try {
        rows = await rest(`lead_files?id=eq.${row.id}&user_id=eq.${uid}&select=id`, { method: 'PATCH', body: { cover_path: path, updated_at: new Date().toISOString() }, prefer: 'return=representation' });
      } catch (e) {
        await removeObjects(PUBLIC_FILES_BUCKET, [path]).catch(() => {});
        throw e;
      }
      forget(row.id);
      if (!rows?.length) {
        await removeObjects(PUBLIC_FILES_BUCKET, [path]).catch(() => {});
        throw fail(404, 'NOT_FOUND', 'That download isn’t in your list.');
      }
      const previous = String(row.cover_path ?? '');
      if (previous && previous !== path && previous.startsWith(`${uid}/`)) await removeObjects(PUBLIC_FILES_BUCKET, [previous]).catch(() => {});
    }
    return { url: publicUrl(path), path };
  }

  /** The caller's public images: email images and covers, newest first. */
  async function listPublicImages(uid) {
    const prefix = `${uid}/`;
    const res = await storage(`object/list/${PUBLIC_FILES_BUCKET}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'created_at', order: 'desc' } }) });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      if (/bucket not found/i.test(text)) return { images: [], limit: MAX_PUBLIC_IMAGES_PER_USER };
      throw fail(502, 'UPSTREAM', `Couldn’t list your images (error ${res.status}).`);
    }
    let items;
    try {
      items = JSON.parse(text);
    } catch {
      items = [];
    }
    const images = (Array.isArray(items) ? items : [])
      .filter((i) => i?.id != null && typeof i.name === 'string' && IMAGE_NAME.test(i.name))
      .map((i) => ({
        path: `${prefix}${i.name}`,
        url: publicUrl(`${prefix}${i.name}`),
        bytes: Number(i.metadata?.size) || 0,
        createdAt: typeof i.created_at === 'string' ? i.created_at : null,
        use: i.name.startsWith('e-') ? 'email' : 'cover',
      }));
    return { images, limit: MAX_PUBLIC_IMAGES_PER_USER };
  }

  /** One of the caller's public images, unless a download uses it as its cover (409 IN_USE). Gone already: done. */
  async function removePublicImage(uid, name) {
    const path = `${uid}/${name}`;
    const using = (await rest(`lead_files?user_id=eq.${uid}&cover_path=eq.${encodeURIComponent(path)}&select=id&limit=1`)) ?? [];
    if (using.length) throw fail(409, 'IN_USE', 'This image is a download’s cover. Change the cover first.');
    await removeObjects(PUBLIC_FILES_BUCKET, [path]);
    return { ok: true };
  }

  async function handleApi(req, res, url) {
    const reply = (status, body) => send(res, status, body, corsHeaders(req));
    const p = url.pathname;
    if (!sameOrigin(req, allowedOrigin)) {
      drain(req);
      return reply(403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
    }
    if (!enabled) {
      drain(req);
      return reply(503, { error: 'Publishing isn’t set up on this server yet: it needs accounts and the SUPABASE_SECRET_KEY Secret. Ask the app’s owner.', code: 'PAGES_OFF' });
    }
    const ident = await whoIs(req, res);
    if (!ident) return;
    const { who } = ident;
    const uid = String(who?.id ?? '');
    if (!who || uid.length !== 36 || !UUID.test(uid)) {
      drain(req);
      return reply(401, { error: 'Sign in to publish downloads.', code: 'AUTH_REQUIRED' });
    }
    const method = req.method;
    if (rateLimited(`lead-files${method === 'GET' ? '-read' : ''}:user:${uid}`)) {
      drain(req);
      return reply(429, { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMIT' });
    }
    const origin = originOf(req);
    const notAllowed = () => {
      drain(req);
      return reply(405, { error: 'Method not allowed', code: 'METHOD' });
    };
    const notFoundHere = () => {
      drain(req);
      return reply(404, { error: 'That download isn’t in your list.', code: 'NOT_FOUND' });
    };
    const body = async () => {
      try {
        const b = await readJson(req, MAX_JSON);
        if (b && typeof b === 'object' && !Array.isArray(b)) return b;
      } catch (e) {
        throw fail(e?.status === 413 ? 413 : 400, e?.status === 413 ? 'TOO_LARGE' : 'BAD_REQUEST', e?.status === 413 ? 'That’s too much to send at once.' : 'That request couldn’t be read.');
      }
      throw fail(400, 'BAD_REQUEST', 'Send a JSON object.');
    };
    try {
      if (p === IMAGES_PATH) {
        // listing and removing never need a plan
        if (method === 'GET') return reply(200, await listPublicImages(uid));
        if (method !== 'POST') return notAllowed();
        await needsActive(who);
        return reply(200, await publicImage(req, who, url, origin));
      }
      if (p.startsWith(`${IMAGES_PATH}/`)) {
        const name = p.slice(IMAGES_PATH.length + 1);
        if (method !== 'DELETE') return notAllowed();
        if (name.length > 40 || !IMAGE_NAME.test(name)) {
          drain(req);
          return reply(404, { error: 'That image isn’t in your list.', code: 'NOT_FOUND' });
        }
        return reply(200, await removePublicImage(uid, name));
      }
      const m = p.length <= 120 ? API_PATH.exec(p) : null;
      if (!m) return notFoundHere();
      const [, id, content] = m;
      if (id === undefined) {
        if (method === 'GET') {
          const projectId = url.searchParams.get('projectId') ?? '';
          if (projectId && (projectId.length > 80 || !PROJECT_ID_RE.test(projectId))) return reply(400, { error: 'Unknown business.', code: 'BAD_REQUEST' });
          const purpose = url.searchParams.get('purpose');
          if (purpose !== null && purpose !== 'magnet' && purpose !== 'product') return reply(400, { error: 'Unknown purpose.', code: 'BAD_REQUEST' });
          const rows = await rest(`lead_files?user_id=eq.${uid}${projectId ? `&project_id=eq.${projectId}` : ''}${purpose ? `&purpose=eq.${purpose}` : ''}&select=${COLUMNS}&order=created_at.desc&limit=100`);
          return reply(200, { files: (rows ?? []).map((r) => describe(r, origin)) });
        }
        if (method !== 'POST') return notAllowed();
        await needsActive(who);
        return reply(200, await create(who, await body(), origin));
      }
      if (id.length !== 22 || !MAGNET_ID.test(id)) return notFoundHere();
      if (content) {
        if (method !== 'PUT') return notAllowed();
        await needsActive(who);
        return reply(200, await upload(req, who, id, origin));
      }
      if (method === 'PATCH') {
        await needsActive(who);
        return reply(200, await update(who, id, await body(), origin));
      }
      // unpublishing never needs a plan
      if (method === 'DELETE') return reply(200, await remove(who, id));
      return notAllowed();
    } catch (e) {
      if (!e?.status) console.error('Lead magnets:', e?.name || 'Error');
      if (res.headersSent) return;
      // a body that wasn't read (too big, or not sent as promised): this connection isn't used again
      if (e?.status === 413 || e?.status === 411) res.setHeader('connection', 'close');
      drain(req);
      return reply(e?.status || 500, { error: e?.status ? e.message : 'Unexpected server error', code: e?.code || 'UPSTREAM', ...(e?.need ? { need: e.need } : {}), ...(e?.upgrade ? { upgrade: e.upgrade } : {}) });
    }
  }

  // ── /m/<id> for visitors ──
  const PUBLIC_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex', 'cache-control': 'no-store' };
  const GATE_CSP = `default-src 'none'; style-src 'unsafe-inline'; ${supabaseOrigin ? `img-src ${supabaseOrigin}; ` : ''}sandbox allow-forms allow-downloads`;
  const NOTICE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

  const matchMagnet = (url) => enabled && url.pathname.length <= MAX_MAGNET_PATH && MAGNET_PATH.test(url.pathname);

  function write(req, res, status, hdrs, body = '') {
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(status, { ...PUBLIC_HEADERS, ...hdrs, 'content-length': buf.length });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }
  const notice = (req, res, [status, title, words], back, extra = {}) => write(req, res, status, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': NOTICE_CSP, ...extra }, leadNotice(title, words, back));
  const retryAfter = (ms) => ({ 'retry-after': String(Math.max(1, Math.ceil(ms / 1000))) });
  const TOO_MANY = [429, 'Please wait a little', 'This was asked for a lot just now. Try again later.'];
  const NOT_SENT = [503, 'That didn’t go through', 'It couldn’t be sent right now, and nothing was downloaded. Try again in a few minutes.'];

  /** The gate page: no script, nothing but this file's title, name, size and cover, and a plain form. */
  function gatePage(row, problem = null) {
    const brand = row.brand ?? '';
    const what = row.kind === 'url' ? 'a link' : `${escapeHtml(row.file_name || 'a file')} (${formatBytes(Number(row.bytes) || 0)})`;
    const title = escapeHtml(row.title || 'Your free download');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${GATE_STYLE}</style>
</head>
<body>
<main>
${row.cover_path ? `<img src="${escapeHtml(publicUrl(row.cover_path))}" alt="">\n` : ''}<h1>${title}</h1>
<p>${problem ? escapeHtml(problem) : `Enter your email to get ${what}.`}</p>
<form method="post" action="/m/${row.id}">
<label>Name (optional)<input type="text" name="name" maxlength="120" autocomplete="name"></label>
<label>Email<input type="email" name="email" maxlength="254" required autocomplete="email"></label>
<label class="check"><input type="checkbox" name="consent" value="yes"><span>${escapeHtml(withBrand(CONSENT.checkbox, brand, false))}</span></label>
<div class="hp" aria-hidden="true"><label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
<button type="submit">Get it</button>
</form>
<small>${escapeHtml(withBrand(CONSENT.magnetReceives, brand, true))}</small>
</main>
</body>
</html>
`;
  }

  /**
   * An outside link on the app's host: not a redirect (the app's address would vouch for anywhere) but a page that
   * names the site it goes to and links there. No script; the link opens with no referrer.
   */
  function leavePage(row, href) {
    const host = escapeHtml(new URL(href).host);
    const title = escapeHtml(row.title || 'Your free download');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${GATE_STYLE}</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>This link goes to another website: <strong>${host}</strong>.</p>
<p><a href="${escapeHtml(href)}" rel="noopener noreferrer">Continue to ${host}</a></p>
</main>
</body>
</html>
`;
  }

  const prefetch = (req) => /prefetch/i.test(`${String(req.headers['sec-purpose'] ?? '').slice(0, 100)} ${String(req.headers.purpose ?? '').slice(0, 100)} ${String(req.headers['x-moz'] ?? '').slice(0, 100)}`);

  async function counted(id) {
    try {
      await rest('rpc/lead_file_downloaded', { method: 'POST', body: { p_id: id }, prefer: 'return=minimal', timeout: LOOKUP_TIMEOUT });
    } catch (e) {
      warn('count', `Lead magnets: couldn’t count a download (${e?.code || 'error'}).`);
    }
  }

  /**
   * The file itself: a redirect to a 60-second signed link, counted for a real GET. An outside link: a redirect on
   * the owner's verified domain (site), else the page that names where it goes.
   */
  async function deliver(req, res, row, status = 302, site = null) {
    let location;
    if (row.kind === 'url') {
      location = normalizeLink(row.url);
      if (location && !site) {
        if (req.method !== 'HEAD' && !prefetch(req)) await counted(row.id);
        write(req, res, 200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': NOTICE_CSP }, leavePage(row, location));
        return true;
      }
    } else {
      const r = await storage(`object/sign/${LEAD_FILES_BUCKET}/${objectPath(row.object_path)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expiresIn: SIGNED_SECONDS }) }, LOOKUP_TIMEOUT);
      const got = await r.json().catch(() => null);
      const signed = typeof got?.signedURL === 'string' ? got.signedURL : '';
      if (!r.ok || !signed.startsWith('/object/sign/')) {
        // the file isn't there (removed by hand) or Storage can't answer
        if (r.status === 400 || r.status === 404) return null;
        throw fail(502, 'UPSTREAM', 'Couldn’t sign the download.');
      }
      location = `${base}/storage/v1${signed}${signed.includes('?') ? '&' : '?'}download=${encodeURIComponent(row.file_name || 'download')}`;
    }
    if (!location) return null;
    if (req.method === 'GET' && !prefetch(req)) await counted(row.id);
    res.writeHead(status, { ...PUBLIC_HEADERS, location, 'content-length': 0 });
    res.end();
    return true;
  }

  /**
   * /m/<id> on the app's host, or (site: serveDomain's verified domain row) on the owner's own domain, where only
   * that owner's files answer. Missing, empty and someone else's are the same "not found".
   */
  async function serveMagnet(req, res, url, site = null) {
    const m = enabled ? MAGNET_PATH.exec(url.pathname) : null;
    if (!m || url.pathname.length > MAX_MAGNET_PATH) return notFound(req, res);
    const id = m[1];
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      drain(req);
      return write(req, res, 405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD, POST' }, 'Method not allowed');
    }
    const back = `/m/${id}`;
    try {
      const who = visitorOf(req);
      if (perHit.full(who)) {
        drain(req);
        return notice(req, res, TOO_MANY, '', retryAfter(perHit.wait(who)));
      }
      perHit.hit(who);
      let row;
      try {
        row = await findRow(id, visitor(req));
      } catch {
        drain(req);
        return notice(req, res, [503, 'This can’t be shown right now', 'Try again in a minute.'], '', retryAfter(60_000));
      }
      // a paid product file is never served here (only /b/<offer>/file after a sale)
      if (!row || row.purpose === 'product' || (row.kind === 'file' && !row.object_path) || (row.kind === 'url' && !row.url) || (site && row.user_id !== site.user_id)) {
        drain(req);
        return notFound(req, res);
      }
      if (billing?.pagesServeUntil) {
        let until = null;
        try {
          until = await billing.pagesServeUntil(row.user_id);
        } catch {
          until = null;
        }
        if (until && Date.parse(until) < Date.now()) {
          drain(req);
          return gone(req, res);
        }
      }
      if (perFile.full(id)) {
        drain(req);
        return notice(req, res, TOO_MANY, '', retryAfter(perFile.wait(id)));
      }
      perFile.hit(id);

      if (method === 'GET' || method === 'HEAD') {
        const k = url.searchParams.get('k');
        if (!row.gate || (k && checkTicket(secret, id, k))) {
          if (!(await deliver(req, res, row, 302, site))) return notFound(req, res);
          return;
        }
        return write(req, res, 200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': GATE_CSP }, gatePage(row));
      }

      // POST: the gate's form
      if (!row.gate) {
        drain(req);
        return write(req, res, 405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }, 'Method not allowed');
      }
      let form;
      try {
        form = await readForm(req);
      } catch (e) {
        return notice(req, res, ANSWERS[e.status === 413 ? 'tooBig' : e.status === 415 ? 'notForm' : 'unreadable'], back);
      }
      // a bot filled in the hidden field: back to the gate, nothing kept, no file
      if (form.get('website')) {
        res.writeHead(303, { ...PUBLIC_HEADERS, location: back, 'content-length': 0 });
        return res.end();
      }
      const { fields, problem } = readLeadFields(form, { emailRequired: true });
      if (problem) return write(req, res, 400, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': GATE_CSP }, gatePage(row, ANSWERS[problem][2]));
      // per visitor: the lead forms' own count; per file: the gate's (a link in an email reaches many people at once)
      const { perVisitor } = gateCounters;
      if (perVisitor.full(who)) return notice(req, res, ANSWERS.visitorLimit, back, retryAfter(perVisitor.wait(who)));
      perVisitor.hit(who);
      if (perSignup.full(id)) return notice(req, res, ANSWERS.pageLimit, back, retryAfter(perSignup.wait(id)));
      perSignup.hit(id);
      const consent = String(form.get('consent') ?? '').slice(0, 10) === 'yes';
      try {
        await keepLead({ user_id: row.user_id, project_id: row.project_id, page_id: `magnet:${id}`, slug: '', source: 'magnet', kind: 'magnet', consent, payload: { request: String(row.title ?? '').slice(0, 200), magnet: id }, name: fields.name, email: fields.email });
      } catch (e) {
        warn('keep', `Lead magnets: couldn’t keep a sign-up (${e?.code || e?.detail || 'error'}).`);
        // never the file unless the sign-up was kept
        return notice(req, res, NOT_SENT, back, retryAfter(60_000));
      }
      if (!(await deliver(req, res, row, 303, site))) return notFound(req, res);
    } catch {
      if (!res.headersSent) notice(req, res, [503, 'This can’t be shown right now', 'Try again in a minute.'], '', retryAfter(60_000));
    }
  }

  /** A deleted account: its files stop answering on this copy of the server right away. */
  function forgetUser(userId) {
    for (const [id, e] of [...cache]) if (e.row?.user_id === userId) cache.delete(id);
  }

  return { matchApi, handleApi, matchMagnet, serveMagnet, findMagnet, ticket, forgetUser };
}

/**
 * A paid product file's 60-second signed download (P6, /b/<offer>/file after a Stripe sale): the signing half of
 * /m/'s deliver(), for a file the seller owns with purpose 'product'. → { location } | null (missing, someone else's,
 * not a product, not uploaded). Doesn't count a magnet download. Throws { status: 502 } when Storage can't answer.
 * supabase: { supabaseUrl, secretKey, fetch }.
 */
export async function signProductDownload({ supabaseUrl = '', secretKey = '', fetch: fetchImpl = globalThis.fetch } = {}, fileId, userId) {
  if (typeof fileId !== 'string' || !MAGNET_ID.test(fileId) || !UUID.test(String(userId ?? ''))) return null;
  let base = String(supabaseUrl);
  while (base.endsWith('/')) base = base.slice(0, -1);
  if (!base || !secretKey) return null;
  const headers = serviceHeaders(secretKey);
  const upstream = () => Object.assign(new Error('Couldn’t sign the download.'), { status: 502, code: 'UPSTREAM' });
  let rows;
  try {
    const r = await fetchImpl(`${base}/rest/v1/lead_files?id=eq.${fileId}&user_id=eq.${userId}&select=id,user_id,kind,purpose,object_path,file_name&limit=1`, { headers, signal: AbortSignal.timeout(LOOKUP_TIMEOUT) });
    if (!r.ok) throw upstream();
    rows = await r.json();
  } catch (e) {
    throw e?.status ? e : upstream();
  }
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || row.user_id !== userId || row.purpose !== 'product' || row.kind !== 'file' || !row.object_path) return null;
  const storageHeaders = { ...headers, 'content-type': 'application/json' };
  const objectPath = String(row.object_path).split('/').map(encodeURIComponent).join('/');
  let r;
  try {
    r = await fetchImpl(`${base}/storage/v1/object/sign/${LEAD_FILES_BUCKET}/${objectPath}`, { method: 'POST', headers: storageHeaders, body: JSON.stringify({ expiresIn: SIGNED_SECONDS }), signal: AbortSignal.timeout(LOOKUP_TIMEOUT) });
  } catch {
    throw upstream();
  }
  const got = await r.json().catch(() => null);
  const signed = typeof got?.signedURL === 'string' ? got.signedURL : '';
  if (!r.ok || !signed.startsWith('/object/sign/')) {
    if (r.status === 400 || r.status === 404) return null;
    throw upstream();
  }
  return { location: `${base}/storage/v1${signed}${signed.includes('?') ? '&' : '?'}download=${encodeURIComponent(row.file_name || 'download')}` };
}
