import { useMemo, useState } from 'react';
import { Database, Eye, Heart, MousePointerClick, ShoppingBag, Target, Trash2, Users } from 'lucide-react';
import type { Post, PostPlatform, PostType, StyleId } from '@/lib/types';
import { DAY_MS, fmtCompact, fmtDate, fmtMoney, fmtPct, fmtRelative } from '@/lib/utils';
import { PLATFORMS, POST_TYPE_MAP, POST_TYPES, STYLE_LABEL } from '@/ai/knowledge';
import { adDaily, followersFor, postLive, type PostMetrics } from '@/lib/metrics';
import { useKpis } from '@/lib/kpis';
import { useNow } from '@/lib/hooks';
import { useActiveProject, useStore } from '@/store/useStore';
import { useUI } from '@/store/ui';
import { clearSampleData, loadSampleData } from '@/store/sample';
import { AreaChart, BarList, ChartCard, Funnel, StatTile } from '@/components/charts/Charts';
import { Segmented, confirmAction } from '@/components/ui/primitives';
import { PlatformChip } from '@/components/posts/PlatformIcon';
import { FormatBadge, PostTypeTag } from '@/components/posts/PostCard';

type Range = '7' | '30' | '90';
type Metric = 'impressions' | 'engagements' | 'clicks' | 'optins' | 'revenue';

const METRICS: { id: Metric; label: string }[] = [
  { id: 'impressions', label: 'Impressions' },
  { id: 'engagements', label: 'Engagements' },
  { id: 'clicks', label: 'Link clicks' },
  { id: 'optins', label: 'Opt-ins' },
  { id: 'revenue', label: 'Revenue' },
];

interface Row {
  post: Post;
  m: PostMetrics;
}

function groupAvg<K extends string>(rows: Row[], key: (r: Row) => K) {
  const map = new Map<K, { n: number; impressions: number; engagements: number; clicks: number }>();
  for (const r of rows) {
    const k = key(r);
    const cur = map.get(k) ?? { n: 0, impressions: 0, engagements: 0, clicks: 0 };
    cur.n++;
    cur.impressions += r.m.impressions;
    cur.engagements += r.m.engagements;
    cur.clicks += r.m.clicks;
    map.set(k, cur);
  }
  return [...map.entries()].map(([k, v]) => ({ key: k, ...v, er: v.impressions ? v.engagements / v.impressions : 0 }));
}

export default function Analytics() {
  const project = useActiveProject()!;
  const [range, setRange] = useState<Range>('30');
  const [metric, setMetric] = useState<Metric>('impressions');
  const days = Number(range);
  const k = useKpis(project, days);
  const now = useNow(5000);
  const allPosts = useStore((s) => s.posts);
  const sales = useStore((s) => s.sales);
  const ads = useStore((s) => s.ads);
  const settings = useStore((s) => s.settings);
  const openEditor = useUI((s) => s.openPostEditor);
  const since = now - days * DAY_MS;

  const rows: Row[] = useMemo(
    () =>
      allPosts
        .filter((p) => p.projectId === project.id && p.status === 'published' && p.publishedAt && new Date(p.publishedAt).getTime() >= since)
        .map((post) => ({ post, m: postLive(post, now, followersFor(settings, post.platform)) })),
    [allPosts, project.id, since, now, settings],
  );
  const projectSales = useMemo(() => sales.filter((s) => s.projectId === project.id && s.createdAt >= since).sort((a, b) => b.createdAt - a.createdAt), [sales, project.id, since]);
  const projectAds = ads.filter((a) => a.projectId === project.id && a.launchedAt);
  const adTotals = projectAds.reduce(
    (t, c) => {
      for (const d of adDaily(c, now)) {
        t.spend += d.spend;
        t.clicks += d.clicks;
        t.impressions += d.impressions;
        t.conversions += d.conversions;
      }
      return t;
    },
    { spend: 0, clicks: 0, impressions: 0, conversions: 0 },
  );
  const hasSample = allPosts.some((p) => p.projectId === project.id && p.source === 'sample') || sales.some((s) => s.projectId === project.id && s.source === 'sample');

  const byType = groupAvg(rows, (r) => r.post.postType).sort((a, b) => b.er - a.er);
  const byStyle = groupAvg(rows, (r) => r.post.style).sort((a, b) => b.er - a.er);
  const byPlatform = groupAvg(rows, (r) => r.post.platform).sort((a, b) => b.impressions - a.impressions);
  const byFormat = groupAvg(rows, (r) => r.post.format);
  const top = rows.slice().sort((a, b) => b.m.engagements - a.m.engagements).slice(0, 8);
  const series = k.series.map((d) => ({ x: fmtDate(d.date), y: d[metric] }));
  const fmt = metric === 'revenue' ? (n: number) => fmtMoney(n, { compact: true }) : (n: number) => fmtCompact(n);
  const erTrend = k.series.map((d) => (d.impressions ? d.engagements / d.impressions : 0));
  const empty = rows.length === 0 && projectSales.length === 0 && k.optins === 0 && !projectAds.length;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow mb-1">Analytics</p>
          <h1 className="page-title">Performance</h1>
          <p className="mt-1 text-[13.5px] text-muted">Engagement is modeled from each post’s platform, format, style and type, and grows live after publishing. Sales come from Marketplace checkouts.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasSample ? (
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                if (await confirmAction({ title: 'Clear sample data?', body: 'Sample posts, subscribers and sales are removed. Your real work is untouched.', confirmLabel: 'Clear sample data' })) clearSampleData();
              }}
            >
              <Trash2 size={14} /> Clear sample data
            </button>
          ) : (
            <button className="btn btn-secondary btn-sm" onClick={() => loadSampleData(project)}>
              <Database size={14} /> Load sample data
            </button>
          )}
          <Segmented
            size="sm"
            value={range}
            onChange={setRange}
            options={[
              { id: '7', label: '7 days' },
              { id: '30', label: '30 days' },
              { id: '90', label: '90 days' },
            ]}
          />
        </div>
      </header>

      {hasSample && <p className="rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[13px] text-warn">Includes clearly labelled sample data so you can explore the dashboard. Clear it anytime.</p>}
      {empty && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-line-2 bg-surface px-4 py-3">
          <Database size={18} className="text-muted" />
          <p className="min-w-0 flex-1 text-[13px] text-ink-2">No data in this range yet. Publish posts, sell on the Marketplace or load sample data to see the dashboard in action.</p>
        </div>
      )}

      <section aria-label="Key metrics" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatTile label="Impressions" value={fmtCompact(k.impressions)} delta={k.delta.impressions} deltaLabel={`vs prior ${days}d`} trend={k.series.map((d) => d.impressions)} icon={<Eye size={13} />} />
        <StatTile label="Engagement rate" value={fmtPct(k.er)} delta={k.delta.er} deltaLabel={`vs prior ${days}d`} trend={erTrend} icon={<Heart size={13} />} />
        <StatTile label="Link clicks" value={fmtCompact(k.clicks)} delta={k.delta.clicks} deltaLabel={`vs prior ${days}d`} trend={k.series.map((d) => d.clicks)} icon={<MousePointerClick size={13} />} />
        <StatTile label="Lead opt-ins" value={fmtCompact(k.optins)} delta={k.delta.optins} deltaLabel={`vs prior ${days}d`} trend={k.series.map((d) => d.optins)} icon={<Users size={13} />} />
        <StatTile label="Store sales" value={fmtMoney(k.revenue, { compact: true })} delta={k.delta.revenue} deltaLabel={`${k.salesCount} orders`} trend={k.series.map((d) => d.revenue)} icon={<ShoppingBag size={13} />} />
      </section>

      <ChartCard
        title={`${METRICS.find((m) => m.id === metric)!.label} per day`}
        subtitle={`Last ${days} days`}
        action={<Segmented size="sm" value={metric} onChange={setMetric} options={METRICS.map((m) => ({ id: m.id, label: m.label }))} />}
        table={{ columns: ['Date', METRICS.find((m) => m.id === metric)!.label], rows: k.series.map((d) => [fmtDate(d.date), metric === 'revenue' ? fmtMoney(d.revenue, { cents: true }) : Math.round(d[metric])]) }}
      >
        <AreaChart data={series} label={`${metric} per day`} format={fmt} height={240} />
      </ChartCard>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ChartCard title="Top post types" subtitle="Average engagement rate per published post" table={{ columns: ['Post type', 'Posts', 'Engagement rate', 'Impressions'], rows: byType.map((r) => [POST_TYPE_MAP[r.key as PostType].label, r.n, fmtPct(r.er), Math.round(r.impressions)]) }}>
          {byType.length ? (
            <BarList format={(n) => fmtPct(n)} rows={byType.map((r) => ({ key: r.key, label: POST_TYPE_MAP[r.key as PostType].label, value: r.er, sub: `${r.n} post${r.n > 1 ? 's' : ''}` }))} />
          ) : (
            <NoData />
          )}
        </ChartCard>
        <ChartCard title="Top visual styles" subtitle="Average engagement rate per style" table={{ columns: ['Style', 'Posts', 'Engagement rate'], rows: byStyle.map((r) => [STYLE_LABEL[r.key as StyleId], r.n, fmtPct(r.er)]) }}>
          {byStyle.length ? <BarList format={(n) => fmtPct(n)} rows={byStyle.map((r) => ({ key: r.key, label: STYLE_LABEL[r.key as StyleId], value: r.er, sub: `${r.n} post${r.n > 1 ? 's' : ''}` }))} /> : <NoData />}
        </ChartCard>
        <ChartCard title="Impressions by platform" subtitle={`Last ${days} days`} table={{ columns: ['Platform', 'Posts', 'Impressions', 'Engagement rate'], rows: byPlatform.map((r) => [PLATFORMS[r.key as PostPlatform].label, r.n, Math.round(r.impressions), fmtPct(r.er)]) }}>
          {byPlatform.length ? <BarList rows={byPlatform.map((r) => ({ key: r.key, label: <PlatformChip platform={r.key as PostPlatform} />, value: r.impressions, sub: `${fmtPct(r.er)} ER` }))} /> : <NoData />}
        </ChartCard>
        <ChartCard title="Funnel" subtitle="From impressions to orders" table={{ columns: ['Stage', 'Count'], rows: [['Impressions', k.impressions], ['Link clicks', k.clicks], ['Lead opt-ins', k.optins], ['Orders', k.salesCount]] }}>
          <Funnel
            stages={[
              { label: 'Impressions', value: k.impressions },
              { label: 'Link clicks', value: k.clicks },
              { label: 'Lead opt-ins', value: k.optins },
              { label: 'Orders', value: k.salesCount },
            ]}
          />
          <div className="mt-4 grid grid-cols-2 gap-2">
            {(['image', 'video'] as const).map((f) => {
              const g = byFormat.find((x) => x.key === f);
              return (
                <div key={f} className="rounded-md bg-surface-2 px-3 py-2">
                  <p className="text-[11.5px] font-medium text-muted">{f === 'image' ? 'Image posts' : 'Video posts'}</p>
                  <p className="num text-[16px] font-bold">{g ? fmtCompact(g.impressions / g.n) : '—'}</p>
                  <p className="num text-[11px] text-muted">{g ? `avg impressions · ${fmtPct(g.er)} ER` : 'No posts yet'}</p>
                </div>
              );
            })}
          </div>
        </ChartCard>
      </div>

      <section className="panel overflow-hidden" aria-label="Top posts">
        <div className="border-b border-line px-4 py-3">
          <h3 className="font-display text-[15px] font-semibold">Top posts</h3>
          <p className="text-xs text-muted">By engagements, last {days} days. Counters update live.</p>
        </div>
        {top.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13px] text-muted">No published posts in this range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Post</th>
                  <th className="px-2 py-2 font-medium">Type</th>
                  <th className="px-2 py-2 text-right font-medium">Impressions</th>
                  <th className="px-2 py-2 text-right font-medium">Engagements</th>
                  <th className="px-2 py-2 text-right font-medium">ER</th>
                  <th className="px-4 py-2 text-right font-medium">Clicks</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {top.map(({ post, m }) => (
                  <tr key={post.id} className="cursor-pointer hover:bg-surface-2/60" onClick={() => openEditor(post.id)}>
                    <td className="max-w-[340px] px-4 py-2.5">
                      <span className="flex items-center gap-2">
                        <PlatformChip platform={post.platform} showLabel={false} />
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">{post.headline}</span>
                          <span className="flex items-center gap-1.5 text-[11px] text-muted">
                            <FormatBadge format={post.format} /> {post.publishedAt ? fmtRelative(post.publishedAt, now) : ''}
                            {post.source === 'sample' && <span className="text-warn">· sample</span>}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="px-2 py-2.5">
                      <PostTypeTag type={post.postType} />
                    </td>
                    <td className="num px-2 py-2.5 text-right">{fmtCompact(m.impressions)}</td>
                    <td className="num px-2 py-2.5 text-right">{fmtCompact(m.engagements)}</td>
                    <td className="num px-2 py-2.5 text-right">{fmtPct(m.engagementRate)}</td>
                    <td className="num px-4 py-2.5 text-right">{fmtCompact(m.clicks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section className="panel overflow-hidden" aria-label="Recent sales">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h3 className="font-display text-[15px] font-semibold">Store sales</h3>
            <span className="num text-[13px] font-semibold">{fmtMoney(projectSales.reduce((n, s) => n + s.amount, 0), { cents: true })}</span>
          </div>
          {projectSales.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-muted">No sales in this range. Publish your listing and share the Marketplace.</p>
          ) : (
            <ul className="max-h-[320px] divide-y divide-line overflow-y-auto scroll-thin">
              {projectSales.slice(0, 40).map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                  <ShoppingBag size={15} className="shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{s.title}</span>
                    <span className="block text-xs text-muted">
                      {s.buyer} · {fmtRelative(s.createdAt, now)}
                    </span>
                  </span>
                  <span className={s.source === 'checkout' || s.source === 'community' ? 'badge bg-good-soft text-good' : 'badge bg-warn-soft text-warn'}>{s.source === 'checkout' ? 'Checkout' : s.source === 'community' ? 'Marketplace' : s.source === 'simulated' ? 'Simulated' : 'Sample'}</span>
                  <span className="num w-16 text-right font-semibold">{fmtMoney(s.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel p-4" aria-label="Paid ads">
          <h3 className="mb-3 flex items-center gap-2 font-display text-[15px] font-semibold">
            <Target size={16} className="text-primary" /> Paid ads (simulated delivery)
          </h3>
          {projectAds.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-muted">No launched campaigns. Launch one from Marketing → Ads to model spend and clicks here.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <AdTile label="Spend" value={fmtMoney(adTotals.spend)} />
              <AdTile label="Impressions" value={fmtCompact(adTotals.impressions)} />
              <AdTile label="Clicks" value={fmtCompact(adTotals.clicks)} sub={adTotals.impressions ? `CTR ${fmtPct(adTotals.clicks / adTotals.impressions)}` : undefined} />
              <AdTile label="Conversions" value={fmtCompact(adTotals.conversions)} sub={adTotals.conversions ? `${fmtMoney(adTotals.spend / adTotals.conversions, { cents: true })} each` : undefined} />
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted">
            {POST_TYPES.map((t) => (
              <span key={t.id} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: `rgb(var(--${t.slot}))` }} /> {t.short}: {rows.filter((r) => r.post.postType === t.id).length}
              </span>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function NoData() {
  return <p className="py-8 text-center text-[13px] text-muted">Publish posts to compare performance.</p>;
}

function AdTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2">
      <p className="text-[11.5px] font-medium text-muted">{label}</p>
      <p className="num text-[17px] font-bold">{value}</p>
      {sub && <p className="num text-[11px] text-muted">{sub}</p>}
    </div>
  );
}
