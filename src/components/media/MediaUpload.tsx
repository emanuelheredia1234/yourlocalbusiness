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
    <div className={cn('group relative overflow-hidden rounded-md border border-line bg-surface-2', className)}>
      {media.kind === 'video' ? (
        url && !url.startsWith('data:') ? <video src={url} muted playsInline className="h-full w-full object-cover" /> : <img src={media.thumb} alt="" className="h-full w-full object-cover" />
      ) : (
        url && <img src={url} alt={media.name} className="h-full w-full object-cover" />
      )}
      {media.kind === 'video' && (
        <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">
          <Video size={10} /> Video
        </span>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} className="absolute right-1.5 top-1.5 rounded bg-black/60 p-1 text-white opacity-0 transition-opacity hover:bg-black/80 focus:opacity-100 group-hover:opacity-100" aria-label={`Remove ${media.name}`}>
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

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
  return (
    <div
      className={cn('relative flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed text-center transition-colors', drag ? 'border-primary bg-primary-soft' : 'border-line-2 hover:border-ink/30 hover:bg-surface-2', compact ? 'px-3 py-4' : 'px-4 py-7', className)}
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
      {busy ? <Spinner size={20} className="text-primary" /> : <ImagePlus size={compact ? 18 : 22} className="text-muted" />}
      <span className="text-[13px] font-semibold text-ink">{label ?? (multiple ? 'Drop images or videos' : 'Drop an image or video')}</span>
      <span className="text-xs text-muted">{sub ?? `or click to browse · up to ${fmtBytes(60 * 1024 * 1024)}`}</span>
      <input ref={input} type="file" accept={accept} multiple={multiple} className="hidden" onChange={(e) => handle(e.target.files)} />
    </div>
  );
}
