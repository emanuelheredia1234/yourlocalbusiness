import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { Project } from '@/lib/types';
import { generateProductIdeas } from './local/research';
import { generateBrandKit } from './local/brand';
import { generateOutline, generateBusinessModel, generateListing } from './local/studio';
import { generateAds, newAdCampaign } from './local/ads';
import { generateEmailSequence, generateLeadMagnet } from './local/email';
import { generateSalesPage, generateSeoMeta, scoreSeo, exportSalesHtml } from './local/seo';
import { composePost, defaultCampaign, generateCampaignPlan, generateContentBatch } from './local/social';
import { generateCode, modifyCode } from './local/code';
import { applyBanned, learnFromFeedback, mergeDirectives, newSkill, parseDirectives, polishText } from './brain';
import { conform, parseJsonLoose } from './claude';
import { luhnValid, cardBrand } from '@/lib/utils';

function productProject(): Project {
  const p = newProject('product', 'new');
  p.niche = 'Personal Finance';
  p.category = 'Freelancer Tax Tracking';
  p.format = 'spreadsheet';
  const ideas = generateProductIdeas({ niche: p.niche, category: p.category, format: 'spreadsheet', count: 4 });
  p.idea = ideas[0];
  p.studio.price = ideas[0].price;
  const kit = generateBrandKit(p);
  p.brand = { ...p.brand, name: kit.nameOptions[0].name, tagline: kit.tagline, pitch: kit.pitch, audience: kit.audience, slug: kit.slug, websiteUrl: `https://${kit.slug}.com`, colors: kit.colors };
  return p;
}

function businessProject(): Project {
  const p = newProject('business', 'new');
  p.niche = 'Home Cleaning';
  p.category = 'Eco-friendly house cleaning';
  p.businessType = 'Home Cleaning';
  p.location = { city: 'Austin', region: 'TX' };
  const kit = generateBrandKit(p);
  p.brand = { ...p.brand, name: kit.nameOptions[0].name, tagline: kit.tagline, pitch: kit.pitch, slug: kit.slug, websiteUrl: `https://${kit.slug}.com`, colors: kit.colors };
  const bm = generateBusinessModel(p);
  p.studio.packages = bm.packages;
  p.studio.price = bm.price;
  return p;
}

describe('local AI engine', () => {
  it('generates niche-aware product ideas', () => {
    const ideas = generateProductIdeas({ niche: 'Fitness', category: 'Postpartum Mobility', format: 'course', count: 5 });
    expect(ideas).toHaveLength(5);
    for (const i of ideas) {
      expect(i.score).toBeGreaterThan(40);
      expect(i.score).toBeLessThan(100);
      expect(i.price).toBeGreaterThan(50);
      expect(i.title.toLowerCase()).toContain('postpartum mobility');
    }
    console.log(ideas.map((i) => `${i.score} · ${i.title} · $${i.price}\n   ${i.hook}\n   ${i.audience} | ${i.pain}`).join('\n'));
  });

  it('builds a brand kit, outline, funnel, sales page and campaign for a product', () => {
    const p = productProject();
    const kit = generateBrandKit(p);
    expect(kit.nameOptions).toHaveLength(3);
    console.log('NAMES', kit.nameOptions.map((n) => n.name).join(' | '), '\nTAGLINE', kit.tagline, '\nPITCH', kit.pitch);
    const outline = generateOutline(p);
    expect(outline.sections.length).toBeGreaterThan(3);
    p.studio.outline = outline.sections;
    const lm = generateLeadMagnet(p, 'checklist');
    p.marketing.leadMagnet = lm;
    const emails = generateEmailSequence(p, lm);
    expect(emails).toHaveLength(5);
    console.log('LEAD MAGNET', lm.title, '\nEMAIL 5\n', emails[4].subject, '\n', emails[4].body);
    const meta = generateSeoMeta(p);
    const page = generateSalesPage(p);
    const score = scoreSeo(meta, page);
    console.log('SEO', meta.metaTitle, `(${meta.metaTitle.length})`, '\n', meta.metaDescription, `(${meta.metaDescription.length})`, '\nSCORE', score.score, score.checks.filter((c) => !c.pass).map((c) => c.label));
    expect(score.score).toBeGreaterThan(60);
    const html = exportSalesHtml(page, meta, p.brand, p);
    expect(html).toContain('application/ld+json');
    const cfg = defaultCampaign();
    const plan = generateCampaignPlan(p, cfg);
    expect(plan.days).toHaveLength(30);
    expect(plan.summary.total).toBe(plan.days.filter((d) => d.posting).length * cfg.postsPerDay);
    const batch = generateContentBatch(p, plan, cfg);
    expect(batch.length).toBeGreaterThan(0);
    console.log('POST\n', batch[0].platform, batch[0].postType, batch[0].format, '\n', batch[0].caption, '\n', batch[0].hashtags.join(' '));
  });

  it('builds a local business model and booking widget', () => {
    const p = businessProject();
    expect(p.studio.packages).toHaveLength(3);
    console.log(p.brand.name, '·', p.brand.tagline, '\n', p.studio.packages.map((x) => `${x.name} $${x.price}`).join(' | '));
    const code = generateCode(p, 'booking', '');
    expect(code.html).toContain('Book with');
    expect(code.js).not.toContain('</' + 'script');
    const meta = generateSeoMeta(p);
    expect(meta.primaryKeyword).toContain('austin');
    const post = composePost(p, { topic: 'A day at the shop', postType: 'bts', platform: 'facebook', format: 'image', style: 'editorial' });
    console.log('BIZ POST\n', post.caption);
  });

  it('keeps the campaign post mix balanced for every goal', () => {
    const p = productProject();
    for (const goal of ['awareness', 'leads', 'sales'] as const) {
      const plan = generateCampaignPlan(p, { ...defaultCampaign(), goal });
      const share = plan.summary.byType.sales / plan.summary.total;
      expect(share).toBeGreaterThan(0.1);
      expect(share).toBeLessThan(0.4);
      // every enabled post type appears
      for (const n of Object.values(plan.summary.byType)) expect(n).toBeGreaterThan(0);
    }
  });

  it('writes business copy from the business type, not the broad niche', () => {
    const p = newProject('business', 'new');
    p.businessType = 'Dog grooming';
    p.niche = 'Dog grooming';
    p.category = 'Mobile grooming van';
    p.location = { city: 'Austin', region: 'TX' };
    p.brand.name = 'Pounce & Co.';
    const listing = generateListing(p);
    expect(listing.bookingType).toBe('book');
    expect(listing.description).not.toMatch(/leash/i);
    const ads = generateAds(p, newAdCampaign(p));
    for (const c of ads.creatives) {
      expect(c.headline.length).toBeLessThanOrEqual(40);
      expect(c.headline).not.toMatch(/^Get (bring|book|keep)\b|^Stop (a|an|the) /i);
      expect(c.headline).not.toMatch(/\b(and|or|with|to|of)$/);
    }
  });

  it('modifies code with plain-language instructions', () => {
    const p = productProject();
    const code = generateCode(p, 'calculator', '');
    const m = modifyCode(code, 'make it dark and change the color to #e11d48 with rounder corners');
    expect(m.applied).toEqual(expect.arrayContaining(['Dark theme', 'Rounder corners']));
    expect(m.css).toContain('--brand: #e11d48');
    const again = modifyCode(m, 'bigger text');
    expect(again.css).toContain('--bg: #0f1412');
    expect(again.css).toContain('--scale: 1.12');
  });
});

describe('brain', () => {
  it('parses freeform skills into directives', () => {
    const d = parseDirectives('Friendly and warm voice. No emojis. Use PAS. Keep it short. Never say: cheap, hack. Always mention free shipping. CTA: "Shop the drop" #handmade');
    expect(d.tone).toBe('friendly');
    expect(d.emoji).toBe('none');
    expect(d.framework).toBe('PAS');
    expect(d.length).toBe('short');
    expect(d.banned).toEqual(expect.arrayContaining(['cheap', 'hack']));
    expect(d.mustInclude?.[0]).toMatch(/free shipping/);
    expect(d.cta).toBe('Shop the drop');
    expect(d.hashtags).toContain('#handmade');
  });

  it('applies banned words and emoji policy', () => {
    expect(applyBanned('This cheap hack is crazy good', ['cheap', 'hack', 'crazy'])).toBe('This affordable shortcut is surprising good');
    expect(polishText('Big news 🎉 today!', { emoji: 'none' })).toBe('Big news today!');
  });

  it('merges by priority and learns from feedback', () => {
    const a = newSkill({ name: 'a', priority: 1, directives: { tone: 'playful', banned: ['x'] } });
    const b = newSkill({ name: 'b', priority: 3, directives: { tone: 'luxury', banned: ['y'] } });
    const m = mergeDirectives([b, a]);
    expect(m.tone).toBe('luxury');
    expect(m.banned).toEqual(['x', 'y']);
    const learned = learnFromFeedback([], ['too-long', 'less-emoji'], 'More specific numbers please', 'caption');
    expect(learned[0].directives.length).toBe('short');
    expect(learned[0].directives.emoji).toBe('none');
  });
});

describe('claude helpers', () => {
  it('parses loose JSON and conforms shapes', () => {
    expect(parseJsonLoose('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Here: [1,2] done')).toEqual([1, 2]);
    const base = { id: 'x_1', title: 'Base', price: 10, items: [{ id: 'i_1', t: 'one' }], type: 'hero' };
    const out = conform(base, { id: 'hack', title: 'New', price: '29', items: [{ t: 'a' }, { t: 'b' }], type: 'evil' });
    expect(out.title).toBe('New');
    expect(out.price).toBe(29);
    expect(out.id).toBe('x_1');
    expect(out.type).toBe('hero');
    expect(out.items).toHaveLength(2);
    expect(out.items[1].id).not.toBe(out.items[0].id);
  });
});

describe('payments', () => {
  it('validates cards', () => {
    expect(luhnValid('4242 4242 4242 4242')).toBe(true);
    expect(luhnValid('4242 4242 4242 4241')).toBe(false);
    expect(cardBrand('3782 822463 10005')).toBe('amex');
  });
});
