// What a prompt box's images look like (rendered once, as on the server: no effects run).
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MediaRef, PromptImage } from '@/lib/types';
import { PromptImages } from './PromptImages';

const media = (id: string): MediaRef => ({ id, kind: 'image', name: `${id}.jpg`, mime: 'image/jpeg', size: 1, createdAt: 0, thumb: 'data:image/jpeg;base64,AAAA' });
const img = (key: string, note?: string): PromptImage => ({ key, media: media(`media_${key}`), ...(note ? { note } : {}) });
const render = (images: PromptImage[], extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(PromptImages, { images, onChange: () => {}, ...extra }));

describe('prompt box images', () => {
  it('start with "Add images" for JPEG, PNG, WebP or GIF files', () => {
    const html = render([]);
    expect(html).toContain('Add images');
    expect(html).toContain('accept="image/jpeg,image/png,image/webp,image/gif"');
    expect(html).toContain('multiple');
  });

  it('show each image by its number, with its note and a labelled Remove', () => {
    const html = render([img('img-1', 'Shop front'), img('img-3')]);
    expect(html).toContain('Image 1');
    expect(html).toContain('Image 3');
    expect(html).toContain('value="Shop front"');
    expect(html).toContain('aria-label="Remove image 3"');
    expect(html).toContain('Add more images');
    expect(html).toMatch(/<label for="[^"]+">Image 1<\/label>|<label[^>]*for="[^"]+"[^>]*>Image 1<\/label>/);
  });

  it('say when the page has as many as it can take', () => {
    const html = render(Array.from({ length: 8 }, (_, i) => img(`img-${i + 1}`)));
    expect(html).toContain('That’s 8 images, the most for one page.');
    expect(html).not.toContain('Add more images');
    expect(render([img('img-1')], { max: 1 })).toContain('That’s 1 image, the most for one page.');
  });

  it('can’t be changed while the AI is working', () => {
    const html = render([img('img-1')], { disabled: true, busy: true });
    expect(html).not.toContain('Add more images');
    expect(html).toMatch(/aria-label="Remove image 1"[^>]*disabled|disabled[^>]*aria-label="Remove image 1"/);
    expect(html).toContain('Adding your image…');
  });
});
