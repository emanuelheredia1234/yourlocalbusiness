// Where the assistant's listing windows open (mounted once in the app). The windows themselves load the
// first time one opens, so they add next to nothing to the app's first load.

import { lazy, Suspense, useEffect } from 'react';
import { create } from 'zustand';
import { useActiveProject, useStore } from '@/store/useStore';

/** publish: "Publish listing" (shows exactly what goes public) · show / hide: "Show my listings to other people" on or off */
export type ListingWindowAction = 'publish' | 'show' | 'hide';

/** Which listing window is open, and for which project (it closes if the owner switches projects). */
export const useListingWindow = create<{ action: ListingWindowAction | null; projectId: string | null; open: (action: ListingWindowAction) => void; close: () => void }>((set) => ({
  action: null,
  projectId: null,
  open: (action) => set({ action, projectId: useStore.getState().activeProjectId }),
  close: () => set({ action: null, projectId: null }),
}));

/** Open a listing window for the open project (the assistant's host does this for a `listing` window). */
export function openListingWindow(action: ListingWindowAction): boolean {
  if (!useStore.getState().activeProjectId) return false;
  useListingWindow.getState().open(action);
  return true;
}

const ListingWindow = lazy(() => import('./ListingWindow'));

export function ListingWindowHost() {
  const action = useListingWindow((s) => s.action);
  const forProject = useListingWindow((s) => s.projectId);
  const close = useListingWindow((s) => s.close);
  const project = useActiveProject();
  // it belongs to the project it was opened for
  useEffect(() => {
    if (action && project?.id !== forProject) close();
  }, [action, project?.id, forProject, close]);
  if (!action || !project || project.id !== forProject) return null;
  return (
    <Suspense fallback={null}>
      <ListingWindow action={action} project={project} close={close} />
    </Suspense>
  );
}
