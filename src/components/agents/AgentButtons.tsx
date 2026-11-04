// "Build with Manus" and "Build with Viktor" (or Rebuild…): they open the build window, where the owner fills in
// the request and confirms who does it and what it costs. Self-hosted only (hidden in the claude.ai build), Viktor
// only for the owner. One that isn't set up is disabled, says why, and offers Settings → AI. They never touch the
// app's own AI, so an AI generation and an agent build can run side by side.

import { useId } from 'react';
import { Bot, MessagesSquare } from 'lucide-react';
import type { AgentId, BuildTarget } from '@/lib/agentTypes';
import { cn } from '@/lib/utils';
import { agentName, useAgentReady } from '@/ai/agents/who';
import { openPage } from '@/ai/assistant/nav';
import { openAgentBuild } from './buildWindow';

const ICON: Record<AgentId, typeof Bot> = { manus: Bot, viktor: MessagesSquare };

export function AgentButtons({
  target,
  rebuild,
  kind,
  lead,
  className,
}: {
  target: BuildTarget;
  rebuild?: boolean;
  /** the kind to start on (the SEO builder's chosen page type) */
  kind?: string;
  /** words before the buttons ("or build it with"), shown only with them: the buttons then just say "Manus" and "Viktor" */
  lead?: string;
  className?: string;
}) {
  const manus = useAgentReady('manus', 'build');
  const viktor = useAgentReady('viktor', 'build');
  const ids = useId();
  if (__ARTIFACT_BUILD__) return null;
  const agents = ([['manus', manus], ['viktor', viktor]] as const).filter(([, r]) => r.show);
  if (!agents.length) return null;
  const setup = agents.some(([, r]) => !r.ready && r.settings);
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)} role="group" aria-label={`${rebuild ? 'Rebuild' : 'Build'} with ${agents.map(([via]) => agentName(via)).join(' or ')}`}>
      {lead && <span className="text-xs text-muted">{lead}</span>}
      {agents.map(([via, r]) => {
        const Icon = ICON[via];
        const label = lead ? agentName(via) : `${rebuild ? 'Rebuild' : 'Build'} with ${agentName(via)}`;
        return (
          // a disabled button shows no tooltip: the wrapper carries it
          <span key={via} title={r.ready ? undefined : r.text} className="inline-flex">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!r.ready}
              aria-label={lead ? `${lead} ${agentName(via)}`.replace(/^or /, '').replace(/^\w/, (c) => c.toUpperCase()) : undefined}
              aria-describedby={r.ready ? undefined : `${ids}-${via}`}
              onClick={() => void openAgentBuild({ target, via, ...(kind ? { kind } : {}) })}
            >
              <Icon size={14} aria-hidden="true" /> {label}
            </button>
            {!r.ready && (
              <span id={`${ids}-${via}`} className="sr-only">
                {r.text}
              </span>
            )}
          </span>
        );
      })}
      {setup && (
        <button type="button" className="link text-xs" onClick={() => void openPage('workspace-settings', 'ai')}>
          Set up
        </button>
      )}
    </div>
  );
}
