// A change to a launched campaign (spec §9.1): the customer's input, then the server's preview (one live read,
// nothing sent), then a confirm, then ONE change request. Raising spend (resume, a higher budget, a later end
// date) gets the spend confirm with the money; lowering, pausing and ending get the short one. Rules:
//   - one clientRequestId per review (per review token); after an uncertain answer, the next press of the same
//     review sends the same id, so the server answers with the job it already has; a new review gets a new id;
//     nothing is retried by itself; a replayed answer that failed is shown as failed, never as done;
//   - a module-level `sending` set stops a reopened window from sending twice; the button is off while in flight.
import { useEffect, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import type { ChangeAction, ChangePreviewRequest, ChangeReview, LaunchedCampaign } from '@/lib/ads/launchTypes';
import { PLATFORM_LABEL } from '@/lib/ads/launchTypes';
import { AdsApiError, changeAds, MAY_HAVE_HAPPENED, newRequestId, previewChange } from '@/lib/ads/launchApi';
import { changeButton, changeLines, changeTitle, money, todayIn } from '@/lib/ads/launchFormat';
import { beginBusy, endBusy } from '@/lib/busy';
import { useAdsLaunch } from '@/store/adsLaunch';
import { useStore } from '@/store/useStore';
import { Callout, Checkbox, Field, Modal, Select, Spinner } from '@/components/ui/primitives';
import { ClaimTicks } from '../launch/ReviewStep';

const sending = new Set<string>();
/** A review (by its token) whose last press got no definite answer: its next press carries the same request id. */
const uncertainRequest = new Map<string, string>();
export const changeRequestIdFor = (reviewToken: string) => uncertainRequest.get(reviewToken) ?? newRequestId();

export type ChangeOutcome = { ok: true } | { ok: false; message: string; uncertain: boolean };

/** One change request with this window's id; never retried. A change already on its way sends nothing. */
export async function sendChange(campaignId: string, action: ChangeAction, reviewToken: string, requestId: string, send = changeAds): Promise<ChangeOutcome | null> {
  const key = `${campaignId}:${action}`;
  if (sending.has(key)) return null;
  sending.add(key);
  beginBusy(`ads-change:${key}`, 'Sending an ad change', 'app');
  try {
    const r = await send(campaignId, reviewToken, requestId);
    uncertainRequest.delete(reviewToken);
    const s = useAdsLaunch.getState();
    s.applyJob(r.job);
    void s.follow(r.job.id);
    // the server answered with the job this review already had: an old failure is a failure, not done
    if (r.replayed && r.job.state === 'failed') return { ok: false, uncertain: false, message: r.job.message };
    return { ok: true };
  } catch (e) {
    const uncertain = e instanceof AdsApiError && e.uncertain;
    if (uncertain) uncertainRequest.set(reviewToken, requestId);
    else uncertainRequest.delete(reviewToken);
    return { ok: false, uncertain, message: uncertain ? `We may have sent this change. ${MAY_HAVE_HAPPENED} Pressing it again can’t send it twice.` : e instanceof AdsApiError ? e.message : 'Nothing was sent. Try again shortly.' };
  } finally {
    sending.delete(key);
    endBusy(`ads-change:${key}`);
  }
}

/** Changes that need something from the customer before the preview. */
const NEEDS_INPUT: ChangeAction[] = ['budget', 'end_date', 'creative'];

export function ChangeConfirmHost() {
  const w = useAdsLaunch((s) => s.changeWindow);
  const close = useAdsLaunch((s) => s.closeChange);
  const c = useAdsLaunch((s) => (w ? Object.values(s.campaigns).flat().find((x) => x.id === w.campaignId) : undefined));
  if (__ARTIFACT_BUILD__ || !w || !c) return null;
  return <ChangeConfirm key={`${c.id}:${w.action}`} c={c} action={w.action} onClose={close} />;
}

export function ChangeConfirm({ c, action, onClose }: { c: LaunchedCampaign; action: ChangeAction; onClose: () => void }) {
  const plan = useStore((s) => s.ads.find((a) => a.id === c.planId));
  const cur = c.account.currency;
  const [daily, setDaily] = useState(String(c.daily));
  const [endDate, setEndDate] = useState(c.end ?? '');
  const offered = (plan?.creatives ?? []).filter((x) => plan?.selectedCreativeIds.includes(x.id) && x.format !== 'video');
  const [creativeId, setCreativeId] = useState(offered[0]?.id ?? '');
  const [adIndex, setAdIndex] = useState('0');
  const [claims, setClaims] = useState<string[]>([]);
  const [review, setReview] = useState<ChangeReview | null>(null);
  // the claim words of the last review stay listed while the customer ticks them (one review round for all)
  const [lastClaims, setLastClaims] = useState<NonNullable<ChangeReview['claims']>>([]);
  const [token, setToken] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(false);
  const key = `${c.id}:${action}`;
  const inFlight = busy || sending.has(key);

  const request = (): ChangePreviewRequest => ({
    action,
    ...(action === 'budget' ? { dailyBudget: /^\d{1,7}$/.test(daily) ? Number(daily) : Number.NaN } : {}),
    ...(action === 'end_date' ? { endDate } : {}),
    ...(action === 'creative' ? { ...(c.platform === 'meta' ? { creativeId, adIndex: Number(adIndex) } : {}), claimsConfirmed: claims } : {}),
  });
  const preview = async () => {
    if (reviewing) return;
    setReviewing(true);
    setErr(null);
    try {
      const r = await previewChange(c.id, request());
      setReview(r.review);
      setToken(r.reviewToken ?? null);
      setLastClaims(r.review.claims ?? []);
    } catch (e) {
      setReview(null);
      setToken(null);
      setErr(e instanceof AdsApiError ? e.message : 'The review didn’t work. Try again.');
    } finally {
      setReviewing(false);
    }
  };
  // pause, resume and end need nothing more: their review is read as the window opens
  useEffect(() => {
    if (!NEEDS_INPUT.includes(action)) void preview();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const spend = review?.confirmKind === 'spend';
  const tickNeeded = action === 'resume' || spend;
  const blocked = !review || !token || review.blockers.length > 0;
  const confirm = async () => {
    if (inFlight || blocked || (tickNeeded && !tick)) return;
    setBusy(true);
    setErr(null);
    const r = await sendChange(c.id, action, token!, changeRequestIdFor(token!));
    setBusy(false);
    if (!r) return;
    if (r.ok) onClose();
    else setErr(r.message);
  };
  const resetReview = () => {
    setReview(null);
    setToken(null);
  };

  return (
    <Modal
      open
      persistent={inFlight}
      onClose={() => !inFlight && onClose()}
      size="md"
      title={changeTitle({ action, platform: c.platform })}
      subtitle={`${c.name} · ${c.account.name} …${c.account.idTail}`}
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" disabled={inFlight} onClick={onClose}>
            Cancel
          </button>
          {review ? (
            <button type="button" className={action === 'end' ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm'} disabled={inFlight || blocked || (tickNeeded && !tick)} aria-busy={busy || undefined} onClick={() => void confirm()}>
              {busy && <Spinner />} {busy ? 'Sending…' : changeButton(review)}
            </button>
          ) : (
            NEEDS_INPUT.includes(action) && (
              <button type="button" className="btn btn-primary btn-sm" disabled={reviewing} onClick={() => void preview()}>
                {reviewing ? <Spinner /> : <ClipboardCheck />} Review the change
              </button>
            )
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {action === 'budget' && (
          <Field label={`New daily budget (${cur})`} htmlFor="cc-daily" hint={`Now ${money(c.daily, cur)} a day. A whole number.`}>
            <input
              id="cc-daily"
              inputMode="numeric"
              className="input num"
              value={daily}
              onChange={(e) => {
                setDaily(e.target.value.replace(/[^\d]/g, '').slice(0, 7));
                resetReview();
              }}
            />
          </Field>
        )}
        {action === 'end_date' && (
          <Field label="New last day" htmlFor="cc-end" hint={`It ends at 23:59 ${c.account.timezone} on that day.`}>
            <input
              id="cc-end"
              type="date"
              className="input w-auto"
              value={endDate}
              min={todayIn(c.account.timezone)}
              onChange={(e) => {
                setEndDate(e.target.value);
                resetReview();
              }}
            />
          </Field>
        )}
        {action === 'creative' && c.platform === 'meta' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Use this version from the plan">
              <Select
                value={creativeId}
                onChange={(v) => {
                  setCreativeId(v);
                  setLastClaims([]);
                  resetReview();
                }}
                options={offered.map((x) => ({ value: x.id, label: `Version ${x.variant}`, description: x.headline }))}
              />
            </Field>
            <Field label="In place of">
              <Select
                value={adIndex}
                onChange={(v) => {
                  setAdIndex(v);
                  resetReview();
                }}
                options={[0, 1, 2].map((i) => ({ value: String(i), label: `Ad ${i + 1}` }))}
              />
            </Field>
          </div>
        )}
        {action === 'creative' && c.platform === 'google' && <p className="text-small text-ink-2">The search ad’s headlines and descriptions are replaced with the plan’s current ones.</p>}
        {reviewing && !review && (
          <p className="flex items-center gap-2 text-small text-muted">
            <Spinner size={14} /> Reading the campaign as it is now…
          </p>
        )}
        {err && <Callout tone={/may have/i.test(err) ? 'warn' : 'bad'}>{err}</Callout>}
        {lastClaims.length > 0 && (
          <ClaimTicks
            claims={lastClaims}
            confirmed={claims}
            onChange={(v) => {
              setClaims(v);
              resetReview();
            }}
          />
        )}
        {review && (
          <>
            {review.blockers.length > 0 && (
              <Callout tone="bad" title="This can’t be sent">
                <ul className="flex flex-col gap-0.5">
                  {review.blockers.map((b, i) => (
                    <li key={`${b.code}-${i}`}>{b.message}</li>
                  ))}
                </ul>
              </Callout>
            )}
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-small sm:grid-cols-[8.5rem_minmax(0,1fr)]" data-testid="change-lines">
              {changeLines(review).map((l) => (
                <div key={l.label} className="contents">
                  <dt className="text-muted">{l.label}</dt>
                  <dd className="text-ink">{l.value}</dd>
                </div>
              ))}
            </dl>
            {review.learning === 'LEARNING' && <p className="text-small text-muted">Meta is still learning who to show this to. Costs move around for the first days.</p>}
            {review.notes.map((n, i) => (
              <p key={`${n.code}-${i}`} className="text-small text-muted">
                {n.message}
              </p>
            ))}
            {tickNeeded && <Checkbox id="cc-tick" checked={tick} onChange={setTick} label={`I understand this will spend real money from the ${c.account.name} ad account on ${PLATFORM_LABEL[c.platform]}.`} />}
          </>
        )}
      </div>
    </Modal>
  );
}
