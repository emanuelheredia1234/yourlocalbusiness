import { useMemo } from 'react';
import type { Project } from './types';
import { dailySeries, pctChange, sumSeries, type DayPoint } from './metrics';
import { useStore } from '@/store/useStore';
import { useNow } from './hooks';

export interface Kpis {
  series: DayPoint[];
  prev: DayPoint[];
  impressions: number;
  engagements: number;
  er: number;
  clicks: number;
  optins: number;
  revenue: number;
  salesCount: number;
  delta: { impressions: number | null; er: number | null; clicks: number | null; optins: number | null; revenue: number | null };
}

export function useKpis(project: Project | null, days: number): Kpis {
  const now = useNow(15_000);
  const posts = useStore((s) => s.posts);
  const sales = useStore((s) => s.sales);
  const ads = useStore((s) => s.ads);
  const settings = useStore((s) => s.settings);
  return useMemo(() => {
    const pid = project?.id;
    const input = {
      posts: posts.filter((p) => p.projectId === pid),
      sales: sales.filter((x) => x.projectId === pid || (!x.projectId && pid)),
      subscribers: project?.marketing.subscribers ?? [],
      ads: ads.filter((a) => a.projectId === pid),
      settings,
    };
    const all = dailySeries(input, days * 2, now);
    const prev = all.slice(0, days);
    const series = all.slice(days);
    const impressions = sumSeries(series, 'impressions');
    const engagements = sumSeries(series, 'engagements');
    const clicks = sumSeries(series, 'clicks');
    const optins = sumSeries(series, 'optins');
    const revenue = sumSeries(series, 'revenue');
    const salesCount = sumSeries(series, 'sales');
    const pImp = sumSeries(prev, 'impressions');
    const pEng = sumSeries(prev, 'engagements');
    const er = impressions ? engagements / impressions : 0;
    const per = pImp ? pEng / pImp : 0;
    return {
      series,
      prev,
      impressions,
      engagements,
      er,
      clicks,
      optins,
      revenue,
      salesCount,
      delta: {
        impressions: pctChange(impressions, pImp),
        er: per ? (er - per) / per : er ? null : 0,
        clicks: pctChange(clicks, sumSeries(prev, 'clicks')),
        optins: pctChange(optins, sumSeries(prev, 'optins')),
        revenue: pctChange(revenue, sumSeries(prev, 'revenue')),
      },
    };
  }, [project, posts, sales, ads, settings, days, Math.floor(now / 60_000)]); // eslint-disable-line react-hooks/exhaustive-deps
}
