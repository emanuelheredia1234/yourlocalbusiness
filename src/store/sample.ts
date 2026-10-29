import type { Post, PostPlatform, PostType, Project, SaleRecord, StyleId, Subscriber } from '@/lib/types';
import { createRng, DAY_MS, hashStr, uid } from '@/lib/utils';
import { composePost } from '@/ai/local/social';
import { IMAGE_STYLES, VIDEO_STYLES } from '@/ai/knowledge';
import { useStore } from './useStore';

const FIRST = ['Maya', 'Jordan', 'Priya', 'Luis', 'Hannah', 'Theo', 'Ava', 'Marcus', 'Elena', 'Sam', 'Noah', 'Zoe', 'Kai', 'Lena', 'Omar', 'Grace', 'Ivy', 'Ben'];

/** Clearly-labelled sample history so Analytics and the queue can be explored before real data exists. */
export function loadSampleData(project: Project): void {
  const rng = createRng(hashStr(project.id + 'sample'));
  const now = Date.now();
  const platforms: PostPlatform[] = project.marketing.campaign.platforms.length ? project.marketing.campaign.platforms : ['instagram', 'facebook'];
  const types: PostType[] = ['educational', 'tip', 'question', 'sales', 'bts'];
  const posts: Post[] = [];
  for (let d = 29; d >= 1; d--) {
    const perDay = rng.int(1, 2);
    for (let k = 0; k < perDay; k++) {
      const postType = rng.pick(types);
      const video = rng.chance(0.4);
      const style: StyleId = video ? rng.pick(VIDEO_STYLES).id : rng.pick(IMAGE_STYLES).id;
      const platform = rng.pick(platforms);
      const when = now - d * DAY_MS + rng.int(8, 20) * 3_600_000 - 12 * 3_600_000;
      const c = composePost(project, { topic: postType === 'question' ? 'What’s your biggest challenge this week?' : project.category || project.niche || 'Behind the scenes', postType, platform, format: video ? 'video' : 'image', style, watermark: true }, {}, `sample-${d}-${k}`);
      const iso = new Date(when).toISOString();
      posts.push({
        id: uid('post'),
        projectId: project.id,
        status: 'published',
        platform,
        format: video ? 'video' : 'image',
        style,
        postType,
        headline: c.headline,
        visualPrompt: c.visualPrompt,
        caption: c.caption,
        hashtags: c.hashtags,
        scheduledAt: iso,
        publishedAt: iso,
        storyboard: c.storyboard,
        watermark: true,
        source: 'sample',
        createdAt: when,
        updatedAt: when,
        seed: rng.int(1, 1e9),
      });
    }
  }
  const subscribers: Subscriber[] = Array.from({ length: rng.int(48, 72) }, (_, i) => {
    const name = rng.pick(FIRST);
    const joinedAt = now - rng.int(0, 29) * DAY_MS - rng.int(0, 20) * 3_600_000;
    return { id: uid('sub'), name, email: `${name.toLowerCase()}${i}@example.com`, joinedAt, source: 'sample', step: rng.int(1, 5), opened: [1, 2], clicked: rng.chance(0.4) ? [2] : [], converted: rng.chance(0.12) };
  });
  const price = project.studio.price || 29;
  const sales: SaleRecord[] = Array.from({ length: rng.int(10, 18) }, () => ({
    id: uid('sale'),
    listingId: project.studio.publishedListingId ?? 'sample',
    projectId: project.id,
    title: project.studio.listing.title || project.brand.name,
    amount: price,
    qty: 1,
    createdAt: now - rng.int(0, 29) * DAY_MS - rng.int(0, 20) * 3_600_000,
    buyer: `${rng.pick(FIRST)} (sample)`,
    source: 'sample',
  }));
  useStore.setState((s) => ({
    posts: [...s.posts, ...posts],
    sales: [...sales, ...s.sales],
    projects: s.projects.map((p) => (p.id === project.id ? { ...p, marketing: { ...p.marketing, subscribers: [...subscribers, ...p.marketing.subscribers] } } : p)),
  }));
}

export function clearSampleData(): void {
  useStore.setState((s) => ({
    posts: s.posts.filter((p) => p.source !== 'sample'),
    sales: s.sales.filter((x) => x.source !== 'sample'),
    projects: s.projects.map((p) => ({ ...p, marketing: { ...p.marketing, subscribers: p.marketing.subscribers.filter((x) => x.source !== 'sample') } })),
  }));
}

export function hasSampleData(): boolean {
  const s = useStore.getState();
  return s.posts.some((p) => p.source === 'sample') || s.sales.some((x) => x.source === 'sample');
}
