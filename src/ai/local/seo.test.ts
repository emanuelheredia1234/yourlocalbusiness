import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import { escapeHtml } from '@/lib/utils';
import type { GuaranteeData, PricingData, ProofData, Project, SalesPage, SalesSection } from '@/lib/types';
import { generateBrandKit } from './brand';
import { generateBusinessModel, generateOutline } from './studio';
import { aiWritableData, canonicalForSlugChange, claimsToReview, exportSalesHtml, generateSalesPage, generateSalesSection, generateSeoMeta, keepFacts, scoreSeo } from './seo';
import { salesPageTask, salesSectionTask, seoMetaTask } from '../tasks';

function productProject(): Project {
  const p = newProject('product', 'new');
  p.niche = 'Personal Finance';
  p.category = 'Freelancer Tax Tracking';
  p.format = 'spreadsheet';
  p.studio.price = 29;
  const kit = generateBrandKit(p);
  p.brand = { ...p.brand, name: kit.nameOptions[0].name, slug: kit.slug, websiteUrl: '', colors: kit.colors };
  return p;
}

function businessProject(): Project {
  const p = newProject('business', 'new');
  p.niche = 'Home Cleaning';
  p.category = 'Eco-friendly house cleaning';
  p.businessType = 'Home Cleaning';
  p.location = { city: 'Austin', region: 'TX' };
  const kit = generateBrandKit(p);
  p.brand = { ...p.brand, name: kit.nameOptions[0].name, slug: kit.slug, websiteUrl: '', colors: kit.colors };
  const bm = generateBusinessModel(p);
  p.studio.packages = bm.packages;
  p.studio.price = bm.price;
  return p;
}

const section = <T extends SalesSection['type']>(page: SalesPage, type: T) => page.sections.find((s) => s.type === type)!.data as Extract<SalesSection, { type: T }>['data'];

/** Claims the old template made up for every business. */
const INVENTED = /Jordan M\.|Priya S\.|Marcus L\.|Licensed|insured|money-back|Lifetime updates|Launch price|Most popular|Satisfaction promise|Quote turnaround|risk-free|refund|cancel anytime|Neighbors Recommend|work we guarantee|Free estimates/i;

describe('sales page: no invented proof, prices or guarantees', () => {
  it('starts with empty proof, no "was" price and no guarantee (product)', () => {
    const p = productProject();
    const page = generateSalesPage(p);
    expect(page.claimsChecked).toBe(true);
    const proof = section(page, 'proof');
    expect(proof.testimonials).toEqual([]);
    expect(proof.stats).toEqual([]); // no outline yet: no fallback 6 sections / 24 lessons
    expect(section(page, 'pricing').compareAt).toBe(0);
    expect(section(page, 'pricing').badge).toBe('');
    const g = section(page, 'guarantee');
    expect(g.offered).toBe(false);
    expect(g.body).toBe('');
    expect(g.days).toBe(0);
    expect(JSON.stringify(page)).not.toMatch(INVENTED);
  });

  it('starts with empty proof and no credentials or promises (business)', () => {
    const p = businessProject();
    const page = generateSalesPage(p);
    expect(section(page, 'proof').testimonials).toEqual([]);
    expect(section(page, 'proof').stats).toEqual([]);
    expect(section(page, 'solution').features.map((f) => f.title)).not.toContain('Upfront pricing');
    expect(JSON.stringify(page)).not.toMatch(INVENTED);
    const meta = generateSeoMeta(p);
    expect(meta.metaDescription).not.toMatch(/trusted|upfront pricing/i);
  });

  it('writes no invented descriptions, features or reassurances', () => {
    const MADE_UP = /practical and specific|same day|busy schedule|Count On|friendly local service|in minutes|at your own pace|Friendly, reliable|Built-in|instant access|Simple, upfront pricing/i;
    for (const p of [productProject(), businessProject()]) {
      for (let v = 0; v < 4; v++) {
        const page = generateSalesPage(p, {}, v);
        expect(JSON.stringify(page)).not.toMatch(MADE_UP);
        expect(generateSeoMeta(p, {}, v).metaDescription).not.toMatch(MADE_UP);
        expect(section(page, 'faq').items.some((x) => x.a.startsWith('Yes.'))).toBe(false);
      }
    }
    // Without an outline the "different" answer is a placeholder; with one it lists the real sections.
    const p = productProject();
    expect(section(generateSalesPage(p), 'faq').items[1].a).toMatch(/^\[What makes .+ different\]$/);
    expect(section(generateSalesPage(p), 'solution').features.every((x) => x.title.startsWith('['))).toBe(true);
    p.studio.outline = generateOutline(p).sections;
    const a = section(generateSalesPage(p), 'faq').items[1].a;
    expect(a.startsWith('It covers ')).toBe(true);
    expect(a).toContain(p.studio.outline[0].title.replace(/^(Module|Chapter|Section) \d+:\s*/i, '').trim());
    // A business with packages names them.
    const b = businessProject();
    expect(section(generateSalesPage(b), 'faq').items[1].a).toContain(b.studio.packages[0].name);
  });

  it('brand kit pitch and value proposition make no service promises', () => {
    const PROMISE = /on time|quote upfront|upfront pricing|like a neighbor|Clear pricing|friendly people|stand behind|satisfaction|most dependable|done right|count on|happy customer|The only|built for real life/i;
    for (const p of [productProject(), businessProject()]) {
      for (let v = 0; v < 8; v++) {
        const kit = generateBrandKit(p, {}, v);
        expect(kit.pitch).not.toMatch(PROMISE);
        expect(kit.valueProp).not.toMatch(PROMISE);
        expect(kit.tagline).not.toMatch(PROMISE);
      }
    }
  });

  it('counts stats from the real outline only', () => {
    const p = productProject();
    p.studio.outline = generateOutline(p).sections;
    const items = p.studio.outline.reduce((s, x) => s + x.items.length, 0);
    const stats = section(generateSalesPage(p), 'proof').stats;
    expect(stats).toEqual([
      { value: String(p.studio.outline.length), label: 'Tabs' },
      { value: String(items), label: 'Lessons, tools & steps' },
    ]);
  });

  it('shows a "was" price only when the owner set one', () => {
    const p = productProject();
    p.studio.compareAt = 49;
    expect(section(generateSalesPage(p), 'pricing').compareAt).toBe(49);
    p.studio.compareAt = 10; // not above the price: not a discount
    expect(section(generateSalesPage(p), 'pricing').compareAt).toBe(0);
  });

  it('keeps what the owner entered when the page is rewritten', () => {
    const p = productProject();
    const page = generateSalesPage(p);
    const quote = { quote: 'It finally made my taxes make sense.', name: 'Dana R.', role: 'Designer', rating: 5 };
    page.sections = page.sections.map((s) => {
      if (s.type === 'proof') return { ...s, data: { ...s.data, testimonials: [quote], stats: [{ value: '12', label: 'Years freelancing' }] } };
      if (s.type === 'guarantee') return { ...s, data: { ...s.data, offered: true, heading: '14-day refund', body: 'Email me within 14 days for a full refund.', days: 14 } };
      if (s.type === 'pricing') return { ...s, data: { ...s.data, compareAt: 39, badge: 'Early bird' } };
      return s;
    });
    p.marketing.salesPage = page;
    const next = generateSalesPage(p, {}, 1);
    expect(section(next, 'proof').testimonials).toEqual([quote]);
    expect(section(next, 'proof').stats).toEqual([{ value: '12', label: 'Years freelancing' }]);
    expect(section(next, 'guarantee')).toMatchObject({ offered: true, heading: '14-day refund', days: 14 });
    expect(section(next, 'pricing')).toMatchObject({ compareAt: 39, badge: 'Early bird' });
    // the FAQ answers "what if it's not right for me" only with the owner's own guarantee
    expect(section(next, 'faq').items.at(-1)).toEqual({ q: 'What if it’s not right for me?', a: 'Email me within 14 days for a full refund.' });
  });
});

describe('sales page HTML export', () => {
  it('leaves out empty proof, the guarantee, stars, "was" price and any guessed domain', () => {
    const p = productProject();
    const meta = generateSeoMeta(p);
    expect(meta.canonical).toBe('');
    const page = generateSalesPage(p);
    const html = exportSalesHtml(page, meta, p.brand, p);
    expect(html).toContain('application/ld+json');
    expect(html).not.toContain('class="proof"');
    expect(html).not.toContain('class="seal"');
    expect(html).not.toContain('★');
    expect(html).not.toContain('<s>$');
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('og:url');
    expect(html).not.toContain(`${p.brand.slug}.com`);
    expect(html).not.toContain('example.com');
    expect(html).not.toMatch(INVENTED);
    expect(html).not.toMatch(/"(review|aggregateRating)"/);
    // still a complete page: the closing heading and button stay
    expect(html).toContain(`<h2>${escapeHtml(section(page, 'guarantee').finalHeading)}</h2>`);
    expect(html).toContain(`>${escapeHtml(section(page, 'guarantee').finalCta)}</a>`);
    expect(scoreSeo(meta, page).score).toBeGreaterThan(50);
  });

  it('publishes confirmed quotes and facts only, with stars only when given', () => {
    const p = businessProject();
    p.brand.websiteUrl = 'https://sparkle.example.org';
    const meta = generateSeoMeta(p);
    expect(meta.canonical).toBe(`https://sparkle.example.org/${meta.slug}`);
    const page = generateSalesPage(p);
    const proof: ProofData = {
      heading: 'What customers say',
      stats: [
        { value: '9', label: 'Years in business' },
        { value: '5,000+', label: 'Homes cleaned', needsReview: true },
      ],
      testimonials: [
        { quote: 'Spotless every time.', name: 'Lee K.', role: 'Homeowner', rating: 0 },
        { quote: 'Best in town!', name: 'Sam P.', role: 'Renter', rating: 5, needsReview: true },
        { quote: '', name: '', role: '', rating: 0 },
      ],
    };
    page.sections = page.sections.map((s) => (s.type === 'proof' ? { ...s, data: proof } : s));
    const html = exportSalesHtml(page, meta, p.brand, p);
    expect(html).toContain('Spotless every time.');
    expect(html).toContain('Years in business');
    expect(html).not.toContain('Best in town');
    expect(html).not.toContain('Homes cleaned');
    expect(html).not.toContain('★');
    expect(html).toContain(`rel="canonical" href="https://sparkle.example.org/${meta.slug}"`);
    expect(html).toContain('"url": "https://sparkle.example.org"');
    expect(claimsToReview(page)).toBe(2);
  });

  it('shows the owner’s guarantee and "was" price once they set them', () => {
    const p = productProject();
    p.studio.compareAt = 49;
    const page = generateSalesPage(p);
    const g: GuaranteeData = { ...section(page, 'guarantee'), offered: true, heading: '14-day refund', body: 'Email me within 14 days.', days: 14 };
    page.sections = page.sections.map((s) => (s.type === 'guarantee' ? { ...s, data: g } : s));
    let html = exportSalesHtml(page, generateSeoMeta(p), p.brand, p);
    expect(html).toContain('14-day refund');
    expect(html).toContain('<div class="seal" aria-hidden="true">14<small>DAY</small></div>');
    expect(html).toContain('<s>$49</s>');
    // an unconfirmed "was" price stays off
    const pr: PricingData = { ...section(page, 'pricing'), compareAtNeedsReview: true };
    page.sections = page.sections.map((s) => (s.type === 'pricing' ? { ...s, data: pr } : s));
    html = exportSalesHtml(page, generateSeoMeta(p), p.brand, p);
    expect(html).not.toContain('<s>$');
  });

  it('points the buttons at the owner’s own buy link', () => {
    const p = productProject();
    p.studio.listing.buyUrl = 'https://buy.stripe.com/test_123';
    const html = exportSalesHtml(generateSalesPage(p), generateSeoMeta(p), p.brand, p);
    expect(html).toContain('href="https://buy.stripe.com/test_123"');
  });
});

describe('AI sales copy keeps the facts', () => {
  it('tells the AI never to invent proof, credentials or guarantees', () => {
    const p = productProject();
    const env = { project: p, directives: {}, brainPrompt: '', variation: 0 };
    const prompt = salesPageTask.claude!.prompt({}, env, salesPageTask.local({}, env));
    expect(prompt).toMatch(/Never invent testimonials, reviews, ratings, statistics/);
    expect(prompt).toMatch(/credentials/);
    expect(prompt).toMatch(/guarantees/);
    expect(prompt).not.toMatch(/"testimonials"|"stats"|"compareAt"|"days"/);
    const base = salesSectionTask.local({ type: 'proof' }, env);
    expect(salesSectionTask.claude!.prompt({ type: 'proof' }, env, base)).toMatch(/Never invent testimonials/);
    expect(seoMetaTask.claude!.prompt({}, env, seoMetaTask.local({}, env))).toMatch(/Never invent testimonials/);
  });

  it('drops testimonials, stats, prices and guarantees the AI returns anyway', () => {
    const p = productProject();
    const env = { project: p, directives: {}, brainPrompt: '', variation: 0 };
    const base = salesPageTask.local({}, env);
    const merged = salesPageTask.claude!.merge(
      {
        hero: { headline: 'New headline', ctaSubtext: '30-day money-back guarantee' },
        proof: { heading: 'Loved by freelancers', stats: [{ value: '10,000+', label: 'Happy users' }], testimonials: [{ quote: 'Amazing', name: 'Alex B.', role: 'User', rating: 5 }] },
        pricing: { heading: 'Pricing', price: 9, compareAt: 99, badge: 'Launch price' },
        guarantee: { heading: 'Risk-free', body: 'Full refund', days: 60, finalHeading: 'Ready?' },
      },
      base,
      {},
      env,
    );
    expect(section(merged, 'hero').headline).toBe('New headline');
    expect(section(merged, 'hero').ctaSubtext).toBe('One-time payment');
    expect(section(merged, 'proof')).toEqual({ heading: 'Loved by freelancers', stats: [], testimonials: [] });
    expect(section(merged, 'pricing')).toMatchObject({ heading: 'Pricing', price: 29, compareAt: 0, badge: '' });
    expect(section(merged, 'guarantee')).toMatchObject({ heading: '', body: '', days: 0, offered: false, finalHeading: 'Ready?' });
  });

  it('sends the AI only the copy fields of a section', () => {
    const p = productProject();
    const s = generateSalesSection(p, 'pricing');
    expect(Object.keys(aiWritableData(s)).sort()).toEqual(['ctaLabel', 'heading', 'includes', 'planName']);
    const g = generateSalesSection(p, 'guarantee');
    expect(Object.keys(aiWritableData(g)).sort()).toEqual(['finalCta', 'finalHeading']);
    const forged = { ...g, data: { ...g.data, offered: true, body: 'Lifetime guarantee' } } as SalesSection;
    expect(keepFacts(forged, g).data).toEqual(g.data);
  });
});

describe('canonical URL follows the slug, never a stale or guessed address', () => {
  it('moves an app-made canonical to the new slug and keeps an address the owner pasted', () => {
    const p = productProject();
    // No website: nothing to make up, and no stale address left behind.
    expect(canonicalForSlugChange(p, '', 'old', 'new')).toBe('');
    expect(canonicalForSlugChange(p, 'https://mine.com/shop/old', 'old', 'new')).toBe('https://mine.com/shop/new');
    expect(canonicalForSlugChange(p, 'https://mine.com/old/', 'old', 'new')).toBe('https://mine.com/new');
    // Clearing the slug while typing, then typing a new one, keeps following it.
    expect(canonicalForSlugChange(p, canonicalForSlugChange(p, 'https://mine.com/old', 'old', ''), '', 'n')).toBe('https://mine.com/n');
    // A hand-pasted address that doesn't follow the slug is the owner's: kept.
    expect(canonicalForSlugChange(p, 'https://mine.com/landing', 'old', 'new')).toBe('https://mine.com/landing');
    // With a website, an empty or generated canonical follows the slug.
    p.brand.websiteUrl = 'https://site.com';
    expect(canonicalForSlugChange(p, '', 'old', 'new')).toBe('https://site.com/new');
    expect(canonicalForSlugChange(p, 'https://site.com/old', 'old', 'new')).toBe('https://site.com/new');
    expect(canonicalForSlugChange(p, 'https://other.com/page', 'old', 'new')).toBe('https://other.com/page');
  });
});
