// The email studio's glue (P5): an email step's block doc (made on the fly from its plain words until the owner
// edits blocks or applies a design), writing a doc back with the plain fields derived from it, and the render
// context the preview, the exports and the Omnisend draft use. The renderer itself is shared with the server
// (shared/email/render.mjs), so the preview shows what Omnisend gets.

import { create } from 'zustand';
import type { EmailStep, Project } from './types';
import { docImageSrcs, docBuyIds, eachBlock, normalizeDoc, MERGE_TAGS, type Block, type EmailDoc, type TextBlock, type ThemeRef } from '../../shared/email/blocks.mjs';
import { variantOpening } from './experiments/variants';
import { docFromPlain, plainFromDoc } from '../../shared/email/migrate.mjs';
import { renderEmail, renderText, type EspId, type RenderContext, type RenderResult, type RenderTarget } from '../../shared/email/render.mjs';
import { emailTokens, signedUpAt } from '@/pages/marketing/email/shared';
import { buyLinksOf } from '@/store/offers';
import { useStore } from '@/store/useStore';

export type { EmailDoc, ThemeRef };

/** The published app's address: the email icons are served there (/email-icons/…). */
export const EMAIL_ICON_BASE = 'https://yourlocalbusiness.replit.app';
/** Where a buy link goes in a preview: nowhere (a preview never opens a checkout). */
export const BUY_PREVIEW = '#buy-preview';

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** A new block id: 'b_' + 10 url-safe characters. */
export function newBlockId(): string {
  const bytes = new Uint8Array(10);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `b_${[...bytes].map((b) => ID_CHARS[b & 63]).join('')}`;
}

/** The theme new designs start from: the project's default, else the brand theme. */
export const themeOf = (p: Project): ThemeRef => p.marketing.emailTheme ?? { id: 'brand' };

/** The email's doc: its own, or one made from its plain words now (nothing is written). */
export function docOf(step: EmailStep, p: Project): EmailDoc {
  return step.doc ?? docFromPlain(step, { theme: themeOf(p) });
}

/** The published Code & assets pages, by asset id → their address (an unpublished asset has none). */
export function publishedAssetLinks(p: Project): Record<string, string> {
  return Object.fromEntries(p.studio.codeAssets.filter((a) => a.published?.url).map((a) => [a.id, a.published!.url]));
}

/** The plain fields a doc stands for (body, button label and link), for exports, A/B openings and older tabs. */
export const plainOf = (doc: EmailDoc, p: Project) => plainFromDoc(doc, { assetLinks: publishedAssetLinks(p) });

const projectById = (id: string) => useStore.getState().projects.find((x) => x.id === id);

/**
 * Write an email's doc (normalized), and the plain fields derived from it, in one change. The doc is kept even when
 * it has problems (an image still without its description): the studio shows them, and the server refuses a draft.
 */
export function setDoc(projectId: string, stepId: string, doc: EmailDoc): void {
  const p = projectById(projectId);
  if (!p) return;
  const clean = normalizeDoc(doc).doc;
  const plain = plainOf(clean, p);
  useStore.getState().updateProject(projectId, (x) => ({
    ...x,
    marketing: { ...x.marketing, emails: x.marketing.emails.map((e) => (e.id === stepId ? { ...e, doc: clean, ...plain } : e)) },
  }));
}

/** The project's default theme, and every designed email's theme ("Use for all emails"). */
export function updateEmailTheme(projectId: string, theme: ThemeRef): void {
  useStore.getState().updateProject(projectId, (x) => ({
    ...x,
    marketing: { ...x.marketing, emailTheme: theme, emails: x.marketing.emails.map((e) => (e.doc ? { ...e, doc: { ...e.doc, theme } } : e)) },
  }));
}

/** The email back to its plain words only (the doc is dropped; body, button and link stay as they were derived). */
export function dropDoc(projectId: string, stepId: string): void {
  useStore.getState().updateProject(projectId, (x) => ({
    ...x,
    marketing: { ...x.marketing, emails: x.marketing.emails.map((e) => (e.id === stepId ? { ...e, doc: undefined } : e)) },
  }));
}

/** The merge values the app owns (only the tags the renderer knows). */
export function emailValues(p: Project): Record<string, string> {
  const t = emailTokens(p);
  return Object.fromEntries(MERGE_TAGS.filter((k) => typeof t[k] === 'string' && t[k]).map((k) => [k, t[k]]));
}

/** buy:<id> → its link (absolute), or the preview's dead link; asset:<id> → its published address. */
export function renderLinks(p: Project, target: RenderTarget): Record<string, string> {
  const buys = buyLinksOf(p.id);
  const links: Record<string, string> = {};
  for (const [k, v] of Object.entries(buys)) links[k] = target === 'preview' ? BUY_PREVIEW : v;
  for (const [id, url] of Object.entries(publishedAssetLinks(p))) links[`asset:${id}`] = url;
  return links;
}

/** The brand an email shows: its name and colours (#rrggbb only). The header shows the name in text. */
export function emailBrand(p: Project): { name: string; colors: Record<string, string> } {
  const colors = Object.fromEntries(Object.entries(p.brand.colors ?? {}).filter(([, v]) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)).map(([k, v]) => [k, (v as string).toLowerCase()]));
  return { name: p.brand.name, colors };
}

export const footerNoteOf = (p: Project) => `You’re receiving this because you signed up at ${signedUpAt(p)}.`;

/** The render context for one target (export: the email tool whose unsubscribe tag goes in). */
export function renderCtx(p: Project, target: RenderTarget, o: { subject?: string; preheader?: string; esp?: EspId } = {}): RenderContext {
  return {
    target,
    subject: o.subject ?? '',
    preheader: o.preheader ?? '',
    brand: emailBrand(p),
    values: emailValues(p),
    links: renderLinks(p, target),
    footerNote: footerNoteOf(p),
    iconBase: EMAIL_ICON_BASE,
    ...(o.esp ? { esp: o.esp } : {}),
  };
}

/** One email rendered: preview, or export for an email tool. Throws RenderError (TOO_LARGE). */
export function emailHtml(step: EmailStep, p: Project, target: 'preview' | 'export', o: { esp?: EspId; doc?: EmailDoc; subject?: string } = {}): RenderResult {
  const tokens = emailTokens(p);
  const fill = (s: string) => s.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => tokens[k] ?? m);
  return renderEmail(o.doc ?? docOf(step, p), renderCtx(p, target, { subject: fill(o.subject ?? step.subject), preheader: fill(step.preview), esp: o.esp }));
}

/** The email's plain-text part (CSV/.txt export): merge tags stay for the email tool to fill, buy links are filled in. */
export function emailText(step: EmailStep, p: Project, links: Record<string, string> = buyLinksOf(p.id)): string {
  return renderText(docOf(step, p), { target: 'export', values: {}, links: { ...links, ...renderLinks(p, 'export') } });
}

/** Whether an image is one the app hosts (its public-files, or its email icons): the only ones the server takes. */
export const isHostedImage = (src: string) => /^https:\/\/[^/]+\/storage\/v1\/object\/public\/public-files\/[^/]+\/[^/]+$/.test(src) || /^https:\/\/[^/]+\/email-icons\/[a-z]+\.png$/.test(src);

/** Images the server would refuse (not on the app's public-files, nor its email icons). */
export function unhostedImages(doc: EmailDoc): string[] {
  return docImageSrcs(doc).filter((src) => !isHostedImage(src));
}

/** Buy links in a doc that aren't one of the business's offers. */
export function unknownBuyIds(doc: EmailDoc, p: Project): string[] {
  const known = buyLinksOf(p.id);
  return docBuyIds(doc).filter((id) => !known[`buy:${id}`]);
}

/** Whether the doc is still a migrated plain email: one text block (plain) and at most one button. */
export function isPlainShape(doc: EmailDoc): boolean {
  const types = doc.blocks.map((b) => b.type);
  return types.filter((t) => t === 'text').length <= 1 && types.filter((t) => t === 'button').length <= 1 && types.every((t) => t === 'text' || t === 'button');
}

/** Each block's id (columns' children too), for checks. */
export function blockIds(doc: EmailDoc): string[] {
  const ids: string[] = [];
  eachBlock(doc, (b) => ids.push(b.id));
  return ids;
}

/**
 * Version B's doc for an A/B test: A's doc with its first text block's first paragraph swapped for B's opening
 * (changed 'opening'); a subject test keeps A's doc as it is (the subject isn't in the doc).
 */
export function variantDoc(step: EmailStep, p: Project): EmailDoc | undefined {
  const v = step.variants;
  if (!v || !step.doc) return undefined;
  const doc = structuredClone(step.doc) as EmailDoc;
  if (v.changed !== 'opening') return doc;
  // B's opening sits where A's is in the body (after the headings' words), and replaces the first text block's first paragraph
  const opening = variantOpening(step, v.b.body).trim();
  let first: Block | null = null;
  eachBlock(doc, (b) => {
    if (!first && b.type === 'text' && b.text.trim()) first = b;
  });
  const text = first as TextBlock | null;
  if (text && opening) {
    const rest = text.text.replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/).slice(1);
    text.text = [opening, ...rest].join('\n\n');
  }
  void p;
  return doc;
}

// ───────────── undo (per email, in memory) ─────────────

/** The doc each email had before the latest replacing change (a design, a template, Make it bolder, an import). */
export const useEmailUndo = create<Record<string, EmailDoc | null>>(() => ({}));

/** Keep the email's current doc (or null: it had none) for Undo, then write the new one. */
export function replaceDoc(projectId: string, stepId: string, doc: EmailDoc): void {
  const step = projectById(projectId)?.marketing.emails.find((e) => e.id === stepId);
  if (!step) return;
  useEmailUndo.setState({ [stepId]: step.doc ? structuredClone(step.doc) : null });
  setDoc(projectId, stepId, doc);
}

/** Put the kept doc back (or none: the plain email). False when there's nothing to undo. */
export function undoDoc(projectId: string, stepId: string): boolean {
  const s = useEmailUndo.getState();
  if (!(stepId in s)) return false;
  const before = s[stepId];
  const { [stepId]: _gone, ...rest } = s;
  useEmailUndo.setState(rest, true);
  if (before) setDoc(projectId, stepId, before);
  else dropDoc(projectId, stepId);
  return true;
}
