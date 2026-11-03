// What the Publish panel shows in each state (rendered once, as on the server: no effects run).
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Published } from '@/lib/types';
import type { PublishAccess } from '@/lib/publish';

const state: { access: PublishAccess } = { access: 'ready' };
vi.mock('@/lib/publish', async (original) => ({ ...(await original<typeof import('@/lib/publish')>()), usePublishAccess: () => ({ access: state.access, retry: () => {} }) }));

const { PublishPanel } = await import('./PublishPanel');

const published: Published = { slug: 'my-menu', domain: 'mybakery.com', home: true, url: 'https://app.example/my-menu', domainUrl: 'https://mybakery.com/', publishedAt: Date.now() - 60_000, hash: 'h' };
const render = (access: PublishAccess, p?: Published) => {
  state.access = access;
  return renderToStaticMarkup(createElement(PublishPanel, { pageId: 'seo:proj_1', kind: 'seo', title: 'Our menu', defaultSlug: 'My Menu & Prices', published: p, build: () => ({ html: '<p>Hi</p>', images: [] }), onChange: () => {} }));
};

describe('the Publish panel', () => {
  it('offers a name for a page that isn’t published', () => {
    const html = render('ready');
    expect(html).toContain('Not published');
    expect(html).toContain('value="my-menu-and-prices"');
    expect(html).toContain('placeholder="your-page-name"');
    expect(html).toMatch(/<button type="submit"[^>]*disabled[^>]*>Publish<\/button>/);
    expect(html).not.toContain('Unpublish');
  });

  it('shows a published page’s links with Copy and Open, and what can be done', () => {
    const html = render('ready', published);
    expect(html).toContain('>Published<');
    for (const url of ['https://app.example/my-menu', 'https://mybakery.com/']) {
      expect(html).toContain(`href="${url}"`);
      expect(html).toContain(`aria-label="Open ${url} in a new tab"`);
    }
    expect(html).toContain('rel="noopener noreferrer"');
    for (const label of ['Update', 'Change address', 'Unpublish', 'Copy']) expect(html).toContain(label);
    expect(html).toContain('Published 1m ago');
  });

  it('says why publishing isn’t available', () => {
    expect(render('checking')).toContain('Checking whether you can publish');
    expect(render('unavailable')).toContain('isn’t available in this version of the app');
    expect(render('off')).toContain('isn’t set up on this app’s server yet');
    const out = render('unreachable');
    expect(out).toContain('Couldn’t reach the app’s server');
    expect(out).toContain('Try again');
    const signedOut = render('signed-out');
    expect(signedOut).toContain('Sign in to publish this page');
    expect(signedOut).toContain('Sign in</button>');
  });

  it('keeps showing a published page’s links when signed out', () => {
    const html = render('signed-out', published);
    expect(html).toContain('Sign in to update or unpublish this page.');
    expect(html).toContain('href="https://app.example/my-menu"');
    expect(html).not.toContain('Unpublish</button>');
  });
});
