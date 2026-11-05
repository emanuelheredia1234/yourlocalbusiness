// Strategy's honesty, enforced in code: the URL rules (the same as the server's), the patterns for links,
// emails, phones, market numbers, predictions and claims, and a normalizer for every section. Whatever an
// AI, a backup or another device wrote goes through these, on every read and write: ids are checked,
// text is cut to its cap, a point is "web" only with a source number that exists, unsourced numbers and
// predictions are dropped, and owner-facing copy loses invented claims. Pure: no store, no React.
import type { CampaignConfig, CodeKind, GenMeta, LeadMagnetType, LinkPlacement, PageType, PostPlatform, PostType, Project, ProviderId } from './types';
import type {
  ActionKind,
  AssetsOut,
  Backed,
  ChannelType,
  ContentOut,
  FindingTopic,
  MeasureWhere,
  OutreachOut,
  OutreachPurpose,
  OwnerFacts,
  PlanOut,
  PromoteOut,
  ResearchOut,
  ResearchOutFinding,
  ResearchReason,
  SeoCta,
  StepInfo,
  StrategyAction,
  StrategyBasis,
  StrategyChannel,
  StrategyFinding,
  StrategyLinkRec,
  StrategyNetwork,
  StrategyPageRec,
  StrategyStep,
} from './strategyTypes';
import { hashStr } from './utils';
import { PAGE_TYPES } from './pageTypes';
import { LINK_PLACEMENTS } from './pageLink';
import { ACTION_KINDS, ASSET_KINDS, BUILTIN_MIX, BUILTIN_WEEKS, LEAD_MAGNET_KINDS, allowedCodeKinds, ctaForPage, defaultLinkPlacement, goalForPage, recommendPageType, PAGE_WHY } from '@/ai/local/strategyDefaults';

// ───────────── URLs (identical rules to server/providers/research.mjs) ─────────────

const MAX_URL = 2000;

/** http(s), a host name with a dot, no user:password, at most 2,000 characters. */
export function isHttpUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.') && !u.username && !u.password;
}

const TRACKING = /^(utm_[a-z]+|gclid|fbclid|mc_[a-z]+|ref_src)$/i;

/** The same page however it's written (scheme, www, trailing slash, tracking parameters and #hash ignored); '' when it isn't a URL. */
export function sourceKey(raw: unknown): string {
  if (!isHttpUrl(raw)) return '';
  const u = new URL(raw as string);
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  return `${u.host.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
}

/** The host name without www., or ''. */
export function domainOf(raw: unknown): string {
  if (!isHttpUrl(raw)) return '';
  return new URL(raw as string).hostname.toLowerCase().replace(/^www\./, '');
}

// ───────────── patterns ─────────────

export const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
export const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;
/** a market number: percentages, multiples, money, big counts of people or actions */
export const NUMBER_CLAIM =
  /\d[\d,.]*\s*(%|percent\b)|\d[\d,.]*\s*x\s+(more|higher|faster|better)\b|\b\d[\d,.]*\s+times\s+(more|higher|faster|better|as)\b|[$€£]\s?\d|\b\d[\d,.]*\s*(k|million|billion)\b|\b\d[\d,.]*\s+(people|users|buyers|customers|clients|followers|views|visitors|searches|sales|bookings|leads|members|subscribers|downloads|shoppers)\b/i;
/** a promise of results */
export const PREDICTION = /\b(you(?:'|’)ll|you will|will (?:get|bring|double|triple|grow|increase|reach|generate|land|win|boost))\b|\bguarantee/i;
/** claims about the business the owner must have given */
export const CLAIMS =
  /trusted by|licensed|insured|award[- ]winning|money-back|risk-free|\bguarantee[ds]?\b|testimonials?\b|\b\d(\.\d)?\s*stars?\b|\bfive[- ]star\b|#1\b|number one|best in (town|the city|the area)|limited time|only \d+ (left|spots)|ends (today|tonight|soon)|\d+\s*% off|\bfree (quote|estimate|consultation|trial|shipping|gift|session|class)\b|years? (of experience|in business)/i;

const globalOf = (re: RegExp) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
const NUMBER_CLAIM_G = globalOf(NUMBER_CLAIM);
const CLAIMS_G = globalOf(CLAIMS);

// ───────────── text helpers ─────────────

/**
 * Plain text cut to `max`: control characters out (newlines kept only with keepNewlines), spaces
 * collapsed, trimmed, and cut at a word boundary with "…". Numbers become text; anything else ''.
 */
// Line and paragraph separators and the no-break space, by code point (a literal one would end a regex literal)
const LS_PS = String.fromCharCode(0x2028, 0x2029);
const NBSP = String.fromCharCode(0xa0);
const CONTROL_NL = new RegExp(`[\\x00-\\x09\\x0b-\\x1f\\x7f-\\x9f${LS_PS}]`, 'g');
const CONTROL_ALL = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${LS_PS}]`, 'g');
const SPACES = new RegExp(`[ ${NBSP}]+`, 'g');

export function clip(v: unknown, max: number, keepNewlines = false): string {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  let s = String(v).slice(0, max * 4 + 400).replace(/\r\n?/g, '\n');
  if (keepNewlines) {
    s = s
      .replace(CONTROL_NL, ' ')
      .split('\n')
      .map((l) => l.replace(SPACES, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } else s = s.replace(CONTROL_ALL, ' ').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  let cut = s.slice(0, Math.max(1, max - 1));
  const sp = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  cut = cut.replace(/[\s,;:.!?\-–—(]+$/, '');
  return `${cut}…`;
}

/**
 * Links, emails and phone numbers out of a text. 'drop' removes them; 'placeholders' (email templates)
 * writes [link to your page], [your email] and [your phone] instead, for the owner to fill in.
 */
export function noLinks(s: string, mode: 'drop' | 'placeholders'): string {
  const put = (word: string) => (m: string) => {
    const trail = /[.,;:!?]+$/.exec(m)?.[0] ?? '';
    return (mode === 'drop' ? '' : word) + trail;
  };
  return s
    .replace(URL_RE, put('[link to your page]'))
    .replace(EMAIL_RE, mode === 'drop' ? '' : '[your email]')
    .replace(PHONE_RE, mode === 'drop' ? '' : '[your phone]')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1');
}

/** A line's sentences (split after . ! or ? and a space). */
export function sentences(s: string): string[] {
  return s.replace(/\u0000/g, '').replace(/([.!?])\s+/g, '$1\u0000').split('\u0000');
}

/**
 * Keep only the sentences `keep` accepts, line by line (so a greeting on its own line survives a bad
 * sentence below it). Empty lines stay as paragraph breaks; a line whose sentences all go is removed.
 */
function bySentence(s: string, keep: (sentence: string) => boolean): string {
  const out: string[] = [];
  for (const line of s.split('\n')) {
    if (!line.trim()) {
      out.push('');
      continue;
    }
    const kept = sentences(line)
      .map((x) => x.trim())
      .filter((x) => x && keep(x))
      .join(' ');
    if (kept) out.push(kept);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** A number as the owner's numbers are kept: no commas, no trailing dot, "49.00" → "49". */
function normNum(t: string, mult = 1): string {
  const n = parseFloat(t.replace(/,/g, '').replace(/\.+$/, ''));
  return Number.isFinite(n) ? String(Math.round(n * mult * 1000) / 1000) : '';
}

/** Every number in a text, as owner numbers are compared. */
export function numbersIn(s: string): string[] {
  return (s.match(/\d[\d,.]*/g) ?? []).map((t) => normNum(t)).filter(Boolean);
}

/** True when every market number in the sentence is one the owner gave (their price, budget, goal…). */
function numbersOk(sentence: string, owner: OwnerFacts): boolean {
  for (const m of sentence.matchAll(NUMBER_CLAIM_G)) {
    const at = (m.index ?? 0) + m[0].search(/\d/);
    const token = /\d[\d,.]*/.exec(sentence.slice(at))?.[0] ?? '';
    const unit = /(k|million|billion)\b/i.exec(m[0])?.[1]?.toLowerCase();
    const n = normNum(token, unit === 'k' ? 1e3 : unit === 'million' ? 1e6 : unit === 'billion' ? 1e9 : 1);
    if (!n || !owner.nums.has(n)) return false;
  }
  return true;
}

/** True when every claim in the sentence is something the owner wrote themselves. */
function claimsOk(sentence: string, owner: OwnerFacts): boolean {
  for (const m of sentence.matchAll(CLAIMS_G)) if (!owner.text.includes(m[0].toLowerCase())) return false;
  return true;
}

/** No links, emails or phone numbers, and no sentence that promises results. */
export function cleanText(s: string, _owner?: OwnerFacts): string {
  return bySentence(noLinks(s, 'drop'), (x) => !PREDICTION.test(x));
}

/** cleanText, and no sentence with a claim or a market number the owner didn't give (owner-facing copy). */
export function claimFree(s: string, owner: OwnerFacts): string {
  return bySentence(cleanText(s, owner), (x) => claimsOk(x, owner) && numbersOk(x, owner));
}

/** No sentence with a market number the owner didn't give (for statements without a source). */
export function unsourcedOk(s: string, owner: OwnerFacts): string {
  return bySentence(s, (x) => numbersOk(x, owner));
}

/** A text field: the rule, then the cap, then the rule again (so a second pass changes nothing). */
function field(v: unknown, max: number, rule: (s: string) => string, keepNewlines = false): string {
  const first = rule(clip(v, max * 3 + 200, keepNewlines));
  return rule(clip(first, max, keepNewlines));
}

/** Statements: no links or predictions, and no unsourced market numbers unless the statement rests on the web. */
const stmt = (v: unknown, max: number, basis: StrategyBasis, owner: OwnerFacts) => field(v, max, (s) => (basis === 'web' ? cleanText(s, owner) : unsourcedOk(cleanText(s, owner), owner)));
/** An unsourced statement (a summary, a habit): no links, predictions or market numbers the owner didn't give. */
export const statementText = (v: unknown, max: number, owner: OwnerFacts) => stmt(v, max, 'ai', owner);
/** Email bodies: links become [placeholders], then claimFree, keeping line breaks. */
const body = (v: unknown, max: number, owner: OwnerFacts) => field(v, max, (s) => claimFree(noLinks(s, 'placeholders'), owner), true);

// ───────────── ids, enums, numbers ─────────────

export function enumOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (allowed as readonly string[]).includes(t) ? (t as T) : fallback;
}
/** An optional id: one of `allowed`, else undefined. */
function optEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (allowed as readonly string[]).includes(t) ? (t as T) : undefined;
}

/** Source numbers: whole numbers that are in `ns`, de-duplicated, at most `max`. */
export function nums(v: unknown, ns: Set<number>, max = 4): number[] {
  const out: number[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const n = typeof x === 'number' ? x : typeof x === 'string' && /^\s*\[?\d+\]?\s*$/.test(x) ? Number(x.replace(/[^\d]/g, '')) : NaN;
    if (Number.isInteger(n) && ns.has(n) && !out.includes(n)) out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

const int = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const texts = (v: unknown, n: number, f: (x: unknown) => string): string[] => {
  const out: string[] = [];
  for (const x of arr(v).slice(0, n * 3)) {
    const t = f(x);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= n) break;
  }
  return out;
};

export const STRATEGY_STEPS: StrategyStep[] = ['research', 'promote', 'content', 'assets', 'outreach', 'plan'];
export const FINDING_TOPICS: FindingTopic[] = ['buyers', 'social', 'promote', 'offers', 'outreach', 'seo', 'other'];
export const CHANNEL_TYPES: ChannelType[] = ['social', 'search', 'marketplace', 'directory', 'community', 'partners', 'email', 'ads', 'offline', 'other'];
export const POST_NETWORKS: PostPlatform[] = ['instagram', 'facebook', 'tiktok', 'linkedin', 'x'];
export const STRATEGY_NETWORKS: StrategyNetwork[] = [...POST_NETWORKS, 'youtube'];
export const POST_TYPE_IDS: PostType[] = ['educational', 'tip', 'question', 'sales', 'bts'];
export const PURPOSES: OutreachPurpose[] = ['partner', 'referral', 'past_customer', 'collab', 'press', 'wholesale', 'other'];
export const WHERES: MeasureWhere[] = ['app', 'network', 'booking', 'payments', 'email', 'other'];
export const SEO_CTAS: SeoCta[] = ['book', 'buy', 'contact', 'join', 'download'];
export const RESEARCH_REASONS: ResearchReason[] = ['', 'unsupported', 'provider_refused', 'not_used', 'no_results', 'search_failed', 'claude_ai', 'builtin'];
const GOALS: CampaignConfig['goal'][] = ['awareness', 'leads', 'sales'];
const PROVIDERS: ProviderId[] = ['local', 'claude', 'server'];

/** 'a_' + hashStr(kind | lowercased title) in base 36: the same action keeps its id (and its tick) across re-plans. */
export const actionId = (kind: string, title: string) => `a_${hashStr(`${kind}|${title.toLowerCase()}`).toString(36)}`;
export const TICK_KEY = /^a_[a-z0-9]{1,13}$/;

// ───────────── caps ─────────────

/**
 * Caps on every field (strings in characters, lists in items). The whole strategy stays ≤ 60,000 characters of JSON.
 * A source's URL: the server passes on none longer (MAX_SOURCE_URL in server/providers/research.mjs), so none is dropped here.
 */
export const STRATEGY_CAPS = {
  json: 60_000,
  inputs: { goal: 200, budget: 120, timePerWeek: 80, competitors: 10, competitor: 120, tried: 400, notes: 600 },
  sources: { items: 24, url: 400, title: 160, domain: 100, quote: 200, pageAge: 40 },
  research: { summary: 600, findings: 16, text: 300, perItem: 4, queries: 8, query: 200, checks: 6, check: 200 },
  manus: { findings: 12, text: 300, message: 300 },
  promote: { line: 200, who: 160, why: 300, channels: 8, name: 60, channelWhy: 300, how: 4, howItem: 160, pageWhy: 300, secondWhy: 200, links: 5, linkWhy: 200 },
  content: { pillars: 5, pillarName: 40, pillarWhy: 200, pillarIdeas: 4, idea: 90, formats: 8, what: 80, formatWhy: 200, campaignWhy: 300, ideas: 10, headline: 90, ideaWhy: 200 },
  assets: { items: 8, title: 90, why: 300, prompt: 600, audience: 200, angle: 200, objections: 4, objection: 160, keywords: 5, keyword: 80, seoWhy: 300 },
  outreach: { idea: 160, welcomeAngle: 200, why: 200, templates: 3, who: 80, subject: 90, body: 1200, followUp: 400, templateWhy: 200 },
  plan: { summary: 400, weeks: 4, focus: 80, goal: 160, actions: 24, title: 90, detail: 300, topic: 90, habits: 5, habit: 160, measure: 6, what: 120, measureWhy: 160 },
  step: { note: 300, skills: 6, skill: 60 },
  ticks: 60,
  runNote: 300,
} as const;
const C = STRATEGY_CAPS;

// ───────────── the normalizers ─────────────

export interface NormCtx {
  /** the source numbers a point may cite */
  ns: Set<number>;
  /** the basis of a point without a valid source */
  fallback: StrategyBasis;
  /** keep a stored 'ai' or 'builtin' basis (reading saved data) */
  trustBasis: boolean;
  owner: OwnerFacts;
  /** the project's networks (campaign platforms, else Instagram and Facebook) */
  networks: PostPlatform[];
  project: Project;
  /** the page the strategy recommends, for default goals and calls to action */
  pageType?: PageType;
}

/** basis + sources of a point: 'web' only with at least one valid source number. */
function backed(raw: Record<string, unknown>, ctx: NormCtx): Backed {
  const sources = nums(raw.sources, ctx.ns, C.research.perItem);
  if (sources.length) return { basis: 'web', sources };
  const b = raw.basis;
  return { basis: ctx.trustBasis && (b === 'ai' || b === 'builtin') ? b : ctx.fallback };
}

const pageOf = (ctx: NormCtx): PageType => ctx.pageType ?? recommendPageType(ctx.project).pageType;

/** One finding (research or Manus), with its source numbers; null when its text doesn't survive. */
export function normalizeFinding(raw: unknown, ctx: NormCtx): StrategyFinding | null {
  const r = obj(raw);
  const b = backed(r, ctx);
  const text = stmt(r.text, C.research.text, b.basis, ctx.owner);
  return text ? { topic: enumOf(r.topic, FINDING_TOPICS, 'other'), text, ...b } : null;
}

/** Findings, de-duplicated by text. */
export function normalizeFindings(list: unknown, ctx: NormCtx, max: number = C.research.findings): StrategyFinding[] {
  const out: StrategyFinding[] = [];
  const seen = new Set<string>();
  for (const x of arr(list).slice(0, max * 3)) {
    const f = normalizeFinding(x, ctx);
    if (!f || seen.has(f.text.toLowerCase())) continue;
    seen.add(f.text.toLowerCase());
    out.push(f);
    if (out.length >= max) break;
  }
  return out;
}

/** The research task's output: findings keep the server URLs they were matched to (sourceUrls), not numbers yet. */
export function normalizeResearchOut(raw: unknown, ctx: NormCtx): ResearchOut {
  const r = obj(raw);
  const findings: ResearchOutFinding[] = [];
  const seen = new Set<string>();
  for (const x of arr(r.findings).slice(0, C.research.findings * 3)) {
    const f = obj(x);
    const sourceUrls = arr(f.sourceUrls)
      .filter((u): u is string => typeof u === 'string' && isHttpUrl(u))
      .filter((u, i, a) => a.indexOf(u) === i)
      .slice(0, C.research.perItem);
    const basis: StrategyBasis = sourceUrls.length ? 'web' : ctx.trustBasis && (f.basis === 'ai' || f.basis === 'builtin') ? f.basis : ctx.fallback;
    const text = stmt(f.text, C.research.text, basis, ctx.owner);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    findings.push({ topic: enumOf(f.topic, FINDING_TOPICS, 'other'), text, basis, sourceUrls });
    if (findings.length >= C.research.findings) break;
  }
  return {
    summary: stmt(r.summary, C.research.summary, 'ai', ctx.owner),
    findings,
    checks: texts(r.checks, C.research.checks, (x) => field(x, C.research.check, (s) => cleanText(s))),
  };
}

function normChannel(raw: unknown, ctx: NormCtx): StrategyChannel | null {
  const r = obj(raw);
  const b = backed(r, ctx);
  const name = field(r.name, C.promote.name, (s) => claimFree(s, ctx.owner));
  const why = stmt(r.why, C.promote.channelWhy, b.basis, ctx.owner);
  if (!name || !why) return null;
  const platform = optEnum(r.platform, STRATEGY_NETWORKS);
  return {
    name,
    channelType: enumOf(r.channelType, CHANNEL_TYPES, 'other'),
    ...(platform ? { platform } : {}),
    priority: int(r.priority, 1, 3, 3) as 1 | 2 | 3,
    why,
    how: texts(r.how, C.promote.how, (x) => stmt(x, C.promote.howItem, b.basis, ctx.owner)),
    ...b,
  };
}

function normPage(raw: unknown, ctx: NormCtx): StrategyPageRec {
  const r = obj(raw);
  const pageType = optEnum(r.pageType, PAGE_TYPES);
  if (!pageType) return recommendPageType(ctx.project);
  const b = backed(r, ctx);
  const secondType = optEnum(r.secondType, PAGE_TYPES);
  const second = secondType && secondType !== pageType ? secondType : undefined;
  const secondWhy = second ? stmt(r.secondWhy, C.promote.secondWhy, b.basis, ctx.owner) : '';
  return {
    pageType,
    why: stmt(r.why, C.promote.pageWhy, b.basis, ctx.owner) || PAGE_WHY[pageType],
    ...(second ? { secondType: second, secondWhy: secondWhy || PAGE_WHY[second] } : {}),
    ...b,
  };
}

function normLinks(raw: unknown, ctx: NormCtx): Partial<Record<PostPlatform, StrategyLinkRec>> {
  const r = obj(raw);
  const out: Partial<Record<PostPlatform, StrategyLinkRec>> = {};
  for (const net of POST_NETWORKS) {
    const v = obj(r[net]);
    const placement = optEnum<LinkPlacement>(v.placement, LINK_PLACEMENTS);
    if (placement) {
      const b = backed(v, ctx);
      out[net] = { placement, why: stmt(v.why, C.promote.linkWhy, b.basis, ctx.owner) || defaultLinkPlacement(net).why, ...b };
    } else if (ctx.networks.includes(net)) out[net] = defaultLinkPlacement(net);
  }
  return out;
}

/** The positioning the built-in engine writes, used when an answer has none. */
function builtinPositioning(ctx: NormCtx): PromoteOut['positioning'] {
  const p = ctx.project;
  const who = clip(p.brand.audience || p.idea?.audience || '', C.promote.who);
  const what = p.track === 'business' ? `${p.businessType || p.category || p.niche || 'a local business'}${p.location?.city ? ` in ${p.location.city}` : ''}` : `${p.category || p.niche || 'a digital product'}`;
  return { basis: 'builtin', line: clip(`${p.brand.name || 'Your business'}: ${what}${who ? ` for ${who}` : ''}.`, C.promote.line), who, why: 'From your project details. Sharpen it in your own words.' };
}

export function normalizePromote(raw: unknown, ctx: NormCtx): PromoteOut {
  const r = obj(raw);
  const pos = obj(r.positioning);
  const pb = backed(pos, ctx);
  const line = field(pos.line, C.promote.line, (s) => claimFree(s, ctx.owner));
  const positioning = line ? { line, who: field(pos.who, C.promote.who, (s) => claimFree(s, ctx.owner)), why: stmt(pos.why, C.promote.why, pb.basis, ctx.owner), ...pb } : builtinPositioning(ctx);
  const channels: StrategyChannel[] = [];
  for (const x of arr(r.channels).slice(0, C.promote.channels * 3)) {
    const c = normChannel(x, ctx);
    if (c && !channels.some((y) => y.name.toLowerCase() === c.name.toLowerCase())) channels.push(c);
    if (channels.length >= C.promote.channels) break;
  }
  return { positioning, channels, page: normPage(r.page, ctx), links: normLinks(r.links, ctx) };
}

export function normalizeContent(raw: unknown, ctx: NormCtx): ContentOut {
  const r = obj(raw);
  const pillars: ContentOut['pillars'] = [];
  for (const x of arr(r.pillars).slice(0, C.content.pillars * 3)) {
    const p = obj(x);
    const name = field(p.name, C.content.pillarName, (s) => claimFree(s, ctx.owner));
    if (!name || pillars.some((y) => y.name.toLowerCase() === name.toLowerCase())) continue;
    pillars.push({ name, why: stmt(p.why, C.content.pillarWhy, 'ai', ctx.owner), ideas: texts(p.ideas, C.content.pillarIdeas, (i) => field(i, C.content.idea, (s) => claimFree(s, ctx.owner))) });
    if (pillars.length >= C.content.pillars) break;
  }
  const formats: ContentOut['formats'] = [];
  for (const x of arr(r.formats).slice(0, C.content.formats * 3)) {
    const f = obj(x);
    const platform = optEnum(f.platform, STRATEGY_NETWORKS);
    if (!platform) continue;
    const b = backed(f, ctx);
    const what = stmt(f.what, C.content.what, b.basis, ctx.owner);
    if (!what) continue;
    formats.push({ platform, what, why: stmt(f.why, C.content.formatWhy, b.basis, ctx.owner), ...b });
    if (formats.length >= C.content.formats) break;
  }
  const c = obj(r.campaign);
  const cb = backed(c, ctx);
  const platforms = arr(c.platforms)
    .map((v) => optEnum(v, POST_NETWORKS))
    .filter((v, i, a): v is PostPlatform => !!v && a.indexOf(v) === i);
  const mixRaw = obj(c.postMix);
  const mix = Object.fromEntries(POST_TYPE_IDS.map((t) => [t, int(mixRaw[t], 0, 3, 0)])) as Record<PostType, 0 | 1 | 2 | 3>;
  const campaign: ContentOut['campaign'] = {
    goal: enumOf(c.goal, GOALS, goalForPage(pageOf(ctx))),
    platforms: platforms.length ? platforms : [...ctx.networks],
    postMix: POST_TYPE_IDS.some((t) => mix[t] > 0) ? mix : { ...BUILTIN_MIX },
    videoShare: enumOf(c.videoShare, ['none', 'some', 'most'] as const, 'some'),
    why: stmt(c.why, C.content.campaignWhy, cb.basis, ctx.owner),
    ...cb,
  };
  const ideas: ContentOut['ideas'] = [];
  for (const x of arr(r.ideas).slice(0, C.content.ideas * 3)) {
    const i = obj(x);
    const headline = field(i.headline, C.content.headline, (s) => claimFree(s, ctx.owner));
    if (!headline || ideas.some((y) => y.headline.toLowerCase() === headline.toLowerCase())) continue;
    const platform = optEnum(i.platform, POST_NETWORKS);
    ideas.push({ headline, postType: enumOf(i.postType, POST_TYPE_IDS, 'tip'), ...(platform ? { platform } : {}), why: stmt(i.why, C.content.ideaWhy, 'ai', ctx.owner) });
    if (ideas.length >= C.content.ideas) break;
  }
  return { pillars, formats, campaign, ideas };
}

export const assetId = (kind: string, title: string) => `as_${hashStr(kind + title).toString(36)}`;

export function normalizeAssets(raw: unknown, ctx: NormCtx): AssetsOut {
  const r = obj(raw);
  const codeKinds = allowedCodeKinds(ctx.project.track);
  const assets: AssetsOut['assets'] = [];
  for (const x of arr(r.assets).slice(0, C.assets.items * 3)) {
    const a = obj(x);
    const kind = optEnum(a.kind, ASSET_KINDS);
    if (!kind) continue;
    const b = backed(a, ctx);
    const title = field(a.title, C.assets.title, (s) => claimFree(s, ctx.owner));
    if (!title) continue;
    const id = assetId(kind, title);
    if (assets.some((y) => y.id === id)) continue;
    const codeKind = kind === 'code' ? optEnum<CodeKind>(a.codeKind, codeKinds) : undefined;
    const leadMagnetType = kind === 'lead_magnet' ? optEnum<LeadMagnetType>(a.leadMagnetType, LEAD_MAGNET_KINDS) : undefined;
    const prompt = kind === 'code' ? field(a.prompt, C.assets.prompt, (s) => claimFree(s, ctx.owner)) : '';
    assets.push({ id, kind, title, why: stmt(a.why, C.assets.why, b.basis, ctx.owner), ...(codeKind ? { codeKind } : {}), ...(leadMagnetType ? { leadMagnetType } : {}), ...(prompt ? { prompt } : {}), ...b });
    if (assets.length >= C.assets.items) break;
  }
  const s = obj(r.seo);
  const sb = backed(s, ctx);
  const own = (v: unknown, max: number) => field(v, max, (t) => claimFree(t, ctx.owner));
  return {
    assets,
    seo: {
      audience: own(s.audience, C.assets.audience),
      angle: own(s.angle, C.assets.angle),
      objections: texts(s.objections, C.assets.objections, (v) => own(v, C.assets.objection)),
      keywords: texts(s.keywords, C.assets.keywords, (v) => own(v, C.assets.keyword).toLowerCase()),
      cta: enumOf(s.cta, SEO_CTAS, ctaForPage(pageOf(ctx), ctx.project.studio.price > 0)),
      why: stmt(s.why, C.assets.seoWhy, sb.basis, ctx.owner),
      ...sb,
    },
  };
}

export const templateId = (subject: string) => `tp_${hashStr(subject).toString(36)}`;

export function normalizeOutreach(raw: unknown, ctx: NormCtx): OutreachOut {
  const r = obj(raw);
  const e = obj(r.email);
  const eb = backed(e, ctx);
  const own = (v: unknown, max: number) => field(v, max, (t) => claimFree(t, ctx.owner));
  const templates: OutreachOut['templates'] = [];
  for (const x of arr(r.templates).slice(0, C.outreach.templates * 3)) {
    const t = obj(x);
    const subject = own(t.subject, C.outreach.subject);
    const text = body(t.body, C.outreach.body, ctx.owner);
    if (!subject || !text) continue;
    const id = templateId(subject);
    if (templates.some((y) => y.id === id)) continue;
    templates.push({ id, who: own(t.who, C.outreach.who), purpose: enumOf(t.purpose, PURPOSES, 'other'), subject, body: text, followUp: body(t.followUp, C.outreach.followUp, ctx.owner), why: own(t.why, C.outreach.templateWhy) });
    if (templates.length >= C.outreach.templates) break;
  }
  return {
    email: {
      leadMagnetType: enumOf(e.leadMagnetType, LEAD_MAGNET_KINDS, ctx.project.track === 'business' ? 'checklist' : 'guide'),
      idea: own(e.idea, C.outreach.idea),
      welcomeAngle: own(e.welcomeAngle, C.outreach.welcomeAngle),
      why: stmt(e.why, C.outreach.why, eb.basis, ctx.owner),
      ...eb,
    },
    templates,
  };
}

export function normalizePlan(raw: unknown, ctx: NormCtx): PlanOut {
  const r = obj(raw);
  const own = (v: unknown, max: number) => field(v, max, (t) => claimFree(t, ctx.owner));
  const rawWeeks = arr(r.weeks).map(obj);
  const weeks = BUILTIN_WEEKS.map((dflt, i) => {
    const w = rawWeeks.find((x) => int(x.week, 0, 99, 0) === dflt.week) ?? (rawWeeks.every((x) => x.week === undefined) ? rawWeeks[i] : undefined) ?? {};
    const focus = own(w.focus, C.plan.focus);
    return focus ? { week: dflt.week, focus, goal: own(w.goal, C.plan.goal) || dflt.goal } : { ...dflt };
  });
  const codeKinds = allowedCodeKinds(ctx.project.track);
  const actions: StrategyAction[] = [];
  for (const x of arr(r.actions).slice(0, C.plan.actions * 3)) {
    const a = obj(x);
    const title = own(a.title, C.plan.title);
    if (!title) continue;
    const kind = enumOf<ActionKind>(a.kind, ACTION_KINDS, 'offline');
    const id = actionId(kind, title);
    if (actions.some((y) => y.id === id)) continue;
    const b = backed(a, ctx);
    const pageType = kind === 'build_page' ? optEnum(a.pageType, PAGE_TYPES) : undefined;
    const codeKind = kind === 'code_asset' ? optEnum<CodeKind>(a.codeKind, codeKinds) : undefined;
    const leadMagnetType = kind === 'lead_magnet' ? optEnum<LeadMagnetType>(a.leadMagnetType, LEAD_MAGNET_KINDS) : undefined;
    const platform = kind === 'write_post' ? optEnum(a.platform, POST_NETWORKS) : undefined;
    const topic = kind === 'write_post' ? own(a.topic, C.plan.topic) || clip(title, C.plan.topic) : '';
    actions.push({
      id,
      week: int(a.week, 1, 4, 4) as 1 | 2 | 3 | 4,
      title,
      detail: stmt(a.detail, C.plan.detail, b.basis, ctx.owner),
      kind,
      ...(pageType ? { pageType } : {}),
      ...(topic ? { topic } : {}),
      ...(codeKind ? { codeKind } : {}),
      ...(leadMagnetType ? { leadMagnetType } : {}),
      ...(platform ? { platform } : {}),
      ...b,
    });
    if (actions.length >= C.plan.actions) break;
  }
  // week order, keeping the order within a week
  actions.sort((p, q) => p.week - q.week);
  const measure: PlanOut['measure'] = [];
  for (const x of arr(r.measure).slice(0, C.plan.measure * 3)) {
    const m = obj(x);
    const what = stmt(m.what, C.plan.what, 'ai', ctx.owner);
    if (!what || measure.some((y) => y.what.toLowerCase() === what.toLowerCase())) continue;
    measure.push({ what, where: enumOf(m.where, WHERES, 'other'), why: stmt(m.why, C.plan.measureWhy, 'ai', ctx.owner) });
    if (measure.length >= C.plan.measure) break;
  }
  return {
    summary: stmt(r.summary, C.plan.summary, 'ai', ctx.owner),
    weeks,
    actions,
    habits: texts(r.habits, C.plan.habits, (v) => stmt(v, C.plan.habit, 'ai', ctx.owner)),
    measure,
  };
}

// ───────────── who wrote a section ─────────────

const GEN_META_STR = ['provider', 'providerLabel', 'model', 'effort', 'effortLabel'] as const;

/** Only GenMeta's own fields, with the right types (the provider's label and model are required). */
export function normalizeGenMeta(raw: unknown): GenMeta | undefined {
  const r = obj(raw);
  if (!GEN_META_STR.every((k) => typeof r[k] === 'string') || !r.provider || !r.model) return undefined;
  const out: GenMeta = Object.fromEntries(GEN_META_STR.map((k) => [k, clip(r[k], 80)])) as unknown as GenMeta;
  if (typeof r.kind === 'string') out.kind = clip(r.kind, 20);
  for (const k of ['input', 'output'] as const) if (num(r[k]) !== undefined) out[k] = Math.max(0, Math.round(r[k] as number));
  if (r.reasoning === null || num(r.reasoning) !== undefined) out.reasoning = r.reasoning === null ? null : Math.max(0, Math.round(r.reasoning as number));
  if (r.costUsd === null || num(r.costUsd) !== undefined) out.costUsd = r.costUsd === null ? null : Math.max(0, r.costUsd as number);
  if (typeof r.costEstimated === 'boolean') out.costEstimated = r.costEstimated;
  if (r.credits === null || num(r.credits) !== undefined) out.credits = r.credits === null ? null : Math.max(0, r.credits as number);
  if (num(r.searches) !== undefined && (r.searches as number) > 0) out.searches = Math.min(50, Math.round(r.searches as number));
  return out;
}

/** A section's StepInfo, or null when it isn't one (no time, or an unknown provider). */
export function normalizeStepInfo(raw: unknown): StepInfo | null {
  const r = obj(raw);
  const at = num(r.at);
  const provider = PROVIDERS.includes(r.provider as ProviderId) ? (r.provider as ProviderId) : null;
  if (!at || at <= 0 || !provider) return null;
  const meta = provider === 'server' ? normalizeGenMeta(r.meta) : undefined;
  const note = clip(r.note, C.step.note);
  const researchAt = num(r.researchAt);
  const skills = texts(r.skills, C.step.skills, (v) => clip(v, C.step.skill));
  return { at, provider, ...(meta ? { meta } : {}), ...(note ? { note } : {}), factsHash: clip(r.factsHash, 20), ...(researchAt !== undefined ? { researchAt } : {}), ...(skills.length ? { skills } : {}) };
}

/** The networks a strategy plans for: the campaign's, else Instagram and Facebook. */
export function strategyNetworks(p: Project): PostPlatform[] {
  const list = (p.marketing?.campaign?.platforms ?? []).filter((x): x is PostPlatform => POST_NETWORKS.includes(x));
  return list.length ? [...new Set(list)] : ['instagram', 'facebook'];
}
