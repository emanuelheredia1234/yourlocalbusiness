import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronLeft, Columns2, Copy, CopyPlus, Download, ExternalLink, Eye, Globe, ImagePlus, Info, RefreshCw, SquareCode, Trash2, Undo2 } from 'lucide-react';
import type { AgentSource, CodeAsset, CodeKind, MediaRef, Project, PromptImage, Published } from '@/lib/types';
import { cn, fmtRelative, listJoin, slugify, uid } from '@/lib/utils';
import { CODE_KINDS, codeKindLabel, detectKind, matchKind, removeImages } from '@/ai/local/code';
import { codeEditTask, codeTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { MAX_PROMPT_IMAGES, PROMPT_IMAGE_ACCEPT, imageDataUrls, imageKeyNumber, planPromptImages, reportRefusals } from '@/lib/promptImages';
import { unpublishPage } from '@/lib/publish';
import { copyText } from '@/lib/platform';
import { deleteBlob, saveMediaFile } from '@/lib/storage';
import { useMediaQuery } from '@/lib/hooks';
import { getActiveProject, useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { AIResultBar, AIThinking, GenerateButton, Spark } from '@/components/ai/AI';
import { PromptImages, usePasteImages } from '@/components/ai/PromptImages';
import { PublishPanel } from '@/components/publish/PublishPanel';
import { AgentButtons } from '@/components/agents/AgentButtons';
import { AgentBuildList } from '@/components/agents/AgentBuildList';
import { CodeEditor, LivePreview, type CodeLang } from '@/components/code/CodeEditor';
import { AutoTextarea, Callout, Empty, InfoTip, Modal, MoreMenu, OptionCards, Segmented, Select, Spinner, StatusDot, StickyActionBar, Tooltip, confirmAction, type MenuEntry } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { MediaThumb } from '@/components/media/MediaUpload';
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
import { AttachPayment } from '@/components/offers/AttachPayment';
import { findOffer, useOffers, useProjectOffers } from '@/store/offers';
import { hasBuyToken } from '@/lib/buyLinks';
import { offerPrice } from '@/lib/offers';
import type { BuyOffer } from '@/ai/tasks';

type Lang = CodeLang | 'script';
type View = 'split' | 'code' | 'preview';

const AGENT_LABEL: Record<AgentSource['via'], string> = { manus: 'Manus', viktor: 'Viktor' };

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

/** One line each on the type cards in the New asset window (the long descriptions wrap to four lines there). */
const SHORT_DESC: Record<CodeKind, string> = {
  calculator: 'Instant estimates',
  leadform: 'Collects emails',
  pricing: 'Plans side by side',
  hero: 'Headline and button',
  countdown: 'Timer to a date',
  quiz: 'Picks an offer',
  checklist: 'Remembers ticks',
  testimonials: 'Rotating reviews',
  booking: 'Pick a time',
  spreadsheet: 'Tabs and formulas',
  faq: 'Answers questions',
  roi: 'Shows the savings',
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

/** Side by side from this canvas width (px); narrower, the code sits above the preview. */
const SPLIT_SIDE_BY_SIDE = 760;

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

/** Save picked files as images (the ones that can't be saved say why). */
async function saveFiles(files: FileList | null, onBusy: (busy: boolean) => void): Promise<MediaRef[]> {
  if (!files?.length) return [];
  onBusy(true);
  const media: MediaRef[] = [];
  try {
    for (const f of Array.from(files)) {
      try {
        media.push(await saveMediaFile(f));
      } catch (e) {
        toast({ kind: 'error', title: `Couldn’t add ${f.name || 'that image'}`, body: (e as Error).message });
      }
    }
  } finally {
    onBusy(false);
  }
  return media;
}

/** Ctrl+Enter (⌘+Enter on a Mac) in a text box runs `run`; Enter alone makes a new line. */
const onModEnter = (run: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    run();
  }
};

/** The text box inside an AI composer frame: no border or fill of its own. */
const COMPOSER_TEXT = '!border-0 !bg-transparent !px-1 !py-0.5 !shadow-none';

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

/** An element's width as it changes (0 until it's measured). */
function useWidth() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width] as const;
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
  const [view, setView] = useState<View>('split');
  const [instruction, setInstruction] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  // phones: the list, then one asset (its preview), then the AI composer in a sheet
  const phone = useMediaQuery('(max-width: 639px)');
  // ≥ 1280 the agents' builds sit under the list; narrower (not a phone) they sit under the asset picker
  const wideList = useMediaQuery('(min-width: 1280px)');
  const [phoneAsset, setPhoneAsset] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [canvasRef, canvasWidth] = useWidth();
  const gen = useAI(codeTask);
  const edit = useAI(codeEditTask);
  const preview = usePreviewImages(active?.id ?? null, active?.images);
  const code = useMemo(() => (active ? codeOf(active) : null), [active?.html, active?.css, active?.js]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchAsset = (id: string, patch: Partial<CodeAsset>) => updateStudio({ codeAssets: assets().map((a) => (a.id === id ? { ...a, ...patch, updatedAt: Date.now() } : a)) });
  /** Where an asset is published. Not a change to the asset, so its "updated" time stays. */
  // the offer its Buy buttons sell: not a change to its code, so nothing to republish for it alone
  const setOffer = (id: string, offerId: string | undefined) =>
    updateStudio({
      codeAssets: assets().map((a) => {
        if (a.id !== id) return a;
        const { offerId: _was, ...rest } = a;
        return offerId ? { ...rest, offerId } : rest;
      }),
    });
  const setPublished = (id: string, published: Published | undefined) =>
    updateStudio({
      codeAssets: assets().map((a) => {
        if (a.id !== id) return a;
        const { published: _was, ...rest } = a;
        return published ? { ...rest, published } : rest;
      }),
    });
  const open = (id: string) => {
    setActiveId(id);
    setPhoneAsset(true);
  };

  // images pasted or dropped on the edit box go to the asset that was open when they were pasted (saving them takes a moment)
  const pasteTarget = useRef<string | null>(null);
  const addEditImages = (assetId: string | null, media: MediaRef[]) => {
    const a = assets().find((x) => x.id === assetId);
    if (!a) return media.forEach((m) => void deleteBlob(m.id));
    patchAsset(a.id, { images: withImages(a.images ?? [], media, reservedImageKeys(a, useCodeTabMemory.getState().undo[a.id])) });
  };
  const editPaste = usePasteImages((media) => addEditImages(pasteTarget.current, media), { room: MAX_PROMPT_IMAGES - (active?.images?.length ?? 0), disabled: !active || edit.running, onBusy: setEditBusy });
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
  const pickEditImages = async (files: FileList | null) => {
    const target = active?.id ?? null;
    const media = await saveFiles(files, setEditBusy);
    if (media.length) addEditImages(target, media);
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
    open(publishReq.assetId);
    setPublishOpen(true);
  }, [publishReq]);
  useEffect(() => {
    if (!focusPublish.current || !publishOpen) return;
    focusPublish.current = false;
    const el = document.getElementById('code-publish');
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.focus({ preventScroll: true });
  }, [publishOpen, active?.id]);

  // an asset asked for from elsewhere (a page from Manus or Viktor was just added): it opens, once
  const assetReq = useUI((s) => s.assetRequest);
  useEffect(() => {
    if (!assetReq) return;
    useUI.setState({ assetRequest: null });
    if (assets().some((a) => a.id === assetReq.assetId)) open(assetReq.assetId);
  }, [assetReq]);

  const generate = async () => {
    if (gen.running) return;
    const text = draft.prompt.trim();
    const images = draft.images;
    const r = await gen.run({ kind, prompt: text, ...(images.length ? { images } : {}) });
    if (!r) return;
    const asset = addCodeAsset(project.id, r, text, images);
    open(asset.id);
    setNewOpen(false);
    setLang('html');
    setOutcome({ assetId: asset.id, run: 'gen', done: [], notes: [...(r.note ? [r.note] : []), ...imageUseNotes(asset)], guided: !!text });
  };

  /** Rebuild an outdated asset in place with the current templates (same kind, request and images). */
  const regenerate = async (a: CodeAsset) => {
    if (!(await confirmAction({ title: `Regenerate “${a.name}”?`, body: 'This replaces its code with a new version. Any changes you made to this code are lost. Undo puts it back.', confirmLabel: 'Regenerate' }))) return;
    const r = await gen.run({ kind: a.kind, prompt: a.prompt, ...(a.images?.length ? { images: a.images } : {}), ...buyOfferOf(project.id, a) });
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
    const r = await edit.run({ code: codeOf(a), instruction: ask, kind: a.kind, ...(before.images.length ? { images: before.images } : {}), ...buyOfferOf(project.id, a) });
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
    if (!next.length) setPhoneAsset(false);
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
    // Buy buttons before the business's offers loaded: asked of the server first (not straight away)
    const offersKnown = !hasBuyToken(codeOf(a).html + codeOf(a).js) || !!useOffers.getState().byProject[project.id];
    const ready = offersKnown ? readyDocument(a, a.id === active?.id ? preview.full : null) : null;
    return ready ? finish(ready) : downloadDocument(a, a.id === active?.id ? preview.full : null, project.id).then(finish);
  };

  const exportHtml = async (a: CodeAsset) => {
    try {
      await download(`${slugify(a.name) || 'widget'}.html`, await pageWithImages(a));
    } catch {
      toast({ kind: 'error', title: 'Couldn’t make the file', body: 'Please try again.' });
    }
  };

  /** Copy HTML from a menu (phones): the menu closes, so a toast says it worked. */
  const copyFromMenu = async (a: CodeAsset) => {
    try {
      if (await copyText(await pageWithImages(a))) toast({ kind: 'success', title: 'HTML copied' });
      else toast({ kind: 'error', title: 'Copy was blocked', body: 'Try again, or use Export .html instead.' });
    } catch {
      toast({ kind: 'error', title: 'Couldn’t make the HTML', body: 'Please try again.' });
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

  const newAssetDialog = (
    <Modal
      open={newOpen}
      onClose={() => setNewOpen(false)}
      size="lg"
      title="New asset"
      subtitle="A page or widget in your brand, ready to copy, export or publish."
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={() => setNewOpen(false)}>
            Cancel
          </button>
          <GenerateButton variant="ai" running={gen.running} runningLabel="Building…" onClick={() => void generate()}>
            Generate
          </GenerateButton>
        </>
      }
    >
      <NewAssetForm project={project} running={gen.running} onGenerate={() => void generate()} />
      <AIThinking running={gen.running} stage={gen.stage} onStop={gen.stop} compact className="mt-4" />
      {gen.error && (
        <Callout tone="bad" className="mt-4">
          {gen.error}
        </Callout>
      )}
    </Modal>
  );

  /** "New asset", the agents' build buttons and their builds (the list's foot, or the empty state). */
  const newAssetButton = (variant: 'ai' | 'ai-outline', className?: string) => (
    <GenerateButton variant={variant} size="sm" running={gen.running} runningLabel="Building…" onClick={() => setNewOpen(true)} className={className}>
      New asset
    </GenerateButton>
  );

  // ── no assets yet ──
  if (!active || !code) {
    return (
      <div>
        <AgentBuildList target="asset" className="mb-6" />
        <Empty
          variant="ai"
          title="Make your first page or widget"
          body="A booking widget, a price table or a landing section, in your brand."
          action={
            <>
              <GenerateButton variant="ai" running={gen.running} runningLabel="Building…" onClick={() => setNewOpen(true)}>
                New asset
              </GenerateButton>
              <AgentButtons target="asset" className="justify-center" />
            </>
          }
        />
        {!newOpen && <AIThinking running={gen.running} stage={gen.stage} onStop={gen.stop} className="mx-auto max-w-[560px]" />}
        {!newOpen && gen.error && (
          <Callout tone="bad" className="mx-auto max-w-[560px]">
            {gen.error}
          </Callout>
        )}
        {newAssetDialog}
      </div>
    );
  }

  const assetList = (
    <AssetList
      list={list}
      activeId={active.id}
      onOpen={open}
      foot={
        <>
          {newAssetButton(phone ? 'ai' : 'ai-outline', 'w-full')}
          <AgentButtons target="asset" className="[&>span]:w-full [&_button]:w-full [&_button]:justify-start" />
        </>
      }
    />
  );

  // ── phones: the list first ──
  if (phone && !phoneAsset) {
    return (
      <div className="flex flex-col gap-6">
        {assetList}
        <AgentBuildList target="asset" />
        {!newOpen && <AIThinking running={gen.running} stage={gen.stage} onStop={gen.stop} />}
        {!newOpen && gen.error && <Callout tone="bad">{gen.error}</Callout>}
        {newAssetDialog}
      </div>
    );
  }

  const menu: MenuEntry[] = [
    ...(phone ? ([{ label: 'Copy HTML', icon: <Copy />, onSelect: () => void copyFromMenu(active) }] as MenuEntry[]) : []),
    { label: 'Export .html', icon: <Download />, onSelect: () => void exportHtml(active) },
    ...(active.script ? ([{ label: 'Export Apps Script', icon: <Download />, onSelect: () => download(`${slugify(active.name) || 'sheet'}-apps-script.txt`, active.script ?? '') }] as MenuEntry[]) : []),
    { label: 'Duplicate', icon: <CopyPlus />, onSelect: () => duplicate(active) },
    'separator',
    { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => void remove(active) },
  ];

  const publishButton = !__ARTIFACT_BUILD__ && (
    <button
      type="button"
      // filled only while its panel is closed: the panel has its own primary Publish (one filled button per view)
      className={cn('btn btn-sm', active.published || publishOpen ? 'btn-secondary' : 'btn-primary', phone && 'flex-1')}
      aria-expanded={publishOpen}
      aria-controls="code-publish"
      onClick={() => {
        setPublishOpen((o) => !o);
        if (phone) focusPublish.current = true;
      }}
    >
      {active.published ? (
        <>
          Public page
          <span className={cn('h-2 w-2 rounded-full', hasUnpublishedChanges(active) ? 'bg-warn-solid' : 'bg-good-solid')} aria-hidden="true" />
        </>
      ) : (
        <>
          <Globe /> Publish
        </>
      )}
    </button>
  );

  const composer = (
    <EditComposer
      asset={active}
      instruction={instruction}
      onInstruction={setInstruction}
      onApply={(t) => void applyEdit(t)}
      running={edit.running}
      busy={busy}
      imagesBusy={editBusy}
      reserved={reserved}
      onImages={(images) => patchAsset(active.id, { images })}
      onPickImages={(files) => void pickEditImages(files)}
      pasteHandlers={editPasteHandlers}
      canUndo={(undoStack?.length ?? 0) > 0}
      onUndo={undo}
      sticky={!phone}
      status={
        <>
          <AIThinking running={edit.running} stage={edit.stage} onStop={edit.stop} compact />
          {edit.error && (
            <p className="text-caption text-bad" role="alert">
              {edit.error}
            </p>
          )}
          <div aria-live="polite">
            {shown && !busy && (shown.done.length > 0 || notes.length > 0) && (
              <div className="flex flex-col gap-1">
                {shown.done.length > 0 && (
                  <ul className="flex flex-col gap-0.5 text-small text-good">
                    {shown.done.map((d) => (
                      <li key={d} className="flex items-start gap-1.5">
                        <Check size={14} className="mt-[3px] shrink-0" aria-hidden="true" />
                        {d}
                      </li>
                    ))}
                  </ul>
                )}
                {notes.map((n) => (
                  <p key={n} className="flex items-start gap-1.5 text-small text-ink-2">
                    <Info size={14} className="mt-[3px] shrink-0 text-muted" aria-hidden="true" />
                    <span>{n}</span>
                  </p>
                ))}
              </div>
            )}
          </div>
          {shown && result && !busy && <AIResultBar provider={result.provider} skills={result.skills} ms={result.ms} note={result.note} logId={shown.run === 'edit' ? edit.logId : gen.logId} />}
        </>
      }
    />
  );

  const codePane = (
    <div className={cn('flex min-w-0 flex-col overflow-hidden rounded-pop border border-line bg-surface', view === 'split' && canvasWidth < SPLIT_SIDE_BY_SIDE ? 'h-[360px]' : 'h-[560px]')}>
      {curLang === 'script' ? (
        <CodeEditor key={`${active.id}-script`} lang="js" value={active.script ?? ''} onChange={(v) => patchAsset(active.id, { script: v })} ariaLabel="Google Apps Script editor" />
      ) : (
        <CodeEditor key={`${active.id}-${curLang}`} lang={curLang} value={active[curLang]} onChange={(v) => patchAsset(active.id, { [curLang]: v })} />
      )}
    </div>
  );
  const lines = (curLang === 'script' ? active.script ?? '' : active[curLang]).split('\n').length;
  const publishedUrl = active.published ? (active.published.domainUrl ?? active.published.url).replace(/^https?:\/\//, '') : undefined;

  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[240px_minmax(0,1fr)]">
      {/* ≥ 1280: the list beside the canvas */}
      {!phone && (
        <aside className="hidden min-w-0 flex-col gap-6 xl:sticky xl:top-6 xl:flex" aria-label="Assets">
          {assetList}
          {wideList && <AgentBuildList target="asset" />}
        </aside>
      )}

      <section className="flex min-w-0 flex-col gap-4" aria-label="Code editor and live preview">
        {phone ? (
          <button type="button" className="btn btn-ghost btn-sm -ml-2 self-start" onClick={() => setPhoneAsset(false)}>
            <ChevronLeft /> Assets
          </button>
        ) : (
          // < 1280: a picker instead of the list
          <div className="flex flex-wrap items-center gap-2 xl:hidden">
            {/* one line, the height of the buttons beside it: Live or Draft as the dot before each name */}
            <Select<string>
              size="sm"
              value={active.id}
              onChange={(id) => setActiveId(id)}
              options={list.map((a) => ({
                value: a.id,
                label: a.name,
                icon: <span className={cn('h-[7px] w-[7px] rounded-full', a.published ? (hasUnpublishedChanges(a) ? 'bg-warn-solid' : 'bg-good-solid') : 'bg-faint')} role="img" aria-label={a.published ? (hasUnpublishedChanges(a) ? 'Changes not live' : 'Live') : 'Draft'} />,
              }))}
              aria-label="Asset"
              className="w-auto min-w-[220px] max-w-full"
            />
            {newAssetButton('ai-outline')}
            <AgentButtons target="asset" />
          </div>
        )}

        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 basis-[240px]">
            <input className="input input-inline -ml-2 h-9 w-full px-2 text-h4" value={active.name} onChange={(e) => patchAsset(active.id, { name: e.target.value })} aria-label="Asset name" />
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-small text-muted">
              <span>{codeKindLabel(active.kind)}</span>
              {active.source && (
                <>
                  <span aria-hidden="true">·</span>
                  <AgentSourceLink source={active.source} />
                </>
              )}
              <span aria-hidden="true">·</span>
              <span>Updated {fmtRelative(active.updatedAt)}</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!phone && <CopyPageButton make={() => pageWithImages(active)} />}
            {!phone && publishButton}
            <MoreMenu label="More asset actions" items={menu} />
          </div>
        </div>

        {!phone && !wideList && <AgentBuildList target="asset" />}

        {active.outdated && (
          <Callout
            tone="warn"
            title="Outdated: regenerate."
            onDismiss={() => patchAsset(active.id, { outdated: false })}
            action={
              <button type="button" className="btn btn-secondary btn-xs" onClick={() => void regenerate(active)} disabled={busy}>
                {gen.running ? <Spinner size={12} /> : <RefreshCw />} Regenerate
              </button>
            }
          >
            An older version made this code. It may tell visitors a form was sent when nothing was, or show made-up taken times, reviews or a deadline. Check it before you use it, or regenerate it.
          </Callout>
        )}
        {missing.length > 0 && (
          <Callout
            tone="warn"
            action={
              <button type="button" className="btn btn-secondary btn-xs" onClick={() => takeOut(active, missing)} disabled={busy}>
                Take {missing.length === 1 ? 'it' : 'them'} out of the code
              </button>
            }
          >
            {missingImagesNote(missing)}
          </Callout>
        )}

        {/* a regeneration (Outdated) or a New asset run whose window was closed: its progress and any error show here */}
        {!newOpen && <AIThinking running={gen.running} stage={gen.stage} onStop={gen.stop} compact />}
        {!newOpen && gen.error && <Callout tone="bad">{gen.error}</Callout>}

        {!__ARTIFACT_BUILD__ && <AssetPayment project={project} asset={active} onChange={(offerId) => setOffer(active.id, offerId)} />}

        {publishOpen && !__ARTIFACT_BUILD__ && (
          <div id="code-publish" className="card p-4 outline-none focus-visible:shadow-focus sm:p-5" tabIndex={-1}>
            <PublishPanel
              key={active.id}
              pageId={artifactPageId(active.id)}
              kind="artifact"
              projectId={project.id}
              title={active.name}
              defaultSlug={active.name}
              published={active.published}
              build={() => publishBuild(active)}
              onChange={(p) => setPublished(active.id, p)}
              version={active.updatedAt}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="View">
            <Segmented<View>
              value={phone && view === 'split' ? 'preview' : view}
              onChange={setView}
              options={[
                ...(phone ? [] : [{ id: 'split' as const, label: 'Split', icon: <Columns2 /> }]),
                { id: 'code', label: 'Code', icon: <SquareCode /> },
                { id: 'preview', label: 'Preview', icon: <Eye /> },
              ]}
            />
          </div>
          {(phone ? view === 'code' : view !== 'preview') && (
            <div role="group" aria-label="Code language">
              <Segmented<Lang> size="sm" value={curLang} onChange={setLang} options={langs} />
            </div>
          )}
          {(phone ? view === 'code' : view !== 'preview') && <span className="num ml-auto font-mono text-caption text-muted">{lines} lines</span>}
        </div>

        <div ref={canvasRef} className="well relative flex flex-col p-3 sm:p-6">
          {phone ? (
            view === 'code' ? (
              codePane
            ) : (
              <LivePreview code={code} title={active.name} images={preview.urls} url={publishedUrl} className="h-[520px]" />
            )
          ) : (
            <div className={cn('grid gap-4', view === 'split' && canvasWidth >= SPLIT_SIDE_BY_SIDE && 'grid-cols-2')}>
              {view !== 'preview' && codePane}
              {view !== 'code' && <LivePreview code={code} title={active.name} images={preview.urls} url={publishedUrl} className="h-[560px]" />}
            </div>
          )}
          {!phone && composer}
        </div>

        {phone && (
          <>
            <StickyActionBar>
              <button type="button" className="btn btn-ai-outline btn-sm flex-1" onClick={() => setComposerOpen(true)}>
                <Spark /> Edit with AI
              </button>
              {publishButton}
            </StickyActionBar>
            <Modal open={composerOpen} onClose={() => setComposerOpen(false)} title="Edit with AI" bodyClass="pb-6">
              {composer}
            </Modal>
          </>
        )}
      </section>
      {newAssetDialog}
    </div>
  );
}

// ───────────── the parts ─────────────

/** The assets: a row each (type, name, Live or Draft), each published one's address under it. */
function AssetList({ list, activeId, onOpen, foot }: { list: CodeAsset[]; activeId: string; onOpen: (id: string) => void; foot: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="Your assets">
      <h2 className="flex items-baseline justify-between gap-2 text-h4 text-ink">
        Assets <span className="num font-mono text-caption font-normal text-muted">{list.length}</span>
      </h2>
      <ul className="-mx-2 flex flex-col gap-0.5">
        {list.map((a) => {
          const on = activeId === a.id;
          return (
            <li key={a.id} className={cn('rounded-md', on && 'bg-primary-soft')}>
              <button type="button" className={cn('flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-120', !on && 'hover:bg-surface-2')} onClick={() => onOpen(a.id)} aria-current={on}>
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-surface-3 text-ink-2">
                  <Icon name={CODE_KINDS.find((k) => k.id === a.kind)?.icon ?? 'code-xml'} size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui text-ink">{a.name}</span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption text-muted">
                    {a.published ? hasUnpublishedChanges(a) ? <StatusDot tone="warn">Changes not live</StatusDot> : <StatusDot tone="good">Live</StatusDot> : <StatusDot tone="faint">Draft</StatusDot>}
                    {a.source && <span>· {AGENT_LABEL[a.source.via]}</span>}
                    {a.outdated && <span className="text-warn">· Outdated</span>}
                  </span>
                </span>
              </button>
              {a.published && <PublishedLink asset={a} published={a.published} />}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col gap-2">{foot}</div>
    </section>
  );
}

/**
 * The box to describe a new asset: its type, what it should be (with images), and ideas. In the New asset
 * window; exported so tests can render it (a closed window renders nothing).
 */
export function NewAssetForm({ project, running, onGenerate }: { project: Project; running: boolean; onGenerate: () => void }) {
  const draft = useCodeTabMemory((s) => s.drafts[project.id]) ?? NO_DRAFT;
  const kind = draft.kind ?? defaultKind(project);
  const kinds = CODE_KINDS.filter((k) => !k.business || project.track === 'business');
  const ideas = useMemo(() => promptIdeas(project), [project]);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // phones: the type is a select (twelve cards would fill the sheet before the description box)
  const phone = useMediaQuery('(max-width: 639px)');
  const setDraft = (patch: Partial<Draft>) =>
    useCodeTabMemory.setState((s) => ({ drafts: { ...s.drafts, [project.id]: { ...(s.drafts[project.id] ?? NO_DRAFT), ...patch } } }));
  const setKind = (k: CodeKind) => setDraft({ kind: k });
  const addImages = (media: MediaRef[]) => setDraft({ images: withImages(useCodeTabMemory.getState().drafts[project.id]?.images ?? [], media) });
  // images pasted or dropped on the box go with the asset
  const paste = usePasteImages(addImages, { room: MAX_PROMPT_IMAGES - draft.images.length, disabled: running, onBusy: setBusy });
  // a description that names another kind ("a booking widget…") suggests it; the owner picks
  const named = useMemo(() => matchKind(draft.prompt), [draft.prompt]);
  const suggested = named && named !== kind && kinds.some((k) => k.id === named) ? named : null;

  return (
    <section className="flex flex-col gap-5" aria-label="Generate a new asset">
      {phone ? (
        <div>
          <label htmlFor="code-kind" className="label">
            Asset type
          </label>
          <Select<CodeKind> id="code-kind" aria-label="Asset type" value={kind} onChange={setKind} options={kinds.map((k) => ({ value: k.id, label: SHORT_LABEL[k.id], icon: <Icon name={k.icon} /> }))} />
        </div>
      ) : (
        <OptionCards<CodeKind>
          aria-label="Asset type"
          columns={4}
          value={kind}
          onChange={setKind}
          options={kinds.map((k) => ({ value: k.id, title: SHORT_LABEL[k.id], description: SHORT_DESC[k.id], icon: <Icon name={k.icon} /> }))}
        />
      )}
      <div>
        <label htmlFor="code-prompt" className="label">
          Describe it
        </label>
        <div className="ai-composer px-3 pb-2 pt-2.5">
          <AutoTextarea
            id="code-prompt"
            aria-describedby="code-prompt-hint"
            value={draft.prompt}
            onChange={(v) => setDraft({ prompt: v })}
            minRows={3}
            placeholder={`${ideas[0]}. Say what it should do, what to include and how it should look.`}
            onKeyDown={onModEnter(onGenerate)}
            {...paste}
            className={COMPOSER_TEXT}
          />
          {(draft.images.length > 0 || busy) && <PromptImages images={draft.images} onChange={(images) => setDraft({ images })} busy={busy} disabled={running} compact className="mt-2" />}
          <div className="mt-1.5 flex items-center gap-1.5">
            <Tooltip content="Add images">
              <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Add images" disabled={running || draft.images.length >= MAX_PROMPT_IMAGES} onClick={() => fileInput.current?.click()}>
                <ImagePlus />
              </button>
            </Tooltip>
            <input
              ref={fileInput}
              type="file"
              accept={PROMPT_IMAGE_ACCEPT}
              multiple
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const files = e.target.files;
                void saveFiles(files, setBusy).then((media) => {
                  if (media.length) addImages(media);
                });
                e.target.value = '';
              }}
            />
            <span className="text-caption text-muted">Your photos or logo: say where each one goes.</span>
          </div>
        </div>
        <p id="code-prompt-hint" className="hint">
          Paste or drop images here too. {MOD_KEY}+Enter generates.
        </p>
        <div aria-live="polite">
          {suggested && (
            <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-small text-ink-2">
              Your description sounds like a different type.
              <button type="button" className="link text-small" onClick={() => setKind(suggested)}>
                Switch to {SHORT_LABEL[suggested]}
              </button>
            </p>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Ideas">
          {ideas.map((i) => (
            <button
              key={i}
              type="button"
              className="chip max-w-[40ch]"
              title={i}
              onClick={() => {
                setDraft({ prompt: i });
                setKind(detectKind(i, project));
              }}
            >
              <span className="truncate">{i}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * "Edit with AI" for the open asset: what to change, its images, Undo and Apply, and quick edits. Docked at
 * the bottom of the canvas (a sheet on phones). The status (thinking, what changed, the result bar) sits above it.
 */
function EditComposer({
  asset,
  instruction,
  onInstruction,
  onApply,
  running,
  busy,
  imagesBusy,
  reserved,
  onImages,
  onPickImages,
  pasteHandlers,
  canUndo,
  onUndo,
  sticky,
  status,
}: {
  asset: CodeAsset;
  instruction: string;
  onInstruction: (v: string) => void;
  onApply: (text: string) => void;
  running: boolean;
  busy: boolean;
  imagesBusy: boolean;
  reserved: readonly string[];
  onImages: (images: PromptImage[]) => void;
  onPickImages: (files: FileList | null) => void;
  pasteHandlers: Pick<React.HTMLAttributes<HTMLElement>, 'onPaste' | 'onDrop' | 'onDragOver'>;
  canUndo: boolean;
  onUndo: () => void;
  sticky: boolean;
  status: ReactNode;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const images = asset.images ?? [];
  // quick edits: three at a time (one row under the box), "More ideas" shows the next ones
  const [ideasPage, setIdeasPage] = useState(0);
  const pages = Math.ceil(QUICK_EDITS.length / 3);
  const ideas = QUICK_EDITS.slice((ideasPage % pages) * 3, (ideasPage % pages) * 3 + 3);
  // docked over the canvas, the box stays small: its images (with their notes) open while you're in it, a strip of
  // thumbnails stands for them otherwise
  const folded = sticky && images.length > 0 && !imagesBusy;
  const form = (
    <form
      className="mx-auto flex w-full max-w-[760px] flex-col gap-2"
      aria-label="Edit with AI"
      onSubmit={(e) => {
        e.preventDefault();
        onApply(instruction);
      }}
    >
      {status}
      <div className={cn('ai-composer group/composer px-3 pb-2 pt-2.5', sticky && 'shadow-pop')}>
        <label htmlFor="code-edit" className="sr-only">
          Edit with AI
        </label>
        <AutoTextarea
          id="code-edit"
          value={instruction}
          onChange={onInstruction}
          minRows={2}
          placeholder="Say what to change, e.g. “add an email field, make it dark and put image 1 at the top”"
          onKeyDown={onModEnter(() => onApply(instruction))}
          {...pasteHandlers}
          className={COMPOSER_TEXT}
        />
        {(images.length > 0 || imagesBusy) && (
          <PromptImages key={asset.id} images={images} onChange={onImages} reserved={reserved} busy={imagesBusy} disabled={running} label="Images in this asset" compact className={cn('mt-2', folded && 'hidden group-focus-within/composer:flex')} />
        )}
        <div className="mt-1.5 flex items-center gap-1.5">
          <Tooltip content="Add images">
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Add images" disabled={running || images.length >= MAX_PROMPT_IMAGES} onClick={() => fileInput.current?.click()}>
              <ImagePlus />
            </button>
          </Tooltip>
          {folded && (
            <button
              type="button"
              className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-caption text-muted transition-colors duration-120 hover:text-ink group-focus-within/composer:hidden"
              onClick={() => document.getElementById('code-edit')?.focus()}
              aria-label={`${images.length === 1 ? '1 image' : `${images.length} images`} in this asset: show ${images.length === 1 ? 'it' : 'them'}`}
            >
              <span className="flex gap-1" aria-hidden="true">
                {images.slice(0, 4).map((i) => (
                  <MediaThumb key={i.key} media={i.media} className="h-6 w-6 rounded" />
                ))}
              </span>
              <span className="num truncate">{images.length === 1 ? '1 image' : `${images.length} images`}</span>
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept={PROMPT_IMAGE_ACCEPT}
            multiple
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              onPickImages(e.target.files);
              e.target.value = '';
            }}
          />
          <span className="ml-auto flex items-center gap-1.5">
            {canUndo && (
              <Tooltip content="Put back the version before your last change">
                <button type="button" className="btn btn-ghost btn-sm" onClick={onUndo} disabled={busy}>
                  <Undo2 /> Undo
                </button>
              </Tooltip>
            )}
            <InfoTip label="About AI edits">
              Say what to change and the AI edits this code; the preview updates as soon as it’s done. Paste or drop images on the box too, and say where each one goes, e.g. “put image 2 at the top”. {MOD_KEY}+Enter applies.
            </InfoTip>
            <button type="submit" className={cn('btn btn-ai-outline btn-sm', running && 'is-running')} disabled={busy || !instruction.trim()} aria-busy={running || undefined}>
              <Spark size={16} />
              {running ? 'Applying…' : 'Apply'}
            </button>
          </span>
        </div>
      </div>
      {!instruction.trim() && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Quick edits">
          {ideas.map((q) => (
            <button key={q} type="button" className="chip max-w-[40ch]" title={q} disabled={busy} onClick={() => onApply(q)}>
              <span className="truncate">{q}</span>
            </button>
          ))}
          {pages > 1 && (
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setIdeasPage((p) => p + 1)}>
              More ideas
            </button>
          )}
        </div>
      )}
    </form>
  );
  // docked at the bottom of the canvas while it scrolls by: a short fade, then the canvas colour behind the status
  // lines, the box and the quick edits (so no code or preview shows through them)
  return sticky ? (
    <div className="sticky bottom-0 z-10 -mx-3 -mb-3 mt-4 sm:-mx-6 sm:-mb-6">
      <div className="pointer-events-none h-6 bg-gradient-to-t from-surface-2 to-transparent" aria-hidden="true" />
      <div className="rounded-b-pop bg-surface-2 px-3 pb-3 sm:px-6 sm:pb-5">{form}</div>
    </div>
  ) : (
    form
  );
}

/** Who made an asset from a page of theirs (Manus or Viktor), with a link to the task or thread. Their code is theirs: check it before you publish. */
function AgentSourceLink({ source }: { source: AgentSource }) {
  const label = AGENT_LABEL[source.via];
  const title = `Made by ${label}${source.url ? `: open the ${source.via === 'manus' ? 'Manus task' : 'Slack thread'}` : ''}`;
  return (
    <span>
      Made by{' '}
      {source.url ? (
        <a href={source.url} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-1" title={title}>
          {label} <ExternalLink size={12} aria-hidden="true" />
        </a>
      ) : (
        <span className="font-medium text-ink-2" title={title}>
          {label}
        </span>
      )}
    </span>
  );
}

/** A published asset's address in the list (its own domain's when it has one). */
function PublishedLink({ asset, published }: { asset: CodeAsset; published: Published }) {
  const url = published.domainUrl ?? published.url;
  return (
    <p className="-mt-1 flex min-w-0 items-center gap-1.5 pb-2 pl-[46px] pr-2 text-caption">
      <a href={url} target="_blank" rel="noopener noreferrer" className="link min-w-0 truncate font-mono font-normal" title={url} aria-label={`${url}: the public page of ${asset.name} (opens in a new tab)`}>
        {url.replace(/^https?:\/\//, '')}
      </a>
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
      {state === 'busy' ? <Spinner size={14} /> : state === 'done' ? <Check className="text-good" /> : <Copy />}
      {state === 'done' ? 'Copied' : 'Copy HTML'}
    </button>
  );
}

/** The offer an asset's Buy buttons sell, for the AI (only when it's loaded and selling or paused). */
function buyOfferOf(projectId: string, a: CodeAsset): { offer?: BuyOffer } {
  const o = findOffer(projectId, a.offerId);
  return o && o.status !== 'archived' ? { offer: { id: o.id, title: o.title, priceDisplay: offerPrice(o) } } : {};
}

/** An asset's payment: the offer its Buy buttons sell, and whether its code uses it yet. */
function AssetPayment({ project, asset, onChange }: { project: Project; asset: CodeAsset; onChange: (offerId: string | undefined) => void }) {
  const { on } = useProjectOffers(project.id);
  if (!on) return null;
  const uses = asset.offerId ? new RegExp(`\\{\\{\\s*buy:${asset.offerId}\\s*\\}\\}`).test(asset.html) : false;
  return (
    <div className="card flex flex-col gap-2 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-ui font-medium text-ink">Payment</h3>
        <p className="text-caption text-muted">What this asset’s Buy buttons sell</p>
      </div>
      <AttachPayment projectId={project.id} value={asset.offerId} onAttach={(o) => onChange(o.id)} onDetach={() => onChange(undefined)} />
      {asset.offerId && !uses && <p className="text-caption text-muted">Its Buy buttons use this after you edit or regenerate the asset (for example: “Make the Buy button open the checkout”).</p>}
    </div>
  );
}
