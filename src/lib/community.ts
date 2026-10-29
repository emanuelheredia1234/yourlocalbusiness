// ───────────────────────── Shared marketplace (claude.ai Artifact `db` capability) ─────────────────────────
// When the app runs as a shared Artifact, published listings and checkout orders are
// written to the artifact's shared database so everyone the artifact is shared with
// can browse and buy from each other. Each viewer only writes their own documents:
//   market/<viewerId>  → { listings: Listing[] }
//   orders/<viewerId>  → { orders: CommunityOrder[] }
// Outside a viewer (or when signed out) everything stays local.

import { create } from 'zustand';
import type { Listing, Order } from './types';
import { getDb, getUser, useRuntime, type DbNs } from './platform';
import { useStore } from '@/store/useStore';

export interface CommunityOrder {
  id: string;
  createdAt: number;
  buyerId: string;
  items: { listingId: string; sellerId: string; title: string; price: number; qty: number }[];
}

interface CommunityState {
  listings: Listing[];
  orders: CommunityOrder[];
  set: (patch: Partial<Pick<CommunityState, 'listings' | 'orders'>>) => void;
}

export const useCommunity = create<CommunityState>((set) => ({ listings: [], orders: [], set: (p) => set(p) }));

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
  return { ...l, cover, gallery: gallery?.length ? gallery : undefined, seller: { ...l.seller, logo, ownerId: me ?? undefined }, origin: 'community' };
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
            for (const l of body?.listings ?? []) if (l && l.id && l.title) listings.push({ ...l, origin: 'community' });
          }
          useCommunity.getState().set({ listings });
        },
        () => useRuntime.getState().set({ community: 'local' }),
      ),
    );
    unsubs.push(
      db.collection('orders').onSnapshot(
        (snap) => {
          const orders: CommunityOrder[] = [];
          for (const d of snap.docs) {
            const body = d.data() as { orders?: CommunityOrder[] } | undefined;
            for (const o of body?.orders ?? []) if (o && o.id) orders.push(o);
          }
          useCommunity.getState().set({ orders });
          creditMySales(orders);
        },
        () => undefined,
      ),
    );
  } catch {
    useRuntime.getState().set({ community: 'local' });
  }
  // publish what this viewer already has
  await pushMyListings();
}

/** Turn other viewers' purchases of my listings into sales + notifications (once each). */
function creditMySales(orders: CommunityOrder[]) {
  const s = useStore.getState();
  const mine = new Map(s.myListings.map((l) => [l.id, l]));
  for (const o of orders) {
    if (o.buyerId === me) continue;
    for (const it of o.items) {
      if (it.sellerId !== me || !mine.has(it.listingId)) continue;
      const id = `c_${o.id}_${it.listingId}`;
      if (s.sales.some((x) => x.id === id)) continue;
      useStore.setState((st) => ({
        sales: [{ id, listingId: it.listingId, projectId: mine.get(it.listingId)?.projectId, title: it.title, amount: it.price * it.qty, qty: it.qty, createdAt: o.createdAt, buyer: 'Marketplace buyer', source: 'community' }, ...st.sales],
        myListings: st.myListings.map((l) => (l.id === it.listingId ? { ...l, sales: l.sales + it.qty } : l)),
      }));
      useStore.getState().notify({ kind: 'sale', title: `New sale: ${it.title}`, body: `$${(it.price * it.qty).toFixed(2)} from a marketplace buyer`, route: 'analytics' });
    }
  }
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

/** Record purchases of other viewers' listings so the sellers get credited. */
export async function recordCommunityOrder(order: Order): Promise<void> {
  if (!db || !me) return;
  const items = order.items.filter((i) => i.origin === 'community' && i.sellerOwnerId).map((i) => ({ listingId: i.listingId, sellerId: i.sellerOwnerId!, title: i.title, price: i.price, qty: i.qty }));
  if (!items.length) return;
  try {
    const ref = db.doc(`orders/${me}`);
    const snap = await ref.get();
    const prev = (snap.exists ? ((snap.data() as { orders?: CommunityOrder[] })?.orders ?? []) : []).slice(-150);
    await ref.set({ orders: [...prev, { id: order.id, createdAt: order.createdAt, buyerId: me, items }] });
  } catch {
    /* ignore: purchase still completes locally */
  }
}

export function stopCommunitySync() {
  unsubs.splice(0).forEach((u) => u());
  started = false;
}
