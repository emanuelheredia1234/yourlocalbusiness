// Where a post's link goes when it isn't in the post: the first comment to add, or the link to keep in the
// profile's bio, each with Copy. The app adds the first comment when your account is connected; otherwise add it
// yourself. The app never changes a profile.
import { Link2, MessageSquare } from 'lucide-react';
import type { LinkPlacement, Post } from '@/lib/types';
import { cn, truncate } from '@/lib/utils';
import { LINK_FACTS, LINK_PLACEMENTS, LINK_PLACEMENT_LABEL, linkMovePatch, linkText, pageLink, postPlacement } from '@/lib/pageLink';
import { networkLabel } from '@/ai/postShared';
import { canPostFrom } from '@/lib/posting';
import { useConnections } from '@/store/analytics';
import { useStore } from '@/store/useStore';
import { AutoTextarea, CopyButton, Field } from '../ui/primitives';

/** "comment", or "reply" on X (the first comment there is a reply to your own post). */
const commentWord = (post: Pick<Post, 'platform'>) => (post.platform === 'x' ? 'reply' : 'comment');

/** The post's last try, unless it failed (a failed try never got to the comment). */
const lastTry = (post: Post) => (post.external && post.external.state !== 'failed' ? post.external : undefined);

/** Whether the owner still has to add the comment themselves. */
function ownerAdds(post: Post, connected: boolean): boolean {
  const ext = lastTry(post);
  if (ext?.via === 'manus') return ext.comment?.state !== 'added';
  if (ext?.via === 'api') return ext.state !== 'working';
  return !connected || post.platform === 'tiktok';
}

/** What the first comment needs from you now (an older Manus report is its own words: shown as text, clipped). */
function commentStatus(post: Post, connected: boolean): string {
  const word = commentWord(post);
  const name = networkLabel(post.platform);
  const ext = lastTry(post);
  if (ext?.via === 'manus') {
    const c = ext.comment;
    if (c?.state === 'added') return 'It was added with the post (sent with Manus earlier).';
    if (c?.state === 'failed') return `It wasn’t added${c.detail ? ` (${truncate(c.detail, 120)})` : ''}. Add it yourself.`;
    return `Check that it’s on ${name}. If not, add it yourself.`;
  }
  if (ext?.via === 'api') return ext.state === 'working' ? 'The app adds it right after posting.' : `Check that it’s on ${name}. If not, add it yourself.`;
  if (post.status === 'published') return `If it isn’t there yet, add this as the first ${word}.`;
  if (post.platform === 'tiktok') return `Add this as the first ${word} in TikTok after posting.`;
  return connected ? `The app adds it when it posts this. Otherwise add it yourself.` : `Add this as the first ${word} when you post.`;
}

/**
 * On a post card (a well with the comment's text) or a list row (`compact`: one quiet line): the first
 * comment to add (with Copy), or the bio reminder (with Copy). Nothing when the link is in the post.
 */
export function PostLinkNote({ post, compact, className }: { post: Post; compact?: boolean; className?: string }) {
  const project = useStore((s) => s.projects.find((p) => p.id === post.projectId));
  const { byPlatform } = useConnections();
  const connected = !__ARTIFACT_BUILD__ && canPostFrom(byPlatform[post.platform]);
  const placement = postPlacement(post);
  if (!project || placement === 'post') return null;
  if (placement === 'comment') {
    const text = post.firstComment?.trim();
    if (!text) return null;
    const word = commentWord(post);
    const title = ownerAdds(post, connected) ? `Add this as the first ${word}` : post.platform === 'x' ? 'First reply' : 'First comment';
    if (compact)
      return (
        <div role="note" aria-label={title} className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-small', className)}>
          <p className="flex min-w-0 items-center gap-1.5 font-medium text-ink-2">
            <MessageSquare size={14} aria-hidden="true" className="shrink-0 text-muted" /> {title}
          </p>
          <span className="min-w-0 flex-1 truncate text-muted">{commentStatus(post, connected)}</span>
          <CopyButton text={text} label={`Copy ${word}`} size="xs" />
        </div>
      );
    return (
      <div role="note" aria-label={title} className={cn('well px-3 py-2.5 text-small', className)}>
        <p className="flex items-center gap-1.5 font-medium text-ink">
          <MessageSquare size={14} aria-hidden="true" className="shrink-0 text-muted" /> {title}
        </p>
        <p className="clamp-2 mt-1 whitespace-pre-line break-words text-ink-2">{text}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="min-w-[11rem] flex-1 text-caption text-muted">{commentStatus(post, connected)}</span>
          <CopyButton text={text} label={`Copy ${word}`} size="xs" />
        </div>
      </div>
    );
  }
  const link = pageLink(project);
  if (!link) return null;
  return (
    <div role="note" aria-label="Link in bio" className={cn('flex min-w-0 items-center gap-2 text-small', compact ? '' : 'well flex-wrap px-3 py-2', className)}>
      <Link2 size={14} aria-hidden="true" className="shrink-0 text-muted" />
      <span className={cn('min-w-0 flex-1 text-ink-2', compact ? 'truncate' : 'min-w-[11rem]')}>
        Link in bio: keep <span className="font-medium [overflow-wrap:anywhere]">{linkText(link.url)}</span> in your {networkLabel(post.platform)} bio.
      </span>
      <CopyButton text={link.url} label="Copy link" size="xs" />
    </div>
  );
}

/** In the post editor: where the link goes, and the first comment's text. */
export function LinkFields({ post, onChange }: { post: Post; onChange: (patch: Partial<Post>) => void }) {
  const project = useStore((s) => s.projects.find((p) => p.id === post.projectId));
  if (!project) return null;
  const link = pageLink(project);
  const placement = postPlacement(post);
  // the comment's text stays when you switch away and back (it's only used while the link goes there)
  const move = (next: LinkPlacement) => onChange(linkMovePatch(project, post, next));
  const label = (id: LinkPlacement) => (id === 'comment' && post.platform === 'x' ? 'First reply' : LINK_PLACEMENT_LABEL[id]);
  return (
    <>
      <Field
        label="Where the link goes"
        htmlFor={`lp-${post.id}`}
        hint={
          link ? (
            <>
              {LINK_FACTS[post.platform]} Your link: <span className="[overflow-wrap:anywhere]">{linkText(link.url)}</span>
            </>
          ) : __ARTIFACT_BUILD__ ? (
            'No link yet: add your website in Settings › Brand.'
          ) : (
            'No link yet: publish your page (Marketing › SEO page), or add your website in Settings › Brand.'
          )
        }
      >
        <select id={`lp-${post.id}`} className="select" value={placement} disabled={!link} onChange={(e) => move(e.target.value as LinkPlacement)}>
          {LINK_PLACEMENTS.map((id) => (
            <option key={id} value={id}>
              {label(id)}
            </option>
          ))}
        </select>
      </Field>
      {placement === 'comment' && (
        <Field label={label('comment')} htmlFor={`fc-${post.id}`} hint="The app adds this right after posting when your account is connected. Otherwise, add it yourself after posting.">
          <AutoTextarea id={`fc-${post.id}`} value={post.firstComment ?? ''} onChange={(v) => onChange({ firstComment: v })} minRows={2} />
        </Field>
      )}
    </>
  );
}
