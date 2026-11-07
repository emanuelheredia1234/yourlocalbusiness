// An email as its Omnisend draft request (P5 §A6): the block doc and the merge values the app owns, never HTML
// (the server renders what Omnisend gets, with [[unsubscribe_link]]), and the checks made before the one request:
// a buy link that isn't one of the business's offers, a link with no address yet, an image the app doesn't host.

import type { EmailDoc, EmailStep, Project } from './types';
import { docLinkSources, docLinks, eachBlock } from '../../shared/email/blocks.mjs';
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

/** Where a link with no address is, in the refusal's words. */
const LINK_PLACE: Partial<Record<string, string>> = { button: 'This email’s button', image: 'This email’s linked image', video: 'This email’s video link', text: 'A link in this email’s text', custom: 'A link in this email’s custom HTML' };

const isWeb = (v: string | undefined) => !!v && /^https?:\/\/[^\s[\]]+$/i.test(v.trim());

/** Why this draft would be refused ('' when it can go): checked here first, so the request is never wasted. */
export function draftProblem(p: Project, d: EmailDraftPayload, o: { offersLoading?: boolean } = {}): string {
  if (unknownBuyIds(d.doc, p).length) return o.offersLoading ? 'This business’s offers are still loading. Try again in a moment.' : 'This buy link isn’t one of this business’s offers. Choose one of its offers for the button, or paste a web address.';
  for (const { link: l, block } of docLinkSources(d.doc)) {
    const what = LINK_PLACE[block] ?? 'A link in this email';
    if (l.kind === 'magnet' && !isWeb(d.values.lead_magnet_link)) return `${what} has no web address yet. ${missingLinkFix(p, '{{lead_magnet_link}}')}`;
    if (l.kind === 'page' && !isWeb(d.values.product_link)) return `${what} has no web address yet. ${missingLinkFix(p, '{{product_link}}')}`;
    if (l.kind === 'asset' && !d.assetLinks[l.assetId]) return 'This email links to an asset that isn’t published yet. Publish it first.';
    if (l.kind === 'url' && !isWeb(l.url) && !/^(mailto|tel):/i.test(l.url)) return `${what} has no web address yet. ${missingLinkFix(p, l.url)}`;
  }
  if (unhostedImages(d.doc).length) return 'Upload this image in the email studio first: images in emails have to be hosted by the app.';
  return '';
}

/** Values in [brackets] the owner fills in at Omnisend before sending. */
export function draftHasPlaceholders(d: EmailDraftPayload): boolean {
  const BRACKETS = /\[[^\]\n]{1,60}\](?!\()/; // [your hours], not a [label](link)
  if (BRACKETS.test(`${d.subject}\n${d.preheader}`)) return true;
  const words: string[] = [];
  eachBlock(d.doc, (b) => {
    if (b.type === 'heading' || b.type === 'text') words.push(b.text);
    else if (b.type === 'button') words.push(b.label);
    else if (b.type === 'custom') words.push(b.html.replace(/<[^>]*>/g, ' '));
    else if (b.type === 'offer') words.push(b.title, b.price, b.blurb ?? '');
  });
  const text = words.join('\n');
  if (BRACKETS.test(text)) return true;
  // a merge tag the email uses whose value is still a placeholder (no subscriber: '[First name]')
  return Object.entries(d.values).some(([name, v]) => BRACKETS.test(v ?? '') && new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(text));
}

/** The server's refusals in the app's words (others keep the server's own). */
export const DRAFT_CODE_TEXT: Record<string, string> = {
  IMAGE_NOT_HOSTED: 'Upload this image in the email studio first: images in emails have to be hosted by the app.',
  UNKNOWN_BUY_LINK: 'This buy link isn’t one of this business’s offers. Choose one of its offers for the button.',
  TOO_LARGE: 'This email is too large for an Omnisend draft. Remove a block or a custom HTML block.',
};
