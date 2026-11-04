// The Strategy tab: research and a plan to get clients and sales. Your details and a free starter checklist
// first; then six AI steps, each saved as it lands (research with sources when the key can search), in
// seven tabs. Nothing runs, refreshes or retries by itself, and nothing outside Strategy changes until the
// owner chooses (Guide my other tabs, Build this page, Use these link settings…).
import { useMemo, useRef, useState } from 'react';
import { ChevronDown, FileDown, Globe, ListChecks, Mail, Megaphone, MessageSquareText, Package, RefreshCw, Search, Sparkles } from 'lucide-react';
import type { Project } from '@/lib/types';
import type { StrategyState } from '@/lib/strategyTypes';
import { hasAnySection, readStrategy } from '@/lib/strategy';
import { tabsOf } from '@/lib/pageTabs';
import { FORMATS, matchBusinessType } from '@/ai/knowledge';
import { starterChecklist } from '@/ai/local/strategy';
import { strategyHas } from '@/ai/strategyTasks';
import { useStrategyJob } from '@/ai/strategyJob';
import { useActiveProject } from '@/store/useStore';
import { useTabRequest } from '@/store/ui';
import { MenuItem, Popover, Tabs } from '@/components/ui/primitives';
import { download } from '@/components/ui/download';
import { ActionRow, useActionCtx } from './parts';
import { DetailsDrawer, DetailsForm, useDetailsDraft } from './DetailsDrawer';
import { RunPanel, useWho } from './RunPanel';
import { PlanTab } from './PlanTab';
import { ResearchTab } from './ResearchTab';
import { PromoteTab } from './PromoteTab';
import { ContentTab } from './ContentTab';
import { AssetsTab } from './AssetsTab';
import { OutreachTab } from './OutreachTab';
import { SeoTab } from './SeoTab';
import { PreviewHost } from './apply';
import { exportName, strategyMarkdown } from './exportMarkdown';
import { startRun } from './runs';

type Tab = 'plan' | 'research' | 'promote' | 'content' | 'assets' | 'outreach' | 'seo';

export default function Strategy() {
  const project = useActiveProject();
  if (!project) return null;
  // a project switch starts fresh: its own tab and drafts
  return <StrategyPage key={project.id} project={project} />;
}

/** "Bakery · Austin · for busy families nearby" (each part only when there is one). */
function subline(p: Project): string[] {
  const type = p.track === 'business' ? matchBusinessType(`${p.businessType} ${p.category} ${p.niche}`).label : p.format ? FORMATS[p.format]?.label : '';
  const aud = (p.brand.audience || '').trim();
  return [type ?? '', p.location?.city ?? '', aud ? `for ${aud.length > 60 ? `${aud.slice(0, 59).trimEnd()}…` : aud}` : ''].filter(Boolean);
}

function UpdateMenu({ project, disabled }: { project: Project; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const go = (k: Parameters<typeof startRun>[1]) => {
    setOpen(false);
    void startRun(project.id, k);
  };
  return (
    <>
      <button ref={anchor} type="button" className="btn btn-secondary" disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <RefreshCw size={15} /> Update… <ChevronDown size={14} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="w-[280px]">
        <div role="menu">
          <MenuItem onClick={() => go({ kind: 'all' })}>Update everything (6 steps)</MenuItem>
          <MenuItem onClick={() => go({ kind: 'research' })}>Search again (research only)</MenuItem>
          <MenuItem onClick={() => go({ kind: 'plan' })}>Update the plan from the research (5 steps)</MenuItem>
        </div>
      </Popover>
    </>
  );
}

function StarterChecklist({ project, s }: { project: Project; s: StrategyState }) {
  const ctx = useActionCtx();
  const items = useMemo(() => starterChecklist(project, strategyHas(project, ctx)), [project, ctx]);
  if (!items.length) return null;
  return (
    <section className="panel flex flex-col gap-3 p-4 sm:p-5" aria-label="Free starter checklist">
      <div>
        <p className="eyebrow mb-1">Built-in guidance, not research</p>
        <h2 className="section-title">Free starter checklist</h2>
        <p className="mt-0.5 text-[13px] text-muted">General first steps from your project details. Plan my strategy replaces them with a plan for your market.</p>
      </div>
      <ul className="flex flex-col gap-2">
        {items.map((a) => (
          <ActionRow key={a.id} project={project} s={s} action={a} ctx={ctx} tickable={false} />
        ))}
      </ul>
    </section>
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
  const saved = hasAnySection(s);
  const empty = !saved && !job;
  const biz = project.track === 'business';
  const brand = project.brand.name || 'your business';
  const findings = (s.research?.findings.length ?? 0) + (s.manus?.state === 'done' ? s.manus.findings?.length ?? 0 : 0);
  const sub = subline(project);

  const exportPlan = () => {
    const md = strategyMarkdown(project, s, ctx);
    void download(exportName(project), new Blob([md], { type: 'text/markdown' }));
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow mb-1">Strategy</p>
          <h1 className="page-title">{biz ? `How ${brand} gets clients` : `How ${brand} makes sales`}</h1>
          {sub.length > 0 && (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-muted">
              {sub.map((x, i) => (
                <span key={x} className="inline-flex items-center gap-2">
                  {i > 0 && <span aria-hidden="true">·</span>}
                  <span>{x}</span>
                </span>
              ))}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {saved ? (
            <UpdateMenu project={project} disabled={!!job || who.mode === 'checking'} />
          ) : (
            <button type="button" className="btn btn-ai" disabled={!!job || who.mode === 'checking'} onClick={() => void startRun(project.id, { kind: 'all' })}>
              <Sparkles size={15} className="text-accent" /> Plan my strategy
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={() => setDrawer(true)}>
            <ListChecks size={15} /> Your details
          </button>
          <button type="button" className="btn btn-ghost" disabled={!saved} onClick={exportPlan}>
            <FileDown size={15} /> Export plan
          </button>
        </div>
      </header>

      {empty ? (
        <>
          <section className="panel p-4 sm:p-5" aria-label="Your details">
            <h2 className="section-title">Your details</h2>
            <p className="mb-4 mt-0.5 text-[13px] text-muted">All optional. Your own words: the AI reads them and never writes them.</p>
            <DetailsForm project={project} d={details} />
          </section>
          <RunPanel project={project} s={s} />
          <StarterChecklist project={project} s={s} />
        </>
      ) : (
        <>
          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'plan', label: 'Plan', icon: <ListChecks size={15} /> },
              { id: 'research', label: 'Research', icon: <Search size={15} />, count: findings || undefined },
              { id: 'promote', label: 'Where to promote', icon: <Megaphone size={15} /> },
              { id: 'content', label: 'Social content', icon: <MessageSquareText size={15} /> },
              { id: 'assets', label: 'Assets to create', icon: <Package size={15} /> },
              { id: 'outreach', label: 'Email outreach', icon: <Mail size={15} /> },
              { id: 'seo', label: 'SEO page', icon: <Globe size={15} /> },
            ]}
          />
          <RunPanel project={project} s={s} compact />
          <div role="tabpanel" aria-label={tab}>
            {tab === 'plan' && <PlanTab project={project} s={s} ctx={ctx} />}
            {tab === 'research' && <ResearchTab project={project} s={s} />}
            {tab === 'promote' && <PromoteTab project={project} s={s} />}
            {tab === 'content' && <ContentTab project={project} s={s} />}
            {tab === 'assets' && <AssetsTab project={project} s={s} ctx={ctx} />}
            {tab === 'outreach' && <OutreachTab project={project} s={s} />}
            {tab === 'seo' && <SeoTab project={project} s={s} />}
          </div>
        </>
      )}

      <DetailsDrawer open={drawer} onClose={() => setDrawer(false)} project={project} d={details} />
      <PreviewHost />
    </div>
  );
}
