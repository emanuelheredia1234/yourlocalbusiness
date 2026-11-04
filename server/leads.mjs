// Lead forms: what visitors send with a published page's form (a lead form page, a booking request, a
// question), kept for the page's owner, who sees it in the app (Marketing Hub → Email → Leads).
//
//   POST   /<slug>/lead                      (visitors) a published page's form → a small thank-you page,
//                                            on the app's address or on the page's own domain
//   GET    /api/leads?before=&limit=&pageId= → { leads: [{ id, pageId, slug, name, email, phone, message, time, createdAt }] }
//                                            newest first                                     (signed in, same site)
//   DELETE /api/leads/<id>                   → { ok: true } (already gone counts as done)
//
// Leads are rows in page_leads (supabase/migrations/20261103050000_page_leads.sql): row-level security on with
// no policies, so only this server, with the secret key, reads or writes them. Deleting an account deletes its
// leads (on delete cascade).
//
// What a visitor sends is a stranger's text. Every input is bounded before any pattern looks at it; a field over
// its limit is refused, never cut; and nothing a visitor typed (nor their email or address) is logged or shown
// back. Only a published SEO page whose HTML has a form posting here takes leads, and on a domain only that
// domain's own page. A hidden field (`website`) catches most bots: filled in, it looks like success and nothing
// is kept. Visitors and pages each have a limit per hour, counted in this server's memory.
//
// server/pages.mjs builds this (createLeads) with what it already has: its page lookup (cached and budgeted),
// the app's reserved names and its "not found" page. Env: LEADS_PER_IP_PER_HOUR (default 10),
// LEADS_PER_PAGE_PER_HOUR (default 30).

import crypto from 'node:crypto';
import net from 'node:net';
import { serviceHeaders } from './secretBox.mjs';
import { sameOrigin } from './providers/routes.mjs';

export const LEADS_MIGRATION = 'supabase/migrations/20261103050000_page_leads.sql';

/** Forms per visitor and per page in windowMs, when nothing says otherwise. */
export const LEAD_LIMITS = Object.freeze({ perIp: 10, perPage: 30, windowMs: 3_600_000 });

/** The limits from the environment: LEADS_PER_IP_PER_HOUR and LEADS_PER_PAGE_PER_HOUR (whole numbers from 1). */
export function leadLimitsFromEnv(env = process.env) {
  const count = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
  };
  return { perIp: count(env.LEADS_PER_IP_PER_HOUR, LEAD_LIMITS.perIp), perPage: count(env.LEADS_PER_PAGE_PER_HOUR, LEAD_LIMITS.perPage), windowMs: LEAD_LIMITS.windowMs };
}

/** POST /<slug>/lead. A slug is 3 to 60 lower-case letters, digits and hyphens, so the path is at most 66 characters. */
const LEAD_PATH = /^\/([a-z0-9][a-z0-9-]{1,58}[a-z0-9])\/lead$/;
const MAX_LEAD_PATH = 66;
const API_ROOT = '/api/leads';
/** /api/leads/<id>: an id is a UUID (36 characters, a little more when encoded) */
const MAX_API_PATH = API_ROOT.length + 1 + 120;
/** Each field's limit in characters (the table's). The form's own maxlength keeps people under it. */
const LEAD_MAX = Object.freeze({ name: 120, email: 254, phone: 40, message: 2000, time: 120 });
/** Before it's tidied, a field may be this many times its limit (line breaks sent as CR LF, runs of spaces); more is refused unread. */
const RAW_FACTOR = 4;
/** A form's whole body. */
const MAX_LEAD_BYTES = 16 * 1024;
/** How much of a body that's refused is read (and dropped) so the answer can go out; past it, the connection ends. */
const MAX_DRAIN = 1024 * 1024;
const LEAD_COLUMNS = 'id,page_id,slug,name,email,phone,message,time,created_at';
const LEAD_EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;
/** An ISO time exactly as Postgres sends it back (paging passes it on unchanged, microseconds and all): at most 32 characters. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const MAX_ISO = 32;
/** A page's id (the same rule as published_pages and page_leads): at most 89 characters. */
const PAGE_ID_RE = /^(seo|artifact):[A-Za-z0-9_-]{1,80}$/;
const MAX_PAGE_ID = 89;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Of X-Forwarded-For, only the end is read: that's where each proxy adds the address it got the request from. */
const MAX_FORWARDED = 1024;
const TIMEOUT = 5000;

const NOTICE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const COMMON = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' };

/**
 * The answer a visitor gets: the same plain page as pages.mjs's notices (no app name: a domain mustn't show
 * whose app serves it), plus a link back to the page. Every string in it is one of this file's own, and back is
 * / or /<slug> (letters, digits and hyphens), so nothing needs escaping.
 */
const leadNotice = (title, text, back) => `<!doctype html>
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
  p.back { margin-top: 16px; }
  a { color: #1d4ed8; }
  @media (prefers-color-scheme: dark) { body { color: #f3f4f6; background: #111827; } p { color: #9ca3af; } a { color: #93c5fd; } }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${text}</p>
<p class="back"><a href="${back}">Back to the page</a></p>
</main>
</body>
</html>
`;

/** What a visitor is told: status, title, text. "Thank you" only once the lead is kept (or a bot filled the hidden field). */
const ANSWERS = {
  sent: [200, 'Thank you', 'Your message was sent.'],
  requested: [200, 'Thank you', 'Your request was sent. This is a request, not a booked time.'],
  noContact: [400, 'Add your email or phone', 'Go back and add your email or phone number, then send it again.'],
  badEmail: [400, 'Check your email', 'That email address doesn’t look right. Go back and check it.'],
  badPhone: [400, 'Check your phone number', 'That phone number doesn’t look right. Go back and check it.'],
  tooLong: [400, 'That’s too long', 'Something you typed is too long. Go back and shorten it.'],
  unreadable: [400, 'This form couldn’t be read', 'Go back and try again.'],
  notForm: [415, 'This form couldn’t be read', 'Go back and try again.'],
  tooBig: [413, 'That’s too long to send', 'Go back and shorten your message.'],
  visitorLimit: [429, 'Please wait a little', 'Too many messages were sent from here just now. Try again later.'],
  pageLimit: [429, 'Please wait a little', 'This page got a lot of messages in the last hour. Try again later.'],
  notSent: [503, 'Your message wasn’t sent', 'It couldn’t be sent right now. Try again in a few minutes.'],
};

// ── who a visitor is, for the per-visitor limit ──

// Addresses that aren't a visitor's own: this machine, private networks (the host's proxies), and the like.
const PRIVATE = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) PRIVATE.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVATE.addSubnet(a, p, 'ipv6');

/** An IPv4 address as a dual-stack server sees it (::ffff:203.0.113.5) → the IPv4 address. */
const unmapped = (a) => (a.length <= 22 && /^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/i.test(a) ? a.slice(7) : a);

/** Whether an address is private (or not an address at all). */
function isPrivate(address) {
  const a = unmapped(String(address || ''));
  if (net.isIPv4(a)) return PRIVATE.check(a, 'ipv4');
  return net.isIPv6(a) ? PRIVATE.check(a, 'ipv6') : true;
}

/** An address as a counting key: IPv4 as it is, IPv6 by its first 64 bits (what one home or phone line gets). */
export function visitorKey(address) {
  const a = unmapped(String(address || ''));
  if (!net.isIPv6(a)) return a;
  const [head, tail] = a.toLowerCase().split('%')[0].split('::');
  const groups = head ? head.split(':') : [];
  if (tail !== undefined) {
    const rest = tail ? tail.split(':') : [];
    const width = rest.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
    groups.push(...Array(Math.max(0, 8 - groups.length - width)).fill('0'), ...rest);
  }
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * The visitor, as a counting key: the connection's address, or behind the host's proxy (a private address)
 * the nearest public address it forwarded for. The left part of X-Forwarded-For is whatever the visitor sent;
 * each proxy appends the address it got the request from, so it's read from the right.
 */
export function visitorOf(req) {
  const peer = String(req.socket?.remoteAddress || '');
  if (!isPrivate(peer)) return visitorKey(peer);
  const fwd = req.headers['x-forwarded-for'];
  const chain = typeof fwd === 'string' ? fwd.slice(-MAX_FORWARDED).split(',') : [];
  for (let i = chain.length - 1; i >= 0; i--) {
    const a = chain[i].trim();
    if (net.isIP(unmapped(a)) && !isPrivate(a)) return visitorKey(a);
  }
  return visitorKey(peer);
}

/** How often each key did something in the last windowMs. Memory only: never logged, never saved. */
function windowCounter(limit, windowMs, maxKeys = 10_000) {
  const m = new Map(); // key → its times, oldest first; the key used least recently first
  const recent = (key, now) => {
    const list = m.get(key);
    if (!list) return [];
    while (list.length && now - list[0] >= windowMs) list.shift();
    if (!list.length) m.delete(key);
    return list;
  };
  return {
    full: (key) => recent(key, Date.now()).length >= limit,
    /** ms until one more fits */
    wait(key) {
      const now = Date.now();
      const list = recent(key, now);
      return list.length ? Math.max(0, windowMs - (now - list[0])) : 0;
    },
    hit(key) {
      const now = Date.now();
      const list = recent(key, now);
      m.delete(key);
      m.set(key, [...list, now]);
      while (m.size > maxKeys) m.delete(m.keys().next().value);
    },
  };
}

// ── what a visitor sends ──

/** Text Postgres can store: no NUL characters, no half emoji. */
const storable = (v) => {
  const s = typeof v === 'string' ? v.replace(/\u0000/g, '') : '';
  return typeof s.toWellFormed === 'function' ? s.toWellFormed() : s;
};
/** Control characters a visitor's text never keeps (tabs and line breaks become spaces or line breaks instead). */
const CONTROL = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g;
/** A one-line field (name, email, phone, preferred time): whitespace runs become one space. */
const oneLine = (v) => storable(v).replace(CONTROL, '').replace(/\s+/g, ' ').trim();
/** The message: the same, but its line breaks stay (at most two in a row). */
const multiLine = (v) =>
  storable(v)
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n')
    .replace(CONTROL, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
/** A phone number as people type it: 6 to 15 digits, with only + ( ) - . and spaces besides. */
const phoneOk = (s) => /^[0-9+().\- ]+$/.test(s) && /^\d{6,15}$/.test(s.replace(/\D/g, ''));

/**
 * A form's fields, tidied: { fields } or { problem } (a key of ANSWERS). Each is bounded before any pattern
 * looks at it, and over its limit it's refused, never cut. It needs an email or a phone.
 */
export function readLeadFields(form) {
  const fields = {};
  for (const [key, max] of Object.entries(LEAD_MAX)) {
    const raw = form.get(key) ?? '';
    if (raw.length > max * RAW_FACTOR) return { problem: 'tooLong' };
    const v = key === 'message' ? multiLine(raw) : oneLine(raw);
    if (v.length > max && Array.from(v).length > max) return { problem: 'tooLong' };
    fields[key] = v;
  }
  if (fields.email && !LEAD_EMAIL.test(fields.email)) return { problem: 'badEmail' };
  if (fields.phone && !phoneOk(fields.phone)) return { problem: 'badPhone' };
  if (!fields.email && !fields.phone) return { problem: 'noContact' };
  return { fields };
}

/** HTML's whitespace: space, tab, line feed, form feed, carriage return. */
const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;

/**
 * Whether a page's HTML has a form that posts here: <form … action="/<slug>/lead" …>. A scan, not a pattern:
 * the HTML is the owner's (up to 1.5 MB), and each character is looked at a bounded number of times.
 */
export function hasLeadForm(html, slug) {
  if (typeof html !== 'string') return false;
  const action = `action="/${slug}/lead"`;
  if (!html.includes(action)) return false;
  for (let at = html.indexOf('<form'); at !== -1; ) {
    const end = html.indexOf('>', at);
    if (end === -1) return false;
    // <form, then a space or / (not <formula>); the tag ends at its first >
    const next = html.charCodeAt(at + 5);
    if (isSpace(next) || next === 47) {
      const tag = html.slice(at + 5, end);
      // an attribute's name follows a space, a / or the quote that ends the attribute before it
      for (let i = tag.indexOf(action); i !== -1; i = tag.indexOf(action, i + 1)) {
        const before = tag.charCodeAt(i - 1);
        if (isSpace(before) || before === 47 || before === 34 || before === 39) return true;
      }
    }
    at = html.indexOf('<form', end);
  }
  return false;
}

/** Read and drop what's still coming (so the answer can be read); past MAX_DRAIN, end the connection. */
function drain(req) {
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_DRAIN) req.destroy();
  });
  req.on('error', () => {});
  req.resume();
}

/** A form's fields (application/x-www-form-urlencoded, at most MAX_LEAD_BYTES). Rejects with { status: 400 | 413 | 415 }. */
function readForm(req) {
  return new Promise((resolve, reject) => {
    const refuse = (status) => reject(Object.assign(new Error('That form couldn’t be read.'), { status }));
    const type = String(req.headers['content-type'] || '')
      .slice(0, 100)
      .toLowerCase();
    if (!type.startsWith('application/x-www-form-urlencoded')) {
      drain(req);
      return refuse(415);
    }
    if (Number(req.headers['content-length']) > MAX_LEAD_BYTES) {
      drain(req);
      return refuse(413);
    }
    const chunks = [];
    let size = 0;
    // past the limit, what's sent is read and dropped, so the answer can still go out; far too much ends the connection
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_LEAD_BYTES) chunks.push(c);
      else if (size > MAX_DRAIN) req.destroy();
    });
    req.on('end', () => (size > MAX_LEAD_BYTES ? refuse(413) : resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))));
    req.on('error', () => refuse(400));
    req.on('close', () => refuse(400));
  });
}

/**
 * enabled: publishing is on (accounts and the secret key). supabaseUrl, secretKey, fetch: Supabase's REST API.
 * limits: { perIp, perPage, windowMs }. findPage(slug, req): the published page's row ({ slug, user_id, page_id,
 * kind, html, domain, home }) or null, cached and budgeted (it throws when that can't be told right now).
 * reserved(slug): one of the app's own names. notFound(req, res): the "Page not found" page. whoIs, send,
 * corsHeaders, rateLimited, allowedOrigin: the server's own, as pages.mjs has them.
 */
export function createLeads({
  enabled = false,
  supabaseUrl = '',
  secretKey = '',
  fetch = globalThis.fetch,
  limits = LEAD_LIMITS,
  findPage = async () => null,
  reserved = () => false,
  notFound = (req, res) => {
    res.writeHead(404, { ...COMMON, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('Not found');
  },
  whoIs,
  send,
  corsHeaders = () => ({}),
  rateLimited = () => false,
  allowedOrigin = '',
} = {}) {
  const lim = { ...LEAD_LIMITS, ...(limits || {}) };
  let base = String(supabaseUrl);
  while (base.endsWith('/')) base = base.slice(0, -1);
  const headers = secretKey ? serviceHeaders(secretKey) : {};
  const perVisitor = windowCounter(lim.perIp, lim.windowMs);
  const perPage = windowCounter(lim.perPage, lim.windowMs);

  const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
  let warnedTable = false;
  const tableMissing = () => {
    if (!warnedTable) {
      warnedTable = true;
      console.warn(`Lead forms: the page_leads table isn’t in Supabase yet. Run ${LEADS_MIGRATION} in Supabase → SQL Editor.`);
    }
    return fail(503, 'LEADS_TABLE', `Run ${LEADS_MIGRATION} in Supabase → SQL Editor.`);
  };
  let warnedAt = 0;
  /** At most one line a minute, and only codes: never what a visitor wrote, their email or their address. */
  const warn = (line) => {
    if (Date.now() - warnedAt < 60_000) return;
    warnedAt = Date.now();
    console.warn(line);
  };

  /** Supabase's REST API with the secret key: the parsed answer, or an error with status and code (fixed words: Postgres's stay here). */
  async function rest(query, { method = 'GET', body, prefer, timeout = 10_000 } = {}) {
    let res;
    try {
      res = await fetch(`${base}/rest/v1/${query}`, { method, headers: { ...headers, ...(prefer ? { prefer } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw fail(502, 'UPSTREAM', e?.name === 'TimeoutError' ? 'Supabase took too long to answer. Try again.' : 'Couldn’t reach Supabase. Try again.', { detail: e?.name === 'TimeoutError' ? 'timeout' : 'unreachable' });
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
    // the message may quote the row (a visitor's words): it's only looked at, never logged or passed on
    const message = String(data?.message ?? '').slice(0, 300);
    if (res.status === 404 && (code === 'PGRST205' || code === '42P01' || message.includes('page_leads'))) throw tableMissing();
    throw fail(502, 'UPSTREAM', `Supabase refused that (error ${res.status}). Try again.`, { detail: `${res.status}${code ? ` ${code}` : ''}` });
  }

  const sendNotice = (res, [status, title, text], back, extra = {}) => {
    const body = Buffer.from(leadNotice(title, text, back), 'utf8');
    res.writeHead(status, { ...COMMON, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': NOTICE_CSP, 'content-length': body.length, ...extra });
    res.end(body);
  };
  const retryAfter = (ms) => ({ 'retry-after': String(Math.max(1, Math.ceil(ms / 1000))) });

  /** POST /<slug>/lead (call receiveLead for it). */
  const matchLead = (url) => enabled && url.pathname.length <= MAX_LEAD_PATH && LEAD_PATH.test(url.pathname);

  /**
   * A visitor sends a published page's form, on the app's address or (site: that domain's row, from serveDomain)
   * on the page's own domain. It's kept for the page's owner, and the visitor gets a short page that says so, or
   * what to fix. Never "sent" unless the lead was stored, or the hidden field caught a bot. false: not a form
   * this server takes (one of the app's own names): the caller answers.
   */
  async function receiveLead(req, res, url, site = null) {
    const p = url.pathname;
    const m = enabled && p.length <= MAX_LEAD_PATH ? LEAD_PATH.exec(p) : null;
    if (!m || reserved(m[1])) return false;
    const slug = m[1];
    let back = `/${slug}`;
    const answer = (name, extra) => {
      sendNotice(res, ANSWERS[name], back, extra);
      return true;
    };
    try {
      // every post counts, the hidden field's too
      const visitor = visitorOf(req);
      if (perVisitor.full(visitor)) {
        drain(req);
        return answer('visitorLimit', retryAfter(perVisitor.wait(visitor)));
      }
      perVisitor.hit(visitor);
      let form;
      try {
        form = await readForm(req);
      } catch (e) {
        return answer(e.status === 413 ? 'tooBig' : e.status === 415 ? 'notForm' : 'unreadable');
      }
      // the hidden field people never see: a bot filled it in
      if (form.get('website')) return answer('sent');
      let page;
      try {
        page = await findPage(slug, req);
      } catch {
        return answer('notSent', retryAfter(60_000));
      }
      // only an SEO page published with this form, and on a domain only that domain's own page
      if (!page || page.kind !== 'seo' || !hasLeadForm(page.html, slug) || (site && (page.domain !== site.domain || page.user_id !== site.user_id))) {
        notFound(req, res);
        return true;
      }
      if (site && page.home) back = '/';
      const { fields, problem } = readLeadFields(form);
      if (problem) return answer(problem);
      const pageKey = `${page.user_id}:${page.page_id}`;
      if (perPage.full(pageKey)) return answer('pageLimit', retryAfter(perPage.wait(pageKey)));
      perPage.hit(pageKey);
      try {
        // once: the server never sends a visitor's message twice
        await rest('page_leads', { method: 'POST', body: { id: crypto.randomUUID(), user_id: page.user_id, slug, page_id: page.page_id, ...fields, created_at: new Date().toISOString() }, prefer: 'return=minimal', timeout: TIMEOUT });
      } catch (e) {
        warn(`Lead forms: couldn’t keep a lead (${e?.code === 'LEADS_TABLE' ? 'LEADS_TABLE' : e?.detail || e?.code || 'error'}).`);
        return answer('notSent', retryAfter(60_000));
      }
      return answer(fields.time ? 'requested' : 'sent');
    } catch {
      if (!res.headersSent) answer('notSent', retryAfter(60_000));
      return true;
    }
  }

  /** The same on a page's own domain (site: serveDomain's row for it). Anything that isn't one of its pages' forms is "not found". */
  async function receiveOnDomain(req, res, url, site) {
    if (!(await receiveLead(req, res, url, site))) notFound(req, res);
    return true;
  }

  // ── the signed-in API ──
  const matchApi = (url) => url.pathname === API_ROOT || url.pathname.startsWith(`${API_ROOT}/`);
  const describeLead = (r) => ({ id: r.id, pageId: r.page_id, slug: r.slug, name: r.name ?? '', email: r.email ?? '', phone: r.phone ?? '', message: r.message ?? '', time: r.time ?? '', createdAt: r.created_at ?? null });

  async function handleApi(req, res, url) {
    const reply = (status, body) => send(res, status, body, corsHeaders(req));
    if (!sameOrigin(req, allowedOrigin)) return reply(403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
    if (!enabled) return reply(503, { error: 'Publishing isn’t set up on this server yet: it needs accounts and the SUPABASE_SECRET_KEY Secret. Ask the app’s owner.', code: 'PAGES_OFF' });
    const ident = await whoIs(req, res);
    if (!ident) return;
    const { who } = ident;
    const uid = String(who?.id ?? '');
    if (!who || uid.length !== 36 || !UUID.test(uid)) return reply(401, { error: 'Sign in to see your leads.', code: 'AUTH_REQUIRED' });
    const notFoundHere = () => reply(404, { error: 'Not found.', code: 'NOT_FOUND' });
    const p = url.pathname;
    if (p.length > MAX_API_PATH) return notFoundHere();
    // /api/leads, or /api/leads/<id>
    const tail = p.slice(API_ROOT.length);
    if (tail !== '' && (tail === '/' || tail.indexOf('/', 1) !== -1)) return notFoundHere();
    const method = req.method;
    // reads are counted apart from changes, and leads apart from pages
    if (rateLimited(`leads${method === 'GET' ? '-read' : ''}:user:${uid}`)) return reply(429, { error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMIT' });
    const notAllowed = () => reply(405, { error: 'Method not allowed', code: 'METHOD' });
    let target = null;
    if (tail) {
      try {
        target = decodeURIComponent(tail.slice(1));
      } catch {
        return reply(400, { error: 'Bad address.', code: 'BAD_REQUEST' });
      }
    }
    try {
      if (target === null) {
        if (method !== 'GET') return notAllowed();
        const asked = (url.searchParams.get('limit') ?? '').slice(0, 8);
        const limit = Math.min(100, Math.max(1, Number.parseInt(asked, 10) || 50));
        // passed on exactly as the server sent it: read back and written again, a time loses its microseconds and paging could skip a lead
        const before = url.searchParams.get('before') ?? '';
        if (before && (before.length > MAX_ISO || !ISO_TIME.test(before) || Number.isNaN(Date.parse(before)))) return reply(400, { error: 'That time isn’t one the server can read.', code: 'BAD_REQUEST' });
        const pageId = url.searchParams.get('pageId') ?? '';
        if (pageId && (pageId.length > MAX_PAGE_ID || !PAGE_ID_RE.test(pageId))) return reply(400, { error: 'Unknown page.', code: 'BAD_REQUEST' });
        // encoded: a + in the time would otherwise read as a space
        const rows = await rest(`page_leads?user_id=eq.${uid}${pageId ? `&page_id=eq.${encodeURIComponent(pageId)}` : ''}${before ? `&created_at=lt.${encodeURIComponent(before)}` : ''}&select=${LEAD_COLUMNS}&order=created_at.desc,id.desc&limit=${limit}`);
        return reply(200, { leads: (Array.isArray(rows) ? rows : []).map(describeLead) });
      }
      if (target.length !== 36 || !UUID.test(target)) return reply(404, { error: 'That lead isn’t in your list.', code: 'NOT_FOUND' });
      if (method !== 'DELETE') return notAllowed();
      // only the owner's own lead; already gone counts as done
      await rest(`page_leads?id=eq.${target}&user_id=eq.${uid}`, { method: 'DELETE', prefer: 'return=minimal' });
      return reply(200, { ok: true });
    } catch (e) {
      if (!e?.status) console.error(e);
      if (res.headersSent) return;
      return reply(e?.status || 500, { error: e?.status ? e.message : 'Unexpected server error', code: e?.code || 'UPSTREAM' });
    }
  }

  return { matchLead, receiveLead, receiveOnDomain, matchApi, handleApi };
}
