// Sharing a post in Facebook groups, by Manus: it opens each group you listed (ones you're already a
// member of), reads the group's rules, and posts the same text with the same image or video, once,
// pausing between groups so the account isn't flagged for spam. It reports every group: posted,
// waiting for the admins' approval, skipped (the rules don't allow it) or failed.

import type { GroupResult, GroupShare, Post } from '@/lib/types';
import { getBlob } from '@/lib/storage';
import { linkText, placeLink } from '@/lib/pageLink';
import { ManusError, createManusTask, readManusTask, sendFileToManus, type ManusState } from './manus';
import { postText } from './manusPost';

/**
 * The text for groups: the link goes in the text (Manus never comments in groups, and a "bio" there is the
 * poster's own). Where the caption pointed to the link, the link takes its place. A post whose link goes in the
 * first comment, and whose caption doesn't say so, ends with that comment's text instead, so the link isn't lost.
 */
export function groupPostText(post: Pick<Post, 'caption' | 'hashtags'> & Partial<Pick<Post, 'linkPlacement' | 'firstComment'>>, link: string | null, known: string[] = []): string {
  const caption = placeLink(post.caption, link ? { url: link, placement: 'post' } : null, 'facebook', known);
  const comment = post.linkPlacement === 'comment' ? post.firstComment?.trim() : '';
  const carried = !link || caption.includes(link) || caption.includes(linkText(link));
  return postText({ ...post, caption: comment && !carried ? `${caption.trim()}\n\n${comment}` : caption });
}

/** Most groups per share: posting the same thing in many groups at once looks like spam to Facebook. */
export const MAX_GROUPS = 10;

/** The groups from what you typed: one per line (a name or a facebook.com/groups link), no repeats. */
/** Two entries are the same group when they match ignoring case and a trailing slash. */
export const groupKey = (g: string) => g.trim().toLowerCase().replace(/\/+$/, '');

export function parseGroups(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n|,(?=\s*https?:)/)) {
    const g = line.trim().replace(/^[-•*\d.)\s]+(?=\S)/, '').trim();
    if (!g || g.length > 200) continue;
    const key = groupKey(g);
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
    'Rules: if you are not signed in to Facebook, ask me to sign in and wait. Post once in each group, straight away: don’t check whether the group already has this post. Never join groups, comment, react, message anyone, or change anything else. Never post in a group that is not on the list.',
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

type ShareRecord = Pick<GroupShare, 'groups' | 'results' | 'earlier'>;

const wentOut = (r: GroupResult) => r.state === 'posted' || r.state === 'pending';

/** Everything a post's group shares reported: results kept from earlier runs, then this run's. */
export function groupRecord(share: ShareRecord): { groups: string[]; results: GroupResult[] } {
  const listed = new Set(share.groups.map(groupKey));
  const earlier = (share.earlier ?? []).filter((r) => !listed.has(groupKey(r.group)));
  return { groups: [...earlier.map((r) => r.group), ...share.groups], results: [...earlier, ...share.results] };
}

/** The groups a post's shares reported as posted or waiting for approval. */
export function groupsAlreadyOut(share: ShareRecord): string[] {
  const rec = groupRecord(share);
  const out = new Set(rec.results.filter(wentOut).map((r) => groupKey(r.group)));
  return rec.groups.filter((g) => out.has(groupKey(g)));
}

/**
 * The groups to offer when sending the post to groups again. Manus doesn't look for an earlier copy before
 * posting, so the groups it reported as posted (or waiting for approval) are left out, unless it reported
 * every group that way: then sending again is a new share to all of them (and the window says it posts twice).
 */
export function groupsToRetry(share: ShareRecord): string[] {
  const rec = groupRecord(share);
  const out = new Set(groupsAlreadyOut(share).map(groupKey));
  const rest = rec.groups.filter((g) => !out.has(groupKey(g)));
  return rest.length ? rest : rec.groups;
}

/** The results a new share of the post keeps: the groups that already have it and aren't being sent again. */
export function carriedResults(share: ShareRecord, sent: string[]): GroupResult[] {
  const sentKeys = new Set(sent.map(groupKey));
  return groupRecord(share).results.filter((r) => wentOut(r) && !sentKeys.has(groupKey(r.group)));
}

/**
 * The group list to remember after sending a post to groups again: the list you had, plus any group you
 * added, once each. Groups the last run reported as failed that you didn't send again (often a name you
 * corrected) are dropped. Over MAX_GROUPS, the groups you just sent stay first.
 */
export function rememberedGroups(current: string[], sent: string[], dropped: string[] = []): string[] {
  const sentKeys = new Set(sent.map(groupKey));
  const gone = new Set(dropped.map(groupKey).filter((k) => !sentKeys.has(k)));
  const merged = parseGroups([...current.filter((g) => !gone.has(groupKey(g))), ...sent].join('\n'));
  if (merged.length <= MAX_GROUPS) return merged;
  let room = MAX_GROUPS - merged.filter((g) => sentKeys.has(groupKey(g))).length;
  return merged.filter((g) => sentKeys.has(groupKey(g)) || room-- > 0).slice(0, MAX_GROUPS);
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

/** Hand the post to Manus for the groups, with the link in the text when there's one. One-shot: never retried. */
export async function startGroupShare(post: Post, groups: string[], postAs: string, onStage?: (stage: string) => void, link: { url: string; known: string[] } | null = null): Promise<GroupShare> {
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
    prompt: groupsPrompt({ groups, postAs, text: groupPostText(post, link?.url ?? null, link?.known), media: media?.kind ?? null }),
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
