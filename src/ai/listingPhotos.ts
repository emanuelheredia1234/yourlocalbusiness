// What a business's listing images are made from, which image each listing shot shows, and the
// photos owners upload for them. Pure helpers: src/ai/image.ts turns the brief into image prompts
// and src/pages/studio/ListingImages.tsx shows the shots.
//
// The prompts start from the owner's own words (business type, specialty, top package, listing
// title, summary, audience, city). A stock setting from BIZ_SCENES is added only when the business
// type clearly is that kind of business. matchBusinessType() is looser on purpose (it matches parts
// of words and feeds every text generator), so it is not used to pick what a photo shows.

import type { ListingShotId, MediaRef, Project } from '@/lib/types';
import { isOwnPhoto } from '@/lib/media';
import { BUSINESS_TYPES, FORMATS, GENERIC_BUSINESS } from './knowledge';
import { unfilledPlaceholders } from './brain';
import { shortAudience } from './text';

// ───────────── is the stock setting safe? ─────────────

interface SceneWords {
  /** phrases that name this kind of business (plurals match too) */
  words: string[];
  /** words that fit the setting but don't name the business on their own (e.g. a cuisine) */
  fits?: string[];
  /** in the specialty, a different kind of business than the setting shows (pool cleaning is not a living room) */
  avoid?: string[];
}

const CUISINES = [
  'mexican', 'italian', 'thai', 'chinese', 'japanese', 'sushi', 'indian', 'french', 'greek', 'mediterranean', 'vietnamese', 'korean',
  'american', 'southern', 'cajun', 'creole', 'bbq', 'barbecue', 'seafood', 'vegan', 'vegetarian', 'burger', 'ramen', 'pho', 'tapas',
  'spanish', 'caribbean', 'ethiopian', 'lebanese', 'middle eastern', 'turkish', 'persian', 'peruvian', 'brazilian', 'cuban', 'soul food',
  'farm to table', 'breakfast', 'brunch', 'lunch', 'dinner', 'noodle', 'dumpling', 'steak', 'fusion', 'asian', 'latin', 'pizza', 'taco', 'wine',
];

/**
 * For each stock setting in BIZ_SCENES (image.ts, same keys), the business types it really shows.
 * Narrower than the business types' own match lists: the café setting is latte art (not a bakery),
 * the salon setting is a blow-dry (not nails), the auto setting is a repair garage (not detailing).
 */
export const SCENE_WORDS: Record<string, SceneWords> = {
  cleaning: {
    words: ['cleaning', 'cleaner', 'house cleaning', 'home cleaning', 'deep cleaning', 'maid', 'maid service', 'housekeeping', 'housekeeper'],
    avoid: ['pool', 'carpet', 'rug', 'upholstery', 'window', 'gutter', 'office', 'commercial', 'janitorial', 'industrial', 'construction', 'pressure', 'power washing', 'car', 'vehicle', 'boat', 'duct', 'chimney', 'solar', 'roof', 'tile', 'grout', 'trash'],
  },
  'home-repair': {
    words: ['handyman', 'handymen', 'handyperson', 'home repair', 'home maintenance', 'property maintenance', 'carpentry', 'carpenter', 'odd jobs'],
    avoid: ['hvac', 'heating', 'cooling', 'air conditioning', 'plumbing', 'plumber', 'electrical', 'electrician', 'roofing', 'roofer', 'roof', 'solar', 'appliance', 'pool', 'phone', 'computer', 'auto', 'car'],
  },
  landscaping: {
    words: ['landscaping', 'landscaper', 'landscape', 'landscape design', 'lawn', 'lawn care', 'lawn service', 'lawn mowing', 'mowing', 'yard', 'yard work', 'yard care', 'garden', 'gardening', 'gardener', 'garden design', 'hedge trimming'],
    avoid: ['tree', 'snow', 'irrigation', 'sprinkler', 'pool', 'pest', 'fence', 'fencing', 'roof', 'gutter', 'concrete', 'paving', 'artificial turf'],
  },
  salon: {
    words: ['salon', 'hair salon', 'hair', 'hairstylist', 'hair stylist', 'stylist', 'hairdresser', 'hair studio', 'beauty salon', 'blowout', 'blow dry', 'colorist', 'hair color'],
    avoid: ['nail', 'manicure', 'pedicure', 'lash', 'eyelash', 'brow', 'eyebrow', 'spa', 'facial', 'massage', 'wax', 'waxing', 'skin', 'skincare', 'esthetician', 'aesthetics', 'botox', 'injectables', 'tattoo', 'piercing', 'makeup', 'tanning', 'dog', 'pet'],
  },
  barber: { words: ['barber', 'barbershop', 'barbering'] },
  'fitness-studio': {
    words: ['gym', 'fitness', 'fitness studio', 'personal training', 'personal trainer', 'trainer', 'bootcamp', 'boot camp', 'crossfit', 'strength training', 'strength and conditioning', 'hiit', 'group fitness'],
    avoid: ['yoga', 'pilates', 'barre', 'dance', 'spin', 'cycling', 'swim', 'swimming', 'martial', 'karate', 'boxing', 'kickboxing', 'climbing', 'physical therapy', 'physiotherapy', 'rehab', 'massage', 'aerial', 'pole'],
  },
  cafe: {
    words: ['cafe', 'café', 'coffee', 'coffee shop', 'coffeehouse', 'coffee house', 'coffee bar', 'espresso', 'espresso bar', 'roaster', 'coffee roaster', 'roastery'],
    avoid: ['bakery', 'cake', 'cupcake', 'juice', 'smoothie', 'boba', 'bubble tea', 'ice cream', 'gelato', 'donut', 'doughnut', 'chocolate', 'bagel'],
  },
  restaurant: {
    words: ['restaurant', 'bistro', 'diner', 'eatery', 'trattoria', 'brasserie', 'steakhouse', 'pizzeria', 'grill', 'dining', 'fine dining', 'gastropub', 'tavern', 'cantina'],
    fits: CUISINES,
    avoid: ['food truck', 'truck', 'catering', 'caterer', 'cart', 'stand', 'ghost kitchen', 'meal prep'],
  },
  photography: {
    words: ['photography', 'photographer', 'photo studio', 'photography studio', 'portrait', 'portrait photography', 'headshot'],
    avoid: ['video', 'videography', 'videographer', 'film', 'drone', 'wedding', 'real estate', 'product', 'food', 'event', 'photo booth'],
  },
  consulting: {
    words: ['consulting', 'consultant', 'consultancy', 'business consulting', 'strategy', 'strategy consulting', 'advisor', 'advisory', 'business coach', 'business coaching', 'agency', 'marketing agency', 'marketing', 'digital marketing', 'marketing consultant'],
  },
  bookkeeping: {
    words: ['bookkeeping', 'bookkeeper', 'accounting', 'accountant', 'cpa', 'tax preparation', 'tax prep', 'tax preparer', 'tax', 'payroll'],
  },
  tutoring: {
    words: ['tutoring', 'tutor', 'homework help', 'learning center', 'test prep', 'academic coaching', 'study skills'],
    fits: ['math', 'reading', 'writing', 'science', 'sat', 'act', 'english', 'homework', 'exam', 'academic', 'online', 'in home'],
    avoid: ['music', 'piano', 'guitar', 'violin', 'drum', 'voice', 'singing', 'vocal', 'dance', 'art', 'swim', 'swimming', 'driving', 'language', 'spanish', 'french', 'mandarin', 'german', 'esl'],
  },
  'pet-services': {
    words: ['dog grooming', 'pet grooming', 'cat grooming', 'dog groomer', 'pet groomer', 'groomer', 'grooming salon', 'pet salon', 'dog salon', 'pet spa', 'dog spa', 'dog wash', 'pet wash'],
    avoid: ['walking', 'walker', 'training', 'trainer', 'boarding', 'daycare', 'sitting', 'sitter', 'vet', 'veterinary', 'kennel', 'adoption', 'photography'],
  },
  auto: {
    words: ['auto repair', 'car repair', 'mechanic', 'auto mechanic', 'garage', 'auto shop', 'auto service', 'car service', 'automotive repair', 'brake', 'oil change', 'engine repair', 'transmission', 'tune up'],
    avoid: ['detailing', 'detail', 'detailer', 'wash', 'tint', 'tinting', 'wrap', 'ceramic', 'paint', 'body', 'collision', 'towing', 'tow', 'windshield', 'glass', 'upholstery', 'stereo', 'audio', 'rental', 'dealership', 'motorcycle', 'boat', 'rv'],
  },
  'event-planning': {
    words: ['event planning', 'event planner', 'event', 'wedding planning', 'wedding planner', 'party planning', 'party planner', 'event design', 'event coordinator', 'event coordination', 'event styling', 'planner', 'wedding', 'venue', 'event venue', 'wedding venue'],
    avoid: ['florist', 'floral', 'flowers', 'dj', 'rental', 'photo booth', 'catering', 'cake', 'bakery', 'photography', 'photographer', 'videography', 'balloon', 'tent', 'bounce', 'music', 'band'],
  },
  retail: {
    words: ['boutique', 'retail', 'retail store', 'clothing', 'clothing store', 'clothing boutique', 'apparel', 'fashion', 'fashion boutique', 'gift shop', 'gift', 'concept store', 'lifestyle store', 'general store', 'home goods', 'homewares', 'accessories'],
    avoid: ['tattoo', 'repair', 'pawn', 'vape', 'smoke', 'liquor', 'grocery', 'pharmacy', 'hardware', 'bike', 'phone', 'thrift', 'consignment'],
  },
};

/** Words that describe any business without changing what its photos show. */
const NEUTRAL = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'to', 'my', 'our', 'your',
  'local', 'small', 'family', 'owned', 'independent', 'mobile', 'professional', 'pro', 'expert', 'quality', 'premium', 'luxury', 'boutique',
  'eco', 'friendly', 'green', 'organic', 'natural', 'best', 'custom', 'residential', 'home', 'house', 'modern', 'classic', 'affordable',
  'full', 'neighborhood', 'neighbourhood', 'community',
  'business', 'company', 'co', 'inc', 'llc', 'ltd', 'service', 'services', 'studio', 'shop', 'store', 'firm', 'practice', 'solutions', 'group', 'team', 'specialist', 'specialists',
  'kids', 'kid', 'children', 'child', 'student', 'students', 'adult', 'adults', 'teen', 'teens', 'senior', 'seniors', 'women', 'men', 'ladies', 'families', 'youth',
]);

/** Lower-case whole words ("Men's" → "men", "&" → "and"). */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !/^\d+$/.test(w));
}

const sameWord = (w: string, k: string) => w === k || w === `${k}s` || w === `${k}es` || (k.endsWith('y') && w === `${k.slice(0, -1)}ies`);
const isNeutral = (w: string) => NEUTRAL.has(w) || NEUTRAL.has(w.replace(/s$/, '')) || NEUTRAL.has(w.replace(/es$/, ''));

const phraseWords = new Map<string, string[]>();

/** Which of `ws` are part of one of the phrases (whole words only: "carpet" is not "car", "teacher" is not "tea"). */
function covered(ws: string[], phrases: string[]): boolean[] {
  const hit = ws.map(() => false);
  for (const phrase of phrases) {
    let ps = phraseWords.get(phrase);
    if (!ps) phraseWords.set(phrase, (ps = words(phrase)));
    if (!ps.length) continue;
    for (let i = 0; i + ps.length <= ws.length; i++) {
      if (ps.every((p, j) => sameWord(ws[i + j], p))) ps.forEach((_, j) => (hit[i + j] = true));
    }
  }
  return hit;
}

/**
 * The BIZ_SCENES setting that safely fits this business, or null. Images only: it is confident when
 * every word of the business type is explained by one setting (or is a neutral word like "local" or
 * "studio"), and the specialty doesn't point at a different kind of business. "Pool cleaning",
 * "Tattoo shop" and "Child daycare" get no stock setting; their own words describe the photo instead.
 */
export function sceneTypeFor(typeText: string, specialty = ''): string | null {
  let ws = words(typeText);
  let spec = specialty;
  // a type made only of generic words ("Small business") says nothing: the specialty is the type then
  if (ws.every(isNeutral)) {
    ws = words(specialty);
    spec = '';
  }
  if (!ws.length) return null;
  const fits = Object.entries(SCENE_WORDS).filter(([, s]) => {
    const named = covered(ws, s.words);
    const qualified = covered(ws, s.fits ?? []);
    return named.some(Boolean) && ws.every((w, i) => named[i] || qualified[i] || isNeutral(w));
  });
  if (fits.length !== 1) return null;
  const [id, s] = fits[0];
  return s.avoid && covered(words(spec), s.avoid).some(Boolean) ? null : id;
}

// ───────────── the owner's words ─────────────

/** Lines a template left for the owner to fill in ("Rooms covered: [your checklist]") are never shown or sent. */
export function withoutPlaceholders(lines: string[]): string[] {
  return lines.map((l) => l.trim()).filter((l) => l && !unfilledPlaceholders(l).length);
}

let templates: Map<string, Set<string>> | null = null;
/** The business types whose template wrote this package line or name (service names, delivery steps, tier names). */
function templateTypes(line: string): Set<string> | undefined {
  if (!templates) {
    const map = new Map<string, Set<string>>();
    const add = (text: string, id: string) => {
      const k = text.trim().toLowerCase();
      map.set(k, (map.get(k) ?? new Set()).add(id));
    };
    for (const bt of [...BUSINESS_TYPES, GENERIC_BUSINESS]) {
      for (const s of bt.services) {
        add(s.name, bt.id);
        if (s.duration) add(`${s.name} (${s.duration})`, bt.id);
      }
      for (const x of [...bt.delivery, ...bt.tiers]) add(x, bt.id);
    }
    templates = map;
  }
  return templates.get(line.trim().toLowerCase());
}

const tidy = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Cut at a word boundary, without trailing punctuation. */
function clip(s: string, max: number): string {
  const t = tidy(s);
  if (t.length <= max) return t.replace(/[\s,;:–—-]+$/, '');
  const cut = t.slice(0, max + 1);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.5 ? cut.slice(0, at) : t.slice(0, max)).replace(/[\s,;:.–—-]+$/, '');
}

/** "Home Cleaning" → "home cleaning"; acronyms and names in mixed case ("HVAC", "iPhone") stay as typed. */
function lowerWords(s: string): string {
  return s
    .split(' ')
    .map((w) =>
      w
        .split('-')
        .map((part) => (/^\p{Lu}[\p{Ll}\p{M}'’]*$/u.test(part) ? part.toLowerCase() : part))
        .join('-'),
    )
    .join(' ');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text without the business name (a name in a photo prompt invites the model to draw lettering). Whole words only. */
function withoutName(text: string, name: string, replacement = ''): string {
  const n = tidy(name);
  if (!n) return tidy(text);
  return tidy(text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, 'giu'), replacement));
}

/** A phrase that goes inside a sentence: no full stop of its own. */
const asPhrase = (s: string) => s.replace(/[\s.!?]+$/, '');

// "coffee shop", "dentist": already a place or a person, so no "business" after it
const PLACES = new Set([
  'business', 'company', 'co', 'service', 'shop', 'store', 'studio', 'salon', 'spa', 'agency', 'firm', 'practice', 'office', 'clinic', 'center',
  'centre', 'school', 'academy', 'club', 'gym', 'bar', 'pub', 'cafe', 'café', 'restaurant', 'bistro', 'diner', 'deli', 'eatery', 'kitchen', 'grill',
  'truck', 'cart', 'stand', 'garage', 'parlor', 'parlour', 'lounge', 'market', 'boutique', 'gallery', 'bakery', 'brewery', 'winery', 'creamery',
  'roastery', 'distillery', 'nursery', 'pizzeria', 'taqueria', 'patisserie', 'daycare', 'pharmacy', 'lab', 'venue', 'hotel', 'inn', 'farm', 'kennel',
]);
const PEOPLE = new Set([
  'teacher', 'trainer', 'planner', 'designer', 'photographer', 'videographer', 'plumber', 'painter', 'roofer', 'cleaner', 'groomer', 'walker',
  'sitter', 'baker', 'barber', 'caterer', 'tutor', 'instructor', 'counselor', 'counsellor', 'realtor', 'contractor', 'mover', 'landscaper',
  'gardener', 'carpenter', 'installer', 'inspector', 'appraiser', 'lawyer', 'attorney', 'doctor', 'chiropractor', 'consultant', 'accountant',
  'bookkeeper', 'assistant', 'coach', 'chef', 'cook', 'nanny', 'vet', 'agent', 'doula', 'midwife', 'tech', 'technician', 'dj', 'cpa', 'mechanic',
  'detailer', 'organizer', 'organiser', 'officiant', 'tailor', 'cobbler', 'jeweler', 'jeweller', 'framer', 'upholsterer', 'welder', 'engineer',
  'architect', 'surveyor', 'notary', 'translator', 'interpreter', 'editor', 'writer', 'developer', 'marketer', 'advisor', 'adviser', 'broker',
  'maker', 'builder', 'farmer', 'brewer', 'butcher', 'grocer', 'chocolatier', 'confectioner', 'masseuse', 'masseur', 'driver', 'courier',
  'guide', 'operator', 'decorator', 'handymen',
]);

/** "a local pool cleaning business", "a local dentist", "local movers"; "a local business" when nothing is known. */
function businessPhrase(what: string): { phrase: string; person: boolean } {
  if (!what) return { phrase: 'a local business', person: false };
  const last = what.split(' ').pop()!.toLowerCase();
  const one = /[^s]s$/.test(last) ? last.slice(0, -1) : last;
  const article = one === last ? 'a local' : 'local';
  if (PLACES.has(one) || /(shop|store|house)$/.test(one)) return { phrase: `${article} ${what}`, person: false };
  if (PEOPLE.has(one) || /(ist|ian|man|smith)$/.test(one)) return { phrase: `${article} ${what}`, person: true };
  return { phrase: `a local ${what} business`, person: false };
}

/** Settings that show a place selling things, not a service being done. */
const SHOP_SCENES = new Set(['cafe', 'restaurant', 'retail']);

export interface BusinessBrief {
  /** what the business is, in the owner's words (business type, else specialty) */
  what: string;
  /** "a local pool cleaning business", "a local dentist" */
  business: string;
  /** the business type names a person ("dentist", "music teacher"): the at-work photo shows them */
  person: boolean;
  /** the specialty, when it adds to the business type */
  specialty: string;
  /** the popular (or first) package's name and what it includes, without lines a template wrote for a different kind of business */
  offerName: string;
  offerItems: string[];
  /** the listing title without the business name, when it says more than the business type */
  title: string;
  /** the first sentence or two of the short description, with the business name left out */
  summary: string;
  /** who it's for, short ("busy families"): shown in the photo with a customer */
  audience: string;
  city: string;
  /** it sells things (a café, a boutique, or "How customers buy: Buy"): the second photo shows a customer instead of the team at work */
  shop: boolean;
  /** the BIZ_SCENES setting, only when the business type clearly is that kind of business */
  sceneId: string | null;
}

/** Everything a business's listing photos are made from, from the owner's own fields first. */
export function businessBrief(p: Project): BusinessBrief {
  const typeText = tidy(p.businessType || p.niche);
  const spec = tidy(p.category);
  const what = lowerWords(clip(typeText || spec, 60));
  const sceneId = sceneTypeFor(typeText || spec, typeText ? spec : '');
  const { phrase, person } = businessPhrase(what);
  // the specialty, unless the business type already says it all
  const specialty = typeText && spec && !typeText.toLowerCase().includes(spec.toLowerCase()) ? asPhrase(clip(spec, 120)) : '';
  // template lines are kept only when they come from the template of the business this clearly is
  const ownLine = (line: string) => {
    const from = templateTypes(line);
    return !from || (!!sceneId && from.has(sceneId));
  };
  const pkg = p.studio.packages.find((x) => x.popular) ?? p.studio.packages[0];
  const offerItems = pkg
    ? withoutPlaceholders(pkg.includes)
        .filter(ownLine)
        // durations ("(2–3 hrs)") don't show in a photo
        .map((l) => asPhrase(clip(l.replace(/\s*\([^)]*\d[^)]*\)/g, ''), 70)))
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const offerName = pkg && ownLine(pkg.name) && !unfilledPlaceholders(pkg.name).length ? asPhrase(clip(withoutName(pkg.name, p.brand.name), 50)) : '';
  // "Sparkle Pools | Weekly pool cleaning" → "Weekly pool cleaning", "Fresh bread by Sparkle" → "Fresh bread"; just the name → nothing
  const title = asPhrase(clip(withoutName(p.studio.listing.title, p.brand.name).replace(/^[\s|·:,–—-]+|[\s|·:,.–—-]+$/g, ''), 90)).replace(/\s+(by|from|at|with|of|for|and|&)$/i, '');
  const usefulTitle = title.replace(/[^\p{L}]/gu, '').length >= 3 && title.toLowerCase() !== (typeText || spec).toLowerCase();
  const firstSentences = tidy(p.summary).match(/^.*?[.!?](?:\s|$)(?:.*?[.!?](?:\s|$))?/)?.[0] ?? tidy(p.summary);
  const summary = clip(withoutName(firstSentences, p.brand.name, 'the business').replace(/^the business/, 'The business'), 200);
  // the built-in brand kit's stand-in ("people getting serious about dentist") says nothing a photo can show
  const audience = tidy(p.brand.audience) ? shortAudience(tidy(p.brand.audience)) : '';
  const ownAudience = audience && !/^people getting serious about\b/i.test(audience) ? audience : '';
  return {
    what,
    business: phrase,
    person,
    specialty,
    offerName,
    offerItems,
    title: usefulTitle ? title : '',
    summary,
    audience: asPhrase(clip(ownAudience, 80)),
    city: tidy(p.location?.city),
    // a café, restaurant or boutique sells things even when tables are booked; otherwise "How customers buy" says,
    // except for a person ("music teacher"), whose "Buy" may be left over from a template
    shop: sceneId ? SHOP_SCENES.has(sceneId) : p.studio.listing.bookingType === 'buy' && !person,
    sceneId,
  };
}

/** The small line above the offer card's title: the owner's own business type and city ("Pool Cleaning · Phoenix"); a product's format. */
export function offerEyebrow(p: Project, max = 38): string {
  if (p.track !== 'business') return p.format ? FORMATS[p.format].label.replace(/s$/, '') : 'Digital product';
  const type = tidy(p.businessType || p.niche || p.category) || 'Local business';
  const city = tidy(p.location?.city);
  // it is drawn on one line: the city only when the whole type fits beside it
  if (city && type.length + city.length + 3 <= max) return `${type} · ${city}`;
  if (type.length <= max) return type;
  return clip(type, max).replace(/\s+(and|or|of|for|with|the|a|an|&)$/i, '');
}

// ───────────── which image each shot shows ─────────────

/** Who made a listing image that has your details typeset on your own photo (no AI). */
export const OWN_PHOTO_PROVIDER = 'Your photo';

/** Your own photo, or your photo with your details typeset on it: "Generate full set" leaves these alone. */
export const fromOwnPhoto = (m: MediaRef | null | undefined): boolean => isOwnPhoto(m) || m?.generated?.provider === OWN_PHOTO_PROVIDER;

/** The image a listing shot shows: the photo you uploaded for it, else the newest image made for it. */
export function listingShotMedia(p: Project, shot: ListingShotId): MediaRef | undefined {
  const own = p.studio.listing.shotImageIds?.[shot];
  const mine = own ? p.brand.images.find((m) => m.id === own && m.kind === 'image') : undefined;
  return mine ?? p.brand.images.filter((m) => m.kind === 'image' && m.generated?.purpose === 'listing' && m.generated.shot === shot).sort((a, b) => b.createdAt - a.createdAt)[0];
}

// ───────────── uploads ─────────────

/** Photos every browser can open. HEIC (the iPhone default) can't be read in Chrome or Firefox. */
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp';

/** Why a file can't be used as a listing photo, or null when it can. */
export function photoFileProblem(file: { name: string; type: string }): string | null {
  const type = file.type.toLowerCase();
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (PHOTO_ACCEPT.split(',').includes(type) || (!type && ['jpg', 'jpeg', 'png', 'webp'].includes(ext))) return null;
  if (/hei[cf]/.test(type) || ext === 'heic' || ext === 'heif') return 'HEIC photos can’t be opened here. Save it as a JPG, PNG or WebP and try again.';
  return 'Use a JPG, PNG or WebP photo.';
}
