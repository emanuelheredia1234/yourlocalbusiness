// The app's billing actions: start Stripe Checkout, open the Customer Portal, change the plan. Each write goes to the
// server once per user action (a clientRequestId the server turns into Stripe's Idempotency-Key); nothing here
// retries a write. A "being confirmed" answer is read back later (getPlan / getBusinesses), never re-sent.

import { changePlan, IntegrationApiError, newRequestId, openPortal, resumePlan, startCheckout } from '@/lib/integrations/api';
import type { PlanInterval, PlanTier } from '@/lib/integrations/types';
import { formatPrice, isTier, planFor, tierName, tierRank, type Interval, type Tier } from '@/lib/plans';
import { navigate } from '@/lib/router';
import { useBilling } from '@/store/billing';
import { toast, useUI } from '@/store/ui';
import { confirmAction } from '@/components/ui/primitives';

/** Leave the app for Stripe (a test replaces it). */
export let goTo = (url: string): void => {
  location.assign(url);
};
export function setGoTo(fn: (url: string) => void): void {
  goTo = fn;
}

const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

/**
 * The request id of a Checkout that may have reached Stripe (it answered "try again in a minute", or the connection
 * dropped): the next press for the same choice reuses it, so Stripe hands back the same page instead of a second one.
 */
let unsure: { choice: string; id: string } | null = null;

/** Start Stripe Checkout for a plan: the browser goes to Stripe's page. Resolves false when it didn't. */
export async function checkout(tier: Tier, interval: Interval, extraBusinesses?: number): Promise<boolean> {
  const choice = `${tier}:${interval}:${extraBusinesses ?? ''}`;
  const id = unsure?.choice === choice ? unsure.id : newRequestId();
  try {
    const { url } = await startCheckout({ tier, interval, clientRequestId: id, ...(extraBusinesses !== undefined ? { extraBusinesses } : {}) });
    unsure = null;
    goTo(url);
    return true;
  } catch (e) {
    const err = e instanceof IntegrationApiError ? e : null;
    unsure = err && (err.code === 'BILLING_PENDING' || err.code === 'NETWORK') ? { choice, id } : null;
    if (err?.code === 'ALREADY_SUBSCRIBED') {
      toast({ kind: 'info', title: err.message, action: { label: 'Open Plan', run: openPlanSettings } });
      void useBilling.getState().refresh();
    } else toast({ kind: 'error', title: err?.message ?? 'Couldn’t start checkout. Try again shortly.' });
    return false;
  }
}

/** "Manage billing": Stripe's Customer Portal (card, invoices, cancelling). */
export async function manageBilling(): Promise<boolean> {
  try {
    const { url } = await openPortal(newRequestId());
    goTo(url);
    return true;
  } catch (e) {
    toast({ kind: 'error', title: e instanceof IntegrationApiError ? e.message : 'Couldn’t open billing. Try again shortly.' });
    return false;
  }
}

/** Settings › Plan. */
export function openPlanSettings(): void {
  useUI.getState().setSettingsTab('plan');
  void navigate('workspace-settings', { force: true });
}

export type PlanChangeKind = 'same' | 'upgrade' | 'downgrade' | 'to_year' | 'to_month' | 'down_to_year';

/**
 * What switching from the current plan to tier/interval is (upgrades and month → year are now; downgrades at renewal).
 * A lower plan and yearly at once ('down_to_year') isn't one step: yearly is charged now, a lower plan waits for renewal.
 */
export function changeKind(fromTier: string | null | undefined, fromInterval: string | null | undefined, tier: Tier, interval: Interval): PlanChangeKind {
  if (fromTier === tier && fromInterval === interval) return 'same';
  if (fromInterval === 'year' && interval === 'month') return 'to_month';
  if (fromInterval === 'month' && interval === 'year') return tierRank(tier) < tierRank(fromTier) ? 'down_to_year' : 'to_year';
  return tierRank(tier) > tierRank(fromTier) ? 'upgrade' : 'downgrade';
}

/** The confirm's words for a plan change. */
export function changeConfirm(kind: PlanChangeKind, tier: Tier, interval: Interval, renewsAt: string | null, fromTier: string | null | undefined, keptTier?: string | null): { title: string; body: string; confirmLabel: string } | null {
  const name = planFor(tier).name;
  const price = `${formatPrice(planFor(tier).price[interval])}/${interval}`;
  // back up to (or below) the plan already paid for this period: nothing is charged now
  if (kind === 'upgrade' && keptTier && tierRank(tier) <= tierRank(keptTier)) {
    return { title: `Switch to ${name} now?`, body: `There’s no charge: you’ve paid for ${tierName(keptTier)} until your renewal${renewsAt ? ` on ${fmtDate(renewsAt)}` : ''}. Then ${price}.`, confirmLabel: `Switch to ${name}` };
  }
  switch (kind) {
    case 'upgrade':
    case 'to_year':
      return { title: `Switch to ${name}${interval === 'year' ? ' yearly' : ''} now?`, body: `${price}. You’ll be charged the prorated difference today, and your new features start right away.`, confirmLabel: `Switch to ${name}` };
    case 'downgrade':
      return {
        title: `Switch to ${name} at renewal?`,
        body: `${price} from your next renewal${renewsAt ? ` on ${fmtDate(renewsAt)}` : ''}. You keep ${tierName(keptTier && tierRank(keptTier) > tierRank(fromTier) ? keptTier : fromTier)} until then. There’s no refund for the rest of this period.`,
        confirmLabel: `Switch to ${name}`,
      };
    default:
      return null;
  }
}

/**
 * Change a live plan: asks first, then sends the change once. Year → month isn't self-serve (support does it at
 * renewal). No plan yet: Checkout instead.
 */
export async function confirmPlanChange(tier: Tier, interval: Interval): Promise<boolean> {
  const b = useBilling.getState();
  const acct = b.account;
  if (!acct || acct.source !== 'stripe' || !['active', 'trialing'].includes(acct.status)) {
    if (acct?.status === 'past_due' || acct?.status === 'unpaid') {
      toast({ kind: 'error', title: 'Update your card first.', action: { label: 'Update card', run: () => void manageBilling() } });
      return false;
    }
    return checkout(tier, interval);
  }
  const kind = changeKind(acct.tier, acct.interval, tier, interval);
  if (kind === 'same') return false;
  const refused = changeRefusal(kind, tier, acct.pendingDowngrade ? b.plan?.tier : null);
  if (refused) {
    toast({ kind: 'info', title: refused });
    return false;
  }
  const words = changeConfirm(kind, tier, interval, acct.currentPeriodEnd, acct.tier, acct.pendingDowngrade ? b.plan?.tier : null);
  // the id is made with the question: pressing the confirm twice is still one change
  const clientRequestId = newRequestId();
  if (!words || !(await confirmAction(words))) return false;
  try {
    const out = await changePlan({ tier: tier as PlanTier, interval: interval as PlanInterval, clientRequestId, confirm: true });
    await useBilling.getState().refresh();
    if (out.op?.state === 'done' || out.ok) toast({ kind: 'success', title: kind === 'downgrade' ? `You’ll switch to ${planFor(tier).name} at renewal.` : `You’re on ${planFor(tier).name}.` });
    else toast({ kind: 'info', title: 'We’re confirming your payment. This takes a minute.', action: { label: 'Open Plan', run: openPlanSettings } });
    return true;
  } catch (e) {
    const err = e instanceof IntegrationApiError ? e : null;
    if (err?.code === 'CARD_DECLINED' || err?.code === 'PAYMENT_REQUIRED') useBilling.getState().showUpgrade({ code: err.code, message: err.message });
    else toast({ kind: 'error', title: err?.message ?? 'Couldn’t change your plan. Try again shortly.' });
    void useBilling.getState().refresh();
    return false;
  }
}

/**
 * Why a change isn't self-serve as one step (the server refuses the same), or null. keptTier: the higher plan paid for
 * until renewal while a downgrade waits (Entitlement.tier then).
 */
export function changeRefusal(kind: PlanChangeKind, tier: Tier, keptTier?: string | null): string | null {
  if (kind === 'to_month') return 'Switching from yearly to monthly happens at renewal: contact support.';
  if (kind === 'down_to_year') return `Choose ${planFor(tier).name} monthly first (it starts at renewal). You can switch to yearly after that.`;
  if (keptTier && isTier(keptTier)) {
    if (kind === 'to_year') return `You’re moving to a lower plan at renewal. Switch back to ${tierName(keptTier)} first, then to yearly.`;
    if (kind === 'upgrade' && tierRank(tier) > tierRank(keptTier)) return `You’ve paid for ${tierName(keptTier)} until renewal. Switch back to it first (no charge), then upgrade.`;
  }
  return null;
}

/** The tier to offer in "Upgrade to …": the server's need, else the next tier up. */
export function upgradeTier(need: string | undefined, current: string | null | undefined): Tier | null {
  if (isTier(need) && tierRank(need) > tierRank(current)) return need;
  const next = (['launch', 'grow', 'scale'] as Tier[]).find((t) => tierRank(t) > tierRank(current));
  return next ?? null;
}

/** The id of a "Keep my plan" that may have reached Stripe: the next press sends the same one (never a second write). */
let unsureResume: string | null = null;

/** "Keep my plan": undo a cancel at the period's end. One request per press; an unclear answer keeps its id. */
export async function keepPlan(): Promise<boolean> {
  const id = unsureResume ?? newRequestId();
  try {
    const out = await resumePlan(id);
    unsureResume = null;
    await useBilling.getState().refresh();
    toast(out.op?.state === 'done' || out.ok ? { kind: 'success', title: 'You’re keeping your plan.' } : { kind: 'info', title: 'We’re confirming your change. This takes a minute.' });
    return true;
  } catch (e) {
    const err = e instanceof IntegrationApiError ? e : null;
    unsureResume = err && (err.code === 'BILLING_PENDING' || err.code === 'NETWORK') ? id : null;
    toast({ kind: 'error', title: err?.message ?? 'Couldn’t keep your plan just now. Try again shortly.' });
    void useBilling.getState().refresh();
    return false;
  }
}
