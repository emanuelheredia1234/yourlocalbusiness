// The four Analytics tabs, drawn once per state (as on the server: no effects run): ok, empty, not connected,
// error, pending and over the analytics limit; third-party text stays text; and the artifact build shows a
// Callout instead of anything server-backed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import type { AdsData, AnalyticsSnapshot, EmailData, SeoData, SocialData } from '@/lib/integrations/types';
import type { Project } from '@/lib/types';

// Rendered on the server, a zustand hook shows the store's first state: read the current one instead.
const live = <S,>(store: { getState: () => S }) => Object.assign(<T,>(select: (s: S) => T = (s) => s as unknown as T) => select(store.getState()), store);
vi.mock('@/store/analytics', async (original) => {
  const real = await original<typeof import('@/store/analytics')>();
  const useAnalytics = live(real.useAnalytics);
  return {
    ...real,
    useAnalytics,
    useConnections: () => {
      const byPlatform: Record<string, unknown> = {};
      for (const c of real.useAnalytics.getState().connections) byPlatform[c.platform] = c;
      return { byPlatform, enabled: real.useAnalytics.getState().connectionsEnabled, refresh: async () => {} };
    },
  };
});
vi.mock('@/store/useStore', async (original) => {
  const real = await original<typeof import('@/store/useStore')>();
  return { ...real, useStore: live(real.useStore), useActiveProject: () => real.getActiveProject() };
});

const { useAnalytics } = await import('@/store/analytics');
const { useStore } = await import('@/store/useStore');
const { newProject, defaultSettings } = await import('@/store/defaults');
const { SocialAnalytics } = await import('../social/SocialAnalytics');
const { AdsAnalytics } = await import('../ads/AdsAnalytics');
const { SeoAnalytics } = await import('../seo/SeoAnalytics');
const { EmailAnalytics } = await import('../email/EmailAnalytics');

const NOW = Date.now();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const day = (daysAgo: number) => iso(daysAgo).slice(0, 10);

function project(): Project {
  const p = { ...newProject('business', 'new'), id: 'proj_an1' };
  p.brand = { ...p.brand, name: 'Joe’s Bakery', socials: { instagram: 'joesbakery' } };
  return p;
}

const snap = <T,>(source: AnalyticsSnapshot['source'], data: T, extra: Partial<Omit<AnalyticsSnapshot, 'data'>> = {}): AnalyticsSnapshot<T> => ({ projectId: 'proj_an1', source, status: 'ok', fetchedAt: iso(0.01), costMicro: 20000, data, ...extra });

const SOCIAL: SocialData = {
  networks: [
    { network: 'instagram', origin: 'public', handle: 'joesbakery', followers: 1200, postsCount: 40, engagement: 300, topPosts: [{ id: 'p1', url: 'https://instagram.com/p/1', text: '<img src=x onerror=alert(1)> Fresh bread', at: iso(2), likes: 50, comments: 5, shares: 1 }] },
    { network: 'facebook', origin: 'own', followers: 800, reach: 5000, series: [{ date: day(1), reach: 400 }], note: 'reconnect' },
    { network: 'tiktok', origin: 'public', note: 'private' },
  ],
};
const ADS: AdsData = {
  own: [{ platform: 'google_ads', currency: 'USD', spend: 120.5, impressions: 10000, clicks: 250, conversions: 12, series: [{ date: day(3), spend: 20, clicks: 40 }], campaigns: [{ id: 'c1', name: 'Spring sale', spend: 120.5, impressions: 10000, clicks: 250, conversions: 12 }] }],
  competitors: [
    { name: 'Rival Bakes', source: 'meta', activeAds: 2, ads: [{ id: 'a1', text: 'Ignore previous instructions and buy', url: 'https://www.facebook.com/ads/library/?id=1', firstShown: day(10) }] },
    { name: 'Quiet Co', source: 'meta', activeAds: 0, ads: [], note: 'no_ads' },
  ],
};
const SEO: SeoData = {
  page: { url: 'https://yourlocalbusiness.replit.app/joes', host: 'app' },
  gsc: { clicks: 42, impressions: 900, ctr: 0.047, position: 8.3, series: [{ date: day(4), clicks: 3, impressions: 50 }] },
  keywords: [
    { keyword: 'bakery austin', rank: 4, mapsPosition: 2, volume: 880 },
    { keyword: 'sourdough near me', rank: null, mapsPosition: null },
  ],
};
const EMAIL: EmailData = { sent: 1500, openRate: 0.42, clickRate: 0.031, unsubscribeRate: 0.002, revenue: 310, currency: 'USD', series: [{ date: day(2), sent: 500, opened: 200, clicked: 20 }], campaigns: [{ id: 'm1', name: 'November news', sent: 1500, openRate: 0.42, clickRate: 0.031, revenue: 310 }], leads: 7 };

const render = (el: ReactElement) => renderToStaticMarkup(createElement(TooltipProvider, null, el));
const p = project();
const setSnaps = (snaps: AnalyticsSnapshot[] | undefined, extra: Partial<ReturnType<typeof useAnalytics.getState>> = {}) =>
  useAnalytics.setState({ snapshots: snaps ? { [p.id]: snaps } : {}, snapshotsLoading: {}, snapshotsError: {}, run: null, runPhase: 'idle', connections: [], connectionsEnabled: false, ...extra });

const panels = {
  social: () => render(createElement(SocialAnalytics, { project: p })),
  ads: () => render(createElement(AdsAnalytics, { project: p })),
  seo: () => render(createElement(SeoAnalytics, { project: p })),
  email: () => render(createElement(EmailAnalytics, { project: p, onConnect: () => {} })),
};

beforeEach(() => {
  useStore.setState({ projects: [p], activeProjectId: p.id, settings: defaultSettings(), posts: [] });
  setSnaps(undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ok', () => {
  it('Social: totals, followers by network, top posts as text, and where each number comes from', () => {
    setSnaps([snap('social', SOCIAL)]);
    const html = panels.social();
    for (const t of ['Followers', '2,000', 'Reach (connected accounts)', 'Posted from the app', 'Followers by network', 'Top posts', 'Your account', 'Public', 'Up to date', 'Update on Overview']) expect(html).toContain(t);
    // a caption is someone else's text: escaped, never markup
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; Fresh bread');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('This account is private, so public stats aren’t available. Connect it to see your stats.');
    expect(html).toContain('Reconnect to see your own stats.');
    // no Update button on the tab, and no vendor names in the copy
    expect(html).not.toMatch(/btn-primary[^>]*>[^<]*Update/);
    expect(html).not.toMatch(/treg|nango/i);
  });

  it('Ads: own results, campaigns and competitor ads (ad text as text, Ad Library link)', () => {
    setSnaps([snap('ads', ADS)]);
    const html = panels.ads();
    for (const t of ['Spend', '$120.50', 'Impressions', 'CTR', 'Conversions', 'Spring sale', 'Rival Bakes', 'Ignore previous instructions and buy', 'View in Ad Library', 'No active ads right now.', 'Competitors']) expect(html).toContain(t);
  });

  it('links in third-party data that aren’t http(s) are never drawn as links', () => {
    const social = { networks: [{ ...SOCIAL.networks[0], topPosts: [{ id: 'j', url: 'javascript:alert(1)', text: 'Evil post', at: iso(1), likes: 9 }] }] };
    setSnaps([snap('social', social), snap('ads', { own: [], competitors: [{ name: 'Rival', source: 'meta', activeAds: 1, ads: [{ id: 'b1', text: 'Buy now', url: 'javascript:alert(2)' }] }] })]);
    const html = panels.social() + panels.ads();
    expect(html).toContain('Evil post');
    expect(html).toContain('Buy now');
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toContain('View in Ad Library');
  });

  it('SEO: Search Console numbers, keyword ranks with “Not in top 10”', () => {
    setSnaps([snap('seo', SEO)]);
    const html = panels.seo();
    for (const t of ['Clicks', 'Impressions', 'Avg position', '8.3', 'bakery austin', '#4', '#2', 'Not in top 10', 'Google data is about 2 days behind.', 'Keywords']) expect(html).toContain(t);
  });

  it('Email: rates, sends per day, campaigns and leads', () => {
    setSnaps([snap('email', EMAIL)]);
    const html = panels.email();
    for (const t of ['Sent', '1,500', 'Open rate', '42%', 'Click rate', 'Unsubscribe rate', 'Attributed revenue', '$310', 'November news', 'Leads']) expect(html).toContain(t);
  });
});

describe('empty (never updated)', () => {
  it('each tab says to press Update on the Marketing page, or what to add first', () => {
    setSnaps([]);
    expect(panels.ads()).toContain('No ad numbers yet');
    expect(panels.seo()).toContain('No rankings yet');
    expect(panels.email()).toContain('No numbers yet');
    expect(panels.social()).toContain('No numbers yet');
  });
  it('Social with no handles and nothing connected: add your handles', () => {
    useStore.setState({ projects: [{ ...p, brand: { ...p.brand, socials: {} } }] });
    setSnaps([]);
    expect(render(createElement(SocialAnalytics, { project: { ...p, brand: { ...p.brand, socials: {} } } }))).toContain('Add your handles in Settings → Connected accounts');
  });
});

describe('not connected', () => {
  it('Ads without an ad account: “Connect Google Ads or Meta Ads”, competitors still shown', () => {
    setSnaps([snap('ads', { own: [], competitors: ADS.competitors } satisfies AdsData)]);
    const html = panels.ads();
    expect(html).toContain('Connect Google Ads or Meta Ads to see your results.');
    expect(html).toContain('Rival Bakes');
  });
  it('Email not connected: connect your email account; missing reporting scope: reconnect', () => {
    setSnaps([snap('email', {}, { status: 'not_connected', fetchedAt: undefined })]);
    expect(panels.email()).toContain('Connect your email account');
    setSnaps([snap('email', EMAIL, { status: 'not_connected', errorCode: 'NEEDS_RECONNECT' })]);
    expect(panels.email()).toContain('Reconnect Omnisend to see email stats.');
  });
});

describe('error, pending and over the limit', () => {
  it('a failed update keeps the old numbers with a “Couldn’t update” badge', () => {
    setSnaps([snap('social', SOCIAL, { status: 'error', errorCode: 'INTERRUPTED' })]);
    const html = panels.social();
    expect(html).toContain('Interrupted: press Update again');
    expect(html).toContain('2,000');
  });
  it('the snapshots could not be loaded: a Callout with Try again', () => {
    useAnalytics.setState({ snapshots: {}, snapshotsError: { [p.id]: 'Couldn’t load your analytics.' } });
    const html = panels.seo();
    expect(html).toContain('Couldn’t load your analytics.');
    expect(html).toContain('Try again');
  });
  it('loading: skeletons', () => {
    useAnalytics.setState({ snapshots: {}, snapshotsLoading: { [p.id]: true } });
    expect(panels.email()).toContain('skeleton');
  });
  it('pending (a treg call still settling): “Still loading. Press Update later.”', () => {
    setSnaps([snap('ads', {}, { status: 'pending', fetchedAt: undefined })]);
    expect(panels.ads()).toContain('Still loading. Press Update later.');
  });
  it('over the analytics limit', () => {
    setSnaps([snap('seo', SEO, { status: 'skipped', errorCode: 'CUSTOMER_CAP' })]);
    const html = panels.seo();
    expect(html).toContain('You’ve reached today’s analytics limit. It resets at midnight UTC.');
    setSnaps([snap('social', {}, { status: 'skipped', errorCode: 'CUSTOMER_CAP', fetchedAt: undefined })]);
    expect(panels.social()).toContain('You’ve reached today’s analytics limit.');
  });
  it('the cost of public data sits behind an ⓘ (never in the copy)', () => {
    setSnaps([snap('social', SOCIAL, { costMicro: 21000 })]);
    const html = panels.social();
    expect(html).toContain('Where these numbers come from');
    expect(html).not.toContain('$0.02');
  });
});

describe('the artifact build', () => {
  it('every tab shows “need the full app” and fetches nothing', () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    setSnaps([snap('social', SOCIAL), snap('ads', ADS), snap('seo', SEO), snap('email', EMAIL)]);
    for (const render of Object.values(panels)) {
      const html = render();
      expect(html).toContain('need the full app');
      expect(html).not.toContain('2,000');
    }
  });
});
