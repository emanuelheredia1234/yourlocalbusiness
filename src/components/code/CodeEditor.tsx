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
import { Tooltip } from '@/components/ui/primitives';
import { BrowserFrame } from '@/components/frames/Frames';
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

// The editor's own chrome (font, gutters, active line, selection) comes from index.css; only what CSS can't
// reach from outside is set here: the text colour and caret, the content padding and the autocomplete popup.
const theme = EditorView.theme({
  '&': { color: 'rgb(var(--ink))' },
  '.cm-content': { caretColor: 'rgb(var(--ink))', padding: '10px 0' },
  '.cm-tooltip': { border: '1px solid rgb(var(--line))', borderRadius: '12px', overflow: 'hidden', backgroundColor: 'rgb(var(--elevated))', color: 'rgb(var(--ink))', boxShadow: 'var(--shadow-pop)' },
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

type PreviewCode = { html: string; css: string; js: string };

/**
 * The page as it will look, in a sandbox like a published page's (scripts run, no storage of its own:
 * the storage stand-in keeps code that saves things working). `images` fills in the {{img-N}} tokens
 * (data URLs); an image that isn't there yet shows nothing rather than its token.
 */
const previewDoc = (c: PreviewCode, title?: string, images?: Record<string, string>) => buildDocument(c, title, { images: images ?? {}, storageShim: true });

export function LivePreview({ code, title, images, className, url }: { code: PreviewCode; title?: string; images?: Record<string, string>; className?: string; url?: string }) {
  const [device, setDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [doc, setDoc] = useState(() => previewDoc(code, title, images));
  const [nonce, setNonce] = useState(0);
  const update = useRef(debounce((c: PreviewCode, t?: string, i?: Record<string, string>) => setDoc(previewDoc(c, t, i)), 350));
  useEffect(() => {
    update.current(code, title, images);
  }, [code, title, images]);
  const width = device === 'desktop' ? '100%' : device === 'tablet' ? '768px' : '390px';
  return (
    <BrowserFrame
      url={url ?? 'Preview'}
      className={cn('flex min-h-0 min-w-0 flex-col', className)}
      bodyClassName="flex min-h-0 flex-1 justify-center overflow-auto bg-surface-2"
      toolbar={
        <>
          {(
            [
              ['desktop', Monitor, 'Desktop width'],
              ['tablet', Tablet, 'Tablet width'],
              ['mobile', Smartphone, 'Phone width'],
            ] as const
          ).map(([d, I, label]) => (
            <Tooltip key={d} content={label}>
              <button type="button" className={cn('btn btn-ghost btn-icon h-6 w-6 rounded-sm', device === d && 'bg-surface-3 text-ink')} onClick={() => setDevice(d)} aria-label={`${d} width`} aria-pressed={device === d}>
                <I className="!size-3.5" />
              </button>
            </Tooltip>
          ))}
          <Tooltip content="Reload">
            <button type="button" className="btn btn-ghost btn-icon h-6 w-6 rounded-sm" onClick={() => setNonce((n) => n + 1)} aria-label="Reload preview">
              <RefreshCw className="!size-3.5" />
            </button>
          </Tooltip>
        </>
      }
    >
      <iframe key={nonce} title={title ?? 'Live preview'} srcDoc={doc} sandbox="allow-scripts allow-forms allow-popups allow-modals" className="h-full min-h-[360px] bg-white transition-[width] duration-240 ease-out" style={{ width, maxWidth: '100%' }} />
    </BrowserFrame>
  );
}
