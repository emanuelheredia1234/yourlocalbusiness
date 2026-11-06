// /b/<id> and /b/<id>/done for visitors: a business's permanent buy link. On the app's host and on the owner's own
// verified domains (only that owner's offers there; anyone else's is "not found", like /m/).
//
// - GET and HEAD only (405 otherwise). The query string is never read or copied anywhere.
// - Limits per visitor (OFFER_CLICKS_PER_IP_PER_HOUR, 60) and per offer (OFFER_CLICKS_PER_OFFER_PER_HOUR, 3000), in
//   memory; the row lookup is cached 60 s (a miss 30 s) and budgeted per client and in all, like the lead magnets.
//   A lookup that fails is a 503 notice, never a redirect.
// - Missing, a draft, or another owner's on a domain: "not found". Archived: 410 "no longer available". Paused, a
//   link Whop didn't confirm, or a Whop account that isn't connected: 503 "isn't available to buy right now" (never
//   which provider or why). The owner's plan ended more than 30 days ago: the pages' "gone".
// - The redirect goes only where server/offers/providers.mjs allows for the offer's provider, checked again on every
//   click: a Whop offer's stored checkout link on whop.com / sandbox.whop.com; an outside link on a known checkout
//   site (elsewhere: a "you're leaving" page on the app's host, a redirect only on the owner's domain).
// - A GET that isn't a prefetch counts one click (offer_clicked); a failed count never blocks the buyer.
// - /b/<id>/done is where Whop sends the buyer back: a thank-you page with no script. It reads nothing from the query
//   (Whop adds its own) and never says the payment went through: only the webhook knows that.

import { drain, escapeHtml, leadNotice, NOTICE_CSP, visitorOf, windowCounter } from '../leads.mjs';
import { PROVIDERS } from './providers.mjs';

const BUY_PATH = /^\/b\/([A-Za-z0-9_-]{22})(\/done)?$/;
const MAX_PATH = 30;
const LOOKUP_TIMEOUT = 5000;
/** Clicks per visitor per hour and per offer per hour (memory only, per server copy). */
export const OFFER_LIMITS = Object.freeze({ perIp: 60, perOffer: 3000, windowMs: 3_600_000 });
const LOOKUP_BUDGET = { perMin: 600, perClient: 60 };
const PUBLIC_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex', 'cache-control': 'no-store' };

/** OFFER_CLICKS_PER_IP_PER_HOUR and OFFER_CLICKS_PER_OFFER_PER_HOUR (whole numbers from 1). */
export function offerLimitsFromEnv(env = process.env) {
  const count = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
  };
  return { perIp: count(env.OFFER_CLICKS_PER_IP_PER_HOUR, OFFER_LIMITS.perIp), perOffer: count(env.OFFER_CLICKS_PER_OFFER_PER_HOUR, OFFER_LIMITS.perOffer), windowMs: OFFER_LIMITS.windowMs };
}

const prefetch = (req) => /prefetch/i.test(`${String(req.headers['sec-purpose'] ?? '').slice(0, 100)} ${String(req.headers.purpose ?? '').slice(0, 100)} ${String(req.headers['x-moz'] ?? '').slice(0, 100)}`);

/**
 * db (server/integrations/db.mjs); billing (pagesServeUntil); limits (OFFER_LIMITS); enabled: offers are on (else
 * every /b/ is "not found"); log.
 */
export function createBuy({ db, billing = null, limits = OFFER_LIMITS, enabled = true, log = console, now = () => Date.now() }) {
  const lim = { ...OFFER_LIMITS, ...(limits || {}) };
  const perIp = windowCounter(lim.perIp, lim.windowMs);
  const perOffer = windowCounter(lim.perOffer, lim.windowMs);
  const cache = new Map(); // id → { value: { row, conn } | null, until }
  const MAX_CACHED = 5000;
  const blocked = new Set(); // users being deleted: their offers stop at once on this copy
  const inflight = new Map();
  let budgetStart = 0;
  let budgetAll = 0;
  const budgetClients = new Map();
  let warnedAt = 0;
  const warn = (line) => {
    if (now() - warnedAt < 60_000) return;
    warnedAt = now();
    log.warn?.(line);
  };

  const takeLookup = (client) => {
    const t = now();
    if (t - budgetStart >= 60_000) {
      budgetStart = t;
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

  const timed = (p) => {
    let timer;
    return Promise.race([p, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), LOOKUP_TIMEOUT)))]).finally(() => clearTimeout(timer));
  };

  /** The offer and (for Whop) its connection's status, cached; throws when it can't be looked up now. */
  async function find(id, client) {
    const hit = cache.get(id);
    if (hit && hit.until > now()) return hit.value;
    if (inflight.has(id)) return inflight.get(id);
    if (!takeLookup(client)) throw Object.assign(new Error('busy'), { code: 'BUSY' });
    const p = (async () => {
      let rows;
      try {
        rows = await timed(db.select('offers', { id }, { select: 'id,user_id,project_id,title,provider,connection_id,provider_ref,status', limit: 1 }));
      } catch (e) {
        // the migration wasn't run: there are no offers
        if (e?.code === 'NOT_SET_UP') return null;
        throw e;
      }
      const row = rows?.[0] ?? null;
      let conn = null;
      if (row?.provider === 'whop' && row.connection_id) {
        const [c] = await timed(db.select('payment_connections', { id: row.connection_id }, { select: 'id,user_id,status,environment,account_id', limit: 1 }));
        conn = c ?? null;
      }
      const value = row ? { row, conn } : null;
      cache.delete(id);
      cache.set(id, { value, until: now() + (row ? 60_000 : 30_000) });
      while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
      return value;
    })().finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  }

  const matchBuy = (url) => url.pathname.length <= MAX_PATH && BUY_PATH.test(url.pathname);

  function write(req, res, status, hdrs, body = '') {
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(status, { ...PUBLIC_HEADERS, ...hdrs, 'content-length': buf.length });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }
  const notice = (req, res, status, title, words, extra = {}) => write(req, res, status, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': NOTICE_CSP, ...extra }, leadNotice(title, words, ''));
  const retryAfter = (ms) => ({ 'retry-after': String(Math.max(1, Math.ceil(ms / 1000))) });
  const NOT_NOW = [503, 'Not available right now', 'This isn’t available to buy right now. Try again later.'];

  /** A link to another site on the app's host: a page that names it and links there (no script, no referrer). */
  function leavePage(row, href) {
    const host = escapeHtml(new URL(href).host);
    const title = escapeHtml(row.title || 'Checkout');
    return leadNotice(title, `This checkout is on another website: <strong>${host}</strong>.</p>\n<p class="back"><a href="${escapeHtml(href)}" rel="noopener noreferrer">Continue to ${host}</a>`, '');
  }

  async function counted(id) {
    try {
      await timed(db.rpc('offer_clicked', { p_id: id }));
    } catch (e) {
      warn(`Offers: couldn’t count a buy-link click (${e?.code || 'error'}).`);
    }
  }

  /**
   * /b/<id>[/done] on the app's host, or (site: the verified domain's row) on the owner's own domain.
   * pages: { notFound(req, res), gone(req, res), visitor(req) } (pages.mjs's).
   */
  async function serveBuy(req, res, url, site = null, { notFound, gone, visitor = visitorOf } = {}) {
    const m = enabled && url.pathname.length <= MAX_PATH ? BUY_PATH.exec(url.pathname) : null;
    if (!m) return notFound(req, res);
    const [, id, done] = m;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      drain(req);
      return write(req, res, 405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }, 'Method not allowed');
    }
    try {
      // the visitor as pages.mjs counts them (TRUSTED_PROXY_HOPS)
      const who = visitor(req);
      if (perIp.full(who)) return notice(req, res, 429, 'Please wait a little', 'This was asked for a lot just now. Try again later.', retryAfter(perIp.wait(who)));
      perIp.hit(who);
      let found;
      try {
        found = await find(id, who);
      } catch {
        return notice(req, res, 503, 'This can’t be shown right now', 'Try again in a minute.', retryAfter(60_000));
      }
      const row = found?.row;
      if (!row || row.status === 'draft' || blocked.has(row.user_id) || (site && row.user_id !== site.user_id)) return notFound(req, res);
      if (billing?.pagesServeUntil) {
        let until = null;
        try {
          until = await billing.pagesServeUntil(row.user_id);
        } catch {
          until = null;
        }
        if (until && Date.parse(until) < now()) return gone(req, res);
      }
      if (done) {
        const title = escapeHtml(row.title || 'Your order');
        return notice(req, res, 200, 'Thanks for your order', `Your receipt and access to ${title} come from the seller’s checkout by email.`);
      }
      if (row.status === 'archived') return notice(req, res, 410, 'No longer available', 'This offer is no longer available.');
      if (row.status !== 'active') return notice(req, res, ...NOT_NOW, retryAfter(3_600_000));
      if (row.provider === 'whop' && (!found.conn || found.conn.status !== 'active' || found.conn.user_id !== row.user_id)) return notice(req, res, ...NOT_NOW, retryAfter(3_600_000));
      if (perOffer.full(id)) return notice(req, res, 429, 'Please wait a little', 'This was asked for a lot just now. Try again later.', retryAfter(perOffer.wait(id)));
      perOffer.hit(id);
      const target = PROVIDERS[row.provider]?.checkoutTarget(row, { site }) ?? null;
      if (!target) {
        warn('Offers: a buy link’s checkout didn’t pass the checks, so it wasn’t followed.');
        return notice(req, res, ...NOT_NOW, retryAfter(3_600_000));
      }
      const counts = req.method === 'GET' && !prefetch(req);
      if (target.leave) {
        if (counts) await counted(id);
        return write(req, res, 200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': NOTICE_CSP }, leavePage(row, target.leave));
      }
      if (counts) await counted(id);
      res.writeHead(302, { ...PUBLIC_HEADERS, location: target.redirect, 'content-length': 0 });
      return res.end();
    } catch {
      if (!res.headersSent) notice(req, res, 503, 'This can’t be shown right now', 'Try again in a minute.', retryAfter(60_000));
    }
  }

  return {
    matchBuy,
    serveBuy,
    /** An offer changed or went: the next click looks it up again. */
    drop: (id) => cache.delete(id),
    /** A connection changed (disconnected, key rejected): its offers are looked up again. */
    dropConnection: (connId) => {
      for (const [id, e] of [...cache]) if (e.value?.row?.connection_id === connId) cache.delete(id);
    },
    forgetUser(userId) {
      blocked.add(userId);
      for (const [id, e] of [...cache]) if (e.value?.row?.user_id === userId) cache.delete(id);
    },
    unforgetUser(userId) {
      blocked.delete(userId);
    },
  };
}
