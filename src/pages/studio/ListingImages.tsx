import { forwardRef, useMemo, useRef, useState, type ReactNode } from 'react';
import { Camera, ChevronDown, Download, ImagePlus, Images, Palette, PenLine, Star, Type, Upload } from 'lucide-react';
import type { ImageKind, ListingShotId, MediaRef, Project } from '@/lib/types';
import { cn } from '@/lib/utils';
import { getBlob } from '@/lib/storage';
import { isOwnPhoto } from '@/lib/media';
import { galleryIds, MAX_GALLERY } from '@/lib/listing';
import { composeOwnListingPhoto, defaultImageKind, listingShots, photoLabel, photoRoute, photoSourceNote, type ListingShot } from '@/ai/image';
import { fromOwnPhoto, listingShotMedia, PHOTO_ACCEPT } from '@/ai/listingPhotos';
import { ALL_SHOTS, listingPendingKey, makeListingShot, ownPhotoPlaced, placeListingShot, savePhotoFile, shotText } from '@/ai/listingImages';
import { pendingManus, type ManusTask } from '@/ai/manus';
import { openPage } from '@/ai/assistant/nav';
import { ManusLink } from '@/components/images/PostImagePanel';
import { getActiveProject, useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { AIThinking, GenerateButton, Spark } from '@/components/ai/AI';
import { download } from '@/components/ui/download';
import { AutoTextarea, Badge, Callout, InfoTip, Menu, Modal, MoreMenu, Segmented, Spinner, type MenuEntry } from '@/components/ui/primitives';
import { MediaThumb } from '@/components/media/MediaUpload';
import { artDirectionLabel, useArtDirection, useImageJob, usePhotoAvailability } from '@/components/images/useImageJob';

const andList = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * Adds your own photos. Only JPG, PNG and WebP: HEIC (the iPhone default) can't be opened in most
 * browsers, so it is turned away with a note instead of failing later.
 */
export function PhotoUploadButton({ onPhotos, multiple, label, ariaLabel, className, disabled }: { onPhotos: (media: MediaRef[]) => void; multiple?: boolean; label: string; ariaLabel?: string; className?: string; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const add = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    const out = await savePhotos(files, multiple);
    setBusy(false);
    if (out.length) onPhotos(out);
  };
  return (
    <>
      <button type="button" className={className ?? 'btn btn-secondary btn-xs'} disabled={disabled || busy} aria-label={ariaLabel} onClick={() => input.current?.click()}>
        {busy ? <Spinner size={12} /> : <Upload />} {label}
      </button>
      <PhotoInput ref={input} multiple={multiple} onFiles={(files) => void add(files)} />
    </>
  );
}

/** Your photos, saved (each one that can't be says why). */
async function savePhotos(files: File[], multiple?: boolean): Promise<MediaRef[]> {
  const out: MediaRef[] = [];
  for (const f of files.slice(0, multiple ? 12 : 1)) {
    try {
      out.push(await savePhotoFile(f));
    } catch (e) {
      toast({ kind: 'error', title: `Couldn’t add ${f.name}`, body: (e as Error).message });
    }
  }
  return out;
}

/** The hidden file picker for your photos (JPG, PNG or WebP). */
const PhotoInput = forwardRef<HTMLInputElement, { multiple?: boolean; onFiles: (files: File[]) => void }>(function PhotoInput({ multiple, onFiles }, ref) {
  return (
    <input
      ref={ref}
      type="file"
      accept={PHOTO_ACCEPT}
      multiple={multiple}
      className="hidden"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(e) => {
        const files = Array.from(e.target.files ?? []);
        // let the same file be picked again later
        e.target.value = '';
        onFiles(files);
      }}
    />
  );
});

/** What a listing image offers: its Replace menu (make or upload one, your details, its description) and its ⋯ menu. */
export type ShotAction = 'generate' | 'regenerate' | 'generate-instead' | 'upload' | 'add-details' | 'update-details' | 'describe' | 'make-cover' | 'add-to-gallery' | 'remove-from-gallery' | 'download';

export const SHOT_ACTION_LABEL: Record<ShotAction, string> = {
  generate: 'Generate',
  regenerate: 'Regenerate',
  'generate-instead': 'Generate instead',
  upload: 'Upload my photo',
  'add-details': 'Add my details',
  'update-details': 'Update my details',
  describe: 'Edit description',
  'make-cover': 'Make cover',
  'add-to-gallery': 'Add to gallery',
  'remove-from-gallery': 'Remove from gallery',
  download: 'Download',
};

/**
 * The actions a listing image offers, in menu order (the component adds what each one does). Your details can go
 * on your own photo for the checklist and offer graphics only.
 */
export function shotActions(project: Project, shot: ListingShot): { replace: ShotAction[]; more: ShotAction[] } {
  const m = listingShotMedia(project, shot.id);
  const own = fromOwnPhoto(m);
  const isCover = !!m && project.studio.listing.coverImageId === m.id;
  const inGallery = !!m && galleryIds(project).includes(m.id);
  const details = shot.layout !== 'clean' && !!m && (isOwnPhoto(m) || (own && !!m.generated?.artId));
  return {
    replace: [own ? 'generate-instead' : m ? 'regenerate' : 'generate', 'upload', ...(details ? [isOwnPhoto(m) ? ('add-details' as const) : ('update-details' as const)] : []), 'describe'],
    more: m ? [...(isCover ? [] : (['make-cover', inGallery ? 'remove-from-gallery' : 'add-to-gallery'] as const)), 'download'] : [],
  };
}

export function ListingImages({ project, children }: { project: Project; children?: ReactNode }) {
  const updateStudio = useStore((s) => s.updateStudio);
  const photo = usePhotoAvailability();
  const shots = useMemo(() => listingShots(project), [project]);
  const [kind, setKind] = useState<ImageKind>(() => defaultImageKind());
  const [describing, setDescribing] = useState<ListingShotId | null>(null);
  const [busy, setBusy] = useState<ListingShotId[]>([]);
  const [composing, setComposing] = useState<ListingShotId | null>(null);
  const [progress, setProgress] = useState('');
  const [tasks, setTasks] = useState<Partial<Record<ListingShotId, ManusTask>>>({});
  const pendingKey = (shot: ListingShotId) => listingPendingKey(project.id, shot);
  // Manus images started before a reload, still on their way
  const [resumable, setResumable] = useState<Partial<Record<ListingShotId, ManusTask>>>(() => {
    const r: Partial<Record<ListingShotId, ManusTask>> = {};
    for (const id of ALL_SHOTS) {
      const t = pendingManus.get(listingPendingKey(project.id, id));
      if (t) r[id] = t;
    }
    return r;
  });
  const job = useImageJob('Listing images');
  const art = useArtDirection('listing');
  const effKind: ImageKind = kind === 'photo' && !photo.ok ? 'illustration' : kind;
  // photos from an image API come back in seconds, so a set is made all at once (Manus tasks one by one)
  const fastPhotos = effKind === 'photo' && (photoRoute() === 'muse' || photoRoute() === 'server');
  const d = project.studio.listing;
  const isBiz = project.track === 'business';
  // "Generate images" leaves the shots that show your own photo alone
  const keepOwn = shots.filter((s) => fromOwnPhoto(listingShotMedia(project, s.id))).map((s) => s.id);
  const toMake = shots.map((s) => s.id).filter((id) => !keepOwn.includes(id));
  const labelOf = (id: ListingShotId) => shots.find((s) => s.id === id)?.label ?? id;
  const described = shots.find((s) => s.id === describing);

  /** Keep an edited image description with the listing; the suggested one when it matches again. */
  const setPrompt = (shot: ListingShot, v: string | undefined) => {
    const draft = getActiveProject()!.studio.listing;
    const next = { ...draft.shotPrompts };
    if (v === undefined || v === shot.prompt) delete next[shot.id];
    else next[shot.id] = v;
    updateStudio({ listing: { ...draft, shotPrompts: Object.keys(next).length ? next : undefined } });
  };

  const makeOne = (shot: ListingShot, signal: AbortSignal, onStage: (s: string) => void, resume?: ManusTask) =>
    makeListingShot({ shot, kind: effKind, signal, onStage, onTask: (t) => setTasks((x) => ({ ...x, [shot.id]: t })), resume });

  const generate = async (ids: ListingShotId[], resume?: Partial<Record<ListingShotId, ManusTask>>) => {
    const list = shots.filter((s) => ids.includes(s.id));
    if (!list.length) return;
    const parallel = !!resume || fastPhotos;
    let made = 0;
    let note = '';
    setResumable({});
    setTasks({});
    await job.run(
      async (signal, onStage) => {
        if (parallel) {
          // remote images: all selected ones are made at the same time
          setBusy(list.map((s) => s.id));
          setProgress(list.length > 1 ? `${list.length} images` : list[0].label);
          const results = await Promise.allSettled(
            list.map((shot) =>
              makeOne(shot, signal, onStage, resume?.[shot.id]).finally(() => setBusy((b) => b.filter((x) => x !== shot.id))),
            ),
          );
          made = results.filter((r) => r.status === 'fulfilled').length;
          const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
          if (failed.length && !made) throw failed[0].reason;
          if (failed.length) note = `${failed.length} image${failed.length > 1 ? 's' : ''} didn’t finish: ${(failed[0].reason as Error)?.message ?? 'unknown error'}`;
          return made;
        }
        for (const [i, shot] of list.entries()) {
          if (signal.aborted) break;
          setBusy([shot.id]);
          setProgress(list.length > 1 ? `${i + 1} of ${list.length}: ${shot.label}` : shot.label);
          const r = await makeOne(shot, signal, onStage);
          note = r.art.note ?? note;
          made += 1;
        }
        return made;
      },
      (n) => ({ done: `${n} image${n === 1 ? '' : 's'} added to your listing`, note }),
    );
    setBusy([]);
    setProgress('');
    if (made) {
      const p = getActiveProject()!;
      const hero = listingShotMedia(p, 'hero');
      const heroIsCover = list.some((s) => s.id === 'hero') && !!hero && p.studio.listing.coverImageId === hero.id;
      toast({ kind: 'success', title: `${made} listing image${made === 1 ? '' : 's'} ready`, body: heroIsCover ? 'The new cover image is set. Publish or update the listing to show it to buyers.' : 'Publish or update the listing to show them to buyers.' });
    }
  };

  /** Put a photo you uploaded on a shot. */
  const putOwnPhoto = (shot: ListingShot, media: MediaRef) => {
    toast({ kind: 'success', ...ownPhotoPlaced(shot.label, placeListingShot(shot.id, media)) });
  };

  /** Typeset your title, checklist or price on your own photo (no AI); the photo itself stays as it is. */
  const addDetails = async (shot: ListingShot, photoId: string) => {
    setComposing(shot.id);
    try {
      const p = getActiveProject()!;
      const media = await composeOwnListingPhoto({ project: p, shot, photoId, text: shotText(p, shot) });
      placeListingShot(shot.id, media);
      toast({ kind: 'success', title: 'Your details are on your photo', body: 'Your original photo stays in your brand images.' });
    } catch (e) {
      toast({ kind: 'error', title: 'Couldn’t add your details', body: (e as Error)?.message || 'Please try again.' });
    } finally {
      setComposing(null);
    }
  };

  const toggleGallery = (id: string) => {
    const p = getActiveProject()!;
    const g = galleryIds(p);
    if (g.includes(id)) updateStudio({ listing: { ...p.studio.listing, galleryIds: g.filter((x) => x !== id) } });
    else if (g.length >= MAX_GALLERY) toast({ kind: 'info', title: `Up to ${MAX_GALLERY} gallery images`, body: 'Remove one from the gallery first.' });
    else updateStudio({ listing: { ...p.studio.listing, galleryIds: [...g, id] } });
  };

  const save = async (m: MediaRef) => {
    const blob = await getBlob(m.id);
    if (blob) await download(m.name, blob);
  };

  const source = effKind === 'photo' ? photoSourceNote() : __ARTIFACT_BUILD__ ? 'Illustrations are drawn by Claude in your brand colors.' : 'Illustrations are drawn by your AI in your brand colors.';
  const artLine = effKind === 'photo' && art.skills.length > 0 ? artDirectionLabel(art.skills.map((k) => k.name)) : '';

  return (
    // the page's "Images" section (it holds the cover and gallery pickers too)
    <section className="mt-10 border-t border-line pt-8" aria-label="Listing images">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-h2 text-ink">Images</h2>
          <p className="mt-1 text-small text-muted">
            {isBiz ? 'A cover, your business at work and two branded graphics.' : 'A cover mockup, an in-use shot and two branded graphics.'} Or your own photos (JPG, PNG or WebP).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<ImageKind>
            size="sm"
            value={effKind}
            onChange={(v) => (v === 'photo' && !photo.ok ? undefined : setKind(v))}
            options={[
              { id: 'illustration', label: 'Illustration', icon: <Palette /> },
              { id: 'photo', label: <span className={cn(!photo.ok && 'text-faint')}>{photoLabel()}</span>, icon: <Camera className={cn(!photo.ok && 'text-faint')} /> },
            ]}
          />
          <InfoTip label="How listing images are made" link={!photo.ok && !__ARTIFACT_BUILD__ ? { label: 'Open Settings › AI keys', onClick: () => void openPage('workspace-settings', 'ai') } : undefined}>
            {!photo.ok && <span className="mb-1.5 block">{photo.reason}</span>}
            {source}
            {artLine && <span className="mt-1.5 block text-muted">{artLine}</span>}
          </InfoTip>
          <GenerateButton size="sm" running={job.running} runningLabel="Designing…" disabled={!toMake.length} onClick={() => void generate(toMake)}>
            {toMake.length === shots.length ? 'Generate images' : `Generate ${toMake.length} image${toMake.length === 1 ? '' : 's'}`}
          </GenerateButton>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
        {shots.map((shot) => {
          const m = listingShotMedia(project, shot.id);
          const own = fromOwnPhoto(m);
          const isCover = !!m && d.coverImageId === m.id;
          const inGallery = !!m && galleryIds(project).includes(m.id);
          const isBusy = (busy.includes(shot.id) && job.running) || composing === shot.id;
          const acts = shotActions(project, shot);
          // your details go on your own photo, or on the photo a details image was made from
          const detailsFrom = !m ? undefined : isOwnPhoto(m) ? m.id : own ? m.generated?.artId : undefined;
          const run: Record<ShotAction, () => void> = {
            generate: () => void generate([shot.id]),
            regenerate: () => void generate([shot.id]),
            'generate-instead': () => void generate([shot.id]),
            upload: () => undefined,
            'add-details': () => detailsFrom && void addDetails(shot, detailsFrom),
            'update-details': () => detailsFrom && void addDetails(shot, detailsFrom),
            describe: () => setDescribing(shot.id),
            'make-cover': () => m && updateStudio({ listing: { ...getActiveProject()!.studio.listing, coverImageId: m.id } }),
            'add-to-gallery': () => m && toggleGallery(m.id),
            'remove-from-gallery': () => m && toggleGallery(m.id),
            download: () => m && void save(m),
          };
          return (
            <ShotTile
              key={shot.id}
              shot={shot}
              media={m}
              own={own}
              isCover={isCover}
              inGallery={inGallery}
              busy={isBusy}
              task={tasks[shot.id]}
              actions={acts}
              disabled={job.running || isBusy}
              run={run}
              onPhoto={(media) => putOwnPhoto(shot, media)}
            />
          );
        })}
      </div>

      <div className="mt-4 flex flex-col gap-3 empty:hidden">
        {keepOwn.length > 0 && (
          <p className="text-small text-muted" role="note">
            {keepOwn.length === 1 ? 'Your photo stays' : 'Your photos stay'} on {andList(keepOwn.map(labelOf))}. To replace {keepOwn.length === 1 ? 'it' : 'one'}, use “Generate instead” on its card.
          </p>
        )}
        {Object.keys(resumable).length > 0 && !job.running && (
          <Callout
            tone="info"
            onDismiss={() => {
              for (const id of Object.keys(resumable)) pendingManus.clear(pendingKey(id as ListingShotId));
              setResumable({});
            }}
            action={
              <button type="button" className="btn btn-secondary btn-xs" onClick={() => void generate(Object.keys(resumable) as ListingShotId[], resumable)}>
                Pick {Object.keys(resumable).length === 1 ? 'it' : 'them'} up
              </button>
            }
          >
            {Object.keys(resumable).length === 1 ? 'A Manus image you started is' : `${Object.keys(resumable).length} Manus images you started are`} still on the way.
          </Callout>
        )}
        <AIThinking running={job.running} stage={progress ? `${progress} · ${job.stage}` : job.stage} onStop={job.stop} compact />
        {job.error && (
          <Callout
            tone="bad"
            title={job.error.title}
            action={
              effKind === 'photo' ? (
                <button type="button" className="btn btn-secondary btn-xs" onClick={() => setKind('illustration')}>
                  Use illustrations instead
                </button>
              ) : undefined
            }
          >
            {job.error.body} <ManusLink url={job.error.taskUrl} label="Open the task in Manus" />
          </Callout>
        )}
        {!job.running && (job.done || job.note) && (
          <p className="text-small text-muted" role="status">
            {job.done}
            {job.note && <span className="block text-warn">{job.note}</span>}
          </p>
        )}
      </div>

      {children}

      {described && (
        <Modal
          open
          onClose={() => setDescribing(null)}
          size="sm"
          title={`${described.label} image`}
          subtitle="What the AI makes for this image. Saved with your listing."
          footer={
            <>
              {d.shotPrompts?.[described.id] !== undefined && d.shotPrompts[described.id] !== described.prompt && (
                <button type="button" className="btn btn-ghost btn-sm mr-auto" onClick={() => setPrompt(described, undefined)}>
                  Reset to suggested
                </button>
              )}
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setDescribing(null)}>
                Done
              </button>
            </>
          }
        >
          <AutoTextarea aria-label={`${described.label} image description`} value={d.shotPrompts?.[described.id] ?? described.prompt} onChange={(v) => setPrompt(described, v)} minRows={5} data-autofocus />
          {described.layout !== 'clean' && <p className="hint">Your title, {described.layout === 'offer' ? 'price and button' : 'checklist and price'} are typeset on top.</p>}
        </Modal>
      )}
    </section>
  );
}

/** One listing image: the picture (4:3), its badges, and Replace ▾ and ⋯ on hover (always on touch). */
function ShotTile({
  shot,
  media: m,
  own,
  isCover,
  inGallery,
  busy,
  task,
  actions,
  disabled,
  run,
  onPhoto,
}: {
  shot: ListingShot;
  media: MediaRef | undefined;
  own: boolean;
  isCover: boolean;
  inGallery: boolean;
  busy: boolean;
  task?: ManusTask;
  actions: { replace: ShotAction[]; more: ShotAction[] };
  disabled: boolean;
  run: Record<ShotAction, () => void>;
  onPhoto: (media: MediaRef) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const pick = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    const [media] = await savePhotos(files);
    setUploading(false);
    if (media) onPhoto(media);
  };
  const ICON: Partial<Record<ShotAction, ReactNode>> = {
    generate: <Spark size={16} />,
    regenerate: <Spark size={16} />,
    'generate-instead': <Spark size={16} />,
    upload: <Upload />,
    'add-details': <Type />,
    'update-details': <Type />,
    describe: <PenLine />,
    'make-cover': <Star />,
    'add-to-gallery': <Images />,
    'remove-from-gallery': <Images />,
    download: <Download />,
  };
  const entry = (a: ShotAction): MenuEntry => ({
    label: a === 'describe' ? `${SHOT_ACTION_LABEL[a]}…` : SHOT_ACTION_LABEL[a],
    icon: ICON[a],
    disabled: (a === 'generate' || a === 'regenerate' || a === 'generate-instead' || a === 'add-details' || a === 'update-details') && disabled,
    onSelect: a === 'upload' ? () => input.current?.click() : run[a],
  });
  const replaceItems: MenuEntry[] = actions.replace.flatMap((a) => (a === 'describe' ? (['separator', entry(a)] as MenuEntry[]) : [entry(a)]));
  return (
    <article className="flex min-w-0 flex-col gap-2.5" aria-label={shot.label}>
      <div className="group relative aspect-[4/3] w-full overflow-hidden rounded-pop bg-surface-3 ring-1 ring-inset ring-ink/5">
        {m ? (
          <MediaThumb media={m} className="absolute inset-0 h-full w-full rounded-none ring-0" />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-muted">
            <ImagePlus size={24} aria-hidden="true" />
            <span className="text-caption">{shot.aspect === '1:1' ? 'Square graphic' : 'Landscape image'}</span>
          </div>
        )}
        {(isCover || inGallery || own) && (
          <div className="absolute left-2 top-2 flex flex-wrap gap-1">
            {isCover && (
              <Badge tone="primary" className="shadow-xs">
                Cover
              </Badge>
            )}
            {inGallery && <Badge className="bg-surface shadow-xs">In gallery</Badge>}
            {own && <Badge className="bg-surface shadow-xs">Your photo</Badge>}
          </div>
        )}
        {(busy || uploading) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-surface/75" role="status">
            <Spinner size={20} className="text-ink-2" />
            <span className="text-caption text-ink-2">{uploading ? 'Adding your photo…' : 'Making it…'}</span>
            {task && <ManusLink url={task.taskUrl} label="Watch in Manus" />}
          </div>
        )}
        {!busy && !uploading && (
          <div className={cn('absolute bottom-2 right-2 flex items-center gap-1.5 transition-opacity duration-120', m && 'opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100')}>
            <Menu
              align="end"
              items={replaceItems}
              trigger={
                <button type="button" className="btn btn-secondary btn-xs shadow-xs" aria-label={`${m ? 'Replace' : 'Add'} the ${shot.label} image`}>
                  {m ? 'Replace' : 'Add image'} <ChevronDown />
                </button>
              }
            />
            {actions.more.length > 0 && (
              <span className="rounded-md bg-surface shadow-xs">
                <MoreMenu size="xs" label={`More for the ${shot.label} image`} items={actions.more.map(entry)} />
              </span>
            )}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <p className="text-ui text-ink">{shot.label}</p>
        <p className="text-small text-muted">{shot.desc}</p>
      </div>
      <PhotoInput ref={input} onFiles={(files) => void pick(files)} />
    </article>
  );
}
