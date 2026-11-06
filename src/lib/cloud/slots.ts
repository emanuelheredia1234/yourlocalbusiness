// Business slots: every business (project) takes one of the plan's slots before it's created, so the account never
// holds more businesses than the plan allows (the database refuses saving a project without one once plans are
// enforced). claimSlot asks the database (claim_project_slot, which serialises claims per user); it's idempotent for
// the same project id.
//
// Skipped (always ok) in the artifact build, signed out or as a guest, and while plans aren't enforced. A network
// failure is never treated as ok: nothing is created without the database's answer.

import { useAuth, marketAccess } from './auth';
import { useBilling } from '@/store/billing';

export type SlotReason = 'limit' | 'plan_required' | 'locked' | 'bad_request' | 'offline';

export interface SlotResult {
  ok: boolean;
  reason?: SlotReason;
  state?: 'active' | 'locked';
  used?: number;
  /** null: unlimited */
  limit?: number | null;
  /** true when no claim was needed (artifact, guest, plans off) */
  skipped?: boolean;
}

const isArtifact = () => typeof __ARTIFACT_BUILD__ !== 'undefined' && __ARTIFACT_BUILD__;

/** Whether creating a business needs a slot claimed first. */
export function slotsNeeded(): boolean {
  if (isArtifact()) return false;
  if (useAuth.getState().phase !== 'ready') return false;
  return useBilling.getState().enforce === true;
}

export async function claimSlot(projectId: string): Promise<SlotResult> {
  if (!slotsNeeded()) return { ok: true, skipped: true };
  const access = marketAccess();
  if (!access) return { ok: false, reason: 'offline' };
  try {
    const { data, error } = await access.client.rpc('claim_project_slot', { p_project_id: projectId });
    if (error) return { ok: false, reason: 'offline' };
    const r = (data ?? {}) as { ok?: boolean; reason?: string; state?: string; used?: number; limit?: number | null };
    if (r.ok === true) {
      return { ok: true, state: r.state === 'locked' ? 'locked' : 'active', ...(typeof r.used === 'number' ? { used: r.used } : {}), ...(r.limit !== undefined ? { limit: r.limit } : {}) };
    }
    const reason: SlotReason = r.reason === 'limit' || r.reason === 'plan_required' || r.reason === 'locked' || r.reason === 'bad_request' ? r.reason : 'offline';
    return { ok: false, reason, ...(typeof r.used === 'number' ? { used: r.used } : {}), ...(r.limit !== undefined ? { limit: r.limit } : {}) };
  } catch {
    return { ok: false, reason: 'offline' };
  }
}

/** Our words for a refused claim (the toast; limit and plan_required open the dialogs instead). */
export function slotMessage(r: SlotResult): string {
  switch (r.reason) {
    case 'limit':
      return `Your plan includes ${r.limit ?? 1} ${r.limit === 1 ? 'business' : 'businesses'}. Add one in Settings › Plan.`;
    case 'plan_required':
      return 'Choose a plan to add a business.';
    case 'locked':
      return 'That business is locked on your plan. Add a business in Settings › Plan to use it again.';
    case 'bad_request':
      return 'Couldn’t start that business. Try again.';
    default:
      return 'Couldn’t reach your account to start a business. Check your connection and try again.';
  }
}
