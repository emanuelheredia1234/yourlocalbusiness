import type { Directives, EmailStep, LeadMagnet, LeadMagnetType, Project } from '@/lib/types';
import { capitalize, hashStr, lowerFirst, titleCase, uid } from '@/lib/utils';
import { buildFacts, singular, verbOutcome, Voice } from '../text';

export const LEAD_MAGNET_TYPES: { id: LeadMagnetType; label: string; desc: string; icon: string }[] = [
  { id: 'checklist', label: 'Checklist', desc: 'Tick-box steps people can finish today', icon: 'list-checks' },
  { id: 'guide', label: 'Mini-guide', desc: 'A short, punchy how-to guide', icon: 'book-open' },
  { id: 'cheatsheet', label: 'Cheat sheet', desc: 'One-page reference of the essentials', icon: 'file-text' },
  { id: 'template', label: 'Starter template', desc: 'A fill-in template to get going fast', icon: 'layout-template' },
  { id: 'swipe', label: 'Swipe file', desc: 'Done-for-you examples to copy', icon: 'copy' },
  { id: 'workbook', label: '7-day workbook', desc: 'Daily prompts and exercises', icon: 'notebook-pen' },
];

export function generateLeadMagnet(project: Project, type: LeadMagnetType, d: Directives = {}, variation = 0): LeadMagnet {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|lm|${type}|${variation}`));
  const rng = v.rng;
  const T = f.topic;
  const n = rng.pick([10, 12, 15]);
  const titles: Record<LeadMagnetType, string[]> = {
    checklist: [`The ${n}-Point ${T} Checklist`, `The ${T} Starter Checklist`, `${T}: The Pre-Flight Checklist`],
    guide: [`${T} in 15 Minutes: The Mini-Guide`, `The ${T} Quick-Start Guide`, `The Beginner’s Guide to ${T}`],
    cheatsheet: [`The ${T} Cheat Sheet`, `${T} on One Page`, `The ${T} Cheat Sheet for ${titleCase(f.audience)}`],
    template: [`The ${T} Starter Template`, `The Plug-and-Play ${T} Template`, `The ${T} Planning Template`],
    swipe: [`The ${T} Swipe File: ${n} Done-for-You Examples`, `${n} ${T} Scripts You Can Steal`, `The ${T} Swipe File`],
    workbook: [`The 7-Day ${T} Workbook`, `7 Days to Better ${T}`, `The ${T} Reset Workbook`],
  };
  const title = rng.pick(titles[type]);
  const outcome = verbOutcome(f.outcomes[0]);
  const subtitle = `Everything ${f.audience} need to ${outcome}, on ${type === 'workbook' ? 'seven short pages' : 'one page'}.`;
  const intro = `${capitalize(f.pain)} is fixable. This ${type === 'cheatsheet' ? 'cheat sheet' : type === 'swipe' ? 'swipe file' : type} gives you the exact steps ${v.we === 'I' ? 'I' : 'we'} use with ${f.audience}, so you can ${outcome} without guesswork.`;
  const termVerbs = ['Get clear on your', 'Track your', 'Review your', 'Simplify your'];
  const termItem = (t: string, i = 0) => `${termVerbs[i % termVerbs.length]} ${t}`;
  let sections: LeadMagnet['sections'];
  switch (type) {
    case 'workbook':
      sections = ['Day 1: Get clear', 'Day 2: Clean up', 'Day 3: Build the system', 'Day 4: Automate', 'Day 5: Practice', 'Day 6: Review', 'Day 7: Lock it in'].map((h, i) => ({
        heading: h,
        items: [
          capitalize(f.quickWins[i % f.quickWins.length]),
          `Prompt: what is one way ${f.pain} showed up for you this week?`,
          i === 6 ? `Write your 30-day commitment to ${outcome}.` : `Five-minute action: ${f.terms[i % f.terms.length]} check-in.`,
        ],
      }));
      break;
    case 'swipe':
      sections = [
        { heading: 'Openers that get attention', items: [v.hook('tip'), v.hook('question'), v.hook('educational')] },
        { heading: 'Proven templates', items: f.terms.slice(0, 4).map((t) => `${capitalize(t)} template: “Fill in [your detail] here”`) },
        { heading: 'Closers that convert', items: [v.cta('buy'), v.cta('comment'), v.cta('save')] },
      ];
      break;
    case 'cheatsheet':
      sections = [
        { heading: 'Key terms', items: f.terms.slice(0, 5).map((t) => `${capitalize(t)}: what it is and why it matters`) },
        { heading: 'Do this', items: f.quickWins.map(capitalize) },
        { heading: 'Avoid this', items: f.mistakes.map(capitalize) },
      ];
      break;
    case 'template':
      sections = [
        { heading: 'Section 1: Your starting point', items: ['Where am I today?', `Biggest frustration: ${f.pain}`, 'One number I want to change'] },
        { heading: 'Section 2: Your plan', items: f.terms.slice(0, 3).map((t, i) => termItem(t, i)) },
        { heading: 'Section 3: Weekly review', items: ['What worked this week?', 'What got in the way?', 'Next week’s one priority'] },
      ];
      break;
    case 'guide':
      sections = [
        { heading: `Why ${f.pain} happens`, items: f.mistakes.slice(0, 3).map(capitalize) },
        { heading: 'The 3-step fix', items: f.quickWins.slice(0, 3).map((q, i) => `Step ${i + 1}: ${capitalize(q)}`) },
        { heading: 'What good looks like', items: f.outcomes.slice(0, 3).map((o) => capitalize(verbOutcome(o))) },
      ];
      break;
    default:
      sections = [
        { heading: 'Before you start', items: [capitalize(f.quickWins[0]), `Write down your #1 goal: ${outcome}`, ...f.terms.slice(0, 2).map((t, i) => termItem(t, i))] },
        { heading: 'Set it up', items: [...f.terms.slice(2, 5).map((t, i) => termItem(t, i + 2)), capitalize(f.quickWins[1] ?? 'block time on your calendar')] },
        { heading: 'Keep it going', items: [capitalize(f.quickWins[2] ?? 'review weekly'), ...f.mistakes.slice(0, 3).map((m) => `Avoid ${m}`), capitalize(f.quickWins[3] ?? 'celebrate small wins')] },
      ];
  }
  const bullets = [
    `The fastest way to ${outcome}`,
    `${f.mistakes.length} mistakes that keep ${f.audience} stuck`,
    `A ${type === 'workbook' ? '7-day' : '15-minute'} action plan you can start today`,
  ];
  const typeWord = LEAD_MAGNET_TYPES.find((t) => t.id === type)?.label.toLowerCase() ?? 'guide';
  return {
    id: uid('lm'),
    type,
    title,
    subtitle,
    intro,
    sections,
    cta: `Ready for the complete system? ${f.product} → ${f.urlDisplay}`,
    optInHeadline: `Free ${typeWord}: ${title}`,
    optInBullets: bullets,
    buttonLabel: `Send me the free ${typeWord}`,
    createdAt: Date.now(),
  };
}

export function generateEmailSequence(project: Project, lm: LeadMagnet | null, d: Directives = {}, variation = 0): EmailStep[] {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|emails|${variation}`));
  const lmTitle = lm?.title ?? `${f.topic} Starter Checklist`;
  const sign = `${v.signOff()}\n${v.we === 'I' ? `{{sender_name}}, ${f.brand}` : `The ${f.brand} team`}`;
  const outcome = verbOutcome(f.outcomes[0]);
  const outcome2 = verbOutcome(f.outcomes[1] ?? f.outcomes[0]);
  const qw = f.quickWins;
  const para = (...xs: string[]) => xs.filter(Boolean).join('\n\n');
  const long = v.length === 'long';
  const short = v.length === 'short';
  const offerLine = f.track === 'business' ? `book your ${f.business?.tiers[1] ?? 'first'} appointment` : `get ${f.product}`;
  const wave = v.e('wave');

  const e1: EmailStep = {
    id: uid('em'),
    index: 1,
    purpose: 'Deliver the freebie + warm welcome',
    subject: v.pick([`Here’s your ${lmTitle}${v.ee('gift')}`, `Your ${lmTitle} is inside`, `Welcome! Your ${lmTitle} (download inside)`]),
    preview: v.pick(['Plus the one thing to do first', 'Start with page one. It takes 5 minutes.', 'And what to expect from me this week']),
    body: para(
      `Hi {{first_name}}${wave ? ` ${wave}` : ''},`,
      `Welcome to ${f.brand}! As promised, here’s your copy of ${lmTitle}:`,
      `→ Download it here: {{lead_magnet_link}}`,
      `If you only do one thing today: ${qw[0]}. It takes about five minutes and it’s the fastest way to feel progress.`,
      short ? '' : `Over the next few days I’ll send you a couple of short emails with the exact steps ${f.audience} use to ${outcome}, no fluff.`,
      long ? `Quick question so I can make these useful: what’s your biggest challenge with ${f.topicLower} right now? Hit reply and tell me. I read every one.` : '',
      sign,
    ),
    delay: { value: 0, unit: 'minutes' },
    ctaLabel: 'Download your free guide',
    ctaUrl: '{{lead_magnet_link}}',
  };

  const e2: EmailStep = {
    id: uid('em'),
    index: 2,
    purpose: 'High-value insight + quick win',
    subject: v.pick([`The 10-minute ${f.topicLower} win`, `Try this before Friday`, `One small change, big difference`]),
    preview: `A quick win most ${f.audience} overlook`,
    body: para(
      `Hi {{first_name}},`,
      `Here’s something most ${f.audience} never hear: the difference between “stuck” and “sorted” usually isn’t effort. It’s ${f.terms[0]}.`,
      `Try this today:\n1. ${capitalize(qw[1] ?? qw[0])}\n2. ${capitalize(qw[2] ?? qw[0])}\n3. Put a 15-minute check-in on your calendar for next week`,
      short ? '' : `Do just those three things and you’ll notice ${lowerFirst(f.desire)} faster than you expect.`,
      long ? `Why it works: when ${f.terms[0]} is set up first, every other decision gets easier. That’s the foundation of everything in ${lmTitle}.` : '',
      `Tomorrow: the most common ${f.topicLower} myth (and what to do instead).`,
      sign,
    ),
    delay: { value: 1, unit: 'days' },
    ctaLabel: 'Revisit your free guide',
    ctaUrl: '{{lead_magnet_link}}',
  };

  const myth = f.myths[0];
  const e3: EmailStep = {
    id: uid('em'),
    index: 3,
    purpose: 'Myth-busting + illustrative case study',
    subject: v.pick([`The ${f.topicLower} myth that keeps ${f.audience} stuck`, `“${myth}” (not quite)`, `Stop ${f.mistakes[0]}`]),
    preview: 'What actually works instead',
    body: para(
      `Hi {{first_name}},`,
      `Let’s bust a myth: “${myth}.”`,
      `It sounds reasonable, but it pushes people into ${f.mistakes[0]}, which is exactly why ${f.pain} keeps coming back.`,
      `Here’s what that looks like in practice. Picture a ${singular(f.audience)} who tries harder every month and still deals with ${f.pain}. Once they ${qw[0]} and ${qw[1] ?? 'review weekly'}, the problem stops being a monthly fire drill. Within a few weeks they ${outcome2}.`,
      short ? '' : `The lesson: systems beat willpower. Every time.`,
      sign,
    ),
    delay: { value: 2, unit: 'days' },
    ctaLabel: 'See how the system works',
    ctaUrl: '{{product_link}}',
  };

  const e4: EmailStep = {
    id: uid('em'),
    index: 4,
    purpose: 'Handle objections + soft teaser',
    subject: v.pick([`“${f.objections[0]}”`, `Is this really for you?`, `The two questions I get most`]),
    preview: 'Honest answers, plus something I’ve been working on',
    body: para(
      `Hi {{first_name}},`,
      `When I talk to ${f.audience}, two things come up again and again:`,
      `“${f.objections[0]}”\nFair. That’s why everything here is designed to take minutes, not hours. Start with ${qw[0]}.`,
      `“${f.objections[1] ?? f.objections[0]}”\nYou don’t need to be perfect. You need a simple routine and a place to start.`,
      `Which brings me to something I’ve been building for people exactly like you: ${f.product}. It’s the complete version of what you’ve been reading this week. More details tomorrow.`,
      sign,
    ),
    delay: { value: 2, unit: 'days' },
    ctaLabel: `Peek at ${f.productShort}`,
    ctaUrl: '{{product_link}}',
  };

  const frameworkBody = (): string[] => {
    switch (d.framework) {
      case 'AIDA':
        return [`If you want to ${outcome}, read this.`, `${f.product} gives you the system, step by step.`, `Imagine next month: ${lowerFirst(f.desire)}, and no more ${f.pain}.`, `Here’s how to ${offerLine}:`];
      case 'BAB':
        return [`Before: ${f.pain}, every single month.`, `After: ${lowerFirst(f.desire)}, on autopilot.`, `The bridge: ${f.product}.`];
      case 'StoryBrand':
        return [`You want to ${outcome}. The problem is ${f.pain}.`, `We get it, and we’ve helped ${f.audience} solve it with a simple 3-step plan: start, systemize, review.`, `${f.product} is that plan, ready to go.`];
      default:
        return [
          `${capitalize(f.pain)}? That doesn’t fix itself.`,
          `Every month it costs you time, money and peace of mind. And it compounds.`,
          `${f.product} is the fix: everything from this week, plus the templates, steps and support to ${outcome}.`,
        ];
    }
  };
  const e5: EmailStep = {
    id: uid('em'),
    index: 5,
    purpose: 'Direct pitch with urgency',
    subject: v.pick([`${f.productShort} is open (and why now)`, `Your invitation: ${f.productShort}`, `48 hours: launch bonus inside`]),
    preview: `Launch bonus ends in 48 hours`,
    body: para(
      `Hi {{first_name}},`,
      ...frameworkBody(),
      `What you get:\n• ${f.product}\n• Every template and checklist from this week\n• ${v.pick(['Lifetime updates', 'Priority email support', 'A bonus quick-start session'])}`,
      `Investment: ${f.priceStr}${f.priceSuffix}. ${f.track === 'business' ? '' : 'Instant access.'}`,
      `For the next 48 hours, you also get a launch bonus. After that, it’s gone.`,
      `→ ${capitalize(offerLine)}: {{product_link}}`,
      sign,
      `P.S. ${v.pick([`Not sure? Reply and ask me anything. I’ll tell you honestly if it’s a fit.`, `If ${f.pain} cost you even one evening this month, this pays for itself.`])}`,
    ),
    delay: { value: 2, unit: 'days' },
    ctaLabel: capitalize(offerLine),
    ctaUrl: '{{product_link}}',
  };

  return [e1, e2, e3, e4, e5].map((e) => ({ ...e, body: v.includeMust(e.body) }));
}

export function renderTokens(text: string, tokens: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => tokens[k] ?? m);
}

export function delayToMs(delay: EmailStep['delay']): number {
  const unit = delay.unit === 'minutes' ? 60_000 : delay.unit === 'hours' ? 3_600_000 : 86_400_000;
  return Math.max(0, delay.value) * unit;
}

export function leadMagnetMarkdown(lm: LeadMagnet, brand: string): string {
  return [
    `# ${lm.title}`,
    `_${lm.subtitle}_`,
    '',
    lm.intro,
    '',
    ...lm.sections.flatMap((s) => [`## ${s.heading}`, ...s.items.map((i) => (lm.type === 'checklist' || lm.type === 'workbook' ? `- [ ] ${i}` : `- ${i}`)), '']),
    '---',
    lm.cta,
    '',
    `© ${new Date().getFullYear()} ${brand}`,
  ].join('\n');
}
