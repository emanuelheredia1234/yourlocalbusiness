import { useState } from 'react';
import { ArrowDown, ArrowUp, BadgeDollarSign, ChevronDown, Download, FileText, Gift, Layers, ListTree, Plus, ShieldCheck, Sparkles, Star, Trash2, Wand2 } from 'lucide-react';
import type { OperatingBlock, OutlineItem, OutlineSection, PriceModel, Project, ServicePackage, ServicePriceModel, ValueStackItem } from '@/lib/types';
import { cn, fmtMoney, moveItem, slugify, uid } from '@/lib/utils';
import { FORMATS } from '@/ai/knowledge';
import { businessModelTask, expandItemTask, outlineTask, sectionDraftTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { getActiveProject, useStore } from '@/store/useStore';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { AutoTextarea, CopyButton, Empty, Field, LinesEditor, Spinner, confirmAction } from '@/components/ui/primitives';
import { Markdown } from '@/components/ui/Markdown';
import { ProductFiles } from './ProductFiles';
import { download } from '@/components/ui/download';

const studio = () => getActiveProject()!.studio;

export function StructureTab({ project }: { project: Project }) {
  return project.track === 'business' ? <BusinessModel project={project} /> : <OutlineBuilder project={project} />;
}

// ───────────────────────── Product outline ─────────────────────────

function outlineMarkdown(p: Project): string {
  const s = p.studio;
  const lines = [`# ${p.idea?.title ?? p.brand.name}`, '', `${s.outlineLabel}`, ''];
  s.outline.forEach((sec, i) => {
    lines.push(`## ${i + 1}. ${sec.title}`);
    if (sec.summary) lines.push('', sec.summary);
    lines.push('');
    sec.items.forEach((it) => lines.push(`- **${it.title}**${it.meta ? ` (${it.meta})` : ''}${it.detail ? `: ${it.detail}` : ''}`));
    if (sec.draft) lines.push('', sec.draft);
    lines.push('');
  });
  return lines.join('\n');
}

function totals(sections: OutlineSection[]) {
  let minutes = 0;
  let pages = 0;
  let items = 0;
  for (const s of sections)
    for (const it of s.items) {
      items++;
      const m = /(\d+)\s*min/i.exec(it.meta ?? '');
      const pg = /(\d+)\s*(?:pages?|pp)/i.exec(it.meta ?? '');
      if (m) minutes += Number(m[1]);
      if (pg) pages += Number(pg[1]);
    }
  return { minutes, pages, items, drafted: sections.filter((s) => s.draft).length };
}

function OutlineBuilder({ project }: { project: Project }) {
  const updateStudio = useStore((s) => s.updateStudio);
  const ai = useAI(outlineTask);
  const outline = project.studio.outline;
  const fmt = FORMATS[project.format ?? 'pdf'];
  const setOutline = (fn: (o: OutlineSection[]) => OutlineSection[]) => updateStudio({ outline: fn(studio().outline) });
  const patchSection = (id: string, patch: Partial<OutlineSection>) => setOutline((o) => o.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const t = totals(outline);

  const generate = async () => {
    if (outline.length && !(await confirmAction({ title: 'Replace the current outline?', body: 'A fresh AI draft will replace your current sections and edits.', confirmLabel: 'Replace outline' }))) return;
    const r = await ai.run({});
    if (r) updateStudio({ outline: r.sections, outlineLabel: r.label });
  };

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="section-title flex items-center gap-2">
              <ListTree size={18} className="text-primary" /> {project.studio.outlineLabel || fmt.outlineLabel}
            </h2>
            <p className="text-[13px] text-muted">AI structure for your {fmt.short.toLowerCase()}. Edit anything, expand items or draft whole sections.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {outline.length > 0 && (
              <>
                <CopyButton text={() => outlineMarkdown(getActiveProject()!)} label="Copy" />
                <button className="btn btn-secondary btn-sm" onClick={() => download(`${slugify(project.idea?.title ?? project.brand.name)}-outline.md`, outlineMarkdown(project))}>
                  <Download size={14} /> Export .md
                </button>
              </>
            )}
            <GenerateButton running={ai.running} onClick={generate} size="sm">
              {outline.length ? 'Regenerate outline' : 'Generate outline'}
            </GenerateButton>
          </div>
        </div>
        <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} />
        {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
        {ai.error && <p className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{ai.error}</p>}

        {!outline.length && !ai.running ? (
          <Empty
            icon={<ListTree size={20} />}
            title={`No ${fmt.outlineLabel.toLowerCase()} yet`}
            body={`The AI maps the transformation for ${project.idea?.audience || project.brand.audience || 'your buyer'}, from the first quick win to the final outcome.`}
            action={
              <GenerateButton running={ai.running} onClick={generate}>
                Generate {fmt.outlineLabel.toLowerCase()}
              </GenerateButton>
            }
          />
        ) : (
          <ol className="flex flex-col gap-3">
            {outline.map((sec, i) => (
              <SectionCard
                key={sec.id}
                section={sec}
                index={i}
                total={outline.length}
                onChange={(patch) => patchSection(sec.id, patch)}
                onMove={(dir) => setOutline((o) => moveItem(o, i, i + dir))}
                onRemove={async () => {
                  if (await confirmAction({ title: `Delete “${sec.title}”?`, body: 'Its items and draft will be removed.', confirmLabel: 'Delete', danger: true })) setOutline((o) => o.filter((s) => s.id !== sec.id));
                }}
              />
            ))}
          </ol>
        )}
        {outline.length > 0 && (
          <button
            className="btn btn-secondary self-start"
            onClick={() => setOutline((o) => [...o, { id: uid('sec'), title: `New ${fmt.unit.replace(/s$/, '')}`, summary: '', items: [{ id: uid('item'), title: 'First lesson', meta: '' }] }])}
          >
            <Plus size={15} /> Add section
          </button>
        )}
      </div>

      <aside className="flex min-w-0 flex-col gap-4">
        <ProductFiles project={project} />
        <ProductOffer project={project} />
        <section className="panel p-4">
          <h3 className="mb-3 text-[13px] font-semibold">At a glance</h3>
          <dl className="grid grid-cols-2 gap-3 text-[13px]">
            <Stat label="Sections" value={outline.length} />
            <Stat label="Items" value={t.items} />
            <Stat label="Video / audio" value={t.minutes ? `${Math.round(t.minutes)} min` : '—'} />
            <Stat label="Pages" value={t.pages || '—'} />
            <Stat label="Drafted" value={`${t.drafted}/${outline.length || 0}`} />
            <Stat label="Format" value={fmt.short} />
          </dl>
        </section>
      </aside>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2">
      <dt className="text-[11px] font-medium text-muted">{label}</dt>
      <dd className="num text-[15px] font-bold text-ink">{value}</dd>
    </div>
  );
}

function SectionCard({ section, index, total, onChange, onMove, onRemove }: { section: OutlineSection; index: number; total: number; onChange: (p: Partial<OutlineSection>) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(index < 2);
  const [editDraft, setEditDraft] = useState(false);
  const [expanding, setExpanding] = useState<string | null>(null);
  const draftAI = useAI(sectionDraftTask);
  const expandAI = useAI(expandItemTask);
  const live = () => studio().outline.find((s) => s.id === section.id) ?? section;
  const setItems = (fn: (items: OutlineItem[]) => OutlineItem[]) => onChange({ items: fn(live().items) });
  const patchItem = (id: string, patch: Partial<OutlineItem>) => setItems((items) => items.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const draft = async () => {
    const r = await draftAI.run({ section: live() });
    if (r) {
      onChange({ draft: r.markdown });
      setOpen(true);
    }
  };
  const expand = async (item: OutlineItem) => {
    setExpanding(item.id);
    const r = await expandAI.run({ item, section: live() });
    setExpanding(null);
    if (r) patchItem(item.id, { detail: r.detail });
  };

  return (
    <li className="panel overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
        <span className="num flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[12px] font-bold text-primary">{index + 1}</span>
        <input className="min-w-0 flex-1 rounded bg-transparent px-1 py-1 font-display text-[15.5px] font-semibold outline-none hover:bg-surface-2 focus:bg-surface-2" value={section.title} onChange={(e) => onChange({ title: e.target.value })} aria-label={`Section ${index + 1} title`} />
        <span className="hidden text-xs text-muted sm:inline">{section.items.length} items</span>
        {section.draft && <span className="badge bg-good-soft text-good">Drafted</span>}
        <button className="btn btn-ghost btn-icon btn-xs" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move section up">
          <ArrowUp size={14} />
        </button>
        <button className="btn btn-ghost btn-icon btn-xs" disabled={index === total - 1} onClick={() => onMove(1)} aria-label="Move section down">
          <ArrowDown size={14} />
        </button>
        <button className="btn btn-ghost btn-icon btn-xs" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? 'Collapse section' : 'Expand section'}>
          <ChevronDown size={16} className={cn('transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line px-3 py-3 sm:px-4">
          <AutoTextarea value={section.summary ?? ''} onChange={(v) => onChange({ summary: v })} minRows={1} placeholder="One-line summary of this section" className="min-h-0 text-[13px]" aria-label="Section summary" />
          <ul className="flex flex-col gap-2">
            {section.items.map((it, j) => (
              <li key={it.id} className="group rounded-md border border-line bg-surface-2/40 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="num w-8 shrink-0 text-xs font-semibold text-muted">
                    {index + 1}.{j + 1}
                  </span>
                  <input className="input input-sm min-w-[160px] flex-1" value={it.title} onChange={(e) => patchItem(it.id, { title: e.target.value })} aria-label="Item title" />
                  <input className="input input-sm w-[130px]" value={it.meta ?? ''} onChange={(e) => patchItem(it.id, { meta: e.target.value })} placeholder="Video · 8 min" aria-label="Item format or length" />
                  <button className="btn btn-ghost btn-xs" onClick={() => expand(it)} disabled={!!expanding} title="Add talking points with AI">
                    {expanding === it.id ? <Spinner size={13} /> : <Wand2 size={13} className="text-primary" />} Expand
                  </button>
                  <button className="btn btn-ghost btn-icon btn-xs text-muted hover:text-bad" onClick={() => setItems((items) => items.filter((x) => x.id !== it.id))} aria-label={`Delete ${it.title}`}>
                    <Trash2 size={13} />
                  </button>
                </div>
                {(it.detail || expanding === it.id) && (
                  <AutoTextarea value={it.detail ?? ''} onChange={(v) => patchItem(it.id, { detail: v })} minRows={1} className="mt-2 text-[13px]" aria-label="Item details" />
                )}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-secondary btn-sm" onClick={() => setItems((items) => [...items, { id: uid('item'), title: 'New item', meta: '' }])}>
              <Plus size={14} /> Add item
            </button>
            <GenerateButton running={draftAI.running} onClick={draft} size="sm" variant="secondary" icon={<FileText size={14} className="text-primary" />}>
              {section.draft ? 'Redraft section' : 'Draft this section'}
            </GenerateButton>
            <button className="btn btn-ghost btn-sm ml-auto text-muted hover:text-bad" onClick={onRemove}>
              <Trash2 size={14} /> Delete section
            </button>
          </div>
          <AIThinking running={draftAI.running} stage={draftAI.stage} chars={draftAI.chars} onStop={draftAI.stop} compact />
          {section.draft && !draftAI.running && (
            <div className="rounded-md border border-line bg-surface">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
                <span className="text-xs font-semibold text-muted">Section draft</span>
                <div className="flex items-center gap-1.5">
                  <CopyButton text={section.draft} size="xs" />
                  <button className="btn btn-ghost btn-xs" onClick={() => setEditDraft((e) => !e)}>
                    {editDraft ? 'Preview' : 'Edit'}
                  </button>
                  <button className="btn btn-ghost btn-xs text-muted hover:text-bad" onClick={() => onChange({ draft: undefined })}>
                    Remove
                  </button>
                </div>
              </div>
              <div className="max-h-[420px] overflow-y-auto p-3 scroll-thin">
                {editDraft ? <AutoTextarea value={section.draft} onChange={(v) => onChange({ draft: v })} minRows={10} className="font-mono text-[12.5px]" aria-label="Edit draft markdown" /> : <Markdown text={section.draft} />}
              </div>
              {draftAI.result && <AIResultBar className="border-t border-line px-3 py-2" provider={draftAI.result.provider} skills={draftAI.result.skills} ms={draftAI.result.ms} note={draftAI.result.note} logId={draftAI.logId} />}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function ProductOffer({ project }: { project: Project }) {
  const updateStudio = useStore((s) => s.updateStudio);
  const s = project.studio;
  const idea = project.idea;
  return (
    <section className="panel p-4">
      <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
        <BadgeDollarSign size={15} className="text-primary" /> Offer & pricing
      </h3>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Price" htmlFor="st-price">
          <input id="st-price" type="number" min={0} className="input num" value={s.price} onChange={(e) => updateStudio({ price: Math.max(0, Number(e.target.value) || 0) })} />
        </Field>
        <Field label="Compare at" htmlFor="st-compare" hint="Optional strike-through">
          <input id="st-compare" type="number" min={0} className="input num" value={s.compareAt || ''} placeholder="—" onChange={(e) => updateStudio({ compareAt: Math.max(0, Number(e.target.value) || 0) })} />
        </Field>
        <Field label="Billing" htmlFor="st-model" className="col-span-2">
          <select id="st-model" className="select" value={s.priceModel} onChange={(e) => updateStudio({ priceModel: e.target.value as PriceModel })}>
            <option value="one-time">One-time payment</option>
            <option value="monthly">Monthly subscription</option>
            <option value="yearly">Yearly subscription</option>
          </select>
        </Field>
      </div>
      {idea && (
        <div className="mt-4 flex flex-col gap-2 border-t border-line pt-3 text-[13px]">
          <p className="font-semibold">{idea.title}</p>
          <p className="text-ink-2">{idea.hook}</p>
          <p className="text-xs text-muted">
            For {idea.audience} · potential {fmtMoney(idea.revenueLow, { compact: true })}–{fmtMoney(idea.revenueHigh, { compact: true })}/mo
          </p>
          {idea.features.length > 0 && (
            <ul className="mt-1 flex flex-col gap-1 text-xs text-ink-2">
              {idea.features.slice(0, 4).map((f) => (
                <li key={f} className="flex gap-1.5">
                  <Star size={12} className="mt-0.5 shrink-0 text-accent" /> {f}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// ───────────────────────── Business model ─────────────────────────

const PRICE_MODELS: { id: ServicePriceModel; label: string }[] = [
  { id: 'per-session', label: 'per session' },
  { id: 'project', label: 'per project' },
  { id: 'monthly', label: 'per month' },
  { id: 'one-time', label: 'one-time' },
  { id: 'quote', label: 'quote' },
  { id: 'free', label: 'free' },
];

function businessMarkdown(p: Project): string {
  const s = p.studio;
  const out = [`# ${p.brand.name}: business model`, '', '## Service packages', ''];
  s.packages.forEach((pk) => out.push(`### ${pk.name}: ${fmtMoney(pk.price)} ${PRICE_MODELS.find((m) => m.id === pk.priceModel)?.label ?? ''}${pk.popular ? ' (most popular)' : ''}`, pk.description, ...pk.includes.map((i) => `- ${i}`), ''));
  out.push('## Operating model', '');
  s.operating.forEach((b) => out.push(`### ${b.title}`, ...b.items.map((i) => `- ${i}`), ''));
  out.push('## Value stack', '');
  s.valueStack.forEach((v) => out.push(`- **${v.title}**${v.value ? ` (${fmtMoney(v.value)} value)` : ''}: ${v.description}`));
  return out.join('\n');
}

function BusinessModel({ project }: { project: Project }) {
  const updateStudio = useStore((s) => s.updateStudio);
  const ai = useAI(businessModelTask);
  const s = project.studio;
  const has = s.packages.length > 0;
  const setPackages = (fn: (x: ServicePackage[]) => ServicePackage[]) => updateStudio({ packages: fn(studio().packages) });
  const setOperating = (fn: (x: OperatingBlock[]) => OperatingBlock[]) => updateStudio({ operating: fn(studio().operating) });
  const setStack = (fn: (x: ValueStackItem[]) => ValueStackItem[]) => updateStudio({ valueStack: fn(studio().valueStack) });
  const generate = async () => {
    if (has && !(await confirmAction({ title: 'Replace your business model?', body: 'Packages, operating model and value stack will be replaced with a fresh AI draft.', confirmLabel: 'Replace' }))) return;
    const r = await ai.run({});
    if (r) updateStudio({ packages: r.packages, operating: r.operating, valueStack: r.valueStack, price: r.price });
  };
  const stackValue = s.valueStack.reduce((n, v) => n + (v.value || 0), 0);
  const popular = s.packages.find((p) => p.popular) ?? s.packages[0];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="section-title flex items-center gap-2">
            <Layers size={18} className="text-primary" /> Packages, operating model & value stack
          </h2>
          <p className="text-[13px] text-muted">Priced for {project.location?.city || 'your market'}. Everything here feeds your listing, sales page and campaign.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {has && (
            <button className="btn btn-secondary btn-sm" onClick={() => download(`${slugify(project.brand.name)}-business-model.md`, businessMarkdown(project))}>
              <Download size={14} /> Export .md
            </button>
          )}
          <GenerateButton running={ai.running} onClick={generate} size="sm">
            {has ? 'Regenerate model' : 'Generate business model'}
          </GenerateButton>
        </div>
      </div>
      <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} />
      {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
      {ai.error && <p className="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{ai.error}</p>}

      {!has && !ai.running ? (
        <Empty
          icon={<Layers size={20} />}
          title="No business model yet"
          body="Get three good-better-best packages with local pricing, a complete operating model and a value stack with bonuses and a guarantee."
          action={
            <GenerateButton running={ai.running} onClick={generate}>
              Generate business model
            </GenerateButton>
          }
        />
      ) : (
        <>
          <section aria-label="Service packages">
            <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted">Service packages</h3>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {s.packages.map((pk) => (
                <div key={pk.id} className={cn('panel flex flex-col gap-2.5 p-4', pk.popular && 'ring-2 ring-primary')}>
                  <div className="flex items-center justify-between gap-2">
                    <input className="min-w-0 flex-1 rounded bg-transparent px-1 font-display text-[16px] font-semibold outline-none hover:bg-surface-2 focus:bg-surface-2" value={pk.name} onChange={(e) => setPackages((x) => x.map((p) => (p.id === pk.id ? { ...p, name: e.target.value } : p)))} aria-label="Package name" />
                    <button
                      className={cn('badge', pk.popular ? 'bg-primary text-on-primary' : 'bg-surface-2 text-muted hover:text-ink')}
                      onClick={() => setPackages((x) => x.map((p) => ({ ...p, popular: p.id === pk.id })))}
                      aria-pressed={!!pk.popular}
                      title="Mark as most popular"
                    >
                      <Star size={10} /> {pk.popular ? 'Most popular' : 'Make popular'}
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted">$</span>
                    <input type="number" min={0} className="input input-sm num w-24" value={pk.price} onChange={(e) => setPackages((x) => x.map((p) => (p.id === pk.id ? { ...p, price: Math.max(0, Number(e.target.value) || 0) } : p)))} aria-label="Package price" />
                    <select className="select input-sm min-w-0 flex-1" value={pk.priceModel} onChange={(e) => setPackages((x) => x.map((p) => (p.id === pk.id ? { ...p, priceModel: e.target.value as ServicePriceModel } : p)))} aria-label="Pricing unit">
                      {PRICE_MODELS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <AutoTextarea value={pk.description} onChange={(v) => setPackages((x) => x.map((p) => (p.id === pk.id ? { ...p, description: v } : p)))} minRows={2} className="text-[13px]" aria-label="Package description" />
                  <Field label="Includes (one per line)">
                    <LinesEditor values={pk.includes} onChange={(v) => setPackages((x) => x.map((p) => (p.id === pk.id ? { ...p, includes: v } : p)))} />
                  </Field>
                  {s.packages.length > 1 && (
                    <button className="btn btn-ghost btn-xs self-start text-muted hover:text-bad" onClick={() => setPackages((x) => x.filter((p) => p.id !== pk.id))}>
                      <Trash2 size={12} /> Remove
                    </button>
                  )}
                </div>
              ))}
              {s.packages.length < 4 && (
                <button className="flex min-h-[160px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-2 text-[13px] font-semibold text-muted hover:border-primary hover:text-primary" onClick={() => setPackages((x) => [...x, { id: uid('pkg'), name: 'New package', price: popular?.price ?? 99, priceModel: popular?.priceModel ?? 'per-session', description: '', includes: [] }])}>
                  <Plus size={18} /> Add package
                </button>
              )}
            </div>
          </section>

          <section aria-label="Operating model">
            <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted">Operating model</h3>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
              {s.operating.map((b) => (
                <div key={b.id} className="panel flex flex-col gap-2 p-3.5">
                  <input className="rounded bg-transparent px-1 text-[14px] font-semibold outline-none hover:bg-surface-2 focus:bg-surface-2" value={b.title} onChange={(e) => setOperating((x) => x.map((o) => (o.id === b.id ? { ...o, title: e.target.value } : o)))} aria-label="Block title" />
                  <LinesEditor values={b.items} onChange={(v) => setOperating((x) => x.map((o) => (o.id === b.id ? { ...o, items: v } : o)))} minRows={3} className="text-[12.5px]" />
                </div>
              ))}
            </div>
          </section>

          <section aria-label="Value stack" className="panel overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <h3 className="text-[14px] font-semibold">Value stack</h3>
              <p className="text-[13px] text-muted">
                Total value <b className="num text-ink">{fmtMoney(stackValue)}</b> · you charge <b className="num text-ink">{fmtMoney(popular?.price ?? s.price)}</b>
                {popular && stackValue > popular.price && <span className="ml-1 text-good">({Math.round(stackValue / Math.max(1, popular.price))}× value)</span>}
              </p>
            </div>
            <ul className="divide-y divide-line">
              {s.valueStack.map((v) => (
                <li key={v.id} className="grid grid-cols-1 items-start gap-2 px-4 py-3 sm:grid-cols-[110px_minmax(0,1fr)_110px_32px]">
                  <span className={cn('badge self-center', v.kind === 'core' ? 'bg-primary-soft text-primary' : v.kind === 'bonus' ? 'bg-accent/20 text-ink' : 'bg-good-soft text-good')}>
                    {v.kind === 'core' ? <Layers size={11} /> : v.kind === 'bonus' ? <Gift size={11} /> : <ShieldCheck size={11} />}
                    {v.kind === 'core' ? 'Core offer' : v.kind === 'bonus' ? 'Bonus' : 'Guarantee'}
                  </span>
                  <div className="min-w-0">
                    <input className="input input-sm font-semibold" value={v.title} onChange={(e) => setStack((x) => x.map((i) => (i.id === v.id ? { ...i, title: e.target.value } : i)))} aria-label="Value item title" />
                    <AutoTextarea value={v.description} onChange={(t) => setStack((x) => x.map((i) => (i.id === v.id ? { ...i, description: t } : i)))} minRows={1} className="mt-1.5 text-[12.5px]" aria-label="Value item description" />
                  </div>
                  <label className="flex items-center gap-1 text-xs text-muted">
                    $
                    <input type="number" min={0} className="input input-sm num" value={v.value} onChange={(e) => setStack((x) => x.map((i) => (i.id === v.id ? { ...i, value: Math.max(0, Number(e.target.value) || 0) } : i)))} aria-label="Perceived value" />
                  </label>
                  <button className="btn btn-ghost btn-icon btn-xs text-muted hover:text-bad" onClick={() => setStack((x) => x.filter((i) => i.id !== v.id))} aria-label={`Remove ${v.title}`}>
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
              <button className="btn btn-secondary btn-sm" onClick={() => setStack((x) => [...x.filter((i) => i.kind !== 'guarantee'), { id: uid('vs'), kind: 'bonus', title: 'New bonus', value: 49, description: '' }, ...x.filter((i) => i.kind === 'guarantee')])}>
                <Gift size={14} /> Add bonus
              </button>
              {!s.valueStack.some((i) => i.kind === 'guarantee') && (
                <button className="btn btn-secondary btn-sm" onClick={() => setStack((x) => [...x, { id: uid('vs'), kind: 'guarantee', title: 'Our promise', value: 0, description: 'If you’re not happy, we’ll make it right or refund you.' }])}>
                  <ShieldCheck size={14} /> Add guarantee
                </button>
              )}
              <CopyButton text={() => businessMarkdown(getActiveProject()!)} label="Copy all" className="ml-auto" />
            </div>
          </section>
        </>
      )}
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <Sparkles size={12} /> Tip: add a Brain skill with your real prices, service area or policies and the AI will use them on every regenerate.
      </p>
    </div>
  );
}
