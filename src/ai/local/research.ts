import type { Directives, PriceModel, ProductFormat, ProductIdea } from '@/lib/types';
import { capitalize, clamp, createRng, hashStr, lowerFirst, titleCase, uid } from '@/lib/utils';
import { extractAudience, FORMATS } from '../knowledge';
import { anchoredOutcomes, anchoredPains, isSpecificCategory, resolveNiche, singular, verbOutcome } from '../text';

export interface ResearchInput {
  niche: string;
  category: string;
  format: ProductFormat;
  count?: number;
  variation?: number;
}

/** Charm pricing: 9 → 9, 23 → 27, 41 → 47, 130 → 147, 260 → 297 */
export function charmPrice(n: number): number {
  if (n <= 10) return Math.max(5, Math.round(n));
  if (n < 100) {
    const tens = Math.floor(n / 10) * 10;
    const candidates = [tens + 7, tens + 9, tens - 3];
    return candidates.reduce((best, c) => (Math.abs(c - n) < Math.abs(best - n) ? c : best), candidates[0]);
  }
  const hundreds = Math.floor(n / 100) * 100;
  const candidates = [hundreds + 47, hundreds + 97, hundreds - 3];
  return candidates.reduce((best, c) => (Math.abs(c - n) < Math.abs(best - n) ? c : best), candidates[0]);
}

interface Angle {
  id: string;
  label: string;
  priceFactor: number;
}

const ANGLES: Angle[] = [
  { id: 'system', label: 'Done-for-you system', priceFactor: 1.05 },
  { id: 'sprint', label: 'Fast-start sprint', priceFactor: 0.9 },
  { id: 'foundation', label: 'Beginner foundation', priceFactor: 0.85 },
  { id: 'pro', label: 'Advanced playbook', priceFactor: 1.35 },
  { id: 'micro', label: 'Focused micro-niche', priceFactor: 1.1 },
];

export interface FitInput {
  niche: string;
  category: string;
  format: ProductFormat;
  audience: string;
  pain: string;
  /** the angle's label, e.g. "Beginner foundation" (AI angles fall back to a general reason) */
  angle: string;
}

/**
 * "Why this could fit you": reasons drawn only from what the owner told us (niche, category,
 * format) and the idea itself. No market data, so no claims about demand or competition.
 */
export function fitReasons(x: FitInput): string[] {
  const niche = x.niche.trim();
  const category = x.category.trim();
  const topic = category || niche;
  const audience = x.audience.trim() || 'your buyers';
  const short = FORMATS[x.format]?.short.toLowerCase() ?? 'product';
  const angleId = ANGLES.find((a) => a.label.toLowerCase() === x.angle.trim().toLowerCase())?.id ?? (/micro-niche$/i.test(x.angle.trim()) ? 'micro' : '');
  const byAngle: Record<string, string> = {
    system: 'Done-for-you: buyers get something ready to use, not just advice.',
    sprint: 'Short and time-boxed, with a clear finish line.',
    foundation: `Starts from the basics, for ${audience} who are new to this.`,
    pro: `Goes deeper, for ${audience} who already know the basics.`,
    micro: `Speaks to one group (${audience}) instead of everyone in ${niche || 'your niche'}.`,
  };
  const reasons = [
    byAngle[angleId],
    x.pain.trim() ? `Made for ${audience}, around one problem: ${lowerFirst(x.pain.trim())}.` : `Made for ${audience}.`,
    topic ? `A ${short} on “${topic}”: the topic and format you chose.` : `A ${short}: the format you chose.`,
  ];
  return reasons.filter((r): r is string => !!r);
}

export function generateProductIdeas(input: ResearchInput, d: Directives = {}): ProductIdea[] {
  const { niche, category, format } = input;
  const count = clamp(input.count ?? 4, 3, 5);
  const rng = createRng(hashStr(`${niche}|${category}|${format}|${input.variation ?? 0}`));
  const prof = resolveNiche(niche, category);
  const fmt = FORMATS[format];
  const topic = titleCase((category || niche).trim()) || prof.label;
  const topicLower = topic.toLowerCase();
  const specific = isSpecificCategory(prof, category);
  const pains = specific ? [anchoredPains(topicLower)[0], prof.pains[0], anchoredPains(topicLower)[1], prof.pains[1], anchoredPains(topicLower)[2]] : prof.pains;
  const outcomes = specific ? [anchoredOutcomes(topicLower)[0], prof.outcomes[0], anchoredOutcomes(topicLower)[1], prof.outcomes[1], anchoredOutcomes(topicLower)[2]] : prof.outcomes;
  const baseAudience = d.audience || extractAudience(`${category} ${niche}`) || prof.audiences[0];
  const angles = rng.shuffle(ANGLES).slice(0, count);
  const usedNouns = new Set<string>();
  const nounFor = () => {
    const pool = fmt.nouns.filter((n) => !usedNouns.has(n));
    const n = rng.pick(pool.length ? pool : fmt.nouns);
    usedNouns.add(n);
    return n;
  };

  return angles.map((angle, i) => {
    const noun = nounFor();
    const audience = angle.id === 'micro' ? rng.pick(prof.audiences.filter((a) => a !== baseAudience)) ?? baseAudience : baseAudience;
    const pain = pains[(i + rng.int(0, 2)) % pains.length];
    const outcome = outcomes[(i + rng.int(0, 1)) % outcomes.length];
    const days = rng.pick([7, 14, 21, 30]);
    const titleBank: Record<string, string[]> = {
      system: [`The ${topic} ${noun}`, `${topic} on Autopilot: The ${noun}`, `The Plug-and-Play ${topic} ${noun}`],
      sprint: [`${days}-Day ${topic} ${noun}`, `The ${days}-Day ${topic} Reset`, `${topic} in ${days} Days`],
      foundation: [`${topic} from Scratch`, `The Beginner’s ${topic} ${noun}`, `${topic} 101: The ${noun}`],
      pro: [`The ${topic} ${noun} for ${titleCase(audience)}`, `Advanced ${topic}: The Pro ${noun}`, `The ${topic} Operator’s ${noun}`],
      micro: [`${topic} for ${titleCase(audience)}`, `The ${titleCase(singular(audience))}’s ${topic} ${noun}`, `${topic} ${noun}: ${titleCase(audience)} Edition`],
    };
    let title = rng.pick(titleBank[angle.id]);
    if (!title.toLowerCase().includes(noun.toLowerCase()) && angle.id !== 'sprint' && rng.chance(0.5)) title = `${title} ${noun}`;
    title = title.replace(/\s+/g, ' ').trim();

    const hookBank = [
      `Stop ${lowerFirst(pain)}. ${capitalize(verbOutcome(outcome))} with a ${noun.toLowerCase()} built for ${audience}.`,
      `A shortcut for ${audience} to ${verbOutcome(outcome)}, without ${lowerFirst(pain)}.`,
      `Everything you need to ${verbOutcome(outcome)}, in one ${noun.toLowerCase()}.`,
      `${capitalize(verbOutcome(outcome))}. No guesswork, no ${lowerFirst(pain)}.`,
    ];
    const hook = hookBank[(i + rng.int(0, 3)) % hookBank.length];

    const solutionBank: Record<ProductFormat, string> = {
      pdf: `A step-by-step ${noun.toLowerCase()} with checklists, worked examples and a one-page action plan.`,
      course: `Bite-sized video lessons, worksheets and weekly milestones that walk ${audience} from zero to ${lowerFirst(outcome)}.`,
      template: `Ready-to-use templates with instructions, examples and a quick-start video. Duplicate and go.`,
      spreadsheet: `A plug-and-play spreadsheet with auto-calculating dashboards, built-in formulas and a short setup guide.`,
      software: `A focused web app that automates the busywork and shows exactly what to do next.`,
      design: `A pack of on-brand, editable assets in Canva, Figma and PNG formats.`,
      audio: `Short, guided audio sessions to use on the go, with transcripts and a progress tracker.`,
      membership: `Monthly playbooks, live Q&A and a private community of ${audience} working on the same goal.`,
      ebook: `A practical book with real examples, exercises at the end of every chapter and a printable summary.`,
    };

    // Suggested contents only: counts (chapters, lessons, templates…) are the owner's to decide in the outline.
    const featureBank: Record<ProductFormat, string[]> = {
      pdf: ['Focused chapters with action steps', `Printable ${prof.terms[0]} checklist`, `Real-world examples for ${audience}`, 'One-page quick-start plan'],
      course: ['Modules of short video lessons', 'Worksheets and templates for every module', 'Live Q&A replay library', 'Completion certificate'],
      template: ['Ready-to-duplicate templates', `Pre-built ${prof.terms[0]} dashboard`, 'Video walkthrough for setup', 'A filled-in example of each template'],
      spreadsheet: [`Auto-calculating ${prof.terms[0]} dashboard`, `Pre-filled ${prof.terms[1] ?? 'category'} tabs`, 'Works in Google Sheets and Excel', 'Monthly progress charts'],
      software: [`One-click ${prof.terms[0]} setup`, 'Smart reminders and weekly reports', 'Mobile-friendly dashboard', 'Export to CSV and PDF'],
      design: ['A pack of editable assets', 'Canva + Figma source files', 'A clear usage license', 'Color and font guide'],
      audio: ['Short guided tracks', 'Each track under 15 minutes', 'Transcripts and worksheets', 'Offline listening'],
      membership: ['New playbook every month', 'Live monthly Q&A', 'Private member community', 'Template vault access'],
      ebook: ['Chapters that end with exercises', 'Kindle, ePub and PDF formats', 'Printable summary sheet', 'Bonus resource list'],
    };

    // A suggestion, not a forecast: the middle of the format's usual range, adjusted for the niche and angle.
    const [lo, hi] = fmt.price;
    const price = charmPrice(((lo + hi) / 2) * prof.priceMult * angle.priceFactor);
    const priceModel: PriceModel = fmt.model;

    return {
      id: uid('idea'),
      title,
      hook,
      audience,
      pain: capitalize(pain),
      solution: solutionBank[format],
      format,
      price,
      priceModel,
      angle: angle.label,
      features: rng.pickN(featureBank[format], 3),
      fit: fitReasons({ niche, category, format, audience, pain, angle: angle.label }),
    };
  });
}
