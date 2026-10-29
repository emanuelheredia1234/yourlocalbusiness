import { useMemo } from 'react';
import { ArrowRight, Brain, CalendarClock, Check, ExternalLink, Globe, Mail, Megaphone, MousePointerClick, Search, ShoppingBag, Sparkles, Store, TrendingUp, Users, WandSparkles, Eye, Heart, Database } from 'lucide-react';
import type { Project } from '@/lib/types';
import { cn, ensureUrl, fmtCompact, fmtDateTime, fmtMoney, fmtPct, fmtRelative, greeting, stripProtocol } from '@/lib/utils';
import { navigate, type Route } from '@/lib/router';
import { FORMATS, PLATFORMS, POST_TYPE_MAP } from '@/ai/knowledge';
import { useKpis } from '@/lib/kpis';
import { useActiveProject, useStore } from '@/store/useStore';
import { useUI } from '@/store/ui';
import { loadSampleData } from '@/store/sample';
import { StatTile } from '@/components/charts/Charts';
import { BrandLogo } from '@/components/brand/Logo';
import { ProgressRing } from '@/components/ui/primitives';
import { PlatformGlyph } from '@/components/posts/PlatformIcon';
import { QuickComposer } from './QuickComposer';

export function readiness(project: Project, ctx: { scheduled: number; sales: number; listed: boolean }) {
  const items: { label: string; done: boolean; route: Route; cta: string }[] = [
    { label: 'Brand kit', done: !!project.brand.name && project.onboarded, route: 'workspace-settings', cta: 'Edit brand' },
    { label: project.track === 'business' ? 'Packages & operating model' : 'Product outline', done: project.studio.outline.length > 0 || project.studio.packages.length > 0, route: 'studio', cta: 'Open Studio' },
    { label: 'Interactive asset', done: project.studio.codeAssets.length > 0, route: 'studio', cta: 'Generate code' },
    { label: 'Listed on the Marketplace', done: ctx.listed, route: 'studio', cta: 'Publish' },
    { label: 'Lead magnet + 5 emails', done: !!project.marketing.leadMagnet && project.marketing.emails.length >= 5, route: 'marketing-email', cta: 'Build funnel' },
    { label: 'SEO sales page', done: !!project.marketing.salesPage, route: 'marketing-seo', cta: 'Build page' },
    { label: 'Social campaign scheduled', done: ctx.scheduled > 0, route: 'marketing-social', cta: 'Plan campaign' },
    { label: 'First sale', done: ctx.sales > 0, route: 'store', cta: 'View store' },
  ];
  return { items, done: items.filter((i) => i.done).length };
}

export function Dashboard() {
  const project = useActiveProject()!;
  const profile = useStore((s) => s.settings.profile);
  const posts = useStore((s) => s.posts);
  const sales = useStore((s) => s.sales);
  const listed = useStore((s) => s.myListings.some((l) => l.projectId === project.id));
  const genLog = useStore((s) => s.genLog);
  const notices = useStore((s) => s.notices);
  const openComposer = useUI((s) => s.openComposer);
  const k = useKpis(project, 7);
  const projectPosts = posts.filter((p) => p.projectId === project.id);
  const upcoming = projectPosts.filter((p) => p.status === 'scheduled').sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).slice(0, 5);
  const projectSales = sales.filter((s) => s.projectId === project.id);
  const ready = readiness(project, { scheduled: projectPosts.filter((p) => p.status !== 'draft').length, sales: projectSales.length, listed });
  const nextStep = ready.items.find((i) => !i.done);
  const noData = projectPosts.every((p) => p.status !== 'published') && projectSales.length === 0 && project.marketing.subscribers.length === 0;
  const trend = (key: 'impressions' | 'clicks' | 'optins' | 'revenue') => k.series.map((d) => d[key]);
  const erTrend = k.series.map((d) => (d.impressions ? d.engagements / d.impressions : 0));
  const activity = useMemo(
    () =>
      [
        ...genLog.filter((g) => g.projectId === project.id).slice(0, 6).map((g) => ({ id: g.id, at: g.createdAt, text: `${g.label}`, sub: g.provider === 'local' ? 'Built-in engine' : 'Claude', icon: <Sparkles size={14} /> })),
        ...notices.slice(0, 6).map((n) => ({ id: n.id, at: n.createdAt, text: n.title, sub: n.body ?? '', icon: n.kind === 'sale' ? <ShoppingBag size={14} /> : n.kind === 'post' ? <Megaphone size={14} /> : <Sparkles size={14} /> })),
      ]
        .sort((a, b) => b.at - a.at)
        .slice(0, 7),
    [genLog, notices, project.id],
  );

  const shortcuts: { route: Route; title: string; desc: string; icon: React.ReactNode; status: string }[] = [
    { route: 'studio', title: project.track === 'business' ? 'Business Studio' : 'Product Studio', desc: 'Outline, code assets, publish', icon: <WandSparkles size={18} />, status: project.studio.outline.length || project.studio.packages.length ? 'In progress' : 'Start here' },
    { route: 'marketing-seo', title: 'SEO sales page', desc: 'Meta, score, HTML export', icon: <Search size={18} />, status: project.marketing.salesPage ? 'Drafted' : 'Not started' },
    { route: 'marketing-email', title: 'Email funnel', desc: 'Lead magnet + 5 emails', icon: <Mail size={18} />, status: project.marketing.emails.length ? `${project.marketing.subscribers.length} subscribers` : 'Not started' },
    { route: 'marketing-social', title: 'Social campaign', desc: '30-day plan, 7-day batch', icon: <Megaphone size={18} />, status: project.marketing.plan ? `${project.marketing.plan.summary.total} posts planned` : 'Not started' },
    { route: 'store', title: 'Marketplace', desc: 'Browse, sell, buy', icon: <Store size={18} />, status: listed ? 'Listed' : 'Not listed' },
    { route: 'brain', title: 'Brain', desc: 'Skills that shape the AI', icon: <Brain size={18} />, status: 'Train it' },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow mb-1">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          <h1 className="page-title">
            {greeting()}
            {profile.name ? `, ${profile.name.split(' ')[0]}` : ''}.
          </h1>
          <p className="mt-1 text-[14px] text-muted">
            {nextStep ? (
              <>
                Next up for <b className="text-ink">{project.brand.name}</b>: {nextStep.label.toLowerCase()}.{' '}
                <button className="link" onClick={() => navigate(nextStep.route)}>
                  {nextStep.cta} →
                </button>
              </>
            ) : (
              <>Everything is launched. Keep the campaign running and watch Analytics.</>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-secondary" onClick={() => navigate('analytics')}>
            <TrendingUp size={16} /> Analytics
          </button>
          <button className="btn btn-primary" onClick={() => openComposer()}>
            <Sparkles size={16} className="text-accent" /> Create post
          </button>
        </div>
      </div>

      {noData && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-line-2 bg-surface px-4 py-3">
          <Database size={18} className="text-muted" />
          <p className="min-w-0 flex-1 text-[13px] text-ink-2">No performance data yet. Publish your first post, or load clearly labelled sample data to explore Analytics.</p>
          <button className="btn btn-secondary btn-sm" onClick={() => loadSampleData(project)}>
            Load sample data
          </button>
        </div>
      )}

      <section aria-label="Key metrics, last 7 days" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatTile label="Impressions" value={fmtCompact(k.impressions)} delta={k.delta.impressions} deltaLabel="vs prior 7d" trend={trend('impressions')} icon={<Eye size={13} />} />
        <StatTile label="Engagement rate" value={fmtPct(k.er)} delta={k.delta.er} deltaLabel="vs prior 7d" trend={erTrend} icon={<Heart size={13} />} />
        <StatTile label="Link clicks" value={fmtCompact(k.clicks)} delta={k.delta.clicks} deltaLabel="vs prior 7d" trend={trend('clicks')} icon={<MousePointerClick size={13} />} />
        <StatTile label="Lead opt-ins" value={fmtCompact(k.optins)} delta={k.delta.optins} deltaLabel="vs prior 7d" trend={trend('optins')} icon={<Users size={13} />} />
        <StatTile label="Store sales" value={fmtMoney(k.revenue, { compact: true })} delta={k.delta.revenue} deltaLabel={`${k.salesCount} orders`} trend={trend('revenue')} icon={<ShoppingBag size={13} />} />
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="panel p-4 sm:p-5" aria-label="Quick composer">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="section-title">Create a new post</h2>
              <p className="text-[13px] text-muted">One click for an AI caption and visual, or bring your own photo or video.</p>
            </div>
          </div>
          <QuickComposer />
        </section>

        <div className="flex min-w-0 flex-col gap-5">
          <section className="panel overflow-hidden" aria-label="Active project">
            <div className="flex items-center gap-3 border-b border-line p-4" style={{ background: project.brand.colors.paper, color: project.brand.colors.ink }}>
              <BrandLogo brand={project.brand} size={40} layout="horizontal" />
            </div>
            <div className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap gap-1.5">
                <span className="badge bg-primary-soft text-primary">{project.track === 'product' ? 'Digital product' : 'Business'}</span>
                {project.format && <span className="badge bg-surface-2 text-ink-2">{FORMATS[project.format].short}</span>}
                {project.location?.city && <span className="badge bg-surface-2 text-ink-2">{project.location.city}</span>}
              </div>
              {project.brand.tagline && <p className="text-[13.5px] italic text-ink-2">“{project.brand.tagline}”</p>}
              <dl className="grid grid-cols-2 gap-2 text-[12.5px]">
                <div>
                  <dt className="text-muted">Niche</dt>
                  <dd className="truncate font-semibold">{project.category || project.niche || project.businessType}</dd>
                </div>
                <div>
                  <dt className="text-muted">Price</dt>
                  <dd className="font-semibold">{project.studio.price ? fmtMoney(project.studio.price) : '—'}</dd>
                </div>
              </dl>
              {project.brand.websiteUrl && (
                <a href={ensureUrl(project.brand.websiteUrl)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-primary hover:underline">
                  <Globe size={13} /> {stripProtocol(project.brand.websiteUrl)} <ExternalLink size={11} />
                </a>
              )}
            </div>
          </section>

          <section className="panel p-4" aria-label="Launch readiness">
            <div className="mb-3 flex items-center gap-3">
              <ProgressRing value={ready.done / ready.items.length} size={46} />
              <div>
                <h2 className="section-title">Launch readiness</h2>
                <p className="text-xs text-muted">
                  {ready.done} of {ready.items.length} steps done
                </p>
              </div>
            </div>
            <ul className="flex flex-col gap-0.5">
              {ready.items.map((it) => (
                <li key={it.label}>
                  <button onClick={() => navigate(it.route)} className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-[13px] hover:bg-surface-2">
                    <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full border', it.done ? 'border-good bg-good text-white' : 'border-line-2')}>{it.done && <Check size={12} />}</span>
                    <span className={cn('flex-1', it.done ? 'text-muted line-through' : 'font-medium text-ink')}>{it.label}</span>
                    {!it.done && <ArrowRight size={13} className="text-muted" />}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      <section aria-label="Shortcuts">
        <h2 className="section-title mb-3">Project shortcuts</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shortcuts.map((s) => (
            <button key={s.route} onClick={() => navigate(s.route)} className="panel group flex items-center gap-3 p-4 text-left transition-colors hover:border-line-2 hover:bg-surface-2/50">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">{s.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold text-ink">{s.title}</span>
                <span className="block truncate text-xs text-muted">{s.desc}</span>
              </span>
              <span className="shrink-0 text-right text-[11.5px] font-semibold text-muted group-hover:text-ink">{s.status}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section className="panel p-4 sm:p-5" aria-label="Upcoming posts">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="section-title">Upcoming posts</h2>
            <button className="link text-[13px]" onClick={() => navigate('calendar')}>
              Open calendar
            </button>
          </div>
          {upcoming.length === 0 ? (
            <p className="rounded-md bg-surface-2 px-3 py-6 text-center text-[13px] text-muted">
              Nothing scheduled.{' '}
              <button className="link" onClick={() => navigate('marketing-social')}>
                Generate a 7-day content batch
              </button>
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {upcoming.map((p) => (
                <li key={p.id}>
                  <button className="flex w-full items-center gap-3 py-2.5 text-left hover:opacity-80" onClick={() => useUI.getState().openPostEditor(p.id)}>
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-white" style={{ background: PLATFORMS[p.platform].color }}>
                      <PlatformGlyph platform={p.platform} size={15} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold">{p.headline}</span>
                      <span className="flex items-center gap-1.5 text-xs text-muted">
                        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: `rgb(var(--${POST_TYPE_MAP[p.postType].slot}))` }} />
                        {POST_TYPE_MAP[p.postType].short} · {p.format}
                      </span>
                    </span>
                    <span className="num flex shrink-0 items-center gap-1 text-xs text-muted">
                      <CalendarClock size={12} /> {fmtDateTime(p.scheduledAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel p-4 sm:p-5" aria-label="Recent activity">
          <h2 className="section-title mb-3">Recent activity</h2>
          {activity.length === 0 ? (
            <p className="rounded-md bg-surface-2 px-3 py-6 text-center text-[13px] text-muted">AI generations, publishes and sales will appear here.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {activity.map((a) => (
                <li key={a.id} className="flex items-start gap-3 rounded-md px-1.5 py-2">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-ink-2">{a.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{a.text}</span>
                    {a.sub && <span className="block truncate text-xs text-muted">{a.sub}</span>}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted">{fmtRelative(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
