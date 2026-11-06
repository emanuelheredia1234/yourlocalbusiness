// Manage one launched campaign (spec §13.3): its numbers as last read, its review per ad, its activity, and the
// actions. Each action opens ChangeConfirm (preview → confirm → one write). While a change is sending or not
// confirmed, every action is off with the reason; Google's end date can't be changed after launch.
import { ExternalLink } from 'lucide-react';
import type { LaunchedCampaign } from '@/lib/ads/launchTypes';
import { PLATFORM_LABEL } from '@/lib/ads/launchTypes';
import { dayLabel, money } from '@/lib/ads/launchFormat';
import { fmtRelative } from '@/lib/utils';
import { useAdsLaunch } from '@/store/adsLaunch';
import { Badge, Drawer, StatusDot } from '@/components/ui/primitives';
import { manageActions, managerLink, managerName, stateBadge } from './campaignView';
import { CampaignNotes } from './CampaignRow';
import { ReviewStatus } from './ReviewStatus';
import { AuditLog } from './AuditLog';

export function ManageDrawerHost() {
  const id = useAdsLaunch((s) => s.manageId);
  const c = useAdsLaunch((s) => (id ? Object.values(s.campaigns).flat().find((x) => x.id === id) : undefined));
  if (__ARTIFACT_BUILD__ || !c) return null;
  return <ManageDrawer c={c} onClose={() => useAdsLaunch.getState().openManage(null)} />;
}

export function ManageActions({ c }: { c: LaunchedCampaign }) {
  const open = useAdsLaunch((s) => s.openChange);
  return (
    <ul className="flex flex-col gap-2" aria-label="Actions">
      {manageActions(c).map((a) => (
        <li key={a.action} className="flex flex-col gap-0.5">
          <button type="button" className={a.danger ? 'btn btn-danger-ghost btn-sm justify-start' : 'btn btn-secondary btn-sm justify-start'} disabled={!a.enabled} aria-describedby={a.reason ? `why-${c.id}-${a.action}` : undefined} onClick={() => open({ campaignId: c.id, action: a.action })}>
            {a.label}
          </button>
          {a.reason && (
            <span id={`why-${c.id}-${a.action}`} className="text-caption text-muted">
              {a.reason}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ManageDrawer({ c, onClose }: { c: LaunchedCampaign; onClose: () => void }) {
  const b = stateBadge(c);
  const cur = c.account.currency;
  const link = managerLink(c);
  return (
    <Drawer open onClose={onClose} title={c.name} width={480}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{PLATFORM_LABEL[c.platform]}</Badge>
            <StatusDot tone={b.tone}>{b.label}</StatusDot>
            {c.learning === 'LEARNING' && <Badge tone="primary">Learning</Badge>}
            {c.learning === 'FAIL' && <Badge tone="warn">Learning limited</Badge>}
          </div>
          <p className="text-small text-ink-2">{c.stateMessage}</p>
          <CampaignNotes c={c} />
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-small">
          <dt className="text-muted">Ad account</dt>
          <dd className="text-ink">
            {c.account.name} …{c.account.idTail}
          </dd>
          <dt className="text-muted">Daily budget</dt>
          <dd className="num text-ink">{money(c.daily, cur)}</dd>
          <dt className="text-muted">Dates</dt>
          <dd className="text-ink">
            {dayLabel(c.start)}
            {c.end ? ` → ${dayLabel(c.end)}` : ''}
          </dd>
          <dt className="text-muted">Spent so far</dt>
          <dd className="num text-ink">{c.spendToDate != null ? money(c.spendToDate, cur) : '—'}</dd>
          {c.platform === 'meta' && (
            <>
              <dt className="text-muted">Spending limit</dt>
              <dd className="num text-ink">{c.spendCap != null ? money(c.spendCap, cur) : 'Not set'}</dd>
            </>
          )}
          <dt className="text-muted">Launched as</dt>
          <dd className="text-ink">{c.launchedAs === 'PAUSED' ? 'Paused' : 'Active'}</dd>
          <dt className="text-muted">As of</dt>
          <dd className="text-ink">{c.lastReadAt ? fmtRelative(c.lastReadAt) : 'Not read yet: press Refresh'}</dd>
        </dl>
        {c.learning === 'LEARNING' && <p className="text-small text-muted">Meta is still learning who to show this to. Costs move around for the first days.</p>}
        {c.learning === 'FAIL' && <p className="text-small text-muted">Learning limited: Meta isn’t getting enough results. A bigger area, a bigger budget or fewer ads can help.</p>}
        <ManageActions c={c} />
        {link && (
          <a href={link} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm self-start">
            Open in {managerName(c)} <ExternalLink />
          </a>
        )}
        <ReviewStatus c={c} />
        <AuditLog projectId={c.projectId} campaignId={c.id} title="Activity" />
      </div>
    </Drawer>
  );
}
