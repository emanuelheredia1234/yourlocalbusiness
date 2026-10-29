import type { Directives, PostPlatform, PostType, Project, Tone } from '@/lib/types';
import { capitalize, createRng, fmtMoney, hashStr, lowerFirst, stripProtocol, titleCase, type Rng } from '@/lib/utils';
import {
  BUSINESS_VOICE,
  extractAudience,
  FORMATS,
  GENERIC_BUSINESS,
  matchBusinessType,
  matchNiche,
  type BusinessType,
  type NicheProfile,
} from './knowledge';

// ───────────────────────── Project facts: everything a generator needs, derived once ─────────────────────────

export interface Facts {
  track: Project['track'];
  brand: string;
  product: string;
  productShort: string;
  format: Project['format'];
  formatLabel: string;
  formatNoun: string;
  niche: NicheProfile;
  nicheLabel: string;
  category: string;
  topic: string;
  topicLower: string;
  audience: string;
  audiences: string[];
  pain: string;
  pains: string[];
  desire: string;
  desires: string[];
  outcome: string;
  outcomes: string[];
  terms: string[];
  objections: string[];
  mistakes: string[];
  myths: string[];
  quickWins: string[];
  hashtags: string[];
  price: number;
  priceStr: string;
  priceSuffix: string;
  url: string;
  urlDisplay: string;
  city: string;
  region: string;
  local: boolean;
  business: BusinessType | null;
  tagline: string;
  pitch: string;
  leadMagnet: string;
  summary: string;
}

export function genericNiche(niche: string, category: string): NicheProfile {
  const topic = (category || niche || 'your topic').trim();
  const t = topic.toLowerCase();
  const aud = extractAudience(`${niche} ${category}`) || `people getting serious about ${t}`;
  const words = `${niche} ${category}`
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 2)
    .map((w) => w.toLowerCase());
  const roots = words.map((w) => capitalize(w)).slice(0, 4);
  return {
    id: 'generic',
    label: titleCase(niche || category || 'General'),
    match: [],
    audiences: [aud, 'beginners', 'busy professionals'],
    pains: [`figuring out ${t} alone`, `inconsistent results with ${t}`, `conflicting advice about ${t}`, `not knowing where to start with ${t}`, `wasting money on ${t} tools that don’t fit`],
    desires: [`real progress with ${t}`, 'a simple plan that works', 'confidence and clarity', 'more time for what matters'],
    outcomes: [`get consistent results with ${t} in 30 days`, 'save hours every week', 'build a repeatable system you trust', `avoid the most expensive ${t} mistakes`],
    terms: [...new Set([...words, 'system', 'checklist', 'routine'])].slice(0, 7),
    objections: ["I don't have time", "I've tried before and it didn't stick", "I'm not sure it will work for me", 'It seems too expensive'],
    mistakes: [`starting ${t} without a clear plan`, 'trying to do everything at once', 'copying advice meant for someone else', 'skipping the fundamentals'],
    myths: [`You need to be an expert to get results with ${t}`, 'More effort always means better results', 'There is one right way to do it', 'It takes years to see progress'],
    quickWins: ['write down your number-one goal for this month', 'block 20 minutes on your calendar this week', 'pick one metric to track', 'ask one customer what they struggle with most'],
    hashtags: [...new Set(words.slice(0, 4).map((w) => `#${w.replace(/[^a-z0-9]/g, '')}`)), '#smallbusiness', '#tips', '#howto'].slice(0, 7),
    icon: 'sparkles',
    palettes: [['#145C43', '#0D2B22', '#F0B429'], ['#3B4CCA', '#141B4D', '#F59E0B'], ['#B4436C', '#3A1323', '#F7B32B']],
    nameRoots: [...roots, 'Bright', 'True', 'North', 'Kind', 'Bold', 'Clear', 'Peak', 'Harbor', 'Nova'].slice(0, 12),
    categories: [],
    demand: 0.72,
    competition: 0.6,
    priceMult: 1,
    calc: 'roi',
  };
}

export function resolveNiche(niche: string, category: string, preferLocal = false): NicheProfile {
  return matchNiche(niche, category, preferLocal) ?? genericNiche(niche, category);
}

/** True when the category names something narrower than the niche's built-in knowledge. */
export function isSpecificCategory(niche: NicheProfile, category: string): boolean {
  const c = category.trim().toLowerCase();
  if (!c || niche.id === 'generic') return false;
  return niche.label.toLowerCase() !== c;
}

export function buildFacts(project: Project): Facts {
  const niche = resolveNiche(project.niche || project.businessType, project.category, project.track === 'business');
  const fmt = project.format ? FORMATS[project.format] : null;
  const local = project.track === 'business' || !!niche.local;
  const business = project.track === 'business' ? matchBusinessType(`${project.businessType} ${project.category} ${project.niche}`) : null;
  const topic = titleCase((project.category || project.niche || niche.label).trim());
  const extracted = extractAudience(`${project.category} ${project.niche}`);
  const brandAudience = project.brand.audience?.trim();
  const audience = shortAudience(brandAudience || project.idea?.audience || extracted || niche.audiences[0]);
  const brand = project.brand.name || 'Your Brand';
  const product =
    project.studio.listing.title ||
    (project.track === 'product' ? project.idea?.title || brand : brand);
  const productShort = product.split(/[:—–]/)[0].trim();
  const price = project.studio.price || project.idea?.price || (business ? Math.round((business.services[1]?.price[0] ?? 99)) : fmt ? fmt.price[0] : 49);
  const priceSuffix = project.studio.priceModel === 'monthly' ? '/mo' : project.studio.priceModel === 'yearly' ? '/yr' : '';
  const specific = isSpecificCategory(niche, project.category) && project.track === 'product';
  const topicL = topic.toLowerCase();
  const bizVoice = business ? BUSINESS_VOICE[business.id] : null;
  const pains = blend(bizVoice?.pains ?? niche.pains, anchoredPains(topicL), specific);
  const outcomes = blend(bizVoice?.outcomes ?? niche.outcomes, anchoredOutcomes(topicL), specific);
  const pain = project.idea?.pain ? lowerFirst(project.idea.pain) : pains[0];
  const url = project.brand.websiteUrl || `https://${project.brand.slug || 'yourbrand'}.com`;
  return {
    track: project.track,
    brand,
    product,
    productShort,
    format: project.format,
    formatLabel: fmt?.label ?? business?.label ?? 'Service',
    formatNoun: fmt?.short ?? 'service',
    niche,
    nicheLabel: niche.id === 'generic' ? titleCase(project.niche || niche.label) : niche.label,
    category: project.category,
    topic,
    topicLower: topic.toLowerCase(),
    audience,
    audiences: [audience, ...niche.audiences.filter((a) => a !== audience)],
    pain,
    pains: [pain, ...pains.filter((p) => p !== pain)],
    desire: niche.desires[0],
    desires: niche.desires,
    outcome: outcomes[0],
    outcomes,
    terms: niche.terms,
    objections: niche.objections,
    mistakes: niche.mistakes,
    myths: niche.myths,
    quickWins: niche.quickWins,
    hashtags: niche.hashtags,
    price,
    priceStr: fmtMoney(price),
    priceSuffix,
    url,
    urlDisplay: stripProtocol(url),
    city: project.location?.city ?? '',
    region: project.location?.region ?? '',
    local,
    business: business ?? (project.track === 'business' ? GENERIC_BUSINESS : null),
    tagline: project.brand.tagline,
    pitch: project.brand.pitch,
    leadMagnet: project.marketing.leadMagnet?.title ?? '',
    summary: project.summary,
  };
}

export function shortAudience(a: string): string {
  let s = a.trim().replace(/\.$/, '');
  // "Freelancers who are tired of …" → "freelancers"
  s = s.split(/\s+(?:who|that|tired|looking|wanting|ready|struggling|trying)\s+/i)[0];
  s = s.split(/[,.;:—–(]/)[0].trim();
  const words = s.split(/\s+/);
  if (words.length > 7) s = words.slice(0, 7).join(' ');
  return lowerFirst(s || a.slice(0, 40));
}

/** Outcomes and pains phrased around the user's own topic, so niche data never drifts off-topic. */
export function anchoredOutcomes(topicLower: string): string[] {
  return [`see real progress with ${topicLower} in 30 days`, `build a ${topicLower} routine that sticks`, `get confident with ${topicLower}, step by step`];
}
export function anchoredPains(topicLower: string): string[] {
  return [`not knowing where to start with ${topicLower}`, `conflicting advice about ${topicLower}`, `${topicLower} plans that never stick`];
}

function blend(primary: string[], anchored: string[], specific: boolean): string[] {
  if (!specific) return primary;
  // anchored first, then the broadest niche items, then the rest
  return [anchored[0], primary[0], anchored[1], primary[1], ...primary.slice(2), anchored[2]].filter(Boolean);
}

// ───────────────────────── Voice: tone-aware phrasing ─────────────────────────

const DEFAULT_TONE: Record<string, Tone> = {
  'b2b-sales': 'authoritative',
  'professional-services': 'professional',
  tech: 'bold',
  marketing: 'bold',
  beauty: 'friendly',
  mindfulness: 'empathetic',
  parenting: 'empathetic',
  fitness: 'bold',
  food: 'friendly',
  'food-business': 'friendly',
  'home-services': 'friendly',
  'real-estate': 'professional',
  'personal-finance': 'friendly',
  career: 'professional',
  education: 'friendly',
  events: 'luxury',
  automotive: 'bold',
  pets: 'playful',
  creative: 'witty',
  ecommerce: 'bold',
  travel: 'playful',
  productivity: 'friendly',
  'health-nutrition': 'empathetic',
  home: 'friendly',
};

const TONE_EMOJI: Record<Tone, 'none' | 'light' | 'heavy'> = {
  friendly: 'light',
  professional: 'none',
  bold: 'light',
  playful: 'heavy',
  luxury: 'none',
  empathetic: 'light',
  witty: 'light',
  authoritative: 'none',
};

const EMOJI: Record<string, string[]> = {
  spark: ['✨', '⚡️', '💡'],
  point: ['👇', '👉', '⬇️'],
  check: ['✅', '✔️', '☑️'],
  warn: ['⚠️', '🚫', '❌'],
  heart: ['❤️', '💛', '🤍'],
  fire: ['🔥', '🚀', '💥'],
  idea: ['💡', '🧠', '📝'],
  money: ['💸', '💰', '📈'],
  time: ['⏱️', '⏰', '🗓️'],
  pin: ['📌', '🔖', '📍'],
  star: ['⭐️', '🌟', '🏆'],
  wave: ['👋', '🙌', '😊'],
  gift: ['🎁', '🎉', '🥳'],
};

const VERBS = new Set(
  'set cut build stop know train reduce add run plan hit fall analyze book raise reclaim double lift recover price rank automate ship write save earn land negotiate switch declutter keep grow finish bake cook prep hold teach spend turn increase get fill make create launch master learn handle find feel move see stay become reach beat win sleep speak enjoy eat manage lose protect avoid hire close sell bring come trust leave look drive grab treat receive walk shop have always glow celebrate host relax'.split(' '),
);

export function verbOutcome(o: string): string {
  const first = o.split(' ')[0].toLowerCase();
  return VERBS.has(first) ? o : `get ${o}`;
}

export function singular(aud: string): string {
  const irregular: Record<string, string> = { women: 'woman', men: 'man', people: 'person', children: 'child', folks: 'person' };
  const words = aud.split(' ');
  const preps = new Set(['over', 'with', 'in', 'who', 'of', 'on', 'at', 'for', 'doing', 'going', 'managing', 'getting', 'selling', 'starting', 'learning', 'juggling', 'planning']);
  let headIdx = words.length - 1;
  for (let i = 0; i < words.length; i++) {
    if (preps.has(words[i].toLowerCase())) {
      headIdx = i - 1;
      break;
    }
  }
  if (headIdx < 0) return aud;
  const w = words[headIdx];
  const lw = w.toLowerCase();
  if (irregular[lw]) words[headIdx] = irregular[lw];
  else if (/ies$/.test(lw)) words[headIdx] = w.slice(0, -3) + 'y';
  else if (/[^s]s$/.test(lw)) words[headIdx] = w.slice(0, -1);
  return words.join(' ');
}

export class Voice {
  readonly tone: Tone;
  readonly emojiLevel: 'none' | 'light' | 'heavy';
  constructor(
    readonly f: Facts,
    readonly d: Directives,
    readonly rng: Rng,
  ) {
    this.tone = d.tone ?? DEFAULT_TONE[f.niche.id] ?? 'friendly';
    this.emojiLevel = d.emoji ?? TONE_EMOJI[this.tone];
  }

  static create(f: Facts, d: Directives, seed: string | number): Voice {
    return new Voice(f, d, createRng(typeof seed === 'number' ? seed : hashStr(seed)));
  }

  pick<T>(arr: readonly T[]): T {
    return this.rng.pick(arr);
  }

  /** An emoji for the given intent, honoring the emoji directive. */
  e(kind: keyof typeof EMOJI, force = false): string {
    if (this.emojiLevel === 'none') return '';
    if (this.emojiLevel === 'light' && !force && !this.rng.chance(0.55)) return '';
    return this.pick(EMOJI[kind]);
  }

  /** Appends an emoji with a leading space when allowed. */
  ee(kind: keyof typeof EMOJI, force = false): string {
    const x = this.e(kind, force);
    return x ? ` ${x}` : '';
  }

  get we(): string {
    if (this.d.person === 'i') return 'I';
    if (this.d.person === 'we') return 'we';
    return this.f.local || this.f.track === 'business' ? 'we' : this.rng.chance(0.5) ? 'I' : 'we';
  }

  get our(): string {
    return this.we === 'I' ? 'my' : 'our';
  }

  get length(): 'short' | 'medium' | 'long' {
    return this.d.length ?? 'medium';
  }

  audienceOne(): string {
    return singular(this.f.audience);
  }

  hookStyle(type: PostType | 'email' | 'ad'): NonNullable<Directives['hookStyle']> {
    if (this.d.hookStyle) return this.d.hookStyle;
    const defaults: Record<string, NonNullable<Directives['hookStyle']>[]> = {
      educational: ['question', 'stat', 'pov'],
      tip: ['contrarian', 'stat', 'question'],
      question: ['question'],
      sales: ['pov', 'question', 'stat'],
      bts: ['story', 'pov'],
      email: ['question', 'story', 'contrarian'],
      ad: ['question', 'pov', 'contrarian'],
    };
    return this.pick(defaults[type] ?? ['question']);
  }

  hook(type: PostType | 'email' | 'ad', topicOverride?: string): string {
    const f = this.f;
    const topic = (topicOverride || f.topicLower).toLowerCase();
    const pain = this.pick(f.pains.slice(0, 3));
    const outcome = verbOutcome(this.pick(f.outcomes.slice(0, 3)));
    const mistake = this.pick(f.mistakes);
    const myth = this.pick(f.myths);
    const aud = f.audience;
    const style = this.hookStyle(type);
    const n = this.pick([3, 3, 5, 5, 7]);
    const lines: Record<string, string[]> = {
      question: [
        `Still dealing with ${pain}?`,
        `What would change if you could ${outcome}?`,
        `Why do so many ${aud} struggle with ${topic}?`,
        `Want to ${outcome} without the guesswork?`,
        `Be honest: how much did ${pain} cost you this month?`,
      ],
      stat: [
        `${n} steps to ${outcome}.`,
        `${n} ${topic} mistakes that quietly cost ${aud} the most.`,
        `15 minutes a week is enough to ${outcome}.`,
        `The ${n} ${topic} moves that matter (and the rest you can skip).`,
        `One habit, ${n} days, a very different ${topic} routine.`,
      ],
      contrarian: [
        `Unpopular opinion: “${lowerFirst(myth)}” isn’t true.`,
        `Stop ${mistake}. Do this instead.`,
        `Everyone tells ${aud} that ${lowerFirst(myth)}. I disagree.`,
        `You don’t need more willpower to ${outcome}. You need a system.`,
        `The most common ${topic} advice is why so many ${aud} stay stuck.`,
      ],
      story: f.local
        ? [
            `Last week a customer told ${this.we === 'I' ? 'me' : 'us'} ${pain} had been driving them crazy for months.`,
            `A quick story from this week’s jobs (it ends well).`,
            `Here’s what happened when a neighbor finally called about ${pain}.`,
          ]
        : [
            `Last month a ${this.audienceOne()} told ${this.we === 'I' ? 'me' : 'us'} ${pain} was ruining their week.`,
            `${capitalize(this.we)} used to struggle with ${pain} too. Here’s what changed.`,
            `The day ${this.we} cracked ${topic}, everything got easier.`,
            `A quick story about ${pain} (and how it ended).`,
          ],
      pov: [
        `POV: you finally ${outcome}.`,
        `POV: you never worry about ${pain} again.`,
        `POV: your ${topic} runs itself.`,
      ],
    };
    if (f.local && f.city && this.rng.chance(0.35)) {
      lines.question.push(`${f.city}, quick question: how do you handle ${pain}?`);
      lines.pov.push(`POV: you found the ${f.city} ${f.formatLabel.toLowerCase()} everyone keeps recommending.`);
    }
    const tonePrefix: Partial<Record<Tone, string[]>> = {
      bold: ['Listen up. ', '', ''],
      playful: ['Okay real talk: ', '', ''],
      witty: ['Plot twist: ', '', ''],
    };
    const prefix = style !== 'pov' && style !== 'story' ? this.pick(tonePrefix[this.tone] ?? ['']) : '';
    const line = this.pick(lines[style]);
    return prefix ? prefix + lowerFirst(line) : line;
  }

  cta(kind: 'link' | 'comment' | 'save' | 'book' | 'buy' | 'optin' | 'reply' | 'share', platform?: PostPlatform): string {
    const f = this.f;
    const linkless = platform === 'instagram' || platform === 'tiktok';
    const where = linkless ? 'the link in bio' : f.urlDisplay;
    const arrow = this.emojiLevel === 'none' ? '→' : this.pick(['👉', '→', '👇']);
    if (this.d.cta && (kind === 'link' || kind === 'buy' || kind === 'book' || kind === 'optin')) {
      const c = this.d.cta.trim();
      return c.toLowerCase().includes(f.urlDisplay.toLowerCase()) || linkless ? `${c}${linkless ? ' (link in bio)' : ''}` : `${c} ${f.urlDisplay}`;
    }
    const byTone: Record<Tone, Record<string, string[]>> = {
      friendly: {
        link: [`Take a look at ${f.productShort} ${arrow} ${where}`, `Everything you need is here ${arrow} ${where}`],
        buy: [`Grab ${f.productShort} here ${arrow} ${where}`, `Ready when you are ${arrow} ${where}`],
        book: [`Book your spot ${arrow} ${where}`, `Come see us. Book at ${where}`],
      },
      professional: {
        link: [`Learn more at ${where}`, `Details at ${where}`],
        buy: [`Get ${f.productShort} at ${where}`, `Start today at ${where}`],
        book: [`Book a consultation at ${where}`, `Schedule your appointment at ${where}`],
      },
      bold: {
        link: [`Stop scrolling. Start here ${arrow} ${where}`, `Go ${arrow} ${where}`],
        buy: [`Get ${f.productShort} now ${arrow} ${where}`, `Claim yours today ${arrow} ${where}`],
        book: [`Lock in your spot ${arrow} ${where}`, `Book now ${arrow} ${where}`],
      },
      playful: {
        link: [`Your future self says thanks ${arrow} ${where}`, `Go on, have a peek ${arrow} ${where}`],
        buy: [`Treat yourself ${arrow} ${where}`, `Add to cart, thank us later ${arrow} ${where}`],
        book: [`Snag a spot before they’re gone ${arrow} ${where}`, `Book the fun part ${arrow} ${where}`],
      },
      luxury: {
        link: [`Discover more at ${where}`, `Explore at ${where}`],
        buy: [`Reserve yours at ${where}`, `Available now at ${where}`],
        book: [`Reserve your appointment at ${where}`, `By appointment at ${where}`],
      },
      empathetic: {
        link: [`Whenever you’re ready, it’s here ${arrow} ${where}`, `Take the first gentle step ${arrow} ${where}`],
        buy: [`If this sounds like you, ${f.productShort} can help ${arrow} ${where}`, `Start at your own pace ${arrow} ${where}`],
        book: [`We’d love to help. Book at ${where}`, `Book a time that suits you ${arrow} ${where}`],
      },
      witty: {
        link: [`Your ${f.topicLower} called. It wants an upgrade ${arrow} ${where}`, `Curiosity looks good on you ${arrow} ${where}`],
        buy: [`Fix it for less than a fancy lunch ${arrow} ${where}`, `Cheaper than therapy, nearly as useful ${arrow} ${where}`],
        book: [`Book now. Thank us at your next brag ${arrow} ${where}`, `Your calendar has room. We checked ${arrow} ${where}`],
      },
      authoritative: {
        link: [`Get the framework at ${where}`, `Read the full breakdown at ${where}`],
        buy: [`Start the program at ${where}`, `Get ${f.productShort} at ${where}`],
        book: [`Book a strategy call at ${where}`, `Reserve a slot at ${where}`],
      },
    };
    switch (kind) {
      case 'comment':
        return this.pick([
          `Tell ${this.we === 'I' ? 'me' : 'us'} in the comments${this.ee('point', true)}`,
          `Drop your answer below${this.ee('point', true)}`,
          `Comment “${f.topic.split(' ')[0].toUpperCase()}” and ${this.we} will send you the ${f.leadMagnet || 'free checklist'}.`,
        ]);
      case 'save':
        return this.pick([`Save this for your next ${f.topicLower} session${this.ee('pin', true)}`, `Bookmark this one. You’ll want it later${this.ee('pin', true)}`]);
      case 'share':
        return this.pick([`Send this to a ${this.audienceOne()} who needs it.`, `Share with someone who’s dealing with ${f.pain}.`]);
      case 'reply':
        return this.pick(['Hit reply and tell me where you’re stuck. I read every one.', 'Reply with one word: “ready”. I’ll send the next step.']);
      case 'optin':
        return `Get the free ${f.leadMagnet || `${f.topic} checklist`} ${arrow} ${where}`;
      default: {
        const bank = byTone[this.tone][kind] ?? byTone[this.tone].link;
        return this.pick(bank);
      }
    }
  }

  signOff(): string {
    if (this.d.signOff) return this.d.signOff;
    const bank: Record<Tone, string[]> = {
      friendly: ['Talk soon,', 'Cheering you on,', 'Warmly,'],
      professional: ['Best regards,', 'Kind regards,', 'All the best,'],
      bold: ['Let’s go,', 'Onward,', 'Your move,'],
      playful: ['High fives,', 'Catch you later,', 'Stay awesome,'],
      luxury: ['With care,', 'Sincerely,', 'Yours,'],
      empathetic: ['Rooting for you,', 'Gently,', 'With you all the way,'],
      witty: ['Stay clever,', 'Until next time,', 'Yours in good ideas,'],
      authoritative: ['To your success,', 'Best,', 'Regards,'],
    };
    return this.pick(bank[this.tone]);
  }

  /** How many body sentences/bullets a piece of copy should have. */
  count(short: number, medium: number, long: number): number {
    return this.length === 'short' ? short : this.length === 'long' ? long : medium;
  }

  hashtags(n: number, extra: string[] = []): string[] {
    const fromDirectives = this.d.hashtags ?? [];
    const topicTag = '#' + this.f.topic.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    const brandTag = '#' + this.f.brand.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    const cityTag = this.f.city ? '#' + this.f.city.replace(/[^A-Za-z0-9]/g, '').toLowerCase() + (this.f.local ? 'local' : '') : '';
    const pool = [...fromDirectives, ...extra, topicTag, ...this.rng.shuffle(this.f.hashtags), cityTag, brandTag].filter(
      (t) => t && t.length > 2 && t.length < 32,
    );
    return [...new Set(pool)].slice(0, Math.max(0, n));
  }

  /** Weave required keywords into copy if missing. */
  includeMust(text: string): string {
    const must = this.d.mustInclude ?? [];
    const missing = must.filter((m) => !text.toLowerCase().includes(m.toLowerCase()));
    if (!missing.length) return text;
    return `${text}\n\n${capitalize(missing.slice(0, 2).join(' · '))}`;
  }
}

export function voiceFor(project: Project, d: Directives, seed: string | number): Voice {
  return Voice.create(buildFacts(project), d, seed);
}
