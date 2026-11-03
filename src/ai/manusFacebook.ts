// A real Facebook post by Manus: Manus opens Facebook in its own browser and posts exactly the post
// the user confirmed (its caption, and its image or video), right away or scheduled. Runs through
// your server's Manus key when self-hosted, or the Zapier connector in claude.ai (images only).

import type { ExternalPublish, Post } from '@/lib/types';
import { getBlob } from '@/lib/storage';
import { ManusError, createManusTask, readManusTask, sendFileToManus, type ManusState } from './manus';

/** Post right away, or schedule for the post's time. */
export type FbMode = 'now' | 'schedule';

export const FB_PAGE_KEY = 'ylb-fb-page';

/** Facebook schedules posts from about 10 minutes to 75 days ahead; keep a margin for Manus to work. */
export function fbScheduleWindowError(iso: string, now = Date.now()): string | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'Pick a date and time first.';
  if (t - now < 30 * 60_000) return 'Pick a time at least 30 minutes from now: Manus needs a few minutes, and Facebook only schedules ahead.';
  if (t - now > 75 * 24 * 3600_000) return 'Facebook schedules posts up to 75 days ahead. Pick an earlier date.';
  return null;
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

/** Exact instructions for Manus: one post on the Page, with this text and this image or video. */
export function facebookPostPrompt(o: { mode: FbMode; page: string; whenIso: string; timeZone: string; text: string; media: 'image' | 'video' | null }): string {
  const now = o.mode === 'now';
  return [
    now ? 'Post ONE organic post on a Facebook Page, right now. Use your web browser.' : 'Schedule ONE organic Facebook Page post. Use your web browser.',
    '',
    `1. Open Meta Business Suite (https://business.facebook.com/latest/home) and choose ${now ? '"Create post"' : 'Planner or "Create post"'}.`,
    o.page ? `2. Post as this Facebook Page: "${o.page}". If no Page with that name is available, or the account manages several Pages and it's unclear which one, stop and ask me.` : "2. Post as the business's Facebook Page. If the account manages more than one Page, stop and ask me which one.",
    '3. Paste this exact post text, keeping its line breaks, emojis and hashtags:',
    '<<<POST TEXT',
    o.text,
    'POST TEXT>>>',
    o.media === 'image'
      ? '4. Attach the image file provided with this task exactly as it is (no edits, no crop, no extra images or videos).'
      : o.media === 'video'
        ? '4. Attach the video file provided with this task exactly as it is (no edits, no trimming, no music, no extra images or videos). Wait until Facebook has finished uploading and processing it. If Facebook offers to share a short vertical video as a Reel, that is fine.'
        : '4. This is a text-only post: do not add any image or video.',
    now
      ? '5. Choose "Publish" (post it now, not scheduled).'
      : `5. Choose Schedule (NOT "Publish now") for: ${fmtWhen(o.whenIso, o.timeZone)} (${o.timeZone} time; that is ${new Date(o.whenIso).toISOString()} UTC). Set Facebook's date, time and time zone to match exactly.`,
    now ? `6. Check that the post now appears on the Page, with the text${o.media ? ` and the ${o.media}` : ''} exactly as given.` : '6. Confirm the scheduled post and check that it appears in the Planner at that time.',
    '',
    `Rules: if you are not signed in to Facebook, ask me to sign in and wait. Post exactly once: if the Page already has this exact text ${now ? 'from the last hour' : 'scheduled'}, do not add it again, just report it. ${now ? 'Never schedule it for later.' : 'Never publish immediately.'} Do not create or change anything else (no ads, no boosts, no other posts, no Instagram cross-posting unless it is already the default and cannot be turned off).`,
    '',
    'When you finish, end your final message with exactly one of these lines:',
    now ? 'RESULT: POSTED | <Page name> | <link to the post, if you can see it>' : 'RESULT: SCHEDULED | <Page name> | <date and time as Facebook shows it>',
    'RESULT: FAILED | <short reason>',
  ].join('\n');
}

/** The scheduling instructions (kept for callers that only schedule). */
export function facebookSchedulePrompt(o: { page: string; whenIso: string; timeZone: string; text: string; hasImage: boolean }): string {
  return facebookPostPrompt({ mode: 'schedule', page: o.page, whenIso: o.whenIso, timeZone: o.timeZone, text: o.text, media: o.hasImage ? 'image' : null });
}

export function parseScheduleResult(text: string): { state: 'posted' | 'scheduled' | 'failed' | null; detail: string } {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\**\s*RESULT:\s*(POSTED|PUBLISHED|SCHEDULED|FAILED)\s*\**\s*(?:\|\s*(.*))?$/i.exec(lines[i]);
    if (m) {
      const detail = (m[2] ?? '').replace(/\*+$/, '').split('|').map((x) => x.trim()).filter(Boolean).join(' · ');
      const word = m[1].toUpperCase();
      return { state: word === 'SCHEDULED' ? 'scheduled' : word === 'FAILED' ? 'failed' : 'posted', detail };
    }
  }
  return { state: null, detail: '' };
}

const WAITING_COPY: Record<string, string> = {
  needConnectMyBrowser: 'Manus needs you to connect your browser in Manus so it can use Facebook.',
  messageAskUser: 'Manus has a question for you.',
  cascadeAskUser: 'Manus has a question for you.',
};

export function stateFromManus(s: ManusState, mode: FbMode = 'schedule'): Pick<ExternalPublish, 'state' | 'message'> {
  const verb = mode === 'now' ? 'post' : 'schedule';
  if (s.status === 'error' || s.status === 'deleted') return { state: 'failed', message: s.error || (s.status === 'deleted' ? 'The Manus task was deleted.' : 'Manus reported an error.') };
  if (s.waiting) return { state: 'needs_input', message: s.waitingDescription || WAITING_COPY[s.waitingType] || 'Manus paused and needs you (for example, to sign in to Facebook). Open the task in Manus.' };
  if (s.done) {
    const r = parseScheduleResult(s.text);
    if (r.state === 'posted') return { state: 'posted', message: r.detail || 'Posted on Facebook.' };
    if (r.state === 'scheduled') return { state: 'scheduled', message: r.detail || 'Scheduled on Facebook.' };
    if (r.state === 'failed') return { state: 'failed', message: r.detail || `Manus couldn’t ${verb} the post.` };
    return { state: 'finished', message: s.text.slice(0, 280) || `Manus finished. Check the task to confirm the post was ${mode === 'now' ? 'posted' : 'scheduled'}.` };
  }
  return { state: 'working', message: mode === 'now' ? 'Manus is posting it on Facebook…' : 'Manus is scheduling it on Facebook…' };
}

/**
 * Hand the post to Manus: its caption, and its image or video. A video (or any big file) goes to
 * Manus first through your server; the image goes with the task. One-shot: never retried.
 */
export async function startFacebookPost(post: Post, page: string, mode: FbMode, onStage?: (stage: string) => void): Promise<ExternalPublish> {
  const media = post.media ?? null;
  const blob = media ? await getBlob(media.id) : null;
  if (media && !blob) throw new ManusError(`This post’s ${media.kind} isn’t on this device or in your account any more. Add it again, then try.`, 'MANUS_CREATE');
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
    prompt: facebookPostPrompt({ mode, page, whenIso, timeZone, text: postText(post), media: media?.kind ?? null }),
    title: `${mode === 'now' ? 'Post on Facebook' : 'Schedule Facebook post'} · ${post.headline}`.slice(0, 110),
    image,
    imageName: media?.name,
    files,
    interactive: true,
  });
  const at = Date.now();
  return { via: 'manus', network: 'facebook', mode, taskId: task.taskId, taskUrl: task.taskUrl, state: 'working', message: 'Manus is opening Facebook…', page, scheduledFor: whenIso, requestedAt: at, checkedAt: at };
}

/** Kept for callers that only schedule. */
export const startFacebookSchedule = (post: Post, page: string) => startFacebookPost(post, page, 'schedule');

export async function refreshFacebookSchedule(ext: ExternalPublish): Promise<ExternalPublish> {
  const s = await readManusTask(ext.taskId, { waitSeconds: 0 });
  return { ...ext, ...stateFromManus(s, ext.mode ?? 'schedule'), taskUrl: s.taskUrl || ext.taskUrl, checkedAt: Date.now() };
}
