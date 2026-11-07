// A business's sales through its Stripe and Whop buy links, newest first: date, offer, amount (a Stripe sale with our
// fee under it, and how much of it went back), status (a Stripe dispute in words), the buyer's email (the owner's own
// customer: shown here, never logged), Live or Test mode, and a CSV. Only what Stripe or Whop told the server: no
// estimate, nothing made up. Refunds and disputes are handled in the seller's Stripe Dashboard or in Whop. A paid
// Stripe sale with a file gets a new 7-day download link for a buyer who lost theirs.

import { useEffect, useState } from 'react';
import { Download, ExternalLink, Link2 } from 'lucide-react';
import { fmtDate, slugify } from '@/lib/utils';
import { OffersError, formatMoney, listSales, saleStatusLabel, salesCsv, type Offer, type Sale, type WhopEnvironment } from '@/lib/offers';
import { dashboardUrl, saleDownloadLink } from '@/lib/stripeConnect';
import { Badge, CopyButton, Segmented, Spinner } from '@/components/ui/primitives';
import { download } from '@/components/ui/download';

const TONE: Record<Sale['status'], 'good' | 'warn' | 'bad' | 'neutral'> = {
  paid: 'good',
  pending: 'neutral',
  failed: 'bad',
  refunded: 'warn',
  partially_refunded: 'warn',
  disputed: 'bad',
};

/** A Stripe sale whose buyer can download a file again (paid, its offer delivers a file). */
export const canRelink = (s: Sale, offers: Offer[]): boolean => s.provider === 'stripe' && (s.status === 'paid' || s.status === 'partially_refunded') && offers.find((o) => o.id === s.offerId)?.delivery?.kind === 'file';

/** "Download link": asks the server for a new 7-day link, then offers it to copy (never sent anywhere by the app). */
export function SaleLinkButton({ saleId, initialUrl = '' }: { saleId: string; initialUrl?: string }) {
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (url) return <CopyButton text={url} label="Copy download link" size="xs" />;
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <button
        type="button"
        className="btn btn-ghost btn-xs"
        disabled={busy}
        title="A new link for this buyer, good for 7 days"
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            setUrl((await saleDownloadLink(saleId)).url);
          } catch (e) {
            setError(e instanceof OffersError || e instanceof Error ? e.message : 'Try again.');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Spinner size={12} /> : <Link2 aria-hidden="true" />}
        Download link
      </button>
      {error && <span className="text-caption text-bad">{error}</span>}
    </span>
  );
}

/** The table as drawn for a list of sales (render tests use this directly). */
export function SalesRows({ sales, offers }: { sales: Sale[]; offers: Offer[] }) {
  const title = (id: string | null) => offers.find((o) => o.id === id)?.title ?? (id ? 'An archived offer' : '');
  const links = sales.some((s) => canRelink(s, offers));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-small">
        <thead className="text-caption text-muted">
          <tr>
            <th className="py-2 pr-3 font-medium">Date</th>
            <th className="py-2 pr-3 font-medium">Offer</th>
            <th className="py-2 pr-3 text-right font-medium">Amount</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 font-medium">Buyer</th>
            {links && <th className="w-36 py-2 pl-3" aria-label="Actions" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {sales.map((s) => (
            <tr key={s.id}>
              <td className="num whitespace-nowrap py-2 pr-3 text-ink-2">{fmtDate(s.paidAt ?? s.createdAt ?? Date.now())}</td>
              <td className="max-w-[220px] truncate py-2 pr-3 text-ink">{title(s.offerId)}</td>
              <td className="num whitespace-nowrap py-2 pr-3 text-right text-ink">
                {formatMoney(s.amountMinor, s.currency)}
                {s.refundedMinor > 0 && <span className="block text-caption text-muted">−{formatMoney(s.refundedMinor, s.currency)} refunded</span>}
                {s.provider === 'stripe' && !!s.feeMinor && (
                  <span className="block text-caption text-muted">
                    Our fee {formatMoney(s.feeMinor, s.currency)}
                    {!!s.feeReturnedMinor && ` · ${formatMoney(s.feeReturnedMinor, s.currency)} returned`}
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap py-2 pr-3">
                <Badge tone={s.status === 'disputed' && s.disputeStatus === 'won' ? 'neutral' : TONE[s.status]}>{saleStatusLabel(s)}</Badge>
              </td>
              <td className="max-w-[220px] truncate py-2 text-ink-2">{s.buyerEmail ?? '—'}</td>
              {links && <td className="whitespace-nowrap py-2 pl-3 text-right">{canRelink(s, offers) && <SaleLinkButton saleId={s.id} />}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Where refunds and disputes are handled, for the business's offers (its Stripe Dashboard, Whop, or both). */
export function RefundsNote({ offers }: { offers: Offer[] }) {
  const stripe = offers.some((o) => o.provider === 'stripe');
  const whop = offers.some((o) => o.provider === 'whop') || !stripe;
  const test = offers.some((o) => o.provider === 'stripe' && o.environment === 'sandbox') && !offers.some((o) => o.provider === 'stripe' && o.environment === 'production');
  return (
    <p className="text-caption text-muted">
      {stripe && (
        <>
          Refunds and disputes:{' '}
          <a className="inline-flex items-center gap-1 underline" href={dashboardUrl(test ? 'sandbox' : 'production', 'payments')} target="_blank" rel="noopener noreferrer">
            in your Stripe Dashboard
            <ExternalLink size={12} aria-hidden="true" />
          </a>
          .{whop ? ' ' : ''}
        </>
      )}
      {whop && 'Whop’s refunds and disputes are handled in Whop; their status shows here when Whop tells us.'}
    </p>
  );
}

export function SalesTable({ projectId, brand, offers }: { projectId: string; brand: string; offers: Offer[] }) {
  const [env, setEnv] = useState<WhopEnvironment>('production');
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    setSales(null);
    setError('');
    listSales(projectId, { env, signal: ctl.signal })
      .then((r) => {
        setSales(r.sales);
        setNext(r.next);
      })
      .catch((e: Error) => {
        if (e?.name !== 'AbortError') setError(e.message);
      });
    return () => ctl.abort();
  }, [projectId, env]);

  const loadMore = async () => {
    if (!next) return;
    setMore(true);
    try {
      const r = await listSales(projectId, { env, before: next });
      setSales((s) => [...(s ?? []), ...r.sales]);
      setNext(r.next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMore(false);
    }
  };
  const exportCsv = () => {
    if (!sales?.length) return;
    const title = (id: string | null) => offers.find((o) => o.id === id)?.title ?? '';
    void download(`${slugify(brand) || 'your'}-sales${env === 'sandbox' ? '-test' : ''}.csv`, String.fromCharCode(0xfeff) + salesCsv(sales, title));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<WhopEnvironment>
          size="sm"
          aria-label="Live or Test mode sales"
          value={env}
          onChange={setEnv}
          options={[
            { id: 'production', label: 'Live' },
            { id: 'sandbox', label: 'Test mode' },
          ]}
        />
        <button type="button" className="btn btn-secondary btn-sm ml-auto" disabled={!sales?.length} onClick={exportCsv}>
          <Download aria-hidden="true" /> Export CSV
        </button>
      </div>
      {error && <p className="text-small text-bad">{error}</p>}
      {!sales && !error && (
        <p className="flex items-center gap-2 text-small text-muted">
          <Spinner size={14} /> Loading sales…
        </p>
      )}
      {sales && !sales.length && <p className="text-small text-muted">{env === 'sandbox' ? 'No test sales yet.' : 'No sales yet. Sales made through your buy links show here.'}</p>}
      {sales && sales.length > 0 && <SalesRows sales={sales} offers={offers} />}
      {next && (
        <div>
          <button type="button" className="btn btn-ghost btn-sm" disabled={more} onClick={() => void loadMore()}>
            {more && <Spinner size={14} />} Show more
          </button>
        </div>
      )}
      <RefundsNote offers={offers} />
    </div>
  );
}
