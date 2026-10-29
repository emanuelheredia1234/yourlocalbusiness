import type { AdCampaign, AdCreative, AdObjective, AdPlatform, AdProjection, AudienceSet, Directives, Project, SearchAd, StyleId } from '@/lib/types';
import { capitalize, clamp, createRng, hashStr, slugify, titleCase, truncate, uid } from '@/lib/utils';
import { buildFacts, verbOutcome, Voice, type Facts } from '../text';
import { primaryKeywordFor } from './seo';

export const AD_PLATFORMS: { id: AdPlatform; label: string; desc: string }[] = [
  { id: 'meta', label: 'Meta (Facebook + Instagram)', desc: 'Broad reach, great for visuals and retargeting' },
  { id: 'tiktok', label: 'TikTok Ads', desc: 'Cheap attention with short videos' },
  { id: 'google', label: 'Google Search', desc: 'Capture people already searching' },
  { id: 'linkedin', label: 'LinkedIn Ads', desc: 'Precise B2B targeting by role and industry' },
];

export const AD_OBJECTIVES: { id: AdObjective; label: string; desc: string }[] = [
  { id: 'awareness', label: 'Awareness', desc: 'Reach as many of the right people as possible' },
  { id: 'traffic', label: 'Traffic', desc: 'Send visitors to your sales page or store' },
  { id: 'leads', label: 'Leads', desc: 'Grow your list with the free lead magnet' },
  { id: 'sales', label: 'Sales & bookings', desc: 'Drive purchases or bookings' },
];

const BENCH: Record<AdPlatform, { cpm: [number, number]; ctr: [number, number]; cpc?: [number, number] }> = {
  meta: { cpm: [9, 14], ctr: [0.011, 0.017] },
  tiktok: { cpm: [6, 10], ctr: [0.009, 0.015] },
  google: { cpm: [30, 60], ctr: [0.035, 0.06], cpc: [1.4, 3.6] },
  linkedin: { cpm: [32, 48], ctr: [0.004, 0.007] },
};

export function projectAds(c: Pick<AdCampaign, 'platforms' | 'dailyBudget' | 'durationDays' | 'objective' | 'seed'>, f: Facts): AdProjection {
  const rng = createRng(c.seed || 7);
  const platforms = c.platforms.length ? c.platforms : (['meta'] as AdPlatform[]);
  const spend = Math.max(0, c.dailyBudget) * Math.max(1, c.durationDays);
  const per = spend / platforms.length;
  let impressions = 0;
  let clicks = 0;
  for (const p of platforms) {
    const b = BENCH[p];
    const mult = f.niche.priceMult > 1.5 ? 1.25 : f.local ? 0.9 : 1;
    if (p === 'google' && b.cpc) {
      const cpc = rng.float(b.cpc[0], b.cpc[1]) * mult;
      const k = per / cpc;
      clicks += k;
      impressions += k / rng.float(b.ctr[0], b.ctr[1]);
    } else {
      const cpm = rng.float(b.cpm[0], b.cpm[1]) * mult;
      const imp = (per / cpm) * 1000;
      impressions += imp;
      clicks += imp * rng.float(b.ctr[0], b.ctr[1]) * (c.objective === 'awareness' ? 0.7 : 1);
    }
  }
  const cvr =
    c.objective === 'leads'
      ? rng.float(0.09, 0.16)
      : c.objective === 'sales'
        ? f.track === 'business'
          ? rng.float(0.035, 0.07)
          : clamp(0.045 - f.price / 6000, 0.008, 0.045)
        : c.objective === 'traffic'
          ? rng.float(0.01, 0.025)
          : rng.float(0.004, 0.01);
  const conversions = clicks * cvr;
  const value = c.objective === 'leads' ? f.price * 0.12 : f.price;
  const revenue = conversions * value;
  return {
    spend: Math.round(spend),
    impressions: Math.round(impressions),
    reach: Math.round(impressions / 1.9),
    ctr: impressions ? clicks / impressions : 0,
    cpc: clicks ? spend / clicks : 0,
    clicks: Math.round(clicks),
    cvr,
    conversions: Math.round(conversions * 10) / 10,
    cpa: conversions ? spend / conversions : 0,
    roas: spend ? revenue / spend : 0,
  };
}

export function suggestInterests(f: Facts): string[] {
  const fromTags = f.hashtags.map((h) => titleCase(h.replace('#', '').replace(/([a-z])([A-Z])/g, '$1 $2')));
  const base = [f.nicheLabel, f.topic, ...f.terms.slice(0, 3).map(titleCase), ...f.audiences.slice(0, 2).map(titleCase), ...fromTags.slice(0, 3)];
  return [...new Set(base.filter((x) => x && x.length < 32))].slice(0, 10);
}

const HOOK_STOP = new Set(['and', 'or', 'with', 'to', 'of', 'for', 'in', 'on', 'at', 'the', 'a', 'an', 'your', 'that', 'who', 'every']);

/** "No more …" headline from a pain phrase, cut on a word boundary without a dangling connector. */
function painHook(pain: string, max: number): string {
  const words = pain.replace(/^(a|an|the)\s+/i, '').split(/\s+/);
  while (words.length > 1) {
    const text = `No more ${words.join(' ')}`;
    if (text.length <= max && !HOOK_STOP.has(words[words.length - 1].toLowerCase())) return text;
    words.pop();
  }
  return truncate(`No more ${pain}`, max);
}

export interface AdsResult {
  audiences: AudienceSet[];
  interests: string[];
  creatives: AdCreative[];
  search: SearchAd | null;
  projections: AdProjection;
}

export function generateAds(project: Project, c: AdCampaign, d: Directives = {}, variation = 0): AdsResult {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|ads|${variation}|${c.objective}`));
  const rng = v.rng;
  const interests = c.interests.length ? c.interests : suggestInterests(f);
  const where = f.local && f.city ? `${c.radiusMi || 10} mi around ${f.city}${f.region ? `, ${f.region}` : ''}` : c.locations || 'United States';
  const audiences: AudienceSet[] = [
    { id: uid('aud'), name: f.local ? 'Local core audience' : 'Core interest audience', description: `Ages ${c.ageMin}–${c.ageMax} · ${where} · interested in ${interests.slice(0, 3).join(', ')}`, size: f.local ? '40K–90K' : '1.2M–2.4M', interests: interests.slice(0, 6) },
    { id: uid('aud'), name: 'Warm retargeting', description: 'Website visitors (30 days), video viewers 50%+, Instagram & Facebook engagers (60 days)', size: '2K–12K', interests: ['Website visitors', 'Video viewers', 'Page engagers'] },
    { id: uid('aud'), name: f.local ? 'Lookalike: past customers (local)' : 'Lookalike 1–3%: buyers & subscribers', description: `Seeded from ${f.track === 'business' ? 'customer list' : 'purchasers and email subscribers'}`, size: f.local ? '25K–60K' : '2M–6M', interests: ['Lookalike'] },
  ];
  const cta: Record<AdObjective, string> =
    f.track === 'business'
      ? { awareness: 'Learn More', traffic: 'Learn More', leads: 'Get Quote', sales: 'Book Now' }
      : { awareness: 'Learn More', traffic: 'Learn More', leads: 'Download', sales: 'Shop Now' };
  const outcome = verbOutcome(f.outcomes[0]);
  const lm = f.leadMagnet || `${f.topic} checklist`;
  const offer = c.objective === 'leads' ? `the free ${lm}` : f.productShort;
  const angles = [
    {
      variant: 'A',
      angle: 'Pain → fix',
      primaryText: `${capitalize(f.pain)}? ${c.objective === 'leads' ? `Grab ${offer} and fix it this week.` : `${f.productShort} helps ${f.audience} ${outcome}.`}${v.ee('point')}`,
      headline: painHook(f.pain, 40),
      description: c.objective === 'leads' ? 'Free instant download' : f.track === 'business' ? 'Free estimates' : `${f.priceStr}${f.priceSuffix} · Instant access`,
    },
    {
      variant: 'B',
      angle: 'Outcome first',
      primaryText: `Imagine being able to ${outcome}. ${c.objective === 'leads' ? `Start with ${offer}, free.` : `That’s what ${f.productShort} is built for.`}`,
      headline: truncate(capitalize(outcome), 40),
      description: truncate(f.tagline || `Built for ${f.audience}`, 30),
    },
    {
      variant: 'C',
      angle: 'Curiosity + specificity',
      primaryText: `The ${f.topicLower} ${f.track === 'business' ? 'service' : 'system'} ${f.audience} are switching to. ${capitalize(f.quickWins[0])} is step one.`,
      headline: truncate(f.track === 'business' && f.city ? `${f.city}’s ${f.business?.label.split(/[&,]/)[0].trim()}` : f.productShort, 40),
      description: truncate(v.pick(['See how it works', 'Takes 2 minutes', 'Built for real life']), 30),
    },
  ];
  const styles: StyleId[] = c.platforms.includes('tiktok') ? ['ugc', 'minimal', 'kinetic'] : ['minimal', 'neon', 'editorial'];
  const creatives: AdCreative[] = angles.map((a, i) => ({
    id: uid('cr'),
    variant: a.variant,
    angle: a.angle,
    primaryText: a.primaryText,
    headline: a.headline,
    description: a.description,
    cta: cta[c.objective],
    style: styles[i % styles.length],
    format: ['ugc', 'kinetic', 'split', 'cinematic', 'talking'].includes(styles[i % styles.length]) ? 'video' : 'image',
    visualHeadline: truncate(i === 0 ? painHook(f.pain, 48) : i === 1 ? capitalize(outcome) : f.productShort, 48),
  }));

  let search: SearchAd | null = null;
  if (c.platforms.includes('google')) {
    const kw = primaryKeywordFor(f);
    const h = [
      truncate(titleCase(kw), 30),
      truncate(`${f.brand} Official Site`, 30),
      truncate(capitalize(outcome), 30),
      f.track === 'business' ? truncate(`Free Estimates · ${f.city || 'Local'}`, 30) : truncate(`Only ${f.priceStr}${f.priceSuffix}`, 30),
      truncate(f.track === 'business' ? 'Book Online in 60 Seconds' : 'Instant Access · Start Today', 30),
      truncate(`Built for ${titleCase(f.audience)}`, 30),
    ];
    search = {
      headlines: [...new Set(h)].slice(0, 6),
      descriptions: [
        truncate(`${capitalize(outcome)} without ${f.pain}. ${f.track === 'business' ? 'Upfront pricing, friendly pros.' : 'Practical, step-by-step and easy to follow.'}`, 90),
        truncate(`Trusted by ${f.audience}. ${f.track === 'business' ? `Serving ${f.city || 'your area'}. Book today.` : 'Get started in minutes. 30-day guarantee.'}`, 90),
      ],
      path: slugify(kw).split('-').slice(0, 2).map((p) => p.slice(0, 15)),
      keywords: [`[${kw}]`, `"${kw}"`, ...f.terms.slice(0, 2).map((t) => `"${t} ${f.topicLower}"`), f.local && f.city ? `"${f.topicLower} ${f.city.toLowerCase()}"` : `"best ${f.topicLower}"`],
      sitelinks: f.track === 'business'
        ? [
            { title: 'Services & Pricing', desc: 'See packages and prices' },
            { title: 'Book Online', desc: 'Pick a time that suits you' },
            { title: 'Reviews', desc: 'What neighbors say' },
            { title: 'About Us', desc: 'Local, licensed & insured' },
          ]
        : [
            { title: 'What’s Inside', desc: `Tour ${truncate(f.productShort, 20)}` },
            { title: 'Free Checklist', desc: 'Start with a free download' },
            { title: 'FAQ', desc: 'Answers to common questions' },
            { title: 'Pricing', desc: `${f.priceStr}${f.priceSuffix}` },
          ],
    };
  }
  const seed = c.seed || rng.int(1, 1_000_000);
  return { audiences, interests, creatives, search, projections: projectAds({ ...c, seed }, f) };
}

export function newAdCampaign(project: Project): AdCampaign {
  const f = buildFacts(project);
  const seed = hashStr(project.id + Date.now());
  const base: AdCampaign = {
    id: uid('ad'),
    projectId: project.id,
    name: `${f.productShort} · ${f.track === 'business' ? 'Bookings' : 'Launch'}`,
    objective: f.track === 'business' ? 'sales' : project.marketing.leadMagnet ? 'leads' : 'sales',
    platforms: f.niche.priceMult > 1.5 && !f.local ? ['linkedin', 'google'] : ['meta', 'google'],
    dailyBudget: f.local ? 25 : 40,
    durationDays: 14,
    startDate: new Date().toISOString().slice(0, 10),
    status: 'draft',
    locations: f.local && f.city ? `${f.city}${f.region ? `, ${f.region}` : ''}` : 'United States',
    radiusMi: 10,
    ageMin: 25,
    ageMax: 54,
    interests: [],
    audiences: [],
    creatives: [],
    selectedCreativeIds: [],
    search: null,
    projections: { spend: 0, impressions: 0, reach: 0, ctr: 0, cpc: 0, clicks: 0, cvr: 0, conversions: 0, cpa: 0, roas: 0 },
    createdAt: Date.now(),
    seed,
  };
  return { ...base, projections: projectAds(base, f) };
}
