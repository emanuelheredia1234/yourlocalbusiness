// The listing's words: the AI's listing copy applied the way Studio → Listing & publish applies it, and
// changes to one project's listing draft. Shared by that tab and the assistant.

import type { ListingDraft } from '@/lib/types';
import { useStore } from '@/store/useStore';
import { updateStudioOf } from './structure';

const activeId = () => useStore.getState().activeProjectId ?? '';

/** Change the listing draft of a project (the open one by default). */
export function patchListingDraft(patch: Partial<ListingDraft>, projectId = activeId()): void {
  updateStudioOf(projectId, (s) => ({ listing: { ...s.listing, ...patch } }));
}

/**
 * The AI's listing copy replaces the title, tagline, description, category and search tags; an empty
 * category or tag list keeps yours. How customers buy, hours, links, contact details and images stay.
 */
export function applyListingCopy(r: Pick<ListingDraft, 'title' | 'tagline' | 'description' | 'category' | 'tags'>, projectId = activeId()): void {
  updateStudioOf(projectId, (s) => ({ listing: { ...s.listing, title: r.title, tagline: r.tagline, description: r.description, category: r.category || s.listing.category, tags: r.tags.length ? r.tags : s.listing.tags } }));
}
