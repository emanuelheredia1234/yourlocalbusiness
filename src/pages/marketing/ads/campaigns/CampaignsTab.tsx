// The Campaigns tab (spec §13.2): what was launched for this business, from our database, refreshed from Meta and
// Google when opened (at most every 5 minutes) and on Refresh. There is no polling beyond following a job that is
// still sending. Spend is billed by Meta and Google to the customer's own payment method.
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Project } from '@/lib/types';
import type { AccountsResponse, AdsPlatform, LaunchedCampaign } from '@/lib/ads/launchTypes';
import { PLATFORM_LABEL } from '@/lib/ads/launchTypes';
import { getAdAccounts } from '@/lib/ads/launchApi';
import { money } from '@/lib/ads/launchFormat';
import { fmtRelative } from '@/lib/utils';
import { mayBeOn, useAdsLaunch } from '@/store/adsLaunch';
import { toast } from '@/store/ui';
import { Callout, Empty, Spinner, StatStrip, StatusDot } from '@/components/ui/primitives';
import { CampaignCard, CampaignRow } from './CampaignRow';
import { AuditLog } from './AuditLog';
import { SetupChecklist, checklistSummary } from './SetupChecklist';

const EMPTY: LaunchedCampaign[] = [];

function SetupSummary({ projectId }: { projectId: string }) {
  const [data, setData] = useState<Partial<Record<AdsPlatform, AccountsResponse | null>>>({});
  const [open, setOpen] = useState<AdsPlatform | null>(null);
  useEffect(() => {
    let alive = true;
    for (const p of ['meta', 'google'] as AdsPlatform[])
      getAdAccounts(projectId, p)
        .then((r) => alive && setData((d) => ({ ...d, [p]: r })))
        .catch(() => alive && setData((d) => ({ ...d, [p]: null })));
    return () => {
      alive = false;
    };
  }, [projectId]);
  const rows = (['meta', 'google'] as AdsPlatform[]).filter((p) => data[p]);
  if (!rows.length) return null;
  return (
    <div className="card flex flex-col gap-3 p-4" aria-label="Setup">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {rows.map((p) => {
          const s = checklistSummary(data[p]!.setup);
          return (
            <button key={p} type="button" className="inline-flex items-center gap-2 text-small" aria-expanded={open === p} onClick={() => setOpen(open === p ? null : p)}>
              <span className="text-ink">{PLATFORM_LABEL[p]}</span>
              <StatusDot tone={s.tone}>{s.text}</StatusDot>
            </button>
          );
        })}
      </div>
      {open && data[open] && <SetupChecklist checks={data[open]!.setup} />}
    </div>
  );
}

export function CampaignsTab({ project, onLaunchAgain }: { project: Project; onLaunchAgain: (c: LaunchedCampaign) => void }) {
  const campaigns = useAdsLaunch((s) => s.campaigns[project.id] ?? EMPTY);
  const limits = useAdsLaunch((s) => s.limits[project.id]);
  const notes = useAdsLaunch((s) => s.notes[project.id]);
  const loading = useAdsLaunch((s) => !!s.loading[project.id]);
  const error = useAdsLaunch((s) => s.error[project.id]);
  const refreshedAt = useAdsLaunch((s) => s.refreshedAt[project.id]);
  const openManage = useAdsLaunch((s) => s.openManage);
  const [, tick] = useState(0);
  useEffect(() => {
    const s = useAdsLaunch.getState();
    void s.load(project.id).then(() => {
      if ((useAdsLaunch.getState().campaigns[project.id] ?? []).some((c) => c.platformCampaignId)) void s.refresh(project.id, { auto: true });
    });
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [project.id]);

  const refresh = async () => {
    const r = await useAdsLaunch.getState().refresh(project.id);
    if (!r.ok && r.message) toast({ kind: 'info', title: 'Not refreshed', body: r.message });
  };
  const live = campaigns.filter(mayBeOn);
  const livePlatforms = [...new Set(live.map((c) => PLATFORM_LABEL[c.platform]))];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-small text-muted">{refreshedAt ? `Updated ${fmtRelative(refreshedAt)}` : 'Results are read from Meta and Google when you refresh.'}</p>
        <button type="button" className="btn btn-secondary btn-sm" disabled={loading} onClick={() => void refresh()}>
          {loading ? <Spinner size={14} /> : <RefreshCw />} Refresh
        </button>
      </div>
      {limits && (
        <StatStrip
          items={[
            { label: 'Daily limit', value: money(limits.maxDaily, limits.currency), sub: 'across live campaigns' },
            { label: 'Committed', value: money(limits.committedDaily, limits.currency), sub: 'a day, switched on' },
            { label: 'Live campaigns', value: String(limits.liveCampaigns) },
          ]}
        />
      )}
      {livePlatforms.length > 0 && <p className="text-small text-muted">Ad spend is billed by {livePlatforms.join(' and ')} to your own payment method. The app never charges you for it.</p>}
      {error && <Callout tone="bad">{error}</Callout>}
      {notes?.map((n, i) => (
        <Callout key={`${n.code}-${i}`} tone="info">
          {n.message}
        </Callout>
      ))}
      <SetupSummary projectId={project.id} />
      {campaigns.length === 0 ? (
        loading ? (
          <Spinner />
        ) : (
          <Empty title="Nothing launched yet" body="Open a plan and press Launch…" />
        )
      ) : (
        <>
          <section className="card hidden overflow-x-auto sm:block" aria-label="Launched campaigns">
            <table className="w-full min-w-[920px] text-left text-small">
              <thead className="border-b border-line text-caption text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Platform</th>
                  <th className="px-2 py-2 font-medium">Campaign</th>
                  <th className="px-2 py-2 font-medium">State</th>
                  <th className="px-2 py-2 text-right font-medium">Daily</th>
                  <th className="px-2 py-2 font-medium">Dates</th>
                  <th className="px-2 py-2 text-right font-medium">Spent so far</th>
                  <th className="px-2 py-2 font-medium">Results</th>
                  <th className="px-2 py-2" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <CampaignRow key={c.id} c={c} onManage={() => openManage(c.id)} onLaunchAgain={() => onLaunchAgain(c)} />
                ))}
              </tbody>
            </table>
          </section>
          <ul className="flex flex-col gap-3 sm:hidden" aria-label="Launched campaigns">
            {campaigns.map((c) => (
              <CampaignCard key={c.id} c={c} onManage={() => openManage(c.id)} onLaunchAgain={() => onLaunchAgain(c)} />
            ))}
          </ul>
        </>
      )}
      <div className="card p-5">
        <AuditLog projectId={project.id} />
      </div>
    </div>
  );
}
