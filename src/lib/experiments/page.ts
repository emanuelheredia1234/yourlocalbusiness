// The SEO page's version B (P4b §A2, §A6): version A is the page as it's published; B is the same page with only its
// hero changed (section mode: the hero's headline, subheading, image or button text; HTML mode: the first <h1>'s text
// and the form's button text, no image swap). B is built by the same builder as a publish, so it keeps the page's
// canonical link, form and images (only images published with the page).

import type { HeroData, Project, SalesSection, SeoVariant } from '@/lib/types';
import { seoHtmlActive, seoPublishBuild } from '@/lib/seoPage';
import { appOriginNow, offersForPublish, preparePublish, publishTarget } from '@/lib/publish';
import { offerIdsForPublish } from '@/store/offers';
import type { HeroFields } from './variants';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const H1 = /(<h1\b[^>]*>)([\s\S]*?)(<\/h1>)/i;
/** the form's submit button: <button type="submit" …>text</button> (or a button in a form with no type) */
const SUBMIT = /(<form\b[\s\S]*?<button\b(?![^>]*type=["'](?:button|reset)["'])[^>]*>)([\s\S]*?)(<\/button>)/i;

const heroSection = (project: Project) => project.marketing.salesPage?.sections.find((s): s is Extract<SalesSection, { type: 'hero' }> => s.type === 'hero');

/** The page's hero as it is (version A's fields), or null when there's no page to test. */
export function heroOf(project: Project): (HeroFields & { mode: 'sections' | 'html' }) | null {
  if (seoHtmlActive(project)) {
    const html = project.marketing.seoHtml?.html ?? '';
    const h1 = H1.exec(html);
    if (!h1) return null;
    return { mode: 'html', headline: unesc(h1[2]), subheadline: '', ctaLabel: unesc(SUBMIT.exec(html)?.[2] ?? '') };
  }
  const hero = heroSection(project)?.data;
  if (!hero) return null;
  return { mode: 'sections', headline: hero.headline, subheadline: hero.subheadline, ctaLabel: hero.ctaLabel, ...(hero.imageId ? { imageId: hero.imageId } : {}) };
}

/** The project with version B's changes on it (the saved page itself is never changed here). */
export function withSeoVariant(project: Project, overrides: SeoVariant['overrides']): Project {
  if (seoHtmlActive(project) && project.marketing.seoHtml) {
    let html = project.marketing.seoHtml.html;
    if (overrides.headline !== undefined) html = html.replace(H1, (_m, a: string, _b: string, c: string) => `${a}${esc(overrides.headline!)}${c}`);
    if (overrides.ctaLabel !== undefined) html = html.replace(SUBMIT, (_m, a: string, _b: string, c: string) => `${a}${esc(overrides.ctaLabel!)}${c}`);
    return { ...project, marketing: { ...project.marketing, seoHtml: { ...project.marketing.seoHtml, html } } };
  }
  const page = project.marketing.salesPage;
  if (!page) return project;
  const sections = page.sections.map((s) => {
    if (s.type !== 'hero') return s;
    const data: HeroData = { ...s.data };
    if (overrides.headline !== undefined) data.headline = overrides.headline;
    if (overrides.subheadline !== undefined) data.subheadline = overrides.subheadline;
    if (overrides.ctaLabel !== undefined) data.ctaLabel = overrides.ctaLabel;
    if (overrides.imageId !== undefined) data.imageId = overrides.imageId || undefined;
    return { ...s, data };
  });
  return { ...project, marketing: { ...project.marketing, salesPage: { ...page, sections } } };
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Version B as it would be published now, at the page's own address: { html, sha256 }. Throws a plain-words Error
 * when the page isn't published (version A is the published page).
 */
export async function buildVersionB(project: Project, overrides: SeoVariant['overrides']): Promise<{ html: string; sha256: string }> {
  const pub = project.marketing.seoPublished;
  if (!pub) throw new Error('Publish the page first: version A is the page as it’s published.');
  const target = publishTarget(appOriginNow(), pub.slug, pub.domain ?? null, pub.home);
  const built = seoPublishBuild(withSeoVariant(project, overrides), target);
  if (!built.html) throw new Error('The page has nothing to build yet.');
  const offers = await offersForPublish(built.html, project.id, offerIdsForPublish);
  const ready = await preparePublish(built, pub.slug, project.marketing.leadMagnet?.delivery?.fileId, offers);
  return { html: ready.html, sha256: await sha256Hex(ready.html) };
}
