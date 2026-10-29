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
  scoreBonus: number;
}

const ANGLES: Angle[] = [
  { id: 'system', label: 'Done-for-you system', priceFactor: 1.05, scoreBonus: 6 },
  { id: 'sprint', label: 'Fast-start sprint', priceFactor: 0.9, scoreBonus: 4 },
  { id: 'foundation', label: 'Beginner foundation', priceFactor: 0.85, scoreBonus: 2 },
  { id: 'pro', label: 'Advanced playbook', priceFactor: 1.35, scoreBonus: 3 },
  { id: 'micro', label: 'Underserved micro-niche', priceFactor: 1.1, scoreBonus: 5 },
];

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
  // keep the strongest angle first so the list reads as ranked
  angles.sort((a, b) => b.scoreBonus - a.scoreBonus);
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
      `The shortcut ${audience} use to ${verbOutcome(outcome)}, without ${lowerFirst(pain)}.`,
      `Everything you need to ${verbOutcome(outcome)}, in one ${noun.toLowerCase()}.`,
      `${capitalize(verbOutcome(outcome))}. No guesswork, no ${lowerFirst(pain)}.`,
    ];
    const hook = hookBank[(i + rng.int(0, 3)) % hookBank.length];

    const solutionBank: Record<ProductFormat, string> = {
      pdf: `A step-by-step ${noun.toLowerCase()} with checklists, worked examples and a one-page action plan.`,
      course: `Bite-sized video lessons, worksheets and weekly milestones that walk ${audience} from zero to ${lowerFirst(outcome)}.`,
      template: `Ready-to-use templates with instructions, examples and a quick-start video. Duplicate and go.`,
      spreadsheet: `A plug-and-play spreadsheet with auto-calculating dashboards, built-in formulas and a 5-minute setup guide.`,
      software: `A focused web app that automates the busywork and shows exactly what to do next.`,
      design: `A pack of on-brand, editable assets in Canva, Figma and PNG formats.`,
      audio: `Short, guided audio sessions to use on the go, with transcripts and a progress tracker.`,
      membership: `Monthly playbooks, live Q&A and a private community of ${audience} working on the same goal.`,
      ebook: `A practical book with real examples, exercises at the end of every chapter and a printable summary.`,
    };

    const featureBank: Record<ProductFormat, string[]> = {
      pdf: [`${rng.int(7, 12)} focused chapters with action steps`, `Printable ${prof.terms[0]} checklist`, `Real-world examples for ${audience}`, 'One-page quick-start plan'],
      course: [`${rng.int(5, 8)} modules, ${rng.int(20, 36)} short lessons`, 'Worksheets and templates for every module', `Live Q&A replay library`, 'Certificate and lifetime updates'],
      template: [`${rng.int(8, 15)} ready-to-duplicate templates`, `Pre-built ${prof.terms[0]} dashboard`, 'Video walkthrough for setup', 'Free updates'],
      spreadsheet: [`Auto-calculating ${prof.terms[0]} dashboard`, `Pre-filled ${prof.terms[1] ?? 'category'} tabs`, 'Works in Google Sheets and Excel', 'Monthly progress charts'],
      software: [`One-click ${prof.terms[0]} setup`, 'Smart reminders and weekly reports', 'Mobile-friendly dashboard', 'Export to CSV and PDF'],
      design: [`${rng.int(60, 180)} editable assets`, 'Canva + Figma source files', 'Commercial license included', 'Color and font guide'],
      audio: [`${rng.int(8, 15)} guided tracks`, 'Under 15 minutes each', 'Transcripts and worksheets', 'Offline listening'],
      membership: ['New playbook every month', 'Live monthly Q&A', 'Private member community', 'Template vault access'],
      ebook: [`${rng.int(8, 14)} chapters with exercises`, 'Kindle, ePub and PDF formats', 'Printable summary sheet', 'Bonus resource list'],
    };

    const [lo, hi] = fmt.price;
    const raw = rng.float(lo, hi) * prof.priceMult * angle.priceFactor;
    const price = charmPrice(raw);
    const priceModel: PriceModel = fmt.model;
    const priceScore = clamp((price - lo) / Math.max(1, hi - lo), 0, 1);
    const specificity = clamp((category.trim().split(/\s+/).length - 1) * 4, 0, 10);
    const score = Math.round(
      clamp(
        prof.demand * 34 + (1 - prof.competition) * 16 + priceScore * 12 + fmt.scalability * 14 + specificity + angle.scoreBonus + rng.float(-4, 6),
        41,
        97,
      ),
    );
    const monthly = Math.max(3, Math.round(Math.pow(score / 100, 2.2) * fmt.volume * (angle.id === 'pro' ? 0.7 : 1)));
    const revenueLow = Math.round((price * monthly * 0.55) / 10) * 10;
    const revenueHigh = Math.round((price * monthly * 1.45) / 10) * 10;

    const signals = rng.pickN(
      [
        `Steady search interest for “${topicLower} ${fmt.short.toLowerCase()}” style queries`,
        `${capitalize(audience)} regularly ask about ${lowerFirst(pain)} in online communities`,
        `Few ${fmt.label.toLowerCase()} target ${audience} specifically`,
        `The problem costs ${audience} real time or money, so willingness to pay is high`,
        `${fmt.label} sell well at ${price < 30 ? 'impulse-buy' : price < 120 ? 'mid-ticket' : 'premium'} prices in this niche`,
        `Easy to bundle with a free ${prof.terms[0]} checklist as a lead magnet`,
      ],
      3,
    );

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
      score,
      revenueLow,
      revenueHigh,
      angle: angle.label,
      features: rng.pickN(featureBank[format], 3),
      signals,
    };
  });
}
