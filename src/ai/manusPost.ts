// A real post by Manus. Manus opens the network in its own browser, where you sign in once, and
// posts exactly the post you confirmed (its text, and its image or video) on your own account,
// right away or scheduled. It works on Facebook, Instagram, TikTok, LinkedIn and X. Self-hosted, it
// runs on your server's Manus key; in claude.ai it goes through the Zapier connector (images only).
// This app never connects to the networks itself.

import type { ExternalPublish, Post, PostPlatform } from '@/lib/types';
import { getBlob, safeStorage } from '@/lib/storage';
import { PLATFORMS } from './knowledge';
import { ManusError, createManusTask, readManusTask, sendFileToManus, type ManusState } from './manus';

/** Post right away, or schedule for the post's time. */
export type PostMode = 'now' | 'schedule';

/** How each network is posted to, in the words its own website uses. */
interface Network {
  /** what to call the account in the form */
  account: string;
  placeholder: string;
  hint: string;
  /** furthest ahead the network schedules posts, in days */
  maxDays: number;
  /** the network takes no post without an image or video */
  needsMedia: boolean;
  /** text longer than this may be refused (some accounts allow more) */
  textLimit?: number;
  /** where to start and how to post; the steps depend on posting now or scheduling */
  open: (now: boolean) => string;
  as: (account: string) => string;
  publish: string;
  schedule: string;
  checkNow: string;
  checkScheduled: string;
  media: { image: string; video: string; none: string };
  rules: string;
}

export const NETWORKS: Record<PostPlatform, Network> = {
  facebook: {
    account: 'Facebook Page',
    placeholder: 'Your business Page name',
    hint: 'The Page name as it appears on Facebook.',
    maxDays: 75,
    needsMedia: false,
    open: (now) => `Open Meta Business Suite (https://business.facebook.com/latest/home) and choose ${now ? '"Create post"' : 'Planner or "Create post"'}.`,
    as: (a) =>
      a
        ? `Post as this Facebook Page: "${a}". If no Page with that name is available, or the account manages several Pages and it's unclear which one, stop and ask me.`
        : "Post as the business's Facebook Page. If the account manages more than one Page, stop and ask me which one.",
    publish: 'Choose "Publish" (post it now, not scheduled).',
    schedule: 'Choose Schedule (NOT "Publish now")',
    checkNow: 'Check that the post now appears on the Page',
    checkScheduled: 'Confirm the scheduled post and check that it appears in the Planner at that time.',
    media: {
      image: 'Attach the image file provided with this task exactly as it is (no edits, no crop, no extra images or videos).',
      video:
        'Attach the video file provided with this task exactly as it is (no edits, no trimming, no music, no extra images or videos). Wait until Facebook has finished uploading and processing it. If Facebook offers to share a short vertical video as a Reel, that is fine.',
      none: 'This is a text-only post: do not add any image or video.',
    },
    rules: 'Do not create or change anything else (no ads, no boosts, no other posts, no Instagram cross-posting unless it is already the default and cannot be turned off).',
  },
  instagram: {
    account: 'Instagram account',
    placeholder: '@yourbusiness',
    hint: 'The account’s username. Scheduling needs a professional (business or creator) account linked to Meta Business Suite.',
    maxDays: 75,
    needsMedia: true,
    open: (now) =>
      now
        ? 'Open Instagram (https://www.instagram.com) and choose Create, then Post. If the account is connected to Meta Business Suite, you may post from there instead (https://business.facebook.com/latest/home, "Create post", Instagram only).'
        : 'Open Meta Business Suite (https://business.facebook.com/latest/home) and choose Planner or "Create post", with only the Instagram account selected. If this Instagram account is not connected to Meta Business Suite, stop: Instagram only schedules from there.',
    as: (a) => (a ? `Post as this Instagram account: "${a}". If you are signed in to a different account, or can't tell which one to use, stop and ask me.` : "Post as the business's Instagram account. If there is more than one, stop and ask me which one."),
    publish: 'Choose "Share" (post it now, not scheduled).',
    schedule: 'Choose Schedule (NOT "Publish now" or "Share")',
    checkNow: 'Check that the post now appears on the account’s profile',
    checkScheduled: 'Confirm the scheduled post and check that it appears in the Planner at that time.',
    media: {
      image: 'Add the image file provided with this task exactly as it is: no filters, no edits, no extra images. If Instagram asks how to crop it, choose "Original" (or the size that keeps the whole image).',
      video: 'Add the video file provided with this task exactly as it is (no edits, no trimming, no music, no filters). Instagram may share it as a Reel; that is fine. Wait until it has finished uploading.',
      none: 'Instagram needs an image or a video, and this post has neither: stop and report it.',
    },
    rules: 'Use the caption as the post text. Do not create or change anything else (no ads, no boosts, no stories, no other posts, no cross-posting to Facebook or Threads unless it is already the default and cannot be turned off).',
  },
  tiktok: {
    account: 'TikTok account',
    placeholder: '@yourbusiness',
    hint: 'The account’s username. TikTok schedules up to 10 days ahead.',
    maxDays: 10,
    needsMedia: true,
    open: () => 'Open TikTok Studio (https://www.tiktok.com/tiktokstudio/upload) to upload a post.',
    as: (a) => (a ? `Post as this TikTok account: "${a}". If you are signed in to a different account, or can't tell which one to use, stop and ask me.` : "Post as the business's TikTok account. If there is more than one, stop and ask me which one."),
    publish: 'Choose "Post" (post it now, not scheduled).',
    schedule: 'Turn on "Schedule" (NOT "Post now")',
    checkNow: 'Check that the post now appears on the account’s profile',
    checkScheduled: 'Confirm the scheduled post and check that it appears in TikTok Studio’s list of scheduled posts at that time.',
    media: {
      image: 'Upload the image file provided with this task as a photo post, exactly as it is (no filters, no music unless TikTok requires a sound). If TikTok Studio on the web cannot post photos for this account, stop and report that.',
      video: 'Upload the video file provided with this task exactly as it is (no edits, no trimming, no filters, no added music or effects). Wait until it has finished uploading and TikTok’s checks are done.',
      none: 'TikTok needs a video or a photo, and this post has neither: stop and report it.',
    },
    rules: 'Use the caption as the description. Leave the account’s privacy, comment and duet settings as they are. Do not create or change anything else (no ads, no promotions, no other posts).',
  },
  linkedin: {
    account: 'LinkedIn profile or Page',
    placeholder: 'Your name, or your company Page',
    hint: 'Your own name to post as yourself, or the company Page name to post as the Page (you need to be its admin).',
    maxDays: 90,
    needsMedia: false,
    open: () => 'Open LinkedIn (https://www.linkedin.com/feed/) and choose "Start a post". To post as a company Page, use the Page’s admin view, or pick the Page where LinkedIn lets you choose who is posting.',
    as: (a) => (a ? `Post as "${a}" (a person's profile or a company Page). If you can't post as that profile or Page, or can't tell which one it is, stop and ask me.` : 'Post as the signed-in member. If you are an admin of a company Page and it is unclear whether to post as the Page, stop and ask me.'),
    publish: 'Choose "Post" (post it now, not scheduled).',
    schedule: 'Choose "Schedule for later" (the clock button), NOT "Post"',
    checkNow: 'Check that the post now appears on the profile or Page',
    checkScheduled: 'Confirm the scheduled post and check that it appears in LinkedIn’s list of scheduled posts at that time.',
    media: {
      image: 'Add the image file provided with this task exactly as it is (no edits, no crop, no extra images or videos).',
      video: 'Add the video file provided with this task exactly as it is (no edits, no trimming). Wait until it has finished uploading.',
      none: 'This is a text-only post: do not add any image or video.',
    },
    rules: 'Do not create or change anything else (no ads, no boosts, no articles, no other posts, no reposts).',
  },
  x: {
    account: 'X account',
    placeholder: '@yourbusiness',
    hint: 'The account’s @handle.',
    maxDays: 75,
    needsMedia: false,
    textLimit: 280,
    open: () => 'Open X (https://x.com/home) and use the post composer ("Post").',
    as: (a) => (a ? `Post as this X account: "${a}". If you are signed in to a different account, or can't tell which one to use, stop and ask me.` : "Post as the business's X account. If there is more than one, stop and ask me which one."),
    publish: 'Choose "Post" (post it now, not scheduled).',
    schedule: 'Choose the schedule button in the composer (NOT "Post" right away)',
    checkNow: 'Check that the post now appears on the account’s profile',
    checkScheduled: 'Confirm the scheduled post and check that it appears in X’s list of scheduled posts at that time.',
    media: {
      image: 'Add the image file provided with this task exactly as it is (no edits, no crop, no extra images or videos).',
      video: 'Add the video file provided with this task exactly as it is (no edits, no trimming). Wait until it has finished uploading.',
      none: 'This is a text-only post: do not add any image or video.',
    },
    rules: 'Post one single post: never split the text into a thread, and never shorten or change it. If X refuses the text because it is too long for this account, stop and report that. Do not create or change anything else (no replies, no reposts, no other posts, no ads).',
  },
};

const label = (n: PostPlatform) => PLATFORMS[n].label.replace(' (Twitter)', '');
export const networkLabel = label;

/** Where the account name for a network was last used (per project, on this device). */
export const accountKey = (projectId: string, network: PostPlatform) => `ylb-post-account:${projectId}:${network}`;
/** Older versions remembered one Facebook Page name for every project. */
const LEGACY_FB_PAGE_KEY = 'ylb-fb-page';

/** The account to suggest: the last one used here, then the brand's handle, then its name. */
export function suggestedAccount(projectId: string, network: PostPlatform, brand: { name: string; socials: Partial<Record<string, string>> }): string {
  const used = safeStorage.getItem(accountKey(projectId, network)) || (network === 'facebook' ? safeStorage.getItem(LEGACY_FB_PAGE_KEY) : null);
  if (used) return used;
  const handle = (brand.socials[network] ?? '').trim();
  if (handle) return handle;
  return network === 'facebook' || network === 'linkedin' ? brand.name : '';
}

export function rememberAccount(projectId: string, network: PostPlatform, account: string) {
  if (account.trim()) safeStorage.setItem(accountKey(projectId, network), account.trim());
}

/** Each network schedules only so far ahead; keep a margin for Manus to work. */
export function scheduleWindowError(network: PostPlatform, iso: string, now = Date.now()): string | null {
  const t = new Date(iso).getTime();
  const n = NETWORKS[network];
  if (!Number.isFinite(t)) return 'Pick a date and time first.';
  if (t - now < 30 * 60_000) return `Pick a time at least 30 minutes from now: Manus needs a few minutes, and ${label(network)} only schedules ahead.`;
  if (t - now > n.maxDays * 24 * 3600_000) return `${label(network)} schedules posts up to ${n.maxDays} days ahead. Pick an earlier date.`;
  return null;
}

/** Why this post can't be handed to Manus (yet), or null when it can. */
export function postBlocker(post: Pick<Post, 'platform' | 'format' | 'media'>, o: { viaServer: boolean }): string | null {
  const n = NETWORKS[post.platform];
  if (post.format === 'video' && post.media?.kind !== 'video') return 'Make or add the video first: a storyboard can’t be posted.';
  if (post.media?.kind === 'video' && !o.viaServer) return 'Videos go to Manus through your own server, so post this one from the self-hosted app (for example on Replit).';
  if (n.needsMedia && !post.media) return `${label(post.platform)} needs an image or a video. Add one first.`;
  return null;
}

/** Text longer than the network usually takes (some accounts allow more, so this only warns). */
export function textWarning(post: Pick<Post, 'platform' | 'caption' | 'hashtags'>): string | null {
  const limit = NETWORKS[post.platform].textLimit;
  const n = [...postText(post)].length;
  return limit && n > limit ? `${label(post.platform)} takes ${limit} characters on most accounts, and this post has ${n}. Shorten it unless your account allows longer posts.` : null;
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function fmtWhen(iso: string, timeZone = localTimeZone()): string {
  try {
    return new Date(iso).toLocaleString('en-US', { timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return new Date(iso).toString();
  }
}

export function postText(post: Pick<Post, 'caption' | 'hashtags'>): string {
  const tags = post.hashtags.filter(Boolean).join(' ');
  return tags ? `${post.caption.trim()}\n\n${tags}` : post.caption.trim();
}

/** Exact instructions for Manus: one post on the account, with this text and this image or video. */
export function postPrompt(o: { network: PostPlatform; mode: PostMode; account: string; whenIso: string; timeZone: string; text: string; media: 'image' | 'video' | null }): string {
  const n = NETWORKS[o.network];
  const now = o.mode === 'now';
  const name = label(o.network);
  return [
    now ? `Post ONE organic post on ${name}, right now. Use your web browser.` : `Schedule ONE organic ${name} post. Use your web browser.`,
    '',
    `1. ${n.open(now)}`,
    `2. ${n.as(o.account)}`,
    '3. Paste this exact post text, keeping its line breaks, emojis and hashtags:',
    '<<<POST TEXT',
    o.text,
    'POST TEXT>>>',
    `4. ${o.media ? n.media[o.media] : n.media.none}`,
    now ? `5. ${n.publish}` : `5. ${n.schedule} for: ${fmtWhen(o.whenIso, o.timeZone)} (${o.timeZone} time; that is ${new Date(o.whenIso).toISOString()} UTC). Set ${name}'s date, time and time zone to match exactly.`,
    now ? `6. ${n.checkNow}, with the text${o.media ? ` and the ${o.media}` : ''} exactly as given.` : `6. ${n.checkScheduled}`,
    '',
    `Rules: if you are not signed in to ${name}, ask me to sign in and wait. Post exactly once: if the account already has this exact text ${now ? 'from the last hour' : 'scheduled'}, do not add it again, just report it. ${now ? 'Never schedule it for later.' : 'Never publish immediately.'} ${n.rules}`,
    '',
    'When you finish, end your final message with exactly one of these lines:',
    now ? 'RESULT: POSTED | <account name> | <link to the post, if you can see it>' : `RESULT: SCHEDULED | <account name> | <date and time as ${name} shows it>`,
    'RESULT: FAILED | <short reason>',
  ].join('\n');
}

/** Hosts a reported post link may point at (anything else is not shown as a link). */
const HOSTS: Record<PostPlatform, RegExp> = {
  facebook: /(^|\.)(facebook\.com|fb\.com|fb\.watch)$/i,
  instagram: /(^|\.)instagram\.com$/i,
  tiktok: /(^|\.)tiktok\.com$/i,
  linkedin: /(^|\.)linkedin\.com$/i,
  x: /(^|\.)(x\.com|twitter\.com)$/i,
};

/** The post's own address from Manus's report, only when it is on that network's website. */
export function postUrlFrom(text: string, network: PostPlatform, account?: string): string | undefined {
  const own = account && /^https?:\/\//i.test(account.trim()) ? account.trim().replace(/\/+$/, '').toLowerCase() : null;
  for (const m of text.matchAll(/https?:\/\/[^\s|<>"')\]]+/gi)) {
    try {
      const u = new URL(m[0].replace(/[.,;:!?*]+$/, ''));
      if (own && u.toString().replace(/\/+$/, '').toLowerCase() === own) continue;
      if (u.protocol === 'https:' && HOSTS[network].test(u.hostname) && u.pathname.length > 1) return u.toString();
    } catch {
      /* not a link */
    }
  }
  return undefined;
}

export function parseResult(text: string): { state: 'posted' | 'scheduled' | 'failed' | null; detail: string; parts: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/[*_`]/g, '').replace(/^[\s>#-]+/, '').trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^RESULT:\s*(POSTED|PUBLISHED|SCHEDULED|FAILED)\s*(?:\|\s*(.*))?$/i.exec(lines[i]);
    if (m) {
      const parts = (m[2] ?? '').split('|').map((x) => x.trim()).filter(Boolean);
      const word = m[1].toUpperCase();
      return { state: word === 'SCHEDULED' ? 'scheduled' : word === 'FAILED' ? 'failed' : 'posted', detail: parts.join(' · '), parts };
    }
  }
  return { state: null, detail: '', parts: [] };
}

const WAITING_COPY: Record<string, string> = {
  needConnectMyBrowser: 'Manus needs you to connect your browser in Manus so it can use your account.',
  messageAskUser: 'Manus has a question for you.',
  cascadeAskUser: 'Manus has a question for you.',
};

export function stateFromManus(s: ManusState, mode: PostMode = 'schedule', network: PostPlatform = 'facebook'): Pick<ExternalPublish, 'state' | 'message' | 'url'> {
  const name = label(network);
  const verb = mode === 'now' ? 'post' : 'schedule';
  if (s.status === 'error' || s.status === 'deleted') return { state: 'failed', message: s.error || (s.status === 'deleted' ? 'The Manus task was deleted.' : 'Manus reported an error.') };
  if (s.waiting) return { state: 'needs_input', message: s.waitingDescription || WAITING_COPY[s.waitingType] || `Manus paused and needs you (for example, to sign in to ${name}). Open the task in Manus.` };
  if (s.done) {
    const r = parseResult(s.text);
    // the link has its own slot (account | link); the account's own profile address is never the post's
    if (r.state === 'posted') return { state: 'posted', message: r.detail || `Manus reports it posted on ${name}.`, url: postUrlFrom(r.parts.length > 1 ? r.parts.slice(1).join(' ') : r.detail, network, r.parts[0]) };
    if (r.state === 'scheduled') return { state: 'scheduled', message: r.detail || `Manus reports it scheduled on ${name}.` };
    if (r.state === 'failed') return { state: 'failed', message: r.detail || `Manus couldn’t ${verb} the post.` };
    return { state: 'finished', message: s.text.slice(0, 280) || `Manus finished. Check the task to confirm the post was ${mode === 'now' ? 'posted' : 'scheduled'}.` };
  }
  return { state: 'working', message: mode === 'now' ? `Manus is posting it on ${name}…` : `Manus is scheduling it on ${name}…` };
}

/**
 * Hand the post to Manus: its text, and its image or video. A video goes to Manus first through
 * your server; an image goes with the task. One-shot: never retried.
 */
export async function startManusPost(post: Post, account: string, mode: PostMode, onStage?: (stage: string) => void): Promise<ExternalPublish> {
  const network = post.platform;
  const media = post.media ?? null;
  const blob = media ? await getBlob(media.id) : null;
  if (media && !blob) throw new ManusError(`This post’s ${media.kind} isn’t on this device or in your account any more. Add it again, then try.`, 'MANUS_CREATE');
  if (NETWORKS[network].needsMedia && !media) throw new ManusError(`${label(network)} needs an image or a video. Add one first.`, 'MANUS_CREATE');
  let image: Blob | null = null;
  let files: { file_id: string; filename: string }[] = [];
  if (media?.kind === 'video' && blob) {
    onStage?.('Sending the video to Manus…');
    files = [await sendFileToManus({ blob, name: media.name, mediaId: media.id })];
  } else if (blob) image = blob;
  onStage?.('Starting the Manus task…');
  const timeZone = localTimeZone();
  const whenIso = mode === 'now' ? new Date().toISOString() : post.scheduledAt;
  const task = await createManusTask({
    fn: 'facebook',
    prompt: postPrompt({ network, mode, account, whenIso, timeZone, text: postText(post), media: media?.kind ?? null }),
    title: `${mode === 'now' ? `Post on ${label(network)}` : `Schedule ${label(network)} post`} · ${post.headline}`.slice(0, 110),
    image,
    imageName: media?.name,
    files,
    interactive: true,
  });
  const at = Date.now();
  return { via: 'manus', network, mode, taskId: task.taskId, taskUrl: task.taskUrl, state: 'working', message: `Manus is opening ${label(network)}…`, page: account, scheduledFor: whenIso, requestedAt: at, checkedAt: at };
}

export async function refreshManusPost(ext: ExternalPublish): Promise<ExternalPublish> {
  const s = await readManusTask(ext.taskId, { waitSeconds: 0 });
  return { ...ext, ...stateFromManus(s, ext.mode ?? 'schedule', ext.network ?? 'facebook'), taskUrl: s.taskUrl || ext.taskUrl, checkedAt: Date.now() };
}
