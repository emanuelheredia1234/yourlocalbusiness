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
import { charmPrice } from './research';

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
  const min = () => `${rng.int(5, 14)} min`;
  const pages = () => `${rng.int(3, 9)} pages`;
  const longer = d.length === 'long';
  const shorter = d.length === 'short';

  switch (project.format) {
    case 'course': {
      const modules: OutlineSection[] = [
        section(`Foundations: Why ${T} Feels Hard`, `Reset expectations and measure where ${f.audience} are starting from.`, [
          item('Welcome & how to get the most from this course', `Video · ${min()}`),
          item(`The real reason behind ${f.pain}`, `Video · ${min()}`),
          item(`Your ${t} baseline audit`, 'Worksheet'),
          item('Set your 30-day target', `Video · ${min()}`),
        ]),
        section(`Set Up Your ${Term(0)} System`, `Build the simple setup everything else runs on.`, [
          item(`Build your ${term(0)}`, `Video · ${min()}`),
          item(`Configure ${term(1)} in under 20 minutes`, `Video · ${min()}`),
          item('Templates & tools walkthrough', `Screen recording · ${min()}`),
          item(`Quick win: ${f.quickWins[0]}`, 'Action step'),
        ]),
        section('The Core Method, Step by Step', `The repeatable process to ${outcome(0)}.`, [
          item(`Step 1: ${capitalize(f.quickWins[1] ?? 'get organized')}`, `Video · ${min()}`),
          item(`Step 2: Build momentum with ${term(2)}`, `Video · ${min()}`),
          item(`Step 3: Review, adjust, repeat`, `Video · ${min()}`),
          item(`Avoid this: ${f.mistakes[0]}`, `Video · ${min()}`),
          item('Module quiz', '5 questions'),
        ]),
        section('Make It Stick: Routines That Run Themselves', 'Turn the method into a weekly habit.', [
          item(`The 15-minute weekly ${t} routine`, `Video · ${min()}`),
          item('Automations that save hours', `Video · ${min()}`),
          item(`Track progress with ${term(3)}`, 'Worksheet'),
        ]),
        section(`Level Up: ${capitalize(outcome(1))}`, `Advanced moves once the basics are automatic.`, [
          item(`${capitalize(outcome(1))}`, `Video · ${min()}`),
          item(`Scaling up: ${outcome(2)}`, `Video · ${min()}`),
          item(`Case study: a ${singular(f.audience)} start to finish`, `Video · ${min()}`),
        ]),
        section('Troubleshooting & Common Objections', 'What to do when life gets in the way.', [
          item(`When “${lowerFirst(f.objections[0])}”`, `Video · ${min()}`),
          item(`When “${lowerFirst(f.objections[1])}”`, `Video · ${min()}`),
          item(`Myth vs. fact: ${lowerFirst(f.myths[0])}`, `Video · ${min()}`),
        ]),
      ];
      if (!shorter) modules.push(section('Bonus: Your Next 90 Days', 'Keep the results compounding.', [item('Your 90-day plan template', 'Template'), item('Community, coaching & next steps', `Video · ${min()}`)]));
      return { label: fmt.outlineLabel, sections: longer ? modules : modules.slice(0, shorter ? 5 : 7) };
    }
    case 'pdf':
    case 'ebook': {
      const chapters: OutlineSection[] = [
        section(`Introduction: ${capitalize(f.desire)} Is Possible`, 'Who this is for and how to use it.', [item('Who this guide is for', pages()), item('How to read this in a weekend', pages()), item('Your promise to yourself', '1 page')]),
        section(`Why ${capitalize(f.pain)} Happens`, 'The root causes nobody talks about.', [item('The three hidden causes', pages()), item(`Myth: ${f.myths[0]}`, pages()), item('Self-assessment quiz', '2 pages')]),
        section(`${T} Fundamentals`, 'The few concepts that matter most.', f.terms.slice(0, 4).map((x) => item(capitalize(x), pages()))),
        section(`Step by Step: Build Your ${Term(0)} System`, `The exact process to ${outcome(0)}.`, [
          item(`Step 1: ${capitalize(f.quickWins[0])}`, pages()),
          item(`Step 2: Set up ${term(1)}`, pages()),
          item(`Step 3: Make ${term(2)} automatic`, pages()),
          item('Step 4: Review weekly', pages()),
        ]),
        section(`${f.mistakes.length} Mistakes to Avoid`, 'Learn from what trips most people up.', f.mistakes.map((m) => item(capitalize(m), '1–2 pages'))),
        section(`Real-World Examples for ${titleCase(f.audience)}`, 'See the method applied.', [item(`Example 1: ${capitalize(outcome(1))}`, pages()), item(`Example 2: ${capitalize(outcome(2))}`, pages()), item('Before & after templates', pages())]),
        section('Your 30-Day Action Plan', 'Day-by-day checklist.', [item('Week 1: Setup', '2 pages'), item('Week 2: Momentum', '2 pages'), item('Week 3: Routines', '2 pages'), item('Week 4: Review & level up', '2 pages')]),
        section('Troubleshooting & FAQ', 'Answers to the questions readers ask most.', f.objections.slice(0, 3).map((o) => item(`“${o}”`, '1 page'))),
      ];
      if (project.format === 'ebook' || longer) chapters.push(section('Resources & Templates', 'Everything referenced in this book.', [item('Printable checklists', pages()), item('Recommended tools', '2 pages'), item('Glossary', '2 pages')]));
      return { label: fmt.outlineLabel, sections: shorter ? chapters.slice(0, 6) : chapters };
    }
    case 'template': {
      const platform = rng.pick(['Notion', 'Google Docs', 'Canva', 'Notion']);
      return {
        label: fmt.outlineLabel,
        sections: [
          section('Core Templates', `The everyday templates ${f.audience} use most.`, [
            item(`${T} Dashboard`, platform, `One home base that shows ${term(0)}, ${term(1)} and this week’s priorities.`),
            item(`${Term(0)} Tracker`, platform, `Log entries in seconds; totals and status update automatically.`),
            item(`${Term(1)} Template`, platform),
            item('Quick-Start Checklist', platform, 'Get set up in 10 minutes.'),
          ]),
          section('Planning & Review', 'Weekly and monthly rhythms that keep results compounding.', [
            item('Weekly Planner', platform),
            item('Monthly Review', platform, 'Prompts to review what worked and plan next month.'),
            item('Goal Setting Worksheet', platform),
          ]),
          section('Bonus Templates', 'Extras that remove the next obstacle.', [
            item(`${Term(2)} Swipe File`, platform),
            item(`${capitalize(f.quickWins[0])}: Checklist`, platform),
            item('Video walkthrough', 'Loom · 12 min'),
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
            item(`Guided ${term(0)} setup`, 'Must-have', `As a ${singular(f.audience)}, I can set up my ${term(0)} in under 5 minutes so I start seeing value on day one.`),
            item(`${Term(1)} tracking`, 'Must-have', `As a ${singular(f.audience)}, I can log ${term(1)} in seconds from my phone.`),
            item('Smart reminders', 'Must-have', `Nudges at the right time so ${f.pain} never sneaks up again.`),
            item('Weekly progress report', 'Should-have', 'Email + in-app summary of wins and next actions.'),
            item('Export to CSV / PDF', 'Should-have'),
            item('Team / partner sharing', 'Could-have'),
          ]),
          section('Tech Stack & Architecture', 'Lean, cheap to run, easy to iterate.', [
            item('Frontend: React + TypeScript', 'Web app, mobile-first'),
            item('Backend: serverless API + Postgres', 'Auth, data, scheduled jobs'),
            item('Payments: subscription billing', `${f.priceStr}/mo plan + annual discount`),
            item('Analytics: product events + activation funnel', 'Track time-to-first-value'),
          ]),
          section('Launch Roadmap', 'Ship in phases and learn from real users.', [
            item('Phase 1 (weeks 1–4): private beta with 20 users', 'Validate core loop'),
            item('Phase 2 (weeks 5–8): public launch + onboarding emails', 'Activation focus'),
            item('Phase 3 (weeks 9–12): integrations + referral program', 'Growth focus'),
          ]),
        ],
      };
    }
    case 'design': {
      return {
        label: fmt.outlineLabel,
        sections: [
          section('Social Media Pack', 'Ready-to-post templates.', [item(`${rng.int(30, 60)} feed post templates`, 'Canva + Figma'), item(`${rng.int(20, 40)} story templates`, 'Canva + Figma'), item('Carousel templates', '10 layouts')]),
          section('Brand Essentials', 'Make everything look consistent.', [item('Logo variations & usage guide', 'SVG / PNG'), item('Color palettes', '6 palettes'), item('Font pairings', '5 pairings')]),
          section('Graphics & Icons', 'Drop-in visual elements.', [item(`${rng.int(60, 150)} icons in 3 styles`, 'SVG'), item('Illustrated spot graphics', 'PNG / SVG'), item('Textures & backgrounds', 'JPG')]),
          section('Mockups', 'Show your work professionally.', [item('Device mockups', 'PSD / Figma'), item('Print mockups', 'PSD'), item('Bonus: video tutorial', '15 min')]),
        ],
      };
    }
    case 'audio': {
      return {
        label: fmt.outlineLabel,
        sections: [
          section('Series 1: Foundations', 'Start here.', [item(`Welcome: how to use these sessions`, '4 min'), item(`Understanding ${t}`, '9 min'), item(`Releasing ${f.pain}`, '12 min')]),
          section('Series 2: Daily Sessions', 'Short sessions for every day of the week.', ['Morning reset', 'Midday focus', 'Evening wind-down', 'Weekend reflection'].map((x) => item(x, `${rng.int(6, 12)} min`))),
          section('Series 3: Deep Dives', 'Longer sessions for real breakthroughs.', [item(capitalize(outcome(0)), '18 min'), item(capitalize(outcome(1)), '20 min'), item('Bonus: guided Q&A', '25 min')]),
        ],
      };
    }
    case 'membership': {
      const p = f.price || 19;
      return {
        label: fmt.outlineLabel,
        sections: [
          section(`Community · $${p}/mo`, 'The core membership.', [item('Private community space'), item('Monthly playbook (new every month)'), item('Template vault access')]),
          section(`Pro · $${charmPrice(p * 2.2)}/mo`, 'For members who want accountability.', [item('Everything in Community'), item('Monthly live Q&A + replays'), item('Quarterly goal-setting workshop')]),
          section(`VIP · $${charmPrice(p * 5)}/mo`, 'Hands-on support.', [item('Everything in Pro'), item('1:1 monthly review call'), item('Priority support')]),
          section('Monthly Content Calendar', 'What members get each week.', [
            item('Week 1: New playbook drop', `Topic: ${capitalize(outcome(0))}`),
            item('Week 2: Live Q&A', 'Members bring their questions'),
            item('Week 3: Template or tool release', `${Term(0)} toolkit`),
            item('Week 4: Wins & review thread', 'Accountability check-in'),
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
    `Example: a ${singular(f.audience)} who ${v.pick(['started from zero', 'was stuck for months', 'tried everything else first'])} and used this to ${verbOutcome(v.pick(f.outcomes))}.`,
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
  const packages: ServicePackage[] = bt.tiers.map((name, i) => {
    const svc = tierServices[i] ?? sorted[0];
    const base = mid(svc.price);
    const price = i === 0 ? base : i === 1 ? Math.max(base, Math.round(mid(tierServices[0].price) * 1.8)) : Math.max(base, Math.round(mid(tierServices[0].price) * 3.1));
    const includes = [
      svc.name + (svc.duration ? ` (${svc.duration})` : ''),
      ...rng.pickN(bt.delivery, i === 0 ? 2 : 3),
      ...(i >= 1 ? [rng.pick(bt.bonuses)] : []),
      ...(i === 2 ? ['Priority scheduling', bt.guarantee.split(':')[0]] : []),
    ];
    return {
      id: uid('pkg'),
      name,
      price: price >= 100 ? Math.round(price / 5) * 5 : price,
      priceModel: svc.unit === 'monthly' ? 'monthly' : svc.unit,
      description:
        i === 0
          ? `The essentials, done right. Ideal for ${f.audience} trying ${f.brand} for the first time.`
          : i === 1
            ? `Our most popular option: everything you need for ${lowerFirst(f.desire)}.`
            : `White-glove, done-for-you service for clients who want the very best.`,
      includes: [...new Set(includes)],
      popular: i === 1,
    };
  });

  const capacity = rng.int(18, 40);
  const operating: OperatingBlock[] = [
    { id: uid('op'), title: 'Customer journey & booking', items: bt.bookingFlow },
    { id: uid('op'), title: 'Service delivery standard', items: bt.delivery },
    { id: uid('op'), title: 'Team & roles', items: bt.roles },
    { id: uid('op'), title: 'Tools & tech stack', items: bt.tools },
    { id: uid('op'), title: 'Hours & capacity', items: [bt.hours, `Target capacity: ~${capacity} appointments or jobs per week`, f.city ? `Service area: ${f.city}${f.region ? `, ${f.region}` : ''} and nearby neighborhoods` : 'Service area: local + online'] },
    { id: uid('op'), title: 'Revenue streams', items: bt.revenue },
    { id: uid('op'), title: 'Cost structure', items: bt.costs },
    { id: uid('op'), title: 'KPIs to track weekly', items: bt.kpis },
  ];

  const core = packages[1];
  const valueStack: ValueStackItem[] = [
    { id: uid('vs'), kind: 'core', title: `${core.name} package`, value: Math.round(core.price * 1.25), description: core.description },
    ...bt.bonuses.map((b, i) => ({ id: uid('vs'), kind: 'bonus' as const, title: b, value: [49, 79, 99, 129][i % 4] * (f.price > 300 ? 3 : 1), description: `Removes the next obstacle for ${f.audience}.` })),
    { id: uid('vs'), kind: 'guarantee', title: 'Our promise', value: 0, description: bt.guarantee },
  ];
  return { packages, operating, valueStack, price: core.price };
}

// ───────────────────────── Listing copy ─────────────────────────

export function generateListing(project: Project, d: Directives = {}, variation = 0): ListingDraft {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|listing|${variation}`));
  const isBiz = project.track === 'business';
  const title = isBiz ? f.brand : project.idea?.title ?? f.product;
  const tagline = project.brand.tagline || (isBiz ? `${f.business?.label ?? 'Local business'} in ${f.city || 'your area'}` : project.idea?.hook ?? `${capitalize(verbOutcome(f.outcome))}.`);
  const highlights = isBiz
    ? f.business!.delivery.slice(0, 3)
    : (project.idea?.features ?? f.terms.slice(0, 3).map((t) => `Built-in ${t}`));
  const description = [
    isBiz
      ? `${f.brand} ${f.city ? `serves ${f.city}${f.region ? `, ${f.region}` : ''}` : 'serves customers locally and online'} with ${f.business?.label.toLowerCase()} that ${f.audience} can count on. ${v.pick([`No more ${f.pain}.`, `Say goodbye to ${f.pain}.`])}`
      : `${f.product} helps ${f.audience} ${verbOutcome(f.outcome)}, without ${f.pain}.`,
    '',
    `What you get:`,
    ...highlights.map((h) => `• ${h}`),
    '',
    isBiz ? f.business!.guarantee : `Instant digital delivery. ${v.pick(['Lifetime updates included.', 'Works on any device.', 'Built from real-world experience.'])}`,
  ].join('\n');
  const category = isBiz ? f.business?.category ?? 'Professional Services' : PRODUCT_CATEGORIES.includes(f.nicheLabel) ? f.nicheLabel : f.nicheLabel;
  const tags = [...new Set([f.topicLower, ...f.terms.slice(0, 3), isBiz ? f.city.toLowerCase() : FORMATS[project.format ?? 'pdf'].short.toLowerCase()].filter(Boolean))].slice(0, 6);
  return {
    title,
    tagline,
    description,
    category,
    tags,
    bookingType: isBiz ? f.business?.booking ?? 'book' : 'buy',
    hours: isBiz ? f.business?.hours ?? '' : '',
  };
}

export function facts(project: Project): Facts {
  return buildFacts(project);
}
