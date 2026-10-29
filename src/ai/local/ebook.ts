// Built-in copy for a product file (no Claude): title page, welcome, how to use it,
// one workbook page per chapter, closing chapter, next steps and a fitting disclaimer.

import type { Project } from '@/lib/types';
import { buildFacts } from '../text';

export interface EbookWorksheet {
  title: string;
  intro: string;
  prompts: string[];
  checklist: string[];
}

export interface EbookExtras {
  title: string;
  subtitle: string;
  /** Markdown */
  welcome: string;
  howToUse: string[];
  /** Markdown */
  conclusion: string;
  nextSteps: string[];
  disclaimer: string;
  /** one per outline section, in order */
  worksheets: EbookWorksheet[];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One or two sentences that fit the niche: never a promise of results. */
export function disclaimerFor(text: string): string {
  if (/tax|financ|money|invest|budget|debt|account|bookkeep/i.test(text)) return 'This guide shares general information and practical tips. It is not tax, legal or financial advice; check your own situation with a qualified professional. Results vary.';
  if (/fitness|workout|health|diet|nutrition|meal|weight|wellness|yoga|sleep|mental/i.test(text)) return 'This guide shares general information, not medical advice. Check with your doctor before starting a new exercise, diet or wellness plan. Results vary.';
  if (/legal|law|contract|immigration/i.test(text)) return 'This guide shares general information, not legal advice. Talk to a qualified lawyer about your situation.';
  return 'This guide shares general information and practical tips based on experience. Results vary with your situation and the effort you put in.';
}

export function localEbookExtras(project: Project): EbookExtras {
  const f = buildFacts(project);
  const noun = (f.formatNoun || 'Guide').toLowerCase();
  const outline = project.studio.outline;
  const title = project.idea?.title || project.studio.listing.title || `${f.topic} ${f.formatNoun || 'Guide'}`;
  return {
    title,
    subtitle: project.idea?.hook || project.brand.valueProp || `A practical ${noun} to help ${f.audience} ${f.outcomes[1] ?? f.outcome}.`,
    welcome: [
      `Welcome! This ${noun} is for **${f.audience}** who are done with ${f.pain}.`,
      `Inside you'll find a simple, step-by-step path to ${f.desire}. Every chapter ends with a workbook page, so you finish with a plan of your own, not just notes.`,
      `Start small: ${f.quickWins[0] ?? 'pick one idea and try it this week'}. Small steps add up faster than you think.`,
    ].join('\n\n'),
    howToUse: [
      'Read the chapters in order: each one builds on the last.',
      'Do the workbook page at the end of each chapter before moving on.',
      'Tick off the action checklists as you go, and come back to them each week.',
      'Use the contents page to jump straight back to any chapter.',
    ],
    conclusion: [
      `You made it to the end, and that already puts you ahead. You now have a clear way to ${f.outcomes[1] ?? f.outcome}.`,
      'Keep it simple: come back to your workbook pages once a week, adjust what isn’t working, and keep what is.',
    ].join('\n\n'),
    nextSteps: [cap(f.quickWins[0] ?? 'Pick your first action today'), cap(f.quickWins[1] ?? 'Put a weekly check-in on your calendar'), cap(f.quickWins[2] ?? 'Share what you learned with a friend')].map((s) => s.replace(/\.?$/, '.')),
    disclaimer: disclaimerFor(`${project.niche} ${project.category} ${title}`),
    worksheets: outline.map((sec) => {
      const items = sec.items.map((i) => i.title);
      return {
        title: `${sec.title}: your plan`,
        intro: 'Use this page to turn the chapter into action. Answer in your own words; short answers are fine.',
        prompts: [
          `What is the one idea from this chapter you'll put to work first?`,
          items[0] ? `How will you apply “${items[0]}” in the next seven days?` : 'What will you do differently this week?',
          'What could get in the way, and what will you do when it does?',
        ],
        checklist: (items.length ? items : ['Re-read the key points', 'Try one idea this week', 'Note what worked']).slice(0, 5),
      };
    }),
  };
}
