// The Marketing hub's "Update": one press fetches every source's numbers for the active business, in the
// background on the server. The button is the only filled one in the hub's header; under the header a row
// shows each source (Social, Ads, SEO, Email) until it's dismissed. One request per press, never retried.
import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { AnalyticsSource, RefreshRun } from '@/lib/integrations/types';
import { ANALYTICS_SOURCES } from '@/lib/integrations/types';
import { IntegrationApiError, getMyUsage } from '@/lib/integrations/api';
import { navigate } from '@/lib/router';
import { snapshotOf, sourceLabel, useAnalytics } from '@/store/analytics';
import { toast } from '@/store/ui';
import { Callout, Spinner, StatusDot, Tooltip } from '@/components/ui/primitives';
import { openConnectedAccounts } from './links';

const REFRESH_EVERY_MS = 15 * 60_000;

/** "Updated 4 min ago. You can update again at 3:15 PM" from the server's nextAt. */
export function tooSoonText(nextAt: string | undefined, now = Date.now()): string {
  const next = nextAt ? Date.parse(nextAt) : NaN;
  if (!Number.isFinite(next)) return 'Updated a moment ago. Try again in a few minutes.';
  const ago = Math.max(0, Math.round((now - (next - REFRESH_EVERY_MS)) / 60_000));
  const at = new Date(next).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `Updated ${ago} min ago. You can update again at ${at}`;
}

export function UpdateButton({ projectId }: { projectId: string | null }) {
  const phase = useAnalytics((s) => s.runPhase);
  const loading = useAnalytics((s) => s.loading);
  const busy = phase === 'running' || loading;
  const press = async () => {
    if (!projectId || busy) return;
    const r = await useAnalytics.getState().startUpdate(projectId);
    if (r.ok) return;
    if (r.code === 'REFRESH_TOO_SOON') toast({ title: tooSoonText(r.nextAt), kind: 'info' });
    else if (r.code !== 'CUSTOMER_CAP' && r.code !== 'CUSTOMER_BLOCKED' && r.code !== 'NOTHING_TO_UPDATE' && r.code !== 'IN_PROGRESS') toast({ title: 'Couldn’t update', body: r.message, kind: 'error' });
  };
  const button = (
    <button type="button" className="btn btn-primary btn-sm" disabled={!projectId || busy} onClick={() => void press()}>
      {busy ? <Spinner size={14} /> : <RefreshCw />}
      {busy ? 'Updating…' : 'Update'}
    </button>
  );
  return projectId ? button : <Tooltip content="Pick a business first">{button}</Tooltip>;
}

const DOT: Record<string, { tone: 'good' | 'warn' | 'bad' | 'primary' | 'faint'; text: string }> = {
  queued: { tone: 'faint', text: 'Waiting' },
  running: { tone: 'primary', text: 'Updating' },
  ok: { tone: 'good', text: 'Done' },
  partial: { tone: 'warn', text: 'Done, some data missing' },
  error: { tone: 'bad', text: 'Problem' },
  skipped: { tone: 'faint', text: 'Skipped' },
  not_connected: { tone: 'faint', text: 'Not connected' },
  pending: { tone: 'faint', text: 'Still loading' },
};

const REASON: Record<string, string> = {
  CUSTOMER_CAP: 'over today’s limit',
  CUSTOMER_BLOCKED: 'paused for your account',
  RATE_LIMITED: 'busy, try later',
  INTERRUPTED: 'interrupted',
  NEEDS_RECONNECT: 'reconnect needed',
  NOT_CONNECTED: 'not connected',
};

/** The per-source line, with a reason from the source's snapshot when it didn't go well. */
export function sourceLine(source: AnalyticsSource, state: RefreshRun['sources'][AnalyticsSource] | undefined, errorCode?: string): { tone: 'good' | 'warn' | 'bad' | 'primary' | 'faint'; text: string } {
  const d = DOT[state ?? 'queued'] ?? DOT.queued;
  const reason = state === 'not_connected' ? 'not connected' : errorCode ? REASON[errorCode] : undefined;
  return { tone: d.tone, text: `${sourceLabel(source)}: ${reason ?? d.text.toLowerCase()}` };
}

/** Under the hub's header: the running (or last) Update per source, and refusals (limit, nothing to update). */
export function UpdateProgress({ projectId }: { projectId: string | null }) {
  const run = useAnalytics((s) => s.run);
  const phase = useAnalytics((s) => s.runPhase);
  const notice = useAnalytics((s) => s.notice);
  const snaps = useAnalytics((s) => (projectId ? s.snapshots[projectId] : undefined));
  return (
    <div className="mb-6 flex flex-col gap-3 empty:hidden">
      {notice?.kind === 'cap' && (
        <Callout tone="warn" onDismiss={() => useAnalytics.getState().dismissNotice()}>
          You’ve reached {notice.period === 'month' ? 'this month’s' : 'today’s'} analytics limit. It resets {notice.period === 'month' ? 'on the 1st' : 'at midnight UTC'}.
        </Callout>
      )}
      {notice?.kind === 'blocked' && (
        <Callout tone="bad" onDismiss={() => useAnalytics.getState().dismissNotice()}>
          Analytics are paused for your account. Contact support.
        </Callout>
      )}
      {notice?.kind === 'nothing' && (
        <Callout
          tone="info"
          onDismiss={() => useAnalytics.getState().dismissNotice()}
          action={
            <button type="button" className="btn btn-secondary btn-xs" onClick={openConnectedAccounts}>
              Open Connected accounts
            </button>
          }
        >
          Add your social handles, keywords or connect an account to see analytics.
        </Callout>
      )}
      {run && run.projectId === projectId && (
        <div role="status" aria-label="Update progress" className="card flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
          {ANALYTICS_SOURCES.map((s) => {
            const line = sourceLine(s, run.sources[s], snapshotOf(snaps, s)?.errorCode);
            return (
              <StatusDot key={s} tone={line.tone} pulse={run.sources[s] === 'running'}>
                {line.text}
              </StatusDot>
            );
          })}
          <span className="ml-auto flex items-center gap-2 text-small text-muted">
            {phase === 'background' && 'Still updating in the background'}
            {phase === 'idle' && (
              <button type="button" className="btn btn-ghost btn-icon btn-xs" aria-label="Dismiss" onClick={() => useAnalytics.getState().dismissRun()}>
                <X />
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

/** The owner only: the analytics provider needs attention (billing). No amounts are shown. */
export function OwnerAlert() {
  const owner = useAnalytics((s) => s.owner);
  const [alert, setAlert] = useState(false);
  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    void useAnalytics.getState().loadOwner();
  }, []);
  useEffect(() => {
    if (!owner) return;
    let live = true;
    getMyUsage(1)
      .then((r) => live && setAlert(!!(r as { alert?: unknown }).alert))
      .catch((e: unknown) => live && e instanceof IntegrationApiError && setAlert(false));
    return () => {
      live = false;
    };
  }, [owner]);
  if (!owner || !alert) return null;
  return (
    <Callout
      tone="warn"
      className="mb-6"
      action={
        <button type="button" className="btn btn-secondary btn-xs" onClick={() => void navigate('admin-billing')}>
          Open Billing
        </button>
      }
    >
      Analytics provider needs attention (billing).
    </Callout>
  );
}
