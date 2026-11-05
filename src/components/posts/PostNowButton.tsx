// The one posting button a post shows, by its state and its network's connection:
//   connected, not posted      → "Post on Facebook" (opens the confirm window; nothing goes out before you confirm)
//   sending                    → "Posting…"
//   posted by the app          → "Posted" and "View post"
//   failed (nothing went out)  → "Try again" (a new confirm), or "Post it yourself"
//   unknown (may have gone out)→ "Check again" (a read-only check). Never "Try again".
//   not connected              → "Post it yourself" (copy, download, open the network, then Mark as posted)
// Manus no longer posts here; it only posts in Facebook groups (ManusGroups). Older posts sent with Manus
// show "Sent with Manus earlier", read-only.
import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, ExternalLink, Hand, Loader2, RefreshCw, Send } from 'lucide-react';
import type { Post } from '@/lib/types';
import type { ConnectionStatus } from '@/lib/integrations/types';
import { cn, fmtRelative } from '@/lib/utils';
import { IntegrationApiError, checkJob } from '@/lib/integrations/api';
import { apiHolds, canPostFrom, failureCopy, legacyManus } from '@/lib/posting';
import { networkLabel } from '@/ai/postShared';
import { useConnections } from '@/store/analytics';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { Badge, Callout, Spinner } from '../ui/primitives';
import { TONE_BADGE, TONE_BLOCK, type Tone } from './manusShared';
import { useMarkPosted } from './PostActions';
import { usePublishConfirm } from './PublishConfirm';
import { usePostItYourself } from './PostItYourselfModal';
import { announceJob } from './PublishJobWatcher';

type Size = 'sm' | 'xs';
const btn = (primary: boolean | undefined, size: Size) => cn('btn', primary ? 'btn-primary' : 'btn-secondary', size === 'xs' ? 'btn-xs' : 'btn-sm');

/** A LinkedIn post as a member (not a Page) has no automatic check: LinkedIn doesn't let the app read those. */
const noAutoCheck = (post: Post, status: ConnectionStatus | undefined) => post.platform === 'linkedin' && status?.targetKind !== 'li_org';

/** "Check again" was pressed for these jobs at these times (the server allows one check per 30 s). */
const lastCheck = new Map<string, number>();
const COOLDOWN = 30_000;

/** The read-only check on an unknown job: it never sends the post again. */
export async function checkAgain(post: Post): Promise<void> {
  const jobId = post.external?.via === 'api' ? post.external.jobId : undefined;
  if (!jobId) return;
  const at = lastCheck.get(jobId) ?? 0;
  if (Date.now() - at < COOLDOWN) return;
  lastCheck.set(jobId, Date.now());
  try {
    const { job } = await checkJob(jobId);
    useStore.getState().applyPublishJob(post.id, job);
    if (job.state === 'sent') announceJob(post.id, job);
    else if (job.state === 'unknown') toast({ kind: 'info', title: 'Still not found', body: `Check ${networkLabel(post.platform)} yourself. If it’s there, mark it as posted.` });
  } catch (e) {
    const rate = e instanceof IntegrationApiError && e.code === 'RATE_LIMITED';
    toast({ kind: 'error', title: rate ? 'Checked a moment ago' : 'Couldn’t check right now', body: rate ? 'Wait 30 seconds, then check again.' : 'Try again shortly, or check the network yourself.' });
  }
}

/** Whether "Check again" waits (pressed less than 30 s ago); re-renders when the wait is over. */
function useCooldown(jobId: string | undefined): [boolean, () => void] {
  const [, tick] = useState(0);
  const waiting = !!jobId && Date.now() - (lastCheck.get(jobId) ?? 0) < COOLDOWN;
  useEffect(() => {
    if (!waiting || !jobId) return;
    const t = setTimeout(() => tick((n) => n + 1), COOLDOWN - (Date.now() - (lastCheck.get(jobId) ?? 0)) + 50);
    return () => clearTimeout(t);
  }, [waiting, jobId]);
  return [waiting, () => tick((n) => n + 1)];
}

function CheckAgainButton({ post, size, primary }: { post: Post; size: Size; primary?: boolean }) {
  const jobId = post.external?.via === 'api' ? post.external.jobId : undefined;
  const [waiting, refresh] = useCooldown(jobId);
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={btn(primary, size)}
      disabled={waiting || busy}
      onClick={async () => {
        setBusy(true);
        await checkAgain(post);
        setBusy(false);
        refresh();
      }}
    >
      {busy ? <Spinner /> : <RefreshCw aria-hidden="true" />} Check again
    </button>
  );
}

/** The posting button for a post (see the top of this file). `primary`: the view's one filled button. */
export function PostNowButton({ post, primary, size = 'sm' }: { post: Post; primary?: boolean; size?: Size }) {
  const { byPlatform } = useConnections();
  const status = __ARTIFACT_BUILD__ ? undefined : byPlatform[post.platform];
  const connected = canPostFrom(status);
  const network = networkLabel(post.platform);
  const ext = post.external;
  if (post.status === 'published') {
    if (post.publishedBy !== 'api') return null;
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Badge tone="good">Posted</Badge>
        {post.postUrl && (
          <a href={post.postUrl} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-1 text-small">
            View post <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
      </span>
    );
  }
  // sent with Manus by an older version: only "Mark as posted"
  if (legacyManus(post) && ext?.state !== 'failed')
    return (
      <button type="button" className={btn(false, size)} onClick={() => useMarkPosted.getState().open(post.id)}>
        Mark as posted
      </button>
    );
  if (ext?.via === 'api' && ext.state === 'working')
    return (
      <button type="button" className={btn(primary, size)} disabled aria-busy="true">
        <Spinner /> Posting…
      </button>
    );
  if (ext?.via === 'api' && ext.state === 'unknown') {
    if (noAutoCheck(post, status))
      return (
        <button type="button" className={btn(false, size)} onClick={() => useMarkPosted.getState().open(post.id)}>
          Mark as posted
        </button>
      );
    return <CheckAgainButton post={post} size={size} primary={primary} />;
  }
  if (connected)
    return (
      <button type="button" className={btn(primary, size)} onClick={() => usePublishConfirm.getState().open(post.id)}>
        <Send aria-hidden="true" /> {ext?.via === 'api' && ext.state === 'failed' ? 'Try again' : `Post on ${network}`}
      </button>
    );
  return (
    <button type="button" className={btn(false, size)} onClick={() => usePostItYourself.getState().open(post.id)}>
      <Hand aria-hidden="true" /> Post it yourself
    </button>
  );
}

/** Each state's words, tone and icon (a status colour always comes with an icon and words). */
function stateUi(post: Post): { label: string; tone: Tone; icon: typeof Loader2 } | null {
  const ext = post.external;
  if (!ext) return null;
  const n = networkLabel(ext.network ?? post.platform);
  if (ext.via === 'manus') return { label: 'Sent with Manus earlier', tone: 'neutral', icon: CircleCheck };
  switch (ext.state) {
    case 'working':
      return { label: `Posting on ${n}…`, tone: 'primary', icon: Loader2 };
    case 'posted':
      return { label: `Posted on ${n}`, tone: 'good', icon: CircleCheck };
    case 'failed':
      return { label: `The ${n} post didn’t go out`, tone: 'bad', icon: CircleAlert };
    case 'unknown':
      return { label: `We couldn’t confirm the ${n} post went out`, tone: 'warn', icon: CircleAlert };
    default:
      return null;
  }
}

/** What happened to a post the app sent (or an older Manus post): a badge in rows, a block on cards. */
export function PublishStatus({ post, compact }: { post: Post; compact?: boolean }) {
  const { byPlatform } = useConnections();
  const ext = post.external;
  const ui = stateUi(post);
  if (!ext || !ui) return null;
  // posted: the post's own "Posted from the app" line says it
  if (ext.via === 'api' && ext.state === 'posted' && !compact) return null;
  const working = ext.state === 'working' && ext.via === 'api';
  if (compact)
    return (
      <span className={cn('badge', TONE_BADGE[ui.tone])} title={ext.via === 'manus' ? ext.message : undefined}>
        <ui.icon className={cn(working && 'animate-spin')} aria-hidden="true" /> {ui.label}
      </span>
    );
  const n = networkLabel(post.platform);
  const status = __ARTIFACT_BUILD__ ? undefined : byPlatform[post.platform];
  const yourself = (
    <button type="button" className="link" onClick={() => usePostItYourself.getState().open(post.id)}>
      Post it yourself
    </button>
  );
  if (ext.via === 'api' && ext.state === 'failed' && post.status !== 'published')
    return (
      <Callout tone="bad" title={ui.label}>
        <p>
          {ext.message || failureCopy({}, post.platform)} Nothing was posted.
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption">
          {canPostFrom(status) && (
            <button type="button" className="link" onClick={() => usePublishConfirm.getState().open(post.id)}>
              Try again
            </button>
          )}
          {yourself}
        </div>
      </Callout>
    );
  if (ext.via === 'api' && ext.state === 'unknown' && post.status !== 'published') {
    const manual = noAutoCheck(post, status);
    return (
      <Callout tone="warn" title={ui.label}>
        <p>{manual ? `Check your ${n} profile, then mark it as posted.` : `Check ${post.platform === 'facebook' ? 'your Facebook Page' : n} before trying anything else.`}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption">
          {!manual && <InlineCheck post={post} />}
          <button type="button" className="link" onClick={() => useMarkPosted.getState().open(post.id)}>
            Mark as posted
          </button>
          {yourself}
        </div>
      </Callout>
    );
  }
  const t = TONE_BLOCK[ui.tone];
  return (
    <div className={cn('flex items-start gap-2.5 rounded-pop border px-3 py-2.5', t.box)} role="status">
      <ui.icon size={16} className={cn('mt-0.5 shrink-0', t.icon, working && 'animate-spin')} aria-hidden="true" />
      <div className="min-w-0 flex-1 text-small text-ink-2">
        <p className="font-medium text-ink">{ui.label}</p>
        {ext.via === 'manus' && ext.message && <p className="mt-0.5 break-words">{ext.message}</p>}
        {ext.checkedAt > 0 && <p className="num mt-1 text-caption text-muted">Checked {fmtRelative(ext.checkedAt)}</p>}
      </div>
    </div>
  );
}

function InlineCheck({ post }: { post: Post }) {
  const jobId = post.external?.via === 'api' ? post.external.jobId : undefined;
  const [waiting, refresh] = useCooldown(jobId);
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="link inline-flex items-center gap-1 disabled:cursor-not-allowed disabled:text-faint"
      disabled={waiting || busy}
      onClick={async () => {
        setBusy(true);
        await checkAgain(post);
        setBusy(false);
        refresh();
      }}
    >
      <RefreshCw size={12} className={cn(busy && 'animate-spin')} aria-hidden="true" /> Check again
    </button>
  );
}

/** The app holds this post (sending, or it may have gone out): moving it or editing its time changes nothing there. */
export { apiHolds };
