// What AI does in the app, grouped the way Settings → AI shows it. Each API key on your server
// powers some of these functions; every AI task belongs to exactly one.

import catalog from '../../shared/ai-functions.json';
import { useRuntime, type AIServerProvider } from '@/lib/platform';

export type AIKind = 'text' | 'image' | 'video' | 'agent';

export interface AIFunction {
  id: string;
  label: string;
  group: string;
  kind: AIKind;
  desc: string;
  tasks: string[];
}

export const AI_FUNCTIONS = catalog.functions as AIFunction[];
export const AI_FUNCTION_GROUPS = catalog.groups as { id: string; label: string }[];

const byId = new Map(AI_FUNCTIONS.map((f) => [f.id, f]));
const byTask = new Map(AI_FUNCTIONS.flatMap((f) => f.tasks.map((t) => [t, f] as const)));

export function aiFunction(id: string): AIFunction | undefined {
  return byId.get(id);
}

/** The function an AI task belongs to (e.g. "productIdeas" → Product research). */
export function functionForTask(taskId: string): AIFunction | undefined {
  return byTask.get(taskId);
}

/** The keys that power a function on your server, in priority order (empty: none). */
export function routeFor(fnId: string): string[] {
  return useRuntime.getState().ai.routing[fnId] ?? [];
}

/** The key that serves a function first, with its model and effort, when the server has one. */
export function primaryProvider(fnId: string): AIServerProvider | undefined {
  const ai = useRuntime.getState().ai;
  const id = ai.routing[fnId]?.[0];
  return id ? ai.providers.find((p) => p.id === id) : undefined;
}
