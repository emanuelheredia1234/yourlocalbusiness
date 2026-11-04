// "Check now" for what Manus is doing with a post: posting it on its network, or sharing it in Facebook groups.
// Reading a task is free (no Manus credits) and never sends anything again. The post cards, the 45-second
// watchers and the assistant all use these, so a post's status moves the same way whoever checks.

import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { networkLabel, refreshManusPost } from './manusPost';
import { groupRecord, groupSummary, refreshGroupShare } from './manusGroups';

const openUrl = (url: string) => {
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
};

/**
 * Read the post's Manus task and update the post: posted (by Manus, on the network), scheduled, needs you, or
 * failed, with a toast and a notification when that changes. Nothing happens without a Manus task on it.
 */
export async function refreshPostFromManus(postId: string): Promise<void> {
  const post = useStore.getState().posts.find((p) => p.id === postId);
  if (!post?.external) return;
  const prev = post.external;
  const next = await refreshManusPost(prev);
  const name = networkLabel(next.network ?? 'facebook');
  // Manus reports it posted: the post is published (by Manus, on the network)
  // when it went out: right after the request for "post now", at its time for a scheduled one (never later than now)
  const wentOut = () => new Date(Math.min(Date.now(), next.mode === 'now' ? next.requestedAt : new Date(next.scheduledFor).getTime() || Date.now())).toISOString();
  if (next.state === 'posted' && prev.state !== 'posted' && post.status !== 'published') useStore.getState().updatePost(postId, { external: next, status: 'published', publishedBy: 'manus', publishedAt: wentOut(), postUrl: next.url ?? post.postUrl });
  else useStore.getState().updatePost(postId, { external: next });
  if (next.state !== prev.state) {
    const action = { label: 'Open in Manus', run: () => openUrl(next.taskUrl) };
    if (next.state === 'posted') {
      // the first comment didn't go on (or Manus didn't say): the owner adds it, from the post card
      const missed = next.comment?.state === 'failed' || next.comment?.state === 'unknown';
      const check = `Check the first ${next.network === 'x' ? 'reply' : 'comment'}: the post card has it to copy.`;
      toast({ kind: 'success', title: `Manus posted it on ${name}`, body: missed ? `${next.message}${/[.!?…]$/.test(next.message) ? '' : '.'} ${check}` : next.message, action });
      useStore.getState().notify({ kind: 'post', title: `Manus posted it on ${name}`, body: post.headline, route: 'calendar' });
    } else if (next.state === 'scheduled') {
      toast({ kind: 'success', title: `Manus scheduled it on ${name}`, body: next.message, action });
      useStore.getState().notify({ kind: 'post', title: `Manus scheduled your ${name} post`, body: post.headline, route: 'calendar' });
    } else if (next.state === 'needs_input') {
      toast({ kind: 'info', title: 'Manus needs you', body: next.message, action });
      useStore.getState().notify({ kind: 'info', title: 'Manus needs you to continue', body: next.message, route: 'calendar' });
    } else if (next.state === 'failed') {
      toast({ kind: 'error', title: `The ${name} post didn’t go through`, body: next.message, action });
    } else if (next.state === 'finished') {
      toast({ kind: 'info', title: 'Manus finished', body: `Open the task to confirm the post was ${next.mode === 'now' ? 'posted' : 'scheduled'}.`, action });
    }
  }
}

/** Read the post's Facebook-groups task and update each group's result, with a toast and a notification when it changes. */
export async function refreshGroupsFromManus(postId: string): Promise<void> {
  const post = useStore.getState().posts.find((p) => p.id === postId);
  if (!post?.groupShare) return;
  const prev = post.groupShare;
  const next = await refreshGroupShare(prev);
  useStore.getState().updatePost(postId, { groupShare: next });
  if (next.state === prev.state) return;
  const action = { label: 'Open in Manus', run: () => openUrl(next.taskUrl) };
  if (next.state === 'done') {
    const summary = groupSummary(groupRecord(next));
    toast({ kind: 'success', title: 'Manus finished the Facebook groups', body: summary || next.message, action });
    useStore.getState().notify({ kind: 'post', title: `Facebook groups: ${summary || 'done'}`, body: post.headline, route: 'calendar' });
  } else if (next.state === 'needs_input') {
    toast({ kind: 'info', title: 'Manus needs you', body: next.message, action });
    useStore.getState().notify({ kind: 'info', title: 'Manus needs you to continue (groups)', body: next.message, route: 'calendar' });
  } else if (next.state === 'failed') {
    toast({ kind: 'error', title: 'Group posting didn’t go through', body: next.message, action });
  } else if (next.state === 'finished') {
    toast({ kind: 'info', title: 'Manus finished the groups', body: 'Open the task to see what it posted.', action });
  }
}
