import { createElement, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { cn } from '@/lib/utils';

/**
 * Click-to-edit text for visual editors. Commits on blur, keeps the caret stable while typing,
 * pastes as plain text, and renders as normal text when `editing` is off.
 */
export function Editable({
  value,
  onChange,
  tag = 'span',
  className,
  style,
  editing = true,
  multiline,
  label,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  tag?: string;
  className?: string;
  style?: CSSProperties;
  editing?: boolean;
  multiline?: boolean;
  label: string;
  placeholder?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.innerText !== value) el.innerText = value;
  }, [value, editing]);
  if (!editing) return createElement(tag, { className, style }, value);
  return createElement(tag, {
    ref,
    contentEditable: true,
    suppressContentEditableWarning: true,
    role: 'textbox',
    tabIndex: 0,
    'aria-label': label,
    'aria-multiline': multiline ? true : undefined,
    'data-placeholder': placeholder ?? label,
    spellCheck: true,
    className: cn('ylb-editable', className),
    style: multiline ? { whiteSpace: 'pre-wrap', ...style } : style,
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      const t = e.currentTarget.innerText.replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      if (t !== value) onChange(t);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter' && !multiline) {
        e.preventDefault();
        e.currentTarget.blur();
      } else if (e.key === 'Escape') {
        e.currentTarget.innerText = value;
        e.currentTarget.blur();
      }
    },
    onPaste: (e: React.ClipboardEvent<HTMLElement>) => {
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(multiline ? text : text.replace(/\s*\n\s*/g, ' ')));
      range.collapse(false);
    },
  });
}
