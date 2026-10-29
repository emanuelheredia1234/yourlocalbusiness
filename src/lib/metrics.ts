import type { AdCampaign, AppSettings, Post, PostPlatform, PostType, SaleRecord, StyleId, Subscriber } from './types';
import { createRng, DAY_MS, hashStr, toDateStr } from './utils';
import { PLATFORMS } from '@/ai/knowledge';

// ───────────────────────── Post performance model ─────────────────────────
// Deterministic per post (seeded), shaped by platform, format, style and post type,
// then revealed over time with a saturating growth curve so live counters tick up.

export interface PostMetrics {
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  conversions: number;
  engagements: number;
  engagementRate: number;
}

const ER: Record<PostType, [number, number]> = {
  educational: [0.04, 0.072],
  tip: [0.042, 0.08],
  question: [0.05, 0.098],
  sales: [0.016, 0.036],
  bts: [0.04, 0.07],
};
const CTR: Record<PostType, [number, number]> = {
  educational: [0.006, 0.012],
  tip: [0.004, 0.009],
  question: [0.002, 0.006],
  sales: [0.016, 0.03],
  bts: [0.004, 0.008],
};
const STYLE_MULT: Record<StyleId, number> = {
  minimal: 0.95,
  neon: 1.12,
  editorial: 1.02,
  isometric: 0.98,
  handcrafted: 1.08,
  ugc: 1.22,
  kinetic: 1.1,
  split: 1.06,
  cinematic: 1.0,
  talking: 1.14,
};
const PLATFORM_ER: Record<PostPlatform, number> = { instagram: 1, facebook: 0.72, tiktok: 1.28, linkedin: 0.86, x: 0.6 };
const TAU_H: Record<PostPlatform, number> = { instagram: 6, facebook: 8, tiktok: 4, linkedin: 12, x: 2 };

export function followersFor(settings: AppSettings | undefined, platform: PostPlatform): number {
  const a = settings?.accounts?.[platform];
  return a?.connected && a.followers > 0 ? a.followers : 1200;
}

export function postFinal(post: Post, followers = 1200): PostMetrics {
  const rng = createRng((post.seed || 1) ^ hashStr(post.id));
  const pf = PLATFORMS[post.platform];
  const video = post.format === 'video';
  let reach = followers * rng.float(0.22, 0.46) * pf.reachMult * (video ? 1.7 : 1) * (STYLE_MULT[post.style] ?? 1);
  if (rng.chance(0.07)) reach *= rng.float(2.6, 5.5); // occasional breakout
  reach = Math.max(40, reach);
  const impressions = reach * rng.float(1.22, 1.58);
  const er = rng.float(...ER[post.postType]) * PLATFORM_ER[post.platform] * (video ? 1.12 : 1);
  const engagements = impressions * er;
  const likes = engagements * 0.7;
  const comments = engagements * (post.postType === 'question' ? 0.21 : 0.07);
  const shares = engagements * (post.postType === 'tip' ? 0.11 : 0.06);
  const saves = engagements * (post.postType === 'educational' || post.postType === 'tip' ? 0.15 : 0.04);
  const clicks = impressions * rng.float(...CTR[post.postType]);
  const conversions = clicks * (post.postType === 'sales' ? rng.float(0.03, 0.065) : rng.float(0.004, 0.014));
  return {
    impressions,
    reach,
    likes,
    comments,
    shares,
    saves,
    clicks,
    conversions,
    engagements: likes + comments + shares + saves,
    engagementRate: impressions ? (likes + comments + shares + saves) / impressions : 0,
  };
}

/** Metrics as of `now`: they grow toward the final values after publishing. */
export function postLive(post: Post, now = Date.now(), followers = 1200): PostMetrics {
  const fin = postFinal(post, followers);
  if (post.status !== 'published' || !post.publishedAt) return scale(fin, 0);
  const hours = Math.max(0, (now - new Date(post.publishedAt).getTime()) / 3_600_000);
  // Front-loaded growth: a post earns a visible share in its first minutes, most of its reach within a day.
  const k = 1 - Math.exp(-Math.pow(hours / TAU_H[post.platform], 0.6));
  return scale(fin, k);
}

function scale(m: PostMetrics, k: number): PostMetrics {
  const r = (n: number) => Math.round(n * k);
  const out = {
    impressions: r(m.impressions),
    reach: r(m.reach),
    likes: r(m.likes),
    comments: r(m.comments),
    shares: r(m.shares),
    saves: r(m.saves),
    clicks: r(m.clicks),
    conversions: Math.floor(m.conversions * k),
    engagements: 0,
    engagementRate: m.engagementRate,
  };
  out.engagements = out.likes + out.comments + out.shares + out.saves;
  return out;
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

// ───────────────────────── Aggregations for dashboards ─────────────────────────
export interface DayPoint {
  date: string;
  impressions: number;
  engagements: number;
  clicks: number;
  optins: number;
  sales: number;
  revenue: number;
  posts: number;
}

export function dailySeries(
  input: { posts: Post[]; sales: SaleRecord[]; subscribers: Subscriber[]; ads: AdCampaign[]; settings?: AppSettings },
  days: number,
  now = Date.now(),
): DayPoint[] {
  const out: DayPoint[] = [];
  const index = new Map<string, DayPoint>();
  for (let i = days - 1; i >= 0; i--) {
    const date = toDateStr(new Date(now - i * DAY_MS));
    const pt: DayPoint = { date, impressions: 0, engagements: 0, clicks: 0, optins: 0, sales: 0, revenue: 0, posts: 0 };
    out.push(pt);
    index.set(date, pt);
  }
  for (const post of input.posts) {
    if (post.status !== 'published' || !post.publishedAt) continue;
    const m = postLive(post, now, followersFor(input.settings, post.platform));
    // spread a post's results over the first three days after publishing
    const t = new Date(post.publishedAt).getTime();
    const split = [0.68, 0.22, 0.1];
    split.forEach((share, k) => {
      const pt = index.get(toDateStr(new Date(t + k * DAY_MS)));
      if (!pt || t + k * DAY_MS > now) return;
      pt.impressions += m.impressions * share;
      pt.engagements += m.engagements * share;
      pt.clicks += m.clicks * share;
    });
    const pd = index.get(toDateStr(new Date(t)));
    if (pd) pd.posts += 1;
  }
  for (const s of input.subscribers) {
    if (s.source === 'test') continue; // your own test sign-ups never count as leads
    const pt = index.get(toDateStr(new Date(s.joinedAt)));
    if (pt) pt.optins += 1;
  }
  for (const s of input.sales) {
    const pt = index.get(toDateStr(new Date(s.createdAt)));
    if (pt) {
      pt.sales += s.qty;
      pt.revenue += s.amount;
    }
  }
  for (const c of input.ads) {
    for (const d of adDaily(c, now)) {
      const pt = index.get(d.date);
      if (pt) {
        pt.impressions += d.impressions;
        pt.clicks += d.clicks;
      }
    }
  }
  return out.map((p) => ({ ...p, impressions: Math.round(p.impressions), engagements: Math.round(p.engagements), clicks: Math.round(p.clicks), revenue: Math.round(p.revenue * 100) / 100 }));
}

export function sumSeries(points: DayPoint[], key: keyof Omit<DayPoint, 'date'>): number {
  return points.reduce((s, p) => s + (p[key] as number), 0);
}

export function pctChange(cur: number, prev: number): number | null {
  if (!prev) return cur ? null : 0;
  return (cur - prev) / prev;
}
