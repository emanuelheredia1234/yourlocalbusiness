// "Public on the web" (P7) for one published listing: the toggle, the plan's counter, the page's status (with what
// keeps it off Google) and a link to it. Studio › Listing & publish shows it under the publish actions; My listings
// offers the same action in each card's menu. Never in the claude.ai build, and only when the server has it on.

import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { Listing, Project } from '@/lib/types';
import { Callout, StatusDot, Toggle, confirmAction } from '@/components/ui/primitives';
import { GOOGLE_NOTE, isOnWeb, limitText, missingText, statusLine, useMarketConfig, type PublicListingState } from '@/lib/marketPublic';
import { useMarketOn } from '@/lib/marketConfig';
import { atLimit, counterLine, planName, putListingOnWeb, takeListingOffWeb, useMarketPublic } from '@/store/marketPublic';
import { toast } from '@/store/ui';

/** Where a thin listing's checklist is (the toast says it wherever the toggle was used). */
export const WHAT_TO_ADD = 'See what to add in Studio › Listing & publish, under “Public on the web”.';

/** What the confirm says before a listing comes off the web. */
export const UNLIST_CONFIRM = { title: 'Take this listing off the web?', body: 'Its address stops working and Google drops it.', confirmLabel: 'Take it off' };

export interface PublicWebViewProps {
  state: PublicListingState | undefined;
  limit: number | null;
  used: number;
  plan: string;
  /** the address the pages live under, for the help text (yourlocalbusiness.replit.app/market) */
  marketHost: string;
  busy: boolean;
  error?: string | null;
  /** the server's state was read (until then the toggle waits: it can't say whether the listing is on) */
  loaded?: boolean;
  /** why the state couldn't be read, with a Retry */
  loadError?: string | null;
  onRetry?: () => void;
  onToggle: (on: boolean) => void;
}

/** The toggle and its status, drawn from props (the render tests use this). */
export function PublicWebView({ state, limit, used, plan, marketHost, busy, error, loaded = true, loadError = null, onRetry, onToggle }: PublicWebViewProps) {
  const on = isOnWeb(state);
  const hidden = state?.status === 'hidden';
  const full = limit !== null && !on && used >= limit;
  const line = statusLine(state);
  const counter = counterLine({ limit, used }, plan);
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-5" aria-label="Public on the web">
      <Toggle
        checked={on}
        disabled={busy || !loaded || hidden || (full && !on)}
        onChange={onToggle}
        label="Public on the web"
        description={`Anyone can open this listing at ${marketHost}, and Google can list it once it’s complete. Turn it off anytime.`}
      />
      {!loaded && loadError && (
        <Callout
          tone="bad"
          action={
            onRetry && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
                Retry
              </button>
            )
          }
        >
          Couldn’t check whether this listing is on the web. {loadError}
        </Callout>
      )}
      {loaded && counter && <p className="num text-caption text-muted">{counter}</p>}
      {full && (
        <p className="text-caption text-ink-2">
          {limitText(limit ?? 0)}{' '}
          <a className="link" href="#plans">
            See plans
          </a>
        </p>
      )}
      {line && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusDot tone={line.tone}>{line.text}</StatusDot>
          {state && on && (
            <a className="link inline-flex items-center gap-1 text-small" href={state.url} target="_blank" rel="noopener">
              View <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
        </div>
      )}
      {state?.status === 'thin' && state.missing.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-small text-ink-2" aria-label="What keeps it off Google">
          {state.missing.map((m) => (
            <li key={m}>{missingText(m)}</li>
          ))}
        </ul>
      )}
      {state && on && state.reportCount > 0 && state.status !== 'held' && (
        <p className="text-caption text-muted">
          {state.reportCount} visitor report{state.reportCount === 1 ? '' : 's'} waiting for review.
        </p>
      )}
      {on && <p className="text-caption text-muted">{GOOGLE_NOTE}</p>}
      {error && <Callout tone="bad">{error}</Callout>}
    </section>
  );
}

/** Turn a listing's web page on or off, with the confirm and toasts the Studio and My listings share. */
export async function toggleWeb(p: Project, listing: Listing, on: boolean): Promise<PublicListingState | null> {
  if (!on) {
    if (!(await confirmAction({ ...UNLIST_CONFIRM, danger: true }))) return null;
    await takeListingOffWeb(listing.id);
    toast({ kind: 'info', title: 'Taken off the web' });
    return useMarketPublic.getState().byListing[listing.id] ?? null;
  }
  const s = await putListingOnWeb(p, listing);
  toast({ kind: 'success', title: s.status === 'live' ? 'On the web' : 'On the web, not on Google yet', body: s.status === 'live' ? GOOGLE_NOTE : WHAT_TO_ADD });
  return s;
}

/** The toggle for a project's published listing, with the server's state. Nothing where the feature is off. */
export function PublicWebToggle({ project, listing }: { project: Project; listing: Listing }) {
  const enabled = useMarketOn();
  const state = useMarketPublic((s) => s.byListing[listing.id]);
  const limit = useMarketPublic((s) => s.limit);
  const used = useMarketPublic((s) => s.used);
  const busy = useMarketPublic((s) => !!s.busy[listing.id]);
  const loaded = useMarketPublic((s) => s.loaded);
  const loadError = useMarketPublic((s) => s.error);
  const publicUrl = useMarketConfig((s) => s.config?.publicUrl);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (enabled && !loaded) void useMarketPublic.getState().load();
  }, [enabled, loaded]);
  if (__ARTIFACT_BUILD__ || !enabled) return null;
  const run = async (on: boolean) => {
    setError(null);
    if (on && atLimit(listing.id)) return setError(limitText(limit ?? 0));
    try {
      await toggleWeb(project, listing, on);
    } catch (e) {
      setError((e as Error).message || 'Please try again.');
    }
  };
  return <PublicWebView state={state} limit={limit} used={used} plan={planName()} marketHost={(publicUrl ?? '').replace(/^https?:\/\//, '') || 'this app’s /market'} busy={busy} error={error} loaded={loaded} loadError={loadError} onRetry={() => void useMarketPublic.getState().load()} onToggle={(v) => void run(v)} />;
}
