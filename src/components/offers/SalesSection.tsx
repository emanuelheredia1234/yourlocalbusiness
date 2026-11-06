// Analytics › Sales: sales through the business's Whop buy links (what Whop told the server: live sales only, gross
// per currency with refunds under it), clicks on all its buy links, and the sales list. Test mode sales are only a
// note. Sales on the owner's own checkout links happen on that site, so only their clicks show. Nothing estimated.

import { useEffect } from 'react';
import { fmtNum } from '@/lib/utils';
import { formatMoney, type SalesSummary } from '@/lib/offers';
import { useOffers, useProjectOffers } from '@/store/offers';
import { Section, StatStrip } from '@/components/ui/primitives';
import { SalesTable } from './SalesTable';

/** The tiles for a summary (render tests draw them directly). */
export function SalesTiles({ summary, days }: { summary: SalesSummary | null; days: number }) {
  const revenue = summary ? Object.entries(summary.live.revenue).filter(([, n]) => n > 0) : [];
  const refunded = summary ? Object.entries(summary.live.refunded).filter(([, n]) => n > 0) : [];
  const money = (rows: [string, number][]) => rows.map(([cur, n]) => formatMoney(n, cur)).join(' · ');
  return (
    <div className="flex flex-col gap-2">
      <StatStrip
        items={[
          { label: 'Sales', value: summary ? fmtNum(summary.live.count) : '–', sub: `Through your Whop buy links, last ${days} days` },
          { label: 'Revenue', value: summary ? money(revenue) || formatMoney(0, 'usd') : '–', sub: refunded.length ? `${money(refunded)} refunded` : 'Before Whop’s fees' },
          { label: 'Buy link clicks', value: summary ? fmtNum(summary.clicks) : '–', sub: 'All time, every buy link' },
        ]}
      />
      {summary && summary.test.count > 0 && (
        <p className="text-caption text-muted">
          Plus {fmtNum(summary.test.count)} Test mode sale{summary.test.count === 1 ? '' : 's'} (not counted).
        </p>
      )}
    </div>
  );
}

/** Analytics' sales part: nothing at all where offers aren't on or the business has none. */
export function SalesSection({ projectId, brand, days }: { projectId: string; brand: string; days: number }) {
  const { on, offers, loaded } = useProjectOffers(projectId);
  const summary = useOffers((s) => s.summary[projectId] ?? null);
  useEffect(() => {
    if (on) void useOffers.getState().refreshSummary(projectId, days);
  }, [on, projectId, days]);
  // archived offers aren't in the list, but their sales and clicks stay: those keep the section
  const sold = !!summary && (summary.live.count > 0 || summary.test.count > 0);
  const history = sold || (!!summary && (summary.clicks > 0 || summary.offers.length > 0));
  if (!on || !loaded || (!offers.length && !history)) return null;
  const fresh = summary && summary.days === days ? summary : null;
  return (
    <Section title="Sales" description="Sales made through your Whop buy links show here. Sales on your own checkout links happen on that site, so only their clicks show." className="mt-6">
      <div className="flex flex-col gap-6">
        <SalesTiles summary={fresh} days={days} />
        {(sold || offers.some((o) => o.provider === 'whop')) && <SalesTable projectId={projectId} brand={brand} offers={offers} />}
      </div>
    </Section>
  );
}
