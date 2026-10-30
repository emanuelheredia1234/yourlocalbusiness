import type { AppSettings, ProviderId, Project, Skill } from '@/lib/types';
import { useRuntime } from '@/lib/platform';
import { sleep, uid } from '@/lib/utils';
import { polishDeep, resolveBrain } from './brain';
import { AIError, callArtifactClaude, callServerAI, friendlyAIError } from './claude';
import { functionForTask, routeFor } from './functions';
import type { AIMeta } from './meta';
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
  /** which key, model and effort answered on your server, and what it used */
  meta?: AIMeta;
}

/**
 * One AI for the whole app. In claude.ai it's Claude; self-hosted it's your server, which sends
 * each task to the API keys that power its function (Settings → AI). Without either, the
 * built-in engine answers.
 */
export function resolveProvider(_settings: AppSettings, forceLocal = false): ProviderId {
  if (forceLocal) return 'local';
  const rt = useRuntime.getState();
  if (__ARTIFACT_BUILD__) return rt.claude === 'available' || rt.claude === 'checking' ? 'claude' : 'local';
  return rt.server === 'down' ? 'local' : 'server';
}

export function providerLabel(p: ProviderId): string {
  return p === 'claude' ? 'Claude' : p === 'server' ? 'AI' : 'Built-in engine';
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
  let meta: AIMeta | undefined;
  const fn = functionForTask(task.id);
  const rt = useRuntime.getState();
  let ask = provider !== 'local' && !!task.claude;

  if (provider === 'server' && ask && fn && rt.ai.reachable && routeFor(fn.id).length === 0) {
    // no request to make: say what to set up
    ask = false;
    note = `No API key powers ${fn.label} yet, so the built-in engine answered. In Settings → AI, tick ${fn.label} for one of your keys.`;
  } else if (!__ARTIFACT_BUILD__ && provider === 'local' && !opts.forceLocal && task.claude && rt.server === 'down') {
    note = 'Your AI server isn’t running (npm run server), so the built-in engine answered.';
  }

  if (ask && task.claude) {
    opts.onStage?.(provider === 'claude' ? 'Claude is thinking…' : 'Asking your AI…');
    try {
      const prompt = task.claude.prompt(input, env, base);
      const wantImages = provider === 'server' || rt.claudeImages;
      const images = wantImages && task.claude.images ? await task.claude.images(input).catch(() => undefined) : undefined;
      const callOpts = {
        tier: task.tier,
        signal: opts.signal,
        images,
        onText: (text: string) => {
          opts.onStage?.(provider === 'claude' ? 'Claude is writing…' : 'Writing…');
          opts.onText?.(text);
        },
      };
      if (provider === 'claude') data = task.claude.merge(await callArtifactClaude(prompt, callOpts), base, input, env);
      else {
        const out = await callServerAI(fn?.id ?? 'product', prompt, { ...callOpts, serverUrl: opts.settings.ai.serverUrl, brain: opts.settings.ai.useBrain });
        meta = out.meta ?? undefined;
        data = task.claude.merge(out.value, base, input, env);
        if (meta?.attempts?.length) note = `${meta.attempts.map((a) => `${a.providerLabel} failed (${a.error})`).join(' ')} ${meta.providerLabel} answered instead.`;
      }
      used = provider;
    } catch (e) {
      const err = e as AIError;
      if (err?.code === 'cancelled' || opts.signal?.aborted) throw new AIError('Stopped.', 'cancelled');
      note = friendlyAIError(err?.code ?? 'upstream_error', provider === 'server' ? err?.message : '');
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
  return { data, provider: used, skills: brain.skills, ms: Math.round(performance.now() - t0), note, id: uid('gen'), meta: used === 'server' ? meta : undefined };
}
