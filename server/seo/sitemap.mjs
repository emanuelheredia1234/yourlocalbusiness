// The app host's /sitemap.xml, /robots.txt and the Search Console verification file, answered through
// pages.mjs's appHostExtras hook (asked before page names, on the app's own host only; people's own domains
// have their own sitemap in pages.mjs serveDomain).
//
//   const sitemap = createSitemapRoutes({ db, env, now });
//   sitemap.handle(req, res, url) → boolean   true when it answered
//
// /sitemap.xml lists every user's published sales page (kind 'seo') that lives on the app's address only: a page
// whose address is a custom domain is listed in that domain's sitemap instead (no duplicate content), then the public
// marketplace (P7, server/market/: setMarket hands it in): /market, each category with 3+ live listings and each live
// listing whose seller's plan still serves (never thin, held, hidden, unlisted or over-limit ones). Built from the
// database at most every 10 minutes (the market drops the cache on this copy when a listing changes). /robots.txt
// allows everything but /api/, the market's search results and report forms, and points at the sitemap.
// /google2598e017b2dc1e02.html answers Google's HTML-file check for the homepage (always, no sign-in).
// /<GSC_APP_VERIFICATION_FILE> answers the same way when that setting names another google<16 hex>.html file.
// Page names can't contain a dot, so none of these collide with a page.

/** Google's HTML verification file name. */
export const VERIFICATION_FILE_RE = /^google[0-9a-f]{16}\.html$/;
/**
 * The homepage property's HTML-file check. Served even when GSC_APP_VERIFICATION_FILE is unset, so
 * https://yourlocalbusiness.replit.app/google2598e017b2dc1e02.html is not the app shell.
 * Body is exactly `google-site-verification: <filename>` with no HTML wrapper.
 */
export const HOMEPAGE_VERIFICATION_FILE = 'google2598e017b2dc1e02.html';
/** How long a built sitemap is served before it's built again. */
export const SITEMAP_TTL_MS = 10 * 60_000;
/** A sitemap file holds at most 50,000 addresses (sitemaps.org). */
const MAX_URLS = 50_000;
const PAGE_SIZE = 1000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;
const COMMON = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' };

/** Text safe inside XML. */
export function xmlEscape(text) {
  return String(text).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

/**
 * The app's public origin ('https://yourlocalbusiness.replit.app'): GSC_APP_PROPERTY's when it's set (the address
 * Google knows the pages by), else the host this request came to.
 */
export function appOrigin(env = process.env, req = null) {
  try {
    const prop = String(env.GSC_APP_PROPERTY || '').trim();
    if (prop) {
      const u = new URL(prop);
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin;
    }
  } catch {
    /* not a URL: use the host */
  }
  const host = String(req?.headers?.host || '').toLowerCase();
  if (/^[a-z0-9.-]+(:\d+)?$/.test(host)) return `${/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https'}://${host}`;
  return 'https://yourlocalbusiness.replit.app';
}

/** The verification file name from env, or '' when it isn't set or isn't Google's shape. */
export function verificationFile(env = process.env) {
  const name = String(env.GSC_APP_VERIFICATION_FILE || '').trim();
  return VERIFICATION_FILE_RE.test(name) ? name : '';
}

/** File names this host answers for Google's HTML-file check: the homepage file, plus GSC_APP_VERIFICATION_FILE when set. */
export function verificationFiles(env = process.env) {
  const names = new Set([HOMEPAGE_VERIFICATION_FILE]);
  const configured = verificationFile(env);
  if (configured) names.add(configured);
  return names;
}

/** The one line Google fetches. No HTML wrapper and no extra newline. */
export function verificationBody(name) {
  return `google-site-verification: ${name}`;
}

const CATEGORY_RE = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,58}[a-z0-9])$/;
/** A category page is listed (and indexed) from this many live listings. */
export const MARKET_CATEGORY_MIN = 3;
const dateOf = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : '');
const urlLine = (loc, date) => `  <url><loc>${xmlEscape(loc)}</loc>${date ? `<lastmod>${xmlEscape(date)}</lastmod>` : ''}</url>\n`;

/**
 * The sitemap XML on this origin: pages ({slug, updated_at}) first, then the market's live listings ({slug,
 * category_slug, content_updated_at}): /market, its categories with 3+ listings, each listing. At most 50,000 in all.
 */
export function sitemapXml(origin, rows, marketRows = []) {
  const urls = rows
    .filter((r) => SLUG_RE.test(String(r.slug || '')))
    .map((r) => urlLine(`${origin}/${r.slug}`, dateOf(r.updated_at)));
  const market = marketRows.filter((r) => SLUG_RE.test(String(r.slug || '')));
  if (market.length) {
    const newest = market.map((r) => dateOf(r.content_updated_at)).sort().at(-1) ?? '';
    urls.push(urlLine(`${origin}/market`, newest));
    const cats = new Map();
    for (const r of market) {
      if (!CATEGORY_RE.test(String(r.category_slug || ''))) continue;
      const c = cats.get(r.category_slug) ?? { n: 0, date: '' };
      c.n++;
      const d = dateOf(r.content_updated_at);
      if (d > c.date) c.date = d;
      cats.set(r.category_slug, c);
    }
    for (const [slug, c] of [...cats].sort(([a], [b]) => (a < b ? -1 : 1))) if (c.n >= MARKET_CATEGORY_MIN) urls.push(urlLine(`${origin}/market?category=${slug}`, c.date));
    for (const r of market) urls.push(urlLine(`${origin}/market/${r.slug}`, dateOf(r.content_updated_at)));
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.slice(0, MAX_URLS).join('')}</urlset>\n`;
}

/** robots.txt: everything but the API, the market's search results and its report forms (those pages are noindex too). */
export function robotsTxt(origin) {
  return `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /market?q=\nDisallow: /market?*&q=\nDisallow: /market/*/report\nSitemap: ${origin}/sitemap.xml\n`;
}

/**
 * db: server/integrations/db.mjs (the secret key: published_pages is server-only). env: GSC_APP_PROPERTY,
 * GSC_APP_VERIFICATION_FILE. now: for the cache (tests).
 */
export function createSitemapRoutes({ db = null, env = process.env, now = () => Date.now(), log = console } = {}) {
  /** origin → { xml, at } */
  const cache = new Map();
  /** the public marketplace (server/market/): { sitemapRows() }, handed in once it is made */
  let market = null;

  /** Every published app-address sales page, all users (only the slug and date are read). */
  async function appPages() {
    const rows = [];
    for (let offset = 0; offset < MAX_URLS; offset += PAGE_SIZE) {
      const page = await db.select('published_pages', { kind: 'seo', domain: null }, { select: 'slug,updated_at', order: 'slug.asc', limit: PAGE_SIZE, offset });
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return rows;
  }

  async function sitemap(origin) {
    const hit = cache.get(origin);
    if (hit && now() - hit.at < SITEMAP_TTL_MS) return hit.xml;
    // the market's pages have one canonical address, the app's (appOrigin without a request): they are listed only in
    // the sitemap served there, never under another of the app's hosts
    const marketHere = !!market?.sitemapRows && origin === appOrigin(env);
    const xml = sitemapXml(origin, await appPages(), marketHere ? await market.sitemapRows() : []);
    cache.clear();
    cache.set(origin, { xml, at: now() });
    return xml;
  }

  function write(req, res, type, body, cacheControl) {
    const bytes = Buffer.from(body, 'utf8');
    res.writeHead(200, { ...COMMON, 'content-type': type, 'content-length': bytes.length, 'cache-control': cacheControl });
    res.end(req.method === 'HEAD' ? undefined : bytes);
    return true;
  }

  return {
    async handle(req, res, url) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false;
      const p = url.pathname;
      if (p === '/robots.txt') return write(req, res, 'text/plain; charset=utf-8', robotsTxt(appOrigin(env, req)), 'public, max-age=300');
      if (p === '/sitemap.xml') {
        if (!db?.enabled) return false;
        let xml;
        try {
          xml = await sitemap(appOrigin(env, req));
        } catch (e) {
          // pages.mjs answers 503 for a throw; the database's text stays here
          log.error?.('Sitemap failed:', e?.code || e?.name || 'Error');
          throw new Error('sitemap unavailable');
        }
        return write(req, res, 'application/xml; charset=utf-8', xml, 'public, max-age=600');
      }
      const asked = p.startsWith('/') ? p.slice(1) : '';
      if (verificationFiles(env).has(asked)) return write(req, res, 'text/html; charset=utf-8', verificationBody(asked), 'public, max-age=3600');
      return false;
    },
    /** for tests, and the market when a listing changes on this copy */
    clearCache: () => cache.clear(),
    /** the public marketplace's rows (server/market/index.mjs) */
    setMarket: (m) => {
      market = m;
    },
  };
}
