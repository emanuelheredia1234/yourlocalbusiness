// Markdown → simple blocks for typesetting (PDF): headings, paragraphs, lists, checklists,
// quotes, rules and tables, with **bold**, *italic* and `code` runs. No HTML.

export interface Run {
  text: string;
  b?: boolean;
  i?: boolean;
  code?: boolean;
}

export type Block =
  | { t: 'h'; level: 1 | 2 | 3 | 4; runs: Run[] }
  | { t: 'p'; runs: Run[] }
  | { t: 'li'; ordered: boolean; n: number; depth: number; runs: Run[]; check: boolean | null }
  | { t: 'quote'; runs: Run[] }
  | { t: 'hr' }
  | { t: 'table'; head: Run[][]; rows: Run[][][] };

/** Inline Markdown → styled runs. Links keep their text. */
export function inlineRuns(text: string): Run[] {
  const out: Run[] = [];
  const re = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|(?<![A-Za-z0-9])_[^_\s][^_]*_(?![A-Za-z0-9])|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    const t = m[0];
    if (t.startsWith('***')) out.push({ text: t.slice(3, -3), b: true, i: true });
    else if (t.startsWith('**') || t.startsWith('__')) out.push({ text: t.slice(2, -2), b: true });
    else if (t.startsWith('`')) out.push({ text: t.slice(1, -1), code: true });
    else if (t.startsWith('[')) out.push({ text: /^\[([^\]]+)\]/.exec(t)![1] });
    else out.push({ text: t.slice(1, -1), i: true });
    last = m.index + t.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.filter((r) => r.text);
}

const LIST = /^(\s*)([-*•+]|\d+[.)])\s+(\[( |x|X)\]\s+)?(.*)$/;
const ROW = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => inlineRuns(c.trim()));

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r/g, '').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ t: 'p', runs: inlineRuns(para.join(' ').replace(/\s+/g, ' ').trim()) });
    para = [];
  };
  const flushQuote = () => {
    if (quote.length) blocks.push({ t: 'quote', runs: inlineRuns(quote.join(' ').replace(/\s+/g, ' ').trim()) });
    quote = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      flushQuote();
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line.trim());
    if (h) {
      flushPara();
      flushQuote();
      blocks.push({ t: 'h', level: Math.min(4, h[1].length) as 1 | 2 | 3 | 4, runs: inlineRuns(h[2]) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      flushQuote();
      blocks.push({ t: 'hr' });
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      flushPara();
      flushQuote();
      const head = ROW(line);
      const rows: Run[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(ROW(lines[i++]));
      i--;
      blocks.push({ t: 'table', head, rows });
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      quote.push(q[1]);
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      flushPara();
      flushQuote();
      const ordered = /\d/.test(li[2]);
      blocks.push({ t: 'li', ordered, n: ordered ? parseInt(li[2], 10) : 0, depth: Math.min(3, Math.floor(li[1].replace(/\t/g, '  ').length / 2)), runs: inlineRuns(li[5]), check: li[3] ? li[4].toLowerCase() === 'x' : null });
      continue;
    }
    const prev = blocks[blocks.length - 1];
    // an indented line right after a list item continues it
    if (!para.length && prev?.t === 'li' && /^\s{2,}\S/.test(raw)) {
      prev.runs.push({ text: ' ' }, ...inlineRuns(line.trim()));
      continue;
    }
    flushQuote();
    para.push(line.trim());
  }
  flushPara();
  flushQuote();
  return blocks;
}

export const runsText = (runs: Run[]) => runs.map((r) => r.text).join('');
