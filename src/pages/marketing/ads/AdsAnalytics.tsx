// Ads › Analytics: the user's own Google Ads and Meta Ads results (read only: the app never changes ads), and
// up to three competitors' active ads from the public ad libraries. Ad text is someone else's: shown as text.
import { useEffect, useState } from 'react';
import { ExternalLink, Target, Users } from 'lucide-react';
import type { Project } from '@/lib/types';
import type { AdsData, AnalyticsCompetitor } from '@/lib/integrations/types';
import { fmtDate } from '@/lib/utils';
import { useAnalytics, useConnections } from '@/store/analytics';
import { toast } from '@/store/ui';
import { AreaChart, ChartCard } from '@/components/charts/Charts';
import { Badge, Callout, Drawer, Empty, Field, Spinner, StatStrip } from '@/components/ui/primitives';
import { AnalyticsShell, DataTable } from '../analytics/AnalyticsShell';
import { adsTotals, money, pct } from '../analytics/compute';
import { openConnectedAccounts } from '../analytics/links';

const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–');

export function AdsAnalytics({ project }: { project: Project }) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <AnalyticsShell<AdsData>
        project={project}
        source="ads"
        label="Ads analytics"
        metered
        meteredNote="Competitor ads are public data, refreshed when you press Update."
        actions={
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
            <Users /> Competitors
          </button>
        }
        empty={<AdsEmpty onCompetitors={() => setEditing(true)} />}
      >
        {(snap, range) => <AdsBody data={snap.data} range={range} onCompetitors={() => setEditing(true)} />}
      </AnalyticsShell>
      {editing && <CompetitorsDrawer projectId={project.id} onClose={() => setEditing(false)} />}
    </>
  );
}

function AdsEmpty({ onCompetitors }: { onCompetitors: () => void }) {
  return (
    <Empty
      icon={<Target />}
      title="No ad numbers yet"
      body="Connect Google Ads or Meta Ads for your own results, or track up to 3 competitors’ ads. Then press Update on the Marketing page."
      action={
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={openConnectedAccounts}>
            Connect an ad account
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCompetitors}>
            Track competitors
          </button>
        </>
      }
    />
  );
}

export function AdsBody({ data, range, onCompetitors, now }: { data: AdsData; range: number; onCompetitors?: () => void; now?: number }) {
  const { byPlatform } = useConnections();
  const own = Array.isArray(data?.own) ? data.own : [];
  const competitors = Array.isArray(data?.competitors) ? data.competitors : [];
  const t = adsTotals(data, range, now);
  const connected = own.length > 0 || byPlatform.google_ads?.state === 'connected' || byPlatform.meta_ads?.state === 'connected';
  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Your ads" className="flex flex-col gap-4">
        <h2 className="text-h3 text-ink">Your ads</h2>
        {own.length === 0 ? (
          <Callout
            tone="info"
            action={
              !connected && (
                <button type="button" className="btn btn-secondary btn-xs" onClick={openConnectedAccounts}>
                  Connect
                </button>
              )
            }
          >
            {connected ? 'No results from your ad accounts yet. Press Update on the Marketing page.' : 'Connect Google Ads or Meta Ads to see your results.'}
          </Callout>
        ) : (
          <>
            <StatStrip
              items={[
                { label: 'Spend', value: money(t.spend, t.currency), sub: `Last ${range} days` },
                { label: 'Impressions', value: n(t.impressions) },
                { label: 'Clicks', value: n(t.clicks) },
                { label: 'CTR', value: pct(t.ctr) },
                { label: 'Conversions', value: n(t.conversions) },
              ]}
            />
            <ChartCard title="Spend per day" subtitle={`Google and Meta, last ${range} days`} table={{ columns: ['Date', 'Spend', 'Clicks'], rows: t.series.map((s) => [fmtDate(s.date), money(s.spend, t.currency), s.clicks]) }}>
              {t.series.length ? <AreaChart data={t.series.map((s) => ({ x: s.date, y: s.spend }))} label="Spend" format={(v) => money(v, t.currency)} /> : <p className="py-6 text-center text-small text-muted">No spend in this range.</p>}
            </ChartCard>
            <DataTable
              caption="Campaigns"
              columns={['Campaign', 'Spend', 'Impressions', 'Clicks', 'Conversions']}
              align={['left', 'right', 'right', 'right', 'right']}
              rows={own.flatMap((a) =>
                (a.campaigns ?? []).map((c) => [
                  <span key="c" className="flex min-w-0 items-center gap-2">
                    <Badge>{a.platform === 'google_ads' ? 'Google' : 'Meta'}</Badge>
                    <span className="truncate">{c.name}</span>
                  </span>,
                  money(c.spend, a.currency),
                  n(c.impressions),
                  n(c.clicks),
                  n(c.conversions),
                ]),
              )}
            />
          </>
        )}
      </section>

      <section aria-label="Competitor ads" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-h3 text-ink">Competitor ads</h2>
        </div>
        {competitors.length === 0 ? (
          <Empty
            variant="inline"
            title="No competitors tracked."
            action={
              onCompetitors && (
                <button type="button" className="link text-small" onClick={onCompetitors}>
                  Track up to 3
                </button>
              )
            }
          />
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            {competitors.map((c, i) => (
              <ChartCard key={`${c.name}-${i}`} title={c.name} subtitle={c.source === 'google' ? 'Google ads' : 'Facebook and Instagram ads'}>
                {c.note === 'not_found' ? (
                  <p className="text-small text-muted">Not found in the ad library. Check the name or page in Competitors.</p>
                ) : c.activeAds === 0 || c.note === 'no_ads' ? (
                  <p className="text-small text-muted">No active ads right now.</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    <p className="text-small text-ink-2">
                      <span className="num font-mono text-ink">{c.activeAds}</span> active ad{c.activeAds === 1 ? '' : 's'}
                    </p>
                    <ul className="flex flex-col divide-y divide-line">
                      {c.ads.slice(0, 5).map((ad) => (
                        <li key={ad.id} className="flex flex-col gap-1 py-2">
                          <p className="clamp-2 text-small text-ink-2">{ad.text || 'No text'}</p>
                          <span className="flex flex-wrap items-center gap-x-3 text-caption text-muted">
                            {ad.firstShown && <span>First shown {fmtDate(ad.firstShown)}</span>}
                            {ad.url && (
                              <a href={ad.url} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-1">
                                View in Ad Library <ExternalLink size={12} aria-hidden="true" />
                              </a>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </ChartCard>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const blank = (): AnalyticsCompetitor => ({ name: '', pageId: '', domain: '' });

/** "Track up to 3 competitors": name, and a Facebook page id or a website for each. */
function CompetitorsDrawer({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const saved = useAnalytics((s) => s.settings[projectId]);
  const [rows, setRows] = useState<AnalyticsCompetitor[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void useAnalytics.getState().loadSettings(projectId);
  }, [projectId]);
  const list = rows ?? (saved ? [...saved.competitors.map((c) => ({ name: c.name, pageId: c.pageId ?? '', domain: c.domain ?? '' }))] : []);
  const shown = list.length ? list : [blank()];
  const edit = (i: number, patch: Partial<AnalyticsCompetitor>) => setRows(shown.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = async () => {
    setSaving(true);
    setError(null);
    const competitors = shown.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), ...(c.pageId?.trim() ? { pageId: c.pageId.trim() } : {}), ...(c.domain?.trim() ? { domain: c.domain.trim() } : {}) }));
    const r = await useAnalytics.getState().saveSettings({ projectId, competitors });
    setSaving(false);
    if (r.ok) {
      toast({ title: 'Competitors saved', body: 'Their ads show after the next Update.', kind: 'success' });
      onClose();
    } else setError(r.message ?? 'Couldn’t save.');
  };
  return (
    <Drawer
      open
      onClose={onClose}
      title="Track up to 3 competitors"
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
      <div className="flex flex-col gap-6">
        <p className="text-small text-muted">Their active ads show on this tab after each Update. A Facebook page id or a website makes the match exact.</p>
        {shown.map((c, i) => (
          <fieldset key={i} className="flex flex-col gap-3">
            <legend className="mb-2 text-ui text-ink">Competitor {i + 1}</legend>
            <Field label="Name" htmlFor={`comp-name-${i}`}>
              <input id={`comp-name-${i}`} className="input" value={c.name} maxLength={100} onChange={(e) => edit(i, { name: e.target.value })} />
            </Field>
            <Field label="Facebook page id" hint="Optional. The number in the page’s Ad Library link." htmlFor={`comp-page-${i}`}>
              <input id={`comp-page-${i}`} className="input" inputMode="numeric" value={c.pageId ?? ''} maxLength={30} onChange={(e) => edit(i, { pageId: e.target.value })} />
            </Field>
            <Field label="Website" hint="Optional, for their Google ads (example.com)." htmlFor={`comp-domain-${i}`}>
              <input id={`comp-domain-${i}`} className="input" value={c.domain ?? ''} maxLength={253} onChange={(e) => edit(i, { domain: e.target.value })} />
            </Field>
            {shown.length > 1 && (
              <button type="button" className="link self-start text-small" onClick={() => setRows(shown.filter((_, j) => j !== i))}>
                Remove
              </button>
            )}
          </fieldset>
        ))}
        {shown.length < 3 && (
          <button type="button" className="btn btn-ghost btn-sm self-start" onClick={() => setRows([...shown, blank()])}>
            Add a competitor
          </button>
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
