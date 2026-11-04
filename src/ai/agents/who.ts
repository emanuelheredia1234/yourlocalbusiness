// Who builds or answers (Manus or Viktor), whether they're ready, and what it costs: the words every
// Build with… button, the build window, the assistant's To: switch and the confirm cards show. A pure
// function of the runtime state (/api/health → ai.agents), so the server decides what's set up.

import { useMemo } from 'react';
import { useRuntime } from '@/lib/platform';
import type { AgentId, AgentReady } from '@/lib/agentTypes';

export type AgentUse = 'build' | 'chat';

export const agentName = (via: AgentId) => (via === 'manus' ? 'Manus' : 'Viktor');

export interface AgentReadiness {
  /** false: don't offer it at all (the claude.ai artifact build; Viktor for anyone but the owner) */
  show: boolean;
  ready: boolean;
  /** the server's reason (ok, no_key, no_token…), or server_down / checking / old_server / artifact */
  reason: string;
  /** one sentence for a tooltip or a disabled button ('' when ready) */
  text: string;
  /** offer "Open Settings → AI" */
  settings: boolean;
}

/** What to tell the owner for each reason a server gives (src/lib/agentTypes.ts AgentReady.reason). */
export function readinessText(via: AgentId, reason: string, use: AgentUse = 'build'): string {
  if (via === 'manus') {
    if (reason === 'no_key') return 'Add a Manus API key in Settings → AI.';
    if (reason === 'not_ticked') return use === 'chat' ? 'Tick “Chat with Manus” for your Manus key in Settings → AI.' : 'Tick “Building pages & assets” for your Manus key in Settings → AI.';
    if (reason === 'own_key_needed') return 'Manus runs in your own Manus account: add your Manus API key in Settings → AI.';
  } else {
    if (reason === 'no_token') return 'Connect Slack in Settings → AI → Viktor (Slack).';
    if (reason === 'bad_token') return 'Slack didn’t accept the saved token: connect again in Settings → AI → Viktor (Slack).';
    if (reason === 'missing_scopes') return 'The Slack app is missing permissions: create it again from the manifest in Settings → AI → Viktor (Slack).';
    if (reason === 'no_viktor') return 'Choose Viktor in Settings → AI → Viktor (Slack).';
    if (reason === 'no_place') return 'Choose where to talk to Viktor (your DM or a channel) in Settings → AI → Viktor (Slack).';
    if (reason === 'owner_only') return 'Viktor runs in the app owner’s Slack, so only the owner can use it.';
  }
  if (reason === 'server_down') return 'Your AI server isn’t running.';
  if (reason === 'checking') return 'Checking your AI server…';
  if (reason === 'old_server') return 'Your AI server needs updating to build and chat with Manus or Viktor: publish the newest version.';
  if (reason === 'ok' || reason === '') return '';
  return via === 'manus' ? 'Manus isn’t set up yet: see Settings → AI.' : 'Viktor isn’t set up yet: see Settings → AI → Viktor (Slack).';
}

const NOT_SETTINGS = new Set(['ok', 'server_down', 'checking', 'old_server', 'owner_only', 'artifact']);

/** Whether Manus or Viktor can build or chat for this person right now, and why not. */
export function agentReady(via: AgentId, use: AgentUse): AgentReadiness {
  if (__ARTIFACT_BUILD__) return { show: false, ready: false, reason: 'artifact', text: '', settings: false };
  const rt = useRuntime.getState();
  const not = (reason: string, show = true): AgentReadiness => ({ show, ready: false, reason, text: readinessText(via, reason, use), settings: !NOT_SETTINGS.has(reason) });
  if (rt.server === 'down') return not('server_down');
  if (!rt.ai.reachable) return not('checking');
  const agents = rt.ai.agents;
  if (!agents) return not('old_server');
  let r: AgentReady;
  if (via === 'manus') r = use === 'build' ? agents.manus.build : agents.manus.chat;
  else {
    r = agents.viktor;
    if (r.reason === 'owner_only') return not('owner_only', false);
  }
  if (r.ready) return { show: true, ready: true, reason: 'ok', text: '', settings: false };
  return not(r.reason || 'unknown');
}

/** agentReady, re-rendered whenever the runtime (the server's answer) changes. */
export function useAgentReady(via: AgentId, use: AgentUse): AgentReadiness {
  const server = useRuntime((s) => s.server);
  const ai = useRuntime((s) => s.ai);
  // agentReady reads the same runtime this hook subscribes to
  return useMemo(() => agentReady(via, use), [via, use, server, ai]);
}

/** Where the app talks to Viktor: 'your DM with Viktor', '#viktor-builds', or '' when not chosen. */
export function agentPlace(): string {
  if (__ARTIFACT_BUILD__) return '';
  const v = useRuntime.getState().ai.agents?.viktor;
  if (!v) return '';
  if (v.where === 'dm') return 'your DM with Viktor';
  if (v.where === 'channel') return v.place || 'the channel you chose';
  return '';
}

/** Who does the work (the house rule: always say who). */
export function agentWho(via: AgentId, use: AgentUse): string {
  if (via === 'manus') {
    const own = !__ARTIFACT_BUILD__ && !!useRuntime.getState().ai.agents?.manus.own;
    return use === 'build'
      ? `Manus, an AI agent with its own computer and browser, builds it in your Manus account${own ? ' (your own key)' : ''}. It usually takes a few minutes.`
      : 'Manus, an AI agent with its own computer and browser, answers in one task in your Manus account.';
  }
  const place = agentPlace() || 'the place you chose in Settings';
  return use === 'build'
    ? `Viktor, the AI employee from viktor.com in your Slack workspace, builds it. The app posts your request as you in ${place} and reads Viktor’s replies in that thread.`
    : `Viktor answers in Slack. The app posts your messages as you in ${place}, in one thread for this chat.`;
}

/** What it costs (the house rule: a cost note, and no made-up numbers). */
export function agentCost(via: AgentId): string {
  return via === 'manus'
    ? 'Uses your Manus credits. How many depends on the work (a Max profile uses more); you’ll see what it used when it’s done.'
    : 'Viktor’s work counts toward your viktor.com plan. This app can’t see how much it uses.';
}

/**
 * Manus agent profiles and their notes, for the build window's "Agent" choice: a copy of the server's
 * SCALES.manusProfile (server/providers/registry.mjs), checked equal by src/ai/agents/targets.test.ts.
 */
export const MANUS_PROFILES: { id: string; label: string; note: string }[] = [
  { id: 'lite', label: 'Lite', note: 'Fastest agent: the fewest credits.' },
  { id: 'standard', label: 'Standard', note: 'Manus’s default agent.' },
  { id: 'max-medium', label: 'Max · medium', note: 'The Max agent with medium thinking: more credits.' },
  { id: 'max-high', label: 'Max · high', note: 'Max with deeper thinking: more credits again.' },
  { id: 'max-extra', label: 'Max · extra', note: 'Max with extra thinking (plain “max”).' },
  { id: 'max-ultra', label: 'Max · ultra', note: 'Deepest reasoning, slowest: the most credits.' },
];
