// The email studio's block model (P5): what an email is made of, its limits, and normalizeDoc(), which turns
// anything a browser, the assistant or an agent import sends into a doc the renderer can trust. Shared by the app
// and the server (plain ESM, no dependencies, no DOM, no I/O). Types: blocks.d.mts.
//
//   EmailDoc = { v: 1, theme: { id, overrides? }, blocks: Block[] }   ≤ 60 blocks, ≤ 100 KB as JSON
//   Block    = { id: 'b_' + 10 url-safe characters, type, …fields, pad?, align? }
//   Link     = { kind: 'magnet' } | { kind: 'page' } | { kind: 'asset', assetId } | { kind: 'offer', offerId }
//            | { kind: 'url', url }
//
// normalizeDoc never throws. Unknown fields are dropped quietly; anything that would change what the email says
// (an unknown block type, text over a limit, a bad link or image) is a problem, never cut: the server answers the
// first problem as a 400 INVALID_DRAFT.

import THEMES_JSON from './themes.json' with { type: 'json' };

export const EMAIL_LIMITS = Object.freeze({
  blocks: 60,
  docBytes: 100 * 1024,
  columnBlocks: 6,
  heading: 200,
  text: 5000,
  /** a text block migrated from a plain-text email (docFromPlain) keeps the old body limit */
  plainText: 24_000,
  alt: 200,
  label: 60,
  url: 2048,
  title: 200,
  price: 40,
  blurb: 1000,
  caption: 300,
  prompt: 500,
  socialLinks: 8,
  imageWidth: 600,
  customHtmlBytes: 20 * 1024,
  customCssBytes: 8 * 1024,
  notes: 20,
  note: 200,
  /** the rendered email: a warning over warnBytes (Gmail clips at 102 KB), refused over htmlBytes */
  warnBytes: 90 * 1024,
  htmlBytes: 200 * 1024,
});

export const BLOCK_TYPES = Object.freeze(['heading', 'text', 'image', 'button', 'columns', 'offer', 'video', 'social', 'divider', 'custom']);
/** What may sit inside a column (no nesting). */
export const COLUMN_TYPES = Object.freeze(['heading', 'text', 'image', 'button']);
/** The merge tags the renderer fills from ctx.values ({{first_name}} …). */
export const MERGE_TAGS = Object.freeze(['first_name', 'lead_magnet_link', 'product_link', 'sender_name', 'brand', 'email']);
/** Merge tags whose value is a web address (a placeholder like [link to your free download] until there is one). */
export const LINK_TAGS = Object.freeze(['lead_magnet_link', 'product_link']);
export const SOCIAL_PLATFORMS = Object.freeze(['facebook', 'instagram', 'tiktok', 'linkedin', 'x', 'youtube', 'pinterest', 'threads']);
export const SOCIAL_LABELS = Object.freeze({ facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', linkedin: 'LinkedIn', x: 'X', youtube: 'YouTube', pinterest: 'Pinterest', threads: 'Threads' });
export const LINK_KINDS = Object.freeze(['magnet', 'page', 'asset', 'offer', 'url']);
export const IMAGE_ORIGINS = Object.freeze(['upload', 'ai', 'url', 'agent']);

export const OFFER_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const BLOCK_ID_RE = /^b_[A-Za-z0-9_-]{10}$/;
export const ASSET_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
/** A merge tag, a buy link or an agent image token, as written in text: {{ first_name }}, {{buy:<id>}}, {{img-1}}. */
export const TAG_RE = /\{\{\s*([a-z_]{1,40}|buy:[A-Za-z0-9_-]{22}|img-[1-9]\d?)\s*\}\}/g;
export const BUY_TAG_RE = /\{\{\s*buy:([A-Za-z0-9_-]{22})\s*\}\}/g;

export const FONTS = THEMES_JSON.fonts;
export const THEMES = THEMES_JSON.themes;
export const THEME_IDS = Object.freeze(THEMES.map((t) => t.id));
export const BRAND_DEFAULTS = THEMES_JSON.brandDefaults;
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const COLOR_TOKENS = ['bg', 'paper', 'ink', 'muted', 'primary', 'primaryText', 'accent', 'rule'];

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
/** Characters as people count them (code points: an emoji is one). */
export const charCount = (s) => [...s].length;
const encoder = new TextEncoder();
/** UTF-8 bytes. */
export const byteLength = (s) => encoder.encode(String(s)).length;
const fmt = (n) => n.toLocaleString('en-US');

const PADS = ['none', 's', 'm', 'l'];
const ALIGNS = ['left', 'center'];

/** A link as the editor, the assistant or a template writes it; null (with a problem) when it isn't one. */
export function normalizeLink(raw, add = () => {}, where = 'The link') {
  if (!isRecord(raw) || !LINK_KINDS.includes(raw.kind)) {
    add(`${where} isn’t one the app knows.`);
    return null;
  }
  switch (raw.kind) {
    case 'magnet':
    case 'page':
      return { kind: raw.kind };
    case 'asset':
      if (typeof raw.assetId !== 'string' || !ASSET_ID_RE.test(raw.assetId)) return add(`${where} points to an asset that isn’t in this business.`), null;
      return { kind: 'asset', assetId: raw.assetId };
    case 'offer':
      if (typeof raw.offerId !== 'string' || !OFFER_ID_RE.test(raw.offerId)) return add(`${where} points to an offer that isn’t one of this business’s.`), null;
      return { kind: 'offer', offerId: raw.offerId };
    default: {
      const url = str(raw.url).trim();
      if (charCount(url) > EMAIL_LIMITS.url) return add(`${where} is too long: at most ${fmt(EMAIL_LIMITS.url)} characters.`), null;
      // an address that isn't usable yet (empty, a placeholder) is kept: the app flags it, the server refuses it
      return { kind: 'url', url };
    }
  }
}

/** A link written as text (a button's old ctaUrl, a [label](target) in text) → a Link. */
export function linkFromTarget(target) {
  const t = str(target).trim();
  if (/^\{\{\s*lead_magnet_link\s*\}\}$/.test(t)) return { kind: 'magnet' };
  if (/^\{\{\s*product_link\s*\}\}$/.test(t)) return { kind: 'page' };
  const buy = /^\{\{\s*buy:([A-Za-z0-9_-]{22})\s*\}\}$/.exec(t);
  if (buy) return { kind: 'offer', offerId: buy[1] };
  return { kind: 'url', url: t };
}

/** A Link written back as text: the merge-tag form the old fields use ({{lead_magnet_link}}, {{buy:<id>}}, a URL). */
export function linkToken(link, assetLinks = {}) {
  if (!isRecord(link)) return '';
  switch (link.kind) {
    case 'magnet':
      return '{{lead_magnet_link}}';
    case 'page':
      return '{{product_link}}';
    case 'offer':
      return `{{buy:${link.offerId}}}`;
    case 'asset':
      return str(assetLinks[link.assetId]);
    case 'url':
      return str(link.url);
    default:
      return '';
  }
}

// ───────────── light markup in text blocks ─────────────

const INLINE_RE = /\[([^\]\n]{1,200})\]\(([^()\s]{1,2048})\)|\*\*([^*\n](?:[^\n]*?[^*\n])?)\*\*|\*([^*\s\n](?:[^*\n]*?[^*\s\n])?)\*/g;

/**
 * A text block's inline markup: **bold**, *italic* and [label](target) (target: an address or a link tag).
 * → [{ t: 'text', v } | { t: 'b' | 'i', children } | { t: 'link', label, target }]
 */
export function parseInline(s, depth = 0) {
  const out = [];
  let last = 0;
  for (const m of String(s).matchAll(new RegExp(INLINE_RE.source, 'g'))) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: 'link', label: m[1], target: m[2] });
    else if (m[3] !== undefined) out.push({ t: 'b', children: depth < 2 ? parseInline(m[3], depth + 1) : [{ t: 'text', v: m[3] }] });
    else out.push({ t: 'i', children: depth < 2 ? parseInline(m[4], depth + 1) : [{ t: 'text', v: m[4] }] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}

/** A text block's paragraphs: a blank line starts a new one; a paragraph whose lines all start with "- " is a list. */
export function parseParagraphs(text, plain = false) {
  const parts = String(text).split(plain ? /\n{2,}/ : /\n[ \t]*\n/).filter((p) => p.trim() !== '');
  return parts.map((p) => {
    const lines = p.split('\n');
    if (!plain && lines.every((l) => /^\s*- /.test(l))) return { kind: 'ul', items: lines.map((l) => l.replace(/^\s*- /, '')) };
    return { kind: 'p', lines };
  });
}

// ───────────── walking a doc ─────────────

/** Every block, top level first then each column's, in reading order: fn(block, parent | null). */
export function eachBlock(doc, fn) {
  for (const b of Array.isArray(doc?.blocks) ? doc.blocks : []) {
    fn(b, null);
    if (b?.type === 'columns' && Array.isArray(b.cols)) for (const c of b.cols) for (const child of Array.isArray(c?.blocks) ? c.blocks : []) fn(child, b);
  }
}

/** The text in a block that may hold merge tags and buy links. */
function textsOf(b) {
  switch (b.type) {
    case 'heading':
    case 'text':
      return [str(b.text)];
    case 'offer':
      return [str(b.blurb)];
    case 'video':
      return [str(b.caption)];
    case 'custom':
      return [str(b.html)];
    default:
      return [];
  }
}

/** Link tokens a custom block uses as an href (the renderer turns them into the magnet's or page's address). */
const CUSTOM_HREF_TOKEN = /\bhref\s*=\s*["']?\s*\{\{\s*(lead_magnet_link|product_link)\s*\}\}/gi;

/**
 * Every link a doc makes, with the type of block it is in: buttons, linked images, offer cards, videos,
 * [label](target) links in text blocks, and {{lead_magnet_link}} / {{product_link}} hrefs in custom HTML.
 */
export function docLinkSources(doc) {
  const out = [];
  eachBlock(doc, (b) => {
    if (!isRecord(b)) return;
    const add = (link) => out.push({ link, block: b.type });
    if ((b.type === 'button' || b.type === 'image' || b.type === 'video') && isRecord(b.link)) add(b.link);
    if (b.type === 'offer' && b.offerId) add({ kind: 'offer', offerId: b.offerId });
    if (b.type === 'text' && !b.plain) {
      const walk = (nodes) => {
        for (const n of nodes) {
          if (n.t === 'link') add(linkFromTarget(n.target));
          else if (n.children) walk(n.children);
        }
      };
      walk(parseInline(str(b.text)));
    }
    if (b.type === 'custom') for (const m of str(b.html).matchAll(CUSTOM_HREF_TOKEN)) add({ kind: m[1].toLowerCase() === 'lead_magnet_link' ? 'magnet' : 'page' });
  });
  return out;
}

/** Every link a doc makes (see docLinkSources). */
export function docLinks(doc) {
  return docLinkSources(doc).map((x) => x.link);
}

/** The offers a doc links to (buy links), each once. */
export function docBuyIds(doc) {
  const ids = new Set();
  for (const l of docLinks(doc)) if (l.kind === 'offer' && l.offerId) ids.add(l.offerId);
  eachBlock(doc, (b) => {
    if (!isRecord(b)) return;
    for (const t of textsOf(b)) for (const m of t.matchAll(new RegExp(BUY_TAG_RE.source, 'g'))) ids.add(m[1]);
  });
  return [...ids];
}

/** Every image address a doc shows (image blocks, offer cards' pictures, video thumbnails), non-empty, each once. */
export function docImageSrcs(doc) {
  const out = new Set();
  eachBlock(doc, (b) => {
    if (!isRecord(b)) return;
    if (b.type === 'image' && b.src) out.add(b.src);
    if (b.type === 'offer' && b.image?.src) out.add(b.image.src);
    if (b.type === 'video' && b.thumb?.src) out.add(b.thumb.src);
  });
  return [...out];
}

// ───────────── normalizing ─────────────

const TYPE_WORDS = { heading: 'heading', text: 'text', image: 'image', button: 'button', columns: 'columns', offer: 'offer card', video: 'video', social: 'social links', divider: 'divider', custom: 'custom HTML' };

/** A theme reference: a known theme and only the overrides it may take. */
export function normalizeThemeRef(raw, add = () => {}) {
  if (raw === undefined || raw === null) return { id: 'brand' };
  if (!isRecord(raw)) return add('The email’s theme isn’t one the app knows.'), { id: 'brand' };
  const id = THEME_IDS.includes(raw.id) ? raw.id : null;
  if (!id) add('The email’s theme isn’t one the app knows.');
  const overrides = {};
  if (raw.overrides !== undefined) {
    const o = isRecord(raw.overrides) ? raw.overrides : {};
    if (!isRecord(raw.overrides)) add('The theme’s settings aren’t valid.');
    for (const [k, v] of Object.entries(o)) {
      let ok = true;
      if (COLOR_TOKENS.includes(k)) ok = typeof v === 'string' && HEX_RE.test(v);
      else if (k === 'font' || k === 'headingFont') ok = typeof v === 'string' && Object.hasOwn(FONTS, v);
      else if (k === 'size') ok = Number.isInteger(v) && v >= 14 && v <= 18;
      else if (k === 'radius') ok = Number.isInteger(v) && v >= 0 && v <= 24;
      else if (k === 'width') ok = Number.isInteger(v) && v >= 560 && v <= 640;
      else if (k === 'density') ok = ['airy', 'regular', 'tight'].includes(v);
      else if (k === 'headingCase') ok = ['normal', 'upper'].includes(v);
      else if (k === 'headerLogo') ok = typeof v === 'boolean';
      else continue; // unknown keys are dropped
      if (!ok) {
        add(`The theme setting “${k}” isn’t valid.`);
        continue;
      }
      overrides[k] = COLOR_TOKENS.includes(k) ? v.toLowerCase() : v;
    }
  }
  return Object.keys(overrides).length ? { id: id ?? 'brand', overrides } : { id: id ?? 'brand' };
}

function imageRef(raw, add, where) {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) return add(`${where} isn’t valid.`), null;
  const src = str(raw.src).trim();
  const alt = str(raw.alt);
  if (src && !/^https:\/\//i.test(src)) add(`${where} must be an https address.`);
  if (charCount(src) > EMAIL_LIMITS.url) add(`${where}’s address is too long.`);
  if (charCount(alt) > EMAIL_LIMITS.alt) add(`${where}’s description is too long: at most ${EMAIL_LIMITS.alt} characters.`);
  return { src, alt };
}

function limitText(value, max, add, where) {
  const s = str(value);
  const n = charCount(s);
  if (n > max) add(`${where} is too long: ${fmt(n)} characters, and at most ${fmt(max)} fit.`);
  return s;
}

/** One block (inColumn: only the column types). null when its type is unknown. */
function normalizeBlock(raw, add, where, inColumn) {
  if (!isRecord(raw) || !BLOCK_TYPES.includes(raw.type)) {
    add(`${where} isn’t a kind of block the app knows.`);
    return null;
  }
  const type = raw.type;
  if (inColumn && !COLUMN_TYPES.includes(type)) {
    add(`${where} (${TYPE_WORDS[type]}) can’t go inside a column.`);
    return null;
  }
  const w = `${where} (${TYPE_WORDS[type]})`;
  const b = { id: typeof raw.id === 'string' && BLOCK_ID_RE.test(raw.id) ? raw.id : '', type };
  if (PADS.includes(raw.pad)) b.pad = raw.pad;
  if (ALIGNS.includes(raw.align)) b.align = raw.align;
  switch (type) {
    case 'heading':
      b.text = limitText(raw.text, EMAIL_LIMITS.heading, add, w);
      b.level = [1, 2, 3].includes(raw.level) ? raw.level : 2;
      break;
    case 'text':
      if (raw.plain === true) b.plain = true;
      b.text = limitText(raw.text, b.plain ? EMAIL_LIMITS.plainText : EMAIL_LIMITS.text, add, w);
      break;
    case 'image': {
      b.src = str(raw.src).trim();
      if (b.src && !/^https:\/\//i.test(b.src)) add(`${w} must be an https address.`);
      if (charCount(b.src) > EMAIL_LIMITS.url) add(`${w}’s address is too long.`);
      b.alt = limitText(raw.alt, EMAIL_LIMITS.alt, add, `${w}’s description`);
      if (b.src && !b.alt.trim()) add(`${w} needs a short description (alt text).`);
      b.width = raw.width === 'full' || raw.width === undefined ? 'full' : Number.isInteger(raw.width) && raw.width >= 16 && raw.width <= EMAIL_LIMITS.imageWidth ? raw.width : (add(`${w}’s width must be 16 to ${EMAIL_LIMITS.imageWidth} pixels.`), 'full');
      b.origin = IMAGE_ORIGINS.includes(raw.origin) ? raw.origin : 'url';
      if (raw.link !== undefined && raw.link !== null) {
        const link = normalizeLink(raw.link, add, `${w}’s link`);
        if (link) b.link = link;
      }
      if (Number.isInteger(raw.w) && raw.w > 0 && raw.w <= 20_000 && Number.isInteger(raw.h) && raw.h > 0 && raw.h <= 20_000) {
        b.w = raw.w;
        b.h = raw.h;
      }
      if (typeof raw.prompt === 'string' && raw.prompt.trim()) b.prompt = limitText(raw.prompt, EMAIL_LIMITS.prompt, add, `${w}’s picture idea`);
      break;
    }
    case 'button': {
      b.label = limitText(raw.label, EMAIL_LIMITS.label, add, `${w}’s label`);
      const link = normalizeLink(raw.link, add, `${w}’s link`);
      b.link = link ?? { kind: 'url', url: '' };
      b.style = raw.style === 'outline' ? 'outline' : 'solid';
      if (raw.full === true) b.full = true;
      break;
    }
    case 'columns': {
      b.ratio = ['50/50', '33/67', '67/33'].includes(raw.ratio) ? raw.ratio : '50/50';
      b.stack = raw.stack !== false;
      const cols = Array.isArray(raw.cols) ? raw.cols : [];
      if (cols.length !== 2) add(`${w} needs exactly two columns.`);
      b.cols = [0, 1].map((i) => {
        const c = cols[i];
        const list = isRecord(c) && Array.isArray(c.blocks) ? c.blocks : [];
        if (list.length > EMAIL_LIMITS.columnBlocks) add(`${w}: a column holds at most ${EMAIL_LIMITS.columnBlocks} blocks.`);
        return { blocks: list.slice(0, EMAIL_LIMITS.columnBlocks).map((x, j) => normalizeBlock(x, add, `${w}, column ${i + 1}, block ${j + 1}`, true)).filter(Boolean) };
      });
      break;
    }
    case 'offer': {
      b.offerId = str(raw.offerId);
      if (b.offerId && !OFFER_ID_RE.test(b.offerId)) add(`${w} points to an offer that isn’t one of this business’s.`);
      b.title = limitText(raw.title, EMAIL_LIMITS.title, add, `${w}’s title`);
      b.price = limitText(raw.price, EMAIL_LIMITS.price, add, `${w}’s price`);
      if (typeof raw.blurb === 'string' && raw.blurb) b.blurb = limitText(raw.blurb, EMAIL_LIMITS.blurb, add, `${w}’s description`);
      const image = imageRef(raw.image, add, `${w}’s picture`);
      if (image?.src) b.image = image;
      b.buttonLabel = limitText(typeof raw.buttonLabel === 'string' && raw.buttonLabel.trim() ? raw.buttonLabel : 'Buy now', EMAIL_LIMITS.label, add, `${w}’s button`);
      break;
    }
    case 'video': {
      b.thumb = imageRef(raw.thumb, add, `${w}’s thumbnail`) ?? { src: '', alt: '' };
      const link = normalizeLink(raw.link ?? { kind: 'url', url: '' }, add, `${w}’s link`);
      if (link && link.kind !== 'url') add(`${w} must link to the video’s web address.`);
      b.link = link && link.kind === 'url' ? link : { kind: 'url', url: '' };
      if (typeof raw.caption === 'string' && raw.caption) b.caption = limitText(raw.caption, EMAIL_LIMITS.caption, add, `${w}’s caption`);
      break;
    }
    case 'social': {
      const list = Array.isArray(raw.links) ? raw.links : [];
      if (list.length > EMAIL_LIMITS.socialLinks) add(`${w} holds at most ${EMAIL_LIMITS.socialLinks} links.`);
      b.links = [];
      for (const l of list.slice(0, EMAIL_LIMITS.socialLinks)) {
        if (!isRecord(l) || !SOCIAL_PLATFORMS.includes(l.platform)) {
          add(`${w} has a link to a network the app doesn’t know.`);
          continue;
        }
        const url = str(l.url).trim();
        if (charCount(url) > EMAIL_LIMITS.url) add(`${w}’s ${SOCIAL_LABELS[l.platform]} link is too long.`);
        b.links.push({ platform: l.platform, url });
      }
      b.style = raw.style === 'icons' ? 'icons' : 'text';
      break;
    }
    case 'divider':
      b.style = raw.style === 'space' ? 'space' : 'line';
      b.size = Number.isInteger(raw.size) && raw.size >= 8 && raw.size <= 64 ? raw.size : 24;
      break;
    case 'custom': {
      b.html = str(raw.html);
      const hb = byteLength(b.html);
      if (hb > EMAIL_LIMITS.customHtmlBytes) add(`${w} is too big: ${Math.ceil(hb / 1024)} KB, and at most ${EMAIL_LIMITS.customHtmlBytes / 1024} KB fit.`);
      if (typeof raw.css === 'string' && raw.css) {
        b.css = raw.css;
        const cb = byteLength(b.css);
        if (cb > EMAIL_LIMITS.customCssBytes) add(`${w}’s CSS is too big: ${Math.ceil(cb / 1024)} KB, and at most ${EMAIL_LIMITS.customCssBytes / 1024} KB fit.`);
      }
      b.source = raw.source === 'agent' ? 'agent' : 'owner';
      if (Array.isArray(raw.notes)) {
        const notes = raw.notes.filter((n) => typeof n === 'string').slice(0, EMAIL_LIMITS.notes).map((n) => [...n].slice(0, EMAIL_LIMITS.note).join(''));
        if (notes.length) b.notes = notes;
      }
      break;
    }
  }
  return b;
}

/** A small deterministic hash (FNV-1a, 32 bits). */
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
/** A block id made from a seed: the same seed, the same id ('b_' + 10 url-safe characters). */
export function blockIdFrom(seed) {
  let a = fnv(`${seed}`);
  let b = fnv(`${seed}#2`);
  let out = '';
  for (let i = 0; i < 10; i++) {
    const src = i < 5 ? a : b;
    out += ID_ALPHABET[src & 63];
    if (i < 5) a = Math.floor(a / 64) ^ Math.imul(a, 31);
    else b = Math.floor(b / 64) ^ Math.imul(b, 31);
    a >>>= 0;
    b >>>= 0;
  }
  return `b_${out}`;
}

/** An empty doc in a theme. */
export const emptyDoc = (theme = { id: 'brand' }) => ({ v: 1, theme, blocks: [] });

/**
 * Any doc → { doc, problems }: known blocks and fields only, defaults filled in, missing or repeated ids made
 * (deterministically, from the block's place), limits checked. problems: [{ path, message }] in plain words.
 */
export function normalizeDoc(raw) {
  const problems = [];
  const at = (path) => (message) => problems.push({ path, message });
  if (!isRecord(raw)) {
    problems.push({ path: '', message: 'The email’s design is missing.' });
    return { doc: emptyDoc(), problems };
  }
  let size = 0;
  try {
    size = byteLength(JSON.stringify(raw));
  } catch {
    problems.push({ path: '', message: 'The email’s design couldn’t be read.' });
    return { doc: emptyDoc(), problems };
  }
  if (size > EMAIL_LIMITS.docBytes) problems.push({ path: '', message: `The email’s design is too big: ${Math.ceil(size / 1024)} KB, and at most ${EMAIL_LIMITS.docBytes / 1024} KB fit.` });
  const theme = normalizeThemeRef(raw.theme, at('theme'));
  const list = Array.isArray(raw.blocks) ? raw.blocks : [];
  if (raw.blocks !== undefined && !Array.isArray(raw.blocks)) problems.push({ path: 'blocks', message: 'The email’s blocks must be a list.' });
  if (list.length > EMAIL_LIMITS.blocks) problems.push({ path: 'blocks', message: `An email holds at most ${EMAIL_LIMITS.blocks} blocks.` });
  const blocks = list.slice(0, EMAIL_LIMITS.blocks).map((b, i) => normalizeBlock(b, at(`blocks[${i}]`), `Block ${i + 1}`, false)).filter(Boolean);
  // ids: kept when valid and unique, else made from the block's place
  const seen = new Set();
  let n = 0;
  const fix = (b, place) => {
    if (!b.id || seen.has(b.id)) {
      let id = blockIdFrom(`auto:${place}`);
      while (seen.has(id)) id = blockIdFrom(`auto:${place}:${++n}`);
      b.id = id;
    }
    seen.add(b.id);
  };
  blocks.forEach((b, i) => {
    fix(b, `${i}`);
    if (b.type === 'columns') b.cols.forEach((c, ci) => c.blocks.forEach((x, j) => fix(x, `${i}.${ci}.${j}`)));
  });
  return { doc: { v: 1, theme, blocks }, problems };
}
