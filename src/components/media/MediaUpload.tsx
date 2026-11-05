import { useRef, useState } from 'react';
import { ImagePlus, Trash2, Video } from 'lucide-react';
import type { MediaRef } from '@/lib/types';
import { cn, fmtBytes } from '@/lib/utils';
import { saveMediaFile } from '@/lib/storage';
import { useMediaUrl } from '@/lib/media';
import { toast } from '@/store/ui';
import { Spinner } from '../ui/primitives';

export function MediaThumb({ media, className, onRemove }: { media: MediaRef; className?: string; onRemove?: () => void }) {
  const url = useMediaUrl(media);
  return (
    <div className={cn('group relative overflow-hidden rounded-md bg-surface-2', className)}>
      {media.kind === 'video' ? (
        url && !url.startsWith('data:') ? <video src={url} muted playsInline className="h-full w-full object-cover" /> : <img src={media.thumb} alt="" className="h-full w-full object-cover" />
      ) : (
        url && <img src={url} alt={media.name} className="h-full w-full object-cover" />
      )}
      {/* the hairline is an overlay: an inset ring would be painted under the image */}
      <span className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-ink/5" aria-hidden="true" />
      {media.kind === 'video' && (
        <span data-media className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-micro text-white">
          <Video size={10} aria-hidden="true" /> Video
        </span>
      )}
      {onRemove && (
        <button type="button" data-media onClick={onRemove} className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded bg-black/60 text-white opacity-0 transition-opacity duration-120 hover:bg-black/80 focus:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100" aria-label={`Remove ${media.name}`}>
          <Trash2 size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * The drop zone for images and videos (the only dashed border in the app). `compact` is a one-line
 * row with a 40px tile.
 */
export function MediaDrop({ onFiles, accept = 'image/*,video/*', multiple = false, label, sub, compact, className }: { onFiles: (media: MediaRef[]) => void; accept?: string; multiple?: boolean; label?: string; sub?: string; compact?: boolean; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const handle = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    const out: MediaRef[] = [];
    for (const f of Array.from(files).slice(0, multiple ? 12 : 1)) {
      try {
        out.push(await saveMediaFile(f));
      } catch (e) {
        toast({ kind: 'error', title: `Couldn’t add ${f.name}`, body: (e as Error).message });
      }
    }
    setBusy(false);
    if (out.length) onFiles(out);
  };
  const what = multiple ? (accept.startsWith('image/') && !accept.includes('video') ? 'images' : 'images or videos') : accept.startsWith('image/') && !accept.includes('video') ? 'an image' : 'an image or video';
  const title = label ?? (
    <>
      Drop {what} or <span className="font-medium text-primary">browse</span>
    </>
  );
  const note = sub ?? `Up to ${fmtBytes(60 * 1024 * 1024)}`;
  const icon = busy ? <Spinner size={20} className="text-primary" /> : <ImagePlus size={20} className="text-muted" aria-hidden="true" />;
  return (
    <div
      className={cn(
        'relative flex cursor-pointer rounded-pop border-[1.5px] border-dashed transition-colors duration-120',
        drag ? 'border-ring bg-primary-soft' : 'border-line-3 bg-surface-2 hover:bg-surface-3/60',
        compact ? 'items-center gap-3 px-3 py-2.5 text-left' : 'flex-col items-center justify-center gap-1.5 px-4 py-7 text-center',
        className,
      )}
      onClick={() => input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        handle(e.dataTransfer.files);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
    >
      {compact ? <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface">{icon}</span> : icon}
      <span className={cn('min-w-0', compact && 'flex flex-col')}>
        <span className="block text-small text-ink">{title}</span>
        <span className="block text-caption text-muted">{note}</span>
      </span>
      <input ref={input} type="file" accept={accept} multiple={multiple} className="hidden" onChange={(e) => handle(e.target.files)} />
    </div>
  );
}
