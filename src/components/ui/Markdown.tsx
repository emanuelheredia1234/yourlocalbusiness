import { Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Inline **bold**, *italic* and `code` → React nodes (no HTML injection). */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={`${key}-${i++}`}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={`${key}-${i++}`} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em]">{t.slice(1, -1)}</code>);
    else out.push(<em key={`${key}-${i++}`}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Small, safe Markdown renderer for AI drafts: headings, lists, quotes, paragraphs. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      const k = `p${blocks.length}`;
      blocks.push(
        <p key={k} className="my-2">
          {inline(para.join(' '), k)}
        </p>,
      );
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const k = `l${blocks.length}`;
      const Tag = list.ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={k} className={cn('my-2 flex flex-col gap-1 pl-5', list.ordered ? 'list-decimal' : 'list-disc')}>
          {list.items.map((it, i) => (
            <li key={i}>{inline(it, `${k}-${i}`)}</li>
          ))}
        </Tag>,
      );
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (h) {
      flushPara();
      flushList();
      const level = h[1].length;
      const k = `h${blocks.length}`;
      const cls = level === 1 ? 'mt-4 mb-2 font-display text-[20px] font-bold' : level === 2 ? 'mt-4 mb-1.5 font-display text-[16.5px] font-semibold' : 'mt-3 mb-1 text-[14px] font-semibold';
      blocks.push(
        <p key={k} role="heading" aria-level={Math.min(6, level + 2)} className={cn('text-ink', cls)}>
          {inline(h[2], k)}
        </p>,
      );
    } else if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((ul ?? ol)![1]);
    } else if (quote) {
      flushPara();
      flushList();
      const k = `q${blocks.length}`;
      blocks.push(
        <blockquote key={k} className="my-2 border-l-2 border-accent pl-3 italic text-ink-2">
          {inline(quote[1], k)}
        </blockquote>,
      );
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return <div className={cn('text-[14px] leading-relaxed text-ink-2 [&>*:first-child]:mt-0', className)}>{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}
