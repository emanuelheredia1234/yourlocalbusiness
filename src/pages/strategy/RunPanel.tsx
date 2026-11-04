// The run area: who writes the strategy and what it costs, the Brain switch for Strategy, how many web
// searches, Plan my strategy; while a run goes, its progress and Stop; after it, one summary line, and
// Continue when it stopped (paid, so it confirms first). Nothing here starts by itself.
import { useEffect, useState } from 'react';
import { Brain, Sparkles, Square } from 'lucide-react';
import type { Project } from '@/lib/types';
import type { StrategyState, StrategyStep } from '@/lib/strategyTypes';
import { STEP_LABEL } from '@/lib/strategy';
import { setMaxSearches, setUseBrain } from '@/lib/strategyWrite';
import { useRuntime } from '@/lib/platform';
import { cn, fmtDateTime } from '@/lib/utils';
import { resolveBrain } from '@/ai/brain';
import { fmtUsdSmall } from '@/ai/meta';
import { openPage } from '@/ai/assistant/nav';
import { stopStrategy, useStrategyJob, type StrategyJob } from '@/ai/strategyJob';
import { strategyWho, type StrategyWho } from '@/ai/strategyWho';
import { useStore } from '@/store/useStore';
import { Segmented, Toggle } from '@/components/ui/primitives';
import { Banner, WithSettingsLink, SettingsAILink } from './parts';
import { startRun } from './runs';

/** Who writes it and the cost, kept in step with the server's health (keys, what they power). */
export function useWho(s: StrategyState): StrategyWho {
  useRuntime((r) => r.ai);
  useRuntime((r) => r.server);
  useRuntime((r) => r.claude);
  return strategyWho({ maxSearches: s.maxSearches });
}

/** "Anthropic Claude writes your strategy with … : 6 steps, 6 requests." and what it costs. */
export function WhoLine({ who }: { who: StrategyWho }) {
  return (
    <div className="flex flex-col gap-1 text-[13px]">
      <p className="font-medium text-ink">{who.who}</p>
      {who.cost && (
        <p className="text-muted">
          <WithSettingsLink text={who.cost} />
        </p>
      )}
      {who.settings && !__ARTIFACT_BUILD__ && !who.cost.includes('Settings → AI') && (
        <p>
          <SettingsAILink>Open Settings → AI</SettingsAILink>
        </p>
      )}
    </div>
  );
}

/** "Use my Brain skills here": the skills that shape Strategy for this project, or why none do. */
export function BrainLine({ project, s }: { project: Project; s: StrategyState }) {
  const skills = useStore((st) => st.skills);
  const appOn = useStore((st) => st.settings.ai.useBrain);
  const applied = resolveBrain(skills, 'strategy', appOn, project.id).skills;
  const shown = applied.slice(0, 4);
  return (
    <div className="flex flex-col gap-1.5">
      <Toggle checked={s.useBrain} disabled={!appOn} onChange={(on) => setUseBrain(project.id, on)} label="Use my Brain skills here" />
      <div className="flex flex-col gap-1 pl-12 text-xs text-muted">
        {!appOn ? (
          <p>
            The Brain is off for the whole app. Turn it on in the Brain.{' '}
            <button type="button" className="link" onClick={() => void openPage('brain', 'skills')}>
              Open the Brain
            </button>
          </p>
        ) : !s.useBrain ? (
          <p>Strategy ignores your Brain skills. Your other tabs still use them.</p>
        ) : applied.length ? (
          <p className="flex flex-wrap items-center gap-1.5">
            <span>These skills shape the strategy:</span>
            {shown.map((k) => (
              <button key={k.id} type="button" className="chip h-6" onClick={() => void openPage('brain', 'skills')}>
                <Brain size={11} /> {k.name}
              </button>
            ))}
            {applied.length > shown.length && <span>+{applied.length - shown.length} more</span>}
          </p>
        ) : (
          <p>No skill applies to Strategy yet. Skills set to Everywhere or Strategy will.</p>
        )}
        <p>To make a skill shape Strategy only, choose Strategy under “Applies to” in the Brain.</p>
      </div>
    </div>
  );
}

/** "Web searches: 3 · 5 · 8" (only when a key that can search powers Strategy). */
export function SearchesPicker({ project, s, who }: { project: Project; s: StrategyState; who: StrategyWho }) {
  if (who.mode !== 'web') return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <span id="strategy-searches" className="font-medium text-ink-2">
        Web searches:
      </span>
      <div aria-labelledby="strategy-searches">
        <Segmented<'3' | '5' | '8'> size="sm" value={String(s.maxSearches) as '3' | '5' | '8'} onChange={(v) => setMaxSearches(project.id, Number(v) as 3 | 5 | 8)} options={[{ id: '3', label: '3' }, { id: '5', label: '5' }, { id: '8', label: '8' }]} />
      </div>
      <span className="text-xs text-muted">The most step 1 may make. Fewer cost less.</span>
    </div>
  );
}

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

/** "Step 2 of 6 · Choosing where to promote…", Stop and the time so far. */
export function ProgressLine({ job }: { job: StrategyJob }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const step = job.steps[job.index] ?? job.steps[0];
  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-surface px-4 py-3">
      <div className="absolute inset-x-0 top-0 h-[2px] overflow-hidden" aria-hidden="true">
        <div className="h-full w-1/3 animate-[shimmer_1.4s_linear_infinite] bg-gradient-to-r from-transparent via-accent to-transparent" style={{ backgroundSize: '200% 100%' }} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink text-accent" aria-hidden="true">
          <Sparkles size={14} />
          <span className="absolute inset-0 animate-ping rounded-full bg-accent/25" />
        </span>
        <p className="min-w-0 flex-1 text-[13px] font-semibold text-ink" role="status" aria-live="polite">
          Step {job.index + 1} of {job.steps.length} · {STEP_LABEL[step]}…
        </p>
        <span className="num text-xs text-muted" aria-label="Time so far">
          {elapsed(now - job.startedAt)}
        </span>
        <button type="button" className="btn btn-secondary btn-xs" onClick={() => stopStrategy(job.projectId)}>
          <Square size={11} className="fill-current" /> Stop
        </button>
      </div>
      <p className="mt-1.5 text-xs text-muted">You can use other pages meanwhile: it keeps going. Closing or reloading the tab stops it.</p>
    </div>
  );
}

/** The last run in one line, and what to do when it stopped. */
export function RunSummary({ project, s }: { project: Project; s: StrategyState }) {
  const job = useStrategyJob(project.id);
  const run = s.run;
  if (!run || job) return null;
  const done = run.done.map((k) => ({ step: k, info: s[k] })).filter((x) => !!x.info);
  // who wrote the run's steps (research and the rest can come from different keys)
  const writers = [...new Set(done.filter((x) => x.info!.provider !== 'local').map((x) => (x.info!.provider === 'claude' ? 'Claude in claude.ai' : x.info!.meta ? `${x.info!.meta.providerLabel} · ${x.info!.meta.model}` : 'Your AI')))];
  const who = writers.length ? writers.join(', ') : 'Built-in engine (free)';
  const searches = run.done.includes('research') ? s.research?.meta?.searches ?? 0 : 0;
  const cost = done.reduce((t, x) => t + (x.info!.meta?.costUsd ?? 0), 0);
  const requests = done.filter((x) => x.info!.provider !== 'local').length;
  const stopIndex = run.stoppedAt ? run.steps.indexOf(run.stoppedAt) + 1 : run.steps.findIndex((k) => !run.done.includes(k)) + 1;
  const interrupted = !run.finishedAt && !run.stoppedAt && stopIndex > 0;
  const parts = [
    `Last run ${fmtDateTime(run.finishedAt ?? run.startedAt)}`,
    who,
    searches ? `${searches} web search${searches === 1 ? '' : 'es'}` : '',
    cost > 0 ? `≈${fmtUsdSmall(cost)}` : '',
    requests ? `${requests} request${requests === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  const cont = (from: number) => void startRun(project.id, { kind: 'continue', steps: run.steps as StrategyStep[], from });
  return (
    <div className="flex flex-col gap-2">
      {done.length > 0 && <p className="num text-xs text-muted">{parts.join(' · ')}</p>}
      {run.stoppedAt && (
        <Banner className="flex flex-wrap items-center justify-between gap-2">
          <span>{run.note ? run.note : `Stopped at step ${stopIndex}.`}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => cont(stopIndex)}>
            Continue from step {stopIndex}
          </button>
        </Banner>
      )}
      {interrupted && (
        <Banner className="flex flex-wrap items-center justify-between gap-2">
          <span>
            The last run stopped at step {stopIndex} of {run.steps.length} (the page was closed).
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => cont(stopIndex)}>
            Continue
          </button>
        </Banner>
      )}
    </div>
  );
}

/**
 * The first visit's run panel: who and the cost, the Brain line, the searches, Plan my strategy.
 * `compact`: under the tabs once something is saved (progress or the summary, the rest folded away).
 */
export function RunPanel({ project, s, compact }: { project: Project; s: StrategyState; compact?: boolean }) {
  const job = useStrategyJob(project.id);
  const who = useWho(s);
  if (compact) {
    return (
      <div className="flex flex-col gap-2">
        {job ? <ProgressLine job={job} /> : <RunSummary project={project} s={s} />}
        <details className="group rounded-md border border-line bg-surface px-3 py-2">
          <summary className="cursor-pointer select-none text-[13px] font-semibold text-ink-2 marker:text-muted">Who writes it, Brain skills and web searches</summary>
          <div className="mt-3 flex flex-col gap-3 pb-1">
            <WhoLine who={who} />
            <BrainLine project={project} s={s} />
            <SearchesPicker project={project} s={s} who={who} />
          </div>
        </details>
      </div>
    );
  }
  return (
    <section className="panel flex flex-col gap-4 p-4 sm:p-5" aria-label="Plan my strategy">
      <div>
        <p className="eyebrow mb-1.5">Who does it and the cost</p>
        <WhoLine who={who} />
      </div>
      <BrainLine project={project} s={s} />
      <SearchesPicker project={project} s={s} who={who} />
      {job ? (
        <ProgressLine job={job} />
      ) : (
        <div>
          <button type="button" className={cn('btn btn-ai')} disabled={who.mode === 'checking'} onClick={() => void startRun(project.id, { kind: 'all' })}>
            <Sparkles size={15} className="text-accent" /> Plan my strategy
          </button>
        </div>
      )}
    </section>
  );
}
