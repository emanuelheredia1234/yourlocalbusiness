// "Public on the web" (P7): which of your listings have their own public page, your plan's limit, and the actions the
// Studio's Listing & publish tab, My listings and the assistant run (the same ones each time). Loaded only when the
// server has the public marketplace on and you're signed in; never in the claude.ai build.

import { create } from 'zustand';
import type { Listing, Project } from '@/lib/types';
import { useStore } from './useStore';
import { useBilling } from './billing';
import { tierName } from '@/lib/plans';
import { toast } from './ui';
import { pushMyListings } from '@/lib/community';
import {
  fetchPublicListings,
  isOnWeb,
  limitText,
  MarketError,
  marketOn,
  publicImagesFor,
  publicInput,
  setListingPublic,
  unlistPublic,
  type PublicListingState,
} from '@/lib/marketPublic';

interface MarketPublicState {
  /** the server's state per listing id */
  byListing: Record<string, PublicListingState>;
  /** your plan's public listings (null: unlimited) */
  limit: number | null;
  /** how many are on the web now */
  used: number;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** listing ids being turned on or off */
  busy: Record<string, boolean>;
  /** Read your public listings again (does nothing where the feature is off). */
  load: () => Promise<void>;
}

export const useMarketPublic = create<MarketPublicState>((set, get) => ({
  byListing: {},
  limit: null,
  used: 0,
  loaded: false,
  loading: false,
  error: null,
  busy: {},
  load: async () => {
    if (!marketOn() || get().loading) return;
    set({ loading: true, error: null });
    try {
      const r = await fetchPublicListings();
      set({ byListing: Object.fromEntries(r.listings.map((l) => [l.listingId, l])), limit: r.limit, used: r.used, loaded: true, loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },
}));

/** The plan's name for the counter ("Launch"), when known. */
export const planName = (): string => {
  const tier = useBilling.getState().plan?.tier;
  return tier ? tierName(tier) : '';
};

/** Whether the plan's limit is reached (a listing that's already on doesn't count against itself). */
export function atLimit(listingId: string, s: Pick<MarketPublicState, 'limit' | 'used' | 'byListing'> = useMarketPublic.getState()): boolean {
  return s.limit !== null && !isOnWeb(s.byListing[listingId]) && s.used >= s.limit;
}

const setBusy = (id: string, on: boolean) => useMarketPublic.setState((s) => ({ busy: { ...s.busy, [id]: on } }));

/** Keep the server's answer for one listing (and the count of listings on the web). */
function remember(state: PublicListingState): void {
  useMarketPublic.setState((s) => {
    const was = isOnWeb(s.byListing[state.listingId]);
    const now = isOnWeb(state);
    return { byListing: { ...s.byListing, [state.listingId]: state }, used: Math.max(0, s.used + (now === was ? 0 : now ? 1 : -1)) };
  });
}

/** Save the listing's web address with it (it travels to the shared Marketplace, so others can open the page). */
function saveWeb(listingId: string, web: Listing['web'] | undefined): void {
  const st = useStore.getState();
  const l = st.myListings.find((x) => x.id === listingId);
  if (!l) return;
  const { web: _old, ...rest } = l;
  if (JSON.stringify(_old) === JSON.stringify(web)) return;
  st.publishListing(web ? { ...rest, web } : rest);
  void pushMyListings();
}

/**
 * Put a published listing on the web, or update its page: its images uploaded as hosted files (once each), then the
 * server checks it and answers its status. Refusals (plan limit, hidden by the owner, a paused plan) throw the
 * server's words. Nothing is sent to Google from here.
 */
export async function putListingOnWeb(p: Project, listing: Listing): Promise<PublicListingState> {
  if (!marketOn()) throw new MarketError('Public web listings aren’t available here.', 'NOT_HERE');
  if (atLimit(listing.id)) throw new MarketError(limitText(useMarketPublic.getState().limit ?? 0), 'LIMIT', 409);
  setBusy(listing.id, true);
  try {
    let images = await publicImagesFor(p);
    let got;
    try {
      got = await setListingPublic(listing.id, publicInput(listing, images));
    } catch (e) {
      // an image the server doesn't have any more (removed, or another account's): upload them again, once
      if (!(e instanceof MarketError && e.code === 'IMAGE_NOT_HOSTED')) throw e;
      images = await publicImagesFor(p, { fresh: true });
      got = await setListingPublic(listing.id, publicInput(listing, images));
    }
    useStore.getState().updateProject(p.id, (x) => ({ ...x, studio: { ...x.studio, listing: { ...x.studio.listing, webImages: images.cache } } }));
    remember(got.listing);
    saveWeb(listing.id, { slug: got.listing.slug, url: got.listing.url });
    return got.listing;
  } catch (e) {
    if (e instanceof MarketError && e.code === 'LIMIT') {
      const lim = typeof e.extra.limit === 'number' ? e.extra.limit : useMarketPublic.getState().limit;
      useMarketPublic.setState((s) => ({ limit: lim ?? s.limit, used: typeof e.extra.used === 'number' ? e.extra.used : s.used }));
      throw new MarketError(limitText(lim ?? 0), 'LIMIT', 409, e.extra);
    }
    throw e;
  } finally {
    setBusy(listing.id, false);
  }
}

/** Take a listing off the web (its address stops working, Google drops it). Already off counts as done. */
export async function takeListingOffWeb(listingId: string): Promise<void> {
  setBusy(listingId, true);
  try {
    await unlistPublic(listingId);
    const had = useMarketPublic.getState().byListing[listingId];
    if (had) remember({ ...had, status: had.status === 'hidden' ? 'hidden' : 'unlisted', indexable: false });
    saveWeb(listingId, undefined);
  } finally {
    setBusy(listingId, false);
  }
}

/** Whether the listing has a public page to keep current (it's on the web, or this device saved its address). */
export function isPublic(l: Listing | undefined): boolean {
  if (!l) return false;
  const s = useMarketPublic.getState().byListing[l.id];
  return s ? isOnWeb(s) : !!l.web;
}

/**
 * After the in-app listing was published again: its web page gets the same content. A failure is a toast; the
 * in-app listing stays published either way.
 */
export async function refreshWebPage(p: Project, listing: Listing): Promise<void> {
  if (!marketOn() || !isPublic(listing)) return;
  try {
    await putListingOnWeb(p, listing);
  } catch (e) {
    toast({ kind: 'error', title: 'The web page wasn’t updated', body: (e as Error).message });
  }
}

/** Before a listing goes away (unpublished, or its business deleted): its web page is taken down too, best effort. */
export async function unlistBeforeRemoving(listings: (Listing | undefined)[]): Promise<void> {
  if (!marketOn()) return;
  for (const l of listings) {
    if (!l || !isPublic(l)) continue;
    await takeListingOffWeb(l.id).catch(() => undefined);
  }
}

/** "Public listings: 2 of 3 on Launch" (null: unlimited, so no counter). */
export function counterLine(s: Pick<MarketPublicState, 'limit' | 'used'> = useMarketPublic.getState(), plan = planName()): string | null {
  return s.limit === null ? null : `Public listings: ${s.used} of ${s.limit}${plan ? ` on ${plan}` : ''}`;
}
