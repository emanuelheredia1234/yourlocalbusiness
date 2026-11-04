import type { ReactNode } from 'react';
import { Mail, Megaphone, Search, Target } from 'lucide-react';
import type { Channel } from '@/lib/types';
import { CHANNEL_ROUTES, navigate } from '@/lib/router';
import { useStore } from '@/store/useStore';

export const CHANNELS: { id: Channel; label: string; short: string; icon: ReactNode; desc: string }[] = [
  { id: 'seo', label: 'SEO sales page', short: 'SEO', icon: <Search size={15} />, desc: 'Metadata, live SEO score and a visual page editor with HTML export.' },
  { id: 'email', label: 'Email funnel', short: 'Email', icon: <Mail size={15} />, desc: 'Lead magnet, opt-in page and a 5-email nurture sequence you can simulate.' },
  { id: 'social', label: 'Social media', short: 'Social', icon: <Megaphone size={15} />, desc: '30-day campaign plan, a 7-day batch of ready-to-publish posts, and individual posts.' },
  { id: 'ads', label: 'Paid ads', short: 'Ads', icon: <Target size={15} />, desc: 'Audiences, A/B creatives, search ads and budget projections.' },
];

export function goChannel(c: Channel) {
  useStore.getState().updateMarketing({ lastChannel: c });
  navigate(CHANNEL_ROUTES[c]);
}

/**
 * The channel switcher that sat at the top of every Marketing page. The sidebar's Marketing group
 * (Overview · SEO page · Email · Social · Ads, with the new-leads count on Email) replaces it, so it
 * renders nothing; Phase 2 deletes this file and its imports.
 */
export function MarketingNav() {
  return null;
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
