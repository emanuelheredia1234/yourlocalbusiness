import type { Listing, Project, ServicePriceModel } from '@/lib/types';
import { hashStr, resizeImage, uid } from '@/lib/utils';
import { getBlob } from '@/lib/storage';
import { matchBusinessType } from '@/ai/knowledge';

const PATTERNS: Listing['cover']['pattern'][] = ['blobs', 'waves', 'dots', 'grid', 'rays'];

/** The price a business listing leads with: its most popular package (or the studio price). */
export function leadPrice(p: Project): { price: number; model: ServicePriceModel } {
  if (p.track === 'business') {
    const pk = p.studio.packages.find((x) => x.popular) ?? p.studio.packages[0];
    if (pk) return { price: pk.price, model: pk.priceModel };
    return { price: p.studio.price, model: 'per-session' };
  }
  return { price: p.studio.price, model: p.studio.priceModel };
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
    seller: { name: p.brand.name, logo: { icon: p.brand.logo.icon, color: c.primary, shape: p.brand.logo.shape, dataUrl: logoUpload }, verified: false },
    format: isBiz ? undefined : p.format ?? undefined,
    niche: p.niche,
    category: d.category || (isBiz ? bt?.category ?? 'Professional Services' : p.category || 'Digital Products'),
    tags: d.tags,
    location: isBiz ? (p.location ? { city: p.location.city, region: p.location.region, lat: p.location.lat, lng: p.location.lng } : { city: 'Online', region: '', online: true }) : undefined,
    website: p.brand.websiteUrl || undefined,
    bookingType: isBiz ? d.bookingType : 'buy',
    hours: isBiz ? d.hours || undefined : undefined,
    services: isBiz && p.studio.packages.length ? p.studio.packages.map((x) => ({ name: x.name, price: x.price, duration: x.priceModel === 'per-session' ? 'per session' : x.priceModel === 'monthly' ? 'monthly' : undefined })) : undefined,
    includes: includes.slice(0, 8),
    cover: {
      colors: [c.primary, c.secondary, c.accent],
      icon: p.brand.logo.icon,
      pattern: PATTERNS[hashStr(p.id) % PATTERNS.length],
      imageDataUrl: coverDataUrl ?? (d.coverImageId ? prev?.cover.imageDataUrl : undefined),
    },
    gallery: gallery ?? (d.galleryIds?.length ? prev?.gallery : undefined),
    rating: prev?.rating ?? 0,
    reviews: prev?.reviews ?? 0,
    sales: prev?.sales ?? 0,
    createdAt: prev?.createdAt ?? Date.now(),
    origin: 'mine',
    projectId: p.id,
  };
}

/** Compress the chosen gallery images (max 4) to small data URLs for the listing. */
export async function galleryFromMedia(p: Project): Promise<string[] | undefined> {
  const ids = (p.studio.listing.galleryIds ?? []).filter((id) => id !== p.studio.listing.coverImageId).slice(0, 4);
  const out: string[] = [];
  for (const id of ids) {
    const media = p.brand.images.find((m) => m.id === id);
    if (!media || media.kind !== 'image') continue;
    const blob = await getBlob(id);
    try {
      if (!blob) throw new Error('missing');
      // small enough to travel with the listing to other viewers (≈ 50 KB each)
      const { dataUrl } = await resizeImage(blob, 640, 'image/jpeg', 0.68);
      out.push(dataUrl.length < 56_000 ? dataUrl : (await resizeImage(blob, 480, 'image/jpeg', 0.62)).dataUrl);
    } catch {
      if (media.thumb) out.push(media.thumb);
    }
  }
  return out.length ? out : undefined;
}

/** Compress the chosen cover photo to a small data URL that fits in the shared store. */
export async function coverFromMedia(p: Project): Promise<string | undefined> {
  const id = p.studio.listing.coverImageId;
  if (!id) return undefined;
  const media = p.brand.images.find((m) => m.id === id);
  if (!media || media.kind !== 'image') return media?.thumb;
  const blob = await getBlob(id);
  if (!blob) return media.thumb;
  try {
    const { dataUrl } = await resizeImage(blob, 720, 'image/jpeg', 0.72);
    return dataUrl.length < 90_000 ? dataUrl : (await resizeImage(blob, 480, 'image/jpeg', 0.66)).dataUrl;
  } catch {
    return media.thumb;
  }
}

