// Run one of the app's AI text tasks (src/ai/tasks.ts) from an assistant tool, outside React. It does
// what useAI does for a page: the Project Context and Brain, the generation in the Brain's activity log
// with which key, model and effort answered, the built-in engine (and the reason) when the AI can't
// answer, including today's limit being reached. The difference: it counts as an app-wide job in the
// busy registry (moving between pages doesn't stop it) and it stops with the chat's Stop, not on unmount.

import type { Project, ProviderId, Skill } from '@/lib/types';
import { beginBusy, busyId, endBusy } from '@/lib/busy';
import { getActiveProject, useStore } from '@/store/useStore';
import { runTask, type RunResult } from '../engine';
import { compactMeta } from '../meta';
import type { TaskDef } from '../tasks';
import type { ToolContext } from './registry';

export interface AITaskResult<O> {
  data: O;
  /** who wrote it: claude / server (your AI) or local (the built-in engine) */
  provider: ProviderId;
  /** why the built-in engine answered, or that another key answered after one failed */
  note?: string;
  /** today's AI limit on the app's keys was reached (the built-in engine wrote it instead) */
  limitReached: boolean;
  /** the Brain activity log entry (null when silent) */
  logId: string | null;
  ms: number;
  result: RunResult<O>;
}

// regenerating the same task in the same project asks for a fresh take, as on the pages
const variations = new Map<string, number>();

/** Today's limit, as the server and the app word it (dailyLimitText). */
const LIMIT = /today[’']s limit/i;

/**
 * Run an AI text task for a tool. Throws AIError code 'cancelled' after the chat's Stop. The chat notes
 * "Used your AI" (or that the built-in engine wrote it) from what this records in ctx.ai.
 */
export async function runAITask<I, O>(task: TaskDef<I, O>, input: I, ctx: ToolContext, opts: { project?: Project; skills?: Skill[]; silent?: boolean; forceLocal?: boolean } = {}): Promise<AITaskResult<O>> {
  const s = useStore.getState();
  const project = opts.project ?? getActiveProject();
  if (!project) throw new Error('Open a project first.');
  const key = `${task.id}|${project.id}`;
  const variation = variations.get(key) ?? 0;
  variations.set(key, variation + 1);
  const job = busyId(`assistant:${task.id}`);
  beginBusy(job, task.label, 'app');
  ctx.stage(`${task.label}…`);
  try {
    const res = await runTask(task, input, {
      project,
      skills: opts.skills ?? s.skills,
      settings: s.settings,
      variation,
      signal: ctx.signal,
      forceLocal: opts.forceLocal,
      onStage: (stage) => ctx.stage(stage),
    });
    let logId: string | null = null;
    if (!opts.silent) {
      logId = useStore.getState().recordGeneration({
        id: res.id,
        task: task.id,
        label: task.label,
        module: task.module,
        provider: res.provider,
        skillIds: res.skills.map((k) => k.id),
        createdAt: Date.now(),
        ms: res.ms,
        projectId: project.id,
        ...(res.meta ? { meta: compactMeta(res.meta) } : {}),
      });
    }
    ctx.ai.push({ task: task.id, label: task.label, provider: res.provider, ...(res.note ? { note: res.note } : {}) });
    return { data: res.data, provider: res.provider, note: res.note, limitReached: !!res.note && LIMIT.test(res.note), logId, ms: res.ms, result: res };
  } finally {
    endBusy(job);
  }
}
