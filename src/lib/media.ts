import { useEffect, useState } from 'react';
import type { MediaRef } from './types';
import { getBlob } from './storage';
import { readFileAsDataURL } from './utils';

const urlCache = new Map<string, string>();

/** Object URL for a stored upload (IndexedDB), falling back to its thumbnail. */
export function useMediaUrl(ref: MediaRef | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(() => (ref ? urlCache.get(ref.id) ?? ref.thumb ?? null : null));
  useEffect(() => {
    let alive = true;
    if (!ref) {
      setUrl(null);
      return;
    }
    const cached = urlCache.get(ref.id);
    if (cached) {
      setUrl(cached);
      return;
    }
    setUrl(ref.thumb ?? null);
    getBlob(ref.id).then(async (blob) => {
      if (!alive || !blob) return;
      // Inside the claude.ai viewer, images and videos use data: URLs (always allowed there); elsewhere object URLs.
      const u = __ARTIFACT_BUILD__ && blob.size < 12 * 1024 * 1024 ? await readFileAsDataURL(blob).catch(() => URL.createObjectURL(blob)) : URL.createObjectURL(blob);
      urlCache.set(ref.id, u);
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [ref?.id, ref?.thumb]);
  return url;
}
