// A lead magnet as a PDF: its guide (title, subtitle, intro, sections, closing call to action) laid out with the
// app's ebook builder, in the brand's colours with the listing cover. This is the "PDF made from this guide"
// download that Email › Lead magnet publishes at /m/<id>.

import type { LeadMagnet, Project } from './types';
import { buildEbookPdf, type EbookDoc } from './ebook';
import { fingerprint } from './publish';
import { pageLink } from './pageLink';
import { LEAD_MAGNET_TYPES } from '@/ai/local/email';
import { coverBytes } from '@/ai/productFiles';

const COVER_ASPECT = 612 / (792 * 0.56);

/** What the guide says, as an ebook: its sections become chapters, its call to action the conclusion and next steps. */
export function leadMagnetEbook(lm: LeadMagnet, project: Project, cover: EbookDoc['cover'] = null, now = new Date()): EbookDoc {
  const cta = lm.cta.trim();
  const link = pageLink(project);
  return {
    title: lm.title.trim() || 'Your free guide',
    subtitle: lm.subtitle.trim(),
    author: project.brand.name || 'Your brand',
    ...(link ? { website: link.url.replace(/^https?:\/\//, '').replace(/\/+$/, '') } : {}),
    ...(project.brand.tagline ? { tagline: project.brand.tagline } : {}),
    formatLabel: LEAD_MAGNET_TYPES.find((t) => t.id === lm.type)?.label ?? 'Guide',
    colors: project.brand.colors,
    welcome: lm.intro.trim(),
    howToUse: [],
    disclaimer: '',
    chapters: lm.sections
      .filter((s) => s.heading.trim() || s.items.some((i) => i.trim()))
      .map((s) => ({ title: s.heading.trim() || 'Section', items: s.items.map((i) => i.trim()).filter(Boolean).map((title) => ({ title })) })),
    conclusion: cta,
    nextSteps: cta ? cta.split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 5) : [],
    cover,
    edition: now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    year: now.getFullYear(),
  };
}

/** A fingerprint of what the PDF is made from (the guide's words and the brand), to tell when a published one is out of date. */
export function leadMagnetHash(lm: LeadMagnet, project: Project): string {
  const c = project.brand.colors;
  return fingerprint(JSON.stringify([lm.type, lm.title, lm.subtitle, lm.intro, lm.sections, lm.cta, project.brand.name, c.primary, c.accent, c.ink, c.paper]));
}

/** The PDF itself (the listing cover on it when there is one). */
export async function leadMagnetPdf(lm: LeadMagnet, project: Project): Promise<{ bytes: Uint8Array; pages: number }> {
  const cover = await coverBytes(project, COVER_ASPECT).catch(() => null);
  return buildEbookPdf(leadMagnetEbook(lm, project, cover), { theme: 'modern', pageSize: 'letter', fillable: false });
}
