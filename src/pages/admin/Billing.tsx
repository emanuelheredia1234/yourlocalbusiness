// The owner's per-customer usage (route admin-billing, linked from Settings for the owner only): what each
// customer's analytics cost (treg), their social posting (Upload-Post: one profile per business, their connected
// accounts, calls and the profile estimates) and ad accounts (Zernio) side by side, Upload-Post profiles used of the
// plan's 75 overall and per customer, their caps (edit, block, reset), the check of our ledger
// against treg's own totals, and a CSV to bill from. The server answers all of it to admins only; this page
// charges nothing. Team-level provider alerts show as plain words, never amounts or links.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, CircleCheck, Download, Pencil, Receipt, RefreshCw, RotateCcw } from 'lucide-react';
import type { CapSettings, CustomerUsageRow, CustomersResponse, ReconcileReport } from '@/lib/integrations/types';
import { IntegrationApiError, getCustomers, getReconcile, putCustomerCap, putDefaults } from '@/lib/integrations/api';
import { serverFetch } from '@/ai/claude';
import { serverBaseNow } from '@/lib/cloud/auth';
import { fmtRelative } from '@/lib/utils';
import { toast } from '@/store/ui';
import { download } from '@/components/ui/download';
import { Badge, Callout, Empty, Field, InfoTip, Modal, MoreMenu, PageHeader, Select, SettingsSection, Skeleton, Spinner, StatStrip, confirmAction, type MenuEntry } from '@/components/ui/primitives';

/** USD from integer micros, 2 decimals (4 under a cent). */
export function usd(micro: number | null | undefined): string {
  const n = (typeof micro === 'number' && Number.isFinite(micro) ? micro : 0) / 1e6;
  return `$${Math.abs(n) > 0 && Math.abs(n) < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}
const toMicro = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t.replace(/^\$/, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6) : NaN;
};
const fromMicro = (m: number | null | undefined) => (typeof m === 'number' ? String(m / 1e6) : '');

/** The last 12 months, newest first (YYYY-MM). */
export function recentMonths(now = new Date(), n = 12): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

type Data = CustomersResponse;

/** Upload-Post's team-level alerts, in plain words for the owner (customers only ever saw "temporarily unavailable"). */
export const UPLOAD_POST_ALERTS: Record<string, string> = {
  profile_cap: 'Upload-Post’s profile limit is reached: new customers can’t connect social accounts. Add the +25 or +50 profile add-on in the Upload-Post dashboard.',
  profile_cap_low: 'Upload-Post profiles are running low. Add the +25 or +50 profile add-on before new customers are turned away.',
  profile_refused: 'Upload-Post refused to make a new business profile (not the plan’s limit), so new businesses can’t connect social accounts. Check the plan and the API key in the Upload-Post dashboard, and the server log for the error code.',
  profile_blocked: 'Upload-Post blocked a customer profile over the plan’s limits. Check the plan and profile count in the Upload-Post dashboard.',
  scheduled_limit: 'Upload-Post’s limit on pending scheduled posts was reached. Check the scheduled posts in the Upload-Post dashboard.',
  analytics_limit: 'Upload-Post’s analytics limit was reached, so some social stats are waiting. They catch up on the next Update.',
  auth: 'Upload-Post refused the API key, so social posting is paused. Check UPLOAD_POST_API_KEY in Replit Secrets.',
  rate_lockout: 'Upload-Post is turning requests away for a few minutes (too many at once, or a wrong key). Check UPLOAD_POST_API_KEY in Replit Secrets if it keeps happening.',
  plan: 'Upload-Post refused a post over the plan’s limits. Check the plan in the Upload-Post dashboard.',
  media_secret: 'Photo and video posts can’t go out: MEDIA_URL_SECRET isn’t set. Add it (32+ random bytes) in Replit Secrets.',
  profile_budget: 'More new customers started connecting social accounts today than UPLOAD_POST_NEW_PROFILES_PER_DAY allows. Check they’re real, then raise it if they are.',
  x_links: 'Upload-Post took links out of X posts: the X Links allowance (50 a month for everyone) is used up, or the add-on is off.',
  x_links_low: 'The X Links allowance (50 link posts a month for every customer together) is nearly used up.',
  profile_orphans: 'Upload-Post has profiles named ylb_ that no customer’s business here owns (another copy of the app on the same key, or another database). They were left alone; delete them in the Upload-Post dashboard if they’re yours to remove.',
  profile_user_cap: 'A customer reached their limit of businesses with social accounts (UPLOAD_POST_MAX_PROFILES_PER_USER). Raise it in Replit Secrets if they need more.',
};

export default function Billing() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [month, setMonth] = useState(() => recentMonths()[0]);
  const [downloading, setDownloading] = useState(false);
  const [editing, setEditing] = useState<CustomerUsageRow | 'defaults' | null>(null);

  const load = useCallback(async () => {
    try {
      setData((await getCustomers(30)) as Data);
      setError(null);
    } catch (e) {
      setError(e instanceof IntegrationApiError ? { code: e.code, message: e.message } : { code: 'UNAVAILABLE', message: 'Couldn’t load customer usage.' });
    }
  }, []);
  useEffect(() => {
    if (!__ARTIFACT_BUILD__) void load();
  }, [load]);

  const check = async () => {
    setChecking(true);
    try {
      setReport(await getReconcile(30));
    } catch (e) {
      toast({ title: 'Couldn’t check the totals', body: e instanceof Error ? e.message : undefined, kind: 'error' });
    } finally {
      setChecking(false);
    }
  };

  const csv = async () => {
    setDownloading(true);
    try {
      const res = await serverFetch(serverBaseNow(), `/api/billing/invoice.csv?month=${encodeURIComponent(month)}`, { method: 'GET' });
      if (!res.ok) throw new Error('The CSV isn’t available right now.');
      await download(`usage-${month}.csv`, await res.blob());
    } catch (e) {
      toast({ title: 'Couldn’t download the CSV', body: e instanceof Error ? e.message : undefined, kind: 'error' });
    } finally {
      setDownloading(false);
    }
  };

  if (__ARTIFACT_BUILD__) {
    return (
      <div>
        <PageHeader className="mb-4" title="Customer usage" />
        <Empty icon={<Receipt />} title="Customer usage needs the full app" body="It reads usage from your server, which this version doesn’t have." />
      </div>
    );
  }

  const header = (
    <PageHeader
      className="mb-4"
      title="Customer usage"
      description={
        <span className="inline-flex flex-wrap items-center gap-1">
          What each customer’s analytics cost, to bill from.
          <InfoTip label="About this page" title="About this page">
            This page tracks usage. It doesn’t charge cards. Billing customers is done outside the app for now.
          </InfoTip>
        </span>
      }
      actions={
        data ? (
          <>
            <button type="button" className="btn btn-secondary btn-sm" disabled={checking} onClick={() => void check()}>
              {checking ? <Spinner size={14} /> : <RefreshCw />}
              Check against treg
            </button>
            <Select size="sm" className="w-44" aria-label="Month" value={month} onChange={setMonth} options={recentMonths().map((m) => ({ value: m, label: monthLabel(m) }))} />
            <button type="button" className="btn btn-primary btn-sm" disabled={downloading} onClick={() => void csv()}>
              {downloading ? <Spinner size={14} /> : <Download />}
              Download CSV
            </button>
          </>
        ) : undefined
      }
    />
  );

  if (error) {
    return (
      <div>
        {header}
        {error.code === 'FORBIDDEN' || error.code === 'AUTH_REQUIRED' ? (
          <Empty icon={<Receipt />} title="For the app’s owner only" body="Customer usage is shown to the owner’s account." />
        ) : (
          <Callout
            tone="bad"
            action={
              <button type="button" className="btn btn-secondary btn-xs" onClick={() => void load()}>
                Try again
              </button>
            }
          >
            {error.message}
          </Callout>
        )}
      </div>
    );
  }
  if (!data) {
    return (
      <div>
        {header}
        <div className="flex flex-col gap-4" aria-label="Loading">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }
  return (
    <div>
      {header}
      <BillingView data={data} report={report} onEdit={setEditing} onChanged={() => void load()} />
      {editing && <CapModal target={editing} defaults={data.defaults} onClose={() => setEditing(null)} onSaved={() => void load()} />}
    </div>
  );
}

/** Everything under the header (rendered in tests with fixed data). */
export function BillingView({ data, report, onEdit, onChanged }: { data: Data; report: ReconcileReport | null; onEdit: (t: CustomerUsageRow | 'defaults') => void; onChanged: () => void }) {
  const rows = data.customers;
  const totals = useMemo(
    () => ({
      cost: rows.reduce((s, r) => s + (r.costMicro || 0), 0),
      estimated: rows.reduce((s, r) => s + (r.estimatedMicro || 0), 0),
      active: rows.filter((r) => r.calls > 0 || r.costMicro > 0).length,
      blocked: rows.filter((r) => r.status === 'blocked').length,
    }),
    [rows],
  );
  const d = data.defaults;
  return (
    <div className="flex flex-col gap-6">
      {data.alert && <Callout tone="warn">Analytics provider needs attention (billing). Check the provider’s balance and plan.</Callout>}
      {data.uploadPostAlert && (
        <Callout tone="warn" title="Social posting needs attention">
          {UPLOAD_POST_ALERTS[data.uploadPostAlert.kind] ?? 'Upload-Post reported a problem with the plan or key. Check the Upload-Post dashboard.'}
          {data.uploadPostAlert.customerTag ? ` Customer ${data.uploadPostAlert.customerTag}.` : ''}
          {data.uploadPostAlert.at && !Number.isNaN(Date.parse(data.uploadPostAlert.at)) ? ` (${fmtRelative(data.uploadPostAlert.at)})` : ''}
        </Callout>
      )}
      {report && <ReconcileCallout report={report} />}
      <StatStrip
        items={[
          { label: 'Total', value: usd(totals.cost), sub: 'Last 30 days' },
          { label: 'Customers active', value: totals.active },
          { label: 'Blocked', value: totals.blocked },
          { label: 'Estimated connection costs', value: usd(totals.estimated), info: 'Estimates for social profiles (Upload-Post’s plan price per profile) and connected ad accounts (Zernio). They never count toward a cap.' },
          ...(data.upProfiles
            ? [
                {
                  label: 'Upload-Post profiles',
                  value: data.upProfiles.limit ? `${data.upProfiles.used} / ${data.upProfiles.limit}` : String(data.upProfiles.used),
                  info: `One profile per business that connected social accounts${data.upProfiles.perCustomer ? ` (each customer up to ${data.upProfiles.perCustomer} businesses, UPLOAD_POST_MAX_PROFILES_PER_USER)` : ''}. The Advanced plan has 75; add-ons give +25 ($65 a month) or +50 ($115 a month), and they don’t stack.`,
                },
              ]
            : []),
        ]}
      />
      <section className="card overflow-x-auto" aria-label="Customers">
        {rows.length === 0 ? (
          <Empty icon={<Receipt />} title="No customers yet" body="Customers appear here after their first analytics Update." />
        ) : (
          <table className="w-full min-w-[880px] text-left text-small">
            <caption className="sr-only">Customers</caption>
            <thead className="border-b border-line text-caption text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-2 py-2 text-right font-medium">Today</th>
                <th className="px-2 py-2 text-right font-medium">30 days</th>
                <th className="px-2 py-2 text-right font-medium">Analytics calls</th>
                <th className="px-2 py-2 text-right font-medium">Social (Upload-Post)</th>
                <th className="px-2 py-2 text-right font-medium">Ads (Zernio)</th>
                <th className="px-2 py-2 font-medium">Cap (day / month)</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="w-12 px-2 py-2" aria-label="Actions" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <CustomerRow key={r.customerTag} row={r} defaults={d} onEdit={() => onEdit(r)} onChanged={onChanged} />
              ))}
            </tbody>
          </table>
        )}
      </section>
      <SettingsSection
        title="Default caps"
        description="Every customer without their own cap gets these."
        actions={
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onEdit('defaults')}>
            <Pencil /> Edit
          </button>
        }
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 pb-4 pt-2 text-small sm:grid-cols-4">
          <div>
            <dt className="text-muted">Per day</dt>
            <dd className="num font-mono text-ink">{usd(d.dailyCapMicro ?? 0)}</dd>
          </div>
          <div>
            <dt className="text-muted">Per month</dt>
            <dd className="num font-mono text-ink">{usd(d.monthlyCapMicro ?? 0)}</dd>
          </div>
          <div>
            <dt className="text-muted">Calls per day</dt>
            <dd className="num font-mono text-ink">{d.callsPerDay ?? '–'}</dd>
          </div>
          <div>
            <dt className="text-muted">Synced</dt>
            <dd className="text-ink">{d.syncedToTreg === false ? <Badge tone="warn">Not synced</Badge> : 'Yes'}</dd>
          </div>
        </dl>
      </SettingsSection>
    </div>
  );
}

export function ReconcileCallout({ report }: { report: ReconcileReport }) {
  const ok = report.treg.sumOk && report.unattributedOk && report.mismatches === 0;
  if (ok)
    return (
      <Callout tone="good">
        Ledger matches treg: attributed + unattributed = total ({usd(report.treg.totalMicro)}). Checked {fmtRelative(report.checkedAt)}.
      </Callout>
    );
  return (
    <Callout tone="bad" title="The ledger doesn’t match">
      {report.mismatches} customer{report.mismatches === 1 ? '' : 's'} differ{report.mismatches === 1 ? 's' : ''}; unattributed {usd(report.treg.unattributedMicro)}
      {!report.treg.sumOk ? '; the provider’s own totals don’t add up' : ''}.{report.pending && report.pending.length ? ` ${report.pending.length} call${report.pending.length === 1 ? ' is' : 's are'} still settling.` : ''}
    </Callout>
  );
}

function CustomerRow({ row, defaults, onEdit, onChanged }: { row: CustomerUsageRow; defaults: CapSettings; onEdit: () => void; onChanged: () => void }) {
  const daily = row.caps.dailyCapMicro ?? defaults.dailyCapMicro;
  const monthly = row.caps.monthlyCapMicro ?? defaults.monthlyCapMicro;
  const custom = row.caps.dailyCapMicro != null || row.caps.monthlyCapMicro != null || row.caps.callsPerDay != null;
  const put = async (cap: CapSettings, done: string) => {
    try {
      await putCustomerCap(row.customerTag, cap);
      toast({ title: done, kind: 'success' });
      onChanged();
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e instanceof Error ? e.message : undefined, kind: 'error' });
    }
  };
  const who = row.email || row.customerTag;
  const items: MenuEntry[] = [
    { label: 'Edit cap', icon: <Pencil />, onSelect: onEdit },
    row.status === 'blocked'
      ? { label: 'Unblock', icon: <CircleCheck />, onSelect: () => void confirmAction({ title: `Unblock ${who}?`, body: 'Their analytics updates work again.', confirmLabel: 'Unblock' }).then((ok) => (ok ? put({ status: 'active' }, 'Unblocked') : undefined)) }
      : { label: 'Block', icon: <Ban />, danger: true, onSelect: () => void confirmAction({ title: `Block ${who}?`, body: 'Their analytics updates stop until you unblock them. Posting and drafts keep working.', confirmLabel: 'Block', danger: true }).then((ok) => (ok ? put({ status: 'blocked' }, 'Blocked') : undefined)) },
    ...(custom ? [{ label: 'Reset to default', icon: <RotateCcw />, onSelect: () => void put({ dailyCapMicro: null, monthlyCapMicro: null, callsPerDay: null }, 'Back to the default caps') }] : []),
    ...(row.syncedToTreg === false ? [{ label: 'Sync', icon: <RefreshCw />, onSelect: () => void put({ ...row.caps, status: row.status }, 'Synced') }] : []),
  ];
  return (
    <tr className="transition-colors duration-120 hover:bg-surface-2">
      <td className="max-w-[260px] px-4 py-2">
        <span className="block truncate text-ink">{row.email || 'No email'}</span>
        <span className="num block truncate font-mono text-caption text-muted">
          {row.customerTag}
          {row.lastActivityAt ? ` · ${fmtRelative(row.lastActivityAt)}` : ''}
        </span>
      </td>
      <td className="num px-2 py-2 text-right font-mono text-ink-2">{usd(row.todayMicro)}</td>
      <td className="num px-2 py-2 text-right font-mono text-ink-2">
        {usd(row.costMicro)}
        {row.estimatedMicro > 0 && <span className="block text-caption text-muted">+{usd(row.estimatedMicro)} est.</span>}
      </td>
      <td className="num px-2 py-2 text-right font-mono text-ink-2">{row.calls}</td>
      <VendorCell accounts={row.socialAccounts} profiles={row.socialProfiles} usage={row.vendors?.uploadpost} calls title="Social accounts connected now (all their businesses), Upload-Post profiles in use (one per business), calls in the period and the estimated profile cost" />
      <VendorCell accounts={row.adAccounts} usage={row.vendors?.zernio} title="Ad accounts connected now and the estimated cost (Zernio bills per connected ad account)" />
      <td className="num px-2 py-2 font-mono text-caption text-ink-2">
        {usd(daily ?? 0)} / {usd(monthly ?? 0)}
        {custom && <Badge className="ml-1.5">Own</Badge>}
      </td>
      <td className="px-2 py-2">
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={row.status === 'blocked' ? 'bad' : 'good'}>{row.status === 'blocked' ? 'Blocked' : 'Active'}</Badge>
          {row.syncedToTreg === false && <Badge tone="warn">Not synced</Badge>}
        </span>
      </td>
      <td className="px-2 py-2 text-right">
        <MoreMenu label={`Actions for ${who}`} items={items} size="xs" />
      </td>
    </tr>
  );
}

/**
 * One vendor's cell: accounts connected now, then the profiles in use (Upload-Post: one per business), calls and the
 * estimate (an older server: the combined count only).
 */
export function VendorCell({ accounts, profiles, usage, calls, title }: { accounts?: number; profiles?: number; usage?: { costMicro: number; estimatedMicro: number; calls: number }; calls?: boolean; title: string }) {
  const extra = [typeof profiles === 'number' && profiles > 0 ? `${profiles} profile${profiles === 1 ? '' : 's'}` : '', calls && usage && usage.calls > 0 ? `${usage.calls} call${usage.calls === 1 ? '' : 's'}` : '', usage && usage.estimatedMicro > 0 ? `+${usd(usage.estimatedMicro)} est.` : ''].filter(Boolean).join(' · ');
  return (
    <td className="num px-2 py-2 text-right font-mono text-ink-2" title={title}>
      {typeof accounts === 'number' ? `${accounts} acct${accounts === 1 ? '' : 's'}` : '–'}
      {extra && <span className="block text-caption text-muted">{extra}</span>}
    </td>
  );
}

function CapModal({ target, defaults, onClose, onSaved }: { target: CustomerUsageRow | 'defaults'; defaults: CapSettings; onClose: () => void; onSaved: () => void }) {
  const isDefaults = target === 'defaults';
  const start = isDefaults ? defaults : target.caps;
  const [daily, setDaily] = useState(fromMicro(start.dailyCapMicro));
  const [monthly, setMonthly] = useState(fromMicro(start.monthlyCapMicro));
  const [calls, setCalls] = useState(start.callsPerDay != null ? String(start.callsPerDay) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const d = toMicro(daily);
    const m = toMicro(monthly);
    const c = calls.trim() ? Number(calls) : null;
    if (Number.isNaN(d) || Number.isNaN(m) || (c !== null && (!Number.isInteger(c) || c < 0))) {
      setError('Use amounts in USD (like 0.25) and a whole number of calls.');
      return;
    }
    setSaving(true);
    try {
      const cap: CapSettings = { dailyCapMicro: d, monthlyCapMicro: m, callsPerDay: c };
      if (isDefaults) await putDefaults(cap);
      else await putCustomerCap(target.customerTag, cap);
      toast({ title: 'Cap saved', kind: 'success' });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t save.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={isDefaults ? 'Default caps' : `Cap for ${target.email || target.customerTag}`}
      subtitle={isDefaults ? 'For every customer without their own cap.' : 'Leave a field empty to use the default.'}
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
            {saving && <Spinner size={14} />}
            Save
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Per day (USD)" htmlFor="cap-daily">
          <input id="cap-daily" className="input" inputMode="decimal" value={daily} placeholder={isDefaults ? '' : fromMicro(defaults.dailyCapMicro)} onChange={(e) => setDaily(e.target.value)} />
        </Field>
        <Field label="Per month (USD)" htmlFor="cap-monthly">
          <input id="cap-monthly" className="input" inputMode="decimal" value={monthly} placeholder={isDefaults ? '' : fromMicro(defaults.monthlyCapMicro)} onChange={(e) => setMonthly(e.target.value)} />
        </Field>
        <Field label="Calls per day" htmlFor="cap-calls">
          <input id="cap-calls" className="input" inputMode="numeric" value={calls} placeholder={isDefaults ? '' : defaults.callsPerDay != null ? String(defaults.callsPerDay) : ''} onChange={(e) => setCalls(e.target.value)} />
        </Field>
        {error && (
          <p role="alert" className="text-small text-bad">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
