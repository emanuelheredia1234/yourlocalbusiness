// The Strategy tab's data: reading it safely (anything can be stored: old builds, backups, other devices),
// keeping it small, its sources, the facts it was written from, what's stale, and progress on the plan.
// Pure: it never imports the store (src/lib/strategyWrite.ts writes; strategyTasks.ts and node tests import this).
import type { AdCampaign, CampaignConfig, LeadMagnetType, LinkPlacement, Listing, PageType, Post, PostPlatform, PostType, Project } from './types';
import type {
  ActionKind,
  AppliedRecord,
  ApplyArea,
  AssetKind,
  ChannelType,
  FindingTopic,
  MeasureWhere,
  OutreachPurpose,
  OwnerFacts,
  SeoCta,
  StrategyAction,
  StrategyFinding,
  StrategyInputs,
  StrategyManus,
  StrategyRun,
  StrategySource,
  StrategyState,
  StrategyStep,
} from './strategyTypes';
import { hashStr, fmtRelative } from './utils';
import { pageTypeOf } from './pageTypes';
import { LINK_PLACEMENTS, placementFor } from './pageLink';
import {
  POST_NETWORKS,
  STRATEGY_CAPS as C,
  STRATEGY_STEPS,
  TICK_KEY,
  clip,
  domainOf,
  enumOf,
  isHttpUrl,
  normalizeAssets,
  normalizeContent,
  normalizeFindings,
  normalizeOutreach,
  normalizePlan,
  normalizePromote,
  normalizeStepInfo,
  numbersIn,
  obj,
  sourceKey,
  statementText,
  strategyNetworks,
  RESEARCH_REASONS,
  type NormCtx,
} from './strategyNormalize';
import { LEAD_MAGNET_TYPES } from '@/ai/local/email';
import { PAGE_TYPES } from './pageTypes';

export { STRATEGY_STEPS, domainOf, isHttpUrl, sourceKey };

// ───────────── labels ─────────────

export const STEP_LABEL: Record<StrategyStep, string> = {
  research: 'Researching your market',
  promote: 'Choosing where to promote',
  content: 'Planning social content',
  assets: 'Picking assets and your SEO page',
  outreach: 'Writing outreach emails',
  plan: 'Writing your plan',
};
export const TOPIC_LABEL: Record<FindingTopic, string> = {
  buyers: 'Where buyers look',
  social: 'Social content that gets attention',
  promote: 'Where similar businesses promote',
  offers: 'Offers and pages that bring leads',
  outreach: 'Email and follow-up',
  seo: 'What people search for',
  other: 'Other findings',
};
export const CHANNEL_LABEL: Record<ChannelType, string> = {
  social: 'Social media',
  search: 'Search & maps',
  marketplace: 'Marketplace',
  directory: 'Directory',
  community: 'Community',
  partners: 'Partners',
  email: 'Email',
  ads: 'Paid ads',
  offline: 'In person',
  other: 'Other',
};
export const ASSET_LABEL: Record<AssetKind, string> = {
  page: 'Web page',
  lead_magnet: 'Lead magnet',
  emails: 'Welcome emails',
  code: 'Interactive tool',
  listing: 'Marketplace listing',
  listing_images: 'Listing images',
  video: 'Video',
  product_file: 'Product file',
  packages: 'Packages',
  other: 'Other',
};
export const ACTION_LABEL: Record<ActionKind, string> = {
  build_page: 'Build this page',
  publish_page: 'Publish your page',
  link_settings: 'Set where links go',
  campaign_setup: 'Open Campaign setup',
  plan_30: 'Write the 30-day plan',
  batch_7: 'Make a 7-day batch',
  write_post: 'Write this post',
  calendar: 'Open the calendar',
  lead_magnet: 'Write the lead magnet',
  welcome_emails: 'Write the welcome emails',
  outreach: 'Open the emails',
  code_asset: 'Open Code & assets',
  listing: 'Open Listing & publish',
  listing_images: 'Add listing images',
  product_file: 'Open Product files',
  packages: 'Set your packages',
  socials: 'Add your social handles',
  website: 'Add your website',
  brain: 'Open the Brain',
  ads: 'Plan an ad',
  // no button: done outside the app, ticked by the owner
  offline: 'Outside the app',
};
export const GOAL_LABEL: Record<CampaignConfig['goal'], string> = { awareness: 'Get known', leads: 'Get leads', sales: 'Make sales' };
export const PURPOSE_LABEL: Record<OutreachPurpose, string> = { partner: 'Partner', referral: 'Referral', past_customer: 'Past customer', collab: 'Collaboration', press: 'Press', wholesale: 'Wholesale', other: 'Other' };
export const WHERE_LABEL: Record<MeasureWhere, string> = { app: 'In the app', network: 'On the network', booking: 'In your booking tool', payments: 'In your payment tool', email: 'In your email tool', other: 'Elsewhere' };
export const CTA_LABEL: Record<SeoCta, string> = { book: 'Book a time', buy: 'Buy now', contact: 'Get in touch', join: 'Join', download: 'Get the free download' };
export const LEAD_MAGNET_LABEL = Object.fromEntries(LEAD_MAGNET_TYPES.map((t) => [t.id, t.label])) as Record<LeadMagnetType, string>;
/** "none / some / more / most" for the post mix's weights 0-3. */
export const MIX_WORD = ['none', 'some', 'more', 'most'] as const;
export const POST_TYPE_WORD: Record<PostType, string> = { educational: 'how-tos', tip: 'tips', question: 'questions', sales: 'sales posts', bts: 'behind-the-scenes posts' };

// ───────────── an empty strategy, and reading one ─────────────

export function emptyStrategy(): StrategyState {
  return { v: 1, inputs: { goal: '', budget: '', timePerWeek: '', competitors: [], tried: '', notes: '' }, useBrain: true, maxSearches: 5, sources: [], nextSource: 1, ticks: {}, applied: {}, updatedAt: 0 };
}

/** The owner's own numbers and words (prices, budget, goal, their texts): claims and numbers in them are facts the owner gave. */
export function ownerFacts(p: Project, inputs: StrategyInputs): OwnerFacts {
  const words = [
    inputs.goal,
    inputs.budget,
    inputs.timePerWeek,
    inputs.tried,
    inputs.notes,
    ...inputs.competitors,
    p.summary,
    p.brand.name,
    p.brand.pitch,
    p.brand.valueProp,
    p.brand.audience,
    p.niche,
    p.category,
    p.businessType,
    ...p.studio.packages.flatMap((x) => [x.name, x.description, ...x.includes]),
  ];
  const nums = new Set<string>();
  for (const n of [p.studio.price, p.studio.compareAt, ...p.studio.packages.map((x) => x.price)]) if (Number.isFinite(n) && n > 0) nums.add(String(Math.round(n * 1000) / 1000));
  for (const t of [inputs.budget, inputs.goal, inputs.timePerWeek, inputs.notes]) for (const n of numbersIn(t)) nums.add(n);
  return { nums, text: words.filter(Boolean).join('\n').toLowerCase() };
}

const normInputs = (raw: unknown): StrategyInputs => {
  const r = obj(raw);
  const competitors = (Array.isArray(r.competitors) ? r.competitors : [])
    .map((c) => clip(c, C.inputs.competitor))
    .filter((c, i, a) => c && a.indexOf(c) === i)
    .slice(0, C.inputs.competitors);
  return { goal: clip(r.goal, C.inputs.goal), budget: clip(r.budget, C.inputs.budget), timePerWeek: clip(r.timePerWeek, C.inputs.timePerWeek), competitors, tried: clip(r.tried, C.inputs.tried, true), notes: clip(r.notes, C.inputs.notes, true) };
};

function normSources(raw: unknown): StrategySource[] {
  const out: StrategySource[] = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    const s = obj(x);
    const n = typeof s.n === 'number' && Number.isInteger(s.n) && s.n > 0 ? s.n : 0;
    const url = typeof s.url === 'string' ? s.url : '';
    if (!n || !isHttpUrl(url) || url.length > C.sources.url || out.some((y) => y.n === n)) continue;
    const quote = clip(s.quote, C.sources.quote);
    const pageAge = clip(s.pageAge, C.sources.pageAge);
    const domain = clip(s.domain, C.sources.domain) || domainOf(url);
    out.push({ n, url, title: clip(s.title, C.sources.title) || domain, domain, ...(quote ? { quote } : {}), ...(pageAge ? { pageAge } : {}), via: s.via === 'manus' ? 'manus' : 'search', at: typeof s.at === 'number' && Number.isFinite(s.at) ? s.at : 0 });
  }
  return out.sort((a, b) => a.n - b.n).slice(-C.sources.items);
}

const PLACEMENTS: readonly LinkPlacement[] = LINK_PLACEMENTS;

function normApplied(raw: unknown): StrategyState['applied'] {
  const r = obj(raw);
  const out: StrategyState['applied'] = {};
  for (const area of ['social', 'email', 'seo', 'campaign', 'links'] as ApplyArea[]) {
    const a = obj(r[area]);
    if (typeof a.at !== 'number' || !Number.isFinite(a.at)) continue;
    const rec: AppliedRecord = { at: a.at, from: typeof a.from === 'number' && Number.isFinite(a.from) ? a.from : 0 };
    if (area === 'social' || area === 'email') {
      if (typeof a.skillId !== 'string' || !a.skillId) continue;
      rec.skillId = a.skillId.slice(0, 80);
      if (typeof a.written === 'string') rec.written = a.written.slice(0, 20);
    } else if (area === 'seo') {
      if (typeof a.block !== 'string' || !a.block) continue;
      rec.block = a.block.slice(0, 2000);
    } else if (area === 'links') {
      const b = obj(a.before);
      rec.before = Object.fromEntries(POST_NETWORKS.filter((n) => PLACEMENTS.includes(b[n] as LinkPlacement)).map((n) => [n, b[n]]));
    } else {
      const b = obj(a.before);
      if (typeof b.goal !== 'string' || !Array.isArray(b.platforms)) continue;
      rec.before = { goal: b.goal, platforms: b.platforms.filter((x) => POST_NETWORKS.includes(x as PostPlatform)), postTypes: obj(b.postTypes), videosPerDay: typeof b.videosPerDay === 'number' ? b.videosPerDay : 0, videoStyles: Array.isArray(b.videoStyles) ? b.videoStyles.filter((x) => typeof x === 'string') : [] };
    }
    out[area] = rec;
  }
  return out;
}

function normRun(raw: unknown): StrategyRun | undefined {
  const r = obj(raw);
  if (typeof r.startedAt !== 'number' || !Number.isFinite(r.startedAt)) return undefined;
  const steps = (Array.isArray(r.steps) ? r.steps : []).filter((x, i, a): x is StrategyStep => STRATEGY_STEPS.includes(x as StrategyStep) && a.indexOf(x) === i);
  if (!steps.length) return undefined;
  const done = (Array.isArray(r.done) ? r.done : []).filter((x, i, a): x is StrategyStep => steps.includes(x as StrategyStep) && a.indexOf(x) === i);
  const note = clip(r.note, C.runNote);
  return {
    startedAt: r.startedAt,
    steps,
    done,
    ...(typeof r.finishedAt === 'number' && Number.isFinite(r.finishedAt) ? { finishedAt: r.finishedAt } : {}),
    ...(steps.includes(r.stoppedAt as StrategyStep) ? { stoppedAt: r.stoppedAt as StrategyStep } : {}),
    ...(note ? { note } : {}),
  };
}

const MANUS_ID = /^[A-Za-z0-9_-]{6,64}$/;

function normManus(raw: unknown, ctx: NormCtx): StrategyManus | undefined {
  const r = obj(raw);
  if (typeof r.taskId !== 'string' || !MANUS_ID.test(r.taskId)) return undefined;
  const url = typeof r.taskUrl === 'string' ? r.taskUrl : '';
  if (!isHttpUrl(url) || !url.startsWith('https:')) return undefined;
  const state = enumOf(r.state, ['working', 'needs_input', 'done', 'failed'] as const, 'failed');
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const message = clip(r.message, C.manus.message);
  // what Manus reported is only ever a page's words: a finding without its page goes
  const findings = normalizeFindings(r.findings, { ...ctx, trustBasis: false, fallback: 'ai' }, C.manus.findings).filter((f) => f.basis === 'web');
  const pagesRead = n(r.pagesRead);
  return {
    taskId: r.taskId,
    taskUrl: url,
    state,
    ...(message ? { message } : {}),
    requestedAt: n(r.requestedAt) ?? 0,
    ...(n(r.checkedAt) !== undefined ? { checkedAt: n(r.checkedAt) } : {}),
    ...(n(r.doneAt) !== undefined ? { doneAt: n(r.doneAt) } : {}),
    ...(n(r.credits) !== undefined ? { credits: n(r.credits) } : {}),
    ...(pagesRead !== undefined ? { pagesRead: Math.min(999, Math.round(pagesRead)) } : {}),
    ...(findings.length ? { findings } : {}),
  };
}

/** The context the normalizers read a project's strategy with. */
export function normCtx(p: Project, s: Pick<StrategyState, 'inputs' | 'sources'> & { promote?: { page?: { pageType?: PageType } } }, o: Partial<NormCtx> = {}): NormCtx {
  return { ns: new Set(s.sources.map((x) => x.n)), fallback: 'ai', trustBasis: true, owner: ownerFacts(p, s.inputs), networks: strategyNetworks(p), project: p, pageType: s.promote?.page?.pageType, ...o };
}

/**
 * The project's strategy, checked field by field: every id, enum and text through the normalizers (a
 * stored 'web' point keeps that basis only with a source number that still exists), ticks only for the
 * plan's actions, Manus only with a real task id and an https link. Then capped (capStrategy).
 */
export function readStrategy(p: Project): StrategyState {
  const raw = obj((p as { strategy?: unknown }).strategy);
  if (!Object.keys(raw).length) return emptyStrategy();
  const base = emptyStrategy();
  const inputs = normInputs(raw.inputs);
  const sources = normSources(raw.sources);
  const maxN = sources.reduce((m, x) => Math.max(m, x.n), 0);
  const nextSource = Math.max(maxN + 1, typeof raw.nextSource === 'number' && Number.isInteger(raw.nextSource) ? raw.nextSource : 1);
  const s: StrategyState = {
    ...base,
    inputs,
    useBrain: raw.useBrain !== false,
    maxSearches: raw.maxSearches === 3 || raw.maxSearches === 8 ? raw.maxSearches : 5,
    sources,
    nextSource,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  };
  const promoteRaw = obj(raw.promote);
  const storedPage = obj(promoteRaw.page).pageType;
  const ctx = normCtx(p, { inputs, sources, promote: { page: { pageType: PAGE_TYPES.includes(storedPage as PageType) ? (storedPage as PageType) : undefined } } });

  const rr = obj(raw.research);
  const ri = normalizeStepInfo(rr);
  if (ri) {
    const queries = (Array.isArray(rr.queries) ? rr.queries : []).map((q) => clip(q, C.research.query)).filter(Boolean).slice(0, C.research.queries);
    s.research = {
      ...ri,
      mode: enumOf(rr.mode, ['web', 'general', 'builtin'] as const, 'general'),
      reason: enumOf(rr.reason, RESEARCH_REASONS, ''),
      searches: typeof rr.searches === 'number' && Number.isFinite(rr.searches) ? Math.min(50, Math.max(0, Math.round(rr.searches))) : 0,
      queries,
      // the summary is never sourced: the rules of an unsourced statement
      summary: statementText(rr.summary, C.research.summary, ctx.owner),
      findings: normalizeFindings(rr.findings, ctx),
      checks: (Array.isArray(rr.checks) ? rr.checks : []).map((c) => clip(c, C.research.check)).filter(Boolean).slice(0, C.research.checks),
    };
  }
  const pi = normalizeStepInfo(promoteRaw);
  if (pi) s.promote = { ...pi, ...normalizePromote(promoteRaw, ctx) };
  const ci = normalizeStepInfo(raw.content);
  if (ci) s.content = { ...ci, ...normalizeContent(raw.content, ctx) };
  const ai = normalizeStepInfo(raw.assets);
  if (ai) s.assets = { ...ai, ...normalizeAssets(raw.assets, ctx) };
  const oi = normalizeStepInfo(raw.outreach);
  if (oi) s.outreach = { ...oi, ...normalizeOutreach(raw.outreach, ctx) };
  const pl = obj(raw.plan);
  const li = normalizeStepInfo(pl);
  if (li) s.plan = { ...li, ...normalizePlan(pl, ctx), startAt: typeof pl.startAt === 'number' && Number.isFinite(pl.startAt) && pl.startAt > 0 ? pl.startAt : li.at };

  const ids = new Set((s.plan?.actions ?? []).map((a) => a.id));
  const ticks = obj(raw.ticks);
  s.ticks = Object.fromEntries(
    Object.entries(ticks)
      .filter(([k, v]) => TICK_KEY.test(k) && ids.has(k) && typeof v === 'number' && Number.isFinite(v))
      .slice(0, C.ticks),
  ) as Record<string, number>;
  s.applied = normApplied(raw.applied);
  const run = normRun(raw.run);
  if (run) s.run = run;
  const manus = normManus(raw.manus, ctx);
  if (manus) s.manus = manus;
  return capStrategy(s);
}

// ───────────── sources ─────────────

/**
 * Give a found page its number: the same page (by sourceKey) keeps its number, filling in an empty title;
 * a new one gets the next number, never one given out before. null when the URL can't be kept.
 * Changes `s` (call it on a copy inside a write).
 */
export function addSource(s: StrategyState, src: { url: string; title?: string; domain?: string; quote?: string; pageAge?: string }, via: 'search' | 'manus', at: number): number | null {
  if (!isHttpUrl(src.url) || src.url.length > C.sources.url) return null;
  const key = sourceKey(src.url);
  const found = s.sources.find((x) => sourceKey(x.url) === key);
  const title = clip(src.title, C.sources.title);
  if (found) {
    if ((!found.title || found.title === found.domain) && title) found.title = title;
    return found.n;
  }
  const domain = clip(src.domain, C.sources.domain) || domainOf(src.url);
  const quote = clip(src.quote, C.sources.quote);
  const pageAge = clip(src.pageAge, C.sources.pageAge);
  const n = s.nextSource;
  s.nextSource = n + 1;
  s.sources.push({ n, url: src.url, title: title || domain, domain, ...(quote ? { quote } : {}), ...(pageAge ? { pageAge } : {}), via, at });
  return n;
}

/** Every source number the strategy cites somewhere. */
export function citedSources(s: StrategyState): Set<number> {
  const out = new Set<number>();
  const add = (x?: { sources?: number[] }) => x?.sources?.forEach((n) => out.add(n));
  s.research?.findings.forEach(add);
  s.manus?.findings?.forEach(add);
  if (s.promote) {
    add(s.promote.positioning);
    s.promote.channels.forEach(add);
    add(s.promote.page);
    Object.values(s.promote.links).forEach(add);
  }
  if (s.content) {
    s.content.formats.forEach(add);
    add(s.content.campaign);
  }
  if (s.assets) {
    s.assets.assets.forEach(add);
    add(s.assets.seo);
  }
  if (s.outreach) add(s.outreach.email);
  s.plan?.actions.forEach(add);
  return out;
}

/** Keep only the sources something cites. */
export function gcSources(s: StrategyState): StrategyState {
  const cited = citedSources(s);
  return s.sources.every((x) => cited.has(x.n)) ? s : { ...s, sources: s.sources.filter((x) => cited.has(x.n)) };
}

// ───────────── caps and the size guard ─────────────

const size = (s: StrategyState) => JSON.stringify(s).length;

/** Strip citations of sources that are gone; a point left without any becomes the AI's general knowledge. */
function dropCitations<T extends { basis: string; sources?: number[] }>(x: T, keep: Set<number>): T {
  if (!x.sources?.length) return x;
  const sources = x.sources.filter((n) => keep.has(n));
  if (sources.length === x.sources.length) return x;
  const { sources: _gone, ...rest } = x;
  return (sources.length ? { ...rest, sources } : { ...rest, basis: 'ai' }) as T;
}

function keepSources(s: StrategyState, keep: Set<number>): StrategyState {
  const f = <T extends { basis: string; sources?: number[] }>(x: T) => dropCitations(x, keep);
  return {
    ...s,
    sources: s.sources.filter((x) => keep.has(x.n)),
    ...(s.research ? { research: { ...s.research, findings: s.research.findings.map(f) } } : {}),
    // a Manus finding is a page's words: without its page it goes
    ...(s.manus ? { manus: { ...s.manus, ...(s.manus.findings ? { findings: s.manus.findings.map(f).filter((x: StrategyFinding) => x.basis === 'web') } : {}) } } : {}),
    ...(s.promote
      ? {
          promote: {
            ...s.promote,
            positioning: f(s.promote.positioning),
            channels: s.promote.channels.map(f),
            page: f(s.promote.page),
            links: Object.fromEntries(Object.entries(s.promote.links).map(([k, v]) => [k, f(v!)])),
          },
        }
      : {}),
    ...(s.content ? { content: { ...s.content, formats: s.content.formats.map(f), campaign: f(s.content.campaign) } } : {}),
    ...(s.assets ? { assets: { ...s.assets, assets: s.assets.assets.map(f), seo: f(s.assets.seo) } } : {}),
    ...(s.outreach ? { outreach: { ...s.outreach, email: f(s.outreach.email) } } : {}),
    ...(s.plan ? { plan: { ...s.plan, actions: s.plan.actions.map(f) } } : {}),
  };
}

const cs = (v: string, n: number, nl = false) => (v.length > n ? clip(v, n, nl) : v);

/** Every list and text within its cap (structure only: the content rules ran when it was written or read). */
function capFields(s: StrategyState): StrategyState {
  const i = s.inputs;
  const out: StrategyState = {
    ...s,
    inputs: { goal: cs(i.goal, C.inputs.goal), budget: cs(i.budget, C.inputs.budget), timePerWeek: cs(i.timePerWeek, C.inputs.timePerWeek), competitors: i.competitors.slice(0, C.inputs.competitors).map((c) => cs(c, C.inputs.competitor)), tried: cs(i.tried, C.inputs.tried, true), notes: cs(i.notes, C.inputs.notes, true) },
    sources: s.sources.slice(-C.sources.items),
    ticks: Object.fromEntries(Object.entries(s.ticks).slice(0, C.ticks)),
  };
  if (out.research) out.research = { ...out.research, summary: cs(out.research.summary, C.research.summary), findings: out.research.findings.slice(0, C.research.findings), queries: out.research.queries.slice(0, C.research.queries), checks: out.research.checks.slice(0, C.research.checks) };
  if (out.manus?.findings) out.manus = { ...out.manus, findings: out.manus.findings.slice(0, C.manus.findings) };
  if (out.promote) out.promote = { ...out.promote, channels: out.promote.channels.slice(0, C.promote.channels).map((c) => ({ ...c, how: c.how.slice(0, C.promote.how) })) };
  if (out.content) out.content = { ...out.content, pillars: out.content.pillars.slice(0, C.content.pillars).map((x) => ({ ...x, ideas: x.ideas.slice(0, C.content.pillarIdeas) })), formats: out.content.formats.slice(0, C.content.formats), ideas: out.content.ideas.slice(0, C.content.ideas) };
  if (out.assets) out.assets = { ...out.assets, assets: out.assets.assets.slice(0, C.assets.items), seo: { ...out.assets.seo, objections: out.assets.seo.objections.slice(0, C.assets.objections), keywords: out.assets.seo.keywords.slice(0, C.assets.keywords) } };
  if (out.outreach) out.outreach = { ...out.outreach, templates: out.outreach.templates.slice(0, C.outreach.templates).map((t) => ({ ...t, body: cs(t.body, C.outreach.body, true), followUp: cs(t.followUp, C.outreach.followUp, true) })) };
  if (out.plan) out.plan = { ...out.plan, weeks: out.plan.weeks.slice(0, C.plan.weeks), actions: out.plan.actions.slice(0, C.plan.actions), habits: out.plan.habits.slice(0, C.plan.habits), measure: out.plan.measure.slice(0, C.plan.measure) };
  if (out.run?.note) out.run = { ...out.run, note: cs(out.run.note, C.runNote) };
  return out;
}

/**
 * Caps, then unused sources out, then the size guard: until the strategy fits in 60,000 characters of JSON,
 * drop quotes, shorten email bodies, keep fewer findings, ideas and actions, then only the 16 newest
 * sources. Deterministic and idempotent; the owner's own facts (inputs, ticks, the switches) are never cut.
 */
export function capStrategy(input: StrategyState): StrategyState {
  let s = gcSources(capFields(input));
  if (size(s) <= C.json) return s;
  const steps: ((x: StrategyState) => StrategyState)[] = [
    // 2. quotes
    (x) => ({ ...x, sources: x.sources.map(({ quote: _q, ...rest }) => rest) }),
    // 3. email bodies to 600
    (x) => (x.outreach ? { ...x, outreach: { ...x.outreach, templates: x.outreach.templates.map((t) => ({ ...t, body: cs(t.body, 600, true) })) } } : x),
    // 4. ten research findings
    (x) => (x.research ? { ...x, research: { ...x.research, findings: x.research.findings.slice(0, 10) } } : x),
    // 5. six content ideas
    (x) => (x.content ? { ...x, content: { ...x.content, ideas: x.content.ideas.slice(0, 6) } } : x),
    // 6. sixteen plan actions, weeks 1-2 first
    (x) => {
      if (!x.plan || x.plan.actions.length <= 16) return x;
      const keep = new Set([...x.plan.actions.filter((a) => a.week <= 2), ...x.plan.actions.filter((a) => a.week > 2)].slice(0, 16).map((a) => a.id));
      return { ...x, plan: { ...x.plan, actions: x.plan.actions.filter((a) => keep.has(a.id)) } };
    },
    // 7. the sixteen newest sources (highest n)
    (x) => keepSources(x, new Set(x.sources.map((y) => y.n).sort((a, b) => b - a).slice(0, 16))),
    // further, rarely needed: shorter texts the AI wrote (never the owner's)
    (x) => shortenTexts(x, 0.6),
    (x) => shortenTexts(x, 0.35),
  ];
  for (const step of steps) {
    s = gcSources(step(s));
    if (size(s) <= C.json) break;
  }
  return s;
}

/** The AI's longer texts cut to a share of their cap (the size guard's last resort). */
function shortenTexts(s: StrategyState, share: number): StrategyState {
  const k = (n: number) => Math.max(40, Math.floor(n * share));
  const out = { ...s };
  if (out.research) out.research = { ...out.research, summary: cs(out.research.summary, k(C.research.summary)), findings: out.research.findings.map((f) => ({ ...f, text: cs(f.text, k(C.research.text)) })), checks: out.research.checks.map((c) => cs(c, k(C.research.check))) };
  if (out.manus?.findings) out.manus = { ...out.manus, findings: out.manus.findings.map((f) => ({ ...f, text: cs(f.text, k(C.manus.text)) })) };
  if (out.promote) out.promote = { ...out.promote, channels: out.promote.channels.map((c) => ({ ...c, why: cs(c.why, k(C.promote.channelWhy)), how: c.how.map((h) => cs(h, k(C.promote.howItem))) })) };
  if (out.content) out.content = { ...out.content, pillars: out.content.pillars.map((x) => ({ ...x, why: cs(x.why, k(C.content.pillarWhy)) })), formats: out.content.formats.map((f) => ({ ...f, why: cs(f.why, k(C.content.formatWhy)) })), ideas: out.content.ideas.map((i) => ({ ...i, why: cs(i.why, k(C.content.ideaWhy)) })) };
  if (out.assets) out.assets = { ...out.assets, assets: out.assets.assets.map((a) => ({ ...a, why: cs(a.why, k(C.assets.why)), ...(a.prompt ? { prompt: cs(a.prompt, k(C.assets.prompt)) } : {}) })) };
  if (out.outreach) out.outreach = { ...out.outreach, templates: out.outreach.templates.map((t) => ({ ...t, body: cs(t.body, k(600), true), followUp: cs(t.followUp, k(C.outreach.followUp), true), why: cs(t.why, k(C.outreach.templateWhy)) })) };
  if (out.plan) out.plan = { ...out.plan, actions: out.plan.actions.map((a) => ({ ...a, detail: cs(a.detail, k(C.plan.detail)) })), measure: out.plan.measure.map((m) => ({ ...m, why: cs(m.why, k(C.plan.measureWhy)) })) };
  out.sources = out.sources.map((x) => ({ ...x, title: cs(x.title, k(C.sources.title)) }));
  return out;
}

// ───────────── the facts a strategy was written from ─────────────

/** What the strategy rests on: the project's details and the owner's own inputs (a change makes sections stale). */
export function strategyFacts(p: Project, inputs: StrategyInputs) {
  return {
    track: p.track,
    niche: p.niche,
    category: p.category,
    format: p.format,
    businessType: p.businessType,
    location: p.location ? [p.location.city, p.location.region].filter(Boolean).join(', ') || null : null,
    summary: p.summary,
    audience: p.brand.audience,
    price: p.studio.price,
    packages: p.studio.packages.map((x) => `${x.name} ${x.price}`),
    networks: strategyNetworks(p),
    website: !!p.brand.websiteUrl,
    inputs,
  };
}
export const strategyFactsHash = (p: Project, inputs: StrategyInputs) => hashStr(JSON.stringify(strategyFacts(p, inputs))).toString(36);

/** The sections the strategy has, in tab order. */
export const SECTION_STEPS: Exclude<StrategyStep, never>[] = ['research', 'promote', 'content', 'assets', 'outreach', 'plan'];
export const hasAnySection = (s: StrategyState) => SECTION_STEPS.some((k) => !!s[k]);

/** What changed since sections were written: the owner's details, or the research (or Manus's findings) under them. */
export function stale(p: Project, s: StrategyState): { details: boolean; beforeResearch: StrategyStep[] } {
  const now = strategyFactsHash(p, s.inputs);
  const details = SECTION_STEPS.some((k) => !!s[k] && s[k]!.factsHash !== now);
  const researchAt = Math.max(s.research?.at ?? 0, s.manus?.state === 'done' ? s.manus.doneAt ?? 0 : 0);
  const beforeResearch = researchAt ? SECTION_STEPS.filter((k) => k !== 'research' && !!s[k] && (s[k]!.researchAt ?? 0) < researchAt) : [];
  return { details, beforeResearch };
}

// ───────────── the plan: weeks and progress ─────────────

const WEEK = 7 * 86_400_000;
/** The plan's week now: 1-4, or 5 once the four weeks are up. */
export const currentWeek = (plan: Pick<StrategyState['plan'] & {}, 'startAt'>, now = Date.now()) => Math.min(5, Math.max(1, 1 + Math.floor((now - plan.startAt) / WEEK)));

export interface ActionCtx {
  posts: Post[];
  ads: AdCampaign[];
  myListings: Listing[];
  now: number;
}

/** Whether the app can see an action done (derived), else whether the owner ticked it. A derived done wins. */
export function actionDone(a: StrategyAction, p: Project, s: StrategyState, ctx: ActionCtx): { done: boolean; by: 'app' | 'owner' | null } {
  const derived = derivedDone(a, p, s, ctx);
  if (derived) return { done: true, by: 'app' };
  return s.ticks[a.id] ? { done: true, by: 'owner' } : { done: false, by: null };
}

export function derivedDone(a: { kind: ActionKind; pageType?: PageType; codeKind?: string }, p: Project, s: StrategyState, ctx: ActionCtx): boolean {
  const m = p.marketing;
  const pid = p.id;
  const studio = p.studio;
  switch (a.kind) {
    case 'build_page': {
      const want = a.pageType ?? s.promote?.page.pageType;
      return !!m.salesPage && (!want || pageTypeOf(p) === want);
    }
    case 'publish_page':
      return !!m.seoPublished;
    case 'link_settings': {
      // where each network's link goes now: the owner's setting, else the default (advice that matches the default is done)
      const links = Object.entries(s.promote?.links ?? {});
      return links.length > 0 && links.every(([n, rec]) => placementFor(p, n as PostPlatform) === rec?.placement);
    }
    case 'campaign_setup':
      return !!s.applied.campaign || !!m.plan;
    case 'plan_30':
      return !!m.plan;
    case 'batch_7':
      return ctx.posts.some((x) => x.projectId === pid && x.source === 'batch');
    case 'calendar':
      return ctx.posts.some((x) => x.projectId === pid && x.status === 'scheduled');
    case 'lead_magnet':
      return !!m.leadMagnet;
    case 'welcome_emails':
      return m.emails.length >= 5;
    case 'code_asset':
      return studio.codeAssets.some((c) => !a.codeKind || c.kind === a.codeKind);
    case 'listing':
      return ctx.myListings.some((l) => l.projectId === pid);
    case 'listing_images':
      return !!studio.listing.coverImageId;
    case 'product_file':
      return p.track === 'business' ? studio.packages.length > 0 : (studio.productFiles ?? []).length > 0;
    case 'packages':
      return studio.packages.length > 0;
    case 'socials':
      return Object.values(p.brand.socials ?? {}).some(Boolean);
    case 'website':
      return !!p.brand.websiteUrl;
    case 'ads':
      return ctx.ads.some((x) => x.projectId === pid);
    default:
      return false;
  }
}

/** Done and total over the plan's actions. */
export function strategyProgress(p: Project, s: StrategyState, ctx: ActionCtx): { done: number; total: number } {
  const actions = s.plan?.actions ?? [];
  return { done: actions.filter((a) => actionDone(a, p, s, ctx).done).length, total: actions.length };
}

/** The next open actions: this week's first, then the earliest open ones. */
export function strategyNextSteps(p: Project, s: StrategyState, ctx: ActionCtx, n = 3): StrategyAction[] {
  if (!s.plan) return [];
  const w = currentWeek(s.plan, ctx.now);
  const open = s.plan.actions.filter((a) => !actionDone(a, p, s, ctx).done);
  const first = open.filter((a) => a.week === w);
  return [...first, ...open.filter((a) => !first.includes(a))].slice(0, n);
}

/** The Dashboard tile's status. */
export function strategyStatusLine(p: Project, ctx: ActionCtx): string {
  const s = readStrategy(p);
  if (s.plan) {
    const pr = strategyProgress(p, s, ctx);
    return `${pr.done}/${pr.total} steps done`;
  }
  if (s.research) return `Researched ${fmtRelative(s.research.at, ctx.now)}`;
  return 'Not started';
}

/** The strategy in brief, for the assistant (about 200 characters; null before anything is written). */
export function strategySummary(p: Project, ctx: ActionCtx) {
  const s = readStrategy(p);
  if (!hasAnySection(s)) return null;
  const pr = strategyProgress(p, s, ctx);
  const next = strategyNextSteps(p, s, ctx, 1)[0];
  return {
    researched: s.research ? (s.research.mode as 'web' | 'general' | 'builtin') : null,
    at: s.updatedAt || null,
    steps: { done: pr.done, total: pr.total },
    week: s.plan ? currentWeek(s.plan, ctx.now) : null,
    next: next ? clip(next.title, 80) : null,
  };
}
