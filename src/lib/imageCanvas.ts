// Canvas compositor for AI images: puts the artwork full-bleed, then adds the parts that
// must be exact (headline, logo, prices, bullet lists, website) as real text, so the final
// PNG/JPEG reads correctly whatever the image model drew.

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { Brand, ImageAspect, StyleId } from './types';
import { darken, readableOn, stripProtocol, withAlpha } from './utils';
import { ART_SIZE } from '@/ai/local/art';
import { LogoMark } from '@/components/brand/Logo';

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the image'));
    img.src = src;
  });
}

export function makeCanvas(aspect: ImageAspect): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; W: number; H: number } {
  const [W, H] = ART_SIZE[aspect];
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser');
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx, W, H };
}

/** Draw an image to fill the box, cropping the overflow (CSS object-fit: cover). */
export function drawCover(ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, x: number, y: number, w: number, h: number) {
  const iw = img.width || w;
  const ih = img.height || h;
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

// ───────────── text ─────────────

export interface FontSpec {
  family: string;
  weight: number;
  italic?: boolean;
  upper?: boolean;
  /** letter spacing in em */
  tracking?: number;
}

const HEADLINE_FONTS: Partial<Record<StyleId, FontSpec>> = {
  neon: { family: 'Anton, Impact, sans-serif', weight: 400, upper: true, tracking: 0.01 },
  editorial: { family: 'Fraunces, Georgia, serif', weight: 700, italic: true },
  handcrafted: { family: 'Caveat, "Comic Sans MS", cursive', weight: 700 },
  isometric: { family: '"JetBrains Mono", ui-monospace, monospace', weight: 700, tracking: -0.02 },
};
export const DISPLAY_FONT: FontSpec = { family: '"Bricolage Grotesque", system-ui, sans-serif', weight: 800, tracking: -0.02 };
export const BODY_FONT: FontSpec = { family: '"Instrument Sans", system-ui, sans-serif', weight: 600 };

export const headlineFont = (style?: StyleId): FontSpec => (style && HEADLINE_FONTS[style]) || DISPLAY_FONT;

const fontCss = (f: FontSpec, size: number) => `${f.italic ? 'italic ' : ''}${f.weight} ${Math.round(size)}px ${f.family}`;

/** Wait (briefly) for the web fonts the compositor uses, so text doesn't render in a fallback face. */
export async function ensureFonts(fonts: FontSpec[]): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts?.load) return;
  const loads = fonts.map((f) => document.fonts.load(fontCss(f, 48)).catch(() => []));
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 2500))]);
}

function applyFont(ctx: CanvasRenderingContext2D, f: FontSpec, size: number) {
  ctx.font = fontCss(f, size);
  // letterSpacing is supported in Chromium and Safari 17+; harmless elsewhere
  (ctx as unknown as { letterSpacing?: string }).letterSpacing = f.tracking ? `${(f.tracking * size).toFixed(1)}px` : '0px';
}

/** Greedy word wrap; words longer than a line are kept whole (the size search shrinks them). */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\n+/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (line && ctx.measureText(test).width > maxWidth) {
        lines.push(line);
        line = w;
      } else line = test;
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Largest font size (from `max` down to `min`) where the text fits the box in `maxLines` lines. */
export function fitText(ctx: CanvasRenderingContext2D, raw: string, f: FontSpec, box: { width: number; height: number; maxLines: number; max: number; min: number; lineHeight?: number }) {
  const text = f.upper ? raw.toUpperCase() : raw;
  const lh = box.lineHeight ?? 1.08;
  for (let size = box.max; size >= box.min; size -= Math.max(1, Math.round(box.max / 40))) {
    applyFont(ctx, f, size);
    const lines = wrapText(ctx, text, box.width);
    const widest = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
    if (lines.length <= box.maxLines && lines.length * size * lh <= box.height && widest <= box.width) return { lines, size, lineHeight: size * lh };
  }
  applyFont(ctx, f, box.min);
  let lines = wrapText(ctx, text, box.width);
  if (lines.length > box.maxLines) {
    lines = lines.slice(0, box.maxLines);
    let last = lines[box.maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > box.width) last = last.slice(0, -1);
    lines[box.maxLines - 1] = `${last.trimEnd()}…`;
  }
  return { lines, size: box.min, lineHeight: box.min * lh };
}

function drawLines(ctx: CanvasRenderingContext2D, lines: string[], x: number, y: number, lineHeight: number, align: CanvasTextAlign = 'left') {
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ───────────── brand pieces ─────────────

/** The brand's logo mark as an image (uploaded logo, or the generated mark rendered to SVG). */
export async function logoImage(brand: Brand): Promise<HTMLImageElement | null> {
  try {
    if (brand.logo.mode === 'upload' && brand.logo.uploadDataUrl) return await loadImage(brand.logo.uploadDataUrl);
    const host = document.createElement('div');
    const root = createRoot(host);
    flushSync(() => root.render(createElement(LogoMark, { colors: brand.colors, logo: brand.logo, name: brand.name, size: 256 })));
    const svg = host.querySelector('svg');
    const xml = svg ? new XMLSerializer().serializeToString(svg) : '';
    root.unmount();
    if (!xml) return null;
    return await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`);
  } catch {
    return null;
  }
}

function brandChip(ctx: CanvasRenderingContext2D, logo: HTMLImageElement | null, name: string, x: number, y: number, size: number, color: string) {
  let tx = x;
  if (logo) {
    ctx.drawImage(logo, x, y, size, size);
    tx = x + size * 1.25;
  }
  if (name) {
    applyFont(ctx, { family: '"Bricolage Grotesque", system-ui, sans-serif', weight: 700 }, size * 0.5);
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(name.slice(0, 32), tx, y + size / 2);
  }
}

function websitePill(ctx: CanvasRenderingContext2D, url: string, W: number, H: number) {
  const size = W * 0.026;
  applyFont(ctx, BODY_FONT, size);
  const tw = ctx.measureText(url).width;
  const padX = size * 0.9;
  const h = size * 2;
  const x = W - W * 0.04 - tw - padX * 2;
  const y = H - W * 0.04 - h;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  roundRect(ctx, x, y, tw + padX * 2, h, h / 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(url, x + padX, y + h / 2 + 1);
}

export function brandUrl(brand: Brand): string {
  return stripProtocol(brand.websiteUrl || (brand.slug ? `${brand.slug}.com` : ''));
}

// ───────────── social post ─────────────

export interface PostComposeOptions {
  art: HTMLImageElement;
  brand: Brand;
  aspect: ImageAspect;
  headline: string;
  style?: StyleId;
  /** headline + brand name on the image */
  overlay: boolean;
  watermark: boolean;
}

export async function composePost(o: PostComposeOptions): Promise<HTMLCanvasElement> {
  const { canvas, ctx, W, H } = makeCanvas(o.aspect);
  ctx.fillStyle = o.brand.colors.paper || '#ffffff'; // under any transparent parts of the artwork
  ctx.fillRect(0, 0, W, H);
  drawCover(ctx, o.art, 0, 0, W, H);
  const pad = Math.round(Math.min(W, H) * 0.07);
  const wide = W / H > 1.2;
  if (o.overlay && o.headline.trim()) {
    const font = headlineFont(o.style);
    await ensureFonts([font, DISPLAY_FONT]);
    // legibility scrims: a gentle one at the top for the brand, a stronger one under the headline
    const top = ctx.createLinearGradient(0, 0, 0, H * 0.2);
    top.addColorStop(0, 'rgba(0,0,0,0.38)');
    top.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, W, H * 0.2);
    const startY = wide ? H * 0.25 : H * 0.42;
    const bottom = ctx.createLinearGradient(0, startY, 0, H);
    bottom.addColorStop(0, 'rgba(0,0,0,0)');
    bottom.addColorStop(0.55, 'rgba(0,0,0,0.5)');
    bottom.addColorStop(1, 'rgba(0,0,0,0.78)');
    ctx.fillStyle = bottom;
    ctx.fillRect(0, startY, W, H - startY);

    const logo = await logoImage(o.brand);
    brandChip(ctx, logo, o.brand.name, pad, pad, Math.min(W, H) * 0.075, '#ffffff');

    const reserve = o.watermark && brandUrl(o.brand) ? Math.min(W, H) * 0.09 : 0;
    const boxW = W - pad * 2 - (wide ? W * 0.3 : 0);
    const boxH = (wide ? H * 0.5 : H * 0.36) - reserve * 0.3;
    const fit = fitText(ctx, o.headline.trim(), font, { width: boxW, height: boxH, maxLines: wide ? 3 : 4, max: Math.round(Math.min(W, H) * (wide ? 0.1 : 0.095)), min: Math.round(Math.min(W, H) * 0.045) });
    applyFont(ctx, font, fit.size);
    const blockH = fit.lines.length * fit.lineHeight;
    const baseY = H - pad - reserve - blockH + fit.size * 0.86;
    // accent bar
    ctx.fillStyle = o.brand.colors.accent;
    roundRect(ctx, pad, baseY - fit.size * 0.86 - Math.min(W, H) * 0.045, Math.min(W, H) * 0.12, Math.min(W, H) * 0.012, Math.min(W, H) * 0.006);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = fit.size * 0.18;
    ctx.shadowOffsetY = fit.size * 0.04;
    drawLines(ctx, fit.lines, pad, baseY, fit.lineHeight);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }
  const url = brandUrl(o.brand);
  if (o.watermark && url) {
    await ensureFonts([BODY_FONT]);
    websitePill(ctx, url, W, H);
  }
  return canvas;
}

// ───────────── marketplace listing graphics ─────────────

export type ListingLayout = 'clean' | 'inside' | 'offer';

export interface ListingText {
  eyebrow: string;
  title: string;
  tagline?: string;
  items?: string[];
  price?: string;
  compareAt?: string;
  cta?: string;
}

export interface ListingComposeOptions {
  art: HTMLImageElement;
  brand: Brand;
  aspect: ImageAspect;
  layout: ListingLayout;
  text: ListingText;
}

function checkIcon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = r * 0.28;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x - r * 0.42, y + r * 0.02);
  ctx.lineTo(x - r * 0.1, y + r * 0.34);
  ctx.lineTo(x + r * 0.45, y - r * 0.3);
  ctx.stroke();
}

export async function composeListing(o: ListingComposeOptions): Promise<HTMLCanvasElement> {
  const { canvas, ctx, W, H } = makeCanvas(o.aspect);
  ctx.fillStyle = o.brand.colors.paper || '#ffffff';
  ctx.fillRect(0, 0, W, H);
  drawCover(ctx, o.art, 0, 0, W, H);
  if (o.layout === 'clean') return canvas;
  const c = o.brand.colors;
  const S = Math.min(W, H);
  await ensureFonts([DISPLAY_FONT, BODY_FONT, { ...BODY_FONT, weight: 500 }]);
  const logo = await logoImage(o.brand);

  if (o.layout === 'inside') {
    const m = S * 0.07;
    const px = m;
    const py = m;
    const pw = W - m * 2;
    const ph = H - m * 2;
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = S * 0.05;
    ctx.shadowOffsetY = S * 0.012;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    roundRect(ctx, px, py, pw, ph, S * 0.035);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    const ip = S * 0.065;
    let y = py + ip;
    const ink = darken(c.ink, 0.1);
    // eyebrow
    applyFont(ctx, { ...BODY_FONT, weight: 700, tracking: 0.14 }, S * 0.026);
    ctx.fillStyle = c.primary;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(o.text.eyebrow.toUpperCase(), px + ip, y);
    y += S * 0.05;
    const title = fitText(ctx, o.text.title, DISPLAY_FONT, { width: pw - ip * 2, height: S * 0.16, maxLines: 2, max: Math.round(S * 0.062), min: Math.round(S * 0.038) });
    applyFont(ctx, DISPLAY_FONT, title.size);
    ctx.fillStyle = ink;
    ctx.textBaseline = 'top';
    title.lines.forEach((l, i) => ctx.fillText(l, px + ip, y + i * title.lineHeight));
    y += title.lines.length * title.lineHeight + S * 0.03;
    ctx.fillStyle = withAlpha(c.ink, 0.12);
    ctx.fillRect(px + ip, y, pw - ip * 2, Math.max(2, S * 0.003));
    y += S * 0.04;
    const items = (o.text.items ?? []).filter(Boolean).slice(0, 6);
    const footer = S * 0.12;
    const avail = py + ph - ip - footer - y;
    const row = Math.min(S * 0.085, avail / Math.max(1, items.length));
    const itemSize = Math.max(S * 0.024, Math.min(S * 0.034, row * 0.42));
    items.forEach((it, i) => {
      const cy = y + i * row + row * 0.38;
      checkIcon(ctx, px + ip + itemSize * 0.75, cy, itemSize * 0.75, c.primary, readableOn(c.primary));
      const fit = fitText(ctx, it, { ...BODY_FONT, weight: 600 }, { width: pw - ip * 2 - itemSize * 2.4, height: row * 0.9, maxLines: 2, max: Math.round(itemSize), min: Math.round(itemSize * 0.75), lineHeight: 1.18 });
      applyFont(ctx, { ...BODY_FONT, weight: 600 }, fit.size);
      ctx.fillStyle = ink;
      ctx.textBaseline = 'middle';
      const startY = cy - ((fit.lines.length - 1) * fit.lineHeight) / 2;
      fit.lines.forEach((l, k) => ctx.fillText(l, px + ip + itemSize * 2.1, startY + k * fit.lineHeight));
    });
    // footer: logo + brand, price on the right
    const fy = py + ph - ip - footer * 0.45;
    brandChip(ctx, logo, o.brand.name, px + ip, fy - S * 0.03, S * 0.06, ink);
    if (o.text.price) {
      applyFont(ctx, DISPLAY_FONT, S * 0.042);
      ctx.fillStyle = c.primary;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(o.text.price, px + pw - ip, fy);
    }
    return canvas;
  }

  // offer card
  const shade = ctx.createLinearGradient(0, 0, 0, H);
  shade.addColorStop(0, withAlpha(darken(c.secondary, 0.55), 0.62));
  shade.addColorStop(1, withAlpha(darken(c.primary, 0.6), 0.86));
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, W, H);
  const cx = W / 2;
  let y = S * 0.1;
  if (logo) {
    const ls = S * 0.1;
    ctx.drawImage(logo, cx - ls / 2, y, ls, ls);
    y += ls + S * 0.04;
  }
  applyFont(ctx, { ...BODY_FONT, weight: 700, tracking: 0.16 }, S * 0.026);
  ctx.fillStyle = c.accent;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(o.text.eyebrow.toUpperCase(), cx, y);
  y += S * 0.06;
  const title = fitText(ctx, o.text.title, DISPLAY_FONT, { width: W * 0.82, height: S * 0.26, maxLines: 3, max: Math.round(S * 0.085), min: Math.round(S * 0.045) });
  applyFont(ctx, DISPLAY_FONT, title.size);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  title.lines.forEach((l, i) => ctx.fillText(l, cx, y + i * title.lineHeight));
  y += title.lines.length * title.lineHeight + S * 0.03;
  if (o.text.tagline) {
    const tag = fitText(ctx, o.text.tagline, { ...BODY_FONT, weight: 500 }, { width: W * 0.74, height: S * 0.1, maxLines: 2, max: Math.round(S * 0.032), min: Math.round(S * 0.024), lineHeight: 1.3 });
    applyFont(ctx, { ...BODY_FONT, weight: 500 }, tag.size);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    tag.lines.forEach((l, i) => ctx.fillText(l, cx, y + i * tag.lineHeight));
    y += tag.lines.length * tag.lineHeight + S * 0.05;
  }
  if (o.text.price) {
    applyFont(ctx, DISPLAY_FONT, S * 0.11);
    const pw = ctx.measureText(o.text.price).width;
    let cmpW = 0;
    if (o.text.compareAt) {
      applyFont(ctx, { ...BODY_FONT, weight: 600 }, S * 0.045);
      cmpW = ctx.measureText(o.text.compareAt).width + S * 0.03;
    }
    const total = pw + cmpW;
    const left = cx - total / 2;
    applyFont(ctx, DISPLAY_FONT, S * 0.11);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const base = y + S * 0.1;
    ctx.fillText(o.text.price, left, base);
    if (o.text.compareAt) {
      applyFont(ctx, { ...BODY_FONT, weight: 600 }, S * 0.045);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      const x0 = left + pw + S * 0.03;
      ctx.fillText(o.text.compareAt, x0, base - S * 0.012);
      ctx.fillRect(x0, base - S * 0.028, ctx.measureText(o.text.compareAt).width, Math.max(2, S * 0.004));
    }
    y = base + S * 0.06;
  }
  if (o.text.cta) {
    applyFont(ctx, { ...BODY_FONT, weight: 700 }, S * 0.036);
    const tw = ctx.measureText(o.text.cta).width;
    const bh = S * 0.095;
    const bw = tw + S * 0.12;
    const by = Math.min(y, H - S * 0.08 - bh);
    ctx.fillStyle = c.accent;
    roundRect(ctx, cx - bw / 2, by, bw, bh, bh / 2);
    ctx.fill();
    ctx.fillStyle = readableOn(c.accent);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(o.text.cta, cx, by + bh / 2 + 1);
  }
  return canvas;
}

// ───────────── export ─────────────

export function canvasBlob(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg', quality = 0.9): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not export the image'))), type, quality);
    } catch (e) {
      reject(e);
    }
  });
}

/** Small JPEG preview for lists (≈ 20 KB). */
export function canvasThumb(canvas: HTMLCanvasElement, max = 360): string {
  const scale = Math.min(1, max / Math.max(canvas.width, canvas.height));
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(canvas.width * scale));
  t.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = t.getContext('2d');
  if (!ctx) return '';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.76);
}
