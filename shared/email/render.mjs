// The email studio's renderer (P5 §4): one block doc → the email's HTML (tables and inline CSS, Outlook VML buttons
// and ghost tables, a hidden preheader) and its plain-text part. Pure and deterministic: the same input gives the
// same bytes, so the app's preview, its HTML export and the Omnisend draft the server makes are the same email.
//
//   renderEmail(doc, ctx) → { html, text, warnings, bytes }      renderText(doc, ctx) → string
//   ctx.target: 'preview' | 'export' | 'omnisend' | 'gmail'
//
// The footer is always the renderer's (never a block): Omnisend's [[unsubscribe_link]] (asserted: exactly one),
// the chosen email tool's unsubscribe tag for an export, the opt-out link and postal address for Gmail (P10), an
// inert link in the preview. Warnings are codes ('UNKNOWN_BUY_LINK:<id>', 'GMAIL_CLIP', …) the app puts in words.

import { BRAND_DEFAULTS, EMAIL_LIMITS, FONTS, HEX_RE, LINK_TAGS, MERGE_TAGS, SOCIAL_LABELS, TAG_RE, THEMES, byteLength, eachBlock, linkFromTarget, normalizeDoc, parseInline, parseParagraphs } from './blocks.mjs';
import { SanitizeError, decodeEntities, escapeHtml, safeHref, safeImageSrc, sanitizeEmailCss, sanitizeEmailHtml } from './sanitize.mjs';
import ESP from './esp.json' with { type: 'json' };

export { escapeHtml, safeHref, safeImageSrc };
export const ESP_TOOLS = ESP;
export const ESP_IDS = Object.freeze(Object.keys(ESP));
export const RENDER_TARGETS = Object.freeze(['preview', 'export', 'omnisend', 'gmail']);
export const OMNISEND_UNSUBSCRIBE = '[[unsubscribe_link]]';

export class RenderError extends Error {
  constructor(code, message, data = {}) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
    Object.assign(this, data);
  }
}

// ───────────── colours and themes ─────────────

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgbToHex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
/** a mixed with b: t = 0 is a, t = 1 is b. */
export const mix = (a, b, t) => rgbToHex(hexToRgb(a).map((v, i) => v + (hexToRgb(b)[i] - v) * t));
/** WCAG relative luminance. */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio of two colours (1–21). */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const BASE = { bg: '#f4f5f4', paper: '#ffffff', ink: '#1d2420', muted: '#5f6b66', primary: BRAND_DEFAULTS.primary, primaryText: '#ffffff', accent: BRAND_DEFAULTS.accent, rule: '#e3e8e6', font: 'system', headingFont: 'system', size: 16, radius: 8, width: 600, density: 'regular', headingCase: 'normal', headerLogo: false };
const SAFE_TEXT = { ink: '#1d2420', paper: '#ffffff', muted: '#5f6b66', rule: '#e3e8e6' };

/**
 * A theme reference and the brand's colours → { tokens, warnings }. Contrast is checked (WCAG): text on the card
 * below 4.5:1 falls back to dark on white (CONTRAST_TEXT); a button label below 4.5:1 on its colour switches to
 * white or the text colour, whichever reads better (CONTRAST_BUTTON when an override had to be changed or neither
 * reaches 4.5:1). tokens also carry fontStack, headingStack and link (the link colour).
 */
export function resolveTheme(ref, brandColors = {}) {
  const warnings = [];
  const r = ref && typeof ref === 'object' ? ref : {};
  const def = THEMES.find((t) => t.id === r.id) ?? THEMES[0];
  const brand = { ...BRAND_DEFAULTS };
  for (const k of ['primary', 'accent', 'ink', 'paper']) if (typeof brandColors?.[k] === 'string' && HEX_RE.test(brandColors[k])) brand[k] = brandColors[k].toLowerCase();
  const t = { ...BASE, ...def.tokens };
  for (const k of def.from) t[k] = brand[k];
  if (def.id === 'brand') {
    t.bg = mix(brand.paper, brand.ink, 0.05);
    t.muted = mix(brand.ink, brand.paper, 0.38);
    t.rule = mix(brand.paper, brand.ink, 0.12);
  }
  const o = r.overrides && typeof r.overrides === 'object' ? r.overrides : {};
  for (const [k, v] of Object.entries(o)) if (Object.hasOwn(BASE, k) && v !== undefined) t[k] = v;
  if (!Object.hasOwn(FONTS, t.font)) t.font = 'system';
  if (!Object.hasOwn(FONTS, t.headingFont)) t.headingFont = t.font;
  for (const k of ['bg', 'paper', 'ink', 'muted', 'primary', 'primaryText', 'accent', 'rule']) if (typeof t[k] !== 'string' || !HEX_RE.test(t[k])) t[k] = BASE[k];
  if (contrast(t.ink, t.paper) < 4.5) {
    warnings.push('CONTRAST_TEXT');
    Object.assign(t, SAFE_TEXT);
  }
  if (contrast(t.primaryText, t.primary) < 4.5) {
    const white = contrast('#ffffff', t.primary);
    const ink = contrast(t.ink, t.primary);
    const chosen = white >= ink ? '#ffffff' : t.ink;
    if (o.primaryText !== undefined || Math.max(white, ink) < 4.5) warnings.push('CONTRAST_BUTTON');
    t.primaryText = chosen;
  }
  t.link = contrast(t.primary, t.paper) >= 3 ? t.primary : t.ink;
  t.fontStack = FONTS[t.font].stack;
  t.headingStack = FONTS[t.headingFont].stack;
  return { tokens: t, warnings };
}

const SPACING = { airy: { gap: 24, side: 40 }, regular: { gap: 16, side: 32 }, tight: { gap: 10, side: 24 } };
const PAD = { none: 0, s: 8, m: 16, l: 32 };
const HEADING_SCALE = { 1: 1.75, 2: 1.4, 3: 1.15 };

// ───────────── the render context ─────────────

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const attr = (v) => escapeHtml(v);
const css = (s) => escapeHtml(s);

function contextFor(doc, ctx) {
  if (!isRecord(ctx) || !RENDER_TARGETS.includes(ctx.target)) throw new RenderError('BAD_TARGET', 'Say what the email is rendered for.');
  const { tokens, warnings } = resolveTheme(doc.theme, ctx.brand?.colors);
  const values = {};
  for (const [k, v] of Object.entries(isRecord(ctx.values) ? ctx.values : {})) if (typeof v === 'string') values[k] = v;
  const links = {};
  for (const [k, v] of Object.entries(isRecord(ctx.links) ? ctx.links : {})) if (typeof v === 'string') links[k] = v;
  const space = SPACING[tokens.density] ?? SPACING.regular;
  const rc = {
    target: ctx.target,
    t: tokens,
    space,
    values,
    links,
    warnings: new Set(warnings),
    iconBase: safeImageSrc(ctx.iconBase ?? '') ? String(ctx.iconBase).replace(/\/+$/, '') : '',
    imageAllowed: typeof ctx.imageAllowed === 'function' ? ctx.imageAllowed : () => true,
    styles: [],
  };
  return rc;
}

const warn = (rc, code) => rc.warnings.add(code);

/** The address a Link goes to, or '#' (with a warning) when there's none yet. */
function hrefFor(link, rc) {
  if (!isRecord(link)) return '#';
  const frag = { fragment: true };
  switch (link.kind) {
    case 'magnet':
    case 'page': {
      const tag = link.kind === 'magnet' ? 'lead_magnet_link' : 'product_link';
      const href = safeHref(rc.values[tag] ?? '', frag);
      if (!href) warn(rc, `NO_LINK:${link.kind}`);
      return href ?? '#';
    }
    case 'offer':
      return buyHref(link.offerId, rc);
    case 'asset': {
      const href = safeHref(rc.links[`asset:${link.assetId}`] ?? '', frag);
      if (!href) warn(rc, `UNKNOWN_ASSET_LINK:${link.assetId}`);
      return href ?? '#';
    }
    case 'url': {
      const href = safeHref(link.url, { mailto: true, fragment: true });
      if (!href) warn(rc, 'BAD_LINK');
      return href ?? '#';
    }
    default:
      return '#';
  }
}

function buyHref(id, rc) {
  const href = safeHref(rc.links[`buy:${id}`] ?? '', { fragment: true });
  if (!href) warn(rc, `UNKNOWN_BUY_LINK:${id}`);
  return href ?? '#';
}

const linkAttrs = (href) => (href.startsWith('#') ? `href="${attr(href)}"` : `href="${attr(href)}" target="_blank" rel="noopener"`);
const textLink = (href, label, rc) => `<a ${linkAttrs(href)} style="color:${rc.t.link};text-decoration:underline;">${label}</a>`;
/** What a bare link in text shows: the address, or words when there's no web address to show. */
const shownAddress = (href, words = 'this link') => (/^https?:\/\//.test(href) ? href : words);

/** Plain text with its merge tags filled in, as HTML (link tags become links when autolink). */
function mergeHtml(s, rc, autolink = true) {
  let out = '';
  let last = 0;
  for (const m of String(s).matchAll(new RegExp(TAG_RE.source, 'g'))) {
    out += escapeHtml(s.slice(last, m.index));
    last = m.index + m[0].length;
    out += tagHtml(m[1], m[0], rc, autolink);
  }
  return out + escapeHtml(s.slice(last));
}

function tagHtml(name, raw, rc, autolink) {
  if (name.startsWith('buy:')) {
    const href = buyHref(name.slice(4), rc);
    return autolink ? textLink(href, escapeHtml(shownAddress(href, 'Buy now')), rc) : escapeHtml(shownAddress(href, 'Buy now'));
  }
  if (!MERGE_TAGS.includes(name)) {
    warn(rc, `UNKNOWN_TAG:${name}`);
    return escapeHtml(raw);
  }
  const v = rc.values[name];
  if (typeof v !== 'string' || !v) {
    warn(rc, `MISSING_VALUE:${name}`);
    return escapeHtml(raw);
  }
  if (LINK_TAGS.includes(name)) {
    const href = safeHref(v, { fragment: true });
    if (href && autolink) return textLink(href, escapeHtml(shownAddress(href, v)), rc);
  }
  return escapeHtml(v);
}

/** Plain text with its merge tags filled in, as text. */
function mergeText(s, rc) {
  return String(s).replace(new RegExp(TAG_RE.source, 'g'), (raw, name) => {
    if (name.startsWith('buy:')) {
      const href = buyHref(name.slice(4), rc);
      return shownAddress(href, '');
    }
    if (!MERGE_TAGS.includes(name)) {
      warn(rc, `UNKNOWN_TAG:${name}`);
      return raw;
    }
    const v = rc.values[name];
    if (typeof v !== 'string' || !v) {
      warn(rc, `MISSING_VALUE:${name}`);
      return raw;
    }
    return v;
  });
}

function inlineHtml(nodes, rc) {
  return nodes
    .map((n) => {
      if (n.t === 'text') return mergeHtml(n.v, rc);
      if (n.t === 'b') return `<strong>${inlineHtml(n.children, rc)}</strong>`;
      if (n.t === 'i') return `<em>${inlineHtml(n.children, rc)}</em>`;
      return textLink(hrefFor(linkFromTarget(n.target), rc), mergeHtml(n.label, rc, false), rc);
    })
    .join('');
}

function inlineText(nodes, rc) {
  return nodes
    .map((n) => {
      if (n.t === 'text') return mergeText(n.v, rc);
      if (n.t === 'b' || n.t === 'i') return inlineText(n.children, rc);
      const href = hrefFor(linkFromTarget(n.target), rc);
      const label = mergeText(n.label, rc);
      return /^https?:\/\//.test(href) ? `${label} (${href})` : label;
    })
    .join('');
}

// ───────────── blocks ─────────────

const font = (rc, heading = false) => `font-family:${css(heading ? rc.t.headingStack : rc.t.fontStack)};`;
const textStyle = (rc, extra = '') => `${font(rc)}font-size:${rc.t.size}px;line-height:1.6;color:${rc.t.ink};mso-line-height-rule:exactly;${extra}`;
const TABLE = 'role="presentation" border="0" cellpadding="0" cellspacing="0"';

function rowFor(b, inner, rc, box, defaults = {}) {
  const v = b.pad ? PAD[b.pad] : defaults.v ?? Math.round(rc.space.gap / 2);
  const align = b.align ?? defaults.align ?? 'left';
  return `<tr>\n<td class="ylb-pad" align="${align}" style="padding:${v}px ${box.side}px ${v}px ${box.side}px;">${inner}</td>\n</tr>`;
}

function headingHtml(b, rc, box) {
  if (!b.text.trim()) return '';
  const size = Math.round(rc.t.size * HEADING_SCALE[b.level]);
  const style = `margin:0;${font(rc, true)}font-size:${size}px;line-height:1.25;font-weight:bold;color:${rc.t.ink};mso-line-height-rule:exactly;${b.align ? `text-align:${b.align};` : ''}${rc.t.headingCase === 'upper' ? 'text-transform:uppercase;letter-spacing:0.5px;' : ''}`;
  return rowFor(b, `<h${b.level} style="${style}">${mergeHtml(b.text, rc, false)}</h${b.level}>`, rc, box);
}

function textHtml(b, rc, box) {
  const paras = parseParagraphs(b.text, !!b.plain);
  if (!paras.length) return '';
  const gap = Math.round(rc.t.size * 0.9);
  const align = b.align ? `text-align:${b.align};` : '';
  const html = paras
    .map((p, i) => {
      const margin = `margin:0 0 ${i === paras.length - 1 ? 0 : gap}px;`;
      if (p.kind === 'ul') return `<ul style="${margin}padding:0 0 0 22px;${textStyle(rc, align)}">${p.items.map((it) => `<li style="margin:0 0 4px;">${inlineHtml(parseInline(it), rc)}</li>`).join('')}</ul>`;
      const lines = p.lines.map((l) => (b.plain ? mergeHtml(l, rc) : inlineHtml(parseInline(l), rc)));
      return `<p style="${margin}${textStyle(rc, align)}">${lines.join('<br>')}</p>`;
    })
    .join('\n');
  return rowFor(b, html, rc, box);
}

function imgTag(src, alt, width, natural, rc, { full = false, center = true } = {}) {
  const height = natural?.w && natural?.h ? Math.round((natural.h * width) / natural.w) : null;
  const style = `display:block;width:100%;max-width:${width}px;height:auto;border:0;outline:none;text-decoration:none;${center ? 'margin:0 auto;' : ''}`;
  return `<img src="${attr(src)}" alt="${attr(alt)}" width="${width}"${height ? ` height="${height}"` : ''} border="0"${full ? ' class="ylb-full"' : ''} style="${style}">`;
}

function imageHtml(b, rc, box) {
  if (!b.src) {
    warn(rc, 'IMAGE_EMPTY');
    return '';
  }
  const src = safeImageSrc(b.src);
  if (!src) {
    warn(rc, 'IMAGE_REFUSED');
    return '';
  }
  const width = b.width === 'full' ? box.width : Math.min(b.width, box.width);
  const img = imgTag(src, b.alt, width, { w: b.w, h: b.h }, rc, { full: b.width === 'full', center: (b.align ?? 'center') === 'center' });
  const inner = b.link ? `<a ${linkAttrs(hrefFor(b.link, rc))} style="text-decoration:none;">${img}</a>` : img;
  return rowFor(b, inner, rc, box, { align: 'center' });
}

/** A bulletproof button: a table cell with its colour, an <a>, and a VML roundrect for Outlook on Windows. */
function buttonCore({ label, href, full = false, outline = false, align = 'center' }, rc, box) {
  const t = rc.t;
  const size = Math.max(15, t.size);
  const width = full ? box.width : Math.max(120, Math.min(box.width, Math.round([...label].length * size * 0.62 + 56)));
  const height = Math.round(size * 2.75);
  const radius = Math.min(t.radius, Math.round(height / 2));
  const arc = Math.min(50, Math.round((radius / height) * 100));
  const bg = outline ? t.paper : t.primary;
  const fg = outline ? t.link : t.primaryText;
  const border = outline ? `border:2px solid ${t.primary};` : '';
  const text = escapeHtml(label);
  const vml = `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${attr(href)}" style="height:${height}px;v-text-anchor:middle;width:${width}px;" arcsize="${arc}%" ${outline ? `strokecolor="${t.primary}" strokeweight="2px"` : 'stroke="f"'} fillcolor="${bg}"><w:anchorlock/><center style="color:${fg};${font(rc)}font-size:${size}px;font-weight:bold;">${text}</center></v:roundrect><![endif]-->`;
  const a = `<!--[if !mso]><!--><a ${linkAttrs(href)} style="display:${full ? 'block' : 'inline-block'};padding:${Math.round(size * 0.8)}px 28px;${font(rc)}font-size:${size}px;line-height:1.2;font-weight:bold;color:${fg};text-decoration:none;text-align:center;background-color:${bg};border-radius:${radius}px;${border}mso-hide:all;">${text}</a><!--<![endif]-->`;
  return `<table ${TABLE} align="${align}"${full ? ' width="100%"' : ''} style="margin:0 ${align === 'center' ? 'auto' : '0'};border-collapse:separate;"><tr><td align="center" bgcolor="${bg}" style="border-radius:${radius}px;background-color:${bg};">${vml}${a}</td></tr></table>`;
}

function buttonHtml(b, rc, box) {
  if (!b.label.trim()) {
    warn(rc, 'BUTTON_NO_LABEL');
    return '';
  }
  const align = b.align ?? 'center';
  return rowFor(b, buttonCore({ label: b.label, href: hrefFor(b.link, rc), full: !!b.full, outline: b.style === 'outline', align }, rc, box), rc, box, { align });
}

function columnsHtml(b, rc, box) {
  const [l, r] = b.ratio === '33/67' ? [0.33, 0.67] : b.ratio === '67/33' ? [0.67, 0.33] : [0.5, 0.5];
  const left = Math.round(box.width * l);
  const widths = [left, box.width - left];
  const inner = (col, w) => {
    const ibox = { width: w - 16, side: 8 };
    const rows = col.blocks.map((x) => blockHtml(x, rc, ibox)).filter(Boolean).join('\n');
    return `<table ${TABLE} width="100%">${rows ? `\n${rows}\n` : '<tr><td></td></tr>'}</table>`;
  };
  let html;
  if (b.stack) {
    // stacks on phones: inline-block columns, a ghost table keeps them side by side in Outlook
    const cols = b.cols.map((c, i) => `<div class="ylb-col" style="display:inline-block;vertical-align:top;width:100%;max-width:${widths[i]}px;">${inner(c, widths[i])}</div>`);
    html = `<!--[if mso]><table ${TABLE} width="${box.width}"><tr><td width="${widths[0]}" valign="top"><![endif]-->${cols[0]}<!--[if mso]></td><td width="${widths[1]}" valign="top"><![endif]-->${cols[1]}<!--[if mso]></td></tr></table><![endif]-->`;
  } else {
    html = `<table ${TABLE} width="100%"><tr>${b.cols.map((c, i) => `<td width="${widths[i]}" valign="top" style="width:${widths[i]}px;">${inner(c, widths[i])}</td>`).join('')}</tr></table>`;
  }
  const v = b.pad ? PAD[b.pad] : Math.round(rc.space.gap / 2);
  return `<tr>\n<td class="ylb-pad" style="padding:${v}px ${box.side}px;font-size:0;line-height:0;" align="center">${html}</td>\n</tr>`;
}

function offerHtml(b, rc, box) {
  if (!b.offerId) {
    warn(rc, 'OFFER_EMPTY');
    return '';
  }
  const t = rc.t;
  const inner = box.width - 2;
  const picture = b.image?.src && safeImageSrc(b.image.src) ? `<tr><td style="padding:0;">${imgTag(safeImageSrc(b.image.src), b.image.alt, inner, null, rc, { full: true })}</td></tr>` : '';
  const title = b.title ? `<h3 style="margin:0 0 6px;${font(rc, true)}font-size:${Math.round(t.size * 1.2)}px;line-height:1.3;font-weight:bold;color:${t.ink};">${escapeHtml(b.title)}</h3>` : '';
  const price = b.price ? `<p style="margin:0 0 10px;${font(rc)}font-size:${t.size}px;font-weight:bold;color:${t.link};">${escapeHtml(b.price)}</p>` : '';
  const blurb = b.blurb ? parseParagraphs(b.blurb, true).map((p) => `<p style="margin:0 0 12px;${textStyle(rc)}">${p.lines.map((l) => mergeHtml(l, rc)).join('<br>')}</p>`).join('') : '';
  const button = buttonCore({ label: b.buttonLabel, href: buyHref(b.offerId, rc), align: 'left' }, rc, { width: inner - 40 });
  const card = `<table ${TABLE} width="100%" style="border:1px solid ${t.rule};border-radius:${Math.min(t.radius, 16)}px;border-collapse:separate;background-color:${t.paper};">${picture}<tr><td style="padding:18px 20px 20px;">${title}${price}${blurb}${button}</td></tr></table>`;
  return rowFor(b, card, rc, box, { align: 'center' });
}

function videoHtml(b, rc, box) {
  const src = safeImageSrc(b.thumb?.src ?? '');
  if (!src) {
    warn(rc, b.thumb?.src ? 'IMAGE_REFUSED' : 'IMAGE_EMPTY');
    return '';
  }
  const href = hrefFor(b.link, rc);
  const img = imgTag(src, b.thumb.alt || 'Watch the video', box.width, null, rc, { full: true });
  const caption = b.caption ? `<p style="margin:8px 0 0;${font(rc)}font-size:${Math.max(13, rc.t.size - 2)}px;line-height:1.5;color:${rc.t.muted};text-align:center;">${mergeHtml(b.caption, rc)}</p>` : '';
  return rowFor(b, `<a ${linkAttrs(href)} style="text-decoration:none;">${img}</a>${caption}`, rc, box, { align: 'center' });
}

function socialHtml(b, rc, box) {
  const links = b.links.map((l) => ({ ...l, href: safeHref(l.url) })).filter((l) => l.href);
  if (links.length < b.links.length) warn(rc, 'BAD_LINK');
  if (!links.length) return '';
  const t = rc.t;
  let inner;
  if (b.style === 'icons' && rc.iconBase) {
    inner = links.map((l) => `<a ${linkAttrs(l.href)} style="display:inline-block;margin:0 6px;text-decoration:none;"><img src="${attr(`${rc.iconBase}/email-icons/${l.platform}.png`)}" alt="${attr(SOCIAL_LABELS[l.platform])}" width="24" height="24" border="0" style="display:inline-block;width:24px;height:24px;border:0;"></a>`).join('');
  } else {
    if (b.style === 'icons') warn(rc, 'SOCIAL_ICONS_TEXT');
    inner = `<p style="margin:0;${font(rc)}font-size:${Math.max(13, t.size - 2)}px;line-height:1.6;color:${t.muted};">${links.map((l) => textLink(l.href, escapeHtml(SOCIAL_LABELS[l.platform]), rc)).join(' &middot; ')}</p>`;
  }
  return rowFor(b, inner, rc, box, { align: 'center' });
}

function dividerHtml(b, rc, box) {
  if (b.style === 'space') return `<tr>\n<td style="padding:0;"><div style="height:${b.size}px;line-height:${b.size}px;font-size:0;">&nbsp;</div></td>\n</tr>`;
  const v = Math.round(b.size / 2);
  return `<tr>\n<td class="ylb-pad" style="padding:${v}px ${box.side}px;"><table ${TABLE} width="100%"><tr><td height="1" style="height:1px;border-top:1px solid ${rc.t.rule};font-size:0;line-height:0;">&nbsp;</td></tr></table></td>\n</tr>`;
}

function customHtml(b, rc, box) {
  const scope = `ylb-c-${b.id}`;
  let html;
  try {
    html = sanitizeEmailHtml(b.html, { imageAllowed: rc.imageAllowed }).html;
  } catch (e) {
    if (!(e instanceof SanitizeError)) throw e;
    warn(rc, 'CUSTOM_TOO_LARGE');
    return '';
  }
  if (b.css) {
    try {
      const scoped = sanitizeEmailCss(b.css, { scope: `.${scope}` }).css;
      if (scoped) rc.styles.push(scoped);
    } catch (e) {
      if (!(e instanceof SanitizeError)) throw e;
      warn(rc, 'CUSTOM_TOO_LARGE');
    }
  }
  // the link tokens the sanitizer kept become addresses; agent image tokens that weren't uploaded are dropped
  html = html.replace(/href="\{\{(lead_magnet_link|product_link|buy:[A-Za-z0-9_-]{22})\}\}"(?: target="_blank" rel="noopener")?/g, (_, tag) => {
    const href = tag.startsWith('buy:') ? buyHref(tag.slice(4), rc) : hrefFor({ kind: tag === 'lead_magnet_link' ? 'magnet' : 'page' }, rc);
    return linkAttrs(href);
  });
  html = html.replace(/<img src="\{\{img-\d{1,2}\}\}"[^>]*>/g, () => {
    warn(rc, 'IMAGE_EMPTY');
    return '';
  });
  // merge tags in its text only, never inside a tag's attributes (a value could break out of a style)
  html = html
    .split(/(<[^>]*>)/)
    .map((part) => (part.startsWith('<') ? part : part.replace(new RegExp(TAG_RE.source, 'g'), (raw, name) => tagHtml(name, raw, rc, false))))
    .join('');
  return rowFor(b, `<div class="${scope}" style="${textStyle(rc)}">${html}</div>`, rc, box);
}

function blockHtml(b, rc, box) {
  switch (b.type) {
    case 'heading':
      return headingHtml(b, rc, box);
    case 'text':
      return textHtml(b, rc, box);
    case 'image':
      return imageHtml(b, rc, box);
    case 'button':
      return buttonHtml(b, rc, box);
    case 'columns':
      return columnsHtml(b, rc, box);
    case 'offer':
      return offerHtml(b, rc, box);
    case 'video':
      return videoHtml(b, rc, box);
    case 'social':
      return socialHtml(b, rc, box);
    case 'divider':
      return dividerHtml(b, rc, box);
    case 'custom':
      return customHtml(b, rc, box);
    default:
      return '';
  }
}

// ───────────── header and footer ─────────────

function headerHtml(ctx, rc, box) {
  if (!rc.t.headerLogo) return '';
  const name = String(ctx.brand?.name ?? '').trim();
  const logo = safeImageSrc(ctx.brand?.logoUrl ?? '');
  let inner;
  if (logo) {
    const w = Number(ctx.brand?.logoWidth);
    const h = Number(ctx.brand?.logoHeight);
    const width = w > 0 && h > 0 ? Math.min(240, Math.max(16, Math.round((40 * w) / h))) : 120;
    inner = `<img src="${attr(logo)}" alt="${attr(name || 'Logo')}" width="${width}" height="40" border="0" style="display:block;height:40px;width:auto;max-width:240px;border:0;outline:none;margin:0 auto;">`;
  } else if (name) {
    inner = `<p style="margin:0;${font(rc, true)}font-size:20px;line-height:1.3;font-weight:bold;color:${rc.t.ink};">${escapeHtml(name)}</p>`;
  } else return '';
  return `<tr>\n<td class="ylb-pad" align="center" style="padding:${rc.space.gap + 8}px ${box.side}px ${Math.round(rc.space.gap / 2)}px;">${inner}</td>\n</tr>`;
}

/** The footer's unsubscribe link for the target: { href (raw, written as is), words } or a visible note. */
function unsubscribeFor(ctx, rc) {
  switch (ctx.target) {
    case 'omnisend':
      return { href: OMNISEND_UNSUBSCRIBE };
    case 'export': {
      const tool = ESP[ctx.esp] ?? ESP.other;
      if (!tool.unsubscribe) {
        warn(rc, 'NO_UNSUBSCRIBE_TAG');
        return { note: '[Add your unsubscribe link]' };
      }
      return { href: tool.unsubscribe };
    }
    case 'gmail': {
      const href = safeHref(ctx.optOutUrl ?? '');
      if (!href || !href.startsWith('https://')) throw new RenderError('NO_OPT_OUT', 'An email sent from Gmail needs its opt-out link.');
      return { href: escapeHtml(href), plainHref: href };
    }
    default:
      return { href: '#unsubscribe-preview' };
  }
}

function footerHtml(ctx, rc, box, unsub) {
  const t = rc.t;
  const note = String(ctx.footerNote ?? '').trim() || 'You’re receiving this because you signed up.';
  const style = `margin:0;${font(rc)}font-size:12px;line-height:1.6;color:${t.muted};`;
  const brand = String(ctx.brand?.name ?? '').trim();
  const link = unsub.href ? `<a href="${unsub.href}" style="color:${t.muted};text-decoration:underline;">Unsubscribe</a>` : escapeHtml(unsub.note);
  const lines = [`<p style="${style}">${escapeHtml(note)}</p>`, `<p style="${style}margin-top:6px;">${brand ? `${escapeHtml(brand)} &middot; ` : ''}${link}</p>`];
  if (ctx.target === 'gmail') {
    const postal = String(ctx.postalAddress ?? '').trim();
    if (postal) lines.push(`<p style="${style}margin-top:6px;">${escapeHtml(postal)}</p>`);
    else warn(rc, 'NO_POSTAL_ADDRESS');
  }
  return `<tr>\n<td class="ylb-pad" align="center" style="padding:${rc.space.gap + 4}px ${box.side}px ${rc.space.gap + 8}px;border-top:1px solid ${t.rule};text-align:center;">${lines.join('')}</td>\n</tr>`;
}

// ───────────── the document ─────────────

const RESET = [
  'body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}',
  'table,td{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;}',
  'img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}',
  'p,h1,h2,h3{margin:0;}',
  '@media (max-width:620px){.ylb-col{display:block!important;width:100%!important;max-width:100%!important;}.ylb-full{width:100%!important;height:auto!important;}.ylb-pad{padding-left:16px!important;padding-right:16px!important;}}',
];

/**
 * The email's HTML and text. doc: an EmailDoc (normalized again here: problems become INVALID_DOC warnings).
 * ctx: { target, subject, preheader, brand: { name, colors, logoUrl?, logoWidth?, logoHeight? }, values, links,
 * esp? (export), optOutUrl?, postalAddress? (gmail), footerNote?, iconBase, imageAllowed?(src) }.
 * Throws RenderError: NO_UNSUBSCRIBE (omnisend without exactly one [[unsubscribe_link]]), NO_OPT_OUT (gmail),
 * TOO_LARGE (over EMAIL_LIMITS.htmlBytes).
 */
export function renderEmail(doc, ctx) {
  const { doc: d, problems } = normalizeDoc(doc);
  const rc = contextFor(d, ctx);
  if (problems.length) warn(rc, 'INVALID_DOC');
  const t = rc.t;
  const box = { width: t.width - 2 * rc.space.side, side: rc.space.side };
  const unsub = unsubscribeFor(ctx, rc);
  const rows = d.blocks.map((b) => blockHtml(b, rc, box)).filter(Boolean);
  const header = headerHtml(ctx, rc, box);
  const top = header || `<tr>\n<td style="padding:${Math.round(rc.space.gap / 2) + 8}px 0 0;font-size:0;line-height:0;">&nbsp;</td>\n</tr>`;
  const footer = footerHtml(ctx, rc, box, unsub);
  const subject = escapeHtml(String(ctx.subject ?? ''));
  const preheader = String(ctx.preheader ?? '').trim();
  const msoFont = t.font === 'georgia' || t.font === 'system' ? (t.font === 'georgia' ? 'Georgia,serif' : 'Arial,sans-serif') : 'Arial,sans-serif';
  const radius = Math.min(t.radius, 16);
  const html = [
    '<!doctype html>',
    '<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="x-apple-disable-message-reformatting">',
    '<meta name="color-scheme" content="light">',
    '<meta name="supported-color-schemes" content="light">',
    `<title>${subject}</title>`,
    `<!--[if mso]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><style>body,table,td,p,a,h1,h2,h3,li{font-family:${msoFont}!important;}</style><![endif]-->`,
    `<style>\n${[...RESET, ...rc.styles].join('\n')}\n</style>`,
    '</head>',
    `<body style="margin:0;padding:0;background-color:${t.bg};">`,
    preheader ? `<div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${t.bg};opacity:0;">${escapeHtml(preheader)}</div><div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>` : '',
    `<table ${TABLE} width="100%" bgcolor="${t.bg}" style="background-color:${t.bg};">`,
    '<tr>',
    '<td align="center" style="padding:24px 12px;">',
    `<!--[if mso]><table ${TABLE} width="${t.width}" align="center"><tr><td><![endif]-->`,
    `<table ${TABLE} width="100%" bgcolor="${t.paper}" style="width:100%;max-width:${t.width}px;background-color:${t.paper};border-radius:${radius}px;border-collapse:separate;">`,
    top,
    ...rows,
    footer,
    '</table>',
    '<!--[if mso]></td></tr></table><![endif]-->',
    '</td>',
    '</tr>',
    '</table>',
    '</body>',
    '</html>',
  ]
    .filter((x) => x !== '')
    .join('\n');
  if (ctx.target === 'omnisend' && html.split(OMNISEND_UNSUBSCRIBE).length !== 2) throw new RenderError('NO_UNSUBSCRIBE', 'The Omnisend email must carry exactly one unsubscribe link.');
  const bytes = byteLength(html);
  if (bytes > EMAIL_LIMITS.htmlBytes) throw new RenderError('TOO_LARGE', `This email is too big: ${Math.ceil(bytes / 1024)} KB, and at most ${EMAIL_LIMITS.htmlBytes / 1024} KB fit.`, { bytes, limit: EMAIL_LIMITS.htmlBytes });
  if (bytes > EMAIL_LIMITS.warnBytes) warn(rc, 'GMAIL_CLIP');
  const text = textFor(d, ctx, rc, unsub);
  return { html, text, warnings: [...rc.warnings], bytes };
}

// ───────────── the plain-text part ─────────────

const stripHtml = (html) =>
  decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();

function blockText(b, rc) {
  switch (b.type) {
    case 'heading':
      return mergeText(b.text, rc).trim();
    case 'text':
      return parseParagraphs(b.text, !!b.plain)
        .map((p) => (p.kind === 'ul' ? p.items.map((it) => `- ${inlineText(parseInline(it), rc)}`).join('\n') : p.lines.map((l) => (b.plain ? mergeText(l, rc) : inlineText(parseInline(l), rc))).join('\n')))
        .join('\n\n');
    case 'button': {
      if (!b.label.trim()) return '';
      const href = hrefFor(b.link, rc);
      return /^https?:\/\//.test(href) ? `${b.label}: ${href}` : b.label;
    }
    case 'image':
      return b.link && b.src ? (() => {
        const href = hrefFor(b.link, rc);
        return /^https?:\/\//.test(href) ? `${b.alt}: ${href}` : '';
      })() : '';
    case 'columns':
      return b.cols.map((c) => c.blocks.map((x) => blockText(x, rc)).filter(Boolean).join('\n\n')).filter(Boolean).join('\n\n');
    case 'offer': {
      if (!b.offerId) return '';
      const href = buyHref(b.offerId, rc);
      return [[b.title, b.price].filter(Boolean).join(' — '), b.blurb ? mergeText(b.blurb, rc) : '', /^https?:\/\//.test(href) ? `${b.buttonLabel}: ${href}` : b.buttonLabel].filter(Boolean).join('\n');
    }
    case 'video': {
      const href = hrefFor(b.link, rc);
      return /^https?:\/\//.test(href) ? `${b.caption ? mergeText(b.caption, rc) : 'Watch the video'}: ${href}` : '';
    }
    case 'social':
      return b.links.map((l) => ({ ...l, href: safeHref(l.url) })).filter((l) => l.href).map((l) => `${SOCIAL_LABELS[l.platform]}: ${l.href}`).join('\n');
    case 'divider':
      return b.style === 'line' ? '---' : '';
    case 'custom': {
      let html;
      try {
        html = sanitizeEmailHtml(b.html, { imageAllowed: rc.imageAllowed }).html;
      } catch {
        return '';
      }
      return mergeText(stripHtml(html.replace(/<img[^>]*>/g, '')), rc);
    }
    default:
      return '';
  }
}

function textFor(d, ctx, rc, unsub) {
  const parts = d.blocks.map((b) => blockText(b, rc)).filter((s) => s.trim());
  const note = String(ctx.footerNote ?? '').trim() || 'You’re receiving this because you signed up.';
  const footer = [note];
  const href = unsub.plainHref ?? unsub.href;
  if (ctx.target === 'preview') footer.push('Unsubscribe');
  else if (href) footer.push(`Unsubscribe: ${href}`);
  else footer.push(unsub.note);
  if (ctx.target === 'gmail' && String(ctx.postalAddress ?? '').trim()) footer.push(String(ctx.postalAddress).trim());
  return `${[...parts, '--', footer.join('\n')].join('\n\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/**
 * The plain-text part alone (Gmail's multipart, CSV and .txt exports). Same ctx as renderEmail. opts.footer false:
 * the words only, no footer (the app's Copy all and CSV body; only for the export and preview targets).
 */
export function renderText(doc, ctx, { footer = true } = {}) {
  const { doc: d } = normalizeDoc(doc);
  const rc = contextFor(d, ctx);
  if (!footer && (ctx.target === 'export' || ctx.target === 'preview')) {
    return `${d.blocks.map((b) => blockText(b, rc)).filter((x) => x.trim()).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
  }
  const unsub = unsubscribeFor(ctx, rc);
  return textFor(d, ctx, rc, unsub);
}

/** Whether a doc has any custom block (the app notes that custom HTML may not look right in every inbox). */
export function hasCustomBlocks(doc) {
  let found = false;
  eachBlock(doc, (b) => {
    if (b?.type === 'custom') found = true;
  });
  return found;
}
