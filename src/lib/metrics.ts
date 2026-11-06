import type { GenerationLog, Post } from './types';
import { DAY_MS, toDateStr } from './utils';

// Counts this app knows for sure. A post counts as posted when the app posted it (or Manus reported it
// posted, older posts) or you marked it posted. Likes, views and clicks live on each network: nothing here estimates them.

export interface DayPoint {
  date: string;
  /** posts that went out that day */
  posted: number;
  /** of those, posted from the app (through a connected account; older posts: by Manus) */
  byApp: number;
  /** posts on your calendar for that day */
  planned: number;
  /** things made with AI that day */
  made: number;
}

/** Posted from the app: through a connected account ('api'), or by Manus (older posts, 'manus'). */
export const postedFromApp = (post: Pick<Post, 'publishedBy'>): boolean => post.publishedBy === 'api' || post.publishedBy === 'manus';

export function dailySeries(input: { posts: Post[]; genLog: GenerationLog[] }, days: number, now = Date.now()): DayPoint[] {
  const out: DayPoint[] = [];
  const index = new Map<string, DayPoint>();
  for (let i = days - 1; i >= 0; i--) {
    const date = toDateStr(new Date(now - i * DAY_MS));
    const pt: DayPoint = { date, posted: 0, byApp: 0, planned: 0, made: 0 };
    out.push(pt);
    index.set(date, pt);
  }
  for (const post of input.posts) {
    if (post.status === 'published' && post.publishedAt) {
      const pt = index.get(toDateStr(new Date(post.publishedAt)));
      if (pt) {
        pt.posted += 1;
        if (postedFromApp(post)) pt.byApp += 1;
      }
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
