// Other sellers' listings from the shared store: only well-formed fields, no outside images, no made-up numbers.
import { describe, expect, it } from 'vitest';
import { fromShared } from './community';

const base = { title: 'Budget Planner', kind: 'product', price: 29, seller: { name: 'Maya', verified: true }, cover: { colors: ['#000', '#111', '#222'], icon: 'star', pattern: 'dots' }, tags: ['budget', 3], rating: 4.9, reviews: 212, sales: 1840 };

describe('a listing from another seller', () => {
  it('keeps what the seller published, under their account, without made-up numbers', () => {
    const l = fromShared(base, 'user-2', 'lst_9')!;
    expect(l).toMatchObject({ id: 'lst_9', title: 'Budget Planner', origin: 'community', seller: { name: 'Maya', ownerId: 'user-2' }, tags: ['budget'] });
    expect(l).not.toHaveProperty('rating');
    expect(l).not.toHaveProperty('sales');
    expect(l.seller).not.toHaveProperty('verified');
  });

  it('never loads images from outside addresses', () => {
    const l = fromShared({ ...base, cover: { ...base.cover, imageDataUrl: 'https://tracker.example/pixel.png' }, gallery: ['data:image/png;base64,AAAA', 'javascript:alert(1)'], seller: { name: 'M', logo: { dataUrl: 'http://x/y.png' } } }, 'u', 'l')!;
    expect(l.cover.imageDataUrl).toBeUndefined();
    expect(l.gallery).toEqual(['data:image/png;base64,AAAA']);
    expect(l.seller.logo?.dataUrl).toBeUndefined();
  });

  it('skips anything malformed', () => {
    expect(fromShared(null, 'u', 'l')).toBeNull();
    expect(fromShared({ ...base, title: '' }, 'u', 'l')).toBeNull();
    expect(fromShared({ ...base, seller: null }, 'u', 'l')).toBeNull();
    expect(fromShared({ ...base, cover: 'x' }, 'u', 'l')).toBeNull();
  });
});
