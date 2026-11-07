// What was launched, as the server says (not persisted: the server is the source of truth), plus which launch or
// change window is open. Reads only, except the two write paths that the confirm windows call after the
// customer's explicit confirm (launch and change): each sends ONE request, carrying the window's clientRequestId.
//
// Rules this store keeps (spec §1, §8): following a job only GETs /api/ads/jobs/:id (followAdJob); Check status is
// only ever the customer's own press; nothing here retries, resends, or calls a write from a catch.

import { create } from 'zustand';
import type { AdJob, AdLimitsView, AdsPlatform, AuditEntry, CampaignsResponse, ChangeAction, LaunchedCampaign, PlainNote } from '@/lib/ads/launchTypes';
import { AdsApiError, checkAdJob, followAdJob, getAdAudit, getCampaigns, refreshCampaigns, removeFailedCampaign } from '@/lib/ads/launchApi';

/** Refresh reads Meta/Google at most once per business every 5 minutes (the server enforces it too). */
export const REFRESH_EVERY_MS = 5 * 60_000;

export interface LaunchWindowState {
  planId: string;
  /** opened by the assistant: nothing is prefilled that spends (no PAUSED/ACTIVE, no ticks) */
  fromAssistant?: boolean;
  /** "Launch again" after a failed launch: which one, so the confirm can warn about a late campaign */
  again?: { platform: AdsPlatform; tag: string | null; code: string | null };
}

export interface ChangeWindowState {
  campaignId: string;
  action: ChangeAction;
}

interface AdsLaunchState {
  /** per business */
  campaigns: Record<string, LaunchedCampaign[]>;
  limits: Record<string, AdLimitsView | undefined>;
  notes: Record<string, PlainNote[] | undefined>;
  loadedAt: Record<string, number | undefined>;
  refreshedAt: Record<string, number | undefined>;
  loading: Record<string, boolean | undefined>;
  error: Record<string, string | undefined>;
  audit: Record<string, { entries: AuditEntry[]; next?: number } | undefined>;
  /** Check status notes per job ("Meta may still be working on it…") */
  checkNotes: Record<string, string | undefined>;
  launchWindow: LaunchWindowState | null;
  changeWindow: ChangeWindowState | null;
  /** the campaign whose Manage drawer is open */
  manageId: string | null;

  load: (projectId: string) => Promise<void>;
  /** One read per connection at Meta/Google (Refresh button, or on opening when older than 5 min). */
  refresh: (projectId: string, opts?: { auto?: boolean }) => Promise<{ ok: boolean; message?: string }>;
  loadAudit: (projectId: string, more?: boolean) => Promise<void>;
  /** A job or campaign the server answered with: put it in place (no request). */
  applyJob: (job: AdJob, campaign?: LaunchedCampaign) => void;
  /** Follow a sending job (GET only) until it's done, failed or unknown. */
  follow: (jobId: string) => Promise<AdJob | null>;
  /** The customer's "Check status": reads only, once. */
  check: (jobId: string) => Promise<{ ok: boolean; message?: string }>;
  /** Remove a failed launch with nothing at Meta or Google from this business's list (one request, never retried). */
  remove: (projectId: string, campaignId: string) => Promise<{ ok: boolean; message?: string }>;
  openLaunch: (w: LaunchWindowState) => void;
  closeLaunch: () => void;
  openChange: (w: ChangeWindowState) => void;
  closeChange: () => void;
  openManage: (id: string | null) => void;
}

const following = new Map<string, Promise<AdJob | null>>();
const messageOf = (e: unknown) => (e instanceof AdsApiError ? e.message : 'Something went wrong. Try again shortly.');

function put(list: LaunchedCampaign[] | undefined, c: LaunchedCampaign): LaunchedCampaign[] {
  const rest = (list ?? []).filter((x) => x.id !== c.id);
  return [c, ...rest];
}

export const useAdsLaunch = create<AdsLaunchState>((set, get) => {
  const take = (projectId: string, r: CampaignsResponse) =>
    set((s) => ({
      campaigns: { ...s.campaigns, [projectId]: r.campaigns },
      limits: { ...s.limits, [projectId]: r.limits },
      notes: { ...s.notes, [projectId]: r.notes },
      loadedAt: { ...s.loadedAt, [projectId]: Date.now() },
      error: { ...s.error, [projectId]: undefined },
    }));

  /** Each job still sending is followed (reads only); one follower per job. */
  const followSending = (list: LaunchedCampaign[]) => {
    for (const c of list) if (c.pendingJob && (c.pendingJob.state === 'sending' || c.pendingJob.state === 'queued')) void get().follow(c.pendingJob.id);
  };

  return {
    campaigns: {},
    limits: {},
    notes: {},
    loadedAt: {},
    refreshedAt: {},
    loading: {},
    error: {},
    audit: {},
    checkNotes: {},
    launchWindow: null,
    changeWindow: null,
    manageId: null,

    load: async (projectId) => {
      if (__ARTIFACT_BUILD__ || !projectId) return;
      set((s) => ({ loading: { ...s.loading, [projectId]: true } }));
      try {
        const r = await getCampaigns(projectId);
        take(projectId, r);
        followSending(r.campaigns);
      } catch (e) {
        set((s) => ({ error: { ...s.error, [projectId]: messageOf(e) } }));
      } finally {
        set((s) => ({ loading: { ...s.loading, [projectId]: false } }));
      }
    },

    refresh: async (projectId, opts = {}) => {
      if (__ARTIFACT_BUILD__ || !projectId) return { ok: false };
      const last = get().refreshedAt[projectId] ?? 0;
      if (opts.auto && Date.now() - last < REFRESH_EVERY_MS) return { ok: true };
      set((s) => ({ loading: { ...s.loading, [projectId]: true } }));
      try {
        const r = await refreshCampaigns(projectId);
        take(projectId, r);
        followSending(r.campaigns);
        set((s) => ({ refreshedAt: { ...s.refreshedAt, [projectId]: Date.now() } }));
        return { ok: true };
      } catch (e) {
        // "updated a moment ago" is not a problem worth showing on an automatic refresh
        if (e instanceof AdsApiError && e.code === 'REFRESH_TOO_SOON') {
          set((s) => ({ refreshedAt: { ...s.refreshedAt, [projectId]: s.refreshedAt[projectId] ?? Date.now() } }));
          return opts.auto ? { ok: true } : { ok: false, message: e.message };
        }
        return { ok: false, message: messageOf(e) };
      } finally {
        set((s) => ({ loading: { ...s.loading, [projectId]: false } }));
      }
    },

    loadAudit: async (projectId, more = false) => {
      if (__ARTIFACT_BUILD__ || !projectId) return;
      const before = more ? get().audit[projectId]?.next : undefined;
      try {
        const r = await getAdAudit({ projectId, before });
        set((s) => ({ audit: { ...s.audit, [projectId]: { entries: more ? [...(s.audit[projectId]?.entries ?? []), ...r.entries] : r.entries, next: r.next } } }));
      } catch (e) {
        set((s) => ({ error: { ...s.error, [projectId]: messageOf(e) } }));
      }
    },

    applyJob: (job, campaign) =>
      set((s) => {
        if (campaign) return { campaigns: { ...s.campaigns, [campaign.projectId]: put(s.campaigns[campaign.projectId], campaign) } };
        // no campaign in the answer: update the job on whichever row holds it
        const campaigns = { ...s.campaigns };
        for (const [pid, list] of Object.entries(campaigns)) {
          const i = list.findIndex((c) => c.pendingJob?.id === job.id || c.lastJob?.id === job.id);
          if (i === -1) continue;
          const live = job.state === 'queued' || job.state === 'sending' || job.state === 'unknown';
          const c = { ...list[i], pendingJob: live ? job : undefined, lastJob: live ? list[i].lastJob : job };
          campaigns[pid] = list.map((x, j) => (j === i ? c : x));
        }
        return { campaigns };
      }),

    follow: (jobId) => {
      const running = following.get(jobId);
      if (running) return running;
      const p = followAdJob(jobId, { onUpdate: (job, campaign) => get().applyJob(job, campaign) }).finally(() => following.delete(jobId));
      following.set(jobId, p);
      return p;
    },

    check: async (jobId) => {
      try {
        const r = await checkAdJob(jobId);
        get().applyJob(r.job, r.campaign);
        set((s) => ({ checkNotes: { ...s.checkNotes, [jobId]: r.note?.message } }));
        return { ok: true, message: r.note?.message };
      } catch (e) {
        return { ok: false, message: messageOf(e) };
      }
    },

    remove: async (projectId, campaignId) => {
      if (__ARTIFACT_BUILD__ || !projectId) return { ok: false };
      try {
        // once: a refused or failed removal is never sent again by itself
        await removeFailedCampaign(campaignId, projectId);
      } catch (e) {
        // already gone (another tab): drop it from the list too
        if (e instanceof AdsApiError && e.status === 404) set((s) => ({ campaigns: { ...s.campaigns, [projectId]: (s.campaigns[projectId] ?? []).filter((c) => c.id !== campaignId) } }));
        return { ok: false, message: messageOf(e) };
      }
      set((s) => ({ campaigns: { ...s.campaigns, [projectId]: (s.campaigns[projectId] ?? []).filter((c) => c.id !== campaignId) }, manageId: s.manageId === campaignId ? null : s.manageId }));
      void get().loadAudit(projectId);
      return { ok: true };
    },

    openLaunch: (w) => set({ launchWindow: w }),
    closeLaunch: () => set({ launchWindow: null }),
    openChange: (w) => set({ changeWindow: w }),
    closeChange: () => set({ changeWindow: null }),
    openManage: (id) => set({ manageId: id }),
  };
});

/** The campaigns of one plan (for the planner's "Launched on Meta · Paused" line and the delete-plan warning). */
export const launchedFor = (projectId: string, planId: string) => (useAdsLaunch.getState().campaigns[projectId] ?? []).filter((c) => c.planId === planId);

/** A campaign whose switch is on, or may be on (counts toward live spend). */
export const mayBeOn = (c: LaunchedCampaign) => !['ended', 'completed', 'failed'].includes(c.state) && (c.configuredStatus === 'ACTIVE' || c.state === 'launching' || c.state === 'unknown' || !!c.pendingJob);
