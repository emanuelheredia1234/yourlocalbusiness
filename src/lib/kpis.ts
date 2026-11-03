import { useMemo } from 'react';
import type { Project } from './types';
import { dailySeries, pctChange, sumSeries, type DayPoint } from './metrics';
import { useStore } from '@/store/useStore';
import { useNow } from './hooks';

/** Real counts for a project over the last `days`, and the same for the days before. */
export interface Kpis {
  series: DayPoint[];
  prev: DayPoint[];
  /** went out in the period (Manus reported it, or you marked it) */
  posted: number;
  /** of those, posted by Manus */
  byManus: number;
  /** on your calendar from now on */
  upcoming: number;
  /** on your calendar, time passed, not posted */
  due: number;
  /** made with AI in the period */
  made: number;
  delta: { posted: number | null; made: number | null };
}

export function useKpis(project: Project | null, days: number): Kpis {
  const now = useNow(60_000);
  const posts = useStore((s) => s.posts);
  const genLog = useStore((s) => s.genLog);
  return useMemo(() => {
    const pid = project?.id;
    const mine = posts.filter((p) => p.projectId === pid);
    const all = dailySeries({ posts: mine, genLog: genLog.filter((g) => g.projectId === pid) }, days * 2, now);
    const prev = all.slice(0, days);
    const series = all.slice(days);
    const since = now - days * 24 * 3600_000;
    const posted = sumSeries(series, 'posted');
    const made = sumSeries(series, 'made');
    return {
      series,
      prev,
      posted,
      byManus: mine.filter((p) => p.status === 'published' && p.publishedBy === 'manus' && p.publishedAt && new Date(p.publishedAt).getTime() >= since).length,
      upcoming: mine.filter((p) => p.status === 'scheduled' && new Date(p.scheduledAt).getTime() > now).length,
      due: mine.filter((p) => p.status === 'scheduled' && new Date(p.scheduledAt).getTime() <= now && (!p.external || p.external.state === 'failed')).length,
      made,
      delta: { posted: pctChange(posted, sumSeries(prev, 'posted')), made: pctChange(made, sumSeries(prev, 'made')) },
    };
  }, [project, posts, genLog, days, Math.floor(now / 60_000)]); // eslint-disable-line react-hooks/exhaustive-deps
}
