// The signed-in user's plan, businesses and AI credits (server/billing/stripe.mjs), and the plan dialogs' state.
// Not persisted: the server is the record. Refreshed after sign-in, when the tab comes back after 5 minutes or more,
// after any billing action, and when the user comes back from Stripe Checkout (?billing=success&session_id=…).
//
// Nothing here in the artifact build, or while the server hasn't set up Stripe (isBillingUi).

import { create } from 'zustand';
import type { BusinessesResponse, Entitlement, PlanAccount, PlanCredits, PlanResponse, TrialOffer } from '@/lib/integrations/types';
import { getBusinesses, getPlan, IntegrationApiError } from '@/lib/integrations/api';
import { useBillingConfig } from '@/lib/billing/config';
import { isBillingUi } from '@/lib/plans';
import { useAuth } from '@/lib/cloud/auth';

/** What the Add a business dialog does once a business is bought (create the project it was opened for, …). */
export type AfterAdd = () => void | Promise<void>;

/** The server's refusal shown by the upgrade prompt (one at a time). */
export interface UpgradeRequest {
  code: 'PLAN_REQUIRED' | 'PAYMENT_REQUIRED' | 'CREDITS_USED' | 'BUSINESS_LIMIT' | 'CARD_DECLINED' | 'VIDEO_WEEK_LIMIT' | 'EXPERIMENT_LIMIT';
  message: string;
  need?: { feature?: string; tier?: string };
  resetsAt?: string;
  /** the time zone resetsAt is shown in (the business's week, for VIDEO_WEEK_LIMIT) */
  timeZone?: string;
  /** CREDITS_USED during a card trial: its allowance is fixed (nothing to add until it ends) */
  trial?: boolean;
}

interface BillingState {
  /** from the last plan read (falls back to /api/config) */
  enforce: boolean;
  plan: Entitlement | null;
  account: PlanAccount | null;
  businesses: BusinessesResponse | null;
  credits: PlanCredits | null;
  /** the card trial this person may start (null: not known yet, or an older server) */
  trial: TrialOffer | null;
  /** Cancel plan and Keep my plan run in the app (false: they open the Customer Portal; the server isn't ready) */
  cancelInApp: boolean;
  loading: boolean;
  error: string | null;
  loadedAt: number;
  /** the Add a business dialog: open, and what happens after a business is added */
  addOpen: boolean;
  afterAdd: AfterAdd | null;
  upgrade: UpgradeRequest | null;

  /** Read the plan (and the businesses) again. sessionId: a Checkout Session the user came back from. */
  refresh: (opts?: { sessionId?: string }) => Promise<PlanResponse | null>;
  /** Free business slots (Infinity when unlimited or plans aren't enforced). */
  slotsLeft: () => number;
  /** Whether a business is locked by the plan (read-only until a slot frees up). */
  isLocked: (projectId: string) => boolean;
  openAddBusiness: (after?: AfterAdd) => void;
  closeAddBusiness: () => void;
  showUpgrade: (req: UpgradeRequest) => void;
  closeUpgrade: () => void;
  reset: () => void;
}

const EMPTY = { plan: null, account: null, businesses: null, credits: null, trial: null, cancelInApp: true, loading: false, error: null, loadedAt: 0 };

export const useBilling = create<BillingState>((set, get) => ({
  enforce: useBillingConfig.getState().enforce,
  ...EMPTY,
  addOpen: false,
  afterAdd: null,
  upgrade: null,

  refresh: async (opts = {}) => {
    if (!billingOn() || useAuth.getState().phase !== 'ready') return null;
    set({ loading: true });
    try {
      const plan = await getPlan(opts.sessionId);
      // the businesses list carries the price, the pending removal and any money operation being confirmed
      const businesses = await getBusinesses().catch(() => null);
      set({
        enforce: plan.billing.enforce,
        plan: plan.plan,
        account: plan.account,
        credits: plan.credits,
        trial: plan.trial ?? null,
        cancelInApp: plan.billing.cancelInApp !== false,
        businesses: businesses ?? {
          limit: plan.businesses.limit,
          used: plan.businesses.used,
          slots: plan.businesses.slots,
          extraBusinesses: plan.account?.extraBusinesses ?? 0,
          pricePerBusiness: { month: 9700, year: 97000 },
          interval: plan.account?.interval ?? null,
          pendingRemove: plan.account?.pendingRemove ?? null,
          op: null,
        },
        loading: false,
        error: null,
        loadedAt: Date.now(),
      });
      useBillingConfig.setState({ enforce: plan.billing.enforce });
      return plan;
    } catch (e) {
      set({ loading: false, error: e instanceof IntegrationApiError ? e.message : 'Couldn’t read your plan. Try again shortly.' });
      return null;
    }
  },

  slotsLeft: () => {
    const { enforce, businesses } = get();
    if (!enforce || !businesses || businesses.limit == null) return Infinity;
    return Math.max(0, businesses.limit - businesses.used);
  },

  isLocked: (projectId) => {
    if (!get().enforce) return false;
    return !!get().businesses?.slots.some((s) => s.projectId === projectId && s.state === 'locked');
  },

  openAddBusiness: (after) => set({ addOpen: true, afterAdd: after ?? null }),
  closeAddBusiness: () => set({ addOpen: false, afterAdd: null }),
  showUpgrade: (upgrade) => {
    // one at a time: a second refusal while one is open is the same story
    if (!get().upgrade) set({ upgrade });
  },
  closeUpgrade: () => set({ upgrade: null }),
  reset: () => set({ ...EMPTY, addOpen: false, afterAdd: null, upgrade: null }),
}));

/** Plans are shown (not the artifact build; Stripe set up on the server). */
export const billingOn = (): boolean => isBillingUi(useBillingConfig.getState());

/** React: whether plans are shown. */
export function useBillingOn(): boolean {
  return isBillingUi(useBillingConfig());
}

/** Statuses of a subscription that is still going (Checkout refuses a second one). */
export const LIVE_STATUSES = ['trialing', 'active', 'past_due', 'unpaid', 'incomplete'];

/** Whether the user has a plan that's going (a paid one, a free one, or the owner's). */
export function hasLivePlan(plan: Entitlement | null, account: PlanAccount | null): boolean {
  if (!plan) return false;
  if (plan.plan === 'owner') return true;
  if (account?.source === 'comp') return plan.active;
  return !!account && LIVE_STATUSES.includes(account.status);
}

// ───────────── coming back from Stripe Checkout ─────────────

const SESSION_ID = /^cs_(test_|live_)?[A-Za-z0-9_]{6,255}$/;

/**
 * The Checkout Session the user just came back from (?billing=success&session_id=cs_…), once: the address loses
 * the query. Null when there's none.
 */
export function takeCheckoutReturn(): string | null {
  if (typeof location === 'undefined') return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return null;
  }
  if (params.get('billing') !== 'success') return null;
  const id = params.get('session_id');
  params.delete('billing');
  params.delete('session_id');
  const rest = params.toString();
  try {
    history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
  } catch {
    /* the plan is still read */
  }
  return id && SESSION_ID.test(id) ? id : null;
}

// ───────────── a plan chosen before signing up ─────────────

const INTENT_KEY = 'ylb-plan-intent';

export interface PlanIntent {
  tier: 'launch' | 'grow' | 'scale';
  interval: 'month' | 'year';
}

export function savePlanIntent(intent: PlanIntent): void {
  try {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent));
  } catch {
    /* storage blocked: they choose again after signing up */
  }
}

export function readPlanIntent(): PlanIntent | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(INTENT_KEY) || 'null') as Partial<PlanIntent> | null;
    if (v && ['launch', 'grow', 'scale'].includes(v.tier as string) && (v.interval === 'month' || v.interval === 'year')) return { tier: v.tier as PlanIntent['tier'], interval: v.interval };
  } catch {
    /* none */
  }
  return null;
}

export function clearPlanIntent(): void {
  try {
    sessionStorage.removeItem(INTENT_KEY);
  } catch {
    /* ignore */
  }
}

/** The trial a person is offered now: from their plan once read, else what the server offers new sign-ups. */
export function trialOffered(state: Pick<BillingState, 'trial' | 'plan'>, config: { trialDays: number }): number {
  if (state.trial) return state.trial.eligible ? state.trial.days : 0;
  // not read yet (signed out, or loading): a new sign-up is offered the server's trial
  if (!state.plan) return config.trialDays;
  return 0;
}

/** React: the trial days to offer here (0: none). */
export function useTrialDays(): number {
  const trial = useBilling((s) => s.trial);
  const plan = useBilling((s) => s.plan);
  const days = useBillingConfig((c) => c.trialDays);
  return trialOffered({ trial, plan }, { trialDays: days });
}
