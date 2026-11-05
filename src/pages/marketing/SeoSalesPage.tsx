import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, CircleDashed, Copy, Download, ExternalLink, Eye, EyeOff, ImagePlus, Monitor, PenLine, RefreshCw, Smartphone, Undo2, X } from 'lucide-react';
import type { MediaRef, PageType, Project, PromptImage, Published, SalesPage, SalesSection, SalesTheme, SeoMeta } from '@/lib/types';
import { cn, listJoin, moveItem, plural, slugify, stripProtocol, truncate } from '@/lib/utils';
import { claimsToReview, canonicalForSlugChange, ctaLink, ownCanonical, pageImageIds, pageTargets, placeNewImages, pruneImages, scoreSeo, SECTION_LABEL, sectionsKeptHidden, siteUrl, type SeoCheck } from '@/ai/local/seo';
import { AI_NO_CHANGE, salesPageEditTask, salesPageTask, salesSectionTask, seoMetaTask, type SalesEditInput, type SalesEditResult, type SalesSectionInput } from '@/ai/tasks';
import { applySalesPageEdit, applySalesSection, applySeoMeta, undoSeo, writeSeoPage, type SeoWriters } from '@/ai/seoBuilder';
import { useAI } from '@/ai/useAI';
import { copyText } from '@/lib/platform';
import { deleteBlob } from '@/lib/storage';
import { useMediaUrl } from '@/lib/media';
import { useMediaQuery } from '@/lib/hooks';
import { MAX_PROMPT_IMAGES, imageDataUrls, imageKeyNumber, nextImageKey, planPromptImages, reportRefusals } from '@/lib/promptImages';
import { PAGE_TYPE_DESC, PAGE_TYPE_LABEL, PAGE_TYPE_LINKS, bookingLink, missingLink, pageTypeNoun, pageTypeOf, paymentLink, sectionPlan } from '@/lib/pageTypes';
import { navigate } from '@/lib/router';
import { usePublishAccess } from '@/lib/publish';
import { getActiveProject, useActiveProject, useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { AIComposer, AIResultBar, AIThinking, GenerateButton, Spark } from '@/components/ai/AI';
import { PromptImages, usePasteImages } from '@/components/ai/PromptImages';
import { PublishPanel } from '@/components/publish/PublishPanel';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  AutoTextarea,
  Callout,
  ChipInput,
  Drawer,
  Empty,
  Field,
  InfoTip,
  Modal,
  MoreMenu,
  PageHeader,
  ProgressRing,
  Segmented,
  Select,
  Skeleton,
  Spinner,
  StatusDot,
  StickyActionBar,
  Tooltip,
  confirmAction,
  type MenuEntry,
} from '@/components/ui/primitives';
import { BrowserFrame } from '@/components/frames/Frames';
import { BrandBanner } from '@/components/brand/Logo';
import { download } from '@/components/ui/download';
import { PageTypeLinks, PageTypePicker } from './PageTypePicker';
import { SalesPreview } from './SalesPreview';
import { highestImageNumber, joinImages, seoFileHtml, seoPageId, seoPublishBuild, seoSourceHtml, shownPromptImages } from '@/lib/seoPage';
import { useSeoUndo, type SeoSnapshot } from '@/store/seoUndo';
import { AgentButtons } from '@/components/agents/AgentButtons';
import { AgentBuildList } from '@/components/agents/AgentBuildList';
import { SeoHtmlMode, SeoVersionSwitch } from './SeoHtmlMode';

type Marketing = Project['marketing'];
type AIHook<I, O> = ReturnType<typeof useAI<I, O>>;
/** The left column's panels (one open at a time). */
export type RailPanel = 'type' | 'links' | 'score' | 'publish' | 'guide' | 'meta' | 'sections' | '';

const marketing = () => getActiveProject()!.marketing;
const NO_IMAGES: PromptImage[] = [];
const NO_UNDO: SeoSnapshot[] = [];

export const scoreWord = (score: number) => (score >= 80 ? 'Great' : score >= 55 ? 'Getting there' : 'Needs work');

/** The media id of the hero's image, if it has one. */
function heroImageId(page: SalesPage | null | undefined): string | undefined {
  const hero = page?.sections.find((s) => s.type === 'hero');
  return hero?.type === 'hero' ? hero.data.imageId : undefined;
}

/** The page's live address as people see it ("copperandcomb.com/booking"), once it's published. */
export const liveAddress = (p?: Published) => (p ? stripProtocol(p.domainUrl ?? p.url) : '');

/** Which panel the left column opens with: something to act on first (images not on the page, then publishing), else the score. */
function firstPanel(o: { html: boolean; published: boolean; unplaced: number }): RailPanel {
  if (!o.html && o.unplaced > 0) return 'guide';
  return o.published ? 'score' : 'publish';
}

export default function SeoSalesPage() {
  const project = useActiveProject()!;
  const updateMarketing = useStore((s) => s.updateMarketing);
  const meta = project.marketing.seo;
  const page = project.marketing.salesPage;
  const images = project.marketing.seoImages ?? NO_IMAGES;
  const metaAI = useAI(seoMetaTask);
  const pageAI = useAI(salesPageTask);
  const editAI = useAI(salesPageEditTask);
  const sectionAI = useAI(salesSectionTask);
  const undoStack = useSeoUndo((s) => s.stacks[project.id] ?? NO_UNDO);
  const phone = useMediaQuery('(max-width: 639px)');
  // on a phone the canvas opens on Preview (editing text on a small screen comes second)
  const [editing, setEditing] = useState(() => !(typeof window !== 'undefined' && window.matchMedia?.('(max-width: 639px)').matches));
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  // the page's type, and the one being chosen (before a page is written, or to change it)
  const type = pageTypeOf(project);
  const [choice, setChoice] = useState<PageType>(type);
  const [typeOpen, setTypeOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  /** the type someone else suggested (the Strategy tab, the assistant), until the owner moves on */
  const [suggested, setSuggested] = useState<PageType | null>(null);
  const { access } = usePublishAccess();
  const result = useMemo(() => (meta ? scoreSeo(meta, page, type) : null), [meta, page, type]);
  const toReview = claimsToReview(page);
  const busy = metaAI.running || pageAI.running || editAI.running || sectionAI.running;
  const projectId = project.id;
  // the page Manus or Viktor made is the one in use (HTML mode): shown, scored and published instead of the builder's
  const seoHtml = project.marketing.seoHtml;
  const htmlMode = !!seoHtml?.active && !!meta;
  const published = project.marketing.seoPublished;
  const onPage = new Set(pageImageIds(page ?? null));
  const unplaced = page ? images.filter((i) => i.media.kind === 'image' && !onPage.has(i.media.id)) : NO_IMAGES;

  // The left column: one panel open at a time, opened afresh when the page (or HTML mode) first shows.
  const mode = htmlMode ? 'html' : page && meta ? 'page' : 'none';
  const [railMode, setRailMode] = useState(mode);
  const [rail, setRail] = useState<RailPanel>(() => firstPanel({ html: htmlMode, published: !!published, unplaced: unplaced.length }));
  if (railMode !== mode) {
    setRailMode(mode);
    setRail(firstPanel({ html: htmlMode, published: !!published, unplaced: unplaced.length }));
  }

  // another project: its own type, nothing open
  useEffect(() => {
    setChoice(pageTypeOf(project));
    setTypeOpen(false);
    setSuggested(null);
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // opened with a type chosen elsewhere: take it once. It never writes anything by itself.
  const preset = useUI((s) => s.seoPreset);
  useEffect(() => {
    if (!preset) return;
    useUI.setState({ seoPreset: undefined });
    setChoice(preset.pageType);
    setSuggested(preset.pageType);
    if (current().salesPage) setTypeOpen(true);
  }, [preset]); // eslint-disable-line react-hooks/exhaustive-deps

  // The Publish panel, opened in the left column and brought into view (the header's Publish, or the assistant).
  // Nothing is published by itself.
  const publishRef = useRef<HTMLDivElement>(null);
  const [showPublish, setShowPublish] = useState(0);
  const openPublish = () => {
    setRail('publish');
    setShowPublish((n) => n + 1);
  };
  useEffect(() => {
    if (!showPublish) return;
    const t = requestAnimationFrame(() => {
      publishRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      publishRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(t);
  }, [showPublish]);
  const publishReq = useUI((s) => s.publishRequest);
  useEffect(() => {
    if (publishReq?.page !== 'seo') return;
    useUI.setState({ publishRequest: null });
    openPublish();
  }, [publishReq]);

  // AI changes land in the project they were asked for, even if another one is opened meanwhile.
  const projectNow = (): Project => useStore.getState().projects.find((p) => p.id === projectId) ?? project;
  const current = (): Marketing => projectNow().marketing;
  const save = (patch: Partial<Marketing>) => useStore.getState().updateProject(projectId, (p) => ({ ...p, marketing: { ...p.marketing, ...patch } }));
  const imagesPatch = (next: PromptImage[]): Partial<Marketing> => ({ seoImages: next, seoImageMax: highestImageNumber(next, current().seoImageMax) });

  const setMeta = (patch: Partial<SeoMeta>) => updateMarketing({ seo: { ...marketing().seo!, ...patch } });
  const setPage = (fn: (p: SalesPage) => SalesPage) => {
    const cur = marketing().salesPage;
    if (cur) updateMarketing({ salesPage: { ...fn(cur), updatedAt: Date.now() } });
  };

  const undo = () => {
    if (undoSeo(projectId) === 'undone') toast({ kind: 'info', title: 'Undone', body: htmlMode ? 'Your page is back to how it was before the last change.' : 'Your page is back to how it was before the last AI change.' });
  };
  // the page's own AI runs (null when stopped or failed)
  const writers: SeoWriters = { meta: (i) => metaAI.run(i), page: (i) => pageAI.run(i) };

  /** The page's images changed in a prompt box: an image taken out of the list comes off the page too. */
  const setImages = (next: PromptImage[]) => {
    const m = current();
    const pruned = m.salesPage ? pruneImages(m.salesPage, next) : null;
    save({ ...imagesPatch(next), ...(pruned && pruned !== m.salesPage ? { salesPage: { ...pruned, updatedAt: Date.now() } } : {}) });
  };
  /** Images in the list that aren't on the page go on it the built-in way: the hero first (if it has none), then the gallery. */
  const addToPage = () => {
    const m = current();
    if (!m.salesPage) return;
    const imgs = m.seoImages ?? [];
    const on = new Set(pageImageIds(m.salesPage));
    const keys = imgs.filter((i) => i.media.kind === 'image' && !on.has(i.media.id)).map((i) => i.key);
    save({ salesPage: { ...placeNewImages(m.salesPage, projectNow(), imgs, keys), updatedAt: Date.now() } });
  };

  /** Write the page (as type `t`), or rewrite it: never by itself, only when the owner presses Write page or Rewrite page. */
  const generateAll = async (t: PageType = pageTypeOf(projectNow())) => {
    const m = current();
    // Buy now opens the owner's own payment link: a checkout page needs one before it's written
    if (!m.salesPage && t === 'checkout' && !paymentLink(projectNow())) {
      toast({ kind: 'info', title: 'Add your payment link first', body: 'Buy now opens your own payment link: the app never takes payments.' });
      return;
    }
    if (
      m.salesPage &&
      !(await confirmAction({
        title: 'Rewrite the whole page?',
        body: 'Your copy and edits will be replaced, following your guidance. Kept: metadata, your testimonials and facts, your guarantee, prices, services, contact details and images. You can undo this.',
        confirmLabel: 'Rewrite page',
      }))
    )
      return;
    // metadata first when there's none; sections the new page doesn't have that hold what the owner entered stay, hidden
    await writeSeoPage(projectId, t, writers);
  };

  /** Page type → Change: the AI writes the page again for the new type (after the owner confirms). Stopped or failed: nothing changes. */
  const switchType = async (next: PageType) => {
    const m = current();
    const now = projectNow();
    if (!m.salesPage || busy) return;
    if (next === 'checkout' && !paymentLink(now)) return;
    const kept = sectionsKeptHidden(m.salesPage, sectionPlan(next, now).map((x) => x.type));
    const ok = await confirmAction({
      title: `Rewrite this page as ${pageTypeNoun(next)}?`,
      body: `The AI writes the page again for this type. Kept: your metadata, testimonials and facts, prices, contact details and images.${kept.length ? ` Hidden but kept: ${listJoin(kept.map((k) => SECTION_LABEL[k]))}.` : ''} You can undo this.`,
      confirmLabel: `Rewrite as ${PAGE_TYPE_LABEL[next].toLowerCase()}`,
    });
    if (!ok) return;
    if (!(await writeSeoPage(projectId, next, writers))) return;
    setChoice(next);
    setTypeOpen(false);
    setSuggested(null);
    toast({ kind: 'success', title: `Your page is now ${pageTypeNoun(next)}`, body: current().seoPublished ? 'Publish it again to update the live page.' : undefined });
  };

  const regenMeta = async () => {
    const m = current();
    const imgs = m.seoImages ?? [];
    const mainImage = imgs.find((i) => i.media.id === heroImageId(m.salesPage))?.key;
    const next = await metaAI.run({ instructions: (m.seoGuide ?? '').trim(), images: imgs, ...(mainImage ? { mainImage } : {}), pageType: pageTypeOf(projectNow()) });
    // only a canonical the app made from the slug is replaced; an address the owner pasted is kept
    if (next) applySeoMeta(projectId, next);
  };

  /** A rewritten section, saved where it is now (its place, visibility and facts as they are now). */
  const applySection = (id: string, next: SalesSection) => applySalesSection(projectId, id, next);

  /** An AI edit made from `base`, saved over the page as it is now (see applySalesPageEdit). False when it changed nothing. */
  const applyPageEdit = (next: SalesPage, base: SalesPage, added: PromptImage[] = []): boolean => !!applySalesPageEdit(projectId, next, base, added);

  // Get the page's images ready as data in the background, so Copy HTML is quick.
  const shownKey = page ? shownPromptImages(page, images).map((i) => i.media.id).join(',') : '';
  useEffect(() => {
    const m = current();
    if (shownKey && m.salesPage) void imageDataUrls(shownPromptImages(m.salesPage, m.seoImages ?? []));
  }, [shownKey]);

  const running = metaAI.running || pageAI.running;
  const last = pageAI.result ?? metaAI.result;
  const heroMedia = images.find((i) => i.media.id === heroImageId(page))?.media;
  // the chosen type can't be written yet: a checkout page needs the owner's payment link first
  const blocked = missingLink(project, choice) === 'payment';
  const formShown = !!page?.sections.some((s) => s.type === 'leadForm' && s.visible);
  const formNote = __ARTIFACT_BUILD__
    ? 'Nothing was sent: this is a preview. Forms work on pages published from the app’s own site.'
    : published
      ? 'Nothing was sent: this is a preview. On your published page, this form sends to Email → Leads.'
      : 'Nothing was sent: this is a preview. Publish this page to collect leads.';
  /** What the owner should know about the page's buttons and form: the first that applies. */
  const note: { kind: 'warn' | 'info'; text: string; leads?: boolean; link?: 'booking' | 'payment' } | null = !page
    ? null
    : type === 'checkout' && !paymentLink(project)
      ? { kind: 'warn', text: 'Buy now doesn’t open anything yet: add your payment link under Page type.', link: 'payment' }
      : type === 'booking' && !bookingLink(project)
        ? formShown
          ? { kind: 'info', text: 'No booking link yet: visitors send a request with the form instead. Add your booking link under Page type to let them book straight away.', link: 'booking' }
          : { kind: 'warn', text: 'No booking link yet, and the “Request a time” form is hidden: show it in Sections, or add your booking link under Page type.', link: 'booking' }
        : type === 'landing' && !ctaLink(project)
          ? { kind: 'info', text: 'The buttons don’t link anywhere yet. Add your buy or booking link in Studio › Publish, or your website in Settings.' }
          : !formShown
            ? null
            : __ARTIFACT_BUILD__
              ? { kind: 'info', text: 'Forms work on pages published from the app’s own site. In claude.ai, the form can’t send.' }
              : published
                ? { kind: 'info', text: 'What people send with the form arrives in Email → Leads.', leads: true }
                : access === 'off'
                  ? { kind: 'info', text: 'Forms send once the page is published, and publishing isn’t set up on this app’s server yet.' }
                  : { kind: 'info', text: 'The form starts collecting leads once you publish this page.' };

  const fileName = `${meta?.slug || slugify(project.brand.name) || 'sales-page'}.html`;
  const file = useSeoFile(projectId, fileName);
  const live = liveAddress(published);
  const hasPage = htmlMode || (!!page && !!meta);
  const menu: MenuEntry[] = [
    { label: 'Copy HTML', icon: <Copy />, onSelect: () => void file.copy() },
    { label: 'Export HTML', icon: <Download />, onSelect: () => void file.save() },
    ...(undoStack.length > 0 ? (['separator', { label: htmlMode ? 'Undo the last change' : 'Undo the last AI change', icon: <Undo2 />, onSelect: undo, disabled: busy }] as MenuEntry[]) : []),
  ];
  const publishLabel = published ? 'Update' : 'Publish';

  return (
    <div>
      <PageHeader
        title="SEO page"
        meta={
          hasPage ? (
            published ? (
              <>
                <StatusDot tone="good">Published</StatusDot>
                <a href={published.domainUrl ?? published.url} target="_blank" rel="noopener noreferrer" className="link inline-flex min-w-0 items-center gap-1 font-mono text-caption">
                  <span className="truncate">{live}</span>
                  <ExternalLink size={12} aria-hidden="true" className="shrink-0" />
                </a>
              </>
            ) : (
              <StatusDot tone="faint">Draft</StatusDot>
            )
          ) : undefined
        }
        actions={
          hasPage ? (
            <>
              {!htmlMode && (
                <GenerateButton size="sm" running={running} runningLabel="Rewriting…" disabled={busy} onClick={() => void generateAll()}>
                  Rewrite page
                </GenerateButton>
              )}
              {rail !== 'publish' && (
                <button type="button" className="btn btn-primary btn-sm max-sm:hidden" onClick={openPublish}>
                  {publishLabel}
                </button>
              )}
              <MoreMenu label="More page actions" items={menu} />
            </>
          ) : undefined
        }
      />

      {htmlMode ? (
        <SeoHtmlMode project={project} publishRef={publishRef} rail={rail} onRail={setRail} />
      ) : !page || !meta || !result ? (
        running ? (
          <WritingCanvas stage={pageAI.stage || metaAI.stage} onStop={() => (pageAI.running ? pageAI.stop() : metaAI.stop())} />
        ) : (
          <div className="mx-auto flex max-w-[920px] flex-col">
            {seoHtml && <SeoVersionSwitch project={project} className="mb-6" />}
            <AgentBuildList target="seo" className="mb-6" />
            <Empty variant="ai" title={`Write your ${PAGE_TYPE_LABEL[choice].toLowerCase()}`} body={`A page people find on Google that turns visits into ${project.track === 'business' ? 'bookings' : 'customers'}.`} className="pb-8 pt-8" />
            <div className="flex flex-col gap-6">
              <PageTypePicker value={choice} onChange={setChoice} disabled={busy} />
              {suggested && <p className="hint -mt-4">Suggested for you. You can pick another.</p>}
              <PageTypeLinks project={project} type={choice} />
              <GuideBox project={project} busy={busy} onImages={setImages} />
              <div className="flex flex-col items-center gap-3 pt-2">
                <GenerateButton variant="ai" size="lg" running={running} runningLabel="Writing…" disabled={busy || blocked} onClick={() => void generateAll(choice)}>
                  Write page
                </GenerateButton>
                {blocked && <p className="text-center text-caption text-muted">Add your payment link first. The app never takes payments: Buy now opens your own link.</p>}
                <AgentButtons target="seo" kind={choice} lead="or build it with" className="justify-center" />
              </div>
            </div>
          </div>
        )
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="scroll-thin flex min-w-0 flex-col gap-4 xl:sticky xl:top-4 xl:-m-1 xl:max-h-[calc(100dvh-104px)] xl:overflow-y-auto xl:p-1" aria-label="Page settings">
            <AgentBuildList target="seo" />
            {seoHtml && <SeoVersionSwitch project={project} />}
            <Accordion type="single" collapsible value={rail} onValueChange={(v) => setRail(v as RailPanel)} className="card px-4">
              <RailItem value="type" open={rail} title="Page type" summary={PAGE_TYPE_LABEL[type]}>
                <section aria-label="Page type" className="flex flex-col gap-3">
                  <p className="text-small text-ink-2">
                    <span className="font-medium text-ink">{PAGE_TYPE_LABEL[type]}.</span> {PAGE_TYPE_DESC[type]}
                  </p>
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs self-start"
                    aria-haspopup="dialog"
                    disabled={busy}
                    onClick={() => {
                      setChoice(type);
                      setTypeOpen(true);
                    }}
                  >
                    Change
                  </button>
                </section>
              </RailItem>
              {PAGE_TYPE_LINKS[type].length > 0 && (
                <RailItem value="links" open={rail} title={type === 'booking' ? 'Booking link' : type === 'checkout' ? 'Payment link' : 'Booking and payment links'} summary={linkSummary(project, type)}>
                  <PageTypeLinks project={project} type={type} />
                </RailItem>
              )}
              <RailItem value="score" open={rail} title="SEO score" summary={<span className="num font-mono">{result.score}</span>}>
                <ScoreSummary score={result.score} checks={result.checks} words={result.words} density={result.density} onChecks={() => setChecksOpen(true)} />
              </RailItem>
              <RailItem value="publish" open={rail} title="Public page" summary={published ? 'Live' : 'Not published'}>
                <div className="rounded-md outline-none focus-visible:shadow-focus" ref={publishRef} tabIndex={-1}>
                  <PublishPanel
                    pageId={seoPageId(project)}
                    kind="seo"
                    title={meta.metaTitle}
                    defaultSlug={meta.slug}
                    published={published}
                    build={(target) => seoPublishBuild(projectNow(), target)}
                    onChange={(seoPublished) => save({ seoPublished })}
                    version={project.updatedAt}
                  />
                </div>
              </RailItem>
              <RailItem value="guide" open={rail} title="Guide the AI" summary={`${(project.marketing.seoGuide ?? '').trim() ? 'Guidance set' : 'No guidance'} · ${plural(images.length, 'image')}`}>
                <GuideBox project={project} busy={busy} onImages={setImages} compact>
                  {unplaced.length > 0 && (
                    <div className="well flex flex-wrap items-center gap-2 px-3 py-2 text-caption text-ink-2" role="status">
                      <span className="min-w-0 flex-1">Not on the page yet: {listJoin(unplaced.map((i) => `image ${imageKeyNumber(i.key)}`))}.</span>
                      <button type="button" className="btn btn-secondary btn-xs" onClick={addToPage} disabled={busy}>
                        <ImagePlus /> Add to the page
                      </button>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <GenerateButton running={running} runningLabel="Rewriting…" disabled={busy} onClick={() => void generateAll()} size="sm">
                      Rewrite page
                    </GenerateButton>
                    <InfoTip label="How Rewrite page works">Rewrite page uses your guidance and all these images. The built-in engine (used when no AI answers) can’t read guidance or see images, but it still puts your images on the page.</InfoTip>
                  </div>
                  <AgentButtons target="seo" rebuild kind={type} />
                </GuideBox>
              </RailItem>
              <RailItem value="meta" open={rail} title="Metadata" summary={<span className="num font-mono">{meta.metaTitle.length}/60</span>}>
                <MetaPanel project={project} meta={meta} setMeta={setMeta} onRegen={regenMeta} running={metaAI.running} disabled={busy} heroMedia={heroMedia} published={published} />
              </RailItem>
              <RailItem value="sections" open={rail} title="Sections" summary={`${page.sections.filter((s) => s.visible).length} shown`} last>
                <SectionsPanel page={page} setPage={setPage} ai={sectionAI} busy={busy} onRewritten={applySection} pageType={type} />
              </RailItem>
            </Accordion>
          </aside>

          <section className="flex min-w-0 flex-col gap-3" aria-label="Visual page editor">
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                size="sm"
                value={editing ? 'edit' : 'view'}
                onChange={(v) => setEditing(v === 'edit')}
                options={[
                  { id: 'edit', label: 'Edit', icon: <PenLine /> },
                  { id: 'view', label: 'Preview', icon: <Eye /> },
                ]}
              />
              <Segmented
                size="sm"
                value={device}
                onChange={setDevice}
                options={[
                  { id: 'desktop', label: 'Desktop', icon: <Monitor /> },
                  { id: 'mobile', label: 'Mobile', icon: <Smartphone /> },
                ]}
              />
              {editing && <InfoTip label="How editing works">Click any text on the page to edit it. Changes save automatically and update your SEO score.</InfoTip>}
              <span className="mx-1 h-5 w-px bg-line max-lg:hidden" aria-hidden="true" />
              <ThemeControls theme={page.theme} onChange={(theme) => setPage((p) => ({ ...p, theme }))} />
            </div>
            <AIThinking running={running} stage={pageAI.stage || metaAI.stage} onStop={() => (pageAI.running ? pageAI.stop() : metaAI.stop())} />
            {last && !running && <AIResultBar provider={last.provider} skills={last.skills} ms={last.ms} note={last.note} logId={pageAI.logId ?? metaAI.logId} />}
            {toReview > 0 ? (
              <Callout tone="warn">
                Check the {toReview === 1 ? 'item' : `${toReview} items`} marked on the page: testimonials, facts or an earlier price that may have been written by AI. They stay off your exported page until you confirm they’re real.
              </Callout>
            ) : note ? (
              <Callout
                tone={note.kind}
                action={
                  note.leads ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      onClick={() => {
                        // the Leads tab is Email's own: until it's there, the request is ignored and Email opens as it was
                        useUI.getState().requestTab('marketing-email', 'leads');
                        void navigate('marketing-email');
                      }}
                    >
                      Open Leads
                    </button>
                  ) : note.link ? (
                    <button type="button" className="btn btn-secondary btn-xs" onClick={() => setRail('links')}>
                      {note.link === 'payment' ? 'Add payment link' : 'Add booking link'}
                    </button>
                  ) : undefined
                }
              >
                {note.text}
              </Callout>
            ) : null}
            <div className="well relative flex flex-col items-center p-3 sm:p-6">
              <BrowserFrame url={live || undefined} className={cn('w-full', device === 'mobile' && 'max-w-[392px]')}>
                <SalesPreview
                  page={page}
                  brand={project.brand}
                  business={project.track === 'business'}
                  editing={editing}
                  device={device}
                  images={images}
                  pageType={type}
                  targets={pageTargets(page, project)}
                  formNote={formNote}
                  onData={(id, data) => setPage((p) => ({ ...p, sections: p.sections.map((s) => (s.id === id ? ({ ...s, data } as SalesSection) : s)) }))}
                />
              </BrowserFrame>
              <EditPanel project={project} page={page} ai={editAI} busy={busy} undoCount={undoStack.length} onUndo={undo} onApply={applyPageEdit} pageType={type} />
            </div>
            <SourcePanel project={project} file={file} images={pageImageIds(page).length > 0} />
          </section>
        </div>
      )}

      {/* the page type, changed in a window: the AI writes the page again for the new type */}
      {page && meta && !htmlMode && (
        <Modal
          open={typeOpen}
          onClose={() => {
            setTypeOpen(false);
            setSuggested(null);
          }}
          size="lg"
          title="Change the page type"
          subtitle="The AI writes your page again for the new type. You can undo it."
          footer={
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setTypeOpen(false);
                  setSuggested(null);
                }}
              >
                Cancel
              </button>
              <GenerateButton variant="ai" running={pageAI.running} runningLabel="Rewriting…" disabled={busy || choice === type || blocked} onClick={() => void switchType(choice)}>
                Rewrite as {PAGE_TYPE_LABEL[choice].toLowerCase()}
              </GenerateButton>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            {suggested && (
              <Callout tone="info">{suggested === type ? `Your page is already ${pageTypeNoun(type)}.` : `Suggested for you: ${PAGE_TYPE_LABEL[suggested]}. You can pick another.`}</Callout>
            )}
            <PageTypePicker value={choice} onChange={setChoice} disabled={busy} />
            <PageTypeLinks project={project} type={choice} />
          </div>
        </Modal>
      )}

      {result && !htmlMode && (
        <Drawer open={checksOpen} onClose={() => setChecksOpen(false)} title="SEO checklist">
          <Checklist checks={result.checks} />
        </Drawer>
      )}

      {hasPage && phone && (
        <div className="sm:hidden">
          <StickyActionBar>
            <button type="button" className="btn btn-primary" onClick={openPublish}>
              {publishLabel}
            </button>
          </StickyActionBar>
        </div>
      )}
    </div>
  );
}

/** What the links panel holds, in a word or two. */
function linkSummary(project: Project, type: PageType): string {
  const need = PAGE_TYPE_LINKS[type];
  const have = need.filter((k) => (k === 'booking' ? bookingLink(project) : paymentLink(project)));
  if (have.length === need.length) return 'Added';
  return have.length ? 'One added' : 'Not added';
}

/** One panel of the left column: its name and a one-line summary, then what it holds (kept in the page, hidden when closed). */
export function RailItem({ value, open, title, summary, children, last }: { value: Exclude<RailPanel, ''>; open: RailPanel; title: ReactNode; summary?: ReactNode; children: ReactNode; last?: boolean }) {
  return (
    <AccordionItem value={value} data-item={value} className={cn(last && 'border-b-0')}>
      <AccordionTrigger className="py-3.5">
        <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
          <span>{title}</span>
          {summary && <span className="min-w-0 truncate text-small font-normal text-muted">{summary}</span>}
        </span>
      </AccordionTrigger>
      {/* kept mounted when closed, so a panel keeps what you typed (and the publish panel its state) */}
      <AccordionContent forceMount hidden={open !== value} className="pb-5">
        {children}
      </AccordionContent>
    </AccordionItem>
  );
}

/** The SEO score in the left column: the number and its word, the ring, and the checklist. */
export function ScoreSummary({ score, checks, words, density, onChecks }: { score: number; checks: { pass: boolean }[]; words: number; density: number; onChecks: () => void }) {
  const passed = checks.filter((c) => c.pass).length;
  return (
    <section aria-label="SEO score" className="flex items-center gap-3">
      <ProgressRing value={score / 100} size={28} stroke={3} label={<span className="sr-only">{score}</span>} />
      <div className="min-w-0 flex-1">
        <p className="num text-h3 text-ink">
          {score} · {scoreWord(score)}
        </p>
        <p className="num text-caption text-muted">
          {words.toLocaleString()} words · keyword {(density * 100).toFixed(1)}% ·{' '}
          <button type="button" className="link text-caption" onClick={onChecks}>
            {passed} of {checks.length} checks
          </button>
        </p>
      </div>
    </section>
  );
}

/** Each check, with what to do when it doesn't pass yet (the checklist's side sheet). */
export function Checklist({ checks }: { checks: SeoCheck[] }) {
  return (
    <ul className="flex flex-col gap-4" aria-label="SEO checklist">
      {checks.map((c) => (
        <li key={c.id} className="flex gap-3 text-small">
          <span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full', c.pass ? 'bg-good-soft text-good' : c.partial ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad')}>
            {c.pass ? <Check size={12} aria-label="Done" /> : c.partial ? <CircleDashed size={12} aria-label="Partly" /> : <X size={12} aria-label="Not yet" />}
          </span>
          <span className="min-w-0">
            <span className="block text-ui text-ink">{c.label}</span>
            {!c.pass && <span className="mt-0.5 block text-small text-muted">{c.tip}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** While the page is first written: the thinking strip where the page will appear, over AI skeletons. */
function WritingCanvas({ stage, onStop }: { stage: string; onStop: () => void }) {
  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
      <div className="card flex flex-col gap-3 p-4 max-xl:hidden" aria-hidden="true">
        {[60, 80, 70, 50, 75].map((w) => (
          <Skeleton key={w} className="h-4" ai />
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <AIThinking running stage={stage} onStop={onStop} />
        <div className="well p-3 sm:p-6">
          <BrowserFrame>
            <div className="flex flex-col gap-4 p-8" aria-hidden="true">
              <Skeleton className="h-3 w-28" ai />
              <Skeleton className="h-9 w-3/4" ai />
              <Skeleton className="h-4 w-2/3" ai />
              <Skeleton className="h-11 w-40" ai />
              <div className="mt-6 grid grid-cols-3 gap-4">
                <Skeleton className="h-28" ai />
                <Skeleton className="h-28" ai />
                <Skeleton className="h-28" ai />
              </div>
            </div>
          </BrowserFrame>
        </div>
      </div>
    </div>
  );
}

/** Copy HTML and Export HTML: the page as one file, with its images inside it (prepared when you ask). */
export function useSeoFile(projectId: string, fileName: string) {
  const [busy, setBusy] = useState<null | 'copy' | 'export'>(null);
  const [copied, setCopied] = useState(false);
  const html = async (): Promise<string | null> => {
    const p = useStore.getState().projects.find((x) => x.id === projectId);
    if (!p) return null;
    const out = await seoFileHtml(p);
    if (out.missing.length) {
      const which = out.missing.length === 1 ? `Image ${out.missing[0]} couldn’t` : `Images ${listJoin(out.missing.map(String))} couldn’t`;
      toast({ kind: 'info', title: `${which} be loaded`, body: 'It’s left out of the file. If you added it on another device, it may still be uploading: try again in a minute.' });
    }
    return out.html;
  };
  const copy = async () => {
    setBusy('copy');
    try {
      const h = await html();
      if (h === null) return;
      if (await copyText(h)) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
        toast({ kind: 'success', title: 'HTML copied', body: 'The whole page, with its images inside it.' });
      } else toast({ kind: 'error', title: 'Copy was blocked', body: 'Use Export HTML instead, or try again.' });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('export');
    try {
      const h = await html();
      if (h !== null) await download(fileName, h);
    } finally {
      setBusy(null);
    }
  };
  return { busy, copied, copy, save };
}

/** The page's HTML, to read or take elsewhere: Copy HTML and Export HTML put the images in the file. */
export function SourcePanel({ project, file, images, note }: { project: Project; file: ReturnType<typeof useSeoFile>; images: boolean; note?: string }) {
  return (
    <details className="group rounded-lg border border-line">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="text-ui text-ink">HTML source</span>
        <span className="min-w-0 flex-1 truncate text-small text-muted">{note ?? 'A standalone page with meta tags, OpenGraph and JSON-LD'}</span>
        <ArrowDown size={16} className="shrink-0 text-muted transition-transform duration-180 group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="flex flex-col gap-3 border-t border-line px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void file.copy()} disabled={!!file.busy}>
            {file.busy === 'copy' ? <Spinner size={16} /> : file.copied ? <Check className="text-good" /> : <Copy />}
            {file.copied ? 'Copied' : 'Copy HTML'}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void file.save()} disabled={!!file.busy}>
            {file.busy === 'export' ? <Spinner size={16} /> : <Download />} Export HTML
          </button>
          {images && <p className="min-w-0 flex-1 text-caption text-muted">Images show here as short placeholders, like {'{{img-1}}'}. Copy HTML and Export HTML put the images themselves into the file.</p>}
        </div>
        <pre className="well scroll-thin max-h-[360px] overflow-auto p-3 font-mono text-caption text-ink-2">{seoSourceHtml(project)}</pre>
      </div>
    </details>
  );
}

/**
 * The owner's standing guidance for the AI and the page's images (the prompt box used each time the
 * page or its metadata is written). Images can also be pasted or dropped on the text box.
 */
function GuideBox({ project, busy, onImages, children, compact }: { project: Project; busy: boolean; onImages: (images: PromptImage[]) => void; children?: ReactNode; compact?: boolean }) {
  const updateMarketing = useStore((s) => s.updateMarketing);
  const guide = project.marketing.seoGuide ?? '';
  const images = project.marketing.seoImages ?? NO_IMAGES;
  const mark = project.marketing.seoImageMax ?? 0;
  const reserved = mark ? [`img-${mark}`] : [];
  const [adding, setAdding] = useState(false);
  const addSaved = (media: MediaRef[]) => {
    // saving takes a moment: add to the page's images as they are by then
    const cur = useStore.getState().projects.find((p) => p.id === project.id)?.marketing.seoImages ?? [];
    const plan = planPromptImages(cur, media, { reserved });
    reportRefusals(plan.refused);
    // these were just saved: don't keep the ones that couldn't be added
    for (const m of media) if (!plan.added.some((a) => a.media.id === m.id)) void deleteBlob(m.id);
    if (plan.added.length) onImages(plan.images);
  };
  const paste = usePasteImages(addSaved, { room: MAX_PROMPT_IMAGES - images.length, disabled: busy, onBusy: setAdding });
  return (
    <div className={cn('flex flex-col', compact ? 'gap-3' : 'gap-5')}>
      <Field label="Guide the AI" htmlFor="seo-guide" hint={compact ? undefined : 'Who the page is for, what to stress and how it should sound. You can paste or drop images here too.'}>
        <AutoTextarea
          id="seo-guide"
          value={guide}
          onChange={(v) => updateMarketing({ seoGuide: v })}
          minRows={3}
          maxLength={2000}
          placeholder="For example: plain, friendly words. Speak to first-time customers. Mention that we serve the whole city."
          disabled={busy}
          {...paste}
        />
      </Field>
      <PromptImages
        images={images}
        onChange={onImages}
        reserved={reserved}
        busy={adding}
        disabled={busy}
        label="Images for the page"
        hint="The first goes beside the headline, the others in a photo gallery. A note helps the AI describe each one."
      />
      {children}
    </div>
  );
}

const EDIT_IDEAS = ['Make the headline shorter', 'Use simpler words', 'Try a dark look', 'Shorten the FAQ answers', 'Say we take walk-ins', 'Mention parking'];
/** What an edit with only new images asks for. */
const IMAGES_ONLY = 'Put the new images on the page where they fit best.';

/**
 * "Edit with AI": a change in the owner's own words, to the whole page or one section, optionally with new
 * images. It starts from the page as it is: if the AI can't answer, nothing changes. Docked at the bottom
 * of the canvas while you scroll the page.
 */
function EditPanel({
  project,
  page,
  ai,
  busy,
  undoCount,
  onUndo,
  onApply,
  pageType,
}: {
  project: Project;
  page: SalesPage;
  ai: AIHook<SalesEditInput, SalesEditResult>;
  busy: boolean;
  undoCount: number;
  onUndo: () => void;
  onApply: (next: SalesPage, base: SalesPage, added?: PromptImage[]) => boolean;
  /** the page's type (the AI is told what kind of page it edits) */
  pageType: PageType;
}) {
  const ids = useId();
  const images = project.marketing.seoImages ?? NO_IMAGES;
  const [instruction, setInstruction] = useState('');
  const [target, setTarget] = useState('');
  const [pending, setPending] = useState<PromptImage[]>([]);
  const [outcome, setOutcome] = useState<{ kind: 'done' | 'same' | 'nothing'; text: string } | null>(null);
  const targetSection = page.sections.find((s) => s.id === target);
  const takesImages = !targetSection || targetSection.type === 'hero' || targetSection.type === 'gallery';
  const room = Math.max(0, MAX_PROMPT_IMAGES - images.length);
  const mark = project.marketing.seoImageMax ?? 0;
  // a new image never takes the number of one the page has (or had)
  const reserved = [...images.map((i) => i.key), ...(mark ? [`img-${mark}`] : [])];
  /** New images for this change, numbered after the page's own; with no words yet, the request says where they go. */
  const setNewImages = (next: PromptImage[]) => {
    const out: PromptImage[] = [];
    for (const img of next) {
      const clash = reserved.includes(img.key) || out.some((o) => o.key === img.key);
      out.push(clash ? { ...img, key: nextImageKey([...out, ...next], reserved) } : img);
    }
    if (out.length > pending.length && !instruction.trim()) setInstruction(IMAGES_ONLY);
    setPending(out);
  };
  const use = takesImages ? pending : [];

  const apply = async () => {
    if ((!instruction.trim() && !use.length) || busy) return;
    const m = useStore.getState().projects.find((p) => p.id === project.id)?.marketing;
    const base = m?.salesPage;
    if (!m || !base) return;
    setOutcome(null);
    const joined = joinImages(m.seoImages ?? [], use, m.seoImageMax);
    const r = await ai.run({
      page: base,
      instruction: instruction.trim() || IMAGES_ONLY,
      images: joined.images,
      newImages: joined.added.map((i) => i.key),
      ...(targetSection ? { sectionId: targetSection.id } : {}),
      ...(m.seo?.primaryKeyword ? { primaryKeyword: m.seo.primaryKeyword } : {}),
      pageType,
    });
    if (!r) return;
    if (!r.edited) {
      setOutcome({ kind: 'nothing', text: 'Nothing changed: only the AI can make this change. Your request is still here, so you can try again.' });
      return;
    }
    if (onApply(r.page, base, joined.added)) {
      setInstruction('');
      setPending([]);
      setOutcome({ kind: 'done', text: r.summary });
    } else setOutcome({ kind: 'same', text: r.summary });
  };

  return (
    <section className="sticky bottom-0 z-10 -mx-3 -mb-3 mt-4 w-[calc(100%+24px)] bg-gradient-to-t from-surface-2 from-70% to-transparent px-3 pb-3 pt-6 sm:-mx-6 sm:-mb-6 sm:w-[calc(100%+48px)] sm:px-6 sm:pb-6" aria-label="Edit with AI">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-2">
        <AIThinking running={ai.running} stage={ai.stage} onStop={ai.stop} compact />
        {outcome && !ai.running && (
          <p className={cn('flex flex-wrap items-center gap-x-2 text-caption', outcome.kind === 'done' ? 'text-good' : outcome.kind === 'nothing' ? 'text-warn' : 'text-ink-2')} role="status">
            {outcome.kind === 'done' && <Check size={14} aria-hidden="true" />}
            <span>{outcome.kind === 'done' ? outcome.text : outcome.kind === 'same' ? `Nothing on the page changed.${outcome.text !== AI_NO_CHANGE ? ` The AI said: “${outcome.text}”` : ''}` : outcome.text}</span>
          </p>
        )}
        {ai.error && <p className="text-caption text-bad">{ai.error}</p>}
        {ai.result && !ai.running && <AIResultBar provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
        <AIComposer
          id={`${ids}-text`}
          aria-label="Say what to change"
          value={instruction}
          onChange={setInstruction}
          onSubmit={() => void apply()}
          placeholder="Say what to change, e.g. “Make the headline shorter and say we work weekends.”"
          disabled={busy && !ai.running}
          running={ai.running}
          submitLabel="Apply"
          images={takesImages ? pending : undefined}
          onImagesChange={takesImages ? setNewImages : undefined}
          maxImages={Math.max(room, pending.length)}
          sticky
          scope={
            <>
              <label htmlFor={`${ids}-target`} className="sr-only">
                Change
              </label>
              <select id={`${ids}-target`} className="select input-sm w-auto max-w-[180px]" value={target} disabled={busy} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Whole page</option>
                {page.sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {SECTION_LABEL[s.type]}
                    {s.visible ? '' : ' (hidden)'}
                  </option>
                ))}
              </select>
            </>
          }
          info={
            <>
              {undoCount > 0 && (
                <Tooltip content="Undo the last AI change">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={onUndo} disabled={busy} aria-label={`Undo the last AI change (${undoCount} can be undone)`}>
                    <Undo2 /> Undo
                  </button>
                </Tooltip>
              )}
              <InfoTip label="About AI edits">
                The AI changes only what you ask, from the page as it is now. It never adds testimonials, numbers or guarantees: you add your real ones on the page.
                {room === 0 && ` Your page has ${MAX_PROMPT_IMAGES} images, the most it can have: remove one under Guide the AI to add another.`}
              </InfoTip>
            </>
          }
          suggestions={instruction.trim() ? undefined : EDIT_IDEAS}
          onSuggestion={setInstruction}
        />
        {!takesImages && pending.length > 0 && <p className="text-caption text-muted">Images can go in the hero, the gallery or anywhere on the whole page. Choose one of those to use your {plural(pending.length, 'new image')}.</p>}
      </div>
    </section>
  );
}

export function MetaPanel({ project, meta, setMeta, onRegen, running, disabled, heroMedia, published }: { project: Project; meta: SeoMeta; setMeta: (p: Partial<SeoMeta>) => void; onRegen: () => void; running: boolean; disabled?: boolean; heroMedia?: MediaRef; published?: Published }) {
  // The owner's own website only; until there is one, show a clear placeholder, never a guessed domain.
  const site = siteUrl(project);
  const domain = stripProtocol(site) || '[your website]';
  // once published (and the owner pasted no address of their own), search engines see the public address
  const live = published && !ownCanonical(project, meta) ? published.domainUrl ?? published.url : '';
  const crumb = live ? stripProtocol(live).replace(/\//g, ' › ') : `${domain} › ${meta.slug}`;
  const tLen = meta.metaTitle.length;
  const dLen = meta.metaDescription.length;
  const lenHint = (n: number, lo: number, hi: number) => <span className={cn('num font-mono', n >= lo && n <= hi ? 'text-good' : n > hi ? 'text-bad' : 'text-warn')}>{n}/{hi}</span>;
  return (
    <section className="flex flex-col gap-4" aria-label="SEO metadata">
      <div className="flex items-center justify-between gap-2">
        <p className="text-small text-muted">What search engines and shared links show.</p>
        <GenerateButton variant="ai-ghost" size="sm" running={running} runningLabel="Writing…" disabled={disabled} onClick={onRegen} icon={<RefreshCw />}>
          Regenerate
        </GenerateButton>
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
        <AutoTextarea id="seo-desc" value={meta.metaDescription} onChange={(v) => setMeta({ metaDescription: v })} minRows={3} />
      </Field>
      <Field label="URL slug" htmlFor="seo-slug" hint="For the page on your own website. The public address you publish it at is set in Public page.">
        <div className="flex h-9 items-center overflow-hidden rounded-md border border-line-2 bg-surface transition-[border-color,box-shadow] duration-120 focus-within:border-ring focus-within:shadow-focus dark:bg-surface-2 max-sm:h-11">
          <span className="flex h-full max-w-[55%] items-center truncate border-r border-line bg-surface-2 px-2.5 font-mono text-caption text-muted">{domain}/</span>
          <input
            id="seo-slug"
            className="h-full min-w-0 flex-1 bg-transparent px-2.5 font-mono text-small text-ink outline-none"
            value={meta.slug}
            onChange={(e) => {
              const slug = e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
              setMeta({ slug, canonical: canonicalForSlugChange(project, meta.canonical, meta.slug, slug) });
            }}
          />
        </div>
      </Field>

      <div>
        <p className="label">Google preview</p>
        {/* as Google shows it: Google's own colours in both themes */}
        <div className="rounded-pop border border-line p-3 text-left" style={{ background: '#ffffff', fontFamily: 'Arial, sans-serif' }}>
          <p className="truncate text-caption" style={{ color: '#202124' }}>
            {crumb}
          </p>
          <p className="mt-0.5 text-h3" style={{ color: '#1a0dab', fontWeight: 400 }}>
            {truncate(meta.metaTitle, 62)}
          </p>
          <p className="mt-0.5 text-small" style={{ color: '#4d5156' }}>
            {truncate(meta.metaDescription, 160)}
          </p>
        </div>
      </div>

      <Field label="Social title (OpenGraph)" htmlFor="seo-ogt">
        <input id="seo-ogt" className="input" value={meta.ogTitle} onChange={(e) => setMeta({ ogTitle: e.target.value })} />
      </Field>
      <Field label="Social description" htmlFor="seo-ogd">
        <AutoTextarea id="seo-ogd" value={meta.ogDescription} onChange={(v) => setMeta({ ogDescription: v })} minRows={2} />
      </Field>
      <Field label="Share image alt text" htmlFor="seo-alt" hint={heroMedia ? 'Says what your page’s main image shows. Shared links show that image once the page is published.' : undefined}>
        <input id="seo-alt" className="input" value={meta.ogImageAlt} onChange={(e) => setMeta({ ogImageAlt: e.target.value })} />
      </Field>
      <div>
        <p className="label">Link preview</p>
        <div className="overflow-hidden rounded-pop border border-line bg-surface">
          {heroMedia ? <ShareImage media={heroMedia} alt={meta.ogImageAlt} /> : <BrandBanner brand={project.brand} rounded={false} className="aspect-[1.91/1] w-full" />}
          <div className="border-t border-line px-3 py-2">
            <p className="truncate text-caption text-muted">{live ? stripProtocol(live).split('/')[0] : domain}</p>
            <p className="truncate text-small font-medium text-ink">{meta.ogTitle}</p>
            <p className="clamp-2 text-caption text-muted">{meta.ogDescription}</p>
          </div>
        </div>
      </div>
      <Field
        label="Canonical URL"
        htmlFor="seo-can"
        hint={
          live
            ? `Your published page gives search engines ${live} as its address. To use a different one, paste it here.`
            : meta.canonical.trim()
              ? undefined
              : 'Where will this page live? Paste its full address, or add your website in Settings. Until then the export leaves it out.'
        }
      >
        <input id="seo-can" className="input font-mono" value={meta.canonical} onChange={(e) => setMeta({ canonical: e.target.value.trim() })} placeholder="https://" />
      </Field>
    </section>
  );
}

/** The page's main image as a link preview shows it. */
function ShareImage({ media, alt }: { media: MediaRef; alt: string }) {
  const url = useMediaUrl(media);
  return url ? <img src={url} alt={alt} className="aspect-[1.91/1] w-full object-cover" /> : <div className="aspect-[1.91/1] w-full animate-pulse bg-surface-2" aria-hidden="true" />;
}

/**
 * Show, hide, move and rewrite sections. "Rewrite with AI" asks what should change (optional): with a
 * request the AI changes just that, from the section as it is; without one it gives a fresh take.
 */
function SectionsPanel({
  page,
  setPage,
  ai,
  busy,
  onRewritten,
  pageType,
}: {
  page: SalesPage;
  setPage: (fn: (p: SalesPage) => SalesPage) => void;
  ai: AIHook<SalesSectionInput, SalesSection>;
  busy: boolean;
  onRewritten: (id: string, next: SalesSection) => void;
  /** the page's type (a fresh take is written for it) */
  pageType: PageType;
}) {
  const ids = useId();
  const [open, setOpen] = useState<string | null>(null);
  const [ask, setAsk] = useState('');
  const [working, setWorking] = useState<string | null>(null);
  const [unchanged, setUnchanged] = useState<string | null>(null);
  const close = () => {
    setOpen(null);
    setAsk('');
    setUnchanged(null);
  };
  const toggle = (id: string) => {
    if (open === id) return close();
    setOpen(id);
    setAsk('');
    setUnchanged(null);
  };
  const rewrite = async (s: SalesSection) => {
    const instruction = ask.trim();
    setWorking(s.id);
    setUnchanged(null);
    const r = await ai.run({ type: s.type, current: s, ...(instruction ? { instruction } : {}), pageType });
    setWorking(null);
    if (!r) return;
    const next = { ...r, id: s.id, visible: s.visible } as SalesSection;
    // a request only the AI can follow: when it didn't answer, the section comes back as it was
    if (instruction && JSON.stringify(next.data) === JSON.stringify(s.data)) {
      setUnchanged(s.id);
      return;
    }
    onRewritten(s.id, next);
    close();
  };
  return (
    <section aria-label="Page sections">
      <ul className="-mx-1 flex flex-col">
        {page.sections.map((s, i) => {
          const label = SECTION_LABEL[s.type];
          const formId = `${ids}-${s.id}`;
          return (
            <li key={s.id} className="rounded-pop">
              <div className="flex h-10 items-center gap-1 px-1">
                <span className="num w-5 shrink-0 font-mono text-caption text-muted">{i + 1}</span>
                <span className={cn('min-w-0 flex-1 truncate text-ui', s.visible ? 'text-ink' : 'text-faint')}>{label}</span>
                <Tooltip content="Rewrite with AI">
                  <button type="button" className={cn('btn btn-ghost btn-icon btn-xs', open === s.id && 'bg-surface-3')} onClick={() => toggle(s.id)} disabled={busy} aria-label={`Rewrite ${label} with AI`} aria-expanded={open === s.id} aria-controls={formId}>
                    {working === s.id ? <Spinner size={14} /> : <Spark size={14} />}
                  </button>
                </Tooltip>
                <Tooltip content={s.visible ? 'Hide' : 'Show'}>
                  <button type="button" className="btn btn-ghost btn-icon btn-xs" onClick={() => setPage((p) => ({ ...p, sections: p.sections.map((x) => (x.id === s.id ? { ...x, visible: !x.visible } : x)) }))} aria-label={s.visible ? `Hide ${label}` : `Show ${label}`} aria-pressed={!s.visible}>
                    {s.visible ? <Eye /> : <EyeOff />}
                  </button>
                </Tooltip>
                <button type="button" className="btn btn-ghost btn-icon btn-xs" disabled={i === 0} onClick={() => setPage((p) => ({ ...p, sections: moveItem(p.sections, i, i - 1) }))} aria-label={`Move ${label} up`}>
                  <ArrowUp />
                </button>
                <button type="button" className="btn btn-ghost btn-icon btn-xs" disabled={i === page.sections.length - 1} onClick={() => setPage((p) => ({ ...p, sections: moveItem(p.sections, i, i + 1) }))} aria-label={`Move ${label} down`}>
                  <ArrowDown />
                </button>
              </div>
              {open === s.id && (
                <form
                  id={formId}
                  className="well mx-1 mb-2 flex flex-col gap-2 p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!busy) void rewrite(s);
                  }}
                >
                  <label htmlFor={`${formId}-ask`} className="text-small font-medium text-ink-2">
                    What should change? (optional)
                  </label>
                  <input
                    id={`${formId}-ask`}
                    className="input input-sm"
                    value={ask}
                    maxLength={500}
                    autoFocus
                    disabled={busy}
                    placeholder="Leave empty for a fresh take"
                    onChange={(e) => setAsk(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') close();
                    }}
                  />
                  <div className="flex items-center gap-2">
                    <GenerateButton size="sm" running={working === s.id} runningLabel="Rewriting…" disabled={busy} onClick={() => void rewrite(s)}>
                      Rewrite
                    </GenerateButton>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={close} disabled={working === s.id}>
                      Cancel
                    </button>
                  </div>
                  {unchanged === s.id && (
                    <p className="text-caption text-warn" role="status">
                      Nothing changed: only the AI can make this change.{ai.result?.note ? ` ${ai.result.note}` : ''}
                    </p>
                  )}
                </form>
              )}
            </li>
          );
        })}
      </ul>
      {ai.error && <p className="mt-2 text-caption text-bad">{ai.error}</p>}
      {ai.result && !ai.running && <AIResultBar className="mt-2" provider={ai.result.provider} skills={ai.result.skills} note={ai.result.note} logId={ai.logId} />}
    </section>
  );
}

function ThemeControls({ theme, onChange }: { theme: SalesTheme; onChange: (t: SalesTheme) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select<SalesTheme['font']>
        size="sm"
        aria-label="Page font"
        className="w-[124px]"
        value={theme.font}
        onChange={(font) => onChange({ ...theme, font })}
        options={[
          { value: 'grotesk', label: 'Grotesk' },
          { value: 'sans', label: 'System sans' },
          { value: 'serif', label: 'Serif' },
        ]}
      />
      <Select<SalesTheme['radius']>
        size="sm"
        aria-label="Corner style"
        className="w-[140px]"
        value={theme.radius}
        onChange={(radius) => onChange({ ...theme, radius })}
        options={[
          { value: 'sharp', label: 'Sharp corners' },
          { value: 'soft', label: 'Soft corners' },
          { value: 'round', label: 'Round corners' },
        ]}
      />
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
