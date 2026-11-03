import { useMemo, useState } from 'react';
import { CalendarClock, CircleAlert, Info, Send, Sparkles } from 'lucide-react';
import type { PostPlatform, PostType } from '@/lib/types';
import { fmtDate, fmtDateTime } from '@/lib/utils';
import { PLATFORMS, POST_TYPE_MAP } from '@/ai/knowledge';
import { useKpis } from '@/lib/kpis';
import { navigate } from '@/lib/router';
import { useActiveProject, useStore } from '@/store/useStore';
import { useUI } from '@/store/ui';
import { AreaChart, BarList, ChartCard, StatTile } from '@/components/charts/Charts';
import { Segmented } from '@/components/ui/primitives';
import { PlatformChip } from '@/components/posts/PlatformIcon';
import { FormatBadge, PostTypeTag } from '@/components/posts/PostCard';
import { PostLink } from '@/components/posts/PostActions';

type Range = '7' | '30' | '90';
type Metric = 'posted' | 'planned' | 'made';

const METRICS: { id: Metric; label: string }[] = [
  { id: 'posted', label: 'Posted' },
  { id: 'planned', label: 'Planned' },
  { id: 'made', label: 'Made with AI' },
];

/** Counts per key, biggest first. */
function countBy<K extends string>(items: K[]) {
  const map = new Map<K, number>();
  for (const k of items) map.set(k, (map.get(k) ?? 0) + 1);
  return [...map.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);
}

export default function Analytics() {
  const project = useActiveProject()!;
  const [range, setRange] = useState<Range>('30');
  const [metric, setMetric] = useState<Metric>('posted');
  const days = Number(range);
  const k = useKpis(project, days);
  const allPosts = useStore((s) => s.posts);
  const openEditor = useUI((s) => s.openPostEditor);
  const since = k.since;

  const posted = useMemo(
    () => allPosts.filter((p) => p.projectId === project.id && p.status === 'published' && p.publishedAt && new Date(p.publishedAt).getTime() >= since).sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')),
    [allPosts, project.id, since],
  );
  const byPlatform = countBy(posted.map((p) => p.platform));
  const byType = countBy(posted.map((p) => p.postType));
  const byFormat = countBy(posted.map((p) => p.format));
  const series = k.series.map((d) => ({ x: fmtDate(d.date), y: d[metric] }));
  const label = METRICS.find((m) => m.id === metric)!.label;
  const nothing = posted.length === 0 && k.upcoming === 0 && k.made === 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow mb-1">Analytics</p>
          <h1 className="page-title">Your activity</h1>
          <p className="mt-1 max-w-[760px] text-[13.5px] text-muted">Real counts only: posts that went out (Manus reported them posted, or you marked them posted), posts on your calendar, and what you made with AI.</p>
        </div>
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
      </header>

      <p className="flex items-start gap-2 rounded-md border border-line bg-surface-2/60 px-3 py-2 text-[13px] text-ink-2">
        <Info size={15} className="mt-0.5 shrink-0 text-muted" />
        <span>Likes, views, clicks and followers live on each network, and sales on your own checkout: this app doesn’t read them, so it doesn’t show or guess them. Open a post on its network to see how it’s doing.</span>
      </p>

      {nothing && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-line-2 bg-surface px-4 py-3">
          <CalendarClock size={18} className="text-muted" />
          <p className="min-w-0 flex-1 text-[13px] text-ink-2">Nothing in this range yet. Plan posts on your calendar, then post them with Manus or post them yourself and mark them posted.</p>
          <button className="btn btn-secondary btn-sm" onClick={() => navigate('calendar')}>
            Open calendar
          </button>
        </div>
      )}

      <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Posted" value={String(k.posted)} delta={k.delta.posted} deltaLabel={`vs prior ${days}d`} trend={k.series.map((d) => d.posted)} icon={<Send size={13} />} />
        <StatTile label="Posted by Manus" value={String(k.byManus)} hint={k.posted ? `${k.posted - k.byManus} marked by you` : 'Its own reports'} icon={<Send size={13} />} />
        <StatTile label="Planned" value={String(k.upcoming)} hint={k.due ? `${k.due} due: not posted yet` : 'Coming up on your calendar'} icon={<CalendarClock size={13} />} />
        <StatTile label="Made with AI" value={String(k.made)} delta={k.delta.made} deltaLabel={`vs prior ${days}d`} trend={k.series.map((d) => d.made)} icon={<Sparkles size={13} />} />
      </section>

      {k.due > 0 && (
        <p className="flex flex-wrap items-center gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[13px] text-warn">
          <CircleAlert size={15} /> {k.due} planned post{k.due > 1 ? 's are' : ' is'} past {k.due > 1 ? 'their' : 'its'} time and not posted.{' '}
          <button className="font-semibold underline" onClick={() => navigate('calendar')}>
            Open the calendar
          </button>
        </p>
      )}

      <ChartCard
        title={`${label} per day`}
        subtitle={`Last ${days} days`}
        action={<Segmented size="sm" value={metric} onChange={setMetric} options={METRICS.map((m) => ({ id: m.id, label: m.label }))} />}
        table={{ columns: ['Date', label], rows: k.series.map((d) => [fmtDate(d.date), d[metric]]) }}
      >
        <AreaChart data={series} label={`${label} per day`} format={(n) => (Number.isInteger(n) ? String(n) : "")} height={220} />
      </ChartCard>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <ChartCard title="Posted by network" subtitle={`Last ${days} days`} table={{ columns: ['Network', 'Posts'], rows: byPlatform.map((r) => [PLATFORMS[r.key as PostPlatform].label, r.n]) }}>
          {byPlatform.length ? <BarList format={(n) => String(n)} rows={byPlatform.map((r) => ({ key: r.key, label: <PlatformChip platform={r.key as PostPlatform} />, value: r.n }))} /> : <NoData />}
        </ChartCard>
        <ChartCard title="Posted by type" subtitle="What you’ve been posting" table={{ columns: ['Post type', 'Posts'], rows: byType.map((r) => [POST_TYPE_MAP[r.key as PostType].label, r.n]) }}>
          {byType.length ? <BarList format={(n) => String(n)} rows={byType.map((r) => ({ key: r.key, label: POST_TYPE_MAP[r.key as PostType].label, value: r.n }))} /> : <NoData />}
        </ChartCard>
        <ChartCard title="Images and videos" subtitle={`Last ${days} days`} table={{ columns: ['Format', 'Posts'], rows: byFormat.map((r) => [r.key === 'video' ? 'Video' : 'Image', r.n]) }}>
          {byFormat.length ? <BarList format={(n) => String(n)} rows={byFormat.map((r) => ({ key: r.key, label: r.key === 'video' ? 'Video' : 'Image', value: r.n }))} /> : <NoData />}
        </ChartCard>
      </div>

      <section className="panel overflow-hidden" aria-label="Posted in this range">
        <div className="border-b border-line px-4 py-3">
          <h3 className="font-display text-[15px] font-semibold">Posted</h3>
          <p className="text-xs text-muted">Last {days} days, newest first.</p>
        </div>
        {posted.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13px] text-muted">Nothing posted in this range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Post</th>
                  <th className="px-2 py-2 font-medium">Type</th>
                  <th className="px-2 py-2 font-medium">Posted</th>
                  <th className="px-2 py-2 font-medium">By</th>
                  <th className="px-4 py-2 font-medium">Link</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {posted.slice(0, 60).map((post) => (
                  <tr key={post.id} className="hover:bg-surface-2/60">
                    <td className="max-w-[340px] px-4 py-2.5">
                      <button className="flex min-w-0 items-center gap-2 text-left" onClick={() => openEditor(post.id)}>
                        <PlatformChip platform={post.platform} showLabel={false} />
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">{post.headline}</span>
                          <FormatBadge format={post.format} />
                        </span>
                      </button>
                    </td>
                    <td className="px-2 py-2.5">
                      <PostTypeTag type={post.postType} />
                    </td>
                    <td className="num px-2 py-2.5 text-muted">{post.publishedAt ? fmtDateTime(post.publishedAt) : ''}</td>
                    <td className="px-2 py-2.5 text-muted">{post.publishedBy === 'manus' ? 'Manus' : 'You'}</td>
                    <td className="px-4 py-2.5">{post.postUrl ? <PostLink post={post} /> : <span className="text-faint">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function NoData() {
  return <p className="py-8 text-center text-[13px] text-muted">Nothing posted in this range.</p>;
}
