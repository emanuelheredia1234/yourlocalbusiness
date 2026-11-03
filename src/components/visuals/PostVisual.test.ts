import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Brand, MediaRef } from '@/lib/types';
import { PostVisual, photoShape } from './PostVisual';

const brand = {
  name: 'Golden Crust Neighborhood Bakery and Cafe',
  colors: { primary: '#c2410c', secondary: '#7c2d12', accent: '#f59e0b', ink: '#1c1917', paper: '#fffbeb' },
  logo: { icon: 'sparkles' },
  socials: {},
  websiteUrl: 'https://goldencrust.example',
} as unknown as Brand;

const photo = (o: Partial<MediaRef> = {}): MediaRef => ({ id: 'media_1', kind: 'image', name: 'bread.jpg', mime: 'image/jpeg', size: 1000, createdAt: 0, w: 3024, h: 4032, thumb: 'data:image/jpeg;base64,AAAA', ...o });

const render = (props: Partial<Parameters<typeof PostVisual>[0]>) => renderToStaticMarkup(createElement(PostVisual, { style: 'minimal', headline: 'Fresh sourdough every morning', brand, watermark: true, aspect: '4/5', ...props }));

describe('photoShape', () => {
  it('keeps a photo at its own shape', () => {
    expect(photoShape(3024, 4032)).toBeCloseTo(0.75);
    expect(photoShape(4032, 3024)).toBeCloseTo(4 / 3);
    expect(photoShape(1080, 1080)).toBe(1);
    expect(photoShape(1920, 1080)).toBeCloseTo(16 / 9);
    expect(photoShape(1080, 1920)).toBeCloseTo(9 / 16);
  });
  it('holds very tall or very wide photos to 9:16 and 1.91:1', () => {
    expect(photoShape(1170, 2532)).toBeCloseTo(9 / 16);
    expect(photoShape(8000, 2000)).toBeCloseTo(1.91);
  });
});

describe('PostVisual with your own photo', () => {
  it('shows the photo alone, filling the preview at its shape', () => {
    const html = render({ media: photo() });
    expect(html).toContain('aspect-ratio:0.75');
    expect(html).toContain('object-cover');
    expect(html.match(/<img/g)).toHaveLength(1);
    // the headline isn't on your photo, so the photo isn't described with it
    expect(html).toContain('aria-label="Your photo"');
  });
  it('draws no headline, brand name or watermark over it (none of them go on the photo)', () => {
    const html = render({ media: photo() });
    expect(html).not.toContain('>Fresh sourdough every morning<');
    expect(html).not.toContain('Golden Crust');
    expect(html).not.toContain('goldencrust.example');
  });
  it('looks the same whatever style is picked', () => {
    for (const style of ['minimal', 'editorial', 'neon', 'isometric', 'handcrafted'] as const) expect(render({ style, media: photo() })).toBe(render({ media: photo() }));
  });
  it('uses the frame shape until it knows the photo size', () => {
    expect(render({ media: photo({ w: undefined, h: undefined }) })).toContain('aspect-ratio:4/5');
  });
  it('keeps an AI image at its exact shape', () => {
    const ai = photo({ w: 1080, h: 1350, generated: { kind: 'photo', provider: 'x', prompt: 'p', purpose: 'post', aspect: '4:5', final: true, createdAt: 0 } });
    const html = render({ media: ai });
    expect(html).toContain('aspect-ratio:1080/1350');
    expect(html).toContain('aria-label="AI image: Fresh sourdough every morning"');
  });
  it('without a photo, still shows the style mockup with the headline and watermark', () => {
    const html = render({});
    expect(html).toContain('Fresh sourdough every morning');
    expect(html).toContain('goldencrust.example');
    expect(html).toContain('aspect-ratio:4/5');
  });
  it('a video plan with a photo keeps its storyboard', () => {
    expect(render({ style: 'ugc', media: photo(), aspect: '9/16' })).toContain('Play preview');
  });
});

describe('your own photo in lists', () => {
  it('is told apart from AI images and videos', async () => {
    const { isOwnPhoto } = await import('@/lib/media');
    expect(isOwnPhoto(photo())).toBe(true);
    expect(isOwnPhoto(photo({ generated: { kind: 'photo', provider: 'x', prompt: 'p', purpose: 'post', aspect: '4:5', final: true, createdAt: 0 } }))).toBe(false);
    expect(isOwnPhoto(photo({ kind: 'video' }))).toBe(false);
    expect(isOwnPhoto(undefined)).toBe(false);
  });
  it('shows "Your photo" instead of a visual style it never gets', async () => {
    const { styleLabel } = await import('@/components/posts/PostCard');
    const post = { format: 'image', style: 'minimal', media: photo() } as unknown as Parameters<typeof styleLabel>[0];
    expect(styleLabel(post)).toBe('Your photo');
    expect(styleLabel({ ...post, media: undefined })).not.toBe('Your photo');
    expect(styleLabel({ ...post, format: 'video', style: 'ugc' })).not.toBe('Your photo');
  });
});
