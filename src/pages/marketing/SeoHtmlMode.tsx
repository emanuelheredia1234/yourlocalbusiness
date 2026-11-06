// The SEO page in HTML mode: a page Manus or Viktor made is the one shown, scored and published (at the same address
// as the builder's page), with the app's own metadata in its head and no JavaScript. The builder's page stays:
// Version switches between them (Undo too). The app can't check claims in free HTML, so a standing note asks the
// owner to check every claim, price and testimonial before publishing.

import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Inbox, Info, Trash2 } from 'lucide-react';
import type { Project, SeoMeta } from '@/lib/types';
import { cn, slugify } from '@/lib/utils';
import { scoreSeoHtml } from '@/ai/local/seo';
import { seoMetaTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { applySeoMeta, removeSeoHtml, saveSeo, setSeoHtmlActive } from '@/ai/seoBuilder';
import { PAGE_TYPE_DESC, PAGE_TYPE_LABEL, pageTypeOf } from '@/lib/pageTypes';
import { imageDataUrls } from '@/lib/promptImages';
import { seoHtmlDocument, seoHtmlShownImages } from '@/lib/seoHtml';
import { seoPageId, seoPublishBuild } from '@/lib/seoPage';
import { navigate } from '@/lib/router';
import { useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { PublishPanel } from '@/components/publish/PublishPanel';
import { Accordion, Callout, Drawer, Segmented, confirmAction } from '@/components/ui/primitives';
import { BrowserFrame } from '@/components/frames/Frames';
import { AgentButtons } from '@/components/agents/AgentButtons';
import { AgentBuildList } from '@/components/agents/AgentBuildList';
import { DeviceSwitch, SEO_SANDBOX } from '@/components/agents/HtmlPreview';
import { Checklist, MetaPanel, RailItem, ScoreSummary, SourcePanel, liveAddress, useSeoFile, type RailPanel } from './SeoSalesPage';
import { resolveBuyTokens } from '@/lib/buyLinks';

const AGENT_NAME = { manus: 'Manus', viktor: 'Viktor' } as const;
const FRAME_WIDTH = { desktop: '', tablet: 'max-w-[770px]', mobile: 'max-w-[392px]' } as const;

/** Use the builder's page or the agent's (each switch can be undone), and say so. */
function switchVersion(project: Project, active: boolean) {
  const h = project.marketing.seoHtml;
  if (!h || !setSeoHtmlActive(project.id, active)) return;
  const name = AGENT_NAME[h.source.via];
  const live = !!useStore.getState().projects.find((p) => p.id === project.id)?.marketing.seoPublished;
  toast({ kind: 'info', title: active ? `Your SEO page is ${name}’s page` : 'Your SEO page is the app’s builder page', body: live ? 'Publish it to update your live page.' : 'Undo switches back.' });
}

/** Version: the app's builder, or the page Manus or Viktor made. Each switch can be undone. */
export function SeoVersionSwitch({ project, className }: { project: Project; className?: string }) {
  const h = project.marketing.seoHtml;
  if (!h) return null;
  const name = AGENT_NAME[h.source.via];
  return (
    <section className={cn('flex flex-wrap items-center justify-between gap-x-3 gap-y-2', className)} aria-label="Version">
      <h2 className="text-small font-medium text-ink-2">Version</h2>
      <Segmented
        size="sm"
        value={h.active ? 'agent' : 'builder'}
        onChange={(v) => switchVersion(project, v === 'agent')}
        options={[
          { id: 'builder', label: 'The app’s builder' },
          { id: 'agent', label: `${name}’s page` },
        ]}
      />
    </section>
  );
}

export function SeoHtmlMode({ project, publishRef, rail, onRail }: { project: Project; publishRef?: RefObject<HTMLDivElement>; rail: RailPanel; onRail: (p: RailPanel) => void }) {
  const h = project.marketing.seoHtml!;
  const meta = project.marketing.seo!;
  const type = pageTypeOf(project);
  const name = AGENT_NAME[h.source.via];
  const projectId = project.id;
  const metaAI = useAI(seoMetaTask);
  const [device, setDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [checksOpen, setChecksOpen] = useState(false);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const result = useMemo(() => scoreSeoHtml(meta, h.html, type), [meta, h.html, type]);
  const published = project.marketing.seoPublished;
  const file = useSeoFile(projectId, `${meta.slug || slugify(project.brand.name) || 'sales-page'}.html`);

  const projectNow = (): Project => useStore.getState().projects.find((p) => p.id === projectId) ?? project;
  const setMeta = (patch: Partial<SeoMeta>) => {
    const cur = projectNow().marketing.seo;
    if (cur) saveSeo(projectId, { seo: { ...cur, ...patch } });
  };
  const regenMeta = async () => {
    const p = projectNow();
    const hh = p.marketing.seoHtml;
    if (!hh) return;
    const mainImage = seoHtmlShownImages(p)[0];
    const next = await metaAI.run({ instructions: (p.marketing.seoGuide ?? '').trim(), images: hh.images, ...(mainImage ? { mainImage } : {}), pageType: pageTypeOf(p) });
    if (next) applySeoMeta(projectId, next);
  };
  const remove = async () => {
    const ok = await confirmAction({
      title: `Remove ${name}’s page?`,
      body: `Your SEO page goes back to the app’s builder${project.marketing.salesPage ? '' : ' (it has no page yet: Write page writes one)'}. ${published ? 'Your live page stays as it is until you publish again. ' : ''}Undo brings ${name}’s page back.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok && removeSeoHtml(projectId)) toast({ kind: 'info', title: `Removed ${name}’s page`, body: 'Undo brings it back.' });
  };

  // the page's images as data, for the preview (they're not on a server here)
  const sig = h.images.map((i) => `${i.key}=${i.media.id}`).join('|');
  useEffect(() => {
    let alive = true;
    void imageDataUrls(h.images).then((u) => alive && setUrls(u));
    return () => {
      alive = false;
    };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  // a preview never opens a checkout: buy links become #buy-preview
  const doc = useMemo(() => resolveBuyTokens(seoHtmlDocument(project, { canonical: meta.canonical, origin: '', leadAction: '', imageUrl: (k) => urls[k] ?? '' }), { mode: 'preview' }), [project, meta.canonical, urls]);

  const formNote = !h.hasLeadForm
    ? null
    : published
      ? { text: 'What people send with the form arrives in Email → Leads.', leads: true }
      : { text: 'The form starts collecting leads once you publish this page.', leads: false };

  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="scroll-thin flex min-w-0 flex-col gap-4 xl:sticky xl:top-4 xl:-m-1 xl:max-h-[calc(100dvh-104px)] xl:overflow-y-auto xl:p-1" aria-label="Page settings">
        <AgentBuildList target="seo" />
        <SeoVersionSwitch project={project} />
        <Accordion type="single" collapsible value={rail} onValueChange={(v) => onRail(v as RailPanel)} className="card px-4">
          <RailItem value="type" open={rail} title="Page type" summary={PAGE_TYPE_LABEL[type]}>
            <section aria-label="Page type" className="flex flex-col gap-3">
              <p className="text-small text-ink-2">
                <span className="font-medium text-ink">{PAGE_TYPE_LABEL[type]}.</span> {PAGE_TYPE_DESC[type]}
              </p>
              <AgentButtons target="seo" lead="Build another type with" />
            </section>
          </RailItem>
          <RailItem value="score" open={rail} title="SEO score" summary={<span className="num font-mono">{result.score}</span>}>
            <ScoreSummary score={result.score} checks={result.checks} words={result.words} density={result.density} onChecks={() => setChecksOpen(true)} />
          </RailItem>
          <RailItem value="publish" open={rail} title="Public page" summary={published ? 'Live' : 'Not published'}>
            <div className="rounded-md outline-none focus-visible:shadow-focus" ref={publishRef} tabIndex={-1}>
              <PublishPanel
                pageId={seoPageId(project)}
                kind="seo"
                title={meta.metaTitle || h.title}
                defaultSlug={meta.slug}
                published={published}
                build={(target) => seoPublishBuild(projectNow(), target)}
                onChange={(seoPublished) => saveSeo(projectId, { seoPublished })}
                version={project.updatedAt}
              />
            </div>
          </RailItem>
          <RailItem value="meta" open={rail} title="Metadata" summary={<span className="num font-mono">{meta.metaTitle.length}/60</span>} last>
            <MetaPanel project={project} meta={meta} setMeta={setMeta} onRegen={() => void regenMeta()} running={metaAI.running} published={published} />
          </RailItem>
        </Accordion>
        <button type="button" className="btn btn-danger-ghost btn-sm self-start" onClick={() => void remove()}>
          <Trash2 /> Remove {name}’s page
        </button>
      </aside>

      <section className="flex min-w-0 flex-col gap-3" aria-label={`${name}’s page`}>
        <Callout
          tone="info"
          title={`You’re using the page ${name} built`}
          action={
            <button type="button" className="btn btn-secondary btn-xs" onClick={() => switchVersion(project, false)}>
              Switch back
            </button>
          }
        >
          {name} wrote this page. Check every claim, price and testimonial before you publish: the app can’t check free HTML.
        </Callout>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <DeviceSwitch value={device} onChange={setDevice} />
          <span className="text-caption text-muted">Scripts are off, and the form doesn’t send from this preview.</span>
        </div>
        {formNote && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-ink-2">
            <Inbox size={16} className="shrink-0 text-muted" aria-hidden="true" />
            <span className="min-w-0">{formNote.text}</span>
            {formNote.leads && (
              <button
                type="button"
                className="link"
                onClick={() => {
                  useUI.getState().requestTab('marketing-email', 'leads');
                  void navigate('marketing-email');
                }}
              >
                Open Leads
              </button>
            )}
          </p>
        )}
        <div className="well flex justify-center p-3 sm:p-6">
          <BrowserFrame url={liveAddress(published) || undefined} className={cn('w-full transition-[max-width] duration-240 ease-out', FRAME_WIDTH[device])}>
            {/* the agent's page as visitors get it: its own colours in both themes, sandboxed (never the app's origin) */}
            <iframe title={`${name}’s SEO page`} srcDoc={doc} sandbox={SEO_SANDBOX} referrerPolicy="no-referrer" className="block h-[64vh] min-h-[420px] w-full" style={{ background: '#ffffff' }} />
          </BrowserFrame>
        </div>
        {h.notes.length > 0 && (
          <ul className="flex flex-col gap-1" aria-label="What the app changed in it">
            {h.notes.map((n) => (
              <li key={n} className="flex items-start gap-1.5 text-caption text-muted">
                <Info size={14} className="mt-px shrink-0" aria-hidden="true" />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        )}
        <SourcePanel project={project} file={file} images={h.images.length > 0} note="With your metadata, OpenGraph and JSON-LD from your own facts" />
      </section>

      <Drawer open={checksOpen} onClose={() => setChecksOpen(false)} title="SEO checklist">
        <Checklist checks={result.checks} />
      </Drawer>
    </div>
  );
}
