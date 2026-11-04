import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Code2, Copy, CopyPlus, Download, FileCode2, Globe, Info, RefreshCw, Sparkles, Trash2, Undo2, Wand2, Columns2, Eye, SquareCode } from 'lucide-react';
import type { CodeAsset, CodeKind, MediaRef, Project, PromptImage, Published } from '@/lib/types';
import { cn, fmtRelative, listJoin, slugify, uid } from '@/lib/utils';
import { CODE_KINDS, codeKindLabel, detectKind, matchKind, removeImages } from '@/ai/local/code';
import { codeEditTask, codeTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { MAX_PROMPT_IMAGES, imageDataUrls, imageKeyNumber, planPromptImages, reportRefusals } from '@/lib/promptImages';
import { unpublishPage } from '@/lib/publish';
import { copyText } from '@/lib/platform';
import { deleteBlob } from '@/lib/storage';
import { getActiveProject, useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { PromptImages, usePasteImages } from '@/components/ai/PromptImages';
import { PublishPanel } from '@/components/publish/PublishPanel';
import { CodeEditor, LivePreview, type CodeLang } from '@/components/code/CodeEditor';
import { AutoTextarea, Empty, Segmented, Spinner, confirmAction } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { download } from '@/components/ui/download';
import {
  NO_DRAFT,
  addCodeAsset,
  applyCodeEdit,
  artifactPageId,
  codeOf,
  defaultKind,
  downloadDocument,
  hasUnpublishedChanges,
  imageUseNotes,
  leftOutNote,
  missingImages,
  missingImagesNote,
  promptIdeas,
  publishBuild,
  readyDocument,
  rememberCodeUndo as remember,
  reservedImageKeys,
  setUndoStack,
  snapshotOf,
  undoCodeAsset,
  useCodeTabMemory,
  type Draft,
} from '@/lib/codeAssets';

type Lang = CodeLang | 'script';

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

/** What the built-in engine takes from a description (shown when it answered a guided request). */
const BUILT_IN_GENERATE =
  'The built-in engine made this from a template. From your description it only uses a name (“called …”), an end date and where forms send, and it puts in your first image.';
/** What the built-in editor can do (shown when it couldn't make a change). */
const BUILT_IN_EDIT =
  'The built-in editor couldn’t make that change. It can switch to a dark or light theme, make corners rounder or sharper, make text bigger or smaller, change the color or font, center the layout, add or remove shadows, and add or take out one of your images.';

/** An instruction about the owner's pictures (so it's worth saying which images aren't in it yet). */
const ABOUT_IMAGES = /\b(?:images?|photos?|pictures?|pics?|logo|img-\d+)\b/i;

const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') ? '⌘' : 'Ctrl';

const assets = () => getActiveProject()!.studio.codeAssets;

/** What happened last, for the asset it happened to: what changed (✓) and what the owner should know. */
interface Outcome {
  assetId: string;
  /** which AI run it came from (its result bar shows); null for Undo and "take it out of the code" */
  run: 'gen' | 'edit' | null;
  done: string[];
  notes: string[];
  /** a generation the owner described (the built-in engine follows little of it) */
  guided?: boolean;
  /** an edit that changed nothing */
  unchanged?: boolean;
}

/** Add images that were just saved to a list (see planPromptImages): say why any weren't added, and free those. */
function withImages(current: PromptImage[], media: MediaRef[], reserved: readonly string[] = []): PromptImage[] {
  const plan = planPromptImages(current, media, { reserved });
  reportRefusals(plan.refused);
  for (const m of media) if (!plan.added.some((a) => a.media.id === m.id)) void deleteBlob(m.id);
  return plan.images;
}

/** Ctrl+Enter (⌘+Enter on a Mac) in a text box runs `run`; Enter alone makes a new line. */
const onModEnter = (run: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    run();
  }
};

// ───────────── images in the preview ─────────────

/**
 * Full-size data URLs per asset, so switching back to an asset shows its images at once. Only the newest
 * 4 (each image can be a megabyte as a data URL); imageDataUrls keeps recent images too.
 */
const fullImageCache = new Map<string, { sig: string; urls: Record<string, string> }>();
const FULL_IMAGE_CACHE = 4;
const imagesSig = (images: PromptImage[] = []) => images.map((i) => `${i.key}=${i.media.id}`).join('|');

/**
 * An asset's images for the live preview: each one's thumbnail at once, then the full-size picture when
 * it's ready (made a moment after the images change, never on each keystroke in the code). `full` is the
 * full-size set when it's ready for exactly these images, so Copy and Export can use it straight away.
 */
function usePreviewImages(assetId: string | null, images: PromptImage[] | undefined) {
  const sig = imagesSig(images);
  const latest = useRef(images);
  latest.current = images;
  const [made, setMade] = useState<{ id: string; sig: string; urls: Record<string, string> } | null>(null);
  useEffect(() => {
    if (!assetId || !sig) return;
    const hit = fullImageCache.get(assetId);
    if (hit?.sig === sig) return setMade({ id: assetId, ...hit });
    let alive = true;
    const t = setTimeout(() => {
      void imageDataUrls(latest.current).then((urls) => {
        fullImageCache.delete(assetId);
        fullImageCache.set(assetId, { sig, urls });
        while (fullImageCache.size > FULL_IMAGE_CACHE) fullImageCache.delete(fullImageCache.keys().next().value!);
        if (alive) setMade({ id: assetId, sig, urls });
      });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [assetId, sig]);
  const cached = assetId ? fullImageCache.get(assetId) : undefined;
  const full = !sig ? null : made && made.id === assetId && made.sig === sig ? made.urls : cached?.sig === sig ? cached.urls : null;
  // keyed by sig: the thumbnails only change when the images do
  const urls = useMemo(() => {
    const out: Record<string, string> = {};
    for (const i of latest.current ?? []) if (i.media.thumb) out[i.key] = i.media.thumb;
    return { ...out, ...(full ?? {}) };
  }, [sig, full]);
  return { urls, full };
}

// ───────────── the tab ─────────────

export function CodeTab({ project }: { project: Project }) {
  const updateStudio = useStore((s) => s.updateStudio);
  const list = project.studio.codeAssets;
  const [activeId, setActiveId] = useState<string | null>(list[0]?.id ?? null);
  const active = list.find((a) => a.id === activeId) ?? list[0] ?? null;
  const draft = useCodeTabMemory((s) => s.drafts[project.id]) ?? NO_DRAFT;
  const kind = draft.kind ?? defaultKind(project);
  const undoStack = useCodeTabMemory((s) => (active ? s.undo[active.id] : undefined));
  const [lang, setLang] = useState<Lang>('html');
  const [view, setView] = useState<'split' | 'code' | 'preview'>('split');
  const [instruction, setInstruction] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [draftBusy, setDraftBusy] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const gen = useAI(codeTask);
  const edit = useAI(codeEditTask);
  const kinds = CODE_KINDS.filter((k) => !k.business || project.track === 'business');
  const ideas = useMemo(() => promptIdeas(project), [project]);
  const preview = usePreviewImages(active?.id ?? null, active?.images);
  const code = useMemo(() => (active ? codeOf(active) : null), [active?.html, active?.css, active?.js]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchAsset = (id: string, patch: Partial<CodeAsset>) => updateStudio({ codeAssets: assets().map((a) => (a.id === id ? { ...a, ...patch, updatedAt: Date.now() } : a)) });
  /** Where an asset is published. Not a change to the asset, so its "updated" time stays. */
  const setPublished = (id: string, published: Published | undefined) =>
    updateStudio({
      codeAssets: assets().map((a) => {
        if (a.id !== id) return a;
        const { published: _was, ...rest } = a;
        return published ? { ...rest, published } : rest;
      }),
    });
  const setDraft = (patch: Partial<Draft>) =>
    useCodeTabMemory.setState((s) => ({ drafts: { ...s.drafts, [project.id]: { ...(s.drafts[project.id] ?? NO_DRAFT), ...patch } } }));
  const setKind = (k: CodeKind) => setDraft({ kind: k });

  // images pasted or dropped on the creation box go with the next asset made
  const draftPaste = usePasteImages((media) => setDraft({ images: withImages(useCodeTabMemory.getState().drafts[project.id]?.images ?? [], media) }), {
    room: MAX_PROMPT_IMAGES - draft.images.length,
    disabled: gen.running,
    onBusy: setDraftBusy,
  });
  // …and on the edit box, to the asset that was open when they were pasted (saving them takes a moment)
  const pasteTarget = useRef<string | null>(null);
  const editPaste = usePasteImages(
    (media) => {
      const a = assets().find((x) => x.id === pasteTarget.current);
      if (!a) return media.forEach((m) => void deleteBlob(m.id));
      patchAsset(a.id, { images: withImages(a.images ?? [], media, reservedImageKeys(a, useCodeTabMemory.getState().undo[a.id])) });
    },
    { room: MAX_PROMPT_IMAGES - (active?.images?.length ?? 0), disabled: !active || edit.running, onBusy: setEditBusy },
  );
  const editPasteHandlers = {
    onPaste: (e: React.ClipboardEvent<HTMLElement>) => {
      pasteTarget.current = active?.id ?? null;
      editPaste.onPaste(e);
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      pasteTarget.current = active?.id ?? null;
      editPaste.onDrop(e);
    },
    onDragOver: editPaste.onDragOver,
  };

  // an asset's Publish panel asked for from elsewhere (the assistant): that asset opens with its panel in view, once.
  // Nothing is published by itself: the owner chooses the address and presses Publish there.
  const publishReq = useUI((s) => s.publishRequest);
  const focusPublish = useRef(false);
  useEffect(() => {
    if (publishReq?.page !== 'asset') return;
    useUI.setState({ publishRequest: null });
    if (__ARTIFACT_BUILD__ || !assets().some((a) => a.id === publishReq.assetId)) return;
    focusPublish.current = true;
    setActiveId(publishReq.assetId);
    setPublishOpen(true);
  }, [publishReq]);
  useEffect(() => {
    if (!focusPublish.current || !publishOpen) return;
    focusPublish.current = false;
    const el = document.getElementById('code-publish');
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.focus({ preventScroll: true });
  }, [publishOpen, active?.id]);

  // a description that names another kind ("a booking widget…") suggests it; the owner picks
  const named = useMemo(() => matchKind(draft.prompt), [draft.prompt]);
  const suggested = named && named !== kind && kinds.some((k) => k.id === named) ? named : null;

  const generate = async () => {
    if (gen.running) return;
    const text = draft.prompt.trim();
    const images = draft.images;
    const r = await gen.run({ kind, prompt: text, ...(images.length ? { images } : {}) });
    if (!r) return;
    const asset = addCodeAsset(project.id, r, text, images);
    setActiveId(asset.id);
    setLang('html');
    setOutcome({ assetId: asset.id, run: 'gen', done: [], notes: [...(r.note ? [r.note] : []), ...imageUseNotes(asset)], guided: !!text });
  };

  /** Rebuild an outdated asset in place with the current templates (same kind, request and images). */
  const regenerate = async (a: CodeAsset) => {
    if (!(await confirmAction({ title: `Regenerate “${a.name}”?`, body: 'This replaces its code with a new version. Any changes you made to this code are lost. Undo puts it back.', confirmLabel: 'Regenerate' }))) return;
    const r = await gen.run({ kind: a.kind, prompt: a.prompt, ...(a.images?.length ? { images: a.images } : {}) });
    const now = r && assets().find((x) => x.id === a.id);
    if (!r || !now) return;
    remember(a.id, snapshotOf(now, true));
    patchAsset(a.id, { html: r.html, css: r.css, js: r.js, script: r.script, outdated: false });
    setOutcome({ assetId: a.id, run: 'gen', done: [], notes: [...(r.note ? [r.note] : []), ...imageUseNotes({ ...codeOf(r), images: now.images })] });
  };

  const applyEdit = async (text: string) => {
    const a = active;
    const ask = text.trim();
    if (!a || !ask || edit.running) return;
    const before = snapshotOf(a);
    const r = await edit.run({ code: codeOf(a), instruction: ask, kind: a.kind, ...(before.images.length ? { images: before.images } : {}) });
    if (!r) return;
    const saved = applyCodeEdit(project.id, a.id, before, r);
    if (saved === 'gone') return;
    if (saved === 'unchanged') {
      // nothing changed: nothing to undo, and what was typed stays so it can be put another way
      setOutcome({ assetId: a.id, run: 'edit', done: [], notes: r.notes ?? [], unchanged: true });
      return;
    }
    const unused = ABOUT_IMAGES.test(ask) ? imageUseNotes(saved.asset) : [];
    setOutcome({ assetId: a.id, run: 'edit', done: r.applied, notes: [...(r.notes ?? []), ...unused] });
    // a quick edit leaves what the owner typed; an applied instruction is cleared (unless it was changed meanwhile)
    setInstruction((cur) => (cur.trim() === ask ? '' : cur));
  };

  const undo = () => {
    if (!active || undoCodeAsset(project.id, active.id) !== 'undone') return;
    setOutcome({ assetId: active.id, run: null, done: ['Put back the version from before your last change'], notes: [] });
  };

  /** Take images that were removed from the list out of the code too (Undo puts them back). */
  const takeOut = (a: CodeAsset, keys: string[]) => {
    remember(a.id, snapshotOf(a));
    patchAsset(a.id, codeOf(removeImages(codeOf(a), keys)));
    const which = listJoin(keys.map((k) => String(imageKeyNumber(k))));
    setOutcome({ assetId: a.id, run: null, done: [`Took image${keys.length === 1 ? '' : 's'} ${which} out of the code`], notes: [] });
  };

  const remove = async (a: CodeAsset) => {
    const live = a.published;
    const link = live ? live.domainUrl ?? live.url : '';
    const canUnpublish = !!live && !__ARTIFACT_BUILD__;
    const body = !live
      ? 'The code will be removed from this project.'
      : canUnpublish
        ? `The code will be removed from this project, and its public page (${link}) is taken down.`
        : `The code will be removed from this project. Its public page (${link}) stays online: unpublish it first in the app where you published it.`;
    if (!(await confirmAction({ title: `Delete “${a.name}”?`, body, confirmLabel: 'Delete', danger: true }))) return;
    if (canUnpublish) {
      try {
        await unpublishPage(artifactPageId(a.id));
      } catch (e) {
        // once the asset is gone nothing here can take its page down, so ask again
        const anyway = await confirmAction({
          title: 'Its public page is still online',
          body: `${(e as Error)?.message || 'It couldn’t be taken down.'} If you delete “${a.name}” now, its page stays at ${link} and can’t be taken down from here.`,
          confirmLabel: 'Delete anyway',
          danger: true,
        });
        if (!anyway) return;
      }
    }
    const next = assets().filter((x) => x.id !== a.id);
    updateStudio({ codeAssets: next });
    setUndoStack(a.id, []);
    setActiveId(next[0]?.id ?? null);
  };

  const duplicate = (a: CodeAsset) => {
    const now = Date.now();
    // a copy is a new page: it isn't published until it's published itself
    const { published: _published, ...rest } = a;
    const copy = { ...rest, id: uid('code'), name: `${a.name} (copy)`, createdAt: now, updatedAt: now };
    updateStudio({ codeAssets: [copy, ...assets()] });
    setActiveId(copy.id);
  };

  /** The page with its images embedded: at once when the preview has them all (keeps Copy's permission), else once they're made. */
  const pageWithImages = (a: CodeAsset): string | Promise<string> => {
    const finish = (d: { html: string; missing: string[] }) => {
      if (d.missing.length) toast({ kind: 'error', ...leftOutNote(d.missing) });
      return d.html;
    };
    const ready = readyDocument(a, a.id === active?.id ? preview.full : null);
    return ready ? finish(ready) : downloadDocument(a).then(finish);
  };

  const exportHtml = async (a: CodeAsset) => {
    try {
      await download(`${slugify(a.name) || 'widget'}.html`, await pageWithImages(a));
    } catch {
      toast({ kind: 'error', title: 'Couldn’t make the file', body: 'Please try again.' });
    }
  };

  const langs: { id: Lang; label: string }[] = [
    { id: 'html', label: 'HTML' },
    { id: 'css', label: 'CSS' },
    { id: 'js', label: 'JS' },
    ...(active?.script ? [{ id: 'script' as const, label: 'Apps Script' }] : []),
  ];
  const curLang: Lang = lang === 'script' && !active?.script ? 'html' : lang;

  // what happened last, when it was to this asset
  const shown = outcome && active && outcome.assetId === active.id ? outcome : null;
  const result = shown?.run === 'edit' ? edit.result : shown?.run === 'gen' ? gen.result : null;
  const builtIn = result?.provider === 'local';
  const notes = [
    ...(shown?.notes ?? []),
    ...(shown?.unchanged ? [builtIn ? BUILT_IN_EDIT : 'The AI sent back the same code, so nothing changed. Try saying it another way.'] : []),
    ...(shown?.run === 'gen' && shown.guided && builtIn ? [BUILT_IN_GENERATE] : []),
  ];
  const missing = active ? missingImages(active) : [];
  const reserved = active ? reservedImageKeys(active, undoStack) : [];
  const busy = gen.running || edit.running;

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="flex min-w-0 flex-col gap-4">
        <section className="panel p-4" aria-label="Generate a new asset">
          <h2 className="mb-1 flex items-center gap-2 text-[14px] font-semibold">
            <Sparkles size={15} className="text-accent" /> AI code & asset generator
          </h2>
          <p className="mb-3 text-xs text-muted">Working HTML, CSS and JavaScript in your brand colors. Edit it live, then {__ARTIFACT_BUILD__ ? 'copy or export it' : 'copy, export or publish it'}.</p>
          <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Asset type">
            {kinds.map((k) => (
              <button
                key={k.id}
                type="button"
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
            Describe it and guide the AI
          </label>
          <AutoTextarea
            id="code-prompt"
            value={draft.prompt}
            onChange={(v) => setDraft({ prompt: v })}
            minRows={3}
            placeholder={`${ideas[0]}. Say what it should do, what to include and how it should look.`}
            className="text-[13px]"
            aria-describedby="code-prompt-hint"
            onKeyDown={onModEnter(() => void generate())}
            {...draftPaste}
          />
          <p id="code-prompt-hint" className="hint">
            Paste or drop images here too. {MOD_KEY}+Enter generates.
          </p>
          <div aria-live="polite">
            {suggested && (
              <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-2">
                Your description sounds like a different type.
                <button type="button" className="link text-xs" onClick={() => setKind(suggested)}>
                  Switch to {SHORT_LABEL[suggested]}
                </button>
              </p>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {ideas.map((i) => (
              <button
                key={i}
                type="button"
                className="chip text-[11px]"
                title={i}
                onClick={() => {
                  setDraft({ prompt: i });
                  setKind(detectKind(i, project));
                }}
              >
                {i.length > 38 ? `${i.slice(0, 36)}…` : i}
              </button>
            ))}
          </div>
          <PromptImages
            images={draft.images}
            onChange={(images) => setDraft({ images })}
            busy={draftBusy}
            disabled={gen.running}
            label="Images (optional)"
            hint="Say where each one goes, in your description or in its note."
            className="mt-3"
          />
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
              {list.map((a) => {
                const on = active?.id === a.id;
                return (
                  <li key={a.id} className={cn(on && 'bg-primary-soft')}>
                    <button className={cn('flex w-full items-center gap-2.5 px-4 py-2.5 text-left', !on && 'hover:bg-surface-2')} onClick={() => setActiveId(a.id)} aria-current={on}>
                      <Icon name={CODE_KINDS.find((k) => k.id === a.kind)?.icon ?? 'code-xml'} size={15} className={on ? 'text-primary' : 'text-muted'} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold">{a.name}</span>
                        <span className="block text-[11px] text-muted">
                          {codeKindLabel(a.kind)} · {fmtRelative(a.updatedAt)}
                          {a.outdated && <span className="ml-1 font-semibold text-warn">· Outdated: regenerate</span>}
                        </span>
                      </span>
                    </button>
                    {a.published && <PublishedLink asset={a} published={a.published} />}
                  </li>
                );
              })}
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
                <CopyPageButton make={() => pageWithImages(active)} />
                <button className="btn btn-secondary btn-sm" onClick={() => void exportHtml(active)}>
                  <Download size={14} /> Export .html
                </button>
                {active.script && (
                  <button className="btn btn-secondary btn-sm" onClick={() => download(`${slugify(active.name) || 'sheet'}-apps-script.txt`, active.script ?? '')}>
                    <Download size={14} /> Apps Script
                  </button>
                )}
                {!__ARTIFACT_BUILD__ && (
                  <button type="button" className={cn('btn btn-sm', publishOpen ? 'btn-primary' : 'btn-secondary')} aria-expanded={publishOpen} aria-controls="code-publish" onClick={() => setPublishOpen((o) => !o)}>
                    <Globe size={14} /> {active.published ? 'Public page' : 'Publish'}
                    {active.published && <span className={cn('h-2 w-2 rounded-full', hasUnpublishedChanges(active) ? 'bg-warn' : 'bg-good')} aria-hidden="true" />}
                  </button>
                )}
                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => duplicate(active)} aria-label="Duplicate asset" title="Duplicate">
                  <CopyPlus size={15} />
                </button>
                <button className="btn btn-ghost btn-icon btn-sm text-muted hover:text-bad" onClick={() => void remove(active)} aria-label="Delete asset" title="Delete">
                  <Trash2 size={15} />
                </button>
              </div>
            </div>

            {publishOpen && !__ARTIFACT_BUILD__ && (
              <div id="code-publish" className="panel p-4 outline-none focus:shadow-focus" tabIndex={-1}>
                <PublishPanel
                  key={active.id}
                  pageId={artifactPageId(active.id)}
                  kind="artifact"
                  title={active.name}
                  defaultSlug={active.name}
                  published={active.published}
                  build={() => publishBuild(active)}
                  onChange={(p) => setPublished(active.id, p)}
                  version={active.updatedAt}
                />
              </div>
            )}

            {active.outdated && (
              <div className="panel flex flex-wrap items-center gap-2 border-warn/40 bg-warn-soft px-3 py-2.5 text-[13px]" role="status">
                <p className="min-w-0 flex-1">
                  <b>Outdated: regenerate.</b> An older version made this code. It may tell visitors a form was sent when nothing was, show made-up taken times, reviews or a deadline. Check it before you use it, or regenerate it.
                </p>
                <button className="btn btn-secondary btn-sm" onClick={() => regenerate(active)} disabled={busy}>
                  {gen.running ? <Spinner size={14} /> : <RefreshCw size={14} />} Regenerate
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => patchAsset(active.id, { outdated: false })}>
                  Dismiss
                </button>
              </div>
            )}

            <div className="panel p-3">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
                <div className="min-w-0">
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void applyEdit(instruction);
                    }}
                  >
                    <label htmlFor="code-edit" className="label flex items-center gap-1.5">
                      <Wand2 size={14} className="text-primary" aria-hidden="true" /> Edit with AI
                    </label>
                    <AutoTextarea
                      id="code-edit"
                      value={instruction}
                      onChange={setInstruction}
                      minRows={2}
                      placeholder="Say what to change, e.g. “add an email field, make it dark and put image 1 at the top”"
                      className="text-[13px]"
                      aria-describedby="code-edit-hint"
                      onKeyDown={onModEnter(() => void applyEdit(instruction))}
                      {...editPasteHandlers}
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button type="submit" className="btn btn-ai btn-sm" disabled={busy || !instruction.trim()}>
                        {edit.running ? <Spinner size={14} /> : <Sparkles size={14} className="text-accent" />} Apply
                      </button>
                      {(undoStack?.length ?? 0) > 0 && (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={undo} disabled={busy}>
                          <Undo2 size={14} /> Undo
                        </button>
                      )}
                      <span id="code-edit-hint" className="text-xs text-muted">
                        Paste or drop images here too. {MOD_KEY}+Enter applies.
                      </span>
                    </div>
                  </form>
                  <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Quick edits">
                    {QUICK_EDITS.map((q) => (
                      <button key={q} type="button" className="chip text-[11.5px]" disabled={busy} onClick={() => void applyEdit(q)}>
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
                <PromptImages
                  key={active.id}
                  images={active.images ?? []}
                  onChange={(images) => patchAsset(active.id, { images })}
                  reserved={reserved}
                  busy={editBusy}
                  disabled={edit.running}
                  label="Images in this asset"
                  hint="Say where they go, e.g. “put image 2 at the top”."
                />
              </div>

              {missing.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-ink-2" role="status">
                  <span className="min-w-0 flex-1">{missingImagesNote(missing)}</span>
                  <button type="button" className="btn btn-secondary btn-xs" onClick={() => takeOut(active, missing)} disabled={busy}>
                    Take {missing.length === 1 ? 'it' : 'them'} out of the code
                  </button>
                </div>
              )}

              <AIThinking running={edit.running} stage={edit.stage} chars={edit.chars} onStop={edit.stop} compact className="mt-2" />
              {edit.error && (
                <p className="mt-2 text-xs text-bad" role="alert">
                  {edit.error}
                </p>
              )}
              <div aria-live="polite">
                {shown && !busy && (shown.done.length > 0 || notes.length > 0) && (
                  <div className="mt-2 flex flex-col gap-1">
                    {shown.done.length > 0 && (
                      <ul className="flex flex-col gap-0.5 text-xs text-good">
                        {shown.done.map((d) => (
                          <li key={d}>✓ {d}</li>
                        ))}
                      </ul>
                    )}
                    {notes.map((n) => (
                      <p key={n} className="flex items-start gap-1.5 text-xs text-ink-2">
                        <Info size={13} className="mt-px shrink-0 text-muted" aria-hidden="true" />
                        <span>{n}</span>
                      </p>
                    ))}
                  </div>
                )}
              </div>
              {shown && result && !busy && (
                <AIResultBar className="mt-2" provider={result.provider} skills={result.skills} ms={result.ms} note={result.note} logId={shown.run === 'edit' ? edit.logId : gen.logId} />
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
                  <LivePreview code={code} title={active.name} images={preview.urls} />
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/** A published asset's address in the list (its own domain's when it has one), and whether it has changes not published yet. */
function PublishedLink({ asset, published }: { asset: CodeAsset; published: Published }) {
  const url = published.domainUrl ?? published.url;
  return (
    <p className="-mt-1.5 flex min-w-0 items-center gap-1.5 pb-2.5 pl-[41px] pr-4 text-[11.5px]">
      <Globe size={11} className="shrink-0 text-good" aria-hidden="true" />
      <a href={url} target="_blank" rel="noopener noreferrer" className="link min-w-0 truncate" title={url} aria-label={`${url}: the public page of ${asset.name} (opens in a new tab)`}>
        {url.replace(/^https?:\/\//, '')}
      </a>
      {hasUnpublishedChanges(asset) && <span className="shrink-0 text-warn">· changes not published</span>}
    </p>
  );
}

/** Copy HTML: the page with its images embedded (made first when the preview doesn't have them yet). */
function CopyPageButton({ make }: { make: () => string | Promise<string> }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const copy = async () => {
    let text: string;
    const made = make();
    if (typeof made === 'string') text = made;
    else {
      setState('busy');
      try {
        text = await made;
      } catch {
        setState('idle');
        toast({ kind: 'error', title: 'Couldn’t make the HTML', body: 'Please try again.' });
        return;
      }
    }
    const ok = await copyText(text);
    if (!ok) {
      setState('idle');
      toast({ kind: 'error', title: 'Copy was blocked', body: 'Try again, or use Export .html instead.' });
      return;
    }
    setState('done');
    setTimeout(() => setState('idle'), 1600);
  };
  return (
    <button type="button" className="btn btn-secondary btn-sm" disabled={state === 'busy'} onClick={() => void copy()}>
      {state === 'busy' ? <Spinner size={14} /> : state === 'done' ? <Check size={14} className="text-good" /> : <Copy size={14} />}
      {state === 'done' ? 'Copied' : 'Copy HTML'}
    </button>
  );
}
