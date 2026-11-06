// The one dialog for a paid action the plan refused (src/lib/billing/upgrade.ts opens it): the server's sentence,
// the tier that has it, and what to do next. Nothing runs again by itself afterwards.

import { CreditCard } from 'lucide-react';
import { navigate } from '@/lib/router';
import { formatPrice, planFor, tierName, type Tier } from '@/lib/plans';
import { confirmPlanChange, manageBilling, upgradeTier } from '@/lib/billing/actions';
import { useBilling, useBillingOn } from '@/store/billing';
import { useUI } from '@/store/ui';
import { Modal } from '@/components/ui/primitives';

const TITLES = {
  PLAN_REQUIRED: 'This needs a plan',
  PAYMENT_REQUIRED: 'Update your card',
  CREDITS_USED: 'This month’s AI credits are used',
  BUSINESS_LIMIT: 'Your plan is full',
  CARD_DECLINED: 'Your card was declined',
} as const;

const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');

export function UpgradePrompt() {
  const on = useBillingOn();
  const req = useBilling((s) => s.upgrade);
  const plan = useBilling((s) => s.plan);
  const account = useBilling((s) => s.account);
  const close = useBilling((s) => s.closeUpgrade);
  if (!on || !req) return null;
  const paying = account?.source === 'stripe' && !!plan?.active;
  const current = plan?.tier ?? null;
  const tier: Tier | null = req.code === 'PLAN_REQUIRED' && paying ? upgradeTier(req.need?.tier, current) : null;
  const interval = account?.interval ?? 'month';
  const go = (fn: () => void) => () => {
    close();
    fn();
  };
  const seePlans = go(() => void navigate('plans', { force: true }));
  const card = go(() => void manageBilling());
  const addBusiness = go(() => useBilling.getState().openAddBusiness());
  const ownKeys = go(() => {
    useUI.getState().setSettingsTab('ai');
    void navigate('workspace-settings', { force: true });
  });

  let actions: JSX.Element;
  switch (req.code) {
    case 'PAYMENT_REQUIRED':
    case 'CARD_DECLINED':
      actions = (
        <button type="button" className="btn btn-primary btn-sm" onClick={card} data-autofocus>
          <CreditCard /> Update card
        </button>
      );
      break;
    case 'CREDITS_USED':
      actions = (
        <>
          <button type="button" className="btn btn-ghost btn-sm" onClick={ownKeys}>
            Use my own AI keys
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={seePlans}>
            See plans
          </button>
          {paying && (
            <button type="button" className="btn btn-primary btn-sm" onClick={addBusiness} data-autofocus>
              Add a business
            </button>
          )}
        </>
      );
      break;
    case 'BUSINESS_LIMIT':
      actions = (
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={seePlans}>
            See plans
          </button>
          {paying && (
            <button type="button" className="btn btn-primary btn-sm" onClick={addBusiness} data-autofocus>
              Add a business
            </button>
          )}
        </>
      );
      break;
    default:
      actions = tier ? (
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={seePlans}>
            See plans
          </button>
          <button type="button" className="btn btn-primary btn-sm" data-autofocus onClick={go(() => void confirmPlanChange(tier, interval))}>
            Upgrade to {planFor(tier).name}
          </button>
        </>
      ) : (
        <button type="button" className="btn btn-primary btn-sm" onClick={seePlans} data-autofocus>
          See plans
        </button>
      );
  }

  return (
    <Modal open onClose={close} size="sm" title={TITLES[req.code]} footer={actions}>
      <p className="text-body text-ink-2">{req.message}</p>
      {tier && (
        <p className="mt-2 text-small text-muted">
          {planFor(tier).name} is {formatPrice(planFor(tier).price[interval])}/{interval}
          {current ? `; you’re on ${tierName(current)}` : ''}.
        </p>
      )}
      {req.code === 'CREDITS_USED' && req.resetsAt && <p className="mt-2 text-small text-muted">Your credits renew on {fmtDate(req.resetsAt)}. Your own AI keys never use credits.</p>}
    </Modal>
  );
}
