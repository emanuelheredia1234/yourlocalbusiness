// Types for migrate.mjs (plain-text emails ↔ block docs, templates). Hand-written: keep in step with the module.
import type { Block, EmailDoc, ThemeRef } from './blocks.mjs';

export type TemplateId = 'delivery' | 'quick_win' | 'story' | 'offer' | 'newsletter' | 'plain';
export interface EmailTemplate {
  id: TemplateId;
  label: string;
  desc: string;
  themeOverrides?: ThemeRef['overrides'];
  /** blocks with slots: 'subject' (a heading), 'text' (body paragraphs), 'cta' (the button) */
  blocks: (Partial<Block> & { type: Block['type']; slot?: 'subject' | 'text' | 'cta' })[];
}
export interface PlainEmail {
  id?: string;
  subject?: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
}
export const TEMPLATES: readonly EmailTemplate[];
export const TEMPLATE_IDS: readonly TemplateId[];
export function docFromPlain(step: Partial<PlainEmail> & { id?: string }, opts?: { theme?: ThemeRef }): EmailDoc;
export function plainFromDoc(doc: EmailDoc, opts?: { assetLinks?: Record<string, string> }): { body: string; ctaLabel: string; ctaUrl: string };
export function templateFor(purpose: string, index?: number, total?: number): TemplateId;
export function applyTemplate(tpl: TemplateId | EmailTemplate, plain: Partial<PlainEmail>, opts?: { theme?: ThemeRef; seed?: string; offer?: { id: string; title?: string; price?: string } | null }): EmailDoc;
