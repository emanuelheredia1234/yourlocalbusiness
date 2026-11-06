import type {
  CampaignConfig,
  CampaignPlan,
  Directives,
  ImageStyleId,
  PlanDay,
  PlanSlot,
  Post,
  PostFormat,
  PostPlatform,
  PostType,
  Project,
  Scene,
  StyleId,
  VideoStyleId,
} from '@/lib/types';
import { addDays, capitalize, combineDateTime, createRng, hashStr, lowerFirst, truncate, uid, weekdayIndex } from '@/lib/utils';
import { IMAGE_STYLES, PLATFORMS, POST_TYPE_MAP, VIDEO_STYLES, isVideoStyle } from '../knowledge';
import { buildFacts, singular, verbOutcome, Voice, type Facts } from '../text';
import { videoDaysOf } from '@/lib/campaign';
import { fitForX, firstCommentFor, knownLinks, linkText, placeLink, postLinkFor, type PostLink } from '@/lib/pageLink';

const PHASES: { until: number; name: string; weights: Record<PostType, number> }[] = [
  { until: 6, name: 'Awareness', weights: { educational: 1.2, tip: 1.1, question: 1.4, sales: 0.35, bts: 0.9 } },
  { until: 13, name: 'Authority', weights: { educational: 1.5, tip: 1.3, question: 0.8, sales: 0.6, bts: 0.8 } },
  { until: 20, name: 'Trust', weights: { educational: 0.9, tip: 0.9, question: 1.0, sales: 0.9, bts: 1.6 } },
  { until: 27, name: 'Conversion', weights: { educational: 0.8, tip: 0.7, question: 0.6, sales: 1.8, bts: 1.1 } },
  { until: 29, name: 'Final push', weights: { educational: 0.5, tip: 0.5, question: 0.5, sales: 2.2, bts: 1.2 } },
];

const PLATFORM_FIT: Record<PostPlatform, Partial<Record<PostType, number>> & { video: number }> = {
  instagram: { video: 1.2, educational: 1.1, tip: 1.1, bts: 1.1, sales: 1 },
  facebook: { video: 0.9, question: 1.3, bts: 1.1, sales: 1.1 },
  tiktok: { video: 1.8, tip: 1.2, bts: 1.1, educational: 1 },
  linkedin: { video: 0.8, educational: 1.4, bts: 1.2, tip: 1 },
  x: { video: 0.6, tip: 1.3, question: 1.3, educational: 0.9 },
};

const STYLE_FIT: Record<StyleId, Partial<Record<PostType, number>>> = {
  minimal: { sales: 1.5, bts: 0.8 },
  neon: { tip: 1.4, question: 1.3 },
  editorial: { bts: 1.6, question: 1 },
  isometric: { educational: 1.5, sales: 1 },
  handcrafted: { educational: 1.4, tip: 1.3 },
  ugc: { tip: 1.3, question: 1.2, bts: 1.1 },
  kinetic: { tip: 1.4, educational: 1.1 },
  split: { educational: 1.3, sales: 1.2 },
  cinematic: { sales: 1.5, bts: 1.2 },
  talking: { educational: 1.4, bts: 1.2, question: 1.1 },
};

export function defaultCampaign(): CampaignConfig {
  return {
    days: [true, true, true, true, true, false, false],
    postsPerDay: 2,
    // three videos a week (Monday, Wednesday, Friday): within every plan's weekly AI videos (Launch makes 3)
    videoDays: [1, 0, 1, 0, 1, 0, 0],
    watermark: true,
    imageStyles: ['minimal', 'handcrafted', 'editorial'],
    videoStyles: ['ugc', 'kinetic'],
    platforms: ['instagram', 'facebook'],
    postTypes: { educational: 2, tip: 2, question: 1, sales: 2, bts: 1 },
    startDate: addDays(new Date().toISOString().slice(0, 10), 1),
    times: ['09:00', '12:30', '17:30', '19:30', '21:00'],
    goal: 'sales',
  };
}

function topicBank(f: Facts, v: Voice): Record<PostType, string[]> {
  const o = (i: number) => verbOutcome(f.outcomes[i % f.outcomes.length]);
  return {
    educational: [
      `How to ${f.quickWins[0]}`,
      `3 steps to ${o(0)}`,
      `The ${f.terms[0]} framework, explained simply`,
      `A beginner’s guide to ${f.terms[1] ?? f.topicLower}`,
      `How to ${o(1)}`,
      `What to do when ${f.pains[1] ?? f.pain}`,
      `${f.topic}: the 80/20 version`,
      `How to set up ${f.terms[2] ?? f.terms[0]}, step by step`,
    ],
    tip: [
      capitalize(f.quickWins[1] ?? f.quickWins[0]),
      `Avoid ${f.mistakes[0]}`,
      `The ${f.terms[0]} shortcut`,
      capitalize(f.quickWins[2] ?? f.quickWins[0]),
      `Stop ${f.mistakes[1] ?? f.mistakes[0]}`,
      capitalize(f.quickWins[3] ?? f.quickWins[0]),
    ],
    question: [
      `What’s your biggest struggle with ${f.topicLower}?`,
      `“${f.myths[0]}”: agree or disagree?`,
      `What does a good ${f.topicLower} week look like for you?`,
      `Which matters more: ${f.terms[0]} or ${f.terms[1] ?? 'consistency'}?`,
      `What’s one ${f.topicLower} win you had this month?`,
    ],
    sales: [
      `Introducing ${f.productShort}`,
      `What’s inside ${f.productShort}`,
      `Who ${f.productShort} is for (and who it isn’t)`,
      `${f.productShort}: price and what’s included`,
      `Questions about ${f.productShort}, answered`,
      f.track === 'business' ? `Book your ${f.business?.tiers[1] ?? 'first'} visit` : `Is ${f.productShort} right for you?`,
    ],
    bts: [
      f.track === 'business' ? `A day at ${f.brand}` : `How we built ${f.productShort}`,
      `Meet the ${f.brand} team`,
      `What to expect from ${f.brand}`,
      `Why ${v.we === 'I' ? 'I' : 'we'} started ${f.brand}`,
      `Our process, start to finish`,
      f.local && f.city ? `Proud to serve ${f.city}` : `What ${v.we === 'I' ? 'I' : 'we'} learned this month`,
    ],
  };
}

export const TRUST_GOAL = 'Show your process, the people behind it, and real customer words when you have them.';
export const RECAP_MESSAGE = 'Here is what’s included, and how to get it.';
export const trustMessage = (brand: string) => `Here is how ${brand} works, and who is behind it.`;
/** What the business or product does for people is the owner's to say: the key message only describes the offer. */
export const offerKeyMessage = (product: string) => `${product}: what it is, who it’s for, and what it costs.`;
export const recapGoal = (track: Project['track']) => `Recap the month and remind people how to ${track === 'business' ? 'book' : 'buy'}.`;

export function generateCampaignPlan(project: Project, config: CampaignConfig, d: Directives = {}, variation = 0): CampaignPlan {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|plan|${variation}`));
  const rng = createRng(hashStr(`${project.id}|plan-rng|${variation}`));
  const types = (Object.keys(config.postTypes) as PostType[]).filter((t) => config.postTypes[t] > 0);
  const activeTypes = types.length ? types : (['educational', 'tip', 'sales'] as PostType[]);
  const platforms = config.platforms.length ? config.platforms : (['instagram'] as PostPlatform[]);
  const imageStyles: ImageStyleId[] = config.imageStyles.length ? config.imageStyles : ['minimal'];
  const videoStyles: VideoStyleId[] = config.videoStyles.length ? config.videoStyles : ['kinetic'];
  const perDay = Math.max(1, Math.min(5, config.postsPerDay));
  // the videos on each weekday (Monday first): they land on the days the setup chose
  const videoDays = videoDaysOf(config);
  const videosWeek = videoDays.reduce((a, b) => a + b, 0);
  const times = config.times.slice(0, perDay).sort();
  const bank = topicBank(f, v);
  const topicCursor: Record<PostType, number> = { educational: 0, tip: 0, question: 0, sales: 0, bts: 0 };
  const platformCount: Record<string, number> = {};
  const styleCursor = { image: rng.int(0, 10), video: rng.int(0, 10) };
  const goalBoost: Record<PostType, number> = config.goal === 'sales' ? { educational: 1, tip: 1, question: 0.9, sales: 1.25, bts: 1 } : config.goal === 'leads' ? { educational: 1.2, tip: 1.1, question: 1, sales: 0.85, bts: 1 } : { educational: 1, tip: 1.15, question: 1.25, sales: 0.7, bts: 1.1 };

  // Balance the mix within each phase so later phases don't "catch up" on earlier ones.
  let phaseName = '';
  let phaseCount: Record<PostType, number> = { educational: 0, tip: 0, question: 0, sales: 0, bts: 0 };
  let phaseAssigned = 0;
  const days: PlanDay[] = [];
  for (let i = 0; i < 30; i++) {
    const date = addDays(config.startDate, i);
    const wd = weekdayIndex(date);
    const posting = !!config.days[wd];
    const phase = PHASES.find((p) => i <= p.until) ?? PHASES[PHASES.length - 1];
    if (phase.name !== phaseName) {
      phaseName = phase.name;
      phaseCount = { educational: 0, tip: 0, question: 0, sales: 0, bts: 0 };
      phaseAssigned = 0;
    }
    const slots: PlanSlot[] = [];
    if (posting) {
      const videoIdx = new Set(rng.shuffle(Array.from({ length: perDay }, (_, k) => k)).slice(0, Math.min(perDay, videoDays[wd])));
      for (let s = 0; s < perDay; s++) {
        const format: PostFormat = videoIdx.has(s) ? 'video' : 'image';
        // post type with largest deficit vs. its weighted target share
        const weights = activeTypes.map((t) => config.postTypes[t] * phase.weights[t] * goalBoost[t]);
        const wSum = weights.reduce((a, b) => a + b, 0) || 1;
        let best = activeTypes[0];
        let bestDeficit = -Infinity;
        activeTypes.forEach((t, k) => {
          const target = ((phaseAssigned + 1) * weights[k]) / wSum;
          const deficit = target - phaseCount[t] + rng.float(0, 0.15);
          if (deficit > bestDeficit) {
            bestDeficit = deficit;
            best = t;
          }
        });
        const postType = best;
        phaseCount[postType]++;
        phaseAssigned++;
        // platform: least used, weighted by fit
        const platform = platforms
          .map((p) => ({ p, score: (platformCount[p] ?? 0) / ((format === 'video' ? PLATFORM_FIT[p].video : 1) * (PLATFORM_FIT[p][postType] ?? 1)) + rng.float(0, 0.3) }))
          .sort((a, b) => a.score - b.score)[0].p;
        platformCount[platform] = (platformCount[platform] ?? 0) + 1;
        // style rotation with a fit nudge
        const pool: StyleId[] = format === 'video' ? videoStyles : imageStyles;
        const cursor = format === 'video' ? styleCursor.video++ : styleCursor.image++;
        const rotated = pool[cursor % pool.length];
        const fitted = pool.slice().sort((a, b) => (STYLE_FIT[b][postType] ?? 1) - (STYLE_FIT[a][postType] ?? 1))[0];
        const style = rng.chance(0.4) ? fitted : rotated;
        const list = bank[postType];
        const topic = list[topicCursor[postType]++ % list.length];
        slots.push({ id: uid('slot'), time: times[s] ?? config.times[s] ?? '12:00', platform, format, style, postType, topic });
      }
    }
    days.push({ date, dayIndex: i, week: Math.min(5, Math.floor(i / 7) + 1), phase: phase.name, posting, slots });
  }

  const all = days.flatMap((d) => d.slots);
  const byType: Record<PostType, number> = { educational: 0, tip: 0, question: 0, sales: 0, bts: 0 };
  const byPlatform: Partial<Record<PostPlatform, number>> = {};
  for (const s of all) {
    byType[s.postType]++;
    byPlatform[s.platform] = (byPlatform[s.platform] ?? 0) + 1;
  }
  const weeks = [
    { week: 1, theme: 'Awareness: name the problem', goal: `Make ${f.audience} feel seen around ${f.pain}.`, kpi: 'Reach, profile visits, follows', keyMessage: `${capitalize(f.pain)} is worth talking about.` },
    { week: 2, theme: 'Authority: teach the method', goal: `Show the steps to ${verbOutcome(f.outcomes[0])}.`, kpi: 'Saves, shares, lead magnet opt-ins', keyMessage: `Here is how ${f.brand} approaches ${f.topicLower}.` },
    // Key messages claim no results, popularity or deadlines: customer words and offers come from the owner.
    { week: 3, theme: 'Trust: proof & community', goal: TRUST_GOAL, kpi: 'Comments, DMs, email replies', keyMessage: trustMessage(f.brand) },
    { week: 4, theme: 'Conversion: open the offer', goal: `Drive ${f.track === 'business' ? 'bookings' : 'sales'} of ${f.productShort}.`, kpi: 'Link clicks, conversions, revenue', keyMessage: offerKeyMessage(f.productShort) },
    { week: 5, theme: 'Final push & recap', goal: recapGoal(f.track), kpi: 'Conversions, retargeting audience size', keyMessage: RECAP_MESSAGE },
  ];
  const strategy = `A 30-day ${config.goal === 'sales' ? 'launch' : config.goal === 'leads' ? 'list-building' : 'awareness'} campaign for ${f.brand} on ${platforms.map((p) => PLATFORMS[p].label).join(', ')}. ${all.length} posts across ${days.filter((x) => x.posting).length} posting days move ${f.audience} from awareness (week 1) to authority (week 2), trust (week 3) and conversion (week 4). ${videosWeek ? `${videosWeek} short ${videosWeek === 1 ? 'video goes' : 'videos go'} out each week on the chosen video days to maximize reach;` : 'Static posts carry the plan;'} sales posts ramp up in the final ten days${f.leadMagnet ? `, and educational posts point to the free “${f.leadMagnet}”` : ''}.`;
  return {
    id: uid('plan'),
    createdAt: Date.now(),
    startDate: config.startDate,
    strategy,
    days,
    weeks,
    summary: { total: all.length, videos: all.filter((s) => s.format === 'video').length, images: all.filter((s) => s.format === 'image').length, byType, byPlatform },
  };
}

// ───────────────────────── Post composition ─────────────────────────

export interface ComposeInput {
  topic: string;
  postType: PostType;
  platform: PostPlatform;
  format: PostFormat;
  style: StyleId;
  goal?: CampaignConfig['goal'];
  mediaDescription?: string;
  hasMedia?: boolean;
  watermark?: boolean;
  /** the post's link and where it goes (postLinkFor); without one, the caption keeps today's wording */
  link?: PostLink | null;
}

export interface ComposedPost {
  headline: string;
  caption: string;
  hashtags: string[];
  visualPrompt: string;
  storyboard?: Scene[];
}

function shortHeadline(input: ComposeInput, f: Facts, v: Voice): string {
  const t = input.topic.replace(/[“”"]/g, '');
  switch (input.postType) {
    case 'question':
      return truncate(t, 70);
    case 'sales':
      return truncate(v.pick([t, `${f.productShort} is here`, `Want to ${verbOutcome(f.outcomes[0])}?`]), 64);
    case 'bts':
      return truncate(t, 60);
    case 'tip':
      return truncate(t, 58);
    default:
      return truncate(t, 62);
  }
}

/** What the business or product is, from the owner's inputs only. */
function whatItIs(f: Facts): string {
  if (f.track === 'business') {
    const label = (f.business?.label ?? f.topic).toLowerCase();
    return `${f.brand} offers ${label}${f.city ? ` in ${f.city}` : ''}`;
  }
  return `${f.productShort} is a ${f.formatLabel.toLowerCase()} about ${f.topicLower} for ${f.audience}`;
}

export function composePost(project: Project, input: ComposeInput, d: Directives = {}, seed: string | number = 0): ComposedPost {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|post|${seed}|${input.topic}|${input.platform}|${input.postType}`));
  const rng = v.rng;
  const isX = input.platform === 'x';
  const media = input.mediaDescription?.trim();
  const topicLower = lowerFirst(input.topic.replace(/[?.!]$/, ''));
  const hook = media
    ? v.pick([`${capitalize(media)}.${v.ee('spark')}`, `Here’s a look at ${lowerFirst(media)}.`, `${capitalize(media)}, and why it matters for ${f.audience}.`])
    : input.postType === 'question'
      ? input.topic
      : rng.chance(0.55)
        ? v.hook(input.postType, f.topicLower)
        : `${capitalize(topicLower)}${v.ee('spark')}`;

  const n = v.count(3, 3, 5);
  const lines: string[] = [];
  switch (input.postType) {
    case 'educational': {
      const verbs = ['get clear on your', 'track your', 'review your'];
      const steps = rng.shuffle([...f.quickWins, ...f.terms.slice(0, 3).map((t, k) => `${verbs[k % verbs.length]} ${t}`)]).slice(0, n);
      if (!isX) lines.push(hook.startsWith(capitalize(topicLower)) ? 'Here’s the simple version:' : `${capitalize(topicLower)}. Here’s the simple version:`);
      steps.forEach((s, i) => lines.push(`${i + 1}. ${capitalize(s)}`));
      if (v.length !== 'short' && !isX) lines.push(`Want to ${verbOutcome(rng.pick(f.outcomes))}? Start with step 1.`);
      break;
    }
    case 'tip': {
      const tip = rng.pick(f.quickWins);
      lines.push(`Try this today: ${tip}.`);
      if (!isX) lines.push(`Worth a try if ${lowerFirst(rng.pick(f.pains))} sounds familiar.${v.ee('idea')}`);
      if (v.length === 'long') lines.push(`Bonus: pair it with a weekly ${f.terms[0]} check-in.`);
      break;
    }
    case 'question': {
      if (!isX) lines.push(`${capitalize(v.we)}’re curious.${v.ee('wave')} How do you handle ${f.topicLower}?`);
      if (v.length !== 'short' && !isX) lines.push(`A) ${capitalize(f.quickWins[0])}\nB) ${capitalize(f.quickWins[1] ?? f.quickWins[0])}\nC) Something else entirely`);
      break;
    }
    case 'sales': {
      const fw = d.framework ?? rng.pick(['PAS', 'AIDA', 'BAB'] as const);
      if (fw === 'BAB') {
        lines.push(`Dealing with ${f.pain}?`, `Looking for ${lowerFirst(rng.pick(f.wishes))}?`, `${whatItIs(f)}.`);
      } else if (fw === 'AIDA') {
        lines.push(`${whatItIs(f)}.`, `Want to ${verbOutcome(f.outcomes[0])}? Take a look.`);
      } else {
        lines.push(`Is ${f.pain} on your mind?`, `${whatItIs(f)}.`);
      }
      if (!isX && v.length !== 'short' && f.price > 0) lines.push(`${f.track === 'business' ? 'Starting at' : 'Just'} ${f.priceStr}${f.priceSuffix}.${v.ee('fire')}`);
      break;
    }
    case 'bts': {
      lines.push(
        v.pick([
          'Here’s a look behind the scenes.',
          `A quick look at how ${f.brand} works.`,
          `This is the part most people never see.`,
        ]),
      );
      const asks = ['What would you like to see next?', `Any questions about ${f.topicLower}? Ask below.`, `What do you want to know about ${f.brand}?`];
      if (!isX) lines.push(`${v.pick(asks)}${v.ee('heart')}`);
      break;
    }
  }

  const ctaKind =
    input.postType === 'question'
      ? 'comment'
      : input.postType === 'sales'
        ? f.track === 'business'
          ? 'book'
          : 'buy'
        : input.postType === 'educational'
          ? input.goal === 'leads' && f.leadMagnet
            ? 'optin'
            : rng.chance(0.5)
              ? 'save'
              : 'share'
          : input.postType === 'tip'
            ? rng.chance(0.5)
              ? 'save'
              : 'comment'
            : 'link';
  const cta = v.cta(ctaKind, input.platform);
  const tagCount = Math.min(PLATFORMS[input.platform].hashtags, v.length === 'short' ? 3 : PLATFORMS[input.platform].hashtags);
  const hashtags = v.hashtags(tagCount);

  // the link where it goes on this network; on X the opening is shortened, never the link or the call to action
  const caption = v.includeMust(finishCaption(project, [hook, ...lines, cta].filter(Boolean).join('\n\n'), input.platform, input.link ?? null, hashtags));

  const styleDef = [...IMAGE_STYLES, ...VIDEO_STYLES].find((s) => s.id === input.style) ?? IMAGE_STYLES[0];
  const headline = shortHeadline(input, f, v);
  const subject = media
    ? media
    : f.track === 'business'
      ? `${f.business?.label ?? 'local business'} scene with real people, ${f.city || 'neighborhood'} setting`
      : `${f.productShort} (${f.formatLabel.toLowerCase()}) shown in use by ${singular(f.audience)}`;
  const visualPrompt = `${styleDef.prompt}. Subject: ${subject}. On-image text: “${headline}”. Brand colors ${project.brand.colors.primary} and ${project.brand.colors.accent}${input.watermark ? `, small watermark “${f.mark}” bottom-right` : ''}.`;

  let storyboard: Scene[] | undefined;
  if (input.format === 'video' || isVideoStyle(input.style)) {
    const vs = input.style as VideoStyleId;
    const shot: Record<string, string[]> = {
      ugc: ['Selfie close-up, handheld, talking fast', 'Quick jump cut to screen/product', 'Point at caption text', 'Back to face, smiling, pointing down'],
      kinetic: ['Bold word slam on brand color', 'Words stack line by line', 'Number counter animation', 'Logo + CTA lockup'],
      split: ['Top: the problem (desaturated)', 'Bottom: the fix (bright, brand color)', 'Wipe transition to result', 'Full frame CTA'],
      cinematic: ['Slow push-in, shallow focus', 'Macro detail with light leak', 'Hands using the product', 'Title card with logo'],
      talking: ['Face to camera, lower-third name', 'B-roll overlay of the process', 'Back to camera with key point', 'CTA lower-third'],
    };
    const shots = shot[vs] ?? shot.kinetic;
    const steps = rng.shuffle(f.quickWins).slice(0, 2);
    storyboard = [
      { id: uid('sc'), text: truncate(hook.replace(/\n/g, ' '), 64), shot: shots[0], duration: 2 },
      { id: uid('sc'), text: truncate(input.postType === 'sales' ? `${capitalize(f.pain)}?` : capitalize(steps[0] ?? topicLower), 56), shot: shots[1], duration: 4 },
      { id: uid('sc'), text: truncate(input.postType === 'sales' ? `Meet ${f.productShort}` : capitalize(steps[1] ?? verbOutcome(f.outcomes[0])), 56), shot: shots[2], duration: 5 },
      { id: uid('sc'), text: truncate(input.postType === 'question' ? 'Tell us below ↓' : input.postType === 'sales' ? f.urlDisplay || f.mark || 'link in bio' : 'Save this for later', 48), shot: shots[3], duration: 3 },
    ];
  }

  return { headline, caption, hashtags, visualPrompt, storyboard };
}

/** A caption as it goes out: its link where it goes on this network, and short enough for X. */
export function finishCaption(project: Project, caption: string, platform: PostPlatform, link: PostLink | null, hashtags: string[]): string {
  const placed = placeLink(caption, link, platform, knownLinks(project));
  return platform === 'x' ? fitForX(placed, hashtags) : placed;
}

/** What the AI is told about a post's link. The app places the link again afterwards, so a slip doesn't stay. */
export function linkRule(link: PostLink | null, platform: PostPlatform): string {
  const where = platform === 'x' ? 'reply' : 'comment';
  if (!link) return 'There is no link yet: write no web address; if the call to action needs a link, say “link in bio”.';
  if (link.placement === 'post') return `End the call to action with this exact link: ${linkText(link.url)}. Write no other web address.`;
  if (link.placement === 'comment') return `Write no web address: the link goes in the first ${where}, so the call to action says “link in the first ${where}”.`;
  return 'Write no web address: the call to action says “link in bio”.';
}

/**
 * A plan day's slots with as many videos as the setup now chooses for that weekday (a plan made before the video days
 * changed): extra videos become image posts and missing ones turn image posts into videos, from the last slot back,
 * each taking the first style of its kind.
 */
export function fitSlotsToVideoDays(day: Pick<PlanDay, 'date' | 'slots'>, config: CampaignConfig): PlanSlot[] {
  const want = videoDaysOf(config)[weekdayIndex(day.date)] ?? 0;
  const slots = day.slots.map((s) => ({ ...s }));
  let have = slots.filter((s) => s.format === 'video').length;
  const imageStyle: StyleId = config.imageStyles[0] ?? 'minimal';
  const videoStyle: StyleId = config.videoStyles[0] ?? 'kinetic';
  for (let i = slots.length - 1; i >= 0 && have !== want; i--) {
    const s = slots[i];
    if (have > want && s.format === 'video') {
      slots[i] = { ...s, format: 'image', style: isVideoStyle(s.style) ? imageStyle : s.style };
      have--;
    } else if (have < want && s.format === 'image') {
      slots[i] = { ...s, format: 'video', style: isVideoStyle(s.style) ? s.style : videoStyle };
      have++;
    }
  }
  return slots;
}

export function generateContentBatch(project: Project, plan: CampaignPlan, config: CampaignConfig, d: Directives = {}, variation = 0, days = 7): Post[] {
  const batchId = uid('batch');
  const now = Date.now();
  const posts: Post[] = [];
  for (const day of plan.days.slice(0, days)) {
    // videos land on the days the setup chooses now
    for (const slot of fitSlotsToVideoDays(day, config)) {
      // the link where this network's setting puts it (the post keeps that choice, and the comment's text when it goes there)
      const link = postLinkFor(project, slot.platform);
      const c = composePost(project, { topic: slot.topic, postType: slot.postType, platform: slot.platform, format: slot.format, style: slot.style, goal: config.goal, watermark: config.watermark, link }, d, `${slot.id}|${variation}`);
      const firstComment = firstCommentFor(project, link);
      posts.push({
        id: uid('post'),
        projectId: project.id,
        status: 'draft',
        platform: slot.platform,
        format: slot.format,
        style: slot.style,
        postType: slot.postType,
        headline: c.headline,
        visualPrompt: c.visualPrompt,
        caption: c.caption,
        hashtags: c.hashtags,
        ...(link ? { linkPlacement: link.placement } : {}),
        ...(firstComment ? { firstComment } : {}),
        scheduledAt: combineDateTime(day.date, slot.time),
        storyboard: c.storyboard,
        watermark: config.watermark,
        source: 'batch',
        planSlotId: slot.id,
        batchId,
        createdAt: now,
        updatedAt: now,
        seed: hashStr(slot.id + variation),
      });
    }
  }
  return posts;
}

export function postTypeLabel(t: PostType): string {
  return POST_TYPE_MAP[t].label;
}

export function suggestTopics(project: Project, d: Directives = {}): string[] {
  const f = buildFacts(project);
  const v = Voice.create(f, d, hashStr(`${project.id}|suggest|${new Date().toDateString()}`));
  const b = topicBank(f, v);
  return [b.tip[0], b.educational[1], b.question[0], b.sales[0], b.bts[0]];
}
