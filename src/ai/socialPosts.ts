// Social posts as the app's buttons make them: the drafts "Create individual post" builds (one per network,
// each with its link where it goes and short enough for X), what it and a post's Rewrite ask the AI for, and
// a post's AI image or video. The composer, the post card and editor, and the assistant all use these, so a
// post comes out the same whoever makes it.

import type { ImageKind, LinkPlacement, MediaRef, Post, PostFormat, PostPlatform, PostType, Project, Scene, StyleId } from '@/lib/types';
import { combineDateTime, hashStr, truncate, uid } from '@/lib/utils';
import { deleteBlob } from '@/lib/storage';
import { firstCommentFor, postLinkFor, postLinkOf, type PostLink } from '@/lib/pageLink';
import { useStore } from '@/store/useStore';
import { finishCaption, type ComposeInput, type ComposedPost } from './local/social';
import { artDirection, aspectForPlatform, createPostImage, defaultImageKind, postVideoPrompt, recordVisualSkills, releaseMedia } from './image';
import { createVideo, type VideoAspect, type VideoJob, type VideoRequest, type VideoResolution } from './video';
import type { ManusTask } from './manus';

// ───────────── Create individual post ─────────────

/** What "Create individual post" holds when it saves: the words, the look, the networks and when. */
export interface ComposerDraft {
  platforms: PostPlatform[];
  /** the post's format (with your own photo or video, its kind) */
  format: PostFormat;
  style: StyleId;
  postType: PostType;
  headline: string;
  /** what the post is about: it names the post when there's no headline */
  topic: string;
  caption: string;
  hashtags: string[];
  visualPrompt: string;
  storyboard?: Scene[];
  watermark: boolean;
  date: string;
  time: string;
  /** your own photo or video, or the AI image or video made for it */
  media?: MediaRef;
  /** where the link goes on each network (default: the project's setting for that network) */
  linkWhere?: Partial<Record<PostPlatform, LinkPlacement>>;
}

/** The link a network's post from the composer carries, and where it goes. */
export const composerLink = (project: Project, platform: PostPlatform, linkWhere?: Partial<Record<PostPlatform, LinkPlacement>>): PostLink | null => postLinkFor(project, platform, linkWhere?.[platform]);

/**
 * The drafts the composer saves: one per network, each with its link where it goes there (the first comment
 * when it goes in one), X with two hashtags at most and its opening shortened to fit (never the link).
 */
export function buildComposerPosts(project: Project, d: ComposerDraft, now = Date.now()): Post[] {
  return d.platforms.map((platform) => {
    const pl = composerLink(project, platform, d.linkWhere);
    const tags = platform === 'x' ? d.hashtags.slice(0, 2) : d.hashtags;
    const firstComment = firstCommentFor(project, pl);
    return {
      id: uid('post'),
      projectId: project.id,
      status: 'draft',
      platform,
      format: d.format,
      style: d.style,
      postType: d.postType,
      headline: d.headline || truncate(d.topic, 60),
      visualPrompt: d.visualPrompt,
      // the link where it goes on this network; on X the opening is shortened, never the link
      caption: finishCaption(project, d.caption, platform, pl, tags),
      hashtags: tags,
      ...(pl ? { linkPlacement: pl.placement } : {}),
      ...(firstComment ? { firstComment } : {}),
      scheduledAt: combineDateTime(d.date, d.time),
      media: d.media,
      storyboard: d.storyboard,
      watermark: d.watermark,
      source: 'composer',
      createdAt: now,
      updatedAt: now,
      seed: hashStr(uid('s')),
    };
  });
}

/**
 * What the composer asks the AI for: one post for the first network, written for where its link goes there
 * (the other networks get the link moved for them when the drafts are built). With your own photo or video
 * (`upload`), the AI writes the caption for it, from what you say is in it.
 */
export function composerTaskInput(
  project: Project,
  o: { topic: string; description?: string; upload?: MediaRef | null; postType: PostType; platforms: PostPlatform[]; format: PostFormat; style: StyleId; watermark: boolean; linkWhere?: Partial<Record<PostPlatform, LinkPlacement>> },
): ComposeInput & { media?: MediaRef } {
  const platform = o.platforms[0] ?? 'instagram';
  const upload = !!o.upload;
  return {
    topic: o.topic.trim() || o.description || 'Behind the scenes',
    postType: o.postType,
    platform,
    format: o.format,
    style: o.style,
    watermark: o.watermark,
    media: o.upload ?? undefined,
    mediaDescription: upload ? o.description || o.topic : undefined,
    hasMedia: upload,
    link: composerLink(project, platform, o.linkWhere),
  };
}

// ───────────── Rewrite ─────────────

/** What a post's Rewrite asks the AI for: the post's own topic (its headline), type, network and look, written for where its link goes. */
export function rewriteInput(project: Project | undefined, post: Post, topic?: string): ComposeInput & { media?: MediaRef } {
  const link = project ? postLinkOf(project, post) : null;
  return { topic: topic ?? post.headline, postType: post.postType, platform: post.platform, format: post.format, style: post.style, watermark: post.watermark, media: post.media, link };
}

/** Rewrite's new words for a post: its link stays where it goes, and a first comment is added only when it has none yet. */
export function rewritePatch(project: Project | undefined, post: Post, r: ComposedPost, link: PostLink | null): Partial<Post> {
  const firstComment = project && !post.firstComment?.trim() ? firstCommentFor(project, link) : undefined;
  return { headline: r.headline, caption: r.caption, hashtags: r.hashtags, visualPrompt: r.visualPrompt, storyboard: r.storyboard ?? post.storyboard, ...(link ? { linkPlacement: link.placement } : {}), ...(firstComment ? { firstComment } : {}) };
}

// ───────────── a post's image or video ─────────────

/** Where a post's Manus image is remembered while it's on its way (the post editor's key, so it offers "Pick it up"). */
export const postImageKey = (postId: string) => `post:${postId}`;
/** Where a post's video job is remembered while it's on its way (the post editor's video panel key). */
export const postVideoKey = (postId: string) => `video:${postId}`;

/** A post's AI image, as its card's "AI image" button makes it: from its image description, in its network's shape, with its headline and logo on it. */
export function makePostImage(project: Project, post: Post, o: { kind?: ImageKind; signal?: AbortSignal; onStage?: (s: string) => void; onTask?: (t: ManusTask) => void } = {}) {
  return createPostImage({
    project,
    kind: o.kind ?? defaultImageKind(),
    prompt: post.visualPrompt || post.headline,
    aspect: aspectForPlatform(post.platform),
    style: post.style,
    headline: post.headline,
    overlay: true,
    watermark: post.watermark,
    signal: o.signal,
    onStage: o.onStage,
    onTask: o.onTask,
    pendingKey: postImageKey(post.id),
  });
}

/** A video for a post or the listing, with the Brain's art direction added, counted toward the skills that shaped it (the video panel's Generate). */
export async function videoWithArtDirection({ purpose, ...r }: VideoRequest & { name: string; purpose: 'post' | 'listing'; signal?: AbortSignal; onStage?: (s: string) => void; pendingKey?: string; resume?: VideoJob }) {
  const brief = artDirection(purpose);
  const out = await createVideo({ ...r, prompt: brief.text ? `${r.prompt.trim()} Art direction: ${brief.text}` : r.prompt });
  recordVisualSkills(brief, { task: 'video', label: purpose === 'post' ? 'Post video' : 'Listing demo video', purpose, ms: out.ms });
  return out;
}

/** The shape of a post's video: wide for LinkedIn and X, vertical elsewhere (the post editor's default). */
export const postVideoAspect = (platform: PostPlatform): VideoAspect => (platform === 'linkedin' || platform === 'x' ? '16:9' : '9:16');

/** A video's file name from the post's headline. */
export const videoFileName = (headline: string) => (headline || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);

/** What a post's video shows: its image description (else its headline, as for its image) and storyboard shots ('' without either). */
export const postVideoText = (project: Project, post: Post) => {
  const scene = post.visualPrompt.trim() || post.headline.trim();
  return scene ? postVideoPrompt(project, scene, post.style, post.storyboard) : '';
};

/** A post's AI video, made the way the post editor's video panel makes it (the prompt: `prompt`, else the post's scene). */
export function makePostVideo(project: Project, post: Post, o: { seconds: number; prompt?: string; resolution?: VideoResolution; signal?: AbortSignal; onStage?: (s: string) => void }) {
  return videoWithArtDirection({
    prompt: o.prompt?.trim() || postVideoText(project, post),
    aspect: postVideoAspect(post.platform),
    duration: o.seconds,
    resolution: o.resolution ?? '768p',
    name: videoFileName(post.headline),
    purpose: 'post',
    signal: o.signal,
    onStage: o.onStage,
    pendingKey: postVideoKey(post.id),
  });
}

/**
 * New media on a post (and any other change with it, like the format). What it replaces is freed once no post
 * or brand image uses it any more: an AI image, or a video; your own photos always stay.
 */
export function applyPostMedia(postId: string, media: MediaRef, extra: Partial<Post> = {}): void {
  const old = useStore.getState().posts.find((p) => p.id === postId)?.media;
  useStore.getState().updatePost(postId, { media, ...extra });
  if (!old || old.id === media.id) return;
  if (old.generated) void releaseMedia(old);
  else if (old.kind === 'video') {
    const s = useStore.getState();
    const used = s.posts.some((p) => p.media?.id === old.id) || s.projects.some((p) => p.brand.images.some((m) => m.id === old.id));
    if (!used) void deleteBlob(old.id);
  }
}
