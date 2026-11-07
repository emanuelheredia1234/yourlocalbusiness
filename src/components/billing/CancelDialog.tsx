// Cancel plan (Settings › Plan): one quick question before cancelling, never a wall. One required reason and an
// optional comment; the reason brings up one fitting alternative (a cheaper plan, tips to get more from it, telling
// us the missing feature), which the person can take or ignore. "Cancel plan" stays one press away.
//
// The cancel is one request with an id made when the dialog opens (an unclear answer sends the same id again: the
// server reads Stripe back, never cancels twice; a definite refusal, NOT_APPLIED included, makes a new id). It ends
// the plan at the end of the period (a trial: before day 8, so nothing is charged), or now after a failed payment
// (Stripe stops trying the card). Taking the alternative instead saves the answer and changes nothing in Stripe.
// While the server can't cancel here yet (USE_PORTAL), the Customer Portal does.

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Lightbulb, MessageSquare, TrendingDown } from 'lucide-react';
import { cancelPlan, IntegrationApiError, keepPlanSurvey, newRequestId } from '@/lib/integrations/api';
import type { CancelOffer, CancelReason, PlanAccount } from '@/lib/integrations/types';
import { formatPrice, isInterval, isTier, planFor, tierName, TIERS, tierRank, type Interval, type Tier } from '@/lib/plans';
import { confirmPlanChange, manageBilling } from '@/lib/billing/actions';
import { navigate } from '@/lib/router';
import { useBilling } from '@/store/billing';
import { toast, useUI } from '@/store/ui';
import { AutoTextarea, Callout, Field, Modal, Spinner } from '@/components/ui/primitives';

export const REASONS: { id: CancelReason; label: string }[] = [
  { id: 'too_expensive', label: 'It’s too expensive' },
  { id: 'not_using', label: 'I’m not using it enough' },
  { id: 'missing_feature', label: 'It’s missing a feature I need' },
  { id: 'results', label: 'The results aren’t good enough' },
  { id: 'switching', label: 'I’m switching to another tool' },
  { id: 'too_hard', label: 'It’s too hard to use' },
  { id: 'short_term', label: 'I only needed it for a short time' },
  { id: 'other', label: 'Something else' },
];

export interface Alternative {
  offer: CancelOffer;
  title: string;
  body: string;
  action?: string;
}

/** The one alternative a reason brings up (null: none fits). tier/interval: the current plan. */
export function alternativeFor(reason: CancelReason | '', tier: Tier | null, interval: Interval | null): Alternative | null {
  const lower = tier ? TIERS.filter((t) => tierRank(t) < tierRank(tier)).at(-1) ?? null : null;
  switch (reason) {
    case 'too_expensive':
      if (lower && interval) return { offer: 'cheaper_plan', title: `Switch to ${tierName(lower)} instead`, body: `${formatPrice(planFor(lower).price[interval])}/${interval} from your next renewal. You keep ${tierName(tier)} until then.`, action: `Switch to ${tierName(lower)}` };
      return { offer: 'tips', title: 'Pay less with your own AI keys', body: 'Requests on your own AI keys never use credits. Add them in Settings › AI keys.', action: 'Open AI keys' };
    case 'not_using':
    case 'short_term':
    case 'results':
    case 'too_hard':
      return { offer: 'tips', title: 'Let the app pick your next step', body: 'Strategy finds where your buyers are, what to post and which page to build first, so each week starts with one clear action.', action: 'Open Strategy' };
    case 'missing_feature':
      return { offer: 'tell_feature', title: 'Tell us what’s missing', body: 'Write it in the box above. The owner reads every answer, and you can keep your plan while you wait.', action: 'Send and keep my plan' };
    default:
      return null;
  }
}

const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
/** Codes where the cancel may have gone through: the same id is sent again (never a second cancel). */
const UNSURE = new Set(['NETWORK', 'BILLING_PENDING']);

export function CancelDialog({ open, onClose, account }: { open: boolean; onClose: () => void; account: PlanAccount | null }) {
  const [reason, setReason] = useState<CancelReason | ''>('');
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState<null | 'cancel' | 'keep'>(null);
  const requestId = useRef('');
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      requestId.current = newRequestId();
      setReason('');
      setComment('');
    }
    wasOpen.current = open;
  }, [open]);
  if (!open) return null;
  const tier = isTier(account?.tier) ? account.tier : null;
  const interval = isInterval(account?.interval) ? account.interval : null;
  const trial = account?.status === 'trialing';
  // a payment failed: the plan ends now (no final invoice; Stripe stops trying the card)
  const unpaid = account?.status === 'past_due' || account?.status === 'unpaid';
  const alt = alternativeFor(reason, tier, interval);
  const ends = fmtDate(trial ? account?.trialEndsAt : account?.currentPeriodEnd);

  const cancel = async () => {
    if (!reason) return;
    setSending('cancel');
    try {
      const out = await cancelPlan({ reason, ...(comment.trim() ? { comment: comment.trim().slice(0, 1000) } : {}), offer: alt?.offer ?? 'none', clientRequestId: requestId.current, confirm: true });
      if (out.op?.state === 'done' || out.ok) toast(unpaid ? { kind: 'success', title: 'Your plan has ended. Nothing more is charged.', body: 'Your work is kept, and published pages keep working for 30 days.' } : { kind: 'success', title: trial ? `Your trial ends on ${ends}. You won’t be charged.` : `Your plan ends on ${ends}.`, body: 'You can keep your plan any time before then.' });
      else toast({ kind: 'info', title: 'We’re confirming your cancel. This takes a minute.' });
      onClose();
    } catch (e) {
      const err = e instanceof IntegrationApiError ? e : null;
      if (err?.code === 'USE_PORTAL') {
        // cancelling here isn't ready on this server: Stripe's billing page does it (and asks its own question)
        useBilling.setState({ cancelInApp: false });
        onClose();
        void manageBilling();
        return;
      }
      toast({ kind: 'error', title: err?.message ?? 'Couldn’t cancel just now. Try again shortly.' });
      if (err && !UNSURE.has(err.code)) requestId.current = newRequestId();
    } finally {
      setSending(null);
      void useBilling.getState().refresh();
    }
  };

  const takeOffer = async () => {
    if (!reason || !alt) return;
    setSending('keep');
    try {
      if (alt.offer === 'cheaper_plan' && tier && interval) {
        const lower = TIERS.filter((t) => tierRank(t) < tierRank(tier)).at(-1);
        // the plan change asks for its own confirmation; the answer is kept only when it went ahead
        if (!lower || !(await confirmPlanChange(lower, interval))) return;
        await keepPlanSurvey({ reason, offer: alt.offer, outcome: 'switched', ...(comment.trim() ? { comment: comment.trim().slice(0, 1000) } : {}) }).catch(() => undefined);
      } else {
        await keepPlanSurvey({ reason, offer: alt.offer, outcome: 'kept', ...(comment.trim() ? { comment: comment.trim().slice(0, 1000) } : {}) });
        if (alt.offer === 'tell_feature') toast({ kind: 'success', title: 'Thanks. The owner reads every answer.' });
        else if (reason === 'too_expensive') {
          useUI.getState().setSettingsTab('ai');
          void navigate('workspace-settings', { force: true });
        }
        else void navigate('strategy', { force: true });
      }
      onClose();
    } catch (e) {
      toast({ kind: 'error', title: e instanceof IntegrationApiError ? e.message : 'Couldn’t save that. Try again shortly.' });
    } finally {
      setSending(null);
    }
  };

  const icon = alt?.offer === 'cheaper_plan' ? <TrendingDown /> : alt?.offer === 'tell_feature' ? <MessageSquare /> : <Lightbulb />;
  return (
    <Modal
      open
      onClose={sending ? () => undefined : onClose}
      persistent={!!sending}
      size="md"
      title={trial ? 'Cancel your free trial?' : 'Cancel your plan?'}
      subtitle={
        trial
          ? `Nothing is charged: your trial ends on ${ends}. You keep everything until then.`
          : unpaid
            ? 'Your last payment didn’t go through, so your plan ends now and Stripe stops trying your card: nothing more is charged. Published pages keep working for 30 days, and your work is kept.'
            : `Your plan runs until ${ends || 'the end of this period'}. Published pages keep working for 30 days after that, and your work is kept.`
      }
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={!!sending}>
            Keep my plan
          </button>
          <button type="button" className="btn btn-danger btn-sm" disabled={!!sending || !reason} onClick={() => void cancel()}>
            {sending === 'cancel' && <Spinner size={14} />} {trial ? 'Cancel trial' : 'Cancel plan'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-0.5">
          <legend className="label">Why are you leaving? (required)</legend>
          {REASONS.map((r) => (
            <label key={r.id} className="flex min-h-10 items-center gap-2 rounded-pop px-2 py-1.5 text-ui text-ink hover:bg-surface-2">
              <input type="radio" name="cancel-reason" value={r.id} checked={reason === r.id} onChange={() => setReason(r.id)} />
              {r.label}
            </label>
          ))}
        </fieldset>
        <Field label="Anything else? (optional)" htmlFor="cancel-comment" right={`${comment.length}/1000`}>
          <AutoTextarea id="cancel-comment" className="input" minRows={2} maxLength={1000} value={comment} onChange={setComment} placeholder={reason === 'missing_feature' ? 'Which feature do you need?' : 'What would have made it worth keeping?'} />
        </Field>
        {alt && (
          <Callout
            tone="info"
            title={alt.title}
            action={
              alt.action ? (
                <button type="button" className="btn btn-secondary btn-xs" disabled={!!sending} onClick={() => void takeOffer()}>
                  {sending === 'keep' ? <Spinner size={12} /> : icon} {alt.action} <ArrowRight />
                </button>
              ) : undefined
            }
          >
            {alt.body}
          </Callout>
        )}
      </div>
    </Modal>
  );
}
