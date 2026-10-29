import { useState } from 'react';
import { ArrowRight, Check, Download, FileText, Gift, Plus, Trash2 } from 'lucide-react';
import type { LeadMagnet, LeadMagnetType, Project } from '@/lib/types';
import { cn, emailValid, readableOn, slugify, withAlpha } from '@/lib/utils';
import { LEAD_MAGNET_TYPES, leadMagnetMarkdown } from '@/ai/local/email';
import { leadMagnetTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { getActiveProject, useStore } from '@/store/useStore';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { AutoTextarea, CopyButton, Empty, Field, LinesEditor, confirmAction } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { BrandLogo } from '@/components/brand/Logo';
import { download } from '@/components/ui/download';
import { addSubscriber } from './shared';

export function LeadMagnetPanel({ project, onSimulate }: { project: Project; onSimulate: (subId: string) => void }) {
  const updateMarketing = useStore((s) => s.updateMarketing);
  const lm = project.marketing.leadMagnet;
  const [type, setType] = useState<LeadMagnetType>(lm?.type ?? 'checklist');
  const ai = useAI(leadMagnetTask);
  const set = (patch: Partial<LeadMagnet>) => updateMarketing({ leadMagnet: { ...getActiveProject()!.marketing.leadMagnet!, ...patch } });

  const generate = async () => {
    if (lm && !(await confirmAction({ title: 'Replace your lead magnet?', body: 'The current freebie and opt-in copy will be replaced.', confirmLabel: 'Replace' }))) return;
    const r = await ai.run({ type });
    if (r) updateMarketing({ leadMagnet: r });
  };

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="flex min-w-0 flex-col gap-4">
        <section className="panel p-4 sm:p-5" aria-label="Lead magnet type">
          <h2 className="section-title mb-1">Free lead magnet</h2>
          <p className="mb-3 text-[13px] text-muted">A quick win your ideal buyer will trade their email for, designed to lead naturally to {project.studio.listing.title || project.brand.name}.</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Lead magnet type">
            {LEAD_MAGNET_TYPES.map((t) => (
              <button key={t.id} role="radio" aria-checked={type === t.id} onClick={() => setType(t.id)} className={cn('flex flex-col gap-1 rounded-md border p-3 text-left transition-colors', type === t.id ? 'border-primary bg-primary-soft' : 'border-line hover:border-line-2 hover:bg-surface-2')}>
                <span className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <Icon name={t.icon} size={14} className={type === t.id ? 'text-primary' : 'text-muted'} /> {t.label}
                </span>
                <span className="text-[11.5px] leading-snug text-muted">{t.desc}</span>
              </button>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <GenerateButton running={ai.running} onClick={generate}>
              {lm ? 'Generate a new lead magnet' : 'Generate lead magnet'}
            </GenerateButton>
            {lm && (
              <>
                <CopyButton text={() => leadMagnetMarkdown(getActiveProject()!.marketing.leadMagnet!, project.brand.name)} label="Copy" />
                <button className="btn btn-secondary btn-sm" onClick={() => download(`${slugify(lm.title)}.md`, leadMagnetMarkdown(lm, project.brand.name))}>
                  <Download size={14} /> Export .md
                </button>
              </>
            )}
          </div>
          <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} className="mt-3" />
          {ai.result && !ai.running && <AIResultBar className="mt-3" provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
        </section>

        {lm ? (
          <section className="panel flex flex-col gap-3.5 p-4 sm:p-5" aria-label="Lead magnet content">
            <div className="flex items-center gap-2">
              <FileText size={16} className="text-primary" />
              <h3 className="text-[14px] font-semibold">Freebie content</h3>
              <span className="badge ml-auto bg-surface-2 text-ink-2">{LEAD_MAGNET_TYPES.find((t) => t.id === lm.type)?.label}</span>
            </div>
            <Field label="Title" htmlFor="lm-title">
              <input id="lm-title" className="input font-semibold" value={lm.title} onChange={(e) => set({ title: e.target.value })} />
            </Field>
            <Field label="Subtitle" htmlFor="lm-sub">
              <input id="lm-sub" className="input" value={lm.subtitle} onChange={(e) => set({ subtitle: e.target.value })} />
            </Field>
            <Field label="Intro" htmlFor="lm-intro">
              <AutoTextarea id="lm-intro" value={lm.intro} onChange={(v) => set({ intro: v })} minRows={2} className="text-[13.5px]" />
            </Field>
            {lm.sections.map((sec, i) => (
              <div key={i} className="rounded-md border border-line bg-surface-2/40 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <input className="input input-sm flex-1 font-semibold" value={sec.heading} onChange={(e) => set({ sections: lm.sections.map((x, j) => (j === i ? { ...x, heading: e.target.value } : x)) })} aria-label={`Section ${i + 1} heading`} />
                  <button className="btn btn-ghost btn-icon btn-xs text-muted hover:text-bad" onClick={() => set({ sections: lm.sections.filter((_, j) => j !== i) })} aria-label={`Remove section ${i + 1}`}>
                    <Trash2 size={13} />
                  </button>
                </div>
                <LinesEditor values={sec.items} onChange={(v) => set({ sections: lm.sections.map((x, j) => (j === i ? { ...x, items: v } : x)) })} />
              </div>
            ))}
            <button className="btn btn-secondary btn-sm self-start" onClick={() => set({ sections: [...lm.sections, { heading: 'New section', items: ['First item'] }] })}>
              <Plus size={14} /> Add section
            </button>
            <Field label="Closing call to action" htmlFor="lm-cta">
              <AutoTextarea id="lm-cta" value={lm.cta} onChange={(v) => set({ cta: v })} minRows={2} className="text-[13.5px]" />
            </Field>
          </section>
        ) : (
          !ai.running && <Empty icon={<Gift size={20} />} title="No lead magnet yet" body="Pick a format above and generate one. You can edit every line afterwards." />
        )}
      </div>

      <aside className="flex min-w-0 flex-col gap-4">{lm && <OptInPreview project={project} lm={lm} set={set} onSimulate={onSimulate} />}</aside>
    </div>
  );
}

function OptInPreview({ project, lm, set, onSimulate }: { project: Project; lm: LeadMagnet; set: (p: Partial<LeadMagnet>) => void; onSimulate: (subId: string) => void }) {
  const c = project.brand.colors;
  const profile = useStore((s) => s.settings.profile);
  const [name, setName] = useState(profile.name);
  const [email, setEmail] = useState(profile.email);
  const [done, setDone] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const onPrimary = readableOn(c.primary);
  return (
    <>
      <section className="panel overflow-hidden" aria-label="Opt-in page preview">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h3 className="text-[13px] font-semibold">Opt-in page preview</h3>
          <span className="badge bg-surface-2 text-muted">Live</span>
        </div>
        <div className="p-5" style={{ background: `linear-gradient(160deg, ${withAlpha(c.primary, 0.1)}, ${c.paper} 60%)`, color: c.ink }}>
          <div className="mb-4">
            <BrandLogo brand={project.brand} size={26} layout="horizontal" />
          </div>
          <div className="flex gap-4">
            <div className="relative hidden h-[124px] w-[96px] shrink-0 rotate-[-4deg] flex-col justify-between rounded-md p-2.5 shadow-pop sm:flex" style={{ background: c.primary, color: onPrimary }} aria-hidden="true">
              <span className="text-[8px] font-bold uppercase tracking-wider opacity-80">Free {LEAD_MAGNET_TYPES.find((t) => t.id === lm.type)?.label}</span>
              <span className="text-[11px] font-extrabold leading-tight">{lm.title}</span>
              <span className="h-1 w-8 rounded-full" style={{ background: c.accent }} />
            </div>
            <div className="min-w-0">
              <p className="text-[19px] font-extrabold leading-tight">{lm.optInHeadline}</p>
              <ul className="mt-3 flex flex-col gap-1.5 text-[13px]">
                {lm.optInBullets.map((b, i) => (
                  <li key={i} className="flex gap-1.5">
                    <Check size={14} className="mt-0.5 shrink-0" style={{ color: c.primary }} /> {b}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {done ? (
            <div className="mt-5 rounded-md bg-white/80 p-4 text-[13.5px] text-[#1d2420]">
              <p className="font-bold">You’re in! Check your inbox.</p>
              <p className="mt-0.5 text-[12.5px] text-[#5b6861]">“{lm.title}” is on its way. (Test subscriber added; no real email is sent.)</p>
              <button className="btn btn-primary btn-sm mt-3" onClick={() => onSimulate(done)}>
                Watch the sequence arrive <ArrowRight size={14} />
              </button>
            </div>
          ) : (
            <form
              className="mt-5 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setTouched(true);
                if (!emailValid(email)) return;
                const sub = addSubscriber(name, email, 'test');
                setDone(sub.id);
              }}
            >
              <label className="sr-only" htmlFor="oi-name">
                First name
              </label>
              <input id="oi-name" className="w-full rounded-md border border-black/10 bg-white px-3 py-2.5 text-[14px] text-[#1d2420] outline-none focus:border-black/30" placeholder="First name" value={name} onChange={(e) => setName(e.target.value)} />
              <label className="sr-only" htmlFor="oi-email">
                Email
              </label>
              <input id="oi-email" type="email" className="w-full rounded-md border border-black/10 bg-white px-3 py-2.5 text-[14px] text-[#1d2420] outline-none focus:border-black/30" placeholder="you@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              {touched && !emailValid(email) && <p className="text-xs font-medium text-[#b42318]">Enter a valid email address.</p>}
              <button type="submit" className="w-full rounded-md px-4 py-3 text-[15px] font-bold shadow-sm" style={{ background: c.primary, color: onPrimary }}>
                {lm.buttonLabel}
              </button>
              <p className="text-center text-[11px] opacity-70">No spam. Unsubscribe anytime.</p>
            </form>
          )}
        </div>
        <p className="border-t border-line px-4 py-2 text-[11.5px] text-muted">Submitting adds a test subscriber so you can try the funnel. Test sign-ups never count toward Analytics.</p>
      </section>

      <section className="panel flex flex-col gap-3 p-4" aria-label="Opt-in copy">
        <h3 className="text-[13px] font-semibold">Opt-in copy</h3>
        <Field label="Headline" htmlFor="oi-h">
          <AutoTextarea id="oi-h" value={lm.optInHeadline} onChange={(v) => set({ optInHeadline: v })} minRows={1} className="text-[13.5px]" />
        </Field>
        <Field label="Benefit bullets (one per line)">
          <LinesEditor values={lm.optInBullets} onChange={(v) => set({ optInBullets: v })} minRows={3} />
        </Field>
        <Field label="Button label" htmlFor="oi-btn">
          <input id="oi-btn" className="input" value={lm.buttonLabel} onChange={(e) => set({ buttonLabel: e.target.value })} />
        </Field>
      </section>
    </>
  );
}
