// Web research for Strategy: the options a request may ask for, which keys can search, and the
// sources each provider returns, normalized the same way for all of them. Pure: no I/O.
//
// Only functions marked "research": true in shared/ai-functions.json may ask (Strategy). The app's
// client checks every URL the model writes against the sources returned here (src/lib/strategy.ts
// has the same isHttpUrl and sourceKey rules), so a URL no search returned never counts as a source.

import { fnById, kindDef, modelDef } from './registry.mjs';

/** A research request may take this long (several searches, then reading the pages). */
export const RESEARCH_TIMEOUT_MS = 10 * 60_000;
/** Sources returned per request, at most. */
export const MAX_SOURCES = 30;
/** The most web searches a research request may ask for (Strategy offers 3, 5 or 8). */
export const MAX_SEARCHES = 8;
const MAX_URL = 2000;
/**
 * A source's URL is at most this long: the app keeps no longer one (STRATEGY_CAPS.sources.url in
 * src/lib/strategyNormalize.ts, the same 400), so a source it returns is never one the app drops.
 */
export const MAX_SOURCE_URL = 400;

/** Cut to `max` characters without leaving half of a surrogate pair at the end. */
function cut(s, max) {
  if (s.length <= max) return s;
  const out = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
}

/** One line of plain text: control characters and line breaks become spaces; at most `max` characters. */
export function line(v, max) {
  if (typeof v !== 'string') return '';
  return cut(
    v
      .slice(0, max * 4 + 64)
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    max,
  ).trim();
}

/**
 * Research options from a /api/ai/generate body: null for an ordinary request. Throws (status 400) when a
 * function that can't research asks for it. Only `web`, `maxSearches` and `location.city/region` are read:
 * clients can't choose domains, engines or tools.
 */
export function researchFromBody(b, fn) {
  const r = b?.research;
  if (r === undefined || r === null || r === false) return null;
  if (fnById[fn]?.research !== true) throw Object.assign(new Error('Web research isn’t available for this function.'), { status: 400, code: 'BAD_REQUEST' });
  if (!r || typeof r !== 'object' || Array.isArray(r) || r.web !== true) return null;
  const n = typeof r.maxSearches === 'number' && Number.isFinite(r.maxSearches) ? Math.round(r.maxSearches) : 5;
  const loc = r.location && typeof r.location === 'object' && !Array.isArray(r.location) ? r.location : null;
  const city = line(loc?.city, 80);
  const region = line(loc?.region, 80);
  return { maxSearches: Math.min(MAX_SEARCHES, Math.max(1, n)), location: city || region ? { city, region } : null };
}

/** Whether a key slot can search the web with this model (Google: not in v1, see the README). */
export function canResearch(providerId, model) {
  const r = kindDef(providerId, 'text')?.research;
  if (!r) return false;
  if (r.except && r.except.test(String(model ?? ''))) return false;
  return modelDef(providerId, 'text', model)?.research !== false;
}

/** The provider's list price per search (0 when it can't search). */
export const searchPrice = (providerId) => kindDef(providerId, 'text')?.research?.perSearch ?? 0;

/** What /api/health says about a key: { perSearch } when it can search with this model, else null. */
export const researchInfo = (providerId, model) => (canResearch(providerId, model) ? { perSearch: searchPrice(providerId) } : null);

/** `user_location` for the search tools that take one: city and region only (never a guessed country). */
export const userLocation = (loc) => ({ type: 'approximate', ...(loc?.city ? { city: loc.city } : {}), ...(loc?.region ? { region: loc.region } : {}) });

/** http(s), a host name with a dot, no user:password, at most 2,000 characters. */
export function isHttpUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL) return false;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.') && !u.username && !u.password;
}

/** A provider's URL string (trimmed, never rewritten) with its parsed form, or null when it isn't one to pass on. */
export function sourceUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  // a URL with a space or a control character inside isn't one a search engine returns; a longer one than the app keeps isn't passed on
  if (!isHttpUrl(s) || s.length > MAX_SOURCE_URL || /[\s\u0000-\u001f\u007f]/.test(s)) return null;
  return { raw: s, u: new URL(s) };
}

const TRACKING = /^(utm_[a-z]+|gclid|fbclid|mc_[a-z]+|ref_src)$/i;

/** The same page however it's written (scheme, www, trailing slash, tracking parameters and #hash ignored); '' when it isn't a URL. */
export function sourceKey(raw) {
  if (!isHttpUrl(raw)) return '';
  const u = new URL(raw);
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  return `${u.host.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
}

/** A host name for display: lowercased, without www. */
const domainOf = (u) => u.hostname.toLowerCase().replace(/^www\./, '');

/**
 * Sources a provider returned → numbered, de-duplicated sources: cited first (then in the order found),
 * at most 30, each URL at most 400 characters. Items: { url, title?, cited?, quote?, pageAge? }. The URL
 * string is kept as the provider sent it; numeric titles (xAI's citation numbers) become the domain. A
 * quote is only ever a provider's own cited text (Anthropic `cited_text`), never a snippet.
 */
export function normalizeSources(raw) {
  const byKey = new Map();
  for (const x of Array.isArray(raw) ? raw : []) {
    const ok = sourceUrl(x?.url);
    if (!ok) continue;
    const key = sourceKey(ok.raw);
    if (!key) continue;
    const s = byKey.get(key) ?? { url: ok.raw, title: '', domain: domainOf(ok.u), cited: false, quote: '', pageAge: '', order: byKey.size };
    const title = line(x.title, 160);
    if (!s.title && title && !/^\[?\d+\]?$/.test(title)) s.title = title;
    if (x.cited === true) s.cited = true;
    if (!s.quote && typeof x.quote === 'string') s.quote = line(x.quote, 200);
    if (!s.pageAge && typeof x.pageAge === 'string') s.pageAge = line(x.pageAge, 40);
    byKey.set(key, s);
  }
  return [...byKey.values()]
    .sort((a, b) => Number(b.cited) - Number(a.cited) || a.order - b.order)
    .slice(0, MAX_SOURCES)
    .map((s, i) => ({
      n: i + 1,
      url: s.url,
      title: s.title || s.domain,
      domain: s.domain,
      cited: s.cited,
      ...(s.quote ? { quote: s.quote } : {}),
      ...(s.pageAge ? { pageAge: s.pageAge } : {}),
    }));
}

/** Short, distinct, one-line strings. */
const distinct = (list, max, n) => [...new Set((Array.isArray(list) ? list : []).map((v) => line(v, max)).filter(Boolean))].slice(0, n);

/**
 * `meta.research` for a reply to a research request. used: the key that answered was asked to search;
 * raw: the adapter's `research` ({ searches, sources, queries, errors, refused? }).
 * `web` is true only when it searched successfully at least once and at least one source came back.
 */
export function researchMeta(used, raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const searches = Math.min(50, Math.max(0, Math.round(Number(r.searches) || 0)));
  const errors = distinct(r.errors, 40, 5);
  const sources = used && !r.refused ? normalizeSources(r.sources) : [];
  const web = !!used && !r.refused && searches > 0 && sources.length > 0;
  const reason = web
    ? ''
    : !used
      ? 'unsupported'
      : r.refused
        ? 'provider_refused'
        : searches === 0 && errors.length
          ? 'search_failed'
          : searches === 0
            ? 'not_used'
            : 'no_results';
  return { web, reason, searches, queries: distinct(r.queries, 200, 12), sources: web ? sources : [], errors };
}

/** A 400 about the search tool itself (not available, not enabled, not for this model): sending again without it is free. */
export const TOOL_REFUSED = /web.?search|openrouter:web_search|server.?tool|tool[ _]?use|tools?\b.*not supported|allowed_callers/i;
/** A 400 about the search tool's version (Anthropic): the basic version may work. */
export const TOOL_VERSION = /web_search_20260209|tool version|not supported for (this|the) model/i;
