import type {
  Directives,
  ListingDraft,
  OperatingBlock,
  OutlineItem,
  OutlineSection,
  Project,
  ServicePackage,
  ValueStackItem,
} from '@/lib/types';
import { capitalize, hashStr, lowerFirst, titleCase, uid } from '@/lib/utils';
import { FORMATS, PRODUCT_CATEGORIES } from '../knowledge';
import { buildFacts, singular, verbOutcome, Voice, type Facts } from '../text';

const item = (title: string, meta?: string, detail?: string): OutlineItem => ({ id: uid('it'), title, meta, detail });
const section = (title: string, summary: string, items: OutlineItem[]): OutlineSection => ({ id: uid('sec'), title, summary, items });

export interface OutlineResult {
  label: string;
  sections: OutlineSection[];
}

export function generateOutline(project: Project, d: Directives = {}, variation = 0): OutlineResult {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|outline|${variation}`));
  const rng = v.rng;
  const fmt = project.format ? FORMATS[project.format] : FORMATS.pdf;
  const T = f.topic;
  const t = f.topicLower;
  const term = (i: number) => f.terms[i % f.terms.length];
  const Term = (i: number) => titleCase(term(i));
  const outcome = (i: number) => verbOutcome(f.outcomes[i % f.outcomes.length]);
  // Lengths, page counts and how-many are the owner's to set: the outline names the kind of item and leaves the
  // number as a placeholder (it is quoted to buyers as contents, so a made-up "12 min" or "40 templates" would be a claim).
  const vid = 'Video · [length]';
  const pages = () => '[pages]';
  const longer = d.length === 'long';
  const shorter = d.length === 'short';

  switch (project.format) {
    case 'course': {
      const modules: OutlineSection[] = [
        section(`Foundations: Why ${T} Feels Hard`, `Reset expectations and measure where ${f.audience} are starting from.`, [
          item('Welcome & how to get the most from this course', vid),
          item(`The real reason behind ${f.pain}`, vid),
          item(`Your ${t} baseline audit`, 'Worksheet'),
          item('Set your 30-day target', vid),
        ]),
        section(`Set Up Your ${Term(0)} System`, `Build the simple setup everything else runs on.`, [
          item(`Build your ${term(0)}`, vid),
          item(`Configure ${term(1)}`, vid),
          item('Templates & tools walkthrough', 'Screen recording · [length]'),
          item(`Quick win: ${f.quickWins[0]}`, 'Action step'),
        ]),
        section('The Core Method, Step by Step', `A step-by-step method for ${f.audience} who want to ${outcome(0)}.`, [
          item(`Step 1: ${capitalize(f.quickWins[1] ?? 'get organized')}`, vid),
          item(`Step 2: Build momentum with ${term(2)}`, vid),
          item(`Step 3: Review, adjust, repeat`, vid),
          item(`Avoid this: ${f.mistakes[0]}`, vid),
          item('Module quiz', '[how many] questions'),
        ]),
        section('Make It a Routine', 'Turn the method into a weekly habit.', [
          item(`A weekly ${t} routine`, vid),
          item('Automations worth setting up', vid),
          item(`Track progress with ${term(3)}`, 'Worksheet'),
        ]),
        section(`Level Up: ${capitalize(outcome(1))}`, `Advanced moves once the basics are automatic.`, [
          item(`${capitalize(outcome(1))}`, vid),
          item(`Scaling up: ${outcome(2)}`, vid),
          item(`Case study: a ${singular(f.audience)} start to finish`, vid),
        ]),
        section('Troubleshooting & Common Objections', 'What to do when life gets in the way.', [
          item(`When “${lowerFirst(f.objections[0])}”`, vid),
          item(`When “${lowerFirst(f.objections[1])}”`, vid),
          item(`Myth vs. fact: ${lowerFirst(f.myths[0])}`, vid),
        ]),
      ];
      if (!shorter) modules.push(section('Bonus: Your Next 90 Days', 'Plan what comes after the course.', [item('Your 90-day plan template', 'Template'), item('Next steps [and any community or coaching you offer]', vid)]));
      return { label: fmt.outlineLabel, sections: longer ? modules : modules.slice(0, shorter ? 5 : 7) };
    }
    case 'pdf':
    case 'ebook': {
      const chapters: OutlineSection[] = [
        section(`Introduction: ${capitalize(f.desire)}`, 'Who this is for and how to use it.', [item('Who this guide is for', pages()), item('How to use this guide', pages()), item('Your starting point', pages())]),
        section(`Why ${capitalize(f.pain)} Happens`, 'The root causes nobody talks about.', [item('Common causes', pages()), item(`Myth: ${f.myths[0]}`, pages()), item('Self-assessment quiz', pages())]),
        section(`${T} Fundamentals`, 'The few concepts that matter most.', f.terms.slice(0, 4).map((x) => item(capitalize(x), pages()))),
        section(`Step by Step: Build Your ${Term(0)} System`, `A step-by-step process for ${f.audience} who want to ${outcome(0)}.`, [
          item(`Step 1: ${capitalize(f.quickWins[0])}`, pages()),
          item(`Step 2: Set up ${term(1)}`, pages()),
          item(`Step 3: Make ${term(2)} automatic`, pages()),
          item('Step 4: Review weekly', pages()),
        ]),
        section(`${f.mistakes.length} Mistakes to Avoid`, 'Learn from what trips most people up.', f.mistakes.map((m) => item(capitalize(m), pages()))),
        section(`Real-World Examples for ${titleCase(f.audience)}`, 'See the method applied.', [item(`Example 1: ${capitalize(outcome(1))}`, pages()), item(`Example 2: ${capitalize(outcome(2))}`, pages()), item('Before & after templates', pages())]),
        section('Your 30-Day Action Plan', 'Day-by-day checklist.', [item('Week 1: Setup', pages()), item('Week 2: Momentum', pages()), item('Week 3: Routines', pages()), item('Week 4: Review & level up', pages())]),
        section('Troubleshooting & FAQ', 'Answers to the questions readers ask most.', f.objections.slice(0, 3).map((o) => item(`“${o}”`, pages()))),
      ];
      if (project.format === 'ebook' || longer) chapters.push(section('Resources & Templates', 'Everything referenced in this book.', [item('Printable checklists', pages()), item('Recommended tools', pages()), item('Glossary', pages())]));
      return { label: fmt.outlineLabel, sections: shorter ? chapters.slice(0, 6) : chapters };
    }
    case 'template': {
      const platform = rng.pick(['Notion', 'Google Docs', 'Canva', 'Notion']);
      return {
        label: fmt.outlineLabel,
        sections: [
          section('Core Templates', `The everyday templates ${f.audience} use most.`, [
            item(`${T} Dashboard`, platform, `One home base that shows ${term(0)}, ${term(1)} and this week’s priorities.`),
            item(`${Term(0)} Tracker`, platform, `A place to log ${term(0)} entries.`),
            item(`${Term(1)} Template`, platform),
            item('Quick-Start Checklist', platform, 'Step-by-step setup for each template.'),
          ]),
          section('Planning & Review', 'Weekly and monthly planning and review.', [
            item('Weekly Planner', platform),
            item('Monthly Review', platform, 'Prompts to review what worked and plan next month.'),
            item('Goal Setting Worksheet', platform),
          ]),
          section('Bonus Templates', 'Extras that remove the next obstacle.', [
            item(`${Term(2)} Swipe File`, platform),
            item(`${capitalize(f.quickWins[0])}: Checklist`, platform),
            item('[Video walkthrough, if you record one]', 'Video · [length]'),
          ]),
        ],
      };
    }
    case 'spreadsheet': {
      return {
        label: fmt.outlineLabel,
        sections: [
          section('Start Here', 'Setup guide and settings.', [item('How to use this spreadsheet', 'Instructions tab'), item('Settings: currency, start month, targets', 'Inputs')]),
          section('Dashboard', `See ${term(0)} and progress at a glance.`, [
            item(`${Term(0)} summary cards`, 'SUMIFS + charts'),
            item('Monthly trend chart', 'Line chart'),
            item(`Progress toward goal: ${outcome(0)}`, 'Progress bar formula'),
          ]),
          section(`${Term(1)} Log`, 'Where daily entries go.', [
            item('Columns: Date, Description, Category, Amount, Status', 'Data validation dropdowns'),
            item('Auto-categorization rules', 'IFS + XLOOKUP'),
            item('Conditional formatting for overdue items', 'Rules'),
          ]),
          section('Monthly Summary', 'Totals by category and month.', [item('Pivot-style summary', 'QUERY / SUMIFS'), item('Month-over-month change', 'Percent change formulas')]),
          section('Annual Overview', 'The year on one page.', [item('12-month heatmap', 'Conditional formatting'), item('Year-end report export', 'Print-ready layout')]),
        ],
      };
    }
    case 'software': {
      return {
        label: fmt.outlineLabel,
        sections: [
          section('MVP Features', `Only what ${f.audience} need to ${outcome(0)}.`, [
            item(`Guided ${term(0)} setup`, 'Must-have', `As a ${singular(f.audience)}, I can set up my ${term(0)} with a guided, step-by-step flow.`),
            item(`${Term(1)} tracking`, 'Must-have', `As a ${singular(f.audience)}, I can log ${term(1)} from my phone.`),
            item('Reminders', 'Must-have', `Reminders about ${term(0)} at times the user chooses.`),
            item('Weekly progress report', 'Should-have', 'Email + in-app summary of wins and next actions.'),
            item('Export to CSV / PDF', 'Should-have'),
            item('Team / partner sharing', 'Could-have'),
          ]),
          section('Tech Stack & Architecture', 'Lean, cheap to run, easy to iterate.', [
            item('Frontend: React + TypeScript', 'Web app, mobile-first'),
            item('Backend: serverless API + Postgres', 'Auth, data, scheduled jobs'),
            item('Payments: subscription billing', `${f.priceStr}/mo plan [annual option, if you offer one]`),
            item('Analytics: product events + activation funnel', 'Track time-to-first-value'),
          ]),
          section('Launch Roadmap', 'Ship in phases and learn from real users.', [
            item('Phase 1: private beta with [how many] users', 'Validate core loop'),
            item('Phase 2: public launch + onboarding emails', 'Activation focus'),
            item('Phase 3: [integrations or a referral program, if you plan them]', 'Growth focus'),
          ]),
        ],
      };
    }
    case 'design': {
      return {
        label: fmt.outlineLabel,
        sections: [
          section('Social Media Pack', 'Ready-to-post templates.', [item('[How many] feed post templates', 'Canva + Figma'), item('[How many] story templates', 'Canva + Figma'), item('Carousel templates', '[how many] layouts')]),
          section('Brand Essentials', 'Make everything look consistent.', [item('Logo variations & usage guide', 'SVG / PNG'), item('Color palettes', '[how many] palettes'), item('Font pairings', '[how many] pairings')]),
          section('Graphics & Icons', 'Drop-in visual elements.', [item('Icon set', '[how many] icons · SVG'), item('Illustrated spot graphics', 'PNG / SVG'), item('Textures & backgrounds', 'JPG')]),
          section('Mockups', 'Show your work professionally.', [item('Device mockups', 'PSD / Figma'), item('Print mockups', 'PSD'), item('[Video tutorial, if you include one]', 'Video · [length]')]),
        ],
      };
    }
    case 'audio': {
      const aud = 'Audio · [length]';
      return {
        label: fmt.outlineLabel,
        sections: [
          section('Series 1: Foundations', 'Start here.', [item(`Welcome: how to use these sessions`, aud), item(`Understanding ${t}`, aud), item(`On ${f.pain}`, aud)]),
          section('Series 2: Daily Sessions', 'Short sessions for every day of the week.', ['Morning reset', 'Midday focus', 'Evening wind-down', 'Weekend reflection'].map((x) => item(x, aud))),
          section('Series 3: Deep Dives', 'Longer sessions on one theme each.', [item(capitalize(outcome(0)), aud), item(capitalize(outcome(1)), aud), item('[Bonus: guided Q&A, if you include one]', aud)]),
        ],
      };
    }
    case 'membership': {
      // One tier at the owner's price. Extra tiers, perks and anything live are the owner's to add.
      const owner = project.studio?.price || project.idea?.price;
      const price = owner ? `$${owner}/mo` : '[your price]/mo';
      return {
        label: fmt.outlineLabel,
        sections: [
          section(`Membership · ${price}`, 'What members get.', [item('[What members get every month]'), item('[Community space, if you run one]'), item('[Templates or resources included]')]),
          section('Monthly Content Calendar', 'What members get each week.', [
            item('Week 1: [New content drop]', `Topic: ${capitalize(outcome(0))}`),
            item('Week 2: [Your choice: live session, Q&A or tutorial]'),
            item('Week 3: Template or tool release', `${Term(0)} toolkit`),
            item('Week 4: Wins & review thread', 'Members share progress'),
          ]),
        ],
      };
    }
    default:
      return generateOutline({ ...project, format: 'pdf' }, d, variation);
  }
}

export function draftSection(project: Project, sec: OutlineSection, d: Directives = {}, variation = 0): string {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${sec.id}|draft|${variation}`));
  const points = sec.items.map((i) => i.title);
  const n = v.count(3, 4, 6);
  const lines = [
    `# ${sec.title}`,
    '',
    `## Goal`,
    `By the end of this section, ${f.audience} will be able to ${verbOutcome(v.pick(f.outcomes))}.`,
    '',
    `## Why it matters`,
    `${v.hook('educational')} ${capitalize(sec.summary ?? '')} Most ${f.audience} skip this step and end up ${f.mistakes[0]}.`,
    '',
    `## Key points`,
    ...points.slice(0, n).map((p) => `- **${p}.** ${capitalize(v.pick(['Here is the simple version:', 'In practice:', 'Do this:', 'The short answer:']))} ${v.pick(f.quickWins)}.`),
    '',
    `## Action steps`,
    ...v.rng.pickN(f.quickWins, Math.min(3, f.quickWins.length)).map((q, i) => `${i + 1}. ${capitalize(q)}.`),
    '',
    `## Recap`,
    `You now have a clear path to ${lowerFirst(f.desire)}. Next up: ${v.pick(['put it into practice this week', 'move on to the next section', 'complete the worksheet before continuing'])}.`,
  ];
  return lines.join('\n');
}

export function expandItem(project: Project, it: OutlineItem, d: Directives = {}, variation = 0): string {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${it.id}|expand|${variation}`));
  const parts = [
    `Talking points: ${v.pick(f.terms)}, ${v.pick(f.quickWins)}, and how to avoid ${v.pick(f.mistakes)}.`,
    `Example (hypothetical): walk through how a ${singular(f.audience)} ${v.pick(['starting from zero', 'who feels stuck', 'trying this for the first time'])} could use this to ${verbOutcome(v.pick(f.outcomes))}.`,
    `Deliverable: ${v.pick(['a one-page worksheet', 'a short checklist', 'a fill-in template', 'a 3-question reflection'])}.`,
  ];
  return parts.slice(0, v.count(2, 3, 3)).join(' ');
}

// ───────────────────────── Business model ─────────────────────────

export interface BusinessModelResult {
  packages: ServicePackage[];
  operating: OperatingBlock[];
  valueStack: ValueStackItem[];
  price: number;
}

export function generateBusinessModel(project: Project, d: Directives = {}, variation = 0): BusinessModelResult {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|biz|${variation}`));
  const rng = v.rng;
  const bt = f.business!;
  const services = bt.services.filter((s) => s.unit !== 'free');
  const sorted = services.slice().sort((a, b) => a.price[0] - b.price[0]);
  const mid = (r: [number, number]) => Math.round((r[0] + r[1]) / 2);
  const tierServices = [sorted[0], sorted[Math.min(1, sorted.length - 1)], sorted[Math.min(2, sorted.length - 1)]];
  // "Most popular" is the owner's call: keep the flag only on a tier the owner already marked.
  const ownerPopular = new Set((project.studio?.packages ?? []).filter((p) => p.popular).map((p) => p.name.trim().toLowerCase()));
  const packages: ServicePackage[] = bt.tiers.map((name, i) => {
    const svc = tierServices[i] ?? sorted[0];
    const base = mid(svc.price);
    const price = i === 0 ? base : i === 1 ? Math.max(base, Math.round(mid(tierServices[0].price) * 1.8)) : Math.max(base, Math.round(mid(tierServices[0].price) * 3.1));
    // No guarantee or perks here: only the owner can promise those (Structure tab value stack, listing description).
    // Includes describe the service itself; anything extra is a bracketed slot for the owner.
    const includes = [
      svc.name + (svc.duration ? ` (${svc.duration})` : ''),
      ...rng.pickN(bt.delivery, i === 0 ? 2 : 3),
      ...(i >= 1 ? ['[Anything extra this package includes]'] : []),
    ];
    return {
      id: uid('pkg'),
      name,
      price: price >= 100 ? Math.round(price / 5) * 5 : price,
      priceModel: svc.unit === 'monthly' ? 'monthly' : svc.unit,
      description:
        i === 0
          ? `The starting package: ${lowerFirst(svc.name)} for ${f.audience} trying ${f.brand} for the first time.`
          : i === 1
            ? `The middle package: ${lowerFirst(svc.name)} with more included.`
            : `The most complete package: ${lowerFirst(svc.name)} with the most included.`,
      includes: [...new Set(includes)],
      popular: ownerPopular.has(name.trim().toLowerCase()),
    };
  });

  const operating: OperatingBlock[] = [
    { id: uid('op'), title: 'Customer journey & booking', items: bt.bookingFlow },
    { id: uid('op'), title: 'Service delivery standard', items: bt.delivery },
    // Role names only: a credential ("licensed", "certified") is the owner's to state.
    { id: uid('op'), title: 'Team & roles', items: teamRoles(bt.roles) },
    { id: uid('op'), title: 'Tools & tech stack', items: bt.tools },
    // Hours and capacity are the owner's to fill in, not a template's.
    { id: uid('op'), title: 'Hours & capacity', items: ['Opening hours: [your hours]', 'Weekly capacity: [how many jobs or appointments you can take]', f.city ? `Service area: ${f.city}${f.region ? `, ${f.region}` : ''}` : 'Service area: [where you work]'] },
    { id: uid('op'), title: 'Revenue streams', items: bt.revenue },
    { id: uid('op'), title: 'Cost structure', items: bt.costs },
    { id: uid('op'), title: 'KPIs to track weekly', items: bt.kpis },
  ];

  // The core offer plus a bracketed bonus slot. Bonuses, what each is worth (0 = not set) and any guarantee are the owner's to add.
  const core = packages[1];
  const valueStack: ValueStackItem[] = [
    { id: uid('vs'), kind: 'core', title: `${core.name} package`, value: 0, description: core.description },
    { id: uid('vs'), kind: 'bonus', title: '[A bonus you actually include]', value: 0, description: '[What it is and why it helps]' },
  ];
  return { packages, operating, valueStack, price: core.price };
}

/** Template role names with any claimed credential left out; never empty. */
export function teamRoles(roles: string[]): string[] {
  const kept = roles.filter((r) => !CLAIM_TERM.test(r));
  return kept.length ? kept : ['Owner / operator', '[Other roles on your team]'];
}

/** The guarantee the owner added to their value stack, or '' when they haven't added one. */
export function ownerGuarantee(project: Project): string {
  return project.studio.valueStack.find((v) => v.kind === 'guarantee')?.description.trim() ?? '';
}

// ───────────────────────── Listing copy ─────────────────────────

/** Niche terms that would claim a credential, review or offer the owner hasn't stated ("licensed and insured",
 *  "free estimate"): kept out of listing tags and ad keywords. */
export const CLAIM_TERM = /licen[sc]ed|insured|bonded|certified|free estimate|guarantee|warranty|review|rated/i;

export function generateListing(project: Project, d: Directives = {}, variation = 0): ListingDraft {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|listing|${variation}`));
  const isBiz = project.track === 'business';
  const title = isBiz ? f.brand : project.idea?.title ?? f.product;
  const tagline = project.brand.tagline || (isBiz ? `${f.business?.label ?? 'Local business'} in ${f.city || 'your area'}` : project.idea?.hook ?? `${capitalize(verbOutcome(f.outcome))}.`);
  const highlights = isBiz
    ? f.business!.delivery.slice(0, 3)
    : // the owner's chosen features, else what their outline covers, else the topics it is about (never invented "Built-in …" features)
      (project.idea?.features?.length
        ? project.idea.features
        : outlineTopics(project).length
          ? outlineTopics(project).slice(0, 3)
          : f.terms.slice(0, 3).map((t) => `Covers ${t}`));
  // Opening hours and any guarantee are the owner's to add (Publish tab offers the business type's as a suggestion).
  // The closing line states only what is true: how to book, or the product file that really exists.
  const booking = isBiz ? f.business?.booking ?? 'book' : 'buy';
  const closing = isBiz ? (booking === 'inquire' ? 'Get in touch for a quote.' : booking === 'buy' ? 'Order today.' : 'Book a time that suits you.') : productClosing(project);
  const description = [
    isBiz
      ? `${f.brand} ${f.city ? `${v.pick(['serves', 'works with'])} ${f.audience} in ${f.city}${f.region ? `, ${f.region}` : ''}` : `${v.pick(['serves', 'works with'])} ${f.audience} locally and online`}, offering ${f.business?.label.toLowerCase()}.`
      : `${f.product} is ${/^[aeiou]/i.test(f.formatNoun) ? 'an' : 'a'} ${f.formatNoun.replace(/^[A-Z](?![A-Z])/, (x) => x.toLowerCase())} for ${f.audience} who want to ${verbOutcome(f.outcome)}.`,
    '',
    `What you get:`,
    ...highlights.map((h) => `• ${h}`),
    '',
    closing,
  ].join('\n');
  const category = isBiz ? f.business?.category ?? 'Professional Services' : PRODUCT_CATEGORIES.includes(f.nicheLabel) ? f.nicheLabel : f.nicheLabel;
  const tags = [...new Set([f.topicLower, ...f.terms.filter((t) => !CLAIM_TERM.test(t)).slice(0, 3), isBiz ? f.city.toLowerCase() : FORMATS[project.format ?? 'pdf'].short.toLowerCase()].filter(Boolean))].slice(0, 6);
  return {
    title,
    tagline,
    description,
    category,
    tags,
    bookingType: booking,
    hours: '',
  };
}

/** The owner's outline section titles without "Module 1:"-style prefixes. */
function outlineTopics(project: Project): string[] {
  return (project.studio.outline ?? []).map((s) => s.title.replace(/^(Module|Chapter|Section|Day|Week|Tab|Part|Series) \d+:\s*/i, '').trim()).filter(Boolean);
}

/** The listing's closing line for a product: the finished file when there is one, otherwise just the format. */
function productClosing(project: Project): string {
  const files = project.studio.productFiles ?? [];
  const pdf = files.find((x) => x.kind === 'pdf');
  const xlsx = files.find((x) => x.kind === 'xlsx');
  if (pdf) return `Comes as a PDF${pdf.pages ? ` (${pdf.pages} pages)` : ''}.`;
  if (xlsx) return `Comes as an Excel workbook${xlsx.sheets?.length ? ` (${xlsx.sheets.length} tabs)` : ''}.`;
  return `Format: ${FORMATS[project.format ?? 'pdf'].short}.`;
}

export function facts(project: Project): Facts {
  return buildFacts(project);
}
