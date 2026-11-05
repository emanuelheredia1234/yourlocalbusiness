// What the Facebook-groups flow (and brand-voice reads) need from Manus: whether this view can reach it, what
// to set up when it can't, its error words, and the status tones. Manus no longer posts on Pages or profiles:
// "Post on <network>" goes through your connected account (PostNowButton), or you post it yourself.
import { useRuntime } from '@/lib/platform';
import { zapierErrorMessage } from '@/lib/zapier';
import { manusErrorMessage, manusViaServer } from '@/ai/manus';

/** Whether this view can reach Manus: claude.ai with the Zapier connector, or a server whose Manus key powers Facebook groups posting. */
export function useManusReady(): boolean {
  const z = useRuntime((s) => s.zapier);
  const fb = useRuntime((s) => s.ai.routing.facebook);
  if (manusViaServer()) return !!fb?.includes('manus');
  return z === 'ready' || (__ARTIFACT_BUILD__ && z === 'checking');
}

/** What to do to use Manus from this view. */
export function manusSetupHint(): string {
  if (!manusViaServer()) return 'Manus is reached through your Zapier connector in claude.ai, which isn’t available in this view.';
  const ai = useRuntime.getState().ai;
  if (!ai.reachable) return 'The app can’t reach its AI server right now, so it can’t send anything to Manus. Reload the page, and check that the app is running.';
  switch (ai.posting?.reason) {
    case 'no_key':
      return 'No Manus API key is saved on the server. Add it in Settings › AI keys › Manus (create a Manus account at manus.im first).';
    case 'not_ticked':
      return 'Your Manus key is saved, but it isn’t set for Facebook groups. In Settings › AI keys › Manus, open its “Powers” list and tick Facebook groups posting.';
    case 'own_key_needed':
      return 'The app’s Manus key is only for its owner’s accounts. Add your own Manus API key in Settings › AI keys › “Use your own Manus” to post in groups as you.';
    default:
      return 'To post in Facebook groups from here, add your Manus API key in Settings › AI keys (create a Manus account at manus.im first) and tick Facebook groups posting in its “Powers” list.';
  }
}

/** Show the groups button even when Manus isn't ready, so pressing it explains what's missing. */
export function useCanOfferManus(): boolean {
  const ready = useManusReady();
  return ready || manusViaServer();
}

/** Failures after which the task may exist anyway (sending again could post twice). */
const UNCERTAIN = new Set(['MANUS_CREATE_UNKNOWN', 'server_unavailable', 'upstream_error', 'cancelled']);

export function errorCopy(e: unknown): { title: string; body: string; uncertain?: boolean } {
  const code = (e as { code?: string })?.code ?? 'upstream_error';
  const msg = (e as Error)?.message ?? '';
  const m = manusErrorMessage(code, msg);
  if (m) return { ...m, uncertain: UNCERTAIN.has(code) };
  const z = zapierErrorMessage(code, msg);
  // a write that failed ambiguously may still have reached Manus
  if (UNCERTAIN.has(code)) return { title: z.title, body: `${z.body} The task may still have started: check your Manus tasks before trying again.`, uncertain: true };
  return z;
}

/**
 * The tones of a status: a badge (rows) and a block with a hairline (the post card and editor). Only what needs
 * the owner is tinted; the rest is a quiet block with a coloured icon.
 */
export type Tone = 'primary' | 'warn' | 'good' | 'bad' | 'neutral';
export const TONE_BADGE: Record<Tone, string> = { primary: 'bg-primary-soft text-primary', warn: 'bg-warn-soft text-warn', good: 'bg-good-soft text-good', bad: 'bg-bad-soft text-bad', neutral: 'bg-surface-3 text-ink-2' };
export const TONE_BLOCK: Record<Tone, { box: string; icon: string }> = {
  primary: { box: 'border-line bg-surface-2', icon: 'text-primary' },
  warn: { box: 'border-warn-line bg-warn-soft', icon: 'text-warn' },
  good: { box: 'border-line bg-surface-2', icon: 'text-good' },
  bad: { box: 'border-bad-line bg-bad-soft', icon: 'text-bad' },
  neutral: { box: 'border-line bg-surface-2', icon: 'text-muted' },
};
