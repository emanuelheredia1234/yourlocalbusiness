// ───────────────────────── Shared marketplace ─────────────────────────
// Published listings are shared with everyone who uses the app:
//   - signed in (Supabase accounts): the market_listings table. Everyone signed in reads every
//     listing; row-level security lets each seller write only their own rows.
//   - in claude.ai as a shared Artifact: the artifact's shared database, one document per viewer
//     (market/<viewerId> → { listings }).
// Buying happens on each seller's own site: this app takes no payments. Otherwise listings stay local.

import { create } from 'zustand';
import type { Listing } from './types';
import { getDb, getUser, useRuntime, type DbNs } from './platform';
import { useStore } from '@/store/useStore';
import { marketAccess, useAuth } from './cloud/auth';

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
let mode: 'none' | 'artifact' | 'account' = 'none';
const unsubs: (() => void)[] = [];

/** Images in a listing: small data URLs only (never an outside address that could track viewers). */
const isDataImage = (v: unknown): v is string => typeof v === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(v) && v.length <= 120_000;

/** Another seller's listing as it came from the shared store: only well-formed fields, made-up numbers dropped. */
export function fromShared(raw: unknown, sellerId: string, id: string): Listing | null {
  const l = raw as Listing | null;
  if (!l || typeof l !== 'object' || typeof l.title !== 'string' || !l.title.trim() || !l.seller || typeof l.seller !== 'object' || !l.cover || typeof l.cover !== 'object') return null;
  const cover = { ...l.cover, imageDataUrl: isDataImage(l.cover.imageDataUrl) ? l.cover.imageDataUrl : undefined };
  const logo = l.seller.logo ? { ...l.seller.logo, dataUrl: isDataImage(l.seller.logo.dataUrl) ? l.seller.logo.dataUrl : undefined } : undefined;
  const gallery = Array.isArray(l.gallery) ? l.gallery.filter(isDataImage).slice(0, 4) : undefined;
  return cleanListing({ ...l, id, cover, gallery: gallery?.length ? gallery : undefined, seller: { ...l.seller, name: String(l.seller.name ?? ''), logo, ownerId: sellerId }, tags: Array.isArray(l.tags) ? l.tags.filter((t) => typeof t === 'string') : [], origin: 'community' });
}

/** The most a shared listing image may weigh (data-URL characters); larger ones are left out. The Studio makes
 *  cover and gallery images fit under it when you publish (src/lib/listing.ts). */
export const SHARED_IMAGE_CHARS = 60_000;
/** Gallery images shared per listing. The Studio lets you pick this many, so buyers see what you chose. */
export const SHARED_GALLERY_MAX = 3;

/** What of your listing is shared: small enough for the shared document, without made-up numbers. */
export function compact(l: Listing): Listing {
  const cover = l.cover.imageDataUrl && l.cover.imageDataUrl.length > SHARED_IMAGE_CHARS ? { ...l.cover, imageDataUrl: undefined } : l.cover;
  const logo = l.seller.logo?.dataUrl && l.seller.logo.dataUrl.length > 30_000 ? { ...l.seller.logo, dataUrl: undefined } : l.seller.logo;
  const gallery = l.gallery?.filter((g) => g.length <= SHARED_IMAGE_CHARS).slice(0, SHARED_GALLERY_MAX);
  return cleanListing({ ...l, cover, gallery: gallery?.length ? gallery : undefined, seller: { ...l.seller, logo, ownerId: me ?? undefined }, origin: 'community' });
}

// ───────────── signed in: the market_listings table ─────────────

const REFRESH_MS = 60_000;

async function loadAccountListings(): Promise<void> {
  const a = marketAccess();
  if (!a) return;
  const { data, error } = await a.client.from('market_listings').select('user_id,id,data,updated_at').order('updated_at', { ascending: false }).limit(1000);
  if (error || !Array.isArray(data)) return;
  const listings: Listing[] = [];
  for (const r of data as { user_id: string; id: string; data: unknown }[]) {
    if (r.user_id === a.userId) continue; // yours come from your own workspace
    const l = fromShared(r.data, r.user_id, r.id);
    if (l) listings.push(l);
  }
  useCommunity.getState().set({ listings });
}

async function startAccount(): Promise<void> {
  const a = marketAccess();
  if (!a) return;
  mode = 'account';
  me = a.userId;
  useRuntime.getState().set({ community: 'live', userId: me });
  await loadAccountListings();
  if (typeof window !== 'undefined') {
    const t = setInterval(() => document.visibilityState === 'visible' && void loadAccountListings(), REFRESH_MS);
    const onVisible = () => document.visibilityState === 'visible' && void loadAccountListings();
    document.addEventListener('visibilitychange', onVisible);
    unsubs.push(() => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    });
  }
  await pushMyListings();
}

/** Make the account's rows match what you publish: upsert yours, remove ones you unpublished. */
async function writeAccountListings(listings: Listing[]): Promise<boolean> {
  const a = marketAccess();
  if (!a || a.userId !== me) return false;
  const table = a.client.from('market_listings');
  if (listings.length) {
    const { error } = await table.upsert(listings.map((l) => ({ user_id: a.userId, id: l.id, data: l })), { onConflict: 'user_id,id' });
    if (error) return false;
  }
  const { data, error } = await a.client.from('market_listings').select('id').eq('user_id', a.userId);
  if (error || !Array.isArray(data)) return false;
  const keep = new Set(listings.map((l) => l.id));
  const stale = (data as { id: string }[]).map((r) => r.id).filter((id) => !keep.has(id));
  if (stale.length) {
    const { error: e2 } = await a.client.from('market_listings').delete().eq('user_id', a.userId).in('id', stale);
    if (e2) return false;
  }
  return true;
}

// ───────────── claude.ai shared Artifact ─────────────

async function startArtifact(): Promise<void> {
  db = await getDb();
  const user = await getUser();
  me = user ? await user.id().catch(() => null) : null;
  if (!db || !me) {
    useRuntime.getState().set({ community: 'local' });
    return;
  }
  mode = 'artifact';
  useRuntime.getState().set({ community: 'live', userId: me });
  try {
    unsubs.push(
      db.collection('market').onSnapshot(
        (snap) => {
          const listings: Listing[] = [];
          for (const d of snap.docs) {
            if (d.id === me) continue;
            const body = d.data() as { listings?: Listing[] } | undefined;
            for (const l of body?.listings ?? []) {
              const ok = l && typeof l.id === 'string' ? fromShared(l, d.id, l.id) : null;
              if (ok) listings.push(ok);
            }
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

export async function startCommunitySync(): Promise<void> {
  if (started) return;
  started = true;
  watchAccount();
  if (marketAccess()) return startAccount();
  // signed out with accounts on: nothing is shared until you sign in
  if (!__ARTIFACT_BUILD__ && useAuth.getState().phase !== 'off') {
    useRuntime.getState().set({ community: 'local' });
    return;
  }
  return startArtifact();
}

let watching = false;
/** Signing in, out or into another account restarts the Marketplace for that account. */
function watchAccount() {
  if (watching) return;
  watching = true;
  let lastUser = useAuth.getState().phase === 'ready' ? useAuth.getState().user?.id ?? null : null;
  useAuth.subscribe((st) => {
    const user = st.phase === 'ready' ? st.user?.id ?? null : null;
    if (user === lastUser) return;
    lastUser = user;
    stopCommunitySync();
    useCommunity.getState().set({ listings: [] });
    lastWritten = '';
    if (user) void startCommunitySync();
    else useRuntime.getState().set({ community: 'local' });
  });
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<void> = Promise.resolve();
let lastWritten = '';

/** Share your published listings (debounced, one write at a time, your own rows only). */
export function pushMyListings(): Promise<void> {
  return new Promise((resolve) => {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      writing = writing.then(async () => {
        try {
          if (mode === 'none' || !me) return;
          const s = useStore.getState();
          const listings = s.settings.shareToCommunity ? s.myListings.map(compact) : [];
          const body = JSON.stringify(listings);
          if (body === lastWritten) return; // only write on change
          if (mode === 'account') {
            if (await writeAccountListings(listings)) lastWritten = body;
            return;
          }
          if (!db) return;
          await db.doc(`market/${me}`).set({ listings, updatedAt: Date.now() });
          lastWritten = body;
        } catch {
          /* offline or refused: the next change tries again */
        }
      });
      writing.then(resolve);
    }, 600);
  });
}

export function stopCommunitySync() {
  unsubs.splice(0).forEach((u) => u());
  started = false;
  mode = 'none';
  me = null;
}

/** Refresh other sellers' listings now (e.g. when the Marketplace opens). */
export function refreshCommunity(): Promise<void> {
  return mode === 'account' ? loadAccountListings() : Promise.resolve();
}
