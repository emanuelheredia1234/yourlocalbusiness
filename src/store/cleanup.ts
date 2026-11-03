// Removes what older versions of the app made up, from workspaces saved before that was fixed:
// posts it pretended to publish (with invented likes and links), "connected" accounts that never
// logged in, sample data, sales by simulated buyers, an invented reach estimate, demo switches, and
// the notices that announced them. It runs whenever a workspace opens and after a
// backup is imported. It changes only what it must, and running it again changes nothing. Signed
// in, its changes reach your account like any other edit.

import type { Notice, Project, SocialPlatform } from '@/lib/types';
import { PLATFORMS } from '@/ai/knowledge';
import { useStore, type StoreState } from './useStore';

type Data = Pick<StoreState, 'posts' | 'projects' | 'notices' | 'settings' | 'activeProjectId' | 'sales' | 'myListings'>;

/** Notices about things that never happened (the pretend publisher, the simulated buyers). */
const INVENTED_NOTICES: RegExp[] = [/^Published to /i, /just went live/i, /^Simulated sale:/i];

/** Sales nobody made: sample data and the demo's simulated buyers. */
const INVENTED_SALES = new Set(['sample', 'simulated']);

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

  // Sales nobody made, and what they added to your listings' "sold" counts.
  const fakeSales = s.sales.filter((x) => INVENTED_SALES.has(x.source as string));
  if (fakeSales.length) {
    patch.sales = s.sales.filter((x) => !INVENTED_SALES.has(x.source as string));
    const sold = new Map<string, number>();
    for (const x of fakeSales) sold.set(x.listingId, (sold.get(x.listingId) ?? 0) + (x.qty || 0));
    if (s.myListings.some((l) => sold.has(l.id))) patch.myListings = s.myListings.map((l) => (sold.has(l.id) ? { ...l, sales: Math.max(0, (l.sales || 0) - (sold.get(l.id) ?? 0)) } : l));
  }

  // Projects: sample subscribers, and the social plan's invented reach estimate.
  let projects = s.projects;
  const cleanProject = (p: Project): Project => {
    const subs = p.marketing.subscribers.filter((x) => (x.source as string) !== 'sample');
    const plan = p.marketing.plan;
    const hasReach = !!plan && 'estReach' in (plan.summary as object);
    if (subs.length === p.marketing.subscribers.length && !hasReach) return p;
    const summary = hasReach ? (({ estReach: _r, ...rest }) => rest)(plan!.summary as typeof plan.summary & { estReach?: number }) : plan?.summary;
    return { ...p, marketing: { ...p.marketing, subscribers: subs, plan: plan && summary ? { ...plan, summary } : plan } };
  };
  if (projects.some((p) => cleanProject(p) !== p)) projects = projects.map(cleanProject);

  // Pretend "connected accounts": keep the handles you typed (in the brand), drop the rest.
  const accounts = s.settings.accounts;
  if (accounts) {
    const target = projects.find((p) => p.id === s.activeProjectId) ?? projects[0];
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
      if (added) projects = projects.map((p): Project => (p.id === target.id ? { ...p, brand: { ...p.brand, socials } } : p));
    }
  }
  if (projects !== s.projects) patch.projects = projects;

  // Settings: the pretend connections, the demo buyers switch, the fake "thinking" delay.
  const legacy = s.settings as typeof s.settings & { marketActivity?: unknown; ai: { simulateLatency?: unknown } };
  if (accounts || 'marketActivity' in legacy || 'simulateLatency' in legacy.ai) {
    const { accounts: _a, marketActivity: _m, ...settings } = legacy;
    const { simulateLatency: _l, ...ai } = legacy.ai;
    patch.settings = { ...settings, ai };
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
