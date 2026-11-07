// Settings › Payments: connect your own Whop account, so a business's offers sell through it (src/lib/offers.ts,
// server/payments/whop.mjs). One connection per mode: Live, and Test (Whop's sandbox, where nothing is charged).
// The API key goes to the server once and stays there, sealed; the browser only ever sees its last 4 characters,
// and the field is emptied after every try. Whop's own error text never reaches this page: the server answers in
// our words. Refunds and disputes stay in Whop. Above it, "Get paid with Stripe" (StripeConnectCard.tsx) when the
// server has Stripe Connect on.

import { useEffect, useState, type FormEvent } from 'react';
import { CircleAlert, ExternalLink, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { fmtRelative } from '@/lib/utils';
import { useAuth } from '@/lib/cloud/auth';
import { OffersError, WHOP_EVENTS, WHOP_PERMISSIONS, checkWhop, connectWhop, disconnectWhop, enableWhopWebhook, pasteWebhookSecret, replaceWhopKey, type OffersConfig, type WhopConnection, type WhopEnvironment } from '@/lib/offers';
import { useOffers } from '@/store/offers';
import { toast } from '@/store/ui';
import { Badge, Callout, CopyButton, Field, Segmented, SettingsSection, Spinner, confirmAction } from '@/components/ui/primitives';
import { StripeConnectCard } from './StripeConnectCard';

const MODE_LABEL: Record<WhopEnvironment, string> = { production: 'Live', sandbox: 'Test mode' };
const NOTICE: Record<string, string> = {
  NO_PUBLIC_ADDRESS: 'Connected. This app has no public https address yet, so set up sales updates in Whop yourself (below).',
  WEBHOOK_MANUAL: 'Connected. Your key can’t set up sales updates, so make the webhook in Whop yourself (below).',
  WEBHOOK_UNCONFIRMED: 'Connected. Whop didn’t confirm the sales updates yet: use Check again in a minute.',
  WEBHOOK_MADE_WITHOUT_SECRET: 'Whop has a webhook for this app, but its secret can’t be read back. Delete it in Whop, then make it again by hand (below).',
  WEBHOOK_GONE: 'The webhook isn’t in Whop anymore. Make it again by hand (below).',
};

/** What the page needs to act; the real ones talk to the server (tests pass their own). */
export interface PaymentActions {
  connect: (environment: WhopEnvironment, accountId: string, key: string) => Promise<string | null>;
  check: (id: string) => Promise<string | null>;
  replaceKey: (id: string, key: string) => Promise<string | null>;
  pasteSecret: (id: string, secret: string) => Promise<void>;
  enableWebhook: (id: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
}

const message = (e: unknown) => (e instanceof OffersError || e instanceof Error ? e.message : 'Something went wrong. Try again.');

/** The webhook's state in plain words. */
export function webhookWords(c: WhopConnection): { tone: 'good' | 'warn' | 'bad' | 'neutral'; text: string } {
  if (c.status === 'key_rejected') return { tone: 'bad', text: 'Key not accepted' };
  if (c.webhook.state === 'ok') return { tone: 'good', text: 'Receiving sales' };
  if (c.webhook.state === 'disabled') return { tone: 'bad', text: 'Whop turned off sales updates' };
  if (c.webhook.state === 'unknown') return { tone: 'warn', text: 'Not confirmed yet' };
  return { tone: 'warn', text: c.webhook.mode === 'manual' ? 'Waiting for your webhook' : 'Not set up yet' };
}

/** One mode's Whop account: connect, or what's connected and what to do next. */
function WhopCard({ environment, connection, actions }: { environment: WhopEnvironment; connection: WhopConnection | null; actions: PaymentActions }) {
  const [accountId, setAccountId] = useState('');
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const test = environment === 'sandbox';
  const field = `whop-${environment}`;

  const run = async (what: string, fn: () => Promise<string | null | void>) => {
    setBusy(what);
    setError('');
    try {
      const notice = await fn();
      if (notice && NOTICE[notice]) toast({ kind: 'info', title: NOTICE[notice] });
    } catch (e) {
      setError(message(e));
    } finally {
      // the pasted key and secret never stay in the page, whatever happened
      setKey('');
      setSecret('');
      setBusy('');
    }
  };

  const onConnect = (e: FormEvent) => {
    e.preventDefault();
    if (!accountId.trim() || !key.trim()) return;
    void run('connect', () => actions.connect(environment, accountId.trim(), key.trim()));
  };
  const onReplace = (e: FormEvent) => {
    e.preventDefault();
    if (!connection || !key.trim()) return;
    void run('key', async () => {
      const n = await actions.replaceKey(connection.id, key.trim());
      setReplacing(false);
      return n;
    });
  };

  if (!connection) {
    return (
      <form onSubmit={onConnect} className="flex flex-col gap-4 py-4" aria-label={`Connect Whop (${MODE_LABEL[environment]})`}>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-small text-ink-2">
          <li>
            In Whop’s dashboard{test ? ' (sandbox.whop.com, for Test mode)' : ''}, open Developer and make an API key for your company. Make sure it has these permissions:
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {WHOP_PERMISSIONS.map((p) => (
                <li key={p.name}>
                  <code className="font-mono text-caption text-ink">{p.name}</code> <span className="text-muted">to {p.why}{p.optional ? ' (optional: without it you set that up by hand)' : ''}</span>
                </li>
              ))}
            </ul>
          </li>
          <li>Copy your company’s id: it starts with biz_ (Whop dashboard › Settings).</li>
          <li>Paste both here. The key goes to this app’s server once, sealed; you’ll only ever see its last 4 characters.</li>
        </ol>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Whop company id" htmlFor={`${field}-account`}>
            <input id={`${field}-account`} className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="biz_…" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="API key" htmlFor={`${field}-key`}>
            <input id={`${field}-key`} type="password" autoComplete="off" className="input" value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} />
          </Field>
        </div>
        {error && <Callout tone="bad">{error}</Callout>}
        <div className="flex items-center gap-2">
          <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy || !accountId.trim() || !key.trim()}>
            {busy === 'connect' && <Spinner size={14} />}
            Connect{test ? ' in Test mode' : ''}
          </button>
          <a className="btn btn-ghost btn-sm" href={test ? 'https://sandbox.whop.com/dashboard' : 'https://whop.com/dashboard'} target="_blank" rel="noopener noreferrer">
            Open Whop <ExternalLink aria-hidden="true" />
          </a>
        </div>
      </form>
    );
  }

  const state = webhookWords(connection);
  const manual = connection.webhook.mode === 'manual';
  return (
    <div className="flex flex-col gap-4 py-4">
      <dl className="grid gap-x-6 gap-y-2 text-small sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="text-muted">Account</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-2 text-ink">
          <span className="truncate font-mono">{connection.accountId}</span>
          {connection.accountName && <span className="text-ink-2">{connection.accountName}</span>}
          {test && <Badge tone="warn">Test mode</Badge>}
        </dd>
        <dt className="text-muted">API key</dt>
        <dd className="font-mono text-ink">…{connection.keyLast4}</dd>
        <dt className="text-muted">Sales updates</dt>
        <dd>
          <Badge tone={state.tone} dot>
            {state.text}
          </Badge>
        </dd>
        <dt className="text-muted">Last sale update</dt>
        <dd className="text-ink-2">{connection.lastEventAt ? fmtRelative(connection.lastEventAt) : 'None yet'}</dd>
      </dl>

      {connection.status === 'key_rejected' && (
        <Callout tone="bad" title="Whop no longer accepts this key">
          Your offers on this account aren’t selling until you replace it. Make a new key in Whop with the same permissions, then use Replace key.
        </Callout>
      )}
      {connection.webhook.state === 'disabled' && (
        <Callout
          tone="bad"
          title="Whop turned off sales updates"
          action={
            connection.webhook.mode === 'auto' ? (
              <button type="button" className="btn btn-secondary btn-xs" disabled={!!busy} onClick={() => void run('enable', () => actions.enableWebhook(connection.id))}>
                {busy === 'enable' && <Spinner size={12} />}
                Turn back on
              </button>
            ) : undefined
          }
        >
          Whop stops sending them after days of failed deliveries. New sales won’t show here until they’re on again{connection.webhook.mode === 'manual' ? ': turn the webhook back on in Whop’s dashboard' : ''}.
        </Callout>
      )}
      {manual && connection.webhook.state !== 'ok' && (
        <div className="well flex flex-col gap-3 p-4">
          <p className="text-small text-ink-2">Set up sales updates in Whop’s dashboard (Developer › Webhooks): make a webhook for your company with this address and these events, then paste its secret here.</p>
          {connection.webhook.url ? (
            <div className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-surface-2 px-2 py-1 font-mono text-caption text-ink">{connection.webhook.url}</code>
              <CopyButton text={connection.webhook.url} label="Copy address" />
            </div>
          ) : (
            <p className="text-small text-muted">This app needs a public https address first (ask its owner to set APP_PUBLIC_URL).</p>
          )}
          <p className="text-caption text-muted">
            Events: <span className="font-mono text-ink-2">{WHOP_EVENTS.join(', ')}</span>
          </p>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (secret.trim()) void run('secret', () => actions.pasteSecret(connection.id, secret.trim()));
            }}
          >
            <Field label="Webhook secret" htmlFor={`${field}-secret`} className="min-w-[220px] flex-1">
              <input id={`${field}-secret`} type="password" autoComplete="off" className="input" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="ws_…" spellCheck={false} />
            </Field>
            <button type="submit" className="btn btn-secondary btn-sm" disabled={!!busy || !secret.trim()}>
              {busy === 'secret' && <Spinner size={14} />}
              Save secret
            </button>
          </form>
          {connection.webhook.state === 'unknown' && <p className="text-caption text-muted">Saved. The first sale, or Whop’s “Send test” on the webhook, confirms it.</p>}
        </div>
      )}

      {replacing && (
        <form onSubmit={onReplace} className="flex flex-wrap items-end gap-2">
          <Field label="New API key" htmlFor={`${field}-newkey`} className="min-w-[220px] flex-1" hint="From the same Whop company, with the same permissions.">
            <input id={`${field}-newkey`} type="password" autoComplete="off" className="input" value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} />
          </Field>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy || !key.trim()}>
            {busy === 'key' && <Spinner size={14} />}
            Save key
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReplacing(false)}>
            Cancel
          </button>
        </form>
      )}
      {error && <Callout tone="bad">{error}</Callout>}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void run('check', () => actions.check(connection.id))}>
          {busy === 'check' ? <Spinner size={14} /> : <RefreshCw aria-hidden="true" />}
          Check again
        </button>
        {!replacing && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => setReplacing(true)}>
            Replace key
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm text-bad" disabled={!!busy} onClick={() => void run('disconnect', () => actions.disconnect(connection.id))}>
          <Trash2 aria-hidden="true" />
          Disconnect
        </button>
      </div>
      <p className="text-caption text-muted">Refunds and disputes are handled in Whop. Sales show here as Refunded or Disputed when Whop tells us.</p>
    </div>
  );
}

/** The section as drawn for a given state (render tests use this directly). */
export function PaymentsView({ status, connections, environment, onEnvironment, actions }: { status: 'checking' | 'off' | 'signed-out' | 'ready'; connections: WhopConnection[] | null; environment: WhopEnvironment; onEnvironment: (e: WhopEnvironment) => void; actions: PaymentActions }) {
  const live = connections?.find((c) => c.environment === 'production') ?? null;
  const test = connections?.find((c) => c.environment === 'sandbox') ?? null;
  const connection = environment === 'sandbox' ? test : live;
  return (
    <div className="flex max-w-[880px] flex-col gap-4">
      <SettingsSection
        title="Whop"
        description="Sell your offers through your own Whop account. Buyers pay on Whop; the money goes to your Whop balance, and each sale shows in Analytics."
        actions={
          status === 'ready' ? (
            <Segmented
              size="sm"
              aria-label="Which Whop account"
              value={environment}
              onChange={onEnvironment}
              options={[
                { id: 'production', label: live ? 'Live · connected' : 'Live' },
                { id: 'sandbox', label: test ? 'Test mode · connected' : 'Test mode' },
              ]}
            />
          ) : undefined
        }
      >
        {status === 'checking' && (
          <div className="flex items-center gap-2 py-4 text-small text-muted">
            <Spinner size={14} /> Checking…
          </div>
        )}
        {status === 'off' && (
          <div className="py-4">
            <Callout tone="info">Payments aren’t set up on this app’s server yet. Until they are, attach your own checkout link to what you sell.</Callout>
          </div>
        )}
        {status === 'signed-out' && <p className="py-4 text-small text-muted">Sign in to connect your Whop account.</p>}
        {status === 'ready' && connections === null && (
          <div className="flex items-center gap-2 py-4 text-small text-muted">
            <Spinner size={14} /> Loading your Whop accounts…
          </div>
        )}
        {status === 'ready' && connections !== null && (
          <>
            {environment === 'sandbox' && (
              <p className="flex items-start gap-2 pt-3 text-small text-ink-2">
                <CircleAlert size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
                Test mode uses Whop’s sandbox: nothing is charged (use the card 4242 4242 4242 4242). Offers made here are labelled Test mode everywhere, and their sales never count as revenue.
              </p>
            )}
            <WhopCard key={`${environment}-${connection?.id ?? 'none'}`} environment={environment} connection={connection} actions={actions} />
          </>
        )}
      </SettingsSection>
      <p className="flex items-start gap-2 text-caption text-muted">
        <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        This app never takes payments and charges no fee on Whop sales. Your buy links send buyers to the checkout you attach, and only sales that come through those links show here.
      </p>
    </div>
  );
}

/** Whether "Get paid with Stripe" shows: the server has Stripe Connect on, signed in, never in the claude.ai build. */
export function showStripeCard(config: OffersConfig | null, signedIn: boolean): boolean {
  return !__ARTIFACT_BUILD__ && signedIn && !!config?.enabled && !!config.stripe.available;
}

/** Settings › Payments. */
export function PaymentsSection() {
  const signedIn = useAuth((s) => s.phase === 'ready');
  const config = useOffers((s) => s.config);
  const connections = useOffers((s) => s.connections);
  const [environment, setEnvironment] = useState<WhopEnvironment>('production');
  useEffect(() => {
    if (!config) void useOffers.getState().loadConfig();
  }, [config]);
  const whopOn = !!config?.enabled && (config.whop.production || config.whop.sandbox);
  useEffect(() => {
    if (signedIn && whopOn) void useOffers.getState().refreshConnections();
  }, [signedIn, whopOn]);

  const put = (c: WhopConnection) => {
    const list = (useOffers.getState().connections ?? []).filter((x) => x.id !== c.id && x.environment !== c.environment);
    useOffers.getState().setConnections(c.status === 'disconnected' ? list : [...list, c]);
  };
  const actions: PaymentActions = {
    connect: async (env, accountId, key) => {
      const got = await connectWhop({ environment: env, accountId, key });
      put(got.connection);
      toast({ kind: 'success', title: `Whop connected${env === 'sandbox' ? ' in Test mode' : ''}` });
      return got.notice;
    },
    check: async (id) => {
      const got = await checkWhop(id);
      put(got.connection);
      return got.notice;
    },
    replaceKey: async (id, key) => {
      const got = await replaceWhopKey(id, key);
      put(got.connection);
      toast({ kind: 'success', title: 'Key replaced' });
      return got.notice;
    },
    pasteSecret: async (id, secret) => put(await pasteWebhookSecret(id, secret)),
    enableWebhook: async (id) => put(await enableWhopWebhook(id)),
    disconnect: async (id) => {
      const ok = await confirmAction({ title: 'Disconnect Whop?', body: 'Your sales so far stay in Analytics. Buy links that use this account stop selling until you attach another payment.', confirmLabel: 'Disconnect', danger: true });
      if (!ok) return;
      let got: { paused: number; notice: string | null };
      try {
        got = await disconnectWhop(id);
      } catch (e) {
        if (!(e instanceof OffersError && e.code === 'OFFERS_LIVE')) throw e;
        const sure = await confirmAction({ title: 'Pause these buy links?', body: `${e.message} They’ll show “not available right now” until you attach another payment.`, confirmLabel: 'Pause them and disconnect', danger: true });
        if (!sure) return;
        got = await disconnectWhop(id, true);
      }
      useOffers.getState().setConnections((useOffers.getState().connections ?? []).filter((c) => c.id !== id));
      useOffers.getState().reset();
      void useOffers.getState().refreshConnections();
      toast({ kind: 'success', title: got.paused ? `Whop disconnected. ${got.paused} buy link${got.paused === 1 ? '' : 's'} paused.` : 'Whop disconnected' });
      if (got.notice === 'REMOVE_WEBHOOK_IN_WHOP') toast({ kind: 'info', title: 'Remove this app’s webhook in Whop’s dashboard (Developer › Webhooks): it couldn’t be removed from here.' });
    },
  };

  const status = !config ? 'checking' : !whopOn ? 'off' : !signedIn ? 'signed-out' : 'ready';
  // selling through the seller's own Stripe account (P6) comes first; never in the claude.ai build
  const stripeOn = showStripeCard(config, signedIn);
  if (!stripeOn) return <PaymentsView status={status} connections={connections} environment={environment} onEnvironment={setEnvironment} actions={actions} />;
  return (
    <div className="flex max-w-[880px] flex-col gap-4">
      <StripeConnectCard />
      {/* Whop off here: Stripe alone, without the "payments aren't set up" note */}
      {status !== 'off' && <PaymentsView status={status} connections={connections} environment={environment} onEnvironment={setEnvironment} actions={actions} />}
    </div>
  );
}
