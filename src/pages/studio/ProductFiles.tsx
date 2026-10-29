import { useEffect, useRef, useState } from 'react';
import { BookOpenText, Download, FileSpreadsheet, FileText, PackageCheck, RefreshCw, Trash2, Wand2 } from 'lucide-react';
import type { ProductFile, Project } from '@/lib/types';
import { cn, fmtBytes, fmtRelative } from '@/lib/utils';
import { coverMedia, createEbookFile, createWorkbookFile, deleteProductFile, productFileBlob } from '@/ai/productFiles';
import type { EbookPageSize, EbookTheme } from '@/lib/ebook';
import { AIThinking } from '@/components/ai/AI';
import { download } from '@/components/ui/download';
import { Segmented, Spinner, Toggle, confirmAction } from '@/components/ui/primitives';
import { toast } from '@/store/ui';

/** One build at a time, with progress, stop and the outcome. */
function useBuild() {
  const [state, setState] = useState<{ running: '' | 'pdf' | 'xlsx'; stage: string; error: string; done: string; notes: string[] }>({ running: '', stage: '', error: '', done: '', notes: [] });
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);
  const run = async (kind: 'pdf' | 'xlsx', job: (signal: AbortSignal, onStage: (s: string) => void) => Promise<{ done: string; notes: string[]; file: ProductFile }>) => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setState({ running: kind, stage: 'Starting…', error: '', done: '', notes: [] });
    try {
      const r = await job(c.signal, (stage) => setState((s) => ({ ...s, stage })));
      setState({ running: '', stage: '', error: '', done: r.done, notes: r.notes });
      toast({ kind: 'success', title: `${r.file.name} is ready`, body: 'Download it below.' });
    } catch (e) {
      const code = (e as { code?: string }).code;
      setState({ running: '', stage: '', error: code === 'cancelled' || c.signal.aborted ? '' : (e as Error).message || 'Something went wrong.', done: code === 'cancelled' ? 'Stopped. Chapters written so far are saved.' : '', notes: [] });
    } finally {
      if (ctl.current === c) ctl.current = null;
    }
  };
  return { ...state, run, stop: () => ctl.current?.abort() };
}

export function ProductFiles({ project }: { project: Project }) {
  const s = project.studio;
  const fmt = project.format ?? 'pdf';
  const sheetFirst = fmt === 'spreadsheet' || fmt === 'template';
  const [theme, setTheme] = useState<EbookTheme>('modern');
  const [pageSize, setPageSize] = useState<EbookPageSize>('letter');
  const [workbookPages, setWorkbookPages] = useState(true);
  const [useCover, setUseCover] = useState(true);
  const [draftMissing, setDraftMissing] = useState(true);
  const build = useBuild();
  const missing = s.outline.filter((x) => !x.draft?.trim()).length;
  const cover = coverMedia(project);
  const files = s.productFiles ?? [];
  const hasOutline = s.outline.length > 0;
  const busy = !!build.running;

  const makePdf = (reuseCopy: boolean) =>
    build.run('pdf', async (signal, onStage) => {
      const r = await createEbookFile({ theme, pageSize, workbookPages, useCover: useCover && !!cover, draftMissing, reuseCopy, fillable: workbookPages }, { signal, onStage });
      return { file: r.file, notes: r.notes, done: `${r.file.name} · ${r.file.pages} pages · ${fmtBytes(r.file.size)}${r.drafted ? ` · ${r.drafted} chapter${r.drafted > 1 ? 's' : ''} written` : ''}` };
    });

  const makeSheet = (redesign: boolean) =>
    build.run('xlsx', async (signal, onStage) => {
      const r = await createWorkbookFile({ redesign }, { signal, onStage });
      return { file: r.file, notes: r.notes, done: `${r.file.name} · ${r.summary.sheets.length} tab${r.summary.sheets.length > 1 ? 's' : ''} + dashboard · ${r.summary.formulas} formulas` };
    });

  const save = async (f: ProductFile) => {
    const blob = await productFileBlob(f);
    if (blob) await download(f.name, blob);
    else toast({ kind: 'error', title: 'That file isn’t stored on this device any more', body: 'Create it again.' });
  };

  const remove = async (f: ProductFile) => {
    if (await confirmAction({ title: `Delete ${f.name}?`, body: 'The file is removed from this workspace. Copies you downloaded stay where you saved them.', confirmLabel: 'Delete', danger: true })) await deleteProductFile(f.id);
  };

  const pdfCard = (
    <div key="pdf" className={cn('flex flex-col gap-2.5 rounded-md border border-line p-3', !sheetFirst && 'border-primary/40 bg-primary-soft/30')}>
      <h4 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
        <BookOpenText size={15} className="text-primary" /> Designed {fmt === 'ebook' ? 'ebook' : fmt === 'course' ? 'workbook' : 'guide'} (PDF)
      </h4>
      <p className="text-[12px] leading-snug text-muted">Cover, clickable contents, branded chapters and fillable workbook pages, ready to sell.</p>
      <div className="flex flex-wrap gap-2">
        <Segmented<EbookTheme> size="sm" value={theme} onChange={setTheme} options={[{ id: 'modern', label: 'Modern' }, { id: 'classic', label: 'Classic' }]} />
        <Segmented<EbookPageSize> size="sm" value={pageSize} onChange={setPageSize} options={[{ id: 'letter', label: 'US Letter' }, { id: 'a4', label: 'A4' }]} />
      </div>
      {missing > 0 && <Toggle checked={draftMissing} onChange={setDraftMissing} label={`AI writes the ${missing} chapter${missing > 1 ? 's' : ''} without a draft`} description={draftMissing ? undefined : 'Those chapters show their outline points instead.'} />}
      <Toggle checked={workbookPages} onChange={setWorkbookPages} label="Fillable workbook page after each chapter" />
      {cover && <Toggle checked={useCover} onChange={setUseCover} label="Listing cover photo on the cover" />}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-ai btn-sm" disabled={busy || !hasOutline} onClick={() => makePdf(false)}>
          {build.running === 'pdf' ? <Spinner size={14} /> : <Wand2 size={14} className="text-accent" />} Create PDF
        </button>
        {s.ebookExtras && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !hasOutline} onClick={() => makePdf(true)} title="New design or page size, same words: no AI">
            <RefreshCw size={13} /> Re-layout only
          </button>
        )}
      </div>
    </div>
  );

  const sheetCard = (
    <div key="xlsx" className={cn('flex flex-col gap-2.5 rounded-md border border-line p-3', sheetFirst && 'border-primary/40 bg-primary-soft/30')}>
      <h4 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
        <FileSpreadsheet size={15} className="text-primary" /> Excel workbook (.xlsx)
      </h4>
      <p className="text-[12px] leading-snug text-muted">AI designs the tabs, dropdowns, formulas and a live dashboard from your outline. Opens in Excel, Google Sheets and Numbers.</p>
      {s.workbook && (
        <ul className="flex flex-col gap-1 text-[12px]" aria-label="Current workbook design">
          {s.workbook.spec.sheets.map((sh) => (
            <li key={sh.name} className="flex min-w-0 items-baseline gap-1.5">
              <span className="font-semibold text-ink">{sh.name}</span>
              <span className="truncate text-muted">{sh.columns.map((c) => c.name).join(' · ')}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-ai btn-sm" disabled={busy || !hasOutline} onClick={() => makeSheet(!!s.workbook)}>
          {build.running === 'xlsx' ? <Spinner size={14} /> : <Wand2 size={14} className="text-accent" />} {s.workbook ? 'Redesign with AI' : 'Design workbook'}
        </button>
        {s.workbook && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => makeSheet(false)} title="Same design with your current brand colors: no AI">
            <RefreshCw size={13} /> Rebuild file
          </button>
        )}
      </div>
    </div>
  );

  return (
    <section className="panel flex flex-col gap-3 p-4" aria-label="Product files">
      <div>
        <h3 className="flex items-center gap-2 text-[13px] font-semibold">
          <PackageCheck size={15} className="text-primary" /> Product files
        </h3>
        <p className="mt-0.5 text-[12px] leading-snug text-muted">Turn your outline into the finished file you sell.</p>
      </div>
      {!hasOutline && <p className="rounded-md bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2">Generate your outline first: the files are built from it.</p>}
      {sheetFirst ? [sheetCard, pdfCard] : [pdfCard, sheetCard]}
      <AIThinking running={busy} stage={build.stage} onStop={build.stop} compact />
      {build.error && (
        <p className="rounded-md bg-bad-soft px-3 py-2 text-[12.5px] text-bad" role="alert">
          {build.error}
        </p>
      )}
      {!busy && build.done && (
        <div className="text-[11.5px] text-muted">
          <p>{build.done}</p>
          {build.notes.slice(0, 4).map((n) => (
            <p key={n} className="text-warn">
              {n}
            </p>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line" aria-label="Your product files">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 px-2.5 py-2">
              {f.kind === 'pdf' ? <FileText size={16} className="shrink-0 text-bad" /> : <FileSpreadsheet size={16} className="shrink-0 text-good" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] font-semibold text-ink" title={f.name}>
                  {f.name}
                </p>
                <p className="text-[11px] text-muted">
                  {f.kind === 'pdf' ? `${f.pages} pages` : `${f.sheets?.length ?? 0} tabs`} · {fmtBytes(f.size)} · {fmtRelative(f.createdAt)}
                  {f.engine === 'local' ? ' · built-in writer' : ''}
                </p>
              </div>
              <button type="button" className="btn btn-ghost btn-icon btn-xs" onClick={() => save(f)} aria-label={`Download ${f.name}`} title="Download">
                <Download size={14} />
              </button>
              <button type="button" className="btn btn-ghost btn-icon btn-xs text-muted hover:text-bad" onClick={() => remove(f)} aria-label={`Delete ${f.name}`} title="Delete">
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
