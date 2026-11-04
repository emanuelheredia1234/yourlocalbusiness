// Finding the web page in an agent's reply (Viktor's Slack message, or Manus's text) and checking a
// downloaded .html file. The page is untrusted: these only find it and measure it; the app cleans it
// (src/ai/agents/importHtml.ts) and shows it only in a sandboxed frame. Pure: no I/O.

/** The largest page the app takes (the same as publishing's limit, server/pages.mjs). */
export const MAX_HTML_BYTES = 1_500_000;

const START_RE = /<!doctype\s+html|<html[\s>]/i;
const ESCAPED_START_RE = /&lt;!doctype\s+html|&lt;html(?:\s|&gt;)/i;

/** Slack's three entities, decoded exactly once in one pass (so a page's own "&amp;amp;" becomes "&amp;"). */
export const decodeOnce = (s) => String(s).replace(/&(lt|gt|amp);/g, (_, n) => (n === 'lt' ? '<' : n === 'gt' ? '>' : '&'));

/** Slack link markup in code: <url|label> → label, <url> → url (only real links; any other <…> is left alone). */
export const unlinkSlack = (s) => String(s).replace(/<((?:https?|mailto):[^|>\s]*)(?:\|([^>]*))?>/g, (_, url, label) => (label === undefined ? url : label));

const byteLength = (s) => Buffer.byteLength(s, 'utf8');

/**
 * The page in a piece of text: from the first <!doctype html or <html to the last </html>. Text that is
 * still entity-escaped (&lt;!doctype…) is decoded once more. null when there's no page start at all.
 * complete: it has its </html> and is at most MAX_HTML_BYTES.
 */
export function findPage(s) {
  if (typeof s !== 'string' || !s) return null;
  let t = s;
  let at = t.search(START_RE);
  if (at < 0) {
    if (!ESCAPED_START_RE.test(t)) return null;
    t = decodeOnce(t);
    at = t.search(START_RE);
    if (at < 0) return null;
  }
  const end = t.toLowerCase().lastIndexOf('</html>');
  const closed = end > at;
  const html = closed ? t.slice(at, end + 7) : t.slice(at);
  const bytes = byteLength(html);
  return { html, bytes, closed, complete: closed && bytes <= MAX_HTML_BYTES, tooBig: bytes > MAX_HTML_BYTES };
}

/** Fenced blocks in a text: ``` with or without a language word, which may be followed by the code on the same line. */
export function fencedBlocks(s) {
  const out = [];
  const re = /```([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(s ?? '')))) {
    let body = m[1];
    // ```html\n<!doctype…  (a language word on its own line); a bare fence starts with the code itself
    const lang = /^([A-Za-z][\w+-]{0,19})[ \t]*\n/.exec(body);
    if (lang) body = body.slice(lang[0].length);
    out.push(body.replace(/^\n/, ''));
  }
  return out;
}

/** The text of a Slack rich_text_preformatted element (its text and link parts joined). */
function preformattedText(el) {
  return (Array.isArray(el?.elements) ? el.elements : [])
    .map((x) => {
      if (x?.type === 'text') return String(x.text ?? '');
      if (x?.type === 'link') return String(x.text ?? x.url ?? '');
      if (x?.type === 'emoji') return `:${x.name ?? ''}:`;
      if (x?.type === 'user') return `<@${x.user_id ?? ''}>`;
      return '';
    })
    .join('');
}

/** Every rich_text_preformatted element in a Slack message's blocks. */
export function preformattedBlocks(blocks) {
  const out = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b?.type !== 'rich_text') continue;
    for (const el of Array.isArray(b.elements) ? b.elements : []) if (el?.type === 'rich_text_preformatted') out.push(preformattedText(el));
  }
  return out;
}

/**
 * The page in a message, from (A) its code blocks (Slack's rich_text_preformatted, taken literally),
 * (B) each fenced block in its text (Slack link markup undone, then entities decoded once), or (C) the
 * whole text. A complete A wins, then a complete B, then a complete C; with none complete, the first page
 * start found (a page still being written, or split). `slack: false` (Manus's Markdown): no Slack decoding.
 * Returns { html, bytes, complete, closed, tooBig, from: 'blocks' | 'fence' | 'text' } or null.
 */
export function extractHtml({ blocks, text, slack = true } = {}, { log } = {}) {
  const clean = (s) => (slack ? decodeOnce(unlinkSlack(s)) : s);
  const A = preformattedBlocks(blocks).map((s) => findPage(s)).filter(Boolean).map((p) => ({ ...p, from: 'blocks' }));
  const B = fencedBlocks(text).map((s) => findPage(clean(s))).filter(Boolean).map((p) => ({ ...p, from: 'fence' }));
  const whole = typeof text === 'string' && text ? findPage(clean(text.replace(/```/g, '\n'))) : null;
  const C = whole ? [{ ...whole, from: 'text' }] : [];
  const a = A.find((p) => p.complete);
  const b = B.find((p) => p.complete);
  if (a && b && a.html !== b.html) log?.('Viktor’s code block and its text differ; using the code block.');
  return a ?? b ?? C.find((p) => p.complete) ?? A[0] ?? B[0] ?? C[0] ?? null;
}

/**
 * A downloaded .html file: UTF-8, has a page start, at most MAX_HTML_BYTES.
 * { ok: true, html } or { ok: false, reason: 'too_big' | 'not_utf8' | 'not_html' }.
 */
export function checkHtmlBytes(buf) {
  if (!buf || buf.length > MAX_HTML_BYTES) return { ok: false, reason: 'too_big' };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { ok: false, reason: 'not_utf8' };
  }
  text = text.replace(/^\ufeff/, '');
  if (!START_RE.test(text)) return { ok: false, reason: 'not_html' };
  return { ok: true, html: text };
}

const kb = (bytes) => `${Math.max(0.1, Math.round(bytes / 102.4) / 10).toFixed(1)} KB`;

/**
 * Text with each code block replaced by a short note: [HTML page · 9.4 KB] or [code · 23 lines]. An
 * unclosed fence that starts a page (half a page) becomes [part of an HTML page · N KB].
 */
export function codePlaceholders(s) {
  let out = String(s ?? '').replace(/```([\s\S]*?)```/g, (_, body) => {
    const page = findPage(body);
    if (page) return `[HTML page · ${kb(page.bytes)}]`;
    const lines = body.replace(/^[A-Za-z][\w+-]{0,19}[ \t]*\n/, '').replace(/\n+$/, '').split('\n').length;
    return `[code · ${lines} line${lines === 1 ? '' : 's'}]`;
  });
  const open = out.indexOf('```');
  if (open >= 0) {
    const rest = out.slice(open + 3);
    const page = findPage(rest);
    if (page) out = `${out.slice(0, open)}[part of an HTML page · ${kb(page.bytes)}]`;
  }
  return out;
}

/** A Slack or Manus file that is a web page: by type, MIME type or name. */
export const isHtmlFile = (f) => !!f && (f.filetype === 'html' || /^text\/html\b/i.test(String(f.mimetype ?? f.content_type ?? '')) || /\.html?$/i.test(String(f.name ?? f.filename ?? '')));

/** A file's kind for the chat chips: an image, a web page, or something else. */
export function fileKind(f) {
  if (isHtmlFile(f)) return 'html';
  const type = String(f?.mimetype ?? f?.content_type ?? '');
  if (f?.type === 'image' || /^image\/(png|jpe?g|webp|gif)\b/i.test(type) || /\.(png|jpe?g|webp|gif)$/i.test(String(f?.name ?? f?.filename ?? ''))) return 'image';
  return 'other';
}
