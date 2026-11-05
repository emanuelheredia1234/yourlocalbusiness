import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, Copy, Download, FileText, Gift, Layers, Plus, ShieldCheck, Star, Trash2, X } from 'lucide-react';
import type { OperatingBlock, OutlineItem, OutlineSection, PriceModel, Project, ServicePackage, ServicePriceModel, ValueStackItem } from '@/lib/types';
import { cn, fmtMoney, moveItem, slugify, uid } from '@/lib/utils';
import { copyText } from '@/lib/platform';
import { navigate } from '@/lib/router';
import { FORMATS } from '@/ai/knowledge';
import { businessModelTask, expandItemTask, outlineTask, sectionDraftTask } from '@/ai/tasks';
import { applyBusinessModel, applyItemDetail, applyOutline, applySectionDraft, businessMarkdown, outlineMarkdown, PACKAGE_PRICE_MODELS as PRICE_MODELS } from '@/ai/structure';
import { useAI } from '@/ai/useAI';
import { getActiveProject, useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { AutoTextarea, Badge, Callout, CopyButton, Empty, Field, InfoTip, MoreMenu, Section, Select, Skeleton, Tooltip, confirmAction, type MenuEntry } from '@/components/ui/primitives';
import { Markdown } from '@/components/ui/Markdown';
import { ProductFiles } from './ProductFiles';
import { download } from '@/components/ui/download';

const studio = () => getActiveProject()!.studio;

export function StructureTab({ project }: { project: Project }) {
  return project.track === 'business' ? <BusinessModel project={project} /> : <OutlineBuilder project={project} />;
}

/** Copy text, saying so (the menu closes, so there's no "Copied" on a button). */
async function copyWithToast(text: string, what: string) {
  if (await copyText(text)) toast({ kind: 'success', title: `${what} copied` });
  else toast({ kind: 'error', title: 'Copy was blocked', body: 'Use Export .md instead.' });
}

// ───────────────────────── AI-drafted lines with blanks ─────────────────────────

/** "[your hours]": a blank the AI left for the owner to fill in. */
const BLANK = /^\[(.+)\]$/;
/** "Opening hours: [your hours]": a named blank. */
const NAMED_BLANK = /^([^:[\]]{2,48}):\s*\[(.+)\]$/;
/** "Service area: Austin, TX": a named value. */
const NAMED = /^([^:[\]]{2,48}):\s*(.*)$/;

/**
 * A line of drafted text, split for display: a blank shows as an empty field with its hint as the placeholder
 * (the stored text keeps the blank until the owner types); `named` also splits off "Label:" from its value.
 */
function splitLine(line: string, named: boolean): { label?: string; value: string; hint?: string } {
  const t = line.trim();
  const blank = BLANK.exec(t);
  if (blank) return { value: '', hint: blank[1] };
  const nb = NAMED_BLANK.exec(t);
  if (nb) return { label: nb[1].trim(), value: '', hint: nb[2] };
  if (named) {
    const n = NAMED.exec(line);
    if (n) return { label: n[1].trim(), value: n[2] };
  }
  return { value: line };
}
const joinLine = (label: string | undefined, value: string) => (label ? `${label}: ${value}` : value);

/**
 * Editable rows of short lines (a package's "Includes", a block of the operating model), each with an optional
 * leading icon and a remove button; "Add item" adds a row and puts the cursor in it. An emptied row goes on blur.
 */
function EditableLines({
  items,
  onChange,
  icon,
  named,
  itemLabel,
  addLabel = 'Add item',
  placeholder,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  icon?: ReactNode;
  /** show "Label: value" lines as a definition list (label left, value right) */
  named?: boolean;
  itemLabel: (i: number) => string;
  addLabel?: string;
  placeholder?: string;
}) {
  const list = useRef<HTMLUListElement>(null);
  const [focusLast, setFocusLast] = useState(false);
  useEffect(() => {
    if (!focusLast) return;
    setFocusLast(false);
    const inputs = list.current?.querySelectorAll<HTMLInputElement>('input');
    inputs?.[inputs.length - 1]?.focus();
  }, [focusLast]);
  const set = (i: number, v: string) => onChange(items.map((x, j) => (j === i ? v : x)));
  const remove = (i: number) => onChange(items.filter((_, j) => j !== i));
  return (
    <div>
      <ul ref={list} className="flex flex-col">
        {items.map((line, i) => {
          const part = splitLine(line, !!named);
          const field = (
            <input
              className="input input-inline input-sm min-w-0 flex-1 px-2"
              value={part.value}
              placeholder={part.hint ?? placeholder}
              aria-label={part.label ?? itemLabel(i)}
              onChange={(e) => set(i, joinLine(part.label, e.target.value))}
              onBlur={(e) => {
                if (!e.target.value.trim() && !part.hint && !part.label) remove(i);
              }}
            />
          );
          return (
            <li key={i} className={cn('group flex min-w-0 items-center gap-1.5', named && 'border-b border-line py-0.5 last:border-b-0')}>
              {icon && <span className="flex w-4 shrink-0 justify-center text-ink-2">{icon}</span>}
              {named && part.label ? (
                <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-x-3">
                  <span className="truncate pl-2 text-small text-muted" title={part.label}>
                    {part.label}
                  </span>
                  {field}
                </div>
              ) : part.label ? (
                <span className="flex min-w-0 flex-1 items-center gap-1">
                  <span className="shrink-0 pl-2 text-small text-muted">{part.label}:</span>
                  {field}
                </span>
              ) : (
                field
              )}
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-xs invisible shrink-0 focus-visible:visible group-focus-within:visible group-hover:visible [@media(pointer:coarse)]:visible"
                onClick={() => remove(i)}
                aria-label={`Remove ${part.label ?? (line.trim() || itemLabel(i))}`}
              >
                <X />
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="btn btn-ghost btn-xs mt-1 text-muted"
        onClick={() => {
          onChange([...items, '']);
          setFocusLast(true);
        }}
      >
        <Plus /> {addLabel}
      </button>
    </div>
  );
}

// ───────────────────────── Product outline ─────────────────────────

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
  const label = project.studio.outlineLabel || fmt.outlineLabel;

  const generate = async () => {
    if (outline.length && !(await confirmAction({ title: 'Replace the current outline?', body: 'A fresh AI draft will replace your current sections and edits.', confirmLabel: 'Replace outline' }))) return;
    const r = await ai.run({});
    if (r) applyOutline(r);
  };

  const menu: MenuEntry[] = [
    { label: 'Copy as text', icon: <Copy />, onSelect: () => void copyWithToast(outlineMarkdown(getActiveProject()!), 'Outline') },
    { label: 'Export .md', icon: <Download />, onSelect: () => download(`${slugify(project.idea?.title ?? project.brand.name)}-outline.md`, outlineMarkdown(project)) },
  ];

  if (!outline.length) {
    return (
      <div>
        {ai.error && (
          <Callout tone="bad" className="mb-4">
            {ai.error}
          </Callout>
        )}
        {ai.running ? (
          <>
            <AIThinking running={ai.running} stage={ai.stage} onStop={ai.stop} />
            <div className="mt-6 flex flex-col gap-3" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} ai className="h-16 rounded-lg" />
              ))}
            </div>
          </>
        ) : (
          <Empty
            variant="ai"
            title={`Outline your ${fmt.short.toLowerCase()}`}
            body={`The path for ${project.idea?.audience || project.brand.audience || 'your buyer'}, from the first quick win to the final outcome.`}
            action={
              <GenerateButton variant="ai" running={ai.running} runningLabel="Writing…" onClick={generate}>
                Generate {fmt.outlineLabel.toLowerCase()}
              </GenerateButton>
            }
          />
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 items-start gap-10 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Section
        title={label}
        description={`Edit anything, expand items or draft whole ${fmt.unit.toLowerCase()}.`}
        actions={
          <>
            <GenerateButton size="sm" running={ai.running} runningLabel="Writing…" onClick={generate}>
              Regenerate outline
            </GenerateButton>
            <MoreMenu label="More outline actions" items={menu} />
          </>
        }
        className="min-w-0"
      >
        <AIThinking running={ai.running} stage={ai.stage} onStop={ai.stop} className="mb-4" />
        {ai.result && !ai.running && <AIResultBar className="mb-4" provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
        {ai.error && (
          <Callout tone="bad" className="mb-4">
            {ai.error}
          </Callout>
        )}
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
        <button
          type="button"
          className="btn btn-ghost btn-sm mt-3"
          onClick={() => setOutline((o) => [...o, { id: uid('sec'), title: `New ${fmt.unit.replace(/s$/, '')}`, summary: '', items: [{ id: uid('item'), title: 'First lesson', meta: '' }] }])}
        >
          <Plus /> Add section
        </button>
      </Section>

      <aside className="flex min-w-0 flex-col divide-y divide-line xl:sticky xl:top-6" aria-label="Product files and offer">
        <ProductFiles project={project} />
        <ProductOffer project={project} />
        <section className="py-6 last:pb-0" aria-label="At a glance">
          <h3 className="text-h4 text-ink">At a glance</h3>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
            <Stat label="Sections" value={outline.length} />
            <Stat label="Items" value={t.items} />
            <Stat label="Video / audio" value={t.minutes ? `${Math.round(t.minutes)} min` : '—'} />
            <Stat label="Pages" value={t.pages || '—'} />
            <Stat label="Drafted" value={`${t.drafted} of ${outline.length || 0}`} />
            <Stat label="Format" value={fmt.short} />
          </dl>
        </section>
      </aside>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-small text-muted">{label}</dt>
      <dd className="num text-h3 text-ink">{value}</dd>
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
      applySectionDraft(section.id, r.markdown);
      setOpen(true);
    }
  };
  const expand = async (item: OutlineItem) => {
    setExpanding(item.id);
    const r = await expandAI.run({ item, section: live() });
    setExpanding(null);
    if (r) applyItemDetail(section.id, item.id, r.detail);
  };

  return (
    <li className="card">
      <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
        <span className="num flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-caption font-semibold text-ink-2">{index + 1}</span>
        <input className="input input-inline h-9 min-w-0 flex-1 px-2 text-h3" value={section.title} onChange={(e) => onChange({ title: e.target.value })} aria-label={`Section ${index + 1} title`} />
        <span className="num hidden text-small text-muted sm:inline">{section.items.length} items</span>
        {section.draft && <Badge tone="good">Drafted</Badge>}
        <Tooltip content="Move up">
          <button type="button" className="btn btn-ghost btn-icon btn-xs" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move section up">
            <ArrowUp />
          </button>
        </Tooltip>
        <Tooltip content="Move down">
          <button type="button" className="btn btn-ghost btn-icon btn-xs" disabled={index === total - 1} onClick={() => onMove(1)} aria-label="Move section down">
            <ArrowDown />
          </button>
        </Tooltip>
        <button type="button" className="btn btn-ghost btn-icon btn-xs" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? 'Collapse section' : 'Expand section'}>
          <ChevronDown className={cn('transition-transform duration-180', open && 'rotate-180')} />
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line px-3 py-3 sm:px-4">
          <AutoTextarea value={section.summary ?? ''} onChange={(v) => onChange({ summary: v })} minRows={1} placeholder="One-line summary of this section" className="input-inline min-h-0 px-2 py-1 text-small text-ink-2" aria-label="Section summary" />
          <ul className="flex flex-col divide-y divide-line">
            {section.items.map((it, j) => (
              <li key={it.id} className="py-2 first:pt-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="num w-8 shrink-0 font-mono text-caption text-muted">
                    {index + 1}.{j + 1}
                  </span>
                  <input className="input input-sm min-w-[160px] flex-1" value={it.title} onChange={(e) => patchItem(it.id, { title: e.target.value })} aria-label="Item title" />
                  <input className="input input-sm w-[130px]" value={it.meta ?? ''} onChange={(e) => patchItem(it.id, { meta: e.target.value })} placeholder="Video · 8 min" aria-label="Item format or length" />
                  <GenerateButton variant="ai-ghost" size="sm" running={expanding === it.id} runningLabel="Writing…" disabled={!!expanding} onClick={() => void expand(it)}>
                    Expand
                  </GenerateButton>
                  <Tooltip content="Delete item">
                    <button type="button" className="btn btn-danger-ghost btn-icon btn-xs" onClick={() => setItems((items) => items.filter((x) => x.id !== it.id))} aria-label={`Delete ${it.title}`}>
                      <Trash2 />
                    </button>
                  </Tooltip>
                </div>
                {(it.detail || expanding === it.id) && <AutoTextarea value={it.detail ?? ''} onChange={(v) => patchItem(it.id, { detail: v })} minRows={1} className="mt-2 text-small" aria-label="Item details" />}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setItems((items) => [...items, { id: uid('item'), title: 'New item', meta: '' }])}>
              <Plus /> Add item
            </button>
            <GenerateButton running={draftAI.running} runningLabel="Writing…" onClick={draft} size="sm" icon={<FileText />}>
              {section.draft ? 'Redraft section' : 'Draft this section'}
            </GenerateButton>
            <button type="button" className="btn btn-danger-ghost btn-sm ml-auto" onClick={onRemove}>
              <Trash2 /> Delete section
            </button>
          </div>
          <AIThinking running={draftAI.running} stage={draftAI.stage} onStop={draftAI.stop} compact />
          {section.draft && !draftAI.running && (
            <div className="well">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
                <span className="text-small font-medium text-ink-2">Section draft</span>
                <div className="flex items-center gap-1.5">
                  <CopyButton text={section.draft} size="xs" />
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEditDraft((e) => !e)}>
                    {editDraft ? 'Preview' : 'Edit'}
                  </button>
                  <button type="button" className="btn btn-danger-ghost btn-xs" onClick={() => onChange({ draft: undefined })}>
                    Remove
                  </button>
                </div>
              </div>
              <div className="scroll-thin max-h-[420px] overflow-y-auto p-3">
                {editDraft ? <AutoTextarea value={section.draft} onChange={(v) => onChange({ draft: v })} minRows={10} className="font-mono text-small" aria-label="Edit draft markdown" /> : <Markdown text={section.draft} />}
              </div>
              {draftAI.result && <AIResultBar className="px-3 pb-2" provider={draftAI.result.provider} skills={draftAI.result.skills} ms={draftAI.result.ms} note={draftAI.result.note} logId={draftAI.logId} />}
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
    <section className="py-6" aria-label="Offer and pricing">
      <h3 className="text-h4 text-ink">Offer & pricing</h3>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Price" htmlFor="st-price">
          <input id="st-price" type="number" min={0} className="input num" value={s.price} onChange={(e) => updateStudio({ price: Math.max(0, Number(e.target.value) || 0) })} />
        </Field>
        <Field label="Compare at" htmlFor="st-compare" hint="Optional: shown as the old price">
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
        <div className="mt-4 flex flex-col gap-1.5 border-t border-line pt-4">
          <p className="text-ui text-ink">{idea.title}</p>
          <p className="text-small text-ink-2">{idea.hook}</p>
          <p className="text-caption text-muted">For {idea.audience}</p>
          {idea.features.length > 0 && (
            <ul className="mt-1 flex flex-col gap-1 text-small text-ink-2">
              {idea.features.slice(0, 4).map((f) => (
                <li key={f} className="flex gap-1.5">
                  <Check size={14} className="mt-[3px] shrink-0 text-muted" aria-hidden="true" /> {f}
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

const KIND_LABEL: Record<ValueStackItem['kind'], string> = { core: 'Core offer', bonus: 'Bonus', guarantee: 'Guarantee' };
const KIND_ICON: Record<ValueStackItem['kind'], ReactNode> = { core: <Layers size={14} aria-hidden="true" />, bonus: <Gift size={14} aria-hidden="true" />, guarantee: <ShieldCheck size={14} aria-hidden="true" /> };

/** A whole-field blank ("[A bonus you actually include]") shows as an empty field with that hint as its placeholder. */
const blankHint = (v: string) => BLANK.exec(v.trim())?.[1];

function BusinessModel({ project }: { project: Project }) {
  const updateStudio = useStore((s) => s.updateStudio);
  const ai = useAI(businessModelTask);
  const s = project.studio;
  const has = s.packages.length > 0;
  const setPackages = (fn: (x: ServicePackage[]) => ServicePackage[]) => updateStudio({ packages: fn(studio().packages) });
  const setOperating = (fn: (x: OperatingBlock[]) => OperatingBlock[]) => updateStudio({ operating: fn(studio().operating) });
  const setStack = (fn: (x: ValueStackItem[]) => ValueStackItem[]) => updateStudio({ valueStack: fn(studio().valueStack) });
  const patchPackage = (id: string, patch: Partial<ServicePackage>) => setPackages((x) => x.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const generate = async () => {
    if (has && !(await confirmAction({ title: 'Replace your business model?', body: 'Packages, operating model and value stack will be replaced with a fresh AI draft.', confirmLabel: 'Replace' }))) return;
    const r = await ai.run({});
    if (r) applyBusinessModel(r);
  };
  const stackValue = s.valueStack.reduce((n, v) => n + (v.value || 0), 0);
  const popular = s.packages.find((p) => p.popular) ?? s.packages[0];

  if (!has) {
    return (
      <div>
        {ai.error && (
          <Callout tone="bad" className="mb-4">
            {ai.error}
          </Callout>
        )}
        {ai.running ? (
          <>
            <AIThinking running={ai.running} stage={ai.stage} onStop={ai.stop} />
            <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} ai className="h-[260px] rounded-lg" />
              ))}
            </div>
          </>
        ) : (
          <Empty
            variant="ai"
            title="Write your packages and how you work"
            body="Prices, what’s included, hours and policies, in your voice."
            action={
              <GenerateButton variant="ai" running={ai.running} runningLabel="Writing…" onClick={generate}>
                Generate business model
              </GenerateButton>
            }
          />
        )}
      </div>
    );
  }

  const menu: MenuEntry[] = [
    { label: 'Copy as text', icon: <Copy />, onSelect: () => void copyWithToast(businessMarkdown(getActiveProject()!), 'Business model') },
    { label: 'Export .md', icon: <Download />, onSelect: () => download(`${slugify(project.brand.name)}-business-model.md`, businessMarkdown(project)) },
  ];

  return (
    <div>
      <Section
        title="Packages"
        description={<span className="max-sm:hidden">Suggested prices: set your own. They feed your listing, sales page and campaign.</span>}
        actions={
          <>
            <InfoTip label="How the AI writes this" link={{ label: 'Open Brain', onClick: () => navigate('brain') }}>
              Add a Brain skill with your real prices, service area or policies, and the AI uses them every time it rewrites your model.
            </InfoTip>
            <GenerateButton size="sm" running={ai.running} runningLabel="Writing…" onClick={generate}>
              Regenerate model
            </GenerateButton>
            <MoreMenu label="More business model actions" items={menu} />
          </>
        }
      >
        <AIThinking running={ai.running} stage={ai.stage} onStop={ai.stop} className="mb-4" />
        {ai.result && !ai.running && <AIResultBar className="mb-4" provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
        {ai.error && (
          <Callout tone="bad" className="mb-4">
            {ai.error}
          </Callout>
        )}
        <div className="grid grid-cols-1 items-start gap-4 pt-2 md:grid-cols-2 xl:grid-cols-3">
          {s.packages.map((pk) => (
            <PackageCard
              key={pk.id}
              pk={pk}
              removable={s.packages.length > 1}
              onChange={(patch) => patchPackage(pk.id, patch)}
              onPopular={() => setPackages((x) => x.map((p) => ({ ...p, popular: p.id === pk.id })))}
              onRemove={() => setPackages((x) => x.filter((p) => p.id !== pk.id))}
            />
          ))}
        </div>
        {s.packages.length < 4 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm mt-3"
            onClick={() => setPackages((x) => [...x, { id: uid('pkg'), name: 'New package', price: popular?.price ?? 99, priceModel: popular?.priceModel ?? 'per-session', description: '', includes: [] }])}
          >
            <Plus /> Add package
          </button>
        )}
      </Section>

      <Section title="How you work" description="Your hours, team, tools and what you track. Fill in the blanks." divider>
        <div className="grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-2">
          {s.operating.map((b) => (
            <div key={b.id} className="min-w-0">
              <input
                className="input input-inline -ml-2 h-8 w-full px-2 text-h4"
                value={b.title}
                onChange={(e) => setOperating((x) => x.map((o) => (o.id === b.id ? { ...o, title: e.target.value } : o)))}
                aria-label="Block title"
              />
              <div className="mt-1">
                <EditableLines items={b.items} named onChange={(items) => setOperating((x) => x.map((o) => (o.id === b.id ? { ...o, items } : o)))} itemLabel={(i) => `${b.title}: item ${i + 1}`} />
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Value stack"
        divider
        description={
          stackValue > 0 ? (
            <>
              Total value <span className="num font-medium text-ink">{fmtMoney(stackValue)}</span> · you charge <span className="num font-medium text-ink">{fmtMoney(popular?.price ?? s.price)}</span>
              {popular && stackValue > popular.price && <span className="num"> ({Math.round(stackValue / Math.max(1, popular.price))}× value)</span>}
            </>
          ) : (
            'Add what each item is worth to show a total. Leave it empty to show none.'
          )
        }
      >
        <ul className="divide-y divide-line border-y border-line">
          {s.valueStack.map((v) => (
            <li key={v.id} className="group grid grid-cols-1 items-start gap-x-4 gap-y-1.5 py-3 sm:grid-cols-[120px_minmax(0,1fr)_120px_28px]">
              <span className="flex items-center gap-1.5 pt-1.5 text-small text-muted">
                {KIND_ICON[v.kind]}
                {KIND_LABEL[v.kind]}
              </span>
              <div className="min-w-0">
                <input
                  className="input input-inline h-8 px-2 text-ui"
                  value={blankHint(v.title) ? '' : v.title}
                  placeholder={blankHint(v.title)}
                  onChange={(e) => setStack((x) => x.map((i) => (i.id === v.id ? { ...i, title: e.target.value } : i)))}
                  aria-label="Value item title"
                />
                <AutoTextarea
                  value={blankHint(v.description) ? '' : v.description}
                  onChange={(t) => setStack((x) => x.map((i) => (i.id === v.id ? { ...i, description: t } : i)))}
                  minRows={1}
                  className="input-inline px-2 py-1 text-small text-ink-2"
                  aria-label="Value item description"
                  placeholder={blankHint(v.description) ?? (v.kind === 'guarantee' ? 'Describe the promise you actually make' : 'What it is and why it helps')}
                />
              </div>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-small text-muted" aria-hidden="true">
                  $
                </span>
                <input type="number" min={0} className="input input-sm num pl-6" value={v.value || ''} placeholder={v.kind === 'guarantee' ? '' : 'Value'} onChange={(e) => setStack((x) => x.map((i) => (i.id === v.id ? { ...i, value: Math.max(0, Number(e.target.value) || 0) } : i)))} aria-label="Perceived value" />
              </div>
              <Tooltip content="Remove">
                <button type="button" className="btn btn-danger-ghost btn-icon btn-xs mt-0.5" onClick={() => setStack((x) => x.filter((i) => i.id !== v.id))} aria-label={`Remove ${v.title}`}>
                  <Trash2 />
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStack((x) => [...x.filter((i) => i.kind !== 'guarantee'), { id: uid('vs'), kind: 'bonus', title: 'New bonus', value: 0, description: '' }, ...x.filter((i) => i.kind === 'guarantee')])}>
            <Gift /> Add bonus
          </button>
          {!s.valueStack.some((i) => i.kind === 'guarantee') && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStack((x) => [...x, { id: uid('vs'), kind: 'guarantee', title: 'Our promise', value: 0, description: '' }])}>
              <ShieldCheck /> Add guarantee
            </button>
          )}
        </div>
      </Section>
    </div>
  );
}

/** One package: name, price and unit, description and what's included. */
function PackageCard({ pk, removable, onChange, onPopular, onRemove }: { pk: ServicePackage; removable: boolean; onChange: (patch: Partial<ServicePackage>) => void; onPopular: () => void; onRemove: () => void }) {
  return (
    <article className={cn('card relative flex min-w-0 flex-col gap-3 p-5', pk.popular && 'border-primary-line')} aria-label={pk.name || 'Package'}>
      {pk.popular && (
        <Badge tone="primary" className="absolute -top-2.5 left-4 border border-primary-line">
          Most popular
        </Badge>
      )}
      <div className="-ml-2 flex items-center gap-1">
        <input className="input input-inline h-9 min-w-0 flex-1 px-2 text-h3" value={pk.name} onChange={(e) => onChange({ name: e.target.value })} aria-label="Package name" placeholder="Package name" />
        <Tooltip content={pk.popular ? 'Most popular' : 'Mark as most popular'}>
          <button type="button" className={cn('btn btn-ghost btn-icon btn-sm', pk.popular && 'text-primary')} onClick={onPopular} aria-pressed={!!pk.popular} aria-label="Mark as most popular">
            <Star className={cn(pk.popular && 'fill-current')} />
          </button>
        </Tooltip>
        {removable && <MoreMenu label={`More for ${pk.name || 'this package'}`} items={[{ label: 'Remove package', icon: <Trash2 />, danger: true, onSelect: onRemove }]} />}
      </div>
      <div className="flex items-center gap-2">
        <div className="relative w-28 shrink-0">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true">
            $
          </span>
          <input type="number" min={0} className="input num pl-7" value={pk.price} onChange={(e) => onChange({ price: Math.max(0, Number(e.target.value) || 0) })} aria-label="Package price" />
        </div>
        <Select<ServicePriceModel> value={pk.priceModel} onChange={(v) => onChange({ priceModel: v })} options={PRICE_MODELS.map((m) => ({ value: m.id, label: m.label }))} aria-label="Pricing unit" className="min-w-0 flex-1" />
      </div>
      <AutoTextarea
        value={blankHint(pk.description) ? '' : pk.description}
        onChange={(v) => onChange({ description: v })}
        minRows={2}
        className="input-inline -mx-2 px-2 py-1 text-body text-ink-2"
        aria-label="Package description"
        placeholder={blankHint(pk.description) ?? 'Who it’s for and what they get'}
      />
      <div className="border-t border-line pt-3">
        <p className="mb-1 text-small font-medium text-ink">Includes</p>
        <EditableLines items={pk.includes} onChange={(includes) => onChange({ includes })} icon={<Check size={14} aria-hidden="true" />} itemLabel={(i) => `Included item ${i + 1}`} placeholder="What’s included" />
      </div>
    </article>
  );
}
