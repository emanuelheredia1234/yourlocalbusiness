// "Post on <network>": the confirm window. It shows exactly what goes out, on which account, then sends one
// publish request when you confirm. One press is one attempt: there is no automatic retry, and a second press
// in the same window carries the same request id, so the server never makes a second post from it.
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Send, TriangleAlert, Type } from 'lucide-react';
import { cn } from '@/lib/utils';
import { IntegrationApiError, publishPost } from '@/lib/integrations/api';
import { useConnections } from '@/store/analytics';
import { buildPublishRequest, canPostFrom, captionPreview, newClientRequestId, targetText } from '@/lib/posting';
import { ensureJpegVariant, ensureUploaded } from '@/lib/cloud/media';
import { networkLabel } from '@/ai/postShared';
import { beginBusy, endBusy } from '@/lib/busy';
import { useStore } from '@/store/useStore';
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

/** The words for a refused request (the server's codes; never a provider's own text). */
function refusal(e: unknown, network: string): { title: string; body: string; uncertain?: boolean } {
  if (!(e instanceof IntegrationApiError)) return { title: 'Something went wrong', body: 'Nothing was sent. Try again shortly, or post it yourself.' };
  switch (e.code) {
    case 'NETWORK':
      // the request may have reached the server: pressing again in this window sends the same request id
      return { title: 'We couldn’t reach the app’s server', body: `It may not have been sent. Check ${network} before trying again: pressing Post again from this window can’t post it twice.`, uncertain: true };
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
    requestId.current = newClientRequestId();
    setBusy(false);
    setStage('');
    setErr(null);
  }, [id]);
  if (!id || !post) return null;
  const network = networkLabel(post.platform);
  const status = byPlatform[post.platform];
  const preview = captionPreview(post, project);
  const inFlight = busy || sending.has(post.id);
  const blocked = preview.blockers.length > 0 || !canPostFrom(status) || post.status === 'published';

  const confirm = async () => {
    if (inFlight || blocked) return;
    sending.add(post.id);
    beginBusy(`post-now:${post.id}`, `Posting on ${network}`, 'app');
    setBusy(true);
    setErr(null);
    try {
      // the file goes to your account's storage first (Instagram gets a JPEG copy): the server reads it there
      let mediaIds: string[] | undefined;
      if (post.media) {
        setStage('Saving the file to your account…');
        const mid = post.platform === 'instagram' && post.media.kind === 'image' ? await ensureJpegVariant(post.media.id, post.media.mime) : post.media.id;
        if (!mid || !(await ensureUploaded(mid))) {
          setErr({ title: `The ${post.media.kind} isn’t in your account yet`, body: 'Nothing was sent. Check that you’re signed in and online, then try again, or post it yourself.' });
          return;
        }
        mediaIds = [mid];
      }
      setStage(`Sending to ${network}…`);
      const latest = useStore.getState().posts.find((p) => p.id === post.id) ?? post;
      const { job } = await publishPost(buildPublishRequest(latest, project, { clientRequestId: requestId.current, mediaIds }));
      useStore.getState().applyPublishJob(post.id, job);
      close();
      if (job.state === 'queued' || job.state === 'sending') void trackJob(post.id, job.id);
    } catch (e) {
      setErr(refusal(e, network));
    } finally {
      sending.delete(post.id);
      endBusy(`post-now:${post.id}`);
      setBusy(false);
      setStage('');
    }
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
            Posts with links cost more on X.
            <InfoTip label="About X posts with links">X charges the app more for a post that has a link than for one without. It counts toward your usage.</InfoTip>
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
