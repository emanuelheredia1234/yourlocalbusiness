// The Code tab's logic: Undo keeps the asset's images, a new image never takes a key that's still in use,
// the owner is told about images the code doesn't show or no longer has, downloads embed the images, and
// what's published is the full page with each image token turned into its published address.
import { describe, expect, it, vi } from 'vitest';
import type { CodeAsset, MediaRef, Project, PromptImage } from '@/lib/types';

const madeUrls = vi.fn();
vi.mock('@/lib/promptImages', async (original) => {
  const real = await original<typeof import('@/lib/promptImages')>();
  return {
    ...real,
    // the real ones redraw images with a canvas (a browser's)
    imageDataUrls: async (images: PromptImage[] = []) => {
      madeUrls(images.map((i) => i.key));
      return Object.fromEntries(images.filter((i) => i.media.id !== 'm-gone').map((i) => [i.key, `data:image/jpeg;base64,${i.key.toUpperCase()}`]));
    },
    imagesForPublish: async (images: PromptImage[], keys: string[]) =>
      images.filter((i) => keys.includes(i.key)).map((i) => ({ name: `${i.key}.${i.media.mime === 'image/png' ? 'png' : 'jpg'}`, mime: i.media.mime, data: 'QUJD', hash: 'h' })),
  };
});

const { newProject } = await import('@/store/defaults');
const { detectKind, STORAGE_SHIM } = await import('@/ai/local/code');
const { buildHash, preparePublish } = await import('@/lib/publish');
const { uid } = await import('@/lib/utils');
const m = await import('./codeAssets');

const media = (id: string, patch: Partial<MediaRef> = {}): MediaRef => ({ id, kind: 'image', name: `${id}.jpg`, mime: 'image/jpeg', size: 1, createdAt: 0, ...patch });
const img = (key: string, id = `m-${key}`, patch: Partial<MediaRef> = {}): PromptImage => ({ key, media: media(id, patch) });
const asset = (patch: Partial<CodeAsset> = {}): CodeAsset => ({
  id: 'code_abc123',
  name: 'Bakery hero',
  kind: 'hero',
  prompt: '',
  html: '<section><img src="{{img-1}}" alt="Shop"></section>',
  css: '.hero { background: url({{img-2}}) center / cover; }',
  js: 'var ok = true;',
  images: [img('img-1'), img('img-2', 'm-img-2', { mime: 'image/png' })],
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

describe('undo', () => {
  it('keeps the last 15 versions, and doesn’t keep the same code twice in a row', () => {
    let stack: ReturnType<typeof m.snapshotOf>[] = [];
    for (let i = 0; i < 20; i++) stack = m.pushSnapshot(stack, m.snapshotOf({ html: `<p>${i}</p>`, css: '', js: '' }));
    expect(stack).toHaveLength(m.UNDO_LIMIT);
    expect(stack[0].html).toBe('<p>5</p>');
    expect(m.pushSnapshot(stack, m.snapshotOf({ html: '<p>19</p>', css: '', js: '' }))).toBe(stack);
  });

  it('keeps the images with the code', () => {
    const snap = m.snapshotOf(asset());
    expect(snap.images.map((i) => i.key)).toEqual(['img-1', 'img-2']);
    expect('script' in snap).toBe(false);
    expect(m.snapshotOf(asset({ script: 'function onOpen() {}' }), true).script).toBe('function onOpen() {}');
  });

  it('brings back an image the restored code shows, and never takes away one added since', () => {
    const before = m.snapshotOf(asset());
    // since then: image 2 was removed from the list, image 3 added
    const now = [img('img-1'), img('img-3')];
    expect(m.imagesAfterUndo(now, before).map((i) => i.key)).toEqual(['img-1', 'img-2', 'img-3']);
    // nothing to bring back: the same list
    expect(m.imagesAfterUndo(now, m.snapshotOf({ html: '<img src="{{img-1}}">', css: '', js: '', images: [img('img-1'), img('img-2')] }))).toBe(now);
  });

  it('puts a sheet’s Apps Script back only when the change replaced it', () => {
    const edited = m.undoPatch([], m.snapshotOf(asset({ script: 'old' })));
    expect('script' in edited).toBe(false);
    expect(m.undoPatch([], m.snapshotOf(asset({ script: 'old' }), true)).script).toBe('old');
    expect(m.undoPatch([], m.snapshotOf(asset(), true)).script).toBeUndefined();
  });
});

describe('image keys and notes', () => {
  it('never gives a new image a key the code or Undo still uses', () => {
    const a = asset({ images: [img('img-1')] });
    expect(m.reservedImageKeys(a).sort()).toEqual(['img-1', 'img-2']);
    const history = [m.snapshotOf({ html: '<img src="{{img-5}}">', css: '', js: '', images: [img('img-6')] })];
    expect(m.reservedImageKeys(a, history).sort()).toEqual(['img-1', 'img-2', 'img-5', 'img-6']);
  });

  it('finds images the code doesn’t show, and ones it uses that are gone', () => {
    const a = asset({ images: [img('img-1'), img('img-3'), img('img-4')] });
    expect(m.unusedImages(a).map((i) => i.key)).toEqual(['img-3', 'img-4']);
    expect(m.missingImages(a)).toEqual(['img-2']);
    expect(m.imageUseNotes(a)).toEqual(['Images 3 and 4 aren’t in it yet. Say where in Edit with AI, e.g. “put image 3 at the top”.']);
    expect(m.imageUseNotes(asset({ images: [img('img-1'), img('img-2'), img('img-7')] }))).toEqual(['Image 7 isn’t in it yet. Say where in Edit with AI, e.g. “put image 7 at the top”.']);
    expect(m.imageUseNotes(asset())).toEqual([]);
    expect(m.missingImagesNote(['img-2'])).toBe('Image 2 was removed, but the code still uses it, so nothing shows there.');
    expect(m.missingImagesNote(['img-2', 'img-5'])).toBe('Images 2 and 5 were removed, but the code still uses them, so nothing shows there.');
  });
});

describe('copy and download', () => {
  it('embed the images as data URLs', async () => {
    madeUrls.mockClear();
    const d = await m.downloadDocument(asset());
    expect(madeUrls).toHaveBeenCalledWith(['img-1', 'img-2']);
    expect(d.missing).toEqual([]);
    expect(d.html).toContain('<img src="data:image/jpeg;base64,IMG-1" alt="Shop">');
    expect(d.html).toContain('url(data:image/jpeg;base64,IMG-2)');
    expect(d.html).not.toContain('{{img-');
    // the owner's own site has storage: the stand-in isn't needed there
    expect(d.html).not.toContain(STORAGE_SHIM);
  });

  it('use the images already made for the preview, at once', async () => {
    const ready = { 'img-1': 'data:image/jpeg;base64,P1', 'img-2': 'data:image/jpeg;base64,P2' };
    const now = m.readyDocument(asset(), ready);
    expect(now?.html).toContain('data:image/jpeg;base64,P1');
    expect(m.readyDocument(asset(), { 'img-1': 'x' })).toBeNull();
    expect(m.readyDocument(asset(), null)).toBeNull();
    // nothing to wait for without images
    expect(m.readyDocument(asset({ html: '<p>Hi</p>', css: '', images: [] }), null)?.html).toContain('<p>Hi</p>');
    madeUrls.mockClear();
    await m.downloadDocument(asset(), ready);
    expect(madeUrls).not.toHaveBeenCalled();
  });

  it('say which image couldn’t be loaded', async () => {
    const d = await m.downloadDocument(asset({ images: [img('img-1'), img('img-2', 'm-gone')] }));
    expect(d.missing).toEqual(['img-2']);
    expect(d.html).toContain('url()');
    expect(m.leftOutNote(['img-2'])).toEqual({ title: 'Image 2 was left out', body: 'It couldn’t be loaded on this device. If you added it on another device, it may still be uploading: try again in a minute.' });
    expect(m.leftOutNote(['img-1', 'img-2']).title).toBe('Images 1 and 2 were left out');
  });
});

describe('publishing', () => {
  it('has a page id the server takes', () => {
    expect(m.artifactPageId('code_abc123')).toBe('artifact:code_abc123');
    for (let i = 0; i < 20; i++) expect(m.artifactPageId(uid('code'))).toMatch(/^(seo|artifact):[A-Za-z0-9_-]{1,80}$/);
  });

  it('builds the full page with image tokens and the storage stand-in before the asset’s own script', () => {
    const b = m.publishBuild(asset());
    expect(b.images.map((i) => i.key)).toEqual(['img-1', 'img-2']);
    expect(b.html).toMatch(/^<!doctype html>/);
    expect(b.html).toContain('<title>Bakery hero</title>');
    expect(b.html).toContain('<img src="{{img-1}}" alt="Shop">');
    const shim = b.html.indexOf(STORAGE_SHIM);
    expect(shim).toBeGreaterThan(0);
    expect(shim).toBeLessThan(b.html.indexOf('var ok = true;'));
    expect(shim).toBeLessThan(b.html.indexOf('<section>'));
  });

  it('goes online with each image at its published address', async () => {
    const ready = await preparePublish(m.publishBuild(asset()), 'bakery-hero');
    expect(ready.images.map((i) => i.name)).toEqual(['img-1.jpg', 'img-2.png']);
    expect(ready.html).toContain('<img src="/bakery-hero/img/img-1.jpg" alt="Shop">');
    expect(ready.html).toContain('url(/bakery-hero/img/img-2.png)');
    expect(ready.html).not.toContain('{{img-');
    expect(ready.html).toContain(STORAGE_SHIM);
    expect(ready.hash).toBe(buildHash(m.publishBuild(asset()).html, asset().images));
  });

  it('knows when the asset changed since it was published here', async () => {
    const a = asset();
    expect(m.hasUnpublishedChanges(a)).toBe(false);
    const { hash } = await preparePublish(m.publishBuild(a), 'bakery-hero');
    const published = { slug: 'bakery-hero', url: 'https://app.example/bakery-hero', publishedAt: 1, hash };
    expect(m.hasUnpublishedChanges({ ...a, published })).toBe(false);
    expect(m.hasUnpublishedChanges({ ...a, published, name: 'Bakery hero!' })).toBe(true);
    expect(m.hasUnpublishedChanges({ ...a, published, images: [img('img-1', 'm-other'), a.images![1]] })).toBe(true);
    // a note on an image changes nothing on the page
    expect(m.hasUnpublishedChanges({ ...a, published, images: [{ ...a.images![0], note: 'Shop' }, a.images![1]] })).toBe(false);
    // published on another device: unknown, so not flagged
    expect(m.hasUnpublishedChanges({ ...a, published: { ...published, hash: '' }, name: 'Other' })).toBe(false);
  });
});

describe('the creation box', () => {
  const projectOf = (track: 'business' | 'product'): Project => {
    const p = newProject(track, 'new');
    p.niche = 'Home Cleaning';
    p.category = 'House cleaning';
    p.brand.name = 'Tidy Nest';
    return p;
  };

  it('suggests ideas that each pick the kind they name', () => {
    const biz = projectOf('business');
    expect(m.promptIdeas(biz).map((i) => detectKind(i, biz))).toEqual(['booking', 'calculator', 'faq']);
    const prod = projectOf('product');
    expect(m.promptIdeas(prod).map((i) => detectKind(i, prod))).toEqual(['calculator', 'quiz', 'countdown']);
    expect(m.defaultKind(biz)).toBe('booking');
    expect(m.defaultKind(prod)).toBe('calculator');
  });
});
