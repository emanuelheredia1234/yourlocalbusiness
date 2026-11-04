// A compact picture of the workspace for the assistant's prompt (and get_workspace): the active
// project, its posts, channels and launch readiness, and what the AI here can do. Facts from the
// owner's own workspace only, kept short; never keys, tokens or other secrets.

import type { Post, Project } from '@/lib/types';
import { useRuntime } from '@/lib/platform';
import { readiness } from '@/lib/readiness';
import { FORMATS } from '@/ai/knowledge';
import { manusViaServer } from '@/ai/manus';
import { photoAvailability, photoRoute } from '@/ai/image';
import { videoAvailability } from '@/components/images/VideoPanel';
import { goesOutAt, isDue } from '@/components/posts/PostActions';
import { getActiveProject, useStore } from '@/store/useStore';
import { AI_FUNCTIONS, routeFor } from '../functions';
import { clip } from './registry';
import { assistantAvailability } from './transport';

const DAY = 86_400_000;

/** Planned, its time has passed, and not posted (Manus doesn't have it, or its last try failed): the calendar's "Due". */
export const isDueNow = (p: Post, now = Date.now()) => isDue(p, now) && (!p.external || p.external.state === 'failed');

/** Whether Manus can post from this view (the same test as the posting buttons, outside React). */
export function manusReadyNow(): boolean {
  const rt = useRuntime.getState();
  if (manusViaServer()) return !!rt.ai.routing.facebook?.includes('manus');
  return rt.zapier === 'ready' || (__ARTIFACT_BUILD__ && rt.zapier === 'checking');
}

/** What the AI here can do: writing, photos, videos and posting, in a few words each. */
export function aiSummary() {
  const rt = useRuntime.getState();
  const assistant = assistantAvailability();
  const writing = AI_FUNCTIONS.filter((f) => f.kind === 'text' && f.id !== 'assistant');
  const unpowered = __ARTIFACT_BUILD__ ? [] : rt.ai.reachable ? writing.filter((f) => !routeFor(f.id).length).map((f) => f.label) : [];
  const photos = photoAvailability();
  const videos = videoAvailability(rt.zapier, rt.ai);
  return {
    where: __ARTIFACT_BUILD__ ? 'claude.ai (Claude writes)' : 'self-hosted (your API keys)',
    assistant: assistant.ok ? 'ready' : assistant.reason,
    writing: __ARTIFACT_BUILD__ ? (rt.claude === 'available' || rt.claude === 'checking' ? 'Claude' : 'built-in engine only') : rt.server === 'down' ? 'AI server unreachable: built-in engine only' : unpowered.length ? `no key for: ${unpowered.join(', ')} (built-in engine writes those)` : 'all writing has a key',
    photos: photos.ok ? (photoRoute() === 'manus' ? 'Manus (a task, minutes, Manus credits)' : 'ready') : photos.reason,
    videos: videos.ok ? 'ready (paid per second)' : videos.reason,
    manusPosting: manusReadyNow() ? 'ready' : 'not set up',
  };
}

function postLine(p: Post, now: number) {
  return {
    id: p.id,
    platform: p.platform,
    status: p.status,
    at: (p.status === 'published' ? p.publishedAt : goesOutAt(p)) ?? p.scheduledAt,
    ...(isDueNow(p, now) ? { due: true } : {}),
    headline: clip(p.headline, 70),
  };
}

/** The projects on this device, briefly. */
export function projectList() {
  const s = useStore.getState();
  return s.projects.map((p) => ({ id: p.id, name: p.brand.name || 'Untitled project', track: p.track, active: p.id === s.activeProjectId, setUp: p.onboarded }));
}

function kindOf(p: Project): string {
  if (p.track === 'business') return p.businessType || 'business';
  return p.format ? FORMATS[p.format].label : 'digital product';
}

/** The workspace in brief (null without a project). */
export function workspaceSummary(now = Date.now()) {
  const s = useStore.getState();
  const p = getActiveProject();
  if (!p) return null;
  const posts = s.posts.filter((x) => x.projectId === p.id);
  const count = (st: Post['status']) => posts.filter((x) => x.status === st).length;
  const due = posts.filter((x) => isDueNow(x, now));
  const upcoming = posts.filter((x) => x.status === 'scheduled' && !isDueNow(x, now)).sort((a, b) => goesOutAt(a).localeCompare(goesOutAt(b)));
  const drafts = posts.filter((x) => x.status === 'draft').sort((a, b) => b.updatedAt - a.updatedAt);
  const listed = s.myListings.some((l) => l.projectId === p.id);
  const ready = readiness(p, { scheduled: posts.filter((x) => x.status !== 'draft').length, posted: count('published'), listed });
  const m = p.marketing;
  const batch = posts.filter((x) => x.source === 'batch' && x.status !== 'published').length;
  return {
    project: {
      id: p.id,
      name: p.brand.name || 'Untitled project',
      track: p.track === 'business' ? 'business' : 'digital product',
      kind: kindOf(p),
      city: p.location?.city || undefined,
      niche: p.category || p.niche || undefined,
      tagline: clip(p.brand.tagline, 100) || undefined,
      website: p.brand.websiteUrl || undefined,
    },
    otherProjects: s.projects.length - 1,
    posts: {
      drafts: count('draft'),
      planned: count('scheduled'),
      posted: count('published'),
      due: due.length,
      plannedNext7Days: upcoming.filter((x) => new Date(goesOutAt(x)).getTime() < now + 7 * DAY).length,
      withManusNow: posts.filter((x) => x.external && ['working', 'needs_input'].includes(x.external.state)).length,
    },
    // a few posts by id, so the AI can act on them without listing first
    somePosts: [...due.slice(0, 3), ...upcoming.slice(0, 3), ...drafts.slice(0, 2)].map((x) => postLine(x, now)),
    social: { plan: m.plan ? `${m.plan.summary.total} posts planned from ${m.plan.startDate}` : 'none', batchPostsNotPosted: batch, platforms: m.campaign.platforms },
    email: { leadMagnet: m.leadMagnet?.title ?? null, emails: m.emails.length, subscribers: m.subscribers.length },
    seo: { metadata: !!m.seo, salesPage: m.salesPage ? 'drafted' : 'none', pageType: m.pageType ?? 'landing', published: m.seoPublished?.url ?? null },
    studio: {
      [p.track === 'business' ? 'packages' : 'outlineSections']: p.track === 'business' ? p.studio.packages.length : p.studio.outline.length,
      codeAssets: p.studio.codeAssets.length,
      productFiles: p.studio.productFiles?.length ?? 0,
      price: p.studio.price || null,
    },
    listing: { onMarketplace: listed, title: p.studio.listing.title || null },
    ads: { campaigns: s.ads.filter((a) => a.projectId === p.id).length },
    brain: { on: s.settings.ai.useBrain, skillsOn: s.skills.filter((k) => k.enabled && (!k.projectId || k.projectId === p.id)).length },
    readiness: { done: ready.done, of: ready.items.length, next: ready.items.find((i) => !i.done)?.label ?? null },
    unreadNotifications: s.notices.filter((n) => !n.read).length,
    ai: aiSummary(),
  };
}
