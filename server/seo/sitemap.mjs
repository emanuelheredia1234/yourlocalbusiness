// The app host's /sitemap.xml, /robots.txt and the Search Console verification file, answered through
// pages.mjs's appHostExtras hook (asked before page names, on the app's own host only; people's own domains
// have their own sitemap in pages.mjs serveDomain).
//
//   const sitemap = createSitemapRoutes({ db, env, now });
//   sitemap.handle(req, res, url) → boolean   true when it answered
//
// /sitemap.xml lists every user's published sales page (kind 'seo') that lives on the app's address only: a page
// whose address is a custom domain is listed in that domain's sitemap instead (no duplicate content). Built from
// the database at most every 10 minutes. /robots.txt allows everything but /api/ and points at the sitemap.
// /<GSC_APP_VERIFICATION_FILE> (google<16 hex>.html) answers Google's HTML-file check for the owner's property.
// Page names can't contain a dot, so none of these collide with a page.

/** Google's HTML verification file name. */
export const VERIFICATION_FILE_RE = /^google[0-9a-f]{16}\.html$/;
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

/** The sitemap XML for these rows ({slug, updated_at}) on this origin. */
export function sitemapXml(origin, rows) {
  const urls = rows
    .filter((r) => SLUG_RE.test(String(r.slug || '')))
    .slice(0, MAX_URLS)
    .map((r) => {
      const lastmod = /^\d{4}-\d{2}-\d{2}/.test(String(r.updated_at || '')) ? `<lastmod>${xmlEscape(String(r.updated_at).slice(0, 10))}</lastmod>` : '';
      return `  <url><loc>${xmlEscape(`${origin}/${r.slug}`)}</loc>${lastmod}</url>\n`;
    });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('')}</urlset>\n`;
}

export function robotsTxt(origin) {
  return `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`;
}

/**
 * db: server/integrations/db.mjs (the secret key: published_pages is server-only). env: GSC_APP_PROPERTY,
 * GSC_APP_VERIFICATION_FILE. now: for the cache (tests).
 */
export function createSitemapRoutes({ db = null, env = process.env, now = () => Date.now(), log = console } = {}) {
  /** origin → { xml, at } */
  const cache = new Map();

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
    const xml = sitemapXml(origin, await appPages());
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
      const file = verificationFile(env);
      if (file && p === `/${file}`) return write(req, res, 'text/html; charset=utf-8', `google-site-verification: ${file}`, 'public, max-age=3600');
      return false;
    },
    /** for tests */
    clearCache: () => cache.clear(),
  };
}
