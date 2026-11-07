// "Before your first ad" (Meta): the three things Meta checks on the first launch, for the chosen ad account, from
// GET /api/ads/accounts (firstAd). A payment method and a Facebook Page come from Meta's live checks; Meta's
// non-discrimination policy can't be checked from here, so the customer ticks that a business admin accepted it
// (kept per ad account, PUT /api/ads/accounts/policy, our database only). Nothing here blocks a launch: Meta decides
// when you launch. Links go only to Meta's own pages (safeFixUrl).
import { useState } from 'react';
import { CircleAlert, CircleCheck, CircleHelp, ExternalLink, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FirstAdCheck, FirstAdItem } from '@/lib/ads/launchTypes';
import { safeFixUrl } from '@/lib/ads/launchFormat';
import { AdsApiError, confirmAdPolicy } from '@/lib/ads/launchApi';
import { Checkbox } from '@/components/ui/primitives';

const STATUS: Record<FirstAdItem['status'], { Icon: typeof CircleCheck; cls: string; word: string }> = {
  done: { Icon: CircleCheck, cls: 'text-good', word: 'Done' },
  not_done: { Icon: CircleAlert, cls: 'text-bad', word: 'Not done' },
  unconfirmed: { Icon: TriangleAlert, cls: 'text-warn', word: 'Not confirmed' },
  unknown: { Icon: CircleHelp, cls: 'text-muted', word: 'Can’t tell' },
};

const TITLE: Record<FirstAdItem['id'], string> = {
  payment: 'Payment method on the ad account',
  policy: 'Meta’s non-discrimination policy accepted',
  page: 'Facebook Page linked',
};

function Link({ href, children }: { href: string | undefined; children: string }) {
  const safe = safeFixUrl(href);
  if (!safe) return null;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-0.5">
      {children} <ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}

export function BeforeFirstAd({ projectId, adAccountRef, firstAd, onChanged, className }: { projectId: string; adAccountRef: string | undefined; firstAd: FirstAdCheck; onChanged: () => void; className?: string }) {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const policy = firstAd.items.find((i) => i.id === 'policy');
  const [ticked, setTicked] = useState<boolean | null>(null);
  const confirmed = ticked ?? policy?.confirmed === true;

  const tick = async (v: boolean) => {
    if (saving || !adAccountRef) return;
    setSaving(true);
    setProblem(null);
    setTicked(v);
    try {
      await confirmAdPolicy(projectId, adAccountRef, v);
      onChanged();
    } catch (e) {
      setTicked(null);
      setProblem(e instanceof AdsApiError ? e.message : 'Your answer couldn’t be saved. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={cn('flex flex-col gap-3 rounded-lg border border-line p-3', className)} aria-label="Before your first ad">
      <div>
        <p className="text-ui font-medium text-ink">Before your first ad</p>
        <p className="text-caption text-muted">
          Meta checks these on {firstAd.adAccount.name} <span className="num font-mono">…{firstAd.adAccount.idTail}</span> when you launch.
        </p>
      </div>
      <ul className="flex flex-col gap-3">
        {firstAd.items.map((i) => {
          const s = STATUS[i.status];
          return (
            <li key={i.id} className="flex items-start gap-2 text-small text-ink-2">
              <s.Icon size={16} className={cn('mt-0.5 shrink-0', s.cls)} aria-hidden="true" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p>
                  <span className="font-medium text-ink">{TITLE[i.id]}</span> <span className={cn('text-caption', s.cls)}>{s.word}</span>
                </p>
                <p>{i.message}</p>
                {i.status !== 'done' && i.steps && i.steps.length > 0 && (
                  <ol className="ml-4 flex list-decimal flex-col gap-0.5 text-caption text-muted">
                    {i.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                )}
                {(i.fixUrl || i.alsoUrl) && (
                  <p className="flex flex-wrap gap-x-3 gap-y-1">
                    {i.status !== 'done' || i.id === 'policy' ? <Link href={i.fixUrl}>{i.fixLabel ?? 'Fix it'}</Link> : null}
                    {i.alsoUrl && i.status !== 'done' ? <Link href={i.alsoUrl}>{i.alsoLabel ?? 'More'}</Link> : null}
                  </p>
                )}
                {i.id === 'policy' && (
                  <div className="pt-1">
                    <Checkbox id={`first-ad-policy-${firstAd.adAccount.idTail}`} checked={confirmed} disabled={saving || !adAccountRef} onChange={(v) => void tick(v)} label="A business admin has accepted Meta’s non-discrimination policy for the business that owns this ad account." />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {problem && (
        <p role="alert" className="text-small text-bad">
          {problem}
        </p>
      )}
    </section>
  );
}
