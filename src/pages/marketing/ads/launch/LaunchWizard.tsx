// The launch window (spec §7.2): one tab per platform in the plan, five steps each (ad account, who sees it, the
// ads, budget and dates, review). The review is the server's own (it reads the saved plan again); the spend
// confirm then sends one launch per platform. Nothing that spends is prefilled, and nothing here launches by
// itself: the only write is SpendConfirm's button.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, ClipboardCheck } from 'lucide-react';
import type { AdCampaign, Project } from '@/lib/types';
import type { AccountsResponse, AdsPlatform } from '@/lib/ads/launchTypes';
import { PLATFORM_LABEL } from '@/lib/ads/launchTypes';
import { AdsApiError, getAdAccounts, previewLaunch } from '@/lib/ads/launchApi';
import { useAdsLaunch } from '@/store/adsLaunch';
import { useStore } from '@/store/useStore';
import { useUI } from '@/store/ui';
import { Callout, Checkbox, Modal, Segmented, Spinner, Stepper } from '@/components/ui/primitives';
import { AccountStep } from './AccountStep';
import { AudienceStep } from './AudienceStep';
import { AdsStep } from './AdsStep';
import { BudgetStep } from './BudgetStep';
import { ReviewStep } from './ReviewStep';
import { SpendConfirm, type LaunchAgain, type LaunchItem, type LaunchOutcome } from './SpendConfirm';
import { draftProblems, forCurrency, launchablePlatforms, newDraft, previewRequest, readyToConfirm, requestKey, splitLine, type LaunchDraft } from './draft';

const STEPS = ['Ad account', 'Who sees it', 'The ads', 'Budget and dates', 'Review'] as const;

export function LaunchWizardHost() {
  const w = useAdsLaunch((s) => s.launchWindow);
  const close = useAdsLaunch((s) => s.closeLaunch);
  const plan = useStore((s) => s.ads.find((a) => a.id === w?.planId));
  const project = useStore((s) => s.projects.find((p) => p.id === plan?.projectId));
  if (__ARTIFACT_BUILD__ || !w || !plan || !project) return null;
  return <LaunchWizard key={plan.id} project={project} plan={plan} again={w.again ?? null} onClose={close} />;
}

export function LaunchWizard({ project, plan, again = null, onClose }: { project: Project; plan: AdCampaign; again?: LaunchAgain | null; onClose: () => void }) {
  const platforms = useMemo(() => launchablePlatforms(plan), [plan]);
  const [tab, setTab] = useState<AdsPlatform>(platforms[0] ?? 'meta');
  const [drafts, setDrafts] = useState<Record<string, LaunchDraft>>(() => Object.fromEntries(platforms.map((p) => [p, newDraft(plan, p, platforms.length)])));
  const [step, setStep] = useState<Record<string, number>>(() => Object.fromEntries(platforms.map((p) => [p, 0])));
  const [accounts, setAccounts] = useState<Record<string, AccountsResponse | null>>({});
  const [acctErr, setAcctErr] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [reviewErr, setReviewErr] = useState<Record<string, string | null>>({});
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const limits = useAdsLaunch((s) => s.limits[project.id]);

  const loadAccounts = useCallback(
    async (p: AdsPlatform) => {
      setLoading((l) => ({ ...l, [p]: true }));
      try {
        const r = await getAdAccounts(project.id, p);
        setAccounts((a) => ({ ...a, [p]: r }));
        setAcctErr((e) => ({ ...e, [p]: null }));
        // the plan's daily is in USD: an account in another currency starts empty (never converted)
        setDrafts((d) => ({ ...d, [p]: forCurrency(d[p], r.chosen?.currency) }));
      } catch (e) {
        setAcctErr((x) => ({ ...x, [p]: e instanceof AdsApiError ? e.message : 'Your ad accounts couldn’t be read. Try again shortly.' }));
      } finally {
        setLoading((l) => ({ ...l, [p]: false }));
      }
    },
    [project.id],
  );
  useEffect(() => {
    for (const p of platforms) void loadAccounts(p);
    if (!useAdsLaunch.getState().limits[project.id]) void useAdsLaunch.getState().load(project.id);
  }, [platforms, loadAccounts, project.id]);

  if (!platforms.length)
    return (
      <Modal open onClose={onClose} size="sm" title="Launch this plan">
        <p className="text-small text-ink-2">The app can launch on Meta and Google. Add one of them to the plan’s platforms first.</p>
      </Modal>
    );

  const d = drafts[tab];
  const acct = accounts[tab];
  const chosen = acct?.chosen;
  const cur = step[tab] ?? 0;
  const patch = (p: AdsPlatform, v: Partial<LaunchDraft>) => setDrafts((all) => ({ ...all, [p]: { ...all[p], ...v } }));
  const currencyOf = (p: AdsPlatform) => accounts[p]?.chosen?.currency;
  const split = splitLine(Object.values(drafts), plan, currencyOf);
  const problems = draftProblems(d, { accountChosen: !!chosen?.usable, minDaily: chosen?.minDailyBudget });
  const ready = (p: string) => readyToConfirm(drafts[p], project.id, plan.id);
  const included = platforms.filter((p) => drafts[p].include);
  const allReady = included.length > 0 && included.every(ready);
  const canLaunch = platforms.some((p) => accounts[p]?.canLaunch);

  const review = async () => {
    if (problems.length || reviewing) return;
    const req = previewRequest(d, project.id, plan.id);
    setReviewing(tab);
    setReviewErr((e) => ({ ...e, [tab]: null }));
    try {
      const r = await previewLaunch(req);
      patch(tab, { review: r.review, reviewToken: r.reviewToken ?? null, reviewedFor: requestKey(req) });
    } catch (e) {
      patch(tab, { review: null, reviewToken: null, reviewedFor: null });
      setReviewErr((x) => ({ ...x, [tab]: e instanceof AdsApiError ? e.message : 'The review didn’t work. Try again.' }));
    } finally {
      setReviewing(null);
    }
  };

  const items: LaunchItem[] = included.filter(ready).map((p) => ({ key: `${plan.id}:${p}`, platform: p, reviewToken: drafts[p].reviewToken!, review: drafts[p].review! }));

  const launched = (done: LaunchOutcome[]) => {
    const s = useAdsLaunch.getState();
    for (const o of done) {
      if (!o.ok) continue;
      s.applyJob(o.job, o.campaign);
      void s.follow(o.job.id);
      // a launched platform can't be launched again from this window
      patch(o.platform, { include: false, review: null, reviewToken: null, reviewedFor: null });
    }
  };

  const content = (i: number) => {
    switch (i) {
      case 0:
        return <AccountStep projectId={project.id} platform={tab} data={acct ?? null} loading={!!loading[tab]} error={acctErr[tab] ?? null} onChanged={() => void loadAccounts(tab)} />;
      case 1:
        return <AudienceStep projectId={project.id} plan={plan} draft={d} onChange={(v) => patch(tab, v)} />;
      case 2:
        return <AdsStep project={project} plan={plan} draft={d} onChange={(v) => patch(tab, v)} />;
      case 3:
        return <BudgetStep plan={plan} draft={d} account={chosen} limits={limits} split={split} twoPlatforms={included.length > 1} onChange={(v) => patch(tab, v)} />;
      default:
        return (
          <div className="flex flex-col gap-3">
            {problems.length > 0 ? (
              <Callout tone="warn" title="Before the review">
                <ul className="flex flex-col gap-0.5">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Callout>
            ) : (
              <div>
                <button type="button" className="btn btn-secondary btn-sm" disabled={!!reviewing} onClick={() => void review()}>
                  {reviewing === tab ? <Spinner size={14} /> : <ClipboardCheck />} {d.review ? 'Review again' : 'Review what will be sent'}
                </button>
              </div>
            )}
            <ReviewStep review={d.review} error={reviewErr[tab] ?? null} stale={!!d.review && d.reviewedFor !== requestKey(previewRequest(d, project.id, plan.id))} confirmed={d.claimsConfirmed} onClaims={(v) => patch(tab, { claimsConfirmed: v })} />
          </div>
        );
    }
  };

  const summaries = [chosen ? `${chosen.name} …${chosen.idTail}` : '', d.locations.length ? `${d.locations.length} place${d.locations.length === 1 ? '' : 's'}` : '', d.platform === 'meta' ? `${d.creativeIds.length} ad${d.creativeIds.length === 1 ? '' : 's'}` : 'Search ad', d.daily ? `${d.daily} ${chosen?.currency ?? ''} a day · ${d.status || 'start not chosen'}` : '', ''];

  return (
    <>
      <Modal
        open={!confirming}
        onClose={onClose}
        size="lg"
        title={`Launch “${plan.name || 'Untitled campaign'}”`}
        subtitle="Nothing is sent until you confirm the spend at the end."
        footer={
          <>
            <button type="button" className="btn btn-ghost btn-sm mr-auto" disabled={cur === 0} onClick={() => setStep((s) => ({ ...s, [tab]: Math.max(0, cur - 1) }))}>
              <ArrowLeft /> Back
            </button>
            {cur < STEPS.length - 1 ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setStep((s) => ({ ...s, [tab]: Math.min(STEPS.length - 1, cur + 1) }))}>
                Next <ArrowRight />
              </button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" disabled={!allReady || !canLaunch} onClick={() => setConfirming(true)}>
                Continue to confirm
              </button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-5">
          {!canLaunch && Object.keys(accounts).length === platforms.length && <Callout tone="warn">Launching ads isn’t turned on for your account. Ask the app owner.</Callout>}
          {platforms.length > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Segmented<AdsPlatform> aria-label="Platform" value={tab} onChange={setTab} options={platforms.map((p) => ({ id: p, label: `${PLATFORM_LABEL[p]}${ready(p) && drafts[p].include ? ' · reviewed' : ''}` }))} />
              <Checkbox id={`lw-include-${tab}`} checked={d.include} onChange={(v) => patch(tab, { include: v })} label={`Launch on ${PLATFORM_LABEL[tab]}`} />
            </div>
          )}
          <Stepper steps={STEPS.map((title, i) => ({ title, summary: summaries[i] || undefined, state: i < cur ? 'done' : i === cur ? 'current' : 'upcoming', content: i === cur ? content(i) : undefined }))} />
          {platforms.length > 1 && cur === STEPS.length - 1 && (
            <p className="text-small text-muted">
              {included.length === 0 ? 'Tick at least one platform to launch.' : `Each platform is its own review, confirm line and launch. Ready: ${included.filter(ready).map((p) => PLATFORM_LABEL[p]).join(' and ') || 'none yet'}.`}
            </p>
          )}
        </div>
      </Modal>
      <SpendConfirm
        open={confirming}
        items={items}
        again={again}
        onClose={() => setConfirming(false)}
        onLaunched={(done) => {
          launched(done);
          // into the Campaigns tab, where the new row is followed until it's sent
          useUI.getState().requestTab('marketing-ads', 'campaigns');
          if (done.length >= items.length) onClose();
        }}
      />
    </>
  );
}
