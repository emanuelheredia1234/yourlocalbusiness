// Removes what older versions of the app made up, from workspaces saved before that was fixed:
// posts it pretended to publish (with invented likes and links), "connected" accounts that never
// logged in, sample data, a pretend checkout (orders, sales, cart) and made-up ratings, reviews and
// sold counts on listings, an invented reach estimate, demo switches, and the notices about them. It runs whenever a workspace opens and after a
// backup is imported. It changes only what it must, and running it again changes nothing. Signed
// in, its changes reach your account like any other edit.

import type { Notice, Project, SocialPlatform } from '@/lib/types';
import { PLATFORMS } from '@/ai/knowledge';
import { cleanListing } from '@/lib/community';
import { useStore, type StoreState } from './useStore';
import { LEGACY_CLEANUP } from './defaults';
import { purgeResearch } from './legacy/research';
import { purgeSalesPage } from './legacy/salespage';
import { purgeAdClaims, purgeClaims, purgeListingClaims } from './legacy/claims';
import { purgeListingWebsite, purgePostWebsite, purgeWebsite } from './legacy/domain';
import { purgeCodeAssets } from './legacy/widgets';
import { purgeSkills } from './legacy/brain';

type Data = Pick<StoreState, 'posts' | 'projects' | 'notices' | 'settings' | 'activeProjectId' | 'myListings' | 'ads' | 'skills'>;

/** Run each change on a value; returns the result, or the same value when nothing changed. */
const chain = <T>(v: T, ...fns: ((x: T) => T | null)[]) => fns.reduce((x, f) => f(x) ?? x, v);

/** Notices about things that never happened: the pretend publisher, simulated buyers, the pretend checkout and inquiries. */
const INVENTED_NOTICES: RegExp[] = [/^Published to /i, /just went live/i, /^Simulated sale:/i, /^Order YLB-/i, /^New sale:/i, /^Inquiry sent to /i, / is live on the Marketplace$/i, /^Test subscriber added/i, /^New subscriber:/i, /^Ad campaign live/i];

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

  // Listings: no ratings, reviews, "verified" badges or sold counts (nothing ever measured them).
  // (Orders and sales from the pretend checkout leave the account in sync.ts: RETIRED_KINDS.)
  const isDirty = (l: object) => 'rating' in l || 'reviews' in l || 'sales' in l || 'verified' in ((l as { seller?: object }).seller ?? {});
  if (s.myListings.some(isDirty)) patch.myListings = s.myListings.map((l) => (isDirty(l) ? cleanListing(l) : l));

  // Ads: a campaign is a plan; nothing was launched, delivered or estimated.
  const adDirty = (a: object) => (a as { status?: string }).status !== 'draft' || 'launchedAt' in a || 'projections' in a || 'seed' in a || ((a as { audiences?: object[] }).audiences ?? []).some((x) => 'size' in x);
  if (s.ads.some(adDirty)) {
    patch.ads = s.ads.map((a) => {
      if (!adDirty(a)) return a;
      const { launchedAt: _l, projections: _p, seed: _s, ...rest } = a as typeof a & { launchedAt?: unknown; projections?: unknown; seed?: unknown };
      return { ...rest, status: 'draft' as const, audiences: (rest.audiences ?? []).map(({ size: _z, ...x }: (typeof rest.audiences)[number] & { size?: unknown }) => x) };
    });
  }

  // Projects: sample and test subscribers (and the simulated opens and clicks on the rest), and the
  // social plan's invented reach estimate.
  let projects = s.projects;
  const SIM_FIELDS = ['step', 'opened', 'clicked', 'converted'];
  const cleanProject = (p: Project): Project => {
    const before = p.marketing.subscribers;
    const kept = before.filter((x) => (x.source as string) !== 'sample' && (x.source as string) !== 'test');
    const simulated = kept.some((x) => SIM_FIELDS.some((k) => k in x));
    const subs = simulated ? kept.map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !SIM_FIELDS.includes(k))) as typeof x) : kept;
    const plan = p.marketing.plan;
    const hasReach = !!plan && 'estReach' in (plan.summary as object);
    if (subs.length === before.length && !simulated && !hasReach) return p;
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
  // Claims older versions wrote into a project (research scores, sales-page testimonials and stats,
  // template hours and guarantees, a made-up website, widgets that pretended to send forms), and into
  // its listings, posts and ads. Once per project: afterwards the owner's own edits are never touched,
  // even when they happen to match a template.
  const due = new Map(projects.filter((p) => (p.legacyCleaned ?? 0) < LEGACY_CLEANUP).map((p) => [p.id, p]));
  if (due.size) {
    const dueId = (id?: string) => (id ? due.get(id) : undefined);
    const listings = (patch.myListings ?? s.myListings).map((l) => {
      const p = dueId(l.projectId);
      return p ? chain(l, purgeListingClaims, (x) => purgeListingWebsite(x, p)) : l;
    });
    if (listings.some((l, i) => l !== (patch.myListings ?? s.myListings)[i])) patch.myListings = listings;
    const posts = (patch.posts ?? s.posts).map((x) => {
      const p = dueId(x.projectId);
      return p ? (purgePostWebsite(x, p) ?? x) : x;
    });
    if (posts.some((x, i) => x !== (patch.posts ?? s.posts)[i])) patch.posts = posts;
    // "… Official Site" headlines go when the project has no website once the made-up one is cleared
    const hasSite = (p: Project) => !!(purgeWebsite(p) ?? p).brand.websiteUrl?.trim();
    const ads = (patch.ads ?? s.ads).map((a) => {
      const p = dueId(a.projectId);
      return p ? (purgeAdClaims(a, hasSite(p)) ?? a) : a;
    });
    if (ads.some((a, i) => a !== (patch.ads ?? s.ads)[i])) patch.ads = ads;
    projects = projects.map((p) => (due.has(p.id) ? { ...chain(p, purgeResearch, purgeSalesPage, purgeClaims, purgeWebsite, purgeCodeAssets), legacyCleaned: LEGACY_CLEANUP } : p));
  }
  if (projects !== s.projects) patch.projects = projects;

  // Brain skills still holding the old made-up "proof points" (exact template lines only).
  const skills = purgeSkills(s.skills);
  if (skills) patch.skills = skills;

  // Settings: the pretend connections, the demo buyers switch, the fake "thinking" delay.
  const legacy = s.settings as typeof s.settings & { marketActivity?: unknown; showSampleListings?: unknown; ai: { simulateLatency?: unknown } };
  if (accounts || 'marketActivity' in legacy || 'showSampleListings' in legacy || 'simulateLatency' in legacy.ai) {
    const { accounts: _a, marketActivity: _m, showSampleListings: _s, ...settings } = legacy;
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
