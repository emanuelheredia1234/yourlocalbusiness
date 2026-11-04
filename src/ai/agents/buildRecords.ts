// The builds Manus and Viktor are doing for a project (project.agentBuilds, synced with the project), as plain
// store reads and writes. A write happens only when something in the build really changes: checking on a build
// every few seconds must not save the whole project (which may hold a 1.5 MB page) each time.

import type { AgentBuild, BuildState } from '@/lib/agentTypes';
import type { Project } from '@/lib/types';
import { useStore } from '@/store/useStore';

/** The most builds kept per project (the oldest finished ones go first). */
export const MAX_BUILDS = 20;

/** States in which the app is still waiting on the agent (or on its own send). */
export const IN_FLIGHT: ReadonlySet<BuildState> = new Set<BuildState>(['sending', 'unknown_start', 'working', 'needs_you']);

const projectOf = (projectId: string): Project | undefined => useStore.getState().projects.find((p) => p.id === projectId);

/** A project's builds, newest first. */
export const buildsOf = (projectId: string): AgentBuild[] => projectOf(projectId)?.agentBuilds ?? [];

/** One build, as it is now. */
export const findBuild = (projectId: string, id: string): AgentBuild | undefined => buildsOf(projectId).find((b) => b.id === id);

const setBuilds = (projectId: string, fn: (list: AgentBuild[]) => AgentBuild[]) => useStore.getState().updateProject(projectId, (p) => ({ ...p, agentBuilds: fn(p.agentBuilds ?? []) }));

/** Which build to drop first when there are too many: one that's done with (used, failed, stopped), then a built one, never one in flight. */
const dropRank = (b: AgentBuild) => (b.state === 'imported' || b.state === 'failed' || b.state === 'stopped' ? 0 : b.state === 'built' ? 1 : 2);

/** The list with at most MAX_BUILDS: the oldest builds that are done with go first. */
export function capBuilds(list: AgentBuild[]): AgentBuild[] {
  if (list.length <= MAX_BUILDS) return list;
  const out = [...list];
  while (out.length > MAX_BUILDS) {
    let drop = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (dropRank(out[i]) === 2) continue;
      if (drop === -1 || dropRank(out[i]) < dropRank(out[drop])) drop = i;
    }
    if (drop === -1) break;
    out.splice(drop, 1);
  }
  return out;
}

/** A new build, first in the list. */
export function addBuild(projectId: string, build: AgentBuild): void {
  setBuilds(projectId, (list) => capBuilds([build, ...list.filter((b) => b.id !== build.id)]));
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Change a build: only the fields given, and only when one of them differs from what's saved (a field set to
 * undefined is removed). Returns the build as it is after, or undefined when it's gone.
 */
export function patchBuild(projectId: string, id: string, patch: Partial<AgentBuild>): AgentBuild | undefined {
  const now = findBuild(projectId, id);
  if (!now) return undefined;
  const changed = (Object.keys(patch) as (keyof AgentBuild)[]).some((k) => !same(now[k], patch[k]));
  if (!changed) return now;
  setBuilds(projectId, (list) =>
    list.map((b) => {
      if (b.id !== id) return b;
      const next = { ...b, ...patch } as AgentBuild;
      for (const k of Object.keys(patch) as (keyof AgentBuild)[]) if (patch[k] === undefined) delete next[k];
      return next;
    }),
  );
  return findBuild(projectId, id);
}

/** Take a build off the list (Dismiss). Nothing is sent to Manus or Slack. */
export function removeBuild(projectId: string, id: string): void {
  if (!findBuild(projectId, id)) return;
  setBuilds(projectId, (list) => list.filter((b) => b.id !== id));
}

/** The page of a build was used: as an asset, or as the SEO page. */
export function markImported(projectId: string, id: string, imported: NonNullable<AgentBuild['imported']>): AgentBuild | undefined {
  return patchBuild(projectId, id, { state: 'imported', imported, message: undefined });
}
