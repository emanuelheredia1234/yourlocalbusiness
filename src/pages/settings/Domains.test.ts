// Settings → Domains shows only where publishing is on (rendered once, as on the server: no effects run).
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

  it('lets a signed-in person add a domain, with plain steps to connect it', () => {
    const html = render('ready');
    expect(html).toContain('id="settings-domains"');
    expect(html).toContain('placeholder="yourbrand.com"');
    expect(html).toContain('Add domain');
    expect(html).toContain('Loading your domains…');
    // the TXT record proves it's theirs; the domain is also linked to the app in Replit
    expect(html).toContain('add that TXT record');
    expect(html).toContain('Deployments → Settings → Link a domain');
    expect(html).toContain('DNS only, not proxied');
    expect(html).toContain('press “Check again”');
  });

  it('shows a domain’s TXT record, its name and value each with a Copy button, next to linking it in Replit', () => {
    const record = { name: '_ylb-domain.mybakery.com', value: 'ylb-0123456789abcdef0123456789abcdef01234567' };
    const txt = renderToStaticMarkup(createElement(TxtRecord, { record }));
    expect(txt).toContain('TXT');
    expect(txt).toContain(`<code class="min-w-0 flex-1 break-all font-mono text-[12.5px] text-ink">${record.name}</code>`);
    expect(txt).toContain(`<code class="min-w-0 flex-1 break-all font-mono text-[12.5px] text-ink">${record.value}</code>`);
    expect(txt.match(/<button type="button"[^>]*>/g)).toHaveLength(2);
    expect(txt).toContain('Copy name');
    expect(txt).toContain('Copy value');
    expect(txt).toContain('type the name without it');
    const steps = renderToStaticMarkup(createElement(ConnectSteps, { record }));
    expect(steps).toContain(record.value);
    expect(steps).toContain('Link the domain to this app in Replit: Deployments → Settings → Link a domain.');
    expect(steps).toContain('Press “Check again”.');
  });
});
