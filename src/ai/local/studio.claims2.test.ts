import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { AdObjective, Project, ProductFormat } from '@/lib/types';
import { generateAds, newAdCampaign } from './ads';
import { proceduralSvg } from './art';
import { generateCode } from './code';
import { generateListing, generateOutline } from './studio';
import { generateProductIdeas } from './research';

function business(type = 'Home Cleaning', city = 'Austin'): Project {
  const p = newProject('business', 'new');
  p.niche = type;
  p.category = type;
  p.businessType = type;
  p.location = { city, region: 'TX' };
  p.brand.name = 'Summit Co';
  return p;
}

function product(format: ProductFormat, withIdea = true): Project {
  const p = newProject('product', 'new');
  p.niche = 'Personal Finance';
  p.category = 'Freelancer Tax Tracking';
  p.format = format;
  if (withIdea) p.idea = generateProductIdeas({ niche: p.niche, category: p.category, format, count: 1 })[0];
  return p;
}

const FORMATS: ProductFormat[] = ['pdf', 'ebook', 'course', 'template', 'spreadsheet', 'software', 'design', 'audio', 'membership'];
const PROMISE = /\bNo more\b|\bhelps .+ without\b|\bwithout .+,? (?:helps)|fixes it|you['’]ll |never sneaks up|Imagine being able|Built-in /i;

describe('ads promise no results and no local monopoly', () => {
  const projects = [business(), business('Plumbing'), business('Bakery', ''), product('pdf'), product('course'), product('template', false)];
  it('never says the pain goes away, across objectives and variations', () => {
    for (const p of projects) {
      for (const objective of ['awareness', 'traffic', 'leads', 'sales'] as AdObjective[]) {
        for (let v = 0; v < 4; v++) {
          const c = { ...newAdCampaign(p), objective, platforms: ['meta' as const, 'google' as const] };
          const r = generateAds(p, c, {}, v);
          const text = JSON.stringify(r.creatives) + JSON.stringify(r.search);
          expect(text).not.toMatch(PROMISE);
          expect(text).not.toMatch(/Pain → fix/);
          // the pain is named as a question, cut cleanly
          expect(r.creatives[0].headline).toMatch(/^Tired of .+\?$/);
          expect(r.creatives[0].headline.length).toBeLessThanOrEqual(40);
          expect(r.creatives[0].visualHeadline).toMatch(/^Tired of .+\?$/);
          expect(r.creatives[1].headline).toMatch(/^Want to .+\?$|…$/);
          // no "Austin’s Home Cleaning": a business is "{Label} in {City}"
          for (const cr of r.creatives) expect(cr.headline).not.toMatch(/^[A-Z][\w ]*[’']s /);
        }
      }
    }
    const r = generateAds(business(), { ...newAdCampaign(business()), objective: 'sales' });
    expect(r.creatives[2].headline).toMatch(/ in Austin$/);
  });
});

describe('the people scene draws no rating', () => {
  it('has a conversation bubble, not five stars', () => {
    for (let seed = 1; seed < 6; seed++) {
      const svg = proceduralSvg({ primary: '#225588', secondary: '#88aa22', accent: '#ffaa00', ink: '#111111', paper: '#ffffff' }, { aspect: '1:1', scene: 'people', seed });
      expect(svg).not.toMatch(/<polygon/);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toMatch(/<\/svg>\s*$/);
    }
  });
});

describe('listing and hero widget describe what it is, not a result', () => {
  it('product listings use the owner’s features or outline, never invented "Built-in" features', () => {
    for (const f of FORMATS) {
      for (const withIdea of [true, false]) {
        const p = product(f, withIdea);
        p.studio.outline = generateOutline(p).sections;
        for (let v = 0; v < 3; v++) {
          const l = generateListing(p, {}, v);
          expect(l.description).not.toMatch(PROMISE);
          expect(l.description).toMatch(/ for .+ who want to /);
        }
      }
    }
    const bare = product('pdf', false);
    bare.studio.outline = [];
    expect(generateListing(bare).description).toMatch(/• Covers /);
  });

  it('hero lead and headline promise nothing', () => {
    for (const p of [business(), business('Plumbing'), product('pdf'), product('course', false)]) {
      p.brand.tagline = '';
      for (let v = 0; v < 3; v++) {
        const r = generateCode(p, 'hero', 'hero section', {}, v);
        expect(r.html).not.toMatch(PROMISE);
        expect(r.html).not.toMatch(/helps /);
      }
    }
  });
});

describe('outlines invent no lengths or counts as contents', () => {
  const COUNTS = /\b\d+\s?(min|minutes|pages?|page|questions|layouts|palettes|pairings|icons|templates|users)\b|Loom|Releasing|1–2 pages|weeks? \d+–\d+|in seconds|never sneaks/i;
  it('uses [length]/[how many] placeholders across formats and variations', () => {
    for (const f of FORMATS) {
      for (const length of ['short', 'medium', 'long'] as const) {
        for (let v = 0; v < 3; v++) {
          const o = generateOutline(product(f), { length }, v);
          const text = JSON.stringify(o.sections);
          expect(text).not.toMatch(COUNTS);
          expect(o.sections.length).toBeGreaterThan(0);
          for (const s of o.sections) {
            expect(s.title.trim()).not.toBe('');
            for (const it of s.items) expect(it.title.trim()).not.toBe('');
          }
        }
      }
    }
    const course = JSON.stringify(generateOutline(product('course')).sections);
    expect(course).toMatch(/Video · \[length\]/);
    const design = JSON.stringify(generateOutline(product('design')).sections);
    expect(design).toMatch(/\[How many\] feed post templates/);
  });
});
