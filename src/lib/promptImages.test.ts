// Images in the prompt boxes: each gets a key ({{img-N}}) that's never reused, only real image types get in,
// tokens become addresses (and a token for an image that's gone never shows), and the AI is told what it sees.
import { describe, expect, it, vi } from 'vitest';
import type { MediaRef, PromptImage } from './types';

const toast = vi.fn();
vi.mock('@/store/ui', () => ({ toast: (t: unknown) => toast(t) }));

const { addPromptImages, describeImagesForAI, imageKeyNumber, imageTokens, nextImageKey, planPromptImages, promptImageRefusal, refusalNotice, resolveImageTokens, usedImages, MAX_PROMPT_IMAGES } = await import('./promptImages');

let n = 0;
const media = (patch: Partial<MediaRef> = {}): MediaRef => ({ id: `media_${++n}`, kind: 'image', name: `photo-${n}.jpg`, mime: 'image/jpeg', size: 1000, createdAt: 0, w: 1200, h: 800, ...patch });
const img = (key: string, patch: Partial<PromptImage> = {}): PromptImage => ({ key, media: media(), ...patch });

describe('image keys', () => {
  it('start at img-1 and go one past the highest in use', () => {
    expect(nextImageKey([])).toBe('img-1');
    expect(nextImageKey([img('img-1'), img('img-2')])).toBe('img-3');
    // a removed image's number isn't filled in
    expect(nextImageKey([img('img-1'), img('img-4')])).toBe('img-5');
  });

  it('skip keys still used elsewhere (e.g. left in the code)', () => {
    expect(nextImageKey([img('img-1')], ['img-1', 'img-3'])).toBe('img-4');
    expect(nextImageKey([], ['not-a-key'])).toBe('img-1');
  });

  it('never go past img-99 (the most a published image name can have)', () => {
    expect(nextImageKey([img('img-99')])).toBe('img-1');
    expect(nextImageKey([img('img-1'), img('img-99')])).toBe('img-2');
  });

  it('read the number of a key', () => {
    expect(imageKeyNumber('img-12')).toBe(12);
    expect(imageKeyNumber('image-1')).toBe(0);
  });
});

describe('adding images', () => {
  it('gives each new image the next key and keeps the ones already there', () => {
    const current = [img('img-1')];
    const a = media();
    const b = media({ mime: 'image/png' });
    const plan = planPromptImages(current, [a, b]);
    expect(plan.images.map((i) => i.key)).toEqual(['img-1', 'img-2', 'img-3']);
    expect(plan.added.map((i) => i.media.id)).toEqual([a.id, b.id]);
    expect(plan.refused).toEqual({});
  });

  it('only takes JPEG, PNG, WebP and GIF images', () => {
    const plan = planPromptImages([], [media({ mime: 'image/svg+xml' }), media({ kind: 'video', mime: 'video/mp4' }), media({ mime: 'image/heic' }), media({ mime: 'image/webp' }), media({ mime: 'image/gif' })]);
    expect(plan.images.map((i) => i.media.mime)).toEqual(['image/webp', 'image/gif']);
    expect(plan.refused).toEqual({ svg: 1, video: 1, type: 1 });
  });

  it('stops at the limit and skips an image that’s already there', () => {
    const current = Array.from({ length: MAX_PROMPT_IMAGES - 1 }, (_, i) => img(`img-${i + 1}`));
    const plan = planPromptImages(current, [current[0].media, media(), media(), media()]);
    expect(plan.images).toHaveLength(MAX_PROMPT_IMAGES);
    expect(plan.added).toHaveLength(1);
    expect(plan.refused).toEqual({ full: 2 });
    expect(planPromptImages([], [media(), media()], { max: 1 }).refused).toEqual({ full: 1 });
  });

  it('says once why files weren’t added', () => {
    toast.mockClear();
    const out = addPromptImages([], [media({ mime: 'image/svg+xml' }), media()]);
    expect(out).toHaveLength(1);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toMatchObject({ kind: 'error', title: 'That file wasn’t added' });
    expect(toast.mock.calls[0][0].body).toMatch(/SVG files can’t be used because they can carry code/);
    toast.mockClear();
    addPromptImages([], [media()]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('explains each reason in plain words', () => {
    expect(refusalNotice({})).toBeNull();
    const n = refusalNotice({ video: 1, full: 2 }, 8)!;
    expect(n.title).toBe('3 files weren’t added');
    expect(n.body).toBe('Videos can’t be used here, only images. A page can have up to 8 images.');
    expect(refusalNotice({ type: 1 })!.body).toBe('Use JPEG, PNG, WebP or GIF images.');
  });

  it('checks a file’s type before it’s saved', () => {
    expect(promptImageRefusal('image/png')).toBeNull();
    expect(promptImageRefusal('IMAGE/JPEG')).toBeNull();
    expect(promptImageRefusal('image/svg+xml')).toBe('svg');
    expect(promptImageRefusal('video/quicktime')).toBe('video');
    expect(promptImageRefusal('application/pdf')).toBe('type');
    expect(promptImageRefusal('')).toBe('type');
  });
});

describe('image tokens', () => {
  const html = '<img src="{{img-2}}" alt=""><div style="background:url({{ img-1 }})"></div><img src="{{img-2}}">{{IMG-03}}';

  it('lists the keys a text uses, once each, in order', () => {
    expect(imageTokens(html)).toEqual(['img-2', 'img-1', 'img-3']);
    expect(imageTokens('')).toEqual([]);
    expect(imageTokens(undefined)).toEqual([]);
    expect(imageTokens('{{img-}} {img-1} {{ image-1 }}')).toEqual([]);
  });

  it('become addresses; one for an image that’s gone becomes nothing', () => {
    const out = resolveImageTokens(html, { 'img-1': '/menu/img/img-1.jpg', 'img-2': 'data:image/png;base64,AAA$&' });
    expect(out).toBe('<img src="data:image/png;base64,AAA$&" alt=""><div style="background:url(/menu/img/img-1.jpg)"></div><img src="data:image/png;base64,AAA$&">');
    expect(out).not.toContain('{{');
  });

  it('pick the images a page uses', () => {
    const images = [img('img-1'), img('img-2'), img('img-3')];
    expect(usedImages(images, '<img src="{{img-3}}">', 'a{background:url({{img-1}})}').map((i) => i.key)).toEqual(['img-1', 'img-3']);
  });
});

describe('telling the AI about the images', () => {
  it('lists each token with its attachment number, note and size', () => {
    const images = [
      img('img-1', { note: 'Our shop front, use it at the top' }),
      img('img-3', { media: media({ mime: 'image/png', w: 400, h: 400 }) }),
      img('img-4', { note: '  the "team"\nphoto ' }),
    ];
    expect(describeImagesForAI(images).split('\n')).toEqual([
      '{{img-1}} (attached image 1): "Our shop front, use it at the top" — 1200×800 photo',
      '{{img-3}} (attached image 2) — 400×400 PNG image',
      '{{img-4}} (attached image 3): "the \\"team\\" photo" — 1200×800 photo',
    ]);
  });

  it('says which images aren’t attached, so the notes guide the AI', () => {
    const images = [img('img-1'), img('img-2', { note: 'logo' }), img('img-3', { media: media({ w: undefined, h: undefined }) })];
    expect(describeImagesForAI(images, 1).split('\n')).toEqual([
      '{{img-1}} (attached image 1) — 1200×800 photo',
      '{{img-2}} (not attached: go by its note): "logo" — 1200×800 photo',
      '{{img-3}} (not attached: go by its note) — photo',
    ]);
    expect(describeImagesForAI([])).toBe('');
  });
});
