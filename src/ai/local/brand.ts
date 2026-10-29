import type { BannerStyle, BrandColors, Directives, LogoFont, LogoShape, NameOption, Project, Tone } from '@/lib/types';
import { capitalize, createRng, darken, hashStr, hexToHsl, hslToHex, lighten, lowerFirst, mix, slugify, titleCase, uniq } from '@/lib/utils';
import { suggestIcons } from '../knowledge';
import { buildFacts, singular, verbOutcome, Voice } from '../text';

export interface BrandKitResult {
  nameOptions: NameOption[];
  tagline: string;
  pitch: string;
  valueProp: string;
  audience: string;
  personality: string[];
  mission: string;
  slug: string;
  domainIdeas: string[];
  colors: BrandColors;
  paletteOptions: BrandColors[];
  icon: string;
  iconOptions: string[];
  shape: LogoShape;
  font: LogoFont;
  bannerStyle: BannerStyle;
}

const PERSONALITY: Record<Tone, string[]> = {
  friendly: ['Warm', 'Practical', 'Encouraging'],
  professional: ['Credible', 'Clear', 'Dependable'],
  bold: ['Confident', 'Energetic', 'Direct'],
  playful: ['Fun', 'Upbeat', 'Approachable'],
  luxury: ['Refined', 'Calm', 'Exclusive'],
  empathetic: ['Supportive', 'Gentle', 'Honest'],
  witty: ['Clever', 'Surprising', 'Sharp'],
  authoritative: ['Expert', 'Precise', 'Decisive'],
};

const SHAPE_BY_TONE: Record<Tone, LogoShape[]> = {
  friendly: ['circle', 'blob', 'rounded'],
  professional: ['rounded', 'shield', 'circle'],
  bold: ['hex', 'shield', 'rounded'],
  playful: ['blob', 'circle'],
  luxury: ['circle', 'none'],
  empathetic: ['circle', 'blob'],
  witty: ['rounded', 'hex'],
  authoritative: ['shield', 'rounded', 'hex'],
};

const FONT_BY_TONE: Record<Tone, LogoFont[]> = {
  friendly: ['rounded', 'grotesk'],
  professional: ['grotesk', 'serif'],
  bold: ['poster', 'grotesk'],
  playful: ['rounded', 'script'],
  luxury: ['serif'],
  empathetic: ['serif', 'rounded'],
  witty: ['grotesk', 'mono'],
  authoritative: ['grotesk', 'serif'],
};

export function paletteFrom([primary, secondary, accent]: [string, string, string]): BrandColors {
  return {
    primary,
    secondary,
    accent,
    ink: darken(mix(secondary, '#000000', 0.2), 0.35),
    paper: lighten(primary, 0.94),
  };
}

function complementary(base: string): [string, string, string] {
  const [h, s, l] = hexToHsl(base);
  return [hslToHex(h + 165, Math.min(0.75, s + 0.1), Math.min(0.48, Math.max(0.32, l))), hslToHex(h + 165, 0.45, 0.14), hslToHex(h + 30, 0.85, 0.6)];
}

export function generateBrandKit(project: Project, d: Directives = {}, variation = 0): BrandKitResult {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|brand|${variation}|${project.niche}|${project.category}`));
  const rng = createRng(hashStr(`names|${project.niche}|${project.category}|${project.businessType}|${variation}`));
  const prof = f.niche;

  // ── names
  const topicWords = `${project.category} ${project.businessType}`
    .split(/[^A-Za-z]+/)
    .filter((w) => w.length > 3 && !/^(with|from|your|the|and|for)$/i.test(w))
    .map((w) => capitalize(w.toLowerCase()));
  const roots = uniq([...rng.shuffle(prof.nameRoots), ...topicWords]);
  const suffixes = ['ly', 'wise', 'hub', 'lab', 'nest', 'path', 'kit', 'works', 'craft', 'base', 'able', 'io'];
  const adjectives = ['Clear', 'True', 'Bright', 'Bold', 'Quiet', 'Good', 'Little', 'Golden', 'North', 'Open', 'Steady', 'Honest', 'Simple'];
  const endings = ['ora', 'ova', 'ari', 'eo', 'ix'];
  const isLocal = f.local;
  const typeWord = f.business?.noun ?? titleCase(f.formatNoun);

  const candidates: NameOption[] = [];
  const add = (name: string, rationale: string) => {
    const clean = name.replace(/\s+/g, ' ').trim();
    if (clean.length < 3 || clean.length > 22) return;
    if (candidates.some((c) => c.name.toLowerCase() === clean.toLowerCase())) return;
    const slug = slugify(clean).replace(/-/g, '');
    candidates.push({ name: clean, rationale, domain: `${slug}.com` });
  };

  const r1 = roots[0] ?? 'Bright';
  const r2 = roots[1] ?? 'Nest';
  const r3 = roots[2] ?? 'Path';
  const suffix = rng.pick(suffixes);
  const joined = r1.endsWith(suffix[0]) ? r1 + suffix.slice(1) : r1 + suffix;
  if (isLocal) {
    const co = typeWord === 'Co.' ? 'Co.' : `${typeWord} Co.`;
    add(`${r1} ${typeWord === 'Co.' ? '& Co.' : typeWord}`, 'Says exactly what you do on the sign, with a name that sounds established.');
    if (f.city) add(`${f.city} ${co}`, `Rooted in ${f.city}: instantly local and easy to recommend.`);
    add(`${r2} & Co.`, 'Warm and timeless, like a neighborhood shop with history.');
    add(`${r3} ${typeWord === 'Co.' ? 'House' : typeWord}`, 'Short, memorable and signage-ready.');
  } else {
    add(joined, `Short and ownable. The “-${suffix}” ending feels modern and app-friendly.`);
    add(`${rng.pick(adjectives)} ${r2}`, `Two plain words that promise ${lowerFirst(f.desire)}.`);
    add(`${r3}${rng.pick(['Path', 'Nest', 'Base', 'Field', 'Works', 'Kit', 'Labs'])}`, 'A compound name that feels like a tool you rely on.');
    add(`${r1.slice(0, Math.max(3, Math.min(5, r1.length - 1)))}${rng.pick(endings)}`, 'Invented and distinctive, easy to trademark and find in search.');
    add(`${r2}${rng.pick(['ly', 'wise', 'hub'])}`, 'Brandable and short, works as a handle on every platform.');
  }
  void topicWords;
  const nameOptions = rng.shuffle(candidates).slice(0, 3);

  // ── copy
  const tone = v.tone;
  const outcome = verbOutcome(rng.pick(f.outcomes.slice(0, 3)));
  const pain = f.pain;
  const desire = rng.pick(f.desires);
  const brandName = project.brand.name || nameOptions[0]?.name || 'Your Brand';
  const what = f.track === 'business' ? f.business?.label.toLowerCase() ?? 'local business' : `${f.formatNoun.toLowerCase()}`;
  const shortWhat = what.replace(/ &.*/, '');
  const taglines = isLocal
    ? [
        f.city ? `${f.city}’s most dependable ${shortWhat}.` : `Your neighborhood ${shortWhat}, done right.`,
        `${capitalize(desire)}, close to home.`,
        `Local people. Real care. Work we stand behind.`,
        f.city ? `Proudly serving ${f.city}, one happy customer at a time.` : `Friendly ${shortWhat} you can count on.`,
      ]
    : [
        `${capitalize(desire)}, made simple.`,
        `Your ${f.topicLower}, finally sorted.`,
        `${capitalize(outcome)}. Without the stress.`,
        `The smarter way to ${outcome.split(' ').slice(0, 5).join(' ')}.`,
      ];
  const tagline = rng.pick(taglines).replace(/\.\./g, '.');

  const formatPhrase =
    f.track === 'business'
      ? `${f.business?.label ?? 'service'} team`
      : `${f.formatNoun.toLowerCase()}${f.product && f.product !== brandName ? ` “${f.productShort}”` : ''}`;
  const pitchBank: Record<string, string[]> = {
    default: [
      `${brandName} helps ${f.audience} ${outcome} without ${pain}. Our ${formatPhrase} turns ${f.topicLower} into a clear, repeatable routine, so you get ${lowerFirst(desire)}.`,
      `For ${f.audience} tired of ${pain}, ${brandName} is the ${formatPhrase} that makes it simple to ${outcome}. Practical, specific and built for real life.`,
    ],
    local: [
      `${brandName} is a ${f.city ? `${f.city}-based ` : ''}${what} that helps ${f.audience} get ${lowerFirst(desire)}. We show up on time, quote upfront and treat every customer like a neighbor.`,
      `${f.city ? `Serving ${f.city} and nearby neighborhoods, ` : ''}${brandName} takes ${pain} off your plate. Clear pricing, friendly people and work we stand behind.`,
    ],
  };
  const pitch = rng.pick(isLocal ? pitchBank.local : pitchBank.default);
  const valueProp = isLocal
    ? `The ${what} for ${f.audience} who want ${lowerFirst(desire)}, with upfront pricing and a satisfaction promise.`
    : `The only ${f.formatNoun.toLowerCase()} built specifically for ${f.audience} who want to ${outcome}.`;
  const audience = d.audience
    ? d.audience
    : `${capitalize(f.audience)} who are tired of ${pain} and want ${lowerFirst(desire)}. They value ${rng.pick(['clear steps over theory', 'saving time', 'trustworthy advice', 'results they can see quickly', 'a personal touch'])} and are ready to invest in a solution that fits their routine.`;
  const mission = `To make ${f.topicLower} ${rng.pick(['simple', 'stress-free', 'approachable', 'rewarding'])} for every ${singular(f.audience)}.`;

  // ── visual identity
  const paletteOptions = [...prof.palettes.map(paletteFrom), paletteFrom(complementary(prof.palettes[0][0]))];
  const colors = paletteOptions[variation % paletteOptions.length];
  const iconOptions = suggestIcons(`${project.niche} ${project.category} ${project.businessType} ${prof.label}`, prof.icon);
  const shape = rng.pick(SHAPE_BY_TONE[tone]);
  const font = prof.id === 'tech' && rng.chance(0.5) ? 'mono' : rng.pick(FONT_BY_TONE[tone]);
  const bannerStyle = rng.pick<BannerStyle>(['waves', 'grid', 'blobs', 'split']);
  const slug = slugify(brandName);
  const bare = slug.replace(/-/g, '');
  const domainIdeas = [`${bare}.com`, `get${bare}.com`, `${bare}.co`, isLocal && f.city ? `${bare}${slugify(f.city).replace(/-/g, '')}.com` : `${bare}hq.com`];

  return {
    nameOptions,
    tagline,
    pitch,
    valueProp,
    audience,
    personality: PERSONALITY[tone],
    mission,
    slug,
    domainIdeas,
    colors,
    paletteOptions,
    icon: iconOptions[0],
    iconOptions,
    shape,
    font,
    bannerStyle,
  };
}
