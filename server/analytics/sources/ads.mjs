// Source `ads`: the business's own ad results on every connected ad account (Meta, Google, LinkedIn, TikTok,
// Pinterest, X, Reddit, Microsoft), read through Zernio (server/connections/zernio.mjs adResults(): daily account
// metrics and campaigns; the app makes no ad changes), and up to 3 competitors' active ads from the ad libraries
// (treg). Ad text and campaign names are data, shown as text.

import { itemsOf } from '../normalize/index.mjs';
import { first, link, num, text, when } from '../normalize/util.mjs';
import { noteFor } from './social-public.mjs';
import { publicCode } from '../runner.mjs';
import { AD_PLATFORMS } from '../../integrations/contracts.mjs';

const usable = (s) => s?.state === 'connected' && !!s.targetLabel;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const DAY = 86_400_000;

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

/** The ad platforms this business has a usable account on, and its competitors (3 at most). */
export function adsPlan(settings, statuses) {
  const byPlatform = Object.fromEntries((statuses || []).map((s) => [s.platform, s]));
  return { own: AD_PLATFORMS.filter((p) => usable(byPlatform[p])), competitors: (settings?.competitors || []).slice(0, 3) };
}

export async function adsSource({ settings, statuses, runner, resolved, now = Date.now() }) {
  const plan = adsPlan(settings, statuses);
  if (!plan.own.length && !plan.competitors.length) return { status: 'not_connected', errorCode: 'NOT_CONNECTED', data: { own: [], competitors: [] } };
  const own = [];
  const competitors = [];
  let problems = 0;
  let stop = null;
  let patch = {};
  const tasks = [];
  for (const platform of plan.own) {
    tasks.push(
      runner.adResults(platform, { since: now - 30 * DAY, until: now }).then(
        (r) => {
          if (r) own.push(r);
        },
        () => (problems += 1),
      ),
    );
  }
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
