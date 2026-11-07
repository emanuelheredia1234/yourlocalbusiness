// Settings → Connected accounts → Ad accounts, under Meta ads once it's connected: "Before your first ad" for the
// business on screen. With no ad account picked for the business yet (or the one picked isn't on this connection any
// more), it asks which one first (saved for the business, our database only); then it shows the checks
// (BeforeFirstAd). With no ad account it can use, it says why (the checklist's red line). Shown only when launching is
// on for the user; a failed read leaves it out (the launch window says it again with the reason).
import { useCallback, useEffect, useState } from 'react';
import type { AccountsResponse } from '@/lib/ads/launchTypes';
import { AdsApiError, chooseAdAccount, getAdAccounts } from '@/lib/ads/launchApi';
import { Spinner } from '@/components/ui/primitives';
import { BeforeFirstAd } from '@/pages/marketing/ads/launch/BeforeFirstAd';

/**
 * Why there's no ad account to pick (none listed, or none Meta lets you use): the checklist's first red line, else a
 * plain sentence. undefined when there is one to pick, or nothing to say (a read that failed).
 */
export function noAccountReason(data: Pick<AccountsResponse, 'accounts' | 'setup'>): string | undefined {
  if (data.accounts.some((a) => a.usable)) return undefined;
  const red = data.setup.find((c) => c.state === 'missing' && c.id !== 'account')?.message;
  return red ?? (data.accounts.length ? 'None of your Meta ad accounts can run ads right now. Open Meta Ads Manager to see why.' : undefined);
}

export function FirstAdPanel({ projectId, businessName, connectedKey }: { projectId: string; businessName: string; connectedKey: string }) {
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getAdAccounts(projectId, 'meta'));
    } catch {
      setData(null);
    }
  }, [projectId]);
  // again whenever the connection changes (connected just now, reconnected, another account chosen)
  useEffect(() => {
    void load();
  }, [load, connectedKey]);

  if (!data || !data.connection || !data.canLaunch) return null;
  const pick = async (ref: string) => {
    if (saving) return;
    setSaving(ref);
    setProblem(null);
    try {
      await chooseAdAccount(projectId, 'meta', ref);
      await load();
    } catch (e) {
      setProblem(e instanceof AdsApiError ? e.message : 'That account couldn’t be saved. Try again.');
    } finally {
      setSaving(null);
    }
  };
  const usable = data.accounts.filter((a) => a.usable);
  const why = usable.length ? undefined : noAccountReason(data);

  return (
    <div className="flex flex-col gap-2 py-3">
      {data.firstAd ? (
        <BeforeFirstAd key={data.chosen?.ref ?? ''} projectId={projectId} adAccountRef={data.chosen?.ref} firstAd={data.firstAd} onChanged={() => void load()} />
      ) : usable.length > 0 ? (
        <section className="flex flex-col gap-2 rounded-lg border border-line p-3" aria-label="Before your first ad">
          <p className="text-ui font-medium text-ink">Before your first ad</p>
          {data.choiceStale && <p className="text-small text-warn">The ad account picked before isn’t on this Meta connection any more. Pick one again.</p>}
          <p className="text-small text-ink-2">Pick the Meta ad account {businessName} launches on, and we’ll check what Meta needs before your first ad.</p>
          <div role="radiogroup" aria-label="Ad account" className="flex flex-col gap-2">
            {usable.map((a) => (
              <button key={a.ref} type="button" role="radio" aria-checked={false} disabled={!!saving} onClick={() => void pick(a.ref)} className="flex w-full items-center gap-3 rounded-lg border border-line p-2.5 text-left hover:border-line-3">
                <span className="min-w-0 flex-1 text-ui text-ink">
                  {a.name} <span className="num font-mono text-small text-muted">…{a.idTail}</span>
                </span>
                {saving === a.ref && <Spinner size={14} />}
              </button>
            ))}
          </div>
        </section>
      ) : why ? (
        <section className="flex flex-col gap-2 rounded-lg border border-line p-3" aria-label="Before your first ad">
          <p className="text-ui font-medium text-ink">Before your first ad</p>
          <p className="text-small text-bad">{why}</p>
        </section>
      ) : null}
      {problem && (
        <p role="alert" className="text-small text-bad">
          {problem}
        </p>
      )}
    </div>
  );
}
