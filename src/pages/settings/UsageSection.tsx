// Settings › AI keys, beside the AI limits: what this person's analytics data has cost (their own rows only,
// from the server), against their daily and monthly caps. Estimated costs (connected accounts, X posts) are
// labelled and never count toward a cap. For the owner, a link to every customer's usage.
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import type { CustomerUsage } from '@/lib/integrations/types';
import { IntegrationApiError, getMyUsage } from '@/lib/integrations/api';
import { cn, fmtRelative } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { useAnalytics } from '@/store/analytics';
import { Badge, Callout, InfoTip, SettingsSection, Skeleton } from '@/components/ui/primitives';

/** USD with 4 decimals, from integer micros (1 USD = 1,000,000). */
export function usd4(micro: number): string {
  const n = (Number.isFinite(micro) ? micro : 0) / 1e6;
  return `$${n.toFixed(4)}`;
}

const FEATURE_LABEL: Record<string, string> = { social: 'Social stats', seo: 'SEO', ads: 'Ads', gsc: 'Search Console', email: 'Email', posting: 'Posting', connections: 'Connected accounts' };
export const featureLabel = (f: string) => FEATURE_LABEL[f] ?? f;

export function UsageSection() {
  const [usage, setUsage] = useState<CustomerUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owner = useAnalytics((s) => s.owner);
  const load = useCallback(async () => {
    try {
      const r = await getMyUsage(30);
      setUsage(r.usage);
      setError(null);
    } catch (e) {
      setError(e instanceof IntegrationApiError ? e.message : 'Couldn’t load your usage.');
    }
  }, []);
  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    void load();
    void useAnalytics.getState().loadOwner();
  }, [load]);
  if (__ARTIFACT_BUILD__) return null;
  return (
    <>
      <UsageView usage={usage} error={error} onRefresh={() => void load()} />
      {owner && (
        <SettingsSection title="Billing (owner)" description="Every customer’s analytics usage, their caps, and a CSV to bill from.">
          <div className="pb-4 pt-2">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void navigate('admin-billing')}>
              Open customer usage <ArrowRight />
            </button>
          </div>
        </SettingsSection>
      )}
    </>
  );
}

/** The usage card itself (rendered in tests with fixed data). */
export function UsageView({ usage, error, onRefresh }: { usage: CustomerUsage | null; error: string | null; onRefresh?: () => void }) {
  const caps = usage?.caps;
  const meter = (label: string, used: number, cap: number) => {
    const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
    return (
      <div>
        <p className="flex items-baseline justify-between gap-2 text-small">
          <span className="text-ink-2">{label}</span>
          <span className={cn('num font-mono text-caption', cap > 0 && used >= cap ? 'text-bad' : 'text-muted')}>{cap > 0 ? `${usd4(used)} of ${usd4(cap)}` : `${usd4(used)} · no limit`}</span>
        </p>
        {cap > 0 && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className={cn('h-full rounded-full', pct >= 100 ? 'bg-bad-solid' : pct >= 80 ? 'bg-warn-solid' : 'bg-primary')} style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
    );
  };
  return (
    <SettingsSection
      title="Analytics data costs"
      description="What your analytics updates have used: today and this month (UTC)."
      actions={
        <span className="flex items-center gap-1">
          <InfoTip label="What’s counted" title="What’s counted">
            Each Update fetches public stats, rankings and ads data, which costs a small amount. Costs marked “estimated” (connected accounts, posts to X) are list-price estimates: they show here but never count toward your limits.
          </InfoTip>
          {onRefresh && (
            <button type="button" className="btn btn-ghost btn-xs" onClick={onRefresh}>
              <RefreshCw /> Refresh
            </button>
          )}
        </span>
      }
    >
      {error && !usage && (
        <p role="alert" className="py-4 text-small text-bad">
          {error}
        </p>
      )}
      {!usage && !error && (
        <div className="flex flex-col gap-3 py-4" aria-label="Loading">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      )}
      {usage && caps && (
        <div className="flex flex-col gap-4 pb-5 pt-3">
          {caps.status === 'blocked' && <Callout tone="bad">Analytics are paused for your account. Contact support.</Callout>}
          <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            {meter('Today', usage.today.costMicro, caps.dailyCapMicro)}
            {meter('This month', usage.month.costMicro, caps.monthlyCapMicro)}
          </div>
          <p className="text-small text-muted">
            <span className="num font-mono text-ink-2">{usage.today.calls}</span> data request{usage.today.calls === 1 ? '' : 's'} today, <span className="num font-mono text-ink-2">{usage.month.calls}</span> this month.
          </p>
          {usage.byFeature.length > 0 && (
            <table className="w-full table-fixed text-left text-small">
              <caption className="sr-only">By feature, last 30 days</caption>
              <thead className="border-b border-line text-caption text-muted">
                <tr>
                  <th className="py-2 font-medium">Feature</th>
                  <th className="w-24 py-2 text-right font-medium">Requests</th>
                  <th className="w-28 py-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {usage.byFeature.map((f) => (
                  <tr key={f.feature}>
                    <td className="truncate py-2 text-ink-2">{featureLabel(f.feature)}</td>
                    <td className="num py-2 text-right font-mono text-muted">{f.calls}</td>
                    <td className="num py-2 text-right font-mono text-ink-2">{usd4(f.costMicro)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {usage.recent.length > 0 && (
            <details className="text-small">
              <summary className="cursor-pointer text-muted">Recent requests</summary>
              <ul className="mt-2 flex flex-col divide-y divide-line">
                {usage.recent.slice(0, 50).map((r, i) => (
                  <li key={`${r.at}-${i}`} className="flex items-center gap-3 py-1.5">
                    <span className="num w-20 shrink-0 font-mono text-caption text-muted">{fmtRelative(r.at)}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-2">{r.label}</span>
                    {r.estimated && <Badge>estimated</Badge>}
                    <span className="num shrink-0 font-mono text-caption text-ink-2">{usd4(r.costMicro)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {usage.today.calls === 0 && usage.month.calls === 0 && usage.recent.length === 0 && <p className="text-small text-muted">Nothing yet. Press Update on the Marketing page to fetch your stats.</p>}
        </div>
      )}
    </SettingsSection>
  );
}
