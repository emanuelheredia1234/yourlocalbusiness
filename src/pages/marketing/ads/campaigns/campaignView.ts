// What a launched campaign shows and offers, decided in one place (pure): its state badge, the job that is still
// going or unknown, and which manage actions are open (each with the reason when not). The server checks every
// rule again; this only keeps buttons honest.
import type { ChangeAction, LaunchedCampaign } from '@/lib/ads/launchTypes';
import { MANAGER_LABEL, PLATFORM_LABEL } from '@/lib/ads/launchTypes';

export type Tone = 'good' | 'warn' | 'bad' | 'primary' | 'faint';

const STATE: Record<LaunchedCampaign['state'], { label: string; tone: Tone }> = {
  launching: { label: 'Launching', tone: 'primary' },
  in_review: { label: 'In review', tone: 'primary' },
  active: { label: 'Running', tone: 'good' },
  paused: { label: 'Paused', tone: 'faint' },
  rejected: { label: 'Not approved', tone: 'bad' },
  with_issues: { label: 'Running with limits', tone: 'warn' },
  completed: { label: 'Finished', tone: 'faint' },
  ended: { label: 'Ended', tone: 'faint' },
  failed: { label: 'Not launched', tone: 'bad' },
  unknown: { label: 'Not confirmed', tone: 'warn' },
};

export function stateBadge(c: LaunchedCampaign): { label: string; tone: Tone } {
  if (c.pendingJob?.state === 'sending' || c.pendingJob?.state === 'queued') return { label: c.pendingJob.kind === 'launch' ? 'Launching' : 'Sending', tone: 'primary' };
  if (c.pendingJob?.state === 'unknown') return { label: 'Not confirmed', tone: 'warn' };
  if (c.state === 'active' && c.learning === 'FAIL') return { label: 'Running · Learning limited', tone: 'warn' };
  return STATE[c.state] ?? { label: c.state, tone: 'faint' };
}

/** The job whose outcome isn't known: only Check status is offered, never "Try again" (R8). */
export const unknownJob = (c: LaunchedCampaign) => (c.pendingJob?.state === 'unknown' ? c.pendingJob : null);
export const sendingJob = (c: LaunchedCampaign) => (c.pendingJob && (c.pendingJob.state === 'sending' || c.pendingJob.state === 'queued') ? c.pendingJob : null);

/** "Launch again" only after a definite "it wasn't created" (NOT_CREATED, PARTIAL_LEFT or a refused create). */
export function canLaunchAgain(c: LaunchedCampaign): boolean {
  if (c.state !== 'failed' || c.pendingJob) return false;
  const code = c.lastJob?.code;
  return c.lastJob?.state === 'failed' && (!code || code === 'NOT_CREATED' || code === 'PARTIAL_LEFT' || code === 'CREATE_FAILED' || code === 'REFUSED' || !/UNKNOWN|INTERRUPTED/.test(code));
}

/**
 * "Remove" only for a failed launch the server says left nothing at Meta or Google (no platform id, no job sending
 * or unknown, nothing left behind). Removing touches our list only; the server checks every rule again.
 */
export function canRemove(c: LaunchedCampaign): boolean {
  return c.canRemove === true && c.state === 'failed' && !c.platformCampaignId && !c.pendingJob && !c.lastJob?.leftBehind?.length && c.lastJob?.state !== 'unknown';
}

/** The confirm's words for removing a failed launch. */
export const removeConfirmText = (c: LaunchedCampaign) => ({
  title: 'Remove this failed launch?',
  body: `Nothing was created at ${PLATFORM_LABEL[c.platform]}, so nothing changes there.`,
  confirmLabel: 'Remove',
  danger: true,
});

export interface ActionView {
  action: ChangeAction;
  label: string;
  enabled: boolean;
  reason?: string;
  danger?: boolean;
}

/** The Manage drawer's buttons, with the reason a button is off. */
export function manageActions(c: LaunchedCampaign): ActionView[] {
  const P = PLATFORM_LABEL[c.platform];
  const live = c.pendingJob ? (c.pendingJob.state === 'unknown' ? 'A change to this campaign isn’t confirmed yet. Check its status first.' : 'A change to this campaign is still being sent.') : null;
  const final = c.state === 'ended' || c.state === 'completed' || c.state === 'failed';
  const notLaunched = !c.platformCampaignId ? `It isn’t on ${P} yet.` : null;
  const finalWhy = c.state === 'ended' ? 'This campaign has ended. Launch the plan again to run it again.' : c.state === 'completed' ? 'This campaign has finished.' : 'This campaign wasn’t launched.';
  const off = (why: string | null) => (why ? { enabled: false, reason: why } : { enabled: true });
  const on = c.configuredStatus === 'ACTIVE';
  const out: ActionView[] = [];
  // pause and end stay open whatever the limits say (R7); only a live job or "not on the platform" stops them
  if (!final) out.push({ action: 'pause', label: 'Pause', ...off(live ?? notLaunched ?? (on ? null : 'It’s already paused.')) });
  if (!final) out.push({ action: 'resume', label: 'Resume', ...off(live ?? notLaunched ?? (c.state === 'rejected' ? `${P} didn’t approve the ad. Swap the ad first.` : on && !c.adsOff && !c.adSetOff ? 'It’s already on.' : null)) });
  out.push({ action: 'budget', label: 'Change daily budget', ...off(final ? finalWhy : live ?? notLaunched) });
  out.push({ action: 'end_date', label: 'Change end date', ...off(c.platform === 'google' ? 'Google doesn’t allow changing the dates after launch. Pause or end it instead.' : final ? finalWhy : live ?? notLaunched) });
  out.push({ action: 'creative', label: c.platform === 'google' ? 'Swap ad text' : 'Swap ad', ...off(final ? finalWhy : live ?? notLaunched) });
  if (c.state !== 'ended' && c.state !== 'failed') out.push({ action: 'end', label: 'End campaign', danger: true, ...off(live ?? notLaunched) });
  return out;
}

export const managerName = (c: LaunchedCampaign) => MANAGER_LABEL[c.platform];

/** Allowlisted Ads Manager links only (built by the server from ids). */
export function managerLink(c: LaunchedCampaign): string | null {
  const url = c.openInManagerUrl;
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'business.facebook.com' || u.hostname === 'ads.google.com') ? u.toString() : null;
  } catch {
    return null;
  }
}
