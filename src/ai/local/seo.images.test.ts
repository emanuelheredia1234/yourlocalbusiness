// The sales page's own images: where they go (hero, gallery), that they stay the owner's (the AI only
// places them and describes them), what the HTML export and the score do with them.
import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { GalleryData, HeroData, MediaRef, Project, PromptImage, SalesPage, SalesSection } from '@/lib/types';
import { generateBrandKit } from './brand';
import {
  aiWritableData,
  altFromNote,
  applyEdit,
  exportSalesHtml,
  generateSalesPage,
  generateSalesSection,
  generateSeoMeta,
  imageKeyFrom,
  imagePlanFrom,
  keepFacts,
  ownCanonical,
  pageImageIds,
  pageText,
  placeImages,
  placeNewImages,
  pruneImages,
  scoreSeo,
  withOwnerFacts,
  withoutImageTokens,
} from './seo';

function project(track: 'product' | 'business' = 'business'): Project {
  const p = newProject(track, 'new');
  p.niche = track === 'business' ? 'Home Cleaning' : 'Personal Finance';
  p.category = track === 'business' ? 'Eco-friendly house cleaning' : 'Freelancer Tax Tracking';
  if (track === 'business') {
    p.businessType = 'Home Cleaning';
    p.location = { city: 'Austin', region: 'TX' };
  } else p.format = 'spreadsheet';
  const kit = generateBrandKit(p);
  p.brand = { ...p.brand, name: kit.nameOptions[0].name, slug: kit.slug, websiteUrl: '', colors: kit.colors };
  return p;
}

const media = (id: string, patch: Partial<MediaRef> = {}): MediaRef => ({ id, kind: 'image', name: `${id}.jpg`, mime: 'image/jpeg', size: 1, createdAt: 0, w: 1200, h: 800, ...patch });
const img = (n: number, note?: string): PromptImage => ({ key: `img-${n}`, media: media(`m${n}`), ...(note ? { note } : {}) });

const sec = <T extends SalesSection['type']>(page: SalesPage, type: T) => page.sections.find((s) => s.type === type) as Extract<SalesSection, { type: T }> | undefined;
const hero = (page: SalesPage) => sec(page, 'hero')!.data as HeroData;
const gallery = (page: SalesPage) => sec(page, 'gallery')?.data as GalleryData | undefined;

describe('the gallery section', () => {
  it('is not on a new page, and promises nothing when it’s made', () => {
    const p = project();
    expect(generateSalesPage(p).sections.map((s) => s.type)).not.toContain('gallery');
    const g = generateSalesSection(p, 'gallery');
    expect(g.type).toBe('gallery');
    expect(g.visible).toBe(true);
    expect(g.data).toEqual({ heading: `Photos from ${p.brand.name}`, intro: '', items: [] });
    expect((generateSalesSection(project('product'), 'gallery').data as GalleryData).heading).toMatch(/^A closer look at /);
  });

  it('keeps the owner’s photos when it’s written again', () => {
    const p = project();
    const page = placeImages(generateSalesPage(p), p, [img(1), img(2)], { gallery: [{ key: 'img-1' }, { key: 'img-2', caption: 'Our van' }] });
    p.marketing.salesPage = page;
    expect((generateSalesSection(p, 'gallery').data as GalleryData).items.map((i) => i.imageId)).toEqual(['m1', 'm2']);
  });
});

describe('images are the owner’s facts', () => {
  it('are never sent to the AI as copy, and come back from the page whatever the AI returns', () => {
    const p = project();
    const page = placeImages(generateSalesPage(p), p, [img(1), img(2)], { hero: 'img-1', heroAlt: 'Our shop', gallery: [{ key: 'img-2' }] });
    const h = sec(page, 'hero')!;
    const g = sec(page, 'gallery')!;
    expect(Object.keys(aiWritableData(h))).not.toContain('imageId');
    expect(Object.keys(aiWritableData(h))).not.toContain('imageAlt');
    expect(Object.keys(aiWritableData(g)).sort()).toEqual(['heading', 'intro']);
    const forged = { ...h, data: { ...h.data, imageId: 'someone-else', imageAlt: 'x' } } as SalesSection;
    expect(keepFacts(forged, h).data).toMatchObject({ imageId: 'm1', imageAlt: 'Our shop' });
    const forgedG = { ...g, data: { ...g.data, heading: 'New', items: [] } } as SalesSection;
    expect(keepFacts(forgedG, g).data).toMatchObject({ heading: 'New', items: g.data.items });
  });
});

describe('placing images', () => {
  const p = project();
  const images = [img(1, 'Our shop front'), img(2), img(3, 'use it at the top')];

  it('puts the hero’s image and a gallery (added visible, right after the solution)', () => {
    const page = placeImages(generateSalesPage(p), p, images, { hero: 'img-2', heroAlt: 'A clean kitchen', gallery: [{ key: 'img-1', alt: 'Shop front', caption: 'Where to find us' }, { key: 'img-3' }], galleryHeading: 'Our work', galleryIntro: 'Recent jobs.' });
    expect(hero(page)).toMatchObject({ imageId: 'm2', imageAlt: 'A clean kitchen' });
    const types = page.sections.map((s) => s.type);
    expect(types.indexOf('gallery')).toBe(types.indexOf('solution') + 1);
    expect(sec(page, 'gallery')!.visible).toBe(true);
    expect(gallery(page)).toEqual({ heading: 'Our work', intro: 'Recent jobs.', items: [{ imageId: 'm1', alt: 'Shop front', caption: 'Where to find us' }, { imageId: 'm3', alt: '', caption: '' }] });
  });

  it('ignores keys the page doesn’t have and shows each image once (the hero wins)', () => {
    const page = placeImages(generateSalesPage(p), p, images, { hero: 'img-1', gallery: [{ key: 'img-1' }, { key: 'img-9' }, { key: 'img-2' }, { key: 'img-2' }] });
    expect(hero(page).imageId).toBe('m1');
    expect(gallery(page)!.items.map((i) => i.imageId)).toEqual(['m2']);
    // an unknown hero key changes nothing; null takes the image off
    expect(hero(placeImages(page, p, images, { hero: 'img-7' })).imageId).toBe('m1');
    expect(hero(placeImages(page, p, images, { hero: null })).imageId).toBeUndefined();
    expect(hero(placeImages(page, p, images, { hero: null }))).not.toHaveProperty('imageAlt');
  });

  it('always puts new images on the page: the ones not placed go at the end of the gallery', () => {
    const page = placeImages(generateSalesPage(p), p, images, { hero: 'img-1' }, ['img-1', 'img-2', 'img-3']);
    expect(hero(page).imageId).toBe('m1');
    expect(gallery(page)!.items.map((i) => i.imageId)).toEqual(['m2', 'm3']);
  });

  it('keeps an existing gallery’s place, visibility and words when it changes', () => {
    const first = placeImages(generateSalesPage(p), p, images, { gallery: [{ key: 'img-1', alt: 'Shop', caption: 'Hello' }] });
    const hidden: SalesPage = { ...first, sections: first.sections.map((s) => (s.type === 'gallery' ? { ...s, visible: false } : s)) };
    const moved: SalesPage = { ...hidden, sections: [...hidden.sections.filter((s) => s.type !== 'gallery'), hidden.sections.find((s) => s.type === 'gallery')!] };
    const next = placeImages(moved, p, images, { hero: 'img-1' }, ['img-2']);
    expect(next.sections.at(-1)!.type).toBe('gallery');
    expect(next.sections.at(-1)!.visible).toBe(false);
    expect(next.sections.at(-1)!.id).toBe(moved.sections.at(-1)!.id);
    // the hero took img-1 from the gallery; img-2 is new
    expect(gallery(next)!.items).toEqual([{ imageId: 'm2', alt: '', caption: '' }]);
    // moving it to the hero keeps the alt text it had
    expect(hero(next).imageAlt).toBe('Shop');
  });

  it('the built-in engine: the first image in the hero (when it has none), the others in the gallery', () => {
    const page = placeNewImages(generateSalesPage(p), p, images, ['img-1', 'img-2', 'img-3']);
    expect(hero(page)).toMatchObject({ imageId: 'm1', imageAlt: 'Our shop front' });
    expect(gallery(page)!.items.map((i) => [i.imageId, i.alt, i.caption])).toEqual([
      ['m2', '', ''],
      ['m3', '', ''], // "use it at the top" says where, not what it shows
    ]);
    const more = [...images, img(4)];
    expect(hero(placeNewImages(page, p, more, ['img-4'])).imageId).toBe('m1');
    expect(gallery(placeNewImages(page, p, more, ['img-4']))!.items.map((i) => i.imageId)).toEqual(['m2', 'm3', 'm4']);
    expect(placeNewImages(page, p, more, [])).toBe(page);
  });

  it('takes images off the page when they’re removed from its images', () => {
    const page = placeNewImages(generateSalesPage(p), p, images, ['img-1', 'img-2', 'img-3']);
    const left = pruneImages(page, [images[1]]);
    expect(hero(left).imageId).toBeUndefined();
    expect(gallery(left)!.items.map((i) => i.imageId)).toEqual(['m2']);
    expect(pruneImages(page, images)).toBe(page);
    expect(pageImageIds(page)).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('reading the AI’s image answer', () => {
  it('keeps only keys and short, plain lines', () => {
    expect(imageKeyFrom('img-2')).toBe('img-2');
    expect(imageKeyFrom('{{IMG-02}}')).toBe('img-2');
    expect(imageKeyFrom('img-0')).toBe('');
    expect(imageKeyFrom('https://x/y.jpg')).toBe('');
    const plan = imagePlanFrom({ hero: '{{img-3}}', heroAlt: 'A  clean\nkitchen {{img-3}}', gallery: ['img-1', { key: 'img-2', alt: 'x'.repeat(300), caption: 'Our team' }, { key: 'nope' }], galleryHeading: 'Work', galleryIntro: '' });
    expect(plan).toEqual({ hero: 'img-3', heroAlt: 'A clean kitchen', gallery: [{ key: 'img-1', alt: '', caption: '' }, { key: 'img-2', alt: `${'x'.repeat(149)}…`, caption: 'Our team' }], galleryHeading: 'Work' });
    expect(imagePlanFrom({ hero: null })).toEqual({ hero: null });
    expect(imagePlanFrom({})).toEqual({});
    expect(imagePlanFrom(null)).toBeNull();
    expect(imagePlanFrom(['img-1'])).toBeNull();
  });

  it('takes alt text from a note that says what the image shows, not where it goes', () => {
    expect(altFromNote('Our shop front')).toBe('Our shop front');
    expect(altFromNote('  The team,\n at work ')).toBe('The team, at work');
    expect(altFromNote('use it at the top')).toBe('');
    expect(altFromNote('Hero image please')).toBe('');
    expect(altFromNote('Kitchen after a deep clean, put it in the gallery')).toBe('');
    expect(altFromNote()).toBe('');
  });

  it('removes image tokens from copy, leaving other text exactly as it is', () => {
    expect(withoutImageTokens({ a: 'See {{img-1}} here', b: ['x  {{ img-2 }}'], c: 'two  spaces stay', n: 3 })).toEqual({ a: 'See here', b: ['x'], c: 'two  spaces stay', n: 3 });
  });
});

describe('an AI edit keeps the owner’s facts', () => {
  const p = project();
  const images = [img(1), img(2)];
  const base = (() => {
    const page = placeNewImages(generateSalesPage(p), p, images, ['img-1', 'img-2']);
    return {
      ...page,
      sections: page.sections.map((s): SalesSection => (s.type === 'proof' ? { ...s, data: { ...s.data, testimonials: [{ quote: 'Spotless, every time!', name: 'Lee K.', role: '', rating: 5 }] } } : s)),
    };
  })();

  it('puts the testimonials, prices and fine print back, by section id, but keeps where it put the images', () => {
    const next: SalesPage = {
      ...base,
      sections: base.sections.map((s): SalesSection => {
        if (s.type === 'proof') return { ...s, data: { ...s.data, testimonials: [{ quote: 'Spotless, every time', name: 'Lee K.', role: '', rating: 5 }] } };
        if (s.type === 'pricing') return { ...s, data: { ...s.data, price: 1, heading: 'New pricing' } };
        if (s.type === 'hero') return { ...s, data: { ...s.data, headline: 'New', imageId: 'm2', imageAlt: 'Van' } };
        if (s.type === 'gallery') return { ...s, data: { ...s.data, items: [{ imageId: 'm1', alt: 'Shop', caption: '' }] } };
        return s;
      }),
    };
    const out = withOwnerFacts(next, base);
    expect(sec(out, 'proof')!.data.testimonials[0].quote).toBe('Spotless, every time!');
    expect(sec(out, 'pricing')!.data).toMatchObject({ price: sec(base, 'pricing')!.data.price, heading: 'New pricing' });
    expect(hero(out)).toMatchObject({ headline: 'New', imageId: 'm2', imageAlt: 'Van', ctaSubtext: hero(base).ctaSubtext });
    expect(gallery(out)!.items).toEqual([{ imageId: 'm1', alt: 'Shop', caption: '' }]);
  });

  it('saves over the page as it is now: what the edit didn’t touch keeps the owner’s latest changes', () => {
    const next: SalesPage = { ...base, sections: base.sections.map((s): SalesSection => (s.type === 'hero' ? { ...s, data: { ...s.data, headline: 'From the AI' } } : s)) };
    const now: SalesPage = {
      ...base,
      theme: { ...base.theme, mode: 'dark' },
      sections: base.sections.map((s): SalesSection => (s.type === 'faq' ? { ...s, data: { ...s.data, heading: 'Typed meanwhile' } } : s.type === 'proof' ? { ...s, data: { ...s.data, stats: [{ value: '9', label: 'Years' }] } } : s)),
    };
    const out = applyEdit(now, base, next);
    expect(hero(out).headline).toBe('From the AI');
    expect(sec(out, 'faq')!.data.heading).toBe('Typed meanwhile');
    expect(sec(out, 'proof')!.data.stats).toEqual([{ value: '9', label: 'Years' }]);
    expect(out.theme.mode).toBe('dark');
    // a look the edit did change wins
    expect(applyEdit(now, base, { ...next, theme: { ...base.theme, radius: 'round' } }).theme).toEqual({ ...base.theme, radius: 'round' });
  });
});

describe('the HTML export with images', () => {
  const p = project();
  const images = [img(1), img(2), img(3)];
  const meta = generateSeoMeta(p);
  const page = placeImages(generateSalesPage(p), p, images, { hero: 'img-1', heroAlt: 'Our "best" shop', gallery: [{ key: 'img-2', alt: 'Kitchen', caption: 'After a clean' }, { key: 'img-3', alt: 'Van', caption: '' }] });
  const data = (id: string) => `data:image/jpeg;base64,${id.toUpperCase()}AAAA`;

  it('leaves images out when it has no address for them, and is the same page as before', () => {
    const html = exportSalesHtml(page, meta, p.brand, p);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('class="gallery"');
    expect(html).not.toContain('hero-grid');
    expect(html).not.toContain('og:image"');
    expect(html).toBe(exportSalesHtml(generateSalesPage(p), meta, p.brand, p));
  });

  it('puts the images in (Copy, Export): hero beside the copy, then the gallery, sized, with alt text', () => {
    const html = exportSalesHtml(page, meta, p.brand, p, { imageUrl: data, imageSize: () => ({ w: 1200, h: 800 }) });
    expect(html).toContain('<div class="wrap hero-grid">');
    expect(html).toContain(`<figure class="hero-img"><img src="${data('m1')}" alt="Our &quot;best&quot; shop" width="1200" height="800" fetchpriority="high" decoding="async"></figure>`);
    expect(html).toContain('<section class="gallery">');
    expect(html).toContain(`<figure><img src="${data('m2')}" alt="Kitchen" width="1200" height="800" loading="lazy" decoding="async"><figcaption>After a clean</figcaption></figure>`);
    expect(html).toContain(`<figure><img src="${data('m3')}" alt="Van" width="1200" height="800" loading="lazy" decoding="async"></figure>`);
    expect(html).toContain('.photos {');
    // a data URL isn't an address a link preview can use
    expect(html).not.toContain('og:image"');
    expect(html).not.toContain('twitter:image');
    expect(html).not.toContain('"image":');
    // the gallery comes right after the solution
    expect(html.indexOf('class="gallery"')).toBeGreaterThan(html.indexOf('class="solution"'));
  });

  it('gives link previews and the schema a full address for the hero image when there is one', () => {
    const html = exportSalesHtml(page, meta, p.brand, p, { imageUrl: (id) => `{{img-${id.slice(1)}}}`, origin: 'https://app.example/', canonical: 'https://app.example/clean-austin' });
    expect(html).toContain('<meta property="og:image" content="https://app.example{{img-1}}" />');
    expect(html).toContain('<meta name="twitter:image" content="https://app.example{{img-1}}" />');
    expect(html).toContain('"image": "https://app.example{{img-1}}"');
    expect(html).toContain('<link rel="canonical" href="https://app.example/clean-austin" />');
    expect(html).toContain('<meta property="og:url" content="https://app.example/clean-austin" />');
    expect(html).toContain('<img src="{{img-2}}"');
    // an absolute address works without an origin; a relative one doesn't
    expect(exportSalesHtml(page, meta, p.brand, p, { imageUrl: () => 'https://cdn.example/a.jpg' })).toContain('<meta property="og:image" content="https://cdn.example/a.jpg" />');
    expect(exportSalesHtml(page, meta, p.brand, p, { imageUrl: () => '/a.jpg' })).not.toContain('og:image"');
  });

  it('never turns the owner’s words into an image token', () => {
    const tricky: SalesPage = { ...page, sections: page.sections.map((s): SalesSection => (s.type === 'hero' ? { ...s, data: { ...s.data, headline: 'Use {{img-2}} here', imageAlt: 'alt {{img-3}}' } } : s.type === 'faq' ? { ...s, data: { ...s.data, items: [{ q: 'Q {{img-1}}?', a: 'A' }] } } : s)) };
    const html = exportSalesHtml(tricky, meta, p.brand, p, { imageUrl: (id) => `{{img-${id.slice(1)}}}`, origin: 'https://app.example' });
    expect(html).toContain('<h1>Use {&#123;img-2}} here</h1>');
    expect(html).toContain('alt="alt {&#123;img-3}}"');
    expect(html).toContain('"name": "Q {\\u007bimg-1}}?"');
    // the only tokens left are the image slots
    expect(html.match(/\{\{img-\d+\}\}/g)).toEqual(['{{img-1}}', '{{img-1}}', '{{img-1}}', '{{img-1}}', '{{img-2}}', '{{img-3}}']);
  });

  it('leaves out a gallery with no images it can show, and a hidden one', () => {
    expect(exportSalesHtml(page, meta, p.brand, p, { imageUrl: (id) => (id === 'm1' ? data(id) : undefined) })).not.toContain('class="gallery"');
    const hidden = { ...page, sections: page.sections.map((s) => (s.type === 'gallery' ? { ...s, visible: false } : s)) };
    expect(exportSalesHtml(hidden, meta, p.brand, p, { imageUrl: data })).not.toContain('class="gallery"');
  });

  it('knows a canonical the owner pasted from the one the app makes', () => {
    const q = project();
    const m = generateSeoMeta(q);
    expect(ownCanonical(q, m)).toBe(false); // no website: none
    q.brand.websiteUrl = 'https://site.example';
    expect(ownCanonical(q, { ...m, canonical: `https://site.example/${m.slug}` })).toBe(false);
    expect(ownCanonical(q, { ...m, canonical: 'https://site.example/landing' })).toBe(true);
  });
});

describe('the score counts what the page shows', () => {
  const p = project();
  const meta = generateSeoMeta(p);

  it('reads the gallery’s heading and captions, and asks for alt text only when there are images', () => {
    const plain = generateSalesPage(p);
    expect(scoreSeo(meta, plain).checks.map((c) => c.id)).not.toContain('img-alt');
    const page = placeImages(plain, p, [img(1), img(2)], { hero: 'img-1', heroAlt: 'Our shop front', gallery: [{ key: 'img-2', caption: 'Spotless kitchens in Austin' }], galleryHeading: 'Recent work' });
    const text = pageText(page);
    expect(text.h2s).toContain('Recent work');
    expect(text.all).toContain('Spotless kitchens in Austin');
    const check = scoreSeo(meta, page).checks.find((c) => c.id === 'img-alt')!;
    expect(check).toMatchObject({ pass: false, partial: true });
    expect(check.tip).toBe('1 of 2 described. In Edit, write what each image shows under it.');
    const described = placeImages(page, p, [img(1), img(2)], { gallery: [{ key: 'img-2', alt: 'A clean kitchen' }] });
    expect(scoreSeo(meta, described).checks.find((c) => c.id === 'img-alt')!.pass).toBe(true);
    // an empty gallery adds nothing
    const empty = placeImages(page, p, [img(1), img(2)], { gallery: [] });
    expect(pageText(empty).h2s).not.toContain('Recent work');
  });
});
