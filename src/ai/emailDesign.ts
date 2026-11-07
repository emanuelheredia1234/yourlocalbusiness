// The email studio's AI (P5 §A5): what "Design this email", "Make it bolder" and the assistant's block edits may
// change, checked before anything is kept. The AI never adds custom HTML, real pictures (an image comes back as a
// picture idea the owner generates on purpose), video, social links, or a link the email didn't have: only the
// email's own download, page, offers and addresses. Without AI the same buttons work from templates.

import type { Block, ColumnChild, EmailDoc, Link, ThemeRef, ThemeTokens } from '../../shared/email/blocks.mjs';
import { linkFromTarget, normalizeDoc, normalizeThemeRef, parseInline } from '../../shared/email/blocks.mjs';
import { applyTemplate, templateFor } from '../../shared/email/migrate.mjs';
import { resolveTheme } from '../../shared/email/render.mjs';

/** What the design task knows about the email and the business. */
export interface EmailDesignInput {
  stepId: string;
  purpose: string;
  index: number;
  total: number;
  subject: string;
  preview: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  theme: ThemeRef;
  offers: { id: string; title: string; price: string }[];
  hasMagnet: boolean;
  hasPage: boolean;
}

/** The links the email may use: its download and page when they exist, its offers, and the addresses it already had. */
export interface AllowedLinks {
  magnet: boolean;
  page: boolean;
  offers: Set<string>;
  urls: Set<string>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const URL_IN_TEXT = /https?:\/\/[^\s)<>"]+/g;

export function allowedFrom(i: Pick<EmailDesignInput, 'body' | 'ctaUrl' | 'offers' | 'hasMagnet' | 'hasPage'>): AllowedLinks {
  const urls = new Set<string>([...(i.body.match(URL_IN_TEXT) ?? []), ...(/^https?:\/\//.test(i.ctaUrl.trim()) ? [i.ctaUrl.trim()] : [])]);
  return { magnet: i.hasMagnet, page: i.hasPage, offers: new Set(i.offers.map((o) => o.id)), urls };
}

/** A link the email may make, or null. */
export function allowedLink(l: Link | null | undefined, a: AllowedLinks): Link | null {
  if (!l) return null;
  if (l.kind === 'magnet') return a.magnet ? l : null;
  if (l.kind === 'page') return a.page ? l : null;
  if (l.kind === 'offer') return a.offers.has(l.offerId) ? l : null;
  if (l.kind === 'url') return a.urls.has(l.url.trim()) ? { kind: 'url', url: l.url.trim() } : null;
  return null;
}

/** Text links ([label](target)) to anything not allowed lose their link (the label stays). */
function cleanTextLinks(text: string, a: AllowedLinks): string {
  return text.replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,2048})\)/g, (whole, label: string, target: string) => (allowedLink(linkFromTarget(target), a) ? whole : label));
}

/** {{buy:<id>}} in text to an offer that isn't the business's: taken out. */
const cleanBuyTags = (text: string, a: AllowedLinks) => text.replace(/\{\{\s*buy:([A-Za-z0-9_-]{22})\s*\}\}/g, (whole, id: string) => (a.offers.has(id) ? whole : ''));

function cleanBlock(b: Block, a: AllowedLinks, offers: EmailDesignInput['offers']): Block | null {
  switch (b.type) {
    case 'heading':
      return { ...b, text: cleanBuyTags(b.text, a).replace(URL_IN_TEXT, (u) => (a.urls.has(u) ? u : '')) };
    case 'text':
      return { ...b, text: cleanBuyTags(cleanTextLinks(b.text, a), a).replace(URL_IN_TEXT, (u) => (a.urls.has(u) ? u : '')), plain: undefined };
    case 'image': {
      // a picture idea: the owner generates it on purpose (no credits spent without asking)
      const link = allowedLink(b.link, a);
      return { id: b.id, type: 'image', src: '', alt: b.alt, width: b.width, origin: 'ai', ...(b.prompt || b.alt ? { prompt: b.prompt || b.alt } : {}), ...(link ? { link } : {}), ...(b.pad ? { pad: b.pad } : {}), ...(b.align ? { align: b.align } : {}) };
    }
    case 'button': {
      const link = allowedLink(b.link, a);
      return link && b.label.trim() ? { ...b, link } : null;
    }
    case 'offer': {
      const o = offers.find((x) => x.id === b.offerId);
      if (!o) return null;
      const { image: _image, ...rest } = b;
      return { ...rest, title: o.title, price: o.price, blurb: b.blurb ? cleanBuyTags(b.blurb, a) : undefined };
    }
    case 'columns': {
      const cols = b.cols.map((c) => ({ blocks: c.blocks.map((x) => cleanBlock(x, a, offers)).filter((x): x is ColumnChild => !!x) })) as typeof b.cols;
      return cols[0].blocks.length || cols[1].blocks.length ? { ...b, cols } : null;
    }
    case 'divider':
      return b;
    // no custom HTML, video or social links from the AI
    default:
      return null;
  }
}

/** The words a doc says (headings and text, markup out), for checking it kept the email's message. */
export function docWords(doc: EmailDoc): string {
  const out: string[] = [];
  const add = (b: Block) => {
    if (b.type === 'heading' || b.type === 'text')
      out.push(
        parseInline(b.text)
          .map((n) => (n.t === 'text' ? n.v : n.t === 'link' ? n.label : ''))
          .join(''),
      );
    if (b.type === 'columns') for (const c of b.cols) c.blocks.forEach(add);
  };
  doc.blocks.forEach(add);
  return out.join(' ');
}

/**
 * The AI's design, checked: a valid doc with no custom HTML, pictures as ideas only, links only to what the email
 * may link to, offers refreshed from the business's own. null when nothing usable came back (the caller keeps the
 * template design).
 */
export function validateDesign(raw: unknown, i: EmailDesignInput, a: AllowedLinks = allowedFrom(i)): EmailDoc | null {
  const obj = isRecord(raw) && isRecord(raw.doc) ? raw.doc : raw;
  if (!isRecord(obj) || !Array.isArray(obj.blocks)) return null;
  const { doc, problems } = normalizeDoc({ v: 1, theme: obj.theme ?? i.theme, blocks: obj.blocks });
  if (problems.some((p) => p.path === '')) return null;
  const blocks = doc.blocks.map((b) => cleanBlock(b, a, i.offers)).filter((b): b is Block => !!b);
  const out: EmailDoc = { v: 1, theme: normalizeThemeRef(doc.theme), blocks };
  // the email's message must still be there: some words, and not cut to a fraction of the original
  const words = docWords(out).replace(/\s+/g, ' ').trim();
  if (!words || words.length < Math.min(40, i.body.trim().length * 0.4)) return null;
  return normalizeDoc(out).doc;
}

/** Without AI: the template that suits the email's purpose, with its words. */
export function localDesign(i: EmailDesignInput): EmailDoc {
  return applyTemplate(templateFor(i.purpose, i.index, i.total), { id: i.stepId, subject: i.subject, body: i.body, ctaLabel: i.ctaLabel, ctaUrl: i.ctaUrl }, { theme: i.theme, seed: i.stepId, offer: i.offers[0] ?? null });
}

// ───────────── Make it bolder ─────────────

/** What "Make it bolder" may change. */
export interface BolderPatch {
  overrides: Partial<ThemeTokens>;
  /** heading and button labels by block id, shorter and more direct */
  labels: Record<string, string>;
}
export const BOLDER_KEYS = ['primary', 'ink', 'bg', 'paper', 'size', 'density', 'headingCase', 'radius'] as const;

/** The patch, checked: only these theme keys, valid values, and labels only for the doc's own headings and buttons, not longer. */
export function validateBolder(raw: unknown, doc: EmailDoc): BolderPatch {
  const r = isRecord(raw) ? raw : {};
  const o = isRecord(r.overrides) ? r.overrides : isRecord(r.theme) ? r.theme : {};
  const picked = Object.fromEntries(Object.entries(o).filter(([k]) => (BOLDER_KEYS as readonly string[]).includes(k)));
  const overrides = normalizeThemeRef({ id: doc.theme.id, overrides: picked }).overrides ?? {};
  const labels: Record<string, string> = {};
  const given = isRecord(r.labels) ? r.labels : {};
  const walk = (b: Block) => {
    if (b.type === 'columns') return b.cols.forEach((c) => c.blocks.forEach(walk));
    const now = b.type === 'heading' ? b.text : b.type === 'button' ? b.label : null;
    const next = given[b.id];
    if (now === null || typeof next !== 'string' || !next.trim()) return;
    const t = next.replace(/\s+/g, ' ').trim();
    // shorter and more direct: never longer, never a new link or tag
    if (t.length <= Math.max(now.length, 12) && !/[{}[\]<>]|https?:/.test(t)) labels[b.id] = t;
  };
  doc.blocks.forEach(walk);
  return { overrides, labels };
}

/** The doc with the patch: theme overrides, new labels, the first heading large, buttons solid and full width. */
export function applyBolder(doc: EmailDoc, patch: BolderPatch): EmailDoc {
  let firstHeading = true;
  const one = (b: Block): Block => {
    if (b.type === 'heading') {
      const level = firstHeading ? 1 : b.level;
      firstHeading = false;
      return { ...b, level, text: patch.labels[b.id] ?? b.text };
    }
    if (b.type === 'button') return { ...b, label: patch.labels[b.id] ?? b.label, style: 'solid', full: true };
    if (b.type === 'columns') return { ...b, cols: b.cols.map((c) => ({ blocks: c.blocks.map((x) => one(x) as ColumnChild) })) as typeof b.cols };
    return b;
  };
  const overrides = { ...(doc.theme.overrides ?? {}), ...patch.overrides };
  return normalizeDoc({ ...doc, theme: { id: doc.theme.id, overrides }, blocks: doc.blocks.map(one) }).doc;
}

/** Without AI: two sizes up, uppercase headings for Latin text, airier spacing. */
export function localBolder(doc: EmailDoc, brandColors?: Record<string, string>): BolderPatch {
  const t = resolveTheme(doc.theme, brandColors).tokens;
  const latin = /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}]*$/u.test(docWords(doc));
  return { overrides: { size: Math.min(18, t.size + 2), density: 'airy', ...(latin ? { headingCase: 'upper' as const } : {}) }, labels: {} };
}

// ───────────── assistant block edits ─────────────

/**
 * An AI edit of a doc (the assistant): checked like a design, except that the doc's own custom HTML blocks stay as
 * they were (matched by id; the AI can move or remove them, never write one), and its own pictures and links stay.
 */
export function validateBlocksEdit(raw: unknown, before: EmailDoc, a: AllowedLinks, offers: EmailDesignInput['offers']): EmailDoc | null {
  const obj = isRecord(raw) && isRecord(raw.doc) ? raw.doc : raw;
  if (!isRecord(obj) || !Array.isArray(obj.blocks)) return null;
  const old = new Map(before.blocks.map((b) => [b.id, b]));
  const { doc, problems } = normalizeDoc({ v: 1, theme: obj.theme ?? before.theme, blocks: obj.blocks });
  if (problems.some((p) => p.path === '')) return null;
  const blocks: Block[] = [];
  for (const b of doc.blocks) {
    const was = old.get(b.id);
    // what the owner made that the AI may not write: kept exactly
    if (was && (was.type === 'custom' || was.type === 'video' || was.type === 'social')) {
      blocks.push(was);
      continue;
    }
    if (was?.type === 'image' && b.type === 'image' && was.src) {
      blocks.push({ ...was, alt: b.alt || was.alt, width: b.width });
      continue;
    }
    // links the doc already had are allowed too
    const extra: AllowedLinks = { ...a, urls: new Set(a.urls) };
    if (was && (was.type === 'button' || was.type === 'image') && was.link?.kind === 'url') extra.urls.add(was.link.url);
    const c = cleanBlock(b, extra, offers);
    if (c) blocks.push(c);
  }
  return normalizeDoc({ v: 1, theme: normalizeThemeRef(doc.theme), blocks }).doc;
}

/** Links a doc already makes, allowed for an edit of it. */
export function allowedForDoc(doc: EmailDoc, base: AllowedLinks): AllowedLinks {
  const a: AllowedLinks = { ...base, offers: new Set(base.offers), urls: new Set(base.urls) };
  const walk = (b: Block) => {
    if (b.type === 'columns') return b.cols.forEach((c) => c.blocks.forEach(walk));
    if ((b.type === 'button' || b.type === 'image') && b.link?.kind === 'url') a.urls.add(b.link.url);
    if (b.type === 'text') for (const m of b.text.matchAll(URL_IN_TEXT)) a.urls.add(m[0]);
  };
  doc.blocks.forEach(walk);
  return a;
}
