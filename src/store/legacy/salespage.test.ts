import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { Project, SalesPage, SalesSection } from '@/lib/types';
import { BUSINESS_TYPES } from '@/ai/knowledge';
import { claimsToReview, exportSalesHtml, generateSalesPage, generateSeoMeta } from '@/ai/local/seo';
import { generateOutline } from '@/ai/local/studio';
import { purgeSalesPage } from './salespage';

const sec = (id: string, s: Omit<SalesSection, 'id' | 'visible'>) => ({ id, visible: true, ...s }) as SalesSection;
const data = <T extends SalesSection['type']>(page: SalesPage | null, type: T) => page!.sections.find((s) => s.type === type)!.data as Extract<SalesSection, { type: T }>['data'];

/** A product sales page as older versions saved it: made-up customers, stats, a 1.6× "was" price and a refund promise. */
function oldProductProject(): Project {
  const p = newProject('product', 'new');
  p.niche = 'Personal Finance';
  p.category = 'Freelancer Tax Tracking';
  p.format = 'spreadsheet';
  p.studio.price = 29;
  p.brand = { ...p.brand, name: 'Tax Tidy', slug: 'tax-tidy', websiteUrl: 'https://taxtidy.io' };
  p.marketing.seo = { ...generateSeoMeta(p), slug: 'freelancer-tax-tracker', canonical: 'https://taxtidy.io/freelancer-tax-tracker' };
  p.marketing.salesPage = {
    theme: { font: 'grotesk', mode: 'light', radius: 'soft' },
    updatedAt: 1,
    sections: [
      sec('h', { type: 'hero', data: { eyebrow: 'For freelancers', headline: 'Track taxes', subheadline: 'Tax Tidy helps.', ctaLabel: 'Get Tax Tidy · $29', ctaSubtext: 'Instant access · 30-day money-back guarantee', bullets: ['Save time'] } }),
      sec('p', {
        type: 'proof',
        data: {
          heading: 'What people are saying',
          stats: [
            { value: '6', label: 'Tabs' },
            { value: '24', label: 'Lessons, tools & steps' },
            { value: '30-day', label: 'Money-back guarantee' },
            { value: '3', label: 'Bonus templates' },
          ],
          testimonials: [
            { quote: 'I stopped guessing in the first week.', name: 'Jordan M.', role: 'Freelancer', rating: 5 },
            { quote: 'Clear, practical and easy to follow.', name: 'Priya S.', role: 'Freelancer', rating: 5 },
            { quote: 'Taxes used to ruin my month.', name: 'Marcus L.', role: 'Freelancer', rating: 5 },
            { quote: 'Paste a real customer quote here.', name: 'Customer name', role: 'Customer', rating: 5 },
            { quote: 'Saved my April.', name: 'Sam P.', role: 'Designer', rating: 5 },
          ],
        },
      }),
      sec('$', { type: 'pricing', data: { heading: 'Get started today', planName: 'Tax Tidy', price: 29, compareAt: 47, priceNote: 'one-time payment', includes: ['Tax Tidy', 'Quarterly planner', 'Lifetime updates', '30-day money-back guarantee'], ctaLabel: 'Get instant access', badge: 'Launch price' } }),
      sec('f', {
        type: 'faq',
        data: {
          heading: 'FAQ',
          items: [
            { q: 'Who is it for?', a: 'Freelancers.' },
            { q: 'What if it’s not right for me?', a: 'You’re covered by our 30-day money-back guarantee. Email us and we’ll refund you, no hard feelings.' },
          ],
        },
      }),
      sec('g', { type: 'guarantee', data: { heading: 'Try it risk-free for 30 days', body: 'Use Tax Tidy for 30 days. If it doesn’t help you track every deduction, email us for a full refund.', days: 30, finalHeading: 'Ready?', finalCta: 'Get Tax Tidy' } }),
    ],
  };
  return p;
}

function oldBusinessProject(): Project {
  const p = newProject('business', 'new');
  p.businessType = 'Home Cleaning';
  p.location = { city: 'Austin', region: 'TX' };
  p.studio.price = 150;
  p.brand = { ...p.brand, name: 'Sparkle Co', slug: 'sparkle-co', websiteUrl: '' };
  p.marketing.seo = { ...generateSeoMeta(p), slug: 'home-cleaning-in-austin', canonical: 'https://sparkleco.com/home-cleaning-in-austin' };
  p.marketing.salesPage = {
    theme: { font: 'grotesk', mode: 'light', radius: 'soft' },
    updatedAt: 1,
    sections: [
      sec('h', {
        type: 'hero',
        data: { eyebrow: 'Serving Austin, TX', headline: 'The Austin Home Cleaning Neighbors Recommend', subheadline: 'Sparkle Co provides home cleaning in austin that takes clutter off your plate, with upfront pricing, on-time pros and work we guarantee.', ctaLabel: 'Book now', ctaSubtext: 'Free estimates · Licensed & insured · Satisfaction promise', bullets: [] },
      }),
      sec('s', { type: 'solution', data: { heading: 'How it works', intro: '', features: [{ title: 'Deep Clean', body: 'Top to bottom.', icon: 'zap' }, { title: 'Upfront pricing', body: 'Know the price before we start. No surprise charges.', icon: 'shield-check' }] } }),
      sec('p', {
        type: 'proof',
        data: {
          heading: 'What people are saying',
          stats: [
            { value: '24h', label: 'Quote turnaround' },
            { value: '100%', label: 'Satisfaction promise' },
            { value: 'Austin', label: 'Owned & operated' },
          ],
          testimonials: [{ quote: 'Clear, practical and easy to follow.', name: 'Priya S.', role: 'Homeowner', rating: 5 }],
        },
      }),
      sec('$', { type: 'pricing', data: { heading: 'Simple, upfront pricing', planName: 'Deep Refresh', price: 150, compareAt: 199, priceNote: 'starting price', includes: ['Kitchen', 'Baths'], ctaLabel: 'Book your appointment', badge: 'Most popular' } }),
      sec('f', { type: 'faq', data: { heading: 'FAQ', items: [{ q: 'How do I book and pay?', a: 'Book online in under a minute. You’ll get a confirmation right away, and you only pay once the job is done right.' }] } }),
      sec('g', { type: 'guarantee', data: { heading: 'Our promise to you', body: BUSINESS_TYPES.find((b) => b.id === 'cleaning')!.guarantee, days: 30, finalHeading: 'Ready for a clean home?', finalCta: 'Book now' } }),
    ],
  };
  return p;
}

describe('purgeSalesPage', () => {
  it('removes the built-in customers, stats, promises and "was" price, and flags AI proof for review (product)', () => {
    const p = oldProductProject();
    const out = purgeSalesPage(p)!;
    expect(out).not.toBeNull();
    const page = out.marketing.salesPage!;
    expect(page.claimsChecked).toBe(true);

    const proof = data(page, 'proof');
    expect(proof.testimonials).toEqual([{ quote: 'Saved my April.', name: 'Sam P.', role: 'Designer', rating: 5, needsReview: true }]);
    // no outline: the fallback 6 and 24 go; the guarantee "stat" goes; the AI's own stat waits for review
    expect(proof.stats).toEqual([{ value: '3', label: 'Bonus templates', needsReview: true }]);

    expect(data(page, 'hero').ctaSubtext).toBe('');
    const pricing = data(page, 'pricing');
    expect(pricing.compareAt).toBe(0);
    expect(pricing.badge).toBe('');
    expect(pricing.includes).toEqual(['Tax Tidy', 'Quarterly planner']);
    expect(data(page, 'faq').items).toEqual([{ q: 'Who is it for?', a: 'Freelancers.' }]);
    expect(data(page, 'guarantee')).toMatchObject({ heading: '', body: '', days: 0, offered: false, finalHeading: 'Ready?' });

    // the owner's real website: canonical untouched
    expect(out.marketing.seo!.canonical).toBe('https://taxtidy.io/freelancer-tax-tracker');

    // the export carries none of it
    const html = exportSalesHtml(page, out.marketing.seo!, out.brand, out);
    expect(html).not.toMatch(/Jordan M\.|Priya S\.|Marcus L\.|Sam P\.|Bonus templates|money-back|Lifetime updates|Launch price|<s>\$|★|refund/);
    expect(claimsToReview(page)).toBe(2);
  });

  it('keeps outline counts only as the real numbers', () => {
    const p = oldProductProject();
    p.studio.outline = generateOutline(p).sections;
    const items = p.studio.outline.reduce((s, x) => s + x.items.length, 0);
    const proof = data(purgeSalesPage(p)!.marketing.salesPage, 'proof');
    expect(proof.stats.slice(0, 2)).toEqual([
      { value: String(p.studio.outline.length), label: 'Tabs' },
      { value: String(items), label: 'Lessons, tools & steps' },
    ]);
  });

  it('cleans a business page and the canonical URL on a guessed domain', () => {
    const p = oldBusinessProject();
    const out = purgeSalesPage(p)!;
    const page = out.marketing.salesPage!;
    const hero = data(page, 'hero');
    expect(hero.headline).toBe('Austin Home Cleaning by Sparkle Co');
    expect(hero.subheadline).toBe('Sparkle Co provides home cleaning in austin that takes clutter off your plate.');
    expect(hero.ctaSubtext).toBe('');
    expect(data(page, 'solution').features.map((f) => f.title)).toEqual(['Deep Clean']);
    expect(data(page, 'proof')).toMatchObject({ stats: [], testimonials: [] });
    // a "was" price that isn't the old formula and isn't the Studio's: hidden until the owner confirms it
    expect(data(page, 'pricing')).toMatchObject({ compareAt: 199, compareAtNeedsReview: true, badge: '' });
    expect(data(page, 'faq').items).toEqual([]);
    expect(data(page, 'guarantee')).toMatchObject({ heading: '', body: '', days: 0, offered: false });
    expect(out.marketing.seo!.canonical).toBe('');
    expect(JSON.stringify(page)).not.toMatch(/Licensed|insured|Neighbors Recommend|Satisfaction promise|Quote turnaround|Owned & operated|Most popular|work we guarantee/);
  });

  it('moves a guessed canonical onto the owner’s real website when they have one', () => {
    const p = oldBusinessProject();
    p.brand.websiteUrl = 'https://sparkle-cleaning.net';
    expect(purgeSalesPage(p)!.marketing.seo!.canonical).toBe('https://sparkle-cleaning.net/home-cleaning-in-austin');
  });

  it('keeps the domain an existing business gave as its own', () => {
    const p = oldBusinessProject();
    p.origin = 'existing';
    p.brand.websiteUrl = 'https://sparkleco.com';
    expect(purgeSalesPage(p)!.marketing.seo!.canonical).toBe('https://sparkleco.com/home-cleaning-in-austin');
  });

  it('changes nothing the second time, or after the owner confirms an item', () => {
    for (const make of [oldProductProject, oldBusinessProject]) {
      const once = purgeSalesPage(make())!;
      expect(purgeSalesPage(once)).toBeNull();
      // the owner confirms the flagged quote: running again doesn't flag it again
      const page = once.marketing.salesPage!;
      const confirmed: Project = {
        ...once,
        marketing: {
          ...once.marketing,
          salesPage: { ...page, sections: page.sections.map((s) => (s.type === 'proof' ? { ...s, data: { ...s.data, testimonials: s.data.testimonials.map(({ needsReview: _r, ...t }) => t) } } : s)) },
        },
      };
      expect(purgeSalesPage(confirmed)).toBeNull();
    }
  });

  it('leaves pages made by this version alone', () => {
    const p = newProject('product', 'new');
    p.marketing.salesPage = generateSalesPage(p);
    expect(purgeSalesPage(p)).toBeNull();
    expect(purgeSalesPage(newProject('business', 'new'))).toBeNull();
  });
});
