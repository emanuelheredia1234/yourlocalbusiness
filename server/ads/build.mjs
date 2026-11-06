// Building the exact Zernio request from a saved plan (spec §6). Pure functions, no I/O: the plan and project come
// from the user's own saved docs (never the browser's copy), the ad account from a fresh list, the customer's picks
// from the review token. Everything that depends on time is computed from `builtAt` (the preview's clock) in the ad
// account's time zone, so a rebuild minutes later is byte-identical and its hash matches (§3.3).
//
//   buildLaunch({ platform, plan, project, account, zid, picks, launchKey, builtAt, mediaUrl })
//     → { body, blockers, warnings, leftOut, claims, ads, targeting, dates, plannedTotal, summary, … }
//   canonical(value) / hashOf(value)       sorted-key JSON and its sha256
//   metaCreativeFor(...) / searchTextFor(...) the creative swap bodies (§9.1)
//   dates helpers: todayIn(tz, t), addDays(ymd, n), localInstant(ymd, hms, tz), withOffset(ymd, hms, tz)
//
// R3: a launch always sends status, campaignStatus, adSetStatus and adStatus. Ad set and ad are ACTIVE, the campaign
// holds the money (R11): the campaign is always created PAUSED (Meta and Google) and switched on only by the launch's
// own next step (after Meta's spending limit is set), so a create that answers late can never be live untracked
// (server/ads/writes.mjs). R4: only the plan's own text is sent; Google gets
// at least 3 headlines and 2 descriptions, Meta gets every creative feature OPT_OUT; claim words need a tick.

import crypto from 'node:crypto';
import { findClaims, unconfirmed } from './claims.mjs';
import { note } from './messages.mjs';
import { PLATFORM_LABEL } from './contracts.mjs';
import { dailyProblem, timesDays } from './money.mjs';

/** The planner's buttons (src/lib/ads.ts AD_CTAS) → Meta's callToAction enum. */
export const CTA_MAP = Object.freeze({ 'Learn More': 'LEARN_MORE', 'Shop Now': 'SHOP_NOW', 'Book Now': 'BOOK_NOW', 'Sign Up': 'SIGN_UP', Download: 'DOWNLOAD', 'Get Quote': 'GET_QUOTE', 'Contact Us': 'CONTACT_US', 'Get Offer': 'GET_OFFER' });
/** Meta's documented creative enhancements, all off (anything not sent defaults to OPT_OUT as well). */
export const CREATIVE_FEATURES = Object.freeze({ enhance_cta: 'OPT_OUT', image_brightness_and_contrast: 'OPT_OUT', text_optimizations: 'OPT_OUT' });
/** EU and EEA countries: Meta needs DSA payer/beneficiary details the app doesn't collect in v1. */
export const EU_EEA = Object.freeze(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO']);
/**
 * Meta refuses a campaign spending limit below about 100 US dollars. In USD the limit is at least that (the daily
 * budget and the last day keep the spend to the planned total); other currencies keep the planned total, and a
 * refusal leaves the campaign paused with CAP_NOT_SET.
 */
export const META_MIN_SPEND_CAP = Object.freeze({ USD: 100 });
export const metaSpendCap = (plannedTotal, currency) => (plannedTotal > 0 && Object.hasOwn(META_MIN_SPEND_CAP, currency) ? Math.max(plannedTotal, META_MIN_SPEND_CAP[currency]) : plannedTotal);
const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc', 'rb.gy', 'lnkd.in'];
export const LIMITS = Object.freeze({ metaHeadline: 255, metaHeadlineWarn: 40, metaBody: 2000, metaDescription: 255, googleHeadline: 30, googleDescription: 90, keyword: 80, maxDays: 90 });
export const META_MIN_RADIUS_MI = 10;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '');

// ───────────── canonical form and hashes ─────────────

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
export const hashOf = (v) => crypto.createHash('sha256').update(canonical(v)).digest('hex');

// ───────────── dates in the ad account's time zone ─────────────

export function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** The calendar day it is in `tz` at time t: 'YYYY-MM-DD'. */
export function todayIn(tz, t) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

export const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b ('YYYY-MM-DD'), b − a. */
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** The UTC offset of `tz` at instant t, in minutes (e.g. -360 for America/Chicago in winter). */
function offsetMinutes(tz, t) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t));
  const get = (k) => Number(parts.find((p) => p.type === k)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / 60_000);
}

/** The instant a wall-clock time in `tz` happens (ms). */
export function localInstant(ymd, hms, tz) {
  const guess = Date.parse(`${ymd}T${hms}Z`);
  let t = guess - offsetMinutes(tz, guess) * 60_000;
  t = guess - offsetMinutes(tz, t) * 60_000;
  return t;
}

/** '2026-12-14T23:59:59-06:00': a wall-clock time in `tz` with its explicit offset (Meta end dates on change). */
export function withOffset(ymd, hms, tz) {
  const off = offsetMinutes(tz, localInstant(ymd, hms, tz));
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${ymd}T${hms}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** "Mon 1 Dec 2026" */
export function dayLabel(ymd) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${ymd}T00:00:00Z`)).replace(/,/g, '');
}

// ───────────── the parts both platforms share ─────────────

/** The page the ads send people to: the plan's own, else the website or buy link. '' when there is none. */
export function finalUrlOf(plan, project) {
  // as the planner does (src/lib/ads.ts adFinalUrl): the plan's own field when it has one, even when it's empty
  const raw = typeof plan?.finalUrl === 'string' ? str(plan.finalUrl) : str(project?.brand?.websiteUrl) || str(project?.studio?.listing?.buyUrl);
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/** Whether a final URL may be sent: https, a real host, not a link shortener. */
export function finalUrlProblem(url) {
  if (!url) return 'NO_FINAL_URL';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return 'NO_FINAL_URL';
    if (SHORTENERS.includes(u.hostname.replace(/^www\./, '').toLowerCase())) return 'NO_FINAL_URL';
    return null;
  } catch {
    return 'NO_FINAL_URL';
  }
}

/** The goal Zernio gets: traffic (leads and sales too, with a note) or awareness. */
export const goalOf = (objective) => (objective === 'awareness' ? 'awareness' : 'traffic');

/** The launch's names: "<plan> · Meta · YLB <12 hex>", at most 120 characters with the level suffix (plan name cut first). */
export function namesFor(planName, platform, launchKey) {
  const tag = `YLB ${String(launchKey).replace(/-/g, '').slice(0, 12)}`;
  const tail = ` · ${PLATFORM_LABEL[platform]} · ${tag}`;
  const room = 100 - tail.length;
  const base = str(planName).replace(/\s+/g, ' ').slice(0, Math.max(1, room)).trim() || 'Ad plan';
  const name = `${base}${tail}`;
  return { tag, name, campaignName: name, adSetName: `${name} · Ad set`, adName: `${name} · Ad` };
}

/** Keyword syntax: [kw] exact, "kw" phrase, else broad. */
export function keywordOf(raw) {
  const s = str(raw);
  let m = /^\[(.+)\]$/.exec(s);
  if (m) return { text: m[1].trim(), matchType: 'exact' };
  m = /^"(.+)"$/.exec(s);
  if (m) return { text: m[1].trim(), matchType: 'phrase' };
  return { text: s, matchType: 'broad' };
}

const dedupe = (list) => {
  const seen = new Set();
  const out = [];
  for (const x of list.map(str).filter(Boolean)) {
    const k = x.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
};

/** The dates of a launch, in the account's zone: { today, startDay, endDay, startDate?, endDate, startAt, endAt, problem? }. */
export function launchDates({ platform, picks, tz, builtAt }) {
  const today = todayIn(tz, builtAt);
  const days = picks.durationDays;
  if (!Number.isInteger(days) || days < 1 || days > LIMITS.maxDays) return { today, problem: 'BAD_DATES' };
  if (picks.startDate != null && !isYmd(picks.startDate)) return { today, problem: 'BAD_DATES' };
  const startDay = picks.startDate ?? today;
  if (startDay < today) return { today, problem: 'START_IN_PAST' };
  const endDay = addDays(startDay, days - 1);
  const time = platform === 'meta' && typeof picks.startTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(picks.startTime) ? picks.startTime : null;
  // "As soon as approved" omits startDate (omitted = starts immediately), so the body doesn't change before the send
  const startDate = picks.startDate == null ? undefined : platform === 'meta' && time ? `${startDay}T${time}:00` : startDay;
  return {
    today,
    startDay,
    endDay,
    days,
    startDate,
    endDate: endDay,
    time,
    asap: picks.startDate == null,
    startAt: new Date(picks.startDate == null ? builtAt : localInstant(startDay, time ? `${time}:00` : '00:00:00', tz)).toISOString(),
    endAt: new Date(localInstant(endDay, '23:59:59', tz)).toISOString(),
  };
}

// ───────────── the launch ─────────────

/**
 * platform 'meta'|'google'; plan: the saved AdCampaign; project: the saved project; account: { adAccountId, name,
 * idTail, currency, timezone, minDaily }; zid: the business's Zernio connection; picks (normalized, from the token):
 * { status, startDate, startTime, dailyBudget, durationDays, locations: [{key, name, kind, cc}], radiusMi,
 * interests: [{id, name}], creativeIds, languages, claimsConfirmed, specialCategory }; launchKey; builtAt;
 * mediaUrl(creative) → { url, madeBy } | null (Meta images: a public link minted with builtAt) or throws NO_IMAGE_LINKS.
 */
export function buildLaunch({ platform, plan, project, account, zid, picks, launchKey, builtAt, mediaUrl = () => null }) {
  const blockers = [];
  const warnings = [];
  const leftOut = [];
  const block = (code, ctx) => blockers.push(note(code, { platform, ...ctx }));
  const warn = (code, ctx) => warnings.push(note(code, { platform, ...ctx }));
  const left = (code, ctx) => leftOut.push(note(code, { platform, ...ctx }));
  const currency = account.currency;
  const tz = account.timezone;

  if (picks.specialCategory === 'yes') block('SPECIAL_CATEGORY');
  else if (picks.specialCategory !== 'none') block('SPECIAL_CATEGORY_UNANSWERED');
  if (!['PAUSED', 'ACTIVE'].includes(picks.status)) block('CONFIRM_REQUIRED');

  const linkUrl = finalUrlOf(plan, project);
  if (finalUrlProblem(linkUrl)) block('NO_FINAL_URL');

  const dp = dailyProblem(picks.dailyBudget, platform === 'meta' ? account.minDaily : 1);
  if (dp) block(dp, { currency, min: account.minDaily });

  const dates = validTimeZone(tz) ? launchDates({ platform, picks, tz, builtAt }) : { problem: 'GOOGLE_NO_TIMEZONE' };
  if (dates.problem) block(dates.problem);
  else if (dates.asap) warn('START_DAY_COUNTS');

  const goal = goalOf(plan.objective);
  if (plan.objective === 'leads' || plan.objective === 'sales') warn('GOAL_NOTE');

  // places: never empty, never a city together with its own country (Meta refuses the overlap)
  let locations = Array.isArray(picks.locations) ? picks.locations.filter((l) => isObj(l) && l.key) : [];
  if (!locations.length) block('NO_LOCATION');
  const inside = new Set(locations.filter((l) => l.kind !== 'country').map((l) => l.cc).filter(Boolean));
  const dropped = locations.filter((l) => l.kind === 'country' && inside.has(String(l.key).toUpperCase()));
  for (const d of dropped) warn('COUNTRY_DROPPED', { name: d.name });
  locations = locations.filter((l) => !dropped.includes(l));
  if (platform === 'meta' && locations.some((l) => EU_EEA.includes(String(l.cc ?? (l.kind === 'country' ? l.key : '')).toUpperCase()))) block('EU_TARGETING');

  const names = namesFor(plan.name, platform, launchKey);
  const days = Number.isInteger(picks.durationDays) ? picks.durationDays : 0;
  const plannedTotal = Number.isInteger(picks.dailyBudget) && days > 0 ? timesDays(picks.dailyBudget, days, currency) : 0;
  // the campaign is created PAUSED whatever the choice; the launch switches it on afterwards (Meta: after its limit)
  const statuses = { status: 'PAUSED', campaignStatus: 'PAUSED', adSetStatus: 'ACTIVE', adStatus: 'ACTIVE' };
  const spendCap = platform === 'meta' ? metaSpendCap(plannedTotal, currency) : null;
  if (spendCap != null && plannedTotal > 0 && spendCap > plannedTotal) warn('CAP_MINIMUM', { currency, cap: spendCap, amount: plannedTotal });
  const common = {
    accountId: zid,
    adAccountId: account.adAccountId,
    name: names.name,
    campaignName: names.campaignName,
    adSetName: names.adSetName,
    adName: names.adName,
    goal,
    budgetAmount: picks.dailyBudget,
    budgetType: 'daily',
    ...(dates.startDate ? { startDate: dates.startDate } : {}),
    ...(dates.endDate ? { endDate: dates.endDate } : {}),
    ...statuses,
  };

  const texts = [];
  let body;
  let ads = [];
  const targeting = locations.map((l) => l.name);

  if (platform === 'meta') {
    const asked = Number.isFinite(picks.radiusMi) && picks.radiusMi > 0 ? Math.round(picks.radiusMi) : META_MIN_RADIUS_MI;
    if (asked < META_MIN_RADIUS_MI && locations.some((l) => l.kind === 'city')) warn('RADIUS_RAISED');
    const miles = Math.min(50, Math.max(META_MIN_RADIUS_MI, asked));
    const geo = {
      countries: locations.filter((l) => l.kind === 'country').map((l) => String(l.key).toUpperCase()),
      cities: locations.filter((l) => l.kind === 'city').map((l) => ({ key: String(l.key), radius: miles, distance_unit: 'mile' })),
      regions: locations.filter((l) => l.kind === 'region').map((l) => ({ key: String(l.key) })),
      zips: locations.filter((l) => l.kind === 'zip').map((l) => ({ key: String(l.key) })),
    };
    for (const k of Object.keys(geo)) if (!geo[k].length) delete geo[k];
    const interests = (Array.isArray(picks.interests) ? picks.interests : []).filter((i) => isObj(i) && i.id).map((i) => ({ id: String(i.id), name: str(i.name) }));
    for (const want of Array.isArray(plan.interests) ? plan.interests : []) {
      if (!interests.some((i) => i.name.toLowerCase() === str(want).toLowerCase())) left('INTEREST_UNMATCHED', { name: want });
    }
    // creatives: the picked A/B/C, 1 to 3
    const ids = Array.isArray(picks.creativeIds) && picks.creativeIds.length ? picks.creativeIds : Array.isArray(plan.selectedCreativeIds) ? plan.selectedCreativeIds : [];
    const picked = ids.map((id) => (plan.creatives ?? []).find((c) => c?.id === id)).filter(Boolean);
    const allowed = new Set(Array.isArray(plan.selectedCreativeIds) ? plan.selectedCreativeIds : []);
    if (!picked.length || picked.length > 3 || picked.length !== ids.length || picked.some((c) => !allowed.has(c.id))) block('NO_CREATIVE');
    let anyAi = false;
    const items = picked.slice(0, 3).map((c) => {
      const headline = str(c.headline);
      const primary = str(c.primaryText);
      const description = str(c.description);
      texts.push({ field: `Ad ${c.variant} headline`, text: headline }, { field: `Ad ${c.variant} text`, text: primary }, { field: `Ad ${c.variant} description`, text: description });
      if (!headline || !primary) block('TEXT_MISSING', { field: `Ad ${c.variant}` });
      if (headline.length > LIMITS.metaHeadline) block('TEXT_TOO_LONG', { field: `Ad ${c.variant} headline`, max: LIMITS.metaHeadline });
      else if (headline.length > LIMITS.metaHeadlineWarn) warn('HEADLINE_LONG', { field: `Ad ${c.variant}` });
      if (primary.length > LIMITS.metaBody) block('TEXT_TOO_LONG', { field: `Ad ${c.variant} text`, max: LIMITS.metaBody });
      if (description.length > LIMITS.metaDescription) block('TEXT_TOO_LONG', { field: `Ad ${c.variant} description`, max: LIMITS.metaDescription });
      const cta = CTA_MAP[str(c.cta)] ?? 'LEARN_MORE';
      if (!CTA_MAP[str(c.cta)]) warn('CTA_DEFAULTED', { field: `Ad ${c.variant}` });
      let media = null;
      if (c.format === 'video' || c.format === 'reel' || c.media?.kind === 'video') block('VIDEO_NOT_READY');
      else {
        try {
          media = c.media?.mediaId ? mediaUrl(c) : null;
        } catch (e) {
          if (e?.code === 'NO_IMAGE_LINKS') block('NO_IMAGE_LINKS');
          else throw e;
          media = undefined;
        }
        if (media === null) block('NO_IMAGE', { field: `Ad ${c.variant}` });
      }
      if (media?.madeBy === 'ai' || c.media?.madeBy === 'ai') anyAi = true;
      return { variant: c.variant, id: c.id, headline, body: primary, description, callToAction: cta, imageUrl: media?.url ?? '', linkUrl, mediaId: c.media?.mediaId ?? null };
    });
    ads = items.map((i) => ({ variant: i.variant, creativeId: i.id, headline: i.headline, body: i.body, description: i.description, callToAction: i.callToAction, linkUrl: i.linkUrl, mediaId: i.mediaId }));
    const shape =
      items.length > 1
        ? { creatives: items.map((i) => ({ name: `${names.adName} ${i.variant}`, headline: i.headline, body: i.body, ...(i.description ? { description: i.description } : {}), callToAction: i.callToAction, imageUrl: i.imageUrl, linkUrl: i.linkUrl })) }
        : items.length === 1
          ? { headline: items[0].headline, body: items[0].body, ...(items[0].description ? { description: items[0].description } : {}), callToAction: items[0].callToAction, imageUrl: items[0].imageUrl, linkUrl: items[0].linkUrl }
          : { linkUrl };
    const ageMin = Math.max(13, Math.min(65, Number.isInteger(plan.ageMin) ? plan.ageMin : 18));
    const ageMax = Math.max(ageMin, Math.min(65, Number.isInteger(plan.ageMax) ? plan.ageMax : 65));
    body = {
      ...common,
      budgetLevel: 'adset',
      ...geo,
      ageMin,
      ageMax,
      gender: 'all',
      advantageAudience: 0,
      ...(interests.length ? { interests } : {}),
      ...shape,
      // top level only: with creatives[] an item's own map would replace the whole default map
      creativeFeatures: { ...CREATIVE_FEATURES },
      multiAdvertiser: 'OPT_OUT',
      aiDisclosure: anyAi ? 'OPT_IN' : 'OPT_OUT',
    };
    targeting.push(`Ages ${ageMin}–${ageMax}`, ...(geo.cities?.length ? [`${miles} miles around each city`] : []), ...interests.map((i) => `Interest: ${i.name}`));
  } else {
    const s = isObj(plan.search) ? plan.search : null;
    if (!s) block('NO_SEARCH_AD');
    const headlines = dedupe(s?.headlines ?? []);
    const descriptions = dedupe(s?.descriptions ?? []);
    if (s && (headlines.length < 3 || descriptions.length < 2)) block('TOO_FEW_HEADLINES');
    if (headlines.length > 15 || descriptions.length > 4) block('TOO_MANY_HEADLINES');
    headlines.forEach((h, i) => {
      texts.push({ field: `Headline ${i + 1}`, text: h });
      if (h.length > LIMITS.googleHeadline) block('TEXT_TOO_LONG', { field: `Headline ${i + 1}`, max: LIMITS.googleHeadline });
    });
    descriptions.forEach((d, i) => {
      texts.push({ field: `Description ${i + 1}`, text: d });
      if (d.length > LIMITS.googleDescription) block('TEXT_TOO_LONG', { field: `Description ${i + 1}`, max: LIMITS.googleDescription });
    });
    const keywords = dedupe(s?.keywords ?? []).map(keywordOf).filter((k) => k.text);
    if (s && !keywords.length) block('NO_KEYWORDS');
    keywords.forEach((k) => {
      texts.push({ field: 'Keyword', text: k.text });
      if (k.text.length > LIMITS.keyword) block('TEXT_TOO_LONG', { field: `Keyword “${k.text.slice(0, 20)}…”`, max: LIMITS.keyword });
    });
    const languages = dedupe(Array.isArray(picks.languages) && picks.languages.length ? picks.languages : ['en']).map((l) => l.toLowerCase()).filter((l) => /^[a-z]{2}$/.test(l));
    const t = {
      countries: locations.filter((l) => l.kind === 'country').map((l) => String(l.key).toUpperCase()),
      regions: locations.filter((l) => l.kind === 'region').map((l) => ({ key: String(l.key) })),
      cities: locations.filter((l) => l.kind === 'city').map((l) => ({ key: String(l.key) })),
      zips: locations.filter((l) => l.kind === 'zip').map((l) => ({ key: String(l.key) })),
    };
    for (const k of Object.keys(t)) if (!t[k].length) delete t[k];
    if (Number.isFinite(picks.radiusMi) && picks.radiusMi > 0) left('GOOGLE_NO_RADIUS');
    left('GOOGLE_NO_AGE');
    body = {
      ...common,
      campaignType: 'search',
      headline: headlines[0] ?? '',
      additionalHeadlines: headlines.slice(1, 15),
      body: descriptions[0] ?? '',
      additionalDescriptions: descriptions.slice(1, 4),
      linkUrl,
      keywords: keywords.map((k) => (k.matchType === 'broad' ? k.text : { text: k.text, matchType: k.matchType })),
      locationTargetingType: 'presence',
      targeting: { ...t, languages: languages.length ? languages : ['en'] },
    };
    ads = [{ variant: 'Search', headlines, descriptions, keywords: keywords.map((k) => (k.matchType === 'exact' ? `[${k.text}]` : k.matchType === 'phrase' ? `"${k.text}"` : k.text)), linkUrl }];
    targeting.push(`Languages: ${(languages.length ? languages : ['en']).join(', ')}`);
  }

  const claims = findClaims(texts);
  const open = unconfirmed(claims, picks.claimsConfirmed);
  for (const c of open) block('CLAIM_UNCONFIRMED', { phrase: c.phrase, field: c.field });

  const summary = {
    platform,
    account: { name: account.name, idTail: account.idTail, currency, timezone: tz },
    status: picks.status,
    daily: picks.dailyBudget,
    days,
    start: dates.startDay ?? null,
    startTime: dates.time ?? null,
    asap: dates.asap ?? null,
    end: dates.endDay ?? null,
    plannedTotal,
    spendCap,
    ads: ads.map((a) => a.variant),
    linkUrl,
    claimsConfirmed: claims.filter((c) => !open.includes(c)).map((c) => c.phrase),
  };

  return {
    body,
    blockers,
    warnings,
    leftOut,
    claims: claims.map((c) => ({ ...c, confirmed: !open.includes(c) })),
    ads,
    targeting,
    goal,
    names,
    dates,
    plannedTotal,
    spendCap,
    summary,
    bodyHash: hashOf(body),
    summaryHash: hashOf(summary),
  };
}

/** The body as stored in ad_campaigns.sent_body: every image link (a 30-minute public capability) as media:<id>. */
export function storedBody(body, ads) {
  const ids = new Map((ads ?? []).filter((a) => a.mediaId).map((a, i) => [i, a.mediaId]));
  const clone = structuredClone(body);
  if (Array.isArray(clone.creatives)) clone.creatives.forEach((c, i) => c.imageUrl && (c.imageUrl = `media:${ids.get(i) ?? 'unknown'}`));
  else if (clone.imageUrl) clone.imageUrl = `media:${ids.get(0) ?? 'unknown'}`;
  return clone;
}

// ───────────── creative swaps (§9.1) ─────────────

/** A Meta creative swap: every field, from one of the plan's creatives. → { creative, blockers, claims } */
export function metaCreativeFor({ plan, project, creative, mediaUrl, claimsConfirmed }) {
  const blockers = [];
  const linkUrl = finalUrlOf(plan, project);
  if (finalUrlProblem(linkUrl)) blockers.push(note('NO_FINAL_URL'));
  const headline = str(creative?.headline);
  const body = str(creative?.primaryText);
  const description = str(creative?.description);
  if (!headline || !body) blockers.push(note('TEXT_MISSING', { field: `Ad ${creative?.variant ?? ''}` }));
  if (headline.length > LIMITS.metaHeadline) blockers.push(note('TEXT_TOO_LONG', { platform: 'meta', field: 'Headline', max: LIMITS.metaHeadline }));
  let media = null;
  if (creative?.format === 'video' || creative?.format === 'reel') blockers.push(note('VIDEO_NOT_READY'));
  else {
    try {
      media = creative?.media?.mediaId ? mediaUrl(creative) : null;
    } catch (e) {
      if (e?.code === 'NO_IMAGE_LINKS') blockers.push(note('NO_IMAGE_LINKS'));
      else throw e;
      media = undefined;
    }
    if (media === null) blockers.push(note('NO_IMAGE'));
  }
  const claims = findClaims([{ field: 'Headline', text: headline }, { field: 'Text', text: body }, { field: 'Description', text: description }]);
  const open = unconfirmed(claims, claimsConfirmed);
  for (const c of open) blockers.push(note('CLAIM_UNCONFIRMED', { phrase: c.phrase }));
  return {
    creative: { headline, body, description, callToAction: CTA_MAP[str(creative?.cta)] ?? 'LEARN_MORE', linkUrl, imageUrl: media?.url ?? '' },
    mediaId: creative?.media?.mediaId ?? null,
    blockers,
    claims: claims.map((c) => ({ ...c, confirmed: !open.includes(c) })),
  };
}

/** A Google search ad's text swap, from the plan's current search ad. → { headlines, descriptions, finalUrls, blockers, claims } */
export function searchTextFor({ plan, project, claimsConfirmed }) {
  const blockers = [];
  const s = isObj(plan?.search) ? plan.search : null;
  if (!s) blockers.push(note('NO_SEARCH_AD'));
  const headlines = dedupe(s?.headlines ?? []);
  const descriptions = dedupe(s?.descriptions ?? []);
  if (headlines.length < 3 || descriptions.length < 2) blockers.push(note('TOO_FEW_HEADLINES'));
  if (headlines.length > 15 || descriptions.length > 4) blockers.push(note('TOO_MANY_HEADLINES'));
  for (const h of headlines) if (h.length > LIMITS.googleHeadline) blockers.push(note('TEXT_TOO_LONG', { platform: 'google', field: 'A headline', max: LIMITS.googleHeadline }));
  for (const d of descriptions) if (d.length > LIMITS.googleDescription) blockers.push(note('TEXT_TOO_LONG', { platform: 'google', field: 'A description', max: LIMITS.googleDescription }));
  const linkUrl = finalUrlOf(plan, project);
  if (finalUrlProblem(linkUrl)) blockers.push(note('NO_FINAL_URL'));
  const claims = findClaims([...headlines.map((text) => ({ field: 'Headline', text })), ...descriptions.map((text) => ({ field: 'Description', text }))]);
  const open = unconfirmed(claims, claimsConfirmed);
  for (const c of open) blockers.push(note('CLAIM_UNCONFIRMED', { phrase: c.phrase }));
  return { headlines, descriptions, finalUrls: [linkUrl], blockers, claims: claims.map((c) => ({ ...c, confirmed: !open.includes(c) })) };
}
