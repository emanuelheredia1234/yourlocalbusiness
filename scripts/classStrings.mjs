// Shared by design-lint.mjs and design-codemod.mjs: finds the class strings in a .tsx/.ts source
// (className="…", className={…}, cn(…), mergeCn(…), clsx(…), cva(…)) and the string literals inside
// them, with their offsets, so a rule can report a line or a rewrite can replace exactly that text.

const OPENERS = /\bclassName\s*=\s*|\b(?:cn|mergeCn|clsx|twMerge|cva)\s*\(/g;

/** Skip a string literal starting at i (quote at s[i]); returns the index after it. */
function skipString(s, i) {
  const q = s[i];
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') j += 2;
    else if (q === '`' && c === '$' && s[j + 1] === '{') {
      j = skipBalanced(s, j + 1, '{', '}');
    } else if (c === q) return j + 1;
    else j++;
  }
  return j;
}

/** From an opening bracket at i, the index after its matching close (strings and nesting aware). */
function skipBalanced(s, i, open, close) {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '"' || c === "'" || c === '`') {
      j = skipString(s, j);
      continue;
    }
    if (c === '/' && s[j + 1] === '/') {
      const nl = s.indexOf('\n', j);
      j = nl === -1 ? s.length : nl;
      continue;
    }
    if (c === '/' && s[j + 1] === '*') {
      const end = s.indexOf('*/', j + 2);
      j = end === -1 ? s.length : end + 2;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return j;
}

/** The string literals in s[from, to): [{ start, end, value }] (start/end exclude the quotes). */
function literalsIn(s, from, to) {
  const out = [];
  let j = from;
  while (j < to) {
    const c = s[j];
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(s, j);
      const value = s.slice(j + 1, end - 1);
      // template literals: only the static parts count as classes
      out.push({ start: j + 1, end: end - 1, value: c === '`' ? value.replace(/\$\{[\s\S]*?\}/g, ' ') : value, template: c === '`' });
      j = end;
      continue;
    }
    if (c === '/' && s[j + 1] === '/') {
      const nl = s.indexOf('\n', j);
      j = nl === -1 ? to : nl;
      continue;
    }
    j++;
  }
  return out;
}

/** Every class string in a source file: { start, end, value, region: [from, to] }. */
export function classStrings(src) {
  const out = [];
  const seen = new Set();
  OPENERS.lastIndex = 0;
  let m;
  while ((m = OPENERS.exec(src))) {
    const at = m.index + m[0].length;
    let from = at;
    let to = at;
    const c = src[at];
    if (m[0].startsWith('className')) {
      if (c === '"' || c === "'") to = skipString(src, at);
      else if (c === '{') to = skipBalanced(src, at, '{', '}');
      else continue;
    } else {
      from = at - 1; // the "("
      to = skipBalanced(src, from, '(', ')');
    }
    for (const lit of literalsIn(src, from, to)) {
      if (seen.has(lit.start)) continue;
      seen.add(lit.start);
      out.push({ ...lit, region: [from, to] });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 1-based line number of an offset. */
export function lineOf(src, offset) {
  let n = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

/** A class token without its variants: "sm:hover:text-[13px]" → "text-[13px]". */
export function baseOf(token) {
  let t = token.replace(/^!/, '');
  for (;;) {
    const m = /^(?:\[[^\]]*\]|[\w@\-/.()]+):/.exec(t);
    if (!m || m[0].length >= t.length) return t.replace(/^!/, '');
    t = t.slice(m[0].length);
  }
}

/** The variant prefix of a token ("sm:hover:" for "sm:hover:text-[13px]"). */
export function prefixOf(token) {
  const base = baseOf(token);
  return token.slice(0, token.length - base.length);
}
