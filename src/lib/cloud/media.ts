// Mirrors the signed-in user's files (uploads, AI photos and videos, product PDFs and spreadsheets)
// to their private folder in Supabase Storage: media/<user id>/<file id>.
// Uploads and deletions wait in a queue that survives reloads; files from other devices download
// the first time they're shown.

import { getLocalBlob, type MediaCloud } from '@/lib/storage';
import { safeStorage } from '@/lib/storage';
import { useSyncStatus } from './sync';

const BUCKET = 'media';
/** the bucket's per-file limit (supabase/migrations) */
export const CLOUD_FILE_LIMIT = 50 * 1024 * 1024;

interface StorageApi {
  storage: {
    from: (bucket: string) => {
      upload: (path: string, body: Blob, opts: { upsert: boolean; contentType?: string }) => Promise<{ error: { message: string } | null }>;
      download: (path: string) => Promise<{ data: Blob | null; error: { message: string; status?: number; statusCode?: string | number } | null }>;
      remove: (paths: string[]) => Promise<{ error: { message: string } | null }>;
      list: (prefix: string, opts: { limit: number; offset: number }) => Promise<{ data: { name: string }[] | null; error: { message: string } | null }>;
    };
  };
}

export type MediaSync = MediaCloud & {
  start(): void;
  stop(): void;
  pending(): number;
  /** wait until the queue is empty (or the time is up); true when everything is saved */
  settle(timeoutMs: number): Promise<boolean>;
  forget(): void;
};

export function createMediaSync(client: StorageApi, userId: string): MediaSync {
  const qKey = `ylb-media-sync:${userId}`;
  const path = (id: string) => `${userId}/${id}`;
  const bucket = () => client.storage.from(BUCKET);
  const q: { up: string[]; del: string[] } = (() => {
    try {
      const v = JSON.parse(safeStorage.getItem(qKey) || 'null');
      return v && Array.isArray(v.up) && Array.isArray(v.del) ? v : { up: [], del: [] };
    } catch {
      return { up: [], del: [] };
    }
  })();
  const save = () => {
    safeStorage.setItem(qKey, JSON.stringify(q));
    useSyncStatus.getState().set({ files: q.up.length + q.del.length });
  };
  /** files Supabase doesn't have, with when we last asked */
  const missing = new Map<string, number>();
  const downloads = new Map<string, Promise<Blob | null>>();
  let running = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  const waiters = new Set<() => void>();

  const pending = () => q.up.length + q.del.length;
  const report = () => {
    if (!pending()) for (const w of [...waiters]) w();
  };

  function kick(wait = 300) {
    if (!running || busy) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void work();
    }, wait);
  }

  async function work() {
    if (busy || !running) return;
    busy = true;
    try {
      while (running && pending()) {
        if (q.del.length) {
          const part = q.del.slice(0, 100);
          const { error } = await bucket().remove(part.map(path));
          if (error) throw new Error(error.message);
          q.del = q.del.filter((id) => !part.includes(id));
          save();
          continue;
        }
        const id = q.up[0];
        const blob = await getLocalBlob(id);
        if (blob && blob.size <= CLOUD_FILE_LIMIT) {
          const { error } = await bucket().upload(path(id), blob, { upsert: true, contentType: blob.type || undefined });
          if (error) throw new Error(error.message);
          missing.delete(id);
        }
        // gone meanwhile, or too big for the account (it stays on this device)
        q.up = q.up.filter((x) => x !== id);
        save();
      }
      retries = 0;
      if (useSyncStatus.getState().problem && !useSyncStatus.getState().saving) useSyncStatus.getState().set({ problem: null, message: null });
    } catch (e) {
      retries++;
      const msg = String((e as Error)?.message ?? e);
      const offline = (typeof navigator !== 'undefined' && navigator.onLine === false) || /fetch|network|load failed/i.test(msg);
      useSyncStatus.getState().set(offline ? { problem: 'offline', message: 'You’re offline. Your files are kept on this device and saved when you’re back.' } : { problem: 'error', message: `Couldn’t save a file to your account: ${msg}` });
      busy = false;
      kick(Math.min(60_000, 2000 * 2 ** Math.min(retries, 5)));
      return;
    }
    busy = false;
    report();
  }

  return {
    upload(id) {
      if (!q.up.includes(id)) q.up.push(id);
      q.del = q.del.filter((x) => x !== id);
      save();
      kick();
    },
    remove(id) {
      q.up = q.up.filter((x) => x !== id);
      if (!q.del.includes(id)) q.del.push(id);
      save();
      kick();
    },
    async download(id) {
      if (q.del.includes(id)) return null;
      const asked = missing.get(id);
      if (asked && Date.now() - asked < 60_000) return null;
      let p = downloads.get(id);
      if (!p) {
        p = bucket()
          .download(path(id))
          .then(({ data, error }) => {
            if (error || !data) {
              missing.set(id, Date.now());
              return null;
            }
            return data;
          })
          .catch(() => {
            missing.set(id, Date.now());
            return null;
          })
          .finally(() => downloads.delete(id));
        downloads.set(id, p);
      }
      return p;
    },
    clear() {
      q.up = [];
      q.del = [];
      save();
      // everything in the folder, a page at a time
      void (async () => {
        for (let round = 0; round < 50; round++) {
          const { data, error } = await bucket().list(userId, { limit: 1000, offset: 0 });
          if (error || !data?.length) return;
          await bucket().remove(data.map((f) => path(f.name)));
          if (data.length < 1000) return;
        }
      })().catch(() => undefined);
    },
    start() {
      running = true;
      save();
      kick(0);
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    pending,
    settle(timeoutMs) {
      if (!pending()) return Promise.resolve(true);
      kick(0);
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(t);
          waiters.delete(done);
          resolve(true);
        };
        const t = setTimeout(() => {
          waiters.delete(done);
          resolve(!pending());
        }, timeoutMs);
        waiters.add(done);
      });
    },
    forget() {
      safeStorage.removeItem(qKey);
    },
  };
}
