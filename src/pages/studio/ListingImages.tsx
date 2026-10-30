import { useMemo, useState } from 'react';
import { Camera, Check, ChevronDown, Download, ImagePlus, Images, Palette, RefreshCw, Square, Star, WandSparkles } from 'lucide-react';
import type { ImageKind, ListingDraft, MediaRef, Project } from '@/lib/types';
import { cn, fmtMoney } from '@/lib/utils';
import { getBlob } from '@/lib/storage';
import { navigate } from '@/lib/router';
import { FORMATS, matchBusinessType } from '@/ai/knowledge';
import { createListingImage, defaultImageKind, listingShots, photoLabel, photoRoute, photoSourceNote, releaseMedia, type ListingShot, type ListingShotId } from '@/ai/image';
import { pendingManus, type ManusTask } from '@/ai/manus';
import { ManusLink } from '@/components/images/PostImagePanel';
import type { ListingText } from '@/lib/imageCanvas';
import { getActiveProject, useStore } from '@/store/useStore';
import { toast } from '@/store/ui';
import { AIThinking } from '@/components/ai/AI';
import { download } from '@/components/ui/download';
import { AutoTextarea, Segmented, Spinner } from '@/components/ui/primitives';
import { MediaThumb } from '@/components/media/MediaUpload';
import { artDirectionLabel, useArtDirection, useImageJob, usePhotoAvailability } from '@/components/images/useImageJob';
import { priceLabel } from '@/pages/store/ListingParts';
import { buildListing } from './listing';

export const MAX_GALLERY = 4;

/** The words typeset on the listing graphics, from the same data the listing uses. */
export function listingText(project: Project): ListingText {
  const l = buildListing(project);
  const isBiz = project.track === 'business';
  return {
    eyebrow: isBiz ? 'What you get' : 'What’s inside',
    title: l.title,
    tagline: l.tagline,
    items: l.includes?.length ? l.includes : l.services?.map((s) => s.name) ?? [],
    price: l.price || l.priceModel === 'free' ? priceLabel(l.price, l.priceModel) : undefined,
    compareAt: l.compareAt ? fmtMoney(l.compareAt) : undefined,
    cta: isBiz ? (l.bookingType === 'book' ? 'Book your visit' : l.bookingType === 'inquire' ? 'Request a quote' : 'Order now') : 'Get instant access',
  };
}

/** Offer card eyebrow: what it is, and where for a local business. */
function offerEyebrow(project: Project): string {
  if (project.track === 'business') {
    const label = matchBusinessType(`${project.businessType} ${project.category} ${project.niche}`).label;
    return project.location?.city ? `${label} · ${project.location.city}` : label;
  }
  return project.format ? FORMATS[project.format].label.replace(/s$/, '') : 'Digital product';
}

const latestFor = (project: Project, shot: ListingShotId): MediaRef | undefined =>
  project.brand.images
    .filter((m) => m.generated?.purpose === 'listing' && m.generated.shot === shot)
    .sort((a, b) => b.createdAt - a.createdAt)[0];

export function ListingImages({ project }: { project: Project }) {
  const updateBrand = useStore((s) => s.updateBrand);
  const updateStudio = useStore((s) => s.updateStudio);
  const photo = usePhotoAvailability();
  const shots = useMemo(() => listingShots(project), [project]);
  const [kind, setKind] = useState<ImageKind>(() => defaultImageKind());
  const [prompts, setPrompts] = useState<Partial<Record<ListingShotId, string>>>({});
  const [selected, setSelected] = useState<ListingShotId[]>(['hero', 'lifestyle', 'inside', 'offer']);
  const [open, setOpen] = useState<ListingShotId | null>(null);
  const [busy, setBusy] = useState<ListingShotId[]>([]);
  const [progress, setProgress] = useState('');
  const [tasks, setTasks] = useState<Partial<Record<ListingShotId, ManusTask>>>({});
  const pendingKey = (shot: ListingShotId) => `listing:${project.id}:${shot}`;
  // Manus images started before a reload, still on their way
  const [resumable, setResumable] = useState<Partial<Record<ListingShotId, ManusTask>>>(() => {
    const r: Partial<Record<ListingShotId, ManusTask>> = {};
    for (const id of ['hero', 'lifestyle', 'inside', 'offer'] as ListingShotId[]) {
      const t = pendingManus.get(`listing:${project.id}:${id}`);
      if (t) r[id] = t;
    }
    return r;
  });
  const job = useImageJob();
  const art = useArtDirection('listing');
  const effKind: ImageKind = kind === 'photo' && !photo.ok ? 'illustration' : kind;
  // photos from an image API come back in seconds, so a set is made all at once (Manus tasks one by one)
  const fastPhotos = effKind === 'photo' && (photoRoute() === 'muse' || photoRoute() === 'server');
  const d = project.studio.listing;
  const gallery = d.galleryIds ?? [];

  /** Put a new image in place of the shot's previous one (cover and gallery follow it). */
  const place = (shot: ListingShot, media: MediaRef) => {
    const p = getActiveProject()!;
    const prev = latestFor(p, shot.id);
    const images = prev ? p.brand.images.map((m) => (m.id === prev.id ? media : m)) : [...p.brand.images, media];
    updateBrand({ images });
    const draft = p.studio.listing;
    const patch: Partial<ListingDraft> = {};
    if (shot.id === 'hero' && (!draft.coverImageId || draft.coverImageId === prev?.id)) patch.coverImageId = media.id;
    else if (prev && draft.coverImageId === prev.id) patch.coverImageId = media.id;
    const g = (draft.galleryIds ?? []).filter((id) => images.some((m) => m.id === id));
    if (prev && g.includes(prev.id)) patch.galleryIds = g.map((id) => (id === prev.id ? media.id : id));
    else if (shot.id !== 'hero' && g.length < MAX_GALLERY && !g.includes(media.id)) patch.galleryIds = [...g, media.id];
    updateStudio({ listing: { ...draft, ...patch } });
    if (prev) setTimeout(() => releaseMedia(prev), 0);
  };

  const makeOne = async (shot: ListingShot, signal: AbortSignal, onStage: (s: string) => void, resume?: ManusTask) => {
    const p = getActiveProject()!;
    const text = listingText(p);
    const r = await createListingImage({
      project: p,
      kind: resume ? 'photo' : effKind,
      shot,
      prompt: prompts[shot.id] ?? shot.prompt,
      text: shot.layout === 'offer' ? { ...text, eyebrow: offerEyebrow(p) } : text,
      signal,
      onStage,
      onTask: (t) => setTasks((x) => ({ ...x, [shot.id]: t })),
      pendingKey: pendingKey(shot.id),
      resume,
    });
    place(shot, r.media);
    return r;
  };

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
      const hero = latestFor(p, 'hero');
      const heroIsCover = list.some((s) => s.id === 'hero') && !!hero && p.studio.listing.coverImageId === hero.id;
      toast({ kind: 'success', title: `${made} listing image${made === 1 ? '' : 's'} ready`, body: heroIsCover ? 'The new cover image is set. Publish or update the listing to show it to buyers.' : 'Publish or update the listing to show them to buyers.' });
    }
  };

  const toggleGallery = (id: string) => {
    const p = getActiveProject()!;
    const g = p.studio.listing.galleryIds ?? [];
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
          <p className="text-[12.5px] text-muted">A cover mockup, an in-use shot and two branded graphics, made from your {project.track === 'business' ? 'services' : 'product'} details.</p>
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
          const m = latestFor(project, shot.id);
          const isCover = !!m && d.coverImageId === m.id;
          const inGallery = !!m && gallery.includes(m.id);
          const on = selected.includes(shot.id);
          const isBusy = busy.includes(shot.id) && job.running;
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
                <div className="absolute left-2 top-2 flex gap-1">
                  {isCover && <span className="badge bg-primary text-on-primary"><Star size={10} className="fill-current" /> Cover</span>}
                  {inGallery && <span className="badge bg-black/55 text-white">In gallery</span>}
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
                    <AutoTextarea aria-label={`${shot.label} image description`} value={prompts[shot.id] ?? shot.prompt} onChange={(v) => setPrompts((x) => ({ ...x, [shot.id]: v }))} minRows={3} className="text-[12.5px]" />
                    {prompts[shot.id] !== undefined && prompts[shot.id] !== shot.prompt && (
                      <button type="button" className="self-start text-[11.5px] font-semibold text-primary hover:underline" onClick={() => setPrompts((x) => ({ ...x, [shot.id]: undefined }))}>
                        Reset to suggested
                      </button>
                    )}
                    {shot.layout !== 'clean' && <p className="text-[11px] text-muted">Your title, {shot.layout === 'offer' ? 'price and button' : 'checklist and price'} are typeset on top.</p>}
                  </div>
                )}
                <div className="mt-auto flex flex-wrap items-center gap-1.5">
                  <button type="button" className="btn btn-secondary btn-xs" disabled={job.running} onClick={() => generate([shot.id])}>
                    {m ? <RefreshCw size={12} /> : <WandSparkles size={12} />} {m ? 'Regenerate' : 'Generate'}
                  </button>
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
        <button type="button" className="btn btn-ai btn-sm" disabled={job.running || !selected.length} onClick={() => generate(selected)}>
          {job.running ? <Spinner size={14} /> : <WandSparkles size={14} className="text-accent" />}
          {selected.length === shots.length ? 'Generate full set' : `Generate ${selected.length} selected`}
        </button>
        {job.running && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={job.stop}>
            <Square size={11} className="fill-current" /> Stop
          </button>
        )}
        <span className="text-[11.5px] text-muted">{effKind === 'photo' ? photoSourceNote() : __ARTIFACT_BUILD__ ? 'Illustrations are drawn by Claude in your brand colors.' : 'Illustrations are drawn by your AI in your brand colors.'}</span>
        {effKind === 'photo' && art.skills.length > 0 && (
          <span className="w-full text-[11.5px] text-muted" title={art.text}>
            {artDirectionLabel(art.skills.map((k) => k.name))}
          </span>
        )}
      </div>
    </section>
  );
}
