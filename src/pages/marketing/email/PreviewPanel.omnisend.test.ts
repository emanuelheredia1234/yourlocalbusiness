// @vitest-environment happy-dom
// The Omnisend card on Email → Preview & export: hidden when the server doesn't offer Omnisend (an older server or
// none: a 404, a failed request, or an answer that isn't a status), the setup guide for the app's owner only, Connect
// again when Omnisend no longer takes the connection, drafts that are what the preview shows, and the way back from
// Omnisend's sign-in. Every request is answered here: fetch is stubbed and nothing leaves the test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';

vi.mock('@/lib/cloud/auth', async (original) => ({ ...(await original<typeof import('@/lib/cloud/auth')>()), authHeaders: async () => ({}) }));

const { newProject } = await import('@/store/defaults');
const { useStore } = await import('@/store/useStore');
const { generateEmailSequence, renderTokens } = await import('@/ai/local/email');
const { emailTokens } = await import('./shared');
const { PreviewPanel, omnisendDraft } = await import('./PreviewPanel');
const { default: EmailFunnel } = await import('../EmailFunnel');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PUBLISHED = 'https://yourlocalbusiness.replit.app';
const STATUS_PATH = '/api/integrations/omnisend/status';
const DRAFTS_PATH = '/api/integrations/omnisend/campaign-drafts';
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
  useStore.setState((s) => ({ settings: { ...s.settings, ai: { ...s.settings.ai, serverUrl: '' } } }));
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const STATUS = { credentialsConfigured: true, missingCredentials: [] as string[], storageReady: true, connected: false, reconnect: null as string | null, scopes: [] as string[], owner: false };
const CONNECTED = { ...STATUS, connected: true, scopes: ['campaigns.write', 'email-templates.write'] };

type Answer = (url: string, init?: RequestInit) => Response | Promise<Response>;

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

function project({ emails = false, website = '' }: { emails?: boolean; website?: string } = {}) {
  const p = newProject('business');
  p.brand.name = 'Copper & Comb';
  p.brand.websiteUrl = website;
  if (emails) p.marketing.emails = generateEmailSequence(p, null);
  return p;
}

async function render(answer: Answer, p = project(), element?: ReactElement) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => answer(String(url), init));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    root.render(createElement(TooltipProvider, null, element ?? createElement(PreviewPanel, { project: p, onWrite: () => {} })));
  });
  // let the status request settle
  await settle();
  return fetchMock;
}

const buttons = (label: string) => [...host.querySelectorAll('button')].filter((b) => b.textContent === label);
const calls = (f: ReturnType<typeof vi.fn>, url: string) => f.mock.calls.filter(([u]) => u === url);

describe('the Omnisend card', () => {
  it('stays hidden when the server has no Omnisend routes (404)', async () => {
    const f = await render(async () => json(404, { error: 'Not found' }));
    expect(f).toHaveBeenCalledWith(STATUS_PATH, expect.objectContaining({ method: 'GET' }));
    expect(host.textContent).not.toContain('Omnisend');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('No emails yet');
  });

  it('stays hidden when there is no server to ask (the request fails)', async () => {
    await render(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(host.textContent).not.toContain('Omnisend');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('stays hidden, and the page keeps working, when the answer isn’t a status', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // a static host's app page (its SPA fallback) answering 200 for the API path
    await render(async () => new Response('<!doctype html><html><body>app</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(host.textContent).toContain('No emails yet');
    expect(host.textContent).not.toContain('Omnisend');
    act(() => root.unmount());
    root = createRoot(host);
    await render(async () => json(200, { credentialsConfigured: false, storageReady: true, connected: false }));
    expect(host.textContent).toContain('No emails yet');
    expect(host.textContent).not.toContain('Omnisend');
  });

  it('asks the app’s server at its address, as Publish and Leads do', async () => {
    useStore.setState((s) => ({ settings: { ...s.settings, ai: { ...s.settings.ai, serverUrl: 'https://api.example.test/' } } }));
    const f = await render(async () => json(200, STATUS));
    expect(f).toHaveBeenCalledWith(`https://api.example.test${STATUS_PATH}`, expect.objectContaining({ method: 'GET' }));
  });

  it('shows the owner how to set Omnisend up, and everyone else one line', async () => {
    const unset = { ...STATUS, credentialsConfigured: false, missingCredentials: ['OMNISEND_CLIENT_ID', 'OMNISEND_CLIENT_SECRET'] };
    await render(async () => json(200, { ...unset, owner: true }));
    expect(host.querySelector('#omnisend-heading')?.textContent).toBe('Omnisend');
    expect(host.textContent).toContain('Not connected');
    expect(host.textContent).toContain('How to set up Omnisend');
    expect(buttons('Connect Omnisend')).toHaveLength(0);

    act(() => root.unmount());
    root = createRoot(host);
    await render(async () => json(200, unset));
    expect(host.textContent).toContain('Omnisend isn’t set up on this app yet.');
    expect(host.textContent).not.toContain('How to set up Omnisend');
    expect(host.textContent).not.toMatch(/Replit Secrets|OMNISEND_CLIENT|redirect URI/);

    // storage that isn't ready: the owner is told what to check, everyone else the same one line
    act(() => root.unmount());
    root = createRoot(host);
    await render(async () => json(200, { ...STATUS, storageReady: false }));
    expect(host.textContent).toContain('Omnisend isn’t set up on this app yet.');
    expect(host.textContent).not.toContain('Supabase');
    act(() => root.unmount());
    root = createRoot(host);
    await render(async () => json(200, { ...STATUS, storageReady: false, owner: true }));
    expect(host.textContent).toContain('Check the Supabase server secret');
  });

  it('shows a server error as an alert', async () => {
    await render(async () => json(500, { error: 'Omnisend storage failed.' }));
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Omnisend storage failed.');
  });

  it('says it is connected and offers Disconnect', async () => {
    await render(async () => json(200, CONNECTED));
    expect(host.textContent).toContain('Connected');
    expect(buttons('Disconnect')).toHaveLength(1);
  });

  it('offers Connect again, with a plain notice, when Omnisend no longer takes the connection', async () => {
    happyDOM.setURL(`${PUBLISHED}/#marketing-email`);
    await render(async () => json(200, { ...STATUS, reconnect: 'revoked' }), project({ emails: true, website: 'copperandcomb.com' }));
    expect(host.textContent).toContain('Reconnect needed');
    expect(host.textContent).toContain('Omnisend no longer accepts this app’s connection. Connect Omnisend again to keep creating drafts.');
    expect(buttons('Connect again')).toHaveLength(1);
    expect(buttons('Create Omnisend draft')).toHaveLength(0);
  });

  it('connects from the published app with a request that keeps its cookie, then opens Omnisend', async () => {
    happyDOM.setURL(`${PUBLISHED}/#marketing-email`);
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const authorize = 'https://app.omnisend.com/oauth2/authorize?client_id=x&state=s';
    const f = await render(async (url) => (url.endsWith('/connect') ? json(200, { authorizationUrl: authorize }) : json(200, STATUS)));
    await act(async () => buttons('Connect Omnisend')[0].click());
    await settle();
    const [, init] = calls(f, `${PUBLISHED}/api/integrations/omnisend/connect`)[0];
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(assign).toHaveBeenCalledWith(authorize);
  });

  it('connects only from the published app, and says where that is', async () => {
    await render(async () => json(200, STATUS));
    expect(buttons('Connect Omnisend')).toHaveLength(0);
    expect(host.textContent).toContain('Connect from the published app');
    expect(host.querySelector(`a[href="${PUBLISHED}/#marketing-email"]`)).not.toBeNull();
  });

  it('says how the sign-in at Omnisend went, and takes the marker out of the address', async () => {
    happyDOM.setURL('http://localhost:3000/?omnisend=connected&x=1#marketing-email');
    await render(async () => json(200, CONNECTED));
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Omnisend is connected. You can create drafts here; nothing has been sent.');
    expect(window.location.search).toBe('?x=1');
    expect(window.location.hash).toBe('#marketing-email');

    for (const [back, owner, text] of [
      ['__proto__', false, 'Returned from Omnisend.'],
      ['<img src=x onerror=alert(1)>', false, 'Returned from Omnisend.'],
      ['setup', false, 'Omnisend isn’t set up on this app yet.'],
      ['setup', true, 'Omnisend OAuth credentials are not configured yet.'],
      ['invalid_state', false, 'couldn’t be matched to this browser'],
    ] as const) {
      act(() => root.unmount());
      root = createRoot(host);
      happyDOM.setURL(`http://localhost:3000/?omnisend=${encodeURIComponent(back)}#marketing-email`);
      await render(async () => json(200, { ...STATUS, owner }));
      expect(host.querySelector('[role="status"]')?.textContent).toContain(text);
      expect(host.querySelector('img')).toBeNull();
    }
  });
});

describe('back from Omnisend on the Email page', () => {
  it('opens Preview & export, where the card says how it went', async () => {
    happyDOM.setURL('http://localhost:3000/?omnisend=connected#marketing-email');
    const p = { ...project(), id: 'proj_omnisend', onboarded: true };
    // a project on its first tab otherwise (no lead magnet yet)
    expect(p.marketing.leadMagnet).toBeFalsy();
    useStore.setState({ projects: [p], activeProjectId: p.id });
    await render(async () => json(200, CONNECTED), p, createElement(EmailFunnel));
    expect(host.textContent).toContain('Omnisend is connected.');
    expect(host.textContent).toContain('No emails yet');
    expect(window.location.search).toBe('');
  });
});

describe('Omnisend drafts', () => {
  async function renderConnected(p: ReturnType<typeof project>, draftAnswer: Answer = async () => json(201, { campaign: { name: 'Copper & Comb — Email 1', url: 'https://app.omnisend.com/campaigns/1/settings' } })) {
    return render(async (url, init) => (url === DRAFTS_PATH ? draftAnswer(url, init) : json(200, CONNECTED)), p);
  }
  const posted = (f: ReturnType<typeof vi.fn>) => calls(f, DRAFTS_PATH).map(([, init]) => JSON.parse(String((init as RequestInit).body)));

  it('sends every field as the preview shows it', async () => {
    const p = project({ emails: true, website: 'copperandcomb.com' });
    const f = await renderConnected(p);
    const tokens = emailTokens(p);
    const create = buttons('Create Omnisend draft');
    expect(create).toHaveLength(5);
    for (const b of create) {
      await act(async () => b.click());
      await settle();
    }
    const sent = posted(f);
    expect(sent).toHaveLength(5);
    sent.forEach((draft, i) => {
      const email = p.marketing.emails[i];
      expect(draft).toEqual({
        name: `Copper & Comb — Email ${i + 1}`,
        subject: renderTokens(email.subject, tokens),
        preheader: renderTokens(email.preview, tokens),
        body: renderTokens(email.body, tokens),
        ctaLabel: renderTokens(email.ctaLabel, tokens),
        ctaUrl: renderTokens(email.ctaUrl, tokens),
      });
      expect(draft).toEqual(omnisendDraft(p, email, i, tokens));
      expect(JSON.stringify(draft)).not.toContain('{{');
      expect(draft.ctaUrl).toMatch(/^https:\/\/copperandcomb\.com\/(free|offer)$/);
      // the body the preview shows is the body sent
      expect(host.querySelectorAll('ol > li')[i].textContent).toContain(draft.body.split('\n')[0]);
    });
    const status = host.querySelector('ol > li [role="status"]');
    expect(status?.textContent).toContain('Draft created in Omnisend: Copper & Comb — Email 1. Nothing has been sent.');
    // "Hi [First name]," is what the preview shows; the owner fills it in at Omnisend
    expect(status?.textContent).toContain('replace the values in [brackets] in Omnisend');
    expect(status?.querySelector('a')?.getAttribute('href')).toBe('https://app.omnisend.com/campaigns/1/settings');
  });

  it('doesn’t create a draft whose button has no web address', async () => {
    const f = await renderConnected(project({ emails: true }));
    await act(async () => buttons('Create Omnisend draft')[0].click());
    await settle();
    expect(calls(f, DRAFTS_PATH)).toHaveLength(0);
    expect(host.querySelector('ol > li [role="alert"]')?.textContent).toBe('This email’s button has no web address yet. Add your website in Settings › Brand, or a full https:// link as its Button link in Sequence.');
  });

  it('says a draft may have been created when Omnisend didn’t confirm it, and never sends again by itself', async () => {
    const f = await renderConnected(project({ emails: true, website: 'copperandcomb.com' }), async () =>
      json(502, { error: 'The email template may have been created: Omnisend didn’t confirm it. Check Omnisend before trying again.', code: 'OUTCOME_UNKNOWN' }),
    );
    await act(async () => buttons('Create Omnisend draft')[0].click());
    await settle();
    await settle();
    expect(calls(f, DRAFTS_PATH)).toHaveLength(1);
    const alert = host.querySelector('ol > li [role="alert"]');
    expect(alert?.textContent).toBe('The email template may have been created: Omnisend didn’t confirm it. Check Omnisend before trying again.');
    expect(alert?.className).toContain('text-warn');
  });

  it('asks for a new connection when Omnisend refused this one', async () => {
    let status: typeof STATUS = CONNECTED;
    const f = await render(async (url) => {
      if (url !== DRAFTS_PATH) return json(200, status);
      status = { ...STATUS, reconnect: 'revoked' };
      return json(409, { error: 'Omnisend no longer accepts this connection, so nothing was created. Connect Omnisend again.', code: 'RECONNECT_REQUIRED' });
    }, project({ emails: true, website: 'copperandcomb.com' }));
    await act(async () => buttons('Create Omnisend draft')[0].click());
    await settle();
    await settle();
    expect(calls(f, STATUS_PATH)).toHaveLength(2);
    expect(host.textContent).toContain('Reconnect needed');
    expect(host.textContent).toContain('Omnisend no longer accepts this connection, so nothing was created. Connect Omnisend again.');
    expect(buttons('Create Omnisend draft')).toHaveLength(0);
  });
});
