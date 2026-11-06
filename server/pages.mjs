// Published pages: someone's SEO page or artifact at a public address. On the app's own host it's
// https://<app>/<slug>; on a domain of their own it's https://<domain>/<slug>, or that domain's home page.
//
//   GET    /api/pages                       → { pages, domains, appOrigin }                       (signed in)
//   GET    /api/pages/check?slug=&pageId=   → { ok } | { ok: false, reason: 'taken'|'reserved'|'format' }
//   PUT    /api/pages/<pageId>              { kind, slug, title, html, images, domain?, home?, projectId? } → { page, url, domainUrl? }
//                                           (projectId: the page's business, kept so its leads know it; an SEO page's is its id's)
//   DELETE /api/pages/<pageId>
//   POST   /api/domains                     { domain } → { domain, token, verified, verifiedAt, record }
//                                           (409 DOMAIN_TAKEN when another account has it, with this account's record)
//   POST   /api/domains/<domain>/check      → { verified, error?, domain? }
//   DELETE /api/domains/<domain>
//
// The browser builds the page (its HTML and images). The server checks the address and the images,
// keeps the page in Supabase (published_pages and published_domains: tables only the server can
// reach) and its images in the private media bucket (media/<user id>/published/<page>/<version>/<name>,
// a new folder each time it's published, so deleting the account removes them), and serves both to anyone.
//
// Published HTML is someone else's code, sent from the app's own address, where the app keeps its
// sign-in in localStorage. So on the app's host every page goes out with a CSP sandbox that never
// includes allow-same-origin: the page runs in an origin of its own, with no access to the app's
// storage or to the API as the visitor, and SEO pages can't run scripts at all. On someone's own
// domain the page has the origin to itself, so it isn't sandboxed; the app and /api never answer there.
//
// Hosts: the app and /api answer only on the app's own hosts, a fixed list (appHost): its address on
// Replit (*.replit.app, *.replit.dev, *.repl.co), localhost, IP addresses, names that are never a public
// domain (one label, *.local, *.internal, *.home.arpa), ALLOWED_ORIGIN's host and APP_HOSTS. Every other
// host goes to serveDomain, whatever the database holds and whether publishing is on or not: a verified
// domain shows its owner's pages, any other host a plain "not found" page (503 when that can't be told
// right now). So the app's own custom domain must be in APP_HOSTS.
//
// Own domains: a domain is someone's only while its DNS says so: a TXT record _ylb-domain.<domain> whose
// value is that account's code for the domain. The check is a DNS lookup, never a request to the domain
// (which this server may answer itself). A verified domain is looked at again every few hours and stops
// showing pages once the record is gone. Another account can take a domain over only the same way; the
// previous owner keeps their pages, on the app's address. Only the owner's pages are ever on a domain: the
// database refuses any other (published_pages_domain_owner), and whenever the owner publishes to it or
// checks it, anything of another account's still there comes off.
//
// Visitors: this copy of the server keeps the names that exist (published pages, verified domains), so
// any other name is "not found" without a database lookup. Lookups that miss the cache are limited per
// minute, by count and by bytes, in all and per client (the address the platform's proxy saw: see clientOf).
// A page's HTML is kept apart from its row (a big page's apart from the rest); when the row is read again it's
// read without the HTML, which is read only when the page changed. HEAD never needs the HTML.
//
// Needs accounts and SUPABASE_SECRET_KEY (GET /api/config says pages: { enabled } either way).
// Env: APP_HOSTS (comma-separated: other hosts the app itself runs on, which nobody can claim);
// PAGES_DNS_SERVERS (optional, comma-separated: the DNS servers the domain check asks; default the system's);
// TRUSTED_PROXY_HOPS (optional: how many X-Forwarded-For addresses the platform's proxies add; default 2).

import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { serviceHeaders } from './secretBox.mjs';
import { sameOrigin } from './providers/routes.mjs';
// lead forms on published pages: POST /<slug>/lead and /api/leads (server/leads.mjs)
import { LEADS_P2_MIGRATION, createLeads, leadCounters, leadLimitsFromEnv } from './leads.mjs';
// lead magnets: /m/<id>, /api/lead-files and /api/public-images (server/leadFiles.mjs)
import { createLeadFiles, leadLinkSecret, magnetLimitsFromEnv } from './leadFiles.mjs';

export const PAGES_MIGRATION = 'supabase/migrations/20261103040000_published_pages.sql';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;
export const PAGE_ID_RE = /^(seo|artifact):[A-Za-z0-9_-]{1,80}$/;
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IMAGE_NAME_RE = /^img-\d{1,2}\.(jpg|png|webp|gif)$/;
/** The folder one publish keeps its images in: <time in base 36>-<random>. */
const VERSION_RE = /^([0-9a-z]{1,12})-[0-9a-f]{10}$/;
/** This server's codes for a domain (tokenFor). Rows from before DNS checks have 32 hex digits. */
const TOKEN_RE = /^ylb-[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** /<slug>, /<slug>/ and /<slug>/img/<name>: the paths a published page answers on. */
const PAGE_PATH = /^\/([a-z0-9][a-z0-9-]{1,58}[a-z0-9])(?:(\/)|\/img\/([^/]+))?$/;
const API_PATH = /^\/api\/(pages|domains)(?:\/([^/]+))?(\/check)?$/;

/** The TXT record that shows whose a domain is: _ylb-domain.<domain>, with the account's code as its value. */
export const TXT_LABEL = '_ylb-domain';
export const txtName = (domain) => `${TXT_LABEL}.${domain}`;

/** Names that stay the app's own (plus every top-level name in dist/). */
export const RESERVED_SLUGS = new Set([
  'api', 'assets', 'static', 'public', 'p', 's', 'u', 'i', 'img', 'images', 'media', 'files', 'file', 'download', 'downloads',
  'admin', 'administrator', 'login', 'logout', 'signin', 'sign-in', 'signup', 'sign-up', 'register', 'auth', 'oauth', 'callback',
  'account', 'accounts', 'settings', 'dashboard', 'app', 'apps', 'billing', 'pay', 'payment', 'payments', 'checkout', 'support',
  'help', 'security', 'privacy', 'terms', 'legal', 'status', 'docs', 'www', 'mail', 'email', 'root', 'system', 'null', 'undefined',
  'index', 'favicon', 'robots', 'sitemap', 'well-known', 'home', 'new', 'edit', 'preview', 'yourlocalbusiness', 'replit', 'supabase', 'manus',
  // upcoming public routes (paid plans, the public marketplace, offers, opt-outs, the cron tick and webhooks)
  'market', 'pricing', 'plans', 'unsubscribe', 'offers', 'thank-you', 'thanks', 'store', 'listings', 'cron', 'webhooks',
  // the short public prefixes below (already too short to be a name; listed so nobody relaxes SLUG_RE into them)
  'b', 'm', 'o',
]);

/**
 * Short public routes the app answers itself: /b/<id> (buy link), /m/<id> (lead magnet download), /o/<token>
 * (opt-out). A published name is at least 3 characters (SLUG_RE), so /b/…, /m/… and /o/… can never be a page or a
 * page's image; matchPage and serveDomain still check isPublicRoute first, so they win whatever the name rules become.
 */
export const PUBLIC_ROUTE_PREFIXES = Object.freeze(['/b/', '/m/', '/o/']);
export const isPublicRoute = (pathname) => PUBLIC_ROUTE_PREFIXES.some((p) => String(pathname || '').startsWith(p));

/**
 * Hosts nobody can claim: the app's own addresses on Replit, this machine, and names that are never
 * anyone's public domain (mDNS .local, private-use .internal and .home.arpa). The app answers on them.
 */
const NEVER_CLAIMED = [/(^|\.)replit\.app$/, /(^|\.)replit\.dev$/, /(^|\.)repl\.co$/, /(^|\.)localhost$/, /(^|\.)local$/, /(^|\.)internal$/, /(^|\.)home\.arpa$/];

/** Longer than any domain (253 characters): not a host name, and never handed to a regex. */
const MAX_HOST = 300;
const IMAGE_TYPES = { 'image/jpeg': { ext: 'jpg', label: 'JPEG' }, 'image/png': { ext: 'png', label: 'PNG' }, 'image/webp': { ext: 'webp', label: 'WebP' }, 'image/gif': { ext: 'gif', label: 'GIF' } };
const MAX_HTML_BYTES = 1_500_000;
const MAX_IMAGES = 12;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_TITLE = 300;
const MAX_PAGES_PER_USER = 100;
const MAX_DOMAINS_PER_USER = 20;
/** POST /api/domains sends one name */
const MAX_DOMAIN_BODY = 16 * 1024;
const IMAGE_TTL = 10 * 60_000;
const IMAGE_CACHE_BYTES = 40 * 1024 * 1024;
const LOOKUP_TIMEOUT = 5000;
const DNS_TIMEOUT = 5000;
/** A new publish's images: a folder younger than this may still be filling (another publish of the same page). */
const UPLOAD_GRACE = 10 * 60_000;
/** While Supabase is failing, an answer past its time is used again for this long at a time (never past twice its time). */
const STALE_HOLD = 5000;
/** A verified domain's TXT record is looked at again after this long; when the DNS couldn't answer, after RECHECK_RETRY. */
const RECHECK_AFTER = 6 * 60 * 60_000;
const RECHECK_RETRY = 10 * 60_000;
const MB = 1024 * 1024;
/**
 * Reads for visitors per minute on this copy of the server, in all and per client (clientOf): how many
 * (database rows, stored images) and, for pages and images, how many bytes they bring from Supabase.
 * Answers from the cache don't count, and neither do names that don't exist (they're never looked up).
 * Pages, domains and images each have their own.
 */
export const LOOKUP_LIMITS = Object.freeze({
  page: { perMin: 1200, perClient: 120, bytesPerMin: 200 * MB, bytesPerClient: 20 * MB },
  domain: { perMin: 600, perClient: 60 },
  image: { perMin: 1200, perClient: 240, bytesPerMin: 300 * MB, bytesPerClient: 60 * MB },
});
/** The cache sizes and times (tests make them small). */
const TUNING = Object.freeze({
  pageTtl: 30_000,
  domainTtl: 60_000,
  /** visitors' pages' HTML, up to pageHtmlMax each: in all (the least recently used go first) */
  pageCacheBytes: 64 * MB,
  /** HTML bigger than this is kept apart, within bigPageCacheBytes, so big pages can't push the others out */
  pageHtmlMax: 256 * 1024,
  bigPageCacheBytes: 32 * MB,
  /** HTML nobody asked for in this long goes (it's only ever sent with its page's row, read within pageTtl) */
  htmlIdle: 10 * 60_000,
  recheckAfter: RECHECK_AFTER,
  /** a name this copy doesn't know is looked for among the latest changes at most this often (knownNames) */
  namesCheck: 1000,
  /** the whole list of names is read again this often (names removed through other copies go) */
  namesReload: 10 * 60_000,
  /** with more names than this, none are kept: each is looked up, within the limits */
  namesMax: 100_000,
});
const MAX_CLIENTS = 10_000;
/** What a page's row brings besides its HTML (the other columns), for the byte limits. */
const ROW_BYTES = 4096;
/** How many X-Forwarded-For addresses the platform's proxies add at its end (clientOf; env TRUSTED_PROXY_HOPS). */
export const TRUSTED_PROXY_HOPS = 2;
/** Names are read 1000 at a time (Supabase's usual most rows per request). */
const NAMES_PAGE = 1000;
/** Changes from this long before the latest one seen are read again (a write can land a little after its time). */
const NAMES_OVERLAP = 60_000;
/** After the list of names couldn't be read, names are looked up one by one for this long before it's tried again. */
const NAMES_RETRY = 5000;
/** A request waits at most this long for the list of names to be read. */
const NAMES_WAIT = 2000;

// Never allow-same-origin: the app's sign-in tokens live in localStorage on the app's origin.
const ARTIFACT_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
// SEO pages run no scripts; allow-downloads only lets a link (a lead magnet's /m/<id>) start a download
const SEO_CSP = 'sandbox allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads';
/** The sandbox published pages get on the app's host (exported for tests). */
export const PAGE_CSP = Object.freeze({ seo: SEO_CSP, artifact: ARTIFACT_CSP });
const IMAGE_CSP = "default-src 'none'; sandbox";
const NOTICE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
/** A page's business (user_docs project id), as page_leads and lead_files keep it. */
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
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
const GONE_PAGE = notice('This page is no longer available', 'This page is no longer available.');

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

/** s without its trailing dots (a loop: a regex for that backtracks on long runs of dots). */
function trimDots(s) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 46) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** A domain as typed ("https://Shop.Example.com:443/about") → its host name ("shop.example.com"), or ''. */
export function normalizeDomain(input) {
  const raw = String(input ?? '');
  // nothing this long is a domain (and no regex runs on it)
  if (raw.length > MAX_HOST) return '';
  let s = trimDots(
    raw
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/[/?#\\].*$/s, '')
      .replace(/^.*@/, '')
      .replace(/:\d*$/, ''),
  );
  if (!s) return '';
  try {
    // international names in the xn-- form browsers send
    s = trimDots(new URL(`http://${s}`).hostname);
  } catch {
    /* not a host name: the format check refuses it */
  }
  return s;
}

/** Whether a host could be someone's own domain (a name with a real top-level domain, not the app's host). */
export function claimable(host, appHosts = new Set()) {
  return typeof host === 'string' && host.length <= 253 && DOMAIN_RE.test(host) && !NEVER_CLAIMED.some((re) => re.test(host)) && !appHosts.has(host);
}

/**
 * Whether the app (and /api) answers on a host (as hostOf gives it): a list, never what the database
 * holds. IP addresses, a name of one label (localhost, a machine's own name), the NEVER_CLAIMED names and
 * the app's own hosts (APP_HOSTS, ALLOWED_ORIGIN's). Any other host, a name nobody may claim included
 * (e.g. under a top-level domain the domain check doesn't take), only ever shows verified pages.
 */
export function appHost(host, appHosts = new Set()) {
  if (typeof host !== 'string' || !host || host.length > 253) return false;
  if (appHosts.has(host)) return true;
  if (net.isIP(host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host)) return true;
  if (!host.includes('.')) return true;
  return NEVER_CLAIMED.some((re) => re.test(host));
}

/** "host:port" → [host, ':port'] (['host', ''] without a port; an IPv6 address in brackets keeps its colons). */
function splitPort(s) {
  const colon = s.lastIndexOf(':');
  if (colon === -1 || s.indexOf(']', colon) !== -1) return [s, ''];
  for (let i = colon + 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return [s, ''];
  }
  return [s.slice(0, colon), s.slice(colon)];
}

/**
 * The host a request was made to, port included: Host, or X-Forwarded-Host from this machine (the Vite
 * dev proxy), like sameOrigin. '' when there's none, or it's too long to be a host name.
 */
function hostWithPort(req) {
  const fwd = req.headers['x-forwarded-host'];
  const raw = typeof fwd === 'string' && fwd && LOOPBACK.has(req.socket?.remoteAddress || '') ? fwd.split(',')[0] : req.headers.host;
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (s.length > MAX_HOST) return '';
  const [name, port] = splitPort(s);
  return trimDots(name) + port;
}
/** The same without the port: what custom domains are matched on. */
export const hostOf = (req) => splitPort(hostWithPort(req))[0];

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

/** An address as a client key: IPv4 as it is, IPv6 by its /64 (what one subscriber usually has). '' if it isn't one. */
function addressKey(input) {
  let s = String(input || '').trim();
  const bracketed = /^\[([^\]]{2,64})\](?::\d{1,5})?$/.exec(s);
  if (bracketed) s = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) s = mapped[1];
  const family = net.isIP(s);
  if (family === 4) return s;
  if (family !== 6) return '';
  const [head, tail] = s.toLowerCase().split('%')[0].split('::');
  const groups = head ? head.split(':') : [];
  if (tail !== undefined) {
    const rest = tail ? tail.split(':') : [];
    const width = rest.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
    groups.push(...Array(Math.max(0, 8 - groups.length - width)).fill('0'), ...rest);
  }
  return `${groups
    .slice(0, 4)
    .map((g) => (g.includes('.') ? g : parseInt(g, 16).toString(16)))
    .join(':')}::/64`;
}

/**
 * Who a visitor is, for the lookup limits: the address the platform's proxies saw it connect from. They
 * add addresses at the end of X-Forwarded-For, after whatever the client sent (anyone can make that up), so
 * it's read from the right: the address `hops` from the end. On Replit's Autoscale that's 2: Google's front
 * end adds the client's address, then its own ('<sent by the client>, <client>, <load balancer>'). With fewer
 * addresses than that, the first (the client of the only proxy, like Vite's in development); without the
 * header, or with hops 0, the connection's own address.
 */
export function clientOf(req, hops = TRUSTED_PROXY_HOPS) {
  const fwd = req.headers['x-forwarded-for'];
  if (hops > 0 && typeof fwd === 'string' && fwd) {
    // only the end counts (a client can send kilobytes before it)
    const list = fwd.slice(-1024).split(',');
    const key = addressKey(list[Math.max(0, list.length - hops)]);
    if (key) return key;
  }
  return addressKey(req.socket?.remoteAddress) || 'unknown';
}

/** TRUSTED_PROXY_HOPS as set: a whole number from 0 to 10 (else the default, with a warning). */
export function hopsFrom(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return TRUSTED_PROXY_HOPS;
  const n = Number(s);
  if (Number.isInteger(n) && n >= 0 && n <= 10) return n;
  console.warn(`TRUSTED_PROXY_HOPS must be a whole number from 0 to 10 (it’s “${s.slice(0, 40)}”); using ${TRUSTED_PROXY_HOPS}.`);
  return TRUSTED_PROXY_HOPS;
}

/** resolveTxt for the domain check: the system's DNS servers, or these ("1.1.1.1, 8.8.8.8", "127.0.0.1:5353"). */
export function txtResolver(servers = '') {
  const resolver = new dns.promises.Resolver({ timeout: 2000, tries: 2 });
  const list = String(servers)
    .split(/[\s,]+/)
    .filter(Boolean);
  if (list.length) {
    try {
      resolver.setServers(list);
    } catch (e) {
      console.warn(`PAGES_DNS_SERVERS isn’t a list of DNS server addresses (${e.message}); using the system’s.`);
    }
  }
  return (name) => resolver.resolveTxt(name);
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Text Postgres can store: no NUL characters, no half emoji (browsers show both as nothing or �). */
const storable = (v) => {
  const s = typeof v === 'string' ? v.replace(/\u0000/g, '') : '';
  return typeof s.toWellFormed === 'function' ? s.toWellFormed() : s;
};

/**
 * Answers for visitors, least recently used out first, within maxBytes (and maxEntries). An answer is
 * fresh for ttl; after that it's only a fallback while Supabase can't answer, until twice ttl from when
 * it was read. Then it's dropped, with its HTML. keep(value) is what's kept of an answer.
 */
function rowCache(name, { ttl, maxBytes, maxEntries, sizeOf, keep = (v) => v }) {
  const maxAge = 2 * ttl;
  const m = new Map(); // key → { value, at, until, bytes }
  let total = 0;
  const drop = (k) => {
    const e = m.get(k);
    if (!e) return;
    total -= e.bytes;
    m.delete(k);
  };
  const dead = (e, now) => now - e.at >= maxAge;
  return {
    name,
    /** a fresh answer (now the most recently used), or null */
    fresh(k) {
      const e = m.get(k);
      if (!e) return null;
      const now = Date.now();
      if (dead(e, now)) {
        drop(k);
        return null;
      }
      if (e.until <= now) return null;
      m.delete(k);
      m.set(k, e);
      return e;
    },
    /** an answer past its time but still young enough to fall back on, or null */
    stale(k) {
      const e = m.get(k);
      return e && !dead(e, Date.now()) ? e : null;
    },
    set(k, value) {
      drop(k);
      const kept = keep(value);
      const bytes = 200 + sizeOf(kept);
      if (bytes > maxBytes) return;
      const at = Date.now();
      m.set(k, { value: kept, at, until: at + ttl, bytes });
      total += bytes;
      while (total > maxBytes || m.size > maxEntries) drop(m.keys().next().value);
    },
    /** use a stale answer for a few seconds more (Supabase is failing), never past its maximum age */
    hold(k, ms) {
      const e = m.get(k);
      if (e) e.until = Math.min(Date.now() + ms, e.at + maxAge);
    },
    delete: drop,
    deleteWhere(test) {
      for (const [k, e] of [...m]) if (test(e.value)) drop(k);
    },
    /** drop every answer past its maximum age */
    sweep() {
      const now = Date.now();
      for (const [k, e] of [...m]) if (dead(e, now)) drop(k);
    },
    stats: () => ({ entries: m.size, bytes: total }),
  };
}

/**
 * Bytes by key (images, pages' HTML), least recently used out first, within maxBytes in all; an entry
 * nobody asked for in `idle` goes. An entry's tag says which version of something it is.
 */
function byteCache(maxBytes, idle) {
  const m = new Map(); // key → { bytes, tag, until }
  let total = 0;
  const drop = (k) => {
    const e = m.get(k);
    if (!e) return;
    total -= e.bytes.length;
    m.delete(k);
  };
  /** the entry as it is (its place in line unchanged), or null */
  const peek = (k) => {
    const e = m.get(k);
    if (e && e.until <= Date.now()) {
      drop(k);
      return null;
    }
    return e ?? null;
  };
  return {
    /** the entry, now the most recently used, or null; with a tag, only that version */
    get(k, tag) {
      const e = peek(k);
      if (!e || (tag !== undefined && e.tag !== tag)) return null;
      m.delete(k);
      m.set(k, e);
      e.until = Date.now() + idle;
      return e;
    },
    peek,
    set(k, bytes, tag) {
      drop(k);
      if (bytes.length > maxBytes) return;
      m.set(k, { bytes, tag, until: Date.now() + idle });
      total += bytes.length;
      while (total > maxBytes) drop(m.keys().next().value);
    },
    delete: drop,
    dropPrefix(prefix) {
      for (const k of [...m.keys()]) if (k.startsWith(prefix)) drop(k);
    },
    deleteWhere(test) {
      for (const [k, e] of [...m]) if (test(e)) drop(k);
    },
    /** drop every entry nobody asked for in time */
    sweep() {
      const now = Date.now();
      for (const [k, e] of [...m]) if (e.until <= now) drop(k);
    },
    stats: () => ({ entries: m.size, bytes: total }),
  };
}

/**
 * Reads for visitors within the limits: per minute, in all and per client, for each kind (page, domain,
 * image), by count and (with bytesPerMin, bytesPerClient) by what they bring from Supabase.
 *   take(kind, client, bytes) → a ticket when the read may go ahead (it's counted, with the bytes it may
 *     bring), or null; settle(ticket, bytes) → what it really brought (a ticket from an earlier minute
 *     changes nothing). A read is never refused for its size alone: the first of a minute always fits.
 */
function lookupBudget(limits, { onClientLimit } = {}) {
  let start = 0;
  let minute = 0;
  const all = new Map(); // kind → { n, bytes }
  const perClient = new Map(); // `${kind} ${client}` → { n, bytes }
  const over = (used, bytes, limit) => !!limit && used > 0 && used + bytes > limit;
  return {
    take(kind, client, bytes = 0) {
      const now = Date.now();
      if (now - start >= 60_000) {
        start = now;
        minute++;
        all.clear();
        perClient.clear();
      }
      const limit = limits[kind];
      if (!limit) return { minute, bytes, mine: null, total: null };
      // a flood of made-up addresses shares one count once there are too many to keep apart
      let key = `${kind} ${client}`;
      if (!perClient.has(key) && perClient.size >= MAX_CLIENTS) key = `${kind} (others)`;
      const mine = perClient.get(key) ?? { n: 0, bytes: 0 };
      const total = all.get(kind) ?? { n: 0, bytes: 0 };
      if (total.n >= limit.perMin || over(total.bytes, bytes, limit.bytesPerMin)) return null;
      if (mine.n >= limit.perClient || over(mine.bytes, bytes, limit.bytesPerClient)) {
        onClientLimit?.(kind, client);
        return null;
      }
      mine.n++;
      mine.bytes += bytes;
      total.n++;
      total.bytes += bytes;
      perClient.set(key, mine);
      all.set(kind, total);
      return { minute, bytes, mine, total };
    },
    settle(ticket, bytes) {
      if (!ticket?.mine || ticket.minute !== minute) return;
      const more = bytes - ticket.bytes;
      ticket.mine.bytes = Math.max(0, ticket.mine.bytes + more);
      ticket.total.bytes = Math.max(0, ticket.total.bytes + more);
      ticket.bytes = bytes;
    },
  };
}

/**
 * The names that exist (published pages' names, verified domains), so a request for any other is "not
 * found" without a lookup: made-up names cost nothing, from however many addresses they come. The whole
 * list is read now and then (every `reload`); in between, a name this copy doesn't know is looked for among
 * the changes since the last look (at most every `check`, one look at a time), so a page published or a
 * domain verified through another copy shows up here within about that long.
 *   all(max) → { names, latest } or { tooMany: true }; since(latest) → { names, latest, full }. latest: the
 *   time of the newest change seen (ms); full: there may be more than one read brings.
 * With more than `max` names, none are kept, and has() says null (look it up) for every name.
 */
function knownNames(label, { all, since, check, reload, max }) {
  const names = new Map(); // name → when it was last known to exist
  let loaded = false;
  let tooMany = false;
  let latest = 0;
  let loadedAt = 0;
  let lookedAt = 0;
  let failedAt = 0;
  let warnedAt = 0;
  let running = null;
  async function wholeList(t) {
    const got = await all(max);
    loadedAt = t;
    if (got.tooMany) {
      if (!tooMany) console.warn(`Published pages: there are more than ${max} ${label}, so they aren’t kept in memory; each is looked up when it’s asked for.`);
      tooMany = true;
      loaded = false;
      names.clear();
      return;
    }
    // names this copy added since the list was asked for stay
    const added = [...names].filter(([, seen]) => seen > t);
    names.clear();
    for (const n of got.names) names.set(n, t);
    for (const [n, seen] of added) names.set(n, seen);
    tooMany = false;
    loaded = true;
    latest = got.latest;
  }
  function look() {
    running ??= (async () => {
      const t = Date.now();
      try {
        if (!loaded || Date.now() - loadedAt >= reload) await wholeList(t);
        else {
          const got = await since(latest);
          for (const n of got.names) if (!(names.get(n) >= t)) names.set(n, t);
          latest = Math.max(latest, got.latest);
          if (got.full) await wholeList(t);
        }
      } catch (e) {
        if (e?.code === 'PAGES_TABLES') {
          // the migration wasn't run: nothing is published
          if (!tooMany) loaded = true;
        } else {
          failedAt = Date.now();
          if (Date.now() - warnedAt > 60_000) {
            warnedAt = Date.now();
            console.warn(`Published pages: couldn’t read the ${label} (${e?.message || e}).`);
          }
        }
      } finally {
        lookedAt = t;
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }
  return {
    /** true: it exists; false: it doesn't (no need to look it up); null: this copy can't say (look it up) */
    async has(name) {
      const now = Date.now();
      if (tooMany) {
        if (now - loadedAt >= reload) void look();
        return null;
      }
      if (loaded && names.has(name)) {
        if (now - loadedAt >= reload) void look();
        return true;
      }
      if (loaded && now - lookedAt < check) return false;
      if (!loaded && now - failedAt < NAMES_RETRY) return null;
      // a long list can take a while to read: meanwhile the name is looked up (or, once there's a list, isn't there yet)
      let timer;
      await Promise.race([look(), new Promise((r) => (timer = setTimeout(r, NAMES_WAIT)))]);
      clearTimeout(timer);
      if (tooMany || !loaded) return null;
      return names.has(name);
    },
    /** it exists now (published, verified, through this copy) */
    add(name) {
      if (!tooMany) names.set(name, Date.now());
    },
    /** it's gone, as a read that started at `since` found (unless it was seen after that) */
    drop(name, since = Date.now()) {
      const seen = names.get(name);
      if (seen !== undefined && seen <= since) names.delete(name);
    },
    stats: () => ({ names: names.size, loaded, tooMany }),
  };
}

export function pagesFromEnv(env = process.env, deps = {}) {
  return createPages({
    supabaseUrl: env.SUPABASE_URL || '',
    secretKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '',
    leadLimits: leadLimitsFromEnv(env),
    magnetLimits: magnetLimitsFromEnv(env),
    linkSecret: leadLinkSecret(env),
    appHosts: env.APP_HOSTS || '',
    resolveTxt: txtResolver(env.PAGES_DNS_SERVERS || ''),
    trustedHops: hopsFrom(env.TRUSTED_PROXY_HOPS),
    ...deps,
  });
}

/**
 * auth: server/auth.mjs (publishing needs accounts on). whoIs, send, readJson, rateLimited and
 * corsHeaders: the server's own (see ai-server.mjs). distDir: the built app, whose top-level names
 * can't be page names. resolveTxt: dns.promises.resolveTxt's shape (tests give their own).
 * trustedHops: see clientOf. lookupLimits and tuning: see LOOKUP_LIMITS and TUNING.
 * appHostExtras(req, res, url) → boolean | Promise<boolean>: more GET/HEAD paths on the app's own host, asked
 * before page names (the app-host /sitemap.xml, /robots.txt and the Search Console verification file, from
 * server/seo/sitemap.mjs); true when it answered. Never asked on people's own domains (serveDomain has theirs).
 * billing: the plans facade (server/integrations/wiring.mjs): a page whose owner's plan ended more than 30 days ago
 * answers 410 (fail-open: plans off or unreachable → served), and publishing needs an active plan.
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
  // lead forms: { perIp, perPage, windowMs } (server/leads.mjs)
  leadLimits,
  // lead magnets: { perIp, perFile, windowMs } and the download tickets' secret (server/leadFiles.mjs)
  magnetLimits,
  linkSecret = null,
  appHosts = '',
  resolveTxt = txtResolver(),
  trustedHops = TRUSTED_PROXY_HOPS,
  lookupLimits = LOOKUP_LIMITS,
  tuning = {},
  fetch = globalThis.fetch,
  appHostExtras = null,
  billing = null,
} = {}) {
  const tune = { ...TUNING, ...tuning };
  const hops = trustedHops;
  const visitor = (req) => clientOf(req, hops);
  const url = String(supabaseUrl).replace(/\/+$/, '');
  const enabled = !!(auth?.enabled && url && secretKey);
  const headers = secretKey ? serviceHeaders(secretKey) : {};
  // Storage takes the same key; each call sets its own content type
  const storageAuth = { ...headers };
  delete storageAuth['content-type'];
  // the app's own hosts besides its addresses on Replit, never someone's domain
  const ownHosts = new Set(
    String(appHosts)
      .split(/[\s,]+/)
      .map(normalizeDomain)
      .filter(Boolean),
  );
  try {
    const host = allowedOrigin ? normalizeDomain(new URL(allowedOrigin).hostname) : '';
    if (host) ownHosts.add(host);
  } catch {
    /* not a URL: ignored */
  }

  // Each account's code for a domain (the value of its TXT record): always the same for that account and
  // domain, so someone taking a domain over has theirs before anything is stored, and only this server can make it.
  const tokenKey = crypto.createHash('sha256').update(`ylb-domain-token:${secretKey}`).digest();
  const tokenFor = (domain, userId) => `ylb-${crypto.createHmac('sha256', tokenKey).update(`${domain}\n${userId}`).digest('hex').slice(0, 40)}`;
  /** The code a row's owner proves the domain with (a row from before DNS checks gets this server's code). */
  const tokenOf = (row) => (TOKEN_RE.test(String(row?.token ?? '')) ? row.token : tokenFor(row.domain, row.user_id));
  /** A domain shows its owner's pages only once its TXT record was found (a check from before DNS checks doesn't count). */
  const verifiedRow = (row) => !!row?.verified_at && TOKEN_RE.test(String(row.token ?? ''));

  const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
  // fixed messages: what went wrong inside (addresses, Postgres's words) stays in the server's log
  const unreachable = (e) => fail(502, 'UPSTREAM', e?.name === 'TimeoutError' ? 'Supabase took too long to answer. Try again.' : 'Couldn’t reach Supabase. Try again.');
  let warnedTables = false;
  const tablesMissing = () => {
    if (!warnedTables) {
      warnedTables = true;
      console.warn(`Published pages: the tables aren’t in Supabase yet. Run ${PAGES_MIGRATION} in Supabase → SQL Editor.`);
    }
    return fail(503, 'PAGES_TABLES', `Run ${PAGES_MIGRATION} in Supabase → SQL Editor.`);
  };
  let warnedUpstream = 0;
  const logUpstream = (what) => {
    if (Date.now() - warnedUpstream < 60_000) return;
    warnedUpstream = Date.now();
    console.warn(`Published pages: Supabase refused a request (${what}).`);
  };
  const accountGone = () => fail(401, 'ACCOUNT_GONE', 'This account doesn’t exist anymore. Sign in again.');
  // project_id is looked for again a while after it was found missing (the migration may have been run since)
  let projectColumnOffAt = 0;
  const projectColumnOff = () => projectColumnOffAt > 0 && Date.now() - projectColumnOffAt < 10 * 60_000;
  const withoutProject = (q) => q.replace(/,project_id(?=[,&]|$)/g, '');

  /**
   * Supabase's REST API with the secret key: the parsed answer, or an error with status and code.
   * meter: what the answer brought is added to meter.bytes (the visitors' byte limits).
   */
  async function rest(query, { method = 'GET', body, prefer, timeout = 10_000, meter } = {}) {
    // before 20261112000000_leads_p2.sql, published_pages has no project_id: it's left out of reads and writes
    if (projectColumnOff()) {
      query = withoutProject(query);
      if (body && typeof body === 'object' && !Array.isArray(body) && 'project_id' in body) {
        body = { ...body };
        delete body.project_id;
      }
    }
    let res;
    let raw;
    try {
      res = await fetch(`${url}/rest/v1/${query}`, { method, headers: { ...headers, ...(prefer ? { prefer } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
      // an answer cut off halfway is no answer (not "no rows")
      raw = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      throw unreachable(e);
    }
    if (meter) meter.bytes += raw.length;
    const text = raw.toString('utf8');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.ok) return data;
    const code = String(data?.code ?? '');
    const message = String(data?.message ?? '');
    const about = `${message} ${data?.details ?? ''}`;
    if (res.status === 404 && (code === 'PGRST205' || code === '42P01' || /published_(pages|domains)/.test(message))) throw tablesMissing();
    if ((code === '42703' || code === 'PGRST204') && message.includes('project_id') && !projectColumnOff()) {
      projectColumnOffAt = Date.now();
      console.warn(`Published pages: published_pages has no project_id column yet, so artifacts’ leads don’t know their business. Run ${LEADS_P2_MIGRATION} in Supabase → SQL Editor.`);
      return rest(query, { method, body, prefer, timeout, meter });
    }
    // a unique key: the address was just taken, or the domain's home page (published_pages_domain_home)
    if (code === '23505') throw fail(409, 'CONFLICT', 'That changed just now. Try again.', { constraint: /published_pages_domain_home/.test(about) ? 'home' : '' });
    // a row this one points at is gone, or isn't the same account's: the account (deleted), or the domain
    // (removed, or another account's now: published_pages_domain_owner, whose key is (domain, user_id))
    if (code === '23503') {
      throw fail(409, 'REFERENCE', 'Something this refers to was just removed. Try again.', { ref: /published_pages_domain|Key \(domain/.test(about) ? 'domain' : /user_id/.test(about) ? 'user' : '' });
    }
    logUpstream(`${res.status}${code ? ` ${code}` : ''}: ${message.slice(0, 200)}`);
    throw fail(502, 'UPSTREAM', `Supabase refused that (error ${res.status}). Try again.`);
  }

  /** Throws unless the account is still there: a deleted account's sign-in still checks out until it expires. */
  async function mustExist(userId) {
    let res;
    try {
      res = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { headers, signal: AbortSignal.timeout(LOOKUP_TIMEOUT) });
    } catch (e) {
      throw unreachable(e);
    }
    await res.arrayBuffer().catch(() => null);
    if (res.status === 404) throw accountGone();
    if (!res.ok) throw fail(502, 'UPSTREAM', `Couldn’t check your account with Supabase (error ${res.status}). Try again.`);
  }

  // ── stored images: media/<user id>/published/<page id with - for :>/<version>/<name> ──
  const pageFolder = (userId, pageId) => `${userId}/published/${pageId.replace(':', '-')}`;
  /** Where a listed image is: its publish's own folder (images from before versions sit in the page's folder). */
  const imageFolder = (page, img) => `${pageFolder(page.user_id, page.page_id)}${typeof img?.v === 'string' && VERSION_RE.test(img.v) ? `/${img.v}` : ''}`;
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
    await res.arrayBuffer().catch(() => null);
    if (!res.ok) throw fail(502, 'UPSTREAM', `Couldn’t store ${img.name} in Supabase (error ${res.status}). Try again.`);
  }
  /**
   * The stored file, or null when it isn't there (Supabase answers 400 or 404 for that) or is bigger than
   * maxBytes: the file checked when the page was published was that size, and the owner can put anything in
   * their folder, so no more than that is ever read. What was read is added to meter.bytes.
   */
  async function getImage(folder, name, maxBytes, meter) {
    const res = await storage(`object/authenticated/media/${objectPath(`${folder}/${name}`)}`, { method: 'GET', headers: {} }, LOOKUP_TIMEOUT);
    if (!res.ok) {
      await res.arrayBuffer().catch(() => null);
      if (res.status === 400 || res.status === 404) return null;
      throw fail(502, 'UPSTREAM', `Supabase didn’t send an image (error ${res.status}).`);
    }
    const chunks = [];
    let size = 0;
    try {
      // (leaving the loop early stops the download)
      for await (const chunk of res.body ?? []) {
        size += chunk.length;
        meter.bytes += chunk.length;
        if (size > maxBytes) return null;
        chunks.push(chunk);
      }
    } catch (e) {
      throw unreachable(e);
    }
    return Buffer.concat(chunks);
  }
  async function listFolder(prefix) {
    const res = await storage('object/list/media', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix, limit: 1000, offset: 0 }) });
    if (!res.ok) {
      await res.arrayBuffer().catch(() => null);
      throw fail(502, 'UPSTREAM', `Couldn’t list stored images (error ${res.status}).`);
    }
    const items = await res.json().catch(() => []);
    return Array.isArray(items) ? items : [];
  }
  async function deleteObjects(paths) {
    for (let i = 0; i < paths.length; i += 1000) {
      const res = await storage('object/media', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: paths.slice(i, i + 1000) }) });
      await res.arrayBuffer().catch(() => null);
      if (!res.ok) throw fail(502, 'UPSTREAM', `Couldn’t remove stored images (error ${res.status}).`);
    }
  }
  /**
   * Remove a page's stored images, except the version in keep and, with spare, versions younger than
   * that (another publish of the page may still be uploading them) other than previous. Best effort:
   * a leftover file is only unused space.
   */
  async function removeImages(folder, { keep = '', spare = 0, previous = '' } = {}) {
    try {
      const gone = [];
      for (const item of await listFolder(`${folder}/`)) {
        if (typeof item?.name !== 'string') continue;
        // a file: from before versions
        if (item.id != null) gone.push(`${folder}/${item.name}`);
        else if (item.name !== keep) {
          const v = VERSION_RE.exec(item.name);
          if (!v || (spare && item.name !== previous && Date.now() - parseInt(v[1], 36) < spare)) continue;
          for (const f of await listFolder(`${folder}/${item.name}/`)) if (f?.id != null && typeof f.name === 'string') gone.push(`${folder}/${item.name}/${f.name}`);
        }
      }
      if (gone.length) await deleteObjects(gone);
    } catch (e) {
      console.warn(`Published pages: couldn’t remove unused images in ${folder} (${e.message}).`);
    }
  }

  // ── lookups for visitors: cached, one request at a time per key, within the limits ──
  const DOMAIN_COLUMNS = 'domain,user_id,token,verified_at';
  /** A page's row without its HTML: what's kept per page (its HTML is kept apart, by version). */
  const PAGE_HEAD = 'slug,user_id,page_id,kind,title,images,domain,home,project_id,updated_at';
  const PAGE_ROW = `${PAGE_HEAD},html`;
  const domainCache = rowCache('domain', { ttl: tune.domainTtl, maxBytes: 4 * MB, maxEntries: 5000, sizeOf: () => 300 }); // host → domain row | null
  // slug → the page's row without its HTML, with htmlBytes (the HTML's size) | null
  const pageCache = rowCache('page', { ttl: tune.pageTtl, maxBytes: 16 * MB, maxEntries: 5000, sizeOf: (row) => (row ? 1000 + JSON.stringify(row.images ?? []).length + 2 * String(row.title ?? '').length : 0) });
  // slug → the page's HTML (UTF-8), tagged with the version of the row it came with; big pages' apart
  const htmlCache = byteCache(tune.pageCacheBytes, tune.htmlIdle);
  const bigHtmlCache = byteCache(tune.bigPageCacheBytes, tune.htmlIdle);
  const onDomainCache = rowCache('on-domain', { ttl: tune.pageTtl, maxBytes: 8 * MB, maxEntries: 2000, sizeOf: (rows) => 120 * (Array.isArray(rows) ? rows.length : 0) }); // domain → [{ slug, user_id, home, updated_at }]
  const imageCache = byteCache(IMAGE_CACHE_BYTES, IMAGE_TTL);
  // stored images that weren't there, or weren't the file published: not read again for a while
  const imageMisses = rowCache('image-miss', { ttl: tune.pageTtl, maxBytes: 2 * MB, maxEntries: 5000, sizeOf: () => 200 });
  const inflight = new Map();
  // a few clients (or pages) must not turn into a flood of database requests, or of bytes
  let warnedClientAt = 0;
  const budget = lookupBudget(lookupLimits, {
    // (if every visitor shows up as the same address, a proxy's, they all share one client's limits)
    onClientLimit: (kind, client) => {
      if (Date.now() - warnedClientAt < 10 * 60_000) return;
      warnedClientAt = Date.now();
      console.warn(`Published pages: a visitor (${client}) used up its ${kind} lookups for this minute, so it gets 503 until the minute is over. If every visitor shows up as the same address (a proxy’s), set TRUSTED_PROXY_HOPS (now ${hops}).`);
    },
  });
  const busy = () => fail(503, 'BUSY', 'Too many lookups right now.');
  // answers past their maximum age go, and HTML and images nobody asked for in a while, even when nothing else comes in
  const sweeper = setInterval(() => {
    domainCache.sweep();
    pageCache.sweep();
    onDomainCache.sweep();
    imageMisses.sweep();
    htmlCache.sweep();
    bigHtmlCache.sweep();
    imageCache.sweep();
  }, tune.pageTtl);
  sweeper.unref?.();

  /**
   * An answer from store, or load(meter) once for everyone asking at the same time, within the limits:
   * `expect` is what it may bring (bytes), settled with what it did bring (meter.bytes).
   */
  function lookUp(store, key, load, kind, client, expect = 0) {
    const hit = store.fresh(key);
    if (hit) return Promise.resolve(hit.value);
    const id = `${store.name}:${key}`;
    if (inflight.has(id)) return inflight.get(id);
    // over the limits: no answer (an old one would keep a removed page up for as long as the limits are spent)
    const ticket = budget.take(kind, client, expect);
    if (!ticket) return Promise.reject(busy());
    const meter = { bytes: 0 };
    const p = load(meter)
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
          // Supabase didn't answer: what was known last, if it's recent (a short outage mustn't take pages down)
          const last = store.stale(key);
          if (last) {
            store.hold(key, STALE_HOLD);
            return last.value;
          }
          throw e;
        },
      )
      .finally(() => {
        inflight.delete(id);
        budget.settle(ticket, meter.bytes);
      });
    inflight.set(id, p);
    return p;
  }
  const domainRow = (host, client) => lookUp(domainCache, host, async (meter) => (await rest(`published_domains?domain=eq.${encodeURIComponent(host)}&select=${DOMAIN_COLUMNS}`, { timeout: LOOKUP_TIMEOUT, meter }))?.[0] ?? null, 'domain', client);
  const pagesOnDomain = (domain, client) => lookUp(onDomainCache, domain, async (meter) => (await rest(`published_pages?domain=eq.${encodeURIComponent(domain)}&select=slug,user_id,home,updated_at&order=updated_at.desc&limit=1000`, { timeout: LOOKUP_TIMEOUT, meter })) ?? [], 'domain', client);

  /** Which version of a page a row is (any change to a row changes its updated_at): its HTML is kept under that. */
  const versionOf = (row) => `${row.user_id} ${row.page_id} ${row.updated_at}`;
  const htmlStore = (bytes) => (bytes > tune.pageHtmlMax ? bigHtmlCache : htmlCache);
  /** A row read with its HTML: the HTML is kept apart (by its size), the row without it. */
  function keepHtml(row) {
    const html = Buffer.from(typeof row.html === 'string' ? row.html : '', 'utf8');
    htmlCache.delete(row.slug);
    bigHtmlCache.delete(row.slug);
    htmlStore(html.length).set(row.slug, html, versionOf(row));
    const page = { ...row, htmlBytes: html.length };
    delete page.html;
    return { page, html };
  }
  /**
   * A published page by its name: its row without the HTML (htmlBytes: the HTML's size), or null. While its
   * HTML is still kept, the row is read again without it, and the HTML only when the page has changed since.
   */
  function pageRow(slug, client) {
    const kept = htmlCache.peek(slug) ?? bigHtmlCache.peek(slug);
    const last = pageCache.stale(slug)?.value;
    const load = async (meter) => {
      if (kept) {
        const head = (await rest(`published_pages?slug=eq.${slug}&select=${PAGE_HEAD}`, { timeout: LOOKUP_TIMEOUT, meter }))?.[0] ?? null;
        if (!head) return null;
        if (versionOf(head) === kept.tag) return { ...head, htmlBytes: kept.bytes.length };
      }
      const row = (await rest(`published_pages?slug=eq.${slug}&select=${PAGE_ROW}`, { timeout: LOOKUP_TIMEOUT, meter }))?.[0] ?? null;
      return row ? keepHtml(row).page : null;
    };
    // what it may bring: little while the HTML is kept, else the HTML (as big as it was, or as big as a page can be)
    return lookUp(pageCache, slug, load, 'page', client, ROW_BYTES + (kept ? 0 : (last?.htmlBytes ?? MAX_HTML_BYTES)));
  }
  /** The page with its HTML: as kept, or read again (with its row: it may have changed). null: it's gone. */
  async function withHtml(page, client) {
    const kept = htmlStore(page.htmlBytes).get(page.slug, versionOf(page));
    if (kept) return { page, html: kept.bytes };
    const id = `html:${page.slug}`;
    if (!inflight.has(id)) {
      const ticket = budget.take('page', client, ROW_BYTES + (page.htmlBytes ?? MAX_HTML_BYTES));
      if (!ticket) throw busy();
      const meter = { bytes: 0 };
      inflight.set(
        id,
        rest(`published_pages?slug=eq.${page.slug}&select=${PAGE_ROW}`, { timeout: LOOKUP_TIMEOUT, meter })
          .then((rows) => {
            const row = rows?.[0] ?? null;
            if (!row) {
              pageCache.set(page.slug, null);
              return null;
            }
            const got = keepHtml(row);
            pageCache.set(row.slug, got.page);
            return got;
          })
          .finally(() => {
            inflight.delete(id);
            budget.settle(ticket, meter.bytes);
          }),
      );
    }
    return inflight.get(id);
  }
  /** Drop what this copy of the server remembers about pages that just changed. */
  const forget = ({ slugs = [], domains = [] }) => {
    for (const s of slugs) {
      if (!s) continue;
      pageCache.delete(s);
      htmlCache.delete(s);
      bigHtmlCache.delete(s);
    }
    for (const d of domains) if (d) onDomainCache.delete(d);
  };
  /** …and about a domain whose owner or verification just changed. */
  const dropDomain = (domain) => {
    domainCache.delete(domain);
    onDomainCache.delete(domain);
  };

  // ── the names that exist (knownNames): any other is "not found" without a lookup ──
  /** Every name in a table, read 1000 at a time: { names, latest } or { tooMany: true }. */
  async function allNames(table, column, time, filter, max) {
    const names = [];
    let latest = 0;
    let after = null;
    for (;;) {
      const rows = (await rest(`${table}?select=${column},${time}${filter}&order=${column}.asc&limit=${NAMES_PAGE}${after === null ? '' : `&${column}=gt.${encodeURIComponent(after)}`}`, { timeout: LOOKUP_TIMEOUT })) ?? [];
      for (const r of rows) {
        if (typeof r?.[column] === 'string') names.push(r[column]);
        latest = Math.max(latest, Date.parse(r?.[time]) || 0);
      }
      if (names.length > max) return { tooMany: true };
      if (rows.length < NAMES_PAGE) return { names, latest };
      after = rows[rows.length - 1][column];
    }
  }
  /** The names of the rows changed since `latest` (and in the minute before it): { names, latest, full }. */
  async function namesSince(table, column, time, latest) {
    const from = new Date(Math.max(0, latest - NAMES_OVERLAP)).toISOString();
    const rows = (await rest(`${table}?select=${column},${time}&${time}=gte.${encodeURIComponent(from)}&order=${time}.asc&limit=${NAMES_PAGE}`, { timeout: LOOKUP_TIMEOUT })) ?? [];
    let newest = 0;
    for (const r of rows) newest = Math.max(newest, Date.parse(r?.[time]) || 0);
    return { names: rows.map((r) => r?.[column]).filter((n) => typeof n === 'string'), latest: newest, full: rows.length >= NAMES_PAGE };
  }
  const listing = { check: tune.namesCheck, reload: tune.namesReload, max: tune.namesMax };
  const pageNames = knownNames('published pages', { ...listing, all: (max) => allNames('published_pages', 'slug', 'updated_at', '', max), since: (latest) => namesSince('published_pages', 'slug', 'updated_at', latest) });
  const domainNames = knownNames('verified domains', { ...listing, all: (max) => allNames('published_domains', 'domain', 'verified_at', '&verified_at=not.is.null', max), since: (latest) => namesSince('published_domains', 'domain', 'verified_at', latest) });

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
  const gone = (req, res) => write(req, res, 410, { ...COMMON, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': NOTICE_CSP }, GONE_PAGE);
  /** Whether a page's owner's plan ended more than 30 days ago (pages keep serving until then). Fail-open. */
  async function expired(page) {
    if (!billing?.pagesServeUntil || !page?.user_id) return false;
    try {
      const until = await billing.pagesServeUntil(page.user_id);
      return !!until && Date.parse(until) < Date.now();
    } catch {
      return false;
    }
  }
  /** A published page with its HTML; with html null (HEAD), its headers only: the row says how big it is. */
  function sendPage(req, res, page, html, { sandbox }) {
    const hdrs = { ...COMMON, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60', ...(sandbox ? { 'content-security-policy': page.kind === 'artifact' ? ARTIFACT_CSP : SEO_CSP } : {}) };
    if (html) return write(req, res, 200, hdrs, html);
    res.writeHead(200, { ...hdrs, 'content-length': page.htmlBytes });
    res.end();
  }
  /** Whether a request for the page can be answered without its HTML (HEAD: the row has its size). */
  const headOnly = (req, page) => req.method === 'HEAD' && Number.isInteger(page.htmlBytes);

  async function sendImage(req, res, page, name, client) {
    const img = IMAGE_NAME_RE.test(name) && Array.isArray(page.images) ? page.images.find((i) => i?.name === name) : null;
    if (!img || !IMAGE_TYPES[img.mime]) return notFound(req, res);
    const folder = imageFolder(page, img);
    const key = `${folder}/${name}@${img.sha256 || ''}`;
    let bytes = imageCache.get(key)?.bytes;
    if (!bytes) {
      if (imageMisses.fresh(key)) return notFound(req, res);
      const id = `image:${key}`;
      if (!inflight.has(id)) {
        // never more than the file that was checked when the page was published (its size was noted then)
        const size = Number.isInteger(img.size) && img.size > 0 && img.size <= MAX_IMAGE_BYTES ? img.size : MAX_IMAGE_BYTES;
        const ticket = budget.take('image', client, size);
        if (!ticket) throw busy();
        const meter = { bytes: 0 };
        inflight.set(
          id,
          getImage(folder, name, size, meter)
            .then((got) => {
              // only the exact file checked when the page was published: the owner can also change their
              // folder directly, and nothing but an image of the listed type may go out from here
              if (!got || imageTypeOf(got) !== img.mime || (img.sha256 && sha256(got) !== img.sha256)) {
                imageMisses.set(key, true);
                return null;
              }
              imageCache.set(key, got);
              return got;
            })
            .finally(() => {
              inflight.delete(id);
              budget.settle(ticket, meter.bytes);
            }),
        );
      }
      bytes = await inflight.get(id);
      if (!bytes) return notFound(req, res);
    }
    return write(req, res, 200, { ...COMMON, 'content-type': img.mime, 'cache-control': 'public, max-age=86400', 'content-security-policy': IMAGE_CSP }, bytes);
  }

  // ── which host gets what ──

  /** Whether the app (and /api) may answer this request: one of the app's own hosts (appHost). Anything else goes to serveDomain. */
  const isAppHost = (req) => appHost(hostOf(req), ownHosts);
  /** For the server's log: where the app answers, and what every other host shows. */
  const appHostsNote = () =>
    [
      `The app and /api answer on *.replit.app, *.replit.dev, *.repl.co, localhost and IP addresses${ownHosts.size ? `, and on ${[...ownHosts].join(', ')} (APP_HOSTS, ALLOWED_ORIGIN)` : ''}.`,
      `Any other host shows only the published pages of a verified domain ("Page not found" otherwise). If the app has a custom domain of its own, list it in the APP_HOSTS Secret${ownHosts.size ? '' : ' (it’s empty now)'}.`,
    ].join('\n');
  /** For the server's log: how visitors are told apart (their lookups are limited per client). */
  const visitorsNote = () =>
    hops > 0
      ? `Visitors’ lookups are limited per address: the one ${hops === 1 ? 'at the end' : `${hops} from the end`} of X-Forwarded-For, where the platform’s proxies add it (TRUSTED_PROXY_HOPS=${hops}).`
      : 'Visitors’ lookups are limited per address: the connection’s own (TRUSTED_PROXY_HOPS=0: X-Forwarded-For isn’t read).';
  // a browser visit (or a check of /) on a host that's nobody's: it may be the app's own custom domain,
  // missing from APP_HOSTS (said once in a while: scanners send any Host)
  let hintedAt = 0;
  function hintAppHosts(req, host, url) {
    if (!host || req.method !== 'GET' || (url.pathname !== '/' && !/text\/html/.test(String(req.headers.accept || '').slice(0, 300))) || Date.now() - hintedAt < 10 * 60_000) return;
    hintedAt = Date.now();
    console.warn(`Published pages: ${host.replace(/[^a-z0-9.:[\]_-]/g, '?')} isn’t one of the app’s hosts or anyone’s verified domain, so it shows “Page not found”. If it’s the app’s own custom domain, add it to the APP_HOSTS Secret.`);
  }

  // ── own domains: proven by a TXT record, looked at again every few hours ──
  const rechecks = new Map(); // domain → { running, confirmedAt, retryAt }

  /** Whether the domain's TXT record has this code: { found, values } or, when the DNS couldn't say, { error }. */
  async function lookUpTxt(domain, token) {
    let timer;
    try {
      const records = await Promise.race([
        Promise.resolve().then(() => resolveTxt(txtName(domain))),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'ETIMEOUT' })), DNS_TIMEOUT);
        }),
      ]);
      const values = (Array.isArray(records) ? records : []).map((r) =>
        (Array.isArray(r) ? r.join('') : String(r))
          .trim()
          .replace(/^"(.*)"$/s, '$1')
          .toLowerCase(),
      );
      return { found: values.includes(token), values: values.length };
    } catch (e) {
      // no such name, or no TXT record there: it isn't there (anything else: the DNS couldn't say)
      if (e?.code === 'ENOTFOUND' || e?.code === 'ENODATA') return { found: false, values: 0 };
      return { found: false, error: e };
    } finally {
      clearTimeout(timer);
    }
  }
  const txtProblem = (domain, r) =>
    r.error
      ? `The DNS lookup for ${txtName(domain)} didn’t get an answer. Try again in a few minutes.`
      : r.values
        ? `${txtName(domain)} has a TXT record, but not with this account’s value. Make it exactly the value shown here, then check again.`
        : `There’s no TXT record at ${txtName(domain)} yet. Add it at your domain registrar; it can take from a few minutes to a few hours to show up.`;

  /** A verified domain's record, looked at again in the background once its last check is old. */
  function recheckSoon(site) {
    const state = rechecks.get(site.domain) ?? {};
    const now = Date.now();
    const last = Math.max(Date.parse(site.verified_at) || 0, state.confirmedAt || 0);
    if (state.running || now - last < tune.recheckAfter || (state.retryAt ?? 0) > now) return;
    state.running = true;
    rechecks.set(site.domain, state);
    recheck(site)
      .catch((e) => {
        state.retryAt = Date.now() + RECHECK_RETRY;
        console.warn(`Published pages: couldn’t check ${site.domain} again (${e.message}).`);
      })
      .finally(() => {
        state.running = false;
      });
  }
  async function recheck(site) {
    const state = rechecks.get(site.domain);
    const d = encodeURIComponent(site.domain);
    // only while the row is still this owner's, with this code (and, to clear it, this check)
    const same = `published_domains?domain=eq.${d}&user_id=eq.${site.user_id}&token=eq.${encodeURIComponent(site.token)}`;
    const r = await lookUpTxt(site.domain, site.token);
    if (r.found) {
      state.confirmedAt = Date.now();
      // the other copies of the server needn't look again for a while (and this one reads the new time)
      await rest(same, { method: 'PATCH', body: { verified_at: new Date().toISOString() }, prefer: 'return=minimal' });
      domainCache.delete(site.domain);
      return;
    }
    if (r.error) {
      state.retryAt = Date.now() + RECHECK_RETRY;
      return;
    }
    console.warn(`Published pages: ${site.domain} no longer has its TXT record (${txtName(site.domain)}), so it stops showing pages until it's checked again.`);
    await rest(`${same}&verified_at=eq.${encodeURIComponent(site.verified_at)}`, { method: 'PATCH', body: { verified_at: null }, prefer: 'return=minimal' });
    dropDomain(site.domain);
    domainNames.drop(site.domain);
    rechecks.delete(site.domain);
  }

  /**
   * Any host that isn't the app's (see isAppHost): a verified domain shows its owner's published pages,
   * plus a robots.txt and a sitemap.xml. Any other host gets "not found" (503 when that can't be told yet),
   * whether or not publishing is on.
   */
  async function serveDomain(req, res, url) {
    const host = hostOf(req);
    // nobody's domain, or publishing is off: nothing to look up
    if (!enabled || !claimable(host, ownHosts)) {
      hintAppHosts(req, host, url);
      return notFound(req, res);
    }
    const client = visitor(req);
    // not a verified domain (any made-up Host): nothing to look up either
    if ((await domainNames.has(host)) === false) {
      hintAppHosts(req, host, url);
      return notFound(req, res);
    }
    const asked = Date.now();
    let site;
    try {
      site = await domainRow(host, client);
    } catch (e) {
      // can't tell whose domain this is right now
      return unavailable(req, res, e);
    }
    if (!verifiedRow(site)) {
      domainNames.drop(host, asked);
      if (!site) hintAppHosts(req, host, url);
      return notFound(req, res);
    }
    recheckSoon(site);
    // a visitor sending one of the domain's pages' forms (server/leads.mjs)
    if (req.method === 'POST' && leads.matchLead(url)) return leads.receiveOnDomain(req, res, url, site);
    // the app's short public routes (/m/<id>: the owner's lead magnets only)
    if (isPublicRoute(url.pathname)) return servePublicRoute(req, res, url, site);
    if (req.method !== 'GET' && req.method !== 'HEAD') return write(req, res, 405, { ...COMMON, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', allow: 'GET, HEAD' }, 'Method not allowed');
    const p = url.pathname;
    const text = (type, body, cacheControl) => write(req, res, 200, { ...COMMON, 'content-type': type, 'cache-control': cacheControl }, body);
    // the domain's pages (only its owner's: a page can only be published to its owner's domain)
    const listed = async () => ((await pagesOnDomain(host, client)) ?? []).filter((r) => r.user_id === site.user_id);
    try {
      if (p === '/robots.txt') text('text/plain; charset=utf-8', `User-agent: *\nAllow: /\nSitemap: https://${host}/sitemap.xml\n`, 'public, max-age=300');
      else if (p === '/sitemap.xml') {
        const urls = (await listed()).map((r) => `  <url><loc>https://${host}/${r.home ? '' : r.slug}</loc>${r.updated_at ? `<lastmod>${String(r.updated_at).slice(0, 10)}</lastmod>` : ''}</url>\n`);
        text('application/xml; charset=utf-8', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('')}</urlset>\n`, 'public, max-age=300');
      } else {
        // the app's short public routes (/b/, /m/, /o/) are never a page's
        const m = p === '/' || isPublicRoute(p) ? null : PAGE_PATH.exec(p);
        const slug = p === '/' ? (await listed()).find((r) => r.home)?.slug : m?.[1];
        // only this domain's own pages (and, at /, its home page)
        const shows = (page) => !!page && page.domain === host && page.user_id === site.user_id && (p !== '/' || !!page.home);
        const page = await findPage(slug, client);
        if (!shows(page)) notFound(req, res);
        else if (await expired(page)) gone(req, res);
        else if (m?.[3] !== undefined) await sendImage(req, res, page, m[3], client);
        else if (headOnly(req, page)) sendPage(req, res, page, null, { sandbox: false });
        else {
          const got = await pageWithHtml(page, client);
          if (!got || !shows(got.page)) notFound(req, res);
          else sendPage(req, res, got.page, got.html, { sandbox: false });
        }
      }
    } catch (e) {
      if (!res.headersSent) unavailable(req, res, e);
    }
  }

  /** A published page by its name, or null. A name nobody published costs no lookup; one found gone is forgotten. */
  async function findPage(slug, client) {
    if (!slug || (await pageNames.has(slug)) === false) return null;
    const asked = Date.now();
    const page = await pageRow(slug, client);
    if (!page) pageNames.drop(slug, asked);
    return page;
  }
  /** withHtml, forgetting the name when the page turns out to be gone. */
  async function pageWithHtml(page, client) {
    const asked = Date.now();
    const got = await withHtml(page, client);
    if (!got) pageNames.drop(page.slug, asked);
    return got;
  }

  /**
   * GET|HEAD on the app's own host, before page names: whether appHostExtras answered (false: carry on with
   * matchPage / the app). A failing extra answers 503 rather than taking the request down.
   */
  async function serveAppHostExtras(req, res, url) {
    if (typeof appHostExtras !== 'function' || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    try {
      return (await appHostExtras(req, res, url)) === true;
    } catch (e) {
      console.error('App-host extra failed:', e?.name || 'Error');
      if (!res.headersSent) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...COMMON });
        res.end('Try again in a minute.');
      }
      return true;
    }
  }

  /** /b/…, /m/… and /o/… (any method): the app's own short public routes, never the app itself (call servePublicRoute). */
  const matchPublicRoute = (url) => isPublicRoute(url.pathname);
  /**
   * A short public route, on the app's host or (site: serveDomain's row) on a domain. Until its feature answers it
   * (/b/ with offers, /o/ with opt-outs), it's the published pages' "not found" page.
   */
  async function servePublicRoute(req, res, url, site = null) {
    if (magnets.matchMagnet(url)) return magnets.serveMagnet(req, res, url, site);
    return notFound(req, res);
  }

  /** GET|HEAD /<slug>, /<slug>/ and /<slug>/img/<name> on the app's host (call servePage for them). */
  const matchPage = (url) => enabled && !isPublicRoute(url.pathname) && PAGE_PATH.test(url.pathname);

  /** A published page or its image on the app's host. false: it's one of the app's own paths (serve the app). */
  async function servePage(req, res, url) {
    const m = isPublicRoute(url.pathname) ? null : PAGE_PATH.exec(url.pathname);
    if (!enabled || !m) return false;
    const [, slug, , image] = m;
    if (reserved(slug)) return false;
    const client = visitor(req);
    try {
      const page = await findPage(slug, client);
      if (!page) notFound(req, res);
      else if (await expired(page)) gone(req, res);
      else if (image !== undefined) await sendImage(req, res, page, image, client);
      else if (headOnly(req, page)) sendPage(req, res, page, null, { sandbox: true });
      else {
        const got = await pageWithHtml(page, client);
        if (!got) notFound(req, res);
        else sendPage(req, res, got.page, got.html, { sandbox: true });
      }
    } catch (e) {
      if (!res.headersSent) unavailable(req, res, e);
    }
    return true;
  }

  // ── lead forms on published pages (server/leads.mjs): POST /<slug>/lead, /api/leads ──
  /**
   * A published page with its HTML, for a lead form sent to it (server/leads.mjs checks the page has that form).
   * Same cache and per-visitor budget as a visit; the HTML is kept apart as bytes.
   */
  async function leadPage(slug, req) {
    const client = visitor(req);
    const page = await findPage(slug, client);
    if (!page || (await expired(page))) return null;
    const got = await pageWithHtml(page, client);
    return got ? { ...got.page, html: got.html.toString('utf8') } : null;
  }
  // one pair of per-visitor and per-page counters for every form: the pages' and the lead magnets' email gate
  const counters = leadCounters(leadLimits);
  const magnets = createLeadFiles({
    enabled,
    supabaseUrl: url,
    secretKey,
    fetch,
    whoIs,
    send,
    readJson,
    rateLimited,
    corsHeaders,
    allowedOrigin,
    billing,
    mustExist,
    originOf,
    notFound,
    gone,
    visitor,
    keepLead: (row) => leads.keepLead(row),
    counters,
    limits: magnetLimits,
    linkSecret,
  });
  const leads = createLeads({ enabled, supabaseUrl: url, secretKey, fetch, counters, findPage: leadPage, findMagnet: magnets.findMagnet, ticket: magnets.ticket, reserved, notFound, whoIs, send, corsHeaders, rateLimited, allowedOrigin });

  // ── the signed-in API ──
  const describePage = (r, origin) => ({
    pageId: r.page_id,
    kind: r.kind,
    slug: r.slug,
    title: r.title ?? '',
    domain: r.domain ?? null,
    home: !!r.home,
    projectId: typeof r.project_id === 'string' ? r.project_id : null,
    updatedAt: r.updated_at ?? null,
    url: `${origin}/${r.slug}`,
    ...(r.domain ? { domainUrl: r.home ? `https://${r.domain}/` : `https://${r.domain}/${r.slug}` } : {}),
  });
  /** A domain as its owner sees it, with the TXT record that proves it's theirs. */
  const describeDomain = (r) => {
    const token = tokenOf(r);
    const verified = verifiedRow(r);
    return { domain: r.domain, token, verified, verifiedAt: verified ? r.verified_at : null, record: { type: 'TXT', name: txtName(r.domain), value: token } };
  };
  /** A domain another account has, as this account would prove it's theirs. */
  const describeClaim = (domain, userId) => describeDomain({ domain, user_id: userId, token: tokenFor(domain, userId), verified_at: null });
  const PAGE_COLUMNS = 'page_id,kind,slug,title,domain,home,project_id,updated_at';

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

  /** Whether the page's row lists the images of this publish (version); null when Supabase can't say. */
  async function usesVersion(uid, pid, version) {
    try {
      const rows = await rest(`published_pages?user_id=eq.${uid}&page_id=eq.${pid}&select=images`, { timeout: LOOKUP_TIMEOUT });
      const images = rows?.[0]?.images;
      return Array.isArray(images) && images.some((i) => i?.v === version);
    } catch {
      return null;
    }
  }

  async function publish(req, who, pageId, b, origin) {
    // publishing (new or again) needs an active plan once plans are enforced (402; a no-op without plans)
    if (billing?.requireActive) {
      try {
        await billing.requireActive(who, 'publish');
      } catch (e) {
        if (e?.status === 402) throw fail(402, e.code, e.message, { need: e.extra?.need, upgrade: '#plans' });
        throw fail(503, 'UNAVAILABLE', 'Couldn’t check your plan just now. Try again in a minute.');
      }
    }
    const kind = pageId.slice(0, pageId.indexOf(':'));
    if (b.kind !== undefined && b.kind !== kind) throw fail(400, 'BAD_REQUEST', 'The page’s kind doesn’t match its id.');
    const slug = typeof b.slug === 'string' ? b.slug.trim() : '';
    const why = slugProblem(slug);
    if (why === 'format') throw fail(400, 'BAD_SLUG', 'Use 3 to 60 lower-case letters, numbers and hyphens, starting and ending with a letter or number.', { reason: 'format' });
    if (why === 'reserved') throw fail(400, 'BAD_SLUG', 'That name is used by the app. Choose another.', { reason: 'reserved' });
    const tooLarge = () => fail(413, 'TOO_LARGE', 'This page is over 1.5 MB. Make it shorter, or use fewer images inside the page.');
    // each UTF-16 unit is at least one byte: a page this long is too big before it's even cleaned
    if (typeof b.html === 'string' && b.html.length > MAX_HTML_BYTES) throw tooLarge();
    const html = storable(b.html);
    if (!html.trim()) throw fail(400, 'BAD_REQUEST', 'There’s nothing to publish yet.');
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw tooLarge();
    // whole characters only (Postgres counts characters, and half an emoji isn't storable); cut first,
    // so a title of millions of characters costs nothing (300 characters are at most 600 units)
    const title = Array.from(storable(typeof b.title === 'string' ? b.title.slice(0, MAX_TITLE * 4) : '').trim())
      .slice(0, MAX_TITLE)
      .join('');
    const images = readImages(b.images);
    if (b.domain != null && typeof b.domain !== 'string') throw fail(400, 'BAD_REQUEST', 'The domain must be text.');
    const domain = b.domain ? normalizeDomain(b.domain) : null;
    if (b.domain && !domain) throw fail(400, 'BAD_DOMAIN', 'That isn’t a domain name.');
    const home = b.home === true;
    if (home && !domain) throw fail(400, 'BAD_REQUEST', 'Choose one of your domains to make this its home page.');
    // the page's business, so its leads know it: given, or (an SEO page) the id after seo:
    if (b.projectId != null && (typeof b.projectId !== 'string' || b.projectId.length > 80 || !PROJECT_ID_RE.test(b.projectId))) throw fail(400, 'BAD_REQUEST', 'Unknown business.');
    const projectId = b.projectId ?? (kind === 'seo' ? pageId.slice(4) : null);
    const uid = who.id;
    const pid = encodeURIComponent(pageId);
    const d = domain ? encodeURIComponent(domain) : '';
    const [holders, currents, owned] = await Promise.all([
      rest(`published_pages?slug=eq.${slug}&select=user_id,page_id`),
      rest(`published_pages?user_id=eq.${uid}&page_id=eq.${pid}&select=slug,domain,images`),
      domain ? rest(`published_domains?domain=eq.${d}&user_id=eq.${uid}&select=domain`) : [],
    ]);
    const holder = holders?.[0];
    const current = currents?.[0];
    if (holder && !(holder.user_id === uid && holder.page_id === pageId)) throw fail(409, 'SLUG_TAKEN', 'That name is taken. Choose another.');
    if (domain && !owned?.length) throw fail(400, 'DOMAIN_NOT_YOURS', 'Add that domain in Settings › Domains first.');
    if (!current) {
      const mine = await rest(`published_pages?user_id=eq.${uid}&select=slug&limit=${MAX_PAGES_PER_USER}`);
      if ((mine?.length ?? 0) >= MAX_PAGES_PER_USER) throw fail(400, 'TOO_MANY', `You can publish up to ${MAX_PAGES_PER_USER} pages. Unpublish one first.`);
    }
    // nothing is stored for an account that's gone (its sign-in still checks out until it expires)
    await mustExist(uid);
    // the images go into a folder of their own: the live page keeps its images until its row points here
    const base = pageFolder(uid, pageId);
    const version = images.length ? `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}` : '';
    const uploads = images.map((img) => `${base}/${version}/${img.name}`);
    let demoted = [];
    let swept = [];
    let saved;
    try {
      const sent = await Promise.allSettled(images.map((img) => putImage(`${base}/${version}`, img)));
      const failed = sent.find((s) => s.status === 'rejected');
      if (failed) throw failed.reason;
      if (domain) {
        // the domain may have changed hands while the images went up: it must still be this account's…
        const still = await rest(`published_domains?domain=eq.${d}&user_id=eq.${uid}&select=domain`);
        if (!still?.length) throw fail(400, 'DOMAIN_NOT_YOURS', 'That domain isn’t in your account anymore. Add it again in Settings › Domains.');
        // …and nothing of another account's stays on it: a publish of its previous owner's that was under way
        // when it changed hands can land after that, and keep the domain's one home page (they stay published
        // at their own names on the app's address)
        swept = (await rest(`published_pages?domain=eq.${d}&user_id=neq.${uid}&select=slug`, { method: 'PATCH', body: { domain: null, home: false }, prefer: 'return=representation' })) ?? [];
      }
      // one home page per domain: the domain's other home page stays published at its own name
      if (home) demoted = await rest(`published_pages?domain=eq.${d}&user_id=eq.${uid}&home=is.true&page_id=neq.${pid}&select=slug`, { method: 'PATCH', body: { home: false }, prefer: 'return=representation' });
      // one row per page: a new name moves the page (its old name stops working)
      const rows = await rest(`published_pages?on_conflict=user_id,page_id&select=${PAGE_COLUMNS}`, {
        method: 'POST',
        body: { slug, user_id: uid, page_id: pageId, kind, title, html, images: images.map(({ name, mime, size, sha256: hash }) => ({ name, mime, size, sha256: hash, v: version })), domain, home, project_id: projectId },
        prefer: 'resolution=merge-duplicates,return=representation',
      });
      saved = rows?.[0];
    } catch (e) {
      // nothing changed: the domain keeps the home page it had, and the new images go
      if (demoted?.length) await rest(`published_pages?slug=eq.${demoted[0].slug}&user_id=eq.${uid}&domain=eq.${d}`, { method: 'PATCH', body: { home: true }, prefer: 'return=minimal' }).catch(() => {});
      // …unless the page already points at them: a write whose answer was lost may still have landed
      // (and when that can't be told, they stay: the next publish of the page removes leftovers)
      const landed = uploads.length && e.code === 'UPSTREAM' ? await usesVersion(uid, pid, version) : false;
      if (uploads.length && landed === false) await deleteObjects(uploads).catch((err) => console.warn(`Published pages: couldn’t remove the images of a publish that failed (${err.message}).`));
      // the domain's one home page went to another page of this account's just now (not the name)
      if (e.code === 'CONFLICT' && e.constraint === 'home') throw fail(409, 'HOME_TAKEN', `Another page just became the home page of ${domain}. Publish again to make this page its home page.`);
      if (e.code === 'CONFLICT') throw fail(409, 'SLUG_TAKEN', 'That name was just taken. Choose another.');
      if (e.code === 'REFERENCE' && e.ref === 'user') throw accountGone();
      if (e.code === 'REFERENCE' && e.ref === 'domain') throw fail(400, 'DOMAIN_NOT_YOURS', 'That domain isn’t in your account anymore. Add it again in Settings › Domains.');
      throw e;
    } finally {
      // (what was swept stays swept: none of it belonged on this account's domain)
      forget({ slugs: swept.map((x) => x.slug), domains: [domain] });
    }
    forget({ slugs: [slug, current?.slug, ...(demoted ?? []).map((x) => x.slug)], domains: [domain, current?.domain] });
    pageNames.add(slug);
    if (current?.slug && current.slug !== slug) pageNames.drop(current.slug);
    imageCache.dropPrefix(`${base}/`);
    // the images it had before go (and leftovers of publishes that stopped halfway)
    const previous = Array.isArray(current?.images) ? String(current.images.find((i) => typeof i?.v === 'string' && i.v)?.v ?? '') : '';
    await removeImages(base, { keep: version, spare: UPLOAD_GRACE, previous });
    const page = describePage(saved ?? { page_id: pageId, kind, slug, title, domain, home, project_id: projectId }, origin);
    return { page, url: page.url, ...(page.domainUrl ? { domainUrl: page.domainUrl } : {}) };
  }

  async function unpublish(who, pageId) {
    const gone = await rest(`published_pages?user_id=eq.${who.id}&page_id=eq.${encodeURIComponent(pageId)}&select=slug,domain`, { method: 'DELETE', prefer: 'return=representation' });
    forget({ slugs: (gone ?? []).map((g) => g.slug), domains: (gone ?? []).map((g) => g.domain) });
    for (const g of gone ?? []) pageNames.drop(g.slug);
    const folder = pageFolder(who.id, pageId);
    imageCache.dropPrefix(`${folder}/`);
    await removeImages(folder);
    return { ok: true };
  }

  async function addDomain(who, raw) {
    const domain = normalizeDomain(raw);
    if (!domain) throw fail(400, 'BAD_DOMAIN', 'Enter a domain, like shop.example.com.');
    if (domain.length > 253 || !DOMAIN_RE.test(domain)) throw fail(400, 'BAD_DOMAIN', 'That isn’t a domain name. Enter it like shop.example.com.');
    if (NEVER_CLAIMED.some((re) => re.test(domain))) throw fail(400, 'BAD_DOMAIN', 'That address belongs to the app’s host. Use a domain you own.');
    if (ownHosts.has(domain)) throw fail(400, 'BAD_DOMAIN', 'That’s this app’s own address. Use a domain you own.');
    const mine = (await rest(`published_domains?user_id=eq.${who.id}&select=${DOMAIN_COLUMNS}`)) ?? [];
    const have = mine.find((x) => x.domain === domain);
    if (have) return describeDomain(have);
    if (mine.length >= MAX_DOMAINS_PER_USER) throw fail(400, 'TOO_MANY', `You can add up to ${MAX_DOMAINS_PER_USER} domains.`);
    // added by whoever adds it first; it's theirs once its TXT record is there (checkDomain)
    const rows = await rest(`published_domains?on_conflict=domain&select=${DOMAIN_COLUMNS}`, {
      method: 'POST',
      body: { domain, user_id: who.id, token: tokenFor(domain, who.id) },
      prefer: 'resolution=ignore-duplicates,return=representation',
    });
    let row = rows?.[0];
    if (!row) {
      row = (await rest(`published_domains?domain=eq.${encodeURIComponent(domain)}&select=${DOMAIN_COLUMNS}`))?.[0];
      if (!row) throw fail(409, 'CONFLICT', 'That domain changed just now. Try again.');
      // someone else's for now: the TXT record with this account's value moves it here
      if (row.user_id !== who.id) throw fail(409, 'DOMAIN_TAKEN', 'Another account added this domain first. If it’s yours, add the TXT record below at your domain registrar, then press Check again: it moves to your account.', { reply: { domain: describeClaim(domain, who.id) } });
    }
    dropDomain(domain);
    return describeDomain(row);
  }

  /**
   * The domain's TXT record, looked up now. The owner's domain is verified (or, once the record is
   * gone, not anymore); another account's moves to this account when the record has this account's value.
   */
  async function checkDomain(who, domain) {
    const d = encodeURIComponent(domain);
    const row = (await rest(`published_domains?domain=eq.${d}&select=${DOMAIN_COLUMNS}`))?.[0];
    if (!row) throw fail(404, 'NOT_FOUND', 'That domain isn’t in your list. Add it first.');
    const mine = row.user_id === who.id;
    if (!mine) {
      const count = (await rest(`published_domains?user_id=eq.${who.id}&select=domain&limit=${MAX_DOMAINS_PER_USER}`))?.length ?? 0;
      if (count >= MAX_DOMAINS_PER_USER) throw fail(400, 'TOO_MANY', `You can add up to ${MAX_DOMAINS_PER_USER} domains.`);
    }
    const token = mine ? tokenOf(row) : tokenFor(domain, who.id);
    const r = await lookUpTxt(domain, token);
    if (!r.found) {
      // the owner's record is gone: the domain stops showing pages (a lookup that failed changes nothing)
      if (mine && row.verified_at && !r.error) {
        await rest(`published_domains?domain=eq.${d}&user_id=eq.${who.id}`, { method: 'PATCH', body: { verified_at: null }, prefer: 'return=minimal' });
        dropDomain(domain);
        domainNames.drop(domain);
      }
      return { verified: false, error: txtProblem(domain, r) };
    }
    const now = new Date().toISOString();
    const changed = () => fail(409, 'CONFLICT', 'That domain changed while it was being checked. Check again.');
    let saved;
    if (mine) saved = (await rest(`published_domains?domain=eq.${d}&user_id=eq.${who.id}&select=${DOMAIN_COLUMNS}`, { method: 'PATCH', body: { token, verified_at: now }, prefer: 'return=representation' }))?.[0];
    else {
      for (let tries = 1; ; tries++) {
        // another account's: its pages come off the domain first (they stay published, on the app's address
        // only), so nothing of theirs is left there, its home page included (a domain has one)
        const off = (await rest(`published_pages?domain=eq.${d}&user_id=eq.${row.user_id}&select=slug`, { method: 'PATCH', body: { domain: null, home: false }, prefer: 'return=representation' })) ?? [];
        forget({ slugs: off.map((x) => x.slug), domains: [domain] });
        // then it changes hands in one step, unless it changed meanwhile (and the database refuses that step
        // while a page of theirs is still on it: one that landed in between, so once more)
        try {
          saved = (await rest(`published_domains?domain=eq.${d}&user_id=eq.${row.user_id}&token=eq.${encodeURIComponent(row.token)}&select=${DOMAIN_COLUMNS}`, { method: 'PATCH', body: { user_id: who.id, token, verified_at: now, created_at: now }, prefer: 'return=representation' }))?.[0];
          break;
        } catch (e) {
          if (e.code !== 'REFERENCE') throw e;
          if (tries >= 2) throw changed();
        }
      }
    }
    if (!saved) throw changed();
    // nothing of another account's stays on it: the previous owner's pages, a publish of theirs that was under
    // way when it changed hands and landed after included (it would keep the domain's one home page)
    const late = await rest(`published_pages?domain=eq.${d}&user_id=neq.${who.id}&select=slug`, { method: 'PATCH', body: { domain: null, home: false }, prefer: 'return=representation' }).catch((e) => {
      console.warn(`Published pages: couldn’t take other accounts’ pages off ${domain} (${e.message}).`);
      return [];
    });
    forget({ slugs: (late ?? []).map((x) => x.slug), domains: [domain] });
    dropDomain(domain);
    domainNames.add(domain);
    rechecks.delete(domain);
    return { verified: true, domain: describeDomain(saved) };
  }

  async function removeDomain(who, domain) {
    const d = encodeURIComponent(domain);
    const row = (await rest(`published_domains?domain=eq.${d}&user_id=eq.${who.id}&select=domain`))?.[0];
    if (!row) return { ok: true };
    // its pages stay published on the app's address
    const moved = await rest(`published_pages?user_id=eq.${who.id}&domain=eq.${d}&select=slug`, { method: 'PATCH', body: { domain: null, home: false }, prefer: 'return=representation' });
    await rest(`published_domains?domain=eq.${d}&user_id=eq.${who.id}`, { method: 'DELETE', prefer: 'return=minimal' });
    forget({ slugs: (moved ?? []).map((m) => m.slug), domains: [domain] });
    dropDomain(domain);
    domainNames.drop(domain);
    rechecks.delete(domain);
    return { ok: true };
  }

  const matchApi = (url) => /^\/api\/(pages|domains)(\/|$)/.test(url.pathname) || leads.matchApi(url) || magnets.matchApi(url);

  async function handleApi(req, res, url) {
    if (leads.matchApi(url)) return leads.handleApi(req, res, url);
    if (magnets.matchApi(url)) return magnets.handleApi(req, res, url);
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
    const readBody = async (limit) => {
      try {
        const b = await readJson(req, limit);
        if (b && typeof b === 'object' && !Array.isArray(b)) return b;
        reply(400, { error: 'Send a JSON object.', code: 'BAD_REQUEST' });
      } catch (e) {
        reply(e.status || 400, { error: e.status === 413 ? 'That’s too much to send at once. Use fewer or smaller images.' : 'That request couldn’t be read.', code: e.status === 413 ? 'TOO_LARGE' : 'BAD_REQUEST' });
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
            rest(`published_domains?user_id=eq.${who.id}&select=${DOMAIN_COLUMNS},created_at&order=created_at.asc`),
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
        const b = await readBody(MAX_DOMAIN_BODY);
        if (!b) return;
        return reply(200, await addDomain(who, typeof b.domain === 'string' ? b.domain : ''));
      }
      const domain = normalizeDomain(target);
      if (!domain || !DOMAIN_RE.test(domain)) return reply(404, { error: 'That domain isn’t in your list.', code: 'NOT_FOUND' });
      if (m[3]) return method === 'POST' ? reply(200, await checkDomain(who, domain)) : notAllowed();
      if (method === 'DELETE') return reply(200, await removeDomain(who, domain));
      return notAllowed();
    } catch (e) {
      if (!e?.status) console.error(e);
      if (res.headersSent) return;
      return reply(e?.status || 500, { error: e?.status ? e.message : 'Unexpected server error', code: e?.code || 'UPSTREAM', ...(e?.reason ? { reason: e.reason } : {}), ...(e?.need ? { need: e.need } : {}), ...(e?.upgrade ? { upgrade: e.upgrade } : {}), ...(e?.reply ?? {}) });
    }
  }

  /** A deleted account: its pages and domains stop answering on this copy of the server right away. */
  function forgetUser(userId) {
    const theirs = (v) => (Array.isArray(v) ? v.some((r) => r?.user_id === userId) : v?.user_id === userId);
    pageCache.deleteWhere(theirs);
    onDomainCache.deleteWhere(theirs);
    domainCache.deleteWhere(theirs);
    const theirHtml = (e) => String(e.tag ?? '').startsWith(`${userId} `);
    htmlCache.deleteWhere(theirHtml);
    bigHtmlCache.deleteWhere(theirHtml);
    imageCache.dropPrefix(`${userId}/`);
    magnets.forgetUser(userId);
  }

  return {
    enabled,
    /** For GET /api/config. */
    config: () => ({ enabled }),
    // POST /<slug>/lead on the app's address (server/leads.mjs)
    matchLead: leads.matchLead,
    receiveLead: leads.receiveLead,
    // /b/, /m/ and /o/ on the app's address (/m/<id>: a lead magnet, server/leadFiles.mjs)
    matchPublicRoute,
    servePublicRoute,
    forgetUser,
    /** Who a request comes from, as the per-address limits count it (clientOf, with TRUSTED_PROXY_HOPS). */
    visitor,
    isAppHost,
    appHostsNote,
    visitorsNote,
    serveDomain,
    matchApi,
    handleApi,
    matchPage,
    servePage,
    serveAppHostExtras,
    /** What the visitors' caches hold (tests, diagnostics): pages' rows, their HTML (big pages' apart), domains, names. */
    cacheStats: () => ({ pages: pageCache.stats(), html: htmlCache.stats(), bigHtml: bigHtmlCache.stats(), domains: domainCache.stats(), onDomain: onDomainCache.stats(), names: { pages: pageNames.stats(), domains: domainNames.stats() } }),
    close: () => clearInterval(sweeper),
  };
}
