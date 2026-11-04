import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { Project } from '@/lib/types';
import { BUSINESS_TYPES, GENERIC_BUSINESS, matchBusinessType } from '../knowledge';
import { businessModelTask, type TaskEnv } from '../tasks';
import { listingSuggestions } from '@/lib/listing';
import { generateBusinessModel, generateListing, generateOutline, ownerGuarantee } from './studio';
import { generateAds, newAdCampaign } from './ads';
import { generateEmailSequence, generateLeadMagnet, LEAD_MAGNET_TYPES } from './email';
import { defaultCampaign, generateCampaignPlan } from './social';
import { generateProductIdeas } from './research';
import { anchoredOutcomes, buildFacts, genericNiche, Voice } from '../text';
import { FORMATS, NICHES } from '../knowledge';

/** Claims the app used to make up for the owner: none may appear unless the owner supplied the fact. */
const INVENTED = /trusted by|licensed|insured|\breviews?\b|what neighbors say|free estimates?|60 seconds|instant (access|digital delivery)|lifetime updates|switching to|takes 2 minutes|30-day guarantee|money-back/i;
const GUARANTEES = [...BUSINESS_TYPES, GENERIC_BUSINESS].map((t) => t.guarantee);

function business(): Project {
  const p = newProject('business', 'new');
  p.niche = 'Home Cleaning';
  p.category = 'Eco-friendly house cleaning';
  p.businessType = 'Home Cleaning';
  p.location = { city: 'Austin', region: 'TX' };
  p.brand.name = 'Summit Cleaning';
  const bm = generateBusinessModel(p);
  p.studio.packages = bm.packages;
  p.studio.valueStack = bm.valueStack;
  p.studio.price = bm.price;
  p.studio.listing = generateListing(p);
  return p;
}

function product(): Project {
  const p = newProject('product', 'new');
  p.niche = 'Personal Finance';
  p.category = 'Freelancer Tax Tracking';
  p.format = 'spreadsheet';
  p.idea = generateProductIdeas({ niche: p.niche, category: p.category, format: 'spreadsheet', count: 1 })[0];
  p.studio.price = p.idea.price;
  p.brand.name = 'Ledger Lane';
  return p;
}

const adText = (p: Project, objective?: 'leads' | 'sales') => {
  const c = { ...newAdCampaign(p), platforms: ['meta' as const, 'google' as const], ...(objective ? { objective } : {}) };
  const r = generateAds(p, c);
  return { r, text: JSON.stringify({ creatives: r.creatives, search: r.search }) };
};

describe('business facts are the owner’s, not a template’s', () => {
  it('starts a business listing with no hours and no guarantee', () => {
    for (const type of ['Home Cleaning', 'HVAC repair', 'Dog grooming', 'Bakery', 'Something unusual']) {
      const p = business();
      p.businessType = type;
      p.niche = type;
      const l = generateListing(p);
      expect(l.hours).toBe('');
      for (const g of GUARANTEES) expect(l.description).not.toContain(g);
      expect(l.description).not.toMatch(INVENTED);
      expect(l.description.trim().split('\n').pop()).toMatch(/^(Book a time that suits you|Get in touch for a quote|Order today)\.$/);
      expect(l.tags.join(' ')).not.toMatch(/licensed|insured|free estimate|warranty/);
    }
  });

  it('offers the business type’s hours and guarantee only as suggestions', () => {
    const p = business();
    const bt = matchBusinessType(`${p.businessType} ${p.category} ${p.niche}`);
    expect(listingSuggestions(p)).toEqual({ hours: bt.hours, guarantee: bt.guarantee });
    expect(listingSuggestions(product())).toEqual({ hours: '', guarantee: '' });
  });

  it('claims instant delivery or updates for a product only from a real file', () => {
    const p = product();
    const l = generateListing(p);
    expect(l.description).not.toMatch(INVENTED);
    expect(l.description).toMatch(/Format: Spreadsheet\.$/);
    p.studio.productFiles = [{ id: 'f1', kind: 'xlsx', name: 'tracker.xlsx', size: 1000, createdAt: 1, sheets: ['Start', 'Log', 'Summary'], engine: 'local' }];
    expect(generateListing(p).description).toMatch(/Comes as an Excel workbook \(3 tabs\)\.$/);
    p.studio.productFiles = [{ id: 'f2', kind: 'pdf', name: 'guide.pdf', size: 1000, createdAt: 2, pages: 24, engine: 'local' }, ...p.studio.productFiles];
    expect(generateListing(p).description).toMatch(/Comes as a PDF \(24 pages\)\.$/);
  });

  it('leaves value-stack values and the guarantee for the owner', () => {
    const p = business();
    const bm = generateBusinessModel(p);
    expect(bm.valueStack.length).toBeGreaterThan(1);
    expect(bm.valueStack[0].kind).toBe('core');
    for (const v of bm.valueStack) {
      expect(v.value).toBe(0);
      expect(v.kind).not.toBe('guarantee');
    }
    const includes = bm.packages.flatMap((x) => x.includes).join(' | ');
    for (const g of GUARANTEES) expect(includes).not.toContain(g.split(':')[0]);
    expect(bm.packages.map((x) => x.description).join(' ')).not.toMatch(/most popular/i);
    for (const t of BUSINESS_TYPES) for (const b of t.bonuses) expect(includes).not.toContain(b);
    expect(includes).not.toMatch(/Priority scheduling/);
    expect(bm.packages.some((x) => x.popular)).toBe(false);
    expect(bm.valueStack.filter((v) => v.kind === 'bonus').map((v) => v.title)).toEqual(['[A bonus you actually include]']);
    const hours = bm.operating.find((b) => b.title === 'Hours & capacity')!;
    expect(hours.items[0]).toBe('Opening hours: [your hours]');
    expect(hours.items.join(' ')).not.toMatch(/\d/);
  });

  it('marks a tier popular only when the owner already did', () => {
    const p = business();
    p.studio.packages = p.studio.packages.map((x, i) => ({ ...x, popular: i === 2 }));
    const bm = generateBusinessModel(p);
    expect(bm.packages.map((x) => !!x.popular)).toEqual([false, false, true]);
  });

  it('keeps the AI’s value stack free of values and guarantees too', () => {
    const p = business();
    const env: TaskEnv = { project: p, directives: {}, brainPrompt: '', variation: 0 };
    const base = businessModelTask.local({}, env);
    const raw = {
      valueStack: [
        { title: 'Deep Refresh package', value: 450, description: 'Our core clean.' },
        { title: 'Free fridge clean-out', value: 79, description: 'On the first visit.' },
        { title: 'Our 100% satisfaction guarantee', value: 0, description: 'We re-clean free.' },
      ],
    };
    const out = businessModelTask.claude!.merge(raw, base, {}, env);
    expect(out.valueStack.map((v) => [v.kind, v.title, v.value])).toEqual([
      ['core', 'Deep Refresh package', 0],
      ['bonus', 'Free fridge clean-out', 0],
    ]);
    expect(businessModelTask.claude!.prompt({}, env, base)).toMatch(/No guarantee in the packages or the value stack/);
  });
});

describe('ads claim nothing the owner didn’t say', () => {
  it('writes business ads without reviews, licensing, guarantees or free estimates', () => {
    const p = business();
    const { r, text } = adText(p);
    expect(text).not.toMatch(INVENTED);
    expect(r.search!.sitelinks.map((s) => s.title)).toEqual(['Services & Pricing', 'Book a Time', 'About Us', 'Contact Us']);
    expect(r.search!.headlines).toContain('Serving Austin');
    expect(r.search!.descriptions[1]).toBe('Summit Cleaning serves Austin. Book today.');
    expect(r.search!.keywords.join(' ')).not.toMatch(/licensed|insured|free estimate/);
    for (const h of r.search!.headlines) expect(h.length).toBeLessThanOrEqual(30);
    for (const d of r.search!.descriptions) expect(d.length).toBeLessThanOrEqual(90);
    for (const c of r.creatives) expect(c.description.length).toBeLessThanOrEqual(30);
  });

  it('writes product ads without instant access, social proof or a guarantee', () => {
    const p = product();
    for (const objective of ['leads', 'sales'] as const) expect(adText(p, objective).text).not.toMatch(INVENTED);
    const titles = adText(p).r.search!.sitelinks.map((s) => s.title);
    expect(titles).toContain('Who It’s For');
    expect(titles).not.toContain('Free Download');
    p.marketing.leadMagnet = { id: 'lm', type: 'checklist', title: 'Quarterly Tax Checklist', subtitle: '', intro: '', sections: [], cta: '', optInHeadline: '', optInBullets: [], buttonLabel: '', createdAt: 1 };
    expect(adText(p).r.search!.sitelinks).toContainEqual({ title: 'Free Download', desc: 'Quarterly Tax Checklist' });
  });

  it('offers a free download in lead ads only when the owner made a lead magnet', () => {
    for (const p of [product(), business()]) {
      const { r, text } = adText(p, 'leads');
      expect(text).not.toMatch(/checklist|free download|this week/i);
      expect(r.creatives.map((c) => c.cta)).not.toContain('Download');
    }
    const p = product();
    p.marketing.leadMagnet = { id: 'lm', type: 'checklist', title: 'Quarterly Tax Checklist', subtitle: '', intro: '', sections: [], cta: '', optInHeadline: '', optInBullets: [], buttonLabel: '', createdAt: 1 };
    const { r, text } = adText(p, 'leads');
    expect(text).toContain('the free Quarterly Tax Checklist');
    expect(r.creatives[0].cta).toBe('Download');
  });

  it('mentions a guarantee only when the owner wrote one', () => {
    const p = business();
    expect(ownerGuarantee(p)).toBe('');
    p.studio.valueStack = [...p.studio.valueStack, { id: 'vs_g', kind: 'guarantee', title: 'Our promise', value: 0, description: 'Missed a spot? We come back within 48 hours.' }];
    expect(ownerGuarantee(p)).toBe('Missed a spot? We come back within 48 hours.');
    expect(adText(p).r.search!.sitelinks).toContainEqual({ title: 'Our Guarantee', desc: 'Missed a spot? We come back within…' });
  });
});

describe('the social plan claims no results', () => {
  it('writes key messages and topics without customer results, popularity or deadlines', () => {
    for (const p of [business(), product()]) {
      const plan = generateCampaignPlan(p, defaultCampaign());
      const weeks = plan.weeks.map((w) => `${w.goal} ${w.keyMessage}`).join(' ');
      expect(weeks).not.toMatch(/getting results|fastest|ends soon|urgency|launch offer/i);
      expect(plan.weeks[2].keyMessage).toBe(`Here is how ${p.brand.name} works, and who is behind it.`);
      const topics = plan.days.flatMap((d) => d.slots.map((s) => s.topic)).join(' | ');
      expect(topics).not.toMatch(/customer spotlight|last chance|launch bonus|launch offer/i);
    }
  });
});

describe('captions and niche data invent no stories, results or perks', () => {
  it('writes story hooks without made-up customer anecdotes or social proof', () => {
    for (const p of [business(), product()]) {
      const f = buildFacts(p);
      for (let seed = 0; seed < 60; seed++) {
        const v = Voice.create(f, { hookStyle: 'story' }, seed);
        const hook = v.hook('ad');
        expect(hook).not.toMatch(/last (week|month)|told (me|us)|what happened|neighbor|everyone keeps recommending|it ends well|how it ended/i);
        const pov = Voice.create(f, { hookStyle: 'pov' }, seed).hook('ad');
        expect(pov).not.toMatch(/everyone keeps recommending/i);
        const ctas = [v.cta('comment'), v.cta('optin')].join(' ');
        expect(ctas).not.toMatch(/checklist/i);
      }
    }
  });

  it('promises no results on a timeline in generic outcomes', () => {
    const g = genericNiche('Underwater basket weaving', 'Basket weaving');
    expect(g.outcomes.join(' ')).not.toMatch(/\b\d+ days\b|consistent results/);
    expect(anchoredOutcomes('baking').join(' ')).not.toMatch(/\d+ days/);
    expect(g).not.toHaveProperty('demand');
    expect(g).not.toHaveProperty('competition');
    for (const fm of Object.values(FORMATS)) {
      expect(fm).not.toHaveProperty('scalability');
      expect(fm).not.toHaveProperty('volume');
    }
  });

  it('keeps niche terms and delivery standards free of promises', () => {
    const terms = NICHES.flatMap((n) => n.terms).join(' | ');
    expect(terms).not.toMatch(/free estimate|licensed and insured|same-day service|warranty/i);
    const delivery = BUSINESS_TYPES.flatMap((t) => [...t.delivery, ...t.bonuses]).join(' | ');
    expect(delivery).not.toMatch(/after 7 days|every 6 weeks|Hot towel finish|Monthly performance report|Priority Slack channel/);
  });
});

/** Result/time promises, implied testimonials and product descriptions the owner never wrote. */
const PROMISED = /takes (5|five|about five) minutes|fastest way|the exact steps|10-minute|faster than you expect|within a few weeks|minutes, not hours|on autopilot|pays for itself|is fixable|templates, steps and support|step-by-step|easy to follow|official site|built for real life|proven|that convert|in 15 minutes|15-minute action plan|complete system|systems beat willpower|done-for-you/i;

describe('email copy promises nothing the owner didn’t say', () => {
  it('writes lead magnets and sequences without result or time promises', () => {
    for (const p of [product(), business()]) {
      for (const t of LEAD_MAGNET_TYPES) {
        const lm = generateLeadMagnet(p, t.id);
        expect(JSON.stringify(lm)).not.toMatch(PROMISED);
        for (const fw of [undefined, 'AIDA', 'BAB', 'StoryBrand'] as const) {
          for (let i = 0; i < 4; i++) {
            const all = JSON.stringify(generateEmailSequence(p, lm, { framework: fw }, i));
            expect(all).not.toMatch(PROMISED);
            expect(all).not.toMatch(INVENTED);
          }
        }
      }
    }
  });

  it('counts only the lead magnet’s real items in its title', () => {
    for (let i = 0; i < 6; i++) {
      const lm = generateLeadMagnet(product(), 'swipe', {}, i);
      const n = lm.sections.reduce((s, x) => s + x.items.length, 0);
      const m = lm.title.match(/\d+/);
      if (m) expect(Number(m[0])).toBe(n);
    }
  });

  it('marks the example as hypothetical and lists only what the product contains', () => {
    const p = product();
    const e = generateEmailSequence(p, null);
    expect(e[2].body).toContain('hypothetical example (not a real customer)');
    expect(e[4].body).toContain('[What’s included]');
    p.studio.outline = generateOutline(p).sections;
    const first = p.studio.outline[0].title.replace(/^(Module|Chapter|Section|Day|Week|Tab|Part) \d+:\s*/i, '').trim();
    const e5 = generateEmailSequence(p, null)[4].body;
    expect(e5).toContain(first);
    expect(e5).not.toContain('[What’s included]');
    expect(e5).toContain('[Anything else you include]');
  });

  it('books the owner’s own package, not a template tier', () => {
    const p = business();
    p.studio.packages = p.studio.packages.map((x, i) => ({ ...x, name: i === 0 ? 'Basic Clean' : x.name }));
    expect(generateEmailSequence(p, null)[4].ctaLabel).toBe('Book your Basic Clean appointment');
    p.studio.packages = [];
    expect(generateEmailSequence(p, null)[4].ctaLabel).toBe('Book your first appointment');
  });
});

describe('ads describe the product without promising results', () => {
  it('says "Official Site" only when the owner has a website', () => {
    const p = business();
    expect(adText(p).r.search!.headlines.join(' ')).not.toMatch(/official site/i);
    p.brand.websiteUrl = 'https://summitcleaning.test';
    expect(adText(p).r.search!.headlines).toContain('Summit Cleaning Official Site');
  });

  it('frames the outcome as a question and describes contents only from the outline', () => {
    for (const p of [product(), business()]) {
      for (const objective of ['leads', 'sales'] as const) expect(adText(p, objective).text).not.toMatch(PROMISED);
    }
    const p = product();
    expect(adText(p).r.search!.descriptions[0]).not.toMatch(/covers/i);
    p.studio.outline = generateOutline(p).sections;
    const { r } = adText(p);
    expect(r.search!.descriptions[0]).toMatch(/Covers /);
    expect(r.creatives[1].headline).toMatch(/^Want to .*\?$|…$/);
    for (const d of r.search!.descriptions) expect(d.length).toBeLessThanOrEqual(90);
    for (const h of r.search!.headlines) expect(h.length).toBeLessThanOrEqual(30);
  });
});
