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
    videosPerDay: 1,
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
      `How ${f.audience} ${o(1)}`,
      `What to do when ${f.pains[1] ?? f.pain}`,
      `${f.topic}: the 80/20 version`,
      `How to set up ${f.terms[2] ?? f.terms[0]} in 15 minutes`,
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
      `What would you do with an extra 5 hours a week?`,
      `Which matters more: ${f.terms[0]} or ${f.terms[1] ?? 'consistency'}?`,
      `What’s one ${f.topicLower} win you had this month?`,
    ],
    sales: [
      `Introducing ${f.productShort}`,
      `What’s inside ${f.productShort}`,
      `Who ${f.productShort} is for (and who it isn’t)`,
      `${f.productShort}: launch offer`,
      `Last chance: launch bonus ends soon`,
      f.track === 'business' ? `Book your ${f.business?.tiers[1] ?? 'first'} visit` : `Why ${f.productShort} costs less than ${f.pain}`,
    ],
    bts: [
      f.track === 'business' ? `A day at ${f.brand}` : `How we built ${f.productShort}`,
      `Meet the ${f.brand} team`,
      `Customer spotlight: a ${singular(f.audience)}’s win`,
      `Why ${v.we === 'I' ? 'I' : 'we'} started ${f.brand}`,
      `Our process, start to finish`,
      f.local && f.city ? `Proud to serve ${f.city}` : `What ${v.we === 'I' ? 'I' : 'we'} learned this month`,
    ],
  };
}

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
  const videos = Math.max(0, Math.min(perDay, config.videosPerDay));
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
      const videoIdx = new Set(rng.shuffle(Array.from({ length: perDay }, (_, k) => k)).slice(0, videos));
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
  let estReach = 0;
  for (const s of all) {
    byType[s.postType]++;
    byPlatform[s.platform] = (byPlatform[s.platform] ?? 0) + 1;
    estReach += 650 * PLATFORMS[s.platform].reachMult * (s.format === 'video' ? 1.6 : 1);
  }
  const weeks = [
    { week: 1, theme: 'Awareness: name the problem', goal: `Make ${f.audience} feel seen around ${f.pain}.`, kpi: 'Reach, profile visits, follows', keyMessage: `${capitalize(f.pain)} is common and fixable.` },
    { week: 2, theme: 'Authority: teach the method', goal: `Show the steps to ${verbOutcome(f.outcomes[0])}.`, kpi: 'Saves, shares, lead magnet opt-ins', keyMessage: `There is a simple system for ${f.topicLower}.` },
    { week: 3, theme: 'Trust: proof & community', goal: 'Show real people, process and results.', kpi: 'Comments, DMs, email replies', keyMessage: `People like you are already getting results with ${f.brand}.` },
    { week: 4, theme: 'Conversion: open the offer', goal: `Drive ${f.track === 'business' ? 'bookings' : 'sales'} of ${f.productShort}.`, kpi: 'Link clicks, conversions, revenue', keyMessage: `${f.productShort} is the fastest way to ${verbOutcome(f.outcomes[0])}.` },
    { week: 5, theme: 'Final push & recap', goal: 'Create urgency and recap the month.', kpi: 'Conversions, retargeting audience size', keyMessage: 'The launch offer ends soon.' },
  ];
  const strategy = `A 30-day ${config.goal === 'sales' ? 'launch' : config.goal === 'leads' ? 'list-building' : 'awareness'} campaign for ${f.brand} on ${platforms.map((p) => PLATFORMS[p].label).join(', ')}. ${all.length} posts across ${days.filter((x) => x.posting).length} posting days move ${f.audience} from awareness (week 1) to authority (week 2), trust (week 3) and conversion (week 4). ${videos ? `${videos} of ${perDay} daily posts are short videos to maximize reach;` : 'Static posts carry the plan;'} sales posts ramp up in the final ten days${f.leadMagnet ? `, and educational posts point to the free “${f.leadMagnet}”` : ''}.`;
  return {
    id: uid('plan'),
    createdAt: Date.now(),
    startDate: config.startDate,
    strategy,
    days,
    weeks,
    summary: { total: all.length, videos: all.filter((s) => s.format === 'video').length, images: all.filter((s) => s.format === 'image').length, byType, byPlatform, estReach: Math.round(estReach) },
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
      return truncate(v.pick([t, `${f.productShort} is here`, capitalize(verbOutcome(f.outcomes[0]))]), 64);
    case 'bts':
      return truncate(t, 60);
    case 'tip':
      return truncate(t, 58);
    default:
      return truncate(t, 62);
  }
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
      if (v.length !== 'short' && !isX) lines.push(`Do this for two weeks and you’ll ${verbOutcome(rng.pick(f.outcomes))}.`);
      break;
    }
    case 'tip': {
      const tip = rng.pick(f.quickWins);
      lines.push(`Try this today: ${tip}.`);
      if (!isX) lines.push(`Why it works: it removes ${lowerFirst(rng.pick(f.pains))} before it starts.${v.ee('idea')}`);
      if (v.length === 'long') lines.push(`Bonus: pair it with a weekly ${f.terms[0]} check-in.`);
      break;
    }
    case 'question': {
      if (!isX) lines.push(`${capitalize(v.we)}’re curious.${v.ee('wave')} Every ${singular(f.audience)} we talk to handles ${f.topicLower} differently.`);
      if (v.length !== 'short' && !isX) lines.push(`A) ${capitalize(f.quickWins[0])}\nB) ${capitalize(f.quickWins[1] ?? f.quickWins[0])}\nC) Something else entirely`);
      break;
    }
    case 'sales': {
      const fw = d.framework ?? rng.pick(['PAS', 'AIDA', 'BAB'] as const);
      if (fw === 'BAB') {
        lines.push(`Before: ${f.pain}.`, `After: ${lowerFirst(f.desire)}.`, `The bridge: ${f.productShort}.`);
      } else if (fw === 'AIDA') {
        lines.push(`${f.productShort} helps ${f.audience} ${verbOutcome(f.outcomes[0])}.`, `Imagine next month without ${f.pain}.`);
      } else {
        lines.push(`${capitalize(f.pain)} costs more than you think: time, money and headspace.`, `${f.productShort} fixes it with ${f.terms.slice(0, 2).join(' + ')}.`);
      }
      if (!isX && v.length !== 'short') lines.push(`${f.track === 'business' ? 'Starting at' : 'Just'} ${f.priceStr}${f.priceSuffix}.${v.ee('fire')}`);
      break;
    }
    case 'bts': {
      lines.push(
        v.pick([
          'Most people never see this part, but it’s where the quality comes from.',
          `${capitalize(v.we)} don’t share this often: here’s what really goes into it.`,
          `This is the unglamorous part ${v.we} love most.`,
        ]),
      );
      const lessons = f.local ? ['details are the difference', 'small touches add up', 'every customer deserves our best, every visit'] : ['systems beat willpower', 'small steps compound', 'listening to customers changes everything', 'details are the difference'];
      if (!isX) lines.push(`The lesson: ${v.pick(lessons)}.${v.ee('heart')}`);
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

  let caption = [hook, ...lines, cta].filter(Boolean).join('\n\n');
  if (isX && caption.length > 270 - hashtags.join(' ').length) {
    caption = [hook, cta].join('\n\n');
    if (caption.length > 270) caption = truncate(hook, 200) + '\n\n' + truncate(cta, 60);
  }
  caption = v.includeMust(caption);

  const styleDef = [...IMAGE_STYLES, ...VIDEO_STYLES].find((s) => s.id === input.style) ?? IMAGE_STYLES[0];
  const headline = shortHeadline(input, f, v);
  const subject = media
    ? media
    : f.track === 'business'
      ? `${f.business?.label ?? 'local business'} scene with real people, ${f.city || 'neighborhood'} setting`
      : `${f.productShort} (${f.formatLabel.toLowerCase()}) shown in use by ${singular(f.audience)}`;
  const visualPrompt = `${styleDef.prompt}. Subject: ${subject}. On-image text: “${headline}”. Brand colors ${project.brand.colors.primary} and ${project.brand.colors.accent}${input.watermark ? `, small watermark “${f.urlDisplay}” bottom-right` : ''}.`;

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
      { id: uid('sc'), text: truncate(input.postType === 'sales' ? `${f.productShort} fixes it` : capitalize(steps[1] ?? verbOutcome(f.outcomes[0])), 56), shot: shots[2], duration: 5 },
      { id: uid('sc'), text: truncate(input.postType === 'question' ? 'Tell us below ↓' : input.postType === 'sales' ? `${f.urlDisplay}` : 'Save this for later', 48), shot: shots[3], duration: 3 },
    ];
  }

  return { headline, caption, hashtags, visualPrompt, storyboard };
}

export function generateContentBatch(project: Project, plan: CampaignPlan, config: CampaignConfig, d: Directives = {}, variation = 0, days = 7): Post[] {
  const batchId = uid('batch');
  const now = Date.now();
  const posts: Post[] = [];
  for (const day of plan.days.slice(0, days)) {
    for (const slot of day.slots) {
      const c = composePost(project, { topic: slot.topic, postType: slot.postType, platform: slot.platform, format: slot.format, style: slot.style, goal: config.goal, watermark: config.watermark }, d, `${slot.id}|${variation}`);
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
