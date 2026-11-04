#!/usr/bin/env node
// Design lint ("Ink & Aura"): reports class strings and imports that step outside the design system.
//
//   node scripts/design-lint.mjs [file-or-dir …] [--strict]
//
// Default paths: src/pages and src/components. Default: report (exit 0). --strict: exit 1 when there
// are errors (Phase 3 wires it into npm test). Rules (design spec §3.15):
//   - arbitrary text sizes/colours, radii and shadows (text-[…], rounded-[…], shadow-[…]; shadow-[inset…] is
//     allowed in primitives.tsx) and raw #hex colours in class strings;
//   - bg-white / text-white (except on media overlays marked data-media), bg-ink + text-surface/text-accent blocks;
//   - legacy classes: eyebrow, btn-accent, text-accent, bg-accent, accent-soft, on-accent, primary-2;
//     font-bold, font-extrabold; uppercase (except kbd and font-mono values);
//   - lucide Sparkles / WandSparkles outside src/components/ai (the Spark glyph is the one AI icon; the brand-logo
//     icon set in ui/Icon.tsx is content and may offer a sparkles logo);
//   - the raw aura recipes outside the AI layer (pages get AI styling only through GenerateButton, AiCard,
//     AIThinking, AIComposer, Empty variant="ai", Skeleton ai, Badge tone="ai", .btn-ai/.btn-ai-outline, .ai-composer);
//   - more than one filled button (btn-primary, btn-ai, variant="ai") in one PageHeader's actions.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseOf, classStrings, lineOf } from './classStrings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const targets = args.filter((a) => !a.startsWith('--'));
const rel = (f) => path.relative(root, f).split(path.sep).join('/');

const ALLOW = [/^src\/components\/visuals\//, /^src\/components\/brand\/Logo\.tsx$/, /^src\/components\/brand\/BrandEditors\.tsx$/, /^src\/components\/code\//, /^src\/components\/ui\/shadcn\//, /^src\/pages\/marketing\/SalesPreview\.tsx$/, /^src\/pages\/marketing\/email\/PreviewPanel\.tsx$/];
/** where the raw aura recipes may appear (the AI layer itself, the assistant, sign-in, onboarding, and the primitives that wrap them) */
const AURA_OK = [/^src\/components\/ai\//, /^src\/components\/assistant\//, /^src\/components\/auth\/AuthGate\.tsx$/, /^src\/pages\/onboarding\//, /^src\/components\/ui\/primitives\.tsx$/];
const AURA_CLASSES = new Set(['aura-edge', 'ai-card', 'thinking', 'orb', 'shimmer-text', 'ai-hero-glow']);
const LEGACY = new Set(['eyebrow', 'btn-accent', 'font-bold', 'font-extrabold']);

function walk(p, out) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) if (e !== 'node_modules' && !e.startsWith('.')) walk(path.join(p, e), out);
  } else if (/\.(tsx|ts)$/.test(p) && !/\.test\.ts$/.test(p) && !/\.d\.ts$/.test(p)) out.push(p);
}

const files = [];
for (const t of targets.length ? targets : ['src/pages', 'src/components']) walk(path.resolve(root, t), files);

const problems = [];
const report = (file, src, offset, rule, text) => problems.push({ file: rel(file), line: lineOf(src, offset), rule, text: text.trim().slice(0, 120) });

/** The JSX opening tag around an offset (for data-media). */
function tagAround(src, offset) {
  const lt = src.lastIndexOf('<', offset);
  const gt = src.indexOf('>', offset);
  return lt === -1 ? '' : src.slice(lt, gt === -1 ? offset : gt + 1);
}

for (const file of files) {
  const r = rel(file);
  if (ALLOW.some((rx) => rx.test(r))) continue;
  const src = fs.readFileSync(file, 'utf8');
  const auraOk = AURA_OK.some((rx) => rx.test(r));
  const isPrimitives = r === 'src/components/ui/primitives.tsx';

  for (const s of classStrings(src)) {
    const tokens = s.value.split(/\s+/).filter(Boolean);
    const bases = tokens.map(baseOf);
    const has = (t) => bases.includes(t);
    for (let i = 0; i < tokens.length; i++) {
      const b = bases[i];
      const at = s.start + Math.max(0, s.value.indexOf(tokens[i]));
      if (b.startsWith('text-[')) report(file, src, at, 'arbitrary text size or colour', tokens[i]);
      else if (b.startsWith('rounded-[')) report(file, src, at, 'arbitrary radius', tokens[i]);
      else if (b.startsWith('shadow-[') && !(isPrimitives && b.startsWith('shadow-[inset'))) report(file, src, at, 'arbitrary shadow', tokens[i]);
      if (/#[0-9a-fA-F]{3,8}\b/.test(tokens[i])) report(file, src, at, 'raw hex colour', tokens[i]);
      if ((b === 'bg-white' || b === 'text-white' || b.startsWith('bg-white/') || b.startsWith('text-white/')) && !/data-media/.test(tagAround(src, s.start))) report(file, src, at, 'white instead of a token', tokens[i]);
      if (LEGACY.has(b)) report(file, src, at, 'legacy class', tokens[i]);
      if (/^(text|bg|border|ring|from|to|via)-accent(\/|$|-soft)/.test(b) || /^(bg|text)-on-accent/.test(b) || /(^|-)primary-2(\/|$)/.test(b) || b === 'accent-soft') report(file, src, at, 'legacy colour', tokens[i]);
      if (b === 'uppercase' && !has('kbd') && !has('font-mono')) report(file, src, at, 'uppercase text', tokens[i]);
      if (!auraOk && AURA_CLASSES.has(b)) report(file, src, at, 'raw aura recipe outside the AI layer', tokens[i]);
    }
    if (has('bg-ink') && (has('text-surface') || has('text-accent'))) report(file, src, s.start, 'inverse ink block', s.value);
  }

  // raw aura in styles
  if (!auraOk) {
    const rx = /--ai-[123]|var\(--aura/g;
    let m;
    while ((m = rx.exec(src))) report(file, src, m.index, 'raw aura recipe outside the AI layer', src.slice(m.index, m.index + 24));
  }

  // lucide sparkles outside the AI layer (Icon.tsx is the brand-logo icon set: customer content, where "sparkles" is a logo choice)
  if (!/^src\/components\/ai\//.test(r) && r !== 'src/components/ui/Icon.tsx') {
    const imp = /import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g;
    let m;
    while ((m = imp.exec(src))) {
      for (const name of m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0])) {
        if (name === 'Sparkles' || name === 'WandSparkles') report(file, src, m.index, 'sparkle icon outside AI moments (use Spark)', name);
      }
    }
  }

  // one filled button per PageHeader
  const ph = /<PageHeader\b/g;
  let p;
  while ((p = ph.exec(src))) {
    const end = src.indexOf('/>', p.index);
    const close = src.indexOf('</PageHeader>', p.index);
    const stop = Math.min(...[end, close].filter((x) => x !== -1).concat(src.length));
    const a = src.indexOf('actions=', p.index);
    if (a === -1 || a > stop) continue;
    const chunk = src.slice(a, stop);
    const filled = (chunk.match(/\bbtn-primary\b|\bbtn-ai\b(?!-)|variant=["']ai["']/g) ?? []).length;
    if (filled > 1) report(file, src, a, 'more than one filled button in PageHeader actions', `${filled} filled buttons`);
  }
}

problems.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
for (const x of problems) console.log(`${x.file}:${x.line}  ${x.rule}  ${x.text}`);
const byFile = new Set(problems.map((x) => x.file)).size;
console.log(`\ndesign-lint: ${problems.length} error${problems.length === 1 ? '' : 's'} in ${byFile} file${byFile === 1 ? '' : 's'} (${files.length} scanned)`);
if (strict && problems.length) process.exit(1);
