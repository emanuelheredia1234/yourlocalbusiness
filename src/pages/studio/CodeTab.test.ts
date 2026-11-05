// What the Code & assets tab shows (rendered once, as on the server: no effects run): the New asset window's
// multi-line box to describe and guide a new asset with images, a multi-line "Edit with AI" box with the
// asset's images, each published asset's link, a way to publish, and a warning when the code uses an image
// that's gone. (Tooltips need their provider, as in the app.)
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CodeAsset, MediaRef, Project } from '@/lib/types';
import { newProject } from '@/store/defaults';
import { useStore } from '@/store/useStore';
import { STORAGE_SHIM } from '@/ai/local/code';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import { CodeTab, NewAssetForm } from './CodeTab';

// the text boxes size themselves in a layout effect, which a server render skips (and React says so)
const consoleError = console.error;
vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
  if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) consoleError(...args);
});

const media = (id: string): MediaRef => ({ id, kind: 'image', name: `${id}.jpg`, mime: 'image/jpeg', size: 1, createdAt: 0, thumb: `data:image/jpeg;base64,THUMB${id}` });

function project(assets: CodeAsset[] = []): Project {
  const p = newProject('business', 'new');
  p.niche = 'Bakery';
  p.brand.name = 'Crumb & Co';
  p.studio.codeAssets = assets;
  useStore.setState({ projects: [p], activeProjectId: p.id });
  return p;
}

const hero: CodeAsset = {
  id: 'code_hero1',
  name: 'Bakery hero',
  kind: 'hero',
  prompt: 'A warm hero',
  html: '<section><img class="hero-img" src="{{img-1}}" alt="Shop"><img src="{{img-2}}" alt=""></section>',
  css: '',
  js: '',
  // image 2 was removed from the list, but the code still uses it
  images: [{ key: 'img-1', media: media('a'), note: 'Shop front' }],
  published: { slug: 'bakery-hero', domain: 'crumb.example', url: 'https://app.example/bakery-hero', domainUrl: 'https://crumb.example/bakery-hero', publishedAt: 1, hash: '' },
  createdAt: 1,
  updatedAt: 1,
};

const render = (p: Project) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(CodeTab, { project: p })));
// the New asset window's form (a closed window renders nothing, and an open one renders in a portal)
const renderForm = (p: Project) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(NewAssetForm, { project: p, running: false, onGenerate: () => {} })));

describe('the Code & assets tab', () => {
  it('has a multi-line box to describe a new asset and guide the AI, with images and the type to pick', () => {
    const html = renderForm(project());
    expect(html).toMatch(/<label for="code-prompt"[^>]*>Describe it<\/label>/);
    expect(html).toMatch(/<textarea[^>]*id="code-prompt"[^>]*aria-describedby="code-prompt-hint"/);
    expect(html).toContain('id="code-prompt-hint"');
    expect(html).toContain('Paste or drop images here too.');
    expect(html).toMatch(/<button[^>]*aria-label="Add images"/);
    expect(html).toContain('accept="image/jpeg,image/png,image/webp,image/gif"');
    expect(html).toMatch(/role="radiogroup"[^>]*aria-label="Asset type"/);
    expect(html).toContain('Booking widget for Crumb &amp; Co with my packages');
    // with no assets yet, the tab says what to make and opens the window
    expect(render(project())).toContain('Make your first page or widget');
  });

  it('edits an asset with a multi-line "Edit with AI" box and the asset’s images', () => {
    const html = render(project([hero]));
    expect(html).toMatch(/<label for="code-edit"[^>]*>.*Edit with AI<\/label>/);
    expect(html).toMatch(/<textarea[^>]*id="code-edit"/);
    expect(html).not.toMatch(/<input[^>]*id="code-edit"/);
    expect(html).toContain('Images in this asset');
    expect(html).toContain('value="Shop front"');
    expect(html).toContain('aria-label="Remove image 1"');
    for (const q of ['Switch to a dark theme', 'Add a phone number field']) expect(html).toContain(q);
    expect(html).toMatch(/<button type="submit"[^>]*>.*Apply<\/button>/);
  });

  it('warns when the code uses an image that was removed, with a way to take it out', () => {
    const html = render(project([hero]));
    expect(html).toContain('Image 2 was removed, but the code still uses it, so nothing shows there.');
    expect(html).toContain('Take it out of the code');
  });

  it('shows each published asset’s link in the list, and offers publishing', () => {
    const html = render(project([hero, { ...hero, id: 'code_two', name: 'Price list', published: undefined }]));
    expect(html).toContain('href="https://crumb.example/bakery-hero"');
    expect(html).toContain('aria-label="https://crumb.example/bakery-hero: the public page of Bakery hero (opens in a new tab)"');
    expect(html).toContain('>crumb.example/bakery-hero</a>');
    expect(html.match(/the public page of/g)).toHaveLength(1);
    expect(html).toMatch(/aria-expanded="false" aria-controls="code-publish"[^>]*>.*Public page/);
    expect(html).toContain('Copy HTML');
    // Export .html, Duplicate and Delete are in the asset's ⋯ menu
    expect(html).toContain('aria-label="More asset actions"');
  });

  it('previews the page in a sandbox, with the images shown and storage that works', () => {
    const html = render(project([hero]));
    const frame = /<iframe[^>]*srcDoc="([^"]*)"[^>]*sandbox="allow-scripts allow-forms allow-popups allow-modals"/i.exec(html) ?? /<iframe[^>]*sandbox="allow-scripts allow-forms allow-popups allow-modals"[^>]*>/i.exec(html);
    expect(frame).not.toBeNull();
    // the thumbnail shows at once, before the full-size picture is made
    expect(html).toContain('data:image/jpeg;base64,THUMBa');
    expect(html).not.toContain('{{img-1}}');
    expect(html).toContain('localStorage');
    expect(STORAGE_SHIM).toContain('defineProperty');
  });

  it('offers Build with Manus and Build with Viktor beside New asset (until the server answers, they wait, saying why)', () => {
    const html = render(project());
    expect(html).toMatch(/New asset[\s\S]*Build with Manus[\s\S]*Build with Viktor/);
    expect(html).toContain('title="Checking your AI server…"');
  });

  it('has no Build with… buttons in the claude.ai build', () => {
    vi.stubGlobal('__ARTIFACT_BUILD__', true);
    try {
      const html = render(project());
      expect(html).toContain('New asset');
      expect(html).not.toContain('Build with');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('an asset Manus or Viktor made says so in the list and its header, with a link to the task or thread', () => {
    const html = render(project([{ ...hero, published: undefined, source: { via: 'viktor', url: 'https://slack.example/p1', at: 1 } }]));
    expect(html).toContain('· Viktor</span>');
    expect(html).toMatch(/<a href="https:\/\/slack.example\/p1"[^>]*title="Made by Viktor: open the Slack thread"[^>]*>Viktor/);
  });
});
