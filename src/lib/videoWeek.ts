// Weekly AI videos per business (shared/plans.json videosPerWeek: Launch 3, Grow 5, Scale unlimited). The server
// counts and decides (server/videoWeek.mjs); the app shows "2 of 3 videos used this week" in the video panel and the
// campaign setup, and warns when the chosen video days add up to more than the plan makes.
//
// A business's week runs Monday 00:00 to Sunday 23:59 in its time zone. Own-key videos never count.

import type { Entitlement, PlanAccount } from '@/lib/integrations/types';
import { tierName, videosPerWeekFor } from '@/lib/plans';

/** A business's videos this week, as the server answers (GET /api/ai/video/week, or a started video's videoWeek). */
export interface VideoWeek {
  used: number;
  /** null = unlimited, or plans not enforced (counted, never refused) */
  limit: number | null;
  resetsAt: string;
  enforced: boolean;
  /** false when the server couldn't read the count */
  known?: boolean;
}

/** What the plan allows a business a week, for the campaign setup's warning (null: nothing to say). */
export interface VideoAllowance {
  /** null = unlimited */
  perWeek: number | null;
  /** plans are on: going over is refused (otherwise only a warning) */
  enforced: boolean;
  /** the plan's name ("Launch") */
  planName: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What the plan allows: from the plan in force, else (plans not turned on yet) from the account's tier, so the setup
 * can warn ahead. null without a plan to go by, or for the owner.
 */
export function videoAllowance(plan: Entitlement | null | undefined, account: PlanAccount | null | undefined): VideoAllowance | null {
  if (plan && plan.plan !== 'legacy') {
    if (plan.plan === 'owner') return null;
    const perWeek = plan.features?.videosPerWeek !== undefined ? plan.features.videosPerWeek : videosPerWeekFor(plan.tier);
    return { perWeek: perWeek ?? null, enforced: true, planName: tierName(plan.tier) };
  }
  const tier = account?.tier;
  const perWeek = videosPerWeekFor(tier);
  if (!tier || perWeek == null) return null;
  return { perWeek, enforced: false, planName: tierName(tier) };
}

/** "2 of 3 videos used this week · resets Monday", or for no limit "4 videos this week" (null: nothing to show). */
export function videoWeekLine(w: VideoWeek | null | undefined): string | null {
  if (!w || w.known === false) return null;
  if (w.limit == null) return w.enforced ? `Unlimited AI videos · ${plural(w.used, 'video')} this week` : null;
  return `${w.used} of ${plural(w.limit, 'video')} used this week · resets Monday`;
}

/** The refusal's sentence: "You’ve made 3 of 3 videos this week. Resets Monday." */
export const videoWeekLimitText = (used: number, limit: number) => `You’ve made ${used} of ${plural(limit, 'video')} this week. Resets Monday.`;

/** Whether the week is used up (only while plans are on). */
export const videoWeekFull = (w: VideoWeek | null | undefined): boolean => !!w && w.enforced && w.limit != null && w.used >= w.limit;

/**
 * When the campaign's chosen video days add up to more AI videos a week than the plan makes for a business: the
 * sentence to show (null when they fit or there's no limit).
 */
export function videoDaysOverLimit(videosPerWeek: number, a: VideoAllowance | null | undefined): string | null {
  if (!a || a.perWeek == null || videosPerWeek <= a.perWeek) return null;
  return `You chose ${plural(videosPerWeek, 'video')} a week; ${a.planName} makes ${plural(a.perWeek, 'AI video')} a week for each business. Choose fewer video days${a.enforced ? '' : ' before plans start'}, or upgrade.`;
}
