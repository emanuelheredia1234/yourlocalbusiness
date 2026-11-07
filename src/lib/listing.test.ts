// Images published with a listing: each one sized to what the shared Marketplace keeps, and the
// gallery you pick is the gallery buyers see.
import { describe, expect, it } from 'vitest';
import { newProject } from '@/store/defaults';
import type { MediaRef, ServicePriceModel } from '@/lib/types';
import { compact, SHARED_GALLERY_MAX, SHARED_IMAGE_CHARS } from '@/lib/community';
import { useOffers } from '@/store/offers';
import { priceLabel } from './listing';
import { priceLabel as serverPriceLabel } from '../../server/market/render.mjs';
import { buildListing, cleanGallery, COVER_STEPS, fitDataUrl, GALLERY_STEPS, galleryIds, LISTING_IMAGE_CHARS, MAX_GALLERY } from './listing';

/** A stand-in JPEG encoder: larger and better-quality images take more characters, like real ones. */
function fakeEncoder(weight = 0.3) {
  const tried: [number, number][] = [];
  const encode = (max: number, quality: number) => {
    tried.push([max, quality]);
    return `data:image/jpeg;base64,${'A'.repeat(Math.round(max * max * quality * weight))}`;
  };
  return { encode, tried };
}

describe('publishing listing images', () => {
  it('steps down size, then quality, until the image fits what is shared', async () => {
    const { encode, tried } = fakeEncoder();
    const url = await fitDataUrl(encode, COVER_STEPS);
    expect(url).toBeDefined();
    expect(url!.length).toBeLessThanOrEqual(LISTING_IMAGE_CHARS);
    // starts as sharp as before, and stops at the first size that fits
    const steps = [...tried];
    expect(steps[0]).toEqual([720, 0.72]);
    expect(steps.length).toBeGreaterThan(1);
    expect(url).toBe(encode(...steps[steps.length - 1]));
    expect(encode(...steps[steps.length - 2]).length).toBeGreaterThan(LISTING_IMAGE_CHARS);
  });

  it('keeps the first size when it already fits, and gives up when nothing does', async () => {
    const small = fakeEncoder(0.01);
    expect(await fitDataUrl(small.encode, GALLERY_STEPS)).toBe(small.encode(...GALLERY_STEPS[0]));
    expect(small.tried[0]).toEqual([...GALLERY_STEPS[0]]);
    expect(await fitDataUrl(() => 'x'.repeat(LISTING_IMAGE_CHARS + 1), COVER_STEPS)).toBeUndefined();
  });

  it('only ever steps down', () => {
    for (const steps of [COVER_STEPS, GALLERY_STEPS]) {
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i][0]).toBeLessThan(steps[i - 1][0]);
        expect(steps[i][1]).toBeLessThanOrEqual(steps[i - 1][1]);
      }
    }
  });

  it('makes images the shared Marketplace keeps, and shares the whole gallery you picked', () => {
    expect(LISTING_IMAGE_CHARS).toBeLessThan(SHARED_IMAGE_CHARS);
    expect(MAX_GALLERY).toBe(SHARED_GALLERY_MAX);
    const img = `data:image/jpeg;base64,${'A'.repeat(LISTING_IMAGE_CHARS - 23)}`;
    expect(img.length).toBe(LISTING_IMAGE_CHARS);
    const p = newProject('business', 'new');
    p.brand = { ...p.brand, name: 'Sparkle Co' };
    const shared = compact(buildListing(p, undefined, img, [img, img, img]));
    expect(shared.cover.imageDataUrl).toBe(img);
    expect(shared.gallery).toEqual([img, img, img]);
    // anything bigger is still left out of what is shared
    const big = img.padEnd(SHARED_IMAGE_CHARS + 1, 'A');
    expect(compact(buildListing(p, undefined, big)).cover.imageDataUrl).toBeUndefined();
  });

  it('shows only gallery images that still exist and aren’t the cover, up to what is shared', () => {
    const img = (id: string, kind: MediaRef['kind'] = 'image'): MediaRef => ({ id, kind, name: id, mime: 'image/jpeg', size: 1, createdAt: 0 });
    const images = [img('a'), img('b'), img('c'), img('d'), img('e'), img('v', 'video')];
    expect(cleanGallery(['a', 'gone', 'cover', 'v', 'b', 'c', 'd'], [...images, img('cover')], 'cover')).toEqual(['a', 'b', 'c']);
    expect(cleanGallery(undefined, images)).toEqual([]);
    const p = newProject('business', 'new');
    p.brand.images = images;
    // older versions let you pick 4
    p.studio.listing.galleryIds = ['a', 'b', 'c', 'd'];
    p.studio.listing.coverImageId = 'a';
    expect(galleryIds(p)).toEqual(['b', 'c', 'd']);
  });
});

describe('a listing sold through an offer', () => {
  const OFFER = 'abcdefghijklmnopqrstuv';
  const offer = (provider: 'whop' | 'external' | 'stripe', status = 'active', environment: 'sandbox' | 'production' | null = 'production') =>
    ({ id: OFFER, provider, status, environment, checkoutHost: provider === 'stripe' ? 'checkout.stripe.com' : 'whop.com', link: `https://yourlocalbusiness.replit.app/b/${OFFER}` }) as never;
  const product = () => {
    const p = newProject('product', 'new');
    p.studio.listing.offerId = OFFER;
    return p;
  };

  it('keeps a Stripe offer (P6) with its /b/ link, like Whop and outside links', () => {
    const p = product();
    for (const provider of ['stripe', 'whop', 'external'] as const) {
      useOffers.setState((s) => ({ ...s, byProject: { [p.id]: [offer(provider)] } }));
      const l = buildListing(p);
      expect(l.buyUrl).toBe(`https://yourlocalbusiness.replit.app/b/${OFFER}`);
      expect(l.offer).toMatchObject({ id: OFFER, provider });
    }
    useOffers.setState((s) => ({ ...s, byProject: { [p.id]: [offer('stripe', 'active', 'sandbox')] } }));
    expect(buildListing(p).offer).toEqual({ id: OFFER, provider: 'stripe', checkoutHost: 'checkout.stripe.com', test: true });
  });

  it('drops an archived offer, and keeps the public web address across updates', () => {
    const p = product();
    useOffers.setState((s) => ({ ...s, byProject: { [p.id]: [offer('stripe', 'archived')] } }));
    expect(buildListing(p).offer).toBeUndefined();
    const prev = { ...buildListing(p), web: { slug: 'cut-abc123', url: 'https://yourlocalbusiness.replit.app/market/cut-abc123' } };
    expect(buildListing(p, prev).web).toEqual(prev.web);
  });
});

describe('price labels on the public page (server/market/render.mjs) match the app’s', () => {
  const cases: [number, ServicePriceModel][] = [
    [49, 'one-time'],
    [19.5, 'monthly'],
    [199, 'yearly'],
    [85, 'per-session'],
    [300, 'project'],
    [0, 'free'],
    [0, 'one-time'],
    [120, 'quote'],
    [1234.56, 'one-time'],
  ];
  it.each(cases)('%s %s', (price, model) => {
    expect(serverPriceLabel(Math.round(price * 100), model)).toBe(priceLabel(price, model));
  });
});
