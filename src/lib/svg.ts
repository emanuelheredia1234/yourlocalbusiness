// Allowlist sanitizer for AI-written SVG illustrations.
//
// The markup is rebuilt from scratch: only known drawing elements and presentation
// attributes survive, references may only point inside the document (#id), and
// comments, scripts, styles, text, foreignObject, event handlers and external URLs
// are dropped. Works without a DOM (string tokenizer), so it runs in tests too.
// The result is only ever drawn as an image (never inserted as HTML).

const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern',
  'filter', 'fegaussianblur', 'feoffset', 'feblend', 'fecolormatrix', 'femerge', 'femergenode',
  'feflood', 'fecomposite', 'fedropshadow', 'feturbulence', 'fedisplacementmap', 'fecomponenttransfer',
  'fefunca', 'fefuncr', 'fefuncg', 'fefuncb', 'femorphology',
]);

/** Elements whose whole subtree is dropped (never just the tag). */
const DROP_SUBTREE = new Set(['script', 'style', 'foreignobject', 'text', 'textpath', 'tspan', 'title', 'desc', 'metadata', 'image', 'a', 'iframe', 'animate', 'animatetransform', 'animatemotion', 'set', 'audio', 'video', 'canvas', 'switch', 'font', 'font-face']);

const CANONICAL: Record<string, string> = {
  lineargradient: 'linearGradient',
  radialgradient: 'radialGradient',
  clippath: 'clipPath',
  fegaussianblur: 'feGaussianBlur',
  feoffset: 'feOffset',
  feblend: 'feBlend',
  fecolormatrix: 'feColorMatrix',
  femerge: 'feMerge',
  femergenode: 'feMergeNode',
  feflood: 'feFlood',
  fecomposite: 'feComposite',
  fedropshadow: 'feDropShadow',
  feturbulence: 'feTurbulence',
  fedisplacementmap: 'feDisplacementMap',
  fecomponenttransfer: 'feComponentTransfer',
  fefunca: 'feFuncA',
  fefuncr: 'feFuncR',
  fefuncg: 'feFuncG',
  fefuncb: 'feFuncB',
  femorphology: 'feMorphology',
};

const ATTRS = new Set([
  'id', 'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr',
  'd', 'points', 'transform', 'preserveaspectratio',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'opacity', 'clip-path', 'clip-rule', 'mask', 'filter',
  'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform', 'spreadmethod',
  'patternunits', 'patterncontentunits', 'patterntransform', 'maskunits', 'maskcontentunits', 'clippathunits',
  'filterunits', 'primitiveunits', 'stddeviation', 'in', 'in2', 'result', 'dx', 'dy', 'mode', 'values', 'type', 'operator',
  'k1', 'k2', 'k3', 'k4', 'flood-color', 'flood-opacity', 'basefrequency', 'numoctaves', 'seed', 'stitchtiles', 'scale',
  'xchannelselector', 'ychannelselector', 'radius', 'tablevalues', 'slope', 'intercept', 'amplitude', 'exponent',
  'href', 'xlink:href', 'xmlns', 'xmlns:xlink', 'version', 'mix-blend-mode', 'color', 'shape-rendering', 'vector-effect',
  'paint-order', 'display', 'visibility',
]);

/** CSS properties a `style` attribute may carry; they become presentation attributes. */
const STYLE_PROPS = new Set(['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'opacity', 'stop-color', 'stop-opacity', 'mix-blend-mode', 'flood-color', 'flood-opacity', 'display', 'visibility']);

const MAX_INPUT = 200_000;
const MAX_NODES = 4000;

function safeValue(name: string, value: string): string | null {
  const v = value.replace(/[\u0000-\u001f]/g, ' ').trim();
  if (v.length > 20_000) return null;
  const lower = v.toLowerCase();
  if (/javascript:|data:|vbscript:|expression\s*\(|@import|<|>/.test(lower)) return null;
  if (name === 'href' || name === 'xlink:href') return /^#[\w.-]+$/.test(v) ? v : null;
  if (name === 'xmlns') return v === 'http://www.w3.org/2000/svg' ? v : null;
  if (name === 'xmlns:xlink') return v === 'http://www.w3.org/1999/xlink' ? v : null;
  // url() may only reference an element in this document
  const urls = v.match(/url\s*\(([^)]*)\)/gi) ?? [];
  for (const u of urls) {
    const inner = u.replace(/^url\s*\(\s*['"]?|['"]?\s*\)$/gi, '');
    if (!/^#[\w.-]+$/.test(inner)) return null;
  }
  return v;
}

const esc = (s: string) => s.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, '&amp;').replace(/"/g, '&quot;');

export interface SanitizedSvg {
  svg: string;
  width: number;
  height: number;
}

/** Returns a safe, self-contained SVG string, or null when there is nothing usable. */
export function sanitizeSvg(input: string): SanitizedSvg | null {
  if (typeof input !== 'string' || !input) return null;
  let src = input.slice(0, MAX_INPUT);
  const start = src.search(/<svg[\s>]/i);
  if (start < 0) return null;
  src = src.slice(start);
  // drop comments, CDATA, processing instructions and doctypes before tokenizing
  src = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '');

  const out: string[] = [];
  const stack: string[] = [];
  let skipDepth = 0; // >0 while inside a dropped subtree
  let skipTag = '';
  let nodes = 0;
  let rootSeen = false;
  let rootClosed = false;
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src)) && !rootClosed) {
    const closing = m[1] === '/';
    const raw = m[2];
    const name = raw.toLowerCase();
    const selfClosing = m[4] === '/';
    if (skipDepth > 0) {
      if (name === skipTag) {
        if (closing) skipDepth -= 1;
        else if (!selfClosing) skipDepth += 1;
      }
      continue;
    }
    if (!closing && (DROP_SUBTREE.has(name) || !ELEMENTS.has(name))) {
      // unknown or dangerous element: drop it with everything inside
      if (!selfClosing) {
        skipDepth = 1;
        skipTag = name;
      }
      continue;
    }
    if (closing) {
      if (!ELEMENTS.has(name)) continue;
      const idx = stack.lastIndexOf(name);
      if (idx < 0) continue;
      while (stack.length > idx) {
        const t = stack.pop()!;
        out.push(`</${CANONICAL[t] ?? t}>`);
      }
      if (stack.length === 0) rootClosed = true;
      continue;
    }
    if (!rootSeen) {
      if (name !== 'svg') continue;
      rootSeen = true;
    }
    if (++nodes > MAX_NODES) break;
    const attrs: string[] = [];
    const extra = new Map<string, string>();
    const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((a = attrRe.exec(m[3]))) {
      const an = a[1].toLowerCase();
      const val = a[2] ?? a[3] ?? a[4] ?? '';
      if (an.startsWith('on')) continue;
      if (an === 'style') {
        for (const decl of val.split(';')) {
          const i = decl.indexOf(':');
          if (i < 0) continue;
          const prop = decl.slice(0, i).trim().toLowerCase();
          const pv = decl.slice(i + 1).trim();
          if (!STYLE_PROPS.has(prop)) continue;
          const safe = safeValue(prop, pv);
          if (safe !== null) extra.set(prop, safe);
        }
        continue;
      }
      if (!ATTRS.has(an) || seen.has(an)) continue;
      const safe = safeValue(an, val);
      if (safe === null) continue;
      seen.add(an);
      // keep the original casing for camelCase SVG attributes (viewBox, stdDeviation…)
      attrs.push(`${a[1]}="${esc(safe)}"`);
    }
    for (const [k, v] of extra) if (!seen.has(k)) attrs.push(`${k}="${esc(v)}"`);
    if (name === 'svg' && stack.length === 0 && !seen.has('xmlns')) attrs.unshift('xmlns="http://www.w3.org/2000/svg"');
    const tag = CANONICAL[name] ?? name;
    if (selfClosing) out.push(`<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}/>`);
    else {
      out.push(`<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
      stack.push(name);
    }
  }
  if (!rootSeen) return null;
  while (stack.length) {
    const t = stack.pop()!;
    out.push(`</${CANONICAL[t] ?? t}>`);
  }
  const svg = out.join('');
  // must actually draw something
  if (!/<(path|rect|circle|ellipse|polygon|polyline|line|use)\b/.test(svg)) return null;
  const root = /^<svg[^>]*>/.exec(svg)?.[0] ?? '<svg>';
  const vb = /\sviewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/i.exec(root);
  const wAttr = /\swidth="([\d.]+)(?:px)?"/i.exec(root);
  const hAttr = /\sheight="([\d.]+)(?:px)?"/i.exec(root);
  const width = Number(vb?.[1] ?? wAttr?.[1] ?? 0);
  const height = Number(vb?.[2] ?? hAttr?.[1] ?? 0);
  if (!(width > 0 && height > 0)) return null;
  // explicit pixel size + viewBox so every browser rasterizes it the same way
  let fixedRoot = root.replace(/\s(width|height)="[^"]*"/gi, '');
  if (!vb) fixedRoot = fixedRoot.replace(/^<svg/, `<svg viewBox="0 0 ${width} ${height}"`);
  fixedRoot = fixedRoot.replace(/^<svg/, `<svg width="${width}" height="${height}"`);
  return { svg: fixedRoot + svg.slice(root.length), width, height };
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
