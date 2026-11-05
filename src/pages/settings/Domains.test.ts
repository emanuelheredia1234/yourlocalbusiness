// Settings › Domains shows only where publishing is on (rendered once, as on the server: no effects run).
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PublishAccess } from '@/lib/publish';

const state: { access: PublishAccess } = { access: 'ready' };
vi.mock('@/lib/publish', async (original) => ({ ...(await original<typeof import('@/lib/publish')>()), usePublishAccess: () => ({ access: state.access, retry: () => {} }) }));

const { ConnectSteps, DomainsCard, TxtRecord } = await import('./Domains');
const render = (access: PublishAccess) => {
  state.access = access;
  return renderToStaticMarkup(createElement(DomainsCard, {}));
};

describe('the Domains card', () => {
  it('isn’t there where publishing isn’t on', () => {
    for (const a of ['checking', 'unavailable', 'unreachable', 'off'] as const) expect(render(a)).toBe('');
  });

  it('asks a signed-out person to sign in', () => {
    const html = render('signed-out');
    expect(html).toContain('Domains');
    expect(html).toContain('Sign in to add your own domains.');
    expect(html).not.toContain('Add domain');
  });

  it('lets a signed-in person add a domain (in a side sheet), with the steps to connect it written once', () => {
    const html = render('ready');
    expect(html).toContain('id="settings-domains"');
    expect(html).toMatch(/<button type="button" class="btn btn-secondary btn-sm"[^>]*>.*Add domain<\/button>/);
    expect(html).toContain('Loading your domains…');
    // the steps sit behind "How to connect a domain"; the host's own steps are in the README, not here
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>How to connect a domain/);
    expect(html).not.toContain('Replit');
    const steps = renderToStaticMarkup(createElement(ConnectSteps));
    expect(steps).toContain('add that TXT record');
    expect(steps).toContain('Connect the domain to this app where the app is hosted.');
    expect(steps).toContain('press “Check again”');
  });

  it('shows a domain’s TXT record, its name and value each with a Copy button', () => {
    const record = { name: '_ylb-domain.mybakery.com', value: 'ylb-0123456789abcdef0123456789abcdef01234567' };
    const txt = renderToStaticMarkup(createElement(TxtRecord, { record }));
    expect(txt).toContain('TXT');
    // the name and the value are the only <code> in it, in that order (the type isn't)
    expect(txt.match(/<code[^>]*>([^<]*)<\/code>/g)).toEqual([
      `<code class="min-w-0 break-all font-mono text-small text-ink">${record.name}</code>`,
      `<code class="min-w-0 break-all font-mono text-small text-ink">${record.value}</code>`,
    ]);
    expect(txt.match(/<button type="button"[^>]*>/g)).toHaveLength(2);
    expect(txt).toContain('Copy name');
    expect(txt).toContain('Copy value');
    expect(txt).toContain('type the name without it');
  });
});
