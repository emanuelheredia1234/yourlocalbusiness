import { useMemo, useState } from 'react';
import { ChartColumn, Plus } from 'lucide-react';
import type { PostPlatform, PostType } from '@/lib/types';
import { fmtDate, fmtDateTime } from '@/lib/utils';
import { PLATFORMS, POST_TYPE_MAP } from '@/ai/knowledge';
import { countBy, postedSince, useKpis } from '@/lib/kpis';
import { postedFromApp } from '@/lib/metrics';
import { leadTime, seoPageIdOf } from '@/lib/leads';
import { navigate } from '@/lib/router';
import { useMediaQuery } from '@/lib/hooks';
import { useActiveProject, useStore } from '@/store/useStore';
import { useLeads } from '@/store/leads';
import { useUI } from '@/store/ui';
import { AreaChart, BarList, ChartCard, ColumnChart } from '@/components/charts/Charts';
import { Badge, Empty, InfoTip, PageHeader, Segmented, StatStrip } from '@/components/ui/primitives';
import { PlatformMark } from '@/components/posts/PlatformIcon';
import { PostTypeTag } from '@/components/posts/PostCard';
import { PostLink } from '@/components/posts/PostActions';
import { PostVisual } from '@/components/visuals/PostVisual';

type Range = '7' | '30' | '90';
type Metric = 'posted' | 'planned' | 'made';

const METRICS: { id: Metric; label: string; few: string }[] = [
  { id: 'posted', label: 'Posted', few: 'Not enough posts yet to show a trend' },
  { id: 'planned', label: 'Planned', few: 'Not enough planned posts in this range to show a trend' },
  { id: 'made', label: 'Made with AI', few: 'Not enough made with AI yet to show a trend' },
];

/** Counts, so whole numbers only on the axis. */
const whole = (n: number) => (Number.isInteger(n) ? String(n) : '');

export default function Analytics() {
  const project = useActiveProject()!;
  const openComposer = useUI((s) => s.openComposer);
  const [range, setRange] = useState<Range>('30');
  const [metric, setMetric] = useState<Metric>('posted');
  const days = Number(range);
  const k = useKpis(project, days);
  const allPosts = useStore((s) => s.posts);
  const recentLeads = useLeads((s) => s.recent);
  const since = k.since;

  const posted = useMemo(() => postedSince(allPosts, project.id, since), [allPosts, project.id, since]);
  // a project that has never planned or posted anything has no numbers yet
  const started = useMemo(() => allPosts.some((p) => p.projectId === project.id && p.status !== 'draft'), [allPosts, project.id]);
  const byPlatform = countBy(posted.map((p) => p.platform));
  const byType = countBy(posted.map((p) => p.postType));
  const byFormat = countBy(posted.map((p) => p.format));
  const scale = (rows: { n: number }[]) => Math.max(5, ...rows.map((r) => r.n));
  const series = k.series.map((d) => ({ x: d.date, y: d[metric] }));
  const m = METRICS.find((x) => x.id === metric)!;
  const total = series.reduce((s, d) => s + d.y, 0);
  const activeDays = series.filter((d) => d.y > 0).length;
  const prevPosted = k.prev.reduce((s, d) => s + d.posted, 0);
  const pageId = seoPageIdOf(project.id);
  // null until the app has looked (a moment after it opens, signed in, with a page published): no count is shown until then
  const leads = recentLeads ? recentLeads.filter((l) => l.pageId === pageId && leadTime(l) >= since).length : null;
  const span = `${days} days`;
  const wide = useMediaQuery('(min-width: 768px)');
  const rangeControl = started ? (
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
  ) : null;

  const header = (
    <PageHeader
      title="Analytics"
      meta={
        <>
          {!wide && rangeControl && <span className="mr-2">{rangeControl}</span>}
          <span>Real counts only</span>
          <InfoTip title="What’s counted" label="What’s counted">
            Posts that went out (posted from the app, or you marked them posted), posts on your calendar, new leads from your page’s form, and what you made with AI. Likes, views, clicks and followers live on each network, and sales on your own checkout: this app doesn’t read them, so it doesn’t show or guess them.
          </InfoTip>
        </>
      }
      actions={wide && rangeControl ? rangeControl : undefined}
    />
  );

  if (!started)
    return (
      <div>
        {header}
        <Empty
          variant="page"
          icon={<ChartColumn />}
          title="Numbers show up after your first post"
          body="Post something and we’ll start counting."
          action={
            <button type="button" className="btn btn-primary" onClick={() => openComposer()}>
              <Plus /> Create a post
            </button>
          }
        />
      </div>
    );

  return (
    <div>
      {header}

      <StatStrip
        items={[
          { label: 'Posted', value: k.posted, sub: `Last ${span}`, delta: prevPosted > 0 ? k.posted - prevPosted : null },
          { label: 'Posted from the app', value: k.byApp, sub: `${k.posted - k.byApp} marked by you` },
          { label: 'Planned', value: k.upcoming, sub: k.due ? `${k.due} due, not posted` : 'Coming up on your calendar', onClick: () => navigate('calendar') },
          { label: 'New leads', value: leads ?? '–', sub: !project.marketing.seoPublished ? 'Publish your page to collect them' : leads === null ? 'Not checked yet' : 'From your page’s form' },
        ]}
      />

      <ChartCard
        className="mt-6"
        title={`${m.label} per day`}
        subtitle={`Last ${span}`}
        action={<Segmented size="sm" value={metric} onChange={setMetric} options={METRICS.map((x) => ({ id: x.id, label: x.label }))} />}
        table={{ columns: ['Date', m.label], rows: k.series.map((d) => [fmtDate(d.date), d[metric]]) }}
      >
        {total < 5 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-1 text-center">
            <p className="text-small text-muted">{m.few}</p>
            {metric !== 'made' && (
              <button type="button" className="link text-small" onClick={() => navigate('calendar')}>
                Open calendar
              </button>
            )}
          </div>
        ) : activeDays < 7 ? (
          <ColumnChart data={series} label={m.label} format={whole} minMax={5} />
        ) : (
          <AreaChart data={series} label={m.label} format={whole} minMax={5} />
        )}
      </ChartCard>

      <div className="mt-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <ChartCard title="By network" subtitle={`Posted, last ${span}`} table={{ columns: ['Network', 'Posts'], rows: byPlatform.map((r) => [PLATFORMS[r.key as PostPlatform].label, r.n]) }}>
          {byPlatform.length ? (
            <BarList
              format={String}
              max={scale(byPlatform)}
              rows={byPlatform.map((r) => ({
                key: r.key,
                label: (
                  <>
                    <PlatformMark platform={r.key as PostPlatform} size={16} />
                    <span className="truncate">{PLATFORMS[r.key as PostPlatform].label}</span>
                  </>
                ),
                value: r.n,
              }))}
            />
          ) : (
            <NoData />
          )}
        </ChartCard>
        <ChartCard title="By post type" subtitle={`Posted, last ${span}`} table={{ columns: ['Post type', 'Posts'], rows: byType.map((r) => [POST_TYPE_MAP[r.key as PostType].label, r.n]) }}>
          {byType.length ? <BarList format={String} max={scale(byType)} rows={byType.map((r) => ({ key: r.key, label: <span className="truncate">{POST_TYPE_MAP[r.key as PostType].label}</span>, value: r.n }))} /> : <NoData />}
        </ChartCard>
        <ChartCard title="Images and videos" subtitle={`Posted, last ${span}`} table={{ columns: ['Format', 'Posts'], rows: byFormat.map((r) => [r.key === 'video' ? 'Video' : 'Image', r.n]) }}>
          {byFormat.length ? <BarList format={String} max={scale(byFormat)} rows={byFormat.map((r) => ({ key: r.key, label: r.key === 'video' ? 'Video' : 'Image', value: r.n }))} /> : <NoData />}
        </ChartCard>
      </div>

      <PostedTable posts={posted} span={span} />

      <p className="mt-6 text-caption text-muted">Likes, views, clicks and followers live on each network: this app doesn’t read or guess them.</p>
    </div>
  );
}

function NoData() {
  return <p className="py-6 text-center text-small text-muted">Nothing posted in this range.</p>;
}

/** What went out in the range, newest first, with the link to each post when there is one. */
function PostedTable({ posts, span }: { posts: ReturnType<typeof postedSince>; span: string }) {
  const project = useActiveProject()!;
  const openEditor = useUI((s) => s.openPostEditor);
  return (
    <section className="card mt-4 overflow-hidden" aria-label="Posted in this range">
      <div className="px-4 pb-3 pt-4 sm:px-5">
        <h3 className="text-h3 text-ink">Posted</h3>
        <p className="text-small text-muted">Last {span}, newest first</p>
      </div>
      {posts.length === 0 ? (
        <p className="border-t border-line px-5 py-8 text-center text-small text-muted">Nothing posted in this range.</p>
      ) : (
        <table className="w-full table-fixed text-left text-small">
          <thead className="border-y border-line text-caption text-muted">
            <tr>
              <th className="px-4 py-2 font-medium sm:px-5">Post</th>
              <th className="hidden w-[150px] px-2 py-2 font-medium md:table-cell">Type</th>
              <th className="hidden w-[170px] px-2 py-2 font-medium sm:table-cell">Posted</th>
              <th className="hidden w-[90px] px-2 py-2 font-medium md:table-cell">By</th>
              <th className="hidden w-[172px] py-2 pl-2 pr-4 font-medium sm:table-cell sm:pr-5">Link</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {posts.slice(0, 60).map((post) => (
              <tr key={post.id} className="transition-colors duration-120 hover:bg-surface-2">
                <td className="px-4 py-2 sm:px-5">
                  <div className="flex w-full min-w-0 items-center gap-3">
                    <span className="w-10 shrink-0 cursor-pointer overflow-hidden rounded-md" onClick={() => openEditor(post.id)}>
                      <PostVisual style={post.style} headline={post.headline} brand={project.brand} media={post.media} storyboard={post.storyboard} aspect="1/1" className="!rounded-none" />
                    </span>
                    <span className="min-w-0">
                      <button type="button" className="block max-w-full truncate text-left text-ui text-ink hover:underline" onClick={() => openEditor(post.id)}>
                        {post.headline}
                      </button>
                      <span className="flex min-w-0 items-center gap-1.5 text-caption text-muted">
                        <PlatformMark platform={post.platform} size={12} />
                        <span className="truncate">{PLATFORMS[post.platform].label}</span>
                        {post.format === 'video' && <Badge>Video</Badge>}
                        <span className="num truncate font-mono sm:hidden">· {post.publishedAt ? fmtDate(post.publishedAt, { month: 'short', day: 'numeric' }) : ''}</span>
                      </span>
                    </span>
                  </div>
                  {post.postUrl && (
                    <span className="mt-1 block pl-[52px] text-small sm:hidden">
                      <PostLink post={post} />
                    </span>
                  )}
                </td>
                <td className="hidden px-2 py-2 md:table-cell">
                  <PostTypeTag type={post.postType} />
                </td>
                <td className="num hidden truncate px-2 py-2 font-mono text-caption text-muted sm:table-cell">{post.publishedAt ? fmtDateTime(post.publishedAt) : ''}</td>
                <td className="hidden px-2 py-2 text-muted md:table-cell">{postedFromApp(post) ? 'App' : 'You'}</td>
                <td className="hidden truncate py-2 pl-2 pr-4 sm:table-cell sm:pr-5">{post.postUrl ? <PostLink post={post} /> : <span className="text-faint">–</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
