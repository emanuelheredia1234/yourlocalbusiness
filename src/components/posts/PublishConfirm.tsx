// "Post on <network>": the confirm window. It shows exactly what goes out, on which account, then sends one
// publish request when you confirm. One press is one attempt: there is no automatic retry, and a second press
// in the same window carries the same request id, so the server never makes a second post from it.
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Send, TriangleAlert, Type } from 'lucide-react';
import { cn } from '@/lib/utils';
import { IntegrationApiError, publishPost } from '@/lib/integrations/api';
import { useConnections } from '@/store/analytics';
import { buildPublishRequest, canPostFrom, captionPreview, legacyManus, newClientRequestId, targetText } from '@/lib/posting';
import { ensureJpegVariant, ensureUploaded } from '@/lib/cloud/media';
import { networkLabel } from '@/ai/postShared';
import { beginBusy, endBusy } from '@/lib/busy';
import { useStore } from '@/store/useStore';
import type { PublishJob } from '@/lib/integrations/types';
import { Callout, InfoTip, Modal, Spinner } from '../ui/primitives';
import { MediaThumb } from '../media/MediaUpload';
import { PlatformChip } from './PlatformIcon';
import { trackJob } from './PublishJobWatcher';

export const usePublishConfirm = create<{ id: string | null; open: (id: string) => void; close: () => void }>((set) => ({
  id: null,
  open: (id) => set({ id }),
  close: () => set({ id: null }),
}));

/** Posts whose publish request is on its way right now (outside the window, so reopening it can't send twice). */
const sending = new Set<string>();

/**
 * The request id of a post whose last send ended without a definite answer (the server couldn't be reached, or
 * answered with a gateway error): it may have been sent. The next confirm for that post, even after closing and
 * reopening the window, carries the same id, so the server answers with the job it already has instead of
 * making a second post. Cleared once the server gives a definite answer.
 */
const uncertainRequest = new Map<string, string>();

/** The request id for a new opening of the window: the uncertain one if there is one, else a fresh one. */
export const requestIdFor = (postId: string) => uncertainRequest.get(postId) ?? newClientRequestId();

/** No definite answer: the server may have taken the request (it can't be reached, or a gateway timed out). */
export const mayHaveBeenSent = (e: unknown) => e instanceof IntegrationApiError && (e.code === 'NETWORK' || (e.status >= 500 && e.code === 'UNAVAILABLE'));

/** The words for a refused request (the server's codes; never a provider's own text). */
function refusal(e: unknown, network: string): { title: string; body: string; uncertain?: boolean } {
  if (!(e instanceof IntegrationApiError)) return { title: 'Something went wrong', body: 'Nothing was sent. Try again shortly, or post it yourself.' };
  if (mayHaveBeenSent(e))
    // the request may have reached the server: pressing again sends the same request id
    return { title: 'We couldn’t confirm it was sent', body: `It may have gone out. Check ${network} before trying again: pressing Post again can’t post it twice.`, uncertain: true };
  switch (e.code) {
    case 'ALREADY_PUBLISHING':
      return { title: 'Already posting', body: `This post is already going out on ${network}. Close this and watch its card.` };
    case 'POST_CHANGED':
      return { title: 'The post changed', body: 'Save your changes, then open this again.' };
    case 'MEDIA_UNSUPPORTED':
      return { title: `${network} can’t take this file`, body: e.message };
    case 'NOT_CONNECTED':
    case 'NEEDS_RECONNECT':
    case 'CONNECTIONS_NOT_ENABLED':
      return { title: `${network} isn’t connected`, body: 'Reconnect it in Settings › Connected accounts, or post it yourself.' };
    case 'CUSTOMER_CAP':
    case 'PLATFORM_LIMIT':
      return { title: 'Posting limit reached', body: `${e.message} You can still post it yourself.` };
    case 'RATE_LIMITED':
      return { title: 'Too many posts at once', body: 'Wait a few minutes, then try again.' };
    default:
      return { title: 'It wasn’t sent', body: e.message };
  }
}

export type SendOutcome = { ok: true; job: PublishJob } | { ok: false; error: { title: string; body: string; uncertain?: boolean } };

/**
 * One confirm: save the file to the account, then ONE publish request with this window's request id. Never
 * retried here. A post already on its way returns without sending.
 */
export async function sendPublish(postId: string, requestId: string, onStage: (s: string) => void = () => {}): Promise<SendOutcome | null> {
  const post = useStore.getState().posts.find((p) => p.id === postId);
  if (!post || sending.has(postId)) return null;
  const project = useStore.getState().projects.find((p) => p.id === post.projectId);
  const network = networkLabel(post.platform);
  sending.add(postId);
  beginBusy(`post-now:${postId}`, `Posting on ${network}`, 'app');
  try {
    // the file goes to your account's storage first (Instagram gets a JPEG copy): the server reads it there
    let mediaIds: string[] | undefined;
    if (post.media) {
      onStage('Saving the file to your account…');
      const mid = post.platform === 'instagram' && post.media.kind === 'image' ? await ensureJpegVariant(post.media.id, post.media.mime) : post.media.id;
      if (!mid || !(await ensureUploaded(mid))) return { ok: false, error: { title: `The ${post.media.kind} isn’t in your account yet`, body: 'Nothing was sent. Check that you’re signed in and online, then try again, or post it yourself.' } };
      mediaIds = [mid];
    }
    onStage(`Sending to ${network}…`);
    const latest = useStore.getState().posts.find((p) => p.id === postId) ?? post;
    try {
      const { job } = await publishPost(buildPublishRequest(latest, project, { clientRequestId: requestId, mediaIds }));
      uncertainRequest.delete(postId);
      useStore.getState().applyPublishJob(postId, job);
      if (job.state === 'queued' || job.state === 'sending') void trackJob(postId, job.id);
      return { ok: true, job };
    } catch (e) {
      if (mayHaveBeenSent(e)) uncertainRequest.set(postId, requestId);
      else uncertainRequest.delete(postId);
      return { ok: false, error: refusal(e, network) };
    }
  } catch {
    return { ok: false, error: refusal(null, network) };
  } finally {
    sending.delete(postId);
    endBusy(`post-now:${postId}`);
  }
}

export function PublishConfirmHost() {
  const id = usePublishConfirm((s) => s.id);
  const close = usePublishConfirm((s) => s.close);
  const post = useStore((s) => s.posts.find((p) => p.id === id));
  const project = useStore((s) => s.projects.find((p) => p.id === post?.projectId));
  const { byPlatform } = useConnections();
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [err, setErr] = useState<ReturnType<typeof refusal> | null>(null);
  // one request id per opening of the window: a second press (after a network error) is the same request
  const requestId = useRef('');
  useEffect(() => {
    if (!id) return;
    requestId.current = requestIdFor(id);
    setBusy(false);
    setStage('');
    setErr(null);
  }, [id]);
  if (!id || !post) return null;
  const network = networkLabel(post.platform);
  const status = byPlatform[post.platform];
  const preview = captionPreview(post, project);
  const inFlight = busy || sending.has(post.id);
  const legacy = legacyManus(post);
  const blocked = preview.blockers.length > 0 || !canPostFrom(status) || post.status === 'published' || legacy;

  const confirm = async () => {
    if (inFlight || blocked) return;
    setBusy(true);
    setErr(null);
    const r = await sendPublish(post.id, requestId.current, setStage);
    setBusy(false);
    setStage('');
    if (!r) return;
    if (r.ok) close();
    else setErr(r.error);
  };

  const word = post.platform === 'x' ? 'reply' : 'comment';
  return (
    <Modal
      open
      onClose={() => !inFlight && close()}
      size="md"
      title={`Post on ${network}`}
      subtitle={`It goes out once, right away, on ${targetText(status, post.platform)}.`}
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" disabled={inFlight} onClick={close}>
            Cancel
          </button>
          <button type="button" className={cn('btn btn-primary btn-sm')} disabled={inFlight || blocked} aria-busy={busy || undefined} onClick={() => void confirm()}>
            {busy ? <Spinner /> : <Send aria-hidden="true" />} {busy ? stage || 'Posting…' : `Post on ${network}`}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex gap-3">
          {post.media ? (
            <MediaThumb media={post.media} className="h-16 w-16 shrink-0" />
          ) : (
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted ring-1 ring-inset ring-line" title="Text only">
              <Type size={20} aria-hidden="true" />
              <span className="sr-only">Text only</span>
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <PlatformChip platform={post.platform} />
              <span className="min-w-0 truncate text-small text-muted">{targetText(status, post.platform)}</span>
            </div>
            <p className="text-small text-muted">{post.media ? (post.media.kind === 'video' ? 'With the video' : 'With the image') : 'Text only'}</p>
          </div>
        </div>
        <div>
          <p className="label">What goes out</p>
          <p className="max-h-60 overflow-y-auto whitespace-pre-line break-words rounded-md border border-line bg-surface-2 px-3 py-2.5 text-small text-ink" data-testid="publish-text">
            {preview.text}
          </p>
          {preview.droppedTags > 0 && (
            <p className="mt-1.5 text-small text-muted">
              {preview.droppedTags} hashtag{preview.droppedTags === 1 ? '' : 's'} left out to fit {network}.
            </p>
          )}
        </div>
        {preview.firstComment && (
          <div>
            <p className="label">First {word}</p>
            <p className="whitespace-pre-line break-words text-small text-ink-2">{preview.firstComment}</p>
            <p className="mt-1 text-small text-muted">The app adds it right after posting. If it can’t, the post stays up and you can add it yourself.</p>
          </div>
        )}
        {preview.commentYourself && <p className="text-small text-muted">{preview.commentYourself}</p>}
        {preview.linkNote && <p className="text-small text-muted">{preview.linkNote}</p>}
        {preview.xLinkCost && (
          <p className="flex items-center gap-1 text-small text-muted">
            The link may not show on X.
            <InfoTip label="About X posts with links">Links on X go through a small monthly allowance the app shares across everyone. Once it’s used up, X gets the post without the link. Put the link in your X bio to be sure.</InfoTip>
          </p>
        )}
        {status?.state === 'limited' && status.limitedReason === 'private_only' && (
          <p className="flex items-start gap-1.5 text-small text-warn">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            It goes out as private until TikTok approves this app. Only you can see it.
          </p>
        )}
        {preview.blockers.map((b) => (
          <p key={b} className="flex items-start gap-1.5 text-small font-medium text-warn">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            {b}
          </p>
        ))}
        {legacy && (
          <Callout tone="warn" title="Sent with Manus earlier">
            It may already be out on {network}. Check there, then mark it as posted. The app doesn’t send it again.
          </Callout>
        )}
        {!canPostFrom(status) && (
          <Callout tone="warn" title={`${network} isn’t connected`}>
            Connect it in Settings › Connected accounts, or post it yourself.
          </Callout>
        )}
        {err && (
          <Callout tone={err.uncertain ? 'warn' : 'bad'} title={err.title}>
            {err.body}
          </Callout>
        )}
      </div>
    </Modal>
  );
}
