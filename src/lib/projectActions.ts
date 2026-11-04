// Starting and deleting projects outside the pages that do it (the project menu, the command palette,
// Settings → Projects & data, and the assistant), with the same steps each time.

import type { Track } from './types';
import { navigate } from './router';
import { pushMyListings } from './community';
import { useStore } from '@/store/useStore';
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

/** Delete a project with its posts, campaigns and listing, and take the listing off the shared Marketplace. */
export function deleteProjectEverywhere(id: string): void {
  useStore.getState().deleteProject(id);
  void pushMyListings();
}
