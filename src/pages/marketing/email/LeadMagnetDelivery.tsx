// Email › Lead magnet › Delivery: the free download people get, published at a permanent address /m/<id>. A PDF
// made from the guide, a file the owner uploads, or a link to a page; optionally behind an email gate whose
// sign-ups go to Email → Leads. Publishing again keeps the same link. Needs the app's server with accounts, so it's
// never shown in the claude.ai build.

import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FileText, Link2, Trash2, Upload } from 'lucide-react';
import type { LeadMagnet, LeadMagnetDelivery, Project } from '@/lib/types';
import { fmtBytes, fmtRelative, slugify } from '@/lib/utils';
import { showSignIn } from '@/lib/cloud/auth';
import { fingerprint, usePublishAccess } from '@/lib/publish';
import { LEAD_FILE_ACCEPT, LeadFilesError, PUBLIC_IMAGE_ACCEPT, createLeadFile, deleteLeadFile, listLeadFiles, patchLeadFile, refusedFileName, uploadLeadFileContent, uploadPublicImage, type LeadFile } from '@/lib/leadFiles';
import { leadMagnetHash, leadMagnetPdf } from '@/lib/leadMagnetPdf';
import { updateMarketingOf } from '@/lib/emailFunnel';
import { toast } from '@/store/ui';
import { Callout, CopyButton, Field, OptionCards, Section, Spinner, Toggle, confirmAction } from '@/components/ui/primitives';

type Source = LeadMagnetDelivery['source'];

/** What the published download is out of date with: the guide changed since its PDF was made. */
export function deliveryStale(lm: LeadMagnet, project: Project): boolean {
  const d = lm.delivery;
  return !!d && d.source === 'pdf' && !!d.hash && d.hash !== leadMagnetHash(lm, project);
}

/** A URL the server takes for a link download: https?://, a host with a dot, no user name or password. */
export function linkDownloadOk(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.') && !u.username && !u.password && raw.trim().length <= 2000;
  } catch {
    return false;
  }
}

async function sha256(blob: Blob): Promise<string> {
  try {
    const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return fingerprint(`${blob.size}`);
  }
}

/** After a new download (its id is new): the forms already published still send the old one, or none. */
export const REPUBLISH_NOTE = 'Publish your page and your lead-form assets again so their forms offer this download.';

/**
 * Publish (or update) the download: the same row and link when there is one, a new one when it's gone from the
 * server; then its file; then save() the delivery. A new row that didn't get its file is taken down again. The cover
 * goes last, on its own: the download is live (and saved) whether or not it uploads, and coverError says so.
 */
export async function publishDownload(
  project: Project,
  lm: LeadMagnet,
  o: { source: Source; url: string; file: File | null; cover: File | null; gate: boolean },
  save: (d: LeadMagnetDelivery) => void,
): Promise<{ delivery: LeadMagnetDelivery; isNew: boolean; coverError: string }> {
  const d = lm.delivery;
  const { source, url, file, cover, gate } = o;
  const title = lm.title.trim().slice(0, 200) || 'Free download';
  const brand = project.brand.name.trim().slice(0, 120);
  let created: string | null = null;
  let delivery: LeadMagnetDelivery;
  let row: LeadFile | null = null;
  try {
    if (d?.fileId) {
      try {
        row = await patchLeadFile(d.fileId, { title, brand, gate, ...(source === 'url' ? { url: url.trim() } : {}) });
      } catch (e) {
        if (!(e instanceof LeadFilesError && e.status === 404)) throw e;
      }
    }
    if (!row) {
      row = await createLeadFile({ projectId: project.id, title, brand, kind: source === 'url' ? 'url' : 'file', ...(source === 'url' ? { url: url.trim() } : {}), gate });
      created = row.id;
    }
    let hash = d?.hash;
    if (source === 'pdf') {
      const pdf = await leadMagnetPdf(lm, project);
      row = await uploadLeadFileContent(row.id, new Blob([pdf.bytes as BlobPart], { type: 'application/pdf' }), `${slugify(title) || 'download'}.pdf`);
      hash = leadMagnetHash(lm, project);
    } else if (source === 'upload' && file) {
      row = await uploadLeadFileContent(row.id, file, file.name);
      hash = `sha256:${await sha256(file)}`;
    } else if (source === 'url') {
      hash = fingerprint(url.trim());
    }
    const fileName = row.kind === 'file' ? row.fileName || d?.fileName : undefined;
    const bytes = row.kind === 'file' ? row.bytes || d?.bytes : undefined;
    delivery = {
      source,
      fileId: row.id,
      // the app's address: it always serves the download (a domain's copy stops when the domain does)
      link: row.link || d?.link || '',
      gate: row.gate,
      ...(fileName ? { fileName } : {}),
      ...(bytes ? { bytes } : {}),
      ...(row.kind === 'url' ? { url: row.url } : {}),
      ...(hash ? { hash } : {}),
      publishedAt: Date.now(),
    };
    save(delivery);
  } catch (e) {
    // a new download that didn't get its file: take it down again, so there's no empty link
    if (created) await deleteLeadFile(created).catch(() => undefined);
    throw e;
  }
  let coverError = '';
  if (cover) {
    try {
      await uploadPublicImage(cover, cover.name, row.id);
    } catch (e) {
      coverError = `The download is published, but its cover image didn’t upload. ${(e as Error)?.message || 'Try again.'}`;
    }
  }
  return { delivery, isNew: row.id !== d?.fileId, coverError };
}

export function LeadMagnetDeliverySection({ project, lm }: { project: Project; lm: LeadMagnet }) {
  if (__ARTIFACT_BUILD__) return null;
  return (
    <Section title="Delivery" description="The free download people get, at a link that never changes. Sign-ups go to Email › Leads." divider>
      <Delivery project={project} lm={lm} />
    </Section>
  );
}

function Delivery({ project, lm }: { project: Project; lm: LeadMagnet }) {
  const { access, retry } = usePublishAccess();
  if (access === 'checking')
    return (
      <div className="flex h-16 items-center text-muted" role="status" aria-label="Checking the app’s server">
        <Spinner size={18} />
      </div>
    );
  if (access === 'unavailable') return null;
  if (access === 'unreachable')
    return (
      <Callout
        tone="warn"
        action={
          <button type="button" className="btn btn-secondary btn-xs" onClick={retry}>
            Try again
          </button>
        }
      >
        Couldn’t reach the app’s server.
      </Callout>
    );
  if (access === 'off') return <Callout tone="info">Downloads need publishing, which isn’t set up on this app’s server yet.</Callout>;
  if (access === 'signed-out')
    return (
      <Callout
        tone="info"
        action={
          <button type="button" className="btn btn-primary btn-xs" onClick={showSignIn}>
            Sign in
          </button>
        }
      >
        Sign in to publish your download.
      </Callout>
    );
  return <DeliveryForm key={project.id} project={project} lm={lm} />;
}

function DeliveryForm({ project, lm }: { project: Project; lm: LeadMagnet }) {
  const d = lm.delivery;
  const [source, setSource] = useState<Source>(d?.source ?? 'pdf');
  const [gate, setGate] = useState(d?.gate ?? true);
  const [url, setUrl] = useState(d?.url ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [busy, setBusy] = useState<'publish' | 'unpublish' | null>(null);
  const [error, setError] = useState('');
  const [stats, setStats] = useState<LeadFile | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);

  // the download count and the last download (the server's, not kept with the project)
  useEffect(() => {
    if (!d?.fileId) return setStats(null);
    const ctrl = new AbortController();
    listLeadFiles(project.id, ctrl.signal, 'magnet').then(
      (files) => setStats(files.find((f) => f.id === d.fileId) ?? null),
      () => undefined,
    );
    return () => ctrl.abort();
  }, [project.id, d?.fileId, d?.publishedAt]);

  const save = (delivery: LeadMagnetDelivery | undefined) =>
    updateMarketingOf(project.id, (m) => {
      if (!m.leadMagnet) return {};
      const { delivery: _old, ...rest } = m.leadMagnet;
      return { leadMagnet: delivery ? { ...rest, delivery } : rest };
    });

  const pickFile = (f: File | null) => {
    setError('');
    if (f && refusedFileName(f.name)) {
      setFile(null);
      setError('SVG, HTML and script files can’t be downloads. Use a PDF, EPUB, ZIP, Word, Excel or PowerPoint file, a PNG, JPEG or WebP image, an MP3 or an MP4.');
      return;
    }
    setFile(f);
  };

  const publish = async () => {
    setError('');
    if (source === 'url' && !linkDownloadOk(url)) return setError('Use a full web address starting with https://.');
    if (source === 'upload' && !file && !(d?.source === 'upload' && d.fileId)) return setError('Choose a file to upload first.');
    setBusy('publish');
    try {
      const done = await publishDownload(project, lm, { source, url, file, cover, gate }, save);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      // forms hand out the download whose id they were published with: a new one needs them published again
      toast({ kind: 'success', title: done.isNew ? 'Download published' : 'Download updated', body: done.isNew ? REPUBLISH_NOTE : 'Its link stays the same.' });
      if (done.coverError) setError(done.coverError);
      else if (cover) {
        setCover(null);
        if (coverRef.current) coverRef.current.value = '';
      }
    } catch (e) {
      setError((e as Error)?.message || 'Couldn’t publish the download. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const unpublish = async () => {
    if (!d) return;
    if (!(await confirmAction({ title: 'Unpublish this download?', body: 'Its link stops working right away, in your emails and pages too. Its sign-ups stay in Leads.', confirmLabel: 'Unpublish', danger: true }))) return;
    setBusy('unpublish');
    setError('');
    try {
      await deleteLeadFile(d.fileId);
      save(undefined);
      toast({ kind: 'info', title: 'Download unpublished' });
    } catch (e) {
      setError((e as Error)?.message || 'Couldn’t unpublish it. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const stale = deliveryStale(lm, project);
  const live = d?.link ?? '';
  return (
    <div className="flex flex-col gap-4">
      <OptionCards<Source>
        aria-label="What people download"
        columns={3}
        value={source}
        onChange={(v) => {
          setSource(v);
          setError('');
        }}
        options={[
          { value: 'pdf', title: 'PDF made from this guide', description: 'Your guide, laid out in your brand’s colours.', icon: <FileText size={20} /> },
          { value: 'upload', title: 'Upload a file', description: 'A PDF, ebook, document, image, audio or video, up to 25 MB.', icon: <Upload size={20} /> },
          { value: 'url', title: 'Link to a page', description: 'Send people to a page of yours, such as a video.', icon: <Link2 size={20} /> },
        ]}
      />
      {source === 'upload' && (
        <Field label="File" htmlFor="lm-file" hint={d?.source === 'upload' && d.fileName && !file ? `Published: ${d.fileName}${d.bytes ? ` (${fmtBytes(d.bytes)})` : ''}. Choose another to replace it.` : 'PDF, EPUB, ZIP, Word, Excel, PowerPoint, PNG, JPEG, WebP, MP3 or MP4.'}>
          <input id="lm-file" ref={fileRef} type="file" className="input" accept={LEAD_FILE_ACCEPT} onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
        </Field>
      )}
      {source === 'url' && (
        <Field label="Web address" htmlFor="lm-url">
          <input id="lm-url" className="input" type="url" inputMode="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2000} />
        </Field>
      )}
      <Toggle checked={gate} onChange={setGate} label="Ask for an email before the download" description="Their name and email go to Email › Leads. They get emails from you only if they tick the box." />
      <Field label="Cover image (optional)" htmlFor="lm-cover" hint="Shown on the download page. JPEG, PNG, WebP or GIF, up to 5 MB.">
        <input id="lm-cover" ref={coverRef} type="file" className="input" accept={PUBLIC_IMAGE_ACCEPT} onChange={(e) => setCover(e.target.files?.[0] ?? null)} />
      </Field>
      {stale && <Callout tone="warn">The guide changed since you published its PDF. Update the download to publish the new one.</Callout>}
      {error && <Callout tone="bad">{error}</Callout>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void publish()} disabled={!!busy}>
          {busy === 'publish' ? <Spinner size={16} /> : null} {d ? 'Update download' : 'Publish download'}
        </button>
        {d && (
          <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => void unpublish()} disabled={!!busy}>
            {busy === 'unpublish' ? <Spinner size={16} /> : <Trash2 aria-hidden="true" />} Unpublish
          </button>
        )}
      </div>
      {d && live && (
        <div className="rounded-lg border border-line bg-surface-2 p-3" aria-label="Your download’s link" role="group">
          <p className="label">Your download’s link</p>
          <div className="flex flex-wrap items-center gap-2">
            <a href={live} target="_blank" rel="noopener noreferrer" className="link min-w-0 break-all font-mono text-small">
              {live.replace(/^https?:\/\//, '')}
            </a>
            <CopyButton text={live} size="xs" />
            <a href={live} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-xs" aria-label="Open your download’s link (opens in a new tab)">
              <ExternalLink aria-hidden="true" /> Open
            </a>
          </div>
          <p className="mt-1 text-caption text-muted">
            {d.gate ? 'People give their email first.' : 'No email asked: anyone with the link gets it.'}
            {stats ? ` ${stats.downloads === 1 ? '1 download' : `${stats.downloads.toLocaleString('en-US')} downloads`}${stats.lastDownloadAt ? `, the last ${fmtRelative(stats.lastDownloadAt)}` : ''}.` : ''}
          </p>
        </div>
      )}
    </div>
  );
}
