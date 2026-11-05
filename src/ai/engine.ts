import type { AppSettings, ProviderId, Project, Skill } from '@/lib/types';
import { useRuntime } from '@/lib/platform';
import { imagesWithKeysForAI } from '@/lib/promptImages';
import { uid } from '@/lib/utils';
import { polishDeep, resolveBrain } from './brain';
import { AIError, SERVER_MAX_IMAGES, callArtifactClaude, callServerAI, fitClaudeImages, friendlyAIError, recheckServer } from './claude';
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
  /** why the built-in engine answered: 'no_provider', 'server_down' or an AIError code (unset when your AI answered, or none was asked) */
  code?: string;
}

/**
 * One AI for the whole app. In claude.ai it's Claude; self-hosted it's your server, which sends
 * each task to the API keys that power its function (Settings › AI keys). Without either, the
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

/** What goes with a request: the files, and for the owner's prompt images which ones (their keys, in order). */
export interface Attachments {
  blobs?: Blob[];
  /** set for a task with `claude.promptImages`: [] when none could be attached */
  keys?: string[];
}

/**
 * The files to send with a task's request. They're ready before its prompt is written, so the prompt
 * can say exactly which images the AI gets: only those whose files could be loaded, within what the
 * AI takes (your server keeps 4; Claude in claude.ai has its own count, types and size).
 */
export async function prepareAttachments<I, O>(task: TaskDef<I, O>, input: I, provider: ProviderId, onStage?: (stage: string) => void): Promise<Attachments> {
  const c = task.claude;
  if (!c || provider === 'local') return {};
  const rt = useRuntime.getState();
  const wantImages = provider === 'server' || rt.claudeImages;
  if (c.promptImages) {
    const list = (c.promptImages(input) ?? []).filter((i) => i.media.kind === 'image');
    if (!wantImages || !list.length) return { keys: [] };
    onStage?.('Getting your images ready…');
    const ready = await imagesWithKeysForAI(list).catch(() => []);
    const blobs = ready.map((r) => r.blob);
    const fit = provider === 'claude' ? fitClaudeImages(blobs, rt.claudeImageLimits) : blobs.slice(0, SERVER_MAX_IMAGES);
    const sent = ready.filter((r) => fit.includes(r.blob));
    return { blobs: sent.length ? sent.map((r) => r.blob) : undefined, keys: sent.map((r) => r.key) };
  }
  if (wantImages && c.images) return { blobs: await c.images(input).catch(() => undefined) };
  return {};
}

export async function runTask<I, O>(task: TaskDef<I, O>, input: I, opts: RunOptions): Promise<RunResult<O>> {
  const t0 = performance.now();
  const brain = resolveBrain(opts.skills, task.module, opts.settings.ai.useBrain, opts.project.id);
  const env: TaskEnv = { project: opts.project, directives: brain.directives, brainPrompt: brain.prompt, variation: opts.variation ?? 0 };
  // a request that couldn't reach your server a while ago may have been a blip: ask it again before going without it
  if (!opts.forceLocal && task.claude) await recheckServer(opts.settings.ai.serverUrl);
  const provider = resolveProvider(opts.settings, opts.forceLocal);
  opts.onStage?.(brain.skills.length ? `Reading ${brain.skills.length} Brain skill${brain.skills.length > 1 ? 's' : ''}…` : 'Reading your project context…');

  const base = task.local(input, env);
  let data = base;
  let used: ProviderId = 'local';
  let note: string | undefined;
  let meta: AIMeta | undefined;
  let code: string | undefined;
  const fn = functionForTask(task.id);
  const rt = useRuntime.getState();
  let ask = provider !== 'local' && !!task.claude;

  if (provider === 'server' && ask && fn && rt.ai.reachable && routeFor(fn.id).length === 0) {
    // no request to make: say what to set up
    ask = false;
    code = 'no_provider';
    note = `No API key powers ${fn.label} yet, so the built-in engine answered. In Settings › AI keys, tick ${fn.label} for one of your keys.`;
  } else if (!__ARTIFACT_BUILD__ && provider === 'local' && !opts.forceLocal && task.claude && rt.server === 'down') {
    code = 'server_down';
    note = 'Your AI server isn’t running, so the built-in engine answered.';
  }

  if (ask && task.claude) {
    const asking = provider === 'claude' ? 'Claude is thinking…' : 'Asking your AI…';
    opts.onStage?.(asking);
    try {
      // The files first, then the prompt: it says which images the AI really gets (env.attached).
      const files = await prepareAttachments(task, input, provider, opts.onStage);
      if (opts.signal?.aborted) throw new AIError('Stopped.', 'cancelled');
      if (files.keys) opts.onStage?.(asking);
      const runEnv: TaskEnv = files.keys ? { ...env, attached: files.keys } : env;
      const prompt = task.claude.prompt(input, runEnv, base);
      const callOpts = {
        tier: task.tier,
        signal: opts.signal,
        images: files.blobs,
        onText: (text: string) => {
          opts.onStage?.(provider === 'claude' ? 'Claude is writing…' : 'Writing…');
          opts.onText?.(text);
        },
      };
      if (provider === 'claude') data = task.claude.merge(await callArtifactClaude(prompt, callOpts), base, input, runEnv);
      else {
        // web research only on your server, for tasks that ask for it (claude.ai has no search)
        const research = task.claude.research?.(input, runEnv) ?? null;
        const out = await callServerAI(fn?.id ?? 'product', prompt, { ...callOpts, serverUrl: opts.settings.ai.serverUrl, brain: opts.settings.ai.useBrain, ...(research ? { research } : {}) });
        meta = out.meta ?? undefined;
        data = task.claude.merge(out.value, base, input, { ...runEnv, meta });
        if (meta?.attempts?.length) note = `${meta.attempts.map((a) => `${a.providerLabel} failed (${a.error})`).join(' ')} ${meta.providerLabel} answered instead.`;
      }
      used = provider;
    } catch (e) {
      const err = e as AIError;
      if (err?.code === 'cancelled' || opts.signal?.aborted) throw new AIError('Stopped.', 'cancelled');
      code = err?.code ?? 'upstream_error';
      note = friendlyAIError(code, provider === 'server' ? err?.message : '');
    }
  }

  data = polishDeep(data, brain.directives);
  return { data, provider: used, skills: brain.skills, ms: Math.round(performance.now() - t0), note, id: uid('gen'), meta: used === 'server' ? meta : undefined, ...(code ? { code } : {}) };
}
