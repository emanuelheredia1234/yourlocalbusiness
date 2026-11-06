// Following the posts the app is sending through your connected accounts. While a job is sending, its post is
// read every 3 seconds for up to 2 minutes with GET /api/posting/jobs/:id: a pure read that never contacts
// the network and never sends again. On load, only jobs still sending are picked up again; an "unknown" job is
// never checked by itself (only your "Check again" press does that). On load and when another business comes on
// screen, the business's job list (a database read) says whether an earlier try that failed was posted after all,
// so a post may be on the network twice: that post says so, once.
import { useEffect } from 'react';
import type { PublishJob } from '@/lib/integrations/types';
import { followJob } from '@/lib/posting';
import { listJobs } from '@/lib/integrations/api';
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
  // a try that failed is never "there twice" (an older server could still send the note with it): its failure shows
  if (job.note === 'POSTED_AFTER_ALL' || (job.note === 'MAY_APPEAR_TWICE' && job.state !== 'failed')) {
    toast({ kind: 'info', title: `This post may be on ${name} twice`, body: job.noteMessage || `An earlier try was posted after all. Check ${name} and delete one if it’s there twice.` });
    useStore.getState().notify({ kind: 'post', title: `May be on ${name} twice`, body: post.headline, route: 'calendar' });
  } else if (job.state === 'sent' && job.note === 'SENT_TO_DRAFTS') {
    toast({ kind: 'info', title: 'Sent to your TikTok drafts', body: job.noteMessage || 'Open TikTok to publish it.' });
    useStore.getState().notify({ kind: 'post', title: 'Sent to your TikTok drafts', body: post.headline, route: 'calendar' });
  } else if (job.state === 'sent') {
    toast({ kind: 'success', title: `Posted on ${name}`, ...(job.url ? { action: { label: 'View post', run: () => void window.open(job.url, '_blank', 'noopener,noreferrer') } } : {}) });
    useStore.getState().notify({ kind: 'post', title: `Posted on ${name}`, body: post.headline, route: 'calendar' });
  } else if (job.state === 'failed') {
    toast({ kind: 'error', title: `The ${name} post didn’t go out`, body: job.errorMessage || 'Open the post to see why, then try again or post it yourself.' });
  } else if (job.state === 'unknown') {
    toast({ kind: 'info', title: `We couldn’t confirm the ${name} post went out`, body: `It may have been posted - check ${name} before trying again.` });
  }
}

/** After the first two minutes, a job still sending is read every 30 s for up to 10 more minutes (a video can take
 *  10 minutes to process, and the server marks a job stuck for 11 minutes "unknown"), so its card never stays on
 *  "Posting…" for the rest of the visit. */
const SLOW = { intervalMs: 30_000, maxMs: 600_000 };
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

/**
 * One read of a business's jobs: a post whose earlier failed try was posted after all (or whose live try may
 * therefore be there twice) takes that news and says so once. A database read only; nothing is sent.
 */
export async function syncPostedTwice(projectId: string): Promise<void> {
  let jobs: PublishJob[] = [];
  try {
    jobs = (await listJobs(projectId)).jobs ?? [];
  } catch {
    return;
  }
  // newest first: a post's live try is applied before its older ones
  for (const job of jobs) {
    const before = useStore.getState().posts.find((p) => p.id === job.postId);
    if (!before) continue;
    const ext = before.external?.via === 'api' ? before.external : undefined;
    const twiceNews = job.note === 'POSTED_AFTER_ALL' || (job.note === 'MAY_APPEAR_TWICE' && job.state !== 'failed');
    // an earlier try that went out after all, over a later one that failed: the post is out (once)
    const outOverFailed = job.state === 'sent' && !!ext && ext.jobId !== job.id && ext.state === 'failed';
    if (!twiceNews && !outOverFailed) continue;
    // already on the post as this job says: nothing changes (and nothing is saved again)
    if (ext && ext.jobId === job.id && ext.state === (job.state === 'sent' ? 'posted' : job.state === 'failed' ? 'failed' : job.state === 'unknown' ? 'unknown' : 'working') && (ext.twice === true) === twiceNews && (ext.url ?? '') === (job.url ?? '')) continue;
    const had = ext?.twice === true;
    useStore.getState().applyPublishJob(job.postId, job);
    const after = useStore.getState().posts.find((p) => p.id === job.postId);
    const now = after?.external?.via === 'api' ? after.external : undefined;
    if ((!had && now?.twice) || (outOverFailed && now?.jobId === job.id)) announceJob(job.postId, job);
  }
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
  const projectId = useStore((s) => s.activeProjectId);
  useEffect(() => {
    if (__ARTIFACT_BUILD__ || !userId) return;
    void useAnalytics.getState().refreshConnections();
    const t = setTimeout(() => {
      for (const { postId, jobId } of sendingJobs(useStore.getState().posts)) void trackJob(postId, jobId);
    }, 2000);
    return () => clearTimeout(t);
  }, [userId]);
  // the business on screen: news of a try posted after all (its post may be there twice)
  useEffect(() => {
    if (__ARTIFACT_BUILD__ || !userId || !projectId) return;
    const t = setTimeout(() => void syncPostedTwice(projectId), 2500);
    return () => clearTimeout(t);
  }, [userId, projectId]);
  return null;
}
