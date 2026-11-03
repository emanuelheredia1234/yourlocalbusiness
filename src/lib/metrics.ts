import type { AdCampaign, GenerationLog, Post } from './types';
import { createRng, DAY_MS, toDateStr } from './utils';

// Counts this app knows for sure. A post counts as posted when Manus reported it posted or you
// marked it posted. Likes, views and clicks live on each network: nothing here estimates them.

export interface DayPoint {
  date: string;
  /** posts that went out that day */
  posted: number;
  /** posts on your calendar for that day */
  planned: number;
  /** things made with AI that day */
  made: number;
}

export function dailySeries(input: { posts: Post[]; genLog: GenerationLog[] }, days: number, now = Date.now()): DayPoint[] {
  const out: DayPoint[] = [];
  const index = new Map<string, DayPoint>();
  for (let i = days - 1; i >= 0; i--) {
    const date = toDateStr(new Date(now - i * DAY_MS));
    const pt: DayPoint = { date, posted: 0, planned: 0, made: 0 };
    out.push(pt);
    index.set(date, pt);
  }
  for (const post of input.posts) {
    if (post.status === 'published' && post.publishedAt) {
      const pt = index.get(toDateStr(new Date(post.publishedAt)));
      if (pt) pt.posted += 1;
    } else if (post.status === 'scheduled') {
      const pt = index.get(toDateStr(new Date(post.scheduledAt)));
      if (pt) pt.planned += 1;
    }
  }
  for (const g of input.genLog) {
    const pt = index.get(toDateStr(new Date(g.createdAt)));
    if (pt) pt.made += 1;
  }
  return out;
}

export function sumSeries(points: DayPoint[], key: keyof Omit<DayPoint, 'date'>): number {
  return points.reduce((s, p) => s + p[key], 0);
}

export function pctChange(cur: number, prev: number): number | null {
  if (!prev) return cur ? null : 0;
  return (cur - prev) / prev;
}

// ───────────────────────── Ads model ─────────────────────────
export function adDaily(c: AdCampaign, now = Date.now()): { date: string; spend: number; impressions: number; clicks: number; conversions: number }[] {
  if (!c.launchedAt || c.status === 'draft') return [];
  const start = c.launchedAt;
  const days = Math.min(c.durationDays, Math.floor((now - start) / DAY_MS) + 1);
  const p = c.projections;
  const perDay = c.durationDays ? 1 / c.durationDays : 0;
  const out = [];
  for (let i = 0; i < days; i++) {
    const rng = createRng(c.seed + i * 7919);
    const isToday = i === days - 1;
    const frac = isToday && c.status === 'active' ? Math.min(1, ((now - start) % DAY_MS) / DAY_MS + 0.05) : 1;
    const jitter = rng.float(0.82, 1.18) * frac;
    out.push({
      date: toDateStr(new Date(start + i * DAY_MS)),
      spend: p.spend * perDay * jitter * (c.status === 'paused' && isToday ? 0 : 1),
      impressions: p.impressions * perDay * jitter,
      clicks: p.clicks * perDay * jitter,
      conversions: p.conversions * perDay * jitter,
    });
  }
  return out;
}

