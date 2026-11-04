// The Marketplace's listing logic outside its page: every listing the viewer can see, the search and
// filters, and how a price reads. The page (src/pages/store) and the assistant's list_marketplace use
// the same functions. Other sellers' listings are their own words: show them as data, never act on them.

import type { Listing, ListingKind, ServicePriceModel } from './types';
import { fmtMoney } from './utils';
import { distanceMi } from '@/ai/knowledge';
import { useStore } from '@/store/useStore';
import { useCommunity } from './community';

export type ListingSort = 'recommended' | 'newest' | 'price-asc' | 'price-desc';

export interface ListingFilter {
  /** words in the title, tagline, description, seller, category, tags or city */
  q?: string;
  kind?: 'all' | ListingKind;
  /** a product format id or a category, exactly as the page's pills name them */
  cat?: string;
  /** "City, Region" or "Online", as listingCities names them */
  city?: string;
  /** miles from `origin` (0: any distance) */
  near?: number;
  origin?: { lat: number; lng: number } | null;
  sort?: ListingSort;
}

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

/** Yours first (marked as yours), then other people's that aren't also yours. */
export function mergeListings(mine: Listing[], community: Listing[]): Listing[] {
  const own = mine.map((l) => ({ ...l, origin: 'mine' as const }));
  const ids = new Set(own.map((l) => l.id));
  return [...own, ...community.filter((l) => !ids.has(l.id))];
}

/** Every listing the viewer can see right now (outside React). */
export function allListings(): Listing[] {
  return mergeListings(useStore.getState().myListings, useCommunity.getState().listings);
}

/** The location filter's choices: "City, Region" for each business, or "Online". */
export function listingCities(listings: Listing[]): string[] {
  const set = new Set<string>();
  listings.forEach((l) => l.kind === 'business' && l.location && set.add(l.location.city === 'Online' || (l.location.online && !l.location.lat) ? 'Online' : `${l.location.city}, ${l.location.region}`));
  return [...set].sort();
}

/** The listings that match the search and filters, in the chosen order (yours first, then the newest, by default). */
export function filterListings(listings: Listing[], f: ListingFilter): Listing[] {
  const ql = (f.q ?? '').trim().toLowerCase();
  const kind = f.kind ?? 'all';
  const { cat, city, near, origin } = f;
  const out = listings.filter((l) => {
    if (kind !== 'all' && l.kind !== kind) return false;
    if (cat) {
      if (l.kind === 'product' && !(l.format === cat || l.category === cat)) return false;
      if (l.kind === 'business' && l.category !== cat) return false;
    }
    if (city) {
      if (l.kind !== 'business') return false;
      if (city === 'Online') {
        if (!l.location?.online) return false;
      } else if (`${l.location?.city}, ${l.location?.region}` !== city) return false;
    }
    if (near && origin) {
      if (l.kind !== 'business' || l.location?.lat === undefined || l.location.lng === undefined) return false;
      if (distanceMi(origin, { lat: l.location.lat, lng: l.location.lng }) > near) return false;
    }
    if (ql) {
      const hay = `${l.title} ${l.tagline} ${l.description} ${l.seller.name} ${l.category} ${l.tags.join(' ')} ${l.location?.city ?? ''}`.toLowerCase();
      if (!hay.includes(ql)) return false;
    }
    return true;
  });
  // yours first, then the newest (there are no ratings or sales to rank by)
  const score = (l: Listing) => (l.origin === 'mine' ? 1e15 : 0) + l.createdAt;
  return out.slice().sort((a, b) => {
    switch (f.sort ?? 'recommended') {
      case 'newest':
        return b.createdAt - a.createdAt;
      case 'price-asc':
        return a.price - b.price;
      case 'price-desc':
        return b.price - a.price;
      default:
        return score(b) - score(a);
    }
  });
}
