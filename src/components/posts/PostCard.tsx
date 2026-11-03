import { useMemo, useState } from 'react';
import { CalendarClock, Check, CheckCheck, ImagePlus, Pencil, Trash2, Undo2 } from 'lucide-react';
import type { Brand, Post, PostPlatform, PostType, StyleId } from '@/lib/types';
import { cn, combineDateTime, fmtDateTime, fmtRelative, isoToDateStr, isoToTime } from '@/lib/utils';
import { IMAGE_STYLES, PLATFORMS, POST_PLATFORMS, POST_TYPES, POST_TYPE_MAP, STYLE_LABEL, VIDEO_STYLES, isVideoStyle } from '@/ai/knowledge';
import { useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { postTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { PostVisual, pointsFromCaption } from '../visuals/PostVisual';
import { PlatformChip, PlatformGlyph } from './PlatformIcon';
import { AutoTextarea, ChipInput, Field, Modal, confirmAction } from '../ui/primitives';
import { AIThinking, RegenerateButton } from '../ai/AI';
import { LogoMark } from '../brand/Logo';
import { ManusLink, PostImagePanel, aspectForPlatform } from '../images/PostImagePanel';
import { VideoPanel } from '../images/VideoPanel';
import { useImageJob } from '../images/useImageJob';
import { ExternalBadge, ManusPostButton, useManusReady } from './ManusPost';
import { GroupShareBadge, PostToGroupsButton } from './ManusGroups';
import { DueBadge, PostMoreMenu, PostedBy, addToCalendarFlow, manusHolds, useMarkPosted } from './PostActions';
import { createPostImage, defaultImageKind, postVideoPrompt } from '@/ai/image';
import { brandHandle } from '@/lib/brandMark';
import { isOwnPhoto } from '@/lib/media';

export function PostTypeTag({ type, className }: { type: PostType; className?: string }) {
  const def = POST_TYPE_MAP[type];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium text-ink-2', className)}>
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: `rgb(var(--${def.slot}))` }} />
      {def.short}
    </span>
  );
}

export function FormatBadge({ format }: { format: Post['format'] }) {
  return <span className={cn('badge', format === 'video' ? 'bg-ink text-surface' : 'bg-surface-2 text-ink-2')}>{format === 'video' ? 'Video' : 'Image'}</span>;
}

function styleOptions(format: Post['format']) {
  return format === 'video' ? VIDEO_STYLES : IMAGE_STYLES;
}

/** An image post with your own photo: it posts as it is, so no visual style applies to it. */
const ownPhotoPost = (post: Post) => post.format === 'image' && isOwnPhoto(post.media);

/** The post's look, as lists show it: "Your photo" for your own photo, else its visual style. */
export const styleLabel = (post: Post) => (ownPhotoPost(post) ? 'Your photo' : STYLE_LABEL[post.style]);

interface EditableProps {
  post: Post;
  onChange: (patch: Partial<Post>) => void;
}

export function PostFields({ post, onChange }: EditableProps) {
  const project = useStore((s) => s.projects.find((p) => p.id === post.projectId));
  const ownPhoto = ownPhotoPost(post);
  return (
    <div className="grid gap-3">
      <Field label={ownPhoto ? 'Headline' : 'On-image headline'} htmlFor={`h-${post.id}`} right={`${post.headline.length}/70`} hint={ownPhoto ? 'Names the post in your lists. It isn’t added to your photo.' : undefined}>
        <input id={`h-${post.id}`} className="input" value={post.headline} maxLength={90} onChange={(e) => onChange({ headline: e.target.value })} />
      </Field>
      <Field label="Caption" htmlFor={`c-${post.id}`} right={`${post.caption.length}/${PLATFORMS[post.platform].limit}`}>
        <AutoTextarea id={`c-${post.id}`} value={post.caption} onChange={(v) => onChange({ caption: v })} minRows={4} />
      </Field>
      <Field label="Hashtags">
        <ChipInput values={post.hashtags} onChange={(v) => onChange({ hashtags: v })} prefix="#" placeholder="#hashtag" />
      </Field>
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
          <AutoTextarea id={`v-${post.id}`} value={post.visualPrompt} onChange={(v) => onChange({ visualPrompt: v })} minRows={2} className="text-[13px]" />
        </Field>
      )}
      {manusHolds(post) && <p className="text-[12.5px] text-warn">Manus already has this post: changing the date or time here doesn’t change it on {PLATFORMS[post.platform].label}.</p>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Date" htmlFor={`d-${post.id}`}>
          <input id={`d-${post.id}`} type="date" className="input" value={isoToDateStr(post.scheduledAt)} onChange={(e) => e.target.value && onChange({ scheduledAt: combineDateTime(e.target.value, isoToTime(post.scheduledAt)) })} />
        </Field>
        <Field label="Time" htmlFor={`t-${post.id}`}>
          <input id={`t-${post.id}`} type="time" className="input" value={isoToTime(post.scheduledAt)} onChange={(e) => e.target.value && onChange({ scheduledAt: combineDateTime(isoToDateStr(post.scheduledAt), e.target.value) })} />
        </Field>
        <Field label="Platform" htmlFor={`p-${post.id}`}>
          <select id={`p-${post.id}`} className="select" value={post.platform} onChange={(e) => onChange({ platform: e.target.value as PostPlatform })}>
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
        <Field label="Visual style" htmlFor={`s-${post.id}`} className="col-span-1 sm:col-span-3" hint={ownPhoto ? 'Only used if you replace your photo with an AI image. Your photo posts as it is.' : undefined}>
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

export function PostCard({ post, brand, selectable, selected, onSelect }: { post: Post; brand: Brand; selectable?: boolean; selected?: boolean; onSelect?: (v: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const update = useStore((s) => s.updatePost);
  const manusReady = useManusReady();
  const ai = useAI(postTask);
  const points = useMemo(() => pointsFromCaption(post.caption), [post.caption]);
  const [expanded, setExpanded] = useState(false);
  const project = useStore((s) => s.projects.find((p) => p.id === post.projectId));
  const img = useImageJob();
  const makeImage = () =>
    project &&
    img.run(
      (signal, onStage, onTask) => createPostImage({ project, kind: defaultImageKind(), prompt: post.visualPrompt || post.headline, aspect: aspectForPlatform(post.platform), style: post.style, headline: post.headline, overlay: true, watermark: post.watermark, signal, onStage, onTask, pendingKey: `post:${post.id}` }),
      (r) => {
        update(post.id, { media: r.media });
        if (r.art.note) toast({ kind: 'info', title: 'Made with the built-in designer', body: r.art.note });
        return { done: '' };
      },
    );
  const regenerate = async () => {
    const r = await ai.run({ topic: post.headline, postType: post.postType, platform: post.platform, format: post.format, style: post.style, watermark: post.watermark, media: post.media });
    if (r) update(post.id, { headline: r.headline, caption: r.caption, hashtags: r.hashtags, visualPrompt: r.visualPrompt, storyboard: r.storyboard ?? post.storyboard });
  };
  return (
    <article className={cn('panel flex min-w-0 flex-col overflow-hidden', selected && 'ring-2 ring-primary')}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {selectable && <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--primary))]" checked={!!selected} onChange={(e) => onSelect?.(e.target.checked)} aria-label="Select post" />}
          <PlatformChip platform={post.platform} />
        </div>
        <span className="num flex shrink-0 items-center gap-1 text-xs text-muted">
          <CalendarClock size={12} />
          {fmtDateTime(post.status === 'published' && post.publishedAt ? post.publishedAt : post.scheduledAt)}
        </span>
      </div>
      <div className="relative">
        <PostVisual style={post.style} headline={post.headline} brand={brand} watermark={post.watermark} media={post.media} storyboard={post.storyboard} points={points} aspect="4/5" className="rounded-none" />
        <div className="absolute left-2 top-2 flex gap-1">
          <FormatBadge format={post.format} />
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <PostTypeTag type={post.postType} />
          <span className="text-[11px] text-muted">{styleLabel(post)}</span>
        </div>
        <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} compact />
        <AIThinking running={img.running} stage={img.stage} onStop={img.stop} compact />
        {img.running && img.task && <ManusLink url={img.task.taskUrl} label="Watch it in Manus" />}
        {img.error && (
          <p className="rounded-md bg-bad-soft px-2.5 py-1.5 text-xs text-bad" role="alert">
            <b>{img.error.title}.</b> {img.error.body} <ManusLink url={img.error.taskUrl} label="Open in Manus" />
          </p>
        )}
        {editing ? (
          <PostFields post={post} onChange={(patch) => update(post.id, patch)} />
        ) : (
          <>
            <p className={cn('whitespace-pre-line text-[13px] leading-relaxed text-ink-2', !expanded && 'clamp-3')}>{post.caption}</p>
            {post.caption.length > 160 && (
              <button className="self-start text-xs font-semibold text-primary hover:underline" onClick={() => setExpanded((x) => !x)}>
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
            <p className="text-xs font-medium text-info">{post.hashtags.join(' ')}</p>
          </>
        )}
        <DueBadge post={post} />
        <PostedBy post={post} />
        <ExternalBadge post={post} />
        <GroupShareBadge post={post} />
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          {post.status === 'draft' && (
            <button className={cn('btn btn-sm', manusReady ? 'btn-secondary' : 'btn-primary')} onClick={() => addToCalendarFlow([post.id])}>
              <CalendarClock size={14} /> Add to calendar
            </button>
          )}
          <ManusPostButton post={post} primary={post.status === 'scheduled'} />
          <PostToGroupsButton post={post} />
          {post.status === 'scheduled' && !manusReady && (
            <button className="btn btn-secondary btn-sm" onClick={() => useMarkPosted.getState().open(post.id)}>
              <CheckCheck size={14} /> Mark as posted
            </button>
          )}
          <button className={cn('btn btn-secondary btn-sm', editing && 'bg-surface-2')} onClick={() => setEditing((e) => !e)}>
            {editing ? <Check size={14} /> : <Pencil size={14} />}
            {editing ? 'Done' : 'Edit'}
          </button>
          {post.status !== 'published' && <RegenerateButton onClick={regenerate} running={ai.running} label="Rewrite" />}
          {post.status !== 'published' && post.format === 'image' && !post.media && !editing && (
            <button className="btn btn-ai btn-sm" onClick={makeImage} disabled={img.running}>
              <ImagePlus size={14} className="text-accent" /> AI image
            </button>
          )}
          <PostMoreMenu post={post} className="ml-auto text-muted" />
        </div>
      </div>
    </article>
  );
}

// ───────────────────────── Platform-style preview + full editor ─────────────────────────

/** The name to show in the preview: the brand's own handle on that network, else the brand name (never a made-up handle). */
function previewHandle(brand: Brand, platform: PostPlatform): string {
  return brandHandle(brand, [platform]).replace(/^@/, '') || brand.name;
}

/** How the post will look on the network (a preview: no counts, no link until it's really out). */
export function PlatformFrame({ post, brand }: { post: Post; brand: Brand }) {
  const handle = previewHandle(brand, post.platform);
  const p = PLATFORMS[post.platform];
  const points = pointsFromCaption(post.caption);
  return (
    <div className="mx-auto w-full max-w-[420px] overflow-hidden rounded-xl border border-line bg-surface shadow-card">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <LogoMark colors={brand.colors} logo={brand.logo} name={brand.name} size={34} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold text-ink">{post.platform === 'linkedin' || post.platform === 'facebook' ? brand.name : handle}</p>
          <p className="text-[11px] text-muted">
            {post.status === 'published' && post.publishedAt ? `Posted ${fmtRelative(post.publishedAt)}` : post.status === 'scheduled' ? `Planned · ${fmtDateTime(post.scheduledAt)}` : 'Draft'} · {p.label}
          </p>
        </div>
        <span className="flex h-6 w-6 items-center justify-center rounded-md text-white" style={{ background: p.color }}>
          <PlatformGlyph platform={post.platform} size={13} />
        </span>
      </div>
      {(post.platform === 'linkedin' || post.platform === 'facebook' || post.platform === 'x') && <p className="whitespace-pre-line px-3 pb-2.5 text-[13px] leading-relaxed text-ink">{post.caption}</p>}
      <PostVisual style={post.style} headline={post.headline} brand={brand} watermark={post.watermark} media={post.media} storyboard={post.storyboard} points={points} aspect={post.format === 'video' && post.platform === 'tiktok' ? '9/16' : '4/5'} className="rounded-none" autoPlay={post.format === 'video'} />
      {(post.platform === 'instagram' || post.platform === 'tiktok') && (
        <p className="whitespace-pre-line px-3 pb-3 pt-2.5 text-[13px] leading-relaxed text-ink">
          <b className="mr-1">{handle}</b>
          {post.caption}
        </p>
      )}
      <p className={cn('px-3 pb-3 text-[12.5px] font-medium text-info', post.platform !== 'instagram' && post.platform !== 'tiktok' && 'pt-2.5')}>{post.hashtags.join(' ')}</p>
      <p className="border-t border-line bg-surface-2/60 px-3 py-2 text-[11px] text-muted">Preview: the network shows it in its own style.</p>
    </div>
  );
}

export function PostEditorHost() {
  const id = useUI((s) => s.postEditorId);
  const close = () => useUI.getState().openPostEditor(null);
  const post = useStore((s) => s.posts.find((p) => p.id === id));
  const project = useStore((s) => s.projects.find((p) => p.id === post?.projectId));
  const update = useStore((s) => s.updatePost);
  const del = useStore((s) => s.deletePosts);
  if (!id || !post || !project) return null;
  return (
    <Modal
      open
      onClose={close}
      size="xl"
      title={post.status === 'published' ? 'Posted' : post.status === 'scheduled' ? 'Planned post' : 'Draft post'}
      subtitle={`${PLATFORMS[post.platform].label} · ${POST_TYPE_MAP[post.postType].label} · ${styleLabel(post)}`}
      footer={
        <>
          <button
            className="btn btn-ghost btn-sm mr-auto text-bad"
            onClick={async () => {
              const extra = post.status === 'published' ? ' It stays on the network: this only removes it from the app.' : '';
              if (await confirmAction({ title: 'Delete this post?', body: `This can’t be undone.${extra}`, confirmLabel: 'Delete', danger: true })) {
                del([post.id]);
                close();
              }
            }}
          >
            <Trash2 size={14} /> Delete
          </button>
          {post.status === 'draft' && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                if (addToCalendarFlow([post.id])) close();
              }}
            >
              <CalendarClock size={14} /> Add to calendar
            </button>
          )}
          {post.status === 'scheduled' && (
            <button className="btn btn-secondary btn-sm" onClick={() => update(post.id, { status: 'draft' })}>
              <Undo2 size={14} /> Move to drafts
            </button>
          )}
          {post.status !== 'published' && (
            <button className="btn btn-secondary btn-sm" onClick={() => useMarkPosted.getState().open(post.id)}>
              <CheckCheck size={14} /> Mark as posted
            </button>
          )}
          {post.status === 'published' && post.publishedBy === 'manual' && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                useStore.getState().unmarkPosted(post.id);
                toast({ kind: 'info', title: 'Back on your calendar', body: 'It’s marked as not posted.' });
              }}
            >
              <Undo2 size={14} /> Mark as not posted
            </button>
          )}
          <PostToGroupsButton post={post} />
          <ManusPostButton post={post} primary />
          <button className="btn btn-secondary btn-sm" onClick={close}>
            Done
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0">
          {(post.status === 'published' || post.status === 'scheduled') && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <DueBadge post={post} />
              <PostedBy post={post} />
            </div>
          )}
          {post.status === 'published' && <p className="mb-3 text-[12.5px] text-muted">It’s already out: editing it here doesn’t change the post on {PLATFORMS[post.platform].label.replace(' (Twitter)', '')}.</p>}
          {post.external && (
            <div className="mb-4">
              <ExternalBadge post={post} />
            </div>
          )}
          {post.groupShare && (
            <div className="mb-4">
              <GroupShareBadge post={post} />
            </div>
          )}
          <PostFields post={post} onChange={(patch) => update(post.id, patch)} />
        </div>
        <div className="min-w-0">
          <p className="eyebrow mb-2">Preview</p>
          <PlatformFrame post={post} brand={project.brand} />
        </div>
      </div>
    </Modal>
  );
}
