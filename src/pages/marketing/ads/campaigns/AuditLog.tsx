// Ad activity (spec §10.4): every launch and change sent, its outcome, each Check status, refusals, review changes
// and the owner's limit changes, newest first, 50 at a time, from our own templates (a refusal we have no sentence
// for quotes the platform's own words, labelled, as plain text). A refused write links the platform's own page that
// fixes it, when there is one. A CSV of the customer's own rows can be downloaded. There is no edit or delete: rows
// go only with the account.
import { useEffect, useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import type { AuditEntry } from '@/lib/ads/launchTypes';
import { getAdAudit } from '@/lib/ads/launchApi';
import { useAdsLaunch } from '@/store/adsLaunch';
import { safeFixUrl } from '@/lib/ads/launchFormat';
import { fmtDateTime } from '@/lib/utils';
import { download } from '@/components/ui/download';
import { Empty, Spinner, StatusDot } from '@/components/ui/primitives';
import type { Tone } from './campaignView';

const OUTCOME: Record<AuditEntry['outcome'], { word: string; tone: Tone }> = {
  sending: { word: 'Sending', tone: 'primary' },
  done: { word: 'Done', tone: 'good' },
  failed: { word: 'Failed', tone: 'bad' },
  unknown: { word: 'Not confirmed', tone: 'warn' },
  refused: { word: 'Not sent', tone: 'faint' },
  info: { word: 'Note', tone: 'faint' },
};
const ACTOR: Record<AuditEntry['actor'], string> = { customer: 'You', owner: 'App owner', platform: 'Meta/Google' };

const csvCell = (v: string) => `"${v.replace(/"/g, '""')}"`;
export function auditCsv(entries: AuditEntry[]): string {
  const head = ['When', 'Who', 'What', 'Outcome', 'Details'];
  return [head.join(','), ...entries.map((e) => [e.at, ACTOR[e.actor] ?? e.actor, e.action, OUTCOME[e.outcome]?.word ?? e.outcome, e.summary].map((x) => csvCell(String(x))).join(','))].join('\n');
}

export function AuditList({ entries }: { entries: AuditEntry[] }) {
  return (
    <ol className="flex flex-col divide-y divide-line" aria-label="Ad activity">
      {entries.map((e) => {
        const fix = safeFixUrl(e.fixUrl);
        return (
          <li key={e.id} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-start sm:gap-3">
            <span className="num shrink-0 text-caption text-muted sm:w-36">{fmtDateTime(e.at)}</span>
            <span className="min-w-0 flex-1 break-words text-small text-ink">
              <span className="text-muted">{ACTOR[e.actor] ?? e.actor}: </span>
              {e.summary}
              {fix && (
                <a href={fix} target="_blank" rel="noopener noreferrer" className="link ml-1 inline-flex items-center gap-0.5">
                  Fix it <ExternalLink size={12} aria-hidden="true" />
                </a>
              )}
            </span>
            <StatusDot tone={OUTCOME[e.outcome]?.tone ?? 'faint'}>{OUTCOME[e.outcome]?.word ?? e.outcome}</StatusDot>
          </li>
        );
      })}
    </ol>
  );
}

/** The full list for a business (Campaigns tab) or one campaign (Manage drawer). */
export function AuditLog({ projectId, campaignId, title = 'Ad activity' }: { projectId?: string; campaignId?: string; title?: string }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [next, setNext] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // a write made here (removing a failed launch) bumps this: the list reads again without a reload
  const rev = useAdsLaunch((s) => (projectId ? (s.auditRev[projectId] ?? 0) : 0));
  const load = async (before?: number) => {
    setBusy(true);
    try {
      const r = await getAdAudit({ projectId, campaignId, before });
      setEntries((e) => (before ? [...(e ?? []), ...r.entries] : r.entries));
      setNext(r.next);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The activity couldn’t be read.');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!__ARTIFACT_BUILD__) void load();
  }, [projectId, campaignId, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-h4 text-ink">{title}</h3>
        {entries && entries.length > 0 && (
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => void download(`ad-activity${campaignId ? `-${campaignId.slice(0, 8)}` : ''}.csv`, auditCsv(entries))}>
            <Download /> CSV
          </button>
        )}
      </div>
      {err && <p className="text-small text-bad">{err}</p>}
      {!entries ? busy ? <Spinner size={14} /> : null : entries.length === 0 ? <Empty title="No ad activity yet" body="Launches, changes and checks show here." /> : <AuditList entries={entries} />}
      {next && (
        <button type="button" className="btn btn-ghost btn-xs self-start" disabled={busy} onClick={() => void load(next)}>
          Show older
        </button>
      )}
    </section>
  );
}
