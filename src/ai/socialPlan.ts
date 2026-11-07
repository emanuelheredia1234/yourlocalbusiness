// The Social media engine's campaign: its setup and whether a plan can be made from it, the 30-day plan
// (a new one, a slot's topic), where each network's link goes on new posts, and the next 7-day batch.
// The Social media engine's tabs and the assistant both use these, so either does exactly the same.
//
// Each change names the project it is for (the open one by default): an AI answer that comes back after
// the owner switched projects still lands in the project it was asked for.

import { canTrialReel, withShareMode } from '@/lib/trialReels';
import type { CampaignConfig, CampaignPlan, LinkPlacement, Post, PostPlatform, Project } from '@/lib/types';
import { useStore } from '@/store/useStore';
import { videoDaysOf, videoDaysPatch } from '@/lib/campaign';
import { videoDaysOverLimit, type VideoAllowance } from '@/lib/videoWeek';

const activeId = () => useStore.getState().activeProjectId ?? '';

/** A project by id (null once it's gone). */
const projectOf = (id: string): Project | null => useStore.getState().projects.find((p) => p.id === id) ?? null;

/** Change one project's marketing (not necessarily the open one). */
export function updateMarketingOf(projectId: string, patch: Partial<Project['marketing']> | ((m: Project['marketing']) => Partial<Project['marketing']>)): void {
  useStore.getState().updateProject(projectId, (p) => ({ ...p, marketing: { ...p.marketing, ...(typeof patch === 'function' ? patch(p.marketing) : patch) } }));
}

// ───────────── the campaign setup ─────────────

/** Posts per week and over 30 days, from the posting days, posts per day and the videos chosen on each day. */
export function cadence(cfg: CampaignConfig) {
  const days = cfg.days.filter(Boolean).length;
  const perWeek = days * cfg.postsPerDay;
  const videoDays = videoDaysOf(cfg);
  const videos = videoDays.reduce((a, b) => a + b, 0);
  // approx. posts over 30 days
  const month = Math.round((perWeek * 30) / 7);
  return { days, perWeek, videos, images: perWeek - videos, month, videoDays, videoDayCount: videoDays.filter((n) => n > 0).length };
}

/**
 * What stops a plan from being made from this setup (the setup tab highlights it), or null. More chosen videos a week
 * than the plan makes never stop it (videoDaysWarning says so): the server refuses each video past the week's limit,
 * and older setups (one video on each posting day) would otherwise be stuck the day plans start.
 */
export function campaignProblem(cfg: CampaignConfig): string | null {
  const c = cadence(cfg);
  if (c.days === 0) return 'Pick at least one posting day.';
  if (!cfg.platforms.length) return 'Pick at least one platform.';
  if (c.images > 0 && !cfg.imageStyles.length) return 'Choose at least one image style for the image posts.';
  if (c.videos > 0 && !cfg.videoStyles.length) return 'Choose at least one video style, or turn the video days off.';
  return null;
}

/** More chosen videos a week than the plan makes for a business: said, never stopping the plan. */
export function videoDaysWarning(cfg: CampaignConfig, allowance?: VideoAllowance | null): string | null {
  return videoDaysOverLimit(cadence(cfg).videos, allowance);
}

/** Change how many videos go out on one weekday (0 = none), within that day's posts. */
export function setVideoDay(weekday: number, n: number, projectId = activeId()): void {
  updateMarketingOf(projectId, (m) => {
    const cur = videoDaysOf(m.campaign);
    const next = cur.map((v, i) => (i === weekday ? Math.max(0, Math.trunc(n)) : v));
    return { campaign: { ...m.campaign, ...videoDaysPatch(m.campaign, { videoDays: next }) } };
  });
}

/** Change the campaign setup (the latest saved one, so two quick changes never undo each other). */
export function patchCampaign(patch: Partial<CampaignConfig>, projectId = activeId()): void {
  updateMarketingOf(projectId, (m) => {
    const next = { ...m.campaign, ...patch };
    // video days stay on posting days and within each day's posts; the older "videos per day" goes
    const { videosPerDay: _old, ...rest } = next;
    return { campaign: { ...rest, ...videoDaysPatch(m.campaign, patch) } };
  });
}

/** Where a network's link goes on this project's new posts (posts already made keep theirs). */
export function setLinkPlacement(platform: PostPlatform, placement: LinkPlacement, projectId = activeId()): void {
  updateMarketingOf(projectId, (m) => ({ linkPlacement: { ...(m.linkPlacement ?? {}), [platform]: placement } }));
}

// ───────────── the 30-day plan ─────────────

/** A new 30-day plan replaces the old one (posts already made from it stay in the batch and on the calendar). */
export function applyCampaignPlan(plan: CampaignPlan, projectId = activeId()): void {
  updateMarketingOf(projectId, { plan });
}

/** A plan slot's topic (a post already made for it keeps its own text). */
export function setSlotTopic(slotId: string, topic: string, projectId = activeId()): void {
  const plan = projectOf(projectId)?.marketing.plan;
  if (!plan) return;
  updateMarketingOf(projectId, { plan: { ...plan, days: plan.days.map((d) => ({ ...d, slots: d.slots.map((s) => (s.id === slotId ? { ...s, topic } : s)) })) } });
}

// ───────────── the 7-day batch ─────────────

/** The plan slots that already have a post in this project's batch. */
export function coveredSlots(posts: Post[], projectId: string): Set<string> {
  return new Set(posts.filter((p) => p.projectId === projectId && p.source === 'batch').map((p) => p.planSlotId).filter((x): x is string => !!x));
}

/** The plan day the next batch starts on: the first with a slot that has no post yet (the plan's length when every slot has one). */
export function batchStart(plan: CampaignPlan, covered: Set<string>): number {
  const i = plan.days.findIndex((d) => d.slots.some((s) => !covered.has(s.id)));
  return i === -1 ? plan.days.length : i;
}

/** What the next 7-day batch is written from: the plan from its first day without posts, and the setup (null without a plan, or when every slot has a post). */
export function weekBatchInput(project: Project, covered: Set<string>): { plan: CampaignPlan; config: CampaignConfig; days: number } | null {
  const plan = project.marketing.plan;
  if (!plan) return null;
  const start = batchStart(plan, covered);
  if (start >= plan.days.length) return null;
  return { plan: { ...plan, days: plan.days.slice(start) }, config: project.marketing.campaign, days: 7 };
}

/** The batch's new posts go in as drafts, and the project remembers the batch. */
export function applyWeekBatch(posts: Post[], projectId = activeId()): void {
  if (!posts.length) return;
  // the setup's "Post Instagram videos as Trial Reels" (P4b): set on each new Instagram video post (never in the claude.ai build)
  const trial = !__ARTIFACT_BUILD__ && useStore.getState().projects.find((p) => p.id === projectId)?.marketing.campaign.instagramTrialReels === true;
  if (trial) posts = posts.map((p) => (p.platform === 'instagram' && canTrialReel(p) ? withShareMode(p, 'TRIAL_REELS_DONT_SHARE_TO_FOLLOWERS') : p));
  useStore.getState().addPosts(posts);
  updateMarketingOf(projectId, { batchId: posts[0].batchId });
}
