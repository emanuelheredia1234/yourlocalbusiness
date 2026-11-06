// What the app knows about new leads: the newest ones from all your pages (memory only: a lead is
// someone's personal details), a check every few minutes while the app is open, and the bell's notices.
// Projects keep two markers (marketing.leadsSeenAt and leadsNotifiedAt), which sync with the account,
// so another device doesn't count or announce the same leads again.

import { useEffect, useRef } from 'react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { Project } from '@/lib/types';
import { uid } from '@/lib/utils';
import { leadOfProject, leadTime, leadToSubscriber, listLeads, type Lead } from '@/lib/leads';
import { useAuth } from '@/lib/cloud/auth';
import { getActiveProject, useStore } from './useStore';

interface LeadsState {
  /** the newest leads from all your pages (the watcher's last look; memory only, never saved or synced) */
  recent: Lead[] | null;
  checkedAt: number;
  /** the last error, in plain words ('' when none) */
  error: string;
  /** look now; one at a time; quiet (errors are kept here, never toasted) */
  refresh: () => Promise<void>;
  /** take a deleted lead out of `recent` */
  drop: (id: string) => void;
}

/** How many of the newest leads the watcher looks at. */
const RECENT = 100;
let looking: Promise<void> | null = null;
/** changes when the account does: an answer for the one before is dropped */
let generation = 0;

export const useLeads: UseBoundStore<StoreApi<LeadsState>> = create<LeadsState>((set) => ({
  recent: null,
  checkedAt: 0,
  error: '',
  refresh: () => {
    if (looking) return looking;
    const gen = generation;
    const look = async () => {
      try {
        const recent = await listLeads({ limit: RECENT });
        if (gen === generation) set({ recent, checkedAt: Date.now(), error: '' });
      } catch (e) {
        if (gen === generation) set({ checkedAt: Date.now(), error: (e as Error)?.message || 'Couldn’t check for new leads.' });
      }
    };
    const p = look().finally(() => {
      if (looking === p) looking = null;
    });
    looking = p;
    return p;
  },
  drop: (id) => set((s) => ({ recent: s.recent ? s.recent.filter((l) => l.id !== id) : s.recent })),
}));

/** Forget the leads seen so far (signed out, or another account). */
export function forgetLeads(): void {
  generation++;
  looking = null;
  useLeads.setState({ recent: null, checkedAt: 0, error: '' });
}

/** New leads for this business (its page, its assets and its lead magnet): newer than marketing.leadsSeenAt. */
export function newLeadCount(project: Project | null | undefined, recent: Lead[] | null): number {
  if (!project || !recent?.length) return 0;
  const seen = project.marketing.leadsSeenAt ?? 0;
  return recent.filter((l) => leadOfProject(l, project.id) && leadTime(l) > seen).length;
}

/** Whether a business has anything published that takes leads: its SEO page, an asset, or its lead magnet. */
export function takesLeads(p: Project): boolean {
  return !!p.marketing.seoPublished || p.studio.codeAssets.some((a) => !!a.published) || !!p.marketing.leadMagnet?.delivery;
}

export function useNewLeadCount(project: Project | null | undefined): number {
  const recent = useLeads((s) => s.recent);
  return __ARTIFACT_BUILD__ ? 0 : newLeadCount(project, recent);
}

/** Pure: which projects have leads to announce, with the count and the newest time to save. */
export function leadsToAnnounce(projects: Project[], recent: Lead[]): { projectId: string; count: number; newest: number; slug: string; brand: string }[] {
  const out: { projectId: string; count: number; newest: number; slug: string; brand: string }[] = [];
  for (const p of projects) {
    if (!takesLeads(p)) continue;
    const marker = Math.max(p.marketing.leadsNotifiedAt ?? 0, p.marketing.leadsSeenAt ?? 0);
    const fresh = recent.filter((l) => leadOfProject(l, p.id) && leadTime(l) > marker);
    if (!fresh.length) continue;
    const latest = fresh.reduce((a, b) => (leadTime(b) > leadTime(a) ? b : a));
    out.push({ projectId: p.id, count: fresh.length, newest: leadTime(latest), slug: latest.slug || (latest.source === 'magnet' ? '' : p.marketing.seoPublished?.slug ?? ''), brand: p.brand.name });
  }
  return out;
}

/** One notice per page in the bell. Notices sync to the account: never a visitor's name, email or message. */
export function announceLeads(recent: Lead[]): void {
  const st = useStore.getState();
  for (const a of leadsToAnnounce(st.projects, recent)) {
    st.notify({ kind: 'lead', title: a.count === 1 ? 'New lead from your page' : `${a.count}${a.count >= RECENT ? '+' : ''} new leads from your page`, body: a.slug ? `/${a.slug} · ${a.brand}` : a.brand, route: 'marketing-email' });
    st.updateProject(a.projectId, (p) => ({ ...p, marketing: { ...p.marketing, leadsNotifiedAt: Math.max(p.marketing.leadsNotifiedAt ?? 0, a.newest) } }));
  }
}

/** Checks for new leads every few minutes while the app is open, and puts one notice per page in the bell. */
export function useLeadsWatcher(): void {
  const signedIn = useAuth((s) => s.phase === 'ready');
  const account = useAuth((s) => (s.phase === 'ready' ? s.user?.id ?? '' : ''));
  const published = useStore((s) => s.projects.some(takesLeads));
  // signed out, or another account: the last one's leads go
  const last = useRef(account);
  useEffect(() => {
    if (last.current === account) return;
    last.current = account;
    forgetLeads();
  }, [account]);
  useEffect(() => {
    if (__ARTIFACT_BUILD__ || !signedIn || !published) return;
    let alive = true;
    const look = async () => {
      if (!alive || (typeof document !== 'undefined' && document.hidden)) return;
      await useLeads.getState().refresh();
      const { recent, error } = useLeads.getState();
      if (alive && recent && !error) announceLeads(recent);
    };
    const first = setTimeout(() => void look(), 5000);
    const every = setInterval(() => void look(), 3 * 60_000);
    // back to the tab: look again, unless that was a moment ago
    const back = () => {
      if (document.visibilityState === 'visible' && Date.now() - useLeads.getState().checkedAt >= 60_000) void look();
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(every);
      document.removeEventListener('visibilitychange', back);
    };
  }, [signedIn, published]);
}

/** Mark this project's leads seen up to `newest` (ms); only ever moves forward. */
export function markLeadsSeen(projectId: string, newest: number): void {
  const st = useStore.getState();
  const p = st.projects.find((x) => x.id === projectId);
  if (!p || !newest || (p.marketing.leadsSeenAt ?? 0) >= newest) return;
  st.updateProject(projectId, (x) => ({ ...x, marketing: { ...x.marketing, leadsSeenAt: Math.max(x.marketing.leadsSeenAt ?? 0, newest) } }));
}

/** The business a lead belongs to (by the business it's tagged with, else its SEO page), or null. */
export function leadOwner(lead: Pick<Lead, 'pageId' | 'projectId'>, projects: Project[] = useStore.getState().projects): Project | null {
  return projects.find((p) => leadOfProject(lead, p.id)) ?? null;
}

/** The project a lead belongs to (else the active one). */
export function leadProject(lead: Pick<Lead, 'pageId' | 'projectId'>, projects: Project[] = useStore.getState().projects): Project | null {
  return leadOwner(lead, projects) ?? getActiveProject();
}

/**
 * Add a lead to the subscribers of the project it belongs to (else the active one). The subscriber's source stays
 * 'lead'. Callers ask the owner first when the lead didn't tick the box to get emails (lead.consent).
 */
export function addLeadToSubscribers(lead: Lead): { status: 'added' | 'exists' | 'no-email'; projectId: string; brand: string } {
  const project = leadProject(lead);
  if (!project) return { status: 'no-email', projectId: '', brand: '' };
  const where = { projectId: project.id, brand: project.brand.name };
  const sub = leadToSubscriber(lead, uid('sub'));
  if (!sub) return { status: 'no-email', ...where };
  if (project.marketing.subscribers.some((s) => s.email.trim().toLowerCase() === sub.email)) return { status: 'exists', ...where };
  useStore.getState().updateProject(project.id, (p) => ({ ...p, marketing: { ...p.marketing, subscribers: [sub, ...p.marketing.subscribers] } }));
  return { status: 'added', ...where };
}
