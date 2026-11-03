// Older versions filled business facts in for the owner from a business-type template: opening hours and a
// guarantee in the listing ("Instant digital delivery. Lifetime updates included." for products), dollar values
// and a guarantee in the value stack, ad copy claiming reviews, licensing, free estimates and a 30-day
// guarantee, and a social plan whose key messages claimed customer results and a launch deadline. Packages got
// perks ("Priority scheduling", a template bonus), an automatic "most popular" flag and service standards with
// timings ("Gallery delivered in 10 business days"); team roles claimed credentials ("Licensed technicians").
// These functions remove that text only where it is still exactly what the template wrote (so the owner
// never edited it), and leave everything the owner wrote alone. Running them again changes nothing.

import type { AdCampaign, AdCreative, CampaignPlan, ListingDraft, Listing, Project, SearchAd, ServicePackage, ValueStackItem } from '@/lib/types';
import { BUSINESS_TYPES, GENERIC_BUSINESS } from '@/ai/knowledge';
import { buildFacts } from '@/ai/text';
import { offerKeyMessage, RECAP_MESSAGE, recapGoal, TRUST_GOAL, trustMessage } from '@/ai/local/social';

const TYPES = [...BUSINESS_TYPES, GENERIC_BUSINESS];
const TEMPLATE_HOURS = new Set(TYPES.map((t) => t.hours));
/** What a listing or package could carry as a promise the owner never made. */
const TEMPLATE_PROMISES = new Set([
  ...TYPES.map((t) => t.guarantee),
  // the short form packages used ("100% satisfaction") when a guarantee has a colon
  ...TYPES.filter((t) => t.guarantee.includes(':')).map((t) => t.guarantee.split(':')[0]),
  // a guarantee older versions listed among the cleaning service standards
  '24-hour re-clean promise for missed spots',
  // the closing line older versions wrote for every product listing
  'Instant digital delivery. Lifetime updates included.',
  'Instant digital delivery. Works on any device.',
  'Instant digital delivery. Built from real-world experience.',
]);
/** Every bonus (perk) the old business-type templates offered, frozen as they were written: some have since been
 *  renamed or replaced by a placeholder in knowledge.ts (e.g. "Priority Slack channel"), so the current lists can't be used. */
const TEMPLATE_BONUSES = new Set([
  'Free fridge clean-out on the first visit', 'Seasonal checklist for homeowners', 'Priority holiday booking',
  'Priority scheduling for members', '15% off repairs for members', 'Free annual safety inspection',
  'Free spring aeration with full-season plans', 'Priority storm cleanup', 'Holiday lighting discount',
  'Complimentary scalp treatment on first visit', 'Member-only pricing on retail', 'Birthday upgrade',
  'Free beard oil with first club month', 'Priority Saturday slots', 'Bring-a-friend credit',
  'Free nutrition kickoff call', 'Progress photo check-ins', 'Bring-a-friend Fridays',
  'Free drink on your 5th visit', 'Birthday pastry', 'Early access to seasonal menu',
  'Free dessert for reservations Tue–Thu', 'Kids eat free Sundays', 'Catering tasting for events of 30+',
  'Free outfit consultation', '5 bonus edited images', 'Social media crop pack',
  'Free competitor audit', 'Template library access', 'Priority Slack channel',
  'Free first-month catch-up review', 'Quarterly planning session', 'Year-end tax organizer',
  'Free practice test', 'Parent strategy guide', 'Priority exam-season slots',
  'Free nail trim between visits', 'Birthday bandana',
  'Free air freshener and tire shine', 'Member-only coating discount', 'Rainy-day rewash',
  'Complimentary engagement shoot styling', 'Vendor discount network', 'Day-after brunch coordination',
  'Free gift wrap', 'Birthday discount', 'Early access to new arrivals',
  'Free follow-up check', 'Priority booking for returning clients', 'Referral credit',
]);
/** The description older versions gave every template bonus in the value stack. */
const TEMPLATE_BONUS_DESC = 'Removes the next obstacle for ';
/** Includes older generators added to packages on their own: a perk ("Priority scheduling" on the top tier) or a template bonus. */
const isTemplatePerk = (x: string) => x.trim() === 'Priority scheduling' || TEMPLATE_BONUSES.has(x.trim());

/** Old "service delivery standard" lines (frozen) that promised standards, timings or extras the owner never set,
 *  with the neutral line or bracketed placeholder current versions use instead. Keys never appear among the values. */
const OLD_DELIVERY: Record<string, string> = {
  'Room-by-room cleaning standard (kitchen, baths, living, bedrooms)': 'Room-by-room cleaning (kitchen, baths, living, bedrooms)',
  'Quality check with photos before leaving': 'Wrap-up before leaving: [how you finish a visit]',
  'Shoe covers and drop cloths on every job': 'Job-site care: [how you protect the home]',
  'Flat-rate pricing approved before work starts': 'Quote shared before work starts: [how you price]',
  'Photo documentation of parts and fixes': 'Summary of the work done',
  'Follow-up call within 48 hours': 'Follow-up [if you do one]',
  'Route-optimized weekly crews': 'Scheduled visits: [how often]',
  'Before/after photos for every project': 'Before/after photos [if you take them]',
  'Seasonal health check of turf and beds': 'Mowing, beds and seasonal tasks: [what you cover]',
  'Clean-up and blow-off on every visit': 'Clean-up at the end of a visit',
  'Consultation before every service': 'Consultation before the service',
  'Personalized at-home care card': 'Aftercare tips',
  'Product recommendations tied to the service': 'Product recommendations [if you make them]',
  'Follow-up message after 7 days': 'Follow-up [if you do one]',
  'Hot towel finish on every service': 'Finishing touches: [describe yours]',
  'Product recommendation': 'Product recommendations [if you make them]',
  'Rebook in 3–4 weeks': 'Rebooking offered at checkout',
  'Programmed sessions with progress tracking': 'Coached sessions',
  'Monthly check-in and re-assessment': 'Check-ins: [how often]',
  'Community challenges every quarter': 'Community events [if you run them]',
  'Seasonal menu rotation': 'Menu: [what you bake and how often it changes]',
  'Catering delivered setup-ready': 'Custom and catering orders [if you take them]',
  'Feedback card in every box': 'Feedback cards [if you include them]',
  'Consistent recipes with plated photos': 'Written recipes for each dish',
  'Catering setup checklist': 'Catering [if you offer it]',
  'Guest feedback loop every week': 'Guest feedback: [how you collect it]',
  'Pre-session style guide': 'Pre-session planning call',
  'Directed session with posing': 'Photo session',
  'Gallery delivered in 10 business days': 'Edited online gallery: [how many images, how soon]',
  'Print and album upsell': 'Prints and albums [if you offer them]',
  'Kickoff workshop': 'Kickoff meeting',
  'Weekly sprints with async updates': 'Project work with updates: [how often]',
  'Monthly performance report': 'Performance report [how often]',
  'Quarterly strategy review': 'Strategy review [how often]',
  'Monthly reconciliation by the 10th': 'Account reconciliation: [how often]',
  'Quarterly tax estimate reminder': 'Tax reminders [if you send them]',
  'Year-end tax-ready package': 'Year-end summary: [what it includes]',
  'Baseline assessment': 'Starting assessment',
  'Personalized learning plan': 'Learning plan for the student',
  'Weekly sessions with practice sets': 'Tutoring sessions: [how often]',
  'Parent progress check-ins': 'Parent check-ins: [how often]',
  'Nose-to-tail health check': 'Check-in and grooming notes',
  'Low-stress handling': 'Bath, cut and trim: [what a groom includes]',
  'Photo update before pickup': 'Pickup',
  'Rebook reminder every 6 weeks': 'Rebook reminder',
  'Interior steam and extraction': 'Interior cleaning: [what you do]',
  'Paint decontamination and protection': 'Exterior wash and finish: [what you do]',
  'Final quality inspection with the client': 'Hand-over with the client',
  'Day-of team and setup/teardown': 'Day-of coordination: [what you handle]',
  'Seasonal merchandising refresh': 'Product selection: [what you stock]',
  'Local maker collaborations': 'Local maker collaborations [if you have them]',
  'Same-day local delivery': 'Pickup or delivery: [which you offer]',
  'Monthly VIP shopping night': 'In-store events [if you run them]',
  'Service delivered to a written standard': 'The service itself: [what it includes]',
  'Quality check before completion': 'Wrap-up: [how you finish a job]',
  'Follow-up within one week': 'Follow-up [if you do one]',
};
/** Old team roles (frozen) that claimed a credential, with the plain role name. */
const OLD_ROLES: Record<string, string> = {
  'Licensed technicians': 'Technicians',
  'Certified trainers': 'Trainers',
  'Owner / master barber': 'Owner / lead barber',
  'Owner / accountant': 'Owner / lead bookkeeper',
};
const OLD_OPERATING: Record<string, string> = { ...OLD_DELIVERY, ...OLD_ROLES };
const own = (m: Record<string, string>, k: string) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined);

/** Old local-business outcomes (frozen) that promised results, timings or quality, with the neutral wording knowledge.ts uses now.
 *  Only applied to text the old generators wrote from them (plan key messages and goals, ad copy). */
export const OLD_OUTCOMES: [string, string][] = [
  ['a response within one business day', 'clear answers to your questions'],
  ['fixed-fee packages with no surprises', 'packages with the scope written down'],
  ['quarterly check-ins that prevent problems', 'regular check-ins'],
  ['hours saved every month', 'less time spent on admin'],
  ['a complete plan 90 days out', 'a complete plan well before the day'],
  ['staying within budget by 5%', 'a budget you can track'],
  ['come home to a spotless house every week', 'come home to a clean house'],
  ['trust the same vetted cleaner every visit', 'book cleaning on a regular schedule'],
  ['get every repair done right the first time', 'get the repair sorted'],
  ['keep your home in top shape year-round', 'keep up with home maintenance'],
  ['enjoy a yard you are proud of', 'enjoy your yard'],
  ['keep a healthy, green lawn all season', 'keep up with lawn and garden care all season'],
  ['leave with exactly the look you asked for', 'get the look you have in mind'],
  ['keep your color vibrant for weeks', 'keep your color looking good between visits'],
  ['book a stylist who remembers you', 'book with a stylist you like'],
  ['look sharp every week', 'look sharp'],
  ['book your barber in seconds', 'book your barber easily'],
  ['get the same great cut every time', 'keep your cut looking the way you like it'],
  ['get stronger with coaching on every rep', 'train with a coach'],
  ['see real progress in 30 days', 'work toward your fitness goals'],
  ['grab a perfect cup on the way to work', 'grab a coffee on the way to work'],
  ['find your new favorite neighborhood spot', 'find a neighborhood spot you like'],
  ['treat yourself to something fresh every day', 'treat yourself to something fresh'],
  ['enjoy a memorable meal close to home', 'enjoy a good meal close to home'],
  ['get fresh food delivered hot', 'order food for a night in'],
  ['make every celebration feel special', 'celebrate with friends and family'],
  ['get photos you will actually frame', 'get photos you will want to frame'],
  ['feel relaxed and natural on camera', 'feel more relaxed on camera'],
  ['receive your gallery within two weeks', 'know when your gallery will arrive'],
  ['get a clear plan with measurable milestones', 'get a clear plan with milestones'],
  ['know exactly what to do next', 'know what to do next'],
  ['have clean books every month', 'keep your books up to date'],
  ['raise grades within a semester', 'feel more on top of schoolwork'],
  ['walk into exams confident', 'walk into exams more prepared'],
  ['bring home a happy, freshly groomed pet', 'bring home a freshly groomed pet'],
  ['book trusted pet care in minutes', 'book grooming easily'],
  ['keep your pet calm, clean and healthy', 'keep your pet clean and comfortable'],
  ['drive a car that looks showroom-new', 'drive a car that looks cared for'],
  ['protect your paint for months', 'look after your paint'],
  ['get honest service on your schedule', 'book service on your schedule'],
  ['stay on budget without compromise', 'keep track of your budget'],
  ['shop local with easy returns', 'shop local'],
  ['always have the perfect gift ready', 'find a gift for the people on your list'],
  ['get reliable service every time', 'get the job done'],
  ['know the price upfront', 'know the price before you book'],
  ['book in minutes', 'book easily'],
];
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
/** Text with any old outcome phrase (lower-case or capitalized) swapped for its neutral wording. */
function fixOutcomes(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [from, to] of OLD_OUTCOMES) {
    if (out.includes(from)) out = out.split(from).join(to);
    const F = cap(from);
    if (out.includes(F)) out = out.split(F).join(cap(to));
  }
  return out;
}
/** The fixed "perceived values" older versions gave bonuses ($49/$79/$99/$129, ×3 for prices over $300). */
const TEMPLATE_BONUS_VALUES = new Set([49, 79, 99, 129].flatMap((v) => [v, v * 3]));

const isPromiseLine = (line: string) => TEMPLATE_PROMISES.has(line.trim().replace(/^•\s*/, ''));
/** Search tags older versions took from the local-services niche terms: they claimed what nobody said. */
const CLAIM_TAGS = new Set(['free estimate', 'licensed and insured']);
const cleanTags = (tags: string[] | undefined) => (tags && tags.some((t) => CLAIM_TAGS.has(t)) ? tags.filter((t) => !CLAIM_TAGS.has(t)) : tags);

const OLD_BULLET = /^•\s*(.+?)\s*$/;
/** An old "What you get" bullet (an old delivery-standard line) in its neutral wording, or undefined. */
const bulletFix = (line: string) => {
  const m = OLD_BULLET.exec(line);
  const to = m ? own(OLD_DELIVERY, m[1]) : undefined;
  return to === undefined ? undefined : `• ${to}`;
};

/** A description without the template's promise lines, with old delivery-standard bullets made neutral
 *  (and no blank lines left dangling at the end). */
function cleanDescription(text: string): string {
  const lines = text.split('\n');
  if (!lines.some((l) => isPromiseLine(l) || bulletFix(l) !== undefined)) return text;
  const kept = lines.filter((l) => !isPromiseLine(l)).map((l) => bulletFix(l) ?? l);
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.join('\n');
}

/** Package or listing includes without template promises and perks, with old delivery-standard lines made neutral. */
function cleanIncludes(xs: string[] | undefined): string[] | undefined {
  if (!xs || !xs.some((x) => TEMPLATE_PROMISES.has(x.trim()) || isTemplatePerk(x) || own(OLD_DELIVERY, x.trim()) !== undefined)) return xs;
  const out = xs.filter((x) => !TEMPLATE_PROMISES.has(x.trim()) && !isTemplatePerk(x)).map((x) => own(OLD_DELIVERY, x.trim()) ?? x);
  return [...new Set(out)];
}

function cleanDraft(d: ListingDraft): ListingDraft {
  const hours = d.hours && TEMPLATE_HOURS.has(d.hours.trim()) ? '' : d.hours;
  const description = typeof d.description === 'string' ? cleanDescription(d.description) : d.description;
  const tags = cleanTags(d.tags) ?? d.tags;
  if (hours === d.hours && description === d.description && tags === d.tags) return d;
  // a removed tag alone needs no review; hours or a promise the listing showed does
  return { ...d, hours, description, tags, ...(hours !== d.hours || description !== d.description ? { needsReview: true } : {}) };
}

const OLD_POPULAR = 'Our most popular option: ';
/** What an earlier cleanup rewrote OLD_POPULAR to (it left the automatic popular flag on). */
const OLD_ALL_ROUND = 'The all-round option: ';
const OLD_ESSENTIALS = 'The essentials, done right. Ideal for ';
const OLD_WHITE_GLOVE = 'White-glove, done-for-you service for clients who want the very best.';

/** An old template package description with its quality claims ("done right", "white-glove", "most popular") taken out. */
function cleanPackageDescription(d: string): string {
  if (d.startsWith(OLD_POPULAR)) return `The middle package: ${d.slice(OLD_POPULAR.length)}`;
  if (d.startsWith(OLD_ALL_ROUND)) return `The middle package: ${d.slice(OLD_ALL_ROUND.length)}`;
  if (d.startsWith(OLD_ESSENTIALS)) return `The starting package, for ${d.slice(OLD_ESSENTIALS.length)}`;
  if (d === OLD_WHITE_GLOVE) return 'The most complete package, with the most included.';
  return d;
}

/** Packages without template promises and perks. The old generator also marked the 2nd of its 3 tiers "most popular" by
 *  itself; that flag is cleared only where the tier still carries the old template description, so a flag the owner
 *  set (or a tier they rewrote) stays. */
function cleanPackages(pkgs: ServicePackage[]): ServicePackage[] {
  let changed = false;
  const out = pkgs.map((pk, i) => {
    const includes = cleanIncludes(pk.includes) ?? pk.includes;
    const d = typeof pk.description === 'string' ? pk.description : '';
    const description = typeof pk.description === 'string' ? cleanPackageDescription(d) : pk.description;
    const autoPopular = pk.popular === true && pkgs.length === 3 && i === 1 && (d.startsWith(OLD_POPULAR) || d.startsWith(OLD_ALL_ROUND));
    if (includes === pk.includes && description === pk.description && !autoPopular) return pk;
    changed = true;
    return { ...pk, includes, description, ...(autoPopular ? { popular: false } : {}) };
  });
  return changed ? out : pkgs;
}

function cleanValueStack(stack: ValueStackItem[], pkgs: ServicePackage[]): ValueStackItem[] {
  let changed = false;
  const out: ValueStackItem[] = [];
  for (const v of stack) {
    if (v.kind === 'guarantee' && TEMPLATE_PROMISES.has(v.description.trim())) {
      changed = true;
      continue;
    }
    // a template perk still carrying the template's description: the owner never offered it
    if (v.kind === 'bonus' && TEMPLATE_BONUSES.has(v.title.trim()) && typeof v.description === 'string' && v.description.startsWith(TEMPLATE_BONUS_DESC)) {
      changed = true;
      continue;
    }
    const templateCore = v.kind === 'core' && v.value > 0 && pkgs.some((pk) => v.title === `${pk.name} package` && v.value === Math.round(pk.price * 1.25));
    const templateBonus = v.kind === 'bonus' && TEMPLATE_BONUSES.has(v.title.trim()) && TEMPLATE_BONUS_VALUES.has(v.value);
    const description = v.kind === 'core' && typeof v.description === 'string' ? cleanPackageDescription(v.description) : v.description;
    if (templateCore || templateBonus || description !== v.description) {
      changed = true;
      out.push({ ...v, description, ...(templateCore || templateBonus ? { value: 0 } : {}) });
      continue;
    }
    out.push(v);
  }
  return changed ? out : stack;
}

const OLD_CAPACITY = /^Target capacity: ~\d+ appointments or jobs per week$/;
// The template once added "and nearby neighborhoods" to the owner's city: a service area they never gave.
const OLD_SERVICE_AREA = /^(Service area: .+) and nearby neighborhoods$/;

const fixOperatingItem = (x: string) =>
  TEMPLATE_HOURS.has(x)
    ? 'Opening hours: [your hours]'
    : OLD_CAPACITY.test(x)
      ? 'Weekly capacity: [how many jobs or appointments you can take]'
      : OLD_SERVICE_AREA.test(x)
        ? x.replace(OLD_SERVICE_AREA, '$1')
        : own(OLD_OPERATING, x) ?? x;

function cleanOperating(ops: Project['studio']['operating']): Project['studio']['operating'] {
  let changed = false;
  const out = ops.map((b) => {
    // the old cleaning re-clean promise was listed as a delivery standard; it goes, like the other template promises
    if (!Array.isArray(b.items) || !b.items.some((x) => TEMPLATE_PROMISES.has(x) || fixOperatingItem(x) !== x)) return b;
    changed = true;
    return { ...b, items: [...new Set(b.items.filter((x) => !TEMPLATE_PROMISES.has(x)).map(fixOperatingItem))] };
  });
  return changed ? out : ops;
}

const OLD_TRUST = /^People like you are already getting results with (.+)\.$/;
// "… is the fastest way to …" (older plans) and "… is built to help you …" (an earlier migration of it) both promise a result.
const OLD_OFFER = /^(.+?) is (?:the fastest way to|built to help you) .+\.$/;
const OLD_TOPIC_OFFER = /^(.+): launch offer$/;
const OLD_TOPIC_DEADLINE = 'Last chance: launch bonus ends soon';
const OLD_TOPIC_SPOTLIGHT = /^Customer spotlight: an? .+’s win$/;

function cleanPlan(plan: CampaignPlan, p: Project): CampaignPlan {
  let changed = false;
  const weeks = plan.weeks.map((w) => {
    let keyMessage = w.keyMessage;
    let goal = w.goal;
    const trust = OLD_TRUST.exec(keyMessage);
    const offer = OLD_OFFER.exec(keyMessage);
    if (trust) keyMessage = trustMessage(trust[1]);
    else if (offer) keyMessage = offerKeyMessage(offer[1]);
    else if (keyMessage === 'The launch offer ends soon.') keyMessage = RECAP_MESSAGE;
    keyMessage = fixOutcomes(keyMessage);
    if (goal === 'Show real people, process and results.') goal = TRUST_GOAL;
    else if (goal === 'Create urgency and recap the month.') goal = recapGoal(p.track);
    goal = fixOutcomes(goal);
    if (keyMessage === w.keyMessage && goal === w.goal) return w;
    changed = true;
    return { ...w, keyMessage, goal };
  });
  let facts: ReturnType<typeof buildFacts> | null = null;
  const f = () => (facts ??= buildFacts(p));
  const days = plan.days.map((d) => {
    if (!d.slots.some((s) => OLD_TOPIC_OFFER.test(s.topic) || s.topic === OLD_TOPIC_DEADLINE || OLD_TOPIC_SPOTLIGHT.test(s.topic))) return d;
    changed = true;
    return {
      ...d,
      slots: d.slots.map((s) => {
        const m = OLD_TOPIC_OFFER.exec(s.topic);
        if (m) return { ...s, topic: `${m[1]}: price and what’s included` };
        if (s.topic === OLD_TOPIC_DEADLINE) return { ...s, topic: `Questions about ${f().productShort}, answered` };
        if (OLD_TOPIC_SPOTLIGHT.test(s.topic)) return { ...s, topic: `What to expect from ${f().brand}` };
        return s;
      }),
    };
  });
  return changed ? { ...plan, weeks, days } : plan;
}

/** The project with template hours, guarantees, bonus values, plan claims and the like removed, or null when there's nothing to change.
 *  A listing draft that lost hours or a promise gets `needsReview` so the Publish tab asks the owner to review it. */
export function purgeClaims(p: Project): Project | null {
  const s = p.studio;
  if (!s) return null;
  const listing = s.listing ? cleanDraft(s.listing) : s.listing;
  const packages = Array.isArray(s.packages) ? cleanPackages(s.packages) : s.packages;
  const valueStack = Array.isArray(s.valueStack) ? cleanValueStack(s.valueStack, Array.isArray(s.packages) ? s.packages : []) : s.valueStack;
  const operating = Array.isArray(s.operating) ? cleanOperating(s.operating) : s.operating;
  const plan = p.marketing?.plan ? cleanPlan(p.marketing.plan, p) : p.marketing?.plan;
  if (listing === s.listing && packages === s.packages && valueStack === s.valueStack && operating === s.operating && plan === p.marketing?.plan) return null;
  return {
    ...p,
    studio: { ...s, listing, packages, valueStack, operating },
    marketing: plan === p.marketing?.plan ? p.marketing : { ...p.marketing, plan },
  };
}

/** A published listing (myListings) without template hours or template promise lines, or null when there's nothing to change. */
export function purgeListingClaims(l: Listing): Listing | null {
  const hours = l.hours && TEMPLATE_HOURS.has(l.hours.trim()) ? undefined : l.hours;
  const description = typeof l.description === 'string' ? cleanDescription(l.description) : l.description;
  const includes = cleanIncludes(l.includes);
  const tags = cleanTags(l.tags) ?? l.tags;
  if (hours === l.hours && description === l.description && includes === l.includes && tags === l.tags) return null;
  const { hours: _h, ...rest } = l;
  return { ...rest, ...(hours ? { hours } : {}), description, includes, tags };
}

/** Sitelinks that claimed reviews and licensing nobody checked. */
const OLD_SITELINKS = new Set(['Reviews|What neighbors say', 'About Us|Local, licensed & insured']);
const OLD_HEADLINE = (h: string) => h === 'Book Online in 60 Seconds' || h === 'Instant Access · Start Today' || h.startsWith('Free Estimates · ');

const OLD_PRICING = ' Upfront pricing, friendly pros.';

/** The template's "Trusted by …" description without that claim (or its "30-day guarantee."); '' when nothing is left. */
function cleanSearchDescription(d: string): string {
  if (d.endsWith(OLD_PRICING)) return `${d.slice(0, -OLD_PRICING.length)} See our services and prices.`;
  if (!d.startsWith('Trusted by ')) return d;
  const end = d.indexOf('. ');
  let out = end < 0 ? '' : d.slice(end + 2);
  const g = out.indexOf('30-day guar');
  if (g >= 0) out = out.slice(0, g).trimEnd();
  return out;
}

/** "<Brand> Official Site": the template wrote it whether or not the owner had a website. */
const OFFICIAL_SITE = /\bOfficial Site$/;

function cleanSearch(s: SearchAd, hasSite?: boolean): SearchAd {
  const sitelinks = s.sitelinks.filter((l) => !OLD_SITELINKS.has(`${l.title}|${l.desc}`));
  const kept = s.headlines.filter((h) => !OLD_HEADLINE(h) && !(hasSite === false && OFFICIAL_SITE.test(h)));
  const fixedHeadlines = kept.map(fixOutcomes);
  const headlines = kept.length === s.headlines.length && fixedHeadlines.every((h, i) => h === kept[i]) ? s.headlines : fixedHeadlines;
  const cleaned = s.descriptions.map((d) => fixOutcomes(cleanSearchDescription(d)));
  const descriptions = cleaned.every((d, i) => d === s.descriptions[i]) ? s.descriptions : cleaned.filter(Boolean);
  if (sitelinks.length === s.sitelinks.length && headlines === s.headlines && descriptions === s.descriptions) return s;
  return { ...s, sitelinks, headlines, descriptions };
}

const OLD_SWITCHING = /^The (.+) (service|system) (.+) are switching to\. /;

function cleanCreative(c: AdCreative): AdCreative {
  const description =
    c.description === 'Free estimates' ? 'Get in touch today' : c.description === 'Free instant download' ? 'Free download' : c.description === 'Takes 2 minutes' ? 'See what’s included' : c.description.replace(/ · Instant access$/, '');
  const primaryText = fixOutcomes(c.primaryText.replace(OLD_SWITCHING, 'A $1 $2 made for $3. '));
  const headline = fixOutcomes(c.headline);
  const visualHeadline = fixOutcomes(c.visualHeadline);
  return description === c.description && primaryText === c.primaryText && headline === c.headline && visualHeadline === c.visualHeadline
    ? c
    : { ...c, description, primaryText, headline, visualHeadline };
}

/** An ad campaign without the template's review, licensing, guarantee, free-estimate and instant-access claims or
 *  old outcome promises, or null when there's nothing to change. Pass `hasSite: false` when the project has no website
 *  to also drop an "… Official Site" headline; left undefined, that headline is kept. */
export function purgeAdClaims(a: AdCampaign, hasSite?: boolean): AdCampaign | null {
  const search = a.search ? cleanSearch(a.search, hasSite) : a.search;
  const creatives = (a.creatives ?? []).map(cleanCreative);
  const creativesChanged = creatives.some((c, i) => c !== a.creatives[i]);
  if (search === a.search && !creativesChanged) return null;
  return { ...a, search, creatives: creativesChanged ? creatives : a.creatives };
}
