// Research: what a web search found, each finding with its sources and the date (or labelled the AI's
// general knowledge), what Manus read, what to check yourself, and every source as found.
import type { Project } from '@/lib/types';
import type { FindingTopic, StrategyFinding, StrategyState } from '@/lib/strategyTypes';
import { FINDING_TOPICS } from '@/lib/strategyNormalize';
import { TOPIC_LABEL } from '@/lib/strategy';
import { fmtDate } from '@/lib/utils';
import { Markdown } from '@/components/ui/Markdown';
import { Backing, Banner, BasisBadge, SectionFooter, SourcesList, WithSettingsLink, beforeResearch, citedBy, reasonCopy } from './parts';
import { DeepResearch } from './DeepResearch';
import { startRun } from './runs';

const DAY = 86_400_000;

function Findings({ list, s, manus }: { list: StrategyFinding[]; s: StrategyState; manus?: boolean }) {
  const groups = FINDING_TOPICS.map((t) => [t, list.filter((f) => f.topic === t)] as [FindingTopic, StrategyFinding[]]).filter(([, l]) => l.length);
  return (
    <div className="flex flex-col gap-4">
      {groups.map(([topic, items]) => (
        <section key={topic} aria-label={TOPIC_LABEL[topic]}>
          <h3 className="mb-1.5 text-[13.5px] font-semibold text-ink">{TOPIC_LABEL[topic]}</h3>
          <ul className="flex flex-col gap-2">
            {items.map((f) => (
              <li key={f.text} className="rounded-md border border-line bg-surface px-3 py-2.5">
                <p className="text-[13.5px] text-ink">{f.text}</p>
                <Backing item={f} all={s.sources} className="mt-1.5" manus={manus} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function ResearchTab({ project, s }: { project: Project; s: StrategyState }) {
  const r = s.research;
  const m = s.manus;
  const manusFindings = m?.state === 'done' ? m.findings ?? [] : [];
  const later = (['promote', 'content', 'assets', 'outreach', 'plan'] as const).some((k) => beforeResearch(s, k));
  const age = r ? Math.floor((Date.now() - r.at) / DAY) : 0;
  return (
    <div className="flex flex-col gap-5">
      {m?.state === 'done' && manusFindings.length > 0 && later && (
        <Banner tone="info" className="flex flex-wrap items-center justify-between gap-2">
          <span>New findings from Manus.</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void startRun(project.id, { kind: 'plan' })}>
            Update the plan from them (5 requests)
          </button>
        </Banner>
      )}

      {!r ? (
        <p className="rounded-md bg-surface-2 px-3 py-6 text-center text-[13px] text-muted">No research yet. It’s the first of the six steps: Plan my strategy writes it.</p>
      ) : (
        <section className="panel flex flex-col gap-4 p-4 sm:p-5" aria-label="Research">
          {r.mode === 'web' ? (
            <p className="num text-xs text-muted">
              Searched the web on {fmtDate(r.at, { month: 'short', day: 'numeric', year: 'numeric' })} · {r.searches} search{r.searches === 1 ? '' : 'es'}
              {r.meta ? ` · ${r.meta.providerLabel} (${r.meta.model})` : ''}
            </p>
          ) : r.mode === 'builtin' ? (
            <p className="text-xs text-muted">No research yet.</p>
          ) : (
            <Banner>
              <WithSettingsLink text={reasonCopy(r.reason, r.meta?.providerLabel || (r.provider === 'claude' ? 'Claude' : 'Your AI'))} />
              {r.reason === 'not_used' && (
                <>
                  {' '}
                  <button type="button" className="link" onClick={() => void startRun(project.id, { kind: 'research' })}>
                    Search again
                  </button>
                </>
              )}
            </Banner>
          )}
          {age > 30 && <p className="text-xs text-muted">This research is {age} days old. Web pages change: search again when you need fresh findings.</p>}

          {r.mode === 'builtin' ? (
            <p className="text-[13.5px] text-ink-2">With an AI key that can search the web, Strategy looks up where buyers in your market look and what gets attention, with a link to every source.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="text-[13.5px] text-ink-2">
                <Markdown text={r.summary} />
              </div>
              {r.mode !== 'web' && <BasisBadge basis="ai" all={s.sources} />}
            </div>
          )}

          {r.findings.length > 0 && <Findings list={r.findings} s={s} />}

          {r.checks.length > 0 && (
            <section aria-label="Check it yourself">
              <h3 className="mb-1.5 text-[13.5px] font-semibold text-ink">Check it yourself (free)</h3>
              <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[13.5px] text-ink-2">
                {r.checks.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ol>
              <BasisBadge basis="builtin" all={s.sources} />
            </section>
          )}

          {r.queries.length > 0 && (
            <details className="text-[13px]">
              <summary className="cursor-pointer select-none font-semibold text-ink-2">Searched for</summary>
              <ul className="mt-1.5 flex list-disc flex-col gap-0.5 pl-5 text-ink-2">
                {r.queries.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {manusFindings.length > 0 && (
        <section className="panel flex flex-col gap-3 p-4 sm:p-5" aria-label="Findings Manus read">
          <div>
            <h2 className="section-title">Findings Manus read</h2>
            <p className="text-[12.5px] text-muted">Manus reports what each page says; the app can’t check it.</p>
          </div>
          <Findings list={manusFindings} s={s} manus />
        </section>
      )}

      <SourcesList ns={citedBy([...(r?.findings ?? []), ...manusFindings])} all={s.sources} manusRead={new Set(citedBy(manusFindings))} />
      <DeepResearch project={project} s={s} />
      <SectionFooter project={project} s={s} step="research" />
    </div>
  );
}
