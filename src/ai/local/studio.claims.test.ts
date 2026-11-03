import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { Project } from '@/lib/types';
import { BUSINESS_TYPES, BUSINESS_VOICE, GENERIC_BUSINESS, NICHES } from '../knowledge';
import { applyBanned } from '../brain';
import { buildFacts, Voice } from '../text';
import { CLAIM_TERM, generateBusinessModel, generateOutline, teamRoles } from './studio';
import { defaultCampaign, generateCampaignPlan } from './social';
import { generateProductIdeas } from './research';

function business(type = 'Home Cleaning'): Project {
  const p = newProject('business', 'new');
  p.niche = type;
  p.category = type;
  p.businessType = type;
  p.location = { city: 'Austin', region: 'TX' };
  p.brand.name = 'Summit Co';
  return p;
}

function product(format: Project['format']): Project {
  const p = newProject('product', 'new');
  p.niche = 'Personal Finance';
  p.category = 'Freelancer Tax Tracking';
  p.format = format;
  p.idea = generateProductIdeas({ niche: p.niche, category: p.category, format: format ?? 'pdf', count: 1 })[0];
  return p;
}

/** Standards, credentials and promises a template used to put in the owner's mouth. */
const STANDARD = /Shoe covers|Flat-rate|Photo documentation|Follow-up call|Quality check|End-of-visit walk-through|Before\/after photos|Route-optimized|setup-ready|Feedback card|feedback loop|tax-ready|Low-stress|Photo update|steam and extraction|decontamination|written standard|on every (job|visit|project)|every (box|week|visit)\b/i;
const TIME = /\b\d+\s?(-\s?)?(minutes?|min|hours?|days?|weeks?)\b(?! ·)|day one|in a weekend/i;

describe('business templates state no standards, credentials or results', () => {
  it('keeps delivery steps neutral and roles free of credentials', () => {
    for (const t of [...BUSINESS_TYPES, GENERIC_BUSINESS]) {
      expect(t.delivery.join(' | ')).not.toMatch(STANDARD);
      expect(t.roles.join(' | ')).not.toMatch(CLAIM_TERM);
      expect(t.roles.join(' | ')).not.toMatch(/master|accountant/i);
    }
    expect(teamRoles(['Owner', 'Licensed technicians', 'Certified trainers'])).toEqual(['Owner']);
    expect(teamRoles(['Licensed technicians'])).toEqual(['Owner / operator', '[Other roles on your team]']);
  });

  it('keeps customer outcomes free of timelines and invented service standards', () => {
    const all = [...NICHES.flatMap((n) => n.outcomes), ...Object.values(BUSINESS_VOICE).flatMap((v) => v.outcomes)].join(' | ');
    expect(all).not.toMatch(/\bin \d+ (minutes|days|weeks|hours)|within (two weeks|a semester|\d+)|\d+%|\d+x\b|showroom|vetted|easy returns|done right|every rep|delivered hot|for months/i);
  });

  it('describes packages by tier, with no quality claims, and filters role credentials', () => {
    for (const type of ['Home Cleaning', 'Plumbing', 'Personal Trainer', 'Bakery']) {
      const bm = generateBusinessModel(business(type));
      const text = JSON.stringify(bm.packages);
      expect(text).not.toMatch(/done right|white-glove|very best|everything you need/i);
      expect(bm.packages.map((p) => p.description)).toEqual([
        expect.stringMatching(/^The starting package/),
        expect.stringMatching(/^The middle package/),
        expect.stringMatching(/^The most complete package/),
      ]);
      const team = bm.operating.find((b) => b.title === 'Team & roles')!;
      expect(team.items.length).toBeGreaterThan(0);
      for (const r of team.items) expect(r).not.toMatch(CLAIM_TERM);
    }
  });
});

describe('product outlines invent no tiers, perks or setup times', () => {
  it('outlines one membership tier at the owner price with placeholders', () => {
    const p = product('membership');
    p.studio.price = 29;
    const secs = generateOutline(p).sections;
    const text = JSON.stringify(secs);
    expect(text).not.toMatch(/\bPro ·|\bVIP\b|1:1|Priority support|Live Q&A \+ replays|goal-setting workshop/i);
    expect(secs.filter((s) => /\$\d/.test(s.title))).toHaveLength(1);
    expect(secs[0].title).toBe('Membership · $29/mo');
    expect(text).toMatch(/\[What members get every month\]/);
    p.studio.price = 0;
    p.idea = null;
    expect(generateOutline(p).sections[0].title).toBe('Membership · [your price]/mo');
  });

  it('promises no setup times in any outline', () => {
    for (const fmt of ['course', 'pdf', 'ebook', 'template', 'spreadsheet', 'software', 'audio', 'design', 'membership'] as const) {
      const titles = generateOutline(product(fmt)).sections.flatMap((s) => [s.title, s.summary ?? '', ...s.items.flatMap((i) => [i.title, i.detail ?? ''])]);
      expect(titles.join(' | ')).not.toMatch(/under \d+ minutes|in \d+ minutes|\d+-minute|day one|save hours|in a weekend|breakthroughs|annual discount/i);
    }
  });
});

describe('copy helpers add no deadlines or time promises', () => {
  it('rewrites "limited time" without a deadline', () => {
    const out = applyBanned('Limited time offer: get 20% off for a limited time.', ['limited time']);
    expect(out).toBe('Current offer: get 20% off now.');
    expect(out).not.toMatch(/this week|today|ends/i);
  });

  it('writes social topics and hooks without timelines', () => {
    const p = product('pdf');
    const plan = generateCampaignPlan(p, defaultCampaign());
    expect(JSON.stringify(plan)).not.toMatch(/in 15 minutes/);
    const f = buildFacts(p);
    for (let seed = 0; seed < 60; seed++) {
      const v = Voice.create(f, {}, seed);
      for (const type of ['educational', 'tip', 'question', 'sales', 'email', 'ad'] as const) {
        const h = v.hook(type);
        expect(h).not.toMatch(/minutes a week is enough|One habit, \d+ days|a very different/);
        expect(h).not.toMatch(TIME);
      }
    }
  });
});
