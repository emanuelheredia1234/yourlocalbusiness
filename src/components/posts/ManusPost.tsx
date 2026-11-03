import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { CalendarClock, CheckCircle2, CircleAlert, ExternalLink, Hand, Loader2, RefreshCw, Send } from 'lucide-react';
import type { Post, PostPlatform } from '@/lib/types';
import { cn, fmtRelative } from '@/lib/utils';
import { useRuntime } from '@/lib/platform';
import { zapierErrorMessage } from '@/lib/zapier';
import { manusErrorMessage, manusViaServer } from '@/ai/manus';
import {
  NETWORKS,
  fmtWhen,
  localTimeZone,
  networkLabel,
  postBlocker,
  postText,
  refreshManusPost,
  rememberAccount,
  scheduleWindowError,
  startManusPost,
  suggestedAccount,
  textWarning,
  type PostMode,
} from '@/ai/manusPost';
import { useStore } from '@/store/useStore';
import { navigate } from '@/lib/router';
import { toast, useUI } from '@/store/ui';
import { Field, Modal, Segmented, Spinner } from '../ui/primitives';
import { MediaThumb } from '../media/MediaUpload';
import { PlatformChip } from './PlatformIcon';

/** Whether this view can reach Manus: claude.ai with the Zapier connector, or a server whose Manus key powers social posting. */
export function useManusReady(): boolean {
  const z = useRuntime((s) => s.zapier);
  const fb = useRuntime((s) => s.ai.routing.facebook);
  if (manusViaServer()) return !!fb?.includes('manus');
  return z === 'ready' || (__ARTIFACT_BUILD__ && z === 'checking');
}

/** What to do to post with Manus from this view. */
export function manusSetupHint(): string {
  if (!manusViaServer()) return 'Manus is reached through your Zapier connector in claude.ai, which isn’t available in this view.';
  const ai = useRuntime.getState().ai;
  if (!ai.reachable) return 'The app can’t reach its AI server right now, so it can’t send posts to Manus. Reload the page, and check that the app is running.';
  switch (ai.posting?.reason) {
    case 'no_key':
      return 'No Manus API key is saved on the server. Add it in Settings → AI → Manus (create a Manus account at manus.im first). On Replit, also add the SUPABASE_SECRET_KEY Secret so keys stay saved when the app restarts.';
    case 'not_ticked':
      return 'Your Manus key is saved, but it isn’t set to post. In Settings → AI → Manus, open its “Powers” list and tick Social posting.';
    case 'own_key_needed':
      return 'The app’s Manus key is only for its owner’s accounts. Add your own Manus API key in Settings → AI → “Use your own Manus” to post on your accounts.';
    default:
      return 'To post from here, add your Manus API key in Settings → AI (create a Manus account at manus.im first) and tick Social posting in its “Powers” list.';
  }
}

/** Show posting buttons even when Manus isn't ready, so pressing one explains what's missing. */
export function useCanOfferManus(): boolean {
  const ready = useManusReady();
  return ready || manusViaServer();
}

/** The posts waiting for you to confirm in the "Post with Manus" window. */
export const useManusPost = create<{ ids: string[]; open: (ids: string | string[]) => void; close: () => void }>((set) => ({
  ids: [],
  open: (ids) => set({ ids: [...new Set(Array.isArray(ids) ? ids : [ids])] }),
  close: () => set({ ids: [] }),
}));

const open = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');

/** Failures after which the task may exist anyway (sending again could post twice). */
const UNCERTAIN = new Set(['MANUS_CREATE_UNKNOWN', 'server_unavailable', 'upstream_error', 'cancelled']);

function errorCopy(e: unknown): { title: string; body: string; uncertain?: boolean } {
  const code = (e as { code?: string })?.code ?? 'upstream_error';
  const msg = (e as Error)?.message ?? '';
  const m = manusErrorMessage(code, msg);
  if (m) return { ...m, uncertain: UNCERTAIN.has(code) };
  const z = zapierErrorMessage(code, msg);
  // a write that failed ambiguously may still have reached Manus
  if (UNCERTAIN.has(code)) return { title: z.title, body: `${z.body} The task may still have started: check your Manus tasks before trying again.`, uncertain: true };
  return z;
}

/** Posts being handed to Manus right now (outside the window, so closing and reopening it can't send twice). */
const sending = new Set<string>();

type Progress = { stage?: string; sent?: boolean; taskUrl?: string; error?: { title: string; body: string; uncertain?: boolean } };

/** Confirm, then hand each post (its text, and its image or video) to Manus, one after another. */
export function ManusPostHost() {
  const ids = useManusPost((s) => s.ids);
  const close = useManusPost((s) => s.close);
  const allPosts = useStore((s) => s.posts);
  const posts = ids.map((id) => allPosts.find((p) => p.id === id)).filter((p): p is Post => !!p);
  const project = useStore((s) => s.projects.find((p) => p.id === posts[0]?.projectId));
  const ready = useManusReady();
  const viaServer = manusViaServer();
  const [accounts, setAccounts] = useState<Partial<Record<PostPlatform, string>>>({});
  const [mode, setMode] = useState<PostMode>('now');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const key = ids.join(',');
  useEffect(() => {
    if (!ids.length) return;
    setBusy(false);
    setProgress({});
    const s = useStore.getState();
    const list = ids.map((id) => s.posts.find((p) => p.id === id)).filter((p): p is Post => !!p);
    const proj = s.projects.find((p) => p.id === list[0]?.projectId);
    if (proj) {
      const a: Partial<Record<PostPlatform, string>> = {};
      for (const p of list) a[p.platform] ??= suggestedAccount(proj.id, p.platform, proj.brand);
      setAccounts(a);
    }
    // one post: Schedule when it's on the calendar at a time its network can schedule, else Post now.
    // several: Schedule whenever any is planned for later (the due ones wait for you), so one overdue post never
    // sends next month's posts out right away
    const later = (p: Post) => p.status === 'scheduled' && new Date(p.scheduledAt).getTime() > Date.now();
    setMode(list.length === 1 ? (later(list[0]) && !scheduleWindowError(list[0].platform, list[0].scheduledAt) ? 'schedule' : 'now') : list.some(later) ? 'schedule' : 'now');
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ids.length || !posts.length || !project) return null;

  const tz = localTimeZone();
  const networks = [...new Set(posts.map((p) => p.platform))];
  const problem = (p: Post) =>
    p.status === 'published'
      ? 'It’s already marked as posted.'
      : progress[p.id]?.error?.uncertain
        ? 'Check your Manus tasks first: this one may have started.'
        : (postBlocker(p, { viaServer }) ?? (mode === 'schedule' ? scheduleWindowError(p.platform, p.scheduledAt) : null));
  const pending = posts.filter((p) => !progress[p.id]?.sent);
  const sendable = pending.filter((p) => !problem(p));
  const laterNow = mode === 'now' && posts.length > 1 ? sendable.filter((p) => p.status === 'scheduled' && new Date(p.scheduledAt).getTime() > Date.now() + 3600_000).length : 0;
  const inFlight = busy || posts.some((p) => sending.has(p.id));
  const single = posts.length === 1;

  const confirm = async () => {
    if (inFlight || !sendable.length) return;
    setBusy(true);
    let failed = 0;
    const sentIds: string[] = [];
    for (const queued of sendable) {
      // the latest copy (it may have been edited since the window opened)
      const p = useStore.getState().posts.find((x) => x.id === queued.id);
      if (!p || sending.has(p.id)) continue;
      sending.add(p.id);
      const account = (accounts[p.platform] ?? '').trim();
      setProgress((x) => ({ ...x, [p.id]: { stage: 'Starting…' } }));
      try {
        const ext = await startManusPost(p, account, mode, (stage) => setProgress((x) => ({ ...x, [p.id]: { stage } })));
        useStore.getState().updatePost(p.id, { external: ext, status: mode === 'schedule' && p.status === 'draft' ? 'scheduled' : p.status });
        rememberAccount(project.id, p.platform, account);
        sentIds.push(p.id);
        setProgress((x) => ({ ...x, [p.id]: { sent: true, taskUrl: ext.taskUrl } }));
      } catch (e) {
        failed++;
        setProgress((x) => ({ ...x, [p.id]: { error: errorCopy(e) } }));
      } finally {
        sending.delete(p.id);
      }
    }
    setBusy(false);
    if (!failed && sentIds.length) {
      const sent = useStore.getState().posts.filter((x) => sentIds.includes(x.id));
      const where = [...new Set(sent.map((x) => networkLabel(x.platform)))].join(', ');
      const one = sent.length === 1 ? sent[0].external?.taskUrl : undefined;
      toast({
        kind: 'success',
        title: sent.length > 1 ? `${sent.length} posts sent to Manus` : 'Sent to Manus',
        body: `Manus is ${mode === 'now' ? 'posting' : 'scheduling'} ${sent.length > 1 ? 'them' : 'it'} on ${where}. Each post card shows its progress.`,
        ...(one ? { action: { label: 'Watch in Manus', run: () => open(one) } } : {}),
      });
      close();
    }
  };

  const verb = mode === 'now' ? 'Post' : 'Schedule';
  const buttonLabel = busy ? 'Sending…' : sendable.length > 1 ? `${verb} ${sendable.length} with Manus` : mode === 'now' ? 'Post now with Manus' : 'Schedule with Manus';
  const title = single ? `Post on ${networkLabel(posts[0].platform)} with Manus` : `Post ${posts.length} posts with Manus`;

  return (
    <Modal
      open
      onClose={() => !inFlight && close()}
      size="lg"
      title={title}
      subtitle="Manus opens each network in its own browser, signed in as you, and posts exactly this: the text, and the image or video."
      footer={
        <>
          <button className="btn btn-ghost btn-sm mr-auto" disabled={inFlight} onClick={close}>
            {Object.values(progress).some((x) => x.sent) ? 'Close' : 'Cancel'}
          </button>
          <button className="btn btn-primary btn-sm" disabled={inFlight || !sendable.length || !ready} onClick={confirm}>
            {busy ? <Spinner size={14} /> : <Send size={14} />} {buttonLabel}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className={cn('grid gap-3', networks.length > 1 && 'sm:grid-cols-2')}>
          {networks.map((n) => (
            <Field key={n} label={NETWORKS[n].account} htmlFor={`acct-${n}`} hint={networks.length === 1 ? `${NETWORKS[n].hint} Manus asks you if it can’t tell which one to use.` : undefined}>
              <input id={`acct-${n}`} className="input" disabled={inFlight} value={accounts[n] ?? ''} onChange={(e) => setAccounts((a) => ({ ...a, [n]: e.target.value }))} placeholder={NETWORKS[n].placeholder} />
            </Field>
          ))}
        </div>
        <div>
          <p className="label">When</p>
          <Segmented<PostMode>
            value={mode}
            onChange={(m) => !inFlight && setMode(m)}
            size="sm"
            options={[
              { id: 'now', label: 'Post now' },
              { id: 'schedule', label: single ? 'Schedule' : 'Schedule each at its time' },
            ]}
          />
          <p className="mt-2 text-[12.5px] text-muted">
            {mode === 'now' ? 'Manus posts as soon as it’s ready, usually within a few minutes.' : `Manus schedules ${single ? 'it' : 'each post'} on the network for the time on your calendar (${tz} time). Change a time in the post editor.`}
          </p>
          {laterNow > 0 && <p className="mt-1 text-[12.5px] font-medium text-warn">{laterNow} of these {laterNow === 1 ? 'is' : 'are'} planned for later: Post now sends {laterNow === 1 ? 'it' : 'them'} out right away.</p>}
        </div>
        <ul className="flex flex-col gap-3">
          {posts.map((p) => (
            <PostRow key={p.id} post={p} mode={mode} tz={tz} problem={problem(p)} progress={progress[p.id]} disabled={inFlight} onEdit={() => { close(); useUI.getState().openPostEditor(p.id); }} onRetry={() => setProgress((x) => ({ ...x, [p.id]: {} }))} />
          ))}
        </ul>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-[12.5px] text-muted">
          <li>{viaServer ? 'Each post is a Manus task on your Manus API key (its agent profile is set in Settings → AI), and uses your Manus credits.' : 'Each post is a Manus task through your Zapier connection, and uses your Manus credits.'}</li>
          <li>The first time, sign in to each network inside Manus. If Manus needs you, the post card says so, with a link.</li>
          <li>{mode === 'now' ? 'Manus posts each one once, right away, on the account you name.' : 'Manus schedules each one on the network for its time; it never publishes right away.'}</li>
          {posts.some((p) => p.media?.kind === 'video') && <li>Videos go to Manus first (through your server). Big videos take a little longer.</li>}
        </ul>
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
      </div>
    </Modal>
  );
}

function PostRow({ post, mode, tz, problem, progress, disabled, onEdit, onRetry }: { post: Post; mode: PostMode; tz: string; problem: string | null; progress?: Progress; disabled: boolean; onEdit: () => void; onRetry?: () => void }) {
  const warning = textWarning(post);
  const resend = !!post.external && post.external.state !== 'failed' && !progress?.sent;
  return (
    <li className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 rounded-md border border-line p-2.5">
      {post.media ? <MediaThumb media={post.media} className="aspect-[4/5] w-full" /> : <div className="flex aspect-[4/5] w-full items-center justify-center rounded-md border border-dashed border-line-2 px-1 text-center text-[10.5px] text-muted">Text only</div>}
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <PlatformChip platform={post.platform} />
          {mode === 'schedule' && <span className="text-xs text-muted">{fmtWhen(post.scheduledAt, tz)}</span>}
        </div>
        <p className="clamp-3 whitespace-pre-line text-[12.5px] leading-relaxed text-ink-2">{postText(post)}</p>
        {problem && (
          <p className="text-[12.5px] font-medium text-warn">
            {problem}{' '}
            <button type="button" className="font-semibold text-primary hover:underline disabled:opacity-60" disabled={disabled} onClick={onEdit}>
              {mode === 'schedule' && !postBlocker(post, { viaServer: manusViaServer() }) ? (
                <>
                  <CalendarClock size={12} className="inline" /> Change the time
                </>
              ) : (
                'Open the post'
              )}
            </button>
          </p>
        )}
        {!problem && warning && <p className="text-[12.5px] text-warn">{warning}</p>}
        {resend && <p className="text-[12.5px] font-medium text-warn">Already sent to Manus. Sending it again can post it twice.</p>}
        {progress?.stage && (
          <p className="flex items-center gap-1.5 text-[12.5px] text-info">
            <Spinner size={12} /> {progress.stage}
          </p>
        )}
        {progress?.sent && (
          <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-good">
            <CheckCircle2 size={13} /> Sent to Manus{' '}
            {progress.taskUrl && (
              <a href={progress.taskUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary hover:underline">
                Watch <ExternalLink size={11} className="inline" />
              </a>
            )}
          </p>
        )}
        {progress?.error && (
          <div className="rounded-md border border-bad/30 bg-bad-soft px-2.5 py-1.5 text-[12.5px]" role="alert">
            <p className="font-semibold text-bad">{progress.error.title}</p>
            <p className="text-ink-2">{progress.error.body}</p>
            {progress.error.uncertain && onRetry && (
              <button type="button" className="mt-1 font-semibold text-primary hover:underline disabled:opacity-60" disabled={disabled} onClick={onRetry}>
                I checked Manus: it didn’t start. Allow sending again
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

const STATE_UI: Record<NonNullable<Post['external']>['state'], { label: (n: string, mode?: PostMode) => string; cls: string; icon: typeof Loader2 }> = {
  working: { label: (n, mode) => (mode === 'now' ? `Manus is posting on ${n}` : `Manus is scheduling on ${n}`), cls: 'bg-info/10 text-info', icon: Loader2 },
  needs_input: { label: () => 'Manus needs you', cls: 'bg-warn/15 text-warn', icon: Hand },
  posted: { label: (n) => `Manus posted it on ${n}`, cls: 'bg-good-soft text-good', icon: CheckCircle2 },
  scheduled: { label: (n) => `Manus scheduled it on ${n}`, cls: 'bg-good-soft text-good', icon: CheckCircle2 },
  failed: { label: (n) => `The ${n} post didn’t go through`, cls: 'bg-bad-soft text-bad', icon: CircleAlert },
  finished: { label: () => 'Manus finished: check the result', cls: 'bg-surface-2 text-ink-2', icon: CheckCircle2 },
};

const stateUi = (ext: NonNullable<Post['external']>) => {
  const ui = STATE_UI[ext.state];
  return { ...ui, label: ui.label(networkLabel(ext.network ?? 'facebook'), ext.mode) };
};

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
      {ext.message && <p className="mt-0.5 break-words text-ink-2">{ext.message}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
        <a href={ext.taskUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
          Open in Manus <ExternalLink size={11} />
        </a>
        {(ext.state === 'working' || ext.state === 'needs_input' || ext.state === 'finished') && (
          <button type="button" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline disabled:opacity-60" onClick={check} disabled={checking}>
            <RefreshCw size={11} className={cn(checking && 'animate-spin')} /> Check now
          </button>
        )}
        {ext.state === 'failed' && post.status !== 'published' && (
          <button type="button" className="font-semibold text-primary hover:underline" onClick={() => useManusPost.getState().open(post.id)}>
            Try again
          </button>
        )}
        <span className="text-muted">Checked {fmtRelative(ext.checkedAt)}</span>
      </div>
    </div>
  );
}

/** "Post on Instagram" (or any network): Manus posts the text with its image or video. */
export function ManusPostButton({ post, size = 'sm', primary }: { post: Post; size?: 'sm' | 'xs'; primary?: boolean }) {
  const offer = useCanOfferManus();
  if (!offer || post.status === 'published') return null;
  if (post.external && post.external.state !== 'failed') return null;
  return (
    <button type="button" className={cn('btn', primary ? 'btn-primary' : 'btn-secondary', size === 'xs' ? 'btn-xs' : 'btn-sm')} onClick={() => useManusPost.getState().open(post.id)}>
      <Send size={size === 'xs' ? 12 : 14} /> Post on {networkLabel(post.platform)}
    </button>
  );
}

async function applyRefresh(postId: string) {
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
    const action = { label: 'Open in Manus', run: () => open(next.taskUrl) };
    if (next.state === 'posted') {
      toast({ kind: 'success', title: `Manus posted it on ${name}`, body: next.message, action });
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

/** Checks posts that Manus is still working on, every 45 seconds while the app is open. */
export function useManusPostWatcher() {
  useEffect(() => {
    let busy = false;
    let alive = true;
    const tick = async () => {
      if (busy || (typeof document !== 'undefined' && document.hidden)) return;
      const ids = useStore
        .getState()
        .posts.filter((p) => p.status !== 'published' && p.external && (p.external.state === 'working' || p.external.state === 'needs_input') && Date.now() - p.external.requestedAt < 3 * 24 * 3600_000)
        // least recently checked first, so a batch never starves behind tasks waiting on you
        .sort((a, b) => (a.external?.checkedAt ?? 0) - (b.external?.checkedAt ?? 0))
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
