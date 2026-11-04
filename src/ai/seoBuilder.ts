// The SEO page builder's AI changes apart from its page: writing or rewriting the page (its metadata first
// when it has none), switching its type, an Edit with AI, a section rewrite, new metadata, and undoing the
// last AI change. Shared by Marketing → SEO page and the assistant, so both do exactly the same.
//
// Each change names the project it is for: an AI answer that comes back after the owner switched projects
// still lands in the project it was asked for. Every AI change can be undone (kept in memory, per project).

import type { PageType, Project, PromptImage, SalesPage, SalesSection, SeoMeta } from '@/lib/types';
import { joinImages, highestImageNumber } from '@/lib/seoPage';
import { useSeoUndo, type SeoSnapshot } from '@/store/seoUndo';
import { useStore } from '@/store/useStore';
import { applyEdit, canonicalForSlugChange, pruneImages, withKeptSections, withOwnerFacts } from './local/seo';
import type { SalesPageInput, SeoMetaInput } from './tasks';

type Marketing = Project['marketing'];

const projectOf = (projectId: string): Project | null => useStore.getState().projects.find((p) => p.id === projectId) ?? null;

/** Change one project's marketing (the page's metadata, page, type, images…). */
export function saveSeo(projectId: string, patch: Partial<Marketing>): void {
  useStore.getState().updateProject(projectId, (p) => ({ ...p, marketing: { ...p.marketing, ...patch } }));
}

/** The images and the highest image number they've used, for saving a new image list. */
export function seoImagesPatch(projectId: string, next: PromptImage[]): Partial<Marketing> {
  return { seoImages: next, seoImageMax: highestImageNumber(next, projectOf(projectId)?.marketing.seoImageMax) };
}

/** Keep the page, its metadata and its type as they are now, so the AI change about to be saved can be undone. */
export function rememberSeo(projectId: string): SeoSnapshot | null {
  const m = projectOf(projectId)?.marketing;
  if (!m || (!m.salesPage && !m.seo)) return null;
  const snap: SeoSnapshot = { salesPage: m.salesPage, seo: m.seo, pageType: m.pageType };
  useSeoUndo.getState().push(projectId, snap);
  return snap;
}

/**
 * Undo the last AI change (the page, its metadata and its type go back). With `only`, it undoes that change
 * only if nothing came after it ('newer' otherwise). An image removed from the page's images since then
 * stays off the page.
 */
export function undoSeo(projectId: string, only?: SeoSnapshot | null): 'undone' | 'nothing' | 'newer' {
  const stack = useSeoUndo.getState().stacks[projectId] ?? [];
  const top = stack[stack.length - 1];
  if (!top) return 'nothing';
  if (only && top !== only) return stack.includes(only) ? 'newer' : 'nothing';
  const snap = useSeoUndo.getState().pop(projectId)!;
  const images = projectOf(projectId)?.marketing.seoImages ?? [];
  saveSeo(projectId, { seo: snap.seo, salesPage: snap.salesPage ? { ...pruneImages(snap.salesPage, images), updatedAt: Date.now() } : null, pageType: snap.pageType });
  return 'undone';
}

/** How the AI writes: the page's hooks (null when stopped or failed), or the assistant's runAITask. */
export interface SeoWriters {
  meta: (input: SeoMetaInput) => Promise<SeoMeta | null | undefined>;
  page: (input: SalesPageInput) => Promise<SalesPage | null | undefined>;
}

export interface SeoWritten {
  seo: SeoMeta;
  page: SalesPage;
  /** the metadata was written too (the page had none) */
  wroteMeta: boolean;
  /** the first change's undo snapshot (null when there was nothing to undo to) */
  undo: SeoSnapshot | null;
}

/**
 * Write the page as `pageType`, or rewrite it (Write page, Rewrite page, Page type → Change), with the owner's
 * guidance and all the page's images. Its metadata is written first when it has none. Sections the new page
 * doesn't have that hold what the owner entered stay, hidden. Resolves null when the AI was stopped or failed
 * (the metadata it wrote first stays, and can be undone).
 */
export async function writeSeoPage(projectId: string, pageType: PageType, ai: SeoWriters): Promise<SeoWritten | null> {
  const m = projectOf(projectId)?.marketing;
  if (!m) return null;
  const instructions = (m.seoGuide ?? '').trim();
  const images = m.seoImages ?? [];
  let undo: SeoSnapshot | null | undefined;
  const put = (patch: Partial<Marketing>) => {
    if (undo === undefined) undo = rememberSeo(projectId);
    saveSeo(projectId, patch);
  };
  let seo = m.seo;
  const wroteMeta = !seo;
  if (!seo) {
    seo = (await ai.meta({ instructions, images, pageType })) ?? null;
    // stopped (or failed): the page needs its metadata, so don't go on without it
    if (!seo) return null;
    put({ seo });
  }
  const page = await ai.page({ primaryKeyword: seo.primaryKeyword, instructions, images, pageType });
  if (!page) return null;
  const salesPage = { ...withKeptSections(page, projectOf(projectId)?.marketing.salesPage ?? null), updatedAt: Date.now() };
  put({ salesPage, pageType });
  return { seo, page: salesPage, wroteMeta, undo: undo ?? null };
}

/** New metadata (Regenerate): a canonical the app made from the slug follows the new slug; an address the owner pasted is kept. */
export function applySeoMeta(projectId: string, next: SeoMeta): void {
  const p = projectOf(projectId);
  if (!p) return;
  const cur = p.marketing.seo;
  const canonical = cur ? canonicalForSlugChange(p, cur.canonical, cur.slug, next.slug) : next.canonical;
  rememberSeo(projectId);
  saveSeo(projectId, { seo: { ...next, canonical } });
}

/** A rewritten section, saved where it is now (its place, visibility and facts as they are now). */
export function applySalesSection(projectId: string, id: string, next: SalesSection): void {
  const cur = projectOf(projectId)?.marketing.salesPage;
  if (!cur?.sections.some((x) => x.id === id)) return;
  rememberSeo(projectId);
  saveSeo(projectId, { salesPage: { ...withOwnerFacts({ ...cur, sections: cur.sections.map((x) => (x.id === id ? ({ ...next, id, visible: x.visible } as SalesSection) : x)) }, cur), updatedAt: Date.now() } });
}

/**
 * An AI edit made from `base`, saved over the page as it is now, with the images it added joined to the
 * page's images as they are now (others may have been added or removed meanwhile). Null when it changed
 * nothing; otherwise the undo snapshot it kept.
 */
export function applySalesPageEdit(projectId: string, next: SalesPage, base: SalesPage, added: PromptImage[] = []): { undo: SeoSnapshot | null } | null {
  const m = projectOf(projectId)?.marketing;
  const cur = m?.salesPage;
  if (!m || !cur) return null;
  const imgs = added.length ? joinImages(m.seoImages ?? [], added, m.seoImageMax).images : undefined;
  const merged = pruneImages(applyEdit(cur, base, next), imgs ?? m.seoImages ?? []);
  const same = JSON.stringify(merged.sections) === JSON.stringify(cur.sections) && JSON.stringify(merged.theme) === JSON.stringify(cur.theme);
  if (same && !imgs) return null;
  const undo = rememberSeo(projectId);
  saveSeo(projectId, { salesPage: { ...merged, updatedAt: Date.now() }, ...(imgs ? seoImagesPatch(projectId, imgs) : {}) });
  return { undo };
}
