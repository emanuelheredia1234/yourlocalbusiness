// The upgrade prompt: one dialog for a paid action the plan refused (402 PLAN_REQUIRED / PAYMENT_REQUIRED /
// CREDITS_USED / BUSINESS_LIMIT / CARD_DECLINED, and the ads gate's 403 PLAN_REQUIRED). The server's sentence is
// shown as is (it's ours, never Stripe's). Nothing is retried after an upgrade: the user presses the action again.

import { setPlanRefusalListener } from '@/ai/claude';
import { billingOn, useBilling, type UpgradeRequest } from '@/store/billing';

const CODES = new Set<UpgradeRequest['code']>(['PLAN_REQUIRED', 'PAYMENT_REQUIRED', 'CREDITS_USED', 'BUSINESS_LIMIT', 'CARD_DECLINED']);

export interface RefusalBody {
  code?: unknown;
  error?: unknown;
  message?: unknown;
  need?: { feature?: unknown; tier?: unknown } | null;
  resetsAt?: unknown;
}

/** Show the upgrade prompt for a refusal; false when it isn't one (or plans aren't shown here). */
export function showUpgrade(err: RefusalBody | null | undefined): boolean {
  if (!err || !billingOn()) return false;
  const code = String(err.code ?? '') as UpgradeRequest['code'];
  if (!CODES.has(code)) return false;
  const message = typeof err.error === 'string' && err.error ? err.error : typeof err.message === 'string' ? err.message : '';
  const need = err.need && typeof err.need === 'object' ? { ...(typeof err.need.feature === 'string' ? { feature: err.need.feature } : {}), ...(typeof err.need.tier === 'string' ? { tier: err.need.tier } : {}) } : undefined;
  useBilling.getState().showUpgrade({ code, message: message || fallback(code), ...(need ? { need } : {}), ...(typeof err.resetsAt === 'string' ? { resetsAt: err.resetsAt } : {}) });
  return true;
}

function fallback(code: UpgradeRequest['code']): string {
  switch (code) {
    case 'PAYMENT_REQUIRED':
      return 'Your last payment didn’t go through. Update your card in Billing to keep going.';
    case 'CREDITS_USED':
      return 'You’ve used this month’s AI credits.';
    case 'CARD_DECLINED':
      return 'Your card was declined. Update it in Billing, then try again.';
    case 'BUSINESS_LIMIT':
      return 'Your plan has no free business slot.';
    default:
      return 'This needs a plan. Choose one to keep going.';
  }
}

/** Every answer from the app's server passes here (serverFetch): a plan refusal opens the prompt. */
export function installUpgradeListener(): void {
  setPlanRefusalListener((path, status, body) => {
    // billing's own routes answer in their dialogs (Add a business, Plan)
    if (path.startsWith('/api/billing/')) return;
    if (status === 402 || (status === 403 && (body as RefusalBody)?.code === 'PLAN_REQUIRED') || (body as RefusalBody)?.code === 'BUSINESS_LIMIT') showUpgrade(body as RefusalBody);
  });
}
