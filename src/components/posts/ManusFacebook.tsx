import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { CalendarClock, CheckCircle2, CircleAlert, ExternalLink, Hand, Loader2, RefreshCw, Send } from 'lucide-react';
import type { Post } from '@/lib/types';
import { cn, fmtRelative } from '@/lib/utils';
import { safeStorage } from '@/lib/storage';
import { useRuntime } from '@/lib/platform';
import { zapierErrorMessage } from '@/lib/zapier';
import { manusErrorMessage, manusViaServer } from '@/ai/manus';
import { FB_PAGE_KEY, fbScheduleWindowError, fmtWhen, localTimeZone, postText, refreshFacebookSchedule, startFacebookPost, type FbMode } from '@/ai/manusFacebook';
import { useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { Field, Modal, Segmented, Spinner } from '../ui/primitives';
import { MediaThumb } from '../media/MediaUpload';

/** Whether this view can reach Manus: claude.ai with the Zapier connector, or a server whose Manus key powers Facebook posting. */
export function useManusReady(): boolean {
  const z = useRuntime((s) => s.zapier);
  const fb = useRuntime((s) => s.ai.routing.facebook);
  if (manusViaServer()) return !!fb?.includes('manus');
  return z === 'ready' || (__ARTIFACT_BUILD__ && z === 'checking');
}

export const useManusFb = create<{ postId: string | null; open: (id: string) => void; close: () => void }>((set) => ({
  postId: null,
  open: (postId) => set({ postId }),
  close: () => set({ postId: null }),
}));

const open = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');

function errorCopy(e: unknown): { title: string; body: string } {
  const code = (e as { code?: string })?.code ?? 'upstream_error';
  const msg = (e as Error)?.message ?? '';
  const m = manusErrorMessage(code, msg);
  if (m) return m;
  const z = zapierErrorMessage(code, msg);
  // a write that failed ambiguously may still have reached Manus
  if (code === 'server_unavailable' || code === 'upstream_error' || code === 'cancelled') return { title: z.title, body: `${z.body} The task may still have started: check your Manus tasks before trying again.` };
  return z;
}

/** Posts being handed to Manus right now (outside the window, so closing and reopening it can't send twice). */
const sending = new Set<string>();

/** Confirm, then hand one post (caption plus image or video) to Manus to post on Facebook. */
export function ManusFacebookHost() {
  const id = useManusFb((s) => s.postId);
  const close = useManusFb((s) => s.close);
  const post = useStore((s) => s.posts.find((p) => p.id === id));
  const project = useStore((s) => s.projects.find((p) => p.id === post?.projectId));
  const fbHandle = useStore((s) => s.settings.accounts.facebook?.handle ?? '');
  const ready = useManusReady();
  const [page, setPage] = useState('');
  const [mode, setMode] = useState<FbMode>('now');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [err, setErr] = useState<{ title: string; body: string } | null>(null);
  useEffect(() => {
    if (!id) return;
    setErr(null);
    setBusy(false);
    setStage('');
    setPage(safeStorage.getItem(FB_PAGE_KEY) || fbHandle || project?.brand.name || '');
    // a post already set for a time Facebook can schedule starts on Schedule; anything else posts now
    const p = useStore.getState().posts.find((x) => x.id === id);
    setMode(p && p.status === 'scheduled' && !fbScheduleWindowError(p.scheduledAt) ? 'schedule' : 'now');
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!id || !post || !project) return null;
  const windowError = mode === 'schedule' ? fbScheduleWindowError(post.scheduledAt) : null;
  const tz = localTimeZone();
  const resend = !!post.external && post.external.state !== 'failed';
  const media = post.media ?? null;

  const confirm = async () => {
    if (sending.has(post.id)) return;
    sending.add(post.id);
    setBusy(true);
    setErr(null);
    try {
      const ext = await startFacebookPost(post, page.trim(), mode, setStage);
      useStore.getState().updatePost(post.id, { external: ext, status: mode === 'schedule' && post.status === 'draft' ? 'scheduled' : post.status });
      safeStorage.setItem(FB_PAGE_KEY, page.trim());
      toast({ kind: 'success', title: 'Sent to Manus', body: mode === 'now' ? 'Manus is posting it on your Facebook Page. The post card shows its progress.' : 'Manus is scheduling it on your Facebook Page. The post card shows its progress.', action: { label: 'Watch in Manus', run: () => open(ext.taskUrl) } });
      close();
    } catch (e) {
      setErr(errorCopy(e));
    } finally {
      sending.delete(post.id);
      setBusy(false);
      setStage('');
    }
  };
  const inFlight = busy || sending.has(post.id);

  return (
    <Modal
      open
      onClose={() => !busy && close()}
      size="lg"
      title="Post on Facebook with Manus"
      subtitle="Manus opens Facebook in its own browser and posts exactly this on your Page: the caption, and the image or video."
      footer={
        <>
          <button className="btn btn-ghost btn-sm mr-auto" disabled={busy} onClick={close}>
            Cancel
          </button>
          {windowError && (
            <button
              className="btn btn-secondary btn-sm"
              disabled={inFlight}
              onClick={() => {
                close();
                useUI.getState().openPostEditor(post.id);
              }}
            >
              <CalendarClock size={14} /> Change the time
            </button>
          )}
          <button className="btn btn-primary btn-sm" disabled={inFlight || !!windowError || !ready} onClick={confirm}>
            {busy ? <Spinner size={14} /> : <Send size={14} />} {busy && stage ? stage : resend ? 'Send to Manus again' : mode === 'now' ? 'Post now with Manus' : 'Schedule with Manus'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_220px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Field label="Facebook Page" htmlFor="fb-page" hint="The Page name as it appears on Facebook. Manus asks you if it can’t tell which Page to use.">
            <input id="fb-page" className="input" disabled={inFlight} value={page} onChange={(e) => setPage(e.target.value)} placeholder="Your business Page name" />
          </Field>
          <div>
            <p className="label">When</p>
            <Segmented<FbMode>
              value={mode}
              onChange={(m) => !inFlight && setMode(m)}
              size="sm"
              options={[
                { id: 'now', label: 'Post now' },
                { id: 'schedule', label: 'Schedule' },
              ]}
            />
            {mode === 'schedule' ? (
              <>
                <p className="mt-2 text-[14px] font-semibold text-ink">{fmtWhen(post.scheduledAt, tz)}</p>
                <p className="text-xs text-muted">{tz} time (the post’s time; change it in the post editor)</p>
                {windowError && <p className="mt-1 text-[12.5px] font-medium text-warn">{windowError}</p>}
              </>
            ) : (
              <p className="mt-2 text-[12.5px] text-muted">Manus posts it as soon as it’s ready, usually within a few minutes.</p>
            )}
          </div>
          <div>
            <p className="label">Post text</p>
            <p className="max-h-48 overflow-y-auto whitespace-pre-line rounded-md border border-line bg-surface-2/50 p-3 text-[13px] leading-relaxed text-ink-2">{postText(post)}</p>
          </div>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[12.5px] text-muted">
            <li>{manusViaServer() ? 'It’s a Manus task with your Manus API key (its agent profile is set in Settings → AI), and uses your Manus credits.' : 'It’s a Manus task through your Zapier connection, and uses your Manus credits.'}</li>
            <li>The first time, sign in to Facebook inside Manus. If Manus needs you, the post card says so, with a link.</li>
            <li>{mode === 'now' ? 'Manus posts it once, right away, on the Page you name.' : 'Manus schedules it for that time; it never publishes right away.'}</li>
            {media?.kind === 'video' && <li>The video goes to Manus first (through your server). Big videos take a little longer.</li>}
          </ul>
          {resend && <p className="text-[12.5px] font-medium text-warn">This post was already sent to Manus. Sending it again can post it twice.</p>}
          {!ready && (
            <p className="text-[12.5px] font-medium text-warn">
              {manusViaServer() ? 'Add your Manus API key in Settings → AI (create a Manus account at manus.im first). If you manage the app’s keys, also tick Facebook posting in the key’s “Powers” list.' : 'Manus is reached through your Zapier connector in claude.ai, which isn’t available in this view.'}
            </p>
          )}
          {err && (
            <div className="rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-[12.5px]" role="alert">
              <p className="font-semibold text-bad">{err.title}</p>
              <p className="text-ink-2">{err.body}</p>
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="label">{media?.kind === 'video' ? 'Video' : 'Image'}</p>
          {media ? <MediaThumb media={media} className="aspect-[4/5] w-full" /> : <p className="rounded-md border border-dashed border-line-2 p-3 text-xs text-muted">No image or video: this will be a text-only post.</p>}
        </div>
      </div>
    </Modal>
  );
}

const STATE_UI: Record<NonNullable<Post['external']>['state'], { label: string; cls: string; icon: typeof Loader2 }> = {
  working: { label: 'Manus is scheduling on Facebook', cls: 'bg-info/10 text-info', icon: Loader2 },
  needs_input: { label: 'Manus needs you', cls: 'bg-warn/15 text-warn', icon: Hand },
  posted: { label: 'Posted on Facebook', cls: 'bg-good-soft text-good', icon: CheckCircle2 },
  scheduled: { label: 'Scheduled on Facebook', cls: 'bg-good-soft text-good', icon: CheckCircle2 },
  failed: { label: 'Facebook post failed', cls: 'bg-bad-soft text-bad', icon: CircleAlert },
  finished: { label: 'Manus finished: check the result', cls: 'bg-surface-2 text-ink-2', icon: CheckCircle2 },
};

/** The badge for a post's Facebook status (posting right away reads differently from scheduling). */
const stateUi = (ext: NonNullable<Post['external']>) => (ext.state === 'working' && ext.mode === 'now' ? { ...STATE_UI.working, label: 'Manus is posting on Facebook' } : STATE_UI[ext.state]);

/** Live status of a post handed to Manus. */
export function ExternalBadge({ post, compact }: { post: Post; compact?: boolean }) {
  const ext = post.external;
  const [checking, setChecking] = useState(false);
  if (!ext) return null;
  const ui = stateUi(ext);
  const check = async () => {
    setChecking(true);
    try {
      await applyRefresh(post.id);
    } catch (e) {
      toast({ kind: 'error', ...errorCopy(e) });
    } finally {
      setChecking(false);
    }
  };
  if (compact) {
    return (
      <span className={cn('badge inline-flex items-center gap-1', ui.cls)} title={ext.message}>
        <ui.icon size={11} className={cn(ext.state === 'working' && 'animate-spin')} /> {ui.label}
      </span>
    );
  }
  return (
    <div className={cn('rounded-md px-2.5 py-2 text-[12.5px]', ui.cls)} role="status">
      <p className="flex items-center gap-1.5 font-semibold">
        <ui.icon size={13} className={cn(ext.state === 'working' && 'animate-spin')} /> {ui.label}
      </p>
      {ext.message && <p className="mt-0.5 text-ink-2">{ext.message}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
        <a href={ext.taskUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
          Open in Manus <ExternalLink size={11} />
        </a>
        {(ext.state === 'working' || ext.state === 'needs_input' || ext.state === 'finished') && (
          <button type="button" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline disabled:opacity-60" onClick={check} disabled={checking}>
            <RefreshCw size={11} className={cn(checking && 'animate-spin')} /> Check now
          </button>
        )}
        {ext.state === 'failed' && (
          <button type="button" className="font-semibold text-primary hover:underline" onClick={() => useManusFb.getState().open(post.id)}>
            Try again
          </button>
        )}
        <span className="text-muted">Checked {fmtRelative(ext.checkedAt)}</span>
      </div>
    </div>
  );
}

/** "Post on Facebook" for a Facebook post: Manus posts its caption with its image or video. */
export function ManusFacebookButton({ post, size = 'sm' }: { post: Post; size?: 'sm' | 'xs' }) {
  const ready = useManusReady();
  if (!ready || post.platform !== 'facebook' || post.status === 'published') return null;
  // a video post needs its video first (a storyboard alone can't be posted)
  if (post.format === 'video' && post.media?.kind !== 'video') return null;
  // videos go to Manus through your server (not available in the claude.ai version)
  if (post.media?.kind === 'video' && !manusViaServer()) return null;
  if (post.external && post.external.state !== 'failed') return null;
  return (
    <button type="button" className={cn('btn btn-secondary', size === 'xs' ? 'btn-xs' : 'btn-sm')} onClick={() => useManusFb.getState().open(post.id)}>
      <Send size={size === 'xs' ? 12 : 14} /> Post on Facebook
    </button>
  );
}

async function applyRefresh(postId: string) {
  const post = useStore.getState().posts.find((p) => p.id === postId);
  if (!post?.external) return;
  const prev = post.external;
  const next = await refreshFacebookSchedule(prev);
  // posted for real: the post is published (on Facebook, by Manus)
  if (next.state === 'posted' && prev.state !== 'posted') useStore.getState().updatePost(postId, { external: next, status: 'published', publishedAt: new Date().toISOString() });
  else useStore.getState().updatePost(postId, { external: next });
  if (next.state !== prev.state) {
    if (next.state === 'posted') {
      toast({ kind: 'success', title: 'Posted on Facebook', body: next.message, action: { label: 'Open in Manus', run: () => open(next.taskUrl) } });
      useStore.getState().notify({ kind: 'post', title: 'Manus posted it on your Facebook Page', body: post.headline, route: 'calendar' });
    } else if (next.state === 'scheduled') {
      toast({ kind: 'success', title: 'Scheduled on Facebook', body: next.message, action: { label: 'Open in Manus', run: () => open(next.taskUrl) } });
      useStore.getState().notify({ kind: 'post', title: 'Manus scheduled your Facebook post', body: post.headline, route: 'calendar' });
    } else if (next.state === 'needs_input') {
      toast({ kind: 'info', title: 'Manus needs you', body: next.message, action: { label: 'Open in Manus', run: () => open(next.taskUrl) } });
      useStore.getState().notify({ kind: 'info', title: 'Manus needs you to continue', body: next.message, route: 'calendar' });
    } else if (next.state === 'failed') {
      toast({ kind: 'error', title: 'The Facebook post didn’t go through', body: next.message, action: { label: 'Open in Manus', run: () => open(next.taskUrl) } });
    } else if (next.state === 'finished') {
      toast({ kind: 'info', title: 'Manus finished', body: `Open the task to confirm the post was ${next.mode === 'now' ? 'posted' : 'scheduled'}.`, action: { label: 'Open in Manus', run: () => open(next.taskUrl) } });
    }
  }
}

/** Checks posts that Manus is still working on, every 45 seconds while the app is open. */
export function useManusScheduleWatcher() {
  useEffect(() => {
    let busy = false;
    let alive = true;
    const tick = async () => {
      if (busy || (typeof document !== 'undefined' && document.hidden)) return;
      const ids = useStore
        .getState()
        .posts.filter((p) => p.external && (p.external.state === 'working' || p.external.state === 'needs_input') && Date.now() - p.external.requestedAt < 3 * 24 * 3600_000)
        .map((p) => p.id)
        .slice(0, 3);
      if (!ids.length) return;
      busy = true;
      try {
        for (const id of ids) {
          if (!alive) return;
          try {
            await applyRefresh(id);
          } catch {
            /* transient: try again on the next tick */
          }
        }
      } finally {
        busy = false;
      }
    };
    const first = setTimeout(tick, 4000);
    const t = setInterval(tick, 45_000);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
}
