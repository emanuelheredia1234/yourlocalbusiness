// The SEO page in HTML mode (a page Manus or Viktor made, marketing.seoHtml) as a whole document: the app writes
// its <head> from the owner's metadata (title, description, keywords, canonical, share image) and JSON-LD from the
// owner's own facts only (name, address, phone, email: never offers, prices or ratings), then the page's own
// styles and body. There's no other script: the page was cleaned of JavaScript when it was imported
// (src/ai/agents/importHtml.ts), and its one form posts to the published page's /<slug>/lead.
//
// Template text here never holds a literal closing script tag (the claude.ai build refuses one).

import type { Project } from './types';
import { imageTokens } from './promptImages';
import { escapeHtml } from './utils';
import { contactEmail, contactTel } from '@/ai/local/seo';
import { SCRIPT_CLOSE } from '@/ai/local/code';

const LT = String.fromCharCode(60);
const TOKEN = /\{\{\s*img-(\d+)\s*\}\}/g;
const LEAD_ACTION = '{{lead-action}}';
/** Stands for the share image in the JSON-LD until its address goes in (that address may be a {{img-N}} token). */
const SHARE_IMAGE = '__ylb_share_image__';

/** Text for an attribute or the page: escaped, and a "{{" in it can't become an image token. */
const text = (s: string) => escapeHtml(s).replace(/\{\{/g, '{&#123;');
const attr = (s: string) => escapeHtml(s);

export interface SeoHtmlOptions {
  /** the page's address (canonical link, og:url and the JSON-LD's url); '' leaves them out */
  canonical: string;
  /** where the page's images are served from: a share image needs a full address ('' leaves it out) */
  origin: string;
  /** where its form sends (/<slug>/lead once published; '' before) */
  leadAction: string;
  /** an image's address by its key: a {{img-N}} token (publishing), a data URL (Copy, Export, the preview), or undefined */
  imageUrl: (key: string) => string | undefined;
}

/** The images the HTML-mode page shows (its tokens, in the order they first appear), of those it has. */
export function seoHtmlShownImages(project: Project): string[] {
  const h = project.marketing.seoHtml;
  if (!h) return [];
  const have = new Set(h.images.map((i) => i.key));
  return imageTokens(`${h.html}\n${h.css}`).filter((k) => have.has(k));
}

/**
 * The HTML-mode page as one document (see the top of this file). Its images go through `o.imageUrl` (a token
 * an address can't be had for stays as it is); its form's {{lead-action}} becomes `o.leadAction`.
 */
export function seoHtmlDocument(project: Project, o: SeoHtmlOptions): string {
  const h = project.marketing.seoHtml;
  if (!h) return '';
  const meta = project.marketing.seo;
  const title = meta?.metaTitle.trim() || h.title;
  const description = meta?.metaDescription.trim() || h.description;
  const keywords = meta ? [meta.primaryKeyword, ...meta.secondaryKeywords].map((k) => k.trim()).filter(Boolean) : [];
  const ogTitle = meta?.ogTitle.trim() || title;
  const ogDescription = meta?.ogDescription.trim() || description;
  const canonical = o.canonical.trim();
  const origin = o.origin.replace(/\/+$/, '');
  const business = project.track === 'business';

  const fill = (s: string) => s.replace(TOKEN, (whole, n: string) => o.imageUrl(`img-${Number(n)}`) ?? whole);
  // the share image: the first image the page shows, as a full address (only where the page is served from)
  const first = seoHtmlShownImages(project)[0];
  const firstUrl = first ? o.imageUrl(first) : undefined;
  const shareImage = !firstUrl ? '' : /^https?:\/\//i.test(firstUrl) ? firstUrl : origin && /^(\/|\{\{)/.test(firstUrl) ? `${origin}${firstUrl}` : '';

  // JSON-LD from the owner's own facts only: never an offer, a price or a rating taken from the agent's page
  const listing = project.studio.listing;
  const telephone = contactTel(listing.phone) ? (listing.phone ?? '').trim() : '';
  const email = contactEmail(listing.contactEmail);
  const loc = project.location;
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': business ? 'LocalBusiness' : 'Organization',
    name: project.brand.name,
    ...(description ? { description } : {}),
    ...(canonical ? { url: canonical } : {}),
    ...(shareImage ? { image: SHARE_IMAGE } : {}),
    ...(business && loc && (loc.city?.trim() || loc.region?.trim()) ? { address: { '@type': 'PostalAddress', ...(loc.city?.trim() ? { addressLocality: loc.city.trim() } : {}), ...(loc.region?.trim() ? { addressRegion: loc.region.trim() } : {}) } } : {}),
    ...(telephone ? { telephone } : {}),
    ...(email ? { email } : {}),
  };
  // as in the text, "{{" is written so it can't be an image token; only the share image keeps its own
  const json = JSON.stringify(ld, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/\{\{/g, '{\\u007b')
    .replace(`"${SHARE_IMAGE}"`, () => JSON.stringify(shareImage).replace(/</g, '\\u003c'));

  const body = fill(h.html).split(LEAD_ACTION).join(attr(o.leadAction));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${text(title)}</title>
${description ? `<meta name="description" content="${text(description)}" />\n` : ''}${keywords.length ? `<meta name="keywords" content="${text(keywords.join(', '))}" />\n` : ''}${canonical ? `<link rel="canonical" href="${attr(canonical)}" />\n` : ''}<meta property="og:type" content="${business ? 'business.business' : 'product'}" />
<meta property="og:title" content="${text(ogTitle)}" />
${ogDescription ? `<meta property="og:description" content="${text(ogDescription)}" />\n` : ''}${canonical ? `<meta property="og:url" content="${attr(canonical)}" />\n` : ''}${shareImage ? `<meta property="og:image" content="${attr(shareImage)}" />\n` : ''}${shareImage && meta?.ogImageAlt.trim() ? `<meta property="og:image:alt" content="${text(meta.ogImageAlt.trim())}" />\n` : ''}<meta name="twitter:card" content="${shareImage ? 'summary_large_image' : 'summary'}" />
<meta name="twitter:title" content="${text(ogTitle)}" />
${ogDescription ? `<meta name="twitter:description" content="${text(ogDescription)}" />\n` : ''}${shareImage ? `<meta name="twitter:image" content="${attr(shareImage)}" />\n` : ''}${LT}script type="application/ld+json">
${json}
${SCRIPT_CLOSE}
<style>
${fill(h.css)}
</style>
</head>
<body>
${body}
</body>
</html>`;
}
