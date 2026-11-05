import { useMemo, useState, type ReactNode } from 'react';
import { CalendarClock, Check, CheckCheck, Hand, Pencil, Send, Trash2, TriangleAlert, Undo2, Users } from 'lucide-react';
import type { Brand, Post, PostPlatform, PostType, StyleId } from '@/lib/types';
import { cn, fmtDateTime, fmtRelative } from '@/lib/utils';
import { IMAGE_STYLES, PLATFORMS, POST_PLATFORMS, POST_TYPES, POST_TYPE_MAP, STYLE_LABEL, VIDEO_STYLES, isVideoStyle } from '@/ai/knowledge';
import { useNow, useMediaQuery } from '@/lib/hooks';
import { useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { postTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { PostVisual, pointsFromCaption } from '../visuals/PostVisual';
import { PlatformMark } from './PlatformIcon';
import { AutoTextarea, Badge, Callout, Checkbox, ChipInput, DateTimeButton, Field, Modal, MoreMenu, StatusDot, confirmAction, type MenuEntry } from '../ui/primitives';
import { AIThinking, Spark } from '../ai/AI';
import { PhoneFrame, PostFrame } from '../frames/Frames';
import { LogoMark } from '../brand/Logo';
import { ManusLink, PostImagePanel } from '../images/PostImagePanel';
import { VideoPanel } from '../images/VideoPanel';
import { useImageJob } from '../images/useImageJob';
import { useCanOfferManus } from './manusShared';
import { PostNowButton, PublishStatus } from './PostNowButton';
import { GroupShareBadge, useManusGroups } from './ManusGroups';
import { DueBadge, PostedBy, addToCalendarFlow, isDue, postHeld, postMenuEntries, useMarkPosted } from './PostActions';
import { postVideoPrompt } from '@/ai/image';
import { makePostImage, rewriteInput, rewritePatch } from '@/ai/socialPosts';
import { brandHandle } from '@/lib/brandMark';
import { isOwnPhoto } from '@/lib/media';
import { firstCommentOf, networkMovePatch, xLength } from '@/lib/pageLink';
import { networkLabel, postText } from '@/ai/postShared';
import { canPostFrom } from '@/lib/posting';
import { useConnections } from '@/store/analytics';
import { usePublishConfirm } from './PublishConfirm';
import { usePostItYourself } from './PostItYourselfModal';
import { LinkFields, PostLinkNote } from './PostLinkNote';

export function PostTypeTag({ type, className }: { type: PostType; className?: string }) {
  return <Badge className={className}>{POST_TYPE_MAP[type].short}</Badge>;
}

export function FormatBadge({ format }: { format: Post['format'] }) {
  return <Badge>{format === 'video' ? 'Video' : 'Image'}</Badge>;
}

function styleOptions(format: Post['format']) {
  return format === 'video' ? VIDEO_STYLES : IMAGE_STYLES;
}

/** An image post with your own photo: it posts as it is, so no visual style applies to it. */
const ownPhotoPost = (post: Post) => post.format === 'image' && isOwnPhoto(post.media);

/** The post's look, as lists show it: "Your photo" for your own photo, else its visual style. */
export const styleLabel = (post: Post) => (ownPhotoPost(post) ? 'Your photo' : STYLE_LABEL[post.style]);

/** "Thu, Nov 5 · 9:00 AM": when a post goes out (or went out). */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

/** A character count against the network's limit ("128/2200"), red once it's over. */
function Count({ n, max }: { n: number; max: number }) {
  return <span className={cn('num font-mono', n > max && 'text-bad')}>{`${n}/${max}`}</span>;
}

interface EditableProps {
  post: Post;
  onChange: (patch: Partial<Post>) => void;
}

export function PostFields({ post, onChange }: EditableProps) {
  const project = useStore((s) => s.projects.find((p) => p.id === post.projectId));
  const ownPhoto = ownPhotoPost(post);
  return (
    <div className="grid gap-4">
      <Field label={ownPhoto ? 'Headline' : 'On-image headline'} htmlFor={`h-${post.id}`} right={<Count n={post.headline.length} max={70} />} hint={ownPhoto ? 'Names the post in your lists. It isn’t added to your photo.' : undefined}>
        <input id={`h-${post.id}`} className="input" value={post.headline} maxLength={90} onChange={(e) => onChange({ headline: e.target.value })} />
      </Field>
      {/* X counts the whole post (hashtags too), and every link as 23 characters */}
      <Field label="Caption" htmlFor={`c-${post.id}`} right={post.platform === 'x' ? <Count n={xLength(postText(post))} max={280} /> : <Count n={post.caption.length} max={PLATFORMS[post.platform].limit} />}>
        <AutoTextarea id={`c-${post.id}`} value={post.caption} onChange={(v) => onChange({ caption: v })} minRows={4} />
      </Field>
      <Field label="Hashtags">
        <ChipInput values={post.hashtags} onChange={(v) => onChange({ hashtags: v })} prefix="#" placeholder="#hashtag" />
      </Field>
      <LinkFields post={post} onChange={onChange} />
      {post.format === 'image' && project ? (
        <PostImagePanel project={project} headline={post.headline} prompt={post.visualPrompt} onPromptChange={(v) => onChange({ visualPrompt: v })} style={post.style} watermark={post.watermark} platform={post.platform} media={post.media} onChange={(m) => onChange({ media: m ?? undefined })} pendingKey={`post:${post.id}`} />
      ) : project ? (
        <VideoPanel
          prompt={post.visualPrompt ? postVideoPrompt(project, post.visualPrompt, post.style, post.storyboard) : ''}
          defaultAspect={post.platform === 'linkedin' || post.platform === 'x' ? '16:9' : '9:16'}
          media={post.media}
          onChange={(m) => onChange({ media: m ?? undefined })}
          name={(post.headline || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}
          pendingKey={`video:${post.id}`}
        />
      ) : (
        <Field label="Visual prompt" htmlFor={`v-${post.id}`} hint="Used to plan the shots for your video.">
          <AutoTextarea id={`v-${post.id}`} value={post.visualPrompt} onChange={(v) => onChange({ visualPrompt: v })} minRows={2} />
        </Field>
      )}
      {postHeld(post) && (
        <p className="flex items-start gap-1.5 text-small text-warn">
          <TriangleAlert size={14} className="mt-[3px] shrink-0" aria-hidden="true" />
          {post.external?.via === 'manus' ? 'This post was sent with Manus earlier' : 'The app is posting this, or may already have'}: changing the date or time here doesn’t change it on {PLATFORMS[post.platform].label}.
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="When">
          <DateTimeButton value={new Date(post.scheduledAt).getTime()} onChange={(ms) => onChange({ scheduledAt: new Date(ms).toISOString() })} aria-label="When" />
        </Field>
        <Field label="Platform" htmlFor={`p-${post.id}`}>
          <select
            id={`p-${post.id}`}
            className="select"
            value={post.platform}
            // the link moves to where it goes on the new network (its own setting), in the caption too
            onChange={(e) => onChange(networkMovePatch(project, post, e.target.value as PostPlatform))}
          >
            {POST_PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {PLATFORMS[p].label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Post type" htmlFor={`pt-${post.id}`}>
          <select id={`pt-${post.id}`} className="select" value={post.postType} onChange={(e) => onChange({ postType: e.target.value as PostType })}>
            {POST_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.short}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Format" htmlFor={`f-${post.id}`}>
          <select
            id={`f-${post.id}`}
            className="select"
            value={post.format}
            onChange={(e) => {
              const format = e.target.value as Post['format'];
              onChange({ format, style: isVideoStyle(post.style) === (format === 'video') ? post.style : styleOptions(format)[0].id });
            }}
          >
            <option value="image">Image</option>
            <option value="video">Video</option>
          </select>
        </Field>
        <Field label="Visual style" htmlFor={`s-${post.id}`} className="sm:col-span-2" hint={ownPhoto ? 'Only used if you replace your photo with an AI image. Your photo posts as it is.' : undefined}>
          <select id={`s-${post.id}`} className="select" value={post.style} onChange={(e) => onChange({ style: e.target.value as StyleId })}>
            {styleOptions(post.format).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </div>
  );
}

/** Whether "Post to groups" applies (a Facebook post, Manus reachable, no group share running). Groups are all Manus does now. */
function groupsOpen(post: Post, offer: boolean): boolean {
  return offer && post.platform === 'facebook' && !(post.groupShare && (post.groupShare.state === 'working' || post.groupShare.state === 'needs_input'));
}

/** The post's state as one dot and a word (Due posts show their badge instead). */
function PostState({ post, now }: { post: Post; now: number }) {
  if (isDue(post, now) && (!post.external || post.external.state === 'failed' || post.external.state === 'scheduled')) return <DueBadge post={post} now={now} />;
  if (post.status === 'published') return <StatusDot tone="good">Posted</StatusDot>;
  if (post.status === 'draft') return <StatusDot tone="faint">Draft</StatusDot>;
  if (post.external?.via === 'api' && post.external.state === 'working') return <StatusDot tone="primary" pulse>Posting…</StatusDot>;
  if (post.external?.via === 'api' && post.external.state === 'unknown') return <StatusDot tone="warn">Check it</StatusDot>;
  return <StatusDot tone="primary">{post.external?.via === 'manus' && post.external.state !== 'failed' ? 'Sent earlier' : 'Planned'}</StatusDot>;
}

/**
 * A post as it will look on the network (the Social 7-day batch, the calendar's drafts): the brand's
 * avatar and handle, the visual, the caption. The footer has its state, the one action that fits it,
 * and Edit; everything else is in the "⋯" menu of the post's header.
 */
export function PostCard({ post, brand, selectable, selected, onSelect }: { post: Post; brand: Brand; selectable?: boolean; selected?: boolean; onSelect?: (v: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const update = useStore((s) => s.updatePost);
  const offer = useCanOfferManus();
  const { byPlatform } = useConnections();
  const canPost = !__ARTIFACT_BUILD__ && canPostFrom(byPlatform[post.platform]);
  const now = useNow(60_000);
  const ai = useAI(postTask);
  const points = useMemo(() => pointsFromCaption(post.caption), [post.caption]);
  const [expanded, setExpanded] = useState(false);
  const project = useStore((s) => s.projects.find((p) => p.id === post.projectId));
  const img = useImageJob();
  const makeImage = () =>
    project &&
    img.run(
      (signal, onStage, onTask) => makePostImage(project, post, { signal, onStage, onTask }),
      (r) => {
        update(post.id, { media: r.media });
        if (r.art.note) toast({ kind: 'info', title: 'Made with the built-in designer', body: r.art.note });
        return { done: '' };
      },
    );
  const regenerate = async () => {
    // written for where this post's link goes; the app places the link itself afterwards
    const input = rewriteInput(project, post);
    const r = await ai.run(input);
    if (r) update(post.id, rewritePatch(project, post, r, input.link ?? null));
  };
  const handle = previewHandle(brand, post.platform);
  const when = post.status === 'published' && post.publishedAt ? post.publishedAt : post.scheduledAt;
  const writing: MenuEntry[] =
    post.status === 'published'
      ? []
      : [
          { label: 'Rewrite the caption', icon: <Spark size={16} />, onSelect: () => void regenerate(), disabled: ai.running },
          ...(post.format === 'image' && !post.media ? [{ label: 'Make an AI image', icon: <Spark size={16} />, onSelect: () => void makeImage(), disabled: img.running }] : []),
          'separator' as const,
        ];
  const menu: MenuEntry[] = [
    ...writing,
    ...(post.status === 'draft' && !postHeld(post)
      ? [canPost ? { label: `Post on ${networkLabel(post.platform)} now`, icon: <Send />, onSelect: () => usePublishConfirm.getState().open(post.id) } : { label: 'Post it yourself…', icon: <Hand />, onSelect: () => usePostItYourself.getState().open(post.id) }]
      : []),
    ...(groupsOpen(post, offer) ? [{ label: 'Post to groups', icon: <Users />, onSelect: () => useManusGroups.getState().open(post.id) }] : []),
    ...postMenuEntries(post),
  ];
  // the one action that fits the post's state (the rest is in the menu)
  const action = editing ? null : post.status === 'draft' ? (
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => addToCalendarFlow([post.id])}>
      <CalendarClock /> Add to calendar
    </button>
  ) : post.status === 'scheduled' ? (
    <PostNowButton post={post} />
  ) : null;
  return (
    <PostFrame
      handle={pageName(post, brand, handle)}
      avatar={<LogoMark colors={brand.colors} logo={brand.logo} name={brand.name} size={24} />}
      meta={
        <>
          <span className="sr-only">{PLATFORMS[post.platform].label} · </span>
          <span className="num font-mono">{fmtWhen(when)}</span>
          {/* the format is metadata, not a badge over the visual (where it collided with the watermark and story bars) */}
          {(post.format === 'video' || ownPhotoPost(post)) && (
            <span>
              <span className="px-1.5">·</span>
              {post.format === 'video' ? 'Video' : 'Your photo'}
            </span>
          )}
        </>
      }
      corner={
        <span className="-mr-1 flex shrink-0 items-center gap-1">
          <PlatformMark platform={post.platform} size={20} />
          <MoreMenu items={menu} size="xs" />
        </span>
      }
      className={cn('flex min-w-0 flex-col', selected && 'ring-[1.5px] ring-primary')}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto flex min-w-0 items-center">
            <PostState post={post} now={now} />
          </span>
          {action}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing((e) => !e)}>
            {editing ? <Check /> : <Pencil />}
            {editing ? 'Done' : 'Edit'}
          </button>
        </div>
      }
    >
      <div className="relative">
        <PostVisual style={post.style} headline={post.headline} brand={brand} watermark={post.watermark} media={post.media} storyboard={post.storyboard} points={points} aspect="4/5" className="!rounded-none" />
        {selectable && (
          <div className="absolute left-2.5 top-2.5 z-10 flex h-8 items-center rounded-md bg-surface pl-2 shadow-xs">
            <Checkbox checked={!!selected} onChange={(v) => onSelect?.(v)} label={<span className="sr-only">Select post</span>} />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2.5 px-3 pb-3 pt-2.5">
        {editing ? (
          <PostFields post={post} onChange={(patch) => update(post.id, patch)} />
        ) : (
          <>
            <div>
              <p className={cn('whitespace-pre-line text-small text-ink-2', !expanded && 'clamp-3')}>
                <span className="mr-1 font-semibold text-ink">{handle}</span>
                {post.caption}
              </p>
              {post.caption.length > 160 && (
                <button type="button" className="link mt-0.5 text-caption" onClick={() => setExpanded((x) => !x)}>
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
            {post.hashtags.length > 0 && (
              <p className="truncate text-small text-primary" title={post.hashtags.join(' ')}>
                {post.hashtags.join(' ')}
              </p>
            )}
            <PostLinkNote post={post} />
          </>
        )}
        <AIThinking running={ai.running} stage={ai.stage} onStop={ai.stop} compact />
        <AIThinking running={img.running} stage={img.stage} onStop={img.stop} compact />
        {img.running && img.task && <ManusLink url={img.task.taskUrl} label="Watch it in Manus" />}
        {img.error && (
          <Callout tone="bad">
            <b>{img.error.title}.</b> {img.error.body} <ManusLink url={img.error.taskUrl} label="Open in Manus" />
          </Callout>
        )}
        <PostedBy post={post} />
        <PublishStatus post={post} />
        <GroupShareBadge post={post} />
      </div>
    </PostFrame>
  );
}

// ───────────────────────── Platform-style preview + full editor ─────────────────────────

/** The name to show in the preview: the brand's own handle on that network, else the brand name (never a made-up handle). */
function previewHandle(brand: Brand, platform: PostPlatform): string {
  return brandHandle(brand, [platform]).replace(/^@/, '') || brand.name;
}

/** On Facebook and LinkedIn a Page posts under the business's name; elsewhere under the handle. */
const pageName = (post: Post, brand: Brand, handle: string) => (post.platform === 'linkedin' || post.platform === 'facebook' ? brand.name : handle);

/** "Planned · Nov 5, 9:00 AM · Instagram" (no counts: it isn't out yet, or the app doesn't read them). */
function previewMeta(post: Post): string {
  const when = post.status === 'published' && post.publishedAt ? `Posted ${fmtRelative(post.publishedAt)}` : post.status === 'scheduled' ? `Planned · ${fmtDateTime(post.scheduledAt)}` : 'Draft';
  return `${when} · ${PLATFORMS[post.platform].label}`;
}

/** The post's body in the network's order: text first on Facebook, LinkedIn and X; the visual first elsewhere. */
function PreviewBody({ post, brand, handle }: { post: Post; brand: Brand; handle: string }) {
  const points = pointsFromCaption(post.caption);
  const textFirst = post.platform === 'linkedin' || post.platform === 'facebook' || post.platform === 'x';
  const comment = firstCommentOf(post);
  return (
    <>
      {textFirst && <p className="whitespace-pre-line break-words px-3 pb-2.5 text-small text-ink">{post.caption}</p>}
      <PostVisual style={post.style} headline={post.headline} brand={brand} watermark={post.watermark} media={post.media} storyboard={post.storyboard} points={points} aspect={post.format === 'video' && post.platform === 'tiktok' ? '9/16' : '4/5'} className="!rounded-none" autoPlay={post.format === 'video'} />
      {!textFirst && (
        <p className="whitespace-pre-line break-words px-3 pt-2.5 text-small text-ink">
          <span className="mr-1 font-semibold">{handle}</span>
          {post.caption}
        </p>
      )}
      {post.hashtags.length > 0 && <p className={cn('break-words px-3 text-small text-primary', textFirst ? 'pt-2.5' : 'pt-1')}>{post.hashtags.join(' ')}</p>}
      {comment && (
        <div className="mx-3 mt-3 border-t border-line pt-2.5 text-small text-ink">
          <p className="text-caption font-medium text-muted">{post.platform === 'x' ? 'First reply' : 'First comment'}</p>
          <p className="mt-0.5 whitespace-pre-line break-words">
            <span className="mr-1 font-semibold">{pageName(post, brand, handle)}</span>
            {comment}
          </p>
        </div>
      )}
      <div className="h-3" aria-hidden="true" />
    </>
  );
}

/** How the post will look on the network (a preview: no counts, no link until it's really out). */
export function PlatformFrame({ post, brand }: { post: Post; brand: Brand }) {
  const handle = previewHandle(brand, post.platform);
  return (
    <PostFrame
      handle={pageName(post, brand, handle)}
      avatar={<LogoMark colors={brand.colors} logo={brand.logo} name={brand.name} size={24} />}
      meta={previewMeta(post)}
      corner={<PlatformMark platform={post.platform} size={20} />}
      footer="Preview: the network shows it in its own style."
      className="mx-auto w-full max-w-[420px]"
    >
      <PreviewBody post={post} brand={brand} handle={handle} />
    </PostFrame>
  );
}

/** The same preview on a phone, scrolling inside its screen. */
function PhonePreview({ post, brand }: { post: Post; brand: Brand }) {
  const handle = previewHandle(brand, post.platform);
  return (
    <PhoneFrame>
      <div className="scroll-thin h-full overflow-y-auto pt-11">
        <div className="flex items-center gap-2 px-3 pb-2.5">
          <LogoMark colors={brand.colors} logo={brand.logo} name={brand.name} size={28} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-small font-semibold text-ink">{pageName(post, brand, handle)}</p>
            <p className="truncate text-caption text-muted">{previewMeta(post)}</p>
          </div>
          <PlatformMark platform={post.platform} size={20} />
        </div>
        <PreviewBody post={post} brand={brand} handle={handle} />
      </div>
    </PhoneFrame>
  );
}

/** An action in the editor's footer: a button on wide screens, a menu entry when it doesn't fit. */
interface FooterAction {
  label: string;
  icon: ReactNode;
  run: () => void;
}

export function PostEditorHost() {
  const id = useUI((s) => s.postEditorId);
  const close = () => useUI.getState().openPostEditor(null);
  const post = useStore((s) => s.posts.find((p) => p.id === id));
  const project = useStore((s) => s.projects.find((p) => p.id === post?.projectId));
  const update = useStore((s) => s.updatePost);
  const del = useStore((s) => s.deletePosts);
  const offer = useCanOfferManus();
  const phone = useMediaQuery('(max-width: 639px)');
  if (!id || !post || !project) return null;
  // an older post sent with Manus: its posting button is already "Mark as posted"
  const legacy = post.external?.via === 'manus' && post.external.state !== 'failed';
  const remove = async () => {
    const extra = post.status === 'published' ? ' It stays on the network: this only removes it from the app.' : '';
    if (await confirmAction({ title: 'Delete this post?', body: `This can’t be undone.${extra}`, confirmLabel: 'Delete', danger: true })) {
      del([post.id]);
      close();
    }
  };
  const addToCalendar: FooterAction = {
    label: 'Add to calendar',
    icon: <CalendarClock />,
    run: () => {
      if (addToCalendarFlow([post.id])) close();
    },
  };
  const markPosted: FooterAction = { label: 'Mark as posted', icon: <CheckCheck />, run: () => useMarkPosted.getState().open(post.id) };
  const unmark: FooterAction = {
    label: 'Mark as not posted',
    icon: <Undo2 />,
    run: () => {
      useStore.getState().unmarkPosted(post.id);
      toast({ kind: 'info', title: 'Back on your calendar', body: 'It’s marked as not posted.' });
    },
  };
  // the state's actions: the posting button (the one filled button when the app can post it), and yours
  let second: FooterAction | null = null;
  const extra: MenuEntry[] = [];
  if (post.status === 'draft') {
    second = addToCalendar;
    extra.push({ label: 'Mark as posted…', icon: <CheckCheck />, onSelect: markPosted.run });
  } else if (post.status === 'scheduled') {
    if (!legacy) second = markPosted;
    extra.push({ label: 'Move to drafts', icon: <Undo2 />, onSelect: () => update(post.id, { status: 'draft' }) });
  } else if (post.publishedBy === 'manual') second = unmark;
  if (groupsOpen(post, offer)) extra.push({ label: 'Post to groups', icon: <Users />, onSelect: () => useManusGroups.getState().open(post.id) });
  const asEntry = (a: FooterAction): MenuEntry => ({ label: a.label, icon: a.icon, onSelect: a.run });
  const button = (a: FooterAction, primary: boolean) => (
    <button type="button" className={cn('btn btn-sm', primary ? 'btn-primary' : 'btn-secondary')} onClick={a.run}>
      {a.icon} {a.label}
    </button>
  );
  const filled = post.status === 'published' && post.publishedBy !== 'api' ? null : <PostNowButton post={post} primary />;
  const footer = phone ? (
    <div className="flex w-full items-center gap-2">
      <MoreMenu items={[...(filled && second ? [asEntry(second)] : []), ...extra, 'separator', { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => void remove() }]} />
      <span className="flex min-w-0 flex-1 [&>.btn]:w-full">{filled ?? (second ? button(second, false) : null)}</span>
    </div>
  ) : (
    <>
      <button type="button" className="btn btn-danger-ghost btn-sm mr-auto" onClick={() => void remove()}>
        <Trash2 /> Delete
      </button>
      {extra.length > 0 && <MoreMenu items={extra} />}
      {second && button(second, false)}
      {filled}
    </>
  );
  return (
    <Modal open onClose={close} size="xl" title={post.status === 'published' ? 'Posted' : post.status === 'scheduled' ? 'Planned post' : 'Draft post'} subtitle={`${PLATFORMS[post.platform].label} · ${POST_TYPE_MAP[post.postType].label} · ${styleLabel(post)}`} footer={footer}>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          {(post.status === 'published' || post.status === 'scheduled') && (
            <div className="mb-4 flex flex-wrap items-center gap-2 empty:hidden">
              <DueBadge post={post} />
              <PostedBy post={post} />
            </div>
          )}
          {post.status === 'published' && <p className="mb-4 text-small text-muted">It’s already out: editing it here doesn’t change the post on {PLATFORMS[post.platform].label.replace(' (Twitter)', '')}.</p>}
          {post.external && (
            <div className="mb-4 empty:hidden">
              <PublishStatus post={post} />
            </div>
          )}
          {post.groupShare && (
            <div className="mb-4">
              <GroupShareBadge post={post} />
            </div>
          )}
          <PostFields post={post} onChange={(patch) => update(post.id, patch)} />
        </div>
        <div className="min-w-0 lg:sticky lg:top-0 lg:self-start">
          <div className="flex justify-center">
            <PhonePreview post={post} brand={project.brand} />
          </div>
          <p className="mt-3 text-center text-caption text-muted">Preview: the network shows it in its own style.</p>
        </div>
      </div>
    </Modal>
  );
}
