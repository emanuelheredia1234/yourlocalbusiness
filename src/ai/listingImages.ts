// The four listing images: the words each graphic carries, putting an image on a shot (an AI image, your
// own photo, or your photo with your details) and making one. Studio → Listing & publish and the
// assistant both use these, so a shot behaves the same whoever fills it.
//
// Placing names the project it is for (the active one by default): an image that finishes after the
// owner switched projects still goes to the listing it was made for.

import type { ImageKind, ListingDraft, ListingShotId, MediaRef, Project } from '@/lib/types';
import { fmtMoney } from '@/lib/utils';
import { isOwnPhoto } from '@/lib/media';
import { saveMediaFile } from '@/lib/storage';
import { buildListing, cleanGallery, MAX_GALLERY, priceLabel } from '@/lib/listing';
import type { ListingText } from '@/lib/imageCanvas';
import { useStore } from '@/store/useStore';
import { createListingImage, releaseMedia, type ArtResult, type ListingShot } from './image';
import { listingShotMedia, offerEyebrow, photoFileProblem, withoutPlaceholders } from './listingPhotos';
import type { ManusTask } from './manus';

/** The four shots, in the order the panel shows them. */
export const ALL_SHOTS: ListingShotId[] = ['hero', 'lifestyle', 'inside', 'offer'];

/** Where a shot's Manus image is remembered while it's on its way, so a reload can pick it up (the panel's own key). */
export const listingPendingKey = (projectId: string, shot: ListingShotId) => `listing:${projectId}:${shot}`;

/** The words typeset on the listing graphics, from the same data the listing uses. */
export function listingText(project: Project): ListingText {
  const l = buildListing(project);
  const isBiz = project.track === 'business';
  // lines a template left for you to fill in ("[your checklist]") never go on an image
  const includes = withoutPlaceholders(l.includes ?? []);
  return {
    eyebrow: isBiz ? 'What you get' : 'What’s inside',
    title: l.title,
    tagline: l.tagline,
    items: includes.length ? includes : withoutPlaceholders(l.services?.map((s) => s.name) ?? []),
    price: l.price || l.priceModel === 'free' ? priceLabel(l.price, l.priceModel) : undefined,
    compareAt: l.compareAt ? fmtMoney(l.compareAt) : undefined,
    cta: isBiz ? (l.bookingType === 'book' ? 'Book your visit' : l.bookingType === 'inquire' ? 'Request a quote' : 'Order now') : 'Get it now',
  };
}

/** The text a shot's graphic carries (the offer card leads with what and where). */
export function shotText(p: Project, shot: ListingShot): ListingText {
  const text = listingText(p);
  return shot.layout === 'offer' ? { ...text, eyebrow: offerEyebrow(p) } : text;
}

/** A shot's image description: the one the owner edited (saved with the listing), else the suggested one. */
export const shotPrompt = (p: Project, shot: ListingShot) => p.studio.listing.shotPrompts?.[shot.id] ?? shot.prompt;

const activeId = () => useStore.getState().activeProjectId ?? '';

/**
 * Show a new image on a shot (an AI image, your photo, or your photo with your details); the cover and
 * gallery follow it. An AI image it replaces is swapped out of your brand images and freed; your own
 * photos always stay in your brand images.
 */
export function placeListingShot(shot: ListingShotId, media: MediaRef, projectId = activeId()): { cover: boolean; gallery: boolean } {
  const p = useStore.getState().projects.find((x) => x.id === projectId);
  if (!p) return { cover: false, gallery: false };
  const prev = listingShotMedia(p, shot);
  const own = isOwnPhoto(media);
  const swap = !!prev?.generated && prev.id !== media.id;
  const swapped = swap ? p.brand.images.map((m) => (m.id === prev!.id ? media : m)) : p.brand.images;
  const images = swapped.some((m) => m.id === media.id) ? swapped : [...swapped, media];
  const draft = p.studio.listing;
  const patch: Partial<ListingDraft> = {};
  // a photo you put on the Cover card is your cover; a new AI cover only takes over from the old one (or none)
  if (shot === 'hero' && (own || !draft.coverImageId || draft.coverImageId === prev?.id)) patch.coverImageId = media.id;
  else if (prev && draft.coverImageId === prev.id) patch.coverImageId = media.id;
  const g = cleanGallery(draft.galleryIds, images, patch.coverImageId ?? draft.coverImageId);
  if (prev && g.includes(prev.id)) patch.galleryIds = g.map((id) => (id === prev.id ? media.id : id));
  else if (shot !== 'hero' && g.length < MAX_GALLERY && !g.includes(media.id)) patch.galleryIds = [...g, media.id];
  // which shots show a photo you uploaded (an AI image or your details on your photo shows by itself)
  const mine = { ...draft.shotImageIds };
  if (own) mine[shot] = media.id;
  else delete mine[shot];
  patch.shotImageIds = Object.keys(mine).length ? mine : undefined;
  useStore.getState().updateProject(projectId, (x) => ({ ...x, brand: { ...x.brand, images }, studio: { ...x.studio, listing: { ...x.studio.listing, ...patch } } }));
  if (swap) setTimeout(() => releaseMedia(prev), 0);
  return { cover: (patch.coverImageId ?? draft.coverImageId) === media.id, gallery: (patch.galleryIds ?? g).includes(media.id) };
}

/** Make one listing image for a shot (from its description) and put it on that shot. */
export async function makeListingShot(o: {
  shot: ListingShot;
  kind: ImageKind;
  /** the project it is for (the active one by default) */
  projectId?: string;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  onTask?: (task: ManusTask) => void;
  /** a Manus image started before a reload, to pick up instead of starting a new one */
  resume?: ManusTask;
}): Promise<{ media: MediaRef; art: ArtResult; cover: boolean; gallery: boolean }> {
  const projectId = o.projectId ?? activeId();
  const p = useStore.getState().projects.find((x) => x.id === projectId);
  if (!p) throw new Error('Open a project first.');
  const r = await createListingImage({
    project: p,
    kind: o.resume ? 'photo' : o.kind,
    shot: o.shot,
    prompt: shotPrompt(p, o.shot),
    text: shotText(p, o.shot),
    signal: o.signal,
    onStage: o.onStage,
    onTask: o.onTask,
    pendingKey: listingPendingKey(p.id, o.shot.id),
    resume: o.resume,
  });
  return { ...r, ...placeListingShot(o.shot.id, r.media, projectId) };
}

/** What putting your photo on a shot did, as a short title and a line (for a toast, or the chat). */
export function ownPhotoPlaced(label: string, r: { cover: boolean; gallery: boolean }): { title: string; body: string } {
  const body = 'Publish or update the listing to show it to buyers.';
  if (r.cover) return { title: 'Your photo is the listing cover', body };
  if (r.gallery) return { title: `Your photo is on ${label} and in the gallery`, body };
  return { title: `Your photo is on ${label}`, body: `The gallery already has ${MAX_GALLERY} images, so it isn’t in it. Remove one to add this photo.` };
}

/**
 * Keep a photo you chose for a listing image. Only JPG, PNG and WebP: HEIC (the iPhone default) can't be
 * opened in most browsers, so it is turned away with a note instead of failing later. Throws with what's
 * wrong, in words for the owner.
 */
export async function savePhotoFile(f: File): Promise<MediaRef> {
  const problem = photoFileProblem(f);
  if (problem) throw new Error(problem);
  try {
    return await saveMediaFile(f);
  } catch (e) {
    const msg = (e as Error)?.message || 'The photo couldn’t be read.';
    throw new Error(/read|load/i.test(msg) ? `${msg} Try a JPG, PNG or WebP photo.` : msg);
  }
}
