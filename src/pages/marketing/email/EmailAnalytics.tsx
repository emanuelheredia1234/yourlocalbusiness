// Email › Analytics: what the user's email account reports for the last 30 days (sends, opens, clicks,
// unsubscribes, revenue), its campaigns, and leads from the published page's form. Campaign names are the
// user's own text from their email tool: shown as text.
import { Mail } from 'lucide-react';
import type { Project } from '@/lib/types';
import type { EmailData } from '@/lib/integrations/types';
import { fmtDate } from '@/lib/utils';
import { snapshotOf, useAnalytics } from '@/store/analytics';
import { ChartCard, ColumnChart } from '@/components/charts/Charts';
import { Callout, Empty, StatStrip } from '@/components/ui/primitives';
import { AnalyticsShell, DataTable } from '../analytics/AnalyticsShell';
import { emailSeries, money, pct } from '../analytics/compute';

const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–');

export function EmailAnalytics({ project, onConnect }: { project: Project; onConnect: () => void }) {
  const snap = useAnalytics((s) => snapshotOf<EmailData>(s.snapshots[project.id], 'email'));
  const reconnect = snap?.status === 'not_connected' && snap.errorCode === 'NEEDS_RECONNECT';
  const notConnected = snap?.status === 'not_connected' && !reconnect;
  const connectCta = (
    <button type="button" className="btn btn-secondary btn-xs" onClick={onConnect}>
      Open Preview &amp; export
    </button>
  );
  return (
    <div className="flex flex-col gap-4">
      {reconnect && (
        <Callout tone="warn" action={connectCta}>
          Reconnect Omnisend to see email stats.
        </Callout>
      )}
      {notConnected && snap?.fetchedAt && (
        <Callout tone="info" action={connectCta}>
          Connect your email account to see email stats.
        </Callout>
      )}
      <AnalyticsShell<EmailData>
        project={project}
        source="email"
        label="Email analytics"
        empty={
          notConnected ? (
            <Empty
              icon={<Mail />}
              title="Connect your email account"
              body="Connect Omnisend under Preview & export, then press Update on the Marketing page."
              action={
                <button type="button" className="btn btn-secondary btn-sm" onClick={onConnect}>
                  Open Preview &amp; export
                </button>
              }
            />
          ) : undefined
        }
      >
        {(s, range) => <EmailBody data={s.data} range={range} />}
      </AnalyticsShell>
    </div>
  );
}

export function EmailBody({ data, range, now }: { data: EmailData; range: number; now?: number }) {
  const series = emailSeries(data, range, now);
  const campaigns = Array.isArray(data?.campaigns) ? data.campaigns : [];
  const currency = data?.currency || 'USD';
  return (
    <div className="flex flex-col gap-4">
      <StatStrip
        items={[
          { label: 'Sent', value: n(data?.sent), sub: 'Last 30 days' },
          { label: 'Open rate', value: pct(data?.openRate) },
          { label: 'Click rate', value: pct(data?.clickRate) },
          { label: 'Unsubscribe rate', value: pct(data?.unsubscribeRate) },
          { label: 'Attributed revenue', value: money(data?.revenue, currency) },
        ]}
      />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <ChartCard className="lg:col-span-2" title="Emails sent per day" subtitle={`Last ${range} days`} table={{ columns: ['Date', 'Sent', 'Opened', 'Clicked'], rows: series.map((s) => [fmtDate(s.date), s.sent, s.opened, s.clicked]) }}>
          {series.length ? <ColumnChart data={series.map((s) => ({ x: fmtDate(s.date), y: s.sent }))} label="Sent" /> : <p className="py-6 text-center text-small text-muted">Nothing sent in this range.</p>}
        </ChartCard>
        <section className="card p-4 sm:p-5" aria-label="Leads">
          <h3 className="text-h3 text-ink">Leads</h3>
          <p className="text-small text-muted">From your published page’s form</p>
          <p className="num mt-3 font-mono text-h1 text-ink">{n(data?.leads ?? 0)}</p>
        </section>
      </div>
      {campaigns.length > 0 ? (
        <DataTable
          caption="Campaigns"
          columns={['Campaign', 'Sent', 'Open', 'Click', 'Revenue']}
          align={['left', 'right', 'right', 'right', 'right']}
          rows={campaigns.map((c) => [<span key="c" className="block truncate">{c.name || 'Untitled campaign'}</span>, n(c.sent), pct(c.openRate), pct(c.clickRate), money(c.revenue, currency)])}
        />
      ) : (
        <p className="text-small text-muted">No campaigns sent in the last 30 days.</p>
      )}
    </div>
  );
}
