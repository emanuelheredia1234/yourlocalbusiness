// The design system's building blocks ("Ink & Aura"). Every export that existed before keeps its props,
// so pages keep working; the look comes from the tokens and classes in src/index.css. Overlays, menus,
// select, checkbox, radio group, accordion and the calendar run on Radix (src/components/ui/shadcn);
// Tabs, Segmented and Toggle stay hand-made because tests assert their exact ARIA markup.
//
// The app's cn() only joins strings; where a caller may override a default (Modal body, PageHeader,
// Section, Empty, Tabs, Segmented), the merging cn from ./shadcn/utils (mergeCn) composes them.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { CalendarClock, Check, ChevronLeft, CircleAlert, CircleCheck, CircleHelp, Copy, Ellipsis, Info, Loader2, Lock, TriangleAlert, X } from 'lucide-react';
import { create } from 'zustand';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { cn, hexToRgb, isHex } from '@/lib/utils';
import { copyText } from '@/lib/platform';
import { useMediaQuery } from '@/lib/hooks';
import { useUI } from '@/store/ui';
import { cn as mergeCn } from './shadcn/utils';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './shadcn/dialog';
import { Sheet, SheetContent, SheetTitle } from './shadcn/sheet';
import { Popover as PopoverRoot, PopoverAnchor, PopoverContent, PopoverTrigger } from './shadcn/popover';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from './shadcn/alert-dialog';
import { Tooltip as TooltipRoot, TooltipContent, TooltipTrigger } from './shadcn/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from './shadcn/dropdown-menu';
import { Select as SelectRoot, SelectContent, SelectItem, SelectTrigger, SelectValue } from './shadcn/select';
import { Checkbox as CheckboxRoot } from './shadcn/checkbox';
import { Calendar } from './shadcn/calendar';
import { Spark } from '../ai/Spark';

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from './shadcn/accordion';
export { Toaster, type ToastPlacement } from './toaster';

// ───────────────────────── Overlay primitives ─────────────────────────

/** Clicks on a toast never dismiss the dialog underneath it. */
function keepForToasts(e: { target: EventTarget | null; preventDefault: () => void }) {
  const t = e.target as Element | null;
  if (t && typeof t.closest === 'function' && t.closest('[data-sonner-toaster]')) e.preventDefault();
}

/** Hands the focus back to `el` once an overlay closes, when the focus was dropped (not moved somewhere on purpose). */
function focusBack(el: Element | null) {
  if (!(el instanceof HTMLElement) || !el.isConnected || (el as HTMLButtonElement).disabled) return;
  const at = document.activeElement;
  if (!at || at === document.body) el.focus({ preventScroll: true });
}

/**
 * The control to give the focus back to: the focused element, or, for an item of a dropdown menu (which is gone
 * once the menu closes), the button that opened that menu.
 */
function openerOf(el: Element | null): Element | null {
  const menu = el instanceof HTMLElement ? el.closest('[role="menu"]') : null;
  const by = menu?.getAttribute('aria-labelledby');
  return (by && document.getElementById(by)) || el;
}

/**
 * The element that had the focus when an overlay opened (its trigger). Radix dialogs without a
 * DialogTrigger hand the focus to nothing on close; pass the returned handler as onCloseAutoFocus.
 */
export function useReturnFocus(open: boolean) {
  const opener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    if (open && typeof document !== 'undefined') opener.current = openerOf(document.activeElement);
  }, [open]);
  return (e: Event) => {
    e.preventDefault();
    focusBack(opener.current);
  };
}

const SIZES = { sm: 'max-w-[440px]', md: 'max-w-[600px]', lg: 'max-w-[820px]', xl: 'max-w-[1080px]', full: 'max-w-[1280px]' } as const;

/**
 * A dialog: centred on wide screens, a bottom sheet on phones. `open=false` renders nothing; closing
 * (Esc, a click outside, the ✕) calls onClose unless `persistent`. The first [data-autofocus] element
 * takes the focus when there is one.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'md',
  persistent,
  bodyClass,
  icon,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  persistent?: boolean;
  bodyClass?: string;
  icon?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const returnFocus = useReturnFocus(open);
  if (!open) return null;
  const header = !!(title || subtitle);
  return (
    <Dialog open onOpenChange={(v) => !v && !persistent && onClose()}>
      <DialogContent
        ref={panel}
        {...(subtitle ? {} : { 'aria-describedby': undefined })}
        onOpenAutoFocus={(e) => {
          const el = panel.current?.querySelector<HTMLElement>('[data-autofocus]');
          if (el) {
            e.preventDefault();
            el.focus({ preventScroll: true });
          }
        }}
        onCloseAutoFocus={returnFocus}
        onEscapeKeyDown={(e) => persistent && e.preventDefault()}
        onPointerDownOutside={(e) => (persistent ? e.preventDefault() : keepForToasts(e))}
        onInteractOutside={(e) => (persistent ? e.preventDefault() : keepForToasts(e))}
        className={cn(
          'flex flex-col overflow-hidden border border-line bg-elevated text-ink shadow-dialog',
          'inset-x-0 bottom-0 max-h-[92dvh] w-full rounded-t-xl',
          'sm:inset-0 sm:m-auto sm:h-fit sm:max-h-[calc(100dvh-48px)] sm:w-[calc(100%-48px)] sm:rounded-xl',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 max-sm:data-[state=open]:slide-in-from-bottom sm:data-[state=open]:zoom-in-[0.97] data-[state=open]:duration-240 max-sm:data-[state=open]:duration-320',
          SIZES[size],
        )}
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        {header ? (
          <div className="flex items-start gap-3 px-6 pr-14 pt-6">
            {icon && <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-pop bg-surface-3 text-ink-2">{icon}</div>}
            <div className="min-w-0 flex-1">
              {title ? <DialogTitle className="text-title text-ink">{title}</DialogTitle> : <DialogTitle className="sr-only">Dialog</DialogTitle>}
              {subtitle && <DialogDescription className="mt-1 text-body text-muted">{subtitle}</DialogDescription>}
            </div>
          </div>
        ) : (
          <DialogTitle className="sr-only">Dialog</DialogTitle>
        )}
        <div className={mergeCn('scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-4', bodyClass)}>{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 px-6 pb-6 pt-2">{footer}</div>}
        {header && (
          <button type="button" data-close className="btn btn-ghost btn-icon btn-sm absolute right-4 top-4" onClick={onClose} aria-label="Close">
            <X />
          </button>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A side sheet: inset on the right on wide screens, full screen on phones. Closing hands the focus back to the button that opened it. */
export function Drawer({ open, onClose, title, children, footer, width = 440 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  const returnFocus = useReturnFocus(open);
  if (!open) return null;
  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent
        side="right"
        aria-describedby={undefined}
        onPointerDownOutside={keepForToasts}
        onInteractOutside={keepForToasts}
        onCloseAutoFocus={returnFocus}
        className="text-ink"
        style={{ maxWidth: width, paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line pl-5 pr-3">
          <SheetTitle className="min-w-0 truncate text-h3 text-ink">{title}</SheetTitle>
          <button type="button" data-close className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </SheetContent>
    </Sheet>
  );
}

/**
 * A floating panel next to `anchor` (below it, flipping above when there's no room). A click on the
 * anchor itself doesn't count as "outside", so its own onClick decides (open, or toggle).
 */
export function Popover({ open, onClose, anchor, children, align = 'end', className }: { open: boolean; onClose: () => void; anchor: React.RefObject<HTMLElement>; children: ReactNode; align?: 'start' | 'end'; className?: string }) {
  // closed by a click elsewhere: the focus stays where the person clicked (otherwise it goes back to the anchor)
  const clickedOutside = useRef(false);
  return (
    <PopoverRoot open={open} onOpenChange={(v) => !v && onClose()}>
      <PopoverAnchor virtualRef={anchor as React.RefObject<HTMLElement>} />
      {open && (
        <PopoverContent
          align={align}
          side="bottom"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={() => {
            clickedOutside.current = false;
          }}
          onInteractOutside={(e) => {
            if (anchor.current?.contains(e.target as Node)) e.preventDefault();
            else clickedOutside.current = true;
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (!clickedOutside.current) anchor.current?.focus({ preventScroll: true });
            clickedOutside.current = false;
          }}
          className={cn('scroll-thin max-h-[min(70vh,var(--radix-popover-content-available-height))] overflow-auto', className)}
        >
          {children}
        </PopoverContent>
      )}
    </PopoverRoot>
  );
}

export function MenuItem({ icon, children, onClick, danger, active }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; danger?: boolean; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded px-2 text-left text-small font-medium transition-colors duration-120',
        danger ? 'text-bad hover:bg-bad-soft' : cn('hover:bg-surface-3 hover:text-ink', active ? 'text-ink' : 'text-ink-2'),
      )}
    >
      {icon && <span className={cn('flex shrink-0 items-center [&>svg.lucide]:size-4', danger ? 'text-bad' : 'text-muted')}>{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {active && <Check size={14} className="shrink-0 text-primary" aria-hidden="true" />}
    </button>
  );
}

// ───────────────────────── Controls ─────────────────────────

/**
 * Tabs: an underline row (no icons, no pills). `icon` is accepted and ignored. On narrow screens the
 * row scrolls sideways, fading at the edges, and keeps the selected tab in view.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
  size = 'md',
  sticky,
  'aria-label': ariaLabel,
}: {
  tabs: { id: T; label: ReactNode; icon?: ReactNode; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
  size?: 'sm' | 'md';
  /** stick to the top of the page's scroll area */
  sticky?: boolean;
  'aria-label'?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEdgeFade(listRef);
  // on narrow screens the tab row scrolls sideways: keep the selected tab in view
  useEffect(() => {
    const sel = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    try {
      sel?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
      /* old browsers */
    }
  }, [value]);
  const list = (
    <div ref={listRef} role="tablist" aria-label={ariaLabel} className={mergeCn('flex gap-6 overflow-x-auto border-b border-line [scrollbar-width:none] max-md:scroll-fade-x max-md:gap-5', !sticky && className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            '-mb-px inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 transition-colors duration-120',
            size === 'sm' ? 'h-9 text-small font-medium' : 'h-10 text-ui',
            value === t.id ? 'border-ink text-ink' : 'border-transparent text-muted hover:text-ink-2',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="num font-mono text-caption text-muted">{t.count}</span>}
        </button>
      ))}
    </div>
  );
  // sticky: the opaque bar sticks and the edge fade stays on the row inside it, so content scrolling under it never shows through
  return sticky ? <div className={mergeCn('sticky top-0 z-10 bg-surface', className)}>{list}</div> : list;
}

/**
 * Marks which edges of a sideways-scrolling row (.scroll-fade-x) have more to scroll to, so the fade shows
 * only there (none at rest when everything fits, only the right edge at the start).
 */
export function useEdgeFade(ref: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      el.dataset.fade = start && end ? 'both' : start ? 'start' : end ? 'end' : 'none';
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [ref]);
}

/**
 * A segmented control (radio group): a grey track with a raised thumb on the selected option. Name it with
 * `aria-label` or `aria-labelledby`. An option with a `reason` shows a lock and says why (as the wrapper's
 * tooltip, since a disabled button shows none, and to screen readers); `disabled` makes it unpickable.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': labelledBy,
}: {
  options: { id: T; label: ReactNode; icon?: ReactNode; disabled?: boolean; reason?: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}) {
  const ids = useId();
  return (
    <div role="radiogroup" aria-label={ariaLabel} aria-labelledby={labelledBy} className={mergeCn('inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md bg-surface-3 p-0.5 [scrollbar-width:none]', className)}>
      {options.map((o) => {
        const on = value === o.id;
        const off = !!o.disabled;
        const why = o.reason ? `${ids}-${o.id}` : undefined;
        const button = (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={off || undefined}
            aria-describedby={why}
            onClick={() => onChange(o.id)}
            className={cn(
              'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded transition-colors duration-120 [&>svg]:size-3.5 [&>svg]:shrink-0',
              size === 'sm' ? 'h-7 px-2.5 text-caption font-medium' : 'h-8 px-3 text-small font-medium',
              on ? 'segmented-on text-ink' : off ? 'cursor-not-allowed text-faint' : 'text-muted hover:text-ink',
            )}
          >
            {o.reason ? <Lock size={12} className="shrink-0" aria-hidden="true" /> : o.icon}
            {o.label}
          </button>
        );
        if (!o.reason) return button;
        return (
          <span key={o.id} title={o.reason} className="inline-flex shrink-0">
            {button}
            <span id={why} className="sr-only">
              {o.reason}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** A switch, with an optional label and description beside it. */
export function Toggle({ checked, onChange, label, description, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean; id?: string }) {
  const auto = useId();
  const tid = id ?? auto;
  return (
    <label htmlFor={tid} className={cn('flex items-start gap-3', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
      <button
        id={tid}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          // (no "disabled:" variants here: tests read this tag's attributes for the word)
          'relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-180 ease-out',
          disabled ? 'cursor-not-allowed bg-surface-3' : checked ? 'bg-primary' : 'bg-surface-3 shadow-[inset_0_0_0_1px_rgb(var(--line-2))]',
        )}
      >
        <span className={cn('switch-thumb inline-block h-4 w-4 rounded-full transition-transform duration-180 ease-out', disabled ? 'bg-surface-2' : 'bg-thumb', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className={cn('block text-ui', disabled ? 'text-faint' : 'text-ink')}>{label}</span>}
          {description && <span className="mt-0.5 block text-small text-muted">{description}</span>}
        </span>
      )}
    </label>
  );
}

export function Field({ label, hint, error, children, className, htmlFor, right }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string; htmlFor?: string; right?: ReactNode }) {
  return (
    <div className={cn('min-w-0', className)}>
      {(label || right) && (
        <div className="flex items-end justify-between gap-2">
          {label && (
            <label htmlFor={htmlFor} className="label">
              {label}
            </label>
          )}
          {right && <div className="mb-1.5 text-caption text-muted">{right}</div>}
        </div>
      )}
      {children}
      {error ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-caption text-bad">
          <CircleAlert size={14} className="shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : hint ? (
        <p className="hint">{hint}</p>
      ) : null}
    </div>
  );
}

export function AutoTextarea({ value, onChange, minRows = 3, className, ...rest }: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & { value: string; onChange: (v: string) => void; minRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      // not rendered (e.g. on a hidden tab): measure once it shows
      if (!el.offsetParent && el.getClientRects().length === 0) return;
      el.style.height = 'auto';
      el.style.height = `${Math.max(el.scrollHeight + 2, minRows * 22 + 20)}px`;
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [value, minRows]);
  return <textarea ref={ref} value={value} onChange={(e) => onChange(e.target.value)} className={cn('textarea min-h-0 resize-none overflow-hidden', className)} {...rest} />;
}

export function ChipInput({ values, onChange, placeholder, max = 20, prefix }: { values: string[]; onChange: (v: string[]) => void; placeholder?: string; max?: number; prefix?: string }) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const parts = raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (prefix && !s.startsWith(prefix) ? prefix + s.replace(/\s+/g, '') : s));
    if (!parts.length) return;
    onChange([...new Set([...values, ...parts])].slice(0, max));
    setDraft('');
  };
  return (
    <div className="flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-line-2 bg-surface px-2 py-1 transition-[border-color,box-shadow] duration-120 focus-within:border-ring focus-within:shadow-focus hover:border-line-3 dark:bg-surface-2">
      {values.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded-sm bg-surface-3 py-0.5 pl-2 pr-0.5 text-caption font-medium text-ink-2">
          {v}
          <button type="button" className="relative flex h-4 w-4 items-center justify-center rounded-xs text-muted hover:text-ink before:absolute before:-inset-1.5 [@media(pointer:coarse)]:before:-inset-3" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`}>
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add(draft);
          } else if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1));
        }}
        onBlur={() => add(draft)}
        placeholder={values.length ? '' : placeholder}
        className="h-7 min-w-[90px] flex-1 bg-transparent px-1 text-body text-ink outline-none placeholder:text-muted max-sm:text-body-lg"
      />
    </div>
  );
}

export function ColorInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="flex items-center gap-2">
      <label className="relative h-9 w-9 shrink-0 cursor-pointer overflow-hidden rounded-md border border-line-2" style={{ background: value }} title={label}>
        <input type="color" value={isHex(value) && value.length === 7 ? value : '#000000'} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label={label ?? 'Pick a color'} />
      </label>
      <input
        className="input input-sm num font-mono uppercase"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (isHex(e.target.value)) onChange(e.target.value);
        }}
        aria-label={label ?? 'Hex color'}
      />
    </div>
  );
}

// ───────────────────────── Feedback ─────────────────────────

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cn('animate-spin', className)} aria-hidden="true" />;
}

/**
 * An empty state. `section` (default) sits inside a section; `page` fills a page; `ai` is the page
 * variant for "the AI can do this for you" (aura tile, an optional `summary` line and a ghosted
 * `preview`); `inline` is one muted line. No dashed borders.
 */
export function Empty({
  icon,
  title,
  body,
  action,
  className,
  variant = 'section',
  preview,
  summary,
  glow = true,
}: {
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
  variant?: 'section' | 'page' | 'ai' | 'inline';
  preview?: ReactNode;
  summary?: ReactNode;
  /** variant="ai": the soft aura wash behind it (off inside an AiCard, which has its own) */
  glow?: boolean;
}) {
  if (variant === 'inline') {
    return (
      <p className={mergeCn('flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted', className)}>
        <span>{title}</span>
        {body && <span>{body}</span>}
        {action}
      </p>
    );
  }
  if (variant === 'section') {
    return (
      <div className={mergeCn('flex flex-col items-center justify-center px-6 py-10 text-center', className)}>
        {icon && <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-md bg-surface-3 text-ink-2 [&>svg]:size-4">{icon}</div>}
        <p className="text-h4 text-ink">{title}</p>
        {body && <p className="mt-1 max-w-sm text-small text-muted">{body}</p>}
        {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
      </div>
    );
  }
  const ai = variant === 'ai';
  return (
    <div className={mergeCn('flex flex-col items-center px-4 text-center', ai ? cn(glow && 'ai-hero-glow', 'rounded-stage py-14') : 'py-16', className)}>
      <div className="flex w-full max-w-[440px] flex-col items-center">
        {ai ? (
          <div className="aura-edge mb-4 flex h-[52px] w-[52px] items-center justify-center rounded-stage shadow-ai">
            <Spark size={24} />
          </div>
        ) : (
          icon && <div className="mb-4 flex h-[52px] w-[52px] items-center justify-center rounded-stage bg-surface-3 text-ink-2 [&>svg]:size-6">{icon}</div>
        )}
        <h2 className="text-h2 text-ink">{title}</h2>
        {body && <p className="mt-2 text-body text-muted">{body}</p>}
        {summary && <div className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-small text-muted">{summary}</div>}
        {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-3">{action}</div>}
      </div>
      {preview && (
        <div aria-hidden="true" className="pointer-events-none mt-10 w-full select-none opacity-50">
          {preview}
        </div>
      )}
    </div>
  );
}

/** Kept for the SEO score only (other rings become ProgressBar in Phase 2). */
export function ProgressRing({ value, size = 44, stroke = 5, color = 'rgb(var(--primary))', label }: { value: number; size?: number; stroke?: number; color?: string; label?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--surface-3))" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={c} strokeDashoffset={c * (1 - v)} strokeLinecap="round" style={{ transition: 'stroke-dashoffset .5s cubic-bezier(0.22, 1, 0.36, 1)' }} />
      </svg>
      <span className="num absolute text-micro text-ink">{label ?? `${Math.round(v * 100)}%`}</span>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy', size = 'sm', className }: { text: string | (() => string); label?: string; size?: 'sm' | 'xs'; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={cn('btn btn-secondary', size === 'xs' ? 'btn-xs' : 'btn-sm', className)}
      onClick={async () => {
        const ok = await copyText(typeof text === 'function' ? text() : text);
        if (ok) {
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } else useUI.getState().toast({ kind: 'error', title: 'Copy was blocked', body: 'Select the text and copy it manually.' });
      }}
    >
      {done ? <Check className="text-good" /> : <Copy />}
      {done ? 'Copied' : label}
    </button>
  );
}

// ───────────────────────── In-page confirmation (window.confirm is unavailable in artifacts) ─────────────────────────

interface ConfirmReq {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  resolve: (v: boolean) => void;
  /** what had the focus when the question was asked: it gets the focus back */
  opener?: Element | null;
}
const useConfirmStore = create<{ req: ConfirmReq | null; set: (r: ConfirmReq | null) => void }>((set) => ({ req: null, set: (req) => set({ req }) }));

export function confirmAction(opts: Omit<ConfirmReq, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    // only one question at a time: one still open counts as "no"
    const prev = useConfirmStore.getState().req;
    const opener = prev ? prev.opener : typeof document !== 'undefined' ? openerOf(document.activeElement) : null;
    prev?.resolve(false);
    useConfirmStore.getState().set({ ...opts, resolve, opener });
  });
}

/** The confirm dialog: Cancel (secondary) and Confirm (solid red when it destroys something). */
export function ConfirmHost() {
  const req = useConfirmStore((s) => s.req);
  const set = useConfirmStore((s) => s.set);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const close = (v: boolean) => {
    req?.resolve(v);
    set(null);
  };
  if (!req) return null;
  return (
    <AlertDialog open onOpenChange={(v) => !v && close(false)}>
      <AlertDialogContent
        {...(req.body ? {} : { 'aria-describedby': undefined })}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          focusBack(req.opener ?? null);
        }}
        onOpenAutoFocus={(e) => {
          // a destructive question starts on Cancel (the Radix default); any other on Confirm
          if (req.danger) return;
          e.preventDefault();
          confirmRef.current?.focus({ preventScroll: true });
        }}
        className={cn(
          'flex flex-col border border-line bg-elevated p-6 text-ink shadow-dialog',
          'inset-x-0 bottom-0 w-full rounded-t-xl',
          'sm:inset-0 sm:m-auto sm:h-fit sm:w-[calc(100%-48px)] sm:max-w-[440px] sm:rounded-xl',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 max-sm:data-[state=open]:slide-in-from-bottom sm:data-[state=open]:zoom-in-[0.97] data-[state=open]:duration-240 max-sm:data-[state=open]:duration-320',
        )}
        style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom, 0px))' }}
      >
        <AlertDialogTitle className="text-title text-ink">{req.title}</AlertDialogTitle>
        {req.body && <AlertDialogDescription className="mt-1.5 text-body text-ink-2">{req.body}</AlertDialogDescription>}
        <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
          <AlertDialogCancel className="btn-sm" onClick={() => close(false)}>
            {req.cancelLabel ?? 'Cancel'}
          </AlertDialogCancel>
          <button ref={confirmRef} type="button" data-autofocus className={cn('btn btn-sm', req.danger ? 'btn-danger' : 'btn-primary')} onClick={() => close(true)}>
            {req.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ───────────────────────── Small display helpers ─────────────────────────

export function Swatch({ color, size = 14, className }: { color: string; size?: number; className?: string }) {
  return <span className={cn('inline-block shrink-0 rounded-full ring-1 ring-ink/10', className)} style={{ width: size, height: size, background: color }} />;
}

export function rgbaFromHex(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Edit a list of strings as one-per-line text; empty lines are dropped on blur. */
export function LinesEditor({ values, onChange, minRows = 3, placeholder, className, id }: { values: string[]; onChange: (v: string[]) => void; minRows?: number; placeholder?: string; className?: string; id?: string }) {
  return (
    <AutoTextarea
      id={id}
      value={values.join('\n')}
      onChange={(v) => onChange(v.split('\n'))}
      onBlur={() => {
        const clean = values.map((x) => x.trim()).filter(Boolean);
        if (clean.length !== values.length || clean.some((x, i) => x !== values[i])) onChange(clean);
      }}
      minRows={minRows}
      placeholder={placeholder}
      className={className}
    />
  );
}

// ───────────────────────── Page structure ─────────────────────────

/** One per routed page: the page's name, a one-line description, meta, and its actions. */
export function PageHeader({
  title,
  description,
  meta,
  actions,
  back,
  size = 'default',
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  back?: { label: string; onClick: () => void };
  size?: 'default' | 'display';
  className?: string;
}) {
  const text = typeof description === 'string' ? description : undefined;
  return (
    <header className={mergeCn('mb-6', className)}>
      {back && (
        <button type="button" className="btn btn-ghost btn-sm -ml-2 mb-2" onClick={back.onClick}>
          <ChevronLeft />
          {back.label}
        </button>
      )}
      {/* phones: the title, then meta and actions on one row when they fit (actions wrap under otherwise); wider: meta under the title, actions at the right */}
      <div className={cn('flex flex-wrap items-end gap-x-4 md:grid md:grid-cols-[minmax(0,1fr)_auto]', meta || actions ? 'gap-y-3 md:gap-y-2' : '')}>
        <div className="min-w-0 basis-full md:col-start-1 md:row-start-1">
          <h1 className={cn('text-ink', size === 'display' ? 'text-phone-display sm:text-display' : 'text-phone-h1 sm:text-h1')}>{title}</h1>
          {description && (
            <p className={cn('mt-1 truncate text-body-lg text-muted', text && text.length > 48 && 'max-sm:hidden')} title={text}>
              {description}
            </p>
          )}
        </div>
        {meta && <div className="flex min-w-0 flex-[1_1_auto] flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted md:col-start-1 md:row-start-2">{meta}</div>}
        {/* empty:hidden: actions that render nothing leave no gap */}
        {actions && <div className={cn('flex flex-wrap items-center gap-2 empty:hidden md:col-start-2 md:row-start-1 md:ml-0 md:shrink-0 md:justify-end md:self-end', meta && 'ml-auto md:row-span-2')}>{actions}</div>}
      </div>
    </header>
  );
}

/** A titled section of a page (sections, not boxes). `aria-label` names it as a region. */
export function Section({
  title,
  description,
  actions,
  divider,
  id,
  className,
  children,
  'aria-label': ariaLabel,
  'aria-labelledby': labelledBy,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  divider?: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}) {
  return (
    <section id={id} aria-label={ariaLabel} aria-labelledby={labelledBy} className={mergeCn('mt-10 first:mt-0', divider && 'border-t border-line pt-8', className)}>
      {(title || description || actions) && (
        // wide actions wrap under the title instead of squeezing it into a one-word column
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-[1_1_16rem]">
            {title && <h2 className="text-h2 text-ink">{title}</h2>}
            {description && <p className="mt-1 text-small text-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

const STAT_COLS: Record<number, string> = { 1: 'lg:grid-cols-1', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5', 6: 'lg:grid-cols-6' };

/** Key numbers in one card, split by hairlines (2×2 on phones). A delta shows only when there's a baseline. */
export function StatStrip({
  items,
  className,
}: {
  items: { label: ReactNode; value: ReactNode; sub?: ReactNode; delta?: number | null; upIsGood?: boolean; info?: ReactNode; onClick?: () => void }[];
  className?: string;
}) {
  const odd = items.length % 2 === 1;
  return (
    <div className={mergeCn('card grid grid-cols-2 gap-px overflow-hidden bg-line', STAT_COLS[Math.min(6, Math.max(1, items.length))], className)}>
      {items.map((it, i) => {
        const delta = typeof it.delta === 'number' && Number.isFinite(it.delta) ? it.delta : null;
        const good = delta === null ? null : (delta >= 0) === (it.upIsGood ?? true);
        const inner = (
          <>
            <span className="flex items-center gap-1 text-small text-muted">
              {it.label}
              {it.info && <InfoTip>{it.info}</InfoTip>}
            </span>
            <span className="num mt-1 block text-phone-kpi text-ink sm:text-kpi">{it.value}</span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-caption text-muted">
              {it.sub}
              {delta !== null && delta !== 0 && (
                <span className={cn('font-mono', good ? 'text-good' : 'text-bad')}>
                  {delta > 0 ? '↑' : '↓'} {Math.abs(delta)}
                </span>
              )}
            </span>
          </>
        );
        const cell = cn('min-w-0 bg-surface px-5 py-4 text-left', odd && i === items.length - 1 && 'col-span-2 lg:col-span-1');
        return it.onClick ? (
          <button key={i} type="button" onClick={it.onClick} className={cn(cell, 'transition-colors duration-120 hover:bg-surface-2')}>
            {inner}
          </button>
        ) : (
          <div key={i} className={cell}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

const DOT: Record<'good' | 'warn' | 'bad' | 'primary' | 'faint', string> = { good: 'bg-good-solid', warn: 'bg-warn-solid', bad: 'bg-bad-solid', primary: 'bg-primary', faint: 'bg-faint' };

/** A small coloured dot with a word: the state of a post, page or connection. */
export function StatusDot({ tone, pulse, children }: { tone: 'good' | 'warn' | 'bad' | 'primary' | 'faint'; pulse?: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-small font-medium text-ink-2">
      <span className={cn('h-[7px] w-[7px] shrink-0 rounded-full', DOT[tone], pulse && 'animate-pulse-dot')} aria-hidden="true" />
      {children}
    </span>
  );
}

const BADGE: Record<'neutral' | 'good' | 'warn' | 'bad' | 'primary', string> = {
  neutral: '',
  good: 'bg-good-soft text-good',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  primary: 'bg-primary-soft text-primary',
};

/** A badge, only for state that changes what you can do. tone="ai" is for "AI draft" only. */
export function Badge({ tone = 'neutral', dot, children, className }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'primary' | 'ai'; dot?: boolean; children: ReactNode; className?: string }) {
  if (tone === 'ai') {
    return (
      <span className={mergeCn('badge badge-ai text-ink-2', className)}>
        <Spark size={12} />
        {children}
      </span>
    );
  }
  return (
    <span className={mergeCn('badge', BADGE[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/**
 * A ⓘ button that opens a small popover: where standing disclaimers, "how it works" paragraphs,
 * model and cost notes and host-specific help go, instead of on the page.
 */
export function InfoTip({ title, children, label, link }: { title?: ReactNode; children: ReactNode; label?: string; link?: { label: string; onClick: () => void } }) {
  const [open, setOpen] = useState(false);
  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors duration-120 hover:text-ink" aria-label={label ?? 'More info'}>
          <CircleHelp size={16} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" collisionPadding={8} className="w-80 max-w-[calc(100vw-16px)] p-3">
        {title && <p className="text-small font-semibold text-ink">{title}</p>}
        <div className={cn('text-small text-ink-2', title && 'mt-1')}>{children}</div>
        {link && (
          <button
            type="button"
            className="link mt-2 text-small"
            onClick={() => {
              setOpen(false);
              link.onClick();
            }}
          >
            {link.label}
          </button>
        )}
      </PopoverContent>
    </PopoverRoot>
  );
}

const CALLOUT = {
  info: { box: 'border-primary-line bg-primary-soft', icon: 'text-primary', Icon: Info },
  good: { box: 'border-good-line bg-good-soft', icon: 'text-good', Icon: CircleCheck },
  warn: { box: 'border-warn-line bg-warn-soft', icon: 'text-warn', Icon: TriangleAlert },
  bad: { box: 'border-bad-line bg-bad-soft', icon: 'text-bad', Icon: CircleAlert },
} as const;

/** A tinted note for state that needs action (at most one per page). */
export function Callout({ tone, title, action, onDismiss, children, className }: { tone: 'info' | 'good' | 'warn' | 'bad'; title?: ReactNode; action?: ReactNode; onDismiss?: () => void; children: ReactNode; className?: string }) {
  const t = CALLOUT[tone];
  return (
    <div className={mergeCn('flex items-start gap-2.5 rounded-pop border px-3 py-2.5', t.box, className)} role={tone === 'bad' ? 'alert' : undefined}>
      <t.Icon size={16} className={cn('mt-0.5 shrink-0', t.icon)} aria-hidden="true" />
      <div className="min-w-0 flex-1 text-small text-ink-2">
        {title && <p className="font-semibold text-ink">{title}</p>}
        <div>{children}</div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2 self-center">{action}</div>}
      {onDismiss && (
        <button type="button" className="btn btn-ghost btn-icon btn-xs -my-1 -mr-1 shrink-0" onClick={onDismiss} aria-label="Dismiss">
          <X />
        </button>
      )}
    </div>
  );
}

/**
 * A settings card: a title and rows of label + control. Below 640px the header's actions go under the
 * title. tone="danger" is for things that can't be undone (a red hairline and title).
 */
export function SettingsSection({
  title,
  description,
  actions,
  children,
  id,
  className,
  tone,
  'aria-label': ariaLabel,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
  tone?: 'danger';
  'aria-label'?: string;
}) {
  return (
    <section id={id} aria-label={ariaLabel} className={mergeCn('card', tone === 'danger' && 'border-bad-line', className)}>
      <div className="flex flex-col gap-3 px-5 pb-1 pt-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className={cn('text-h3', tone === 'danger' ? 'text-bad' : 'text-ink')}>{title}</h3>
          {description && <p className="mt-0.5 text-small text-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="px-5 pb-1">{children}</div>
    </section>
  );
}

export function SettingsRow({ label, description, htmlFor, stack, children }: { label: ReactNode; description?: ReactNode; htmlFor?: string; stack?: boolean; children: ReactNode }) {
  return (
    <div className={cn('grid gap-x-8 gap-y-2 border-t border-line py-4 first:border-t-0', !stack && 'md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]')}>
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-ui text-ink">
            {label}
          </label>
        ) : (
          <p className="text-ui text-ink">{label}</p>
        )}
        {description && <p className="clamp-2 mt-0.5 text-small text-muted">{description}</p>}
      </div>
      <div className="flex min-w-0 items-center md:justify-end [&>.input]:max-w-[420px] [&>.select]:max-w-[420px] [&>.textarea]:max-w-[420px]">{children}</div>
    </div>
  );
}

/**
 * A thin progress bar ("3 of 5"), or n gapped segments. variant="ink" (segments only) is the setup top bar's
 * look: short ink segments up to the current step, hairlines after.
 */
export function ProgressBar({
  value,
  max = 100,
  min = 0,
  label,
  segments,
  className,
  variant = 'default',
  title,
  'aria-label': ariaLabel,
  valueText,
}: {
  value: number;
  max?: number;
  min?: number;
  label?: ReactNode;
  segments?: number;
  className?: string;
  variant?: 'default' | 'ink';
  title?: string;
  'aria-label'?: string;
  valueText?: string;
}) {
  const v = Math.max(min, Math.min(max, value));
  const done = max > 0 && v >= max;
  const ink = variant === 'ink' && !!segments;
  return (
    <div className={mergeCn(ink ? 'flex min-w-0 items-center gap-3' : 'flex items-center gap-3', className)} title={title}>
      <div
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={v}
        aria-valuetext={valueText}
        className={cn('flex min-w-0', !ink && 'flex-1', segments ? 'gap-1' : 'h-1 overflow-hidden rounded-full bg-surface-3')}
      >
        {segments ? (
          Array.from({ length: segments }, (_, i) => {
            const filled = i < Math.round((v / (max || 1)) * segments);
            return ink ? (
              <span key={i} className={cn('h-1 w-8 min-w-3 rounded-full transition-colors duration-240 sm:w-12', filled ? 'bg-ink' : 'bg-line-2')} />
            ) : (
              <span key={i} className={cn('h-1 flex-1 rounded-full', filled ? (done ? 'bg-good-solid' : 'bg-primary') : 'bg-surface-3')} />
            );
          })
        ) : (
          <span className={cn('h-full rounded-full transition-[width] duration-240 ease-out', done ? 'bg-good-solid' : 'bg-primary')} style={{ width: `${max > 0 ? (v / max) * 100 : 0}%` }} />
        )}
      </div>
      {label && <span className="num shrink-0 whitespace-nowrap font-mono text-caption text-muted">{label}</span>}
    </div>
  );
}

/** Vertical steps: only the current one is open; done ones show their one-line summary. */
export function Stepper({ steps }: { steps: { title: ReactNode; summary?: ReactNode; state: 'done' | 'current' | 'upcoming'; content?: ReactNode }[] }) {
  return (
    <ol className="flex flex-col">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <li key={i} className="relative flex gap-3 pb-5 last:pb-0" aria-current={s.state === 'current' ? 'step' : undefined}>
            {!last && <span aria-hidden="true" className={cn('absolute bottom-0 left-3 top-7 w-px', s.state === 'done' ? 'bg-primary-line' : 'bg-line')} />}
            <span
              className={cn(
                'relative z-[1] flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-caption font-semibold',
                s.state === 'done' && 'bg-primary-soft text-primary',
                s.state === 'current' && 'bg-primary text-on-primary ring-[3px] ring-primary/15',
                s.state === 'upcoming' && 'border border-line bg-surface-2 text-muted',
              )}
            >
              {s.state === 'done' ? <Check size={14} aria-hidden="true" /> : i + 1}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className={cn('text-h4', s.state === 'upcoming' ? 'text-muted' : 'text-ink')}>{s.title}</p>
              {s.state === 'done' && s.summary && <p className="mt-0.5 text-small text-muted">{s.summary}</p>}
              {s.state === 'current' && s.content && <div className="mt-3">{s.content}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function Skeleton({ className, ai }: { className?: string; ai?: boolean }) {
  return <div aria-hidden="true" className={cn('skeleton', ai && 'skeleton-ai', className)} />;
}

/**
 * A tooltip on any element (required on icon-only buttons). The provider is mounted in main.tsx. A disabled
 * trigger gets no pointer or focus events, so it is wrapped in a focusable span that carries the tooltip.
 */
export function Tooltip({ content, side = 'top', kbd, children }: { content: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left'; kbd?: string; children: ReactElement }) {
  const disabled = !!(children.props as { disabled?: boolean }).disabled;
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        {disabled ? (
          <span tabIndex={0} className="inline-flex rounded-md">
            {children}
          </span>
        ) : (
          children
        )}
      </TooltipTrigger>
      <TooltipContent side={side}>
        {content}
        {kbd && <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-on-inverse/25 px-[5px] font-mono text-micro text-on-inverse/80">{kbd}</span>}
      </TooltipContent>
    </TooltipRoot>
  );
}

export type MenuEntry = { label: ReactNode; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; shortcut?: string; checked?: boolean } | 'separator' | { group: string };

/** A dropdown menu on any trigger element. */
export function Menu({ trigger, items, align = 'end', className }: { trigger: ReactElement; items: MenuEntry[]; align?: 'start' | 'end'; className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} collisionPadding={8} className={className}>
        <MenuEntries items={items} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuEntries({ items }: { items: MenuEntry[] }) {
  return (
    <>
      {items.map((it, i) => {
        if (it === 'separator') return <DropdownMenuSeparator key={i} />;
        if ('group' in it) return <DropdownMenuLabel key={i}>{it.group}</DropdownMenuLabel>;
        return (
          <DropdownMenuItem key={i} disabled={it.disabled} onSelect={() => it.onSelect()} className={cn(it.danger && 'text-bad focus:bg-bad-soft focus:text-bad [&>svg]:text-bad')}>
            {it.icon}
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.checked && <Check className="!text-primary" aria-hidden="true" />}
            {it.shortcut && <DropdownMenuShortcut>{it.shortcut}</DropdownMenuShortcut>}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/** The standard "⋯" menu for rows, cards and footers. */
export function MoreMenu({ items, label, size = 'sm' }: { items: MenuEntry[]; label?: string; size?: 'xs' | 'sm' }) {
  return (
    <DropdownMenu>
      <Tooltip content="More">
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn('btn btn-ghost btn-icon', size === 'xs' ? 'btn-xs' : 'btn-sm')} aria-label={label ?? 'More actions'}>
            <Ellipsis />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" collisionPadding={8}>
        <DropdownMenuGroup>
          <MenuEntries items={items} />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A select (Radix). A native <select className="select"> stays valid where it's simpler or tested. */
export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  size = 'md',
  disabled,
  id,
  'aria-label': ariaLabel,
  className,
}: {
  value: T | '';
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; description?: ReactNode; icon?: ReactNode; disabled?: boolean }[];
  placeholder?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  className?: string;
}) {
  return (
    <SelectRoot value={value} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn(size === 'sm' && 'h-8 text-small max-sm:h-9', className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            <span className="flex min-w-0 items-center gap-2">
              {o.icon && <span className="flex shrink-0 text-muted [&>svg]:size-4">{o.icon}</span>}
              <span className="min-w-0">
                <span className="block truncate">{o.label}</span>
                {o.description && <span className="block truncate text-caption text-muted">{o.description}</span>}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}

export function Checkbox({ checked, onChange, label, description, disabled, id }: { checked: boolean | 'indeterminate'; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean; id?: string }) {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <div className="flex items-start gap-2.5">
      <CheckboxRoot id={cid} checked={checked} onCheckedChange={(v) => onChange(v === true)} disabled={disabled} className="mt-[3px]" />
      {(label || description) && (
        <label htmlFor={cid} className={cn('min-w-0', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
          {label && <span className={cn('block text-body', disabled ? 'text-faint' : 'text-ink')}>{label}</span>}
          {description && <span className="block text-small text-muted">{description}</span>}
        </label>
      )}
    </div>
  );
}

const OPTION_COLS: Record<1 | 2 | 3 | 4, string> = { 1: 'grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-2 lg:grid-cols-3', 4: 'grid-cols-2 lg:grid-cols-4' };

type OptionCard<T> = { value: T; title: ReactNode; description?: ReactNode; icon?: ReactNode; badge?: ReactNode; disabled?: boolean; /** a quieter line under the description (examples) */ meta?: ReactNode };

/**
 * Choice cards. The default is a radio group (one tab stop, arrow keys). mode="button": each card is a
 * button that moves you on (onChange on click; the chosen one, if any, is pressed), as on the setup steps.
 */
export function OptionCards<T extends string>({
  value,
  onChange,
  options,
  columns = 2,
  size = 'md',
  mode = 'radio',
  'aria-label': ariaLabel,
}: {
  value: T | '';
  onChange: (v: T) => void;
  options: OptionCard<T>[];
  columns?: 1 | 2 | 3 | 4;
  size?: 'md' | 'lg';
  mode?: 'radio' | 'button';
  'aria-label': string;
}) {
  const lg = size === 'lg';
  const card = (on: boolean) =>
    cn(
      'relative flex min-w-0 flex-col items-start rounded-lg border border-line bg-surface text-left transition-[border-color,box-shadow,background-color] duration-120 disabled:cursor-not-allowed disabled:bg-surface-2',
      lg ? 'gap-4 p-5 sm:p-6' : 'gap-3 p-4',
      on ? 'bg-primary-soft/50 shadow-[inset_0_0_0_1.5px_rgb(var(--primary))]' : 'hover:border-line-3 hover:shadow-sm',
    );
  const inner = (o: OptionCard<T>, on: boolean) => (
    <>
      {on && (
        <span className={cn('absolute flex h-[18px] w-[18px] items-center justify-center rounded-full bg-primary text-on-primary', lg ? 'right-4 top-4' : 'right-3 top-3')} aria-hidden="true">
          <Check size={12} strokeWidth={3} />
        </span>
      )}
      {o.icon && <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-pop bg-surface-3 text-ink-2 [&>svg]:size-5">{o.icon}</span>}
      <span className="block w-full min-w-0">
        {/* without an icon the check sits beside the title: room is kept on its first line only */}
        {!o.icon && <span className="float-right ml-2 h-[18px] w-[18px]" aria-hidden="true" />}
        <span className={cn('block', lg ? 'text-title' : 'text-h3', o.disabled ? 'text-faint' : 'text-ink')}>
          {o.title}
          {o.badge && <span className="ml-2 inline-flex align-middle">{o.badge}</span>}
        </span>
        {o.description && <span className={cn('mt-1 text-muted', lg ? 'block text-body' : 'clamp-2 text-small')}>{o.description}</span>}
        {o.meta && <span className="mt-3 block text-small text-muted">{o.meta}</span>}
      </span>
    </>
  );
  if (mode === 'button') {
    return (
      <div role="group" aria-label={ariaLabel} className={cn('grid', lg ? 'gap-4' : 'gap-3', OPTION_COLS[columns])}>
        {options.map((o) => {
          const on = !!value && value === o.value;
          return (
            <button key={o.value} type="button" disabled={o.disabled} aria-pressed={value ? on : undefined} onClick={() => onChange(o.value)} className={card(on)}>
              {inner(o, on)}
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <RadioGroupPrimitive.Root aria-label={ariaLabel} value={value} onValueChange={(v) => onChange(v as T)} className={cn('grid gap-3', OPTION_COLS[columns])}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <RadioGroupPrimitive.Item key={o.value} value={o.value} disabled={o.disabled} className={card(on)}>
            {inner(o, on)}
          </RadioGroupPrimitive.Item>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A date and/or time as one button ("Thu, Nov 5 · 12:00 PM") that opens a calendar and a list of times. */
export function DateTimeButton({
  value,
  onChange,
  mode = 'datetime',
  stepMinutes = 15,
  min,
  disabled,
  size = 'sm',
  'aria-label': ariaLabel,
}: {
  value: number | null;
  onChange: (ms: number) => void;
  mode?: 'datetime' | 'date' | 'time';
  stepMinutes?: number;
  min?: number;
  disabled?: boolean;
  size?: 'xs' | 'sm';
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const date = value != null ? new Date(value) : null;
  const zone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return '';
    }
  }, []);
  const fmtDay = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtTime = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const text = !date ? (mode === 'time' ? 'Pick a time' : 'Pick a date') : mode === 'date' ? fmtDay(date) : mode === 'time' ? fmtTime(date) : `${fmtDay(date)} · ${fmtTime(date)}`;
  const times = useMemo(() => {
    const out: { value: string; label: string }[] = [];
    const base = new Date(2000, 0, 1);
    for (let m = 0; m < 24 * 60; m += Math.max(5, stepMinutes)) {
      base.setHours(Math.floor(m / 60), m % 60, 0, 0);
      out.push({ value: `${pad(Math.floor(m / 60))}:${pad(m % 60)}`, label: fmtTime(base) });
    }
    return out;
  }, [stepMinutes]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = date ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : '';
  const timeOptions = current && !times.some((t) => t.value === current) ? [{ value: current, label: fmtTime(date!) }, ...times] : times;
  const setDay = (d: Date | undefined) => {
    if (!d) return;
    const next = new Date(d);
    if (date) next.setHours(date.getHours(), date.getMinutes(), 0, 0);
    else next.setHours(12, 0, 0, 0);
    onChange(next.getTime());
  };
  const setTime = (hm: string) => {
    const [h, m] = hm.split(':').map(Number);
    const next = date ? new Date(date) : new Date();
    next.setHours(h, m, 0, 0);
    onChange(next.getTime());
  };
  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" disabled={disabled} className={cn('btn btn-secondary', size === 'xs' ? 'btn-xs' : 'btn-sm')} aria-label={ariaLabel ? `${ariaLabel}: ${text}` : undefined}>
          <CalendarClock className="!size-3.5" aria-hidden="true" />
          <span className="num">{text}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" collisionPadding={8} className="w-auto p-2">
        {mode !== 'time' && <Calendar mode="single" selected={date ?? undefined} onSelect={setDay} disabled={min != null ? { before: new Date(min) } : undefined} defaultMonth={date ?? undefined} />}
        {mode !== 'date' && (
          <div className={cn('px-1', mode !== 'time' && 'border-t border-line pt-2')}>
            <Select value={current} onChange={setTime} options={timeOptions} placeholder="Time" size="sm" aria-label="Time" />
          </div>
        )}
        {mode !== 'date' && zone && <p className="mt-2 px-1 text-caption text-muted">Times are in your time zone ({zone})</p>}
      </PopoverContent>
    </PopoverRoot>
  );
}

/**
 * A phone bottom action bar (fixed, above the safe area); inline from 640px. While it's on a phone
 * screen, body[data-bottom-bar] tells the assistant's launcher to move up.
 */
export function StickyActionBar({ children }: { children: ReactNode }) {
  const phone = useMediaQuery('(max-width: 639px)');
  useEffect(() => {
    if (!phone || typeof document === 'undefined') return;
    document.body.dataset.bottomBar = '1';
    return () => {
      delete document.body.dataset.bottomBar;
    };
  }, [phone]);
  return <div className="sticky-bar flex items-center justify-end gap-2">{children}</div>;
}
