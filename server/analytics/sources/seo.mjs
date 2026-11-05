// Source `seo`: Google rank and Maps position per keyword (treg), Search Console for this project's own page
// (performance with exact page filters, sitemap status, the last inspection), and monthly extras (keyword volume;
// authority and backlinks for a custom domain only).

import { seoPageIdFor } from '../../integrations/common.mjs';
import { mapsPosition, organicRows, rankOf } from '../../seo/rank.mjs';
import { appSitemapStatus, inspectionFields, pagePerformance } from '../../seo/gsc.mjs';
import { claimInspection, inspectionDue, readSteps, writeStep } from '../../seo/steps.mjs';
import { itemsOf } from '../normalize/index.mjs';
import { num } from '../normalize/util.mjs';
import { noteFor } from './social-public.mjs';
import { publicCode } from '../runner.mjs';

const MONTH_MS = 30 * 86_400_000;
const FALLBACK_KINDS = new Set(['busy', 'unavailable', 'upstream']);

/** "City, Region" for the business: project.location (city + region), else the city set in analytics settings. */
export function cityOf(project, settings) {
  const loc = project?.location;
  if (loc && typeof loc.city === 'string' && loc.city.trim()) return [loc.city.trim(), typeof loc.region === 'string' ? loc.region.trim() : ''].filter(Boolean).join(', ');
  return typeof settings?.city === 'string' && settings.city.trim() ? settings.city.trim() : '';
}

async function organic(runner, keyword, location) {
  try {
    const got = await runner.treg('serp.organic', { q: keyword, ...(location ? { location } : {}), country: 'us', language: 'en', num: 10 }, 'seo');
    return organicRows(got.data);
  } catch (e) {
    // only on a 429 / 5xx of the main one (never on a 4xx: our request was wrong)
    if (!FALLBACK_KINDS.has(e?.kind)) throw e;
    const got = await runner.treg('serp.organic.fallback', [{ keyword, ...(location ? { location_name: location } : {}), language_code: 'en', depth: 10 }], 'seo');
    return organicRows(got.data);
  }
}

export function seoPlan(settings, page, gscStatus) {
  return { keywords: (settings?.keywords || []).slice(0, 10), page, gsc: !!page && (page.host === 'app' || gscStatus?.state === 'connected') };
}

/**
 * → { status, errorCode?, data: SeoData, summary, resolved }. page: ownSeoPage(...) or null. property:
 * GSC_APP_PROPERTY. origin: the app's public origin (its sitemap). gscStatus: the google_search_console
 * ConnectionStatus. storage + customerTag: the inspection budgets (steps.mjs), for the weekly re-inspection.
 */
export async function seoSource({ db, userId, projectId, project, settings, resolved, page, property, origin = '', gscStatus, runner, now, storage = null, customerTag = '' }) {
  const plan = seoPlan(settings, page, gscStatus);
  if (!plan.keywords.length && !page) return { status: 'not_connected', errorCode: 'NOTHING_TO_UPDATE', data: { keywords: [] } };
  const data = { keywords: [] };
  if (page) data.page = { url: page.url, host: page.host };
  let problems = 0;
  let stop = null;
  const patch = {};
  const location = cityOf(project, settings);
  const place = { placeId: resolved?.placeId, cid: resolved?.cid, name: project?.brand?.name };

  await Promise.all(
    plan.keywords.map(async (keyword, i) => {
      const row = { keyword, rank: null, mapsPosition: null };
      data.keywords[i] = row;
      try {
        row.rank = rankOf(await organic(runner, keyword, location), page);
      } catch (e) {
        problems += 1;
        if (!noteFor(e)) stop = stop ?? e;
      }
      try {
        const got = await runner.treg('serp.maps', { query: keyword, ...(location ? { location } : {}), limit: 20 }, 'seo');
        const hit = mapsPosition(itemsOf(got.data), place);
        if (hit) {
          row.mapsPosition = hit.position;
          if (!place.placeId && hit.placeId) Object.assign(patch, { placeId: hit.placeId, ...(hit.cid ? { cid: hit.cid } : {}) });
        }
      } catch (e) {
        problems += 1;
        if (!noteFor(e)) stop = stop ?? e;
      }
    }),
  );

  if (page) {
    // what "Submit to Google" stored for this page (the route and the weekly check write it)
    const pageId = seoPageIdFor(projectId);
    const steps = await readSteps(db, userId, pageId).catch(() => ({}));
    const google = {};
    if (steps.sitemap?.outcome === 'ok') google.submittedAt = steps.sitemap.at;
    if (steps.inspect?.detail) Object.assign(google, steps.inspect.detail);
    if (page.host === 'app' && property && origin) {
      // the shared sitemap's status in the owner's property (every Update): a submit Google took after the page
      // was last published covers it, whoever pressed
      try {
        const sm = await appSitemapStatus(runner, property, `${origin}/sitemap.xml`);
        if (!google.submittedAt && sm?.lastSubmitted && Date.parse(page.updatedAt) <= Date.parse(sm.lastSubmitted)) google.submittedAt = sm.lastSubmitted;
      } catch (e) {
        problems += 1;
        if (!noteFor(e)) stop = stop ?? e;
      }
      // once the page was sent to Google: inspected again weekly until it is indexed, within the same daily
      // budgets as "Submit to Google" (a read; never more than one per Update)
      if (!stop && (steps.sitemap || steps.inspect) && inspectionDue(steps.inspect, now) && storage?.enabled === true && customerTag) {
        const claimed = await claimInspection(storage, customerTag, now).catch(() => false);
        if (claimed) {
          try {
            const got = await runner.treg('gsc.inspect', { inspectionUrl: page.url, siteUrl: property, languageCode: 'en-US' }, 'gsc');
            const fields = inspectionFields(got.data);
            await writeStep(db, userId, pageId, 'inspect', 'ok', fields, now).catch(() => {});
            Object.assign(google, fields);
          } catch (e) {
            problems += 1;
            if (!noteFor(e)) stop = stop ?? e;
          }
        }
      }
    }
    if (Object.keys(google).length) data.google = google;
    if (plan.gsc && (page.host === 'custom' || property)) {
      try {
        data.gsc = await pagePerformance({ runner, page, property, now });
      } catch (e) {
        problems += 1;
        if (!noteFor(e) && e?.kind !== 'reconnect') stop = stop ?? e;
      }
    }
  }

  // monthly extras: keyword volume; authority and backlinks only for a domain the business owns
  const monthlyDue = !(Date.parse(resolved?.monthlyAt) > now - MONTH_MS);
  const monthly = resolved?.monthly && typeof resolved.monthly === 'object' ? { ...resolved.monthly } : {};
  if (monthlyDue && !stop && (plan.keywords.length || page?.host === 'custom')) {
    let ran = false;
    if (plan.keywords.length) {
      try {
        const got = await runner.treg('kw.volume', { keywords: plan.keywords, country: 'us', language: 'en' }, 'seo');
        monthly.volume = {};
        for (const r of itemsOf(got.data)) if (r && typeof r.keyword === 'string' && num(r.volume) !== undefined) monthly.volume[r.keyword.toLowerCase()] = num(r.volume);
        ran = true;
      } catch (e) {
        problems += 1;
        if (!noteFor(e)) stop = stop ?? e;
      }
    }
    if (page?.host === 'custom') {
      try {
        const m = await runner.treg('web.metrics', { target: page.domain }, 'seo');
        const b = await runner.treg('web.backlinks', { target: page.domain }, 'seo');
        const metrics = m.data?.output?.metrics ?? m.data?.metrics ?? {};
        const firstPage = Array.isArray(metrics.pages) ? metrics.pages[0] : Array.isArray(m.data?.results) ? m.data.results[0] : metrics;
        const out = b.data?.output ?? b.data ?? {};
        monthly.authority = {
          ...(num(firstPage?.domain_inlink_rank ?? firstPage?.domain_authority) !== undefined ? { score: num(firstPage?.domain_inlink_rank ?? firstPage?.domain_authority) } : {}),
          ...(num(out.referring_domains) !== undefined ? { referringDomains: num(out.referring_domains) } : {}),
          ...(num(out.backlinks) !== undefined ? { backlinks: num(out.backlinks) } : {}),
          fetchedAt: new Date(now).toISOString(),
        };
        ran = true;
      } catch (e) {
        problems += 1;
        if (!noteFor(e)) stop = stop ?? e;
      }
    }
    if (ran) Object.assign(patch, { monthlyAt: new Date(now).toISOString(), monthly });
  }
  for (const k of data.keywords) {
    const v = monthly.volume?.[k.keyword.toLowerCase()];
    if (v !== undefined) k.volume = v;
  }
  if (page?.host === 'custom' && monthly.authority) data.authority = monthly.authority;

  const anything = data.keywords.some((k) => k.rank !== null || k.mapsPosition !== null) || data.gsc || data.google || (!problems && data.keywords.length);
  if (!anything && stop) throw stop;
  return {
    status: problems ? (anything ? 'partial' : 'error') : 'ok',
    errorCode: stop?.kind ? publicCode(stop) : problems && !anything ? 'UNAVAILABLE' : null,
    data,
    summary: { clicks: data.gsc?.clicks ?? null, impressions: data.gsc?.impressions ?? null, ranks: Object.fromEntries(data.keywords.map((k) => [k.keyword, k.rank])) },
    resolved: Object.keys(patch).length ? patch : null,
  };
}
