import { useMemo, useState } from 'react';
import { Code2, CopyPlus, Download, FileCode2, Sparkles, Trash2, Undo2, Wand2, Columns2, Eye, SquareCode } from 'lucide-react';
import type { CodeAsset, CodeKind, Project } from '@/lib/types';
import { cn, fmtRelative, slugify, uid } from '@/lib/utils';
import { buildDocument, CODE_KINDS, codeKindLabel, detectKind } from '@/ai/local/code';
import { codeEditTask, codeTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { getActiveProject, useStore } from '@/store/useStore';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { CodeEditor, LivePreview, type CodeLang } from '@/components/code/CodeEditor';
import { AutoTextarea, CopyButton, Empty, Segmented, Spinner, confirmAction } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { download } from '@/components/ui/download';

type Lang = CodeLang | 'script';
type Snapshot = { html: string; css: string; js: string };

const SHORT_LABEL: Record<CodeKind, string> = {
  calculator: 'Calculator',
  leadform: 'Lead form',
  pricing: 'Pricing table',
  hero: 'Hero section',
  countdown: 'Countdown',
  quiz: 'Quiz',
  checklist: 'Checklist',
  testimonials: 'Testimonials',
  booking: 'Booking',
  spreadsheet: 'Spreadsheet',
  faq: 'FAQ',
  roi: 'ROI calculator',
};

const QUICK_EDITS = ['Switch to a dark theme', 'Make the button bigger and rounder', 'Add a phone number field', 'Use my accent color for highlights', 'Tighten the spacing', 'Add a subtle entrance animation'];

const assets = () => getActiveProject()!.studio.codeAssets;

function defaultKind(p: Project): CodeKind {
  if (p.track === 'business') return 'booking';
  if (p.format === 'spreadsheet') return 'spreadsheet';
  if (p.format === 'course' || p.format === 'membership') return 'quiz';
  return 'calculator';
}

function promptIdeas(p: Project): string[] {
  const topic = (p.category || p.niche || 'my niche').toLowerCase();
  return p.track === 'business'
    ? [`Booking widget for ${p.brand.name} with my packages`, `Instant quote calculator for ${topic}`, `FAQ that answers pricing and service-area questions`]
    : [`A calculator that shows the cost of ${topic} problems`, `A 5-question quiz that recommends ${p.idea?.title ?? 'my product'}`, `Launch countdown with an email capture`];
}

export function CodeTab({ project }: { project: Project }) {
  const updateStudio = useStore((s) => s.updateStudio);
  const list = project.studio.codeAssets;
  const [activeId, setActiveId] = useState<string | null>(list[0]?.id ?? null);
  const active = list.find((a) => a.id === activeId) ?? list[0] ?? null;
  const [kind, setKind] = useState<CodeKind>(() => defaultKind(project));
  const [prompt, setPrompt] = useState('');
  const [lang, setLang] = useState<Lang>('html');
  const [view, setView] = useState<'split' | 'code' | 'preview'>('split');
  const [instruction, setInstruction] = useState('');
  const [applied, setApplied] = useState<string[]>([]);
  const [history, setHistory] = useState<Record<string, Snapshot[]>>({});
  const gen = useAI(codeTask);
  const edit = useAI(codeEditTask);
  const kinds = CODE_KINDS.filter((k) => !k.business || project.track === 'business');
  const ideas = useMemo(() => promptIdeas(project), [project]);

  const patchAsset = (id: string, patch: Partial<CodeAsset>) => updateStudio({ codeAssets: assets().map((a) => (a.id === id ? { ...a, ...patch, updatedAt: Date.now() } : a)) });

  const generate = async () => {
    const r = await gen.run({ kind, prompt: prompt.trim() });
    if (!r) return;
    const now = Date.now();
    const asset: CodeAsset = { id: uid('code'), name: r.name, kind: r.kind, prompt: prompt.trim(), html: r.html, css: r.css, js: r.js, script: r.script, createdAt: now, updatedAt: now };
    updateStudio({ codeAssets: [asset, ...assets()] });
    setActiveId(asset.id);
    setLang('html');
    setApplied(r.note ? [r.note] : []);
  };

  const applyEdit = async (text: string) => {
    if (!active || !text.trim()) return;
    const before: Snapshot = { html: active.html, css: active.css, js: active.js };
    const r = await edit.run({ code: before, instruction: text.trim() });
    if (!r) return;
    setHistory((h) => ({ ...h, [active.id]: [...(h[active.id] ?? []), before].slice(-15) }));
    patchAsset(active.id, { html: r.html, css: r.css, js: r.js });
    setApplied(r.applied);
    setInstruction('');
  };

  const undo = () => {
    if (!active) return;
    const stack = history[active.id] ?? [];
    const prev = stack[stack.length - 1];
    if (!prev) return;
    patchAsset(active.id, prev);
    setHistory((h) => ({ ...h, [active.id]: stack.slice(0, -1) }));
    setApplied(['Reverted the last AI change']);
  };

  const remove = async (a: CodeAsset) => {
    if (!(await confirmAction({ title: `Delete “${a.name}”?`, body: 'The code will be removed from this project.', confirmLabel: 'Delete', danger: true }))) return;
    const next = assets().filter((x) => x.id !== a.id);
    updateStudio({ codeAssets: next });
    setActiveId(next[0]?.id ?? null);
  };

  const duplicate = (a: CodeAsset) => {
    const now = Date.now();
    const copy = { ...a, id: uid('code'), name: `${a.name} (copy)`, createdAt: now, updatedAt: now };
    updateStudio({ codeAssets: [copy, ...assets()] });
    setActiveId(copy.id);
  };

  const langs: { id: Lang; label: string }[] = [
    { id: 'html', label: 'HTML' },
    { id: 'css', label: 'CSS' },
    { id: 'js', label: 'JS' },
    ...(active?.script ? [{ id: 'script' as const, label: 'Apps Script' }] : []),
  ];
  const curLang: Lang = lang === 'script' && !active?.script ? 'html' : lang;
  const code = active ? { html: active.html, css: active.css, js: active.js } : null;

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="flex min-w-0 flex-col gap-4">
        <section className="panel p-4" aria-label="Generate a new asset">
          <h2 className="mb-1 flex items-center gap-2 text-[14px] font-semibold">
            <Sparkles size={15} className="text-accent" /> AI code & asset generator
          </h2>
          <p className="mb-3 text-xs text-muted">Working HTML, CSS and JavaScript in your brand colors. Edit it live, then copy or export.</p>
          <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Asset type">
            {kinds.map((k) => (
              <button
                key={k.id}
                role="radio"
                aria-checked={kind === k.id}
                className={cn('flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-[12px] font-medium transition-colors', kind === k.id ? 'border-primary bg-primary-soft text-primary' : 'border-line hover:border-line-2 hover:bg-surface-2')}
                onClick={() => setKind(k.id)}
                title={k.desc}
              >
                <Icon name={k.icon} size={13} className="shrink-0" />
                <span className="truncate">{SHORT_LABEL[k.id]}</span>
              </button>
            ))}
          </div>
          <label htmlFor="code-prompt" className="label mt-3">
            Describe it (optional)
          </label>
          <AutoTextarea id="code-prompt" value={prompt} onChange={setPrompt} minRows={2} placeholder={ideas[0]} className="text-[13px]" />
          <div className="mt-1.5 flex flex-wrap gap-1">
            {ideas.map((i) => (
              <button
                key={i}
                className="chip text-[11px]"
                onClick={() => {
                  setPrompt(i);
                  setKind(detectKind(i, project));
                }}
              >
                {i.length > 38 ? `${i.slice(0, 36)}…` : i}
              </button>
            ))}
          </div>
          <GenerateButton running={gen.running} onClick={generate} className="mt-3 w-full">
            Generate {codeKindLabel(kind).toLowerCase()}
          </GenerateButton>
          <AIThinking running={gen.running} stage={gen.stage} chars={gen.chars} onStop={gen.stop} compact className="mt-3" />
          {gen.error && <p className="mt-2 text-xs text-bad">{gen.error}</p>}
        </section>

        <section className="panel overflow-hidden" aria-label="Your assets">
          <h3 className="border-b border-line px-4 py-2.5 text-[13px] font-semibold">Your assets ({list.length})</h3>
          {list.length === 0 ? (
            <p className="px-4 py-5 text-[13px] text-muted">Generated assets are saved here automatically.</p>
          ) : (
            <ul className="max-h-[360px] divide-y divide-line overflow-y-auto scroll-thin">
              {list.map((a) => (
                <li key={a.id}>
                  <button className={cn('flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-surface-2', active?.id === a.id && 'bg-primary-soft')} onClick={() => setActiveId(a.id)} aria-current={active?.id === a.id}>
                    <Icon name={CODE_KINDS.find((k) => k.id === a.kind)?.icon ?? 'code-xml'} size={15} className={active?.id === a.id ? 'text-primary' : 'text-muted'} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold">{a.name}</span>
                      <span className="block text-[11px] text-muted">
                        {codeKindLabel(a.kind)} · {fmtRelative(a.updatedAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>

      <section className="flex min-w-0 flex-col gap-3" aria-label="Code editor and live preview">
        {!active || !code ? (
          <Empty
            icon={<Code2 size={20} />}
            title="Generate your first interactive asset"
            body="Calculators, quizzes, booking widgets, pricing tables and more, written for your niche in your brand colors."
            action={
              <GenerateButton running={gen.running} onClick={generate}>
                Generate {codeKindLabel(kind).toLowerCase()}
              </GenerateButton>
            }
            className="min-h-[420px]"
          />
        ) : (
          <>
            <div className="panel flex flex-wrap items-center gap-2 px-3 py-2.5">
              <FileCode2 size={16} className="shrink-0 text-primary" />
              <input className="min-w-[220px] flex-1 rounded bg-transparent px-1 py-1 text-[14px] font-semibold outline-none hover:bg-surface-2 focus:bg-surface-2" value={active.name} onChange={(e) => patchAsset(active.id, { name: e.target.value })} aria-label="Asset name" />
              <span className="badge bg-surface-2 text-ink-2">{codeKindLabel(active.kind)}</span>
              <div className="flex flex-wrap items-center gap-1.5">
                <CopyButton text={() => buildDocument(code, active.name)} label="Copy HTML" />
                <button className="btn btn-secondary btn-sm" onClick={() => download(`${slugify(active.name) || 'widget'}.html`, buildDocument(code, active.name))}>
                  <Download size={14} /> Export .html
                </button>
                {active.script && (
                  <button className="btn btn-secondary btn-sm" onClick={() => download(`${slugify(active.name) || 'sheet'}-apps-script.txt`, active.script ?? '')}>
                    <Download size={14} /> Apps Script
                  </button>
                )}
                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => duplicate(active)} aria-label="Duplicate asset" title="Duplicate">
                  <CopyPlus size={15} />
                </button>
                <button className="btn btn-ghost btn-icon btn-sm text-muted hover:text-bad" onClick={() => remove(active)} aria-label="Delete asset" title="Delete">
                  <Trash2 size={15} />
                </button>
              </div>
            </div>

            <div className="panel p-3">
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  applyEdit(instruction);
                }}
              >
                <label htmlFor="code-edit" className="sr-only">
                  Ask AI to change this asset
                </label>
                <div className="relative min-w-[200px] flex-1">
                  <Wand2 size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-primary" />
                  <input id="code-edit" className="input pl-9" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Ask AI to change it, e.g. “add an email field and make it dark”" />
                </div>
                <button type="submit" className="btn btn-ai" disabled={edit.running || !instruction.trim()}>
                  {edit.running ? <Spinner size={15} /> : <Sparkles size={15} className="text-accent" />} Apply
                </button>
                {(history[active.id]?.length ?? 0) > 0 && (
                  <button type="button" className="btn btn-secondary" onClick={undo} disabled={edit.running}>
                    <Undo2 size={15} /> Undo
                  </button>
                )}
              </form>
              <div className="mt-2 flex flex-wrap gap-1">
                {QUICK_EDITS.map((q) => (
                  <button key={q} className="chip text-[11.5px]" disabled={edit.running} onClick={() => applyEdit(q)}>
                    {q}
                  </button>
                ))}
              </div>
              <AIThinking running={edit.running} stage={edit.stage} chars={edit.chars} onStop={edit.stop} compact className="mt-2" />
              {applied.length > 0 && !edit.running && (
                <ul className="mt-2 flex flex-col gap-0.5 text-xs text-good">
                  {applied.map((a) => (
                    <li key={a}>✓ {a}</li>
                  ))}
                </ul>
              )}
              {(edit.result ?? gen.result) && !edit.running && !gen.running && (
                <AIResultBar className="mt-2" provider={(edit.result ?? gen.result)!.provider} skills={(edit.result ?? gen.result)!.skills} ms={(edit.result ?? gen.result)!.ms} note={(edit.result ?? gen.result)!.note} logId={edit.logId ?? gen.logId} />
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented
                size="sm"
                value={view}
                onChange={setView}
                options={[
                  { id: 'split', label: 'Split', icon: <Columns2 size={13} /> },
                  { id: 'code', label: 'Code', icon: <SquareCode size={13} /> },
                  { id: 'preview', label: 'Preview', icon: <Eye size={13} /> },
                ]}
              />
              <p className="text-xs text-muted">Edits update the preview instantly. Everything saves automatically.</p>
            </div>

            <div className={cn('grid gap-3', view === 'split' && '2xl:grid-cols-2')}>
              {view !== 'preview' && (
                <div className="panel flex h-[540px] min-w-0 flex-col overflow-hidden">
                  <div className="flex items-center gap-1 border-b border-line bg-surface px-2 py-1.5" role="tablist" aria-label="Code language">
                    {langs.map((l) => (
                      <button key={l.id} role="tab" aria-selected={curLang === l.id} className={cn('rounded px-2.5 py-1 text-[12px] font-semibold', curLang === l.id ? 'bg-ink text-surface' : 'text-muted hover:bg-surface-2 hover:text-ink')} onClick={() => setLang(l.id)}>
                        {l.label}
                      </button>
                    ))}
                    <span className="num ml-auto pr-1 text-[11px] text-faint">{(curLang === 'script' ? active.script ?? '' : active[curLang]).split('\n').length} lines</span>
                  </div>
                  <div className="min-h-0 flex-1">
                    {curLang === 'script' ? (
                      <CodeEditor key={`${active.id}-script`} lang="js" value={active.script ?? ''} onChange={(v) => patchAsset(active.id, { script: v })} ariaLabel="Google Apps Script editor" />
                    ) : (
                      <CodeEditor key={`${active.id}-${curLang}`} lang={curLang} value={active[curLang]} onChange={(v) => patchAsset(active.id, { [curLang]: v })} />
                    )}
                  </div>
                </div>
              )}
              {view !== 'code' && (
                <div className="panel h-[540px] min-w-0 overflow-hidden">
                  <LivePreview code={code} title={active.name} />
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
