import type { Directives, EmailStep, LeadMagnet, LeadMagnetType, Project } from '@/lib/types';
import { capitalize, hashStr, lowerFirst, titleCase, uid } from '@/lib/utils';
import { buildFacts, verbOutcome, Voice } from '../text';

export const LEAD_MAGNET_TYPES: { id: LeadMagnetType; label: string; desc: string; icon: string }[] = [
  { id: 'checklist', label: 'Checklist', desc: 'Tick-box steps people can finish today', icon: 'list-checks' },
  { id: 'guide', label: 'Mini-guide', desc: 'A short, punchy how-to guide', icon: 'book-open' },
  { id: 'cheatsheet', label: 'Cheat sheet', desc: 'One-page reference of the essentials', icon: 'file-text' },
  { id: 'template', label: 'Starter template', desc: 'A fill-in template to get going fast', icon: 'layout-template' },
  { id: 'swipe', label: 'Swipe file', desc: 'Done-for-you examples to copy', icon: 'copy' },
  { id: 'workbook', label: '7-day workbook', desc: 'Daily prompts and exercises', icon: 'notebook-pen' },
];

/** What the owner's product actually contains: outline section titles, else package names (business). [] = nothing set. */
function ownerContents(project: Project): string[] {
  const fromOutline = project.studio.outline.map((s) => s.title.replace(/^(Module|Chapter|Section|Day|Week|Tab|Part) \d+:\s*/i, '').trim()).filter(Boolean);
  if (fromOutline.length) return fromOutline.slice(0, 5);
  return project.studio.packages.map((x) => x.name.trim()).filter(Boolean).slice(0, 5);
}

const joinList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export function generateLeadMagnet(project: Project, type: LeadMagnetType, d: Directives = {}, variation = 0): LeadMagnet {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|lm|${type}|${variation}`));
  const rng = v.rng;
  const T = f.topic;
  const outcome = verbOutcome(f.outcomes[0]);
  const kind = type === 'cheatsheet' ? 'cheat sheet' : type === 'swipe' ? 'swipe file' : type;
  // no promises: what the freebie is about and who it's for, not how fast or how well it works
  const subtitle = `A ${type === 'workbook' ? 'seven-day' : 'short'} ${kind} for ${f.audience} who want to ${outcome}.`;
  const intro = `This ${kind} is for ${f.audience} dealing with ${f.pain}. It collects simple steps you can work through at your own pace.`;
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
          i === 6 ? `Write your 30-day commitment to ${outcome}.` : `Quick action: ${f.terms[i % f.terms.length]} check-in.`,
        ],
      }));
      break;
    case 'swipe':
      sections = [
        { heading: 'Opening lines', items: [v.hook('tip'), v.hook('question'), v.hook('educational')] },
        { heading: 'Templates to adapt', items: f.terms.slice(0, 4).map((t) => `${capitalize(t)} template: “Fill in [your detail] here”`) },
        { heading: 'Closing lines', items: [v.cta('buy'), v.cta('comment'), v.cta('save')] },
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
        { heading: 'Three steps to try', items: f.quickWins.slice(0, 3).map((q, i) => `Step ${i + 1}: ${capitalize(q)}`) },
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
  // counts in the title are the real number of items, never a made-up "15-point" or "12 examples"
  const n = sections.reduce((s, x) => s + x.items.length, 0);
  const titles: Record<LeadMagnetType, string[]> = {
    checklist: [`The ${n}-Point ${T} Checklist`, `The ${T} Starter Checklist`, `${T}: The Pre-Flight Checklist`],
    guide: [`The ${T} Mini-Guide`, `The ${T} Quick-Start Guide`, `The Beginner’s Guide to ${T}`],
    cheatsheet: [`The ${T} Cheat Sheet`, `${T} on One Page`, `The ${T} Cheat Sheet for ${titleCase(f.audience)}`],
    template: [`The ${T} Starter Template`, `The Fill-In ${T} Template`, `The ${T} Planning Template`],
    swipe: [`The ${T} Swipe File: ${n} Examples to Adapt`, `${n} ${T} Lines to Adapt`, `The ${T} Swipe File`],
    workbook: [`The 7-Day ${T} Workbook`, `A 7-Day ${T} Workbook`, `The ${T} Reset Workbook`],
  };
  const title = rng.pick(titles[type]);
  // the mistakes bullet counts the "avoid" items this freebie really lists, and is left out when it lists none
  const avoidCount = type === 'checklist' ? sections[2].items.filter((i) => i.startsWith('Avoid ')).length : type === 'cheatsheet' || type === 'guide' ? (sections.find((s) => s.heading === 'Avoid this' || s.heading.startsWith('Why '))?.items.length ?? 0) : 0;
  const bullets = [
    `Simple steps for when you want to ${outcome}`,
    avoidCount ? `${avoidCount} common ${avoidCount === 1 ? 'mistake' : 'mistakes'} to watch for` : `${n} ${type === 'swipe' ? 'examples to adapt' : 'items to work through'}`,
    `A ${type === 'workbook' ? '7-day' : 'short'} action plan you can start today`,
  ];
  const typeWord = LEAD_MAGNET_TYPES.find((t) => t.id === type)?.label.toLowerCase() ?? 'guide';
  return {
    id: uid('lm'),
    type,
    title,
    subtitle,
    intro,
    sections,
    cta: `Want to go further? ${f.product} → ${f.urlDisplay || '[link to your offer]'}`,
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
  const qw = f.quickWins;
  const para = (...xs: string[]) => xs.filter(Boolean).join('\n\n');
  const long = v.length === 'long';
  const short = v.length === 'short';
  // only the owner's own package names, never the template's tier names
  const offerLine = f.track === 'business' ? `book your ${project.studio.packages[0]?.name.trim() || 'first'} appointment` : `get ${f.product}`;
  const contents = ownerContents(project);
  const wave = v.e('wave');

  const e1: EmailStep = {
    id: uid('em'),
    index: 1,
    purpose: 'Deliver the freebie + warm welcome',
    subject: v.pick([`Here’s your ${lmTitle}${v.ee('gift')}`, `Your ${lmTitle} is inside`, `Welcome! Your ${lmTitle} (download inside)`]),
    preview: v.pick(['Plus the one thing to do first', 'Start with page one.', 'And what to expect from me this week']),
    body: para(
      `Hi {{first_name}}${wave ? ` ${wave}` : ''},`,
      `Welcome to ${f.brand}! As promised, here’s your copy of ${lmTitle}:`,
      `→ Download it here: {{lead_magnet_link}}`,
      `If you only do one thing today: ${qw[0]}.`,
      short ? '' : `Over the next few days I’ll send you a couple of short emails about ${f.topicLower}: what tends to get in the way, and a few ideas to try.`,
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
    subject: v.pick([`One small ${f.topicLower} step`, `Try this before Friday`, `One small change to try`]),
    preview: 'One small step to try this week',
    body: para(
      `Hi {{first_name}},`,
      `Here are two small ${f.topicLower} steps you could try this week.`,
      `Try this today:\n1. ${capitalize(qw[1] ?? qw[0])}\n2. ${capitalize(qw[2] ?? qw[0])}\n3. Put a short check-in on your calendar for next week`,
      short ? '' : `Pick whichever one fits your week.`,
      long ? `Want to look back at the basics? Your copy of ${lmTitle} is here: {{lead_magnet_link}}` : '',
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
    purpose: 'Myth-busting + hypothetical example',
    subject: v.pick([`The ${f.topicLower} myth that keeps ${f.audience} stuck`, `“${myth}” (not quite)`, `Stop ${f.mistakes[0]}`]),
    preview: 'What actually works instead',
    body: para(
      `Hi {{first_name}},`,
      `Let’s bust a myth: “${myth}.”`,
      `It sounds reasonable, but it can lead to ${f.mistakes[0]}.`,
      `A hypothetical example (not a real customer): say you’ve tried harder every month and still deal with ${f.pain}. Instead of pushing harder, you could ${qw[0]} and ${qw[1] ?? 'review weekly'}, then see what changes.`,
      short ? '' : `Which of these could you try this week?`,
      sign,
    ),
    delay: { value: 2, unit: 'days' },
    ctaLabel: `See ${f.productShort}`,
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
      `“${f.objections[0]}”\nFair. Start small: ${qw[0]}.`,
      `“${f.objections[1] ?? f.objections[0]}”\nYou don’t need to be perfect. You need a simple routine and a place to start.`,
      `Which brings me to something I’ve been working on: ${f.product}. More details tomorrow.`,
      sign,
    ),
    delay: { value: 2, unit: 'days' },
    ctaLabel: `Peek at ${f.productShort}`,
    ctaUrl: '{{product_link}}',
  };

  // describe only what the owner's product contains (its outline or packages), else a placeholder; no promised results
  const covers = contents.length ? joinList(contents) : '[What’s included]';
  const frameworkBody = (): string[] => {
    switch (d.framework) {
      case 'AIDA':
        return [`If you want to ${outcome}, read this.`, `${f.product} covers ${covers}.`, `It’s made for ${f.audience} dealing with ${f.pain}.`, `Here’s how to ${offerLine}:`];
      case 'BAB':
        return [`Before: ${f.pain}.`, `What you’re after: ${lowerFirst(f.desire)}.`, `What ${f.productShort} covers: ${covers}.`];
      case 'StoryBrand':
        return [`You want to ${outcome}. The problem is ${f.pain}.`, `We get it.`, `${f.product} covers ${covers}.`];
      default:
        return [`${capitalize(f.pain)}? You’re not the only one.`, `${f.product} is about ${f.topicLower} for ${f.audience}. It covers ${covers}.`];
    }
  };
  const e5: EmailStep = {
    id: uid('em'),
    index: 5,
    purpose: 'Direct pitch',
    // no invented deadlines, launch bonuses or perks: the owner adds a real offer if they have one
    subject: v.pick([`${f.productShort} is open`, `Your invitation: ${f.productShort}`, `What’s inside ${f.productShort}`]),
    preview: `What you get and how to ${offerLine}`,
    body: para(
      `Hi {{first_name}},`,
      ...frameworkBody(),
      `What you get:\n• ${f.product}${contents.map((x) => `\n• ${x}`).join('')}\n• [Anything else you include]`,
      f.price > 0 ? `Investment: ${f.priceStr}${f.priceSuffix}.` : 'Investment: [your price].',
      `→ ${capitalize(offerLine)}: {{product_link}}`,
      sign,
      `P.S. ${v.pick([`Not sure? Reply with any questions you have.`, `Questions about what’s included? Just reply and ask.`])}`,
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
