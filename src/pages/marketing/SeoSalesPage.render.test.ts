// What the SEO page builder shows (rendered once, as on the server: no effects run): the "Guide the AI"
// box with images before there's a page; then Edit with AI, the public page, Guide the AI with Rewrite
// page, the page's images on the canvas (alt text in Edit), and Undo after an AI change.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MediaRef, Project, PromptImage } from '@/lib/types';
import type { PublishAccess } from '@/lib/publish';

const state: { access: PublishAccess } = { access: 'ready' };
vi.mock('@/lib/publish', async (original) => ({ ...(await original<typeof import('@/lib/publish')>()), usePublishAccess: () => ({ access: state.access, retry: () => {} }) }));

// Rendered on the server, a zustand hook shows the store's first state: read the current one instead.
const live = <S,>(store: { getState: () => S }) => Object.assign(<T,>(select: (s: S) => T = (s) => s as unknown as T) => select(store.getState()), store);
vi.mock('@/store/useStore', async (original) => {
  const real = await original<typeof import('@/store/useStore')>();
  return { ...real, useStore: live(real.useStore), useActiveProject: () => real.getActiveProject() };
});
vi.mock('./seoUndo', async (original) => {
  const real = await original<typeof import('./seoUndo')>();
  return { ...real, useSeoUndo: live(real.useSeoUndo) };
});

const { useStore } = await import('@/store/useStore');
const { newProject, defaultSettings } = await import('@/store/defaults');
const { generateBrandKit } = await import('@/ai/local/brand');
const { generateSalesPage, generateSeoMeta, placeImages } = await import('@/ai/local/seo');
const { useSeoUndo } = await import('./seoUndo');
const { SalesPreview } = await import('./SalesPreview');
const { default: SeoSalesPage } = await import('./SeoSalesPage');

const media = (id: string): MediaRef => ({ id, kind: 'image', name: `${id}.jpg`, mime: 'image/jpeg', size: 1, createdAt: 0, w: 1200, h: 800, thumb: `data:image/jpeg;base64,${id}` });
const img = (n: number, note?: string): PromptImage => ({ key: `img-${n}`, media: media(`m${n}`), ...(note ? { note } : {}) });

function project(): Project {
  const p = { ...newProject('business', 'new'), id: 'proj_render1' };
  p.niche = 'Home Cleaning';
  p.category = 'Eco-friendly house cleaning';
  p.businessType = 'Home Cleaning';
  p.location = { city: 'Austin', region: 'TX' };
  const kit = generateBrandKit(p);
  p.brand = { ...p.brand, name: kit.nameOptions[0].name, slug: kit.slug, websiteUrl: '', colors: kit.colors };
  return p;
}

const render = (p: Project) => {
  useStore.setState({ projects: [p], activeProjectId: p.id, settings: defaultSettings() });
  return renderToStaticMarkup(createElement(SeoSalesPage));
};

beforeEach(() => {
  state.access = 'ready';
  useSeoUndo.setState({ stacks: {} });
});

describe('before there’s a page', () => {
  it('offers a box to guide the AI, with images, above Generate', () => {
    const p = project();
    p.marketing.seoGuide = 'Plain words, please.';
    p.marketing.seoImages = [img(1, 'Our van')];
    const html = render(p);
    expect(html).toContain('<label for="seo-guide" class="label">Guide the AI</label>');
    expect(html).toMatch(/<textarea[^>]*id="seo-guide"[^>]*>Plain words, please\.<\/textarea>/);
    expect(html).toContain('Images for the page');
    expect(html).toContain('value="Our van"');
    expect(html).toContain('Add more images');
    expect(html.indexOf('seo-guide')).toBeLessThan(html.indexOf('Generate SEO sales page'));
    expect(html).not.toContain('Edit with AI');
  });
});

describe('with a page', () => {
  const withPage = () => {
    const p = project();
    const images = [img(1, 'Shop front'), img(2), img(3)];
    p.marketing.seo = generateSeoMeta(p);
    p.marketing.seoImages = images;
    p.marketing.seoImageMax = 3;
    p.marketing.salesPage = placeImages(generateSalesPage(p), p, images, { hero: 'img-1', heroAlt: 'Our shop front', gallery: [{ key: 'img-2', alt: 'A clean kitchen', caption: 'After a deep clean' }] });
    return p;
  };

  it('has Edit with AI for the whole page or one section, with images', () => {
    const html = render(withPage());
    expect(html).toContain('Edit with AI');
    expect(html).toContain('Say what to change');
    expect(html).toContain('<option value="" selected="">Whole page</option>');
    for (const label of ['Hero &amp; CTA', 'Problem / agitation', 'Gallery', 'FAQ']) expect(html).toContain(`>${label}</option>`);
    expect(html).toMatch(/aria-expanded="false"[^>]*aria-controls="[^"]+-images"[^>]*>.*Images/);
    expect(html).toMatch(/<button type="submit" class="btn btn-ai btn-sm ml-auto" disabled="">/);
    expect(html).toContain('It never adds testimonials, numbers or guarantees');
  });

  it('has the public page, and Guide the AI with Rewrite page and the images not on the page yet', () => {
    const p = withPage();
    const html = render(p);
    expect(html).toContain('Public page');
    // the page's name starts as its SEO slug
    expect(p.marketing.seo!.slug).toMatch(/^[a-z0-9-]{3,}$/);
    expect(html).toContain(`value="${p.marketing.seo!.slug}"`);
    expect(html).toContain('Guide the AI');
    expect(html).toContain('No guidance');
    expect(html).toContain('3 images');
    expect(html).toContain('Not on the page yet: image 3.');
    expect(html).toContain('Add to the page');
    // open, since there's an image to place
    expect(html).toMatch(/<details class="panel group" open="">/);
  });

  it('shows the images on the canvas, with their alt text to edit', () => {
    const html = render(withPage());
    expect(html).toContain('<img src="data:image/jpeg;base64,m1" alt="Our shop front"');
    expect(html).toContain('<img src="data:image/jpeg;base64,m2" alt="A clean kitchen"');
    expect(html).toMatch(/<label for="[^"]+"[^>]*>Image 1 alt text<\/label><input id="[^"]+"[^>]*value="Our shop front"/);
    expect(html).toContain('aria-label="Remove the main image from the page"');
    expect(html).toContain('aria-label="Remove photo 1 from the page"');
    // click-to-edit text (filled in once it's on screen)
    expect(html).toContain('aria-label="Photo 1 caption"');
    expect(html).toContain('aria-label="Gallery heading"');
    // the HTML source shows short placeholders
    expect(html).toContain('&lt;img src=&quot;{{img-1}}&quot;');
    expect(html).toContain('Copy HTML and Export HTML put the images themselves into the file.');
  });

  it('offers Undo once there’s an AI change to undo', () => {
    const p = withPage();
    expect(render(p)).not.toContain('Undo the last AI change');
    useSeoUndo.getState().push(p.id, { salesPage: p.marketing.salesPage, seo: p.marketing.seo });
    expect(render(p)).toContain('aria-label="Undo the last AI change (1 can be undone)"');
  });

  it('says why publishing isn’t offered where it can’t be', () => {
    state.access = 'unavailable';
    expect(render(withPage())).toContain('Publishing at a public address isn’t available in this version of the app.');
  });
});

describe('the preview', () => {
  it('shows what the published page does: no removed image, no empty gallery', () => {
    const p = project();
    const images = [img(1), img(2)];
    const page = placeImages(generateSalesPage(p), p, images, { hero: 'img-1', gallery: [{ key: 'img-2', alt: 'Kitchen', caption: '' }] });
    const view = (imgs: PromptImage[], editing: boolean) => renderToStaticMarkup(createElement(SalesPreview, { page, brand: p.brand, editing, device: 'desktop', images: imgs, onData: () => {} }));
    // image 1 removed from the page's images: gone from the preview, a note while editing
    expect(view([images[1]], false)).not.toContain('base64,m1');
    expect(view([images[1]], true)).toContain('This image was removed from your page’s images.');
    expect(view([], false)).not.toContain('Photos from');
    expect(view([], true)).toContain('aria-label="Gallery heading"');
    expect(view(images, false)).toContain('Photos from');
    expect(view(images, false)).toContain('alt="Kitchen"');
    expect(view(images, false)).not.toContain('alt text');
  });
});
