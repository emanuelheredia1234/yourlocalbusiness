// Owner → Billing → Ad limits (spec §10.1): the defaults every customer gets, each customer's own limits, what
// they have switched on now, and "Pause all" for one customer. Limits are checked by the server before every
// launch, resume and increase; pausing and ending are never blocked. Every limit change is written to that
// customer's ad activity and invalidates any review they have open. Turning ads off never pauses anything by
// itself: the confirm says how many campaigns are on and offers Pause all.
import { useCallback, useEffect, useState } from 'react';
import { Pause, Pencil } from 'lucide-react';
import type { AdLimitsCustomerRow, AdLimitsPatch, AdminLimitsResponse, LiveAdRow } from '@/lib/ads/launchTypes';
import { AdsApiError, getAdminAdLimits, pauseAll, previewPauseAll, putAdLimits } from '@/lib/ads/launchApi';
import { money } from '@/lib/ads/launchFormat';
import { fmtRelative } from '@/lib/utils';
import { toast } from '@/store/ui';
import { liveAdLine } from '@/components/ads/liveAds';
import { Badge, Callout, Field, Modal, Select, SettingsSection, Spinner, confirmAction } from '@/components/ui/primitives';

type Target = { tag: '*' } | { tag: string; row: AdLimitsCustomerRow };

/** Zernio's team-level problem, in plain words for the owner. */
export function zernioAlertText(kind: string): string {
  if (/ads_addon|feature_not_available/.test(kind)) return 'The ads add-on is off for your Zernio team: turn it on in the Zernio dashboard.';
  if (/allowance/.test(kind)) return 'Zernio’s free allowance of live ads is used up: add a payment method to your Zernio team.';
  if (/payment|402/.test(kind)) return 'Zernio’s billing gate is closed for your team: add a card or pay the open invoice in the Zernio dashboard.';
  if (/401|auth|key/.test(kind)) return 'Zernio refused the API key: check ZERNIO_API_KEY in Replit Secrets.';
  return 'Zernio refused an ads request for a reason on your team’s side (plan, billing or key): check the Zernio dashboard and the server log (zernio_owner_alert).';
}

const FIELDS: { key: Exclude<keyof AdLimitsPatch, 'adsEnabled' | 'adsCurrency'>; label: string; money: boolean }[] = [
  { key: 'maxDaily', label: 'Daily limit across live campaigns', money: true },
  { key: 'maxChange', label: 'Most one launch or increase can add a day', money: true },
  { key: 'maxCampaignTotal', label: 'Most one campaign can spend in total', money: true },
  { key: 'launchesPerDay', label: 'Launches a day', money: false },
  { key: 'changesPerDay', label: 'Changes a day (pausing and ending don’t count)', money: false },
];

/** The fields as typed (empty = inherit) → a patch; null when a value isn't valid. */
export function patchFrom(form: Record<string, string>, ceilings: { maxDaily: number; maxChange: number }): { patch: AdLimitsPatch } | { error: string } {
  const patch: AdLimitsPatch = {};
  patch.adsEnabled = form.adsEnabled === 'on' ? true : form.adsEnabled === 'off' ? false : null;
  const cur = (form.adsCurrency ?? '').trim().toUpperCase();
  if (cur && !/^[A-Z]{3}$/.test(cur)) return { error: 'The currency is a 3-letter code, like USD.' };
  patch.adsCurrency = cur || null;
  for (const f of FIELDS) {
    const t = (form[f.key] ?? '').trim();
    if (!t) {
      patch[f.key] = null;
      continue;
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || (!f.money && !Number.isInteger(n)) || (f.money && Math.round(n * 100) !== n * 100)) return { error: `${f.label}: enter ${f.money ? 'an amount' : 'a whole number'} of 0 or more.` };
    if (f.key === 'maxDaily' && n > ceilings.maxDaily) return { error: `The daily limit can be at most ${ceilings.maxDaily} (ADS_HARD_MAX_DAILY).` };
    if (f.key === 'maxChange' && n > ceilings.maxChange) return { error: `One launch or increase can be at most ${ceilings.maxChange} (ADS_HARD_MAX_CHANGE).` };
    patch[f.key] = n;
  }
  return { patch };
}

function EditLimits({ target, data, onClose, onSaved }: { target: Target; data: AdminLimitsResponse; onClose: () => void; onSaved: () => void }) {
  const own = target.tag === '*' ? data.defaults : (target as { row: AdLimitsCustomerRow }).row.own;
  const [form, setForm] = useState<Record<string, string>>(() => ({
    adsEnabled: own.adsEnabled === true ? 'on' : own.adsEnabled === false ? 'off' : 'inherit',
    adsCurrency: own.adsCurrency ?? '',
    ...Object.fromEntries(FIELDS.map((f) => [f.key, own[f.key] == null ? '' : String(own[f.key])])),
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const row = target.tag === '*' ? null : (target as { row: AdLimitsCustomerRow }).row;
  const save = async () => {
    const r = patchFrom(form, data.ceilings);
    if ('error' in r) return setErr(r.error);
    const turningOff = r.patch.adsEnabled === false && own.adsEnabled !== false;
    const on = row ? row.liveCampaigns : data.customers.reduce((s, c) => s + c.liveCampaigns, 0);
    const ok = await confirmAction({
      title: target.tag === '*' ? 'Change the defaults for everyone?' : `Change ${target.tag}’s ad limits?`,
      body: `${target.tag === '*' ? 'Every customer without their own value gets these.' : 'They take effect at once.'} Open reviews must be done again, and the change shows in ${target.tag === '*' ? 'each customer’s' : 'the customer’s'} ad activity.${turningOff && on ? ` ${on} campaign${on === 1 ? ' is' : 's are'} on: turning ads off doesn’t pause ${on === 1 ? 'it' : 'them'}. Use Pause all for that.` : ''}`,
      confirmLabel: 'Save limits',
    });
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      await putAdLimits(target.tag, r.patch);
      toast({ kind: 'success', title: 'Ad limits saved' });
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof AdsApiError ? e.message : 'The limits couldn’t be saved.');
    } finally {
      setBusy(false);
    }
  };
  const inherit = (k: keyof AdLimitsPatch) => (target.tag === '*' ? '' : `Default: ${data.defaults[k] ?? '–'}`);
  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      size="md"
      title={target.tag === '*' ? 'Default ad limits' : `Ad limits for ${target.tag}`}
      subtitle={target.tag === '*' ? 'Every customer without their own value gets these.' : 'Leave a field empty to use the default.'}
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save()}>
            {busy && <Spinner size={14} />} Save
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Launching ads" htmlFor="al-enabled" hint={inherit('adsEnabled')}>
          <Select
            id="al-enabled"
            value={form.adsEnabled as 'inherit' | 'on' | 'off'}
            onChange={(v) => setForm((f) => ({ ...f, adsEnabled: v }))}
            options={[...(target.tag === '*' ? [] : [{ value: 'inherit' as const, label: 'Use the default' }]), { value: 'on' as const, label: 'On' }, { value: 'off' as const, label: 'Off' }]}
          />
        </Field>
        <Field label="Currency of the limits" htmlFor="al-cur" hint={row?.otherCurrencies.length ? `A campaign in ${row.otherCurrencies.join(', ')} is on: pause it before changing the currency.` : inherit('adsCurrency') || 'Limits apply only to ad accounts in this currency.'}>
          <input id="al-cur" className="input font-mono" maxLength={3} value={form.adsCurrency} placeholder={target.tag === '*' ? 'USD' : ''} onChange={(e) => setForm((f) => ({ ...f, adsCurrency: e.target.value.toUpperCase() }))} />
        </Field>
        {FIELDS.map((f) => (
          <Field key={f.key} label={f.label} htmlFor={`al-${f.key}`} hint={inherit(f.key)}>
            <input id={`al-${f.key}`} inputMode="decimal" className="input num" value={form[f.key]} onChange={(e) => setForm((x) => ({ ...x, [f.key]: e.target.value }))} />
          </Field>
        ))}
      </div>
      <p className="mt-3 text-caption text-muted">
        Hard ceilings (Replit Secrets, can’t be raised here): {data.ceilings.maxDaily} a day (ADS_HARD_MAX_DAILY), {data.ceilings.maxChange} per launch or increase (ADS_HARD_MAX_CHANGE).
      </p>
      {err && <Callout tone="bad" className="mt-3">{err}</Callout>}
    </Modal>
  );
}

function PauseAll({ tag, onClose, onDone }: { tag: string; onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<LiveAdRow[] | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    previewPauseAll(tag)
      .then((r) => {
        setRows(r.campaigns);
        setToken(r.reviewToken ?? null);
      })
      .catch((e) => setErr(e instanceof AdsApiError ? e.message : 'The campaigns couldn’t be read.'));
  }, [tag]);
  const send = async () => {
    if (busy || !token) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await pauseAll(tag, token);
      toast({ kind: 'success', title: `Pausing ${r.jobs.length} campaign${r.jobs.length === 1 ? '' : 's'}`, body: r.skipped ? `${r.skipped} skipped (already changing, or ended).` : 'Each is sent once; the customer sees “Paused by the app owner”.' });
      onDone();
      onClose();
    } catch (e) {
      // no automatic retry: an uncertain answer is said as such
      setErr(e instanceof AdsApiError && e.uncertain ? 'The pauses may have been sent. It may have happened - check status before trying again (open the admin limits again to see what is still on).' : e instanceof AdsApiError ? e.message : 'Nothing was sent.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      persistent={busy}
      onClose={() => !busy && onClose()}
      size="md"
      title={`Pause all of ${tag}’s campaigns?`}
      subtitle="One pause per campaign, sent once each. It works with ads off and for blocked customers."
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger btn-sm" disabled={busy || !token || !rows?.length} onClick={() => void send()}>
            {busy ? <Spinner size={14} /> : <Pause />} Pause {rows?.length ?? ''} campaign{rows?.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      {!rows && !err && <Spinner />}
      {rows && rows.length === 0 && <p className="text-small text-muted">Nothing of theirs is switched on.</p>}
      {rows && rows.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-4 text-small text-ink">
          {rows.map((r) => (
            <li key={r.id}>{liveAdLine(r)}</li>
          ))}
        </ul>
      )}
      {err && <Callout tone={/may have/i.test(err) ? 'warn' : 'bad'} className="mt-3">{err}</Callout>}
    </Modal>
  );
}

export function AdsLimitsSection() {
  const [data, setData] = useState<AdminLimitsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Target | null>(null);
  const [pausing, setPausing] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await getAdminAdLimits());
      setErr(null);
    } catch (e) {
      setErr(e instanceof AdsApiError ? e.message : 'Ad limits couldn’t be read.');
    }
  }, []);
  useEffect(() => {
    if (!__ARTIFACT_BUILD__) void load();
  }, [load]);
  if (__ARTIFACT_BUILD__) return null;
  const d = data?.defaults;
  return (
    <SettingsSection
      title="Ad limits"
      description="What customers may launch and spend from the app on their own Meta and Google accounts. Pausing and ending are never limited."
      actions={
        data && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing({ tag: '*' })}>
            <Pencil /> Edit defaults
          </button>
        )
      }
    >
      <div className="flex flex-col gap-4 pb-4 pt-2">
        {err && <Callout tone="bad">{err}</Callout>}
        {!data && !err && <Spinner />}
        {data?.zernioAlert && (
          <Callout tone="warn" title="Ads need attention in Zernio">
            {zernioAlertText(data.zernioAlert.kind)} ({fmtRelative(data.zernioAlert.at)}). Customers see only that launching and changing ads isn’t available right now.
          </Callout>
        )}
        {data && !data.launchEnabled && <Callout tone="info">Launching, resuming and raising budgets are off for everyone (ADS_LAUNCH_ENABLED isn’t 1 in Replit Secrets). Pausing and ending still work.</Callout>}
        {d && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-small sm:grid-cols-4">
            <div>
              <dt className="text-muted">Launching</dt>
              <dd className="text-ink">{d.adsEnabled ? 'On' : 'Off'}</dd>
            </div>
            <div>
              <dt className="text-muted">Daily limit</dt>
              <dd className="num font-mono text-ink">{d.maxDaily != null ? money(d.maxDaily, d.adsCurrency ?? 'USD') : '–'}</dd>
            </div>
            <div>
              <dt className="text-muted">Per launch or increase</dt>
              <dd className="num font-mono text-ink">{d.maxChange != null ? money(d.maxChange, d.adsCurrency ?? 'USD') : '–'}</dd>
            </div>
            <div>
              <dt className="text-muted">Per campaign</dt>
              <dd className="num font-mono text-ink">{d.maxCampaignTotal != null ? money(d.maxCampaignTotal, d.adsCurrency ?? 'USD') : '–'}</dd>
            </div>
          </dl>
        )}
        {data && data.customers.length > 0 && (
          <section className="card overflow-x-auto" aria-label="Customers’ ad limits">
            <table className="w-full min-w-[760px] text-left text-small">
              <thead className="border-b border-line text-caption text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Customer</th>
                  <th className="px-2 py-2 font-medium">Launching</th>
                  <th className="px-2 py-2 text-right font-medium">Committed a day</th>
                  <th className="px-2 py-2 text-right font-medium">Limit a day</th>
                  <th className="px-2 py-2 text-right font-medium">Campaigns on</th>
                  <th className="px-2 py-2 font-medium">Last change</th>
                  <th className="px-2 py-2" aria-label="Actions" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.customers.map((c) => (
                  <tr key={c.tag}>
                    <td className="px-4 py-2.5 font-mono text-caption text-ink">{c.tag}</td>
                    <td className="px-2 py-2.5">
                      {c.effective.blocked ? <Badge tone="bad">Blocked</Badge> : c.effective.adsEnabled ? <Badge tone="good">On</Badge> : <Badge>Off</Badge>}
                      {c.own.adsEnabled == null && <span className="ml-1 text-caption text-muted">default</span>}
                    </td>
                    <td className="num px-2 py-2.5 text-right">{money(c.committedDaily, c.effective.currency)}</td>
                    <td className="num px-2 py-2.5 text-right">{money(c.effective.maxDaily, c.effective.currency)}</td>
                    <td className="num px-2 py-2.5 text-right">
                      {c.liveCampaigns}
                      {c.otherCurrencies.length > 0 && <span className="block text-caption text-warn">also {c.otherCurrencies.join(', ')}</span>}
                    </td>
                    <td className="px-2 py-2.5 text-caption text-muted">{c.lastChangeAt ? fmtRelative(c.lastChangeAt) : '–'}</td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-right">
                      <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEditing({ tag: c.tag, row: c })}>
                        <Pencil /> Limits
                      </button>
                      <button type="button" className="btn btn-ghost btn-xs" disabled={c.liveCampaigns === 0} onClick={() => setPausing(c.tag)}>
                        <Pause /> Pause all
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
      {editing && data && <EditLimits target={editing} data={data} onClose={() => setEditing(null)} onSaved={() => void load()} />}
      {pausing && <PauseAll tag={pausing} onClose={() => setPausing(null)} onDone={() => void load()} />}
    </SettingsSection>
  );
}
