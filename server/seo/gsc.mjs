// Search Console reads for one page, built only from the requester's own published page (never a URL from the
// browser). App-host pages are in the owner's property (GSC_APP_PROPERTY) through treg's team connection;
// custom-domain pages in the user's own property through their connected Search Console.
//
// The owner's property holds every customer's pages, so each performance call carries exactly ONE filter,
// {dimension:'page', operator:'equals', expression:<exact URL>}: `contains` on /joe would also count /joes-bakery.
// The page's two address variants (with and without the trailing slash) are two calls, summed.

const DAY = 86_400_000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);

/** The exact address variants of a page: as published, and with/without the trailing slash. */
export function pageVariants(url) {
  const u = String(url || '');
  if (!u) return [];
  const bare = u.replace(/\/+$/, '');
  // a home page on a domain is "https://d/": both "https://d" and "https://d/" are the same page to Google
  return [...new Set([bare, `${bare}/`])];
}

/** The searchAnalytics body for one exact page address, by day. */
export function performanceBody(pageUrl, now, days = 28) {
  return {
    startDate: ymd(now - days * DAY),
    endDate: ymd(now),
    dimensions: ['date'],
    dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: pageUrl }] }],
    type: 'web',
    dataState: 'all',
    rowLimit: 1000,
  };
}

/** Sum the per-day rows of the variant answers into SeoData.gsc. */
export function sumPerformance(answers) {
  const byDate = new Map();
  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  for (const body of answers) {
    for (const r of Array.isArray(body?.rows) ? body.rows : []) {
      const date = String(r?.keys?.[0] ?? '').slice(0, 10);
      const c = n(r?.clicks);
      const i = n(r?.impressions);
      clicks += c;
      impressions += i;
      weighted += n(r?.position) * i;
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const d = byDate.get(date) ?? { date, clicks: 0, impressions: 0 };
        d.clicks += c;
        d.impressions += i;
        byDate.set(date, d);
      }
    }
  }
  return {
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    position: impressions ? Math.round((weighted / impressions) * 10) / 10 : 0,
    series: [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

/** Site id for the user's own custom-domain property. */
export const domainProperty = (domain) => `sc-domain:${domain}`;

/**
 * The page's last 28 days. page: ownSeoPage(...). runner: analytics runner (treg / own). property: the owner's
 * GSC_APP_PROPERTY (app host). → SeoData.gsc
 */
export async function pagePerformance({ runner, page, property, now }) {
  const answers = [];
  for (const variant of pageVariants(page.url)) {
    const body = performanceBody(variant, now);
    if (page.host === 'app') {
      const got = await runner.treg('gsc.performance', body, 'gsc', { query: { siteUrl: property } });
      answers.push(got.data);
    } else {
      const res = await runner.own('google_search_console', { method: 'POST', path: `/v3/sites/${encodeURIComponent(domainProperty(page.domain))}/searchAnalytics/query`, body });
      if (res?.status >= 200 && res.status < 300) answers.push(res.body);
      else throw Object.assign(new Error('gsc read failed'), { kind: res?.status === 401 || res?.status === 403 ? 'reconnect' : 'upstream' });
    }
  }
  return sumPerformance(answers);
}

/** The sitemap's status in the owner's property (app host): { lastSubmitted, isPending, errors } or null. */
export async function appSitemapStatus(runner, property, sitemapUrl) {
  const got = await runner.treg('gsc.sitemaps', { siteUrl: property }, 'gsc');
  const list = Array.isArray(got.data?.sitemap) ? got.data.sitemap : [];
  const hit = list.find((s) => s?.path === sitemapUrl);
  return hit ? { lastSubmitted: typeof hit.lastSubmitted === 'string' ? hit.lastSubmitted : undefined, isPending: hit.isPending === true, errors: n(hit.errors) } : null;
}

/** URL inspection's answer → the few fields the app shows. */
export function inspectionFields(data) {
  const r = data?.inspectionResult?.indexStatusResult ?? {};
  const s = (v) => (typeof v === 'string' ? v.slice(0, 200) : undefined);
  return Object.fromEntries(Object.entries({ verdict: s(r.verdict), coverageState: s(r.coverageState), lastCrawlTime: s(r.lastCrawlTime) }).filter(([, v]) => v !== undefined));
}
