// @vitest-environment happy-dom
// Settings › Connected accounts › Gmail: hidden when this server has no Gmail routes, the owner’s setup
// (secret names and the exact redirect URI), Connect only on the published app, and Disconnect.
// fetch is stubbed; nothing leaves the test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';

vi.mock('@/lib/cloud/auth', async (original) => ({ ...(await original<typeof import('@/lib/cloud/auth')>()), authHeaders: async () => ({}) }));

const { GmailAccount, GMAIL_CALLBACK_URL } = await import('./GmailAccount');
const { ConfirmHost } = await import('@/components/ui/primitives');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PUBLISHED = 'https://yourlocalbusiness.replit.app';
const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  happyDOM.setURL('http://localhost:3000/');
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const STATUS = { credentialsConfigured: true, missingCredentials: [] as string[], storageReady: true, connected: false, reconnect: null as string | null, scopes: [] as string[], email: '', owner: false };

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function render(answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => answer(String(url), init));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    root.render(createElement(TooltipProvider, null, createElement(Fragment, null, createElement(GmailAccount), createElement(ConfirmHost))));
  });
  await settle();
  return fetchMock;
}

const buttons = (label: string) => [...host.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === label);

describe('Gmail on Connected accounts', () => {
  it('stays hidden when the server has no Gmail routes', async () => {
    await render(async () => json(404, { error: 'Not found' }));
    expect(host.textContent).not.toContain('Gmail');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows the owner the secret names and the exact redirect URI, and everyone else one line', async () => {
    const unset = { ...STATUS, credentialsConfigured: false, missingCredentials: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] };
    await render(async () => json(200, { ...unset, owner: true }));
    expect(host.querySelector('#gmail-account')).not.toBeNull();
    expect(host.textContent).toContain('Owner setup');
    expect(host.textContent).toContain('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
    expect(host.textContent).toContain(GMAIL_CALLBACK_URL);
    expect(GMAIL_CALLBACK_URL).toBe('https://yourlocalbusiness.replit.app/api/integrations/gmail/callback');
    expect(buttons('Connect')).toHaveLength(0);

    act(() => root.unmount());
    root = createRoot(host);
    await render(async () => json(200, unset));
    expect(host.textContent).toContain('Connecting Gmail isn’t set up on this app yet.');
    expect(host.textContent).not.toMatch(/GOOGLE_CLIENT|Replit Secrets|redirect URI/);
  });

  it('connects from the published app with a request that keeps its cookie, then opens Google', async () => {
    happyDOM.setURL(`${PUBLISHED}/?settings=accounts#workspace-settings`);
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const authorize = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&scope=openid&state=s';
    const f = await render(async (url) => (url.endsWith('/connect') ? json(200, { authorizationUrl: authorize }) : json(200, STATUS)));
    await act(async () => buttons('Connect')[0].click());
    await settle();
    const [, init] = f.mock.calls.find(([u]) => String(u).endsWith('/api/integrations/gmail/connect'))!;
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(assign).toHaveBeenCalledWith(authorize);
  });

  it('does not follow a sign-in URL that isn’t Google', async () => {
    happyDOM.setURL(`${PUBLISHED}/#workspace-settings`);
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    await render(async (url) => (String(url).endsWith('/connect') ? json(200, { authorizationUrl: 'https://evil.example/oauth' }) : json(200, STATUS)));
    await act(async () => buttons('Connect')[0].click());
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(host.textContent).toContain('unexpected sign-in URL');
  });

  it('connects only from the published app', async () => {
    await render(async () => json(200, STATUS));
    expect(buttons('Connect')).toHaveLength(0);
    expect(host.textContent).toContain('Connect from the published app');
    expect(host.querySelector(`a[href="${PUBLISHED}/?settings=accounts#workspace-settings"]`)).not.toBeNull();
  });

  it('shows the connected mailbox and disconnects after a confirm', async () => {
    happyDOM.setURL(`${PUBLISHED}/#workspace-settings`);
    let deleted = false;
    const f = await render(async (url, init) => {
      if (String(url).endsWith('/connection') && init?.method === 'DELETE') {
        deleted = true;
        return json(200, { connected: false, revoked: true });
      }
      return json(200, deleted ? STATUS : { ...STATUS, connected: true, email: 'ada@gmail.com', scopes: ['https://www.googleapis.com/auth/gmail.send', 'openid', 'https://www.googleapis.com/auth/userinfo.email'] });
    });
    expect(host.textContent).toContain('ada@gmail.com');
    expect(host.querySelector('[data-integration="gmail"]')?.getAttribute('data-state')).toBe('connected');
    await act(async () => buttons('Disconnect')[0].click());
    await settle();
    // the confirm dialog is portaled on document.body, outside the card
    const confirm = [...document.querySelectorAll('button')].filter((b) => b.className.includes('btn-danger') && (b.textContent || '').includes('Disconnect'));
    expect(confirm).toHaveLength(1);
    await act(async () => confirm[0].click());
    await settle();
    await settle();
    expect(f.mock.calls.some(([u, init]) => String(u).endsWith('/connection') && (init as RequestInit | undefined)?.method === 'DELETE')).toBe(true);
    expect(host.textContent).toContain('removed at Google');
  });

  it('says how the Google sign-in went, and takes the marker out of the address', async () => {
    happyDOM.setURL(`${PUBLISHED}/?settings=accounts&gmail=connected#workspace-settings`);
    const replace = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    await render(async () => json(200, { ...STATUS, connected: true, email: 'ada@gmail.com' }));
    expect(host.textContent).toContain('Gmail is connected. Nothing has been sent.');
    expect(replace).toHaveBeenCalledWith(null, '', '/?settings=accounts#workspace-settings');
  });
});
