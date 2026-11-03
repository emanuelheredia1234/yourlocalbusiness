import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { AdCampaign, CampaignPlan, Listing, Project } from '@/lib/types';
import { matchBusinessType } from '@/ai/knowledge';
import { OLD_OUTCOMES, purgeAdClaims, purgeClaims, purgeListingClaims } from './claims';

const bt = matchBusinessType('Home Cleaning');
const GUARANTEE = bt.guarantee; // '100% satisfaction: if anything is missed, we come back within 24 hours and re-clean it free.'

/** A cleaning business as older versions saved it, with the template's hours, guarantee and values filled in. */
function oldProject(): Project {
  const p = newProject('business', 'new');
  p.businessType = 'Home Cleaning';
  p.niche = 'Home Cleaning';
  p.brand.name = 'Summit Cleaning';
  p.location = { city: 'Austin', region: 'TX' };
  p.studio.listing = {
    ...p.studio.listing,
    title: 'Summit Cleaning',
    bookingType: 'book',
    hours: bt.hours,
    tags: ['home cleaning', 'free estimate', 'licensed and insured', 'service area', 'austin'],
    description: ['Summit Cleaning serves Austin, TX with home cleaning that homeowners can count on.', '', 'What you get:', '• Pre-visit checklist confirmed with the client', '• 24-hour re-clean promise for missed spots', '', GUARANTEE].join('\n'),
  };
  p.studio.packages = [
    { id: 'pkg_1', name: 'Fresh Start', price: 150, priceModel: 'per-session', description: 'The essentials, done right.', includes: ['Standard Clean (2–3 hrs)'] },
    { id: 'pkg_2', name: 'Deep Refresh', price: 270, priceModel: 'per-session', description: 'Our most popular option: everything you need for a calm home.', includes: ['Deep Clean (4–6 hrs)', '24-hour re-clean promise for missed spots'], popular: true },
    { id: 'pkg_3', name: 'Spotless Plus', price: 465, priceModel: 'project', description: 'White-glove service.', includes: ['Move-In / Move-Out Clean', 'Priority scheduling', '100% satisfaction'] },
  ];
  p.studio.valueStack = [
    { id: 'vs_1', kind: 'core', title: 'Deep Refresh package', value: Math.round(270 * 1.25), description: 'Our core clean.' },
    { id: 'vs_2', kind: 'bonus', title: bt.bonuses[0], value: 49, description: 'Removes the next obstacle for homeowners.' },
    { id: 'vs_3', kind: 'bonus', title: bt.bonuses[1], value: 79, description: 'Removes the next obstacle.' },
    { id: 'vs_4', kind: 'guarantee', title: 'Our promise', value: 0, description: GUARANTEE },
  ];
  p.studio.operating = [{ id: 'op_1', title: 'Hours & capacity', items: [bt.hours, 'Target capacity: ~27 appointments or jobs per week', 'Service area: Austin, TX and nearby neighborhoods'] }];
  const plan: CampaignPlan = {
    id: 'plan_1',
    createdAt: 1,
    startDate: '2026-01-01',
    strategy: 'A plan.',
    weeks: [
      { week: 1, theme: 'Awareness: name the problem', goal: 'Make homeowners feel seen.', kpi: 'Reach', keyMessage: 'Weekends lost to scrubbing is common and fixable.' },
      { week: 3, theme: 'Trust: proof & community', goal: 'Show real people, process and results.', kpi: 'Comments', keyMessage: 'People like you are already getting results with Summit Cleaning.' },
      { week: 4, theme: 'Conversion: open the offer', goal: 'Drive bookings of Summit Cleaning.', kpi: 'Clicks', keyMessage: 'Summit Cleaning is the fastest way to come home to a spotless house.' },
      { week: 5, theme: 'Final push & recap', goal: 'Create urgency and recap the month.', kpi: 'Conversions', keyMessage: 'The launch offer ends soon.' },
    ],
    days: [
      {
        date: '2026-01-20',
        dayIndex: 19,
        week: 3,
        phase: 'Trust',
        posting: true,
        slots: [
          { id: 's1', time: '09:00', platform: 'instagram', format: 'image', style: 'minimal', postType: 'bts', topic: 'Customer spotlight: a homeowner’s win' },
          { id: 's2', time: '12:00', platform: 'facebook', format: 'image', style: 'minimal', postType: 'sales', topic: 'Summit Cleaning: launch offer' },
          { id: 's3', time: '17:00', platform: 'facebook', format: 'image', style: 'minimal', postType: 'sales', topic: 'Last chance: launch bonus ends soon' },
          { id: 's4', time: '19:00', platform: 'instagram', format: 'image', style: 'minimal', postType: 'tip', topic: 'Clean top to bottom' },
        ],
      },
    ],
    summary: { total: 4, videos: 0, images: 4, byType: { educational: 0, tip: 1, question: 0, sales: 2, bts: 1 }, byPlatform: { instagram: 2, facebook: 2 } },
  };
  p.marketing.plan = plan;
  return p;
}

function oldListing(): Listing {
  return {
    id: 'lst_1',
    kind: 'business',
    title: 'Summit Cleaning',
    tagline: 'Home Cleaning in Austin',
    description: ['Summit Cleaning serves Austin.', '', 'What you get:', '• Room-by-room cleaning standard', '', GUARANTEE].join('\n'),
    price: 270,
    priceModel: 'per-session',
    seller: { name: 'Summit Cleaning' },
    category: 'Home Services',
    tags: ['cleaning', 'licensed and insured'],
    hours: bt.hours,
    includes: ['Deep Clean (4–6 hrs)', '24-hour re-clean promise for missed spots', 'Free fridge clean-out on the first visit'],
    cover: { colors: ['#000', '#111', '#222'], icon: 'sparkles', pattern: 'dots' },
    createdAt: 1,
    origin: 'mine',
    projectId: 'proj_1',
  } as Listing;
}

function oldAd(): AdCampaign {
  return {
    id: 'ad_1',
    projectId: 'proj_1',
    name: 'Summit Cleaning · Bookings',
    objective: 'sales',
    platforms: ['meta', 'google'],
    dailyBudget: 25,
    durationDays: 14,
    startDate: '2026-01-01',
    status: 'draft',
    locations: 'Austin, TX',
    radiusMi: 10,
    ageMin: 25,
    ageMax: 54,
    interests: [],
    audiences: [],
    creatives: [
      { id: 'cr_1', variant: 'A', angle: 'Pain → fix', primaryText: 'Weekends lost to scrubbing?', headline: 'No more scrubbing', description: 'Free estimates', cta: 'Book Now', style: 'minimal', format: 'image', visualHeadline: 'No more scrubbing' },
      { id: 'cr_2', variant: 'C', angle: 'Curiosity + specificity', primaryText: 'The home cleaning service homeowners are switching to. Declutter first is step one.', headline: 'Austin’s Home Cleaning', description: 'Takes 2 minutes', cta: 'Book Now', style: 'editorial', format: 'image', visualHeadline: 'Summit Cleaning' },
    ],
    selectedCreativeIds: [],
    search: {
      headlines: ['Home Cleaning Austin', 'Summit Cleaning Official Site', 'Free Estimates · Austin', 'Book Online in 60 Seconds'],
      descriptions: ['Come home to a spotless house without scrubbing. Upfront pricing, friendly pros.', 'Trusted by homeowners. Serving Austin. Book today.'],
      path: ['home', 'cleaning'],
      keywords: ['[home cleaning austin]'],
      sitelinks: [
        { title: 'Services & Pricing', desc: 'See packages and prices' },
        { title: 'Book Online', desc: 'Pick a time that suits you' },
        { title: 'Reviews', desc: 'What neighbors say' },
        { title: 'About Us', desc: 'Local, licensed & insured' },
      ],
    },
    createdAt: 1,
  };
}

describe('purgeClaims', () => {
  it('clears template hours and promises from the listing draft and asks the owner to review it', () => {
    const out = purgeClaims(oldProject())!;
    expect(out).not.toBeNull();
    const l = out.studio.listing;
    expect(l.hours).toBe('');
    expect(l.description).not.toContain(GUARANTEE);
    expect(l.description).not.toContain('re-clean promise');
    expect(l.description.endsWith('• Pre-visit checklist confirmed with the client')).toBe(true);
    expect(l.needsReview).toBe(true);
    expect(l.tags).toEqual(['home cleaning', 'service area', 'austin']);
  });

  it('removes the template guarantee and values from the business model', () => {
    const s = purgeClaims(oldProject())!.studio;
    // the bonus still carrying the template description is dropped; the one the owner reworded keeps its title, worth 0
    expect(s.valueStack.map((v) => [v.kind, v.value])).toEqual([
      ['core', 0],
      ['bonus', 0],
    ]);
    expect(s.valueStack[1].title).toBe(bt.bonuses[1]);
    expect(s.packages[1].includes).toEqual(['Deep Clean (4–6 hrs)']);
    expect(s.packages[1].description).toBe('The middle package: everything you need for a calm home.');
    expect(s.packages[1].popular).toBe(false);
    expect(s.packages[2].includes).toEqual(['Move-In / Move-Out Clean']);
    expect(s.operating[0].items).toEqual(['Opening hours: [your hours]', 'Weekly capacity: [how many jobs or appointments you can take]', 'Service area: Austin, TX']);
  });

  it('rewrites plan key messages and topics that claimed results or a deadline', () => {
    const plan = purgeClaims(oldProject())!.marketing.plan!;
    expect(plan.weeks.map((w) => w.keyMessage)).toEqual([
      'Weekends lost to scrubbing is common and fixable.',
      'Here is how Summit Cleaning works, and who is behind it.',
      'Summit Cleaning: what it is, who it’s for, and what it costs.',
      'Here is what’s included, and how to get it.',
    ]);
    expect(plan.weeks[1].goal).toBe('Show your process, the people behind it, and real customer words when you have them.');
    expect(plan.weeks[3].goal).toBe('Recap the month and remind people how to book.');
    expect(plan.days[0].slots.map((s) => s.topic)).toEqual(['What to expect from Summit Cleaning', 'Summit Cleaning: price and what’s included', 'Questions about Summit Cleaning, answered', 'Clean top to bottom']);
  });

  it('leaves what the owner wrote alone', () => {
    const p = oldProject();
    p.studio.listing = { ...p.studio.listing, hours: 'Mon–Fri 9am–5pm', tags: ['home cleaning', 'austin'], description: 'We clean Austin homes.\n\nIf we miss a spot, we come back next day.' };
    p.studio.packages = p.studio.packages.map((x) => ({ ...x, description: 'Mine.', includes: x.includes.filter((i) => i !== '100% satisfaction' && i !== 'Priority scheduling' && !i.includes('re-clean')) }));
    p.studio.valueStack = [
      { id: 'vs_1', kind: 'core', title: 'Deep Refresh package', value: 300, description: 'Our core clean.' },
      { id: 'vs_2', kind: 'bonus', title: 'My own bonus', value: 49, description: '' },
      { id: 'vs_4', kind: 'guarantee', title: 'Our promise', value: 0, description: 'Missed a spot? We come back free.' },
    ];
    p.studio.operating = [{ id: 'op_1', title: 'Hours & capacity', items: ['Mon–Fri 9–5', 'Target capacity: about 20 a week'] }];
    p.marketing.plan = null;
    expect(purgeClaims(p)).toBeNull();
  });

  it('changes nothing the second time', () => {
    const once = purgeClaims(oldProject())!;
    expect(purgeClaims(once)).toBeNull();
    expect(purgeClaims(newProject('business', 'new'))).toBeNull();
    expect(purgeClaims(newProject('product', 'new'))).toBeNull();
  });

  it('drops claim tags without asking for a review', () => {
    const p = newProject('business', 'new');
    p.studio.listing = { ...p.studio.listing, tags: ['plumbing', 'free estimate', 'licensed and insured'] };
    const l = purgeClaims(p)!.studio.listing;
    expect(l.tags).toEqual(['plumbing']);
    expect(l.needsReview).toBeUndefined();
  });

  it('removes the old product closing line', () => {
    const p = newProject('product', 'new');
    p.studio.listing = { ...p.studio.listing, description: 'A tracker for freelancers.\n\nWhat you get:\n• Built-in budgets\n\nInstant digital delivery. Lifetime updates included.' };
    const out = purgeClaims(p)!;
    expect(out.studio.listing.description).toBe('A tracker for freelancers.\n\nWhat you get:\n• Built-in budgets');
    expect(out.studio.listing.needsReview).toBe(true);
    expect(purgeClaims(out)).toBeNull();
  });
});

describe('purgeClaims: perks, the automatic "most popular" flag, service standards and outcomes', () => {
  /** A consulting business as the old generator saved it: 3 tiers, the 2nd flagged popular, perks and timed standards. */
  function oldConsulting(): Project {
    const p = newProject('business', 'new');
    p.businessType = 'Marketing Consulting';
    p.brand.name = 'Northwind Strategy';
    p.studio.packages = [
      { id: 'pkg_1', name: 'Starter', price: 900, priceModel: 'project', description: 'The essentials, done right. Ideal for founders trying Northwind Strategy for the first time.', includes: ['Strategy session', 'Kickoff workshop', 'Monthly performance report'] },
      { id: 'pkg_2', name: 'Growth', price: 1800, priceModel: 'monthly', description: 'Our most popular option: everything you need for steady growth.', includes: ['Monthly retainer', 'Weekly sprints with async updates', 'Quarterly strategy review', 'Priority Slack channel'], popular: true },
      { id: 'pkg_3', name: 'Scale', price: 3100, priceModel: 'monthly', description: 'White-glove, done-for-you service for clients who want the very best.', includes: ['Fractional CMO', 'Monthly performance report', 'Free competitor audit', 'Priority scheduling', 'Results in 90 days'] },
    ];
    p.studio.valueStack = [
      { id: 'vs_1', kind: 'core', title: 'Growth package', value: 2250, description: 'Our most popular option: everything you need for steady growth.' },
      { id: 'vs_2', kind: 'bonus', title: 'Priority Slack channel', value: 129, description: 'Removes the next obstacle for founders.' },
      { id: 'vs_3', kind: 'bonus', title: 'Free competitor audit', value: 49, description: 'Removes the next obstacle for founders.' },
    ];
    p.studio.operating = [
      { id: 'op_1', title: 'Service delivery standard', items: ['Kickoff workshop', 'Weekly sprints with async updates', 'Monthly performance report', 'Quarterly strategy review'] },
      { id: 'op_2', title: 'Team & roles', items: ['Owner / accountant', 'Licensed technicians', 'Project manager'] },
    ];
    p.studio.listing = { ...p.studio.listing, description: 'Northwind Strategy helps founders.\n\nWhat you get:\n• Kickoff workshop\n• Gallery delivered in 10 business days\n• Our own onboarding call' };
    p.marketing.plan = {
      id: 'plan_1',
      createdAt: 1,
      startDate: '2026-01-01',
      strategy: 'A plan.',
      weeks: [
        { week: 2, theme: 'Authority', goal: 'Show the steps to get a response within one business day.', kpi: 'Saves', keyMessage: 'There is a simple system.' },
        { week: 4, theme: 'Conversion', goal: 'Drive bookings of Northwind Strategy.', kpi: 'Clicks', keyMessage: 'Northwind Strategy is the fastest way to know exactly what to do next.' },
      ],
      days: [],
      summary: { total: 0, videos: 0, images: 0, byType: { educational: 0, tip: 0, question: 0, sales: 0, bts: 0 }, byPlatform: {} },
    } as CampaignPlan;
    return p;
  }

  it('drops perks and the automatic popular flag, and neutralizes old package descriptions', () => {
    const s = purgeClaims(oldConsulting())!.studio;
    expect(s.packages.map((x) => !!x.popular)).toEqual([false, false, false]);
    expect(s.packages[0].description).toBe('The starting package, for founders trying Northwind Strategy for the first time.');
    expect(s.packages[1].description).toBe('The middle package: everything you need for steady growth.');
    expect(s.packages[2].description).toBe('The most complete package, with the most included.');
    expect(s.packages[0].includes).toEqual(['Strategy session', 'Kickoff meeting', 'Performance report [how often]']);
    expect(s.packages[1].includes).toEqual(['Monthly retainer', 'Project work with updates: [how often]', 'Strategy review [how often]']);
    // owner-looking text stays, even when it is a claim: only the template's exact strings go
    expect(s.packages[2].includes).toEqual(['Fractional CMO', 'Performance report [how often]', 'Results in 90 days']);
    expect(s.valueStack).toHaveLength(1);
    expect(s.valueStack[0]).toMatchObject({ kind: 'core', value: 0, description: 'The middle package: everything you need for steady growth.' });
  });

  it('makes old service standards and credentialed roles neutral', () => {
    const out = purgeClaims(oldConsulting())!;
    expect(out.studio.operating[0].items).toEqual(['Kickoff meeting', 'Project work with updates: [how often]', 'Performance report [how often]', 'Strategy review [how often]']);
    expect(out.studio.operating[1].items).toEqual(['Owner / lead bookkeeper', 'Technicians', 'Project manager']);
    expect(out.studio.listing.description).toBe('Northwind Strategy helps founders.\n\nWhat you get:\n• Kickoff meeting\n• Edited online gallery: [how many images, how soon]\n• Our own onboarding call');
    expect(out.studio.listing.needsReview).toBe(true);
  });

  it('rewrites old outcome promises in the plan', () => {
    const weeks = purgeClaims(oldConsulting())!.marketing.plan!.weeks;
    expect(weeks[0].goal).toBe('Show the steps to get clear answers to your questions.');
    expect(weeks[1].keyMessage).not.toContain('know exactly what to do next');
    expect(weeks[1].keyMessage).toBe('Northwind Strategy: what it is, who it’s for, and what it costs.');
  });

  it('is idempotent', () => {
    const once = purgeClaims(oldConsulting())!;
    expect(purgeClaims(once)).toBeNull();
  });

  it('keeps a popular flag the owner set', () => {
    const p = oldConsulting();
    p.studio.packages = p.studio.packages.map((x, i) => ({ ...x, description: `Mine ${i}.`, includes: ['Strategy session'], popular: i === 1 }));
    p.studio.valueStack = [];
    p.studio.operating = [];
    p.studio.listing = { ...p.studio.listing, description: 'Ours.' };
    p.marketing.plan = null;
    expect(purgeClaims(p)).toBeNull();
    // a flag on a tier other than the old generator's, or with more or fewer than 3 tiers, is the owner's
    const q = oldConsulting();
    q.studio.packages = [q.studio.packages[1]];
    expect(purgeClaims(q)!.studio.packages[0].popular).toBe(true);
  });

  it('clears the flag that an earlier cleanup left on a rewritten "all-round" tier', () => {
    const p = oldConsulting();
    p.studio.packages[1] = { ...p.studio.packages[1], description: 'The all-round option: everything you need for steady growth.' };
    const pk = purgeClaims(p)!.studio.packages[1];
    expect(pk.popular).toBe(false);
    expect(pk.description).toBe('The middle package: everything you need for steady growth.');
  });

  it('has frozen tables that cannot feed themselves', () => {
    for (const [, to] of OLD_OUTCOMES) for (const [from] of OLD_OUTCOMES) expect(to.includes(from)).toBe(false);
  });
});

describe('purgeListingClaims', () => {
  it('clears template hours, the guarantee line and promise includes from a published listing', () => {
    const out = purgeListingClaims(oldListing())!;
    expect(out).not.toBeNull();
    expect(out).not.toHaveProperty('hours');
    expect(out.description).toBe('Summit Cleaning serves Austin.\n\nWhat you get:\n• Room-by-room cleaning standard');
    expect(out.includes).toEqual(['Deep Clean (4–6 hrs)']);
    expect(out.tags).toEqual(['cleaning']);
    expect(purgeListingClaims(out)).toBeNull();
  });

  it('keeps hours and text the owner wrote', () => {
    expect(purgeListingClaims({ ...oldListing(), hours: 'Mon–Fri 9am–5pm', description: 'Ours.', includes: ['Deep Clean'], tags: ['cleaning'] })).toBeNull();
  });
});

describe('purgeAdClaims', () => {
  it('strips review, licensing, free-estimate and "trusted by" claims', () => {
    const out = purgeAdClaims(oldAd())!;
    expect(out).not.toBeNull();
    const s = out.search!;
    expect(s.sitelinks.map((l) => l.title)).toEqual(['Services & Pricing', 'Book Online']);
    expect(s.headlines).toEqual(['Home Cleaning Austin', 'Summit Cleaning Official Site']);
    expect(s.descriptions).toEqual(['Come home to a spotless house without scrubbing. See our services and prices.', 'Serving Austin. Book today.']);
    expect(out.creatives.map((c) => c.description)).toEqual(['Get in touch today', 'See what’s included']);
    expect(out.creatives[1].primaryText).toBe('A home cleaning service made for homeowners. Declutter first is step one.');
    expect(purgeAdClaims(out)).toBeNull();
  });

  it('drops "Official Site" only when told the project has no website, and old outcome promises', () => {
    const a = oldAd();
    a.creatives = [{ ...a.creatives[0], headline: 'Come home to a spotless house every week', primaryText: 'Weekends lost? Summit Cleaning helps homeowners come home to a spotless house every week.' }];
    const kept = purgeAdClaims(a)!;
    expect(kept.search!.headlines).toContain('Summit Cleaning Official Site');
    expect(kept.creatives[0].headline).toBe('Come home to a clean house');
    expect(kept.creatives[0].primaryText).toBe('Weekends lost? Summit Cleaning helps homeowners come home to a clean house.');
    const out = purgeAdClaims(a, false)!;
    expect(out.search!.headlines).toEqual(['Home Cleaning Austin']);
    expect(purgeAdClaims(out, false)).toBeNull();
    expect(purgeAdClaims(kept)).toBeNull();
  });

  it('drops a product ad’s 30-day guarantee and leaves clean ads alone', () => {
    const a = oldAd();
    a.search = { ...a.search!, sitelinks: [], headlines: ['Only $29', 'Instant Access · Start Today'], descriptions: ['Trusted by freelancers. Get started in minutes. 30-day guarantee.', 'Trusted by busy freelancers who want calm money and fewer surprises at tax time every single…'] };
    a.creatives = [{ ...a.creatives[0], description: '$29 · Instant access' }];
    const out = purgeAdClaims(a)!;
    expect(out.search!.headlines).toEqual(['Only $29']);
    expect(out.search!.descriptions).toEqual(['Get started in minutes.']);
    expect(out.creatives[0].description).toBe('$29');
    expect(purgeAdClaims(out)).toBeNull();
    expect(purgeAdClaims({ ...oldAd(), search: null, creatives: [] })).toBeNull();
  });
});

describe('purgeClaims: offer key messages and service areas', () => {
  it('rewrites an earlier-migrated "built to help you" promise to the neutral offer message', () => {
    const p = oldProject();
    p.marketing.plan!.weeks = [{ week: 4, theme: 'Conversion', goal: 'Drive bookings.', kpi: 'Clicks', keyMessage: 'Summit Cleaning is built to help you come home to a spotless house.' }];
    const out = purgeClaims(p)!;
    expect(out.marketing.plan!.weeks[0].keyMessage).toBe('Summit Cleaning: what it is, who it’s for, and what it costs.');
  });

  it('drops only the template "and nearby neighborhoods" from a service area', () => {
    const p = oldProject();
    p.studio.operating = [{ id: 'op_1', title: 'Hours & capacity', items: ['Service area: Austin and nearby neighborhoods', 'Service area: Austin and Round Rock'] }];
    expect(purgeClaims(p)!.studio.operating[0].items).toEqual(['Service area: Austin', 'Service area: Austin and Round Rock']);
  });
});
