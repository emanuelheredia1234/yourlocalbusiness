// Turning the outline into the files you sell: a designed PDF (guide, ebook, workbook) and an
// .xlsx workbook. The AI writes what's missing (chapter drafts, welcome, workbook pages, the
// workbook design); the layout is done here, in the browser. Files are kept in IndexedDB.

import type { Project, ProductFile, ProviderId } from '@/lib/types';
import { deleteBlob, getBlob, putBlob } from '@/lib/storage';
import { readFileAsDataURL, slugify, uid } from '@/lib/utils';
import { canvasBlob, loadImage } from '@/lib/imageCanvas';
import { buildEbookPdf, type EbookDoc, type EbookOptions } from '@/lib/ebook';
import { getActiveProject, useStore } from '@/store/useStore';
import { runTask, type RunResult } from './engine';
import { ebookExtrasTask, sectionDraftTask, workbookTask, type TaskDef } from './tasks';
import type { EbookExtras } from './local/ebook';
import { workbookFile, type WorkbookSummary } from './workbook';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const KEEP_PER_KIND = 6;

export interface BuildHooks {
  signal: AbortSignal;
  onStage: (stage: string) => void;
}

const stopped = () => Object.assign(new Error('Stopped.'), { code: 'cancelled' });

function project(): Project {
  const p = getActiveProject();
  if (!p) throw Object.assign(new Error('Open a project first.'), { code: 'NO_PROJECT' });
  return p;
}

/** Run an AI task for the open project and log it like any other generation. */
async function runLogged<I, O>(task: TaskDef<I, O>, input: I, h: BuildHooks, stage?: (s: string) => void): Promise<RunResult<O>> {
  const s = useStore.getState();
  const p = project();
  const res = await runTask(task, input, { project: p, skills: s.skills, settings: s.settings, signal: h.signal, onStage: stage });
  s.recordGeneration({ id: res.id, task: task.id, label: task.label, module: task.module, provider: res.provider, skillIds: res.skills.map((k) => k.id), createdAt: Date.now(), ms: res.ms, projectId: p.id });
  return res;
}

const website = (p: Project) => p.brand.websiteUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '') || undefined;

async function saveProductFile(f: { kind: ProductFile['kind']; name: string; bytes: Uint8Array; mime: string; pages?: number; sheets?: string[]; engine: ProviderId }): Promise<ProductFile> {
  const id = uid('file');
  await putBlob(id, new Blob([f.bytes as BlobPart], { type: f.mime }));
  const file: ProductFile = { id, kind: f.kind, name: f.name, size: f.bytes.length, createdAt: Date.now(), pages: f.pages, sheets: f.sheets, engine: f.engine };
  const all = [file, ...(project().studio.productFiles ?? [])];
  // keep the newest few of each kind
  const drop = all.filter((x) => x.kind === f.kind).slice(KEEP_PER_KIND);
  await Promise.all(drop.map((d) => deleteBlob(d.id)));
  useStore.getState().updateStudio({ productFiles: all.filter((x) => !drop.includes(x)) });
  return file;
}

export async function deleteProductFile(id: string): Promise<void> {
  await deleteBlob(id);
  useStore.getState().updateStudio({ productFiles: (project().studio.productFiles ?? []).filter((x) => x.id !== id) });
}

export async function productFileBlob(f: ProductFile): Promise<Blob | null> {
  return getBlob(f.id);
}

// ───────────── PDF ─────────────

const FORMAT_LABEL: Record<string, string> = { pdf: 'Guide', ebook: 'Ebook', course: 'Course workbook', template: 'Template guide', spreadsheet: 'Guide', software: 'User guide', design: 'Guide', audio: 'Companion guide', membership: 'Member guide' };

export interface EbookBuild extends EbookOptions {
  /** AI writes the chapters that have no draft yet */
  draftMissing: boolean;
  /** put the listing cover photo on the cover */
  useCover: boolean;
  /** a workbook page after each chapter */
  workbookPages: boolean;
  /** layout only: reuse the last welcome / workbook copy instead of asking the AI again */
  reuseCopy: boolean;
}

/** The listing cover (or the latest listing hero image), cropped for the top of the cover. */
export function coverMedia(p: Project) {
  const byId = p.studio.listing.coverImageId ? p.brand.images.find((m) => m.id === p.studio.listing.coverImageId && m.kind === 'image') : undefined;
  return byId ?? p.brand.images.filter((m) => m.kind === 'image' && m.generated?.purpose === 'listing' && m.generated.shot === 'hero').sort((a, b) => b.createdAt - a.createdAt)[0];
}

async function coverBytes(p: Project, aspect: number): Promise<EbookDoc['cover']> {
  const m = coverMedia(p);
  if (!m || typeof document === 'undefined') return null;
  const blob = await getBlob(m.id);
  if (!blob) return null;
  const img = await loadImage(await readFileAsDataURL(blob));
  const w = Math.min(1600, img.naturalWidth || img.width);
  const h = Math.round(w / aspect);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const scale = Math.max(w / img.width, h / img.height);
  ctx.drawImage(img, (w - img.width * scale) / 2, (h - img.height * scale) / 2, img.width * scale, img.height * scale);
  const jpeg = await canvasBlob(c, 'image/jpeg', 0.86);
  return { bytes: new Uint8Array(await jpeg.arrayBuffer()), type: 'jpg' };
}

export function ebookDoc(p: Project, extras: EbookExtras, o: { workbookPages: boolean; cover?: EbookDoc['cover'] }, now = new Date()): EbookDoc {
  return {
    title: extras.title || p.idea?.title || p.brand.name || 'Your guide',
    subtitle: extras.subtitle,
    author: p.brand.name || 'Your brand',
    website: website(p),
    tagline: p.brand.tagline,
    formatLabel: FORMAT_LABEL[p.format ?? 'pdf'] ?? 'Guide',
    colors: p.brand.colors,
    welcome: extras.welcome,
    howToUse: extras.howToUse,
    disclaimer: extras.disclaimer,
    chapters: p.studio.outline.map((s, i) => ({ title: s.title, summary: s.summary, items: s.items, markdown: s.draft, worksheet: o.workbookPages ? extras.worksheets[i] ?? null : null })),
    conclusion: extras.conclusion,
    nextSteps: extras.nextSteps,
    cover: o.cover ?? null,
    edition: now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    year: now.getFullYear(),
  };
}

export async function createEbookFile(o: EbookBuild, h: BuildHooks): Promise<{ file: ProductFile; notes: string[]; drafted: number }> {
  let p = project();
  if (!p.studio.outline.length) throw Object.assign(new Error('Generate your outline first: the file is built from it.'), { code: 'NO_OUTLINE' });
  const notes: string[] = [];
  let drafted = 0;
  let engine: ProviderId = 'local';
  if (o.draftMissing && !o.reuseCopy) {
    const missing = p.studio.outline.filter((s) => !s.draft?.trim());
    for (const [k, sec] of missing.entries()) {
      if (h.signal.aborted) throw stopped();
      const label = `Writing chapter ${k + 1} of ${missing.length}: ${sec.title}`;
      h.onStage(`${label}…`);
      const res = await runLogged(sectionDraftTask, { section: sec }, h, (s) => h.onStage(/thinking|writing/i.test(s) ? `${label} · ${s}` : `${label}…`));
      if (res.provider !== 'local') engine = res.provider;
      if (res.note) notes.push(res.note);
      // saved as it goes, so stopping keeps what's written
      useStore.getState().updateStudio({ outline: project().studio.outline.map((x) => (x.id === sec.id ? { ...x, draft: res.data.markdown } : x)) });
      drafted++;
    }
    p = project();
  }
  let extras = p.studio.ebookExtras;
  if (!o.reuseCopy || !extras || extras.data.worksheets.length !== p.studio.outline.length) {
    if (h.signal.aborted) throw stopped();
    h.onStage('Writing the welcome page, workbook pages and next steps…');
    const res = await runLogged(ebookExtrasTask, {}, h, () => h.onStage('Writing the welcome page, workbook pages and next steps…'));
    if (res.note) notes.push(res.note);
    extras = { data: res.data, at: Date.now(), engine: res.provider };
    useStore.getState().updateStudio({ ebookExtras: extras });
    p = project();
  }
  if (engine === 'local') engine = extras.engine;
  if (h.signal.aborted) throw stopped();
  h.onStage('Designing the pages…');
  const [W, H] = o.pageSize === 'a4' ? [595.28, 841.89] : [612, 792];
  const cover = o.useCover ? await coverBytes(p, W / (H * 0.56)).catch(() => null) : null;
  const doc = ebookDoc(p, extras.data, { workbookPages: o.workbookPages, cover });
  const { bytes, pages } = await buildEbookPdf(doc, { ...o, fillable: o.workbookPages });
  if (h.signal.aborted) throw stopped();
  const file = await saveProductFile({ kind: 'pdf', name: `${slugify(doc.title, 60) || 'guide'}.pdf`, bytes, mime: 'application/pdf', pages, engine });
  return { file, notes: [...new Set(notes)], drafted };
}

// ───────────── XLSX ─────────────

export async function createWorkbookFile(o: { redesign: boolean }, h: BuildHooks): Promise<{ file: ProductFile; summary: WorkbookSummary; notes: string[] }> {
  let p = project();
  let wb = p.studio.workbook;
  const notes: string[] = [];
  if (!wb || o.redesign) {
    h.onStage('Designing your workbook from the outline…');
    const res = await runLogged(workbookTask, {}, h, (s) => h.onStage(/thinking|writing/i.test(s) ? `Designing your workbook · ${s}` : s));
    if (res.note) notes.push(res.note);
    wb = { spec: res.data, at: Date.now(), engine: res.provider };
    useStore.getState().updateStudio({ workbook: wb });
    p = project();
  }
  if (h.signal.aborted) throw stopped();
  h.onStage('Building the spreadsheet…');
  const { bytes, summary } = workbookFile(wb.spec, { name: p.brand.name || 'Your brand', website: website(p), colors: p.brand.colors });
  const file = await saveProductFile({ kind: 'xlsx', name: `${slugify(wb.spec.title, 60) || 'workbook'}.xlsx`, bytes, mime: XLSX_MIME, sheets: summary.sheets.map((s) => s.name), engine: wb.engine });
  return { file, summary, notes: [...notes, ...summary.dropped] };
}
