// The Analytics tabs' arithmetic: the 7/30-day window, totals across networks and ad accounts, labels.
import { describe, expect, it } from 'vitest';
import { adsTotals, inRange, money, pct, rankLabel, safeLink, socialTotals, statusView } from './compute';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('the window', () => {
  it('counts what falls in the last n days (undated items count)', () => {
    expect(inRange(ago(3), 7, NOW)).toBe(true);
    expect(inRange(ago(10), 7, NOW)).toBe(false);
    expect(inRange(undefined, 7, NOW)).toBe(true);
    expect(inRange('2026-11-01', 7, NOW)).toBe(true);
  });
});

describe('social', () => {
  const data = {
    networks: [
      { network: 'instagram' as const, origin: 'public' as const, followers: 100, topPosts: [{ id: 'a', text: 'new', at: ago(2), likes: 10, comments: 2 }, { id: 'b', text: 'old', at: ago(20), likes: 99 }] },
      { network: 'facebook' as const, origin: 'own' as const, followers: 50, series: [{ date: ago(1).slice(0, 10), reach: 30 }, { date: ago(15).slice(0, 10), reach: 70 }] },
    ],
  };
  it('followers summed; posts, engagement and reach only in the range; reach from own accounts only', () => {
    const w = socialTotals(data, 7, NOW);
    expect(w.followers).toBe(150);
    expect(w.posts).toBe(1);
    expect(w.engagement).toBe(12);
    expect(w.reach).toBe(30);
    expect(w.topPosts.map((p) => p.text)).toEqual(['new']);
    const m = socialTotals(data, 30, NOW);
    expect(m.reach).toBe(100);
    expect(m.topPosts[0].text).toBe('old');
  });
  it('no connected account: reach is null (shown as –)', () => {
    expect(socialTotals({ networks: [data.networks[0]] }, 30, NOW).reach).toBeNull();
  });

  it('says when an engagement number is a connected account’s recent total rather than this range’s posts', () => {
    const own = { network: 'tiktok' as const, origin: 'own' as const, followers: 10, engagement: 40 };
    expect(socialTotals({ networks: [own] }, 7, NOW)).toMatchObject({ engagement: 40, engagementTotals: true, posts: 0 });
    const withPosts = { ...own, topPosts: [{ id: 'p', text: 'a', at: ago(1), likes: 3 }] };
    expect(socialTotals({ networks: [withPosts] }, 7, NOW)).toMatchObject({ engagement: 3, engagementTotals: false, posts: 1 });
  });
});

describe('ads', () => {
  it('sums Google and Meta; a 7-day range uses the per-day series', () => {
    const d = {
      own: [
        { platform: 'google_ads' as const, currency: 'USD', spend: 100, impressions: 1000, clicks: 50, conversions: 2, series: [{ date: ago(2).slice(0, 10), spend: 10, clicks: 5 }], campaigns: [] },
        { platform: 'meta_ads' as const, currency: 'USD', spend: 50, impressions: 1000, clicks: 10, conversions: 1, series: [{ date: ago(2).slice(0, 10), spend: 5, clicks: 1 }, { date: ago(20).slice(0, 10), spend: 45, clicks: 9 }], campaigns: [] },
      ],
      competitors: [],
    };
    expect(adsTotals(d, 30, NOW)).toMatchObject({ spend: 150, clicks: 60, impressions: 2000, conversions: 3, ctr: 0.03 });
    expect(adsTotals(d, 7, NOW)).toMatchObject({ spend: 15, clicks: 6 });
  });
});

describe('labels', () => {
  it('ranks, rates, money and statuses', () => {
    expect(rankLabel(3)).toBe('#3');
    expect(rankLabel(null)).toBe('Not in top 10');
    expect(pct(0.042)).toBe('4.2%');
    expect(pct(42)).toBe('42%');
    expect(money(120.5)).toBe('$120.50');
    expect(statusView('error', 'CUSTOMER_CAP').label).toBe('Over today’s analytics limit');
    expect(statusView('not_connected', 'NEEDS_RECONNECT').label).toBe('Reconnect needed');
    expect(statusView(undefined).label).toBe('Not updated yet');
  });
});

describe('links from someone else’s data', () => {
  it('only plain http(s) web addresses become links', () => {
    expect(safeLink('https://instagram.com/p/1')).toBe('https://instagram.com/p/1');
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'https://user:pw@evil.example/', '//evil.example', '', undefined]) expect(safeLink(bad)).toBeUndefined();
  });
  it('a top post with a javascript: link keeps its text but loses the link', () => {
    const t = socialTotals({ networks: [{ network: 'x', origin: 'public', followers: 1, topPosts: [{ id: 'z', text: 'hi', url: 'javascript:alert(1)', at: ago(1), likes: 1 }] }] }, 7, NOW);
    expect(t.topPosts[0].text).toBe('hi');
    expect(t.topPosts[0].url).toBeUndefined();
  });
});
