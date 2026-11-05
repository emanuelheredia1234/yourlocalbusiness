// "Check now" for what Manus is doing with a post in Facebook groups (Manus no longer posts on Pages or
// profiles). Reading a task is free (no Manus credits) and never sends anything again. The post cards, the
// 45-second watcher and the assistant all use this, so a share's status moves the same way whoever checks.

import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { groupRecord, groupSummary, refreshGroupShare } from './manusGroups';

const openUrl = (url: string) => {
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
};

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
