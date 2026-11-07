// Step 4: budget and dates, for this platform only, in this ad account's own currency (never converted, never
// prefilled across currencies). PAUSED / ACTIVE has no default: the launch can't go on until one is picked. On Meta
// the days can't go below what its 24-hour rule allows from the start picked (the review checks it again).
import type { AdCampaign } from '@/lib/types';
import type { AdAccountOption, AdLimitsView, LaunchChoice } from '@/lib/ads/launchTypes';
import { PLATFORM_LABEL } from '@/lib/ads/launchTypes';
import { money, runsText, todayIn } from '@/lib/ads/launchFormat';
import { Callout, Field, Segmented } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { metaDaysProblem, minDaysFor, type LaunchDraft } from './draft';

export function BudgetStep({ plan, draft, account, limits, split, twoPlatforms, onChange, now }: { plan: AdCampaign; draft: LaunchDraft; account: AdAccountOption | undefined; limits: AdLimitsView | undefined; split: { text: string; over: boolean } | null; twoPlatforms: boolean; onChange: (patch: Partial<LaunchDraft>) => void; now?: number }) {
  const P = PLATFORM_LABEL[draft.platform];
  const cur = account?.currency || '';
  const tz = account?.timezone || '';
  const start = draft.startMode === 'day' ? draft.startDate : tz ? todayIn(tz, now) : '';
  const notPlanCurrency = !!cur && cur !== 'USD';
  const id = (s: string) => `lw-${draft.platform}-${s}`;
  // Meta: a daily budget runs only more than 24 hours, so never 1 day (and more from a late start)
  const minDays = minDaysFor(draft, tz || undefined, now);
  const tooShort = draft.platform === 'meta' && draft.durationDays < minDays;
  return (
    <div className="flex flex-col gap-5">
      {twoPlatforms && <p className="text-small text-ink-2">Your plan says {money(plan.dailyBudget, 'USD')} a day in total. Split it between Meta and Google:</p>}
      {notPlanCurrency && <Callout tone="info">Your account is in {cur}. Enter a daily amount in {cur}.</Callout>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={`Daily budget on ${P}${cur ? ` (${cur})` : ''}`} htmlFor={id('daily')} hint={account?.minDailyBudget ? `${P}’s minimum for this account: ${money(account.minDailyBudget, cur)} a day.` : 'A whole number.'}>
          <input id={id('daily')} inputMode="numeric" className="input num" value={draft.daily} placeholder={cur ? `Amount in ${cur}` : 'Amount'} onChange={(e) => onChange({ daily: e.target.value.replace(/[^\d]/g, '').slice(0, 7), dailyTouched: true })} />
        </Field>
        <Field label="Number of days" htmlFor={id('days')} error={tooShort ? metaDaysProblem(minDays) : undefined} hint={draft.platform === 'meta' ? `At least ${minDays} on Meta: a daily budget needs more than 24 hours.` : undefined}>
          <input id={id('days')} type="number" min={minDays} max={90} className="input num" value={draft.durationDays} aria-invalid={tooShort || undefined} onChange={(e) => onChange({ durationDays: Math.max(1, Math.min(90, Math.round(Number(e.target.value) || 1))) })} />
        </Field>
      </div>
      {split && <p className={cn('num text-small', split.over ? 'text-warn' : 'text-muted')}>{split.text}</p>}
      <div className="flex flex-col gap-2">
        <p className="label" id={id('start')}>
          Start
        </p>
        <Segmented<'asap' | 'day'> aria-labelledby={id('start')} value={draft.startMode} onChange={(v) => onChange({ startMode: v })} options={[{ id: 'asap', label: 'As soon as approved' }, { id: 'day', label: 'Pick a day' }]} />
        {draft.startMode === 'day' && (
          <div className="flex flex-wrap gap-2">
            <input type="date" className="input w-auto" aria-label="Start day" value={draft.startDate} min={tz ? todayIn(tz) : undefined} onChange={(e) => onChange({ startDate: e.target.value })} />
            {draft.platform === 'meta' && <input type="time" className="input w-auto" aria-label="Start time" value={draft.startTime} onChange={(e) => onChange({ startTime: e.target.value })} />}
          </div>
        )}
        {start && tz && <p className="text-small text-muted">{runsText(start, draft.durationDays, tz)}</p>}
      </div>
      {limits && (
        <p className="text-small text-muted">
          Your limit: {money(limits.maxDaily, limits.currency)} a day across all live campaigns. In use: {money(limits.committedDaily, limits.currency)}.
        </p>
      )}
      <div className="flex flex-col gap-2">
        <p className="label" id={id('status')}>
          How it starts
        </p>
        <Segmented<'' | LaunchChoice> aria-labelledby={id('status')} value={draft.status} onChange={(v) => onChange({ status: v })} options={[{ id: 'PAUSED', label: 'Paused' }, { id: 'ACTIVE', label: 'Active' }]} />
        <ul className="flex flex-col gap-1 text-small text-muted">
          <li>
            <span className="font-medium text-ink-2">Paused:</span> created and sent for review, spends nothing until you resume it.
          </li>
          <li>
            <span className="font-medium text-ink-2">Active:</span> starts spending as soon as {P} approves it.
          </li>
        </ul>
      </div>
    </div>
  );
}
