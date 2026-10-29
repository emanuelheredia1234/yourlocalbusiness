import { useEffect, useMemo } from 'react';
import { ArrowLeft, ArrowRight, Check, Compass, Package, PartyPopper, Rocket, Search, Store, Upload, Wand2, X } from 'lucide-react';
import type { Origin, Project, Track } from '@/lib/types';
import { cn, fmtMoney, stripProtocol } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { FORMATS, matchBusinessType } from '@/ai/knowledge';
import { useActiveProject, useStore } from '@/store/useStore';
import { AppMark } from '@/components/layout/Shell';
import { BrandBanner, LogoMark } from '@/components/brand/Logo';
import { StepResearch } from './StepResearch';
import { StepSetup } from './StepSetup';
import { StepBrand } from './StepBrand';
import { finishOnboarding } from './finish';

type StepId = 'goal' | 'start' | 'research' | 'setup' | 'brand' | 'done';

function pathFor(p: Project): StepId[] {
  if (p.track === 'product') return p.origin === 'new' ? ['goal', 'start', 'research', 'brand', 'done'] : ['goal', 'start', 'setup', 'done'];
  return p.origin === 'new' ? ['goal', 'start', 'brand', 'done'] : ['goal', 'start', 'setup', 'done'];
}

const STEP_LABEL: Record<StepId, string> = {
  goal: 'Your goal',
  start: 'Starting point',
  research: 'Winning product research',
  setup: 'Brand & asset setup',
  brand: 'AI brand identity',
  done: 'Launch',
};

function OptionCard({ icon, title, body, examples, onClick, selected }: { icon: React.ReactNode; title: string; body: string; examples?: string[]; onClick: () => void; selected?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn('group flex min-w-0 flex-col items-start gap-3 rounded-xl border-2 bg-surface p-5 text-left transition-all hover:-translate-y-0.5 hover:shadow-pop', selected ? 'border-primary' : 'border-line hover:border-line-2')}
    >
      <span className={cn('flex h-12 w-12 items-center justify-center rounded-xl transition-colors', selected ? 'bg-primary text-on-primary' : 'bg-primary-soft text-primary group-hover:bg-primary group-hover:text-on-primary')}>{icon}</span>
      <span className="font-display text-[20px] font-bold leading-tight tracking-[-0.01em]">{title}</span>
      <span className="text-[13.5px] leading-relaxed text-muted">{body}</span>
      {examples && (
        <span className="flex flex-wrap gap-1.5">
          {examples.map((e) => (
            <span key={e} className="rounded-full bg-surface-2 px-2.5 py-1 text-[11.5px] font-medium text-ink-2">
              {e}
            </span>
          ))}
        </span>
      )}
      <span className="mt-auto inline-flex items-center gap-1.5 pt-1 text-[13px] font-semibold text-primary">
        Choose <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

function Rail({ project, path, step }: { project: Project; path: StepId[]; step: StepId }) {
  const idx = path.indexOf(step);
  const b = project.brand;
  return (
    <aside className="relative hidden w-[300px] shrink-0 flex-col overflow-hidden bg-[rgb(var(--primary-2))] text-white lg:flex" style={{ paddingLeft: 'env(safe-area-inset-left, 0px)' }}>
      <div className="h-3 shrink-0" style={{ backgroundImage: 'repeating-linear-gradient(90deg, rgb(var(--accent)) 0 16px, #fff 16px 32px)' }} />
      <div className="h-2.5 shrink-0" style={{ backgroundImage: 'radial-gradient(circle at 8px 0, rgb(var(--accent)) 7.5px, transparent 8px), radial-gradient(circle at 24px 0, #fff 7.5px, transparent 8px)', backgroundSize: '32px 10px', backgroundRepeat: 'repeat-x' }} />
      <div className="flex items-center gap-2.5 px-6 pt-5">
        <AppMark size={32} />
        <span className="font-display text-[18px] font-bold tracking-[-0.02em]">Yourlocalbusiness</span>
      </div>
      <div className="px-6 pt-8">
        <p className="font-display text-[26px] font-bold leading-[1.1] tracking-[-0.02em]">Let’s set up your project.</p>
        <p className="mt-2 text-[13.5px] text-white/70">A few guided steps. Every answer feeds the AI that builds and markets what you sell.</p>
      </div>
      <ol className="mt-8 flex flex-col gap-1 px-4">
        {path.map((s, i) => {
          const done = i < idx;
          const current = i === idx;
          return (
            <li key={s} className={cn('flex items-center gap-3 rounded-lg px-2.5 py-2', current && 'bg-white/10')}>
              <span className={cn('num flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold', done ? 'bg-[rgb(var(--accent))] text-[rgb(var(--on-accent))]' : current ? 'bg-white text-[rgb(var(--primary-2))]' : 'border border-white/30 text-white/60')}>
                {done ? <Check size={14} /> : i + 1}
              </span>
              <span className={cn('text-[13.5px] font-semibold', current ? 'text-white' : done ? 'text-white/85' : 'text-white/55')}>{STEP_LABEL[s]}</span>
            </li>
          );
        })}
      </ol>
      <div className="mt-auto px-5 pb-6">
        {(b.name || project.niche) && (
          <div className="rounded-xl border border-white/15 bg-white/[0.07] p-4">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/60">Project context</p>
            <div className="flex items-center gap-3">
              <LogoMark colors={b.colors} logo={b.logo} name={b.name || 'Brand'} size={38} />
              <div className="min-w-0">
                <p className="truncate font-display text-[15px] font-bold">{b.name || 'Unnamed brand'}</p>
                <p className="truncate text-xs text-white/65">{[project.niche, project.category].filter(Boolean).join(' · ') || project.businessType}</p>
              </div>
            </div>
            {b.tagline && <p className="mt-2 text-xs italic text-white/75">“{b.tagline}”</p>}
          </div>
        )}
        <p className="mt-3 text-[11.5px] text-white/50">Progress saves automatically on this device.</p>
      </div>
    </aside>
  );
}

function Done({ project }: { project: Project }) {
  const b = project.brand;
  const fmt = project.format ? FORMATS[project.format] : null;
  const bt = project.track === 'business' ? matchBusinessType(`${project.businessType} ${project.category}`) : null;
  const rows: [string, string][] = [
    ['Track', project.track === 'product' ? `Digital product · ${fmt?.label ?? 'Format TBD'}` : `Business · ${bt?.label ?? project.businessType}`],
    ['Niche', [project.niche, project.category].filter(Boolean).join(' → ') || '—'],
    project.idea ? ['Product', project.idea.title] : ['Location', project.location ? `${project.location.city}${project.location.region ? `, ${project.location.region}` : ''}` : 'Online'],
    ['Price', project.studio.price ? `${fmtMoney(project.studio.price)}${project.studio.priceModel === 'monthly' ? '/mo' : ''}` : 'Set in the Studio'],
    ['Website', stripProtocol(b.websiteUrl) || `${b.slug}.com`],
  ];
  return (
    <div className="flex flex-col gap-5">
      <div className="overflow-hidden rounded-xl border border-line">
        <BrandBanner brand={b} rounded={false} />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="panel p-5">
          <p className="eyebrow mb-3">Your Project Context</p>
          <dl className="flex flex-col divide-y divide-line">
            {rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 py-2 text-[13.5px]">
                <dt className="text-muted">{k}</dt>
                <dd className="min-w-0 truncate text-right font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="panel p-5">
          <p className="eyebrow mb-3">What happens next</p>
          <ol className="flex flex-col gap-3 text-[13.5px]">
            {[
              [Wand2, project.track === 'product' ? 'Build the product in the Studio: AI outline, drafts and interactive code assets.' : 'Shape your packages, operating model and booking widget in the Studio.'],
              [Store, 'Publish your listing to the Marketplace in one click.'],
              [Rocket, 'Launch marketing: SEO sales page, email funnel and a 30-day social campaign.'],
            ].map(([I, t], i) => {
              const Ico = I as typeof Wand2;
              return (
                <li key={i} className="flex gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary">
                    <Ico size={15} />
                  </span>
                  <span className="pt-1 text-ink-2">{t as string}</span>
                </li>
              );
            })}
          </ol>
          <p className="mt-4 rounded-md bg-accent-soft px-3 py-2 text-xs text-on-accent">Your Brain has been seeded with a “{b.name} brand voice” skill. Every generation will sound like you.</p>
        </div>
      </div>
    </div>
  );
}

export function Onboarding() {
  const project = useActiveProject();
  const projects = useStore((s) => s.projects);
  const create = useStore((s) => s.createProject);
  const update = useStore((s) => s.updateProject);
  const setActive = useStore((s) => s.setActiveProject);
  const del = useStore((s) => s.deleteProject);

  useEffect(() => {
    if (!project) create();
  }, [project, create]);

  const path = useMemo(() => (project ? pathFor(project) : (['goal'] as StepId[])), [project]);
  if (!project) return null;
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

  const header: Record<StepId, { title: string; sub: string }> = {
    goal: { title: 'What would you like to promote today?', sub: 'Pick a track. You can run more projects later.' },
    start:
      project.track === 'product'
        ? { title: 'Do you already have a product, or do you want to discover and create a new one?', sub: 'Existing products go straight to brand setup. New ones start with AI research.' }
        : { title: 'Do you already have an existing business, or do you want to start a new one?', sub: 'Existing businesses import their brand. New ones get an AI-generated identity.' },
    research: { title: 'Find a winning product', sub: 'Tell the AI your niche, a specific category and the format you want to sell.' },
    setup: { title: project.track === 'product' ? 'Set up your existing product' : 'Set up your existing business', sub: 'Add your name, logo, website, images and social accounts.' },
    brand: { title: 'Generate your brand identity', sub: 'Names, logo, palette, banner and messaging, generated from your niche and fully editable.' },
    done: { title: `${project.brand.name || 'Your project'} is ready to launch`, sub: 'Here’s what the AI will use across the Studio, Marketing Hub, Store and Analytics.' },
  };

  return (
    <div className="flex h-full">
      <Rail project={project} path={path} step={step} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b border-line bg-surface gutter py-3" style={{ paddingTop: 'max(12px, env(safe-area-inset-top, 0px))' }}>
          <div className="flex items-center gap-2 lg:hidden">
            <AppMark size={26} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="eyebrow">
              Step {idx + 1} of {path.length} · {STEP_LABEL[step]}
            </p>
            <div className="mt-1.5 h-1 w-full max-w-[420px] overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${((idx + 1) / path.length) * 100}%` }} />
            </div>
          </div>
          {others.length > 0 && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                del(project.id);
                setActive(others[0].id);
                navigate('dashboard');
              }}
            >
              <X size={15} /> Cancel setup
            </button>
          )}
        </div>
        <div id="wizard-scroll" className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1000px] gutter pb-10 pt-8">
            <div className="mb-6 animate-rise-in">
              <h1 className="page-title max-w-[28ch]">{header[step].title}</h1>
              <p className="mt-2 max-w-[60ch] text-[14.5px] text-muted">{header[step].sub}</p>
            </div>
            <div key={step} className="animate-rise-in">
              {step === 'goal' && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <OptionCard selected={project.track === 'product' && project.wizardStep !== 'goal'} icon={<Package size={24} />} title="Promote a Product" body="Digital products you sell online: research a winner or launch the one you have." examples={['Courses', 'Templates', 'Ebooks', 'Spreadsheets', 'Software']} onClick={() => chooseTrack('product')} />
                  <OptionCard selected={project.track === 'business' && project.wizardStep !== 'goal'} icon={<Store size={24} />} title="Promote a Business" body="Local shops, services and studios, or online businesses that sell services." examples={['Cafés', 'Salons', 'Home services', 'Agencies', 'Studios']} onClick={() => chooseTrack('business')} />
                </div>
              )}
              {step === 'start' && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {project.track === 'product' ? (
                    <>
                      <OptionCard icon={<Upload size={22} />} title="I already have a product" body="Import your name, logo, website, images and social accounts, then go straight to marketing." onClick={() => chooseOrigin('existing')} />
                      <OptionCard icon={<Search size={22} />} title="Help me find & create one" body="AI researches your niche, scores winning product ideas and builds a brand around the one you pick." onClick={() => chooseOrigin('new')} />
                    </>
                  ) : (
                    <>
                      <OptionCard icon={<Store size={22} />} title="I have an existing business" body="Bring your brand assets and accounts. We’ll set up your listing, funnel and campaigns." onClick={() => chooseOrigin('existing')} />
                      <OptionCard icon={<Compass size={22} />} title="I want to start a new business" body="Describe your idea and city. AI generates names, logo, palette, banner and pitch." onClick={() => chooseOrigin('new')} />
                    </>
                  )}
                </div>
              )}
              {step === 'research' && <StepResearch project={project} onNext={() => go('brand')} />}
              {step === 'setup' && <StepSetup project={project} />}
              {step === 'brand' && <StepBrand project={project} />}
              {step === 'done' && <Done project={project} />}
            </div>
          </div>
        </div>
        {step !== 'goal' && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line bg-surface gutter py-3" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom, 0px))' }}>
            <button className="btn btn-secondary" onClick={back}>
              <ArrowLeft size={16} /> Back
            </button>
            {step === 'done' ? (
              <div className="flex flex-wrap justify-end gap-2">
                <button className="btn btn-secondary" onClick={() => finish('dashboard')}>
                  Go to dashboard
                </button>
                <button className="btn btn-primary" onClick={() => finish('studio')}>
                  <PartyPopper size={16} /> Open {project.track === 'business' ? 'Business' : 'Product'} Studio
                </button>
              </div>
            ) : step === 'start' ? (
              <span className="text-xs text-muted">Choose an option to continue</span>
            ) : (
              <button className="btn btn-primary" disabled={!canContinue} onClick={next}>
                {step === 'research' && !project.idea ? 'Select an idea to continue' : 'Continue'} <ArrowRight size={16} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
