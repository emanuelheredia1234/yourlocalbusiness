// Changing the brand kit outside the Settings page (the assistant), the way Settings → Brand does it:
// the active project's brand changes, and when it's listed on the Marketplace its shared listing is
// brought up to date. A brand-copy refresh rewrites only the words: name, logo and colors are kept.

import type { Brand } from './types';
import type { BrandKitResult } from '@/ai/local/brand';
import { useStore } from '@/store/useStore';
import { pushMyListings } from './community';

/** Change the active project's brand (and re-share its Marketplace listing when it's listed). */
export function saveBrand(patch: Partial<Brand>): void {
  const s = useStore.getState();
  s.updateBrand(patch);
  if (s.activeProjectId && useStore.getState().myListings.some((l) => l.projectId === s.activeProjectId)) void pushMyListings();
}

/** What "Refresh brand copy" writes from a brand kit: the copy and name ideas (name, logo and colors are kept). */
export function brandCopyFrom(r: BrandKitResult): Pick<Brand, 'tagline' | 'pitch' | 'valueProp' | 'audience' | 'personality' | 'mission' | 'nameOptions' | 'domainIdeas'> {
  return { tagline: r.tagline, pitch: r.pitch, valueProp: r.valueProp, audience: r.audience, personality: r.personality, mission: r.mission, nameOptions: r.nameOptions, domainIdeas: r.domainIdeas };
}
