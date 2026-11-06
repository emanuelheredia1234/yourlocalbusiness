// One launched campaign: state in plain words (spec §9.3), money in the account's own currency, results as of
// their read time, and what can be done now. An unknown outcome offers Check status only (never "Try again");
// platform text (review reasons) is rendered as plain text, never a link.
import { useState } from 'react';
import { ExternalLink, RefreshCw, Settings2 } from 'lucide-react';
import type { LaunchedCampaign } from '@/lib/ads/launchTypes';
import { PLATFORM_LABEL } from '@/lib/ads/launchTypes';
import { money, shortDay } from '@/lib/ads/launchFormat';
import { fmtNum, fmtRelative } from '@/lib/utils';
import { useAdsLaunch } from '@/store/adsLaunch';
import { toast } from '@/store/ui';
import { Badge, Callout, Spinner, StatusDot } from '@/components/ui/primitives';
import { canLaunchAgain, managerLink, managerName, sendingJob, stateBadge, unknownJob } from './campaignView';

export function CheckStatusButton({ jobId, canCheckAt, size = 'xs' }: { jobId: string; canCheckAt?: string; size?: 'xs' | 'sm' }) {
  const [busy, setBusy] = useState(false);
  const wait = canCheckAt ? Date.parse(canCheckAt) - Date.now() : 0;
  const check = async () => {
    if (busy) return;
    setBusy(true);
    const r = await useAdsLaunch.getState().check(jobId);
    setBusy(false);
    if (!r.ok) toast({ kind: 'error', title: 'Couldn’t check', body: r.message });
    else if (r.message) toast({ kind: 'info', title: 'Not confirmed yet', body: r.message });
  };
  return (
    <button type="button" className={`btn btn-secondary btn-${size}`} disabled={busy || wait > 0} title={wait > 0 ? 'You can check again in a few seconds.' : undefined} onClick={() => void check()}>
      {busy ? <Spinner size={12} /> : <RefreshCw />} Check status
    </button>
  );
}

/** The row's notes under the name: a sending or unknown job, a failed launch, a rejected ad, ads switched off. */
export function CampaignNotes({ c, onLaunchAgain }: { c: LaunchedCampaign; onLaunchAgain?: () => void }) {
  const sending = sendingJob(c);
  const unknown = unknownJob(c);
  const note = useAdsLaunch((s) => (unknown ? s.checkNotes[unknown.id] : undefined));
  const link = managerLink(c);
  if (sending)
    return (
      <p className="mt-1 flex items-center gap-1.5 text-caption text-muted">
        <Spinner size={12} /> {sending.kind === 'launch' ? 'Launching…' : 'Sending the change…'}
      </p>
    );
  if (unknown)
    return (
      <Callout
        tone="warn"
        className="mt-2"
        action={
          <>
            <CheckStatusButton jobId={unknown.id} canCheckAt={unknown.canCheckAt} />
            {link && (
              <a href={link} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-xs">
                Open {managerName(c)} <ExternalLink />
              </a>
            )}
          </>
        }
      >
        {unknown.message}
        {note && <span className="mt-1 block">{note}</span>}
      </Callout>
    );
  return (
    <>
      {c.state === 'failed' && (
        <p className="mt-1 text-caption text-bad">
          {c.lastJob?.message ?? 'Not launched.'}
          {c.lastJob?.leftBehind?.length ? ` Left behind: ${c.lastJob.leftBehind.join(', ')}.` : ''}
          {canLaunchAgain(c) && onLaunchAgain && (
            <button type="button" className="link ml-1" onClick={onLaunchAgain}>
              Launch again
            </button>
          )}
        </p>
      )}
      {c.state === 'rejected' && c.review.reasons.length > 0 && (
        <div className="mt-1 text-caption text-ink-2">
          <span className="text-muted">{PLATFORM_LABEL[c.platform]}’s reason:</span>
          <ul className="list-disc pl-4">
            {c.review.reasons.map((r, i) => (
              <li key={i} className="whitespace-pre-line break-words">
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}
      {c.lastJob?.state === 'done' && c.lastJob.code && <p className="mt-1 text-caption text-warn">{c.lastJob.message}</p>}
      {c.lastJob?.state === 'failed' && c.state !== 'failed' && <p className="mt-1 text-caption text-bad">{c.lastJob.message}</p>}
      {(c.adsOff ?? 0) > 0 && <p className="mt-1 text-caption text-warn">{c.adsOff === 1 ? 'One ad is' : `${c.adsOff} ads are`} switched off: {PLATFORM_LABEL[c.platform]} didn’t accept switching {c.adsOff === 1 ? 'it' : 'them'} on. Resume switches {c.adsOff === 1 ? 'it' : 'them'} on.</p>}
      {c.review.accountMessage && <p className="mt-1 text-caption text-bad">{c.review.accountMessage}</p>}
      {c.planDeleted && <p className="mt-1 text-caption text-muted">Plan deleted</p>}
    </>
  );
}

function Results({ c }: { c: LaunchedCampaign }) {
  if (!c.results) return <span className="text-muted">Results load after Refresh</span>;
  return (
    <span className="num">
      {fmtNum(c.results.impressions)} views · {fmtNum(c.results.clicks)} clicks · {c.results.ctr.toFixed(2)}% CTR
    </span>
  );
}

export function CampaignRow({ c, onManage, onLaunchAgain }: { c: LaunchedCampaign; onManage: () => void; onLaunchAgain: () => void }) {
  const b = stateBadge(c);
  const link = managerLink(c);
  return (
    <tr className="border-b border-line align-top last:border-0">
      <td className="px-4 py-3">
        <Badge>{PLATFORM_LABEL[c.platform]}</Badge>
      </td>
      <td className="max-w-80 px-2 py-3">
        <p className="text-ui text-ink">{c.name}</p>
        <p className="text-caption text-muted">
          {c.account.name} …{c.account.idTail}
          {c.tag ? ` · ${c.tag}` : ''}
        </p>
        <p className="mt-0.5 text-caption text-ink-2">{c.stateMessage}</p>
        <CampaignNotes c={c} onLaunchAgain={onLaunchAgain} />
      </td>
      <td className="px-2 py-3">
        <StatusDot tone={b.tone} pulse={b.tone === 'primary'}>
          {b.label}
        </StatusDot>
      </td>
      <td className="num px-2 py-3 text-right">{money(c.daily, c.account.currency)}</td>
      <td className="whitespace-nowrap px-2 py-3">
        {shortDay(c.start)}
        {c.end ? ` – ${shortDay(c.end)}` : ''}
      </td>
      <td className="num px-2 py-3 text-right">{c.spendToDate != null ? money(c.spendToDate, c.account.currency) : '—'}</td>
      <td className="px-2 py-3 text-caption">
        <Results c={c} />
        {c.resultsAsOf && <span className="block text-muted">as of {fmtRelative(c.resultsAsOf)}</span>}
      </td>
      <td className="whitespace-nowrap px-2 py-3 text-right">
        <button type="button" className="btn btn-secondary btn-xs" onClick={onManage}>
          <Settings2 /> Manage
        </button>
        {link && (
          <a href={link} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-xs ml-1" aria-label={`Open in ${managerName(c)}`} title={`Open in ${managerName(c)}`}>
            <ExternalLink />
          </a>
        )}
      </td>
    </tr>
  );
}

/** The same campaign as a card, below the sm breakpoint. */
export function CampaignCard({ c, onManage, onLaunchAgain }: { c: LaunchedCampaign; onManage: () => void; onLaunchAgain: () => void }) {
  const b = stateBadge(c);
  const link = managerLink(c);
  return (
    <li className="card flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <Badge>{PLATFORM_LABEL[c.platform]}</Badge>
        <StatusDot tone={b.tone} pulse={b.tone === 'primary'}>
          {b.label}
        </StatusDot>
      </div>
      <div>
        <p className="text-ui text-ink">{c.name}</p>
        <p className="text-caption text-muted">
          {c.account.name} …{c.account.idTail}
        </p>
        <p className="mt-0.5 text-caption text-ink-2">{c.stateMessage}</p>
        <CampaignNotes c={c} onLaunchAgain={onLaunchAgain} />
      </div>
      <p className="num text-small text-ink-2">
        {money(c.daily, c.account.currency)} a day · {shortDay(c.start)}
        {c.end ? ` – ${shortDay(c.end)}` : ''} · spent {c.spendToDate != null ? money(c.spendToDate, c.account.currency) : '—'}
      </p>
      <p className="text-caption">
        <Results c={c} />
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onManage}>
          <Settings2 /> Manage
        </button>
        {link && (
          <a href={link} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm">
            Open in {managerName(c)} <ExternalLink />
          </a>
        )}
      </div>
    </li>
  );
}
