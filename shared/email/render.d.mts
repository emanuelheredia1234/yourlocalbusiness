// Types for render.mjs (the email renderer). Hand-written: keep in step with the module.
import type { EmailDoc, ThemeRef, ThemeTokens } from './blocks.mjs';

export { escapeHtml, safeHref, safeImageSrc } from './sanitize.mjs';

export type RenderTarget = 'preview' | 'export' | 'omnisend' | 'gmail';
export type EspId = 'omnisend' | 'mailchimp' | 'kit' | 'mailerlite' | 'brevo' | 'other';
export const ESP_TOOLS: Readonly<Record<EspId, { label: string; unsubscribe: string | null }>>;
export const ESP_IDS: readonly EspId[];
export const RENDER_TARGETS: readonly RenderTarget[];
export const OMNISEND_UNSUBSCRIBE: '[[unsubscribe_link]]';

export class RenderError extends Error {
  code: 'NO_UNSUBSCRIBE' | 'NO_OPT_OUT' | 'TOO_LARGE' | 'BAD_TARGET';
  bytes?: number;
  limit?: number;
}

export interface BrandColorsIn {
  primary?: string;
  secondary?: string;
  accent?: string;
  ink?: string;
  paper?: string;
}
export interface RenderContext {
  target: RenderTarget;
  subject?: string;
  preheader?: string;
  brand?: { name?: string; colors?: BrandColorsIn; logoUrl?: string; logoWidth?: number; logoHeight?: number };
  /** merge values: first_name, lead_magnet_link, product_link, sender_name, brand, email */
  values?: Record<string, string>;
  /** 'buy:<id>' → address (or '#buy-preview'), 'asset:<id>' → address */
  links?: Record<string, string>;
  /** export only: which email tool's unsubscribe tag */
  esp?: EspId;
  /** gmail only (P10) */
  optOutUrl?: string;
  postalAddress?: string;
  footerNote?: string;
  /** https origin serving /email-icons/<platform>.png */
  iconBase?: string;
  /** which https images custom HTML may keep (the server: the caller's public-files folder) */
  imageAllowed?: (src: string) => boolean;
}
/**
 * Warning codes: CONTRAST_TEXT, CONTRAST_BUTTON, GMAIL_CLIP, INVALID_DOC, UNKNOWN_TAG:<name>, MISSING_VALUE:<name>,
 * UNKNOWN_BUY_LINK:<id>, UNKNOWN_ASSET_LINK:<id>, NO_LINK:magnet|page, BAD_LINK, IMAGE_EMPTY, IMAGE_REFUSED,
 * OFFER_EMPTY, BUTTON_NO_LABEL, SOCIAL_ICONS_TEXT, CUSTOM_TOO_LARGE, NO_UNSUBSCRIBE_TAG, NO_POSTAL_ADDRESS.
 */
export interface RenderResult {
  html: string;
  text: string;
  warnings: string[];
  bytes: number;
}
export type ResolvedTheme = ThemeTokens & { fontStack: string; headingStack: string; link: string };

export function mix(a: string, b: string, t: number): string;
export function luminance(hex: string): number;
export function contrast(a: string, b: string): number;
export function resolveTheme(ref: ThemeRef | undefined, brandColors?: BrandColorsIn): { tokens: ResolvedTheme; warnings: string[] };
export function renderEmail(doc: EmailDoc | unknown, ctx: RenderContext): RenderResult;
export function renderText(doc: EmailDoc | unknown, ctx: RenderContext): string;
export function hasCustomBlocks(doc: EmailDoc): boolean;
