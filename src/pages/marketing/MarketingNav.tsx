import type { ReactNode } from 'react';
import { LayoutGrid, Mail, Megaphone, Search, Target } from 'lucide-react';
import type { Channel } from '@/lib/types';
import { cn } from '@/lib/utils';
import { CHANNEL_ROUTES, navigate, useRoute } from '@/lib/router';
import { useStore } from '@/store/useStore';

export const CHANNELS: { id: Channel; label: string; short: string; icon: ReactNode; desc: string }[] = [
  { id: 'seo', label: 'SEO sales page', short: 'SEO', icon: <Search size={15} />, desc: 'Metadata, live SEO score and a visual page editor with HTML export.' },
  { id: 'email', label: 'Email funnel', short: 'Email', icon: <Mail size={15} />, desc: 'Lead magnet, opt-in page and a 5-email nurture sequence you can simulate.' },
  { id: 'social', label: 'Social media', short: 'Social', icon: <Megaphone size={15} />, desc: '30-day campaign plan and a 7-day batch of ready-to-publish posts.' },
  { id: 'ads', label: 'Paid ads', short: 'Ads', icon: <Target size={15} />, desc: 'Audiences, A/B creatives, search ads and budget projections.' },
];

export function goChannel(c: Channel) {
  useStore.getState().updateMarketing({ lastChannel: c });
  navigate(CHANNEL_ROUTES[c]);
}

/** Channel switcher shown at the top of every Marketing Hub page. */
export function MarketingNav() {
  const route = useRoute();
  return (
    <nav aria-label="Marketing channels" className="scroll-thin -mx-1 overflow-x-auto px-1">
      <div className="inline-flex min-w-max items-center gap-1 rounded-lg border border-line bg-surface p-1">
        <button className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-semibold transition-colors', route === 'marketing' ? 'bg-ink text-surface' : 'text-muted hover:bg-surface-2 hover:text-ink')} onClick={() => navigate('marketing')} aria-current={route === 'marketing' ? 'page' : undefined}>
          <LayoutGrid size={15} /> Overview
        </button>
        {CHANNELS.map((c) => {
          const active = route === CHANNEL_ROUTES[c.id];
          return (
            <button key={c.id} className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-semibold transition-colors', active ? 'bg-ink text-surface' : 'text-muted hover:bg-surface-2 hover:text-ink')} onClick={() => goChannel(c.id)} aria-current={active ? 'page' : undefined}>
              {c.icon} {c.short}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export function MarketingHeader({ eyebrow, title, desc, actions }: { eyebrow: string; title: string; desc: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <MarketingNav />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow mb-1">{eyebrow}</p>
          <h1 className="page-title">{title}</h1>
          <p className="mt-1 max-w-[680px] text-[13.5px] text-muted">{desc}</p>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </header>
    </div>
  );
}
