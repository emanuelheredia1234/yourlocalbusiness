import { useMemo } from 'react';
import { ArrowRight, Check, Circle } from 'lucide-react';
import type { Channel } from '@/lib/types';
import { cn } from '@/lib/utils';
import { scoreSeo } from '@/ai/local/seo';
import { useKpis } from '@/lib/kpis';
import { useActiveProject, useStore } from '@/store/useStore';

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
  const signups = m.subscribers.length;

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
      progress: [!!m.leadMagnet, m.emails.length >= 5, signups > 0].filter(Boolean).length / 3,
      lines: [
        { label: 'Lead magnet', done: !!m.leadMagnet },
        { label: '5-email sequence', done: m.emails.length >= 5 },
        { label: 'Subscribers imported', done: signups > 0 },
      ],
      metric: `${signups} subscriber${signups === 1 ? '' : 's'}`,
    },
    social: {
      progress: [!!m.plan, posts.some((p) => p.source === 'batch'), scheduled + published > 0].filter(Boolean).length / 3,
      lines: [
        { label: '30-day plan', done: !!m.plan },
        { label: '7-day content batch', done: posts.some((p) => p.source === 'batch') },
        { label: 'Posts on your calendar', done: scheduled + published > 0 },
      ],
      metric: `${scheduled} planned · ${published} posted`,
    },
    ads: {
      progress: [ads.length > 0, ads.some((a) => a.creatives.length > 0), ads.some((a) => !!a.exportedAt)].filter(Boolean).length / 3,
      lines: [
        { label: 'Campaign created', done: ads.length > 0 },
        { label: 'Creatives generated', done: ads.some((a) => a.creatives.length > 0) },
        { label: 'Exported to an ad platform', done: ads.some((a) => !!a.exportedAt) },
      ],
      metric: `${ads.length} campaign plan${ads.length === 1 ? '' : 's'}`,
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

      <section className="panel p-5" aria-label="Last 30 days">
        <h3 className="font-display text-[15px] font-semibold">Last 30 days</h3>
        <p className="mb-3 text-[12.5px] text-muted">Real counts only. Reach, likes and clicks live on each network, and sales on your own checkout: open them there.</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Posted" value={String(k.posted)} />
          <Tile label="Posted by Manus" value={String(k.byManus)} />
          <Tile label="Planned" value={String(k.upcoming)} />
          <Tile label="Made with AI" value={String(k.made)} />
        </div>
      </section>
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
