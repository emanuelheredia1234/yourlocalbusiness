import { useEffect, useState } from 'react';
import type { MediaRef } from './types';
import { getBlob, hasMediaCloud } from './storage';
import { readFileAsDataURL } from './utils';

const urlCache = new Map<string, string>();

/** A photo you added yourself (not made with AI). It posts exactly as it is: no style, headline or watermark goes on it. */
export const isOwnPhoto = (m: MediaRef | null | undefined): boolean => m?.kind === 'image' && !m.generated;

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
    let timer: ReturnType<typeof setTimeout> | null = null;
    let tries = 0;
    const load = () =>
      getBlob(ref.id).then(async (blob) => {
      if (!alive) return;
      if (!blob) {
        // saved on another device and maybe still uploading: look again a little later
        if (hasMediaCloud() && tries < 3) timer = setTimeout(load, [20_000, 70_000, 180_000][tries++]);
        return;
      }
      // Inside the claude.ai viewer, images and videos use data: URLs (always allowed there); elsewhere object URLs.
      const u = __ARTIFACT_BUILD__ && blob.size < 12 * 1024 * 1024 ? await readFileAsDataURL(blob).catch(() => URL.createObjectURL(blob)) : URL.createObjectURL(blob);
      urlCache.set(ref.id, u);
      if (alive) setUrl(u);
    });
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [ref?.id, ref?.thumb]);
  return url;
}
