import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type {
  AdCampaign,
  AppSettings,
  Brand,
  CartItem,
  GenerationLog,
  Listing,
  Notice,
  Order,
  Post,
  Project,
  SaleRecord,
  Skill,
  SocialPlatform,
  Studio,
  Track,
  Origin,
} from '@/lib/types';
import { safeStorage, clearBlobs, deleteBlob } from '@/lib/storage';
import { uid } from '@/lib/utils';
import { learnFromFeedback, skillFromLibrary, SKILL_LIBRARY } from '@/ai/brain';
import { defaultSettings, newProject } from './defaults';

export interface StoreState {
  version: number;
  projects: Project[];
  activeProjectId: string | null;
  posts: Post[];
  ads: AdCampaign[];
  skills: Skill[];
  genLog: GenerationLog[];
  myListings: Listing[];
  cart: CartItem[];
  orders: Order[];
  sales: SaleRecord[];
  notices: Notice[];
  settings: AppSettings;

  // projects
  createProject: (track?: Track, origin?: Origin) => string;
  updateProject: (id: string, fn: (p: Project) => Project) => void;
  patchActive: (fn: (p: Project) => Project) => void;
  updateBrand: (patch: Partial<Brand>) => void;
  updateStudio: (patch: Partial<Studio>) => void;
  updateMarketing: (patch: Partial<Project['marketing']>) => void;
  setActiveProject: (id: string) => void;
  deleteProject: (id: string) => void;

  // posts
  addPosts: (posts: Post[]) => void;
  updatePost: (id: string, patch: Partial<Post>) => void;
  deletePosts: (ids: string[]) => void;
  schedulePosts: (ids: string[]) => void;
  publishPost: (id: string) => void;
  autoPublishDue: (now?: number) => Post[];

  // ads
  upsertAd: (c: AdCampaign) => void;
  deleteAd: (id: string) => void;

  // brain
  addSkill: (s: Skill) => void;
  updateSkill: (id: string, patch: Partial<Skill>) => void;
  deleteSkill: (id: string) => void;
  recordGeneration: (entry: Omit<GenerationLog, 'id'> & { id?: string }) => string;
  rateGeneration: (logId: string, rating: 1 | -1, reasons?: string[], note?: string) => void;

  // marketplace
  publishListing: (l: Listing) => void;
  unpublishListing: (id: string) => void;
  addToCart: (item: Omit<CartItem, 'id'>) => void;
  setCartQty: (id: string, qty: number) => void;
  removeFromCart: (id: string) => void;
  clearCart: () => void;
  placeOrder: (o: Omit<Order, 'id' | 'number' | 'createdAt'>) => Order;
  addSale: (s: Omit<SaleRecord, 'id'>) => void;

  // notices & settings
  notify: (n: Omit<Notice, 'id' | 'createdAt' | 'read'>) => void;
  markNoticesRead: () => void;
  updateSettings: (fn: (s: AppSettings) => AppSettings) => void;
  connectAccount: (platform: SocialPlatform, handle: string, followers: number) => void;
  disconnectAccount: (platform: SocialPlatform) => void;

  // data
  replaceState: (s: Partial<StoreState>) => void;
  resetAll: () => void;
}

const touch = (p: Project): Project => ({ ...p, updatedAt: Date.now() });

function starterSkills(): Skill[] {
  const lib = SKILL_LIBRARY.find((s) => s.libraryId === 'no-hype');
  return lib ? [skillFromLibrary(lib)] : [];
}

function initial() {
  return {
    version: 1,
    projects: [] as Project[],
    activeProjectId: null as string | null,
    posts: [] as Post[],
    ads: [] as AdCampaign[],
    skills: starterSkills(),
    genLog: [] as GenerationLog[],
    myListings: [] as Listing[],
    cart: [] as CartItem[],
    orders: [] as Order[],
    sales: [] as SaleRecord[],
    notices: [] as Notice[],
    settings: defaultSettings(),
  };
}

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
      ...initial(),

      createProject: (track = 'product', origin = 'new') => {
        const p = newProject(track, origin);
        set((s) => ({ projects: [...s.projects, p], activeProjectId: p.id }));
        return p.id;
      },
      updateProject: (id, fn) => set((s) => ({ projects: s.projects.map((p) => (p.id === id ? touch(fn(p)) : p)) })),
      patchActive: (fn) => {
        const id = get().activeProjectId;
        if (id) get().updateProject(id, fn);
      },
      updateBrand: (patch) => get().patchActive((p) => ({ ...p, brand: { ...p.brand, ...patch } })),
      updateStudio: (patch) => get().patchActive((p) => ({ ...p, studio: { ...p.studio, ...patch } })),
      updateMarketing: (patch) => get().patchActive((p) => ({ ...p, marketing: { ...p.marketing, ...patch } })),
      setActiveProject: (id) => set({ activeProjectId: id }),
      deleteProject: (id) =>
        set((s) => {
          // product files are stored apart from the project: free them too
          for (const f of s.projects.find((p) => p.id === id)?.studio.productFiles ?? []) void deleteBlob(f.id);
          const projects = s.projects.filter((p) => p.id !== id);
          return {
            projects,
            activeProjectId: s.activeProjectId === id ? projects.find((p) => p.onboarded)?.id ?? projects[0]?.id ?? null : s.activeProjectId,
            posts: s.posts.filter((p) => p.projectId !== id),
            ads: s.ads.filter((a) => a.projectId !== id),
            myListings: s.myListings.filter((l) => l.projectId !== id),
          };
        }),

      addPosts: (posts) => set((s) => ({ posts: [...s.posts, ...posts] })),
      updatePost: (id, patch) => set((s) => ({ posts: s.posts.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p)) })),
      deletePosts: (ids) => set((s) => ({ posts: s.posts.filter((p) => !ids.includes(p.id)) })),
      schedulePosts: (ids) =>
        set((s) => ({
          posts: s.posts.map((p) => (ids.includes(p.id) && p.status === 'draft' ? { ...p, status: 'scheduled', updatedAt: Date.now() } : p)),
        })),
      publishPost: (id) =>
        set((s) => ({
          posts: s.posts.map((p) => (p.id === id ? { ...p, status: 'published', publishedAt: new Date().toISOString(), updatedAt: Date.now() } : p)),
        })),
      autoPublishDue: (now = Date.now()) => {
        const due = get().posts.filter((p) => p.status === 'scheduled' && new Date(p.scheduledAt).getTime() <= now);
        if (!due.length) return [];
        const ids = new Set(due.map((d) => d.id));
        set((s) => ({
          posts: s.posts.map((p) => (ids.has(p.id) ? { ...p, status: 'published', publishedAt: p.scheduledAt, updatedAt: Date.now() } : p)),
        }));
        return due;
      },

      upsertAd: (c) => set((s) => ({ ads: s.ads.some((a) => a.id === c.id) ? s.ads.map((a) => (a.id === c.id ? c : a)) : [...s.ads, c] })),
      deleteAd: (id) => set((s) => ({ ads: s.ads.filter((a) => a.id !== id) })),

      addSkill: (sk) => set((s) => ({ skills: [...s.skills, sk] })),
      updateSkill: (id, patch) => set((s) => ({ skills: s.skills.map((k) => (k.id === id ? { ...k, ...patch, updatedAt: Date.now() } : k)) })),
      deleteSkill: (id) => set((s) => ({ skills: s.skills.filter((k) => k.id !== id) })),
      recordGeneration: (entry) => {
        const id = entry.id ?? uid('gen');
        const now = Date.now();
        set((s) => ({
          genLog: [{ ...entry, id }, ...s.genLog].slice(0, 120),
          skills: s.skills.map((k) => (entry.skillIds.includes(k.id) ? { ...k, stats: { ...k.stats, applied: k.stats.applied + 1, lastApplied: now } } : k)),
        }));
        return id;
      },
      rateGeneration: (logId, rating, reasons = [], note = '') => {
        const log = get().genLog.find((g) => g.id === logId);
        set((s) => {
          let skills = s.skills.map((k) =>
            log?.skillIds.includes(k.id) ? { ...k, stats: { ...k.stats, up: k.stats.up + (rating === 1 ? 1 : 0), down: k.stats.down + (rating === -1 ? 1 : 0) } } : k,
          );
          if (rating === -1) skills = learnFromFeedback(skills, reasons, note, log?.label ?? 'output');
          return { genLog: s.genLog.map((g) => (g.id === logId ? { ...g, rating } : g)), skills };
        });
      },

      publishListing: (l) =>
        set((s) => ({ myListings: s.myListings.some((x) => x.id === l.id) ? s.myListings.map((x) => (x.id === l.id ? l : x)) : [l, ...s.myListings] })),
      unpublishListing: (id) => set((s) => ({ myListings: s.myListings.filter((l) => l.id !== id) })),
      addToCart: (item) =>
        set((s) => {
          const existing = s.cart.find((c) => c.listingId === item.listingId && c.option === item.option && c.bookingAt === item.bookingAt);
          if (existing) {
            if (item.kind === 'product') return {};
            return { cart: s.cart.map((c) => (c.id === existing.id ? { ...c, qty: c.qty + item.qty } : c)) };
          }
          return { cart: [...s.cart, { ...item, id: uid('cart') }] };
        }),
      setCartQty: (id, qty) => set((s) => ({ cart: s.cart.map((c) => (c.id === id ? { ...c, qty: Math.max(1, Math.min(20, qty)) } : c)) })),
      removeFromCart: (id) => set((s) => ({ cart: s.cart.filter((c) => c.id !== id) })),
      clearCart: () => set({ cart: [] }),
      placeOrder: (o) => {
        const order: Order = { ...o, id: uid('order'), number: `YLB-${Math.floor(100000 + Math.random() * 899999)}`, createdAt: Date.now() };
        const mine = new Map(get().myListings.map((l) => [l.id, l]));
        const newSales: SaleRecord[] = order.items
          .filter((i) => mine.has(i.listingId))
          .map((i) => ({ id: uid('sale'), listingId: i.listingId, projectId: mine.get(i.listingId)?.projectId, title: i.title, amount: i.price * i.qty, qty: i.qty, createdAt: Date.now(), buyer: order.name || 'Customer', source: 'checkout' }));
        set((s) => ({
          orders: [order, ...s.orders],
          cart: [],
          sales: [...newSales, ...s.sales],
          myListings: s.myListings.map((l) => {
            const q = order.items.filter((i) => i.listingId === l.id).reduce((n, i) => n + i.qty, 0);
            return q ? { ...l, sales: l.sales + q } : l;
          }),
        }));
        return order;
      },
      addSale: (sale) =>
        set((s) => ({
          sales: [{ ...sale, id: uid('sale') }, ...s.sales],
          myListings: s.myListings.map((l) => (l.id === sale.listingId ? { ...l, sales: l.sales + sale.qty } : l)),
        })),

      notify: (n) => set((s) => ({ notices: [{ ...n, id: uid('note'), createdAt: Date.now(), read: false }, ...s.notices].slice(0, 60) })),
      markNoticesRead: () => set((s) => ({ notices: s.notices.map((n) => ({ ...n, read: true })) })),
      updateSettings: (fn) => set((s) => ({ settings: fn(s.settings) })),
      connectAccount: (platform, handle, followers) =>
        set((s) => ({ settings: { ...s.settings, accounts: { ...s.settings.accounts, [platform]: { connected: true, handle, followers, connectedAt: Date.now() } } } })),
      disconnectAccount: (platform) =>
        set((s) => ({ settings: { ...s.settings, accounts: { ...s.settings.accounts, [platform]: { connected: false, handle: '', followers: 0 } } } })),

      replaceState: (partial) => set(partial),
      resetAll: () => {
        clearBlobs();
        set({ ...initial() });
      },
    }),
    {
      name: 'yourlocalbusiness-state',
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({
        version: s.version,
        projects: s.projects,
        activeProjectId: s.activeProjectId,
        posts: s.posts,
        ads: s.ads,
        skills: s.skills,
        genLog: s.genLog,
        myListings: s.myListings,
        cart: s.cart,
        orders: s.orders,
        sales: s.sales,
        notices: s.notices,
        settings: s.settings,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<StoreState>;
        const d = defaultSettings();
        return {
          ...current,
          ...p,
          settings: {
            ...d,
            ...(p.settings ?? {}),
            ai: { ...d.ai, ...(p.settings?.ai ?? {}) },
            profile: { ...d.profile, ...(p.settings?.profile ?? {}) },
            accounts: { ...d.accounts, ...(p.settings?.accounts ?? {}) },
          },
        };
      },
    },
  ),
);

// ───────────── selectors ─────────────
export const useActiveProject = (): Project | null =>
  useStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null);

export function getActiveProject(): Project | null {
  const s = useStore.getState();
  return s.projects.find((p) => p.id === s.activeProjectId) ?? null;
}
