// @vitest-environment happy-dom
// Settings › Connected accounts › Direct connections: hidden when this server has no social OAuth
// routes, the owner’s setup (secret names and the exact redirect URIs), Connect only on the published
// app, and Disconnect. fetch is stubbed; nothing leaves the test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';

vi.mock('@/lib/cloud/auth', async (original) => ({ ...(await original<typeof import('@/lib/cloud/auth')>()), authHeaders: async () => ({}) }));

const { SocialOAuthAccounts, SOCIAL_OAUTH_PROVIDERS } = await import('./SocialOAuthAccounts');
const { ConfirmHost } = await import('@/components/ui/primitives');
const { useStore } = await import('@/store/useStore');
const { newProject } = await import('@/store/defaults');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PUBLISHED = 'https://yourlocalbusiness.replit.app';
const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const project = newProject('business', 'existing');
  useStore.setState({ projects: [{ ...project, id: 'proj_bakery', brand: { ...project.brand, name: 'Ada Bakery' } }], activeProjectId: 'proj_bakery' });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  happyDOM.setURL('http://localhost:3000/');
  useStore.setState({ projects: [], activeProjectId: null });
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const account = (provider: string, extra: Record<string, unknown> = {}) => ({
  provider,
  credentialsConfigured: true,
  missingCredentials: [] as string[],
  storageReady: true,
  connected: false,
  reconnect: null,
  scopes: [] as string[],
  accountLabel: '',
  accountId: '',
  owner: false,
  ...extra,
});
const bundle = (accounts = SOCIAL_OAUTH_PROVIDERS.map((spec) => account(spec.id))) => ({ projectId: 'proj_bakery', storageReady: true, owner: false, accounts });

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function render(answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => answer(String(url), init));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    root.render(createElement(TooltipProvider, null, createElement(Fragment, null, createElement(SocialOAuthAccounts), createElement(ConfirmHost))));
  });
  await settle();
  return fetchMock;
}

const row = (id: string) => host.querySelector(`[data-direct="${id}"]`);
const buttons = (label: string) => [...host.querySelectorAll('button')].filter((button) => (button.textContent || '').trim() === label);

describe('direct social connections', () => {
  it('stays hidden when the server has no social OAuth routes', async () => {
    await render(async () => json(404, { error: 'Not found' }));
    expect(host.querySelector('#direct-social')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows the owner the secret names and the exact redirect URIs, and everyone else one line', async () => {
    const unset = SOCIAL_OAUTH_PROVIDERS.map((spec) => account(spec.id, { credentialsConfigured: false, missingCredentials: spec.secrets.split(' and '), owner: true }));
    await render(async () => json(200, bundle(unset)));
    expect(host.querySelector('#direct-social')).not.toBeNull();
    expect(host.textContent).toContain('Owner setup');
    expect(host.textContent).toContain('META_APP_ID and META_APP_SECRET');
    expect(host.textContent).toContain('TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET');
    expect(host.textContent).toContain('X_CLIENT_ID and X_CLIENT_SECRET');
    expect(host.textContent).toContain('PINTEREST_APP_ID and PINTEREST_APP_SECRET');
    expect(host.textContent).toContain('YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET');
    for (const spec of SOCIAL_OAUTH_PROVIDERS) expect(host.textContent).toContain(spec.callback);
    expect(SOCIAL_OAUTH_PROVIDERS.map((spec) => spec.callback)).toEqual([
      'https://yourlocalbusiness.replit.app/api/integrations/meta/callback',
      'https://yourlocalbusiness.replit.app/api/integrations/instagram/callback',
      'https://yourlocalbusiness.replit.app/api/integrations/tiktok/callback',
      'https://yourlocalbusiness.replit.app/api/integrations/x/callback',
      'https://yourlocalbusiness.replit.app/api/integrations/pinterest/callback',
      'https://yourlocalbusiness.replit.app/api/integrations/youtube/callback',
    ]);
    expect(buttons('Connect')).toHaveLength(0);

    act(() => root.unmount());
    root = createRoot(host);
    await render(async () => json(200, bundle(unset.map((item) => ({ ...item, owner: false, missingCredentials: [] })))));
    expect(host.textContent).toContain('Some direct connections aren’t set up on this app yet.');
    expect(host.textContent).not.toMatch(/META_APP|Replit Secrets|redirect URI/);
  });

  it('connects Facebook from the published app for this business', async () => {
    happyDOM.setURL(`${PUBLISHED}/?settings=accounts#workspace-settings`);
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const authorize = 'https://www.facebook.com/v23.0/dialog/oauth?client_id=x&state=s';
    const fetchMock = await render(async (url) => (url.endsWith('/connect') ? json(200, { authorizationUrl: authorize }) : json(200, bundle())));
    const connect = row('meta')?.querySelector('button');
    expect(connect?.textContent).toContain('Connect');
    await act(async () => connect?.click());
    await settle();
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/integrations/meta/connect'))!;
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ projectId: 'proj_bakery' });
    expect(assign).toHaveBeenCalledWith(authorize);
  });

  it('does not follow a sign-in URL that isn’t that network', async () => {
    happyDOM.setURL(`${PUBLISHED}/#workspace-settings`);
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    await render(async (url) => (String(url).endsWith('/connect') ? json(200, { authorizationUrl: 'https://evil.example/oauth' }) : json(200, bundle())));
    await act(async () => row('meta')?.querySelector('button')?.click());
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(host.textContent).toContain('unexpected sign-in URL');
  });

  it('connects only from the published app', async () => {
    await render(async () => json(200, bundle()));
    expect(buttons('Connect')).toHaveLength(0);
    expect(host.textContent).toContain('Connect from the published app');
    expect(host.querySelector(`a[href="${PUBLISHED}/?settings=accounts#workspace-settings"]`)).not.toBeNull();
  });

  it('shows the connected account and disconnects after a confirm', async () => {
    happyDOM.setURL(`${PUBLISHED}/#workspace-settings`);
    let deleted = false;
    const fetchMock = await render(async (url, init) => {
      if (String(url).includes('/api/integrations/x/connection') && init?.method === 'DELETE') {
        deleted = true;
        return json(200, { connected: false, revoked: true });
      }
      const accounts = SOCIAL_OAUTH_PROVIDERS.map((spec) => account(spec.id, spec.id === 'x' && !deleted ? { connected: true, accountLabel: 'ada' } : {}));
      return json(200, bundle(accounts));
    });
    expect(host.textContent).toContain('ada');
    expect(row('x')?.getAttribute('data-state')).toBe('connected');
    await act(async () => row('x')?.querySelector('button')?.click());
    await settle();
    const confirm = [...document.querySelectorAll('button')].filter((button) => button.className.includes('btn-danger') && (button.textContent || '').includes('Disconnect'));
    expect(confirm).toHaveLength(1);
    await act(async () => confirm[0].click());
    await settle();
    await settle();
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/api/integrations/x/connection') && (init as RequestInit | undefined)?.method === 'DELETE')).toBe(true);
    expect(host.textContent).toContain('removed at X');
  });

  it('says how the sign-in went, and takes the marker out of the address', async () => {
    happyDOM.setURL(`${PUBLISHED}/?settings=accounts&social_oauth=youtube.connected#workspace-settings`);
    const replace = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    await render(async () => json(200, bundle(SOCIAL_OAUTH_PROVIDERS.map((spec) => account(spec.id, spec.id === 'youtube' ? { connected: true, accountLabel: 'Ada Channel' } : {})))));
    expect(host.textContent).toContain('YouTube is connected. Nothing has been posted.');
    expect(replace).toHaveBeenCalledWith(null, '', '/?settings=accounts#workspace-settings');
  });
});
