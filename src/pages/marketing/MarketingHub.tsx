import { useMemo } from 'react';
import { ArrowRight, Check, Circle } from 'lucide-react';
import type { Channel } from '@/lib/types';
import { cn, fmtCompact, fmtMoney, fmtPct } from '@/lib/utils';
import { scoreSeo } from '@/ai/local/seo';
import { useKpis } from '@/lib/kpis';
import { useActiveProject, useStore } from '@/store/useStore';
import { ChartCard, Funnel } from '@/components/charts/Charts';
import { ProgressRing } from '@/components/ui/primitives';
import { CHANNELS, MarketingHeader, goChannel } from './MarketingNav';

export default function MarketingHub() {
  const project = useActiveProject()!;
  const allPosts = useStore((s) => s.posts);
  const allAds = useStore((s) => s.ads);
  const posts = useMemo(() => allPosts.filter((p) => p.projectId === project.id), [allPosts, project.id]);
  const ads = useMemo(() => allAds.filter((a) => a.projectId === project.id), [allAds, project.id]);
  const k = useKpis(project, 30);
  const m = project.marketing;
  const seo = m.seo ? scoreSeo(m.seo, m.salesPage) : null;
  const scheduled = posts.filter((p) => p.status === 'scheduled').length;
  const published = posts.filter((p) => p.status === 'published').length;
  const activeAds = ads.filter((a) => a.status === 'active').length;

  const status: Record<Channel, { progress: number; lines: { label: string; done: boolean }[]; metric: string }> = {
    seo: {
      progress: [!!m.seo, !!m.salesPage, (seo?.score ?? 0) >= 80].filter(Boolean).length / 3,
      lines: [
        { label: 'Keyword & metadata', done: !!m.seo },
        { label: 'Sales page drafted', done: !!m.salesPage },
        { label: 'SEO score 80+', done: (seo?.score ?? 0) >= 80 },
      ],
      metric: seo ? `SEO score ${seo.score}/100` : 'Not started',
    },
    email: {
      progress: [!!m.leadMagnet, m.emails.length >= 5, m.subscribers.length > 0].filter(Boolean).length / 3,
      lines: [
        { label: 'Lead magnet', done: !!m.leadMagnet },
        { label: '5-email sequence', done: m.emails.length >= 5 },
        { label: 'First subscriber', done: m.subscribers.length > 0 },
      ],
      metric: `${m.subscribers.length} subscriber${m.subscribers.length === 1 ? '' : 's'}`,
    },
    social: {
      progress: [!!m.plan, posts.some((p) => p.source === 'batch'), scheduled + published > 0].filter(Boolean).length / 3,
      lines: [
        { label: '30-day plan', done: !!m.plan },
        { label: '7-day content batch', done: posts.some((p) => p.source === 'batch') },
        { label: 'Posts scheduled', done: scheduled + published > 0 },
      ],
      metric: `${scheduled} scheduled · ${published} published`,
    },
    ads: {
      progress: [ads.length > 0, ads.some((a) => a.creatives.length > 0), activeAds > 0].filter(Boolean).length / 3,
      lines: [
        { label: 'Campaign created', done: ads.length > 0 },
        { label: 'Creatives generated', done: ads.some((a) => a.creatives.length > 0) },
        { label: 'Campaign live (simulated)', done: activeAds > 0 },
      ],
      metric: activeAds ? `${activeAds} active campaign${activeAds > 1 ? 's' : ''}` : `${ads.length} draft${ads.length === 1 ? '' : 's'}`,
    },
  };

  return (
    <div className="flex flex-col gap-6">
      <MarketingHeader eyebrow="Marketing Hub" title="Market it everywhere" desc={<>Four channels that share one brain: everything you write here pulls from {project.brand.name}’s brand, offer and Brain skills, so the message stays consistent.</>} />

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2" aria-label="Channels">
        {CHANNELS.map((c) => {
          const st = status[c.id];
          return (
            <button key={c.id} className="panel group flex flex-col gap-4 p-5 text-left transition-shadow hover:shadow-pop" onClick={() => goChannel(c.id)}>
              <div className="flex items-start gap-4">
                <ProgressRing value={st.progress} size={52} stroke={5} label={<span className="text-primary">{c.icon}</span>} />
                <div className="min-w-0 flex-1">
                  <h2 className="font-display text-[17px] font-semibold">{c.label}</h2>
                  <p className="mt-0.5 text-[13px] text-muted">{c.desc}</p>
                </div>
                <ArrowRight size={18} className="mt-1 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
              </div>
              <ul className="flex flex-col gap-1.5 text-[13px]">
                {st.lines.map((l) => (
                  <li key={l.label} className={cn('flex items-center gap-2', l.done ? 'text-ink-2' : 'text-muted')}>
                    {l.done ? <Check size={14} className="text-good" /> : <Circle size={12} className="mx-[1px]" />}
                    {l.label}
                  </li>
                ))}
              </ul>
              <p className="num text-xs font-semibold text-ink-2">{st.metric}</p>
            </button>
          );
        })}
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ChartCard
          title="Funnel, last 30 days"
          subtitle="From impressions to paying customers across every channel"
          table={{ columns: ['Stage', 'Count'], rows: [['Impressions', k.impressions], ['Link clicks', k.clicks], ['Lead opt-ins', k.optins], ['Sales', k.salesCount]] }}
        >
          <Funnel
            stages={[
              { label: 'Impressions', value: k.impressions },
              { label: 'Link clicks', value: k.clicks },
              { label: 'Lead opt-ins', value: k.optins },
              { label: 'Sales', value: k.salesCount },
            ]}
          />
        </ChartCard>
        <section className="panel grid grid-cols-2 gap-3 p-5" aria-label="Channel totals">
          <h3 className="col-span-2 font-display text-[15px] font-semibold">Totals, last 30 days</h3>
          <Tile label="Impressions" value={fmtCompact(k.impressions)} />
          <Tile label="Engagement rate" value={fmtPct(k.er)} />
          <Tile label="Click-through" value={k.impressions ? fmtPct(k.clicks / k.impressions) : '—'} />
          <Tile label="Opt-ins" value={fmtCompact(k.optins)} />
          <Tile label="Orders" value={fmtCompact(k.salesCount)} />
          <Tile label="Revenue" value={fmtMoney(k.revenue, { compact: true })} />
        </section>
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2.5">
      <p className="text-[11.5px] font-medium text-muted">{label}</p>
      <p className="num text-[19px] font-bold">{value}</p>
    </div>
  );
}
