// Plain-text emails and block docs (P5 §1.3): an email step written before the studio has no doc; docFromPlain
// makes one on the fly (nothing is written until the owner edits blocks), and plainFromDoc keeps the old fields
// (body, ctaLabel, ctaUrl) derived from a doc, so CSV/.txt exports, A/B openings, the assistant and older tabs keep
// working. plain → doc → plain is the identity for every step shape. Templates fill a layout with an email's words.

import { blockIdFrom, eachBlock, linkFromTarget, linkToken, normalizeDoc, parseInline, parseParagraphs } from './blocks.mjs';
import TEMPLATES_JSON from './templates.json' with { type: 'json' };

export const TEMPLATES = TEMPLATES_JSON.templates;
export const TEMPLATE_IDS = Object.freeze(TEMPLATES.map((t) => t.id));

const str = (v) => (typeof v === 'string' ? v : '');

/**
 * A step's plain words as a doc: one text block holding the body exactly (plain: no markup read into it), and a
 * button from ctaLabel/ctaUrl when either is set ({{lead_magnet_link}} → magnet, {{product_link}} → page,
 * {{buy:<id>}} → offer, anything else → a url link holding it as written). Block ids come from the step's id.
 */
export function docFromPlain(step, { theme = { id: 'brand' } } = {}) {
  const seed = str(step?.id) || 'step';
  const blocks = [{ id: blockIdFrom(`${seed}:text`), type: 'text', plain: true, text: str(step?.body) }];
  const label = str(step?.ctaLabel);
  const url = str(step?.ctaUrl);
  if (label || url) blocks.push({ id: blockIdFrom(`${seed}:button`), type: 'button', label, link: linkFromTarget(url) });
  return { v: 1, theme, blocks };
}

/** A text block's words without markup: links as "label (address)". */
function plainOf(text) {
  const walk = (nodes) =>
    nodes
      .map((n) => {
        if (n.t === 'text') return n.v;
        if (n.t === 'link') return `${n.label} (${n.target})`;
        return walk(n.children);
      })
      .join('');
  return parseParagraphs(text, false)
    .map((p) => (p.kind === 'ul' ? p.items.map((it) => `- ${walk(parseInline(it))}`).join('\n') : p.lines.map((l) => walk(parseInline(l))).join('\n')))
    .join('\n\n');
}

/**
 * The old fields from a doc: body = the headings' and text blocks' words joined by blank lines (a plain block's
 * exactly as written), ctaLabel/ctaUrl = the first button's label and its link as text (assetLinks: id → address
 * for asset links, '' otherwise).
 */
export function plainFromDoc(doc, { assetLinks = {} } = {}) {
  const parts = [];
  let button = null;
  eachBlock(doc, (b) => {
    if (!b || typeof b !== 'object') return;
    if (b.type === 'heading' && str(b.text)) parts.push(str(b.text));
    if (b.type === 'text') {
      const t = b.plain ? str(b.text) : plainOf(str(b.text));
      if (t) parts.push(t);
    }
    if (b.type === 'button' && !button) button = b;
  });
  return { body: parts.join('\n\n'), ctaLabel: button ? str(button.label) : '', ctaUrl: button ? linkToken(button.link, assetLinks) : '' };
}

/** The template that suits a sequence email: by its purpose's words, else its place (first: delivery, last: offer). */
export function templateFor(purpose, index = 0, total = 5) {
  const p = str(purpose).toLowerCase();
  if (/deliver|freebie|welcome|download/.test(p)) return 'delivery';
  if (/pitch|offer|sale|buy|invitation/.test(p)) return 'offer';
  if (/myth|story|example|objection/.test(p)) return 'story';
  if (/insight|quick win|tip|value/.test(p)) return 'quick_win';
  if (/newsletter|update|news/.test(p)) return 'newsletter';
  if (index === 1) return 'delivery';
  if (index >= total && total > 1) return 'offer';
  return 'quick_win';
}

/**
 * A template filled with an email's words: the subject in the heading, the body's paragraphs spread over the text
 * slots in order (empty slots dropped), the CTA on the button (no CTA: no button). opts: { theme, seed, offer:
 * { id, title, price } }. → a normalized EmailDoc.
 */
export function applyTemplate(tplOrId, plain, { theme = { id: 'brand' }, seed = 'tpl', offer = null } = {}) {
  const tpl = typeof tplOrId === 'string' ? TEMPLATES.find((t) => t.id === tplOrId) : tplOrId;
  if (!tpl) throw new Error(`Unknown email template: ${String(tplOrId)}`);
  const paragraphs = str(plain?.body)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const slots = [];
  const countSlots = (list) => {
    for (const b of list) {
      if (b.type === 'text' && b.slot === 'text') slots.push(b);
      if (b.type === 'columns') for (const c of b.cols) countSlots(c.blocks);
    }
  };
  countSlots(tpl.blocks);
  // the first slots take the extra paragraphs
  const share = slots.map((_, i) => Math.floor(paragraphs.length / slots.length) + (i < paragraphs.length % slots.length ? 1 : 0));
  const texts = [];
  let at = 0;
  for (const n of share) {
    texts.push(paragraphs.slice(at, at + n).join('\n\n'));
    at += n;
  }
  let slot = 0;
  let n = 0;
  const fill = (list) => {
    const out = [];
    for (const raw of list) {
      const b = structuredClone(raw);
      const slotName = b.slot;
      delete b.slot;
      b.id = blockIdFrom(`${seed}:${tpl.id}:${n++}`);
      if (slotName === 'subject') {
        b.text = str(plain?.subject);
        if (!b.text.trim()) continue;
      } else if (slotName === 'text') {
        b.text = texts[slot++] ?? '';
        b.plain = true;
        if (!b.text.trim()) continue;
      } else if (slotName === 'cta') {
        const label = str(plain?.ctaLabel);
        const url = str(plain?.ctaUrl);
        if (!label && !url) continue;
        if (label) b.label = label;
        if (url) b.link = linkFromTarget(url);
      }
      if (b.type === 'offer' && offer?.id) Object.assign(b, { offerId: offer.id, title: str(offer.title), price: str(offer.price) });
      if (b.type === 'columns') {
        b.cols = b.cols.map((c) => ({ blocks: fill(c.blocks) }));
        if (b.cols.every((c) => !c.blocks.length)) continue;
      }
      out.push(b);
    }
    return out;
  };
  const blocks = fill(tpl.blocks);
  const overrides = { ...(theme?.overrides ?? {}), ...(tpl.themeOverrides ?? {}) };
  const ref = Object.keys(overrides).length ? { id: theme?.id ?? 'brand', overrides } : { id: theme?.id ?? 'brand' };
  return normalizeDoc({ v: 1, theme: ref, blocks }).doc;
}
