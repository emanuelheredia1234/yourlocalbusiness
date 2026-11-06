// Every treg endpoint the app calls (WP3 owns this table, WP4 reads it), with its price ceiling. Prices and
// fallbacks: catalog prices on 2026-11-05. maxCostUsd null: the team's own connection (Search Console), no
// X-Treg-Route-Max-Cost header. oneShot: a write, never repeated (not even after a timeout).
//
// refresh: when a source calls it ('update' every Update press; 'once' per handle or competitor, cached in
// analytics_settings.resolved; 'monthly'; 'fallback' only after a 429/5xx of the main one; 'health';
// 'publish' from "Submit to Google"; 'inspect' on publish, then weekly until indexed).

export const TREG_ENDPOINTS = Object.freeze({
  'ig.profile': { label: 'Instagram profile', endpointId: 'treg.instagram.user.profile', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'ig.posts': { label: 'Instagram posts', endpointId: 'treg.instagram.user.posts', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'fb.profile': { label: 'Facebook profile', endpointId: 'crawl4ai.facebook.user.profile', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'fb.posts': { label: 'Facebook posts', endpointId: 'treg.facebook.user.posts', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'tt.profile': { label: 'TikTok profile', endpointId: 'treg.tiktok.user.profile', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'tt.videos': { label: 'TikTok videos', endpointId: 'treg.tiktok.user.videos', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'li.profile': { label: 'LinkedIn page', endpointId: 'treg.linkedin.company.profile', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'li.posts': { label: 'LinkedIn posts', endpointId: 'harvestapi.linkedin.company.posts', method: 'GET', maxCostUsd: 0.005, refresh: 'update' },
  'x.profile': { label: 'X profile', endpointId: 'treg.x.user.profile', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'x.posts': { label: 'X posts', endpointId: 'treg.x.user.posts', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'yt.resolve': { label: 'YouTube channel lookup', endpointId: 'crawl4ai.youtube.channel.profile', method: 'POST', maxCostUsd: 0.005, refresh: 'once' },
  'yt.profile': { label: 'YouTube channel', endpointId: 'treg.youtube.channel.profile', method: 'POST', maxCostUsd: 0.01, refresh: 'update' },
  'yt.videos': { label: 'YouTube videos', endpointId: 'crawl4ai.youtube.channel.videos', method: 'POST', maxCostUsd: 0.005, refresh: 'update' },
  'serp.organic': { label: 'Google rank', endpointId: 'crawl4ai.google.serp.organic', method: 'GET', maxCostUsd: 0.005, refresh: 'update' },
  'serp.organic.fallback': { label: 'Google rank', endpointId: 'dataforseo.google.serp.organic', method: 'POST', maxCostUsd: 0.005, refresh: 'fallback' },
  'serp.maps': { label: 'Google Maps position', endpointId: 'crawl4ai.google.serp.maps', method: 'POST', maxCostUsd: 0.005, refresh: 'update' },
  'kw.volume': { label: 'Keyword search volume', endpointId: 'treg.google.keywords.volume', method: 'POST', maxCostUsd: 0.03, refresh: 'monthly' },
  'web.metrics': { label: 'Website authority', endpointId: 'treg.web.url.metrics', method: 'POST', maxCostUsd: 0.01, refresh: 'monthly' },
  'web.backlinks': { label: 'Backlinks', endpointId: 'treg.web.backlinks.summary', method: 'POST', maxCostUsd: 0.03, refresh: 'monthly' },
  'ads.meta': { label: 'Competitor Facebook ads', endpointId: 'treg.meta-ads.library.advertiser', method: 'POST', maxCostUsd: 0.005, refresh: 'update' },
  'ads.meta.lookup': { label: 'Competitor lookup', endpointId: 'scrapecreators.x.v1-facebook-adlibrary-search-companies', method: 'GET', maxCostUsd: 0.005, refresh: 'once' },
  'ads.google': { label: 'Competitor Google ads', endpointId: 'scrapecreators.x.v1-google-company-ads', method: 'GET', maxCostUsd: 0.005, refresh: 'update' },
  'gsc.sites': { label: 'Search Console check', endpointId: 'google-search-console.sites', method: 'GET', maxCostUsd: null, refresh: 'health' },
  'gsc.sitemaps': { label: 'Sitemap status', endpointId: 'google-search-console.sitemaps', method: 'GET', maxCostUsd: null, refresh: 'update' },
  'gsc.submit': { label: 'Sitemap submitted to Google', endpointId: 'google-search-console.x.webmasters-sitemaps-submit', method: 'PUT', maxCostUsd: null, refresh: 'publish', oneShot: true },
  'gsc.sites_add': { label: 'Domain added to Search Console', endpointId: 'google-search-console.x.webmasters-sites-add', method: 'PUT', maxCostUsd: null, refresh: 'publish', oneShot: true },
  'gsc.inspect': { label: 'Google index check', endpointId: 'google-search-console.url_inspection', method: 'POST', maxCostUsd: null, refresh: 'inspect' },
  'gsc.performance': { label: 'Google search results', endpointId: 'google-search-console.performance', method: 'POST', maxCostUsd: null, refresh: 'update' },
});

/** The entry for a table key ('ig.profile') or a treg endpoint id ('treg.instagram.user.profile'), with its key; else null. */
export function tregEndpoint(keyOrId) {
  const k = String(keyOrId ?? '');
  if (Object.hasOwn(TREG_ENDPOINTS, k)) return { key: k, ...TREG_ENDPOINTS[k] };
  for (const [key, e] of Object.entries(TREG_ENDPOINTS)) if (e.endpointId === k) return { key, ...e };
  return null;
}

/** A plain label for a usage-ledger endpoint (treg endpoint ids, '<platform>:<METHOD> <path>' for connected accounts). */
export function endpointLabel(endpoint, vendor = 'treg') {
  const e = tregEndpoint(endpoint);
  if (e) return e.label;
  const NAMES = { facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', tiktok: 'TikTok', x: 'X', youtube: 'YouTube', pinterest: 'Pinterest', google_ads: 'Google Ads', meta_ads: 'Meta Ads', linkedin_ads: 'LinkedIn Ads', tiktok_ads: 'TikTok Ads', pinterest_ads: 'Pinterest Ads', x_ads: 'X Ads', reddit_ads: 'Reddit Ads', microsoft_ads: 'Microsoft Ads' };
  const platform = /^([a-z_]+):/.exec(String(endpoint ?? ''))?.[1];
  if (vendor === 'x') return 'X post';
  if (vendor === 'zernio' && /^zernio_accounts/.test(String(endpoint))) return 'Ad accounts';
  if (vendor === 'uploadpost' && /^upload_post_profile/.test(String(endpoint))) return 'Connected accounts';
  if (vendor === 'uploadpost' && platform && NAMES[platform]) {
    const ep = String(endpoint);
    if (/:POST \/upload/.test(ep)) return `${NAMES[platform]} post`;
    if (/:GET \/(analytics|post-analytics)/.test(ep)) return `${NAMES[platform]} stats`;
  }
  if (vendor === 'nango' && /^nango_connection/.test(String(endpoint))) return 'Connected integration';
  if (platform && NAMES[platform]) return `${NAMES[platform]} (your account)`;
  if (vendor === 'omnisend') return 'Email stats';
  return 'Analytics data';
}
