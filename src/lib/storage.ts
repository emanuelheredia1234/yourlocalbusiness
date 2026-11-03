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

/** Signed in: each account keeps its media in its own database on this device, mirrored to its cloud folder. */
export interface MediaCloud {
  /** save a stored file to the account (queued) */
  upload(id: string): void;
  /** fetch a file this device doesn't have */
  download(id: string): Promise<Blob | null>;
  /** delete it from the account (queued) */
  remove(id: string): void;
  /** delete every file in the account */
  clear(): void;
}
let namespace: string | null = null;
let cloud: MediaCloud | null = null;
const dbNameFor = (ns: string | null) => (ns ? `${DB_NAME}:${ns}` : DB_NAME);

/** Switch whose media this device reads and writes (null: the browser's own, without an account). */
export function setMediaAccount(ns: string | null, hooks: MediaCloud | null): void {
  void dbPromise?.then((db) => db?.close());
  namespace = ns;
  cloud = hooks;
  memBlobs.clear();
  dbPromise = null;
}

/** Signed in: files are also saved to the account, whose per-file limit is 50 MB. */
export const CLOUD_FILE_LIMIT = 50 * 1024 * 1024;
export const hasMediaCloud = () => !!cloud;

function openNamedDb(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        // let a deletion (on log out) go through instead of waiting on this connection
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) dbPromise = openNamedDb(dbNameFor(namespace));
  return dbPromise;
}

async function writeBlob(db: IDBDatabase | null, id: string, blob: Blob): Promise<void> {
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

export async function putBlob(id: string, blob: Blob): Promise<void> {
  memBlobs.set(id, blob);
  await writeBlob(await openDb(), id, blob);
  cloud?.upload(id);
}

/** This device's copy only (never downloads). */
export async function getLocalBlob(id: string): Promise<Blob | null> {
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

export async function getBlob(id: string): Promise<Blob | null> {
  const local = await getLocalBlob(id);
  if (local || !cloud) return local;
  // saved from another device: download it once and keep a copy here
  const hooks = cloud;
  const ns = namespace;
  const remote = await hooks.download(id).catch(() => null);
  if (remote && ns === namespace) {
    memBlobs.set(id, remote);
    await writeBlob(await openDb(), id, remote);
  }
  return remote;
}

export async function deleteBlob(id: string): Promise<void> {
  memBlobs.delete(id);
  cloud?.remove(id);
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
  cloud?.clear();
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
  } catch {
    /* ignore */
  }
}

/** Every file in the browser's own media store (from before accounts), for bringing it into an account. */
export async function readBrowserMedia(): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>();
  const db = await openNamedDb(DB_NAME);
  if (!db) return out;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve();
        if (c.value instanceof Blob) out.set(String(c.key), c.value);
        c.continue();
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
  return out;
}

/** Delete a media database from this device: an account's (on sign-out) or the browser's own (null). */
export function deleteMediaDatabase(ns: string | null): Promise<void> {
  if (ns === namespace) {
    memBlobs.clear();
    void dbPromise?.then((db) => db?.close());
    dbPromise = null;
  }
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve();
      const req = indexedDB.deleteDatabase(dbNameFor(ns));
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

/** Persist an uploaded file and return a lightweight reference with a preview thumbnail. */
export async function saveMediaFile(file: File): Promise<MediaRef> {
  const isVideo = file.type.startsWith('video/');
  if (!isVideo && !file.type.startsWith('image/')) throw new Error('Choose an image or video file.');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('That file is over 60 MB. Try a shorter clip or a smaller image.');
  if (cloud && file.size > CLOUD_FILE_LIMIT) throw new Error('That file is over 50 MB, the most your account can save. Try a shorter clip or a smaller image.');
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
