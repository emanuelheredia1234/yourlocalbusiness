import { useEffect, useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import { campaignPlanTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { getActiveProject, useActiveProject, useStore } from '@/store/useStore';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { Empty, PageHeader, StickyActionBar, Tabs, confirmAction } from '@/components/ui/primitives';
import { useUI, type SocialTab } from '@/store/ui';
import { tabLabel } from '@/lib/pageTabs';
import { applyCampaignPlan, campaignProblem, coveredSlots } from '@/ai/socialPlan';
import { QuickComposer } from '@/pages/dashboard/QuickComposer';
import { CampaignSetup } from './social/CampaignSetup';
import { PlanView } from './social/PlanView';
import { BatchView } from './social/BatchView';

type Tab = SocialTab;

export default function SocialEngine() {
  const project = useActiveProject()!;
  const allPosts = useStore((s) => s.posts);
  const plan = project.marketing.plan;
  const cfg = project.marketing.campaign;
  // "Create post" elsewhere in the app asks for a tab (see useUI.openComposer)
  const requested = useUI((s) => s.socialTab);
  const preset = useUI((s) => s.composerPreset);
  const [tab, setTab] = useState<Tab>(() => requested ?? (!plan ? 'setup' : 'batch'));
  useEffect(() => {
    if (!requested) return;
    setTab(requested);
    useUI.getState().setSocialTab(null);
  }, [requested]);
  // Once opened, the 7-day batch and the composer stay mounted while you switch tabs, so what they're
  // generating (and your draft) isn't lost.
  const [shown, setShown] = useState<Set<Tab>>(() => new Set([tab]));
  useEffect(() => {
    setShown((s) => (s.has(tab) ? s : new Set([...s, tab])));
  }, [tab]);
  // a topic from elsewhere starts one new draft: once the composer has it, it isn't offered again
  useEffect(() => {
    if (preset?.topic) useUI.setState({ composerPreset: { n: preset.n } });
  }, [preset]);
  const planAI = useAI(campaignPlanTask);
  const batchPosts = useMemo(() => allPosts.filter((p) => p.projectId === project.id && p.source === 'batch').sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)), [allPosts, project.id]);
  const covered = useMemo(() => coveredSlots(batchPosts, project.id), [batchPosts, project.id]);
  const invalid = !!campaignProblem(cfg);

  const generatePlan = async () => {
    if (plan && !(await confirmAction({ title: 'Replace the 30-day plan?', body: 'A new plan is generated from your current setup. Posts you already generated stay in your batch and queue.', confirmLabel: 'Generate new plan' }))) return;
    const r = await planAI.run({ config: getActiveProject()!.marketing.campaign });
    if (r) {
      applyCampaignPlan(r);
      setTab('plan');
    }
  };

  /** The plan's one button: filled while there's no plan yet (the setup's main action), outlined once there is. */
  const planButton = (label?: string) => (
    <GenerateButton variant={plan ? 'ai-outline' : 'ai'} size={plan ? 'sm' : 'md'} running={planAI.running} runningLabel="Planning…" onClick={generatePlan} disabled={invalid}>
      {label ?? (plan ? 'Regenerate 30-day plan' : 'Generate 30-day plan')}
    </GenerateButton>
  );
  const label = (t: Tab) => tabLabel('marketing-social', t);

  return (
    <div>
      <PageHeader className="mb-4" title="Social" description="A 30-day plan, then a week of posts ready to go out." />
      <Tabs<Tab>
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'setup', label: label('setup') },
          { id: 'plan', label: label('plan'), count: plan?.summary.total },
          { id: 'batch', label: label('batch'), count: batchPosts.filter((p) => p.status !== 'published').length || undefined },
          { id: 'create', label: label('create') },
        ]}
      />
      {/* the plan's progress and Stop show on every tab while it runs: it can be started from the setup, the plan or the 7-day batch */}
      <div className="mb-5 flex flex-col gap-3 empty:hidden">
        <AIThinking running={planAI.running} stage={planAI.stage} chars={planAI.chars} onStop={planAI.stop} />
        {planAI.result && !planAI.running && tab === 'plan' && <AIResultBar provider={planAI.result.provider} skills={planAI.result.skills} ms={planAI.result.ms} note={planAI.result.note} logId={planAI.logId} />}
      </div>

      {tab === 'setup' && (
        <>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 max-sm:hidden">
            <p className="text-small text-muted">Your cadence, looks and networks. The plan and every post follow them.</p>
            <div className="flex flex-wrap items-center gap-3">
              {invalid && <p className="text-caption text-warn">Fix the highlighted settings to continue.</p>}
              {planButton()}
            </div>
          </div>
          <CampaignSetup project={project} />
          <div className="sm:hidden">
            <StickyActionBar>
              {invalid && <p className="mr-auto text-caption text-warn">Fix the highlighted settings.</p>}
              {planButton()}
            </StickyActionBar>
          </div>
        </>
      )}
      {tab === 'plan' &&
        (plan ? (
          <>
            <div className="mb-5 flex flex-wrap items-center justify-end gap-2">
              {planButton('Regenerate plan')}
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setTab('batch')}>
                <Layers /> Go to the 7-day batch
              </button>
            </div>
            <PlanView plan={plan} covered={covered} />
          </>
        ) : (
          !planAI.running && <Empty variant="ai" title="No plan yet" body="Finish the setup, then plan 30 days that move people from hearing about you to booking." action={planButton()} />
        ))}
      {shown.has('batch') && (
        <div hidden={tab !== 'batch'}>
          <BatchView project={project} posts={batchPosts} covered={covered} planAction={plan ? undefined : planButton()} />
        </div>
      )}
      {shown.has('create') && (
        <section hidden={tab !== 'create'} aria-label="Create individual post">
          <QuickComposer key={`${project.id}:${preset?.n ?? 0}`} initialTopic={preset?.topic} />
        </section>
      )}
    </div>
  );
}
