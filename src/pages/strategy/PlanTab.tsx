// The plan: this week's actions with "Do it" buttons (ticked by the app when it can see them done, by the
// owner otherwise), all four weeks, the habits after them, what to measure (never a predicted number),
// and "Guide my other tabs with this strategy".
import type { Project } from '@/lib/types';
import type { StrategyState } from '@/lib/strategyTypes';
import { WHERE_LABEL, actionDone, currentWeek, strategyProgress, type ActionCtx } from '@/lib/strategy';
import { restartPlan } from '@/lib/strategyWrite';
import { openPage } from '@/ai/assistant/nav';
import { Markdown } from '@/components/ui/Markdown';
import { ProgressRing } from '@/components/ui/primitives';
import { ActionRow, Banner, BasisBadge, PageCard, SectionFooter, SourcesList, beforeResearch, citedBy, detailsChanged } from './parts';
import { ApplyPanel } from './ApplyPanel';
import { startRun } from './runs';

export function PlanTab({ project, s, ctx }: { project: Project; s: StrategyState; ctx: ActionCtx }) {
  const plan = s.plan;
  const biz = project.track === 'business';
  if (!plan) {
    return (
      <div className="flex flex-col gap-4">
        <p className="rounded-md bg-surface-2 px-3 py-6 text-center text-[13px] text-muted">No plan yet. It’s the last of the six steps: Plan my strategy writes it, or Update… → Update the plan from the research.</p>
        <PageCard project={project} s={s} />
      </div>
    );
  }
  const pr = strategyProgress(project, s, ctx);
  const w = currentWeek(plan, ctx.now);
  const week = plan.weeks.find((x) => x.week === w);
  const thisWeek = w <= 4 ? plan.actions.filter((a) => a.week === w) : plan.actions.filter((a) => !actionDone(a, project, s, ctx).done);
  const basis = plan.provider === 'local' ? 'builtin' : 'ai';
  return (
    <div className="flex flex-col gap-5">
      {detailsChanged(project, s, plan) && (
        <Banner className="flex flex-wrap items-center justify-between gap-2">
          <span>Your details changed since this plan was written.</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void startRun(project.id, { kind: 'plan' })}>
            Update the plan
          </button>
        </Banner>
      )}
      {beforeResearch(s, 'plan') && (
        <Banner className="flex flex-wrap items-center justify-between gap-2">
          <span>This plan was written before your latest research.</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void startRun(project.id, { kind: 'plan' })}>
            Update the plan from it
          </button>
        </Banner>
      )}

      <section className="panel flex flex-col gap-3 p-4 sm:p-5" aria-label="Your plan">
        <div className="flex items-start gap-4">
          <ProgressRing value={pr.total ? pr.done / pr.total : 0} size={52} label={`${pr.done}/${pr.total}`} />
          <div className="min-w-0 flex-1">
            <h2 className="section-title">{biz ? 'Your plan to win clients' : 'Your plan to make sales'}</h2>
            <p className="text-xs text-muted">
              {pr.done} of {pr.total} done
            </p>
          </div>
        </div>
        <div className="text-[13.5px] text-ink-2">
          <Markdown text={plan.summary} />
        </div>
        <BasisBadge basis={basis} all={s.sources} />
      </section>

      <PageCard project={project} s={s} />

      <section className="flex flex-col gap-2.5" aria-label="This week">
        {w <= 4 && week ? (
          <div>
            <h2 className="section-title">
              This week · Week {w} of 4: {week.focus}
            </h2>
            {week.goal && <p className="text-[13px] text-muted">{week.goal}</p>}
          </div>
        ) : (
          <div>
            <h2 className="section-title">After the four weeks</h2>
            <p className="text-[13px] text-muted">
              Your 4 weeks are up: keep going with the habits below and any steps still open.{' '}
              <button type="button" className="link" onClick={() => restartPlan(project.id)}>
                Start again from week 1
              </button>
            </p>
          </div>
        )}
        {thisWeek.length ? (
          <ul className="flex flex-col gap-2">
            {thisWeek.map((a) => (
              <ActionRow key={a.id} project={project} s={s} action={a} ctx={ctx} />
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted">{w <= 4 ? 'Nothing planned this week.' : 'Every step is done.'}</p>
        )}
      </section>

      <section className="flex flex-col gap-2" aria-label="All 4 weeks">
        <h2 className="section-title">All 4 weeks</h2>
        {plan.weeks.map((wk) => {
          const list = plan.actions.filter((a) => a.week === wk.week);
          const doneN = list.filter((a) => actionDone(a, project, s, ctx).done).length;
          return (
            <details key={wk.week} className="group rounded-md border border-line bg-surface px-3 py-2.5" open={wk.week === w}>
              <summary className="flex cursor-pointer select-none flex-wrap items-baseline justify-between gap-2 marker:text-muted">
                <span className="text-[13.5px] font-semibold text-ink">
                  Week {wk.week}: {wk.focus}
                </span>
                <span className="text-xs text-muted">
                  {doneN} of {list.length} done
                </span>
              </summary>
              {wk.goal && <p className="mt-1 text-[13px] text-muted">{wk.goal}</p>}
              {list.length > 0 && (
                <ul className="mt-2 flex flex-col gap-2">
                  {list.map((a) => (
                    <ActionRow key={a.id} project={project} s={s} action={a} ctx={ctx} />
                  ))}
                </ul>
              )}
            </details>
          );
        })}
      </section>

      {plan.habits.length > 0 && (
        <section className="panel p-4" aria-label="Keep doing">
          <h2 className="section-title mb-2">Keep doing</h2>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13.5px] text-ink-2">
            {plan.habits.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </section>
      )}

      {plan.measure.length > 0 && (
        <section className="panel p-4" aria-label="What to measure">
          <h2 className="section-title mb-2">What to measure</h2>
          <ul className="flex flex-col divide-y divide-line">
            {plan.measure.map((m) => (
              <li key={m.what} className="flex flex-col gap-0.5 py-2 text-[13px] sm:flex-row sm:items-baseline sm:gap-2">
                <span className="font-semibold text-ink">{m.what}</span>
                <span className="text-muted">· {WHERE_LABEL[m.where]}</span>
                {m.why && <span className="text-ink-2 sm:ml-auto sm:text-right">{m.why}</span>}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            No predictions: these are what to watch. The app never estimates results.
            {plan.measure.some((m) => m.where === 'app') && (
              <>
                {' '}
                Leads from your page arrive in{' '}
                <button type="button" className="link" onClick={() => void openPage('marketing-email', 'leads')}>
                  Email → Leads
                </button>
                .
              </>
            )}
          </p>
        </section>
      )}

      <SourcesList ns={citedBy(plan.actions)} all={s.sources} title="Sources this plan cites" />
      <ApplyPanel project={project} s={s} />
      <SectionFooter project={project} s={s} step="plan" />
    </div>
  );
}
