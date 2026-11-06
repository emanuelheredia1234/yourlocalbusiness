// The Code & assets tab's logic, apart from its UI: undo snapshots (which keep the asset's images), the
// image keys a new image mustn't take, what to tell the owner about images the code doesn't show or no
// longer has, and the documents an asset makes: to copy or download (images embedded as data URLs)
// and to publish (images as {{img-N}} tokens, which publishing turns into addresses). Also what the tab
// keeps while the app is open (each asset's undo stack, each project's creation box), and how a new or
// edited asset is saved: shared by Studio → Code & assets and the assistant, so both do exactly the same.

import { create } from 'zustand';
import type { CodeAsset, CodeKind, Project, PromptImage, Published } from '@/lib/types';
import { buildDocument, type CodeResult } from '@/ai/local/code';
import { imageDataUrls, imageKeyNumber, imageTokens } from '@/lib/promptImages';
import { appOriginNow, buildHash, type PublishBuild } from '@/lib/publish';
import { allKnownOfferIds, offerIdsForCopy } from '@/store/offers';
import { hasBuyToken } from './buyLinks';
import { hasLeadAction, LEAD_ACTION } from '@/lib/leadAction';
import { listJoin, uid } from '@/lib/utils';
import { useStore } from '@/store/useStore';

export type Code = { html: string; css: string; js: string };
/**
 * What Undo puts back: the code, and the images the asset had then. `script` (a sheet's Apps Script) only
 * when the change replaced it too (Regenerate): an edit never touches it, so Undo leaves the owner's own changes to it.
 */
export type Snapshot = Code & { images: PromptImage[]; script?: string };

/** The most AI changes each asset can undo. */
export const UNDO_LIMIT = 15;

export const codeOf = (a: Code): Code => ({ html: a.html, css: a.css, js: a.js });
const allCode = (c: Code) => `${c.html}\n${c.css}\n${c.js}`;
const sameCode = (a: Code, b: Code) => a.html === b.html && a.css === b.css && a.js === b.js;
const byNumber = (a: PromptImage, b: PromptImage) => imageKeyNumber(a.key) - imageKeyNumber(b.key);

export function snapshotOf(a: Code & { images?: PromptImage[]; script?: string }, withScript = false): Snapshot {
  return { ...codeOf(a), images: a.images ?? [], ...(withScript ? { script: a.script ?? '' } : {}) };
}

/** What Undo writes back to the asset for `snap`, given the images it has now (see imagesAfterUndo). */
export function undoPatch(current: PromptImage[], snap: Snapshot): Code & { images: PromptImage[]; script?: string } {
  return { ...codeOf(snap), images: imagesAfterUndo(current, snap), ...(snap.script !== undefined ? { script: snap.script || undefined } : {}) };
}

/** The undo stack with `snap` on top (the oldest dropped past the limit). Code the same as the top isn't pushed twice. */
export function pushSnapshot(stack: Snapshot[], snap: Snapshot): Snapshot[] {
  const top = stack[stack.length - 1];
  if (top && sameCode(top, snap)) return stack;
  return [...stack, snap].slice(-UNDO_LIMIT);
}

/**
 * Keys a new image mustn't take: the ones the code still uses (an image removed from the list but still
 * in the code) and the ones Undo could bring back. So a new image never shows up where an old one was.
 */
export function reservedImageKeys(a: Code, history: Snapshot[] = []): string[] {
  const keys = new Set(imageTokens(allCode(a)));
  for (const s of history) {
    for (const k of imageTokens(allCode(s))) keys.add(k);
    for (const i of s.images) keys.add(i.key);
  }
  return [...keys];
}

/**
 * The asset's images once Undo has put back `snap`'s code: the ones it has now, plus any of `snap`'s that
 * the restored code shows and that were removed since. Undo never takes away an image added after.
 */
export function imagesAfterUndo(current: PromptImage[], snap: Snapshot): PromptImage[] {
  const shown = new Set(imageTokens(allCode(snap)));
  const have = new Set(current.map((i) => i.key));
  const back = snap.images.filter((i) => shown.has(i.key) && !have.has(i.key));
  return back.length ? [...current, ...back].sort(byNumber) : current;
}

const names = (keys: string[]) => listJoin(keys.map((k) => String(imageKeyNumber(k))));

/** Images the asset has that its code doesn't show yet. */
export function unusedImages(a: Code & { images?: PromptImage[] }): PromptImage[] {
  const used = new Set(imageTokens(allCode(a)));
  return (a.images ?? []).filter((i) => !used.has(i.key));
}

/** Image keys the code uses that the asset doesn't have anymore (nothing shows there). */
export function missingImages(a: Code & { images?: PromptImage[] }): string[] {
  const have = new Set((a.images ?? []).map((i) => i.key));
  return imageTokens(allCode(a)).filter((k) => !have.has(k));
}

/** What to tell the owner after the AI made or changed the code, about images it doesn't show. */
export function imageUseNotes(a: Code & { images?: PromptImage[] }): string[] {
  const unused = unusedImages(a).map((i) => i.key);
  if (!unused.length) return [];
  const n = imageKeyNumber(unused[0]);
  return [`${unused.length === 1 ? `Image ${n} isn’t` : `Images ${names(unused)} aren’t`} in it yet. Say where in Edit with AI, e.g. “put image ${n} at the top”.`];
}

/** What to tell the owner about images the code uses that the asset no longer has. */
export function missingImagesNote(keys: string[]): string {
  return keys.length === 1
    ? `Image ${imageKeyNumber(keys[0])} was removed, but the code still uses it, so nothing shows there.`
    : `Images ${names(keys)} were removed, but the code still uses them, so nothing shows there.`;
}

// ───────────── documents ─────────────

/** A published asset's page id: 'artifact:<asset id>'. */
export const artifactPageId = (assetId: string) => `artifact:${assetId}`;

/** What an asset publishes: the full page, images as {{img-N}} (publishing gives them addresses), with the storage stand-in, since published pages run sandboxed. */
export function publishBuild(a: CodeAsset): PublishBuild {
  return { html: buildDocument(codeOf(a), a.name, { storageShim: true, leadAction: LEAD_ACTION }), images: a.images ?? [] };
}

const staleCache = new WeakMap<CodeAsset, boolean>();

/** Whether the asset changed since it was published from this device (unknown, so false, when it was published elsewhere). */
export function hasUnpublishedChanges(a: CodeAsset): boolean {
  const p: Published | undefined = a.published;
  if (!p?.hash) return false;
  let stale = staleCache.get(a);
  if (stale === undefined) {
    const b = publishBuild(a);
    stale = buildHash(b.html, b.images) !== p.hash;
    staleCache.set(a, stale);
  }
  return stale;
}

/** A copy's TODO where its forms would send, when the asset isn't published yet. */
const LEAD_TODO = `${String.fromCharCode(60)}!-- TODO: publish this asset in the app so its forms send to Email → Leads. Until then they send nothing. -->\n`;

/**
 * The page to copy or download, with its images embedded as data URLs, and the keys of any used image that couldn't be loaded.
 * Its forms send to the published asset's full address (https://<app>/<slug>/lead), so they work from anywhere; not published,
 * they send nothing yet, and a comment at the top says so.
 */
export function documentWithImages(a: CodeAsset, urls: Record<string, string>): { html: string; missing: string[] } {
  const code = codeOf(a);
  const missing = imageTokens(allCode(code)).filter((k) => !urls[k] && (a.images ?? []).some((i) => i.key === k));
  const published = a.published?.url && /^https?:\/\//.test(a.published.url) ? `${a.published.url.replace(/\/+$/, '')}/lead` : '';
  const forms = hasLeadAction(allCode(code));
  // its Buy buttons: the offer's full buy link, so the copy works from anywhere
  const buy = { mode: 'absolute' as const, origin: appOriginNow(), known: allKnownOfferIds() };
  const html = buildDocument(forms && !published ? { ...code, html: `${LEAD_TODO}${code.html}` } : code, a.name, { images: urls, buy, ...(published ? { leadAction: published } : {}) });
  return { html, missing };
}

/** The images the code shows (of those the asset has). */
const shownImages = (a: CodeAsset) => {
  const used = new Set(imageTokens(allCode(a)));
  return (a.images ?? []).filter((i) => used.has(i.key));
};

/**
 * documentWithImages straight away, when `ready` (data URLs already made for the preview) has every image
 * the code shows; null when some still have to be made. Copying straight away keeps the click's permission
 * to write to the clipboard, which some browsers drop while waiting.
 */
export function readyDocument(a: CodeAsset, ready: Record<string, string> | null | undefined): { html: string; missing: string[] } | null {
  const images = shownImages(a);
  if (images.length && !(ready && images.every((i) => ready[i.key]))) return null;
  return documentWithImages(a, ready ?? {});
}

/** documentWithImages, making the data URLs (or using ones already made for the preview). */
export async function downloadDocument(a: CodeAsset, ready?: Record<string, string> | null, projectId?: string): Promise<{ html: string; missing: string[] }> {
  // its Buy buttons: the business's offers asked of the server first, so none is left a dead # link
  if (projectId && hasBuyToken(allCode(codeOf(a)))) await offerIdsForCopy(projectId);
  return readyDocument(a, ready) ?? documentWithImages(a, await imageDataUrls(shownImages(a)));
}

/** What to tell the owner when a download or copy left images out. */
export function leftOutNote(keys: string[]): { title: string; body: string } {
  const one = keys.length === 1;
  return {
    title: one ? `Image ${imageKeyNumber(keys[0])} was left out` : `Images ${names(keys)} were left out`,
    body: `${one ? 'It' : 'They'} couldn’t be loaded on this device. If you added ${one ? 'it' : 'them'} on another device, ${one ? 'it' : 'they'} may still be uploading: try again in a minute.`,
  };
}

// ───────────── the creation box ─────────────

/** The kind the creation box starts on. */
export function defaultKind(p: Project): CodeKind {
  if (p.track === 'business') return 'booking';
  if (p.format === 'spreadsheet') return 'spreadsheet';
  if (p.format === 'course' || p.format === 'membership') return 'quiz';
  return 'calculator';
}

/** Ideas for the creation box (each names its kind first, so clicking one picks that kind). */
export function promptIdeas(p: Project): string[] {
  const topic = (p.category || p.niche || 'my niche').toLowerCase();
  return p.track === 'business'
    ? [`Booking widget for ${p.brand.name} with my packages`, `Instant quote calculator for ${topic}`, `FAQ that answers pricing and service-area questions`]
    : [`A calculator that shows the cost of ${topic} problems`, `A 5-question quiz that recommends ${p.idea?.title ?? 'my product'}`, `Launch countdown with an email capture`];
}

// ───────────── what the tab keeps while the app is open ─────────────

/** The creation box: what was typed, the images added, and the type picked (the project's usual one until then). */
export interface Draft {
  prompt: string;
  images: PromptImage[];
  kind?: CodeKind;
}
export const NO_DRAFT: Draft = { prompt: '', images: [] };

/**
 * Kept while the app is open, so switching Studio tabs loses neither (not saved): each asset's undo
 * stack, and each project's creation box (the type picked, what was typed and the images added).
 */
export const useCodeTabMemory = create<{ undo: Record<string, Snapshot[]>; drafts: Record<string, Draft> }>(() => ({ undo: {}, drafts: {} }));
export const setUndoStack = (assetId: string, stack: Snapshot[]) => useCodeTabMemory.setState((s) => ({ undo: { ...s.undo, [assetId]: stack } }));
/** Keep `snap` so Undo can put it back. Returns the top of the stack after (the same snapshot as before when the code didn't change). */
export function rememberCodeUndo(assetId: string, snap: Snapshot): Snapshot {
  const next = pushSnapshot(useCodeTabMemory.getState().undo[assetId] ?? [], snap);
  setUndoStack(assetId, next);
  return next[next.length - 1];
}

// ───────────── saving new and edited assets ─────────────

const projectOf = (projectId: string): Project | undefined => useStore.getState().projects.find((p) => p.id === projectId);
const setAssets = (projectId: string, fn: (list: CodeAsset[]) => CodeAsset[]) => useStore.getState().updateProject(projectId, (p) => ({ ...p, studio: { ...p.studio, codeAssets: fn(p.studio.codeAssets) } }));

/** One of a project's assets, as it is now. */
export const findCodeAsset = (projectId: string, assetId: string): CodeAsset | undefined => projectOf(projectId)?.studio.codeAssets.find((a) => a.id === assetId);

/** Change an asset (its "updated" time too). */
export function patchCodeAsset(projectId: string, assetId: string, patch: Partial<CodeAsset>): void {
  setAssets(projectId, (list) => list.map((a) => (a.id === assetId ? { ...a, ...patch, updatedAt: Date.now() } : a)));
}

/** A newly generated asset, first in the project's list, with the request and images it was made from. */
export function addCodeAsset(projectId: string, r: CodeResult, prompt: string, images: PromptImage[] = []): CodeAsset {
  const now = Date.now();
  const asset: CodeAsset = { id: uid('code'), name: r.name, kind: r.kind, prompt, html: r.html, css: r.css, js: r.js, script: r.script, ...(images.length ? { images } : {}), outdated: false, createdAt: now, updatedAt: now };
  setAssets(projectId, (list) => [asset, ...list]);
  return asset;
}

/**
 * An AI edit made from `before` (the asset's snapshot when it was asked for): the code becomes the edited
 * code, and Undo can put `before` back. 'unchanged' when the code came back the same (nothing to undo), 'gone'
 * when the asset was deleted meanwhile; otherwise the asset as saved and its undo snapshot.
 */
export function applyCodeEdit(projectId: string, assetId: string, before: Snapshot, r: Code): 'unchanged' | 'gone' | { asset: CodeAsset; undo: Snapshot } {
  if (!findCodeAsset(projectId, assetId)) return 'gone';
  if (sameCode(r, before)) return 'unchanged';
  const undo = rememberCodeUndo(assetId, before);
  patchCodeAsset(projectId, assetId, codeOf(r));
  return { asset: findCodeAsset(projectId, assetId)!, undo };
}

/**
 * Undo an asset's last AI change (its code, and any image the old code shows, go back). With `only`, it undoes
 * that change only if nothing came after it ('newer' otherwise).
 */
export function undoCodeAsset(projectId: string, assetId: string, only?: Snapshot): 'undone' | 'nothing' | 'newer' {
  const a = findCodeAsset(projectId, assetId);
  const stack = useCodeTabMemory.getState().undo[assetId] ?? [];
  const prev = stack[stack.length - 1];
  if (!a || !prev) return 'nothing';
  if (only && prev !== only) return stack.includes(only) ? 'newer' : 'nothing';
  setUndoStack(assetId, stack.slice(0, -1));
  patchCodeAsset(projectId, assetId, undoPatch(a.images ?? [], prev));
  return 'undone';
}
