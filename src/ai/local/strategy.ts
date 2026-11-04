// The built-in engine for Strategy: free starter notes from the project's own details, labelled "Built-in
// guidance" (basis 'builtin'), never research. No numbers except the owner's own, no claims, no links; each
// generator's output goes through its section's normalizer like any AI answer, so the same rules hold.
// Pure, no React.
import type { CodeKind, PostPlatform, Project } from '@/lib/types';
import type { AssetsOut, ContentOut, OutreachOut, PlanOut, PromoteOut, ResearchOut, StepInputBase, StrategyAction, StrategyHas, StrategyInputs } from '@/lib/strategyTypes';
import { PAGE_TYPE_LABEL } from '@/lib/pageTypes';
import { ownerFacts } from '@/lib/strategy';
import { normalizeAssets, normalizeContent, normalizeOutreach, normalizePlan, normalizePromote, normalizeResearchOut, strategyNetworks, type NormCtx } from '@/lib/strategyNormalize';
import { lowerFirst } from '@/lib/utils';
import { FORMATS, PLATFORMS, matchBusinessType } from '../knowledge';
import { buildFacts } from '../text';
import { suggestTopics } from './social';
import { codeKindLabel } from './code';
import { BUILTIN_MIX, BUILTIN_WEEKS, ctaForPage, defaultLinkPlacement, goalForPage, recommendPageType } from './strategyDefaults';

export { recommendPageType, defaultLinkPlacement, PAGE_WHY, BUILTIN_MIX, BUILTIN_WEEKS } from './strategyDefaults';

const fullInputs = (o: Partial<StrategyInputs> = {}): StrategyInputs => ({ goal: o.goal ?? '', budget: o.budget ?? '', timePerWeek: o.timePerWeek ?? '', competitors: o.competitors ?? [], tried: o.tried ?? '', notes: o.notes ?? '' });

/** The context the built-in engine's output is normalized with: every point is 'builtin'. */
function ctxOf(p: Project, i: Pick<StepInputBase, 'owner' | 'networks'>): NormCtx {
  return { ns: new Set(), fallback: 'builtin', trustBasis: false, owner: ownerFacts(p, fullInputs(i.owner)), networks: i.networks?.length ? i.networks : strategyNetworks(p), project: p, pageType: recommendPageType(p).pageType };
}

/** Words the built-in notes use for this project. */
function words(p: Project) {
  const f = buildFacts(p);
  const bt = p.track === 'business' ? matchBusinessType(`${p.businessType} ${p.category} ${p.niche}`) : null;
  const typeLabel = (bt && bt.id !== 'service' ? bt.label : p.businessType || p.category || p.niche || 'business').trim();
  const type = typeLabel.toLowerCase() || 'business';
  const fmt = p.format ? FORMATS[p.format] : null;
  const format = (fmt?.short ?? 'product').toLowerCase();
  const niche = (p.niche || p.category || f.topicLower || 'your topic').trim();
  const audience = (p.brand.audience || f.audience || 'your customers').trim();
  return { f, bt, type, format, niche, audience, brand: p.brand.name || 'your business', city: p.location?.city ?? '', productShort: f.productShort };
}

const label = (net: PostPlatform) => PLATFORMS[net].label;

// ───────────── research: what to check yourself ─────────────

export function localResearch(p: Project, i: StepInputBase): ResearchOut {
  const w = words(p);
  const city = w.city || 'your area';
  const checks =
    p.track === 'business'
      ? [
          `Search “${w.type} near ${city}” on Google and Maps. Note who shows up first and what their profiles show: photos, booking links, how they reply to people.`,
          'Look at three similar businesses on Instagram and Facebook. Which posts get comments? Note the formats: videos, photos, tips.',
          'Ask your last few customers how they found you and what almost stopped them.',
          `Look in local Facebook groups and community boards for people asking for a ${w.type}.`,
          `Read the top search results for “${w.type} ${city}”: what do they offer first (a quote, a booking, packages)?`,
        ]
      : [
          `Search “${w.niche} ${w.format}” and read the first page: what do the top products promise?`,
          `Look at three creators in ${w.niche} on Instagram or TikTok. Which posts get comments? Note the formats.`,
          `Find where buyers ask about ${w.niche} (groups, forums, Reddit) and note the questions they repeat.`,
          `Look at marketplaces where people buy ${w.format}s and note what the best-placed listings show.`,
          'Ask a few people who match your audience what they would search for to find this.',
        ];
  return normalizeResearchOut(
    { summary: 'No research yet: these are things to check yourself. With an AI key that can search the web, Strategy looks them up for you, with a link to every source.', findings: [], checks },
    ctxOf(p, i),
  );
}

// ───────────── where to promote ─────────────

export function localPromote(p: Project, i: StepInputBase): PromoteOut {
  const w = words(p);
  const nets = i.networks?.length ? i.networks : strategyNetworks(p);
  const line = p.track === 'business' ? `${w.brand}: ${w.type}${w.city ? ` in ${w.city}` : ''} for ${w.audience}.` : `${w.brand}: a ${w.format} about ${w.niche} for ${w.audience}.`;
  const social = (net: PostPlatform, priority: 1 | 2) =>
    p.track === 'business'
      ? { name: label(net), channelType: 'social', platform: net, priority, why: `You chose ${label(net)} for your campaign. Show your work, answer questions and point people to your page.`, how: ['Post from your content pillars', 'Put your link where the link settings say', 'Reply to comments and messages'] }
      : { name: label(net), channelType: 'social', platform: net, priority, why: `Share useful tips from your ${w.format}, show what’s inside, and point people to your page.`, how: ['Post from your content pillars', 'Put your link where the link settings say', 'Reply to comments and messages'] };
  const channels =
    p.track === 'business'
      ? [
          { name: 'Google Business Profile', channelType: 'search', priority: 1, why: 'Make it easy for people nearby to find you on Google and Maps: a complete profile with photos and your booking or contact link.', how: ['Claim or create your profile', 'Add photos, hours and your booking or contact link', 'Reply to people who message you'] },
          social(nets[0], 1),
          ...(nets[1] ? [social(nets[1], 2)] : []),
          { name: 'Local groups and community boards', channelType: 'community', priority: 2, why: 'Neighbors ask for recommendations there. Be helpful first; share your page when the group’s rules allow it.', how: ['Find the groups your neighbors use', 'Answer questions helpfully', 'Share your page when the rules allow it'] },
          { name: 'Businesses that serve the same customers', channelType: 'partners', priority: 2, why: 'They can recommend you to people who already trust them. Email outreach has a first message.', how: ['List five businesses your customers also use', 'Send the partner email', 'Offer to recommend them back'] },
          ...(i.has?.listed ? [] : [{ name: 'The app’s Marketplace', channelType: 'marketplace', priority: 3, why: 'Publish your listing so people browsing the Marketplace can find you.', how: ['Open Listing & publish', 'Add photos and your booking or contact link'] }]),
        ]
      : [
          social(nets[0], 1),
          ...(nets[1] ? [social(nets[1], 2)] : []),
          { name: 'Search: your SEO page', channelType: 'search', priority: 2, why: 'Build your page around what buyers type into search, so it can be found.', how: ['Pick the words buyers would type', 'Answer their questions on your page'] },
          { name: 'Your email list', channelType: 'email', priority: 2, why: 'A free lead magnet turns visitors into subscribers you can email later.', how: ['Write your lead magnet', 'Write your welcome emails'] },
          { name: 'Communities where buyers ask questions', channelType: 'community', priority: 2, why: 'Answer questions helpfully; share your page only where the rules allow it.', how: ['Find where your buyers ask questions', 'Answer helpfully, without a pitch'] },
          { name: `Marketplaces for ${w.format}s`, channelType: 'marketplace', priority: 3, why: `List it where people already shop for ${w.format}s.`, how: ['Publish your listing', 'Add listing images'] },
          { name: 'Creators your buyers follow', channelType: 'partners', priority: 3, why: 'They can introduce you to their audience. Email outreach has a first message.', how: ['List a few creators your buyers follow', 'Send the collaboration email'] },
        ];
  const rec = recommendPageType(p);
  return normalizePromote(
    {
      positioning: { line, who: w.audience, why: 'From your project details. Sharpen it in your own words.' },
      channels,
      page: rec,
      links: Object.fromEntries(nets.map((n) => [n, defaultLinkPlacement(n)])),
    },
    ctxOf(p, i),
  );
}

// ───────────── social content ─────────────

const FORMAT_WHAT: Record<PostPlatform, string> = { instagram: 'Short videos and carousels', tiktok: 'Short videos', facebook: 'Photos with a short story', linkedin: 'Text posts with practical tips', x: 'Short tips' };
const asQuestion = (s: string) => {
  const t = s.trim().replace(/[.?!]+$/, '');
  if (/^(what|how|why|is|are|can|do|does|should)\b/i.test(t)) return `${t}?`;
  // "I'm not a numbers person" → "What if I'm not a numbers person?"
  return `What if ${/^I\b/.test(t) ? t : lowerFirst(t)}?`;
};

export function localContent(p: Project, i: StepInputBase): ContentOut {
  const w = words(p);
  const nets = i.networks?.length ? i.networks : strategyNetworks(p);
  const service = p.studio.packages[0]?.name || w.bt?.services[0]?.name || 'visit';
  const pillars = [
    { name: 'Quick wins', why: 'Useful tips people can use today.', ideas: w.f.quickWins.slice(0, 3) },
    { name: 'Mistakes to avoid', why: 'Help people avoid problems before they happen.', ideas: w.f.mistakes.slice(0, 3) },
    { name: 'Questions people ask', why: 'Answer what makes people hesitate.', ideas: w.f.objections.slice(0, 2).map(asQuestion) },
    { name: 'Behind the scenes', why: `Show the people and work behind ${w.brand}.`, ideas: p.track === 'business' ? [`How a ${service.toLowerCase()} works, step by step`, `A day at ${w.brand}`] : [`How ${w.productShort} was made`, `What’s inside ${w.productShort}`] },
    { name: 'Your offer', why: 'Say clearly what people get and how to get it.', ideas: [`What you get with ${w.productShort}`] },
  ];
  const rec = recommendPageType(p);
  return normalizeContent(
    {
      pillars,
      formats: nets.map((n) => ({ platform: n, what: FORMAT_WHAT[n], why: `A common starting point to test on ${label(n)}.` })),
      campaign: { goal: goalForPage(rec.pageType), platforms: nets, postMix: { ...BUILTIN_MIX }, videoShare: nets.includes('tiktok') ? 'most' : 'some', why: 'A balanced mix to start with. Look at what gets comments after two weeks and adjust.' },
      ideas: suggestTopics(p).map((headline, k) => ({ headline, postType: (['tip', 'educational', 'question', 'sales', 'bts'] as const)[k] ?? 'tip', platform: nets[0], why: 'A topic from your project details.' })),
    },
    ctxOf(p, i),
  );
}

// ───────────── assets and the SEO page ─────────────

/** The code asset the built-in engine suggests: a booking widget for a business that books, a contact form for other businesses, a quiz for a product. */
function codeFor(p: Project, brand: string, productShort: string): { kind: CodeKind; prompt: string } {
  if (p.track === 'business') {
    const bt = matchBusinessType(`${p.businessType} ${p.category} ${p.niche}`);
    return bt.booking === 'book'
      ? { kind: 'booking', prompt: `A booking widget for ${brand}: pick a service and a time, then continue to my booking link.` }
      : { kind: 'leadform', prompt: `A short contact form for ${brand}: name, email, phone and what they need.` };
  }
  return { kind: 'quiz', prompt: `A short quiz that helps people see whether ${productShort} fits them, ending with a link to my page.` };
}

export function localAssets(p: Project, i: StepInputBase): AssetsOut {
  const w = words(p);
  const has = i.has;
  const rec = recommendPageType(p);
  const code = codeFor(p, w.brand, w.productShort);
  const assets = [
    ...(has.salesPage ? [] : [{ kind: 'page', title: `A ${PAGE_TYPE_LABEL[rec.pageType].toLowerCase()}`, why: rec.why }]),
    ...(has.leadMagnet
      ? []
      : [p.track === 'business' ? { kind: 'lead_magnet', title: 'A checklist people can use before they hire you', leadMagnetType: 'checklist', why: 'It gives people a reason to leave their email.' } : { kind: 'lead_magnet', title: `A short free guide on ${w.niche}`, leadMagnetType: 'guide', why: 'It gives people a reason to leave their email.' }]),
    ...(has.emails >= 5 ? [] : [{ kind: 'emails', title: 'Five welcome emails', why: 'They follow up with everyone who downloads your lead magnet.' }]),
    ...(has.codeAssets.length ? [] : [{ kind: 'code', title: codeKindLabel(code.kind), codeKind: code.kind, prompt: code.prompt, why: 'Something useful people can try on your page.' }]),
    ...(has.listed ? [] : [{ kind: 'listing', title: 'Your Marketplace listing', why: 'People browsing the Marketplace can find you.' }]),
    ...(has.listingImages ? [] : [{ kind: 'listing_images', title: 'Listing images', why: 'Listings with images are easier to understand at a glance.' }]),
  ];
  const keywords =
    p.track === 'business'
      ? [`${w.type} ${w.city}`, `${w.type} near me`]
      : [`${w.niche} ${w.format}`, `${p.category || ''} ${w.format}`];
  return normalizeAssets(
    {
      assets,
      seo: {
        audience: w.audience,
        angle: p.brand.valueProp || p.brand.tagline || '',
        objections: w.f.objections.slice(0, 3).map(asQuestion),
        keywords: keywords.map((k) => k.replace(/\s+/g, ' ').trim().toLowerCase()).filter((k) => k.split(' ').length > 1 || k.length > 2),
        cta: ctaForPage(rec.pageType, p.studio.price > 0),
        why: 'From your project details. Check the search terms yourself before you rely on them.',
      },
    },
    ctxOf(p, i),
  );
}

// ───────────── email outreach ─────────────

export function localOutreach(p: Project, i: StepInputBase): OutreachOut {
  const w = words(p);
  const inCity = w.city ? ` in ${w.city}` : '';
  const email =
    p.track === 'business'
      ? { leadMagnetType: 'checklist', idea: `A checklist: what to know before you hire a ${w.type}`, welcomeAngle: 'Practical help first, then how you can help them.', why: 'A checklist is quick to use and gives people a reason to leave their email.' }
      : { leadMagnetType: 'guide', idea: `A short guide: first steps with ${w.niche}`, welcomeAngle: 'Practical help first, then how you can help them.', why: 'A short guide shows how you help before anyone buys.' };
  const templates =
    p.track === 'business'
      ? [
          {
            who: 'A business that serves the same customers',
            purpose: 'partner',
            subject: 'An idea for our customers',
            body: `Hi [Name],\n\nI run ${w.brand}, a ${w.type}${inCity}. I think we serve the same kind of customers, so I wondered if we could help each other.\n\nWould you be open to recommending each other when a customer asks? I'm happy to share your details with mine.\n\nHere's my page: [link to your page]\n\nThanks,\n[Your name]`,
            followUp: 'Hi [Name], just checking you saw my note about recommending each other. Happy to talk whenever suits you. [Your name]',
            why: 'A business your customers already use could recommend you.',
          },
          {
            who: 'Past customers',
            purpose: 'past_customer',
            subject: 'Thank you, and a small favor',
            body: `Hi [Name],\n\nThank you again for choosing ${w.brand}. If a friend ever needs a ${w.type}, I'd be grateful if you passed on my page: [link to your page]\n\n[Your name]`,
            followUp: 'If they reply, thank them personally.',
            why: 'Start with people who already know your work.',
          },
        ]
      : [
          {
            who: 'A creator your buyers follow',
            purpose: 'collab',
            subject: 'A resource for your audience',
            body: `Hi [Name],\n\nI made ${w.productShort}, a ${w.format} for ${w.audience}. I think your audience might find it useful.\n\nWould you like to see it? I can send you [a copy to review].\n\n[link to your page]\n\n[Your name]`,
            followUp: `Hi [Name], just checking you saw my note about ${w.productShort}. No pressure at all. [Your name]`,
            why: 'A creator your buyers follow could introduce you to them.',
          },
          {
            who: 'People who already bought or downloaded',
            purpose: 'referral',
            subject: 'Know someone who’d like this?',
            body: `Hi [Name],\n\nThanks for getting ${w.productShort}. If you know someone who'd find it useful, you're welcome to share my page: [link to your page]\n\n[Your name]`,
            followUp: 'If they reply, thank them personally.',
            why: 'Ask people who liked it to pass it on.',
          },
        ];
  return normalizeOutreach({ email, templates }, ctxOf(p, i));
}

// ───────────── the plan ─────────────

/** The built-in four-week plan's actions, only the ones that still apply (by what the project has). */
function planActions(p: Project, has: StrategyHas, firstIdea: string): Record<string, unknown>[] {
  const rec = recommendPageType(p);
  const biz = p.track === 'business';
  const code = codeFor(p, p.brand.name || 'your business', buildFacts(p).productShort);
  const a = (week: number, kind: string, title: string, detail: string, extra: Record<string, unknown> = {}) => ({ week, kind, title, detail, ...extra });
  return [
    a(1, 'build_page', `Build your ${PAGE_TYPE_LABEL[rec.pageType].toLowerCase()}`, rec.why, { pageType: rec.pageType }),
    a(1, 'link_settings', 'Set where your link goes on each network', 'Choose the post, the first comment or your bio for each network, so new posts carry your link.'),
    ...(has.socials.length ? [] : [a(1, 'socials', 'Add your social handles', 'Your profiles, so posts and your page can point to them.')]),
    ...(has.leadMagnet ? [] : [a(1, 'lead_magnet', 'Write your lead magnet', 'A free download that gives people a reason to leave their email.')]),
    ...(biz ? (has.packages ? [] : [a(1, 'packages', 'Set your packages', 'What you offer and what each includes, in your own words and prices.')]) : has.productFiles ? [] : [a(1, 'product_file', 'Make your product file', 'The file people get when they buy.')]),
    a(2, 'campaign_setup', 'Set up your social campaign', 'Pick your days, networks and post mix.'),
    a(2, 'write_post', 'Write your first post', 'Start with a useful tip and point to your page.', { topic: firstIdea }),
    ...(has.pagePublished ? [] : [a(2, 'publish_page', 'Publish your page', 'Give it a public address, so posts and emails can link to it.')]),
    a(2, 'outreach', biz ? 'Send the partner email to three businesses' : 'Send the collaboration email to three creators', 'Copy the email from Email outreach, fill in the [brackets] and send it from your own email.'),
    ...(biz ? [a(2, 'offline', 'Complete your Google Business Profile', 'Photos, hours and your booking or contact link, so people nearby can find you.')] : []),
    a(3, 'batch_7', 'Make a 7-day batch of posts', 'A week of posts from your campaign plan, ready to review.'),
    ...(has.emails >= 5 ? [] : [a(3, 'welcome_emails', 'Write your welcome emails', 'They follow up with everyone who downloads your lead magnet.')]),
    ...(has.codeAssets.length ? [] : [a(3, 'code_asset', `Make your ${codeKindLabel(code.kind).toLowerCase()}`, 'Something useful people can try on your page.', { codeKind: code.kind })]),
    a(3, 'calendar', 'Plan your posts on the calendar', 'Put your posts on the days you can post.'),
    ...(has.listed ? [] : [a(4, 'listing', 'Publish your Marketplace listing', 'People browsing the Marketplace can find you.')]),
    ...(has.listingImages ? [] : [a(4, 'listing_images', 'Add listing images', 'Listings with images are easier to understand at a glance.')]),
    a(4, 'offline', 'Follow up on the emails you sent', 'A short, friendly nudge to anyone who hasn’t replied.'),
    a(4, 'offline', 'See which posts got comments and make more like them', 'Each network shows which posts people answered.'),
  ];
}

export function localPlan(p: Project, i: StepInputBase): PlanOut {
  const ideas = suggestTopics(p);
  return normalizePlan(
    {
      summary: 'A starter plan from your project details: get your page ready, then post, reach out and follow up for four weeks. It’s general guidance; an AI key adds research and a plan made for your market.',
      weeks: BUILTIN_WEEKS,
      actions: planActions(p, i.has, ideas[0] ?? 'A useful tip'),
      habits: ['Post at a pace you can keep every week.', 'Reply to comments and messages.', 'Ask every new customer how they found you.'],
      measure: [
        { what: 'Posts that went out', where: 'app', why: 'Analytics counts them.' },
        { what: 'Sign-ups and leads from your page', where: 'app', why: 'Your page collects them.' },
        p.track === 'business' ? { what: 'Bookings', where: 'booking', why: 'Your booking tool shows them.' } : { what: 'Sales', where: 'payments', why: 'Your payment tool shows them.' },
        { what: 'Profile visits and link clicks', where: 'network', why: 'Each network’s insights show them.' },
      ],
    },
    ctxOf(p, i),
  );
}

/** The empty state's free checklist: the built-in plan's weeks 1 and 2, computed on render and never stored. */
export function starterChecklist(p: Project, has: StrategyHas): StrategyAction[] {
  return localPlan(p, { owner: {}, has, networks: strategyNetworks(p), allowed: { pageTypes: [], placements: [], actionKinds: [], codeKinds: [], leadMagnetTypes: [] } }).actions.filter((a) => a.week <= 2);
}
