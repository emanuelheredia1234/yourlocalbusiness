// The web address and handle the app shows for a brand: only what the owner entered. Nothing here
// makes up a domain or a handle from the brand name; with neither, the brand name is the mark.

import type { Brand, SocialPlatform } from './types';
import { stripProtocol } from './utils';

/** The owner's website as people read it ("sparkle.co"), or '' when they haven't added one. */
export function websiteHost(brand: Pick<Brand, 'websiteUrl'>): string {
  return stripProtocol((brand.websiteUrl ?? '').trim());
}

/** Networks where an @handle is how people find you, in the order a watermark prefers them. */
const HANDLE_NETWORKS: SocialPlatform[] = ['instagram', 'tiktok', 'x'];

/** The owner's own @handle from what they typed ("@sparkle", "instagram.com/sparkle"), or '' when there is none. */
export function brandHandle(brand: Pick<Brand, 'socials'>, networks: SocialPlatform[] = HANDLE_NETWORKS): string {
  for (const n of networks) {
    const raw = (brand.socials?.[n] ?? '').trim();
    if (!raw) continue;
    const h = raw
      .replace(/^https?:\/\//i, '')
      .replace(/^(www\.)?(instagram|tiktok|x|twitter)\.com\//i, '')
      .replace(/^@/, '')
      .replace(/[/?#].*$/, '');
    if (/^[A-Za-z0-9._]{1,30}$/.test(h)) return `@${h}`;
  }
  return '';
}

/** The small mark on images and previews: the owner's website, else their @handle, else the brand name. */
export function brandMark(brand: Pick<Brand, 'websiteUrl' | 'socials' | 'name'>): string {
  return websiteHost(brand) || brandHandle(brand) || (brand.name ?? '').trim();
}
