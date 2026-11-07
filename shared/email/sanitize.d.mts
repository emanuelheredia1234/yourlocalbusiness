// Types for sanitize.mjs (custom HTML and CSS in emails). Hand-written: keep in step with the module.

export class SanitizeError extends Error {
  code: 'TOO_LARGE';
  bytes?: number;
  limit?: number;
}
export const CLASS_PREFIX: string;
export type RemovedKind = 'script' | 'style' | 'iframe' | 'object' | 'hidden' | 'svg' | 'form' | 'media' | 'meta' | 'comment' | 'handler' | 'image' | 'link' | 'css' | 'font' | 'attribute';

export function removedNotes(removed: Partial<Record<RemovedKind, number>>): string[];
export function decodeEntities(s: string): string;
export function escapeHtml(s: string): string;
export function safeHref(value: string, opts?: { mailto?: boolean; fragment?: boolean }): string | null;
export function safeImageSrc(value: string): string | null;
export function filterStyle(css: string, opts?: { allowImportant?: boolean; count?: (kind: RemovedKind) => void }): string;

export interface SanitizeHtmlOptions {
  /** whether an https image may stay (default: any https image); {{img-N}} tokens always stay */
  imageAllowed?: (src: string) => boolean;
  /** default 20 KB */
  maxBytes?: number;
  /** also return the <style> elements' CSS */
  collectStyles?: boolean;
}
export function sanitizeEmailHtml(html: string, opts?: SanitizeHtmlOptions): { html: string; notes: string[]; removed: Partial<Record<RemovedKind, number>>; styles?: string };
export function sanitizeEmailCss(css: string, opts?: { scope?: string; maxBytes?: number }): { css: string; notes: string[] };
