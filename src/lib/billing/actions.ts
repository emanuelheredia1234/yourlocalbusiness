// The app's billing actions: start Stripe Checkout, open the Customer Portal, change the plan. Each write goes to the
// server once per user action (a clientRequestId the server turns into Stripe's Idempotency-Key); nothing here
// retries a write. A "being confirmed" answer is read back later (getPlan / getBusinesses), never re-sent.

import { changePlan, IntegrationApiError, newRequestId, openPortal, startCheckout } from '@/lib/integrations/api';
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

export type PlanChangeKind = 'same' | 'upgrade' | 'downgrade' | 'to_year' | 'to_month';

/** What switching from the current plan to tier/interval is (upgrades and month → year are now; downgrades at renewal). */
export function changeKind(fromTier: string | null | undefined, fromInterval: string | null | undefined, tier: Tier, interval: Interval): PlanChangeKind {
  if (fromTier === tier && fromInterval === interval) return 'same';
  if (fromInterval === 'year' && interval === 'month') return 'to_month';
  if (fromInterval === 'month' && interval === 'year') return tierRank(tier) < tierRank(fromTier) ? 'downgrade' : 'to_year';
  return tierRank(tier) > tierRank(fromTier) ? 'upgrade' : 'downgrade';
}

/** The confirm's words for a plan change. */
export function changeConfirm(kind: PlanChangeKind, tier: Tier, interval: Interval, renewsAt: string | null, fromTier: string | null | undefined): { title: string; body: string; confirmLabel: string } | null {
  const name = planFor(tier).name;
  const price = `${formatPrice(planFor(tier).price[interval])}/${interval}`;
  switch (kind) {
    case 'upgrade':
    case 'to_year':
      return { title: `Switch to ${name}${interval === 'year' ? ' yearly' : ''} now?`, body: `${price}. You’ll be charged the prorated difference today, and your new features start right away.`, confirmLabel: `Switch to ${name}` };
    case 'downgrade':
      return {
        title: `Switch to ${name} at renewal?`,
        body: `${price} from your next renewal${renewsAt ? ` on ${fmtDate(renewsAt)}` : ''}. You keep ${tierName(fromTier)} until then. There’s no refund for the rest of this period.`,
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
  if (kind === 'to_month') {
    toast({ kind: 'info', title: 'Switching from yearly to monthly happens at renewal: contact support.' });
    return false;
  }
  const words = changeConfirm(kind, tier, interval, acct.currentPeriodEnd, acct.tier);
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

/** The tier to offer in "Upgrade to …": the server's need, else the next tier up. */
export function upgradeTier(need: string | undefined, current: string | null | undefined): Tier | null {
  if (isTier(need) && tierRank(need) > tierRank(current)) return need;
  const next = (['launch', 'grow', 'scale'] as Tier[]).find((t) => tierRank(t) > tierRank(current));
  return next ?? null;
}
