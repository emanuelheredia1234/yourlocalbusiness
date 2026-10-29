import type { AppSettings, ProviderId, Project, Skill } from '@/lib/types';
import { useRuntime } from '@/lib/platform';
import { sleep, uid } from '@/lib/utils';
import { polishDeep, resolveBrain } from './brain';
import { AIError, callArtifactClaude, callServerClaude, friendlyAIError } from './claude';
import type { TaskDef, TaskEnv } from './tasks';

export interface RunOptions {
  project: Project;
  skills: Skill[];
  settings: AppSettings;
  variation?: number;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  onText?: (text: string) => void;
  forceLocal?: boolean;
}

export interface RunResult<O> {
  data: O;
  provider: ProviderId;
  skills: Skill[];
  ms: number;
  note?: string;
  id: string;
}

export function resolveProvider(settings: AppSettings, forceLocal = false): ProviderId {
  if (forceLocal) return 'local';
  const rt = useRuntime.getState();
  const claudeOk = rt.claude === 'available' || rt.claude === 'checking';
  switch (settings.ai.provider) {
    case 'local':
      return 'local';
    case 'claude':
      return claudeOk ? 'claude' : 'local';
    case 'server':
      // a blank URL means the same origin (the bundled server in /server)
      return 'server';
    default:
      if (rt.claude === 'available') return 'claude';
      if (rt.server === 'ok') return 'server';
      return 'local';
  }
}

export function providerLabel(p: ProviderId): string {
  return p === 'claude' ? 'Claude' : p === 'server' ? 'Claude (your server)' : 'Built-in engine';
}

export async function runTask<I, O>(task: TaskDef<I, O>, input: I, opts: RunOptions): Promise<RunResult<O>> {
  const t0 = performance.now();
  const brain = resolveBrain(opts.skills, task.module, opts.settings.ai.useBrain);
  const env: TaskEnv = { project: opts.project, directives: brain.directives, brainPrompt: brain.prompt, variation: opts.variation ?? 0 };
  const provider = resolveProvider(opts.settings, opts.forceLocal);
  opts.onStage?.(brain.skills.length ? `Reading ${brain.skills.length} Brain skill${brain.skills.length > 1 ? 's' : ''}…` : 'Reading your project context…');

  const base = task.local(input, env);
  let data = base;
  let used: ProviderId = 'local';
  let note: string | undefined;

  if (provider !== 'local' && task.claude) {
    opts.onStage?.(provider === 'claude' ? 'Claude is thinking…' : 'Asking your Claude server…');
    try {
      const prompt = task.claude.prompt(input, env, base);
      const wantImages = provider === 'server' || useRuntime.getState().claudeImages;
      const images = wantImages && task.claude.images ? await task.claude.images(input).catch(() => undefined) : undefined;
      const callOpts = {
        tier: task.tier,
        signal: opts.signal,
        images,
        onText: (text: string) => {
          opts.onStage?.('Claude is writing…');
          opts.onText?.(text);
        },
      };
      const raw = provider === 'claude' ? await callArtifactClaude(prompt, callOpts) : await callServerClaude(opts.settings.ai.serverUrl, prompt, callOpts);
      data = task.claude.merge(raw, base, input, env);
      used = provider;
    } catch (e) {
      const err = e as AIError;
      if (err?.code === 'cancelled' || opts.signal?.aborted) throw new AIError('Stopped.', 'cancelled');
      note = friendlyAIError(err?.code ?? 'upstream_error');
    }
  } else if (opts.settings.ai.simulateLatency) {
    for (const stage of task.stages) {
      opts.onStage?.(stage);
      await sleep(260 + Math.random() * 260, opts.signal).catch(() => {
        throw new AIError('Stopped.', 'cancelled');
      });
    }
  }

  data = polishDeep(data, brain.directives);
  return { data, provider: used, skills: brain.skills, ms: Math.round(performance.now() - t0), note, id: uid('gen') };
}
