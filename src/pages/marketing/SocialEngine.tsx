import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Layers, PenSquare, SlidersHorizontal } from 'lucide-react';
import { campaignPlanTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { getActiveProject, useActiveProject, useStore } from '@/store/useStore';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { Empty, Tabs, confirmAction } from '@/components/ui/primitives';
import { useUI, type SocialTab } from '@/store/ui';
import { QuickComposer } from '@/pages/dashboard/QuickComposer';
import { MarketingHeader } from './MarketingNav';
import { CampaignSetup, cadence } from './social/CampaignSetup';
import { PlanView } from './social/PlanView';
import { BatchView } from './social/BatchView';

type Tab = SocialTab;

export default function SocialEngine() {
  const project = useActiveProject()!;
  const allPosts = useStore((s) => s.posts);
  const updateMarketing = useStore((s) => s.updateMarketing);
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
      <MarketingHeader eyebrow="Marketing Hub · Social" title="Social media engine" desc="Set your cadence, visual styles, platforms and post mix. The AI writes a 30-day campaign plan, then a 7-day batch of ready-to-publish posts you can edit and schedule. Or create individual posts, one at a time." actions={tab === 'setup' || (!plan && tab !== 'create') ? planButton : undefined} />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'setup', label: '1 · Campaign setup', icon: <SlidersHorizontal size={15} /> },
          { id: 'plan', label: '2 · 30-day plan', icon: <CalendarDays size={15} />, count: plan?.summary.total },
          { id: 'batch', label: '3 · 7-day batch', icon: <Layers size={15} />, count: batchPosts.filter((p) => p.status !== 'published').length || undefined },
          { id: 'create', label: 'Create individual post', icon: <PenSquare size={15} /> },
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
      {shown.has('batch') && (
        <div hidden={tab !== 'batch'}>
          <BatchView project={project} posts={batchPosts} covered={covered} />
        </div>
      )}
      {shown.has('create') && (
        <section hidden={tab !== 'create'} aria-label="Create individual post" className="panel p-4 sm:p-5">
          <p className="mb-4 text-[13.5px] text-muted">One post at a time, outside your campaign: generate it with AI, or upload your own photo or video and let AI write the caption.</p>
          <QuickComposer key={`${project.id}:${preset?.n ?? 0}`} initialTopic={preset?.topic} />
        </section>
      )}
    </div>
  );
}
