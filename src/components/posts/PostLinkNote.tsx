// Where a post's link goes when it isn't in the post: the first comment to add, or the link to keep in the
// profile's bio, each with Copy. The app never comments or changes a profile by itself; Manus adds the first
// comment only when it posts the post right away.
import { Link2, MessageSquare } from 'lucide-react';
import type { LinkPlacement, Post } from '@/lib/types';
import { cn, truncate } from '@/lib/utils';
import { LINK_FACTS, LINK_PLACEMENTS, LINK_PLACEMENT_LABEL, linkMovePatch, linkText, pageLink, postPlacement } from '@/lib/pageLink';
import { networkLabel } from '@/ai/manusPost';
import { useStore } from '@/store/useStore';
import { AutoTextarea, CopyButton, Field } from '../ui/primitives';

/** "comment", or "reply" on X (the first comment there is a reply to your own post). */
const commentWord = (post: Pick<Post, 'platform'>) => (post.platform === 'x' ? 'reply' : 'comment');

/** The post's Manus try, unless it failed (a failed try never got to the comment). */
const manusTry = (post: Post) => (post.external && post.external.state !== 'failed' ? post.external : undefined);

/** Whether the owner still has to add the comment themselves (Manus isn't adding it, or didn't). */
function ownerAdds(post: Post): boolean {
  const c = manusTry(post)?.comment;
  return c?.state !== 'added' && c?.state !== 'asked';
}

/** What the first comment needs from you now. Manus's reason is its own words: shown as text, clipped. */
function commentStatus(post: Post): string {
  const word = commentWord(post);
  const ext = manusTry(post);
  const c = ext?.comment;
  if (c?.state === 'added') return 'Manus added it.';
  if (c?.state === 'failed') return `Manus couldn’t add it${c.detail ? ` (${truncate(c.detail, 120)})` : ''}. Add it yourself.`;
  if (c?.state === 'unknown') return `Check that it’s on ${networkLabel(post.platform)}. If not, add it yourself.`;
  if (c?.state === 'asked') return 'Manus adds it right after posting.';
  if (ext?.mode === 'now') return post.status === 'published' ? `Manus posted it without this ${word}: add it yourself.` : `Manus is posting it without this ${word}: add it yourself once it’s live.`;
  if (ext) return `Manus only schedules the post. Once it’s live, add this as the first ${word}.`;
  return post.status === 'published' ? `If it isn’t there yet, add this as the first ${word}.` : `Add this as the first ${word} when you post.`;
}

/** On a post card or list row: the first comment (with Copy), or the bio reminder (with Copy). Nothing when the link is in the post. */
export function PostLinkNote({ post, compact, className }: { post: Post; compact?: boolean; className?: string }) {
  const project = useStore((s) => s.projects.find((p) => p.id === post.projectId));
  const placement = postPlacement(post);
  if (!project || placement === 'post') return null;
  if (placement === 'comment') {
    const text = post.firstComment?.trim();
    if (!text) return null;
    const word = commentWord(post);
    const title = ownerAdds(post) ? `Add this as the first ${word}` : post.platform === 'x' ? 'First reply' : 'First comment';
    return (
      <div role="note" aria-label={title} className={cn('rounded-md border border-line bg-surface-2/60 px-2.5 py-2 text-[12.5px]', className)}>
        <p className="flex items-center gap-1.5 font-semibold text-ink-2">
          <MessageSquare size={13} aria-hidden="true" /> {title}
        </p>
        {!compact && <p className="clamp-2 mt-0.5 whitespace-pre-line break-words text-ink-2">{text}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="min-w-[11rem] flex-1 text-muted">{commentStatus(post)}</span>
          <CopyButton text={text} label={`Copy ${word}`} size="xs" />
        </div>
      </div>
    );
  }
  const link = pageLink(project);
  if (!link) return null;
  return (
    <div role="note" aria-label="Link in bio" className={cn('flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-2/60 px-2.5 py-1.5 text-[12.5px]', className)}>
      <Link2 size={13} aria-hidden="true" className="shrink-0 text-muted" />
      <span className="min-w-[11rem] flex-1 text-ink-2">
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
            'No link yet: add your website in Settings → Brand.'
          ) : (
            'No link yet: publish your page (Marketing → SEO page), or add your website in Settings → Brand.'
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
        <Field label={label('comment')} htmlFor={`fc-${post.id}`} hint="When Manus posts it right away, it adds this too. Otherwise, add it yourself after posting.">
          <AutoTextarea id={`fc-${post.id}`} value={post.firstComment ?? ''} onChange={(v) => onChange({ firstComment: v })} minRows={2} />
        </Field>
      )}
    </>
  );
}
