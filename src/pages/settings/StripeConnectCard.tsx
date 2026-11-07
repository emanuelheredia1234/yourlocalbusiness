// Settings › Payments › "Get paid with Stripe" (P6): the seller makes their own Stripe account through the app and
// sells through it. Buyers pay on Stripe Checkout on that account; the seller sees every payment, refund and dispute in
// their own Stripe Dashboard; Stripe's fees come out of their Stripe balance, and our fee (the plan's percentage) is
// taken by Stripe at the sale. The app never holds a key, never sees a card, and never refunds.
//
// States, in order: none (country, the seller terms, Get paid with Stripe) → confirming (Stripe hadn't answered;
// the server reads it back) → onboarding (Continue setup: Stripe's own page, in this tab) → restricted (what Stripe
// needs, by when) → active (Receiving payments, Stripe Tax, Refresh status, Stop selling with Stripe here) →
// rejected. An onboarding link goes only to this browser: never opened in a new tab, copied or shown.
// Back from Stripe (?stripe=return) the account is read again; ?stripe=refresh asks for a new link.

import { useEffect, useRef, useState } from 'react';
import { CircleAlert, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import { OffersError, requestId } from '@/lib/offers';
import { CONNECT_COUNTRIES, createConnectAccount, dashboardUrl, disabledWords, disconnectConnect, dueWords, feeTiers, noFee, onboardingLink, setConnectTax, syncConnect, type ConnectState } from '@/lib/stripeConnect';
import { takeConnectLanding, useOffers, watchConnectFocus } from '@/store/offers';
import { toast } from '@/store/ui';
import { Badge, Callout, Checkbox, Field, Segmented, SettingsSection, Spinner, confirmAction } from '@/components/ui/primitives';

const message = (e: unknown) => (e instanceof OffersError || e instanceof Error ? e.message : 'Something went wrong. Try again.');

/** How long "Confirming your Stripe account…" polls before it offers Check again. */
export const CONFIRM_POLL_MS = 5_000;
export const CONFIRM_POLL_FOR_MS = 2 * 60_000;

const countryName = (code: string): string => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** The browser's own region when Stripe supports sellers there, else the first listed one (US). */
export function defaultCountry(list: readonly string[] = CONNECT_COUNTRIES, lang = typeof navigator !== 'undefined' ? navigator.language : ''): string {
  let region = '';
  try {
    region = new Intl.Locale(lang).maximize().region ?? '';
  } catch {
    region = /-([A-Z]{2})$/i.exec(lang)?.[1]?.toUpperCase() ?? '';
  }
  return list.includes(region) ? region : list.includes('US') ? 'US' : (list[0] ?? 'US');
}

/** "Stripe's fees come out of your Stripe balance. Our fee is 3% on Launch, 1% on Grow and 0% on Scale." */
export function FeeLine({ fee }: { fee: ConnectState['fee'] }) {
  if (noFee(fee) && fee?.tier !== 'scale') return <p className="text-small text-ink-2">Stripe’s fees come out of your Stripe balance. No platform fee.</p>;
  const tiers = feeTiers();
  return (
    <p className="text-small text-ink-2">
      Stripe’s fees come out of your Stripe balance. Our fee is{' '}
      {tiers.map((t, i) => (
        <span key={t.tier}>
          {i > 0 && (i === tiers.length - 1 ? ' and ' : ', ')}
          {fee?.tier === t.tier ? <span className="font-semibold text-ink">{t.pct}%</span> : `${t.pct}%`} on {t.name}
        </span>
      ))}
      .{fee?.tier === 'none' ? ' Without a plan, sales pay Launch’s rate.' : ''}
    </p>
  );
}

/** What the card can do; the real ones talk to the server (tests pass their own). */
export interface ConnectActions {
  create: (country: string) => Promise<void>;
  continueSetup: () => Promise<void>;
  refresh: () => Promise<void>;
  setTax: (on: boolean) => Promise<void>;
  stop: () => Promise<void>;
}

/** The card as drawn for a state (render tests use this directly). */
export function StripeConnectView({ state, error, actions, pollEnded = false, stopped = false }: { state: ConnectState | null; error?: string; actions: ConnectActions; pollEnded?: boolean; stopped?: boolean }) {
  const [country, setCountry] = useState(() => defaultCountry(state?.countries));
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy('');
    }
  };
  const a = state?.account ?? null;
  const test = (a?.environment ?? state?.environment) === 'sandbox';
  const shown = err || error || '';
  const continueBtn = (
    <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void run('setup', actions.continueSetup)}>
      {busy === 'setup' ? <Spinner size={14} /> : <ExternalLink aria-hidden="true" />}
      Continue setup
    </button>
  );
  const stopBtn = (
    <button type="button" className="btn btn-ghost btn-sm text-bad" disabled={!!busy} onClick={() => void run('stop', actions.stop)}>
      Stop selling with Stripe here
    </button>
  );
  const refreshBtn = (
    <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => void run('refresh', actions.refresh)}>
      {busy === 'refresh' ? <Spinner size={14} /> : <RefreshCw aria-hidden="true" />}
      Refresh status
    </button>
  );

  return (
    <SettingsSection
      title="Get paid with Stripe"
      description="Buyers pay you through your own Stripe account. You see every payment in your Stripe Dashboard, and refunds and disputes are handled there."
      actions={test ? <Badge tone="warn">Test mode</Badge> : undefined}
    >
      <div className="flex flex-col gap-3 pb-4 pt-2">
        {!state && (
          <p className="flex items-center gap-2 text-small text-muted">
            <Spinner size={14} /> Checking…
          </p>
        )}

        {/* not open to this user yet (the seller terms are still a draft: only the owner can set it up) */}
        {state && !a && !state.available && <Callout tone="info">Selling with Stripe opens soon. You can use Whop or your own checkout link until then.</Callout>}

        {/* none (or stopped): the country, the seller terms, and the button */}
        {state && !a && state.available && (
          <>
            {stopped && <Callout tone="info">You stopped selling with Stripe here. Your Stripe account is still yours, in your Stripe Dashboard. Set it up again whenever you like.</Callout>}
            <FeeLine fee={state.fee} />
            <p className="text-small text-muted">You’ll make a Stripe account for selling here. If you already have one, sign in with the same email during setup.</p>
            <Field label="Where your business is" htmlFor="stripe-country" hint="Stripe needs this for your account, and it can’t be changed later.">
              <select id="stripe-country" className="select" value={country} onChange={(e) => setCountry(e.target.value)}>
                {state.countries.map((c) => (
                  <option key={c} value={c}>
                    {countryName(c)}
                  </option>
                ))}
              </select>
            </Field>
            <Checkbox
              id="stripe-terms"
              checked={agreed}
              onChange={setAgreed}
              label={
                <>
                  I agree to the{' '}
                  <a href={state.termsUrl} target="_blank" rel="noopener noreferrer" className="underline">
                    Seller terms
                  </a>
                </>
              }
            />
            <div>
              <button type="button" className="btn btn-primary btn-sm" disabled={!agreed || !!busy || !country} onClick={() => void run('create', () => actions.create(country))}>
                {busy === 'create' && <Spinner size={14} />}
                Get paid with Stripe
              </button>
            </div>
          </>
        )}

        {/* Stripe hadn't answered: the server reads it back */}
        {a && (a.status === 'creating' || a.status === 'unknown') && (
          <div className="flex flex-col gap-2">
            {!pollEnded ? (
              <p className="flex items-center gap-2 text-small text-ink-2" role="status">
                <Spinner size={14} /> Confirming your Stripe account…
              </p>
            ) : (
              <>
                <p className="text-small text-ink-2">Stripe hasn’t confirmed your account yet. This can take a few minutes.</p>
                <div>{refreshBtn}</div>
              </>
            )}
          </div>
        )}

        {a && a.status === 'onboarding' && (
          <>
            <h4 className="text-ui text-ink">Finish setting up Stripe</h4>
            <p className="text-small text-ink-2">Stripe asks for your business and bank details. It takes about 5 minutes.</p>
            <div className="flex flex-wrap items-center gap-2">
              {continueBtn}
              {refreshBtn}
            </div>
          </>
        )}

        {a && a.status === 'restricted' && (
          <>
            <Callout tone="warn" title="Stripe needs more information">
              {[dueWords(a), a.due.pastDue ? 'Payments are paused until you finish.' : '', disabledWords(a.disabledReason)].filter(Boolean).join(' ') || 'Finish the details Stripe asks for to start taking payments.'}
            </Callout>
            <div className="flex flex-wrap items-center gap-2">
              {continueBtn}
              {refreshBtn}
            </div>
          </>
        )}

        {a && a.status === 'active' && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="good" dot>
                Receiving payments
              </Badge>
              <span className="text-small text-ink-2">Payouts: {a.payoutsEnabled ? 'On' : 'Paused by Stripe'}</span>
            </div>
            <p className="text-small text-ink-2">
              {[a.displayName, a.country ? countryName(a.country) : '', a.accountLast4 ? `…${a.accountLast4}` : ''].filter(Boolean).join(' · ')}
            </p>
            {(a.due.now > 0 || a.due.pastDue > 0) && (
              <Callout tone="warn" title="Stripe needs more information" action={continueBtn}>
                {dueWords(a)}
              </Callout>
            )}
            {a.payoutFailedAt && <Callout tone="warn">Stripe couldn’t pay you out: check your Stripe Dashboard.</Callout>}
            <FeeLine fee={state?.fee ?? null} />
            <Field label="Stripe Tax" hint="Stripe works out and adds sales tax at checkout. Set it up in your Stripe Dashboard (Tax › Settings) first. Stripe may charge you for Stripe Tax.">
              <Segmented<'off' | 'on'>
                size="sm"
                aria-label="Stripe Tax"
                value={a.taxEnabled ? 'on' : 'off'}
                onChange={(v) => void run('tax', () => actions.setTax(v === 'on'))}
                options={[
                  { id: 'off', label: 'Off' },
                  { id: 'on', label: 'On' },
                ]}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <a className="btn btn-secondary btn-sm" href={dashboardUrl(a.environment)} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden="true" />
                Open Stripe Dashboard
              </a>
              {refreshBtn}
              {stopBtn}
            </div>
          </>
        )}

        {a && a.status === 'rejected' && (
          <>
            <Callout tone="bad">Stripe can’t support this account. Contact Stripe support.</Callout>
            <div>{stopBtn}</div>
          </>
        )}

        {shown && (
          <p className="flex items-start gap-1.5 text-small text-bad" role="alert">
            <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            {shown}
          </p>
        )}
        {test && <p className="text-caption text-muted">Test mode: buyers can’t really pay (use the card 4242 4242 4242 4242), and test sales never count as revenue.</p>}
        <p className="flex items-start gap-2 text-caption text-muted">
          <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          You’re the seller: your money goes to your own Stripe balance. Stripe emails buyers a receipt in your name only if you turn on successful-payment emails (Stripe Dashboard → Settings → Customer emails).
        </p>
      </div>
    </SettingsSection>
  );
}

/** Settings › Payments' Stripe card: the server's state, the actions, and the landing back from Stripe. */
export function StripeConnectCard() {
  const state = useOffers((s) => s.connect);
  const error = useOffers((s) => s.connectError);
  const [pollEnded, setPollEnded] = useState(false);
  const [stopped, setStopped] = useState(false);
  // one request id per account made: kept until the server gives a definite answer (a lost connection retries the
  // same request, so Stripe never makes a second account)
  const crid = useRef(requestId());

  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    const landing = takeConnectLanding();
    void (async () => {
      if (landing === 'refresh') {
        try {
          location.assign(await onboardingLink());
          return;
        } catch (e) {
          toast({ kind: 'error', title: message(e) });
        }
      }
      if (landing === 'return') {
        try {
          const acct = await syncConnect();
          await useOffers.getState().refreshConnect();
          toast({ kind: 'success', title: acct?.status === 'active' ? 'You’re ready to sell with Stripe.' : 'Stripe saved your progress.' });
        } catch (e) {
          toast({ kind: 'error', title: message(e) });
        }
        watchConnectFocus();
        return;
      }
      await useOffers.getState().refreshConnect();
    })();
  }, []);

  // confirming: ask again every 5 s for up to 2 minutes, then offer "Refresh status"
  const status = state?.account?.status;
  useEffect(() => {
    if (status !== 'creating' && status !== 'unknown') return;
    setPollEnded(false);
    const started = Date.now();
    const t = setInterval(() => {
      if (Date.now() - started >= CONFIRM_POLL_FOR_MS) {
        clearInterval(t);
        setPollEnded(true);
        return;
      }
      void useOffers.getState().refreshConnect();
    }, CONFIRM_POLL_MS);
    return () => clearInterval(t);
  }, [status]);

  const actions: ConnectActions = {
    create: async (country) => {
      try {
        const got = await createConnectAccount({ country, clientRequestId: crid.current });
        crid.current = requestId();
        setStopped(false);
        useOffers.getState().setConnectAccount(got.account);
        if (!got.pending && got.account?.status === 'onboarding') toast({ kind: 'success', title: 'Stripe account made. Continue setup to start selling.' });
      } catch (e) {
        // the server answered (nothing was made): the next press is a new request
        if (e instanceof OffersError && e.status >= 400 && e.code !== 'PENDING') crid.current = requestId();
        if (e instanceof OffersError && e.code === 'PENDING') {
          await useOffers.getState().refreshConnect();
          return;
        }
        throw e;
      }
    },
    continueSetup: async () => {
      // a user click: the browser goes to Stripe's own page in this tab
      location.assign(await onboardingLink());
    },
    refresh: async () => {
      setPollEnded(false);
      if (state?.account?.status === 'creating' || state?.account?.status === 'unknown') {
        await useOffers.getState().refreshConnect();
        return;
      }
      useOffers.getState().setConnectAccount(await syncConnect());
    },
    setTax: async (on) => {
      useOffers.getState().setConnectAccount(await setConnectTax(on));
      toast({ kind: 'success', title: on ? 'Stripe Tax is on for your checkouts' : 'Stripe Tax is off' });
    },
    stop: async () => {
      let first = '';
      try {
        await disconnectConnect(false);
      } catch (e) {
        if (!(e instanceof OffersError && e.code === 'CONFIRM')) throw e;
        first = e.message;
      }
      const ok = await confirmAction({ title: 'Stop selling with Stripe here?', body: `${first || 'Your Stripe buy links will pause.'} Sales so far stay in Analytics, and your Stripe account stays yours.`, confirmLabel: 'Stop selling here', danger: true });
      if (!ok) return;
      const got = await disconnectConnect(true);
      useOffers.getState().setConnectAccount(null);
      // the paused offers show as paused everywhere
      useOffers.setState({ byProject: {} });
      setStopped(true);
      toast({ kind: 'success', title: got.paused ? `Stopped. ${got.paused} buy link${got.paused === 1 ? '' : 's'} paused.` : 'Stopped selling with Stripe here' });
    },
  };

  return <StripeConnectView state={state} error={error} actions={actions} pollEnded={pollEnded} stopped={stopped} />;
}
