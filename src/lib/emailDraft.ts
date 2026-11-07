// An email as its Omnisend draft request (P5 §A6): the block doc and the merge values the app owns, never HTML
// (the server renders what Omnisend gets, with [[unsubscribe_link]]), and the checks made before the one request:
// a buy link that isn't one of the business's offers, a link with no address yet, an image the app doesn't host.

import type { EmailDoc, EmailStep, Project } from './types';
import { docLinks } from '../../shared/email/blocks.mjs';
import { renderTokens } from '@/ai/local/email';
import { emailTokens, missingLinkFix } from '@/pages/marketing/email/shared';
import { docOf, emailBrand, emailValues, footerNoteOf, publishedAssetLinks, unhostedImages, unknownBuyIds } from './emailDoc';

export interface EmailDraftPayload {
  name: string;
  subject: string;
  preheader: string;
  doc: EmailDoc;
  values: Record<string, string>;
  brand: { name: string; colors: Record<string, string> };
  footerNote: string;
  assetLinks: Record<string, string>;
}

/** The request for one email (or version B: its own doc and subject). */
export function emailDraftPayload(p: Project, step: EmailStep, index: number, o: { doc?: EmailDoc; subject?: string; preview?: string } = {}): EmailDraftPayload {
  const tokens = emailTokens(p);
  const doc = o.doc ?? docOf(step, p);
  const published = publishedAssetLinks(p);
  const assetLinks: Record<string, string> = {};
  for (const l of docLinks(doc)) if (l.kind === 'asset' && published[l.assetId]) assetLinks[l.assetId] = published[l.assetId];
  return {
    name: `${p.brand.name} — Email ${index + 1}`,
    subject: renderTokens(o.subject ?? step.subject, tokens),
    preheader: renderTokens(o.preview ?? step.preview, tokens),
    doc,
    values: emailValues(p),
    brand: emailBrand(p),
    footerNote: footerNoteOf(p),
    assetLinks,
  };
}

const isWeb = (v: string | undefined) => !!v && /^https?:\/\/[^\s[\]]+$/i.test(v.trim());

/** Why this draft would be refused ('' when it can go): checked here first, so the request is never wasted. */
export function draftProblem(p: Project, d: EmailDraftPayload, o: { offersLoading?: boolean } = {}): string {
  if (unknownBuyIds(d.doc, p).length) return o.offersLoading ? 'This business’s offers are still loading. Try again in a moment.' : 'This buy link isn’t one of this business’s offers. Choose one of its offers for the button, or paste a web address.';
  for (const l of docLinks(d.doc)) {
    if (l.kind === 'magnet' && !isWeb(d.values.lead_magnet_link)) return `This email’s button has no web address yet. ${missingLinkFix(p, '{{lead_magnet_link}}')}`;
    if (l.kind === 'page' && !isWeb(d.values.product_link)) return `This email’s button has no web address yet. ${missingLinkFix(p, '{{product_link}}')}`;
    if (l.kind === 'asset' && !d.assetLinks[l.assetId]) return 'This email links to an asset that isn’t published yet. Publish it first.';
    if (l.kind === 'url' && !isWeb(l.url) && !/^(mailto|tel):/i.test(l.url)) return `This email’s button has no web address yet. ${missingLinkFix(p, l.url)}`;
  }
  if (unhostedImages(d.doc).length) return 'Upload this image in the email studio first: images in emails have to be hosted by the app.';
  return '';
}

/** Values in [brackets] the owner fills in at Omnisend before sending. */
export const draftHasPlaceholders = (d: EmailDraftPayload) => /\[[^\]\n]{1,60}\]/.test([d.subject, d.preheader, d.values.first_name ?? ''].join('\n')) || JSON.stringify(d.doc).includes('{{first_name}}');

/** The server's refusals in the app's words (others keep the server's own). */
export const DRAFT_CODE_TEXT: Record<string, string> = {
  IMAGE_NOT_HOSTED: 'Upload this image in the email studio first: images in emails have to be hosted by the app.',
  UNKNOWN_BUY_LINK: 'This buy link isn’t one of this business’s offers. Choose one of its offers for the button.',
  TOO_LARGE: 'This email is too large for an Omnisend draft. Remove a block or a custom HTML block.',
};
