// The Ads planner's launch entry: tabs Plans / Campaigns / Analytics; "Launch…" shows only when the owner has
// launching on for this customer, and a launched plan says so and that editing it doesn't change the live one.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';

const live = <S,>(store: { getState: () => S }) => Object.assign(<T,>(select: (s: S) => T = (s) => s as unknown as T) => select(store.getState()), store);
vi.mock('@/store/useStore', async (original) => {
  const real = await original<typeof import('@/store/useStore')>();
  return { ...real, useStore: live(real.useStore), useActiveProject: () => real.getActiveProject() };
});
vi.mock('@/store/adsLaunch', async (original) => {
  const real = await original<typeof import('@/store/adsLaunch')>();
  return { ...real, useAdsLaunch: live(real.useAdsLaunch) };
});

const { useStore } = await import('@/store/useStore');
const { useAdsLaunch } = await import('@/store/adsLaunch');
const { newProject, defaultSettings } = await import('@/store/defaults');
const { newAdCampaign } = await import('@/ai/local/ads');
const { default: AdsEngine } = await import('./AdsEngine');

const p = { ...newProject('business', 'new'), id: 'proj_ads1' };
const plan = { ...newAdCampaign(p), id: 'ad_1', platforms: ['meta' as const], finalUrl: 'https://acme.example', creatives: [{ id: 'cr1', variant: 'A', angle: 'x', primaryText: 'Fix it today', headline: 'Fast fixes', description: '', cta: 'Learn More', style: 'minimal' as const, format: 'image' as const, visualHeadline: 'Fast' }], selectedCreativeIds: ['cr1'] };
const limits = { adsEnabled: true, currency: 'USD', maxDaily: 50, maxChange: 50, maxCampaignTotal: 750, launchesPerDay: 3, changesPerDay: 20, committedDaily: 0, liveCampaigns: 0, launchOpen: true };
const render = () => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(AdsEngine)));

beforeEach(() => {
  useStore.setState({ projects: [p], activeProjectId: p.id, settings: defaultSettings(), ads: [plan] });
  useAdsLaunch.setState({ campaigns: {}, limits: {} });
});

describe('the Ads planner', () => {
  it('has Plans, Campaigns and Analytics tabs', () => {
    const html = render();
    for (const t of ['Plans', 'Campaigns', 'Analytics']) expect(html).toContain(`>${t}<`);
  });
  it('shows Launch… only when launching is on for this customer', () => {
    expect(render()).not.toContain('Launch…');
    useAdsLaunch.setState({ limits: { [p.id]: limits } });
    expect(render()).toContain('Launch…');
    useAdsLaunch.setState({ limits: { [p.id]: { ...limits, adsEnabled: false } } });
    expect(render()).not.toContain('Launch…');
    useAdsLaunch.setState({ limits: { [p.id]: { ...limits, launchOpen: false } } });
    expect(render()).not.toContain('Launch…');
  });
  it('a launched plan says where it runs and that edits don’t change it', () => {
    useAdsLaunch.setState({
      limits: { [p.id]: limits },
      campaigns: { [p.id]: [{ id: 'c1', planId: 'ad_1', projectId: p.id, platform: 'meta', name: 'x', tag: null, account: { name: 'Acme', idTail: '1234', currency: 'USD', timezone: 'UTC' }, state: 'paused', stateMessage: 'Paused: not spending.', review: { status: null, reasons: [] }, daily: 25, start: '2026-12-01', end: null, launchedAs: 'PAUSED', configuredStatus: 'PAUSED' }] },
    });
    const html = render();
    expect(html).toContain('Launched on Meta · Paused');
    expect(html).toContain('Changes here don’t change the live campaign. Use Manage on the Campaigns tab.');
  });
});
