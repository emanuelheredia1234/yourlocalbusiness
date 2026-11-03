// Saves the signed-in user's workspace to Supabase and keeps devices in step.
//
// Each project, post, ad, skill, generation, listing and notice is its own row in
// user_docs (plus one row for the account-level settings). Changes are found by comparing the
// store before and after each update, saved a moment later in small batches, and remembered across
// reloads until Supabase has them. Pulling compares each row's updated_at with what this device last
// saw, so only rows changed elsewhere are downloaded.

import { create } from 'zustand';
import type { AppSettings } from '@/lib/types';
import { safeStorage } from '@/lib/storage';
import { useStore, type StoreState } from '@/store/useStore';

export type DocKind = 'project' | 'post' | 'ad' | 'skill' | 'gen' | 'listing' | 'order' | 'sale' | 'notice' | 'settings';
type SliceKey = 'projects' | 'posts' | 'ads' | 'skills' | 'genLog' | 'myListings' | 'notices';
type Entity = { id: string; createdAt?: number };

/** Which store list each kind of row fills, and its order (lists that grow at the top are newest first). */
export const SLICES: { slice: SliceKey; kind: DocKind; newestFirst: boolean }[] = [
  { slice: 'projects', kind: 'project', newestFirst: false },
  { slice: 'posts', kind: 'post', newestFirst: false },
  { slice: 'ads', kind: 'ad', newestFirst: false },
  { slice: 'skills', kind: 'skill', newestFirst: false },
  { slice: 'genLog', kind: 'gen', newestFirst: true },
  { slice: 'myListings', kind: 'listing', newestFirst: true },
  { slice: 'notices', kind: 'notice', newestFirst: true },
];
const SETTINGS_KEY = 'settings:user';
/** Kinds older versions saved that nothing uses any more: the pretend checkout's orders and sales. Removed from the account when seen. */
export const RETIRED_KINDS: DocKind[] = ['order', 'sale'];
const KNOWN_KINDS = new Set<DocKind>([...SLICES.map((x) => x.kind), 'settings']);

export interface DocRow {
  kind: DocKind;
  id: string;
  data?: unknown;
  updated_at: string;
}

/** Where rows live (Supabase in the app; an in-memory stand-in in tests). */
export interface SyncBackend {
  /** kind, id and updated_at of every row the user has */
  index(): Promise<DocRow[]>;
  /** full rows */
  fetch(kind: DocKind, ids: string[]): Promise<DocRow[]>;
  /** insert or replace; returns kind, id and the new updated_at */
  upsert(rows: { kind: DocKind; id: string; data: unknown }[]): Promise<DocRow[]>;
  remove(kind: DocKind, ids: string[]): Promise<void>;
}

/** The settings that belong to the account. Theme, server address and demo switches stay per device. */
export interface AccountSettings {
  profile: AppSettings['profile'];
  /** only from older versions (their pretend connections): the cleanup moves the handles and drops it */
  accounts?: AppSettings['accounts'];
  useBrain: boolean;
  shareToCommunity: boolean;
}
const accountSettings = (s: AppSettings): AccountSettings => ({ profile: s.profile, ...(s.accounts ? { accounts: s.accounts } : {}), useBrain: s.ai.useBrain, shareToCommunity: s.shareToCommunity });
function withAccountSettings(s: AppSettings, a: Partial<AccountSettings>): AppSettings {
  return {
    ...s,
    profile: a.profile && typeof a.profile === 'object' ? { ...s.profile, ...a.profile } : s.profile,
    // kept only until the cleanup has moved its handles (see store/cleanup.ts)
    accounts: a.accounts && typeof a.accounts === 'object' ? a.accounts : s.accounts,
    shareToCommunity: typeof a.shareToCommunity === 'boolean' ? a.shareToCommunity : s.shareToCommunity,
    ai: { ...s.ai, useBrain: typeof a.useBrain === 'boolean' ? a.useBrain : s.ai.useBrain },
  };
}

// ───────────── status shown in the app ─────────────

export interface SyncStatus {
  /** rows waiting to be saved */
  pending: number;
  /** files waiting to be uploaded or deleted */
  files: number;
  saving: boolean;
  /** last save or pull failed: offline, or Supabase refused */
  problem: null | 'offline' | 'error';
  message: string | null;
  lastSavedAt: number | null;
}
export const useSyncStatus = create<SyncStatus & { set: (p: Partial<SyncStatus>) => void }>((set) => ({
  pending: 0,
  files: 0,
  saving: false,
  problem: null,
  message: null,
  lastSavedAt: null,
  set: (p) => set(p),
}));

// ───────────── helpers ─────────────

const keyOf = (kind: DocKind, id: string) => `${kind}:${id}`;
const splitKey = (key: string): [DocKind, string] => {
  const i = key.indexOf(':');
  return [key.slice(0, i) as DocKind, key.slice(i + 1)];
};
const isEntity = (d: unknown, id: string): d is Entity => !!d && typeof d === 'object' && (d as Entity).id === id;

/** Split rows into requests of about `limit` characters of JSON (a single big row goes alone). */
export function chunkBySize<T>(rows: T[], size: (r: T) => number, limit = 900_000, maxRows = 200): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let used = 0;
  for (const r of rows) {
    const n = size(r);
    if (cur.length && (used + n > limit || cur.length >= maxRows)) {
      out.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(r);
    used += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

const chunks = <T,>(list: T[], n: number): T[][] => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

function describe(e: unknown): { problem: 'offline' | 'error'; message: string } {
  const msg = String((e as { message?: string })?.message ?? e ?? '');
  const offline = (typeof navigator !== 'undefined' && navigator.onLine === false) || /fetch|network|load failed|timed? ?out/i.test(msg);
  return offline ? { problem: 'offline', message: 'You’re offline. Changes are kept on this device and saved when you’re back.' } : { problem: 'error', message: msg ? `Couldn’t save to your account: ${msg}` : 'Couldn’t save to your account.' };
}

interface Meta {
  /** updated_at of each row as this device last saw it */
  v: Record<string, string>;
  /** rows changed here and not yet saved: 'up' (save) or 'del' (delete) */
  d: Record<string, 'up' | 'del'>;
}

type Store = typeof useStore;

export interface SyncOptions {
  backend: SyncBackend;
  userId: string;
  store?: Store;
  /** wait this long after the last change before saving */
  delay?: number;
  /** how stale a pull may get before saving (or coming back to the tab) pulls again */
  refreshAfter?: number;
  /** this device has no copy of the account: forget any saved-change marks left behind */
  fresh?: boolean;
}

export type Sync = ReturnType<typeof createSync>;

export function createSync({ backend, userId, store = useStore, delay = 1500, refreshAfter = 30_000, fresh = false }: SyncOptions) {
  const metaKey = `ylb-sync:${userId}`;
  const meta: Meta = (() => {
    if (fresh) return { v: {}, d: {} };
    try {
      const m = JSON.parse(safeStorage.getItem(metaKey) || 'null') as Meta | null;
      return m && typeof m.v === 'object' && typeof m.d === 'object' ? m : { v: {}, d: {} };
    } catch {
      return { v: {}, d: {} };
    }
  })();
  const seq = new Map<string, number>();
  let counter = 0;
  let applying = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  let lastPull = 0;
  /** stopped for good (signed out, or another tab took over): never write again */
  let disposed = false;
  let poll: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let removeListeners: (() => void) | null = null;
  // pulls and saves take turns, so neither works from a picture the other is changing
  let queue: Promise<unknown> = Promise.resolve();
  const turn = <T,>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => undefined);
    return p;
  };

  const saveMeta = () => {
    if (disposed) return;
    safeStorage.setItem(metaKey, JSON.stringify(meta));
    useSyncStatus.getState().set({ pending: Object.keys(meta.d).length });
  };
  const mark = (key: string, op: 'up' | 'del') => {
    meta.d[key] = op;
    seq.set(key, ++counter);
  };

  type Snapshot = Record<SliceKey, Entity[]> & { settings: AccountSettings };
  const snapshot = (s: StoreState): Snapshot => {
    const snap = { settings: accountSettings(s.settings) } as Snapshot;
    for (const { slice } of SLICES) snap[slice] = s[slice] as unknown as Entity[];
    return snap;
  };
  let last: Snapshot | null = null;

  /** Mark what changed between two pictures of the store. */
  function diff(prev: Snapshot, next: Snapshot): boolean {
    let changed = false;
    for (const { slice, kind } of SLICES) {
      const a = prev[slice];
      const b = next[slice];
      if (a === b) continue;
      const before = new Map(a.map((e) => [e.id, e]));
      for (const e of b) {
        if (before.get(e.id) !== e) {
          mark(keyOf(kind, e.id), 'up');
          changed = true;
        }
        before.delete(e.id);
      }
      for (const id of before.keys()) {
        mark(keyOf(kind, id), 'del');
        changed = true;
      }
    }
    const x = prev.settings;
    const y = next.settings;
    if (x.profile !== y.profile || x.accounts !== y.accounts || x.useBrain !== y.useBrain || x.shareToCommunity !== y.shareToCommunity) {
      mark(SETTINGS_KEY, 'up');
      changed = true;
    }
    return changed;
  }

  function localKeys(s: StoreState): Set<string> {
    const keys = new Set<string>([SETTINGS_KEY]);
    for (const { slice, kind } of SLICES) for (const e of s[slice] as unknown as Entity[]) keys.add(keyOf(kind, e.id));
    return keys;
  }

  function entityFor(s: StoreState, kind: DocKind, id: string): unknown {
    if (kind === 'settings') return accountSettings(s.settings);
    const def = SLICES.find((x) => x.kind === kind);
    return def ? (s[def.slice] as unknown as Entity[]).find((e) => e.id === id) : undefined;
  }

  /** Put rows from Supabase into the store without counting them as local changes. */
  function apply(rows: DocRow[], removed: string[]) {
    if (disposed) return;
    const s = store.getState();
    const patch: Partial<StoreState> = {};
    // something changed here while the download ran: this device's version wins and is saved next
    rows = rows.filter((r) => !meta.d[keyOf(r.kind, r.id)]);
    const gone = new Set(removed.filter((k) => !meta.d[k]));
    for (const { slice, kind, newestFirst } of SLICES) {
      const incoming = new Map<string, Entity>();
      for (const r of rows) if (r.kind === kind && isEntity(r.data, r.id)) incoming.set(r.id, r.data);
      const list = s[slice] as unknown as Entity[];
      const dropped = list.some((e) => gone.has(keyOf(kind, e.id)));
      if (!incoming.size && !dropped) continue;
      let added = false;
      const next = list
        .filter((e) => !gone.has(keyOf(kind, e.id)))
        .map((e) => {
          const r = incoming.get(e.id);
          if (!r) return e;
          incoming.delete(e.id);
          return r;
        });
      for (const r of incoming.values()) {
        next.push(r);
        added = true;
      }
      if (added) next.sort((a, b) => (newestFirst ? (b.createdAt ?? 0) - (a.createdAt ?? 0) : (a.createdAt ?? 0) - (b.createdAt ?? 0)));
      (patch as Record<string, unknown>)[slice] = next;
    }
    const st = rows.find((r) => r.kind === 'settings' && r.id === 'user');
    if (st?.data && typeof st.data === 'object') patch.settings = withAccountSettings(s.settings, st.data as Partial<AccountSettings>);
    if (patch.projects) {
      const projects = patch.projects;
      if (!projects.some((p) => p.id === s.activeProjectId)) patch.activeProjectId = (projects.find((p) => p.onboarded) ?? projects[0])?.id ?? null;
    }
    if (!Object.keys(patch).length) return;
    applying = true;
    try {
      store.setState(patch);
    } finally {
      applying = false;
    }
    last = snapshot(store.getState());
  }

  /** Bring this device up to date. Returns whether the account had nothing saved yet. */
  const pull = () => turn(pullNow);

  async function pullNow() {
      const all = await backend.index();
      const retired = all.filter((r) => RETIRED_KINDS.includes(r.kind));
      const index = all.filter((r) => KNOWN_KINDS.has(r.kind));
      const remote = new Map(index.map((r) => [keyOf(r.kind, r.id), r.updated_at]));
      const local = localKeys(store.getState());
      const need = new Map<DocKind, string[]>();
      for (const [key, version] of remote) {
        if (meta.d[key]) continue; // changed here too: this device's version is saved next
        if (meta.v[key] !== version || !local.has(key)) {
          const [kind, id] = splitKey(key);
          need.set(kind, [...(need.get(kind) ?? []), id]);
        }
      }
      const removed: string[] = [];
      for (const key of local) {
        if (remote.has(key) || meta.d[key] === 'del') continue;
        if (key !== SETTINGS_KEY && meta.v[key]) {
          // deleted on another device: that wins, even over a change here (say an auto-published post)
          removed.push(key);
          delete meta.d[key];
          seq.delete(key);
        } else if (!meta.d[key]) mark(key, 'up'); // never saved yet
      }
      for (const key of Object.keys(meta.v)) if (!remote.has(key)) delete meta.v[key];
      const rows: DocRow[] = [];
      for (const [kind, ids] of need) for (const part of chunks(ids, 100)) rows.push(...(await backend.fetch(kind, part)));
      apply(rows, removed);
      for (const r of rows) meta.v[keyOf(r.kind, r.id)] = r.updated_at;
      saveMeta();
      lastPull = Date.now();
      if (running && Object.keys(meta.d).length) schedule();
      // rows of retired kinds (pretend orders and sales) leave the account; if that fails, the next pull tries again
      for (const kind of RETIRED_KINDS) {
        const ids = retired.filter((r) => r.kind === kind).map((r) => r.id);
        for (const part of chunks(ids, 100)) await backend.remove(kind, part).catch(() => undefined);
      }
      return { remoteEmpty: all.length === 0, downloaded: rows.length, removed: removed.length };
  }

  /** Save everything waiting. Resolves true when nothing is left to save. */
  const flush = () =>
    turn(async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (disposed) return false;
      if (!Object.keys(meta.d).length) return true;
      const status = useSyncStatus.getState();
      status.set({ saving: true });
      // catch up first, so this device doesn't save over newer changes from another one
      if (Date.now() - lastPull > refreshAfter) {
        try {
          await pullNow();
        } catch (e) {
          status.set({ saving: false, ...describe(e) });
          if (running) {
            retries++;
            schedule(Math.min(60_000, 2000 * 2 ** Math.min(retries, 5)));
          }
          return false;
        }
      }
      const entries = Object.entries(meta.d);
      if (!entries.length) {
        status.set({ saving: false, problem: null, message: null, lastSavedAt: Date.now() });
        return true;
      }
      const at = new Map(entries.map(([key]) => [key, seq.get(key) ?? 0]));
      const done = (key: string) => {
        if ((seq.get(key) ?? 0) === at.get(key)) delete meta.d[key];
      };
      try {
        const s = store.getState();
        const ups: { kind: DocKind; id: string; data: unknown; size: number }[] = [];
        const dels = new Map<DocKind, string[]>();
        for (const [key, op] of entries) {
          const [kind, id] = splitKey(key);
          if (op === 'del') {
            dels.set(kind, [...(dels.get(kind) ?? []), id]);
            continue;
          }
          const data = entityFor(s, kind, id);
          // marked to save but not here (e.g. marks left behind without the workspace): never delete for it
          if (data === undefined) done(key);
          else ups.push({ kind, id, data, size: JSON.stringify(data).length });
        }
        for (const part of chunkBySize(ups, (r) => r.size)) {
          const saved = await backend.upsert(part.map(({ kind, id, data }) => ({ kind, id, data })));
          for (const r of saved) meta.v[keyOf(r.kind, r.id)] = r.updated_at;
          for (const r of part) done(keyOf(r.kind, r.id));
          saveMeta();
        }
        for (const [kind, ids] of dels) {
          for (const part of chunks(ids, 100)) {
            await backend.remove(kind, part);
            for (const id of part) {
              delete meta.v[keyOf(kind, id)];
              done(keyOf(kind, id));
            }
            saveMeta();
          }
        }
        retries = 0;
        status.set({ saving: false, problem: null, message: null, lastSavedAt: Date.now() });
        const left = Object.keys(meta.d).length;
        if (left && running) schedule();
        return left === 0;
      } catch (e) {
        saveMeta();
        status.set({ saving: false, ...describe(e) });
        if (running) {
          retries++;
          schedule(Math.min(60_000, 2000 * 2 ** Math.min(retries, 5)));
        }
        return false;
      }
    });

  function schedule(wait = delay) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, wait);
  }

  /** Start saving changes as they happen (call after the first pull). */
  function start() {
    if (running) return;
    running = true;
    last = snapshot(store.getState());
    unsubscribe = store.subscribe((state) => {
      const next = snapshot(state);
      if (applying || !last) {
        last = next;
        return;
      }
      const changed = diff(last, next);
      last = next;
      if (changed) {
        saveMeta();
        schedule();
      }
    });
    if (typeof window !== 'undefined') {
      const onVisible = () => {
        if (document.visibilityState === 'hidden') void flush();
        else if (Date.now() - lastPull > refreshAfter) void pull().catch(() => undefined);
      };
      const onOnline = () => void pull().catch(() => undefined).then(() => flush());
      const onHide = () => void flush();
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('online', onOnline);
      window.addEventListener('pagehide', onHide);
      // a tab that stays open keeps up with other devices too
      poll = setInterval(() => {
        if (document.visibilityState === 'visible' && Date.now() - lastPull > refreshAfter) void pull().catch(() => undefined);
      }, Math.max(15_000, refreshAfter));
      removeListeners = () => {
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('online', onOnline);
        window.removeEventListener('pagehide', onHide);
      };
    }
    saveMeta();
    if (Object.keys(meta.d).length) schedule(0);
  }

  function stop() {
    running = false;
    unsubscribe?.();
    unsubscribe = null;
    removeListeners?.();
    removeListeners = null;
    if (timer) clearTimeout(timer);
    timer = null;
    if (poll) clearInterval(poll);
    poll = null;
  }

  /** Stop for good: nothing more is saved or written on this device. */
  function dispose() {
    stop();
    disposed = true;
  }

  /** Mark these items to be saved (e.g. starter skills for a new account). */
  function markKeys(kind: DocKind, ids: string[]) {
    for (const id of ids) mark(keyOf(kind, id), 'up');
    saveMeta();
    if (running) schedule();
  }

  /** Treat everything in the store as changed here (after bringing in a workspace from this browser). */
  function markAll() {
    for (const key of localKeys(store.getState())) mark(key, 'up');
    saveMeta();
  }

  return {
    pull,
    flush,
    start,
    stop,
    dispose,
    markAll,
    markKeys,
    pending: () => Object.keys(meta.d).length,
    forget: () => {
      dispose();
      safeStorage.removeItem(metaKey);
    },
  };
}

/** user_docs in Supabase (row-level security keeps each user to their own rows). */
export function supabaseBackend(
  client: {
    from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  },
  userId: string,
): SyncBackend {
  const t = () => client.from('user_docs');
  const check = <T,>(r: { data: T | null; error: { message: string } | null }): T => {
    if (r.error) throw Object.assign(new Error(r.error.message), r.error);
    return (r.data ?? []) as T;
  };
  return {
    async index() {
      const out: DocRow[] = [];
      for (let from = 0; ; from += 1000) {
        const page = check<DocRow[]>(await t().select('kind,id,updated_at').eq('user_id', userId).order('kind').order('id').range(from, from + 999));
        out.push(...page);
        if (page.length < 1000) break;
      }
      return out;
    },
    async fetch(kind, ids) {
      return check<DocRow[]>(await t().select('kind,id,data,updated_at').eq('user_id', userId).eq('kind', kind).in('id', ids));
    },
    async upsert(rows) {
      return check<DocRow[]>(await t().upsert(rows.map((r) => ({ user_id: userId, ...r })), { onConflict: 'user_id,kind,id' }).select('kind,id,updated_at'));
    },
    async remove(kind, ids) {
      check(await t().delete().eq('user_id', userId).eq('kind', kind).in('id', ids));
    },
  };
}
