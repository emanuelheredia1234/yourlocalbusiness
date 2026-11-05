// Following the posts the app is sending through your connected accounts. While a job is sending, its post is
// read every 3 seconds for up to 2 minutes with GET /api/posting/jobs/:id: a pure read that never contacts
// the network and never sends again. On load, only jobs still sending are picked up again; an "unknown" job is
// never checked by itself (only your "Check again" press does that).
import { useEffect } from 'react';
import type { PublishJob } from '@/lib/integrations/types';
import { followJob } from '@/lib/posting';
import { networkLabel } from '@/ai/postShared';
import { useStore } from '@/store/useStore';
import { useAnalytics } from '@/store/analytics';
import { useAuth } from '@/lib/cloud/auth';
import { toast } from '@/store/ui';

/** Jobs being followed right now (one loop per job, however many buttons show it). */
const following = new Set<string>();

/** What a finished job means for its post, said once. */
export function announceJob(postId: string, job: PublishJob) {
  const post = useStore.getState().posts.find((p) => p.id === postId);
  if (!post) return;
  const name = networkLabel(post.platform);
  if (job.state === 'sent') {
    toast({ kind: 'success', title: `Posted on ${name}`, ...(job.url ? { action: { label: 'View post', run: () => void window.open(job.url, '_blank', 'noopener,noreferrer') } } : {}) });
    useStore.getState().notify({ kind: 'post', title: `Posted on ${name}`, body: post.headline, route: 'calendar' });
  } else if (job.state === 'failed') {
    toast({ kind: 'error', title: `The ${name} post didn’t go out`, body: 'Open the post to see why, then try again or post it yourself.' });
  } else if (job.state === 'unknown') {
    toast({ kind: 'info', title: `We couldn’t confirm the ${name} post went out`, body: `Check ${name} before trying anything else.` });
  }
}

/** After the first two minutes, a job still sending is read every 30 s for up to 5 more minutes (the server marks
 *  one stuck for 3 minutes "unknown"), so its card never stays on "Posting…" for the rest of the visit. */
const SLOW = { intervalMs: 30_000, maxMs: 300_000 };
const stillSending = (job: PublishJob | null) => !!job && (job.state === 'queued' || job.state === 'sending');

/** Follow one job until it's no longer sending (GET only), putting each answer on its post. */
export function trackJob(postId: string, jobId: string, o: { intervalMs?: number; maxMs?: number; slow?: { intervalMs: number; maxMs: number } } = {}): Promise<void> {
  if (following.has(jobId)) return Promise.resolve();
  following.add(jobId);
  let lastState: PublishJob['state'] | null = null;
  const onUpdate = (job: PublishJob) => {
    useStore.getState().applyPublishJob(postId, job);
    lastState = job.state;
  };
  return followJob(jobId, { intervalMs: o.intervalMs, maxMs: o.maxMs, onUpdate })
    .then(async (job) => {
      // still sending after the first follow: keep reading, slower (still GET only)
      if (stillSending(job) || (!job && lastState === null)) job = (await followJob(jobId, { ...(o.slow ?? SLOW), onUpdate })) ?? job;
      if (job && lastState && lastState !== 'queued' && lastState !== 'sending') announceJob(postId, job);
    })
    .finally(() => following.delete(jobId));
}

/** Jobs the post list says are still sending (the ones to pick up again on load). */
export const sendingJobs = (posts: ReturnType<typeof useStore.getState>['posts']) =>
  posts.filter((p) => p.external?.via === 'api' && p.external.state === 'working' && p.external.jobId).map((p) => ({ postId: p.id, jobId: p.external!.jobId! }));

/**
 * Mounted once in the app. Once signed in: reads which accounts are connected (so posts show "Post on <network>"
 * or "Post it yourself"), and picks up posts that were still sending when the page was closed.
 */
export function PublishJobWatcher() {
  const userId = useAuth((s) => (s.phase === 'ready' ? s.user?.id : undefined));
  useEffect(() => {
    if (__ARTIFACT_BUILD__ || !userId) return;
    void useAnalytics.getState().refreshConnections();
    const t = setTimeout(() => {
      for (const { postId, jobId } of sendingJobs(useStore.getState().posts)) void trackJob(postId, jobId);
    }, 2000);
    return () => clearTimeout(t);
  }, [userId]);
  return null;
}
