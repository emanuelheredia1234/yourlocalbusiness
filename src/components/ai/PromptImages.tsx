import { useCallback, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { MediaRef, PromptImage } from '@/lib/types';
import { cn, plural } from '@/lib/utils';
import { deleteBlob, saveMediaFile } from '@/lib/storage';
import { MAX_PROMPT_IMAGES, PROMPT_IMAGE_ACCEPT, imageKeyNumber, planPromptImages, promptImageRefusal, reportRefusals, type RefusalCounts } from '@/lib/promptImages';
import { toast } from '@/store/ui';
import { MediaDrop, MediaThumb } from '@/components/media/MediaUpload';
import { Spinner } from '@/components/ui/primitives';

/**
 * Images pasted or dropped on a text box (spread the handlers on it). Only JPEG, PNG, WebP and GIF
 * files are saved, at most `room` of them; `onFiles` gets the saved images, e.g. for addPromptImages.
 * Pasting text that also carries a picture of itself (copied from Word or Excel) pastes the text.
 */
export function usePasteImages(onFiles: (media: MediaRef[]) => void, opts: { room?: number; max?: number; disabled?: boolean; onBusy?: (busy: boolean) => void } = {}) {
  const latest = useRef({ onFiles, opts });
  latest.current = { onFiles, opts };

  const take = useCallback(async (files: File[]) => {
    const { room = MAX_PROMPT_IMAGES, max = MAX_PROMPT_IMAGES, onBusy } = latest.current.opts;
    const refused: RefusalCounts = {};
    const ok: File[] = [];
    for (const f of files) {
      const why = promptImageRefusal(f.type) ?? (ok.length >= Math.max(0, room) ? 'full' : null);
      if (why) refused[why] = (refused[why] ?? 0) + 1;
      else ok.push(f);
    }
    reportRefusals(refused, max);
    if (!ok.length) return;
    onBusy?.(true);
    const media: MediaRef[] = [];
    try {
      for (const f of ok) {
        try {
          media.push(await saveMediaFile(f));
        } catch (e) {
          toast({ kind: 'error', title: `Couldn’t add ${f.name || 'that image'}`, body: (e as Error).message });
        }
      }
    } finally {
      onBusy?.(false);
    }
    if (media.length) latest.current.onFiles(media);
  }, []);

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLElement>) => {
      if (latest.current.opts.disabled) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (!files.length || e.clipboardData.getData('text/plain').trim()) return;
      e.preventDefault();
      void take(files);
    },
    [take],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      if (latest.current.opts.disabled) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      void take(files);
    },
    [take],
  );

  const onDragOver = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (latest.current.opts.disabled || !Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    // without this the browser opens a dropped file instead of handing it to the text box
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  return { onPaste, onDrop, onDragOver };
}

/**
 * The images in a prompt box: a thumbnail of each with an optional note for the AI ("what it shows or
 * where it goes") and Remove, then "Add images". The AI and the page refer to each by its number
 * ({{img-N}}), which stays the same when others are removed.
 */
export function PromptImages({
  images,
  onChange,
  max = MAX_PROMPT_IMAGES,
  reserved,
  busy,
  disabled,
  label,
  hint,
  className,
}: {
  images: PromptImage[];
  onChange: (images: PromptImage[]) => void;
  max?: number;
  /** keys the code still uses, which a new image mustn't take */
  reserved?: readonly string[];
  /** an image pasted or dropped on the text box is being saved (usePasteImages' onBusy) */
  busy?: boolean;
  disabled?: boolean;
  label?: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  const base = useId();
  const latest = useRef({ images, onChange });
  latest.current = { images, onChange };

  const add = (media: MediaRef[]) => {
    const plan = planPromptImages(latest.current.images, media, { max, reserved });
    reportRefusals(plan.refused, max);
    // these were saved just now: don't keep (or upload) the ones that couldn't be added
    for (const m of media) if (!plan.added.some((a) => a.media.id === m.id)) void deleteBlob(m.id);
    if (plan.added.length) latest.current.onChange(plan.images);
  };
  const setNote = (key: string, note: string) => onChange(images.map((i) => (i.key === key ? { ...i, note } : i)));
  const tidyNote = (key: string) =>
    onChange(
      images.map((i) => {
        if (i.key !== key) return i;
        const note = i.note?.trim();
        const { note: _old, ...rest } = i;
        return note ? { ...rest, note } : rest;
      }),
    );
  const remove = (key: string) => onChange(images.filter((i) => i.key !== key));

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      {label && <p className="label mb-0">{label}</p>}
      {images.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Images for the AI">
          {images.map((img) => {
            const n = imageKeyNumber(img.key);
            const noteId = `${base}-${img.key}`;
            return (
              <li key={img.key} className="flex items-center gap-2.5 rounded-md border border-line bg-surface p-1.5 pr-2">
                <MediaThumb media={img.media} className="h-12 w-12 shrink-0" />
                <div className="min-w-0 flex-1">
                  <label htmlFor={noteId} className="mb-0.5 block text-[11.5px] font-semibold text-ink-2">
                    Image {n}
                  </label>
                  <input
                    id={noteId}
                    className="input input-sm"
                    value={img.note ?? ''}
                    maxLength={200}
                    placeholder="What it shows or where it goes (optional)"
                    disabled={disabled}
                    onChange={(e) => setNote(img.key, e.target.value)}
                    onBlur={() => tidyNote(img.key)}
                  />
                </div>
                <button type="button" className="btn btn-ghost btn-icon btn-xs shrink-0 text-muted hover:text-bad" aria-label={`Remove image ${n}`} title="Remove" disabled={disabled} onClick={() => remove(img.key)}>
                  <X size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {!disabled &&
        (images.length < max ? (
          <MediaDrop compact multiple accept={PROMPT_IMAGE_ACCEPT} label={images.length ? 'Add more images' : 'Add images'} sub={`JPEG, PNG, WebP or GIF · up to ${max}`} onFiles={add} />
        ) : (
          <p className="hint mt-0">That’s {plural(max, 'image')}, the most for one page. Remove one to add another.</p>
        ))}
      {busy && (
        <p className="flex items-center gap-1.5 text-xs text-muted" role="status">
          <Spinner size={12} /> Adding your image…
        </p>
      )}
      {hint && <p className="hint mt-0">{hint}</p>}
    </div>
  );
}
