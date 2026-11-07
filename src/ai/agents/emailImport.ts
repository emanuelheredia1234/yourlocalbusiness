// An email or a lead magnet from Manus or Viktor (P5 §A7, §8): the page is untrusted, so the app only reads its
// <title>, its body and its head <style> with DOMParser (inert: nothing runs or loads), then hands them to the
// shared email sanitizer (the same one the server runs again on every Omnisend draft). An email becomes one custom
// block (its footer and unsubscribe link removed: the app adds its own); a lead magnet becomes the guide's words,
// which the app turns into its own PDF (never a PDF the agent made).

import type { LeadMagnet, LeadMagnetType } from '@/lib/types';
import { MAX_HTML_BYTES } from '@/lib/publish';
import { SanitizeError, sanitizeEmailCss, sanitizeEmailHtml } from '../../../shared/email/sanitize.mjs';
import { EMAIL_LIMITS } from '../../../shared/email/blocks.mjs';

export type EmailImport = { ok: true; html: string; css: string; title: string; notes: string[] } | { ok: false; reason: 'too_big' | 'not_html' | 'empty'; message: string };

const enc = new TextEncoder();
const kb = (s: string) => Math.ceil(enc.encode(s).length / 1024);
const oneLine = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const TOKEN_IMG = /<img\b[^>]*\bsrc="\{\{\s*img-(\d+)\s*\}\}"[^>]*>/g;

/** The email's footer the agent added anyway: the last table row (or paragraph) that talks about unsubscribing. */
function dropFooter(doc: Document): boolean {
  const rows = Array.from(doc.body.querySelectorAll('tr'));
  const last = rows[rows.length - 1];
  if (last && /unsubscribe/i.test(last.textContent ?? '')) {
    last.remove();
    return true;
  }
  const links = Array.from(doc.body.querySelectorAll('a')).filter((a) => /unsubscribe/i.test(`${a.textContent ?? ''} ${a.getAttribute('href') ?? ''}`));
  for (const a of links) (a.closest('p,div,td,footer') ?? a).remove();
  return links.length > 0;
}

/**
 * Clean an agent's page for an email (`email`: one custom block, at most 20 KB once cleaned) or for a lead magnet
 * (`leadMagnet`: the guide's HTML, to be read into its fields). Images: only the {{img-N}} the build sent (`imageKeys`).
 */
export function importAgentEmailHtml(raw: string, o: { target: 'email' | 'leadMagnet'; imageKeys: readonly string[] }): EmailImport {
  if (enc.encode(raw).length > MAX_HTML_BYTES) return { ok: false, reason: 'too_big', message: 'The page is over 1.5 MB, too big to use. Ask for a smaller page.' };
  if (!/<html|<!doctype|<body|<table/i.test(raw)) return { ok: false, reason: 'not_html', message: 'That reply isn’t a usable page: it isn’t an HTML document.' };
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const title = oneLine(doc.querySelector('title')?.textContent) || oneLine(doc.querySelector('h1')?.textContent);
  const notes: string[] = [];
  const headCss = Array.from(doc.head.querySelectorAll('style'))
    .map((s) => s.textContent ?? '')
    .join('\n');
  if (o.target === 'email' && dropFooter(doc)) notes.push('We removed the agent’s footer: the app adds yours, with the unsubscribe link.');
  const max = o.target === 'email' ? EMAIL_LIMITS.customHtmlBytes : 256 * 1024;
  let html: string;
  try {
    // only the build's own images ({{img-N}}); outside pictures go
    const r = sanitizeEmailHtml(doc.body.innerHTML, { maxBytes: max, imageAllowed: () => false });
    html = r.html;
    notes.push(...r.notes);
  } catch (e) {
    if (e instanceof SanitizeError)
      return { ok: false, reason: 'too_big', message: o.target === 'email' ? `The agent’s email is too big for one block (${kb(doc.body.innerHTML)} KB). Ask for a simpler email.` : 'The agent’s document is too big. Ask for a shorter one.' };
    throw e;
  }
  // a token for an image the build didn't send: the picture goes
  let unknown = 0;
  html = html.replace(TOKEN_IMG, (whole, n: string) => (o.imageKeys.includes(`img-${Number(n)}`) ? whole : (unknown++, '')));
  if (unknown) notes.push(unknown === 1 ? 'Took out a picture that wasn’t one of your images.' : `Took out ${unknown} pictures that weren’t your images.`);
  if (!html.replace(/<[^>]*>/g, '').trim() && !/<img/i.test(html)) return { ok: false, reason: 'empty', message: 'That page has nothing in it to use.' };
  let css = '';
  if (headCss.trim()) {
    try {
      const c = sanitizeEmailCss(headCss, { scope: '' });
      css = c.css;
      notes.push(...c.notes);
    } catch {
      notes.push('Its styles were too big and were left out.');
    }
  }
  return { ok: true, html, css, title, notes: [...new Set(notes)] };
}

const MAX_SECTIONS = 12;
const MAX_ITEMS = 20;
const MAX_ITEM = 300;
const clip = (s: string, n = MAX_ITEM) => {
  const t = oneLine(s);
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/**
 * A lead magnet's words from the agent's cleaned document: h1 → title, .subtitle (or the first paragraph) →
 * subtitle, paragraphs before the first h2 → intro, each h2 → a section with its list items (or paragraphs), .cta →
 * the closing call to action. The opt-in words are kept from the current magnet, or made from these.
 */
export function magnetFromHtml(cleanHtml: string, o: { type: LeadMagnetType; current: LeadMagnet | null; id: string; now: number; typeLabel: string }): LeadMagnet | null {
  const doc = new DOMParser().parseFromString(`<body>${cleanHtml}</body>`, 'text/html');
  const isClass = (el: Element, name: string) => Array.from(el.classList).some((c) => c === name || c.endsWith(`-${name}`) || c === `u-${name}`);
  const title = clip(doc.querySelector('h1')?.textContent ?? '', 120);
  if (!title) return null;
  const all = Array.from(doc.body.querySelectorAll('p,h2,li,h3'));
  const subEl = all.find((el) => el.tagName === 'P' && isClass(el, 'subtitle'));
  const ctaEl = all.find((el) => el.tagName === 'P' && isClass(el, 'cta'));
  const firstH2 = all.findIndex((el) => el.tagName === 'H2');
  const before = (firstH2 < 0 ? all : all.slice(0, firstH2)).filter((el) => el.tagName === 'P' && el !== ctaEl);
  const subtitle = clip(subEl?.textContent ?? (before[0] && !subEl ? before[0].textContent ?? '' : ''), 200);
  const intro = before
    .filter((el) => el !== subEl && !(!subEl && el === before[0]))
    .map((el) => clip(el.textContent ?? '', 600))
    .filter(Boolean)
    .join('\n\n');
  const sections: LeadMagnet['sections'] = [];
  let cur: LeadMagnet['sections'][number] | null = null;
  let paras: string[] = [];
  const close = () => {
    if (cur) {
      if (!cur.items.length) cur.items = paras.slice(0, MAX_ITEMS);
      if (cur.heading) sections.push(cur);
    }
    paras = [];
  };
  for (const el of firstH2 < 0 ? [] : all.slice(firstH2)) {
    if (el === ctaEl) continue;
    if (el.tagName === 'H2') {
      close();
      if (sections.length >= MAX_SECTIONS) break;
      cur = { heading: clip(el.textContent ?? '', 120), items: [] };
    } else if (cur && el.tagName === 'LI' && cur.items.length < MAX_ITEMS) {
      const t = clip(el.textContent ?? '');
      if (t) cur.items.push(t);
    } else if (cur && (el.tagName === 'P' || el.tagName === 'H3')) {
      const t = clip(el.textContent ?? '');
      if (t) paras.push(t);
    }
  }
  close();
  if (!sections.length) return null;
  const c = o.current;
  return {
    id: o.id,
    type: o.type,
    title,
    subtitle,
    intro,
    sections: sections.slice(0, MAX_SECTIONS),
    cta: clip(ctaEl?.textContent ?? '', 300),
    optInHeadline: c?.optInHeadline || title,
    optInBullets: c?.optInBullets?.length ? c.optInBullets : sections.slice(0, 3).map((s) => s.heading),
    buttonLabel: c?.buttonLabel || `Get the free ${o.typeLabel.toLowerCase()}`,
    createdAt: o.now,
  };
}
