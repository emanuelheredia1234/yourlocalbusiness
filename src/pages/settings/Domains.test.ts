// Settings → Domains shows only where publishing is on (rendered once, as on the server: no effects run).
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PublishAccess } from '@/lib/publish';

const state: { access: PublishAccess } = { access: 'ready' };
vi.mock('@/lib/publish', async (original) => ({ ...(await original<typeof import('@/lib/publish')>()), usePublishAccess: () => ({ access: state.access, retry: () => {} }) }));

const { DomainsCard } = await import('./Domains');
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

  it('lets a signed-in person add a domain, with plain steps to connect it', () => {
    const html = render('ready');
    expect(html).toContain('id="settings-domains"');
    expect(html).toContain('placeholder="yourbrand.com"');
    expect(html).toContain('Add domain');
    expect(html).toContain('Loading your domains…');
    expect(html).toContain('“Use a domain you already own”');
    expect(html).toContain('DNS only, not proxied');
    expect(html).toContain('press “Check again”');
  });
});
