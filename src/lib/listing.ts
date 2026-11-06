// A project's Marketplace listing, built from the shared Project Context: its price, the listing itself,
// and the images that travel with it. Used by Studio → Listing & publish, the Marketplace and the assistant.

import type { Listing, MediaRef, Project, ServicePriceModel } from '@/lib/types';
import { fmtMoney, hashStr, readFileAsDataURL, uid } from '@/lib/utils';
import { getBlob } from '@/lib/storage';
import { loadImage } from '@/lib/imageCanvas';
import { SHARED_GALLERY_MAX, SHARED_IMAGE_CHARS } from '@/lib/community';
import { matchBusinessType } from '@/ai/knowledge';
import { findOffer } from '@/store/offers';

const PATTERNS: Listing['cover']['pattern'][] = ['blobs', 'waves', 'dots', 'grid', 'rays'];

/** A listing's price as buyers read it: "$49/mo", "From $300", "Get a quote" (a business with no price set). */
export function priceLabel(price: number, model: ServicePriceModel): string {
  if (model === 'quote') return 'Get a quote';
  if (model === 'free' || price === 0) return 'Free';
  const p = fmtMoney(price);
  switch (model) {
    case 'monthly':
      return `${p}/mo`;
    case 'yearly':
      return `${p}/yr`;
    case 'per-session':
      return `${p}/session`;
    case 'project':
      return `From ${p}`;
    default:
      return p;
  }
}

/** The price a business listing leads with: the package the owner marked popular, else the first package (or the studio price). */
export function leadPrice(p: Project): { price: number; model: ServicePriceModel } {
  if (p.track === 'business') {
    const pk = p.studio.packages.find((x) => x.popular) ?? p.studio.packages[0];
    if (pk) return { price: pk.price, model: pk.priceModel };
    // no price set yet: buyers are asked to get a quote (never "Free")
    return p.studio.price > 0 ? { price: p.studio.price, model: 'per-session' } : { price: 0, model: 'quote' };
  }
  return { price: p.studio.price, model: p.studio.priceModel };
}

/** The business type's typical hours and an example guarantee: offered to the owner to accept with one click,
 *  never put in the listing for them. Empty for products. */
export function listingSuggestions(p: Project): { hours: string; guarantee: string } {
  if (p.track !== 'business') return { hours: '', guarantee: '' };
  const bt = matchBusinessType(`${p.businessType} ${p.category} ${p.niche}`);
  return { hours: bt.hours, guarantee: bt.guarantee };
}

/** Build the marketplace listing for a project from the shared Project Context (brand, studio, listing draft). */
export function buildListing(p: Project, prev?: Listing, coverDataUrl?: string, gallery?: string[]): Listing {
  const isBiz = p.track === 'business';
  const d = p.studio.listing;
  const c = p.brand.colors;
  const { price, model } = leadPrice(p);
  const bt = isBiz ? matchBusinessType(`${p.businessType} ${p.category} ${p.niche}`) : null;
  const includes = isBiz
    ? (p.studio.packages.find((x) => x.popular) ?? p.studio.packages[0])?.includes ?? bt?.delivery.slice(0, 4) ?? []
    : p.studio.outline.length
      ? p.studio.outline.slice(0, 8).map((s) => s.title)
      : p.idea?.features ?? [];
  // an attached offer (as last loaded from the server) is the listing's buy link: its permanent /b/<id> address
  const offer = d.offerId ? findOffer(p.id, d.offerId) : undefined;
  const sells = offer && offer.link && offer.status !== 'archived' && (offer.provider === 'whop' || offer.provider === 'external') ? offer : undefined;
  const logoUpload = p.brand.logo.mode === 'upload' && p.brand.logo.uploadDataUrl && p.brand.logo.uploadDataUrl.length < 30_000 ? p.brand.logo.uploadDataUrl : undefined;
  return {
    id: prev?.id ?? p.studio.publishedListingId ?? uid('lst'),
    kind: isBiz ? 'business' : 'product',
    title: d.title.trim() || p.idea?.title || p.brand.name,
    tagline: d.tagline.trim() || p.brand.tagline,
    description: d.description.trim() || p.brand.pitch,
    price,
    priceModel: model,
    compareAt: !isBiz && p.studio.compareAt > price ? p.studio.compareAt : undefined,
    seller: { name: p.brand.name, logo: { icon: p.brand.logo.icon, color: c.primary, shape: p.brand.logo.shape, dataUrl: logoUpload } },
    format: isBiz ? undefined : p.format ?? undefined,
    niche: p.niche,
    category: d.category || (isBiz ? bt?.category ?? 'Professional Services' : p.category || 'Digital Products'),
    tags: d.tags,
    location: isBiz ? (p.location ? { city: p.location.city, region: p.location.region, lat: p.location.lat, lng: p.location.lng } : { city: 'Online', region: '', online: true }) : undefined,
    website: p.brand.websiteUrl || undefined,
    buyUrl: sells ? sells.link : d.buyUrl?.trim() || undefined,
    ...(sells ? { offer: { id: sells.id, provider: sells.provider as 'whop' | 'external', checkoutHost: sells.checkoutHost, ...(sells.environment === 'sandbox' ? { test: true } : {}) } } : {}),
    contactEmail: d.contactEmail?.trim() || undefined,
    phone: d.phone?.trim() || undefined,
    bookingType: isBiz ? d.bookingType : 'buy',
    hours: isBiz ? d.hours || undefined : undefined,
    services: isBiz && p.studio.packages.length ? p.studio.packages.map((x) => ({ name: x.name, price: x.price, duration: x.priceModel === 'per-session' ? 'per session' : x.priceModel === 'monthly' ? 'monthly' : undefined, ...(x.priceModel === 'quote' || x.priceModel === 'free' ? { priceModel: x.priceModel } : {}) })) : undefined,
    includes: includes.slice(0, 8),
    cover: {
      colors: [c.primary, c.secondary, c.accent],
      icon: p.brand.logo.icon,
      pattern: PATTERNS[hashStr(p.id) % PATTERNS.length],
      imageDataUrl: coverDataUrl ?? (d.coverImageId ? prev?.cover.imageDataUrl : undefined),
    },
    gallery: gallery ?? (d.galleryIds?.length ? prev?.gallery : undefined),
    createdAt: prev?.createdAt ?? Date.now(),
    origin: 'mine',
    projectId: p.id,
  };
}

// ───────────── images that travel with the listing ─────────────

/** Each published image aims under this many data-URL characters, a little under what the shared Marketplace keeps. */
export const LISTING_IMAGE_CHARS = SHARED_IMAGE_CHARS - 2_000;

/** [longest side, JPEG quality] tried in turn until an image fits: as sharp as the shared Marketplace allows. */
export const COVER_STEPS: readonly (readonly [number, number])[] = [
  [720, 0.72],
  [640, 0.68],
  [560, 0.64],
  [480, 0.6],
  [400, 0.56],
  [320, 0.5],
];
export const GALLERY_STEPS = COVER_STEPS.slice(1);

/** The first encoding that fits under `limit`, trying the steps in order; undefined when none does. */
export async function fitDataUrl(encode: (max: number, quality: number) => string | Promise<string>, steps: readonly (readonly [number, number])[], limit = LISTING_IMAGE_CHARS): Promise<string | undefined> {
  for (const [max, quality] of steps) {
    const url = await encode(max, quality);
    if (url.length <= limit) return url;
  }
  return undefined;
}

/** One decoded copy of an image, encoded as JPEG at any size (decoding a large photo once, not once per step). */
async function jpegEncoder(blob: Blob): Promise<(max: number, quality: number) => string> {
  const img = await loadImage(await readFileAsDataURL(blob));
  return (max, quality) => {
    const scale = Math.min(1, max / Math.max(img.width, img.height, 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available in this browser');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  };
}

/** A stored image as a data URL small enough to be shared, else its preview when that fits, else nothing. */
async function sharedImage(media: MediaRef, steps: readonly (readonly [number, number])[]): Promise<string | undefined> {
  const preview = media.thumb && media.thumb.length <= LISTING_IMAGE_CHARS ? media.thumb : undefined;
  if (media.kind !== 'image') return preview;
  const blob = await getBlob(media.id);
  if (!blob) return preview;
  try {
    return (await fitDataUrl(await jpegEncoder(blob), steps)) ?? preview;
  } catch {
    return preview;
  }
}

/** As many gallery images as the shared Marketplace keeps, so buyers see the ones you picked. */
export const MAX_GALLERY = SHARED_GALLERY_MAX;

/** Gallery ids that still point at an image and aren't the cover, at most as many as the Marketplace shares. */
export function cleanGallery(ids: string[] | undefined, images: MediaRef[], coverId?: string): string[] {
  return (ids ?? []).filter((id) => id !== coverId && images.some((m) => m.id === id && m.kind === 'image')).slice(0, MAX_GALLERY);
}

/** The images the listing's gallery shows. */
export const galleryIds = (p: Project): string[] => cleanGallery(p.studio.listing.galleryIds, p.brand.images, p.studio.listing.coverImageId);

/** The chosen gallery images as small data URLs, each small enough to be shared. */
export async function galleryFromMedia(p: Project): Promise<string[] | undefined> {
  const out: string[] = [];
  for (const id of galleryIds(p)) {
    const media = p.brand.images.find((m) => m.id === id);
    const url = media && (await sharedImage(media, GALLERY_STEPS));
    if (url) out.push(url);
  }
  return out.length ? out : undefined;
}

/** The chosen cover photo as a small data URL that is shared with everyone who sees the listing. */
export async function coverFromMedia(p: Project): Promise<string | undefined> {
  const id = p.studio.listing.coverImageId;
  if (!id) return undefined;
  const media = p.brand.images.find((m) => m.id === id);
  return media ? sharedImage(media, COVER_STEPS) : undefined;
}

