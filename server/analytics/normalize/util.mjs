// Small helpers the normalizers share. Everything a provider sends is data: numbers are read as numbers, text
// is kept as plain text (cut to a sane length) and links only when they are http(s).

/** A finite, non-negative number from a number or a numeric string ("1,234", "21.3M" → 21300000), else undefined. */
export function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const m = /^\s*([\d.,]+)\s*([kmb])?\b/i.exec(value.replace(/ /g, ' '));
  if (!m) return undefined;
  const base = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return undefined;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[String(m[2] || '').toLowerCase()] ?? 1;
  return Math.round(base * mult);
}

/** Plain text, at most `max` characters. */
export function text(value, max = 500) {
  if (value == null) return '';
  const s = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** An http(s) link, or undefined (never javascript:, data: or anything else). */
export function link(value) {
  try {
    const u = new URL(String(value ?? ''));
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** An ISO time from an ISO string, epoch seconds or epoch ms; undefined otherwise ("10 days ago" included). */
export function when(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

/** The first defined value. */
export const first = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');

/** Drop undefined fields. */
export function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** A post in SocialNetworkStats.topPosts shape, or null without an id. */
export function post({ id, url, text: body, at, likes, comments, shares, views }) {
  const pid = id == null ? '' : text(id, 100);
  if (!pid) return null;
  return compact({ id: pid, url: link(url), text: text(body, 500), at: when(at), likes: num(likes), comments: num(comments), shares: num(shares), views: num(views) });
}
