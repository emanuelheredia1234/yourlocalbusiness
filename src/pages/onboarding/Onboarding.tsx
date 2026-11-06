import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Compass, LogOut, Megaphone, Package, PencilRuler, Search, Store, Upload, X } from 'lucide-react';
import type { Origin, Project, Track } from '@/lib/types';
import { cn, fmtMoney, stripProtocol } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { deleteProjectEverywhere } from '@/lib/projectActions';
import { FORMATS, matchBusinessType } from '@/ai/knowledge';
import { useActiveProject, useStore } from '@/store/useStore';
import { AppMark } from '@/components/layout/Shell';
import { logOut } from '@/components/auth/Account';
import { useAuth } from '@/lib/cloud/auth';
import { BrandBanner, LogoMark } from '@/components/brand/Logo';
import { Spark } from '@/components/ai/Spark';
import { OptionCards, ProgressBar } from '@/components/ui/primitives';
import { StepResearch } from './StepResearch';
import { StepSetup } from './StepSetup';
import { StepBrand } from './StepBrand';
import { finishOnboarding } from './finish';
import { claimSlot, slotMessage, slotsNeeded, type SlotResult } from '@/lib/cloud/slots';
import { newProjectId } from '@/store/defaults';
import { PlanPickerScreen } from '@/pages/plans/Plans';
import { useBilling } from '@/store/billing';
import { Callout } from '@/components/ui/primitives';

/** The first project's creation, once (React may run the effect twice): its business slot is claimed first. */
let firstProject: Promise<SlotResult> | null = null;

/**
 * With no project at all, the setup makes one. Plans on: its slot is claimed first; no plan yet → the plan picker
 * instead (nothing is created). Plans off, the artifact build, a guest: created at once, as before.
 */
function createFirst(): Promise<SlotResult> | null {
  if (!slotsNeeded()) {
    useStore.getState().createProject();
    return null;
  }
  if (!firstProject) {
    const id = newProjectId();
    firstProject = claimSlot(id)
      .then((r) => {
        if (r.ok && !useStore.getState().projects.length) useStore.getState().createProject(undefined, 'new', id);
        return r;
      })
      .finally(() => {
        firstProject = null;
      });
  }
  return firstProject;
}

type StepId = 'goal' | 'start' | 'research' | 'setup' | 'brand' | 'done';

function pathFor(p: Project): StepId[] {
  if (p.track === 'product') return p.origin === 'new' ? ['goal', 'start', 'research', 'brand', 'done'] : ['goal', 'start', 'setup', 'done'];
  return p.origin === 'new' ? ['goal', 'start', 'brand', 'done'] : ['goal', 'start', 'setup', 'done'];
}

const STEP_LABEL: Record<StepId, string> = {
  goal: 'Your goal',
  start: 'Starting point',
  research: 'Product ideas',
  setup: 'Brand & asset setup',
  brand: 'AI brand identity',
  done: 'Launch',
};

function Done({ project }: { project: Project }) {
  const b = project.brand;
  const fmt = project.format ? FORMATS[project.format] : null;
  const bt = project.track === 'business' ? matchBusinessType(`${project.businessType} ${project.category}`) : null;
  const rows: [string, string][] = [
    ['Track', project.track === 'product' ? `Digital product · ${fmt?.label ?? 'Format TBD'}` : `Business · ${bt?.label ?? project.businessType}`],
    ['Niche', [project.niche, project.category].filter(Boolean).join(' → ') || '—'],
    project.idea ? ['Product', project.idea.title] : ['Location', project.location ? `${project.location.city}${project.location.region ? `, ${project.location.region}` : ''}` : 'Online'],
    ['Price', project.studio.price ? `${fmtMoney(project.studio.price)}${project.studio.priceModel === 'monthly' ? '/mo' : ''}` : 'Set in the Studio'],
    ['Website', stripProtocol(b.websiteUrl) || 'None yet'],
  ];
  const next: [typeof PencilRuler, string][] = [
    [PencilRuler, project.track === 'product' ? 'Build the product in the Studio: an outline, drafts and interactive code assets.' : 'Shape your packages, how you work and your booking widget in the Studio.'],
    [Store, 'Publish your listing to the Marketplace in one click.'],
    [Megaphone, 'Launch marketing: an SEO page, an email funnel and a 30-day social campaign.'],
    [Compass, 'Plan how you’ll get clients: Strategy finds where your buyers are, what to post and which page to build first.'],
  ];
  return (
    <div className="flex flex-col gap-6">
      <div className="overflow-hidden rounded-2xl shadow-product">
        <BrandBanner brand={b} rounded={false} />
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <section className="card px-5 py-4" aria-labelledby="launch-context">
          <h2 id="launch-context" className="text-h4 text-ink">
            Your project
          </h2>
          <dl className="mt-2 flex flex-col divide-y divide-line">
            {rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 py-2.5 text-small">
                <dt className="text-muted">{k}</dt>
                <dd className="min-w-0 truncate text-right font-medium text-ink">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="card px-5 py-4" aria-labelledby="launch-next">
          <h2 id="launch-next" className="text-h4 text-ink">
            What happens next
          </h2>
          <ol className="mt-3 flex flex-col gap-3">
            {next.map(([Ico, t], i) => (
              <li key={i} className="flex gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-3 text-ink-2">
                  <Ico size={16} aria-hidden="true" />
                </span>
                <span className="pt-1.5 text-small text-ink-2">{t}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
      <p className="flex items-center gap-2 text-small text-ink-2">
        <Spark size={16} /> Your Brain learned {b.name || 'your brand'}’s voice: every post, page and email will sound like you.
      </p>
    </div>
  );
}

export function Onboarding() {
  const project = useActiveProject();
  const projects = useStore((s) => s.projects);
  const create = useStore((s) => s.createProject);
  const update = useStore((s) => s.updateProject);
  const setActive = useStore((s) => s.setActiveProject);
  const signedIn = useAuth((s) => s.phase === 'ready');

  const [refused, setRefused] = useState<SlotResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  // a plan that just started (back from Stripe Checkout): try the first business again
  const planActive = useBilling((s) => s.plan?.active === true && s.plan.plan !== 'legacy');
  const canBuy = useBilling((s) => s.account?.source === 'stripe' && s.plan?.active === true);
  useEffect(() => {
    if (project) return;
    let gone = false;
    void createFirst()?.then((r) => !gone && setRefused(r.ok ? null : r));
    return () => {
      gone = true;
    };
  }, [project, create, attempt, planActive]);

  const path = useMemo(() => (project ? pathFor(project) : (['goal'] as StepId[])), [project]);
  if (!project) {
    const out = signedIn ? (
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void logOut()}>
        <LogOut /> Log out
      </button>
    ) : null;
    // plans on and no plan yet: choose one first (Stripe Checkout, then back here to set up the first business)
    if (refused?.reason === 'plan_required') return <PlanPickerScreen footer={out} />;
    if (refused)
      return (
        <div className="mx-auto flex min-h-full max-w-[480px] flex-col justify-center gap-4 gutter py-10">
          <Callout tone={refused.reason === 'offline' ? 'warn' : 'bad'}>{slotMessage(refused)}</Callout>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
            {refused.reason === 'limit' && canBuy && (
              // a paying plan buys a slot right here; then the first business is tried again
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => useBilling.getState().openAddBusiness(() => setAttempt((n) => n + 1))}>
                Add a business
              </button>
            )}
            {refused.reason === 'limit' && !canBuy && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void navigate('plans', { force: true })}>
                See plans
              </button>
            )}
            {out}
          </div>
        </div>
      );
    return null;
  }
  const step = (path.includes(project.wizardStep as StepId) ? project.wizardStep : 'goal') as StepId;
  const idx = path.indexOf(step);
  const go = (s: StepId) => {
    update(project.id, (p) => ({ ...p, wizardStep: s }));
    document.getElementById('wizard-scroll')?.scrollTo({ top: 0 });
  };
  const next = () => go(path[Math.min(path.length - 1, idx + 1)]);
  const back = () => go(path[Math.max(0, idx - 1)]);
  const others = projects.filter((p) => p.onboarded && p.id !== project.id);

  const chooseTrack = (t: Track) => {
    update(project.id, (p) => ({ ...p, track: t, wizardStep: 'start' }));
  };
  const chooseOrigin = (o: Origin) => {
    const nextStep: StepId = project.track === 'product' ? (o === 'new' ? 'research' : 'setup') : o === 'new' ? 'brand' : 'setup';
    update(project.id, (p) => ({ ...p, origin: o, wizardStep: nextStep }));
  };

  const canContinue = (() => {
    switch (step) {
      case 'research':
        return !!project.idea;
      case 'setup':
        return project.brand.name.trim().length > 1 && (project.track === 'product' ? !!project.niche.trim() && !!project.format : !!(project.businessType || project.niche).trim());
      case 'brand':
        return project.brand.name.trim().length > 1 && project.brand.nameOptions.length > 0;
      default:
        return true;
    }
  })();

  const finish = (dest: 'studio' | 'dashboard') => {
    finishOnboarding(project.id);
    navigate(dest);
  };

  const name = project.brand.name.trim();
  const header: Record<StepId, { title: ReactNode; sub: string }> = {
    goal: { title: 'What would you like to promote today?', sub: 'Pick a track. You can run more projects later.' },
    start:
      project.track === 'product'
        ? { title: 'Do you already have a product, or do you want to discover and create a new one?', sub: 'Existing products go straight to brand setup. New ones start with AI product ideas.' }
        : { title: 'Do you already have an existing business, or do you want to start a new one?', sub: 'Existing businesses bring their brand. New ones get an AI-made identity.' },
    research: { title: 'Pick a product idea', sub: 'Tell the AI your niche, a specific category and the format you want to sell.' },
    setup: { title: project.track === 'product' ? 'Set up your existing product' : 'Set up your existing business', sub: 'Your name, logo, website, images and social accounts.' },
    brand: { title: 'Generate your brand identity', sub: 'Names, a logo, palette, banner and messaging, made from your details and all editable.' },
    done: {
      title: (
        <>
          {name || 'Your project'} is{' '}
          <span className="font-editorial font-normal italic tracking-[-0.02em]" style={{ fontSize: '1.1em' }}>
            ready to launch.
          </span>
        </>
      ),
      sub: 'What the AI will use across the Studio, Marketing and the Marketplace.',
    },
  };

  const wide = step === 'brand' || step === 'research';

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line gutter" style={{ paddingTop: 'env(safe-area-inset-top, 0px)', boxSizing: 'content-box' }}>
        <AppMark size={24} />
        <span className="hidden text-h4 text-ink sm:inline">Yourlocalbusiness</span>
        <span className="hidden h-4 w-px bg-line-2 sm:block" aria-hidden="true" />
        {/* (the segments give way on a narrow phone with Cancel setup beside them, so "Step 2 of 5" stays clear of it) */}
        <ProgressBar
          variant="ink"
          segments={path.length}
          value={idx + 1}
          min={1}
          max={path.length}
          aria-label="Setup progress"
          valueText={`Step ${idx + 1} of ${path.length}: ${STEP_LABEL[step]}`}
          title={STEP_LABEL[step]}
          label={`Step ${idx + 1} of ${path.length}`}
        />
        <span className="ml-auto flex items-center gap-1">
          {others.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                // a business set up halfway may already have connected social accounts: they go with it
                deleteProjectEverywhere(project.id);
                setActive(others[0].id);
                navigate('dashboard');
              }}
            >
              <X /> <span className="max-sm:sr-only">Cancel setup</span>
            </button>
          )}
          {signedIn && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void logOut()}>
              <LogOut /> <span className="max-sm:sr-only">Log out</span>
            </button>
          )}
        </span>
      </header>

      <div id="wizard-scroll" className="scroll-thin relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className={cn('mx-auto w-full gutter pb-12 pt-10 sm:pt-14', wide ? 'max-w-[960px]' : 'max-w-[720px]')}>
          <div className="mb-8 animate-rise-in">
            <h1 className={cn('max-w-[24ch] text-ink', step === 'done' ? 'text-phone-display sm:text-display-xl' : 'text-phone-display sm:text-display')}>{header[step].title}</h1>
            <p className="mt-3 max-w-[60ch] text-body-lg text-muted">{header[step].sub}</p>
          </div>
          <div key={step} className="animate-rise-in">
            {step === 'goal' && (
              <OptionCards<'product' | 'business'>
                mode="button"
                size="lg"
                aria-label="What to promote"
                value={project.wizardStep !== 'goal' && (project.track === 'product' || project.track === 'business') ? project.track : ''}
                onChange={chooseTrack}
                options={[
                  { value: 'product', icon: <Package />, title: 'Promote a Product', description: 'Digital products you sell online: get AI product ideas or launch the one you have.', meta: ['Courses', 'Templates', 'Ebooks', 'Spreadsheets', 'Software'].join(' · ') },
                  { value: 'business', icon: <Store />, title: 'Promote a Business', description: 'Local shops, services and studios, or online businesses that sell services.', meta: ['Cafés', 'Salons', 'Home services', 'Agencies', 'Studios'].join(' · ') },
                ]}
              />
            )}
            {step === 'start' && (
              <OptionCards<'existing' | 'new'>
                mode="button"
                size="lg"
                aria-label="Where to start"
                value=""
                onChange={chooseOrigin}
                options={
                  project.track === 'product'
                    ? [
                        { value: 'existing', icon: <Upload />, title: 'I already have a product', description: 'Bring your name, logo, website, images and social accounts, then go straight to marketing.' },
                        { value: 'new', icon: <Search />, title: 'Help me find & create one', description: 'AI suggests product ideas for your niche and builds a brand around the one you pick.' },
                      ]
                    : [
                        { value: 'existing', icon: <Store />, title: 'I have an existing business', description: 'Bring your brand and accounts. We’ll set up your listing, funnel and campaigns.' },
                        { value: 'new', icon: <Compass />, title: 'I want to start a new business', description: 'Describe your idea and city. AI makes names, a logo, palette, banner and pitch.' },
                      ]
                }
              />
            )}
            {step === 'research' && <StepResearch project={project} onNext={() => go('brand')} />}
            {step === 'setup' && <StepSetup project={project} />}
            {step === 'brand' && <StepBrand project={project} />}
            {step === 'done' && <Done project={project} />}
          </div>
        </div>
      </div>

      {step !== 'goal' && (
        <footer className="flex min-h-16 shrink-0 items-center gap-3 border-t border-line bg-surface gutter py-3" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom, 0px))' }}>
          <button type="button" className="btn btn-ghost max-sm:btn-icon" onClick={back} aria-label="Back">
            <ArrowLeft /> <span className="max-sm:hidden">Back</span>
          </button>
          {name && step !== 'start' && (
            <span className="hidden min-w-0 items-center gap-2 rounded-full border border-line py-1 pl-1 pr-3 md:flex">
              <LogoMark colors={project.brand.colors} logo={project.brand.logo} name={name} size={22} />
              <span className="truncate text-small font-medium text-ink">{name}</span>
            </span>
          )}
          <span className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
            {step === 'done' ? (
              <>
                <button type="button" className="btn btn-secondary btn-lg max-sm:hidden" onClick={() => finish('dashboard')}>
                  Go to dashboard
                </button>
                <button type="button" className="btn btn-primary btn-lg max-sm:w-full" onClick={() => finish('studio')}>
                  Open {project.track === 'business' ? 'Business' : 'Product'} Studio
                </button>
              </>
            ) : step === 'start' ? (
              <span className="text-small text-muted">Choose an option to continue</span>
            ) : (
              <button type="button" className="btn btn-primary btn-lg max-sm:w-full" disabled={!canContinue} onClick={next}>
                {step === 'research' && !project.idea ? 'Select an idea to continue' : 'Continue'} <ArrowRight />
              </button>
            )}
          </span>
        </footer>
      )}
      {step === 'done' && (
        <div className="flex shrink-0 justify-center pb-3 sm:hidden" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom, 0px))' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => finish('dashboard')}>
            Go to dashboard
          </button>
        </div>
      )}
    </div>
  );
}
