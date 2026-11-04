// Manus's and Viktor's messages in the chat, and the owner's messages to them. A reply is untrusted: its text is
// shown as plain text with links (app links off, so it can never move the app), never as HTML. What came with
// it renders from the message's own data, so it survives a reload: images (fetched from your server when
// shown), pages (Preview, Open as asset, Use as my SEO page, through the importer that cleans them first), and
// other files (Download). The owner's own messages show where they went and whether they arrived.

import { useEffect, useState } from 'react';
import { Bot, Check, CircleAlert, Download, ExternalLink, Eye, FileCode, FileText, Globe, ImagePlus, LayoutTemplate, MessagesSquare, PanelsTopLeft, RotateCw } from 'lucide-react';
import type { AgentFileMeta, AgentId } from '@/lib/agentTypes';
import { cn } from '@/lib/utils';
import { saveMediaFile } from '@/lib/storage';
import { PROMPT_IMAGE_TYPES } from '@/lib/promptImages';
import { useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import type { ChatMessage } from '@/store/assistant';
import { agentErrorText } from '@/ai/agents/api';
import { agentName } from '@/ai/agents/who';
import { answerManus, checkDelivery, replyFile, replyPageSource, sendAgain } from '@/ai/agents/chat';
import { applyAgentPage } from '@/ai/agents/results';
import { pageErrorText } from '@/ai/agents/builds';
import { openHtmlPreview } from '../agents/HtmlPreview';
import { confirmAction, Spinner } from '../ui/primitives';
import { download } from '../ui/download';
import { MediaThumb } from '../media/MediaUpload';
import { ChatText } from './ChatText';

const ICON: Record<AgentId, typeof Bot> = { manus: Bot, viktor: MessagesSquare };
/** Most images kept in the brand gallery (Settings → Brand). */
const GALLERY_MAX = 24;

const viaOf = (m: ChatMessage): AgentId => (m.via === 'manus' ? 'manus' : 'viktor');
const httpsOnly = (u: string | undefined) => (u && /^https:\/\/\S+$/i.test(u) ? u : '');
/** "9.4 KB", "1.6 MB" ('' when unknown). */
const sizeText = (bytes: number | undefined) => (bytes && bytes > 0 ? (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(0.1, Math.round(bytes / 102.4) / 10)} KB`) : '');

/** A file name from an agent, safe to save under (no folders, no odd characters). */
export function safeFileName(name: string, fallback = 'file'): string {
  const n = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return n || fallback;
}

/** "Open in Manus" / "Open in Slack": the task or thread, when there's an address for it. */
export function OpenInAgent({ m, className }: { m: ChatMessage; className?: string }) {
  const url = httpsOnly(m.agentRef?.url);
  if (!url || !m.via) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={cn('link inline-flex items-center gap-1', className)}>
      Open in {m.via === 'manus' ? 'Manus' : 'Slack'}
      <ExternalLink size={11} aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

// ───────────── what came with a reply ─────────────

function ReplyImage({ m, f, projectId }: { m: ChatMessage; f: AgentFileMeta; projectId: string }) {
  const via = viaOf(m);
  const [img, setImg] = useState<{ url?: string; blob?: Blob; error?: string }>({});
  const [busy, setBusy] = useState(false);
  const source = m.agentRef?.taskId ?? m.agentRef?.threadId ?? '';
  useEffect(() => {
    if (m.gone) return;
    let alive = true;
    let url = '';
    setImg({});
    replyFile(m, f.id).then(
      (blob) => {
        if (!alive) return;
        // only an image your server recognised is shown as one; anything else can only be downloaded
        if (!PROMPT_IMAGE_TYPES.includes(blob.type)) return setImg({ blob, error: 'This file isn’t an image the app can show.' });
        url = URL.createObjectURL(blob);
        setImg({ url, blob });
      },
      (e) => alive && setImg({ error: agentErrorText(e, via).body }),
    );
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
    // the file is the same as long as the message, its task or thread and the file are
  }, [m.id, f.id, source, m.gone]); // eslint-disable-line react-hooks/exhaustive-deps

  const name = safeFileName(f.name, 'image');
  const save = async () => {
    const blob = img.blob;
    const p = useStore.getState().projects.find((x) => x.id === projectId);
    if (!blob || !p || busy) return;
    if (p.brand.images.length >= GALLERY_MAX) return toast({ kind: 'error', title: `Your images are full (${GALLERY_MAX})`, body: 'Remove one in Settings → Brand, then save this one.' });
    setBusy(true);
    try {
      const media = await saveMediaFile(new File([blob], name, { type: blob.type }));
      useStore.getState().updateProject(projectId, (x) => ({ ...x, brand: { ...x.brand, images: [...x.brand.images, media] } }));
      toast({ kind: 'success', title: 'Saved to your images', body: 'It’s with your photos in Settings → Brand.' });
    } catch (e) {
      toast({ kind: 'error', title: 'Couldn’t save the image', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <figure className="flex w-full max-w-[260px] flex-col gap-1.5 rounded-md border border-line bg-surface-2/60 p-1.5">
      {img.url ? (
        <img src={img.url} alt={`${f.name} from ${agentName(via)}`} className="max-h-48 w-full rounded object-contain" />
      ) : (
        <div className="flex h-24 items-center justify-center gap-1.5 rounded bg-surface-2 px-2 text-center text-[11.5px] text-muted" role={img.error ? 'alert' : 'status'}>
          {m.gone ? 'Deleted in Slack' : img.error ? img.error : <><Spinner size={12} /> Getting the image…</>}
        </div>
      )}
      <figcaption className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted" title={f.name}>
          {f.name}
        </span>
        {img.url && (
          <button type="button" className="btn btn-secondary btn-xs" disabled={busy} onClick={() => void save()}>
            {busy ? <Spinner size={11} /> : <ImagePlus size={12} aria-hidden="true" />} Save to my images
          </button>
        )}
        {img.blob && (
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => void download(name, img.blob!)} aria-label={`Download ${f.name}`}>
            <Download size={12} aria-hidden="true" /> Download
          </button>
        )}
      </figcaption>
    </figure>
  );
}

interface PageRef {
  at: string;
  name: string;
  bytes?: number;
  complete: boolean;
}

/** The pages in a reply: Viktor's page (a code block or an attached .html file), then any other .html file. */
export function replyPages(m: ChatMessage): PageRef[] {
  const files = m.files ?? [];
  const out: PageRef[] = [];
  if (m.html) out.push({ at: m.html.at, name: files.find((f) => f.id === m.html?.at)?.name || 'page.html', bytes: m.html.bytes, complete: m.html.complete });
  for (const f of files) if (f.kind === 'html' && f.id !== m.html?.at) out.push({ at: f.id, name: f.name || 'page.html', bytes: f.bytes, complete: true });
  return out;
}

function PageChip({ m, page, projectId, onLeave }: { m: ChatMessage; page: PageRef; projectId: string; onLeave?: () => void }) {
  const via = viaOf(m);
  const name = agentName(via);
  const [busy, setBusy] = useState<'' | 'preview' | 'asset' | 'seo'>('');
  const [error, setError] = useState('');
  const why = m.gone ? 'It was deleted in Slack.' : !page.complete ? `${name} sent only part of the page: ask for the whole page as one file.` : '';

  const run = async (what: 'preview' | 'asset' | 'seo') => {
    if (busy) return;
    setError('');
    if (what === 'seo') {
      const p = useStore.getState().projects.find((x) => x.id === projectId);
      const has = !!p?.marketing.salesPage || !!p?.marketing.seoHtml?.active;
      if (has && !(await confirmAction({ title: `Use ${name}’s page as your SEO page?`, body: 'Your current page is kept: switch back under Version, or Undo.', confirmLabel: 'Use this page' }))) return;
    }
    setBusy(what);
    try {
      const src = await replyPageSource(projectId, m, page.at);
      if (what === 'preview') return openHtmlPreview({ title: `${name}’s page`, target: 'asset', src });
      // the importer cleans the page first; nothing is published
      const r = await applyAgentPage(projectId, what === 'asset' ? 'asset' : 'seo', src);
      if (!r.ok) setError(r.message);
      else onLeave?.();
    } catch (e) {
      setError(pageErrorText(e, via));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="flex w-full flex-col gap-1.5 rounded-md border border-line bg-surface-2/60 p-2">
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
        <FileCode size={13} className="shrink-0 text-muted" aria-hidden="true" />
        <span className="min-w-0 truncate" title={page.name}>
          {page.name}
        </span>
        {sizeText(page.bytes) && <span className="shrink-0 font-normal text-muted">· {sizeText(page.bytes)}</span>}
      </p>
      {why ? (
        <p className="text-[11.5px] text-warn">{why}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="btn btn-secondary btn-xs" disabled={!!busy} onClick={() => void run('preview')}>
            {busy === 'preview' ? <Spinner size={11} /> : <Eye size={12} aria-hidden="true" />} Preview
          </button>
          <button type="button" className="btn btn-secondary btn-xs" disabled={!!busy} onClick={() => void run('asset')}>
            {busy === 'asset' ? <Spinner size={11} /> : <PanelsTopLeft size={12} aria-hidden="true" />} Open as asset
          </button>
          <button type="button" className="btn btn-secondary btn-xs" disabled={!!busy} onClick={() => void run('seo')}>
            {busy === 'seo' ? <Spinner size={11} /> : <LayoutTemplate size={12} aria-hidden="true" />} Use as my SEO page
          </button>
        </div>
      )}
      {error && (
        <p className="text-[11.5px] text-bad" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function OtherFile({ m, f }: { m: ChatMessage; f: AgentFileMeta }) {
  const via = viaOf(m);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const get = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await download(safeFileName(f.name), await replyFile(m, f.id));
    } catch (e) {
      setError(agentErrorText(e, via).body);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex w-full flex-wrap items-center gap-1.5 rounded-md border border-line bg-surface-2/60 px-2 py-1.5 text-[12px]">
      <FileText size={13} className="shrink-0 text-muted" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-ink-2" title={f.name}>
        {f.name}
        {sizeText(f.bytes) && <span className="text-muted"> · {sizeText(f.bytes)}</span>}
      </span>
      {!m.gone && (
        <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => void get()} aria-label={`Download ${f.name}`}>
          {busy ? <Spinner size={11} /> : <Download size={12} aria-hidden="true" />} Download
        </button>
      )}
      {error && (
        <p className="basis-full text-[11.5px] text-bad" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Attachments({ m, projectId, onLeave }: { m: ChatMessage; projectId: string; onLeave?: () => void }) {
  const files = m.files ?? [];
  const pages = replyPages(m);
  const images = files.filter((f) => f.kind === 'image');
  const others = files.filter((f) => f.kind === 'other');
  if (!pages.length && !images.length && !others.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {images.map((f) => (
        <ReplyImage key={f.id} m={m} f={f} projectId={projectId} />
      ))}
      {pages.map((p) => (
        <PageChip key={p.at} m={m} page={p} projectId={projectId} onLeave={onLeave} />
      ))}
      {others.map((f) => (
        <OtherFile key={f.id} m={m} f={f} />
      ))}
    </div>
  );
}

// ───────────── the bubbles ─────────────

/**
 * A message from Manus or Viktor (or from someone in the Slack thread). `folded`: an opening or progress message
 * a result came after (shown on request). `answerable`: Manus's question with choices waits for the owner.
 */
export function ExternalMessage({ m, projectId, folded, answerable, onLeave }: { m: ChatMessage; projectId: string; folded?: boolean; answerable?: boolean; onLeave?: () => void }) {
  const via = viaOf(m);
  const name = agentName(via);
  const [shown, setShown] = useState(false);
  const [answering, setAnswering] = useState('');
  const Icon = ICON[via];
  const who = m.from === 'you-in-slack' ? 'You (in Slack)' : m.from === 'other' ? 'Someone in the thread' : `From ${name}`;
  if (folded && !shown) {
    return (
      <button type="button" className="mr-auto inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11.5px] text-muted hover:text-ink" aria-expanded={false} onClick={() => setShown(true)}>
        <Icon size={12} aria-hidden="true" /> {name} is working: show
      </button>
    );
  }
  const answer = async (option: string) => {
    if (answering) return;
    setAnswering(option);
    try {
      await answerManus(projectId, option);
    } finally {
      setAnswering('');
    }
  };
  return (
    <div role="group" aria-label={who} className={cn('mr-auto flex w-full max-w-[92%] flex-col gap-1.5 rounded-2xl rounded-bl-md border border-line-2 bg-surface px-3 py-2', m.from === 'other' && 'border-dashed')}>
      <p className="flex flex-wrap items-center gap-x-1.5 text-[11.5px] font-semibold text-muted">
        <Icon size={12} aria-hidden="true" className={m.from === 'you-in-slack' ? 'opacity-60' : 'text-primary'} />
        {who}
        {m.via === 'viktor' && !!m.agentRef?.edited && !m.gone && <span className="font-normal">· edited in Slack</span>}
        {m.agentRef?.where === 'top' && <span className="font-normal">· in your DM, not the thread</span>}
      </p>
      {m.gone && <p className="text-[12px] font-semibold text-warn">Deleted in Slack</p>}
      {m.text && <ChatText text={m.text} appLinks={false} className={cn(m.gone && 'opacity-60')} />}
      {m.from !== 'other' && <Attachments m={m} projectId={projectId} onLeave={onLeave} />}
      {answerable && !!m.options?.length && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Answer ${name}`}>
          {m.options.map((o) => (
            <button key={o} type="button" className="chip h-auto max-w-full whitespace-normal py-1 text-left" disabled={!!answering} onClick={() => void answer(o)}>
              {answering === o && <Spinner size={11} />}
              {o}
            </button>
          ))}
          <span className="basis-full text-[11px] text-muted">Or answer in your own words below.</span>
        </div>
      )}
    </div>
  );
}

/** The owner's message to Manus or Viktor: where it went, and whether it arrived. */
export function AgentUserMessage({ m, projectId }: { m: ChatMessage; projectId: string }) {
  const name = agentName(viaOf(m));
  const [busy, setBusy] = useState(false);
  const act = async (f: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };
  const failed = m.delivery === 'failed';
  return (
    <div className="ml-auto flex max-w-[85%] flex-col items-end gap-1">
      <p className="text-[11px] text-muted">
        To {name}
        {m.drafted && <> · Drafted by the assistant{failed ? '' : ' · sent by you'}</>}
      </p>
      <div className="flex flex-col gap-1.5 whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3 py-2 text-[13.5px] text-on-primary">
        {m.text}
        {!!m.images?.length && (
          <span className="flex flex-wrap gap-1">
            {m.images.map((i) => (
              <span key={i.key} title={`Image ${i.key.replace('img-', '')}`}>
                <MediaThumb media={i.media} className="h-10 w-10" />
              </span>
            ))}
          </span>
        )}
        {m.website && (
          <span className="inline-flex items-center gap-1 text-[11.5px] opacity-85">
            <Globe size={11} aria-hidden="true" /> With your website
          </span>
        )}
      </div>
      <p className={cn('flex flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 text-right text-[11px]', failed ? 'text-bad' : m.delivery === 'unknown' ? 'text-warn' : 'text-muted')} role={failed ? 'alert' : undefined}>
        {m.delivery === 'sending' && (
          <>
            <Spinner size={11} /> Sending…
          </>
        )}
        {m.delivery === 'sent' && (
          <>
            <Check size={12} aria-hidden="true" /> Sent<span className="sr-only"> to {name}</span>
          </>
        )}
        {m.delivery === 'unknown' && (
          <>
            <CircleAlert size={12} aria-hidden="true" />
            <span>{m.deliveryNote || 'May have been delivered.'}</span>
            <button type="button" className="btn btn-secondary btn-xs" disabled={busy} onClick={() => void act(() => checkDelivery(projectId, m.id))}>
              {busy ? <Spinner size={11} /> : <RotateCw size={11} aria-hidden="true" />} Check
            </button>
          </>
        )}
        {failed && (
          <>
            <CircleAlert size={12} aria-hidden="true" />
            <span>{m.deliveryNote || 'Not sent.'}</span>
            {m.undelivered && (
              <button type="button" className="btn btn-secondary btn-xs" disabled={busy} onClick={() => void act(() => sendAgain(projectId, m.id))}>
                {busy ? <Spinner size={11} /> : <RotateCw size={11} aria-hidden="true" />} Send again
              </button>
            )}
          </>
        )}
      </p>
    </div>
  );
}
