import { useEffect, useRef, useState } from 'react';
import { BookOpenText, Download, FileSpreadsheet, FileText, RefreshCw, Trash2 } from 'lucide-react';
import type { ProductFile, Project } from '@/lib/types';
import { fmtBytes, fmtRelative } from '@/lib/utils';
import { coverMedia, createEbookFile, createWorkbookFile, deleteProductFile, downloadProductFile } from '@/ai/productFiles';
import type { EbookPageSize, EbookTheme } from '@/lib/ebook';
import { AIThinking, GenerateButton } from '@/components/ai/AI';
import { Callout, Segmented, Toggle, Tooltip, confirmAction } from '@/components/ui/primitives';
import { toast } from '@/store/ui';
import { beginBusy, busyId, endBusy } from '@/lib/busy';

/** One build at a time, with progress, stop and the outcome. */
function useBuild() {
  const [state, setState] = useState<{ running: '' | 'pdf' | 'xlsx'; stage: string; error: string; done: string; notes: string[] }>({ running: '', stage: '', error: '', done: '', notes: [] });
  const ctl = useRef<AbortController | null>(null);
  const jobId = useRef(busyId('file'));
  useEffect(() => {
    const id = jobId.current;
    return () => {
      ctl.current?.abort();
      endBusy(id);
    };
  }, []);
  const run = async (kind: 'pdf' | 'xlsx', job: (signal: AbortSignal, onStage: (s: string) => void) => Promise<{ done: string; notes: string[]; file: ProductFile }>) => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setState({ running: kind, stage: 'Starting…', error: '', done: '', notes: [] });
    beginBusy(jobId.current, kind === 'pdf' ? 'PDF' : 'Spreadsheet');
    try {
      const r = await job(c.signal, (stage) => setState((s) => ({ ...s, stage })));
      setState({ running: '', stage: '', error: '', done: r.done, notes: r.notes });
      toast({ kind: 'success', title: `${r.file.name} is ready`, body: 'Download it below.' });
    } catch (e) {
      const code = (e as { code?: string }).code;
      setState({ running: '', stage: '', error: code === 'cancelled' || c.signal.aborted ? '' : (e as Error).message || 'Something went wrong.', done: code === 'cancelled' ? 'Stopped. Chapters written so far are saved.' : '', notes: [] });
    } finally {
      if (ctl.current === c) {
        ctl.current = null;
        endBusy(jobId.current);
      }
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

  const save = (f: ProductFile) => downloadProductFile(f);

  const remove = async (f: ProductFile) => {
    if (await confirmAction({ title: `Delete ${f.name}?`, body: 'The file is removed from this workspace. Copies you downloaded stay where you saved them.', confirmLabel: 'Delete', danger: true })) await deleteProductFile(f.id);
  };

  const pdfBlock = (
    <div key="pdf" className="flex flex-col gap-3">
      <div>
        <h4 className="flex items-center gap-2 text-ui text-ink">
          <BookOpenText size={16} className="shrink-0 text-ink-2" aria-hidden="true" /> Designed {fmt === 'ebook' ? 'ebook' : fmt === 'course' ? 'workbook' : 'guide'} (PDF)
        </h4>
        <p className="mt-0.5 text-small text-muted">Cover, clickable contents, branded chapters and fillable workbook pages.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Segmented<EbookTheme> size="sm" value={theme} onChange={setTheme} options={[{ id: 'modern', label: 'Modern' }, { id: 'classic', label: 'Classic' }]} />
        <Segmented<EbookPageSize> size="sm" value={pageSize} onChange={setPageSize} options={[{ id: 'letter', label: 'US Letter' }, { id: 'a4', label: 'A4' }]} />
      </div>
      {missing > 0 && <Toggle checked={draftMissing} onChange={setDraftMissing} label={`AI writes the ${missing} chapter${missing > 1 ? 's' : ''} without a draft`} description={draftMissing ? undefined : 'Those chapters show their outline points instead.'} />}
      <Toggle checked={workbookPages} onChange={setWorkbookPages} label="Fillable workbook page after each chapter" />
      {cover && <Toggle checked={useCover} onChange={setUseCover} label="Listing cover photo on the cover" />}
      <div className="flex flex-wrap gap-2">
        <GenerateButton size="sm" running={build.running === 'pdf'} runningLabel="Building…" disabled={busy || !hasOutline} onClick={() => makePdf(false)}>
          Create PDF
        </GenerateButton>
        {s.ebookExtras && (
          <Tooltip content="New design or page size, same words: no AI">
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !hasOutline} onClick={() => makePdf(true)}>
              <RefreshCw /> Re-layout only
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );

  const sheetBlock = (
    <div key="xlsx" className="flex flex-col gap-3">
      <div>
        <h4 className="flex items-center gap-2 text-ui text-ink">
          <FileSpreadsheet size={16} className="shrink-0 text-ink-2" aria-hidden="true" /> Excel workbook (.xlsx)
        </h4>
        <p className="mt-0.5 text-small text-muted">Tabs, dropdowns, formulas and a live dashboard from your outline. Opens in Excel, Google Sheets and Numbers.</p>
      </div>
      {s.workbook && (
        <ul className="flex flex-col gap-1 text-small" aria-label="Current workbook design">
          {s.workbook.spec.sheets.map((sh) => (
            <li key={sh.name} className="flex min-w-0 items-baseline gap-1.5">
              <span className="font-medium text-ink">{sh.name}</span>
              <span className="truncate text-muted">{sh.columns.map((c) => c.name).join(' · ')}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <GenerateButton size="sm" running={build.running === 'xlsx'} runningLabel="Building…" disabled={busy || !hasOutline} onClick={() => makeSheet(!!s.workbook)}>
          {s.workbook ? 'Redesign with AI' : 'Design workbook'}
        </GenerateButton>
        {s.workbook && (
          <Tooltip content="Same design with your current brand colors: no AI">
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => makeSheet(false)}>
              <RefreshCw /> Rebuild file
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );

  return (
    <section className="flex flex-col gap-5 pb-6" aria-label="Product files">
      <div>
        <h3 className="text-h4 text-ink">Product files</h3>
        <p className="mt-0.5 text-small text-muted">Turn your outline into the finished file you sell.</p>
      </div>
      {!hasOutline && <p className="well px-3 py-2 text-small text-ink-2">Generate your outline first: the files are built from it.</p>}
      {sheetFirst ? [sheetBlock, pdfBlock] : [pdfBlock, sheetBlock]}
      <AIThinking running={busy} stage={build.stage} onStop={build.stop} compact />
      {build.error && <Callout tone="bad">{build.error}</Callout>}
      {!busy && build.done && (
        <div className="text-caption text-muted" role="status">
          <p>{build.done}</p>
          {build.notes.slice(0, 4).map((n) => (
            <p key={n} className="text-warn">
              {n}
            </p>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <ul className="flex flex-col divide-y divide-line border-y border-line" aria-label="Your product files">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 py-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-surface-3 text-ink-2">{f.kind === 'pdf' ? <FileText size={14} aria-hidden="true" /> : <FileSpreadsheet size={14} aria-hidden="true" />}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-small font-medium text-ink" title={f.name}>
                  {f.name}
                </p>
                <p className="num truncate text-caption text-muted">
                  {f.kind === 'pdf' ? `${f.pages} pages` : `${f.sheets?.length ?? 0} tabs`} · {fmtBytes(f.size)} · {fmtRelative(f.createdAt)}
                  {f.engine === 'local' ? ' · built-in writer' : ''}
                </p>
              </div>
              <Tooltip content="Download">
                <button type="button" className="btn btn-ghost btn-icon btn-xs" onClick={() => save(f)} aria-label={`Download ${f.name}`}>
                  <Download />
                </button>
              </Tooltip>
              <Tooltip content="Delete">
                <button type="button" className="btn btn-danger-ghost btn-icon btn-xs" onClick={() => remove(f)} aria-label={`Delete ${f.name}`}>
                  <Trash2 />
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
