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
import { Spinner } from '@/components/ui/primitives';
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
    <section className="panel flex flex-col gap-3 p-4 sm:p-5" aria-label="Deep research with Manus">
      <div>
        <p className="eyebrow mb-1">Optional</p>
        <h2 className="section-title">Deep research with Manus</h2>
      </div>
      <p className="text-[13px] text-ink-2">Manus, an AI agent with its own browser, opens up to 15 public pages about your market and reports what each page says, with its link. It takes several minutes and uses your Manus credits (the amount depends on the task; the app shows it when it’s done). It only reads: it never signs in, posts, messages or buys.</p>
      <p className="text-xs text-muted">
        What Manus gets: your niche, your {what}
        {project.track === 'business' && project.location?.city ? ', and your city' : ''} — nothing else from your project.
      </p>

      {m?.state === 'working' && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-2.5 text-[13px]" role="status">
          <Spinner size={14} className="text-primary" />
          <span className="min-w-0 flex-1">Manus is reading pages… checked {fmtRelative(m.checkedAt ?? m.requestedAt)}.</span>
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => void checkNow(project.id)}>
            <RefreshCw size={12} /> Check now
          </button>
          <a className="btn btn-ghost btn-xs" href={m.taskUrl} target="_blank" rel="noopener noreferrer">
            Open in Manus <ExternalLink size={12} />
          </a>
        </div>
      )}
      {m?.state === 'needs_input' && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-warn-soft px-3 py-2.5 text-[13px]" role="status">
          <span className="min-w-0 flex-1">Manus is waiting for you.</span>
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => void checkNow(project.id)}>
            <RefreshCw size={12} /> Check now
          </button>
          <a className="btn btn-secondary btn-xs" href={m.taskUrl} target="_blank" rel="noopener noreferrer">
            Open in Manus <ExternalLink size={12} />
          </a>
        </div>
      )}
      {m?.state === 'done' && (
        <p className="num text-[13px] text-ink-2">
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
      {m?.state === 'failed' && <p className="rounded-md bg-warn-soft px-3 py-2.5 text-[13px] text-ink">{m.message || 'Manus stopped without a report.'}</p>}

      {!busy && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-secondary" disabled={!deep.ok} onClick={() => void startDeepResearch(project.id)}>
            <Telescope size={15} /> {m?.state === 'failed' || m?.state === 'done' ? 'Start again…' : 'Start deep research…'}
          </button>
          {!deep.ok && deep.reason && (
            <span className="text-xs text-muted">
              <WithSettingsLink text={deep.reason} />
            </span>
          )}
        </div>
      )}
    </section>
  );
}
