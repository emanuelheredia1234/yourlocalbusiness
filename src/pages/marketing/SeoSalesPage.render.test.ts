// What the SEO page builder shows (rendered once, as on the server: no effects run): the "Guide the AI"
// box with images before there's a page; then Edit with AI, the public page, Guide the AI with Rewrite
// page, the page's images on the canvas (alt text in Edit), and Undo after an AI change.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/shadcn/tooltip';
import type { MediaRef, PageType, Project, PromptImage, SalesPage } from '@/lib/types';
import type { PublishAccess } from '@/lib/publish';

const state: { access: PublishAccess } = { access: 'ready' };
vi.mock('@/lib/publish', async (original) => ({ ...(await original<typeof import('@/lib/publish')>()), usePublishAccess: () => ({ access: state.access, retry: () => {} }) }));

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

const { useStore } = await import('@/store/useStore');
const { newProject, defaultSettings } = await import('@/store/defaults');
const { generateBrandKit } = await import('@/ai/local/brand');
const { generateSalesPage, generateSeoMeta, pageTargets, placeImages } = await import('@/ai/local/seo');
const { useSeoUndo } = await import('@/store/seoUndo');
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
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(SeoSalesPage)));
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
    expect(html.indexOf('seo-guide')).toBeLessThan(html.indexOf('Write page'));
    expect(html).not.toContain('Edit with AI');
  });

  it('asks what kind of page to write first: six choices, a landing page unless the owner chose', () => {
    const html = render(project());
    expect(html).toContain('<legend class="label">What kind of page?</legend>');
    expect(html.match(/<input type="radio"/g)).toHaveLength(6);
    expect(html).toMatch(/<input type="radio"[^>]* checked=""[^>]* value="landing"/);
    expect(html.match(/ checked=""/g)).toHaveLength(1);
    for (const label of ['Lead form page', 'Booking page', 'Website', 'Landing page', 'Showcase page', 'Checkout page']) expect(html).toContain(`>${label}</span>`);
    // the empty state names the chosen type (spec E07: "Write your {type} page")
    expect(html).toContain('Write your landing page');
    expect(html.indexOf('What kind of page?')).toBeLessThan(html.indexOf('seo-guide'));
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>).)*Write page/);
    expect(html).not.toContain('Add your payment link first');
  });

  it('a checkout page needs the owner’s payment link before it’s written', () => {
    const p = project();
    p.marketing.pageType = 'checkout';
    const html = render(p);
    expect(html).toMatch(/<input type="radio"[^>]* checked=""[^>]* value="checkout"/);
    expect(html).toContain('Your payment link</label>');
    expect(html).toContain('the app never takes payments');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Write page/);
    expect(html).toContain('Add your payment link first. The app never takes payments: Buy now opens your own link.');
    // no price set yet: the page would show "Ask for a quote"
    expect(html).toContain('Checkout pages show the price: set it in Studio, or type it on the page.');
    // with one, it can be written
    p.marketing.pageLinks = { payment: 'https://buy.stripe.com/test_1' };
    const ok = render(p);
    expect(ok).not.toContain('Add your payment link first');
    expect(ok).toContain('value="https://buy.stripe.com/test_1"');
    // a link that isn't one says so
    p.marketing.pageLinks = { payment: 'not a link' };
    expect(render(p)).toContain('Use a web address, like https://buy.stripe.com/…');
  });

  it('a booking page offers the booking link field, with the listing’s link when it has one', () => {
    const p = project();
    p.marketing.pageType = 'booking';
    expect(render(p)).toContain('Your booking link (optional)</label>');
    p.studio.listing = { ...p.studio.listing, bookingType: 'book', buyUrl: 'https://cal.example.com/sparkle' };
    expect(render(p)).toContain('Using your listing’s booking link (cal.example.com). Paste another to use it on this page only.');
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
    // the AI composer: new images for the change, and Apply (disabled until there's a request)
    expect(html).toContain('aria-label="Add images"');
    expect(html).toMatch(/<button(?=[^>]*class="btn btn-ai-outline btn-sm")(?=[^>]*disabled="")[^>]*>(?:(?!<\/button>).)*Apply<\/button>/);
    // what the AI never adds is behind the composer's ⓘ
    expect(html).toContain('aria-label="About AI edits"');
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
    expect(html).toMatch(/<div(?=[^>]*data-item="guide")(?=[^>]*data-state="open")[^>]*>/);
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

  it('shows the page’s type, with Change', () => {
    const html = render(withPage());
    expect(html).toContain('aria-label="Page type"');
    expect(html).toMatch(/>Page type<\/span><span[^>]*>Landing page<\/span>/);
    // Change opens a window with the six types
    expect(html).toMatch(/<button type="button" class="btn btn-secondary btn-xs self-start" aria-haspopup="dialog"[^>]*>Change<\/button>/);
    expect(html).toContain('One offer and one call to action.');
    expect(html).toContain('>SEO page</h1>');
  });

  it('a booking page without a booking link says visitors send a request instead', () => {
    const p = project();
    p.marketing.pageType = 'booking';
    p.marketing.seo = generateSeoMeta(p);
    p.marketing.salesPage = generateSalesPage(p, {}, 0, 'booking');
    const html = render(p);
    expect(html).toContain('No booking link yet: visitors send a request with the form instead. Add your booking link under Page type to let them book straight away.');
    expect(html).toMatch(/>Page type<\/span><span[^>]*>Booking page<\/span>/);
    expect(html).toContain('Your booking link (optional)</label>');
    // the preview's form (it asks for a time): it never sends, and has no address
    expect(html).toContain('aria-label="Form heading"');
    expect(html).toContain('>Preferred day and time</label>');
    expect(html).not.toMatch(/<form[^>]*action=/);
  });

  it('a checkout page without its payment link warns that Buy now opens nothing', () => {
    const p = project();
    p.marketing.pageType = 'checkout';
    p.marketing.seo = generateSeoMeta(p);
    p.marketing.salesPage = generateSalesPage(p, {}, 0, 'checkout');
    expect(render(p)).toContain('Buy now doesn’t open anything yet: add your payment link under Page type.');
  });

  it('a published page with a form points to Email → Leads', () => {
    const p = project();
    p.marketing.pageType = 'lead';
    p.marketing.seo = generateSeoMeta(p);
    p.marketing.salesPage = generateSalesPage(p, {}, 0, 'lead');
    expect(render(p)).toContain('The form starts collecting leads once you publish this page.');
    p.marketing.seoPublished = { slug: 'sparkle', url: 'https://app.example/sparkle', publishedAt: 1, hash: 'h' };
    const html = render(p);
    expect(html).toContain('What people send with the form arrives in Email → Leads.');
    expect(html).toContain('>Open Leads</button>');
  });

  it('says why publishing isn’t offered where it can’t be', () => {
    state.access = 'unavailable';
    expect(render(withPage())).toContain('Publishing at a public address isn’t available in this version of the app.');
  });
});

describe('the preview', () => {
  const view = (p: Project, page: SalesPage, pageType: PageType, editing: boolean) =>
    renderToStaticMarkup(createElement(SalesPreview, { page, brand: p.brand, business: p.track === 'business', editing, device: 'desktop', pageType, targets: pageTargets(page, { ...p, marketing: { ...p.marketing, pageType } }), onData: () => {} }));

  it('a website has its menu as buttons that scroll the preview (never # links: the app routes on them)', () => {
    const p = project();
    p.studio.listing = { ...p.studio.listing, phone: '(512) 555-0142' };
    const html = view(p, generateSalesPage(p, {}, 0, 'website'), 'website', false);
    expect(html).toContain('aria-label="Page menu (preview)"');
    for (const label of ['Home', 'About', 'FAQ', 'Contact']) expect(html).toMatch(new RegExp(`<button type="button"[^>]*>${label}</button>`));
    expect(html).not.toContain('href="#');
    expect(html).toContain('data-section="about"');
  });

  it('the form shows the app’s fields, sends nothing, and has no address', () => {
    const p = project();
    const page = generateSalesPage(p, {}, 0, 'lead');
    const html = view(p, page, 'lead', false);
    expect(html).toMatch(/<form[^>]*>/);
    expect(html).not.toMatch(/<form[^>]*action=/);
    for (const label of ['Your name', 'Email', 'Phone (optional)', 'Message (optional)']) expect(html).toContain(`>${label}</label>`);
    expect(html).toContain('<button type="submit"');
    expect(html).toContain('role="status"');
    const editing = view(p, page, 'lead', true);
    expect(editing).toContain('What they send arrives in Email → Leads once the page is published.');
    expect(editing).toContain('Ask for a preferred time');
  });

  it('offered items have their price, button, link and image controls in Edit', () => {
    const p = project();
    p.studio.packages = [
      { id: 'a', name: 'Standard clean', price: 120, priceModel: 'per-session', description: 'Kitchen and bathrooms.', includes: [] },
      { id: 'b', name: 'Move-out clean', price: 0, priceModel: 'quote', description: '', includes: [] },
    ];
    const page = generateSalesPage(p, {}, 0, 'showcase');
    const editing = view(p, page, 'showcase', true);
    expect(editing).toMatch(/<input type="number"[^>]*aria-label="Price of Standard clean \(empty: Ask for a quote\)" value="120"/);
    expect(editing).toContain(' Add an item</button>');
    expect(editing).toContain('Its own link (optional)');
    expect(editing).toContain('>No image</option>');
    expect(editing).toContain('>Remove Standard clean</button>');
    // the listing sells (the default): Buy buttons wait for a payment link
    expect(editing).toContain('Hidden on your page: no payment link.');
    expect(editing).toContain('Buy buttons need a payment link: add one under Page type, or give the item its own link.');
    // a business without packages: an empty list, and where to add them
    const none = generateSalesPage(project(), {}, 0, 'showcase');
    expect(view(project(), none, 'showcase', true)).toContain('Add your services in Studio, or add items here.');
    expect(view(project(), none, 'showcase', false)).not.toContain('data-section="offers"><section');
    const live = view(p, page, 'showcase', false);
    expect(live).toContain('>$120</b>');
    expect(live).toContain('>Ask for a quote</b>');
    expect(live).toContain('>Get a quote</span>');
    expect(live).not.toContain('Buy now');
    expect(live).not.toContain('type="number"');
  });

  it('a button with nowhere to go is shown faded in Edit, and left off in Preview', () => {
    const p = project();
    const page = generateSalesPage(p, {}, 0, 'lead');
    const noForm = { ...page, sections: page.sections.map((s) => (s.type === 'leadForm' ? { ...s, visible: false } : s)) };
    expect(view(p, noForm, 'lead', true)).toContain('Hidden on your page: nothing on the page for it to open.');
    expect(view(p, noForm, 'lead', false)).not.toContain('Get in touch');
    expect(view(p, page, 'lead', false)).toContain('Get in touch');
  });

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
