// Research: what a web search found, each finding with its source numbers and the date (or an ⓘ when it's
// the AI's general knowledge), what Manus read, what to check yourself, and every source as found.
import { Search } from 'lucide-react';
import type { Project } from '@/lib/types';
import type { FindingTopic, StrategyFinding, StrategyState } from '@/lib/strategyTypes';
import { FINDING_TOPICS } from '@/lib/strategyNormalize';
import { TOPIC_LABEL } from '@/lib/strategy';
import { fmtDate } from '@/lib/utils';
import { Markdown } from '@/components/ui/Markdown';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Callout, Empty, InfoTip, Section } from '@/components/ui/primitives';
import { BasisTip, Cite, RunButton, SectionFooter, SourcesList, WithSettingsLink, beforeResearch, citedBy, reasonCopy } from './parts';
import { DeepResearch } from './DeepResearch';

const DAY = 86_400_000;

function Findings({ list, s }: { list: StrategyFinding[]; s: StrategyState }) {
  const groups = FINDING_TOPICS.map((t) => [t, list.filter((f) => f.topic === t)] as [FindingTopic, StrategyFinding[]]).filter(([, l]) => l.length);
  return (
    <div className="flex flex-col gap-6">
      {groups.map(([topic, items]) => (
        <section key={topic} aria-label={TOPIC_LABEL[topic]}>
          <h3 className="flex items-center gap-1 text-h4 text-ink">
            {TOPIC_LABEL[topic]}
            <BasisTip items={items} />
          </h3>
          <ul className="mt-1 max-w-[80ch] divide-y divide-line">
            {items.map((f) => (
              <li key={f.text} className="py-2.5 text-body text-ink-2">
                {f.text}
                <Cite item={f} all={s.sources} />
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
  const reason = r && r.mode !== 'web' ? reasonCopy(r.reason, r.meta?.providerLabel || (r.provider === 'claude' ? 'Claude' : 'Your AI')) : '';
  return (
    <div>
      {m?.state === 'done' && manusFindings.length > 0 && later && (
        <Callout
          tone="info"
          className="mb-6"
          action={
            <RunButton projectId={project.id} kind={{ kind: 'plan' }} variant="secondary" size="md" className="btn-xs" runningLabel="Writing…">
              Update the plan from them
            </RunButton>
          }
        >
          New findings from Manus.
        </Callout>
      )}

      {!r ? (
        <Empty icon={<Search />} title="No research yet" body="It’s the first of the six steps: Plan my strategy writes it." />
      ) : (
        <Section
          title={
            <span className="inline-flex items-center gap-1">
              What the research found
              {r.mode === 'web' ? (
                <InfoTip label="About this research">Found by a web search on {fmtDate(r.at, { month: 'short', day: 'numeric', year: 'numeric' })}. Pages change: check them before you rely on them.</InfoTip>
              ) : (
                <InfoTip label={r.mode === 'builtin' ? 'Built-in guidance' : 'Based on general knowledge'} title={r.mode === 'builtin' ? 'Built-in guidance' : 'Not a web search'}>
                  <WithSettingsLink text={reason} />
                </InfoTip>
              )}
            </span>
          }
          description={
            r.mode === 'web' ? (
              <span className="num">
                Searched the web on {fmtDate(r.at, { month: 'short', day: 'numeric', year: 'numeric' })} · {r.searches} search{r.searches === 1 ? '' : 'es'}
              </span>
            ) : r.mode === 'builtin' ? (
              'Built-in guidance, not research'
            ) : (
              'From the AI’s general knowledge, not a web search'
            )
          }
        >
          {age > 30 && <p className="mb-3 text-small text-muted">This research is {age} days old. Web pages change: search again when you need fresh findings.</p>}
          {r.mode === 'builtin' ? (
            <p className="max-w-[72ch] text-body text-ink-2">With an AI key that can search the web, Strategy looks up where buyers in your market look and what gets attention, with a link to every source.</p>
          ) : (
            <div className="max-w-[72ch] text-body text-ink-2">
              <Markdown text={r.summary} />
            </div>
          )}
          {r.findings.length > 0 && (
            <div className="mt-8">
              <Findings list={r.findings} s={s} />
            </div>
          )}

          {r.checks.length > 0 && (
            <section aria-label="Check it yourself" className="mt-8">
              <h3 className="flex items-center gap-1 text-h4 text-ink">
                Check it yourself (free)
                <BasisTip items={[{ basis: 'builtin' }]} />
              </h3>
              <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-body text-ink-2 marker:text-muted">
                {r.checks.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ol>
            </section>
          )}

          {r.queries.length > 0 && (
            <Accordion type="single" collapsible className="mt-6 border-t border-line">
              <AccordionItem value="queries">
                <AccordionTrigger className="text-small">What it searched for</AccordionTrigger>
                <AccordionContent>
                  <ul className="flex list-disc flex-col gap-1 pl-5 text-small text-ink-2">
                    {r.queries.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          )}
        </Section>
      )}

      {manusFindings.length > 0 && (
        <Section title="Findings Manus read" description="Manus reports what each page says; the app can’t check it.">
          <Findings list={manusFindings} s={s} />
        </Section>
      )}

      <DeepResearch project={project} s={s} />
      <SourcesList ns={citedBy([...(r?.findings ?? []), ...manusFindings])} all={s.sources} manusRead={new Set(citedBy(manusFindings))} />
      <SectionFooter project={project} s={s} step="research" />
    </div>
  );
}
