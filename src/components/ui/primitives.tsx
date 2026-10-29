import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, CircleAlert, Copy, Info, Loader2, Sparkles, X } from 'lucide-react';
import { create } from 'zustand';
import { cn, hexToRgb, isHex } from '@/lib/utils';
import { copyText } from '@/lib/platform';
import { useUI } from '@/store/ui';

// ───────────────────────── Overlay primitives ─────────────────────────

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
}

function useFocusReturn(open: boolean, panel: React.RefObject<HTMLElement>) {
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const el = panel.current?.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]), textarea, select, button:not([data-close])');
      (el ?? panel.current)?.focus({ preventScroll: true });
    }, 30);
    return () => {
      clearTimeout(t);
      prev?.focus?.({ preventScroll: true });
    };
  }, [open, panel]);
}

const SIZES = { sm: 'max-w-[440px]', md: 'max-w-[600px]', lg: 'max-w-[820px]', xl: 'max-w-[1080px]', full: 'max-w-[1280px]' } as const;

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
  const titleId = useId();
  useEscape(open && !persistent, onClose);
  useFocusReturn(open, panel);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-6" role="presentation">
      <div className="absolute inset-0 animate-fade-in bg-[rgb(var(--shadow)/0.45)] backdrop-blur-[2px]" onClick={() => !persistent && onClose()} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-[calc(100%-12px)] w-full animate-rise-in flex-col overflow-hidden rounded-t-xl border border-line bg-surface shadow-pop outline-none sm:max-h-[calc(100%-24px)] sm:rounded-xl',
          SIZES[size],
        )}
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        {(title || subtitle) && (
          <div className="flex items-start gap-3 border-b border-line px-5 py-4">
            {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
            <div className="min-w-0 flex-1">
              {title && (
                <h2 id={titleId} className="font-display text-[19px] font-semibold leading-tight tracking-[-0.01em]">
                  {title}
                </h2>
              )}
              {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
            </div>
            <button data-close className="btn btn-ghost btn-icon btn-sm -mr-1.5 -mt-1" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        )}
        <div className={cn('scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4', bodyClass)}>{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2/60 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, children, footer, width = 440 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  const panel = useRef<HTMLDivElement>(null);
  useEscape(open, onClose);
  useFocusReturn(open, panel);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[55]">
      <div className="absolute inset-0 animate-fade-in bg-[rgb(var(--shadow)/0.35)]" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="absolute bottom-0 right-0 top-0 flex w-full animate-slide-in-right flex-col border-l border-line bg-surface shadow-pop outline-none"
        style={{ maxWidth: width, paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)', paddingRight: 'env(safe-area-inset-right, 0px)' }}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          <button data-close className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="border-t border-line px-5 py-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Popover({ open, onClose, anchor, children, align = 'end', className }: { open: boolean; onClose: () => void; anchor: React.RefObject<HTMLElement>; children: ReactNode; align?: 'start' | 'end'; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number }>({ top: 0 });
  useEscape(open, onClose);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const top = r.bottom + 6;
    if (align === 'end') setPos({ top, right: Math.max(8, window.innerWidth - r.right) });
    else setPos({ top, left: Math.max(8, r.left) });
  }, [open, anchor, align]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open, onClose, anchor]);
  if (!open) return null;
  return createPortal(
    <div ref={ref} className={cn('fixed z-[70] max-h-[70vh] animate-rise-in overflow-auto rounded-lg border border-line bg-surface p-1.5 shadow-pop', className)} style={{ top: pos.top, left: pos.left, right: pos.right }}>
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({ icon, children, onClick, danger, active }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; danger?: boolean; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors',
        danger ? 'text-bad hover:bg-bad-soft' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        active && 'bg-surface-2 text-ink',
      )}
    >
      {icon && <span className="shrink-0 opacity-80">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {active && <Check size={14} className="text-primary" />}
    </button>
  );
}

// ───────────────────────── Controls ─────────────────────────

export function Tabs<T extends string>({ tabs, value, onChange, className, size = 'md' }: { tabs: { id: T; label: ReactNode; icon?: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; className?: string; size?: 'sm' | 'md' }) {
  return (
    <div role="tablist" className={cn('scroll-thin flex gap-1 overflow-x-auto border-b border-line', className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            '-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 font-semibold transition-colors',
            size === 'sm' ? 'h-9 text-[13px]' : 'h-11 text-sm',
            value === t.id ? 'border-primary text-ink' : 'border-transparent text-muted hover:text-ink',
          )}
        >
          {t.icon}
          {t.label}
          {t.count !== undefined && <span className={cn('num rounded-full px-1.5 text-2xs', value === t.id ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-muted')}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange, size = 'md', className }: { options: { id: T; label: ReactNode; icon?: ReactNode }[]; value: T; onChange: (v: T) => void; size?: 'sm' | 'md'; className?: string }) {
  return (
    <div role="radiogroup" className={cn('scroll-thin inline-flex max-w-full overflow-x-auto rounded-md border border-line-2 bg-surface-2 p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] px-2.5 font-semibold transition-colors',
            size === 'sm' ? 'h-7 text-xs' : 'h-8 text-[13px]',
            value === o.id ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, description, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean; id?: string }) {
  const auto = useId();
  const tid = id ?? auto;
  return (
    <label htmlFor={tid} className={cn('flex cursor-pointer items-start gap-3', disabled && 'cursor-not-allowed opacity-60')}>
      <button
        id={tid}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors', checked ? 'bg-primary' : 'bg-line-2')}
      >
        <span className={cn('inline-block h-4 w-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className="block text-sm font-semibold text-ink">{label}</span>}
          {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
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
          {right && <div className="mb-1.5 text-xs text-muted">{right}</div>}
        </div>
      )}
      {children}
      {error ? <p className="mt-1 text-xs font-medium text-bad">{error}</p> : hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

export function AutoTextarea({ value, onChange, minRows = 3, className, ...rest }: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & { value: string; onChange: (v: string) => void; minRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight + 2, minRows * 22 + 18)}px`;
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
    <div className="flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-line-2 bg-surface px-2 py-1.5 focus-within:border-primary focus-within:shadow-focus">
      {values.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded bg-surface-2 py-0.5 pl-2 pr-1 text-xs font-medium text-ink-2">
          {v}
          <button type="button" className="rounded p-0.5 text-muted hover:bg-surface-3 hover:text-ink" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`}>
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
        className="min-w-[90px] flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-faint"
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

export function Empty({ icon, title, body, action, className }: { icon?: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center rounded-lg border border-dashed border-line-2 px-6 py-10 text-center', className)}>
      {icon && <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-muted">{icon}</div>}
      <p className="font-display text-[16px] font-semibold text-ink">{title}</p>
      {body && <p className="mt-1 max-w-md text-[13px] text-muted">{body}</p>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function ProgressRing({ value, size = 44, stroke = 5, color = 'rgb(var(--primary))', label }: { value: number; size?: number; stroke?: number; color?: string; label?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--surface-3))" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={c} strokeDashoffset={c * (1 - v)} strokeLinecap="round" style={{ transition: 'stroke-dashoffset .5s ease' }} />
      </svg>
      <span className="num absolute text-[11px] font-bold">{label ?? `${Math.round(v * 100)}%`}</span>
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
      {done ? <Check size={14} className="text-good" /> : <Copy size={14} />}
      {done ? 'Copied' : label}
    </button>
  );
}

export function Toaster() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismissToast);
  return createPortal(
    <div
      className="pointer-events-none fixed bottom-0 right-0 z-[80] flex w-full max-w-[380px] flex-col gap-2 p-4"
      style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom, 0px))', paddingRight: 'max(16px, env(safe-area-inset-right, 0px))' }}
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto flex animate-rise-in items-start gap-3 rounded-lg border border-line bg-surface p-3 pr-2 shadow-pop">
          <span
            className={cn(
              'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
              t.kind === 'success' && 'bg-good-soft text-good',
              t.kind === 'error' && 'bg-bad-soft text-bad',
              t.kind === 'info' && 'bg-info-soft text-info',
              t.kind === 'ai' && 'bg-accent-soft text-on-accent',
            )}
          >
            {t.kind === 'success' ? <Check size={14} /> : t.kind === 'error' ? <CircleAlert size={14} /> : t.kind === 'ai' ? <Sparkles size={13} /> : <Info size={14} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-ink">{t.title}</p>
            {t.body && <p className="mt-0.5 text-xs text-muted">{t.body}</p>}
            {t.action && (
              <button
                className="link mt-1 text-xs"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ───────────────────────── In-page confirmation (window.confirm is unavailable in artifacts) ─────────────────────────

interface ConfirmReq {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (v: boolean) => void;
}
const useConfirmStore = create<{ req: ConfirmReq | null; set: (r: ConfirmReq | null) => void }>((set) => ({ req: null, set: (req) => set({ req }) }));

export function confirmAction(opts: Omit<ConfirmReq, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useConfirmStore.getState().set({ ...opts, resolve }));
}

export function ConfirmHost() {
  const req = useConfirmStore((s) => s.req);
  const set = useConfirmStore((s) => s.set);
  const close = (v: boolean) => {
    req?.resolve(v);
    set(null);
  };
  return (
    <Modal
      open={!!req}
      onClose={() => close(false)}
      size="sm"
      title={req?.title}
      footer={
        <>
          <button className="btn btn-secondary btn-sm" onClick={() => close(false)}>
            Cancel
          </button>
          <button data-autofocus className={cn('btn btn-sm', req?.danger ? 'bg-bad text-white hover:bg-bad/90' : 'btn-primary')} onClick={() => close(true)}>
            {req?.confirmLabel ?? 'Confirm'}
          </button>
        </>
      }
    >
      <p className="text-sm text-ink-2">{req?.body}</p>
    </Modal>
  );
}

// ───────────────────────── Small display helpers ─────────────────────────

export function Swatch({ color, size = 14, className }: { color: string; size?: number; className?: string }) {
  return <span className={cn('inline-block shrink-0 rounded-full ring-1 ring-black/10', className)} style={{ width: size, height: size, background: color }} />;
}

export function SectionHeader({ title, desc, action, eyebrow }: { title: ReactNode; desc?: ReactNode; action?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-1">{eyebrow}</p>}
        <h2 className="section-title">{title}</h2>
        {desc && <p className="mt-0.5 text-[13px] text-muted">{desc}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
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
      className={cn('text-[13px]', className)}
    />
  );
}
