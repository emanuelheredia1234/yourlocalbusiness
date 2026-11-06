// The image a Meta ad needs: made from the creative (its style and on-visual headline, with the brand) or the
// owner's own photo, saved to the account so the server can hand Meta a signed link to it. The plan's creative
// keeps a reference (AdCreative.media); nothing is sent to Meta here.

import type { AdCreative, AdCreativeMedia, MediaRef, Project } from '@/lib/types';
import { createPostImage } from '@/ai/image';
import { ensureUploaded } from '@/lib/cloud/media';
import { saveMediaFile } from '@/lib/storage';

/** What an image was made from: a changed creative shows "make it again". */
export const renderedFromOf = (project: Project, cr: Pick<AdCreative, 'style' | 'visualHeadline'>) => `${cr.style}|${cr.visualHeadline.trim()}|${project.brand.name.trim()}`;

/** Whether the creative's image is out of date (made by the app from text that changed since). */
export const imageStale = (project: Project, cr: AdCreative) => cr.media?.madeBy === 'ai' && !!cr.media.renderedFrom && cr.media.renderedFrom !== renderedFromOf(project, cr);

function mediaOf(ref: MediaRef, madeBy: 'ai' | 'owner', renderedFrom?: string): AdCreativeMedia | null {
  const type = /^image\/png$/i.test(ref.mime) ? 'image/png' : /^image\/jpe?g$/i.test(ref.mime) ? 'image/jpeg' : null;
  if (!type) return null;
  return { mediaId: ref.id, width: ref.w ?? 1080, height: ref.h ?? 1080, type, madeBy, ...(renderedFrom ? { renderedFrom } : {}) };
}

export type AdImageResult = { ok: true; media: AdCreativeMedia } | { ok: false; message: string };

/** Make a 1:1 image from the creative and save it to the account. */
export async function makeAdImage(project: Project, cr: AdCreative, onStage?: (s: string) => void, signal?: AbortSignal): Promise<AdImageResult> {
  try {
    const { media } = await createPostImage({ project, kind: 'illustration', prompt: cr.visualHeadline || cr.headline, aspect: '1:1', style: cr.style, headline: cr.visualHeadline || cr.headline, overlay: true, watermark: false, signal, onStage });
    return await saveForAds(media, 'ai', renderedFromOf(project, cr), onStage);
  } catch (e) {
    return { ok: false, message: e instanceof Error && e.message ? e.message : 'The image couldn’t be made. Try again.' };
  }
}

/** The owner's own photo (JPEG or PNG) as the ad's image. */
export async function useOwnPhoto(file: File, onStage?: (s: string) => void): Promise<AdImageResult> {
  if (!/^image\/(jpeg|png)$/i.test(file.type)) return { ok: false, message: 'Meta ads take a JPEG or PNG image.' };
  try {
    const ref = await saveMediaFile(file);
    return await saveForAds(ref, 'owner', undefined, onStage);
  } catch (e) {
    return { ok: false, message: e instanceof Error && e.message ? e.message : 'The photo couldn’t be saved.' };
  }
}

async function saveForAds(ref: MediaRef, madeBy: 'ai' | 'owner', renderedFrom: string | undefined, onStage?: (s: string) => void): Promise<AdImageResult> {
  const media = mediaOf(ref, madeBy, renderedFrom);
  if (!media) return { ok: false, message: 'Meta ads take a JPEG or PNG image.' };
  onStage?.('Saving the image to your account…');
  if (!(await ensureUploaded(media.mediaId))) return { ok: false, message: 'The image isn’t in your account yet. Check that you’re signed in and online, then try again.' };
  return { ok: true, media };
}
