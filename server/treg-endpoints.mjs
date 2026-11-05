// Every treg endpoint the app calls (WP3 owns this table, WP4 reads it), with its price ceiling. Prices and
// fallbacks: catalog prices on 2026-11-05. maxCostUsd null: the team's own connection (Search Console), no
// X-Treg-Route-Max-Cost header. oneShot: a write, never repeated (not even after a timeout).
//
// refresh: when a source calls it ('update' every Update press; 'once' per handle or competitor, cached in
// analytics_settings.resolved; 'monthly'; 'fallback' only after a 429/5xx of the main one; 'health';
// 'publish' from "Submit to Google"; 'inspect' on publish, then weekly until indexed).

export const TREG_ENDPOINTS = Object.freeze({
  'ig.profile': { endpointId: 'treg.instagram.user.profile', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'ig.posts': { endpointId: 'treg.instagram.user.posts', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'fb.profile': { endpointId: 'crawl4ai.facebook.user.profile', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'fb.posts': { endpointId: 'treg.facebook.user.posts', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'tt.profile': { endpointId: 'treg.tiktok.user.profile', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'tt.videos': { endpointId: 'treg.tiktok.user.videos', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'li.profile': { endpointId: 'treg.linkedin.company.profile', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'li.posts': { endpointId: 'harvestapi.linkedin.company.posts', method: 'GET', maxCostUsd: 0.005, refresh: 'update' },
  'x.profile': { endpointId: 'treg.x.user.profile', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'x.posts': { endpointId: 'treg.x.user.posts', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'yt.resolve': { endpointId: 'crawl4ai.youtube.channel.profile', method: 'POST', maxCostUsd: 0.005, refresh: 'once' },
  'yt.profile': { endpointId: 'treg.youtube.channel.profile', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'yt.videos': { endpointId: 'crawl4ai.youtube.channel.videos', method: 'POST', maxCostUsd: 0.005, refresh: 'update' },
  'serp.organic': { endpointId: 'crawl4ai.google.serp.organic', method: 'GET', maxCostUsd: 0.005, refresh: 'update' },
  'serp.organic.fallback': { endpointId: 'dataforseo.google.serp.organic', method: 'POST', maxCostUsd: 0.005, refresh: 'fallback' },
  'serp.maps': { endpointId: 'crawl4ai.google.serp.maps', method: 'POST', maxCostUsd: 0.005, refresh: 'update' },
  'kw.volume': { endpointId: 'treg.google.keywords.volume', method: 'POST', maxCostUsd: 0.03, refresh: 'monthly' },
  'web.metrics': { endpointId: 'treg.web.url.metrics', method: 'POST', maxCostUsd: 0.01, refresh: 'monthly' },
  'web.backlinks': { endpointId: 'treg.web.backlinks.summary', method: 'POST', maxCostUsd: 0.03, refresh: 'monthly' },
  'ads.meta': { endpointId: 'treg.meta-ads.library.advertiser', method: 'POST', maxCostUsd: 0.005, refresh: 'update' },
  'ads.meta.lookup': { endpointId: 'scrapecreators.x.v1-facebook-adlibrary-search-companies', method: 'GET', maxCostUsd: 0.005, refresh: 'once' },
  'ads.google': { endpointId: 'scrapecreators.x.v1-google-company-ads', method: 'GET', maxCostUsd: 0.005, refresh: 'update' },
  'gsc.sites': { endpointId: 'google-search-console.sites', method: 'GET', maxCostUsd: null, refresh: 'health' },
  'gsc.sitemaps': { endpointId: 'google-search-console.sitemaps', method: 'GET', maxCostUsd: null, refresh: 'update' },
  'gsc.submit': { endpointId: 'google-search-console.x.webmasters-sitemaps-submit', method: 'PUT', maxCostUsd: null, refresh: 'publish', oneShot: true },
  'gsc.inspect': { endpointId: 'google-search-console.url_inspection', method: 'POST', maxCostUsd: null, refresh: 'inspect' },
  'gsc.performance': { endpointId: 'google-search-console.performance', method: 'POST', maxCostUsd: null, refresh: 'update' },
});
