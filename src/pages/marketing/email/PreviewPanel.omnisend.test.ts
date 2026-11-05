// @vitest-environment happy-dom
// The Omnisend card on Email → Preview & export: hidden when the server doesn't offer Omnisend (an older server or
// none: a 404 or a failed request), the setup guide while OAuth isn't configured, and a server's error as an alert.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';

vi.mock('@/lib/cloud/auth', async (original) => ({ ...(await original<typeof import('@/lib/cloud/auth')>()), authHeaders: async () => ({}) }));

const { newProject } = await import('@/store/defaults');
const { PreviewPanel } = await import('./PreviewPanel');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function render(answer: () => Promise<Response>) {
  const fetchMock = vi.fn(answer);
  vi.stubGlobal('fetch', fetchMock);
  const project = newProject('business');
  project.brand.name = 'Copper & Comb';
  await act(async () => {
    root.render(createElement(TooltipProvider, null, createElement(PreviewPanel, { project, onWrite: () => {} })));
  });
  // let the status request settle
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return fetchMock;
}

describe('the Omnisend card', () => {
  it('stays hidden when the server has no Omnisend routes (404)', async () => {
    const f = await render(async () => json(404, { error: 'Not found' }));
    expect(f).toHaveBeenCalledWith('/api/integrations/omnisend/status', expect.objectContaining({ method: 'GET' }));
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

  it('shows the setup guide while OAuth isn’t configured, without a Connect button', async () => {
    await render(async () => json(200, { credentialsConfigured: false, missingCredentials: ['OMNISEND_CLIENT_ID', 'OMNISEND_CLIENT_SECRET'], storageReady: true, connected: false, scopes: [] }));
    expect(host.querySelector('#omnisend-heading')?.textContent).toBe('Omnisend');
    expect(host.textContent).toContain('Not connected');
    expect(host.textContent).toContain('How to set up Omnisend');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Connect Omnisend'))).toBe(false);
  });

  it('shows a server error as an alert', async () => {
    await render(async () => json(500, { error: 'Omnisend storage failed.' }));
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Omnisend storage failed.');
  });

  it('says it is connected and offers Disconnect', async () => {
    await render(async () => json(200, { credentialsConfigured: true, missingCredentials: [], storageReady: true, connected: true, scopes: ['campaigns.write'] }));
    expect(host.textContent).toContain('Connected');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Disconnect')).toBe(true);
  });
});
