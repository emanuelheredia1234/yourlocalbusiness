// Settings › Connected accounts, drawn once per state (as on the server: no effects run): the two sections
// (social accounts through Upload-Post, each business its own; ad accounts through Zernio), the business slots,
// every row state (limited with each reason, waiting, a connect window that didn't finish), one side or both
// switched off, the owner's setup steps (Secret names and webhook addresses, never values) and the artifact build.
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
// the business on screen, read live too (a server render would otherwise read the store's first state)
vi.mock('@/store/useStore', async (original) => {
  const real = await original<typeof import('@/store/useStore')>();
  return { ...real, useStore: live(real.useStore) };
});

const { useAnalytics } = await import('@/store/analytics');
const { useStore } = await import('@/store/useStore');
const { newProject } = await import('@/store/defaults');
const { ConnectedAccounts, rowView, webhookUrls } = await import('./ConnectedAccounts');

const render = () => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ConnectedAccounts)));
const set = (connections: ConnectionStatus[], extra: Partial<ReturnType<typeof useAnalytics.getState>> = {}) =>
  useAnalytics.setState({ connections, slots: undefined, connectionsEnabled: true, socialEnabled: true, adsEnabled: true, connectionsLoaded: true, connectionsHint: undefined, connectionsError: undefined, pending: {}, expired: {}, ...extra });
/** The user's businesses, the first one on screen (each business connects its own social accounts). */
function businesses(...names: string[]) {
  const projects = names.map((name, i) => {
    const p = newProject('business', 'existing');
    return { ...p, id: `proj_${i + 1}`, brand: { ...p.brand, name } };
  });
  useStore.setState({ projects, activeProjectId: projects[0]?.id ?? null });
}

/** The markup of one row (from its data-platform marker back to the row's start). */
function rowOf(html: string, platform: string): string {
  const at = html.indexOf(`data-platform="${platform}"`);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<div class="grid', at);
  const end = html.indexOf('<div class="grid', at);
  return html.slice(start, end === -1 ? undefined : end);
}

beforeEach(() => {
  set([]);
  businesses('Joe’s Bakery', 'Joe’s Catering');
});
afterEach(() => vi.unstubAllGlobals());

describe('the sections', () => {
  it('Social accounts and Ad accounts (every ad network Zernio reads), Pinterest as Coming soon, no Search Console row', () => {
    const html = render();
    for (const t of ['Social accounts', 'Ad accounts', 'Gmail', 'Facebook Page', 'Instagram', 'LinkedIn', 'TikTok', 'YouTube', 'Google Ads', 'Meta Ads', 'LinkedIn Ads', 'TikTok Ads', 'Pinterest Ads', 'X Ads', 'Reddit Ads', 'Microsoft Ads']) expect(html).toContain(t);
    expect(rowOf(html, 'pinterest')).toContain('Coming soon');
    for (const p of ['microsoft_ads', 'tiktok_ads', 'reddit_ads']) expect(rowOf(html, p)).toContain('Connect');
    expect(html).not.toContain('Search Console');
    expect(html).not.toMatch(/nango|treg|zernio/i);
  });
  it('no Other integrations section until the owner sets Nango up', () => {
    expect(render()).not.toContain('Other integrations');
  });
});

describe('each business’s own accounts', () => {
  it('says each business connects its own, and whose these are', () => {
    const html = render();
    expect(html).toContain('Each business connects its own accounts. These are Joe’s Bakery’s');
    businesses('Joe’s Catering', 'Joe’s Bakery');
    expect(render()).toContain('These are Joe’s Catering’s');
  });
  it('how many business slots are used, of the user’s limit', () => {
    set([], { slots: { used: 2, cap: 3, projects: ['proj_1', 'proj_2'] } });
    const html = render();
    expect(html).toContain('Business slots');
    expect(html).toContain('2 of 3 used');
    expect(html).not.toContain('you deleted');
    expect(html).not.toContain('can’t connect social accounts yet');
  });
  it('all slots in use and this business has none: it says so plainly', () => {
    businesses('Joe’s Food Truck', 'Joe’s Bakery');
    set([], { slots: { used: 3, cap: 3, projects: ['proj_2', 'proj_x', 'proj_y'] } });
    const html = render();
    expect(html).toContain('3 of 3 used');
    expect(html).toContain('All 3 business slots are in use, so Joe’s Food Truck can’t connect social accounts yet.');
  });
  it('a slot held by a business that was deleted can be freed: only one the server found gone from the account', () => {
    set([], { slots: { used: 2, cap: 3, projects: ['proj_1', 'proj_gone'], orphans: ['proj_gone'] } });
    const html = render();
    expect(html).toContain('1 slot is held by a business you deleted.');
    expect(html).toContain('>Free it<');
  });
  it('a business this device hasn’t pulled yet (made on another device) is never offered to free', () => {
    set([], { slots: { used: 2, cap: 3, projects: ['proj_1', 'proj_other_device'], orphans: [] } });
    const html = render();
    expect(html).not.toContain('held by a business you deleted');
    expect(html).not.toContain('>Free it<');
  });
  it('no business on screen: nothing social to connect (ads still do)', () => {
    useStore.setState({ projects: [], activeProjectId: null });
    const html = render();
    expect(html).toContain('Open a business to connect its social accounts.');
    expect(rowOf(html, 'instagram')).not.toContain('>Connect<');
    expect(rowOf(html, 'google_ads')).toContain('>Connect<');
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
  it('Instagram connects on its own (no Facebook Page needed)', () => {
    const row = rowOf(render(), 'instagram');
    expect(row).toContain('Not connected');
    expect(row).toContain('>Connect<');
    set([{ platform: 'instagram', state: 'connected', targetLabel: 'joesbakery', targetKind: 'ig_account' }]);
    expect(rowOf(render(), 'instagram')).toContain('joesbakery (Instagram)');
  });
  it('X Ads is coming soon (Zernio’s X Ads needs an X account in Zernio; X posting is Upload-Post’s)', () => {
    const row = rowOf(render(), 'x_ads');
    expect(row).toContain('Coming soon');
    expect(row).not.toContain('>Connect<');
  });
});

describe('connecting switched off', () => {
  it('a Callout at the top, and no Connect buttons', () => {
    set([], { connectionsEnabled: false, socialEnabled: false, adsEnabled: false });
    const html = render();
    expect(html).toContain('Connecting accounts is coming soon. You can still post yourself and mark posts as posted.');
    expect(html).not.toContain('>Connect<');
  });
  it('social off, ads on: the social section says so and only ad rows connect', () => {
    set([], { socialEnabled: false });
    const html = render();
    expect(html).toContain('Connecting social accounts isn’t available yet.');
    expect(html).not.toContain('Connecting ad accounts isn’t available yet.');
    expect(rowOf(html, 'instagram')).not.toContain('>Connect<');
    expect(rowOf(html, 'google_ads')).toContain('>Connect<');
  });
  it('ads off, social on: the ads section says so and only social rows connect', () => {
    set([], { adsEnabled: false });
    const html = render();
    expect(html).toContain('Connecting ad accounts isn’t available yet.');
    expect(rowOf(html, 'meta_ads')).not.toContain('>Connect<');
    expect(rowOf(html, 'facebook')).toContain('>Connect<');
  });
  it('a reconnect from the server shows Reconnect while that side is on', () => {
    set([{ platform: 'instagram', state: 'needs_reconnect', lastError: 'reconnect' }]);
    expect(rowOf(render(), 'instagram')).toContain('>Reconnect<');
  });
  it('a connect the server saw start but never finish: “That didn’t finish. Try again.”', () => {
    set([{ platform: 'youtube', state: 'not_connected', lastError: 'not_finished' }]);
    expect(rowOf(render(), 'youtube')).toContain('That didn’t finish. Try again.');
  });
});

describe('the owner’s hint', () => {
  it('names the Replit Secret, never a value', () => {
    set([], { connectionsEnabled: false, socialEnabled: false, adsEnabled: false, connectionsHint: 'Social accounts and posting are off: add UPLOAD_POST_API_KEY in Replit Secrets. Ad accounts are off: add ZERNIO_API_KEY (and ZERNIO_WEBHOOK_SECRET) in Replit Secrets.' });
    const html = render();
    expect(html).toContain('ZERNIO_API_KEY');
    expect(html).toContain('Replit Secrets');
    expect(html).not.toMatch(/sk_test|test-zernio-key/);
  });
  it('the owner’s setup steps: each side that’s off, with its Secrets and the webhook address to register', () => {
    set([], { connectionsEnabled: false, socialEnabled: false, adsEnabled: false, connectionsHint: 'Social accounts and posting are off.' });
    const html = render();
    for (const t of ['Social accounts (Upload-Post)', 'Advanced plan (yearly)', 'UPLOAD_POST_API_KEY', 'UPLOAD_POST_WEBHOOK_SECRET', 'MEDIA_URL_SECRET', '/api/webhooks/upload-post', 'Ad accounts (Zernio)', 'ZERNIO_WEBHOOK_SECRET', '/api/webhooks/zernio', 'docs/integrations-setup.md']) expect(html).toContain(t);
    // a side that works shows no steps
    set([], { adsEnabled: false, connectionsHint: 'Ad accounts are off.' });
    const ads = render();
    expect(ads).toContain('Ad accounts (Zernio)');
    expect(ads).not.toContain('Social accounts (Upload-Post)');
  });
  it('webhook addresses from the server’s address', () => {
    expect(webhookUrls('https://app.example.com/')).toEqual({ social: 'https://app.example.com/api/webhooks/upload-post', ads: 'https://app.example.com/api/webhooks/zernio' });
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
    expect(rowView('instagram', undefined, { enabled: true }).action).toBe('connect');
  });
});
