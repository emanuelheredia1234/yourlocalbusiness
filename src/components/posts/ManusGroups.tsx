// "Post to groups": Manus shares a Facebook post in the groups you list (ones you're a member of),
// following each group's rules, and reports every group.
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { CheckCircle2, CircleAlert, Clock, ExternalLink, Hand, Loader2, MinusCircle, RefreshCw, Users } from 'lucide-react';
import type { GroupResult, GroupShare, Post } from '@/lib/types';
import { cn, fmtRelative } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { manusViaServer } from '@/ai/manus';
import { postBlocker, postText, suggestedAccount } from '@/ai/manusPost';
import { MAX_GROUPS, carriedResults, groupKey, groupLinkError, groupRecord, groupSummary, groupsAlreadyOut, groupsToRetry, parseGroups, refreshGroupShare, rememberedGroups, startGroupShare } from '@/ai/manusGroups';
import { beginBusy, endBusy } from '@/lib/busy';
import { useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { AutoTextarea, Field, Modal, Spinner } from '../ui/primitives';
import { MediaThumb } from '../media/MediaUpload';
import { errorCopy, manusSetupHint, useCanOfferManus, useManusReady } from './ManusPost';

export const useManusGroups = create<{ id: string | null; open: (id: string) => void; close: () => void }>((set) => ({
  id: null,
  open: (id) => set({ id }),
  close: () => set({ id: null }),
}));

const openUrl = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');
/** Group shares being started right now (outside the window, so reopening it can't send twice). */
const sending = new Set<string>();

export function ManusGroupsHost() {
  const id = useManusGroups((s) => s.id);
  const close = useManusGroups((s) => s.close);
  const post = useStore((s) => s.posts.find((p) => p.id === id));
  const project = useStore((s) => s.projects.find((p) => p.id === post?.projectId));
  const ready = useManusReady();
  const viaServer = manusViaServer();
  const [raw, setRaw] = useState('');
  const [postAs, setPostAs] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [err, setErr] = useState<{ title: string; body: string; uncertain?: boolean } | null>(null);
  useEffect(() => {
    if (!id) return;
    const s = useStore.getState();
    const p = s.posts.find((x) => x.id === id);
    const proj = s.projects.find((x) => x.id === p?.projectId);
    setRaw((p?.groupShare ? groupsToRetry(p.groupShare) : proj?.marketing.facebookGroups ?? []).join('\n'));
    setPostAs(p?.groupShare?.postAs ?? (proj ? suggestedAccount(proj.id, 'facebook', proj.brand) : ''));
    setBusy(false);
    setStage('');
    setErr(null);
  }, [id]);
  if (!id || !post || !project) return null;

  const groups = parseGroups(raw);
  const linkProblem = groups.map(groupLinkError).find(Boolean) ?? null;
  const tooMany = groups.length > MAX_GROUPS ? `Up to ${MAX_GROUPS} groups at a time: posting the same thing in many groups at once can get your account limited by Facebook.` : null;
  const blocker = postBlocker({ ...post, platform: 'facebook' }, { viaServer });
  // Sending it to groups again. Manus doesn't look for an earlier copy before posting, so the list starts
  // without the groups it reported as posted (or waiting for approval), unless that's all of them. The
  // warnings follow the list as you edit it.
  const prev = post.groupShare ?? null;
  const out = prev ? groupsAlreadyOut(prev) : [];
  const listed = new Set(groups.map(groupKey));
  const outKeys = new Set(out.map(groupKey));
  const resent = groups.filter((g) => outKeys.has(groupKey(g)));
  const leftOut = out.filter((g) => !listed.has(groupKey(g)));
  const allResent = groups.length > 0 && resent.length === groups.length;
  const problem = blocker ?? linkProblem ?? tooMany ?? (groups.length ? null : 'Add at least one group.');
  const inFlight = busy || sending.has(post.id);

  const send = async () => {
    if (inFlight || problem || !ready) return;
    sending.add(post.id);
    beginBusy(`manus-groups:${post.id}`, 'Sending to Manus', 'app');
    setBusy(true);
    setErr(null);
    try {
      const share = await startGroupShare(useStore.getState().posts.find((x) => x.id === post.id) ?? post, groups, postAs.trim(), setStage);
      // the groups that already have it stay on the post, with their results and links
      const earlier = prev ? carriedResults(prev, groups) : [];
      useStore.getState().updatePost(post.id, { groupShare: earlier.length ? { ...share, earlier } : share });
      // remembered for the next post (saved with the project). Sending again keeps the list you had (the
      // groups left out are still yours), plus any group you added.
      const failedBefore = prev ? groupRecord(prev).results.filter((r) => r.state === 'failed').map((r) => r.group) : [];
      useStore.getState().updateProject(project.id, (p) => ({ ...p, marketing: { ...p.marketing, facebookGroups: prev ? rememberedGroups(p.marketing.facebookGroups ?? groupRecord(prev).groups, groups, failedBefore) : groups } }));
      toast({ kind: 'success', title: 'Sent to Manus', body: `Manus is posting it in ${groups.length} group${groups.length === 1 ? '' : 's'}, a couple of minutes apart. The post card shows each group’s result.`, action: { label: 'Watch in Manus', run: () => openUrl(share.taskUrl) } });
      close();
    } catch (e) {
      setErr(errorCopy(e));
    } finally {
      sending.delete(post.id);
      endBusy(`manus-groups:${post.id}`);
      setBusy(false);
      setStage('');
    }
  };

  return (
    <Modal
      open
      onClose={() => !inFlight && close()}
      size="lg"
      title="Post to Facebook groups with Manus"
      subtitle="Manus opens each group in its own browser, signed in as you, checks the group’s rules, and posts this exactly: the text, and the image or video."
      footer={
        <>
          <button className="btn btn-ghost btn-sm mr-auto" disabled={inFlight} onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" disabled={inFlight || !!problem || !ready || !!err?.uncertain} onClick={send}>
            {busy ? <Spinner size={14} /> : <Users size={14} />} {busy && stage ? stage : allResent ? 'Post to these groups again' : `Post to ${groups.length || ''} group${groups.length === 1 ? '' : 's'}`.replace('  ', ' ')}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_200px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Field label="Groups" htmlFor="fb-groups" hint={`One per line: the group’s name, or its link (facebook.com/groups/…). Only groups you’re already a member of. Up to ${MAX_GROUPS}.`} error={linkProblem ?? tooMany ?? undefined}>
            <AutoTextarea id="fb-groups" value={raw} onChange={setRaw} minRows={4} disabled={inFlight} placeholder={'Austin Small Business Owners\nhttps://www.facebook.com/groups/…'} />
          </Field>
          <Field label="Post as (optional)" htmlFor="fb-groups-as" hint="Your Page’s name, for groups that let you post as a Page. Leave empty to post as your profile.">
            <input id="fb-groups-as" className="input" value={postAs} disabled={inFlight} onChange={(e) => setPostAs(e.target.value)} placeholder="Your Page name" />
          </Field>
          <div>
            <p className="label">Post text</p>
            <p className="max-h-40 overflow-y-auto whitespace-pre-line rounded-md border border-line bg-surface-2/50 p-3 text-[13px] leading-relaxed text-ink-2">{postText(post)}</p>
          </div>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[12.5px] text-muted">
            <li>Manus posts once in each group, right away, about 2 minutes apart, and never joins a group or comments.</li>
            <li>It reads each group’s rules first and skips groups that don’t allow this kind of post. Some groups hold posts for their admins to approve.</li>
            <li>It’s one Manus task for all the groups, on your Manus credits. The first time, sign in to Facebook inside Manus.</li>
          </ul>
          {prev && !err?.uncertain && (
            <p className="text-[12.5px] font-medium text-warn">
              {resent.length > 0 && `Manus already posted this in ${resent.join(', ')} (or it’s waiting for their admins): sending it again posts it twice there. `}
              {prev.state === 'failed' ? 'The last try stopped before Manus finished, so it may also have posted in groups it didn’t report. ' : resent.length ? '' : 'Manus already shared this post in groups. '}
              {leftOut.length > 0 && `Left out, as Manus reported ${leftOut.length === 1 ? 'it' : 'them'} posted or waiting for approval: ${leftOut.join(', ')}. `}
              {!allResent && 'Sending it again to a group that already has it posts it twice. '}
              Check{' '}
              <a href={prev.taskUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary hover:underline">
                the last task in Manus
              </a>
              , or look in the groups on Facebook, first.
            </p>
          )}
          {blocker && <p className="text-[12.5px] font-medium text-warn">{blocker}</p>}
          {!ready && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-[12.5px]" role="alert">
              <p className="min-w-0 flex-1 font-medium text-warn">Manus can’t post yet. {manusSetupHint()}</p>
              {!__ARTIFACT_BUILD__ && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    close();
                    useUI.getState().setSettingsTab('ai');
                    navigate('workspace-settings');
                  }}
                >
                  Open Settings → AI
                </button>
              )}
            </div>
          )}
          {err && (
            <div className="rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-[12.5px]" role="alert">
              <p className="font-semibold text-bad">{err.title}</p>
              <p className="text-ink-2">{err.body}</p>
              {err.uncertain && (
                <button type="button" className="mt-1 font-semibold text-primary hover:underline" onClick={() => setErr(null)}>
                  I checked Manus: it didn’t start. Allow sending again
                </button>
              )}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="label">{post.media?.kind === 'video' ? 'Video' : 'Image'}</p>
          {post.media ? <MediaThumb media={post.media} className="aspect-[4/5] w-full" /> : <p className="rounded-md border border-dashed border-line-2 p-3 text-xs text-muted">No image or video: a text-only post.</p>}
        </div>
      </div>
    </Modal>
  );
}

const RESULT_UI: Record<GroupResult['state'], { label: string; cls: string; icon: typeof CheckCircle2 }> = {
  posted: { label: 'Posted', cls: 'text-good', icon: CheckCircle2 },
  pending: { label: 'Waiting for admin approval', cls: 'text-warn', icon: Clock },
  skipped: { label: 'Skipped', cls: 'text-muted', icon: MinusCircle },
  failed: { label: 'Failed', cls: 'text-bad', icon: CircleAlert },
};

const SHARE_UI: Record<GroupShare['state'], { label: (n: number) => string; cls: string; icon: typeof Loader2 }> = {
  working: { label: (n) => `Manus is posting in ${n} group${n === 1 ? '' : 's'}`, cls: 'bg-info/10 text-info', icon: Loader2 },
  needs_input: { label: () => 'Manus needs you (groups)', cls: 'bg-warn/15 text-warn', icon: Hand },
  done: { label: () => 'Facebook groups', cls: 'bg-good-soft text-good', icon: Users },
  failed: { label: () => 'Group posting didn’t go through', cls: 'bg-bad-soft text-bad', icon: CircleAlert },
  finished: { label: () => 'Manus finished the groups: check the result', cls: 'bg-surface-2 text-ink-2', icon: CheckCircle2 },
};

/** The groups a post was shared in, and how each went. */
export function GroupShareBadge({ post, compact }: { post: Post; compact?: boolean }) {
  const share = post.groupShare;
  const [checking, setChecking] = useState(false);
  if (!share) return null;
  const ui = SHARE_UI[share.state];
  // this run's results, after those kept from an earlier run (groups it isn't sending to again)
  const rec = groupRecord(share);
  const summary = groupSummary(rec);
  if (compact) {
    return (
      <span className={cn('badge inline-flex items-center gap-1', ui.cls)} title={share.state === 'done' && summary ? summary : share.message}>
        <ui.icon size={11} className={cn(share.state === 'working' && 'animate-spin')} /> {share.state === 'done' && summary ? `Groups: ${summary}` : ui.label(share.groups.length)}
      </span>
    );
  }
  const check = async () => {
    setChecking(true);
    try {
      await applyGroupRefresh(post.id);
    } catch (e) {
      toast({ kind: 'error', ...errorCopy(e) });
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className={cn('rounded-md px-2.5 py-2 text-[12.5px]', ui.cls)} role="status">
      <p className="flex items-center gap-1.5 font-semibold">
        <ui.icon size={13} className={cn(share.state === 'working' && 'animate-spin')} />
        <span>
          {ui.label(share.groups.length)}
          {share.state === 'done' && summary && <span className="font-normal text-ink-2">: {summary}</span>}
        </span>
      </p>
      {share.state !== 'done' && share.message && <p className="mt-0.5 break-words text-ink-2">{share.message}</p>}
      {rec.results.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5 text-ink-2">
          {rec.results.map((r) => {
            const R = RESULT_UI[r.state];
            return (
              <li key={r.group} className="flex flex-wrap items-center gap-x-1.5">
                <R.icon size={12} className={R.cls} />
                <span className="font-medium">{r.group}</span>
                <span className={R.cls}>{R.label}</span>
                {r.detail && (r.state === 'skipped' || r.state === 'failed') && <span className="text-muted">· {r.detail}</span>}
                {r.url && (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-semibold text-primary hover:underline">
                    Open <ExternalLink size={10} />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
        <a href={share.taskUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
          Open in Manus <ExternalLink size={11} />
        </a>
        {(share.state === 'working' || share.state === 'needs_input' || share.state === 'finished') && (
          <button type="button" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline disabled:opacity-60" onClick={check} disabled={checking}>
            <RefreshCw size={11} className={cn(checking && 'animate-spin')} /> Check now
          </button>
        )}
        {share.state === 'failed' && (
          <button type="button" className="font-semibold text-primary hover:underline" onClick={() => useManusGroups.getState().open(post.id)}>
            Try again
          </button>
        )}
        <span className="text-muted">Checked {fmtRelative(share.checkedAt)}</span>
      </div>
    </div>
  );
}

/** "Post to groups" on a Facebook post. */
export function PostToGroupsButton({ post, size = 'sm' }: { post: Post; size?: 'sm' | 'xs' }) {
  const offer = useCanOfferManus();
  if (!offer || post.platform !== 'facebook') return null;
  if (post.groupShare && (post.groupShare.state === 'working' || post.groupShare.state === 'needs_input')) return null;
  return (
    <button type="button" className={cn('btn btn-secondary', size === 'xs' ? 'btn-xs' : 'btn-sm')} onClick={() => useManusGroups.getState().open(post.id)}>
      <Users size={size === 'xs' ? 12 : 14} /> Post to groups
    </button>
  );
}

async function applyGroupRefresh(postId: string) {
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

/** Checks group shares Manus is still working on, every 45 seconds while the app is open. */
export function useGroupShareWatcher() {
  useEffect(() => {
    let busy = false;
    let alive = true;
    const tick = async () => {
      if (busy || (typeof document !== 'undefined' && document.hidden)) return;
      const ids = useStore
        .getState()
        .posts.filter((p) => p.groupShare && (p.groupShare.state === 'working' || p.groupShare.state === 'needs_input') && Date.now() - p.groupShare.requestedAt < 3 * 24 * 3600_000)
        .sort((a, b) => (a.groupShare?.checkedAt ?? 0) - (b.groupShare?.checkedAt ?? 0))
        .map((p) => p.id)
        .slice(0, 3);
      if (!ids.length) return;
      busy = true;
      try {
        for (const id of ids) {
          if (!alive) return;
          try {
            await applyGroupRefresh(id);
          } catch {
            /* transient: try again on the next tick */
          }
        }
      } finally {
        busy = false;
      }
    };
    const first = setTimeout(tick, 6000);
    const t = setInterval(tick, 45_000);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
}
