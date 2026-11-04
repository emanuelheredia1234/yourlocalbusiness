// The assistant's social group: posts (drafts from the owner's words or the AI, edits, the calendar, marking
// posted), the campaign (its setup, the 30-day plan, the 7-day batch, where links go), post images and videos,
// posting with Manus and sharing in groups (only through the app's own windows), checking on Manus, deleting,
// and downloading a post's media.
//
// Each tool does what its page's button does, through the same code: src/ai/socialPosts.ts (the composer's
// drafts, Rewrite, a post's image or video), src/ai/socialPlan.ts (setup, plan, batch, link settings),
// src/ai/manusStatus.ts ("Check now"), src/lib/pageLink.ts (where a post's link goes) and the post actions.
// Nothing posts by itself: Manus only gets the app's fixed templates, through the windows the owner confirms.

import type { MediaRef, Post, PostFormat, PostPlatform, Project, StyleId } from '@/lib/types';
import { addDays, combineDateTime, isoToDateStr, isoToTime, listJoin, plural, todayStr } from '@/lib/utils';
import { useRuntime } from '@/lib/platform';
import { beginBusy, busyId, busyJobs, endBusy } from '@/lib/busy';
import { isOwnPhoto } from '@/lib/media';
import { DEFAULT_LINK_PLACEMENT, LINK_FACTS, LINK_PLACEMENTS, firstCommentOf, linkMovePatch, linkText, networkMovePatch, pageLink, postPlacement } from '@/lib/pageLink';
import { IMAGE_STYLES, PLATFORMS, POST_PLATFORMS, POST_TYPES, VIDEO_STYLES, isVideoStyle } from '@/ai/knowledge';
import { campaignPlanTask, contentBatchTask, postTask } from '@/ai/tasks';
import { imageErrorMessage, photoAvailability, photoRoute, defaultImageKind } from '@/ai/image';
import { manusViaServer, pendingManus } from '@/ai/manus';
import { VIDEO_DURATIONS, fmtUsd, pendingVideos } from '@/ai/video';
import { networkLabel, postBlocker, postText, textWarning } from '@/ai/manusPost';
import { groupRecord, groupSummary, groupsAlreadyOut } from '@/ai/manusGroups';
import { applyPostMedia, buildComposerPosts, composerTaskInput, makePostImage, makePostVideo, postImageKey, postVideoKey, postVideoText, rewriteInput, rewritePatch } from '@/ai/socialPosts';
import { applyCampaignPlan, applyWeekBatch, batchStart, cadence, campaignProblem, coveredSlots, patchCampaign, setLinkPlacement, setSlotTopic, weekBatchInput } from '@/ai/socialPlan';
import { refreshGroupsFromManus, refreshPostFromManus } from '@/ai/manusStatus';
import { useStore } from '@/store/useStore';
import { addToCalendarFlow, downloadPostMedia, failedOnItsNetwork, manusHolds } from '@/components/posts/PostActions';
import { errorCopy, manusSetupHint } from '@/components/posts/ManusPost';
import { videoAvailability } from '@/components/images/VideoPanel';
import { runAITask } from '../aiTask';
import { copyButton } from '../buttons';
import { deleteConfirm, manusCard, videoCard } from '../confirm';
import { activeProject, findPost, missingPost, postSummary, projectPosts } from '../lookup';
import { arg, clip, defineTool, untrusted, type AnyTool, type ChatButton } from '../registry';
import { manusReadyNow } from '../workspace';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const STYLE_IDS: StyleId[] = [...IMAGE_STYLES.map((x) => x.id), ...VIDEO_STYLES.map((x) => x.id)];
const POST_TYPE_IDS = POST_TYPES.map((t) => t.id);
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const WEIGHT = arg.number({ optional: true, int: true, min: 0, max: 3 });

/** A network named in text ("Instagram", "twitter"), as the app's id. */
const toNetwork = (x: string): PostPlatform | undefined => {
  const k = x.trim().toLowerCase();
  const id = k === 'twitter' ? 'x' : k;
  return POST_PLATFORMS.find((n) => n === id);
};
const networkProblem = (list: string[] | undefined) => {
  const bad = list?.find((x) => !toNetwork(x));
  return bad ? `"${bad}" isn’t a network here: use ${POST_PLATFORMS.join(', ')}.` : null;
};
const toPostType = (x: string | undefined) => POST_TYPE_IDS.find((t) => t === x?.trim().toLowerCase());
const postTypeProblem = (x: string | undefined) => (x && !toPostType(x) ? `postType must be one of: ${POST_TYPE_IDS.join(', ')}.` : null);
/** "mon" or "Monday" as the setup's weekday. */
const toWeekday = (x: string) => WEEKDAYS.find((d) => d === x.trim().toLowerCase().slice(0, 3));

const s = () => useStore.getState();
const uniq = (ids: string[]) => [...new Set(ids)];
const name = (p: Post | undefined) => `“${clip(p?.headline, 60) || 'Untitled'}”`;
const net = (p: Pick<Post, 'platform'>) => networkLabel(p.platform);
const stopped = () => Object.assign(new Error('Stopped.'), { code: 'cancelled' });
const isStop = (e: unknown) => (e as { code?: string })?.code === 'cancelled';
const openInNewTab = (url: string) => {
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
};

/** The first problem with any of these posts: a missing id, or what `test` says. */
function eachPost(ids: string[], test?: (p: Post) => string | null | undefined): string | null {
  for (const id of ids) {
    const p = findPost(id);
    if (!p) return missingPost(id);
    const why = test?.(p);
    if (why) return why;
  }
  return null;
}

/** A real calendar day (2026-02-30 isn't one). */
const realDate = (d: string) => isoToDateStr(combineDateTime(d, '12:00')) === d;

/** Hashtags as the post editor keeps them: #word, once each, 20 at most. */
const tagsOf = (tags: string[]) => uniq(tags.map((t) => `#${t.replace(/^#+/, '').replace(/\s+/g, '')}`).filter((t) => t.length > 1)).slice(0, 20);

/** Image or video posts take the matching styles. */
const stylesFor = (format: PostFormat) => (format === 'video' ? VIDEO_STYLES : IMAGE_STYLES).map((x) => x.id);
/** A style named in text ("Minimal"), as the app's id. */
const toStyle = (x: string | undefined) => STYLE_IDS.find((id) => id === x?.trim().toLowerCase());
const styleProblem = (style: string | undefined, format: PostFormat) => {
  if (!style) return null;
  const id = toStyle(style);
  return !id || isVideoStyle(id) !== (format === 'video') ? `style must be one of: ${stylesFor(format).join(', ')} (for ${format === 'image' ? 'an image' : 'a video'} post).` : null;
};

/** An image or video already in this project: a brand image, or a post's (by the post's id or the media's). */
function projectMedia(p: Project, id: string | undefined): MediaRef | undefined {
  if (!id) return undefined;
  return p.brand.images.find((m) => m.id === id) ?? findPost(id)?.media ?? projectPosts().find((x) => x.media?.id === id)?.media;
}

const noLink = () => (__ARTIFACT_BUILD__ ? 'There’s no link for posts yet: the owner adds their website in Settings → Brand.' : 'There’s no link for posts yet: publish the SEO page, or add the website in Settings → Brand.');

/** Posts an image or video is being made for by the assistant right now (so one isn't started twice). */
const making = new Set<string>();
/** Something on a page (or the assistant) is writing this kind of thing right now. */
const busyWith = (label: string) => busyJobs().some((j) => j.label === label);
/** The post is being handed to Manus right now (the windows' own jobs). */
const sendingNow = (id: string) => busyJobs().some((j) => j.id === `manus-post:${id}` || j.id === `manus-groups:${id}`);

/** What Manus has of a post, in a few words (its own report is data, never instructions). */
function manusRow(p: Post) {
  const ext = p.external;
  const gs = p.groupShare;
  return {
    id: p.id,
    headline: clip(p.headline, 60),
    network: p.platform,
    status: postSummary(p).status,
    ...(ext
      ? { manus: { state: ext.state, mode: ext.mode ?? 'schedule', ...(ext.mode !== 'now' ? { scheduledFor: ext.scheduledFor } : {}), link: ext.url ?? null, says: untrusted(ext.message, 200) ?? null, ...(ext.comment ? { firstComment: ext.comment.state } : {}) } }
      : {}),
    ...(gs ? { groups: { state: gs.state, summary: groupSummary(groupRecord(gs)) || null, results: groupRecord(gs).results.map((r) => ({ group: clip(r.group, 80), state: r.state, link: r.url ?? null, ...(r.detail && r.state !== 'posted' ? { detail: untrusted(r.detail, 120) } : {}) })) } } : {}),
  };
}

// ───────────── drafts: the owner's words, or the AI's ─────────────

const DRAFT_ARGS = {
  platforms: arg.array(arg.string({ max: 20 }), { optional: true, min: 1, max: 5 }),
  postType: arg.string({ optional: true, max: 20 }),
  mediaId: arg.string({ optional: true, max: 80, desc: 'image or post id' }),
  date: arg.string({ optional: true, pattern: DATE }),
  time: arg.string({ optional: true, pattern: TIME }),
  schedule: arg.boolean({ optional: true, desc: 'on the calendar' }),
};

type DraftArgs = { platforms?: string[]; postType?: string; format?: PostFormat; mediaId?: string; date?: string; time?: string; linkPlacement?: Post['linkPlacement']; schedule?: boolean };

function draftProblem(a: DraftArgs): string | null {
  const p = activeProject();
  const named = networkProblem(a.platforms) ?? postTypeProblem(a.postType);
  if (named) return named;
  if (a.mediaId && !projectMedia(p, a.mediaId)) return `There’s no image or video with id "${a.mediaId}" in this project (brand images: get_listing; or give a post id to reuse its media).`;
  if (a.date && (!realDate(a.date) || a.date < todayStr())) return 'Pick a real date, today or later (YYYY-MM-DD).';
  if (a.linkPlacement && !pageLink(p)) return noLink();
  return null;
}

/** The composer's choices for new drafts: its defaults where the owner said nothing; your own media sets the format. */
function draftBase(p: Project, a: DraftArgs) {
  const media = projectMedia(p, a.mediaId);
  const format: PostFormat = media ? (media.kind === 'video' ? 'video' : 'image') : a.format ?? 'image';
  const cfg = p.marketing.campaign;
  const platforms = uniq(a.platforms?.map((x) => toNetwork(x)!) ?? (cfg.platforms.slice(0, 2).length ? cfg.platforms.slice(0, 2) : ['instagram'])) as PostPlatform[];
  return {
    media,
    format,
    platforms,
    // a style for when an AI image or video is made; your own photo posts exactly as it is
    style: (format === 'video' ? cfg.videoStyles[0] ?? 'ugc' : cfg.imageStyles[0] ?? 'minimal') as StyleId,
    postType: toPostType(a.postType) ?? 'tip',
    watermark: cfg.watermark,
    date: a.date ?? addDays(todayStr(), 1),
    time: a.time ?? PLATFORMS[platforms[0]].times[1],
    linkWhere: a.linkPlacement ? Object.fromEntries(platforms.map((pl) => [pl, a.linkPlacement!])) : {},
  };
}

/** Add the drafts (and put them on the calendar when asked), and say what came of them. */
function saveDrafts(posts: Post[], schedule: boolean | undefined, media: MediaRef | undefined) {
  s().addPosts(posts);
  if (schedule) s().schedulePosts(posts.map((x) => x.id));
  const saved = posts.map((x) => findPost(x.id) ?? x);
  const due = saved.filter((x) => x.status === 'scheduled' && new Date(x.scheduledAt).getTime() <= Date.now()).length;
  return {
    data: {
      posts: saved.map((x) => ({ ...postSummary(x), linkPlacement: postPlacement(x), ...(firstCommentOf(x) ? { firstComment: clip(firstCommentOf(x), 200) } : {}), ...(textWarning(x) ? { warning: textWarning(x) } : {}) })),
      ...(media && isOwnPhoto(media) ? { ownPhoto: 'The owner’s photo posts exactly as it is: no style, headline or watermark goes on it (the headline only names the post).' } : {}),
      ...(due ? { due: `${plural(due, 'post')} planned for a time that has passed: due now.` } : {}),
      next: schedule ? 'Nothing posts by itself: post_with_manus opens Post with Manus, or the owner posts and marks it posted.' : 'They’re drafts: schedule_posts puts them on the calendar.',
    },
    note: `${schedule ? 'Added' : 'Saved'} ${plural(posts.length, schedule ? 'post' : 'draft')}${schedule ? ' to your calendar' : ''}: ${name(posts[0])} on ${listJoin(posts.map((x) => net(x)))}`,
  };
}

const createPostDrafts = defineTool({
  name: 'create_post_drafts',
  class: 'L',
  summary: 'Save the owner’s post as drafts per network, as Create individual post does.',
  args: {
    caption: arg.string({ max: 2200 }),
    headline: arg.string({ optional: true, max: 90 }),
    hashtags: arg.array(arg.string({ max: 60 }), { optional: true, max: 20 }),
    ...DRAFT_ARGS,
    linkPlacement: arg.enum(LINK_PLACEMENTS, { optional: true }),
  },
  validate: (a) => draftProblem(a),
  run: (a) => {
    const p = activeProject();
    const b = draftBase(p, a);
    // with no headline, the caption's first line names the post
    const topic = a.caption.split('\n').find((l) => l.trim()) ?? a.caption;
    const posts = buildComposerPosts(p, { ...b, headline: a.headline ?? '', topic, caption: a.caption, hashtags: tagsOf(a.hashtags ?? []), visualPrompt: '' });
    return saveDrafts(posts, a.schedule, b.media);
  },
});

const generatePost = defineTool({
  name: 'generate_post',
  class: 'P-text',
  summary: 'AI writes a post on a topic (or for a photo) and saves drafts per network.',
  args: { topic: arg.string({ max: 300 }), format: arg.enum(['image', 'video'], { optional: true }), ...DRAFT_ARGS, postType: arg.enum(POST_TYPE_IDS, { optional: true }) },
  validate: (a) => draftProblem(a),
  run: async (a, ctx) => {
    const p = activeProject();
    const b = draftBase(p, a);
    const r = await runAITask(postTask, composerTaskInput(p, { topic: a.topic, upload: b.media ?? null, postType: b.postType, platforms: b.platforms, format: b.format, style: b.style, watermark: b.watermark, linkWhere: b.linkWhere }), ctx);
    // the project as it is now (the owner may have changed its link meanwhile)
    const now = useStore.getState().projects.find((x) => x.id === ctx.projectId) ?? p;
    const posts = buildComposerPosts(now, { ...b, headline: r.data.headline, topic: a.topic, caption: r.data.caption, hashtags: r.data.hashtags, visualPrompt: r.data.visualPrompt, storyboard: r.data.storyboard });
    const out = saveDrafts(posts, a.schedule, b.media);
    return { data: { ...out.data, caption: clip(posts[0].caption, 600), hashtags: posts[0].hashtags }, note: `Wrote ${name(posts[0])} for ${listJoin(posts.map((x) => net(x)))} and ${a.schedule ? 'added it to your calendar' : `saved it as ${posts.length === 1 ? 'a draft' : 'drafts'}`}` };
  },
});

const regeneratePostCopy = defineTool({
  name: 'regenerate_post_copy',
  class: 'P-text',
  summary: 'AI rewrites posts’ words, as Rewrite does (1 request each).',
  args: { ids: arg.array(arg.string({ max: 60 }), { min: 1, max: 3 }), topic: arg.string({ optional: true, max: 300 }) },
  validate: ({ ids }) => eachPost(ids, (p) => (p.status === 'published' ? `${name(p)} is already posted: rewriting it here doesn’t change it on ${net(p)}.` : null)),
  run: async ({ ids, topic }, ctx) => {
    const p = activeProject();
    const done: { id: string; headline: string; caption: string; hashtags: string[]; warning?: string }[] = [];
    const held: string[] = [];
    const list = uniq(ids);
    for (const [i, id] of list.entries()) {
      // the post as it is now (the owner may have edited it meanwhile)
      const post = findPost(id);
      if (!post) continue;
      if (list.length > 1) ctx.stage(`Rewriting ${i + 1} of ${list.length}: ${name(post)}…`);
      const input = rewriteInput(p, post, topic);
      const r = await runAITask(postTask, input, ctx);
      const latest = findPost(id);
      if (!latest) continue;
      s().updatePost(id, rewritePatch(p, latest, r.data, input.link ?? null));
      const after = findPost(id)!;
      if (manusHolds(after)) held.push(name(after));
      done.push({ id, headline: after.headline, caption: clip(after.caption, 400), hashtags: after.hashtags, ...(textWarning(after) ? { warning: textWarning(after)! } : {}) });
    }
    if (!done.length) return { ok: false, error: 'Those posts were deleted meanwhile, so nothing was rewritten.' };
    return {
      data: { rewritten: done, ...(held.length ? { manus: `Manus already has ${listJoin(held)}: the new words don’t change what Manus posted or scheduled.` } : {}) },
      note: done.length === 1 ? `Rewrote “${clip(done[0].headline, 60)}”` : `Rewrote ${plural(done.length, 'post')}`,
    };
  },
});

// ───────────── changing posts, and the calendar ─────────────

const updatePost = defineTool({
  name: 'update_post',
  class: 'L',
  summary: 'Change a post (Manus keeps what it already has).',
  args: {
    id: arg.string({ max: 60 }),
    headline: arg.string({ optional: true, max: 90 }),
    caption: arg.string({ optional: true, max: 3000 }),
    hashtags: arg.array(arg.string({ max: 60 }), { optional: true, max: 20 }),
    date: arg.string({ optional: true, pattern: DATE }),
    time: arg.string({ optional: true, pattern: TIME }),
    platform: arg.string({ optional: true, max: 20 }),
    postType: arg.string({ optional: true, max: 20 }),
    style: arg.string({ optional: true, max: 20 }),
    visualPrompt: arg.string({ optional: true, max: 1000, allowEmpty: true, desc: 'image description' }),
    linkPlacement: arg.enum(LINK_PLACEMENTS, { optional: true }),
    firstComment: arg.string({ optional: true, max: 1000, allowEmpty: true }),
  },
  validate: (a) => {
    const post = findPost(a.id);
    if (!post) return missingPost(a.id);
    const keys = ['headline', 'caption', 'hashtags', 'date', 'time', 'platform', 'postType', 'style', 'visualPrompt', 'linkPlacement', 'firstComment'] as const;
    if (!keys.some((k) => a[k] !== undefined)) return 'Say what to change.';
    const named = networkProblem(a.platform ? [a.platform] : undefined) ?? postTypeProblem(a.postType) ?? styleProblem(a.style, post.format);
    if (named) return named;
    if (a.date && !realDate(a.date)) return 'Pick a real date (YYYY-MM-DD).';
    if ((a.date || a.time) && post.status !== 'published') {
      const at = combineDateTime(a.date ?? isoToDateStr(post.scheduledAt), a.time ?? isoToTime(post.scheduledAt));
      if (new Date(at).getTime() < Date.now() - 60_000) return 'That time has already passed. Pick a later one.';
    }
    if (a.linkPlacement && !pageLink(activeProject())) return noLink();
    if (a.firstComment !== undefined && (a.linkPlacement ?? postPlacement(post)) !== 'comment') return 'A first comment is only used when the link goes there: set linkPlacement: comment too.';
    return null;
  },
  run: (a) => {
    const p = activeProject();
    const post = findPost(a.id)!;
    const patch: Partial<Post> = {};
    const changed: string[] = [];
    const set = <K extends keyof Post>(k: K, v: Post[K], word: string) => {
      patch[k] = v;
      changed.push(word);
    };
    if (a.headline !== undefined) set('headline', a.headline, 'headline');
    if (a.caption !== undefined) set('caption', a.caption, 'caption');
    if (a.hashtags) set('hashtags', tagsOf(a.hashtags), 'hashtags');
    if (a.postType) set('postType', toPostType(a.postType)!, 'type');
    if (a.style) set('style', toStyle(a.style)!, 'style');
    if (a.visualPrompt !== undefined) set('visualPrompt', a.visualPrompt, 'image description');
    if (a.date || a.time) set('scheduledAt', combineDateTime(a.date ?? isoToDateStr(post.scheduledAt), a.time ?? isoToTime(post.scheduledAt)), 'date and time');
    // a new network moves the link to where that network's setting puts it, as the editor does; then any placement asked for
    const platform = a.platform ? toNetwork(a.platform)! : undefined;
    if (platform && platform !== post.platform) {
      Object.assign(patch, networkMovePatch(p, { ...post, ...patch }, platform));
      changed.push('network');
    }
    if (a.linkPlacement) {
      Object.assign(patch, linkMovePatch(p, { ...post, ...patch }, a.linkPlacement));
      changed.push('where the link goes');
    }
    if (a.firstComment !== undefined) set('firstComment', a.firstComment, 'first comment');
    s().updatePost(post.id, patch);
    const after = findPost(post.id)!;
    const comment = firstCommentOf(after);
    return {
      data: {
        ...postSummary(after),
        changed,
        linkPlacement: postPlacement(after),
        ...(comment ? { firstComment: clip(comment, 300) } : {}),
        ...(textWarning(after) ? { warning: textWarning(after) } : {}),
        ...(manusHolds(post) ? { manus: `Manus already has this post (${post.external!.state}): the change doesn’t move or change what Manus scheduled or posted on ${networkLabel(post.external!.network ?? post.platform)}.` } : {}),
        ...(post.status === 'published' ? { posted: `It’s already out: this doesn’t change the post on ${net(post)}.` } : {}),
      },
      note: `Updated ${name(after)}: ${listJoin(changed)}`,
    };
  },
});

const schedulePosts = defineTool({
  name: 'schedule_posts',
  class: 'L',
  summary: 'Put drafts on the calendar (nothing posts by itself).',
  args: { ids: arg.array(arg.string({ max: 60 }), { min: 1, max: 50 }) },
  validate: ({ ids }) => eachPost(ids) ?? (ids.some((id) => findPost(id)?.status === 'draft') ? null : 'None of these is a draft: they’re already on the calendar or posted.'),
  run: ({ ids }) => {
    const drafts = uniq(ids).filter((id) => findPost(id)?.status === 'draft');
    addToCalendarFlow(drafts);
    const planned = drafts.map((id) => findPost(id)).filter((p): p is Post => p?.status === 'scheduled');
    const skipped = uniq(ids).filter((id) => !drafts.includes(id)).map((id) => ({ id, why: findPost(id)?.status === 'published' ? 'already posted' : 'already planned' }));
    const due = planned.filter((p) => new Date(p.scheduledAt).getTime() <= Date.now()).length;
    return {
      data: { planned: planned.map((p) => postSummary(p)), ...(skipped.length ? { skipped } : {}), ...(due ? { due: `${plural(due, 'post')} planned for a time that has passed: due now.` } : {}), next: 'Nothing posts by itself: post_with_manus, or the owner posts it and marks it posted.' },
      note: `Added ${plural(planned.length, 'post')} to your calendar`,
    };
  },
});

const unschedulePost = defineTool({
  name: 'unschedule_post',
  class: 'L',
  summary: 'Move planned posts back to drafts.',
  args: { ids: arg.array(arg.string({ max: 60 }), { min: 1, max: 50 }) },
  validate: ({ ids }) => eachPost(ids) ?? (ids.some((id) => findPost(id)?.status === 'scheduled') ? null : 'None of these is planned on the calendar.'),
  run: ({ ids }) => {
    const planned = uniq(ids).filter((id) => findPost(id)?.status === 'scheduled');
    const held = planned.map((id) => findPost(id)!).filter(manusHolds);
    for (const id of planned) s().updatePost(id, { status: 'draft' });
    return {
      data: { drafts: planned, ...(held.length ? { manus: `Manus already has ${listJoin(held.map(name))} on the network: moving ${held.length === 1 ? 'it' : 'them'} back to drafts here doesn’t unschedule ${held.length === 1 ? 'it' : 'them'} there.` } : {}) },
      note: planned.length === 1 ? `Moved ${name(findPost(planned[0]))} back to drafts` : `Moved ${plural(planned.length, 'post')} back to drafts`,
    };
  },
});

const markPosted = defineTool({
  name: 'mark_posted',
  class: 'Pub',
  summary: 'Open “Mark as posted” for a post the owner posted.',
  args: { id: arg.string({ max: 60 }) },
  validate: ({ id }) => eachPost([id], (p) => (p.status === 'published' ? `${name(p)} is already marked as posted.` : null)),
  window: ({ id }) => ({ kind: 'mark-posted', postId: id }),
});

const unmarkPosted = defineTool({
  name: 'unmark_posted',
  class: 'L',
  summary: 'Undo “Mark as posted” on a post the owner marked.',
  args: { id: arg.string({ max: 60 }) },
  validate: ({ id }) =>
    eachPost([id], (p) => {
      if (p.status !== 'published') return `${name(p)} isn’t marked as posted.`;
      return p.publishedBy === 'manual' ? null : `Manus reported ${name(p)} posted: only posts the owner marked themselves can be marked as not posted.`;
    }),
  run: ({ id }) => {
    s().unmarkPosted(id);
    const p = findPost(id)!;
    return { data: postSummary(p), note: `Marked ${name(p)} as not posted: it’s ${p.status === 'draft' ? 'a draft' : 'on your calendar'} again` };
  },
});

// ───────────── the campaign: setup, plan, batch, links ─────────────

const updateCampaign = defineTool({
  name: 'update_campaign',
  class: 'L',
  summary: 'Change the campaign setup (postTypes: 0 off to 3 most).',
  args: {
    days: arg.array(arg.string({ max: 9 }), { optional: true, max: 7, desc: 'mon…sun' }),
    postsPerDay: arg.number({ optional: true, int: true, min: 1, max: 5 }),
    videosPerDay: arg.number({ optional: true, int: true, min: 0, max: 5 }),
    times: arg.array(arg.string({ pattern: TIME }), { optional: true, max: 5 }),
    startDate: arg.string({ optional: true, pattern: DATE }),
    goal: arg.enum(['awareness', 'leads', 'sales'], { optional: true }),
    platforms: arg.array(arg.string({ max: 20 }), { optional: true, max: 5 }),
    styles: arg.array(arg.string({ max: 20 }), { optional: true, max: 10 }),
    postTypes: arg.object({ educational: WEIGHT, tip: WEIGHT, question: WEIGHT, sales: WEIGHT, bts: WEIGHT }, { optional: true }),
    watermark: arg.boolean({ optional: true }),
  },
  validate: (a) => {
    const keys = ['days', 'postsPerDay', 'videosPerDay', 'times', 'startDate', 'goal', 'platforms', 'styles', 'postTypes', 'watermark'] as const;
    if (!keys.some((k) => a[k] !== undefined && !(k === 'postTypes' && !Object.keys(a.postTypes ?? {}).length))) return 'Say what to change.';
    const cfg = activeProject().marketing.campaign;
    if (a.videosPerDay !== undefined && a.videosPerDay > (a.postsPerDay ?? cfg.postsPerDay)) return `Videos per day can’t be more than posts per day (${a.postsPerDay ?? cfg.postsPerDay}).`;
    if (a.startDate && !realDate(a.startDate)) return 'Pick a real start date (YYYY-MM-DD).';
    const day = a.days?.find((d) => !toWeekday(d));
    if (day) return `"${day}" isn’t a weekday: use ${WEEKDAYS.join(', ')}.`;
    const named = networkProblem(a.platforms);
    if (named) return named;
    const bad = a.styles?.find((x) => !toStyle(x));
    if (bad) return `"${bad}" isn’t a style. Image styles: ${stylesFor('image').join(', ')}; video styles: ${stylesFor('video').join(', ')}.`;
    return null;
  },
  run: (a, ctx) => {
    const cfg = activeProject().marketing.campaign;
    const patch: Partial<typeof cfg> = {};
    if (a.days) {
      const on = a.days.map(toWeekday);
      patch.days = WEEKDAYS.map((d) => on.includes(d));
    }
    if (a.postsPerDay !== undefined) {
      patch.postsPerDay = a.postsPerDay;
      // as the setup does: never more videos than posts
      patch.videosPerDay = Math.min(a.videosPerDay ?? cfg.videosPerDay, a.postsPerDay);
    } else if (a.videosPerDay !== undefined) patch.videosPerDay = a.videosPerDay;
    if (a.times) patch.times = [...a.times, ...cfg.times.slice(a.times.length)];
    if (a.startDate) patch.startDate = a.startDate;
    if (a.goal) patch.goal = a.goal;
    if (a.platforms) patch.platforms = uniq(a.platforms.map((x) => toNetwork(x)!)) as PostPlatform[];
    // image and video styles are kept apart: naming only image styles leaves the video styles as they are
    const styles = uniq((a.styles ?? []).map((x) => toStyle(x)!));
    const images = styles.filter((x) => !isVideoStyle(x)) as typeof cfg.imageStyles;
    const videos = styles.filter((x) => isVideoStyle(x)) as typeof cfg.videoStyles;
    if (images.length) patch.imageStyles = images;
    if (videos.length) patch.videoStyles = videos;
    if (a.postTypes) patch.postTypes = { ...cfg.postTypes, ...a.postTypes };
    if (a.watermark !== undefined) patch.watermark = a.watermark;
    patchCampaign(patch, ctx.projectId);
    const p = useStore.getState().projects.find((x) => x.id === ctx.projectId)!;
    const now = p.marketing.campaign;
    const c = cadence(now);
    const problem = campaignProblem(now);
    return {
      data: {
        changed: Object.keys(patch),
        setup: { days: WEEKDAYS.filter((_d, i) => now.days[i]), postsPerDay: now.postsPerDay, videosPerDay: now.videosPerDay, times: now.times.slice(0, now.postsPerDay), platforms: now.platforms, goal: now.goal, perWeek: c.perWeek, over30Days: c.month },
        ...(problem ? { problem: `A plan can’t be made from this setup yet: ${problem}` } : {}),
        ...(p.marketing.plan ? { plan: 'The 30-day plan was made from the old setup: generate_campaign_plan with replace: true makes a new one (ask the owner).' } : {}),
      },
      note: `Updated your campaign setup${problem ? `: ${problem.replace(/\.$/, '').toLowerCase()}` : `: about ${c.perWeek} posts a week`}`,
    };
  },
});

const generateCampaignPlan = defineTool({
  name: 'generate_campaign_plan',
  class: 'P-text',
  summary: 'AI writes the 30-day plan from the setup; replacing one needs replace: true after asking.',
  args: { replace: arg.boolean({ optional: true }) },
  validate: ({ replace }) => {
    const p = activeProject();
    if (busyWith(campaignPlanTask.label)) return 'A 30-day plan is being written on the Social media engine right now. Wait for it to finish.';
    const problem = campaignProblem(p.marketing.campaign);
    if (problem) return `The campaign setup can’t make a plan yet: ${problem} Fix it with update_campaign.`;
    return p.marketing.plan && !replace ? 'There is already a 30-day plan (posts made from it stay). Ask the owner, then call again with replace: true.' : null;
  },
  run: async (_a, ctx) => {
    const r = await runAITask(campaignPlanTask, { config: activeProject().marketing.campaign }, ctx);
    applyCampaignPlan(r.data, ctx.projectId);
    const plan = r.data;
    return {
      data: { posts: plan.summary.total, videos: plan.summary.videos, images: plan.summary.images, from: plan.days[0]?.date, to: plan.days[plan.days.length - 1]?.date, strategy: clip(plan.strategy, 300), weeks: plan.weeks.map((w) => ({ week: w.week, theme: w.theme })), next: 'generate_week_batch writes the first 7 days of posts.' },
      note: `Wrote a 30-day plan: ${plural(plan.summary.total, 'post')} from ${plan.days[0]?.date ?? plan.startDate}`,
    };
  },
});

const getPlan = defineTool({
  name: 'get_plan',
  class: 'R',
  summary: 'A week of the 30-day plan (default: the next batch’s): slots, topics, post ids.',
  args: { week: arg.number({ optional: true, int: true, min: 1, max: 5 }) },
  validate: () => (activeProject().marketing.plan ? null : 'There’s no 30-day plan yet: generate_campaign_plan writes one.'),
  run: ({ week }) => {
    const p = activeProject();
    const plan = p.marketing.plan!;
    const posts = projectPosts().filter((x) => x.source === 'batch');
    const covered = coveredSlots(posts, p.id);
    const start = batchStart(plan, covered);
    const w = week ?? plan.days[Math.min(start, plan.days.length - 1)]?.week ?? 1;
    const days = plan.days.filter((d) => d.week === w);
    return {
      data: {
        week: w,
        theme: plan.weeks.find((x) => x.week === w)?.theme ?? null,
        days: days.map((d) => ({ date: d.date, phase: d.phase, slots: d.slots.map((sl) => ({ id: sl.id, time: sl.time, platform: sl.platform, format: sl.format, type: sl.postType, topic: clip(sl.topic, 110), ...(covered.has(sl.id) ? { post: posts.find((x) => x.planSlotId === sl.id)?.id } : {}) })) })),
        nextBatch: start >= plan.days.length ? 'every slot has a post' : `starts ${plan.days[start].date}`,
      },
      note: `Read week ${w} of your 30-day plan`,
    };
  },
});

const setPlanTopic = defineTool({
  name: 'set_plan_topic',
  class: 'L',
  summary: 'Change a plan slot’s topic (a post made for it keeps its words).',
  args: { slotId: arg.string({ max: 60 }), topic: arg.string({ max: 200 }) },
  validate: ({ slotId }) => {
    const plan = activeProject().marketing.plan;
    if (!plan) return 'There’s no 30-day plan yet: generate_campaign_plan writes one.';
    return plan.days.some((d) => d.slots.some((sl) => sl.id === slotId)) ? null : `There’s no plan slot with id "${slotId}". get_plan lists them.`;
  },
  run: ({ slotId, topic }, ctx) => {
    setSlotTopic(slotId, topic, ctx.projectId);
    const day = activeProject().marketing.plan!.days.find((d) => d.slots.some((sl) => sl.id === slotId))!;
    const post = projectPosts().find((x) => x.source === 'batch' && x.planSlotId === slotId);
    return {
      data: { slotId, date: day.date, topic, ...(post ? { post: post.id, kept: 'A post was already made for this slot: it keeps its words (update_post or regenerate_post_copy changes them).' } : {}) },
      note: `Changed the topic for ${day.date}: “${clip(topic, 60)}”`,
    };
  },
});

const generateWeekBatch = defineTool({
  name: 'generate_week_batch',
  class: 'P-text',
  summary: 'AI writes the plan’s next 7 days as draft posts.',
  args: {},
  validate: () => {
    const p = activeProject();
    if (!p.marketing.plan) return 'There’s no 30-day plan yet: generate_campaign_plan writes one first.';
    if (busyWith(contentBatchTask.label)) return 'A 7-day batch is being written on the Social media engine right now. Wait for it to finish.';
    return weekBatchInput(p, coveredSlots(s().posts, p.id)) ? null : 'Every slot in the 30-day plan already has a post.';
  },
  run: async (_a, ctx) => {
    const p = activeProject();
    const input = weekBatchInput(p, coveredSlots(s().posts, p.id));
    if (!input) return { ok: false, error: 'Every slot in the 30-day plan already has a post.' };
    const r = await runAITask(contentBatchTask, input, ctx);
    if (!r.data.length) return { ok: false, error: 'No posts came back for these days (they may all be rest days).' };
    applyWeekBatch(r.data, ctx.projectId);
    const posts = [...r.data].sort((x, y) => x.scheduledAt.localeCompare(y.scheduledAt));
    return {
      data: {
        added: posts.length,
        from: isoToDateStr(posts[0].scheduledAt),
        to: isoToDateStr(posts[posts.length - 1].scheduledAt),
        posts: posts.slice(0, 14).map((x) => ({ id: x.id, when: x.scheduledAt, platform: x.platform, format: x.format, headline: clip(x.headline, 70) })),
        next: 'They’re drafts: schedule_posts puts them on the calendar (ask the owner), or they do it in the 7-day batch.',
      },
      note: `Wrote ${plural(posts.length, 'draft post')} for ${isoToDateStr(posts[0].scheduledAt)} to ${isoToDateStr(posts[posts.length - 1].scheduledAt)}`,
    };
  },
});

const setLinkPlacementTool = defineTool({
  name: 'set_link_placement',
  class: 'L',
  summary: 'Where a network’s link goes on new posts (comment: first comment, a reply on X).',
  args: { platform: arg.enum(POST_PLATFORMS), placement: arg.enum(LINK_PLACEMENTS) },
  run: ({ platform, placement }, ctx) => {
    setLinkPlacement(platform, placement, ctx.projectId);
    const link = pageLink(activeProject());
    return {
      data: {
        platform,
        placement,
        suggested: DEFAULT_LINK_PLACEMENT[platform],
        link: link ? linkText(link.url) : null,
        fact: LINK_FACTS[platform],
        ...(placement === 'bio' ? { bio: 'The app never changes the profile: the owner keeps the link in their bio.' } : {}),
        ...(link ? {} : { noLinkYet: noLink() }),
        existingPosts: 'Posts already made keep theirs (update_post linkPlacement).',
      },
      note: `New ${networkLabel(platform)} posts put the link ${placement === 'post' ? 'in the post' : placement === 'comment' ? `in the first ${platform === 'x' ? 'reply' : 'comment'}` : 'in the bio'}`,
    };
  },
});

// ───────────── a post's image or video ─────────────

const imageKind = (kind: 'photo' | 'illustration' | undefined) => kind ?? defaultImageKind();
/** Photos come from Manus here: each is a Manus task, so the owner confirms a card first. */
const manusPhotos = (kind: 'photo' | 'illustration' | undefined) => imageKind(kind) === 'photo' && photoRoute() === 'manus';

/** A media failure in words for the owner (paid tries are never repeated by themselves). */
function mediaFailure(e: unknown): { error: string; task?: string } {
  const m = imageErrorMessage(e);
  return { error: `${m.title}: ${m.body}`, ...(m.taskUrl ? { task: m.taskUrl } : {}) };
}

const makePostImageTool = defineTool({
  name: 'make_post_image',
  class: 'P-media',
  summary: 'AI images for posts; the owner’s photos stay unless replaceOwn.',
  args: { ids: arg.array(arg.string({ max: 60 }), { min: 1, max: 4 }), kind: arg.enum(['photo', 'illustration'], { optional: true }), replaceOwn: arg.boolean({ optional: true }) },
  validate: ({ ids, kind, replaceOwn }) => {
    if (imageKind(kind) === 'photo') {
      const av = photoAvailability();
      if (!av.ok) return `${av.reason} Or use kind: illustration.`;
    }
    return eachPost(ids, (p) => {
      if (p.format !== 'image') return `${name(p)} is a video post: make_video makes its video.`;
      if (p.status === 'published') return `${name(p)} is already posted: a new image here doesn’t change it on ${net(p)}.`;
      if (making.has(p.id)) return `An image or video for ${name(p)} is being made right now.`;
      if (pendingManus.get(postImageKey(p.id))) return `A Manus image for ${name(p)} is still on its way: open the post (open_post) to pick it up.`;
      if (isOwnPhoto(p.media) && !replaceOwn) return `${name(p)} uses the owner’s own photo. Ask them, then call again with replaceOwn: true to replace it with an AI image.`;
      return null;
    });
  },
  media: ({ kind }) => (manusPhotos(kind) ? 'manus' : 'image'),
  card: ({ ids }) => {
    const list = uniq(ids).map((id) => findPost(id));
    const n = list.length;
    return manusCard({
      title: n === 1 ? 'Make this post photo with Manus?' : `Make ${n} post photos with Manus?`,
      what: `${listJoin(list.map(name))}${n > 1 ? ': one Manus task each, one after another' : ''}, from ${n === 1 ? 'its' : 'each post’s'} image description, with the headline and logo on top.`,
      cost: `Uses your Manus credits: ${plural(n, 'task')}.`,
      confirmLabel: n === 1 ? 'Make the photo' : `Make ${n} photos`,
    });
  },
  run: async ({ ids, kind }, ctx) => {
    const p = activeProject();
    const k = imageKind(kind);
    const list = uniq(ids);
    const made: { id: string; by: string }[] = [];
    let failed: { id: string; error: string } | null = null;
    let taskUrl: string | undefined;
    const job = busyId('assistant:post-image');
    beginBusy(job, 'Post image', 'app');
    list.forEach((id) => making.add(id));
    try {
      for (const [i, id] of list.entries()) {
        if (ctx.signal.aborted) break;
        const post = findPost(id);
        if (!post) continue;
        const step = list.length > 1 ? `${i + 1} of ${list.length}: ` : '';
        ctx.stage(`Making the image ${step}${name(post)}…`);
        try {
          const r = await makePostImage(p, post, { kind: k, signal: ctx.signal, onStage: (st) => ctx.stage(`${step}${st}`) });
          if (!findPost(id)) continue;
          applyPostMedia(id, r.media);
          ctx.ai.push({ task: 'postImage', label: 'Post image', provider: r.art.engine, ...(r.art.note ? { note: r.art.note } : {}) });
          made.push({ id, by: r.art.provider });
        } catch (e) {
          if (isStop(e) || ctx.signal.aborted) break;
          // the first failure stops the set: a paid try is never repeated by itself
          const f = mediaFailure(e);
          failed = { id, error: f.error };
          taskUrl = f.task;
          break;
        }
      }
    } finally {
      list.forEach((id) => making.delete(id));
      endBusy(job);
    }
    if (ctx.signal.aborted) throw stopped();
    const notStarted = list.filter((id) => !made.some((m) => m.id === id) && failed?.id !== id);
    const buttons: ChatButton[] = taskUrl ? [{ label: 'Open the task in Manus', icon: 'open', run: () => openInNewTab(taskUrl!) }] : [];
    const data = { made, ...(failed ? { failed: { ...failed, retry: 'Don’t try again by yourself: tell the owner what happened.' } } : {}), ...(notStarted.length ? { notStarted } : {}) };
    if (!made.length) return { ok: false, error: failed?.error ?? 'No image was made.', data, buttons };
    return { data, note: `Made ${plural(made.length, 'post image')}${failed ? `; ${name(findPost(failed.id))} didn’t finish` : ''}`, buttons };
  },
});

/** The video lengths the app makes, the nearest one to what was asked. */
const videoSeconds = (s: number | undefined) => VIDEO_DURATIONS.reduce((best, d) => (Math.abs(d - (s ?? 8)) < Math.abs(best - (s ?? 8)) ? d : best), VIDEO_DURATIONS[0] as number);

const makeVideo = defineTool({
  name: 'make_video',
  class: 'P-media',
  summary: 'An AI video for a post (an image post becomes a video post).',
  args: { postId: arg.string({ max: 60 }), seconds: arg.number({ optional: true, int: true, min: 5, max: 15 }), prompt: arg.string({ optional: true, max: 800, desc: 'what happens' }) },
  validate: ({ postId, prompt }) => {
    const rt = useRuntime.getState();
    const av = videoAvailability(rt.zapier, rt.ai);
    return eachPost([postId], (p) => {
      if (p.status === 'published') return `${name(p)} is already posted: a video here doesn’t change it on ${net(p)}.`;
      if (!av.ok) return av.reason;
      if (making.has(p.id)) return `An image or video for ${name(p)} is being made right now.`;
      if (pendingVideos.get(postVideoKey(p.id))) return `A video for ${name(p)} is still on its way: open the post (open_post) to pick it up.`;
      if ((prompt?.trim() || postVideoText(activeProject(), p)).length < 4) return `${name(p)} has nothing to make a video from: give prompt (what happens in the video).`;
      return null;
    });
  },
  media: 'video',
  card: ({ postId, seconds }) => {
    const p = findPost(postId);
    const turns = p?.format === 'image' ? `. It becomes a video post: the video takes the place of its ${isOwnPhoto(p.media) ? 'photo (your photo stays in your files)' : p.media ? 'image' : 'planned image'}` : '';
    return videoCard({ what: `A ${videoSeconds(seconds)}-second video for ${name(p)} on ${p ? net(p) : 'its network'}${turns}.`, seconds: videoSeconds(seconds) });
  },
  run: async ({ postId, seconds, prompt }, ctx) => {
    const p = activeProject();
    const post = findPost(postId)!;
    const secs = videoSeconds(seconds);
    const job = busyId('assistant:video');
    beginBusy(job, 'Video', 'app');
    making.add(postId);
    let r: Awaited<ReturnType<typeof makePostVideo>>;
    try {
      ctx.stage('Making the video…');
      r = await makePostVideo(p, post, { seconds: secs, prompt, signal: ctx.signal, onStage: ctx.stage });
    } catch (e) {
      if (isStop(e) || ctx.signal.aborted) throw stopped();
      // never started again by itself: the owner decides (a new try is a new paid job)
      return { ok: false, error: `${mediaFailure(e).error} Don’t try again by yourself: tell the owner.` };
    } finally {
      making.delete(postId);
      endBusy(job);
    }
    if (!findPost(postId)) return { ok: false, error: 'The post was deleted while its video was being made.' };
    const convert = post.format !== 'video';
    applyPostMedia(postId, r.media, convert ? { format: 'video', style: VIDEO_STYLES[0].id } : {});
    return {
      data: { postId, seconds: secs, ...(r.cost != null ? { cost: fmtUsd(r.cost) } : {}), ...(convert ? { nowAVideoPost: true } : {}), next: 'post_with_manus posts it, or download_post_media saves it.' },
      note: `Made a ${secs}-second video for ${name(findPost(postId))}`,
    };
  },
});

const downloadPostMediaTool = defineTool({
  name: 'download_post_media',
  class: 'R',
  summary: 'Buttons to download posts’ images or videos (one post: copy its text too).',
  args: { ids: arg.array(arg.string({ max: 60 }), { min: 1, max: 6 }) },
  validate: ({ ids }) => eachPost(ids) ?? (ids.some((id) => findPost(id)?.media) ? null : 'None of these posts has an image or video yet (make_post_image or make_video).'),
  run: ({ ids }) => {
    const list = uniq(ids).map((id) => findPost(id)!);
    const withMedia = list.filter((p) => p.media);
    // the post as it is on the click (its media may change meanwhile)
    const buttons: ChatButton[] = withMedia.map((p) => ({ label: `Download the ${p.media!.kind}${withMedia.length > 1 ? `: ${clip(p.headline, 30)}` : ''}`, icon: 'download', run: () => downloadPostMedia(findPost(p.id) ?? p) }));
    if (list.length === 1) {
      const p = list[0];
      buttons.push(copyButton('Copy text and hashtags', () => postText(findPost(p.id) ?? p)));
      const comment = firstCommentOf(p);
      if (comment) buttons.push(copyButton(`Copy the first ${p.platform === 'x' ? 'reply' : 'comment'}`, () => firstCommentOf(findPost(p.id) ?? p) ?? comment));
    }
    const without = list.filter((p) => !p.media).map((p) => p.id);
    return {
      data: { files: withMedia.map((p) => ({ id: p.id, kind: p.media!.kind, file: p.media!.name })), ...(without.length ? { noMedia: without } : {}), next: 'After posting it themselves, the owner marks it posted (mark_posted).' },
      note: withMedia.length === 1 ? `The ${withMedia[0].media!.kind} for ${name(withMedia[0])} is ready to download` : `${withMedia.length} files are ready to download`,
      buttons,
    };
  },
});

// ───────────── posting with Manus (only through the app's windows) ─────────────

const notReady = () => `Manus can’t post from here yet. ${manusSetupHint()}`;

const postWithManus = defineTool({
  name: 'post_with_manus',
  class: 'Pub',
  summary: 'Open “Post with Manus”; resend only after the owner checked a failed or sent post.',
  args: { ids: arg.array(arg.string({ max: 60 }), { min: 1, max: 20 }), resend: arg.boolean({ optional: true }) },
  validate: ({ ids, resend }) => {
    if (!manusReadyNow()) return notReady();
    const problem = eachPost(ids, (p) => {
      if (p.status === 'published') return `${name(p)} is already posted.`;
      if (sendingNow(p.id)) return `${name(p)} is being handed to Manus right now.`;
      if (resend) return null;
      // a one-shot send is never repeated by itself: the owner checks first
      if (manusHolds(p)) return `Manus already has ${name(p)} (${p.external!.state}): sending it again can post it twice. Check it with check_manus; resend: true only if the owner asks for it after you told them.`;
      if (failedOnItsNetwork(p)) return `The last Manus try for ${name(p)} failed, but it may still have gone out or been scheduled on ${net(p)}. Ask the owner to check ${net(p)} (or the task in Manus) first; resend: true once they say it isn’t there.`;
      return null;
    });
    if (problem) return problem;
    const blocked = uniq(ids).map((id) => findPost(id)!).map((p) => [p, postBlocker(p, { viaServer: manusViaServer() })] as const);
    return blocked.every(([, b]) => b) ? blocked.map(([p, b]) => `${name(p)}: ${b}`).join(' ') : null;
  },
  window: ({ ids }) => ({ kind: 'manus-post', postIds: uniq(ids) }),
});

const postToGroups = defineTool({
  name: 'post_to_groups',
  class: 'Pub',
  summary: 'Open “Post to groups” for a Facebook post; again only once the owner OKs it.',
  args: { id: arg.string({ max: 60 }), again: arg.boolean({ optional: true }) },
  validate: ({ id, again }) => {
    if (!manusReadyNow()) return notReady();
    return eachPost([id], (p) => {
      if (p.platform !== 'facebook') return `Post to groups is for Facebook posts, and ${name(p)} is for ${net(p)}.`;
      const blocker = postBlocker({ ...p, platform: 'facebook' }, { viaServer: manusViaServer() });
      if (blocker) return blocker;
      if (sendingNow(p.id)) return `${name(p)} is being handed to Manus right now.`;
      const gs = p.groupShare;
      if (gs && (gs.state === 'working' || gs.state === 'needs_input')) return `Manus is still posting ${name(p)} in groups (check_manus).`;
      if (gs && !again) {
        const out = groupsAlreadyOut(gs);
        return `Manus already shared ${name(p)} in groups${out.length ? `: it’s in (or waiting for approval in) ${listJoin(out)}` : ''}${gs.state === 'failed' ? '; the last try stopped early, so it may be in groups it didn’t report' : ''}. Sharing again posts twice where it already is (the window leaves those out). Ask the owner; again: true to open it.`;
      }
      return null;
    });
  },
  window: ({ id }) => ({ kind: 'manus-groups', postId: id }),
});

const REFRESH_POST = new Set(['working', 'needs_input', 'finished']);

const checkManus = defineTool({
  name: 'check_manus',
  class: 'L',
  summary: 'Check (free) what Manus did with posts and groups (default: those in progress).',
  args: { ids: arg.array(arg.string({ max: 60 }), { optional: true, min: 1, max: 5 }) },
  validate: ({ ids }) => (ids ? eachPost(ids, (p) => (p.external || p.groupShare ? null : `Manus doesn’t have ${name(p)}: it was never sent to Manus.`)) : null),
  run: async ({ ids }) => {
    const targets = ids
      ? uniq(ids)
      : projectPosts()
          .filter((p) => (p.external && REFRESH_POST.has(p.external.state)) || (p.groupShare && REFRESH_POST.has(p.groupShare.state)))
          .sort((a, b) => Math.max(b.external?.requestedAt ?? 0, b.groupShare?.requestedAt ?? 0) - Math.max(a.external?.requestedAt ?? 0, a.groupShare?.requestedAt ?? 0))
          .slice(0, 5)
          .map((p) => p.id);
    if (!targets.length) return { data: { checked: 0, withManus: 'Nothing is with Manus right now.' }, note: 'Nothing is with Manus right now' };
    const rows: unknown[] = [];
    const buttons: ChatButton[] = [];
    let problems = 0;
    for (const id of targets) {
      const before = findPost(id);
      if (!before) continue;
      let error: string | undefined;
      try {
        // reading a task is free and never sends anything again
        if (before.external && REFRESH_POST.has(before.external.state)) await refreshPostFromManus(id);
        if (before.groupShare && REFRESH_POST.has(before.groupShare.state)) await refreshGroupsFromManus(id);
      } catch (e) {
        const c = errorCopy(e);
        error = `${c.title}: ${c.body}`;
        problems++;
      }
      const p = findPost(id) ?? before;
      rows.push({ ...manusRow(p), ...(error ? { couldntCheck: error } : {}) });
      const url = p.external?.taskUrl ?? p.groupShare?.taskUrl;
      if (url && buttons.length < 3 && (p.external?.state === 'needs_input' || p.groupShare?.state === 'needs_input' || p.external?.state === 'failed' || p.external?.state === 'finished')) buttons.push({ label: `Open in Manus: ${clip(p.headline, 30)}`, icon: 'open', run: () => openInNewTab(url) });
    }
    const states = rows.map((r) => (r as { manus?: { state: string } }).manus?.state).filter(Boolean) as string[];
    const counts = [...new Set(states)].map((st) => `${states.filter((x) => x === st).length} ${st.replace('_', ' ')}`);
    return { data: { checked: rows.length, posts: rows }, note: `Checked ${plural(rows.length, 'post')} with Manus${counts.length ? `: ${counts.join(', ')}` : ''}${problems ? ` (${problems} couldn’t be checked)` : ''}`, buttons };
  },
});

// ───────────── deleting ─────────────

const deletePosts = defineTool({
  name: 'delete_posts',
  class: 'D',
  summary: 'Delete posts from the app (what’s on a network stays).',
  args: { ids: arg.array(arg.string({ max: 60 }), { min: 1, max: 50 }) },
  validate: ({ ids }) => eachPost(ids, (p) => (sendingNow(p.id) ? `${name(p)} is being handed to Manus right now.` : making.has(p.id) ? `An image or video for ${name(p)} is being made right now.` : null)),
  danger: ({ ids }) => {
    const list = uniq(ids).map((id) => findPost(id)!);
    const out = list.some((p) => p.status === 'published');
    const held = list.some((p) => p.status !== 'published' && manusHolds(p));
    return deleteConfirm({ thing: 'post', names: list.map((p) => p.headline), extra: [out ? 'Posts already out stay on the network: this only removes them from the app.' : '', held ? 'If Manus already posted or scheduled one, it stays on the network.' : ''].filter(Boolean).join(' ') || undefined });
  },
  run: ({ ids }) => {
    const gone = uniq(ids).filter((id) => findPost(id));
    s().deletePosts(gone);
    return { data: { deleted: gone.length }, note: `Deleted ${plural(gone.length, 'post')}` };
  },
});

export const socialTools: AnyTool[] = [
  createPostDrafts,
  generatePost,
  regeneratePostCopy,
  updatePost,
  schedulePosts,
  unschedulePost,
  markPosted,
  unmarkPosted,
  updateCampaign,
  generateCampaignPlan,
  getPlan,
  setPlanTopic,
  generateWeekBatch,
  setLinkPlacementTool,
  makePostImageTool,
  makeVideo,
  downloadPostMediaTool,
  postWithManus,
  postToGroups,
  checkManus,
  deletePosts,
];
