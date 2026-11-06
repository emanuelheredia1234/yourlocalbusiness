// The spend confirm (spec §7.4): exactly what will spend money, per platform, in each account's own currency,
// then ONE launch request per platform when the customer presses the button. Rules:
//   - one clientRequestId per platform per opening of this window; a second press after an uncertain answer
//     (no answer, or a gateway error) sends the same id, so the server answers with the job it already has;
//   - a module-level `sending` set stops a reopened window from sending while a request is on its way;
//   - the button is disabled from the first press until the answer (Enter or a double click can't fire twice);
//   - an ACTIVE launch needs the "real money" tick; nothing is ever retried by itself.
import { useEffect, useRef, useState } from 'react';
import { Rocket } from 'lucide-react';
import type { AdJob, AdsPlatform, LaunchedCampaign, LaunchReview } from '@/lib/ads/launchTypes';
import { PLATFORM_LABEL, PLATFORM_LONG } from '@/lib/ads/launchTypes';
import { AdsApiError, launchAds, MAY_HAVE_HAPPENED, newRequestId } from '@/lib/ads/launchApi';
import { combinedLine, launchButton, launchLines, needsMoneyTick } from '@/lib/ads/launchFormat';
import { beginBusy, endBusy } from '@/lib/busy';
import { Callout, Checkbox, Modal, Spinner } from '@/components/ui/primitives';

export interface LaunchItem {
  /** planId:platform */
  key: string;
  platform: AdsPlatform;
  reviewToken: string;
  review: LaunchReview;
}

export type LaunchOutcome = { key: string; platform: AdsPlatform; ok: true; job: AdJob; campaign?: LaunchedCampaign } | { key: string; platform: AdsPlatform; ok: false; message: string; uncertain: boolean; code: string };

/** Launches on their way right now (outside the window, so reopening it can't send twice). */
const sending = new Set<string>();
/** A launch whose last press got no definite answer: its next confirm carries the same request id. */
const uncertainRequest = new Map<string, string>();

/** The request id for a new opening of the window: the uncertain one if there is one, else a fresh one. */
export const launchRequestIdFor = (key: string) => uncertainRequest.get(key) ?? newRequestId();
export const isSending = (key: string) => sending.has(key);

function refusal(e: unknown, platform: AdsPlatform): { message: string; uncertain: boolean; code: string } {
  if (!(e instanceof AdsApiError)) return { message: 'Nothing was sent. Try again shortly.', uncertain: false, code: 'UNKNOWN' };
  if (e.uncertain) return { message: `We may have started the launch on ${PLATFORM_LABEL[platform]}. ${MAY_HAVE_HAPPENED} Check the Campaigns tab first: pressing Launch again can’t launch it twice.`, uncertain: true, code: e.code };
  return { message: e.message, uncertain: false, code: e.code };
}

/**
 * Send each launch once, one after another (one platform failing never cancels, retries or changes the other).
 * Items already on their way are skipped. Never retried here.
 */
export async function sendLaunches(items: LaunchItem[], requestIds: Record<string, string>, send = launchAds): Promise<LaunchOutcome[]> {
  const out: LaunchOutcome[] = [];
  for (const it of items) {
    if (sending.has(it.key)) continue;
    const id = requestIds[it.key] ?? launchRequestIdFor(it.key);
    sending.add(it.key);
    beginBusy(`ads-launch:${it.key}`, `Launching on ${PLATFORM_LABEL[it.platform]}`, 'app');
    try {
      const r = await send(it.reviewToken, id);
      uncertainRequest.delete(it.key);
      out.push({ key: it.key, platform: it.platform, ok: true, job: r.job, campaign: r.campaign });
    } catch (e) {
      const f = refusal(e, it.platform);
      if (f.uncertain) uncertainRequest.set(it.key, id);
      else uncertainRequest.delete(it.key);
      out.push({ key: it.key, platform: it.platform, ok: false, ...f });
    } finally {
      sending.delete(it.key);
      endBusy(`ads-launch:${it.key}`);
    }
  }
  return out;
}

export function SpendConfirm({ open, items, onClose, onLaunched }: { open: boolean; items: LaunchItem[]; onClose: () => void; onLaunched: (done: LaunchOutcome[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [doneKeys, setDoneKeys] = useState<string[]>([]);
  // one request id per platform per opening of the window
  const ids = useRef<Record<string, string>>({});
  const keys = items.map((i) => i.key).join(',');
  useEffect(() => {
    if (!open) return;
    ids.current = Object.fromEntries(items.map((i) => [i.key, launchRequestIdFor(i.key)]));
    setBusy(false);
    setTick(false);
    setErrors({});
    setDoneKeys([]);
  }, [open, keys]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open || !items.length) return null;
  const left = items.filter((i) => !doneKeys.includes(i.key));
  const reviews = left.map((i) => i.review);
  const tickNeeded = needsMoneyTick(reviews);
  const inFlight = busy || left.some((i) => sending.has(i.key));
  const accounts = [...new Set(reviews.map((r) => r.account.name))].join(' and ');

  const confirm = async () => {
    if (inFlight || (tickNeeded && !tick) || !left.length) return;
    setBusy(true);
    setErrors({});
    const out = await sendLaunches(left, ids.current);
    setBusy(false);
    const ok = out.filter((o) => o.ok);
    const bad = out.filter((o): o is Extract<LaunchOutcome, { ok: false }> => !o.ok);
    if (ok.length) setDoneKeys((d) => [...d, ...ok.map((o) => o.key)]);
    setErrors(Object.fromEntries(bad.map((b) => [b.key, b.message])));
    if (ok.length) onLaunched(ok);
    if (!bad.length) onClose();
  };

  return (
    <Modal
      open
      persistent={inFlight}
      onClose={() => !inFlight && onClose()}
      size="md"
      title={left.length > 1 ? 'Launch on Meta and Google' : `Launch on ${PLATFORM_LONG[left[0]?.platform ?? items[0].platform]}`}
      subtitle="Ad spend is billed by Meta or Google to your own payment method. The app never charges you for it."
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" disabled={inFlight} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={inFlight || (tickNeeded && !tick) || !left.length} aria-busy={busy || undefined} onClick={() => void confirm()}>
            {busy ? <Spinner /> : <Rocket aria-hidden="true" />} {busy ? 'Launching…' : launchButton(reviews)}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {left.map((it) => (
          <section key={it.key} aria-label={`Launch on ${PLATFORM_LABEL[it.platform]}`} className="flex flex-col gap-2">
            {left.length > 1 && <h3 className="text-h4 text-ink">{PLATFORM_LONG[it.platform]}</h3>}
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-small sm:grid-cols-[8.5rem_minmax(0,1fr)]" data-testid={`spend-${it.platform}`}>
              {launchLines(it.review).map((l) => (
                <div key={l.label} className="contents">
                  <dt className="text-muted">{l.label}</dt>
                  <dd className="text-ink">{l.value}</dd>
                </div>
              ))}
            </dl>
            {errors[it.key] && <Callout tone={/may have/i.test(errors[it.key]) ? 'warn' : 'bad'}>{errors[it.key]}</Callout>}
          </section>
        ))}
        {combinedLine(reviews) && <p className="num text-small font-medium text-ink">{combinedLine(reviews)}</p>}
        {tickNeeded && <Checkbox id="spend-tick" checked={tick} onChange={setTick} label={`I understand this will spend real money from the ${accounts} ad account${reviews.length > 1 ? 's' : ''}.`} />}
      </div>
    </Modal>
  );
}
