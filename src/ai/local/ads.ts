import type { AdCampaign, AdCreative, AdObjective, AdPlatform, AudienceSet, Directives, Project, SearchAd, StyleId } from '@/lib/types';
import { capitalize, hashStr, slugify, titleCase, truncate, uid } from '@/lib/utils';
import { buildFacts, verbOutcome, Voice, type Facts } from '../text';
import { primaryKeywordFor } from './seo';
import { CLAIM_TERM, ownerGuarantee } from './studio';

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

export function suggestInterests(f: Facts): string[] {
  const fromTags = f.hashtags.map((h) => titleCase(h.replace('#', '').replace(/([a-z])([A-Z])/g, '$1 $2')));
  const base = [f.nicheLabel, f.topic, ...f.terms.slice(0, 3).map(titleCase), ...f.audiences.slice(0, 2).map(titleCase), ...fromTags.slice(0, 3)];
  return [...new Set(base.filter((x) => x && x.length < 32))].slice(0, 10);
}

const HOOK_STOP = new Set(['and', 'or', 'with', 'to', 'of', 'for', 'in', 'on', 'at', 'the', 'a', 'an', 'your', 'that', 'who', 'every']);

/** "Tired of …?" headline from a pain phrase, cut on a word boundary without a dangling connector. It names the
 *  pain as a question; it never says the pain goes away ("No more …"), which the owner hasn't promised. */
function painHook(pain: string, max: number): string {
  const words = pain.replace(/^(a|an|the)\s+/i, '').split(/\s+/);
  while (words.length > 1) {
    const text = `Tired of ${words.join(' ')}?`;
    if (text.length <= max && !HOOK_STOP.has(words[words.length - 1].toLowerCase())) return text;
    words.pop();
  }
  return `${truncate(`Tired of ${words[0] ?? pain}`, max - 1)}?`;
}

export interface AdsResult {
  audiences: AudienceSet[];
  interests: string[];
  creatives: AdCreative[];
  search: SearchAd | null;
}

export function generateAds(project: Project, c: AdCampaign, d: Directives = {}, variation = 0): AdsResult {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|ads|${variation}|${c.objective}`));
  const interests = c.interests.length ? c.interests : suggestInterests(f);
  const where = f.local && f.city ? `${c.radiusMi || 10} mi around ${f.city}${f.region ? `, ${f.region}` : ''}` : c.locations || 'United States';
  const audiences: AudienceSet[] = [
    { id: uid('aud'), name: f.local ? 'Local core audience' : 'Core interest audience', description: `Ages ${c.ageMin}–${c.ageMax} · ${where} · interested in ${interests.slice(0, 3).join(', ')}`, interests: interests.slice(0, 6) },
    { id: uid('aud'), name: 'Warm retargeting', description: 'Website visitors (30 days), video viewers 50%+, Instagram & Facebook engagers (60 days)', interests: ['Website visitors', 'Video viewers', 'Page engagers'] },
    { id: uid('aud'), name: f.local ? 'Lookalike: past customers (local)' : 'Lookalike 1–3%: buyers & subscribers', description: `Seeded from ${f.track === 'business' ? 'customer list' : 'purchasers and email subscribers'}`, interests: ['Lookalike'] },
  ];
  const cta: Record<AdObjective, string> =
    f.track === 'business'
      ? { awareness: 'Learn More', traffic: 'Learn More', leads: 'Get Quote', sales: 'Book Now' }
      : { awareness: 'Learn More', traffic: 'Learn More', leads: f.leadMagnet ? 'Download' : 'Sign Up', sales: 'Shop Now' };
  const outcome = verbOutcome(f.outcomes[0]);
  // A free download is offered only when the owner actually made a lead magnet; otherwise the CTA stays neutral.
  const lm = f.leadMagnet?.trim() || '';
  const leads = c.objective === 'leads';
  const offer = leads && lm ? `the free ${lm}` : f.productShort;
  // No reviews, "trusted by", licensing, free estimates, instant delivery or guarantees unless the owner has them:
  // the copy sticks to the owner's own facts (city, price, format, booking type, a guarantee they wrote).
  const isBiz = f.track === 'business';
  const guarantee = ownerGuarantee(project);
  const booking = project.studio.listing.bookingType;
  const serving = f.city ? `Serving ${f.city}` : '';
  // the outcome is framed as a question or as what the product is about, never as a promised result
  const outcomeQ = `Want to ${outcome}?`;
  // what the product contains, only from the owner's outline (never a made-up "step-by-step, easy to follow")
  const sections = project.studio.outline.map((s) => s.title.replace(/^(Module|Chapter|Section|Day|Week|Tab|Part) \d+:\s*/i, '').trim()).filter(Boolean);
  const covers = sections.length ? `Covers ${sections.slice(0, 3).join(', ')}.` : '';
  // what the product is, in the owner's own terms
  const whatNoun = isBiz ? `${f.topicLower} service` : f.formatNoun.replace(/^[A-Z](?![A-Z])/, (x) => x.toLowerCase());
  const what = `${/^[aeiou]/i.test(whatNoun) ? 'an' : 'a'} ${whatNoun}`;
  const angles = [
    {
      variant: 'A',
      angle: 'Pain point',
      primaryText: `${capitalize(f.pain)}? ${leads ? (lm ? `Grab ${offer} to get started.` : isBiz ? `Request a quote from ${f.brand}.` : `Join the list to hear from ${f.productShort}.`) : `${f.productShort} is made for ${f.audience} who want to ${outcome}.`}${v.ee('point')}`,
      headline: painHook(f.pain, 40),
      description: truncate(leads ? (lm ? 'Free download' : isBiz ? 'Request a quote' : 'Sign up for updates') : isBiz ? serving || 'Get in touch today' : `${f.priceStr}${f.priceSuffix} · ${f.formatNoun}`, 30),
    },
    {
      variant: 'B',
      angle: 'Outcome first',
      primaryText: `${outcomeQ} ${leads && lm ? `Start with ${offer}, free.` : `${f.productShort} is ${what} for ${f.audience}.`}`,
      headline: truncate(outcomeQ, 40),
      description: truncate(f.tagline || `Built for ${f.audience}`, 30),
    },
    {
      variant: 'C',
      angle: 'Curiosity + specificity',
      primaryText: `${/^[aeiou]/i.test(f.topicLower) ? 'An' : 'A'} ${f.topicLower} ${isBiz ? 'service' : whatNoun} made for ${f.audience}. A good first step: ${f.quickWins[0]}.`,
      // "{Label} in {City}", not "{City}'s {Label}", which reads as the city's one provider
      headline: truncate(isBiz && f.city && f.business ? `${f.business.label.split(/[&,]/)[0].trim()} in ${f.city}` : f.productShort, 40),
      description: truncate(v.pick(['See how it works', 'See what’s included']), 30),
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
    visualHeadline: truncate(i === 0 ? painHook(f.pain, 48) : i === 1 ? outcomeQ : f.productShort, 48),
  }));

  let search: SearchAd | null = null;
  if (c.platforms.includes('google')) {
    const kw = primaryKeywordFor(f);
    const bookLabel = booking === 'inquire' ? 'Request a Quote' : booking === 'buy' ? 'Order Today' : 'Book an Appointment';
    const h = [
      truncate(titleCase(kw), 30),
      // "Official Site" only when the owner actually has a website
      ...(f.url ? [truncate(`${f.brand} Official Site`, 30)] : []),
      truncate(outcomeQ, 30),
      isBiz ? truncate(serving || titleCase(f.business?.label ?? 'Local Service'), 30) : truncate(`Only ${f.priceStr}${f.priceSuffix}`, 30),
      truncate(isBiz ? bookLabel : 'See What’s Inside', 30),
      truncate(`Built for ${titleCase(f.audience)}`, 30),
    ];
    const guaranteeLink = guarantee ? [{ title: 'Our Guarantee', desc: truncate(guarantee, 35) }] : [];
    search = {
      headlines: [...new Set(h)].slice(0, 6),
      descriptions: [
        truncate(isBiz ? `${f.brand}: ${f.topicLower} for ${f.audience}. See our services and prices.` : covers ? `${covers} Made for ${f.audience}.` : `${f.productShort}: for ${f.audience} who want to ${outcome}.`, 90),
        truncate(isBiz ? `${f.brand} serves ${f.city || 'your area'}. ${booking === 'inquire' ? 'Request a quote' : booking === 'buy' ? 'Order' : 'Book'} today.` : `Made for ${f.audience}. See what’s inside and get started today.`, 90),
      ],
      path: slugify(kw).split('-').slice(0, 2).map((p) => p.slice(0, 15)),
      // no keywords that promise what the owner hasn't said ("licensed and insured …", "free estimate …")
      keywords: [`[${kw}]`, `"${kw}"`, ...f.terms.filter((t) => !CLAIM_TERM.test(t)).slice(0, 2).map((t) => `"${t} ${f.topicLower}"`), f.local && f.city ? `"${f.topicLower} ${f.city.toLowerCase()}"` : `"best ${f.topicLower}"`],
      sitelinks: isBiz
        ? [
            { title: 'Services & Pricing', desc: 'See packages and prices' },
            booking === 'inquire' ? { title: 'Request a Quote', desc: 'Tell us what you need' } : { title: 'Book a Time', desc: 'Pick a time that suits you' },
            { title: 'About Us', desc: truncate(serving || `Get to know ${f.brand}`, 35) },
            { title: 'Contact Us', desc: 'Questions? Get in touch' },
            ...guaranteeLink,
          ]
        : [
            { title: 'What’s Inside', desc: `Tour ${truncate(f.productShort, 20)}` },
            f.leadMagnet ? { title: 'Free Download', desc: truncate(f.leadMagnet, 35) } : { title: 'Who It’s For', desc: truncate(`Made for ${f.audience}`, 35) },
            { title: 'FAQ', desc: 'Answers to common questions' },
            { title: 'Pricing', desc: `${f.priceStr}${f.priceSuffix}` },
            ...guaranteeLink,
          ],
    };
  }
  return { audiences, interests, creatives, search };
}

export function newAdCampaign(project: Project): AdCampaign {
  const f = buildFacts(project);
  return {
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
    createdAt: Date.now(),
  };
}
