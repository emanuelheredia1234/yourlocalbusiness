// The one dialog for a paid action the plan refused (src/lib/billing/upgrade.ts opens it): the server's sentence,
// the tier that has it, and what to do next. Nothing runs again by itself afterwards. With no plan yet and a card trial
// on offer, a plan refusal says "Start your free trial". A card trial's credits used up: only own AI keys help until
// it ends (a business or another plan adds none during it).

import { CreditCard } from 'lucide-react';
import { navigate } from '@/lib/router';
import { formatPrice, planFor, tierName, type Tier } from '@/lib/plans';
import { confirmPlanChange, manageBilling, upgradeTier } from '@/lib/billing/actions';
import { useBilling, useBillingOn, useTrialDays } from '@/store/billing';
import { useUI } from '@/store/ui';
import { Modal } from '@/components/ui/primitives';
import { shortDate } from '@/lib/videoWeek';

const TITLES = {
  PLAN_REQUIRED: 'This needs a plan',
  PAYMENT_REQUIRED: 'Update your card',
  CREDITS_USED: 'This month’s AI credits are used',
  BUSINESS_LIMIT: 'Your plan is full',
  CARD_DECLINED: 'Your card was declined',
  VIDEO_WEEK_LIMIT: 'This week’s AI videos are used',
} as const;

const fmtDate = (iso?: string | null) => shortDate(iso);

export function UpgradePrompt() {
  const on = useBillingOn();
  const req = useBilling((s) => s.upgrade);
  const plan = useBilling((s) => s.plan);
  const account = useBilling((s) => s.account);
  const close = useBilling((s) => s.closeUpgrade);
  const trialDays = useTrialDays();
  if (!on || !req) return null;
  const paying = account?.source === 'stripe' && !!plan?.active;
  // no plan yet (setup done, looking around): every locked action leads to the free trial
  const trialOffer = req.code === 'PLAN_REQUIRED' && !paying && plan?.plan !== 'owner' && trialDays > 0 ? trialDays : 0;
  const current = plan?.tier ?? null;
  const tier: Tier | null = (req.code === 'PLAN_REQUIRED' || req.code === 'VIDEO_WEEK_LIMIT') && paying ? upgradeTier(req.need?.tier, current) : null;
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

  // the trial's AI credits are fixed until it ends
  const trialCredits = req.code === 'CREDITS_USED' && (req.trial === true || plan?.trial === true);
  let actions: JSX.Element;
  switch (trialCredits ? 'TRIAL_CREDITS' : req.code) {
    case 'TRIAL_CREDITS':
      actions = (
        <button type="button" className="btn btn-primary btn-sm" onClick={ownKeys} data-autofocus>
          Use my own AI keys
        </button>
      );
      break;
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
    case 'VIDEO_WEEK_LIMIT':
      actions = (
        <>
          <button type="button" className="btn btn-ghost btn-sm" onClick={ownKeys}>
            Use my own AI keys
          </button>
          {tier ? (
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
      actions = trialOffer ? (
        <button type="button" className="btn btn-primary btn-sm" onClick={seePlans} data-autofocus>
          Start {trialOffer}-day free trial
        </button>
      ) : tier ? (
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
    <Modal open onClose={close} size="sm" title={trialOffer ? 'Start your free trial' : trialCredits ? 'Your trial’s AI credits are used' : TITLES[req.code]} footer={actions}>
      <p className="text-body text-ink-2">{req.message}</p>
      {trialOffer > 0 && (
        <p className="mt-2 text-small text-muted">
          Try any plan free for {trialOffer} days. You add a card at checkout; nothing is charged until day {trialOffer + 1}, and you can cancel before then in Settings › Plan.
        </p>
      )}
      {tier && (
        <p className="mt-2 text-small text-muted">
          {planFor(tier).name} is {formatPrice(planFor(tier).price[interval])}/{interval}
          {current ? `; you’re on ${tierName(current)}` : ''}.
        </p>
      )}
      {req.code === 'VIDEO_WEEK_LIMIT' && <p className="mt-2 text-small text-muted">{req.resetsAt ? `This week’s videos reset on Monday, ${shortDate(req.resetsAt, req.timeZone)}.` : 'This week’s videos reset on Monday.'} Videos made with your own AI keys don’t count.</p>}
      {req.code === 'CREDITS_USED' && req.resetsAt && <p className="mt-2 text-small text-muted">{trialCredits ? `Your plan’s monthly credits start on ${fmtDate(req.resetsAt)}, when the trial ends.` : `Your credits renew on ${fmtDate(req.resetsAt)}.`} Your own AI keys never use credits.</p>}
    </Modal>
  );
}
