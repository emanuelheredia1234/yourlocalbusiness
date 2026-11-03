import { useMemo, useRef, useState } from 'react';
import { Camera, Check, ChevronDown, Download, ImagePlus, Images, Palette, RefreshCw, Square, Star, Type, Upload, WandSparkles } from 'lucide-react';
import type { ImageKind, ListingShotId, MediaRef, Project } from '@/lib/types';
import { cn } from '@/lib/utils';
import { getBlob } from '@/lib/storage';
import { isOwnPhoto } from '@/lib/media';
import { navigate } from '@/lib/router';
import { galleryIds, MAX_GALLERY } from '@/lib/listing';
import { composeOwnListingPhoto, defaultImageKind, listingShots, photoLabel, photoRoute, photoSourceNote, type ListingShot } from '@/ai/image';
import { fromOwnPhoto, listingShotMedia, PHOTO_ACCEPT } from '@/ai/listingPhotos';
import { ALL_SHOTS, listingPendingKey, makeListingShot, ownPhotoPlaced, placeListingShot, savePhotoFile, shotText } from '@/ai/listingImages';
import { pendingManus, type ManusTask } from '@/ai/manus';
import { ManusLink } from '@/components/images/PostImagePanel';
import { getActiveProject, useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { AIThinking } from '@/components/ai/AI';
import { download } from '@/components/ui/download';
import { AutoTextarea, Segmented, Spinner } from '@/components/ui/primitives';
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
    const out: MediaRef[] = [];
    for (const f of files.slice(0, multiple ? 12 : 1)) {
      try {
        out.push(await savePhotoFile(f));
      } catch (e) {
        toast({ kind: 'error', title: `Couldn’t add ${f.name}`, body: (e as Error).message });
      }
    }
    setBusy(false);
    if (out.length) onPhotos(out);
  };
  return (
    <>
      <button type="button" className={className ?? 'btn btn-ghost btn-xs'} disabled={disabled || busy} aria-label={ariaLabel} onClick={() => input.current?.click()}>
        {busy ? <Spinner size={12} /> : <Upload size={12} />} {label}
      </button>
      <input
        ref={input}
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
          void add(files);
        }}
      />
    </>
  );
}

export function ListingImages({ project }: { project: Project }) {
  const updateStudio = useStore((s) => s.updateStudio);
  const photo = usePhotoAvailability();
  const shots = useMemo(() => listingShots(project), [project]);
  const [kind, setKind] = useState<ImageKind>(() => defaultImageKind());
  const [selected, setSelected] = useState<ListingShotId[]>(ALL_SHOTS);
  const [open, setOpen] = useState<ListingShotId | null>(null);
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
  const gallery = galleryIds(project);
  const isBiz = project.track === 'business';
  // "Generate full set" leaves the shots that show your own photo alone
  const keepOwn = selected.filter((id) => fromOwnPhoto(listingShotMedia(project, id)));
  const toMake = selected.filter((id) => !keepOwn.includes(id));
  const labelOf = (id: ListingShotId) => shots.find((s) => s.id === id)?.label ?? id;

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

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2/40 p-3 sm:p-4" aria-label="Listing images">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
            <Images size={16} className="text-primary" /> Listing images
          </h3>
          <p className="text-[12.5px] text-muted">
            {isBiz ? 'A cover photo, a photo of your business in action and two branded graphics, made from your business details.' : 'A cover mockup, an in-use shot and two branded graphics, made from your product details.'} Or upload your own photos (JPG, PNG or WebP).
          </p>
        </div>
        <Segmented<ImageKind>
          size="sm"
          value={effKind}
          onChange={(v) => (v === 'photo' && !photo.ok ? undefined : setKind(v))}
          options={[
            { id: 'illustration', label: 'Illustration', icon: <Palette size={13} /> },
            { id: 'photo', label: <span className={cn(!photo.ok && 'opacity-50')}>{photoLabel()}</span>, icon: <Camera size={13} className={cn(!photo.ok && 'opacity-50')} /> },
          ]}
        />
      </div>
      {!photo.ok && (
        <p className="text-[11.5px] leading-snug text-muted">
          {photo.reason}{' '}
          {!__ARTIFACT_BUILD__ && (
            <button type="button" className="font-semibold text-primary hover:underline" onClick={() => navigate('workspace-settings')}>
              Open settings
            </button>
          )}
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {shots.map((shot) => {
          const m = listingShotMedia(project, shot.id);
          const own = fromOwnPhoto(m);
          const isCover = !!m && d.coverImageId === m.id;
          const inGallery = !!m && gallery.includes(m.id);
          const on = selected.includes(shot.id);
          const isBusy = (busy.includes(shot.id) && job.running) || composing === shot.id;
          const saved = d.shotPrompts?.[shot.id];
          // your details can go on your own photo (checklist and offer graphics only)
          const detailsFrom = shot.layout === 'clean' || !m ? undefined : isOwnPhoto(m) ? m.id : own ? m.generated?.artId : undefined;
          return (
            <article key={shot.id} className={cn('flex min-w-0 flex-col overflow-hidden rounded-lg border bg-surface', on ? 'border-line-2' : 'border-line opacity-80')}>
              <div className={cn('relative w-full bg-surface-3', shot.aspect === '1:1' ? 'aspect-square' : 'aspect-[3/2]')}>
                {m ? (
                  <MediaThumb media={m} className="absolute inset-0 h-full w-full rounded-none border-0" />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted">
                    <ImagePlus size={22} />
                    <span className="text-xs">{shot.aspect === '1:1' ? 'Square graphic' : 'Landscape image'}</span>
                  </div>
                )}
                {isBusy && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-surface/70 backdrop-blur-[1px]">
                    <Spinner size={22} className="text-primary" />
                    {tasks[shot.id] && <ManusLink url={tasks[shot.id]!.taskUrl} label="Watch in Manus" />}
                  </div>
                )}
                <div className="absolute left-2 top-2 flex flex-wrap gap-1">
                  {isCover && <span className="badge bg-primary text-on-primary"><Star size={10} className="fill-current" /> Cover</span>}
                  {inGallery && <span className="badge bg-black/55 text-white">In gallery</span>}
                  {own && <span className="badge bg-black/55 text-white">Your photo</span>}
                </div>
              </div>
              <div className="flex flex-1 flex-col gap-2 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <label className="flex min-w-0 cursor-pointer items-start gap-2">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--primary))]" checked={on} onChange={(e) => setSelected((x) => (e.target.checked ? [...x, shot.id] : x.filter((y) => y !== shot.id)))} />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-semibold text-ink">{shot.label}</span>
                      <span className="block text-[11.5px] leading-snug text-muted">{shot.desc}</span>
                    </span>
                  </label>
                  <button type="button" className="btn btn-ghost btn-xs shrink-0" aria-expanded={open === shot.id} onClick={() => setOpen(open === shot.id ? null : shot.id)}>
                    Edit <ChevronDown size={12} className={cn('transition-transform', open === shot.id && 'rotate-180')} />
                  </button>
                </div>
                {open === shot.id && (
                  <div className="flex flex-col gap-1">
                    <AutoTextarea aria-label={`${shot.label} image description`} value={saved ?? shot.prompt} onChange={(v) => setPrompt(shot, v)} minRows={3} className="text-[12.5px]" />
                    {saved !== undefined && saved !== shot.prompt && (
                      <button type="button" className="self-start text-[11.5px] font-semibold text-primary hover:underline" onClick={() => setPrompt(shot, undefined)}>
                        Reset to suggested
                      </button>
                    )}
                    <p className="text-[11px] text-muted">
                      Saved with your listing.{shot.layout !== 'clean' && ` Your title, ${shot.layout === 'offer' ? 'price and button' : 'checklist and price'} are typeset on top.`}
                    </p>
                  </div>
                )}
                <div className="mt-auto flex flex-wrap items-center gap-1.5">
                  <button type="button" className="btn btn-secondary btn-xs" disabled={job.running || isBusy} onClick={() => generate([shot.id])} title={own ? 'Your photo stays in your brand images.' : undefined}>
                    {m && !own ? <RefreshCw size={12} /> : <WandSparkles size={12} />} {own ? 'Generate instead' : m ? 'Regenerate' : 'Generate'}
                  </button>
                  <PhotoUploadButton label="Upload my photo" ariaLabel={`Upload my photo for ${shot.label}`} disabled={isBusy} onPhotos={(ms) => putOwnPhoto(shot, ms[0])} />
                  {detailsFrom && (
                    <button type="button" className="btn btn-ghost btn-xs" disabled={isBusy} onClick={() => addDetails(shot, detailsFrom)}>
                      <Type size={12} /> {isOwnPhoto(m) ? 'Add my details' : 'Update my details'}
                    </button>
                  )}
                  {m && !isCover && (
                    <button type="button" className="btn btn-ghost btn-xs" onClick={() => updateStudio({ listing: { ...getActiveProject()!.studio.listing, coverImageId: m.id } })}>
                      <Star size={12} /> Make cover
                    </button>
                  )}
                  {m && !isCover && (
                    <button type="button" className="btn btn-ghost btn-xs" aria-pressed={inGallery} onClick={() => toggleGallery(m.id)}>
                      {inGallery ? <Check size={12} /> : <Images size={12} />} {inGallery ? 'In gallery' : 'Add to gallery'}
                    </button>
                  )}
                  {m && (
                    <button type="button" className="btn btn-ghost btn-xs ml-auto" onClick={() => save(m)} aria-label={`Download ${shot.label}`}>
                      <Download size={12} />
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {Object.keys(resumable).length > 0 && !job.running && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-[12.5px]">
          <span className="min-w-0 flex-1 text-ink-2">
            {Object.keys(resumable).length === 1 ? 'A Manus image you started is' : `${Object.keys(resumable).length} Manus images you started are`} still on the way.
          </span>
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => generate(Object.keys(resumable) as ListingShotId[], resumable)}>
            Pick {Object.keys(resumable).length === 1 ? 'it' : 'them'} up
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs text-muted"
            onClick={() => {
              for (const id of Object.keys(resumable)) pendingManus.clear(pendingKey(id as ListingShotId));
              setResumable({});
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      <AIThinking running={job.running} stage={progress ? `${progress} · ${job.stage}` : job.stage} onStop={job.stop} compact />
      {job.error && (
        <div className="rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-[12.5px]" role="alert">
          <p className="font-semibold text-bad">{job.error.title}</p>
          <p className="text-ink-2">{job.error.body}</p>
          <ManusLink url={job.error.taskUrl} label="Open the task in Manus" />
          {effKind === 'photo' && (
            <button type="button" className="mt-1 text-xs font-semibold text-primary hover:underline" onClick={() => setKind('illustration')}>
              Use illustrations instead
            </button>
          )}
        </div>
      )}
      {!job.running && (job.done || job.note) && (
        <p className="text-[11.5px] text-muted">
          {job.done}
          {job.note && <span className="block text-warn">{job.note}</span>}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-ai btn-sm" disabled={job.running || !toMake.length} onClick={() => generate(toMake)}>
          {job.running ? <Spinner size={14} /> : <WandSparkles size={14} className="text-accent" />}
          {toMake.length === shots.length ? 'Generate full set' : `Generate ${toMake.length} image${toMake.length === 1 ? '' : 's'}`}
        </button>
        {job.running && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={job.stop}>
            <Square size={11} className="fill-current" /> Stop
          </button>
        )}
        <span className="text-[11.5px] text-muted">{effKind === 'photo' ? photoSourceNote() : __ARTIFACT_BUILD__ ? 'Illustrations are drawn by Claude in your brand colors.' : 'Illustrations are drawn by your AI in your brand colors.'}</span>
        {keepOwn.length > 0 && (
          <span className="w-full text-[11.5px] text-muted" role="note">
            {keepOwn.length === 1 ? 'Your photo stays' : 'Your photos stay'} on {andList(keepOwn.map(labelOf))}. To replace {keepOwn.length === 1 ? 'it' : 'one'}, use “Generate instead” on its card.
          </span>
        )}
        {effKind === 'photo' && art.skills.length > 0 && (
          <span className="w-full text-[11.5px] text-muted" title={art.text}>
            {artDirectionLabel(art.skills.map((k) => k.name))}
          </span>
        )}
      </div>
    </section>
  );
}
