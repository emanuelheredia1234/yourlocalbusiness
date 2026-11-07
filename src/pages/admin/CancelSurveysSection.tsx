// Owner → Customer usage → Why people cancel: the cancel survey's answers (in-app, and the Customer Portal's own
// survey read from Stripe) as totals by reason over every answer, the latest comments, and the card trials (running,
// stopped as a second trial on a card or email already used: cancelled, nothing charged). Customers are shown by
// their opaque tag only.
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { getCancelSurveys, IntegrationApiError } from '@/lib/integrations/api';
import type { CancelReason, CancelSurveysResponse } from '@/lib/integrations/types';
import { fmtRelative } from '@/lib/utils';
import { tierName } from '@/lib/plans';
import { REASONS } from '@/components/billing/CancelDialog';
import { Badge, Callout, SettingsSection, Spinner, StatStrip } from '@/components/ui/primitives';

const label = (r: CancelReason) => REASONS.find((x) => x.id === r)?.label ?? r;
const OUTCOME: Record<string, string> = { cancelled: 'Cancelled', kept: 'Kept the plan', switched: 'Switched plan' };

export function CancelSurveysSection() {
  const [data, setData] = useState<CancelSurveysResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await getCancelSurveys());
      setError(null);
    } catch (e) {
      setError(e instanceof IntegrationApiError ? e.message : 'Couldn’t load the answers.');
    }
  }, []);
  useEffect(() => {
    if (!__ARTIFACT_BUILD__) void load();
  }, [load]);
  if (__ARTIFACT_BUILD__) return null;
  return (
    <SettingsSection
      title="Why people cancel"
      description="Answers to the cancel survey (in the app and in Stripe’s billing page), and the free trials."
      actions={
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
          <RefreshCw /> Refresh
        </button>
      }
    >
      <CancelSurveysView data={data} error={error} />
    </SettingsSection>
  );
}

/** The section's body (rendered in tests with fixed data). */
export function CancelSurveysView({ data, error }: { data: CancelSurveysResponse | null; error: string | null }) {
  if (error) return <Callout tone="bad" className="my-3">{error}</Callout>;
  if (!data)
    return (
      <p className="flex items-center gap-2 py-4 text-small text-muted" role="status">
        <Spinner size={14} /> Reading…
      </p>
    );
  if (data.missing) return <Callout tone="warn" className="my-3">Run {data.missing} in Supabase to keep cancel answers and trials.</Callout>;
  const rows = REASONS.map((r) => ({ ...r, n: data.counts[r.id] ?? { cancelled: 0, kept: 0 } })).filter((r) => r.n.cancelled + r.n.kept > 0).sort((a, b) => b.n.cancelled + b.n.kept - (a.n.cancelled + a.n.kept));
  return (
    <div className="flex flex-col gap-4 pb-4 pt-2">
      <StatStrip
        items={[
          { label: 'Trials running', value: data.trials.trialing },
          { label: 'Second trials stopped', value: data.trials.endedEarly, info: 'A trial on a card or email that already had one is cancelled at once. Nothing is charged; the app tells the person, and their next Checkout has no trial.' },
          { label: 'Cancel answers', value: data.total ?? data.recent.length },
        ]}
      />
      {data.partial && <p className="text-caption text-muted">These counts are the latest answers only: run the trial migration again to count every one.</p>}
      {rows.length ? (
        <table className="w-full text-left text-small" aria-label="Answers by reason">
          <thead className="border-b border-line text-caption text-muted">
            <tr>
              <th className="py-2 font-medium">Reason</th>
              <th className="py-2 text-right font-medium">Cancelled</th>
              <th className="py-2 text-right font-medium">Stayed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="py-2 text-ink">{r.label}</td>
                <td className="num py-2 text-right text-ink">{r.n.cancelled}</td>
                <td className="num py-2 text-right text-ink-2">{r.n.kept}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-small text-muted">No answers yet.</p>
      )}
      {data.recent.some((r) => r.comment) && (
        <ul className="flex flex-col divide-y divide-line border-t border-line" aria-label="Latest comments">
          {data.recent
            .filter((r) => r.comment)
            .slice(0, 20)
            .map((r, i) => (
              <li key={i} className="flex flex-col gap-1 py-2.5">
                <span className="flex flex-wrap items-center gap-2 text-caption text-muted">
                  <Badge tone={r.outcome === 'cancelled' ? 'warn' : 'good'}>{OUTCOME[r.outcome] ?? r.outcome}</Badge>
                  {label(r.reason)}
                  {r.tier ? ` · ${tierName(r.tier)}` : ''}
                  {r.source === 'portal' ? ' · Stripe billing page' : ''} · {fmtRelative(r.at)}
                </span>
                <span className="whitespace-pre-wrap break-words text-small text-ink">{r.comment}</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
