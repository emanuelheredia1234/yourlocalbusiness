// Step 1: which ad account inside the business's Meta or Google connection. The connection itself is chosen in
// Settings → Connected accounts; the ad account here is saved for this business (our database only). Accounts
// that can't run ads can't be picked, and say why in plain words.
import { useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AccountsResponse, AdsPlatform } from '@/lib/ads/launchTypes';
import { MANAGER_LABEL } from '@/lib/ads/launchTypes';
import { AdsApiError, chooseAdAccount } from '@/lib/ads/launchApi';
import { Callout, Spinner } from '@/components/ui/primitives';
import { openConnectedAccounts } from '@/components/posts/PostItYourselfModal';
import { SetupChecklist } from '../campaigns/SetupChecklist';

export function AccountStep({ projectId, platform, data, loading, error, onChanged }: { projectId: string; platform: AdsPlatform; data: AccountsResponse | null; loading: boolean; error: string | null; onChanged: () => void }) {
  const [saving, setSaving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (loading && !data)
    return (
      <p className="flex items-center gap-2 text-small text-muted">
        <Spinner size={14} /> Reading your ad accounts…
      </p>
    );
  if (error) return <Callout tone="bad">{error}</Callout>;
  if (!data) return null;
  const pick = async (ref: string) => {
    if (saving) return;
    setSaving(ref);
    setProblem(null);
    try {
      await chooseAdAccount(projectId, platform, ref);
      onChanged();
    } catch (e) {
      setProblem(e instanceof AdsApiError ? e.message : 'That account couldn’t be saved. Try again.');
    } finally {
      setSaving(null);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      {data.connection ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2.5">
          <p className="min-w-0 text-small text-ink-2">
            Connected as <span className="font-medium text-ink">{data.connection.label}</span>
          </p>
          <button type="button" className="btn btn-ghost btn-xs" onClick={openConnectedAccounts}>
            <ArrowLeftRight /> Change in Connected accounts
          </button>
        </div>
      ) : (
        <Callout
          tone="warn"
          title={platform === 'meta' ? 'Connect Meta ads' : 'Connect Google Ads'}
          action={
            <button type="button" className="btn btn-secondary btn-xs" onClick={openConnectedAccounts}>
              Open Connected accounts
            </button>
          }
        >
          {data.setup[0]?.message ?? 'Connect the account first.'}
        </Callout>
      )}
      {data.choiceStale && <Callout tone="info">This business uses a different {MANAGER_LABEL[platform]} connection now. Pick the ad account again.</Callout>}
      {data.accounts.length > 0 && (
        <div role="radiogroup" aria-label="Ad account" className="flex flex-col gap-2">
          {data.accounts.map((a) => {
            const on = data.chosen?.ref === a.ref;
            return (
              <button
                key={a.ref}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!a.usable || !!saving}
                onClick={() => void pick(a.ref)}
                className={cn('flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-[border-color,box-shadow] duration-120', on ? 'border-transparent ring-[1.5px] ring-inset ring-primary' : 'border-line hover:border-line-3', !a.usable && 'cursor-not-allowed opacity-70')}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-ui text-ink">
                    {a.name} <span className="num font-mono text-small text-muted">…{a.idTail}</span>
                  </span>
                  <span className="block text-caption text-muted">
                    {a.currency || 'Currency unknown'} · {a.timezone || 'Time zone unknown'}
                    {a.minDailyBudget ? ` · at least ${a.minDailyBudget} a day` : ''}
                  </span>
                  {!a.usable && a.message && <span className="mt-1 block text-caption text-bad">{a.message}</span>}
                </span>
                {saving === a.ref && <Spinner size={14} />}
              </button>
            );
          })}
        </div>
      )}
      {problem && <Callout tone="bad">{problem}</Callout>}
      {data.connection && <SetupChecklist checks={data.setup} />}
    </div>
  );
}
