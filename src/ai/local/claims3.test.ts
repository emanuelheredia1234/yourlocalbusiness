import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { Project } from '@/lib/types';
import * as social from './social';
import { generateBrandKit } from './brand';
import { generateBusinessModel } from './studio';
import { generateSalesPage } from './seo';
import { generateCode } from './code';

function business(type = 'Home Cleaning', city = 'Austin'): Project {
  const p = newProject('business', 'new');
  p.niche = type;
  p.category = type;
  p.businessType = type;
  p.brand.name = 'Tidy Nest';
  p.location = { city, region: 'TX' };
  const bm = generateBusinessModel(p);
  p.studio.packages = bm.packages;
  p.studio.price = bm.price;
  return p;
}

function product(): Project {
  const p = newProject('product', 'new');
  p.niche = 'Personal Finance';
  p.category = 'Freelancer taxes';
  p.brand.name = 'Ledger Lane';
  p.studio.price = 29;
  return p;
}

describe('no service area the owner did not give', () => {
  it('brand kit taglines and pitches say "Serving {city}" at most, never "and nearby"', () => {
    const p = business();
    for (let v = 0; v < 24; v++) {
      const kit = generateBrandKit(p, {}, v);
      expect(`${kit.tagline} ${kit.pitch}`).not.toMatch(/nearby|neighbo/i);
    }
  });

  it('business model service area is the owner’s city only, or a placeholder', () => {
    const items = (p: Project) => generateBusinessModel(p).operating.flatMap((b) => b.items).filter((x) => x.startsWith('Service area'));
    expect(items(business())).toEqual(['Service area: Austin, TX']);
    expect(items(business('Home Cleaning', ''))).toEqual(['Service area: [where you work]']);
  });
});

describe('quiz and ROI widgets promise no results', () => {
  it('quiz results state no outcome', () => {
    for (const p of [business(), product()]) {
      for (let v = 0; v < 4; v++) {
        const js = generateCode(p, 'quiz', '', {}, v).js;
        expect(js).not.toMatch(/will help you|Fine-tune your routine|A clear system will/);
      }
    }
  });

  it('ROI widget starts at 0 and frames numbers as the visitor’s own', () => {
    for (const p of [business(), product()]) {
      const c = generateCode(p, 'roi', '');
      const all = `${c.html}${c.js}`;
      expect(all).not.toMatch(/Hours saved per week|worth to your business/);
      expect(all).toContain('your estimate');
      expect(c.note).toMatch(/start at 0/);
    }
  });
});

describe('sales page problem section makes no claims about the reader', () => {
  it('intro and agitation drop "not your fault" and consequences', () => {
    for (const p of [business(), product()]) {
      for (let v = 0; v < 6; v++) {
        const prob = generateSalesPage(p, {}, v).sections.find((s) => s.type === 'problem')!.data as { intro: string; agitation: string };
        const text = `${prob.intro} ${prob.agitation}`;
        expect(text).not.toMatch(/not your fault|not alone|compounds|wasted|doesn’t have to be|undefined/);
        expect(prob.intro).toMatch(/\.$/);
        expect(prob.agitation).toMatch(/\.$/);
      }
    }
  });
});

describe('legacy offer message', () => {
  it('social no longer exports the result-promising offerMessage', () => {
    expect('offerMessage' in social).toBe(false);
    expect(social.offerKeyMessage('Tidy Nest')).toBe('Tidy Nest: what it is, who it’s for, and what it costs.');
  });
});
