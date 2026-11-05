import { useState } from 'react';
import { Check, Copy, Download, Plus, Trash2 } from 'lucide-react';
import type { LeadMagnet, LeadMagnetType, Project } from '@/lib/types';
import { emailValid, readableOn, slugify, withAlpha } from '@/lib/utils';
import { LEAD_MAGNET_TYPES, leadMagnetMarkdown } from '@/ai/local/email';
import { applyLeadMagnet } from '@/lib/emailFunnel';
import { leadMagnetTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { copyText } from '@/lib/platform';
import { getActiveProject, useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { AutoTextarea, Empty, Field, LinesEditor, MoreMenu, OptionCards, Section, Select, Tooltip, confirmAction } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { BrandLogo } from '@/components/brand/Logo';
import { BrowserFrame } from '@/components/frames/Frames';
import { download } from '@/components/ui/download';
import { PanelHead } from './shared';

export function LeadMagnetPanel({ project }: { project: Project }) {
  const updateMarketing = useStore((s) => s.updateMarketing);
  const lm = project.marketing.leadMagnet;
  const [type, setType] = useState<LeadMagnetType>(lm?.type ?? 'checklist');
  const ai = useAI(leadMagnetTask);
  const set = (patch: Partial<LeadMagnet>) => updateMarketing({ leadMagnet: { ...getActiveProject()!.marketing.leadMagnet!, ...patch } });

  const generate = async () => {
    if (lm && !(await confirmAction({ title: 'Replace your lead magnet?', body: 'The current freebie and opt-in copy will be replaced.', confirmLabel: 'Replace' }))) return;
    const r = await ai.run({ type });
    if (r) applyLeadMagnet(r, project.id);
  };
  const copyMarkdown = async () => {
    const cur = getActiveProject()!.marketing.leadMagnet;
    if (!cur) return;
    if (await copyText(leadMagnetMarkdown(cur, project.brand.name))) toast({ kind: 'success', title: 'Copied as Markdown' });
    else toast({ kind: 'error', title: 'Copy was blocked', body: 'Use Export .md instead.' });
  };

  const thinking = <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} />;
  const resultBar = ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />;

  // before there's a lead magnet: what it is, the six kinds, and one button that writes it
  if (!lm) {
    return (
      <div className="flex flex-col gap-4">
        <Empty
          variant="ai"
          title="Turn visitors into subscribers"
          body="A free guide, an opt-in page and five emails in your voice."
          action={
            <GenerateButton variant="ai" size="lg" running={ai.running} runningLabel="Writing…" onClick={generate}>
              Generate lead magnet
            </GenerateButton>
          }
          className="pb-10"
        />
        <div className="mx-auto w-full max-w-[880px]">
          <p className="label">What kind of freebie?</p>
          <OptionCards<LeadMagnetType>
            aria-label="Lead magnet type"
            columns={3}
            value={type}
            onChange={setType}
            options={LEAD_MAGNET_TYPES.map((t) => ({ value: t.id, title: t.label, description: t.desc, icon: <Icon name={t.icon} size={20} /> }))}
          />
        </div>
        {thinking}
        {resultBar}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12">
      <div className="flex min-w-0 flex-col lg:col-span-7">
        <Section>
          <PanelHead
            title="Lead magnet"
            description={`A quick win people trade their email for, leading to ${project.studio.listing.title || project.brand.name}.`}
            actions={
              <>
                <Select<LeadMagnetType> size="sm" aria-label="Lead magnet type" value={type} onChange={setType} options={LEAD_MAGNET_TYPES.map((t) => ({ value: t.id, label: t.label }))} className="w-[150px]" />
                <GenerateButton size="sm" running={ai.running} runningLabel="Writing…" onClick={generate}>
                  Write a new one
                </GenerateButton>
                <MoreMenu
                  items={[
                    { label: 'Copy as Markdown', icon: <Copy />, onSelect: () => void copyMarkdown() },
                    { label: 'Export .md', icon: <Download />, onSelect: () => void download(`${slugify(lm.title)}.md`, leadMagnetMarkdown(lm, project.brand.name)) },
                  ]}
                />
              </>
            }
          />
          <div className="flex flex-col gap-4">
            {thinking}
            {resultBar}
            <Field label="Title" htmlFor="lm-title">
              <input id="lm-title" className="input" value={lm.title} onChange={(e) => set({ title: e.target.value })} />
            </Field>
            <Field label="Subtitle" htmlFor="lm-sub">
              <input id="lm-sub" className="input" value={lm.subtitle} onChange={(e) => set({ subtitle: e.target.value })} />
            </Field>
            <Field label="Intro" htmlFor="lm-intro">
              <AutoTextarea id="lm-intro" value={lm.intro} onChange={(v) => set({ intro: v })} minRows={2} />
            </Field>
            <div>
              <p className="label">Sections</p>
              <ol className="flex flex-col divide-y divide-line rounded-lg border border-line">
                {lm.sections.map((sec, i) => (
                  <li key={i} className="flex flex-col gap-2 p-3">
                    <div className="flex items-center gap-2">
                      <span className="num w-5 shrink-0 font-mono text-caption text-muted">{i + 1}</span>
                      <input className="input input-inline min-w-0 flex-1 text-h4" value={sec.heading} onChange={(e) => set({ sections: lm.sections.map((x, j) => (j === i ? { ...x, heading: e.target.value } : x)) })} aria-label={`Section ${i + 1} heading`} />
                      <Tooltip content="Remove section">
                        <button type="button" className="btn btn-danger-ghost btn-icon btn-xs" onClick={() => set({ sections: lm.sections.filter((_, j) => j !== i) })} aria-label={`Remove section ${i + 1}`}>
                          <Trash2 />
                        </button>
                      </Tooltip>
                    </div>
                    <LinesEditor values={sec.items} onChange={(v) => set({ sections: lm.sections.map((x, j) => (j === i ? { ...x, items: v } : x)) })} />
                  </li>
                ))}
              </ol>
              <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => set({ sections: [...lm.sections, { heading: 'New section', items: ['First item'] }] })}>
                <Plus /> Add section
              </button>
            </div>
            <Field label="Closing call to action" htmlFor="lm-cta">
              <AutoTextarea id="lm-cta" value={lm.cta} onChange={(v) => set({ cta: v })} minRows={2} />
            </Field>
          </div>
        </Section>

        <Section title="Opt-in page" description="The words on the page where people sign up." divider>
          <div className="flex flex-col gap-4" aria-label="Opt-in copy" role="group">
            <Field label="Headline" htmlFor="oi-h">
              <AutoTextarea id="oi-h" value={lm.optInHeadline} onChange={(v) => set({ optInHeadline: v })} minRows={1} />
            </Field>
            <Field label="Benefit bullets" right="One per line">
              <LinesEditor values={lm.optInBullets} onChange={(v) => set({ optInBullets: v })} minRows={3} />
            </Field>
            <Field label="Button label" htmlFor="oi-btn">
              <input id="oi-btn" className="input" value={lm.buttonLabel} onChange={(e) => set({ buttonLabel: e.target.value })} />
            </Field>
          </div>
        </Section>
      </div>

      <aside className="min-w-0 lg:sticky lg:top-4 lg:col-span-5">
        <OptInPreview project={project} lm={lm} />
      </aside>
    </div>
  );
}

// The opt-in page as visitors see it: the business's own page (its colours, its button), so it keeps its
// own look in both themes. Only the frame around it is the app's.
const PAGE_INK = '#1d2420';
const PAGE_MUTED = '#5b6861';

function OptInPreview({ project, lm }: { project: Project; lm: LeadMagnet }) {
  const c = project.brand.colors;
  const profile = useStore((s) => s.settings.profile);
  const [name, setName] = useState(profile.name);
  const [email, setEmail] = useState(profile.email);
  const [done, setDone] = useState(false);
  const [touched, setTouched] = useState(false);
  const onPrimary = readableOn(c.primary);
  const typeLabel = LEAD_MAGNET_TYPES.find((t) => t.id === lm.type)?.label;
  const site = project.brand.websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const field = { width: '100%', borderRadius: 8, border: '1px solid rgba(0,0,0,.12)', background: '#ffffff', padding: '10px 12px', fontSize: 14, color: PAGE_INK } as const;
  return (
    <section aria-label="Opt-in page preview">
      <BrowserFrame url={site ? `${site}/free` : 'Your opt-in page'}>
        <div style={{ background: `linear-gradient(160deg, ${withAlpha(c.primary, 0.1)}, ${c.paper} 60%)`, color: c.ink, padding: 24 }}>
          <div style={{ marginBottom: 20 }}>
            <BrandLogo brand={project.brand} size={26} layout="horizontal" />
          </div>
          <div className="flex gap-4">
            <div aria-hidden="true" className="relative hidden shrink-0 flex-col justify-between sm:flex" style={{ height: 124, width: 96, transform: 'rotate(-4deg)', borderRadius: 8, padding: 10, background: c.primary, color: onPrimary, boxShadow: '0 12px 24px -12px rgba(0,0,0,.35)' }}>
              <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.8 }}>Free {typeLabel}</span>
              <span style={{ fontSize: 11, fontWeight: 800, lineHeight: 1.2 }}>{lm.title}</span>
              <span style={{ height: 4, width: 32, borderRadius: 999, background: c.accent }} />
            </div>
            <div className="min-w-0">
              <p style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.2 }}>{lm.optInHeadline}</p>
              <ul className="flex flex-col" style={{ marginTop: 12, gap: 6, fontSize: 13 }}>
                {lm.optInBullets.map((b, i) => (
                  <li key={i} className="flex" style={{ gap: 6 }}>
                    <Check size={14} className="shrink-0" style={{ marginTop: 2, color: c.primary }} aria-hidden="true" /> {b}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {done ? (
            <div style={{ marginTop: 20, borderRadius: 8, background: 'rgba(255,255,255,.85)', padding: 16, fontSize: 14, color: PAGE_INK }}>
              <p style={{ fontWeight: 700 }}>This is only a preview.</p>
              <p style={{ marginTop: 2, fontSize: 13, color: PAGE_MUTED }}>On your real opt-in page, this form sends the sign-up to your email provider, which delivers “{lm.title}”. Nothing was saved or sent here.</p>
              <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={() => setDone(false)}>
                Back to the form
              </button>
            </div>
          ) : (
            <form
              className="flex flex-col"
              style={{ marginTop: 20, gap: 8 }}
              onSubmit={(e) => {
                e.preventDefault();
                setTouched(true);
                if (!emailValid(email)) return;
                setDone(true);
              }}
            >
              <label className="sr-only" htmlFor="oi-name">
                First name
              </label>
              <input id="oi-name" style={field} placeholder="First name" value={name} onChange={(e) => setName(e.target.value)} />
              <label className="sr-only" htmlFor="oi-email">
                Email
              </label>
              <input id="oi-email" type="email" style={field} placeholder="you@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              {touched && !emailValid(email) && <p style={{ fontSize: 12, fontWeight: 500, color: '#b42318' }}>Enter a valid email address.</p>}
              <button type="submit" style={{ width: '100%', borderRadius: 8, padding: '12px 16px', fontSize: 15, fontWeight: 700, background: c.primary, color: onPrimary, boxShadow: '0 1px 2px rgba(0,0,0,.15)' }}>
                {lm.buttonLabel}
              </button>
              <p style={{ textAlign: 'center', fontSize: 11, opacity: 0.7 }}>No spam. Unsubscribe anytime.</p>
            </form>
          )}
        </div>
      </BrowserFrame>
      <p className="mt-2 text-caption text-muted">A preview of your page’s words. To collect sign-ups, use your email provider’s form.</p>
    </section>
  );
}
