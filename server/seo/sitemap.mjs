// The app host's /sitemap.xml, /robots.txt and the Search Console verification file (WP4 builds this),
// answered through pages.mjs's appHostExtras hook (asked before page names, on the app's own host only).
//
//   const sitemap = createSitemapRoutes({ db, env, now });
//   sitemap.handle(req, res, url) → boolean   true when it answered
//
// Placeholder until then: it answers nothing (false), so those paths behave as before.

export function createSitemapRoutes() {
  return {
    stub: true,
    async handle() {
      return false;
    },
  };
}
