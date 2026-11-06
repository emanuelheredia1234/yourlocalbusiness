// A page from Manus or Viktor (one HTML file), cleaned before the app keeps it: as a Code & assets asset
// (HTML, CSS and one script) or as the SEO page's HTML mode (HTML and CSS, no JavaScript at all). The page is
// untrusted: it's parsed with DOMParser (an inert document: nothing in it runs or loads), and only what the
// app can use safely is kept. Comments go (they'd reach the app's code-edit AI as code), so do frames,
// plugins, outside stylesheets and fonts, <base>, <meta> and every inline event handler; javascript:,
// vbscript: and data: addresses are taken out; images are only the owner's own ({{img-N}} tokens). Forms that
// Email → Leads can receive post to {{lead-action}} (an SEO page keeps at most one); an asset's other forms go,
// unless they send to the owner's own site or only its script uses them.
//
// Template text here never holds a literal closing script tag, and comment openers are written '\x3C!--'
// (the claude.ai build refuses a bundle that has them): comments are handled through the DOM only.

import type { BuildTarget } from '@/lib/agentTypes';
import { MAX_HTML_BYTES } from '@/lib/publish';
import { keepOwnImages, keptOwnImagesNote } from '@/ai/codeImages';

export type ImportResult =
  | { ok: true; page: { html: string; css: string; js: string; title: string; description: string; notes: string[]; bytes: number; hasLeadForm: boolean } }
  | { ok: false; reason: 'too_big' | 'not_html' | 'empty'; message: string };

/** Above this, the page still imports, with a note: it makes every save of the project bigger. */
export const LARGE_PAGE_BYTES = 300 * 1024;

import { HONEYPOT, LEAD_EXTRA_NAMES, LEAD_FIELDS, LEAD_PAYLOAD_MAX } from '@/lib/leadFields';
import { LEAD_ACTION } from '@/lib/leadAction';

/** The fields a published page's form may send (server/leads.mjs LEAD_MAX), with their limits. */
export { LEAD_FIELDS, LEAD_PAYLOAD_MAX, LEAD_ACTION };
const HONEYPOT_CSS = '.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}';
/** Every limit a form's field gets as maxlength. */
const FIELD_MAX: Readonly<Record<string, number>> = { ...LEAD_FIELDS, ...LEAD_PAYLOAD_MAX };

/** Elements that never stay: frames and plugins, the document's base address, meta tags, links, noscript. */
const REMOVED = ['iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal', 'base', 'meta', 'link', 'noscript', 'noembed', 'noframes'];
/** Those worth telling the owner about. */
const FRAMES = new Set(['iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal']);
/** Attributes that hold an address: a javascript:, vbscript: or data: one is taken out (a data:image/ picture may stay in src). */
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'background', 'data', 'codebase', 'cite', 'longdesc', 'manifest', 'icon']);
/** SVG animation values, which can set an address (<set attributeName="href" to="javascript:…">). */
const ANIMATION_ATTRS = new Set(['to', 'from', 'values', 'by']);
/** Body attributes that are the window's own handlers (onload on <body> is window.onload). */
const WINDOW_EVENTS = new Set(['afterprint', 'beforeprint', 'beforeunload', 'hashchange', 'languagechange', 'message', 'messageerror', 'offline', 'online', 'pagehide', 'pageshow', 'popstate', 'rejectionhandled', 'storage', 'unhandledrejection', 'unload', 'blur', 'error', 'focus', 'load', 'resize', 'scroll']);
/** A classic script's types (empty is classic too); anything else is a module, data or a template. */
const JS_TYPES = new Set(['text/javascript', 'application/javascript', 'application/ecmascript', 'text/ecmascript', 'application/x-javascript', 'text/jscript', 'text/livescript']);

const TOKEN = /\{\{\s*img-(\d+)\s*\}\}/g;
const LT = String.fromCharCode(60);

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;
const oneLine = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace('#', String(n)));

/**
 * The text with each {{img-N}} token swapped for its new key in `map` (keys not in the map stay as they are).
 * One pass, so swapping two keys (img-1 ↔ img-2) is safe.
 */
export function rewriteImageTokens(s: string, map: Record<string, string>): string {
  return s.replace(TOKEN, (whole, n: string) => {
    const to = map[`img-${Number(n)}`];
    return to ? `{{${to}}}` : whole;
  });
}

/** An address with what browsers ignore taken out (spaces, tabs, line breaks, control characters), lower-case. */
const bareUrl = (v: string) => v.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
const DANGEROUS = /^(?:javascript|vbscript|data):/;

/** Whether an attribute's address must go: javascript:, vbscript: or data: (a data:image/ picture may stay in src). */
function badUrl(attr: string, value: string): boolean {
  const v = bareUrl(value);
  if (!DANGEROUS.test(v)) return false;
  return !(attr === 'src' && v.startsWith('data:image/'));
}

/** Every element under `root`, template contents included (a template's content isn't in the tree): `inTemplate` says which. */
function elementsOf(root: ParentNode): { el: Element; inTemplate: boolean }[] {
  const out: { el: Element; inTemplate: boolean }[] = [];
  const visit = (node: ParentNode, inTemplate: boolean) => {
    for (const el of Array.from(node.children ?? [])) {
      out.push({ el, inTemplate });
      visit(el, inTemplate);
      if (el.localName === 'template') visit((el as HTMLTemplateElement).content, true);
    }
  };
  visit(root, false);
  return out;
}

/** Every text node under `node`. */
function textNodesOf(node: Node): Text[] {
  const out: Text[] = [];
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) out.push(child as Text);
    else out.push(...textNodesOf(child));
  }
  return out;
}

/** Remove every comment under `node` (template contents too). */
function removeComments(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 8) child.parentNode?.removeChild(child);
    else {
      removeComments(child);
      if ((child as Element).localName === 'template') removeComments((child as HTMLTemplateElement).content);
    }
  }
}

/**
 * Script text that stays one script when it's written back between script tags: a comment opener or a script
 * tag inside it (only possible in a string, a regular expression or a comment) gets its "<" written as \x3C,
 * which is the same character there.
 */
export function safeScriptText(js: string): string {
  return js.replace(new RegExp(`${LT}(?=!--|/?script[\\s/>])`, 'gi'), '\\x3C');
}

/** A script that runs in the page as it is (inline, classic, not a fallback for old browsers). */
function isClassicInline(s: Element): boolean {
  const type = (s.getAttribute('type') ?? '').trim().toLowerCase();
  if (s.hasAttribute('src') || s.hasAttribute('href') || s.hasAttribute('xlink:href') || s.hasAttribute('nomodule')) return false;
  return type === '' || JS_TYPES.has(type);
}

const isJsonLd = (s: Element) => (s.getAttribute('type') ?? '').trim().toLowerCase() === 'application/ld+json';

/**
 * Whether a form can send to Email → Leads: only lead fields, a result or request (hidden inputs a script fills
 * in), the consent box, its kind, a lead magnet's id and the hidden field by name, and an email or a phone.
 */
export function formFits(form: Element): boolean {
  let contact = false;
  for (const c of Array.from(form.querySelectorAll('input, select, textarea, button'))) {
    const tag = c.localName;
    const type = (c.getAttribute('type') ?? '').toLowerCase();
    if (tag === 'button' || (tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(type))) continue;
    const name = c.getAttribute('name');
    if (!name) continue;
    if (name === HONEYPOT || LEAD_EXTRA_NAMES.includes(name)) continue;
    if (!(name in LEAD_FIELDS) && !(name in LEAD_PAYLOAD_MAX)) return false;
    if (name === 'email' || name === 'phone') contact = true;
  }
  return contact;
}

/**
 * A form that fits, made to send to Email → Leads: method post, action {{lead-action}} (publishing writes
 * /<slug>/lead), no other target, each field's limit as maxlength, and the app's own hidden field (a "website"
 * field the page had would make the server drop every lead).
 */
function toLeadForm(doc: Document, form: Element): void {
  form.setAttribute('method', 'post');
  form.setAttribute('action', LEAD_ACTION);
  for (const a of ['enctype', 'target', 'accept-charset', 'novalidate']) form.removeAttribute(a);
  for (const b of Array.from(form.querySelectorAll('[formaction], [formmethod], [formenctype], [formtarget]'))) ['formaction', 'formmethod', 'formenctype', 'formtarget'].forEach((a) => b.removeAttribute(a));
  for (const c of Array.from(form.querySelectorAll('input, textarea'))) {
    const name = c.getAttribute('name') ?? '';
    if (name in FIELD_MAX) c.setAttribute('maxlength', String(FIELD_MAX[name]));
  }
  for (const c of Array.from(form.querySelectorAll('input, select, textarea'))) {
    if (c.getAttribute('name') !== HONEYPOT) continue;
    const id = c.getAttribute('id');
    if (id) for (const l of Array.from(form.querySelectorAll('label'))) if (l.getAttribute('for') === id) l.remove();
    const label = c.closest('label');
    (label && form.contains(label) ? label : c).remove();
  }
  const hp = doc.createElement('div');
  hp.setAttribute('class', 'hp');
  hp.setAttribute('aria-hidden', 'true');
  const label = doc.createElement('label');
  label.append('Website ');
  const input = doc.createElement('input');
  input.setAttribute('type', 'text');
  input.setAttribute('name', HONEYPOT);
  input.setAttribute('tabindex', '-1');
  input.setAttribute('autocomplete', 'off');
  label.append(input);
  hp.append(label);
  form.prepend(hp);
}

/** Whether a form would send something by itself: named fields, and a POST or an address of its own (not "#"). */
function formSends(form: Element): boolean {
  const named = Array.from(form.querySelectorAll('input, select, textarea')).some((c) => !!c.getAttribute('name') && !['submit', 'button', 'reset', 'image'].includes((c.getAttribute('type') ?? '').toLowerCase()));
  if (!named) return false;
  const action = (form.getAttribute('action') ?? '').trim();
  return (form.getAttribute('method') ?? '').trim().toLowerCase() === 'post' || (!!action && action !== '#');
}

/** The host of an address, without "www." ('' when it isn't an http(s) address). */
function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase().replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

/** Outside stylesheets and fonts in CSS: @import rules, and @font-face blocks that load from another site. */
function cssWithoutOutside(css: string): { css: string; removed: number } {
  let removed = 0;
  const out = css
    .replace(/@import\b[^;{}]*;?/gi, () => {
      removed++;
      return '';
    })
    .replace(/@font-face\s*\{[^{}]*\}/gi, (block) => {
      if (!/url\(\s*["']?\s*(?:https?:)?\/\//i.test(block)) return block;
      removed++;
      return '';
    });
  return { css: out, removed };
}

/** The empty-page check: no words and no image left. */
function isEmpty(html: string): boolean {
  if (/\{\{\s*img-\d+\s*\}\}/.test(html)) return false;
  const text = html
    .replace(new RegExp(`${LT}(style|script)[\\s\\S]*?${LT}/\\1\\s*>`, 'gi'), ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ');
  return !text.trim();
}

/**
 * Clean a page from Manus or Viktor for the app: an asset (`target: 'asset'`: HTML, CSS and one classic
 * script) or the SEO page (`'seo'`: HTML and CSS, no JavaScript, at most one form that Email → Leads takes).
 * `imageKeys` are the owner's images sent with that request (the page shows them as {{img-N}}); `ownHost` is
 * the owner's website's host (an asset's form may send there). Nothing in the page runs while it's cleaned.
 */
export function importAgentHtml(raw: string, o: { target: BuildTarget; imageKeys: readonly string[]; fallbackTitle: string; ownHost?: string }): ImportResult {
  if (byteLength(raw) > MAX_HTML_BYTES) return { ok: false, reason: 'too_big', message: 'The page is over 1.5 MB, too big to use. Ask for a smaller page.' };
  if (!/<html|<!doctype/i.test(raw)) return { ok: false, reason: 'not_html', message: 'That reply isn’t a usable page: it isn’t an HTML document.' };
  const seo = o.target === 'seo';
  const notes: string[] = [];
  const doc = new DOMParser().parseFromString(raw, 'text/html');

  // 3. comments: anything in them would reach the code-edit AI as code
  removeComments(doc);

  // 4. its name and description (text only)
  const title = cut(oneLine(doc.querySelector('title')?.textContent) || oneLine(doc.querySelector('h1')?.textContent) || o.fallbackTitle, 80);
  const metaDescription = Array.from(doc.querySelectorAll('meta')).find((m) => (m.getAttribute('name') ?? '').trim().toLowerCase() === 'description');
  const description = cut(oneLine(metaDescription?.getAttribute('content')), 300);

  // 5. styles: every <style> (head and body) into one stylesheet; outside stylesheets and fonts go
  const styles = Array.from(doc.querySelectorAll('style'));
  let css = styles.map((s) => s.textContent ?? '').join('\n').trim();
  styles.forEach((s) => s.remove());
  let outside = Array.from(doc.querySelectorAll('link')).filter((l) => {
    const rel = (l.getAttribute('rel') ?? '').toLowerCase();
    return /\bstylesheet\b/.test(rel) || (/\bpreload\b/.test(rel) && (l.getAttribute('as') ?? '').toLowerCase() === 'font');
  }).length;
  const cleanedCss = cssWithoutOutside(css);
  css = cleanedCss.css.trim();
  outside += cleanedCss.removed;
  if (outside) notes.push('Took out a link to an outside stylesheet or font: the page uses only its own styles.');

  // 6. scripts: an asset keeps its inline classic scripts (as one script); an SEO page keeps none; JSON-LD never (the app writes its own)
  const scripts = Array.from(doc.querySelectorAll('script'));
  const kept: string[] = [];
  let dropped = 0;
  for (const s of scripts) {
    if (!isJsonLd(s)) {
      if (!seo && isClassicInline(s)) kept.push(s.textContent ?? '');
      else dropped++;
    }
    s.remove();
  }

  // 7. frames, plugins, base, meta, links, noscript (and, on an SEO page, templates: there's no script to use them)
  let frames = 0;
  for (const tag of seo ? [...REMOVED, 'template'] : REMOVED) {
    for (const el of Array.from(doc.querySelectorAll(tag))) {
      if (FRAMES.has(tag)) frames++;
      el.remove();
    }
  }
  if (frames) notes.push(plural(frames, 'Took out an embedded frame or plugin (an iframe, object or embed): the page can’t load other pages inside it.', 'Took out # embedded frames or plugins (iframes, objects or embeds): the page can’t load other pages inside it.'));

  // event handlers and addresses: an asset's handlers move into its script (so its buttons still work); an SEO page's go
  const handlers: { target: string; type: string; code: string }[] = [];
  let mark = 0;
  let removedHandlers = 0;
  let removedUrls = 0;
  const body = doc.body;
  const all = [{ el: body as Element, inTemplate: false }, ...elementsOf(body)];
  for (const { el, inTemplate } of all) {
    let id = '';
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        removedHandlers++;
        const code = attr.value.trim();
        // a template's copy isn't in the page yet when the script runs: its handlers can't be moved
        if (seo || inTemplate || !code) continue;
        const type = name.slice(2);
        if (el === body) handlers.push({ target: WINDOW_EVENTS.has(type) ? 'window' : 'document.body', type, code });
        else {
          if (!id) {
            id = String(++mark);
            el.setAttribute('data-ylb-on', id);
          }
          handlers.push({ target: `el(${JSON.stringify(id)})`, type, code });
        }
        continue;
      }
      if ((URL_ATTRS.has(name) && badUrl(name, attr.value)) || (ANIMATION_ATTRS.has(name) && /(?:javascript|vbscript|data):/.test(bareUrl(attr.value)))) {
        el.removeAttribute(attr.name);
        removedUrls++;
        continue;
      }
      // a click on a link must not send where it was clicked (or a ping) to other sites
      if (name === 'ping') el.removeAttribute(attr.name);
    }
    if (el.localName === 'a' || el.localName === 'area' || el.localName === 'form') {
      if ((el.getAttribute('target') ?? '').trim().toLowerCase() === '_blank') {
        const rel = new Set((el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean));
        rel.add('noopener');
        rel.add('noreferrer');
        el.setAttribute('rel', [...rel].join(' '));
      }
    }
  }
  if (seo && (dropped || removedHandlers || removedUrls)) notes.push('Took out JavaScript: your SEO page runs without scripts.');
  if (!seo && dropped) notes.push(plural(dropped, 'Took out 1 script the page can’t run here.', 'Took out # scripts the page can’t run here.'));
  if (!seo && handlers.length) notes.push(plural(handlers.length, 'Moved 1 inline event handler (like onclick) into the page’s script, so it shows in the JS tab.', 'Moved # inline event handlers (like onclick) into the page’s script, so they show in the JS tab.'));
  if (!seo && removedUrls) notes.push(plural(removedUrls, 'Took out a javascript: or data: address.', 'Took out # javascript: or data: addresses.'));

  // 8. forms
  let hasLeadForm = false;
  // a control outside a form that names one (form="…") would send with it: never on these pages
  for (const c of Array.from(body.querySelectorAll('[form]'))) c.removeAttribute('form');
  if (seo) {
    // the form's action is the app's to write: any other {{lead-action}} in the page goes
    for (const { el } of all) {
      for (const attr of Array.from(el.attributes)) if (attr.value.includes(LEAD_ACTION)) el.setAttribute(attr.name, attr.value.split(LEAD_ACTION).join(''));
    }
    for (const t of textNodesOf(body)) if ((t.data ?? '').includes(LEAD_ACTION)) t.data = t.data.split(LEAD_ACTION).join('');
    const forms = Array.from(body.querySelectorAll('form'));
    const keep = forms.find(formFits);
    let others = 0;
    for (const f of forms) {
      if (f === keep) continue;
      f.remove();
      others++;
    }
    if (keep) {
      toLeadForm(doc, keep);
      css = css ? `${css}\n${HONEYPOT_CSS}` : HONEYPOT_CSS;
      hasLeadForm = true;
      notes.push('Your page’s form sends to Email → Leads once it’s published.');
    }
    if (others) notes.push(plural(others, 'Took out a form the app can’t receive: only name, email, phone, message and time fields work.', 'Took out # forms the app can’t receive: only name, email, phone, message and time fields work.'));
  } else {
    // a form's action is the app's to write: {{lead-action}} anywhere else in the HTML goes (the script may keep it)
    for (const { el } of all) {
      for (const attr of Array.from(el.attributes)) if (attr.value.includes(LEAD_ACTION) && !(el.localName === 'form' && attr.name === 'action')) el.setAttribute(attr.name, attr.value.split(LEAD_ACTION).join(''));
    }
    for (const t of textNodesOf(body)) if ((t.data ?? '').includes(LEAD_ACTION)) t.data = t.data.split(LEAD_ACTION).join('');
    const own = (o.ownHost ?? '').toLowerCase().replace(/^www\./, '');
    let away = 0;
    let leads = 0;
    let removed = 0;
    for (const f of Array.from(body.querySelectorAll('form'))) {
      const action = (f.getAttribute('action') ?? '').trim();
      const host = hostOf(action);
      // the owner's own site (an endpoint they set up) stays as it is
      if (host && host === own) continue;
      if (formFits(f)) {
        toLeadForm(doc, f);
        leads++;
      } else if (formSends(f)) {
        f.remove();
        removed++;
      } else if (host || /^mailto:/i.test(action)) {
        // a form the page's script handles: it mustn't send anywhere by itself
        f.removeAttribute('action');
        away++;
      }
    }
    for (const b of Array.from(body.querySelectorAll('[formaction]'))) {
      const host = hostOf((b.getAttribute('formaction') ?? '').trim());
      if (host && host !== own) {
        b.removeAttribute('formaction');
        away++;
      }
    }
    if (leads) {
      css = css ? `${css}\n${HONEYPOT_CSS}` : HONEYPOT_CSS;
      hasLeadForm = true;
      notes.push(leads === 1 ? 'Your page’s form sends to Email → Leads once it’s published.' : 'Your page’s forms send to Email → Leads once it’s published.');
    }
    if (removed) notes.push(plural(removed, 'Took out a form the app can’t receive.', 'Took out # forms the app can’t receive.'));
    if (away) notes.push('Took out where a form sent to another site.');
  }

  // 9. the page itself
  let html = body.innerHTML.trim();
  // each script was a whole program: a ";" between them keeps one from running into the next (a script that ends
  // without one, then a line that starts with "(", would otherwise call what it ended with)
  let js = kept.map((s) => s.trim()).filter(Boolean).join('\n;\n');
  if (handlers.length) {
    const lines = [
      '// Event handlers the page had in its HTML (onclick=…), moved here by the app.',
      ';(function () {',
      '  function el(n) { return document.querySelector(\'[data-ylb-on="\' + n + \'"]\'); }',
      '  function on(target, type, run) {',
      '    if (target) target.addEventListener(type, function (event) { if (run.call(this, event) === false) event.preventDefault(); });',
      '  }',
      ...handlers.map((h) => `  on(${h.target}, ${JSON.stringify(h.type)}, function (event) {\n${h.code}\n  });`),
      '})();',
    ];
    js = js ? `${js}\n\n${lines.join('\n')}` : lines.join('\n');
  }
  js = safeScriptText(js);

  // 10. only the owner's own images
  const own = keepOwnImages({ html, css, js }, o.imageKeys);
  html = own.code.html;
  css = own.code.css;
  js = own.code.js;
  const imageNote = keptOwnImagesNote(own.removed);
  if (imageNote) notes.push(imageNote);

  // 11. nothing left
  if (isEmpty(html)) return { ok: false, reason: 'empty', message: 'That reply isn’t a usable page: the page came back empty after cleaning.' };

  // 12. a big page makes every save of the project bigger
  const bytes = byteLength(html) + byteLength(css) + byteLength(js);
  if (bytes > LARGE_PAGE_BYTES) notes.push(`This page is large (${Math.round(bytes / 1024)} KB): it makes your project slower to save.`);

  return { ok: true, page: { html, css, js, title, description, notes, bytes, hasLeadForm } };
}
