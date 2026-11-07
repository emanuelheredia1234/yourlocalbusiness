// The public marketplace (P7): listings their sellers put "Public on the web", rendered by the server at /market on
// the app's own host and indexed by Google when they are full enough. The in-app Marketplace (market_listings, signed
// in only) is unchanged; this is a separate, server-only copy (public_listings).
//
// Seller API (signed in, same site, JSON, no-store; errors { error, code }):
//   GET    /api/market/public[?projectId=]          → { listings: [PublicListingState], limit, used, appUrl }
//   PUT    /api/market/public/<listingId>  {…}      → { listing } (201 the first time): validate, normalize, the plan's
//                                                    limit and the per-day count under a lock per seller (409 LIMIT,
//                                                    409 HIDDEN, 429 RATE_LIMITED), the quality check (live or thin)
//   DELETE /api/market/public/<listingId>           → { ok: true }: the seller unlists (410 from then on; the slug stays)
//   POST   /api/market/reports {slug, reason, note?} → { ok: true }: a signed-in report (not your own listing)
// Owner only (who.isAdmin):
//   GET    /api/market/admin                         → { reports, held, hidden, submit, alert }
//   POST   /api/market/admin/listings/<id>/hide {reason, note?} · …/unhide · /api/market/admin/reports/<id>/dismiss
//   POST   /api/market/admin/submit-sitemap {confirm: true} → { outcome, alreadySubmittedAt? }
// Visitors (the app's host only: a custom domain never reaches this; GET and HEAD, plus POST for a report):
//   /market[?category=&q=&page=]  /market/<slug>  /market/<slug>/report
//   No scripts (the CSP has default-src 'none'); 60 s HTTP cache with an ETag; unlisted, hidden, over-limit and
//   ended-plan listings answer 410; thin and held ones are served with noindex. See render.mjs, store.mjs, reports.mjs.
// Cron: market-sweep (04:20 UTC: plan limits after a downgrade, quality again, old unlisted rows) and
//   market-sitemap-submit (05:40 UTC: only when the market changed since the last submit; submit.mjs).
//
// Env (all optional): MARKET_PUBLIC=off (every /market page "not found", the API 503 NOT_SET_UP), MARKET_REPORT_SECRET
// (16+ characters; else derived from SUPABASE_SECRET_KEY), MARKET_REPORTS_PER_IP_PER_HOUR (5),
// MARKET_REPORTS_PER_LISTING_PER_HOUR (30), MARKET_REPORT_HOLD_AT (3), MARKET_NEW_PUBLIC_PER_DAY (10). Uses
// GSC_APP_PROPERTY, APP_PUBLIC_URL, SUPABASE_URL. Tables: supabase/migrations/20261119000000_public_market.sql.

import crypto from 'node:crypto';
import { errorBody, fail, isUuid, notSetUp, safeLog } from '../integrations/common.mjs';
import { ROUTE_PREFIXES } from '../integrations/contracts.mjs';
import { drain, leadNotice, NOTICE_CSP, readForm, visitorOf, windowCounter } from '../leads.mjs';
import { serviceHeaders } from '../secretBox.mjs';
import { PUBLIC_FILES_BUCKET } from '../buckets.mjs';
import { appOrigin } from '../seo/sitemap.mjs';
import { publicStatus, qualityOf, statusOf } from './quality.mjs';
import { gridHtml, gridPath, listingHtml, marketCsp, MAX_PAGE, reportFormHtml } from './render.mjs';
import { checkFormToken, cleanNote, createReports, makeFormToken, reporterHash } from './reports.mjs';
import { createMarketStore, normalizeQuery } from './store.mjs';
import { createMarketSubmit } from './submit.mjs';
import { CATEGORY_SLUG_RE, LISTING_ID_RE, PROJECT_ID_RE, REPORT_REASONS, SLUG_RE, slugFor, validatePublicListing } from './validate.mjs';

export const MARKET_MIGRATION = 'supabase/migrations/20261119000000_public_market.sql';
const MAX_JSON = 32 * 1024;
const UNLISTED_KEEP_MS = 180 * 86_400_000;
const off = (v) => ['off', 'none', 'false', '0'].includes(String(v ?? '').trim().toLowerCase());
const count = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
};

/** The market's settings from env (numbers from 1; anything else is the default). */
export function marketSettings(env = process.env) {
  const own = String(env.MARKET_REPORT_SECRET ?? '');
  const key = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '');
  return {
    switchedOff: off(env.MARKET_PUBLIC),
    reportSecret: own.length >= 16 ? Buffer.from(own, 'utf8') : key ? Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), 'ylb-market-report', 32)) : null,
    reportsPerIp: count(env.MARKET_REPORTS_PER_IP_PER_HOUR, 5),
    reportsPerListing: count(env.MARKET_REPORTS_PER_LISTING_PER_HOUR, 30),
    holdAt: count(env.MARKET_REPORT_HOLD_AT, 3),
    newPerDay: count(env.MARKET_NEW_PUBLIC_PER_DAY, 10),
  };
}

const PUBLIC_PATH = /^\/market(?:\/([^/]{1,80})(\/|\/report)?)?(\/)?$/;

/**
 * deps: the integration modules' own (server/integrations/wiring.mjs): auth, db, storage (appState), treg,
 * connections, send, readJson, limit, corsHeaders, sameOrigin, clientKey, env, fetch, now, log, billing. Tests:
 * visitor(req) (the client key for the public pages).
 */
export function createMarket({ auth = null, db = null, storage = null, treg = null, connections = null, send, readJson, limit = () => false, corsHeaders = () => ({}), sameOrigin = () => true, env = process.env, fetch = globalThis.fetch, now = () => Date.now(), log = console, billing = null, visitor = visitorOf } = {}) {
  const cfg = marketSettings(env);
  const enabled = !cfg.switchedOff && !!db?.enabled && auth?.enabled === true && !!cfg.reportSecret;
  const supabaseBase = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const supabaseOrigin = (() => {
    try {
      return new URL(supabaseBase).origin;
    } catch {
      return '';
    }
  })();
  const secretKey = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '');
  const CSP = marketCsp(supabaseOrigin);
  const imageUrl = (path) => `${supabaseBase}/storage/v1/object/public/${PUBLIC_FILES_BUCKET}/${String(path).split('/').map(encodeURIComponent).join('/')}`;
  const blocked = new Set();
  const store = createMarketStore({ db, billing, now });
  let sitemap = null;
  const log1 = (event, fields) => safeLog(event, fields, log);
  const submitter = createMarketSubmit({ db, storage, treg, connections, env, now, log, hasLive: async () => (await db.select('public_listings', { status: 'live' }, { select: 'id', limit: 1 })).length > 0 });

  /** Something public changed: this copy's caches, the sitemap's, and the cron's "changed since" mark. */
  async function onChanged(slug = null) {
    store.drop(slug);
    sitemap?.clearCache?.();
    await submitter.markChanged();
  }
  const reports = createReports({ db, now, holdAt: cfg.holdAt, onChanged: (slug) => void onChanged(slug), log: log1 });

  const perVisitor = windowCounter(cfg.reportsPerIp, 3_600_000);
  const perListing = windowCounter(cfg.reportsPerListing, 3_600_000);
  const allReports = windowCounter(500, 3_600_000, 1);

  const notes = () => {
    if (cfg.switchedOff) return ['Public marketplace: off (MARKET_PUBLIC=off). /market answers "not found".'];
    if (!db?.enabled || auth?.enabled !== true) return ['Public marketplace: off (it needs accounts, SUPABASE_URL and SUPABASE_SECRET_KEY).'];
    const lines = [`Public marketplace: on (/market). It needs ${MARKET_MIGRATION} in Supabase (limits: MARKET_REPORTS_PER_IP_PER_HOUR, MARKET_REPORTS_PER_LISTING_PER_HOUR, MARKET_REPORT_HOLD_AT, MARKET_NEW_PUBLIC_PER_DAY).`];
    if (String(env.MARKET_REPORT_SECRET ?? '').length < 16) lines.push('Public marketplace: report forms are signed with a key derived from SUPABASE_SECRET_KEY (set MARKET_REPORT_SECRET, 16+ characters, to keep them apart).');
    if (!String(env.GSC_APP_PROPERTY || '').trim()) lines.push('Public marketplace: GSC_APP_PROPERTY isn’t set, so sitemap submissions are off (listings still appear in /sitemap.xml).');
    return lines;
  };
  const config = () => ({ enabled, publicUrl: enabled ? `${appOrigin(env)}/market` : null });

  // ───────────── shared helpers ─────────────

  /** A database failure in our words: the migration's path when a table is missing, else "try again". */
  function fromDb(e) {
    if (e?.name !== 'DbError') return e;
    if (e.code === 'NOT_SET_UP') {
      log1('market_not_set_up', { hint: `run ${MARKET_MIGRATION}` });
      return notSetUp(`Run ${MARKET_MIGRATION} in Supabase → SQL Editor.`, `Run ${MARKET_MIGRATION} in Supabase → SQL Editor.`);
    }
    log1('market_db_failed', { code: e.code });
    return fail(503, 'UNAVAILABLE', 'Couldn’t reach the database. Try again shortly.');
  }

  /** The seller's public-files names (one Storage list call). */
  async function imagesOf(uid) {
    let res;
    try {
      res = await fetch(`${supabaseBase}/storage/v1/object/list/${PUBLIC_FILES_BUCKET}`, { method: 'POST', headers: { ...serviceHeaders(secretKey), 'content-type': 'application/json' }, body: JSON.stringify({ prefix: `${uid}/`, limit: 1000, offset: 0 }), signal: AbortSignal.timeout(10_000) });
    } catch {
      throw fail(503, 'UNAVAILABLE', 'Couldn’t check your images just now. Try again shortly.');
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      if (/bucket not found/i.test(text)) return new Set();
      throw fail(503, 'UNAVAILABLE', 'Couldn’t check your images just now. Try again shortly.');
    }
    let items = [];
    try {
      items = JSON.parse(text);
    } catch {
      items = [];
    }
    return new Set((Array.isArray(items) ? items : []).filter((i) => i?.id != null && typeof i.name === 'string').map((i) => i.name));
  }

  /** Remove listing images nothing references any more (best effort). */
  async function removeImages(paths) {
    if (!paths.length) return;
    try {
      await fetch(`${supabaseBase}/storage/v1/object/${PUBLIC_FILES_BUCKET}`, { method: 'DELETE', headers: { ...serviceHeaders(secretKey), 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: paths }), signal: AbortSignal.timeout(10_000) });
    } catch {
      log1('market_image_cleanup_failed', {});
    }
  }

  // ───────────── public pages ─────────────

  function write(req, res, status, headers, body = '') {
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(status, { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', ...headers, 'content-length': buf.length });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }
  /** A plain notice page (no script, no-store, noindex). back: '/market/<slug>' (a checked slug) or ''. */
  const notice = (req, res, status, title, text, { back = '', ...extra } = {}) => write(req, res, status, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': NOTICE_CSP, 'cache-control': 'no-store', 'x-robots-tag': 'noindex', ...extra }, leadNotice(title, text, back));
  const notFound = (req, res) => notice(req, res, 404, 'Page not found', 'This page doesn’t exist, or it’s no longer published.');
  const gone = (req, res) => notice(req, res, 410, 'No longer listed', 'This listing is no longer on the marketplace.');
  const busy = (req, res) => notice(req, res, 503, 'This can’t be shown right now', 'Try again in a minute.', { 'retry-after': '60' });

  /** A page with its ETag (304 when the visitor has it). */
  function html(req, res, body, { cache, robots = null }) {
    const etag = `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
    const headers = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': cache, etag, ...(robots ? { 'x-robots-tag': robots } : {}) };
    const inm = String(req.headers['if-none-match'] ?? '').slice(0, 400);
    if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) {
      res.writeHead(304, { 'x-content-type-options': 'nosniff', etag, 'cache-control': cache });
      return res.end();
    }
    return write(req, res, 200, headers, body);
  }

  /** How a row is served now (the seller's plan and the account's deletion included). */
  async function serving(row) {
    if (!row) return 'missing';
    const until = await store.serveUntil(row.user_id);
    return statusOf(row, { blocked: blocked.has(row.user_id), serveUntil: until, now: now() });
  }

  /** The Buy button's state from the offer as it is now (cached 60 s). */
  async function offerState(row, client) {
    if (!row.offer_id) return { state: 'none', test: false };
    const o = await store.offer(row.offer_id, client);
    if (!o || o.user_id !== row.user_id || ['archived', 'draft'].includes(o.status)) return { state: 'none', test: false };
    return { state: o.status === 'active' ? 'active' : 'paused', test: o.provider_ref?.environment === 'sandbox' };
  }

  async function gridPage(req, res, url, client) {
    const origin = appOrigin(env, req);
    const rawPage = url.searchParams.get('page');
    const pageNo = rawPage === null ? 1 : /^\d{1,3}$/.test(rawPage) ? Number(rawPage) : 0;
    if (pageNo < 1 || pageNo > MAX_PAGE) return notFound(req, res);
    const q = normalizeQuery(url.searchParams.get('q') ?? '').slice(0, 80).trim();
    const catParam = url.searchParams.get('category');
    const categories = await store.categories(client);
    let category = null;
    if (catParam !== null && catParam !== '') {
      if (!CATEGORY_SLUG_RE.test(catParam)) return notFound(req, res);
      category = categories.find((c) => c.slug === catParam) ?? null;
      if (!category) return notFound(req, res);
    }
    const got = q ? await store.search({ q, page: pageNo }, client) : await store.grid({ category: category?.slug ?? null, page: pageNo }, client);
    // sellers whose plan ended more than 30 days ago, or whose account is being deleted, are off the grid
    const rows = [];
    for (const r of got.rows) if (!blocked.has(r.user_id) && (await serving({ ...r, status: 'live' })) === 'live') rows.push(r);
    if (pageNo > 1 && !got.rows.length) return notFound(req, res);
    let robots = 'index, follow';
    if (q || !rows.length || (category && category.count < 3)) robots = 'noindex, follow';
    const canonical = `${origin}${q ? '/market' : gridPath({ category: category?.slug, page: pageNo })}`;
    const body = gridHtml({ origin, imageUrl, rows, categories, category, q, page: pageNo, hasNext: got.hasNext, robots, canonical });
    return html(req, res, body, { cache: q ? 'public, max-age=30' : 'public, max-age=60, stale-while-revalidate=300', robots: robots.startsWith('noindex') ? 'noindex' : null });
  }

  async function listingPage(req, res, slug, client) {
    const row = await store.bySlug(slug, client);
    const st = await serving(row);
    if (st === 'missing') return notFound(req, res);
    if (st === 'gone') return gone(req, res);
    const origin = appOrigin(env, req);
    const offer = await offerState(row, client);
    const robots = st === 'live' ? 'index, follow' : 'noindex, follow';
    return html(req, res, listingHtml(row, { origin, imageUrl, offer, robots }), { cache: 'public, max-age=60, stale-while-revalidate=300', robots: st === 'live' ? null : 'noindex' });
  }

  const formPage = (req, res, status, row, problem = '') => write(req, res, status, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' }, reportFormHtml(row, { origin: appOrigin(env, req), token: makeFormToken(cfg.reportSecret, row.slug, now()), problem }));

  async function reportPage(req, res, slug, client) {
    const row = await store.bySlug(slug, client);
    const st = await serving(row);
    if (st === 'missing') {
      drain(req);
      return notFound(req, res);
    }
    if (st === 'gone') {
      drain(req);
      return gone(req, res);
    }
    if (req.method !== 'POST') return formPage(req, res, 200, row);
    const back = { back: `/market/${row.slug}` };
    if (perVisitor.full(client) || perListing.full(row.id) || allReports.full('all')) {
      drain(req);
      return notice(req, res, 429, 'Please wait a little', 'Too many reports were sent just now. Try again later.', back);
    }
    perVisitor.hit(client);
    perListing.hit(row.id);
    allReports.hit('all');
    let form;
    try {
      form = await readForm(req);
    } catch (e) {
      return notice(req, res, e?.status === 413 ? 413 : 400, 'This form couldn’t be read', 'Go back and try again.', back);
    }
    const thanks = () => notice(req, res, 200, 'Thanks, we’ll take a look', 'Your report was sent to Your Local Business.', back);
    // a bot filled the hidden field: the same answer, nothing kept
    if (String(form.get('website') ?? '') !== '') return thanks();
    if (!checkFormToken(cfg.reportSecret, row.slug, form.get('t'), now())) return formPage(req, res, 400, row, 'Please send the form again.');
    const reason = String(form.get('reason') ?? '');
    if (!REPORT_REASONS.includes(reason)) return formPage(req, res, 400, row, 'Choose what’s wrong with this listing.');
    if (String(form.get('note') ?? '').length > 2000) return formPage(req, res, 400, row, 'Keep the note to 500 characters.');
    await reports.file(row, { reason, note: cleanNote(form.get('note')), hash: reporterHash(cfg.reportSecret, 'v', client), kind: 'visitor' });
    return thanks();
  }

  const publicRoutes = {
    /** Whether this path is the market's (the app's host only). */
    match: (url) => url.pathname === '/market' || url.pathname.startsWith('/market/'),
    async handle(req, res, url) {
      const p = url.pathname;
      if (!enabled) {
        drain(req);
        return notFound(req, res);
      }
      const m = p.length <= 120 ? PUBLIC_PATH.exec(p) : null;
      const isReport = !!m && m[2] === '/report' && !m[3];
      if (req.method !== 'GET' && req.method !== 'HEAD' && !(req.method === 'POST' && isReport)) {
        drain(req);
        return write(req, res, 405, { 'content-type': 'text/plain; charset=utf-8', allow: isReport ? 'GET, HEAD, POST' : 'GET, HEAD', 'cache-control': 'no-store' }, 'Method not allowed');
      }
      if (!m) return notFound(req, res);
      const [, slug, tail, trailing] = m;
      const qs = url.search && url.search.length <= 300 ? url.search : '';
      // /market/ → /market, /market/<slug>/ → /market/<slug>
      if (!slug && trailing) return write(req, res, 301, { location: `/market${qs}`, 'cache-control': 'public, max-age=3600' });
      if (slug && !SLUG_RE.test(slug)) return notFound(req, res);
      if (slug && tail === '/' && !trailing) return write(req, res, 301, { location: `/market/${slug}`, 'cache-control': 'public, max-age=3600' });
      if (trailing) return notFound(req, res);
      const client = visitor(req);
      try {
        if (!slug) return await gridPage(req, res, url, client);
        if (tail === '/report') return await reportPage(req, res, slug, client);
        return await listingPage(req, res, slug, client);
      } catch (e) {
        if (res.headersSent) return res.destroy();
        if (e?.code === 'BUSY') return busy(req, res);
        if (e?.name === 'DbError' && e.code === 'NOT_SET_UP') log1('market_not_set_up', { hint: `run ${MARKET_MIGRATION}` });
        else log1('market_page_failed', { error: e?.name || 'Error', code: e?.code });
        return busy(req, res);
      }
    },
  };

  if (!enabled) {
    return {
      enabled: false,
      publicRoutes,
      config,
      notes,
      cronJobs: () => [],
      sitemapRows: async () => [],
      setSitemap: (s) => {
        sitemap = s;
      },
      onChanged: async () => {},
      async handle(req, res, url) {
        const p = url.pathname;
        if (p !== ROUTE_PREFIXES.market && !p.startsWith(`${ROUTE_PREFIXES.market}/`)) return false;
        drain(req);
        send(res, 503, { error: 'The public marketplace isn’t set up on this app yet.', code: 'NOT_SET_UP' }, { ...corsHeaders(req), 'cache-control': 'no-store' });
        return true;
      },
      async forgetUser() {},
      async unforgetUser() {},
    };
  }

  // ───────────── seller and owner API ─────────────

  const reply = (req, res, status, body, extra = {}) => send(res, status, body, { ...corsHeaders(req), 'cache-control': 'no-store', ...extra });

  async function user(req, res) {
    if (!sameOrigin(req)) {
      drain(req);
      reply(req, res, 403, { error: 'Cross-site request refused.', code: 'FORBIDDEN' });
      return null;
    }
    let who = null;
    try {
      who = await auth.identify(req);
    } catch {
      drain(req);
      reply(req, res, 503, { error: 'Couldn’t check your sign-in. Try again shortly.', code: 'UNAVAILABLE' });
      return null;
    }
    if (!who?.id || !isUuid(who.id)) {
      drain(req);
      reply(req, res, 401, { error: 'Sign in first.', code: 'AUTH_REQUIRED' });
      return null;
    }
    return who;
  }

  async function body(req) {
    let b;
    try {
      b = await readJson(req, MAX_JSON);
    } catch (e) {
      throw e?.status === 413 ? fail(413, 'BAD_REQUEST', 'Request too large.') : fail(400, 'BAD_REQUEST', 'That request isn’t valid JSON.');
    }
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw fail(400, 'BAD_REQUEST', 'Send a JSON object.');
    return b;
  }

  const limited = (bucket, who) => {
    if (limit(bucket, who)) throw fail(429, 'RATE_LIMITED', 'Too many requests. Try again in a minute.');
  };
  const notBlocked = (who) => {
    if (blocked.has(who.id)) throw fail(409, 'ACCOUNT_DELETING', 'This account is being deleted.');
  };

  /** The plan: active (402 otherwise) and its public-listing limit (null: unlimited) and whether it is a card trial. */
  async function planFor(who) {
    let ent = null;
    if (billing?.requireActive) {
      try {
        ent = await billing.requireActive(who, 'publicListings');
      } catch (e) {
        if (e?.status === 402) throw fail(402, e.code, e.message, { need: e.extra?.need ?? null, upgrade: '#plans' });
        throw fail(503, 'UNAVAILABLE', 'Couldn’t check your plan just now. Try again in a minute.');
      }
    }
    if (!ent && billing?.entitlement) {
      try {
        ent = await billing.entitlement(who.id, who);
      } catch {
        throw fail(503, 'UNAVAILABLE', 'Couldn’t check your plan just now. Try again in a minute.');
      }
    }
    const lim = ent?.features?.publicListings;
    return { limit: lim === undefined || lim === null ? null : Number(lim), trial: ent?.trial === true, ent };
  }

  /** What the seller sees of a row. */
  const stateOf = (row, origin) => ({
    listingId: row.listing_id,
    projectId: row.project_id,
    slug: row.slug,
    url: `${origin}/market/${row.slug}`,
    status: row.status,
    indexable: row.status === 'live',
    missing: Array.isArray(row.quality?.missing) ? row.quality.missing : [],
    reportCount: Number(row.report_count) || 0,
    ...(row.hidden_reason ? { hiddenReason: row.hidden_reason } : {}),
    publicAt: row.public_at ?? null,
    contentUpdatedAt: row.content_updated_at ?? null,
  });

  async function listMine(who, url, origin) {
    const projectId = url.searchParams.get('projectId');
    if (projectId !== null && !PROJECT_ID_RE.test(projectId)) throw fail(400, 'BAD_REQUEST', 'Unknown business.');
    const rows = await db.select('public_listings', { user_id: who.id, ...(projectId ? { project_id: projectId } : {}) }, { select: 'listing_id,project_id,slug,status,quality,report_count,hidden_reason,public_at,content_updated_at', order: 'public_at.asc', limit: 500 });
    const all = projectId ? await db.select('public_listings', { user_id: who.id, status: ['in', ['live', 'thin', 'held']] }, { select: 'id', limit: 500 }) : rows.filter((r) => ['live', 'thin', 'held'].includes(r.status));
    let lim = null;
    try {
      lim = billing?.entitlement ? ((await billing.entitlement(who.id, who))?.features?.publicListings ?? null) : null;
    } catch {
      lim = null;
    }
    return { listings: rows.map((r) => stateOf(r, origin)), limit: lim, used: all.length, appUrl: origin };
  }

  async function putPublic(who, listingId, b, origin) {
    notBlocked(who);
    const plan = await planFor(who);
    let offerRow = null;
    const fields = await validatePublicListing(b, {
      uid: who.id,
      offerOf: async (id) => {
        const [o] = await db.select('offers', { id, user_id: who.id }, { select: 'id,user_id,status,provider,price_minor,currency', limit: 1 });
        offerRow = o ?? null;
        return offerRow;
      },
      imagesOf: () => imagesOf(who.id),
    });
    const [existing] = await db.select('public_listings', { user_id: who.id, listing_id: listingId }, { select: 'id,slug,status,hidden_at,cover_path,gallery_paths', limit: 1 });
    if (existing?.hidden_at) throw fail(409, 'HIDDEN', 'Your Local Business hid this listing from the web, so it can’t go back on.');
    const [dupe] = await db.select('public_listings', { content_hash: fields.content_hash, status: 'live', user_id: ['neq', who.id] }, { select: 'id', limit: 1 });
    const quality = qualityOf(fields, { offer: offerRow, duplicate: !!dupe, trial: plan.trial });
    const row = { ...fields, quality, status: publicStatus(quality) };
    let got = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const slug = existing?.slug ?? slugFor(fields.title);
      try {
        got = await db.rpc('ylb_market_set_public', { p_user: who.id, p_listing_id: listingId, p_limit: plan.limit, p_new_per_day: cfg.newPerDay, p_row: { ...row, slug } });
        break;
      } catch (e) {
        // another listing has this address: pick another (nothing has gone public yet)
        if (e?.code === 'CONFLICT' && !existing && attempt < 3) continue;
        throw e;
      }
    }
    if (!got?.ok) {
      if (got?.code === 'HIDDEN') throw fail(409, 'HIDDEN', 'Your Local Business hid this listing from the web, so it can’t go back on.');
      if (got?.code === 'DAILY') throw fail(429, 'RATE_LIMITED', `You can put up to ${cfg.newPerDay} new listings on the web a day.`);
      if (got?.code === 'LIMIT') throw fail(409, 'LIMIT', `Your plan includes ${plan.limit} public listing${plan.limit === 1 ? '' : 's'}. Upgrade or turn one off.`, { used: Number(got.used) || 0, limit: plan.limit, upgrade: '#plans' });
      throw fail(503, 'UNAVAILABLE', 'Couldn’t save that just now. Try again shortly.');
    }
    const saved = got.row;
    // images the row held before and doesn't any more
    if (existing) {
      const keep = new Set([saved.cover_path, ...(saved.gallery_paths ?? [])].filter(Boolean));
      await removeImages([existing.cover_path, ...(existing.gallery_paths ?? [])].filter((p) => p && !keep.has(p) && p.startsWith(`${who.id}/l-`)));
    }
    await onChanged(saved.slug);
    return { status: existing ? 200 : 201, body: { listing: stateOf(saved, origin) } };
  }

  async function unlist(who, listingId) {
    const [row] = await db.select('public_listings', { user_id: who.id, listing_id: listingId }, { select: 'id,slug,status,unlisted_at', limit: 1 });
    if (!row || row.unlisted_at) return { ok: true };
    await db.update('public_listings', { id: row.id, user_id: who.id }, { unlisted_at: new Date(now()).toISOString(), ...(row.status === 'hidden' ? {} : { status: 'unlisted' }) });
    await onChanged(row.slug);
    return { ok: true };
  }

  async function userReport(who, b) {
    const slug = String(b.slug ?? '');
    if (!SLUG_RE.test(slug)) throw fail(404, 'NOT_FOUND', 'That listing isn’t on the web.');
    const row = await store.bySlug(slug);
    const st = await serving(row);
    if (st === 'missing' || st === 'gone') throw fail(404, 'NOT_FOUND', 'That listing isn’t on the web.');
    if (row.user_id === who.id) throw fail(400, 'BAD_REQUEST', 'You can’t report your own listing.');
    if (!REPORT_REASONS.includes(b.reason)) throw fail(400, 'BAD_REQUEST', 'Choose a reason.');
    if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 2000)) throw fail(400, 'BAD_REQUEST', 'Keep the note to 500 characters.');
    await reports.file(row, { reason: b.reason, note: cleanNote(b.note), hash: reporterHash(cfg.reportSecret, 'u', who.id), kind: 'user' });
    return { ok: true };
  }

  async function routeAdmin(req, res, url, who) {
    if (who.isAdmin !== true) throw fail(403, 'FORBIDDEN', 'Only the app’s owner can see this.');
    limited('market-admin', who.id);
    const p = url.pathname;
    if (p === `${ROUTE_PREFIXES.market}/admin` && req.method === 'GET') {
      await submitter.rememberOwner(who.id);
      const view = await reports.adminView();
      let alert = null;
      try {
        alert = (await treg?.alert?.()) ?? null;
      } catch {
        alert = null;
      }
      return reply(req, res, 200, { ...view, submit: await submitter.state(), alert });
    }
    if (p === `${ROUTE_PREFIXES.market}/admin/submit-sitemap` && req.method === 'POST') {
      const b = await body(req);
      if (b.confirm !== true) throw fail(400, 'BAD_REQUEST', 'Confirm first.');
      if (treg?.stub) throw notSetUp('The treg wrapper isn’t built into this copy of the app.', 'Sending the sitemap to Google isn’t available yet.');
      await submitter.rememberOwner(who.id);
      return reply(req, res, 200, await submitter.submit(who.id, { trigger: 'owner' }));
    }
    const m = /^\/api\/market\/admin\/(listings|reports)\/([^/]{1,64})\/(hide|unhide|dismiss)$/.exec(p.length <= 160 ? p : '');
    if (!m || req.method !== 'POST') throw fail(404, 'NOT_FOUND', 'Not found.');
    const [, kind, id, action] = m;
    if (!isUuid(id)) throw fail(404, 'NOT_FOUND', 'Not found.');
    if (kind === 'listings' && action === 'hide') {
      const b = await body(req);
      return reply(req, res, 200, await reports.hide(id, { reason: b.reason, note: b.note }));
    }
    if (kind === 'listings' && action === 'unhide') {
      drain(req);
      return reply(req, res, 200, await reports.unhide(id));
    }
    if (kind === 'reports' && action === 'dismiss') {
      drain(req);
      return reply(req, res, 200, await reports.dismiss(id));
    }
    throw fail(404, 'NOT_FOUND', 'Not found.');
  }

  async function route(req, res, url, who) {
    const p = url.pathname;
    const origin = appOrigin(env, req);
    if (p === `${ROUTE_PREFIXES.market}/admin` || p.startsWith(`${ROUTE_PREFIXES.market}/admin/`)) return routeAdmin(req, res, url, who);
    if (p === `${ROUTE_PREFIXES.market}/reports`) {
      if (req.method !== 'POST') throw fail(405, 'BAD_REQUEST', 'Method not allowed.');
      limited('market-report', who.id);
      notBlocked(who);
      return reply(req, res, 200, await userReport(who, await body(req)));
    }
    if (p === `${ROUTE_PREFIXES.market}/public`) {
      if (req.method !== 'GET') throw fail(405, 'BAD_REQUEST', 'Method not allowed.');
      limited('market-read', who.id);
      return reply(req, res, 200, await listMine(who, url, origin));
    }
    const m = /^\/api\/market\/public\/([^/]{1,80})$/.exec(p.length <= 140 ? p : '');
    if (!m) throw fail(404, 'NOT_FOUND', 'Not found.');
    const listingId = m[1];
    if (!LISTING_ID_RE.test(listingId)) throw fail(404, 'NOT_FOUND', 'Not found.');
    limited('market-write', who.id);
    if (req.method === 'PUT') {
      const got = await putPublic(who, listingId, await body(req), origin);
      return reply(req, res, got.status, got.body);
    }
    if (req.method === 'DELETE') {
      drain(req);
      return reply(req, res, 200, await unlist(who, listingId));
    }
    throw fail(405, 'BAD_REQUEST', 'Method not allowed.');
  }

  // ───────────── cron ─────────────

  /**
   * The daily sweep: plans over their limit after a downgrade (the earliest public listings stay, the rest become
   * over_limit), quality again (offers archived or paused, a trial that became paid, duplicates), and unlisted rows
   * older than 180 days deleted. Counts only in the logs.
   */
  async function sweep() {
    const rows = await db.select('public_listings', { status: ['in', ['live', 'thin', 'held']] }, { select: 'id,user_id,slug,status,public_at,held_at,title,description,cover_path,category,tags,offer_id,outside_buy_url,website,phone,price_minor,price_model,content_hash,quality', order: 'public_at.asc', limit: 10_000 });
    const byUser = new Map();
    for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
    let changed = false;
    const ents = new Map();
    for (const userId of byUser.keys()) {
      try {
        ents.set(userId, billing?.entitlement ? await billing.entitlement(userId) : null);
      } catch {
        ents.set(userId, undefined);
      }
    }
    // 1. over the plan's limit
    const over = new Set();
    for (const [userId, list] of byUser) {
      const ent = ents.get(userId);
      const lim = ent === undefined ? null : ent?.features?.publicListings ?? null;
      if (lim === null || list.length <= lim) continue;
      const extra = list.slice(lim);
      for (const r of extra) over.add(r.id);
      await db.update('public_listings', { id: ['in', extra.map((r) => r.id)] }, { status: 'over_limit' });
      log1('market_over_limit', { count: extra.length });
      changed = true;
    }
    // 2. quality again
    const offerIds = [...new Set(rows.filter((r) => r.offer_id).map((r) => r.offer_id))];
    const offers = new Map();
    for (let i = 0; i < offerIds.length; i += 200) for (const o of await db.select('offers', { id: ['in', offerIds.slice(i, i + 200)] }, { select: 'id,user_id,status', limit: 200 })) offers.set(o.id, o);
    const liveHashes = new Map();
    for (const r of rows) if (r.status === 'live' && !over.has(r.id)) liveHashes.set(r.content_hash, new Set([...(liveHashes.get(r.content_hash) ?? []), r.user_id]));
    for (const r of rows) {
      if (over.has(r.id) || r.status === 'held') continue;
      const offer = offers.get(r.offer_id);
      const ent = ents.get(r.user_id);
      const others = [...(liveHashes.get(r.content_hash) ?? [])].filter((u) => u !== r.user_id);
      // a duplicate stays flagged only if it was one already (the first seller to go live keeps theirs)
      const duplicate = others.length > 0 && (r.status !== 'live' || (r.quality?.missing ?? []).includes('duplicate'));
      const q = qualityOf(r, { offer: offer && offer.user_id === r.user_id ? offer : null, duplicate, trial: ent === undefined ? (r.quality?.missing ?? []).includes('trial') : ent?.trial === true });
      const status = publicStatus(q);
      if (status !== r.status || JSON.stringify(q.missing) !== JSON.stringify(r.quality?.missing ?? [])) {
        await db.update('public_listings', { id: r.id, status: r.status }, { quality: q, status });
        changed = true;
      }
    }
    // 3. unlisted long ago
    const cutoff = new Date(now() - UNLISTED_KEEP_MS).toISOString();
    const removed = await db.remove('public_listings', { status: 'unlisted', unlisted_at: ['lt', cutoff] }, { returning: true });
    if (removed.length) log1('market_unlisted_removed', { count: removed.length });
    if (changed) await onChanged();
    return { overLimit: over.size, removed: removed.length };
  }

  /** The sitemap's market rows: live listings whose seller's plan still serves. */
  async function sitemapRows() {
    const out = [];
    for (let offset = 0; offset < 50_000; offset += 1000) {
      const page = await db.select('public_listings', { status: 'live' }, { select: 'slug,category_slug,content_updated_at,user_id', order: 'slug.asc', limit: 1000, offset });
      for (const r of page) if (!blocked.has(r.user_id) && (await serving({ ...r, status: 'live' })) === 'live') out.push({ slug: r.slug, category_slug: r.category_slug, content_updated_at: r.content_updated_at });
      if (page.length < 1000) break;
    }
    return out;
  }

  return {
    enabled: true,
    publicRoutes,
    config,
    notes,
    sitemapRows,
    onChanged,
    /** the sitemap module (its cache is dropped with ours) */
    setSitemap: (s) => {
      sitemap = s;
    },
    /** for tests */
    store,
    reports,
    submitter,
    sweep,

    async handle(req, res, url) {
      const p = url.pathname;
      if (p !== ROUTE_PREFIXES.market && !p.startsWith(`${ROUTE_PREFIXES.market}/`)) return false;
      const who = await user(req, res);
      if (!who) return true;
      try {
        await route(req, res, url, who);
      } catch (e) {
        const mapped = fromDb(e);
        if (!mapped?.code) log1('market_error', { error: e?.name || 'Error' });
        if (res.headersSent) return true;
        drain(req);
        const { status, body: b } = errorBody(mapped, who);
        reply(req, res, status, b);
      }
      return true;
    },

    cronJobs: () => [
      { name: 'market-sweep', dailyAtUtc: '04:20', run: () => sweep() },
      { name: 'market-sitemap-submit', dailyAtUtc: '05:40', run: () => submitter.cron() },
    ],

    /** Before an account is deleted: its listings answer 410 on this copy at once (the rows go with the account). */
    async forgetUser(userId) {
      blocked.add(userId);
      store.dropUser(userId);
      sitemap?.clearCache?.();
    },
    async unforgetUser(userId) {
      blocked.delete(userId);
      store.dropUser(userId);
    },
  };
}

