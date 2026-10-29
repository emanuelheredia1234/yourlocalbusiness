// ───────────────────────── General helpers ─────────────────────────

export function cn(...parts: Array<string | false | null | undefined | 0>): string {
  return parts.filter(Boolean).join(' ');
}

export function uid(prefix = ''): string {
  const bytes = new Uint8Array(8);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  const id = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
  return prefix ? `${prefix}_${id}` : id;
}

/** FNV-1a 32-bit string hash — stable seeds for deterministic generation. */
export function hashStr(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  float(min: number, max: number): number;
  pick<T>(arr: readonly T[]): T;
  pickN<T>(arr: readonly T[], n: number): T[];
  shuffle<T>(arr: readonly T[]): T[];
  chance(p: number): boolean;
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
}

export function createRng(seed: number | string): Rng {
  const next = mulberry32(typeof seed === 'string' ? hashStr(seed) : seed);
  const rng: Rng = {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    float: (min, max) => next() * (max - min) + min,
    pick: (arr) => arr[Math.floor(next() * arr.length) % Math.max(1, arr.length)],
    shuffle: (arr) => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    pickN: (arr, n) => rng.shuffle(arr).slice(0, Math.max(0, n)),
    chance: (p) => next() < p,
    weighted: (items, weights) => {
      const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
      if (total <= 0) return items[0];
      let r = next() * total;
      for (let i = 0; i < items.length; i++) {
        r -= Math.max(0, weights[i]);
        if (r <= 0) return items[i];
      }
      return items[items.length - 1];
    },
  };
  return rng;
}

export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
export const round = (n: number, step = 1) => Math.round(n / step) * step;
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function uniq<T>(arr: readonly T[]): T[] {
  return Array.from(new Set(arr));
}

export function uniqBy<T>(arr: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of arr) {
    const k = key(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

export function groupBy<T, K extends string>(arr: readonly T[], key: (t: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of arr) {
    const k = key(item);
    (out[k] ||= []).push(item);
  }
  return out;
}

export const sum = (arr: readonly number[]) => arr.reduce((s, n) => s + n, 0);
export const avg = (arr: readonly number[]) => (arr.length ? sum(arr) / arr.length : 0);

export function sortBy<T>(arr: readonly T[], key: (t: T) => number | string, dir: 'asc' | 'desc' = 'asc'): T[] {
  const m = dir === 'asc' ? 1 : -1;
  return arr.slice().sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 * m : ka > kb ? 1 * m : 0;
  });
}

export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  const a = arr.slice();
  if (to < 0 || to >= a.length || from === to) return a;
  const [it] = a.splice(from, 1);
  a.splice(to, 0, it);
  return a;
}

/** Immutable deep set by path. */
export function setIn<T>(obj: T, path: ReadonlyArray<string | number>, value: unknown): T {
  if (!path.length) return value as T;
  const [head, ...rest] = path;
  const src = (obj ?? (typeof head === 'number' ? [] : {})) as Record<string | number, unknown>;
  const clone = (Array.isArray(src) ? src.slice() : { ...src }) as Record<string | number, unknown>;
  clone[head] = setIn(src[head], rest, value);
  return clone as T;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const d = (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => t && clearTimeout(t);
  return d;
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

// ───────────────────────── Strings ─────────────────────────

export function slugify(input: string, max = 48): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'via', 'with', 'from']);

export function titleCase(input: string): string {
  return input
    .split(/(\s+)/)
    .map((w, i) => {
      if (/^\s+$/.test(w)) return w;
      if (/[A-Z].*[A-Z]/.test(w) || /\d/.test(w)) return w; // keep acronyms/brand casing
      const lower = w.toLowerCase();
      if (i !== 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

export const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
export const lowerFirst = (s: string) => (s && !/^[A-Z]{2}/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

export function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, Math.max(0, n - 1)).trimEnd() + '…' : s;
}

export const plural = (n: number, word: string, pluralWord = word + 's') => `${n} ${n === 1 ? word : pluralWord}`;

export function stripProtocol(url: string): string {
  return (url || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
}

export function ensureUrl(url: string): string {
  const u = (url || '').trim();
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

export function initials(name: string): string {
  const parts = (name || '').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function escapeHtml(s: string): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function wordCount(s: string): number {
  const m = (s || '').trim().match(/[A-Za-z0-9'’-]+/g);
  return m ? m.length : 0;
}

export function listJoin(items: string[], conj = 'and'): string {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a.join('');
  if (a.length === 2) return `${a[0]} ${conj} ${a[1]}`;
  return `${a.slice(0, -1).join(', ')}, ${conj} ${a[a.length - 1]}`;
}

// ───────────────────────── Numbers & money ─────────────────────────

export function fmtMoney(n: number, opts: { cents?: boolean; compact?: boolean } = {}): string {
  if (!isFinite(n)) return '$0';
  if (opts.compact && Math.abs(n) >= 1000) {
    return '$' + fmtCompact(n);
  }
  const cents = opts.cents ?? !Number.isInteger(Math.round(n * 100) / 100);
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
}

export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [v, s] of units) {
    if (abs >= v) {
      const x = n / v;
      return (Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 10) / 10) + s;
    }
  }
  return String(n);
}

export const fmtNum = (n: number) => Math.round(n).toLocaleString('en-US');
export const fmtPct = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`;

// ───────────────────────── Dates ─────────────────────────

export const DAY_MS = 86_400_000;
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date string yyyy-mm-dd */
export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDateStr(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export const todayStr = () => toDateStr(new Date());

export function addDays(dateStr: string, n: number): string {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/** Monday = 0 … Sunday = 6 */
export function weekdayIndex(dateStr: string): number {
  return (parseDateStr(dateStr).getDay() + 6) % 7;
}

export function combineDateTime(dateStr: string, time: string): string {
  const d = parseDateStr(dateStr);
  const [h, m] = (time || '09:00').split(':').map(Number);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.toISOString();
}

export function isoToDateStr(iso: string): string {
  return toDateStr(new Date(iso));
}

export function isoToTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m || 0)} ${ampm}`;
}

export function fmtDate(input: string | number | Date, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
  const d = typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input) ? parseDateStr(input) : new Date(input);
  return d.toLocaleDateString('en-US', opts);
}

export function fmtDateTime(iso: string | number): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

export function fmtRelative(ts: number | string, now = Date.now()): string {
  const t = typeof ts === 'string' ? new Date(ts).getTime() : ts;
  const diff = t - now;
  const abs = Math.abs(diff);
  const fut = diff > 0;
  const fmt = (n: number, unit: string) => (fut ? `in ${n}${unit}` : `${n}${unit} ago`);
  if (abs < 45_000) return fut ? 'in a moment' : 'just now';
  if (abs < 3_600_000) return fmt(Math.round(abs / 60_000), 'm');
  if (abs < DAY_MS) return fmt(Math.round(abs / 3_600_000), 'h');
  if (abs < 7 * DAY_MS) return fmt(Math.round(abs / DAY_MS), 'd');
  return fmtDate(t, { month: 'short', day: 'numeric' });
}

export function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// ───────────────────────── Color ─────────────────────────

export function hexToRgb(hex: string): [number, number, number] {
  let h = (hex || '#000').replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(lerp(r1, r2, t), lerp(g1, g2, t), lerp(b1, b2, t));
}

export const lighten = (hex: string, t: number) => mix(hex, '#ffffff', t);
export const darken = (hex: string, t: number) => mix(hex, '#000000', t);

export function withAlpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function readableOn(bg: string, light = '#ffffff', dark = '#111814'): string {
  return contrastRatio(bg, light) >= contrastRatio(bg, dark) ? light : dark;
}

export function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return [h, s, l];
}

export function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number] = [0, 0, 0];
  if (hh < 60) rgb = [c, x, 0];
  else if (hh < 120) rgb = [x, c, 0];
  else if (hh < 180) rgb = [0, c, x];
  else if (hh < 240) rgb = [0, x, c];
  else if (hh < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgbToHex((rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255);
}

export function isHex(s: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test((s || '').trim());
}

// ───────────────────────── Files & media ─────────────────────────

export function readFileAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function readFileAsText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = src;
  });
}

/** Downscale an image file to a data URL (keeps aspect ratio). */
export async function resizeImage(
  file: Blob,
  maxSize = 512,
  type: 'image/jpeg' | 'image/png' | 'image/webp' = 'image/jpeg',
  quality = 0.82,
): Promise<{ dataUrl: string; w: number; h: number }> {
  const src = await readFileAsDataURL(file);
  const img = await loadImage(src);
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { dataUrl: src, w: img.width, h: img.height };
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(img, 0, 0, w, h);
  return { dataUrl: canvas.toDataURL(type, quality), w: img.width, h: img.height };
}

/** Grab a still frame from a video file (used for thumbnails and AI captioning). */
export function videoFrame(file: Blob, atSeconds = 0.8, maxSize = 640): Promise<{ blob: Blob | null; dataUrl: string; w: number; h: number; duration: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    const fail = () => {
      URL.revokeObjectURL(url);
      resolve({ blob: null, dataUrl: '', w: 0, h: 0, duration: 0 });
    };
    const timer = setTimeout(fail, 6000);
    video.onerror = () => {
      clearTimeout(timer);
      fail();
    };
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(atSeconds, Math.max(0, (video.duration || 1) / 2));
    };
    video.onseeked = () => {
      clearTimeout(timer);
      const scale = Math.min(1, maxSize / Math.max(video.videoWidth || 1, video.videoHeight || 1));
      const w = Math.max(1, Math.round((video.videoWidth || 320) * scale));
      const h = Math.max(1, Math.round((video.videoHeight || 568) * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return fail();
      ctx.drawImage(video, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(url);
          resolve({ blob, dataUrl, w: video.videoWidth, h: video.videoHeight, duration: video.duration || 0 });
        },
        'image/jpeg',
        0.85,
      );
    };
  });
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',');
  const mime = /data:([^;]+)/.exec(head)?.[1] || 'application/octet-stream';
  const bin = atob(body || '');
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ───────────────────────── Payments (demo checkout validation) ─────────────────────────

export function luhnValid(num: string): boolean {
  const digits = num.replace(/\D/g, '');
  if (digits.length < 12 || digits.length > 19) return false;
  let sumDigits = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sumDigits += d;
    dbl = !dbl;
  }
  return sumDigits % 10 === 0;
}

export function cardBrand(num: string): 'visa' | 'mastercard' | 'amex' | 'discover' | 'card' {
  const d = num.replace(/\D/g, '');
  if (/^4/.test(d)) return 'visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(d)) return 'mastercard';
  if (/^3[47]/.test(d)) return 'amex';
  if (/^(6011|65|64[4-9])/.test(d)) return 'discover';
  return 'card';
}

export function formatCardNumber(num: string): string {
  const d = num.replace(/\D/g, '').slice(0, 19);
  if (cardBrand(d) === 'amex') return d.replace(/^(\d{0,4})(\d{0,6})(\d{0,5}).*/, (_, a, b, c) => [a, b, c].filter(Boolean).join(' '));
  return d.replace(/(\d{4})(?=\d)/g, '$1 ');
}

export function expiryValid(mmYY: string, now = new Date()): boolean {
  const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(mmYY.trim());
  if (!m) return false;
  const month = Number(m[1]);
  const year = 2000 + Number(m[2]);
  if (month < 1 || month > 12) return false;
  const end = new Date(year, month, 1);
  return end.getTime() > now.getTime();
}

export const emailValid = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((s || '').trim());
