// A business's sales through its Whop buy links, newest first: date, offer, amount, status, the buyer's email (the
// owner's own customer: shown here, never logged), Live or Test mode, and a CSV. Only what Whop told the server:
// no estimate, nothing made up. Refunds and disputes are handled in Whop.

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { fmtDate, slugify } from '@/lib/utils';
import { SALE_STATUS_LABEL, formatMoney, listSales, salesCsv, type Offer, type Sale, type WhopEnvironment } from '@/lib/offers';
import { Badge, Segmented, Spinner } from '@/components/ui/primitives';
import { download } from '@/components/ui/download';

const TONE: Record<Sale['status'], 'good' | 'warn' | 'bad' | 'neutral'> = {
  paid: 'good',
  pending: 'neutral',
  failed: 'bad',
  refunded: 'warn',
  partially_refunded: 'warn',
  disputed: 'bad',
};

/** The table as drawn for a list of sales (render tests use this directly). */
export function SalesRows({ sales, offers }: { sales: Sale[]; offers: Offer[] }) {
  const title = (id: string | null) => offers.find((o) => o.id === id)?.title ?? (id ? 'An archived offer' : '');
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
              </td>
              <td className="whitespace-nowrap py-2 pr-3">
                <Badge tone={TONE[s.status]}>{SALE_STATUS_LABEL[s.status]}</Badge>
              </td>
              <td className="max-w-[220px] truncate py-2 text-ink-2">{s.buyerEmail ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
      {sales && !sales.length && <p className="text-small text-muted">{env === 'sandbox' ? 'No test sales yet.' : 'No sales yet. Sales made through your Whop buy links show here.'}</p>}
      {sales && sales.length > 0 && <SalesRows sales={sales} offers={offers} />}
      {next && (
        <div>
          <button type="button" className="btn btn-ghost btn-sm" disabled={more} onClick={() => void loadMore()}>
            {more && <Spinner size={14} />} Show more
          </button>
        </div>
      )}
      <p className="text-caption text-muted">Refunds and disputes are handled in Whop; their status shows here when Whop tells us.</p>
    </div>
  );
}
