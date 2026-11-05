// Finding things in the active project for tools, and the compact shapes tools hand back to the model.

import type { Post, Project } from '@/lib/types';
import { goesOutAt } from '@/components/posts/PostActions';
import { getActiveProject, useStore } from '@/store/useStore';
import { clip } from './registry';
import { isDueNow } from './workspace';

/** The active project (tools always act on it; a turn stops if the owner switches). */
export function activeProject(): Project {
  const p = getActiveProject();
  if (!p) throw new Error('No project is open.');
  return p;
}

/** The active project's posts. */
export function projectPosts(): Post[] {
  const id = useStore.getState().activeProjectId;
  return useStore.getState().posts.filter((p) => p.projectId === id);
}

/** A post of the active project by id. */
export function findPost(id: string): Post | undefined {
  return projectPosts().find((p) => p.id === id);
}

/** What a validate hook says about an id that isn't one of this project's posts. */
export const missingPost = (id: string) => `There’s no post with id "${id}" in this project. Use list_posts to find it.`;

/** When a post is (posted: when it went out; otherwise when it's planned, or when Manus scheduled it, older posts). */
export const postWhen = (p: Post) => (p.status === 'published' ? p.publishedAt ?? p.scheduledAt : goesOutAt(p));

/** A post in a few fields, as list_posts returns it (use the same shape in other tools' results). */
export function postSummary(p: Post, now = Date.now()) {
  return {
    id: p.id,
    platform: p.platform,
    format: p.format,
    type: p.postType,
    status: p.status === 'scheduled' ? 'planned' : p.status === 'published' ? 'posted' : 'draft',
    when: postWhen(p),
    ...(isDueNow(p, now) ? { due: true } : {}),
    headline: clip(p.headline, 90),
    caption: clip(p.caption, 90),
    media: p.media ? p.media.kind : null,
    ...(p.external ? { sent: { by: p.external.via === 'api' ? 'the app' : 'Manus (earlier)', state: p.external.state } } : {}),
  };
}
