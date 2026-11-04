// The sales page as HTML in its three forms: on screen (the HTML source view, images as short
// {{img-N}} placeholders), as a file (Copy and Export, images put in as data), and as published
// (images as {{img-N}} tokens that the Publish panel turns into the page's own image addresses).
// In HTML mode (a page Manus or Viktor made is the one in use: marketing.seoHtml.active), the same three
// come from that page (src/lib/seoHtml.ts), at the same address.

import type { Project, PromptImage, SalesPage } from '@/lib/types';
import { imageDataUrls, imageKeyNumber, nextImageKey } from '@/lib/promptImages';
import type { PublishBuild, PublishTarget } from '@/lib/publish';
import { exportSalesHtml, ownCanonical, pageImageIds, type SalesHtmlOptions } from '@/ai/local/seo';
import { seoHtmlDocument, seoHtmlShownImages } from './seoHtml';

/** Whether the page in use is the one Manus or Viktor made (HTML mode): it's shown, scored and published instead of the builder's. */
export function seoHtmlActive(project: Project): boolean {
  return !!(project.marketing.seoHtml?.active && project.marketing.seo);
}

/** The sales page's id for publishing: one per project. */
export function seoPageId(project: Project): string {
  return `seo:${project.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}`;
}

/** Width and height of the page's images (their original size: only the shape matters to the page). */
function sizes(images: PromptImage[]): SalesHtmlOptions['imageSize'] {
  const byId = new Map(images.map((i) => [i.media.id, i.media]));
  return (id) => {
    const m = byId.get(id);
    return m?.w && m?.h ? { w: m.w, h: m.h } : undefined;
  };
}

/** Each image as its {{img-N}} token, by media id. */
function tokens(images: PromptImage[]): SalesHtmlOptions['imageUrl'] {
  const keyOf = new Map(images.map((i) => [i.media.id, i.key]));
  return (id) => (keyOf.has(id) ? `{{${keyOf.get(id)}}}` : undefined);
}

/** Where the page's form sends from a copy of the page (the HTML source, Copy and Export): the published page's
 *  /lead, once it's published ('' before: the form shows but can't send). The published address is always the
 *  app's own (https://<app>/<slug>), which takes the form from any site. */
const leadActionOf = (p: Project) => (p.marketing.seoPublished ? `${p.marketing.seoPublished.url}/lead` : '');

/** The images the page shows (visible sections), in the order they appear. */
export function shownPromptImages(page: SalesPage, images: PromptImage[]): PromptImage[] {
  const byId = new Map(images.map((i) => [i.media.id, i]));
  return pageImageIds(page, { visibleOnly: true })
    .map((id) => byId.get(id))
    .filter((i): i is PromptImage => !!i);
}

/** The HTML source as it's shown on screen: short {{img-N}} placeholders instead of image data. */
export function seoSourceHtml(project: Project): string {
  const { salesPage, seo, seoImages = [] } = project.marketing;
  if (seoHtmlActive(project)) return seoHtmlDocument(project, { canonical: seo!.canonical, origin: '', leadAction: leadActionOf(project), imageUrl: (k) => `{{${k}}}` });
  return salesPage && seo ? exportSalesHtml(salesPage, seo, project.brand, project, { imageUrl: tokens(seoImages), imageSize: sizes(seoImages), leadAction: leadActionOf(project) }) : '';
}

/**
 * The page as one file, with its images inside it (Copy and Export HTML). `missing` lists the numbers
 * of images whose files couldn't be loaded here: they're left out of the file.
 */
export async function seoFileHtml(project: Project): Promise<{ html: string; missing: number[] }> {
  const { salesPage, seo, seoImages = [], seoHtml } = project.marketing;
  if (seoHtml && seoHtmlActive(project)) {
    const keys = new Set(seoHtmlShownImages(project));
    const used = seoHtml.images.filter((i) => keys.has(i.key));
    const urls = used.length ? await imageDataUrls(used) : {};
    const html = seoHtmlDocument(project, { canonical: seo!.canonical, origin: '', leadAction: leadActionOf(project), imageUrl: (k) => urls[k] });
    return { html, missing: used.filter((i) => !urls[i.key]).map((i) => imageKeyNumber(i.key)) };
  }
  if (!salesPage || !seo) return { html: '', missing: [] };
  const used = shownPromptImages(salesPage, seoImages);
  const urls = used.length ? await imageDataUrls(used) : {};
  const byId = new Map(used.map((i) => [i.media.id, urls[i.key]]));
  const html = exportSalesHtml(salesPage, seo, project.brand, project, { imageUrl: (id) => byId.get(id), imageSize: sizes(seoImages), leadAction: leadActionOf(project) });
  return { html, missing: used.filter((i) => !urls[i.key]).map((i) => imageKeyNumber(i.key)) };
}

/**
 * The page as it goes online at `target` (the Publish panel's build). Its images are {{img-N}} tokens, and
 * the share image is `${target.origin}{{img-N}}`, a full address. The canonical address is where it's
 * published, unless the owner pasted their own (the page also lives there). Its form sends to /<slug>/lead.
 */
export function seoPublishBuild(project: Project, target: PublishTarget): PublishBuild {
  const { salesPage, seo, seoImages = [], seoHtml } = project.marketing;
  if (seoHtml && seo && seoHtmlActive(project)) {
    // the same page id, kind and address as the builder's page; the form ends up as action="/<slug>/lead"
    const html = seoHtmlDocument(project, { canonical: ownCanonical(project, seo) ? seo.canonical : target.canonical, origin: target.origin, leadAction: `/${target.slug}/lead`, imageUrl: (k) => `{{${k}}}` });
    return { html, images: seoHtml.images };
  }
  if (!salesPage || !seo) return { html: '', images: [] };
  const html = exportSalesHtml(salesPage, seo, project.brand, project, {
    imageUrl: tokens(seoImages),
    imageSize: sizes(seoImages),
    canonical: ownCanonical(project, seo) ? seo.canonical : target.canonical,
    origin: target.origin,
    // relative: the form works on the app's address and on the owner's domain (its home page too)
    leadAction: `/${target.slug}/lead`,
  });
  return { html, images: seoImages };
}

/** The highest image number among these images (img-N), or `floor` if that's higher. */
export function highestImageNumber(images: PromptImage[], floor = 0): number {
  return Math.max(floor, 0, ...images.map((i) => imageKeyNumber(i.key)));
}

/**
 * Images added with an AI edit, joined to the page's images. An image the page already has isn't added
 * twice, and one whose number was taken meanwhile (an image added under "Guide the AI" while this one
 * waited) gets the next free number: numbers are never shared, nor reused after `floor` (seoImageMax).
 */
export function joinImages(existing: PromptImage[], added: PromptImage[], floor = 0): { images: PromptImage[]; added: PromptImage[] } {
  const images = [...existing];
  const out: PromptImage[] = [];
  const reserved = floor ? [`img-${floor}`] : [];
  for (const img of added) {
    if (images.some((i) => i.media.id === img.media.id)) continue;
    const next = images.some((i) => i.key === img.key) || imageKeyNumber(img.key) <= floor ? { ...img, key: nextImageKey(images, reserved) } : img;
    images.push(next);
    out.push(next);
  }
  return { images, added: out };
}
