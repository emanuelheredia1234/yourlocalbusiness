// The plan: the page to build first, this week's steps with their buttons (ticked by the app when it can see
// them done, by the owner otherwise), the plan in brief with all four weeks, the habits after them, what to
// measure (never a predicted number), and "Guide my other tabs with this strategy". At 1280px and up, a rail
// holds the angle to lead with and where to start.
import type { ReactNode } from 'react';
import { Globe, Mail, MapPin, Megaphone, Search, Store, Target, Users, Handshake, BookOpen, Compass } from 'lucide-react';
import type { Project } from '@/lib/types';
import type { ChannelType, StrategyState } from '@/lib/strategyTypes';
import { CHANNEL_LABEL, WHERE_LABEL, actionDone, currentWeek, strategyProgress, type ActionCtx } from '@/lib/strategy';
import { restartPlan } from '@/lib/strategyWrite';
import { openPage } from '@/ai/assistant/nav';
import { Markdown } from '@/components/ui/Markdown';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Empty, InfoTip, ProgressBar, Section } from '@/components/ui/primitives';
import { PlatformMark } from '@/components/posts/PlatformIcon';
import { ActionRow, BasisTip, Cite, PageCard, RunButton, SectionFooter, SourcesList, StaleNote, citedBy } from './parts';
import { ApplyPanel } from './ApplyPanel';

/** A neutral 32px tile for a channel without a network of its own. */
const CHANNEL_ICON: Record<ChannelType, ReactNode> = {
  social: <Megaphone />,
  search: <Search />,
  marketplace: <Store />,
  directory: <BookOpen />,
  community: <Users />,
  partners: <Handshake />,
  email: <Mail />,
  ads: <Target />,
  offline: <MapPin />,
  other: <Compass />,
};

export function ChannelTile({ platform, type }: { platform?: Parameters<typeof PlatformMark>[0]['platform']; type: ChannelType }) {
  if (platform) return <PlatformMark platform={platform} size={32} />;
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-3 text-ink-2 [&>svg]:size-4" aria-hidden="true">
      {CHANNEL_ICON[type] ?? <Globe />}
    </span>
  );
}

/** The rail at 1280px and up: the angle to lead with, and the channels to start with. */
function Rail({ s }: { s: StrategyState }) {
  const pr = s.promote;
  if (!pr) return null;
  const pos = pr.positioning;
  const start = pr.channels.filter((c) => c.priority === 1).slice(0, 4);
  return (
    <aside className="flex flex-col gap-4 max-xl:hidden xl:col-span-4" aria-label="Your angle and where to start">
      <section aria-label="Your angle" className="card p-5">
        <h2 className="flex items-center gap-1 text-small font-medium text-muted">
          Your angle
          <BasisTip items={[pos]} />
        </h2>
        <p className="mt-2 text-title text-ink">
          {pos.line}
          <Cite item={pos} all={s.sources} />
        </p>
        {pos.who && <p className="mt-2 text-small text-muted">Who: {pos.who}</p>}
      </section>
      {start.length > 0 && (
        <section aria-label="Where to start" className="card p-5">
          <h2 className="text-small font-medium text-muted">Where to start</h2>
          <ul className="mt-3 flex flex-col gap-3">
            {start.map((c) => (
              <li key={c.name} className="flex items-center gap-3">
                <ChannelTile platform={c.platform} type={c.channelType} />
                <span className="min-w-0">
                  <span className="block truncate text-ui text-ink" title={c.name}>
                    {c.name}
                  </span>
                  <span className="block truncate text-small text-muted">{CHANNEL_LABEL[c.channelType]}</span>
                </span>
              </li>
            ))}
          </ul>
          <button type="button" className="link mt-4 text-small" onClick={() => void openPage('strategy', 'promote')}>
            All the places to promote
          </button>
        </section>
      )}
    </aside>
  );
}

export function PlanTab({ project, s, ctx }: { project: Project; s: StrategyState; ctx: ActionCtx }) {
  const plan = s.plan;
  const biz = project.track === 'business';
  if (!plan) {
    return (
      <div>
        <PageCard project={project} s={s} />
        <Empty
          className="mt-6"
          icon={<Compass />}
          title="No plan yet"
          body="It’s the last of the six steps: Plan my strategy writes it, or Update plan → Update the plan from the research."
        />
      </div>
    );
  }
  const pr = strategyProgress(project, s, ctx);
  const w = currentWeek(plan, ctx.now);
  const week = plan.weeks.find((x) => x.week === w);
  const thisWeek = w <= 4 ? plan.actions.filter((a) => a.week === w) : plan.actions.filter((a) => !actionDone(a, project, s, ctx).done);
  const basis = plan.provider === 'local' ? 'builtin' : 'ai';
  return (
    <div>
      <StaleNote
        project={project}
        s={s}
        step="plan"
        action={
          <RunButton projectId={project.id} kind={{ kind: 'plan' }} variant="secondary" size="md" className="btn-xs" runningLabel="Writing…">
            Update the plan
          </RunButton>
        }
      />
      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-10 xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-8">
          <PageCard project={project} s={s} />

          <Section
            className="mt-10"
            title="This week"
            actions={
              w <= 4 && week ? (
                <span className="text-small text-muted">
                  Week {w} of 4 · {week.focus}
                </span>
              ) : undefined
            }
          >
            {w <= 4 && week ? (
              week.goal && <p className="-mt-2 mb-1 text-small text-muted">{week.goal}</p>
            ) : (
              <p className="-mt-2 mb-1 text-small text-muted">
                Your 4 weeks are up: keep going with the habits below and any steps still open.{' '}
                <button type="button" className="link" onClick={() => restartPlan(project.id)}>
                  Start again from week 1
                </button>
              </p>
            )}
            {thisWeek.length ? (
              <ul className="divide-y divide-line">
                {thisWeek.map((a) => (
                  <ActionRow key={a.id} project={project} s={s} action={a} ctx={ctx} />
                ))}
              </ul>
            ) : (
              <p className="py-3 text-small text-muted">{w <= 4 ? 'Nothing planned this week.' : 'Every step is done.'}</p>
            )}
          </Section>

          <Section
            title={
              <span className="inline-flex items-center gap-1">
                {biz ? 'Your plan to win clients' : 'Your plan to make sales'}
                <BasisTip items={[{ basis }]} />
              </span>
            }
          >
            <div className="max-w-[72ch] text-body text-ink-2">
              <Markdown text={plan.summary} />
            </div>
            <ProgressBar className="mt-4 max-w-sm" value={pr.done} max={pr.total || 1} label={`${pr.done} of ${pr.total} done`} />
            <Accordion type="multiple" className="mt-3 border-t border-line">
              {plan.weeks.map((wk) => {
                const list = plan.actions.filter((a) => a.week === wk.week);
                const doneN = list.filter((a) => actionDone(a, project, s, ctx).done).length;
                return (
                  <AccordionItem key={wk.week} value={`week-${wk.week}`}>
                    <AccordionTrigger>
                      <span className="min-w-0 flex-1">
                        Week {wk.week}: {wk.focus}
                        {wk.week === w && <span className="text-muted"> · this week</span>}
                      </span>
                      <span className="num shrink-0 text-small text-muted">
                        {doneN} of {list.length} done
                      </span>
                    </AccordionTrigger>
                    <AccordionContent>
                      {wk.goal && <p className="text-small text-muted">{wk.goal}</p>}
                      {list.length > 0 && (
                        <ul className="divide-y divide-line">
                          {list.map((a) => (
                            <ActionRow key={a.id} project={project} s={s} action={a} ctx={ctx} />
                          ))}
                        </ul>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>
          </Section>

          {(plan.habits.length > 0 || plan.measure.length > 0) && (
            <div className="mt-10 grid grid-cols-1 items-start gap-x-8 gap-y-10 lg:grid-cols-2">
              {plan.habits.length > 0 && (
                <Section title="Keep doing" className="mt-0">
                  <ul className="flex list-disc flex-col gap-1.5 pl-5 text-body text-ink-2 marker:text-faint">
                    {plan.habits.map((h) => (
                      <li key={h}>{h}</li>
                    ))}
                  </ul>
                </Section>
              )}
              {plan.measure.length > 0 && (
                <Section
                  className="mt-0"
                  title={
                    <span className="inline-flex items-center gap-1">
                      What to measure
                      <InfoTip label="About these numbers">No predictions: these are what to watch. The app never estimates results.</InfoTip>
                    </span>
                  }
                >
                  <ul className="flex flex-col divide-y divide-line">
                    {plan.measure.map((m) => (
                      <li key={m.what} className="py-2.5 first:pt-0">
                        <p className="text-ui text-ink">{m.what}</p>
                        <p className="mt-0.5 text-small text-muted">
                          {WHERE_LABEL[m.where]}
                          {m.why ? ` · ${m.why}` : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                  {plan.measure.some((m) => m.where === 'app') && (
                    <p className="mt-3 text-small text-muted">
                      Leads from your page arrive in{' '}
                      <button type="button" className="link" onClick={() => void openPage('marketing-email', 'leads')}>
                        Email › Leads
                      </button>
                      .
                    </p>
                  )}
                </Section>
              )}
            </div>
          )}

          <ApplyPanel project={project} s={s} />
          <SourcesList ns={citedBy([...plan.actions, s.promote?.page, s.promote?.positioning])} all={s.sources} />
          <SectionFooter project={project} s={s} step="plan" />
        </div>
        <Rail s={s} />
      </div>
    </div>
  );
}
