// The run's details, kept out of the way: the page header's "Details" holds who writes the strategy and what
// it costs, the last run's numbers (with the estimate of a step that was stopped or failed unsaved), the
// Brain switch for Strategy and how many web searches; while a run goes, the thinking strip and Stop where
// the plan appears; when it stopped, one note with Continue (paid, so it confirms first). Nothing here starts
// by itself.
import { useRef, useState } from 'react';
import type { Project } from '@/lib/types';
import type { StrategyState, StrategyStep } from '@/lib/strategyTypes';
import { STEP_LABEL } from '@/lib/strategy';
import { setMaxSearches, setUseBrain } from '@/lib/strategyWrite';
import { useRuntime } from '@/lib/platform';
import { useMediaQuery } from '@/lib/hooks';
import { fmtDate, fmtDateTime } from '@/lib/utils';
import { resolveBrain } from '@/ai/brain';
import { fmtUsdSmall } from '@/ai/meta';
import { openPage } from '@/ai/assistant/nav';
import { stopStrategy, useStrategyJob, useUnsavedCost, type StrategyJob } from '@/ai/strategyJob';
import { searchPriceText, strategyWho, type StrategyWho } from '@/ai/strategyWho';
import { useStore } from '@/store/useStore';
import { AIThinking } from '@/components/ai/AI';
import { Callout, Popover, Segmented, Skeleton, Toggle } from '@/components/ui/primitives';
import { RunButton, SettingsAILink, WithSettingsLink, writtenBy, SETTINGS_AI } from './parts';

/** Who writes it and the cost, kept in step with the server's health (keys, what they power). */
export function useWho(s: StrategyState): StrategyWho {
  useRuntime((r) => r.ai);
  useRuntime((r) => r.server);
  useRuntime((r) => r.claude);
  return strategyWho({ maxSearches: s.maxSearches });
}

/** "Anthropic Claude writes your strategy with …: 6 steps, 6 requests." and what it costs. */
export function WhoLine({ who }: { who: StrategyWho }) {
  return (
    <div className="flex flex-col gap-1 text-small">
      <p className="text-ink-2">{who.who}</p>
      {who.cost && (
        <p className="text-muted">
          <WithSettingsLink text={who.cost} />
        </p>
      )}
      {who.settings && !__ARTIFACT_BUILD__ && !/Settings (→|›) AI/.test(who.cost) && (
        <p>
          <SettingsAILink>Open {SETTINGS_AI}</SettingsAILink>
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
      <div className="flex flex-col gap-1 pl-12 text-small text-muted">
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
          <p>
            Shaped by{' '}
            {shown.map((k, i) => (
              <span key={k.id}>
                {i > 0 && ', '}
                <button type="button" className="link" onClick={() => void openPage('brain', 'skills')}>
                  {k.name}
                </button>
              </span>
            ))}
            {applied.length > shown.length && ` and ${applied.length - shown.length} more`}.
          </p>
        ) : (
          <p>No skill applies to Strategy yet. Skills set to Everywhere or Strategy will.</p>
        )}
      </div>
    </div>
  );
}

/** "Web searches: 3 · 5 · 8" (only when a key that can search powers Strategy). */
export function SearchesPicker({ project, s, who }: { project: Project; s: StrategyState; who: StrategyWho }) {
  if (who.mode !== 'web') return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id="strategy-searches" className="text-ui text-ink">
          Web searches
        </span>
        <div role="group" aria-labelledby="strategy-searches">
          <Segmented<'3' | '5' | '8'> size="sm" value={String(s.maxSearches) as '3' | '5' | '8'} onChange={(v) => setMaxSearches(project.id, Number(v) as 3 | 5 | 8)} options={[{ id: '3', label: '3' }, { id: '5', label: '5' }, { id: '8', label: '8' }]} />
        </div>
      </div>
      <p className="text-small text-muted">The most step 1 may make. Fewer cost less.</p>
    </div>
  );
}

/** The last run in numbers: when, who wrote it, web searches, cost (with a stopped step's estimate) and requests. */
export function RunFacts({ project, s }: { project: Project; s: StrategyState }) {
  const unsaved = useUnsavedCost(project.id);
  const run = s.run;
  if (!run) return null;
  const done = run.done.map((k) => ({ step: k, info: s[k] })).filter((x) => !!x.info);
  // who wrote the run's steps (research and the rest can come from different keys)
  const writers = [...new Set(done.map((x) => (x.info!.provider === 'local' ? 'Built-in engine (free)' : writtenBy(x.info!))))];
  const searches = run.done.includes('research') ? s.research?.meta?.searches ?? 0 : 0;
  const cost = done.reduce((t, x) => t + (x.info!.meta?.costUsd ?? 0), 0);
  const requests = done.filter((x) => x.info!.provider !== 'local').length;
  const extra = unsaved && unsaved.runAt === run.startedAt ? unsaved : null;
  const rows: [string, string][] = [
    ['When', fmtDateTime(run.finishedAt ?? run.startedAt)],
    ...(writers.length ? [['Written by', writers.join(', ')] as [string, string]] : []),
    ...(searches ? [['Web searches', String(searches)] as [string, string]] : []),
    ...(cost > 0 ? [['Cost', `≈${fmtUsdSmall(cost)}`] as [string, string]] : []),
    ...(requests ? [['Requests', String(requests)] as [string, string]] : []),
  ];
  return (
    <div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-small">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="num min-w-0 break-words text-ink-2">{v}</dd>
          </div>
        ))}
        {extra && (
          <div className="contents">
            <dt className="text-muted">Not saved</dt>
            <dd className="num min-w-0 text-ink-2">{extra.estimate ? `≈${fmtUsdSmall(extra.usd)} or more, estimated` : `≈${fmtUsdSmall(extra.usd)}`}</dd>
          </div>
        )}
      </dl>
      {extra && (
        <p className="mt-1.5 text-caption text-muted">
          {extra.estimate
            ? `Step ${run.steps.indexOf(extra.step) + 1} stopped before it was saved, but its web searches may already be billed: up to ${extra.searches} at ${searchPriceText(extra.perSearch ?? 0)} each (list price), plus the pages it read.`
            : `Step ${run.steps.indexOf(extra.step) + 1}’s answer couldn’t be used, so it wasn’t saved, but it was billed.`}
        </p>
      )}
    </div>
  );
}

/** What the page header's Details holds. */
export function RunDetails({ project, s, who }: { project: Project; s: StrategyState; who: StrategyWho }) {
  return (
    <div className="flex flex-col divide-y divide-line">
      <div className="pb-3">
        <p className="mb-1.5 text-small font-semibold text-ink">Who writes it and the cost</p>
        <WhoLine who={who} />
      </div>
      {s.run && (
        <div className="py-3">
          <p className="mb-1.5 text-small font-semibold text-ink">Last run</p>
          <RunFacts project={project} s={s} />
        </div>
      )}
      <div className="py-3">
        <BrainLine project={project} s={s} />
      </div>
      {who.mode === 'web' && (
        <div className="pt-3">
          <SearchesPicker project={project} s={s} who={who} />
        </div>
      )}
    </div>
  );
}

/** The "Details" link (and its popover) in the page header. */
export function RunDetailsLink({ project, s, who, children = 'Details' }: { project: Project; s: StrategyState; who: StrategyWho; children?: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} type="button" className="link text-small" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)}>
        {children}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="start" className="w-80 max-w-[calc(100vw-16px)] p-4">
        <RunDetails project={project} s={s} who={who} />
      </Popover>
    </>
  );
}

/** "Updated Nov 4 · Details" once something is written, else "Who writes it and the cost". */
export function RunMeta({ project, s, who, saved }: { project: Project; s: StrategyState; who: StrategyWho; saved: boolean }) {
  const updated = saved && s.updatedAt > 0;
  return (
    <>
      {updated && (
        <>
          <span>Updated {fmtDate(s.updatedAt)}</span>
          <span aria-hidden="true">·</span>
        </>
      )}
      <RunDetailsLink project={project} s={s} who={who}>
        {updated ? 'Details' : 'Who writes it and the cost'}
      </RunDetailsLink>
    </>
  );
}

/** While a run goes: the thinking strip with its step and Stop, where the plan appears, over AI skeletons when there's nothing to show yet. */
export function RunningBlock({ job, skeleton }: { job: StrategyJob; skeleton: boolean }) {
  const step: StrategyStep = job.steps[job.index] ?? job.steps[0];
  const of = `Step ${job.index + 1} of ${job.steps.length}`;
  // a phone's strip keeps its width for the stage ("Researching your market…"): the step goes on the line under it
  const wide = useMediaQuery('(min-width: 640px)');
  return (
    <section aria-label="Plan my strategy" className="mb-6">
      <AIThinking running stage={`${STEP_LABEL[step]}…`} step={wide ? of : undefined} onStop={() => stopStrategy(job.projectId)} />
      <p className="mt-2 text-caption text-muted">
        {!wide && <span className="num">{of} · </span>}
        It keeps going while you use other pages. Closing or reloading this tab stops it.
      </p>
      {skeleton && (
        <div className="mt-6 grid grid-cols-1 items-start gap-4 xl:grid-cols-12" aria-hidden="true">
          <div className="flex flex-col gap-4 xl:col-span-8">
            <div className="card flex gap-5 p-5">
              <Skeleton ai className="h-[90px] w-[120px] shrink-0 rounded-pop" />
              <div className="flex flex-1 flex-col gap-3 pt-1">
                <Skeleton ai className="h-3 w-28" />
                <Skeleton ai className="h-6 w-1/2" />
                <Skeleton ai className="h-4 w-11/12" />
                <Skeleton ai className="h-4 w-3/4" />
              </div>
            </div>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 px-1 py-2">
                <Skeleton ai className="h-5 w-5 shrink-0 rounded-full" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton ai className="h-4 w-2/3" />
                  <Skeleton ai className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
          <div className="card flex flex-col gap-3 p-5 max-xl:hidden xl:col-span-4">
            <Skeleton ai className="h-3 w-24" />
            <Skeleton ai className="h-5 w-full" />
            <Skeleton ai className="h-5 w-4/5" />
          </div>
        </div>
      )}
    </section>
  );
}

/** When the last run stopped (Stop, a failure, or the page closed): why, and Continue from where it stopped. */
export function StoppedNote({ project, s }: { project: Project; s: StrategyState }) {
  const job = useStrategyJob(project.id);
  const run = s.run;
  if (!run || job || run.finishedAt) return null;
  const stopIndex = run.stoppedAt ? run.steps.indexOf(run.stoppedAt) + 1 : run.steps.findIndex((k) => !run.done.includes(k)) + 1;
  if (stopIndex <= 0) return null;
  const kind = { kind: 'continue' as const, steps: run.steps as StrategyStep[], from: stopIndex };
  return (
    <Callout
      tone="warn"
      className="mb-6"
      action={
        <RunButton projectId={project.id} kind={kind} variant="secondary" size="md" className="btn-xs" runningLabel="Writing…">
          {run.stoppedAt ? `Continue from step ${stopIndex}` : 'Continue'}
        </RunButton>
      }
    >
      {run.stoppedAt ? run.note ? <WithSettingsLink text={run.note} /> : `Stopped at step ${stopIndex} of ${run.steps.length}.` : `The last run stopped at step ${stopIndex} of ${run.steps.length} (the page was closed).`}
    </Callout>
  );
}
