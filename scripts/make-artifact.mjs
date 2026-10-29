// Turns the single-file Vite build (dist-artifact/index.html) into a claude.ai Artifact page:
// strips the document skeleton (the host adds its own), moves <title> to the top, and refuses to
// finish if an inline script or style could end early or the page is too large.
//
// The file is walked as markup vs. raw text (script/style bodies) so tag-like strings inside the
// bundled JavaScript are never mistaken for real tags.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'dist-artifact', 'index.html');
const out = path.join(root, 'dist-artifact', 'yourlocalbusiness.html');

const fail = (msg) => {
  console.error(`make-artifact: ${msg}`);
  process.exit(1);
};

if (!fs.existsSync(src)) fail(`missing ${src}. Run "vite build --mode artifact" first.`);
const html = fs.readFileSync(src, 'utf8');
const lower = html.toLowerCase();

/** Split into markup and raw-text elements, the way an HTML parser would. */
const segments = [];
const openRe = /<(script|style)\b[^>]*>/gi;
let i = 0;
while (i < html.length) {
  openRe.lastIndex = i;
  const m = openRe.exec(html);
  if (!m) {
    segments.push({ kind: 'markup', text: html.slice(i) });
    break;
  }
  segments.push({ kind: 'markup', text: html.slice(i, m.index) });
  const tag = m[1].toLowerCase();
  const bodyStart = m.index + m[0].length;
  const closeAt = lower.indexOf(`</${tag}`, bodyStart);
  if (closeAt === -1) fail(`an inline <${tag}> never closes.`);
  const closeEnd = html.indexOf('>', closeAt) + 1;
  segments.push({ kind: tag, open: m[0], body: html.slice(bodyStart, closeAt), close: html.slice(closeAt, closeEnd) });
  i = closeEnd;
}

const raws = segments.filter((s) => s.kind !== 'markup');
const markup = segments.filter((s) => s.kind === 'markup');

// If code contained a literal closing tag, the element ended early and its tail became "markup".
for (const s of markup) {
  if (/<\/(script|style)/i.test(s.text)) fail('an inline script or style contains a literal closing tag, so it would end early.');
}
for (const s of raws) {
  // "<!--" followed by "<script" switches the HTML tokenizer into the escaped state.
  if (s.kind === 'script' && s.body.includes('<!--') && /<script/i.test(s.body.slice(s.body.indexOf('<!--')))) fail('an inline script contains "<!--" followed by "<script".');
}

// Strip the document skeleton from markup only.
const SKELETON = /<!doctype[^>]*>|<\/?html\b[^>]*>|<\/?head\b[^>]*>|<\/?body\b[^>]*>/gi;
let title = '';
const parts = segments.map((s) => {
  // Bundled libraries (pdf-lib) use U+FFFD in string literals; the Artifact publisher refuses that
  // character in a page, so scripts carry the escape \uFFFD instead (same value at runtime).
  if (s.kind === 'script') return s.open + s.body.replace(/\uFFFD/g, '\\uFFFD') + s.close;
  if (s.kind !== 'markup') return s.open + s.body + s.close;
  let t = s.text.replace(SKELETON, '');
  t = t.replace(/<title>[\s\S]*?<\/title>/i, (found) => {
    if (!title) title = found;
    return '';
  });
  return t;
});
if (!title) fail('the page has no <title>.');

let page = `${title}\n${parts.join('')}`
  .split('\n')
  .filter((line, n, arr) => line.trim() || (arr[n - 1] ?? '').trim())
  .join('\n')
  .trim() + '\n';

if (page.includes('\uFFFD')) fail('the page contains the replacement character U+FFFD outside a script.');

const bytes = Buffer.byteLength(page);
if (bytes > 16 * 1024 * 1024) fail(`page is ${(bytes / 1048576).toFixed(1)} MB, over the 16 MB limit.`);
if (page.indexOf('<title>') > 8192) fail('<title> is not within the first 8 KB.');

fs.writeFileSync(out, page);
const scripts = raws.filter((s) => s.kind === 'script').length;
const styles = raws.filter((s) => s.kind === 'style').length;
console.log(`make-artifact: wrote ${path.relative(root, out)} (${(bytes / 1024).toFixed(0)} KB, ${scripts} inline script${scripts === 1 ? '' : 's'}, ${styles} inline style${styles === 1 ? '' : 's'})`);
