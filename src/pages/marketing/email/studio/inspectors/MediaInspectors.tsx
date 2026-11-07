// Inspectors for pictures: image blocks (upload, generate with AI, or in the claude.ai build an https address),
// video blocks (the video's address and a thumbnail with a play badge) and offer cards (one of the business's
// offers). Uploads and AI pictures need the app's own server and are hidden in the claude.ai build.

import { useId, useState } from 'react';
import { ImageUp, RefreshCw } from 'lucide-react';
import type { ImageBlock, OfferBlock, VideoBlock } from '../../../../../../shared/email/blocks.mjs';
import type { MediaRef } from '@/lib/types';
import { useProjectOffers } from '@/store/offers';
import { offerPrice } from '@/lib/offers';
import { imageErrorMessage } from '@/ai/image';
import { GenerateButton } from '@/components/ai/AI';
import { AutoTextarea, Callout, Field, Segmented, Spinner } from '@/components/ui/primitives';
import { LinkPicker } from '../LinkPicker';
import { generateEmailMedia, uploadEmailImage, uploadMedia, withPlayBadge, type HostedImage } from '../images';
import type { InspectorProps } from './TextInspectors';

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : 'That didn’t work. Try again.');

/** "Upload" (a file input) for a picture; hidden in the claude.ai build. */
function UploadButton({ label = 'Upload', onFile, busy }: { label?: string; onFile: (f: File) => void; busy?: boolean }) {
  if (__ARTIFACT_BUILD__) return null;
  return (
    <label className="btn btn-secondary btn-xs cursor-pointer">
      {busy ? <Spinner size={14} /> : <ImageUp aria-hidden="true" />} {label}
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
    </label>
  );
}

/** An https address the owner types (the claude.ai build's only way to add a picture). */
function UrlInput({ value, onChange, label = 'Image address' }: { value: string; onChange: (v: string) => void; label?: string }) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} hint="An https:// address of a picture that is online.">
      <input id={id} className="input font-mono" placeholder="https://" value={value} onChange={(e) => onChange(e.target.value.trim())} />
    </Field>
  );
}

export function ImageInspector({ project, block, onChange }: InspectorProps<ImageBlock>) {
  const ids = useId();
  const [busy, setBusy] = useState<'' | 'upload' | 'ai'>('');
  const [error, setError] = useState('');
  const [made, setMade] = useState<MediaRef | null>(null);
  const [prompt, setPrompt] = useState(block.prompt ?? '');
  const place = (img: HostedImage, origin: ImageBlock['origin']) => onChange({ src: img.src, origin, w: img.w, h: img.h, prompt: undefined });

  const upload = async (f: File) => {
    setBusy('upload');
    setError('');
    try {
      place(await uploadEmailImage(f, f.name), 'upload');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };
  // one generation per press; a failed upload keeps the picture for "Upload again" (never made again by itself)
  const generate = async () => {
    setBusy('ai');
    setError('');
    let media: MediaRef | null = null;
    try {
      media = await generateEmailMedia(project, prompt.trim() || block.alt || project.brand.name);
      setMade(media);
      place(await uploadMedia(media), 'ai');
      setMade(null);
    } catch (e) {
      setError(media ? `The picture was made and is kept on this device, but it couldn’t be uploaded: ${errText(e)}` : imageErrorMessage(e).body || errText(e));
    } finally {
      setBusy('');
    }
  };
  const uploadAgain = async () => {
    if (!made) return;
    setBusy('upload');
    setError('');
    try {
      place(await uploadMedia(made), 'ai');
      setMade(null);
    } catch (e) {
      setError(`It still couldn’t be uploaded: ${errText(e)}`);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="grid gap-3">
      {__ARTIFACT_BUILD__ ? (
        <UrlInput value={block.src} onChange={(src) => onChange({ src, origin: 'url' })} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <UploadButton onFile={(f) => void upload(f)} busy={busy === 'upload'} />
          {made && (
            <button type="button" className="btn btn-secondary btn-xs" disabled={!!busy} onClick={() => void uploadAgain()}>
              <RefreshCw aria-hidden="true" /> Upload again
            </button>
          )}
        </div>
      )}
      {!__ARTIFACT_BUILD__ && (
        <Field label="Generate with AI" htmlFor={`${ids}-prompt`} hint="Uses AI credits for one picture.">
          <AutoTextarea id={`${ids}-prompt`} value={prompt} onChange={setPrompt} minRows={2} placeholder="What the picture shows" />
          <GenerateButton size="sm" className="mt-2" running={busy === 'ai'} runningLabel="Making the picture…" onClick={() => void generate()}>
            {block.prompt && !block.src ? 'Generate this image' : 'Generate'}
          </GenerateButton>
        </Field>
      )}
      {error && <Callout tone="bad">{error}</Callout>}
      <Field
        label="Description (alt text)"
        htmlFor={`${ids}-alt`}
        hint="Required: read aloud by screen readers and shown when pictures are off."
        error={block.src && !block.alt.trim() ? 'Add a short description.' : undefined}
      >
        <input id={`${ids}-alt`} className="input" value={block.alt} maxLength={200} onChange={(e) => onChange({ alt: e.target.value })} />
      </Field>
      <Segmented<'full' | 'fixed'>
        size="sm"
        aria-label="Width"
        value={block.width === 'full' ? 'full' : 'fixed'}
        onChange={(v) => onChange({ width: v === 'full' ? 'full' : 300 })}
        options={[
          { id: 'full', label: 'Full width' },
          { id: 'fixed', label: 'Fixed width' },
        ]}
      />
      {block.width !== 'full' && (
        <Field label={`Width: ${block.width}px`} htmlFor={`${ids}-w`}>
          <input id={`${ids}-w`} type="range" min={80} max={600} step={10} value={block.width} onChange={(e) => onChange({ width: Number(e.target.value) })} className="w-full" />
        </Field>
      )}
      <label className="flex items-center gap-2 text-small text-ink-2">
        <input type="checkbox" checked={!!block.link} onChange={(e) => onChange({ link: e.target.checked ? { kind: 'page' } : undefined })} /> The picture is a link
      </label>
      {block.link && <LinkPicker project={project} value={block.link} onChange={(link) => onChange({ link })} label="Picture link" />}
    </div>
  );
}

export function VideoInspector({ block, onChange }: InspectorProps<VideoBlock>) {
  const ids = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const thumb = async (f: File) => {
    setBusy(true);
    setError('');
    try {
      const img = await uploadEmailImage(await withPlayBadge(f), 'video-thumbnail.png');
      onChange({
        thumb: { src: img.src, alt: block.thumb.alt || 'Play the video' },
      });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-3">
      <Field label="Video address" htmlFor={`${ids}-url`} hint="Where the video plays (YouTube, Vimeo, your page). Emails can’t play video: the thumbnail links to it.">
        <input id={`${ids}-url`} className="input font-mono" placeholder="https://" value={block.link.url} onChange={(e) => onChange({ link: { kind: 'url', url: e.target.value.trim() } })} />
      </Field>
      {__ARTIFACT_BUILD__ ? (
        <UrlInput label="Thumbnail address" value={block.thumb.src} onChange={(src) => onChange({ thumb: { ...block.thumb, src } })} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <UploadButton label="Upload a thumbnail" onFile={(f) => void thumb(f)} busy={busy} />
          <span className="text-caption text-muted">A play button is drawn on it.</span>
        </div>
      )}
      {error && <Callout tone="bad">{error}</Callout>}
      <Field label="Thumbnail description" htmlFor={`${ids}-alt`}>
        <input id={`${ids}-alt`} className="input" value={block.thumb.alt} onChange={(e) => onChange({ thumb: { ...block.thumb, alt: e.target.value } })} />
      </Field>
      <Field label="Caption" htmlFor={`${ids}-cap`}>
        <input id={`${ids}-cap`} className="input" value={block.caption ?? ''} onChange={(e) => onChange({ caption: e.target.value || undefined })} />
      </Field>
    </div>
  );
}

export function OfferInspector({ project, block, onChange }: InspectorProps<OfferBlock>) {
  const ids = useId();
  const { on, offers, loaded } = useProjectOffers(project.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choose = (id: string) => {
    const o = offers.find((x) => x.id === id);
    if (o) onChange({ offerId: o.id, title: o.title, price: offerPrice(o) });
  };
  const upload = async (f: File) => {
    setBusy(true);
    setError('');
    try {
      const img = await uploadEmailImage(f, f.name);
      onChange({
        image: { src: img.src, alt: block.image?.alt || block.title },
      });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!on && !block.offerId) return <Callout tone="info">Offers need the app’s own server and a signed-in account. Add one under Studio › Offers, then pick it here.</Callout>;
  return (
    <div className="grid gap-3">
      <Field label="Offer" htmlFor={`${ids}-offer`} hint={loaded && !offers.length ? 'This business has no offers yet.' : 'The button always opens this offer’s buy link.'}>
        <select id={`${ids}-offer`} className="select" value={block.offerId} onChange={(e) => choose(e.target.value)}>
          {!offers.some((o) => o.id === block.offerId) && <option value={block.offerId}>{block.offerId ? block.title || 'This offer' : 'Choose an offer…'}</option>}
          {offers.map((o) => (
            <option key={o.id} value={o.id}>
              {o.title}
              {offerPrice(o) ? ` · ${offerPrice(o)}` : ''}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Description" htmlFor={`${ids}-blurb`}>
        <AutoTextarea id={`${ids}-blurb`} value={block.blurb ?? ''} onChange={(v) => onChange({ blurb: v || undefined })} minRows={2} />
      </Field>
      <Field label="Button label" htmlFor={`${ids}-btn`}>
        <input id={`${ids}-btn`} className="input" value={block.buttonLabel} onChange={(e) => onChange({ buttonLabel: e.target.value })} />
      </Field>
      {__ARTIFACT_BUILD__ ? (
        <UrlInput
          label="Picture address"
          value={block.image?.src ?? ''}
          onChange={(src) =>
            onChange({
              image: src ? { src, alt: block.image?.alt || block.title } : undefined,
            })
          }
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <UploadButton label={block.image ? 'Change the picture' : 'Add a picture'} onFile={(f) => void upload(f)} busy={busy} />
          {block.image && (
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => onChange({ image: undefined })}>
              Remove the picture
            </button>
          )}
        </div>
      )}
      {error && <Callout tone="bad">{error}</Callout>}
    </div>
  );
}
