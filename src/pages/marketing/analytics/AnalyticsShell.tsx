// The frame every Analytics tab shares: the 7/30-day range, when the numbers were fetched ("as of" in a
// tooltip), the source's status, and the way to Update (on the Marketing hub, never here). It loads the
// project's snapshots from the server (memory only) and hands the source's snapshot to the panel.
import { useEffect, type ReactNode } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';
import type { AnalyticsSnapshot, AnalyticsSource } from '@/lib/integrations/types';
import type { Project } from '@/lib/types';
import { fmtDateTime, fmtRelative } from '@/lib/utils';
import { snapshotOf, useAnalytics, type AnalyticsRange } from '@/store/analytics';
import { Badge, Callout, Empty, InfoTip, Segmented, Skeleton, Spinner, Tooltip } from '@/components/ui/primitives';
import { hasData, statusView } from './compute';
import { openMarketingHub } from './links';

const RANGES: { id: '7' | '30'; label: string }[] = [
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
];

/** About how much a refresh of this source used, from the snapshot (shown behind an ⓘ, never in body copy). */
export function costNote(costMicro: number): string {
  const usd = Math.max(0, costMicro) / 1e6;
  return usd > 0 ? `about $${usd < 0.01 ? usd.toFixed(3) : usd.toFixed(2)}` : 'a very small amount';
}

const TONE = { good: 'good', warn: 'warn', bad: 'bad', neutral: 'neutral' } as const;

export function AnalyticsShell<T>({
  project,
  source,
  label,
  metered,
  meteredNote,
  actions,
  empty,
  children,
}: {
  project: Project;
  source: AnalyticsSource;
  /** for screen readers: "Social analytics" */
  label: string;
  /** public data fetched per Update: an ⓘ says it uses a little of the analytics allowance */
  metered?: boolean;
  meteredNote?: string;
  actions?: ReactNode;
  /** shown instead of "No numbers yet" when there's nothing to fetch for this source */
  empty?: ReactNode;
  children: (snapshot: AnalyticsSnapshot<T>, range: AnalyticsRange) => ReactNode;
}) {
  const snapshots = useAnalytics((s) => s.snapshots[project.id]);
  const loading = useAnalytics((s) => s.snapshotsLoading[project.id] === true);
  const error = useAnalytics((s) => s.snapshotsError[project.id]);
  const range = useAnalytics((s) => s.range);
  const run = useAnalytics((s) => s.run);
  const runPhase = useAnalytics((s) => s.runPhase);

  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    void useAnalytics.getState().loadSnapshots(project.id);
  }, [project.id]);

  if (__ARTIFACT_BUILD__) {
    return (
      <Callout tone="info" title="Connected accounts and live analytics need the full app.">
        This version can’t fetch stats. Open the full app to see them.
      </Callout>
    );
  }

  const snap = snapshotOf<T>(snapshots, source);
  const updating = runPhase !== 'idle' && run?.projectId === project.id && (run.sources[source] === 'queued' || run.sources[source] === 'running');
  const sv = statusView(snap?.status, snap?.errorCode);

  let body: ReactNode;
  if (!snapshots && loading) {
    body = (
      <div className="flex flex-col gap-4" aria-label="Loading">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  } else if (!snapshots && error) {
    body = (
      <Callout
        tone="bad"
        action={
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => void useAnalytics.getState().loadSnapshots(project.id)}>
            Try again
          </button>
        }
      >
        {error}
      </Callout>
    );
  } else if (!hasData(snap)) {
    body =
      snap?.status === 'pending' ? (
        <Callout tone="info">Still loading. Press Update later.</Callout>
      ) : snap?.errorCode === 'CUSTOMER_CAP' ? (
        <CapCallout />
      ) : (
        empty ?? (
          <Empty
            icon={<BarChart3 />}
            title="No numbers yet"
            body="Press Update on the Marketing page to fetch them."
            action={
              <button type="button" className="btn btn-secondary btn-sm" onClick={openMarketingHub}>
                Go to Update
              </button>
            }
          />
        )
      );
  } else {
    body = (
      <>
        {snap!.errorCode === 'CUSTOMER_CAP' && <CapCallout className="mb-4" />}
        {snap!.errorCode === 'CUSTOMER_BLOCKED' && (
          <Callout tone="bad" className="mb-4">
            Analytics are paused for your account. Contact support.
          </Callout>
        )}
        {snap!.status === 'pending' && (
          <Callout tone="info" className="mb-4">
            Still loading. Press Update later.
          </Callout>
        )}
        {children(snap!, range)}
      </>
    );
  }

  return (
    <section aria-label={label} className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <Segmented size="sm" aria-label="Range" value={String(range) as '7' | '30'} onChange={(v) => useAnalytics.getState().setRange(v === '7' ? 7 : 30)} options={RANGES} />
          {snap?.fetchedAt && (
            <Tooltip content={`As of ${fmtDateTime(snap.fetchedAt)}`}>
              <span className="num text-small text-muted" tabIndex={0}>
                Updated {fmtRelative(snap.fetchedAt)}
              </span>
            </Tooltip>
          )}
          {updating ? (
            <span className="inline-flex items-center gap-1.5 text-small text-muted">
              <Spinner size={14} /> Updating…
            </span>
          ) : (
            snap && <Badge tone={TONE[sv.tone]}>{sv.label}</Badge>
          )}
          {metered && snap && (
            <InfoTip label="Where these numbers come from" title="Public data">
              {meteredNote ?? 'Public data, refreshed when you press Update.'} Each refresh uses a small amount of your analytics allowance ({costNote(snap.costMicro)}).
            </InfoTip>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <button type="button" className="link inline-flex items-center gap-1 text-small" onClick={openMarketingHub}>
            <RefreshCw size={14} aria-hidden="true" /> Update on Overview
          </button>
        </div>
      </div>
      {body}
    </section>
  );
}

function CapCallout({ className }: { className?: string }) {
  return (
    <Callout tone="warn" className={className}>
      You’ve reached today’s analytics limit. It resets at midnight UTC.
    </Callout>
  );
}

/** A plain table for analytics (third-party text goes in as text). */
export function DataTable({ caption, columns, rows, align }: { caption: string; columns: string[]; rows: ReactNode[][]; align?: ('left' | 'right')[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[480px] text-left text-small">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-line text-caption text-muted">
          <tr>
            {columns.map((c, i) => (
              <th key={c} className={`px-4 py-2 font-medium ${align?.[i] === 'right' ? 'text-right' : ''}`}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j} className={`px-4 py-2 text-ink-2 ${align?.[j] === 'right' ? 'num text-right font-mono' : ''}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
