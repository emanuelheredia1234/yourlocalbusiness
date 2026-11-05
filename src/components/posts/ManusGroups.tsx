// "Post to groups": Manus shares a Facebook post in the groups you list (ones you're a member of),
// following each group's rules, and reports every group.
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { CircleAlert, CircleCheck, CircleMinus, Clock, ExternalLink, Hand, Loader2, RefreshCw, Type, Users } from 'lucide-react';
import type { GroupResult, GroupShare, Post } from '@/lib/types';
import { cn, fmtRelative } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { manusViaServer } from '@/ai/manus';
import { postBlocker, suggestedAccount } from '@/ai/manusPost';
import { MAX_GROUPS, carriedResults, groupKey, groupLinkError, groupPostText, groupRecord, groupSummary, groupsAlreadyOut, groupsToRetry, parseGroups, rememberedGroups, startGroupShare } from '@/ai/manusGroups';
import { knownLinks, linkText, pageLink, postPlacement } from '@/lib/pageLink';
import { beginBusy, endBusy } from '@/lib/busy';
import { useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, AutoTextarea, Callout, Field, Modal, Spinner } from '../ui/primitives';
import { MediaThumb } from '../media/MediaUpload';
import { PlatformChip } from './PlatformIcon';
import { TONE_BADGE, TONE_BLOCK, errorCopy, manusSetupHint, useCanOfferManus, useManusReady, type Tone } from './ManusPost';
import { refreshGroupsFromManus } from '@/ai/manusStatus';

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

  // in groups the link always goes in the text: Manus never comments there, and a bio would be the poster's own
  const page = pageLink(project);
  const groupLink = page ? { url: page.url, known: knownLinks(project) } : null;
  const groupText = groupPostText(post, groupLink?.url ?? null, groupLink?.known);
  // the post's link was going in a comment or a bio, and in groups it's in the text instead
  const linkMoved = !!groupLink && postPlacement(post) !== 'post' && (groupText.includes(groupLink.url) || groupText.includes(linkText(groupLink.url)));
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
      const share = await startGroupShare(useStore.getState().posts.find((x) => x.id === post.id) ?? post, groups, postAs.trim(), setStage, groupLink);
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
      size="md"
      title="Post to Facebook groups with Manus"
      subtitle="Manus shares this exact post in each group, signed in as you, after reading the group’s rules."
      footer={
        <>
          <button className="btn btn-secondary btn-sm" disabled={inFlight} onClick={close}>
            Cancel
          </button>
          <button className={cn('btn btn-ai btn-sm', busy && 'is-running')} disabled={inFlight || !!problem || !ready || !!err?.uncertain} aria-busy={busy || undefined} onClick={send}>
            {busy ? <Spinner /> : <Users />} {busy && stage ? stage : allResent ? 'Post to these groups again' : `Post to ${groups.length || ''} group${groups.length === 1 ? '' : 's'}`.replace('  ', ' ')}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex gap-3">
          {post.media ? (
            <MediaThumb media={post.media} className="h-14 w-14 shrink-0" />
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted ring-1 ring-inset ring-line" title="Text only">
              <Type size={20} aria-hidden="true" />
              <span className="sr-only">Text only</span>
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <PlatformChip platform="facebook" />
            {/* the text that goes, exactly (its link included) */}
            <p className="scroll-thin max-h-32 overflow-y-auto whitespace-pre-line text-small text-ink-2" tabIndex={0} aria-label="Post text">
              {groupText}
            </p>
          </div>
        </div>
        <Field label="Groups" htmlFor="fb-groups" hint={`One per line: the group’s name, or its link (facebook.com/groups/…). Only groups you’re already a member of. Up to ${MAX_GROUPS}.`} error={linkProblem ?? tooMany ?? undefined}>
          <AutoTextarea id="fb-groups" value={raw} onChange={setRaw} minRows={4} disabled={inFlight} placeholder={'Austin Small Business Owners\nhttps://www.facebook.com/groups/…'} />
        </Field>
        <Field label="Post as (optional)" htmlFor="fb-groups-as" hint="Your Page’s name, for groups that let you post as a Page. Leave empty to post as your profile.">
          <input id="fb-groups-as" className="input" value={postAs} disabled={inFlight} onChange={(e) => setPostAs(e.target.value)} placeholder="Your Page name" />
        </Field>
        {prev && !err?.uncertain && (
          <Callout tone="warn">
            {resent.length > 0 && `Manus already posted this in ${resent.join(', ')} (or it’s waiting for their admins): sending it again posts it twice there. `}
            {prev.state === 'failed' ? 'The last try stopped before Manus finished, so it may also have posted in groups it didn’t report. ' : resent.length ? '' : 'Manus already shared this post in groups. '}
            {leftOut.length > 0 && `Left out, as Manus reported ${leftOut.length === 1 ? 'it' : 'them'} posted or waiting for approval: ${leftOut.join(', ')}. `}
            {!allResent && 'Sending it again to a group that already has it posts it twice. '}
            Check{' '}
            <a href={prev.taskUrl} target="_blank" rel="noopener noreferrer" className="link">
              the last task in Manus
            </a>
            , or look in the groups on Facebook, first.
          </Callout>
        )}
        {blocker && <p className="text-small font-medium text-warn">{blocker}</p>}
        <Accordion type="single" collapsible className="-my-1 border-t border-line">
          <AccordionItem value="before" className="border-0">
            <AccordionTrigger className="py-2.5 text-small font-medium text-ink-2 hover:text-ink">Before you send</AccordionTrigger>
            <AccordionContent className="pb-2">
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-small text-muted">
                <li>Manus posts once in each group, right away, about 2 minutes apart, and never joins a group or comments.</li>
                {linkMoved && <li>In groups, your link goes in the post text: Manus doesn’t comment in groups.</li>}
                <li>It reads each group’s rules first and skips groups that don’t allow this kind of post. Some groups hold posts for their admins to approve.</li>
                <li>It’s one Manus task for all the groups, on your Manus credits. The first time, sign in to Facebook inside Manus.</li>
              </ul>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        {!ready && (
          <Callout
            tone="warn"
            title="Manus can’t post yet"
            action={
              !__ARTIFACT_BUILD__ && (
                <button
                  className="btn btn-secondary btn-xs"
                  onClick={() => {
                    close();
                    useUI.getState().setSettingsTab('ai');
                    navigate('workspace-settings');
                  }}
                >
                  Open Settings › AI keys
                </button>
              )
            }
          >
            {manusSetupHint()}
          </Callout>
        )}
        {err && (
          <Callout tone="bad" title={err.title}>
            <p>{err.body}</p>
            {err.uncertain && (
              <button type="button" className="link mt-1" onClick={() => setErr(null)}>
                I checked Manus: it didn’t start. Allow sending again
              </button>
            )}
          </Callout>
        )}
      </div>
    </Modal>
  );
}

const RESULT_UI: Record<GroupResult['state'], { label: string; cls: string; icon: typeof CircleCheck }> = {
  posted: { label: 'Posted', cls: 'text-good', icon: CircleCheck },
  pending: { label: 'Waiting for admin approval', cls: 'text-warn', icon: Clock },
  skipped: { label: 'Skipped', cls: 'text-muted', icon: CircleMinus },
  failed: { label: 'Failed', cls: 'text-bad', icon: CircleAlert },
};

const SHARE_UI: Record<GroupShare['state'], { label: (n: number) => string; tone: Tone; icon: typeof Loader2 }> = {
  working: { label: (n) => `Manus is posting in ${n} group${n === 1 ? '' : 's'}`, tone: 'primary', icon: Loader2 },
  needs_input: { label: () => 'Manus needs you (groups)', tone: 'warn', icon: Hand },
  done: { label: () => 'Facebook groups', tone: 'good', icon: Users },
  failed: { label: () => 'Group posting didn’t go through', tone: 'bad', icon: CircleAlert },
  finished: { label: () => 'Manus finished the groups: check the result', tone: 'neutral', icon: CircleCheck },
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
      <span className={cn('badge', TONE_BADGE[ui.tone])} title={share.state === 'done' && summary ? summary : share.message}>
        <ui.icon className={cn(share.state === 'working' && 'animate-spin')} aria-hidden="true" /> {share.state === 'done' && summary ? `Groups: ${summary}` : ui.label(share.groups.length)}
      </span>
    );
  }
  const check = async () => {
    setChecking(true);
    try {
      await refreshGroupsFromManus(post.id);
    } catch (e) {
      toast({ kind: 'error', ...errorCopy(e) });
    } finally {
      setChecking(false);
    }
  };
  const t = TONE_BLOCK[ui.tone];
  return (
    <div className={cn('flex items-start gap-2.5 rounded-pop border px-3 py-2.5', t.box)} role="status">
      <ui.icon size={16} className={cn('mt-0.5 shrink-0', t.icon, share.state === 'working' && 'animate-spin')} aria-hidden="true" />
      <div className="min-w-0 flex-1 text-small text-ink-2">
        <p className="font-medium text-ink">
          {ui.label(share.groups.length)}
          {share.state === 'done' && summary && <span className="font-normal text-ink-2">: {summary}</span>}
        </p>
        {share.state !== 'done' && share.message && <p className="mt-0.5 break-words">{share.message}</p>}
        {rec.results.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-1">
            {rec.results.map((r) => {
              const R = RESULT_UI[r.state];
              return (
                <li key={r.group} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <R.icon size={14} className={cn('shrink-0', R.cls)} aria-hidden="true" />
                  <span className="font-medium text-ink">{r.group}</span>
                  <span className={R.cls}>{R.label}</span>
                  {r.detail && (r.state === 'skipped' || r.state === 'failed') && <span className="text-muted">· {r.detail}</span>}
                  {r.url && (
                    <a href={r.url} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-0.5">
                      Open <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption">
          <a href={share.taskUrl} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-1">
            Open in Manus <ExternalLink size={12} aria-hidden="true" />
          </a>
          {(share.state === 'working' || share.state === 'needs_input' || share.state === 'finished') && (
            <button type="button" className="link inline-flex items-center gap-1 disabled:cursor-not-allowed disabled:text-faint" onClick={check} disabled={checking}>
              <RefreshCw size={12} className={cn(checking && 'animate-spin')} aria-hidden="true" /> Check now
            </button>
          )}
          {share.state === 'failed' && (
            <button type="button" className="link" onClick={() => useManusGroups.getState().open(post.id)}>
              Try again
            </button>
          )}
          <span className="num text-muted">Checked {fmtRelative(share.checkedAt)}</span>
        </div>
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
      <Users aria-hidden="true" /> Post to groups
    </button>
  );
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
            await refreshGroupsFromManus(id);
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
