import { useMemo } from 'react';
import type { GenerationLog, Post, Project } from './types';
import { dailySeries, pctChange, sumSeries, type DayPoint } from './metrics';
import { useStore } from '@/store/useStore';
import { useNow } from './hooks';

/** Real counts for a project over the last `days`, and the same for the days before. */
export interface Kpis {
  series: DayPoint[];
  prev: DayPoint[];
  /** start of the first day counted (local midnight): every count uses this same boundary */
  since: number;
  /** went out in the period (the app posted it, or you marked it) */
  posted: number;
  /** of those, posted from the app (older posts: by Manus) */
  byApp: number;
  /** on your calendar from now on */
  upcoming: number;
  /** on your calendar, time passed, not posted */
  due: number;
  /** made with AI in the period */
  made: number;
  delta: { posted: number | null; made: number | null };
}

/** The counts for one project (the Analytics page, the Dashboard, and the assistant's get_analytics). */
export function computeKpis(input: { projectId: string | undefined; posts: Post[]; genLog: GenerationLog[] }, days: number, now = Date.now()): Kpis {
  const pid = input.projectId;
  const mine = input.posts.filter((p) => p.projectId === pid);
  const all = dailySeries({ posts: mine, genLog: input.genLog.filter((g) => g.projectId === pid) }, days * 2, now);
  const prev = all.slice(0, days);
  const series = all.slice(days);
  const [y, m, d] = series[0].date.split('-').map(Number);
  const since = new Date(y, m - 1, d).getTime();
  const posted = sumSeries(series, 'posted');
  const made = sumSeries(series, 'made');
  return {
    series,
    prev,
    since,
    posted,
    byApp: sumSeries(series, 'byApp'),
    upcoming: mine.filter((p) => p.status === 'scheduled' && new Date(p.scheduledAt).getTime() > now).length,
    due: mine.filter((p) => p.status === 'scheduled' && new Date(p.scheduledAt).getTime() <= now && (!p.external || p.external.state === 'failed')).length,
    made,
    delta: { posted: pctChange(posted, sumSeries(prev, 'posted')), made: pctChange(made, sumSeries(prev, 'made')) },
  };
}

export function useKpis(project: Project | null, days: number): Kpis {
  const now = useNow(60_000);
  const posts = useStore((s) => s.posts);
  const genLog = useStore((s) => s.genLog);
  return useMemo(() => computeKpis({ projectId: project?.id, posts, genLog }, days, now), [project, posts, genLog, days, Math.floor(now / 60_000)]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** A project's posts that went out since `since`, newest first (the Analytics page's list and breakdowns). */
export function postedSince(posts: Post[], projectId: string, since: number): Post[] {
  return posts
    .filter((p) => p.projectId === projectId && p.status === 'published' && p.publishedAt && new Date(p.publishedAt).getTime() >= since)
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
}

/** Counts per key, biggest first. */
export function countBy<K extends string>(items: K[]): { key: K; n: number }[] {
  const map = new Map<K, number>();
  for (const k of items) map.set(k, (map.get(k) ?? 0) + 1);
  return [...map.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);
}
