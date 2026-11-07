// Pictures for emails (P5 §A2, §A5): uploaded to the app's public images (public-files, use=email) so every inbox
// can load them; AI pictures made by the image route (metered there) and then uploaded; a video's thumbnail with a
// play badge drawn on it. Server only: the claude.ai build has no image hosting (image blocks take an https URL).
// Nothing is retried by itself: a failed upload after a generated picture keeps the picture for "Upload again".

import type { MediaRef, Project } from '@/lib/types';
import { uploadPublicImage } from '@/lib/leadFiles';
import { getBlob } from '@/lib/storage';
import { createPostImage, defaultImageKind } from '@/ai/image';

export interface HostedImage {
  src: string;
  w?: number;
  h?: number;
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

async function sizeOf(blob: Blob): Promise<{ w?: number; h?: number }> {
  try {
    const bmp = await createImageBitmap(blob);
    const out = { w: bmp.width, h: bmp.height };
    bmp.close();
    return out;
  } catch {
    return {};
  }
}

/** Upload a picture for an email; its address is the app's public one. */
export async function uploadEmailImage(blob: Blob, name?: string): Promise<HostedImage> {
  if (__ARTIFACT_BUILD__) throw new Error('Image hosting needs the app’s own server.');
  const ext = EXT[blob.type] ?? name?.match(/\.(png|jpe?g|webp|gif)$/i)?.[1] ?? 'png';
  const file = name && /\.(png|jpe?g|webp|gif)$/i.test(name) ? name : `email-image.${ext}`;
  const [{ url }, size] = await Promise.all([uploadPublicImage(blob, file, undefined, 'email'), sizeOf(blob)]);
  return { src: url, ...size };
}

/** A picture the image route makes for an email (a landscape picture, no text on it). The media stays on this device. */
export async function generateEmailMedia(project: Project, prompt: string): Promise<MediaRef> {
  const { media } = await createPostImage({
    project,
    kind: defaultImageKind(),
    prompt,
    aspect: '1.91:1',
    style: 'minimal',
    headline: '',
    overlay: false,
    watermark: false,
  });
  return media;
}

/** Upload a picture made earlier (generateEmailMedia). */
export async function uploadMedia(media: MediaRef): Promise<HostedImage> {
  const blob = await getBlob(media.id);
  if (!blob) throw new Error('The picture isn’t on this device any more. Make it again.');
  return uploadEmailImage(blob, media.name);
}

/** A thumbnail with a play badge drawn on it (a circle with a triangle), as a PNG. */
export async function withPlayBadge(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const w = Math.min(1200, bmp.width);
  const h = Math.round((bmp.height * w) / bmp.width);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser can’t draw the play badge.');
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const r = Math.max(24, Math.round(Math.min(w, h) * 0.12));
  const cx = w / 2;
  const cy = h / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.35, cy - r * 0.5);
  ctx.lineTo(cx + r * 0.55, cy);
  ctx.lineTo(cx - r * 0.35, cy + r * 0.5);
  ctx.closePath();
  ctx.fill();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The thumbnail couldn’t be made.'))), 'image/png'));
}
