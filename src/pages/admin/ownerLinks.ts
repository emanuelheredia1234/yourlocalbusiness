// The owner's sections on the Customer usage page (route admin-billing), reachable from Settings › Owner: each has
// an element id on that page, and a link asks the page to scroll to it once it has drawn (the request is taken once).

import { navigate } from '@/lib/router';

export type OwnerSection = 'overview' | 'plans' | 'ad-limits';

/** The element id of each section on the Customer usage page. */
export const OWNER_SECTION_ID: Record<OwnerSection, string> = {
  overview: 'owner-billing-overview',
  plans: 'owner-plans',
  'ad-limits': 'owner-ad-limits',
};

let pending: OwnerSection | null = null;

/** Open Customer usage at a section. */
export function openOwnerSection(section: OwnerSection): Promise<boolean> {
  pending = section;
  return navigate('admin-billing');
}

/** The section a link asked for (once), or null. */
export function takeOwnerSection(): OwnerSection | null {
  const s = pending;
  pending = null;
  return s;
}

/** Scroll the page to a section (no-op when it isn't drawn). */
export function scrollToOwnerSection(section: OwnerSection): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.getElementById(OWNER_SECTION_ID[section]);
  if (!el) return false;
  try {
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  } catch {
    el.scrollIntoView();
  }
  return true;
}
