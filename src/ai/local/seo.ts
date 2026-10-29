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
  SalesPage,
  SalesSection,
  SalesSectionType,
  SeoMeta,
  SolutionData,
} from '@/lib/types';
import { capitalize, escapeHtml, hashStr, lighten, darken, lowerFirst, readableOn, slugify, titleCase, truncate, uid, wordCount, ensureUrl } from '@/lib/utils';
import { FORMATS } from '../knowledge';
import { buildFacts, singular, verbOutcome, Voice, type Facts } from '../text';
import { SCRIPT_CLOSE } from './code';
import { charmPrice } from './research';

const LT = String.fromCharCode(60);

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
      ? `${f.brand} offers trusted ${primary}. ${capitalize(f.outcomes[0])}, upfront pricing and friendly local service. Book online today.`
      : `${capitalize(verbOutcome(f.outcomes[0]))} with ${f.productShort}, the ${primary} built for ${f.audience}. ${v.pick(['Instant access.', 'Start today.', 'Get started in minutes.'])}`,
  );
  const slug = slugify(primary).split('-').slice(0, 5).join('-');
  return {
    metaTitle,
    metaDescription,
    slug,
    primaryKeyword: primary,
    secondaryKeywords: secondary,
    ogTitle: truncate(f.track === 'business' ? `${f.brand}: ${titleCase(primary)}` : `${f.productShort}: ${capitalize(verbOutcome(f.outcomes[0]))}`, 70),
    ogDescription: truncate(metaDescription, 200),
    ogImageAlt: `${f.brand} ${f.track === 'business' ? 'storefront and team' : `${f.productShort} preview`}`,
    canonical: `${ensureUrl(f.url).replace(/\/$/, '')}/${slug}`,
  };
}

function heroData(f: Facts, v: Voice, primary: string): HeroData {
  const outcome = verbOutcome(f.outcomes[0]);
  const headline =
    f.track === 'business'
      ? v.pick([`${titleCase(primary)} You Can Actually Count On`, `The ${f.city || 'Local'} ${titleCase((f.business?.label ?? 'Service').split(/[&,]/)[0].trim())} Neighbors Recommend`, `${capitalize(f.desire)}, From ${f.brand}`])
      : v.pick([`The ${titleCase(primary)} That Helps ${titleCase(f.audience)} ${titleCase(outcome)}`, `${capitalize(outcome)} With the ${titleCase(primary)}`, `Finally, a ${titleCase(primary)} Built for ${titleCase(f.audience)}`]);
  return {
    eyebrow: f.track === 'business' && f.city ? `Serving ${f.city}${f.region ? `, ${f.region}` : ''}` : `For ${f.audience}`,
    headline,
    subheadline:
      f.track === 'business'
        ? `${f.brand} provides ${primary} that takes ${f.pain} off your plate, with upfront pricing, on-time pros and work we guarantee.`
        : `${f.productShort} is the ${primary} that helps ${f.audience} ${outcome}, without ${f.pain}.`,
    ctaLabel: f.track === 'business' ? `Book now` : `Get ${f.productShort} · ${f.priceStr}${f.priceSuffix}`,
    ctaSubtext: f.track === 'business' ? 'Free estimates · Licensed & insured · Satisfaction promise' : 'Instant access · 30-day money-back guarantee',
    bullets: f.outcomes.slice(0, 3).map((o) => capitalize(verbOutcome(o))),
  };
}

function problemData(f: Facts, v: Voice): ProblemData {
  return {
    heading: v.pick(['Sound familiar?', `Why ${f.topicLower} feels so hard`, `The problem with ${f.topicLower} today`]),
    intro: `If you’re one of the many ${f.audience} dealing with ${f.pain}, you’re not alone, and it’s not your fault.`,
    points: f.pains.slice(0, 3).map((p, i) => ({
      title: capitalize(p),
      body: [
        `It eats time you don’t have and makes every week feel behind.`,
        `You try a fix, it works for a while, then everything slides back.`,
        `The advice out there contradicts itself, so you second-guess every step.`,
      ][i % 3],
    })),
    agitation: `Left alone, it compounds: more stress, more wasted ${f.local ? 'money' : 'hours'}, and the nagging feeling that ${lowerFirst(f.desire)} is for other people. It doesn’t have to be.`,
  };
}

function solutionData(f: Facts, project: Project): SolutionData {
  const icons = ['check-circle', 'zap', 'layers', 'shield-check', 'clock', 'sparkles'];
  let features: SolutionData['features'];
  if (project.track === 'business' && project.studio.packages.length) {
    features = project.studio.packages.slice(0, 3).map((p, i) => ({ title: p.name, body: p.description, icon: icons[i] }));
    features.push({ title: 'Upfront pricing', body: 'Know the price before we start. No surprise charges.', icon: 'shield-check' });
  } else if (project.studio.outline.length) {
    features = project.studio.outline.slice(0, 6).map((s, i) => ({ title: s.title.replace(/^(Module|Chapter|Section) \d+:\s*/i, ''), body: s.summary || s.items.slice(0, 2).map((x) => x.title).join(' · '), icon: icons[i % icons.length] }));
  } else {
    const feats = project.idea?.features ?? f.terms.slice(0, 4).map((t) => `Built-in ${t}`);
    features = feats.map((x, i) => ({ title: x, body: `Designed so ${f.audience} can ${verbOutcome(f.outcomes[i % f.outcomes.length])}.`, icon: icons[i % icons.length] }));
  }
  return {
    heading: project.track === 'business' ? `How ${f.brand} works` : `Meet ${f.productShort}`,
    intro: project.track === 'business' ? f.pitch || `Friendly, reliable ${f.business?.label.toLowerCase()} for ${f.audience}.` : `Everything you need to ${verbOutcome(f.outcomes[0])}, organized into a clear path you can follow at your own pace.`,
    features,
  };
}

function proofData(f: Facts, project: Project): ProofData {
  const outline = project.studio.outline;
  const itemsCount = outline.reduce((s, x) => s + x.items.length, 0);
  const fmt = project.format ? FORMATS[project.format] : null;
  const stats =
    project.track === 'business'
      ? [
          { value: '24h', label: 'Quote turnaround' },
          { value: '100%', label: 'Satisfaction promise' },
          { value: f.city || 'Local', label: 'Owned & operated' },
        ]
      : [
          { value: String(outline.length || 6), label: fmt ? titleCase(fmt.unit) : 'Sections' },
          { value: String(itemsCount || 24), label: 'Lessons, tools & steps' },
          { value: '30-day', label: 'Money-back guarantee' },
        ];
  return {
    heading: 'What people are saying',
    stats,
    testimonials: [
      { quote: `I stopped ${f.mistakes[0]} in the first week. Now I ${verbOutcome(f.outcomes[0])} without thinking about it.`, name: 'Jordan M.', role: capitalize(singular(f.audience)), rating: 5 },
      { quote: `Clear, practical and easy to follow. It saved me hours every single week.`, name: 'Priya S.', role: capitalize(singular(f.audience)), rating: 5 },
      { quote: `${capitalize(f.pain)} used to ruin my month. Not anymore.`, name: 'Marcus L.', role: capitalize(singular(f.audience)), rating: 5 },
    ],
  };
}

function pricingData(f: Facts, project: Project): PricingData {
  const compare = project.studio.compareAt && project.studio.compareAt > f.price ? project.studio.compareAt : charmPrice(f.price * 1.6);
  const includes =
    project.track === 'business'
      ? project.studio.packages.find((p) => p.popular)?.includes ?? f.business?.delivery.slice(0, 4) ?? []
      : [f.product, ...(project.idea?.features ?? []), 'Lifetime updates', '30-day money-back guarantee'].slice(0, 6);
  return {
    heading: project.track === 'business' ? 'Simple, upfront pricing' : 'Get started today',
    planName: project.track === 'business' ? project.studio.packages.find((p) => p.popular)?.name ?? f.brand : f.productShort,
    price: project.track === 'business' ? project.studio.packages.find((p) => p.popular)?.price ?? f.price : f.price,
    compareAt: compare,
    priceNote: project.studio.priceModel === 'monthly' ? 'per month · cancel anytime' : project.track === 'business' ? 'starting price' : 'one-time payment',
    includes,
    ctaLabel: project.track === 'business' ? 'Book your appointment' : `Get instant access`,
    badge: project.track === 'business' ? 'Most popular' : 'Launch price',
  };
}

function faqData(f: Facts, primary: string): FaqData {
  return {
    heading: 'Frequently asked questions',
    items: [
      { q: `Who is this ${f.track === 'business' ? 'service' : f.formatNoun.toLowerCase()} for?`, a: `It’s built for ${f.audience} who want to ${verbOutcome(f.outcomes[0])} without ${f.pain}.` },
      { q: `What makes this ${primary} different?`, a: `It’s practical and specific: clear steps, real examples and tools you can use the same day, not generic theory.` },
      ...f.objections.slice(0, 2).map((o) => ({ q: o.endsWith('?') ? o : `${o}. Will this still work for me?`, a: `Yes. ${capitalize(f.quickWins[0])} is a great first step, and everything is designed to fit a busy schedule.` })),
      {
        q: f.track === 'business' ? 'How do I book and pay?' : 'What if it’s not right for me?',
        a: f.track === 'business' ? `Book online in under a minute. You’ll get a confirmation right away, and you only pay once the job is done right.` : `You’re covered by our 30-day money-back guarantee. Email us and we’ll refund you, no hard feelings.`,
      },
    ],
  };
}

function guaranteeData(f: Facts, project: Project): GuaranteeData {
  return {
    heading: project.track === 'business' ? 'Our promise to you' : 'Try it risk-free for 30 days',
    body: project.track === 'business' ? f.business?.guarantee ?? 'If you’re not happy, we make it right.' : `Use ${f.productShort} for 30 days. If it doesn’t help you ${verbOutcome(f.outcomes[0])}, email us for a full refund.`,
    days: 30,
    finalHeading: `Ready to ${verbOutcome(f.outcomes[0])}?`,
    finalCta: project.track === 'business' ? 'Book now' : `Get ${f.productShort}`,
  };
}

export function generateSalesSection(project: Project, type: SalesSectionType, d: Directives = {}, variation = 0): SalesSection {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|sales|${type}|${variation}`));
  const primary = primaryKeywordFor(f);
  const id = uid('sec');
  switch (type) {
    case 'hero':
      return { id, type, visible: true, data: heroData(f, v, primary) };
    case 'problem':
      return { id, type, visible: true, data: problemData(f, v) };
    case 'solution':
      return { id, type, visible: true, data: solutionData(f, project) };
    case 'proof':
      return { id, type, visible: true, data: proofData(f, project) };
    case 'pricing':
      return { id, type, visible: true, data: pricingData(f, project) };
    case 'faq':
      return { id, type, visible: true, data: faqData(f, primary) };
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
};

export function generateSalesPage(project: Project, d: Directives = {}, variation = 0): SalesPage {
  return {
    sections: SECTION_ORDER.map((t) => generateSalesSection(project, t, d, variation)),
    theme: { font: project.brand.logo.font === 'serif' ? 'serif' : 'grotesk', mode: 'light', radius: 'soft' },
    updatedAt: Date.now(),
  };
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
      case 'proof':
        h2s.push(s.data.heading);
        parts.push(s.data.heading, ...s.data.stats.map((x) => `${x.value} ${x.label}`), ...s.data.testimonials.map((t) => t.quote));
        break;
      case 'pricing':
        h2s.push(s.data.heading);
        parts.push(s.data.heading, s.data.planName, ...s.data.includes);
        break;
      case 'faq':
        h2s.push(s.data.heading);
        parts.push(s.data.heading, ...s.data.items.flatMap((i) => [i.q, i.a]));
        break;
      case 'guarantee':
        h2s.push(s.data.heading);
        parts.push(s.data.heading, s.data.body, s.data.finalHeading);
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
  const url = ensureUrl(brand.websiteUrl || `https://${brand.slug || 'example'}.com`);
  const faq = page.sections.find((s) => s.type === 'faq');
  const pricing = page.sections.find((s) => s.type === 'pricing');
  const ld: Record<string, unknown>[] = [
    project.track === 'business'
      ? {
          '@context': 'https://schema.org',
          '@type': 'LocalBusiness',
          name: brand.name,
          description: meta.metaDescription,
          url,
          ...(project.location ? { address: { '@type': 'PostalAddress', addressLocality: project.location.city, addressRegion: project.location.region } } : {}),
        }
      : {
          '@context': 'https://schema.org',
          '@type': 'Product',
          name: pricing && pricing.type === 'pricing' ? pricing.data.planName : brand.name,
          description: meta.metaDescription,
          brand: { '@type': 'Brand', name: brand.name },
          offers: { '@type': 'Offer', priceCurrency: 'USD', price: pricing && pricing.type === 'pricing' ? pricing.data.price : project.studio.price, availability: 'https://schema.org/InStock', url: meta.canonical },
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
      <ul class="ticks">${s.data.bullets.map((b) => `<li>${e(b)}</li>`).join('')}</ul>
      <a class="btn" href="#pricing">${e(s.data.ctaLabel)}</a>
      <p class="fine">${e(s.data.ctaSubtext)}</p>
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
        case 'proof':
          return `  <section class="proof">
    <div class="wrap">
      <h2>${e(s.data.heading)}</h2>
      <div class="stats">${s.data.stats.map((x) => `<div><b>${e(x.value)}</b><span>${e(x.label)}</span></div>`).join('')}</div>
      <div class="grid">${s.data.testimonials.map((t) => `<figure class="card"><div class="stars" aria-label="${t.rating} out of 5 stars">${'★'.repeat(t.rating)}</div><blockquote>“${e(t.quote)}”</blockquote><figcaption><b>${e(t.name)}</b> · ${e(t.role)}</figcaption></figure>`).join('')}</div>
    </div>
  </section>`;
        case 'pricing':
          return `  <section class="pricing" id="pricing">
    <div class="wrap narrow">
      <h2>${e(s.data.heading)}</h2>
      <div class="price-card">
        ${s.data.badge ? `<span class="badge">${e(s.data.badge)}</span>` : ''}
        <h3>${e(s.data.planName)}</h3>
        <p class="price">${s.data.compareAt > s.data.price ? `<s>$${s.data.compareAt}</s> ` : ''}<b>$${s.data.price}</b> <span>${e(s.data.priceNote)}</span></p>
        <ul class="ticks">${s.data.includes.map((i) => `<li>${e(i)}</li>`).join('')}</ul>
        <a class="btn block" href="${e(url)}">${e(s.data.ctaLabel)}</a>
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
        case 'guarantee':
          return `  <section class="guarantee">
    <div class="wrap narrow">
      <div class="seal" aria-hidden="true">${s.data.days}<small>DAY</small></div>
      <h2>${e(s.data.heading)}</h2>
      <p>${e(s.data.body)}</p>
      <h3>${e(s.data.finalHeading)}</h3>
      <a class="btn" href="${e(url)}">${e(s.data.finalCta)}</a>
    </div>
  </section>`;
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
<link rel="canonical" href="${e(meta.canonical)}" />
<meta property="og:type" content="${project.track === 'business' ? 'business.business' : 'product'}" />
<meta property="og:title" content="${e(meta.ogTitle)}" />
<meta property="og:description" content="${e(meta.ogDescription)}" />
<meta property="og:url" content="${e(meta.canonical)}" />
<meta property="og:image:alt" content="${e(meta.ogImageAlt)}" />
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
  <footer><div class="wrap">© ${new Date().getFullYear()} ${e(brand.name)} · <a href="${e(url)}">${e(url.replace(/^https?:\/\//, ''))}</a></div></footer>
</body>
</html>`;
}

export function placeholderTestimonials(page: SalesPage | null): boolean {
  return !!page?.sections.some((s) => s.type === 'proof' && s.visible && s.data.testimonials.some((t) => ['Jordan M.', 'Priya S.', 'Marcus L.'].includes(t.name)));
}
