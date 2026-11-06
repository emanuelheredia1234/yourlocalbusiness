// Step 5: the server's review of exactly what would be sent (POST /api/ads/launch/preview reads the saved plan,
// the account and the limits again; nothing is sent to Meta or Google). Blockers stop the launch; claim words
// need the customer's own tick; warnings and what's left out are said plainly.
import type { ClaimFlag, LaunchReview, PlainNote } from '@/lib/ads/launchTypes';
import { launchLines } from '@/lib/ads/launchFormat';
import { Callout, Checkbox } from '@/components/ui/primitives';
import { safeFixUrl } from '../campaigns/SetupChecklist';

function Notes({ title, tone, notes }: { title: string; tone: 'bad' | 'warn' | 'info'; notes: PlainNote[] }) {
  if (!notes.length) return null;
  return (
    <Callout tone={tone} title={title}>
      <ul className="flex flex-col gap-1">
        {notes.map((n, i) => {
          const fix = safeFixUrl(n.fixUrl);
          return (
            <li key={`${n.code}-${i}`}>
              {n.message}
              {fix && (
                <a href={fix} target="_blank" rel="noopener noreferrer" className="link ml-1">
                  Fix it
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </Callout>
  );
}

export function ClaimTicks({ claims, confirmed, onChange }: { claims: ClaimFlag[]; confirmed: string[]; onChange: (v: string[]) => void }) {
  if (!claims.length) return null;
  const on = new Set(confirmed.map((c) => c.toLowerCase()));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="label">Claims in your ads</legend>
      <p className="text-small text-muted">Ads must only claim what’s true for your business. Tick each one that’s true and you can show it, or change the plan.</p>
      {claims.map((c) => (
        <Checkbox
          key={c.phrase}
          id={`claim-${c.phrase.replace(/\W+/g, '-')}`}
          checked={on.has(c.phrase)}
          onChange={(v) => onChange(v ? [...confirmed, c.phrase] : confirmed.filter((x) => x.toLowerCase() !== c.phrase))}
          label={<span>“{c.phrase}”</span>}
          description={`In ${c.field}. This is true and I can show it.`}
        />
      ))}
    </fieldset>
  );
}

export function ReviewStep({ review, error, stale, confirmed, onClaims }: { review: LaunchReview | null; error: string | null; stale: boolean; confirmed: string[]; onClaims: (v: string[]) => void }) {
  if (error) return <Callout tone="bad">{error}</Callout>;
  if (!review) return <p className="text-small text-muted">Review it to see exactly what will be sent.</p>;
  return (
    <div className="flex flex-col gap-4" data-testid={`review-${review.platform}`}>
      {stale && <Callout tone="info">You changed something since this review. Review it again before launching.</Callout>}
      <Notes title="Fix these first" tone="bad" notes={review.blockers} />
      <ClaimTicks claims={review.claims} confirmed={confirmed} onChange={onClaims} />
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-small sm:grid-cols-[9rem_minmax(0,1fr)]">
        {launchLines(review).map((l) => (
          <div key={l.label} className="contents">
            <dt className="text-muted">{l.label}</dt>
            <dd className="text-ink">{l.value}</dd>
          </div>
        ))}
      </dl>
      {review.targeting.length > 0 && (
        <div>
          <p className="label">Who sees it</p>
          <p className="text-small text-ink-2">{review.targeting.join(' · ')}</p>
        </div>
      )}
      <div>
        <p className="label">The ads, as they’ll be sent</p>
        <ul className="flex flex-col gap-2">
          {review.ads.map((a) => (
            <li key={a.variant} className="rounded-md border border-line px-3 py-2 text-small">
              {a.headlines ? (
                <>
                  <p className="text-ink">{a.headlines.join(' | ')}</p>
                  <p className="text-muted">{(a.descriptions ?? []).join(' ')}</p>
                  {a.keywords && <p className="mt-1 font-mono text-caption text-muted">{a.keywords.join(', ')}</p>}
                </>
              ) : (
                <>
                  <p className="font-medium text-ink">
                    Version {a.variant}: {a.headline}
                  </p>
                  <p className="whitespace-pre-line text-ink-2">{a.body}</p>
                  <p className="text-caption text-muted">
                    Button: {a.callToAction} · {a.hasImage ? 'With its image' : 'No image yet'}
                  </p>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
      {review.goalNote && <p className="text-small text-muted">{review.goalNote}</p>}
      <Notes title="Good to know" tone="warn" notes={review.warnings} />
      <Notes title="Left out" tone="info" notes={review.leftOut} />
    </div>
  );
}
