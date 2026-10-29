// Calls into the viewer's Zapier connector (claude.ai `mcp` capability).
// Used for Manus image generation and Facebook scheduling; only available when the app
// runs as a claude.ai Artifact whose viewer has the Zapier connector.

import { getMcp, useRuntime } from './platform';

export const ZAPIER_SERVER = 'Zapier';

export class ZapierError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return text(o.message ?? o.error ?? o.detail ?? '') || JSON.stringify(v).slice(0, 300);
  }
  return '';
}

/**
 * Zapier wraps results differently per action type:
 *   built-in actions → { results: [...] }
 *   code actions     → { isError, results: { data: { success, data: {...} }, logs } }
 * This returns the useful part, or throws a ZapierError when Zapier reports a failure.
 */
export function unwrapZapier(payload: unknown): unknown {
  let p = payload;
  if (typeof payload === 'string') {
    try {
      p = JSON.parse(payload);
    } catch {
      throw new ZapierError(payload.slice(0, 300) || 'Zapier returned an unexpected answer.', 'tool_error');
    }
  }
  if (!p || typeof p !== 'object') return p;
  const o = p as Record<string, unknown>;
  if (o.isError === true) {
    const id = typeof o.error_id === 'string' ? ` (Zapier error id ${o.error_id})` : '';
    throw new ZapierError((text(o.error ?? o.results) || 'The Zapier action failed.') + (id && !text(o.error).includes(String(o.error_id)) ? id : ''), 'tool_error');
  }
  const results = o.results;
  if (Array.isArray(results)) return results;
  if (results && typeof results === 'object') {
    const data = (results as Record<string, unknown>).data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      if (d.success === false) throw new ZapierError(text(d.error ?? d.message) || 'The Zapier action failed.', 'tool_error');
      return 'data' in d ? d.data : d;
    }
    return results;
  }
  return p;
}

export interface ZapierCallOptions {
  /** the app's Zapier id, e.g. Manus */
  selectedApi: string;
  kind?: 'read' | 'write';
  /** only for calls that are safe to abandon (status reads); never for one-shot writes */
  signal?: AbortSignal;
}

/** Run one Zapier action through the viewer's connector and return its unwrapped result. */
export async function zapierCall(action: string, params: Record<string, unknown>, opts: ZapierCallOptions): Promise<unknown> {
  const mcp = await getMcp();
  if (!mcp) throw new ZapierError('Zapier isn’t available on this page.', 'unavailable');
  const tool = opts.kind === 'read' ? 'execute_zapier_read_action' : 'execute_zapier_write_action';
  let res;
  try {
    res = await mcp.callTool(ZAPIER_SERVER, tool, { selected_api: opts.selectedApi, action, params }, opts.signal ? { cache: false, signal: opts.signal } : { cache: false });
  } catch (e) {
    const err = e as { code?: string; message?: string; retryable?: boolean; result?: unknown };
    const code = err?.code ?? 'upstream_error';
    if (code === 'needs_reauth') useRuntime.getState().set({ zapier: 'needs_reauth' });
    if (code === 'server_not_connected') useRuntime.getState().set({ zapier: 'missing' });
    if (code === 'not_granted' || code === 'capability_disabled' || code === 'capability_removed') useRuntime.getState().set({ zapier: 'unavailable' });
    if (code === 'tool_error') throw new ZapierError(text(err.result) || err.message || 'The Zapier action failed.', 'tool_error');
    throw new ZapierError(err?.message || 'Zapier didn’t answer.', code, err?.retryable === true);
  }
  useRuntime.getState().set({ zapier: 'ready' });
  return unwrapZapier(res?.payload ?? res);
}

/** What to tell the viewer for a Zapier failure (by code, never by message text). */
export function zapierErrorMessage(code: string, message = ''): { title: string; body: string } {
  switch (code) {
    case 'needs_reauth':
      return { title: 'Reconnect Zapier', body: 'Your Zapier connection expired. Reconnect it in claude.ai Settings → Connectors, then try again.' };
    case 'server_not_connected':
    case 'missing':
      return { title: 'Zapier isn’t connected', body: 'Add the Zapier connector in claude.ai Settings → Connectors and connect Manus in Zapier.' };
    case 'selection_required':
      return { title: 'Choose your Zapier connector', body: 'You have more than one Zapier connector. Pick one when claude.ai asks, then try again.' };
    case 'approval_required':
      return { title: 'Zapier needs your approval', body: 'Approve the Zapier request when claude.ai asks. To skip the prompt, set Zapier’s “execute write action” tool to Always allow in claude.ai connector settings.' };
    case 'not_in_manifest':
      return { title: 'Zapier isn’t allowed on this page', body: 'Allow Zapier in this page’s Permissions menu, then try again.' };
    case 'blocked_by_policy':
      return { title: 'Zapier is blocked here', body: 'Your organization’s policy blocks this Zapier tool.' };
    case 'server_unavailable':
    case 'rate_limited':
      return { title: 'Zapier is busy', body: 'Zapier didn’t answer in time. Wait a moment and try again.' };
    case 'unavailable':
    case 'not_granted':
    case 'capability_disabled':
    case 'capability_removed':
      return { title: 'Zapier isn’t available here', body: 'Open this app in claude.ai with the Zapier connector to use Manus.' };
    case 'tool_error':
      return { title: 'Zapier reported an error', body: message || 'The Zapier action failed. Check the Manus connection in Zapier.' };
    default:
      return { title: 'Zapier didn’t answer', body: message || 'Please try again.' };
  }
}
