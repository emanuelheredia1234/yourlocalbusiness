// Owner → Billing → Plans: turn plans on or off (the server says what's missing first), the optional card trial and
// the free days existing accounts get, and every account's plan, with "Grant free plan" and "Re-check with Stripe".
// Stripe ids show as …last4 only; keys never reach the app (the server shows the key's last 4 characters).

import { useCallback, useEffect, useState } from 'react';
import { Gift, RefreshCw } from 'lucide-react';
import type { BillingSettingsResponse, OwnerBillingAccount, PlanTier } from '@/lib/integrations/types';
import { IntegrationApiError, getBillingAccounts, getBillingSettings, putBillingSettings, putCompPlan, syncBillingAccount } from '@/lib/integrations/api';
import { tierName } from '@/lib/plans';
import { toast } from '@/store/ui';
import { useBillingOn } from '@/store/billing';
import { Badge, Callout, Field, Modal, MoreMenu, Select, SettingsRow, SettingsSection, Spinner, Toggle, confirmAction } from '@/components/ui/primitives';

const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '–');

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral' | 'primary'> = { active: 'good', trialing: 'primary', past_due: 'warn', unpaid: 'bad', canceled: 'neutral', expired: 'neutral', incomplete: 'warn', paused: 'warn' };

export function PlansAdminSection() {
  const on = useBillingOn();
  const [settings, setSettings] = useState<BillingSettingsResponse | null>(null);
  const [accounts, setAccounts] = useState<OwnerBillingAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [grant, setGrant] = useState<OwnerBillingAccount | null>(null);

  const load = useCallback(async () => {
    try {
      setSettings(await getBillingSettings());
      setAccounts((await getBillingAccounts().catch(() => ({ accounts: [] }))).accounts);
      setError(null);
    } catch (e) {
      setError(e instanceof IntegrationApiError ? e.message : 'Couldn’t read the plans settings.');
      if (e instanceof IntegrationApiError && e.hint) setHint(e.hint);
    }
  }, []);
  useEffect(() => {
    if (!__ARTIFACT_BUILD__) void load();
  }, [load]);

  if (__ARTIFACT_BUILD__) return null;

  const save = async (patch: { enforce?: boolean; cardTrialDays?: number; existingTrialDays?: number }) => {
    setSaving(true);
    setHint(null);
    try {
      const out = await putBillingSettings(patch);
      setSettings(out);
      if (patch.enforce === true) toast({ kind: 'success', title: 'Plans are on', ...(out.existingAccountsStarted != null ? { body: `${out.existingAccountsStarted} existing ${out.existingAccountsStarted === 1 ? 'account gets' : 'accounts get'} free days of Grow.` } : {}) });
      else if (patch.enforce === false) toast({ kind: 'success', title: 'Plans are off: nothing is gated' });
    } catch (e) {
      const err = e instanceof IntegrationApiError ? e : null;
      toast({ kind: 'error', title: err?.message ?? 'Couldn’t save.' });
      if (err?.hint) setHint(err.hint);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (v: boolean) => {
    const ok = await confirmAction(
      v
        ? { title: 'Turn on plans?', body: `Every account with a business gets ${settings?.settings.existingTrialDays ?? 30} days of Grow free, then needs a plan. New sign-ups set up their first business free, then choose a plan (with the card trial when it’s on). You can turn plans off again at any time.`, confirmLabel: 'Turn on plans' }
        : { title: 'Turn off plans?', body: 'Everything is ungated at once (as before plans). Nothing is deleted, and subscriptions in Stripe keep running.', confirmLabel: 'Turn off plans', danger: true },
    );
    if (ok) await save({ enforce: v });
  };

  const recheck = async (a: OwnerBillingAccount) => {
    try {
      await syncBillingAccount(a.customerTag);
      toast({ kind: 'success', title: `Re-checked ${a.email || a.customerTag}` });
      void load();
    } catch (e) {
      toast({ kind: 'error', title: e instanceof IntegrationApiError ? e.message : 'Couldn’t re-check.' });
    }
  };

  const s = settings;
  return (
    <SettingsSection title="Plans" description="Launch, Grow and Scale through Stripe. Nothing is gated until plans are on.">
      {error && <Callout tone="bad" className="my-3">{error}</Callout>}
      {hint && (
        <Callout tone="warn" className="my-3">
          {hint}
        </Callout>
      )}
      {!s ? (
        !error && (
          <p className="flex items-center gap-2 py-4 text-small text-muted" role="status">
            <Spinner size={14} /> Reading…
          </p>
        )
      ) : (
        <>
          <SettingsRow
            label="Plans are on"
            description={s.settings.enforce ? `On since ${fmtDate(s.settings.enforcedAt)}.` : s.missing.length ? `Add first: ${s.missing.join(', ')}.` : 'Ready to turn on.'}
            htmlFor="plans-enforce"
          >
            <Toggle id="plans-enforce" checked={s.settings.enforce} disabled={saving || !on} onChange={(v) => void toggle(v)} />
          </SettingsRow>
          <SettingsRow label="Stripe" description={s.stripe.mode ? `${s.stripe.mode === 'live' ? 'Live' : 'Test'} mode, key ${s.stripe.key ?? ''}; webhook secret ${s.stripe.webhookSecret ?? 'missing'}.` : 'No key yet (STRIPE_SECRET_KEY).'}>
            {s.stripe.prices ? (
              <Badge tone={Object.values(s.stripe.prices).every((v) => v === 'ok') ? 'good' : 'warn'}>
                {Object.values(s.stripe.prices).filter((v) => v === 'ok').length} of {Object.keys(s.stripe.prices).length} prices found
              </Badge>
            ) : (
              <span className="text-small text-muted">Prices not checked</span>
            )}
          </SettingsRow>
          <SettingsRow label="Card trial" description="Days a new sign-up tries their first plan, card taken at checkout, before the first charge (0 = off). One trial per person and card." htmlFor="plans-trial">
            <Select<string>
              id="plans-trial"
              value={String(s.settings.cardTrialDays)}
              onChange={(v) => void save({ cardTrialDays: Number(v) })}
              options={[0, 3, 7, 14].map((n) => ({ value: String(n), label: n ? `${n} days` : 'Off' }))}
            />
          </SettingsRow>
          <SettingsRow label="Free days for existing accounts" description="Grow, free, when plans are first turned on." htmlFor="plans-existing">
            <Select<string>
              id="plans-existing"
              value={String(s.settings.existingTrialDays)}
              onChange={(v) => void save({ existingTrialDays: Number(v) })}
              options={[0, 14, 30, 60, 90].map((n) => ({ value: String(n), label: n ? `${n} days` : 'None' }))}
            />
          </SettingsRow>
          <div className="-mx-5 mt-2 overflow-x-auto border-t border-line">
            <table className="w-full min-w-[760px] text-left text-small">
              <thead>
                <tr className="border-b border-line text-muted">
                  {['Customer', 'Plan', 'Status', 'Businesses', 'Renews', 'Grace until', 'Free until', 'Data kept until', ''].map((h) => (
                    <th key={h} scope="col" className="px-4 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(accounts ?? []).map((a) => (
                  <tr key={a.customerTag} className="border-b border-line last:border-b-0">
                    <td className="max-w-[220px] truncate px-4 py-2 text-ink" title={a.email || a.customerTag}>
                      {a.email || <span className="font-mono text-caption">{a.customerTag}</span>}
                      {a.stripeCustomer && <span className="ml-1 font-mono text-caption text-muted">{a.stripeCustomer}</span>}
                    </td>
                    <td className="px-4 py-2 text-ink">
                      {tierName(a.tier)}
                      {a.interval ? ` · ${a.interval === 'year' ? 'yearly' : 'monthly'}` : ''}
                      {a.source === 'comp' ? ' (free)' : ''}
                    </td>
                    <td className="px-4 py-2">
                      <Badge tone={STATUS_TONE[a.status] ?? 'neutral'}>{a.cancelAtPeriodEnd ? 'cancelling' : a.status.replace('_', ' ')}</Badge>
                    </td>
                    <td className="num px-4 py-2 text-ink">{a.businessLimit ?? '∞'}</td>
                    <td className="px-4 py-2 text-ink-2">{a.trialEndsAt ? `Trial ends ${fmtDate(a.trialEndsAt)}` : fmtDate(a.currentPeriodEnd)}</td>
                    <td className="px-4 py-2 text-ink-2">{fmtDate(a.graceUntil)}</td>
                    <td className="px-4 py-2 text-ink-2">{fmtDate(a.compUntil)}</td>
                    <td className="px-4 py-2 text-ink-2">{fmtDate(a.dataExpiresAt)}</td>
                    <td className="px-4 py-2 text-right">
                      {a.source !== 'owner' && (
                        <MoreMenu
                          label={`Actions for ${a.email || a.customerTag}`}
                          items={[
                            { label: 'Grant free plan', icon: <Gift />, onSelect: () => setGrant(a) },
                            { label: 'Re-check with Stripe', icon: <RefreshCw />, onSelect: () => void recheck(a), disabled: !a.stripeCustomer },
                          ]}
                        />
                      )}
                    </td>
                  </tr>
                ))}
                {accounts && !accounts.length && (
                  <tr>
                    <td colSpan={9} className="px-4 py-4 text-muted">
                      No accounts with a plan yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
      <GrantDialog account={grant} onClose={() => setGrant(null)} onDone={() => void load()} />
    </SettingsSection>
  );
}

function GrantDialog({ account, onClose, onDone }: { account: OwnerBillingAccount | null; onClose: () => void; onDone: () => void }) {
  const [tier, setTier] = useState<PlanTier | 'none'>('grow');
  const [extra, setExtra] = useState('0');
  const [until, setUntil] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  if (!account) return null;
  const submit = async () => {
    const n = Number(extra);
    if (!Number.isInteger(n) || n < 0 || n > 100) return toast({ kind: 'error', title: 'Extra businesses: a whole number from 0 to 100.' });
    setBusy(true);
    try {
      await putCompPlan(account.customerTag, tier === 'none' ? { tier: 'none' } : { tier, extraBusinesses: n, until: until ? new Date(`${until}T23:59:59Z`).toISOString() : null, ...(note.trim() ? { note: note.trim() } : {}) });
      toast({ kind: 'success', title: tier === 'none' ? 'Free plan ended' : `Granted ${tierName(tier)}` });
      onDone();
      onClose();
    } catch (e) {
      toast({ kind: 'error', title: e instanceof IntegrationApiError ? e.message : 'Couldn’t grant that.' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Grant a free plan"
      subtitle={account.email || account.customerTag}
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void submit()}>
            {busy && <Spinner size={14} />} {tier === 'none' ? 'End free plan' : 'Grant'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Plan" htmlFor="grant-tier">
          <Select<string>
            id="grant-tier"
            value={tier}
            onChange={(v) => setTier(v as PlanTier | 'none')}
            options={[
              { value: 'launch', label: 'Launch' },
              { value: 'grow', label: 'Grow' },
              { value: 'scale', label: 'Scale' },
              { value: 'none', label: 'End the free plan' },
            ]}
          />
        </Field>
        {tier !== 'none' && (
          <>
            <Field label="Extra businesses" htmlFor="grant-extra">
              <input id="grant-extra" className="input" inputMode="numeric" value={extra} onChange={(e) => setExtra(e.target.value)} />
            </Field>
            <Field label="Until" hint="Empty: no end." htmlFor="grant-until">
              <input id="grant-until" type="date" className="input" value={until} onChange={(e) => setUntil(e.target.value)} />
            </Field>
            <Field label="Note (only you see it)" htmlFor="grant-note">
              <input id="grant-note" className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}
