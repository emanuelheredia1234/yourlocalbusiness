// Owner → Public marketplace (P7): visitors' open reports (hide the listing or dismiss the report), the listings held
// after reports and the ones hidden (unhide), and Search Console: the last sitemap submit, whether the market changed
// since, treg's owner alert, and "Send sitemap to Google" (at most once a day across the app). Sellers never see any
// of this. Not shown in the claude.ai build, or when the server has the market off.

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { fmtDateTime } from '@/lib/utils';
import { Callout, Field, Modal, Select, SettingsSection, Spinner, confirmAction } from '@/components/ui/primitives';
import { toast } from '@/store/ui';
import { dismissReport, fetchMarketAdmin, hideListing, reasonLabel, REPORT_REASONS, submitMarketSitemap, unhideListing, useMarketConfig, type MarketAdmin, type ReportReason, type SubmitOutcome } from '@/lib/marketPublic';
import { marketConfig } from '@/lib/marketConfig';

/** The last submit's outcome in words. */
export function outcomeText(outcome: string | null, at: string | null): string {
  if (!outcome || !at) return 'Not sent yet.';
  const when = fmtDateTime(at);
  switch (outcome) {
    case 'ok':
      return `Sent ${when}. Google accepted it.`;
    case 'failed':
      return `Tried ${when}. Google refused it: check the property in Search Console.`;
    case 'unknown':
      return `Sent ${when}, but the answer was lost. It isn’t sent again until Google’s list is read back.`;
    default:
      return `Last try ${when}.`;
  }
}

/** What the button's press came back with, in words. */
export function submitResultText(r: SubmitOutcome): string {
  if (r.outcome === 'skipped') return r.alreadySubmittedAt ? `Skipped: already sent at ${fmtDateTime(r.alreadySubmittedAt)} (once a day at most).` : 'Skipped: Google already has the latest sitemap.';
  if (r.outcome === 'ok') return 'Sent. Google picks it up on its own schedule.';
  if (r.outcome === 'failed') return 'Google refused the sitemap. Check the property in Search Console.';
  return 'The answer was lost. It isn’t sent again automatically.';
}

export interface MarketAdminActions {
  onHide: (id: string, title: string) => void;
  onDismiss: (id: string) => void;
  onUnhide: (id: string, title: string) => void;
  onSubmit: () => void;
}

/** The section's body (rendered in tests with fixed data). */
export function MarketAdminView({ data, error, origin, busy, last, actions }: { data: MarketAdmin | null; error: string | null; origin: string; busy: boolean; last: SubmitOutcome | null; actions: MarketAdminActions }) {
  if (error) return <Callout tone="bad" className="my-3">{error}</Callout>;
  if (!data)
    return (
      <p className="flex items-center gap-2 py-4 text-small text-muted" role="status">
        <Spinner size={14} /> Reading…
      </p>
    );
  const link = (slug: string, title: string) =>
    slug ? (
      <a className="link" href={`${origin}/market/${encodeURIComponent(slug)}`} target="_blank" rel="noopener">
        {title}
      </a>
    ) : (
      title
    );
  return (
    <div className="flex flex-col gap-6 pb-4 pt-2">
      <div>
        <h4 className="text-ui text-ink">Open reports</h4>
        {!data.reports.length ? (
          <p className="mt-1 text-small text-muted">No open reports.</p>
        ) : (
          <div className="mt-1 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-small">
              <thead className="text-caption text-muted">
                <tr>
                  <th className="py-2 pr-3 font-medium">Listing</th>
                  <th className="py-2 pr-3 font-medium">Seller</th>
                  <th className="py-2 pr-3 font-medium">Reason</th>
                  <th className="py-2 pr-3 font-medium">Note</th>
                  <th className="py-2 pr-3 font-medium">Date</th>
                  <th className="py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.reports.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 pr-3 text-ink">{r.listing ? link(r.listing.slug, r.listing.title) : 'Deleted listing'}</td>
                    <td className="py-2 pr-3 text-ink-2">{r.listing?.seller_name ?? ''}</td>
                    <td className="py-2 pr-3 text-ink-2">{reasonLabel(r.reason)}</td>
                    <td className="max-w-[260px] whitespace-pre-line break-words py-2 pr-3 text-ink-2">{r.note}</td>
                    <td className="num whitespace-nowrap py-2 pr-3 text-muted">{r.at ? fmtDateTime(r.at) : ''}</td>
                    <td className="py-2">
                      <span className="flex justify-end gap-1">
                        {r.listing && r.listing.status !== 'hidden' && (
                          <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => actions.onHide(r.listing!.id, r.listing!.title)}>
                            Hide
                          </button>
                        )}
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => actions.onDismiss(r.id)}>
                          Dismiss
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h4 className="text-ui text-ink">Held after reports</h4>
          {!data.held.length ? (
            <p className="mt-1 text-small text-muted">None. Held listings stay up without Google until you review them.</p>
          ) : (
            <ul className="mt-1 flex flex-col divide-y divide-line">
              {data.held.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-2 py-2 text-small">
                  <span className="min-w-0 truncate text-ink">
                    {link(h.slug, h.title)} <span className="text-muted">· {h.seller_name}</span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => actions.onHide(h.id, h.title)}>
                      Hide
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => actions.onUnhide(h.id, h.title)}>
                      Unhide
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 className="text-ui text-ink">Hidden</h4>
          {!data.hidden.length ? (
            <p className="mt-1 text-small text-muted">None.</p>
          ) : (
            <ul className="mt-1 flex flex-col divide-y divide-line">
              {data.hidden.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-2 py-2 text-small">
                  <span className="min-w-0 truncate text-ink">
                    {h.title} <span className="text-muted">· {h.seller_name} · {reasonLabel(h.hidden_reason)}</span>
                  </span>
                  <button type="button" className="btn btn-ghost btn-sm shrink-0" onClick={() => actions.onUnhide(h.id, h.title)}>
                    Unhide
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div>
        <h4 className="text-ui text-ink">Search Console</h4>
        <dl className="mt-1 grid grid-cols-1 gap-x-6 gap-y-1 text-small sm:grid-cols-2">
          <div>
            <dt className="text-muted">Last sitemap submit</dt>
            <dd className="text-ink">{outcomeText(data.submit.outcome, data.submit.lastAt)}</dd>
          </div>
          <div>
            <dt className="text-muted">Market changed since then</dt>
            <dd className="text-ink">{data.submit.changedSince ? 'Yes' : 'No'}</dd>
          </div>
        </dl>
        {!data.submit.property && (
          <Callout tone="warn" className="mt-3">
            GSC_APP_PROPERTY isn’t set, so sitemaps aren’t sent to Google. Listings still appear in /sitemap.xml.
          </Callout>
        )}
        {data.alert && (
          <Callout tone="bad" className="mt-3">
            {data.alert}
          </Callout>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !data.submit.property} onClick={actions.onSubmit}>
            {busy && <Spinner size={14} />} Send sitemap to Google
          </button>
          {last && <p className="text-small text-ink-2">{submitResultText(last)}</p>}
        </div>
        <p className="mt-2 text-caption text-muted">A daily job also sends it when the market changed. Google indexes on its own schedule.</p>
      </div>
    </div>
  );
}

/** Choose a reason before a listing is hidden. */
function HideDialog({ title, onDone }: { title: string; onDone: (r: { reason: ReportReason; note: string } | null) => void }) {
  const [reason, setReason] = useState<ReportReason | ''>('');
  const [note, setNote] = useState('');
  return (
    <Modal
      open
      onClose={() => onDone(null)}
      title="Hide from the web"
      subtitle={title}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={!reason} onClick={() => reason && onDone({ reason, note })}>
            Hide
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Reason (the seller sees it)" htmlFor="hide-reason">
          <Select id="hide-reason" value={reason} onChange={setReason} options={REPORT_REASONS} placeholder="Choose a reason" />
        </Field>
        <Field label="Note for your records (optional)" htmlFor="hide-note">
          <textarea id="hide-note" className="input min-h-[80px]" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export function MarketSection() {
  const enabled = useMarketConfig((s) => s.config?.enabled === true);
  const publicUrl = useMarketConfig((s) => s.config?.publicUrl ?? '');
  const [data, setData] = useState<MarketAdmin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<SubmitOutcome | null>(null);
  const [hiding, setHiding] = useState<{ id: string; title: string } | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await fetchMarketAdmin());
      setError(null);
    } catch (e) {
      setError((e as Error).message || 'Couldn’t load the public marketplace.');
    }
  }, []);
  useEffect(() => {
    if (__ARTIFACT_BUILD__) return;
    void marketConfig();
  }, []);
  useEffect(() => {
    if (!__ARTIFACT_BUILD__ && enabled) void load();
  }, [enabled, load]);
  if (__ARTIFACT_BUILD__ || !enabled) return null;
  const act = async (run: () => Promise<void>, done: string) => {
    try {
      await run();
      toast({ kind: 'success', title: done });
      await load();
    } catch (e) {
      toast({ kind: 'error', title: 'That didn’t work', body: (e as Error).message });
    }
  };
  const actions: MarketAdminActions = {
    onHide: (id, title) => setHiding({ id, title }),
    onDismiss: (id) => void act(() => dismissReport(id), 'Report dismissed'),
    onUnhide: (id, title) =>
      void (async () => {
        if (await confirmAction({ title: 'Unhide this listing?', body: `${title} goes back on the web if its seller still has it on.`, confirmLabel: 'Unhide' })) await act(() => unhideListing(id), 'Listing unhidden');
      })(),
    onSubmit: () =>
      void (async () => {
        if (!(await confirmAction({ title: 'Send the sitemap to Google?', body: 'Search Console is asked to read /sitemap.xml again. It goes at most once a day across the whole app.', confirmLabel: 'Send' }))) return;
        setBusy(true);
        try {
          setLast(await submitMarketSitemap());
          await load();
        } catch (e) {
          toast({ kind: 'error', title: 'Couldn’t send the sitemap', body: (e as Error).message });
        } finally {
          setBusy(false);
        }
      })(),
  };
  return (
    <SettingsSection
      title="Public marketplace"
      description="Listings sellers put on the web at /market: visitors’ reports, what’s held or hidden, and Search Console."
      actions={
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
          <RefreshCw /> Refresh
        </button>
      }
    >
      <MarketAdminView data={data} error={error} origin={publicUrl.replace(/\/market$/, '')} busy={busy} last={last} actions={actions} />
      {hiding && (
        <HideDialog
          title={hiding.title}
          onDone={(r) => {
            const h = hiding;
            setHiding(null);
            if (!r) return;
            void (async () => {
              if (await confirmAction({ title: 'Hide this listing from the web?', body: `${h.title} answers “gone” at once and its seller can’t turn it back on.`, confirmLabel: 'Hide', danger: true })) await act(() => hideListing(h.id, r.reason, r.note), 'Listing hidden');
            })();
          }}
        />
      )}
    </SettingsSection>
  );
}
