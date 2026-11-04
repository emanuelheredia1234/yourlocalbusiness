// The preview of a page from Manus or Viktor, as the app would keep it: cleaned by the importer, with the owner's
// images filled in, in a sandboxed frame that has no access to the app (no allow-same-origin). An asset runs its
// script (like Code & assets' own preview); an SEO page has none, and its form can't send from here. "Use this"
// makes it an asset or the SEO page (nothing is published). Opened by a build's card and by the assistant chat.

import { useEffect, useMemo, useState } from 'react';
import { Info, Monitor, Smartphone, Tablet } from 'lucide-react';
import { create } from 'zustand';
import type { AgentId, BuildTarget } from '@/lib/agentTypes';
import type { Project, PromptImage } from '@/lib/types';
import { cn } from '@/lib/utils';
import { imageDataUrls } from '@/lib/promptImages';
import { findCodeAsset } from '@/lib/codeAssets';
import { seoHtmlDocument } from '@/lib/seoHtml';
import { buildDocument } from '@/ai/local/code';
import { importAgentHtml, type ImportResult } from '@/ai/agents/importHtml';
import { applyAgentPage, type AgentHtmlSource } from '@/ai/agents/results';
import { findBuild } from '@/ai/agents/buildRecords';
import { getActiveProject, useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { Modal, Segmented, Spinner } from '@/components/ui/primitives';

const AGENT_NAME: Record<AgentId, string> = { manus: 'Manus', viktor: 'Viktor' };

/** An asset's preview runs its script (sandboxed, like Code & assets); an SEO page's has no script and no form that sends. */
export const ASSET_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals';
export const SEO_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

type Device = 'desktop' | 'tablet' | 'mobile';
const WIDTH: Record<Device, string> = { desktop: '100%', tablet: '768px', mobile: '390px' };

/** A whole page in a sandboxed frame (it never gets the app's origin). */
export function HtmlPreviewFrame({ doc, sandbox, device = 'desktop', title, className }: { doc: string; sandbox: string; device?: Device; title: string; className?: string }) {
  return (
    <div className={cn('dotgrid flex min-h-0 justify-center overflow-auto rounded-md bg-surface-2 p-3', className)}>
      <iframe title={title} srcDoc={doc} sandbox={sandbox} referrerPolicy="no-referrer" className="h-[62vh] min-h-[380px] rounded-md border border-line bg-white shadow-card transition-[width] duration-300" style={{ width: WIDTH[device], maxWidth: '100%' }} />
    </div>
  );
}

/** The device widths a preview can show. */
export function DeviceSwitch({ value, onChange }: { value: Device; onChange: (d: Device) => void }) {
  return (
    <Segmented
      size="sm"
      value={value}
      onChange={onChange}
      options={[
        { id: 'desktop', label: 'Desktop', icon: <Monitor size={13} /> },
        { id: 'tablet', label: '768 px', icon: <Tablet size={13} /> },
        { id: 'mobile', label: 'Mobile', icon: <Smartphone size={13} /> },
      ]}
    />
  );
}

interface PreviewReq {
  title: string;
  target: BuildTarget;
  src: AgentHtmlSource;
  projectId: string;
}

const usePreview = create<{ req: PreviewReq | null }>(() => ({ req: null }));

/** The sandboxed preview of what an import would make (cleaned, with the owner's images filled in). */
export function openHtmlPreview(o: { title: string; target: BuildTarget; src: AgentHtmlSource }): void {
  const p = getActiveProject();
  if (!p) return;
  usePreview.setState({ req: { ...o, projectId: p.id } });
}

/** What the importer makes of the page, for this preview (its own image keys: the preview needs no renumbering). */
export function previewImport(p: Project, target: BuildTarget, src: AgentHtmlSource): ImportResult {
  let ownHost = '';
  try {
    ownHost = p.brand.websiteUrl ? new URL(/^https?:\/\//i.test(p.brand.websiteUrl) ? p.brand.websiteUrl : `https://${p.brand.websiteUrl}`).hostname : '';
  } catch {
    ownHost = '';
  }
  return importAgentHtml(src.html, { target, imageKeys: src.images.map((i) => i.key), fallbackTitle: `Page from ${AGENT_NAME[src.via]}`, ownHost });
}

/** The document the preview shows: the asset as Code & assets would build it, or the SEO page with the app's own head. */
export function previewDocument(p: Project, target: BuildTarget, src: AgentHtmlSource, page: Extract<ImportResult, { ok: true }>['page'], urls: Record<string, string>): string {
  if (target === 'asset') return buildDocument({ html: page.html, css: page.css, js: page.js }, page.title, { images: urls, storageShim: true });
  const images: PromptImage[] = src.images;
  const shown: Project = {
    ...p,
    marketing: {
      ...p.marketing,
      seo: p.marketing.seo ?? { metaTitle: page.title, metaDescription: page.description, slug: '', primaryKeyword: '', secondaryKeywords: [], ogTitle: page.title, ogDescription: page.description, ogImageAlt: '', canonical: '' },
      seoHtml: { html: page.html, css: page.css, images, source: { via: src.via, at: 0 }, title: page.title, description: page.description, notes: page.notes, active: true, hasLeadForm: page.hasLeadForm, importedAt: 0 },
    },
  };
  return seoHtmlDocument(shown, { canonical: '', origin: '', leadAction: '', imageUrl: (k) => urls[k] ?? '' });
}

/** The preview window (mounted once, in App). */
export function HtmlPreviewHost() {
  const req = usePreview((s) => s.req);
  const project = useStore((s) => (req ? s.projects.find((p) => p.id === req.projectId) : undefined));
  const [device, setDevice] = useState<Device>('desktop');
  const [urls, setUrls] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => usePreview.setState({ req: null });

  // the importer reads only the page: the project matters for the owner's website and metadata, read once
  const result = useMemo(() => (req && project ? previewImport(project, req.target, req.src) : null), [req]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setUrls(null);
    setDevice('desktop');
    if (!req) return;
    let alive = true;
    void imageDataUrls(req.src.images).then((u) => alive && setUrls(u));
    return () => {
      alive = false;
    };
  }, [req]);

  if (!req || !project) return null;
  const name = AGENT_NAME[req.src.via];
  const build = req.src.buildId ? findBuild(project.id, req.src.buildId) : undefined;
  // a page from a build that was already used as an asset: update that asset, or add another
  const earlier = req.target === 'asset' && build?.imported?.assetId ? findCodeAsset(project.id, build.imported.assetId) : undefined;
  const doc = result?.ok && urls ? previewDocument(project, req.target, req.src, result.page, urls) : '';

  const use = async (replaceAssetId?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await applyAgentPage(project.id, req.target, req.src, { ...(replaceAssetId ? { replaceAssetId } : {}), resultAt: build?.result?.at });
      if (!r.ok) {
        toast({ kind: 'error', title: 'Couldn’t use this page', body: r.message });
        return;
      }
      close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={close}
      size="xl"
      title={req.title}
      subtitle={`${name}’s page as the app would keep it: ${req.target === 'seo' ? 'without JavaScript, with your page’s metadata' : 'cleaned, with your images'}. Nothing is published.`}
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={close}>
            Close
          </button>
          {result?.ok &&
            (earlier ? (
              <>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void use()}>
                  Add as a new asset
                </button>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void use(earlier.id)}>
                  {busy && <Spinner size={14} />} Update “{earlier.name}”
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void use()}>
                {busy && <Spinner size={14} />} {req.target === 'seo' ? 'Use as my SEO page' : 'Use this'}
              </button>
            ))}
        </>
      }
    >
      {!result ? null : !result.ok ? (
        <p className="rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad" role="alert">
          {result.message}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {req.target === 'seo' && (
            <p className="rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[13px] text-warn">{name} wrote this page. Check every claim, price and testimonial before you publish: the app can’t check free HTML.</p>
          )}
          {result.page.notes.length > 0 && (
            <ul className="flex flex-col gap-1" aria-label="What the app changed">
              {result.page.notes.map((n) => (
                <li key={n} className="flex items-start gap-1.5 text-xs text-ink-2">
                  <Info size={13} className="mt-px shrink-0 text-muted" aria-hidden="true" />
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <DeviceSwitch value={device} onChange={setDevice} />
            <span className="text-xs text-muted">{req.target === 'seo' ? 'Scripts are off and its form doesn’t send from here.' : 'Its script runs here in a sandbox, as on a published page.'}</span>
          </div>
          {doc ? (
            <HtmlPreviewFrame doc={doc} sandbox={req.target === 'seo' ? SEO_SANDBOX : ASSET_SANDBOX} device={device} title={`Preview of ${req.title}`} />
          ) : (
            <p className="flex h-[62vh] min-h-[380px] items-center justify-center gap-2 rounded-md bg-surface-2 text-xs text-muted" role="status">
              <Spinner size={14} /> Getting your images ready…
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
