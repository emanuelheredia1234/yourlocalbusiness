// Add a business: buys one more business slot on a paid plan (one Stripe change, charged today for the rest of the
// period). The request id is made when the dialog opens and reused if it's submitted again, so a double click is one
// charge. "Being confirmed" is read back every 10 s for up to 2 minutes (never re-sent); then Settings › Plan.

import { useEffect, useRef, useState } from 'react';
import { Building2, CreditCard } from 'lucide-react';
import { changeBusinesses, getBusinesses, IntegrationApiError, newRequestId } from '@/lib/integrations/api';
import { formatPrice, PLANS } from '@/lib/plans';
import { manageBilling, openPlanSettings } from '@/lib/billing/actions';
import { useBilling, useBillingOn } from '@/store/billing';
import { toast } from '@/store/ui';
import { Callout, Modal, Spinner } from '@/components/ui/primitives';

type Phase = 'ready' | 'sending' | 'confirming' | 'late' | 'declined' | 'error';

export const POLL_MS = 10_000;
export const POLL_FOR_MS = 120_000;

export function AddBusinessDialog() {
  const on = useBillingOn();
  const open = useBilling((s) => s.addOpen);
  const after = useBilling((s) => s.afterAdd);
  const close = useBilling((s) => s.closeAddBusiness);
  const account = useBilling((s) => s.account);
  const businesses = useBilling((s) => s.businesses);
  const [phase, setPhase] = useState<Phase>('ready');
  const [error, setError] = useState<string | null>(null);
  // one id per opening: submitting again (a double click, or after a dropped connection) is the same request
  const requestId = useRef<string>('');
  const undoId = useRef<string>('');
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!open) return;
    requestId.current = newRequestId();
    undoId.current = newRequestId();
    setPhase('ready');
    setError(null);
    return () => {
      if (poll.current) clearInterval(poll.current);
      poll.current = null;
    };
  }, [open]);

  if (!on || !open) return null;
  const paying = account?.source === 'stripe';
  const yearly = account?.interval === 'year';
  const price = PLANS.additionalBusiness.price;
  const pending = businesses?.pendingRemove ?? account?.pendingRemove ?? null;

  const finish = async (title: string) => {
    if (poll.current) clearInterval(poll.current);
    poll.current = null;
    await useBilling.getState().refresh();
    const then = after;
    close();
    toast({ kind: 'success', title });
    if (then) await then();
  };

  /** Read back (never re-send) until the change shows: the paid quantity went up, or the op ended without it. */
  const watch = (before: number) => {
    setPhase('confirming');
    const started = Date.now();
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      if (Date.now() - started >= POLL_FOR_MS) {
        if (poll.current) clearInterval(poll.current);
        poll.current = null;
        setPhase('late');
        return;
      }
      const b = await getBusinesses().catch(() => null);
      if (!b || b.op) return; // still being confirmed (or no answer this time)
      if (b.extraBusinesses > before) return void (await finish('Business added'));
      if (poll.current) clearInterval(poll.current);
      poll.current = null;
      setPhase('error');
      setError('That change didn’t go through. Try again.');
      requestId.current = newRequestId();
    }, POLL_MS);
  };

  const send = async (action: 'add' | 'undo_remove') => {
    if (phase === 'sending' || phase === 'confirming') return;
    setPhase('sending');
    setError(null);
    const before = useBilling.getState().businesses?.extraBusinesses ?? account?.extraBusinesses ?? 0;
    try {
      const out = await changeBusinesses({ action, clientRequestId: action === 'add' ? requestId.current : undoId.current, confirm: true });
      if (out.op?.state === 'done' || out.ok) await finish(action === 'add' ? 'Business added' : 'You’re keeping that business');
      else watch(before);
    } catch (e) {
      const err = e instanceof IntegrationApiError ? e : null;
      if (err?.code === 'CARD_DECLINED') {
        setPhase('declined');
        setError(err.message);
        // a declined card changed nothing: a new try is a new request
        requestId.current = newRequestId();
        return;
      }
      if (err?.useUndo) {
        setPhase('ready');
        void useBilling.getState().refresh();
        return setError(err.message);
      }
      setPhase('error');
      setError(err?.message ?? 'Couldn’t add a business. Try again shortly.');
      // a definite refusal: the next try is a new request; a dropped connection reuses this one
      if (err && err.code !== 'NETWORK' && err.code !== 'BILLING_PENDING') requestId.current = newRequestId();
    }
  };

  const busy = phase === 'sending' || phase === 'confirming';
  const footer =
    phase === 'late' ? (
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={() => {
          close();
          openPlanSettings();
        }}
      >
        Open Settings › Plan
      </button>
    ) : phase === 'declined' ? (
      <>
        <button type="button" className="btn btn-secondary btn-sm" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void manageBilling()}>
          <CreditCard /> Update card
        </button>
      </>
    ) : (
      <>
        <button type="button" className="btn btn-secondary btn-sm" onClick={close} disabled={busy}>
          Cancel
        </button>
        {paying && (
          <button type="button" className="btn btn-primary btn-sm" data-autofocus disabled={busy} onClick={() => void send('add')}>
            {busy && <Spinner size={14} />} Add a business
          </button>
        )}
      </>
    );

  return (
    <Modal open onClose={busy ? () => undefined : close} persistent={busy} size="sm" title="Add a business" icon={<Building2 />} footer={footer}>
      {!paying ? (
        <p className="text-body text-ink-2">Your plan doesn’t add businesses here. Choose a paid plan in Settings › Plan to add more.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-body text-ink-2">
            Add a business for {formatPrice(price.month)}/month (or {formatPrice(price.year)}/year on yearly plans). You’ll be charged today for the rest of this billing period.
          </p>
          <p className="text-small text-muted">
            You pay {yearly ? `${formatPrice(price.year)}/year` : `${formatPrice(price.month)}/month`} for it from your next renewal, and get {PLANS.additionalBusiness.aiCreditsPerMonth.toLocaleString('en-US')} more AI credits a month.
          </p>
          {pending && (
            <Callout
              tone="info"
              action={
                <button type="button" className="btn btn-secondary btn-xs" disabled={busy} onClick={() => void send('undo_remove')}>
                  Keep it
                </button>
              }
            >
              Keep the business you were removing instead (no charge).
            </Callout>
          )}
          {phase === 'confirming' && (
            <p className="flex items-center gap-2 text-small text-muted" role="status">
              <Spinner size={14} /> Confirming your payment…
            </p>
          )}
          {phase === 'late' && <Callout tone="info">We’ll finish this shortly; check Settings › Plan.</Callout>}
          {error && <Callout tone={phase === 'declined' || phase === 'error' ? 'bad' : 'warn'}>{error}</Callout>}
        </div>
      )}
    </Modal>
  );
}
