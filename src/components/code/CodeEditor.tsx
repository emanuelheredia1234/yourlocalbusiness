import { useEffect, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle, foldGutter } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, autocompletion } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { tags as t } from '@lezer/highlight';
import { Monitor, RefreshCw, Smartphone, Tablet } from 'lucide-react';
import { cn, debounce } from '@/lib/utils';
import { buildDocument } from '@/ai/local/code';

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier], color: 'rgb(var(--code-kw))' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'rgb(var(--code-str))' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'rgb(var(--code-num))' },
  { tag: [t.tagName, t.typeName], color: 'rgb(var(--code-tag))' },
  { tag: [t.attributeName, t.propertyName], color: 'rgb(var(--code-attr))' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'rgb(var(--code-com))', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'rgb(var(--code-fn))' },
  { tag: [t.className, t.labelName], color: 'rgb(var(--code-tag))' },
  { tag: t.invalid, color: 'rgb(var(--bad))' },
]);

const theme = EditorView.theme({
  '&': { color: 'rgb(var(--ink))', backgroundColor: 'rgb(var(--code-bg))' },
  '.cm-content': { caretColor: 'rgb(var(--ink))', padding: '10px 0' },
  '.cm-gutters': { border: 'none' },
  '.cm-tooltip': { border: '1px solid rgb(var(--line))', backgroundColor: 'rgb(var(--surface))', color: 'rgb(var(--ink))' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'rgb(var(--primary) / 0.18)', color: 'rgb(var(--ink))' },
});

export type CodeLang = 'html' | 'css' | 'js';

function langExt(lang: CodeLang): Extension {
  return lang === 'html' ? html({ autoCloseTags: true }) : lang === 'css' ? css() : javascript();
}

export function CodeEditor({ value, onChange, lang, readOnly, className, ariaLabel }: { value: string; onChange?: (v: string) => void; lang: CodeLang; readOnly?: boolean; className?: string; ariaLabel?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
        syntaxHighlighting(highlight),
        theme,
        langExt(lang),
        EditorView.lineWrapping,
        EditorState.readOnly.of(!!readOnly),
        EditorView.contentAttributes.of({ 'aria-label': ariaLabel ?? `${lang.toUpperCase()} editor` }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
        }),
      ],
    });
    view.current = new EditorView({ state, parent: host.current });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
    // Recreate only when the language or read-only mode changes; content syncs below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, readOnly]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div ref={host} className={cn('h-full min-h-0 overflow-hidden', className)} />;
}

export function LivePreview({ code, title, className }: { code: { html: string; css: string; js: string }; title?: string; className?: string }) {
  const [device, setDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [doc, setDoc] = useState(() => buildDocument(code, title));
  const [nonce, setNonce] = useState(0);
  const update = useRef(debounce((c: { html: string; css: string; js: string }, t?: string) => setDoc(buildDocument(c, t)), 350));
  useEffect(() => {
    update.current(code, title);
  }, [code, title]);
  const width = device === 'desktop' ? '100%' : device === 'tablet' ? '768px' : '390px';
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-line bg-surface px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-bad/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-warn/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-good/70" />
          <span className="ml-2 text-xs font-semibold text-muted">Live preview</span>
        </div>
        <div className="flex items-center gap-1">
          {(
            [
              ['desktop', Monitor],
              ['tablet', Tablet],
              ['mobile', Smartphone],
            ] as const
          ).map(([d, I]) => (
            <button key={d} className={cn('btn btn-ghost btn-icon btn-xs', device === d && 'bg-surface-2 text-ink')} onClick={() => setDevice(d)} aria-label={`${d} width`} aria-pressed={device === d}>
              <I size={14} />
            </button>
          ))}
          <button className="btn btn-ghost btn-icon btn-xs" onClick={() => setNonce((n) => n + 1)} aria-label="Reload preview">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      <div className="dotgrid flex min-h-0 flex-1 justify-center overflow-auto bg-surface-2 p-3">
        <iframe key={nonce} title={title ?? 'Live preview'} srcDoc={doc} sandbox="allow-scripts allow-forms allow-popups allow-modals" className="h-full min-h-[420px] rounded-md border border-line bg-white shadow-card transition-[width] duration-300" style={{ width, maxWidth: '100%' }} />
      </div>
    </div>
  );
}
