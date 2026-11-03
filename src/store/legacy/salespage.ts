// Sales pages saved before the app stopped inventing proof. Older versions filled the page with three
// made-up 5-star customers, stats and guarantees nobody offered ("24h quote turnaround", "30-day
// money-back guarantee", "Licensed & insured"), a "was" price of 1.6× the real one, and a canonical
// URL on a guessed {slug}.com domain. This removes the built-in ones, refreshes counts from the real
// outline, and flags what can't be told apart from the owner's own words (AI-written quotes, stats and
// "was" prices) so it stays off the exported page until the owner confirms it. Pure and idempotent.

import type { FaqData, GuaranteeData, HeroData, PricingData, ProofData, Project, SalesPage, SalesSection, SeoMeta, SolutionData } from '@/lib/types';
import { BUSINESS_TYPES, GENERIC_BUSINESS } from '@/ai/knowledge';
import { canonicalFor, outlineStatLabels, outlineStats } from '@/ai/local/seo';

/** The three customers the old template made up. */
export const BUILT_IN_TESTIMONIAL_NAMES = ['Jordan M.', 'Priya S.', 'Marcus L.'];

/** The old "Add testimonial" button's stand-in text. */
const OLD_PLACEHOLDER_QUOTE = 'Paste a real customer quote here.';

/** Built-in stats that were never facts about anyone's business. */
const BUILT_IN_STATS: { value?: string; label: string }[] = [
  { value: '24h', label: 'Quote turnaround' },
  { value: '100%', label: 'Satisfaction promise' },
  { label: 'Owned & operated' },
  { value: '30-day', label: 'Money-back guarantee' },
];

const BUILT_IN_FINE_PRINT = ['Free estimates · Licensed & insured · Satisfaction promise', 'Instant access · 30-day money-back guarantee'];
const BUILT_IN_INCLUDES = ['Lifetime updates', '30-day money-back guarantee'];
const BUILT_IN_BADGES = ['Launch price', 'Most popular'];
const BUILT_IN_FAQ_ANSWERS = [
  'You’re covered by our 30-day money-back guarantee. Email us and we’ll refund you, no hard feelings.',
  'Book online in under a minute. You’ll get a confirmation right away, and you only pay once the job is done right.',
];
const BUILT_IN_HERO_PROMISE = /, with upfront pricing, on-time pros and work we guarantee\.$/;
const BUILT_IN_NEIGHBORS = /^The (.+) Neighbors Recommend$/;
const BUILT_IN_PRODUCT_GUARANTEE = /^Use .+ for 30 days\. If it doesn’t help you .+, email us for a full refund\.$/;

/** The old "was" price: 1.6× the price, rounded to a charm price (a frozen copy of what older versions did). */
function oldCompareAt(price: number): number {
  const n = price * 1.6;
  if (n <= 10) return Math.max(5, Math.round(n));
  const step = n < 100 ? 10 : 100;
  const base = Math.floor(n / step) * step;
  const candidates = step === 10 ? [base + 7, base + 9, base - 3] : [base + 47, base + 97, base - 3];
  return candidates.reduce((best, c) => (Math.abs(c - n) < Math.abs(best - n) ? c : best), candidates[0]);
}

/** The template guarantees, read loosely so a template change can't break the cleanup. */
function templateGuarantees(): Set<string> {
  const all = [...BUSINESS_TYPES, GENERIC_BUSINESS].map((b) => (b as { guarantee?: unknown }).guarantee);
  return new Set([...all.filter((g): g is string => typeof g === 'string'), 'If you’re not happy, we make it right.']);
}

const isBuiltInStat = (x: { value: string; label: string }) => BUILT_IN_STATS.some((b) => b.label === x.label && (b.value === undefined || b.value === x.value));
const isBuiltInTestimonial = (t: { quote: string; name: string }) => BUILT_IN_TESTIMONIAL_NAMES.includes(t.name.trim()) || t.quote.trim() === OLD_PLACEHOLDER_QUOTE;

const isItemCount = (label: string) => label.startsWith('Lesson');

function cleanProof(d: ProofData, p: Project): ProofData {
  const counted = new Set(outlineStatLabels(p));
  const real = outlineStats(p);
  const stats: ProofData['stats'] = [];
  for (const x of d.stats) {
    if (isBuiltInStat(x)) continue;
    if (counted.has(x.label)) {
      // A count from the outline (or the old fallback 6 and 24): keep it only as the real, current number.
      const fresh = real.find((r) => isItemCount(r.label) === isItemCount(x.label));
      if (fresh && !stats.some((s) => s.label === fresh.label)) stats.push(fresh);
      continue;
    }
    stats.push({ ...x, needsReview: true });
  }
  const testimonials = d.testimonials.filter((t) => !isBuiltInTestimonial(t)).map((t) => ({ ...t, needsReview: true }));
  return { ...d, stats, testimonials };
}

function cleanHero(d: HeroData, p: Project): HeroData {
  const m = d.headline.match(BUILT_IN_NEIGHBORS);
  return {
    ...d,
    headline: m ? `${m[1]}${p.brand.name ? ` by ${p.brand.name}` : ''}` : d.headline,
    subheadline: d.subheadline.replace(BUILT_IN_HERO_PROMISE, '.'),
    ctaSubtext: BUILT_IN_FINE_PRINT.includes(d.ctaSubtext) ? '' : d.ctaSubtext,
  };
}

function cleanSolution(d: SolutionData): SolutionData {
  return { ...d, features: d.features.filter((f) => !(f.title === 'Upfront pricing' && f.body === 'Know the price before we start. No surprise charges.')) };
}

function cleanPricing(d: PricingData, p: Project): PricingData {
  const out: PricingData = {
    ...d,
    includes: d.includes.filter((i) => !BUILT_IN_INCLUDES.includes(i)),
    badge: BUILT_IN_BADGES.includes(d.badge) ? '' : d.badge,
    priceNote: d.priceNote === 'per month · cancel anytime' ? 'per month' : d.priceNote,
  };
  // A "was" price is kept only when it's the one the owner set in the Studio. The old 1.6× formula goes;
  // any other (AI-written or typed here) waits for the owner to confirm it.
  if (d.compareAt > d.price && d.compareAt !== p.studio.compareAt) {
    const prices = [d.price, p.studio.price, p.idea?.price ?? 0].filter((x) => x > 0);
    if (prices.some((x) => oldCompareAt(x) === d.compareAt)) out.compareAt = 0;
    else out.compareAtNeedsReview = true;
  }
  return out;
}

function cleanFaq(d: FaqData): FaqData {
  return { ...d, items: d.items.filter((i) => !BUILT_IN_FAQ_ANSWERS.includes(i.a)) };
}

function cleanGuarantee(d: GuaranteeData): GuaranteeData {
  // Never shown again unless the owner turns it on (offered). The template's own promises are cleared.
  const builtIn = (d.heading === 'Try it risk-free for 30 days' && BUILT_IN_PRODUCT_GUARANTEE.test(d.body)) || (d.heading === 'Our promise to you' && templateGuarantees().has(d.body));
  return builtIn ? { ...d, heading: '', body: '', days: 0, offered: false } : { ...d, offered: d.offered ?? false };
}

function cleanSection(s: SalesSection, p: Project): SalesSection {
  switch (s.type) {
    case 'hero':
      return { ...s, data: cleanHero(s.data, p) };
    case 'solution':
      return { ...s, data: cleanSolution(s.data) };
    case 'proof':
      return { ...s, data: cleanProof(s.data, p) };
    case 'pricing':
      return { ...s, data: cleanPricing(s.data, p) };
    case 'faq':
      return { ...s, data: cleanFaq(s.data) };
    case 'guarantee':
      return { ...s, data: cleanGuarantee(s.data) };
    default:
      return s;
  }
}

/** The saved sales page with invented proof removed or flagged, or null when it's already clean. */
export function purgeSalesPageData(page: SalesPage | null, p: Project): SalesPage | null {
  if (!page || page.claimsChecked) return null;
  return { ...page, sections: page.sections.map((s) => cleanSection(s, p)), claimsChecked: true };
}

function hostOf(url: string): string {
  const u = url.trim();
  if (!u) return '';
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** A domain the app made up from the brand name (or a placeholder), unless an existing business gave it to us as theirs. */
function isGuessedHost(host: string, p: Project): boolean {
  const slug = (p.brand.slug || '').toLowerCase();
  const guessed = new Set(['yourbrand.com', 'example.com', ...(slug ? [`${slug}.com`, `${slug.replace(/-/g, '')}.com`] : [])]);
  if (!guessed.has(host)) return false;
  return !(p.origin === 'existing' && hostOf(p.brand.websiteUrl) === host);
}

/** A canonical URL built on a guessed {slug}.com (or placeholder) domain, rather than the owner's own site. */
export function isGuessedCanonical(meta: SeoMeta, p: Project): boolean {
  const host = hostOf(meta.canonical);
  return !!host && isGuessedHost(host, p);
}

/** One project's sales page and SEO metadata cleaned, or null when nothing changes. Safe to run again. */
export function purgeSalesPage(p: Project): Project | null {
  const page = purgeSalesPageData(p.marketing.salesPage, p);
  const seo = p.marketing.seo;
  const fixCanonical = !!seo && !!seo.canonical && isGuessedCanonical(seo, p);
  if (!page && !fixCanonical) return null;
  // On the owner's real website when there is one; otherwise empty, and the editor asks for it.
  const site = hostOf(p.brand.websiteUrl) && !isGuessedHost(hostOf(p.brand.websiteUrl), p) ? canonicalFor(p, seo?.slug ?? '') : '';
  return {
    ...p,
    marketing: {
      ...p.marketing,
      ...(page ? { salesPage: page } : {}),
      ...(fixCanonical && seo ? { seo: { ...seo, canonical: site } } : {}),
    },
  };
}
