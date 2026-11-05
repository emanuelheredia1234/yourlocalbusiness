// Settings › Connected accounts, drawn once per state (as on the server: no effects run): every row state
// (limited with each reason, waiting, a connect window that didn't finish), connecting switched off, the
// owner's hint (Secret names, never values) and the artifact build.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import type { ConnectionStatus, LimitedReason } from '@/lib/integrations/types';

const live = <S,>(store: { getState: () => S }) => Object.assign(<T,>(select: (s: S) => T = (s) => s as unknown as T) => select(store.getState()), store);
vi.mock('@/store/analytics', async (original) => {
  const real = await original<typeof import('@/store/analytics')>();
  return { ...real, useAnalytics: live(real.useAnalytics) };
});

const { useAnalytics } = await import('@/store/analytics');
const { ConnectedAccounts, rowView } = await import('./ConnectedAccounts');

const render = () => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ConnectedAccounts)));
const set = (connections: ConnectionStatus[], extra: Partial<ReturnType<typeof useAnalytics.getState>> = {}) =>
  useAnalytics.setState({ connections, connectionsEnabled: true, connectionsLoaded: true, connectionsHint: undefined, connectionsError: undefined, pending: {}, expired: {}, ...extra });

/** The markup of one row (from its data-platform marker back to the row's start). */
function rowOf(html: string, platform: string): string {
  const at = html.indexOf(`data-platform="${platform}"`);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<div class="grid', at);
  const end = html.indexOf('<div class="grid', at);
  return html.slice(start, end === -1 ? undefined : end);
}

beforeEach(() => set([]));
afterEach(() => vi.unstubAllGlobals());

describe('the three sections', () => {
  it('Social, Ads and Search Console, with phase-2 networks as Coming soon', () => {
    const html = render();
    for (const t of ['Social', 'Ads', 'Google Search Console', 'Facebook Page', 'Instagram', 'LinkedIn', 'TikTok', 'YouTube', 'Google Ads', 'Meta Ads', 'Search Console', 'Pages on the app’s address need no connection']) expect(html).toContain(t);
    for (const p of ['pinterest', 'microsoft_ads', 'tiktok_ads']) expect(rowOf(html, p)).toContain('Coming soon');
    expect(html).not.toMatch(/nango|treg/i);
  });
});

describe('every row state', () => {
  it('not connected: Connect (secondary, never filled)', () => {
    const row = rowOf(render(), 'linkedin');
    expect(row).toContain('Not connected');
    expect(row).toContain('btn btn-secondary btn-sm');
    expect(row).toContain('Connect');
    expect(render()).not.toContain('btn-primary');
  });
  it('waiting for the network (connect window opened here, under 30 minutes): Check', () => {
    set([], { pending: { tiktok: Date.now() - 60_000 } });
    const row = rowOf(render(), 'tiktok');
    expect(row).toContain('Waiting for TikTok…');
    expect(row).toContain('Check');
  });
  it('a connect window older than 30 minutes: back to Not connected with “That didn’t finish. Try again.”', () => {
    set([], { pending: { x: Date.now() - 31 * 60_000 } });
    const row = rowOf(render(), 'x');
    expect(row).toContain('Not connected');
    expect(row).toContain('That didn’t finish. Try again.');
    set([], { expired: { youtube: true } });
    expect(rowOf(render(), 'youtube')).toContain('That didn’t finish. Try again.');
  });
  it('connected: the Page it posts as, and the ⋯ menu', () => {
    set([{ platform: 'facebook', state: 'connected', targetLabel: 'Joe’s Bakery', targetKind: 'fb_page', targetsAvailable: 2 }]);
    const row = rowOf(render(), 'facebook');
    expect(row).toContain('Connected');
    expect(row).toContain('Joe’s Bakery (Page)');
    expect(row).toContain('aria-label="Facebook actions"');
  });
  it('needs reconnect and expires soon: Reconnect', () => {
    set([
      { platform: 'linkedin', state: 'needs_reconnect' },
      { platform: 'facebook', state: 'connected', expiresSoon: true },
    ]);
    const html = render();
    expect(rowOf(html, 'linkedin')).toContain('Reconnect needed');
    expect(rowOf(html, 'linkedin')).toContain('Reconnect');
    expect(rowOf(html, 'facebook')).toContain('Expires soon');
    expect(rowOf(html, 'facebook')).toContain('Reconnect');
  });
  it('limited, with each reason in plain words', () => {
    const cases: [LimitedReason, string, string][] = [
      ['missing_permissions', 'facebook', 'Some permissions weren’t allowed'],
      ['no_page_role', 'facebook', 'You need to be able to post on this Page'],
      ['app_not_approved', 'google_ads', 'Waiting for Google Ads to approve this app'],
      ['insights_unavailable', 'facebook', 'Stats appear once the account has 100 followers'],
      ['private_only', 'tiktok', 'Posts go out as private until TikTok approves this app'],
    ];
    for (const [reason, platform, text] of cases) {
      set([{ platform: platform as ConnectionStatus['platform'], state: 'limited', limitedReason: reason }]);
      const row = rowOf(render(), platform);
      expect(row).toContain(text);
      // Reconnect only where it helps (permissions, the Page role)
      expect(row.includes('>Reconnect<')).toBe(reason === 'missing_permissions' || reason === 'no_page_role');
    }
  });
  it('Instagram follows Facebook: connect a Facebook Page that has an Instagram professional account', () => {
    expect(rowOf(render(), 'instagram')).toContain('Connect a Facebook Page that has an Instagram professional account.');
    set([
      { platform: 'facebook', state: 'connected' },
      { platform: 'instagram', state: 'connected', targetLabel: 'joesbakery', targetKind: 'ig_account' },
    ]);
    expect(rowOf(render(), 'instagram')).toContain('Connected');
  });
});

describe('connecting switched off', () => {
  it('a Callout at the top, and no Connect buttons', () => {
    set([], { connectionsEnabled: false });
    const html = render();
    expect(html).toContain('Connecting accounts is coming soon. You can still post yourself and mark posts as posted.');
    expect(html).not.toContain('>Connect<');
  });
});

describe('the owner’s hint', () => {
  it('names the Replit Secret, never a value', () => {
    set([], { connectionsEnabled: false, connectionsHint: 'Connecting accounts is off: add NANGO_SECRET_KEY (and NANGO_WEBHOOK_SIGNING_KEY) in Replit Secrets.' });
    const html = render();
    expect(html).toContain('NANGO_SECRET_KEY');
    expect(html).toContain('Replit Secrets');
    expect(html).not.toMatch(/sk_|test-nango-key/);
  });
  it('people who aren’t the owner get no hint (the server sends none)', () => {
    set([], { connectionsEnabled: false });
    expect(render()).not.toContain('Replit Secrets');
  });
});

describe('the artifact build', () => {
  it('shows “need the full app” instead', () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    const html = render();
    expect(html).toContain('Connected accounts and live analytics need the full app.');
    expect(html).not.toContain('Facebook Page');
  });
});

describe('rowView', () => {
  it('a server-side pending state reads as waiting; connected with connecting off shows no action', () => {
    expect(rowView('facebook', { platform: 'facebook', state: 'pending' }, { enabled: true }).status).toBe('Waiting for Facebook…');
    expect(rowView('facebook', { platform: 'facebook', state: 'connected' }, { enabled: false }).action).toBe('none');
    expect(rowView('instagram', undefined, { enabled: true }).connectAs).toBe('facebook');
  });
});
