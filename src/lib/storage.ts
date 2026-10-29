import type { MediaRef } from './types';
import { resizeImage, uid, videoFrame } from './utils';

// ───────────────────────── localStorage (guarded) ─────────────────────────
// Storage can be missing or throw (private windows, blocked site data, previews),
// so every access is wrapped and falls back to an in-memory map.

const memory = new Map<string, string>();

export const safeStorage = {
  getItem(key: string): string | null {
    try {
      const v = window.localStorage.getItem(key);
      return v ?? memory.get(key) ?? null;
    } catch {
      return memory.get(key) ?? null;
    }
  },
  setItem(key: string, value: string): void {
    memory.set(key, value);
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* quota or blocked — memory copy keeps the session working */
    }
  },
  removeItem(key: string): void {
    memory.delete(key);
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export function storageAvailable(): boolean {
  try {
    const k = '__ylb_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────── IndexedDB media store ─────────────────────────
// Uploaded images/videos can be megabytes, far beyond localStorage quotas,
// so blobs live in IndexedDB and the project only keeps a small MediaRef.

const DB_NAME = 'yourlocalbusiness-media';
const STORE = 'blobs';
const memBlobs = new Map<string, Blob>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

export async function putBlob(id: string, blob: Blob): Promise<void> {
  memBlobs.set(id, blob);
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function getBlob(id: string): Promise<Blob | null> {
  const mem = memBlobs.get(id);
  if (mem) return mem;
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => {
        const v = req.result as Blob | undefined;
        if (v) memBlobs.set(id, v);
        resolve(v ?? null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function deleteBlob(id: string): Promise<void> {
  memBlobs.delete(id);
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
  } catch {
    /* ignore */
  }
}

export async function clearBlobs(): Promise<void> {
  memBlobs.clear();
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
  } catch {
    /* ignore */
  }
}

export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

/** Persist an uploaded file and return a lightweight reference with a preview thumbnail. */
export async function saveMediaFile(file: File): Promise<MediaRef> {
  const isVideo = file.type.startsWith('video/');
  if (!isVideo && !file.type.startsWith('image/')) throw new Error('Choose an image or video file.');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('That file is over 60 MB. Try a shorter clip or a smaller image.');
  const id = uid('media');
  let thumb = '';
  let w: number | undefined;
  let h: number | undefined;
  if (isVideo) {
    const frame = await videoFrame(file, 0.8, 360);
    thumb = frame.dataUrl;
    w = frame.w;
    h = frame.h;
  } else {
    const r = await resizeImage(file, 360, 'image/jpeg', 0.76);
    thumb = r.dataUrl;
    w = r.w;
    h = r.h;
  }
  await putBlob(id, file);
  return {
    id,
    kind: isVideo ? 'video' : 'image',
    name: file.name,
    mime: file.type,
    size: file.size,
    createdAt: Date.now(),
    w,
    h,
    thumb,
  };
}
