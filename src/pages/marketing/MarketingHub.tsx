import { useMemo, type ReactNode } from 'react';
import { ArrowRight, Check, Globe, Mail, Megaphone, Target } from 'lucide-react';
import type { Channel } from '@/lib/types';
import { cn } from '@/lib/utils';
import { scoreSeo } from '@/ai/local/seo';
import { useKpis } from '@/lib/kpis';
import { CHANNEL_ROUTES, navigate } from '@/lib/router';
import { useNewLeadCount } from '@/store/leads';
import { useActiveProject, useStore } from '@/store/useStore';
import { InfoTip, PageHeader, ProgressBar, StatStrip } from '@/components/ui/primitives';

/** The four channels, with the sidebar's names and icons. */
const CHANNELS: { id: Channel; label: string; icon: ReactNode; desc: string }[] = [
  { id: 'seo', label: 'SEO page', icon: <Globe />, desc: 'A page people find on Google that turns visits into customers.' },
  { id: 'email', label: 'Email', icon: <Mail />, desc: 'A free guide, an opt-in page and welcome emails in your voice.' },
  { id: 'social', label: 'Social', icon: <Megaphone />, desc: 'A 30-day plan and a week of posts, ready to go out.' },
  { id: 'ads', label: 'Ads', icon: <Target />, desc: 'A local campaign: targeting, three ad versions and search ads.' },
];

function goChannel(c: Channel) {
  useStore.getState().updateMarketing({ lastChannel: c });
  navigate(CHANNEL_ROUTES[c]);
}

export default function MarketingHub() {
  const project = useActiveProject()!;
  const allPosts = useStore((s) => s.posts);
  const allAds = useStore((s) => s.ads);
  const posts = useMemo(() => allPosts.filter((p) => p.projectId === project.id), [allPosts, project.id]);
  const ads = useMemo(() => allAds.filter((a) => a.projectId === project.id), [allAds, project.id]);
  const k = useKpis(project, 30);
  const newLeads = useNewLeadCount(project);
  const m = project.marketing;
  const seo = m.seo ? scoreSeo(m.seo, m.salesPage) : null;
  const scheduled = posts.filter((p) => p.status === 'scheduled').length;
  const published = posts.filter((p) => p.status === 'published').length;
  const signups = m.subscribers.length;

  const status: Record<Channel, { lines: { label: string; done: boolean }[]; metric: string }> = {
    seo: {
      lines: [
        { label: 'Keyword and metadata', done: !!m.seo },
        { label: 'Page written', done: !!m.salesPage },
        { label: 'SEO score 80+', done: (seo?.score ?? 0) >= 80 },
      ],
      metric: seo ? `SEO score ${seo.score}` : 'Not started',
    },
    email: {
      lines: [
        { label: 'Lead magnet', done: !!m.leadMagnet },
        { label: 'Five welcome emails', done: m.emails.length >= 5 },
        { label: 'Subscribers imported', done: signups > 0 },
      ],
      metric: [`${signups} subscriber${signups === 1 ? '' : 's'}`, newLeads > 0 && !__ARTIFACT_BUILD__ ? `${newLeads} new lead${newLeads === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '),
    },
    social: {
      lines: [
        { label: '30-day plan', done: !!m.plan },
        { label: 'A week of posts', done: posts.some((p) => p.source === 'batch') },
        { label: 'Posts on your calendar', done: scheduled + published > 0 },
      ],
      metric: `${scheduled} planned · ${published} posted`,
    },
    ads: {
      lines: [
        { label: 'Campaign planned', done: ads.length > 0 },
        { label: 'Ad versions written', done: ads.some((a) => a.creatives.length > 0) },
        { label: 'Taken to an ad platform', done: ads.some((a) => !!a.exportedAt) },
      ],
      metric: `${ads.length} campaign plan${ads.length === 1 ? '' : 's'}`,
    },
  };

  return (
    <div>
      <PageHeader title="Marketing" description="Four channels, one brand." />

      <section className="grid grid-cols-1 items-start gap-4 md:grid-cols-2" aria-label="Channels">
        {CHANNELS.map((c) => {
          const st = status[c.id];
          const done = st.lines.filter((l) => l.done).length;
          return (
            <button key={c.id} type="button" className="card card-interactive group flex min-w-0 flex-col gap-4 p-5 text-left" onClick={() => goChannel(c.id)}>
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-pop bg-surface-3 text-ink-2 [&>svg]:size-5" aria-hidden="true">
                  {c.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-h3 text-ink">{c.label}</span>
                  <span className="mt-0.5 block text-small text-muted sm:truncate" title={c.desc}>
                    {c.desc}
                  </span>
                </span>
              </div>
              <ProgressBar value={done} max={3} segments={3} label={`${done} of 3`} />
              <ul className="flex flex-col gap-2">
                {st.lines.map((l) => (
                  <li key={l.label} className={cn('flex items-center gap-2.5 text-small', l.done ? 'text-ink-2' : 'text-muted')}>
                    <CheckCircle done={l.done} />
                    {l.label}
                  </li>
                ))}
              </ul>
              <span className="mt-auto flex items-center justify-between gap-3 border-t border-line pt-3">
                <span className="num truncate font-mono text-small text-ink-2">{st.metric}</span>
                <span className="link inline-flex shrink-0 items-center gap-1 text-small group-hover:underline">
                  Open {c.label} <ArrowRight size={14} aria-hidden="true" />
                </span>
              </span>
            </button>
          );
        })}
      </section>

      <section className="mt-10" aria-label="Last 30 days">
        <h2 className="mb-4 inline-flex items-center gap-1 text-h2 text-ink">
          Last 30 days
          <InfoTip label="What’s counted">Real counts only. Reach, likes and clicks live on each network, and sales on your own checkout: open them there.</InfoTip>
        </h2>
        <StatStrip
          items={[
            { label: 'Posted', value: k.posted },
            { label: 'Posted by Manus', value: k.byManus },
            { label: 'Planned', value: k.upcoming },
            { label: 'Made with AI', value: k.made },
          ]}
        />
      </section>
    </div>
  );
}

/** A 16px check circle: filled when done, an empty ring when not. */
function CheckCircle({ done }: { done: boolean }) {
  return done ? (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary" aria-hidden="true">
      <Check size={12} strokeWidth={3} />
    </span>
  ) : (
    <span className="h-4 w-4 shrink-0 rounded-full border-[1.5px] border-line-3" aria-hidden="true" />
  );
}
