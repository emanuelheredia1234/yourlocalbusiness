// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"handleDisabledFileLoadingAsSuccess":true}}
// The SEO page in HTML mode (a page Manus or Viktor made is the one in use), rendered once as on the server: the
// standing "check every claim" note, Version, the score read from its HTML, Publish and metadata, the preview and
// its source; none of the builder's editing (Edit with AI, Sections, the theme, Rewrite page). With the builder's
// page in use, Version is at the top. (A DOM environment: the score reads the page with DOMParser.)
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project, SeoHtml } from '@/lib/types';

vi.mock('@/lib/publish', async (original) => ({ ...(await original<typeof import('@/lib/publish')>()), usePublishAccess: () => ({ access: 'ready', retry: () => {} }) }));
// Rendered on the server, a zustand hook shows the store's first state: read the current one instead.
const live = <S,>(store: { getState: () => S }) => Object.assign(<T,>(select: (s: S) => T = (s) => s as unknown as T) => select(store.getState()), store);
vi.mock('@/store/useStore', async (original) => {
  const real = await original<typeof import('@/store/useStore')>();
  return { ...real, useStore: live(real.useStore), useActiveProject: () => real.getActiveProject() };
});
vi.mock('@/store/seoUndo', async (original) => {
  const real = await original<typeof import('@/store/seoUndo')>();
  return { ...real, useSeoUndo: live(real.useSeoUndo) };
});
const consoleError = console.error;
vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
  if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) consoleError(...args);
});

const { useStore } = await import('@/store/useStore');
const { newProject, defaultSettings } = await import('@/store/defaults');
const { generateSalesPage, generateSeoMeta } = await import('@/ai/local/seo');
const { useSeoUndo } = await import('@/store/seoUndo');
const { default: SeoSalesPage } = await import('./SeoSalesPage');

const seoHtml = (active: boolean): SeoHtml => ({
  html: '<header><h1>Calm yoga in Austin</h1><p>Classes for beginners.</p><a href="#c">Book</a></header><section id="c"><h2>Contact</h2><form method="post" action="{{lead-action}}"><input name="email" maxlength="254"><button>Send</button></form></section>',
  css: 'h1{color:#123}',
  images: [],
  source: { via: 'viktor', url: 'https://slack.example/p1', buildId: 'b1', at: 1 },
  title: 'Calm yoga',
  description: 'Classes for beginners.',
  notes: ['Took out JavaScript: your SEO page runs without scripts.', 'Your page’s form sends to Email → Leads once it’s published.'],
  active,
  hasLeadForm: true,
  importedAt: 1,
});

function project(o: { active: boolean; structured?: boolean }): Project {
  const p = { ...newProject('business', 'new'), id: 'proj_html1' };
  p.brand = { ...p.brand, name: 'Calm Studio' };
  p.marketing.seo = generateSeoMeta(p);
  p.marketing.seoHtml = seoHtml(o.active);
  if (o.structured) p.marketing.salesPage = generateSalesPage(p);
  return p;
}

const render = (p: Project) => {
  useStore.setState({ projects: [p], activeProjectId: p.id, settings: defaultSettings() });
  return renderToStaticMarkup(createElement(SeoSalesPage));
};

beforeEach(() => useSeoUndo.setState({ stacks: {} }));

describe('HTML mode', () => {
  it('shows the standing note, Version, the score, Publish, metadata, the preview and the source; none of the builder’s editing', () => {
    const html = render(project({ active: true, structured: true }));
    expect(html).toContain('Viktor wrote this page. Check every claim, price and testimonial before you publish: the app can’t check free HTML.');
    expect(html).toContain('aria-label="Version"');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Viktor’s page<\/button>/);
    expect(html).toContain('The app’s builder');
    expect(html).toContain('aria-label="SEO score"');
    expect(html).toContain('Public page');
    expect(html).toContain('aria-label="SEO metadata"');
    expect(html).toContain('Took out JavaScript: your SEO page runs without scripts.');
    expect(html).toContain('The form starts collecting leads once you publish this page');
    expect(html).toContain('sandbox="allow-popups allow-popups-to-escape-sandbox"');
    expect(html).toContain('HTML source');
    expect(html).toContain('Remove Viktor’s page');
    for (const builderOnly of ['Edit with AI', 'aria-label="Visual page editor"', 'Rewrite page', '>Sections<', 'Guide the AI']) expect(html).not.toContain(builderOnly);
    // header: the file actions, no Rewrite page
    expect(html).toContain('Copy HTML');
    expect(html).toContain('Export HTML');
  });

  it('the source has the app’s head and no script but its JSON-LD', () => {
    const html = render(project({ active: true }));
    const source = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(html)![1];
    expect(source).toContain('&lt;script type=&quot;application/ld+json&quot;&gt;');
    expect(source.match(/&lt;script/g)).toHaveLength(1);
    expect(source).toContain('&lt;title&gt;');
  });
});

describe('with the builder’s page in use', () => {
  it('Version is at the top, so the owner can switch back to Viktor’s page', () => {
    const html = render(project({ active: false, structured: true }));
    expect(html).toContain('aria-label="Version"');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>The app’s builder<\/button>/);
    expect(html).toContain('Edit with AI');
    expect(html).not.toContain('Viktor wrote this page');
  });

  it('with no builder page yet, Version shows above Write page', () => {
    const html = render(project({ active: false }));
    expect(html).toContain('aria-label="Version"');
    expect(html).toContain('Write page');
    expect(html.indexOf('aria-label="Version"')).toBeLessThan(html.indexOf('Write page'));
  });
});
