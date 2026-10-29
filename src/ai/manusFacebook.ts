// Scheduling a real Facebook post with Manus: Manus opens Meta Business Suite in its own
// browser and schedules exactly the post the user confirmed. Runs through the viewer's
// Zapier connector (see ./manus.ts).

import type { ExternalPublish, Post } from '@/lib/types';
import { getBlob } from '@/lib/storage';
import { createManusTask, readManusTask, type ManusState } from './manus';

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

export function facebookSchedulePrompt(o: { page: string; whenIso: string; timeZone: string; text: string; hasImage: boolean }): string {
  return [
    'Schedule ONE organic Facebook Page post. Use your web browser.',
    '',
    '1. Open Meta Business Suite (https://business.facebook.com/latest/home) and go to Planner or "Create post".',
    o.page ? `2. Post as this Facebook Page: "${o.page}". If no Page with that name is available, or the account manages several Pages and it's unclear which one, stop and ask me.` : "2. Post as the business's Facebook Page. If the account manages more than one Page, stop and ask me which one.",
    '3. Paste this exact post text, keeping its line breaks, emojis and hashtags:',
    '<<<POST TEXT',
    o.text,
    'POST TEXT>>>',
    o.hasImage ? '4. Attach the image file provided with this task exactly as it is (no edits, no crop, no extra images).' : '4. This is a text-only post: do not add any image.',
    `5. Choose Schedule (NOT "Publish now") for: ${fmtWhen(o.whenIso, o.timeZone)} (${o.timeZone} time; that is ${new Date(o.whenIso).toISOString()} UTC). Set Facebook's date, time and time zone to match exactly.`,
    '6. Confirm the scheduled post and check that it appears in the Planner at that time.',
    '',
    'Rules: if you are not signed in to Facebook, ask me to sign in and wait. Never publish immediately. Do not create or change anything else (no ads, no boosts, no other posts, no Instagram cross-posting unless it is already the default and cannot be turned off).',
    '',
    'When you finish, end your final message with exactly one of these lines:',
    'RESULT: SCHEDULED | <Page name> | <date and time as Facebook shows it>',
    'RESULT: FAILED | <short reason>',
  ].join('\n');
}

export function parseScheduleResult(text: string): { state: 'scheduled' | 'failed' | null; detail: string } {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\**\s*RESULT:\s*(SCHEDULED|FAILED)\s*\**\s*(?:\|\s*(.*))?$/i.exec(lines[i]);
    if (m) {
      const detail = (m[2] ?? '').replace(/\*+$/, '').split('|').map((x) => x.trim()).filter(Boolean).join(' · ');
      return { state: m[1].toUpperCase() === 'SCHEDULED' ? 'scheduled' : 'failed', detail };
    }
  }
  return { state: null, detail: '' };
}

const WAITING_COPY: Record<string, string> = {
  needConnectMyBrowser: 'Manus needs you to connect your browser in Manus so it can use Facebook.',
  messageAskUser: 'Manus has a question for you.',
  cascadeAskUser: 'Manus has a question for you.',
};

export function stateFromManus(s: ManusState): Pick<ExternalPublish, 'state' | 'message'> {
  if (s.status === 'error' || s.status === 'deleted') return { state: 'failed', message: s.error || (s.status === 'deleted' ? 'The Manus task was deleted.' : 'Manus reported an error.') };
  if (s.waiting) return { state: 'needs_input', message: s.waitingDescription || WAITING_COPY[s.waitingType] || 'Manus paused and needs you (for example, to sign in to Facebook). Open the task in Manus.' };
  if (s.done) {
    const r = parseScheduleResult(s.text);
    if (r.state === 'scheduled') return { state: 'scheduled', message: r.detail || 'Scheduled on Facebook.' };
    if (r.state === 'failed') return { state: 'failed', message: r.detail || 'Manus couldn’t schedule the post.' };
    return { state: 'finished', message: s.text.slice(0, 280) || 'Manus finished. Check the task to confirm the post was scheduled.' };
  }
  return { state: 'working', message: 'Manus is scheduling it on Facebook…' };
}

/** Start the Manus task. One-shot: never retried automatically. */
export async function startFacebookSchedule(post: Post, page: string): Promise<ExternalPublish> {
  const image = post.media?.kind === 'image' ? await getBlob(post.media.id) : null;
  const timeZone = localTimeZone();
  const task = await createManusTask({
    prompt: facebookSchedulePrompt({ page, whenIso: post.scheduledAt, timeZone, text: postText(post), hasImage: !!image }),
    title: `Schedule Facebook post · ${post.headline}`.slice(0, 110),
    image,
    imageName: post.media?.name,
    interactive: true,
  });
  const now = Date.now();
  return { via: 'manus', network: 'facebook', taskId: task.taskId, taskUrl: task.taskUrl, state: 'working', message: 'Manus is opening Facebook…', page, scheduledFor: post.scheduledAt, requestedAt: now, checkedAt: now };
}

export async function refreshFacebookSchedule(ext: ExternalPublish): Promise<ExternalPublish> {
  const s = await readManusTask(ext.taskId, { waitSeconds: 0 });
  return { ...ext, ...stateFromManus(s), taskUrl: s.taskUrl || ext.taskUrl, checkedAt: Date.now() };
}
