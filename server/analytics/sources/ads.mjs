// Source `ads`: the user's own Google Ads and Meta Ads results (reads through the connected accounts; the app makes
// no ad changes), and up to 3 competitors' active ads from the ad libraries (treg). Ad text is data, shown as text.

import { itemsOf } from '../normalize/index.mjs';
import { first, link, num, text, when } from '../normalize/util.mjs';
import { noteFor } from './social-public.mjs';
import { publicCode } from '../runner.mjs';

const usable = (s) => s?.state === 'connected' && !!s.targetLabel;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The GAQL for the last 30 days per campaign (spec §1.5, plus the account currency so amounts are labelled). */
export const GOOGLE_ADS_QUERY =
  'SELECT customer.currency_code, campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, segments.date FROM campaign WHERE segments.date DURING LAST_30_DAYS';

function okBody(res) {
  if (res && res.status >= 200 && res.status < 300) return res.body;
  throw Object.assign(new Error('ads read failed'), { kind: res?.status === 401 || res?.status === 403 ? 'reconnect' : 'upstream' });
}

function rollup(platform, currency, rows) {
  const campaigns = new Map();
  const days = new Map();
  for (const r of rows) {
    const c = campaigns.get(r.id) ?? { id: r.id, name: r.name, spend: 0, impressions: 0, clicks: 0, conversions: 0 };
    c.spend += r.spend;
    c.impressions += r.impressions;
    c.clicks += r.clicks;
    c.conversions += r.conversions;
    campaigns.set(r.id, c);
    if (r.date) {
      const d = days.get(r.date) ?? { date: r.date, spend: 0, clicks: 0 };
      d.spend += r.spend;
      d.clicks += r.clicks;
      days.set(r.date, d);
    }
  }
  const list = [...campaigns.values()];
  const total = (k) => list.reduce((a, c) => a + c[k], 0);
  return {
    platform,
    currency,
    spend: Math.round(total('spend') * 100) / 100,
    impressions: total('impressions'),
    clicks: total('clicks'),
    conversions: total('conversions'),
    series: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    campaigns: list.sort((a, b) => b.spend - a.spend).slice(0, 50),
  };
}

async function googleAds(runner) {
  const body = okBody(await runner.own('google_ads', { method: 'POST', path: '/v26/customers/{target}/googleAds:search', body: { query: GOOGLE_ADS_QUERY } }));
  const results = Array.isArray(body?.results) ? body.results : [];
  let currency = 'USD';
  const rows = results.filter(isObj).map((r) => {
    if (typeof r.customer?.currencyCode === 'string') currency = r.customer.currencyCode.slice(0, 3);
    return {
      id: text(r.campaign?.id, 40),
      name: text(r.campaign?.name, 200),
      spend: (num(r.metrics?.costMicros) ?? 0) / 1e6,
      impressions: num(r.metrics?.impressions) ?? 0,
      clicks: num(r.metrics?.clicks) ?? 0,
      conversions: num(r.metrics?.conversions) ?? 0,
      date: typeof r.segments?.date === 'string' ? r.segments.date.slice(0, 10) : '',
    };
  });
  return rollup('google_ads', currency, rows);
}

const CONVERSION_TYPES = /^(lead|purchase|complete_registration|offsite_conversion\.|onsite_conversion\.lead|omni_purchase)/;

async function metaAds(runner) {
  const body = okBody(
    await runner.own('meta_ads', {
      method: 'GET',
      path: '/v26.0/act_{target}/insights',
      query: { level: 'campaign', fields: 'campaign_id,campaign_name,impressions,reach,clicks,spend,ctr,cpc,actions,account_currency', date_preset: 'last_30d', time_increment: '1' },
    }),
  );
  const data = Array.isArray(body?.data) ? body.data : [];
  let currency = 'USD';
  const rows = data.filter(isObj).map((r) => {
    if (typeof r.account_currency === 'string') currency = r.account_currency.slice(0, 3);
    const conversions = (Array.isArray(r.actions) ? r.actions : []).filter((a) => CONVERSION_TYPES.test(String(a?.action_type ?? ''))).reduce((a, x) => a + (num(x?.value) ?? 0), 0);
    return { id: text(r.campaign_id, 40), name: text(r.campaign_name, 200), spend: Number(r.spend) || 0, impressions: num(r.impressions) ?? 0, clicks: num(r.clicks) ?? 0, conversions, date: typeof r.date_start === 'string' ? r.date_start.slice(0, 10) : '' };
  });
  return rollup('meta_ads', currency, rows);
}

function adsList(data) {
  return itemsOf(data)
    .filter(isObj)
    .slice(0, 20)
    .map((a) => {
      const id = text(first(a.ad_archive_id, a.id, a.creativeId, a.adArchiveID), 64);
      const body = first(a.body, a.ad_creative_bodies?.[0], a.snapshot?.body?.text, a.cards?.[0]?.body, a.title, a.advertiserName, '');
      return {
        id,
        text: text(body, 500),
        ...(link(first(a.ad_url, a.adUrl, a.ad_snapshot_url, a.url)) ? { url: link(first(a.ad_url, a.adUrl, a.ad_snapshot_url, a.url)) } : {}),
        ...(when(first(a.start_date, a.firstShown, a.ad_delivery_start_time)) ? { firstShown: when(first(a.start_date, a.firstShown, a.ad_delivery_start_time)) } : {}),
      };
    })
    .filter((a) => a.id);
}

/** A competitor's Facebook page id: theirs as set, the one found earlier, or a lookup by name (once). */
async function competitorPageId(runner, c, resolved) {
  if (c.pageId) return { pageId: c.pageId };
  const known = resolved?.competitors?.[c.name.toLowerCase()];
  if (known?.pageId) return { pageId: known.pageId };
  if (known?.lookedUp) return {};
  const got = await runner.treg('ads.meta.lookup', { query: c.name }, 'ads');
  const hit = itemsOf(got.data).find((x) => isObj(x) && /^\d{3,30}$/.test(String(first(x.page_id, x.pageId, x.id) ?? '')));
  const pageId = hit ? String(first(hit.page_id, hit.pageId, hit.id)) : undefined;
  return { pageId, patch: { [c.name.toLowerCase()]: { lookedUp: true, ...(pageId ? { pageId } : {}) } } };
}

export function adsPlan(settings, statuses) {
  const byPlatform = Object.fromEntries((statuses || []).map((s) => [s.platform, s]));
  return { google: usable(byPlatform.google_ads), meta: usable(byPlatform.meta_ads), competitors: (settings?.competitors || []).slice(0, 3) };
}

export async function adsSource({ settings, statuses, runner, resolved }) {
  const plan = adsPlan(settings, statuses);
  if (!plan.google && !plan.meta && !plan.competitors.length) return { status: 'not_connected', errorCode: 'NOT_CONNECTED', data: { own: [], competitors: [] } };
  const own = [];
  const competitors = [];
  let problems = 0;
  let stop = null;
  let patch = {};
  const tasks = [];
  if (plan.google) tasks.push(googleAds(runner).then((r) => own.push(r), () => (problems += 1)));
  if (plan.meta) tasks.push(metaAds(runner).then((r) => own.push(r), () => (problems += 1)));
  for (const c of plan.competitors) {
    tasks.push(
      (async () => {
        try {
          const found = await competitorPageId(runner, c, resolved);
          if (found.patch) patch = { ...patch, ...found.patch };
          const got = await runner.treg('ads.meta', found.pageId ? { page_id: found.pageId } : { company_name: c.name }, 'ads');
          const ads = adsList(got.data);
          competitors.push({ name: c.name, source: 'meta', activeAds: ads.length, ads, ...(ads.length ? {} : { note: 'no_ads' }) });
        } catch (e) {
          if (noteFor(e) === 'not_found') competitors.push({ name: c.name, source: 'meta', activeAds: 0, ads: [], note: 'not_found' });
          else {
            problems += 1;
            if (!noteFor(e)) stop = stop ?? e;
          }
        }
        if (!c.domain) return;
        try {
          const got = await runner.treg('ads.google', { domain: c.domain, region: 'US' }, 'ads');
          const ads = adsList(got.data);
          competitors.push({ name: c.name, source: 'google', activeAds: num(got.data?.number_of_ads_estimate) ?? ads.length, ads, ...(ads.length ? {} : { note: 'no_ads' }) });
        } catch (e) {
          if (noteFor(e) === 'not_found') competitors.push({ name: c.name, source: 'google', activeAds: 0, ads: [], note: 'not_found' });
          else {
            problems += 1;
            if (!noteFor(e)) stop = stop ?? e;
          }
        }
      })(),
    );
  }
  await Promise.all(tasks);
  if (!own.length && !competitors.length) {
    if (stop) throw stop;
    return { status: 'error', errorCode: 'UNAVAILABLE', data: { own: [], competitors: [] } };
  }
  own.sort((a, b) => (a.platform < b.platform ? -1 : 1));
  const summary = { spend: own.reduce((a, o) => a + o.spend, 0), clicks: own.reduce((a, o) => a + o.clicks, 0), competitorAds: competitors.reduce((a, c) => a + c.activeAds, 0) };
  return {
    status: problems ? 'partial' : 'ok',
    errorCode: stop?.kind ? publicCode(stop) : null,
    data: { own, competitors },
    summary,
    resolved: Object.keys(patch).length ? { competitors: { ...(resolved?.competitors || {}), ...patch } } : null,
  };
}
