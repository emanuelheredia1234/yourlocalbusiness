import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Check, CircleDashed, Code2, Copy, Download, Eye, EyeOff, ImagePlus, Inbox, Link2, Monitor, PenLine, RefreshCw, Search, Smartphone, Sparkles, Undo2, Wand2, X } from 'lucide-react';
import type { MediaRef, PageType, Project, PromptImage, Published, SalesPage, SalesSection, SalesTheme, SeoMeta } from '@/lib/types';
import { cn, listJoin, moveItem, plural, slugify, stripProtocol, truncate } from '@/lib/utils';
import { claimsToReview, canonicalForSlugChange, ctaLink, ownCanonical, pageImageIds, pageTargets, placeNewImages, pruneImages, scoreSeo, SECTION_LABEL, sectionsKeptHidden, siteUrl } from '@/ai/local/seo';
import { AI_NO_CHANGE, salesPageEditTask, salesPageTask, salesSectionTask, seoMetaTask, type SalesEditInput, type SalesEditResult, type SalesSectionInput } from '@/ai/tasks';
import { applySalesPageEdit, applySalesSection, applySeoMeta, undoSeo, writeSeoPage, type SeoWriters } from '@/ai/seoBuilder';
import { useAI } from '@/ai/useAI';
import { copyText } from '@/lib/platform';
import { deleteBlob } from '@/lib/storage';
import { useMediaUrl } from '@/lib/media';
import { MAX_PROMPT_IMAGES, imageDataUrls, imageKeyNumber, planPromptImages, reportRefusals } from '@/lib/promptImages';
import { PAGE_TYPE_DESC, PAGE_TYPE_LABEL, bookingLink, missingLink, pageTypeNoun, pageTypeOf, paymentLink, sectionPlan } from '@/lib/pageTypes';
import { navigate } from '@/lib/router';
import { usePublishAccess } from '@/lib/publish';
import { getActiveProject, useActiveProject, useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { AIResultBar, AIThinking, GenerateButton } from '@/components/ai/AI';
import { PromptImages, usePasteImages } from '@/components/ai/PromptImages';
import { PublishPanel } from '@/components/publish/PublishPanel';
import { AutoTextarea, ChipInput, Empty, Field, ProgressRing, Segmented, Spinner, confirmAction } from '@/components/ui/primitives';
import { BrandBanner } from '@/components/brand/Logo';
import { download } from '@/components/ui/download';
import { MarketingHeader } from './MarketingNav';
import { PageTypeLinks, PageTypePicker } from './PageTypePicker';
import { SalesPreview } from './SalesPreview';
import { highestImageNumber, joinImages, seoFileHtml, seoPageId, seoPublishBuild, seoSourceHtml, shownPromptImages } from '@/lib/seoPage';
import { useSeoUndo, type SeoSnapshot } from '@/store/seoUndo';
import { AgentButtons } from '@/components/agents/AgentButtons';
import { AgentBuildList } from '@/components/agents/AgentBuildList';
import { SeoHtmlMode, SeoVersionSwitch } from './SeoHtmlMode';

type Marketing = Project['marketing'];
type AIHook<I, O> = ReturnType<typeof useAI<I, O>>;

const marketing = () => getActiveProject()!.marketing;
const NO_IMAGES: PromptImage[] = [];
const NO_UNDO: SeoSnapshot[] = [];

function scoreColor(score: number) {
  return score >= 80 ? 'rgb(var(--good))' : score >= 55 ? 'rgb(var(--warn))' : 'rgb(var(--bad))';
}

/** The media id of the hero's image, if it has one. */
function heroImageId(page: SalesPage | null | undefined): string | undefined {
  const hero = page?.sections.find((s) => s.type === 'hero');
  return hero?.type === 'hero' ? hero.data.imageId : undefined;
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
  const [editing, setEditing] = useState(true);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [panel, setPanel] = useState<'meta' | 'score' | 'sections'>('meta');
  // the page's type, and the one being chosen (before a page is written, or to change it)
  const type = pageTypeOf(project);
  const [choice, setChoice] = useState<PageType>(type);
  const [typeOpen, setTypeOpen] = useState(false);
  /** the type someone else suggested (the Strategy tab, the assistant), until the owner moves on */
  const [suggested, setSuggested] = useState<PageType | null>(null);
  const { access } = usePublishAccess();
  const ids = useId();
  const result = useMemo(() => (meta ? scoreSeo(meta, page, type) : null), [meta, page, type]);
  const toReview = claimsToReview(page);
  const busy = metaAI.running || pageAI.running || editAI.running || sectionAI.running;
  const projectId = project.id;
  // the page Manus or Viktor made is the one in use (HTML mode): shown, scored and published instead of the builder's
  const seoHtml = project.marketing.seoHtml;
  const htmlMode = !!seoHtml?.active && !!meta;

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
  // the Publish panel asked for from elsewhere (the assistant): brought into view and focused, once. Nothing is published by itself.
  const publishReq = useUI((s) => s.publishRequest);
  const publishRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (publishReq?.page !== 'seo') return;
    useUI.setState({ publishRequest: null });
    publishRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    publishRef.current?.focus({ preventScroll: true });
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
    if (undoSeo(projectId) === 'undone') toast({ kind: 'info', title: 'Undone', body: 'Your page is back to how it was before the last AI change.' });
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
  const published = project.marketing.seoPublished;
  const formShown = !!page?.sections.some((s) => s.type === 'leadForm' && s.visible);
  const formNote = __ARTIFACT_BUILD__
    ? 'Nothing was sent: this is a preview. Forms work on pages published from the app’s own site.'
    : published
      ? 'Nothing was sent: this is a preview. On your published page, this form sends to Email → Leads.'
      : 'Nothing was sent: this is a preview. Publish this page to collect leads.';
  /** What the owner should know about the page's buttons and form: the first that applies. */
  const note: { kind: 'warn' | 'info'; text: string; leads?: boolean } | null = !page
    ? null
    : type === 'checkout' && !paymentLink(project)
      ? { kind: 'warn', text: 'Buy now doesn’t open anything yet: add your payment link under Page type.' }
      : type === 'booking' && !bookingLink(project)
        ? formShown
          ? { kind: 'info', text: 'No booking link yet: visitors send a request with the form instead. Add your booking link under Page type to let them book straight away.' }
          : { kind: 'warn', text: 'No booking link yet, and the “Request a time” form is hidden: show it in Sections, or add your booking link under Page type.' }
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
                  : { kind: 'info', text: 'The form starts collecting leads once you publish this page (Public page, beside the score).' };

  return (
    <div className="flex flex-col gap-5">
      <MarketingHeader
        eyebrow="Marketing Hub · SEO"
        title="SEO page"
        desc="Pick the kind of page you need: a lead form, a booking page, a website, a landing page, a showcase or a checkout page. Edit it on the canvas or with AI, add your own photos, publish it at its own address, or export the HTML."
        actions={
          htmlMode && meta ? (
            <>
              <FileActions projectId={projectId} fileName={`${meta.slug || slugify(project.brand.name) || 'sales-page'}.html`} />
              {undoStack.length > 0 && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={undo} disabled={busy} title="Undo the last change" aria-label={`Undo the last change (${undoStack.length} can be undone)`}>
                  <Undo2 size={14} /> Undo
                </button>
              )}
            </>
          ) : page && meta ? (
            <>
              <FileActions projectId={projectId} fileName={`${meta.slug || slugify(project.brand.name) || 'sales-page'}.html`} />
              {undoStack.length > 0 && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={undo} disabled={busy} title="Undo the last AI change" aria-label={`Undo the last AI change (${undoStack.length} can be undone)`}>
                  <Undo2 size={14} /> Undo
                </button>
              )}
              <GenerateButton running={running} disabled={busy} onClick={() => void generateAll()} size="sm">
                Rewrite page
              </GenerateButton>
            </>
          ) : null
        }
      />
      <AIThinking running={running} stage={pageAI.stage || metaAI.stage} chars={pageAI.chars || metaAI.chars} onStop={() => (pageAI.running ? pageAI.stop() : metaAI.stop())} />
      {last && !running && !htmlMode && <AIResultBar provider={last.provider} skills={last.skills} ms={last.ms} note={last.note} logId={pageAI.logId ?? metaAI.logId} />}
      <AgentBuildList target="seo" />

      {htmlMode ? (
        <SeoHtmlMode project={project} publishRef={publishRef} />
      ) : !page && !running ? (
        <Empty
          icon={<Search size={20} />}
          title="Build your SEO page"
          body={`Choose the kind of page. The AI picks a buyer-intent keyword for ${project.brand.name}, writes the metadata and drafts the page. You add the real parts: customer testimonials, facts and any guarantee you offer.`}
          action={
            <div className="flex w-full max-w-3xl flex-col gap-4 text-left">
              {seoHtml && <SeoVersionSwitch project={project} />}
              <PageTypePicker value={choice} onChange={setChoice} disabled={busy} />
              {suggested && <p className="hint mt-0">Suggested for you. You can pick another.</p>}
              <PageTypeLinks project={project} type={choice} />
              <GuideBox project={project} busy={busy} onImages={setImages} />
              <GenerateButton running={running} disabled={busy || blocked} onClick={() => void generateAll(choice)} size="lg" className="self-center">
                Write page
              </GenerateButton>
              {blocked && <p className="-mt-2 text-center text-caption text-muted">Add your payment link first. The app never takes payments: Buy now opens your own link.</p>}
              <AgentButtons target="seo" kind={choice} lead="or build it with" className="justify-center" />
            </div>
          }
          className="min-h-[360px]"
        />
      ) : page && meta && result ? (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
          <aside className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-4 xl:max-h-[calc(100vh-120px)] xl:self-start xl:overflow-y-auto xl:pr-1 scroll-thin">
            {seoHtml && <SeoVersionSwitch project={project} />}
            <section className="panel flex items-center gap-4 p-4" aria-label="SEO score">
              <ProgressRing value={result.score / 100} size={64} stroke={6} color={scoreColor(result.score)} label={<span className="text-h3">{result.score}</span>} />
              <div className="min-w-0 flex-1">
                <p className="text-body font-semibold">SEO score {result.score >= 80 ? '· Great' : result.score >= 55 ? '· Getting there' : '· Needs work'}</p>
                <p className="num text-caption text-muted">
                  {result.words.toLocaleString()} words · keyword density {(result.density * 100).toFixed(1)}% · {result.checks.filter((c) => c.pass).length}/{result.checks.length} checks
                </p>
                <button className="link mt-1 text-caption" onClick={() => setPanel('score')}>
                  See the checklist →
                </button>
              </div>
            </section>

            <section className="panel p-4" aria-label="Page type">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-body font-semibold">Page type</h2>
                <span className="chip">{PAGE_TYPE_LABEL[type]}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs ml-auto"
                  aria-expanded={typeOpen}
                  aria-controls={`${ids}-type`}
                  disabled={busy && !typeOpen}
                  onClick={() => {
                    if (typeOpen) {
                      setTypeOpen(false);
                      setSuggested(null);
                    } else {
                      setChoice(type);
                      setTypeOpen(true);
                    }
                  }}
                >
                  Change
                </button>
              </div>
              <p className="mt-1 text-caption text-muted">{PAGE_TYPE_DESC[type]}</p>
              {!typeOpen && (type === 'booking' || type === 'showcase' || type === 'checkout') && (
                <div className="mt-3">
                  <PageTypeLinks project={project} type={type} />
                </div>
              )}
              {typeOpen && (
                <div id={`${ids}-type`} className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
                  {suggested && (
                    <p className="text-caption font-medium text-ink-2" role="status">
                      {suggested === type ? `Your page is already ${pageTypeNoun(type)}.` : `Suggested for you: ${PAGE_TYPE_LABEL[suggested]}. You can pick another.`}
                    </p>
                  )}
                  <PageTypePicker value={choice} onChange={setChoice} disabled={busy} compact />
                  <PageTypeLinks project={project} type={choice} />
                  <div className="flex flex-wrap items-center gap-2">
                    <GenerateButton running={pageAI.running} disabled={busy || choice === type || blocked} onClick={() => void switchType(choice)} size="sm">
                      Rewrite as {PAGE_TYPE_LABEL[choice].toLowerCase()}
                    </GenerateButton>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setTypeOpen(false);
                        setSuggested(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </section>

            <div className="panel p-4 outline-none focus:shadow-focus" ref={publishRef} tabIndex={-1}>
              <PublishPanel
                pageId={seoPageId(project)}
                kind="seo"
                title={meta.metaTitle}
                defaultSlug={meta.slug}
                published={project.marketing.seoPublished}
                build={(target) => seoPublishBuild(projectNow(), target)}
                onChange={(seoPublished) => save({ seoPublished })}
                version={project.updatedAt}
              />
            </div>

            <GuidePanel project={project} page={page} busy={busy} running={running} onImages={setImages} onAddToPage={addToPage} onRewrite={() => void generateAll()} />

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

            {panel === 'meta' && <MetaPanel project={project} meta={meta} setMeta={setMeta} onRegen={regenMeta} running={metaAI.running} disabled={busy} heroMedia={heroMedia} published={project.marketing.seoPublished} />}
            {panel === 'score' && (
              <section className="panel p-4" aria-label="SEO checklist">
                <ul className="flex flex-col gap-3">
                  {result.checks.map((c) => (
                    <li key={c.id} className="flex gap-2.5 text-small">
                      <span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full', c.pass ? 'bg-good-soft text-good' : c.partial ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad')}>
                        {c.pass ? <Check size={12} /> : c.partial ? <CircleDashed size={12} /> : <X size={12} />}
                      </span>
                      <span className="min-w-0">
                        <span className="font-semibold text-ink">{c.label}</span>
                        {!c.pass && <span className="block text-caption text-muted">{c.tip}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {panel === 'sections' && <SectionsPanel page={page} setPage={setPage} ai={sectionAI} busy={busy} onRewritten={applySection} pageType={type} />}
          </aside>

          <section className="flex min-w-0 flex-col gap-3" aria-label="Visual page editor">
            <EditPanel project={project} page={page} ai={editAI} busy={busy} canUndo={undoStack.length > 0} onUndo={undo} onApply={applyPageEdit} pageType={type} />
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
            {toReview > 0 && (
              <p className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-small text-warn">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>
                  Check the {toReview === 1 ? 'item' : `${toReview} items`} marked on the page: testimonials, facts or an earlier price that may have been written by AI. They stay off your exported page until you confirm they’re real.
                </span>
              </p>
            )}
            {note &&
              (note.kind === 'warn' ? (
                <p className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-small text-warn">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" /> <span>{note.text}</span>
                </p>
              ) : (
                <p className="flex flex-wrap items-start gap-x-2 gap-y-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-small text-ink-2">
                  {note.leads ? <Inbox size={15} className="mt-0.5 shrink-0 text-muted" /> : <Link2 size={15} className="mt-0.5 shrink-0 text-muted" />}
                  <span className="min-w-0 flex-1">{note.text}</span>
                  {note.leads && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        // the Leads tab is Email's own: until it's there, the request is ignored and Email opens as it was
                        useUI.getState().requestTab('marketing-email', 'leads');
                        void navigate('marketing-email');
                      }}
                    >
                      Open Leads
                    </button>
                  )}
                </p>
              ))}
            {editing && <p className="text-caption text-muted">Click any text on the page to edit it. Changes save automatically and update your SEO score.</p>}
            <div className="dotgrid flex justify-center overflow-x-auto rounded-lg bg-surface-2 p-3 sm:p-5">
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
            </div>
            <details className="panel group">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-small font-semibold">
                <Code2 size={15} className="text-primary" /> HTML source
                <span className="ml-auto text-caption font-normal text-muted">Standalone page with meta tags, OpenGraph and JSON-LD schema</span>
              </summary>
              {pageImageIds(page).length > 0 && <p className="border-t border-line px-4 py-2 text-caption text-muted">Images show here as short placeholders, like {'{{img-1}}'}. Copy HTML and Export HTML put the images themselves into the file.</p>}
              <pre className="max-h-[360px] overflow-auto border-t border-line bg-surface-2 p-3 font-mono text-caption leading-relaxed text-ink-2 scroll-thin">{seoSourceHtml(project)}</pre>
            </details>
          </section>
        </div>
      ) : null}
    </div>
  );
}

/** Copy HTML and Export HTML: the page as one file, with its images inside it (prepared when you click). */
export function FileActions({ projectId, fileName }: { projectId: string; fileName: string }) {
  const [busy, setBusy] = useState<null | 'copy' | 'export'>(null);
  const [copied, setCopied] = useState(false);
  const file = async (): Promise<string | null> => {
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
      const html = await file();
      if (html === null) return;
      if (await copyText(html)) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      } else toast({ kind: 'error', title: 'Copy was blocked', body: 'Use Export HTML instead, or try again.' });
    } finally {
      setBusy(null);
    }
  };
  const exportFile = async () => {
    setBusy('export');
    try {
      const html = await file();
      if (html !== null) await download(fileName, html);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copy()} disabled={!!busy}>
        {busy === 'copy' ? <Spinner size={14} /> : copied ? <Check size={14} className="text-good" /> : <Copy size={14} />}
        {copied ? 'Copied' : 'Copy HTML'}
      </button>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void exportFile()} disabled={!!busy}>
        {busy === 'export' ? <Spinner size={14} /> : <Download size={14} />} Export HTML
      </button>
    </>
  );
}

/**
 * The owner's standing guidance for the AI and the page's images (the prompt box used each time the
 * page or its metadata is written). Images can also be pasted or dropped on the text box.
 */
function GuideBox({ project, busy, onImages, children }: { project: Project; busy: boolean; onImages: (images: PromptImage[]) => void; children?: ReactNode }) {
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
    <div className="flex flex-col gap-3">
      <Field label="Guide the AI" htmlFor="seo-guide" hint="Who the page is for, what to stress and how it should sound. The AI follows it each time it writes the page or its metadata. You can paste or drop images here too.">
        <AutoTextarea
          id="seo-guide"
          value={guide}
          onChange={(v) => updateMarketing({ seoGuide: v })}
          minRows={3}
          maxLength={2000}
          placeholder="For example: plain, friendly words. Speak to first-time customers. Mention that we serve the whole city."
          className="text-small"
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
        hint="The AI puts each one on the page: the main image beside the headline, the others in a photo gallery. A note helps it describe the image well."
      />
      {children}
    </div>
  );
}

/** "Guide the AI" beside a page that exists: the guidance, the images (and which aren't on the page yet), Rewrite page. */
function GuidePanel({ project, page, busy, running, onImages, onAddToPage, onRewrite }: { project: Project; page: SalesPage; busy: boolean; running: boolean; onImages: (images: PromptImage[]) => void; onAddToPage: () => void; onRewrite: () => void }) {
  const images = project.marketing.seoImages ?? NO_IMAGES;
  const on = new Set(pageImageIds(page));
  const unplaced = images.filter((i) => i.media.kind === 'image' && !on.has(i.media.id));
  // open when there's something to act on; the owner opens or closes it after that
  const [open] = useState(() => unplaced.length > 0);
  const guide = (project.marketing.seoGuide ?? '').trim();
  return (
    <details className="panel group" open={open}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-small font-semibold">
        <Sparkles size={15} className="text-accent" /> Guide the AI
        <span className="ml-auto text-caption font-normal text-muted">
          {guide ? 'Guidance set' : 'No guidance'} · {plural(images.length, 'image')}
        </span>
      </summary>
      <div className="border-t border-line p-4">
        <GuideBox project={project} busy={busy} onImages={onImages}>
          {unplaced.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-caption text-ink-2" role="status">
              <span className="min-w-0 flex-1">Not on the page yet: {listJoin(unplaced.map((i) => `image ${imageKeyNumber(i.key)}`))}.</span>
              <button type="button" className="btn btn-secondary btn-xs" onClick={onAddToPage} disabled={busy}>
                <ImagePlus size={12} /> Add to the page
              </button>
            </div>
          )}
          <p className="text-caption text-muted">Rewrite page uses your guidance and all these images. The built-in engine (used when no AI answers) can’t read guidance or see images, but it still puts your images on the page.</p>
          <GenerateButton running={running} disabled={busy} onClick={onRewrite} size="sm" className="self-start">
            Rewrite page
          </GenerateButton>
          <AgentButtons target="seo" rebuild kind={pageTypeOf(project)} />
        </GuideBox>
      </div>
    </details>
  );
}

const EDIT_IDEAS = ['Make the headline shorter and clearer', 'Use simpler words everywhere', 'Switch to a dark look with round corners', 'Make the FAQ answers shorter'];

/**
 * "Edit with AI": a change in the owner's own words, to the whole page or one section, optionally with new
 * images. It starts from the page as it is: if the AI can't answer, nothing changes.
 */
function EditPanel({
  project,
  page,
  ai,
  busy,
  canUndo,
  onUndo,
  onApply,
  pageType,
}: {
  project: Project;
  page: SalesPage;
  ai: AIHook<SalesEditInput, SalesEditResult>;
  busy: boolean;
  canUndo: boolean;
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
  const [showImages, setShowImages] = useState(false);
  const [adding, setAdding] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: 'done' | 'same' | 'nothing'; text: string } | null>(null);
  const targetSection = page.sections.find((s) => s.id === target);
  const takesImages = !targetSection || targetSection.type === 'hero' || targetSection.type === 'gallery';
  const room = Math.max(0, MAX_PROMPT_IMAGES - images.length);
  const mark = project.marketing.seoImageMax ?? 0;
  // a new image never takes the number of one the page has (or had)
  const reserved = [...images.map((i) => i.key), ...(mark ? [`img-${mark}`] : [])];
  const addSaved = (media: MediaRef[]) => {
    const plan = planPromptImages(pending, media, { max: room, reserved });
    reportRefusals(plan.refused);
    for (const m of media) if (!plan.added.some((a) => a.media.id === m.id)) void deleteBlob(m.id);
    if (plan.added.length) {
      setPending(plan.images);
      setShowImages(true);
    }
  };
  const paste = usePasteImages(addSaved, { room: room - pending.length, disabled: busy || !takesImages, onBusy: setAdding });
  const use = takesImages ? pending : [];
  const ready = !!instruction.trim() || use.length > 0;

  const apply = async () => {
    if (!ready || busy) return;
    const m = useStore.getState().projects.find((p) => p.id === project.id)?.marketing;
    const base = m?.salesPage;
    if (!m || !base) return;
    setOutcome(null);
    const joined = joinImages(m.seoImages ?? [], use, m.seoImageMax);
    const r = await ai.run({
      page: base,
      instruction: instruction.trim() || 'Put the new images on the page where they fit best.',
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
      setShowImages(false);
      setOutcome({ kind: 'done', text: r.summary });
    } else setOutcome({ kind: 'same', text: r.summary });
  };

  return (
    <section className="panel p-3" aria-label="Edit with AI">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void apply();
        }}
      >
        <label htmlFor={`${ids}-text`} className="label flex items-center gap-1.5">
          <Wand2 size={14} className="text-primary" /> Edit with AI
        </label>
        <AutoTextarea
          id={`${ids}-text`}
          value={instruction}
          onChange={setInstruction}
          minRows={2}
          maxLength={1000}
          placeholder="Say what to change, e.g. “Make the headline shorter and say we work weekends.”"
          className="text-small"
          disabled={busy}
          aria-describedby={`${ids}-hint`}
          onKeyDown={(e) => {
            // Ctrl/⌘ + Enter applies, as in other prompt boxes
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void apply();
            }
          }}
          {...paste}
        />
        <p id={`${ids}-hint`} className="hint">
          The AI changes only what you ask, from the page as it is now. It never adds testimonials, numbers or guarantees: you add your real ones on the page.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label htmlFor={`${ids}-target`} className="text-caption font-semibold text-ink-2">
            Change
          </label>
          <select id={`${ids}-target`} className="select input-sm w-auto" value={target} disabled={busy} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Whole page</option>
            {page.sections.map((s) => (
              <option key={s.id} value={s.id}>
                {SECTION_LABEL[s.type]}
                {s.visible ? '' : ' (hidden)'}
              </option>
            ))}
          </select>
          {takesImages && (
            <button type="button" className="btn btn-secondary btn-sm" aria-expanded={showImages} aria-controls={`${ids}-images`} onClick={() => setShowImages((v) => !v)} disabled={busy}>
              <ImagePlus size={14} /> Images{pending.length ? ` (${pending.length})` : ''}
            </button>
          )}
          <button type="submit" className="btn btn-ai btn-sm ml-auto" disabled={busy || !ready}>
            {ai.running ? <Spinner size={14} /> : <Sparkles size={14} className="text-accent" />} Apply
          </button>
        </div>
        {takesImages && showImages && (
          <div id={`${ids}-images`} className="mt-3">
            {room > 0 ? (
              <PromptImages
                images={pending}
                onChange={setPending}
                max={room}
                reserved={reserved}
                busy={adding}
                disabled={busy}
                label="New images for this change"
                hint={`They go on the page with this change: say where in your request, or let the AI choose.${images.length ? ` Your page has ${plural(images.length, 'image')} already, and can have ${MAX_PROMPT_IMAGES} in all.` : ''}`}
              />
            ) : (
              <p className="hint mt-0">Your page has {MAX_PROMPT_IMAGES} images, the most it can have. Remove one under “Guide the AI” to add another.</p>
            )}
          </div>
        )}
        {!takesImages && pending.length > 0 && <p className="hint">Images can go in the hero, the gallery or anywhere on the whole page. Choose one of those to use your {plural(pending.length, 'new image')}.</p>}
      </form>
      <div className="mt-2 flex flex-wrap gap-1">
        {EDIT_IDEAS.map((idea) => (
          <button key={idea} type="button" className="chip text-caption" disabled={busy} onClick={() => setInstruction(idea)}>
            {idea}
          </button>
        ))}
      </div>
      <AIThinking running={ai.running} stage={ai.stage} chars={ai.chars} onStop={ai.stop} compact className="mt-2" />
      {outcome && !ai.running && (
        <p className={cn('mt-2 flex flex-wrap items-center gap-x-2 text-caption', outcome.kind === 'done' ? 'text-good' : outcome.kind === 'nothing' ? 'text-warn' : 'text-ink-2')} role="status">
          <span>{outcome.kind === 'done' ? `✓ ${outcome.text}` : outcome.kind === 'same' ? `Nothing on the page changed.${outcome.text !== AI_NO_CHANGE ? ` The AI said: “${outcome.text}”` : ''}` : outcome.text}</span>
          {outcome.kind === 'done' && canUndo && (
            <button type="button" className="link" onClick={onUndo}>
              Undo
            </button>
          )}
        </p>
      )}
      {ai.error && <p className="mt-2 text-caption text-bad">{ai.error}</p>}
      {ai.result && !ai.running && <AIResultBar className="mt-2" provider={ai.result.provider} skills={ai.result.skills} ms={ai.result.ms} note={ai.result.note} logId={ai.logId} />}
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
  const lenHint = (n: number, lo: number, hi: number) => <span className={n >= lo && n <= hi ? 'text-good' : n > hi ? 'text-bad' : 'text-warn'}>{n}/{hi}</span>;
  return (
    <section className="panel flex flex-col gap-3.5 p-4" aria-label="SEO metadata">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-body font-semibold">Metadata</h2>
        <button className="btn btn-ghost btn-xs" onClick={onRegen} disabled={running || disabled}>
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
        <AutoTextarea id="seo-desc" value={meta.metaDescription} onChange={(v) => setMeta({ metaDescription: v })} minRows={3} className="text-small" />
      </Field>
      <Field label="URL slug" htmlFor="seo-slug" hint="For the page on your own website. The public address you publish it at is set in Public page.">
        <div className="flex items-center rounded-md border border-line-2 bg-surface focus-within:border-primary focus-within:shadow-focus">
          <span className="truncate pl-3 text-small text-muted">{domain}/</span>
          <input
            id="seo-slug"
            className="min-w-0 flex-1 bg-transparent py-2 pr-3 text-small outline-none"
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
        <div className="rounded-md border border-line bg-white p-3 text-left" style={{ fontFamily: 'Arial, sans-serif' }}>
          <p className="truncate text-caption text-[#202124]">{crumb}</p>
          <p className="mt-0.5 text-h3 leading-snug text-[#1a0dab]">{truncate(meta.metaTitle, 62)}</p>
          <p className="mt-0.5 text-small leading-snug text-[#4d5156]">{truncate(meta.metaDescription, 160)}</p>
        </div>
      </div>

      <Field label="Social title (OpenGraph)" htmlFor="seo-ogt">
        <input id="seo-ogt" className="input" value={meta.ogTitle} onChange={(e) => setMeta({ ogTitle: e.target.value })} />
      </Field>
      <Field label="Social description" htmlFor="seo-ogd">
        <AutoTextarea id="seo-ogd" value={meta.ogDescription} onChange={(v) => setMeta({ ogDescription: v })} minRows={2} className="text-small" />
      </Field>
      <Field label="Share image alt text" htmlFor="seo-alt" hint={heroMedia ? 'Says what your page’s main image shows. Shared links show that image once the page is published.' : undefined}>
        <input id="seo-alt" className="input" value={meta.ogImageAlt} onChange={(e) => setMeta({ ogImageAlt: e.target.value })} />
      </Field>
      <div>
        <p className="label">Link preview</p>
        <div className="overflow-hidden rounded-md border border-line bg-surface">
          {heroMedia ? <ShareImage media={heroMedia} alt={meta.ogImageAlt} /> : <BrandBanner brand={project.brand} rounded={false} className="aspect-[1.91/1] w-full" />}
          <div className="border-t border-line px-3 py-2">
            <p className="text-caption uppercase tracking-wide text-muted">{live ? stripProtocol(live).split('/')[0] : domain}</p>
            <p className="truncate text-small font-semibold">{meta.ogTitle}</p>
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
        <input id="seo-can" className="input text-small" value={meta.canonical} onChange={(e) => setMeta({ canonical: e.target.value.trim() })} placeholder="https://" />
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
    <section className="panel overflow-hidden" aria-label="Page sections">
      <ul className="divide-y divide-line">
        {page.sections.map((s, i) => {
          const label = SECTION_LABEL[s.type];
          const formId = `${ids}-${s.id}`;
          return (
            <li key={s.id}>
              <div className={cn('flex items-center gap-2 px-3 py-2.5', !s.visible && 'opacity-60')}>
                <span className="num w-5 text-caption font-semibold text-muted">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-small font-semibold">{label}</span>
                <button
                  type="button"
                  className={cn('btn btn-ghost btn-icon btn-xs', open === s.id && 'bg-primary-soft')}
                  onClick={() => toggle(s.id)}
                  disabled={busy}
                  aria-label={`Rewrite ${label} with AI`}
                  aria-expanded={open === s.id}
                  aria-controls={formId}
                  title="Rewrite with AI"
                >
                  {working === s.id ? <Spinner size={13} /> : <RefreshCw size={13} className="text-primary" />}
                </button>
                <button className="btn btn-ghost btn-icon btn-xs" onClick={() => setPage((p) => ({ ...p, sections: p.sections.map((x) => (x.id === s.id ? { ...x, visible: !x.visible } : x)) }))} aria-label={s.visible ? `Hide ${label}` : `Show ${label}`} aria-pressed={!s.visible}>
                  {s.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
                <button className="btn btn-ghost btn-icon btn-xs" disabled={i === 0} onClick={() => setPage((p) => ({ ...p, sections: moveItem(p.sections, i, i - 1) }))} aria-label={`Move ${label} up`}>
                  <ArrowUp size={13} />
                </button>
                <button className="btn btn-ghost btn-icon btn-xs" disabled={i === page.sections.length - 1} onClick={() => setPage((p) => ({ ...p, sections: moveItem(p.sections, i, i + 1) }))} aria-label={`Move ${label} down`}>
                  <ArrowDown size={13} />
                </button>
              </div>
              {open === s.id && (
                <form
                  id={formId}
                  className="flex flex-col gap-2 bg-surface-2/60 px-3 pb-3 pt-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!busy) void rewrite(s);
                  }}
                >
                  <label htmlFor={`${formId}-ask`} className="text-caption font-semibold text-ink-2">
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
                    <button type="submit" className="btn btn-ai btn-sm" disabled={busy}>
                      {working === s.id ? <Spinner size={13} /> : <Sparkles size={13} className="text-accent" />} Rewrite
                    </button>
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
      {ai.error && <p className="px-3 pb-3 text-caption text-bad">{ai.error}</p>}
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
