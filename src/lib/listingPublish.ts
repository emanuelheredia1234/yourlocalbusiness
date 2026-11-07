// Publishing a project's listing to the Marketplace: the checks it must pass, and the publish, unpublish
// and "show my listings to other people" actions. Studio → Listing & publish runs these from its buttons;
// the assistant's publish window runs the same ones once the owner confirms there.

import type { Listing, Project } from './types';
import { getActiveProject, useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { navigate } from './router';
import { useRuntime } from './platform';
import { pushMyListings, startCommunitySync } from './community';
import { buildListing, coverFromMedia, galleryFromMedia, galleryIds, leadPrice, listingOfferId } from './listing';
import { offerIdsForPublish, useOffers } from '@/store/offers';
import { listingActions, safeEmail, safeUrl } from './listingActions';
import { refreshWebPage, unlistBeforeRemoving } from '@/store/marketPublic';

export interface ListingCheck {
  ok: boolean;
  label: string;
  /** a tip: publishing doesn't wait for it */
  optional?: boolean;
}

/** The project's listing as it is on the Marketplace now, when it's published. */
export function liveListing(p: Project): Listing | undefined {
  return useStore.getState().myListings.find((l) => l.id === p.studio.publishedListingId);
}

/** What a listing needs before it's published (required ones block the Publish button; optional ones are tips). */
export function listingChecks(p: Project, preview: Listing = buildListing(p, liveListing(p))): ListingCheck[] {
  const d = p.studio.listing;
  const isBiz = p.track === 'business';
  const lp = leadPrice(p);
  return [
    { ok: d.title.trim().length >= 4, label: 'Title' },
    { ok: d.description.trim().length >= 80, label: 'Description (80+ characters)' },
    { ok: lp.price > 0 || lp.model === 'free' || lp.model === 'quote', label: isBiz ? 'Package pricing' : 'Price' },
    { ok: d.tags.length >= 3, label: '3+ search tags' },
    { ok: isBiz ? p.studio.packages.length > 0 : p.studio.outline.length > 0, label: isBiz ? 'Service packages (Structure tab)' : 'Product outline (Structure tab)' },
    { ok: !d.buyUrl?.trim() || !!safeUrl(d.buyUrl), label: 'Buy or booking link is a web address' },
    { ok: !d.contactEmail?.trim() || !!safeEmail(d.contactEmail), label: 'Email address looks right' },
    { ok: listingActions(preview).length > 0, label: 'A way to buy or reach you (link, website, email or phone)', optional: true },
    { ok: !!d.coverImageId, label: 'Cover photo (optional: brand cover is used otherwise)', optional: true },
  ];
}

/** The required checks a listing doesn't pass yet (publishing waits for these). */
export const blockingChecks = (p: Project): ListingCheck[] => listingChecks(p).filter((c) => !c.ok && !c.optional);

/** Whether the live listing differs from what publishing now would share (its words, price, images…). */
export function listingChanged(p: Project, live: Listing | undefined): boolean {
  if (!live) return false;
  // its offer's buy link is only known once the business's offers have loaded: until then it isn't compared
  const unsure = !!listingOfferId(p) && !useOffers.getState().byProject[p.id];
  const strip = (l: Listing) => {
    const { buyUrl, offer, ...rest } = l;
    return { ...rest, cover: null, gallery: null, ...(unsure ? {} : { buyUrl, offer }) };
  };
  return JSON.stringify(strip(buildListing(p, live))) !== JSON.stringify(strip(live)) || galleryIds(p).length !== (live.gallery?.length ?? 0);
}

/**
 * Before a listing with an offer is published: the business's offers asked of the server now, so its buy link is the
 * offer's. One that isn't the business's (any more), or can't be checked now, isn't published without it.
 */
export async function checkListingOffer(p: Project, ask: (projectId: string) => Promise<ReadonlySet<string>> = offerIdsForPublish): Promise<void> {
  const id = listingOfferId(p);
  // this build has no offers (no server): the listing keeps its typed link
  if (!id || __ARTIFACT_BUILD__) return;
  let ids: ReadonlySet<string>;
  try {
    ids = await ask(p.id);
  } catch {
    throw new Error('Couldn’t check this listing’s buy link. Try again in a moment.');
  }
  if (!ids.has(id)) throw new Error('This listing’s buy link isn’t one of this business’s offers any more. Attach payment again, or remove it.');
}

/** Whether your listings are shared with everyone who uses the app (the shared Marketplace is on, and you show them). */
export const listingsShared = () => useRuntime.getState().community === 'live' && useStore.getState().settings.shareToCommunity;

/** Open a listing as buyers see it, in the Marketplace. */
export function openInStore(id: string): void {
  void navigate('store');
  setTimeout(() => useUI.getState().openListing(id), 60);
}

/**
 * Publish the open project's listing, or update it when it's live: its cover and gallery made small enough
 * to share, then shared with everyone who uses the app when the Marketplace is shared (only you see it
 * otherwise). Says how it went in a toast and a notification.
 */
export async function publishProjectListing(): Promise<{ listing: Listing; updated: boolean; shared: boolean }> {
  const p = getActiveProject();
  if (!p) throw new Error('Open a project first.');
  const live = liveListing(p);
  await checkListingOffer(p);
  const cover = await coverFromMedia(p);
  const gallery = await galleryFromMedia(p);
  const listing = { ...buildListing(p, live, cover, gallery), gallery };
  useStore.getState().publishListing(listing);
  useStore.getState().updateStudio({ publishedListingId: listing.id, publishedAt: Date.now() });
  await startCommunitySync();
  await pushMyListings();
  // its public web page (P7), when it has one, gets the same content (a failure is its own toast)
  if (live) void refreshWebPage(p, listing);
  const shared = useRuntime.getState().community === 'live';
  useStore.getState().notify({ kind: 'info', title: live ? `Listing updated: ${listing.title}` : shared ? `${listing.title} is on the shared Marketplace` : `${listing.title} is in your listings`, route: 'store' });
  toast({ kind: 'success', title: live ? 'Listing updated' : shared ? 'Published to the Marketplace' : 'Saved to your listings', body: shared ? listing.title : `${listing.title}. Only you can see it here for now.`, action: { label: 'View listing', run: () => openInStore(listing.id) } });
  return { listing, updated: !!live, shared };
}

/** What the danger confirm says before a listing is unpublished. */
export const UNPUBLISH_CONFIRM = { title: 'Unpublish this listing?', body: 'It disappears from the Marketplace. Your Studio work stays intact and you can republish anytime.', confirmLabel: 'Unpublish' };

/** Take the open project's listing off the Marketplace (the Studio work stays, and it can be published again). */
export function unpublishProjectListing(): Listing | null {
  const p = getActiveProject();
  const live = p ? liveListing(p) : undefined;
  if (!live) return null;
  // its public web page goes too (best effort: its address answers "gone" and Google drops it)
  void unlistBeforeRemoving([live]);
  useStore.getState().unpublishListing(live.id);
  useStore.getState().updateStudio({ publishedListingId: undefined, publishedAt: undefined });
  void pushMyListings();
  toast({ kind: 'info', title: 'Listing unpublished' });
  return live;
}

/** Show your listings to other people on the shared Marketplace, or hide them (they stay in your listings). */
export function setListingsShared(on: boolean): void {
  useStore.getState().updateSettings((s) => ({ ...s, shareToCommunity: on }));
  setTimeout(() => void pushMyListings(), 0);
}
