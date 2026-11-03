// ───────────────────────── Shared marketplace (claude.ai Artifact `db` capability) ─────────────────────────
// When the app runs as a shared Artifact, published listings are written to the artifact's
// shared database so everyone the artifact is shared with can browse them. Buying happens on each
// seller's own site (this app takes no payments). Each viewer only writes their own document:
//   market/<viewerId>  → { listings: Listing[] }
// Outside a viewer (or when signed out) everything stays local.

import { create } from 'zustand';
import type { Listing } from './types';
import { getDb, getUser, useRuntime, type DbNs } from './platform';
import { useStore } from '@/store/useStore';

interface CommunityState {
  listings: Listing[];
  set: (patch: Partial<Pick<CommunityState, 'listings'>>) => void;
}

export const useCommunity = create<CommunityState>((set) => ({ listings: [], set: (p) => set(p) }));

/** Only what a listing really is (older versions also carried made-up ratings, reviews and sold counts). */
export function cleanListing(l: Listing): Listing {
  const { rating: _r, reviews: _v, sales: _s, ...rest } = l as Listing & { rating?: unknown; reviews?: unknown; sales?: unknown };
  const { verified: _ver, ...seller } = (rest.seller ?? { name: '' }) as Listing['seller'] & { verified?: unknown };
  return { ...rest, seller };
}

let db: DbNs | null = null;
let me: string | null = null;
let started = false;
const unsubs: (() => void)[] = [];

function compact(l: Listing): Listing {
  // keep documents small: drop large data URLs beyond ~60KB
  const cover = l.cover.imageDataUrl && l.cover.imageDataUrl.length > 60_000 ? { ...l.cover, imageDataUrl: undefined } : l.cover;
  const logo = l.seller.logo?.dataUrl && l.seller.logo.dataUrl.length > 30_000 ? { ...l.seller.logo, dataUrl: undefined } : l.seller.logo;
  // gallery: at most 3 images, each small enough for the shared document
  const gallery = l.gallery?.filter((g) => g.length <= 60_000).slice(0, 3);
  return cleanListing({ ...l, cover, gallery: gallery?.length ? gallery : undefined, seller: { ...l.seller, logo, ownerId: me ?? undefined }, origin: 'community' });
}

export async function startCommunitySync(): Promise<void> {
  if (started) return;
  started = true;
  db = await getDb();
  const user = await getUser();
  me = user ? await user.id().catch(() => null) : null;
  if (!db || !me) {
    useRuntime.getState().set({ community: 'local' });
    return;
  }
  useRuntime.getState().set({ community: 'live', userId: me });
  try {
    unsubs.push(
      db.collection('market').onSnapshot(
        (snap) => {
          const listings: Listing[] = [];
          for (const d of snap.docs) {
            if (d.id === me) continue;
            const body = d.data() as { listings?: Listing[] } | undefined;
            for (const l of body?.listings ?? []) if (l && l.id && l.title && l.seller) listings.push(cleanListing({ ...l, origin: 'community' }));
          }
          useCommunity.getState().set({ listings });
        },
        () => useRuntime.getState().set({ community: 'local' }),
      ),
    );
  } catch {
    useRuntime.getState().set({ community: 'local' });
  }
  // publish what this viewer already has
  await pushMyListings();
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<void> = Promise.resolve();
let lastWritten = '';

/** Write this viewer's published listings to the shared store (debounced, one write at a time, own doc only). */
export function pushMyListings(): Promise<void> {
  return new Promise((resolve) => {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      writing = writing.then(async () => {
        try {
          if (!db || !me) return;
          const s = useStore.getState();
          const listings = s.settings.shareToCommunity ? s.myListings.map(compact) : [];
          const body = JSON.stringify(listings);
          if (body === lastWritten) return; // only write on change
          await db.doc(`market/${me}`).set({ listings, updatedAt: Date.now() });
          lastWritten = body;
        } catch {
          /* read-only viewers and quota errors keep the store local */
        }
      });
      writing.then(resolve);
    }, 600);
  });
}

export function stopCommunitySync() {
  unsubs.splice(0).forEach((u) => u());
  started = false;
}
