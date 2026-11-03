// The listing images panel: an upload on every image, your photos kept out of "Generate full set",
// and your details typeset on your own photo for the two graphics.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { newProject } from '@/store/defaults';
import type { MediaRef, Project } from '@/lib/types';
import { generateBusinessModel, generateListing } from '@/ai/local/studio';
import { OWN_PHOTO_PROVIDER } from '@/ai/listingPhotos';
import { ListingImages } from './ListingImages';

function project(): Project {
  const p = newProject('business', 'new');
  p.businessType = 'Pool cleaning';
  p.niche = 'Pool cleaning';
  p.location = { city: 'Phoenix', region: 'AZ' };
  p.brand = { ...p.brand, name: 'Sparkle Pools' };
  p.studio.packages = generateBusinessModel(p).packages;
  p.studio.listing = generateListing(p);
  return p;
}

const photo = (id: string, generated?: MediaRef['generated']): MediaRef => ({ id, kind: 'image', name: `${id}.jpg`, mime: 'image/jpeg', size: 1, createdAt: 1, thumb: 'data:image/jpeg;base64,AAAA', ...(generated ? { generated } : {}) });
const withDetails = (id: string, shot: string, photoId: string) => photo(id, { kind: 'design', provider: OWN_PHOTO_PROVIDER, prompt: '', purpose: 'listing', shot, aspect: '1:1', final: true, createdAt: 2, artId: photoId });
const render = (p: Project) => renderToStaticMarkup(createElement(ListingImages, { project: p }));
const count = (html: string, s: string) => html.split(s).length - 1;

describe('listing images panel', () => {
  it('offers an upload for every image, in formats every browser opens', () => {
    const html = render(project());
    for (const label of ['Cover', 'At work', 'What you get', 'Offer card']) expect(html).toContain(`aria-label="Upload my photo for ${label}"`);
    expect(count(html, 'accept="image/jpeg,image/png,image/webp"')).toBe(4);
    expect(html).toContain('JPG, PNG or WebP');
    expect(html).toContain('Generate full set');
    expect(html).not.toContain('Your photo');
  });

  it('shows your photos on their cards and leaves them out of “Generate full set”', () => {
    const p = project();
    p.brand.images = [photo('mine'), withDetails('det', 'inside', 'mine2'), photo('mine2')];
    p.studio.listing.shotImageIds = { hero: 'mine' };
    p.studio.listing.coverImageId = 'mine';
    const html = render(p);
    expect(count(html, '>Your photo<')).toBe(2);
    expect(count(html, ' Generate instead</button>')).toBe(2);
    expect(html).toContain('Update my details');
    expect(html).toContain('Generate 2 images');
    expect(html).not.toContain('Generate full set');
    expect(html).toContain('Your photos stay on Cover and What you get. To replace one, use “Generate instead” on its card.');
  });

  it('offers “Add my details” for your photo on the checklist and offer graphics only', () => {
    const p = project();
    p.brand.images = [photo('a'), photo('b')];
    p.studio.listing.shotImageIds = { lifestyle: 'a', offer: 'b' };
    const html = render(p);
    // the At work photo is used as it is; the offer card can get your details
    expect(count(html, 'Add my details')).toBe(1);
    expect(html.indexOf('Add my details')).toBeGreaterThan(html.indexOf('Upload my photo for Offer card'));
    expect(html).toContain('Your photos stay on At work and Offer card.');
  });
});
