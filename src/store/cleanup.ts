// Removes what older versions of the app made up, from workspaces saved before that was fixed:
// posts it pretended to publish (with invented likes and links), "connected" accounts that never
// logged in, and the notices that announced them. It runs whenever a workspace opens and after a
// backup is imported. It changes only what it must, and running it again changes nothing. Signed
// in, its changes reach your account like any other edit.

import type { Notice, Project, SocialPlatform } from '@/lib/types';
import { PLATFORMS } from '@/ai/knowledge';
import { useStore, type StoreState } from './useStore';

type Data = Pick<StoreState, 'posts' | 'projects' | 'notices' | 'settings' | 'activeProjectId'>;

/** Notices about things that never happened (the pretend publisher). */
const INVENTED_NOTICES: RegExp[] = [/^Published to /i, /just went live/i];

export const isInventedNotice = (n: Pick<Notice, 'title'>) => INVENTED_NOTICES.some((r) => r.test(n.title));

/** The handle as the brand's social handles keep it ("@name" where the network uses @). */
function asHandle(platform: SocialPlatform, handle: string): string {
  const h = handle.trim();
  if (!h || /^https?:\/\//i.test(h) || h.includes('/')) return h;
  return PLATFORMS[platform]?.handlePrefix === '@' && !h.startsWith('@') ? `@${h}` : h;
}

/** What to change, or null when there's nothing made up left. */
export function purgeInventedData(s: Data): Partial<Data> | null {
  const patch: Partial<Data> = {};

  // Posts: sample posts were never real; a post the app itself marked published (no Manus report, not
  // marked by you) never went anywhere, so it goes back on your calendar, unposted.
  let postsChanged = false;
  const posts = [];
  for (const p of s.posts) {
    if ((p.source as string) === 'sample') {
      postsChanged = true;
      continue;
    }
    if (p.status === 'published' && !p.publishedBy) {
      postsChanged = true;
      if (p.external?.state === 'posted') posts.push({ ...p, publishedBy: 'manus' as const });
      else posts.push({ ...p, status: 'scheduled' as const, publishedAt: undefined });
      continue;
    }
    posts.push(p);
  }
  if (postsChanged) patch.posts = posts;

  // Pretend "connected accounts": keep the handles you typed (in the brand), drop the rest.
  const accounts = s.settings.accounts;
  if (accounts) {
    const target = s.projects.find((p) => p.id === s.activeProjectId) ?? s.projects[0];
    if (target) {
      const socials = { ...target.brand.socials };
      let added = false;
      for (const [platform, a] of Object.entries(accounts) as [SocialPlatform, { handle?: string } | undefined][]) {
        const handle = typeof a?.handle === 'string' ? asHandle(platform, a.handle) : '';
        if (handle && !(socials[platform] ?? '').trim()) {
          socials[platform] = handle;
          added = true;
        }
      }
      if (added) patch.projects = s.projects.map((p): Project => (p.id === target.id ? { ...p, brand: { ...p.brand, socials } } : p));
    }
    const { accounts: _gone, ...settings } = s.settings;
    patch.settings = settings;
  }

  // Notices about the pretend publishing.
  if (s.notices.some(isInventedNotice)) patch.notices = s.notices.filter((n) => !isInventedNotice(n));

  return Object.keys(patch).length ? patch : null;
}

/** Clean the open workspace (when it opens, and after a backup import). */
export function cleanWorkspace(): boolean {
  const patch = purgeInventedData(useStore.getState());
  if (!patch) return false;
  useStore.setState(patch);
  return true;
}
