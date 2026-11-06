// The Marketing hub's header: exactly one filled button, "Update", top right; the per-source progress row
// while an Update runs; the Callouts for a refused Update; and none of it in the artifact build.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import type { RefreshRun } from '@/lib/integrations/types';

const live = <S,>(store: { getState: () => S }) => Object.assign(<T,>(select: (s: S) => T = (s) => s as unknown as T) => select(store.getState()), store);
vi.mock('@/store/analytics', async (original) => {
  const real = await original<typeof import('@/store/analytics')>();
  return { ...real, useAnalytics: live(real.useAnalytics) };
});
vi.mock('@/store/useStore', async (original) => {
  const real = await original<typeof import('@/store/useStore')>();
  return { ...real, useStore: live(real.useStore), useActiveProject: () => real.getActiveProject() };
});

const { useAnalytics } = await import('@/store/analytics');
const { useStore } = await import('@/store/useStore');
const { newProject, defaultSettings } = await import('@/store/defaults');
const { default: MarketingHub } = await import('./MarketingHub');
const { tooSoonText, sourceLine } = await import('./analytics/UpdateButton');

const p = { ...newProject('business', 'new'), id: 'proj_hub1' };
const render = () => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(MarketingHub)));
/** The page header (up to the channel cards). */
const headerOf = (html: string) => html.slice(0, html.indexOf('aria-label="Channels"'));

beforeEach(() => {
  useStore.setState({ projects: [p], activeProjectId: p.id, settings: defaultSettings(), posts: [], ads: [] });
  useAnalytics.setState({ run: null, runPhase: 'idle', notice: null, loading: false, snapshots: {}, owner: false });
});
afterEach(() => vi.unstubAllGlobals());

describe('the header', () => {
  it('has exactly one filled button, labelled Update', () => {
    const header = headerOf(render());
    expect(header.match(/btn-primary/g)?.length).toBe(1);
    expect(header).toMatch(/btn btn-primary btn-sm"[^>]*>(<svg[\s\S]*?<\/svg>)?Update<\/button>/);
  });
  it('while updating: Updating…, disabled, and the four sources', () => {
    const run: RefreshRun = { id: 'r1', projectId: p.id, state: 'running', sources: { social: 'ok', ads: 'running', seo: 'queued', email: 'error' }, startedAt: new Date().toISOString() };
    useAnalytics.setState({ run, runPhase: 'running' });
    const html = render();
    expect(headerOf(html)).toContain('Updating…');
    expect(headerOf(html)).toMatch(/btn-primary btn-sm" disabled/);
    for (const t of ['Social: done', 'Ads: updating', 'SEO: waiting', 'Email: problem']) expect(html).toContain(t);
  });
  it('over five minutes: the button is back and the row says it goes on in the background', () => {
    const run: RefreshRun = { id: 'r1', projectId: p.id, state: 'running', sources: { social: 'ok', ads: 'running', seo: 'running', email: 'ok' }, startedAt: new Date().toISOString() };
    useAnalytics.setState({ run, runPhase: 'background' });
    const html = render();
    expect(headerOf(html)).toMatch(/>Update<\/button>/);
    expect(html).toContain('Still updating in the background');
  });
  it('the reasons from each source’s snapshot (“SEO: over today’s limit”, “Ads: not connected”)', () => {
    expect(sourceLine('seo', 'skipped', 'CUSTOMER_CAP').text).toBe('SEO: over today’s limit');
    expect(sourceLine('ads', 'not_connected').text).toBe('Ads: not connected');
  });
});

describe('a refused Update', () => {
  it('over the limit, nothing to update, blocked', () => {
    useAnalytics.setState({ notice: { kind: 'cap', message: 'x', period: 'day' } });
    expect(render()).toContain('You’ve reached today’s analytics limit.');
    useAnalytics.setState({ notice: { kind: 'nothing', message: 'x' } });
    expect(render()).toContain('Add your social handles, keywords or connect an account to see analytics.');
    useAnalytics.setState({ notice: { kind: 'blocked', message: 'x' } });
    expect(render()).toContain('Analytics are paused for your account.');
  });
  it('too soon: “Updated n min ago. You can update again at …”', () => {
    const now = Date.parse('2026-11-05T15:05:00Z');
    expect(tooSoonText('2026-11-05T15:15:00Z', now)).toMatch(/^Updated 5 min ago\. You can update again at /);
  });
});

describe('the artifact build', () => {
  it('no Update, no progress', () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    const html = render();
    expect(headerOf(html)).not.toContain('btn-primary');
    expect(html).not.toContain('Update progress');
  });
});
