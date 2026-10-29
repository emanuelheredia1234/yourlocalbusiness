// Built-in brand illustrations: deterministic vector scenes in the project's colors.
// Used when Claude isn't available (and as the backdrop for text-led listing graphics).
// Every scene is plain shapes and gradients: no text, no external references.

import type { BrandColors, ImageAspect, ProductFormat, Project, StyleId } from '@/lib/types';
import { darken, lighten, mix, mulberry32 } from '@/lib/utils';

/** Output pixel size for each aspect (social sizes follow each platform's recommended upload). */
export const ART_SIZE: Record<ImageAspect, [number, number]> = {
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
  '9:16': [1080, 1920],
  '1.91:1': [1200, 628],
  '3:2': [1200, 800],
  '21:8': [1600, 610],
};

export type ArtScene = 'pedestal' | 'device' | 'book' | 'storefront' | 'desk' | 'people' | 'neon' | 'iso' | 'paper' | 'soft';

export interface ArtOptions {
  aspect: ImageAspect;
  scene: ArtScene;
  seed: number;
}

const n = (v: number) => Math.round(v * 10) / 10;

/** The scene that best fits a social post style. */
export function sceneForStyle(style: StyleId, project: Project): ArtScene {
  switch (style) {
    case 'neon':
      return 'neon';
    case 'isometric':
      return 'iso';
    case 'handcrafted':
      return 'paper';
    case 'editorial':
      return project.track === 'business' ? 'people' : 'desk';
    default:
      return heroScene(project);
  }
}

const DEVICE_FORMATS: ProductFormat[] = ['software', 'course', 'template', 'spreadsheet', 'membership', 'design', 'audio'];

/** The scene for a product's hero shot. */
export function heroScene(project: Project): ArtScene {
  if (project.track === 'business') return 'storefront';
  if (project.format === 'pdf' || project.format === 'ebook') return 'book';
  if (project.format && DEVICE_FORMATS.includes(project.format)) return 'device';
  return 'pedestal';
}

export function proceduralSvg(colors: BrandColors, opts: ArtOptions): string {
  const [W, H] = ART_SIZE[opts.aspect];
  const rnd = mulberry32(opts.seed || 1);
  const c = colors;
  const dark = opts.scene === 'neon' || opts.scene === 'iso';
  const s = Math.min(W, H); // scene scale
  const cx = W / 2;
  const cy = H * (opts.scene === 'soft' ? 0.5 : 0.46);
  const defs: string[] = [];
  const parts: string[] = [];

  // background
  const bgA = dark ? darken(c.secondary, 0.55) : opts.scene === 'paper' ? mix('#fbf3e3', c.accent, 0.08) : lighten(c.primary, 0.86);
  const bgB = dark ? darken(c.primary, 0.62) : opts.scene === 'paper' ? mix('#f6ead2', c.primary, 0.06) : lighten(c.accent, 0.78);
  defs.push(`<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bgA}"/><stop offset="1" stop-color="${bgB}"/></linearGradient>`);
  parts.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`);

  // soft color fields
  defs.push(`<radialGradient id="glowA"><stop offset="0" stop-color="${dark ? c.accent : '#ffffff'}" stop-opacity="${dark ? 0.45 : 0.7}"/><stop offset="1" stop-color="${dark ? c.accent : '#ffffff'}" stop-opacity="0"/></radialGradient>`);
  defs.push(`<radialGradient id="glowB"><stop offset="0" stop-color="${c.primary}" stop-opacity="${dark ? 0.55 : 0.28}"/><stop offset="1" stop-color="${c.primary}" stop-opacity="0"/></radialGradient>`);
  parts.push(`<circle cx="${n(W * (0.75 + rnd() * 0.15))}" cy="${n(H * (0.12 + rnd() * 0.15))}" r="${n(s * 0.55)}" fill="url(#glowA)"/>`);
  parts.push(`<circle cx="${n(W * (0.05 + rnd() * 0.2))}" cy="${n(H * (0.8 + rnd() * 0.15))}" r="${n(s * 0.6)}" fill="url(#glowB)"/>`);

  if (opts.scene === 'neon') {
    const step = s / 12;
    const lines: string[] = [];
    for (let x = 0; x <= W; x += step) lines.push(`M${n(x)} 0V${H}`);
    for (let y = 0; y <= H; y += step) lines.push(`M0 ${n(y)}H${W}`);
    parts.push(`<path d="${lines.join('')}" stroke="#ffffff" stroke-opacity="0.07" stroke-width="2"/>`);
  } else if (opts.scene === 'paper') {
    const dots: string[] = [];
    const step = s / 30;
    for (let y = step; y < H; y += step) for (let x = step; x < W; x += step) dots.push(`M${n(x)} ${n(y)}h0.01`);
    parts.push(`<path d="${dots.join('')}" stroke="${c.ink}" stroke-opacity="0.12" stroke-width="${n(s / 260)}" stroke-linecap="round"/>`);
  } else {
    for (let i = 0; i < 6; i++) {
      const r = s * (0.04 + rnd() * 0.09);
      parts.push(`<circle cx="${n(rnd() * W)}" cy="${n(rnd() * H)}" r="${n(r)}" fill="${i % 2 ? c.accent : dark ? c.primary : '#ffffff'}" opacity="${n(0.12 + rnd() * 0.18)}"/>`);
    }
  }

  const shadow = (x: number, y: number, rx: number, ry: number) => parts.push(`<ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(rx)}" ry="${n(ry)}" fill="${c.ink}" opacity="${dark ? 0.45 : 0.16}"/>`);
  defs.push(`<linearGradient id="hero" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${lighten(c.primary, 0.08)}"/><stop offset="1" stop-color="${darken(c.secondary, 0.12)}"/></linearGradient>`);
  defs.push(`<linearGradient id="hero2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${lighten(c.accent, 0.1)}"/><stop offset="1" stop-color="${darken(c.accent, 0.15)}"/></linearGradient>`);

  // UI blocks drawn inside a screen or card
  const ui = (x: number, y: number, w: number, h: number) => {
    const p = w * 0.07;
    parts.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h * 0.14)}" fill="${c.primary}"/>`);
    parts.push(`<circle cx="${n(x + p)}" cy="${n(y + h * 0.07)}" r="${n(h * 0.035)}" fill="#ffffff" opacity="0.85"/>`);
    parts.push(`<rect x="${n(x + p * 2)}" y="${n(y + h * 0.055)}" width="${n(w * 0.3)}" height="${n(h * 0.03)}" rx="${n(h * 0.015)}" fill="#ffffff" opacity="0.7"/>`);
    const cardW = (w - p * 3) / 2;
    for (let i = 0; i < 2; i++) {
      const cx2 = x + p + i * (cardW + p);
      parts.push(`<rect x="${n(cx2)}" y="${n(y + h * 0.22)}" width="${n(cardW)}" height="${n(h * 0.3)}" rx="${n(h * 0.03)}" fill="${i ? lighten(c.accent, 0.55) : lighten(c.primary, 0.75)}"/>`);
      parts.push(`<rect x="${n(cx2 + p * 0.5)}" y="${n(y + h * 0.28)}" width="${n(cardW * 0.5)}" height="${n(h * 0.04)}" rx="${n(h * 0.02)}" fill="${i ? darken(c.accent, 0.3) : c.primary}" opacity="0.8"/>`);
      parts.push(`<rect x="${n(cx2 + p * 0.5)}" y="${n(y + h * 0.36)}" width="${n(cardW * 0.7)}" height="${n(h * 0.03)}" rx="${n(h * 0.015)}" fill="${c.ink}" opacity="0.18"/>`);
    }
    const bars = 6;
    const bw = (w - p * 2) / (bars * 1.6);
    for (let i = 0; i < bars; i++) {
      const bh = h * (0.12 + ((i * 37 + opts.seed) % 23) / 100);
      parts.push(`<rect x="${n(x + p + i * bw * 1.6)}" y="${n(y + h * 0.92 - bh)}" width="${n(bw)}" height="${n(bh)}" rx="${n(bw * 0.25)}" fill="${i % 2 ? c.accent : c.primary}" opacity="${i % 2 ? 0.9 : 0.75}"/>`);
    }
  };

  switch (opts.scene) {
    case 'device': {
      const lw = s * 0.62;
      const lh = lw * 0.62;
      const lx = cx - lw / 2 - s * 0.05;
      const ly = cy - lh / 2;
      shadow(cx, ly + lh + s * 0.07, lw * 0.62, s * 0.035);
      parts.push(`<rect x="${n(lx - s * 0.015)}" y="${n(ly - s * 0.015)}" width="${n(lw + s * 0.03)}" height="${n(lh + s * 0.03)}" rx="${n(s * 0.025)}" fill="${darken(c.ink, 0.2)}"/>`);
      parts.push(`<rect x="${n(lx)}" y="${n(ly)}" width="${n(lw)}" height="${n(lh)}" rx="${n(s * 0.01)}" fill="#ffffff"/>`);
      ui(lx, ly, lw, lh);
      parts.push(`<path d="M${n(lx - s * 0.07)} ${n(ly + lh + s * 0.015)}H${n(lx + lw + s * 0.07)}L${n(lx + lw + s * 0.03)} ${n(ly + lh + s * 0.055)}H${n(lx - s * 0.03)}Z" fill="${mix(c.ink, '#9aa3ad', 0.6)}"/>`);
      // phone
      const pw = s * 0.17;
      const ph = pw * 2;
      const px = lx + lw - pw * 0.35;
      const py = ly + lh - ph * 0.72;
      parts.push(`<rect x="${n(px)}" y="${n(py)}" width="${n(pw)}" height="${n(ph)}" rx="${n(pw * 0.16)}" fill="${darken(c.ink, 0.2)}"/>`);
      parts.push(`<rect x="${n(px + pw * 0.07)}" y="${n(py + pw * 0.12)}" width="${n(pw * 0.86)}" height="${n(ph - pw * 0.24)}" rx="${n(pw * 0.1)}" fill="url(#hero)"/>`);
      parts.push(`<circle cx="${n(px + pw / 2)}" cy="${n(py + ph * 0.35)}" r="${n(pw * 0.22)}" fill="#ffffff" opacity="0.9"/>`);
      parts.push(`<rect x="${n(px + pw * 0.2)}" y="${n(py + ph * 0.6)}" width="${n(pw * 0.6)}" height="${n(pw * 0.08)}" rx="${n(pw * 0.04)}" fill="#ffffff" opacity="0.75"/>`);
      parts.push(`<rect x="${n(px + pw * 0.2)}" y="${n(py + ph * 0.7)}" width="${n(pw * 0.6)}" height="${n(pw * 0.16)}" rx="${n(pw * 0.08)}" fill="${c.accent}"/>`);
      break;
    }
    case 'book': {
      const bw = s * 0.36;
      const bh = bw * 1.38;
      const bx = cx - bw / 2;
      const by = cy - bh / 2;
      shadow(cx + bw * 0.08, by + bh + s * 0.02, bw * 0.75, s * 0.03);
      // second book behind
      parts.push(`<g transform="rotate(-8 ${n(cx)} ${n(cy)})"><rect x="${n(bx - bw * 0.42)}" y="${n(by + bh * 0.05)}" width="${n(bw)}" height="${n(bh)}" rx="${n(bw * 0.03)}" fill="url(#hero2)"/><rect x="${n(bx - bw * 0.3)}" y="${n(by + bh * 0.2)}" width="${n(bw * 0.6)}" height="${n(bw * 0.06)}" rx="${n(bw * 0.03)}" fill="#ffffff" opacity="0.7"/></g>`);
      parts.push(`<rect x="${n(bx + bw * 0.04)}" y="${n(by + bh * 0.02)}" width="${n(bw)}" height="${n(bh)}" rx="${n(bw * 0.03)}" fill="#f4f1ea"/>`);
      parts.push(`<rect x="${n(bx)}" y="${n(by)}" width="${n(bw)}" height="${n(bh)}" rx="${n(bw * 0.03)}" fill="url(#hero)"/>`);
      parts.push(`<rect x="${n(bx)}" y="${n(by)}" width="${n(bw * 0.07)}" height="${n(bh)}" fill="${darken(c.secondary, 0.35)}" opacity="0.55"/>`);
      parts.push(`<circle cx="${n(bx + bw * 0.55)}" cy="${n(by + bh * 0.36)}" r="${n(bw * 0.2)}" fill="${c.accent}" opacity="0.95"/>`);
      parts.push(`<circle cx="${n(bx + bw * 0.55)}" cy="${n(by + bh * 0.36)}" r="${n(bw * 0.11)}" fill="#ffffff" opacity="0.9"/>`);
      for (let i = 0; i < 3; i++) parts.push(`<rect x="${n(bx + bw * 0.2)}" y="${n(by + bh * (0.64 + i * 0.07))}" width="${n(bw * (i ? 0.5 : 0.66))}" height="${n(bw * 0.045)}" rx="${n(bw * 0.022)}" fill="#ffffff" opacity="${i ? 0.6 : 0.9}"/>`);
      break;
    }
    case 'storefront': {
      const fw = s * 0.66;
      const fh = fw * 0.72;
      const fx = cx - fw / 2;
      const fy = cy - fh / 2 + s * 0.04;
      shadow(cx, fy + fh + s * 0.012, fw * 0.6, s * 0.022);
      parts.push(`<rect x="${n(fx)}" y="${n(fy)}" width="${n(fw)}" height="${n(fh)}" rx="${n(s * 0.012)}" fill="${lighten(c.paper || '#ffffff', 0.4)}"/>`);
      parts.push(`<rect x="${n(fx)}" y="${n(fy)}" width="${n(fw)}" height="${n(fh * 0.2)}" fill="url(#hero)"/>`);
      parts.push(`<rect x="${n(fx + fw * 0.25)}" y="${n(fy + fh * 0.05)}" width="${n(fw * 0.5)}" height="${n(fh * 0.1)}" rx="${n(fh * 0.05)}" fill="#ffffff" opacity="0.9"/>`);
      // striped awning
      const stripes = 8;
      const sw = (fw + s * 0.04) / stripes;
      for (let i = 0; i < stripes; i++) {
        const x0 = fx - s * 0.02 + i * sw;
        parts.push(`<path d="M${n(x0)} ${n(fy + fh * 0.2)}H${n(x0 + sw)}V${n(fy + fh * 0.32)}Q${n(x0 + sw / 2)} ${n(fy + fh * 0.4)} ${n(x0)} ${n(fy + fh * 0.32)}Z" fill="${i % 2 ? '#ffffff' : c.accent}"/>`);
      }
      // windows + door
      const wy = fy + fh * 0.46;
      parts.push(`<rect x="${n(fx + fw * 0.07)}" y="${n(wy)}" width="${n(fw * 0.36)}" height="${n(fh * 0.38)}" rx="${n(s * 0.01)}" fill="${lighten(c.secondary, 0.55)}"/>`);
      parts.push(`<path d="M${n(fx + fw * 0.1)} ${n(wy + fh * 0.33)}L${n(fx + fw * 0.2)} ${n(wy + fh * 0.04)}" stroke="#ffffff" stroke-width="${n(s * 0.012)}" opacity="0.6" stroke-linecap="round"/>`);
      parts.push(`<rect x="${n(fx + fw * 0.55)}" y="${n(wy - fh * 0.04)}" width="${n(fw * 0.22)}" height="${n(fh * 0.58)}" rx="${n(s * 0.008)}" fill="${darken(c.primary, 0.25)}"/>`);
      parts.push(`<circle cx="${n(fx + fw * 0.73)}" cy="${n(wy + fh * 0.26)}" r="${n(s * 0.008)}" fill="${c.accent}"/>`);
      parts.push(`<rect x="${n(fx + fw * 0.82)}" y="${n(wy)}" width="${n(fw * 0.12)}" height="${n(fh * 0.2)}" rx="${n(s * 0.008)}" fill="${lighten(c.secondary, 0.55)}"/>`);
      // plants
      for (const px of [fx - s * 0.03, fx + fw + s * 0.03]) {
        parts.push(`<rect x="${n(px - s * 0.035)}" y="${n(fy + fh - s * 0.06)}" width="${n(s * 0.07)}" height="${n(s * 0.06)}" rx="${n(s * 0.008)}" fill="${darken(c.accent, 0.2)}"/>`);
        parts.push(`<ellipse cx="${n(px)}" cy="${n(fy + fh - s * 0.1)}" rx="${n(s * 0.045)}" ry="${n(s * 0.06)}" fill="${mix('#3f8f5a', c.primary, 0.2)}"/>`);
      }
      break;
    }
    case 'desk': {
      const ty = cy + s * 0.2;
      parts.push(`<rect x="0" y="${n(ty)}" width="${W}" height="${n(H - ty)}" fill="${mix(lighten(c.accent, 0.6), '#d9c4a5', 0.45)}"/>`);
      parts.push(`<rect x="0" y="${n(ty)}" width="${W}" height="${n(s * 0.012)}" fill="#ffffff" opacity="0.5"/>`);
      // laptop (open, small)
      const lw = s * 0.44;
      const lh = lw * 0.6;
      const lx = cx - lw * 0.7;
      const ly = ty - lh - s * 0.02;
      parts.push(`<rect x="${n(lx)}" y="${n(ly)}" width="${n(lw)}" height="${n(lh)}" rx="${n(s * 0.012)}" fill="${darken(c.ink, 0.2)}"/>`);
      parts.push(`<rect x="${n(lx + s * 0.012)}" y="${n(ly + s * 0.012)}" width="${n(lw - s * 0.024)}" height="${n(lh - s * 0.024)}" fill="#ffffff"/>`);
      ui(lx + s * 0.012, ly + s * 0.012, lw - s * 0.024, lh - s * 0.024);
      parts.push(`<rect x="${n(lx - s * 0.04)}" y="${n(ty - s * 0.022)}" width="${n(lw + s * 0.08)}" height="${n(s * 0.022)}" rx="${n(s * 0.01)}" fill="${mix(c.ink, '#9aa3ad', 0.6)}"/>`);
      // mug
      const mx = cx + s * 0.2;
      parts.push(`<path d="M${n(mx + s * 0.07)} ${n(ty - s * 0.1)}a${n(s * 0.035)} ${n(s * 0.035)} 0 1 1 0 ${n(s * 0.07)}" fill="none" stroke="${c.primary}" stroke-width="${n(s * 0.014)}"/>`);
      parts.push(`<rect x="${n(mx - s * 0.02)}" y="${n(ty - s * 0.13)}" width="${n(s * 0.1)}" height="${n(s * 0.13)}" rx="${n(s * 0.014)}" fill="${c.primary}"/>`);
      parts.push(`<path d="M${n(mx + s * 0.01)} ${n(ty - s * 0.16)}q${n(s * 0.015)} ${n(-s * 0.03)} 0 ${n(-s * 0.06)}M${n(mx + s * 0.05)} ${n(ty - s * 0.16)}q${n(s * 0.015)} ${n(-s * 0.03)} 0 ${n(-s * 0.06)}" stroke="${c.ink}" stroke-opacity="0.25" stroke-width="${n(s * 0.006)}" fill="none" stroke-linecap="round"/>`);
      // plant
      const px = cx + s * 0.36;
      for (let i = 0; i < 5; i++) {
        const a = -70 + i * 35;
        parts.push(`<ellipse cx="${n(px)}" cy="${n(ty - s * 0.2)}" rx="${n(s * 0.022)}" ry="${n(s * 0.075)}" fill="${mix('#3f8f5a', c.secondary, 0.15)}" transform="rotate(${a} ${n(px)} ${n(ty - s * 0.13)})"/>`);
      }
      parts.push(`<path d="M${n(px - s * 0.05)} ${n(ty - s * 0.12)}H${n(px + s * 0.05)}L${n(px + s * 0.038)} ${n(ty)}H${n(px - s * 0.038)}Z" fill="${c.accent}"/>`);
      // notebook
      parts.push(`<g transform="rotate(-6 ${n(cx - s * 0.05)} ${n(ty + s * 0.12)})"><rect x="${n(cx - s * 0.2)}" y="${n(ty + s * 0.06)}" width="${n(s * 0.3)}" height="${n(s * 0.13)}" rx="${n(s * 0.01)}" fill="#ffffff"/><rect x="${n(cx - s * 0.2)}" y="${n(ty + s * 0.06)}" width="${n(s * 0.03)}" height="${n(s * 0.13)}" fill="${c.secondary}"/><rect x="${n(cx - s * 0.14)}" y="${n(ty + s * 0.1)}" width="${n(s * 0.18)}" height="${n(s * 0.012)}" rx="${n(s * 0.006)}" fill="${c.ink}" opacity="0.2"/></g>`);
      break;
    }
    case 'people': {
      const py = cy + s * 0.08;
      shadow(cx, py + s * 0.26, s * 0.4, s * 0.03);
      const person = (x: number, scale: number, shirt: string, skin: string) => {
        parts.push(`<path d="M${n(x - s * 0.13 * scale)} ${n(py + s * 0.26)}V${n(py + s * 0.08)}a${n(s * 0.13 * scale)} ${n(s * 0.13 * scale)} 0 0 1 ${n(s * 0.26 * scale)} 0V${n(py + s * 0.26)}Z" fill="${shirt}"/>`);
        parts.push(`<circle cx="${n(x)}" cy="${n(py - s * 0.1 * scale)}" r="${n(s * 0.085 * scale)}" fill="${skin}"/>`);
        parts.push(`<path d="M${n(x - s * 0.085 * scale)} ${n(py - s * 0.11 * scale)}a${n(s * 0.085 * scale)} ${n(s * 0.085 * scale)} 0 0 1 ${n(s * 0.17 * scale)} 0q${n(-s * 0.06 * scale)} ${n(-s * 0.04 * scale)} ${n(-s * 0.17 * scale)} 0Z" fill="${darken(c.ink, 0.1)}" opacity="0.85"/>`);
      };
      person(cx - s * 0.17, 0.92, c.primary, '#e9b48f');
      person(cx + s * 0.17, 1, c.accent, '#a8714f');
      // rating card
      const kx = cx - s * 0.16;
      const ky = cy - s * 0.38;
      parts.push(`<rect x="${n(kx)}" y="${n(ky)}" width="${n(s * 0.32)}" height="${n(s * 0.1)}" rx="${n(s * 0.03)}" fill="#ffffff"/>`);
      for (let i = 0; i < 5; i++) {
        const sx = kx + s * 0.045 + i * s * 0.058;
        const sy = ky + s * 0.05;
        const r = s * 0.022;
        const pts = Array.from({ length: 10 }, (_, k) => {
          const ang = -Math.PI / 2 + (k * Math.PI) / 5;
          const rr = k % 2 ? r * 0.45 : r;
          return `${n(sx + rr * Math.cos(ang))},${n(sy + rr * Math.sin(ang))}`;
        }).join(' ');
        parts.push(`<polygon points="${pts}" fill="${c.accent}"/>`);
      }
      break;
    }
    case 'neon': {
      const r = s * 0.24;
      parts.push(`<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${n(s * 0.018)}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`);
      parts.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="none" stroke="${c.accent}" stroke-width="${n(s * 0.018)}" filter="url(#glow)"/>`);
      parts.push(`<rect x="${n(cx - r * 0.8)}" y="${n(cy - r * 0.8)}" width="${n(r * 1.6)}" height="${n(r * 1.6)}" rx="${n(r * 0.2)}" fill="none" stroke="${lighten(c.primary, 0.3)}" stroke-width="${n(s * 0.012)}" transform="rotate(45 ${n(cx)} ${n(cy)})" filter="url(#glow)"/>`);
      parts.push(`<path d="M${n(cx - r * 0.35)} ${n(cy + r * 0.05)}l${n(r * 0.25)} ${n(r * 0.25)} ${n(r * 0.45)} ${n(-r * 0.5)}" fill="none" stroke="#ffffff" stroke-width="${n(s * 0.02)}" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>`);
      break;
    }
    case 'iso': {
      const t = s * 0.2;
      const tile = (x: number, y: number, h: number, top: string, left: string, right: string) => {
        parts.push(`<path d="M${n(x)} ${n(y - h)}l${n(t)} ${n(-t * 0.58)} ${n(t)} ${n(t * 0.58)} ${n(-t)} ${n(t * 0.58)}Z" fill="${top}"/>`);
        parts.push(`<path d="M${n(x)} ${n(y - h)}l${n(t)} ${n(t * 0.58)}v${n(h)}l${n(-t)} ${n(-t * 0.58)}Z" fill="${left}"/>`);
        parts.push(`<path d="M${n(x + t)} ${n(y - h + t * 0.58)}l${n(t)} ${n(-t * 0.58)}v${n(h)}l${n(-t)} ${n(t * 0.58)}Z" fill="${right}"/>`);
      };
      tile(cx - t * 1.6, cy + t * 0.6, t * 0.25, lighten(c.secondary, 0.25), darken(c.secondary, 0.25), darken(c.secondary, 0.45));
      tile(cx - t, cy + t * 0.2, t * 0.7, lighten(c.primary, 0.2), darken(c.primary, 0.2), darken(c.primary, 0.4));
      tile(cx - t * 0.2, cy - t * 0.25, t * 1.1, lighten(c.accent, 0.2), darken(c.accent, 0.2), darken(c.accent, 0.4));
      parts.push(`<rect x="${n(cx + t * 0.6)}" y="${n(cy - t * 2.1)}" width="${n(t * 1.3)}" height="${n(t * 0.8)}" rx="${n(t * 0.12)}" fill="#ffffff" opacity="0.92"/>`);
      parts.push(`<rect x="${n(cx + t * 0.75)}" y="${n(cy - t * 1.95)}" width="${n(t * 0.6)}" height="${n(t * 0.1)}" rx="${n(t * 0.05)}" fill="${c.primary}"/>`);
      parts.push(`<rect x="${n(cx + t * 0.75)}" y="${n(cy - t * 1.75)}" width="${n(t * 0.95)}" height="${n(t * 0.08)}" rx="${n(t * 0.04)}" fill="${c.ink}" opacity="0.2"/>`);
      break;
    }
    case 'paper': {
      const r = s * 0.2;
      parts.push(`<path d="M${n(cx - r)} ${n(cy)}c${n(r * 0.1)} ${n(-r * 1.1)} ${n(r * 1.9)} ${n(-r * 1.1)} ${n(r * 2)} ${n(-r * 0.05)}s${n(-r * 0.9)} ${n(r * 1.15)} ${n(-r * 1.95)} ${n(r * 0.15)}" fill="${lighten(c.accent, 0.35)}" stroke="${c.ink}" stroke-width="${n(s * 0.006)}"/>`);
      parts.push(`<path d="M${n(cx - r * 1.4)} ${n(cy + r * 1.3)}c${n(r * 0.6)} ${n(-r * 0.3)} ${n(r * 1.2)} ${n(r * 0.3)} ${n(r * 1.8)} 0s${n(r * 1.2)} ${n(r * 0.3)} ${n(r * 1.8)} 0" fill="none" stroke="${c.primary}" stroke-width="${n(s * 0.012)}" stroke-linecap="round"/>`);
      for (let i = 0; i < 3; i++) {
        const x = cx - r * 1.5 + i * r * 1.5;
        const y = cy - r * 1.55;
        parts.push(`<path d="M${n(x)} ${n(y - r * 0.2)}l${n(r * 0.06)} ${n(r * 0.14)} ${n(r * 0.15)} ${n(r * 0.02)} ${n(-r * 0.11)} ${n(r * 0.1)} ${n(r * 0.03)} ${n(r * 0.15)} ${n(-r * 0.13)} ${n(-r * 0.08)} ${n(-r * 0.13)} ${n(r * 0.08)} ${n(r * 0.03)} ${n(-r * 0.15)} ${n(-r * 0.11)} ${n(-r * 0.1)} ${n(r * 0.15)} ${n(-r * 0.02)}Z" fill="${i === 1 ? c.accent : c.primary}" stroke="${c.ink}" stroke-width="${n(s * 0.004)}" stroke-linejoin="round"/>`);
      }
      break;
    }
    case 'soft':
      break;
    case 'pedestal':
    default: {
      const pw = s * 0.42;
      const py = cy + s * 0.16;
      shadow(cx, py + s * 0.11, pw * 0.62, s * 0.025);
      parts.push(`<rect x="${n(cx - pw / 2)}" y="${n(py)}" width="${n(pw)}" height="${n(s * 0.1)}" fill="${lighten(c.primary, 0.7)}"/>`);
      parts.push(`<ellipse cx="${n(cx)}" cy="${n(py)}" rx="${n(pw / 2)}" ry="${n(s * 0.04)}" fill="${lighten(c.primary, 0.82)}"/>`);
      parts.push(`<ellipse cx="${n(cx)}" cy="${n(py + s * 0.1)}" rx="${n(pw / 2)}" ry="${n(s * 0.04)}" fill="${lighten(c.primary, 0.6)}"/>`);
      const bw = s * 0.3;
      parts.push(`<rect x="${n(cx - bw / 2)}" y="${n(py - bw - s * 0.02)}" width="${n(bw)}" height="${n(bw)}" rx="${n(bw * 0.18)}" fill="url(#hero)"/>`);
      parts.push(`<circle cx="${n(cx)}" cy="${n(py - bw / 2 - s * 0.02)}" r="${n(bw * 0.24)}" fill="#ffffff" opacity="0.9"/>`);
      parts.push(`<circle cx="${n(cx + bw * 0.34)}" cy="${n(py - bw - s * 0.01)}" r="${n(bw * 0.09)}" fill="${c.accent}"/>`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><defs>${defs.join('')}</defs>${parts.join('')}</svg>`;
}
