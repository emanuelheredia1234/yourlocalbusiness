// Starting and deleting projects outside the pages that do it (the project menu, the command palette,
// Settings › Projects & data, and the assistant), with the same steps each time.

import type { Origin, Track } from './types';
import { navigate } from './router';
import { pushMyListings } from './community';
import { useStore } from '@/store/useStore';
import { newProjectId } from '@/store/defaults';
import { useAnalytics } from '@/store/analytics';
import { useBilling } from '@/store/billing';
import { toast } from '@/store/ui';
import { releaseHeld, useAuth } from '@/lib/cloud/auth';
import { claimSlot, slotMessage, type SlotResult } from '@/lib/cloud/slots';
import { confirmLeave } from '@/components/ui/leave';

// ───────────── business slots ─────────────

/**
 * What the app does when the plan has no slot for a new business: the plan's limit opens Add a business (then
 * `retry` runs), no plan opens #plans, anything else is a toast in our words. Free and owner plans never buy here.
 */
export function slotRefused(r: SlotResult, retry?: () => void | Promise<void>): void {
  const b = useBilling.getState();
  if (r.reason === 'limit') {
    if (b.account?.source === 'stripe' && b.plan?.active) b.openAddBusiness(retry);
    else toast({ kind: 'error', title: slotMessage(r) });
    return;
  }
  if (r.reason === 'plan_required') {
    toast({ kind: 'info', title: 'Choose a plan to add a business.' });
    void navigate('plans', { force: true });
    return;
  }
  toast({ kind: 'error', title: slotMessage(r) });
}

/**
 * Create a project only once the plan has a slot for it: the id is made first, its slot claimed, then the project
 * is created with that id. Resolves to the id, or null when the plan refused (the dialogs say why; `then` runs if the
 * owner adds a business and the project is created after all). Nothing is created without the database's answer.
 */
export async function createProjectWithSlot(track?: Track, origin: Origin = 'new', then?: (id: string) => void): Promise<string | null> {
  const id = newProjectId();
  const make = () => {
    const made = useStore.getState().createProject(track, origin, id);
    then?.(made);
    return made;
  };
  const r = await claimSlot(id);
  if (r.ok) return make();
  slotRefused(r, async () => {
    // a business was just added: the slot is claimed again (the same id), then the project is made
    const again = await claimSlot(id);
    if (again.ok) make();
    else slotRefused(again);
  });
  return null;
}

export type StartResult = { id: string } | { stayed: true } | { refused: string };

/**
 * Start a new project and open its setup, as the project menu's "New project" does: first the leave guard
 * asks when leaving would stop something that's generating, then the plan's business slot is claimed.
 * `track`: the setup's first answer when it's already known (the setup then starts at its next step).
 * `interactive: false` (the assistant): a refused slot only says so; nothing paid opens.
 */
export async function startProject(track?: Track, { interactive = true }: { interactive?: boolean } = {}): Promise<StartResult> {
  if (!(await confirmLeave())) return { stayed: true };
  const open = (id: string) => {
    // what choosing the track on the setup's first step does
    if (track) useStore.getState().updateProject(id, (p) => ({ ...p, track, wizardStep: 'start' }));
    void navigate('onboarding', { force: true });
  };
  if (!interactive) {
    const id = newProjectId();
    const r = await claimSlot(id);
    if (!r.ok) return { refused: r.reason === 'limit' || r.reason === 'plan_required' ? 'Your plan has no free business slot. Add one in Settings › Plan.' : slotMessage(r) };
    useStore.getState().createProject(track ?? 'product', 'new', id);
    open(id);
    return { id };
  }
  const id = await createProjectWithSlot(track ?? undefined, 'new', open);
  return id ? { id } : { refused: 'no slot' };
}

/** startProject for the project menu and the palette: the new id, or null when the owner stayed or the plan refused. */
export async function startNewProject(track?: Track): Promise<string | null> {
  const r = await startProject(track);
  return 'id' in r ? r.id : null;
}

/**
 * Claim slots for projects that have none yet (a backup's), in order, up to the plan's limit. Returns the ids that
 * got one and the ids that didn't (those are set aside by sync until a slot frees up). Ids with a slot already reuse it.
 */
export async function claimSlotsFor(ids: string[]): Promise<{ claimed: string[]; refused: string[]; offline: boolean }> {
  const claimed: string[] = [];
  const refused: string[] = [];
  let offline = false;
  let full = false;
  for (const id of ids) {
    // the plan is full (or the account can't be reached): the rest wait too
    if (full || offline) {
      refused.push(id);
      continue;
    }
    const r = await claimSlot(id);
    if (r.ok) claimed.push(id);
    else {
      refused.push(id);
      if (r.reason === 'offline') offline = true;
      if (r.reason === 'limit' || r.reason === 'plan_required') full = true;
    }
  }
  if (claimed.length) releaseHeld(claimed);
  return { claimed, refused, offline };
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

const isArtifact = () => typeof __ARTIFACT_BUILD__ !== 'undefined' && __ARTIFACT_BUILD__;

/**
 * Read which businesses hold a slot now (another device may have connected one since this one last asked), so a
 * delete or import confirm says what it disconnects. Signed out, or in the artifact, nothing is read.
 */
export async function refreshSocialSlots(): Promise<void> {
  if (isArtifact() || useAuth.getState().phase !== 'ready') return;
  await useAnalytics.getState().refreshConnections().catch(() => undefined);
}

/** socialDeleteNote with the slots read fresh first. */
export async function freshSocialDeleteNote(id: string): Promise<string> {
  await refreshSocialSlots();
  return socialDeleteNote(id);
}

/**
 * Businesses that are gone (deleted here, by a workspace reset or a backup import): their social accounts are
 * disconnected at the posting service and their slots freed. One request per gone business, whatever this device
 * last heard about its slots (the server answers freed: false for one without), never retried (the server's daily
 * check finishes anything left over).
 */
export async function releaseSocialFor(ids: string[]): Promise<void> {
  if (isArtifact() || !ids.length) return;
  // social accounts belong to a signed-in account: signed out, there's nothing of this device's to free
  if (useAuth.getState().phase !== 'ready') return;
  // social posting is off on this server: there's nothing to free
  const a = useAnalytics.getState();
  if (a.connectionsLoaded && !a.socialEnabled && !a.slots) return;
  for (const id of ids) await useAnalytics.getState().releaseBusiness(id);
}
