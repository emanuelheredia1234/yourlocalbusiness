// Types for blocks.mjs (the email studio's block model). Hand-written: keep in step with the module.

export type ThemeId = 'brand' | 'clean' | 'bold' | 'warm' | 'minimal' | 'editorial';
export type FontId = 'system' | 'arial' | 'georgia' | 'verdana' | 'trebuchet' | 'tahoma';
export type SocialPlatform = 'facebook' | 'instagram' | 'tiktok' | 'linkedin' | 'x' | 'youtube' | 'pinterest' | 'threads';
export type MergeTag = 'first_name' | 'lead_magnet_link' | 'product_link' | 'sender_name' | 'brand' | 'email';

export interface ThemeTokens {
  bg: string;
  paper: string;
  ink: string;
  muted: string;
  primary: string;
  primaryText: string;
  accent: string;
  rule: string;
  font: FontId;
  headingFont: FontId;
  /** base text size in px, 14–18 */
  size: number;
  /** 0–24 */
  radius: number;
  /** 560–640 */
  width: number;
  density: 'airy' | 'regular' | 'tight';
  headingCase: 'normal' | 'upper';
  headerLogo: boolean;
}
export interface ThemeRef {
  id: ThemeId;
  overrides?: Partial<ThemeTokens>;
}
export interface ThemeDef {
  id: ThemeId;
  label: string;
  /** the brand colours this theme takes */
  from: ('primary' | 'accent' | 'ink' | 'paper')[];
  tokens: Partial<ThemeTokens>;
}

export type Link =
  | { kind: 'magnet' }
  | { kind: 'page' }
  | { kind: 'asset'; assetId: string }
  | { kind: 'offer'; offerId: string }
  | { kind: 'url'; url: string };

interface BlockBase {
  /** 'b_' + 10 url-safe characters */
  id: string;
  pad?: 'none' | 's' | 'm' | 'l';
  align?: 'left' | 'center';
}
export interface HeadingBlock extends BlockBase {
  type: 'heading';
  text: string;
  level: 1 | 2 | 3;
}
export interface TextBlock extends BlockBase {
  type: 'text';
  /** light markup (**bold**, *italic*, [label](link), "- " lists) unless plain */
  text: string;
  /** words kept exactly as written (a migrated plain-text email): no markup is read */
  plain?: boolean;
}
export interface ImageBlock extends BlockBase {
  type: 'image';
  /** https; '' while it's a placeholder */
  src: string;
  alt: string;
  width: number | 'full';
  link?: Link;
  origin: 'upload' | 'ai' | 'url' | 'agent';
  w?: number;
  h?: number;
  /** an AI-designed placeholder's picture idea ("Generate this image") */
  prompt?: string;
}
export interface ButtonBlock extends BlockBase {
  type: 'button';
  label: string;
  link: Link;
  style: 'solid' | 'outline';
  full?: boolean;
}
export type ColumnChild = HeadingBlock | TextBlock | ImageBlock | ButtonBlock;
export interface ColumnsBlock extends BlockBase {
  type: 'columns';
  cols: [{ blocks: ColumnChild[] }, { blocks: ColumnChild[] }];
  ratio: '50/50' | '33/67' | '67/33';
  stack: boolean;
}
export interface OfferBlock extends BlockBase {
  type: 'offer';
  /** 22 characters; '' while it's a placeholder */
  offerId: string;
  title: string;
  price: string;
  blurb?: string;
  image?: { src: string; alt: string };
  buttonLabel: string;
}
export interface VideoBlock extends BlockBase {
  type: 'video';
  thumb: { src: string; alt: string };
  link: { kind: 'url'; url: string };
  caption?: string;
}
export interface SocialBlock extends BlockBase {
  type: 'social';
  links: { platform: SocialPlatform; url: string }[];
  style: 'icons' | 'text';
}
export interface DividerBlock extends BlockBase {
  type: 'divider';
  style: 'line' | 'space';
  /** 8–64 */
  size: number;
}
export interface CustomBlock extends BlockBase {
  type: 'custom';
  html: string;
  /** cleaned, unscoped (the renderer scopes it to the block) */
  css?: string;
  source: 'owner' | 'agent';
  /** what the sanitizer removed, for the owner */
  notes?: string[];
}
export type Block = HeadingBlock | TextBlock | ImageBlock | ButtonBlock | ColumnsBlock | OfferBlock | VideoBlock | SocialBlock | DividerBlock | CustomBlock;
export type BlockType = Block['type'];

export interface EmailDoc {
  v: 1;
  theme: ThemeRef;
  blocks: Block[];
}
export interface DocProblem {
  path: string;
  /** in plain words, for the owner */
  message: string;
}

export const EMAIL_LIMITS: Readonly<{
  blocks: number;
  docBytes: number;
  columnBlocks: number;
  heading: number;
  text: number;
  plainText: number;
  alt: number;
  label: number;
  url: number;
  title: number;
  price: number;
  blurb: number;
  caption: number;
  prompt: number;
  socialLinks: number;
  imageWidth: number;
  customHtmlBytes: number;
  customCssBytes: number;
  notes: number;
  note: number;
  warnBytes: number;
  htmlBytes: number;
}>;
export const BLOCK_TYPES: readonly BlockType[];
export const COLUMN_TYPES: readonly ColumnChild['type'][];
export const MERGE_TAGS: readonly MergeTag[];
export const LINK_TAGS: readonly MergeTag[];
export const SOCIAL_PLATFORMS: readonly SocialPlatform[];
export const SOCIAL_LABELS: Readonly<Record<SocialPlatform, string>>;
export const LINK_KINDS: readonly Link['kind'][];
export const IMAGE_ORIGINS: readonly ImageBlock['origin'][];
export const OFFER_ID_RE: RegExp;
export const BLOCK_ID_RE: RegExp;
export const ASSET_ID_RE: RegExp;
export const TAG_RE: RegExp;
export const BUY_TAG_RE: RegExp;
export const HEX_RE: RegExp;
export const FONTS: Readonly<Record<FontId, { label: string; stack: string }>>;
export const THEMES: readonly ThemeDef[];
export const THEME_IDS: readonly ThemeId[];
export const BRAND_DEFAULTS: Readonly<{ primary: string; accent: string; ink: string; paper: string }>;

export function charCount(s: string): number;
export function byteLength(s: string): number;
export function normalizeLink(raw: unknown, add?: (message: string) => void, where?: string): Link | null;
export function linkFromTarget(target: string): Link;
export function linkToken(link: Link | undefined | null, assetLinks?: Record<string, string>): string;

export type InlineNode = { t: 'text'; v: string } | { t: 'b' | 'i'; children: InlineNode[] } | { t: 'link'; label: string; target: string };
export function parseInline(s: string): InlineNode[];
export function parseParagraphs(text: string, plain?: boolean): ({ kind: 'p'; lines: string[] } | { kind: 'ul'; items: string[] })[];

export function eachBlock(doc: EmailDoc, fn: (block: Block, parent: ColumnsBlock | null) => void): void;
export function docLinkSources(doc: EmailDoc): { link: Link; block: Block['type'] }[];
export function docLinks(doc: EmailDoc): Link[];
export function docBuyIds(doc: EmailDoc): string[];
export function docImageSrcs(doc: EmailDoc): string[];
export function normalizeThemeRef(raw: unknown, add?: (message: string) => void): ThemeRef;
export function blockIdFrom(seed: string): string;
export function emptyDoc(theme?: ThemeRef): EmailDoc;
export function normalizeDoc(raw: unknown): { doc: EmailDoc; problems: DocProblem[] };
