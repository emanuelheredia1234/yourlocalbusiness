// Mirrors the signed-in user's files (uploads, AI photos and videos, product PDFs and spreadsheets)
// to their private folder in Supabase Storage: media/<user id>/<file id>.
// Uploads and deletions wait in a queue that survives reloads; files from other devices download
// the first time they're shown.

import { CLOUD_FILE_LIMIT as LIMIT, getBlob, getLocalBlob, putBlob, type MediaCloud } from '@/lib/storage';
import { safeStorage } from '@/lib/storage';
import { useSyncStatus } from './sync';

const BUCKET = 'media';
/** the bucket's per-file limit (supabase/migrations) */
export const CLOUD_FILE_LIMIT = LIMIT;

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
  /** stop, and wait for an upload that's under way */
  stop(): Promise<void>;
  pending(): number;
  /** wait until the queue is empty (or the time is up); true when everything is saved */
  settle(timeoutMs: number): Promise<boolean>;
  settleFile(id: string, timeoutMs: number): Promise<boolean>;
  forget(): void;
  /** stop for good without forgetting the queue (another tab takes over) */
  dispose(): void;
};

/** The signed-in account's file sync (the latest one started), for ensureUploaded. */
let active: MediaSync | null = null;

export function createMediaSync(client: StorageApi, userId: string): MediaSync {
  const qKey = `ylb-media-sync:${userId}`;
  const path = (id: string) => `${userId}/${id}`;
  const bucket = () => client.storage.from(BUCKET);
  // big: files too large for the account (kept on this device only; they count as not saved)
  const q: { up: string[]; del: string[]; big: string[] } = (() => {
    try {
      const v = JSON.parse(safeStorage.getItem(qKey) || 'null');
      return v && Array.isArray(v.up) && Array.isArray(v.del) ? { up: v.up, del: v.del, big: Array.isArray(v.big) ? v.big : [] } : { up: [], del: [], big: [] };
    } catch {
      return { up: [], del: [], big: [] };
    }
  })();
  let disposed = false;
  let current: Promise<void> | null = null;
  let ownProblem = false;
  const save = () => {
    if (disposed) return;
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

  const pending = () => q.up.length + q.del.length + q.big.length;
  const report = () => {
    if (!q.up.length && !q.del.length) for (const w of [...waiters]) w();
  };

  function kick(wait = 300) {
    if (!running || busy) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      current = work().finally(() => (current = null));
    }, wait);
  }

  async function work() {
    if (busy || !running) return;
    busy = true;
    try {
      while (running && (q.up.length || q.del.length)) {
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
        } else if (blob && !q.big.includes(id)) q.big.push(id); // too big for the account: stays on this device
        q.up = q.up.filter((x) => x !== id);
        save();
      }
      retries = 0;
      if (ownProblem) {
        ownProblem = false;
        useSyncStatus.getState().set({ problem: null, message: null });
      }
    } catch (e) {
      retries++;
      const msg = String((e as Error)?.message ?? e);
      const offline = (typeof navigator !== 'undefined' && navigator.onLine === false) || /fetch|network|load failed/i.test(msg);
      ownProblem = true;
      useSyncStatus.getState().set(offline ? { problem: 'offline', message: 'You’re offline. Your files are kept on this device and saved when you’re back.' } : { problem: 'error', message: `Couldn’t save a file to your account: ${msg}` });
      busy = false;
      kick(Math.min(60_000, 2000 * 2 ** Math.min(retries, 5)));
      return;
    }
    busy = false;
    report();
  }

  const api: MediaSync = {
    upload(id) {
      if (!q.up.includes(id)) q.up.push(id);
      q.del = q.del.filter((x) => x !== id);
      save();
      kick();
    },
    remove(id) {
      q.up = q.up.filter((x) => x !== id);
      q.big = q.big.filter((x) => x !== id);
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
      q.big = [];
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
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      await current?.catch(() => undefined);
    },
    pending,
    /** Wait until this one file has reached the account (true), or can't (too big, or time's up). */
    settleFile(id, timeoutMs) {
      const waiting = () => q.up.includes(id);
      if (q.big.includes(id)) return Promise.resolve(false);
      if (!waiting()) return Promise.resolve(true);
      kick(0);
      return new Promise((resolve) => {
        const started = Date.now();
        const tick = setInterval(() => {
          if (!waiting()) {
            clearInterval(tick);
            resolve(!q.big.includes(id));
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(tick);
            resolve(false);
          }
        }, 500);
      });
    },
    settle(timeoutMs) {
      if (q.big.length) return Promise.resolve(false); // some files can only stay on this device
      if (!pending()) return Promise.resolve(true);
      kick(0);
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(t);
          waiters.delete(done);
          resolve(!q.big.length);
        };
        const t = setTimeout(() => {
          waiters.delete(done);
          resolve(!pending());
        }, timeoutMs);
        waiters.add(done);
      });
    },
    dispose() {
      disposed = true;
      if (active === api) active = null;
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    forget() {
      disposed = true;
      running = false;
      if (active === api) active = null;
      safeStorage.removeItem(qKey);
    },
  };
  active = api;
  return api;
}

/**
 * Before the app posts a file through your connected account: make sure it's in your account's storage (the
 * server reads it from there). Saves it now if it's waiting, and waits for this one file only. False when
 * signed out, when the file is too big for the account or isn't on this device, or when time's up.
 */
export async function ensureUploaded(mediaId: string, timeoutMs = 120_000): Promise<boolean> {
  const sync = active;
  if (!sync || !/^[A-Za-z0-9_-]{1,80}$/.test(mediaId)) return false;
  const blob = await getLocalBlob(mediaId);
  if (blob) {
    if (blob.size > CLOUD_FILE_LIMIT) return false;
    // upsert: saving a file that's already there again is harmless
    sync.upload(mediaId);
  }
  return sync.settleFile(mediaId, timeoutMs);
}

/** The id of a post image's JPEG copy (Instagram takes JPEG only). */
export const jpegVariantId = (mediaId: string) => `${mediaId.slice(0, 75)}-jpg`;

/**
 * Instagram takes JPEG images only: a JPEG copy of the image, saved as its own file next to it (the original is
 * kept). Returns the id to post: the original when it's already a JPEG, the copy otherwise, or null when the
 * image isn't available or can't be converted in this browser.
 */
export async function ensureJpegVariant(mediaId: string, mime?: string): Promise<string | null> {
  if (/^image\/jpe?g$/i.test(mime ?? '')) return mediaId;
  const id = jpegVariantId(mediaId);
  if (await getLocalBlob(id)) return id;
  const blob = await getBlob(mediaId);
  if (!blob) return null;
  if (/^image\/jpe?g$/i.test(blob.type)) return mediaId;
  const jpeg = await toJpeg(blob);
  if (!jpeg) return null;
  await putBlob(id, jpeg);
  return id;
}

async function toJpeg(blob: Blob): Promise<Blob | null> {
  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  try {
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // JPEG has no transparency: transparent parts become white, not black
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    return await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9));
  } catch {
    return null;
  }
}
