// Manus and Viktor (viktor.com's AI employee, in Slack) for the assistant. It can open their build window for the
// SEO page or a Code & assets asset (the owner fills it in and sends it there), draft a message the owner
// confirms on a card before it goes (then it's sent as the owner's, in this chat's Manus task or Slack thread),
// and say what they're working on. It never sends anything to them by itself, and never sees their replies:
// agent_status holds states only, never their words.

import type { AgentId } from '@/lib/agentTypes';
import { fmtRelative } from '@/lib/utils';
import { agentCost, agentName, agentReady, agentWho } from '@/ai/agents/who';
import { agentChatStatus, sendToAgent } from '@/ai/agents/chat';
import { buildsOf } from '@/ai/agents/buildRecords';
import { kindLabel } from '@/ai/agents/builds';
import { chatOf } from '@/store/assistant';
import { redactSecrets } from '../prompt';
import { arg, defineTool, type AnyTool } from '../registry';

const AGENTS = ['manus', 'viktor'] as const;
const TARGETS = ['asset', 'seo'] as const;

/** The longest message the assistant drafts (both agents take it in one message). */
export const DRAFT_MAX = 3000;

const NOT_HERE = 'Manus and Viktor work in the self-hosted app: they aren’t available in claude.ai.';

/** Why an agent can't be used for this ('' when it can). */
function notReady(via: AgentId, use: 'build' | 'chat'): string {
  if (__ARTIFACT_BUILD__) return NOT_HERE;
  const r = agentReady(via, use);
  if (!r.show) return r.text || `${agentName(via)} isn’t available here.`;
  if (!r.ready) return `${agentName(via)} isn’t ready${use === 'build' ? ' to build' : ''}: ${r.text || 'see Settings → AI keys.'}`;
  return '';
}

const draftAgentMessage = defineTool({
  name: 'draft_agent_message',
  class: 'P-media',
  summary:
    'Only when the owner asks you to write a message for Manus or Viktor: the app shows your exact text on a card, and sends it as the owner’s message in this chat’s Manus task or Slack thread only if they confirm. Put in only what the owner asked for.',
  args: { to: arg.enum(AGENTS), text: arg.string({ max: DRAFT_MAX, desc: 'the exact message' }) },
  validate: ({ to, text }) => {
    if (redactSecrets(text) !== text) return 'The draft has something that looks like a key or password: never put keys or passwords in a message.';
    return notReady(to, 'chat') || null;
  },
  media: 'agent',
  card: ({ to, text }) => ({
    title: `Send this to ${agentName(to)}?`,
    what: 'The assistant drafted this message for you. It goes exactly as shown below, as your message.',
    quote: text,
    who: agentWho(to, 'chat'),
    cost: agentCost(to),
    confirmLabel: `Send to ${agentName(to)}`,
  }),
  // only after the owner's yes on the card (the policy asks first)
  run: async ({ to, text }, ctx) => {
    const name = agentName(to);
    const delivery = await sendToAgent(ctx.projectId, to, { text, images: [], website: false, drafted: true });
    if (delivery === 'sent') return { data: { to, delivery }, note: `Sent your message to ${name}` };
    if (delivery === 'unknown') return { data: { to, delivery }, note: `Your message to ${name} may have been delivered: the app is checking` };
    // why it didn't go is on the message in the chat
    const mine = [...chatOf(ctx.projectId)].reverse().find((m) => m.role === 'user' && m.via === to && m.drafted);
    const why = delivery === 'failed' && mine?.delivery === 'failed' ? mine.deliveryNote : '';
    return { ok: false, data: { to, delivery }, error: why || `It wasn’t sent to ${name}: see the chat.`, note: `Your message wasn’t sent to ${name}` };
  },
});

const openAgentBuildTool = defineTool({
  name: 'open_agent_build',
  class: 'Pub',
  summary: 'Open “Build with Manus” or “Build with Viktor” for the SEO page or a new Code & assets asset: the owner fills it in and sends it there (you never fill it in).',
  args: { target: arg.enum(TARGETS), agent: arg.enum(AGENTS) },
  validate: ({ agent }) => notReady(agent, 'build') || null,
  window: ({ target, agent }) => ({ kind: 'agent-build', target, agent }),
});

/** Whether each agent can build and chat here, in a word, or why not (the app's own words, never an agent's). */
function readiness(): Record<AgentId, { build: string; chat: string }> {
  const one = (via: AgentId, use: 'build' | 'chat') => notReady(via, use) || 'ready';
  return { manus: { build: one('manus', 'build'), chat: one('manus', 'chat') }, viktor: { build: one('viktor', 'build'), chat: one('viktor', 'chat') } };
}

const agentStatus = defineTool({
  name: 'agent_status',
  class: 'R',
  summary: 'What Manus and Viktor are doing for this project: its builds (who, page or asset kind, state, when), whether this chat waits for a reply from either, and whether each is set up. States only: you never see their replies.',
  args: {},
  run: (_a, ctx) => {
    const builds = buildsOf(ctx.projectId)
      .slice(0, 10)
      .map((b) => ({ via: b.via, target: b.target, kind: kindLabel(b.target, b.kind), state: b.state, requested: fmtRelative(b.requestedAt) }));
    return { data: { builds, chats: agentChatStatus(ctx.projectId), setup: readiness() }, note: 'Looked at what Manus and Viktor are doing' };
  },
});

export const agentTools: AnyTool[] = [draftAgentMessage, openAgentBuildTool, agentStatus];
