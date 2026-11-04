// The sales page as HTML on screen (short image placeholders), as a file (images inside it) and as
// published (image tokens that become the page's own image addresses, a full share-image address and the
// right canonical); image numbers are never shared or reused; undo keeps the last 15 AI changes.
import { describe, expect, it, vi } from 'vitest';
import type { MediaRef, Project, PromptImage } from '@/lib/types';

vi.mock('@/lib/promptImages', async (original) => ({
  ...(await original<typeof import('@/lib/promptImages')>()),
  // redrawing images needs a browser: stand in with a tiny data URL (none for 'm-gone') and one file per used key
  imageDataUrls: vi.fn(async (images: PromptImage[] = []) => Object.fromEntries(images.filter((i) => i.media.id !== 'm-gone').map((i) => [i.key, `data:image/jpeg;base64,${i.key.toUpperCase()}`]))),
  imagesForPublish: vi.fn(async (images: PromptImage[], keys: string[]) => images.filter((i) => keys.includes(i.key)).map((i) => ({ name: `${i.key}.jpg`, mime: 'image/jpeg', data: 'AAAA', hash: 'h' }))),
}));

const { newProject } = await import('@/store/defaults');
const { generateBrandKit } = await import('@/ai/local/brand');
const { generateSalesPage, generateSeoMeta, placeImages } = await import('@/ai/local/seo');
const { preparePublish, publishTarget } = await import('@/lib/publish');
const { highestImageNumber, joinImages, seoFileHtml, seoPageId, seoPublishBuild, seoSourceHtml, shownPromptImages } = await import('./seoPage');
const { UNDO_LIMIT, useSeoUndo } = await import('./seoUndo');

const media = (id: string): MediaRef => ({ id, kind: 'image', name: `${id}.jpg`, mime: 'image/jpeg', size: 1, createdAt: 0, w: 1200, h: 800 });
const img = (n: number, id = `m${n}`): PromptImage => ({ key: `img-${n}`, media: media(id) });

function project(): Project {
  const p = newProject('business', 'new');
  p.niche = 'Home Cleaning';
  p.category = 'Eco-friendly house cleaning';
  p.businessType = 'Home Cleaning';
  p.location = { city: 'Austin', region: 'TX' };
  const kit = generateBrandKit(p);
  p.brand = { ...p.brand, name: kit.nameOptions[0].name, slug: kit.slug, websiteUrl: '', colors: kit.colors };
  const images = [img(1), img(2), img(3)];
  p.marketing.seo = generateSeoMeta(p);
  p.marketing.seoImages = images;
  p.marketing.salesPage = placeImages(generateSalesPage(p), p, images, { hero: 'img-1', heroAlt: 'Our shop', gallery: [{ key: 'img-2', alt: 'A clean kitchen', caption: '' }] });
  return p;
}

describe('the page’s id for publishing', () => {
  it('is one per project, in the form the server takes', () => {
    expect(seoPageId({ ...project(), id: 'proj_abc123' })).toBe('seo:proj_abc123');
    expect(seoPageId({ ...project(), id: 'old id/with:odd chars' })).toBe('seo:old_id_with_odd_chars');
  });
});

describe('the HTML source on screen', () => {
  it('shows short {{img-N}} placeholders, never image data', () => {
    const html = seoSourceHtml(project());
    expect(html).toContain('<img src="{{img-1}}" alt="Our shop" width="1200" height="800"');
    expect(html).toContain('<img src="{{img-2}}" alt="A clean kitchen"');
    expect(html).not.toContain('base64');
    // img-3 isn't on the page
    expect(html).not.toContain('{{img-3}}');
  });
});

describe('the page as a file (Copy and Export HTML)', () => {
  it('puts the images inside it', async () => {
    const out = await seoFileHtml(project());
    expect(out.missing).toEqual([]);
    expect(out.html).toContain('<img src="data:image/jpeg;base64,IMG-1" alt="Our shop"');
    expect(out.html).toContain('<img src="data:image/jpeg;base64,IMG-2" alt="A clean kitchen"');
    expect(out.html).not.toContain('{{img-');
    expect(out.html).not.toContain('og:image"');
  });

  it('says which images couldn’t be loaded, and leaves them out', async () => {
    const p = project();
    p.marketing.seoImages = [img(1, 'm-gone'), img(2)];
    p.marketing.salesPage = placeImages(generateSalesPage(p), p, p.marketing.seoImages, { hero: 'img-1', gallery: [{ key: 'img-2' }] });
    const out = await seoFileHtml(p);
    expect(out.missing).toEqual([1]);
    expect(out.html).not.toContain('IMG-1');
    expect(out.html).toContain('IMG-2');
  });

  it('only prepares the images the page shows', () => {
    const p = project();
    expect(shownPromptImages(p.marketing.salesPage!, p.marketing.seoImages!).map((i) => i.key)).toEqual(['img-1', 'img-2']);
    const hidden = { ...p.marketing.salesPage!, sections: p.marketing.salesPage!.sections.map((s) => (s.type === 'gallery' ? { ...s, visible: false } : s)) };
    expect(shownPromptImages(hidden, p.marketing.seoImages!).map((i) => i.key)).toEqual(['img-1']);
  });
});

describe('the page as published', () => {
  it('uses image tokens, a full share-image address, and the public address as canonical', async () => {
    const p = project();
    const target = publishTarget('https://app.example', 'clean-austin');
    const build = seoPublishBuild(p, target);
    expect(build.images).toBe(p.marketing.seoImages);
    expect(build.html).toContain('<img src="{{img-1}}"');
    expect(build.html).toContain('<meta property="og:image" content="https://app.example{{img-1}}" />');
    expect(build.html).toContain('<meta name="twitter:image" content="https://app.example{{img-1}}" />');
    expect(build.html).toContain('<link rel="canonical" href="https://app.example/clean-austin" />');
    expect(build.html).toContain('<meta property="og:url" content="https://app.example/clean-austin" />');
    // what the Publish panel sends: tokens become the page's own image addresses
    const ready = await preparePublish(build, 'clean-austin');
    expect(ready.html).toContain('<img src="/clean-austin/img/img-1.jpg"');
    expect(ready.html).toContain('<meta property="og:image" content="https://app.example/clean-austin/img/img-1.jpg" />');
    expect(ready.html).toContain('"image": "https://app.example/clean-austin/img/img-1.jpg"');
    expect(ready.images.map((i) => i.name)).toEqual(['img-1.jpg', 'img-2.jpg']);
    expect(ready.html).not.toContain('{{');
  });

  it('points to the owner’s domain when it’s also shown there', () => {
    const build = seoPublishBuild(project(), publishTarget('https://app.example', 'clean-austin', 'cleanaustin.com', true));
    expect(build.html).toContain('<link rel="canonical" href="https://cleanaustin.com/" />');
    expect(build.html).toContain('<meta property="og:image" content="https://cleanaustin.com{{img-1}}" />');
  });

  it('keeps a canonical address the owner pasted (the page lives there), but not one the app made', () => {
    const p = project();
    p.brand.websiteUrl = 'https://site.example';
    const target = publishTarget('https://app.example', 'clean-austin');
    p.marketing.seo = { ...p.marketing.seo!, canonical: `https://site.example/${p.marketing.seo!.slug}` };
    expect(seoPublishBuild(p, target).html).toContain('<link rel="canonical" href="https://app.example/clean-austin" />');
    p.marketing.seo = { ...p.marketing.seo, canonical: 'https://site.example/landing' };
    expect(seoPublishBuild(p, target).html).toContain('<link rel="canonical" href="https://site.example/landing" />');
  });

  it('is empty without a page', () => {
    const p = project();
    p.marketing.salesPage = null;
    expect(seoPublishBuild(p, publishTarget('https://app.example', 'x-page'))).toEqual({ html: '', images: [] });
    expect(seoSourceHtml(p)).toBe('');
  });
});

describe('the page’s form', () => {
  // a lead form page: its form sends to the published page's /lead, and only once there is one
  const leadPage = (): Project => {
    const p = project();
    p.marketing.pageType = 'lead';
    p.marketing.salesPage = generateSalesPage(p, {}, 0, 'lead');
    return p;
  };
  const published = { slug: 'clean-austin', url: 'https://app.example/clean-austin', publishedAt: 1, hash: 'h' };

  it('as published, posts to /<name>/lead on whichever address shows it', () => {
    const build = seoPublishBuild(leadPage(), publishTarget('https://app.example', 'clean-austin'));
    expect(build.html).toContain('<form method="post" action="/clean-austin/lead" enctype="application/x-www-form-urlencoded" accept-charset="utf-8">');
    expect(build.html).not.toContain('<fieldset disabled>');
    // on the owner's domain (its home page too), the same relative address
    expect(seoPublishBuild(leadPage(), publishTarget('https://app.example', 'clean-austin', 'cleanaustin.com', true)).html).toContain('action="/clean-austin/lead"');
  });

  it('in a copy of the page (source, Copy and Export HTML), posts to the published page, else can’t send', async () => {
    const p = leadPage();
    expect(seoSourceHtml(p)).toContain('<fieldset disabled>');
    expect(seoSourceHtml(p)).toContain('Publish this page to collect leads.');
    expect((await seoFileHtml(p)).html).not.toContain('action=');
    p.marketing.seoPublished = published;
    expect(seoSourceHtml(p)).toContain('action="https://app.example/clean-austin/lead"');
    const file = await seoFileHtml(p);
    expect(file.html).toContain('<form method="post" action="https://app.example/clean-austin/lead"');
    expect(file.html).not.toContain('Publish this page to collect leads.');
  });

  it('a page without a form has no form address', () => {
    const p = project();
    p.marketing.seoPublished = published;
    expect(seoSourceHtml(p)).not.toContain('<form');
    expect(seoPublishBuild(p, publishTarget('https://app.example', 'clean-austin')).html).not.toContain('/lead');
  });
});

describe('image numbers', () => {
  it('track the highest one the page has used', () => {
    expect(highestImageNumber([])).toBe(0);
    expect(highestImageNumber([img(2), img(5)])).toBe(5);
    expect(highestImageNumber([img(2)], 7)).toBe(7);
  });

  it('are never shared or reused when an edit’s images join the page’s', () => {
    // img-3 was used before (and removed): a new image waiting as img-3 gets img-4
    const out = joinImages([img(1), img(2)], [img(3, 'new-a')], 3);
    expect(out.added.map((i) => [i.key, i.media.id])).toEqual([['img-4', 'new-a']]);
    // an image added under "Guide the AI" meanwhile took img-3
    expect(joinImages([img(1), img(3, 'other')], [img(3, 'new-a'), img(4, 'new-b')], 3).images.map((i) => [i.key, i.media.id])).toEqual([
      ['img-1', 'm1'],
      ['img-3', 'other'],
      ['img-4', 'new-a'],
      ['img-5', 'new-b'],
    ]);
    // the same file isn't added twice; a free number is kept
    expect(joinImages([img(1)], [img(2, 'm1'), img(5, 'x')]).added.map((i) => i.key)).toEqual(['img-5']);
  });
});

describe('undo', () => {
  it('keeps the last 15 AI changes per project, newest first out', () => {
    const snap = (n: number) => ({ salesPage: null, seo: { ...generateSeoMeta(project()), metaTitle: `v${n}` } });
    const { push, pop } = useSeoUndo.getState();
    for (let n = 1; n <= UNDO_LIMIT + 3; n++) push('p1', snap(n));
    push('p2', snap(99));
    expect(useSeoUndo.getState().stacks.p1).toHaveLength(UNDO_LIMIT);
    expect(pop('p1')?.seo?.metaTitle).toBe(`v${UNDO_LIMIT + 3}`);
    expect(pop('p1')?.seo?.metaTitle).toBe(`v${UNDO_LIMIT + 2}`);
    expect(pop('p2')?.seo?.metaTitle).toBe('v99');
    expect(pop('p2')).toBeUndefined();
    let last;
    while ((last = pop('p1'))) if (useSeoUndo.getState().stacks.p1.length === 0) break;
    expect(last?.seo?.metaTitle).toBe('v4');
  });

  it('keeps the page’s type with the page, so undoing a change of type brings both back', () => {
    const p = project();
    const { push, pop } = useSeoUndo.getState();
    push('p3', { salesPage: p.marketing.salesPage, seo: p.marketing.seo, pageType: 'booking' });
    push('p3', { salesPage: null, seo: null });
    expect(pop('p3')?.pageType).toBeUndefined();
    const snap = pop('p3');
    expect(snap?.pageType).toBe('booking');
    expect(snap?.salesPage).toBe(p.marketing.salesPage);
  });
});
