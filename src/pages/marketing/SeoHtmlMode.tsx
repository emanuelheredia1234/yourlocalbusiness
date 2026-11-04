// The SEO page in HTML mode: a page Manus or Viktor made is the one shown, scored and published (at the same address
// as the builder's page), with the app's own metadata in its head and no JavaScript. The builder's page stays:
// Version switches between them (Undo too). The app can't check claims in free HTML, so a standing note asks the
// owner to check every claim, price and testimonial before publishing.

import { useEffect, useMemo, useState, type RefObject } from 'react';
import { AlertTriangle, Check, CircleDashed, Code2, Inbox, Info, Trash2, X } from 'lucide-react';
import type { Project, SeoMeta } from '@/lib/types';
import { cn } from '@/lib/utils';
import { scoreSeoHtml } from '@/ai/local/seo';
import { seoMetaTask } from '@/ai/tasks';
import { useAI } from '@/ai/useAI';
import { applySeoMeta, removeSeoHtml, saveSeo, setSeoHtmlActive } from '@/ai/seoBuilder';
import { PAGE_TYPE_DESC, PAGE_TYPE_LABEL, pageTypeOf } from '@/lib/pageTypes';
import { imageDataUrls } from '@/lib/promptImages';
import { seoHtmlDocument, seoHtmlShownImages } from '@/lib/seoHtml';
import { seoPageId, seoPublishBuild, seoSourceHtml } from '@/lib/seoPage';
import { navigate } from '@/lib/router';
import { useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { PublishPanel } from '@/components/publish/PublishPanel';
import { ProgressRing, Segmented, confirmAction } from '@/components/ui/primitives';
import { AgentButtons } from '@/components/agents/AgentButtons';
import { DeviceSwitch, HtmlPreviewFrame, SEO_SANDBOX } from '@/components/agents/HtmlPreview';
import { MetaPanel } from './SeoSalesPage';

const AGENT_NAME = { manus: 'Manus', viktor: 'Viktor' } as const;

function scoreColor(score: number) {
  return score >= 80 ? 'rgb(var(--good))' : score >= 55 ? 'rgb(var(--warn))' : 'rgb(var(--bad))';
}

/** Version: the app's builder, or the page Manus or Viktor made. Each switch can be undone. */
export function SeoVersionSwitch({ project, className }: { project: Project; className?: string }) {
  const h = project.marketing.seoHtml;
  if (!h) return null;
  const name = AGENT_NAME[h.source.via];
  const flip = (active: boolean) => {
    if (!setSeoHtmlActive(project.id, active)) return;
    const live = !!useStore.getState().projects.find((p) => p.id === project.id)?.marketing.seoPublished;
    toast({ kind: 'info', title: active ? `Your SEO page is ${name}’s page` : 'Your SEO page is the app’s builder page', body: live ? 'Publish it to update your live page.' : 'Undo switches back.' });
  };
  return (
    <section className={cn('panel flex flex-wrap items-center gap-2 p-3', className)} aria-label="Version">
      <h2 className="text-small font-semibold">Version</h2>
      <Segmented
        size="sm"
        value={h.active ? 'agent' : 'builder'}
        onChange={(v) => flip(v === 'agent')}
        options={[
          { id: 'builder', label: 'The app’s builder' },
          { id: 'agent', label: `${name}’s page` },
        ]}
      />
    </section>
  );
}

export function SeoHtmlMode({ project, publishRef }: { project: Project; publishRef?: RefObject<HTMLDivElement> }) {
  const h = project.marketing.seoHtml!;
  const meta = project.marketing.seo!;
  const type = pageTypeOf(project);
  const name = AGENT_NAME[h.source.via];
  const projectId = project.id;
  const metaAI = useAI(seoMetaTask);
  const [device, setDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [panel, setPanel] = useState<'meta' | 'score'>('meta');
  const [urls, setUrls] = useState<Record<string, string>>({});
  const result = useMemo(() => scoreSeoHtml(meta, h.html, type), [meta, h.html, type]);
  const published = project.marketing.seoPublished;

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
  const doc = useMemo(() => seoHtmlDocument(project, { canonical: meta.canonical, origin: '', leadAction: '', imageUrl: (k) => urls[k] ?? '' }), [project, meta.canonical, urls]);

  const formNote = !h.hasLeadForm
    ? null
    : published
      ? { text: 'What people send with the form arrives in Email → Leads.', leads: true }
      : { text: 'The form starts collecting leads once you publish this page (Public page, beside the score).', leads: false };

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
      <aside className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-4 xl:max-h-[calc(100vh-120px)] xl:self-start xl:overflow-y-auto xl:pr-1 scroll-thin">
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

        <SeoVersionSwitch project={project} />

        <section className="panel p-4" aria-label="Page type">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-body font-semibold">Page type</h2>
            <span className="chip">{PAGE_TYPE_LABEL[type]}</span>
          </div>
          <p className="mt-1 text-caption text-muted">{PAGE_TYPE_DESC[type]}</p>
          <AgentButtons target="seo" lead="Build another type with" className="mt-3" />
        </section>

        <div className="panel p-4 outline-none focus:shadow-focus" ref={publishRef} tabIndex={-1}>
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

        <Segmented
          size="sm"
          value={panel}
          onChange={setPanel}
          options={[
            { id: 'meta', label: 'Metadata' },
            { id: 'score', label: 'Checklist' },
          ]}
        />
        {panel === 'meta' && <MetaPanel project={project} meta={meta} setMeta={setMeta} onRegen={() => void regenMeta()} running={metaAI.running} published={published} />}
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

        <button type="button" className="btn btn-ghost btn-sm self-start text-muted hover:text-bad" onClick={() => void remove()}>
          <Trash2 size={14} /> Remove {name}’s page
        </button>
      </aside>

      <section className="flex min-w-0 flex-col gap-3" aria-label={`${name}’s page`}>
        <p className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-small text-warn">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>
            {name} wrote this page. Check every claim, price and testimonial before you publish: the app can’t check free HTML.
          </span>
        </p>
        {h.notes.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-md border border-line bg-surface-2 px-3 py-2" aria-label="What the app changed in it">
            {h.notes.map((n) => (
              <li key={n} className="flex items-start gap-1.5 text-caption text-ink-2">
                <Info size={13} className="mt-px shrink-0 text-muted" aria-hidden="true" />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        )}
        {formNote && (
          <p className="flex flex-wrap items-start gap-x-2 gap-y-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-small text-ink-2">
            <Inbox size={15} className="mt-0.5 shrink-0 text-muted" />
            <span className="min-w-0 flex-1">{formNote.text}</span>
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
        <div className="panel flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <DeviceSwitch value={device} onChange={setDevice} />
          <span className="text-caption text-muted">Scripts are off; the form doesn’t send from this preview.</span>
        </div>
        <HtmlPreviewFrame doc={doc} sandbox={SEO_SANDBOX} device={device} title={`${name}’s SEO page`} />
        <details className="panel group">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-small font-semibold">
            <Code2 size={15} className="text-primary" /> HTML source
            <span className="ml-auto text-caption font-normal text-muted">With your metadata, OpenGraph and JSON-LD from your own facts</span>
          </summary>
          {h.images.length > 0 && <p className="border-t border-line px-4 py-2 text-caption text-muted">Images show here as short placeholders, like {'{{img-1}}'}. Copy HTML and Export HTML put the images themselves into the file.</p>}
          <pre className="max-h-[360px] overflow-auto border-t border-line bg-surface-2 p-3 font-mono text-caption leading-relaxed text-ink-2 scroll-thin">{seoSourceHtml(project)}</pre>
        </details>
      </section>
    </div>
  );
}
