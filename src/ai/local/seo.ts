import type {
  Brand,
  Directives,
  FaqData,
  GuaranteeData,
  HeroData,
  PricingData,
  ProblemData,
  Project,
  ProofData,
  ProofStat,
  SalesPage,
  SalesSection,
  SalesSectionType,
  SeoMeta,
  ServicePriceModel,
  SolutionData,
} from '@/lib/types';
import { capitalize, escapeHtml, hashStr, lighten, darken, readableOn, slugify, titleCase, truncate, uid, wordCount, ensureUrl } from '@/lib/utils';
import { FORMATS } from '../knowledge';
import { buildFacts, singular, verbOutcome, Voice, type Facts } from '../text';
import { SCRIPT_CLOSE } from './code';

const LT = String.fromCharCode(60);

/** "a" or "an" for the word that follows. */
const article = (next: string) => (/^[aeiou]/i.test(next.trim()) ? 'an' : 'a');

export function primaryKeywordFor(f: Facts): string {
  if (f.track === 'business') {
    const type = (f.business?.label ?? 'services').split(/[&,]/)[0].trim().toLowerCase();
    return f.city ? `${type} in ${f.city.toLowerCase()}` : `${type} near me`;
  }
  const noun = f.formatNoun.toLowerCase();
  return f.topicLower.includes(noun) ? f.topicLower : `${f.topicLower} ${noun}`;
}

function fitTitle(primary: string, brand: string): string {
  const full = `${titleCase(primary)} | ${brand}`;
  if (full.length <= 60) return full;
  const noBrand = titleCase(primary);
  return noBrand.length <= 60 ? noBrand : truncate(noBrand, 60);
}

function fitDescription(s: string): string {
  if (s.length <= 158) return s;
  const sentences = s.match(/[^.!?]+[.!?]+/g) ?? [s];
  let out = '';
  for (const sent of sentences) {
    if ((out + sent).trim().length > 158) break;
    out += sent;
  }
  if (out.trim().length >= 90) return out.trim();
  const words = s.slice(0, 157).split(' ').slice(0, -1);
  while (words.length && /^(for|with|the|and|to|of|a|an|in|on|by|your)$/i.test(words[words.length - 1])) words.pop();
  return words.join(' ').replace(/[\s,;:.]+$/, '') + '.';
}

const KW_STOP = new Set(['in', 'with', 'for', 'to', 'of', 'and', 'a', 'an', 'the', 'on', 'at', 'by', 'your', 'every']);

/** Keep long-tail keywords searchable: whole words only, no dangling prepositions or numbers. */
function trimKeyword(s: string, maxWords = 9): string {
  const words = s.trim().split(/\s+/).slice(0, maxWords);
  while (words.length > 3 && (KW_STOP.has(words[words.length - 1].toLowerCase()) || /^\d+$/.test(words[words.length - 1]))) words.pop();
  return words.join(' ');
}

export function generateSeoMeta(project: Project, d: Directives = {}, variation = 0): SeoMeta {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|seo|${variation}`));
  const primary = primaryKeywordFor(f);
  const sec =
    f.track === 'business'
      ? [
          `best ${(f.business?.label ?? 'service').toLowerCase().split(/[&,]/)[0].trim()} ${f.city ? `in ${f.city.toLowerCase()}` : 'near me'}`,
          `${f.topicLower} near me`,
          `affordable ${f.topicLower}`,
          ...f.terms.slice(0, 2),
          f.city ? `${f.city.toLowerCase()} ${f.business?.category.toLowerCase()}` : 'local business',
        ]
      : [
          `${f.topicLower} for ${f.audience}`,
          trimKeyword(`how to ${verbOutcome(f.outcomes[0])}`),
          `best ${f.topicLower} ${f.formatNoun.toLowerCase()}`,
          ...f.terms.slice(0, 2),
          `${f.topicLower} template`,
        ];
  const secondary = [...new Set(sec.map((s) => s.trim()).filter((s) => s && s !== primary))].slice(0, 6);
  const metaTitle = fitTitle(primary, f.brand);
  const metaDescription = fitDescription(
    f.track === 'business'
      ? `${f.brand} offers ${primary} for ${f.audience}.${pageLink(project) ? ' Book today.' : ''}`
      : `${f.productShort} is ${article(primary)} ${primary} for ${f.audience}. Want to ${verbOutcome(f.outcomes[0])}? ${v.pick(['Start today.', 'See what’s inside.'])}`,
  );
  const slug = slugify(primary).split('-').slice(0, 5).join('-');
  return {
    metaTitle,
    metaDescription,
    slug,
    primaryKeyword: primary,
    secondaryKeywords: secondary,
    ogTitle: truncate(f.track === 'business' ? `${f.brand}: ${titleCase(primary)}` : `${f.productShort}: ${titleCase(primary)} for ${titleCase(f.audience)}`, 70),
    ogDescription: truncate(metaDescription, 200),
    ogImageAlt: f.track === 'business' ? `${f.brand} logo and name` : `${f.productShort} preview`,
    canonical: canonicalFor(project, slug),
  };
}

/** The owner's own website, or '' (never a guessed domain). */
export function siteUrl(project: Project): string {
  return ensureUrl(project.brand.websiteUrl).replace(/\/$/, '');
}

/** Where this page will live: the owner's website plus the slug. Empty until they add a website. */
export function canonicalFor(project: Project, slug: string): string {
  const site = siteUrl(project);
  return site ? `${site}/${slug}` : '';
}

/** The canonical to keep when the slug changes (typed, or new metadata generated). An address that follows
 *  the slug (empty, or ending in the old slug) moves to the new slug; any other address the owner pasted is kept. */
export function canonicalForSlugChange(project: Project, canonical: string, oldSlug: string, newSlug: string): string {
  const cur = canonical.trim();
  if (!cur) return canonicalFor(project, newSlug);
  if (!/^https?:\/\/[^/?#]+\/[^?#]*$/i.test(cur)) return cur;
  // Ignore one trailing slash unless that's where the (empty) old slug sits.
  const path = oldSlug && cur.endsWith('/') ? cur.slice(0, -1) : cur;
  const cut = path.lastIndexOf('/');
  const base = path.slice(0, cut);
  if (/^https?:\/?$/i.test(base) || path.slice(cut + 1) !== oldSlug) return cur;
  return `${base}/${newSlug}`;
}

/** Where the page's buttons go: the owner's own buy or booking link, else their website, else ''. */
export function pageLink(project: Project): string {
  return ensureUrl(project.studio.listing.buyUrl ?? '') || siteUrl(project);
}

/** The section of this type on the page being replaced, so a rewrite keeps what the owner entered. */
type SectionData = { [S in SalesSection as S['type']]: S['data'] };
function previous<T extends SalesSectionType>(project: Project, type: T): SectionData[T] | null {
  const s = project.marketing.salesPage?.sections.find((x) => x.type === type);
  return s ? (s.data as SectionData[T]) : null;
}

/** Fine print under the hero button: only what the price model says, never a promise. */
function finePrint(project: Project): string {
  if (project.track === 'business') return '';
  return project.studio.priceModel === 'monthly' ? 'Billed monthly' : project.studio.priceModel === 'yearly' ? 'Billed yearly' : 'One-time payment';
}

/** Hero bullets: only what the owner set up (their packages, chosen features or outline), never outcomes. */
function heroBullets(project: Project): string[] {
  const clean = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))].slice(0, 3);
  if (project.track === 'business') return clean(project.studio.packages.map((p) => p.name));
  if (project.idea?.features?.length) return clean(project.idea.features);
  return clean(project.studio.outline.map((s) => s.title.replace(/^(Module|Chapter|Section) \d+:\s*/i, '')));
}

function heroData(f: Facts, v: Voice, primary: string, project: Project): HeroData {
  const outcome = verbOutcome(f.outcomes[0]);
  const label = titleCase((f.business?.label ?? 'Service').split(/[&,]/)[0].trim());
  const headline =
    f.track === 'business'
      ? v.pick([`${titleCase(primary)} From ${f.brand}`, `${f.city ? `${f.city} ` : ''}${label} by ${f.brand}`, `${label} for ${titleCase(f.audience)}, From ${f.brand}`, `Looking for ${titleCase(primary)}?`])
      : v.pick([`The ${titleCase(primary)} for ${titleCase(f.audience)}`, `Want to ${outcome}?`, `${capitalize(article(primary))} ${titleCase(primary)} Made for ${titleCase(f.audience)}`]);
  return {
    eyebrow: f.track === 'business' && f.city ? `Serving ${f.city}${f.region ? `, ${f.region}` : ''}` : `For ${f.audience}`,
    headline,
    subheadline:
      f.track === 'business'
        ? `${f.brand} provides ${primary} for ${f.audience}.`
        : `${f.productShort} is ${article(primary)} ${primary} for ${f.audience} who want to ${outcome}.`,
    ctaLabel: f.track === 'business' ? `Book now` : `Get ${f.productShort} · ${f.priceStr}${f.priceSuffix}`,
    ctaSubtext: finePrint(project),
    bullets: heroBullets(project),
  };
}

function problemData(f: Facts, v: Voice): ProblemData {
  return {
    heading: v.pick(['Sound familiar?', `Why ${f.topicLower} feels so hard`, `The problem with ${f.topicLower} today`]),
    intro: `For ${f.audience} dealing with ${f.pain}, a few things may sound familiar.`,
    points: f.pains.slice(0, 3).map((p, i) => ({
      title: capitalize(p),
      body: [
        `It eats time you don’t have and makes every week feel behind.`,
        `You try a fix, it works for a while, then everything slides back.`,
        `The advice out there contradicts itself, so you second-guess every step.`,
      ][i % 3],
    })),
    // No consequences or outcomes asserted for the reader: the line points to what the offer is.
    agitation: `Below: what ${f.local ? f.brand : f.productShort} offers, who it’s for, and how to ${f.local ? 'book' : 'get it'}.`,
  };
}

function solutionData(f: Facts, project: Project): SolutionData {
  const icons = ['check-circle', 'zap', 'layers', 'shield-check', 'clock', 'sparkles'];
  let features: SolutionData['features'];
  if (project.track === 'business' && project.studio.packages.length) {
    features = project.studio.packages.slice(0, 3).map((p, i) => ({ title: p.name, body: p.description, icon: icons[i] }));
  } else if (project.studio.outline.length) {
    features = project.studio.outline.slice(0, 6).map((s, i) => ({ title: s.title.replace(/^(Module|Chapter|Section) \d+:\s*/i, ''), body: s.summary || s.items.slice(0, 2).map((x) => x.title).join(' · '), icon: icons[i % icons.length] }));
  } else {
    // Only features the owner chose; otherwise obvious placeholders to fill in (never invented features).
    const feats = project.idea?.features?.length ? project.idea.features : null;
    features = feats
      ? feats.map((x, i) => ({ title: x, body: `[What ${x} does for ${f.audience}]`, icon: icons[i % icons.length] }))
      : [1, 2, 3].map((n, i) => ({ title: `[Feature ${n}]`, body: `[What it does for ${f.audience}]`, icon: icons[i] }));
  }
  return {
    heading: project.track === 'business' ? `How ${f.brand} works` : `Meet ${f.productShort}`,
    intro: project.track === 'business' ? f.pitch || `${capitalize(f.business?.label.toLowerCase() ?? 'service')} for ${f.audience}.` : `${f.productShort} is ${article(f.formatNoun)} ${f.formatNoun.toLowerCase()} about ${f.topicLower} for ${f.audience}.`,
    features,
  };
}

/** Labels of the counts taken from the real outline (current or older wording). */
export function outlineStatLabels(project: Project): string[] {
  const fmt = project.format ? FORMATS[project.format] : null;
  const unit = fmt ? titleCase(fmt.unit) : 'Sections';
  return [unit, titleCase(singular(unit)), 'Sections', 'Section', 'Lessons, tools & steps', 'Lesson, tool or step'];
}

/** Facts counted from the product's actual outline. Nothing when there's no outline yet. */
export function outlineStats(project: Project): ProofStat[] {
  if (project.track === 'business') return [];
  const outline = project.studio.outline;
  const items = outline.reduce((s, x) => s + x.items.length, 0);
  const fmt = project.format ? FORMATS[project.format] : null;
  const unit = fmt ? titleCase(fmt.unit) : 'Sections';
  const stats: ProofStat[] = [];
  if (outline.length) stats.push({ value: String(outline.length), label: outline.length === 1 ? titleCase(singular(unit)) : unit });
  if (items) stats.push({ value: String(items), label: items === 1 ? 'Lesson, tool or step' : 'Lessons, tools & steps' });
  return stats;
}

/** Proof starts empty: the owner adds real quotes and facts. Counts from the real outline are refreshed;
 *  anything the owner already entered is kept. */
function proofData(project: Project): ProofData {
  const prev = previous(project, 'proof');
  const counted = new Set(outlineStatLabels(project));
  const kept = (prev?.stats ?? []).filter((x) => !counted.has(x.label));
  return {
    heading: 'What customers say',
    stats: [...outlineStats(project), ...kept],
    testimonials: prev?.testimonials ?? [],
  };
}

/** The price as the page shows it: a business with no price set asks for a quote (never "$0"). */
export function priceText(price: number, business: boolean): string {
  return price > 0 ? `$${price}` : business ? 'Ask for a quote' : 'Free';
}

/** What the price model says about billing, and nothing more (no "cancel anytime"). */
const PRICE_NOTE: Record<ServicePriceModel, string> = { 'one-time': 'one-time payment', monthly: 'per month', yearly: 'per year', 'per-session': 'per visit', project: 'per project', quote: 'starting price', free: '' };

function pricingData(f: Facts, project: Project): PricingData {
  const prev = previous(project, 'pricing');
  // a business leads with the package it marked popular, else its first one (as its listing does)
  const popular = project.track === 'business' ? (project.studio.packages.find((p) => p.popular) ?? project.studio.packages[0]) : undefined;
  const price = popular?.price ?? f.price;
  // A "was" price only when the owner set one (in the Studio, or on this page before).
  const studioCompare = project.studio.compareAt > 0 ? project.studio.compareAt : 0;
  const compare = studioCompare || prev?.compareAt || 0;
  const review = !studioCompare && !!prev?.compareAtNeedsReview;
  const includes = project.track === 'business' ? popular?.includes ?? [] : [f.product, ...(project.idea?.features ?? [])].slice(0, 6);
  return {
    heading: project.track === 'business' ? 'Pricing' : 'Get started today',
    planName: project.track === 'business' ? popular?.name ?? f.brand : f.productShort,
    price,
    compareAt: compare > price ? compare : 0,
    ...(review && compare > price ? { compareAtNeedsReview: true } : {}),
    priceNote: PRICE_NOTE[popular?.priceModel ?? project.studio.priceModel] ?? '',
    includes,
    ctaLabel: project.track === 'business' ? 'Book your appointment' : `Get ${f.productShort}`,
    badge: prev?.badge ?? '',
  };
}

/** What's actually in it (the real outline or packages), else a placeholder for the owner to fill in. */
function differenceAnswer(f: Facts, project: Project): string {
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
  if (project.track === 'business') {
    const names = project.studio.packages.slice(0, 4).map((p) => p.name.trim()).filter(Boolean);
    if (names.length) return `${f.brand} offers ${list(names)}.`;
  } else {
    const titles = project.studio.outline.slice(0, 5).map((s) => s.title.replace(/^(Module|Chapter|Section) \d+:\s*/i, '').trim()).filter(Boolean);
    if (titles.length) return `It covers ${list(titles)}.`;
  }
  return `[What makes ${project.track === 'business' ? f.brand : f.productShort} different]`;
}

function faqData(f: Facts, primary: string, project: Project): FaqData {
  const items: FaqData['items'] = [
    { q: `Who is this ${f.track === 'business' ? 'service' : f.formatNoun.toLowerCase()} for?`, a: f.track === 'business' ? `${f.brand} serves ${f.audience}${f.city ? ` in ${f.city}${f.region ? `, ${f.region}` : ''}` : ''}.` : `It’s for ${f.audience} who want to ${verbOutcome(f.outcomes[0])}.` },
    { q: `What makes this ${primary} different?`, a: differenceAnswer(f, project) },
    // The answer to an objection is the owner's to give: a placeholder, never an invented "Yes, it works".
    ...f.objections.slice(0, 2).map((o) => ({ q: o.endsWith('?') ? o : `${o}. Will this still work for me?`, a: `[Your answer]` })),
  ];
  // Booking and refund answers only from what the owner told us: their phone number, their own guarantee.
  if (f.track === 'business') {
    const phone = project.studio.listing.phone?.trim();
    items.push({ q: 'How do I book?', a: `Use the booking button on this page${phone ? ` or call ${phone}` : ''}.` });
  } else {
    const g = previous(project, 'guarantee');
    if (g?.offered && g.body.trim()) items.push({ q: 'What if it’s not right for me?', a: g.body.trim() });
  }
  return { heading: 'Frequently asked questions', items };
}

/** A guarantee only when the owner turned theirs on (kept across rewrites); otherwise just the closing heading and button. */
function guaranteeData(f: Facts, project: Project): GuaranteeData {
  const prev = previous(project, 'guarantee');
  const own = prev?.offered ? prev : null;
  return {
    heading: own?.heading ?? '',
    body: own?.body ?? '',
    days: own?.days ?? 0,
    finalHeading: project.track === 'business' ? `Ready to book with ${f.brand}?` : `Ready to ${verbOutcome(f.outcomes[0])}?`,
    finalCta: project.track === 'business' ? 'Book now' : `Get ${f.productShort}`,
    offered: !!own,
  };
}

export function generateSalesSection(project: Project, type: SalesSectionType, d: Directives = {}, variation = 0): SalesSection {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|sales|${type}|${variation}`));
  const primary = primaryKeywordFor(f);
  const id = uid('sec');
  switch (type) {
    case 'hero':
      return { id, type, visible: true, data: heroData(f, v, primary, project) };
    case 'problem':
      return { id, type, visible: true, data: problemData(f, v) };
    case 'solution':
      return { id, type, visible: true, data: solutionData(f, project) };
    case 'proof':
      return { id, type, visible: true, data: proofData(project) };
    case 'pricing':
      return { id, type, visible: true, data: pricingData(f, project) };
    case 'faq':
      return { id, type, visible: true, data: faqData(f, primary, project) };
    case 'guarantee':
    default:
      return { id, type: 'guarantee', visible: true, data: guaranteeData(f, project) };
  }
}

export const SECTION_ORDER: SalesSectionType[] = ['hero', 'problem', 'solution', 'proof', 'pricing', 'faq', 'guarantee'];
export const SECTION_LABEL: Record<SalesSectionType, string> = {
  hero: 'Hero & CTA',
  problem: 'Problem / agitation',
  solution: 'Solution & features',
  proof: 'Social proof',
  pricing: 'Pricing card',
  faq: 'FAQ',
  guarantee: 'Guarantee & final CTA',
  gallery: 'Gallery',
};

export function generateSalesPage(project: Project, d: Directives = {}, variation = 0): SalesPage {
  return {
    sections: SECTION_ORDER.map((t) => generateSalesSection(project, t, d, variation)),
    theme: { font: project.brand.logo.font === 'serif' ? 'serif' : 'grotesk', mode: 'light', radius: 'soft' },
    updatedAt: Date.now(),
    claimsChecked: true,
  };
}

// ───────────────────────── Facts vs copy ─────────────────────────

/** Fields that hold facts (the owner's inputs, or real data), never AI copy. */
const FACT_FIELDS: Partial<Record<SalesSectionType, string[]>> = {
  hero: ['ctaSubtext'],
  proof: ['stats', 'testimonials'],
  pricing: ['price', 'compareAt', 'compareAtNeedsReview', 'priceNote', 'badge'],
  guarantee: ['heading', 'body', 'days', 'offered'],
};

/** The part of a section the AI may rewrite. */
export function aiWritableData(s: SalesSection): Record<string, unknown> {
  const facts = new Set(FACT_FIELDS[s.type] ?? []);
  return Object.fromEntries(Object.entries(s.data).filter(([k]) => !facts.has(k)));
}

/** `next` with the facts put back from `base`, whatever the AI returned for them. */
export function keepFacts(next: SalesSection, base: SalesSection): SalesSection {
  const facts = FACT_FIELDS[base.type] ?? [];
  if (next.type !== base.type) return base;
  if (!facts.length) return next;
  const data: Record<string, unknown> = { ...next.data };
  for (const k of facts) {
    if (k in base.data) data[k] = (base.data as unknown as Record<string, unknown>)[k];
    else delete data[k];
  }
  return { ...next, data } as unknown as SalesSection;
}

const filled = (s: string) => !!s.trim();

/** What of the proof section can go on the published page: confirmed, filled-in items only. */
export function publishableProof(d: ProofData): ProofData {
  return {
    heading: d.heading,
    stats: d.stats.filter((x) => !x.needsReview && filled(x.value) && filled(x.label)),
    testimonials: d.testimonials.filter((t) => !t.needsReview && filled(t.quote) && filled(t.name)),
  };
}

export const showsGuarantee = (d: GuaranteeData) => !!d.offered && (filled(d.heading) || filled(d.body));
export const showsCompareAt = (d: PricingData) => !d.compareAtNeedsReview && d.compareAt > d.price;

/** Items written before the app stopped inventing proof, waiting for the owner to confirm or remove them. */
export function claimsToReview(page: SalesPage | null): number {
  let n = 0;
  for (const s of page?.sections ?? []) {
    if (s.type === 'proof') n += s.data.stats.filter((x) => x.needsReview).length + s.data.testimonials.filter((t) => t.needsReview).length;
    if (s.type === 'pricing' && s.data.compareAtNeedsReview) n += 1;
  }
  return n;
}

// ───────────────────────── SEO scoring ─────────────────────────

export interface SeoCheck {
  id: string;
  label: string;
  pass: boolean;
  partial?: boolean;
  weight: number;
  tip: string;
}

export function pageText(page: SalesPage): { all: string; h1: string; h2s: string[]; firstPara: string } {
  const parts: string[] = [];
  const h2s: string[] = [];
  let h1 = '';
  let firstPara = '';
  for (const s of page.sections) {
    if (!s.visible) continue;
    switch (s.type) {
      case 'hero':
        h1 = s.data.headline;
        firstPara = s.data.subheadline;
        parts.push(s.data.eyebrow, s.data.headline, s.data.subheadline, ...s.data.bullets, s.data.ctaLabel);
        break;
      case 'problem':
        h2s.push(s.data.heading);
        parts.push(s.data.heading, s.data.intro, ...s.data.points.flatMap((p) => [p.title, p.body]), s.data.agitation);
        break;
      case 'solution':
        h2s.push(s.data.heading);
        parts.push(s.data.heading, s.data.intro, ...s.data.features.flatMap((x) => [x.title, x.body]));
        break;
      case 'proof': {
        // Only what the published page shows: the heading goes with real testimonials.
        const proof = publishableProof(s.data);
        if (proof.testimonials.length) {
          h2s.push(proof.heading);
          parts.push(proof.heading);
        }
        parts.push(...proof.stats.map((x) => `${x.value} ${x.label}`), ...proof.testimonials.map((t) => t.quote));
        break;
      }
      case 'pricing':
        h2s.push(s.data.heading);
        parts.push(s.data.heading, s.data.planName, ...s.data.includes);
        break;
      case 'faq':
        h2s.push(s.data.heading);
        parts.push(s.data.heading, ...s.data.items.flatMap((i) => [i.q, i.a]));
        break;
      case 'guarantee':
        if (showsGuarantee(s.data)) {
          h2s.push(s.data.heading);
          parts.push(s.data.heading, s.data.body, s.data.finalHeading);
        } else {
          h2s.push(s.data.finalHeading);
          parts.push(s.data.finalHeading);
        }
        break;
    }
  }
  return { all: parts.join(' '), h1, h2s, firstPara };
}

function countPhrase(text: string, phrase: string): number {
  if (!phrase.trim()) return 0;
  const re = new RegExp(phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi');
  return (text.match(re) || []).length;
}

export function scoreSeo(meta: SeoMeta, page: SalesPage | null): { score: number; checks: SeoCheck[]; words: number; density: number } {
  const kw = meta.primaryKeyword.trim().toLowerCase();
  const { all, h1, h2s, firstPara } = page ? pageText(page) : { all: '', h1: '', h2s: [], firstPara: '' };
  const words = wordCount(all);
  const occurrences = countPhrase(all, kw);
  const density = words ? (occurrences * Math.max(1, kw.split(/\s+/).length)) / words : 0;
  const includes = (s: string) => !!kw && s.toLowerCase().includes(kw);
  const kwWords = kw.split(/\s+/).filter((w) => w.length > 2);
  const looseIncludes = (s: string) => kwWords.length > 0 && kwWords.every((w) => s.toLowerCase().includes(w));
  const secondaryUsed = meta.secondaryKeywords.filter((k) => countPhrase(all + ' ' + meta.metaDescription, k) > 0).length;
  const faq = page?.sections.find((s) => s.type === 'faq' && s.visible);
  const hero = page?.sections.find((s) => s.type === 'hero' && s.visible);
  const tLen = meta.metaTitle.length;
  const dLen = meta.metaDescription.length;
  const checks: SeoCheck[] = [
    { id: 'title-len', label: 'Meta title is 30–60 characters', pass: tLen >= 30 && tLen <= 60, partial: tLen > 0 && tLen < 70, weight: 10, tip: `Currently ${tLen} characters.` },
    { id: 'title-kw', label: 'Primary keyword in meta title', pass: includes(meta.metaTitle), partial: looseIncludes(meta.metaTitle), weight: 10, tip: 'Put the exact keyword near the start of the title.' },
    { id: 'desc-len', label: 'Meta description is 120–160 characters', pass: dLen >= 120 && dLen <= 160, partial: dLen >= 80 && dLen <= 175, weight: 8, tip: `Currently ${dLen} characters.` },
    { id: 'desc-kw', label: 'Keyword in meta description', pass: includes(meta.metaDescription), partial: looseIncludes(meta.metaDescription), weight: 7, tip: 'Mention the keyword naturally once.' },
    { id: 'h1-kw', label: 'Keyword in the H1 headline', pass: includes(h1), partial: looseIncludes(h1), weight: 10, tip: 'Your hero headline is the page’s H1.' },
    { id: 'intro-kw', label: 'Keyword in the first paragraph', pass: includes(firstPara), partial: looseIncludes(firstPara), weight: 6, tip: 'Use it in the hero subheadline.' },
    { id: 'slug', label: 'Short URL slug containing the keyword', pass: kwWords.every((w) => meta.slug.includes(w.replace(/[^a-z0-9]/g, ''))) && meta.slug.split('-').length <= 6, partial: meta.slug.length > 0, weight: 6, tip: 'Keep slugs to 3–5 words.' },
    { id: 'words', label: 'At least 350 words of content', pass: words >= 350, partial: words >= 220, weight: 8, tip: `Currently ${words} words.` },
    { id: 'density', label: 'Keyword density between 0.5% and 2.5%', pass: density >= 0.005 && density <= 0.025, partial: occurrences > 0, weight: 7, tip: `Currently ${(density * 100).toFixed(1)}% (${occurrences} uses).` },
    { id: 'h2', label: 'At least 3 H2 section headings', pass: h2s.length >= 3, partial: h2s.length >= 1, weight: 5, tip: `${h2s.length} section headings visible.` },
    { id: 'secondary', label: 'Two or more secondary keywords used', pass: secondaryUsed >= 2, partial: secondaryUsed === 1, weight: 6, tip: `${secondaryUsed} of ${meta.secondaryKeywords.length} found on the page.` },
    { id: 'faq', label: 'FAQ section with 3+ questions (FAQ schema)', pass: !!faq && faq.type === 'faq' && faq.data.items.length >= 3, weight: 5, tip: 'FAQ rich results can win extra search space.' },
    { id: 'og', label: 'OpenGraph title and description set', pass: !!meta.ogTitle && !!meta.ogDescription, weight: 5, tip: 'Controls how links look when shared.' },
    { id: 'cta', label: 'Call to action above the fold', pass: !!hero && hero.type === 'hero' && !!hero.data.ctaLabel, weight: 4, tip: 'The hero needs a clear button.' },
    { id: 'alt', label: 'Social image has alt text', pass: meta.ogImageAlt.trim().length >= 8, weight: 3, tip: 'Describe the image for screen readers.' },
  ];
  const max = checks.reduce((s, c) => s + c.weight, 0);
  const got = checks.reduce((s, c) => s + (c.pass ? c.weight : c.partial ? c.weight * 0.45 : 0), 0);
  return { score: Math.round((got / max) * 100), checks, words, density };
}

// ───────────────────────── HTML export ─────────────────────────

const ICON_SVG: Record<string, string> = {
  'check-circle': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  'shield-check': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  sparkles: '<path d="m12 3-1.9 5.8L4 10.7l6.1 1.9L12 18.4l1.9-5.8 6.1-1.9-6.1-1.9z"/>',
};

export function exportSalesHtml(page: SalesPage, meta: SeoMeta, brand: Brand, project: Project): string {
  const c = brand.colors;
  const dark = page.theme.mode === 'dark';
  const bg = dark ? '#0f1412' : '#ffffff';
  const ink = dark ? '#eef3ef' : c.ink;
  const muted = dark ? '#a9b8af' : '#5b6861';
  const soft = dark ? '#18211c' : lighten(c.primary, 0.93);
  const radius = page.theme.radius === 'sharp' ? '4px' : page.theme.radius === 'round' ? '22px' : '12px';
  const font =
    page.theme.font === 'serif'
      ? 'Georgia, "Times New Roman", serif'
      : page.theme.font === 'grotesk'
        ? '"Helvetica Neue", Arial, system-ui, sans-serif'
        : 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  const e = escapeHtml;
  // Only the owner's own addresses: no guessed domain. Without a link, buttons stay on the page.
  const site = ensureUrl(brand.websiteUrl).replace(/\/$/, '');
  const link = pageLink(project) || '#pricing';
  const faq = page.sections.find((s) => s.type === 'faq');
  const pricing = page.sections.find((s) => s.type === 'pricing');
  const ld: Record<string, unknown>[] = [
    project.track === 'business'
      ? {
          '@context': 'https://schema.org',
          '@type': 'LocalBusiness',
          name: brand.name,
          description: meta.metaDescription,
          ...(site ? { url: site } : {}),
          ...(project.location ? { address: { '@type': 'PostalAddress', addressLocality: project.location.city, addressRegion: project.location.region } } : {}),
        }
      : {
          '@context': 'https://schema.org',
          '@type': 'Product',
          name: pricing && pricing.type === 'pricing' ? pricing.data.planName : brand.name,
          description: meta.metaDescription,
          brand: { '@type': 'Brand', name: brand.name },
          offers: { '@type': 'Offer', priceCurrency: 'USD', price: pricing && pricing.type === 'pricing' ? pricing.data.price : project.studio.price, availability: 'https://schema.org/InStock', ...(meta.canonical ? { url: meta.canonical } : {}) },
        },
  ];
  if (faq && faq.type === 'faq' && faq.visible) {
    ld.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.data.items.map((i) => ({ '@type': 'Question', name: i.q, acceptedAnswer: { '@type': 'Answer', text: i.a } })),
    });
  }
  const json = JSON.stringify(ld.length === 1 ? ld[0] : ld, null, 2).replace(/</g, '\\u003c');

  const sectionHtml = page.sections
    .filter((s) => s.visible)
    .map((s) => {
      switch (s.type) {
        case 'hero':
          return `  <header class="hero">
    <div class="wrap">
      <p class="eyebrow">${e(s.data.eyebrow)}</p>
      <h1>${e(s.data.headline)}</h1>
      <p class="lead">${e(s.data.subheadline)}</p>
      ${s.data.bullets.length ? `<ul class="ticks">${s.data.bullets.map((b) => `<li>${e(b)}</li>`).join('')}</ul>` : ''}
      <a class="btn" href="#pricing">${e(s.data.ctaLabel)}</a>
      ${s.data.ctaSubtext.trim() ? `<p class="fine">${e(s.data.ctaSubtext)}</p>` : ''}
    </div>
  </header>`;
        case 'problem':
          return `  <section class="problem">
    <div class="wrap">
      <h2>${e(s.data.heading)}</h2>
      <p class="lead">${e(s.data.intro)}</p>
      <div class="grid">${s.data.points.map((p) => `<div class="card"><h3>${e(p.title)}</h3><p>${e(p.body)}</p></div>`).join('')}</div>
      <p class="agitate">${e(s.data.agitation)}</p>
    </div>
  </section>`;
        case 'solution':
          return `  <section class="solution">
    <div class="wrap">
      <h2>${e(s.data.heading)}</h2>
      <p class="lead">${e(s.data.intro)}</p>
      <div class="grid">${s.data.features
        .map(
          (x) =>
            `<div class="feature"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_SVG[x.icon] ?? ICON_SVG['check-circle']}</svg><h3>${e(x.title)}</h3><p>${e(x.body)}</p></div>`,
        )
        .join('')}</div>
    </div>
  </section>`;
        case 'proof': {
          // Left out until there's something real to show: confirmed quotes and facts only.
          const proof = publishableProof(s.data);
          if (!proof.stats.length && !proof.testimonials.length) return '';
          const stars = (n: number) => {
            const r = Math.max(0, Math.min(5, Math.round(n)));
            return r ? `<div class="stars" aria-label="${r} out of 5 stars">${'★'.repeat(r)}</div>` : '';
          };
          return `  <section class="proof">
    <div class="wrap">
      ${proof.testimonials.length ? `<h2>${e(proof.heading)}</h2>` : ''}
      ${proof.stats.length ? `<div class="stats">${proof.stats.map((x) => `<div><b>${e(x.value)}</b><span>${e(x.label)}</span></div>`).join('')}</div>` : ''}
      ${proof.testimonials.length ? `<div class="grid">${proof.testimonials.map((t) => `<figure class="card">${stars(t.rating)}<blockquote>“${e(t.quote)}”</blockquote><figcaption><b>${e(t.name)}</b>${t.role.trim() ? ` · ${e(t.role)}` : ''}</figcaption></figure>`).join('')}</div>` : ''}
    </div>
  </section>`;
        }
        case 'pricing':
          return `  <section class="pricing" id="pricing">
    <div class="wrap narrow">
      <h2>${e(s.data.heading)}</h2>
      <div class="price-card">
        ${s.data.badge ? `<span class="badge">${e(s.data.badge)}</span>` : ''}
        <h3>${e(s.data.planName)}</h3>
        <p class="price">${showsCompareAt(s.data) ? `<s>$${s.data.compareAt}</s> ` : ''}<b>${e(priceText(s.data.price, project.track === 'business'))}</b> <span>${e(s.data.priceNote)}</span></p>
        <ul class="ticks">${s.data.includes.map((i) => `<li>${e(i)}</li>`).join('')}</ul>
        <a class="btn block" href="${e(link)}">${e(s.data.ctaLabel)}</a>
      </div>
    </div>
  </section>`;
        case 'faq':
          return `  <section class="faq">
    <div class="wrap narrow">
      <h2>${e(s.data.heading)}</h2>
      ${s.data.items.map((i) => `<details><summary>${e(i.q)}</summary><p>${e(i.a)}</p></details>`).join('\n      ')}
    </div>
  </section>`;
        case 'guarantee': {
          // The owner's own guarantee, only when they turned it on; otherwise just the closing call to action.
          const days = Math.max(0, Math.round(s.data.days));
          const seal = days ? `<div class="seal" aria-hidden="true">${days}<small>DAY</small></div>\n      ` : '';
          const top = showsGuarantee(s.data) ? `${seal}<h2>${e(s.data.heading)}</h2>\n      <p>${e(s.data.body)}</p>\n      <h3>${e(s.data.finalHeading)}</h3>` : `<h2>${e(s.data.finalHeading)}</h2>`;
          return `  <section class="guarantee">
    <div class="wrap narrow">
      ${top}
      <a class="btn" href="${e(link)}">${e(s.data.finalCta)}</a>
    </div>
  </section>`;
        }
        default:
          return '';
      }
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${e(meta.metaTitle)}</title>
<meta name="description" content="${e(meta.metaDescription)}" />
<meta name="keywords" content="${e([meta.primaryKeyword, ...meta.secondaryKeywords].join(', '))}" />
${meta.canonical ? `<link rel="canonical" href="${e(meta.canonical)}" />\n` : ''}<meta property="og:type" content="${project.track === 'business' ? 'business.business' : 'product'}" />
<meta property="og:title" content="${e(meta.ogTitle)}" />
<meta property="og:description" content="${e(meta.ogDescription)}" />
${meta.canonical ? `<meta property="og:url" content="${e(meta.canonical)}" />\n` : ''}<meta property="og:image:alt" content="${e(meta.ogImageAlt)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${e(meta.ogTitle)}" />
<meta name="twitter:description" content="${e(meta.ogDescription)}" />
${LT}script type="application/ld+json">
${json}
${SCRIPT_CLOSE}
<style>
:root { --brand: ${c.primary}; --brand-dark: ${darken(c.primary, 0.2)}; --on-brand: ${readableOn(c.primary)}; --accent: ${c.accent}; --bg: ${bg}; --ink: ${ink}; --muted: ${muted}; --soft: ${soft}; --radius: ${radius}; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 17px/1.6 ${font}; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 0 20px; }
.wrap.narrow { max-width: 720px; }
section, header { padding: 72px 0; }
h1 { font-size: clamp(34px, 5vw, 56px); line-height: 1.05; letter-spacing: -0.02em; margin: 10px 0 18px; max-width: 18ch; }
h2 { font-size: clamp(26px, 3.4vw, 38px); line-height: 1.15; letter-spacing: -0.01em; margin: 0 0 12px; }
h3 { margin: 0 0 6px; font-size: 19px; }
.eyebrow { text-transform: uppercase; letter-spacing: .12em; font-size: 13px; font-weight: 700; color: var(--brand); margin: 0; }
.lead { font-size: 19px; color: var(--muted); max-width: 60ch; margin: 0 0 24px; }
.hero { background: radial-gradient(900px 400px at 90% 0%, var(--soft), transparent), var(--bg); }
.btn { display: inline-block; background: var(--brand); color: var(--on-brand); padding: 15px 26px; border-radius: var(--radius); font-weight: 700; text-decoration: none; }
.btn:hover { background: var(--brand-dark); }
.btn.block { display: block; text-align: center; }
.fine { font-size: 14px; color: var(--muted); }
.ticks { list-style: none; padding: 0; margin: 0 0 26px; display: grid; gap: 8px; }
.ticks li::before { content: "✓"; color: var(--brand); font-weight: 800; margin-right: 10px; }
.grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); margin-top: 28px; }
.card, .feature { background: var(--soft); border-radius: var(--radius); padding: 22px; margin: 0; }
.feature svg { color: var(--brand); }
.agitate { margin-top: 28px; font-size: 19px; font-weight: 600; }
.problem { background: var(--bg); }
.solution, .faq { background: var(--soft); }
.solution .feature { background: var(--bg); }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 24px; text-align: center; }
.stats b { display: block; font-size: 34px; color: var(--brand); }
.stats span { color: var(--muted); font-size: 14px; }
blockquote { margin: 8px 0 12px; font-size: 18px; }
.stars { color: var(--accent); letter-spacing: 2px; }
.price-card { position: relative; border: 2px solid var(--brand); border-radius: var(--radius); padding: 30px; margin-top: 22px; background: var(--bg); }
.badge { position: absolute; top: -13px; left: 26px; background: var(--accent); color: #111; font-size: 13px; font-weight: 800; padding: 4px 12px; border-radius: 999px; }
.price b { font-size: 46px; letter-spacing: -0.02em; }
.price s { color: var(--muted); font-size: 22px; }
.price span { color: var(--muted); font-size: 15px; }
details { background: var(--bg); border-radius: var(--radius); padding: 0 20px; margin: 10px 0; }
summary { cursor: pointer; padding: 18px 0; font-weight: 700; }
details p { margin: 0 0 18px; color: var(--muted); }
.guarantee { text-align: center; }
.seal { width: 92px; height: 92px; border-radius: 50%; margin: 0 auto 16px; background: var(--brand); color: var(--on-brand); display: grid; place-content: center; font-size: 30px; font-weight: 800; line-height: 1; }
.seal small { font-size: 11px; letter-spacing: .14em; }
footer { padding: 30px 0; text-align: center; color: var(--muted); font-size: 14px; }
@media (max-width: 640px) { section, header { padding: 52px 0; } .stats { grid-template-columns: 1fr; } }
</style>
</head>
<body>
${sectionHtml}
  <footer><div class="wrap">© ${new Date().getFullYear()} ${e(brand.name)}${site ? ` · <a href="${e(site)}">${e(site.replace(/^https?:\/\//, ''))}</a>` : ''}</div></footer>
</body>
</html>`;
}
