import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Check, CircleDashed, Code2, Download, Eye, EyeOff, Monitor, PenLine, RefreshCw, Search, Smartphone, X } from 'lucide-react';
import type { Project, SalesPage, SalesSection, SalesTheme, SeoMeta } from '@/lib/types';
import { cn, ensureUrl, moveItem, slugify, stripProtocol, truncate } from '@/lib/utils';
import { exportSalesHtml, placeholderTestimonials, scoreSeo, SECTION_LABEL } from '@/ai/local/seo';
import { salesPageTask, salesSectionTask, seoMetaTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { getActiveProject, useActiveProject, useStore } from '@/store/useStore';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { AutoTextarea, ChipInput, CopyButton, Empty, Field, ProgressRing, Segmented, Spinner, confirmAction } from '@/components/ui/primitives';
import { BrandBanner } from '@/components/brand/Logo';
import { download } from '@/components/ui/download';
import { MarketingHeader } from './MarketingNav';
import { SalesPreview } from './SalesPreview';

const marketing = () => getActiveProject()!.marketing;

function scoreColor(score: number) {
  return score >= 80 ? 'rgb(var(--good))' : score >= 55 ? 'rgb(var(--warn))' : 'rgb(var(--bad))';
}

export default function SeoSalesPage() {
  const project = useActiveProject()!;
  const updateMarketing = useStore((s) => s.updateMarketing);
  const meta = project.marketing.seo;
  const page = project.marketing.salesPage;
  const metaAI = useAI(seoMetaTask);
  const pageAI = useAI(salesPageTask);
  const [editing, setEditing] = useState(true);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [panel, setPanel] = useState<'meta' | 'score' | 'sections'>('meta');
  const result = useMemo(() => (meta ? scoreSeo(meta, page) : null), [meta, page]);
  const example = placeholderTestimonials(page);

  const setMeta = (patch: Partial<SeoMeta>) => updateMarketing({ seo: { ...marketing().seo!, ...patch } });
  const setPage = (fn: (p: SalesPage) => SalesPage) => {
    const cur = marketing().salesPage;
    if (cur) updateMarketing({ salesPage: { ...fn(cur), updatedAt: Date.now() } });
  };

  const generateAll = async () => {
    if (page && !(await confirmAction({ title: 'Rewrite the whole page?', body: 'Your current copy and edits will be replaced. Metadata is kept.', confirmLabel: 'Rewrite page' }))) return;
    let m = marketing().seo;
    if (!m) {
      m = await metaAI.run({});
      if (m) updateMarketing({ seo: m });
    }
    const p = await pageAI.run({ primaryKeyword: m?.primaryKeyword });
    if (p) updateMarketing({ salesPage: p });
  };

  const regenMeta = async () => {
    const m = await metaAI.run({});
    if (m) updateMarketing({ seo: m });
  };

  const html = () => {
    const p = getActiveProject()!;
    return p.marketing.salesPage && p.marketing.seo ? exportSalesHtml(p.marketing.salesPage, p.marketing.seo, p.brand, p) : '';
  };

  const running = metaAI.running || pageAI.running;
  const last = pageAI.result ?? metaAI.result;

  return (
    <div className="flex flex-col gap-5">
      <MarketingHeader
        eyebrow="Marketing Hub · SEO"
        title="SEO sales page"
        desc="Keyword-targeted metadata, a live SEO score and a one-page sales page you can edit right on the canvas. Export clean HTML with schema markup."
        actions={
          page && meta ? (
            <>
              <CopyButton text={html} label="Copy HTML" />
              <button className="btn btn-secondary btn-sm" onClick={() => download(`${meta.slug || slugify(project.brand.name)}.html`, html())}>
                <Download size={14} /> Export HTML
              </button>
              <GenerateButton running={running} onClick={generateAll} size="sm">
                Rewrite page
              </GenerateButton>
            </>
          ) : null
        }
      />
      <AIThinking running={running} stage={pageAI.stage || metaAI.stage} chars={pageAI.chars || metaAI.chars} onStop={() => (pageAI.running ? pageAI.stop() : metaAI.stop())} />
      {last && !running && <AIResultBar provider={last.provider} skills={last.skills} ms={last.ms} note={last.note} logId={pageAI.logId ?? metaAI.logId} />}

      {!page && !running ? (
        <Empty
          icon={<Search size={20} />}
          title="Build your SEO sales page"
          body={`The AI picks a buyer-intent keyword for ${project.brand.name}, writes the metadata and drafts every section: hero, problem, solution, proof, pricing, FAQ and guarantee.`}
          action={
            <GenerateButton running={running} onClick={generateAll} size="lg">
              Generate SEO sales page
            </GenerateButton>
          }
          className="min-h-[360px]"
        />
      ) : page && meta && result ? (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
          <aside className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-4 xl:max-h-[calc(100vh-120px)] xl:self-start xl:overflow-y-auto xl:pr-1 scroll-thin">
            <section className="panel flex items-center gap-4 p-4" aria-label="SEO score">
              <ProgressRing value={result.score / 100} size={64} stroke={6} color={scoreColor(result.score)} label={<span className="text-[17px]">{result.score}</span>} />
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold">SEO score {result.score >= 80 ? '· Great' : result.score >= 55 ? '· Getting there' : '· Needs work'}</p>
                <p className="num text-xs text-muted">
                  {result.words.toLocaleString()} words · keyword density {(result.density * 100).toFixed(1)}% · {result.checks.filter((c) => c.pass).length}/{result.checks.length} checks
                </p>
                <button className="link mt-1 text-xs" onClick={() => setPanel('score')}>
                  See the checklist →
                </button>
              </div>
            </section>

            <Segmented
              size="sm"
              value={panel}
              onChange={setPanel}
              options={[
                { id: 'meta', label: 'Metadata' },
                { id: 'score', label: 'Checklist' },
                { id: 'sections', label: 'Sections' },
              ]}
            />

            {panel === 'meta' && <MetaPanel project={project} meta={meta} setMeta={setMeta} onRegen={regenMeta} running={metaAI.running} />}
            {panel === 'score' && (
              <section className="panel p-4" aria-label="SEO checklist">
                <ul className="flex flex-col gap-3">
                  {result.checks.map((c) => (
                    <li key={c.id} className="flex gap-2.5 text-[13px]">
                      <span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full', c.pass ? 'bg-good-soft text-good' : c.partial ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad')}>
                        {c.pass ? <Check size={12} /> : c.partial ? <CircleDashed size={12} /> : <X size={12} />}
                      </span>
                      <span className="min-w-0">
                        <span className="font-semibold text-ink">{c.label}</span>
                        {!c.pass && <span className="block text-xs text-muted">{c.tip}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {panel === 'sections' && <SectionsPanel page={page} setPage={setPage} />}
          </aside>

          <section className="flex min-w-0 flex-col gap-3" aria-label="Visual page editor">
            <div className="panel flex flex-wrap items-center gap-2 px-3 py-2">
              <Segmented
                size="sm"
                value={editing ? 'edit' : 'view'}
                onChange={(v) => setEditing(v === 'edit')}
                options={[
                  { id: 'edit', label: 'Edit', icon: <PenLine size={13} /> },
                  { id: 'view', label: 'Preview', icon: <Eye size={13} /> },
                ]}
              />
              <Segmented
                size="sm"
                value={device}
                onChange={setDevice}
                options={[
                  { id: 'desktop', label: 'Desktop', icon: <Monitor size={13} /> },
                  { id: 'mobile', label: 'Mobile', icon: <Smartphone size={13} /> },
                ]}
              />
              <ThemeControls theme={page.theme} onChange={(theme) => setPage((p) => ({ ...p, theme }))} />
            </div>
            {example && (
              <p className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[13px] text-warn">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" /> The testimonials are examples written by AI. Replace them with real customer quotes (or hide the Social proof section) before you publish.
              </p>
            )}
            {editing && <p className="text-xs text-muted">Click any text on the page to edit it. Changes save automatically and update your SEO score.</p>}
            <div className="dotgrid flex justify-center overflow-x-auto rounded-lg bg-surface-2 p-3 sm:p-5">
              <SalesPreview page={page} brand={project.brand} editing={editing} device={device} example={example} onData={(id, data) => setPage((p) => ({ ...p, sections: p.sections.map((s) => (s.id === id ? ({ ...s, data } as SalesSection) : s)) }))} />
            </div>
            <details className="panel group">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[13px] font-semibold">
                <Code2 size={15} className="text-primary" /> HTML source
                <span className="ml-auto text-xs font-normal text-muted">Standalone page with meta tags, OpenGraph and JSON-LD schema</span>
              </summary>
              <pre className="max-h-[360px] overflow-auto border-t border-line bg-surface-2 p-3 font-mono text-[11.5px] leading-relaxed text-ink-2 scroll-thin">{html()}</pre>
            </details>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function MetaPanel({ project, meta, setMeta, onRegen, running }: { project: Project; meta: SeoMeta; setMeta: (p: Partial<SeoMeta>) => void; onRegen: () => void; running: boolean }) {
  const domain = stripProtocol(project.brand.websiteUrl || `${project.brand.slug || 'yourbrand'}.com`).replace(/\/$/, '');
  const tLen = meta.metaTitle.length;
  const dLen = meta.metaDescription.length;
  const lenHint = (n: number, lo: number, hi: number) => <span className={n >= lo && n <= hi ? 'text-good' : n > hi ? 'text-bad' : 'text-warn'}>{n}/{hi}</span>;
  return (
    <section className="panel flex flex-col gap-3.5 p-4" aria-label="SEO metadata">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold">Metadata</h2>
        <button className="btn btn-ghost btn-xs" onClick={onRegen} disabled={running}>
          {running ? <Spinner size={12} /> : <RefreshCw size={12} />} Regenerate
        </button>
      </div>
      <Field label="Primary keyword" htmlFor="seo-kw" hint="The search phrase this page should rank for.">
        <input id="seo-kw" className="input" value={meta.primaryKeyword} onChange={(e) => setMeta({ primaryKeyword: e.target.value })} />
      </Field>
      <Field label="Secondary keywords">
        <ChipInput values={meta.secondaryKeywords} onChange={(v) => setMeta({ secondaryKeywords: v })} placeholder="Add a keyword" max={10} />
      </Field>
      <Field label="Meta title" htmlFor="seo-title" right={lenHint(tLen, 45, 60)}>
        <input id="seo-title" className="input" value={meta.metaTitle} onChange={(e) => setMeta({ metaTitle: e.target.value })} />
      </Field>
      <Field label="Meta description" htmlFor="seo-desc" right={lenHint(dLen, 120, 158)}>
        <AutoTextarea id="seo-desc" value={meta.metaDescription} onChange={(v) => setMeta({ metaDescription: v })} minRows={3} className="text-[13px]" />
      </Field>
      <Field label="URL slug" htmlFor="seo-slug">
        <div className="flex items-center rounded-md border border-line-2 bg-surface focus-within:border-primary focus-within:shadow-focus">
          <span className="truncate pl-3 text-[12.5px] text-muted">{domain}/</span>
          <input
            id="seo-slug"
            className="min-w-0 flex-1 bg-transparent py-2 pr-3 text-[13px] outline-none"
            value={meta.slug}
            onChange={(e) => {
              const slug = e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
              setMeta({ slug, canonical: `${ensureUrl(domain)}/${slug}` });
            }}
          />
        </div>
      </Field>

      <div>
        <p className="label">Google preview</p>
        <div className="rounded-md border border-line bg-white p-3 text-left" style={{ fontFamily: 'Arial, sans-serif' }}>
          <p className="truncate text-[12px] text-[#202124]">
            {domain} › {meta.slug}
          </p>
          <p className="mt-0.5 text-[18px] leading-snug text-[#1a0dab]">{truncate(meta.metaTitle, 62)}</p>
          <p className="mt-0.5 text-[13px] leading-snug text-[#4d5156]">{truncate(meta.metaDescription, 160)}</p>
        </div>
      </div>

      <Field label="Social title (OpenGraph)" htmlFor="seo-ogt">
        <input id="seo-ogt" className="input" value={meta.ogTitle} onChange={(e) => setMeta({ ogTitle: e.target.value })} />
      </Field>
      <Field label="Social description" htmlFor="seo-ogd">
        <AutoTextarea id="seo-ogd" value={meta.ogDescription} onChange={(v) => setMeta({ ogDescription: v })} minRows={2} className="text-[13px]" />
      </Field>
      <Field label="Share image alt text" htmlFor="seo-alt">
        <input id="seo-alt" className="input" value={meta.ogImageAlt} onChange={(e) => setMeta({ ogImageAlt: e.target.value })} />
      </Field>
      <div>
        <p className="label">Link preview</p>
        <div className="overflow-hidden rounded-md border border-line bg-surface">
          <BrandBanner brand={project.brand} rounded={false} className="aspect-[1.91/1] w-full" />
          <div className="border-t border-line px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-muted">{domain}</p>
            <p className="truncate text-[13.5px] font-semibold">{meta.ogTitle}</p>
            <p className="clamp-2 text-xs text-muted">{meta.ogDescription}</p>
          </div>
        </div>
      </div>
      <Field label="Canonical URL" htmlFor="seo-can">
        <input id="seo-can" className="input text-[12.5px]" value={meta.canonical} onChange={(e) => setMeta({ canonical: e.target.value })} />
      </Field>
    </section>
  );
}

function SectionsPanel({ page, setPage }: { page: SalesPage; setPage: (fn: (p: SalesPage) => SalesPage) => void }) {
  const ai = useAI(salesSectionTask);
  const [busy, setBusy] = useState<string | null>(null);
  const regen = async (s: SalesSection) => {
    setBusy(s.id);
    const r = await ai.run({ type: s.type });
    setBusy(null);
    if (r) setPage((p) => ({ ...p, sections: p.sections.map((x) => (x.id === s.id ? { ...r, id: s.id, visible: s.visible } : x)) }));
  };
  return (
    <section className="panel overflow-hidden" aria-label="Page sections">
      <ul className="divide-y divide-line">
        {page.sections.map((s, i) => (
          <li key={s.id} className={cn('flex items-center gap-2 px-3 py-2.5', !s.visible && 'opacity-60')}>
            <span className="num w-5 text-xs font-semibold text-muted">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{SECTION_LABEL[s.type]}</span>
            <button className="btn btn-ghost btn-icon btn-xs" onClick={() => regen(s)} disabled={!!busy} aria-label={`Rewrite ${SECTION_LABEL[s.type]} with AI`} title="Rewrite with AI">
              {busy === s.id ? <Spinner size={13} /> : <RefreshCw size={13} className="text-primary" />}
            </button>
            <button className="btn btn-ghost btn-icon btn-xs" onClick={() => setPage((p) => ({ ...p, sections: p.sections.map((x) => (x.id === s.id ? { ...x, visible: !x.visible } : x)) }))} aria-label={s.visible ? `Hide ${SECTION_LABEL[s.type]}` : `Show ${SECTION_LABEL[s.type]}`} aria-pressed={!s.visible}>
              {s.visible ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
            <button className="btn btn-ghost btn-icon btn-xs" disabled={i === 0} onClick={() => setPage((p) => ({ ...p, sections: moveItem(p.sections, i, i - 1) }))} aria-label="Move up">
              <ArrowUp size={13} />
            </button>
            <button className="btn btn-ghost btn-icon btn-xs" disabled={i === page.sections.length - 1} onClick={() => setPage((p) => ({ ...p, sections: moveItem(p.sections, i, i + 1) }))} aria-label="Move down">
              <ArrowDown size={13} />
            </button>
          </li>
        ))}
      </ul>
      {ai.error && <p className="px-3 pb-3 text-xs text-bad">{ai.error}</p>}
      {ai.result && !ai.running && <AIResultBar className="border-t border-line px-3 py-2" provider={ai.result.provider} skills={ai.result.skills} note={ai.result.note} logId={ai.logId} />}
    </section>
  );
}

function ThemeControls({ theme, onChange }: { theme: SalesTheme; onChange: (t: SalesTheme) => void }) {
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="th-font">
        Page font
      </label>
      <select id="th-font" className="select input-sm w-auto" value={theme.font} onChange={(e) => onChange({ ...theme, font: e.target.value as SalesTheme['font'] })}>
        <option value="grotesk">Grotesk</option>
        <option value="sans">System sans</option>
        <option value="serif">Serif</option>
      </select>
      <label className="sr-only" htmlFor="th-radius">
        Corner style
      </label>
      <select id="th-radius" className="select input-sm w-auto" value={theme.radius} onChange={(e) => onChange({ ...theme, radius: e.target.value as SalesTheme['radius'] })}>
        <option value="sharp">Sharp corners</option>
        <option value="soft">Soft corners</option>
        <option value="round">Round corners</option>
      </select>
      <Segmented
        size="sm"
        value={theme.mode}
        onChange={(mode) => onChange({ ...theme, mode })}
        options={[
          { id: 'light', label: 'Light' },
          { id: 'dark', label: 'Dark' },
        ]}
      />
    </div>
  );
}
