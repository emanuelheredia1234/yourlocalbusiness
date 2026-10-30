import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, ProviderId, Skill } from '@/lib/types';
import { getActiveProject, useStore } from '@/store/useStore';
import { runTask, type RunResult } from './engine';
import { compactMeta } from './meta';
import type { TaskDef } from './tasks';

export interface GenState<O> {
  running: boolean;
  stage: string;
  chars: number;
  result: RunResult<O> | null;
  error: string | null;
  logId: string | null;
  provider: ProviderId | null;
}

export interface RunExtras {
  project?: Project;
  skills?: Skill[];
  forceLocal?: boolean;
  variation?: number;
  silent?: boolean;
}

const variations = new Map<string, number>();

/** React binding for the AI engine: runs a task with the Project Context + Brain, tracks progress, logs the generation. */
export function useAI<I, O>(task: TaskDef<I, O>) {
  const [state, setState] = useState<GenState<O>>({ running: false, stage: '', chars: 0, result: null, error: null, logId: null, provider: null });
  const ctl = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ctl.current?.abort();
    };
  }, []);

  const run = useCallback(
    async (input: I, extras: RunExtras = {}): Promise<O | null> => {
      const s = useStore.getState();
      const project = extras.project ?? getActiveProject();
      if (!project) return null;
      ctl.current?.abort();
      const controller = new AbortController();
      ctl.current = controller;
      const key = `${task.id}|${project.id}`;
      const variation = extras.variation ?? variations.get(key) ?? 0;
      variations.set(key, variation + 1);
      setState((st) => ({ ...st, running: true, stage: 'Starting…', chars: 0, error: null }));
      try {
        const res = await runTask(task, input, {
          project,
          skills: extras.skills ?? s.skills,
          settings: s.settings,
          variation,
          signal: controller.signal,
          forceLocal: extras.forceLocal,
          onStage: (stage) => mounted.current && setState((st) => ({ ...st, stage })),
          onText: (text) => mounted.current && setState((st) => ({ ...st, chars: text.length })),
        });
        let logId: string | null = null;
        if (!extras.silent) {
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
        if (mounted.current) setState({ running: false, stage: '', chars: 0, result: res, error: null, logId, provider: res.provider });
        return res.data;
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (mounted.current) setState((st) => ({ ...st, running: false, stage: '', error: code === 'cancelled' ? null : (e as Error).message || 'Something went wrong.' }));
        return null;
      } finally {
        if (ctl.current === controller) ctl.current = null;
      }
    },
    [task],
  );

  const stop = useCallback(() => ctl.current?.abort(), []);
  const reset = useCallback(() => setState({ running: false, stage: '', chars: 0, result: null, error: null, logId: null, provider: null }), []);

  return { ...state, run, stop, reset };
}
