import { useMemo, useState } from 'react';
import { CalendarDays, Layers, SlidersHorizontal } from 'lucide-react';
import { campaignPlanTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { getActiveProject, useActiveProject, useStore } from '@/store/useStore';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { Empty, Tabs, confirmAction } from '@/components/ui/primitives';
import { MarketingHeader } from './MarketingNav';
import { CampaignSetup, cadence } from './social/CampaignSetup';
import { PlanView } from './social/PlanView';
import { BatchView } from './social/BatchView';

type Tab = 'setup' | 'plan' | 'batch';

export default function SocialEngine() {
  const project = useActiveProject()!;
  const allPosts = useStore((s) => s.posts);
  const updateMarketing = useStore((s) => s.updateMarketing);
  const plan = project.marketing.plan;
  const cfg = project.marketing.campaign;
  const [tab, setTab] = useState<Tab>(() => (!plan ? 'setup' : 'batch'));
  const planAI = useAI(campaignPlanTask);
  const batchPosts = useMemo(() => allPosts.filter((p) => p.projectId === project.id && p.source === 'batch').sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)), [allPosts, project.id]);
  const covered = useMemo(() => new Set(batchPosts.map((p) => p.planSlotId).filter((x): x is string => !!x)), [batchPosts]);
  const c = cadence(cfg);
  const invalid = c.days === 0 || cfg.platforms.length === 0 || (c.images > 0 && !cfg.imageStyles.length) || (c.videos > 0 && !cfg.videoStyles.length);

  const generatePlan = async () => {
    if (plan && !(await confirmAction({ title: 'Replace the 30-day plan?', body: 'A new plan is generated from your current setup. Posts you already generated stay in your batch and queue.', confirmLabel: 'Generate new plan' }))) return;
    const r = await planAI.run({ config: getActiveProject()!.marketing.campaign });
    if (r) {
      updateMarketing({ plan: r });
      setTab('plan');
    }
  };

  const planButton = (
    <GenerateButton running={planAI.running} onClick={generatePlan} disabled={invalid}>
      {plan ? 'Regenerate 30-day plan' : 'Generate 30-day plan'}
    </GenerateButton>
  );

  return (
    <div className="flex flex-col gap-5">
      <MarketingHeader eyebrow="Marketing Hub · Social" title="Social media engine" desc="Set your cadence, visual styles, platforms and post mix. The AI writes a 30-day campaign plan, then a 7-day batch of ready-to-publish posts you can edit and schedule." actions={tab === 'setup' || !plan ? planButton : undefined} />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'setup', label: '1 · Campaign setup', icon: <SlidersHorizontal size={15} /> },
          { id: 'plan', label: '2 · 30-day plan', icon: <CalendarDays size={15} />, count: plan?.summary.total },
          { id: 'batch', label: '3 · 7-day batch', icon: <Layers size={15} />, count: batchPosts.filter((p) => p.status !== 'published').length || undefined },
        ]}
      />
      <AIThinking running={planAI.running} stage={planAI.stage} chars={planAI.chars} onStop={planAI.stop} />
      {planAI.result && !planAI.running && tab === 'plan' && <AIResultBar provider={planAI.result.provider} skills={planAI.result.skills} ms={planAI.result.ms} note={planAI.result.note} logId={planAI.logId} />}

      {tab === 'setup' && (
        <>
          <CampaignSetup project={project} />
          <div className="flex flex-wrap items-center justify-end gap-3">
            {invalid && <p className="text-xs text-warn">Fix the highlighted settings to continue.</p>}
            {planButton}
          </div>
        </>
      )}
      {tab === 'plan' &&
        (plan ? (
          <>
            <PlanView plan={plan} covered={covered} />
            <div className="flex flex-wrap justify-end gap-2">
              {planButton}
              <button className="btn btn-primary" onClick={() => setTab('batch')}>
                <Layers size={15} /> Go to the 7-day batch
              </button>
            </div>
          </>
        ) : (
          <Empty icon={<CalendarDays size={20} />} title="No plan yet" body="Finish the setup, then generate a 30-day plan that moves people from awareness to purchase." action={planButton} />
        ))}
      {tab === 'batch' && <BatchView project={project} posts={batchPosts} covered={covered} />}
    </div>
  );
}
