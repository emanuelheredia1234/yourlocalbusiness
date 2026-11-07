// Owner → Customer usage → Morning action (P4): the hourly job's last run (counts only), whether a key powers the
// "Morning action" function, and one warning per alert of the last week in plain words (kinds only: never a
// provider's message, a key, a customer or a business). Not shown in the claude.ai build.
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { IntegrationApiError, getMorningOwner } from '@/lib/integrations/api';
import type { MorningOwner } from '@/lib/integrations/types';
import { fmtRelative } from '@/lib/utils';
import { Callout, SettingsSection, Spinner, StatStrip } from '@/components/ui/primitives';

/** Each alert kind in plain words for the owner. */
export function morningAlertText(kind: string, n?: number): string {
  switch (kind) {
    case 'ai_key':
      return 'The AI key that powers Morning action was refused. Check it in Settings › AI keys.';
    case 'ai_credits':
      return 'The AI key that powers Morning action is out of credits. Add credits with that provider.';
    case 'ai_rate':
      return 'The AI key that powers Morning action was rate limited. Its provider’s limits may need raising.';
    case 'ai_model':
      return 'The model chosen for Morning action wasn’t found. Pick another model in Settings › AI keys.';
    case 'backlog':
      return `Morning actions are falling behind: ${n ?? 'some'} business${n === 1 ? '' : 'es'} waited more than 3 hours. Raise MORNING_PER_TICK or MORNING_CONCURRENCY.`;
    default:
      return 'Morning action needs attention.';
  }
}

/** The alerts to show: the latest of each kind this week (or the single latest one from an older server). */
export function morningAlerts(alert: MorningOwner['alert']): { kind: string; at: string; n?: number }[] {
  if (!alert) return [];
  const kinds = alert.kinds && typeof alert.kinds === 'object' ? Object.entries(alert.kinds).map(([kind, v]) => ({ kind, at: v.at, ...(v.n != null ? { n: v.n } : {}) })) : [];
  const list = kinds.length ? kinds : [{ kind: alert.kind, at: alert.at, ...(alert.n != null ? { n: alert.n } : {}) }];
  return list.sort((a, b) => b.at.localeCompare(a.at));
}

export function MorningSection() {
  const [data, setData] = useState<MorningOwner | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await getMorningOwner());
      setError(null);
    } catch (e) {
      setError(e instanceof IntegrationApiError ? e.message : 'Couldn’t load the morning action’s status.');
    }
  }, []);
  useEffect(() => {
    if (!__ARTIFACT_BUILD__) void load();
  }, [load]);
  if (__ARTIFACT_BUILD__) return null;
  return (
    <SettingsSection
      title="Morning action"
      description="Each business’s action for today, made by the hourly job by about 5 am in its time zone."
      actions={
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
          <RefreshCw /> Refresh
        </button>
      }
    >
      <MorningOwnerView data={data} error={error} />
    </SettingsSection>
  );
}

/** The section's body (rendered in tests with fixed data). */
export function MorningOwnerView({ data, error }: { data: MorningOwner | null; error: string | null }) {
  if (error) return <Callout tone="bad" className="my-3">{error}</Callout>;
  if (!data)
    return (
      <p className="flex items-center gap-2 py-4 text-small text-muted" role="status">
        <Spinner size={14} /> Reading…
      </p>
    );
  const last = data.last;
  const alerts = morningAlerts(data.alert);
  return (
    <div className="flex flex-col gap-4 pb-4 pt-2">
      {alerts.map((a) => (
        <Callout key={a.kind} tone="warn">
          {morningAlertText(a.kind, a.n)} <span className="text-muted">({fmtRelative(Date.parse(a.at))})</span>
        </Callout>
      ))}
      {last?.notSetUp ? (
        <Callout tone="warn">Run supabase/migrations/20261116000000_morning_action.sql in Supabase to turn on the morning action.</Callout>
      ) : last ? (
        <StatStrip
          items={[
            { label: 'Last run', value: last.claimed ?? 0, sub: last.at ? `Businesses · ${fmtRelative(Date.parse(last.at))}` : 'Businesses' },
            { label: 'Picked by AI', value: last.ai ?? 0, sub: `${last.rules ?? 0} from built-in rules` },
            { label: 'Didn’t come through', value: last.failed ?? 0, sub: `${(last.skipped ?? 0) + (last.late ?? 0)} skipped · ${last.exists ?? 0} already made` },
          ]}
        />
      ) : (
        <p className="text-small text-muted">The hourly job hasn’t run yet.</p>
      )}
      <p className="text-small text-ink-2">
        {data.powered ? 'An AI key powers Morning action.' : 'No AI key powers Morning action: actions are built from each business’s plan. Tick Morning action on a low-cost key in Settings › AI keys.'} Up to {data.perTick} businesses per hourly run, {data.concurrency} at a time.
      </p>
    </div>
  );
}
