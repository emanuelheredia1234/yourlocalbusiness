// Deep research with Manus (optional; self-hosted only): Manus opens public pages about the market and
// reports what each says, with its link. Starting it is one paid action behind a confirm; the app checks
// the task every 45 seconds (or on Check now) and never starts or retries it by itself.
import { ExternalLink, RefreshCw, Telescope } from 'lucide-react';
import type { Project } from '@/lib/types';
import type { StrategyState } from '@/lib/strategyTypes';
import { fmtDate, fmtRelative } from '@/lib/utils';
import { checkNow, startDeepResearch } from '@/ai/strategyManus';
import { strategyWho } from '@/ai/strategyWho';
import { useRuntime } from '@/lib/platform';
import { Callout, InfoTip, Section, Spinner } from '@/components/ui/primitives';
import { WithSettingsLink } from './parts';

export function DeepResearch({ project, s }: { project: Project; s: StrategyState }) {
  useRuntime((r) => r.ai);
  useRuntime((r) => r.server);
  const deep = strategyWho().deep;
  if (!deep.show) return null;
  const m = s.manus;
  const what = project.track === 'business' ? 'business type' : 'product type';
  const busy = m?.state === 'working' || m?.state === 'needs_input';
  return (
    <Section
      divider
      title={
        <span className="inline-flex items-center gap-1">
          Deep research with Manus
          <InfoTip label="About deep research" title="Deep research with Manus">
            <p>Manus, an AI agent with its own browser, opens up to 15 public pages about your market and reports what each page says, with its link. It takes several minutes and uses your Manus credits (the amount depends on the task; the app shows it when it’s done). It only reads: it never signs in, posts, messages or buys.</p>
            <p className="mt-2">
              What Manus gets: your niche, your {what}
              {project.track === 'business' && project.location?.city ? ', and your city' : ''}, nothing else from your project.
            </p>
          </InfoTip>
        </span>
      }
      description="Optional: Manus reads public pages about your market and reports what each says, with its link."
    >
      {m?.state === 'working' && (
        <div className="well flex flex-wrap items-center gap-2 px-3 py-2.5 text-small" role="status">
          <Spinner size={14} className="text-primary" />
          <span className="min-w-0 flex-1 text-ink-2">Manus is reading pages… checked {fmtRelative(m.checkedAt ?? m.requestedAt)}.</span>
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => void checkNow(project.id)}>
            <RefreshCw /> Check now
          </button>
          <a className="btn btn-ghost btn-xs" href={m.taskUrl} target="_blank" rel="noopener noreferrer">
            Open in Manus <ExternalLink />
          </a>
        </div>
      )}
      {m?.state === 'needs_input' && (
        <Callout
          tone="warn"
          action={
            <>
              <button type="button" className="btn btn-secondary btn-xs" onClick={() => void checkNow(project.id)}>
                <RefreshCw /> Check now
              </button>
              <a className="btn btn-secondary btn-xs" href={m.taskUrl} target="_blank" rel="noopener noreferrer">
                Open in Manus <ExternalLink />
              </a>
            </>
          }
        >
          <span role="status">Manus is waiting for you.</span>
        </Callout>
      )}
      {m?.state === 'done' && (
        <p className="num text-small text-ink-2">
          Manus read {m.pagesRead ?? 0} page{m.pagesRead === 1 ? '' : 's'}
          {m.credits ? ` · ${m.credits} credits` : ''} · {fmtDate(m.doneAt ?? m.checkedAt ?? m.requestedAt, { month: 'short', day: 'numeric', year: 'numeric' })}
          {m.taskUrl && (
            <>
              {' · '}
              <a className="link" href={m.taskUrl} target="_blank" rel="noopener noreferrer">
                Open in Manus
              </a>
            </>
          )}
        </p>
      )}
      {m?.state === 'failed' && <Callout tone="warn">{m.message || 'Manus stopped without a report.'}</Callout>}

      {!busy && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <button type="button" className="btn btn-secondary btn-sm" disabled={!deep.ok} onClick={() => void startDeepResearch(project.id)}>
            <Telescope /> {m?.state === 'failed' || m?.state === 'done' ? 'Start again…' : 'Start deep research…'}
          </button>
          {!deep.ok && deep.reason && (
            <span className="text-small text-muted">
              <WithSettingsLink text={deep.reason} />
            </span>
          )}
        </div>
      )}
    </Section>
  );
}
