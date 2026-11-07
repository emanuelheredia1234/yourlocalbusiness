// Settings › Plan: the plan (tier, price, status, renewal, AI credits), the businesses it covers (add one, remove one
// at renewal, undo, choose which stay active), Manage billing (Stripe's Customer Portal: card, invoices), and Cancel
// plan (a quick survey first, src/components/billing/CancelDialog.tsx; also after a failed payment, when it ends the
// plan now) or Keep my plan after a cancel. Before the server can do those two (cancelInApp false) they open the
// portal. A card trial shows its days left (no extra business until it ends); with no plan yet, Start your free
// trial. Every change is one request with its own id; a change being confirmed is read back, never re-sent.
//
// Signed in, plans shown (never in the artifact build). The owner sees the owner plan.

import { useEffect, useRef, useState } from 'react';
import { CreditCard, Plus, RefreshCw, Undo2 } from 'lucide-react';
import { navigate } from '@/lib/router';
import { changeBusinesses, IntegrationApiError, newRequestId, setActiveBusinesses } from '@/lib/integrations/api';
import type { BusinessSlot, Entitlement, PlanAccount } from '@/lib/integrations/types';
import { formatPrice, isInterval, isTier, planFor, PLANS, tierName } from '@/lib/plans';
import { keepPlan, manageBilling } from '@/lib/billing/actions';
import { CancelDialog } from '@/components/billing/CancelDialog';
import { releaseHeld } from '@/lib/cloud/auth';
import { useBilling, useTrialDays } from '@/store/billing';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { HeldProjectsNotice } from '@/components/billing/HeldProjects';
import { Badge, Callout, Checkbox, Modal, ProgressBar, SettingsRow, SettingsSection, Spinner } from '@/components/ui/primitives';

const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

/** The status chip: Active / Trial ends <date> / Payment problem until <date> / Cancels <date> / Ended. */
export function statusChip(plan: Entitlement | null, account: PlanAccount | null): { tone: 'good' | 'warn' | 'bad' | 'neutral' | 'primary'; label: string } {
  if (!plan) return { tone: 'neutral', label: 'Loading' };
  if (plan.plan === 'owner') return { tone: 'primary', label: 'Owner' };
  if (plan.plan === 'legacy') return { tone: 'neutral', label: 'Plans not started' };
  if (plan.paused === 'payment') return { tone: 'bad', label: 'Payment needed' };
  if (plan.banner === 'grace') return { tone: 'warn', label: `Payment problem until ${fmtDate(plan.graceUntil ?? account?.graceUntil)}` };
  // only a plan that really ended says Ended: no plan yet (setup, a Checkout left half way) or a second trial that was
  // refused never had one
  if (plan.paused === 'plan' || plan.banner === 'plan_ended') return { tone: 'neutral', label: plan.banner === 'plan_ended' && !account?.trialRefused ? 'Ended' : 'No plan' };
  if (account?.cancelAtPeriodEnd) return { tone: 'warn', label: `Cancels ${fmtDate(account.currentPeriodEnd)}` };
  if (account?.source === 'comp') return { tone: 'primary', label: account.compUntil ? `Free until ${fmtDate(account.compUntil)}` : 'Free plan' };
  if (account?.status === 'trialing') return { tone: 'primary', label: plan.trialDaysLeft != null ? `Free trial · ${plan.trialDaysLeft === 1 ? '1 day' : `${plan.trialDaysLeft} days`} left` : `Trial ends ${fmtDate(plan.trialEndsAt ?? account.trialEndsAt)}` };
  return { tone: 'good', label: 'Active' };
}

export function PlanSection() {
  const plan = useBilling((s) => s.plan);
  const account = useBilling((s) => s.account);
  const credits = useBilling((s) => s.credits);
  const businesses = useBilling((s) => s.businesses);
  const loading = useBilling((s) => s.loading);
  const error = useBilling((s) => s.error);
  const refresh = useBilling((s) => s.refresh);
  const projects = useStore((s) => s.projects);
  const [busy, setBusy] = useState<null | 'portal' | 'check' | 'keep'>(null);
  const [removing, setRemoving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const trialDays = useTrialDays();
  const cancelInApp = useBilling((s) => s.cancelInApp);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!plan) {
    return (
      <div className="flex max-w-[880px] flex-col gap-6">
        {error ? (
          <Callout tone="bad" action={<button type="button" className="btn btn-secondary btn-xs" onClick={() => void refresh()}>Try again</button>}>
            {error}
          </Callout>
        ) : (
          <p className="flex items-center gap-2 text-small text-muted" role="status">
            <Spinner size={14} /> Reading your plan…
          </p>
        )}
      </div>
    );
  }

  const owner = plan.plan === 'owner';
  const legacy = plan.plan === 'legacy';
  const canChangeBusinesses = account?.source === 'stripe' && plan.active && ['active', 'trialing'].includes(account.status);
  // a trial covers one business: more start once it ends
  const inTrial = account?.status === 'trialing';
  // any Stripe plan still going can be cancelled (after a failed payment it ends now) or kept
  const canCancel = account?.source === 'stripe' && ['trialing', 'active', 'past_due', 'unpaid'].includes(account.status);
  // a second trial on a card or email that had one: cancelled at once, it never was a plan
  const refused = account?.trialRefused === 'refused';
  const chip = statusChip(plan, account);
  const name = (id: string) => projects.find((p) => p.id === id)?.brand.name || 'A business not on this device';
  const tier = isTier(account?.tier) ? account.tier : null;
  const interval = isInterval(account?.interval) ? account.interval : null;
  const op = businesses?.op ?? null;
  const pendingRemove = businesses?.pendingRemove ?? account?.pendingRemove ?? null;
  const slots = businesses?.slots ?? [];
  const limit = businesses?.limit ?? plan.businessLimit;
  const used = businesses?.used ?? slots.filter((s) => s.state === 'active').length;
  const overLimit = limit != null && (used > limit || (slots.some((s) => s.state === 'locked' && s.lockedReason === 'limit') && used < limit));

  const portal = async () => {
    setBusy('portal');
    await manageBilling();
    setBusy(null);
  };
  const checkAgain = async () => {
    setBusy('check');
    await refresh();
    setBusy(null);
  };

  const undo = async () => {
    // the id is made with the press: pressing twice while it's on its way is still one change
    const id = newRequestId();
    try {
      const out = await changeBusinesses({ action: 'undo_remove', clientRequestId: id, confirm: true });
      toast(out.op?.state === 'done' || out.ok ? { kind: 'success', title: 'You’re keeping that business' } : { kind: 'info', title: 'We’re confirming your last change. This takes a minute.' });
    } catch (e) {
      toast({ kind: 'error', title: e instanceof IntegrationApiError ? e.message : 'Couldn’t undo that. Try again shortly.' });
    }
    void refresh();
  };

  return (
    <div className="flex max-w-[880px] flex-col gap-6">
      <HeldProjectsNotice />
      {op && (op.state === 'unknown' || op.state === 'sending') && (
        <Callout
          tone="info"
          action={
            <button type="button" className="btn btn-secondary btn-xs" disabled={busy === 'check'} onClick={() => void checkAgain()}>
              {busy === 'check' ? <Spinner size={12} /> : <RefreshCw />} Check again
            </button>
          }
        >
          We’re confirming your last change… This takes a minute.
        </Callout>
      )}

      <SettingsSection
        title="Your plan"
        description={owner ? 'The owner’s account: everything unlimited, never billed.' : legacy ? 'Plans haven’t started on this app yet: nothing is charged.' : 'Your plan, its price and this month’s AI credits.'}
        actions={<Badge tone={chip.tone === 'neutral' ? 'neutral' : chip.tone}>{chip.label}</Badge>}
      >
        {owner ? (
          <SettingsRow label="Owner plan — unlimited" description="Unlimited businesses, AI credits and features. No Stripe customer is ever made for this account.">
            <span className="text-small text-muted">Owner</span>
          </SettingsRow>
        ) : (
          <>
            <SettingsRow label="Plan" description={account?.pendingDowngrade ? `Switches to ${tierName(account.pendingDowngrade.tier)} on ${fmtDate(account.pendingDowngrade.at)}.` : undefined}>
              <span className="text-ui text-ink">
                {plan.plan === 'none' || !tier || refused ? 'No plan' : `${tierName(plan.tier ?? tier)}${account?.source === 'comp' ? ' (free)' : ''}`}
                {tier && interval && account?.source === 'stripe' && !refused && (
                  <span className="ml-2 text-small text-muted">
                    {formatPrice(planFor(tier).price[interval])}/{interval}
                  </span>
                )}
              </span>
            </SettingsRow>
            {plan.trial && tier && interval && (
              <SettingsRow label="Free trial" description={account?.cancelAtPeriodEnd ? 'You cancelled it: nothing is charged, and your plan ends with the trial. Keep my plan undoes that.' : 'Cancel before then and you pay nothing.'}>
                <span className="text-small text-ink">
                  {plan.trialDaysLeft === 1 ? '1 day left' : `${plan.trialDaysLeft ?? 0} days left`} ·{' '}
                  {account?.cancelAtPeriodEnd ? `ends ${fmtDate(plan.trialEndsAt ?? account?.trialEndsAt)}` : `${formatPrice(planFor(tier).price[interval])}/${interval} from ${fmtDate(plan.trialEndsAt ?? account?.trialEndsAt)}`}
                </span>
              </SettingsRow>
            )}
            {refused && (
              <Callout tone="warn" className="my-3" action={<button type="button" className="btn btn-primary btn-xs" onClick={() => void navigate('plans', { force: true })}>See plans</button>}>
                Your free trial didn’t start: this card or email already had one. We cancelled it, so nothing was charged. Choose a plan to start today.
              </Callout>
            )}
            {plan.plan === 'none' && !account?.source?.match(/comp|owner/) && plan.paused === 'plan' && plan.banner !== 'plan_ended' && (
              <Callout
                tone="info"
                className="my-3"
                action={
                  <button type="button" className="btn btn-primary btn-xs" onClick={() => void navigate('plans', { force: true })}>
                    {trialDays ? `Start ${trialDays}-day free trial` : 'See plans'}
                  </button>
                }
              >
                You’re looking around for free. Publishing, posting, ads, AI video and connecting accounts start with a plan{trialDays ? `: try any plan free for ${trialDays} days` : ''}.
              </Callout>
            )}
            {account?.source === 'stripe' && account.currentPeriodEnd && !plan.trial && ['active', 'past_due', 'unpaid'].includes(account.status) && (
              <SettingsRow label={account.cancelAtPeriodEnd ? 'Ends' : 'Next renewal'}>
                <span className="text-small text-ink">{fmtDate(account.currentPeriodEnd)}</span>
              </SettingsRow>
            )}
            {account?.source === 'comp' && plan.active && (
              <Callout tone="info" className="my-3" action={<button type="button" className="btn btn-secondary btn-xs" onClick={() => void navigate('plans', { force: true })}>See plans</button>}>
                Free {tierName(plan.tier)}
                {account.compUntil ? ` until ${fmtDate(account.compUntil)}` : ''}. Pick a plan to keep going.
              </Callout>
            )}
            {credits && credits.monthly != null && (
              <SettingsRow label="AI credits" description="About 1¢ of AI each on the app’s keys. Your own AI keys never use credits.">
                <div className="w-full max-w-[320px]">
                  <ProgressBar value={Math.min(credits.monthly, credits.usedCredits ?? 0)} max={Math.max(1, credits.monthly)} aria-label="AI credits used" />
                  <p className="num mt-1.5 text-small text-muted">
                    {(credits.usedCredits ?? 0).toLocaleString('en-US')} of {credits.monthly.toLocaleString('en-US')} credits used
                    {plan.trial ? ' during your trial' : plan.starter ? ' to set up (once, before a plan)' : credits.resetsAt ? ` · renews ${fmtDate(credits.resetsAt)}` : ''}
                  </p>
                </div>
              </SettingsRow>
            )}
            <div className="flex flex-wrap gap-2 border-t border-line py-4">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void navigate('plans', { force: true })}>
                {plan.plan === 'none' || plan.paused === 'plan' || account?.source !== 'stripe' ? 'See plans' : 'Change plan'}
              </button>
              {account?.hasCustomer && (
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy === 'portal'} onClick={() => void portal()}>
                  {busy === 'portal' ? <Spinner size={14} /> : <CreditCard />} Manage billing
                </button>
              )}
              {canCancel && account?.cancelAtPeriodEnd && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy === 'keep'}
                  onClick={async () => {
                    setBusy('keep');
                    await keepPlan();
                    setBusy(null);
                  }}
                >
                  {busy === 'keep' && <Spinner size={14} />} Keep my plan
                </button>
              )}
              {canCancel && !account?.cancelAtPeriodEnd && (
                // before the server can cancel here, Stripe's billing page does it (and asks its own question)
                <button type="button" className="btn btn-ghost btn-sm sm:ml-auto" onClick={() => (cancelInApp ? setCancelling(true) : void portal())}>
                  {account?.status === 'trialing' ? 'Cancel trial' : 'Cancel plan'}
                </button>
              )}
            </div>
          </>
        )}
      </SettingsSection>

      {!owner && !legacy && (
        <SettingsSection
          title="Businesses"
          description={
            limit == null
              ? 'Unlimited businesses.'
              : `${used} of ${limit} ${limit === 1 ? 'business' : 'businesses'}. Each extra business is ${formatPrice(PLANS.additionalBusiness.price[interval ?? 'month'])}/${interval ?? 'month'}${inTrial ? ', added once your free trial ends' : ''}.`
          }
          actions={
            canChangeBusinesses && !inTrial ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => useBilling.getState().openAddBusiness()}>
                <Plus /> Add a business — {formatPrice(PLANS.additionalBusiness.price[interval ?? 'month'])}/{interval ?? 'month'}
              </button>
            ) : undefined
          }
        >
          {slots.length ? (
            <ul className="-mx-5 mt-2 flex flex-col border-t border-line" aria-label="Businesses on your plan">
              {slots.map((s) => (
                <li key={s.projectId} className="flex min-h-12 items-center gap-3 border-b border-line px-5 py-2 last:border-b-0">
                  <span className="min-w-0 flex-1 truncate text-ui text-ink">{name(s.projectId)}</span>
                  <SlotBadge slot={s} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-3 text-small text-muted">No businesses yet.</p>
          )}
          <div className="flex flex-wrap gap-2 py-4">
            {pendingRemove ? (
              <>
                <p className="w-full text-small text-muted">
                  {pendingRemove.count === 1 ? 'One business' : `${pendingRemove.count} businesses`} will be removed on {fmtDate(pendingRemove.at)}.
                </p>
                {canChangeBusinesses && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => void undo()}>
                    <Undo2 /> Undo
                  </button>
                )}
              </>
            ) : (
              canChangeBusinesses &&
              (account?.extraBusinesses ?? 0) > 0 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRemoving(true)}>
                  Remove one at renewal
                </button>
              )
            )}
            {overLimit && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setChoosing(true)}>
                Choose which businesses stay active
              </button>
            )}
          </div>
        </SettingsSection>
      )}

      {loading && <span className="sr-only" role="status">Updating your plan</span>}
      <RemoveDialog open={removing} onClose={() => setRemoving(false)} slots={slots.filter((s) => s.state === 'active' && !s.lockAt)} name={name} at={account?.currentPeriodEnd ?? null} />
      <ChooseDialog open={choosing} onClose={() => setChoosing(false)} slots={slots} limit={limit ?? 1} name={name} />
      <CancelDialog open={cancelling} onClose={() => setCancelling(false)} account={account} />
    </div>
  );
}

function SlotBadge({ slot }: { slot: BusinessSlot }) {
  if (slot.state === 'locked') return <Badge tone="warn">Locked</Badge>;
  if (slot.lockAt) return <Badge>Ends {fmtDate(slot.lockAt)}</Badge>;
  return <Badge tone="good">Active</Badge>;
}

/** Runs `start` once each time `open` goes from false to true (never again on a re-render while open). */
function useOnOpen(open: boolean, start: () => void): void {
  const was = useRef(false);
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    if (open && !was.current) startRef.current();
    was.current = open;
  }, [open]);
}

/** Codes where the request may have gone through: the same id is sent again (the server reads it back, never twice). */
const UNSURE = new Set(['NETWORK', 'BILLING_PENDING']);

/**
 * Remove one business at renewal: pick which one is locked then; no refund, no charge. The id and the default pick are
 * set when the dialog opens (a background refresh never changes them); after an unclear answer the same id goes again.
 */
export function RemoveDialog({ open, onClose, slots, name, at }: { open: boolean; onClose: () => void; slots: BusinessSlot[]; name: (id: string) => string; at: string | null }) {
  const [pick, setPick] = useState<string>('');
  const [sending, setSending] = useState(false);
  const requestId = useRef('');
  useOnOpen(open, () => {
    requestId.current = newRequestId();
    setPick(slots[slots.length - 1]?.projectId ?? '');
  });
  if (!open) return null;
  const send = async () => {
    setSending(true);
    try {
      const out = await changeBusinesses({ action: 'remove', clientRequestId: requestId.current, confirm: true, ...(pick ? { projectId: pick } : {}) });
      toast(out.op?.state === 'done' || out.ok ? { kind: 'success', title: `${name(pick)} stays until ${fmtDate(at)}` } : { kind: 'info', title: 'We’re confirming your last change. This takes a minute.' });
      onClose();
    } catch (e) {
      const err = e instanceof IntegrationApiError ? e : null;
      toast({ kind: 'error', title: err?.message ?? 'Couldn’t remove a business. Try again shortly.' });
      // a definite refusal: a new try is a new request; an unclear answer keeps the id (Stripe sees one request)
      if (err && !UNSURE.has(err.code)) requestId.current = newRequestId();
    } finally {
      setSending(false);
      void useBilling.getState().refresh();
    }
  };
  return (
    <Modal
      open
      onClose={sending ? () => undefined : onClose}
      persistent={sending}
      size="sm"
      title="Remove a business at renewal"
      subtitle={`It stays until ${fmtDate(at) || 'your renewal'}, then it’s locked (never deleted). There’s no refund for this period, and your next renewal is lower.`}
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger btn-sm" disabled={sending || !pick} onClick={() => void send()}>
            {sending && <Spinner size={14} />} Remove at renewal
          </button>
        </>
      }
    >
      <fieldset className="flex flex-col gap-1">
        <legend className="label">Which business is locked then?</legend>
        {slots.map((s) => (
          <label key={s.projectId} className="flex items-center gap-2 rounded-pop px-2 py-1.5 text-ui text-ink hover:bg-surface-2">
            <input type="radio" name="remove-business" value={s.projectId} checked={pick === s.projectId} onChange={() => setPick(s.projectId)} />
            {name(s.projectId)}
          </label>
        ))}
      </fieldset>
    </Modal>
  );
}

/** Over the limit: which businesses stay active (the rest are locked, never deleted). The choice is set on open only. */
export function ChooseDialog({ open, onClose, slots, limit, name }: { open: boolean; onClose: () => void; slots: BusinessSlot[]; limit: number; name: (id: string) => string }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  useOnOpen(open, () => setPicked(slots.filter((s) => s.state === 'active').map((s) => s.projectId).slice(0, limit)));
  if (!open) return null;
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? (p.length >= limit ? p : [...p, id]) : p.filter((x) => x !== id)));
  const save = async () => {
    setSending(true);
    try {
      await setActiveBusinesses(picked);
      toast({ kind: 'success', title: 'Saved which businesses stay active' });
      onClose();
      // projects set aside on this device may save now
      releaseHeld(picked);
    } catch (e) {
      toast({ kind: 'error', title: e instanceof IntegrationApiError ? e.message : 'Couldn’t save that. Try again shortly.' });
    } finally {
      setSending(false);
      void useBilling.getState().refresh();
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Choose which businesses stay active"
      subtitle={`Your plan includes ${limit} ${limit === 1 ? 'business' : 'businesses'}. The others are locked: you can still open and export them.`}
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={sending || !picked.length} onClick={() => void save()}>
            {sending && <Spinner size={14} />} Save
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-1">
        {slots.map((s) => (
          <Checkbox key={s.projectId} checked={picked.includes(s.projectId)} onChange={(v) => toggle(s.projectId, v)} label={name(s.projectId)} disabled={!picked.includes(s.projectId) && picked.length >= limit} />
        ))}
      </div>
      <p className="mt-3 text-small text-muted">
        {picked.length} of {limit} chosen
      </p>
    </Modal>
  );
}
