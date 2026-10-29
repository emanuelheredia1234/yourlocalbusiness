// A designed PDF guide / ebook, typeset with pdf-lib: cover, copyright page, clickable contents
// and bookmarks, welcome, chapter openers, chapters set from Markdown, fillable workbook pages,
// next steps and a back cover, all in the brand's colors. Standard PDF fonts only (no font
// files to embed), so text is cleaned to the characters those fonts can show.

import { PDFDocument, PDFHexString, PDFName, StandardFonts, clip, endPath, popGraphicsState, pushGraphicsState, rectangle, rgb, type PDFFont, type PDFImage, type PDFPage, type PDFRef, type RGB } from 'pdf-lib';
import type { BrandColors } from './types';
import { parseMarkdown, runsText, type Block, type Run } from './markdownBlocks';

export interface Worksheet {
  title: string;
  intro: string;
  prompts: string[];
  checklist: string[];
}

export interface EbookChapter {
  title: string;
  summary?: string;
  items: { title: string; meta?: string; detail?: string }[];
  markdown?: string;
  worksheet?: Worksheet | null;
}

export interface EbookDoc {
  title: string;
  subtitle: string;
  author: string;
  website?: string;
  tagline?: string;
  /** e.g. "Guide", "Ebook", "Course workbook" */
  formatLabel: string;
  colors: BrandColors;
  welcome: string;
  howToUse: string[];
  disclaimer: string;
  chapters: EbookChapter[];
  conclusion: string;
  nextSteps: string[];
  cover?: { bytes: Uint8Array; type: 'jpg' | 'png' } | null;
  /** e.g. "October 2026" */
  edition: string;
  year: number;
}

export type EbookTheme = 'modern' | 'classic';
export type EbookPageSize = 'letter' | 'a4';

export interface EbookOptions {
  theme: EbookTheme;
  pageSize: EbookPageSize;
  /** workbook pages get fillable fields */
  fillable: boolean;
}

const SIZES: Record<EbookPageSize, [number, number]> = { letter: [612, 792], a4: [595.28, 841.89] };
const WORDS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty'];

// ───────────── colors ─────────────

function hexRgb(hex: string): [number, number, number] {
  const h = (hex || '').replace('#', '');
  const six = h.length === 3 ? h.replace(/(.)/g, '$1$1') : h.padEnd(6, '0').slice(0, 6);
  return [0, 2, 4].map((i) => (parseInt(six.slice(i, i + 2), 16) || 0) / 255) as [number, number, number];
}
const lum = (c: [number, number, number]) => {
  const [r, g, b] = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
const mix = (c: [number, number, number], to: [number, number, number], t: number) => c.map((x, i) => x + (to[i] - x) * t) as [number, number, number];
const toRgb = (c: [number, number, number]) => rgb(c[0], c[1], c[2]);

interface Palette {
  primary: RGB;
  accent: RGB;
  /** accent dark enough for text on white */
  accentText: RGB;
  ink: RGB;
  muted: RGB;
  line: RGB;
  tint: RGB;
  field: RGB;
  onPrimary: RGB;
  onPrimarySoft: RGB;
  secondary: RGB;
  white: RGB;
}

function palette(c: BrandColors): Palette {
  const white: [number, number, number] = [1, 1, 1];
  const primary = hexRgb(c.primary || '#1f5f4a');
  let ink = hexRgb(c.ink || '#1f2328');
  if (contrast(ink, white) < 7) ink = hexRgb('#1f2328');
  let primaryText = primary;
  if (contrast(primaryText, white) < 4.5) primaryText = mix(primary, [0, 0, 0], 0.45);
  const accent = hexRgb(c.accent || c.primary || '#1f5f4a');
  const accentText = contrast(accent, white) >= 3 ? accent : mix(accent, [0, 0, 0], 0.4);
  const onPrimary = lum(primary) > 0.45 ? ink : white;
  return {
    primary: toRgb(primaryText),
    accent: toRgb(accent),
    accentText: toRgb(accentText),
    ink: toRgb(ink),
    muted: toRgb(mix(ink, white, 0.42)),
    line: toRgb(mix(ink, white, 0.82)),
    tint: toRgb(mix(primary, white, 0.91)),
    field: toRgb(mix(primary, white, 0.96)),
    onPrimary: toRgb(onPrimary),
    onPrimarySoft: toRgb(mix(onPrimary, primary, 0.25)),
    secondary: toRgb(hexRgb(c.secondary || c.primary || '#0e3b2a')),
    white: toRgb(white),
  };
}
// the cover background uses the brand color itself, even when it is light
const coverFill = (c: BrandColors) => toRgb(hexRgb(c.primary || '#1f5f4a'));

// ───────────── text cleanup ─────────────

const REPLACE: Record<string, string> = {
  '→': '->', '⟶': '->', '←': '<-', '↔': '<->', '⇒': '=>', '≥': '>=', '≤': '<=', '≠': '!=', '≈': '~', '−': '-', '‐': '-', '‑': '-', '⁃': '-',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '​': '', '‍': '', '﻿': '', '\t': ' ',
  '′': "'", '″': '"', '✓': '', '✔': '', '✅': '', '☐': '', '☑': '', '✗': 'x', '✘': 'x', '★': '*', '☆': '*', '▶': '>', '►': '>', '▪': '•', '◦': '•', '●': '•',
};

// ───────────── layout engine ─────────────

interface Fonts {
  body: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  head: PDFFont;
  mono: PDFFont;
  sans: PDFFont;
  sansBold: PDFFont;
}

type PageKind = 'cover' | 'plain' | 'body' | 'opener' | 'back';
interface PageInfo {
  page: PDFPage;
  kind: PageKind;
  header: string;
}
interface Seg {
  text: string;
  font: PDFFont;
}
interface Line {
  segs: Seg[];
  width: number;
}
interface TocEntry {
  label: string;
  number?: string;
  page: PDFPage;
  index: number;
}

class Book {
  W: number;
  H: number;
  M: { l: number; r: number; t: number; b: number };
  page!: PDFPage;
  y = 0;
  pages: PageInfo[] = [];
  header = '';
  body: { size: number; leading: number };
  private chars: Set<number>;
  fieldCount = 0;

  constructor(
    public pdf: PDFDocument,
    public f: Fonts,
    public c: Palette,
    public opts: EbookOptions,
    /** the brand color itself, for full-bleed areas (cover, chapter bands) */
    public band: RGB,
  ) {
    [this.W, this.H] = SIZES[opts.pageSize];
    this.M = { l: 66, r: 66, t: 84, b: 78 };
    this.body = opts.theme === 'classic' ? { size: 11.5, leading: 16.8 } : { size: 10.5, leading: 16 };
    this.chars = new Set(f.body.getCharacterSet());
  }

  get width() {
    return this.W - this.M.l - this.M.r;
  }

  /** Text the standard fonts can show: known symbols swapped, anything else dropped. */
  clean(s: string): string {
    let out = '';
    for (const ch of s.normalize('NFC')) {
      const r = REPLACE[ch];
      if (r !== undefined) out += r;
      else if (this.chars.has(ch.codePointAt(0)!)) out += ch;
    }
    return out.replace(/ {2,}/g, ' ');
  }

  addPage(kind: PageKind, header = this.header): PDFPage {
    this.page = this.pdf.addPage([this.W, this.H]);
    this.pages.push({ page: this.page, kind, header });
    this.y = this.H - this.M.t;
    return this.page;
  }

  /** Make room for h points, continuing on a new body page when needed. */
  ensure(h: number) {
    if (this.y - h < this.M.b) this.addPage('body');
  }

  fontFor(r: Run): PDFFont {
    if (r.code) return this.f.mono;
    if (r.b && r.i) return this.f.boldItalic;
    if (r.b) return this.f.bold;
    if (r.i) return this.f.italic;
    return this.f.body;
  }

  wrap(runs: Run[], size: number, width: number, font?: (r: Run) => PDFFont): Line[] {
    const lines: Line[] = [];
    let cur: Line = { segs: [], width: 0 };
    let space: Seg | null = null;
    const push = (text: string, fnt: PDFFont, w: number) => {
      const last = cur.segs[cur.segs.length - 1];
      if (last && last.font === fnt) last.text += text;
      else cur.segs.push({ text, font: fnt });
      cur.width += w;
    };
    for (const r of runs) {
      const fnt = font ? font(r) : this.fontFor(r);
      for (const tok of this.clean(r.text).split(/(\s+)/)) {
        if (!tok) continue;
        if (/^\s+$/.test(tok)) {
          if (cur.segs.length) space = { text: ' ', font: fnt };
          continue;
        }
        let word = tok;
        let w = fnt.widthOfTextAtSize(word, size);
        const sw = space ? space.font.widthOfTextAtSize(' ', size) : 0;
        if (cur.segs.length && cur.width + sw + w > width) {
          lines.push(cur);
          cur = { segs: [], width: 0 };
          space = null;
        } else if (space) {
          push(' ', space.font, sw);
          space = null;
        }
        // a word longer than the line (a URL) is split
        while (w > width && word.length > 1) {
          let n = word.length - 1;
          while (n > 1 && fnt.widthOfTextAtSize(word.slice(0, n), size) > width - cur.width) n--;
          push(word.slice(0, n), fnt, fnt.widthOfTextAtSize(word.slice(0, n), size));
          lines.push(cur);
          cur = { segs: [], width: 0 };
          word = word.slice(n);
          w = fnt.widthOfTextAtSize(word, size);
        }
        push(word, fnt, w);
      }
    }
    if (cur.segs.length) lines.push(cur);
    return lines;
  }

  drawLines(lines: Line[], x: number, size: number, leading: number, color: RGB, align: 'left' | 'center' = 'left', page = this.page) {
    for (const ln of lines) {
      const base = this.y - size * 0.8;
      let cx = align === 'center' ? x + (this.width - ln.width) / 2 : x;
      for (const s of ln.segs) {
        page.drawText(s.text, { x: cx, y: base, size, font: s.font, color });
        cx += s.font.widthOfTextAtSize(s.text, size);
      }
      this.y -= leading;
    }
  }

  /** A flowing paragraph that may continue on the next page. */
  text(runs: Run[], o: { size?: number; leading?: number; color?: RGB; x?: number; width?: number; after?: number; align?: 'left' | 'center'; font?: (r: Run) => PDFFont } = {}) {
    const size = o.size ?? this.body.size;
    const leading = o.leading ?? this.body.leading;
    const x = o.x ?? this.M.l;
    const lines = this.wrap(runs, size, o.width ?? this.width - (x - this.M.l), o.font);
    // short paragraphs stay together; a long one never leaves its last line alone on a page
    if (lines.length <= 3) this.ensure(lines.length * leading);
    lines.forEach((ln, i) => {
      if (i === lines.length - 2 && this.y - 2 * leading < this.M.b) this.addPage('body');
      this.ensure(leading);
      this.drawLines([ln], x, size, leading, o.color ?? this.c.ink, o.align);
    });
    this.y -= o.after ?? 0;
  }

  plain(s: string): Run[] {
    return [{ text: s }];
  }

  heading(runs: Run[], level: 1 | 2 | 3 | 4) {
    const classic = this.opts.theme === 'classic';
    const size = level <= 2 ? (classic ? 17 : 15.5) : level === 3 ? 12.5 : 11;
    const before = level <= 2 ? 14 : 9;
    const lines = this.wrap(runs, size, this.width, () => this.f.head);
    // keep a heading with at least two lines of what follows
    this.y -= before;
    this.ensure(lines.length * size * 1.3 + this.body.leading * 2);
    this.drawLines(lines, this.M.l, size, size * 1.3, level <= 2 ? this.c.primary : this.c.ink);
    this.y -= level <= 2 ? 5 : 3;
  }

  blocks(blocks: Block[]) {
    let prev: Block | null = null;
    for (const b of blocks) {
      if (prev?.t === 'li' && b.t !== 'li') this.y -= 5;
      switch (b.t) {
        case 'h':
          this.heading(b.runs, b.level);
          break;
        case 'p':
          this.text(b.runs, { after: 7 });
          break;
        case 'li':
          this.listItem(b);
          break;
        case 'quote':
          this.callout(b.runs);
          break;
        case 'hr':
          this.ensure(20);
          this.y -= 8;
          this.page.drawLine({ start: { x: this.M.l, y: this.y }, end: { x: this.W - this.M.r, y: this.y }, thickness: 0.6, color: this.c.line });
          this.y -= 12;
          break;
        case 'table':
          this.table(b.head, b.rows);
          break;
      }
      prev = b;
    }
    if (prev?.t === 'li') this.y -= 5;
  }

  listItem(b: Extract<Block, { t: 'li' }>) {
    const size = this.body.size;
    const lead = this.body.leading;
    const indent = this.M.l + b.depth * 16;
    const textX = indent + 16;
    const lines = this.wrap(b.runs, size, this.W - this.M.r - textX);
    this.ensure(Math.min(lines.length, 3) * lead);
    const top = this.y;
    if (b.check !== null) {
      const s = size * 0.78;
      this.page.drawRectangle({ x: indent + 1, y: top - size * 0.8 - 0.5, width: s, height: s, borderColor: this.c.accentText, borderWidth: 0.9, color: this.c.white });
      if (b.check) this.page.drawSvgPath('M1.8 5.2 L4.1 7.5 L8.4 2.2', { x: indent + 1, y: top - size * 0.8 - 0.5 + s, scale: s / 10, borderColor: this.c.accentText, borderWidth: 1.5 });
    } else if (b.ordered) {
      this.page.drawText(`${b.n}.`, { x: indent, y: top - size * 0.8, size, font: this.f.sansBold, color: this.c.accentText });
    } else {
      this.page.drawText('•', { x: indent + 3, y: top - size * 0.8, size, font: this.f.sansBold, color: this.c.accentText });
    }
    for (const ln of lines) {
      this.ensure(lead);
      this.drawLines([ln], textX, size, lead, this.c.ink);
    }
    this.y -= 3;
  }

  callout(runs: Run[]) {
    const size = this.body.size;
    const lead = this.body.leading;
    const pad = 11;
    const lines = this.wrap(runs, size, this.width - pad * 2 - 4);
    const h = lines.length * lead + pad * 2 - 4;
    this.y -= 4;
    this.ensure(Math.min(h, this.H - this.M.t - this.M.b));
    const top = this.y;
    this.page.drawRectangle({ x: this.M.l, y: top - h, width: this.width, height: h, color: this.c.tint });
    this.page.drawRectangle({ x: this.M.l, y: top - h, width: 3, height: h, color: this.c.accent });
    this.y -= pad - 2;
    this.drawLines(lines, this.M.l + pad + 4, size, lead, this.c.ink);
    this.y = top - h - 10;
  }

  table(head: Run[][], rows: Run[][][]) {
    const cols = Math.max(head.length, ...rows.map((r) => r.length));
    if (!cols) return;
    const size = this.body.size - 1;
    const lead = size * 1.4;
    const pad = 5;
    const cw = this.width / cols;
    const rowLines = (cells: Run[][], bold: boolean) => Array.from({ length: cols }, (_, i) => this.wrap(cells[i] ?? [], size, cw - pad * 2, bold ? () => this.f.bold : undefined));
    const drawRow = (cells: Run[][], bold: boolean) => {
      const lines = rowLines(cells, bold);
      const h = Math.max(1, ...lines.map((l) => l.length)) * lead + pad * 2 - 3;
      this.ensure(h);
      const top = this.y;
      if (bold) this.page.drawRectangle({ x: this.M.l, y: top - h, width: this.width, height: h, color: this.c.tint });
      lines.forEach((l, i) => {
        this.y = top - pad + 1;
        this.drawLines(l, this.M.l + i * cw + pad, size, lead, this.c.ink);
      });
      this.y = top - h;
      this.page.drawLine({ start: { x: this.M.l, y: this.y }, end: { x: this.W - this.M.r, y: this.y }, thickness: 0.5, color: this.c.line });
    };
    this.y -= 6;
    drawRow(head, true);
    for (const r of rows) drawRow(r, false);
    this.y -= 12;
  }

  /** A soft box listing what a chapter covers. */
  itemsBox(items: EbookChapter['items']) {
    if (!items.length) return;
    const size = this.body.size - 0.5;
    const lead = size * 1.45;
    const pad = 13;
    const textX = this.M.l + pad + 12;
    const metaW = 110;
    const entries = items.slice(0, 10).map((it) => ({ lines: this.wrap([{ text: it.title }], size, this.width - pad * 2 - 12 - (it.meta ? metaW : 0)), meta: it.meta ? this.clean(it.meta).slice(0, 26) : '' }));
    const h = 26 + entries.reduce((s, e) => s + e.lines.length * lead + 2, 0) + pad - 4;
    this.ensure(h);
    const top = this.y;
    this.page.drawRectangle({ x: this.M.l, y: top - h, width: this.width, height: h, color: this.c.tint });
    this.page.drawText('IN THIS CHAPTER', { x: this.M.l + pad, y: top - pad - 7, size: 7.5, font: this.f.sansBold, color: this.c.accentText });
    this.y = top - 26;
    for (const e of entries) {
      this.page.drawText('•', { x: this.M.l + pad, y: this.y - size * 0.8, size, font: this.f.sansBold, color: this.c.accentText });
      if (e.meta) this.page.drawText(e.meta, { x: this.W - this.M.r - pad - this.f.sans.widthOfTextAtSize(e.meta, 8), y: this.y - size * 0.8, size: 8, font: this.f.sans, color: this.c.muted });
      this.drawLines(e.lines, textX, size, lead, this.c.ink);
      this.y -= 2;
    }
    this.y = top - h - 16;
  }
}

// ───────────── pages ─────────────

function wrapTitle(book: Book, text: string, font: PDFFont, width: number, maxSize: number, minSize: number, maxLines: number): { size: number; lines: string[] } {
  for (let size = maxSize; size >= minSize; size -= 1) {
    const lines = book.wrap([{ text }], size, width, () => font).map((l) => l.segs.map((s) => s.text).join(''));
    if (lines.length <= maxLines) return { size, lines };
  }
  const lines = book.wrap([{ text }], minSize, width, () => font).map((l) => l.segs.map((s) => s.text).join(''));
  return { size: minSize, lines: lines.slice(0, maxLines) };
}

function drawCover(book: Book, doc: EbookDoc, image: PDFImage | null) {
  const { W, H } = book;
  const p = book.addPage('cover', '');
  const bg = book.band;
  p.drawRectangle({ x: 0, y: 0, width: W, height: H, color: bg });
  const c = book.c;
  let textTop: number;
  if (image) {
    // the photo fills the top of the cover, cropped to fit
    const boxH = H * 0.56;
    const boxY = H - boxH;
    const scale = Math.max(W / image.width, boxH / image.height);
    const dw = image.width * scale;
    const dh = image.height * scale;
    p.pushOperators(pushGraphicsState(), rectangle(0, boxY, W, boxH), clip(), endPath());
    p.drawImage(image, { x: (W - dw) / 2, y: boxY + (boxH - dh) / 2, width: dw, height: dh });
    p.pushOperators(popGraphicsState());
    // fade the bottom of the photo into the cover color
    for (let i = 0; i < 24; i++) p.drawRectangle({ x: 0, y: boxY + i * 3, width: W, height: 3, color: bg, opacity: ((24 - i) / 24) ** 1.6 });
    textTop = boxY - 34;
  } else {
    p.drawCircle({ x: W * 0.86, y: H * 0.86, size: W * 0.42, color: c.secondary, opacity: 0.35 });
    p.drawCircle({ x: W * 0.94, y: H * 0.62, size: W * 0.16, color: c.accent, opacity: 0.85 });
    textTop = H * 0.56;
  }
  const x = 58;
  const width = W - 116;
  p.drawRectangle({ x, y: textTop + 4, width: 46, height: 4, color: c.accent });
  const eyebrow = book.clean(`${doc.formatLabel} · ${doc.author}`.toUpperCase());
  p.drawText(eyebrow, { x, y: textTop - 18, size: 9.5, font: book.f.sansBold, color: c.onPrimary, opacity: 0.85 });
  const titleFont = book.opts.theme === 'classic' ? book.f.head : book.f.sansBold;
  const t = wrapTitle(book, doc.title, titleFont, width, image ? 36 : 44, 22, 4);
  let y = textTop - 34 - t.size;
  for (const ln of t.lines) {
    p.drawText(ln, { x, y, size: t.size, font: titleFont, color: c.onPrimary });
    y -= t.size * 1.12;
  }
  if (doc.subtitle) {
    const sub = book.wrap([{ text: doc.subtitle }], 13.5, width, () => book.f.sans).slice(0, 4);
    y -= 8;
    for (const ln of sub) {
      p.drawText(ln.segs.map((s) => s.text).join(''), { x, y, size: 13.5, font: book.f.sans, color: c.onPrimarySoft });
      y -= 19;
    }
  }
  p.drawText(book.clean(doc.author), { x, y: 58, size: 12, font: book.f.sansBold, color: c.onPrimary });
  if (doc.website) p.drawText(book.clean(doc.website), { x, y: 42, size: 9.5, font: book.f.sans, color: c.onPrimarySoft });
}

function drawCopyright(book: Book, doc: EbookDoc) {
  book.addPage('plain', '');
  const size = 8.8;
  const lines: [string, boolean][] = [
    [doc.title, true],
    [`© ${doc.year} ${doc.author}. All rights reserved.`, false],
    ['No part of this publication may be copied, shared or resold without written permission, except for brief quotes with credit.', false],
    [doc.disclaimer, false],
    [`Edition: ${doc.edition}`, false],
    ...(doc.website ? ([[doc.website, false]] as [string, boolean][]) : []),
  ];
  const wrapped = lines.map(([t, b]) => ({ b, lines: book.wrap([{ text: t, b }], size, book.width * 0.78) }));
  const h = wrapped.reduce((s, w) => s + w.lines.length * 13 + 8, 0);
  book.y = book.M.b + h;
  for (const w of wrapped) {
    book.drawLines(w.lines, book.M.l, size, 13, w.b ? book.c.ink : book.c.muted);
    book.y -= 8;
  }
}

function chapterOpener(book: Book, ch: EbookChapter, n: number) {
  book.header = ch.title;
  const p = book.addPage('opener', ch.title);
  const { W } = book;
  const c = book.c;
  if (book.opts.theme === 'classic') {
    book.y = book.H - 120;
    const eyebrow = `CHAPTER ${(WORDS[n - 1] ?? String(n)).toUpperCase()}`;
    p.drawText(eyebrow, { x: (W - book.f.sansBold.widthOfTextAtSize(eyebrow, 9)) / 2, y: book.y, size: 9, font: book.f.sansBold, color: c.accentText });
    book.y -= 22;
    const t = wrapTitle(book, ch.title, book.f.head, book.width - 40, 28, 18, 4);
    for (const ln of t.lines) {
      p.drawText(ln, { x: (W - book.f.head.widthOfTextAtSize(ln, t.size)) / 2, y: book.y - t.size * 0.8, size: t.size, font: book.f.head, color: c.primary });
      book.y -= t.size * 1.22;
    }
    book.y -= 10;
    p.drawRectangle({ x: (W - 54) / 2, y: book.y, width: 54, height: 1.6, color: c.accent });
    book.y -= 24;
    if (ch.summary) book.text([{ text: ch.summary, i: true }], { size: 12.5, leading: 18, color: c.muted, align: 'center', after: 18 });
  } else {
    const bandH = 196;
    p.drawRectangle({ x: 0, y: book.H - bandH, width: W, height: bandH, color: book.band });
    const num = String(n).padStart(2, '0');
    p.drawText(num, { x: W - book.M.r - book.f.sansBold.widthOfTextAtSize(num, 92), y: book.H - bandH + 22, size: 92, font: book.f.sansBold, color: c.onPrimary, opacity: 0.14 });
    p.drawText(`CHAPTER ${n}`, { x: book.M.l, y: book.H - 70, size: 9, font: book.f.sansBold, color: c.accent });
    const t = wrapTitle(book, ch.title, book.f.sansBold, book.width - 70, 26, 17, 3);
    let y = book.H - 92 - t.size * 0.8;
    for (const ln of t.lines) {
      p.drawText(ln, { x: book.M.l, y, size: t.size, font: book.f.sansBold, color: c.onPrimary });
      y -= t.size * 1.18;
    }
    book.y = book.H - bandH - 30;
    if (ch.summary) book.text([{ text: ch.summary }], { size: 12.5, leading: 18.5, color: c.muted, after: 16 });
  }
}

function sameTitle(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/^(chapter|module|part|section)\s+\w+[:.\s-]*/i, '').replace(/^\d+[.):\s-]*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const x = n(a);
  const y = n(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

function chapterBody(book: Book, ch: EbookChapter) {
  book.itemsBox(ch.items);
  if (ch.markdown?.trim()) {
    const blocks = parseMarkdown(ch.markdown);
    // drafts often repeat the chapter title as their first heading
    if (blocks[0]?.t === 'h' && sameTitle(runsText(blocks[0].runs), ch.title)) blocks.shift();
    book.blocks(blocks);
  } else {
    for (const it of ch.items) {
      book.heading([{ text: it.title }], 3);
      if (it.detail) book.text([{ text: it.detail }], { after: 6 });
    }
  }
}

function worksheetPages(book: Book, ch: EbookChapter, n: number, ws: Worksheet) {
  const c = book.c;
  const usable = book.H - book.M.t - book.M.b;
  if (book.pages[book.pages.length - 1].kind === 'body' && book.y - book.M.b > usable * 0.55) {
    // plenty of room left on the chapter's last page: the workbook starts here, after a divider
    book.y -= 14;
    for (let x = book.M.l; x < book.W - book.M.r; x += 6) book.page.drawLine({ start: { x, y: book.y }, end: { x: x + 3, y: book.y }, thickness: 0.7, color: c.line });
    book.y -= 26;
    book.header = `Workbook · ${ch.title}`;
  } else {
    book.header = `Workbook · ${ch.title}`;
    book.addPage('body');
  }
  book.page.drawText(`CHAPTER ${n} WORKBOOK`, { x: book.M.l, y: book.y - 8, size: 8.5, font: book.f.sansBold, color: c.accentText });
  book.y -= 18;
  book.text([{ text: ws.title }], { size: 18, leading: 23, color: c.primary, font: () => book.f.head, after: 4 });
  if (ws.intro) book.text([{ text: ws.intro }], { color: c.muted, after: 12 });
  const form = book.opts.fillable ? book.pdf.getForm() : null;
  ws.prompts.slice(0, 6).forEach((q, i) => {
    const label = book.wrap([{ text: `${i + 1}. `, b: true }, { text: q, b: true }], book.body.size, book.width);
    const boxH = 78;
    book.ensure(label.length * book.body.leading + boxH + 16);
    book.drawLines(label, book.M.l, book.body.size, book.body.leading, c.ink);
    book.y -= 4;
    const y = book.y - boxH;
    if (form) {
      const tf = form.createTextField(`ch${n}.q${i + 1}.${book.fieldCount++}`);
      tf.enableMultiline();
      tf.addToPage(book.page, { x: book.M.l, y, width: book.width, height: boxH, borderColor: c.line, borderWidth: 0.8, backgroundColor: c.field, textColor: c.ink, font: book.f.sans });
      tf.setFontSize(10);
    } else {
      book.page.drawRectangle({ x: book.M.l, y, width: book.width, height: boxH, borderColor: c.line, borderWidth: 0.8, color: c.field });
      for (let ly = y + 20; ly < y + boxH - 8; ly += 20) book.page.drawLine({ start: { x: book.M.l + 10, y: ly }, end: { x: book.W - book.M.r - 10, y: ly }, thickness: 0.4, color: c.line });
    }
    book.y = y - 16;
  });
  if (ws.checklist.length) {
    book.y -= 4;
    book.heading([{ text: 'Action checklist' }], 3);
    book.y -= 4;
    ws.checklist.slice(0, 10).forEach((item, i) => {
      const size = book.body.size;
      const lines = book.wrap([{ text: item }], size, book.width - 24);
      book.ensure(lines.length * book.body.leading + 6);
      const top = book.y;
      const box = 11;
      const by = top - size * 0.8 - 1.5;
      if (form) {
        const cb = form.createCheckBox(`ch${n}.c${i + 1}.${book.fieldCount++}`);
        cb.addToPage(book.page, { x: book.M.l, y: by, width: box, height: box, borderColor: c.accentText, borderWidth: 0.9, backgroundColor: c.white, textColor: c.primary });
      } else book.page.drawRectangle({ x: book.M.l, y: by, width: box, height: box, borderColor: c.accentText, borderWidth: 0.9 });
      book.drawLines(lines, book.M.l + 22, size, book.body.leading, c.ink);
      book.y -= 6;
    });
  }
}

function decorate(book: Book, doc: EbookDoc) {
  const c = book.c;
  book.pages.forEach((pi, i) => {
    const n = i + 1;
    if (pi.kind === 'cover' || pi.kind === 'back') return;
    const p = pi.page;
    if (pi.kind === 'body' && pi.header) {
      const head = book.clean(pi.header).slice(0, 70);
      p.drawText(head, { x: book.M.l, y: book.H - 46, size: 8, font: book.f.sans, color: c.muted });
      const right = book.clean(doc.author);
      p.drawText(right, { x: book.W - book.M.r - book.f.sans.widthOfTextAtSize(right, 8), y: book.H - 46, size: 8, font: book.f.sans, color: c.muted });
      p.drawLine({ start: { x: book.M.l, y: book.H - 54 }, end: { x: book.W - book.M.r, y: book.H - 54 }, thickness: 0.5, color: c.line });
    }
    if (pi.kind !== 'plain' || i > 1) {
      const label = String(n);
      const w = book.f.sansBold.widthOfTextAtSize(label, 8.5);
      p.drawText(label, { x: book.opts.theme === 'classic' ? (book.W - w) / 2 : book.W - book.M.r - w, y: 40, size: 8.5, font: book.f.sansBold, color: c.muted });
      if (book.opts.theme !== 'classic') p.drawRectangle({ x: book.W - book.M.r - w - 12, y: 41.5, width: 5, height: 5, color: c.accent });
    }
  });
}

function drawToc(book: Book, tocPages: PDFPage[], entries: TocEntry[]) {
  const c = book.c;
  const perPage = tocPages.length > 1 ? Math.ceil(entries.length / tocPages.length) : entries.length;
  tocPages.forEach((p, pi) => {
    book.page = p;
    book.y = book.H - book.M.t;
    if (pi === 0) {
      p.drawText('Contents', { x: book.M.l, y: book.y - 26, size: 30, font: book.f.head, color: c.primary });
      p.drawRectangle({ x: book.M.l, y: book.y - 44, width: 40, height: 3, color: c.accent });
      book.y -= 74;
    }
    for (const e of entries.slice(pi * perPage, (pi + 1) * perPage)) {
      const size = 11.5;
      const numW = 30;
      const pageLabel = String(e.index + 1);
      const pw = book.f.sansBold.widthOfTextAtSize(pageLabel, size);
      const lines = book.wrap([{ text: e.label }], size, book.width - numW - pw - 40, () => book.f.body).slice(0, 2);
      const top = book.y;
      if (e.number) p.drawText(e.number, { x: book.M.l, y: top - size * 0.8, size: size - 1, font: book.f.sansBold, color: c.accentText });
      book.drawLines(lines, book.M.l + numW, size, size * 1.45, c.ink, 'left', p);
      const last = lines[lines.length - 1];
      const lastBase = book.y + size * 1.45 - size * 0.8;
      // dot leader from the end of the title to the page number
      const from = book.M.l + numW + (last?.width ?? 0) + 8;
      const to = book.W - book.M.r - pw - 8;
      for (let x = from; x < to; x += 5) p.drawCircle({ x, y: lastBase + 2, size: 0.55, color: c.line });
      p.drawText(pageLabel, { x: book.W - book.M.r - pw, y: lastBase, size, font: book.f.sansBold, color: c.primary });
      const bottom = book.y + size * 0.2;
      // the whole row links to the page
      const link = book.pdf.context.register(book.pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [book.M.l, bottom, book.W - book.M.r, top], Border: [0, 0, 0], Dest: [e.page.ref, 'XYZ', null, null, null] }));
      p.node.addAnnot(link);
      book.y -= 9;
    }
  });
}

function addOutline(book: Book, entries: TocEntry[]) {
  if (!entries.length) return;
  const ctx = book.pdf.context;
  const root = ctx.nextRef();
  const refs: PDFRef[] = entries.map(() => ctx.nextRef());
  entries.forEach((e, i) => {
    const item: Record<string, unknown> = { Title: PDFHexString.fromText(book.clean(e.number ? `${e.number}  ${e.label}` : e.label)), Parent: root, Dest: [e.page.ref, 'XYZ', null, null, null] };
    if (i > 0) item.Prev = refs[i - 1];
    if (i < entries.length - 1) item.Next = refs[i + 1];
    ctx.assign(refs[i], ctx.obj(item as never));
  });
  ctx.assign(root, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: entries.length }));
  book.pdf.catalog.set(PDFName.of('Outlines'), root);
  book.pdf.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

/** Typeset the ebook and return the PDF bytes. */
export async function buildEbookPdf(doc: EbookDoc, opts: EbookOptions): Promise<{ bytes: Uint8Array; pages: number }> {
  const pdf = await PDFDocument.create();
  const classic = opts.theme === 'classic';
  const [helv, helvB, helvI, helvBI, times, timesB, timesI, timesBI, courier] = await Promise.all(
    [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique, StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic, StandardFonts.Courier].map((f) => pdf.embedFont(f)),
  );
  const fonts: Fonts = classic
    ? { body: times, bold: timesB, italic: timesI, boldItalic: timesBI, head: timesB, mono: courier, sans: helv, sansBold: helvB }
    : { body: helv, bold: helvB, italic: helvI, boldItalic: helvBI, head: helvB, mono: courier, sans: helv, sansBold: helvB };
  const book = new Book(pdf, fonts, palette(doc.colors), opts, coverFill(doc.colors));
  const clean = (s: string) => book.clean(s);

  pdf.setTitle(clean(doc.title), { showInWindowTitleBar: true });
  pdf.setAuthor(clean(doc.author));
  pdf.setSubject(clean(doc.subtitle));
  pdf.setKeywords([doc.formatLabel, doc.author]);
  pdf.setCreator('Yourlocalbusiness');
  pdf.setProducer('Yourlocalbusiness (pdf-lib)');
  pdf.setCreationDate(new Date());

  let image: PDFImage | null = null;
  if (doc.cover?.bytes?.length) {
    try {
      image = doc.cover.type === 'png' ? await pdf.embedPng(doc.cover.bytes) : await pdf.embedJpg(doc.cover.bytes);
    } catch {
      image = null;
    }
  }

  drawCover(book, doc, image);
  drawCopyright(book, doc);
  const entriesCount = doc.chapters.length + 2;
  const tocPages = Array.from({ length: Math.max(1, Math.ceil(entriesCount / 16)) }, () => book.addPage('plain', ''));
  const toc: TocEntry[] = [];
  const at = (label: string, number?: string) => toc.push({ label, number, page: book.page, index: book.pages.length - 1 });

  // welcome
  book.header = 'Welcome';
  book.addPage('body');
  at('Welcome');
  book.text([{ text: 'Welcome' }], { size: 28, leading: 34, color: book.c.primary, font: () => fonts.head, after: 6 });
  book.page.drawRectangle({ x: book.M.l, y: book.y + 2, width: 40, height: 3, color: book.c.accent });
  book.y -= 18;
  book.blocks(parseMarkdown(doc.welcome));
  if (doc.howToUse.length) {
    book.heading([{ text: `How to use this ${doc.formatLabel.toLowerCase()}` }], 2);
    book.blocks(doc.howToUse.map((s, i) => ({ t: 'li', ordered: true, n: i + 1, depth: 0, runs: [{ text: s }], check: null })));
  }
  if (opts.fillable && doc.chapters.some((ch) => ch.worksheet)) book.callout([{ text: 'Workbook pages are fillable: ', b: true }, { text: 'type straight into the boxes and tick the checklists in any PDF reader, or print them and write by hand.' }]);

  // chapters
  doc.chapters.forEach((ch, i) => {
    const n = i + 1;
    chapterOpener(book, ch, n);
    at(ch.title, String(n).padStart(2, '0'));
    chapterBody(book, ch);
    if (ch.worksheet && (ch.worksheet.prompts.length || ch.worksheet.checklist.length)) worksheetPages(book, ch, n, ch.worksheet);
  });

  // next steps
  book.header = 'Your next steps';
  book.addPage('body');
  at('Your next steps');
  book.text([{ text: 'Your next steps' }], { size: 28, leading: 34, color: book.c.primary, font: () => fonts.head, after: 6 });
  book.page.drawRectangle({ x: book.M.l, y: book.y + 2, width: 40, height: 3, color: book.c.accent });
  book.y -= 18;
  book.blocks(parseMarkdown(doc.conclusion));
  if (doc.nextSteps.length) book.blocks(doc.nextSteps.map((s, i) => ({ t: 'li', ordered: true, n: i + 1, depth: 0, runs: [{ text: s }], check: null })));
  if (doc.website) book.callout([{ text: 'Keep going: ', b: true }, { text: `${doc.tagline ? `${doc.tagline} ` : ''}Find more from ${doc.author} at ${doc.website}.` }]);

  // back cover
  const back = book.addPage('back', '');
  back.drawRectangle({ x: 0, y: 0, width: book.W, height: book.H, color: book.band });
  const name = clean(doc.author);
  const nameSize = 30;
  back.drawText(name, { x: (book.W - fonts.sansBold.widthOfTextAtSize(name, nameSize)) / 2, y: book.H / 2 + 20, size: nameSize, font: fonts.sansBold, color: book.c.onPrimary });
  back.drawRectangle({ x: (book.W - 40) / 2, y: book.H / 2, width: 40, height: 3, color: book.c.accent });
  book.y = book.H / 2 - 18;
  book.page = back;
  if (doc.tagline) book.text([{ text: doc.tagline }], { size: 13, leading: 19, color: book.c.onPrimarySoft, align: 'center', font: () => fonts.sans });
  if (doc.website) {
    const w = clean(doc.website);
    back.drawText(w, { x: (book.W - fonts.sansBold.widthOfTextAtSize(w, 11)) / 2, y: 70, size: 11, font: fonts.sansBold, color: book.c.onPrimary });
  }

  drawToc(book, tocPages, toc);
  addOutline(book, toc);
  decorate(book, doc);
  const bytes = await pdf.save();
  return { bytes, pages: pdf.getPageCount() };
}
