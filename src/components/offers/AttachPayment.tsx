// "Attach payment": one dialog used wherever something is sold (an asset's Buy buttons, the SEO checkout page, the
// listing, an email's button). It picks one of the business's offers or makes a new one: sold through the owner's
// own Stripe account (P6, StripeOfferForm), a Whop plan from their own Whop account, or their own checkout link. The caller keeps only the offer's id; pages hold
// {{buy:<id>}}, which becomes the offer's permanent buy link /b/<id>. Signed out, with the server's offers off, or
// in the claude.ai build, the caller's old plain link field shows instead.

import { useEffect, useState, type ReactNode } from 'react';
import { CircleAlert, CreditCard, Link2, Plus, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  OffersError,
  PROVIDER_LABEL,
  checkOffer,
  checkoutHint,
  createExternalOffer,
  createStripeOffer,
  createWhopOffer,
  offerConnection,
  offerPrice,
  offerProblem,
  requestId,
  requestIdsAfter,
  whopPlans,
  whopProducts,
  type Offer,
  type WhopConnection,
  type WhopEnvironment,
  type WhopPlan,
  type WhopProduct,
} from '@/lib/offers';
import type { ConnectState } from '@/lib/stripeConnect';
import { useOffers, useProjectOffers } from '@/store/offers';
import { StripeOfferForm, type StripeOfferInput } from './StripeOfferForm';
import { useUI } from '@/store/ui';
import { navigate } from '@/lib/router';
import { Badge, Callout, CopyButton, Field, Modal, Segmented, Spinner } from '@/components/ui/primitives';

const message = (e: unknown) => (e instanceof OffersError || e instanceof Error ? e.message : 'Something went wrong. Try again.');

/** An offer's badges: who takes the payment, Test mode, a state that isn't selling. */
export function OfferBadges({ offer }: { offer: Offer }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone="neutral">{PROVIDER_LABEL[offer.provider]}</Badge>
      {offer.environment === 'sandbox' && <Badge tone="warn">Test mode</Badge>}
      {offer.problem === 'stripe_setup' && offer.status === 'active' && <Badge tone="warn">Stripe setup</Badge>}
      {offer.status === 'paused' && <Badge tone="warn">Paused</Badge>}
      {offer.status === 'checkout_unknown' && <Badge tone="warn">Not confirmed</Badge>}
    </span>
  );
}

/** The attached offer, compact: title · price · provider · Copy link · Change · Remove, and a warning when it isn't selling. */
export function AttachedOffer({ offer, connection, onChange, onRemove }: { offer: Offer; connection?: Pick<WhopConnection, 'status'> | null; onChange: () => void; onRemove: () => void }) {
  const problem = offerProblem(offer, connection);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <CreditCard size={16} className="shrink-0 text-muted" aria-hidden="true" />
        <span className="min-w-0 truncate text-ui text-ink">{offer.title}</span>
        {offerPrice(offer) && <span className="text-small text-ink-2">{offerPrice(offer)}</span>}
        <OfferBadges offer={offer} />
        <span className="ml-auto flex items-center gap-1">
          {offer.link && <CopyButton text={offer.link} label="Copy link" size="xs" />}
          <button type="button" className="btn btn-ghost btn-xs" onClick={onChange}>
            Change
          </button>
          <button type="button" className="btn btn-ghost btn-xs" onClick={onRemove}>
            Remove
          </button>
        </span>
      </div>
      {problem && (
        <p className="flex items-start gap-1.5 text-caption text-warn">
          <CircleAlert size={14} className="mt-px shrink-0" aria-hidden="true" />
          {problem}
        </p>
      )}
    </div>
  );
}

type Tab = 'pick' | 'stripe' | 'whop' | 'external';

/** The dialog's body (render tests draw it directly). */
export function AttachPaymentForm({
  projectId,
  offers,
  connections,
  whopOn,
  stripeOn: stripeAsked = false,
  connect = null,
  defaultTitle = '',
  value,
  initialTab,
  initialPending,
  onAttach,
}: {
  projectId: string;
  offers: Offer[];
  connections: WhopConnection[];
  whopOn: boolean;
  /** selling through the owner's own Stripe account is on here (never in the claude.ai build) */
  stripeOn?: boolean;
  /** the owner's Stripe account and fee (null: not loaded yet) */
  connect?: ConnectState | null;
  /** a new offer's title to start with (the asset's or page's name) */
  defaultTitle?: string;
  value?: string;
  initialTab?: Tab;
  /** a Whop offer whose link Whop didn't confirm yet */
  initialPending?: Offer | null;
  onAttach: (offer: Offer) => void;
}) {
  const choosable = offers.filter((o) => o.status !== 'archived' && o.status !== 'draft');
  const stripeOn = stripeAsked && !__ARTIFACT_BUILD__;
  const [tab, setTab] = useState<Tab>(initialTab ?? (choosable.length ? 'pick' : stripeOn ? 'stripe' : whopOn && connections.length ? 'whop' : 'external'));
  // a double press of Create makes one offer, and one Whop checkout link: each kind keeps its request id until the
  // server definitely refused it (then nothing was made, and another try is a new request, never Whop's replay)
  const [crids, setCrids] = useState(() => ({ whop: requestId(), own: requestId(), stripe: requestId() }));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Offer | null>(initialPending ?? null);

  // ── Whop ──
  const usable = connections.filter((c) => c.status === 'active');
  const [env, setEnv] = useState<WhopEnvironment>(usable.some((c) => c.environment === 'production') ? 'production' : 'sandbox');
  const conn = usable.find((c) => c.environment === env) ?? null;
  const [products, setProducts] = useState<WhopProduct[] | null>(null);
  const [productId, setProductId] = useState('');
  const [plans, setPlans] = useState<WhopPlan[] | null>(null);
  const [planId, setPlanId] = useState('');
  const [title, setTitle] = useState('');
  useEffect(() => {
    if (tab !== 'whop' || !conn) return;
    let alive = true;
    setProducts(null);
    setProductId('');
    setError('');
    whopProducts(conn.id)
      .then((r) => alive && setProducts(r.products))
      .catch((e) => {
        if (!alive) return;
        setProducts([]);
        setError(message(e));
      });
    return () => {
      alive = false;
    };
  }, [tab, conn?.id]);
  useEffect(() => {
    if (!conn || !productId) return;
    let alive = true;
    setPlans(null);
    setPlanId('');
    whopPlans(conn.id, productId)
      .then((r) => alive && setPlans(r.plans))
      .catch((e) => {
        if (!alive) return;
        setPlans([]);
        setError(message(e));
      });
    return () => {
      alive = false;
    };
  }, [conn?.id, productId]);

  // ── your own link ──
  const [url, setUrl] = useState('');
  const [price, setPrice] = useState('');

  const run = async (what: string, fn: () => Promise<void>, kind?: 'whop' | 'own' | 'stripe') => {
    setBusy(what);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(message(e));
      // an answer from the server (not a lost connection): nothing was made, so the next try is a new request
      if (kind) setCrids((c) => requestIdsAfter(c, kind, e));
    } finally {
      setBusy('');
    }
  };
  const done = (o: Offer) => {
    useOffers.getState().put(o);
    onAttach(o);
  };
  const createWhop = () =>
    run('create', async () => {
      if (!conn) return;
      const product = products?.find((p) => p.id === productId);
      const got = await createWhopOffer({
        projectId,
        connectionId: conn.id,
        productId,
        variantId: planId,
        clientRequestId: crids.whop,
        title: title.trim() || product?.title || undefined,
      });
      useOffers.getState().put(got.offer);
      if (got.unconfirmed) setPending(got.offer);
      else done(got.offer);
    }, 'whop');
  const checkAgain = () =>
    run('check', async () => {
      if (!pending) return;
      const got = await checkOffer(pending.id);
      useOffers.getState().put(got.offer);
      if (got.unconfirmed) setPending(got.offer);
      else {
        setPending(null);
        done(got.offer);
      }
    });
  const createOwn = () =>
    run('create', async () => {
      done(
        await createExternalOffer({
          projectId,
          title: title.trim(),
          url: url.trim(),
          priceDisplay: price.trim() || undefined,
          clientRequestId: crids.own,
        }),
      );
    }, 'own');

  const createStripe = (input: StripeOfferInput) =>
    run('create', async () => {
      done(await createStripeOffer({ projectId, ...input, clientRequestId: crids.stripe }));
    }, 'stripe');

  const tabs = [
    ...(choosable.length ? [{ id: 'pick' as const, label: 'Your offers' }] : []),
    ...(stripeOn ? [{ id: 'stripe' as const, label: 'New: Stripe' }] : []),
    ...(whopOn ? [{ id: 'whop' as const, label: 'New: Whop' }] : []),
    { id: 'external' as const, label: 'New: your own link' },
  ];
  const product = products?.find((p) => p.id === productId);
  const plan = plans?.find((p) => p.id === planId);
  const hint = checkoutHint(url);

  if (pending) {
    return (
      <div className="flex flex-col gap-3">
        <Callout tone="warn" title="Whop didn’t confirm the link yet">
          The checkout link for “{pending.title}” may have been made. Check again asks Whop for the same link, so nothing is made twice.
        </Callout>
        {error && <Callout tone="bad">{error}</Callout>}
        <div>
          <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void checkAgain()}>
            {busy === 'check' ? <Spinner size={14} /> : <RefreshCw aria-hidden="true" />}
            Check again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Segmented<Tab> aria-label="Attach" value={tab} onChange={(t) => (setTab(t), setError(''))} options={tabs} />

      {tab === 'pick' && (
        <ul className="flex flex-col divide-y divide-line rounded-pop border border-line" aria-label="Your offers">
          {choosable.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                className={cn('flex w-full min-w-0 flex-wrap items-center gap-2 px-3 py-2.5 text-left transition-colors duration-120 hover:bg-surface-2', o.id === value && 'bg-surface-2')}
                onClick={() => onAttach(o)}
                aria-pressed={o.id === value}
              >
                <span className="min-w-0 truncate text-ui text-ink">{o.title}</span>
                {offerPrice(o) && <span className="text-small text-ink-2">{offerPrice(o)}</span>}
                <span className="ml-auto">
                  <OfferBadges offer={o} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {tab === 'stripe' && stripeOn && (
        connect ? (
          <StripeOfferForm projectId={projectId} connect={connect} defaultTitle={defaultTitle} busy={busy === 'create'} error={error} onCreate={(i) => void createStripe(i)} />
        ) : (
          <p className="flex items-center gap-2 text-small text-muted">
            <Spinner size={14} /> Checking your Stripe account…
          </p>
        )
      )}

      {tab === 'whop' && !usable.length && (
        <Callout
          tone="info"
          action={
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={() => {
                useUI.getState().setSettingsTab('payments');
                navigate('workspace-settings');
              }}
            >
              Open Settings
            </button>
          }
        >
          Connect your Whop account in Settings › Payments first.
        </Callout>
      )}
      {tab === 'whop' && usable.length > 0 && (
        <div className="flex flex-col gap-3">
          {usable.length > 1 && (
            <Segmented<WhopEnvironment>
              size="sm"
              aria-label="Which Whop account"
              value={env}
              onChange={setEnv}
              options={[
                { id: 'production', label: 'Live' },
                { id: 'sandbox', label: 'Test mode' },
              ]}
            />
          )}
          {env === 'sandbox' && <p className="text-caption text-warn">Test mode: buyers can’t really pay, and its sales never count as revenue.</p>}
          <Field label="Whop product" htmlFor="attach-whop-product">
            {products === null ? (
              <p className="flex items-center gap-2 text-small text-muted">
                <Spinner size={14} /> Loading your products…
              </p>
            ) : products.length ? (
              <select id="attach-whop-product" className="select" value={productId} onChange={(e) => setProductId(e.target.value)}>
                <option value="">Choose a product</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title || p.id}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-small text-muted">No products in this Whop account yet. Make one in Whop’s dashboard, then come back.</p>
            )}
          </Field>
          {productId && (
            <Field label="Plan (its price comes from Whop)" htmlFor="attach-whop-plan">
              {plans === null ? (
                <p className="flex items-center gap-2 text-small text-muted">
                  <Spinner size={14} /> Loading its plans…
                </p>
              ) : plans.length ? (
                <select id="attach-whop-plan" className="select" value={planId} onChange={(e) => setPlanId(e.target.value)}>
                  <option value="">Choose a plan</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {[p.title, p.renewal?.display || p.price.display].filter(Boolean).join(' · ') || p.id}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-small text-muted">This product has no plans. Add a price to it in Whop first.</p>
              )}
            </Field>
          )}
          {plan && (
            <Field label="Title" htmlFor="attach-whop-title" hint="What your pages and Analytics call it.">
              <input id="attach-whop-title" className="input" value={title} placeholder={product?.title ?? ''} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          )}
          {error && <Callout tone="bad">{error}</Callout>}
          <div>
            <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || !plan || !conn} onClick={() => void createWhop()}>
              {busy === 'create' ? <Spinner size={14} /> : <Plus aria-hidden="true" />}
              Create buy link
            </button>
          </div>
        </div>
      )}

      {tab === 'external' && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void createOwn();
          }}
        >
          <Field label="Your checkout link" htmlFor="attach-own-url" hint={hint || 'A Stripe Payment Link, Gumroad, Square, PayPal, Shopify or your own checkout page.'}>
            <input id="attach-own-url" className="input" type="url" inputMode="url" value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Field label="Title" htmlFor="attach-own-title">
              <input id="attach-own-title" className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="Price (as shown)" htmlFor="attach-own-price">
              <input id="attach-own-price" className="input" value={price} maxLength={40} placeholder="$49" onChange={(e) => setPrice(e.target.value)} />
            </Field>
          </div>
          <p className="text-caption text-muted">Buyers pay on that site, so only clicks on its buy link show in Analytics, not sales.</p>
          {error && <Callout tone="bad">{error}</Callout>}
          <div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy || !url.trim() || !title.trim()}>
              {busy === 'create' ? <Spinner size={14} /> : <Link2 aria-hidden="true" />}
              Create buy link
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * The payment of something sold: the attached offer, or "Attach payment". `fallback` is the old plain link field,
 * shown alone where offers aren't available (signed out, the server's offers off, the claude.ai build).
 */
export function AttachPayment({
  projectId,
  value,
  onAttach,
  onDetach,
  fallback,
  label = 'Attach payment',
  defaultTitle,
}: {
  projectId: string;
  value?: string;
  onAttach: (offer: Offer) => void;
  onDetach: () => void;
  fallback?: ReactNode;
  label?: string;
  /** a new offer's title to start with (optional: the asset's or page's name) */
  defaultTitle?: string;
}) {
  const { on, offers, loaded, whop, stripe } = useProjectOffers(projectId);
  const connections = useOffers((s) => s.connections);
  const connect = useOffers((s) => s.connect);
  const [open, setOpen] = useState(false);
  const [openKey, setOpenKey] = useState(0);
  useEffect(() => {
    if (on && whop && connections === null) void useOffers.getState().refreshConnections();
  }, [on, whop, connections]);
  // the Stripe account (and fee) when the dialog opens: read again each time, as its setup may have moved on
  useEffect(() => {
    if (open && on && stripe && !__ARTIFACT_BUILD__) void useOffers.getState().refreshConnect();
  }, [open, on, stripe]);
  if (!on) return <>{fallback ?? null}</>;
  const offer = value ? offers.find((o) => o.id === value) : undefined;
  const conn = offer ? offerConnection(offer, connections) : null;
  const show = () => {
    setOpenKey((k) => k + 1);
    setOpen(true);
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {offer ? (
        <AttachedOffer offer={offer} connection={conn} onChange={show} onRemove={onDetach} />
      ) : value && loaded ? (
        <Callout
          tone="warn"
          action={
            <button type="button" className="btn btn-secondary btn-xs" onClick={onDetach}>
              Remove
            </button>
          }
        >
          The attached offer isn’t in your account anymore, so its Buy buttons go nowhere.
        </Callout>
      ) : value ? (
        <p className="flex items-center gap-2 text-small text-muted">
          <Spinner size={14} /> Loading the offer…
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={show}>
            <CreditCard aria-hidden="true" />
            {label}
          </button>
        </div>
      )}
      {!offer && fallback && <div className="min-w-0">{fallback}</div>}
      <Modal open={open} onClose={() => setOpen(false)} title="Attach payment" subtitle={stripe ? 'What its Buy buttons sell. Buyers pay through your own Stripe account, Whop, or your own checkout.' : 'What its Buy buttons sell. Buyers pay on Whop or your own checkout; the app never takes payments.'} size="md">
        <AttachPaymentForm
          key={openKey}
          projectId={projectId}
          offers={offers}
          connections={connections ?? []}
          whopOn={whop}
          stripeOn={stripe}
          connect={connect}
          defaultTitle={defaultTitle}
          value={value}
          onAttach={(o) => {
            setOpen(false);
            onAttach(o);
          }}
        />
      </Modal>
    </div>
  );
}
