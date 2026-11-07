// Social › Analytics: followers, posts, engagement and reach across the networks, from the user's own
// connected accounts where they're connected and from public data otherwise. Captions are someone else's
// text: shown as text, links open with noopener.
import { ExperimentsSummary } from '@/components/experiments/ExperimentsSummary';
import { useMemo } from 'react';
import { Link2 } from 'lucide-react';
import type { Project, SocialPlatform } from '@/lib/types';
import type { SocialData, SocialNetworkStats } from '@/lib/integrations/types';
import { PLATFORMS } from '@/ai/knowledge';
import { useStore } from '@/store/useStore';
import { useConnections } from '@/store/analytics';
import { BarList, ChartCard } from '@/components/charts/Charts';
import { PlatformMark } from '@/components/posts/PlatformIcon';
import { Badge, Empty, StatStrip } from '@/components/ui/primitives';
import { AnalyticsShell, DataTable } from '../analytics/AnalyticsShell';
import { inRange, socialTotals } from '../analytics/compute';
import { openConnectedAccounts } from '../analytics/links';

const fmt = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '–');

const NOTE: Record<NonNullable<SocialNetworkStats['note']>, string> = {
  private: 'This account is private, so public stats aren’t available. Connect it to see your stats.',
  not_found: 'Check this handle in Settings.',
  over_cost: 'Skipped (over cost limit).',
  busy: 'Try again later.',
  reconnect: 'Reconnect to see your own stats.',
};

export function SocialAnalytics({ project }: { project: Project }) {
  const handles = project.brand.socials ?? {};
  const hasHandle = Object.values(handles).some((h) => typeof h === 'string' && h.trim());
  const { byPlatform } = useConnections();
  const connected = (['facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube'] as const).some((p) => byPlatform[p]?.state === 'connected');
  const posts = useStore((s) => s.posts);
  const appPosts = useMemo(() => posts.filter((p) => p.projectId === project.id && p.status === 'published' && p.publishedBy === 'api'), [posts, project.id]);

  return (
    <div className="flex flex-col gap-4">
      <AnalyticsShell<SocialData>
        project={project}
        source="social"
        label="Social analytics"
        metered
        empty={
          !hasHandle && !connected ? (
            <Empty
              icon={<Link2 />}
              title="Add your handles in Settings → Connected accounts"
              body="Your profiles give public stats; connected accounts add your own reach."
              action={
                <button type="button" className="btn btn-secondary btn-sm" onClick={openConnectedAccounts}>
                  Open Connected accounts
                </button>
              }
            />
          ) : undefined
        }
      >
        {(snap, range) => <SocialBody data={snap.data} range={range} appPosted={appPosts.filter((p) => inRange(p.publishedAt, range)).length} />}
      </AnalyticsShell>
      {/* A/B tests (P4b): hidden in the claude.ai build and when there are none */}
      <ExperimentsSummary project={project} kind="post" />
    </div>
  );
}

export function SocialBody({ data, range, appPosted, now }: { data: SocialData; range: number; appPosted: number; now?: number }) {
  const t = socialTotals(data, range, now);
  const networks = Array.isArray(data?.networks) ? data.networks : [];
  const name = (n: SocialNetworkStats['network']) => PLATFORMS[n as SocialPlatform]?.label ?? n;
  if (!networks.length) return <Empty icon={<Link2 />} title="No stats yet" body="Add your handles in Settings → Connected accounts, then press Update." />;
  return (
    <div className="flex flex-col gap-4">
      <StatStrip
        items={[
          { label: 'Followers', value: fmt(t.followers) },
          { label: 'Posts', value: fmt(t.posts), sub: `Last ${range} days` },
          { label: 'Engagement', value: fmt(t.engagement), info: t.engagementTotals ? 'Likes, comments and shares on posts in this range. A connected account with no public handle counts its recent total instead.' : 'Likes, comments and shares on posts in this range.' },
          { label: 'Reach (connected accounts)', value: t.reach === null ? '–' : fmt(t.reach), info: t.reach === null ? 'Reach is only available from accounts you connect.' : undefined },
          { label: 'Posted from the app', value: fmt(appPosted) },
        ]}
      />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <ChartCard title="Followers by network" subtitle="Now" table={{ columns: ['Network', 'Followers'], rows: t.byNetwork.map((r) => [name(r.network), r.followers]) }}>
          {t.byNetwork.length ? (
            <BarList
              rows={t.byNetwork.map((r) => ({
                key: r.network,
                value: r.followers,
                label: (
                  <>
                    <PlatformMark platform={r.network as SocialPlatform} size={16} />
                    <span className="truncate">{name(r.network)}</span>
                  </>
                ),
              }))}
            />
          ) :  <p className="py-6 text-center text-small text-muted">No follower counts yet.</p>}
        </ChartCard>
        <ChartCard title="Top posts" subtitle={`By engagement, last ${range} days`}>
          {t.topPosts.length ? (
            <BarList
              rows={t.topPosts.map((p) => ({
                key: p.key,
                value: p.engagement,
                label: (
                  <>
                    <PlatformMark platform={p.network as SocialPlatform} size={16} />
                    {p.url ? (
                      <a href={p.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate hover:underline" title={p.text}>
                        {p.text || 'Untitled post'}
                      </a>
                    ) : (
                      <span className="min-w-0 truncate" title={p.text}>
                        {p.text || 'Untitled post'}
                      </span>
                    )}
                  </>
                ),
              }))}
            />
          ) : (
            <p className="py-6 text-center text-small text-muted">No posts in this range.</p>
          )}
        </ChartCard>
      </div>
      <DataTable
        caption="Each network"
        columns={['Network', 'From', 'Followers', 'Posts', 'Engagement']}
        align={['left', 'left', 'right', 'right', 'right']}
        rows={networks.map((n) => [
          <span key="n" className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              <PlatformMark platform={n.network as SocialPlatform} size={16} />
              <span className="truncate text-ink">{name(n.network)}</span>
              {n.handle && <span className="truncate text-caption text-muted">@{n.handle.replace(/^@/, '')}</span>}
            </span>
            {n.note && <span className="mt-0.5 text-caption text-muted">{NOTE[n.note]}</span>}
          </span>,
          <Badge key="o" tone={n.origin === 'own' ? 'good' : 'neutral'}>
            {n.origin === 'own' ? 'Your account' : 'Public'}
          </Badge>,
          fmt(n.followers),
          fmt(n.postsCount),
          fmt(n.engagement),
        ])}
      />
    </div>
  );
}
