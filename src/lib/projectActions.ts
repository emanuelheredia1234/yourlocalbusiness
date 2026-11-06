// Starting and deleting projects outside the pages that do it (the project menu, the command palette,
// Settings › Projects & data, and the assistant), with the same steps each time.

import type { Track } from './types';
import { navigate } from './router';
import { pushMyListings } from './community';
import { useStore } from '@/store/useStore';
import { useAnalytics } from '@/store/analytics';
import { useAuth } from '@/lib/cloud/auth';
import { confirmLeave } from '@/components/ui/leave';

/**
 * Start a new project and open its setup, as the project menu's "New project" does: first the leave guard
 * asks when leaving would stop something that's generating. `track`: the setup's first answer when it's
 * already known (the setup then starts at its next step). Resolves to the new project's id, or null when
 * the owner chose to stay.
 */
export async function startNewProject(track?: Track): Promise<string | null> {
  if (!(await confirmLeave())) return null;
  const s = useStore.getState();
  const id = track ? s.createProject(track, 'new') : s.createProject();
  // what choosing the track on the setup's first step does
  if (track) s.updateProject(id, (p) => ({ ...p, track, wizardStep: 'start' }));
  void navigate('onboarding', { force: true });
  return id;
}

/**
 * Delete a project with its posts, campaigns and listing, take the listing off the shared Marketplace, and
 * disconnect its social accounts (each business has its own; this frees its business slot).
 */
export function deleteProjectEverywhere(id: string): void {
  useStore.getState().deleteProject(id);
  void pushMyListings();
  void releaseSocialFor([id]);
}

/** Whether a business has social accounts (holds one of the user's business slots), as the server last said. */
export function holdsSocialSlot(id: string): boolean {
  return !!useAnalytics.getState().slots?.projects.includes(id);
}

/** The sentence a delete confirm adds for a business with social accounts (empty for one without). */
export const socialDeleteNote = (id: string): string => (holdsSocialSlot(id) ? ' Its connected social accounts are disconnected too, which frees one of your business slots.' : '');

/**
 * Businesses that are gone (deleted here, by a workspace reset or a backup import): their social accounts are
 * disconnected at the posting service and their slots freed. One request per business that holds a slot, never
 * retried (the server's daily check finishes anything left over).
 */
export async function releaseSocialFor(ids: string[]): Promise<void> {
  if ((typeof __ARTIFACT_BUILD__ !== 'undefined' && __ARTIFACT_BUILD__) || !ids.length) return;
  // social accounts belong to a signed-in account: signed out, there's nothing of this device's to free
  if (useAuth.getState().phase !== 'ready') return;
  const analytics = useAnalytics.getState();
  // which businesses hold a slot: the last answer, or one read now
  if (!analytics.slots) await analytics.refreshConnections().catch(() => undefined);
  const slots = useAnalytics.getState().slots;
  if (!slots) return;
  for (const id of ids.filter((x) => slots.projects.includes(x))) await useAnalytics.getState().releaseBusiness(id);
}
