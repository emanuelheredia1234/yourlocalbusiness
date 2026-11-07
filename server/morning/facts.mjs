// What the morning action knows about a business: first-party data only, read in parallel and kept compact.
// Never leads' or buyers' personal data (counts and dates only), never competitors' text, never a provider's words.
// Strings from the owner (their notes) and from the Strategy (AI-written) are data: clipped, and quoted as such in
// the prompt (server/morning/prompt.mjs).
//
// A read that fails throws (the generation is then `failed`, UNAVAILABLE); a table that isn't there yet (an older
// database) counts as empty.

import { actionDayOf, addDays, localDateOf } from '../localTime.mjs';
import { DAY_MS, MORNING, iso } from './config.mjs';

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
/** Text as data: control characters out, whitespace collapsed, clipped. */
export const clip = (v, n) =>
  typeof v === 'string'
    ? Array.from(v.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim())
        .slice(0, n)
        .join('')
    : '';
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ms = (v) => {
  const t = typeof v === 'number' ? v : Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
};

/** A table missing (NOT_SET_UP) reads as empty; anything else is a failed read. */
async function soft(p, { badRequestEmpty = false } = {}) {
  try {
    return await p;
  } catch (e) {
    if (e?.code === 'NOT_SET_UP' || (badRequestEmpty && e?.code === 'BAD_REQUEST')) return [];
    throw e;
  }
}

const WEEK_MS = 7 * DAY_MS;
const STRATEGY_SECTIONS = ['research', 'promote', 'content', 'assets', 'outreach', 'plan'];

/**
 * The server's port of src/lib/strategy.ts derivedDone for the kinds it can see. link_settings and the others are
 * done only when the owner ticked them (the caller checks ticks).
 */
export function derivedDoneOf(a, p, s, ctx) {
  const m = obj(p.marketing);
  const studio = obj(p.studio);
  const pid = p.id;
  switch (a.kind) {
    case 'build_page': {
      const want = a.pageType ?? obj(obj(s.promote).page).pageType;
      const has = typeof m.pageType === 'string' && MORNING.pageTypes.includes(m.pageType) ? m.pageType : 'landing';
      return !!m.salesPage && (!want || has === want);
    }
    case 'publish_page':
      return !!m.seoPublished;
    case 'campaign_setup':
      return !!obj(s.applied).campaign || !!m.plan;
    case 'plan_30':
      return !!m.plan;
    case 'batch_7':
      return ctx.posts.some((x) => x.projectId === pid && x.source === 'batch');
    case 'calendar':
      return ctx.posts.some((x) => x.projectId === pid && x.status === 'scheduled');
    case 'lead_magnet':
      return !!m.leadMagnet;
    case 'welcome_emails':
      return arr(m.emails).length >= 5;
    case 'code_asset':
      return arr(studio.codeAssets).some((c) => !a.codeKind || c?.kind === a.codeKind);
    case 'listing':
      return ctx.listings.some((l) => l.projectId === pid);
    case 'listing_images':
      return !!obj(studio.listing).coverImageId;
    case 'product_file':
      return p.track === 'business' ? arr(studio.packages).length > 0 : arr(studio.productFiles).length > 0;
    case 'packages':
      return arr(studio.packages).length > 0;
    case 'socials':
      return Object.values(obj(obj(p.brand).socials)).some(Boolean);
    case 'website':
      return !!obj(p.brand).websiteUrl;
    case 'ads':
      return ctx.ads.some((x) => x.projectId === pid);
    default:
      return false;
  }
}

/** The Strategy's plan week now: 1–4, or 5 once the four weeks are up. */
const currentWeek = (startAt, now) => Math.min(5, Math.max(1, 1 + Math.floor((now - startAt) / WEEK_MS)));

/** What the business's Strategy says, compact (null without one). */
export function strategyFacts(p, ctx, now) {
  const s = obj(p.strategy);
  const has = STRATEGY_SECTIONS.some((k) => Object.keys(obj(s[k])).length > 0);
  const inputs = obj(s.inputs);
  const promote = obj(s.promote);
  const plan = obj(s.plan);
  const ticks = obj(s.ticks);
  const pageType = MORNING.pageTypes.includes(obj(promote.page).pageType) ? obj(promote.page).pageType : null;
  if (!has) return { has: false, goal: clip(inputs.goal, 200), notes: clip(inputs.notes, 200), pageType: null, plan: null };
  let planOut = null;
  const actions = arr(plan.actions).filter((a) => a && typeof a.id === 'string' && MORNING.kinds.includes(a.kind));
  if (actions.length && num(plan.startAt) != null) {
    const week = currentWeek(plan.startAt, now);
    const isDone = (a) => derivedDoneOf(a, p, s, ctx) || !!ticks[a.id];
    const open = actions.filter((a) => !isDone(a));
    const thisWeek = open.filter((a) => a.week === week);
    const ordered = [...thisWeek, ...open.filter((a) => !thisWeek.includes(a))].slice(0, 8);
    const wk = arr(plan.weeks).find((w) => w?.week === week) ?? {};
    planOut = {
      week,
      focus: clip(wk.focus, 120),
      goal: clip(wk.goal, 120),
      done: actions.length - open.length,
      total: actions.length,
      open: ordered.map((a) => ({
        id: clip(a.id, 60),
        kind: a.kind,
        week: [1, 2, 3, 4].includes(a.week) ? a.week : 1,
        title: clip(a.title, 100),
        ...(MORNING.pageTypes.includes(a.pageType) ? { pageType: a.pageType } : {}),
        ...(a.topic ? { topic: clip(a.topic, 80) } : {}),
        ...(MORNING.codeKinds.includes(a.codeKind) ? { codeKind: a.codeKind } : {}),
        ...(MORNING.leadMagnetTypes.includes(a.leadMagnetType) ? { leadMagnetType: a.leadMagnetType } : {}),
        ...(MORNING.platforms.includes(a.platform) ? { platform: a.platform } : {}),
      })),
    };
  }
  return {
    has: true,
    goal: clip(inputs.goal, 200),
    notes: clip(inputs.notes, 200),
    positioning: clip(obj(promote.positioning).line, 160),
    channels: arr(promote.channels)
      .slice(0, 3)
      .map((c) => clip(c?.name, 60))
      .filter(Boolean),
    pageType,
    plan: planOut,
  };
}

/** Post counts in the business's zone (ids of up to 3 due posts, with their headline as the owner wrote it). */
export function postFacts(posts, tz, now) {
  const today = localDateOf(now, tz);
  const planned = posts.filter((x) => x.status === 'scheduled');
  const at = (x) => ms(x.scheduledAt);
  const dueToday = planned.filter((x) => at(x) != null && localDateOf(at(x), tz) === today);
  const overdue = planned.filter((x) => at(x) != null && at(x) < now && localDateOf(at(x), tz) < today);
  const published = posts.map((x) => ms(x.publishedAt)).filter((t) => t != null);
  const last = published.length ? Math.max(...published) : null;
  const due = [...dueToday, ...overdue].sort((a, b) => at(a) - at(b)).slice(0, 3);
  return {
    drafts: posts.filter((x) => x.status === 'draft').length,
    plannedNext7: planned.filter((x) => at(x) != null && at(x) >= now && at(x) < now + WEEK_MS).length,
    dueToday: dueToday.length,
    overdue: overdue.length,
    posted7: published.filter((t) => t >= now - WEEK_MS).length,
    lastPosted: last == null ? null : localDateOf(last, tz),
    due: due.map((x) => ({ id: clip(x.id, 80), headline: clip(x.headline, 60) })),
  };
}

/** Numbers only from each analytics snapshot (never text, URLs or competitors' ads). */
function numbersOf(snap) {
  const values = {};
  const take = (k, v) => {
    if (Object.keys(values).length < 12 && /^[A-Za-z][A-Za-z0-9]{0,29}$/.test(k) && num(v) != null) values[k] = Math.round(v * 100) / 100;
  };
  for (const [k, v] of Object.entries(obj(snap.data))) {
    if (num(v) != null) take(k, v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) take(`${k}${k2.charAt(0).toUpperCase()}${k2.slice(1)}`, v2);
  }
  const currency = typeof obj(snap.data).currency === 'string' && /^[A-Za-z]{3}$/.test(snap.data.currency) ? snap.data.currency.toUpperCase() : null;
  return { source: snap.source, status: snap.status, fetchedAt: snap.fetched_at ?? null, values, ...(currency ? { currency } : {}) };
}

/** Keys and titles the business saw lately, and what the owner marked Not useful. */
export function historyFacts(rows, today) {
  const recentFrom = addDays(today, -MORNING.recentDays);
  const notUsefulFrom = addDays(today, -MORNING.notUsefulDays);
  const recent = [];
  const notUseful = [];
  for (const r of rows) {
    const cands = arr(r.candidates);
    if (r.local_date === today) continue;
    if (r.local_date >= recentFrom && Number.isInteger(r.chosen) && cands[r.chosen]) {
      const c = cands[r.chosen];
      recent.push({ key: String(c.key ?? ''), kind: c.kind, title: clip(c.title, 90), state: r.state });
    }
    if (r.local_date >= notUsefulFrom) {
      for (const f of arr(r.feedback)) {
        const c = cands[f?.i];
        if (c && notUseful.length < 10) notUseful.push({ key: String(c.key ?? ''), kind: c.kind, title: clip(c.title, 90), ...(f.reason ? { reason: f.reason } : {}), ...(f.note ? { note: clip(f.note, 200) } : {}) });
      }
    }
  }
  return { recent, notUseful };
}

/**
 * Everything the rules and the prompt need, read in parallel. tz: the zone the action day was worked out in.
 * → facts (see the header); throws when a read fails.
 */
export async function readFacts(db, { userId, projectId, tz, now }) {
  const u = { user_id: userId };
  const since30 = iso(now - 30 * DAY_MS);
  const today = actionDayOf(now, tz);
  const [docs, postRows, adRows, listingRows, snaps, leadRows, saleRows, offerRows, history] = await Promise.all([
    db.select('user_docs', { ...u, kind: 'project', id: projectId }, { select: 'id,data', limit: 1 }),
    soft(db.select('user_docs', { ...u, kind: 'post' }, { select: 'id,projectId:data->>projectId,status:data->>status,source:data->>source,scheduledAt:data->>scheduledAt,publishedAt:data->>publishedAt,headline:data->>headline', order: 'updated_at.desc', limit: 500 })),
    soft(db.select('user_docs', { ...u, kind: 'ad' }, { select: 'id,projectId:data->>projectId', limit: 500 })),
    soft(db.select('user_docs', { ...u, kind: 'listing' }, { select: 'id,projectId:data->>projectId', limit: 500 })),
    soft(db.select('analytics_snapshots', { ...u, project_id: projectId }, { select: 'source,status,fetched_at,data', limit: 10 })),
    soft(db.select('page_leads', { ...u, project_id: projectId, created_at: ['gte', since30] }, { select: 'created_at,source', limit: 1000 }), { badRequestEmpty: true }),
    soft(db.select('sales', { ...u, project_id: projectId, environment: 'production', status: ['in', ['paid', 'partially_refunded']], paid_at: ['gte', since30] }, { select: 'offer_id,amount_minor,currency,paid_at', limit: 1000 })),
    soft(db.select('offers', { ...u, project_id: projectId, status: 'active' }, { select: 'id,title,clicks', limit: 100 })),
    soft(db.select('daily_actions', { ...u, project_id: projectId, local_date: ['gte', addDays(today, -MORNING.notUsefulDays)] }, { select: 'local_date,state,candidates,chosen,feedback', order: 'local_date.desc', limit: 40 })),
  ]);
  const p = obj(docs?.[0]?.data);
  if (!docs?.[0]) throw Object.assign(new Error('The business isn’t there.'), { code: 'NOT_FOUND' });
  const posts = arr(postRows).filter((x) => x.projectId === projectId);
  const ctx = { posts, ads: arr(adRows), listings: arr(listingRows) };
  const strategy = strategyFacts({ ...p, id: projectId }, ctx, now);
  const m = obj(p.marketing);
  const brand = obj(p.brand);

  const leadTimes = arr(leadRows).map((r) => ms(r.created_at)).filter((t) => t != null);
  const seen = ms(m.leadsSeenAt);
  const bySource = {};
  for (const r of arr(leadRows)) bySource[['page', 'asset', 'magnet'].includes(r.source) ? r.source : 'page'] = (bySource[['page', 'asset', 'magnet'].includes(r.source) ? r.source : 'page'] ?? 0) + 1;
  const newest = leadTimes.length ? Math.max(...leadTimes) : null;

  const revenue = {};
  let lastPaid = null;
  const soldOffers = new Set();
  for (const s of arr(saleRows)) {
    const cur = /^[a-z]{3}$/.test(String(s.currency)) ? s.currency.toUpperCase() : 'USD';
    revenue[cur] = (revenue[cur] ?? 0) + (Number(s.amount_minor) || 0) / 100;
    const t = ms(s.paid_at);
    if (t != null && (lastPaid == null || t > lastPaid)) lastPaid = t;
    if (s.offer_id) soldOffers.add(s.offer_id);
  }
  for (const k of Object.keys(revenue)) revenue[k] = Math.round(revenue[k]);

  return {
    projectId,
    today,
    timeZone: tz,
    business: {
      brand: clip(brand.name ?? p.name, 80),
      track: clip(p.track, 20),
      businessType: clip(p.businessType, 60),
      niche: clip(p.niche, 80),
      category: clip(p.category, 60),
      place: p.location ? [clip(p.location.city, 60), clip(p.location.region, 60)].filter(Boolean).join(', ') : '',
      summary: clip(p.summary, 300),
      hasWebsite: !!brand.websiteUrl,
      socials: Object.entries(obj(brand.socials))
        .filter(([, v]) => !!v)
        .map(([k]) => clip(k, 20))
        .slice(0, 8),
      onboarded: p.onboarded === true,
    },
    strategy,
    fresh: !strategy.has && posts.length === 0,
    posts: postFacts(posts, tz, now),
    page: { built: !!m.salesPage, type: MORNING.pageTypes.includes(m.pageType) ? m.pageType : 'landing', published: !!m.seoPublished },
    leadMagnet: !!m.leadMagnet,
    emails: arr(m.emails).length,
    numbers: arr(snaps).map(numbersOf),
    leads: {
      last7: leadTimes.filter((t) => t >= now - WEEK_MS).length,
      last30: leadTimes.length,
      bySource,
      newest: newest == null ? null : iso(newest).slice(0, 10),
      newSinceSeen: seen == null ? leadTimes.filter((t) => t >= now - 2 * DAY_MS).length : leadTimes.filter((t) => t > seen).length,
    },
    sales: {
      paid30: arr(saleRows).length,
      revenue,
      lastPaid: lastPaid == null ? null : iso(lastPaid).slice(0, 10),
      lastPaidAt: lastPaid,
      activeOffers: arr(offerRows).length,
      stuckOffers: arr(offerRows)
        .filter((o) => (Number(o.clicks) || 0) >= 20 && !soldOffers.has(o.id))
        .sort((a, b) => (Number(b.clicks) || 0) - (Number(a.clicks) || 0))
        .slice(0, 2)
        .map((o) => ({ title: clip(o.title, 60), clicks: Number(o.clicks) || 0 })),
    },
    history: historyFacts(arr(history), today),
  };
}
