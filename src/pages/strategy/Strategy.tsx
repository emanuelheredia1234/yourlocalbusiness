// The Strategy tab: research and a plan to get clients and sales. Before the first run, one AI hero (your
// details as a summary line, Plan my strategy) with the free starter checklist folded under it; then six AI
// steps, each saved as it lands (research with sources when the key can search), in seven tabs. Who writes
// it, what it costs and the run's numbers sit behind the header's Details. Nothing runs, refreshes or
// retries by itself, and nothing outside Strategy changes until the owner chooses (Guide my other tabs,
// Build this page, Use these link settings…).
import { useMemo, useState } from 'react';
import { BookOpen, ChevronDown, FileDown, ListChecks } from 'lucide-react';
import type { Project } from '@/lib/types';
import type { StrategyState } from '@/lib/strategyTypes';
import { hasAnySection, isHttpUrl, readStrategy } from '@/lib/strategy';
import { tabLabel, tabsOf } from '@/lib/pageTabs';
import { FORMATS, matchBusinessType } from '@/ai/knowledge';
import { starterChecklist } from '@/ai/local/strategy';
import { strategyHas } from '@/ai/strategyTasks';
import { useStrategyJob } from '@/ai/strategyJob';
import { useActiveProject } from '@/store/useStore';
import { useTabRequest } from '@/store/ui';
import { GenerateButton, Spark } from '@/components/ai/AI';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Empty, InfoTip, Menu, Modal, MoreMenu, PageHeader, Tabs } from '@/components/ui/primitives';
import { download } from '@/components/ui/download';
import { ActionRow, RunButton, SourceItems, useActionCtx } from './parts';
import { DetailsDrawer, useDetailsDraft } from './DetailsDrawer';
import { RunMeta, RunningBlock, StoppedNote, useWho } from './RunPanel';
import { PlanTab } from './PlanTab';
import { ResearchTab } from './ResearchTab';
import { PromoteTab } from './PromoteTab';
import { ContentTab } from './ContentTab';
import { AssetsTab } from './AssetsTab';
import { OutreachTab } from './OutreachTab';
import { SeoTab } from './SeoTab';
import { PreviewHost } from './apply';
import { exportName, strategyMarkdown } from './exportMarkdown';
import { CHECKING_LABEL, runKey, startRun, useCheckingServer, type RunKind } from './runs';

type Tab = 'plan' | 'research' | 'promote' | 'content' | 'assets' | 'outreach' | 'seo';

export default function Strategy() {
  const project = useActiveProject();
  if (!project) return null;
  // a project switch starts fresh: its own tab and drafts
  return <StrategyPage key={project.id} project={project} />;
}

/** "Salon · Austin · for busy families nearby" (each part only when there is one). */
function subline(p: Project): string[] {
  const type = p.track === 'business' ? matchBusinessType(`${p.businessType} ${p.category} ${p.niche}`).label : p.format ? FORMATS[p.format]?.label : '';
  const aud = (p.brand.audience || '').trim();
  return [type ?? '', p.location?.city ?? '', aud ? `for ${aud.length > 60 ? `${aud.slice(0, 59).trimEnd()}…` : aud}` : ''].filter(Boolean);
}

const UPDATES: { label: string; kind: RunKind }[] = [
  { label: 'Update everything (6 steps)', kind: { kind: 'all' } },
  { label: 'Search again (research only)', kind: { kind: 'research' } },
  { label: 'Update the plan from the research (5 steps)', kind: { kind: 'plan' } },
];

/** "Update plan": the three ways to update (each a paid run after its confirm), or the run under way. */
function UpdateButton({ project, disabled }: { project: Project; disabled: boolean }) {
  const job = useStrategyJob(project.id);
  const checking = useCheckingServer(project.id);
  const mine = !!checking && UPDATES.some((u) => runKey(u.kind) === checking);
  if (job || mine) {
    const researching = job && job.steps[job.index] === 'research';
    return (
      <GenerateButton size="sm" running={job ? true : mine} runningLabel={mine ? CHECKING_LABEL : researching ? 'Researching…' : 'Writing…'} onClick={() => {}}>
        Update plan
      </GenerateButton>
    );
  }
  return (
    <Menu
      align="end"
      trigger={
        <button type="button" className="btn btn-ai-outline btn-sm" disabled={disabled || !!checking}>
          <Spark size={16} />
          Update plan
          <ChevronDown className="-mr-1 text-muted" />
        </button>
      }
      items={UPDATES.map((u) => ({ label: u.label, onSelect: () => void startRun(project.id, u.kind) }))}
    />
  );
}

/** The free starter checklist: general first steps from the project's details, not research. */
export function StarterChecklist({ project, s }: { project: Project; s: StrategyState }) {
  const ctx = useActionCtx();
  const items = useMemo(() => starterChecklist(project, strategyHas(project, ctx)), [project, ctx]);
  if (!items.length) return null;
  return (
    <section aria-label="Free starter checklist">
      <p className="flex items-center gap-1 text-small text-muted">
        General first steps from your project details. Plan my strategy replaces them with a plan for your market.
        <InfoTip label="Built-in guidance">Built-in guidance, not research: the app’s general starter notes.</InfoTip>
      </p>
      <ul className="mt-1 divide-y divide-line">
        {items.map((a) => (
          <ActionRow key={a.id} project={project} s={s} action={a} ctx={ctx} tickable={false} />
        ))}
      </ul>
    </section>
  );
}

/** Ghosts of what the run writes, under the first visit's hero. */
function Preview() {
  const card = (title: string, lines: string[]) => (
    <div className="card flex flex-col gap-3 p-4 text-left">
      <p className="text-small font-medium text-ink-2">{title}</p>
      {lines.map((w) => (
        <span key={w} className={`h-2.5 rounded-full bg-surface-3 ${w}`} />
      ))}
    </div>
  );
  return (
    <div className="mx-auto grid max-w-[720px] grid-cols-3 gap-4 max-md:hidden">
      {card('Your 4-week plan', ['w-11/12', 'w-3/4', 'w-5/6'])}
      {card('Where to promote', ['w-4/5', 'w-11/12', 'w-2/3'])}
      {card('Posts to make', ['w-5/6', 'w-2/3', 'w-3/4'])}
    </div>
  );
}

export function StrategyPage({ project }: { project: Project }) {
  const s = useMemo(() => readStrategy(project), [project]);
  const job = useStrategyJob(project.id);
  const who = useWho(s);
  const ctx = useActionCtx();
  const [tab, setTab] = useState<Tab>('plan');
  useTabRequest<Tab>('strategy', tabsOf('strategy') as Tab[], setTab);
  const details = useDetailsDraft(project.id, s.inputs);
  const [drawer, setDrawer] = useState(false);
  const [sources, setSources] = useState(false);
  const saved = hasAnySection(s);
  const empty = !saved && !job;
  const biz = project.track === 'business';
  const brand = project.brand.name || 'your business';
  const findings = (s.research?.findings.length ?? 0) + (s.manus?.state === 'done' ? s.manus.findings?.length ?? 0 : 0);
  const sub = subline(project);
  const allSources = s.sources.filter((x) => isHttpUrl(x.url)).sort((a, b) => a.n - b.n);

  const exportPlan = () => {
    const md = strategyMarkdown(project, s, ctx);
    void download(exportName(project), new Blob([md], { type: 'text/markdown' }));
  };

  if (empty) {
    return (
      <div>
        <PageHeader title="Strategy" meta={<RunMeta project={project} s={s} who={who} saved={false} />} />
        <section aria-label="Plan my strategy">
          <Empty
            variant="ai"
            className="pb-10 pt-8"
            title={`Plan how ${project.brand.name || 'your business'} gets customers`}
            body="Research, where to promote, and a 4-week plan. About two minutes."
            summary={
              <>
                {sub.length > 0 && <span>{sub.join(' · ')}</span>}
                <span className="basis-full">
                  <button type="button" className="link" onClick={() => setDrawer(true)}>
                    Edit details
                  </button>
                </span>
              </>
            }
            action={
              <RunButton projectId={project.id} kind={{ kind: 'all' }} variant="ai" size="lg" disabled={who.mode === 'checking'}>
                Plan my strategy
              </RunButton>
            }
            preview={<Preview />}
          />
        </section>
        <Accordion type="single" collapsible className="mx-auto mt-2 max-w-[720px]">
          <AccordionItem value="free">
            <AccordionTrigger>Start without AI</AccordionTrigger>
            <AccordionContent>
              <StarterChecklist project={project} s={s} />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        <DetailsDrawer open={drawer} onClose={() => setDrawer(false)} project={project} d={details} />
        <PreviewHost />
      </div>
    );
  }

  // the tab's own section isn't written yet: the run's skeletons stand where it will appear
  const written = { plan: !!s.plan, research: !!s.research, promote: !!s.promote, content: !!s.content, assets: !!s.assets, outreach: !!s.outreach, seo: !!s.assets }[tab];
  return (
    <div>
      <PageHeader
        className="mb-4"
        title={saved ? (biz ? `How ${brand} gets clients` : `How ${brand} makes sales`) : 'Strategy'}
        description={sub.join(' · ') || undefined}
        meta={<RunMeta project={project} s={s} who={who} saved={saved} />}
        actions={
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDrawer(true)}>
              <ListChecks /> Your details
            </button>
            <MoreMenu
              label="More strategy actions"
              items={[
                { label: 'Export plan', icon: <FileDown />, onSelect: exportPlan, disabled: !saved },
                { label: 'Sources', icon: <BookOpen />, onSelect: () => setSources(true), disabled: !allSources.length },
              ]}
            />
            <UpdateButton project={project} disabled={who.mode === 'checking'} />
          </>
        }
      />
      <Tabs<Tab>
        sticky
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'plan', label: 'Plan' },
          { id: 'research', label: 'Research', count: findings || undefined },
          { id: 'promote', label: 'Where to promote' },
          { id: 'content', label: 'Social content' },
          { id: 'assets', label: 'Assets to create' },
          { id: 'outreach', label: 'Email outreach' },
          { id: 'seo', label: 'SEO page' },
        ]}
      />
      {job ? <RunningBlock job={job} skeleton={!written} /> : <StoppedNote project={project} s={s} />}
      <div role="tabpanel" aria-label={tabLabel('strategy', tab)}>
        {(written || !job) && (
          <>
            {tab === 'plan' && <PlanTab project={project} s={s} ctx={ctx} />}
            {tab === 'research' && <ResearchTab project={project} s={s} />}
            {tab === 'promote' && <PromoteTab project={project} s={s} />}
            {tab === 'content' && <ContentTab project={project} s={s} />}
            {tab === 'assets' && <AssetsTab project={project} s={s} ctx={ctx} />}
            {tab === 'outreach' && <OutreachTab project={project} s={s} />}
            {tab === 'seo' && <SeoTab project={project} s={s} />}
          </>
        )}
      </div>

      <Modal open={sources} onClose={() => setSources(false)} title="Sources" subtitle="Every page the research found, as found. Links open the original pages." size="md">
        <SourceItems list={allSources} />
      </Modal>
      <DetailsDrawer open={drawer} onClose={() => setDrawer(false)} project={project} d={details} />
      <PreviewHost />
    </div>
  );
}
