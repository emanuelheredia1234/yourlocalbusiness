// How the assistant reaches an AI: the key that powers "Assistant" on your server (self-hosted), or
// Claude in claude.ai. One request per step, the same JSON protocol on both.

import { getSample, useRuntime } from '@/lib/platform';
import { useStore } from '@/store/useStore';
import { AIError, callArtifactClaude, callServerAI, dailyLimitText } from '../claude';
import { aiFunction, routeFor } from '../functions';

export const ASSISTANT_FN = 'assistant';

export interface Availability {
  ok: boolean;
  /** still finding out (the first try may well work) */
  checking?: boolean;
  /** what's missing, in plain words ('' when ok) */
  reason: string;
  /** Settings › AI keys is where to fix it */
  settings: boolean;
}

/** Whether the assistant can reach an AI right now, and if not, why. */
export function assistantAvailability(): Availability {
  const rt = useRuntime.getState();
  if (__ARTIFACT_BUILD__) {
    switch (rt.claude) {
      case 'available':
        return { ok: true, reason: '', settings: false };
      case 'checking':
        return { ok: true, checking: true, reason: '', settings: false };
      case 'limited':
        return { ok: true, reason: 'Claude is busy or a usage limit was reached, so answers may fail for a while.', settings: false };
      case 'declined':
        return { ok: false, reason: 'Claude access was declined for this page, so the assistant can’t think right now.', settings: false };
      default:
        return { ok: false, reason: 'Claude isn’t available in this view, so the assistant can’t think right now.', settings: false };
    }
  }
  if (rt.server === 'down') return { ok: false, reason: 'The app can’t reach its AI server right now (is it running?).', settings: true };
  if (!rt.ai.reachable) return { ok: true, checking: true, reason: '', settings: false };
  if (!routeFor(ASSISTANT_FN).length) {
    const label = aiFunction(ASSISTANT_FN)?.label ?? 'Assistant';
    return { ok: false, reason: `No API key powers the ${label} yet. In Settings › AI keys, tick ${label} for one of your keys, or add your own key there.`, settings: true };
  }
  return { ok: true, reason: '', settings: false };
}

/** A failed request, said plainly (Settings › AI keys when that's where to fix it). */
export class AssistantError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly settings = false,
  ) {
    super(message);
  }
}

/** Codes that mean the AI never answered (anything else that still carries text answered in prose). */
const NO_ANSWER = new Set(['cancelled', 'not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed', 'rate_limited', 'session_expired', 'unavailable', 'network', 'daily_limit', 'no_provider', 'credits', 'auth', 'refused', 'plan_required']);

function explain(e: unknown): AssistantError {
  const err = e as AIError;
  const code = err?.code ?? 'upstream_error';
  const msg = err?.message ?? '';
  switch (code) {
    case 'daily_limit':
      return new AssistantError(dailyLimitText(msg), code, true);
    case 'no_provider':
      return new AssistantError('No API key powers the Assistant yet. In Settings › AI keys, tick Assistant for one of your keys, or add your own key there.', code, true);
    case 'network':
      return new AssistantError('Your AI server could not be reached (is it running?). Try again in a moment.', code, true);
    case 'rate_limited':
      return new AssistantError(msg && !/^AI server error/.test(msg) ? msg : 'The AI is busy or a usage limit was reached. Try again in a minute.', code);
    case 'refused':
      return new AssistantError('The AI declined this request. Try asking another way.', code);
    case 'credits':
    case 'auth':
      return new AssistantError(msg || 'The key that powers the Assistant couldn’t be used.', code, true);
    case 'plan_required':
      return new AssistantError(msg || 'This needs a plan. Choose one in Settings › Plan.', code);
    case 'not_granted':
      return new AssistantError('Claude access was declined for this page.', code);
    case 'session_expired':
      return new AssistantError('Your Claude session expired. Sign in to claude.ai again.', code);
    case 'unavailable':
    case 'sampling_disabled':
      return new AssistantError('Claude isn’t available in this view.', code);
    case 'prompt_too_large':
      return new AssistantError('This conversation got too long for the AI. Start a new chat and ask again.', code);
    default:
      return new AssistantError(msg ? `The AI hit a problem: ${msg}` : 'The AI hit a temporary problem. Try again.', code);
  }
}

/**
 * Ask for one step. Resolves to the parsed JSON object, or to the AI's text when it answered in prose
 * (shown as the reply). Throws AssistantError (code 'cancelled' after Stop).
 */
export async function askAssistantModel(prompt: string, signal: AbortSignal): Promise<unknown> {
  try {
    if (__ARTIFACT_BUILD__) return await callArtifactClaude(prompt, { tier: 'default', signal });
    const { settings } = useStore.getState();
    const out = await callServerAI(ASSISTANT_FN, prompt, { tier: 'default', signal, serverUrl: settings.ai.serverUrl, brain: settings.ai.useBrain });
    return out.value;
  } catch (e) {
    const err = e as AIError;
    if (signal.aborted || err?.code === 'cancelled') throw new AssistantError('Stopped.', 'cancelled');
    // it answered, just not in JSON: the text is the reply
    if (typeof err?.partial === 'string' && err.partial.trim() && !NO_ANSWER.has(err.code)) return err.partial;
    throw explain(e);
  }
}

let claudeLimit: number | null = null;

/** The longest prompt to send, in characters: well under the server's 120,000 and Claude's own limit in claude.ai. */
export function promptBudget(): number {
  const base = 48_000;
  if (!__ARTIFACT_BUILD__) return base;
  if (claudeLimit === null) {
    claudeLimit = base;
    void getSample()
      .then((s) => s?.limits())
      .then((l) => {
        // bytes, and a character can take several: stay at a third of it
        if (l?.maxPromptBytes && Number.isFinite(l.maxPromptBytes)) claudeLimit = Math.max(8000, Math.min(base, Math.floor(l.maxPromptBytes / 3)));
      })
      .catch(() => undefined);
  }
  return claudeLimit;
}
