// Using a page from Manus or Viktor: as a new Code & assets asset (or in place of one made earlier from the same
// build, with Undo), or as the SEO page's HTML mode (the structured page stays; Version switches back; Undo). The
// page is cleaned first (importHtml.ts) and its {{img-N}} tokens are renumbered into the asset's or the SEO page's
// own image numbers, so a number already used there (whose published file may still be cached) never shows
// another picture. Nothing is published by itself.

import type { AgentId, BuildTarget } from '@/lib/agentTypes';
import type { CodeAsset, CodeKind, PageType, Project, PromptImage, SeoMeta } from '@/lib/types';
import { CODE_KINDS, matchKind } from '@/ai/local/code';
import { canonicalFor } from '@/ai/local/seo';
import { addCodeAsset, findCodeAsset, imageUseNotes, patchCodeAsset, rememberCodeUndo, reservedImageKeys, snapshotOf, useCodeTabMemory } from '@/lib/codeAssets';
import { PAGE_TYPES } from '@/lib/pageTypes';
import { MAX_PROMPT_IMAGES, imageKeyNumber, imageTokens, nextImageKey } from '@/lib/promptImages';
import { highestImageNumber } from '@/lib/seoPage';
import { slugify } from '@/lib/utils';
import { rememberSeo, saveSeo } from '@/ai/seoBuilder';
import { openPage } from '@/ai/assistant/nav';
import { useStore } from '@/store/useStore';
import { toast, useUI } from '@/store/ui';
import { importAgentHtml, rewriteImageTokens } from './importHtml';
import { importAgentEmailHtml, magnetFromHtml } from './emailImport';
import type { LeadMagnetType } from '@/lib/types';
import { LEAD_MAGNET_TYPES } from '@/ai/local/email';
import { applyLeadMagnet } from '@/lib/emailFunnel';
import { docOf, newBlockId, replaceDoc } from '@/lib/emailDoc';
import { uploadPublicImage } from '@/lib/leadFiles';
import { getBlob } from '@/lib/storage';
import { uid } from '@/lib/utils';
import { confirmAction } from '@/components/ui/primitives';
import { findBuild, markImported } from './buildRecords';

export interface AgentHtmlSource {
  via: AgentId;
  /** the page as the agent sent it */
  html: string;
  /** the images sent with that request or chat thread; their keys are the page's {{img-N}} tokens */
  images: PromptImage[];
  /** the Manus task, or the Slack permalink */
  url?: string;
  buildId?: string;
  /** CodeKind (asset) or PageType (seo); absent from a chat */
  kind?: string;
  /** the owner's words, kept as the asset's prompt */
  request?: string;
  /** an email build: which email it designs */
  stepId?: string;
}

const AGENT_NAME: Record<AgentId, string> = { manus: 'Manus', viktor: 'Viktor' };
/** The highest image number a published page can use (its files are img-1 … img-99). */
const MAX_IMAGE_NUMBER = 99;
/** Tokens of images the agent wasn't given get numbers no image can have, so the importer takes them out. */
const NO_IMAGE_FROM = 1000;

const projectOf = (projectId: string): Project | undefined => useStore.getState().projects.find((p) => p.id === projectId);
const CODE_KIND_IDS = CODE_KINDS.map((k) => k.id) as string[];
const isCodeKind = (k: string | undefined): k is CodeKind => !!k && CODE_KIND_IDS.includes(k);
const isPageType = (k: string | undefined): k is PageType => !!k && (PAGE_TYPES as string[]).includes(k);
const allCode = (c: { html: string; css: string; js: string }) => `${c.html}\n${c.css}\n${c.js}`;
const byNumber = (a: PromptImage, b: PromptImage) => imageKeyNumber(a.key) - imageKeyNumber(b.key);

/** The owner's website's host ('' when there's none). */
function ownHostOf(p: Project): string {
  const raw = (p.brand.websiteUrl ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Text cut at a word, without an ellipsis (a title or a description), at most `max` characters. */
function clipWords(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, '');
}

/**
 * Incoming images given keys among `existing`: the same file keeps the key it has there; any other gets the next
 * free key (never one in `reserved`). `map` takes each incoming key to its new one.
 */
export function remapImages(existing: PromptImage[], incoming: PromptImage[], reserved: readonly string[] = []): { images: PromptImage[]; added: PromptImage[]; map: Record<string, string> } {
  const images = [...existing];
  const added: PromptImage[] = [];
  const map: Record<string, string> = {};
  for (const img of incoming) {
    const have = images.find((i) => i.media.id === img.media.id);
    if (have) {
      map[img.key] = have.key;
      continue;
    }
    const key = nextImageKey(images, reserved);
    const next = { ...img, key };
    images.push(next);
    added.push(next);
    map[img.key] = key;
  }
  return { images, added, map };
}

/** The map, plus a dead number for every token the page uses that isn't one of the images sent (so a renumbered image can't land on it). */
function withDeadTokens(html: string, sent: PromptImage[], map: Record<string, string>): Record<string, string> {
  const out = { ...map };
  const sentKeys = new Set(sent.map((i) => i.key));
  let dead = NO_IMAGE_FROM;
  for (const k of imageTokens(html)) if (!sentKeys.has(k) && !out[k]) out[k] = `img-${dead++}`;
  return out;
}

/** The images an asset keeps: those its code shows, then the others sent, up to the most an asset has. */
function keptImages(images: PromptImage[], code: { html: string; css: string; js: string }, always: PromptImage[] = []): PromptImage[] {
  const used = new Set(imageTokens(allCode(code)));
  const shown = images.filter((i) => used.has(i.key));
  const rest = images.filter((i) => !used.has(i.key) && !always.includes(i));
  const keep = [...always.filter((i) => !used.has(i.key)), ...shown];
  for (const i of rest) if (keep.length < MAX_PROMPT_IMAGES) keep.push(i);
  return [...new Set(keep)].sort(byNumber);
}

/** An image as a project keeps it (no thumbnail: the list loads it from the file). */
const stored = (i: PromptImage): PromptImage => {
  const { thumb: _thumb, ...media } = i.media;
  return { ...i, media };
};

/**
 * A page from Manus or Viktor as a Code & assets asset: a new one first in the list, or (`replaceAssetId`) the code
 * of an asset made earlier from the same build replaced, which Undo puts back. Refused when the page isn't usable.
 */
export function addAgentAsset(projectId: string, src: AgentHtmlSource, o: { replaceAssetId?: string } = {}): { ok: true; asset: CodeAsset; notes: string[] } | { ok: false; message: string } {
  const p = projectOf(projectId);
  if (!p) return { ok: false, message: 'That project isn’t here any more.' };
  const existing = o.replaceAssetId ? findCodeAsset(projectId, o.replaceAssetId) : undefined;
  if (o.replaceAssetId && !existing) return { ok: false, message: 'That asset was deleted: add the page as a new asset instead.' };
  const name = AGENT_NAME[src.via];
  const now = Date.now();

  let images: PromptImage[];
  let raw = src.html;
  let keepAll: PromptImage[] = [];
  if (existing) {
    const reserved = reservedImageKeys(existing, useCodeTabMemory.getState().undo[existing.id]);
    const r = remapImages(existing.images ?? [], src.images.map(stored), reserved);
    images = r.images;
    keepAll = existing.images ?? [];
    raw = rewriteImageTokens(raw, withDeadTokens(raw, src.images, r.map));
  } else images = src.images.map(stored);

  const imported = importAgentHtml(raw, { target: 'asset', imageKeys: images.map((i) => i.key), fallbackTitle: `Page from ${name}`, ownHost: ownHostOf(p) });
  if (!imported.ok) return { ok: false, message: imported.message };
  const { html, css, js, title, notes } = imported.page;
  const code = { html, css, js };
  const kept = keptImages(images, code, keepAll);
  const source = { via: src.via, ...(src.url ? { url: src.url } : {}), ...(src.buildId ? { buildId: src.buildId } : {}), at: now };

  if (existing) {
    rememberCodeUndo(existing.id, snapshotOf(existing));
    patchCodeAsset(projectId, existing.id, { html, css, js, images: kept, source: { ...existing.source, ...source } });
    const asset = findCodeAsset(projectId, existing.id)!;
    return { ok: true, asset, notes: [...notes, ...imageUseNotes(asset)] };
  }
  const kind: CodeKind = isCodeKind(src.kind) ? src.kind : matchKind(title) ?? 'hero';
  const made = addCodeAsset(projectId, { name: title, kind, html, css, js }, (src.request ?? '').trim(), kept);
  patchCodeAsset(projectId, made.id, { source });
  const asset = findCodeAsset(projectId, made.id)!;
  return { ok: true, asset, notes: [...notes, ...imageUseNotes(asset)] };
}

/**
 * A page from Manus or Viktor as the SEO page (HTML mode): it becomes the page that's shown, scored and published
 * (at the same address), and the app's structured page stays for Version → The app's builder. Its images take
 * numbers in the SEO page's own number space (the same file keeps its number). Metadata is made from the page's
 * title and description when there's none yet (no AI). Undo puts back what was there, even an empty builder.
 */
export function setAgentSeoPage(projectId: string, src: AgentHtmlSource): { ok: true; notes: string[]; replaced: boolean } | { ok: false; message: string } {
  const p = projectOf(projectId);
  if (!p) return { ok: false, message: 'That project isn’t here any more.' };
  const m = p.marketing;
  const seoImages = m.seoImages ?? [];
  const before = m.seoHtml?.images ?? [];
  // only the images the page shows take a number
  const shown = new Set(imageTokens(src.html));
  let top = Math.max(m.seoImageMax ?? 0, highestImageNumber(seoImages), highestImageNumber(before));
  const map: Record<string, string> = {};
  const images: PromptImage[] = [];
  for (const img of src.images) {
    if (!shown.has(img.key) || map[img.key]) continue;
    const known = seoImages.find((i) => i.media.id === img.media.id) ?? before.find((i) => i.media.id === img.media.id) ?? images.find((i) => i.media.id === img.media.id);
    let key = known?.key;
    if (!key) {
      if (top >= MAX_IMAGE_NUMBER) return { ok: false, message: 'Too many image numbers used on this page: remove an image you no longer use.' };
      key = `img-${++top}`;
    }
    map[img.key] = key;
    if (!images.some((i) => i.key === key)) images.push({ ...stored(img), key });
  }
  const raw = rewriteImageTokens(src.html, withDeadTokens(src.html, src.images, map));
  const name = AGENT_NAME[src.via];
  const imported = importAgentHtml(raw, { target: 'seo', imageKeys: images.map((i) => i.key), fallbackTitle: `Page from ${name}` });
  if (!imported.ok) return { ok: false, message: imported.message };
  const page = imported.page;
  const used = new Set(imageTokens(`${page.html}\n${page.css}`));
  const kept = images.filter((i) => used.has(i.key)).sort(byNumber);
  const replaced = !!m.salesPage || !!m.seoHtml?.active;
  const now = Date.now();

  let seo: SeoMeta | null = m.seo;
  if (!seo) {
    const metaTitle = clipWords(page.title, 60) || p.brand.name;
    const metaDescription = clipWords(page.description, 160);
    const slug = slugify(p.brand.name) || 'page';
    const firstShown = imageTokens(page.html).map((k) => kept.find((i) => i.key === k)).find(Boolean);
    seo = { metaTitle, metaDescription, slug, primaryKeyword: '', secondaryKeywords: [], ogTitle: metaTitle, ogDescription: metaDescription, ogImageAlt: firstShown?.note?.trim() ?? '', canonical: canonicalFor(p, slug) };
  }

  rememberSeo(projectId, { always: true });
  saveSeo(projectId, {
    seoHtml: {
      html: page.html,
      css: page.css,
      images: kept,
      source: { via: src.via, ...(src.url ? { url: src.url } : {}), ...(src.buildId ? { buildId: src.buildId } : {}), at: now },
      title: page.title,
      description: page.description,
      notes: page.notes,
      active: true,
      hasLeadForm: page.hasLeadForm,
      importedAt: now,
    },
    seoImageMax: highestImageNumber(kept, Math.max(m.seoImageMax ?? 0, highestImageNumber(seoImages))),
    seo,
    ...(isPageType(src.kind) ? { pageType: src.kind } : {}),
  });
  return { ok: true, notes: page.notes, replaced };
}

/** Upload the build's images an email shows ({{img-N}}) to the app's public images; all or nothing. */
export async function hostEmailImages(html: string, images: PromptImage[], upload = uploadPublicImage): Promise<{ ok: true; html: string } | { ok: false; message: string }> {
  let out = html;
  for (const key of imageTokens(html)) {
    const img = images.find((i) => i.key === key);
    const blob = img ? await getBlob(img.media.id).catch(() => null) : null;
    if (!img || !blob) return { ok: false, message: `The picture ${key} from this build isn’t on this device. Nothing was changed.` };
    try {
      const name = /\.(png|jpe?g|webp|gif)$/i.test(img.media.name ?? '') ? img.media.name! : `${key}.${blob.type === 'image/jpeg' ? 'jpg' : 'png'}`;
      const { url } = await upload(blob, name, undefined, 'email');
      out = out.split(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g')).join(url);
    } catch (e) {
      return { ok: false, message: `A picture couldn’t be uploaded, so nothing was changed: ${e instanceof Error ? e.message : 'try again.'}` };
    }
  }
  return { ok: true, html: out };
}

/**
 * A designed email from Manus or Viktor: one custom block (cleaned by the shared sanitizer, its pictures uploaded
 * first), in place of the email's blocks (Undo puts them back) or added below them. Nothing is half-applied.
 */
export async function setAgentEmail(projectId: string, src: AgentHtmlSource, o: { append?: boolean; upload?: typeof uploadPublicImage } = {}): Promise<{ ok: true; notes: string[] } | { ok: false; message: string }> {
  const p = projectOf(projectId);
  const step = p?.marketing.emails.find((e) => e.id === src.stepId);
  if (!p || !step) return { ok: false, message: 'That email isn’t in the sequence any more.' };
  const imported = importAgentEmailHtml(src.html, { target: 'email', imageKeys: src.images.map((i) => i.key) });
  if (!imported.ok) return { ok: false, message: imported.message };
  const hosted = await hostEmailImages(imported.html, src.images, o.upload);
  if (!hosted.ok) return hosted;
  const now = projectOf(projectId)?.marketing.emails.find((e) => e.id === step.id);
  if (!now) return { ok: false, message: 'That email isn’t in the sequence any more.' };
  const current = docOf(now, projectOf(projectId)!);
  const block = { id: newBlockId(), type: 'custom' as const, html: hosted.html, ...(imported.css ? { css: imported.css } : {}), source: 'agent' as const, ...(imported.notes.length ? { notes: imported.notes.slice(0, 20) } : {}) };
  replaceDoc(projectId, step.id, { ...current, blocks: o.append ? [...current.blocks, block] : [block] });
  return { ok: true, notes: imported.notes };
}

/** A lead magnet from Manus or Viktor: its words read into the guide (the app makes the PDF); the download stays, to publish again. */
export function setAgentLeadMagnet(projectId: string, src: AgentHtmlSource): { ok: true; notes: string[] } | { ok: false; message: string } {
  const p = projectOf(projectId);
  if (!p) return { ok: false, message: 'That project isn’t here any more.' };
  const imported = importAgentEmailHtml(src.html, { target: 'leadMagnet', imageKeys: [] });
  if (!imported.ok) return { ok: false, message: imported.message };
  const current = p.marketing.leadMagnet;
  const type = (LEAD_MAGNET_TYPES.some((t) => t.id === src.kind) ? src.kind : current?.type ?? 'checklist') as LeadMagnetType;
  const lm = magnetFromHtml(imported.html, { type, current, id: current?.id ?? uid('lm'), now: Date.now(), typeLabel: LEAD_MAGNET_TYPES.find((t) => t.id === type)?.label ?? 'guide' });
  if (!lm) return { ok: false, message: 'That document has no title and sections the app can use. Ask for one with an h1 title and h2 sections.' };
  applyLeadMagnet({ ...lm, design: { source: 'agent', via: src.via, ...(src.buildId ? { buildId: src.buildId } : {}), importedAt: Date.now() } }, projectId);
  return { ok: true, notes: imported.notes };
}

/** Studio → Code & assets, with that asset open (through the leave guard). */
export async function showAgentAsset(assetId: string): Promise<boolean> {
  if (!(await openPage('studio', 'code'))) return false;
  useUI.getState().requestAsset(assetId);
  return true;
}

/** Marketing → SEO page (through the leave guard). */
export function showAgentSeoPage(): Promise<boolean> {
  return openPage('marketing-seo');
}

/**
 * "Use this": the page as an asset (a new one, or `replaceAssetId`) or as the SEO page, then that page opens. A
 * build it came from is marked as used. Says what happened in a toast; nothing is published.
 */
export async function applyAgentPage(projectId: string, target: BuildTarget, src: AgentHtmlSource, o: { replaceAssetId?: string; resultAt?: string; append?: boolean } = {}): Promise<{ ok: true; notes: string[] } | { ok: false; message: string }> {
  const name = AGENT_NAME[src.via];
  if (target === 'email') {
    const step = projectOf(projectId)?.marketing.emails.find((e) => e.id === src.stepId);
    if (step?.doc && !o.append && !(await confirmAction({ title: `Use ${name}’s email?`, body: 'It replaces this email’s blocks. Undo in the email studio puts them back.', confirmLabel: 'Use this' }))) return { ok: false, message: 'Kept your email as it was.' };
    const r = await setAgentEmail(projectId, src, { append: o.append });
    if (!r.ok) return r;
    if (src.buildId && findBuild(projectId, src.buildId)) markImported(projectId, src.buildId, { at: Date.now(), result: o.resultAt ?? '', email: src.stepId });
    toast({ kind: 'success', title: o.append ? `Added ${name}’s design below` : `Your email is now ${name}’s design`, body: r.notes[0] ?? 'Undo in the email studio puts the earlier blocks back.' });
    void openPage('marketing-email', 'sequence');
    return r;
  }
  if (target === 'leadMagnet') {
    if (projectOf(projectId)?.marketing.leadMagnet && !(await confirmAction({ title: `Use ${name}’s lead magnet?`, body: 'Its words replace your lead magnet’s. Your download stays: publish it again to update it.', confirmLabel: 'Use this' }))) return { ok: false, message: 'Kept your lead magnet as it was.' };
    const r = setAgentLeadMagnet(projectId, src);
    if (!r.ok) return r;
    if (src.buildId && findBuild(projectId, src.buildId)) markImported(projectId, src.buildId, { at: Date.now(), result: o.resultAt ?? '', leadMagnet: true });
    const published = !!projectOf(projectId)?.marketing.leadMagnet?.delivery;
    toast({ kind: 'success', title: `Your lead magnet is now ${name}’s`, body: published ? 'Your download is out of date: publish it again in Lead magnet › Delivery.' : 'Publish it in Lead magnet › Delivery when you’re ready.' });
    void openPage('marketing-email', 'magnet');
    return r;
  }
  if (target === 'asset') {
    const r = addAgentAsset(projectId, src, o);
    if (!r.ok) return r;
    if (src.buildId && findBuild(projectId, src.buildId)) markImported(projectId, src.buildId, { at: Date.now(), result: o.resultAt ?? '', assetId: r.asset.id });
    toast({ kind: 'success', title: o.replaceAssetId ? `Updated “${r.asset.name}”` : `Added “${r.asset.name}” to Code & assets`, body: o.replaceAssetId ? 'Undo on the asset puts the earlier code back.' : undefined });
    void showAgentAsset(r.asset.id);
    return { ok: true, notes: r.notes };
  }
  const r = setAgentSeoPage(projectId, src);
  if (!r.ok) return r;
  if (src.buildId && findBuild(projectId, src.buildId)) markImported(projectId, src.buildId, { at: Date.now(), result: o.resultAt ?? '', seo: true });
  const live = !!projectOf(projectId)?.marketing.seoPublished;
  toast({ kind: 'success', title: `Your SEO page is now ${name}’s page`, body: live ? 'Publish it to update your live page.' : 'Switch back any time under Version, or press Undo.' });
  void showAgentSeoPage();
  return { ok: true, notes: r.notes };
}
