#!/usr/bin/env node
// Design codemod ("Ink & Aura"): safe, regex-only rewrites inside class strings (className, cn(…)),
// printing every changed line for review. Phase 2 runs it per file, then reviews each change.
//
//   node scripts/design-codemod.mjs <file-or-dir> … [--dry]
//
// Rewrites (design spec §3.5 / §3.15):
//   - text-[Npx] (and text-2xs / text-xs / text-sm) to the type scale: text-ui over text-small/text-body when
//     the string has font-medium/font-semibold and sits on a button/btn/tab; text-h3 over text-body-lg
//     when it has font-display/font-semibold/font-bold;
//   - font-bold / font-extrabold → font-semibold (not in visuals/**, Logo.tsx, BrandEditors.tsx, imageCanvas.ts);
//   - rounded-[4px] → rounded-xs, rounded-[5px] → rounded-sm;
//   - drops font-display once a size token with a baked weight is applied;
//   - drops uppercase + tracking-[…] pairs on eyebrow-like text (reported).
// --dry prints the changes without writing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseOf, classStrings, lineOf, prefixOf } from './classStrings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const targets = args.filter((a) => !a.startsWith('--'));
if (!targets.length) {
  console.error('usage: node scripts/design-codemod.mjs <file-or-dir> … [--dry]');
  process.exit(2);
}
const rel = (f) => path.relative(root, f).split(path.sep).join('/');
const KEEP_BOLD = [/^src\/components\/visuals\//, /^src\/components\/brand\/Logo\.tsx$/, /^src\/components\/brand\/BrandEditors\.tsx$/, /imageCanvas\.ts$/];
/** size tokens that carry their own weight: font-display beside them is redundant */
const BAKED = new Set(['text-ui', 'text-h4', 'text-h3', 'text-title', 'text-h2', 'text-h1', 'text-kpi', 'text-display', 'text-display-xl', 'text-display-2xl', 'text-phone-h1', 'text-phone-display', 'text-phone-kpi', 'text-phone-hero', 'text-micro']);

function walk(p, out) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) if (e !== 'node_modules' && !e.startsWith('.')) walk(path.join(p, e), out);
  } else if (/\.(tsx|ts)$/.test(p) && !/\.test\.ts$/.test(p)) out.push(p);
}

/** The new size token for a pixel size, given what else the class string says. */
function sizeFor(px, ctx) {
  if (px <= 11) return ctx.numeric ? 'text-micro' : 'text-caption';
  if (px <= 12) return 'text-caption';
  if (px <= 13.5) return ctx.control ? 'text-ui' : 'text-small';
  if (px <= 14.5) return ctx.control ? 'text-ui' : 'text-body';
  if (px <= 16.5) return ctx.title ? 'text-h3' : 'text-body-lg';
  if (px <= 19) return px >= 18 && ctx.dialog ? 'text-title' : 'text-h3';
  if (px <= 24) return 'text-h2';
  if (px <= 32) return 'text-h1';
  if (px >= 40 && px <= 46) return 'text-display-xl';
  return null;
}

/** Rewrite one class string; returns { value, notes }. */
function rewrite(value, file, around) {
  const notes = [];
  const tokens = value.split(/(\s+)/);
  const words = tokens.filter((t) => t.trim());
  const bases = words.map(baseOf);
  const has = (t) => bases.includes(t);
  const weighted = has('font-medium') || has('font-semibold') || has('font-bold');
  const ctx = {
    control: weighted && (/\b(btn|tab)\b/.test(value) || /<button\b|role="tab"/.test(around)),
    title: has('font-display') || has('font-semibold') || has('font-bold') || has('font-extrabold'),
    numeric: has('kbd') || has('num') || has('font-mono') || has('tabular-nums'),
    dialog: /\b(DialogTitle|Modal|title)\b/.test(around),
  };
  const keepBold = KEEP_BOLD.some((rx) => rx.test(rel(file)));
  const eyebrowLike = has('uppercase') && bases.some((b) => b.startsWith('tracking-['));
  let baked = false;
  const out = tokens.map((t) => {
    if (!t.trim()) return t;
    const base = baseOf(t);
    const pre = prefixOf(t);
    let m = /^text-\[(\d+(?:\.\d+)?)px\]$/.exec(base);
    if (m) {
      const next = sizeFor(Number(m[1]), ctx);
      if (next) {
        if (BAKED.has(next)) baked = true;
        return pre + next;
      }
      notes.push(`no scale step for ${base}`);
      return t;
    }
    if (base === 'text-2xs') return pre + (ctx.numeric ? 'text-micro' : 'text-caption');
    if (base === 'text-xs') return pre + 'text-caption';
    if (base === 'text-sm') {
      const next = ctx.control ? 'text-ui' : 'text-body';
      if (next === 'text-ui') baked = true;
      return pre + next;
    }
    if ((base === 'font-bold' || base === 'font-extrabold') && !keepBold) return pre + 'font-semibold';
    if (base === 'rounded-[4px]') return pre + 'rounded-xs';
    if (base === 'rounded-[5px]') return pre + 'rounded-sm';
    if (eyebrowLike && (base === 'uppercase' || base.startsWith('tracking-['))) {
      notes.push(`dropped ${base} (eyebrow-like text: remove the eyebrow if it's a header kicker)`);
      return '';
    }
    return t;
  });
  let next = out.join('');
  if (baked || words.some((w) => BAKED.has(baseOf(w)))) next = next.replace(/(^|\s)font-display(?=\s|$)/g, '$1');
  next = next.replace(/[ \t]{2,}/g, ' ').replace(/^ +| +$/g, (s) => (value.startsWith(' ') || value.endsWith(' ') ? s : ''));
  return { value: next, notes };
}

const files = [];
for (const t of targets) walk(path.resolve(root, t), files);
let changedFiles = 0;
let changedStrings = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const edits = [];
  for (const s of classStrings(src)) {
    if (s.template && /\$\{/.test(src.slice(s.start, s.end))) continue; // leave template literals with expressions alone
    const around = src.slice(Math.max(0, s.region[0] - 200), s.region[1]);
    const { value, notes } = rewrite(s.value, file, around);
    if (value !== s.value || notes.length) edits.push({ ...s, next: value, notes });
  }
  const real = edits.filter((e) => e.next !== e.value);
  for (const e of edits) {
    const line = lineOf(src, e.start);
    if (e.next !== e.value) console.log(`${rel(file)}:${line}\n  - ${e.value.trim()}\n  + ${e.next.trim()}`);
    for (const n of e.notes) console.log(`${rel(file)}:${line}  note: ${n}`);
  }
  if (!real.length) continue;
  changedFiles++;
  changedStrings += real.length;
  if (dry) continue;
  let out = src;
  for (const e of [...real].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.next + out.slice(e.end);
  fs.writeFileSync(file, out);
}
console.log(`\ndesign-codemod: ${changedStrings} class string${changedStrings === 1 ? '' : 's'} in ${changedFiles} file${changedFiles === 1 ? '' : 's'} ${dry ? 'would change (dry run)' : 'changed'}. Review each one.`);
