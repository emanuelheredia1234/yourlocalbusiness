import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { Project } from '@/lib/types';
import { NICHES } from '../knowledge';
import { buildFacts } from '../text';
import { generateBrandKit } from './brand';
import { generateBusinessModel } from './studio';
import { exportSalesHtml, generateSalesPage, generateSeoMeta } from './seo';

function product(niche: string, category: string, format: Project['format']): Project {
  const p = newProject('product', 'new');
  p.niche = niche;
  p.category = category;
  p.format = format;
  p.studio.price = 29;
  const kit = generateBrandKit(p);
  p.brand = { ...p.brand, name: kit.nameOptions[0].name, slug: kit.slug, websiteUrl: '', colors: kit.colors };
  return p;
}

function business(type: string, city = 'Austin'): Project {
  const p = newProject('business', 'new');
  p.niche = type;
  p.category = type;
  p.businessType = type;
  p.location = { city, region: 'TX' };
  const kit = generateBrandKit(p);
  p.brand = { ...p.brand, name: kit.nameOptions[0].name, slug: kit.slug, websiteUrl: '', colors: kit.colors };
  const bm = generateBusinessModel(p);
  p.studio.packages = bm.packages;
  p.studio.price = bm.price;
  return p;
}

const PROJECTS = () => [
  product('Personal Finance', 'Freelancer Tax Tracking', 'spreadsheet'),
  product('Fitness', 'Home workouts for beginners', 'course'),
  product('Productivity', 'Notion planning', 'template'),
  business('Home Cleaning'),
  business('Auto Repair'),
  business('Accounting', ''),
  business('Dog grooming'),
];

/** Results promised as fact, service standards, owner actions and puffery the owner never said. */
const PROMISES = /\bhelps? (you|\w+ \w+)|that helps|built to help|without \w|off your plate|finally sorted|the smarter way|made simple|without the stress|turns .+ into a clear|repeatable routine|no more\b|fixes it|you['’]ll\b|we checked|I read every|I['’]ll send|strategy call|start the program|designed so|★|\bstars?\b|rated\b/i;

describe('sales page and SEO copy state only what the owner provided', () => {
  it('hero, solution, FAQ and meta make no result promises and no service standards', () => {
    for (const p of PROJECTS()) {
      const f = buildFacts(p);
      // Niche desires/outcomes for a business read as service standards ("On-time, tidy professionals").
      const standards = p.track === 'business' ? [...f.niche.desires, ...f.outcomes].map((x) => x.toLowerCase()) : [];
      for (let v = 0; v < 10; v++) {
        const page = generateSalesPage(p, {}, v);
        const meta = generateSeoMeta(p, {}, v);
        const hero = page.sections.find((s) => s.type === 'hero')!.data as { headline: string; subheadline: string; bullets: string[] };
        const solution = page.sections.find((s) => s.type === 'solution')!.data;
        const faq = page.sections.find((s) => s.type === 'faq')!.data;
        const guarantee = page.sections.find((s) => s.type === 'guarantee')!.data;
        const text = JSON.stringify({ hero, solution, faq, finalHeading: (guarantee as { finalHeading: string }).finalHeading, meta });
        expect(text, `${p.businessType || p.category} v${v}`).not.toMatch(PROMISES);
        for (const s of standards) expect(text.toLowerCase(), s).not.toContain(s);
        // Well-formed: no empty interpolations or doubled punctuation.
        expect(text).not.toMatch(/undefined|null|\.\.(?!\.)|\s,|\(\)/);
        expect(hero.headline.trim().length).toBeGreaterThan(5);
        expect(hero.subheadline).toMatch(/[.?]$/);
      }
    }
  });

  it('hero bullets come only from the owner’s packages, features or outline', () => {
    const b = business('Home Cleaning');
    const hero = generateSalesPage(b).sections.find((s) => s.type === 'hero')!.data as { bullets: string[] };
    expect(hero.bullets.every((x) => b.studio.packages.some((p) => p.name === x))).toBe(true);
    const p = product('Personal Finance', 'Freelancer Tax Tracking', 'spreadsheet');
    p.idea = null;
    p.studio.outline = [];
    const ph = generateSalesPage(p).sections.find((s) => s.type === 'hero')!.data as { bullets: string[] };
    expect(ph.bullets).toEqual([]);
    expect(exportSalesHtml(generateSalesPage(p), generateSeoMeta(p), p.brand, p)).not.toContain('<ul class="ticks"></ul>');
  });

  it('headlines stay varied across variations', () => {
    for (const p of PROJECTS()) {
      const heads = new Set(Array.from({ length: 12 }, (_, v) => (generateSalesPage(p, {}, v).sections[0].data as { headline: string }).headline));
      expect(heads.size).toBeGreaterThan(1);
    }
  });
});

describe('brand kit copy states only what the business is and who it is for', () => {
  it('tagline, pitch and value proposition make no promises or standards', () => {
    const ps = [...PROJECTS(), ...NICHES.slice(0, 6).map((n) => product(n.label, n.label, 'ebook'))];
    for (const p of ps) {
      const f = buildFacts(p);
      const standards = f.local ? f.niche.desires.map((x) => x.toLowerCase()) : [];
      const taglines = new Set<string>();
      for (let v = 0; v < 12; v++) {
        const kit = generateBrandKit(p, {}, v);
        taglines.add(kit.tagline);
        for (const s of [kit.tagline, kit.pitch, kit.valueProp, ...kit.nameOptions.map((n) => n.rationale)]) {
          expect(s, s).not.toMatch(PROMISES);
          expect(s, s).not.toMatch(/close to home|undefined|\.\.(?!\.)/i);
          for (const d of standards) expect(s.toLowerCase(), s).not.toContain(d);
        }
      }
      expect(taglines.size).toBeGreaterThan(1);
    }
  });
});
