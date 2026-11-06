// The campaign setup's video days: how many of each posting day's posts are AI videos (CampaignConfig.videoDays,
// Monday first). Setups saved before video days had one "videos per day" for every posting day; they're read as that
// count on each posting day (videoDaysOf), and saved that way once when the workspace opens (fillVideoDays).
//
// No store here: the local plan generator, the setup tab, the assistant and the cleanup all use these.

import type { CampaignConfig, Project } from './types';

type VideoSetup = Pick<CampaignConfig, 'days' | 'postsPerDay'> & { videoDays?: unknown; videosPerDay?: unknown };

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0);
const perDayOf = (cfg: Pick<CampaignConfig, 'postsPerDay'>) => Math.max(1, Math.min(5, count(cfg.postsPerDay) || 1));

/** Whether a setup already has its own video days (seven numbers). */
export const hasVideoDays = (cfg: { videoDays?: unknown }): boolean => Array.isArray(cfg.videoDays) && cfg.videoDays.length === 7 && cfg.videoDays.every((n) => typeof n === 'number' && Number.isFinite(n));

/**
 * The videos on each weekday (Monday first): 0 on days without posts, never more than the posts of the day. An older
 * setup's "videos per day" counts on each posting day.
 */
export function videoDaysOf(cfg: VideoSetup): number[] {
  const perDay = perDayOf(cfg);
  const old = Math.min(perDay, count(cfg.videosPerDay));
  const raw = hasVideoDays(cfg) ? (cfg.videoDays as number[]) : null;
  return Array.from({ length: 7 }, (_, i) => (cfg.days?.[i] ? Math.min(perDay, raw ? count(raw[i]) : old) : 0));
}

/** AI videos a week the setup asks for (the plan's videos land on these days). */
export const videosPerWeek = (cfg: VideoSetup): number => videoDaysOf(cfg).reduce((a, b) => a + b, 0);

/** The setup with its video days filled in, and the older "videos per day" dropped. */
export function withVideoDays<C extends VideoSetup>(cfg: C): Omit<C, 'videosPerDay'> & { videoDays: number[] } {
  const { videosPerDay: _old, ...rest } = cfg;
  return { ...rest, videoDays: videoDaysOf(cfg) };
}

/**
 * A change to the posting days, posts per day or video days, kept consistent: video days only on posting days and
 * never more than the posts of the day (a day turned on starts with no video).
 */
export function videoDaysPatch(cfg: VideoSetup, patch: Partial<Pick<CampaignConfig, 'days' | 'postsPerDay' | 'videoDays'>>): Pick<CampaignConfig, 'videoDays'> {
  const next = { ...cfg, ...patch, ...(patch.videoDays ? {} : { videoDays: videoDaysOf(cfg) }) };
  return { videoDays: videoDaysOf(next) };
}

/** Businesses whose setup has no video days yet get them (the same array back when nothing changed). */
export function fillVideoDays<P extends Pick<Project, 'marketing'>>(projects: P[]): P[] {
  const stale = (p: P) => !!p.marketing?.campaign && (!hasVideoDays(p.marketing.campaign) || 'videosPerDay' in p.marketing.campaign);
  if (!projects.some(stale)) return projects;
  return projects.map((p) => (stale(p) ? { ...p, marketing: { ...p.marketing, campaign: withVideoDays(p.marketing.campaign) as CampaignConfig } } : p));
}
