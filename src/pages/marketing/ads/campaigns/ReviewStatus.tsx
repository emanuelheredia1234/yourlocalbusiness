// Each ad's verdict at Meta or Google, read on demand (GET /api/ads/campaigns/:id/review, at most 3 reads). The
// reasons are the platform's own text: shown as plain text, cut, never a link and never followed (R6).
import { useState } from 'react';
import { ClipboardList } from 'lucide-react';
import type { LaunchedCampaign, ReviewView } from '@/lib/ads/launchTypes';
import { PLATFORM_LABEL } from '@/lib/ads/launchTypes';
import { AdsApiError, getCampaignReview } from '@/lib/ads/launchApi';
import { META_IN_REVIEW } from '@/lib/ads/reviewTime';
import { Spinner, StatusDot } from '@/components/ui/primitives';

const WORD = { approved: ['Approved', 'good'], rejected: ['Not approved', 'bad'], with_issues: ['Approved with limits', 'warn'], in_review: ['In review', 'primary'], unknown: ['Couldn’t read', 'faint'] } as const;

export function ReviewStatus({ c }: { c: LaunchedCampaign }) {
  const [view, setView] = useState<ReviewView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const read = async () => {
    setBusy(true);
    try {
      setView((await getCampaignReview(c.id)).review);
      setErr(null);
    } catch (e) {
      setErr(e instanceof AdsApiError ? e.message : 'The review couldn’t be read.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Review per ad" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-h4 text-ink">Review at {PLATFORM_LABEL[c.platform]}</h3>
        <button type="button" className="btn btn-ghost btn-xs" disabled={busy || !c.platformCampaignId} onClick={() => void read()}>
          {busy ? <Spinner size={12} /> : <ClipboardList />} {view ? 'Read again' : 'Read each ad'}
        </button>
      </div>
      {err && <p className="text-small text-bad">{err}</p>}
      {view && (
        <ul className="flex flex-col gap-2">
          {view.ads.map((a) => {
            const [word, tone] = WORD[a.status] ?? WORD.unknown;
            return (
              <li key={a.index} className="rounded-md border border-line px-3 py-2">
                <div className="flex items-center justify-between gap-2 text-small text-ink">
                  Ad {a.index + 1}
                  <StatusDot tone={tone}>{word}</StatusDot>
                </div>
                {a.reasons.length > 0 && (
                  <div className="mt-1 text-caption text-ink-2">
                    <span className="text-muted">{PLATFORM_LABEL[c.platform]}’s reason:</span>
                    <ul className="list-disc pl-4">
                      {a.reasons.map((r, i) => (
                        <li key={i} className="whitespace-pre-line break-words">
                          {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {view && c.platform === 'meta' && view.ads.some((a) => a.status === 'in_review') && <p className="text-caption text-muted">{META_IN_REVIEW}</p>}
    </section>
  );
}
