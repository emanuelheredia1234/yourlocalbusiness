// What you can do with a post besides Manus: put it on your calendar, mark it posted when you posted
// it yourself, copy its text, download its image or video, open it on the network.
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { CalendarClock, CheckCheck, Copy, Download, ExternalLink, MoreHorizontal, Trash2, Undo2 } from 'lucide-react';
import type { Post } from '@/lib/types';
import { cn, fmtDateTime } from '@/lib/utils';
import { copyText } from '@/lib/platform';
import { getBlob } from '@/lib/storage';
import { networkLabel, postText } from '@/ai/manusPost';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { Field, MenuItem, Modal, Popover, confirmAction } from '../ui/primitives';
import { download } from '../ui/download';

/** Put drafts on your calendar. Nothing posts by itself: Manus posts them, or you do. */
export function addToCalendarFlow(ids: string[]): boolean {
  const posts = useStore.getState().posts.filter((p) => ids.includes(p.id) && p.status === 'draft');
  if (!posts.length) return false;
  useStore.getState().schedulePosts(posts.map((p) => p.id));
  toast({ kind: 'success', title: posts.length > 1 ? `${posts.length} posts added to your calendar` : 'Added to your calendar', body: 'When one is due, post it with Manus, or post it yourself and mark it posted.' });
  return true;
}

/** Its last Manus try on its own network failed. Manus doesn't look for an earlier copy before posting, so that
 *  try may still have gone out (or been scheduled) before it stopped. */
export const failedOnItsNetwork = (post: Post) => post.external?.state === 'failed' && post.external.network === post.platform;

/** Manus has (or may have) the post on the network for a set time: changing it here doesn't move it there. */
export const manusHolds = (post: Post) => !!post.external && post.external.state !== 'failed';

/** When the post goes out: the time Manus scheduled it on the network, if it did, else its calendar time. */
export const goesOutAt = (post: Post) => (post.external?.state === 'scheduled' && post.external.scheduledFor ? post.external.scheduledFor : post.scheduledAt);

/** A planned post whose time has come and gone without being posted. */
export function isDue(post: Post, now = Date.now()): boolean {
  return post.status === 'scheduled' && new Date(goesOutAt(post)).getTime() <= now;
}

/** "Due" on a planned post whose time has passed (or "should be live" when Manus scheduled it there). */
export function DueBadge({ post, now }: { post: Post; now?: number }) {
  if (!isDue(post, now)) return null;
  if (post.external?.state === 'scheduled') return <span className="badge bg-good-soft text-good" title="Manus scheduled it on the network for this time. Mark it posted once you’ve seen it there.">Should be live on {networkLabel(post.platform)}</span>;
  if (post.external && post.external.state !== 'failed') return null;
  return <span className="badge bg-warn-soft text-warn" title="Its time has passed and it hasn’t been posted. Post it with Manus, or post it yourself and mark it posted.">Due</span>;
}

/** Who posted it, and the link when there is a real one. */
export function PostedBy({ post, className }: { post: Post; className?: string }) {
  if (post.status !== 'published') return null;
  const by = post.publishedBy === 'manus' ? `Posted by Manus (its report)` : post.publishedBy === 'manual' ? 'Marked as posted by you' : 'Posted';
  return (
    <p className={cn('flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted', className)}>
      <span>
        {by}
        {post.publishedAt ? ` · ${fmtDateTime(post.publishedAt)}` : ''}
      </span>
      {post.postUrl && <PostLink post={post} />}
    </p>
  );
}

export function PostLink({ post, className }: { post: Post; className?: string }) {
  if (!post.postUrl) return null;
  return (
    <a href={post.postUrl} target="_blank" rel="noopener noreferrer" className={cn('inline-flex items-center gap-1 font-semibold text-primary hover:underline', className)}>
      Open on {networkLabel(post.platform)} <ExternalLink size={11} />
    </a>
  );
}

// ───────────── Mark as posted ─────────────

export const useMarkPosted = create<{ id: string | null; open: (id: string) => void; close: () => void }>((set) => ({
  id: null,
  open: (id) => set({ id }),
  close: () => set({ id: null }),
}));

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** A link someone pasted: kept only when it's a web address. */
export function cleanPostUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function MarkPostedHost() {
  const id = useMarkPosted((s) => s.id);
  const close = useMarkPosted((s) => s.close);
  const post = useStore((s) => s.posts.find((p) => p.id === id));
  const [url, setUrl] = useState('');
  const [when, setWhen] = useState('');
  useEffect(() => {
    if (!id) return;
    setUrl('');
    setWhen(localInput(new Date()));
  }, [id]);
  if (!id || !post) return null;
  const clean = cleanPostUrl(url);
  const at = when ? new Date(when) : new Date();
  const future = at.getTime() > Date.now() + 60_000;
  const save = () => {
    if (clean === null || future || Number.isNaN(at.getTime())) return;
    useStore.getState().markPosted(post.id, { url: clean || undefined, at: at.toISOString() });
    toast({ kind: 'success', title: 'Marked as posted', body: `On ${networkLabel(post.platform)}, ${fmtDateTime(at.toISOString())}.` });
    close();
  };
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title="Mark as posted"
      subtitle={`Posted this on ${networkLabel(post.platform)} yourself? Mark it here so your calendar shows what’s really out.`}
      footer={
        <>
          <button className="btn btn-ghost btn-sm mr-auto" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" disabled={clean === null || future} onClick={save}>
            <CheckCheck size={14} /> Mark as posted
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Link to the post (optional)" htmlFor="mp-url" error={clean === null ? 'That isn’t a web address.' : undefined}>
          <input id="mp-url" className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={`https://www.${post.platform === 'x' ? 'x' : post.platform}.com/…`} inputMode="url" />
        </Field>
        <Field label="When you posted it" htmlFor="mp-when" error={future ? 'That’s in the future.' : undefined}>
          <input id="mp-when" type="datetime-local" className="input" value={when} max={localInput(new Date())} onChange={(e) => setWhen(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

// ───────────── the "More" menu on a post ─────────────

export async function downloadPostMedia(post: Post) {
  const m = post.media;
  if (!m) return;
  const blob = await getBlob(m.id);
  if (!blob) {
    toast({ kind: 'error', title: `The ${m.kind} isn’t available`, body: 'It isn’t on this device or in your account any more.' });
    return;
  }
  await download(m.name || `${post.headline || 'post'}.${m.kind === 'video' ? 'mp4' : 'png'}`, blob);
}

export function PostMoreMenu({ post, onDeleted, className }: { post: Post; onDeleted?: () => void; className?: string }) {
  const [openMenu, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const store = useStore.getState;
  const run = (fn: () => void | Promise<void>) => () => {
    setOpen(false);
    void fn();
  };
  return (
    <>
      <button ref={ref} type="button" className={cn('btn btn-ghost btn-icon btn-sm', className)} aria-label="More actions" aria-haspopup="menu" aria-expanded={openMenu} onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal size={16} />
      </button>
      <Popover open={openMenu} onClose={() => setOpen(false)} anchor={ref} className="w-60">
        {post.status !== 'published' && (
          <MenuItem icon={<CheckCheck size={15} />} onClick={run(() => useMarkPosted.getState().open(post.id))}>
            Mark as posted…
          </MenuItem>
        )}
        {post.status === 'published' && post.publishedBy === 'manual' && (
          <MenuItem
            icon={<Undo2 size={15} />}
            onClick={run(() => {
              store().unmarkPosted(post.id);
              toast({ kind: 'info', title: 'Back on your calendar', body: 'It’s marked as not posted.' });
            })}
          >
            Mark as not posted
          </MenuItem>
        )}
        <MenuItem
          icon={<Copy size={15} />}
          onClick={run(async () => {
            if (await copyText(postText(post))) toast({ kind: 'success', title: 'Post text copied' });
            else toast({ kind: 'error', title: 'Copy was blocked', body: 'Open the post and copy the text from there.' });
          })}
        >
          Copy text and hashtags
        </MenuItem>
        {post.media && (
          <MenuItem icon={<Download size={15} />} onClick={run(() => downloadPostMedia(post))}>
            Download the {post.media.kind}
          </MenuItem>
        )}
        {post.postUrl && (
          <MenuItem icon={<ExternalLink size={15} />} onClick={run(() => void window.open(post.postUrl, '_blank', 'noopener,noreferrer'))}>
            Open on {networkLabel(post.platform)}
          </MenuItem>
        )}
        {post.status === 'scheduled' && (
          <MenuItem icon={<Undo2 size={15} />} onClick={run(() => store().updatePost(post.id, { status: 'draft' }))}>
            Move back to drafts
          </MenuItem>
        )}
        {post.status === 'draft' && (
          <MenuItem icon={<CalendarClock size={15} />} onClick={run(() => void addToCalendarFlow([post.id]))}>
            Add to calendar
          </MenuItem>
        )}
        <MenuItem
          danger
          icon={<Trash2 size={15} />}
          onClick={run(async () => {
            const extra = post.status === 'published' ? ' It stays on the network: this only removes it from the app.' : post.external && post.external.state !== 'failed' ? ' If Manus already posted or scheduled it, it stays on the network.' : '';
            if (await confirmAction({ title: 'Delete this post?', body: `This can’t be undone.${extra}`, confirmLabel: 'Delete', danger: true })) {
              store().deletePosts([post.id]);
              onDeleted?.();
            }
          })}
        >
          Delete
        </MenuItem>
      </Popover>
    </>
  );
}
