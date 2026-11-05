// Pure helpers for the Analytics tabs: the range window, totals per range, rank matching labels and the
// plain words for each source status. Third-party text is data: these return strings for React to render as
// text, never HTML.
import type { AdsData, AnalyticsSnapshot, EmailData, SocialData, SocialNetworkStats, SourceStatus } from '@/lib/integrations/types';

const DAY = 86_400_000;

/** Is an ISO date (or YYYY-MM-DD) within the last `days` days of `now`? Undated items count. */
export function inRange(date: string | undefined, days: number, now = Date.now()): boolean {
  if (!date) return true;
  const t = Date.parse(date.length === 10 ? `${date}T00:00:00Z` : date);
  if (!Number.isFinite(t)) return true;
  return t >= now - days * DAY;
}

export const sum = (xs: (number | undefined)[]) => xs.reduce<number>((s, x) => s + (typeof x === 'number' && Number.isFinite(x) ? x : 0), 0);

export const engagementOf = (p: { likes?: number; comments?: number; shares?: number }) => sum([p.likes, p.comments, p.shares]);

export interface SocialTotals {
  followers: number;
  posts: number;
  engagement: number;
  /** own-insights networks only; null when none is connected */
  reach: number | null;
  byNetwork: { network: SocialNetworkStats['network']; followers: number }[];
  topPosts: { key: string; network: SocialNetworkStats['network']; text: string; url?: string; engagement: number; at?: string }[];
}

export function socialTotals(data: SocialData | undefined, days: number, now = Date.now()): SocialTotals {
  const networks = Array.isArray(data?.networks) ? data!.networks : [];
  let posts = 0;
  let engagement = 0;
  let reach: number | null = null;
  const top: SocialTotals['topPosts'] = [];
  for (const n of networks) {
    const inWindow = (n.topPosts ?? []).filter((p) => inRange(p.at, days, now));
    const dated = (n.topPosts ?? []).some((p) => p.at);
    posts += dated ? inWindow.length : n.postsCount ?? inWindow.length;
    const series = (n.series ?? []).filter((s) => inRange(s.date, days, now));
    const seriesEng = sum(series.map((s) => s.engagement));
    engagement += inWindow.length ? sum(inWindow.map(engagementOf)) : seriesEng || (n.engagement ?? 0);
    if (n.origin === 'own') {
      const r = series.length ? sum(series.map((s) => s.reach)) : n.reach ?? 0;
      reach = (reach ?? 0) + r;
    }
    for (const p of inWindow) top.push({ key: `${n.network}:${p.id}`, network: n.network, text: p.text, url: p.url, engagement: engagementOf(p), at: p.at });
  }
  top.sort((a, b) => b.engagement - a.engagement);
  return {
    followers: sum(networks.map((n) => n.followers)),
    posts,
    engagement,
    reach,
    byNetwork: networks.filter((n) => typeof n.followers === 'number').map((n) => ({ network: n.network, followers: n.followers ?? 0 })),
    topPosts: top.slice(0, 5),
  };
}

export interface AdsTotals {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  currency: string;
  series: { date: string; spend: number; clicks: number }[];
}

export function adsTotals(data: AdsData | undefined, days: number, now = Date.now()): AdsTotals {
  const own = Array.isArray(data?.own) ? data!.own : [];
  const byDate = new Map<string, { spend: number; clicks: number }>();
  let spend = 0;
  let clicks = 0;
  for (const a of own) {
    for (const s of a.series ?? []) {
      if (!inRange(s.date, days, now)) continue;
      const d = byDate.get(s.date) ?? { spend: 0, clicks: 0 };
      d.spend += s.spend || 0;
      d.clicks += s.clicks || 0;
      byDate.set(s.date, d);
    }
  }
  const series = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));
  // a range shorter than what was fetched: the per-day series; otherwise the account totals
  const useSeries = days < 30 && series.length > 0;
  spend = useSeries ? sum(series.map((s) => s.spend)) : sum(own.map((a) => a.spend));
  clicks = useSeries ? sum(series.map((s) => s.clicks)) : sum(own.map((a) => a.clicks));
  const impressions = sum(own.map((a) => a.impressions));
  return {
    spend,
    clicks,
    impressions,
    conversions: sum(own.map((a) => a.conversions)),
    ctr: impressions > 0 ? sum(own.map((a) => a.clicks)) / impressions : 0,
    currency: own[0]?.currency || 'USD',
    series,
  };
}

export interface EmailTotals {
  sent: number;
  series: EmailData['series'];
}

export function emailSeries(data: EmailData | undefined, days: number, now = Date.now()): EmailData['series'] {
  return (Array.isArray(data?.series) ? data!.series : []).filter((s) => inRange(s.date, days, now));
}

/** A rate (0–1, or already a percent above 1) as "12.3%". */
export function pct(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–';
  const v = n > 1 ? n : n * 100;
  return `${v.toFixed(v >= 10 ? 0 : 1)}%`;
}

export function money(n: number | undefined, currency = 'USD'): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  try {
    const d = Math.abs(v) >= 10_000 ? 0 : 2;
    return v.toLocaleString('en-US', { style: 'currency', currency, minimumFractionDigits: d, maximumFractionDigits: d });
  } catch {
    return `$${v.toFixed(2)}`;
  }
}

/** "#3", or "Not in top 10". */
export const rankLabel = (r: number | null | undefined) => (typeof r === 'number' && r > 0 ? `#${r}` : 'Not in top 10');

// ───────────── statuses ─────────────

const CODE_TEXT: Record<string, string> = {
  CUSTOMER_CAP: 'Over today’s analytics limit',
  CUSTOMER_BLOCKED: 'Analytics are paused for your account',
  RATE_LIMITED: 'Busy: try again later',
  INTERRUPTED: 'Interrupted: press Update again',
  NEEDS_RECONNECT: 'Reconnect needed',
  NOT_CONNECTED: 'Not connected',
  TOO_EXPENSIVE: 'Skipped (over cost limit)',
  UNAVAILABLE: 'Temporarily unavailable',
};

export interface StatusView {
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  label: string;
}

export function statusView(status: SourceStatus | undefined, errorCode?: string): StatusView {
  switch (status) {
    case 'ok':
      return { tone: 'good', label: 'Up to date' };
    case 'partial':
      return { tone: 'warn', label: 'Some data missing' };
    case 'error':
      return { tone: 'bad', label: (errorCode && CODE_TEXT[errorCode]) || 'Couldn’t update' };
    case 'not_connected':
      return { tone: 'neutral', label: errorCode === 'NEEDS_RECONNECT' ? 'Reconnect needed' : 'Not connected' };
    case 'skipped':
      return { tone: 'neutral', label: (errorCode && CODE_TEXT[errorCode]) || 'Skipped' };
    case 'pending':
      return { tone: 'neutral', label: 'Still loading' };
    default:
      return { tone: 'neutral', label: 'Not updated yet' };
  }
}

/** The snapshot shows data worth drawing (it was fetched at least once). */
export const hasData = (s: AnalyticsSnapshot | undefined) => !!s?.fetchedAt;
