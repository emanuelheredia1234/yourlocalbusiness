// Sharing a post in Facebook groups, by Manus: it opens each group you listed (ones you're already a
// member of), reads the group's rules, and posts the same text with the same image or video, once,
// pausing between groups so the account isn't flagged for spam. It reports every group: posted,
// waiting for the admins' approval, skipped (the rules don't allow it) or failed.

import type { GroupResult, GroupShare, Post } from '@/lib/types';
import { getBlob } from '@/lib/storage';
import { ManusError, createManusTask, readManusTask, sendFileToManus, type ManusState } from './manus';
import { postText } from './manusPost';

/** Most groups per share: posting the same thing in many groups at once looks like spam to Facebook. */
export const MAX_GROUPS = 10;

/** The groups from what you typed: one per line (a name or a facebook.com/groups link), no repeats. */
export function parseGroups(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n|,(?=\s*https?:)/)) {
    const g = line.trim().replace(/^[-•*\d.)\s]+(?=\S)/, '').trim();
    if (!g || g.length > 200) continue;
    const key = g.toLowerCase().replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

/** A group link must be a Facebook group address; anything else is taken as a group name. */
export function groupLinkError(g: string): string | null {
  if (!/^https?:\/\//i.test(g) && !/^(www\.|m\.)?facebook\.com\//i.test(g)) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(g) ? g : `https://${g}`);
    return /(^|\.)facebook\.com$/i.test(u.hostname) && /^\/groups\/[^/]+/i.test(u.pathname) ? null : `“${g}” isn’t a Facebook group link (it should look like facebook.com/groups/…).`;
  } catch {
    return `“${g}” isn’t a valid link.`;
  }
}

/** Exact instructions for Manus: the same post in each group, once, following each group's rules. */
export function groupsPrompt(o: { groups: string[]; postAs: string; text: string; media: 'image' | 'video' | null }): string {
  const asPage = o.postAs.trim();
  return [
    'Share ONE post in each of these Facebook groups, right now. Use your web browser.',
    '',
    'Groups (in this order):',
    ...o.groups.map((g, i) => `${i + 1}. ${g}`),
    '',
    'For each group:',
    '1. Open Facebook (https://www.facebook.com). If the group is a link, open it; if it is a name, find it under Groups → Your groups. Only post in groups this account is already a member of: never join a group, request to join, or answer membership questions. If you can’t find the group, report it as FAILED.',
    '2. Read the group’s rules (the About or Rules section). If they don’t allow this kind of post (for example: no promotions, no business posts, no links, only on certain days), do not post: report the group as SKIPPED with the rule.',
    asPage
      ? `3. Post as the Facebook Page "${asPage}" if the group lets you choose it (the "Posting as" or profile switch in the composer). If the group only allows posting as a person, post as the signed-in profile and say so in the report.`
      : '3. Post as the signed-in profile.',
    '4. In the group’s composer ("Write something…"), paste this exact post text, keeping its line breaks, emojis and hashtags:',
    '<<<POST TEXT',
    o.text,
    'POST TEXT>>>',
    o.media === 'image'
      ? '5. Attach the image file provided with this task exactly as it is (no edits, no crop, no extra images).'
      : o.media === 'video'
        ? '5. Attach the video file provided with this task exactly as it is (no edits, no trimming). Wait until it has finished uploading.'
        : '5. This is a text-only post: do not add any image or video.',
    '6. Choose "Post". If the group sends it to its admins for approval, that is fine: report it as PENDING.',
    '7. Wait about 2 minutes before going to the next group (posting the same thing in many groups at once can get the account limited).',
    '',
    'Rules: if you are not signed in to Facebook, ask me to sign in and wait. Post exactly once per group: if this exact text is already in the group (or waiting for approval) from the last day, do not post it again, report it as POSTED or PENDING. Never join groups, comment, react, message anyone, or change anything else. Never post in a group that is not on the list.',
    '',
    'When you finish, end your final message with one line per group, in the same order, then the summary line:',
    'GROUP: <group as listed> | POSTED | <link to the post, if you can see it>',
    'GROUP: <group as listed> | PENDING | waiting for admin approval',
    'GROUP: <group as listed> | SKIPPED | <the rule or setting that doesn’t allow it>',
    'GROUP: <group as listed> | FAILED | <short reason>',
    'RESULT: GROUPS DONE',
  ].join('\n');
}

const STATES: Record<string, GroupResult['state']> = { POSTED: 'posted', PUBLISHED: 'posted', PENDING: 'pending', SKIPPED: 'skipped', FAILED: 'failed' };

/** A reported link, only when it is a Facebook address. */
function fbLink(text: string): string | undefined {
  for (const m of text.matchAll(/https?:\/\/[^\s|<>"')\]]+/gi)) {
    try {
      const u = new URL(m[0].replace(/[.,;:!?*]+$/, ''));
      if (u.protocol === 'https:' && /(^|\.)(facebook\.com|fb\.com)$/i.test(u.hostname) && u.pathname.length > 1) return u.toString();
    } catch {
      /* not a link */
    }
  }
  return undefined;
}

/** Manus's per-group lines (Markdown tolerated). The last report for a group wins. */
export function parseGroupResults(text: string, groups: string[]): { results: GroupResult[]; done: boolean } {
  const byGroup = new Map<string, GroupResult>();
  let done = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[*_`]/g, '').replace(/^[\s>#-]+/, '').trim();
    if (/^RESULT:\s*GROUPS\s+DONE/i.test(line)) done = true;
    const m = /^GROUP:\s*(.+?)\s*\|\s*(POSTED|PUBLISHED|PENDING|SKIPPED|FAILED)\s*(?:\|\s*(.*))?$/i.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    // match the group as you listed it (Manus may shorten or re-case it)
    const listed = groups.find((g) => g.toLowerCase() === name.toLowerCase()) ?? groups.find((g) => g.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(g.toLowerCase())) ?? name;
    const state = STATES[m[2].toUpperCase()];
    const detail = (m[3] ?? '').trim();
    byGroup.set(listed, { group: listed, state, detail, url: state === 'posted' ? fbLink(detail) : undefined });
  }
  // listed order; groups Manus didn't mention are left out (the summary says how many)
  return { results: groups.map((g) => byGroup.get(g)).filter((r): r is GroupResult => !!r), done };
}

export function groupSummary(share: Pick<GroupShare, 'results' | 'groups'>): string {
  const n = (s: GroupResult['state']) => share.results.filter((r) => r.state === s).length;
  const parts = [n('posted') && `posted in ${n('posted')}`, n('pending') && `${n('pending')} waiting for admin approval`, n('skipped') && `${n('skipped')} skipped`, n('failed') && `${n('failed')} failed`].filter(Boolean);
  const missing = share.groups.length - share.results.length;
  if (missing > 0) parts.push(`${missing} not reported`);
  return parts.length ? `${parts.join(', ')} (of ${share.groups.length} group${share.groups.length === 1 ? '' : 's'})` : '';
}

export function groupStateFromManus(s: ManusState, groups: string[]): Pick<GroupShare, 'state' | 'message' | 'results'> {
  const { results, done } = parseGroupResults(s.text || '', groups);
  if (s.status === 'error' || s.status === 'deleted') return { state: 'failed', message: s.error || 'Manus reported an error.', results };
  if (s.waiting) return { state: 'needs_input', message: s.waitingDescription || 'Manus paused and needs you (for example, to sign in to Facebook). Open the task in Manus.', results };
  if (s.done) {
    if (results.length || done) return { state: 'done', message: groupSummary({ results, groups }) || 'Manus finished.', results };
    return { state: 'finished', message: (s.text || '').slice(0, 280) || 'Manus finished. Open the task to see what it posted.', results };
  }
  return { state: 'working', message: `Manus is posting in ${groups.length} group${groups.length === 1 ? '' : 's'}…`, results };
}

/** Hand the post to Manus for the groups. One-shot: never retried. */
export async function startGroupShare(post: Post, groups: string[], postAs: string, onStage?: (stage: string) => void): Promise<GroupShare> {
  if (!groups.length) throw new ManusError('Add at least one group.', 'MANUS_CREATE');
  if (groups.length > MAX_GROUPS) throw new ManusError(`Up to ${MAX_GROUPS} groups at a time.`, 'MANUS_CREATE');
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
  const task = await createManusTask({
    fn: 'facebook',
    prompt: groupsPrompt({ groups, postAs, text: postText(post), media: media?.kind ?? null }),
    title: `Post in ${groups.length} Facebook group${groups.length === 1 ? '' : 's'} · ${post.headline}`.slice(0, 110),
    image,
    imageName: media?.name,
    files,
    interactive: true,
  });
  const at = Date.now();
  return { via: 'manus', taskId: task.taskId, taskUrl: task.taskUrl, state: 'working', message: 'Manus is opening Facebook…', groups, postAs, results: [], requestedAt: at, checkedAt: at };
}

export async function refreshGroupShare(share: GroupShare): Promise<GroupShare> {
  const s = await readManusTask(share.taskId, { waitSeconds: 0 });
  return { ...share, ...groupStateFromManus(s, share.groups), taskUrl: s.taskUrl || share.taskUrl, checkedAt: Date.now() };
}
