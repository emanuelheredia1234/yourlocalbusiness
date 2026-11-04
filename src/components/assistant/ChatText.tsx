// The assistant's replies, rendered as a small, safe subset of Markdown: paragraphs, bullet and
// numbered lists, **bold**, *italic*, `code`, and links. A link to an app page (#calendar, or with a
// tab: #workspace-settings/ai) opens it in the app; https links open in a new tab; anything else
// stays plain text. No HTML from the reply is ever rendered.

import { Fragment, type ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { ROUTES, type Route } from '@/lib/router';
import { cn } from '@/lib/utils';

export type OpenPage = (route: Route, tab?: string) => void;

/** "#workspace-settings/ai" → the page and tab, when it's one of the app's pages. */
export function appLink(href: string): { route: Route; tab?: string } | null {
  const m = /^#([a-z-]+)(?:[/:]([a-z-]+))?$/.exec(href.trim());
  if (!m || !(ROUTES as readonly string[]).includes(m[1]) || m[1] === 'onboarding') return null;
  return { route: m[1] as Route, ...(m[2] ? { tab: m[2] } : {}) };
}

// _italic_ only as a whole word: a merge tag ({{lead_magnet_link}}) or a name like ads_text stays as it is
const TOKEN = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\s][^*\n]*\*|(?<![\p{L}\p{N}_])_[^_\s][^_\n]*_(?![\p{L}\p{N}_]))/gu;

function inline(text: string, key: string, open: OpenPage): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith('**')) out.push(<strong key={k} className="font-semibold text-ink">{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em]">{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t) ?? [];
      const page = appLink(href ?? '');
      if (page) {
        out.push(
          <a
            key={k}
            href={`#${page.route}`}
            className="link"
            onClick={(e) => {
              e.preventDefault();
              open(page.route, page.tab);
            }}
          >
            {label}
          </a>,
        );
      } else if (/^https?:\/\/[^\s]+$/i.test(href ?? '')) {
        out.push(
          <a key={k} href={href} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-0.5">
            {label}
            <ArrowUpRight size={12} aria-hidden="true" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>,
        );
      } else out.push(label ?? t);
    } else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = at + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A reply as paragraphs and lists. */
export function ChatText({ text, onOpenPage, className }: { text: string; onOpenPage: OpenPage; className?: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    const k = `p${blocks.length}`;
    blocks.push(<p key={k}>{inline(para.join(' '), k, onOpenPage)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const k = `l${blocks.length}`;
    const Tag = list.ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag key={k} className={cn('flex flex-col gap-1 pl-5', list.ordered ? 'list-decimal' : 'list-disc')}>
        {list.items.map((it, n) => (
          <li key={n}>{inline(it, `${k}-${n}`, onOpenPage)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (ul || ol) {
      flushPara();
      if (list && list.ordered !== !!ol) flushList();
      list ??= { ordered: !!ol, items: [] };
      list.items.push((ul ?? ol)![1]);
    } else if (heading) {
      // a heading in a chat reply is just a bold line
      flushPara();
      flushList();
      const k = `h${blocks.length}`;
      blocks.push(
        <p key={k} className="font-semibold text-ink">
          {inline(heading[1], k, onOpenPage)}
        </p>,
      );
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return <div className={cn('flex flex-col gap-2 break-words text-[13.5px] leading-relaxed text-ink-2', className)}>{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}
