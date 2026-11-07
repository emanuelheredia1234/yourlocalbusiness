// Owner → Customer usage → Stripe Connect (P6): whether selling with Stripe is set up (Connect on, the Connect webhook
// secret, an https APP_PUBLIC_URL, the seller terms published), the platform alerts the owner must see (customers only
// ever read "isn't available right now"), our fees (taken, returned, net) month to date and over 30 days, fee returns
// that need a look, and the sellers. Owner only (the server answers admins only); never in the claude.ai build. No
// Stripe id beyond the last 4, no key, ever.

import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, CircleX, RefreshCw } from 'lucide-react';
import { fmtRelative } from '@/lib/utils';
import { formatMoney, OffersError } from '@/lib/offers';
import { connectAdmin, resolveConnectAlert, type ConnectAdmin, type ConnectAdminSeller } from '@/lib/stripeConnect';
import { toast } from '@/store/ui';
import { Badge, Callout, SettingsSection, Spinner } from '@/components/ui/primitives';

/** Where the owner's steps are (docs/integrations-setup.md, "Stripe Connect: sellers get paid (P6)"). */
export const CONNECT_DOCS = 'docs/integrations-setup.md#stripe-connect-sellers-get-paid-p6';

/** Platform alerts in plain words, with what to do. */
export const CONNECT_ALERTS: Record<string, string> = {
  connect_not_enabled: 'Stripe refused to make a seller account: Connect isn’t turned on. Stripe Dashboard → Connect → Get started.',
  platform_profile_incomplete: 'Stripe needs the Connect platform profile finished: Stripe Dashboard → Settings → Connect → Platform profile.',
  key_missing_connect_permission: 'The Stripe key can’t do Connect. Add the Connect permissions to the restricted key (accounts, account links, Checkout on connected accounts, application fees), or use a secret key.',
  checkout_url_unexpected: 'Stripe sent a checkout address on a host we don’t send buyers to, so the buy link didn’t open. Check the host in the server log before allowing it.',
  webhook_secret_missing: 'The Connect webhook’s signing secret is missing: add STRIPE_CONNECT_WEBHOOK_SECRET in Replit Secrets.',
  fee_return_failed: 'Returning our fee to a seller after a refund failed. Check the fee returns below and in Stripe (Payments → Collected fees).',
  fee_return_unknown: 'Stripe didn’t confirm returning our fee to a seller for a day. Check it in Stripe (Payments → Collected fees): it’s never sent twice.',
  account_mismatch: 'A Stripe sale named a buy link that isn’t that seller’s. It wasn’t recorded: check the server log.',
  fee_not_allowed_br: 'A seller in Brazil sold without our fee: Stripe doesn’t allow it across borders.',
  connect_no_public_url: 'A buy link couldn’t open checkout: APP_PUBLIC_URL isn’t an https address. Set it in Replit Secrets.',
  connect_readback_lost: 'A seller’s Stripe account couldn’t be confirmed after Stripe didn’t answer. They can press Get paid with Stripe again.',
};
export const alertWords = (kind: string): string => CONNECT_ALERTS[kind] ?? `Stripe Connect needs a look (${kind.replace(/_/g, ' ')}). Check the server log.`;

const STATUS_WORDS: Record<string, { tone: 'good' | 'warn' | 'bad' | 'neutral'; text: string }> = {
  active: { tone: 'good', text: 'Receiving payments' },
  restricted: { tone: 'warn', text: 'Needs information' },
  onboarding: { tone: 'neutral', text: 'Setting up' },
  creating: { tone: 'neutral', text: 'Being confirmed' },
  unknown: { tone: 'neutral', text: 'Being confirmed' },
  rejected: { tone: 'bad', text: 'Closed by Stripe' },
  disconnected: { tone: 'neutral', text: 'Stopped' },
};
const ORDER = ['restricted', 'rejected', 'onboarding', 'unknown', 'creating', 'active'];
/** Sellers that need something first (restricted, then rejected, setting up…), then the active ones. */
export const sortSellers = (l: ConnectAdminSeller[]): ConnectAdminSeller[] => [...l].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));

const money = (m: Record<string, number>) =>
  Object.entries(m)
    .filter(([, n]) => n)
    .map(([c, n]) => formatMoney(n, c))
    .join(' · ') || '–';

function Check({ ok, label, hint }: { ok: boolean | null; label: string; hint: string }) {
  return (
    <li className="flex items-start gap-2 py-1.5">
      {ok ? <CircleCheck size={16} className="mt-0.5 shrink-0 text-good" aria-hidden="true" /> : <CircleX size={16} className={ok === null ? 'mt-0.5 shrink-0 text-muted' : 'mt-0.5 shrink-0 text-bad'} aria-hidden="true" />}
      <span className="min-w-0">
        <span className="block text-ui text-ink">
          {label}
          <span className="sr-only">{ok ? ': done' : ok === null ? ': not checked' : ': not yet'}</span>
        </span>
        {!ok && <span className="block text-caption text-muted">{hint}</span>}
      </span>
    </li>
  );
}

/** The section as drawn for an answer (render tests use this directly). */
export function ConnectView({ data, error, busy, onResolve }: { data: ConnectAdmin | null; error: string | null; busy?: string; onResolve: (kind: string) => void }) {
  if (error) return <Callout tone="bad">{error}</Callout>;
  if (!data)
    return (
      <p className="flex items-center gap-2 py-4 text-small text-muted">
        <Spinner size={14} /> Loading…
      </p>
    );
  const s = data.setup;
  const curs = Object.entries(data.fees.currencies);
  const counts = Object.entries(data.accounts.counts);
  return (
    <div className="flex flex-col gap-5 pb-4 pt-2">
      <div>
        <h4 className="text-ui text-ink">Setup {s.environment === 'sandbox' && <Badge tone="warn">Test mode</Badge>}</h4>
        <ul className="mt-1">
          <Check ok={s.connectEnabled} label="Connect is on in Stripe" hint="Stripe Dashboard → Connect → Get started, then the platform profile. With a restricted key, add the Connect permissions." />
          <Check ok={!s.missing.includes('STRIPE_CONNECT_WEBHOOK_SECRET')} label="Connect webhook secret" hint="Add the Connect webhook (Events from: Connected accounts) and put its signing secret in STRIPE_CONNECT_WEBHOOK_SECRET." />
          <Check ok={s.publicUrlOk} label="APP_PUBLIC_URL is the app’s https address" hint="Live setup links and checkout need https." />
          <Check ok={s.sellerTermsReady} label="Seller terms published" hint="Review the draft at /seller-terms (server/legal.mjs), then set SELLER_TERMS_READY. Until then only you can sell with Stripe." />
        </ul>
        {s.missing.length > 0 && <p className="mt-1 text-caption text-muted">Missing in Replit Secrets: {s.missing.join(', ')}</p>}
        <p className="mt-1 text-caption text-muted">
          Steps: <code className="font-mono">{CONNECT_DOCS}</code>
          {s.webhookLastAt ? ` · last Connect event ${fmtRelative(s.webhookLastAt)}` : ' · no Connect event yet'}
          {s.returnFees ? '' : ' · returning our fee is off (CONNECT_RETURN_FEES)'}
        </p>
      </div>

      <div>
        <h4 className="text-ui text-ink">Platform alerts</h4>
        {!data.alerts.length ? (
          <p className="mt-1 text-small text-muted">None. Customers only ever see “isn’t available right now”; what to fix shows here.</p>
        ) : (
          <ul className="mt-1 flex flex-col divide-y divide-line">
            {data.alerts.map((a) => (
              <li key={a.kind} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2">
                <span className="min-w-0 flex-1 basis-64 text-small text-ink">{alertWords(a.kind)}</span>
                <span className="text-caption text-muted">
                  {a.count}× · last {a.lastAt ? fmtRelative(a.lastAt) : '–'}
                </span>
                <button type="button" className="btn btn-ghost btn-xs" disabled={busy === a.kind} onClick={() => onResolve(a.kind)}>
                  {busy === a.kind && <Spinner size={12} />}
                  Mark resolved
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="text-ui text-ink">Our fees</h4>
        {!curs.length ? (
          <p className="mt-1 text-small text-muted">No Stripe sales in the last 30 days.</p>
        ) : (
          <div className="mt-1 overflow-x-auto">
            <table className="w-full min-w-[480px] text-left text-small">
              <thead className="text-caption text-muted">
                <tr>
                  <th className="py-2 pr-3 font-medium">Currency</th>
                  <th className="py-2 pr-3 text-right font-medium">Month to date: taken</th>
                  <th className="py-2 pr-3 text-right font-medium">Returned</th>
                  <th className="py-2 pr-3 text-right font-medium">Net</th>
                  <th className="py-2 text-right font-medium">30 days: net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {curs.map(([cur, t]) => (
                  <tr key={cur}>
                    <td className="py-2 pr-3 text-ink">{cur.toUpperCase()}</td>
                    <td className="num py-2 pr-3 text-right">{formatMoney(t.monthToDate.fees, cur)}</td>
                    <td className="num py-2 pr-3 text-right">{formatMoney(t.monthToDate.returned, cur)}</td>
                    <td className="num py-2 pr-3 text-right text-ink">{formatMoney(t.monthToDate.net, cur)}</td>
                    <td className="num py-2 text-right text-ink">{formatMoney(t.last30.net, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.fees.returns.length > 0 && (
          <div className="mt-2">
            <p className="text-caption text-muted">Fee returns that need a look (never sent twice; the hourly check reads Stripe back):</p>
            <ul className="mt-1 flex flex-col gap-1">
              {data.fees.returns.map((r) => (
                <li key={r.sourceId} className="flex flex-wrap items-center gap-2 text-small">
                  <Badge tone={r.state === 'failed' ? 'bad' : 'warn'}>{r.state === 'failed' ? 'Failed' : r.state === 'unknown' ? 'Not confirmed' : 'Waiting for the fee'}</Badge>
                  <span className="num text-ink-2">{r.amountMinor} (smallest currency unit)</span>
                  <span className="text-caption text-muted">
                    {r.createdAt ? fmtRelative(r.createdAt) : ''}
                    {r.errorCode ? ` · ${r.errorCode}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div>
        <h4 className="text-ui text-ink">Sellers</h4>
        {counts.length > 0 && (
          <p className="mt-1 text-caption text-muted">
            {counts.map(([k, n]) => `${n} ${STATUS_WORDS[k]?.text.toLowerCase() ?? k}`).join(' · ')}
          </p>
        )}
        {!data.accounts.sellers.length ? (
          <p className="mt-1 text-small text-muted">No sellers yet.</p>
        ) : (
          <div className="mt-1 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-small">
              <thead className="text-caption text-muted">
                <tr>
                  <th className="py-2 pr-3 font-medium">Customer</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Country</th>
                  <th className="py-2 pr-3 font-medium">Payments / payouts</th>
                  <th className="py-2 pr-3 text-right font-medium">Due</th>
                  <th className="py-2 pr-3 text-right font-medium">30 days</th>
                  <th className="py-2 text-right font-medium">Our fees</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {sortSellers(data.accounts.sellers).map((x, i) => {
                  const w = STATUS_WORDS[x.status] ?? { tone: 'neutral' as const, text: x.status };
                  return (
                    <tr key={`${x.customerTag}-${i}`}>
                      <td className="max-w-[220px] py-2 pr-3">
                        <span className="block truncate text-ink">{x.email || '—'}</span>
                        <span className="block truncate font-mono text-caption text-muted">{x.customerTag}</span>
                      </td>
                      <td className="py-2 pr-3">
                        <Badge tone={w.tone}>{w.text}</Badge>
                      </td>
                      <td className="py-2 pr-3 text-ink-2">{x.country}</td>
                      <td className="py-2 pr-3 text-ink-2">
                        {x.chargesEnabled ? 'On' : 'Off'} / {x.payoutsEnabled ? 'On' : 'Off'}
                      </td>
                      <td className="num py-2 pr-3 text-right">{x.dueNow || '–'}</td>
                      <td className="num py-2 pr-3 text-right">
                        {x.last30.count} · {money(x.last30.gross)}
                      </td>
                      <td className="num py-2 text-right">{money(x.last30.fees)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function ConnectSection() {
  const [data, setData] = useState<ConnectAdmin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try {
      setData(await connectAdmin());
      setError(null);
    } catch (e) {
      setError(e instanceof OffersError || e instanceof Error ? e.message : 'Couldn’t load Stripe Connect.');
    }
  }, []);
  useEffect(() => {
    if (!__ARTIFACT_BUILD__) void load();
  }, [load]);
  if (__ARTIFACT_BUILD__) return null;
  const resolve = async (kind: string) => {
    setBusy(kind);
    try {
      await resolveConnectAlert(kind);
      setData((d) => (d ? { ...d, alerts: d.alerts.filter((a) => a.kind !== kind) } : d));
      toast({ kind: 'success', title: 'Marked resolved' });
    } catch (e) {
      toast({ kind: 'error', title: (e as Error)?.message || 'That didn’t work. Try again.' });
    } finally {
      setBusy('');
    }
  };
  return (
    <SettingsSection
      title="Stripe Connect"
      description="Sellers getting paid through their own Stripe accounts: setup, alerts, our fees and the sellers."
      actions={
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
          <RefreshCw /> Refresh
        </button>
      }
    >
      <ConnectView data={data} error={error} busy={busy} onResolve={(k) => void resolve(k)} />
    </SettingsSection>
  );
}
