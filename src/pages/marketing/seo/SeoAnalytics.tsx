// SEO page › Analytics: whether Google knows the page (Submit to Google, one confirmed press, steps never
// retried by the app), Search Console clicks and impressions for this page only, and where it ranks for the
// keywords you track (Google and Maps).
import { useCallback, useEffect, useState } from 'react';
import { Globe, KeyRound, Search } from 'lucide-react';
import type { Project } from '@/lib/types';
import type { SeoData, SeoGoogleStatus, SeoPublishResult } from '@/lib/integrations/types';
import { IntegrationApiError, getSeoGoogleStatus, publishSeoToGoogle } from '@/lib/integrations/api';
import { fmtDate } from '@/lib/utils';
import { useAnalytics } from '@/store/analytics';
import { toast } from '@/store/ui';
import { AreaChart, ChartCard } from '@/components/charts/Charts';
import { Callout, ChipInput, CopyButton, Drawer, Empty, Field, InfoTip, Segmented, Spinner, StatStrip, StatusDot, confirmAction } from '@/components/ui/primitives';
import { AnalyticsShell, DataTable } from '../analytics/AnalyticsShell';
import { inRange, pct, rankLabel } from '../analytics/compute';
import { openConnectedAccounts } from '../analytics/links';

const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–');

const VERDICT: Record<string, string> = { PASS: 'Indexed', PARTIAL: 'Indexed with issues', FAIL: 'Not indexed', NEUTRAL: 'Not indexed yet', VERDICT_UNSPECIFIED: 'Not checked yet' };

export function SeoAnalytics({ project }: { project: Project }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      {!__ARTIFACT_BUILD__ && <GoogleCard project={project} />}
      <AnalyticsShell<SeoData>
        project={project}
        source="seo"
        label="SEO analytics"
        metered
        meteredNote="Rankings are public search results, refreshed when you press Update."
        actions={
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
            <KeyRound /> Keywords
          </button>
        }
        empty={
          <Empty
            icon={<Search />}
            title="No rankings yet"
            body="Add the keywords people search for, then press Update on the Marketing page."
            action={
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
                Add keywords
              </button>
            }
          />
        }
      >
        {(snap, range) => <SeoBody data={snap.data} range={range} />}
      </AnalyticsShell>
      {editing && <KeywordsDrawer project={project} onClose={() => setEditing(false)} />}
    </div>
  );
}

export function SeoBody({ data, range, now }: { data: SeoData; range: number; now?: number }) {
  const [metric, setMetric] = useState<'clicks' | 'impressions'>('clicks');
  const keywords = Array.isArray(data?.keywords) ? data.keywords : [];
  const gsc = data?.gsc;
  const series = (gsc?.series ?? []).filter((s) => inRange(s.date, range, now));
  return (
    <div className="flex flex-col gap-4">
      {gsc ? (
        <>
          <StatStrip
            items={[
              { label: 'Clicks', value: n(gsc.clicks), sub: 'Last 28 days' },
              { label: 'Impressions', value: n(gsc.impressions) },
              { label: 'Avg position', value: gsc.position ? gsc.position.toFixed(1) : '–' },
              { label: 'CTR', value: pct(gsc.ctr) },
            ]}
          />
          <p className="-mt-2 text-caption text-muted">Google data is about 2 days behind.</p>
          <ChartCard
            title={metric === 'clicks' ? 'Clicks per day' : 'Impressions per day'}
            subtitle={`From Google, last ${range} days`}
            action={
              <Segmented
                size="sm"
                aria-label="Metric"
                value={metric}
                onChange={setMetric}
                options={[
                  { id: 'clicks', label: 'Clicks' },
                  { id: 'impressions', label: 'Impressions' },
                ]}
              />
            }
            table={{ columns: ['Date', 'Clicks', 'Impressions'], rows: series.map((s) => [fmtDate(s.date), s.clicks, s.impressions]) }}
          >
            {series.length ? <AreaChart data={series.map((s) => ({ x: s.date, y: s[metric] }))} label={metric === 'clicks' ? 'Clicks' : 'Impressions'} /> : <p className="py-6 text-center text-small text-muted">No search data in this range yet.</p>}
          </ChartCard>
        </>
      ) : (
        <p className="text-small text-muted">Clicks and impressions from Google show once the page is submitted and Google has data (usually a few days).</p>
      )}
      {keywords.length > 0 ? (
        <DataTable
          caption="Keywords"
          columns={['Keyword', 'Google', 'Maps', 'Searches a month']}
          align={['left', 'right', 'right', 'right']}
          rows={keywords.map((k) => [k.keyword, rankLabel(k.rank), typeof k.mapsPosition === 'number' && k.mapsPosition > 0 ? `#${k.mapsPosition}` : '–', n(k.volume)])}
        />
      ) : (
        <p className="text-small text-muted">No keywords tracked yet.</p>
      )}
      {data?.authority && (
        <StatStrip
          items={[
            { label: 'Authority', value: n(data.authority.score), sub: `As of ${fmtDate(data.authority.fetchedAt)}` },
            { label: 'Sites linking to you', value: n(data.authority.referringDomains) },
            { label: 'Backlinks', value: n(data.authority.backlinks) },
          ]}
        />
      )}
    </div>
  );
}

/** The page on Google: not submitted / submitted / indexed, and the one filled button in this panel. */
function GoogleCard({ project }: { project: Project }) {
  const [status, setStatus] = useState<SeoGoogleStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SeoPublishResult | null>(null);
  const load = useCallback(async () => {
    try {
      setStatus((await getSeoGoogleStatus(project.id)).status);
      setError(null);
    } catch (e) {
      setError(e instanceof IntegrationApiError ? e.message : 'Couldn’t check Google.');
    }
  }, [project.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    const ok = await confirmAction({
      title: 'Submit this page to Google?',
      body: 'Google is told about your page once. Google decides when to index it, usually days to weeks.',
      confirmLabel: 'Submit to Google',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { result } = await publishSeoToGoogle(project.id);
      setResult(result);
      const unsure = result.steps.some((s) => s.outcome === 'unknown');
      toast({ title: unsure ? 'Sent, but Google didn’t confirm' : 'Submitted to Google', body: unsure ? 'Check the status here later before pressing again.' : 'Google decides when to index it, usually days to weeks.', kind: unsure ? 'info' : 'success' });
      await load();
    } catch (e) {
      const err = e instanceof IntegrationApiError ? e : null;
      toast({ title: 'Not submitted', body: err?.code === 'INSPECTION_QUOTA' ? 'Google’s daily check limit is used up. Try again tomorrow.' : err?.message ?? 'Try again shortly.', kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const dns = result?.dnsRecord;
  const verdict = status?.verdict ? VERDICT[status.verdict] ?? status.verdict : null;
  const state = !status?.published
    ? { tone: 'faint' as const, text: 'Not published' }
    : verdict && status.verdict === 'PASS'
      ? { tone: 'good' as const, text: 'Indexed' }
      : status.submittedAt
        ? { tone: 'primary' as const, text: `Submitted ${fmtDate(status.submittedAt)}` }
        : { tone: 'faint' as const, text: 'Not submitted' };
  const needsConnect = status?.host === 'custom' && status.connected === false;

  return (
    <section className="card p-4 sm:p-5" aria-label="Google">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1 text-h3 text-ink">
            Google
            <InfoTip label="About submitting" title="About submitting">
              Submitting tells Google the page exists. There’s no way to make Google index a page right away: it decides when, usually days to weeks.
            </InfoTip>
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-muted">
            {status ? <StatusDot tone={state.tone}>{state.text}</StatusDot> : !error && <Spinner size={14} />}
            {status?.coverageState && <span>{status.coverageState}</span>}
            {status?.lastCrawlTime && <span>Last crawled {fmtDate(status.lastCrawlTime)}</span>}
          </div>
        </div>
        {status?.published && !needsConnect && (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void submit()}>
            {busy ? <Spinner size={14} /> : <Globe />}
            {dns ? 'Verify and submit' : 'Submit to Google'}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-small text-bad">
          {error}
        </p>
      )}
      {status && !status.published && <p className="mt-3 text-small text-muted">Publish the page first (on the Page tab), then submit it here.</p>}
      {needsConnect && (
        <Callout
          tone="info"
          className="mt-3"
          action={
            <button type="button" className="btn btn-secondary btn-xs" onClick={openConnectedAccounts}>
              Connect
            </button>
          }
        >
          Your page is on your own domain. Connect Google Search Console to submit it.
        </Callout>
      )}
      {dns && (
        <div className="mt-4 rounded-md border border-line p-3">
          <p className="text-small text-ink-2">Add this TXT record at your DNS host, then press Verify and submit.</p>
          <dl className="mt-2 grid grid-cols-1 gap-2 text-small sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-muted">Name</dt>
            <dd className="num truncate font-mono text-ink">{dns.name}</dd>
            <dt className="text-muted">Value</dt>
            <dd className="flex min-w-0 items-center gap-2">
              <span className="num min-w-0 truncate font-mono text-ink">{dns.value}</span>
              <CopyButton text={dns.value} size="xs" />
            </dd>
          </dl>
        </div>
      )}
      {result && result.steps.some((s) => s.outcome === 'unknown') && (
        <Callout tone="warn" className="mt-3">
          Google didn’t confirm one step. It may have gone through: the status above updates once Google answers.
        </Callout>
      )}
    </section>
  );
}

function KeywordsDrawer({ project, onClose }: { project: Project; onClose: () => void }) {
  const saved = useAnalytics((s) => s.settings[project.id]);
  const [keywords, setKeywords] = useState<string[] | null>(null);
  const [city, setCity] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void useAnalytics.getState().loadSettings(project.id);
  }, [project.id]);
  const kw = keywords ?? saved?.keywords ?? [];
  const placeCity = project.location?.city ? [project.location.city, project.location.region].filter(Boolean).join(', ') : '';
  const cityValue = city ?? saved?.city ?? '';
  const save = async () => {
    setSaving(true);
    setError(null);
    const r = await useAnalytics.getState().saveSettings({ projectId: project.id, keywords: kw.slice(0, 10), ...(placeCity ? {} : { city: cityValue.trim() }) });
    setSaving(false);
    if (r.ok) {
      toast({ title: 'Keywords saved', body: 'Rankings show after the next Update.', kind: 'success' });
      onClose();
    } else setError(r.message ?? 'Couldn’t save.');
  };
  return (
    <Drawer
      open
      onClose={onClose}
      title="Keywords to track"
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
      <div className="flex flex-col gap-5">
        <Field label="Keywords" hint="Up to 10: what people type to find a business like yours.">
          <ChipInput values={kw} onChange={(v) => setKeywords(v.slice(0, 10))} max={10} placeholder="house cleaning austin" />
        </Field>
        {placeCity ? (
          <p className="text-small text-muted">Searched from {placeCity} (your business’s city, from Brand).</p>
        ) : (
          <Field label="City" hint="Rankings are checked as if searching from here." htmlFor="seo-city">
            <input id="seo-city" className="input" value={cityValue} maxLength={80} onChange={(e) => setCity(e.target.value)} />
          </Field>
        )}
        {error && (
          <p role="alert" className="text-small text-bad">
            {error}
          </p>
        )}
      </div>
    </Drawer>
  );
}
