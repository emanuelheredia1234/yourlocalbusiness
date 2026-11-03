import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { Project } from '@/lib/types';
import { BUSINESS_TYPES, NICHES } from '../knowledge';
import { generateBusinessModel, generateOutline } from './studio';
import { generateEmailSequence, generateLeadMagnet, LEAD_MAGNET_TYPES } from './email';
import { disclaimerFor, localEbookExtras } from './ebook';
import { generateProductIdeas } from './research';

/** Advice that only fits some businesses of a niche, or reads as a number, a service standard or a promise. */
const NARROW_ADVICE =
  /\d|%|\$|sump|hvac|filter|photo updates|every job|tuesday|special|discovery call|free\b|protein|spf|snuffle|carry-on|travel card|fare alert|pre-approved|comps|abandoned cart|\bAOV\b|STAR stories|rubric|exit ticket|retrieval|seasonal inspection|cancel the|backward from dinner/i;

/** Claims the reviewer found in the ebook front matter and the email sequence. */
const PROMISES =
  /step-by-step path|puts you ahead|you now have a clear way|faster than you think|A practical \w+ to help|never hear|“stuck” and “sorted”|I’ll tell you honestly|easier to keep than willpower|easier to keep up than|Why it works|exactly why|based on experience|builds on the last/i;

function business(type: string): Project {
  const p = newProject('business', 'new');
  p.niche = type;
  p.category = type;
  p.businessType = type;
  p.location = { city: 'Austin', region: 'TX' };
  p.brand.name = 'Summit Co';
  const bm = generateBusinessModel(p);
  p.studio.packages = bm.packages;
  p.studio.price = bm.price;
  return p;
}

function product(niche: string, category: string): Project {
  const p = newProject('product', 'new');
  p.niche = niche;
  p.category = category;
  p.format = 'ebook';
  p.idea = generateProductIdeas({ niche, category, format: 'ebook', count: 1 })[0];
  p.studio.price = p.idea.price;
  p.brand.name = 'Ledger Lane';
  return p;
}

describe('niche quick wins are generic, low-risk advice', () => {
  it('no niche quick win carries numbers, products, offers or narrow advice', () => {
    for (const n of NICHES) {
      expect(n.quickWins.length, n.id).toBeGreaterThanOrEqual(4);
      for (const q of n.quickWins) {
        expect(q, `${n.id}: ${q}`).not.toMatch(NARROW_ADVICE);
        // starts with a lowercase verb so "If you only do one thing today: …" and "How often do you …?" read well
        expect(q, `${n.id}: ${q}`).toMatch(/^[a-z]/);
      }
    }
  });

  it('home services no longer tell a cleaning or plumbing customer to test a sump pump', () => {
    for (const bt of BUSINESS_TYPES.slice(0, 3)) {
      const p = business(bt.label);
      const text = JSON.stringify([generateEmailSequence(p, generateLeadMagnet(p, 'checklist')), ...LEAD_MAGNET_TYPES.map((t) => generateLeadMagnet(p, t.id))]);
      expect(text).not.toMatch(/sump pump|HVAC filters|photo updates/i);
    }
  });
});

describe('lead magnet opt-in bullets match the freebie', () => {
  it('the mistakes count equals the “avoid” items actually listed, or is left out', () => {
    for (const p of [business('Home Cleaning'), product('Personal Finance', 'Freelancer Tax Tracking')]) {
      for (const { id } of LEAD_MAGNET_TYPES) {
        for (let v = 0; v < 3; v++) {
          const lm = generateLeadMagnet(p, id, {}, v);
          const bullet = lm.optInBullets.find((b) => /mistakes? to watch for/.test(b));
          const items = lm.sections.flatMap((s) => s.items);
          if (id === 'checklist') {
            const avoid = items.filter((i) => i.startsWith('Avoid ')).length;
            expect(bullet, `${id}`).toBe(`${avoid} common ${avoid === 1 ? 'mistake' : 'mistakes'} to watch for`);
          } else if (id === 'cheatsheet') {
            expect(bullet).toBe(`${lm.sections.find((s) => s.heading === 'Avoid this')!.items.length} common mistakes to watch for`);
          } else if (id === 'guide') {
            expect(bullet).toBe(`${lm.sections[0].items.length} common mistakes to watch for`);
          } else {
            expect(bullet, id).toBeUndefined();
            expect(lm.optInBullets[1]).toMatch(new RegExp(`^${items.length} `));
          }
        }
      }
    }
  });
});

describe('email sequence makes no promises for the owner', () => {
  it('has none of the flagged lines across lengths and variations', () => {
    for (const p of [business('Home Cleaning'), business('Plumbing'), product('Personal Finance', 'Freelancer Tax Tracking')]) {
      for (const length of ['short', 'medium', 'long'] as const) {
        for (let v = 0; v < 6; v++) {
          const emails = generateEmailSequence(p, generateLeadMagnet(p, 'checklist'), { length }, v);
          const text = emails.map((e) => `${e.subject}\n${e.body}`).join('\n');
          expect(text).not.toMatch(PROMISES);
          expect(text).not.toMatch(/It’s (estimate|service call|cash flow)\./);
          expect(text).not.toMatch(/15-minute/);
        }
      }
    }
  });
});

describe('ebook front matter describes the file, not results', () => {
  it('welcome, subtitle, conclusion and disclaimer carry no promises', () => {
    for (const [niche, category] of [['Fitness', 'Home Workouts'], ['Personal Finance', 'Freelancer Tax Tracking'], ['Home Cleaning', 'Home Cleaning']]) {
      const p = Object.assign(newProject('product', 'new'), { niche, category, format: 'ebook' as const });
      p.studio.outline = generateOutline(p).sections;
      const x = localEbookExtras(p);
      const text = [x.subtitle, x.welcome, x.conclusion, x.disclaimer, ...x.howToUse, ...x.nextSteps].join('\n');
      expect(text).not.toMatch(PROMISES);
      expect(x.subtitle).toMatch(/^A \w+ about .+ for .+\.$/);
      // the welcome lists the chapters the file really has
      const first = p.studio.outline[0].title.replace(/^(Module|Chapter|Section|Day|Week|Tab|Part) \d+:\s*/i, '').trim();
      expect(x.welcome).toContain(first);
    }
    expect(disclaimerFor('Woodworking')).not.toMatch(/experience|effort/);
  });
});
