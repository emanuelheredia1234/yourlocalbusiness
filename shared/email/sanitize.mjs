// Custom HTML and CSS in emails (P5 §5): an allowlist sanitizer with no DOM, so the server runs the same code as
// the app. sanitizeEmailHtml walks the markup with a small tokenizer (tags, attributes, text, comments) and writes
// back only allowed tags with allowed, re-quoted attributes; sanitizeEmailCss parses rules and scopes them to one
// block. Neither ever cuts content to fit: output over its limit is refused (SanitizeError TOO_LARGE).
//
// Only the renderer (render.mjs) may write Outlook conditional comments: every comment here is removed. Omnisend's
// [[…]] tags in content are escaped to text, so content can't fake or move the unsubscribe link.

import { EMAIL_LIMITS, byteLength } from './blocks.mjs';

export class SanitizeError extends Error {
  constructor(code, message, data = {}) {
    super(message);
    this.name = 'SanitizeError';
    this.code = code;
    Object.assign(this, data);
  }
}

/** The prefix every class in custom HTML gets (and every class selector in its CSS), so it can't hit the renderer's. */
export const CLASS_PREFIX = 'u-';

const KEEP = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'div', 'span', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sup', 'sub', 'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'center', 'font']);
const VOID = new Set(['br', 'hr', 'img', 'col', 'input', 'meta', 'link', 'base', 'source', 'track', 'embed', 'area', 'wbr', 'param', 'keygen', 'frame', 'basefont', 'bgsound']);
/** Removed with everything inside them, by what the owner is told was removed. */
const DROP = new Map([
  ['script', 'script'],
  ['style', 'style'],
  ['iframe', 'iframe'],
  ['frame', 'iframe'],
  ['frameset', 'iframe'],
  ['object', 'object'],
  ['embed', 'object'],
  ['applet', 'object'],
  ['noscript', 'hidden'],
  ['template', 'hidden'],
  ['svg', 'svg'],
  ['math', 'svg'],
  ['form', 'form'],
  ['input', 'form'],
  ['button', 'form'],
  ['select', 'form'],
  ['textarea', 'form'],
  ['video', 'media'],
  ['audio', 'media'],
  ['source', 'media'],
  ['track', 'media'],
  ['canvas', 'media'],
  ['link', 'meta'],
  ['meta', 'meta'],
  ['base', 'meta'],
  ['title', 'meta'],
  ['head', 'meta'],
  ['xmp', 'hidden'],
  ['noembed', 'hidden'],
  ['noframes', 'hidden'],
  ['plaintext', 'hidden'],
  ['portal', 'iframe'],
  ['xml', 'meta'],
]);
/** Their content is raw text up to their end tag, never markup. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
/** Dropped, their content kept (no element for them). */
const UNWRAP = new Set(['html', 'body']);
const TABLE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col']);
const ALIGN_TAGS = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'center', 'hr']);

const WORDS = {
  script: ['script', 'scripts'],
  style: ['style block', 'style blocks'],
  iframe: ['frame', 'frames'],
  object: ['embedded object', 'embedded objects'],
  hidden: ['hidden part', 'hidden parts'],
  svg: ['drawing', 'drawings'],
  form: ['form or form field', 'forms or form fields'],
  media: ['video or audio', 'videos or audio'],
  meta: ['page setting', 'page settings'],
  comment: ['comment', 'comments'],
  handler: ['event handler', 'event handlers'],
  image: ['outside image', 'outside images'],
  link: ['unsafe link', 'unsafe links'],
  css: ['style rule', 'style rules'],
  font: ['web font', 'web fonts'],
  attribute: ['other attribute', 'other attributes'],
};
const ORDER = Object.keys(WORDS);
/** "2 scripts", "1 outside image" … in a fixed order, from the counts. */
export function removedNotes(removed) {
  return ORDER.filter((k) => removed[k] > 0).map((k) => `${removed[k]} ${WORDS[k][removed[k] === 1 ? 0 : 1]}`);
}

// ───────────── entities ─────────────

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', euro: '€', pound: '£', yen: '¥', cent: '¢', times: '×', divide: '÷', zwnj: '‌', zwj: '‍', shy: '­', laquo: '«', raquo: '»', deg: '°', para: '¶', sect: '§', larr: '←', rarr: '→', uarr: '↑', darr: '↓', check: '✓', star: '☆', hearts: '♥', lbrack: '[', rbrack: ']', lsqb: '[', rsqb: ']', lbrace: '{', rbrace: '}', colon: ':', Tab: '\t', NewLine: '\n' };

/** Text with its character references decoded once (unknown names stay as written; bad numbers become U+FFFD). */
export function decodeEntities(s) {
  return String(s).replace(/&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,9}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (whole, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    if (!Object.hasOwn(NAMED, ref)) return whole;
    // without its ; only the few names browsers take that way
    return whole.endsWith(';') || ['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg'].includes(ref) ? NAMED[ref] : whole;
  });
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '[': '&#91;', ']': '&#93;' };
/** Text or an attribute value, escaped for HTML ([ and ] too: no Omnisend [[tag]] can be written by content). */
export const escapeHtml = (s) => String(s).replace(/[&<>"'[\]]/g, (c) => ESC[c]);
// C0 controls (but tab and newline), DEL and C1 controls
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

// ───────────── URLs ─────────────

/**
 * An address a link may go to: https, or http with no user name or password; mailto: and tel: when allowed; a
 * #fragment when allowed (the app's preview anchors). The address as written back, or null.
 */
export function safeHref(value, { mailto = false, fragment = false } = {}) {
  const v = String(value ?? '').replace(CONTROLS, '').trim();
  if (!v || v.length > EMAIL_LIMITS.url) return null;
  if (fragment && /^#[A-Za-z0-9_-]{0,64}$/.test(v)) return v;
  const squashed = v.replace(/[\s\u0000- ]+/g, '').toLowerCase();
  if (/^(javascript|vbscript|data|file|blob):/.test(squashed)) return null;
  if (mailto && /^mailto:[^\s<>"]+@[^\s<>"]+$/i.test(v)) return v;
  if (mailto && /^tel:\+?[0-9().\s-]{3,30}$/i.test(v)) return v;
  let url;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || !url.hostname) return null;
  return url.href;
}

/** An image address: https only. */
export function safeImageSrc(value) {
  const href = safeHref(value);
  return href && href.startsWith('https://') ? href : null;
}

/** Link tokens the renderer resolves inside custom HTML hrefs. */
const HREF_TOKEN = /^\{\{\s*(lead_magnet_link|product_link|buy:[A-Za-z0-9_-]{22})\s*\}\}$/;
const IMG_TOKEN = /^\{\{\s*(img-[1-9]\d?)\s*\}\}$/;

// ───────────── inline styles ─────────────

const STYLE_PROPS = new Set(['color', 'background-color', 'background', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration', 'text-transform', 'vertical-align', 'width', 'max-width', 'min-width', 'height', 'max-height', 'border-collapse', 'display', 'mso-line-height-rule', 'mso-hide']);
const BOX_PROP = /^(padding|margin)(-(top|right|bottom|left))?$/;
const BORDER_PROP = /^border(-(top|right|bottom|left))?(-(width|style|color))?$|^border(-(top|bottom)-(left|right))?-radius$/;
const DISPLAYS = new Set(['block', 'inline', 'inline-block', 'none', 'table', 'table-cell']);
const BANNED_VALUE = /url\s*\(|expression\s*\(|javascript:|vbscript:|@import|behavior|-moz-binding|var\s*\(|image\s*\(|image-set\s*\(|attr\s*\(|\\|<|>|\/\*|position/i;
const COLOR_VALUE = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\(\s*[0-9.%\s,/]+\)|[a-z]{3,20})$/i;

/** Split CSS declarations on ; outside quotes and brackets. */
function splitDeclarations(css) {
  const out = [];
  let cur = '';
  let quote = '';
  let depth = 0;
  for (const ch of css) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && !depth) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * An inline style (or a CSS rule's declarations) with only the allowed properties and safe values.
 * !important is kept only with allowImportant (a custom block's @media rules).
 */
export function filterStyle(css, { allowImportant = false, count = () => {} } = {}) {
  const kept = [];
  for (const decl of splitDeclarations(String(css ?? ''))) {
    const at = decl.indexOf(':');
    if (at < 1) {
      if (decl.trim()) count('css');
      continue;
    }
    const prop = decl.slice(0, at).trim().toLowerCase();
    let value = decl.slice(at + 1).replace(CONTROLS, '').trim();
    const allowed = STYLE_PROPS.has(prop) || BOX_PROP.test(prop) || BORDER_PROP.test(prop);
    if (!allowed || !value || value.length > 300 || BANNED_VALUE.test(value)) {
      count('css');
      continue;
    }
    const important = /!\s*important\s*$/i.test(value);
    value = value.replace(/!\s*important\s*$/i, '').trim();
    if (!value || /!/.test(value)) {
      count('css');
      continue;
    }
    let name = prop;
    if (prop === 'display' && !DISPLAYS.has(value.toLowerCase())) {
      count('css');
      continue;
    }
    if (prop === 'background') {
      // colour only: no images, no shorthand
      if (!COLOR_VALUE.test(value)) {
        count('css');
        continue;
      }
      name = 'background-color';
    }
    if (prop === 'mso-hide' && value.toLowerCase() !== 'all') {
      count('css');
      continue;
    }
    if (prop === 'mso-line-height-rule' && !['exactly', 'at-least'].includes(value.toLowerCase())) {
      count('css');
      continue;
    }
    kept.push(`${name}:${value}${important && allowImportant ? '!important' : ''}`);
  }
  return kept.join(';');
}

// ───────────── the tokenizer ─────────────

/**
 * The markup as tokens: { type: 'text', v } | { type: 'start', name, attrs: [[name, value]], selfClosing } |
 * { type: 'end', name } | { type: 'comment' } | { type: 'raw', name, v } (a raw-text element's content).
 * Names are lower case; attribute values are as written (entities not decoded yet).
 */
export function* tokenize(src) {
  const n = src.length;
  let i = 0;
  const tagName = /[^\s/>]*/y;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      yield { type: 'text', v: src.slice(i) };
      return;
    }
    if (lt > i) yield { type: 'text', v: src.slice(i, lt) };
    i = lt;
    const next = src[i + 1] ?? '';
    if (src.startsWith('<!--', i)) {
      // <!--> and <!---> are empty comments
      const close = src.startsWith('<!-->', i) ? i + 2 : src.startsWith('<!--->', i) ? i + 3 : src.indexOf('-->', i + 4);
      i = close === -1 ? n : close + 3;
      yield { type: 'comment' };
      continue;
    }
    if (next === '!') {
      if (src.startsWith('<![CDATA[', i)) {
        const close = src.indexOf(']]>', i);
        i = close === -1 ? n : close + 3;
      } else {
        const close = src.indexOf('>', i);
        const isDoctype = /^<!doctype/i.test(src.slice(i, i + 9));
        i = close === -1 ? n : close + 1;
        if (isDoctype) continue;
      }
      yield { type: 'comment' };
      continue;
    }
    if (next === '?') {
      const close = src.indexOf('>', i);
      i = close === -1 ? n : close + 1;
      yield { type: 'comment' };
      continue;
    }
    if (next === '/') {
      if (!/[A-Za-z]/.test(src[i + 2] ?? '')) {
        // a bogus comment (</ followed by no name): up to the next >
        const close = src.indexOf('>', i);
        i = close === -1 ? n : close + 1;
        yield { type: 'comment' };
        continue;
      }
      tagName.lastIndex = i + 2;
      const name = tagName.exec(src)[0].toLowerCase();
      const close = src.indexOf('>', tagName.lastIndex);
      i = close === -1 ? n : close + 1;
      if (close !== -1) yield { type: 'end', name };
      continue;
    }
    if (!/[A-Za-z]/.test(next)) {
      yield { type: 'text', v: '<' };
      i += 1;
      continue;
    }
    // a start tag: its name, then its attributes up to an unquoted >
    tagName.lastIndex = i + 1;
    const name = tagName.exec(src)[0].toLowerCase();
    let j = tagName.lastIndex;
    const attrs = [];
    let selfClosing = false;
    let ended = false;
    while (j < n) {
      while (j < n && /[\s/]/.test(src[j])) {
        if (src[j] === '/') selfClosing = src[j + 1] === '>';
        j++;
      }
      if (j >= n) break;
      if (src[j] === '>') {
        ended = true;
        j++;
        break;
      }
      selfClosing = false;
      let k = j;
      // an attribute's name: anything up to whitespace, /, > or = (the first character may be =)
      k++;
      while (k < n && !/[\s/>=]/.test(src[k])) k++;
      const attrName = src.slice(j, k).toLowerCase();
      j = k;
      while (j < n && /\s/.test(src[j])) j++;
      let value = '';
      if (src[j] === '=') {
        j++;
        while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === '"' || q === "'") {
          const close = src.indexOf(q, j + 1);
          if (close === -1) {
            j = n;
            break;
          }
          value = src.slice(j + 1, close);
          j = close + 1;
        } else {
          let e = j;
          while (e < n && !/[\s>]/.test(src[e])) e++;
          value = src.slice(j, e);
          j = e;
        }
      }
      attrs.push([attrName, value]);
    }
    if (!ended) return; // a tag cut off at the end: nothing after it is markup we can trust
    i = j;
    yield { type: 'start', name, attrs, selfClosing };
    if (RAW_TEXT.has(name) && !selfClosing) {
      const end = new RegExp(`</${name}(?=[\\s/>])`, 'ig');
      end.lastIndex = i;
      const m = end.exec(src);
      if (!m) {
        yield { type: 'raw', name, v: src.slice(i) };
        return;
      }
      yield { type: 'raw', name, v: src.slice(i, m.index) };
      const close = src.indexOf('>', m.index);
      i = close === -1 ? n : close + 1;
      yield { type: 'end', name };
    }
  }
}

// ───────────── HTML ─────────────

const NUM = /^\d{1,4}%?$/;
const SMALL = /^\d{1,3}$/;

function cleanClass(value) {
  const out = [];
  for (const t of String(value).split(/\s+/)) {
    if (!t || !/^-?[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(t) || t.toLowerCase().startsWith('ylb-')) continue;
    const c = t.startsWith(CLASS_PREFIX) ? t : `${CLASS_PREFIX}${t}`;
    if (!out.includes(c)) out.push(c);
    if (out.length >= 10) break;
  }
  return out.join(' ');
}

/**
 * Custom or agent-made HTML as email-safe HTML. opts: imageAllowed(src) → whether an https image may stay (default:
 * any https image), maxBytes (default 20 KB), collectStyles (also return the <style> elements' CSS as `styles`).
 * → { html, notes, removed, styles? }. Throws SanitizeError TOO_LARGE when the result is over maxBytes.
 */
export function sanitizeEmailHtml(html, opts = {}) {
  const imageAllowed = typeof opts.imageAllowed === 'function' ? opts.imageAllowed : () => true;
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : EMAIL_LIMITS.customHtmlBytes;
  const src = String(html ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const removed = {};
  const count = (k, n = 1) => {
    removed[k] = (removed[k] ?? 0) + n;
  };
  const out = [];
  const stack = []; // { name: as written (lower case), tag: as output }
  const styles = [];
  let skip = null; // { name, depth }

  for (const tok of tokenize(src)) {
    if (skip) {
      if (tok.type === 'raw' && tok.name === 'style' && opts.collectStyles) styles.push(tok.v);
      if (tok.type === 'start' && tok.name === skip.name && !tok.selfClosing && !VOID.has(tok.name)) skip.depth++;
      else if (tok.type === 'end' && tok.name === skip.name && --skip.depth === 0) skip = null;
      continue;
    }
    if (tok.type === 'text') {
      out.push(escapeHtml(decodeEntities(tok.v).replace(CONTROLS, '')));
      continue;
    }
    if (tok.type === 'comment') {
      count('comment');
      continue;
    }
    if (tok.type === 'raw') continue;
    if (tok.type === 'end') {
      if (VOID.has(tok.name)) continue;
      const at = stack.map((e) => e.name).lastIndexOf(tok.name);
      if (at === -1) continue; // an end tag with no start tag
      while (stack.length > at) out.push(`</${stack.pop().tag}>`);
      continue;
    }
    // a start tag
    const name = tok.name;
    if (DROP.has(name)) {
      const kind = DROP.get(name);
      count(kind === 'meta' && tok.attrs.some(([k, v]) => k === 'rel' && /stylesheet|preload|font/i.test(v)) ? 'font' : kind);
      if (!VOID.has(name) && !tok.selfClosing) skip = { name, depth: 1 };
      continue;
    }
    if (UNWRAP.has(name)) continue;
    const tag = KEEP.has(name) ? (name === 'font' ? 'span' : name) : 'div';
    const attrs = attributesFor(tag, name, tok.attrs, { imageAllowed, count });
    if (attrs === null) continue; // an image that may not stay
    out.push(`<${tag}${attrs}>`);
    if (!VOID.has(tag)) stack.push({ name, tag });
  }
  while (stack.length) out.push(`</${stack.pop().tag}>`);
  const result = out.join('');
  const bytes = byteLength(result);
  if (bytes > maxBytes) throw new SanitizeError('TOO_LARGE', `This HTML is too big: ${Math.ceil(bytes / 1024)} KB, and at most ${Math.floor(maxBytes / 1024)} KB fit.`, { bytes, limit: maxBytes });
  return { html: result, notes: removedNotes(removed), removed, ...(opts.collectStyles ? { styles: styles.join('\n') } : {}) };
}

/** The attributes a kept tag may carry, in a fixed order, re-quoted and escaped; null drops the element (an image). */
function attributesFor(tag, original, list, { imageAllowed, count }) {
  const given = new Map();
  for (const [k, v] of list) {
    if (k.startsWith('on')) {
      count('handler');
      continue;
    }
    if (!given.has(k)) given.set(k, decodeEntities(v).replace(CONTROLS, ''));
  }
  const out = [];
  const put = (k, v) => out.push(` ${k}="${escapeHtml(v)}"`);
  const raw = (k, v) => out.push(` ${k}="${v}"`);
  const used = new Set();
  const take = (k) => {
    used.add(k);
    return given.get(k);
  };
  if (tag === 'a') {
    const href = take('href');
    if (href !== undefined) {
      const tokenMatch = HREF_TOKEN.exec(href.trim());
      const safe = tokenMatch ? `{{${tokenMatch[1]}}}` : href.trim() === '#' ? '#' : safeHref(href, { mailto: true });
      if (safe) {
        raw('href', escapeHtml(safe));
        if (safe !== '#') {
          raw('target', '_blank');
          raw('rel', 'noopener');
        }
      } else {
        raw('href', '#');
        count('link');
      }
    }
  }
  if (tag === 'img') {
    const srcValue = (take('src') ?? '').trim();
    const token = IMG_TOKEN.exec(srcValue);
    if (token) raw('src', `{{${token[1]}}}`);
    else {
      const safe = safeImageSrc(srcValue);
      if (!safe || !imageAllowed(safe)) {
        count('image');
        return null;
      }
      put('src', safe);
    }
    put('alt', [...(take('alt') ?? '')].slice(0, 300).join(''));
    for (const k of ['width', 'height']) {
      const v = (take(k) ?? '').replace(/px$/i, '').trim();
      if (NUM.test(v)) put(k, v);
    }
    raw('border', '0');
  }
  if (original === 'font') {
    // <font color face> → a span's style
    const color = take('color');
    const face = take('face');
    const style = filterStyle([color ? `color:${color}` : '', face ? `font-family:${face}` : '', given.get('style') ?? ''].filter(Boolean).join(';'), { count });
    used.add('style');
    used.add('size');
    if (style) put('style', style);
  }
  if (TABLE_TAGS.has(tag)) {
    const role = take('role');
    if (role === 'presentation' || role === 'none') raw('role', role);
    for (const k of ['width', 'height']) {
      const v = (take(k) ?? '').replace(/px$/i, '').trim();
      if (NUM.test(v)) put(k, v);
    }
    const align = (take('align') ?? '').toLowerCase();
    if (['left', 'right', 'center', 'justify'].includes(align)) raw('align', align);
    const valign = (take('valign') ?? '').toLowerCase();
    if (['top', 'middle', 'bottom', 'baseline'].includes(valign)) raw('valign', valign);
    const bg = (take('bgcolor') ?? '').trim();
    if (COLOR_VALUE.test(bg)) put('bgcolor', bg);
    for (const k of ['border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan']) {
      const v = (take(k) ?? '').trim();
      if (SMALL.test(v)) put(k, v);
    }
  } else if (ALIGN_TAGS.has(tag)) {
    const align = (take('align') ?? '').toLowerCase();
    if (['left', 'right', 'center', 'justify'].includes(align)) raw('align', align);
  }
  if (original !== 'font' && given.has('style')) {
    const style = filterStyle(take('style'), { count });
    if (style) put('style', style);
  }
  if (given.has('class')) {
    const cls = cleanClass(take('class'));
    if (cls) put('class', cls);
  }
  const title = take('title');
  if (title) put('title', [...title].slice(0, 300).join(''));
  const dir = (take('dir') ?? '').toLowerCase();
  if (['ltr', 'rtl', 'auto'].includes(dir)) raw('dir', dir);
  const lang = take('lang') ?? '';
  if (/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/.test(lang)) raw('lang', lang);
  // anything else is dropped (ids, names, srcset, data-*, background, xlink:*, formaction…)
  for (const k of given.keys()) if (!used.has(k) && !['href', 'src', 'alt', 'width', 'height', 'align', 'valign', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'role', 'style', 'class', 'title', 'dir', 'lang', 'color', 'face', 'size'].includes(k)) count('attribute');
  return out.join('');
}

// ───────────── CSS ─────────────

const MEDIA_QUERY = /^[a-z0-9\s(),:.-]{1,200}$/i;
const MEDIA_FEATURES = new Set(['max-width', 'min-width', 'prefers-color-scheme']);
const MEDIA_WORDS = new Set(['screen', 'all', 'only', 'and', 'not']);

function mediaOk(query) {
  const q = query.trim();
  if (!MEDIA_QUERY.test(q)) return false;
  for (const m of q.matchAll(/\(\s*([a-z-]+)\s*:\s*([^)]*)\)/gi)) {
    if (!MEDIA_FEATURES.has(m[1].toLowerCase())) return false;
    if (m[1].toLowerCase() === 'prefers-color-scheme' ? !/^(light|dark)$/i.test(m[2].trim()) : !/^\d{1,4}(\.\d+)?(px|em|rem)$/i.test(m[2].trim())) return false;
  }
  const bare = q.replace(/\([^)]*\)/g, ' ').split(/[\s,]+/).filter(Boolean);
  return bare.every((w) => MEDIA_WORDS.has(w.toLowerCase()));
}

/** The block of { … } starting at s[i] === '{': its content and the index after its }, quotes respected. */
function readBlock(s, i) {
  let depth = 0;
  let quote = '';
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return { body: s.slice(i + 1, j), end: j + 1 };
  }
  return { body: s.slice(i + 1), end: s.length };
}

/** One selector, scoped; '' when it may not stay. */
function scopeSelector(sel, scope) {
  let s = sel.trim().replace(/\s+/g, ' ');
  if (!s || s.length > 200 || /[{};@\\"'`<]/.test(s)) return '';
  // the universal selector, outside attribute selectors
  if (/\*/.test(s.replace(/\[[^\]]*\]/g, ''))) return '';
  // class names get the custom HTML's prefix (outside attribute selectors)
  s = s.replace(/(\[[^\]]*\])|\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g, (whole, attr, cls) => (attr ? attr : `.${cls.startsWith(CLASS_PREFIX) ? cls : CLASS_PREFIX + cls}`));
  if (!scope) return s;
  // html, body and :root are the block itself
  const lead = /^(?:html|body|:root)(?:\s+(?:html|body|:root))*(?=$|[\s>+~.#:[])/i.exec(s);
  if (lead) {
    const rest = s.slice(lead[0].length);
    if (!rest.trim()) return scope;
    // body.dark → the scope with that class; body p → p inside the scope
    return /^[.#:[]/.test(rest) ? `${scope}${rest}` : `${scope} ${rest.trim()}`;
  }
  return `${scope} ${s}`;
}

function splitSelectors(prelude) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of prelude) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && !depth) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function cssRules(s, { scope, inMedia, count, notes }) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s;]/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === '}') {
      i++;
      continue;
    }
    if (s[i] === '@') {
      const m = /^@([A-Za-z-]+)/.exec(s.slice(i, i + 40));
      const name = (m?.[1] ?? '').toLowerCase();
      let j = i + 1;
      let quote = '';
      while (j < s.length) {
        const ch = s[j];
        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '{' || ch === ';') break;
        j++;
      }
      const prelude = s.slice(i + 1 + name.length, j);
      if (s[j] !== '{') {
        // @import, @charset, @namespace …
        notes.add(name === 'import' ? 'outside style sheets (@import)' : `@${name || 'rule'} rules`);
        count(name === 'import' ? 'font' : 'css');
        i = j + 1;
        continue;
      }
      const { body, end } = readBlock(s, j);
      i = end;
      if (name === 'media' && !inMedia && mediaOk(prelude)) {
        const inner = cssRules(body, { scope, inMedia: true, count, notes });
        if (inner.length) out.push(`@media ${prelude.trim().replace(/\s+/g, ' ')}{${inner.join('')}}`);
      } else {
        notes.add(name === 'font-face' ? 'web fonts (@font-face)' : `@${name || 'rule'} rules`);
        count(name === 'font-face' ? 'font' : 'css');
      }
      continue;
    }
    let j = i;
    let quote = '';
    while (j < s.length) {
      const ch = s[j];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{' || ch === '}' || ch === ';') break;
      j++;
    }
    if (s[j] !== '{') {
      count('css');
      i = j + 1;
      continue;
    }
    const prelude = s.slice(i, j);
    const { body, end } = readBlock(s, j);
    i = end;
    const sels = splitSelectors(prelude).map((x) => scopeSelector(x, scope)).filter(Boolean);
    const decls = filterStyle(body, { allowImportant: inMedia, count });
    if (!sels.length || !decls) {
      count('css');
      continue;
    }
    out.push(`${sels.join(',')}{${decls}}`);
  }
  return out;
}

/**
 * A custom block's CSS: allowed declarations only, @media (max-width, min-width, prefers-color-scheme) kept, every
 * other at-rule dropped, each selector put under `scope` (e.g. '.ylb-c-b_xxxxxxxxxx'; html, body and :root become the
 * scope itself; '*' is dropped) and class names given the custom HTML's prefix. scope '' cleans without scoping (what
 * the app stores; the renderer scopes). → { css, notes }. Throws SanitizeError TOO_LARGE over maxBytes (8 KB).
 */
export function sanitizeEmailCss(css, opts = {}) {
  const scope = typeof opts.scope === 'string' ? opts.scope : '';
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : EMAIL_LIMITS.customCssBytes;
  const removed = {};
  const count = (k, n = 1) => {
    removed[k] = (removed[k] ?? 0) + n;
  };
  const extra = new Set();
  let s = String(css ?? '').replace(/\r\n?/g, '\n').replace(CONTROLS, '').replace(/<!--|-->/g, '');
  // comments out, an unclosed one to the end
  s = s.replace(/\/\*[\s\S]*?(\*\/|$)/g, '');
  const rules = cssRules(s, { scope, inMedia: false, count, notes: extra });
  const result = rules.join('\n');
  const bytes = byteLength(result);
  if (bytes > maxBytes) throw new SanitizeError('TOO_LARGE', `This CSS is too big: ${Math.ceil(bytes / 1024)} KB, and at most ${Math.floor(maxBytes / 1024)} KB fit.`, { bytes, limit: maxBytes });
  return { css: result, notes: [...removedNotes(removed), ...extra] };
}
