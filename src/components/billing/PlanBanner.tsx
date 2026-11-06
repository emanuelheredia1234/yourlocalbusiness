// The plan's one banner above every page (grace, payment, trial ending, cancelling, ended), and the watcher that
// keeps the plan fresh: after sign-in, when the tab comes back after 5 minutes, and when the user comes back from
// Stripe Checkout. Nothing in the artifact build or without Stripe set up on the server.

import { useEffect, useState } from 'react';
import { navigate } from '@/lib/router';
import { checkout, manageBilling, openPlanSettings } from '@/lib/billing/actions';
import { installUpgradeListener } from '@/lib/billing/upgrade';
import { tierName } from '@/lib/plans';
import { useAuth } from '@/lib/cloud/auth';
import { useSyncStatus } from '@/lib/cloud/sync';
import { clearPlanIntent, hasLivePlan, readPlanIntent, takeCheckoutReturn, useBilling, useBillingOn } from '@/store/billing';
import { toast } from '@/store/ui';
import { Callout } from '@/components/ui/primitives';
import type { PlanBanner as BannerKind } from '@/lib/integrations/types';

const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'soon');

export const REFRESH_AFTER_MS = 5 * 60_000;

/** After Checkout: "You're on Grow." once the plan shows it; still processing → a toast with a refresh. */
async function afterCheckout(sessionId: string): Promise<void> {
  const r = await useBilling.getState().refresh({ sessionId });
  const acct = r?.account;
  if (r && acct && ['active', 'trialing'].includes(acct.status)) {
    toast({ kind: 'success', title: `You’re on ${tierName(acct.tier)}.` });
    return;
  }
  toast({
    kind: 'info',
    title: 'Payment is still processing',
    body: 'Your plan starts as soon as Stripe confirms it.',
    action: { label: 'Refresh', run: () => void afterCheckout(sessionId) },
  });
}

/** Keeps the plan fresh, finishes a plan chosen before signing up, and listens for plan refusals. */
export function useBillingWatcher(): void {
  const on = useBillingOn();
  const phase = useAuth((s) => s.phase);
  useEffect(() => {
    if (on) installUpgradeListener();
  }, [on]);
  useEffect(() => {
    if (!on || phase !== 'ready') return;
    let gone = false;
    void (async () => {
      const sessionId = takeCheckoutReturn();
      if (sessionId) return afterCheckout(sessionId);
      const r = await useBilling.getState().refresh();
      if (gone || !r) return;
      // a plan chosen on #plans before signing up: on to Stripe Checkout (only without a plan already)
      const intent = readPlanIntent();
      if (!intent) return;
      clearPlanIntent();
      if (!hasLivePlan(r.plan, r.account) && r.plan.plan !== 'owner') await checkout(intent.tier, intent.interval);
    })();
    const again = () => {
      if (document.visibilityState === 'visible' && Date.now() - useBilling.getState().loadedAt >= REFRESH_AFTER_MS) void useBilling.getState().refresh();
    };
    document.addEventListener('visibilitychange', again);
    return () => {
      gone = true;
      document.removeEventListener('visibilitychange', again);
    };
  }, [on, phase]);
}

const DISMISS_KEY = 'ylb-plan-banner-dismissed';

function dismissed(kind: string): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === kind;
  } catch {
    return false;
  }
}

export function PlanBanner() {
  const on = useBillingOn();
  const plan = useBilling((s) => s.plan);
  const account = useBilling((s) => s.account);
  const held = useSyncStatus((s) => s.held.length);
  const [hidden, setHidden] = useState<string | null>(null);
  if (!on || !plan) return null;
  const kind: BannerKind | null = plan.banner;
  if (!kind) {
    if (!held) return null;
    return (
      <Callout tone="warn" className="mb-5" action={<button type="button" className="btn btn-secondary btn-xs" onClick={() => openPlanSettings()}>Open Plan</button>}>
        {held === 1 ? 'A business isn’t' : `${held} businesses aren’t`} saved to your account: your plan has no free business slot.
      </Callout>
    );
  }
  if (hidden === kind || dismissed(kind)) return null;
  const hide = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, kind);
    } catch {
      /* hidden for this view only */
    }
    setHidden(kind);
  };
  const portal = (label: string) => (
    <button type="button" className="btn btn-secondary btn-xs" onClick={() => void manageBilling()}>
      {label}
    </button>
  );
  const plans = (label: string) => (
    <button type="button" className="btn btn-secondary btn-xs" onClick={() => void navigate('plans', { force: true })}>
      {label}
    </button>
  );
  switch (kind) {
    case 'grace':
      return (
        <Callout tone="warn" className="mb-5" action={portal('Update card')} onDismiss={hide}>
          Your payment didn’t go through. Update your card by {fmtDate(plan.graceUntil ?? account?.graceUntil)} to keep everything running.
        </Callout>
      );
    case 'payment':
      return (
        <Callout tone="bad" className="mb-5" action={portal('Update card')}>
          Your last payment didn’t go through, so paid actions are paused. Update your card to keep going.
        </Callout>
      );
    case 'trial_ending':
      return (
        <Callout tone="info" className="mb-5" action={account?.source === 'comp' ? plans('Pick a plan') : portal('Manage billing')} onDismiss={hide}>
          {account?.source === 'comp' ? `Free ${tierName(plan.tier)} until ${fmtDate(plan.trialEndsAt ?? account?.compUntil)}. Pick a plan to keep going.` : `Your trial ends on ${fmtDate(plan.trialEndsAt ?? account?.trialEndsAt)}.`}
        </Callout>
      );
    case 'cancel_at_period_end':
      return (
        <Callout tone="info" className="mb-5" action={portal('Keep my plan')} onDismiss={hide}>
          Your plan ends on {fmtDate(account?.currentPeriodEnd)}. Published pages keep working for 30 days after that.
        </Callout>
      );
    case 'plan_ended':
      return (
        <Callout tone="warn" className="mb-5" action={plans('See plans')}>
          Your plan has ended. Your work is kept; choose a plan to keep using paid features.
        </Callout>
      );
    default:
      return null;
  }
}
